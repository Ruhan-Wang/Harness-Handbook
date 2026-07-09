# Main event loop and request dispatch  `stage-10`

This stage is the system’s steady-state control center: once startup is complete, it sits in the main loop and turns incoming UI activity, JSON-RPC traffic, and internal thread messages into concrete work for the right subsystem. Interactive event dispatch governs the TUI side, consuming the unified event stream, deciding which screen, popup, composer, or thread should receive each keystroke or redraw signal, and forwarding background work or RPCs when user actions require them.

RPC request routing performs the same role for protocol traffic. It decodes requests and notifications, checks connection and session state, selects the appropriate feature processor, and shapes replies, errors, and outbound notifications across the app server, core tool routing, MCP paths, and executor-facing endpoints. Directly assigned files support that dispatch spine: exec-server/src/server/processor.rs drives one exec-server connection end to end; core/src/session/handlers.rs maps session operations into mutations, tasks, persistence, and emitted events; app-server/src/request_serialization.rs preserves ordering for conflicting requests without blocking unrelated ones; and core/src/tools/parallel.rs executes tool calls with the right concurrency and cancellation semantics. Together, these parts keep the running system responsive, ordered, and correctly routed.

## Sub-stages

- [Interactive event dispatch](stage-10.1.md) `stage-10.1` — 96 files
- [RPC request routing](stage-10.2.md) `stage-10.2` — 37 files

## Files in this stage

### Connection dispatch
The exec server enters its steady-state JSON-RPC loop, decoding inbound traffic and routing requests and notifications into higher-level handlers.

### `exec-server/src/server/processor.rs`

`orchestration` · `per-connection main loop`

This file contains the orchestration layer between raw JSON-RPC transport events and the server handler implementation. `ConnectionProcessor` owns two pieces of shared state: an `Arc<SessionRegistry>` so multiple connections can attach to or resume the same session, and `ExecServerRuntimePaths` needed by handlers. Its `run_connection` method clones both and hands them to the internal async `run_connection` function.

`run_connection` first builds a router with `build_router`, destructures the `JsonRpcConnection` into inbound/outbound channels plus transport task handles, and creates a dedicated mpsc channel for server outbound messages. That channel is wrapped in `RpcNotificationSender` and passed into a new `ExecServerHandler`. A spawned `outbound_task` drains `RpcServerOutboundMessage` values, serializes them with `encode_server_message`, logs and stops on serialization failure, and forwards JSON text to the transport's outgoing channel until the receiver closes.

Inbound processing is intentionally sequential to preserve the required `initialize` then `initialized` ordering. Before each event, the loop checks `handler.is_session_attached()` so an evicted connection exits promptly after session resume elsewhere. Malformed messages generate an explicit JSON-RPC error with request id `-1`. Valid requests are dispatched through the router; each handler future is raced against `disconnected_rx.changed()` so transport loss interrupts in-flight work. Unknown request methods return `method_not_found`, while unknown notifications, unexpected client responses, and unexpected client errors all cause the connection to close. On exit, the processor shuts down the handler, drops the outbound sender to end the serializer task, aborts any transport-owned tasks, and awaits cleanup.

The embedded tests use in-memory duplex streams to verify a subtle lifecycle guarantee: disconnecting a transport during a long-poll read must detach the session quickly enough that another connection can resume it without waiting for the old read to finish.

#### Function details

##### `ConnectionProcessor::new`  (lines 27–32)

```
fn new(runtime_paths: ExecServerRuntimePaths) -> Self
```

**Purpose**: Creates a connection processor with a fresh shared session registry and fixed runtime paths. This is the top-level object reused across accepted transports.

**Data flow**: Consumes `ExecServerRuntimePaths`, allocates a new `SessionRegistry`, stores both in the struct, and returns `ConnectionProcessor`.

**Call relations**: Constructed by transport startup code before serving stdio or websocket connections. Each accepted connection later uses the same processor so sessions can survive reconnects.

*Call graph*: calls 1 internal fn (new); called by 10 (processor_exit_reports_closed_virtual_stream, multiplexed_environment_sends_keepalive, duplicate_handshakes_exhaust_failure_budget, oversized_harness_authorization_is_rejected_before_validation, pending_harness_key_validation_does_not_block_new_handshakes, repeated_early_data_during_validation_closes_the_physical_relay, repeated_malformed_handshakes_close_the_physical_relay, run_remote_environment, run_stdio_connection_with_io, run_websocket_listener).


##### `ConnectionProcessor::run_connection`  (lines 34–41)

```
async fn run_connection(&self, connection: JsonRpcConnection)
```

**Purpose**: Runs one `JsonRpcConnection` against the processor's shared registry and runtime configuration. It is the public per-connection entry point.

**Data flow**: Consumes a `JsonRpcConnection`, clones `self.session_registry` and `self.runtime_paths`, and awaits the internal `run_connection` function. It returns when that connection has fully shut down.

**Call relations**: Called by transport code when a stdio session starts or a websocket upgrades. It delegates all detailed event-loop behavior to the free `run_connection` function.

*Call graph*: calls 1 internal fn (run_connection); called by 1 (spawn_noise_virtual_stream); 2 external calls (clone, clone).


##### `run_connection`  (lines 44–185)

```
async fn run_connection(
    connection: JsonRpcConnection,
    session_registry: Arc<SessionRegistry>,
    runtime_paths: ExecServerRuntimePaths,
)
```

**Purpose**: Implements the full JSON-RPC event loop for one connection, including routing, outbound serialization, disconnect handling, and final cleanup. It is the core driver that turns transport events into handler calls.

**Data flow**: Takes a `JsonRpcConnection`, shared `SessionRegistry`, and `ExecServerRuntimePaths`. It builds a router, creates an outbound mpsc channel and `RpcNotificationSender`, constructs an `ExecServerHandler`, spawns an outbound serialization task, then repeatedly reads `JsonRpcConnectionEvent` values from `incoming_rx`. Depending on the event, it emits JSON-RPC errors for malformed input, dispatches requests and notifications through router closures, races each dispatch against `disconnected_rx.changed()`, forwards any resulting `RpcServerOutboundMessage` to the outbound channel, and breaks on protocol violations, disconnects, send failures, or session eviction. After the loop it awaits `handler.shutdown()`, drops channels, aborts connection-owned tasks, and awaits the outbound task.

**Call relations**: This function is invoked by `ConnectionProcessor::run_connection` in production and by `tests::spawn_test_connection` in the local test harness. It depends on `build_router` for method dispatch and on `ExecServerHandler` for all protocol semantics, while also enforcing transport-level closure rules.

*Call graph*: calls 6 internal fn (new, encode_server_message, invalid_request, method_not_found, new, build_router); called by 2 (run_connection, spawn_test_connection); 7 external calls (new, Integer, debug!, format!, select!, spawn, warn!).


##### `tests::transport_disconnect_detaches_session_during_in_flight_read`  (lines 229–316)

```
async fn transport_disconnect_detaches_session_during_in_flight_read()
```

**Purpose**: Tests that dropping the first transport during a long-poll `exec/read` detaches the session quickly enough for a second connection to resume it immediately. It guards against resume being blocked by an in-flight read on the old connection.

**Data flow**: Creates a shared `SessionRegistry`, spawns a first in-memory connection, sends initialize and initialized messages, starts a process, issues a long-poll read request, then drops the first writer to simulate disconnect. After a short sleep it spawns a second connection, sends initialize with `resume_session_id` from the first response, waits with a timeout for the resumed initialize response, asserts the session id matches, waits for the first processor task to exit, sends initialized on the second connection, terminates the process, and finally drops the second connection and waits for its task to finish.

**Call relations**: This test drives the internal `run_connection` loop through the helper functions in the nested test module. It specifically validates the disconnect-vs-read race handled by the `tokio::select!` branches in request processing.

*Call graph*: calls 2 internal fn (from, new); 11 external calls (clone, from_millis, from_secs, assert_eq!, exec_params, read_response, send_notification, send_request, spawn_test_connection, sleep (+1 more)).


##### `tests::spawn_test_connection`  (lines 318–328)

```
fn spawn_test_connection(
        registry: Arc<SessionRegistry>,
        label: &str,
    ) -> (DuplexStream, Lines<BufReader<DuplexStream>>, JoinHandle<()>)
```

**Purpose**: Creates an in-memory client/server pair and launches `run_connection` against the server side. It is the reusable harness for processor tests.

**Data flow**: Accepts a shared `Arc<SessionRegistry>` and a label string, creates two `duplex` stream pairs to simulate bidirectional stdio, wraps the server ends in `JsonRpcConnection::from_stdio`, spawns `run_connection(connection, registry, test_runtime_paths())`, and returns the client writer, a line-oriented reader over the client read side, and the join handle.

**Call relations**: Used by the processor test to stand up first and second logical connections sharing one registry. It delegates actual protocol processing to the same `run_connection` function used in production.

*Call graph*: calls 2 internal fn (from_stdio, run_connection); 4 external calls (new, test_runtime_paths, duplex, spawn).


##### `tests::test_runtime_paths`  (lines 330–336)

```
fn test_runtime_paths() -> ExecServerRuntimePaths
```

**Purpose**: Builds runtime paths for processor tests from the current executable. It mirrors the production constructor but omits any Linux sandbox binary.

**Data flow**: Reads `current_exe`, passes it with `None` into `ExecServerRuntimePaths::new`, and returns the resulting runtime-path object.

**Call relations**: Called by `tests::spawn_test_connection` so each in-memory processor instance has valid runtime configuration.

*Call graph*: calls 1 internal fn (new); 1 external calls (current_exe).


##### `tests::send_request`  (lines 338–354)

```
async fn send_request(
        writer: &mut DuplexStream,
        id: i64,
        method: &str,
        params: &P,
    )
```

**Purpose**: Serializes and writes a JSON-RPC request line to the test connection. It hides the boilerplate for request id, method, and params encoding.

**Data flow**: Takes a mutable `DuplexStream`, numeric id, method string, and serializable params, wraps them in `JSONRPCMessage::Request(JSONRPCRequest { ... })` with `RequestId::Integer(id)` and `serde_json::to_value(params)`, then forwards the message to `write_message`.

**Call relations**: Used throughout the processor test to drive initialize, exec, read, and terminate requests into the running connection loop. It depends on `write_message` for the actual framed write.

*Call graph*: 4 external calls (Request, Integer, write_message, to_value).


##### `tests::send_notification`  (lines 356–365)

```
async fn send_notification(writer: &mut DuplexStream, method: &str, params: &P)
```

**Purpose**: Serializes and writes a JSON-RPC notification line to the test connection. It is the notification counterpart to `send_request`.

**Data flow**: Takes a mutable `DuplexStream`, method string, and serializable params, wraps them in `JSONRPCMessage::Notification(JSONRPCNotification { ... })` using `serde_json::to_value`, and passes the message to `write_message`.

**Call relations**: Used by the processor test to send the `initialized` notification after successful initialize responses. It feeds the same line-oriented transport format expected by `run_connection`.

*Call graph*: 3 external calls (Notification, write_message, to_value).


##### `tests::write_message`  (lines 367–371)

```
async fn write_message(writer: &mut DuplexStream, message: &JSONRPCMessage)
```

**Purpose**: Writes one JSON-RPC message followed by a newline to a duplex stream. It provides the framing expected by the stdio-style test transport.

**Data flow**: Accepts a mutable `DuplexStream` and a `JSONRPCMessage`, serializes the message with `serde_json::to_vec`, writes the bytes, then writes `\n`. It returns after both writes complete successfully.

**Call relations**: This low-level helper is called by both `send_request` and `send_notification`. It is the final step that injects test traffic into the processor.

*Call graph*: 2 external calls (write_all, to_vec).


##### `tests::read_response`  (lines 373–390)

```
async fn read_response(
        lines: &mut Lines<BufReader<DuplexStream>>,
        expected_id: i64,
    ) -> T
```

**Purpose**: Reads the next line from the test connection and decodes it as a successful JSON-RPC response of a caller-specified result type. It fails loudly on errors or unexpected message kinds.

**Data flow**: Takes a mutable `Lines<BufReader<DuplexStream>>` and an expected integer request id, reads the next line, parses it as `JSONRPCMessage`, matches only `JSONRPCMessage::Response(JSONRPCResponse { id, result })`, asserts the id equals `RequestId::Integer(expected_id)`, and deserializes `result` into `T` with `serde_json::from_value`. Any JSON-RPC error or non-response message causes a panic.

**Call relations**: Used by the processor test after each request to validate that `run_connection` emitted the expected response promptly. It is the read-side counterpart to `send_request`.

*Call graph*: 4 external calls (next_line, assert_eq!, panic!, from_value).


##### `tests::exec_params`  (lines 392–407)

```
fn exec_params(process_id: ProcessId) -> ExecParams
```

**Purpose**: Builds `ExecParams` for the processor test's long-lived process. The command is chosen to emit output only after a delay so the read request remains in flight during disconnect.

**Data flow**: Accepts a `ProcessId`, creates a PATH-only environment map, resolves the current directory to `PathUri`, obtains argv from `sleep_then_print_argv`, and returns an `ExecParams` with `env_policy: None`, `tty: false`, `pipe_stdin: false`, and `arg0: None`.

**Call relations**: Called by the processor test before sending the `exec` request. Its delayed-output command is essential to reproducing the in-flight long-poll scenario.

*Call graph*: calls 1 internal fn (from_path); 4 external calls (new, sleep_then_print_argv, current_dir, var_os).


##### `tests::sleep_then_print_argv`  (lines 409–423)

```
fn sleep_then_print_argv() -> Vec<String>
```

**Purpose**: Returns a platform-specific shell command that waits and then prints `late`. It ensures the process stays alive long enough for the disconnect/resume race to be exercised.

**Data flow**: Checks `cfg!(windows)` and returns either a `cmd.exe /C` command using `ping` and `echo late`, or a `/bin/sh -c` command using `sleep 1; printf late`, packaged as `Vec<String>`.

**Call relations**: Used only by `tests::exec_params` to define the process behavior for the transport-disconnect test.

*Call graph*: 2 external calls (cfg!, vec!).


### Session request handling
Session-level dispatch turns incoming operations into concrete protocol handling, coordinating mutations, task launches, and outbound effects.

### `core/src/session/handlers.rs`

`orchestration` · `main loop`

This file is the main orchestration hub for session-level protocol handling. Small wrappers like `interrupt`, `clean_background_terminals`, `request_user_input_response`, `request_permissions_response`, `dynamic_tool_response`, `refresh_mcp_servers`, and `reload_user_config` simply forward to `Session` methods. More involved handlers translate protocol payloads into internal state transitions: `thread_settings_update` merges partial `ThreadSettingsOverrides` with the active collaboration mode when model/effort updates arrive without an explicit mode object, and `thread_settings_applied_event` snapshots the resulting configuration into a `ThreadSettingsAppliedEvent`. `user_input_or_turn_inner` is the most important path: it destructures `Op::UserInput`, optionally applies thread-setting updates, starts a new turn, emits settings-applied and unknown-model warnings, then tries `sess.steer_input(...)`. If steering reports `NoActiveTurn`, it merges additional context into session state, converts that context into `TurnInput::ResponseItem` values, appends user input if present, refreshes MCP servers if requested, and spawns a regular task. The file also handles inter-agent mailbox traffic, shell-command execution either inside an active turn or as a new task, elicitation resolution, approval decisions including execpolicy amendment persistence, compaction, thread rollback with persistence flush/load/replay and rollback-marker durability, thread memory mode persistence, review-thread spawning, and full shutdown. `submission_loop` ties everything together: it receives `Submission`s from an async channel, creates a tracing span with optional W3C parent context, matches on `Op`, invokes the appropriate handler, and ensures teardown still runs if the channel closes without an explicit shutdown.

#### Function details

##### `interrupt`  (lines 63–65)

```
async fn interrupt(sess: &Arc<Session>)
```

**Purpose**: Interrupts the currently running session task.

**Data flow**: Takes `&Arc<Session>`, awaits `sess.interrupt_task()`, and produces no return value or additional state beyond the session-side interruption effects.

**Call relations**: Called from `submission_loop` when it receives `Op::Interrupt`. It is a minimal adapter that keeps the dispatch match concise.

*Call graph*: called by 1 (submission_loop).


##### `clean_background_terminals`  (lines 67–69)

```
async fn clean_background_terminals(sess: &Arc<Session>)
```

**Purpose**: Closes any unified exec/background terminal processes associated with the session.

**Data flow**: Accepts `&Arc<Session>`, awaits `sess.close_unified_exec_processes()`, and returns `()` after the session has attempted cleanup.

**Call relations**: Dispatched from `submission_loop` for `Op::CleanBackgroundTerminals`. It isolates this maintenance action behind a named handler.

*Call graph*: called by 1 (submission_loop).


##### `realtime_conversation_list_voices`  (lines 71–81)

```
async fn realtime_conversation_list_voices(sess: &Session, sub_id: String)
```

**Purpose**: Responds to a realtime-conversation voice-list request with the built-in voice inventory.

**Data flow**: Builds an `Event` using the provided subscription id and `EventMsg::RealtimeConversationListVoicesResponse`, filling `voices` with `RealtimeVoicesList::builtin()`, then sends it via `sess.send_event_raw`.

**Call relations**: Used by `submission_loop` for `Op::RealtimeConversationListVoices` and by a dedicated test. It does not query dynamic state; it always emits the built-in list.

*Call graph*: calls 1 internal fn (builtin); called by 2 (submission_loop, realtime_conversation_list_voices_emits_builtin_list); 2 external calls (send_event_raw, RealtimeConversationListVoicesResponse).


##### `user_input_or_turn`  (lines 83–90)

```
async fn user_input_or_turn(
    sess: &Arc<Session>,
    sub_id: String,
    op: Op,
    client_user_message_id: Option<String>,
)
```

**Purpose**: Public wrapper that forwards user-input submissions into the full turn/steering handler.

**Data flow**: Receives the session, submission id, `Op`, and optional client message id; passes them unchanged to `user_input_or_turn_inner` and awaits completion.

**Call relations**: Called from `submission_loop` for `Op::UserInput` and from tests. It exists mainly as the externally visible entry while the inner function remains `pub(super)`.

*Call graph*: calls 1 internal fn (user_input_or_turn_inner); called by 2 (submission_loop, user_turn_updates_approvals_reviewer).


##### `update_thread_settings`  (lines 92–106)

```
async fn update_thread_settings(
    sess: &Arc<Session>,
    sub_id: String,
    thread_settings: ThreadSettingsOverrides,
)
```

**Purpose**: Applies thread-setting overrides and emits either a snapshot event or a bad-request error event.

**Data flow**: Transforms `ThreadSettingsOverrides` into `SessionSettingsUpdate` via `thread_settings_update`, calls `sess.update_settings(updates)`, maps success to `thread_settings_applied_event(sess).await` and failure to `EventMsg::Error` with a formatted validation message, then sends the resulting event with the provided submission id.

**Call relations**: Invoked by `submission_loop` for `Op::ThreadSettings`. It orchestrates the update-and-respond flow while delegating update construction and snapshot formatting to helper functions.

*Call graph*: calls 2 internal fn (thread_settings_applied_event, thread_settings_update); called by 1 (submission_loop); 2 external calls (format!, Error).


##### `thread_settings_update`  (lines 108–157)

```
async fn thread_settings_update(
    sess: &Session,
    thread_settings: ThreadSettingsOverrides,
) -> SessionSettingsUpdate
```

**Purpose**: Converts protocol-level thread-setting overrides into the internal `SessionSettingsUpdate` structure, preserving current collaboration mode when only partial model settings are supplied.

**Data flow**: Destructures `ThreadSettingsOverrides` into individual optional fields. If `collaboration_mode` is absent, it locks `sess.state`, reads the current `session_configuration.collaboration_mode`, and derives an updated mode with `with_updates(model, effort, None)`; then it returns a `SessionSettingsUpdate` populated with the provided environment, workspace, approval, sandbox, permission, Windows sandbox, collaboration, reasoning summary, service tier, and personality fields plus defaults for the rest.

**Call relations**: Used by both `update_thread_settings` and `user_input_or_turn_inner` whenever thread settings accompany a request. It centralizes the subtle rule that model and reasoning effort currently live inside collaboration-mode settings.

*Call graph*: called by 2 (update_thread_settings, user_input_or_turn_inner); 1 external calls (default).


##### `thread_settings_applied_event`  (lines 159–181)

```
async fn thread_settings_applied_event(sess: &Session) -> EventMsg
```

**Purpose**: Builds the protocol event that reports the session’s current thread settings snapshot back to the client.

**Data flow**: Locks `sess.state`, obtains `state.session_configuration.thread_config_snapshot()`, clones the snapshot cwd, and constructs `EventMsg::ThreadSettingsApplied` containing a `ThreadSettingsSnapshot` with model, provider, service tier, approval settings, permission profile fields, cwd, reasoning settings, personality, and collaboration mode.

**Call relations**: Called after successful settings updates from both `update_thread_settings` and `user_input_or_turn_inner`. It is the canonical formatter for the post-update snapshot sent to clients.

*Call graph*: called by 2 (update_thread_settings, user_input_or_turn_inner); 1 external calls (ThreadSettingsApplied).


##### `user_input_or_turn_inner`  (lines 183–275)

```
async fn user_input_or_turn_inner(
    sess: &Arc<Session>,
    sub_id: String,
    op: Op,
    client_user_message_id: Option<String>,
)
```

**Purpose**: Processes a `UserInput` operation by applying optional thread-setting updates, opening a turn, attempting to steer active work, and falling back to spawning a new regular task when no active turn can accept the input.

**Data flow**: Pattern-matches `op` as `Op::UserInput`, extracts items, schema, metadata, additional context, and thread settings, computes whether settings-applied should be emitted, builds `SessionSettingsUpdate` via `thread_settings_update` or default, stores `final_output_json_schema`, and calls `sess.new_turn_with_sub_id`. On success it may emit `ThreadSettingsApplied`, emits unknown-model warnings, and calls `sess.steer_input(...)`. If steering succeeds it records telemetry for the user prompt. If it returns `SteerInputError::NoActiveTurn(items)`, it optionally stores responses API metadata in turn metadata, refreshes MCP servers, merges additional context into session state, converts merged context into `ResponseItem` then `TurnInput::ResponseItem`, appends a `TurnInput::UserInput` when the original items are non-empty, and spawns a regular task. Any other steering error is converted to an `ErrorEvent` and sent.

**Call relations**: Reached from `user_input_or_turn` and realtime text routing. It is the central bridge between protocol input and task execution, delegating turn creation, steering, MCP refresh, context merging, and task spawning to session methods.

*Call graph*: calls 3 internal fn (thread_settings_applied_event, thread_settings_update, new); called by 2 (route_realtime_text_input, user_input_or_turn); 5 external calls (clone, default, Error, default, unreachable!).


##### `inter_agent_communication`  (lines 279–292)

```
async fn inter_agent_communication(
    sess: &Arc<Session>,
    sub_id: String,
    communication: InterAgentCommunication,
)
```

**Purpose**: Queues an inter-agent mailbox message and optionally triggers turn startup if the message requests it.

**Data flow**: Reads `communication.trigger_turn`, enqueues the full `InterAgentCommunication` into `sess.input_queue`, and if the flag is true calls `sess.maybe_start_turn_for_pending_work_with_sub_id(sub_id)`.

**Call relations**: Called by `submission_loop` for `Op::InterAgentCommunication`. It separates mailbox enqueueing from the scheduler decision about whether pending work should wake an idle session.

*Call graph*: called by 1 (submission_loop).


##### `run_user_shell_command`  (lines 294–319)

```
async fn run_user_shell_command(sess: &Arc<Session>, sub_id: String, command: String)
```

**Purpose**: Executes a user shell command either as auxiliary work attached to the active turn or as a standalone task in a newly created default turn.

**Data flow**: Checks `sess.active_turn_context_and_cancellation_token()`. If an active turn exists, it clones the session and spawns a Tokio task that calls `execute_user_shell_command(session, turn_context, command, cancellation_token, UserShellCommandMode::ActiveTurnAuxiliary)`. Otherwise it creates a default turn with the submission id and spawns a `UserShellCommandTask::new(command)` with empty initial input.

**Call relations**: Dispatched from `submission_loop` for `Op::RunUserShellCommand` and covered by tests. It chooses between in-turn auxiliary execution and standalone task startup based on whether a turn is already active.

*Call graph*: calls 1 internal fn (new); called by 2 (submission_loop, run_user_shell_command_does_not_set_reference_context_item); 4 external calls (clone, new, execute_user_shell_command, spawn).


##### `resolve_elicitation`  (lines 321–359)

```
async fn resolve_elicitation(
    sess: &Arc<Session>,
    server_name: String,
    request_id: ProtocolRequestId,
    decision: codex_protocol::approvals::ElicitationAction,
    content: Option<Value
```

**Purpose**: Maps a protocol-level elicitation decision into the RMCP client representation and forwards it to the session.

**Data flow**: Converts `codex_protocol::approvals::ElicitationAction` into `codex_rmcp_client::ElicitationAction`, normalizes accepted responses to include `{}` content when absent while dropping content for decline/cancel, wraps action/content/meta into `ElicitationResponse`, converts `ProtocolRequestId` into `rmcp::model::NumberOrString`, and calls `sess.resolve_elicitation(server_name, request_id, response)`, logging a warning if that fails.

**Call relations**: Used by `submission_loop` for `Op::ResolveElicitation`. It is the protocol adaptation layer between client-facing approval responses and the session’s MCP elicitation machinery.

*Call graph*: called by 1 (submission_loop); 4 external calls (Number, String, from, warn!).


##### `exec_approval`  (lines 363–403)

```
async fn exec_approval(
    sess: &Arc<Session>,
    approval_id: String,
    turn_id: Option<String>,
    decision: ReviewDecision,
)
```

**Purpose**: Applies a user’s exec approval decision, including optional persistence of an execpolicy amendment before notifying the waiting approval flow.

**Data flow**: Computes an event turn id from `turn_id` or `approval_id`. If the decision is `ApprovedExecpolicyAmendment`, it calls `sess.persist_execpolicy_amendment(...)`; on success it records an amendment message, on failure it formats a warning message and sends `EventMsg::Warning`. It then either interrupts the task for `ReviewDecision::Abort` or forwards the decision to `sess.notify_approval(&approval_id, other)`.

**Call relations**: Dispatched from `submission_loop` for `Op::ExecApproval`. It adds amendment persistence and warning emission around the generic approval-notification path.

*Call graph*: called by 1 (submission_loop); 3 external calls (format!, Warning, warn!).


##### `patch_approval`  (lines 405–412)

```
async fn patch_approval(sess: &Arc<Session>, id: String, decision: ReviewDecision)
```

**Purpose**: Propagates a non-exec approval patch decision or aborts the active task.

**Data flow**: Matches on `ReviewDecision`; `Abort` triggers `sess.interrupt_task().await`, while any other decision is passed to `sess.notify_approval(&id, other).await`.

**Call relations**: Called from `submission_loop` for `Op::PatchApproval`. It is a simpler sibling of `exec_approval` without execpolicy amendment handling.

*Call graph*: called by 1 (submission_loop).


##### `request_user_input_response`  (lines 414–420)

```
async fn request_user_input_response(
    sess: &Arc<Session>,
    id: String,
    response: RequestUserInputResponse,
)
```

**Purpose**: Forwards a response to a pending user-input request back into the session.

**Data flow**: Accepts the request id and `RequestUserInputResponse`, then awaits `sess.notify_user_input_response(&id, response)`.

**Call relations**: Used by `submission_loop` for `Op::UserInputAnswer`. It is a thin protocol-to-session adapter.

*Call graph*: called by 1 (submission_loop).


##### `request_permissions_response`  (lines 422–429)

```
async fn request_permissions_response(
    sess: &Arc<Session>,
    id: String,
    response: RequestPermissionsResponse,
)
```

**Purpose**: Forwards a response to a pending permissions request back into the session.

**Data flow**: Accepts the request id and `RequestPermissionsResponse`, then awaits `sess.notify_request_permissions_response(&id, response)`.

**Call relations**: Used by `submission_loop` for `Op::RequestPermissionsResponse`. Like the user-input response handler, it simply bridges protocol input to session state.

*Call graph*: called by 1 (submission_loop).


##### `dynamic_tool_response`  (lines 431–433)

```
async fn dynamic_tool_response(sess: &Arc<Session>, id: String, response: DynamicToolResponse)
```

**Purpose**: Delivers a dynamic tool response to the session component waiting for it.

**Data flow**: Takes the response id and `DynamicToolResponse`, then calls `sess.notify_dynamic_tool_response(&id, response).await`.

**Call relations**: Dispatched from `submission_loop` for `Op::DynamicToolResponse`. It is another narrow forwarding adapter.

*Call graph*: called by 1 (submission_loop).


##### `refresh_mcp_servers`  (lines 435–438)

```
async fn refresh_mcp_servers(sess: &Arc<Session>, refresh_config: McpServerRefreshConfig)
```

**Purpose**: Stores a pending MCP server refresh configuration to be applied later during turn processing.

**Data flow**: Locks `sess.pending_mcp_server_refresh_config` and replaces its contents with `Some(refresh_config)`.

**Call relations**: Called by `submission_loop` for `Op::RefreshMcpServers`. It does not refresh immediately; later turn logic consumes this pending config via session MCP helpers.

*Call graph*: called by 1 (submission_loop).


##### `reload_user_config`  (lines 440–442)

```
async fn reload_user_config(sess: &Arc<Session>)
```

**Purpose**: Triggers reloading of the user config layer for the session.

**Data flow**: Awaits `sess.reload_user_config_layer()` and returns `()`.

**Call relations**: Invoked from `submission_loop` for `Op::ReloadUserConfig`. It delegates all actual reload semantics to the session.

*Call graph*: called by 1 (submission_loop).


##### `compact`  (lines 444–449)

```
async fn compact(sess: &Arc<Session>, sub_id: String)
```

**Purpose**: Starts a compaction task in a fresh default turn.

**Data flow**: Creates a default turn context with the submission id, then calls `sess.spawn_task(Arc::clone(&turn_context), Vec::new(), CompactTask).await`.

**Call relations**: Dispatched from `submission_loop` for `Op::Compact`. It is the entry point for compaction work and always runs as a new task.

*Call graph*: called by 1 (submission_loop); 2 external calls (clone, new).


##### `thread_rollback`  (lines 451–549)

```
async fn thread_rollback(sess: &Arc<Session>, sub_id: String, num_turns: u32)
```

**Purpose**: Rolls back persisted thread history by replaying stored rollout items minus the requested number of turns, then records and emits a rollback marker.

**Data flow**: Validates `num_turns >= 1`, rejects rollback if an active turn exists, creates a default turn context, obtains a persisted live thread or emits an error if unavailable, flushes persistence, loads non-archived history, constructs `ThreadRolledBackEvent` and `EventMsg::ThreadRolledBack`, appends that marker to the replay item stream, applies rollout reconstruction, recomputes token usage, persists the rollback marker, flushes rollout with warning-on-failure, and finally delivers the rollback event to the client.

**Call relations**: Called from `submission_loop` for `Op::ThreadRollback` and heavily exercised by tests. It coordinates persistence, replay, state recomputation, and client notification to make rollback durable and visible.

*Call graph*: called by 9 (submission_loop, thread_rollback_clears_history_when_num_turns_exceeds_existing_turns, thread_rollback_drops_last_turn_from_history, thread_rollback_fails_when_num_turns_is_zero, thread_rollback_fails_when_turn_in_progress, thread_rollback_fails_without_persisted_thread_history, thread_rollback_persists_marker_and_replays_cumulatively, thread_rollback_recomputes_previous_turn_settings_and_reference_context_from_replay, thread_rollback_restores_cleared_reference_context_item_after_compaction); 6 external calls (format!, Error, ThreadRolledBack, Warning, EventMsg, once).


##### `persist_thread_memory_mode_update`  (lines 551–563)

```
async fn persist_thread_memory_mode_update(
    sess: &Arc<Session>,
    mode: ThreadMemoryMode,
) -> anyhow::Result<()>
```

**Purpose**: Persists a thread-level memory mode change into durable thread metadata.

**Data flow**: Obtains a live thread via `sess.live_thread_for_persistence(...)`, persists and flushes current state, calls `update_memory_mode(mode, false)`, flushes again, and returns `Ok(())` or the first persistence error.

**Call relations**: Used internally by `set_thread_memory_mode`. It isolates the persistence sequence required to safely update thread metadata.

*Call graph*: called by 2 (set_thread_memory_mode, set_thread_memory_mode).


##### `set_thread_memory_mode`  (lines 569–581)

```
async fn set_thread_memory_mode(sess: &Arc<Session>, sub_id: String, mode: ThreadMemoryMode)
```

**Purpose**: Applies a thread memory mode update and reports any persistence failure back to the client as an error event.

**Data flow**: Calls `persist_thread_memory_mode_update(sess, mode).await`; on error it logs a warning, constructs an `EventMsg::Error` with `CodexErrorInfo::Other`, and sends it using the provided submission id.

**Call relations**: Dispatched from `submission_loop` for `Op::SetThreadMemoryMode`. It wraps the lower-level persistence helper with user-visible error reporting.

*Call graph*: calls 1 internal fn (persist_thread_memory_mode_update); called by 1 (submission_loop); 2 external calls (Error, warn!).


##### `shutdown_session_runtime`  (lines 583–602)

```
async fn shutdown_session_runtime(sess: &Arc<Session>)
```

**Purpose**: Performs the internal teardown sequence for a session runtime without emitting the final shutdown-complete protocol event.

**Data flow**: Takes and aborts any startup prewarm handle, aborts all tasks with `TurnAbortReason::Interrupted`, shuts down the conversation, terminates all unified exec processes, attempts code-mode shutdown with warning on failure, shuts down the MCP connection manager, and shuts down the guardian review session.

**Call relations**: Called by both `shutdown` and the fallback path at the end of `submission_loop` when the channel closes unexpectedly. It centralizes runtime cleanup so explicit and implicit teardown share the same sequence.

*Call graph*: called by 2 (shutdown, submission_loop); 1 external calls (warn!).


##### `emit_thread_stop_lifecycle`  (lines 604–613)

```
async fn emit_thread_stop_lifecycle(sess: &Session)
```

**Purpose**: Invokes extension lifecycle contributors for thread-stop notifications.

**Data flow**: Iterates over `sess.services.extensions.thread_lifecycle_contributors()`, and for each contributor awaits `on_thread_stop` with references to session and thread extension stores.

**Call relations**: Used during both explicit `shutdown` and implicit teardown after `submission_loop` exits. It gives extensions a consistent stop hook after runtime cleanup.

*Call graph*: called by 2 (shutdown, submission_loop).


##### `shutdown`  (lines 615–660)

```
async fn shutdown(sess: &Arc<Session>, sub_id: String) -> bool
```

**Purpose**: Runs full session shutdown, records telemetry and rollout trace completion, flushes thread persistence, emits `ShutdownComplete`, and signals the submission loop to exit.

**Data flow**: Calls `shutdown_session_runtime`, logs shutdown, clones conversation history and counts user-turn boundaries for telemetry, emits thread-stop lifecycle hooks, attempts `live_thread.shutdown()` and sends an error event if that fails, constructs and records a `ShutdownComplete` event in rollout tracing, delivers it, records rollout completion status, and returns `true`.

**Call relations**: Triggered from `submission_loop` for `Op::Shutdown`. Its boolean return is used by the loop to break and avoid duplicate teardown.

*Call graph*: calls 2 internal fn (emit_thread_stop_lifecycle, shutdown_session_runtime); called by 1 (submission_loop); 4 external calls (try_from, info!, Error, warn!).


##### `review`  (lines 662–696)

```
async fn review(
    sess: &Arc<Session>,
    config: &Arc<Config>,
    sub_id: String,
    review_request: ReviewRequest,
)
```

**Purpose**: Starts a review workflow in a fresh turn after resolving the incoming review request against the turn cwd.

**Data flow**: Creates a default turn context, emits unknown-model warnings, refreshes MCP servers if requested, resolves the incoming `ReviewRequest` with `resolve_review_request(review_request, &turn_context.cwd)`, and on success calls `spawn_review_thread(...)`; on failure it sends an `ErrorEvent` through the turn context.

**Call relations**: Dispatched from `submission_loop` for `Op::Review`. It orchestrates the setup and validation needed before handing off to the dedicated review-thread spawner.

*Call graph*: called by 1 (submission_loop); 4 external calls (clone, resolve_review_request, spawn_review_thread, Error).


##### `submission_loop`  (lines 698–851)

```
async fn submission_loop(
    sess: Arc<Session>,
    config: Arc<Config>,
    rx_sub: Receiver<Submission>,
)
```

**Purpose**: Receives protocol submissions from the session channel, wraps each dispatch in tracing context, routes every supported `Op` to its handler, and guarantees teardown when the loop ends.

**Data flow**: Consumes `Submission` values from `rx_sub.recv().await` in a loop, logs each submission, creates a span via `submission_dispatch_span`, matches on `sub.op.clone()`, invokes the corresponding handler for realtime conversation, user input, settings, approvals, MCP refresh, rollback, shell commands, review, shutdown, and other operations, and tracks whether an explicit shutdown occurred. If the channel closes without shutdown, it still calls `shutdown_session_runtime` and `emit_thread_stop_lifecycle` before exiting.

**Call relations**: Called by the session’s internal spawn path and acts as the central dispatcher for this file. Every other handler here is either directly invoked from this match or supports one of the invoked flows.

*Call graph*: calls 30 internal fn (handle_audio, handle_close, handle_speech, handle_start, handle_text, approve_guardian_denied_action, clean_background_terminals, compact, dynamic_tool_response, emit_thread_stop_lifecycle (+15 more)); called by 1 (spawn_internal); 2 external calls (debug!, Error).


##### `approve_guardian_denied_action`  (lines 853–891)

```
async fn approve_guardian_denied_action(sess: &Arc<Session>, event: GuardianAssessmentEvent)
```

**Purpose**: Transforms approval of a previously denied Guardian assessment into a developer message injected into the conversation without starting a new turn.

**Data flow**: Checks that `event.status` is `Denied`, otherwise warns and returns. For denied events it builds a JSON object containing the original action and `outcome: "allowed"`, pretty-serializes it, formats a developer instruction block prefixed with `AUTO_REVIEW_DENIED_ACTION_APPROVAL_DEVELOPER_PREFIX`, wraps that text in a `ResponseInputItem::Message` and `ResponseItem`, and calls `sess.inject_no_new_turn(items, None).await`.

**Call relations**: Invoked from `submission_loop` for `Op::ApproveGuardianDeniedAction`. It converts an approval action into conversation state that the model can consume on the next turn or active work stream.

*Call graph*: called by 1 (submission_loop); 5 external calls (format!, json!, to_string_pretty, vec!, warn!).


##### `submission_dispatch_span`  (lines 893–921)

```
fn submission_dispatch_span(sub: &Submission) -> tracing::Span
```

**Purpose**: Creates the tracing span used for dispatching a submission and optionally attaches a W3C parent trace context from the submission payload.

**Data flow**: Reads the operation kind from `sub.op.kind()`, formats an OpenTelemetry span name, creates either a `debug_span!` for realtime audio or an `info_span!` for all other ops with submission id and op fields, then if `sub.trace` is present attempts `set_parent_from_w3c_trace_context`; invalid trace carriers trigger a warning. It returns the configured `tracing::Span`.

**Call relations**: Called once per iteration by `submission_loop` before dispatching the operation. It provides consistent observability metadata across all handlers in this file.

*Call graph*: called by 1 (submission_loop); 5 external calls (set_parent_from_w3c_trace_context, debug_span!, format!, info_span!, warn!).


### Concurrency control
Supporting dispatch machinery then governs how work is serialized by resource key and how tool executions run in parallel or exclusive modes with correct cancellation behavior.

### `app-server/src/request_serialization.rs`

`util` · `cross-cutting request dispatch serialization for initialized client requests`

This module implements the app server's per-scope request serialization mechanism. `RequestSerializationQueueKey` enumerates the resource scopes that can be serialized independently: global names, thread ids, thread paths, command-exec processes, generic processes, fuzzy-search sessions, filesystem watches, and MCP OAuth servers. `RequestSerializationQueueKey::from_scope` converts the wire-level `ClientRequestSerializationScope` plus `ConnectionId` into an internal key and an access mode (`Exclusive` or `SharedRead`).

Queued work is represented by `QueuedInitializedRequest`, which pairs a boxed future with a `ConnectionRpcGate`. Running the request goes through `gate.run(future)`, so requests for closed or shutting-down connections are skipped consistently. `RequestSerializationQueues` stores a `HashMap<RequestSerializationQueueKey, VecDeque<QueuedSerializedRequest>>` behind a Tokio mutex. `enqueue` pushes onto an existing queue or creates a new queue and spawns a dedicated drain task for that key. `drain` repeatedly pops the next request; if it is `SharedRead`, it also drains any immediately following shared reads for the same key into the same batch. It then runs the batch concurrently with `join_all`. This preserves FIFO ordering across writes and read/write boundaries while allowing adjacent reads to overlap. The tests cover FIFO behavior for same-key exclusives, concurrency across different keys, skipping requests whose gate is already closed or shuts down while queued, concurrent execution of adjacent shared reads, writer blocking behind running readers, and the invariant that later readers cannot jump ahead of an already queued writer.

#### Function details

##### `RequestSerializationQueueKey::from_scope`  (lines 54–103)

```
fn from_scope(
        connection_id: ConnectionId,
        scope: ClientRequestSerializationScope,
    ) -> (Self, RequestSerializationAccess)
```

**Purpose**: Maps a client-declared serialization scope into the internal queue key and access mode used by the dispatcher. It also folds connection identity into scopes that are connection-local.

**Data flow**: Accepts a `ConnectionId` and `ClientRequestSerializationScope`, matches the scope variant, constructs the corresponding `RequestSerializationQueueKey`, and returns it paired with either `RequestSerializationAccess::Exclusive` or `SharedRead`.

**Call relations**: Called by initialized-request dispatch before enqueuing work so requests that target the same logical resource share a queue.

*Call graph*: called by 1 (dispatch_initialized_client_request); 1 external calls (Global).


##### `QueuedInitializedRequest::new`  (lines 112–120)

```
fn new(
        gate: Arc<ConnectionRpcGate>,
        future: impl Future<Output = ()> + Send + 'static,
    ) -> Self
```

**Purpose**: Wraps a request future together with the connection RPC gate that controls whether it may run. It boxes and pins the future for storage in the queue.

**Data flow**: Accepts `Arc<ConnectionRpcGate>` and any `Future<Output = ()> + Send + 'static`, boxes and pins the future into `BoxFutureUnit`, and returns `QueuedInitializedRequest { gate, future }`.

**Call relations**: Used by request dispatch and by tests to create queueable work items.

*Call graph*: called by 8 (dispatch_initialized_client_request, closed_gate_request_is_skipped_and_following_requests_continue, different_keys_run_concurrently, exclusive_write_waits_for_running_shared_reads, later_shared_reads_do_not_jump_ahead_of_queued_write, same_key_requests_run_fifo, same_key_shared_reads_run_concurrently, shutdown_of_live_gate_skips_already_queued_requests); 1 external calls (pin).


##### `QueuedInitializedRequest::run`  (lines 122–125)

```
async fn run(self)
```

**Purpose**: Executes the queued request through its connection gate. This ensures closed or shutting-down connections suppress queued work consistently.

**Data flow**: Consumes `self`, destructures out `gate` and `future`, and awaits `gate.run(future)`.

**Call relations**: Called by `RequestSerializationQueues::drain` for each dequeued request or shared-read batch member.


##### `RequestSerializationQueues::enqueue`  (lines 139–167)

```
async fn enqueue(
        &self,
        key: RequestSerializationQueueKey,
        access: RequestSerializationAccess,
        request: QueuedInitializedRequest,
    )
```

**Purpose**: Adds a request to the queue for a given key and starts a drain task if this is the first request for that key. It is the only mutation entrypoint for the queue map.

**Data flow**: Accepts a queue key, access mode, and `QueuedInitializedRequest`, wraps them in `QueuedSerializedRequest`, locks `inner`, pushes onto an existing `VecDeque` or inserts a new one, records whether a drain task should be spawned, then if needed clones `self`, creates a tracing span, and spawns `queues.drain(key)`.

**Call relations**: Called by initialized-request dispatch after computing the serialization key. It delegates actual execution ordering to `drain`.

*Call graph*: called by 1 (dispatch_initialized_client_request); 4 external calls (new, clone, spawn, debug_span!).


##### `RequestSerializationQueues::drain`  (lines 169–201)

```
async fn drain(self, key: RequestSerializationQueueKey)
```

**Purpose**: Runs queued requests for one key in the correct order, batching adjacent shared reads so they execute concurrently. It removes the queue entry when the queue becomes empty.

**Data flow**: Consumes `self` and a queue key, loops forever, locks `inner`, fetches the queue for the key, pops the front request, and if that request is `SharedRead` also pops any immediately following shared-read requests into the same vector. If the queue is empty it removes the key and returns. Outside the lock it awaits `join_all` over `request.request.run()` for the batch, then repeats.

**Call relations**: Spawned by `enqueue` once per active key. It is the core scheduler that enforces FIFO ordering and shared-read batching semantics.

*Call graph*: 2 external calls (join_all, vec!).


##### `tests::gate`  (lines 219–221)

```
fn gate() -> Arc<ConnectionRpcGate>
```

**Purpose**: Creates a fresh `ConnectionRpcGate` wrapped in `Arc` for queue tests. It keeps test setup concise.

**Data flow**: Constructs `ConnectionRpcGate::new()`, wraps it in `Arc`, and returns it.

**Call relations**: Shared fixture helper for all request-serialization tests.

*Call graph*: calls 1 internal fn (new); 1 external calls (new).


##### `tests::queue_drain_timeout`  (lines 223–225)

```
fn queue_drain_timeout() -> Duration
```

**Purpose**: Provides a standard timeout used when waiting for queued requests to run in tests. It avoids repeating the same duration literal.

**Data flow**: Returns `Duration::from_secs(1)`.

**Call relations**: Used throughout the tests when awaiting queue progress.

*Call graph*: 1 external calls (from_secs).


##### `tests::shutdown_wait_timeout`  (lines 227–229)

```
fn shutdown_wait_timeout() -> Duration
```

**Purpose**: Provides a short timeout used when asserting something should still be blocked. It distinguishes expected waiting from deadlock.

**Data flow**: Returns `Duration::from_millis(50)`.

**Call relations**: Used by tests that verify shutdown or queued-write blocking behavior.

*Call graph*: 1 external calls (from_millis).


##### `tests::same_key_requests_run_fifo`  (lines 232–272)

```
async fn same_key_requests_run_fifo()
```

**Purpose**: Verifies exclusive requests enqueued under the same key execute strictly in FIFO order. This is the baseline serialization guarantee.

**Data flow**: Creates a default queue set, one global key, a gate, and an unbounded channel; enqueues three exclusive requests that send distinct integers; drains the receiver with timeouts; and asserts the observed values are `[1, 2, 3]`.

**Call relations**: Test-harness coverage for same-key exclusive ordering.

*Call graph*: calls 1 internal fn (new); 9 external calls (clone, new, Global, default, gate, queue_drain_timeout, assert_eq!, unbounded_channel, timeout).


##### `tests::different_keys_run_concurrently`  (lines 275–306)

```
async fn different_keys_run_concurrently()
```

**Purpose**: Checks that requests under different keys do not block each other. A blocked request on one key should not prevent another key from running immediately.

**Data flow**: Creates two one-shot channels, enqueues one exclusive request under key `blocked` that waits on a receiver, enqueues another under key `other` that signals completion, waits for the second to run within the drain timeout, then releases the blocked request.

**Call relations**: Covers cross-key concurrency in the queue scheduler.

*Call graph*: calls 1 internal fn (new); 5 external calls (Global, default, gate, queue_drain_timeout, timeout).


##### `tests::closed_gate_request_is_skipped_and_following_requests_continue`  (lines 309–379)

```
async fn closed_gate_request_is_skipped_and_following_requests_continue()
```

**Purpose**: Verifies a queued request whose gate is already closed is skipped rather than blocking the queue, and later requests on the same key still run. This protects queue progress when a connection disappears.

**Data flow**: Creates one live gate and one gate that is closed before enqueue, enqueues a blocking first request under the live gate, a second request under the closed gate, and a third under the live gate; waits for the first value, releases the blocker, drains remaining values, and asserts only the third value appears after the first.

**Call relations**: Tests the interaction between queue draining and `ConnectionRpcGate::run` skipping behavior.

*Call graph*: calls 1 internal fn (new); 9 external calls (clone, new, Global, default, gate, queue_drain_timeout, assert_eq!, unbounded_channel, timeout).


##### `tests::shutdown_of_live_gate_skips_already_queued_requests`  (lines 382–444)

```
async fn shutdown_of_live_gate_skips_already_queued_requests()
```

**Purpose**: Checks that shutting down a live gate waits for the currently running request but prevents already queued later requests from running. This models orderly connection shutdown.

**Data flow**: Enqueues a blocking first request and a second queued request under the same live gate, waits for the first to start, spawns `gate.shutdown()`, asserts shutdown is still waiting, releases the blocker, then confirms the queue drains without ever receiving the second request's value.

**Call relations**: Covers gate-shutdown semantics for queued work after a request has already started.

*Call graph*: calls 1 internal fn (new); 9 external calls (clone, Global, default, gate, shutdown_wait_timeout, assert_eq!, unbounded_channel, spawn, timeout).


##### `tests::same_key_shared_reads_run_concurrently`  (lines 447–505)

```
async fn same_key_shared_reads_run_concurrently()
```

**Purpose**: Verifies adjacent shared-read requests for the same key are batched and run concurrently once earlier exclusive work finishes. Both readers should start before either is released.

**Data flow**: Enqueues an exclusive blocker under one key, waits for it to start, enqueues two shared-read requests that each signal start and then wait on a broadcast receiver, releases the blocker, collects both start signals, asserts both readers started, then broadcasts release.

**Call relations**: Tests the shared-read batching branch in `drain`.

*Call graph*: calls 1 internal fn (new); 8 external calls (new, Global, default, gate, queue_drain_timeout, assert_eq!, unbounded_channel, timeout).


##### `tests::exclusive_write_waits_for_running_shared_reads`  (lines 508–582)

```
async fn exclusive_write_waits_for_running_shared_reads()
```

**Purpose**: Checks that an exclusive request queued after shared reads does not start until all currently running shared reads finish. This preserves write-after-read ordering.

**Data flow**: Enqueues an exclusive blocker, waits for it to start, enqueues two shared reads and then one exclusive write under the same key, releases the blocker, waits for both reads to start, asserts the write has not started within the short timeout, then releases the reads and confirms the write starts afterward.

**Call relations**: Covers the read-batch then write ordering guarantee in the scheduler.

*Call graph*: calls 1 internal fn (new); 8 external calls (pin, Global, default, gate, queue_drain_timeout, shutdown_wait_timeout, unbounded_channel, timeout).


##### `tests::later_shared_reads_do_not_jump_ahead_of_queued_write`  (lines 585–681)

```
async fn later_shared_reads_do_not_jump_ahead_of_queued_write()
```

**Purpose**: Verifies that a shared read arriving after an exclusive write is queued cannot join an earlier shared-read batch and overtake the write. This preserves FIFO boundaries between batches.

**Data flow**: Enqueues an exclusive blocker, then a first shared read, then an exclusive write, then a later shared read under the same key; releases the blocker; confirms the first read starts while the write and later read remain blocked; releases the first read and confirms the write starts before the later read; then releases the write and confirms the later read starts last.

**Call relations**: Regression test for the subtle queue invariant that only immediately adjacent shared reads batch together.

*Call graph*: calls 1 internal fn (new); 7 external calls (pin, Global, default, gate, queue_drain_timeout, shutdown_wait_timeout, timeout).


### `core/src/tools/parallel.rs`

`orchestration` · `tool call dispatch and cancellation handling`

This module wraps `ToolRouter` dispatch in a runtime that understands parallelism, cancellation, and response shaping. `ToolCallRuntime` holds shared references to the router, session, turn context, a diff tracker, and an `RwLock<()>` used as a coarse execution gate: tools that support parallel execution take a read lock, while exclusive tools take a write lock. That design allows many parallel-safe tools to run together while serializing tools that require isolation.

`handle_tool_call` is the public convenience entry point for direct calls. It delegates to `handle_tool_call_with_source`, then converts `AnyToolResult` into a `ResponseInputItem`; fatal dispatch failures become `CodexErr::Fatal`, while nonfatal tool errors are turned into synthetic failure outputs by `failure_response`. The lower-level `handle_tool_call_with_source` spawns router dispatch in a task wrapped by `AbortOnDropHandle`, tracks whether a terminal outcome has already been claimed with an `AtomicBool`, and races task completion against the caller’s `CancellationToken`. If cancellation arrives after the task has effectively finished, it returns the real result. Otherwise it either waits for runtime-managed cleanup (`waits_for_runtime_cancellation`) or aborts the task immediately, then synthesizes an aborted tool result via `aborted_response` and emits `notify_tool_aborted`.

Response shaping is payload-sensitive: tool-search failures return an empty completed search output, custom tools return `CustomToolCallOutput`, and ordinary tools return `FunctionCallOutput`, all with `success: Some(false)`. Aborted messages are also specialized: plain `shell_command` and `unified_exec` calls get a multi-line wall-time format, while other tools get a concise `aborted by user after ...s` string.

The embedded tests build minimal fake tool executors and lifecycle contributors to verify two subtle races: cancellation after the handler has already finished but before lifecycle finish callbacks complete must preserve the completed lifecycle outcome, while cancellation of a runtime that performs cleanup after observing cancellation must emit only an aborted lifecycle outcome.

#### Function details

##### `ToolCallRuntime::new`  (lines 40–53)

```
fn new(
        router: Arc<ToolRouter>,
        session: Arc<Session>,
        turn_context: Arc<TurnContext>,
        tracker: SharedTurnDiffTracker,
    ) -> Self
```

**Purpose**: Constructs a tool-call runtime with shared router, session, turn context, diff tracker, and a fresh parallel-execution lock. This is the setup step before handling any tool calls.

**Data flow**: Consumes `router`, `session`, `turn_context`, and `tracker` as `Arc` values → creates `parallel_execution: Arc<RwLock<()>>` initialized with a new lock → returns `ToolCallRuntime { ... }`.

**Call relations**: Turn workers, sampling flows, and tests instantiate this runtime before dispatching tool calls. It prepares the shared state used by both direct and nested tool-call handling.

*Call graph*: called by 6 (test_tool_runtime, run_sampling_request, handle_output_item_done_returns_contributed_last_agent_message, start_turn_worker, cancellation_after_handler_finishes_preserves_completed_lifecycle, cancellation_waiting_for_runtime_cleanup_emits_only_aborted_lifecycle); 2 external calls (new, new).


##### `ToolCallRuntime::create_diff_consumer`  (lines 55–60)

```
fn create_diff_consumer(
        &self,
        tool_name: &codex_tools::ToolName,
    ) -> Option<Box<dyn ToolArgumentDiffConsumer>>
```

**Purpose**: Asks the router for an argument-diff consumer for a specific tool name. This exposes router-specific diff tracking through the runtime wrapper.

**Data flow**: Reads `tool_name: &codex_tools::ToolName` → calls `self.router.create_diff_consumer(tool_name)` → returns `Option<Box<dyn ToolArgumentDiffConsumer>>`.

**Call relations**: Sampling-request code calls this when it wants to track argument diffs for a tool invocation. The runtime simply forwards the request to the router.

*Call graph*: called by 1 (try_run_sampling_request).


##### `ToolCallRuntime::handle_tool_call`  (lines 63–79)

```
fn handle_tool_call(
        self,
        call: ToolCall,
        cancellation_token: CancellationToken,
    ) -> impl std::future::Future<Output = Result<ResponseInputItem, CodexErr>>
```

**Purpose**: Handles a direct tool call and converts the result into a `ResponseInputItem` suitable for protocol output. It wraps lower-level dispatch errors into either fatal codex errors or synthetic failure responses.

**Data flow**: Consumes `self`, `call: ToolCall`, and `cancellation_token` → clones the call for fallback error formatting, invokes `handle_tool_call_with_source(call, ToolCallSource::Direct, cancellation_token)`, awaits it, and maps outcomes: successful `AnyToolResult` becomes `into_response()`, `FunctionCallError::Fatal(message)` becomes `Err(CodexErr::Fatal(message))`, and other errors become `Ok(Self::failure_response(error_call, other))`.

**Call relations**: This is the main entry point for ordinary tool calls. It delegates all dispatch, locking, and cancellation logic to `handle_tool_call_with_source`, then performs only the final protocol-level result shaping.

*Call graph*: calls 1 internal fn (handle_tool_call_with_source); 3 external calls (failure_response, clone, Fatal).


##### `ToolCallRuntime::handle_tool_call_with_source`  (lines 82–178)

```
fn handle_tool_call_with_source(
        self,
        call: ToolCall,
        source: ToolCallSource,
        cancellation_token: CancellationToken,
    ) -> impl std::future::Future<Output = Result<
```

**Purpose**: Dispatches a tool call with explicit source metadata, enforcing parallel/exclusive execution rules and resolving cancellation races. It returns either the real `AnyToolResult` or an aborted synthetic result/error.

**Data flow**: Consumes `self`, `call`, `source`, and `cancellation_token` → queries router capabilities (`tool_supports_parallel`, `tool_waits_for_runtime_cancellation`), clones shared state, records start time, creates an `AtomicBool` for terminal-outcome ownership, and spawns a task that acquires either a read or write lock on `parallel_execution` before calling `router.dispatch_tool_call_with_terminal_outcome(...)` under a tracing span → then `tokio::select!` races task completion against `cancellation_token.cancelled()`.

If the task finishes first, it returns the joined result or maps join failure through `tool_task_join_error`. If cancellation wins but the terminal outcome is already reached or the task is finished, it still awaits and returns the real task result. Otherwise it records the span as aborted and either waits for runtime-managed cancellation cleanup or aborts the task immediately, handling cancelled join errors specially. After cleanup/abort, it builds `AnyToolResult` via `aborted_response`, calls `notify_tool_aborted(...)`, and returns the aborted result.

**Call relations**: Direct-call handling and nested tool-call flows both use this method. It delegates actual tool execution to the router, lifecycle abort notification to `notify_tool_aborted`, and join-error formatting plus aborted-result construction to local helpers.

*Call graph*: called by 2 (call_nested_tool, handle_tool_call); 13 external calls (new, clone, new, new, clone, Left, Right, now, clone, clone (+3 more)).


##### `ToolCallRuntime::tool_task_join_error`  (lines 182–184)

```
fn tool_task_join_error(err: JoinError) -> FunctionCallError
```

**Purpose**: Converts a Tokio task join failure into a fatal function-call error. This treats dispatcher task crashes as unrecoverable tool-call failures.

**Data flow**: Consumes `err: JoinError` → formats it into `"tool task failed to receive: {err:?}"` → returns `FunctionCallError::Fatal(...)`.

**Call relations**: Cancellation and normal completion paths in `handle_tool_call_with_source` call this whenever awaiting the spawned dispatch task fails. It centralizes the fatal-error wording.

*Call graph*: 2 external calls (format!, Fatal).


##### `ToolCallRuntime::failure_response`  (lines 186–211)

```
fn failure_response(call: ToolCall, err: FunctionCallError) -> ResponseInputItem
```

**Purpose**: Builds a protocol response item representing a nonfatal tool-call failure, with shape determined by the original tool payload type. This lets the system return structured failure outputs instead of surfacing every tool error as a transport failure.

**Data flow**: Consumes `call: ToolCall` and `err: FunctionCallError` → converts the error to a message string → matches `call.payload`: `ToolSearch` yields `ResponseInputItem::ToolSearchOutput` with empty tools and completed/client status, `Custom` yields `CustomToolCallOutput` with text body and `success: Some(false)`, and all other payloads yield `FunctionCallOutput` with the same text body and failure flag.

**Call relations**: The public `handle_tool_call` method uses this when lower-level dispatch returns a nonfatal `FunctionCallError`. It is the final fallback shaping step for recoverable tool failures.

*Call graph*: 3 external calls (new, Text, to_string).


##### `ToolCallRuntime::aborted_response`  (lines 213–222)

```
fn aborted_response(call: &ToolCall, secs: f32) -> AnyToolResult
```

**Purpose**: Constructs an `AnyToolResult` representing a user-aborted tool call. The payload is preserved, but the result body is replaced with an `AbortedToolOutput` message.

**Data flow**: Reads `call: &ToolCall` and `secs: f32` → clones `call_id` and `payload`, computes the message with `abort_message(call, secs)`, boxes `AbortedToolOutput { message }`, and returns `AnyToolResult { call_id, payload, result, post_tool_use_payload: None }`.

**Call relations**: Cancellation handling in `handle_tool_call_with_source` uses this after it has decided the call should be treated as aborted. It delegates message formatting to `abort_message`.

*Call graph*: 2 external calls (new, abort_message).


##### `ToolCallRuntime::abort_message`  (lines 224–235)

```
fn abort_message(call: &ToolCall, secs: f32) -> String
```

**Purpose**: Formats the human-visible aborted message for a cancelled tool call, with special wording for shell-like tools. This preserves the legacy wall-time format expected for command execution tools.

**Data flow**: Reads `call.tool_name.namespace`, `call.tool_name.name`, and `secs` → if the tool is unnamespaced and named `shell_command` or `unified_exec`, returns `"Wall time: {secs:.1} seconds\naborted by user"`; otherwise returns `"aborted by user after {secs:.1}s"`.

**Call relations**: Only `aborted_response` calls this helper. It encapsulates the special-case formatting logic for shell-oriented tools.

*Call graph*: 2 external calls (format!, matches!).


##### `tests::ImmediateHandler::tool_name`  (lines 261–263)

```
fn tool_name(&self) -> codex_tools::ToolName
```

**Purpose**: Returns the configured test tool name for the immediate-success handler. It satisfies the `ToolExecutor` trait in the test harness.

**Data flow**: Reads `self.tool_name` → clones it → returns the cloned `ToolName`.

**Call relations**: The test router calls this when registering or dispatching the fake handler. It is a simple trait accessor used only in tests.

*Call graph*: 1 external calls (clone).


##### `tests::ImmediateHandler::spec`  (lines 265–274)

```
fn spec(&self) -> codex_tools::ToolSpec
```

**Purpose**: Provides a minimal function-tool spec for the immediate test handler. The spec advertises a non-strict function with default JSON schema and no output schema.

**Data flow**: Reads `self.tool_name.name` → constructs `codex_tools::ResponsesApiTool` with fixed description and defaults → wraps it in `codex_tools::ToolSpec::Function` and returns it.

**Call relations**: The test registry uses this trait method when building the router. It supplies enough metadata for dispatch without affecting the cancellation behavior under test.

*Call graph*: 2 external calls (default, Function).


##### `tests::ImmediateHandler::handle`  (lines 276–283)

```
fn handle(&self, _invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Implements a test tool that completes immediately with a successful text output. It is used to exercise cancellation races after handler completion.

**Data flow**: Ignores the incoming `ToolInvocation` → returns a pinned async future that resolves to `Ok(Box<dyn ToolOutput>)` containing `FunctionToolOutput::from_text("ok", Some(true))`.

**Call relations**: The router dispatches this handler in the completed-lifecycle cancellation test. It does not delegate further beyond constructing the boxed output.

*Call graph*: calls 1 internal fn (from_text); 2 external calls (new, pin).


##### `tests::CancellationCleanupHandler::tool_name`  (lines 296–298)

```
fn tool_name(&self) -> codex_tools::ToolName
```

**Purpose**: Returns the configured test tool name for the cancellation-cleanup handler. It fulfills the `ToolExecutor` trait in tests.

**Data flow**: Reads `self.tool_name` → clones and returns it.

**Call relations**: The test router uses this when registering the cleanup-aware fake tool. It is a simple trait accessor.

*Call graph*: 1 external calls (clone).


##### `tests::CancellationCleanupHandler::spec`  (lines 300–309)

```
fn spec(&self) -> codex_tools::ToolSpec
```

**Purpose**: Provides a minimal function-tool spec for the cleanup-aware test handler. Like the immediate handler, it advertises a simple non-strict function tool.

**Data flow**: Reads `self.tool_name.name` → constructs a `ResponsesApiTool` with fixed description, default schema, and no output schema → wraps it in `ToolSpec::Function` and returns it.

**Call relations**: The test registry consumes this metadata when building the router for cancellation-cleanup scenarios.

*Call graph*: 2 external calls (default, Function).


##### `tests::CancellationCleanupHandler::handle`  (lines 311–313)

```
fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Adapts the async `handle_call` helper into the boxed future shape required by `ToolExecutor`. It keeps the test logic itself in a separate method.

**Data flow**: Consumes `invocation: ToolInvocation` → calls `self.handle_call(invocation)` → boxes and pins the resulting future for trait compatibility.

**Call relations**: The router invokes this trait method during the cleanup test. It delegates all substantive behavior to `handle_call`.

*Call graph*: calls 1 internal fn (handle_call); 1 external calls (pin).


##### `tests::CancellationCleanupHandler::handle_call`  (lines 317–343)

```
async fn handle_call(
            &self,
            invocation: ToolInvocation,
        ) -> Result<Box<dyn crate::tools::context::ToolOutput>, FunctionCallError>
```

**Purpose**: Simulates a tool that notices cancellation, performs asynchronous cleanup, and only then returns. It lets tests verify the runtime path that waits for tool-managed cancellation cleanup.

**Data flow**: Reads `invocation.cancellation_token` and internal synchronization fields → sends a `started` oneshot if present, awaits `invocation.cancellation_token.cancelled()`, sends a `cleanup_started` oneshot if present, waits on `self.allow_cleanup.notified()`, then returns `Ok(Box<dyn ToolOutput>)` containing `FunctionToolOutput::from_text("cleanup complete", Some(false))`.

**Call relations**: The boxed `handle` method delegates here. The runtime cancellation test uses this behavior to ensure the runtime emits an aborted lifecycle outcome instead of the handler’s eventual output.

*Call graph*: calls 1 internal fn (from_text); called by 1 (handle); 1 external calls (new).


##### `tests::CancellationCleanupHandler::waits_for_runtime_cancellation`  (lines 347–349)

```
fn waits_for_runtime_cancellation(&self) -> bool
```

**Purpose**: Marks the cleanup-aware test handler as one that expects the runtime to wait for cancellation cleanup rather than aborting its task immediately.

**Data flow**: Takes `&self` and returns `true` with no side effects.

**Call relations**: The runtime queries this through router capability plumbing during cancellation handling. It drives the branch in `handle_tool_call_with_source` that waits for cleanup before synthesizing an aborted response.


##### `tests::FinishRecorder::on_tool_finish`  (lines 357–369)

```
fn on_tool_finish(
            &'a self,
            input: codex_extension_api::ToolFinishInput<'a>,
        ) -> codex_extension_api::ToolLifecycleFuture<'a>
```

**Purpose**: Records each tool-finish outcome into a shared vector for assertions. It is a lightweight lifecycle contributor used in tests.

**Data flow**: Reads `input.outcome`, clones the shared `records` mutex, and returns a pinned async future that locks the vector and pushes the outcome.

**Call relations**: The cancellation-cleanup test installs this contributor in the extension registry to observe whether the runtime emits `Completed` or `Aborted` finish notifications.

*Call graph*: 2 external calls (clone, pin).


##### `tests::BlockingFinishContributor::on_tool_finish`  (lines 379–401)

```
fn on_tool_finish(
            &'a self,
            input: codex_extension_api::ToolFinishInput<'a>,
        ) -> codex_extension_api::ToolLifecycleFuture<'a>
```

**Purpose**: Simulates a lifecycle contributor whose finish callback blocks until explicitly released. This creates a race window where the handler has finished but lifecycle completion is still in progress.

**Data flow**: Reads `input.outcome`, clones shared `records` and `allow_finish`, takes an optional `finish_started` oneshot sender, and returns a pinned async future that signals `finish_started`, waits on `allow_finish.notified()`, then pushes the outcome into the shared vector.

**Call relations**: The completed-lifecycle cancellation test installs this contributor to verify that cancellation arriving during finish-hook execution does not convert a completed tool call into an aborted one.

*Call graph*: 2 external calls (clone, pin).


##### `tests::cancellation_after_handler_finishes_preserves_completed_lifecycle`  (lines 405–472)

```
async fn cancellation_after_handler_finishes_preserves_completed_lifecycle() -> anyhow::Result<()>
```

**Purpose**: Verifies that if the tool handler has already completed and only lifecycle finish callbacks are still running, a later cancellation does not change the final response or lifecycle outcome. The call should still complete successfully.

**Data flow**: Builds a session and turn context, installs `BlockingFinishContributor`, constructs a router with `ImmediateHandler`, creates `ToolCallRuntime`, spawns `handle_tool_call`, waits until finish notification starts, cancels the token, releases the blocking contributor, awaits the response, and asserts the response is a successful `FunctionCallOutput` with body `"ok"` and the recorded lifecycle outcomes equal `[ToolCallOutcome::Completed { success: true }]`.

**Call relations**: This integration-style test exercises the cancellation race logic in `handle_tool_call_with_source` together with lifecycle notification ordering. It proves the runtime respects an already-claimed terminal outcome.

*Call graph*: calls 6 internal fn (make_session_and_context, new, from_tools, from_parts, new, plain); 16 external calls (clone, new, new, from_millis, from_secs, new, new, assert_eq!, new, channel (+6 more)).


##### `tests::cancellation_waiting_for_runtime_cleanup_emits_only_aborted_lifecycle`  (lines 475–543)

```
async fn cancellation_waiting_for_runtime_cleanup_emits_only_aborted_lifecycle() -> anyhow::Result<()>
```

**Purpose**: Verifies that when a tool waits for runtime-managed cancellation cleanup, cancelling the call yields an aborted response and only an aborted lifecycle finish event. The handler’s eventual cleanup-complete output must not surface as the final result.

**Data flow**: Builds a session and turn context, installs `FinishRecorder`, constructs a router with `CancellationCleanupHandler`, creates `ToolCallRuntime`, spawns `handle_tool_call`, waits for handler start, cancels the token, waits for cleanup to begin, releases cleanup, awaits the response, extracts the text body from the returned `FunctionCallOutput`, asserts it contains `"aborted by user"`, and asserts the recorded lifecycle outcomes equal `[ToolCallOutcome::Aborted]`.

**Call relations**: This test drives the `wait_for_runtime_cancellation` branch in `handle_tool_call_with_source`. It confirms that the runtime, not the handler’s eventual return value, owns the terminal outcome once cancellation is claimed.

*Call graph*: calls 6 internal fn (make_session_and_context, new, from_tools, from_parts, new, plain); 17 external calls (clone, new, new, from_millis, from_secs, new, new, bail!, assert!, assert_eq! (+7 more)).

## 📊 State Registers Touched

- `reg-feature-flags` — The resolved experimental-feature and startup feature-enablement state that gates runtime behavior and can be surfaced or updated through server APIs.
- `reg-tool-catalog` — The runtime-visible catalog of executable tools and their normalized schemas, exposure rules, and metadata used for dispatch and prompt assembly.
- `reg-mcp-server-catalog` — The materialized MCP declarations, runtime server metadata, and contribution overlays used for connection setup, routing, and prompt/tool exposure.
- `reg-app-server-connections` — The live app-server transport/listener/connection registry and per-connection routing state that all RPC handling depends on.
- `reg-remote-control-state` — The persisted and live remote-control desired state, pairing/enrollment records, and reconnecting remote-session state.
- `reg-exec-server-runtime` — The exec-server listener, client, process-control, and environment-discovery runtime state shared across request processing and execution.
- `reg-mcp-runtime-connections` — The live MCP runtime sessions and transport connections maintained for tool routing and integration access.
- `reg-frontend-session-ui-state` — The user-facing frontend session state including startup decisions, terminal ownership, visible chat/transcript state, and loaded thread view.
- `reg-live-thread-registry` — The in-memory registry of active threads and reconstructed thread runtimes that stabilizes ownership across resumes, forks, and UI switching.
- `reg-live-session-object` — The long-lived session object and shared services that own turn submission, event delivery, approvals, persistence, and runtime configuration.
- `reg-thread-projections` — The projected user-visible thread state derived from events and persisted records, including item views, statuses, summaries, and replayed token usage.
- `reg-connection-shutdown-gates` — The per-connection shutdown acceptance flags, running-handler tracking, and cleanup-task registries used for graceful drain and teardown.
- `reg-observability-context` — The global tracing/logging/metrics context and stable session-turn-auth-model-tool tags attached to emitted telemetry throughout runtime.
- `reg-request-serialization-queues` — Per-resource/per-thread ordering queues that serialize conflicting RPC or session requests while allowing unrelated work to proceed concurrently.
- `reg-realtime-session-state` — The live per-thread realtime conversation/session state, including active start/append/stop lifecycle and associated transport/session bookkeeping.
- `reg-command-exec-pty-sessions` — The registry of long-lived interactive command/process sessions, including PTY handles, stdin/write channels, resize/terminate control, and streamed output subscribers.
- `reg-connection-pending-initialization` — Per-connection initialization/handshake state that gates which RPC methods are allowed before a transport session is fully initialized.
- `reg-listener-subscriptions` — The per-thread and per-connection listener/subscription registry that tracks who is watching which thread or process streams for ordered notifications.
- `reg-tool-runtime-concurrency` — The live concurrency, cancellation, and in-flight execution coordination state for parallel tool calls and other dispatched runtime tasks.
