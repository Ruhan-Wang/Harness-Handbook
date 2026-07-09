# Main event loop and request dispatch  `stage-10`

This stage is the system’s normal working loop, after startup is finished. It is the traffic control center for everything that happens while the app is running. On the user side, interactive event dispatch turns keyboard input, paste events, terminal resizing, redraw requests, and background updates into clear app actions, then sends them to the right screen area or chat thread.

On the server side, RPC request routing handles JSON-RPC messages, which are structured requests with names, data, and replies. It checks each request, chooses the right subsystem, and sends back results or errors. The exec server processor does this for each remote execution connection, reading requests, dispatching actions, writing replies, and cleaning up afterward.

Inside a live Codex session, session handlers act like a command desk for user messages, approvals, setting changes, rollbacks, reviews, voice input, and shutdown. Request serialization keeps requests that touch the same resource in a safe order, while allowing unrelated work to continue. Parallel tool handling decides which tool calls can run together, formats their results, and makes cancellation reliable.

## Sub-stages

- [Interactive event dispatch](stage-10.1.md) `stage-10.1` — 96 files
- [RPC request routing](stage-10.2.md) `stage-10.2` — 37 files

## Files in this stage

### Connection dispatch
The exec server enters its steady-state JSON-RPC loop, decoding inbound traffic and routing requests and notifications into higher-level handlers.

### `exec-server/src/server/processor.rs`

`orchestration` · `request handling`

The exec server talks to clients using JSON-RPC, a simple pattern where each message is a request, response, notification, or error written as JSON. This file is the part that sits in the middle of one live connection. It is like a receptionist: it reads each incoming message, checks which server feature it asks for, sends it to the right handler, and returns the answer.

A ConnectionProcessor owns shared session state, so a client can reconnect and resume an existing exec session. When a connection starts, the processor builds a router, creates a handler for real server work, and starts a background task that turns internal server replies into JSON strings for the transport layer to send.

Incoming messages are processed one at a time. That matters because startup messages such as initialize and initialized must happen in order. Badly formed messages get a standard “invalid request” error. Unknown request methods get a “method not found” error. Unexpected client responses, client errors, or unknown notifications are treated as protocol mistakes and close the connection.

The file also watches for disconnects while a request is still running. If the transport disappears, it stops waiting and shuts down cleanly. The included test checks an important reconnect case: an old connection with a long-running read must not block a new connection from resuming the same session.

#### Function details

##### `ConnectionProcessor::new`  (lines 27–32)

```
fn new(runtime_paths: ExecServerRuntimePaths) -> Self
```

**Purpose**: Creates a reusable processor for exec-server connections. It sets up shared session tracking and remembers the runtime paths needed later to run commands.

**Data flow**: It receives the runtime path settings for the server. It creates a fresh shared SessionRegistry, stores the paths beside it, and returns a ConnectionProcessor ready to accept connections.

**Call relations**: Higher-level server and relay code call this when they are setting up an exec-server environment. The processor it returns is later asked to run individual connections through ConnectionProcessor::run_connection.

*Call graph*: calls 1 internal fn (new); called by 10 (processor_exit_reports_closed_virtual_stream, multiplexed_environment_sends_keepalive, duplicate_handshakes_exhaust_failure_budget, oversized_harness_authorization_is_rejected_before_validation, pending_harness_key_validation_does_not_block_new_handshakes, repeated_early_data_during_validation_closes_the_physical_relay, repeated_malformed_handshakes_close_the_physical_relay, run_remote_environment, run_stdio_connection_with_io, run_websocket_listener).


##### `ConnectionProcessor::run_connection`  (lines 34–41)

```
async fn run_connection(&self, connection: JsonRpcConnection)
```

**Purpose**: Starts processing one client connection using the processor’s shared session registry and runtime settings. This is the public wrapper around the file’s main connection loop.

**Data flow**: It receives a JsonRpcConnection, copies the shared session registry pointer and runtime paths, and passes them into the lower-level run_connection function. It waits until that connection loop has fully finished.

**Call relations**: Connection-handling code calls this when a new virtual stream or client link is ready. It delegates the real work to run_connection, so all connections share the same behavior and session registry.

*Call graph*: calls 1 internal fn (run_connection); called by 1 (spawn_noise_virtual_stream); 2 external calls (clone, clone).


##### `run_connection`  (lines 44–185)

```
async fn run_connection(
    connection: JsonRpcConnection,
    session_registry: Arc<SessionRegistry>,
    runtime_paths: ExecServerRuntimePaths,
)
```

**Purpose**: Runs the full life of one JSON-RPC connection: route incoming client messages, send replies, notice disconnects, and clean up tasks. Without this loop, the exec server would receive bytes but would not turn them into server actions or responses.

**Data flow**: It takes a JsonRpcConnection, a shared session registry, and runtime paths. It builds a router, creates an ExecServerHandler, and opens an internal outgoing message channel. As incoming events arrive, it turns valid requests and notifications into handler calls, turns handler results into outbound messages, and sends errors for malformed or unknown requests. When the connection ends or the protocol is broken, it shuts down the handler, closes channels, aborts transport tasks, and waits for the outbound writer task to finish.

**Call relations**: ConnectionProcessor::run_connection and the test helper tests::spawn_test_connection call this. Inside, it relies on build_router to find the right request or notification function, ExecServerHandler to do the actual exec-session work, encode_server_message to serialize replies, and invalid_request or method_not_found to make standard JSON-RPC errors.

*Call graph*: calls 6 internal fn (new, encode_server_message, invalid_request, method_not_found, new, build_router); called by 2 (run_connection, spawn_test_connection); 7 external calls (new, Integer, debug!, format!, select!, spawn, warn!).


##### `tests::transport_disconnect_detaches_session_during_in_flight_read`  (lines 229–316)

```
async fn transport_disconnect_detaches_session_during_in_flight_read()
```

**Purpose**: Checks that a disconnected client does not keep ownership of a session while a long-running read request is still waiting. This protects reconnection: a new client should be able to resume quickly even if the old connection died mid-request.

**Data flow**: The test creates a first fake connection, initializes a session, starts a process, and sends a read request that waits. It then drops the first writer to simulate a disconnect, starts a second fake connection, and tries to resume the same session. The expected result is that the second initialize call returns promptly with the same session id, the first processor exits, and the process can be terminated through the second connection.

**Call relations**: This test drives the same run_connection function used in production through tests::spawn_test_connection. It uses the small test helpers to send JSON-RPC requests and notifications, read typed responses, and build command parameters.

*Call graph*: calls 2 internal fn (from, new); 11 external calls (clone, from_millis, from_secs, assert_eq!, exec_params, read_response, send_notification, send_request, spawn_test_connection, sleep (+1 more)).


##### `tests::spawn_test_connection`  (lines 318–328)

```
fn spawn_test_connection(
        registry: Arc<SessionRegistry>,
        label: &str,
    ) -> (DuplexStream, Lines<BufReader<DuplexStream>>, JoinHandle<()>)
```

**Purpose**: Builds an in-memory client/server connection for tests and starts the real connection processor on the server side. This lets the test exercise production connection logic without opening a real socket or terminal.

**Data flow**: It receives a shared session registry and a label. It creates paired in-memory streams, wraps the server ends as a JsonRpcConnection, starts run_connection in a background task, and returns the client writer, client response reader, and task handle.

**Call relations**: The reconnect test calls this twice, once for the old connection and once for the resumed connection. It hands the fake connection to run_connection so the test uses the same routing, disconnect, and cleanup behavior as real code.

*Call graph*: calls 2 internal fn (from_stdio, run_connection); 4 external calls (new, test_runtime_paths, duplex, spawn).


##### `tests::test_runtime_paths`  (lines 330–336)

```
fn test_runtime_paths() -> ExecServerRuntimePaths
```

**Purpose**: Creates runtime path settings suitable for tests. It points the server at the current test executable and leaves the optional Linux sandbox executable unset.

**Data flow**: It reads the path of the currently running executable, passes that into ExecServerRuntimePaths::new, and returns the resulting runtime paths object.

**Call relations**: tests::spawn_test_connection calls this while constructing a test connection. The returned paths are passed into run_connection so the handler can be created normally.

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

**Purpose**: Sends one JSON-RPC request over a test stream. It hides the repetitive work of wrapping a method name, id, and parameters into the protocol’s request shape.

**Data flow**: It receives a writable in-memory stream, a numeric request id, a method name, and serializable parameters. It converts the parameters to JSON, builds a JSONRPCRequest message, and passes it to tests::write_message to put it on the stream.

**Call relations**: The reconnect test uses this helper for initialize, exec, read, and terminate requests. It hands the final message off to tests::write_message, which performs the actual serialization and write.

*Call graph*: 4 external calls (Request, Integer, write_message, to_value).


##### `tests::send_notification`  (lines 356–365)

```
async fn send_notification(writer: &mut DuplexStream, method: &str, params: &P)
```

**Purpose**: Sends one JSON-RPC notification over a test stream. A notification is like a request that does not expect a response.

**Data flow**: It receives a writable stream, a method name, and serializable parameters. It converts the parameters to JSON, builds a JSONRPCNotification message, and sends it through tests::write_message.

**Call relations**: The reconnect test uses this to send the initialized notification after each successful initialize response. It shares the low-level writing path with tests::send_request.

*Call graph*: 3 external calls (Notification, write_message, to_value).


##### `tests::write_message`  (lines 367–371)

```
async fn write_message(writer: &mut DuplexStream, message: &JSONRPCMessage)
```

**Purpose**: Writes a JSON-RPC message to the test stream in the same line-based format the server expects. Each message is encoded as JSON followed by a newline.

**Data flow**: It receives a writable in-memory stream and a JSON-RPC message. It serializes the message into bytes, writes those bytes, then writes a newline so the reader can tell where the message ends.

**Call relations**: tests::send_request and tests::send_notification both use this helper. It is the final step before the test message reaches the production connection reader.

*Call graph*: 2 external calls (write_all, to_vec).


##### `tests::read_response`  (lines 373–390)

```
async fn read_response(
        lines: &mut Lines<BufReader<DuplexStream>>,
        expected_id: i64,
    ) -> T
```

**Purpose**: Reads one JSON-RPC response from a test stream and decodes its result into the type the test expects. It also verifies that the response id matches the request id.

**Data flow**: It receives a line reader and the expected numeric id. It reads one line, parses it as a JSON-RPC message, checks that it is a response with the expected id, converts the response result into the requested Rust type, and returns that value. If it sees an error or a different message kind, the test fails.

**Call relations**: The reconnect test uses this after requests that should produce replies, such as initialize, exec, and terminate. It turns raw JSON lines coming back from run_connection into strongly checked test values.

*Call graph*: 4 external calls (next_line, assert_eq!, panic!, from_value).


##### `tests::exec_params`  (lines 392–407)

```
fn exec_params(process_id: ProcessId) -> ExecParams
```

**Purpose**: Builds the parameters for a test command that starts a process and produces output later. The delayed output is useful for creating a read request that can stay in flight.

**Data flow**: It receives a process id. It copies the PATH environment variable if available, gets the current directory as a URI, chooses the platform-specific delayed command from tests::sleep_then_print_argv, and returns an ExecParams structure for starting that command.

**Call relations**: The reconnect test calls this before sending the exec request. It depends on tests::sleep_then_print_argv for the actual command line and supplies the request body used by tests::send_request.

*Call graph*: calls 1 internal fn (from_path); 4 external calls (new, sleep_then_print_argv, current_dir, var_os).


##### `tests::sleep_then_print_argv`  (lines 409–423)

```
fn sleep_then_print_argv() -> Vec<String>
```

**Purpose**: Returns a small command line that waits briefly and then prints text. It uses different commands on Windows and non-Windows systems so the test can run on both.

**Data flow**: It checks the operating system at compile time. On Windows it returns a command shell invocation using ping as a delay; elsewhere it returns a shell command using sleep and printf. The result is a list of command arguments.

**Call relations**: tests::exec_params calls this when building the test process parameters. Its delayed output helps the main reconnect test create a long-poll read that is still pending when the first connection disconnects.

*Call graph*: 2 external calls (cfg!, vec!).


### Session request handling
Session-level dispatch turns incoming operations into concrete protocol handling, coordinating mutations, task launches, and outbound effects.

### `core/src/session/handlers.rs`

`orchestration` · `main loop, request handling, and teardown`

A Codex session is a live conversation with background tasks, tool calls, saved history, permissions, and sometimes realtime audio. This file turns incoming protocol requests into concrete session actions. Think of it like a hotel front desk: guests ask for many different things, and the desk either handles them directly or sends them to housekeeping, maintenance, security, or checkout.

The central piece is `submission_loop`, which waits for `Submission` messages from a channel. Each submission contains an `Op`, meaning an operation requested by the client. The loop matches the operation and calls a smaller handler: start a new user turn, update settings, answer an approval prompt, run a shell command, refresh MCP servers, roll back history, compact the conversation, start a review, or shut the session down.

Several helpers keep the behavior safe and predictable. Settings updates are converted into internal session updates and echoed back as a snapshot. User input either steers an active turn or starts a new model task. Rollback refuses to run during an active turn and carefully reloads persisted history before replaying it. Shutdown stops running tasks, closes services, flushes saved thread state, emits lifecycle hooks, and finally reports completion. The file also creates tracing spans, which are labeled timing/logging scopes that help operators see what each incoming operation did.

#### Function details

##### `interrupt`  (lines 63–65)

```
async fn interrupt(sess: &Arc<Session>)
```

**Purpose**: Stops the currently running session task, such as an in-progress model turn or tool activity. A client uses this when the user wants Codex to stop what it is doing.

**Data flow**: It receives a shared session reference → asks the session to interrupt its active task → nothing is returned, but the running work is signaled to stop.

**Call relations**: `submission_loop` calls this when it receives an interrupt operation. The actual stopping work is handed to the session object, which owns the active task.

*Call graph*: called by 1 (submission_loop).


##### `clean_background_terminals`  (lines 67–69)

```
async fn clean_background_terminals(sess: &Arc<Session>)
```

**Purpose**: Closes background terminal processes that were left open by the session. This is useful when the client wants to clean up hidden or auxiliary command processes.

**Data flow**: It receives the session → tells it to close unified execution processes → returns after the cleanup request has been made.

**Call relations**: `submission_loop` calls this for the clean-background-terminals operation. The session’s execution process layer does the real cleanup.

*Call graph*: called by 1 (submission_loop).


##### `realtime_conversation_list_voices`  (lines 71–81)

```
async fn realtime_conversation_list_voices(sess: &Session, sub_id: String)
```

**Purpose**: Sends the client the built-in list of voices available for realtime conversation. It answers a simple “what voices can I use?” request.

**Data flow**: It receives the session and submission id → builds a response event containing the built-in voice list → sends that event back under the same id.

**Call relations**: `submission_loop` calls this for realtime voice-list requests, and tests call it to check the emitted list. It does not ask an external service; it uses the built-in voice catalog.

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

**Purpose**: Public wrapper for processing user input. It exists so callers can use a simple entry point while the detailed logic stays in `user_input_or_turn_inner`.

**Data flow**: It receives the session, submission id, operation, and optional client message id → forwards all of that unchanged → returns when the inner processing is done.

**Call relations**: `submission_loop` and tests call this. It immediately delegates to `user_input_or_turn_inner`, which decides whether to steer an active turn or start a new one.

*Call graph*: calls 1 internal fn (user_input_or_turn_inner); called by 2 (submission_loop, user_turn_updates_approvals_reviewer).


##### `update_thread_settings`  (lines 92–106)

```
async fn update_thread_settings(
    sess: &Arc<Session>,
    sub_id: String,
    thread_settings: ThreadSettingsOverrides,
)
```

**Purpose**: Applies new conversation-level settings, such as model, permissions, sandboxing, workspace roots, or personality. It also reports either the applied settings snapshot or a clear error back to the client.

**Data flow**: It receives setting overrides → converts them into the session’s internal update format → asks the session to apply them → sends either a settings-applied event or an invalid-settings error.

**Call relations**: `submission_loop` calls this for thread settings operations. It relies on `thread_settings_update` to prepare the update and `thread_settings_applied_event` to describe the result.

*Call graph*: calls 2 internal fn (thread_settings_applied_event, thread_settings_update); called by 1 (submission_loop); 2 external calls (format!, Error).


##### `thread_settings_update`  (lines 108–157)

```
async fn thread_settings_update(
    sess: &Session,
    thread_settings: ThreadSettingsOverrides,
) -> SessionSettingsUpdate
```

**Purpose**: Translates protocol-facing setting overrides into the internal update object the session understands. It also preserves the current collaboration mode when only model or reasoning effort changes are supplied.

**Data flow**: It receives the session and the user’s partial settings override → reads current session configuration if needed → builds a `SessionSettingsUpdate` with explicit fields and defaults for the rest.

**Call relations**: `update_thread_settings` uses this for standalone settings changes, and `user_input_or_turn_inner` uses it when a user message includes settings changes. It is the adapter between client settings and session settings.

*Call graph*: called by 2 (update_thread_settings, user_input_or_turn_inner); 1 external calls (default).


##### `thread_settings_applied_event`  (lines 159–181)

```
async fn thread_settings_applied_event(sess: &Session) -> EventMsg
```

**Purpose**: Builds the confirmation message that tells the client what settings are now active. This prevents the client from guessing after a partial update.

**Data flow**: It reads the session’s current thread configuration snapshot → copies the relevant fields into a protocol event → returns that event message.

**Call relations**: `update_thread_settings` sends this after a successful settings update. `user_input_or_turn_inner` also sends it when a user input request included settings overrides.

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

**Purpose**: Processes a user message. It either adds the message to an already-running turn or starts a fresh model turn with the user input and any extra context.

**Data flow**: It receives a user-input operation → optionally applies thread settings and output schema → opens a new turn record → tries to steer an active turn → if no active turn exists, merges extra context, builds task input, refreshes requested MCP servers, and spawns a regular task → if something fails, sends an error event.

**Call relations**: `user_input_or_turn` and realtime text routing call this. It coordinates session state, telemetry, MCP refresh, context merging, and task spawning so the user’s message becomes model work.

*Call graph*: calls 3 internal fn (thread_settings_applied_event, thread_settings_update, new); called by 2 (route_realtime_text_input, user_input_or_turn); 5 external calls (clone, default, Error, default, unreachable!).


##### `inter_agent_communication`  (lines 279–292)

```
async fn inter_agent_communication(
    sess: &Arc<Session>,
    sub_id: String,
    communication: InterAgentCommunication,
)
```

**Purpose**: Queues a message from another agent and optionally starts work if the session is idle. This lets agents leave mailbox-style messages for the conversation.

**Data flow**: It receives inter-agent communication → stores it in the session input queue → if the message says to trigger a turn, asks the session to start pending work under the submission id.

**Call relations**: `submission_loop` calls this for inter-agent communication operations. The pending-work scheduler decides whether the queued message should become a new turn.

*Call graph*: called by 1 (submission_loop).


##### `run_user_shell_command`  (lines 294–319)

```
async fn run_user_shell_command(sess: &Arc<Session>, sub_id: String, command: String)
```

**Purpose**: Runs a shell command requested directly by the user. If a turn is already active, it runs as side work for that turn; otherwise it starts a dedicated shell-command task.

**Data flow**: It receives the command and session → checks for an active turn and cancellation token → either spawns an auxiliary command task tied to that turn, or creates a new default turn and spawns a `UserShellCommandTask` → returns immediately after scheduling.

**Call relations**: `submission_loop` calls this for run-shell-command operations, and tests check its context behavior. It hands actual command execution to `execute_user_shell_command` or to a task object.

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

**Purpose**: Sends the user’s answer to an MCP elicitation request. An elicitation is a prompt from an external tool/server asking the user to provide or approve information.

**Data flow**: It receives server name, request id, decision, optional content, and metadata → converts protocol types into the MCP client’s types → fills in an empty object for accepted legacy responses with no content → asks the session to resolve the request → logs a warning if resolution fails.

**Call relations**: `submission_loop` calls this when the client answers an elicitation. The session then forwards the answer to the MCP connection that originally asked.

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

**Purpose**: Applies the user’s decision about an execution approval request. It can also persist an approved execution-policy amendment before notifying the waiting task.

**Data flow**: It receives an approval id, optional turn id, and decision → if the decision includes an exec-policy amendment, tries to save it and records or warns about the result → if the decision is abort, interrupts the task; otherwise notifies the session of the approval decision.

**Call relations**: `submission_loop` calls this for exec approval operations. It connects the client’s security decision to the paused command or tool request waiting inside the session.

*Call graph*: called by 1 (submission_loop); 3 external calls (format!, Warning, warn!).


##### `patch_approval`  (lines 405–412)

```
async fn patch_approval(sess: &Arc<Session>, id: String, decision: ReviewDecision)
```

**Purpose**: Applies the user’s decision about a patch approval request. A patch approval is permission to make or apply file changes.

**Data flow**: It receives the approval id and decision → interrupts the running task if the decision is abort → otherwise sends the decision to the session’s approval waiters.

**Call relations**: `submission_loop` calls this for patch approval operations. It is the patch-specific counterpart to `exec_approval`, but without exec-policy amendment handling.

*Call graph*: called by 1 (submission_loop).


##### `request_user_input_response`  (lines 414–420)

```
async fn request_user_input_response(
    sess: &Arc<Session>,
    id: String,
    response: RequestUserInputResponse,
)
```

**Purpose**: Delivers the client’s answer to a pending request for more user input. This unblocks session work that paused to ask the user a question.

**Data flow**: It receives the request id and response → passes both to the session → returns after the session has been notified.

**Call relations**: `submission_loop` calls this when a user-input-answer operation arrives. The session matches the id to the waiting task.

*Call graph*: called by 1 (submission_loop).


##### `request_permissions_response`  (lines 422–429)

```
async fn request_permissions_response(
    sess: &Arc<Session>,
    id: String,
    response: RequestPermissionsResponse,
)
```

**Purpose**: Delivers the client’s answer to a pending permissions request. This lets paused work continue or stop based on the user’s permission decision.

**Data flow**: It receives the request id and permission response → passes them to the session’s permission-response notifier → returns when notification is complete.

**Call relations**: `submission_loop` calls this for request-permissions-response operations. The session wakes the part of the system waiting for that permission decision.

*Call graph*: called by 1 (submission_loop).


##### `dynamic_tool_response`  (lines 431–433)

```
async fn dynamic_tool_response(sess: &Arc<Session>, id: String, response: DynamicToolResponse)
```

**Purpose**: Delivers a response for a dynamic tool request. Dynamic tools are tools whose details can be supplied or changed at runtime rather than being fixed in the program.

**Data flow**: It receives the tool request id and response → forwards them to the session → returns after the waiting tool flow has been notified.

**Call relations**: `submission_loop` calls this for dynamic-tool-response operations. The session connects the response to the tool request that was waiting.

*Call graph*: called by 1 (submission_loop).


##### `refresh_mcp_servers`  (lines 435–438)

```
async fn refresh_mcp_servers(sess: &Arc<Session>, refresh_config: McpServerRefreshConfig)
```

**Purpose**: Records that MCP servers should be refreshed using the given configuration. MCP servers are external tool servers that Codex can connect to.

**Data flow**: It receives a refresh configuration → locks the session’s pending-refresh slot, which is a protected shared value → stores the configuration there for later use.

**Call relations**: `submission_loop` calls this when the client asks to refresh MCP servers. Later turn setup reads the pending configuration and performs the refresh.

*Call graph*: called by 1 (submission_loop).


##### `reload_user_config`  (lines 440–442)

```
async fn reload_user_config(sess: &Arc<Session>)
```

**Purpose**: Reloads the user configuration layer for the running session. This lets changes to user config take effect without restarting the whole process.

**Data flow**: It receives the session → asks it to reload user config → returns when the reload operation completes.

**Call relations**: `submission_loop` calls this for reload-user-config operations. The session owns the actual configuration reload logic.

*Call graph*: called by 1 (submission_loop).


##### `compact`  (lines 444–449)

```
async fn compact(sess: &Arc<Session>, sub_id: String)
```

**Purpose**: Starts a compaction task, which reduces or summarizes conversation context so the session can keep working within model limits. It is like tidying a long notebook so the important parts remain usable.

**Data flow**: It receives the session and submission id → creates a new default turn context → spawns a `CompactTask` with no user input items → returns after scheduling the task.

**Call relations**: `submission_loop` calls this for compact operations. The session task system performs the actual compaction work.

*Call graph*: called by 1 (submission_loop); 2 external calls (clone, new).


##### `thread_rollback`  (lines 451–549)

```
async fn thread_rollback(sess: &Arc<Session>, sub_id: String, num_turns: u32)
```

**Purpose**: Rolls the conversation thread back by a requested number of user turns. It is used when the client wants to undo recent conversation history and continue from an earlier point.

**Data flow**: It receives the session, submission id, and number of turns → rejects zero turns and rejects rollback during an active turn → opens a default turn context → loads and flushes persisted thread history → appends a rollback marker to the replay data → reconstructs in-memory state, recomputes token usage, persists the marker, and emits a rollback event or warning/error as needed.

**Call relations**: `submission_loop` calls this for rollback operations, and many tests exercise its safety cases. It depends on persisted thread history because rollback must rebuild the session from durable records rather than guess from partial memory.

*Call graph*: called by 9 (submission_loop, thread_rollback_clears_history_when_num_turns_exceeds_existing_turns, thread_rollback_drops_last_turn_from_history, thread_rollback_fails_when_num_turns_is_zero, thread_rollback_fails_when_turn_in_progress, thread_rollback_fails_without_persisted_thread_history, thread_rollback_persists_marker_and_replays_cumulatively, thread_rollback_recomputes_previous_turn_settings_and_reference_context_from_replay, thread_rollback_restores_cleared_reference_context_item_after_compaction); 6 external calls (format!, Error, ThreadRolledBack, Warning, EventMsg, once).


##### `persist_thread_memory_mode_update`  (lines 551–563)

```
async fn persist_thread_memory_mode_update(
    sess: &Arc<Session>,
    mode: ThreadMemoryMode,
) -> anyhow::Result<()>
```

**Purpose**: Writes the thread’s memory mode setting into persisted thread metadata. This controls whether the thread is eligible for future memory generation.

**Data flow**: It receives the session and desired memory mode → obtains the live persisted thread → makes sure current state is persisted and flushed → updates the memory mode in stored metadata → flushes again → returns success or an error.

**Call relations**: `set_thread_memory_mode` calls this and turns any error into a client-facing event. The function isolates the durable-storage steps from the public handler.

*Call graph*: called by 2 (set_thread_memory_mode, set_thread_memory_mode).


##### `set_thread_memory_mode`  (lines 569–581)

```
async fn set_thread_memory_mode(sess: &Arc<Session>, sub_id: String, mode: ThreadMemoryMode)
```

**Purpose**: Applies a thread-level memory mode change and reports failures. It does not talk to the model; it only changes saved metadata about the thread.

**Data flow**: It receives the session, submission id, and mode → calls `persist_thread_memory_mode_update` → if that fails, logs the problem and sends an error event to the client.

**Call relations**: `submission_loop` calls this for set-thread-memory-mode operations. It relies on `persist_thread_memory_mode_update` for storage and handles user-visible error reporting.

*Call graph*: calls 1 internal fn (persist_thread_memory_mode_update); called by 1 (submission_loop); 2 external calls (Error, warn!).


##### `shutdown_session_runtime`  (lines 583–602)

```
async fn shutdown_session_runtime(sess: &Arc<Session>)
```

**Purpose**: Stops the live runtime pieces of a session. This is the cleanup step that prevents background work, processes, connections, and review services from continuing after the session ends.

**Data flow**: It receives the session → aborts startup prewarm if present → aborts all tasks → shuts down the conversation, execution processes, code mode service, MCP connections, and Guardian review session → logs if code mode shutdown fails.

**Call relations**: `shutdown` calls this during an explicit shutdown, and `submission_loop` calls it if the submission channel closes unexpectedly. It is runtime cleanup, separate from sending the final shutdown event.

*Call graph*: called by 2 (shutdown, submission_loop); 1 external calls (warn!).


##### `emit_thread_stop_lifecycle`  (lines 604–613)

```
async fn emit_thread_stop_lifecycle(sess: &Session)
```

**Purpose**: Notifies extensions that the thread is stopping. Extensions are add-on components that may need to save data or run cleanup code.

**Data flow**: It receives the session → asks the extension service for thread-lifecycle contributors → calls each contributor’s stop hook with access to session and thread extension stores → returns after all hooks finish.

**Call relations**: `shutdown` and `submission_loop` call this during teardown. It gives extensions a formal chance to react before the session is fully gone.

*Call graph*: called by 2 (shutdown, submission_loop).


##### `shutdown`  (lines 615–660)

```
async fn shutdown(sess: &Arc<Session>, sub_id: String) -> bool
```

**Purpose**: Performs a full, explicit session shutdown and tells the client it is complete. It also records final telemetry and closes persisted thread state cleanly.

**Data flow**: It receives the session and submission id → stops runtime services → counts user turns from history and records telemetry → emits thread-stop lifecycle hooks → shuts down live thread persistence if present → records and delivers a shutdown-complete event → marks the rollout trace completed → returns true to tell the loop to exit.

**Call relations**: `submission_loop` calls this when it receives a shutdown operation. It builds on `shutdown_session_runtime` and `emit_thread_stop_lifecycle`, then adds client notification and trace finalization.

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

**Purpose**: Starts a review flow for a requested target, such as code or changes needing inspection. It validates and resolves the request before launching the review thread.

**Data flow**: It receives the session, config, submission id, and review request → creates a default turn context → emits model warnings and refreshes MCP servers if needed → resolves the review request relative to the current working directory → either spawns a review thread or sends an error event.

**Call relations**: `submission_loop` calls this for review operations. It hands validated review work to `spawn_review_thread`; invalid requests are reported directly to the client.

*Call graph*: called by 1 (submission_loop); 4 external calls (clone, resolve_review_request, spawn_review_thread, Error).


##### `submission_loop`  (lines 698–851)

```
async fn submission_loop(
    sess: Arc<Session>,
    config: Arc<Config>,
    rx_sub: Receiver<Submission>,
)
```

**Purpose**: The main dispatcher for a session’s incoming client operations. It keeps reading submissions and calls the right handler for each operation until shutdown or channel closure.

**Data flow**: It receives the session, config, and a channel of submissions → repeatedly reads one submission at a time → creates a tracing span for observability → matches the operation and awaits the matching handler → exits on explicit shutdown, or performs cleanup if the channel closes without shutdown.

**Call relations**: `spawn_internal` starts this loop. It is the hub that calls nearly every other handler in this file, plus realtime conversation handlers from another module.

*Call graph*: calls 30 internal fn (handle_audio, handle_close, handle_speech, handle_start, handle_text, approve_guardian_denied_action, clean_background_terminals, compact, dynamic_tool_response, emit_thread_stop_lifecycle (+15 more)); called by 1 (spawn_internal); 2 external calls (debug!, Error).


##### `approve_guardian_denied_action`  (lines 853–891)

```
async fn approve_guardian_denied_action(sess: &Arc<Session>, event: GuardianAssessmentEvent)
```

**Purpose**: Turns a user approval of a previously denied Guardian action into developer instructions injected into the session. Guardian is a safety review layer that can deny risky actions.

**Data flow**: It receives the session and Guardian assessment event → ignores it unless the event was denied → builds a JSON description of the exact approved action → formats developer text saying only that exact action is approved → injects that message into the session without starting a new turn.

**Call relations**: `submission_loop` calls this for approve-Guardian-denied-action operations. It does not directly execute the action; it adds precise approval context so the ongoing flow can reconsider it.

*Call graph*: called by 1 (submission_loop); 5 external calls (format!, json!, to_string_pretty, vec!, warn!).


##### `submission_dispatch_span`  (lines 893–921)

```
fn submission_dispatch_span(sub: &Submission) -> tracing::Span
```

**Purpose**: Creates a tracing span for one incoming submission. A tracing span is a labeled block of logs and timing data that helps developers understand what happened during that operation.

**Data flow**: It receives a submission → reads the operation kind and id → creates a debug-level span for high-volume realtime audio or an info-level span for other operations → attaches a parent trace from the submission if valid → returns the span.

**Call relations**: `submission_loop` calls this before dispatching each operation and then runs the handler inside the span. This ties logs and telemetry for that operation together.

*Call graph*: called by 1 (submission_loop); 5 external calls (set_parent_from_w3c_trace_context, debug_span!, format!, info_span!, warn!).


### Concurrency control
Supporting dispatch machinery then governs how work is serialized by resource key and how tool executions run in parallel or exclusive modes with correct cancellation behavior.

### `app-server/src/request_serialization.rs`

`domain_logic` · `request handling`

Some client requests must not run on top of each other. For example, two requests that change the same thread, process, file watch, or OAuth flow could interfere if they happen at once. This file provides the waiting-room system for those requests.

The main idea is a key: `RequestSerializationQueueKey` names the thing a request is about, such as a thread, a process, a path, or a global operation. Requests with the same key share one line. Requests with different keys get different lines and can move independently.

Each queued request also says whether it needs `Exclusive` access, meaning it must run alone, or `SharedRead` access, meaning it can run beside other reads. This is like a library room: many people may read the same book at once, but only one person may rewrite it.

`RequestSerializationQueues` stores one first-in, first-out queue per key. When the first request for a key arrives, it starts a background task that drains that key’s queue. The drainer runs one exclusive request at a time, or groups consecutive shared reads and waits for them all to finish before moving on. It does not let later reads skip ahead of an already queued exclusive request.

Each queued request is wrapped with a `ConnectionRpcGate`, which acts like a safety gate for a client connection. If the connection is closed or shutting down, the gate can prevent already queued work from running.

#### Function details

##### `RequestSerializationQueueKey::from_scope`  (lines 54–103)

```
fn from_scope(
        connection_id: ConnectionId,
        scope: ClientRequestSerializationScope,
    ) -> (Self, RequestSerializationAccess)
```

**Purpose**: This converts the request’s public serialization scope into the internal queue key used by the server. It also decides whether that scope should run alone or may share time with other read-only requests.

**Data flow**: It receives the connection id and a client-provided scope. It matches the scope to the correct internal key, adding the connection id where needed so two clients do not accidentally share a process or file-watch queue. It returns the key plus either exclusive or shared-read access.

**Call relations**: When `dispatch_initialized_client_request` is preparing a client request, it calls this function to find the correct waiting line for that request. The result is then used to enqueue the request with the right ordering rules.

*Call graph*: called by 1 (dispatch_initialized_client_request); 1 external calls (Global).


##### `QueuedInitializedRequest::new`  (lines 112–120)

```
fn new(
        gate: Arc<ConnectionRpcGate>,
        future: impl Future<Output = ()> + Send + 'static,
    ) -> Self
```

**Purpose**: This packages an already prepared request so it can be stored in a queue and run later. It keeps the request together with the connection gate that decides whether it is still allowed to run.

**Data flow**: It receives a shared `ConnectionRpcGate` and an asynchronous future, which is work that will finish later. It pins and boxes the future so different kinds of request work can be stored in the same queue shape. It returns a `QueuedInitializedRequest` ready for queuing.

**Call relations**: `dispatch_initialized_client_request` uses this before putting real client work into the serialization queues. The tests also use it to build small fake requests that prove the queue runs, skips, and orders work correctly.

*Call graph*: called by 8 (dispatch_initialized_client_request, closed_gate_request_is_skipped_and_following_requests_continue, different_keys_run_concurrently, exclusive_write_waits_for_running_shared_reads, later_shared_reads_do_not_jump_ahead_of_queued_write, same_key_requests_run_fifo, same_key_shared_reads_run_concurrently, shutdown_of_live_gate_skips_already_queued_requests); 1 external calls (pin).


##### `QueuedInitializedRequest::run`  (lines 122–125)

```
async fn run(self)
```

**Purpose**: This runs one queued request through its connection gate. The gate is important because queued work may become invalid if the client disconnects or the connection is shutting down before the request reaches the front of the line.

**Data flow**: It takes ownership of the queued request, separates the gate from the stored future, and asks the gate to run the future. The future may execute, or the gate may prevent it depending on connection state. The function returns nothing when the attempt is complete.

**Call relations**: This is the final execution step for a queued item. The queue-draining logic calls on it when a request or group of compatible requests is ready to leave the waiting line.


##### `RequestSerializationQueues::enqueue`  (lines 139–167)

```
async fn enqueue(
        &self,
        key: RequestSerializationQueueKey,
        access: RequestSerializationAccess,
        request: QueuedInitializedRequest,
    )
```

**Purpose**: This adds a request to the correct per-resource queue. If this is the first request for that resource, it also starts a background task to drain that queue.

**Data flow**: It receives a queue key, an access mode, and a prepared queued request. It locks the shared map of queues, appends the request if a queue already exists, or creates a new queue if not. If it created a new queue, it spawns an asynchronous drainer for that key and then returns.

**Call relations**: `dispatch_initialized_client_request` calls this after it has translated a client request into a queue key. This function hands off actual execution to `RequestSerializationQueues::drain` by spawning a background task for newly active keys.

*Call graph*: called by 1 (dispatch_initialized_client_request); 4 external calls (new, clone, spawn, debug_span!).


##### `RequestSerializationQueues::drain`  (lines 169–201)

```
async fn drain(self, key: RequestSerializationQueueKey)
```

**Purpose**: This is the worker that empties one queue in the correct order. It enforces the rule that exclusive requests run alone, while consecutive shared reads may run together.

**Data flow**: It receives the queue collection and the key it is responsible for. In a loop, it locks the queue map, removes the next request, and, if that request is a shared read, also removes any immediately following shared reads. It then runs that batch and waits until all of it finishes. When the queue is empty, it removes the queue from the map and exits.

**Call relations**: `RequestSerializationQueues::enqueue` starts this function when a key first becomes active. Inside the drain loop, it runs queued requests and uses `join_all` to wait for a batch of shared reads to complete before continuing.

*Call graph*: 2 external calls (join_all, vec!).


##### `tests::gate`  (lines 219–221)

```
fn gate() -> Arc<ConnectionRpcGate>
```

**Purpose**: This test helper creates a fresh connection gate. Tests use it so each fake request can behave like it belongs to a real client connection.

**Data flow**: It takes no input. It creates a new `ConnectionRpcGate`, wraps it in shared ownership, and returns it to the test.

**Call relations**: The queue behavior tests call this whenever they need a live gate for a queued fake request. It keeps the tests shorter and makes the gate setup consistent.

*Call graph*: calls 1 internal fn (new); 1 external calls (new).


##### `tests::queue_drain_timeout`  (lines 223–225)

```
fn queue_drain_timeout() -> Duration
```

**Purpose**: This test helper gives a standard maximum wait time for queue activity. It prevents tests from hanging forever if a queued request never runs.

**Data flow**: It takes no input and returns a one-second duration. Tests pass that duration to timeout checks around expected queue progress.

**Call relations**: The async tests call this while waiting for messages that prove a request started or a queue drained. If the timeout expires, the test fails instead of stalling.

*Call graph*: 1 external calls (from_secs).


##### `tests::shutdown_wait_timeout`  (lines 227–229)

```
fn shutdown_wait_timeout() -> Duration
```

**Purpose**: This test helper gives a short wait time used when something is expected not to happen yet. It helps prove that shutdowns or writes are correctly blocked while earlier work is still running.

**Data flow**: It takes no input and returns a fifty-millisecond duration. Tests use it with timeout checks where success would mean the queue moved too early.

**Call relations**: Tests for shutdown and shared-read ordering call this to confirm that a task remains waiting at the right moment.

*Call graph*: 1 external calls (from_millis).


##### `tests::same_key_requests_run_fifo`  (lines 232–272)

```
async fn same_key_requests_run_fifo()
```

**Purpose**: This test proves that exclusive requests with the same key run in first-in, first-out order. In plain terms, the first request put in line is the first one served.

**Data flow**: The test creates one queue key and enqueues three fake exclusive requests that send the values 1, 2, and 3. It then reads those values from a channel. The expected output is the same order: 1, then 2, then 3.

**Call relations**: It builds requests with `QueuedInitializedRequest::new`, puts them into `RequestSerializationQueues::enqueue`, and uses `queue_drain_timeout` while waiting. It exercises the core same-key ordering path.

*Call graph*: calls 1 internal fn (new); 9 external calls (clone, new, Global, default, gate, queue_drain_timeout, assert_eq!, unbounded_channel, timeout).


##### `tests::different_keys_run_concurrently`  (lines 275–306)

```
async fn different_keys_run_concurrently()
```

**Purpose**: This test proves that a stuck request for one key does not block a request for another key. Separate resources should have separate waiting lines.

**Data flow**: The test enqueues one request under a key that waits until it is released. Then it enqueues another request under a different key that immediately signals it ran. The expected result is that the second request runs even while the first is still blocked.

**Call relations**: It uses `QueuedInitializedRequest::new` and `RequestSerializationQueues::enqueue` to create two independent queues. The timeout confirms that the second queue’s drainer is not held up by the first queue.

*Call graph*: calls 1 internal fn (new); 5 external calls (Global, default, gate, queue_drain_timeout, timeout).


##### `tests::closed_gate_request_is_skipped_and_following_requests_continue`  (lines 309–379)

```
async fn closed_gate_request_is_skipped_and_following_requests_continue()
```

**Purpose**: This test proves that a request whose connection gate is already closed does not stop the rest of the queue. Bad or obsolete work is skipped, and later valid work still runs.

**Data flow**: The test enqueues three same-key requests. The first runs and waits, the second belongs to a closed gate, and the third belongs to a live gate. After releasing the first request, the test expects the second request not to send anything and the third request to send its value.

**Call relations**: It uses `QueuedInitializedRequest::new` to attach different gates to queued requests. It checks the interaction between queue draining and the gate behavior that can skip closed-connection work.

*Call graph*: calls 1 internal fn (new); 9 external calls (clone, new, Global, default, gate, queue_drain_timeout, assert_eq!, unbounded_channel, timeout).


##### `tests::shutdown_of_live_gate_skips_already_queued_requests`  (lines 382–444)

```
async fn shutdown_of_live_gate_skips_already_queued_requests()
```

**Purpose**: This test proves that if a connection begins shutting down while one request is running, later queued requests for that same gate are skipped. Shutdown waits for the currently running request but does not start new ones afterward.

**Data flow**: The test enqueues two same-key requests on one live gate. The first starts and blocks. While it is still running, the test starts gate shutdown and confirms shutdown has to wait. After the first request is released, the test expects no second value, showing the queued request was skipped.

**Call relations**: It combines `QueuedInitializedRequest::new`, `RequestSerializationQueues::enqueue`, and `shutdown_wait_timeout`. It verifies the queue cooperates with `ConnectionRpcGate` shutdown rules.

*Call graph*: calls 1 internal fn (new); 9 external calls (clone, Global, default, gate, shutdown_wait_timeout, assert_eq!, unbounded_channel, spawn, timeout).


##### `tests::same_key_shared_reads_run_concurrently`  (lines 447–505)

```
async fn same_key_shared_reads_run_concurrently()
```

**Purpose**: This test proves that consecutive shared-read requests for the same key can run at the same time once earlier exclusive work is finished. This is the main performance benefit of the shared-read mode.

**Data flow**: The test first enqueues an exclusive blocker. Behind it, it enqueues two shared-read requests that each report when they start and then wait for release. After the blocker is released, both read requests should report that they started without waiting for each other to finish.

**Call relations**: It uses queue enqueueing and fake gated requests to exercise the shared-read batching done by `RequestSerializationQueues::drain`. The timeout and channel checks confirm both reads enter the same batch.

*Call graph*: calls 1 internal fn (new); 8 external calls (new, Global, default, gate, queue_drain_timeout, assert_eq!, unbounded_channel, timeout).


##### `tests::exclusive_write_waits_for_running_shared_reads`  (lines 508–582)

```
async fn exclusive_write_waits_for_running_shared_reads()
```

**Purpose**: This test proves that an exclusive request waits until currently running shared reads are finished. A write-like operation must not start while read-like operations are still using the same resource.

**Data flow**: The test queues an exclusive blocker, then two shared reads, then an exclusive request. After releasing the blocker, the shared reads start and stay running. The test checks that the exclusive request does not start until both reads are released.

**Call relations**: It builds the exact read-then-write queue shape that `RequestSerializationQueues::drain` must handle. The short shutdown-style timeout is used to prove the exclusive request is still waiting at the proper point.

*Call graph*: calls 1 internal fn (new); 8 external calls (pin, Global, default, gate, queue_drain_timeout, shutdown_wait_timeout, unbounded_channel, timeout).


##### `tests::later_shared_reads_do_not_jump_ahead_of_queued_write`  (lines 585–681)

```
async fn later_shared_reads_do_not_jump_ahead_of_queued_write()
```

**Purpose**: This test proves the queue is fair to an already waiting exclusive request. A later shared read is not allowed to sneak ahead just because reads can sometimes run together.

**Data flow**: The test queues an exclusive blocker, a shared read, an exclusive request, and then another shared read. After the blocker is released, the first read starts. The write waits for that read, and the later read waits behind the write. Only after the write finishes may the later read start.

**Call relations**: It stresses the ordering rule inside `RequestSerializationQueues::drain`: only consecutive shared reads at the front are grouped. The test confirms that once an exclusive request is next in line, later shared reads stay behind it.

*Call graph*: calls 1 internal fn (new); 7 external calls (pin, Global, default, gate, queue_drain_timeout, shutdown_wait_timeout, timeout).


### `core/src/tools/parallel.rs`

`orchestration` · `tool execution during a conversation turn`

A tool call is work the system asks another component to do, such as running a shell command or calling a custom tool. This file provides `ToolCallRuntime`, the small runtime that sits between the conversation code and the tool router. Its job is like a traffic controller: let safe tool calls proceed in parallel, make exclusive tools wait their turn, and produce one clear answer for each call.

The runtime keeps shared references to the tool router, the current session, the current turn, and a turn-diff tracker, which records changes made during the turn. It uses a read/write lock: tools that support parallel execution take a shared read lock, while tools that must run alone take an exclusive write lock. That prevents unsafe overlap without blocking tools that are declared safe to run together.

Cancellation is the most delicate part. If the user cancels while a tool is running, the runtime checks whether the tool already reached a final outcome. If it did, the completed result is preserved. If not, the runtime either aborts the task immediately or waits for the tool to clean itself up, depending on what the tool says it needs. It then returns an “aborted by user” result and notifies lifecycle hooks so extensions see the right final state.

The tests in this file guard two important promises: late cancellation must not turn a completed tool into an aborted one, and cleanup-aware cancellation must emit only the aborted lifecycle outcome.

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

**Purpose**: Builds a `ToolCallRuntime` from the shared pieces needed to run tools: the router, session, turn context, and change tracker. It also creates the internal lock used to coordinate parallel and exclusive tool execution.

**Data flow**: It receives already-created shared objects for routing, session state, turn state, and turn changes. It stores them in a new runtime object and adds a fresh read/write lock, which starts unlocked. The result is a ready-to-use runtime that can dispatch tool calls.

**Call relations**: This is called when larger flows prepare to run tools, such as turn workers, sampling requests, and the tests in this file. After construction, callers use the runtime to create diff consumers or to execute tool calls.

*Call graph*: called by 6 (test_tool_runtime, run_sampling_request, handle_output_item_done_returns_contributed_last_agent_message, start_turn_worker, cancellation_after_handler_finishes_preserves_completed_lifecycle, cancellation_waiting_for_runtime_cleanup_emits_only_aborted_lifecycle); 2 external calls (new, new).


##### `ToolCallRuntime::create_diff_consumer`  (lines 55–60)

```
fn create_diff_consumer(
        &self,
        tool_name: &codex_tools::ToolName,
    ) -> Option<Box<dyn ToolArgumentDiffConsumer>>
```

**Purpose**: Asks the tool router whether a tool has a helper that can consume partial argument changes. This is useful when tool arguments arrive gradually and the system wants to track or display the changing input.

**Data flow**: It takes a tool name, passes that name to the router, and returns either a boxed consumer object or nothing if the tool does not provide one. It does not change the runtime itself.

**Call relations**: Sampling code calls this while trying to run a sampling request. The runtime does not create the consumer directly; it delegates that decision to the router because the router knows the registered tools.

*Call graph*: called by 1 (try_run_sampling_request).


##### `ToolCallRuntime::handle_tool_call`  (lines 63–79)

```
fn handle_tool_call(
        self,
        call: ToolCall,
        cancellation_token: CancellationToken,
    ) -> impl std::future::Future<Output = Result<ResponseInputItem, CodexErr>>
```

**Purpose**: Runs a normal, direct tool call and converts the internal tool result into the response format expected by the protocol. It also turns recoverable tool errors into failure responses instead of crashing the whole request.

**Data flow**: It receives a tool call and a cancellation token, then calls the lower-level source-aware runner with the source marked as direct. If the call succeeds, it converts the tool result into a protocol response. If the tool reports a fatal error, it returns a fatal protocol error. For other tool errors, it creates a normal response whose output says the call failed.

**Call relations**: This is the public path for ordinary tool execution. It hands the real dispatch work to `ToolCallRuntime::handle_tool_call_with_source`, and uses `ToolCallRuntime::failure_response` only when the lower-level runner reports a non-fatal failure.

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

**Purpose**: Runs a tool call with full coordination: parallel-or-exclusive locking, dispatch through the router, tracing, cancellation, abort reporting, and cleanup behavior. This is the core of the file.

**Data flow**: It receives a tool call, a source label, and a cancellation token. It asks the router whether the tool supports parallel execution and whether it needs time to react to runtime cancellation. It then spawns the actual tool dispatch in a task. While that task runs, it waits for either the task result or cancellation. On success, it returns the tool result. On cancellation, it either waits for cleanup or aborts the task, then returns a synthetic aborted result and sends an aborted lifecycle notification.

**Call relations**: `ToolCallRuntime::handle_tool_call` uses this for direct calls, and nested tool execution uses it when one tool calls another. Inside, it hands actual tool execution to the router, uses `ToolCallRuntime::tool_task_join_error` if the spawned task fails unexpectedly, and uses `ToolCallRuntime::aborted_response` plus `notify_tool_aborted` when cancellation wins.

*Call graph*: called by 2 (call_nested_tool, handle_tool_call); 13 external calls (new, clone, new, new, clone, Left, Right, now, clone, clone (+3 more)).


##### `ToolCallRuntime::tool_task_join_error`  (lines 182–184)

```
fn tool_task_join_error(err: JoinError) -> FunctionCallError
```

**Purpose**: Converts an unexpected failure of the spawned tool task into a fatal tool error. This gives callers one consistent error type when the background task itself cannot be joined.

**Data flow**: It receives Tokio's join error, which means the spawned async task failed to return normally. It formats that error into a readable message and wraps it as a fatal function-call error. The output is an error value for the surrounding tool runtime.

**Call relations**: `ToolCallRuntime::handle_tool_call_with_source` calls this whenever awaiting the spawned tool task fails in a way that is not the expected cancellation path.

*Call graph*: 2 external calls (format!, Fatal).


##### `ToolCallRuntime::failure_response`  (lines 186–211)

```
fn failure_response(call: ToolCall, err: FunctionCallError) -> ResponseInputItem
```

**Purpose**: Builds a protocol response for a tool call that failed without being fatal. This lets the model or caller see that the tool call completed with an error message rather than losing the call entirely.

**Data flow**: It receives the original tool call and the error. It turns the error into text and chooses the right response shape based on the tool payload type: search tools get an empty search result, custom tools get custom output, and normal function tools get function output. The response marks ordinary output as unsuccessful where that format supports it.

**Call relations**: `ToolCallRuntime::handle_tool_call` calls this after `ToolCallRuntime::handle_tool_call_with_source` returns a non-fatal error. It is the bridge from internal error values to the external response format.

*Call graph*: 3 external calls (new, Text, to_string).


##### `ToolCallRuntime::aborted_response`  (lines 213–222)

```
fn aborted_response(call: &ToolCall, secs: f32) -> AnyToolResult
```

**Purpose**: Creates an internal tool result that says the user aborted the tool. This result can then flow through the same response machinery as other tool results.

**Data flow**: It receives the original tool call and the number of seconds the tool ran before aborting. It copies the call id and payload, creates an aborted output message, and returns an `AnyToolResult` with no extra post-tool payload.

**Call relations**: `ToolCallRuntime::handle_tool_call_with_source` calls this after cancellation wins and the tool task has either stopped or finished cleanup. It relies on `ToolCallRuntime::abort_message` to produce the human-readable message.

*Call graph*: 2 external calls (new, abort_message).


##### `ToolCallRuntime::abort_message`  (lines 224–235)

```
fn abort_message(call: &ToolCall, secs: f32) -> String
```

**Purpose**: Creates the text shown when a tool is aborted by the user. It gives shell-like tools a special wall-time format and uses a shorter general format for other tools.

**Data flow**: It reads the tool name and the elapsed seconds. If the tool is a built-in shell-style tool, it returns text like a command-line timeout report. Otherwise, it returns a plain message saying the user aborted after a certain number of seconds.

**Call relations**: `ToolCallRuntime::aborted_response` calls this when building the aborted tool result. The special formatting matters because command execution output is often read like terminal output.

*Call graph*: 2 external calls (format!, matches!).


##### `tests::ImmediateHandler::tool_name`  (lines 261–263)

```
fn tool_name(&self) -> codex_tools::ToolName
```

**Purpose**: Returns the name of the simple test tool that finishes immediately. Test code uses this to register and identify the fake tool.

**Data flow**: It reads the stored tool name from the test handler, clones it, and returns the clone. Nothing else changes.

**Call relations**: The tool registry calls this through the `ToolExecutor` trait while setting up or dispatching the test tool. It supports the test that checks cancellation after a tool has already completed.

*Call graph*: 1 external calls (clone).


##### `tests::ImmediateHandler::spec`  (lines 265–274)

```
fn spec(&self) -> codex_tools::ToolSpec
```

**Purpose**: Describes the immediate test tool to the registry. The description says it is a function-style tool with default input schema and no special output schema.

**Data flow**: It reads the stored tool name and builds a tool specification object around it. The result is metadata, not an executed tool call.

**Call relations**: The registry uses this through the tool executor interface when the fake tool is registered for tests. It allows the runtime to treat the fake tool like a real registered tool.

*Call graph*: 2 external calls (default, Function).


##### `tests::ImmediateHandler::handle`  (lines 276–283)

```
fn handle(&self, _invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Implements the immediate test tool's actual work: it instantly returns successful text output saying `ok`. This gives tests a tool that finishes before cancellation is triggered.

**Data flow**: It ignores the invocation details, creates a successful function-tool output containing the text `ok`, boxes it as a generic tool output, and returns it from an async future.

**Call relations**: The router calls this through the tool execution trait during the completed-lifecycle test. That test then delays lifecycle finishing and cancels afterward to confirm the runtime preserves the completed result.

*Call graph*: calls 1 internal fn (from_text); 2 external calls (new, pin).


##### `tests::CancellationCleanupHandler::tool_name`  (lines 296–298)

```
fn tool_name(&self) -> codex_tools::ToolName
```

**Purpose**: Returns the name of the cleanup-aware test tool. This lets the registry identify the fake tool used in cancellation cleanup tests.

**Data flow**: It reads the stored tool name, clones it, and returns the clone. It does not touch the cancellation test state.

**Call relations**: The tool registry calls this through the executor trait while preparing the cleanup-aware fake tool. That fake tool is used to test runtime cancellation behavior.

*Call graph*: 1 external calls (clone).


##### `tests::CancellationCleanupHandler::spec`  (lines 300–309)

```
fn spec(&self) -> codex_tools::ToolSpec
```

**Purpose**: Describes the cleanup-aware test tool to the registry. It declares a simple function-style test tool with default schema information.

**Data flow**: It reads the stored name and builds a function tool specification. The output is registration metadata for the test tool.

**Call relations**: The registry uses this when the cleanup tool is added to the test router. It makes the fake cleanup tool look like a normal tool to the runtime.

*Call graph*: 2 external calls (default, Function).


##### `tests::CancellationCleanupHandler::handle`  (lines 311–313)

```
fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Starts the cleanup-aware test tool's asynchronous work. It wraps `handle_call`, which contains the actual wait-for-cancellation and cleanup behavior.

**Data flow**: It receives a tool invocation, passes it to `tests::CancellationCleanupHandler::handle_call`, and returns the resulting pinned future. The work itself happens later when the future is awaited.

**Call relations**: The router calls this through the executor trait during the cancellation cleanup test. It immediately hands off to `tests::CancellationCleanupHandler::handle_call` so the test can coordinate startup, cancellation, and cleanup.

*Call graph*: calls 1 internal fn (handle_call); 1 external calls (pin).


##### `tests::CancellationCleanupHandler::handle_call`  (lines 317–343)

```
async fn handle_call(
            &self,
            invocation: ToolInvocation,
        ) -> Result<Box<dyn crate::tools::context::ToolOutput>, FunctionCallError>
```

**Purpose**: Simulates a tool that notices cancellation, performs cleanup, and only then returns. This is used to prove the runtime can wait for tools that need cleanup time.

**Data flow**: It receives the tool invocation, signals the test that the handler has started, then waits until the invocation's cancellation token is cancelled. After cancellation, it signals that cleanup has started, waits until the test allows cleanup to finish, and returns a text output saying cleanup completed with an unsuccessful result.

**Call relations**: `tests::CancellationCleanupHandler::handle` calls this when the router executes the fake tool. The cancellation cleanup test uses its signals to cancel at the right moment and verify that the runtime reports an aborted outcome instead of a completed cleanup result.

*Call graph*: calls 1 internal fn (from_text); called by 1 (handle); 1 external calls (new).


##### `tests::CancellationCleanupHandler::waits_for_runtime_cancellation`  (lines 347–349)

```
fn waits_for_runtime_cancellation(&self) -> bool
```

**Purpose**: Tells the runtime that this test tool wants to receive cancellation and clean itself up instead of being force-aborted immediately. This models tools that own resources and need orderly shutdown.

**Data flow**: It takes no outside data beyond the handler itself and returns `true`. That single value changes how the runtime treats cancellation for this tool.

**Call relations**: `ToolCallRuntime::handle_tool_call_with_source` consults this behavior through the router before deciding whether to abort the task or wait for cleanup. The cleanup test depends on this returning true.


##### `tests::FinishRecorder::on_tool_finish`  (lines 357–369)

```
fn on_tool_finish(
            &'a self,
            input: codex_extension_api::ToolFinishInput<'a>,
        ) -> codex_extension_api::ToolLifecycleFuture<'a>
```

**Purpose**: Records each tool finish outcome during tests. It gives the tests a simple way to inspect whether the runtime reported `Completed` or `Aborted` to lifecycle listeners.

**Data flow**: It receives lifecycle finish input, copies out the outcome, and returns an async future. When run, that future locks the shared record list and appends the outcome.

**Call relations**: The extension lifecycle system calls this after a tool finishes. The cancellation cleanup test later reads the shared records to confirm that only an aborted outcome was reported.

*Call graph*: 2 external calls (clone, pin).


##### `tests::BlockingFinishContributor::on_tool_finish`  (lines 379–401)

```
fn on_tool_finish(
            &'a self,
            input: codex_extension_api::ToolFinishInput<'a>,
        ) -> codex_extension_api::ToolLifecycleFuture<'a>
```

**Purpose**: Simulates a lifecycle listener that starts processing a completed tool result but pauses before recording it. This lets a test cancel during that small window and verify the completed outcome is still preserved.

**Data flow**: It receives the finish input, copies the outcome, signals the test that finish handling has started, waits until the test allows it to continue, and then appends the outcome to the shared record list.

**Call relations**: The completed-lifecycle test installs this contributor. The runtime finishes the immediate tool, this contributor blocks, the test cancels the token, and then the contributor is released so the test can verify the result remains completed.

*Call graph*: 2 external calls (clone, pin).


##### `tests::cancellation_after_handler_finishes_preserves_completed_lifecycle`  (lines 405–472)

```
async fn cancellation_after_handler_finishes_preserves_completed_lifecycle() -> anyhow::Result<()>
```

**Purpose**: Checks that cancelling after a tool has already produced its result does not rewrite history as an abort. This protects users and extensions from seeing a completed tool incorrectly reported as cancelled.

**Data flow**: The test builds a session, installs a blocking lifecycle contributor, registers an immediate fake tool, and starts a tool call. Once lifecycle finish handling has begun, it cancels the token, releases the blocked lifecycle contributor, and waits for the response. It then checks that the response is the successful `ok` output and that the recorded lifecycle outcome is completed.

**Call relations**: This test constructs a `ToolCallRuntime` with `ToolCallRuntime::new` and runs `ToolCallRuntime::handle_tool_call`. It uses `tests::ImmediateHandler` for the tool behavior and `tests::BlockingFinishContributor` to create the race-like timing it wants to verify.

*Call graph*: calls 6 internal fn (make_session_and_context, new, from_tools, from_parts, new, plain); 16 external calls (clone, new, new, from_millis, from_secs, new, new, assert_eq!, new, channel (+6 more)).


##### `tests::cancellation_waiting_for_runtime_cleanup_emits_only_aborted_lifecycle`  (lines 475–543)

```
async fn cancellation_waiting_for_runtime_cleanup_emits_only_aborted_lifecycle() -> anyhow::Result<()>
```

**Purpose**: Checks that a cleanup-aware tool, when cancelled, is reported as aborted and not also as completed. This protects lifecycle consumers from receiving contradictory finish events.

**Data flow**: The test builds a session, installs a finish recorder, registers the cleanup-aware fake tool, and starts a tool call. It waits until the tool starts, cancels the token, waits until cleanup begins, then allows cleanup to finish. Finally, it checks that the response text says the tool was aborted and that the only recorded lifecycle outcome is aborted.

**Call relations**: This test creates the runtime with `ToolCallRuntime::new` and executes through `ToolCallRuntime::handle_tool_call`. It relies on `tests::CancellationCleanupHandler::waits_for_runtime_cancellation` and `tests::CancellationCleanupHandler::handle_call` to exercise the runtime path that waits for cleanup before returning an aborted response.

*Call graph*: calls 6 internal fn (make_session_and_context, new, from_tools, from_parts, new, plain); 17 external calls (clone, new, new, from_millis, from_secs, new, new, bail!, assert!, assert_eq! (+7 more)).

## 📊 State Registers Touched

- `reg-effective-config` — The final set of settings Codex runs with after combining files, policies, profiles, cloud settings, thread overrides, and command-line flags.
- `reg-feature-flags` — The shared list of enabled or disabled experimental and product features that changes what the app exposes.
- `reg-auth-identity` — The signed-in user or service identity, including account facts such as email, plan, workspace, and login mode.
- `reg-model-provider-catalog` — The combined menu of usable model providers and models from bundled data, cache, live services, local servers, and account access.
- `reg-app-server-runtime` — The live app-server or daemon state, including open transports, connected clients, request routing, and server lifecycle status.
- `reg-remote-control-relay` — The remote-control, relay, socket, WebSocket, and encrypted connection state used to connect clients and helper processes.
- `reg-permission-sandbox-policy` — The shared rules for file access, command execution, network access, approvals, and sandbox modes.
- `reg-exec-environment` — The active command-execution setup, including local or remote executor choice, sandbox helper paths, runtime paths, and process execution capabilities.
- `reg-process-registry` — The shared record of running or tracked external processes, their identifiers, input/output streams, terminal sizes, and completion state.
- `reg-mcp-server-sessions` — The configured and connected MCP tool servers, their tools, resources, login state, approval rules, and active sessions.
- `reg-live-session-services` — The toolbox attached to one running session, such as model access, auth, telemetry, approvals, tools, extensions, networking, and MCP connections.
- `reg-thread-session-state` — The live state of a conversation thread, including its identity, workspace, selected model, history, permissions, listeners, and lifecycle status.
- `reg-turn-state` — The shared clipboard for one active assistant turn, tracking the current task, pending replies, granted permissions, cancellations, and bookkeeping.
- `reg-hook-rules` — The configured hooks and hook schemas that let external commands inspect or affect session starts, turns, tool calls, and other lifecycle events.
- `reg-background-work-queues` — The shared set of background tasks such as cloud refreshes, cleanup jobs, memory jobs, skill watchers, agent jobs, update checks, and session maintenance.
- `reg-tui-visible-state` — The current terminal user-interface state, including visible transcript cells, inputs, popups, keymaps, headers, status lines, notifications, and restored history.
- `reg-observability-telemetry` — The shared logs, traces, metrics, analytics facts, rollout tracing, debug captures, and feedback evidence used to understand what happened.
- `reg-realtime-stream-state` — Active realtime conversation state, including audio/text stream sessions, WebSocket transport state, buffers, and stop/cancel lifecycle data.
- `reg-request-serialization-gates` — The in-flight RPC/session request admission gates, per-resource serialization queues, and shutdown blockers that control when handlers may start or must drain.
- `reg-filesystem-watch-subscriptions` — Active file and directory watch subscriptions, invalidation signals, and watcher-to-client mappings used for skills, plugin/config refreshes, and app-server file APIs.
- `reg-terminal-runtime-state` — Live terminal control state such as raw mode, alternate screen ownership, resize/suspend handling, input streams, and restoration obligations.
- `reg-workspace-change-set` — Live and saved workspace change information, including file diffs, patch outcomes, reviewable changes, and rollback/snapshot data used by tools, UI, and persistence.
- `reg-outgoing-transport-buffers` — Queued outbound protocol messages, write buffers, and backpressure state for app-server, daemon, exec-server, and remote transports.
