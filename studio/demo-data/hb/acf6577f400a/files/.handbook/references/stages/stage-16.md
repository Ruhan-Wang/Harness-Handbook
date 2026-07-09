# Result persistence, projection, and user-visible state updates  `stage-16`

This stage is the system’s “make it real and show it” step. After the assistant, a tool, or an imported session produces progress, these files decide what should be saved, what should be shown, and what status other parts of the app should see. Rollout and thread-store code saves useful events, rebuilds old sessions, imports external chats, archives or restores threads, and keeps fast database summaries in sync with older transcript files. State and summary code turns raw event logs into searchable thread details like title, preview, model, folder, Git state, and token use.

Event-mapping code translates detailed core activity into simpler messages for app clients, exec JSONL output, and terminal displays. Tool, shell-command, diff, review, agent-status, and lifecycle code turn work into clear records: commands started or ended, files changed, approvals waited on, or agents finished. The TUI files then project that state into visible transcript cells, status lines, headers, pending-input previews, rate-limit warnings, goal indicators, and restored history. Together, they turn internal activity into durable records and understandable user-facing state.

## Files in this stage

### App-server event projection
These files translate core execution events into app-server notifications, thread history projections, replayed usage updates, and externally visible thread status.

### `app-server/src/bespoke_event_handling.rs`

`orchestration` · `main loop / event handling`

Think of this file as the control desk between the engine room and the user interface. Codex core emits many kinds of events: a turn starts, a command asks for approval, a tool needs user input, token usage changes, a rollback finishes, or an error occurs. Most clients should not need to understand core’s internal event shapes, so this file converts them into the app-server protocol that clients receive.

The main function, apply_bespoke_event_handling, matches each incoming event and decides what to do. Some events become simple notifications, like “turn started” or “token usage updated.” Some events require a round trip to the client, such as asking whether a command may run or whether a file change is allowed. For those, this file sends a request, waits asynchronously for the client’s answer, and submits the decision back to the Codex thread.

It also keeps small pieces of per-turn state, such as whether an error happened or whether a command item has already been announced, so clients do not see duplicate or misleading updates. Without this file, the UI would miss important live updates, approvals would not get back to core, and turns could end with the wrong status.

#### Function details

##### `apply_bespoke_event_handling`  (lines 137–1277)

```
async fn apply_bespoke_event_handling(
    event: Event,
    conversation_id: ThreadId,
    conversation: Arc<CodexThread>,
    thread_manager: Arc<ThreadManager>,
    outgoing: ThreadScopedOutgoingMe
```

**Purpose**: This is the central dispatcher for one core event. It decides whether to notify the client, ask the client for a decision, update thread-watch state, or submit a response back into the running Codex thread.

**Data flow**: It receives a core event plus the thread, outgoing message sender, shared thread state, thread manager, and fallback configuration. It inspects the event kind, builds the matching app-server notification or request, updates shared state when needed, and either sends messages to clients or starts background tasks that wait for client replies. The visible result is that clients see live thread updates and Codex core receives any decisions or answers it needs.

**Call relations**: This function is called by tests and by the surrounding event loop in production. It hands specialized work to helpers such as handle_turn_complete, handle_error_notification, handle_token_count_event, start_command_execution_item, and the response-waiting functions when an event needs more than a direct notification.

*Call graph*: calls 38 internal fn (complete_command_execution_item, handle_error_notification, handle_thread_rollback_failed, handle_token_count_event, handle_turn_complete, handle_turn_diff, handle_turn_interrupted, handle_turn_plan_update, maybe_emit_hook_prompt_item_completed, maybe_emit_raw_response_item_completed (+15 more)); called by 3 (apply_guardian_assessment_event, interrupted_subagent_activity_removes_missing_thread_watch, turn_started_omits_active_snapshot_items); 46 external calls (DeprecationNotice, Error, GuardianWarning, HookCompleted, HookStarted, ItemCompleted, ItemStarted, McpServerStatusUpdated, ModelRerouted, ModelVerification (+15 more)).


##### `handle_turn_diff`  (lines 1279–1293)

```
async fn handle_turn_diff(
    conversation_id: ThreadId,
    event_turn_id: &str,
    turn_diff_event: TurnDiffEvent,
    outgoing: &ThreadScopedOutgoingMessageSender,
)
```

**Purpose**: This sends clients the current text diff for a turn. A diff is a compact view of what changed in files, similar to what a code review shows.

**Data flow**: It takes the thread id, turn id, and core diff text. It wraps that text in a client-facing TurnDiffUpdated notification and sends it out. It does not change stored state.

**Call relations**: apply_bespoke_event_handling calls this when core reports a TurnDiff event. A test calls it directly to confirm the v2 notification shape.

*Call graph*: calls 1 internal fn (send_server_notification); called by 2 (apply_bespoke_event_handling, test_handle_turn_diff_emits_v2_notification); 2 external calls (TurnDiffUpdated, to_string).


##### `handle_turn_plan_update`  (lines 1295–1315)

```
async fn handle_turn_plan_update(
    conversation_id: ThreadId,
    event_turn_id: &str,
    plan_update_event: UpdatePlanArgs,
    outgoing: &ThreadScopedOutgoingMessageSender,
)
```

**Purpose**: This tells clients that the assistant’s checklist or todo plan changed. It is for the update_plan tool, not for a separate planning mode.

**Data flow**: It receives the core plan update, converts each plan step into the app-server format, keeps any explanation text, and sends a TurnPlanUpdated notification. The output is a client-visible checklist update.

**Call relations**: apply_bespoke_event_handling calls it for PlanUpdate events. The related test verifies that plan steps and statuses are translated correctly.

*Call graph*: calls 1 internal fn (send_server_notification); called by 2 (apply_bespoke_event_handling, test_handle_turn_plan_update_emits_notification_for_v2); 2 external calls (TurnPlanUpdated, to_string).


##### `emit_turn_completed_with_status`  (lines 1325–1347)

```
async fn emit_turn_completed_with_status(
    conversation_id: ThreadId,
    event_turn_id: String,
    turn_completion_metadata: TurnCompletionMetadata,
    outgoing: &ThreadScopedOutgoingMessageSend
```

**Purpose**: This sends the final “turn completed” message with the chosen outcome, such as completed, failed, or interrupted.

**Data flow**: It receives a thread id, turn id, completion metadata, and outgoing sender. It builds a Turn object with no loaded items, attaches status, error, and timing data, then sends a TurnCompleted notification.

**Call relations**: handle_turn_complete and handle_turn_interrupted call this after they decide the final status. It is the shared last step for ending a turn.

*Call graph*: calls 1 internal fn (send_server_notification); called by 2 (handle_turn_complete, handle_turn_interrupted); 3 external calls (TurnCompleted, to_string, vec!).


##### `start_command_execution_item`  (lines 1350–1391)

```
async fn start_command_execution_item(
    conversation_id: &ThreadId,
    turn_id: String,
    item_id: String,
    command: String,
    cwd: AbsolutePathBuf,
    command_actions: Vec<V2ParsedCommand
```

**Purpose**: This announces that a command execution item has started, but only once for the same item. This prevents duplicate command rows in the client.

**Data flow**: It receives command details, the turn and thread ids, shared thread state, and the outgoing sender. It records the item id in the turn summary; if it was not already present, it sends an ItemStarted notification with an in-progress command item. It returns whether this was the first start.

**Call relations**: apply_bespoke_event_handling uses it for command approvals and guardian assessments before a command is actually allowed or denied. Tests call it directly to prove duplicate starts are suppressed.

*Call graph*: calls 2 internal fn (now_unix_timestamp_ms, send_server_notification); called by 3 (apply_bespoke_event_handling, command_execution_started_helper_emits_once, complete_command_execution_item_emits_declined_once_for_pending_command); 2 external calls (ItemStarted, to_string).


##### `complete_command_execution_item`  (lines 1394–1438)

```
async fn complete_command_execution_item(
    conversation_id: &ThreadId,
    turn_id: String,
    item_id: String,
    command: String,
    cwd: AbsolutePathBuf,
    process_id: Option<String>,
    s
```

**Purpose**: This announces that a previously started command item has finished, failed, or was declined. It only emits a completion if the command had been marked as started.

**Data flow**: It receives command details, completion status, shared state, and the outgoing sender. It removes the command id from the set of started commands; if removal succeeds, it sends an ItemCompleted notification. If the command was not pending, it sends nothing.

**Call relations**: apply_bespoke_event_handling and on_command_execution_request_approval_response call this when a command-like approval ends negatively. Tests verify that it emits once and then clears the pending marker.

*Call graph*: calls 2 internal fn (now_unix_timestamp_ms, send_server_notification); called by 3 (apply_bespoke_event_handling, on_command_execution_request_approval_response, complete_command_execution_item_emits_declined_once_for_pending_command); 2 external calls (ItemCompleted, to_string).


##### `maybe_emit_raw_response_item_completed`  (lines 1440–1454)

```
async fn maybe_emit_raw_response_item_completed(
    conversation_id: ThreadId,
    turn_id: &str,
    item: codex_protocol::models::ResponseItem,
    outgoing: &ThreadScopedOutgoingMessageSender,
)
```

**Purpose**: This forwards a raw model response item to clients as a completed raw-response item. It preserves the lower-level model output for clients that need it.

**Data flow**: It receives a thread id, turn id, raw response item, and outgoing sender. It wraps the item in RawResponseItemCompletedNotification and sends it. No state is changed.

**Call relations**: apply_bespoke_event_handling calls it when core emits a RawResponseItem event, after first checking whether the same raw item also represents a hook prompt.

*Call graph*: calls 1 internal fn (send_server_notification); called by 1 (apply_bespoke_event_handling); 2 external calls (RawResponseItemCompleted, to_string).


##### `maybe_emit_hook_prompt_item_completed`  (lines 1456–1493)

```
async fn maybe_emit_hook_prompt_item_completed(
    conversation_id: ThreadId,
    turn_id: &str,
    item: &codex_protocol::models::ResponseItem,
    outgoing: &ThreadScopedOutgoingMessageSender,
)
```

**Purpose**: This detects when a raw response item is actually a hook prompt and emits a clearer hook-prompt item for clients. A hook prompt is generated text that asks the assistant to react to hook results.

**Data flow**: It receives a response item by reference. If the item is not a user message, or cannot be parsed as a hook prompt, it does nothing. If parsing succeeds, it converts the prompt fragments into app-server fragments and sends an ItemCompleted notification.

**Call relations**: apply_bespoke_event_handling calls it before forwarding raw response items. The hook prompt test builds a sample prompt and checks that this helper emits the expected item.

*Call graph*: calls 3 internal fn (now_unix_timestamp_ms, send_server_notification, parse_hook_prompt_message); called by 2 (apply_bespoke_event_handling, test_hook_prompt_raw_response_emits_item_completed); 2 external calls (ItemCompleted, to_string).


##### `find_and_remove_turn_summary`  (lines 1495–1501)

```
async fn find_and_remove_turn_summary(
    _conversation_id: ThreadId,
    thread_state: &Arc<Mutex<ThreadState>>,
) -> TurnSummary
```

**Purpose**: This takes the current turn summary out of shared thread state and resets that slot. The summary is scratch paper for one turn: errors, start time, and command-start markers.

**Data flow**: It locks the shared ThreadState, replaces the stored TurnSummary with a fresh empty one, and returns the old summary to the caller. The before state has accumulated turn details; the after state is ready for the next turn.

**Call relations**: handle_turn_complete and handle_turn_interrupted use this when a turn ends. Tests use it to inspect what handle_error recorded.

*Call graph*: called by 3 (handle_turn_complete, handle_turn_interrupted, test_handle_error_records_message); 1 external calls (take).


##### `handle_turn_complete`  (lines 1503–1530)

```
async fn handle_turn_complete(
    conversation_id: ThreadId,
    event_turn_id: String,
    turn_complete_event: TurnCompleteEvent,
    outgoing: &ThreadScopedOutgoingMessageSender,
    thread_state:
```

**Purpose**: This finishes a normal turn and decides whether it should be reported as completed or failed. A turn is marked failed if an earlier error was recorded in the turn summary.

**Data flow**: It removes the accumulated turn summary, checks for a stored error, combines that with completion timing from core, and asks emit_turn_completed_with_status to send the final notification. It clears per-turn summary state as part of finishing.

**Call relations**: apply_bespoke_event_handling calls it when core emits TurnComplete. Several tests call it directly to check successful, failed, and multi-turn behavior.

*Call graph*: calls 2 internal fn (emit_turn_completed_with_status, find_and_remove_turn_summary); called by 4 (apply_bespoke_event_handling, test_handle_turn_complete_emits_completed_without_error, test_handle_turn_complete_emits_error_multiple_turns, test_handle_turn_complete_emits_failed_with_error).


##### `handle_turn_interrupted`  (lines 1532–1554)

```
async fn handle_turn_interrupted(
    conversation_id: ThreadId,
    event_turn_id: String,
    turn_aborted_event: TurnAbortedEvent,
    outgoing: &ThreadScopedOutgoingMessageSender,
    thread_state
```

**Purpose**: This finishes a turn that was interrupted by the user or system. It reports the turn as interrupted rather than failed.

**Data flow**: It removes the accumulated turn summary, ignores any stored turn error for the final interrupted notification, attaches interruption timing, and sends a TurnCompleted notification with Interrupted status. The turn summary is cleared afterward.

**Call relations**: apply_bespoke_event_handling calls it for TurnAborted events. A test calls it directly to confirm interrupted turns do not surface a stored error as the final turn error.

*Call graph*: calls 2 internal fn (emit_turn_completed_with_status, find_and_remove_turn_summary); called by 2 (apply_bespoke_event_handling, test_handle_turn_interrupted_emits_interrupted_with_error).


##### `handle_thread_rollback_failed`  (lines 1556–1569)

```
async fn handle_thread_rollback_failed(
    _conversation_id: ThreadId,
    message: String,
    thread_state: &Arc<Mutex<ThreadState>>,
    outgoing: &ThreadScopedOutgoingMessageSender,
)
```

**Purpose**: This fails a pending rollback request when core reports that rollback did not work. It prevents the client request from hanging forever.

**Data flow**: It takes any pending rollback request id out of thread state. If one exists, it sends an invalid-request error response containing the failure message. If no rollback is pending, it does nothing.

**Call relations**: apply_bespoke_event_handling calls it when an Error event is specifically marked as ThreadRollbackFailed.

*Call graph*: calls 2 internal fn (invalid_request, send_error); called by 1 (apply_bespoke_event_handling).


##### `thread_rollback_response_from_stored_thread`  (lines 1571–1590)

```
fn thread_rollback_response_from_stored_thread(
    stored_thread: codex_thread_store::StoredThread,
    session_id: String,
    fallback_model_provider: &str,
    fallback_cwd: &AbsolutePathBuf,
```

**Purpose**: This rebuilds the client-facing thread object after a rollback has changed stored history. It gives the requester a fresh view of the thread.

**Data flow**: It receives a stored thread, session id, fallback model provider, fallback working directory, and current loaded status. It converts the stored thread into the app-server thread model, requires persisted history to be present, repopulates turns from that history, applies the loaded status, and returns a ThreadRollbackResponse or an error string.

**Call relations**: apply_bespoke_event_handling calls it after core says a rollback completed. The rollback test calls it directly with a pathless stored thread to make sure history reconstruction works.

*Call graph*: called by 2 (apply_bespoke_event_handling, rollback_response_rebuilds_pathless_thread_from_stored_history); 3 external calls (populate_thread_turns_from_history, thread_from_stored_thread, format!).


##### `respond_to_pending_interrupts`  (lines 1592–1606)

```
async fn respond_to_pending_interrupts(
    thread_state: &Arc<Mutex<ThreadState>>,
    outgoing: &ThreadScopedOutgoingMessageSender,
)
```

**Purpose**: This replies to any client requests that asked to interrupt a turn once the turn has actually ended or been aborted.

**Data flow**: It removes the list of pending interrupt request ids from shared state. For each id, it sends an empty TurnInterruptResponse. Afterward, no interrupt requests remain pending.

**Call relations**: apply_bespoke_event_handling calls it on TurnComplete and TurnAborted, because both mean outstanding interrupt requests can now be resolved.

*Call graph*: calls 1 internal fn (send_response); called by 1 (apply_bespoke_event_handling); 1 external calls (take).


##### `handle_token_count_event`  (lines 1608–1634)

```
async fn handle_token_count_event(
    conversation_id: ThreadId,
    turn_id: String,
    token_count_event: TokenCountEvent,
    outgoing: &ThreadScopedOutgoingMessageSender,
)
```

**Purpose**: This sends clients updated token usage and account rate-limit information. Tokens are pieces of text counted by the model, and rate limits describe usage caps.

**Data flow**: It receives token usage data and optional rate-limit data. If usage is present, it converts it into ThreadTokenUsageUpdatedNotification. If rate limits are present, it sends AccountRateLimitsUpdatedNotification. Either part may be absent.

**Call relations**: apply_bespoke_event_handling calls it for TokenCount events. Tests verify both the case with usage/rate limits and the case where nothing should be emitted.

*Call graph*: calls 1 internal fn (send_server_notification); called by 3 (apply_bespoke_event_handling, test_handle_token_count_event_emits_usage_and_rate_limits, test_handle_token_count_event_without_usage_info); 3 external calls (AccountRateLimitsUpdated, ThreadTokenUsageUpdated, to_string).


##### `handle_error`  (lines 1636–1643)

```
async fn handle_error(
    _conversation_id: ThreadId,
    error: TurnError,
    thread_state: &Arc<Mutex<ThreadState>>,
)
```

**Purpose**: This records that the current turn has hit an error. It does not notify the client by itself.

**Data flow**: It receives a TurnError and shared thread state. It locks the state and stores the error as the turn summary’s last error. Later turn completion can then mark the turn as failed.

**Call relations**: handle_error_notification calls it before sending an error notification. Tests call it directly to confirm the error is kept in the turn summary.

*Call graph*: called by 5 (handle_error_notification, test_handle_error_records_message, test_handle_turn_complete_emits_error_multiple_turns, test_handle_turn_complete_emits_failed_with_error, test_handle_turn_interrupted_emits_interrupted_with_error).


##### `handle_error_notification`  (lines 1645–1661)

```
async fn handle_error_notification(
    conversation_id: ThreadId,
    event_turn_id: &str,
    error: TurnError,
    outgoing: &ThreadScopedOutgoingMessageSender,
    thread_state: &Arc<Mutex<ThreadS
```

**Purpose**: This records an error for the turn and also tells the client about it. It is used for errors that affect the turn’s final status.

**Data flow**: It receives the thread id, turn id, error, outgoing sender, and shared state. It stores the error through handle_error, then sends an Error notification with will_retry set to false. The client sees the error and the turn summary remembers it.

**Call relations**: apply_bespoke_event_handling calls it for status-affecting core errors. on_request_permissions_response also calls it if granted filesystem paths cannot be localized safely.

*Call graph*: calls 2 internal fn (handle_error, send_server_notification); called by 2 (apply_bespoke_event_handling, on_request_permissions_response); 3 external calls (Error, clone, to_string).


##### `on_request_user_input_response`  (lines 1663–1742)

```
async fn on_request_user_input_response(
    event_turn_id: String,
    pending_request_id: RequestId,
    receiver: oneshot::Receiver<ClientRequestResult>,
    conversation: Arc<CodexThread>,
    thr
```

**Purpose**: This waits for the client’s answers to a tool’s user-input questions and sends those answers back to core. If the client fails, it sends an empty answer set so the tool can continue or stop cleanly.

**Data flow**: It receives the pending request id, a one-shot receiver for the client response, the conversation, thread state, and a guard marking user input as active. It waits for the response, clears the pending-request marker, drops the guard, deserializes answers if possible, and submits UserInputAnswer to the Codex thread.

**Call relations**: apply_bespoke_event_handling starts this in a background task after sending ToolRequestUserInput to the client. It is the return path from client UI back to core.

*Call graph*: calls 2 internal fn (is_turn_transition_server_request_error, resolve_server_request_on_thread_listener); called by 1 (apply_bespoke_event_handling); 2 external calls (new, error!).


##### `on_mcp_server_elicitation_response`  (lines 1744–1770)

```
async fn on_mcp_server_elicitation_response(
    server_name: String,
    request_id: codex_protocol::mcp::RequestId,
    pending_request_id: RequestId,
    receiver: oneshot::Receiver<ClientRequestRe
```

**Purpose**: This waits for the client’s answer to an MCP server elicitation request and submits that answer back to core. MCP is a tool-server protocol; elicitation means the server asks the user for a decision or data.

**Data flow**: It waits on the client response channel, clears pending-request state, drops the permission guard, converts the response into a safe app-server response, and submits ResolveElicitation to the Codex thread. The result is that the MCP server receives accept, decline, or cancel plus optional content.

**Call relations**: apply_bespoke_event_handling spawns it after sending McpServerElicitationRequest. It relies on mcp_server_elicitation_response_from_client_result to normalize errors and bad JSON.

*Call graph*: calls 2 internal fn (mcp_server_elicitation_response_from_client_result, resolve_server_request_on_thread_listener); called by 1 (apply_bespoke_event_handling); 1 external calls (error!).


##### `mcp_server_elicitation_response_from_client_result`  (lines 1772–1809)

```
fn mcp_server_elicitation_response_from_client_result(
    response: std::result::Result<ClientRequestResult, oneshot::error::RecvError>,
) -> McpServerElicitationRequestResponse
```

**Purpose**: This turns a raw client response for MCP elicitation into a safe, typed decision. It chooses conservative defaults when the client response is missing or malformed.

**Data flow**: It receives either a successful JSON value, a client error, or a closed response channel. Successful JSON is parsed into McpServerElicitationRequestResponse. Turn-transition errors become Cancel; other failures become Decline.

**Call relations**: on_mcp_server_elicitation_response calls it before submitting the decision to core. A test verifies that turn-transition errors map to Cancel.

*Call graph*: calls 1 internal fn (is_turn_transition_server_request_error); called by 2 (on_mcp_server_elicitation_response, mcp_server_elicitation_turn_transition_error_maps_to_cancel); 1 external calls (error!).


##### `on_request_permissions_response`  (lines 1811–1870)

```
async fn on_request_permissions_response(
    pending_response: PendingRequestPermissionsResponse,
    conversation: Arc<CodexThread>,
    thread_state: Arc<Mutex<ThreadState>>,
)
```

**Purpose**: This waits for the client’s answer to a permission request and submits the granted permissions back to core. It also handles unsafe or invalid granted paths by reporting an error and interrupting the turn.

**Data flow**: It unpacks the pending permission request, waits for the client reply, clears pending state, drops the active permission guard, converts the reply with request_permissions_response_from_client_result, records the effective approval, and submits RequestPermissionsResponse to the Codex thread. If path conversion fails, it sends an error notification and asks core to interrupt.

**Call relations**: apply_bespoke_event_handling spawns it when core asks for broader permissions. It uses handle_error_notification for serious conversion failures and request_permissions_response_from_client_result for normal parsing.

*Call graph*: calls 3 internal fn (handle_error_notification, request_permissions_response_from_client_result, resolve_server_request_on_thread_listener); called by 1 (apply_bespoke_event_handling); 2 external calls (error!, format!).


##### `request_permissions_response_from_client_result`  (lines 1884–1944)

```
fn request_permissions_response_from_client_result(
    requested_permissions: CoreRequestPermissionProfile,
    response: std::result::Result<ClientRequestResult, oneshot::error::RecvError>,
    cwd:
```

**Purpose**: This safely converts a client permission approval into the core permission format. It never grants more than core originally requested.

**Data flow**: It receives the requested permission profile, the raw client response, and the working directory used for path interpretation. Client failures become an empty turn-scoped grant, while turn-transition errors are ignored. Successful replies are parsed, validated, localized to filesystem paths, intersected with the requested permissions, and returned with scope and strict-auto-review settings.

**Call relations**: on_request_permissions_response calls it before submitting a permission decision to core. Many tests call it directly to confirm partial grants, session scope, strict auto-review rules, and path-scope safety.

*Call graph*: calls 2 internal fn (is_turn_transition_server_request_error, intersect_permission_profiles); called by 9 (on_request_permissions_response, request_permissions_response_accepts_explicit_child_grant_for_requested_cwd_scope, request_permissions_response_accepts_partial_network_and_file_system_grants, request_permissions_response_ignores_broader_cwd_grant_for_requested_child_path, request_permissions_response_preserves_session_scope, request_permissions_response_preserves_turn_scoped_strict_auto_review, request_permissions_response_rejects_child_grant_outside_requested_cwd_scope, request_permissions_response_rejects_session_scoped_strict_auto_review, request_permissions_turn_transition_error_is_ignored); 5 external calls (default, into, default, error!, matches!).


##### `render_review_output_text`  (lines 1948–1966)

```
fn render_review_output_text(output: &ReviewOutputEvent) -> String
```

**Purpose**: This turns structured review output into readable text for the client. It combines an overall explanation with formatted findings.

**Data flow**: It receives a review output event. It trims the explanation, formats any findings, drops empty sections, and joins the remaining sections with blank lines. If nothing useful exists, it returns a fallback message.

**Call relations**: apply_bespoke_event_handling calls it when emitting an ExitedReviewMode item.

*Call graph*: calls 1 internal fn (format_review_findings_block); called by 1 (apply_bespoke_event_handling); 1 external calls (new).


##### `map_file_change_approval_decision`  (lines 1968–1975)

```
fn map_file_change_approval_decision(decision: FileChangeApprovalDecision) -> ReviewDecision
```

**Purpose**: This translates a client-facing file-change approval choice into the core review decision type. It keeps the same meaning across two protocol layers.

**Data flow**: It receives a FileChangeApprovalDecision such as accept, accept for session, decline, or cancel. It returns the matching core ReviewDecision: approved, approved for session, denied, or abort.

**Call relations**: on_file_change_request_approval_response uses it before submitting PatchApproval to core. A test checks the accept-for-session mapping.

*Call graph*: called by 2 (on_file_change_request_approval_response, file_change_accept_for_session_maps_to_approved_for_session).


##### `on_file_change_request_approval_response`  (lines 1978–2021)

```
async fn on_file_change_request_approval_response(
    item_id: String,
    pending_request_id: RequestId,
    receiver: oneshot::Receiver<ClientRequestResult>,
    codex: Arc<CodexThread>,
    thread
```

**Purpose**: This waits for the client’s decision about a proposed file change and sends that decision back to core.

**Data flow**: It waits for the client response, clears the pending-request marker, drops the permission guard, parses the file-change approval response, maps it to a core review decision, and submits PatchApproval with the item id. Failures default to denial, except turn-transition errors are ignored.

**Call relations**: apply_bespoke_event_handling spawns it after sending FileChangeRequestApproval. It uses map_file_change_approval_decision for the protocol translation.

*Call graph*: calls 3 internal fn (map_file_change_approval_decision, is_turn_transition_server_request_error, resolve_server_request_on_thread_listener); called by 1 (apply_bespoke_event_handling); 1 external calls (error!).


##### `on_command_execution_request_approval_response`  (lines 2024–2146)

```
async fn on_command_execution_request_approval_response(
    event_turn_id: String,
    conversation_id: ThreadId,
    approval_id: Option<String>,
    item_id: String,
    completion_item: Option<Com
```

**Purpose**: This waits for the client’s decision about running a command or changing network/exec policy, then submits the decision back to core. It can also close a visible command item if the command was declined or failed before running.

**Data flow**: It waits for the approval response, clears pending state, drops the permission guard, parses the decision, translates it into a core ReviewDecision, and determines whether a command item should be completed with declined or failed status. Finally it submits ExecApproval to the Codex thread.

**Call relations**: apply_bespoke_event_handling spawns it after sending CommandExecutionRequestApproval. It calls complete_command_execution_item when a visible pending command needs to be ended.

*Call graph*: calls 3 internal fn (complete_command_execution_item, is_turn_transition_server_request_error, resolve_server_request_on_thread_listener); called by 1 (apply_bespoke_event_handling); 1 external calls (error!).


##### `now_unix_timestamp_ms`  (lines 2148–2153)

```
fn now_unix_timestamp_ms() -> i64
```

**Purpose**: This returns the current time as milliseconds since the Unix epoch, which is a common timestamp starting point: midnight UTC on January 1, 1970.

**Data flow**: It reads the system clock, converts the duration since the Unix epoch into milliseconds, and returns that number. If the clock is somehow before the epoch, it returns zero.

**Call relations**: Event helpers use it when they need a started_at or completed_at timestamp for synthetic item notifications.

*Call graph*: called by 4 (apply_bespoke_event_handling, complete_command_execution_item, maybe_emit_hook_prompt_item_completed, start_command_execution_item); 1 external calls (now).


##### `tests::new_thread_state`  (lines 2210–2212)

```
fn new_thread_state() -> Arc<Mutex<ThreadState>>
```

**Purpose**: This test helper creates a fresh shared ThreadState. It gives each test a clean piece of mutable thread state.

**Data flow**: It constructs a default ThreadState, wraps it in a Mutex so async code can lock it safely, then wraps that in Arc so multiple tasks can share it. The result is ready for tests to pass into handlers.

**Call relations**: Many tests use it before calling handlers that expect shared thread state.

*Call graph*: 3 external calls (new, new, default).


##### `tests::recv_broadcast_message`  (lines 2217–2228)

```
async fn recv_broadcast_message(
        rx: &mut mpsc::Receiver<OutgoingEnvelope>,
    ) -> Result<OutgoingMessage>
```

**Purpose**: This test helper receives one outgoing message from a channel and unwraps it from its envelope. It lets tests inspect what the server would send to clients.

**Data flow**: It waits for the next OutgoingEnvelope from a test channel. Whether the envelope is broadcast or connection-specific, it extracts and returns the contained OutgoingMessage. If no message arrives, it returns an error.

**Call relations**: Notification-focused tests call it after invoking a handler to check the emitted message.

*Call graph*: calls 1 internal fn (recv).


##### `tests::rollback_response_rebuilds_pathless_thread_from_stored_history`  (lines 2231–2299)

```
fn rollback_response_rebuilds_pathless_thread_from_stored_history() -> Result<()>
```

**Purpose**: This test proves rollback response construction can rebuild a thread from stored history even when the stored thread has no rollout path.

**Data flow**: It builds a fake stored thread with user and agent history, calls thread_rollback_response_from_stored_thread, and checks that the returned thread has expected metadata, status, and populated turn items.

**Call relations**: It directly exercises thread_rollback_response_from_stored_thread, covering the helper used after a real rollback completes.

*Call graph*: calls 3 internal fn (thread_rollback_response_from_stored_thread, read_only, from_string); 4 external calls (now, assert_eq!, test_path_buf, vec!).


##### `tests::turn_complete_event`  (lines 2301–2309)

```
fn turn_complete_event(turn_id: &str) -> TurnCompleteEvent
```

**Purpose**: This test helper builds a standard TurnCompleteEvent with fixed timing. Fixed values make assertions simple and repeatable.

**Data flow**: It receives a turn id and returns a TurnCompleteEvent with that id plus predefined completed_at and duration values. It does not touch shared state.

**Call relations**: Several turn-completion tests use it when calling handle_turn_complete.


##### `tests::turn_aborted_event`  (lines 2311–2318)

```
fn turn_aborted_event(turn_id: &str) -> TurnAbortedEvent
```

**Purpose**: This test helper builds a standard interrupted TurnAbortedEvent. It keeps interruption tests focused on handler behavior rather than event setup.

**Data flow**: It receives a turn id and returns a TurnAbortedEvent with an Interrupted reason and fixed completion timing. The output is passed into handle_turn_interrupted.

**Call relations**: The interrupted-turn test uses it to simulate core reporting an aborted turn.


##### `tests::command_execution_completion_item`  (lines 2320–2328)

```
fn command_execution_completion_item(command: &str) -> CommandExecutionCompletionItem
```

**Purpose**: This test helper builds command details used by command-start and command-completion tests.

**Data flow**: It receives a command string, creates a test working directory, and returns a CommandExecutionCompletionItem with one parsed-command entry. The result is used as input to command item helpers.

**Call relations**: Command execution notification tests call it before invoking start_command_execution_item and complete_command_execution_item.

*Call graph*: 2 external calls (test_path_buf, vec!).


##### `tests::guardian_command_assessment`  (lines 2330–2376)

```
fn guardian_command_assessment(
        id: &str,
        turn_id: &str,
        status: GuardianAssessmentStatus,
    ) -> GuardianAssessmentEvent
```

**Purpose**: This test helper builds a guardian assessment event for a command. Guardian assessment is an automatic safety review before a risky action.

**Data flow**: It receives an item id, turn id, and guardian status. It fills in risk details appropriate to the status, creates a command action JSON payload, and returns a GuardianAssessmentEvent.

**Call relations**: The guardian lifecycle test uses it to feed apply_bespoke_event_handling realistic guardian events.

*Call graph*: 4 external calls (format!, json!, matches!, from_value).


##### `tests::GuardianAssessmentTestContext::apply_guardian_assessment_event`  (lines 2388–2405)

```
async fn apply_guardian_assessment_event(&self, assessment: GuardianAssessmentEvent)
```

**Purpose**: This test helper applies one guardian assessment event using a prepared test context. It avoids repeating the long argument list for the main dispatcher.

**Data flow**: It receives a guardian assessment, builds a core Event from it, and calls apply_bespoke_event_handling with the context’s thread, manager, outgoing sender, state, and watch manager. Any emitted messages go to the test channel.

**Call relations**: guardian_command_execution_notifications_wrap_review_lifecycle calls it repeatedly to simulate a full guardian review sequence.

*Call graph*: calls 1 internal fn (apply_bespoke_event_handling); 5 external calls (new, clone, clone, GuardianAssessment, new).


##### `tests::guardian_assessment_started_uses_event_turn_id_fallback`  (lines 2409–2452)

```
fn guardian_assessment_started_uses_event_turn_id_fallback()
```

**Purpose**: This test checks that a guardian assessment with an empty turn id still produces a started notification using the surrounding event’s turn id.

**Data flow**: It builds a guardian assessment with no assessment turn id, calls the notification builder, and asserts that the notification uses the fallback turn id and contains the expected review details.

**Call relations**: It validates behavior relied on by apply_bespoke_event_handling when guardian assessment data is incomplete.

*Call graph*: calls 1 internal fn (new); 5 external calls (new, assert_eq!, guardian_auto_approval_review_notification, test_path_buf, panic!).


##### `tests::guardian_assessment_completed_emits_review_payload`  (lines 2455–2505)

```
fn guardian_assessment_completed_emits_review_payload()
```

**Purpose**: This test checks the completed guardian review notification for a denied command assessment.

**Data flow**: It builds a completed guardian assessment with risk, authorization, rationale, and action details, then asserts that the generated notification preserves those fields in client-facing form.

**Call relations**: It exercises the external guardian_auto_approval_review_notification used by apply_bespoke_event_handling.

*Call graph*: calls 1 internal fn (new); 4 external calls (assert_eq!, guardian_auto_approval_review_notification, test_path_buf, panic!).


##### `tests::guardian_assessment_aborted_emits_completed_review_payload`  (lines 2508–2551)

```
fn guardian_assessment_aborted_emits_completed_review_payload()
```

**Purpose**: This test checks that an aborted guardian assessment is reported as a completed review with aborted status.

**Data flow**: It creates a network-access guardian assessment marked aborted, generates the client notification, and verifies ids, status, decision source, and action data.

**Call relations**: It covers a guardian outcome that apply_bespoke_event_handling forwards to clients.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, guardian_auto_approval_review_notification, panic!).


##### `tests::command_execution_started_helper_emits_once`  (lines 2554–2622)

```
async fn command_execution_started_helper_emits_once() -> Result<()>
```

**Purpose**: This test proves start_command_execution_item sends a command-start notification only the first time for an item id.

**Data flow**: It creates test state and an outgoing channel, starts the same command twice, reads the first emitted ItemStarted message, and confirms the second call emits nothing.

**Call relations**: It directly tests the duplicate-suppression behavior used by approval and guardian event handling.

*Call graph*: calls 5 internal fn (disabled, start_command_execution_item, new, new, new); 9 external calls (new, command_execution_completion_item, new_thread_state, recv_broadcast_message, assert!, assert_eq!, bail!, channel, vec!).


##### `tests::complete_command_execution_item_emits_declined_once_for_pending_command`  (lines 2625–2701)

```
async fn complete_command_execution_item_emits_declined_once_for_pending_command() -> Result<()>
```

**Purpose**: This test proves a pending command completion is emitted once and then cleared.

**Data flow**: It starts a command item, consumes the start notification, completes it as declined, checks the completion notification, then tries to complete it again and confirms no extra message appears.

**Call relations**: It directly tests complete_command_execution_item, which is used when approvals or guardian checks stop a command before normal execution.

*Call graph*: calls 6 internal fn (disabled, complete_command_execution_item, start_command_execution_item, new, new, new); 9 external calls (new, command_execution_completion_item, new_thread_state, recv_broadcast_message, assert!, assert_eq!, bail!, channel, vec!).


##### `tests::guardian_command_execution_notifications_wrap_review_lifecycle`  (lines 2704–2906)

```
async fn guardian_command_execution_notifications_wrap_review_lifecycle() -> Result<()>
```

**Purpose**: This integration-style test checks that guardian command reviews produce the right visible command and review notifications.

**Data flow**: It creates a test Codex thread and outgoing channel, sends guardian assessments for approved, denied, and missing-target cases, then reads emitted messages in order. It verifies when command items start, when review notifications start or complete, and when denied commands are completed as declined.

**Call relations**: It drives apply_bespoke_event_handling through GuardianAssessmentTestContext::apply_guardian_assessment_event and indirectly covers start_command_execution_item and complete_command_execution_item.

*Call graph*: calls 7 internal fn (disabled, new, new, new, thread_manager_with_models_provider_and_home, default_for_tests, create_dummy_chatgpt_auth_for_testing); 11 external calls (new, new, guardian_command_assessment, new_thread_state, recv_broadcast_message, assert!, assert_eq!, bail!, load_default_config_for_test, channel (+1 more)).


##### `tests::file_change_accept_for_session_maps_to_approved_for_session`  (lines 2909–2913)

```
fn file_change_accept_for_session_maps_to_approved_for_session()
```

**Purpose**: This test confirms that accepting file changes for the whole session maps to the matching core decision.

**Data flow**: It passes AcceptForSession into map_file_change_approval_decision and checks that the result is ApprovedForSession.

**Call relations**: It directly tests the mapping used by on_file_change_request_approval_response.

*Call graph*: calls 1 internal fn (map_file_change_approval_decision); 1 external calls (assert_eq!).


##### `tests::mcp_server_elicitation_turn_transition_error_maps_to_cancel`  (lines 2916–2933)

```
fn mcp_server_elicitation_turn_transition_error_maps_to_cancel()
```

**Purpose**: This test checks that a client request ended because the turn changed is treated as cancellation for MCP elicitation.

**Data flow**: It creates a JSON-RPC-style error marked as a turn transition, passes it to mcp_server_elicitation_response_from_client_result, and asserts that the result is Cancel with no content.

**Call relations**: It directly covers the helper used by on_mcp_server_elicitation_response.

*Call graph*: calls 1 internal fn (mcp_server_elicitation_response_from_client_result); 2 external calls (assert_eq!, json!).


##### `tests::request_permissions_turn_transition_error_is_ignored`  (lines 2936–2951)

```
fn request_permissions_turn_transition_error_is_ignored()
```

**Purpose**: This test checks that permission responses ended by a turn transition are ignored rather than converted into denial.

**Data flow**: It builds a turn-transition client error, passes it to request_permissions_response_from_client_result, and expects None. None means no response should be submitted back to core.

**Call relations**: It verifies the early-return behavior used by on_request_permissions_response.

*Call graph*: calls 1 internal fn (request_permissions_response_from_client_result); 4 external calls (default, assert_eq!, json!, current_dir).


##### `tests::request_permissions_response_accepts_partial_network_and_file_system_grants`  (lines 2954–3055)

```
fn request_permissions_response_accepts_partial_network_and_file_system_grants()
```

**Purpose**: This test confirms that clients may grant only part of the permissions core requested, and that extra unrequested grants are ignored.

**Data flow**: It defines requested network and filesystem permissions, then tries several client responses. For each, it calls request_permissions_response_from_client_result and checks that the returned permissions are exactly the safe intersection of requested and granted permissions.

**Call relations**: It directly tests the safety rule enforced before on_request_permissions_response submits permissions to core.

*Call graph*: calls 1 internal fn (request_permissions_response_from_client_result); 6 external calls (from_read_write_roots, assert_eq!, cfg!, json!, current_dir, vec!).


##### `tests::request_permissions_response_preserves_session_scope`  (lines 3058–3078)

```
fn request_permissions_response_preserves_session_scope()
```

**Purpose**: This test confirms that a client can grant permissions for the session scope when strict auto-review is not requested.

**Data flow**: It passes a response with session scope and empty permissions into request_permissions_response_from_client_result. It checks that the returned core response keeps Session scope.

**Call relations**: It covers one allowed scope path in the permission conversion helper.

*Call graph*: calls 1 internal fn (request_permissions_response_from_client_result); 4 external calls (default, assert_eq!, json!, current_dir).


##### `tests::request_permissions_response_rejects_session_scoped_strict_auto_review`  (lines 3081–3106)

```
fn request_permissions_response_rejects_session_scoped_strict_auto_review()
```

**Purpose**: This test confirms that strict auto-review cannot be granted for an entire session.

**Data flow**: It passes a client response asking for session scope and strictAutoReview. The conversion helper logs the invalid combination and returns an empty, turn-scoped, non-strict response.

**Call relations**: It protects the rule inside request_permissions_response_from_client_result that strict auto-review is only supported for a single turn.

*Call graph*: calls 1 internal fn (request_permissions_response_from_client_result); 4 external calls (default, assert_eq!, json!, current_dir).


##### `tests::request_permissions_response_preserves_turn_scoped_strict_auto_review`  (lines 3109–3132)

```
fn request_permissions_response_preserves_turn_scoped_strict_auto_review()
```

**Purpose**: This test confirms that strict auto-review is preserved when it is only turn-scoped.

**Data flow**: It requests network permission, passes a client response granting network with strictAutoReview, and checks that the returned response remains turn-scoped and strict.

**Call relations**: It covers the valid strict-auto-review path in request_permissions_response_from_client_result.

*Call graph*: calls 1 internal fn (request_permissions_response_from_client_result); 5 external calls (default, assert!, assert_eq!, json!, current_dir).


##### `tests::request_permissions_response_accepts_explicit_child_grant_for_requested_cwd_scope`  (lines 3135–3176)

```
fn request_permissions_response_accepts_explicit_child_grant_for_requested_cwd_scope()
```

**Purpose**: This test confirms that a client may grant a specific child path when core requested write access under the current project root.

**Data flow**: It creates a temporary working directory and child path, requests project-root write access, grants the child path, and checks that the converted permissions include that child path.

**Call relations**: It verifies path localization and safe intersection inside request_permissions_response_from_client_result.

*Call graph*: calls 2 internal fn (request_permissions_response_from_client_result, from_absolute_path); 5 external calls (default, new, assert_eq!, json!, vec!).


##### `tests::request_permissions_response_rejects_child_grant_outside_requested_cwd_scope`  (lines 3179–3217)

```
fn request_permissions_response_rejects_child_grant_outside_requested_cwd_scope()
```

**Purpose**: This test confirms that a granted path outside the requested working-directory scope is ignored.

**Data flow**: It creates separate request and later working directories, requests write access relative to the request directory, grants a child of the later directory, and expects no permissions to be returned.

**Call relations**: It protects request_permissions_response_from_client_result from accidentally using a changed working directory to broaden access.

*Call graph*: calls 2 internal fn (request_permissions_response_from_client_result, from_absolute_path); 5 external calls (default, new, assert_eq!, json!, vec!).


##### `tests::request_permissions_response_ignores_broader_cwd_grant_for_requested_child_path`  (lines 3220–3259)

```
fn request_permissions_response_ignores_broader_cwd_grant_for_requested_child_path()
```

**Purpose**: This test confirms that a broader project-root grant is ignored when core only requested a specific child path.

**Data flow**: It requests write access to one child path, then provides a client response granting the whole project root. The helper returns no permission because the grant is broader than the request.

**Call relations**: It verifies the “never grant more than requested” rule in request_permissions_response_from_client_result.

*Call graph*: calls 2 internal fn (request_permissions_response_from_client_result, from_absolute_path); 6 external calls (from_read_write_roots, default, new, assert_eq!, json!, vec!).


##### `tests::test_handle_error_records_message`  (lines 3262–3287)

```
async fn test_handle_error_records_message() -> Result<()>
```

**Purpose**: This test confirms that handle_error stores the error in the turn summary.

**Data flow**: It creates thread state, records a TurnError, removes the turn summary, and checks that the stored error matches the original message and error info.

**Call relations**: It directly tests handle_error and find_and_remove_turn_summary.

*Call graph*: calls 3 internal fn (find_and_remove_turn_summary, handle_error, new); 2 external calls (new_thread_state, assert_eq!).


##### `tests::turn_started_omits_active_snapshot_items`  (lines 3290–3375)

```
async fn turn_started_omits_active_snapshot_items() -> Result<()>
```

**Purpose**: This test checks that a TurnStarted notification does not include already tracked active-turn items. The client should load items separately rather than receive stale duplicates.

**Data flow**: It preloads thread state with a turn and a user message, then sends a TurnStarted event through apply_bespoke_event_handling. It reads the notification and asserts that items are empty and marked NotLoaded.

**Call relations**: It exercises the TurnStarted branch of apply_bespoke_event_handling.

*Call graph*: calls 8 internal fn (disabled, apply_bespoke_event_handling, new, new, new, thread_manager_with_models_provider_and_home, default_for_tests, create_dummy_chatgpt_auth_for_testing); 15 external calls (new, default, new, new, new_thread_state, recv_broadcast_message, assert!, assert_eq!, bail!, load_default_config_for_test (+5 more)).


##### `tests::interrupted_subagent_activity_removes_missing_thread_watch`  (lines 3378–3463)

```
async fn interrupted_subagent_activity_removes_missing_thread_watch() -> Result<()>
```

**Purpose**: This test checks that an interrupted sub-agent whose thread no longer exists is removed from the thread watch manager.

**Data flow**: It creates a watched child thread id without an actual thread, sends a SubAgentActivity interrupted event through apply_bespoke_event_handling, and checks that the running count drops and the expected item completion notification is emitted.

**Call relations**: It exercises the SubAgentActivity branch of apply_bespoke_event_handling and its cleanup of missing child threads.

*Call graph*: calls 10 internal fn (disabled, apply_bespoke_event_handling, new, new, new, thread_manager_with_models_provider_and_home, default_for_tests, create_dummy_chatgpt_auth_for_testing, try_from, new); 11 external calls (new, new, new_thread_state, recv_broadcast_message, assert_eq!, bail!, load_default_config_for_test, channel, SubAgentActivity, new (+1 more)).


##### `tests::test_handle_turn_complete_emits_completed_without_error`  (lines 3466–3523)

```
async fn test_handle_turn_complete_emits_completed_without_error() -> Result<()>
```

**Purpose**: This test confirms that a turn with no recorded error finishes as Completed.

**Data flow**: It prepares thread state with a started turn, calls handle_turn_complete, receives the TurnCompleted notification, and checks status, timing, empty items, and no error.

**Call relations**: It directly tests handle_turn_complete and the shared emit_turn_completed_with_status path.

*Call graph*: calls 5 internal fn (disabled, handle_turn_complete, new, new, new); 12 external calls (new, default, new_thread_state, recv_broadcast_message, turn_complete_event, assert!, assert_eq!, bail!, channel, TurnComplete (+2 more)).


##### `tests::test_handle_turn_interrupted_emits_interrupted_with_error`  (lines 3526–3573)

```
async fn test_handle_turn_interrupted_emits_interrupted_with_error() -> Result<()>
```

**Purpose**: This test confirms that interrupted turns are reported as Interrupted even if an error was previously recorded.

**Data flow**: It records an error in thread state, calls handle_turn_interrupted, reads the final notification, and checks that status is Interrupted and error is omitted.

**Call relations**: It directly tests handle_turn_interrupted and shows how it differs from normal completion.

*Call graph*: calls 6 internal fn (disabled, handle_error, handle_turn_interrupted, new, new, new); 9 external calls (new, new_thread_state, recv_broadcast_message, turn_aborted_event, assert!, assert_eq!, bail!, channel, vec!).


##### `tests::test_handle_turn_complete_emits_failed_with_error`  (lines 3576–3630)

```
async fn test_handle_turn_complete_emits_failed_with_error() -> Result<()>
```

**Purpose**: This test confirms that a completed turn with a recorded error is reported as Failed.

**Data flow**: It stores a TurnError in thread state, calls handle_turn_complete, receives the final notification, and checks that the status and error fields match the failure.

**Call relations**: It tests the error-aware branch of handle_turn_complete.

*Call graph*: calls 6 internal fn (disabled, handle_error, handle_turn_complete, new, new, new); 9 external calls (new, new_thread_state, recv_broadcast_message, turn_complete_event, assert!, assert_eq!, bail!, channel, vec!).


##### `tests::test_handle_turn_plan_update_emits_notification_for_v2`  (lines 3633–3678)

```
async fn test_handle_turn_plan_update_emits_notification_for_v2() -> Result<()>
```

**Purpose**: This test checks that plan updates are converted into v2 client notifications with the right step statuses.

**Data flow**: It builds an update with two plan steps, calls handle_turn_plan_update, receives the notification, and asserts thread id, turn id, explanation, step text, and statuses.

**Call relations**: It directly tests the helper used by apply_bespoke_event_handling for PlanUpdate events.

*Call graph*: calls 5 internal fn (disabled, handle_turn_plan_update, new, new, new); 7 external calls (new, recv_broadcast_message, assert!, assert_eq!, bail!, channel, vec!).


##### `tests::test_handle_token_count_event_emits_usage_and_rate_limits`  (lines 3681–3771)

```
async fn test_handle_token_count_event_emits_usage_and_rate_limits() -> Result<()>
```

**Purpose**: This test checks that token usage and rate-limit snapshots both produce notifications.

**Data flow**: It builds token usage and rate-limit data, calls handle_token_count_event, receives two notifications, and checks important usage and limit fields.

**Call relations**: It directly tests the helper used by apply_bespoke_event_handling for TokenCount events.

*Call graph*: calls 5 internal fn (disabled, handle_token_count_event, new, new, new); 7 external calls (new, recv_broadcast_message, assert!, assert_eq!, bail!, channel, vec!).


##### `tests::test_handle_token_count_event_without_usage_info`  (lines 3774–3804)

```
async fn test_handle_token_count_event_without_usage_info() -> Result<()>
```

**Purpose**: This test confirms that no notification is emitted when a token-count event contains neither usage nor rate-limit data.

**Data flow**: It calls handle_token_count_event with both optional fields absent, then checks the outgoing channel is empty.

**Call relations**: It covers the no-op branch of handle_token_count_event.

*Call graph*: calls 5 internal fn (disabled, handle_token_count_event, new, new, new); 4 external calls (new, assert!, channel, vec!).


##### `tests::test_handle_turn_complete_emits_error_multiple_turns`  (lines 3807–3926)

```
async fn test_handle_turn_complete_emits_error_multiple_turns() -> Result<()>
```

**Purpose**: This test checks that turn summary errors are cleared after each completed turn, so one turn’s error does not leak into the next.

**Data flow**: It records errors and completes multiple turns, then reads each final notification. The first two turns fail with their own errors, while the later turn completes successfully with no stale error.

**Call relations**: It exercises handle_error, handle_turn_complete, and find_and_remove_turn_summary across repeated turns.

*Call graph*: calls 6 internal fn (disabled, handle_error, handle_turn_complete, new, new, new); 9 external calls (new, new_thread_state, recv_broadcast_message, turn_complete_event, assert!, assert_eq!, bail!, channel, vec!).


##### `tests::test_handle_turn_diff_emits_v2_notification`  (lines 3929–3966)

```
async fn test_handle_turn_diff_emits_v2_notification() -> Result<()>
```

**Purpose**: This test checks that a core diff event becomes the correct v2 TurnDiffUpdated notification.

**Data flow**: It calls handle_turn_diff with a sample unified diff, receives the outgoing notification, and verifies thread id, turn id, and diff text.

**Call relations**: It directly tests handle_turn_diff, the helper used by apply_bespoke_event_handling.

*Call graph*: calls 5 internal fn (disabled, handle_turn_diff, new, new, new); 7 external calls (new, recv_broadcast_message, assert!, assert_eq!, bail!, channel, vec!).


##### `tests::test_hook_prompt_raw_response_emits_item_completed`  (lines 3969–4017)

```
async fn test_hook_prompt_raw_response_emits_item_completed() -> Result<()>
```

**Purpose**: This test checks that hook prompt messages hidden inside raw response items are surfaced as completed HookPrompt items.

**Data flow**: It builds a hook prompt response item with two fragments, calls maybe_emit_hook_prompt_item_completed, receives the ItemCompleted notification, and verifies the fragments and hook run ids.

**Call relations**: It directly tests the hook-prompt detection path used before raw response items are forwarded.

*Call graph*: calls 6 internal fn (disabled, maybe_emit_hook_prompt_item_completed, new, new, build_hook_prompt_message, new); 8 external calls (new, from_single_hook, recv_broadcast_message, assert!, assert_eq!, bail!, channel, vec!).


### `app-server/src/thread_status.rs`

`domain_logic` · `cross-cutting thread lifecycle and request handling`

A thread in this app can move through many visible states: it may be loaded but quiet, running a turn, paused while asking the user for approval, waiting for typed input, shut down, or failed with a system error. This file is the central noticeboard for those states. Without it, the server could not reliably show the user which threads are busy, which need attention, or when a thread has disappeared.

The main piece is `ThreadWatchManager`. Other parts of the server call it whenever something important happens, such as “a turn started,” “a permission prompt was opened,” or “the thread shut down.” The manager stores small runtime facts for each thread, then converts those facts into a public `ThreadStatus`.

It also publishes changes in two ways. First, it can send outgoing server notifications so clients can update their UI. Second, it offers watch subscriptions, which are like live radio channels: listeners subscribe to one thread or to the total number of running turns and receive updates when the value changes.

A notable detail is `ThreadWatchActiveGuard`. When code asks for permission or user input, it receives a guard object. As long as that guard exists, the thread is marked as waiting. When the guard is dropped, the waiting count is reduced automatically, which helps prevent stale “waiting” badges.

#### Function details

##### `ThreadWatchActiveGuard::new`  (lines 34–45)

```
fn new(
        manager: ThreadWatchManager,
        thread_id: String,
        guard_type: ThreadWatchActiveGuardType,
    ) -> Self
```

**Purpose**: Creates a guard object that represents one active wait, such as waiting for approval or user input. The guard remembers which thread it belongs to so the wait can be cleared later.

**Data flow**: It receives a manager, a thread id, and the kind of wait. It records those values and also captures the current async runtime handle, then returns a guard ready to be held by the caller.

**Call relations**: It is called by `ThreadWatchManager::note_pending_request` after that method has marked a thread as waiting. The returned guard becomes the token whose lifetime controls when the waiting state ends.

*Call graph*: called by 1 (note_pending_request); 1 external calls (current).


##### `ThreadWatchActiveGuard::drop`  (lines 49–58)

```
fn drop(&mut self)
```

**Purpose**: Automatically clears one pending wait when the guard goes out of scope. This is a cleanup safety net, like returning a library checkout card when you are done.

**Data flow**: When the guard is destroyed, it copies the manager, thread id, and wait type. It then spawns an async task that tells the manager to reduce the matching pending counter.

**Call relations**: This is triggered by Rust’s automatic drop behavior rather than by a normal direct call. It hands work to `ThreadWatchManager::note_active_guard_released` so status updates still happen through the manager.

*Call graph*: 2 external calls (spawn, clone).


##### `ThreadWatchManager::default`  (lines 68–70)

```
fn default() -> Self
```

**Purpose**: Provides the standard empty manager when code asks for a default value. It is a convenience wrapper around normal construction.

**Data flow**: It takes no input, calls the regular constructor, and returns a manager with empty thread state and no outgoing notification sender.

**Call relations**: It delegates to `ThreadWatchManager::new`, keeping the default setup identical to explicit construction.

*Call graph*: 1 external calls (new).


##### `ThreadWatchManager::new`  (lines 74–81)

```
fn new() -> Self
```

**Purpose**: Creates a thread status manager for code that only needs in-memory tracking and subscriptions. It does not send outgoing client notifications.

**Data flow**: It starts with no thread records, creates a shared locked state store, creates a watch channel for the running-turn count with initial value zero, and returns the manager.

**Call relations**: It is used by tests and by server setup paths that need a fresh status tracker. Later calls such as `upsert_thread`, `note_turn_started`, and `subscribe_running_turn_count` use the state created here.

*Call graph*: called by 11 (guardian_command_execution_notifications_wrap_review_lifecycle, interrupted_subagent_activity_removes_missing_thread_watch, turn_started_omits_active_snapshot_items, has_running_turns_tracks_runtime_running_flag_only, loaded_status_defaults_to_not_loaded_for_untracked_threads, loaded_statuses_default_to_not_loaded_for_untracked_threads, shutdown_marks_thread_not_loaded, status_updates_track_single_thread, status_watchers_receive_only_their_thread_updates, system_error_sets_idle_flag_until_next_turn (+1 more)); 4 external calls (new, new, default, channel).


##### `ThreadWatchManager::new_with_outgoing`  (lines 83–90)

```
fn new_with_outgoing(outgoing: Arc<OutgoingMessageSender>) -> Self
```

**Purpose**: Creates a manager that can also broadcast thread status changes to connected clients. This is used when UI-facing notifications are needed.

**Data flow**: It receives an outgoing message sender, stores it, creates empty shared state, creates a running-turn-count watch channel set to zero, and returns the manager.

**Call relations**: It is called by setup and tests that verify notifications. Its outgoing sender is later used by `mutate_and_publish` whenever a status actually changes.

*Call graph*: called by 3 (new, silent_upsert_skips_initial_notification, status_change_emits_notification); 4 external calls (new, new, default, channel).


##### `ThreadWatchManager::upsert_thread`  (lines 92–97)

```
async fn upsert_thread(&self, thread: Thread)
```

**Purpose**: Marks a thread as known and loaded, creating it if needed or refreshing it if already present. It can emit a status-change notification.

**Data flow**: It receives a `Thread`, uses its id, updates the stored runtime facts to say the thread is loaded, recalculates status, and may publish a change.

**Call relations**: Thread resume and listener attachment flows call this when a thread becomes available. It performs the actual state change through `mutate_and_publish`.

*Call graph*: calls 1 internal fn (mutate_and_publish); called by 2 (thread_resume_inner, try_attach_thread_listener).


##### `ThreadWatchManager::upsert_thread_silently`  (lines 99–104)

```
async fn upsert_thread_silently(&self, thread: Thread)
```

**Purpose**: Marks a thread as known and loaded without sending the initial notification. This is useful when the server is preparing internal state and does not want to announce a harmless setup step.

**Data flow**: It receives a `Thread`, stores or refreshes its loaded state, updates any local watchers, and suppresses the outgoing status notification for that upsert.

**Call relations**: Forking and detached review startup use this quiet version. It still goes through `mutate_and_publish`, but the state layer is told not to emit the initial notification.

*Call graph*: calls 1 internal fn (mutate_and_publish); called by 2 (thread_fork_inner, start_detached_review).


##### `ThreadWatchManager::remove_thread`  (lines 106–110)

```
async fn remove_thread(&self, thread_id: &str)
```

**Purpose**: Forgets a thread and marks it as not loaded. This lets subscribers and clients know that the thread is no longer active in memory.

**Data flow**: It receives a thread id, removes that thread’s runtime facts, updates any watcher for that id to `NotLoaded`, and may publish a status-change notification.

**Call relations**: Teardown and unload paths call this when a thread is being removed. It uses `mutate_and_publish` so the running count and outgoing messages stay consistent.

*Call graph*: calls 1 internal fn (mutate_and_publish); called by 3 (apply_bespoke_event_handling, unload_thread_without_subscribers, finalize_thread_teardown).


##### `ThreadWatchManager::loaded_status_for_thread`  (lines 112–114)

```
async fn loaded_status_for_thread(&self, thread_id: &str) -> ThreadStatus
```

**Purpose**: Returns the current public status for one thread. Unknown threads are treated as `NotLoaded`.

**Data flow**: It receives a thread id, reads the locked state, asks the state for that thread’s loaded status, and returns a `ThreadStatus` value.

**Call relations**: Many response-building paths call this when they need to show one thread’s status. It reads state directly and does not publish anything.

*Call graph*: called by 11 (apply_bespoke_event_handling, handle_pending_thread_resume_request, read_thread_view, resume_running_thread, thread_fork_inner, thread_metadata_update_response_inner, thread_resume_inner, thread_turns_list_response_inner, thread_unarchive_response, start_detached_review (+1 more)).


##### `ThreadWatchManager::loaded_statuses_for_threads`  (lines 116–128)

```
async fn loaded_statuses_for_threads(
        &self,
        thread_ids: Vec<String>,
    ) -> HashMap<String, ThreadStatus>
```

**Purpose**: Returns statuses for several threads at once. This avoids repeated locking when building lists or search results.

**Data flow**: It receives a list of thread ids, locks the state once, looks up each id, substitutes `NotLoaded` for missing ones, and returns a map from id to status.

**Call relations**: Thread list and thread search responses call this when they need statuses for many results. It relies on `ThreadWatchState::loaded_status_for_thread` for each item.

*Call graph*: called by 2 (thread_list_response_inner, thread_search_response_inner).


##### `ThreadWatchManager::running_turn_count`  (lines 131–139)

```
async fn running_turn_count(&self) -> usize
```

**Purpose**: Test-only helper that counts how many threads currently have a running turn. It checks the raw running flag rather than broader active states.

**Data flow**: It reads all stored runtime records, counts the ones whose `running` flag is true, and returns that number.

**Call relations**: Tests use it to confirm that waiting for approval alone does not count as a running turn. Production code uses the watch subscription instead.


##### `ThreadWatchManager::subscribe_running_turn_count`  (lines 141–143)

```
fn subscribe_running_turn_count(&self) -> watch::Receiver<usize>
```

**Purpose**: Lets other code listen for changes in the total number of running turns. This is useful for UI or coordination code that only cares whether work is currently underway.

**Data flow**: It takes no input, creates a new receiver attached to the existing watch channel, and returns that receiver to the caller.

**Call relations**: `subscribe_running_assistant_turn_count` calls this to expose the live count. The count is updated by `mutate_and_publish` after every relevant state change.

*Call graph*: called by 1 (subscribe_running_assistant_turn_count); 1 external calls (subscribe).


##### `ThreadWatchManager::note_turn_started`  (lines 145–152)

```
async fn note_turn_started(&self, thread_id: &str)
```

**Purpose**: Records that a thread has begun doing assistant work. It also clears any previous system error for that thread.

**Data flow**: It receives a thread id, marks that thread loaded and running, clears `has_system_error`, recalculates the status, and publishes changes.

**Call relations**: Event-handling code calls this when it observes a turn start. It delegates the actual edit to `update_runtime_for_thread`.

*Call graph*: calls 1 internal fn (update_runtime_for_thread); called by 1 (apply_bespoke_event_handling).


##### `ThreadWatchManager::note_turn_completed`  (lines 154–156)

```
async fn note_turn_completed(&self, thread_id: &str, _failed: bool)
```

**Purpose**: Records that a thread’s turn finished. The current `_failed` argument is accepted but not used here.

**Data flow**: It receives a thread id, clears the running flag and any pending approval or user-input waits, then publishes the resulting status.

**Call relations**: Event-handling code calls this when a turn completes. It shares cleanup logic with interruptions through `clear_active_state`.

*Call graph*: calls 1 internal fn (clear_active_state); called by 1 (apply_bespoke_event_handling).


##### `ThreadWatchManager::note_turn_interrupted`  (lines 158–160)

```
async fn note_turn_interrupted(&self, thread_id: &str)
```

**Purpose**: Records that a thread’s turn stopped before normal completion. For status purposes, it clears the same active markers as a completed turn.

**Data flow**: It receives a thread id, clears running and pending request counters, then publishes the updated status.

**Call relations**: Event-handling code calls this when a turn is interrupted. It delegates to `clear_active_state`, just like `note_turn_completed`.

*Call graph*: calls 1 internal fn (clear_active_state); called by 1 (apply_bespoke_event_handling).


##### `ThreadWatchManager::note_thread_shutdown`  (lines 162–170)

```
async fn note_thread_shutdown(&self, thread_id: &str)
```

**Purpose**: Records that a thread runtime has shut down. This marks the thread as no longer loaded.

**Data flow**: It receives a thread id, clears running and pending waits, sets `is_loaded` to false, recalculates status as `NotLoaded`, and publishes changes.

**Call relations**: Event-handling code calls this when shutdown is observed. It changes the stored runtime through `update_runtime_for_thread`.

*Call graph*: calls 1 internal fn (update_runtime_for_thread); called by 1 (apply_bespoke_event_handling).


##### `ThreadWatchManager::note_system_error`  (lines 172–180)

```
async fn note_system_error(&self, thread_id: &str)
```

**Purpose**: Records that a thread hit a system-level failure. The thread stops being active and is shown as being in error.

**Data flow**: It receives a thread id, clears running and pending waits, sets the system-error flag, recalculates status, and publishes changes.

**Call relations**: Event-handling code calls this when an error event arrives. A later `note_turn_started` clears the error flag for the next run.

*Call graph*: calls 1 internal fn (update_runtime_for_thread); called by 1 (apply_bespoke_event_handling).


##### `ThreadWatchManager::clear_active_state`  (lines 182–189)

```
async fn clear_active_state(&self, thread_id: &str)
```

**Purpose**: Shared helper that removes all active-turn markers from one thread. It is used when a turn finishes or is interrupted.

**Data flow**: It receives a thread id, clears the running flag and both pending request counters, then lets the manager recalculate and publish status.

**Call relations**: `note_turn_completed` and `note_turn_interrupted` both call this so they do not duplicate the same cleanup steps.

*Call graph*: calls 1 internal fn (update_runtime_for_thread); called by 2 (note_turn_completed, note_turn_interrupted).


##### `ThreadWatchManager::note_permission_requested`  (lines 191–197)

```
async fn note_permission_requested(
        &self,
        thread_id: &str,
    ) -> ThreadWatchActiveGuard
```

**Purpose**: Records that a thread is waiting for approval. It returns a guard that keeps that waiting state alive until the request is finished.

**Data flow**: It receives a thread id, increases the pending permission count, updates status to include `WaitingOnApproval`, and returns a guard object.

**Call relations**: Event-handling code calls this when a permission request appears. It delegates to `note_pending_request` with the permission kind.

*Call graph*: calls 1 internal fn (note_pending_request); called by 1 (apply_bespoke_event_handling).


##### `ThreadWatchManager::note_user_input_requested`  (lines 199–205)

```
async fn note_user_input_requested(
        &self,
        thread_id: &str,
    ) -> ThreadWatchActiveGuard
```

**Purpose**: Records that a thread is waiting for the user to type or provide input. It returns a guard that clears the wait when dropped.

**Data flow**: It receives a thread id, increases the pending user-input count, updates status to include `WaitingOnUserInput`, and returns a guard object.

**Call relations**: Event-handling code calls this when a user-input request appears. It delegates to `note_pending_request` with the user-input kind.

*Call graph*: calls 1 internal fn (note_pending_request); called by 1 (apply_bespoke_event_handling).


##### `ThreadWatchManager::note_pending_request`  (lines 207–219)

```
async fn note_pending_request(
        &self,
        thread_id: &str,
        guard_type: ThreadWatchActiveGuardType,
    ) -> ThreadWatchActiveGuard
```

**Purpose**: Shared helper for marking a thread as waiting on either approval or user input. It also creates the lifetime guard for that wait.

**Data flow**: It receives a thread id and wait type, marks the thread loaded, increments the matching pending counter safely, publishes the new status, and returns a `ThreadWatchActiveGuard`.

**Call relations**: `note_permission_requested` and `note_user_input_requested` both call this. It calls `update_runtime_for_thread` for the state change, then `ThreadWatchActiveGuard::new` for the cleanup token.

*Call graph*: calls 2 internal fn (new, update_runtime_for_thread); called by 2 (note_permission_requested, note_user_input_requested).


##### `ThreadWatchManager::mutate_and_publish`  (lines 221–244)

```
async fn mutate_and_publish(&self, mutate: F)
```

**Purpose**: Applies one state change and then broadcasts any effects. This is the manager’s central “change state, then tell everyone” path.

**Data flow**: It receives a closure that edits `ThreadWatchState`. While holding the lock, it applies the edit and counts running turns; after releasing the lock, it updates the running-count watch channel and sends an outgoing notification if one was produced.

**Call relations**: `upsert_thread`, `upsert_thread_silently`, `remove_thread`, and `update_runtime_for_thread` all use this. It is where internal changes become external updates.

*Call graph*: called by 4 (remove_thread, update_runtime_for_thread, upsert_thread, upsert_thread_silently); 2 external calls (send, ThreadStatusChanged).


##### `ThreadWatchManager::subscribe`  (lines 246–251)

```
async fn subscribe(
        &self,
        thread_id: ThreadId,
    ) -> Option<watch::Receiver<ThreadStatus>>
```

**Purpose**: Lets a caller listen to status changes for one specific thread. The caller immediately has access to the current status and later receives changes.

**Data flow**: It receives a typed thread id, converts it to text, locks the state, creates or reuses that thread’s watch sender, and returns a receiver.

**Call relations**: Code that needs a live view of one thread calls this. The returned receiver is fed by `ThreadWatchState::update_status_watcher` whenever that thread changes.

*Call graph*: 1 external calls (to_string).


##### `ThreadWatchManager::note_active_guard_released`  (lines 253–263)

```
async fn note_active_guard_released(
        &self,
        thread_id: String,
        guard_type: ThreadWatchActiveGuardType,
    )
```

**Purpose**: Clears one pending approval or user-input wait after its guard is dropped. It prevents a thread from staying falsely marked as waiting.

**Data flow**: It receives a thread id and wait type, finds the matching counter, subtracts one without going below zero, recalculates status, and publishes any change.

**Call relations**: `ThreadWatchActiveGuard::drop` schedules this method. It uses `update_runtime_for_thread` so guard cleanup follows the same publish path as other updates.

*Call graph*: calls 1 internal fn (update_runtime_for_thread).


##### `ThreadWatchManager::update_runtime_for_thread`  (lines 265–272)

```
async fn update_runtime_for_thread(&self, thread_id: &str, update: F)
```

**Purpose**: Shared helper for changing the stored runtime facts for one thread. It ensures missing records are created and changes are published.

**Data flow**: It receives a thread id and an update function, converts the id to owned text, asks the state to apply the update, and then sends any resulting notifications through `mutate_and_publish`.

**Call relations**: Turn starts, shutdowns, errors, pending requests, guard releases, and active-state cleanup all call this. It is the bridge between high-level events and the raw state object.

*Call graph*: calls 1 internal fn (mutate_and_publish); called by 6 (clear_active_state, note_active_guard_released, note_pending_request, note_system_error, note_thread_shutdown, note_turn_started).


##### `ThreadWatchManager::pending_counter`  (lines 274–282)

```
fn pending_counter(
        runtime: &mut RuntimeFacts,
        guard_type: ThreadWatchActiveGuardType,
    ) -> &mut u32
```

**Purpose**: Chooses which pending-request counter to edit based on the kind of wait. It keeps approval and user-input counts separate.

**Data flow**: It receives mutable runtime facts and a guard type. It returns a mutable reference to either the permission counter or the user-input counter.

**Call relations**: `note_pending_request` uses it to increment the right counter, and `note_active_guard_released` uses it to decrement the same kind of counter.


##### `resolve_thread_status`  (lines 285–299)

```
fn resolve_thread_status(
    status: ThreadStatus,
    has_in_progress_turn: bool,
) -> ThreadStatus
```

**Purpose**: Corrects a race where a real running turn may be known before the thread watcher has observed it. In that narrow case, it prefers showing `Active` over `Idle` or `NotLoaded`.

**Data flow**: It receives a status and a boolean saying whether a turn is in progress. If the boolean is true and the status looks inactive, it returns `Active` with no flags; otherwise it returns the original status.

**Call relations**: Tests call this directly. In the larger design, it is a small safety helper for code that combines watcher status with another source of “turn is running” truth.

*Call graph*: called by 1 (resolves_in_progress_turn_to_active_status); 2 external calls (new, matches!).


##### `ThreadWatchState::upsert_thread`  (lines 308–325)

```
fn upsert_thread(
        &mut self,
        thread_id: String,
        emit_notification: bool,
    ) -> Option<ThreadStatusChangedNotification>
```

**Purpose**: Adds or refreshes one thread inside the raw state store. It marks the thread loaded and optionally prepares a change notification.

**Data flow**: It receives a thread id and a flag for whether to notify. It records the previous status, marks the runtime loaded, updates any watcher, and returns a notification only if requested and the status changed.

**Call relations**: `ThreadWatchManager::upsert_thread` and `upsert_thread_silently` reach this through `mutate_and_publish`. It calls status and watcher helpers to keep views current.

*Call graph*: calls 3 internal fn (status_changed_notification, status_for, update_status_watcher_for_thread).


##### `ThreadWatchState::remove_thread`  (lines 327–339)

```
fn remove_thread(&mut self, thread_id: &str) -> Option<ThreadStatusChangedNotification>
```

**Purpose**: Removes one thread from the raw state store and moves its public status to `NotLoaded`. It tells watchers even when the runtime record disappears.

**Data flow**: It receives a thread id, remembers its previous status, deletes its runtime facts, sends `NotLoaded` to that thread’s watcher, and returns a notification if there was a meaningful change.

**Call relations**: `ThreadWatchManager::remove_thread` reaches this through `mutate_and_publish`. It uses `status_for` and `update_status_watcher` to compare old and new visible state.

*Call graph*: calls 2 internal fn (status_for, update_status_watcher).


##### `ThreadWatchState::update_runtime`  (lines 341–358)

```
fn update_runtime(
        &mut self,
        thread_id: &str,
        mutate: F,
    ) -> Option<ThreadStatusChangedNotification>
```

**Purpose**: Applies a focused edit to one thread’s runtime facts and reports whether its public status changed. This is the core state update operation.

**Data flow**: It receives a thread id and a mutation function. It saves the old status, creates a runtime record if needed, marks it loaded, runs the mutation, updates watchers, and returns a notification if the status changed.

**Call relations**: `ThreadWatchManager::update_runtime_for_thread` calls this inside `mutate_and_publish`. It relies on `status_changed_notification` to decide whether clients need a message.

*Call graph*: calls 3 internal fn (status_changed_notification, status_for, update_status_watcher_for_thread).


##### `ThreadWatchState::status_for`  (lines 360–364)

```
fn status_for(&self, thread_id: &str) -> Option<ThreadStatus>
```

**Purpose**: Looks up the current status for a thread only if the thread has a runtime record. Missing threads return no status here.

**Data flow**: It receives a thread id, checks the runtime map, converts found runtime facts with `loaded_thread_status`, and returns either a status or `None`.

**Call relations**: Several state methods call this before and after changes. `loaded_status_for_thread` wraps it to provide the public default of `NotLoaded`.

*Call graph*: called by 5 (loaded_status_for_thread, remove_thread, status_changed_notification, update_runtime, upsert_thread).


##### `ThreadWatchState::loaded_status_for_thread`  (lines 366–369)

```
fn loaded_status_for_thread(&self, thread_id: &str) -> ThreadStatus
```

**Purpose**: Returns a public status for one thread, using `NotLoaded` when the thread is unknown. This is the safe lookup used by callers.

**Data flow**: It receives a thread id, asks `status_for` for a stored status, and returns that status or `ThreadStatus::NotLoaded`.

**Call relations**: Manager status queries, subscriptions, and watcher updates rely on this behavior so missing threads are shown consistently.

*Call graph*: calls 1 internal fn (status_for); called by 2 (subscribe, update_status_watcher_for_thread).


##### `ThreadWatchState::subscribe`  (lines 371–378)

```
fn subscribe(&mut self, thread_id: String) -> watch::Receiver<ThreadStatus>
```

**Purpose**: Creates or reuses a live status channel for one thread. A watch channel is like a shared latest-value feed that subscribers can wait on.

**Data flow**: It receives a thread id, computes the current status, creates a sender for that thread if none exists, and returns a receiver subscribed to it.

**Call relations**: `ThreadWatchManager::subscribe` calls this after locking state. Later `update_status_watcher_for_thread` sends changes to the receivers created here.

*Call graph*: calls 1 internal fn (loaded_status_for_thread).


##### `ThreadWatchState::update_status_watcher_for_thread`  (lines 380–383)

```
fn update_status_watcher_for_thread(&mut self, thread_id: &str)
```

**Purpose**: Recomputes one thread’s current status and pushes it to that thread’s watchers. It is a convenience wrapper for watcher updates after state changes.

**Data flow**: It receives a thread id, gets the latest loaded status, and passes that status to `update_status_watcher`.

**Call relations**: `upsert_thread` and `update_runtime` call this after changing runtime facts. It keeps subscribers synchronized with the stored state.

*Call graph*: calls 2 internal fn (loaded_status_for_thread, update_status_watcher); called by 2 (update_runtime, upsert_thread).


##### `ThreadWatchState::update_status_watcher`  (lines 385–403)

```
fn update_status_watcher(&mut self, thread_id: &str, status: &ThreadStatus)
```

**Purpose**: Sends a new status to subscribers for one thread, but only if the value actually changed. It also cleans up unused watcher channels.

**Data flow**: It receives a thread id and status. If a watcher exists, it updates the current value only when different, then removes the sender if there are no receivers left.

**Call relations**: `remove_thread` calls it directly to send `NotLoaded`, and `update_status_watcher_for_thread` calls it after normal state updates.

*Call graph*: called by 2 (remove_thread, update_status_watcher_for_thread); 1 external calls (clone).


##### `ThreadWatchState::status_changed_notification`  (lines 405–417)

```
fn status_changed_notification(
        &self,
        thread_id: String,
        previous_status: Option<ThreadStatus>,
    ) -> Option<ThreadStatusChangedNotification>
```

**Purpose**: Builds an outgoing status-change notification when a thread’s visible status has changed. It avoids noisy duplicate messages.

**Data flow**: It receives a thread id and the previous status. It calculates the current status, compares old and new, and returns either no notification or a `ThreadStatusChangedNotification`.

**Call relations**: `upsert_thread` and `update_runtime` call this after changing state. `mutate_and_publish` later sends the notification if one is returned.

*Call graph*: calls 1 internal fn (status_for); called by 2 (update_runtime, upsert_thread).


##### `loaded_thread_status`  (lines 429–451)

```
fn loaded_thread_status(runtime: &RuntimeFacts) -> ThreadStatus
```

**Purpose**: Converts raw runtime facts into the public `ThreadStatus` shown to clients. It is the rulebook for status priority.

**Data flow**: It receives runtime facts. If the thread is not loaded, it returns `NotLoaded`; otherwise it builds active flags for pending waits, returns `Active` if running or waiting, returns `SystemError` if errored, and finally returns `Idle`.

**Call relations**: `ThreadWatchState::status_for` uses this whenever it needs to turn stored facts into a visible status.

*Call graph*: 1 external calls (new).


##### `tests::loaded_status_defaults_to_not_loaded_for_untracked_threads`  (lines 466–475)

```
async fn loaded_status_defaults_to_not_loaded_for_untracked_threads()
```

**Purpose**: Checks that asking about an unknown thread returns `NotLoaded`. This protects the default behavior callers rely on.

**Data flow**: It creates a fresh manager, asks for the status of an id that was never inserted, and asserts that the result is `NotLoaded`.

**Call relations**: This test exercises `ThreadWatchManager::new` and `loaded_status_for_thread` in the simplest missing-thread case.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `tests::tracks_non_interactive_thread_status`  (lines 478–497)

```
async fn tracks_non_interactive_thread_status()
```

**Purpose**: Checks that a non-interactive thread becomes active when a turn starts. The source of the thread should not stop basic running-state tracking.

**Data flow**: It creates a manager, inserts a test thread, marks a turn started, then reads the status and expects `Active` with no special waiting flags.

**Call relations**: This test uses `ThreadWatchManager::new`, `upsert_thread`, and `note_turn_started` to verify the normal active path.

*Call graph*: calls 1 internal fn (new); 2 external calls (test_thread, assert_eq!).


##### `tests::status_updates_track_single_thread`  (lines 500–575)

```
async fn status_updates_track_single_thread()
```

**Purpose**: Checks the full status journey for one interactive thread: active, waiting for approval, waiting for input, then idle. It also verifies guard-based cleanup.

**Data flow**: It creates a manager and thread, starts a turn, opens permission and user-input waits, drops each guard, waits for the status to update, then completes the turn and expects idle.

**Call relations**: This test drives `note_permission_requested`, `note_user_input_requested`, guard dropping, and `note_turn_completed`, with `wait_for_status` helping observe async cleanup.

*Call graph*: calls 1 internal fn (new); 4 external calls (test_thread, wait_for_status, assert_eq!, vec!).


##### `tests::resolves_in_progress_turn_to_active_status`  (lines 578–595)

```
fn resolves_in_progress_turn_to_active_status()
```

**Purpose**: Checks that `resolve_thread_status` upgrades inactive-looking statuses when another signal says a turn is in progress.

**Data flow**: It passes `Idle` and `NotLoaded` statuses with `has_in_progress_turn` set to true, then asserts both come back as `Active`.

**Call relations**: This test calls `resolve_thread_status` directly to protect the race-condition workaround.

*Call graph*: calls 1 internal fn (resolve_thread_status); 1 external calls (assert_eq!).


##### `tests::keeps_status_when_no_in_progress_turn`  (lines 598–610)

```
fn keeps_status_when_no_in_progress_turn()
```

**Purpose**: Checks that statuses are not changed when there is no in-progress turn signal. The helper should only intervene in the special race case.

**Data flow**: It passes statuses with `has_in_progress_turn` set to false and asserts the same statuses come back.

**Call relations**: This test complements `tests::resolves_in_progress_turn_to_active_status` by verifying the no-op path.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::system_error_sets_idle_flag_until_next_turn`  (lines 613–641)

```
async fn system_error_sets_idle_flag_until_next_turn()
```

**Purpose**: Checks that a system error is shown after a failed runtime state, and that starting a new turn clears the error. This protects recovery behavior.

**Data flow**: It creates and loads a thread, starts a turn, records a system error, checks for `SystemError`, then starts another turn and expects `Active`.

**Call relations**: This test drives `note_system_error` and `note_turn_started`, confirming their ordering rules in `loaded_thread_status`.

*Call graph*: calls 1 internal fn (new); 2 external calls (test_thread, assert_eq!).


##### `tests::shutdown_marks_thread_not_loaded`  (lines 644–662)

```
async fn shutdown_marks_thread_not_loaded()
```

**Purpose**: Checks that shutting down a thread makes it appear not loaded. This matters because clients should stop treating it as ready or active.

**Data flow**: It creates and loads a thread, starts a turn, records shutdown, then reads the status and expects `NotLoaded`.

**Call relations**: This test exercises `note_thread_shutdown` after normal setup through `ThreadWatchManager::new` and `upsert_thread`.

*Call graph*: calls 1 internal fn (new); 2 external calls (test_thread, assert_eq!).


##### `tests::loaded_statuses_default_to_not_loaded_for_untracked_threads`  (lines 665–692)

```
async fn loaded_statuses_default_to_not_loaded_for_untracked_threads()
```

**Purpose**: Checks batch status lookup for a mix of known and unknown threads. Unknown items should still appear with `NotLoaded`.

**Data flow**: It creates one active thread, asks for statuses for that thread and another missing one, then asserts the returned map contains both expected statuses.

**Call relations**: This test exercises `loaded_statuses_for_threads`, which is used by list and search response paths.

*Call graph*: calls 1 internal fn (new); 3 external calls (test_thread, assert_eq!, vec!).


##### `tests::has_running_turns_tracks_runtime_running_flag_only`  (lines 695–718)

```
async fn has_running_turns_tracks_runtime_running_flag_only()
```

**Purpose**: Checks that the running-turn count only counts actual running turns, not pending permission waits. This keeps global “work is running” signals accurate.

**Data flow**: It creates a thread, checks count zero, adds a permission wait and still expects zero, starts a turn and expects one, then completes it and expects zero.

**Call relations**: This test uses the test-only `running_turn_count` helper to verify how `note_permission_requested`, `note_turn_started`, and `note_turn_completed` affect the running flag.

*Call graph*: calls 1 internal fn (new); 2 external calls (test_thread, assert_eq!).


##### `tests::status_change_emits_notification`  (lines 721–761)

```
async fn status_change_emits_notification()
```

**Purpose**: Checks that visible status changes are sent through the outgoing notification channel. This protects client-facing live updates.

**Data flow**: It creates a manager with an outgoing sender, inserts a thread, starts a turn, removes the thread, and after each step receives and compares the broadcast notification.

**Call relations**: This test exercises `new_with_outgoing`, `upsert_thread`, `note_turn_started`, `remove_thread`, and the helper `recv_status_changed_notification`.

*Call graph*: calls 3 internal fn (disabled, new, new_with_outgoing); 4 external calls (new, test_thread, assert_eq!, channel).


##### `tests::silent_upsert_skips_initial_notification`  (lines 764–801)

```
async fn silent_upsert_skips_initial_notification()
```

**Purpose**: Checks that silent insertion records a thread without broadcasting the initial idle status. Later real changes should still notify.

**Data flow**: It creates a notifying manager, silently upserts a thread, confirms no message arrives quickly, then starts a turn and confirms an active notification is sent.

**Call relations**: This test compares `upsert_thread_silently` with later `note_turn_started`, using the outgoing channel and `recv_status_changed_notification`.

*Call graph*: calls 3 internal fn (disabled, new, new_with_outgoing); 5 external calls (new, test_thread, assert!, assert_eq!, channel).


##### `tests::status_watchers_receive_only_their_thread_updates`  (lines 804–850)

```
async fn status_watchers_receive_only_their_thread_updates()
```

**Purpose**: Checks that per-thread subscriptions only receive updates for the thread they subscribed to. This prevents unrelated UI panels from refreshing incorrectly.

**Data flow**: It creates two threads, subscribes to both, starts a turn on one, confirms that subscriber receives `Active`, and confirms the other subscriber receives no update and remains idle.

**Call relations**: This test exercises `ThreadWatchManager::subscribe` and the watcher update path inside the state object.

*Call graph*: calls 2 internal fn (new, from_string); 5 external calls (from_secs, test_thread, assert!, assert_eq!, timeout).


##### `tests::wait_for_status`  (lines 852–868)

```
async fn wait_for_status(
        manager: &ThreadWatchManager,
        thread_id: &str,
        expected_status: ThreadStatus,
    )
```

**Purpose**: Test helper that waits until a thread reaches an expected status. It is useful because some cleanup happens asynchronously after a guard is dropped.

**Data flow**: It receives a manager, thread id, and expected status. It repeatedly reads the current status, yields to other tasks between checks, and fails the test if the expected value does not appear before the timeout.

**Call relations**: `tests::status_updates_track_single_thread` uses this after dropping guards, allowing the async drop cleanup task time to publish the new status.

*Call graph*: calls 1 internal fn (loaded_status_for_thread); 3 external calls (from_secs, yield_now, timeout).


##### `tests::recv_status_changed_notification`  (lines 870–887)

```
async fn recv_status_changed_notification(
        outgoing_rx: &mut mpsc::Receiver<OutgoingEnvelope>,
    ) -> ThreadStatusChangedNotification
```

**Purpose**: Test helper that receives one outgoing thread-status notification and extracts its payload. It fails loudly if the wrong kind of message arrives.

**Data flow**: It receives a mutable outgoing-message receiver, waits with a timeout for one envelope, verifies it is a broadcast thread-status-changed message, and returns the notification inside.

**Call relations**: Notification tests call this after actions that should publish. It checks the result of `mutate_and_publish` sending through the outgoing channel.

*Call graph*: calls 1 internal fn (recv); 3 external calls (from_secs, panic!, timeout).


##### `tests::test_thread`  (lines 889–912)

```
fn test_thread(thread_id: &str, source: codex_app_server_protocol::SessionSource) -> Thread
```

**Purpose**: Test helper that builds a minimal `Thread` value with predictable fields. It keeps the tests focused on status behavior instead of thread construction details.

**Data flow**: It receives a thread id and source, fills in required thread fields with simple test values, and returns a `Thread` starting with `NotLoaded` status.

**Call relations**: Most tests call this before upserting a thread into the manager. It supplies realistic enough data for status tracking without involving storage or real sessions.

*Call graph*: 3 external calls (new, new, test_path_buf).


### `core/src/review_format.rs`

`domain_logic` · `review result display`

When the system reviews code, it receives structured data: an overall explanation, a list of findings, file paths, line ranges, titles, and longer comments. That data is useful to the program, but not pleasant for a person to read directly. This file is the small translation layer that turns those review results into readable text.

It formats each finding like a short note: the title, the file location, and then the body text indented underneath. If the caller supplies a selection list, each finding also gets a checkbox-style marker, such as "[x]" or "[ ]". This is useful when a user can choose which review comments to keep or act on. If no selection list is supplied, it uses a simple bullet instead.

The file also builds a complete review message. It includes the reviewer’s overall explanation if there is one, then adds the formatted findings if any exist. If the reviewer produced neither an explanation nor findings, it returns a clear fallback message: "Reviewer failed to output a response." In other words, this file makes sure the user sees something understandable instead of raw data or an empty screen.

#### Function details

##### `format_location`  (lines 7–12)

```
fn format_location(item: &ReviewFinding) -> String
```

**Purpose**: This function turns a finding’s code location into a compact human-readable place marker, like a file path followed by a start and end line. Someone reading the review can use it to know exactly where the comment applies.

**Data flow**: It receives one review finding. It reads the finding’s absolute file path and its line range, then combines them into one string in the form path:start-end. It does not change the finding; it only returns the formatted location text.

**Call relations**: This is a small helper used by format_review_findings_block while building each review comment line. The larger formatter asks it for the location so the main review text can include both what the issue is and where it appears.

*Call graph*: called by 1 (format_review_findings_block); 1 external calls (format!).


##### `format_review_findings_block`  (lines 23–58)

```
fn format_review_findings_block(
    findings: &[ReviewFinding],
    selection: Option<&[bool]>,
) -> String
```

**Purpose**: This function builds the plain-text block that lists one or more review findings. It is used when the system needs to show review comments in a readable form, with optional checkbox markers for selected and unselected items.

**Data flow**: It receives a list of review findings and, optionally, a matching list of true-or-false selection values. It starts with a blank line and a header, choosing singular or plural wording depending on how many findings there are. For each finding, it asks format_location for the file-and-line text, writes a bullet line with the title and location, adds a checkbox marker if selections were provided, and then indents each line of the finding body underneath. It returns the whole block as one string joined with newline characters. If a selection list is shorter than the findings list, missing entries are treated as selected.

**Call relations**: render_review_output_text calls this when it needs to include findings inside a full review summary. exit_review_mode also calls it when leaving review mode and presenting or preserving the review comments. Inside its own work, it relies on format_location to keep location formatting consistent.

*Call graph*: calls 1 internal fn (format_location); called by 3 (render_review_output_text, render_review_output_text, exit_review_mode); 5 external calls (new, new, format!, iter, len).


##### `render_review_output_text`  (lines 64–82)

```
fn render_review_output_text(output: &ReviewOutputEvent) -> String
```

**Purpose**: This function creates the final user-facing review message from a complete review output event. It decides whether to show the overall explanation, the findings, both, or a fallback message when the reviewer returned nothing useful.

**Data flow**: It receives a review output event. It trims the overall explanation and keeps it only if it has visible text. If there are findings, it passes them to format_review_findings_block without checkbox selections, trims that result, and keeps it if it is not empty. If it collected any sections, it joins them with a blank line between them. If it collected none, it returns the fallback failure message.

**Call relations**: This is the higher-level formatter used when review output is ready to become text. exit_review_mode calls it as part of presenting the final review result, and review_op_emits_lifecycle_and_review_output calls it in test coverage for the review operation flow. When findings need detailed formatting, it hands that work to format_review_findings_block.

*Call graph*: calls 1 internal fn (format_review_findings_block); called by 2 (exit_review_mode, review_op_emits_lifecycle_and_review_output); 1 external calls (new).


### `app-server-protocol/src/protocol/event_mapping.rs`

`io_transport` · `event handling`

The core Codex system produces events in one shape, while the app server sends notifications to clients in another shape. This file is the adapter between those two worlds. Like a receptionist rewriting internal notes into customer-facing updates, it takes a single core event and turns it into the matching server notification.

The main function, `item_event_to_server_notification`, receives a core `EventMsg` plus the current thread and turn IDs. It then matches the event type and builds the correct v2 notification. Some events are simple text streams, such as agent message deltas or command output chunks. Others become timeline items, such as command executions, dynamic tool calls, patch updates, or collaborative agent actions.

A notable part of the file is the collaborative-agent mapping. It records whether another agent was spawned, sent input, waited on, closed, or resumed. It also converts agent outcomes such as “not found” or “errored” into client-facing failed statuses. For command execution and file patches, this file delegates the detailed item-building work to helper functions from `item_builders`.

The file also contains focused tests for resume-agent events and command-output streaming. These tests make sure important event shapes are translated into exactly the notification clients expect.

#### Function details

##### `item_event_to_server_notification`  (lines 30–464)

```
fn item_event_to_server_notification(
    msg: EventMsg,
    thread_id: &str,
    turn_id: &str,
) -> ServerNotification
```

**Purpose**: Turns one core Codex event into one app-server notification for clients. This is used when the server already knows the surrounding context, such as the thread and turn, and only needs the direct event-to-notification translation.

**Data flow**: It receives a core event message, a thread ID, and a turn ID. It copies the IDs into owned strings, inspects which kind of event arrived, and builds the matching notification payload. For example, command output bytes become readable text, patch changes are converted into the v2 patch shape, and collaborative-agent statuses are converted into completed or failed tool-call states. The result is a `ServerNotification`; the function does not keep state or update outside data.

**Call relations**: This function is the central translator in the file. For command execution and patch events, it hands off the detailed conversion to helper builders such as `build_command_execution_begin_item`, `build_command_execution_end_item`, and `convert_patch_changes`. The tests call it with sample resume-agent and command-output events, then compare the returned notification against the expected client-facing shape.

*Call graph*: calls 4 internal fn (build_command_execution_begin_item, build_command_execution_end_item, convert_patch_changes, from); called by 3 (collab_resume_begin_maps_to_item_started_resume_agent, collab_resume_end_maps_to_item_completed_resume_agent, exec_command_output_delta_maps_to_command_execution_output_delta); 17 external calls (new, AgentMessageDelta, CommandExecutionOutputDelta, FileChangePatchUpdated, ItemCompleted, ItemStarted, PlanDelta, ReasoningSummaryPartAdded, ReasoningSummaryTextDelta, ReasoningTextDelta (+7 more)).


##### `tests::assert_item_started_server_notification`  (lines 476–484)

```
fn assert_item_started_server_notification(
        notification: ServerNotification,
        expected: ItemStartedNotification,
    )
```

**Purpose**: Checks that a returned server notification is specifically an “item started” notification and that its contents are exactly what the test expected. It gives tests a clearer failure message than a raw comparison would.

**Data flow**: It receives an actual notification and an expected `ItemStartedNotification`. If the actual notification is the right variant, it compares the inner data. If it is any other kind of notification, it stops the test with a message explaining what was received instead.

**Call relations**: The resume-begin test uses this helper after calling `item_event_to_server_notification`. It keeps the test focused on the behavior being checked instead of repeating the same match-and-compare code.

*Call graph*: 2 external calls (assert_eq!, panic!).


##### `tests::assert_item_completed_server_notification`  (lines 486–494)

```
fn assert_item_completed_server_notification(
        notification: ServerNotification,
        expected: ItemCompletedNotification,
    )
```

**Purpose**: Checks that a returned server notification is specifically an “item completed” notification and that its contents match the expected value. It is a small test helper for completed timeline items.

**Data flow**: It takes the actual notification and the expected completed-item payload. If the notification contains a completed item, it compares that payload. If the notification is a different kind, it fails the test and reports the unexpected value.

**Call relations**: The resume-end test uses this helper after exercising `item_event_to_server_notification`. This makes the test read like a short story: build an event, translate it, then assert that the completed item looks right.

*Call graph*: 2 external calls (assert_eq!, panic!).


##### `tests::assert_command_execution_output_delta_server_notification`  (lines 496–506)

```
fn assert_command_execution_output_delta_server_notification(
        notification: ServerNotification,
        expected: CommandExecutionOutputDeltaNotification,
    )
```

**Purpose**: Checks that a returned notification is a command-output text update and that the update matches what the test expected. This is useful for verifying streaming command output, where bytes from a process become text sent to the client.

**Data flow**: It receives an actual notification and the expected command-output delta payload. If the notification is the command-output-delta variant, it compares the payload. Otherwise, it fails the test and names the unexpected notification.

**Call relations**: The command-output test uses this helper after calling `item_event_to_server_notification`. It confirms that command output is translated into the specific notification type clients listen for.

*Call graph*: 2 external calls (assert_eq!, panic!).


##### `tests::collab_resume_begin_maps_to_item_started_resume_agent`  (lines 509–543)

```
fn collab_resume_begin_maps_to_item_started_resume_agent()
```

**Purpose**: Verifies that a collaborative-agent resume start event becomes an “item started” notification for the ResumeAgent tool. This protects the client timeline from showing the wrong kind of tool action when an agent is being resumed.

**Data flow**: The test creates a sample resume-begin event with a call ID, start time, sender thread, and receiver thread. It sends that event through `item_event_to_server_notification`, then builds the exact notification it expects: an in-progress collaborative tool call with the resume tool selected. The assertion confirms the actual output matches that expected shape.

**Call relations**: This test drives the main mapper directly. It then uses `tests::assert_item_started_server_notification` to check that the mapper chose the correct notification variant and filled in the collaborative-agent fields correctly.

*Call graph*: calls 2 internal fn (item_event_to_server_notification, new); 4 external calls (new, assert_item_started_server_notification, CollabResumeBegin, vec!).


##### `tests::collab_resume_end_maps_to_item_completed_resume_agent`  (lines 546–587)

```
fn collab_resume_end_maps_to_item_completed_resume_agent()
```

**Purpose**: Verifies that a collaborative-agent resume end event becomes an “item completed” notification, and that a missing agent is reported as a failed resume. This matters because clients need to show a failed tool call when the target agent cannot be found.

**Data flow**: The test creates a resume-end event whose status is `NotFound`. It translates that event with `item_event_to_server_notification`. It then expects a completed collaborative tool-call item whose status is failed, whose receiver thread is recorded, and whose agent state records the not-found outcome. The assertion confirms all of those fields are preserved and converted correctly.

**Call relations**: This test exercises the failure branch of the main mapper’s resume-end logic. It relies on `CollabAgentState::from` through the mapper’s conversion path, then uses `tests::assert_item_completed_server_notification` to verify the final client-facing notification.

*Call graph*: calls 3 internal fn (item_event_to_server_notification, from, new); 3 external calls (assert_item_completed_server_notification, CollabResumeEnd, vec!).


##### `tests::exec_command_output_delta_maps_to_command_execution_output_delta`  (lines 590–610)

```
fn exec_command_output_delta_maps_to_command_execution_output_delta()
```

**Purpose**: Verifies that a chunk of command output becomes a command-output-delta notification with readable text. This protects the live terminal-style output clients receive while a command is running.

**Data flow**: The test creates a command-output event containing the bytes for `hello`. It passes the event through `item_event_to_server_notification`. The expected result is a notification tied to the same call ID, thread, and turn, with the byte chunk converted into the string `hello`.

**Call relations**: This test calls the main mapper for the command-output streaming case. It then uses `tests::assert_command_execution_output_delta_server_notification` to confirm the mapper produced the notification type that clients use for incremental command output.

*Call graph*: calls 1 internal fn (item_event_to_server_notification); 2 external calls (assert_command_execution_output_delta_server_notification, ExecCommandOutputDelta).


### `app-server-protocol/src/protocol/item_builders.rs`

`domain_logic` · `event handling and history rebuild`

The core system reports events such as “a command wants approval,” “a patch started applying,” or “a security review finished.” Those events are useful internally, but they are not shaped exactly like the items a client wants to show in a chat-like thread. This file is the adapter between those two worlds.

Think of it like a ticket printer at a restaurant: the kitchen has its own detailed signals, but the waiter needs a clear, consistent ticket to read. Here, the “tickets” are `ThreadItem` values. The builders create file-change items for patches, command-execution items for shell commands, and guardian approval review notifications for automatic safety checks.

The file also smooths out rough edges. It joins command argument lists into a readable shell command string, converts file paths and patch details into display-friendly change records, sorts file changes so output is stable, and fills in missing values such as completed time or unknown command actions. Some builders represent work that has not actually run yet, such as approval requests, so they mark the item as in progress and omit runtime details like process ID, exit code, and duration.

#### Function details

##### `build_file_change_approval_request_item`  (lines 40–48)

```
fn build_file_change_approval_request_item(
    payload: &ApplyPatchApprovalRequestEvent,
) -> ThreadItem
```

**Purpose**: Creates a thread item for a patch that is asking for approval before it is applied. This lets the client show the proposed file changes as an in-progress file-change item.

**Data flow**: It receives an apply-patch approval event containing a call ID and a set of file changes. It copies the call ID, converts the raw patch changes into display-friendly file update records, marks the status as in progress, and returns a `ThreadItem::FileChange`.

**Call relations**: When the approval-request handler sees that a patch needs permission, it calls this builder to create the visible thread item. The builder delegates the file-change conversion to `convert_patch_changes` so patch display is consistent with other patch paths.

*Call graph*: calls 1 internal fn (convert_patch_changes); called by 1 (handle_apply_patch_approval_request).


##### `build_file_change_begin_item`  (lines 50–56)

```
fn build_file_change_begin_item(payload: &PatchApplyBeginEvent) -> ThreadItem
```

**Purpose**: Creates a thread item when a patch application starts. It gives clients an immediate visible record that file changes are underway.

**Data flow**: It receives a patch-begin event with a call ID and file-change map. It converts those changes into client-facing records, sets the status to in progress, and returns a `ThreadItem::FileChange` with that information.

**Call relations**: The patch-begin handler calls this when patch work starts. Like the approval and completion builders, it sends the raw patch map through `convert_patch_changes` so all file-change items have the same shape.

*Call graph*: calls 1 internal fn (convert_patch_changes); called by 1 (handle_patch_apply_begin).


##### `build_file_change_end_item`  (lines 58–64)

```
fn build_file_change_end_item(payload: &PatchApplyEndEvent) -> ThreadItem
```

**Purpose**: Creates a final thread item for a patch after it has finished. This records the same file changes together with the final success or failure status.

**Data flow**: It receives a patch-end event containing the call ID, the changed files, and the core patch status. It converts the files for display, translates the status into the app-server status type, and returns a completed `ThreadItem::FileChange`.

**Call relations**: The patch-end handler calls this after patch application finishes. It relies on `convert_patch_changes` for the visible file list, while the final status comes from the patch event itself.

*Call graph*: calls 1 internal fn (convert_patch_changes); called by 1 (handle_patch_apply_end).


##### `build_command_execution_approval_request_item`  (lines 66–86)

```
fn build_command_execution_approval_request_item(
    payload: &ExecApprovalRequestEvent,
) -> ThreadItem
```

**Purpose**: Creates a command-execution thread item for a command that is asking for approval before it runs. It lets the UI show what command is being considered, even though no process has started yet.

**Data flow**: It receives a command approval request with the command arguments, working directory, call ID, and parsed command details. It turns the argument list into a readable command string, converts parsed command information into app-server command actions, marks the item as in progress, and leaves runtime fields like process ID, output, exit code, and duration empty.

**Call relations**: This builder is used for the pre-execution approval path. It uses `shlex_join` to make the command readable as a shell-style string, then packages the command as a `ThreadItem::CommandExecution` for clients.

*Call graph*: calls 1 internal fn (shlex_join).


##### `build_command_execution_begin_item`  (lines 88–106)

```
fn build_command_execution_begin_item(payload: &ExecCommandBeginEvent) -> ThreadItem
```

**Purpose**: Creates a command-execution thread item when a command actually starts running. It includes the process ID and source so the client can show a live command in progress.

**Data flow**: It receives a command-begin event with command arguments, working directory, process ID, source, and parsed command details. It joins the arguments into a readable command string, converts parsed command details into display actions, marks the command as in progress, and returns a `ThreadItem::CommandExecution` without final output or exit information yet.

**Call relations**: This is called both by live command-begin handling and by code that turns item events into server notifications. It prepares the first visible command item, while later completion handling can replace or update it with final details.

*Call graph*: calls 1 internal fn (shlex_join); called by 2 (item_event_to_server_notification, handle_exec_command_begin).


##### `build_command_execution_end_item`  (lines 108–133)

```
fn build_command_execution_end_item(payload: &ExecCommandEndEvent) -> ThreadItem
```

**Purpose**: Creates a final command-execution thread item after a command finishes. It records what ran, what it produced, how it ended, and how long it took.

**Data flow**: It receives a command-end event with the command, working directory, process ID, final status, output, exit code, duration, and parsed command details. It joins the command arguments into a readable string, omits aggregated output if it is empty, converts the duration to milliseconds with a safe maximum if it is too large, translates the status, and returns a completed `ThreadItem::CommandExecution`.

**Call relations**: This is called by command-end handling and by the item-event-to-notification path. It is the counterpart to `build_command_execution_begin_item`: the begin builder shows the running command, and this builder produces the final version with outcome details.

*Call graph*: calls 1 internal fn (shlex_join); called by 2 (item_event_to_server_notification, handle_exec_command_end); 1 external calls (try_from).


##### `build_item_from_guardian_event`  (lines 139–204)

```
fn build_item_from_guardian_event(
    assessment: &GuardianAssessmentEvent,
    status: CommandExecutionStatus,
) -> Option<ThreadItem>
```

**Purpose**: Builds a command-execution thread item from a guardian assessment when the guardian is reviewing a command-like action. The guardian is a safety review layer, and this function lets its review target appear as a normal command item in the thread.

**Data flow**: It receives a guardian assessment and the command status that should be shown. If the assessment is for a shell command, it uses the target item ID, command text, and working directory to create an in-progress-style command item. If it is for an `execve` action, meaning a direct program launch with arguments, it rebuilds a readable command line, tries to parse it into known command actions, and falls back to an unknown action if parsing finds nothing. For non-command guardian actions, it returns nothing.

**Call relations**: Guardian assessment handling calls this when it wants to synthesize a visible thread item from a safety review. The function uses `shlex_join` for readable command text and `parse_command` to identify useful command actions where possible.

*Call graph*: calls 2 internal fn (parse_command, shlex_join); called by 1 (handle_guardian_assessment); 2 external calls (once, vec!).


##### `guardian_auto_approval_review_notification`  (lines 206–277)

```
fn guardian_auto_approval_review_notification(
    conversation_id: &ThreadId,
    event_turn_id: &str,
    assessment: &GuardianAssessmentEvent,
) -> ServerNotification
```

**Purpose**: Creates a server notification that tells clients a guardian approval review has started or completed. This is how automatic safety decisions become visible in the app-server protocol.

**Data flow**: It receives the conversation ID, the event turn ID, and the guardian assessment. It chooses the best turn ID, translates the guardian status, risk level, authorization, rationale, and action into app-server types, then returns either a “review started” notification for in-progress assessments or a “review completed” notification for approved, denied, timed-out, or aborted assessments. If completion time is missing, it uses the start time as a fallback.

**Call relations**: This function sits on the notification path for guardian review events. It packages the review details into either `ItemGuardianApprovalReviewStartedNotification` or `ItemGuardianApprovalReviewCompletedNotification` so clients receive a clear lifecycle update.

*Call graph*: 3 external calls (ItemGuardianApprovalReviewCompleted, ItemGuardianApprovalReviewStarted, to_string).


##### `convert_patch_changes`  (lines 279–290)

```
fn convert_patch_changes(changes: &HashMap<PathBuf, FileChange>) -> Vec<FileUpdateChange>
```

**Purpose**: Converts raw patch file changes into the simpler list of file updates that clients display. It also sorts them by path so the same patch appears in a predictable order.

**Data flow**: It receives a map from file paths to raw file-change records. For each entry, it turns the path into text, translates the kind of change, formats the diff or content, collects the results into a list, sorts that list by path, and returns it.

**Call relations**: The file-change builders call this whenever they need to show patch contents. Other conversion paths also use it, which keeps approval requests, patch starts, patch ends, and rebuilt history from drifting apart in how file changes are shown.

*Call graph*: called by 5 (item_event_to_server_notification, build_file_change_approval_request_item, build_file_change_begin_item, build_file_change_end_item, from).


##### `map_patch_change_kind`  (lines 292–300)

```
fn map_patch_change_kind(change: &FileChange) -> PatchChangeKind
```

**Purpose**: Translates the core patch change type into the app-server change type used by clients. It preserves whether a file was added, deleted, updated, or moved.

**Data flow**: It receives one raw file change. It checks which variant it is: add, delete, or update. It returns the matching `PatchChangeKind`, carrying along the move target when an update represents a move.

**Call relations**: This is a small helper used as part of patch-change conversion. It supplies the “what kind of change is this?” piece while the surrounding conversion builds the full client-facing file update record.


##### `format_file_change_diff`  (lines 302–317)

```
fn format_file_change_diff(change: &FileChange) -> String
```

**Purpose**: Produces the text clients should show for a single file change. For moved files, it adds a short note showing the new path.

**Data flow**: It receives one raw file change. For added or deleted files, it returns the file content stored in the change. For updated files, it returns the unified diff, which is a standard before-and-after patch format; if the file was moved, it appends a “Moved to” line with the destination path.

**Call relations**: This helper is used during patch-change conversion to fill the display text for each changed file. It keeps the formatting rule for moved files in one place instead of repeating it in every patch builder.

*Call graph*: 1 external calls (format!).


### `app-server/src/request_processors/token_usage_replay.rs`

`domain_logic` · `client attach / thread replay`

When a client opens an existing thread, the server may already have a saved record of how many tokens were used. This file turns that saved record into a fresh server notification so the client can show accurate usage without asking the model to do anything again. Think of it like reopening a receipt: the cost was already recorded, and this code simply shows it to the returning customer.

The main job is careful attribution. A token count belongs to the turn that was active when the count was saved. The file reads the saved rollout history, which is the ordered list of events that rebuilt the thread, and remembers which turn was active when the latest token-count event appeared. If that exact turn id still exists, it uses it. If ids were regenerated while rebuilding the thread, it falls back to the turn’s position in the thread, so the usage still lands on the corresponding turn.

A second safety behavior is that replay is connection-scoped. The update is sent only to the client that just attached, not broadcast to everyone watching the thread. That prevents other clients from seeing an old usage update as if it were new live activity.

#### Function details

##### `send_thread_token_usage_update_to_connection`  (lines 36–58)

```
async fn send_thread_token_usage_update_to_connection(
    outgoing: &Arc<OutgoingMessageSender>,
    connection_id: ConnectionId,
    thread_id: ThreadId,
    thread: &Thread,
    conversation: &Code
```

**Purpose**: Sends a saved token-usage update to one specific connection that has attached to an existing thread. It is used for replaying already-recorded usage, not for creating a new model event.

**Data flow**: It receives the outgoing message sender, the target connection id, the thread id, the rebuilt thread, the live conversation object, and an optional turn id already chosen for the token usage. It asks the conversation for saved token-usage information; if there is none, it stops. If there is usage data, it builds a thread-token-usage notification, choosing the provided turn id or falling back to the latest suitable turn in the thread, converts the usage data into the protocol shape, and sends the notification only to the given connection.

**Call relations**: A higher-level request processor calls this after deciding replay is allowed for a newly attached client. Inside, it calls `token_usage_info` to read the saved usage, uses `ThreadTokenUsage::from` to convert that data for the app-server protocol, builds a `ThreadTokenUsageUpdatedNotification`, and hands it to the outgoing-message sender so only the attaching connection receives it.

*Call graph*: calls 2 internal fn (from, token_usage_info); 2 external calls (ThreadTokenUsageUpdated, to_string).


##### `latest_token_usage_turn_id_from_rollout_items`  (lines 69–98)

```
fn latest_token_usage_turn_id_from_rollout_items(
    rollout_items: &[RolloutItem],
    turns: &[Turn],
) -> Option<String>
```

**Purpose**: Finds which rebuilt turn should receive the latest saved token-usage update. It exists because a saved history may contain old turn ids that no longer match the rebuilt thread.

**Data flow**: It receives the saved rollout items and the list of rebuilt turns. It walks through the rollout items in order with a thread-history builder, watching for token-count events. Whenever it sees one, it records a snapshot of the currently active turn: both its id and its position in the turn list. After the walk, it returns the saved id if that id still appears in the rebuilt turns. If not, it uses the saved position to look up the corresponding rebuilt turn and returns that rebuilt id. If no token-count owner can be found, it returns nothing.

**Call relations**: This function is the normal attribution path used before replaying token usage. It creates a `ThreadHistoryBuilder` with `new`, iterates through the rollout history, checks each item for a token-count event, and relies on the builder’s view of the active turn to map old persisted history back to the rebuilt `Turn` list.

*Call graph*: calls 1 internal fn (new); 2 external calls (iter, matches!).


##### `latest_token_usage_turn_id`  (lines 105–114)

```
fn latest_token_usage_turn_id(thread: &Thread) -> String
```

**Purpose**: Chooses a backup turn id when the more precise rollout-based attribution is unavailable. It gives the replay notification a stable turn id even for unusual or incomplete histories.

**Data flow**: It receives a rebuilt thread. It scans the turns from newest to oldest and prefers the latest turn that is completed or failed, because those are the most likely to have finished usage information. If none are completed or failed, it uses the last turn in the thread. If the thread has no turns at all, it returns an empty string.

**Call relations**: This is the fallback used by `send_thread_token_usage_update_to_connection` when no token-usage turn id was supplied. It does not call out to other project helpers; it simply inspects the thread’s turns and picks the best available id.


##### `tests::replay_attribution_uses_already_loaded_history`  (lines 126–134)

```
fn replay_attribution_uses_already_loaded_history()
```

**Purpose**: Checks that token usage is attributed to the original rebuilt turn when the saved turn id still matches. This protects the normal replay path.

**Data flow**: It builds a small fake rollout history with one user turn, one agent answer, a token count, and then another user turn. It rebuilds turns from that history, asks `latest_token_usage_turn_id_from_rollout_items` for the owner of the token usage, and asserts that the answer is the first turn’s id.

**Call relations**: This test uses `tests::token_usage_history` to create the sample history and `build_turns_from_rollout_items` to rebuild the visible turns. It then exercises the attribution function directly and uses `assert_eq!` to lock in the expected result.

*Call graph*: 3 external calls (token_usage_history, assert_eq!, build_turns_from_rollout_items).


##### `tests::replay_attribution_falls_back_to_rebuilt_turn_position`  (lines 137–146)

```
fn replay_attribution_falls_back_to_rebuilt_turn_position()
```

**Purpose**: Checks that attribution still works when the old saved turn id no longer matches the rebuilt thread. This protects the position-based fallback.

**Data flow**: It creates the same fake rollout history and rebuilds the turns, then deliberately changes the first rebuilt turn’s id to a new value. It asks `latest_token_usage_turn_id_from_rollout_items` for the token-usage owner and asserts that the function returns the new rebuilt id at the same position.

**Call relations**: This test mirrors the normal-history test but simulates regenerated turn ids. It calls `tests::token_usage_history`, rebuilds turns with `build_turns_from_rollout_items`, mutates the first turn id, and confirms with `assert_eq!` that the attribution function falls back by position.

*Call graph*: 3 external calls (token_usage_history, assert_eq!, build_turns_from_rollout_items).


##### `tests::token_usage_history`  (lines 148–176)

```
fn token_usage_history() -> Vec<RolloutItem>
```

**Purpose**: Creates a compact sample conversation history for the replay-attribution tests. The history is shaped to show a token count saved after the first answer and before the second turn begins.

**Data flow**: It takes no input. It returns a vector of rollout items: a user message for the first turn, an agent message answering it, a token-count event, and a user message starting a second turn.

**Call relations**: The two replay-attribution tests call this helper so they share the same controlled history. It uses the standard vector-building macro to produce the rollout items that are then fed into `build_turns_from_rollout_items` and the attribution function.

*Call graph*: 1 external calls (vec!).


### `app-server-protocol/src/protocol/thread_history.rs`

`domain_logic` · `rollout replay and live thread update tracking`

A conversation thread is saved as many small events: the user typed something, the agent answered, a command started, a file patch finished, a tool failed, a turn was rolled back, and so on. This file rebuilds those scattered events into ordered turns, where each turn contains the visible items that happened during one user-agent exchange. Think of it like taking a pile of receipts and arranging them into a clear trip itinerary.

The central piece is `ThreadHistoryBuilder`. It keeps finished turns, one currently open turn, and counters for generated item IDs. Incoming events are routed to small handler methods. Some handlers add new items, such as user messages or agent messages. Others update an existing item, such as changing a web search from “started” to “completed.” Turn-level events mark turns as in progress, completed, failed, or interrupted.

The file also supports incremental updates. Instead of rebuilding the whole history after each new log entry, callers can ask for a compact change set: which items changed, which turn metadata changed, and which turns were removed by rollback. This matters for live clients because they can update the display efficiently without rereading the whole thread.

#### Function details

##### `build_turns_from_rollout_items`  (lines 78–84)

```
fn build_turns_from_rollout_items(items: &[RolloutItem]) -> Vec<Turn>
```

**Purpose**: Rebuilds a full list of turns from saved rollout items, which are the persisted log records for a thread. Callers use it when resuming or displaying an existing thread.

**Data flow**: It receives a slice of saved rollout items → creates a fresh `ThreadHistoryBuilder` → feeds each item to the builder in order → finishes the builder and returns the completed list of turns.

**Call relations**: Many tests exercise this as the public replay path. Internally it starts with `ThreadHistoryBuilder::new`, then relies on `ThreadHistoryBuilder::handle_rollout_item` and `ThreadHistoryBuilder::finish` to do the actual reconstruction.

*Call graph*: calls 1 internal fn (new); called by 29 (assigns_late_exec_completion_to_original_turn, drops_last_turns_on_thread_rollback, error_then_turn_complete_preserves_failed_status, ignores_plain_user_response_items_in_rollout_replay, ignores_user_message_item_lifecycle_events, late_turn_aborted_does_not_interrupt_active_turn, late_turn_complete_does_not_close_active_turn, marks_turn_as_interrupted_when_aborted, out_of_turn_error_does_not_create_or_fail_a_turn, preserves_agent_message_phase_in_history (+15 more)).


##### `ThreadHistoryChangeSet::is_empty`  (lines 114–118)

```
fn is_empty(&self) -> bool
```

**Purpose**: Checks whether a change set contains no useful updates. This is a quick way for callers to skip unnecessary client notifications.

**Data flow**: It reads the three lists inside the change set → checks that changed items, changed turns, and removed turn IDs are all empty → returns true only if nothing changed.

**Call relations**: This is a small helper for consumers of incremental history updates. It does not call other project code and is used after handlers produce a `ThreadHistoryChangeSet`.


##### `ThreadHistoryTurnChange::from_pending_turn`  (lines 122–131)

```
fn from_pending_turn(turn: &PendingTurn) -> Self
```

**Purpose**: Creates a lightweight turn-status snapshot from an open, not-yet-finished turn. It lets incremental update code report that a turn has started or changed without copying every item.

**Data flow**: It reads the pending turn’s ID, status, error, timestamps, and duration → copies those fields into a `ThreadHistoryTurnChange` → returns that snapshot.

**Call relations**: `record_changed_pending_turn` calls this when an active turn is created or updated while change tracking is enabled.

*Call graph*: called by 1 (record_changed_pending_turn).


##### `ThreadHistoryTurnChange::from_turn`  (lines 133–142)

```
fn from_turn(turn: &Turn) -> Self
```

**Purpose**: Creates a lightweight turn-status snapshot from a finished turn. It is used when older turns are updated after they have already left the active slot.

**Data flow**: It reads the finished turn’s ID, status, error, timestamps, and duration → copies those fields into a `ThreadHistoryTurnChange` → returns that snapshot.

**Call relations**: `handle_turn_aborted` and `handle_turn_complete` use this when an event targets a turn already stored in the finished-turn list.

*Call graph*: called by 2 (handle_turn_aborted, handle_turn_complete).


##### `ThreadHistoryChangeAccumulator::push`  (lines 159–169)

```
fn push(&mut self, changes: ThreadHistoryChangeSet)
```

**Purpose**: Adds one event’s changes into a batch accumulator. It keeps the batch tidy by routing removals, item changes, and turn changes through deduping helpers.

**Data flow**: It receives a `ThreadHistoryChangeSet` → processes removed turns first, then changed items, then changed turns → updates the accumulator’s internal lists and lookup tables.

**Call relations**: `handle_rollout_items_with_changes` calls this for each rollout item in a batch. It hands work to `push_removed_turn_id`, `push_item_change`, and `push_turn_change`.

*Call graph*: calls 3 internal fn (push_item_change, push_removed_turn_id, push_turn_change).


##### `ThreadHistoryChangeAccumulator::finish`  (lines 171–177)

```
fn finish(self) -> ThreadHistoryChangeSet
```

**Purpose**: Turns the accumulator’s internal state into the final batch change set. It removes entries that were intentionally blanked out because a later rollback made them obsolete.

**Data flow**: It consumes the accumulator → drops `None` placeholders from item and turn lists → returns a `ThreadHistoryChangeSet` with final changed items, changed turns, and removed turn IDs.

**Call relations**: `handle_rollout_items_with_changes` calls this after all rollout items in the batch have been processed.


##### `ThreadHistoryChangeAccumulator::push_item_change`  (lines 179–189)

```
fn push_item_change(&mut self, change: ThreadHistoryItemChange)
```

**Purpose**: Records the latest snapshot for one changed item while preserving the position of its first change in the batch. This stops repeated updates to the same item from being sent multiple times.

**Data flow**: It receives an item change → builds a key from turn ID and item ID → replaces the earlier snapshot if that key was already seen, or appends it if it is new.

**Call relations**: `ThreadHistoryChangeAccumulator::push` calls this for each changed item produced by a single rollout item.

*Call graph*: called by 1 (push).


##### `ThreadHistoryChangeAccumulator::push_turn_change`  (lines 191–200)

```
fn push_turn_change(&mut self, change: ThreadHistoryTurnChange)
```

**Purpose**: Records the latest metadata snapshot for one turn while keeping first-change ordering. This avoids sending both “started” and “completed” snapshots for the same turn in one batch when only the final state matters.

**Data flow**: It receives a turn change → checks whether that turn ID already has an entry → replaces the old snapshot or appends a new one → updates the index map.

**Call relations**: `ThreadHistoryChangeAccumulator::push` calls this for each changed turn produced by a single rollout item.

*Call graph*: called by 1 (push).


##### `ThreadHistoryChangeAccumulator::push_removed_turn_id`  (lines 202–224)

```
fn push_removed_turn_id(&mut self, turn_id: String)
```

**Purpose**: Records that a turn was removed and clears any earlier item or turn changes for that same turn. This keeps clients from receiving “update this turn” and “delete this turn” at the same time.

**Data flow**: It receives a turn ID → adds it to the removed list if not already present → removes pending turn metadata changes for that ID → removes pending item changes belonging to that turn.

**Call relations**: `ThreadHistoryChangeAccumulator::push` calls this before adding other changes from the same event, so rollback cleanup wins over stale updates.

*Call graph*: called by 1 (push).


##### `ThreadHistoryBuilder::default`  (lines 237–239)

```
fn default() -> Self
```

**Purpose**: Creates a fresh builder using the same setup as `new`. It exists so code can use Rust’s standard default-construction pattern.

**Data flow**: It receives no input → delegates to `ThreadHistoryBuilder::new` → returns an empty builder.

**Call relations**: This is the standard `Default` implementation and is equivalent to calling `new` directly.

*Call graph*: 1 external calls (new).


##### `ThreadHistoryBuilder::new`  (lines 243–252)

```
fn new() -> Self
```

**Purpose**: Creates an empty thread-history builder ready to receive events. This is the starting point for both full replay and live tracking.

**Data flow**: It initializes empty finished turns, no current turn, item numbering at 1, rollout indexes at 0, and no active change set → returns the builder.

**Call relations**: `build_turns_from_rollout_items`, many tests, and other runtime code call this before feeding events into the builder.

*Call graph*: called by 15 (build_turns_from_rollout_items, apply_patch_approval_request_updates_active_turn_snapshot_with_file_change, builds_multiple_turns_with_reasoning_items, changed_rollout_item_reports_new_item_snapshot, changed_rollout_item_reports_streaming_item_mutation, changed_rollout_item_reports_turn_completion_metadata, changed_rollout_item_reports_updated_existing_item_snapshot, changed_rollout_items_dedupe_turn_metadata_snapshots, changed_rollout_items_dedupe_updated_item_snapshots, changed_rollout_items_drop_prior_changes_for_removed_turns (+5 more)); 1 external calls (new).


##### `ThreadHistoryBuilder::reset`  (lines 254–256)

```
fn reset(&mut self)
```

**Purpose**: Clears the builder back to its initial empty state. This lets a long-lived owner reuse the same builder after a thread is cleared or restarted.

**Data flow**: It takes the existing builder → replaces all internal state with a newly constructed builder → leaves no finished or active turn behind.

**Call relations**: Runtime helpers such as `clear_listener` and `track_current_turn_event` call this when they need to discard the current reconstructed history.

*Call graph*: called by 2 (clear_listener, track_current_turn_event); 1 external calls (new).


##### `ThreadHistoryBuilder::finish`  (lines 258–261)

```
fn finish(mut self) -> Vec<Turn>
```

**Purpose**: Completes history construction and returns the final turn list. It makes sure any still-open turn is included if it should be visible.

**Data flow**: It takes ownership of the builder → closes the current turn through `finish_current_turn` → returns the stored `Vec<Turn>`.

**Call relations**: `build_turns_from_rollout_items` calls this after replaying all saved items. It depends on `finish_current_turn` to apply the rules for keeping or dropping an empty implicit turn.

*Call graph*: calls 1 internal fn (finish_current_turn).


##### `ThreadHistoryBuilder::active_turn_snapshot`  (lines 263–268)

```
fn active_turn_snapshot(&self) -> Option<Turn>
```

**Purpose**: Returns a copy of the current turn as it looks right now. If no turn is open, it returns the latest finished turn instead.

**Data flow**: It reads the open pending turn if present, otherwise the last finished turn → clones or converts it into a `Turn` → returns it as an optional value.

**Call relations**: Live display code can call this when it wants the current visible state without finishing the builder.

*Call graph*: called by 1 (active_turn_snapshot).


##### `ThreadHistoryBuilder::turn_snapshot`  (lines 270–276)

```
fn turn_snapshot(&self, turn_id: &str) -> Option<Turn>
```

**Purpose**: Returns a copy of a specific turn by ID. It works whether the turn is still open or already finished.

**Data flow**: It receives a turn ID → checks the current pending turn first → otherwise searches finished turns → returns a cloned `Turn` if found.

**Call relations**: This is a lookup helper for callers that need one turn’s current materialized state instead of the whole history.


##### `ThreadHistoryBuilder::active_turn_position`  (lines 282–290)

```
fn active_turn_position(&self) -> Option<usize>
```

**Purpose**: Reports where the active turn appears in the final turn list. This helps callers place live updates in the same order they will have after replay finishes.

**Data flow**: It inspects whether a current turn exists and how many finished turns exist → returns the index of the current turn, the last finished turn, or nothing if there is no turn at all.

**Call relations**: This helper is used by code that tracks or displays the active turn’s position without forcing the turn to close.


##### `ThreadHistoryBuilder::has_active_turn`  (lines 292–294)

```
fn has_active_turn(&self) -> bool
```

**Purpose**: Answers whether a turn is currently open. This is a simple guard for code that treats live turns differently from finished history.

**Data flow**: It checks whether `current_turn` is `Some` → returns true or false.

**Call relations**: `track_current_turn_event` calls this to decide how to update current-turn state.

*Call graph*: called by 1 (track_current_turn_event).


##### `ThreadHistoryBuilder::active_turn_id_if_explicit`  (lines 296–301)

```
fn active_turn_id_if_explicit(&self) -> Option<String>
```

**Purpose**: Returns the current turn’s ID only if that turn was opened by an explicit turn-start event. This distinguishes modern streams from older implicit grouping behavior.

**Data flow**: It checks the current pending turn → verifies its explicit-open flag → returns the turn ID copy if both conditions hold.

**Call relations**: Callers use this when they must know whether a live turn has a real persisted turn boundary.


##### `ThreadHistoryBuilder::active_turn_start_index`  (lines 303–307)

```
fn active_turn_start_index(&self) -> Option<usize>
```

**Purpose**: Reports which rollout item opened the current turn. This helps resume or rejoin logic know where the active turn began in the saved stream.

**Data flow**: It reads the current pending turn’s `rollout_start_index` → returns that index if a turn is open.

**Call relations**: This is a state-inspection helper for code coordinating rollout replay with live updates.


##### `ThreadHistoryBuilder::handle_event`  (lines 314–378)

```
fn handle_event(&mut self, event: &EventMsg)
```

**Purpose**: Routes one low-level event to the specific handler that knows how to turn it into history. It is the main dispatcher for event replay.

**Data flow**: It receives an `EventMsg` → matches on its variant → calls the matching `handle_*` method or ignores variants that should not affect visible thread history.

**Call relations**: `handle_rollout_item` and live tracking code call this. It hands off to many specialized handlers such as `handle_user_message`, `handle_exec_command_end`, and `handle_turn_complete`.

*Call graph*: calls 40 internal fn (handle_agent_message, handle_agent_reasoning, handle_agent_reasoning_raw_content, handle_apply_patch_approval_request, handle_collab_agent_interaction_begin, handle_collab_agent_interaction_end, handle_collab_agent_spawn_begin, handle_collab_agent_spawn_end, handle_collab_close_begin, handle_collab_close_end (+15 more)); called by 2 (handle_rollout_item, track_current_turn_event).


##### `ThreadHistoryBuilder::handle_rollout_item`  (lines 380–391)

```
fn handle_rollout_item(&mut self, item: &RolloutItem)
```

**Purpose**: Processes one saved rollout item and advances the builder’s replay position. Rollout items may be events, compaction markers, response items, or metadata.

**Data flow**: It updates the current and next rollout indexes → examines the item kind → sends event messages to `handle_event`, compaction markers to `handle_compacted`, hook response items to `handle_response_item`, and ignores metadata-only items.

**Call relations**: `build_turns_from_rollout_items` calls this for full replay. The change-tracking path also wraps this through `handle_rollout_item_with_changes`.

*Call graph*: calls 3 internal fn (handle_compacted, handle_event, handle_response_item).


##### `ThreadHistoryBuilder::handle_event_with_changes`  (lines 395–397)

```
fn handle_event_with_changes(&mut self, event: &EventMsg) -> ThreadHistoryChangeSet
```

**Purpose**: Processes one event and returns only the materialized history changes caused by that event. This is for live clients that want efficient incremental updates.

**Data flow**: It receives an event → starts temporary change collection → runs `handle_event` → returns the collected changed items, changed turns, and removed turns.

**Call relations**: It uses `collect_changes` as the common wrapper for change tracking.

*Call graph*: calls 1 internal fn (collect_changes).


##### `ThreadHistoryBuilder::handle_rollout_item_with_changes`  (lines 401–406)

```
fn handle_rollout_item_with_changes(
        &mut self,
        item: &RolloutItem,
    ) -> ThreadHistoryChangeSet
```

**Purpose**: Processes one saved rollout item and reports the visible history changes it caused. This is the rollout-item version of incremental update handling.

**Data flow**: It receives a rollout item → starts temporary change collection → runs `handle_rollout_item` → returns the collected `ThreadHistoryChangeSet`.

**Call relations**: `handle_rollout_items_with_changes` calls this once per item when building a coalesced batch update.

*Call graph*: calls 1 internal fn (collect_changes); called by 1 (handle_rollout_items_with_changes).


##### `ThreadHistoryBuilder::handle_rollout_items_with_changes`  (lines 411–420)

```
fn handle_rollout_items_with_changes(
        &mut self,
        items: &[RolloutItem],
    ) -> ThreadHistoryChangeSet
```

**Purpose**: Processes several rollout items and returns one cleaned-up batch of changes. Repeated updates to the same item or turn are collapsed to their final state.

**Data flow**: It receives a slice of rollout items → creates a `ThreadHistoryChangeAccumulator` → processes each item with `handle_rollout_item_with_changes` → pushes each result into the accumulator → returns the accumulator’s final change set.

**Call relations**: This is the batch-oriented incremental API. It relies on `ThreadHistoryChangeAccumulator` to deduplicate and remove stale changes.

*Call graph*: calls 1 internal fn (handle_rollout_item_with_changes); 1 external calls (default).


##### `ThreadHistoryBuilder::collect_changes`  (lines 422–427)

```
fn collect_changes(&mut self, handle: impl FnOnce(&mut Self)) -> ThreadHistoryChangeSet
```

**Purpose**: Temporarily turns on change recording while one handler runs. It is the shared wrapper behind the incremental APIs.

**Data flow**: It asserts no change set is already active → installs an empty change set → runs the provided closure against the builder → takes and returns the collected changes.

**Call relations**: `handle_event_with_changes` and `handle_rollout_item_with_changes` both call this so normal handlers do not need separate incremental versions.

*Call graph*: called by 2 (handle_event_with_changes, handle_rollout_item_with_changes); 2 external calls (default, debug_assert!).


##### `ThreadHistoryBuilder::handle_response_item`  (lines 429–453)

```
fn handle_response_item(&mut self, item: &codex_protocol::models::ResponseItem)
```

**Purpose**: Extracts hook-prompt messages from saved response items and adds them to the current turn. Plain user response items are ignored because they are not special hook prompts.

**Data flow**: It receives a response item → keeps only user-role message items → tries to parse hook-prompt content → converts fragments into v2 history fragments → pushes a `HookPrompt` item into the current turn.

**Call relations**: `handle_rollout_item` calls this for `RolloutItem::ResponseItem`. It uses `parse_hook_prompt_message` and then `push_item_in_current_turn`.

*Call graph*: calls 2 internal fn (push_item_in_current_turn, parse_hook_prompt_message); called by 1 (handle_rollout_item).


##### `ThreadHistoryBuilder::handle_user_message`  (lines 455–472)

```
fn handle_user_message(&mut self, payload: &UserMessageEvent)
```

**Purpose**: Adds a user message to history and starts a new implicit turn when needed. It preserves explicit turns so mid-turn steering messages stay in the same turn.

**Data flow**: It receives a user-message event → may close the current implicit turn → generates a new item ID → converts text and images with `build_user_inputs` → pushes a `UserMessage` item.

**Call relations**: `handle_event` calls this for user messages. It uses `finish_current_turn`, `next_item_id`, `build_user_inputs`, and `push_item_in_current_turn`.

*Call graph*: calls 4 internal fn (build_user_inputs, finish_current_turn, next_item_id, push_item_in_current_turn); called by 1 (handle_event).


##### `ThreadHistoryBuilder::handle_agent_message`  (lines 474–491)

```
fn handle_agent_message(
        &mut self,
        text: String,
        phase: Option<MessagePhase>,
        memory_citation: Option<crate::protocol::v2::MemoryCitation>,
    )
```

**Purpose**: Adds an agent-visible message to the current turn. Empty messages are skipped so they do not create blank timeline items.

**Data flow**: It receives text, optional phase, and optional memory citation → returns early if the text is empty → generates an item ID → pushes an `AgentMessage` item.

**Call relations**: `handle_event` calls this when an agent message event arrives.

*Call graph*: calls 2 internal fn (next_item_id, push_item_in_current_turn); called by 1 (handle_event).


##### `ThreadHistoryBuilder::handle_agent_reasoning`  (lines 493–531)

```
fn handle_agent_reasoning(&mut self, payload: &AgentReasoningEvent)
```

**Purpose**: Adds or extends the agent’s reasoning summary. Consecutive reasoning-summary chunks are merged into one item so streamed text appears as one coherent block.

**Data flow**: It receives a reasoning event → ignores empty text → ensures a turn exists → if the last item is reasoning, appends to its summary and records the updated item → otherwise creates a new reasoning item.

**Call relations**: `handle_event` calls this. It uses `ensure_turn` for the active turn, `record_changed_item` for live updates, and `push_item_in_current_turn` for new reasoning items.

*Call graph*: calls 5 internal fn (ensure_turn, is_tracking_changes, next_item_id, push_item_in_current_turn, record_changed_item); called by 1 (handle_event); 2 external calls (new, vec!).


##### `ThreadHistoryBuilder::handle_agent_reasoning_raw_content`  (lines 533–571)

```
fn handle_agent_reasoning_raw_content(&mut self, payload: &AgentReasoningRawContentEvent)
```

**Purpose**: Adds or extends the raw reasoning content for the agent. It mirrors summary handling but writes to the detailed content field.

**Data flow**: It receives raw reasoning text → ignores empty text → ensures a turn exists → appends to the last reasoning item if possible → otherwise creates a new reasoning item containing raw content.

**Call relations**: `handle_event` calls this for raw reasoning events. It shares the same change-recording pattern as `handle_agent_reasoning`.

*Call graph*: calls 5 internal fn (ensure_turn, is_tracking_changes, next_item_id, push_item_in_current_turn, record_changed_item); called by 1 (handle_event); 2 external calls (new, vec!).


##### `ThreadHistoryBuilder::handle_item_started`  (lines 573–601)

```
fn handle_item_started(&mut self, payload: &ItemStartedEvent)
```

**Purpose**: Rebuilds supported lifecycle items when a persisted item-started event appears. At present it only materializes plan and sleep items from these generic lifecycle events.

**Data flow**: It receives an item-started payload → checks the embedded turn item → converts non-empty plans and sleeps into `ThreadItem`s → upserts them into the referenced turn → ignores other item types because they are represented by their own event kinds.

**Call relations**: `handle_event` calls this. It relies on `upsert_item_in_turn_id` so updates land in the explicit turn named by the event.

*Call graph*: calls 2 internal fn (upsert_item_in_turn_id, from); called by 1 (handle_event).


##### `ThreadHistoryBuilder::handle_item_completed`  (lines 603–631)

```
fn handle_item_completed(&mut self, payload: &ItemCompletedEvent)
```

**Purpose**: Rebuilds supported lifecycle items when a persisted item-completed event appears. It keeps completed plan and sleep items visible after replay.

**Data flow**: It receives an item-completed payload → converts non-empty plans and sleeps into `ThreadItem`s → upserts them into the referenced turn → ignores item types handled elsewhere.

**Call relations**: `handle_event` calls this. Like `handle_item_started`, it sends converted items to `upsert_item_in_turn_id`.

*Call graph*: calls 2 internal fn (upsert_item_in_turn_id, from); called by 1 (handle_event).


##### `ThreadHistoryBuilder::handle_web_search_begin`  (lines 633–640)

```
fn handle_web_search_begin(&mut self, payload: &WebSearchBeginEvent)
```

**Purpose**: Shows that a web search has started. It creates a placeholder search item that can later be updated with the final query and action.

**Data flow**: It receives a search-begin event → builds a `WebSearch` item with the call ID, empty query, and no action → upserts it into the current turn.

**Call relations**: `handle_event` calls this. A later `handle_web_search_end` with the same ID replaces the placeholder.

*Call graph*: calls 1 internal fn (upsert_item_in_current_turn); called by 1 (handle_event); 1 external calls (new).


##### `ThreadHistoryBuilder::handle_web_search_end`  (lines 642–649)

```
fn handle_web_search_end(&mut self, payload: &WebSearchEndEvent)
```

**Purpose**: Stores the completed web search details. It updates the placeholder item if one already exists.

**Data flow**: It receives a search-end event → converts the core web search action to the v2 form → builds a complete `WebSearch` item → upserts it into the current turn.

**Call relations**: `handle_event` calls this after search completion events. It pairs naturally with `handle_web_search_begin`.

*Call graph*: calls 2 internal fn (upsert_item_in_current_turn, from); called by 1 (handle_event).


##### `ThreadHistoryBuilder::handle_exec_command_begin`  (lines 651–654)

```
fn handle_exec_command_begin(&mut self, payload: &ExecCommandBeginEvent)
```

**Purpose**: Adds or updates a command-execution item when a shell command starts. This lets the history show running commands.

**Data flow**: It receives a command-begin event → asks an item-builder helper to convert it into a v2 history item → upserts that item into the event’s turn ID.

**Call relations**: `handle_event` calls this. It uses `build_command_execution_begin_item` for conversion and `upsert_item_in_turn_id` for placement.

*Call graph*: calls 2 internal fn (build_command_execution_begin_item, upsert_item_in_turn_id); called by 1 (handle_event).


##### `ThreadHistoryBuilder::handle_exec_command_end`  (lines 656–664)

```
fn handle_exec_command_end(&mut self, payload: &ExecCommandEndEvent)
```

**Purpose**: Adds or updates a command-execution item when a shell command finishes. It uses the event’s turn ID so late command exits are attached to the turn that started them.

**Data flow**: It receives a command-end event → converts it into a complete command item → upserts it into the turn named by the event, even if another turn is currently active.

**Call relations**: `handle_event` calls this. This is important for out-of-order command completion, where a background process may finish after a newer turn has begun.

*Call graph*: calls 2 internal fn (build_command_execution_end_item, upsert_item_in_turn_id); called by 1 (handle_event).


##### `ThreadHistoryBuilder::handle_guardian_assessment`  (lines 666–683)

```
fn handle_guardian_assessment(&mut self, payload: &GuardianAssessmentEvent)
```

**Purpose**: Turns safety-review events into visible command items when a command is being reviewed, declined, aborted, or timed out. Approved reviews are not shown as separate items.

**Data flow**: It receives a guardian assessment → maps the guardian status to a command status → asks a builder helper for the item → inserts it into the current turn or the explicit turn ID if provided.

**Call relations**: `handle_event` calls this for guardian assessment events. It uses `build_item_from_guardian_event` and the upsert helpers.

*Call graph*: calls 3 internal fn (build_item_from_guardian_event, upsert_item_in_current_turn, upsert_item_in_turn_id); called by 1 (handle_event).


##### `ThreadHistoryBuilder::handle_apply_patch_approval_request`  (lines 685–692)

```
fn handle_apply_patch_approval_request(&mut self, payload: &ApplyPatchApprovalRequestEvent)
```

**Purpose**: Shows a file-change item when a patch needs approval. This gives the client a visible record of the proposed edit.

**Data flow**: It receives an approval request → converts it into a file-change item → upserts it into either the current turn or the turn ID carried by the payload.

**Call relations**: `handle_event` calls this. It uses `build_file_change_approval_request_item` for the conversion.

*Call graph*: calls 3 internal fn (build_file_change_approval_request_item, upsert_item_in_current_turn, upsert_item_in_turn_id); called by 1 (handle_event).


##### `ThreadHistoryBuilder::handle_patch_apply_begin`  (lines 694–701)

```
fn handle_patch_apply_begin(&mut self, payload: &PatchApplyBeginEvent)
```

**Purpose**: Shows that a file patch has started applying. It creates or updates the file-change item as in progress.

**Data flow**: It receives a patch-begin event → converts the patch details into a v2 file-change item → inserts it into the current or named turn.

**Call relations**: `handle_event` calls this. It pairs with `handle_patch_apply_end`, which later records the final outcome.

*Call graph*: calls 3 internal fn (build_file_change_begin_item, upsert_item_in_current_turn, upsert_item_in_turn_id); called by 1 (handle_event).


##### `ThreadHistoryBuilder::handle_patch_apply_end`  (lines 703–710)

```
fn handle_patch_apply_end(&mut self, payload: &PatchApplyEndEvent)
```

**Purpose**: Stores the final result of applying a file patch. This updates the file-change item with success, failure, or declined status.

**Data flow**: It receives a patch-end event → builds the final file-change item → upserts it into the current or named turn.

**Call relations**: `handle_event` calls this after patch completion. It uses `build_file_change_end_item` and the upsert helpers.

*Call graph*: calls 3 internal fn (build_file_change_end_item, upsert_item_in_current_turn, upsert_item_in_turn_id); called by 1 (handle_event).


##### `ThreadHistoryBuilder::handle_dynamic_tool_call_request`  (lines 712–731)

```
fn handle_dynamic_tool_call_request(
        &mut self,
        payload: &codex_protocol::dynamic_tools::DynamicToolCallRequest,
    )
```

**Purpose**: Adds a dynamic-tool call when the agent requests a tool that is described at runtime. The initial item is marked in progress.

**Data flow**: It receives a dynamic tool request → builds a `DynamicToolCall` item with namespace, tool name, arguments, and in-progress status → inserts it into the current or named turn.

**Call relations**: `handle_event` calls this. `handle_dynamic_tool_call_response` later replaces the item with the completed result.

*Call graph*: calls 2 internal fn (upsert_item_in_current_turn, upsert_item_in_turn_id); called by 1 (handle_event).


##### `ThreadHistoryBuilder::handle_dynamic_tool_call_response`  (lines 733–755)

```
fn handle_dynamic_tool_call_response(&mut self, payload: &DynamicToolCallResponseEvent)
```

**Purpose**: Stores the result of a dynamic-tool call. It records success or failure, returned content, and duration.

**Data flow**: It receives a dynamic tool response → maps success to completed or failed status → converts duration to milliseconds if possible → converts output content items → upserts the final `DynamicToolCall` item into the current or named turn.

**Call relations**: `handle_event` calls this. It depends on `convert_dynamic_tool_content_items` for output conversion.

*Call graph*: calls 3 internal fn (upsert_item_in_current_turn, upsert_item_in_turn_id, convert_dynamic_tool_content_items); called by 1 (handle_event); 1 external calls (try_from).


##### `ThreadHistoryBuilder::handle_mcp_tool_call_begin`  (lines 757–775)

```
fn handle_mcp_tool_call_begin(&mut self, payload: &McpToolCallBeginEvent)
```

**Purpose**: Adds an in-progress MCP tool call. MCP means Model Context Protocol, a way for the agent to call external tools or servers.

**Data flow**: It receives an MCP begin event → extracts server, tool, arguments, resource URI, and plugin ID → builds an in-progress `McpToolCall` item → upserts it into the current turn.

**Call relations**: `handle_event` calls this. `handle_mcp_tool_call_end` later updates the same call ID with the result.

*Call graph*: calls 1 internal fn (upsert_item_in_current_turn); called by 1 (handle_event).


##### `ThreadHistoryBuilder::handle_mcp_tool_call_end`  (lines 777–817)

```
fn handle_mcp_tool_call_end(&mut self, payload: &McpToolCallEndEvent)
```

**Purpose**: Stores the completed MCP tool call, including either its result or its error message. It also records how long the call took.

**Data flow**: It receives an MCP end event → decides completed versus failed → converts duration to milliseconds → splits the result into either a result object or an error object → upserts the final `McpToolCall` item.

**Call relations**: `handle_event` calls this after MCP completion events. It updates items first created by `handle_mcp_tool_call_begin`, or creates the completed item directly during replay.

*Call graph*: calls 2 internal fn (upsert_item_in_current_turn, is_success); called by 1 (handle_event); 2 external calls (new, try_from).


##### `ThreadHistoryBuilder::handle_view_image_tool_call`  (lines 819–825)

```
fn handle_view_image_tool_call(&mut self, payload: &ViewImageToolCallEvent)
```

**Purpose**: Adds a history item when the agent views an image file. This keeps image-inspection actions visible in the thread.

**Data flow**: It receives a view-image event → builds an `ImageView` item with the call ID and path → upserts it into the current turn.

**Call relations**: `handle_event` calls this for image-view tool events.

*Call graph*: calls 1 internal fn (upsert_item_in_current_turn); called by 1 (handle_event).


##### `ThreadHistoryBuilder::handle_image_generation_begin`  (lines 827–836)

```
fn handle_image_generation_begin(&mut self, payload: &ImageGenerationBeginEvent)
```

**Purpose**: Shows that image generation has started. It creates a placeholder item before the generated result is available.

**Data flow**: It receives an image-generation begin event → builds an `ImageGeneration` item with blank result fields → upserts it into the current turn.

**Call relations**: `handle_event` calls this. `handle_image_generation_end` later fills in status, prompt, result, and saved path.

*Call graph*: calls 1 internal fn (upsert_item_in_current_turn); called by 1 (handle_event); 1 external calls (new).


##### `ThreadHistoryBuilder::handle_image_generation_end`  (lines 838–847)

```
fn handle_image_generation_end(&mut self, payload: &ImageGenerationEndEvent)
```

**Purpose**: Stores the final image-generation result. It records status, revised prompt, generated data, and the saved file path if present.

**Data flow**: It receives an image-generation end event → builds a complete `ImageGeneration` item → upserts it into the current turn.

**Call relations**: `handle_event` calls this after image generation completes, updating the placeholder from `handle_image_generation_begin` if present.

*Call graph*: calls 1 internal fn (upsert_item_in_current_turn); called by 1 (handle_event).


##### `ThreadHistoryBuilder::handle_collab_agent_spawn_begin`  (lines 849–865)

```
fn handle_collab_agent_spawn_begin(
        &mut self,
        payload: &codex_protocol::protocol::CollabAgentSpawnBeginEvent,
    )
```

**Purpose**: Adds an in-progress collaborative-agent spawn call. This shows that one agent is starting another agent.

**Data flow**: It receives a spawn-begin event → builds a `CollabAgentToolCall` for the spawn operation with prompt, model, reasoning effort, and sender thread ID → upserts it into the current turn.

**Call relations**: `handle_event` calls this. `handle_collab_agent_spawn_end` later records whether the new agent was created.

*Call graph*: calls 1 internal fn (upsert_item_in_current_turn); called by 1 (handle_event); 2 external calls (new, new).


##### `ThreadHistoryBuilder::handle_collab_agent_spawn_end`  (lines 867–899)

```
fn handle_collab_agent_spawn_end(
        &mut self,
        payload: &codex_protocol::protocol::CollabAgentSpawnEndEvent,
    )
```

**Purpose**: Stores the result of spawning a collaborative agent. It records the new thread ID and agent state when creation succeeds.

**Data flow**: It receives a spawn-end event → decides completed or failed based on status and whether a receiver thread exists → builds receiver IDs and agent-state map → upserts the final spawn tool-call item.

**Call relations**: `handle_event` calls this. It converts core agent status into v2 `CollabAgentState` for display.

*Call graph*: calls 2 internal fn (upsert_item_in_current_turn, from); called by 1 (handle_event); 3 external calls (new, new, vec!).


##### `ThreadHistoryBuilder::handle_collab_agent_interaction_begin`  (lines 901–917)

```
fn handle_collab_agent_interaction_begin(
        &mut self,
        payload: &codex_protocol::protocol::CollabAgentInteractionBeginEvent,
    )
```

**Purpose**: Adds an in-progress send-input call to another agent. This represents one agent asking another agent to do something.

**Data flow**: It receives an interaction-begin event → builds a `CollabAgentToolCall` with the sender, receiver, and prompt → marks it in progress → upserts it into the current turn.

**Call relations**: `handle_event` calls this. `handle_collab_agent_interaction_end` later records the receiver’s state.

*Call graph*: calls 1 internal fn (upsert_item_in_current_turn); called by 1 (handle_event); 2 external calls (new, vec!).


##### `ThreadHistoryBuilder::handle_collab_agent_interaction_end`  (lines 919–940)

```
fn handle_collab_agent_interaction_end(
        &mut self,
        payload: &codex_protocol::protocol::CollabAgentInteractionEndEvent,
    )
```

**Purpose**: Stores the result of sending input to another agent. It treats missing or errored receivers as failed and other statuses as a completed send operation.

**Data flow**: It receives an interaction-end event → maps the receiver status to tool-call status and agent state → builds the final `CollabAgentToolCall` → upserts it into the current turn.

**Call relations**: `handle_event` calls this. It complements `handle_collab_agent_interaction_begin`.

*Call graph*: calls 2 internal fn (upsert_item_in_current_turn, from); called by 1 (handle_event); 1 external calls (vec!).


##### `ThreadHistoryBuilder::handle_sub_agent_activity`  (lines 942–952)

```
fn handle_sub_agent_activity(
        &mut self,
        payload: &codex_protocol::protocol::SubAgentActivityEvent,
    )
```

**Purpose**: Adds a visible note that a sub-agent performed some activity. This lets the parent thread show related agent movement.

**Data flow**: It receives a sub-agent activity event → copies the event ID, kind, agent thread ID, and agent path → upserts a `SubAgentActivity` item into the current turn.

**Call relations**: `handle_event` calls this for sub-agent activity events.

*Call graph*: calls 1 internal fn (upsert_item_in_current_turn); called by 1 (handle_event); 1 external calls (from).


##### `ThreadHistoryBuilder::handle_collab_waiting_begin`  (lines 954–974)

```
fn handle_collab_waiting_begin(
        &mut self,
        payload: &codex_protocol::protocol::CollabWaitingBeginEvent,
    )
```

**Purpose**: Adds an in-progress wait call for collaborative agents. It shows that this thread is waiting on one or more other agent threads.

**Data flow**: It receives a waiting-begin event → converts receiver thread IDs to strings → builds an in-progress `CollabAgentToolCall` with tool `Wait` → upserts it into the current turn.

**Call relations**: `handle_event` calls this. `handle_collab_waiting_end` later records the final states of the waited-on agents.

*Call graph*: calls 1 internal fn (upsert_item_in_current_turn); called by 1 (handle_event); 1 external calls (new).


##### `ThreadHistoryBuilder::handle_collab_waiting_end`  (lines 976–1008)

```
fn handle_collab_waiting_end(
        &mut self,
        payload: &codex_protocol::protocol::CollabWaitingEndEvent,
    )
```

**Purpose**: Stores the result of waiting on collaborative agents. The wait is failed if any waited-on agent errored or was not found.

**Data flow**: It receives a waiting-end event → checks all agent statuses → sorts receiver IDs for stable output → converts statuses into an agent-state map → upserts the completed wait item.

**Call relations**: `handle_event` calls this after wait completion events.

*Call graph*: calls 1 internal fn (upsert_item_in_current_turn); called by 1 (handle_event).


##### `ThreadHistoryBuilder::handle_collab_close_begin`  (lines 1010–1026)

```
fn handle_collab_close_begin(
        &mut self,
        payload: &codex_protocol::protocol::CollabCloseBeginEvent,
    )
```

**Purpose**: Adds an in-progress close-agent call. This shows that one thread is asking another agent thread to close.

**Data flow**: It receives a close-begin event → builds a `CollabAgentToolCall` with tool `CloseAgent`, sender, and receiver → marks it in progress → upserts it into the current turn.

**Call relations**: `handle_event` calls this. `handle_collab_close_end` later records the outcome.

*Call graph*: calls 1 internal fn (upsert_item_in_current_turn); called by 1 (handle_event); 2 external calls (new, vec!).


##### `ThreadHistoryBuilder::handle_collab_close_end`  (lines 1028–1051)

```
fn handle_collab_close_end(&mut self, payload: &codex_protocol::protocol::CollabCloseEndEvent)
```

**Purpose**: Stores the result of closing a collaborative agent. It records whether the close operation succeeded and the receiver’s final state.

**Data flow**: It receives a close-end event → maps errored or missing receivers to failed, otherwise completed → builds an agent-state map → upserts the final close item.

**Call relations**: `handle_event` calls this after close completion events.

*Call graph*: calls 2 internal fn (upsert_item_in_current_turn, from); called by 1 (handle_event); 1 external calls (vec!).


##### `ThreadHistoryBuilder::handle_collab_resume_begin`  (lines 1053–1069)

```
fn handle_collab_resume_begin(
        &mut self,
        payload: &codex_protocol::protocol::CollabResumeBeginEvent,
    )
```

**Purpose**: Adds an in-progress resume-agent call. This shows that one thread is trying to resume another agent thread.

**Data flow**: It receives a resume-begin event → builds a `CollabAgentToolCall` with tool `ResumeAgent`, sender, and receiver → marks it in progress → upserts it into the current turn.

**Call relations**: `handle_event` calls this. `handle_collab_resume_end` later records the result.

*Call graph*: calls 1 internal fn (upsert_item_in_current_turn); called by 1 (handle_event); 2 external calls (new, vec!).


##### `ThreadHistoryBuilder::handle_collab_resume_end`  (lines 1071–1097)

```
fn handle_collab_resume_end(
        &mut self,
        payload: &codex_protocol::protocol::CollabResumeEndEvent,
    )
```

**Purpose**: Stores the result of resuming a collaborative agent. It records the receiver’s state after the resume request.

**Data flow**: It receives a resume-end event → maps failure statuses to failed and others to completed → builds a receiver state map → upserts the final resume item.

**Call relations**: `handle_event` calls this for collaborative-agent resume completion events.

*Call graph*: calls 2 internal fn (upsert_item_in_current_turn, from); called by 1 (handle_event); 1 external calls (vec!).


##### `ThreadHistoryBuilder::handle_context_compacted`  (lines 1099–1102)

```
fn handle_context_compacted(&mut self, _payload: &ContextCompactedEvent)
```

**Purpose**: Adds a visible marker that the conversation context was compacted. Compaction means old context was summarized or compressed to fit within limits.

**Data flow**: It receives a compaction event → generates a new item ID → pushes a `ContextCompaction` item into the current turn.

**Call relations**: `handle_event` calls this for `ContextCompacted` events. Separate `handle_compacted` handles persisted compaction records that do not render an item.

*Call graph*: calls 2 internal fn (next_item_id, push_item_in_current_turn); called by 1 (handle_event).


##### `ThreadHistoryBuilder::handle_entered_review_mode`  (lines 1104–1111)

```
fn handle_entered_review_mode(&mut self, payload: &codex_protocol::protocol::ReviewRequest)
```

**Purpose**: Adds a visible marker when the thread enters review mode. It uses a user-facing hint if one was supplied.

**Data flow**: It receives a review request → picks the provided hint or a default review message → generates an item ID → pushes an `EnteredReviewMode` item.

**Call relations**: `handle_event` calls this when review mode starts.

*Call graph*: calls 2 internal fn (next_item_id, push_item_in_current_turn); called by 1 (handle_event).


##### `ThreadHistoryBuilder::handle_exited_review_mode`  (lines 1113–1124)

```
fn handle_exited_review_mode(
        &mut self,
        payload: &codex_protocol::protocol::ExitedReviewModeEvent,
    )
```

**Purpose**: Adds a visible marker when review mode ends. It records the reviewer’s explanation or a fallback message if no usable output exists.

**Data flow**: It receives an exited-review event → renders the review output text if present → otherwise uses the fallback string → generates an item ID → pushes an `ExitedReviewMode` item.

**Call relations**: `handle_event` calls this. It uses `render_review_output_text` to turn structured review output into display text.

*Call graph*: calls 2 internal fn (next_item_id, push_item_in_current_turn); called by 1 (handle_event).


##### `ThreadHistoryBuilder::handle_error`  (lines 1126–1145)

```
fn handle_error(&mut self, payload: &ErrorEvent)
```

**Purpose**: Marks the current turn as failed when an error should affect turn status. Errors that are request-level or unrelated to the active turn are ignored for turn history.

**Data flow**: It receives an error event → asks whether the error affects turn status → if a current turn exists, sets its status to failed and stores error details → records a changed turn when change tracking is active.

**Call relations**: `handle_event` calls this for error events. It uses `affects_turn_status` from the error payload and `record_changed_turn` for incremental updates.

*Call graph*: calls 3 internal fn (is_tracking_changes, record_changed_turn, affects_turn_status); called by 1 (handle_event).


##### `ThreadHistoryBuilder::handle_turn_aborted`  (lines 1147–1177)

```
fn handle_turn_aborted(&mut self, payload: &TurnAbortedEvent)
```

**Purpose**: Marks a turn as interrupted when an abort event arrives. It prefers the turn ID in the event so late aborts do not accidentally interrupt the wrong active turn.

**Data flow**: It receives an abort payload → tries to update the matching current turn → otherwise tries finished turns → otherwise falls back to the active turn if no usable ID exists → records the changed turn.

**Call relations**: `handle_event` calls this. It uses `ThreadHistoryTurnChange::from_turn` when updating a finished turn.

*Call graph*: calls 2 internal fn (record_changed_turn, from_turn); called by 1 (handle_event).


##### `ThreadHistoryBuilder::handle_turn_started`  (lines 1179–1188)

```
fn handle_turn_started(&mut self, payload: &TurnStartedEvent)
```

**Purpose**: Starts a new explicit turn. Explicit turns are preserved even if they later contain no renderable items.

**Data flow**: It receives a turn-start event → closes any current turn → creates a new pending turn with the provided ID, in-progress status, and start time → marks it explicitly opened → records a changed turn → stores it as current.

**Call relations**: `handle_event` calls this for turn-start events. It uses `finish_current_turn`, `new_turn`, and `record_changed_pending_turn`.

*Call graph*: calls 3 internal fn (finish_current_turn, new_turn, record_changed_pending_turn); called by 1 (handle_event).


##### `ThreadHistoryBuilder::handle_turn_complete`  (lines 1190–1233)

```
fn handle_turn_complete(&mut self, payload: &TurnCompleteEvent)
```

**Purpose**: Marks a turn as completed and closes it when appropriate. It is careful not to close the active turn if the completion event belongs to an older turn.

**Data flow**: It receives a completion event → updates the matching current turn and closes it, or updates a matching finished turn, or falls back to the active turn if the event cannot be matched → preserves failed status if the turn had already failed.

**Call relations**: `handle_event` calls this. It uses `finish_current_turn` for the active matching turn and `ThreadHistoryTurnChange::from_turn` for already finished turns.

*Call graph*: calls 3 internal fn (finish_current_turn, record_changed_turn, from_turn); called by 1 (handle_event); 1 external calls (matches!).


##### `ThreadHistoryBuilder::handle_compacted`  (lines 1240–1242)

```
fn handle_compacted(&mut self, _payload: &CompactedItem)
```

**Purpose**: Notes that the current turn contains a persisted compaction marker, even if that marker does not render as an item. This prevents certain legacy compaction-only turns from disappearing.

**Data flow**: It receives a compacted rollout payload → ensures a turn exists → sets the pending turn’s `saw_compaction` flag.

**Call relations**: `handle_rollout_item` calls this for `RolloutItem::Compacted`. `finish_current_turn` later uses the flag to decide whether to keep an otherwise empty implicit turn.

*Call graph*: calls 1 internal fn (ensure_turn); called by 1 (handle_rollout_item).


##### `ThreadHistoryBuilder::handle_thread_rollback`  (lines 1244–1268)

```
fn handle_thread_rollback(&mut self, payload: &ThreadRolledBackEvent)
```

**Purpose**: Removes the most recent turns after a rollback event. Rollback means the thread history was intentionally rewound.

**Data flow**: It receives a rollback payload with a number of turns → closes the current turn → computes which turn IDs will be removed → records those removals for incremental updates → truncates or clears finished turns → resets the next generated item ID based on remaining items.

**Call relations**: `handle_event` calls this. It relies on `finish_current_turn` before removal so the active turn is included in rollback calculations.

*Call graph*: calls 2 internal fn (finish_current_turn, record_removed_turn_ids); called by 1 (handle_event); 3 external calls (new, try_from, try_from).


##### `ThreadHistoryBuilder::finish_current_turn`  (lines 1270–1277)

```
fn finish_current_turn(&mut self)
```

**Purpose**: Moves the current pending turn into the finished-turn list if it should be kept. Empty implicit turns are dropped unless they represent compaction.

**Data flow**: It takes the current pending turn if present → checks whether it has items, was explicitly opened, or saw compaction → drops it if none are true → otherwise converts it into a `Turn` and appends it.

**Call relations**: `finish`, `handle_user_message`, `handle_turn_started`, `handle_turn_complete`, and `handle_thread_rollback` call this whenever the current turn boundary changes.

*Call graph*: called by 5 (finish, handle_thread_rollback, handle_turn_complete, handle_turn_started, handle_user_message); 1 external calls (from).


##### `ThreadHistoryBuilder::new_turn`  (lines 1279–1299)

```
fn new_turn(&mut self, id: Option<String>) -> PendingTurn
```

**Purpose**: Creates a fresh pending turn with the right ID and default metadata. It supports both explicit turn IDs and legacy implicit IDs.

**Data flow**: It receives an optional ID → uses it if present → otherwise generates a UUID before replay begins or a rollout-based ID during replay → initializes empty items, completed status, no timestamps, and bookkeeping flags.

**Call relations**: `ensure_turn` uses this for implicit turns, and `handle_turn_started` uses it for explicit turns.

*Call graph*: called by 2 (ensure_turn, handle_turn_started); 1 external calls (new).


##### `ThreadHistoryBuilder::ensure_turn`  (lines 1301–1313)

```
fn ensure_turn(&mut self) -> &mut PendingTurn
```

**Purpose**: Guarantees that there is a current pending turn and returns it. This lets item handlers add content without first checking whether a turn exists.

**Data flow**: It checks whether `current_turn` is missing → creates a new implicit turn and records its metadata if needed → returns a mutable reference to the current turn.

**Call relations**: Many item handlers reach this through `push_item_in_current_turn` or `upsert_item_in_current_turn`. `handle_compacted` and reasoning handlers call it directly.

*Call graph*: calls 2 internal fn (new_turn, record_changed_pending_turn); called by 5 (handle_agent_reasoning, handle_agent_reasoning_raw_content, handle_compacted, push_item_in_current_turn, upsert_item_in_current_turn); 1 external calls (unreachable!).


##### `ThreadHistoryBuilder::push_item_in_current_turn`  (lines 1315–1326)

```
fn push_item_in_current_turn(&mut self, item: ThreadItem)
```

**Purpose**: Appends a new item to the current turn. It is used when an event always creates a fresh visible item rather than updating an existing one.

**Data flow**: It receives a `ThreadItem` → ensures a turn exists → appends the item to that turn → records the item snapshot if change tracking is active.

**Call relations**: User messages, agent messages, review markers, hook prompts, context compaction, and new reasoning items use this helper.

*Call graph*: calls 3 internal fn (ensure_turn, is_tracking_changes, record_changed_item); called by 8 (handle_agent_message, handle_agent_reasoning, handle_agent_reasoning_raw_content, handle_context_compacted, handle_entered_review_mode, handle_exited_review_mode, handle_response_item, handle_user_message).


##### `ThreadHistoryBuilder::upsert_item_in_turn_id`  (lines 1328–1358)

```
fn upsert_item_in_turn_id(&mut self, turn_id: &str, item: ThreadItem)
```

**Purpose**: Inserts or replaces an item in a specific turn by ID. This is crucial for events that may arrive late but still belong to an earlier turn.

**Data flow**: It receives a turn ID and item → looks for a matching current turn, then a matching finished turn → replaces an existing item with the same item ID or appends it → records the changed item if tracking → logs a warning and drops the item if the turn ID is unknown.

**Call relations**: Command, patch, dynamic tool, and generic lifecycle handlers call this when their payload carries an explicit turn ID.

*Call graph*: calls 3 internal fn (is_tracking_changes, record_changed_item, upsert_turn_item); called by 10 (handle_apply_patch_approval_request, handle_dynamic_tool_call_request, handle_dynamic_tool_call_response, handle_exec_command_begin, handle_exec_command_end, handle_guardian_assessment, handle_item_completed, handle_item_started, handle_patch_apply_begin, handle_patch_apply_end); 1 external calls (warn!).


##### `ThreadHistoryBuilder::upsert_item_in_current_turn`  (lines 1360–1370)

```
fn upsert_item_in_current_turn(&mut self, item: ThreadItem)
```

**Purpose**: Inserts or replaces an item in the current turn. It is used for events whose correct turn is simply the active one.

**Data flow**: It receives a `ThreadItem` → ensures a current turn exists → replaces any item with the same ID or appends it → records the changed item if change tracking is active.

**Call relations**: Most tool begin/end handlers and collaborative-agent handlers call this. It delegates item replacement to `upsert_turn_item`.

*Call graph*: calls 4 internal fn (ensure_turn, is_tracking_changes, record_changed_item, upsert_turn_item); called by 24 (handle_apply_patch_approval_request, handle_collab_agent_interaction_begin, handle_collab_agent_interaction_end, handle_collab_agent_spawn_begin, handle_collab_agent_spawn_end, handle_collab_close_begin, handle_collab_close_end, handle_collab_resume_begin, handle_collab_resume_end, handle_collab_waiting_begin (+14 more)).


##### `ThreadHistoryBuilder::is_tracking_changes`  (lines 1372–1374)

```
fn is_tracking_changes(&self) -> bool
```

**Purpose**: Reports whether the builder is currently collecting incremental changes. Handlers use this to avoid extra cloning when no one asked for change details.

**Data flow**: It checks whether `active_change_set` is present → returns true if change collection is active.

**Call relations**: Several handlers and record helpers call this inside `collect_changes`-driven flows.

*Call graph*: called by 7 (handle_agent_reasoning, handle_agent_reasoning_raw_content, handle_error, push_item_in_current_turn, record_changed_pending_turn, upsert_item_in_current_turn, upsert_item_in_turn_id).


##### `ThreadHistoryBuilder::record_changed_item`  (lines 1376–1382)

```
fn record_changed_item(&mut self, turn_id: String, item: ThreadItem)
```

**Purpose**: Adds one changed item snapshot to the active change set. It does nothing when change tracking is not active.

**Data flow**: It receives a turn ID and item → if an active change set exists, appends a `ThreadHistoryItemChange` containing both.

**Call relations**: Item push and upsert helpers call this, and reasoning handlers call it when they mutate an existing reasoning item.

*Call graph*: called by 5 (handle_agent_reasoning, handle_agent_reasoning_raw_content, push_item_in_current_turn, upsert_item_in_current_turn, upsert_item_in_turn_id).


##### `ThreadHistoryBuilder::record_changed_pending_turn`  (lines 1384–1388)

```
fn record_changed_pending_turn(&mut self, turn: &PendingTurn)
```

**Purpose**: Records the current metadata snapshot for a pending turn when incremental tracking is active.

**Data flow**: It receives a pending turn → checks whether change tracking is active → converts it with `ThreadHistoryTurnChange::from_pending_turn` → stores it through `record_changed_turn`.

**Call relations**: `ensure_turn` calls this for newly created implicit turns, and `handle_turn_started` calls it for explicit turns.

*Call graph*: calls 3 internal fn (is_tracking_changes, record_changed_turn, from_pending_turn); called by 2 (ensure_turn, handle_turn_started).


##### `ThreadHistoryBuilder::record_changed_turn`  (lines 1390–1394)

```
fn record_changed_turn(&mut self, turn: ThreadHistoryTurnChange)
```

**Purpose**: Adds one turn metadata snapshot to the active change set. It is the common sink for status, error, and timing updates.

**Data flow**: It receives a `ThreadHistoryTurnChange` → if an active change set exists, appends it to `changed_turns`.

**Call relations**: Turn start, completion, abort, error, and pending-turn recording paths call this.

*Call graph*: called by 4 (handle_error, handle_turn_aborted, handle_turn_complete, record_changed_pending_turn).


##### `ThreadHistoryBuilder::record_removed_turn_ids`  (lines 1396–1400)

```
fn record_removed_turn_ids(&mut self, removed_turn_ids: Vec<String>)
```

**Purpose**: Adds removed turn IDs to the active change set. This tells clients which turns to delete after rollback.

**Data flow**: It receives a list of turn IDs → if an active change set exists, extends its `removed_turn_ids` list.

**Call relations**: `handle_thread_rollback` calls this after deciding which turns rollback removed.

*Call graph*: called by 1 (handle_thread_rollback).


##### `ThreadHistoryBuilder::next_item_id`  (lines 1402–1406)

```
fn next_item_id(&mut self) -> String
```

**Purpose**: Generates the next synthetic item ID for history items that do not already have one. IDs are simple sequential strings like `item-1`.

**Data flow**: It formats the current item counter into an ID string → increments the counter → returns the ID.

**Call relations**: Handlers for user messages, agent messages, reasoning, context compaction, and review markers call this before pushing new items.

*Call graph*: called by 7 (handle_agent_message, handle_agent_reasoning, handle_agent_reasoning_raw_content, handle_context_compacted, handle_entered_review_mode, handle_exited_review_mode, handle_user_message); 1 external calls (format!).


##### `ThreadHistoryBuilder::build_user_inputs`  (lines 1408–1436)

```
fn build_user_inputs(&self, payload: &UserMessageEvent) -> Vec<UserInput>
```

**Purpose**: Converts a user-message event into the list of text and image inputs shown in history. It preserves image-detail metadata for both remote and local images.

**Data flow**: It receives a user-message payload → adds a text input if the message is not blank → adds remote image inputs with matching details → adds local image inputs with matching details → returns the ordered input list.

**Call relations**: `handle_user_message` calls this before creating a `UserMessage` history item.

*Call graph*: called by 1 (handle_user_message); 1 external calls (new).


##### `render_review_output_text`  (lines 1441–1448)

```
fn render_review_output_text(output: &ReviewOutputEvent) -> String
```

**Purpose**: Turns review output into plain display text. It provides a fallback when the reviewer produced no explanation.

**Data flow**: It receives a review output event → trims the overall explanation → returns the explanation if non-empty, otherwise returns the fallback message.

**Call relations**: `handle_exited_review_mode` uses this when review mode ends with structured review output.


##### `convert_dynamic_tool_content_items`  (lines 1450–1465)

```
fn convert_dynamic_tool_content_items(
    items: &[codex_protocol::dynamic_tools::DynamicToolCallOutputContentItem],
) -> Vec<DynamicToolCallOutputContentItem>
```

**Purpose**: Converts dynamic-tool output content from the core protocol type into the app-server v2 protocol type. This keeps the history model independent from the raw event model.

**Data flow**: It receives a slice of core dynamic-tool content items → maps each text or image item to the matching v2 variant → returns the converted vector.

**Call relations**: `handle_dynamic_tool_call_response` calls this while building the final dynamic-tool history item.

*Call graph*: called by 1 (handle_dynamic_tool_call_response); 1 external calls (iter).


##### `upsert_turn_item`  (lines 1467–1478)

```
fn upsert_turn_item(items: &mut Vec<ThreadItem>, item: ThreadItem) -> &ThreadItem
```

**Purpose**: Replaces an existing turn item with the same ID or appends it if it is new. This supports begin/end events that update one visible item over time.

**Data flow**: It receives a mutable item list and a new item → searches for an existing item with the same ID → replaces and returns it if found → otherwise appends and returns the inserted item.

**Call relations**: `upsert_item_in_current_turn` and `upsert_item_in_turn_id` use this as their shared item-replacement helper.

*Call graph*: called by 2 (upsert_item_in_current_turn, upsert_item_in_turn_id).


##### `PendingTurn::opened_explicitly`  (lines 1499–1502)

```
fn opened_explicitly(mut self) -> Self
```

**Purpose**: Marks a pending turn as coming from an explicit turn-start event. Explicit turns are kept even if they contain no visible items.

**Data flow**: It receives a pending turn by value → sets its `opened_explicitly` flag → returns the modified turn.

**Call relations**: `handle_turn_started` uses this in its builder-style setup of a new pending turn.


##### `PendingTurn::with_status`  (lines 1504–1507)

```
fn with_status(mut self, status: TurnStatus) -> Self
```

**Purpose**: Sets the initial status of a pending turn in a builder-style chain. This keeps turn creation readable.

**Data flow**: It receives a pending turn and a status → stores the status → returns the modified turn.

**Call relations**: `handle_turn_started` uses this to mark a newly started explicit turn as in progress.


##### `PendingTurn::with_started_at`  (lines 1509–1512)

```
fn with_started_at(mut self, started_at: Option<i64>) -> Self
```

**Purpose**: Sets the start timestamp of a pending turn in a builder-style chain. The timestamp is optional because older events may not have one.

**Data flow**: It receives a pending turn and optional start time → stores it → returns the modified turn.

**Call relations**: `handle_turn_started` uses this while building the new active turn from a turn-start event.


##### `Turn::from`  (lines 1531–1542)

```
fn from(value: &PendingTurn) -> Self
```

**Purpose**: Converts a pending turn into the public v2 `Turn` shape. This is the final materialized form sent to clients.

**Data flow**: It receives a pending turn or a reference to one → copies or moves ID, items, status, error, and timestamps → sets the item view to full → returns a `Turn`.

**Call relations**: `finish_current_turn` uses the owned conversion when closing a turn, and snapshot methods use the borrowed conversion to preview an open turn.


##### `tests::builds_multiple_turns_with_reasoning_items`  (lines 1591–1697)

```
fn builds_multiple_turns_with_reasoning_items()
```

**Purpose**: Checks that legacy implicit user messages split history into separate turns and that reasoning summary/raw content merge into one reasoning item.

**Data flow**: It builds a sequence of user, agent, and reasoning events → feeds them through a builder → asserts the resulting turns, item IDs, and item contents.

**Call relations**: This test exercises `ThreadHistoryBuilder::new`, event handling, and finalization for basic conversation replay.

*Call graph*: calls 1 internal fn (new); 4 external calls (assert!, assert_eq!, assert_ne!, vec!).


##### `tests::rebuilds_user_message_image_details_from_legacy_events`  (lines 1700–1738)

```
fn rebuilds_user_message_image_details_from_legacy_events()
```

**Purpose**: Verifies that remote and local image detail settings survive replay from older user-message events.

**Data flow**: It creates a saved user-message rollout item with text, remote image, local image, and detail metadata → rebuilds turns → checks the user input list.

**Call relations**: This test calls `build_turns_from_rollout_items`, covering `handle_user_message` and `build_user_inputs`.

*Call graph*: calls 1 internal fn (build_turns_from_rollout_items); 3 external calls (from, assert_eq!, vec!).


##### `tests::ignores_user_message_item_lifecycle_events`  (lines 1741–1797)

```
fn ignores_user_message_item_lifecycle_events()
```

**Purpose**: Ensures generic item lifecycle events do not duplicate user messages. User messages are rebuilt from their dedicated event instead.

**Data flow**: It creates a turn with both a user-message event and a user-message lifecycle item → rebuilds history → asserts only one user message appears.

**Call relations**: This test exercises `handle_item_started` ignoring user-message lifecycle items while `handle_user_message` supplies the real item.

*Call graph*: calls 2 internal fn (build_turns_from_rollout_items, new); 2 external calls (assert_eq!, vec!).


##### `tests::rebuilds_sleep_item_from_persisted_completion`  (lines 1800–1844)

```
fn rebuilds_sleep_item_from_persisted_completion()
```

**Purpose**: Checks that a persisted sleep item can be reconstructed from an item-completed event.

**Data flow**: It creates an explicit turn with a completed sleep lifecycle item → rebuilds turns → asserts the sleep item is present with its duration.

**Call relations**: This test covers `handle_item_completed` and `upsert_item_in_turn_id` for supported lifecycle items.

*Call graph*: calls 2 internal fn (build_turns_from_rollout_items, new); 3 external calls (Sleep, assert_eq!, vec!).


##### `tests::preserves_user_message_client_id_from_legacy_event`  (lines 1847–1905)

```
fn preserves_user_message_client_id_from_legacy_event()
```

**Purpose**: Verifies that a user message’s client-provided ID is preserved during replay.

**Data flow**: It creates events containing a user message with a client ID → rebuilds history → checks that the final `UserMessage` item includes that client ID.

**Call relations**: This test covers `handle_user_message` and confirms lifecycle events do not overwrite the rebuilt message.

*Call graph*: calls 2 internal fn (build_turns_from_rollout_items, new); 2 external calls (assert_eq!, vec!).


##### `tests::preserves_agent_message_phase_in_history`  (lines 1908–1930)

```
fn preserves_agent_message_phase_in_history()
```

**Purpose**: Checks that agent message phase metadata, such as final-answer phase, is kept in history.

**Data flow**: It creates an agent-message event with a phase → rebuilds turns → asserts the resulting agent item has the same phase.

**Call relations**: This test exercises `handle_agent_message` through `build_turns_from_rollout_items`.

*Call graph*: calls 1 internal fn (build_turns_from_rollout_items); 2 external calls (assert_eq!, vec!).


##### `tests::replays_image_generation_end_events_into_turn_history`  (lines 1933–1997)

```
fn replays_image_generation_end_events_into_turn_history()
```

**Purpose**: Verifies that completed image-generation events are visible after replay.

**Data flow**: It creates an explicit turn with a user request and image-generation end event → rebuilds history → checks the final image-generation item fields.

**Call relations**: This test covers `handle_image_generation_end` and normal explicit turn boundaries.

*Call graph*: calls 1 internal fn (build_turns_from_rollout_items); 2 external calls (assert_eq!, vec!).


##### `tests::splits_reasoning_when_interleaved`  (lines 2000–2051)

```
fn splits_reasoning_when_interleaved()
```

**Purpose**: Ensures reasoning chunks merge only when they are adjacent reasoning items. If another item appears between them, a new reasoning item is created.

**Data flow**: It creates reasoning summary and raw content, then an agent message, then more reasoning → rebuilds history → checks that two reasoning items exist.

**Call relations**: This test covers the merge behavior in `handle_agent_reasoning` and `handle_agent_reasoning_raw_content`.

*Call graph*: calls 1 internal fn (build_turns_from_rollout_items); 2 external calls (assert_eq!, vec!).


##### `tests::marks_turn_as_interrupted_when_aborted`  (lines 2054–2144)

```
fn marks_turn_as_interrupted_when_aborted()
```

**Purpose**: Checks that an abort event marks the affected turn as interrupted and that later user input starts a new turn.

**Data flow**: It creates a first user-agent exchange, aborts it, then creates a second exchange → rebuilds history → asserts the first turn is interrupted and the second is completed.

**Call relations**: This test exercises `handle_turn_aborted`, implicit turn finishing, and new-turn creation.

*Call graph*: calls 1 internal fn (build_turns_from_rollout_items); 2 external calls (assert_eq!, vec!).


##### `tests::drops_last_turns_on_thread_rollback`  (lines 2147–2240)

```
fn drops_last_turns_on_thread_rollback()
```

**Purpose**: Verifies that rollback removes the requested number of latest turns and that new history continues afterward.

**Data flow**: It creates two implicit turns, rolls back one, then adds a third input → rebuilds history → asserts only the first and post-rollback turns remain.

**Call relations**: This test covers `handle_thread_rollback`, `finish_current_turn`, and item counter reset after rollback.

*Call graph*: calls 1 internal fn (build_turns_from_rollout_items); 3 external calls (assert_eq!, assert_ne!, vec!).


##### `tests::thread_rollback_clears_all_turns_when_num_turns_exceeds_history`  (lines 2243–2280)

```
fn thread_rollback_clears_all_turns_when_num_turns_exceeds_history()
```

**Purpose**: Checks that rolling back more turns than exist clears the whole history safely.

**Data flow**: It creates two turns then requests rollback of a much larger number → rebuilds history → asserts the result is empty.

**Call relations**: This test exercises the clearing branch in `handle_thread_rollback`.

*Call graph*: calls 1 internal fn (build_turns_from_rollout_items); 2 external calls (assert_eq!, vec!).


##### `tests::uses_explicit_turn_boundaries_for_mid_turn_steering`  (lines 2283–2345)

```
fn uses_explicit_turn_boundaries_for_mid_turn_steering()
```

**Purpose**: Ensures multiple user messages inside an explicitly opened turn stay together. This supports mid-turn steering by the user.

**Data flow**: It creates one explicit turn with two user messages before completion → rebuilds history → asserts both messages are in the same turn.

**Call relations**: This test covers `handle_turn_started`, `handle_user_message`, and `handle_turn_complete` working together.

*Call graph*: calls 1 internal fn (build_turns_from_rollout_items); 2 external calls (assert_eq!, vec!).


##### `tests::reconstructs_tool_items_from_persisted_completion_events`  (lines 2348–2459)

```
fn reconstructs_tool_items_from_persisted_completion_events()
```

**Purpose**: Checks that completed tool events can rebuild final web search, command, and MCP tool-call items even without begin events.

**Data flow**: It creates a turn with a user message and several tool completion events → rebuilds history → asserts each tool item has the expected final fields.

**Call relations**: This test exercises `handle_web_search_end`, `handle_exec_command_end`, and `handle_mcp_tool_call_end`.

*Call graph*: calls 1 internal fn (build_turns_from_rollout_items); 2 external calls (assert_eq!, vec!).


##### `tests::reconstructs_mcp_tool_result_meta_from_persisted_completion_events`  (lines 2462–2525)

```
fn reconstructs_mcp_tool_result_meta_from_persisted_completion_events()
```

**Purpose**: Verifies that MCP tool results keep structured content and metadata during replay.

**Data flow**: It creates an MCP tool completion event with result content, structured content, metadata, URI, and plugin ID → rebuilds history → checks the full item.

**Call relations**: This test focuses on `handle_mcp_tool_call_end` result conversion.

*Call graph*: calls 1 internal fn (build_turns_from_rollout_items); 2 external calls (assert_eq!, vec!).


##### `tests::reconstructs_dynamic_tool_items_from_request_and_response_events`  (lines 2528–2593)

```
fn reconstructs_dynamic_tool_items_from_request_and_response_events()
```

**Purpose**: Checks that dynamic-tool request and response events combine into one completed dynamic-tool item.

**Data flow**: It creates a request followed by a successful response with output content → rebuilds history → asserts the final item is completed and contains the converted output.

**Call relations**: This test exercises `handle_dynamic_tool_call_request`, `handle_dynamic_tool_call_response`, and `convert_dynamic_tool_content_items`.

*Call graph*: calls 1 internal fn (build_turns_from_rollout_items); 2 external calls (assert_eq!, vec!).


##### `tests::reconstructs_declined_exec_and_patch_items`  (lines 2596–2685)

```
fn reconstructs_declined_exec_and_patch_items()
```

**Purpose**: Verifies that declined command and patch events are represented as declined visible items.

**Data flow**: It creates an explicit turn with a declined command completion and declined patch completion → rebuilds history → checks statuses and displayed details.

**Call relations**: This test covers `handle_exec_command_end` and `handle_patch_apply_end` for declined outcomes.

*Call graph*: calls 1 internal fn (build_turns_from_rollout_items); 2 external calls (assert_eq!, vec!).


##### `tests::reconstructs_declined_guardian_command_item`  (lines 2688–2771)

```
fn reconstructs_declined_guardian_command_item()
```

**Purpose**: Checks that a denied guardian assessment becomes a declined command item in history.

**Data flow**: It creates in-progress and denied guardian assessment events for a command → rebuilds history → asserts the command item is declined.

**Call relations**: This test exercises `handle_guardian_assessment` and `build_item_from_guardian_event` integration.

*Call graph*: calls 1 internal fn (build_turns_from_rollout_items); 2 external calls (assert_eq!, vec!).


##### `tests::reconstructs_in_progress_guardian_execve_item`  (lines 2774–2837)

```
fn reconstructs_in_progress_guardian_execve_item()
```

**Purpose**: Verifies that an in-progress guardian assessment for an execve-style command creates an in-progress command item.

**Data flow**: It creates a guardian assessment containing program and argument data → rebuilds history → checks the reconstructed command string and status.

**Call relations**: This test covers `handle_guardian_assessment` for guardian execve actions.

*Call graph*: calls 1 internal fn (build_turns_from_rollout_items); 2 external calls (assert_eq!, vec!).


##### `tests::assigns_late_exec_completion_to_original_turn`  (lines 2840–2935)

```
fn assigns_late_exec_completion_to_original_turn()
```

**Purpose**: Ensures a command completion that arrives after a newer turn starts is still attached to its original turn.

**Data flow**: It creates turn A, completes it, starts turn B, then sends a command-end event for turn A → rebuilds history → checks the command appears in turn A, not turn B.

**Call relations**: This test validates the turn-ID routing in `handle_exec_command_end` and `upsert_item_in_turn_id`.

*Call graph*: calls 1 internal fn (build_turns_from_rollout_items); 2 external calls (assert_eq!, vec!).


##### `tests::drops_late_turn_scoped_item_for_unknown_turn_id`  (lines 2938–3027)

```
fn drops_late_turn_scoped_item_for_unknown_turn_id()
```

**Purpose**: Checks that a late item with an unknown turn ID is dropped instead of being attached to the wrong active turn.

**Data flow**: It creates two explicit turns and sends a command-end event for a missing turn ID → finishes history → asserts no extra command item appears.

**Call relations**: This test covers the warning-and-drop path in `upsert_item_in_turn_id`.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert_eq!, vec!).


##### `tests::patch_apply_begin_updates_active_turn_snapshot_with_file_change`  (lines 3030–3095)

```
fn patch_apply_begin_updates_active_turn_snapshot_with_file_change()
```

**Purpose**: Verifies that an in-progress patch item appears in the active-turn snapshot before the turn is complete.

**Data flow**: It starts a turn, adds a user message and patch-begin event → asks for the active snapshot → checks the file-change item is present and in progress.

**Call relations**: This test covers `handle_patch_apply_begin` and `active_turn_snapshot`.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert_eq!, vec!).


##### `tests::apply_patch_approval_request_updates_active_turn_snapshot_with_file_change`  (lines 3098–3165)

```
fn apply_patch_approval_request_updates_active_turn_snapshot_with_file_change()
```

**Purpose**: Checks that a patch approval request updates the active-turn snapshot immediately.

**Data flow**: It starts a turn, adds a user message and approval request → reads the active snapshot → asserts the file-change item is visible.

**Call relations**: This test covers `handle_apply_patch_approval_request` and snapshot behavior.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert_eq!, vec!).


##### `tests::late_turn_complete_does_not_close_active_turn`  (lines 3168–3237)

```
fn late_turn_complete_does_not_close_active_turn()
```

**Purpose**: Ensures a completion event for an older turn does not close the currently active newer turn.

**Data flow**: It completes turn A, starts turn B, then sends another completion for turn A before finishing B → rebuilds history → asserts turn B still receives later items.

**Call relations**: This test validates ID matching in `handle_turn_complete`.

*Call graph*: calls 1 internal fn (build_turns_from_rollout_items); 2 external calls (assert_eq!, vec!).


##### `tests::late_turn_aborted_does_not_interrupt_active_turn`  (lines 3240–3302)

```
fn late_turn_aborted_does_not_interrupt_active_turn()
```

**Purpose**: Ensures an abort event for an older turn does not interrupt the current newer turn.

**Data flow**: It completes turn A, starts turn B, then sends an abort for turn A → rebuilds history → asserts turn B remains in progress with its items.

**Call relations**: This test validates ID matching in `handle_turn_aborted`.

*Call graph*: calls 1 internal fn (build_turns_from_rollout_items); 2 external calls (assert_eq!, vec!).


##### `tests::preserves_compaction_only_turn`  (lines 3305–3342)

```
fn preserves_compaction_only_turn()
```

**Purpose**: Checks that an explicitly started turn containing only a persisted compaction marker is kept.

**Data flow**: It creates a turn-start, compacted rollout item, and turn-complete sequence → rebuilds history → asserts the empty turn remains.

**Call relations**: This test covers `handle_compacted` and the keep/drop rules in `finish_current_turn`.

*Call graph*: calls 1 internal fn (build_turns_from_rollout_items); 2 external calls (assert_eq!, vec!).


##### `tests::reconstructs_collab_resume_end_item`  (lines 3345–3397)

```
fn reconstructs_collab_resume_end_item()
```

**Purpose**: Verifies that a collaborative-agent resume completion creates the correct resume tool-call item.

**Data flow**: It creates a user message followed by a collab resume-end event → rebuilds history → checks sender, receiver, status, and agent state.

**Call relations**: This test exercises `handle_collab_resume_end`.

*Call graph*: calls 1 internal fn (build_turns_from_rollout_items); 2 external calls (assert_eq!, vec!).


##### `tests::reconstructs_collab_spawn_end_item_with_model_metadata`  (lines 3400–3457)

```
fn reconstructs_collab_spawn_end_item_with_model_metadata()
```

**Purpose**: Checks that spawning a collaborative agent preserves model and reasoning-effort metadata.

**Data flow**: It creates a spawn-end event with sender, new thread ID, prompt, model, effort, and running status → rebuilds history → asserts all metadata appears in the tool-call item.

**Call relations**: This test covers `handle_collab_agent_spawn_end`.

*Call graph*: calls 2 internal fn (build_turns_from_rollout_items, try_from); 2 external calls (assert_eq!, vec!).


##### `tests::reconstructs_interrupted_send_input_as_completed_collab_call`  (lines 3460–3529)

```
fn reconstructs_interrupted_send_input_as_completed_collab_call()
```

**Purpose**: Ensures that redirecting a child agent with an interrupted receiver state is still shown as a completed send-input operation.

**Data flow**: It creates a collab interaction begin/end pair where the receiver status is interrupted → rebuilds history → checks the tool call is completed while the agent state says interrupted.

**Call relations**: This test exercises `handle_collab_agent_interaction_begin` and `handle_collab_agent_interaction_end`.

*Call graph*: calls 2 internal fn (build_turns_from_rollout_items, try_from); 2 external calls (assert_eq!, vec!).


##### `tests::rollback_failed_error_does_not_mark_turn_failed`  (lines 3532–3561)

```
fn rollback_failed_error_does_not_mark_turn_failed()
```

**Purpose**: Verifies that a rollback-failed error does not incorrectly fail the visible turn.

**Data flow**: It creates a normal turn followed by a rollback-failed error event → rebuilds history → asserts the turn stays completed and has no error.

**Call relations**: This test covers the filtering logic in `handle_error` through `affects_turn_status`.

*Call graph*: calls 1 internal fn (build_turns_from_rollout_items); 2 external calls (assert_eq!, vec!).


##### `tests::out_of_turn_error_does_not_create_or_fail_a_turn`  (lines 3564–3620)

```
fn out_of_turn_error_does_not_create_or_fail_a_turn()
```

**Purpose**: Checks that an error arriving after a turn is already complete does not create a new failed turn.

**Data flow**: It creates and completes a turn, then sends a request-level error → rebuilds history → asserts only the completed turn remains.

**Call relations**: This test validates `handle_error` when there is no current turn.

*Call graph*: calls 1 internal fn (build_turns_from_rollout_items); 2 external calls (assert_eq!, vec!).


##### `tests::error_then_turn_complete_preserves_failed_status`  (lines 3623–3675)

```
fn error_then_turn_complete_preserves_failed_status()
```

**Purpose**: Ensures that a failed turn remains failed even if a later turn-complete event arrives.

**Data flow**: It starts a turn, adds a user message, records a stream error, then completes the turn → rebuilds history → asserts the final turn status is failed with error details.

**Call relations**: This test covers `handle_error` followed by `handle_turn_complete`.

*Call graph*: calls 1 internal fn (build_turns_from_rollout_items); 2 external calls (assert_eq!, vec!).


##### `tests::rebuilds_hook_prompt_items_from_rollout_response_items`  (lines 3678–3730)

```
fn rebuilds_hook_prompt_items_from_rollout_response_items()
```

**Purpose**: Verifies that special hook-prompt response items are reconstructed into visible hook-prompt history items.

**Data flow**: It builds a hook prompt response item, places it in an explicit turn, replays the rollout → checks the resulting hook-prompt fragments.

**Call relations**: This test exercises `handle_response_item` and `parse_hook_prompt_message`.

*Call graph*: calls 2 internal fn (build_turns_from_rollout_items, build_hook_prompt_message); 3 external calls (from_single_hook, assert_eq!, vec!).


##### `tests::ignores_plain_user_response_items_in_rollout_replay`  (lines 3733–3763)

```
fn ignores_plain_user_response_items_in_rollout_replay()
```

**Purpose**: Checks that ordinary user response items are ignored during rollout replay. Only hook-prompt response items should become history items.

**Data flow**: It creates a plain user response item inside a turn → rebuilds history → asserts the turn has no items.

**Call relations**: This test covers the early-return behavior in `handle_response_item`.

*Call graph*: calls 1 internal fn (build_turns_from_rollout_items); 3 external calls (assert!, assert_eq!, vec!).


##### `tests::changed_rollout_item_reports_new_item_snapshot`  (lines 3766–3805)

```
fn changed_rollout_item_reports_new_item_snapshot()
```

**Purpose**: Checks that processing one rollout item with change tracking reports both the new item and the newly created turn metadata.

**Data flow**: It creates a fresh builder → processes one user-message rollout item with changes enabled → compares the returned change set to the expected item and turn snapshots.

**Call relations**: This test covers `handle_rollout_item_with_changes`, `collect_changes`, and change recording in `push_item_in_current_turn` and `ensure_turn`.

*Call graph*: calls 1 internal fn (new); 5 external calls (default, new, assert_eq!, UserMessage, EventMsg).


##### `tests::changed_rollout_item_reports_updated_existing_item_snapshot`  (lines 3808–3845)

```
fn changed_rollout_item_reports_updated_existing_item_snapshot()
```

**Purpose**: Verifies that updating an existing item reports the latest item snapshot, not a duplicate new item.

**Data flow**: It first processes a web-search begin event → then processes a web-search end event with changes enabled → checks that the change set contains the updated search item.

**Call relations**: This test exercises `upsert_item_in_current_turn` and `record_changed_item`.

*Call graph*: calls 1 internal fn (new); 4 external calls (assert_eq!, WebSearchBegin, WebSearchEnd, EventMsg).


##### `tests::changed_rollout_item_reports_streaming_item_mutation`  (lines 3848–3877)

```
fn changed_rollout_item_reports_streaming_item_mutation()
```

**Purpose**: Checks that mutating an existing reasoning item during streaming is reported as a changed item snapshot.

**Data flow**: It creates a reasoning summary item → processes raw reasoning content with change tracking → asserts the returned item contains both summary and raw content.

**Call relations**: This test covers the in-place mutation path in `handle_agent_reasoning_raw_content`.

*Call graph*: calls 1 internal fn (new); 4 external calls (assert_eq!, AgentReasoning, AgentReasoningRawContent, EventMsg).


##### `tests::changed_rollout_item_reports_turn_completion_metadata`  (lines 3880–3943)

```
fn changed_rollout_item_reports_turn_completion_metadata()
```

**Purpose**: Verifies that turn-start and turn-complete events produce turn metadata changes when tracking is enabled.

**Data flow**: It processes a start event and checks the in-progress snapshot → processes a user message and completion event → checks the completed timestamp and duration snapshot.

**Call relations**: This test covers `record_changed_pending_turn` and `record_changed_turn`.

*Call graph*: calls 1 internal fn (new); 7 external calls (default, new, assert_eq!, TurnComplete, TurnStarted, UserMessage, EventMsg).


##### `tests::changed_rollout_items_dedupe_updated_item_snapshots`  (lines 3946–3987)

```
fn changed_rollout_items_dedupe_updated_item_snapshots()
```

**Purpose**: Checks that a batch containing begin and end updates for the same item returns only the final item snapshot.

**Data flow**: It processes web-search begin and end events as one batch → examines the coalesced change set → confirms only the completed search item is reported.

**Call relations**: This test exercises `handle_rollout_items_with_changes` and `ThreadHistoryChangeAccumulator::push_item_change`.

*Call graph*: calls 1 internal fn (new); 4 external calls (assert_eq!, WebSearchBegin, WebSearchEnd, EventMsg).


##### `tests::changed_rollout_items_dedupe_turn_metadata_snapshots`  (lines 3990–4024)

```
fn changed_rollout_items_dedupe_turn_metadata_snapshots()
```

**Purpose**: Checks that a batch with start and complete metadata for the same turn returns only the final turn snapshot.

**Data flow**: It processes turn-start and turn-complete events as one batch → examines the coalesced change set → confirms the turn is reported as completed with final timing.

**Call relations**: This test exercises `ThreadHistoryChangeAccumulator::push_turn_change`.

*Call graph*: calls 1 internal fn (new); 5 external calls (default, assert_eq!, TurnComplete, TurnStarted, EventMsg).


##### `tests::changed_rollout_items_drop_prior_changes_for_removed_turns`  (lines 4027–4058)

```
fn changed_rollout_items_drop_prior_changes_for_removed_turns()
```

**Purpose**: Verifies that if a batch creates a turn and then rolls it back, the final change set only says the turn was removed.

**Data flow**: It processes turn-start, user-message, and rollback events as one batch → examines the coalesced change set → confirms item and turn changes were dropped and only the removed ID remains.

**Call relations**: This test exercises `ThreadHistoryChangeAccumulator::push_removed_turn_id` and rollback change recording.

*Call graph*: calls 1 internal fn (new); 7 external calls (default, new, assert_eq!, ThreadRolledBack, TurnStarted, UserMessage, EventMsg).


### Rollout and metadata persistence
These files define what gets recorded, reconstruct persisted sessions, derive normalized metadata, and synchronize thread storage state across rollout files and databases.

### `app-server/src/request_processors/external_agent_session_import.rs`

`orchestration` · `external agent config import / session migration`

This file is the bridge between external agent session history and Codex’s internal thread system. Without it, imported configuration could point at old sessions, but those conversations would not become usable Codex threads.

The main type, `ExternalAgentSessionImporter`, keeps the shared tools needed for the job: the Codex home folder, the thread store, the configuration loader, the thread manager, and paths to helper executables. It also uses a semaphore, which is a small gate that limits how many import batches can run at once. Inside one batch, it can still process several sessions in parallel, like several workers at one counter.

The import flow has three main steps. First, each requested external session is prepared and checked. This can involve file reading and validation, so it is run on a blocking worker thread to avoid freezing the async server. Second, a valid prepared session is persisted as a new Codex thread. That means loading the right configuration for the session’s working folder, choosing model information, creating a new thread record, copying over saved conversation items, writing metadata such as title and first user message, then saving and shutting down the thread cleanly. Third, successful imports are written to an import ledger so the system knows those source files have already been imported.

#### Function details

##### `ExternalAgentSessionImporter::new`  (lines 46–61)

```
fn new(
        codex_home: PathBuf,
        thread_manager: Arc<ThreadManager>,
        thread_store: Arc<dyn ThreadStore>,
        config_manager: ConfigManager,
        arg0_paths: Arg0DispatchPath
```

**Purpose**: Creates a reusable importer with all the shared services it needs to turn external sessions into Codex threads. It also creates the gate that prevents two full import batches from running at the same time.

**Data flow**: It receives the Codex home path, thread manager, thread store, configuration manager, and helper executable paths. It stores those values in a new `ExternalAgentSessionImporter`, wraps the import gate in shared ownership so cloned importers use the same gate, and returns the ready-to-use importer.

**Call relations**: This is called when the surrounding request-processing setup builds the session importer. The returned importer is later used by the import flow, especially `ExternalAgentSessionImporter::import_sessions`, which clones it for individual session work.

*Call graph*: called by 1 (new); 2 external calls (new, new).


##### `ExternalAgentSessionImporter::import_sessions`  (lines 63–118)

```
async fn import_sessions(
        &self,
        sessions: Vec<ExternalAgentSessionMigration>,
        mut item_result: ExternalAgentConfigImportItemResult,
    ) -> ExternalAgentConfigImportItemResul
```

**Purpose**: Imports a batch of external sessions and updates the user-facing import result with successes and errors. It is the top-level method for this file’s workflow.

**Data flow**: It takes a list of requested session migrations and an import-result object that is already being built. If the list is empty, it returns the result unchanged. Otherwise it acquires the batch gate, starts importing sessions with limited parallelism, records each success or failure into the result, writes a ledger of completed imports, and returns the updated result.

**Call relations**: This method is called by the broader external-agent configuration import process when session migrations are part of the import. For each session it hands work to `ExternalAgentSessionImporter::import_requested_session`. When a session succeeds, it records the success in the import item result; when a failure comes back, it uses `record_import_error` so the caller can report the problem. At the end it calls `record_completed_session_imports` to remember which source files have been imported.

*Call graph*: calls 2 internal fn (record_success, record_import_error); 4 external calls (new, record_completed_session_imports, pin_mut!, iter).


##### `ExternalAgentSessionImporter::import_requested_session`  (lines 120–149)

```
async fn import_requested_session(
        &self,
        session: ExternalAgentSessionMigration,
    ) -> Result<Option<CompletedExternalAgentSessionImport>, SessionImportFailure>
```

**Purpose**: Imports one requested external session, if it is valid and still needs importing. It turns preparation and persistence errors into a structured failure that says which source file failed and at what stage.

**Data flow**: It receives one external session migration request. It first keeps the source path for error reporting, then asks `ExternalAgentSessionImporter::prepare_session_import` to validate and prepare the session. If preparation says there is nothing to import, it returns no completed import. If preparation succeeds, it sends the prepared session to `ExternalAgentSessionImporter::persist_session`, then returns a completed-import record containing the source path, source content hash, and new Codex thread id.

**Call relations**: This is the per-session worker used by `ExternalAgentSessionImporter::import_sessions`. It coordinates the two main substeps: preparation first, persistence second. Its result is then interpreted by the batch importer as either a success to record, a skipped session, or a failure to show in the import report.

*Call graph*: calls 2 internal fn (persist_session, prepare_session_import).


##### `ExternalAgentSessionImporter::prepare_session_import`  (lines 151–160)

```
async fn prepare_session_import(
        &self,
        session: ExternalAgentSessionMigration,
    ) -> Result<Option<PendingSessionImport>, String>
```

**Purpose**: Checks and prepares an external session before Codex tries to save it as a thread. It runs the potentially slow file and validation work away from the async task scheduler so other server work is not blocked.

**Data flow**: It receives one external session migration request and clones the Codex home path. It then runs `prepare_validated_session_import` on a blocking worker thread. The result is either a prepared pending import, a clean “nothing to import” answer, or a plain error message explaining what went wrong.

**Call relations**: This is called by `ExternalAgentSessionImporter::import_requested_session` before any thread is created. It hands off the heavy preparation work to `spawn_blocking`, then returns a simplified result so the caller can either skip, continue to persistence, or report a preparation failure.

*Call graph*: called by 1 (import_requested_session); 2 external calls (clone, spawn_blocking).


##### `ExternalAgentSessionImporter::persist_session`  (lines 162–279)

```
async fn persist_session(
        &self,
        session: ImportedExternalAgentSession,
    ) -> Result<ThreadId, String>
```

**Purpose**: Saves one prepared external session as a real Codex thread. This is where imported conversation data becomes part of Codex’s normal thread store.

**Data flow**: It receives a prepared imported session containing the original working folder, optional title, first user message, and saved conversation items. It loads configuration for that working folder, chooses model and instruction information, creates a new thread id, builds thread creation settings and metadata, filters out conversation items that should not be persisted, creates the thread, appends the saved items, updates metadata, persists the thread to storage, shuts it down, and returns the new thread id. If appending items fails after thread creation, it tries to discard the partially created thread before returning an error.

**Call relations**: This is called by `ExternalAgentSessionImporter::import_requested_session` after preparation succeeds. It relies on the configuration manager for session-specific settings, the thread manager for model and source information, and the thread store for all thread storage actions. Its returned thread id becomes part of the completed-import record that the batch importer later reports and writes to the import ledger.

*Call graph*: calls 2 internal fn (load_with_overrides, new); called by 1 (import_requested_session); 5 external calls (default, now, new, env!, format!).


### `app-server/src/request_processors/thread_resume_redaction.rs`

`domain_logic` · `request handling for thread resume responses`

When a client asks to resume a thread, the server may send back past conversation turns. Some of those turns can contain bulky data, such as image-generation results, or detailed MCP tool-call payloads. MCP means “Model Context Protocol,” a way for the app to call external tools. Those tool calls can include arguments, results, and error messages that are not suitable to send in full to certain remote ChatGPT mobile clients.

This file is a temporary safety layer for that specific response. It does not change the saved thread history, the model’s resume history, or other APIs. Think of it like putting a privacy screen over one copy of a document before handing it to a particular audience; the original document stays unchanged elsewhere.

The file first decides whether a client name belongs to the remote ChatGPT Android or iOS clients. If so, the server can run the redaction pass over the turns being returned. During that pass, regular conversation items are kept. MCP tool calls are kept, but their arguments, result content, and error message are replaced with "[redacted]". Image-generation items are removed completely, because their payloads can be especially large. The tests build sample threads and confirm that normal messages remain, tool-call metadata remains, sensitive payloads are replaced, and image-generation entries disappear.

#### Function details

##### `should_redact_thread_resume_payloads`  (lines 13–15)

```
fn should_redact_thread_resume_payloads(client_name: Option<&str>) -> bool
```

**Purpose**: Decides whether thread-resume payloads should be redacted for a given client name. It is used to limit this special behavior to the ChatGPT remote Android and iOS clients.

**Data flow**: It receives an optional client name. If there is no name, it returns false. If there is a name, it checks whether it exactly matches one of the known remote ChatGPT mobile client names, then returns true or false.

**Call relations**: No caller is shown in the provided function graph, but this function is the gatekeeper for the redaction step. In the wider request flow, code can ask this question before choosing whether to call redact_thread_resume_payloads.


##### `redact_thread_resume_payloads`  (lines 17–39)

```
fn redact_thread_resume_payloads(turns: &mut [Turn])
```

**Purpose**: Edits a list of conversation turns so the thread-resume response is safe and smaller for selected remote clients. It keeps the shape of MCP tool-call history but hides the large or sensitive parts, and it removes image-generation items entirely.

**Data flow**: It receives a mutable list of turns. For each turn, it walks through the items in that turn. MCP tool-call items have their arguments replaced with the string "[redacted]"; any successful result is replaced with a small redacted result; any error message is also replaced. Image-generation items are dropped from the list. Other items are left as they were. It does not return a new value; it changes the provided turns in place.

**Call relations**: The tests redacts_mcp_success_result_and_removes_image_generation and redacts_mcp_error_message call this function after building sample thread data. In normal use, this is the main worker that would run after the caller has decided that the client needs redacted thread-resume payloads. When it needs a replacement MCP result, it uses redacted_mcp_tool_call_result.

*Call graph*: called by 2 (redacts_mcp_error_message, redacts_mcp_success_result_and_removes_image_generation).


##### `redacted_mcp_tool_call_result`  (lines 41–50)

```
fn redacted_mcp_tool_call_result() -> McpToolCallResult
```

**Purpose**: Builds the small placeholder result used when an MCP tool call originally had a successful result. This preserves the fact that there was a result while hiding its actual contents.

**Data flow**: It takes no input. It creates a new MCP tool-call result whose content is a single text entry containing "[redacted]", and whose structured content and metadata are empty. It returns that replacement result to the caller.

**Call relations**: redact_thread_resume_payloads uses this helper when it finds an MCP tool-call item with an existing result. The helper centralizes the exact replacement shape so the redaction pass does not have to rebuild it inline each time.

*Call graph*: 1 external calls (vec!).


##### `tests::redacts_mcp_success_result_and_removes_image_generation`  (lines 67–130)

```
fn redacts_mcp_success_result_and_removes_image_generation()
```

**Purpose**: Checks the main success case: ordinary messages stay, successful MCP tool-call payloads are redacted, and image-generation items are removed. This protects against future changes accidentally sending back large or sensitive data.

**Data flow**: It creates a sample thread containing an agent message, a completed MCP tool call with secret-looking arguments and result data, and an image-generation item. It runs redact_thread_resume_payloads on the thread’s turns. It then compares the edited thread items with the expected result: the message is unchanged, the MCP tool call keeps its useful metadata but has redacted payloads, and the image-generation item is gone.

**Call relations**: This test calls the test_thread helper to build realistic thread data, then calls redact_thread_resume_payloads as the behavior under test. It also compares the final items with expected values, including the same redacted_mcp_tool_call_result shape used by the production redaction code.

*Call graph*: calls 1 internal fn (redact_thread_resume_payloads); 3 external calls (test_thread, assert_eq!, vec!).


##### `tests::redacts_mcp_error_message`  (lines 133–168)

```
fn redacts_mcp_error_message()
```

**Purpose**: Checks the failure case for MCP tool calls. It makes sure that when a tool call failed, both its arguments and its error message are hidden before the thread-resume response is sent.

**Data flow**: It creates a sample thread with one failed MCP tool call whose arguments and error message contain secret-looking text. It runs redact_thread_resume_payloads. It then verifies that the tool call is still present and still marked as failed, but the arguments and error message have both become "[redacted]".

**Call relations**: This test uses test_thread to create the sample thread and then calls redact_thread_resume_payloads to exercise the real redaction path. The final assertion documents the expected behavior for MCP errors.

*Call graph*: calls 1 internal fn (redact_thread_resume_payloads); 3 external calls (test_thread, assert_eq!, vec!).


##### `tests::test_thread`  (lines 170–202)

```
fn test_thread(items: Vec<ThreadItem>) -> Thread
```

**Purpose**: Builds a complete test thread around a supplied list of thread items. It saves the tests from repeating a large amount of setup that is not the focus of the redaction behavior.

**Data flow**: It receives a list of thread items. It wraps those items inside one completed turn, then wraps that turn inside a thread with fixed test values such as IDs, status, model provider, current working directory, and source. It returns the finished thread object to the test.

**Call relations**: The two test cases call this helper before running redact_thread_resume_payloads. Its job is to provide realistic enough surrounding data so the tests can focus on how individual thread items are changed.

*Call graph*: 2 external calls (test_path_buf, vec!).


### `app-server/src/request_processors/thread_summary.rs`

`domain_logic` · `request handling`

A “thread” here is a saved conversation session. The app server often needs to show a thread list, send a “thread started” message, or report the current settings for a thread without loading every message in full. This file is the adapter for that job: it takes data from the core protocol, saved rollout files, and configuration snapshots, then reshapes it into app-server response types.

Several helpers are only compiled for tests. They read the beginning of a saved conversation file, pull out the session metadata, find the first user message to use as a preview, and convert timestamps and Git information into the format expected by the app-server model. This lets tests verify that old saved conversations still appear correctly in thread lists.

The production helpers focus on safe translation. Permission settings are converted into a sandbox policy, which is the rule set that decides what the assistant may touch on the local machine. Thread settings snapshots from different sources are normalized into one `ThreadSettings` response. There is also a small cleanup step for thread-start notifications: it removes turns from the thread before sending the notification, so a start event does not accidentally include conversation history.

#### Function details

##### `read_summary_from_rollout`  (lines 9–81)

```
async fn read_summary_from_rollout(
    path: &Path,
    fallback_provider: &str,
) -> std::io::Result<ConversationSummary>
```

**Purpose**: This test-only helper reads a saved conversation rollout file and builds a short `ConversationSummary` from it. It is used to check that stored conversation files can still be summarized for thread listings.

**Data flow**: It receives a file path and a fallback model provider name. It reads the start of the file, expects the first record to be session metadata, adds missing sub-agent nickname or role information when needed, finds an updated time from the file metadata, and then tries to extract a preview from the first user message. If no preview can be found, it still returns a summary with empty preview text. If the file is empty or does not start with session metadata, it returns an input/output error.

**Call relations**: In the test flow, this is the top-level reader for a rollout summary. It relies on `with_thread_spawn_agent_metadata` to repair agent metadata, asks `read_updated_at` for a best-effort modification time, and delegates the preview-building path to `extract_conversation_summary` when the saved file contains a usable first user message.

*Call graph*: calls 3 internal fn (extract_conversation_summary, read_updated_at, with_thread_spawn_agent_metadata); 4 external calls (to_path_buf, new, other, format!).


##### `extract_conversation_summary`  (lines 84–130)

```
fn extract_conversation_summary(
    path: PathBuf,
    head: &[serde_json::Value],
    session_meta: &SessionMeta,
    git: Option<&CoreGitInfo>,
    fallback_provider: &str,
    updated_at: Option<S
```

**Purpose**: This test-only helper tries to build a conversation summary from the records already read from the start of a rollout file. Its main job is to find a human-readable preview from the first user message.

**Data flow**: It receives the rollout path, the already-read JSON records, session metadata, optional Git metadata, a fallback provider, and an optional updated timestamp. It scans the records for response items that represent user messages, strips a known message marker if present, and combines that preview with session details. If it cannot find a user message, it returns nothing.

**Call relations**: `read_summary_from_rollout` calls this after it has loaded the file header and session metadata. When this helper succeeds, the caller can return the richer summary immediately; when it fails, the caller falls back to a summary with an empty preview.

*Call graph*: called by 1 (read_summary_from_rollout); 1 external calls (iter).


##### `map_git_info`  (lines 133–139)

```
fn map_git_info(git_info: &CoreGitInfo) -> ConversationGitInfo
```

**Purpose**: This test-only helper converts Git information from the core conversation format into the app-server summary format. Git information means details like the commit, branch, and remote repository URL.

**Data flow**: It receives core Git metadata. It copies the commit hash, branch name, and repository URL into a `ConversationGitInfo` value, using `None` where the source has no value.

**Call relations**: It is used by the rollout-summary conversion path when a saved conversation includes Git context. That lets the summary and reconstructed thread carry repository details without exposing the core protocol type directly.


##### `with_thread_spawn_agent_metadata`  (lines 141–170)

```
fn with_thread_spawn_agent_metadata(
    source: codex_protocol::protocol::SessionSource,
    agent_nickname: Option<String>,
    agent_role: Option<String>,
) -> codex_protocol::protocol::SessionSour
```

**Purpose**: This helper fills in missing nickname or role information for a thread spawned by a sub-agent. It preserves the original source unless there is new agent metadata worth adding.

**Data flow**: It receives a session source plus optional agent nickname and role strings. If both optional values are missing, it returns the source unchanged. If the source describes a sub-agent thread spawn, it returns a new source where the provided nickname or role fills the corresponding fields, while keeping existing values when no replacement is provided. Other kinds of sources pass through unchanged.

**Call relations**: `read_summary_from_rollout` calls this while reading session metadata from a rollout file. The goal is to make older or differently shaped metadata look like the newer thread-spawn source format before it is turned into a summary.

*Call graph*: called by 1 (read_summary_from_rollout); 1 external calls (SubAgent).


##### `thread_response_active_permission_profile`  (lines 172–176)

```
fn thread_response_active_permission_profile(
    active_permission_profile: Option<codex_protocol::models::ActivePermissionProfile>,
) -> Option<codex_app_server_protocol::ActivePermissionProfile>
```

**Purpose**: This helper converts the currently active permission profile from the core model into the app-server response model. A permission profile is a named set of rules about what the assistant may do.

**Data flow**: It receives an optional core permission profile. If a profile is present, it converts it into the app-server version; if it is missing, it returns missing as well.

**Call relations**: Both `thread_settings_from_config_snapshot` and `thread_settings_from_core_snapshot` use this while building `ThreadSettings`. It is the small translation step that keeps the response type independent from the core protocol type.

*Call graph*: called by 2 (thread_settings_from_config_snapshot, thread_settings_from_core_snapshot).


##### `thread_response_sandbox_policy`  (lines 178–187)

```
fn thread_response_sandbox_policy(
    permission_profile: &codex_protocol::models::PermissionProfile,
    cwd: &Path,
) -> codex_app_server_protocol::SandboxPolicy
```

**Purpose**: This helper computes the sandbox policy to report for a thread. A sandbox policy is the practical rule set that limits file and system access for safety.

**Data flow**: It receives a permission profile and the thread’s working directory. It asks the sandboxing layer to produce the compatible sandbox policy for that combination, then converts the result into the app-server response type.

**Call relations**: `thread_settings_from_config_snapshot` and `thread_settings_from_core_snapshot` both call this because they need to show clients the effective safety rules, not just the raw permission profile.

*Call graph*: called by 2 (thread_settings_from_config_snapshot, thread_settings_from_core_snapshot); 1 external calls (compatibility_sandbox_policy_for_permission_profile).


##### `thread_settings_from_config_snapshot`  (lines 189–211)

```
fn thread_settings_from_config_snapshot(
    config_snapshot: &ThreadConfigSnapshot,
) -> ThreadSettings
```

**Purpose**: This function builds a `ThreadSettings` response from a stored configuration snapshot. It gives clients one clear view of the model, approval rules, sandbox rules, working directory, and assistant behavior settings for a thread.

**Data flow**: It receives a `ThreadConfigSnapshot`. It copies basic settings such as working directory, model, provider, service tier, reasoning options, collaboration mode, and personality. It converts approval-related values into response types, computes the sandbox policy from the permission profile and working directory, and converts the active permission profile if one exists. The output is a complete `ThreadSettings` value.

**Call relations**: This is used when the app server has a configuration snapshot rather than a core protocol snapshot. Inside that conversion, it calls `thread_response_sandbox_policy` for the effective sandbox rules and `thread_response_active_permission_profile` for the optional active profile.

*Call graph*: calls 3 internal fn (thread_response_active_permission_profile, thread_response_sandbox_policy, cwd).


##### `thread_settings_from_core_snapshot`  (lines 213–247)

```
fn thread_settings_from_core_snapshot(
    snapshot: codex_protocol::protocol::ThreadSettingsSnapshot,
) -> ThreadSettings
```

**Purpose**: This function builds the same `ThreadSettings` response, but from a snapshot produced by the core protocol. It normalizes core thread settings into the app-server shape clients expect.

**Data flow**: It receives a core `ThreadSettingsSnapshot` and breaks it into its fields. It computes the sandbox policy using the permission profile and working directory, converts approval and active-profile values into app-server response types, and copies the model, provider, reasoning, collaboration, and personality values into a new `ThreadSettings`.

**Call relations**: This is the sibling of `thread_settings_from_config_snapshot` for data that comes from the running core session. It uses the same two conversion helpers, `thread_response_sandbox_policy` and `thread_response_active_permission_profile`, so clients see consistent settings no matter where the snapshot came from.

*Call graph*: calls 2 internal fn (thread_response_active_permission_profile, thread_response_sandbox_policy).


##### `parse_datetime`  (lines 250–256)

```
fn parse_datetime(timestamp: Option<&str>) -> Option<DateTime<Utc>>
```

**Purpose**: This test-only helper turns an optional timestamp string into a UTC date-time value. UTC is a shared time standard, useful because saved files may be read on machines in different time zones.

**Data flow**: It receives either no timestamp or a timestamp string. If a string is present and follows the RFC 3339 date-time format, it parses it and converts it to UTC. If the string is missing or invalid, it returns nothing.

**Call relations**: `summary_to_thread` uses this when rebuilding a thread from a conversation summary in tests. That lets the reconstructed thread store creation and update times as numeric timestamps.

*Call graph*: called by 1 (summary_to_thread).


##### `read_updated_at`  (lines 259–269)

```
async fn read_updated_at(path: &Path, created_at: Option<&str>) -> Option<String>
```

**Purpose**: This test-only helper finds the best available “last updated” time for a saved rollout file. It prefers the file’s modification time and falls back to the creation timestamp from the session metadata.

**Data flow**: It receives a file path and an optional created-at timestamp. It asks the operating system for the file metadata, reads the modified time if available, and formats it as an RFC 3339 timestamp with milliseconds. If any of that fails, it returns the provided created-at timestamp instead.

**Call relations**: `read_summary_from_rollout` calls this before creating a summary. The summary can then show when the conversation was last touched, even if the rollout itself does not explicitly store an updated time.

*Call graph*: called by 1 (read_summary_from_rollout); 1 external calls (metadata).


##### `thread_started_notification`  (lines 271–274)

```
fn thread_started_notification(mut thread: Thread) -> ThreadStartedNotification
```

**Purpose**: This helper prepares the notification sent when a thread starts. It deliberately removes the thread’s turns, meaning the message history, so the start event stays small and does not leak conversation contents.

**Data flow**: It receives a full `Thread` value. Before wrapping it in a `ThreadStartedNotification`, it clears the list of turns inside the thread. The returned notification contains the same thread identity and metadata, but no turn history.

**Call relations**: Other request-processing code can call this when it needs to announce a newly started thread. It does not delegate to other helpers; it performs one focused cleanup before producing the notification object.


##### `summary_to_thread`  (lines 277–335)

```
fn summary_to_thread(
    summary: ConversationSummary,
    fallback_cwd: &AbsolutePathBuf,
) -> Thread
```

**Purpose**: This test-only helper rebuilds a lightweight `Thread` from a `ConversationSummary`. It is useful for tests that start with a saved summary but need the app-server thread shape.

**Data flow**: It receives a conversation summary and a fallback working directory. It parses creation and update times, converts Git metadata, normalizes the saved working directory into an absolute local path, and falls back to the supplied directory if normalization fails. It then creates a `Thread` marked as not loaded, with no turns, using the summary preview, model provider, source, timestamps, path, Git details, and agent metadata.

**Call relations**: This sits after the summary-reading path in tests: a summary can be produced from a rollout file and then converted into a thread-like record. It calls `parse_datetime` for timestamp conversion and uses path-normalization helpers so the reconstructed thread has a usable working directory on the current machine.

*Call graph*: calls 2 internal fn (parse_datetime, relative_to_current_dir); 2 external calls (new, normalize_for_native_workdir).


### `core/src/session/rollout_reconstruction.rs`

`domain_logic` · `session resume or fork reconstruction`

A rollout is like a diary of what happened in a session: user messages, model responses, compactions, rollbacks, and turn metadata. This file reads that diary and turns it back into the current conversation state. Without it, resuming an old session or branching from one would risk using the wrong history, wrong model settings, or stale context.

The main work happens in `Session::reconstruct_history_from_rollout`. It first scans the rollout backward, from newest item to oldest. That lets it quickly find the newest surviving checkpoint, while also respecting rollbacks that say “remove the last N user turns.” It groups items into turn-sized segments so it can decide whether a segment counts as a real user turn and whether its metadata should still matter.

Once it knows the best checkpoint and the needed resume metadata, it replays the surviving tail forward. This second pass rebuilds the exact visible history using `ContextManager`, including inter-agent messages, compaction checkpoints, and rollback events. A compaction is a saved shortened version of history, like replacing a pile of notes with a summary plus the important messages. The file also has special fallback behavior for older compaction records that did not save a replacement history.

#### Function details

##### `turn_ids_are_compatible`  (lines 40–43)

```
fn turn_ids_are_compatible(active_turn_id: Option<&str>, item_turn_id: Option<&str>) -> bool
```

**Purpose**: This small helper decides whether two turn identifiers can be treated as referring to the same turn. It is permissive when either side has no identifier, because older or partial rollout records may not always carry one.

**Data flow**: It receives an optional active turn id and an optional item turn id. If the active id is missing, it accepts the item. If the item id is missing, it also accepts it. If both are present, it returns true only when the strings match.

**Call relations**: During reverse reconstruction, `Session::reconstruct_history_from_rollout` uses this helper when attaching turn metadata or closing a turn segment. It prevents metadata from a clearly different turn from being mixed into the active segment, while still allowing incomplete older records to be replayed.

*Call graph*: called by 1 (reconstruct_history_from_rollout).


##### `finalize_active_segment`  (lines 45–91)

```
fn finalize_active_segment(
    active_segment: ActiveReplaySegment<'a>,
    base_replacement_history: &mut Option<&'a [ResponseItem]>,
    previous_turn_settings: &mut Option<PreviousTurnSettings>,
```

**Purpose**: This function takes one completed replay segment and decides which parts of it still matter for the rebuilt session. It applies rollback rules, captures the newest useful checkpoint, and records the latest surviving resume metadata.

**Data flow**: It receives an accumulated segment plus mutable slots for the chosen replacement history, previous turn settings, reference context item, window id, and pending rollback count. If a rollback still needs to remove user turns, it may skip this whole segment. Otherwise, it fills any still-empty output slots with information from this segment, but only when that segment is the newest surviving source for that kind of data.

**Call relations**: `Session::reconstruct_history_from_rollout` builds segments while scanning the rollout backward and calls this function when a segment is complete, or once more at the end for any unfinished segment. The helper hands back the decisions that let the larger reconstruction stop early and later replay only the needed suffix.

*Call graph*: called by 1 (reconstruct_history_from_rollout); 1 external calls (matches!).


##### `Session::reconstruct_history_from_rollout`  (lines 94–335)

```
async fn reconstruct_history_from_rollout(
        &self,
        turn_context: &TurnContext,
        rollout_items: &[RolloutItem],
    ) -> RolloutReconstruction
```

**Purpose**: This is the main reconstruction routine. Given a saved rollout log, it rebuilds the conversation history and returns the metadata needed to continue the session as if it had never been unloaded.

**Data flow**: It takes the current turn context and a slice of rollout items. First it scans backward to find the newest surviving replacement-history checkpoint, last relevant turn settings, reference context, and compaction window id, while honoring rollback events. Then it creates a fresh `ContextManager` and replays the surviving rollout items forward to rebuild the final list of response items. It returns a `RolloutReconstruction` containing the rebuilt history, optional previous turn settings, optional reference context item, and window id.

**Call relations**: This method is called when a session needs to resume or fork from persisted rollout data. Inside, it uses `turn_ids_are_compatible` to safely group turn-scoped records, `finalize_active_segment` to decide what survives the backward scan, and `ContextManager` to rebuild history during the forward replay. When it encounters older compaction records without a saved replacement history, it falls back to `collect_user_messages` and `build_compacted_history` to recreate a compacted prompt shape as well as it can.

*Call graph*: calls 5 internal fn (build_compacted_history, collect_user_messages, new, finalize_active_segment, turn_ids_are_compatible); 10 external calls (new, default, new, Latest, is_user_turn_boundary, matches!, iter, once, try_from, try_from).


### `core/src/session_rollout_init_error.rs`

`domain_logic` · `session initialization`

Codex stores conversation sessions under its home directory. When that storage cannot be prepared, the raw error from the operating system may be hard to understand: for example, it might only say “permission denied” or “not a directory.” This file acts like a translator. It looks through a session initialization failure, finds any underlying file-system error, and rewrites common cases into practical advice.

The main entry point is `map_session_init_error`. It receives a broad error value and the path to the Codex home directory. It walks through the error’s causes, looking for an input/output error from the operating system. If it finds one, it asks `map_rollout_io_error` whether that specific kind of error has a helpful explanation.

`map_rollout_io_error` focuses on the sessions folder. It recognizes cases such as missing folders, wrong permissions, a file blocking a folder path, corrupt-looking data, or an unexpected file type. For each, it returns a fatal Codex error with a plain hint and the original error included for detail. If the error is not one of the known session-storage problems, the file falls back to a general “Failed to initialize session” message. Without this file, users would get less actionable startup failures and might not know how to fix their session directory.

#### Function details

##### `map_session_init_error`  (lines 7–17)

```
fn map_session_init_error(err: &anyhow::Error, codex_home: &Path) -> CodexErr
```

**Purpose**: This function converts a broad session startup error into the kind of error Codex can show to a user. It tries to find a useful file-system cause first, so the final message can include a concrete fix instead of a generic failure.

**Data flow**: It takes an error and the Codex home directory path. It looks through the error and its underlying causes, searching for an operating-system input/output error. If a known session-storage problem is found, it returns that clearer fatal error; otherwise it returns a general fatal message that includes the full original error text.

**Call relations**: This is the public helper within the crate for session rollout startup failures. During session initialization, higher-level startup code can pass its failure here before reporting it. It delegates the detailed interpretation of file-system error kinds to `map_rollout_io_error`, then hands the resulting `CodexErr` back to the caller for display or shutdown.

*Call graph*: 3 external calls (chain, format!, Fatal).


##### `map_rollout_io_error`  (lines 19–49)

```
fn map_rollout_io_error(io_err: &std::io::Error, codex_home: &Path) -> Option<CodexErr>
```

**Purpose**: This helper turns specific operating-system file errors into practical messages about Codex session storage. It is used when Codex knows the failure happened while preparing or reading the sessions directory.

**Data flow**: It receives a file-system error and the Codex home directory. It builds the expected sessions directory path, checks what kind of file error occurred, and creates a tailored explanation for known cases such as permission trouble, a missing folder, corrupt data, or the wrong kind of path. It returns a fatal Codex error when it recognizes the problem, or nothing if the error kind is not one it knows how to explain.

**Call relations**: This function is the specialist called from `map_session_init_error` after an input/output error has been found inside a larger failure. It supplies the user-friendly wording and then hands that mapped error back up, so the broader session initialization path can report the most helpful message available.

*Call graph*: 4 external calls (join, kind, format!, Fatal).


### `external-agent-sessions/src/export.rs`

`domain_logic` · `session import`

When a user imports a session from another tool, the rest of Codex cannot work directly with that tool’s raw records. It expects a sequence of internal “rollout items,” which are the event and message records Codex uses to show a thread, track turns, and estimate token use. This file is the translator between those worlds.

It first reads and parses the external session file, then checks that the session has a working directory. Without that directory, Codex cannot attach the conversation to a project, so the import is ignored. It chooses a title from the source file if one exists; otherwise it uses a shortened version of the first user message.

The main conversion walks through the imported messages in order. Each user message starts a new turn, like opening a new folder for that exchange. Assistant messages are added only if a user turn is already open, so stray assistant text before any request is skipped. For each visible message, the file also creates a stored response item, so both the user interface and the underlying history have the same imported content.

At the end, it adds a special message, “<EXTERNAL SESSION IMPORTED>,” plus a rough token count and a turn-complete event. That marker matters because it tells users and downstream code that this was imported history, not a fresh assistant reply.

#### Function details

##### `load_session_for_import`  (lines 24–29)

```
fn load_session_for_import(path: &Path) -> io::Result<Option<ImportedExternalAgentSession>>
```

**Purpose**: This test-only helper loads an imported session but drops the file content hash from the result. Tests use it when they only care about the imported conversation, not about identifying the exact source file contents.

**Data flow**: It receives a file path. It asks `load_session_for_import_with_content_sha256` to do the real loading, then keeps only the session part if one was found. It returns either no session, a loaded session, or an input/output error from reading the file.

**Call relations**: The import tests call this as their simple doorway into the importer. It immediately hands the work to `load_session_for_import_with_content_sha256`, which is the production loader that also returns the content hash.

*Call graph*: calls 1 internal fn (load_session_for_import_with_content_sha256); called by 7 (adds_import_marker_without_copying_last_agent_message, builds_visible_turns_for_imported_history, emits_token_usage_for_imported_history, loads_ai_title_for_imported_session, loads_custom_title_for_imported_session, loads_custom_title_over_later_ai_title_for_imported_session, stores_imported_messages_as_response_items_and_visible_events).


##### `load_session_for_import_with_content_sha256`  (lines 31–57)

```
fn load_session_for_import_with_content_sha256(
    path: &Path,
) -> io::Result<Option<(ImportedExternalAgentSession, String)>>
```

**Purpose**: This is the main loader for an external session file. It reads the file, decides whether it contains enough information to import, builds Codex-ready history items, and returns the imported session together with a SHA-256 content hash, which is a fingerprint of the file contents.

**Data flow**: It takes a path to a session file. It reads parsed session data from `read_session_import`, checks for a working directory, chooses a title, converts conversation messages into rollout items, and rejects empty imports. If successful, it returns an `ImportedExternalAgentSession` plus the file hash; otherwise it returns `None` or a read/parse error.

**Call relations**: This function is called by the higher-level import flow through `load_importable_session`, and by the test helper `load_session_for_import`. After reading the raw import records, it hands the message list to `rollout_items_from_messages` so the rest of Codex can consume the conversation in its normal internal shape.

*Call graph*: calls 2 internal fn (rollout_items_from_messages, read_session_import); called by 2 (load_session_for_import, load_importable_session).


##### `rollout_items_from_messages`  (lines 59–121)

```
fn rollout_items_from_messages(messages: Vec<ConversationMessage>) -> Vec<RolloutItem>
```

**Purpose**: This function converts plain imported chat messages into Codex’s internal timeline of turn events, visible messages, stored response messages, token counts, and completion markers. It is the heart of the import translation.

**Data flow**: It receives a list of imported conversation messages. It walks through them in order, starts a new turn for each user message, adds user and assistant text as both visible events and stored response items, estimates token usage from message byte length, and closes turns when needed. It returns a list of rollout items ready to be shown and saved by Codex.

**Call relations**: It is called by `load_session_for_import_with_content_sha256` after the external file has been parsed. While building the timeline, it uses helper functions such as `response_item`, `message_byte_count`, `external_session_imported_marker_item`, `token_count_item`, and `turn_complete_item` to create each specific kind of internal record.

*Call graph*: calls 5 internal fn (external_session_imported_marker_item, message_byte_count, response_item, token_count_item, turn_complete_item); called by 1 (load_session_for_import_with_content_sha256); 9 external calls (default, new, approx_tokens_from_byte_count_i64, format!, AgentMessage, TurnStarted, UserMessage, EventMsg, ResponseItem).


##### `external_session_imported_marker_item`  (lines 123–129)

```
fn external_session_imported_marker_item() -> RolloutItem
```

**Purpose**: This creates the visible marker message that says the previous content came from an external import. It prevents the imported transcript from being mistaken for a live assistant response generated during the current Codex session.

**Data flow**: It takes no input. It wraps the fixed text `<EXTERNAL SESSION IMPORTED>` inside an agent-message event and returns that as a rollout item.

**Call relations**: At the end of `rollout_items_from_messages`, this marker is inserted into the final open turn. The thread-building code later displays it like an assistant message, making the boundary between imported history and future work clear.

*Call graph*: called by 1 (rollout_items_from_messages); 2 external calls (AgentMessage, EventMsg).


##### `response_item`  (lines 131–146)

```
fn response_item(message: ConversationMessage) -> ResponseItem
```

**Purpose**: This converts one imported message into a stored response-message record. That stored form preserves the message in the same structure Codex normally uses for user and assistant conversation content.

**Data flow**: It receives a `ConversationMessage` with a role and text. If the role is user, it creates input-text content and labels the message as `user`; if the role is assistant, it creates output-text content and labels it as `assistant`. It returns a `ResponseItem::Message` containing that content.

**Call relations**: It is called from `rollout_items_from_messages` for every imported user or assistant message that becomes part of the Codex history. It works alongside the visible event records, so the imported session is available both for display and for stored conversation context.

*Call graph*: called by 1 (rollout_items_from_messages); 1 external calls (vec!).


##### `message_byte_count`  (lines 148–150)

```
fn message_byte_count(message: &ConversationMessage) -> i64
```

**Purpose**: This measures how large a message’s text is in bytes, using a safe fallback if the size is too large to fit normally. The importer uses this size to estimate token usage.

**Data flow**: It receives a reference to a conversation message. It reads the length of the message text, converts that length to a signed number, and returns it; if conversion would overflow, it returns the largest possible signed value instead.

**Call relations**: It is called by `rollout_items_from_messages` each time an imported message is counted toward the rough token estimate. That byte count is later passed through an approximate byte-to-token conversion before `token_count_item` records the usage.

*Call graph*: called by 1 (rollout_items_from_messages); 1 external calls (try_from).


##### `token_count_item`  (lines 152–165)

```
fn token_count_item(last_model_visible_tokens: i64) -> RolloutItem
```

**Purpose**: This creates a token-usage event for the imported history. Tokens are the small text pieces language models count internally, and this event gives Codex a rough idea of how much conversation context the import represents.

**Data flow**: It receives an estimated number of visible tokens. It puts that number into both the total usage and last usage fields, leaves unknown fields empty, and returns a rollout item containing a token-count event.

**Call relations**: It is called near the end of `rollout_items_from_messages`, after message sizes have been accumulated and converted into an approximate token count. The resulting event lets later parts of Codex treat imported history more like normal model conversation history.

*Call graph*: called by 1 (rollout_items_from_messages); 3 external calls (TokenCount, EventMsg, default).


##### `turn_complete_item`  (lines 167–175)

```
fn turn_complete_item(turn_id: String, completed_at: Option<i64>) -> RolloutItem
```

**Purpose**: This creates the event that says a conversation turn is finished. It is used to close imported turns cleanly in the same way Codex closes live turns.

**Data flow**: It receives a turn ID and an optional completion timestamp. It builds a turn-complete event with that ID, includes the timestamp if one is known, leaves timing details empty, and returns it as a rollout item.

**Call relations**: It is called by `rollout_items_from_messages` when a new user message starts and the previous turn must be closed, and once more at the end to close the final imported turn. The thread-building code depends on these boundaries to group messages into visible turns.

*Call graph*: called by 1 (rollout_items_from_messages); 2 external calls (TurnComplete, EventMsg).


##### `tests::builds_visible_turns_for_imported_history`  (lines 187–219)

```
fn builds_visible_turns_for_imported_history()
```

**Purpose**: This test checks that imported messages are grouped into visible turns correctly. It protects the user-facing shape of imported conversations.

**Data flow**: It creates a temporary project and a fake JSON-lines session file with two user requests and one assistant answer. It imports the file, converts rollout items into thread turns, and checks that there are two visible turns with the expected number of displayed items, including the import marker in the second turn.

**Call relations**: The test calls `load_session_for_import`, which exercises the real importer, then calls external thread-building code to see what a user would see. It verifies that `rollout_items_from_messages` produces turn events that downstream display code can understand.

*Call graph*: calls 1 internal fn (load_session_for_import); 7 external calls (new, assert_eq!, build_turns_from_rollout_items, jsonl, record, create_dir_all, write).


##### `tests::adds_import_marker_without_copying_last_agent_message`  (lines 222–263)

```
fn adds_import_marker_without_copying_last_agent_message()
```

**Purpose**: This test makes sure the import marker is shown without being stored as the turn’s last real assistant answer. That distinction avoids confusing imported-history bookkeeping with an actual assistant reply.

**Data flow**: It writes a temporary session containing a user request and assistant answer, imports it, builds visible turns, and confirms that the last displayed item is the import marker. It then looks back through the raw rollout items and checks that the final turn-complete event does not copy that marker into its `last_agent_message` field.

**Call relations**: The test goes through `load_session_for_import` and then inspects both the user-facing thread and the underlying rollout data. It specifically protects the behavior created by `external_session_imported_marker_item` and `turn_complete_item` working together.

*Call graph*: calls 1 internal fn (load_session_for_import); 7 external calls (new, assert_eq!, build_turns_from_rollout_items, jsonl, record, create_dir_all, write).


##### `tests::stores_imported_messages_as_response_items_and_visible_events`  (lines 266–307)

```
fn stores_imported_messages_as_response_items_and_visible_events()
```

**Purpose**: This test confirms that imported messages are saved in both important forms: visible events for the interface and response items for the stored conversation record.

**Data flow**: It creates a fake session with a long user request and a long assistant answer, imports it, then counts rollout items. It expects two stored response messages and two matching visible message events.

**Call relations**: The test calls `load_session_for_import`, which reaches `rollout_items_from_messages`. It checks that the converter calls `response_item` while also emitting user-message and agent-message events.

*Call graph*: calls 1 internal fn (load_session_for_import); 6 external calls (new, assert_eq!, jsonl, record, create_dir_all, write).


##### `tests::loads_custom_title_for_imported_session`  (lines 310–329)

```
fn loads_custom_title_for_imported_session()
```

**Purpose**: This test checks that a title explicitly provided by the source app is used for the imported session. That lets an imported chat keep the name the user or source tool gave it.

**Data flow**: It writes a temporary session containing a user message and a custom-title record. After importing the session, it reads the imported title and checks that it matches the custom title.

**Call relations**: The test calls `load_session_for_import`, which relies on the parsed data returned by `read_session_import`. It verifies the title-selection part of `load_session_for_import_with_content_sha256`.

*Call graph*: calls 1 internal fn (load_session_for_import); 7 external calls (new, assert_eq!, custom_title_record, jsonl, record, create_dir_all, write).


##### `tests::loads_ai_title_for_imported_session`  (lines 332–351)

```
fn loads_ai_title_for_imported_session()
```

**Purpose**: This test checks that an AI-generated title from the source app can also become the imported session title. This preserves useful naming even when the title was generated automatically.

**Data flow**: It writes a temporary session with a user message and an AI-title record. It imports the file and checks that the resulting session title is the AI-provided title.

**Call relations**: The test uses `load_session_for_import` to exercise the real loading path. It confirms that the parser and `load_session_for_import_with_content_sha256` pass through source titles, not just message text summaries.

*Call graph*: calls 1 internal fn (load_session_for_import); 7 external calls (new, assert_eq!, ai_title_record, jsonl, record, create_dir_all, write).


##### `tests::loads_custom_title_over_later_ai_title_for_imported_session`  (lines 354–374)

```
fn loads_custom_title_over_later_ai_title_for_imported_session()
```

**Purpose**: This test makes sure a custom title wins over a later AI-generated title. In human terms, a user-chosen name should not be overwritten by an automatic suggestion.

**Data flow**: It creates a fake session with a user message, a custom-title record, and then an AI-title record. After import, it checks that the final title is still the custom one.

**Call relations**: The test calls `load_session_for_import` and depends on `read_session_import` preserving title priority before the loader chooses the session title. It protects the rule that user/source custom naming takes precedence.

*Call graph*: calls 1 internal fn (load_session_for_import); 8 external calls (new, assert_eq!, ai_title_record, custom_title_record, jsonl, record, create_dir_all, write).


##### `tests::emits_token_usage_for_imported_history`  (lines 377–406)

```
fn emits_token_usage_for_imported_history()
```

**Purpose**: This test checks that imported history includes a token-count event. That matters because later parts of Codex use token counts to understand how much text is already in the conversation.

**Data flow**: It writes a temporary session with two user messages and one assistant message, imports it, searches the rollout items for a token-count event, and verifies that the reported token count is greater than zero and internally consistent.

**Call relations**: The test exercises `load_session_for_import`, which reaches `rollout_items_from_messages` and `token_count_item`. It protects the importer’s promise that imported sessions carry approximate usage information.

*Call graph*: calls 1 internal fn (load_session_for_import); 7 external calls (new, assert!, assert_eq!, jsonl, record, create_dir_all, write).


##### `tests::record`  (lines 408–416)

```
fn record(role: &str, text: &str, cwd: &Path) -> JsonValue
```

**Purpose**: This test helper builds one fake chat-message record in the same JSON shape expected from an external session file. It keeps the test setup short and consistent.

**Data flow**: It receives a role name, message text, and working-directory path. It adds the current timestamp and returns a JSON object containing the type, directory, timestamp, and message content.

**Call relations**: Most tests call this helper when writing temporary JSON-lines session files. Those files are then passed into `load_session_for_import`, allowing the tests to exercise the importer with realistic input.

*Call graph*: 2 external calls (now, json!).


##### `tests::custom_title_record`  (lines 418–423)

```
fn custom_title_record(title: &str) -> JsonValue
```

**Purpose**: This test helper builds a fake JSON record for a custom session title. Tests use it to check how imported titles are chosen.

**Data flow**: It receives a title string. It returns a JSON object whose type is `custom-title` and whose custom title field contains that string.

**Call relations**: Title-related tests include this record in their temporary session files before calling `load_session_for_import`. It supplies the input needed to verify custom-title behavior.

*Call graph*: 1 external calls (json!).


##### `tests::ai_title_record`  (lines 425–430)

```
fn ai_title_record(title: &str) -> JsonValue
```

**Purpose**: This test helper builds a fake JSON record for an AI-generated session title. It lets tests cover automatically generated source titles without repeating JSON details.

**Data flow**: It receives a title string. It returns a JSON object whose type is `ai-title` and whose AI title field contains that string.

**Call relations**: The AI-title tests write this record into temporary JSON-lines files and then call `load_session_for_import`. It provides the source data used to confirm AI-title import behavior and title priority rules.

*Call graph*: 1 external calls (json!).


##### `tests::jsonl`  (lines 432–438)

```
fn jsonl(records: &[JsonValue]) -> String
```

**Purpose**: This test helper turns a list of JSON records into JSON Lines text, where each record is one JSON object on its own line. That matches the file format the importer reads.

**Data flow**: It receives a slice of JSON values. It converts each value to text, joins them with newline characters, and returns the resulting string for writing to a temporary session file.

**Call relations**: All the import tests use this helper before writing their fake session files to disk. The resulting file is then read through `load_session_for_import`, so tests start from the same line-based format as real imports.

*Call graph*: 1 external calls (iter).


### `rollout/src/policy.rs`

`domain_logic` · `cross-cutting`

A rollout file is a saved record of what happened during an agent run. Not every internal event belongs there. Some events are meaningful milestones, like a user message, an agent reply, a tool result, or a completed turn. Others are short-lived progress updates, streaming fragments, approval prompts, or startup chatter that would make the saved record bulky and harder to replay.

This file is the policy for that choice. It answers a simple question: “Should this item be kept?” It does that for several kinds of records. A RolloutItem is the broad wrapper used by the rollout system. It may contain a model response item, an event message, inter-agent communication, or session markers. The top-level function checks the wrapper and then delegates to more specific rules.

The rules are intentionally explicit. Each known message or event type is listed as either saved or not saved, which makes the behavior predictable when reading the code. One important detail is that memory persistence has its own rule: developer messages are not saved for memories, and many internal reasoning or compaction records are excluded. In everyday terms, this file is like an archivist’s checklist: it keeps the official minutes and useful artifacts, but leaves out passing notes and typing indicators.

#### Function details

##### `is_persisted_rollout_item`  (lines 6–16)

```
fn is_persisted_rollout_item(item: &RolloutItem) -> bool
```

**Purpose**: This is the main yes-or-no check for whether one rollout item should be written to the saved rollout history. It looks at the broad kind of item first, then uses the more detailed policy for response items or event messages.

**Data flow**: It receives one RolloutItem. If the item wraps a model response, it asks should_persist_response_item. If it wraps an event message, it asks should_persist_event_msg. If it is inter-agent communication or one of the important session/executive markers, it keeps it. The output is a boolean: true means save it, false means leave it out.

**Call relations**: persisted_rollout_items calls this function while scanning a batch of rollout items. This function is the middle step: it understands the outer RolloutItem shape, then hands the detailed decision to should_persist_response_item or should_persist_event_msg when needed.

*Call graph*: calls 2 internal fn (should_persist_event_msg, should_persist_response_item); called by 1 (persisted_rollout_items).


##### `persisted_rollout_items`  (lines 19–27)

```
fn persisted_rollout_items(items: &[RolloutItem]) -> Vec<RolloutItem>
```

**Purpose**: This function takes a list of rollout items and returns only the ones that should be saved. It is used when appending live activity to a rollout file so the file receives the canonical, filtered set.

**Data flow**: It receives a slice of RolloutItem values. It starts with a new empty list, checks each item with is_persisted_rollout_item, clones the items that pass the policy, and skips the ones that do not. The output is a new Vec of RolloutItem values containing only the saved records.

**Call relations**: This is the batch-level entry into the policy in this file. It repeatedly calls is_persisted_rollout_item, which then delegates to the response-item or event-message rules. The result is ready for the rollout-writing code to append without carrying unwanted temporary events.

*Call graph*: calls 1 internal fn (is_persisted_rollout_item); 1 external calls (new).


##### `should_persist_response_item`  (lines 31–50)

```
fn should_persist_response_item(item: &ResponseItem) -> bool
```

**Purpose**: This function decides whether a model response item should be saved in rollout files. It keeps the response records that represent meaningful conversation content, tool calls, tool results, searches, image generation, and compaction records, while dropping items that are only triggers or unknown placeholders.

**Data flow**: It receives a ResponseItem. It compares the item against the known response variants. Most substantive response items produce true. CompactionTrigger and Other produce false. The result is a boolean that tells the caller whether this response item belongs in the rollout history.

**Call relations**: is_persisted_rollout_item calls this when it sees a RolloutItem::ResponseItem. This function does not call other project functions; it is the response-specific checklist used by the top-level rollout filter.

*Call graph*: called by 1 (is_persisted_rollout_item).


##### `should_persist_response_item_for_memories`  (lines 54–73)

```
fn should_persist_response_item_for_memories(item: &ResponseItem) -> bool
```

**Purpose**: This function applies a separate saving rule for memories, which are long-term records used later as context. It is more selective than rollout persistence because memories should avoid some internal or sensitive system material, such as developer-role messages.

**Data flow**: It receives a ResponseItem. For normal messages, it reads the message role and keeps it unless the role is "developer". It also keeps several tool-call and tool-output records. It rejects agent-only messages, reasoning, image generation calls, compaction records, triggers, context compaction, and unknown items. The output is true if the response item may be stored for memories, otherwise false.

**Call relations**: This function is a standalone policy helper in this file. It is not called by the other listed functions here, which means memory-saving code elsewhere can use it without going through the rollout-file policy.


##### `should_persist_event_msg`  (lines 77–165)

```
fn should_persist_event_msg(ev: &EventMsg) -> bool
```

**Purpose**: This function decides whether an event message should be saved in rollout files. It keeps important milestones that are useful for replaying or understanding a run, and drops short-lived lifecycle, streaming, approval, startup, and progress events.

**Data flow**: It receives an EventMsg. It checks the event against a long explicit list. User and agent messages, reasoning summaries, patch completion, token counts, turn start and finish, web search completion, image generation completion, sub-agent activity, and similar durable events return true. Many begin-events, deltas, requests, warnings, setup notices, and transient collaboration or tool events return false. For ItemCompleted, it looks more closely and only keeps completions for plan and sleep items, because those do not have another raw item form to replay from. The output is a boolean decision.

**Call relations**: is_persisted_rollout_item calls this when a rollout item contains an EventMsg. Inside the ItemCompleted case, it uses Rust's matches! helper to make the special plan-or-sleep check concise. This function is the event-specific half of the rollout persistence policy.

*Call graph*: called by 1 (is_persisted_rollout_item); 1 external calls (matches!).


### `rollout/src/metadata.rs`

`orchestration` · `startup/background backfill and session metadata extraction`

A rollout file is the saved record of a conversation or session. This file reads those records and builds a compact summary: when the session started, which model/provider was used, what directory it ran in, git information, archive state, memory mode, and other details the rest of the app can query quickly. Without this, the system would still have raw session files on disk, but the state database would not know about them, so features like listing, resuming, filtering, or showing session details could miss old sessions.

The file has two main jobs. First, it extracts metadata from one rollout file. It looks for an explicit session metadata line inside the file. If that is missing, it falls back to clues in the filename, like a timestamp and session id. Then it replays the rollout items enough to update the summary with later information.

Second, it performs a backfill. Backfill means “scan old files and insert what we learn into the newer database.” It walks both active and archived session folders, sorts files into a stable order, skips work already checkpointed, processes files in batches, and writes results to the database. It also uses a lease, like a temporary “I am doing this job” sign, so two workers do not backfill at the same time.

#### Function details

##### `builder_from_session_meta`  (lines 37–62)

```
fn builder_from_session_meta(
    session_meta: &SessionMetaLine,
    rollout_path: &Path,
) -> Option<ThreadMetadataBuilder>
```

**Purpose**: Creates a metadata builder from the explicit session metadata stored inside a rollout file. This is the best source of truth because it was written by the session itself.

**Data flow**: It receives a session metadata line and the path to the rollout file. It parses the session timestamp into a UTC time, copies identity, source, model, agent, working directory, CLI version, and git details into a ThreadMetadataBuilder, and sets safe defaults for sandbox and approval settings. If the timestamp cannot be understood, it returns nothing.

**Call relations**: builder_from_items calls this when it finds a SessionMeta item in the rollout. This function does the focused work of turning that one rich metadata record into the builder that later becomes full thread metadata.

*Call graph*: calls 2 internal fn (parse_timestamp_to_utc, new); called by 1 (builder_from_items); 2 external calls (to_path_buf, new_read_only_policy).


##### `builder_from_items`  (lines 64–92)

```
fn builder_from_items(
    items: &[RolloutItem],
    rollout_path: &Path,
) -> Option<ThreadMetadataBuilder>
```

**Purpose**: Finds enough information in a rollout file’s items to start building thread metadata. It prefers real embedded session metadata, but can fall back to the rollout filename when older or incomplete files do not contain it.

**Data flow**: It receives all parsed rollout items and the rollout file path. First it searches the items for a SessionMeta record and, if found, delegates to builder_from_session_meta. If not found, it reads the file name, strips any compression-related naming, parses a timestamp and UUID from it, converts those into a creation time and thread id, and returns a basic metadata builder. If any required clue is missing or malformed, it returns nothing.

**Call relations**: extract_metadata_from_rollout uses this as the first step after loading a file. The call graph also shows apply_rollout_items using it in related reconstruction flows. It hands back the starting point that later rollout items can refine.

*Call graph*: calls 4 internal fn (from_string, parse_timestamp_uuid_from_filename, builder_from_session_meta, new); called by 2 (extract_metadata_from_rollout, apply_rollout_items); 6 external calls (from_timestamp, file_name, to_path_buf, default, parse_rollout_file_name, iter).


##### `extract_metadata_from_rollout`  (lines 94–131)

```
async fn extract_metadata_from_rollout(
    rollout_path: &Path,
    default_provider: &str,
) -> anyhow::Result<ExtractionOutcome>
```

**Purpose**: Reads one rollout file and produces the final metadata summary that should be stored in the state database. This is the single-file extraction path used by backfill and reconciliation code.

**Data flow**: It receives a rollout path and a default model provider name. It loads the rollout items from disk, rejects empty files, builds initial metadata with builder_from_items, then walks every item and applies any metadata-changing information to the summary. It also uses the file’s modified time as the updated-at time when available. It returns an ExtractionOutcome containing the finished metadata, the most recent memory mode found in session metadata, and a count of parse errors.

**Call relations**: backfill_sessions_with_lease calls this for each discovered rollout file. Other flows such as resume matching and rollout reconciliation also call it when they need to compare or rebuild metadata from the saved file. It relies on RolloutRecorder for reading the file and on apply_rollout_item from the state layer for interpreting each saved item.

*Call graph*: calls 3 internal fn (builder_from_items, file_modified_time_utc, load_rollout_items); called by 4 (backfill_sessions_with_lease, resume_candidate_matches_cwd, reconcile_rollout, reconcile_rollout_preserves_existing_explicit_title); 2 external calls (anyhow!, apply_rollout_item).


##### `backfill_sessions`  (lines 133–145)

```
async fn backfill_sessions(
    runtime: &codex_state::StateRuntime,
    codex_home: &Path,
    default_provider: &str,
)
```

**Purpose**: Starts the normal session metadata backfill using the standard lease duration. It is a small wrapper so callers do not need to know the lease setting.

**Data flow**: It receives the state runtime, the Codex home directory, and the default provider. It passes those values plus the built-in lease length to backfill_sessions_with_lease. It does not return a value; its effect is to start and await the backfill work.

**Call relations**: wait_for_backfill_gate calls this when the system needs database metadata to be populated before proceeding. It delegates all real work to backfill_sessions_with_lease.

*Call graph*: calls 1 internal fn (backfill_sessions_with_lease); called by 1 (wait_for_backfill_gate).


##### `backfill_sessions_with_lease`  (lines 147–350)

```
async fn backfill_sessions_with_lease(
    runtime: &codex_state::StateRuntime,
    codex_home: &Path,
    default_provider: &str,
    backfill_lease_seconds: i64,
)
```

**Purpose**: Scans saved session files and writes their metadata into the state database, while making sure only one worker does that job at a time. This is the main backfill engine.

**Data flow**: It receives a state runtime, the Codex home path, the default provider, and a lease duration. It reads the current backfill state, tries to claim the lease, marks the job running, finds rollout files under active and archived session folders, sorts them by a stable watermark, and skips anything already checkpointed. For each file it extracts metadata, normalizes the working directory, preserves useful existing database fields when appropriate, fills archive time for archived files, upserts the thread metadata, and restores memory mode. After each batch it checkpoints progress, and at the end it marks the backfill complete. It also logs warnings and records metrics for successes, failures, parse errors, and duration.

**Call relations**: backfill_sessions calls this with the normal lease, and wait_for_backfill_gate can call it directly in controlled flows such as tests or gatekeeping. It calls collect_rollout_paths to find files, extract_metadata_from_rollout to understand each file, file_modified_time_utc for timestamps, normalize_cwd_for_state_db before database storage, and state runtime methods to read, claim, checkpoint, and update the database.

*Call graph*: calls 5 internal fn (collect_rollout_paths, extract_metadata_from_rollout, file_modified_time_utc, normalize_cwd_for_state_db, default); called by 2 (backfill_sessions, wait_for_backfill_gate); 15 external calls (default, join, new, global, info!, checkpoint_backfill, get_backfill_state, get_thread, mark_backfill_complete, mark_backfill_running (+5 more)).


##### `backfill_watermark_for_path`  (lines 359–364)

```
fn backfill_watermark_for_path(codex_home: &Path, path: &Path) -> String
```

**Purpose**: Creates the stable progress marker used to know how far the backfill has scanned. The marker is based on the rollout path relative to the Codex home directory.

**Data flow**: It receives the Codex home path and a rollout file path. It tries to remove the home directory prefix, converts the remaining path to text, and changes Windows-style backslashes into forward slashes. It returns that normalized string as the watermark.

**Call relations**: backfill_sessions_with_lease uses this when collecting rollout files, so it can sort them and later checkpoint progress. The function is not shown as being called elsewhere; it exists to keep watermark formatting consistent.

*Call graph*: 1 external calls (strip_prefix).


##### `file_modified_time_utc`  (lines 366–369)

```
async fn file_modified_time_utc(path: &Path) -> Option<DateTime<Utc>>
```

**Purpose**: Reads a file’s last modified time and converts it into a UTC timestamp. This gives metadata a reasonable updated or archived time when the rollout contents do not provide one directly.

**Data flow**: It receives a file path. It asks the compression/file helper for the modified time, handles missing or failed reads by returning nothing, and converts the timestamp into a DateTime in UTC when possible. The output is either a usable UTC time or no value.

**Call relations**: extract_metadata_from_rollout uses this to set a session’s updated-at time from the rollout file. backfill_sessions_with_lease uses it as a fallback archived-at time for files found in the archived sessions folder.

*Call graph*: calls 1 internal fn (file_modified_time); called by 2 (backfill_sessions_with_lease, extract_metadata_from_rollout); 1 external calls (from_timestamp).


##### `parse_timestamp_to_utc`  (lines 371–381)

```
fn parse_timestamp_to_utc(ts: &str) -> Option<DateTime<Utc>>
```

**Purpose**: Parses the timestamp text stored in session metadata into a UTC time. It supports both the project’s filename-like timestamp format and standard RFC 3339 timestamps, which are common internet date strings like `2024-01-01T12:00:00Z`.

**Data flow**: It receives a timestamp string. It first tries the local rollout filename style, then tries RFC 3339. If parsing succeeds, it returns the equivalent UTC time, trimming nanoseconds for the filename-style format. If neither format matches, it returns nothing.

**Call relations**: builder_from_session_meta calls this before it can create a metadata builder. If this parsing fails, that explicit metadata line cannot be used for builder creation.

*Call graph*: called by 1 (builder_from_session_meta); 3 external calls (from_naive_utc_and_offset, parse_from_rfc3339, parse_from_str).


##### `collect_rollout_paths`  (lines 383–429)

```
async fn collect_rollout_paths(root: &Path) -> std::io::Result<Vec<PathBuf>>
```

**Purpose**: Finds rollout files under a directory tree. It is the file-system search step used before backfill can extract metadata.

**Data flow**: It receives a root directory. It walks through that directory and all nested directories using a stack, reads entries asynchronously, skips unreadable entries with warnings, descends into folders, ignores non-files, and uses the rollout file recognizer to keep only valid rollout files. It returns a list of paths to those rollout files.

**Call relations**: backfill_sessions_with_lease calls this separately for the active sessions folder and the archived sessions folder. It hands back the raw file list that the backfill code turns into sorted, checkpointable work.

*Call graph*: calls 1 internal fn (from_path); called by 1 (backfill_sessions_with_lease); 4 external calls (new, read_dir, vec!, warn!).


### `state/src/extract.rs`

`domain_logic` · `state indexing and thread metadata refresh`

A thread rollout is like a diary of everything that happened in a Codex session: session headers, turn settings, user messages, token counts, and other events. This file reads those diary entries and updates a ThreadMetadata record, which is the compact “index card” for the thread. Without this code, the database could store the raw history but would not reliably know the thread title, first user request, current model, safety settings, or token count.

The main doorway is apply_rollout_item. It looks at one rollout item and sends it to the small helper that understands that kind of item. Session metadata supplies stable facts such as the thread source, command-line version, current folder, agent details, provider, and Git repository data. Turn context supplies per-turn facts such as the model, reasoning effort, approval mode, and sandbox or permission profile. Event messages supply changing facts such as token usage, the first user-facing message, a preview, and sometimes a goal-based preview.

The file is careful about what it treats as a real user prompt. User messages wrapped with the protocol marker are stripped down to the human text. Blank image-only messages become the readable placeholder “[Image]”. Response items that happen to have a user role are deliberately ignored for title and first-message purposes, because they are not the same as incoming user events. The tests at the bottom document these edge cases.

#### Function details

##### `apply_rollout_item`  (lines 15–31)

```
fn apply_rollout_item(
    metadata: &mut ThreadMetadata,
    item: &RolloutItem,
    default_provider: &str,
)
```

**Purpose**: Updates a thread summary using one item from the saved conversation history. This is the main entry point for turning detailed rollout records into the compact metadata stored for a thread.

**Data flow**: It receives a mutable ThreadMetadata record, one RolloutItem, and a fallback model provider name. It inspects the item type, passes it to the helper for that type, then fills in the fallback provider if the metadata still has no provider. The same metadata object is changed in place; nothing separate is returned.

**Call relations**: The tests call this function to exercise the real update path. During that path it delegates session records to apply_session_meta_from_item, turn settings to apply_turn_context, events to apply_event_msg, and response items to apply_response_item.

*Call graph*: calls 4 internal fn (apply_event_msg, apply_response_item, apply_session_meta_from_item, apply_turn_context); called by 10 (event_msg_blank_user_message_without_images_keeps_first_user_message_empty, event_msg_image_only_user_message_sets_image_placeholder_preview, event_msg_thread_goal_sets_preview_only_and_later_user_sets_message_title, event_msg_user_messages_set_title_and_first_user_message, response_item_user_messages_do_not_set_title_or_first_user_message, session_meta_does_not_set_model_or_reasoning_effort, turn_context_does_not_override_session_cwd, turn_context_sets_cwd_when_session_cwd_missing, turn_context_sets_model_and_reasoning_effort, turn_context_sets_permission_profile_metadata).


##### `rollout_item_affects_thread_metadata`  (lines 34–45)

```
fn rollout_item_affects_thread_metadata(item: &RolloutItem) -> bool
```

**Purpose**: Answers whether a rollout item is worth considering when updating the thread summary stored in SQLite, the local database. It helps avoid unnecessary work for records that cannot change metadata.

**Data flow**: It receives a RolloutItem and checks its variant. It returns true for session metadata, turn context, token counts, user messages, and thread goal updates; it returns false for other event types, response items, inter-agent communication, and compacted records.

**Call relations**: This is a filtering helper. Code that scans rollout history can use it before deciding whether to run metadata extraction, while the actual field updates happen through apply_rollout_item and its helpers.


##### `apply_session_meta_from_item`  (lines 47–73)

```
fn apply_session_meta_from_item(metadata: &mut ThreadMetadata, meta_line: &SessionMetaLine)
```

**Purpose**: Copies stable session-level facts into the thread summary. These are facts like where the session came from, which working directory it used, which CLI version created it, and what Git repository it was in.

**Data flow**: It receives mutable metadata and a SessionMetaLine. First it checks that the session metadata belongs to the same thread ID; if not, it ignores it to avoid mixing in data from a forked source thread. If it matches, it writes session source, thread source, agent fields, provider, CLI version, working directory, and optional Git commit, branch, and remote URL into the metadata.

**Call relations**: apply_rollout_item calls this when it sees a session metadata rollout item. It uses enum_to_string to turn enum-like protocol values into the plain strings stored in metadata.

*Call graph*: calls 1 internal fn (enum_to_string); called by 1 (apply_rollout_item).


##### `apply_turn_context`  (lines 75–84)

```
fn apply_turn_context(metadata: &mut ThreadMetadata, turn_ctx: &TurnContextItem)
```

**Purpose**: Copies facts about a particular conversation turn into the thread summary. This includes the model, reasoning effort, approval behavior, and sandbox or permission settings.

**Data flow**: It receives mutable metadata and a TurnContextItem. If the metadata has no working directory yet, it uses the turn’s folder as a fallback. It then stores the model, reasoning effort, serialized permission profile, and approval mode. The metadata is changed in place.

**Call relations**: apply_rollout_item calls this for turn context records. It calls permission_profile on the turn context to get the effective safety profile, serializes it to text for storage, and uses enum_to_string to store the approval policy as a simple string.

*Call graph*: calls 2 internal fn (permission_profile, enum_to_string); called by 1 (apply_rollout_item); 1 external calls (to_string).


##### `apply_event_msg`  (lines 86–114)

```
fn apply_event_msg(metadata: &mut ThreadMetadata, event: &EventMsg)
```

**Purpose**: Extracts metadata from live event messages, such as token counts, user prompts, and thread goal updates. These events are what usually provide the visible title and preview for a thread.

**Data flow**: It receives mutable metadata and an EventMsg. For token counts, it records the latest nonnegative total token use. For user messages, it builds a preview, records the first user message if none exists, sets the preview only if it is still empty, and creates a title from the message text if the title is empty. For thread goal updates, it uses the goal objective as a preview if no preview has been set.

**Call relations**: apply_rollout_item calls this for event message records. It relies on user_message_preview to make readable preview text, strip_user_message_prefix to remove protocol wrapping from raw user text, and set_preview_if_empty so earlier previews are not overwritten.

*Call graph*: calls 3 internal fn (set_preview_if_empty, strip_user_message_prefix, user_message_preview); called by 1 (apply_rollout_item).


##### `apply_response_item`  (lines 116–116)

```
fn apply_response_item(_metadata: &mut ThreadMetadata, _item: &ResponseItem)
```

**Purpose**: Currently does nothing for response items. Its presence makes the dispatch in apply_rollout_item explicit and leaves a clear place to add response-derived metadata later if needed.

**Data flow**: It receives mutable metadata and a ResponseItem, but it does not read or change either value. The metadata before and after the call is the same.

**Call relations**: apply_rollout_item calls this when it sees a response item. The tests confirm an important consequence: even response items with role "user" do not set the thread title or first user message.

*Call graph*: called by 1 (apply_rollout_item).


##### `set_preview_if_empty`  (lines 118–122)

```
fn set_preview_if_empty(metadata: &mut ThreadMetadata, preview: Option<String>)
```

**Purpose**: Sets the thread preview only if no preview has been chosen yet. This protects the first useful preview from being overwritten by later events.

**Data flow**: It receives mutable metadata and an optional preview string. If metadata.preview is empty, it stores the provided value; if a preview already exists, it leaves it unchanged.

**Call relations**: apply_event_msg calls this when processing user messages and thread goal updates. This is why an early goal preview can remain visible even after a later user message arrives.

*Call graph*: called by 1 (apply_event_msg).


##### `strip_user_message_prefix`  (lines 124–129)

```
fn strip_user_message_prefix(text: &str) -> &str
```

**Purpose**: Removes the protocol marker that can appear before the real user text. This turns stored wire-format text into something a person would expect to see as a title or preview.

**Data flow**: It receives raw text. If it finds the USER_MESSAGE_BEGIN marker, it returns the text after that marker with surrounding whitespace removed. If the marker is not present, it returns the trimmed original text.

**Call relations**: apply_event_msg uses it when forming a title, and user_message_preview uses it when forming preview text. It is the shared cleanup step for user-facing message text.

*Call graph*: called by 2 (apply_event_msg, user_message_preview).


##### `user_message_preview`  (lines 131–145)

```
fn user_message_preview(user: &UserMessageEvent) -> Option<String>
```

**Purpose**: Builds a short readable preview for a user message. It prefers actual text, but if the message only contains images it returns the placeholder “[Image]”.

**Data flow**: It receives a UserMessageEvent. It strips any protocol prefix from the message text; if text remains, it returns that text. If the text is empty but remote or local images are present, it returns the image placeholder. If there is neither text nor images, it returns no preview.

**Call relations**: apply_event_msg calls this when it sees a user message. It calls strip_user_message_prefix so preview text and title text are cleaned in the same way.

*Call graph*: calls 1 internal fn (strip_user_message_prefix); called by 1 (apply_event_msg).


##### `enum_to_string`  (lines 147–153)

```
fn enum_to_string(value: &T) -> String
```

**Purpose**: Converts serializable enum-like values into the plain strings used in ThreadMetadata. This avoids storing Rust debug formatting and instead uses the protocol’s JSON representation.

**Data flow**: It receives any value that can be serialized. It asks serde_json to turn it into a JSON value. If that JSON value is a string, it returns the string; if it is another JSON shape, it returns that shape as text; if serialization fails, it returns an empty string.

**Call relations**: apply_session_meta_from_item and apply_turn_context call this for fields such as session source and approval mode. Other parts of the crate, including build and test_thread_metadata according to the call graph, also use it when they need the same plain-string conversion.

*Call graph*: called by 4 (apply_session_meta_from_item, apply_turn_context, build, test_thread_metadata); 2 external calls (new, to_value).


##### `tests::response_item_user_messages_do_not_set_title_or_first_user_message`  (lines 185–202)

```
fn response_item_user_messages_do_not_set_title_or_first_user_message()
```

**Purpose**: Checks that response items do not count as incoming user messages for metadata purposes. This protects titles and first-message fields from being filled by the wrong kind of record.

**Data flow**: It creates test metadata and a response item whose role is "user" and whose content says hello. After passing that item through apply_rollout_item, it verifies that first_user_message, preview, and title are still empty.

**Call relations**: This test calls apply_rollout_item to prove the production dispatch reaches apply_response_item and leaves user-facing metadata unchanged for response items.

*Call graph*: calls 1 internal fn (apply_rollout_item); 4 external calls (assert_eq!, ResponseItem, metadata_for_test, vec!).


##### `tests::event_msg_user_messages_set_title_and_first_user_message`  (lines 205–224)

```
fn event_msg_user_messages_set_title_and_first_user_message()
```

**Purpose**: Checks the normal happy path for a real user event. A user message event should set the first user message, preview, and title.

**Data flow**: It creates test metadata and a user message event containing the protocol marker followed by real text. After apply_rollout_item runs, it expects the marker to be removed and the cleaned text to appear in first_user_message, preview, and title.

**Call relations**: This test drives apply_rollout_item through apply_event_msg, which then uses user_message_preview and strip_user_message_prefix.

*Call graph*: calls 1 internal fn (apply_rollout_item); 7 external calls (default, assert_eq!, format!, UserMessage, EventMsg, metadata_for_test, vec!).


##### `tests::event_msg_image_only_user_message_sets_image_placeholder_preview`  (lines 227–249)

```
fn event_msg_image_only_user_message_sets_image_placeholder_preview()
```

**Purpose**: Checks that an image-only user message still produces a useful preview. Instead of showing nothing, the metadata should show the placeholder “[Image]”.

**Data flow**: It creates test metadata and a user message event with no text but with an image URL. After apply_rollout_item runs, it verifies that first_user_message and preview contain the image placeholder, while title remains empty because there was no text to title the thread with.

**Call relations**: This test exercises apply_rollout_item and apply_event_msg, especially the image branch inside user_message_preview.

*Call graph*: calls 1 internal fn (apply_rollout_item); 7 external calls (default, new, assert_eq!, UserMessage, EventMsg, metadata_for_test, vec!).


##### `tests::event_msg_blank_user_message_without_images_keeps_first_user_message_empty`  (lines 252–268)

```
fn event_msg_blank_user_message_without_images_keeps_first_user_message_empty()
```

**Purpose**: Checks that a blank user message with no images does not create misleading metadata. Empty input should not become a fake title or preview.

**Data flow**: It creates test metadata and a user message event containing only whitespace and no images. After apply_rollout_item runs, it verifies that first_user_message, preview, and title remain empty.

**Call relations**: This test calls apply_rollout_item to cover the path where apply_event_msg asks user_message_preview for text and receives no usable preview.

*Call graph*: calls 1 internal fn (apply_rollout_item); 6 external calls (default, assert_eq!, UserMessage, EventMsg, metadata_for_test, vec!).


##### `tests::event_msg_thread_goal_sets_preview_only_and_later_user_sets_message_title`  (lines 271–312)

```
fn event_msg_thread_goal_sets_preview_only_and_later_user_sets_message_title()
```

**Purpose**: Checks how goal updates and later user messages share metadata fields. A thread goal can provide an early preview, but it should not become the first user message or title.

**Data flow**: It first applies a thread goal update with the objective “optimize the benchmark” and confirms that only preview is set. It then applies a normal user message and confirms that the existing preview stays the same, while first_user_message and title are filled from the later prompt.

**Call relations**: This test calls apply_rollout_item twice. The first call reaches the thread-goal branch of apply_event_msg and set_preview_if_empty; the second reaches the user-message branch and proves set_preview_if_empty does not overwrite the earlier preview.

*Call graph*: calls 1 internal fn (apply_rollout_item); 8 external calls (default, assert_eq!, format!, ThreadGoalUpdated, UserMessage, EventMsg, metadata_for_test, vec!).


##### `tests::turn_context_does_not_override_session_cwd`  (lines 315–380)

```
fn turn_context_does_not_override_session_cwd()
```

**Purpose**: Checks that the session’s working directory wins over a later turn context directory. This matters for forked or copied histories where turn context might describe a parent workspace instead of the child thread’s real workspace.

**Data flow**: It starts with metadata whose working directory is empty, applies session metadata with a child worktree path, then applies turn context with a different parent workspace path. It verifies that the child path remains, and also checks that sandbox and approval metadata are stored in their expected text forms.

**Call relations**: This test calls apply_rollout_item first through apply_session_meta_from_item and then through apply_turn_context. It documents the rule that turn context only fills the working directory when session metadata has not already done so.

*Call graph*: calls 2 internal fn (from_string, apply_rollout_item); 7 external calls (from, new, now_v7, assert_eq!, SessionMeta, TurnContext, metadata_for_test).


##### `tests::turn_context_sets_permission_profile_metadata`  (lines 383–416)

```
fn turn_context_sets_permission_profile_metadata()
```

**Purpose**: Checks that a turn’s explicit permission profile is what gets stored as sandbox metadata. This ensures the summary reflects the effective safety permissions rather than an older or less precise field.

**Data flow**: It creates a workspace-write permission profile and places it in a turn context. After apply_rollout_item runs, it compares metadata.sandbox_policy with the JSON text for that same permission profile.

**Call relations**: This test drives apply_rollout_item into apply_turn_context, covering the call to the turn context’s permission_profile logic and the JSON serialization step.

*Call graph*: calls 2 internal fn (workspace_write, apply_rollout_item); 4 external calls (from, assert_eq!, TurnContext, metadata_for_test).


##### `tests::turn_context_sets_cwd_when_session_cwd_missing`  (lines 419–449)

```
fn turn_context_sets_cwd_when_session_cwd_missing()
```

**Purpose**: Checks the fallback behavior for working directories. If session metadata did not provide a folder, the turn context folder should be used.

**Data flow**: It clears the test metadata’s working directory, then applies a turn context with a fallback workspace path. After apply_rollout_item runs, it verifies that metadata.cwd now contains that fallback path.

**Call relations**: This test calls apply_rollout_item and reaches apply_turn_context. It complements the non-overwrite test by showing when turn context is allowed to set the working directory.

*Call graph*: calls 1 internal fn (apply_rollout_item); 6 external calls (from, new, new_read_only_policy, assert_eq!, TurnContext, metadata_for_test).


##### `tests::turn_context_sets_model_and_reasoning_effort`  (lines 452–482)

```
fn turn_context_sets_model_and_reasoning_effort()
```

**Purpose**: Checks that turn context records populate the model and reasoning effort fields. These fields describe how the assistant was configured for that turn.

**Data flow**: It creates a turn context with model “gpt-5” and high reasoning effort. After apply_rollout_item runs, it verifies that those values were copied into the metadata.

**Call relations**: This test calls apply_rollout_item to exercise apply_turn_context’s model and reasoning-effort assignments.

*Call graph*: calls 1 internal fn (apply_rollout_item); 5 external calls (from, new_read_only_policy, assert_eq!, TurnContext, metadata_for_test).


##### `tests::session_meta_does_not_set_model_or_reasoning_effort`  (lines 485–518)

```
fn session_meta_does_not_set_model_or_reasoning_effort()
```

**Purpose**: Checks that session metadata does not fill fields that belong to turn context. This keeps long-lived session facts separate from per-turn model settings.

**Data flow**: It creates session metadata with normal session information and applies it to test metadata. After apply_rollout_item runs, it verifies that model and reasoning_effort are still unset.

**Call relations**: This test calls apply_rollout_item through apply_session_meta_from_item and confirms that model-specific fields are only set by apply_turn_context.

*Call graph*: calls 1 internal fn (apply_rollout_item); 4 external calls (from, assert_eq!, SessionMeta, metadata_for_test).


##### `tests::metadata_for_test`  (lines 520–549)

```
fn metadata_for_test() -> ThreadMetadata
```

**Purpose**: Builds a complete, predictable ThreadMetadata value for the tests. It keeps the tests focused on the one field or behavior they are checking.

**Data flow**: It creates a fixed thread ID, timestamp, rollout path, provider, working directory, CLI version, token count, and other default metadata fields. It returns a ThreadMetadata object that each test can modify or pass into apply_rollout_item.

**Call relations**: Most tests call this helper before exercising apply_rollout_item or metadata comparison. It is test support code, not part of the production metadata extraction flow.

*Call graph*: calls 1 internal fn (from_string); 4 external calls (from_timestamp, from, new, from_u128).


##### `tests::diff_fields_detects_changes`  (lines 552–561)

```
fn diff_fields_detects_changes()
```

**Purpose**: Checks that ThreadMetadata can report which fields differ between two metadata records. Although the diff method lives on the model type, this test confirms it behaves as expected with metadata shaped like this file produces.

**Data flow**: It creates a base metadata record, clones it, changes the clone’s token count and title, then asks the base record for the changed field names. It expects exactly “title” and “tokens_used”.

**Call relations**: This test uses metadata_for_test to create realistic metadata and then calls ThreadMetadata::diff_fields. It is included here because the extraction tests also rely on accurate metadata field behavior.

*Call graph*: calls 1 internal fn (from_string); 3 external calls (now_v7, assert_eq!, metadata_for_test).


### `thread-store/src/local/archive_thread.rs`

`domain_logic` · `request handling`

A “thread” here is a saved conversation, stored on disk as a rollout/session file. Archiving does not delete the conversation. It moves the file from the normal sessions area to an archived area, like moving a paper folder from your desk into a filing cabinet.

The main function first looks up the session file for the requested thread id. It may use both the filesystem and an optional state database to find it. If no matching file is found, it returns a clear “invalid request” error instead of silently doing nothing.

Before moving anything, it checks that the found path really belongs inside the expected sessions folder. This is an important safety step: it prevents a bad or surprising path from causing the code to move an unrelated file. It also checks that the file name matches the requested thread id, so the archive operation cannot accidentally move the wrong thread.

Once the file is verified, the code creates the archived sessions folder if it does not already exist, then renames the file into that folder. On most filesystems, “rename” is the operation used for moving a file. Finally, if a state database is present, the function tries to mark the thread as archived there too, recording the new path and the current time. That database update is best-effort: the file move is the core action.

#### Function details

##### `archive_thread`  (lines 11–61)

```
async fn archive_thread(
    store: &LocalThreadStore,
    params: ArchiveThreadParams,
) -> ThreadStoreResult<()>
```

**Purpose**: Archives one thread by finding its active session file, moving it to the archived sessions folder, and optionally updating the state database. This is used when a caller wants the thread hidden from normal active listings without deleting its saved data.

**Data flow**: It receives a local thread store and archive parameters containing the thread id. It reads the store configuration to find the Codex home folder, asks the store for an optional state database context, locates the rollout file for that thread id, checks that the path and file name are safe and correct, creates the archive folder if needed, and moves the file there. It returns success when the move completes, or a thread-store error if the thread cannot be found or the filesystem operation fails; if a state database is available, it also records the archived path and timestamp.

**Call relations**: This is the worker behind the local store’s archive operation. It leans on lookup code to find the thread file, helper checks to make sure the file is inside the expected sessions area and matches the requested id, filesystem calls to create the destination folder and move the file, and the state database to keep metadata in step with the moved file.

*Call graph*: calls 3 internal fn (state_db, matching_rollout_file_name, scoped_rollout_path); called by 1 (archive_thread); 4 external calls (now, find_thread_path_by_id_str, create_dir_all, rename).


##### `tests::archive_thread_moves_rollout_to_archived_collection`  (lines 82–125)

```
async fn archive_thread_moves_rollout_to_archived_collection()
```

**Purpose**: Checks the basic archive behavior from a user’s point of view: an active session file should disappear from the active location, reappear in the archived folder, and show up in archived thread listings.

**Data flow**: The test creates a temporary Codex home folder, builds a local thread store with no state database, writes a fake session file for a known thread id, and calls the archive operation. Afterward, it checks that the original file path no longer exists, that the same file name exists in the archived sessions folder, and that listing archived threads returns that thread with the archived path and archive time.

**Call relations**: This test drives the public store archive flow in a simple filesystem-only setup. It uses test helpers to create the store configuration and session file, then relies on the store’s listing behavior to confirm that the archive operation produces data other parts of the thread store can still read.

*Call graph*: calls 4 internal fn (from_string, new, test_config, write_session_file); 5 external calls (new, from_u128, new, assert!, assert_eq!).


##### `tests::archive_thread_updates_sqlite_metadata_when_present`  (lines 128–177)

```
async fn archive_thread_updates_sqlite_metadata_when_present()
```

**Purpose**: Checks the extra behavior that happens when the optional SQLite state database is present: archiving should update the database record as well as move the file. SQLite is a small file-based database used here to speed up and organize thread metadata.

**Data flow**: The test creates a temporary home folder, starts a state database runtime, writes a fake active session file, inserts matching thread metadata into the database, and then calls the archive operation. It then reads the thread metadata back from the database and verifies that the stored rollout path now points to the archived file and that an archive timestamp was recorded.

**Call relations**: This test covers the path where the archive function has both filesystem data and database metadata to update. It sets up the database state before calling the store archive operation, then reads directly from the runtime afterward to prove that the archive function handed the new path and time to the database layer.

*Call graph*: calls 6 internal fn (from_string, new, init, new, test_config, write_session_file); 5 external calls (new, now, from_u128, assert!, assert_eq!).


### `thread-store/src/local/unarchive_thread.rs`

`domain_logic` · `request handling`

This file solves the “bring this archived thread back” problem for the local thread store. Archived threads live in a separate folder, like boxes moved from an office desk into storage. Unarchiving means finding the right box, checking it really belongs in the archive area, moving it back to the regular sessions area, and then updating the labels so the rest of the system sees it as active again.

The main function starts with a thread id from the caller. It asks the rollout layer to find the archived session file for that id. A rollout file is the saved record of a conversation thread. Before moving anything, it checks that the path is safely inside the expected archived folder, which helps avoid accidentally moving an unrelated file. It then reads the date from the filename and rebuilds the normal sessions folder path, organized by year, month, and day.

After creating the destination folder, it renames the archived file into the active sessions folder. It updates the file’s modified time so the restored thread looks recently changed. If a SQLite state database is available, it marks the thread as unarchived there too. Finally, it reads the restored rollout file and turns it into a `StoredThread`, the thread summary object returned to callers.

The tests check both the file move and the optional database update.

#### Function details

##### `unarchive_thread`  (lines 15–101)

```
async fn unarchive_thread(
    store: &LocalThreadStore,
    params: ArchiveThreadParams,
) -> ThreadStoreResult<StoredThread>
```

**Purpose**: Restores one archived thread into the normal local sessions folder and returns its updated thread summary. Someone would use this when a user chooses to unarchive a conversation so it appears with active threads again.

**Data flow**: It receives a local thread store and an `ArchiveThreadParams` value containing the thread id. It looks up the archived rollout file, verifies the file is in the expected archived area, extracts the date from its filename, creates the matching normal sessions folder, moves the file there, updates its timestamp, optionally updates the state database, then reads the moved file back into a `StoredThread`. On success it returns that restored thread; on failure it returns a clear thread-store error.

**Call relations**: This function is the core worker used by the store’s unarchive operation. It asks `state_db` for optional database access, uses `find_archived_thread_path_by_id_str` to locate the archived file, uses `scoped_rollout_path` and `matching_rollout_file_name` to validate that the file is safe and matches the requested thread, uses `rollout_date_parts` to choose the destination folder, calls `touch_modified_time` after moving the file, and finally hands the restored rollout item to `stored_thread_from_rollout_item` so callers get the normal thread object back.

*Call graph*: calls 5 internal fn (state_db, matching_rollout_file_name, scoped_rollout_path, stored_thread_from_rollout_item, touch_modified_time); called by 1 (unarchive_thread); 6 external calls (find_archived_thread_path_by_id_str, read_thread_item_from_rollout, rollout_date_parts, format!, create_dir_all, rename).


##### `tests::unarchive_thread_restores_rollout_and_returns_updated_thread`  (lines 119–146)

```
async fn unarchive_thread_restores_rollout_and_returns_updated_thread()
```

**Purpose**: Checks the basic unarchive behavior without a state database. It proves that the archived file is removed from the archive folder, recreated in the normal sessions folder, and returned as an active thread with the expected preview text.

**Data flow**: The test creates a temporary home folder, builds a local store, writes a fake archived session file for a known thread id, then calls `unarchive_thread`. After the call, it checks that the old archived path no longer exists, the new sessions path exists, and the returned `StoredThread` has the right id, path, non-archived status, and message preview.

**Call relations**: This test sets up its store with `test_config`, creates the archived rollout using `write_archived_session_file`, then exercises the store’s unarchive path. Its assertions describe the expected result of the production `unarchive_thread` function from a user-visible point of view.

*Call graph*: calls 4 internal fn (from_string, new, test_config, write_archived_session_file); 4 external calls (new, from_u128, assert!, assert_eq!).


##### `tests::unarchive_thread_updates_sqlite_metadata_when_present`  (lines 149–199)

```
async fn unarchive_thread_updates_sqlite_metadata_when_present()
```

**Purpose**: Checks that unarchiving also updates SQLite metadata when the local store has a state database. This matters because the file system and the database must agree about where the thread lives and whether it is archived.

**Data flow**: The test creates a temporary home folder, writes an archived session file, starts a state database runtime, inserts metadata that says the thread is archived, and then calls `unarchive_thread`. Afterward it reads the database record and confirms the rollout path now points to the restored sessions file and `archived_at` has been cleared.

**Call relations**: This test builds the same kind of archived file setup as the basic test, but also uses `codex_state::StateRuntime::init` and thread metadata objects to prepare a database record. It then calls the store’s unarchive operation and verifies that the production function’s optional database update step happened correctly.

*Call graph*: calls 6 internal fn (from_string, new, init, new, test_config, write_archived_session_file); 4 external calls (new, now, from_u128, assert_eq!).


### `thread-store/src/local/update_thread_metadata.rs`

`domain_logic` · `request handling`

A thread has more than just messages. It also has searchable and displayable facts: its title, preview text, model, source, current folder, Git branch, and whether memory is enabled. This file is the place where those facts are changed for the local thread store.

The main job is careful coordination. Newer code stores thread metadata in SQLite, a small local database used for quick listing and filtering. Older and compatibility code also relies on rollout files, which are append-only JSONL transcript logs. Think of SQLite as the library card catalog and the rollout file as the original notebook. When some fields change, this file updates the card catalog, and for special fields like name, Git data, and memory mode it also writes a new note into the notebook so older readers still see the change.

The code treats different updates differently. Ordinary metadata learned from a transcript is best-effort: if the optional SQLite index is broken, the transcript should still remain usable. But explicit Git-only updates may need SQLite to preserve fields that were not mentioned in the patch, so those failures can block the update. The file also knows how to find active or archived rollout files, avoid changing the wrong thread by checking IDs, and preserve archived status when rebuilding missing database rows.

#### Function details

##### `update_thread_metadata`  (lines 37–176)

```
async fn update_thread_metadata(
    store: &LocalThreadStore,
    params: UpdateThreadMetadataParams,
) -> ThreadStoreResult<StoredThread>
```

**Purpose**: This is the main update path for changing a thread's metadata. It applies the requested patch, then performs extra compatibility writes to rollout files when fields like name, memory mode, or Git information need to be visible outside SQLite.

**Data flow**: It receives a local store and update parameters containing a thread id, a patch, and whether archived threads may be searched. If the patch is empty, it simply reads the thread back. Otherwise it writes metadata to SQLite through `apply_metadata_update`, decides whether rollout compatibility work is needed, locates or persists the rollout file, appends memory-mode or Git metadata when needed, updates the thread-name index when needed, and finally reads back a `StoredThread` as the result.

**Call relations**: The store's update operation reaches this function when a caller wants metadata changed. It delegates the broad SQLite update to `apply_metadata_update`, uses `resolve_rollout_path` and `refresh_resolved_rollout_path` to keep pointing at the current transcript file, calls rollout-specific helpers for name, memory mode, and Git information, and falls back to reading by rollout path if the normal read does not find the thread.

*Call graph*: calls 17 internal fn (reconcile_rollout, state_db, git_info_from_parts, persist_thread, rollout_path, read_thread, read_thread_by_rollout_path, apply_metadata_update, apply_thread_git_info, apply_thread_git_info_to_rollout (+7 more)); called by 1 (update_thread_metadata); 1 external calls (format!).


##### `refresh_resolved_rollout_path`  (lines 178–182)

```
async fn refresh_resolved_rollout_path(resolved: &mut ResolvedRolloutPath)
```

**Purpose**: This small helper refreshes a previously found rollout file path in case the real file has moved or been canonicalized. It keeps later writes aimed at the file that actually exists.

**Data flow**: It receives a mutable resolved path record. It asks the rollout layer for the existing path corresponding to that file, and if one is found it replaces the stored path with the fresher one. It returns nothing and only changes the path record.

**Call relations**: After `update_thread_metadata` appends memory-mode or Git metadata, it calls this helper before doing more rollout work. That keeps the rest of the update flow from writing to a stale file location.

*Call graph*: called by 1 (update_thread_metadata); 1 external calls (existing_rollout_path).


##### `apply_metadata_update`  (lines 184–353)

```
async fn apply_metadata_update(
    store: &LocalThreadStore,
    thread_id: ThreadId,
    patch: ThreadMetadataPatch,
    include_archived: bool,
    require_sqlite_write: bool,
) -> ThreadStoreResul
```

**Purpose**: This function applies the general metadata patch to the SQLite state database and then reads the updated thread back. It is the broad updater for fields such as preview, title, model, timestamps, source, permissions, tokens, first user message, current folder, and Git fields.

**Data flow**: It receives the store, thread id, patch, archived-search flag, and a flag saying whether SQLite failure must stop the update. It finds a live or stored rollout path if needed, reads any existing SQLite row, creates one from rollout information when appropriate, overlays each patch field, normalizes paths, converts enum-like values to strings, resolves partial Git changes, and writes the row back. It may also update the memory-mode index. It then returns the result of reading the thread, unless a required database write failed.

**Call relations**: `update_thread_metadata` calls this first so the main metadata index is updated before compatibility work. Inside, it leans on helpers such as `resolve_rollout_path`, `enum_to_string`, `normalize_cwd`, `resolve_git_info_patch`, `memory_mode_as_str`, and `sqlite_write_error_is_best_effort` to keep the update rules consistent.

*Call graph*: calls 11 internal fn (state_db, git_info_from_parts, permission_profile_to_metadata_value, rollout_path, read_thread, enum_to_string, memory_mode_as_str, normalize_cwd, resolve_git_info_patch, resolve_rollout_path (+1 more)); called by 1 (update_thread_metadata); 2 external calls (clone, warn!).


##### `needs_rollout_compatibility_update`  (lines 355–363)

```
fn needs_rollout_compatibility_update(patch: &ThreadMetadataPatch) -> bool
```

**Purpose**: This decides whether an update also needs to touch rollout files for backward compatibility. It focuses on fields that older readers still expect in rollout-derived places: name, memory mode, and some Git-only changes.

**Data flow**: It receives a metadata patch. It returns true for name changes, false for patches without memory-mode or Git changes, and for memory-mode or Git patches it checks whether the patch also contains observed transcript metadata. The output is a simple yes-or-no decision.

**Call relations**: `update_thread_metadata` uses this decision after the SQLite update. It calls `has_observed_metadata_facts` to distinguish explicit compatibility-sensitive changes from ordinary metadata refreshes.

*Call graph*: calls 1 internal fn (has_observed_metadata_facts); called by 1 (update_thread_metadata).


##### `sqlite_write_failure_should_block`  (lines 365–372)

```
fn sqlite_write_failure_should_block(patch: &ThreadMetadataPatch) -> bool
```

**Purpose**: This decides whether a SQLite write failure should stop the whole update. It protects explicit Git-only updates because partial Git patches need existing stored values to avoid accidentally erasing unspecified fields.

**Data flow**: It receives a metadata patch. If the patch contains Git information and no other observed metadata facts, it returns true; otherwise it returns false, allowing some database failures to be treated as log-only. It does not change anything.

**Call relations**: `update_thread_metadata` computes this before calling `apply_metadata_update`. It uses `has_observed_metadata_facts` to preserve older best-effort behavior for transcript-derived metadata and legacy rollout compatibility updates.

*Call graph*: calls 1 internal fn (has_observed_metadata_facts); called by 1 (update_thread_metadata).


##### `sqlite_write_error_is_best_effort`  (lines 374–376)

```
fn sqlite_write_error_is_best_effort(err: &ThreadStoreError) -> bool
```

**Purpose**: This classifies which thread-store errors are safe to treat as best-effort SQLite failures. In this file, internal SQLite-style failures can be logged instead of always stopping the update, depending on the patch.

**Data flow**: It receives a `ThreadStoreError` and checks its kind. It returns true when the error is an internal error, and false for other error categories. It has no side effects.

**Call relations**: `apply_metadata_update` uses this after attempting the SQLite write. Combined with the caller's blocking flag, it decides whether to return the error or only warn about it.

*Call graph*: called by 1 (apply_metadata_update); 1 external calls (matches!).


##### `has_observed_metadata_facts`  (lines 378–397)

```
fn has_observed_metadata_facts(patch: &ThreadMetadataPatch) -> bool
```

**Purpose**: This checks whether a patch contains metadata that was observed from the thread or environment, rather than only an explicit name, Git, or memory-mode command. Examples include preview text, model, timestamps, source, working directory, permissions, and token usage.

**Data flow**: It receives a metadata patch and inspects many optional fields. If any of those observed metadata fields are present, it returns true; otherwise it returns false. It does not modify the patch.

**Call relations**: `needs_rollout_compatibility_update` and `sqlite_write_failure_should_block` both use this helper to choose different safety rules for different kinds of updates.

*Call graph*: called by 2 (needs_rollout_compatibility_update, sqlite_write_failure_should_block).


##### `enum_to_string`  (lines 399–405)

```
fn enum_to_string(value: &T) -> String
```

**Purpose**: This converts a serializable value, commonly an enum, into the string form stored in SQLite metadata. It handles both enums that serialize directly as strings and values that serialize as other JSON shapes.

**Data flow**: It receives a value that can be serialized with Serde. It turns it into JSON; if the JSON is a string it extracts that string, otherwise it uses the JSON text form, and if serialization fails it returns an empty string.

**Call relations**: `apply_metadata_update` uses this when storing fields such as session source and approval mode, where the database keeps a string rather than the Rust enum value.

*Call graph*: called by 1 (apply_metadata_update); 2 external calls (new, to_value).


##### `normalize_cwd`  (lines 407–409)

```
fn normalize_cwd(cwd: PathBuf) -> PathBuf
```

**Purpose**: This cleans up a current-working-directory path before storing it. Normalizing paths helps later filters match equivalent paths, such as a folder written with `child/..`.

**Data flow**: It receives a path. It asks the shared path utility to normalize it for comparison; if that works, it returns the normalized path, and if not, it returns the original path unchanged.

**Call relations**: `apply_metadata_update` calls this whenever a patch supplies a current working directory. The normalized value later helps list and search operations find the right threads.

*Call graph*: called by 1 (apply_metadata_update); 2 external calls (as_path, normalize_for_path_comparison).


##### `apply_thread_git_info`  (lines 411–441)

```
async fn apply_thread_git_info(
    store: &LocalThreadStore,
    thread_id: ThreadId,
    sha: &Option<String>,
    branch: &Option<String>,
    origin_url: &Option<String>,
) -> ThreadStoreResult<()
```

**Purpose**: This writes already-resolved Git metadata into the SQLite state database. It is used after rollout compatibility metadata has been appended, so both storage forms agree.

**Data flow**: It receives the store, thread id, and optional commit SHA, branch, and remote URL. It obtains the state database, updates the Git columns for that thread, and returns success only if a row was actually updated. If the database is unavailable or the row disappeared, it returns an internal error.

**Call relations**: `update_thread_metadata` calls this after `apply_thread_git_info_to_rollout` succeeds. It relies on the store's state database and reports errors back to the main update flow.

*Call graph*: calls 1 internal fn (state_db); called by 1 (update_thread_metadata); 1 external calls (format!).


##### `resolve_git_info_patch`  (lines 443–459)

```
fn resolve_git_info_patch(
    existing: Option<GitInfo>,
    git_info: GitInfoPatch,
) -> (Option<String>, Option<String>, Option<String>)
```

**Purpose**: This merges a partial Git update with existing Git metadata. It lets callers change only one Git field, such as the branch, without losing the existing commit hash or repository URL.

**Data flow**: It receives the existing Git information, if any, and a Git patch whose fields may each be absent, set to a value, or explicitly cleared. It starts with the existing SHA, branch, and origin URL, applies only the fields mentioned in the patch, and returns the final three optional values.

**Call relations**: `apply_metadata_update` uses this while updating SQLite, and `update_thread_metadata` uses it again before writing Git metadata to rollout files. This shared helper keeps partial Git update behavior consistent.

*Call graph*: called by 2 (apply_metadata_update, update_thread_metadata).


##### `apply_thread_git_info_to_rollout`  (lines 461–495)

```
async fn apply_thread_git_info_to_rollout(
    rollout_path: &Path,
    thread_id: ThreadId,
    sha: &Option<String>,
    branch: &Option<String>,
    origin_url: &Option<String>,
    memory_mode: Op
```

**Purpose**: This appends updated Git metadata to a rollout transcript file. It also preserves the current memory-mode marker in the appended session metadata so replaying the rollout does not lose that setting.

**Data flow**: It receives a rollout path, thread id, optional Git fields, and optional memory-mode string. It reads the session metadata line from the rollout, verifies that the metadata belongs to the expected thread, replaces its Git data, sets memory mode from the supplied value, and appends a new `SessionMeta` item to the file. It returns an error if the file cannot be read or belongs to a different thread.

**Call relations**: `update_thread_metadata` calls this when Git metadata needs rollout compatibility. It uses rollout helpers to read the old session metadata and append the new item.

*Call graph*: called by 1 (update_thread_metadata); 4 external calls (append_rollout_item_to_path, read_session_meta_line, format!, SessionMeta).


##### `apply_thread_name`  (lines 497–521)

```
async fn apply_thread_name(
    store: &LocalThreadStore,
    thread_id: ThreadId,
    name: String,
) -> ThreadStoreResult<()>
```

**Purpose**: This records a user-visible thread name in both SQLite and the rollout name index. The name index lets code find the latest name even when reading from rollout files.

**Data flow**: It receives the store, thread id, and desired name. If SQLite is available, it updates the thread title there and fails if no metadata row exists. Then it appends the name to the rollout-side thread-name index under the configured Codex home directory. It returns success or a thread-store error.

**Call relations**: `update_thread_metadata` calls this only when the patch includes a name. It bridges the newer SQLite title field and the older rollout name lookup.

*Call graph*: calls 1 internal fn (state_db); called by 1 (update_thread_metadata); 2 external calls (append_thread_name, format!).


##### `apply_thread_memory_mode`  (lines 523–552)

```
async fn apply_thread_memory_mode(
    rollout_path: &Path,
    thread_id: ThreadId,
    memory_mode: ThreadMemoryMode,
) -> ThreadStoreResult<()>
```

**Purpose**: This appends a memory-mode change to the rollout transcript file. Memory mode controls whether a thread uses stored memory, and rollout replay must be able to see the latest value.

**Data flow**: It receives a rollout path, thread id, and memory-mode enum. It reads the file's session metadata, checks that the embedded id matches the expected thread, clears Git data so this update does not accidentally change Git metadata, writes the new memory-mode string, and appends that session metadata back to the rollout file.

**Call relations**: `update_thread_metadata` calls this when a patch changes memory mode and rollout compatibility is needed. It calls `memory_mode_as_str` for the stored text form and rollout append helpers for the actual file write.

*Call graph*: calls 1 internal fn (memory_mode_as_str); called by 1 (update_thread_metadata); 4 external calls (append_rollout_item_to_path, read_session_meta_line, format!, SessionMeta).


##### `memory_mode_as_str`  (lines 554–559)

```
fn memory_mode_as_str(mode: ThreadMemoryMode) -> &'static str
```

**Purpose**: This converts the memory-mode enum into the exact text stored in SQLite and rollout metadata. It keeps the spellings consistent across the file.

**Data flow**: It receives either `Enabled` or `Disabled`. It returns the static string `enabled` or `disabled`. It has no side effects.

**Call relations**: `apply_metadata_update` uses it when writing the SQLite memory-mode index, and `apply_thread_memory_mode` uses it when appending memory mode to rollout metadata.

*Call graph*: called by 2 (apply_metadata_update, apply_thread_memory_mode).


##### `resolve_rollout_path`  (lines 561–608)

```
async fn resolve_rollout_path(
    store: &LocalThreadStore,
    thread_id: ThreadId,
    include_archived: bool,
) -> ThreadStoreResult<ResolvedRolloutPath>
```

**Purpose**: This finds the rollout transcript file for a thread. It can search live writer state, active session files, and, when allowed, archived session files.

**Data flow**: It receives the store, thread id, and whether archived threads may be considered. It first asks the live writer for an in-use path, then searches active rollout files, and finally searches archived files if allowed. It returns a path plus a flag telling whether that path is archived, or an invalid-request error if no matching thread is found.

**Call relations**: `update_thread_metadata` uses this before compatibility writes, and `apply_metadata_update` uses it when it needs to create or repair SQLite metadata from an existing rollout. It calls `rollout_path_is_archived` to mark live paths correctly.

*Call graph*: calls 3 internal fn (state_db, rollout_path, rollout_path_is_archived); called by 2 (apply_metadata_update, update_thread_metadata); 4 external calls (find_archived_thread_path_by_id_str, find_thread_path_by_id_str, format!, to_string).


##### `rollout_path_is_archived`  (lines 610–612)

```
fn rollout_path_is_archived(store: &LocalThreadStore, path: &Path) -> bool
```

**Purpose**: This checks whether a rollout file path lives under the archived sessions folder. It is a simple way to preserve archived status when metadata is rebuilt or updated.

**Data flow**: It receives the store and a path. It compares the path with the configured archived-session directory under Codex home and returns true if the rollout path starts there.

**Call relations**: `resolve_rollout_path` calls this after finding a live rollout path so the resolved result correctly says whether the thread is archived.

*Call graph*: called by 1 (resolve_rollout_path); 1 external calls (starts_with).


##### `tests::update_thread_metadata_sets_name_on_active_rollout_and_indexes_name`  (lines 638–662)

```
async fn update_thread_metadata_sets_name_on_active_rollout_and_indexes_name()
```

**Purpose**: This test proves that setting a thread name updates the returned thread and the rollout-side name index. It covers the no-SQLite path for an active rollout file.

**Data flow**: It creates a temporary home, writes a fake session file, updates the thread with a name patch, then reads the name index. The expected output is that both the returned thread and the index contain the new name.

**Call relations**: The Rust test runner invokes this test. It exercises the public store update path, which reaches `update_thread_metadata`, and then verifies the rollout name lookup used by compatibility readers.

*Call graph*: calls 4 internal fn (from_string, new, test_config, write_session_file); 5 external calls (default, new, from_u128, assert_eq!, find_thread_name_by_id).


##### `tests::update_thread_metadata_sets_memory_mode_on_active_rollout`  (lines 665–702)

```
async fn update_thread_metadata_sets_memory_mode_on_active_rollout()
```

**Purpose**: This test checks that a memory-mode update is written both to rollout metadata and to SQLite. It ensures replay and indexed reads agree.

**Data flow**: It creates a session and SQLite runtime, updates memory mode to disabled, reads the last rollout line, and reads the memory-mode value from SQLite. Both places are expected to show `disabled`.

**Call relations**: The test runner calls this test. It drives `update_thread_metadata`, which in turn uses `apply_metadata_update` and `apply_thread_memory_mode`.

*Call graph*: calls 5 internal fn (from_string, init, new, test_config, write_session_file); 5 external calls (default, new, from_u128, assert_eq!, last_rollout_item).


##### `tests::update_thread_metadata_preserves_memory_mode_when_updating_git_info`  (lines 705–771)

```
async fn update_thread_metadata_preserves_memory_mode_when_updating_git_info()
```

**Purpose**: This test makes sure that changing Git metadata does not erase a previously stored memory-mode setting. That matters because rollout replay uses session metadata markers cumulatively.

**Data flow**: It creates a thread, first sets memory mode to disabled, then updates only the Git branch. It checks the appended rollout metadata and reconciles the rollout back into SQLite to confirm memory mode is still disabled.

**Call relations**: The test runner calls this test. It exercises the main update flow's handoff from Git patch resolution to `apply_thread_git_info_to_rollout`, then uses rollout reconciliation to verify future readers will see the same state.

*Call graph*: calls 6 internal fn (from_string, reconcile_rollout, init, new, test_config, write_session_file); 5 external calls (default, new, from_u128, assert_eq!, last_rollout_item).


##### `tests::update_thread_metadata_uses_live_rollout_path_for_external_resume`  (lines 774–811)

```
async fn update_thread_metadata_uses_live_rollout_path_for_external_resume()
```

**Purpose**: This test confirms that a resumed live thread can use a rollout file outside the store's normal home directory. It protects updates for externally supplied transcript paths.

**Data flow**: It creates one home for the store and another for an external session file, resumes the thread from that external path, updates memory mode, and checks that the external file received the appended metadata.

**Call relations**: The test runner invokes this test. It goes through resume logic before calling the update path, which should get the path from the live writer rather than searching only the local home.

*Call graph*: calls 4 internal fn (from_string, new, test_config, write_session_file); 7 external calls (default, new, from_u128, assert!, assert_eq!, last_rollout_item, test_thread_metadata).


##### `tests::update_thread_metadata_sets_git_info`  (lines 814–854)

```
async fn update_thread_metadata_sets_git_info()
```

**Purpose**: This test checks that a full Git metadata patch is reflected in the returned thread. It covers commit hash, branch, and repository URL together.

**Data flow**: It sets up a thread with SQLite, applies a Git patch containing all three fields, then inspects the returned thread's Git information. The expected result is that all supplied values are present.

**Call relations**: The test runner calls this test. It exercises `update_thread_metadata`, including SQLite Git storage and rollout compatibility behavior for Git updates.

*Call graph*: calls 5 internal fn (from_string, init, new, test_config, write_session_file); 4 external calls (default, new, from_u128, assert_eq!).


##### `tests::update_thread_metadata_sets_permission_profile`  (lines 857–894)

```
async fn update_thread_metadata_sets_permission_profile()
```

**Purpose**: This test verifies that a permission profile is stored and read back correctly. A permission profile describes the sandbox or approval behavior allowed for the thread.

**Data flow**: It creates a thread with SQLite, updates the permission profile to disabled, checks the returned thread, then reads raw SQLite metadata to ensure the stored sandbox policy string matches the serialized profile.

**Call relations**: The test runner invokes this test. It specifically exercises the `permission_profile_to_metadata_value` conversion used inside `apply_metadata_update`.

*Call graph*: calls 5 internal fn (from_string, init, new, test_config, write_session_file); 4 external calls (default, new, from_u128, assert_eq!).


##### `tests::update_thread_metadata_partially_updates_git_info`  (lines 897–952)

```
async fn update_thread_metadata_partially_updates_git_info()
```

**Purpose**: This test proves that a partial Git update preserves fields that were not mentioned. For example, changing only the branch should keep the existing commit hash and repository URL.

**Data flow**: It first writes complete Git metadata, then sends a second patch containing only a new branch. It reads the returned thread and expects the branch to change while the SHA and URL stay the same.

**Call relations**: The test runner calls this test. It validates the behavior provided by `resolve_git_info_patch` through the public update path.

*Call graph*: calls 5 internal fn (from_string, init, new, test_config, write_session_file); 4 external calls (default, new, from_u128, assert_eq!).


##### `tests::update_thread_metadata_clears_git_info_fields`  (lines 955–1123)

```
async fn update_thread_metadata_clears_git_info_fields()
```

**Purpose**: This test covers deliberately clearing Git metadata fields and then updating them again later. It guards against stale Git data reappearing during rollout replay or memory-mode updates.

**Data flow**: It seeds full Git metadata, clears all Git fields, checks that the returned thread and appended rollout item show no Git information, reconciles the rollout, updates memory mode, deletes the SQLite row, and finally applies a partial Git update again. At each step it checks that cleared fields remain cleared unless explicitly set.

**Call relations**: The test runner invokes this comprehensive test. It exercises `resolve_git_info_patch`, `apply_thread_git_info_to_rollout`, `apply_thread_memory_mode`, and rollout reconciliation across several edge cases.

*Call graph*: calls 6 internal fn (from_string, reconcile_rollout, init, new, test_config, write_session_file); 6 external calls (default, new, from_u128, assert!, assert_eq!, last_rollout_item).


##### `tests::update_thread_metadata_rejects_mismatched_session_meta_id`  (lines 1126–1155)

```
async fn update_thread_metadata_rejects_mismatched_session_meta_id()
```

**Purpose**: This test ensures the updater refuses to write metadata into a rollout file whose embedded session id does not match the requested thread. This prevents corrupting the wrong transcript.

**Data flow**: It creates a rollout file, edits its contents so the metadata id differs from the file's thread id, then tries to update memory mode. The expected output is an internal error mentioning the id mismatch.

**Call relations**: The test runner calls this test. It reaches the id check inside `apply_thread_memory_mode` through the normal update path.

*Call graph*: calls 4 internal fn (from_string, new, test_config, write_session_file); 6 external calls (default, new, from_u128, assert!, read_to_string, write).


##### `tests::update_thread_metadata_applies_combined_explicit_patch`  (lines 1158–1208)

```
async fn update_thread_metadata_applies_combined_explicit_patch()
```

**Purpose**: This test confirms that name, memory mode, and Git information can be updated together in one patch. It checks that the combined path does not make one compatibility write overwrite another.

**Data flow**: It creates a thread with SQLite, applies a patch containing a name, disabled memory mode, and Git branch, then checks the returned thread, the last rollout item, the name index, and SQLite memory mode.

**Call relations**: The test runner invokes this test. It drives the full `update_thread_metadata` orchestration where `apply_thread_memory_mode`, rollout reconciliation, `apply_thread_name`, and `apply_thread_git_info_to_rollout` all participate.

*Call graph*: calls 5 internal fn (from_string, init, new, test_config, write_session_file); 6 external calls (default, new, from_u128, assert_eq!, find_thread_name_by_id, last_rollout_item).


##### `tests::sqlite_failures_are_best_effort_for_legacy_rollout_compat_updates`  (lines 1211–1220)

```
fn sqlite_failures_are_best_effort_for_legacy_rollout_compat_updates()
```

**Purpose**: This unit test documents that SQLite failures should not block older compatibility-style updates for names and memory mode. The transcript-oriented storage should still be allowed to work.

**Data flow**: It builds patches for a name update and a memory-mode update, passes them to `sqlite_write_failure_should_block`, and expects false for both.

**Call relations**: The test runner calls this direct helper test. It verifies the policy used by `update_thread_metadata` before calling `apply_metadata_update`.

*Call graph*: 1 external calls (assert!).


##### `tests::sqlite_failures_are_best_effort_for_observed_metadata_updates`  (lines 1223–1237)

```
fn sqlite_failures_are_best_effort_for_observed_metadata_updates()
```

**Purpose**: This test documents that transcript-derived metadata updates should not fail the whole operation just because SQLite has an internal problem. These updates are treated as optional indexing work.

**Data flow**: It builds patches containing observed facts such as `updated_at` and preview text, including one with Git and memory mode mixed in. It checks that `sqlite_write_failure_should_block` returns false.

**Call relations**: The test runner invokes this helper-level test. It protects the behavior controlled by `has_observed_metadata_facts`.

*Call graph*: 1 external calls (assert!).


##### `tests::sqlite_failures_still_block_for_explicit_git_only_updates`  (lines 1240–1248)

```
fn sqlite_failures_still_block_for_explicit_git_only_updates()
```

**Purpose**: This test confirms that explicit Git-only updates still require SQLite success. Partial Git patches need existing stored values, so ignoring a database failure could lose information.

**Data flow**: It creates a patch containing only a Git branch update and checks that `sqlite_write_failure_should_block` returns true.

**Call relations**: The test runner calls this policy test. It verifies the stricter branch of `sqlite_write_failure_should_block` used by the main update flow.

*Call graph*: 1 external calls (assert!).


##### `tests::metadata_patch_applies_title_over_existing_name`  (lines 1251–1291)

```
async fn metadata_patch_applies_title_over_existing_name()
```

**Purpose**: This test shows that a later title patch can replace an earlier user-chosen name in SQLite-backed metadata. It reflects the file's rule that the explicit `title` field is applied after `name`.

**Data flow**: It creates a thread, first sets a name, then sends a patch with title and preview text. The returned thread is expected to show the title text as its name.

**Call relations**: The test runner invokes this test. It exercises field ordering inside `apply_metadata_update` through the public store update method.

*Call graph*: calls 5 internal fn (from_string, init, new, test_config, write_session_file); 4 external calls (default, new, from_u128, assert_eq!).


##### `tests::metadata_patch_applies_latest_preview_and_first_user_message`  (lines 1294–1349)

```
async fn metadata_patch_applies_latest_preview_and_first_user_message()
```

**Purpose**: This test checks that SQLite metadata stores the latest preview and first-user-message values from patches, while the returned thread may still derive display preview from the rollout transcript. It highlights the difference between indexed metadata and transcript-derived reading.

**Data flow**: It writes initial preview and first-message values, then writes later values. It reads the returned thread and raw SQLite metadata; SQLite should contain the later patch values, while the returned thread's display fields come from the test rollout content.

**Call relations**: The test runner calls this test. It exercises `apply_metadata_update` for preview and first-user-message fields, then compares that with `read_thread` behavior.

*Call graph*: calls 5 internal fn (from_string, init, new, test_config, write_session_file); 4 external calls (default, new, from_u128, assert_eq!).


##### `tests::observed_metadata_rejects_unknown_thread_without_rollout`  (lines 1352–1387)

```
async fn observed_metadata_rejects_unknown_thread_without_rollout()
```

**Purpose**: This test ensures an observed metadata patch cannot silently create a brand-new thread when no rollout file exists. Metadata should attach to a real thread, not invent one.

**Data flow**: It creates SQLite state but no session file, then tries to update preview metadata for a random thread id. The expected result is a `thread not found` invalid-request error and no SQLite row.

**Call relations**: The test runner invokes this test. It validates the `resolve_rollout_path` step used by `apply_metadata_update` when it needs to create missing metadata.

*Call graph*: calls 4 internal fn (from_string, init, new, test_config); 4 external calls (default, new, from_u128, assert!).


##### `tests::update_thread_metadata_recreates_missing_archived_sqlite_row_as_archived`  (lines 1390–1427)

```
async fn update_thread_metadata_recreates_missing_archived_sqlite_row_as_archived()
```

**Purpose**: This test checks that if SQLite metadata is missing for an archived rollout, updating metadata recreates the row as archived. It prevents archived threads from accidentally becoming active in the index.

**Data flow**: It writes an archived session file, creates SQLite state with no row, updates preview metadata with archived lookup enabled, then checks both the returned thread and SQLite row for an archived timestamp.

**Call relations**: The test runner calls this test. It exercises `resolve_rollout_path`, `rollout_path_is_archived`, and row creation inside `apply_metadata_update`.

*Call graph*: calls 5 internal fn (from_string, init, new, test_config, write_archived_session_file); 4 external calls (default, new, from_u128, assert!).


##### `tests::observed_metadata_normalizes_cwd_for_list_filters`  (lines 1430–1492)

```
async fn observed_metadata_normalizes_cwd_for_list_filters()
```

**Purpose**: This test proves that current-working-directory paths are normalized before storage. Without this, list filters could miss a thread because the same folder was written in a slightly different path form.

**Data flow**: It creates a workspace path and an equivalent unnormalized path using `..`, updates thread metadata with that path, checks SQLite for the normalized path, then lists threads filtered by the workspace. The thread should be found.

**Call relations**: The test runner invokes this test. It validates `normalize_cwd` as used by `apply_metadata_update`, and then confirms the value works with thread listing.

*Call graph*: calls 5 internal fn (from_string, init, new, test_config, write_session_file); 8 external calls (default, new, from_u128, new, assert_eq!, normalize_for_path_comparison, create_dir_all, vec!).


##### `tests::update_thread_metadata_keeps_archived_thread_archived_in_sqlite`  (lines 1495–1555)

```
async fn update_thread_metadata_keeps_archived_thread_archived_in_sqlite()
```

**Purpose**: This test ensures that updating the name of an archived thread does not clear its archived status in SQLite. It protects the archive boundary during metadata edits.

**Data flow**: It writes an archived rollout, reconciles it into SQLite as archived, updates the thread name with archived lookup enabled, then checks the returned thread and SQLite row still have archived timestamps.

**Call relations**: The test runner calls this test. It combines rollout reconciliation with the `update_thread_metadata` path and checks that `apply_metadata_update` preserves archived state.

*Call graph*: calls 6 internal fn (from_string, reconcile_rollout, init, new, test_config, write_archived_session_file); 4 external calls (default, new, from_u128, assert!).


##### `tests::update_thread_metadata_keeps_live_archived_thread_archived_in_sqlite`  (lines 1558–1619)

```
async fn update_thread_metadata_keeps_live_archived_thread_archived_in_sqlite()
```

**Purpose**: This test covers the case where an archived thread is also resumed as a live thread. Updating it should still leave it marked as archived.

**Data flow**: It writes an archived rollout, reconciles it into SQLite, resumes it through the live writer, updates its name, and checks both returned and stored metadata for archived status.

**Call relations**: The test runner invokes this test. It specifically exercises `resolve_rollout_path` when the live writer provides a path that points into the archived sessions area.

*Call graph*: calls 6 internal fn (from_string, reconcile_rollout, init, new, test_config, write_archived_session_file); 5 external calls (default, new, from_u128, assert!, test_thread_metadata).


##### `tests::test_thread_metadata`  (lines 1621–1627)

```
fn test_thread_metadata() -> ThreadPersistenceMetadata
```

**Purpose**: This helper builds minimal persistence metadata used when tests resume a thread. It supplies a current folder, test model provider, and enabled memory mode.

**Data flow**: It reads the process current directory and returns a `ThreadPersistenceMetadata` value with that directory, a fixed test provider string, and enabled memory mode.

**Call relations**: Resume-related tests call this helper when they need plausible metadata for `resume_thread` before exercising update behavior.

*Call graph*: 1 external calls (current_dir).


##### `tests::last_rollout_item`  (lines 1629–1637)

```
fn last_rollout_item(path: &std::path::Path) -> Value
```

**Purpose**: This helper reads the last JSON item from a rollout file so tests can inspect what an update appended. It is a simple test-only microscope for append-only rollout logs.

**Data flow**: It receives a path, reads the whole file as text, takes the last line, parses that line as JSON, and returns the parsed value. If reading or parsing fails, the test panics.

**Call relations**: Several tests call this after metadata updates to verify that `apply_thread_memory_mode` or `apply_thread_git_info_to_rollout` wrote the expected `SessionMeta` item.

*Call graph*: 2 external calls (from_str, read_to_string).


### Core result emission
These files turn streamed model and tool outcomes into persisted turn items, lifecycle callbacks, status updates, and user-visible command or diff records.

### `core/src/tools/events.rs`

`orchestration` · `tool execution and turn event reporting`

This file is the bridge between “a tool did something” and “the session can tell the user and the model what happened.” A tool here might be a shell command, a unified execution command, or an apply-patch operation that edits files. The file records the start of work, formats the result, reports success or failure, and updates the turn’s file-difference view when patches change the workspace.

The main idea is the ToolEmitter. Think of it like a receipt printer for tools: each kind of tool has different details, but all of them need a clear begin and end receipt. For shell-like commands, it emits command-start and command-end events with the command, working directory, output, exit code, duration, and status. For patches, it emits file-change items and may also emit a TurnDiff event, which is a text summary of file changes.

The file also handles awkward edge cases. A patch can fail or be denied after it already changed some files, so the code can still track the committed part and show the resulting diff. Rejections are normalized into clearer messages such as “exec command rejected by user.” The tests focus on these edge cases, especially making sure partial patch changes and empty diffs are reported correctly.

#### Function details

##### `ToolEventCtx::new`  (lines 39–51)

```
fn new(
        session: &'a Session,
        turn: &'a TurnContext,
        call_id: &'a str,
        turn_diff_tracker: Option<&'a SharedTurnDiffTracker>,
    ) -> Self
```

**Purpose**: Creates a small bundle of context that event-emitting code needs: the session, the current turn, the tool call id, and optionally the tracker for file diffs. It keeps later functions from having to pass these pieces around one by one.

**Data flow**: It receives references to the session, turn context, call id, and optional shared diff tracker. It stores those references together in a ToolEventCtx value. Nothing is sent or changed yet; this is just packaging information for later use.

**Call relations**: Higher-level tool flows such as handle_call, intercept_apply_patch, run_exec_like, and unified execution helpers create this context before asking ToolEmitter to report progress. The tests also build it directly so they can exercise patch and diff reporting in isolation.

*Call graph*: called by 9 (assert_failed_apply_patch_tracks_committed_delta, invalidation_emits_empty_turn_diff, net_zero_patch_emits_empty_turn_diff, handle_call, intercept_apply_patch, run_exec_like, emit_exec_end_for_unified_exec, emit_failed_exec_end_for_unified_exec, exec_command).


##### `tracker_update_for_known_delta`  (lines 81–93)

```
fn tracker_update_for_known_delta(
    environment_id: Option<&str>,
    delta: &'a AppliedPatchDelta,
) -> TurnDiffTrackerUpdate<'a>
```

**Purpose**: Decides whether a known patch result should update the turn’s file-difference tracker. It avoids sending pointless updates when a patch is exact but makes no actual change.

**Data flow**: It receives an optional environment id and an AppliedPatchDelta, which describes what a patch changed. If the delta is both exact and empty, it returns “do nothing.” Otherwise it returns an instruction to track that delta, carrying along the environment id if one was provided.

**Call relations**: ToolEmitter::emit uses this helper when an apply-patch tool succeeds or is rejected after partially applying changes. The resulting instruction is passed to emit_patch_end, which actually updates or skips the diff tracker.

*Call graph*: calls 2 internal fn (is_empty, is_exact).


##### `emit_exec_command_begin`  (lines 95–120)

```
async fn emit_exec_command_begin(
    ctx: ToolEventCtx<'_>,
    command: &[String],
    cwd: &AbsolutePathBuf,
    parsed_cmd: &[ParsedCommand],
    source: ExecCommandSource,
    interaction_input:
```

**Purpose**: Sends the event that says an execution command has started. This lets the session, user interface, or log know what command is running before any output arrives.

**Data flow**: It receives the event context, command words, working directory, parsed command details, command source, optional interaction input, and optional process id. It adds the current timestamp, copies the needed fields into an ExecCommandBegin event, and sends that event through the session.

**Call relations**: emit_exec_stage calls this when a shell or unified execution tool enters the Begin stage. It is the first half of the command event pair; emit_exec_end later sends the matching completion event.

*Call graph*: calls 1 internal fn (now_unix_timestamp_ms); called by 1 (emit_exec_stage); 3 external calls (to_vec, ExecCommandBegin, clone).


##### `ToolEmitter::shell`  (lines 144–152)

```
fn shell(command: Vec<String>, cwd: AbsolutePathBuf, source: ExecCommandSource) -> Self
```

**Purpose**: Builds a ToolEmitter for a normal shell command. It also parses the command into a structured form so later events can show more than just raw text.

**Data flow**: It receives the command as a list of strings, the working directory, and the source of the command. It runs the command through the parser, then returns a Shell emitter containing the raw command, parsed command, directory, and source.

**Call relations**: run_exec_like uses this when it is about to run a shell-style tool. After construction, the emitter can be asked to begin and finish the event stream for that command.

*Call graph*: calls 1 internal fn (parse_command); called by 1 (run_exec_like).


##### `ToolEmitter::apply_patch_for_environment`  (lines 154–164)

```
fn apply_patch_for_environment(
        changes: HashMap<PathBuf, FileChange>,
        auto_approved: bool,
        environment_id: String,
    ) -> Self
```

**Purpose**: Builds a ToolEmitter for a patch operation tied to a specific environment. The environment id matters because file diffs may need to be tracked separately for different execution environments.

**Data flow**: It receives the map of intended file changes, whether the patch was automatically approved, and the environment id. It returns an ApplyPatch emitter carrying those details so the patch can later be reported as started, completed, failed, or declined.

**Call relations**: handle_call and intercept_apply_patch use this when the tool being run is an apply-patch operation. ToolEmitter::emit later uses the stored file changes and environment id to create file-change events and update the diff tracker.

*Call graph*: called by 2 (handle_call, intercept_apply_patch).


##### `ToolEmitter::unified_exec`  (lines 166–180)

```
fn unified_exec(
        command: &[String],
        cwd: AbsolutePathBuf,
        source: ExecCommandSource,
        process_id: Option<String>,
    ) -> Self
```

**Purpose**: Builds a ToolEmitter for the unified execution path, which is another way the system runs commands. It keeps the optional process id so begin and end events can be connected to the same running process.

**Data flow**: It receives a command slice, working directory, command source, and optional process id. It parses the command, copies the command into owned storage, and returns a UnifiedExec emitter with all those details.

**Call relations**: exec_command and unified execution event helpers create this emitter before sending begin or end events. Once built, ToolEmitter::emit reports the command using the same shared execution-event path as normal shell commands.

*Call graph*: calls 1 internal fn (parse_command); called by 3 (emit_exec_end_for_unified_exec, emit_failed_exec_end_for_unified_exec, exec_command).


##### `ToolEmitter::emit`  (lines 182–338)

```
async fn emit(&self, ctx: ToolEventCtx<'_>, stage: ToolEventStage<'_>)
```

**Purpose**: Sends the correct session event for one stage of one tool. It is the central dispatcher that turns “shell began,” “patch succeeded,” or “command was rejected” into the right protocol message.

**Data flow**: It receives an event context and a ToolEventStage, then looks at both the emitter kind and the stage. For shell and unified execution tools, it builds an ExecCommandInput and passes the work to emit_exec_stage. For patches, it sends file-change start or completion events, decides the patch status, and passes patch output plus tracker instructions to emit_patch_end.

**Call relations**: ToolEmitter::begin calls this with the Begin stage, and ToolEmitter::finish calls it after turning a tool result or error into Success or Failure. It hands execution events to emit_exec_stage and patch completion work to emit_patch_end.

*Call graph*: calls 3 internal fn (new, emit_exec_stage, emit_patch_end); called by 2 (begin, finish); 2 external calls (new, FileChange).


##### `ToolEmitter::begin`  (lines 340–342)

```
async fn begin(&self, ctx: ToolEventCtx<'_>)
```

**Purpose**: Convenience method that announces a tool has started. Callers use it instead of manually building a Begin stage.

**Data flow**: It receives the event context. It calls ToolEmitter::emit with the Begin stage, which sends either a command-begin event or a file-change-started item depending on the emitter kind.

**Call relations**: This is the simple public entry into ToolEmitter::emit for startup reporting. Tool-running code can call begin before it actually waits for the command or patch result.

*Call graph*: calls 1 internal fn (emit).


##### `ToolEmitter::format_exec_output_for_model`  (lines 344–350)

```
fn format_exec_output_for_model(
        &self,
        output: &ExecToolCallOutput,
        ctx: ToolEventCtx<'_>,
    ) -> String
```

**Purpose**: Formats command output into the text that should be returned to the model. It applies the current turn’s truncation policy, meaning long output can be shortened in a consistent way.

**Data flow**: It receives an ExecToolCallOutput and the event context. It reads the turn’s truncation policy and delegates to the shared formatter, producing a single string suitable for the model response.

**Call relations**: ToolEmitter::finish uses this whenever command output must be returned to the model, whether the command succeeded, failed, timed out, or was denied.

*Call graph*: called by 1 (finish); 1 external calls (format_exec_output_for_model).


##### `ToolEmitter::finish`  (lines 352–430)

```
async fn finish(
        &self,
        ctx: ToolEventCtx<'_>,
        out: Result<ExecToolCallOutput, ToolError>,
        applied_patch_delta: Option<&AppliedPatchDelta>,
    ) -> Result<String, Func
```

**Purpose**: Completes a tool run by reporting the final event and returning the text or error that should go back to the model. It is where raw execution results are translated into user-visible status and model-facing responses.

**Data flow**: It receives the event context, either a successful ExecToolCallOutput or a ToolError, and an optional patch delta. It formats output when available, chooses a Success or Failure event, normalizes rejection messages, preserves partial patch changes when possible, sends the final event through emit, and returns either the formatted success text or a FunctionCallError telling the caller what to show the model.

**Call relations**: Tool-running code calls finish after the actual shell command or patch operation ends. It calls format_exec_output_for_model to prepare model text and ToolEmitter::emit to publish the final event.

*Call graph*: calls 2 internal fn (emit, format_exec_output_for_model); 5 external calls (Message, Output, Failure, format!, RespondToModel).


##### `ExecCommandInput::new`  (lines 443–459)

```
fn new(
        command: &'a [String],
        cwd: &'a AbsolutePathBuf,
        parsed_cmd: &'a [ParsedCommand],
        source: ExecCommandSource,
        interaction_input: Option<&'a str>,
```

**Purpose**: Packages the shared input details for an execution command. This avoids repeating the same group of command fields through the execution-event helpers.

**Data flow**: It receives references to the command, working directory, parsed command, source, optional interaction input, and optional process id. It returns an ExecCommandInput that simply holds those references for later event creation.

**Call relations**: ToolEmitter::emit creates this package before calling emit_exec_stage for shell and unified execution tools. emit_exec_stage and emit_exec_end then read from it to build begin and end events.

*Call graph*: called by 1 (emit).


##### `emit_exec_stage`  (lines 472–534)

```
async fn emit_exec_stage(
    ctx: ToolEventCtx<'_>,
    exec_input: ExecCommandInput<'_>,
    stage: ToolEventStage<'_>,
)
```

**Purpose**: Turns an execution tool’s stage into the right command event. It knows how to represent begin, success, normal failure, message-only failure, and user-declined execution.

**Data flow**: It receives the event context, packaged command input, and the stage. For Begin, it sends a start event. For output-bearing success or failure, it copies stdout, stderr, combined output, exit code, duration, formatted output, and chooses Completed or Failed. For message-only failures or rejections, it builds a synthetic failed or declined result with exit code -1. It then sends the end event when appropriate.

**Call relations**: ToolEmitter::emit calls this for Shell and UnifiedExec emitters. It delegates begin reporting to emit_exec_command_begin and final reporting to emit_exec_end.

*Call graph*: calls 2 internal fn (emit_exec_command_begin, emit_exec_end); called by 1 (emit); 2 external calls (new, format_exec_output_str).


##### `emit_exec_end`  (lines 536–564)

```
async fn emit_exec_end(
    ctx: ToolEventCtx<'_>,
    exec_input: ExecCommandInput<'_>,
    exec_result: ExecCommandResult,
)
```

**Purpose**: Sends the event that says an execution command has finished. This gives the session the final output, status, timing, and command identity.

**Data flow**: It receives the event context, the original command input, and the computed command result. It adds the current completion timestamp, copies command metadata, attaches stdout, stderr, combined output, exit code, duration, formatted output, and status, then sends an ExecCommandEnd event through the session.

**Call relations**: emit_exec_stage calls this for every execution stage that represents a finished command. It completes the event pair that starts with emit_exec_command_begin.

*Call graph*: calls 1 internal fn (now_unix_timestamp_ms); called by 1 (emit_exec_stage); 1 external calls (ExecCommandEnd).


##### `emit_patch_end`  (lines 566–618)

```
async fn emit_patch_end(
    ctx: ToolEventCtx<'_>,
    changes: HashMap<PathBuf, FileChange>,
    stdout: String,
    stderr: String,
    status: PatchApplyStatus,
    tracker_update: TurnDiffTracker
```

**Purpose**: Reports that a patch operation has finished and updates the visible turn diff when needed. This is what keeps file-change status and the overall diff view in sync.

**Data flow**: It receives the event context, file changes, stdout, stderr, final patch status, and an instruction for the diff tracker. First it emits a completed FileChange item with the status and output. Then, if a shared diff tracker exists, it locks the tracker, tracks a new delta, invalidates the diff, or does nothing. If the visible diff changed or was cleared, it sends a TurnDiff event with the current unified diff text.

**Call relations**: ToolEmitter::emit calls this for apply-patch success, failure, and rejection cases. The patch-related tests also call it directly to verify that empty diffs and invalidations are emitted correctly.

*Call graph*: called by 3 (emit, invalidation_emits_empty_turn_diff, net_zero_patch_emits_empty_turn_diff); 2 external calls (FileChange, TurnDiff).


##### `tests::assert_failed_apply_patch_tracks_committed_delta`  (lines 636–695)

```
async fn assert_failed_apply_patch_tracks_committed_delta(
        out: Result<ExecToolCallOutput, ToolError>,
        expected_status: PatchApplyStatus,
    )
```

**Purpose**: Test helper that checks a failed or rejected patch can still report file changes that were already committed. It protects against losing real edits just because the final patch status is not success.

**Data flow**: It receives a simulated tool result and the patch status expected in the emitted event. It creates a test session, a temporary directory, a diff tracker, and applies a patch that adds a file. Then it finishes an ApplyPatch emitter with the supplied failure result and the known delta. It reads emitted events and asserts that the patch status matches and the TurnDiff contains the added file and line.

**Call relations**: The denied and rejected patch tests both call this helper with different failure types. Inside, it uses ToolEventCtx::new and ToolEmitter::finish to exercise the same path real patch execution would use.

*Call graph*: calls 4 internal fn (make_session_and_context_with_dynamic_tools_and_rx, new, new, from_absolute_path); 9 external calls (new, from_secs, new, new, new, assert!, apply_patch, tempdir, timeout).


##### `tests::denied_apply_patch_tracks_committed_delta`  (lines 698–711)

```
async fn denied_apply_patch_tracks_committed_delta()
```

**Purpose**: Tests the case where the sandbox denies an apply-patch operation after some change information is known. A sandbox is the restricted environment that controls what a tool is allowed to do.

**Data flow**: It creates an ExecToolCallOutput with a nonzero exit code, wraps it in a sandbox Denied error, and passes that into the shared failed-patch helper. The expected visible patch status is Failed.

**Call relations**: This test relies on tests::assert_failed_apply_patch_tracks_committed_delta to do the full setup and event checking. It specifically verifies the denied-error branch in ToolEmitter::finish.

*Call graph*: 5 external calls (new, default, assert_failed_apply_patch_tracks_committed_delta, Codex, Sandbox).


##### `tests::rejected_apply_patch_tracks_committed_delta`  (lines 714–720)

```
async fn rejected_apply_patch_tracks_committed_delta()
```

**Purpose**: Tests the case where an apply-patch operation is rejected but already has a known committed delta. It makes sure the UI can still show what changed while marking the patch as declined.

**Data flow**: It creates a ToolError::Rejected with the common “rejected by user” message and passes it to the shared helper. The expected patch status is Declined, while the diff should still include the committed file change.

**Call relations**: This test calls tests::assert_failed_apply_patch_tracks_committed_delta. It covers the rejection branch in ToolEmitter::finish, including the path that carries an applied patch delta into the final event.

*Call graph*: 2 external calls (assert_failed_apply_patch_tracks_committed_delta, Rejected).


##### `tests::net_zero_patch_emits_empty_turn_diff`  (lines 723–773)

```
async fn net_zero_patch_emits_empty_turn_diff()
```

**Purpose**: Tests that when patches add and then remove the same content, the system emits an empty diff to show there are no remaining changes. This prevents stale file-change summaries from lingering.

**Data flow**: It creates a test session, temporary directory, and diff tracker. It applies one patch that adds a file and emits a patch end, then applies another patch that deletes the file and emits another patch end. It checks that the first TurnDiff shows the added line and the second TurnDiff is an empty string.

**Call relations**: This test calls emit_patch_end directly so it can focus on diff-tracker behavior. It also uses ToolEventCtx::new to provide the same context shape used during real tool execution.

*Call graph*: calls 5 internal fn (make_session_and_context_with_dynamic_tools_and_rx, new, emit_patch_end, new, from_absolute_path); 9 external calls (new, new, new, new, new, assert!, assert_eq!, apply_patch, tempdir).


##### `tests::invalidation_emits_empty_turn_diff`  (lines 776–814)

```
async fn invalidation_emits_empty_turn_diff()
```

**Purpose**: Tests that invalidating the diff tracker clears the visible turn diff. This matters when the system can no longer trust its accumulated patch history.

**Data flow**: It creates a test session, temporary directory, and tracker, applies a patch that adds a file, and manually records that delta in the tracker. Then it calls emit_patch_end with an Invalidate update. It reads emitted events and confirms the TurnDiff event contains an empty string.

**Call relations**: This test calls emit_patch_end directly to exercise the invalidation path. It verifies the behavior that ToolEmitter::emit uses when patch output is missing or the diff tracker must be reset.

*Call graph*: calls 5 internal fn (make_session_and_context_with_dynamic_tools_and_rx, new, emit_patch_end, new, from_absolute_path); 8 external calls (new, new, new, new, new, assert_eq!, apply_patch, tempdir).


### `core/src/turn_diff_tracker.rs`

`domain_logic` · `during a turn, after committed apply_patch mutations and before reporting changes`

When the assistant edits files with apply_patch, the rest of the system needs a clear summary of what changed in this turn. This file builds that summary from the patch results themselves. Think of it like a notebook: before a file is changed, it writes down the original text; after each add, delete, update, or move, it writes down the latest text. At the end it compares the original and latest versions and produces a familiar Git-style diff.

The tracker is careful about trust. It only works with “exact” patch deltas, meaning the patch result includes enough text to know the before-and-after content precisely. If a delta is not exact, the tracker marks itself invalid and stops producing a diff, because guessing would be misleading.

It tracks paths per environment, so the same filesystem path in two different workspaces does not get mixed up. It also remembers file moves, so a rename can be shown as one before-and-after comparison instead of a separate delete and add when possible. To stay fast, it caches rendered diffs using revision numbers and uses a short timeout when producing line-by-line diffs. The result is a current-turn diff that is exact, ordered, display-friendly, and safe to omit when the tracker cannot prove correctness.

#### Function details

##### `TrackedPath::new`  (lines 32–37)

```
fn new(environment_id: &str, path: &Path) -> Self
```

**Purpose**: Creates a path label that includes both the environment name and the file path. This prevents two workspaces from accidentally sharing the same tracked file entry.

**Data flow**: It receives an environment ID and a path reference. It copies the environment ID into owned text and copies the path into an owned path buffer. The result is a `TrackedPath` that can be stored in maps and compared later.

**Call relations**: When a patch change arrives, `TurnDiffTracker::apply_change` uses this to turn the patch’s raw path into the tracker’s environment-aware path key. Tests also create these keys directly when checking path and diff behavior.

*Call graph*: called by 2 (apply_change, large_rewrite_returns_promptly_and_preserves_exact_content); 1 external calls (to_path_buf).


##### `TurnDiffTracker::default`  (lines 64–77)

```
fn default() -> Self
```

**Purpose**: Builds an empty, valid tracker with no known file contents yet. It sets up all the internal tables the tracker will use during a turn.

**Data flow**: It takes no input. It creates empty maps for baseline text, current text, rename origins, display roots, and cached diffs; sets the revision counter to zero; and starts with no unified diff. The output is a fresh tracker ready to receive patch deltas.

**Call relations**: This is the underlying constructor used by `TurnDiffTracker::new`. It is also created directly in some system flows and tests that need the tracker’s initial state.

*Call graph*: called by 2 (invocation, multi_agent_v2_request_user_input_rejects_subagent_threads); 2 external calls (new, new).


##### `TurnDiffTracker::new`  (lines 81–83)

```
fn new() -> Self
```

**Purpose**: Provides the standard way to create a fresh turn diff tracker. Callers use it when they want default behavior without custom display roots.

**Data flow**: It receives no input and delegates to the default constructor. The result is an empty tracker that is valid and ready to record exact patch changes.

**Call relations**: Many turn, permission, and tool flows create a tracker this way before any edits happen. `TurnDiffTracker::with_environment_display_roots` also starts from this and then adds display-root information.

*Call graph*: called by 30 (fatal_tool_error_stops_turn_and_reports_error, guardian_allows_shell_command_additional_permissions_requests_past_policy_validation, guardian_allows_unified_exec_additional_permissions_requests_past_policy_validation, shell_command_allows_sticky_turn_permissions_without_inline_request_permissions_feature, strict_auto_review_turn_grant_forces_guardian_for_shell_command_policy_skip, rejects_escalated_permissions_when_policy_not_on_request, request_permissions_tool_rejects_unknown_environment_id, request_permissions_tool_resolves_relative_paths_against_selected_environment, test_tool_runtime, unified_exec_rejects_escalated_permissions_when_policy_not_on_request (+15 more)); 1 external calls (default).


##### `TurnDiffTracker::with_environment_display_roots`  (lines 85–91)

```
fn with_environment_display_roots(
        display_roots: impl IntoIterator<Item = (String, PathBuf)>,
    ) -> Self
```

**Purpose**: Creates a tracker that knows how to shorten displayed paths for one or more environments. This makes generated diffs easier to read by showing paths relative to workspace roots when possible.

**Data flow**: It receives pairs of environment IDs and root paths. It creates a fresh tracker, stores those roots in a lookup table, and returns the tracker with that display configuration applied.

**Call relations**: The turn runner uses this when it knows the workspace roots for the active environments. Tests use it to check that paths are displayed correctly, especially when more than one environment is involved.

*Call graph*: called by 3 (run_turn, tracker_with_root, tracks_same_absolute_path_across_multiple_environments); 2 external calls (into_iter, new).


##### `TurnDiffTracker::track_delta`  (lines 93–107)

```
fn track_delta(&mut self, environment_id: &str, delta: &AppliedPatchDelta)
```

**Purpose**: Records one committed patch delta into the tracker and refreshes the combined diff. This is the main entry point for feeding file changes into the tracker.

**Data flow**: It receives an environment ID and an applied patch delta. If the tracker is already invalid, it does nothing. If the delta is not exact, it invalidates the tracker. Otherwise it applies each file change, then rebuilds the stored unified diff from the updated before-and-after state.

**Call relations**: Higher-level code calls this after apply_patch succeeds. It hands individual file changes to `TurnDiffTracker::apply_change`, and once all are recorded it calls `TurnDiffTracker::refresh_unified_diff` so later readers can fetch the latest summary.

*Call graph*: calls 5 internal fn (changes, is_exact, apply_change, invalidate, refresh_unified_diff).


##### `TurnDiffTracker::invalidate`  (lines 109–113)

```
fn invalidate(&mut self)
```

**Purpose**: Marks the tracker as unable to produce a trustworthy diff. This is used when a patch result lacks exact enough information to prove the current-turn changes.

**Data flow**: It takes no extra input beyond the tracker itself. It flips the validity flag off, clears any cached rendered diffs, and removes the current unified diff. After this, the tracker no longer reports a diff.

**Call relations**: `TurnDiffTracker::track_delta` calls this when it sees a non-exact delta. That prevents later code from showing a possibly wrong diff.

*Call graph*: called by 1 (track_delta).


##### `TurnDiffTracker::get_unified_diff`  (lines 115–117)

```
fn get_unified_diff(&self) -> Option<String>
```

**Purpose**: Returns the current combined diff, if one is available. Callers use this when they want to display or send the net changes from the current turn.

**Data flow**: It reads the tracker’s stored unified diff. If a diff exists, it returns a copied string; if there are no changes or the tracker was invalidated, it returns nothing.

**Call relations**: This is the read side of the tracker: after `TurnDiffTracker::track_delta` has recorded changes and refreshed the diff, other parts of the system can call this to obtain the ready-to-use text.


##### `TurnDiffTracker::has_unified_diff`  (lines 119–121)

```
fn has_unified_diff(&self) -> bool
```

**Purpose**: Answers whether the tracker currently has a diff to report. It is a lightweight check that avoids copying the diff text.

**Data flow**: It reads the stored optional diff and returns true if one exists, false otherwise. It does not change the tracker.

**Call relations**: This supports callers that only need to know whether there are tracked changes, not the diff contents themselves.


##### `TurnDiffTracker::refresh_unified_diff`  (lines 123–183)

```
fn refresh_unified_diff(&mut self)
```

**Purpose**: Rebuilds the full current-turn diff from the tracker’s remembered original and latest file contents. It is the step that turns the notebook of changes into one readable report.

**Data flow**: It reads all baseline paths, current paths, known rename origins, display roots, revision numbers, and cached rendered diffs. It pairs renames where appropriate, sorts paths for stable output, reuses cached file diffs when the same revisions were already rendered, renders missing file diffs, and joins them into one string. It updates the diff cache and stores either the combined diff or nothing if there are no net changes.

**Call relations**: `TurnDiffTracker::track_delta` calls this after applying a patch delta. It asks `TurnDiffTracker::rename_pairs` which paths should be shown as moves, and it relies on `TurnDiffTracker::render_diff` to produce each individual file’s Git-style section.

*Call graph*: calls 1 internal fn (rename_pairs); called by 1 (track_delta); 4 external calls (new, new, new, take).


##### `TurnDiffTracker::apply_change`  (lines 185–211)

```
fn apply_change(&mut self, environment_id: &str, change: &AppliedPatchChange)
```

**Purpose**: Routes one patch file change to the right specialized updater. It translates the patch library’s add, delete, and update records into the tracker’s internal model.

**Data flow**: It receives an environment ID and one applied patch change. It wraps the change’s path in a `TrackedPath`, inspects whether the change is an add, delete, or update/move, and forwards the relevant text and paths to the matching helper. It changes the tracker’s remembered baseline and current content through those helpers.

**Call relations**: `TurnDiffTracker::track_delta` calls this for every change in an exact patch delta. It uses `TrackedPath::new` for source and move paths, then hands work to `TurnDiffTracker::apply_add`, `TurnDiffTracker::apply_delete`, or `TurnDiffTracker::apply_update`.

*Call graph*: calls 4 internal fn (new, apply_add, apply_delete, apply_update); called by 1 (track_delta).


##### `TurnDiffTracker::apply_add`  (lines 213–225)

```
fn apply_add(&mut self, path: TrackedPath, content: &str, overwritten_content: Option<&str>)
```

**Purpose**: Records that a file now exists with given content. It also handles the special case where an add overwrote an existing file, so the original overwritten text can still appear in the final diff.

**Data flow**: It receives a tracked path, the new content, and optional overwritten content. It removes any old rename-origin note for that path. If the file was not already known and overwritten text is available, it stores that overwritten text as the baseline. Then it stores the new content as the current version with a fresh revision number.

**Call relations**: `TurnDiffTracker::apply_change` calls this for add changes. It uses `TurnDiffTracker::tracked_content` to attach revision numbers to stored text, which later lets `TurnDiffTracker::refresh_unified_diff` know whether a cached diff is still valid.

*Call graph*: calls 1 internal fn (tracked_content); called by 1 (apply_change); 1 external calls (clone).


##### `TurnDiffTracker::apply_delete`  (lines 227–235)

```
fn apply_delete(&mut self, path: TrackedPath, content: &str)
```

**Purpose**: Records that a file has been removed. If the tracker had not seen the file before, it stores the deleted text as the original baseline so the deletion can be shown accurately.

**Data flow**: It receives a tracked path and the file content that was deleted. It removes any current version of the file. If there was no current version and no baseline yet, it saves the deleted content as the baseline. It also clears any rename-origin note for that path.

**Call relations**: `TurnDiffTracker::apply_change` calls this for delete changes. The stored baseline and missing current content are later compared by `TurnDiffTracker::refresh_unified_diff` to render a deleted-file diff.

*Call graph*: calls 1 internal fn (tracked_content); called by 1 (apply_change); 1 external calls (clone).


##### `TurnDiffTracker::apply_update`  (lines 237–280)

```
fn apply_update(
        &mut self,
        source_path: TrackedPath,
        move_path: Option<TrackedPath>,
        old_content: &str,
        overwritten_move_content: Option<&str>,
        new_con
```

**Purpose**: Records a file edit, and optionally a move or rename, while preserving the original before-text for the turn. This is what lets multiple edits collapse into one net before-and-after diff.

**Data flow**: It receives the source path, an optional destination path, old content, optional content overwritten at the destination, and new content. If the source file has not been tracked before, it saves the old content as the baseline. For a move, it may also save overwritten destination content as a baseline, removes the current source entry, stores the new content at the destination, and records where that destination came from. For a plain update, it stores the new content at the source path.

**Call relations**: `TurnDiffTracker::apply_change` calls this for update changes. It uses `TurnDiffTracker::tracked_content` for every stored text version, and its rename-origin records are later interpreted by `TurnDiffTracker::rename_pairs`.

*Call graph*: calls 1 internal fn (tracked_content); called by 1 (apply_change); 1 external calls (clone).


##### `TurnDiffTracker::tracked_content`  (lines 282–289)

```
fn tracked_content(&mut self, content: &str) -> TrackedContent
```

**Purpose**: Wraps file text with a unique revision number. The revision number is a simple change stamp used to decide whether a previously rendered diff can be reused.

**Data flow**: It receives content text. It reads the next revision number, increments the tracker’s counter, copies the text into owned storage, and returns both the text and revision together.

**Call relations**: The add, delete, and update helpers call this whenever they store a baseline or current file version. `TurnDiffTracker::refresh_unified_diff` later uses the revision numbers in its cache key.

*Call graph*: called by 3 (apply_add, apply_delete, apply_update).


##### `TurnDiffTracker::rename_pairs`  (lines 291–307)

```
fn rename_pairs(&self) -> HashMap<TrackedPath, TrackedPath>
```

**Purpose**: Finds file moves that can safely be shown as a rename-style before-and-after comparison. It filters out cases where a move would be misleading, such as when the origin still exists or the destination already had its own baseline.

**Data flow**: It reads the map from current paths to their original paths, plus the baseline and current content maps. For each possible move, it checks that the origin existed before, the destination exists now, the origin does not still exist now, and the destination did not already exist before. It returns a map from original path to destination path for the safe rename pairs.

**Call relations**: `TurnDiffTracker::refresh_unified_diff` calls this before rendering. The result tells the refresh step which two paths should be compared as one moved file instead of as unrelated delete and add sections.

*Call graph*: called by 1 (refresh_unified_diff).


##### `TurnDiffTracker::render_diff`  (lines 309–366)

```
fn render_diff(
        &self,
        left_path: &TrackedPath,
        left_content: Option<&str>,
        right_path: &TrackedPath,
        right_content: Option<&str>,
    ) -> Option<String>
```

**Purpose**: Builds one Git-style diff section for a single file comparison. It covers new files, deleted files, changed files, and moved files by comparing optional left and right contents.

**Data flow**: It receives the old path and optional old content, plus the new path and optional new content. If the contents are identical, it returns nothing. Otherwise it creates display paths, computes Git blob IDs for the old and new text, writes the diff headers, marks new or deleted files when needed, and asks the line-diff library to produce the changed lines with nearby context. It returns the finished diff text.

**Call relations**: `TurnDiffTracker::refresh_unified_diff` uses this whenever it cannot reuse a cached file diff. It calls `TurnDiffTracker::display_path` for readable paths and uses the Git object-ID helpers so the output looks like a normal Git diff.

*Call graph*: calls 1 internal fn (display_path); 2 external calls (format!, configure).


##### `TurnDiffTracker::rendered_diff_count`  (lines 369–371)

```
fn rendered_diff_count(&self) -> usize
```

**Purpose**: Reports how many file diffs were actually rendered during tests. This exists to check that caching works without exposing that test-only counter in normal builds.

**Data flow**: It reads the test-only counter stored in the tracker and returns the number. It does not change tracker state.

**Call relations**: Only test code uses this helper. It supports tests that verify `TurnDiffTracker::refresh_unified_diff` reuses cached renderings instead of recomputing unchanged file diffs.


##### `TurnDiffTracker::display_path`  (lines 373–385)

```
fn display_path(&self, path: &TrackedPath) -> String
```

**Purpose**: Turns an internal tracked path into the path text shown in a diff. It makes paths shorter and more consistent for readers.

**Data flow**: It receives a tracked path. If that path belongs to an environment with a known display root, it tries to strip that root so the path becomes relative. It changes Windows backslashes to forward slashes. If there are multiple environments, it prefixes the environment ID to avoid confusion. It returns the display string.

**Call relations**: `TurnDiffTracker::render_diff` calls this while building diff headers. The display-root data usually comes from `TurnDiffTracker::with_environment_display_roots`.

*Call graph*: called by 1 (render_diff); 1 external calls (format!).


##### `git_blob_oid`  (lines 388–390)

```
fn git_blob_oid(data: &[u8]) -> String
```

**Purpose**: Formats a Git blob object ID for some file bytes. A blob object ID is Git’s hash for one file’s exact content.

**Data flow**: It receives raw bytes. It asks `git_blob_sha1_hex_bytes` to compute the Git-compatible SHA-1 digest, then formats that digest as lowercase hexadecimal text. The output is the object ID string used in diff headers.

**Call relations**: `TurnDiffTracker::render_diff` uses this when writing the `index` line of a Git-style diff. It is a small formatting wrapper around the lower-level hash function.

*Call graph*: 1 external calls (format!).


##### `git_blob_sha1_hex_bytes`  (lines 393–400)

```
fn git_blob_sha1_hex_bytes(data: &[u8]) -> Output<sha1::Sha1>
```

**Purpose**: Computes the same SHA-1 digest Git uses for a file blob. Git does not hash only the file bytes; it also includes a small header with the word `blob` and the byte length.

**Data flow**: It receives raw file bytes. It builds the Git blob header from the byte length, feeds the header and then the file bytes into a SHA-1 hasher, and returns the finished digest bytes.

**Call relations**: `git_blob_oid` calls this to get the digest before turning it into text. This keeps the diff headers compatible with Git’s idea of file content identity.

*Call graph*: 2 external calls (format!, new).


### `core/src/agent/status.rs`

`domain_logic` · `cross-cutting during agent event processing and completion checks`

An agent produces many events while it works, but the rest of the system often needs a simpler answer: “What state is the agent in right now?” This file is the small translator that turns individual event messages into that answer. Think of it like a dashboard light in a car: the engine has many detailed signals, but the driver needs clear states like running, stopped, or error.

The main function looks at one emitted event at a time. If a turn starts, the agent becomes running. If a turn completes, the status becomes completed and carries the last message the agent produced. If a turn is aborted, the file distinguishes between expected stoppages, such as interruption or budget limit, and other abort reasons, which are treated as errors. Direct error events also become errored statuses, and a shutdown-complete event becomes shutdown. Events that do not change the agent’s overall status are ignored by returning no status update.

The second function answers a related question: “Can we stop waiting for this agent?” It treats pending, running, and interrupted as not final. Everything else is final. This matters for code that watches agent work, reports finished turns, recovers state, or waits until an operation is done.

#### Function details

##### `agent_status_from_event`  (lines 6–21)

```
fn agent_status_from_event(msg: &EventMsg) -> Option<AgentStatus>
```

**Purpose**: Turns one detailed event message into the agent status it implies. Code would use this when it receives events from an agent and wants to keep a simple, up-to-date status record.

**Data flow**: It receives an event message. It checks what kind of event it is: start, complete, abort, error, shutdown, or something unrelated. For status-changing events, it returns a new status; for example, completion includes the last agent message, and errors include an error message or abort reason. For events that do not affect status, it returns nothing.

**Call relations**: This function sits at the boundary between the detailed event stream and the simpler status view. Inside, it creates completed and errored status values when the event calls for them, including formatting unexpected abort reasons into readable error text. No direct callers are shown in the provided graph, so it is best understood as a reusable translator for any part of the agent flow that consumes emitted events.

*Call graph*: 3 external calls (format!, Completed, Errored).


##### `is_final`  (lines 23–28)

```
fn is_final(status: &AgentStatus) -> bool
```

**Purpose**: Answers whether a given agent status means there is no more work to wait for. It is used by code that needs to decide whether an agent turn or thread has reached an endpoint.

**Data flow**: It receives the current agent status. It compares that status against the non-final states: pending initialization, running, and interrupted. If the status is one of those, it returns false; for every other status, it returns true.

**Call relations**: This function is used by several higher-level flows that need a clear stopping rule. Completion watchers use it before deciding that work is done, notification code uses it before reporting a terminal turn, recovery code uses it when rebuilding running items, request handling uses it while processing calls, and waiting code uses it to know when it can stop waiting for a final status.

*Call graph*: called by 6 (maybe_start_completion_watcher, maybe_notify_parent_of_terminal_turn, find_finished_threads, recover_running_items, handle_call, wait_for_final_status); 1 external calls (matches!).


### `core/src/event_mapping.rs`

`domain_logic` · `conversation event processing`

The app receives conversation data in a fairly general protocol format: messages can contain text, images, reasoning notes, web search calls, image generation calls, and hidden context instructions. This file is the adapter that turns those raw pieces into the project’s own timeline items, like user messages, assistant messages, reasoning entries, and web search entries. Without it, later code would have to understand every low-level protocol shape itself, and hidden context updates could accidentally appear as normal chat messages.

A key job here is separating real conversation from “contextual” material. Contextual material means instructions or background snippets inserted by the system, such as permissions, model-switch notes, collaboration mode tags, or visible hook prompts. These are useful to the model, but they are not always part of the human-visible conversation and sometimes need to be trimmed during rollback.

For normal user messages, the file rebuilds user input as text and image entries. It also skips wrapper tags around images, like open and close markers, so the UI sees the actual image rather than the markup around it. For assistant messages, it keeps text and assigns an ID if one is missing. The main entry point, `parse_turn_item`, looks at each raw response item and chooses the matching internal item: user message, assistant message, reasoning, web search, or image generation.

#### Function details

##### `is_contextual_user_message_content`  (lines 38–40)

```
fn is_contextual_user_message_content(message: &[ContentItem]) -> bool
```

**Purpose**: Checks whether a user-message-shaped bundle is actually contextual material rather than a real user turn. This helps the app avoid treating system-inserted context as something the user typed.

**Data flow**: It receives a list of content pieces from a message. It scans those pieces and asks whether any piece matches the project’s definition of a contextual user fragment. It returns `true` if at least one such fragment is present, otherwise `false`; it does not change the message.

**Call relations**: This check is used before user messages are parsed, and also by code that trims pre-turn context, finds user turn boundaries, collects guardian transcript entries, and builds the current thread section. In those flows, it acts like a label on a folder: “this is context, not ordinary chat.”

*Call graph*: called by 5 (trim_pre_turn_context_updates, is_user_turn_boundary, parse_user_message, collect_guardian_transcript_entries, build_current_thread_section); 1 external calls (iter).


##### `is_contextual_dev_message_content`  (lines 47–49)

```
fn is_contextual_dev_message_content(message: &[ContentItem]) -> bool
```

**Purpose**: Checks whether a developer message contains any rollback-trimmable contextual fragment. This matters because developer messages can mix persistent instructions with temporary context, and the app needs to know when temporary context is present.

**Data flow**: It receives the content pieces from a developer message. It scans them with `is_contextual_dev_fragment`, looking for known context prefixes such as permissions instructions or model-switch markers. It returns `true` if it finds one; it leaves the input untouched.

**Call relations**: It is called during pre-turn context trimming. There, it helps decide whether a stored baseline should be invalidated or whether part of the developer-provided material belongs to the temporary context that can be rolled back.

*Call graph*: called by 1 (trim_pre_turn_context_updates); 1 external calls (iter).


##### `has_non_contextual_dev_message_content`  (lines 53–57)

```
fn has_non_contextual_dev_message_content(message: &[ContentItem]) -> bool
```

**Purpose**: Checks whether a developer message contains anything that is not part of the known temporary context prefix set. This protects real developer instructions from being treated as disposable context.

**Data flow**: It receives a list of content pieces. For each piece, it asks `is_contextual_dev_fragment`; if any piece is not contextual, it returns `true`. The output is a yes-or-no answer about whether durable, non-context content exists.

**Call relations**: It is used by the pre-turn context trimming flow alongside `is_contextual_dev_message_content`. Together, the two checks distinguish messages that are purely temporary context from messages that also contain developer text that should remain meaningful.

*Call graph*: called by 1 (trim_pre_turn_context_updates); 1 external calls (iter).


##### `is_contextual_dev_fragment`  (lines 59–70)

```
fn is_contextual_dev_fragment(content_item: &ContentItem) -> bool
```

**Purpose**: Recognizes one content piece as a special developer-context fragment by checking whether its text starts with a known marker. These markers identify things like permissions instructions, token budget notes, or collaboration mode settings.

**Data flow**: It receives one content item. If the item is not input text, it immediately returns `false`. If it is text, it trims leading spaces and compares the start of the text, ignoring letter case, against the known contextual prefixes. It returns `true` only when a prefix matches.

**Call relations**: This is the small helper behind the developer-message checks in this file. The public checks use it while scanning whole messages, so they can answer broader questions like “does this message contain temporary context?” or “does it contain anything else?”


##### `parse_user_message`  (lines 72–109)

```
fn parse_user_message(message: &[ContentItem]) -> Option<UserMessageItem>
```

**Purpose**: Turns raw user message content into a `UserMessageItem`, unless the message is actually contextual material. It preserves real text and images while hiding image wrapper tags from the final user-facing item.

**Data flow**: It receives a list of protocol content pieces. First it calls `is_contextual_user_message_content`; if the message is context-only, it returns `None`. Otherwise it walks through each piece: text becomes user text, images become user images, and special open/close text tags around images are skipped. If it sees output text inside a user message, it logs a warning. At the end, it returns a new user message built from the cleaned content.

**Call relations**: This function is used inside `parse_turn_item` when a raw response item has the role `user`. Before it creates an ordinary user turn, `parse_turn_item` gives hook prompts a chance to be parsed separately; if that does not apply, this function converts the content into the normal user-message form.

*Call graph*: calls 6 internal fn (is_contextual_user_message_content, new, is_image_close_tag_text, is_image_open_tag_text, is_local_image_close_tag_text, is_local_image_open_tag_text); 4 external calls (new, matches!, iter, warn!).


##### `parse_agent_message`  (lines 111–137)

```
fn parse_agent_message(
    id: Option<&String>,
    message: &[ContentItem],
    phase: Option<MessagePhase>,
) -> AgentMessageItem
```

**Purpose**: Turns raw assistant message content into an `AgentMessageItem`. It keeps the assistant’s text, carries through the message phase when present, and creates a new unique ID if the protocol item did not provide one.

**Data flow**: It receives an optional message ID, a list of content pieces, and an optional message phase. It collects input-text and output-text pieces as assistant text. If it finds an unexpected item, such as an image in an assistant message, it logs a warning. It then uses the supplied ID or generates a new UUID, and returns the completed assistant message item.

**Call relations**: This function is called by `parse_turn_item` whenever a raw response item is an assistant message. It is the assistant-side counterpart to `parse_user_message`, giving the rest of the app a consistent internal shape for assistant replies.

*Call graph*: called by 1 (parse_turn_item); 3 external calls (new, iter, warn!).


##### `parse_turn_item`  (lines 139–214)

```
fn parse_turn_item(item: &ResponseItem) -> Option<TurnItem>
```

**Purpose**: Converts one raw protocol `ResponseItem` into the internal `TurnItem` used in the conversation timeline. It is the main dispatcher in this file: it decides what kind of thing the raw item represents and builds the matching internal item.

**Data flow**: It receives a single protocol response item. If it is a message, it checks the role: user messages may become hook prompts or user messages, assistant messages become agent messages, and system or unknown roles are ignored. If it is reasoning, it extracts summary text and raw reasoning text. If it is a web search call, it records the action and query detail. If it is an image generation call, it copies the status, prompt, and result into an image generation item. It returns `Some` converted turn item when recognized, or `None` when the raw item should not appear in the timeline.

**Call relations**: This is called when initial context is inserted before the last real user message or summary. During that flow, it acts as the translator between the protocol’s mixed bag of response records and the app’s cleaner conversation history. It hands off user parsing to hook-prompt parsing or `parse_user_message`, assistant parsing to `parse_agent_message`, and web search detail extraction to `web_search_action_detail`.

*Call graph*: calls 2 internal fn (parse_agent_message, web_search_action_detail); called by 1 (insert_initial_context_before_last_real_user_or_summary); 6 external calls (new, AgentMessage, ImageGeneration, Reasoning, WebSearch, parse_visible_hook_prompt_message).


### `core/src/stream_events_utils.rs`

`orchestration` · `request handling`

When the model produces output, it can be many different things: a normal assistant message, hidden citation markup, a request to run a tool, search results, reasoning text, or a generated image encoded as text. This file sorts those outputs into the right path. Think of it like a mailroom for model events: each incoming parcel is inspected, cleaned up, recorded, and either delivered to the user interface, sent to a tool worker, or stored on disk.

The file also protects the conversation record. Completed items are written to session history quickly so cancellation later does not leave the transcript and internal rollout out of sync. Assistant text is cleaned before display: hidden citation markers are removed, and plan-only blocks can be stripped in plan mode. Memory citations are still detected before they disappear from the visible text, so the system can remember which stored memories were used.

For image generation, the file decodes the model’s base64 image payload, writes a PNG under the Codex home directory, and records instructions telling future turns where generated images are saved. For tool calls, it records the request and creates a future, meaning a piece of work that will finish later, to run the tool. It also decides when mailbox-style input should wait until the next turn, so late incoming messages do not interrupt a final answer.

#### Function details

##### `image_generation_artifact_path`  (lines 42–68)

```
fn image_generation_artifact_path(
    codex_home: &AbsolutePathBuf,
    session_id: &str,
    call_id: &str,
) -> AbsolutePathBuf
```

**Purpose**: Builds the standard file path where a generated image should be saved. It also cleans the session and call identifiers so unsafe characters cannot become awkward or dangerous file names.

**Data flow**: It receives the Codex home directory, a session id, and an image call id. It replaces any character outside letters, numbers, dashes, and underscores with underscores, then returns a path like a folder for generated images, then a folder for the session, then a PNG file for the call.

**Call relations**: Image-saving code uses this as the single source of truth for where images belong. It is called before saving an image, when reporting a failed save location, and when recording instructions that tell later conversation turns where image files will appear.

*Call graph*: calls 1 internal fn (join); called by 6 (handle_output_item_done_records_image_save_history_message, handle_output_item_done_skips_image_save_message_when_save_fails, persist_image_generation_item, record_image_generation_instructions, save_image_generation_result, image_generation_publication_is_finalized_by_core); 1 external calls (format!).


##### `strip_hidden_assistant_markup`  (lines 70–77)

```
fn strip_hidden_assistant_markup(text: &str, plan_mode: bool) -> String
```

**Purpose**: Removes assistant text that should not be shown as normal user-facing prose. This includes hidden citation markup, and in plan mode it also removes proposed-plan blocks.

**Data flow**: It takes raw assistant text and a flag saying whether the turn is in plan mode. It strips citation markers first, then optionally strips plan blocks, and returns only the cleaned visible text.

**Call relations**: It is used when the system wants the last visible assistant message from a response item. The deeper citation-aware variant is used when finalizing full turn items.

*Call graph*: called by 1 (last_assistant_message_from_item); 2 external calls (strip_citations, strip_proposed_plan_blocks).


##### `strip_hidden_assistant_markup_and_parse_memory_citation`  (lines 79–93)

```
fn strip_hidden_assistant_markup_and_parse_memory_citation(
    text: &str,
    plan_mode: bool,
) -> (
    String,
    Option<codex_protocol::memory_citation::MemoryCitation>,
)
```

**Purpose**: Cleans assistant text for display while also preserving any memory citation hidden inside it. This lets the UI show clean text without losing the record that a stored memory was used.

**Data flow**: It receives raw assistant text and whether plan mode is active. It separates visible text from citation markup, optionally removes plan blocks, parses the citation data into a memory citation object if one exists, and returns both the cleaned text and the optional citation.

**Call relations**: Final turn cleanup calls this when an assistant message is being turned into a stored turn item. The cleaned text stays in the message, while the parsed memory citation is saved with the item if it was not already present.

*Call graph*: calls 1 internal fn (parse_memory_citation); called by 1 (finalize_turn_item); 2 external calls (strip_citations, strip_proposed_plan_blocks).


##### `raw_assistant_output_text_from_item`  (lines 95–109)

```
fn raw_assistant_output_text_from_item(item: &ResponseItem) -> Option<String>
```

**Purpose**: Extracts the raw text parts from a model response item, but only if the item is an assistant message. It gives other code a simple way to ask, “What did the assistant actually say here?”

**Data flow**: It receives a response item. If the item is an assistant message, it joins together all output-text content pieces and returns that combined string; otherwise it returns nothing.

**Call relations**: Several flows use this as their first step before cleaning or inspecting assistant text. It feeds last-message detection, memory-citation detection, sampling request logic, and response timing tracking elsewhere in the system.

*Call graph*: called by 4 (try_run_sampling_request, last_assistant_message_from_item, record_stage1_output_usage_and_detect_memory_citation, response_item_records_turn_ttft).


##### `save_image_generation_result`  (lines 111–128)

```
async fn save_image_generation_result(
    codex_home: &AbsolutePathBuf,
    session_id: &str,
    call_id: &str,
    result: &str,
) -> Result<AbsolutePathBuf>
```

**Purpose**: Decodes a generated image from base64 text and writes it to disk as a PNG file. Base64 is a way to represent binary data, like an image, using ordinary text characters.

**Data flow**: It receives the Codex home directory, session id, image call id, and base64 image result. It decodes the text into bytes, builds the target path, creates the parent folders if needed, writes the bytes, and returns the path that was written.

**Call relations**: Image persistence calls this when an image generation item says the image is complete. It relies on the shared path builder so saved files and later instructions point to the same place.

*Call graph*: calls 1 internal fn (image_generation_artifact_path); called by 1 (persist_image_generation_item); 2 external calls (create_dir_all, write).


##### `persist_image_generation_item`  (lines 130–166)

```
async fn persist_image_generation_item(
    sess: &Session,
    turn_context: &TurnContext,
    image_item: &mut ImageGenerationItem,
) -> Option<AbsolutePathBuf>
```

**Purpose**: Attempts to save a completed generated image and updates the image item with the saved file path. If saving fails, it logs a warning but does not crash the whole turn.

**Data flow**: It receives the current session, turn context, and mutable image item. It clears any old saved path, tries to decode and write the image, stores the resulting path back into the item on success, and returns that path; on failure it returns nothing and leaves the item without a saved path.

**Call relations**: Final turn cleanup calls this for completed image generation items. If it succeeds, later image-instruction recording can tell future turns where images are stored; if it fails, the session continues but without a saved file.

*Call graph*: calls 2 internal fn (image_generation_artifact_path, save_image_generation_result); called by 1 (finalize_turn_item); 1 external calls (warn!).


##### `record_image_generation_instructions`  (lines 168–188)

```
async fn record_image_generation_instructions(
    sess: &Session,
    turn_context: &TurnContext,
    image_item: &ImageGenerationItem,
)
```

**Purpose**: Adds a hidden conversation note explaining where generated image files are saved. This helps future model turns know where to look for image artifacts created by the host.

**Data flow**: It receives the session, turn context, and an image generation item. If the image has no saved path, it does nothing. If it was saved, it builds the standard output directory and placeholder path, creates an instruction message, and records that message in the conversation history.

**Call relations**: Non-tool response handling calls this after an image generation turn item has been finalized. It only records the note after persistence has succeeded, so the transcript does not promise files that were not saved.

*Call graph*: calls 3 internal fn (into, new, image_generation_artifact_path); called by 1 (handle_non_tool_response_item); 1 external calls (record_conversation_items).


##### `record_completed_response_item`  (lines 191–203)

```
async fn record_completed_response_item(
    sess: &Session,
    turn_context: &TurnContext,
    item: &ResponseItem,
)
```

**Purpose**: Records a completed model response item in the conversation history using the default fact-detection path. It is a convenience wrapper for the more detailed recording function.

**Data flow**: It receives the session, turn context, and completed response item. It forwards them to the fuller recording function without precomputed facts, so that function will inspect the item itself.

**Call relations**: The main output handler uses this whenever it has not already finalized the item into richer facts. It keeps the common recording path short while still sharing the full logic underneath.

*Call graph*: calls 1 internal fn (record_completed_response_item_with_finalized_facts); called by 1 (handle_output_item_done).


##### `record_completed_response_item_with_finalized_facts`  (lines 205–244)

```
async fn record_completed_response_item_with_finalized_facts(
    sess: &Session,
    turn_context: &TurnContext,
    item: &ResponseItem,
    finalized_facts: Option<&FinalizedTurnItemFacts>,
)
```

**Purpose**: Writes a completed response item to conversation history and updates side effects that depend on what the item contained. Those side effects include deferring mailbox delivery, marking memory mode as polluted by external context, and recording memory citation use.

**Data flow**: It receives the session, turn context, response item, and optionally facts that were already computed while finalizing the item. It records the item, decides whether incoming mailbox messages should wait for the next turn, checks whether external context should disable memory behavior, records memory usage if a citation is present, and marks the turn as having used memory when appropriate.

**Call relations**: This is the central persistence step for completed model output. The main output handler calls it after tool calls and normal messages; the simple wrapper calls it when no finalized facts are available; plan-mode handling elsewhere can call it with facts that were already computed to avoid repeating work.

*Call graph*: calls 3 internal fn (mark_thread_memory_mode_polluted_if_external_context, record_stage1_output_usage_and_detect_memory_citation, record_stage1_output_usage_for_memory_citation); called by 3 (handle_assistant_item_done_in_plan_mode, handle_output_item_done, record_completed_response_item); 3 external calls (record_conversation_items, record_memory_citation_for_turn, from_ref).


##### `response_item_may_include_external_context`  (lines 246–253)

```
fn response_item_may_include_external_context(item: &ResponseItem) -> bool
```

**Purpose**: Answers whether a response item is the kind that may contain information from outside the current conversation, such as search results. This matters because external context can change how memory should be trusted or used.

**Data flow**: It receives a response item and checks whether it is a tool search call, tool search output, or web search call. It returns true for those external-context shapes and false for other item types.

**Call relations**: The memory-pollution check uses this as its filter. If this function says the item cannot include external context, the system skips the database update.

*Call graph*: called by 1 (mark_thread_memory_mode_polluted_if_external_context); 1 external calls (matches!).


##### `mark_thread_memory_mode_polluted_if_external_context`  (lines 255–271)

```
async fn mark_thread_memory_mode_polluted_if_external_context(
    sess: &Session,
    turn_context: &TurnContext,
    item: &ResponseItem,
)
```

**Purpose**: Marks the current thread’s memory mode as polluted when the configuration says external context should disable memory behavior and the item may contain such context. In plain terms, it puts up a warning flag that the conversation has mixed in outside material.

**Data flow**: It receives the session, turn context, and response item. It first checks the configuration and the item type; if either does not require action, it returns. Otherwise it asks the state database to mark this thread’s memory mode as polluted.

**Call relations**: Completed-item recording calls this after storing an item. In-flight draining elsewhere can also call it, so external-context effects are captured even outside the main happy path.

*Call graph*: calls 2 internal fn (response_item_may_include_external_context, mark_thread_memory_mode_polluted); called by 2 (drain_in_flight, record_completed_response_item_with_finalized_facts).


##### `record_stage1_output_usage_and_detect_memory_citation`  (lines 273–286)

```
async fn record_stage1_output_usage_and_detect_memory_citation(
    state_db_ctx: Option<&state_db::StateDbHandle>,
    item: &ResponseItem,
) -> bool
```

**Purpose**: Looks inside an assistant message for a hidden memory citation and records that the cited memory was used. It returns whether any memory citation was found.

**Data flow**: It receives an optional state database handle and a response item. It extracts raw assistant text, strips citation markup while keeping the citation data, parses that data as a memory citation, records usage for any cited memory threads, and returns true if a memory citation existed.

**Call relations**: Completed-item recording uses this when finalized facts did not already include a memory citation. It hands the actual database update to the citation-recording helper.

*Call graph*: calls 3 internal fn (raw_assistant_output_text_from_item, record_stage1_output_usage_for_memory_citation, parse_memory_citation); called by 1 (record_completed_response_item_with_finalized_facts); 1 external calls (strip_citations).


##### `record_stage1_output_usage_for_memory_citation`  (lines 288–301)

```
async fn record_stage1_output_usage_for_memory_citation(
    state_db_ctx: Option<&state_db::StateDbHandle>,
    memory_citation: &MemoryCitation,
) -> bool
```

**Purpose**: Records database usage for the memory threads named by a memory citation. This is how the system keeps track that a stored memory influenced an assistant output.

**Data flow**: It receives an optional state database handle and a parsed memory citation. It extracts thread ids from the citation; if there are none, it still reports that a citation existed. If there are ids and a database is available, it records usage for those ids, then returns true.

**Call relations**: It is called either directly when finalized facts already contain a memory citation, or indirectly after text inspection finds one. The higher-level recorder uses its true or false result to mark the turn as having a memory citation.

*Call graph*: calls 1 internal fn (thread_ids_from_memory_citation); called by 2 (record_completed_response_item_with_finalized_facts, record_stage1_output_usage_and_detect_memory_citation).


##### `apply_turn_item_contributors`  (lines 324–338)

```
async fn apply_turn_item_contributors(
    sess: &Session,
    turn_store: &ExtensionData,
    item: &mut TurnItem,
)
```

**Purpose**: Lets installed extensions add information to a turn item before it is finalized. Extensions are add-ons; each contributor gets a chance to enrich the item, and failures are logged instead of stopping the turn.

**Data flow**: It receives the session, per-turn extension data, and a mutable turn item. It asks the session’s extension service for contributor objects, runs each one with thread and turn data, lets them modify the item, and logs a warning if any contributor fails.

**Call relations**: Turn item finalization calls this when the selected policy says contributors should run. This gives extensions a hook before the item is emitted or recorded.

*Call graph*: called by 1 (finalize_turn_item); 1 external calls (warn!).


##### `finalize_non_tool_response_item`  (lines 357–402)

```
async fn finalize_non_tool_response_item(
    sess: &Session,
    turn_context: &TurnContext,
    contributor_policy: TurnItemContributorPolicy<'_>,
    item: &ResponseItem,
    plan_mode: bool,
) ->
```

**Purpose**: Converts a non-tool model response into a finished turn item and gathers useful facts about it. These facts help later code avoid re-reading the item to find the last assistant message, memory citation, or mailbox behavior.

**Data flow**: It receives the session, turn context, contributor policy, response item, and plan-mode flag. It asks the non-tool handler to parse and finalize the item, then inspects the resulting turn item: assistant messages may produce a last visible message and memory citation, image generation defers mailbox delivery, and other items usually have no special facts. It returns the turn item together with those facts, or nothing if the response could not become a turn item.

**Call relations**: The main output handler uses this for ordinary non-tool model output. Plan-mode assistant handling elsewhere also uses it, so both paths share the same cleanup and fact-gathering rules.

*Call graph*: calls 1 internal fn (handle_non_tool_response_item); called by 2 (handle_assistant_item_done_in_plan_mode, handle_output_item_done); 1 external calls (matches!).


##### `handle_output_item_done`  (lines 405–515)

```
async fn handle_output_item_done(
    ctx: &mut HandleOutputCtx,
    item: ResponseItem,
    previously_active_item: Option<TurnItem>,
) -> Result<OutputItemResult>
```

**Purpose**: This is the main dispatcher for a completed item from the model stream. It decides whether the item is a tool request, a normal message, a direct tool-error response, or a fatal error, then performs the right recording and follow-up work.

**Data flow**: It receives a handling context, a completed response item, and optionally the turn item that was already active. It tries to build a tool call from the item. If it is a real tool call, it records the item and returns a future that will run the tool. If it is normal output, it finalizes and emits the user-visible turn item, records the raw completed response, and returns the last assistant message if any. If the tool request should be answered directly, it records a function-call output message and asks for a follow-up model turn. If the error is fatal, it returns an error.

**Call relations**: The sampling loop calls this as model stream items finish. It hands tool work off to the tool runtime, hands normal content to finalization and session emission, and hands all completed items to the recording functions so history stays synchronized.

*Call graph*: calls 5 internal fn (finalize_non_tool_response_item, record_completed_response_item, record_completed_response_item_with_finalized_facts, response_input_to_response_item, build_tool_call); called by 1 (try_run_sampling_request); 10 external calls (pin, default, new, default, Run, Fatal, Text, clone, from_ref, info!).


##### `handle_non_tool_response_item`  (lines 517–553)

```
async fn handle_non_tool_response_item(
    sess: &Session,
    turn_context: &TurnContext,
    contributor_policy: TurnItemContributorPolicy<'_>,
    item: &ResponseItem,
    plan_mode: bool,
) -> Op
```

**Purpose**: Turns model outputs that are not tool calls into internal turn items, such as assistant messages, reasoning, web search calls, or image generation calls. It ignores unexpected tool-output items because those should arrive through a different path.

**Data flow**: It receives the session, turn context, contributor policy, response item, and plan-mode flag. For supported item types, it parses the response into a turn item, finalizes it, records image-generation instructions if relevant, and returns the turn item. For tool outputs or unknown shapes, it returns nothing.

**Call relations**: The main non-tool finalizer calls this first. The sampling loop can also call it directly, while finalization and image-instruction recording do the follow-up work for parsed items.

*Call graph*: calls 2 internal fn (finalize_turn_item, record_image_generation_instructions); called by 2 (try_run_sampling_request, finalize_non_tool_response_item); 2 external calls (parse_turn_item, debug!).


##### `finalize_turn_item`  (lines 555–586)

```
async fn finalize_turn_item(
    sess: &Session,
    turn_context: &TurnContext,
    contributor_policy: TurnItemContributorPolicy<'_>,
    turn_item: &mut TurnItem,
    plan_mode: bool,
)
```

**Purpose**: Performs the last cleanup on a turn item before it is shown or recorded. It lets extensions contribute, cleans hidden assistant markup, preserves memory citations, and saves completed generated images.

**Data flow**: It receives the session, turn context, contributor policy, mutable turn item, and plan-mode flag. It optionally runs extension contributors. If the item is an assistant message, it combines its text, strips hidden markup, parses any memory citation, and replaces the content with the cleaned text. If the item is a completed image generation, it saves the image and stores the saved path on the item.

**Call relations**: Non-tool response handling calls this after parsing a response into a turn item. Completed-item emission elsewhere can also call it, so the same cleanup rules are applied before a turn item becomes final.

*Call graph*: calls 3 internal fn (apply_turn_item_contributors, persist_image_generation_item, strip_hidden_assistant_markup_and_parse_memory_citation); called by 2 (handle_non_tool_response_item, emit_completed); 1 external calls (vec!).


##### `last_assistant_message_from_item`  (lines 588–603)

```
fn last_assistant_message_from_item(
    item: &ResponseItem,
    plan_mode: bool,
) -> Option<String>
```

**Purpose**: Returns the cleaned last assistant message from a response item, if there is one worth using. Empty text or text that only contained hidden markup is treated as no message.

**Data flow**: It receives a response item and plan-mode flag. It extracts raw assistant text, rejects empty strings, removes hidden markup, rejects text that becomes blank after cleanup, and returns the cleaned message if anything remains.

**Call relations**: Mailbox-deferral logic uses this to decide whether an assistant message counts as a final answer. Other turn-level code uses it to recover the last assistant message from stored response items.

*Call graph*: calls 2 internal fn (raw_assistant_output_text_from_item, strip_hidden_assistant_markup); called by 2 (get_last_assistant_message_from_turn, completed_item_defers_mailbox_delivery_to_next_turn).


##### `completed_item_defers_mailbox_delivery_to_next_turn`  (lines 605–621)

```
fn completed_item_defers_mailbox_delivery_to_next_turn(
    item: &ResponseItem,
    plan_mode: bool,
) -> bool
```

**Purpose**: Decides whether a completed item should make incoming mailbox messages wait until the next turn. This avoids interrupting final assistant answers or image generation results with late-arriving input.

**Data flow**: It receives a response item and plan-mode flag. Assistant messages defer mailbox delivery only if they are not commentary and have visible text after cleanup; image generation calls always defer; other items do not.

**Call relations**: Completed-item recording uses this when it was not given precomputed finalized facts. Its decision feeds the session input queue, which either accepts mailbox delivery now or postpones it.

*Call graph*: calls 1 internal fn (last_assistant_message_from_item); 1 external calls (matches!).


##### `response_input_to_response_item`  (lines 623–664)

```
fn response_input_to_response_item(input: &ResponseInputItem) -> Option<ResponseItem>
```

**Purpose**: Converts certain input-side tool results back into response items so they can be written into conversation history. This keeps tool outputs in the same recorded format as model stream outputs.

**Data flow**: It receives a response input item. If it is a function-call output, custom tool-call output, MCP tool-call output, or tool-search output, it copies the relevant fields into the matching response item shape and returns it. For input types that do not have a response-item equivalent here, it returns nothing.

**Call relations**: The main output handler uses this when a tool request is answered directly rather than executed normally. After conversion, the session records the response item so the transcript includes the reply sent back to the model.

*Call graph*: called by 1 (handle_output_item_done).


### `core/src/tasks/lifecycle.rs`

`orchestration` · `cross-cutting turn and thread lifecycle`

A session is not only the built-in conversation engine. It can also have extensions: add-on pieces of code that observe or enrich what happens during a conversation. This file is the notification desk for those extensions. When a user turn begins, ends, errors, or is aborted, it walks through the registered lifecycle contributors and calls the matching callback on each one.

The file also checks for a quieter moment: when the thread has no active turn and no queued input waiting to trigger another turn. Only then does it tell thread-level extensions that the thread is idle. This prevents extensions from acting too early, like a shopkeeper closing up while customers are still in line.

Each notification includes the shared extension data stores. There is session-level data, thread-level data, and sometimes turn-level data. These are like labeled notebooks where extensions can keep state at the right scope. The code does not decide what extensions should do with the event; it simply gives them the event details and waits for each callback to finish. That makes this file important glue: without it, extensions would not reliably know where the conversation is in its lifecycle.

#### Function details

##### `Session::emit_turn_start_lifecycle`  (lines 10–27)

```
async fn emit_turn_start_lifecycle(
        &self,
        turn_context: &TurnContext,
        token_usage_at_turn_start: &TokenUsage,
    )
```

**Purpose**: Notifies every turn lifecycle extension that a new turn has started. It gives extensions the turn identity, collaboration mode, token usage at the start, and the data stores they can read or update.

**Data flow**: It receives the current turn context and the token usage snapshot from the beginning of the turn. It reads the session's registered turn lifecycle contributors and, for each one, builds a turn-start input containing session, thread, and turn-scoped extension data. The output is not a returned value; the effect is that each extension gets a chance to run its start-of-turn logic.

**Call relations**: This function is used when the session begins work on a turn. It hands the event to each registered contributor through that contributor's `on_turn_start` callback, so extension code can prepare before the rest of the turn continues.


##### `Session::emit_turn_stop_lifecycle`  (lines 29–39)

```
async fn emit_turn_stop_lifecycle(&self, turn_store: &ExtensionData)
```

**Purpose**: Notifies every turn lifecycle extension that a turn has stopped normally. This gives extensions a clean end-of-turn moment to save state, summarize, or tidy up.

**Data flow**: It receives the turn's extension data store. It reads the session's turn lifecycle contributors and sends each one a turn-stop input containing the session, thread, and turn data stores. It returns nothing; its visible effect is that all contributors are called and awaited.

**Call relations**: This function belongs at the normal end of a turn. It passes control to each contributor's `on_turn_stop` callback so extension behavior can run after the turn is complete.


##### `Session::emit_thread_idle_lifecycle_if_idle`  (lines 41–56)

```
async fn emit_thread_idle_lifecycle_if_idle(&self)
```

**Purpose**: Checks whether the conversation thread is truly idle, and only then notifies thread lifecycle extensions. This protects extensions from being told the thread is quiet while a turn is still active or new input is waiting.

**Data flow**: It reads the session's active-turn lock and asks the input queue whether there are queued items that should trigger another turn. If either check says work is still pending, it stops immediately. If the thread is idle, it sends each thread lifecycle contributor the session and thread extension data stores. It returns nothing; the effect is optional notification when the idle condition is met.

**Call relations**: This function is called at moments when the session may have become quiet. Instead of always firing an idle event, it first checks the active turn and input queue, then hands the confirmed idle event to each contributor's `on_thread_idle` callback.


##### `Session::emit_turn_abort_lifecycle`  (lines 58–73)

```
async fn emit_turn_abort_lifecycle(
        &self,
        reason: TurnAbortReason,
        turn_store: &ExtensionData,
    )
```

**Purpose**: Notifies every turn lifecycle extension that a turn was aborted and tells them why. This is used for interrupted or cancelled turns, where extensions may need to clean up differently than on a normal stop.

**Data flow**: It receives an abort reason and the turn's extension data store. For each registered turn lifecycle contributor, it builds an abort input with the reason plus session, thread, and turn data. Because the same reason must be sent to multiple contributors, it clones the reason for each callback. It returns nothing; the effect is that every contributor is told about the abort.

**Call relations**: This function fits into the exceptional end path for a turn. When the session decides a turn has been aborted, it calls each contributor's `on_turn_abort` callback and supplies the reason so extension code can react appropriately.

*Call graph*: 1 external calls (clone).


##### `Session::emit_turn_error_lifecycle`  (lines 75–91)

```
async fn emit_turn_error_lifecycle(
        &self,
        turn_context: &TurnContext,
        error: CodexErrorInfo,
    )
```

**Purpose**: Notifies every turn lifecycle extension that a turn hit an error. It gives extensions both the turn identity and the error details so they can record, report, or respond to the failure.

**Data flow**: It receives the current turn context and an error description. It reads the registered turn lifecycle contributors and sends each one a turn-error input containing the turn id, the error, and the session, thread, and turn data stores. Because the same error information is sent to multiple contributors, it clones the error for each callback. It returns nothing; the effect is that all contributors are informed of the failure.

**Call relations**: This function is used on the error path of a turn. It hands the failure event to each contributor's `on_turn_error` callback, giving extension code a consistent place to react when something goes wrong.

*Call graph*: 1 external calls (clone).


### `core/src/tools/lifecycle.rs`

`orchestration` · `during tool execution`

When the system runs a tool, other parts of the application may need to know about it. For example, an extension might record timing, update stored state, show progress, or clean up after a failed tool call. This file provides those lifecycle notifications.

Think of it like a theater stage manager calling out “curtain up” and “curtain down” to everyone backstage. The tool runner does the actual work, but this file makes sure interested extension contributors hear about the important moments.

The main flow is simple. When a tool begins, notify_tool_start gathers the current session, thread, turn, call ID, tool name, and where the call came from, then sends that information to every registered tool lifecycle contributor. When a tool finishes normally, notify_tool_finish sends a finish message with the outcome. When a tool is stopped early, notify_tool_aborted reports the finish outcome as “aborted.” Both finish paths share notify_tool_finish_parts so the same information is sent in the same shape.

One important detail is that the core code and the extension API use separate versions of the “tool call source” type. extension_tool_call_source translates between them, preserving whether the call was direct or came from code mode.

#### Function details

##### `notify_tool_start`  (lines 12–31)

```
async fn notify_tool_start(invocation: &ToolInvocation)
```

**Purpose**: This function announces that a tool call has just begun. Extensions use this moment to prepare, record state, or react before the tool does its work.

**Data flow**: It receives a ToolInvocation, which contains the session, current turn, call ID, tool name, and the source of the tool call. It reads the registered lifecycle contributors from the session, builds a start message for each one, translates the call source into the extension API shape, and awaits each contributor’s start callback. It does not return a value; its effect is that all contributors have been notified.

**Call relations**: The tool dispatch flow calls this before running a tool. Inside the notification message, it asks extension_tool_call_source to convert the internal source value into the form extensions understand.

*Call graph*: calls 1 internal fn (extension_tool_call_source); called by 1 (dispatch_any_with_terminal_outcome).


##### `notify_tool_finish`  (lines 33–43)

```
async fn notify_tool_finish(invocation: &ToolInvocation, outcome: ToolCallOutcome)
```

**Purpose**: This function announces that a tool call has finished with a given result. It is used when the system has a complete ToolInvocation and wants to send the finish event to extensions.

**Data flow**: It takes the ToolInvocation and a ToolCallOutcome, such as success, failure, or another finish state. It pulls out the session, turn, call ID, tool name, and source, then passes those pieces to notify_tool_finish_parts. It returns nothing; the visible effect is that finish notifications are sent.

**Call relations**: It is called by the path that finishes a tool if nobody else has already claimed that finish event. Rather than duplicate the notification-building work, it hands everything to notify_tool_finish_parts.

*Call graph*: calls 1 internal fn (notify_tool_finish_parts); called by 1 (notify_tool_finish_if_unclaimed).


##### `notify_tool_aborted`  (lines 45–61)

```
async fn notify_tool_aborted(
    session: &Session,
    turn: &TurnContext,
    call_id: &str,
    tool_name: &ToolName,
    source: ToolCallSource,
)
```

**Purpose**: This function reports that a tool call ended because it was aborted. It is useful when the system has the separate pieces of context instead of a full ToolInvocation.

**Data flow**: It receives the session, turn, call ID, tool name, and source. It adds the specific outcome value ToolCallOutcome::Aborted, then forwards all of that to notify_tool_finish_parts. It returns nothing; the change is that extensions are told the tool ended early.

**Call relations**: This is the special abort path. It reuses notify_tool_finish_parts so aborted tools are reported through the same finish-notification channel as other completed tools.

*Call graph*: calls 1 internal fn (notify_tool_finish_parts).


##### `notify_tool_finish_parts`  (lines 63–85)

```
async fn notify_tool_finish_parts(
    session: &Session,
    turn: &TurnContext,
    call_id: &str,
    tool_name: &ToolName,
    source: ToolCallSource,
    outcome: ToolCallOutcome,
)
```

**Purpose**: This shared helper sends the actual “tool finished” message to every registered lifecycle contributor. It keeps normal finishes and aborted finishes consistent.

**Data flow**: It receives the session, turn, call ID, tool name, source, and final outcome. It reads the extension contributors from the session, builds a ToolFinishInput for each one with the relevant session, thread, and turn stores, translates the source for the extension API, and awaits each contributor’s finish callback. It returns nothing; its output is the set of completed extension notifications.

**Call relations**: notify_tool_finish and notify_tool_aborted both call this after deciding what outcome should be reported. While building each finish message, it calls extension_tool_call_source so extensions receive the source in their own API format.

*Call graph*: calls 1 internal fn (extension_tool_call_source); called by 2 (notify_tool_aborted, notify_tool_finish); 1 external calls (clone).


##### `extension_tool_call_source`  (lines 87–98)

```
fn extension_tool_call_source(source: ToolCallSource) -> ExtensionToolCallSource
```

**Purpose**: This function converts the core system’s idea of where a tool call came from into the matching type used by the extension API. It lets the core and extension layers keep separate data types without losing information.

**Data flow**: It takes a ToolCallSource from the core tool code. If the call was direct, it returns the extension API’s direct value. If the call came from code mode, it carries over the cell ID and runtime tool call ID into the extension API’s code-mode value.

**Call relations**: The start and finish notification paths call this whenever they build messages for extensions. It is the small translation step that lets lifecycle contributors receive source information in the format they expect.

*Call graph*: called by 2 (notify_tool_finish_parts, notify_tool_start).


### `core/src/user_shell_command.rs`

`domain_logic` · `after shell command execution, while recording conversation context`

When a user runs a shell command, the system needs more than the raw text that came back from the terminal. It needs a structured note saying what command ran, whether it succeeded, how long it took, and what output should be kept. This file builds that note.

The main flow is simple. First, the command output is passed through `format_exec_output_str`, which turns the raw execution result into readable text and applies the current truncation policy. A truncation policy is the rule for shortening very long output so it does not flood the conversation or storage. Then the file creates a `UserShellCommand`, which is the project’s internal record for “the user ran this shell command and this is what happened.”

For normal use, the record is converted into a `ResponseItem`, which is a protocol-level item that can be persisted or included in the ongoing exchange. In tests, the same underlying record can instead be rendered directly as a string, making it easier to check the exact text that would be produced.

Without this file, shell command results would be harder to include consistently in conversation history, and long command output might not be shortened according to the active session rules.

#### Function details

##### `user_shell_command_fragment`  (lines 9–16)

```
fn user_shell_command_fragment(
    command: &str,
    exec_output: &ExecToolCallOutput,
    turn_context: &TurnContext,
) -> UserShellCommand
```

**Purpose**: Builds the internal record for a user-run shell command. It combines the command text with the command’s exit code, duration, and formatted output.

**Data flow**: It receives the original command, the raw execution result, and the current turn context. It reads the turn context’s truncation policy, formats the command output with that policy, then creates a `UserShellCommand` containing the command, exit code, runtime, and cleaned-up output. The result is an internal fragment ready to be rendered or converted into a response item.

**Call relations**: This is the shared helper used by both outward paths in this file. The test-only string formatter calls it when it wants human-readable text, and `user_shell_command_record_item` calls it before wrapping the command record into the protocol shape used by the rest of the system.

*Call graph*: calls 2 internal fn (new, format_exec_output_str); called by 2 (format_user_shell_command_record, user_shell_command_record_item).


##### `format_user_shell_command_record`  (lines 19–25)

```
fn format_user_shell_command_record(
    command: &str,
    exec_output: &ExecToolCallOutput,
    turn_context: &TurnContext,
) -> String
```

**Purpose**: Formats a user shell command record as plain text for tests. This lets tests compare the rendered command record without going through the full response-item conversion.

**Data flow**: It receives the same command, execution output, and turn context as the main builder. It asks `user_shell_command_fragment` to create the structured command record, then renders that record into a string. The output is text that represents how the command record would look when displayed or inspected.

**Call relations**: This function is only compiled for tests. It reuses the same fragment-building path as production code, so tests exercise the real formatting behavior instead of duplicating it.

*Call graph*: calls 1 internal fn (user_shell_command_fragment).


##### `user_shell_command_record_item`  (lines 27–37)

```
fn user_shell_command_record_item(
    command: &str,
    exec_output: &ExecToolCallOutput,
    turn_context: &TurnContext,
) -> ResponseItem
```

**Purpose**: Creates the protocol-ready record for a user shell command. This is the function used when the system needs to persist or pass along the command result as part of the conversation.

**Data flow**: It receives the command text, the execution result, and the turn context. It first builds a `UserShellCommand` fragment, including formatted and possibly shortened output. It then converts that contextual fragment into a `ResponseItem`, which is the common message item format used outside this small module.

**Call relations**: This is the production-facing entry in the file. After shell output is ready to be saved, `persist_user_shell_output` calls this function to turn the raw command result into a response item. Internally, it hands the work of building the command-specific fragment to `user_shell_command_fragment`, then converts that fragment into the broader protocol format.

*Call graph*: calls 2 internal fn (into, user_shell_command_fragment); called by 1 (persist_user_shell_output).


### `tools/src/tool_output.rs`

`domain_logic` · `tool result handling`

When a tool finishes, its result has to serve several audiences at once. The model needs a protocol-shaped response. Logs need a safe short preview instead of a huge dump. optional "post tool use" hooks need stable data they can inspect. Code mode may need a plain JSON value. This file gives all tool outputs a shared contract called `ToolOutput`, like a standard form every tool result must fill out.

The trait says what every output must be able to do: make a log preview, say whether it succeeded for logging, report whether it brought in outside context, turn itself into a model response item, and optionally provide data for hooks. The file then teaches two important result types how to follow that contract: `JsonToolOutput`, for ordinary JSON-shaped results, and `CallToolResult`, for MCP tool results. MCP means Model Context Protocol, a protocol for connecting tools and context providers.

A small but important safety feature is `telemetry_preview`. It trims logged output by both bytes and lines, while respecting character boundaries so multi-byte text is not cut in half. Without this file, each tool runtime would need to invent its own output conversion rules, making logging, hooks, and model replies inconsistent and easier to break.

#### Function details

##### `ToolOutput::contains_external_context`  (lines 23–25)

```
fn contains_external_context(&self) -> bool
```

**Purpose**: This default method says whether a tool result includes outside information that should affect memory behavior. By default it says no, so ordinary tool outputs do not disable memory generation.

**Data flow**: It receives the tool output object itself, reads no extra data, and returns `false`. Implementations can override that answer when their result includes external context.

**Call relations**: This is part of the shared `ToolOutput` contract. Concrete output types such as `JsonToolOutput` and boxed outputs can provide their own answer when the wider tool flow asks whether external context was present.


##### `ToolOutput::post_tool_use_id`  (lines 30–32)

```
fn post_tool_use_id(&self, call_id: &str) -> String
```

**Purpose**: This default method decides which tool call id should be shown to `PostToolUse` hooks. Normally it just reuses the original call id.

**Data flow**: It takes the call id string, copies it into a new owned string, and returns that copy. It does not inspect the tool payload or output contents.

**Call relations**: The hook-building paths `post_unified_exec_tool_use_payload` and `post_tool_use_payload` call this when preparing data for code that runs after a tool finishes. Output types can override it if the hook should see a different id than the model-facing one.

*Call graph*: called by 2 (post_unified_exec_tool_use_payload, post_tool_use_payload).


##### `ToolOutput::post_tool_use_input`  (lines 35–37)

```
fn post_tool_use_input(&self, _payload: &ToolPayload) -> Option<JsonValue>
```

**Purpose**: This default method provides the input data that a `PostToolUse` hook should see. The default is no input, which means many output types do not expose extra hook input unless they opt in.

**Data flow**: It receives the tool payload but ignores it, then returns `None`. A specialized output type may override this to return a JSON value.

**Call relations**: `post_tool_use_payload` and `post_unified_exec_tool_use_payload` call this while assembling hook payloads. This method is one of the extension points that lets each output type decide what hook-facing data is safe and useful.

*Call graph*: called by 3 (post_tool_use_payload, post_unified_exec_tool_use_payload, post_tool_use_payload).


##### `ToolOutput::post_tool_use_response`  (lines 46–48)

```
fn post_tool_use_response(&self, _call_id: &str, _payload: &ToolPayload) -> Option<JsonValue>
```

**Purpose**: This default method provides the response data that a `PostToolUse` hook should receive. Returning `None` means this output should not create a hook response payload.

**Data flow**: It receives the call id and original tool payload, ignores both, and returns `None`. Implementations can override it to return a stable JSON representation of the tool result.

**Call relations**: The hook-building code calls this from `post_tool_use_payload` and `post_unified_exec_tool_use_payload`. `JsonToolOutput` overrides it so generic JSON tool results can be passed to hooks directly.

*Call graph*: called by 5 (post_tool_use_payload, post_tool_use_payload, post_tool_use_payload, post_unified_exec_tool_use_payload, post_tool_use_payload).


##### `ToolOutput::code_mode_result`  (lines 50–52)

```
fn code_mode_result(&self, payload: &ToolPayload) -> JsonValue
```

**Purpose**: This default method converts a tool output into the JSON value used by code mode. Code mode wants a simple value, so this method turns the model-facing response into that simpler form.

**Data flow**: It takes the tool payload, first asks the output to become a `ResponseInputItem`, then passes that response item to `response_input_to_code_mode_result`. The result is a JSON value.

**Call relations**: `tool_dispatch_result` calls this after a tool has run and needs a code-mode result. The method hands off the conversion details to `response_input_to_code_mode_result`, while allowing output types such as `JsonToolOutput` and `CallToolResult` to override it when they have a better direct representation.

*Call graph*: calls 1 internal fn (response_input_to_code_mode_result); called by 1 (tool_dispatch_result).


##### `Box::log_preview`  (lines 59–61)

```
fn log_preview(&self) -> String
```

**Purpose**: This lets a boxed tool output produce the same log preview as the real output inside the box. A box is just heap storage for a value whose exact type may be chosen at runtime.

**Data flow**: It receives a boxed output, looks through the box, calls the inner output's `log_preview`, and returns that string unchanged.

**Call relations**: This is delegation glue for the `ToolOutput` trait. It means callers can treat `Box<dyn ToolOutput>` the same way as a concrete output and still reach the real implementation inside.


##### `Box::success_for_logging`  (lines 63–65)

```
fn success_for_logging(&self) -> bool
```

**Purpose**: This lets a boxed tool output report success or failure for logs by asking the output stored inside it.

**Data flow**: It receives the boxed output, forwards the request to the inner output, and returns the inner boolean answer.

**Call relations**: This supports code that stores different output types behind a box. Logging code can ask for success without needing to know which concrete result type is inside.


##### `Box::contains_external_context`  (lines 67–69)

```
fn contains_external_context(&self) -> bool
```

**Purpose**: This lets a boxed tool output report whether it contains external context. It simply passes the question to the real output inside the box.

**Data flow**: It receives the boxed output, calls `contains_external_context` on the inner value, and returns that answer.

**Call relations**: This keeps the external-context check working even when tool outputs are stored through the shared `ToolOutput` interface rather than as concrete types.


##### `Box::to_response_item`  (lines 71–73)

```
fn to_response_item(&self, call_id: &str, payload: &ToolPayload) -> ResponseInputItem
```

**Purpose**: This lets a boxed tool output turn itself into the protocol response sent back to the model. The box itself does not know the format, so it asks the inner output.

**Data flow**: It receives a call id and tool payload, forwards both to the inner output's `to_response_item`, and returns the resulting response item.

**Call relations**: This is part of making boxed outputs transparent. The larger tool pipeline can keep outputs in boxes and still produce the correct model-facing response.


##### `Box::post_tool_use_id`  (lines 75–77)

```
fn post_tool_use_id(&self, call_id: &str) -> String
```

**Purpose**: This lets a boxed tool output decide which id a `PostToolUse` hook should see. The decision is delegated to the output inside the box.

**Data flow**: It receives the call id, passes it to the inner output's `post_tool_use_id`, and returns the resulting string.

**Call relations**: Hook payload builders can call this through the shared `ToolOutput` interface. The box layer stays invisible and preserves any custom id behavior supplied by the concrete output.


##### `Box::post_tool_use_input`  (lines 79–81)

```
fn post_tool_use_input(&self, payload: &ToolPayload) -> Option<JsonValue>
```

**Purpose**: This lets a boxed tool output provide hook input data if the inner output supports it.

**Data flow**: It receives the tool payload, passes it to the inner output's `post_tool_use_input`, and returns either a JSON value or `None`.

**Call relations**: This keeps post-tool hook preparation consistent when outputs are stored dynamically. The real choice about hook input remains with the concrete output type.


##### `Box::post_tool_use_response`  (lines 83–85)

```
fn post_tool_use_response(&self, call_id: &str, payload: &ToolPayload) -> Option<JsonValue>
```

**Purpose**: This lets a boxed tool output provide hook response data if the inner output supports it.

**Data flow**: It receives the call id and payload, forwards both to the inner output, and returns the inner output's optional JSON response.

**Call relations**: The box implementation makes sure hook-building code does not lose specialized behavior just because the output is stored as a boxed trait object.


##### `Box::code_mode_result`  (lines 87–89)

```
fn code_mode_result(&self, payload: &ToolPayload) -> JsonValue
```

**Purpose**: This lets a boxed tool output produce the JSON value expected by code mode. It asks the real output inside the box to do the conversion.

**Data flow**: It receives the tool payload, forwards it to the inner output's `code_mode_result`, and returns the JSON value unchanged.

**Call relations**: This supports `tool_dispatch_result` and similar callers that work with boxed outputs. The conversion remains type-specific even though the caller only sees the shared interface.


##### `JsonToolOutput::new`  (lines 100–106)

```
fn new(value: JsonValue) -> Self
```

**Purpose**: This creates a normal successful JSON tool output. It is the simple constructor used when a tool already has a JSON value to return.

**Data flow**: It takes a JSON value, stores it, marks success as `Some(true)`, marks external context as false, and returns the new `JsonToolOutput`.

**Call relations**: Many tool handlers call this after they finish work and need to package a result, including `handle_call`, `handle`, `exposes_generic_hook_payloads`, `post_tool_use_feedback_output_keeps_code_mode_result_typed`, and `goal_response`. Those callers hand their finished JSON into this constructor so the shared `ToolOutput` machinery can take over.

*Call graph*: called by 13 (handle_call, handle_call, handle, exposes_generic_hook_payloads, post_tool_use_feedback_output_keeps_code_mode_result_typed, handle_call, handle, goal_response, handle_call, handle_call (+3 more)).


##### `JsonToolOutput::with_success`  (lines 108–114)

```
fn with_success(value: JsonValue, success: Option<bool>) -> Self
```

**Purpose**: This creates a JSON tool output with an explicit success value. It is useful when a tool needs to say success, failure, or unknown rather than always successful.

**Data flow**: It takes a JSON value and an optional boolean success marker, stores both, marks external context as false, and returns the new output.

**Call relations**: This is an alternate constructor for the same `JsonToolOutput` path. Later logging and response conversion read the stored success marker when deciding how to represent the result.


##### `JsonToolOutput::with_external_context`  (lines 116–119)

```
fn with_external_context(mut self) -> Self
```

**Purpose**: This marks a JSON output as containing external context. That matters because some memory-generation settings may avoid learning from results that came from outside sources.

**Data flow**: It takes an existing `JsonToolOutput`, changes its external-context flag to true, and returns the updated output.

**Call relations**: This is used as a builder-style step after creating a JSON output. Later, `JsonToolOutput::contains_external_context` reports the flag to the wider tool pipeline.


##### `JsonToolOutput::log_preview`  (lines 123–125)

```
fn log_preview(&self) -> String
```

**Purpose**: This makes a short, safe log preview of a JSON tool result. It prevents large JSON output from flooding telemetry logs.

**Data flow**: It turns the stored JSON value into text, passes that text to `telemetry_preview`, and returns the shortened preview string.

**Call relations**: Logging code reaches this through the `ToolOutput` interface. The actual trimming is handed to `telemetry_preview`, which applies the shared byte and line limits.

*Call graph*: calls 1 internal fn (telemetry_preview); 1 external calls (to_string).


##### `JsonToolOutput::success_for_logging`  (lines 127–129)

```
fn success_for_logging(&self) -> bool
```

**Purpose**: This tells logging whether the JSON tool result should count as successful. If no success value was stored, it treats the result as successful.

**Data flow**: It reads the stored optional success value. If it is present, that value is returned; if it is missing, the function returns true.

**Call relations**: This is the JSON-specific implementation of the `ToolOutput` logging contract. It gives log writers a simple yes-or-no answer even when the original success marker was unspecified.


##### `JsonToolOutput::contains_external_context`  (lines 131–133)

```
fn contains_external_context(&self) -> bool
```

**Purpose**: This reports whether this JSON output was marked as containing external context.

**Data flow**: It reads the `contains_external_context` flag stored inside the `JsonToolOutput` and returns that boolean.

**Call relations**: This overrides the default `ToolOutput` answer. Outputs created with `with_external_context` later surface that fact through this method.


##### `JsonToolOutput::to_response_item`  (lines 135–153)

```
fn to_response_item(&self, call_id: &str, payload: &ToolPayload) -> ResponseInputItem
```

**Purpose**: This converts a JSON tool result into the response shape expected by the model protocol. It also chooses the correct response kind for ordinary tools versus custom tools.

**Data flow**: It turns the stored JSON value into text, wraps it in a function-call output payload with the stored success marker, then checks the tool payload. For custom tools it returns a custom tool-call output; otherwise it returns a normal function-call output, both carrying the call id and output payload.

**Call relations**: The wider tool pipeline calls this through the `ToolOutput` trait when it needs to send a result back to the model. This method is also used indirectly by the default code-mode conversion path, though `JsonToolOutput` overrides `code_mode_result` to keep the original JSON type.

*Call graph*: 3 external calls (to_string, matches!, Text).


##### `JsonToolOutput::post_tool_use_response`  (lines 155–157)

```
fn post_tool_use_response(&self, _call_id: &str, _payload: &ToolPayload) -> Option<JsonValue>
```

**Purpose**: This exposes the JSON result to `PostToolUse` hooks. Unlike the default trait method, JSON outputs do participate by returning their stored value.

**Data flow**: It ignores the call id and payload, clones the stored JSON value, and returns it inside `Some`.

**Call relations**: Hook-building code calls the trait method when preparing post-tool data. This implementation lets hooks see the same structured JSON value the tool produced, rather than only a text version.

*Call graph*: 1 external calls (clone).


##### `JsonToolOutput::code_mode_result`  (lines 159–161)

```
fn code_mode_result(&self, _payload: &ToolPayload) -> JsonValue
```

**Purpose**: This returns the JSON result for code mode without converting it to text. That keeps numbers, objects, arrays, and booleans as their real JSON types.

**Data flow**: It ignores the payload, clones the stored JSON value, and returns the clone.

**Call relations**: `tool_dispatch_result` can reach this through the `ToolOutput` interface. This override avoids the default path, which would first turn the output into a response item and could lose some JSON structure.

*Call graph*: 1 external calls (clone).


##### `CallToolResult::log_preview`  (lines 165–169)

```
fn log_preview(&self) -> String
```

**Purpose**: This creates a short log preview for an MCP tool result. It prefers the human-readable body text when available, and falls back to a string form of the whole output otherwise.

**Data flow**: It converts the MCP result into a function-call output payload, tries to extract text from the body, falls back to the payload's string form if needed, then sends that text through `telemetry_preview`.

**Call relations**: Logging code calls this through the `ToolOutput` interface for MCP results. The final trimming is shared with JSON output logging through `telemetry_preview`.

*Call graph*: calls 1 internal fn (telemetry_preview).


##### `CallToolResult::success_for_logging`  (lines 171–173)

```
fn success_for_logging(&self) -> bool
```

**Purpose**: This tells logging whether an MCP tool result succeeded. It uses the success information built into the MCP result.

**Data flow**: It reads the MCP result's success state through its `success` method and returns that boolean.

**Call relations**: This is the MCP-specific version of the `ToolOutput` success contract. Log writers do not need to know MCP details; they just ask the common interface.


##### `CallToolResult::to_response_item`  (lines 175–180)

```
fn to_response_item(&self, call_id: &str, _payload: &ToolPayload) -> ResponseInputItem
```

**Purpose**: This wraps an MCP tool result in the response item shape expected by the model protocol.

**Data flow**: It takes the call id, clones the MCP result, and returns a `McpToolCallOutput` response item containing both.

**Call relations**: The tool pipeline calls this through `ToolOutput` when an MCP tool has finished and its result must be sent back to the model. Unlike JSON outputs, it preserves the MCP result as an MCP-specific response.


##### `CallToolResult::code_mode_result`  (lines 182–186)

```
fn code_mode_result(&self, _payload: &ToolPayload) -> JsonValue
```

**Purpose**: This converts an MCP tool result into JSON for code mode. If serialization fails, it returns a readable error string instead of crashing.

**Data flow**: It tries to serialize the MCP result into a JSON value. On success it returns that value; on failure it builds a JSON string saying serialization failed and includes the error.

**Call relations**: `tool_dispatch_result` can reach this through the `ToolOutput` interface. This MCP-specific override gives code mode a structured representation when possible.

*Call graph*: 1 external calls (to_value).


##### `response_input_to_code_mode_result`  (lines 189–221)

```
fn response_input_to_code_mode_result(response: ResponseInputItem) -> JsonValue
```

**Purpose**: This turns a model response item into the simpler JSON value used by code mode. It is the fallback converter for output types that do not provide their own direct code-mode result.

**Data flow**: It receives a `ResponseInputItem`, looks at which kind it is, and converts it accordingly. Text outputs become JSON strings, content-item outputs are flattened by `content_items_to_code_mode_result`, tool search outputs become JSON arrays, and MCP outputs are serialized to JSON or replaced with an error string if serialization fails.

**Call relations**: The default `ToolOutput::code_mode_result` calls this after creating a model-facing response item. When content items need flattening, this function hands that smaller job to `content_items_to_code_mode_result`.

*Call graph*: calls 1 internal fn (content_items_to_code_mode_result); called by 1 (code_mode_result); 3 external calls (Array, String, to_value).


##### `content_items_to_code_mode_result`  (lines 223–243)

```
fn content_items_to_code_mode_result(items: &[FunctionCallOutputContentItem]) -> JsonValue
```

**Purpose**: This flattens mixed content items into one readable string for code mode. It keeps useful text and image URLs, and skips empty or encrypted content.

**Data flow**: It receives a slice of content items, walks through them one by one, keeps non-empty text and non-empty image URLs, ignores blank text, blank image URLs, and encrypted content, joins the kept pieces with newlines, and returns the result as a JSON string.

**Call relations**: `response_input_to_code_mode_result` calls this when a response contains content items rather than one plain text body. This function is the small helper that decides what parts of those items can become a simple code-mode string.

*Call graph*: called by 1 (response_input_to_code_mode_result); 2 external calls (String, iter).


##### `telemetry_preview`  (lines 245–283)

```
fn telemetry_preview(content: &str) -> String
```

**Purpose**: This makes a bounded preview string for telemetry logs. It protects logs from huge tool outputs while avoiding broken text caused by cutting a character in half.

**Data flow**: It takes the full content string, cuts it to a maximum byte count at a valid character boundary, then keeps only a maximum number of lines. If anything was cut, it adds a clear truncation notice; if nothing was cut, it returns the original content.

**Call relations**: `JsonToolOutput::log_preview` and `CallToolResult::log_preview` call this whenever tool output is prepared for logs. It relies on `take_bytes_at_char_boundary` for safe byte trimming, then applies the shared line limit.

*Call graph*: called by 2 (log_preview, log_preview); 2 external calls (new, take_bytes_at_char_boundary).


### Machine-readable and auxiliary outputs
These files adapt notifications into exec JSONL output and other specialized rendered progress or reporting surfaces outside the main thread UI.

### `cli/src/doctor/output.rs`

`domain_logic` · `doctor command output rendering`

The doctor command checks many parts of a user's setup: the operating system, install method, configuration, network access, background server, and more. The raw report is useful for tools, but it would be hard for a person to scan. This file is the “front desk” for that report: it groups checks into familiar sections, shows a short status marker beside each one, adds helpful notes at the top, and prints a final count of what is healthy or broken.

It keeps presentation separate from the checks themselves. That matters because the JSON report can stay stable for automation while the human view can be tuned for readability. It also protects users by redacting secrets and trimming sensitive parts of URLs before details are shown.

The main flow starts with `render_human_report`. It builds a string from top to bottom: title, notes, grouped check rows, divider, summary line, and footer hints. Helper functions decide whether a check is OK, warning, failed, idle, or an update note; turn detailed key-value text into aligned rows; shorten noisy data into friendlier summaries; and add color only when requested. It can also fall back to plain ASCII symbols for terminals that do not handle Unicode well.

#### Function details

##### `render_human_report`  (lines 73–117)

```
fn render_human_report(report: &DoctorReport, options: HumanOutputOptions) -> String
```

**Purpose**: Builds the complete human-facing doctor report as one terminal-ready string. This is the main entry point for this file's rendering work.

**Data flow**: It takes a `DoctorReport` plus display options such as details, ASCII mode, and color. It writes the heading, optional notes, grouped checks, summary, and footer into a new string, then returns that string without changing the report.

**Call relations**: The doctor command and tests call this when they need the terminal version of a report. It delegates the smaller jobs to note builders, group filtering, row writers, and the footer writer.

*Call graph*: calls 5 internal fn (checks_for_group, notes_for_report, write_check_row, write_footer, write_note_row); called by 10 (render_human_report_can_emit_color, render_human_report_expands_feature_flags_with_all, render_human_report_explains_terminal_warning_issue, render_human_report_includes_details_by_default_without_color, render_human_report_includes_memories_db_in_state_health_summary, render_human_report_includes_redacted_details, render_human_report_includes_threads_row_in_environment, render_human_report_promotes_notes_without_changing_statuses, render_human_report_supports_ascii_output, render_human_report_supports_summary_output_without_color); 2 external calls (new, writeln!).


##### `checks_for_group`  (lines 119–130)

```
fn checks_for_group(report: &'a DoctorReport, group: &OutputGroup) -> Vec<&'a DoctorCheck>
```

**Purpose**: Selects the checks that belong under one visible section, such as Environment or Connectivity. It also enforces the display order within that section.

**Data flow**: It receives the full report and one output group. It walks the group's category keys, finds matching checks in the report, and returns those checks as a list of references.

**Call relations**: It is used by `render_human_report` while printing each section. The returned checks are then passed one by one to `write_check_row`.

*Call graph*: called by 1 (render_human_report).


##### `write_check_row`  (lines 132–148)

```
fn write_check_row(out: &mut String, check: &DoctorCheck, options: HumanOutputOptions)
```

**Purpose**: Writes one check's main line, and optionally its detailed lines, into the report text. This is where each diagnostic item becomes a visible row.

**Data flow**: It receives the output string, a check, and display options. It chooses a short description, converts the check status into a display status, writes the aligned row, and adds detail rows if detailed output is enabled.

**Call relations**: `render_human_report` calls it for every check in a visible group. It asks `row_description`, `display_status`, and `detail_lines` for the content, then passes each detail to `write_detail_line`.

*Call graph*: calls 4 internal fn (detail_lines, display_status, row_description, write_detail_line); called by 1 (render_human_report); 1 external calls (writeln!).


##### `write_note_row`  (lines 150–158)

```
fn write_note_row(out: &mut String, note: &DoctorNote, options: HumanOutputOptions)
```

**Purpose**: Writes one highlighted note at the top of the report. Notes call attention to updates, warnings, or important mixed signals before the user scans the full table.

**Data flow**: It receives the output string, a note, and display options. It formats the note marker, name, and styled summary as one aligned line and appends it to the output.

**Call relations**: `render_human_report` calls it after `notes_for_report` has collected notes. It relies on the same marker and summary styling helpers used elsewhere so notes look consistent with check rows.

*Call graph*: called by 1 (render_human_report); 1 external calls (writeln!).


##### `write_detail_line`  (lines 160–213)

```
fn write_detail_line(out: &mut String, detail: HumanDetail, options: HumanOutputOptions)
```

**Purpose**: Writes one indented detail under a check. Details explain the evidence behind the one-line result, such as a path, setting, expected value, or suggested fix.

**Data flow**: It receives a `HumanDetail` value, which may be a label-value row, continuation line, bullet, or remedy. It chooses the right marker and alignment, styles the text, and appends a line to the output string.

**Call relations**: `write_check_row` calls it for each detail produced by the detail module. It hands detail values through `detail_value` so inline code, paths, and statuses can be colored consistently.

*Call graph*: calls 1 internal fn (detail_value); called by 1 (write_check_row); 2 external calls (format!, writeln!).


##### `row_description`  (lines 215–229)

```
fn row_description(check: &DoctorCheck, options: HumanOutputOptions) -> String
```

**Purpose**: Chooses the short sentence shown on a check's main row. It prefers the most actionable explanation when something is wrong.

**Data flow**: It receives a check and display options. If the check has warning or failure issues, it summarizes those issues; otherwise it may combine the normal summary with remediation text, or fall back to a category-specific friendly summary.

**Call relations**: `write_check_row` calls this before printing a check. It relies on `issue_summary` for problem-heavy checks and `display_summary` for ordinary category-specific summaries.

*Call graph*: calls 2 internal fn (display_summary, issue_summary); called by 1 (write_check_row); 2 external calls (format!, matches!).


##### `issue_summary`  (lines 231–246)

```
fn issue_summary(check: &DoctorCheck) -> String
```

**Purpose**: Turns one or more issue records into a compact sentence for the main row or notes. This keeps warnings readable even when a check found several problems.

**Data flow**: It receives a check. With no issues it returns the check summary, with one issue it returns that cause, and with many issues it reports the count plus the first two causes.

**Call relations**: `row_description` uses it for warning and failure rows, and `actionable_note_summary` uses it when promoting broken checks into top-of-report notes.

*Call graph*: called by 2 (actionable_note_summary, row_description); 1 external calls (format!).


##### `display_status`  (lines 264–280)

```
fn display_status(check: &DoctorCheck) -> DisplayStatus
```

**Purpose**: Maps the check's raw status into the status used for display. It adds one special human distinction: a healthy app server check can be shown as idle when the server is simply not running.

**Data flow**: It reads a check's category, raw status, and details. It returns a display status such as OK, warning, fail, or idle.

**Call relations**: Row rendering and summary counting call this so they agree on how a check should appear. `StatusCounts::from_report` also uses it when building the final totals.

*Call graph*: called by 2 (from_report, write_check_row).


##### `status_marker`  (lines 282–308)

```
fn status_marker(status: DisplayStatus, options: HumanOutputOptions) -> String
```

**Purpose**: Chooses the visible status symbol, such as a check mark, warning sign, or ASCII fallback. It also applies the status color when color is enabled.

**Data flow**: It receives a display status and output options. It chooses a Unicode or ASCII marker, colors it according to severity, and returns the finished marker text.

**Call relations**: `status_marker_slot` uses it whenever a row needs a status marker. It depends on the small color helpers like `green`, `orange`, and `red`.

*Call graph*: calls 5 internal fn (amber, dim, green, orange, red); called by 1 (status_marker_slot).


##### `status_marker_slot`  (lines 310–313)

```
fn status_marker_slot(status: DisplayStatus, options: HumanOutputOptions) -> String
```

**Purpose**: Adds spacing after a status marker so row text lines up cleanly. It is a small layout helper.

**Data flow**: It receives a display status and options, gets the marker text, appends a trailing space, and returns the result.

**Call relations**: Check rows and note rows use it before printing the category or note name. It wraps `status_marker` so callers do not repeat the spacing rule.

*Call graph*: calls 1 internal fn (status_marker); 1 external calls (format!).


##### `style_description`  (lines 315–326)

```
fn style_description(
    description: &str,
    status: DisplayStatus,
    options: HumanOutputOptions,
) -> String
```

**Purpose**: Styles the main descriptive text for a row. Healthy or idle rows are quieter, while warnings and failures stay more visible.

**Data flow**: It receives description text, a display status, and options. It first highlights command-like parts, then dims, colors, or leaves the description based on the status.

**Call relations**: `style_note_summary` uses it for most notes, and row-formatting code uses the same styling idea for check descriptions. It hands command and flag highlighting to `highlight_actions`.

*Call graph*: calls 3 internal fn (amber, dim, highlight_actions); called by 1 (style_note_summary).


##### `detail_marker`  (lines 328–333)

```
fn detail_marker(is_issue: bool, options: HumanOutputOptions) -> String
```

**Purpose**: Chooses the small marker shown beside a detail row when that detail is an issue. Non-issue details get a blank marker.

**Data flow**: It receives a yes-or-no issue flag and output options. It returns either a colored issue pointer or a blank space.

**Call relations**: `write_detail_line` uses it for label-value detail rows. It calls `orange` so issue markers match warning-style attention color.

*Call graph*: calls 1 internal fn (orange).


##### `style_note_summary`  (lines 335–340)

```
fn style_note_summary(note: &DoctorNote, options: HumanOutputOptions) -> String
```

**Purpose**: Styles a note's summary text. Update notes get special treatment so the available version stands out.

**Data flow**: It receives a note and display options. If the note is an update, it uses the update-specific formatter; otherwise it styles the text according to the note's status.

**Call relations**: `write_note_row` uses it when printing notes gathered by `notes_for_report`. It branches to `style_update_note_summary` or the general `style_description` helper.

*Call graph*: calls 2 internal fn (style_description, style_update_note_summary).


##### `style_update_note_summary`  (lines 342–363)

```
fn style_update_note_summary(summary: &str, options: HumanOutputOptions) -> String
```

**Purpose**: Makes an update note easier to scan by emphasizing the new version and dimming context such as the current or dismissed version.

**Data flow**: It receives update summary text and options. With color disabled it returns the text unchanged; with color enabled it splits the sentence around “available” and the parenthetical context, then styles those parts.

**Call relations**: `style_note_summary` calls this for update notes. A test also calls it directly to make sure the version and context styling remain correct.

*Call graph*: calls 1 internal fn (amber); called by 2 (style_note_summary, update_note_emphasizes_available_version_and_dims_context); 1 external calls (format!).


##### `summary_line`  (lines 365–404)

```
fn summary_line(report: &DoctorReport, options: HumanOutputOptions) -> String
```

**Purpose**: Builds the final one-line totals at the bottom of the report. It tells the user, at a glance, how many checks are OK, idle, warnings, failures, and notes.

**Data flow**: It receives the report and output options. It rebuilds the notes, counts display statuses, formats each count label, adds the overall status word, and returns the finished line.

**Call relations**: `render_human_report` uses it after printing all groups. It works with `StatusCounts::from_report`, `count_label`, and `overall_status_label` to keep counts and wording consistent.

*Call graph*: calls 5 internal fn (from_report, count_label, dim, notes_for_report, overall_status_label); 2 external calls (format!, vec!).


##### `count_label`  (lines 406–421)

```
fn count_label(
    count: usize,
    label: &str,
    status: DisplayStatus,
    options: HumanOutputOptions,
) -> String
```

**Purpose**: Formats one count in the summary line, such as `12 ok` or `1 fail`. The label color matches the severity.

**Data flow**: It receives a number, label text, display status, and options. It dims the number, colors the label if color is enabled, and returns the combined text.

**Call relations**: `summary_line` calls it once for each count it wants to show. It uses the shared color helpers so summary colors match row markers.

*Call graph*: calls 5 internal fn (amber, dim, green, orange, red); called by 1 (summary_line); 1 external calls (format!).


##### `overall_status_label`  (lines 423–429)

```
fn overall_status_label(status: CheckStatus) -> &'static str
```

**Purpose**: Turns the report's raw overall status into a human word. A warning becomes “degraded,” which is clearer than just “warning” for the whole system.

**Data flow**: It receives a `CheckStatus` and returns one fixed label: `ok`, `degraded`, or `failed`.

**Call relations**: `summary_line` uses this before applying final status styling with `styled_overall_status`.

*Call graph*: called by 1 (summary_line).


##### `styled_overall_status`  (lines 431–441)

```
fn styled_overall_status(label: &str, status: CheckStatus, options: HumanOutputOptions) -> String
```

**Purpose**: Applies strong color and bold styling to the final overall status word. This makes the bottom-line result stand out.

**Data flow**: It receives the label, raw status, and options. If color is off it returns the label unchanged; otherwise it colors the word green, yellow, or red and makes it bold.

**Call relations**: `summary_line` uses it at the end of the totals line so the report has a clear final verdict.


##### `write_footer`  (lines 443–478)

```
fn write_footer(out: &mut String, options: HumanOutputOptions)
```

**Purpose**: Writes short command hints at the bottom of the report. The hints tell users how to switch between compact, detailed, expanded, and JSON views.

**Data flow**: It receives the output string and options. Depending on whether details are currently shown, it appends the relevant help lines and returns by mutating the string.

**Call relations**: `render_human_report` calls it last. It uses styled option names so flags such as `--json` and `--all` are easy to spot.

*Call graph*: called by 1 (render_human_report); 1 external calls (writeln!).


##### `header_suffix`  (lines 480–490)

```
fn header_suffix(report: &DoctorReport) -> String
```

**Purpose**: Builds the small text shown beside the report title. It always includes the Codex version and may add the runtime platform.

**Data flow**: It receives the report, starts with `v` plus the Codex version, then looks for the runtime check's platform detail. If found, it returns version plus platform; otherwise only the version.

**Call relations**: `render_human_report` uses it in the heading. It reads detail data through the detail module rather than recomputing runtime facts.

*Call graph*: 1 external calls (format!).


##### `notes_for_report`  (lines 492–516)

```
fn notes_for_report(report: &DoctorReport) -> Vec<DoctorNote>
```

**Purpose**: Collects important top-of-report notes that deserve attention before the full checklist. These notes can highlight updates, large rollout files, loose sandboxing, broken checks, or confusing auth signals.

**Data flow**: It receives the report, looks up specific checks, asks specialized note builders whether each one should produce a note, adds notes for warning and failed checks, and returns the collected list.

**Call relations**: `render_human_report` uses it to print the Notes section, and `summary_line` uses it to count notes. It coordinates `update_note`, `rollout_note`, `sandbox_note`, `non_ok_notes`, and `auth_reachability_note`.

*Call graph*: calls 6 internal fn (auth_reachability_note, find_check, non_ok_notes, rollout_note, sandbox_note, update_note); called by 2 (render_human_report, summary_line); 1 external calls (new).


##### `find_check`  (lines 518–523)

```
fn find_check(report: &'a DoctorReport, category: &str) -> Option<&'a DoctorCheck>
```

**Purpose**: Finds the first check in a report with a given category name. It is a convenience helper for note builders.

**Data flow**: It receives a report and category string. It scans the report's checks and returns the matching check if one exists.

**Call relations**: `notes_for_report` uses it before calling category-specific note functions. `auth_reachability_note` uses it to compare websocket and HTTP reachability checks.

*Call graph*: called by 2 (auth_reachability_note, notes_for_report).


##### `update_note`  (lines 525–545)

```
fn update_note(check: &DoctorCheck, report: &DoctorReport) -> Option<DoctorNote>
```

**Purpose**: Creates a note when a newer Codex version is available. This lets update information appear near the top without turning the underlying check into a failure.

**Data flow**: It receives the updates check and full report. It reads version-related detail fields, ignores the check if no newer version is reported, then builds an update note with latest, current, and possibly dismissed version information.

**Call relations**: `notes_for_report` calls it when an updates check exists. It uses detail helpers for safe value lookup and falsy-value detection.

*Call graph*: calls 2 internal fn (detail_value, is_falsy); called by 1 (notes_for_report); 1 external calls (format!).


##### `rollout_note`  (lines 547–562)

```
fn rollout_note(check: &DoctorCheck) -> Option<DoctorNote>
```

**Purpose**: Creates a warning note when rollout state files are unusually numerous or large. This draws attention to disk usage that may matter to the user.

**Data flow**: It receives the state check, reads the active rollout files detail, parses file and byte counts, and returns no note unless the counts cross the built-in thresholds.

**Call relations**: `notes_for_report` calls it for the state check. It relies on the detail module to parse and format counts and byte sizes.

*Call graph*: calls 2 internal fn (detail_value, rollout_files_and_bytes); called by 1 (notes_for_report); 1 external calls (format!).


##### `sandbox_note`  (lines 564–575)

```
fn sandbox_note(check: &DoctorCheck) -> Option<DoctorNote>
```

**Purpose**: Creates a note when sandbox restrictions are not fully locked down. A sandbox is a safety boundary; this warns when file or network access is looser than restricted.

**Data flow**: It receives the sandbox check, reads filesystem and network sandbox details, and returns no note only when both are `restricted`. Otherwise it summarizes both modes.

**Call relations**: `notes_for_report` calls it for the sandbox check. Its note is later rendered by `write_note_row`.

*Call graph*: calls 1 internal fn (detail_value); called by 1 (notes_for_report); 1 external calls (format!).


##### `non_ok_notes`  (lines 577–588)

```
fn non_ok_notes(report: &DoctorReport) -> Vec<DoctorNote>
```

**Purpose**: Promotes every warning or failed check into a top note. This keeps important problems visible even if they appear lower in the grouped report.

**Data flow**: It receives the full report, filters checks whose status is warning or fail, builds a note for each using the check category and actionable summary, and returns the list.

**Call relations**: `notes_for_report` calls it after special notes are considered. It uses `display_status` and `actionable_note_summary` so the note mirrors the row's severity and message.

*Call graph*: called by 1 (notes_for_report).


##### `actionable_note_summary`  (lines 590–598)

```
fn actionable_note_summary(check: &DoctorCheck) -> String
```

**Purpose**: Chooses the most useful short text for a warning or failure note. It favors concrete issue causes and next steps over generic summaries.

**Data flow**: It receives a check. If issues exist, it summarizes them; otherwise it appends remediation text when present, or returns the original summary.

**Call relations**: `non_ok_notes` uses it while turning broken checks into notes. It shares `issue_summary` with row rendering so the same problem is described consistently.

*Call graph*: calls 1 internal fn (issue_summary); 1 external calls (format!).


##### `auth_reachability_note`  (lines 600–615)

```
fn auth_reachability_note(report: &DoctorReport) -> Option<DoctorNote>
```

**Purpose**: Warns when authentication signals disagree between websocket and HTTP reachability checks. For example, it notices ChatGPT login plus API-key mode being used for HTTP.

**Data flow**: It receives the report, finds websocket and reachability checks, reads their auth mode details, compares them in lowercase, and returns a warning note only for the mixed-signal case.

**Call relations**: `notes_for_report` calls it after ordinary notes are gathered. It uses `find_check` and detail lookup helpers to connect information from two separate checks.

*Call graph*: calls 2 internal fn (detail_value, find_check); called by 1 (notes_for_report).


##### `display_summary`  (lines 617–635)

```
fn display_summary(check: &DoctorCheck, options: HumanOutputOptions) -> String
```

**Purpose**: Chooses a friendly one-line summary for a check based on its category. It replaces generic raw summaries with more useful human wording where possible.

**Data flow**: It receives a check and output options. It matches the category, calls the appropriate category-specific summary helper, and falls back to the check's own summary for unknown categories.

**Call relations**: `row_description` calls it for checks that are not being summarized by issue text. It is the dispatcher for helpers like `system_summary`, `sandbox_summary`, and `websocket_summary`.

*Call graph*: calls 12 internal fn (app_server_summary, git_summary, mcp_summary, network_summary, runtime_summary, sandbox_summary, search_summary, state_summary, system_summary, terminal_summary (+2 more)); called by 1 (row_description).


##### `system_summary`  (lines 637–639)

```
fn system_summary(check: &DoctorCheck) -> String
```

**Purpose**: Summarizes the system check with the operating system language when available. This gives a compact environment clue.

**Data flow**: It receives a system check, looks for the `os language` detail, and returns it or the original summary if absent.

**Call relations**: `display_summary` calls it for the `system` category. It relies on the detail module to read labeled detail lines.

*Call graph*: calls 1 internal fn (detail_value); called by 1 (display_summary).


##### `runtime_summary`  (lines 641–648)

```
fn runtime_summary(check: &DoctorCheck) -> String
```

**Purpose**: Summarizes how this Codex binary is running. It specially calls out local debug builds, which are useful for developers to notice.

**Data flow**: It receives a runtime check, checks whether the executable path looks like a local debug build, otherwise returns the install method detail or the original summary.

**Call relations**: `display_summary` calls it for runtime rows. It reads runtime evidence from check details rather than from the filesystem.

*Call graph*: calls 1 internal fn (detail_value); called by 1 (display_summary).


##### `search_summary`  (lines 650–660)

```
fn search_summary(check: &DoctorCheck) -> String
```

**Purpose**: Summarizes the configured search tool when it is ready. It shows readiness, provider, and command in one compact phrase.

**Data flow**: It receives a search check and reads provider, command, and readiness details. If all are present and the check is OK, it returns a combined summary; otherwise it returns the original summary.

**Call relations**: `display_summary` calls it for search rows. It formats the command in backticks so later styling can make it stand out.

*Call graph*: calls 1 internal fn (detail_value); called by 1 (display_summary); 1 external calls (format!).


##### `git_summary`  (lines 662–666)

```
fn git_summary(check: &DoctorCheck) -> String
```

**Purpose**: Summarizes the Git setup using the Git version if available. Git is the version-control tool used to track source changes.

**Data flow**: It receives a Git check, tries to read `git version`, then `selected git`, and finally falls back to the check summary.

**Call relations**: `display_summary` calls it for Git rows. It uses detail lookup helpers to prefer the most informative available field.

*Call graph*: calls 1 internal fn (detail_value); called by 1 (display_summary).


##### `terminal_summary`  (lines 668–685)

```
fn terminal_summary(check: &DoctorCheck) -> String
```

**Purpose**: Builds a compact description of the user's terminal. It can include terminal app, version, multiplexer, and `TERM` value.

**Data flow**: It receives a terminal check, collects available terminal-related details into a list, joins them with separators, and returns the original summary if nothing useful is found.

**Call relations**: `display_summary` calls it for terminal rows. It combines several detail fields into one scan-friendly line.

*Call graph*: calls 1 internal fn (detail_value); called by 1 (display_summary); 2 external calls (new, format!).


##### `title_summary`  (lines 687–698)

```
fn title_summary(check: &DoctorCheck, options: HumanOutputOptions) -> String
```

**Purpose**: Summarizes how terminal titles are configured. It can show both the source of the title setting and the project value.

**Data flow**: It receives a title check and output options. It reads source and project details, chooses an ASCII or Unicode separator, and returns a compact phrase or the original summary.

**Call relations**: `display_summary` calls it for title rows. It uses the same ASCII setting as the rest of the report so punctuation stays terminal-safe.

*Call graph*: calls 1 internal fn (detail_value); called by 1 (display_summary); 1 external calls (format!).


##### `state_summary`  (lines 700–714)

```
fn state_summary(check: &DoctorCheck) -> String
```

**Purpose**: Reports state databases as healthy when all expected database integrity checks say OK. This avoids listing a vague state summary when the important storage checks passed.

**Data flow**: It receives a state check, reads integrity details for state, log, goals, and memories databases, and returns `databases healthy` only when the check is OK and all four are OK.

**Call relations**: `display_summary` calls it for state rows. Tests cover the memories database case so new state databases do not silently disappear from the summary.

*Call graph*: called by 1 (display_summary).


##### `mcp_summary`  (lines 716–739)

```
fn mcp_summary(check: &DoctorCheck) -> String
```

**Purpose**: Summarizes configured MCP servers. MCP means Model Context Protocol, a way for Codex to talk to external tools or data sources.

**Data flow**: It receives an MCP check, reads configured and disabled server counts, scans detail lines for transport-specific counts, and returns a compact server-count summary.

**Call relations**: `display_summary` calls it for MCP rows. It combines labeled details into one human-readable line rather than showing only the generic check summary.

*Call graph*: calls 1 internal fn (detail_value); called by 1 (display_summary); 1 external calls (format!).


##### `sandbox_summary`  (lines 741–751)

```
fn sandbox_summary(check: &DoctorCheck) -> String
```

**Purpose**: Summarizes safety settings for filesystem access, network access, and approval policy. This tells users how restricted Codex actions are.

**Data flow**: It receives a sandbox check, reads approval, filesystem sandbox, and network sandbox details, and returns a combined phrase if all are available.

**Call relations**: `display_summary` calls it for sandbox rows. It complements `sandbox_note`, which may separately promote loose sandbox settings to the Notes section.

*Call graph*: calls 1 internal fn (detail_value); called by 1 (display_summary); 1 external calls (format!).


##### `network_summary`  (lines 753–763)

```
fn network_summary(check: &DoctorCheck) -> String
```

**Purpose**: Summarizes whether proxy-related environment variables are present. A proxy is a network intermediary that can affect connectivity.

**Data flow**: It receives a network check, reads the `proxy env vars` detail, and returns either `no proxy env vars`, `proxy env vars present`, or the original summary.

**Call relations**: `display_summary` calls it for network rows. It turns a raw detail value into wording that is easier to scan.

*Call graph*: calls 1 internal fn (detail_value); called by 1 (display_summary).


##### `websocket_summary`  (lines 765–774)

```
fn websocket_summary(check: &DoctorCheck) -> String
```

**Purpose**: Summarizes websocket connectivity. A websocket is a long-lived network connection used for interactive communication.

**Data flow**: It receives a websocket check, reads handshake status and timeout details, shortens the timeout wording, and returns a connected summary if both pieces exist.

**Call relations**: `display_summary` calls it for websocket rows. It uses detail lookup so either of two handshake detail labels can supply the status.

*Call graph*: calls 1 internal fn (detail_value); called by 1 (display_summary); 1 external calls (format!).


##### `app_server_summary`  (lines 776–783)

```
fn app_server_summary(check: &DoctorCheck) -> String
```

**Purpose**: Summarizes the background server's status and mode. This makes it clear whether the server is running, idle, or using an ephemeral mode.

**Data flow**: It receives an app-server check, reads status and mode details, and returns `status (mode mode)` when both are available.

**Call relations**: `display_summary` calls it for app-server rows. `display_status` may separately mark a not-running OK server as idle.

*Call graph*: calls 1 internal fn (detail_value); called by 1 (display_summary); 1 external calls (format!).


##### `separator`  (lines 785–791)

```
fn separator(options: HumanOutputOptions) -> String
```

**Purpose**: Creates the horizontal divider line used between report sections. It chooses Unicode box drawing or plain hyphens based on terminal compatibility settings.

**Data flow**: It receives output options. If ASCII mode is on, it repeats `-`; otherwise it repeats `─`, using the fixed separator width.

**Call relations**: `render_human_report` and note rendering use this style of divider to visually separate notes and summary content.


##### `highlight_actions`  (lines 793–813)

```
fn highlight_actions(text: &str, options: HumanOutputOptions) -> String
```

**Purpose**: Highlights actionable text such as commands in backticks and command-line flags. This helps users spot what they can copy or run.

**Data flow**: It receives text and options. If color is off, it returns the text unchanged; otherwise it splits around backticks, colors code-like parts, highlights flags in plain parts, and returns the rebuilt text.

**Call relations**: `style_description` uses it before applying status styling. It delegates flag detection to `highlight_flags` and code coloring to `cyan`.

*Call graph*: calls 2 internal fn (cyan, highlight_flags); called by 1 (style_description); 1 external calls (new).


##### `highlight_flags`  (lines 815–830)

```
fn highlight_flags(text: &str, options: HumanOutputOptions) -> String
```

**Purpose**: Highlights command-line flags such as `--json` within ordinary text. It preserves surrounding punctuation and whitespace.

**Data flow**: It receives a text fragment, splits it into whitespace-preserving tokens, checks each token after trimming punctuation, colors tokens starting with `--`, and rejoins the results.

**Call relations**: `highlight_actions` calls it for text outside backticks. It keeps flag highlighting separate from inline-code highlighting.

*Call graph*: called by 1 (highlight_actions).


##### `redact_detail`  (lines 832–860)

```
fn redact_detail(detail: &str) -> String
```

**Purpose**: Removes or masks sensitive detail text before it is shown or serialized. This protects secrets such as tokens, API keys, and private URL paths.

**Data flow**: It receives one detail string. It preserves safe presence values, masks known secret-looking labels as `<redacted>`, strips credentials and sensitive path parts from URLs, and returns the safe string.

**Call relations**: The detail-rendering and JSON-report paths rely on this sanitizer before exposing diagnostic details. Tests call it directly for URL and secret-presence cases.

*Call graph*: calls 1 internal fn (redact_urls); called by 4 (redact_detail_sanitizes_secret_url_path_segments, redact_detail_sanitizes_urls, redacted_json_issue, structured_json_details); 1 external calls (format!).


##### `is_safe_presence_value`  (lines 862–867)

```
fn is_safe_presence_value(value: &str) -> bool
```

**Purpose**: Decides whether a value only says whether something exists, rather than revealing the secret itself. Values like `present` or `false` are safe to show.

**Data flow**: It receives a value string, trims and lowercases it, and returns true for a fixed set of presence-style words.

**Call relations**: `redact_detail` uses it to avoid over-redacting harmless secret status lines, such as “stored tokens: true”.

*Call graph*: 1 external calls (matches!).


##### `redact_urls`  (lines 869–874)

```
fn redact_urls(detail: &str) -> String
```

**Purpose**: Finds URL-like tokens in a detail line and sanitizes each one. It keeps non-URL text unchanged.

**Data flow**: It receives a detail string, splits it while preserving whitespace, sends each token through `redact_url_token`, and joins the results back into a string.

**Call relations**: `redact_detail` calls it for safe labels and for non-secret details that may still contain private URLs.

*Call graph*: called by 1 (redact_detail).


##### `redact_url_token`  (lines 876–914)

```
fn redact_url_token(token: &str) -> String
```

**Purpose**: Sanitizes one URL token by removing embedded credentials, query strings, fragments, and deep path secrets. It keeps enough of the URL to be useful for debugging.

**Data flow**: It receives one token. If there is no URL scheme, it returns it unchanged; otherwise it separates trailing punctuation, strips user info before `@`, removes query and fragment data, redacts deeper path segments, then returns the rebuilt token.

**Call relations**: `redact_urls` applies it to each whitespace-preserved token. It delegates path shortening to `redact_url_path`.

*Call graph*: calls 1 internal fn (redact_url_path); 2 external calls (format!, matches!).


##### `redact_url_path`  (lines 916–926)

```
fn redact_url_path(path: &str) -> String
```

**Purpose**: Shortens URL paths that may contain secret identifiers. It keeps the first path segment and replaces deeper segments with `<redacted>`.

**Data flow**: It receives a URL path. If the path has zero or one segment, it returns it unchanged; if it has more, it returns `/<first>/<redacted>`.

**Call relations**: `redact_url_token` calls it after stripping query and fragment data. This keeps endpoint names visible while hiding likely IDs or tokens.

*Call graph*: called by 1 (redact_url_token); 1 external calls (format!).


##### `StatusCounts::from_report`  (lines 938–953)

```
fn from_report(report: &DoctorReport, notes: usize) -> Self
```

**Purpose**: Counts checks by display status for the final summary line. It includes notes as a separate count supplied by the caller.

**Data flow**: It receives the report and the number of notes. It starts with those notes, walks every check, maps each through `display_status`, increments the matching counter, and returns the count struct.

**Call relations**: `summary_line` calls it before formatting totals. It shares `display_status` with row rendering so idle app-server rows are counted as idle too.

*Call graph*: calls 1 internal fn (display_status); called by 1 (summary_line); 1 external calls (default).


##### `bold`  (lines 956–962)

```
fn bold(text: &str, options: HumanOutputOptions) -> String
```

**Purpose**: Applies bold styling when color and styling are enabled. Otherwise it leaves text plain.

**Data flow**: It receives text and options. If color output is enabled, it returns a bold terminal-styled string; if not, it returns the original text as a string.

**Call relations**: `render_human_report` uses it for headings such as the report title and group titles.


##### `dim`  (lines 964–970)

```
fn dim(text: &str, options: HumanOutputOptions) -> String
```

**Purpose**: Applies dim styling for lower-emphasis text. This is used for context, separators, and healthy details.

**Data flow**: It receives text and options. It returns dimmed terminal text when color is enabled, or plain text when disabled.

**Call relations**: Many formatting helpers use it, including `count_label`, `status_marker`, `style_description`, `summary_line`, and detail styling.

*Call graph*: called by 5 (count_label, status_marker, style_description, style_detail_bare_token, summary_line).


##### `very_dim`  (lines 972–974)

```
fn very_dim(text: &str, options: HumanOutputOptions) -> String
```

**Purpose**: Applies an extra-muted gray color. It is used for small low-emphasis markers such as bullets.

**Data flow**: It receives text and options, then sends the text to `color256` with a dark gray color code.

**Call relations**: `write_detail_line` uses it for bullet markers in detailed output.

*Call graph*: calls 1 internal fn (color256).


##### `detail_label`  (lines 976–978)

```
fn detail_label(text: &str, options: HumanOutputOptions) -> String
```

**Purpose**: Styles the label column in detailed rows. Labels are intentionally quieter than values.

**Data flow**: It receives label text and options, then applies a muted gray color through `color256` when color is enabled.

**Call relations**: `write_detail_line` uses it for detail labels and continuation spacing.

*Call graph*: calls 1 internal fn (color256).


##### `detail_value`  (lines 980–985)

```
fn detail_value(text: &str, options: HumanOutputOptions) -> String
```

**Purpose**: Styles the value part of a detailed row. It highlights useful tokens like paths, URLs, flags, and `ok` while muting low-signal values.

**Data flow**: It receives value text and options. With color disabled it returns the text unchanged; with color enabled it passes the text through detailed token styling.

**Call relations**: `write_detail_line` uses it for displayed detail values. A test calls it directly to verify inline status and low-signal coloring.

*Call graph*: calls 1 internal fn (style_detail_text); called by 2 (detail_value_colors_inline_statuses_and_low_signal_values, write_detail_line).


##### `style_detail_text`  (lines 987–1003)

```
fn style_detail_text(text: &str, options: HumanOutputOptions) -> String
```

**Purpose**: Applies detailed-value styling while treating text in backticks as copyable code. Backticks act like little “highlight this command” markers.

**Data flow**: It receives text and options, splits the text around backticks, styles plain parts token by token, colors code parts cyan, and returns the combined string.

**Call relations**: `detail_value` calls it when color is enabled. It delegates plain text work to `style_detail_plain_text`.

*Call graph*: calls 2 internal fn (cyan, style_detail_plain_text); called by 1 (detail_value); 1 external calls (new).


##### `style_detail_plain_text`  (lines 1005–1009)

```
fn style_detail_plain_text(text: &str, options: HumanOutputOptions) -> String
```

**Purpose**: Styles ordinary detail text one token at a time while preserving whitespace. This keeps alignment and spacing intact.

**Data flow**: It receives plain text and options, splits it into whitespace-preserving tokens, styles each token, and collects the result into one string.

**Call relations**: `style_detail_text` calls it for text outside backticks. It sends each token to `style_detail_token`.

*Call graph*: called by 1 (style_detail_text).


##### `style_detail_token`  (lines 1011–1018)

```
fn style_detail_token(token: &str, options: HumanOutputOptions) -> String
```

**Purpose**: Styles one detail token without losing trailing punctuation or spaces. This avoids coloring commas and spaces as if they were part of a path or flag.

**Data flow**: It receives a token and options, separates trailing whitespace and punctuation, styles the bare token, then rebuilds the full token.

**Call relations**: `style_detail_plain_text` calls it for each token. It delegates the actual decision to `style_detail_bare_token`.

*Call graph*: calls 1 internal fn (style_detail_bare_token); 1 external calls (format!).


##### `style_detail_bare_token`  (lines 1020–1045)

```
fn style_detail_bare_token(bare: &str, options: HumanOutputOptions) -> String
```

**Purpose**: Decides how one bare detail token should look. It highlights good statuses, copyable paths and URLs, flags, and redaction markers while muting missing or false-like values.

**Data flow**: It receives a punctuation-free token and options. It checks special cases such as `<redacted>`, missing values, `ok`, command flags, paths, URLs, and units, then returns the appropriately styled or unchanged token.

**Call relations**: `style_detail_token` calls it after stripping punctuation. It uses `looks_copyable`, the detail module's falsy-value helper, and shared color helpers.

*Call graph*: calls 6 internal fn (color256, cyan, is_falsy, dim, green, looks_copyable); called by 1 (style_detail_token); 3 external calls (new, format!, matches!).


##### `green`  (lines 1047–1049)

```
fn green(text: &str, options: HumanOutputOptions) -> String
```

**Purpose**: Applies the green status color. Green represents OK or healthy information.

**Data flow**: It receives text and options, then calls `color256` with the green color code.

**Call relations**: Status markers, count labels, and detail-token styling use it whenever something should read as healthy.

*Call graph*: calls 1 internal fn (color256); called by 3 (count_label, status_marker, style_detail_bare_token).


##### `amber`  (lines 1051–1053)

```
fn amber(text: &str, options: HumanOutputOptions) -> String
```

**Purpose**: Applies an amber/yellow color for update-related information. It suggests attention without implying failure.

**Data flow**: It receives text and options, then calls `color256` with the amber color code.

**Call relations**: Update notes, update markers, and summary count labels use it through helpers like `status_marker` and `style_update_note_summary`.

*Call graph*: calls 1 internal fn (color256); called by 4 (count_label, status_marker, style_description, style_update_note_summary).


##### `orange`  (lines 1055–1057)

```
fn orange(text: &str, options: HumanOutputOptions) -> String
```

**Purpose**: Applies an orange warning color. It is used for warnings, notes, and issue pointers.

**Data flow**: It receives text and options, then calls `color256` with the orange color code.

**Call relations**: `status_marker`, `count_label`, and `detail_marker` use it for warning-style emphasis.

*Call graph*: calls 1 internal fn (color256); called by 3 (count_label, detail_marker, status_marker).


##### `red`  (lines 1059–1061)

```
fn red(text: &str, options: HumanOutputOptions) -> String
```

**Purpose**: Applies the red failure color. Red marks checks that failed.

**Data flow**: It receives text and options, then calls `color256` with the red color code.

**Call relations**: `status_marker` and `count_label` use it for failed rows and failed totals.

*Call graph*: calls 1 internal fn (color256); called by 2 (count_label, status_marker).


##### `cyan`  (lines 1063–1065)

```
fn cyan(text: &str, options: HumanOutputOptions) -> String
```

**Purpose**: Applies cyan coloring for copyable or action-oriented text such as commands, flags, paths, and URLs.

**Data flow**: It receives text and options, then calls `color256` with the cyan color code.

**Call relations**: `highlight_actions`, `style_detail_text`, and `style_detail_bare_token` use it to make things users might copy stand out.

*Call graph*: calls 1 internal fn (color256); called by 3 (highlight_actions, style_detail_bare_token, style_detail_text).


##### `color256`  (lines 1067–1073)

```
fn color256(text: &str, code: u8, options: HumanOutputOptions) -> String
```

**Purpose**: Centralizes 256-color terminal styling. A 256-color code is a numbered color supported by many terminals.

**Data flow**: It receives text, a color code, and options. If color is enabled, it wraps the text in terminal color styling; otherwise it returns plain text.

**Call relations**: All simple color helpers call it, so color disabling works consistently across the whole renderer.

*Call graph*: called by 8 (amber, cyan, detail_label, green, orange, red, style_detail_bare_token, very_dim); 1 external calls (from).


##### `looks_copyable`  (lines 1075–1083)

```
fn looks_copyable(text: &str) -> bool
```

**Purpose**: Recognizes strings that look like URLs or filesystem paths. These are likely useful for users to copy.

**Data flow**: It receives a text token and returns true if it starts with common URL schemes or path prefixes like `/`, `~/`, `./`, or `../`.

**Call relations**: `style_detail_bare_token` uses it to color copyable detail tokens cyan.

*Call graph*: called by 1 (style_detail_bare_token).


##### `tests::detailed_no_color_unicode_options`  (lines 1091–1098)

```
fn detailed_no_color_unicode_options() -> HumanOutputOptions
```

**Purpose**: Creates test options for detailed Unicode output without color. This gives tests a stable, readable baseline.

**Data flow**: It takes no input and returns `HumanOutputOptions` with details on, all-items off, Unicode symbols on, and color off.

**Call relations**: Many rendering tests call it before `render_human_report` so expected strings do not contain terminal color escape codes.


##### `tests::summary_no_color_unicode_options`  (lines 1100–1107)

```
fn summary_no_color_unicode_options() -> HumanOutputOptions
```

**Purpose**: Creates test options for compact Unicode output without color. It represents the `--summary` style view.

**Data flow**: It takes no input and returns options with details off, all-items off, Unicode symbols on, and color off.

**Call relations**: Summary-output tests use it when checking that compact reports omit detail rows but keep the main sections and notes.


##### `tests::detailed_all_no_color_unicode_options`  (lines 1109–1116)

```
fn detailed_all_no_color_unicode_options() -> HumanOutputOptions
```

**Purpose**: Creates test options for detailed output with expanded lists and no color. This is used to test the `--all` behavior.

**Data flow**: It takes no input and returns options with details on, all-items on, Unicode symbols on, and color off.

**Call relations**: The feature-flag expansion test compares this option set with the normal detailed option set.


##### `tests::detailed_color_unicode_options`  (lines 1118–1125)

```
fn detailed_color_unicode_options() -> HumanOutputOptions
```

**Purpose**: Creates test options for detailed Unicode output with color enabled. This lets tests check terminal color styling.

**Data flow**: It takes no input and returns options with details on, all-items off, Unicode symbols on, and color on.

**Call relations**: Color-focused tests call it when verifying detail-value styling and update-note emphasis.


##### `tests::sample_report`  (lines 1127–1237)

```
fn sample_report() -> DoctorReport
```

**Purpose**: Builds a representative doctor report for tests. It includes healthy checks, warnings, failures, details, and remediation text.

**Data flow**: It takes no input, constructs a vector of `DoctorCheck` values, wraps them in a `DoctorReport`, and returns it.

**Call relations**: Many tests pass this report into `render_human_report` to check full report layout across detailed, summary, ASCII, and color modes.

*Call graph*: 1 external calls (vec!).


##### `tests::render_human_report_includes_details_by_default_without_color`  (lines 1240–1300)

```
fn render_human_report_includes_details_by_default_without_color()
```

**Purpose**: Verifies the full detailed, no-color Unicode report layout. It protects the expected wording, grouping, detail rows, summary, and footer.

**Data flow**: It builds the sample report and detailed options, renders the report, builds the expected string, and asserts exact equality.

**Call relations**: It calls `render_human_report` as a user-facing integration test for most renderer pieces working together.

*Call graph*: calls 1 internal fn (render_human_report); 4 external calls (assert_eq!, detailed_no_color_unicode_options, sample_report, format!).


##### `tests::render_human_report_snapshot_covers_environment_rows`  (lines 1303–1308)

```
fn render_human_report_snapshot_covers_environment_rows()
```

**Purpose**: Captures a snapshot of the rendered report, with emphasis on environment rows. Snapshot tests compare current output to a stored known-good output.

**Data flow**: It renders the sample report with detailed no-color options and passes the result to the snapshot assertion tool.

**Call relations**: It exercises `render_human_report` indirectly through the snapshot macro and helps catch accidental formatting changes.

*Call graph*: 1 external calls (assert_snapshot!).


##### `tests::render_human_report_supports_summary_output_without_color`  (lines 1311–1355)

```
fn render_human_report_supports_summary_output_without_color()
```

**Purpose**: Verifies compact summary output without detail rows. It ensures `--summary` style output is shorter but still complete.

**Data flow**: It renders the sample report with summary options, constructs the expected compact text, and checks exact equality.

**Call relations**: It calls `render_human_report` and confirms that `write_check_row` respects the `show_details` option.

*Call graph*: calls 1 internal fn (render_human_report); 4 external calls (assert_eq!, sample_report, summary_no_color_unicode_options, format!).


##### `tests::render_human_report_includes_threads_row_in_environment`  (lines 1358–1377)

```
fn render_human_report_includes_threads_row_in_environment()
```

**Purpose**: Ensures the `threads` category appears under Environment. This protects a category that could otherwise be hidden from the human view.

**Data flow**: It adds a threads warning check to the sample report, renders compact output, finds the line containing `threads`, and checks that the warning text is present.

**Call relations**: It tests the group-key mapping used by `checks_for_group` through the public renderer.

*Call graph*: calls 2 internal fn (new, render_human_report); 3 external calls (assert!, sample_report, summary_no_color_unicode_options).


##### `tests::render_human_report_includes_memories_db_in_state_health_summary`  (lines 1380–1408)

```
fn render_human_report_includes_memories_db_in_state_health_summary()
```

**Purpose**: Ensures the state health summary includes the memories database integrity check. This prevents one database from being overlooked in the healthy-state wording.

**Data flow**: It builds a report with state, log, goals, and memories database details all marked OK, renders it, and asserts both the healthy summary and memories detail are present.

**Call relations**: It exercises `state_summary`, detail rendering, and `render_human_report` together.

*Call graph*: calls 1 internal fn (render_human_report); 3 external calls (assert!, detailed_no_color_unicode_options, vec!).


##### `tests::render_human_report_supports_ascii_output`  (lines 1411–1463)

```
fn render_human_report_supports_ascii_output()
```

**Purpose**: Verifies that the renderer can avoid Unicode symbols. This matters for terminals or logs that handle plain ASCII more reliably.

**Data flow**: It renders the sample report with ASCII enabled and details off, then compares the whole output to an expected ASCII-only string.

**Call relations**: It tests `render_human_report` along with marker, separator, and title-summary choices controlled by the ASCII option.

*Call graph*: calls 1 internal fn (render_human_report); 3 external calls (assert_eq!, sample_report, format!).


##### `tests::render_human_report_includes_redacted_details`  (lines 1466–1477)

```
fn render_human_report_includes_redacted_details()
```

**Purpose**: Checks that detail output includes safe redacted-style presence information. In the sample, an API key detail shows only `present`, not the key itself.

**Data flow**: It renders the sample report with details enabled and asserts that the safe API-key presence line appears.

**Call relations**: It exercises `render_human_report` and the detail rendering path that uses sanitized details from the detail module.

*Call graph*: calls 1 internal fn (render_human_report); 2 external calls (assert!, sample_report).


##### `tests::render_human_report_explains_terminal_warning_issue`  (lines 1480–1516)

```
fn render_human_report_explains_terminal_warning_issue()
```

**Purpose**: Verifies that a warning with a structured issue shows the issue cause, expected value, and remedy. This protects the most actionable warning format.

**Data flow**: It builds a report with a narrow-terminal issue, renders detailed output, and asserts that the warning row, issue detail, and remedy are present while a less useful summary is absent.

**Call relations**: It tests `row_description`, `issue_summary`, `write_detail_line`, and the detailed issue display through `render_human_report`.

*Call graph*: calls 1 internal fn (render_human_report); 3 external calls (assert!, detailed_no_color_unicode_options, vec!).


##### `tests::render_human_report_promotes_notes_without_changing_statuses`  (lines 1519–1594)

```
fn render_human_report_promotes_notes_without_changing_statuses()
```

**Purpose**: Verifies that notable conditions appear as notes while the underlying check statuses remain counted correctly. Notes should inform, not rewrite the report's facts.

**Data flow**: It builds a report with update, rollout, sandbox, MCP, auth-mode, and idle server cases, renders summary output, and asserts the notes and final counts.

**Call relations**: It exercises `notes_for_report`, note builders, `display_status`, `summary_line`, and `render_human_report` together.

*Call graph*: calls 1 internal fn (render_human_report); 3 external calls (assert!, summary_no_color_unicode_options, vec!).


##### `tests::render_human_report_expands_feature_flags_with_all`  (lines 1597–1623)

```
fn render_human_report_expands_feature_flags_with_all()
```

**Purpose**: Checks that compact detailed output summarizes feature flags, while `--all` expands the full list. This keeps normal output short without hiding data when requested.

**Data flow**: It builds a config-only report with feature flag details, renders once with normal detailed options and once with all-items options, then compares expected snippets.

**Call relations**: It calls `render_human_report`; the feature-flag detail behavior comes from the detail module used by `write_check_row`.

*Call graph*: calls 1 internal fn (render_human_report); 4 external calls (assert!, detailed_all_no_color_unicode_options, detailed_no_color_unicode_options, vec!).


##### `tests::detail_value_colors_inline_statuses_and_low_signal_values`  (lines 1626–1637)

```
fn detail_value_colors_inline_statuses_and_low_signal_values()
```

**Purpose**: Verifies colored detail-value styling for statuses, low-signal values, copyable paths, and redaction markers. This protects the visual language of detailed rows.

**Data flow**: It passes a sample detail string into `detail_value` with color enabled and checks for expected terminal color escape sequences.

**Call relations**: It directly tests `detail_value` and, through it, `style_detail_text` and token styling helpers.

*Call graph*: calls 1 internal fn (detail_value); 2 external calls (assert!, detailed_color_unicode_options).


##### `tests::update_note_emphasizes_available_version_and_dims_context`  (lines 1640–1648)

```
fn update_note_emphasizes_available_version_and_dims_context()
```

**Purpose**: Verifies that update notes emphasize the available version and dim the context. This keeps update prompts easy to scan.

**Data flow**: It passes a sample update note summary into `style_update_note_summary` with color enabled and checks for the expected color sequences.

**Call relations**: It directly tests the helper used by `style_note_summary` for update notes.

*Call graph*: calls 1 internal fn (style_update_note_summary); 2 external calls (assert!, detailed_color_unicode_options).


##### `tests::redact_detail_sanitizes_urls`  (lines 1651–1660)

```
fn redact_detail_sanitizes_urls()
```

**Purpose**: Ensures URL redaction removes credentials, query strings, and fragments while keeping the host and first path segment. This protects private connection details.

**Data flow**: It passes a failure message containing a credentialed URL to `redact_detail` and compares the sanitized output to the expected safe form.

**Call relations**: It directly exercises `redact_detail`, which in turn uses the URL redaction helpers.

*Call graph*: calls 1 internal fn (redact_detail); 1 external calls (assert_eq!).


##### `tests::redact_detail_sanitizes_secret_url_path_segments`  (lines 1663–1670)

```
fn redact_detail_sanitizes_secret_url_path_segments()
```

**Purpose**: Ensures deeper URL path segments are redacted because they may contain secret IDs or tokens.

**Data flow**: It passes a URL with two path segments into `redact_detail` and checks that the second segment becomes `<redacted>`.

**Call relations**: It tests the path-shortening behavior provided by `redact_url_path` through the public redaction helper.

*Call graph*: calls 1 internal fn (redact_detail); 1 external calls (assert_eq!).


##### `tests::redact_detail_preserves_env_var_names`  (lines 1673–1678)

```
fn redact_detail_preserves_env_var_names()
```

**Purpose**: Ensures environment variable names are not removed just because they contain secret-like words. The names themselves are useful and not secret.

**Data flow**: It compares an environment-variable presence line to the expected unchanged output.

**Call relations**: It protects the `redact_detail` rule that treats environment-variable listing lines differently from secret values.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::redact_detail_preserves_secret_presence_booleans`  (lines 1681–1690)

```
fn redact_detail_preserves_secret_presence_booleans()
```

**Purpose**: Ensures boolean secret-presence values stay visible. Knowing whether tokens exist is useful, while the token contents remain hidden.

**Data flow**: It checks that lines ending in `true` and `false` remain unchanged after redaction.

**Call relations**: It protects the `is_safe_presence_value` path used by `redact_detail`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::render_human_report_can_emit_color`  (lines 1693–1704)

```
fn render_human_report_can_emit_color()
```

**Purpose**: Verifies that color-enabled rendering actually emits terminal color escape sequences. This catches accidental disabling of colored output.

**Data flow**: It renders the sample report with color enabled and asserts that the output contains an escape-code prefix.

**Call relations**: It exercises `render_human_report` and the color helpers as a broad end-to-end color smoke test.

*Call graph*: calls 1 internal fn (render_human_report); 2 external calls (assert!, sample_report).


### `cli/src/doctor/output/detail.rs`

`domain_logic` · `doctor output rendering`

Doctor checks store their details as simple text like `label: value`. That is convenient for saving as JSON, but it is not always pleasant to read in a terminal. This file is the translator between those raw strings and the human-facing doctor report. It decides which details matter most for each check category, such as system, runtime, install, Git, config, or saved state. It also groups repeated items, hides noisy values unless `--all` is used, shortens long paths, formats timestamps, and attaches extra hints from any issue the check found. Think of it like a receptionist turning a pile of form answers into a tidy summary sheet: the facts stay the same, but the order and wording become easier to understand. Without this file, the doctor command would either show raw machine-friendly strings or every caller would need to repeat the same display rules. A key idea is that this file does presentation work only. The checks still create the source facts; this code reshapes them into `HumanDetail` rows, continuation lines, bullet notes, and remedies.

#### Function details

##### `detail_lines`  (lines 37–56)

```
fn detail_lines(check: &DoctorCheck, options: HumanOutputOptions) -> Vec<HumanDetail>
```

**Purpose**: Builds the final list of human-readable detail lines for one doctor check. It chooses the right formatting path based on the check category, then adds issue expectations, shortens values, and appends suggested remedies.

**Data flow**: It receives a `DoctorCheck` and display options such as whether `--all` was requested. It first parses the raw detail strings, sends them to the category-specific formatter, enriches rows with issue metadata, humanizes values like paths and timestamps, then returns a list of rows, bullets, continuations, and remedies.

**Call relations**: This is the main entry point of the file. `write_check_row` calls it when a check is being printed, and it delegates to helpers such as `system_details`, `runtime_details`, `install_details`, `git_details`, `config_details`, `state_details`, or `generic_details` depending on the category.

*Call graph*: calls 10 internal fn (config_details, generic_details, git_details, install_details, issue_remedies, parsed_details, runtime_details, state_details, system_details, title_details); called by 1 (write_check_row).


##### `system_details`  (lines 58–92)

```
fn system_details(parsed: &[ParsedDetail]) -> Vec<HumanDetail>
```

**Purpose**: Creates readable rows for system-related facts, such as operating system, language, and terminal/editor environment variables. It puts the most recognizable items first.

**Data flow**: It receives already-parsed label/value details. It copies selected labels into display rows with friendly names, then adds any leftover details that were not already shown.

**Call relations**: `detail_lines` calls this for checks in the `system` category. It relies on `push_row_if_present` for important known fields and `push_remaining` so unusual extra fields are not lost.

*Call graph*: calls 2 internal fn (push_remaining, push_row_if_present); called by 1 (detail_lines); 1 external calls (new).


##### `detail_value`  (lines 94–99)

```
fn detail_value(check: &DoctorCheck, label: &str) -> Option<String>
```

**Purpose**: Looks up one raw detail value from a doctor check by label. Other summary code uses it when it needs a single fact rather than the full displayed detail list.

**Data flow**: It receives a check and a label to search for. It parses the check details, finds the first parsed entry with that exact label, and returns its value if present.

**Call relations**: This is a small lookup tool used by higher-level summary functions such as runtime, Git, network, sandbox, authentication, MCP, and rollout summaries. It shares the same parsing path as `detail_lines`, so summaries and detail rendering read the same source data.

*Call graph*: calls 1 internal fn (parsed_details); called by 15 (app_server_summary, auth_reachability_note, git_summary, mcp_summary, network_summary, rollout_note, runtime_summary, sandbox_note, sandbox_summary, search_summary (+5 more)).


##### `rollout_summary`  (lines 101–114)

```
fn rollout_summary(value: &str) -> Option<String>
```

**Purpose**: Turns a verbose rollout file count string into a compact, readable summary. It is used so storage-related doctor output says something like file count and size in a quick-to-scan way.

**Data flow**: It receives text expected to contain file count, total bytes, and average bytes. It extracts those numbers, formats the count with commas and the byte values as KB/MB/GB where appropriate, and returns a short summary string; if the text does not match, it returns nothing.

**Call relations**: `state_details` uses this when showing active and archived rollout files. It works with `format_count` and `format_bytes` to turn plain numbers into human-friendly text.

*Call graph*: called by 1 (state_details); 1 external calls (format!).


##### `rollout_files_and_bytes`  (lines 116–123)

```
fn rollout_files_and_bytes(value: &str) -> Option<(u64, u64)>
```

**Purpose**: Extracts the two most important rollout storage numbers: how many files exist and how many bytes they use. It is useful for summary logic that needs numbers, not display text.

**Data flow**: It receives a rollout statistic string. It parses the leading file count and total byte count, then returns them as numbers if both can be read.

**Call relations**: This helper is called by rollout note logic outside this file. It uses the same expected source format as `rollout_summary`, keeping numeric rollout interpretation in one place.

*Call graph*: called by 1 (rollout_note).


##### `format_bytes`  (lines 125–140)

```
fn format_bytes(bytes: u64) -> String
```

**Purpose**: Formats a byte count into a size people can quickly understand. For example, large raw byte numbers become KB, MB, or GB.

**Data flow**: It receives a number of bytes. It compares the value to common size thresholds and returns a string with the appropriate unit and two decimal places for larger units.

**Call relations**: It supports rollout size display, especially through `rollout_summary`. This keeps size wording consistent wherever rollout storage is summarized.

*Call graph*: 1 external calls (format!).


##### `format_count`  (lines 142–158)

```
fn format_count(count: u64) -> String
```

**Purpose**: Adds comma separators to large whole numbers. This makes counts like file totals easier to read at a glance.

**Data flow**: It receives a number, splits its decimal digits into groups of three from the right, and returns the grouped text.

**Call relations**: `rollout_summary` uses it when showing how many rollout files exist. It is a display helper rather than a checker.

*Call graph*: 2 external calls (new, format!).


##### `parsed_details`  (lines 160–178)

```
fn parsed_details(check: &DoctorCheck) -> Vec<ParsedDetail>
```

**Purpose**: Converts raw doctor detail strings into simple label/value records. It is the shared first step before either full rendering or single-value lookup.

**Data flow**: It reads each detail string from a check, redacts sensitive parts through `redact_detail`, then splits strings shaped like `label: value`. Strings without that separator become unlabeled bullet-style values.

**Call relations**: `detail_lines` uses it before formatting a check, and `detail_value` uses it for direct lookup. This keeps redaction and parsing consistent across all doctor output.

*Call graph*: called by 2 (detail_lines, detail_value).


##### `runtime_details`  (lines 180–199)

```
fn runtime_details(parsed: &[ParsedDetail]) -> Vec<HumanDetail>
```

**Purpose**: Creates readable rows for facts about the running Codex program, such as version, install method, commit, and executable path.

**Data flow**: It receives parsed details, pulls out important runtime labels in a preferred order, renames some labels for display, then appends any unrecognized details.

**Call relations**: `detail_lines` calls it for the `runtime` category. It uses the shared row and leftover helpers so runtime output follows the same style as other categories.

*Call graph*: calls 2 internal fn (push_remaining, push_row_if_present); called by 1 (detail_lines); 1 external calls (new).


##### `install_details`  (lines 201–272)

```
fn install_details(parsed: &[ParsedDetail], options: HumanOutputOptions) -> Vec<HumanDetail>
```

**Purpose**: Creates readable rows for installation-related facts, including package-manager ownership and where Codex appears in `PATH`. `PATH` is the operating system list of places searched for commands.

**Data flow**: It receives parsed install details and output options. It builds a context row, notes a special ignored inherited package-manager environment case, combines npm/bun/package-root facts into one row, shows a shortened list of matching `PATH` entries unless `--all` is set, and then appends leftovers.

**Call relations**: `detail_lines` calls it for the `install` category. It uses `numbered_values` to gather repeated `PATH` entries, `value` for named facts, and `push_remaining` to preserve details not specially formatted.

*Call graph*: calls 4 internal fn (numbered_values, push_remaining, push_row_if_present, value); called by 1 (detail_lines); 5 external calls (new, Bullet, Continuation, iter, format!).


##### `git_details`  (lines 274–331)

```
fn git_details(parsed: &[ParsedDetail], options: HumanOutputOptions) -> Vec<HumanDetail>
```

**Purpose**: Creates readable rows for Git-related facts, such as which Git executable was selected, its version, repository information, and Git entries found in `PATH`.

**Data flow**: It receives parsed Git details and display options. It emits common Git fields in a helpful order, groups numbered Git `PATH` entries, limits long lists unless `--all` is requested, and then includes any remaining details.

**Call relations**: `detail_lines` calls it for the `git` category. Like install output, it uses `numbered_values`, `push_row_if_present`, and `push_remaining` to combine known fields with safe fallback display.

*Call graph*: calls 3 internal fn (numbered_values, push_remaining, push_row_if_present); called by 1 (detail_lines); 3 external calls (new, Continuation, format!).


##### `title_details`  (lines 333–363)

```
fn title_details(parsed: &[ParsedDetail]) -> Vec<HumanDetail>
```

**Purpose**: Creates readable rows for terminal title configuration and detected title parts. This helps explain what Codex would put in the terminal window title.

**Data flow**: It receives parsed title details, selects title source, items, activity, and project fields in a fixed order, then adds any leftover title-related information.

**Call relations**: `detail_lines` calls it for the `title` category. It uses the same row-building helpers as the other category formatters.

*Call graph*: calls 2 internal fn (push_remaining, push_row_if_present); called by 1 (detail_lines); 1 external calls (new).


##### `config_details`  (lines 365–418)

```
fn config_details(parsed: &[ParsedDetail], options: HumanOutputOptions) -> Vec<HumanDetail>
```

**Purpose**: Creates readable rows for configuration facts, such as the selected model, current folder, config file status, MCP servers, and feature flags. MCP means Model Context Protocol, a way tools or servers can provide context to the model.

**Data flow**: It receives parsed config details and output options. It combines model and provider into one row, adds key config-file and server rows, summarizes feature flags, lists legacy aliases, and finally appends anything not already consumed.

**Call relations**: `detail_lines` calls it for the `config` category. It delegates feature-flag display to `push_feature_flags` and uses common helpers for named rows and remaining data.

*Call graph*: calls 4 internal fn (push_feature_flags, push_remaining, push_row_if_present, value); called by 1 (detail_lines); 2 external calls (new, iter).


##### `state_details`  (lines 420–464)

```
fn state_details(parsed: &[ParsedDetail]) -> Vec<HumanDetail>
```

**Purpose**: Creates readable rows for local state files and databases, including logs, SQLite locations, database integrity, and rollout file storage. SQLite is a small file-based database.

**Data flow**: It receives parsed state details. It adds important folders, combines each database path with its integrity result when available, summarizes rollout file counts and sizes, then appends any unshown details.

**Call relations**: `detail_lines` calls it for the `state` category. It relies on `push_database_row` for database rows and `rollout_summary` for compact rollout storage text.

*Call graph*: calls 5 internal fn (push_database_row, push_remaining, push_row_if_present, rollout_summary, value); called by 1 (detail_lines); 1 external calls (new).


##### `generic_details`  (lines 466–481)

```
fn generic_details(parsed: &[ParsedDetail]) -> Vec<HumanDetail>
```

**Purpose**: Provides a fallback display for check categories that do not have custom formatting. It ensures unknown or new details still appear instead of disappearing.

**Data flow**: It receives parsed details. Entries with labels become rows using display-friendly labels; entries without labels become bullet lines.

**Call relations**: `detail_lines` calls this when a check category has no specialized formatter. It is the safety net for forward compatibility.

*Call graph*: called by 1 (detail_lines); 1 external calls (iter).


##### `push_feature_flags`  (lines 483–513)

```
fn push_feature_flags(
    out: &mut Vec<HumanDetail>,
    parsed: &[ParsedDetail],
    options: HumanOutputOptions,
)
```

**Purpose**: Adds a compact feature-flag summary to config output. Feature flags are switches that enable or change behavior, often for experimental or optional features.

**Data flow**: It reads the count of enabled flags and any override list from parsed details. It writes a summary row, optionally writes override names, and only expands the full enabled-flag list when `--all` is requested.

**Call relations**: `config_details` calls this while building config rows. It uses `list_items`, `override_names`, and `push_list_row` to turn comma-separated raw data into readable list rows.

*Call graph*: calls 4 internal fn (list_items, override_names, push_list_row, value); called by 1 (config_details); 1 external calls (format!).


##### `push_list_row`  (lines 515–540)

```
fn push_list_row(
    out: &mut Vec<HumanDetail>,
    label: &str,
    items: &[String],
    options: HumanOutputOptions,
)
```

**Purpose**: Adds one row containing a comma-separated list, with optional truncation. It keeps long lists from overwhelming normal doctor output.

**Data flow**: It receives an output list, a row label, list items, and display options. It joins either all items or a limited number of them into one string, adds a `--all` hint if some were hidden, and appends the row.

**Call relations**: `push_feature_flags` uses it for feature flag override and enabled-flag lists. It centralizes the list-shortening behavior.

*Call graph*: called by 1 (push_feature_flags).


##### `push_database_row`  (lines 542–556)

```
fn push_database_row(out: &mut Vec<HumanDetail>, parsed: &[ParsedDetail], label: &str)
```

**Purpose**: Adds a state database row, optionally including its integrity result. Integrity here means whether the database passed a consistency check.

**Data flow**: It receives an output list, parsed details, and a database label. If the database path exists, it looks for a matching integrity field, combines both pieces when possible, and appends one row.

**Call relations**: `state_details` calls it for state, log, goals, and memories databases. It uses `value` to read the path and integrity facts.

*Call graph*: calls 1 internal fn (value); called by 1 (state_details); 1 external calls (format!).


##### `push_row_if_present`  (lines 558–571)

```
fn push_row_if_present(
    out: &mut Vec<HumanDetail>,
    parsed: &[ParsedDetail],
    source_label: &str,
    display_label: &str,
)
```

**Purpose**: Adds a row only when a named detail exists. It avoids empty rows while letting category formatters ask for known fields in a clear order.

**Data flow**: It receives an output list, parsed details, a source label, and the label to show to the user. If the source label is found, it appends a row with the display label and found value.

**Call relations**: Most category formatters call this, including system, runtime, install, Git, title, config, and state formatting. It is the common building block for known detail fields.

*Call graph*: calls 1 internal fn (value); called by 7 (config_details, git_details, install_details, runtime_details, state_details, system_details, title_details).


##### `push_remaining`  (lines 573–600)

```
fn push_remaining(
    out: &mut Vec<HumanDetail>,
    parsed: &[ParsedDetail],
    consumed_labels: &[&str],
    consumed_prefixes: &[&str],
)
```

**Purpose**: Adds parsed details that were not already consumed by a specialized formatter. This protects against losing new or unusual facts.

**Data flow**: It receives output rows, all parsed details, exact labels already handled, and label prefixes already handled. It skips consumed entries and a special noisy install note, then appends the rest as rows or bullets.

**Call relations**: Each category formatter calls it after placing its preferred rows. It uses `display_label` to rename a few technical labels before showing them.

*Call graph*: calls 1 internal fn (display_label); called by 7 (config_details, git_details, install_details, runtime_details, state_details, system_details, title_details); 1 external calls (Bullet).


##### `humanize_detail`  (lines 602–619)

```
fn humanize_detail(detail: HumanDetail, options: HumanOutputOptions) -> HumanDetail
```

**Purpose**: Applies final readability cleanup to one displayed detail. It shortens values where useful while leaving remedy text untouched.

**Data flow**: It receives a `HumanDetail` and output options. For rows, continuations, and bullets, it sends the visible value through `humanize_value`; for remedies, it returns the remedy as-is.

**Call relations**: `detail_lines` applies this after category formatting and issue metadata attachment. It hands value cleanup to `humanize_value`.

*Call graph*: calls 1 internal fn (humanize_value); 3 external calls (Bullet, Continuation, Remedy).


##### `attach_issue_metadata`  (lines 621–636)

```
fn attach_issue_metadata(detail: HumanDetail, check: &DoctorCheck) -> HumanDetail
```

**Purpose**: Adds expected-value information to a row when a doctor issue says what the value should have been. This makes problem rows more helpful without changing normal rows.

**Data flow**: It receives a display detail and the original check. If the detail is a row and does not already have an expected value, it searches the check issues for a matching field and attaches that expected text.

**Call relations**: `detail_lines` applies this to formatted rows before final humanization. It asks `issue_expected_for_label` to find the matching expectation.


##### `issue_expected_for_label`  (lines 638–649)

```
fn issue_expected_for_label(check: &DoctorCheck, label: &str) -> Option<String>
```

**Purpose**: Finds the expected value for a displayed row label from the check's issues. It bridges issue fields, which may use raw labels, and the labels shown to people.

**Data flow**: It receives a check and a displayed label. It scans the check's issues, compares each issue field both directly and through `display_label`, and returns the issue's expected value if there is a match.

**Call relations**: `attach_issue_metadata` uses this while enriching rows. It lets issue information appear next to the detail row that caused the issue.


##### `issue_remedies`  (lines 651–661)

```
fn issue_remedies(check: &DoctorCheck) -> Vec<HumanDetail>
```

**Purpose**: Collects unique remedy messages from a check's issues. Remedies are suggested actions a user can take to fix a problem.

**Data flow**: It receives a check, walks through issue remedies, removes duplicates using a sorted set, and returns them as remedy detail lines.

**Call relations**: `detail_lines` appends these after the normal details. This keeps fix suggestions close to the check output without repeating the same remedy multiple times.

*Call graph*: called by 1 (detail_lines); 1 external calls (new).


##### `humanize_value`  (lines 663–671)

```
fn humanize_value(value: &str, _options: HumanOutputOptions) -> String
```

**Purpose**: Turns certain raw values into friendlier terminal text. It currently recognizes paths and UTC timestamps.

**Data flow**: It receives a string value. If it looks like a path, it shortens the path; otherwise, if it looks like an ISO-style UTC timestamp, it formats the date and time more readably; otherwise, it returns the original text.

**Call relations**: `humanize_detail` calls this for rows, bullets, and continuation lines. It delegates path work to `shorten_path_prefix` and timestamp work to `humanize_timestamp`.

*Call graph*: calls 3 internal fn (humanize_timestamp, looks_like_path, shorten_path_prefix); called by 1 (humanize_detail).


##### `humanize_timestamp`  (lines 673–680)

```
fn humanize_timestamp(value: &str) -> Option<String>
```

**Purpose**: Converts a timestamp ending in `Z` into a simpler UTC date-and-time display. The `Z` means the time is in UTC, a standard worldwide time zone.

**Data flow**: It receives a string. If the string appears to contain a date, a `T`, a time, and a trailing `Z`, it returns text like `date hour:minute UTC`; otherwise it returns nothing.

**Call relations**: `humanize_value` tries this after path detection. It only changes values that match the expected timestamp shape.

*Call graph*: called by 1 (humanize_value); 1 external calls (format!).


##### `shorten_path_prefix`  (lines 682–690)

```
fn shorten_path_prefix(value: &str) -> String
```

**Purpose**: Makes long filesystem paths fit better in terminal output. It also preserves suffix notes such as text in parentheses after the path.

**Data flow**: It receives a value that looks like a path, separates any parenthesized suffix, replaces the home directory with `~` when possible, truncates the middle if the result is too long, and returns the recombined text.

**Call relations**: `humanize_value` calls this for path-like values. It uses `home_shortened_path` for home-directory replacement and `middle_truncate` for length control.

*Call graph*: calls 2 internal fn (home_shortened_path, middle_truncate); called by 1 (humanize_value); 1 external calls (format!).


##### `home_shortened_path`  (lines 692–702)

```
fn home_shortened_path(path: &str) -> String
```

**Purpose**: Replaces the user's home directory prefix with `~`, the common shorthand for home. This makes personal paths shorter and easier to scan.

**Data flow**: It receives a path string and reads the `HOME` environment variable. If the path is exactly the home folder, it returns `~`; if it starts inside home, it returns `~/...`; otherwise it leaves the path unchanged.

**Call relations**: `shorten_path_prefix` calls this before truncating long paths. It depends on the process environment for the home directory.

*Call graph*: called by 1 (shorten_path_prefix); 2 external calls (var_os, format!).


##### `middle_truncate`  (lines 704–721)

```
fn middle_truncate(value: &str, max_chars: usize) -> String
```

**Purpose**: Shortens a long string by keeping the beginning and end and replacing the middle with an ellipsis. This is useful for paths, where both the start and filename often matter.

**Data flow**: It receives a string and a maximum character count. If the string already fits, it returns it unchanged; otherwise it builds a shortened version with the first part, `…`, and the last part.

**Call relations**: `shorten_path_prefix` calls this after home-directory shortening. It is careful to count characters rather than raw bytes, which matters for non-ASCII text.

*Call graph*: called by 1 (shorten_path_prefix); 1 external calls (format!).


##### `looks_like_path`  (lines 723–728)

```
fn looks_like_path(value: &str) -> bool
```

**Purpose**: Detects whether a value appears to be a filesystem path. This lets display cleanup avoid treating every string as a path.

**Data flow**: It receives a string and checks for common path starts such as `/`, `~/`, `./`, or `../`. It returns true when one of those prefixes is present.

**Call relations**: `humanize_value` calls this before path shortening. It is the gatekeeper for path-specific formatting.

*Call graph*: called by 1 (humanize_value).


##### `numbered_values`  (lines 730–736)

```
fn numbered_values(parsed: &[ParsedDetail], prefix: &str) -> Vec<String>
```

**Purpose**: Collects values whose labels share a numbered prefix, such as repeated `PATH` entries. It turns many similarly named fields into one ordered list.

**Data flow**: It receives parsed details and a label prefix. It filters entries whose labels start with that prefix and returns their values in the same order.

**Call relations**: `install_details` uses it for Codex `PATH` entries, and `git_details` uses it for Git `PATH` entries. Those formatters then decide how many entries to show.

*Call graph*: called by 2 (git_details, install_details); 1 external calls (iter).


##### `value`  (lines 738–743)

```
fn value(parsed: &'a [ParsedDetail], label: &str) -> Option<&'a str>
```

**Purpose**: Finds the value for one exact label inside parsed details. It is the basic lookup helper used by many formatting routines.

**Data flow**: It receives parsed details and a label. It searches for the first detail with that label and returns the value as borrowed text, or nothing if missing.

**Call relations**: Category formatters and helpers such as `config_details`, `install_details`, `state_details`, `push_feature_flags`, `push_database_row`, and `push_row_if_present` use it whenever they need a named fact.

*Call graph*: called by 6 (config_details, install_details, push_database_row, push_feature_flags, push_row_if_present, state_details); 1 external calls (iter).


##### `display_label`  (lines 745–753)

```
fn display_label(label: &str) -> String
```

**Purpose**: Renames a few technical labels into friendlier labels for terminal output. Labels not in its small rename table are left unchanged.

**Data flow**: It receives a raw label. If it matches one of the known technical phrases, it returns a clearer replacement; otherwise it returns the original label as a string.

**Call relations**: `push_remaining` uses it before showing leftover details, and issue matching also uses the same display-label idea so expected values can attach to renamed rows.

*Call graph*: called by 1 (push_remaining).


##### `list_items`  (lines 755–765)

```
fn list_items(value: &str) -> Vec<String>
```

**Purpose**: Turns a comma-separated text field into a clean list of items. It treats empty or false-like values as no list at all.

**Data flow**: It receives a string. If the string is considered false or absent, it returns an empty list; otherwise it splits on commas, trims spaces, drops empty items, and returns the item strings.

**Call relations**: `push_feature_flags` uses it to read feature flag override and enabled-flag lists. It relies on `is_falsy` to understand values such as `none` or `not set`.

*Call graph*: calls 1 internal fn (is_falsy); called by 1 (push_feature_flags); 1 external calls (new).


##### `override_names`  (lines 767–773)

```
fn override_names(items: &[String]) -> Vec<String>
```

**Purpose**: Extracts just the flag names from feature-flag override entries. This keeps the summary concise when overrides are written as `name=value`.

**Data flow**: It receives a list of override strings. For each item, it keeps the part before `=` when present, or the whole item when there is no `=`.

**Call relations**: `push_feature_flags` calls it before showing override names through `push_list_row`. It hides override values in the compact display while preserving which flags were overridden.

*Call graph*: called by 1 (push_feature_flags).


##### `yes_no`  (lines 775–777)

```
fn yes_no(value: &str) -> &'static str
```

**Purpose**: Converts a raw boolean-like string into `yes` or `no` for display. It makes package-manager ownership rows easier to read than `true` and `false`.

**Data flow**: It receives a string. If the value is exactly `true`, it returns `yes`; every other value returns `no`.

**Call relations**: `install_details` uses it when combining npm and bun management facts into one human-readable row.


##### `is_falsy`  (lines 779–784)

```
fn is_falsy(value: &str) -> bool
```

**Purpose**: Decides whether a text value means absent, disabled, or unknown. It recognizes several common spellings so display code can avoid showing fake list items or misleading values.

**Data flow**: It receives a string, trims it, lowercases it, and compares it with values like empty text, `false`, `none`, `not set`, `missing`, `no`, and dash-like placeholders. It returns true when the value should be treated as absent or false.

**Call relations**: `list_items` uses it before splitting comma-separated lists, and other doctor output note code uses it when deciding whether bare tokens or update notes represent real values.

*Call graph*: called by 3 (list_items, style_detail_bare_token, update_note); 1 external calls (matches!).


### `exec/src/event_processor_with_jsonl_output.rs`

`io_transport` · `session event handling and shutdown`

When Codex runs in an execution mode, many things happen: a turn starts, the assistant thinks, commands run, files change, warnings appear, token usage changes, and the turn eventually succeeds or fails. This file translates those server notifications into a steady JSONL stream, meaning “JSON Lines”: each line is a complete JSON message. That makes the output easy for another program to watch, like reading ticker tape.

The main type, EventProcessorWithJsonOutput, keeps a little memory while the session runs. It assigns stable output item IDs, remembers which raw server items are still in progress, tracks the latest todo list, stores token usage, remembers the last serious error, and saves the final assistant message if one exists.

Most of the work is translation. A server-side command item becomes an exec command item. A file patch becomes a file-change item. Tool calls, web searches, reasoning summaries, warnings, and errors are converted into the output shapes used by exec_events. Some events are deliberately skipped, such as empty reasoning summaries or agent-message “started” events, because they would not be useful to downstream readers.

At the end of a successful turn, the processor emits a completed-turn event, marks the run ready to shut down, and can write the final message to a configured file. On failure or interruption, it avoids writing stale success output.

#### Function details

##### `EventProcessorWithJsonOutput::new`  (lines 82–93)

```
fn new(last_message_path: Option<PathBuf>) -> Self
```

**Purpose**: Creates a fresh JSONL event processor for a new run. It sets up empty tracking state and optionally remembers where the final assistant message should be written at the end.

**Data flow**: It receives an optional path for the last-message file. It builds a processor with item numbering starting at zero, no active todo list, no saved token usage or error, and no final message yet. The result is a ready-to-use processor.

**Call relations**: This is the starting point used by the exec session runner and by many tests. After construction, the rest of the file gradually fills in this stored state as server notifications arrive.

*Call graph*: called by 32 (failed_turn_does_not_overwrite_output_last_message_file, mcp_tool_call_result_preserves_meta_in_jsonl_event, runtime_warning_emits_a_non_fatal_error_item, run_exec_session, agent_message_item_started_is_ignored, agent_message_item_updates_final_message, collab_spawn_begin_and_end_emit_item_events, command_execution_started_and_completed_translate_to_thread_events, empty_reasoning_items_are_ignored, failed_turn_clears_stale_final_message (+15 more)); 2 external calls (new, new).


##### `EventProcessorWithJsonOutput::final_message`  (lines 95–97)

```
fn final_message(&self) -> Option<&str>
```

**Purpose**: Returns the final assistant message currently remembered by the processor, if there is one. This is useful for code or tests that need to inspect the message without printing or writing it.

**Data flow**: It reads the processor’s saved final_message field. If a message exists, it returns it as borrowed text; if not, it returns nothing. It does not change any state.

**Call relations**: This is a small access point into the state built by completed item and completed turn events. It does not call other project logic.


##### `EventProcessorWithJsonOutput::next_item_id`  (lines 99–101)

```
fn next_item_id(&self) -> String
```

**Purpose**: Creates the next simple output item ID, such as item_0 or item_1. These IDs let later JSON events refer to the same visible item in a stable way.

**Data flow**: It reads and increments an atomic counter, which is a number that can be safely updated even if shared across threads. It formats the old number into a string and returns that string.

**Call relations**: Many translation paths call this when they need a new public ID, including warning events, todo lists, and item tracking. started_item_id also uses it when a raw server item appears for the first time.

*Call graph*: called by 2 (collect_thread_events, started_item_id); 1 external calls (format!).


##### `EventProcessorWithJsonOutput::emit`  (lines 104–115)

```
fn emit(&self, event: ThreadEvent)
```

**Purpose**: Prints one translated thread event as a single JSON line. This is the final step that makes an internal event visible to outside tools.

**Data flow**: It receives a ThreadEvent, tries to turn it into JSON text, and prints that text to standard output. If JSON conversion fails, it prints a JSON-formatted error message instead of crashing.

**Call relations**: The EventProcessor trait methods call this after they collect translated events. It is the mouth of the pipeline: print_config_summary, process_server_notification, and process_warning all hand events to it.

*Call graph*: called by 3 (print_config_summary, process_server_notification, process_warning); 1 external calls (println!).


##### `EventProcessorWithJsonOutput::usage_from_last_total`  (lines 117–127)

```
fn usage_from_last_total(&self) -> Usage
```

**Purpose**: Builds the token-usage summary that is attached to a completed turn. Tokens are the chunks of text counted by the language model for input, output, and reasoning.

**Data flow**: It reads the latest total token usage remembered from earlier notifications. If usage has been seen, it copies the relevant counts into the exec output type; if not, it returns zero/default usage.

**Call relations**: collect_thread_events calls this when a turn completes successfully. It relies on earlier ThreadTokenUsageUpdated notifications having stored the latest totals.

*Call graph*: called by 1 (collect_thread_events); 1 external calls (default).


##### `EventProcessorWithJsonOutput::map_todo_items`  (lines 129–139)

```
fn map_todo_items(plan: &[codex_app_server_protocol::TurnPlanStep]) -> Vec<TodoItem>
```

**Purpose**: Converts a server turn plan into the simpler todo-list items shown in JSONL output. Each plan step becomes text plus a completed/not-completed flag.

**Data flow**: It receives a list of server plan steps. For each step, it copies the step text and checks whether the server marked it completed. It returns a new list of output todo items.

**Call relations**: collect_thread_events uses this when the server reports a plan update. Tests also call it directly to confirm that text and completion status are preserved.

*Call graph*: called by 1 (map_todo_items_preserves_text_and_completion_state); 1 external calls (iter).


##### `EventProcessorWithJsonOutput::map_item_with_id`  (lines 141–316)

```
fn map_item_with_id(
        item: ThreadItem,
        make_id: impl FnOnce() -> String,
    ) -> Option<ExecThreadItem>
```

**Purpose**: Converts one server thread item into the corresponding exec output item, using a supplied function to choose the output ID. It is the central translation table for item types.

**Data flow**: It receives a server ThreadItem and a way to make an ID. It matches the item’s kind, copies or reshapes the important fields, converts server status names into exec status names, and returns an output item. If the item is not useful for JSONL output, or if a reasoning item has no text, it returns nothing.

**Call relations**: The started-item and completed-item mapping functions delegate to this helper so the detailed conversion rules stay in one place. It hands back normalized items that can be wrapped as started, updated, or completed events.

*Call graph*: 9 external calls (AgentMessage, CollabToolCall, CommandExecution, FileChange, McpToolCall, Reasoning, WebSearch, from_value, to_value).


##### `EventProcessorWithJsonOutput::started_item_id`  (lines 318–326)

```
fn started_item_id(&mut self, raw_id: &str) -> String
```

**Purpose**: Finds or creates the public output ID for a raw server item that has started. This keeps the same visible item ID across later updates and completion.

**Data flow**: It receives the raw server item ID. If that raw ID is already known, it returns the existing output ID. Otherwise it creates a new item ID, stores the raw-to-output mapping, and returns the new ID.

**Call relations**: map_started_item uses this when translating an item-started notification. Later, completed_item_id uses the stored mapping to finish the same visible item instead of inventing a different one.

*Call graph*: calls 1 internal fn (next_item_id).


##### `EventProcessorWithJsonOutput::completed_item_id`  (lines 328–332)

```
fn completed_item_id(&mut self, raw_id: &str) -> String
```

**Purpose**: Gets the public output ID for an item that has completed and removes it from the in-progress map. This marks the item as no longer running.

**Data flow**: It receives the raw server item ID. If that ID was seen during start, it removes and returns the matching output ID. If no start was recorded, it creates a fresh ID so the completed item can still be emitted.

**Call relations**: map_completed_item_mut uses this for non-message items. It pairs with started_item_id to make started and completed events line up for the same command, file change, or tool call.


##### `EventProcessorWithJsonOutput::map_started_item`  (lines 334–342)

```
fn map_started_item(&mut self, item: ThreadItem) -> Option<ExecThreadItem>
```

**Purpose**: Translates a server “item started” notification into an exec item, when that kind of item should be shown as started. It intentionally ignores agent messages and reasoning at start time because those are only useful once completed.

**Data flow**: It receives a server item. If it is an agent message or reasoning item, it returns nothing. Otherwise it gets the item’s raw ID, assigns or reuses a public output ID, and returns the translated item.

**Call relations**: collect_thread_events calls this when a ServerNotification::ItemStarted arrives. It delegates the actual field-by-field conversion to map_item_with_id.

*Call graph*: called by 1 (collect_thread_events); 1 external calls (map_item_with_id).


##### `EventProcessorWithJsonOutput::map_completed_item_mut`  (lines 344–359)

```
fn map_completed_item_mut(&mut self, item: ThreadItem) -> Option<ExecThreadItem>
```

**Purpose**: Translates a server “item completed” notification into an exec item. It also filters out empty reasoning summaries so the output does not contain blank thinking entries.

**Data flow**: It receives a completed server item and may update the processor’s raw-ID tracking. Agent messages and reasoning items get fresh output IDs because they were not emitted at start time. Other items reuse and remove their earlier started ID if one exists. The result is either a completed output item or nothing.

**Call relations**: collect_thread_events calls this for normal item-completed notifications, and reconciliation uses it for items that were started but not explicitly completed. It relies on map_item_with_id for the detailed conversion.

*Call graph*: called by 1 (collect_thread_events); 1 external calls (map_item_with_id).


##### `EventProcessorWithJsonOutput::reconcile_unfinished_started_items`  (lines 361–376)

```
fn reconcile_unfinished_started_items(
        &mut self,
        turn_items: &[ThreadItem],
    ) -> Vec<ThreadEvent>
```

**Purpose**: Closes any items that were emitted as started but never received a matching completed event. This prevents downstream readers from seeing items left hanging forever.

**Data flow**: It receives the final list of turn items from the server. It looks for items whose raw IDs are still marked as in progress, converts each one into a completed output item, and returns completed events for them.

**Call relations**: collect_thread_events calls this when a turn finishes. It is a cleanup step before emitting the final turn status, like checking that every open tab has been closed before leaving.

*Call graph*: called by 1 (collect_thread_events); 1 external calls (iter).


##### `EventProcessorWithJsonOutput::final_message_from_turn_items`  (lines 378–392)

```
fn final_message_from_turn_items(items: &[ThreadItem]) -> Option<String>
```

**Purpose**: Finds the best final text to treat as the assistant’s answer for the turn. It prefers the last agent message, and falls back to the last plan text if there was no agent message.

**Data flow**: It receives the list of items from a completed turn and searches from the end backward. It first looks for an agent-message item and returns its text; if none exists, it searches for a plan item and returns that text. If neither exists, it returns nothing.

**Call relations**: collect_thread_events uses this during a successful turn completion to decide what final message should be saved for later output. It does not emit anything itself.

*Call graph*: 1 external calls (iter).


##### `EventProcessorWithJsonOutput::thread_started_event`  (lines 394–398)

```
fn thread_started_event(session_configured: &SessionConfiguredEvent) -> ThreadEvent
```

**Purpose**: Creates the JSONL event that announces a thread has started. This gives outside readers the session thread ID before other events arrive.

**Data flow**: It receives the session configuration event, copies out the thread ID, and wraps it in a ThreadStarted event. It returns that event without changing processor state.

**Call relations**: print_config_summary calls this at startup and then emits the result. It is the first visible event in the JSONL stream for a configured session.

*Call graph*: 1 external calls (ThreadStarted).


##### `EventProcessorWithJsonOutput::collect_warning`  (lines 400–410)

```
fn collect_warning(&mut self, message: String) -> CollectedThreadEvents
```

**Purpose**: Turns a warning message into a non-fatal error-style item in the output stream. The run keeps going, but the warning is still visible to readers.

**Data flow**: It receives warning text, creates a new output item ID, wraps the text in an ErrorItem, and returns it inside a CollectedThreadEvents value with status Running. It changes only the item counter.

**Call relations**: process_warning uses this for warnings that come directly through the EventProcessor interface. collect_thread_events also uses it for server warning notifications, so warning formatting stays consistent.

*Call graph*: called by 2 (collect_thread_events, process_warning); 1 external calls (vec!).


##### `EventProcessorWithJsonOutput::collect_thread_events`  (lines 412–593)

```
fn collect_thread_events(
        &mut self,
        notification: ServerNotification,
    ) -> CollectedThreadEvents
```

**Purpose**: Converts one server notification into zero or more JSONL thread events and decides whether the run should continue or begin shutting down. This is the main decision point in the file.

**Data flow**: It receives a ServerNotification. Depending on the notification kind, it may create warning or error items, translate started or completed items, update token usage, maintain the running todo list, store the final message, reconcile unfinished items, or emit turn success/failure events. It returns the translated events plus a CodexStatus saying Running or InitiateShutdown.

**Call relations**: process_server_notification calls this for every server update, then prints whatever events it returns. Internally it calls the small helpers for item conversion, warning collection, todo mapping, token usage, final-message selection, and unfinished-item cleanup.

*Call graph*: calls 6 internal fn (collect_warning, map_completed_item_mut, map_started_item, next_item_id, reconcile_unfinished_started_items, usage_from_last_total); called by 1 (process_server_notification); 13 external calls (final_message_from_turn_items, map_todo_items, new, Error, ItemCompleted, ItemStarted, ItemUpdated, TurnCompleted, TurnFailed, TurnStarted (+3 more)).


##### `EventProcessorWithJsonOutput::print_config_summary`  (lines 597–604)

```
fn print_config_summary(
        &mut self,
        _: &Config,
        _: &str,
        session_configured: &SessionConfiguredEvent,
    )
```

**Purpose**: Starts the JSONL stream by printing a thread-started event. In this output mode it does not print a human-readable configuration summary.

**Data flow**: It receives the app config, a string label, and the session configuration, but only uses the session configuration. It creates a thread-started event from the thread ID and emits it to standard output.

**Call relations**: This is part of the EventProcessor interface and is called during session setup. It hands off to thread_started_event for construction and emit for printing.

*Call graph*: calls 1 internal fn (emit); 1 external calls (thread_started_event).


##### `EventProcessorWithJsonOutput::process_server_notification`  (lines 606–612)

```
fn process_server_notification(&mut self, notification: ServerNotification) -> CodexStatus
```

**Purpose**: Processes one live server notification and prints the resulting JSONL events. It returns the status that tells the caller whether to keep running or shut down.

**Data flow**: It receives a server notification, passes it to collect_thread_events, then emits each returned event in order. It returns the collected CodexStatus to the caller.

**Call relations**: This is the main runtime entry through the EventProcessor trait. It connects the server event stream to the JSONL output stream by using collect_thread_events and emit.

*Call graph*: calls 2 internal fn (collect_thread_events, emit).


##### `EventProcessorWithJsonOutput::process_warning`  (lines 614–620)

```
fn process_warning(&mut self, message: String) -> CodexStatus
```

**Purpose**: Processes a standalone warning and prints it as a JSONL event without stopping the run. This covers warnings that are not packaged as normal server notifications.

**Data flow**: It receives warning text, turns it into collected warning events, prints each event, and returns Running status. It may advance the item ID counter.

**Call relations**: This EventProcessor method is a thin wrapper around collect_warning and emit. It keeps warning behavior the same whether the warning comes from the server notification path or a direct processor call.

*Call graph*: calls 2 internal fn (collect_warning, emit).


##### `EventProcessorWithJsonOutput::print_final_output`  (lines 622–628)

```
fn print_final_output(&mut self)
```

**Purpose**: Writes the final assistant message to the configured last-message file, but only after a successful completed turn. This gives scripts a simple place to read the final answer.

**Data flow**: It checks whether final-message writing was enabled by a successful turn and whether a file path was configured. If both are true, it passes the saved final message and path to handle_last_message. On failed or interrupted turns, it does nothing.

**Call relations**: This EventProcessor method runs during shutdown. collect_thread_events decides earlier whether final output should be allowed, and this function performs the final file-writing handoff.

*Call graph*: calls 1 internal fn (handle_last_message).


### `exec/src/event_processor.rs`

`orchestration` · `main loop and teardown`

This file is a shared contract for the part of the exec command that listens to what the agent reports and decides what to do next. The agent sends typed notifications, such as progress updates or final results. Code that implements the EventProcessor trait promises it can print the starting configuration, process those notifications, show warnings, and optionally print final output. The return value CodexStatus is a simple signal: either keep running or begin shutting down.

The file also covers one practical end-of-run need: writing the last agent message to disk. That is useful for scripts or tools that want to read the final answer from a file instead of scraping the terminal. The helper is careful about missing data. If there is no last message, it writes an empty file and prints a warning, rather than silently leaving stale old content behind. This is like clearing a mailbox before saying there was no mail: downstream readers do not accidentally see yesterday’s message.

If the write itself fails, the code reports the problem to standard error, but it does not crash the whole process from here. That makes this file a small but important bridge between the event-processing flow and the final user-visible output.

#### Function details

##### `EventProcessor::print_final_output`  (lines 28–28)

```
fn print_final_output(&mut self)
```

**Purpose**: This is the optional final-output hook for anything that implements EventProcessor. The default version does nothing, so processors only need to override it when they have something meaningful to print or save at the end.

**Data flow**: It receives the processor object itself and no extra data. In the default implementation, it reads nothing, changes nothing, and returns nothing. The before and after state are the same unless a specific processor provides its own version elsewhere.

**Call relations**: This hook is used at the end of a run when final output may need to be produced. The recorded call facts show it being exercised by a test named failed_turn_does_not_overwrite_output_last_message_file, which checks end-of-run output behavior. Other concrete print_final_output implementations are where final-message saving can lead into handle_last_message.

*Call graph*: called by 1 (failed_turn_does_not_overwrite_output_last_message_file).


##### `handle_last_message`  (lines 31–40)

```
fn handle_last_message(last_agent_message: Option<&str>, output_file: &Path)
```

**Purpose**: This function writes the agent’s last message into a chosen output file. If there was no last message, it deliberately writes an empty file and warns the user, so old output is not mistaken for a fresh result.

**Data flow**: It takes an optional text message and a file path. If the message exists, it uses that text; if it is missing, it uses an empty string. It then asks write_last_message_file to put that text on disk. When the message was missing, it also prints a warning to standard error that names the file that received empty content.

**Call relations**: This function is called by final-output code when a run is wrapping up and the last agent response needs to be saved. It delegates the actual disk write to write_last_message_file, keeping this function focused on the policy decision: use the real message when available, otherwise write empty content and warn.

*Call graph*: calls 1 internal fn (write_last_message_file); called by 2 (print_final_output, print_final_output); 1 external calls (eprintln!).


##### `write_last_message_file`  (lines 42–48)

```
fn write_last_message_file(contents: &str, last_message_path: Option<&Path>)
```

**Purpose**: This helper performs the actual file write for the last agent message. It keeps file-writing errors contained by reporting them to standard error instead of panicking.

**Data flow**: It receives the text to write and an optional file path. If no path is provided, it does nothing. If a path is provided, it tries to write the text to that file. On success, the file now contains the supplied text; on failure, no useful output file is guaranteed, and an error message is printed.

**Call relations**: handle_last_message calls this helper after deciding what text should be saved. This function then hands the text to the standard library’s file-writing operation and reports any failure with eprintln!, which writes a message to the error stream for the user or calling tool to see.

*Call graph*: called by 1 (handle_last_message); 2 external calls (eprintln!, write).


### `ext/goal/src/accounting.rs`

`domain_logic` · `during conversation turns and goal progress accounting`

This file is the bookkeeping desk for goals. A goal can be active during a conversation turn, or it can be active while the system is idle. While that goal is active, the system needs to count two things: tokens, meaning pieces of text processed or produced by the model, and wall-clock time, meaning real elapsed seconds. Without this file, the project could overcharge, undercharge, or double-charge goal progress.

The central type is `GoalAccountingState`. It stores shared state behind a mutex, which is a lock that stops two tasks from changing the same data at once. It also has a one-at-a-time semaphore for progress accounting, like a single checkout lane: only one caller may take a snapshot, write it to storage, and mark it counted before the next caller starts.

Each turn has `GoalTurnAccounting`, which remembers current token totals, the last token totals already counted, whether this turn should count tokens, and which goal is active. Plan-mode turns are deliberately excluded from token charging. Separately, `GoalWallClockAccounting` tracks when time was last counted and which goal, if any, is currently accumulating time.

The main pattern is: start a turn, mark a goal active, update token totals, take a snapshot of new progress, persist that progress elsewhere, then mark the snapshot as accounted. Status changes decide whether the active goal stays active or is cleared.

#### Function details

##### `GoalAccountingState::start_turn`  (lines 67–83)

```
fn start_turn(
        &self,
        turn_id: impl Into<String>,
        collaboration_mode: ModeKind,
        token_usage_at_turn_start: &TokenUsage,
    )
```

**Purpose**: Starts accounting for a new conversation turn. It records the turn id, the token totals at the beginning of the turn, and whether this turn should count tokens toward a goal.

**Data flow**: A turn id, collaboration mode, and starting token totals go in. The shared accounting state is locked, the current turn id is set, and a new per-turn record is stored. The result is updated internal state; nothing is returned.

**Call relations**: This is called when a new turn begins. It creates the `GoalTurnAccounting` record that later calls such as `record_token_usage`, `progress_snapshot`, and `finish_turn` rely on.

*Call graph*: calls 2 internal fn (inner, new); 4 external calls (clone, into, matches!, clone).


##### `GoalAccountingState::current_turn_id`  (lines 85–87)

```
fn current_turn_id(&self) -> Option<String>
```

**Purpose**: Returns the id of the turn currently being tracked, if there is one. Callers use this when they need to connect later progress or cleanup work to the active turn.

**Data flow**: No outside data goes in. The function locks the shared state, copies the current turn id if present, and returns it as an optional string.

**Call relations**: This is a small read-only doorway into the accounting state. Other higher-level code can use it before deciding whether to mark a goal active, record progress, or finish a turn.

*Call graph*: calls 1 internal fn (inner).


##### `GoalAccountingState::progress_accounting_permit`  (lines 94–98)

```
async fn progress_accounting_permit(
        &self,
    ) -> Result<SemaphorePermit<'_>, tokio::sync::AcquireError>
```

**Purpose**: Gives a caller exclusive permission to perform progress accounting. This avoids two concurrent tasks charging the same tokens or seconds twice.

**Data flow**: No accounting data goes in. The function waits for the single semaphore permit and returns it, or returns an acquire error if the semaphore is closed. Holding the permit changes who else may enter this accounting section until it is dropped.

**Call relations**: Higher-level progress-writing code should call this before taking a snapshot and keep the permit until after the durable write and mark-accounted step. It coordinates calls to snapshot and mark-accounted methods.

*Call graph*: 1 external calls (acquire).


##### `GoalAccountingState::turn_is_current_active_goal`  (lines 100–109)

```
fn turn_is_current_active_goal(&self, turn_id: &str) -> bool
```

**Purpose**: Checks whether a given turn is both the current turn and has a token-counting active goal. This is useful before doing work that only makes sense for the active charged turn.

**Data flow**: A turn id goes in. The function locks the state, compares it with the current turn id, looks up that turn, and checks that token accounting is enabled and a goal id is present. It returns true or false.

**Call relations**: This is a guard used by surrounding flow to decide whether the current turn should be treated as actively contributing to a goal.

*Call graph*: calls 1 internal fn (inner).


##### `GoalAccountingState::record_token_usage`  (lines 111–132)

```
fn record_token_usage(
        &self,
        turn_id: impl Into<String>,
        total_usage: &TokenUsage,
    ) -> Option<RecordedTokenDelta>
```

**Purpose**: Updates the stored token totals for a turn and reports how many new goal-chargeable tokens appeared since the last accounting point. It skips turns that are not supposed to count tokens, such as plan-mode turns.

**Data flow**: A turn id and total token usage go in. The function locks state, finds that turn, stores the new totals, computes the positive difference from the last counted totals, and returns that delta plus the unflushed total across the thread. If there is no turn or no positive countable change, it returns nothing.

**Call relations**: This is called as token totals change during or after a turn. Its per-turn record was created by `start_turn`, and its delta calculation depends on `GoalTurnAccounting::token_delta_since_last_accounting` and the inner thread-wide unflushed total.

*Call graph*: calls 1 internal fn (inner); 2 external calls (into, clone).


##### `GoalAccountingState::mark_turn_goal_active`  (lines 134–146)

```
fn mark_turn_goal_active(&self, turn_id: &str, goal_id: impl Into<String>)
```

**Purpose**: Marks a specific turn as working on a specific goal. If that turn is also the current turn, wall-clock time starts being counted for the same goal.

**Data flow**: A turn id and goal id go in. The function locks state, clears any stale budget-limit report marker for a different goal, stores the goal id on the turn if it exists, and possibly updates wall-clock accounting. It returns nothing.

**Call relations**: This is used when code knows exactly which turn should receive the goal. It connects later token snapshots from that turn with wall-clock tracking in `GoalWallClockAccounting`.

*Call graph*: calls 1 internal fn (inner); 3 external calls (as_str, clone, into).


##### `GoalAccountingState::mark_current_turn_goal_active`  (lines 148–163)

```
fn mark_current_turn_goal_active(
        &self,
        goal_id: impl Into<String>,
    ) -> Option<String>
```

**Purpose**: Marks the current turn as working on a goal and resets the token baseline to the turn's current usage. This means only future token growth is charged to the newly active goal.

**Data flow**: A goal id goes in. The function locks state, finds the current turn, clears stale budget-limit reporting if needed, stores the goal id, resets that turn's last-counted tokens to its current tokens, starts wall-clock timing for the goal, and returns the current turn id. If there is no current turn or matching record, it returns nothing.

**Call relations**: This is the common path when a goal becomes active during the current turn. Later `progress_snapshot` calls use the active goal and the reset baseline to report only new progress.

*Call graph*: calls 1 internal fn (inner); 3 external calls (as_str, clone, into).


##### `GoalAccountingState::mark_idle_goal_active`  (lines 165–172)

```
fn mark_idle_goal_active(&self, goal_id: impl Into<String>)
```

**Purpose**: Marks a goal as active while no turn-specific token accounting is needed. This lets elapsed time be charged to a goal during idle periods.

**Data flow**: A goal id goes in. The function locks state, clears stale budget-limit reporting if it refers to another goal, and tells wall-clock accounting that this goal is active. It returns nothing.

**Call relations**: This supports idle progress accounting. After this is called, `idle_progress_snapshot` can later report elapsed seconds for the active goal.

*Call graph*: calls 1 internal fn (inner); 2 external calls (as_str, into).


##### `GoalAccountingState::clear_current_turn_goal`  (lines 174–183)

```
fn clear_current_turn_goal(&self) -> Option<String>
```

**Purpose**: Removes the active goal from the current turn and stops wall-clock time from accumulating. It reports which turn was cleared.

**Data flow**: No outside data goes in. The function locks state, finds the current turn id, clears that turn's active goal if present, clears wall-clock active-goal tracking, resets the budget-limit report marker, and returns the turn id. If there is no current turn, it returns nothing.

**Call relations**: This is used when the current turn should no longer be associated with a goal. It prepares the state so later snapshots do not keep charging that goal.

*Call graph*: calls 1 internal fn (inner).


##### `GoalAccountingState::clear_active_goal`  (lines 185–194)

```
fn clear_active_goal(&self)
```

**Purpose**: Clears any active goal from the current turn and from wall-clock tracking. It is a broad stop button for goal accounting.

**Data flow**: No outside data goes in. The function locks state, clears the active goal on the current turn if one exists, clears the wall-clock active goal, resets budget-limit reporting, and returns nothing.

**Call relations**: This is used when the system needs to stop goal charging regardless of the specific turn. Later token and idle snapshots will not report progress until a goal is marked active again.

*Call graph*: calls 1 internal fn (inner).


##### `GoalAccountingState::progress_snapshot`  (lines 196–219)

```
fn progress_snapshot(&self, turn_id: &str) -> Option<GoalProgressSnapshot>
```

**Purpose**: Builds a snapshot of uncounted progress for a turn: new chargeable tokens, elapsed seconds, and the goal expected to receive them. The snapshot is meant to be written to persistent storage before being marked as accounted.

**Data flow**: A turn id goes in. The function locks state, finds the turn, confirms token accounting is enabled and a goal is active, computes token growth since the last counted baseline, and computes elapsed time only if the wall-clock goal matches. It returns a snapshot if there is any new token or time progress; otherwise it returns nothing.

**Call relations**: This is part of the accounting transaction guarded by `progress_accounting_permit`. After outside code successfully records the snapshot, it should call `mark_progress_accounted_for_status`.

*Call graph*: calls 1 internal fn (inner).


##### `GoalAccountingState::idle_progress_snapshot`  (lines 221–232)

```
fn idle_progress_snapshot(&self) -> Option<IdleGoalProgressSnapshot>
```

**Purpose**: Builds a snapshot of uncounted elapsed time for a goal that is active outside a token-counting turn. It is for charging time when the system is idle or not tied to a turn.

**Data flow**: No outside data goes in. The function locks state, reads the wall-clock active goal, calculates seconds since time was last counted, and returns an idle snapshot if at least one second has elapsed. If there is no active goal or no time to count, it returns nothing.

**Call relations**: This pairs with `mark_idle_goal_active` and is followed by `mark_idle_progress_accounted_for_status` after the progress has been written elsewhere.

*Call graph*: calls 1 internal fn (inner).


##### `GoalAccountingState::mark_progress_accounted_for_status`  (lines 234–256)

```
fn mark_progress_accounted_for_status(
        &self,
        turn_id: &str,
        snapshot: &GoalProgressSnapshot,
        status: ThreadGoalStatus,
        budget_limited_goal_disposition: BudgetL
```

**Purpose**: Marks a previously taken turn progress snapshot as successfully counted. It also decides, from the goal's status, whether the active goal should remain active or be cleared.

**Data flow**: A turn id, progress snapshot, current goal status, and budget-limit clearing policy go in. The function decides whether to clear the active goal, locks state, moves the turn's last-counted token baseline up to the snapshot's token totals, advances the wall-clock baseline by the counted seconds, maybe clears active-goal tracking, and maybe resets budget-limit reporting. It returns nothing.

**Call relations**: This should be called only after the snapshot from `progress_snapshot` has been persisted successfully. It uses `should_clear_active_goal` to apply consistent status rules.

*Call graph*: calls 2 internal fn (inner, should_clear_active_goal).


##### `GoalAccountingState::finish_turn`  (lines 258–264)

```
fn finish_turn(&self, turn_id: &str)
```

**Purpose**: Removes a turn from the accounting table when that turn is over. If it was the current turn, there is no longer a current turn.

**Data flow**: A turn id goes in. The function locks state, deletes that turn's accounting record, and clears `current_turn_id` if it pointed to the same turn. It returns nothing.

**Call relations**: This is the cleanup counterpart to `start_turn`. After it runs, later calls for that turn will not find accounting data.

*Call graph*: calls 1 internal fn (inner).


##### `GoalAccountingState::mark_idle_progress_accounted_for_status`  (lines 266–281)

```
fn mark_idle_progress_accounted_for_status(
        &self,
        snapshot: &IdleGoalProgressSnapshot,
        status: ThreadGoalStatus,
        budget_limited_goal_disposition: BudgetLimitedGoalDisp
```

**Purpose**: Marks an idle time snapshot as successfully counted. It advances the time baseline and may stop the goal from remaining active based on its status.

**Data flow**: An idle snapshot, goal status, and budget-limit clearing policy go in. The function decides whether the active goal should be cleared, locks state, advances the wall-clock baseline by the counted seconds, maybe clears the active goal, and maybe resets budget-limit reporting. It returns nothing.

**Call relations**: This follows `idle_progress_snapshot` after outside code has written the time progress. It uses the same `should_clear_active_goal` rule as turn-based accounting.

*Call graph*: calls 2 internal fn (inner, should_clear_active_goal).


##### `GoalAccountingState::reset_idle_progress_baseline_and_clear_active_goal`  (lines 283–288)

```
fn reset_idle_progress_baseline_and_clear_active_goal(&self)
```

**Purpose**: Resets idle time accounting to now and clears the idle active goal. This prevents old elapsed time from being charged after the goal is no longer active.

**Data flow**: No outside data goes in. The function locks state, resets the wall-clock baseline, clears the active wall-clock goal, clears budget-limit reporting, and returns nothing.

**Call relations**: This is a cleanup helper for idle accounting. It makes later `idle_progress_snapshot` calls return nothing until another idle goal is marked active.

*Call graph*: calls 1 internal fn (inner).


##### `GoalAccountingState::mark_budget_limit_reported_if_new`  (lines 290–297)

```
fn mark_budget_limit_reported_if_new(&self, goal_id: &str) -> bool
```

**Purpose**: Records that a budget-limit notice has already been reported for a goal. It tells the caller whether this is the first report for that goal, so duplicate notices can be avoided.

**Data flow**: A goal id goes in. The function locks state, compares it with the stored reported goal id, and returns false if it was already recorded. Otherwise it stores the new goal id and returns true.

**Call relations**: This is used around budget-limit handling. Other methods clear this marker when the active goal changes or when the status is no longer budget-limited.

*Call graph*: calls 1 internal fn (inner).


##### `GoalAccountingState::inner`  (lines 299–301)

```
fn inner(&self) -> std::sync::MutexGuard<'_, GoalAccountingInner>
```

**Purpose**: Locks and returns access to the shared accounting state. It also recovers the state if a previous holder of the lock panicked while holding it.

**Data flow**: No domain data goes in. The function tries to lock the mutex and returns a guard that allows reading and changing the inner state. If the lock is poisoned, it still returns the stored state rather than crashing.

**Call relations**: Almost every method on `GoalAccountingState` uses this before reading or changing accounting data. It is the single doorway through the mutex.

*Call graph*: called by 16 (clear_active_goal, clear_current_turn_goal, current_turn_id, finish_turn, idle_progress_snapshot, mark_budget_limit_reported_if_new, mark_current_turn_goal_active, mark_idle_goal_active, mark_idle_progress_accounted_for_status, mark_progress_accounted_for_status (+6 more)).


##### `GoalAccountingState::default`  (lines 305–310)

```
fn default() -> Self
```

**Purpose**: Creates a fresh accounting state with no current turn, no active goal, and a one-at-a-time progress accounting permit. This is the normal starting state for a thread's goal accounting.

**Data flow**: No input goes in. The function builds a default inner state inside a mutex and creates a semaphore with one permit. It returns a ready-to-use `GoalAccountingState`.

**Call relations**: Tests and production setup can use this to initialize accounting. It relies on `GoalAccountingInner::default` and starts the concurrency gate used by `progress_accounting_permit`.

*Call graph*: calls 1 internal fn (default); called by 2 (goal_accounting_ignores_plan_mode_turns, goal_accounting_uses_turn_start_baseline_for_exact_deltas); 2 external calls (new, new).


##### `token_delta_since_last_accounting`  (lines 313–326)

```
fn token_delta_since_last_accounting(last: &TokenUsage, current: &TokenUsage) -> i64
```

**Purpose**: Computes how many chargeable tokens were added between two token-usage totals. It treats the inputs as cumulative counters and compares the older count with the newer count.

**Data flow**: Previous token totals and current token totals go in. The function subtracts each token field safely so the result never underflows, then passes the difference to `goal_token_delta_for_usage`. It returns one signed integer delta.

**Call relations**: Per-turn accounting calls this through `GoalTurnAccounting::token_delta_since_last_accounting`. It supplies the basic token difference used by snapshots and unflushed-total reporting.

*Call graph*: calls 1 internal fn (goal_token_delta_for_usage); called by 1 (token_delta_since_last_accounting).


##### `goal_token_delta_for_usage`  (lines 328–333)

```
fn goal_token_delta_for_usage(usage: &TokenUsage) -> i64
```

**Purpose**: Converts a token-usage record into the number of tokens that should count toward a goal. Cached input tokens are excluded, and output tokens are included only when positive.

**Data flow**: A token-usage record goes in. The function subtracts cached input from input and adds non-negative output tokens. It returns the resulting chargeable token count.

**Call relations**: This is the final formula used by `token_delta_since_last_accounting`. Keeping it separate makes the goal-token rule clear and reusable.

*Call graph*: called by 1 (token_delta_since_last_accounting).


##### `GoalAccountingInner::default`  (lines 336–343)

```
fn default() -> Self
```

**Purpose**: Creates the empty inner bookkeeping record. It starts with no turns, no current turn, a fresh wall-clock tracker, and no remembered budget-limit report.

**Data flow**: No input goes in. The function constructs the internal fields and returns a `GoalAccountingInner` value.

**Call relations**: This is used by `GoalAccountingState::default` when the outer shared accounting state is first created.

*Call graph*: calls 1 internal fn (new); called by 1 (default); 1 external calls (new).


##### `GoalAccountingInner::thread_unflushed_token_delta`  (lines 347–354)

```
fn thread_unflushed_token_delta(&self) -> i64
```

**Purpose**: Adds up all positive, not-yet-accounted token deltas across token-counting turns. This gives a thread-wide view of progress waiting to be flushed.

**Data flow**: It reads the turns stored inside the inner state. For each turn that counts tokens, it computes the positive token delta since that turn's last accounting point and adds it safely to a total. It returns that total number.

**Call relations**: This is used by `record_token_usage` to report not only the current turn's new delta, but also the total pending token progress for the thread.


##### `GoalTurnAccounting::new`  (lines 358–365)

```
fn new(current_token_usage: TokenUsage, account_tokens: bool) -> Self
```

**Purpose**: Creates the accounting record for one turn. It sets both the current token totals and the already-accounted baseline to the same starting value.

**Data flow**: Starting token usage and a yes/no flag for whether tokens should count go in. The function stores the starting usage twice, leaves the active goal empty, stores the flag, and returns the new turn record.

**Call relations**: This is called by `GoalAccountingState::start_turn`. The record it creates is later updated by token recording and goal activation methods.

*Call graph*: called by 1 (start_turn); 1 external calls (clone).


##### `GoalTurnAccounting::active_goal_id`  (lines 367–369)

```
fn active_goal_id(&self) -> Option<String>
```

**Purpose**: Returns the goal id currently attached to this turn, if there is one. It gives callers their own copy so the stored value remains protected.

**Data flow**: No input goes in. The function reads the turn's optional active goal id and returns a cloned optional string.

**Call relations**: This is used when building a progress snapshot, where the snapshot needs to name the goal that should receive the progress.


##### `GoalTurnAccounting::reset_baseline_to_current`  (lines 371–373)

```
fn reset_baseline_to_current(&mut self)
```

**Purpose**: Moves the token accounting baseline up to the turn's current token totals. After this, earlier tokens will not be charged to a newly active goal.

**Data flow**: No input goes in. The function copies `current_token_usage` into `last_accounted_token_usage`. It changes the turn record and returns nothing.

**Call relations**: This is called when the current turn gets a newly active goal. It ensures later snapshots count only progress made after the goal became active.

*Call graph*: 1 external calls (clone).


##### `GoalTurnAccounting::token_delta_since_last_accounting`  (lines 375–380)

```
fn token_delta_since_last_accounting(&self) -> i64
```

**Purpose**: Calculates how many chargeable tokens this turn has accumulated since it was last marked accounted. This is the per-turn token progress number.

**Data flow**: No input goes in beyond the turn record itself. The function compares the stored last-counted token totals with the current token totals and returns the chargeable difference.

**Call relations**: This is used by `record_token_usage`, `progress_snapshot`, and the inner thread-wide unflushed-token calculation. It delegates the actual token formula to `token_delta_since_last_accounting`.

*Call graph*: calls 1 internal fn (token_delta_since_last_accounting).


##### `GoalWallClockAccounting::new`  (lines 384–389)

```
fn new() -> Self
```

**Purpose**: Creates a wall-clock tracker starting from the current moment with no active goal. This means no elapsed time is charged until a goal is marked active.

**Data flow**: No input goes in. The function records `Instant::now()` as the baseline, sets the active goal to none, and returns the tracker.

**Call relations**: This is used by `GoalAccountingInner::default` when fresh accounting state is created.

*Call graph*: called by 1 (default); 1 external calls (now).


##### `GoalWallClockAccounting::time_delta_since_last_accounting`  (lines 391–393)

```
fn time_delta_since_last_accounting(&self) -> i64
```

**Purpose**: Reports how many whole seconds have passed since wall-clock time was last counted or reset. It caps extremely large values at the largest signed integer.

**Data flow**: No input goes in. The function measures elapsed time from the stored baseline, converts it to seconds, and returns that number as an integer.

**Call relations**: Turn and idle snapshot methods use this to decide whether there is elapsed time to charge to the active goal.

*Call graph*: 2 external calls (elapsed, try_from).


##### `GoalWallClockAccounting::mark_accounted`  (lines 395–404)

```
fn mark_accounted(&mut self, accounted_seconds: i64)
```

**Purpose**: Moves the wall-clock baseline forward by the number of seconds that were successfully counted. This keeps uncounted leftover time, if any, from being lost.

**Data flow**: A number of accounted seconds goes in. If it is zero or negative, nothing changes. Otherwise the function advances `last_accounted_at` by that many seconds, falling back to the current time if the arithmetic cannot be represented.

**Call relations**: This is called after a progress snapshot has been persisted, from both turn-based and idle mark-accounted methods. It is what prevents the same seconds from being counted again.

*Call graph*: 3 external calls (from_secs, checked_add, try_from).


##### `GoalWallClockAccounting::reset_baseline`  (lines 406–408)

```
fn reset_baseline(&mut self)
```

**Purpose**: Resets the wall-clock baseline to the current moment. It starts a fresh timing window.

**Data flow**: No input goes in. The function replaces `last_accounted_at` with the current time and returns nothing.

**Call relations**: This is used when an active goal changes or is cleared, so time from the old period is not accidentally charged to a new goal.

*Call graph*: called by 2 (clear_active_goal, mark_active_goal); 1 external calls (now).


##### `GoalWallClockAccounting::mark_active_goal`  (lines 410–416)

```
fn mark_active_goal(&mut self, goal_id: impl Into<String>)
```

**Purpose**: Sets which goal should receive elapsed time. If the goal changes, it resets the timer so the new goal starts from now.

**Data flow**: A goal id goes in. The function compares it with the current active goal; if it is different, it resets the wall-clock baseline and stores the new goal id. It returns nothing.

**Call relations**: Goal activation methods call this when a turn or idle period begins contributing time to a goal. Snapshot methods later read this active goal and elapsed time.

*Call graph*: calls 1 internal fn (reset_baseline); 2 external calls (as_str, into).


##### `GoalWallClockAccounting::clear_active_goal`  (lines 418–421)

```
fn clear_active_goal(&mut self)
```

**Purpose**: Stops wall-clock time from being charged to any goal and resets the timer. This avoids carrying old elapsed time into a future goal.

**Data flow**: No input goes in. The function sets the active goal to none, resets the baseline to now, and returns nothing.

**Call relations**: Clear and status-update methods call this when a goal ends, pauses, blocks, completes, or should otherwise stop accumulating time.

*Call graph*: calls 1 internal fn (reset_baseline).


##### `should_clear_active_goal`  (lines 424–439)

```
fn should_clear_active_goal(
    status: ThreadGoalStatus,
    budget_limited_goal_disposition: BudgetLimitedGoalDisposition,
) -> bool
```

**Purpose**: Applies the rule for whether a goal status means the active goal should be cleared. Active goals stay active; completed, paused, blocked, and usage-limited goals are cleared; budget-limited goals depend on a caller-supplied policy.

**Data flow**: A thread goal status and a budget-limit disposition go in. The function matches the status against the rule table and returns true if accounting should clear the active goal, false otherwise.

**Call relations**: Both turn-based and idle mark-accounted methods call this after progress has been written. It keeps the status-to-clearing decision consistent in both paths.

*Call graph*: called by 2 (mark_idle_progress_accounted_for_status, mark_progress_accounted_for_status); 1 external calls (matches!).


### `git-utils/src/baseline.rs`

`domain_logic` · `baseline setup and diff generation`

This file solves a practical problem: the system needs to know how a working directory changed since a known starting point, without treating that directory as a user’s real Git project. It creates or repairs a hidden `.git` folder, makes one baseline commit, and later compares the current files against that commit. Think of it like taking a photo of a room, then later walking around with the photo to spot what moved, appeared, or disappeared.

The code is careful because Git operations and filesystem scans can be slow. The public async functions move the blocking work onto a background thread so they do not stall the async runtime. Resetting is intentionally destructive: it removes any existing `.git` metadata in the target directory and replaces it with a fresh one-commit history. Ensuring is gentler: it keeps an existing usable baseline and only resets if the metadata is missing or broken.

For comparison, the file reads the baseline tree from Git and scans the current directory, ignoring `.git`. It records each file’s content hash and mode, such as normal file, executable file, or symbolic link. It then produces both a structured list of changed paths and a human-readable unified diff, the familiar patch-style text with `+` and `-` lines. The tests verify important edge cases, including deleted files, executable-bit changes, symlinks-style content handling, and avoiding Git hooks during index setup.

#### Function details

##### `GitBaselineChangeStatus::label`  (lines 30–36)

```
fn label(self) -> &'static str
```

**Purpose**: Returns the short one-letter label used by Git-like status output. It turns added, modified, and deleted into `A`, `M`, and `D`.

**Data flow**: It receives a change status value → matches it to the right Git-style letter → returns that static text label without changing anything else.

**Call relations**: This is a small formatting helper for code that wants to show file changes compactly. It does not call other project functions and can be used wherever a change status needs to be displayed.


##### `GitBaselineDiff::has_changes`  (lines 54–56)

```
fn has_changes(&self) -> bool
```

**Purpose**: Answers the simple question: did anything change since the baseline? It is useful for callers that only need a yes-or-no answer before deciding whether to show or save a diff.

**Data flow**: It reads the diff object’s list of file changes → checks whether that list is empty → returns `true` if at least one change exists, otherwise `false`.

**Call relations**: Higher-level diff rendering code, such as `render_workspace_diff_file`, calls this when it needs to decide whether the baseline diff contains anything worth reporting.

*Call graph*: called by 1 (render_workspace_diff_file).


##### `reset_git_repository`  (lines 69–72)

```
async fn reset_git_repository(root: &Path) -> anyhow::Result<()>
```

**Purpose**: Replaces the target directory’s Git metadata with a fresh private baseline repository. Someone uses this when they want to declare, “the files look like this now; treat this as the new starting point.”

**Data flow**: It receives a directory path → copies that path so it can be moved safely into background work → runs the synchronous reset logic on a blocking worker thread → returns success or an error from that reset.

**Call relations**: Tests call this before modifying files so they can check later diffs. Internally it hands the real work to `reset_git_repository_sync`, keeping blocking filesystem and Git work out of the async task.

*Call graph*: called by 6 (diff_reports_added_modified_and_deleted_files, reports_executable_bit_changes_as_modified, reset_creates_fresh_baseline, reset_drops_previous_history, status_scan_does_not_write_added_file_blobs, write_index_ignores_configured_hooks_path); 2 external calls (to_path_buf, spawn_blocking).


##### `ensure_git_baseline_repository`  (lines 78–92)

```
async fn ensure_git_baseline_repository(root: &Path) -> anyhow::Result<()>
```

**Purpose**: Makes sure a directory has a usable private Git baseline without resetting it unnecessarily. It preserves a valid baseline, but repairs missing or unusable Git metadata.

**Data flow**: It receives a directory path → creates the directory if needed → checks whether `.git` exists, the repository opens, and the baseline commit can be read → either returns unchanged or rebuilds the baseline repository.

**Call relations**: The recovery test calls this for an empty, not-yet-committed Git repository. It uses the same reset path as a full reset when the existing metadata cannot provide a usable baseline.

*Call graph*: called by 1 (ensure_recovers_from_unborn_repository); 2 external calls (to_path_buf, spawn_blocking).


##### `reset_git_repository_sync`  (lines 94–102)

```
fn reset_git_repository_sync(root: &Path) -> anyhow::Result<()>
```

**Purpose**: Does the actual reset work for the private baseline repository. It creates the directory, removes old Git metadata, initializes Git, commits the current files, and prepares the index.

**Data flow**: It receives a root directory → ensures it exists → deletes any old `.git` entry → initializes a new Git repository → commits the current tree as the baseline → writes the Git index from `HEAD` → returns success or the first error encountered.

**Call relations**: `reset_git_repository` and `ensure_git_baseline_repository` rely on this when they need a fresh baseline. It coordinates `remove_git_metadata`, `commit_current_tree`, and `write_index_from_head` in that order.

*Call graph*: calls 3 internal fn (commit_current_tree, remove_git_metadata, write_index_from_head); 2 external calls (create_dir_all, init).


##### `diff_since_latest_init`  (lines 105–120)

```
async fn diff_since_latest_init(root: &Path) -> anyhow::Result<GitBaselineDiff>
```

**Purpose**: Computes what changed between the last baseline reset and the files currently on disk. It returns both machine-friendly change records and a patch-style text diff.

**Data flow**: It receives a root path → opens the private Git repository in the background → reads file entries from the baseline commit → scans current files → compares the two maps → renders detailed diff text → returns a `GitBaselineDiff`.

**Call relations**: The tests call this after setup and file edits to verify the reported changes. It ties together `head_file_entries`, `current_file_entries`, `diff_entries`, and `render_unified_diff`.

*Call graph*: called by 6 (diff_reports_added_modified_and_deleted_files, ensure_recovers_from_unborn_repository, reports_executable_bit_changes_as_modified, reset_creates_fresh_baseline, reset_drops_previous_history, status_scan_does_not_write_added_file_blobs); 2 external calls (to_path_buf, spawn_blocking).


##### `remove_git_metadata`  (lines 122–135)

```
fn remove_git_metadata(root: &Path) -> anyhow::Result<()>
```

**Purpose**: Deletes the `.git` entry inside the target directory before a fresh baseline is created. It handles both normal `.git` directories and unusual file or symlink forms.

**Data flow**: It builds the path to `.git` → checks what kind of filesystem entry it is → does nothing if it is absent → removes it as a directory or as a file-like entry → returns success or a filesystem error.

**Call relations**: `reset_git_repository_sync` calls this first so the new baseline starts from clean Git metadata instead of inheriting old history or broken state.

*Call graph*: called by 1 (reset_git_repository_sync); 4 external calls (join, remove_dir_all, remove_file, symlink_metadata).


##### `commit_current_tree`  (lines 137–155)

```
fn commit_current_tree(repo: &gix::Repository, message: &str) -> anyhow::Result<()>
```

**Purpose**: Creates the single baseline commit that represents the directory’s current contents. This is the saved snapshot that future comparisons are measured against.

**Data flow**: It receives an opened Git repository and a commit message → finds the working directory → writes the current files into Git tree objects → builds a Codex author signature → commits that tree as `HEAD` with no parents → returns success or an error.

**Call relations**: `reset_git_repository_sync` calls this after initializing the repository. It delegates file-tree construction to `write_tree` and identity creation to `codex_signature`.

*Call graph*: calls 2 internal fn (codex_signature, write_tree); called by 1 (reset_git_repository_sync); 4 external calls (commit_as, workdir, new, default).


##### `write_index_from_head`  (lines 157–160)

```
fn write_index_from_head(root: &Path) -> anyhow::Result<()>
```

**Purpose**: Updates Git’s index so it matches the baseline commit. The index is Git’s staging-area file; keeping it aligned prevents normal Git status commands from seeing false changes immediately after reset.

**Data flow**: It receives the repository root → runs `git read-tree --reset HEAD` through the project’s safe Git command wrapper → returns success or the command error.

**Call relations**: `reset_git_repository_sync` calls this after committing the baseline. A test also calls it directly to make sure this index rewrite does not trigger configured Git hooks.

*Call graph*: calls 1 internal fn (run_git_for_status); called by 2 (reset_git_repository_sync, write_index_ignores_configured_hooks_path).


##### `codex_signature`  (lines 162–171)

```
fn codex_signature() -> gix::actor::Signature
```

**Purpose**: Builds the author and committer identity used for baseline commits. It marks these commits as created by Codex rather than by a user.

**Data flow**: It reads the current UTC time → combines it with the fixed name `Codex` and email `noreply@openai.com` → returns a Git signature object.

**Call relations**: `commit_current_tree` calls this right before creating the baseline commit, so every internal baseline commit has a consistent identity.

*Call graph*: called by 1 (commit_current_tree); 1 external calls (now).


##### `write_tree`  (lines 173–227)

```
fn write_tree(repo: &gix::Repository, dir: &Path) -> anyhow::Result<ObjectId>
```

**Purpose**: Converts a directory’s current contents into Git tree and blob objects. In plain terms, it packs files, folders, and symlinks into the format Git uses for a snapshot.

**Data flow**: It receives a Git repository and a directory → reads each entry except `.git` → recursively writes child directories, file contents, and symlink targets → records each entry’s name, mode, and object id → sorts entries → writes and returns the Git tree id.

**Call relations**: `commit_current_tree` calls this to prepare the snapshot that becomes the baseline commit. It uses helpers such as `file_mode`, `os_str_to_bstring`, and `path_to_bytes` to represent filesystem details in Git’s format.

*Call graph*: calls 3 internal fn (file_mode, os_str_to_bstring, path_to_bytes); called by 1 (commit_current_tree); 8 external calls (new, find_tree, write_blob, write_object, new, read, read_dir, read_link).


##### `head_file_entries`  (lines 229–237)

```
fn head_file_entries(
    repo: &gix::Repository,
) -> anyhow::Result<BTreeMap<String, GitBaselineFileEntry>>
```

**Purpose**: Reads the baseline commit and builds a lookup table of every tracked file. Each entry stores the file path, content identifier, and Git mode.

**Data flow**: It receives an opened repository → loads the tree pointed to by `HEAD` → walks that tree recursively → returns a sorted map from slash-style file paths to baseline file entries.

**Call relations**: `diff_since_latest_init` calls this to get the saved side of the comparison. It delegates the recursive walking to `collect_tree_entries`.

*Call graph*: calls 1 internal fn (collect_tree_entries); 4 external calls (new, new, find_tree, head_tree_id).


##### `collect_tree_entries`  (lines 239–265)

```
fn collect_tree_entries(
    repo: &gix::Repository,
    tree: gix::Tree<'_>,
    prefix: PathBuf,
    entries: &mut BTreeMap<String, GitBaselineFileEntry>,
) -> anyhow::Result<()>
```

**Purpose**: Walks a Git tree and records all non-directory entries inside it. This turns Git’s nested tree structure into a flat path-to-file map that is easier to compare.

**Data flow**: It receives a repository, a tree, a path prefix, and an output map → visits each tree entry → recurses into child trees → inserts files and links into the map using slash-separated paths → updates the map in place.

**Call relations**: `head_file_entries` starts this walk at the baseline root tree. When it finds subdirectories, it calls itself again to continue deeper.

*Call graph*: calls 2 internal fn (bstr_to_path, path_to_slash_string); called by 1 (head_file_entries); 3 external calls (join, find_tree, iter).


##### `current_file_entries`  (lines 267–274)

```
fn current_file_entries(
    repo: &gix::Repository,
    root: &Path,
) -> anyhow::Result<BTreeMap<String, GitBaselineFileEntry>>
```

**Purpose**: Builds the same kind of file lookup table for the files currently on disk. This is the live side of the baseline comparison.

**Data flow**: It receives a repository and root directory → creates an empty map → scans the current filesystem recursively → returns a sorted map from slash-style relative paths to current file entries.

**Call relations**: `diff_since_latest_init` calls this after reading the baseline entries. It hands the recursive filesystem walk to `collect_current_entries`.

*Call graph*: calls 1 internal fn (collect_current_entries); 1 external calls (new).


##### `collect_current_entries`  (lines 276–314)

```
fn collect_current_entries(
    repo: &gix::Repository,
    root: &Path,
    dir: &Path,
    entries: &mut BTreeMap<String, GitBaselineFileEntry>,
) -> anyhow::Result<()>
```

**Purpose**: Scans the current directory tree and records files and symbolic links, while ignoring `.git`. It computes Git-style identities for current content without adding those files to the repository.

**Data flow**: It receives the repository, root path, directory to scan, and output map → reads directory entries → recurses into subdirectories → for files, reads bytes and computes a blob id → for symlinks, reads the link target and hashes that → inserts path, id, and mode into the map.

**Call relations**: `current_file_entries` calls this at the root, and this function calls itself for subdirectories. It relies on `blob_oid`, `file_mode`, `path_to_bytes`, and `relative_slash_path` to describe current files in Git-compatible terms.

*Call graph*: calls 4 internal fn (blob_oid, file_mode, path_to_bytes, relative_slash_path); called by 1 (current_file_entries); 4 external calls (new, read, read_dir, read_link).


##### `blob_oid`  (lines 316–319)

```
fn blob_oid(repo: &gix::Repository, bytes: &[u8]) -> anyhow::Result<ObjectId>
```

**Purpose**: Computes the Git object id for a byte sequence as if it were a file blob. It does this without writing the bytes into Git’s object database.

**Data flow**: It receives a repository and raw bytes → uses the repository’s hash algorithm to compute the Git blob hash → returns the object id or an error.

**Call relations**: `collect_current_entries` uses this during status scanning so new files can be compared without being stored as Git objects. One test calls it directly to confirm that scanning does not write added file blobs.

*Call graph*: called by 2 (collect_current_entries, status_scan_does_not_write_added_file_blobs); 2 external calls (object_hash, compute_hash).


##### `diff_entries`  (lines 321–349)

```
fn diff_entries(
    head: &BTreeMap<String, GitBaselineFileEntry>,
    current: &BTreeMap<String, GitBaselineFileEntry>,
) -> Vec<GitBaselineChange>
```

**Purpose**: Compares the baseline file map with the current file map and decides which paths are added, modified, or deleted. This is the core change detection step.

**Data flow**: It receives two path-to-entry maps → checks current paths against baseline paths to find added and modified files → checks baseline paths missing from current files to find deletions → sorts the results by path → returns the change list.

**Call relations**: `diff_since_latest_init` calls this after collecting both sides of the comparison. Its output drives both the structured `changes` field and the later unified diff rendering.

*Call graph*: 1 external calls (new).


##### `render_unified_diff`  (lines 351–369)

```
fn render_unified_diff(
    repo: &gix::Repository,
    root: &Path,
    head_entries: &BTreeMap<String, GitBaselineFileEntry>,
    current_entries: &BTreeMap<String, GitBaselineFileEntry>,
    change
```

**Purpose**: Builds one combined patch-style diff for all changed files. This is the human-readable text that shows old and new lines.

**Data flow**: It receives the repository, root path, baseline entries, current entries, and change list → renders each changed file in order → concatenates those sections → returns the full diff string.

**Call relations**: `diff_since_latest_init` calls this after `diff_entries`. For each individual file, it hands off to `render_change_diff`.

*Call graph*: calls 1 internal fn (render_change_diff); 1 external calls (new).


##### `render_change_diff`  (lines 371–431)

```
fn render_change_diff(
    repo: &gix::Repository,
    root: &Path,
    head_entries: &BTreeMap<String, GitBaselineFileEntry>,
    current_entries: &BTreeMap<String, GitBaselineFileEntry>,
    change:
```

**Purpose**: Creates the patch-style diff section for one changed file. It includes file mode lines when a file is new, deleted, or changes executable/link mode.

**Data flow**: It receives one change plus both entry maps → reads old content from Git when present → reads new content from disk when present → converts bytes to text lossily if needed → writes Git-like headers and mode information → uses a text diff library to create line-level changes → returns that section.

**Call relations**: `render_unified_diff` calls this once per changed path. It reads baseline content with `read_head_blob` and current content with `read_current_file_bytes`, then uses `mode_label` to format Git modes.

*Call graph*: called by 1 (render_unified_diff); 4 external calls (from_utf8_lossy, new, from_lines, format!).


##### `read_head_blob`  (lines 433–436)

```
fn read_head_blob(repo: &gix::Repository, entry: &GitBaselineFileEntry) -> anyhow::Result<Vec<u8>>
```

**Purpose**: Reads the saved content for a baseline file from Git. This supplies the “before” side of a file diff.

**Data flow**: It receives a repository and a baseline file entry → finds the Git blob with that entry’s object id → takes its stored bytes → returns those bytes.

**Call relations**: `render_change_diff` calls this when the changed file existed in the baseline. The returned bytes are compared against the current file content.

*Call graph*: 1 external calls (find_blob).


##### `read_current_file_bytes`  (lines 438–449)

```
fn read_current_file_bytes(root: &Path, relative_path: &str) -> anyhow::Result<Vec<u8>>
```

**Purpose**: Reads the current on-disk content for a changed path. For symbolic links, it reads the link target text, matching how Git stores symlinks.

**Data flow**: It receives the root and a relative path → joins them into a full path → checks whether the entry is a symlink → returns symlink target bytes or regular file bytes → reports filesystem errors with path context.

**Call relations**: `render_change_diff` calls this when the changed file exists in the current directory. It uses `path_to_bytes` for symlink targets so the diff matches Git’s representation.

*Call graph*: calls 1 internal fn (path_to_bytes); 4 external calls (join, read, read_link, symlink_metadata).


##### `mode_label`  (lines 451–459)

```
fn mode_label(mode: EntryMode) -> &'static str
```

**Purpose**: Turns Git’s internal file mode value into the familiar numeric text used in diffs, such as `100644` for a normal file or `100755` for an executable file.

**Data flow**: It receives a Git entry mode → checks the kind of entry it represents → returns the matching mode string.

**Call relations**: `render_change_diff` uses this when writing new-file, deleted-file, or mode-change headers in the unified diff.

*Call graph*: 1 external calls (kind).


##### `file_mode`  (lines 474–476)

```
fn file_mode(_path: &Path, default: EntryKind) -> anyhow::Result<EntryMode>
```

**Purpose**: Decides what Git mode should be recorded for a filesystem file. On Unix it notices executable permission bits; on non-Unix systems it falls back to the supplied default kind.

**Data flow**: It receives a file path and a default Git kind → on Unix, reads file permissions and returns executable mode if any execute bit is set, otherwise the default mode → on non-Unix, returns the default mode.

**Call relations**: `write_tree` uses this when writing the baseline tree, and `collect_current_entries` uses it when scanning current files, so permission changes can be reported as modifications.

*Call graph*: called by 2 (collect_current_entries, write_tree); 2 external calls (into, metadata).


##### `os_str_to_bstring`  (lines 486–488)

```
fn os_str_to_bstring(value: &OsStr) -> gix::bstr::BString
```

**Purpose**: Converts an operating-system filename into the byte-string type expected by the Git library. This preserves Unix filenames as raw bytes where possible.

**Data flow**: It receives an `OsStr`, which is Rust’s platform-aware filename string → on Unix, uses the raw bytes → on other systems, uses a lossy text conversion → returns a Git byte string.

**Call relations**: `write_tree` calls this when creating Git tree entries, because Git stores filenames as byte strings rather than normal Rust text strings.

*Call graph*: called by 1 (write_tree); 2 external calls (as_bytes, to_string_lossy).


##### `path_to_bytes`  (lines 498–500)

```
fn path_to_bytes(path: &Path) -> Vec<u8>
```

**Purpose**: Converts a path into bytes for storage or hashing, especially for symbolic link targets. Git stores symlink targets as blob bytes, not as followed file contents.

**Data flow**: It receives a path → on Unix, copies the raw path bytes → on other systems, converts the path text lossily to bytes → returns the byte vector.

**Call relations**: `write_tree`, `collect_current_entries`, and `read_current_file_bytes` use this whenever a symlink target needs to be represented the way Git would represent it.

*Call graph*: called by 3 (collect_current_entries, read_current_file_bytes, write_tree); 2 external calls (as_os_str, to_string_lossy).


##### `bstr_to_path`  (lines 502–513)

```
fn bstr_to_path(value: &gix::bstr::BStr) -> PathBuf
```

**Purpose**: Converts a filename read from a Git tree back into a platform path. This lets the code rebuild relative paths while walking baseline tree entries.

**Data flow**: It receives a Git byte string → on Unix, treats the bytes as an OS string → on other systems, converts them through text → returns a `PathBuf`.

**Call relations**: `collect_tree_entries` calls this for each filename found in the baseline Git tree before joining it with the current path prefix.

*Call graph*: called by 1 (collect_tree_entries); 3 external calls (to_string, from_bytes, from).


##### `relative_slash_path`  (lines 515–519)

```
fn relative_slash_path(root: &Path, path: &Path) -> anyhow::Result<String>
```

**Purpose**: Turns an absolute or rooted filesystem path into a relative path string using forward slashes. This gives stable keys like `folder/file.txt` for comparison.

**Data flow**: It receives the root path and a full path → strips the root prefix → converts the remaining path components into a slash-separated string → returns that string or an error if the path is not under the root.

**Call relations**: `collect_current_entries` uses this when inserting current files into the comparison map, so current paths have the same format as baseline paths.

*Call graph*: called by 1 (collect_current_entries); 1 external calls (strip_prefix).


##### `path_to_slash_string`  (lines 521–526)

```
fn path_to_slash_string(path: &Path) -> String
```

**Purpose**: Formats a path with `/` separators regardless of the operating system’s native separator. This keeps diff paths Git-like and consistent.

**Data flow**: It receives a path → walks its components → converts each component to text → joins them with `/` → returns the resulting string.

**Call relations**: `collect_tree_entries` uses this for baseline paths. It is also part of the path conversion used by `relative_slash_path`.

*Call graph*: called by 1 (collect_tree_entries); 1 external calls (components).


##### `tests::git_stdout`  (lines 536–549)

```
fn git_stdout(root: &Path, args: &[&str]) -> String
```

**Purpose**: Runs a real `git` command inside a test repository and returns its standard output. It makes tests easier to read when they need to verify Git’s view of the repository.

**Data flow**: It receives a root path and command arguments → starts the `git` process in that directory → asserts the command succeeded → converts stdout bytes to text → returns that text.

**Call relations**: Several tests use this helper to check status, tracked files, and Git configuration effects after the baseline code runs.

*Call graph*: 3 external calls (from_utf8_lossy, assert!, new).


##### `tests::reset_creates_fresh_baseline`  (lines 552–567)

```
async fn reset_creates_fresh_baseline()
```

**Purpose**: Checks that a reset creates a usable private Git repository with the current files recorded as clean baseline content.

**Data flow**: It creates a temporary directory and file → calls `reset_git_repository` → asks for the diff → checks that `.git` and the index exist, no changes are reported, Git status is clean, and the file is tracked.

**Call relations**: This test exercises the main happy path through `reset_git_repository` and `diff_since_latest_init`, with `git_stdout` confirming the repository also looks clean to Git itself.

*Call graph*: calls 2 internal fn (diff_since_latest_init, reset_git_repository); 5 external calls (new, assert!, assert_eq!, create_dir_all, write).


##### `tests::ensure_recovers_from_unborn_repository`  (lines 570–585)

```
async fn ensure_recovers_from_unborn_repository()
```

**Purpose**: Checks that the ensure function repairs a Git repository that exists but has no baseline commit yet. Such a repository is “unborn,” meaning `HEAD` does not point to a commit.

**Data flow**: It creates files and initializes Git without committing → calls `ensure_git_baseline_repository` → computes the diff → verifies there are no changes and Git sees the file as tracked and clean.

**Call relations**: This test drives `ensure_git_baseline_repository` down its recovery path and then uses `diff_since_latest_init` and `git_stdout` to verify the repaired baseline.

*Call graph*: calls 2 internal fn (diff_since_latest_init, ensure_git_baseline_repository); 6 external calls (new, assert!, assert_eq!, create_dir_all, write, init).


##### `tests::write_index_ignores_configured_hooks_path`  (lines 589–630)

```
async fn write_index_ignores_configured_hooks_path()
```

**Purpose**: Checks that rewriting the baseline index does not run user-configured Git hooks. This matters because the baseline repository is an internal tool and should not trigger arbitrary hook scripts.

**Data flow**: It creates a temporary repository → resets the baseline → configures a custom hook that would write a marker file if run → calls `write_index_from_head` → asserts the marker file was not created.

**Call relations**: This test calls `reset_git_repository` for setup and then calls `write_index_from_head` directly to focus on the index rewrite behavior.

*Call graph*: calls 2 internal fn (reset_git_repository, write_index_from_head); 8 external calls (new, assert!, format!, create_dir_all, metadata, set_permissions, write, git_stdout).


##### `tests::diff_reports_added_modified_and_deleted_files`  (lines 633–689)

```
async fn diff_reports_added_modified_and_deleted_files()
```

**Purpose**: Checks that the diff system correctly reports all three main file changes: added, modified, and deleted. It also verifies that the readable diff text contains the expected sections.

**Data flow**: It creates baseline files → resets the repository → edits one file, adds another, and deletes a third → calls `diff_since_latest_init` → compares the structured change list and checks important lines in the unified diff.

**Call relations**: This test covers the full comparison pipeline: baseline creation, current filesystem scanning, `diff_entries`, and unified diff rendering.

*Call graph*: calls 2 internal fn (diff_since_latest_init, reset_git_repository); 6 external calls (new, assert!, assert_eq!, create_dir_all, remove_file, write).


##### `tests::reset_drops_previous_history`  (lines 692–708)

```
async fn reset_drops_previous_history()
```

**Purpose**: Checks that resetting again replaces old history rather than adding another commit on top. The private baseline should always be a single fresh snapshot.

**Data flow**: It creates a baseline → changes a file → resets again → opens the repository → verifies the current commit has no parents → checks that no diff is reported.

**Call relations**: This test calls `reset_git_repository` twice and then uses `diff_since_latest_init` to confirm the second reset became the new clean starting point.

*Call graph*: calls 2 internal fn (diff_since_latest_init, reset_git_repository); 6 external calls (new, assert!, assert_eq!, create_dir_all, write, open).


##### `tests::status_scan_does_not_write_added_file_blobs`  (lines 711–728)

```
async fn status_scan_does_not_write_added_file_blobs()
```

**Purpose**: Checks that scanning for changes does not store new file contents inside Git. The diff check should be observational, not mutate the object database with added files.

**Data flow**: It creates and resets an empty baseline → writes a new file → calls `diff_since_latest_init` → computes the would-be blob id for the new file → verifies Git cannot find that blob as a stored object.

**Call relations**: This test relies on `blob_oid` to calculate the expected object id and confirms that `collect_current_entries` only hashes current files instead of writing them.

*Call graph*: calls 3 internal fn (blob_oid, diff_since_latest_init, reset_git_repository); 5 external calls (new, assert!, create_dir_all, write, open).


##### `tests::reports_executable_bit_changes_as_modified`  (lines 732–755)

```
async fn reports_executable_bit_changes_as_modified()
```

**Purpose**: Checks that changing a file’s executable permission is treated as a modification even when the file text stays the same. This matters on Unix systems where executability is part of Git’s file mode.

**Data flow**: It writes a file → resets the baseline → changes the file permissions to add execute bits → calls `diff_since_latest_init` → verifies the file is marked modified and the diff shows old and new modes.

**Call relations**: This test exercises `file_mode`, `diff_entries`, and `render_change_diff` together to ensure permission-only changes are visible.

*Call graph*: calls 2 internal fn (diff_since_latest_init, reset_git_repository); 7 external calls (new, assert!, assert_eq!, create_dir_all, metadata, set_permissions, write).


### `ollama/src/pull.rs`

`io_transport` · `active during model pull/download progress reporting`

This file is the small user-facing layer for model download progress. Pulling a model can involve several pieces, often called layers, arriving over time. The code turns those updates into understandable terminal output, like “Downloading model: total 4.20 GB” and “1.10/4.20 GB (26.2%) 18.5 MB/s”.

The central idea is an event: `PullEvent` is a message about something that happened during a pull. It can be a plain status message, a byte-count update for one downloaded layer, a success signal, or an error message. A `PullProgressReporter` is an observer: anything that implements it can receive these events and decide how to present them.

`CliProgressReporter` is the current command-line implementation. It writes to standard error, which is the usual place for progress text because it stays separate from normal program output. It remembers progress for each layer digest, adds the totals together, estimates download speed from the change since the last update, and rewrites the same terminal line so the screen does not fill with repeated progress messages. It also skips the noisy “pulling manifest” message and avoids printing errors twice.

`TuiProgressReporter` is a placeholder for a future text user interface. For now, it simply reuses the command-line reporter so both modes behave the same.

#### Function details

##### `CliProgressReporter::default`  (lines 39–41)

```
fn default() -> Self
```

**Purpose**: Creates a standard command-line progress reporter with its starting state set up. This lets other code ask for the default reporter without caring about the exact fields it needs internally.

**Data flow**: Nothing special comes in. It calls the reporter constructor, which builds a fresh reporter with no header printed, no remembered line length, no completed bytes yet, a current timestamp, and an empty table of layer progress. The finished reporter comes out ready to receive pull events.

**Call relations**: This is the conventional default path for code that wants a `CliProgressReporter` without custom setup. It hands off directly to `CliProgressReporter::new`, so there is only one place that knows how to initialize the reporter correctly.

*Call graph*: 1 external calls (new).


##### `CliProgressReporter::new`  (lines 45–53)

```
fn new() -> Self
```

**Purpose**: Builds a new command-line progress reporter. It prepares the memory the reporter needs to update one terminal line and calculate total progress across all downloaded layers.

**Data flow**: No input is needed. The function creates a reporter whose progress table is empty, whose last printed line length is zero, whose completed byte count is zero, and whose timing baseline is the current moment. The result is a fresh `CliProgressReporter` ready to be given pull events.

**Call relations**: Other setup code, including `ensure_oss_ready`, calls this when it needs a progress display for a model pull. `CliProgressReporter::default` also uses it, which keeps normal construction and default construction consistent.

*Call graph*: called by 1 (ensure_oss_ready); 2 external calls (new, now).


##### `CliProgressReporter::on_event`  (lines 57–135)

```
fn on_event(&mut self, event: &PullEvent) -> io::Result<()>
```

**Purpose**: Receives one pull progress event and updates the command-line display. It turns raw download facts, such as completed bytes per layer, into readable progress text for the user.

**Data flow**: A pull event comes in. If it is a status message, the function writes that status on the current terminal line, except for the intentionally skipped “pulling manifest” message. If it is chunk progress, it updates the saved total and completed byte counts for that layer digest, adds all layers together, prints a total-size header once, calculates percentage and download speed, then rewrites the current progress line. If it is success, it prints a newline so the terminal prompt starts cleanly. If it is an error, it prints nothing because the caller is expected to show the error elsewhere. The function returns an input/output result showing whether writing to the terminal succeeded.

**Call relations**: This is the main workhorse for command-line progress reporting. The pull process sends it events through the `PullProgressReporter` trait. It writes directly to standard error and uses the current time to estimate speed. `TuiProgressReporter::on_event` also delegates to this same function so the temporary TUI behavior matches the CLI behavior.

*Call graph*: 3 external calls (format!, stderr, now).


##### `TuiProgressReporter::on_event`  (lines 144–146)

```
fn on_event(&mut self, event: &PullEvent) -> io::Result<()>
```

**Purpose**: Receives pull progress events for the text user interface path, but currently shows them using the same behavior as the command-line reporter. This keeps progress reporting working until a dedicated TUI display is built.

**Data flow**: A pull event comes in. The function passes that event unchanged to the inner `CliProgressReporter`. Whatever terminal output or input/output error the CLI reporter produces is passed back as this function’s result.

**Call relations**: This function sits in front of `CliProgressReporter::on_event`. Code that expects a TUI-style reporter can call it now, while the actual rendering is still done by the CLI reporter underneath.


### TUI status and summary surfaces
These files maintain the TUI's status-oriented projections, including footer and header state, goal and rate-limit summaries, branch metadata, and `/status` display models.

### `tui/src/chatwidget/status_surfaces.rs`

`domain_logic` · `main loop / UI refresh`

The chat screen has two “at a glance” surfaces: a status line at the bottom of the app, and the title shown by the terminal window. This file decides what appears there: model name, current project, git branch, task progress, token usage, permissions, rate limits, and similar context. Without it, users would lose quick visibility into what Codex is doing and where it is working.

The file first reads the user’s configuration and turns item names like “project-name” or “git-branch” into known display items. Unknown names are ignored, but the user is warned once so a typo does not silently confuse them. Some values are quick to compute, while others, like git branch or pull request details, may need background work. The file starts those lookups only when the chosen display actually needs them, then caches results so frequent title refreshes do not keep repeating expensive filesystem or git checks.

Rendering works like assembling a small dashboard. Each configured item is asked for its current text. Missing values are skipped rather than shown as errors. The footer is formatted into colored segments when enabled. The terminal title is written only when it has changed, and it can animate a spinner or blink an “Action Required” message when Codex is waiting for the user.

#### Function details

##### `StatusSurfaceSelections::uses_git_branch`  (lines 54–59)

```
fn uses_git_branch(&self) -> bool
```

**Purpose**: Checks whether either the footer status line or the terminal title has asked to show the current git branch. This lets the app avoid doing git work when no visible surface needs it.

**Data flow**: It reads the already-parsed lists of selected status-line and terminal-title items. If either list contains the git branch item, it returns true; otherwise it returns false. It does not change any state.

**Call relations**: During shared refresh setup, ChatWidget::sync_status_surface_shared_state calls this to decide whether to keep or clear the cached branch information and whether to request a branch lookup.

*Call graph*: called by 1 (sync_status_surface_shared_state).


##### `StatusSurfaceSelections::uses_git_summary`  (lines 61–67)

```
fn uses_git_summary(&self) -> bool
```

**Purpose**: Checks whether the status line needs richer git summary information, such as pull request number or branch change counts. This prevents extra git summary work when those items are not displayed.

**Data flow**: It reads the parsed status-line item list. If that list includes pull request number or branch changes, it returns true; otherwise it returns false. It does not modify anything.

**Call relations**: ChatWidget::sync_status_surface_shared_state uses this check before syncing or requesting the cached git summary used by the footer.

*Call graph*: called by 1 (sync_status_surface_shared_state).


##### `ChatWidget::status_surface_selections`  (lines 82–92)

```
fn status_surface_selections(&self) -> StatusSurfaceSelections
```

**Purpose**: Builds one snapshot of what the status line and terminal title should try to show. It also captures any unknown configured item names so warnings can be shown.

**Data flow**: It reads the widget configuration through the status-line and terminal-title parsing helpers. It packages the valid items and invalid item names into a StatusSurfaceSelections value, which later refresh steps reuse.

**Call relations**: This is the first step for refresh_status_surfaces, refresh_terminal_title, and the manual git refresh requests. It calls ChatWidget::status_line_items_with_invalids and ChatWidget::terminal_title_items_with_invalids so both surfaces are based on the same config snapshot.

*Call graph*: calls 2 internal fn (status_line_items_with_invalids, terminal_title_items_with_invalids); called by 4 (refresh_status_surfaces, refresh_terminal_title, request_status_line_branch_refresh, request_status_line_git_summary_refresh).


##### `ChatWidget::warn_invalid_status_line_items_once`  (lines 94–113)

```
fn warn_invalid_status_line_items_once(&mut self, invalid_items: &[String])
```

**Purpose**: Shows a one-time warning when the user configured status-line item names that Codex does not understand. This helps users spot typos without spamming them every refresh.

**Data flow**: It receives a list of invalid item names. If a chat thread exists, the list is not empty, and the warning has not already been sent, it formats a readable warning and sends it through the widget warning path.

**Call relations**: ChatWidget::refresh_status_surfaces calls this after parsing configuration and before rendering the footer. It does not participate in title-only refreshes because it is specific to the status line.

*Call graph*: called by 1 (refresh_status_surfaces); 1 external calls (format!).


##### `ChatWidget::warn_invalid_terminal_title_items_once`  (lines 115–134)

```
fn warn_invalid_terminal_title_items_once(&mut self, invalid_items: &[String])
```

**Purpose**: Shows a one-time warning when the terminal-title configuration contains unknown item names. This makes bad configuration visible while keeping repeated refreshes quiet.

**Data flow**: It receives invalid terminal-title names. If there is an active thread, the list is non-empty, and the title warning flag was still unset, it formats one message and sends it as a warning.

**Call relations**: Both ChatWidget::refresh_status_surfaces and ChatWidget::refresh_terminal_title call this after parsing title selections, because either full UI refreshes or title-only refreshes can discover bad title settings.

*Call graph*: called by 2 (refresh_status_surfaces, refresh_terminal_title); 1 external calls (format!).


##### `ChatWidget::sync_status_surface_shared_state`  (lines 136–160)

```
fn sync_status_surface_shared_state(&mut self, selections: &StatusSurfaceSelections)
```

**Purpose**: Keeps shared cached data, especially git branch and git summary data, aligned with what the current displays need. It avoids stale project information and avoids background work for hidden items.

**Data flow**: It receives the current selection snapshot. If branch or summary information is not selected, it clears the related cached value and pending flags. If it is selected, it checks the current working directory, resets caches when the directory changed, and starts a background lookup if needed.

**Call relations**: ChatWidget::refresh_status_surfaces and ChatWidget::refresh_terminal_title call this before rendering. It uses StatusSurfaceSelections::uses_git_branch and StatusSurfaceSelections::uses_git_summary, then hands work to the branch and git-summary sync/request helpers.

*Call graph*: calls 7 internal fn (request_status_line_branch, request_status_line_git_summary, status_line_cwd, sync_status_line_branch_state, sync_status_line_git_summary_state, uses_git_branch, uses_git_summary); called by 2 (refresh_status_surfaces, refresh_terminal_title).


##### `ChatWidget::refresh_status_line_from_selections`  (lines 162–188)

```
fn refresh_status_line_from_selections(&mut self, selections: &StatusSurfaceSelections)
```

**Purpose**: Turns the selected status-line items into the actual footer text shown inside the terminal UI. It also enables or disables the footer status line depending on whether anything is configured.

**Data flow**: It receives parsed selections. If no status-line items are selected, it disables and clears the line and its hyperlink. Otherwise it asks each item for its current display value, skips missing values, formats the remaining pieces into status-line segments, and stores the result; if a pull request is shown, it also sets the link target.

**Call relations**: ChatWidget::refresh_status_surfaces calls this after shared state is synced. For each displayed item it calls ChatWidget::status_line_value_for_item, then delegates final segment formatting to the bottom-pane status-line formatter.

*Call graph*: calls 1 internal fn (status_line_value_for_item); called by 1 (refresh_status_surfaces); 2 external calls (new, status_line_from_segments).


##### `ChatWidget::clear_managed_terminal_title`  (lines 195–202)

```
fn clear_managed_terminal_title(&mut self) -> std::io::Result<()>
```

**Purpose**: Clears the terminal title that Codex most recently wrote. It deliberately does not try to restore whatever title the shell had before Codex touched it.

**Data flow**: It checks whether Codex has a remembered last title. If so, it sends the terminal escape sequence to clear the title and then forgets the cached title. It returns success or the I/O error from writing to the terminal.

**Call relations**: ChatWidget::refresh_terminal_title_from_selections calls this whenever the title selection is empty, the rendered title has no visible content, or rendering produces no title.

*Call graph*: called by 1 (refresh_terminal_title_from_selections).


##### `ChatWidget::refresh_terminal_title_from_selections`  (lines 211–254)

```
fn refresh_terminal_title_from_selections(&mut self, selections: &StatusSurfaceSelections)
```

**Purpose**: Builds and applies the current terminal window title from the chosen title items. It avoids redundant writes and schedules animation frames when the title should keep moving or blinking.

**Data flow**: It receives parsed selections, records whether the title is currently in an action-required state, and clears the title if no title items are selected. Otherwise it renders the title for the current time, compares it with the last written title, writes only if changed, handles empty or failed writes, and schedules the next animation tick when needed.

**Call relations**: ChatWidget::refresh_status_surfaces and ChatWidget::refresh_terminal_title call this after parsing and shared-state syncing. It relies on title text and animation helpers, and calls ChatWidget::clear_managed_terminal_title when the managed title should disappear.

*Call graph*: calls 4 internal fn (clear_managed_terminal_title, terminal_title_animation_interval_with_selections, terminal_title_shows_action_required_with_selections, terminal_title_text_for_selections); called by 2 (refresh_status_surfaces, refresh_terminal_title); 2 external calls (now, debug!).


##### `ChatWidget::refresh_status_surfaces`  (lines 262–269)

```
fn refresh_status_surfaces(&mut self)
```

**Purpose**: Refreshes both the footer status line and the terminal title in one coordinated pass. This is the main entry point when the UI wants all status displays updated.

**Data flow**: It parses both configurations into a shared selection snapshot, warns once about invalid configured items, syncs shared cached data such as git information, then renders the footer and terminal title from that same snapshot.

**Call relations**: This function ties together the file’s main workflow. It calls the selection parser, invalid-item warning helpers, shared-state sync, status-line renderer, and terminal-title renderer in order.

*Call graph*: calls 6 internal fn (refresh_status_line_from_selections, refresh_terminal_title_from_selections, status_surface_selections, sync_status_surface_shared_state, warn_invalid_status_line_items_once, warn_invalid_terminal_title_items_once).


##### `ChatWidget::refresh_terminal_title`  (lines 272–277)

```
fn refresh_terminal_title(&mut self)
```

**Purpose**: Refreshes only the terminal window title. This is useful for frequent title updates, such as animation frames, without rebuilding the footer.

**Data flow**: It parses the latest surface selections, warns once about invalid terminal-title items, syncs any shared state the title depends on, and renders the title.

**Call relations**: This is the title-only counterpart to ChatWidget::refresh_status_surfaces. It calls the same parsing and shared-state paths but skips status-line warning and footer rendering.

*Call graph*: calls 4 internal fn (refresh_terminal_title_from_selections, status_surface_selections, sync_status_surface_shared_state, warn_invalid_terminal_title_items_once).


##### `ChatWidget::terminal_title_requires_action`  (lines 279–281)

```
fn terminal_title_requires_action(&self) -> bool
```

**Purpose**: Asks whether the bottom pane currently needs user input, so the terminal title can call attention to it. This is the basic signal behind the “Action Required” title behavior.

**Data flow**: It reads the bottom pane’s action-required state and returns that boolean unchanged. It does not change any state.

**Call relations**: ChatWidget::terminal_title_shows_action_required and ChatWidget::terminal_title_shows_action_required_with_selections call this before deciding whether the title should show the special action-needed message.

*Call graph*: called by 2 (terminal_title_shows_action_required, terminal_title_shows_action_required_with_selections).


##### `ChatWidget::terminal_title_shows_action_required`  (lines 283–285)

```
fn terminal_title_shows_action_required(&self) -> bool
```

**Purpose**: Decides whether the terminal title should show the action-required alert under the current configuration. It requires both a real action-needed state and an activity item in the title setup.

**Data flow**: It reads whether the bottom pane needs action and whether the configured title uses an activity or spinner item. It returns true only when both are true.

**Call relations**: Animation helpers and progress checks call this to decide whether normal spinner progress should stop and the action-required animation should take over.

*Call graph*: calls 2 internal fn (terminal_title_requires_action, terminal_title_uses_activity); called by 2 (should_animate_terminal_title_action_required, terminal_title_has_active_progress).


##### `ChatWidget::terminal_title_text_for_selections`  (lines 287–312)

```
fn terminal_title_text_for_selections(
        &mut self,
        selections: &StatusSurfaceSelections,
        now: Instant,
    ) -> Option<String>
```

**Purpose**: Creates the full terminal title text for the current selection snapshot. It either builds the normal title or switches to a special action-required title.

**Data flow**: It receives selected title items and the current time. If action is required, it returns the alert-style title. Otherwise it asks each selected item for its current value, skips unavailable values, inserts item-specific separators, and returns the assembled title if it is not empty.

**Call relations**: ChatWidget::refresh_terminal_title_from_selections calls this before writing the title. It calls ChatWidget::action_required_terminal_title_text when an alert should be shown, otherwise it uses terminal-title item value lookups.

*Call graph*: calls 2 internal fn (action_required_terminal_title_text, terminal_title_shows_action_required_with_selections); called by 1 (refresh_terminal_title_from_selections); 1 external calls (new).


##### `ChatWidget::action_required_terminal_title_text`  (lines 314–325)

```
fn action_required_terminal_title_text(
        &mut self,
        selections: &StatusSurfaceSelections,
        now: Instant,
    ) -> String
```

**Purpose**: Builds the terminal-title text used when Codex is blocked waiting for the user. It keeps useful title parts while adding a clear alert prefix.

**Data flow**: It receives selections and the current time. It chooses the visible or blinking alert prefix, then asks the bottom-pane title builder to combine that prefix with selected title items while excluding the normal status item.

**Call relations**: ChatWidget::terminal_title_text_for_selections calls this when the selected title should show action-required state. It depends on ChatWidget::action_required_terminal_title_prefix_at for the time-based prefix.

*Call graph*: calls 1 internal fn (action_required_terminal_title_prefix_at); called by 1 (terminal_title_text_for_selections); 1 external calls (build_action_required_title_text).


##### `ChatWidget::action_required_terminal_title_prefix_at`  (lines 327–339)

```
fn action_required_terminal_title_prefix_at(&self, now: Instant) -> &'static str
```

**Purpose**: Chooses the alert prefix for the terminal title at a given moment. When animations are enabled, it alternates between two prefixes to create a blinking effect.

**Data flow**: It reads the animation setting and compares the given time with the title animation start time. If animations are off, it returns the steady alert prefix; if on, it returns one of two prefixes based on the current one-second phase.

**Call relations**: ChatWidget::action_required_terminal_title_text calls this while building the action-required title. Its timing works with the frame scheduling chosen by ChatWidget::terminal_title_animation_interval_with_selections.

*Call graph*: called by 1 (action_required_terminal_title_text); 1 external calls (saturating_duration_since).


##### `ChatWidget::terminal_title_shows_action_required_with_selections`  (lines 341–349)

```
fn terminal_title_shows_action_required_with_selections(
        &self,
        selections: &StatusSurfaceSelections,
    ) -> bool
```

**Purpose**: Decides whether a particular parsed title selection should show the action-required alert. It is stricter than the general check because it looks at the already-parsed item list.

**Data flow**: It reads the current action-required state and checks whether the selected terminal-title items include the spinner item. It returns true only when both are true.

**Call relations**: The title rendering path calls this before choosing alert text, recording title state, and scheduling action-required animation.

*Call graph*: calls 1 internal fn (terminal_title_requires_action); called by 3 (refresh_terminal_title_from_selections, terminal_title_animation_interval_with_selections, terminal_title_text_for_selections).


##### `ChatWidget::terminal_title_animation_interval_with_selections`  (lines 351–363)

```
fn terminal_title_animation_interval_with_selections(
        &self,
        selections: &StatusSurfaceSelections,
    ) -> Option<Duration>
```

**Purpose**: Chooses how soon the next terminal-title refresh should happen, if any animation is active. It covers both blinking action-required alerts and spinner animation.

**Data flow**: It receives the parsed title selections. If animations are enabled and action-required title mode is active, it returns the slower blink interval. Otherwise, if the spinner should animate, it returns the spinner interval. If no animation is needed, it returns no interval.

**Call relations**: ChatWidget::refresh_terminal_title_from_selections uses this to schedule the next frame. It calls the action-required and spinner animation decision helpers.

*Call graph*: calls 2 internal fn (should_animate_terminal_title_spinner_with_selections, terminal_title_shows_action_required_with_selections); called by 1 (refresh_terminal_title_from_selections).


##### `ChatWidget::request_status_line_branch_refresh`  (lines 365–373)

```
fn request_status_line_branch_refresh(&mut self)
```

**Purpose**: Forces a refresh of the cached git branch when a relevant event says the branch may have changed. It does nothing if neither status surface is configured to show the branch.

**Data flow**: It parses the current selections, exits if branch is not used, gets the current working directory, syncs the branch cache to that directory, and starts a branch lookup.

**Call relations**: This function is used outside the normal full refresh path when branch data needs to be refreshed directly. It shares the same selection and request helpers used by ChatWidget::sync_status_surface_shared_state.

*Call graph*: calls 4 internal fn (request_status_line_branch, status_line_cwd, status_surface_selections, sync_status_line_branch_state).


##### `ChatWidget::request_status_line_git_summary_refresh`  (lines 375–383)

```
fn request_status_line_git_summary_refresh(&mut self)
```

**Purpose**: Forces a refresh of git summary data, such as pull request and change counts, when that information may be stale. It skips work when those items are not displayed.

**Data flow**: It parses selections, exits if no selected item needs git summary data, gets the current working directory, resets summary cache state for that directory if needed, and starts a background summary lookup.

**Call relations**: This direct refresh path mirrors the summary part of ChatWidget::sync_status_surface_shared_state and calls the same git-summary request helper.

*Call graph*: calls 4 internal fn (request_status_line_git_summary, status_line_cwd, status_surface_selections, sync_status_line_git_summary_state).


##### `ChatWidget::status_line_items_with_invalids`  (lines 388–390)

```
fn status_line_items_with_invalids(&self) -> (Vec<StatusLineItem>, Vec<String>)
```

**Purpose**: Turns configured status-line item names into known status-line item values and collects names that were not recognized. This separates valid display choices from configuration mistakes.

**Data flow**: It reads the configured status-line item strings, or defaults if none were configured, then passes them to the generic parser. It returns two lists: valid items and invalid names.

**Call relations**: ChatWidget::status_surface_selections calls this while building the shared refresh snapshot. It uses ChatWidget::configured_status_line_items and parse_items_with_invalids.

*Call graph*: calls 2 internal fn (configured_status_line_items, parse_items_with_invalids); called by 1 (status_surface_selections).


##### `ChatWidget::configured_status_line_items`  (lines 392–399)

```
fn configured_status_line_items(&self) -> Vec<String>
```

**Purpose**: Returns the raw configured status-line item names. If the user did not configure the status line, it supplies the built-in default list.

**Data flow**: It reads the status-line configuration from the widget config. If a custom list exists, it clones and returns it; otherwise it returns the default item names as strings.

**Call relations**: ChatWidget::status_line_items_with_invalids calls this before parsing the names into real status-line items.

*Call graph*: called by 1 (status_line_items_with_invalids).


##### `ChatWidget::terminal_title_items_with_invalids`  (lines 404–406)

```
fn terminal_title_items_with_invalids(&self) -> (Vec<TerminalTitleItem>, Vec<String>)
```

**Purpose**: Turns configured terminal-title item names into known title item values and collects unknown names. This lets title rendering ignore bad entries while still warning the user.

**Data flow**: It reads the raw title item names, falling back to defaults when unset, then parses them. It returns valid title items together with a de-duplicated list of invalid names.

**Call relations**: ChatWidget::status_surface_selections calls this while preparing a refresh snapshot. It uses ChatWidget::configured_terminal_title_items and parse_items_with_invalids.

*Call graph*: calls 2 internal fn (configured_terminal_title_items, parse_items_with_invalids); called by 1 (status_surface_selections).


##### `ChatWidget::configured_terminal_title_items`  (lines 409–416)

```
fn configured_terminal_title_items(&self) -> Vec<String>
```

**Purpose**: Returns the raw configured terminal-title item names. If the user has not configured the title, it uses the minimal default title setup.

**Data flow**: It reads the terminal-title configuration. A custom list is cloned and returned; otherwise the default items, activity and project name, are returned as strings.

**Call relations**: ChatWidget::terminal_title_items_with_invalids calls this before parsing title item names.

*Call graph*: called by 1 (terminal_title_items_with_invalids).


##### `ChatWidget::status_line_cwd`  (lines 418–422)

```
fn status_line_cwd(&self) -> &Path
```

**Purpose**: Finds the working directory that status displays should describe. It uses the live current directory when available and otherwise falls back to the configured startup directory.

**Data flow**: It reads the widget’s current working directory field. If it exists, it returns that path; otherwise it returns the config’s cwd path. It does not allocate or change state.

**Call relations**: Many display and refresh helpers call this when they need directory context, including git lookups, project-name lookup, current-directory display, and terminal-title directory items.

*Call graph*: called by 6 (request_status_line_branch_refresh, request_status_line_git_summary_refresh, status_line_project_root_name, status_line_value_for_item, sync_status_surface_shared_state, terminal_title_value_for_item).


##### `ChatWidget::status_line_project_root_for_cwd`  (lines 429–447)

```
fn status_line_project_root_for_cwd(&self, cwd: &Path) -> Option<PathBuf>
```

**Purpose**: Finds the best project root for a given working directory. It prefers a git repository root, but can still find a project folder from Codex project configuration when no git repository is present.

**Data flow**: It receives a directory path. It first tries to find the containing git repository root. If none is found, it scans the configuration layer stack for a project config folder and returns that project’s parent directory. If neither exists, it returns nothing.

**Call relations**: ChatWidget::status_line_project_root_name_for_cwd calls this before turning the root path into a short display name.

*Call graph*: called by 1 (status_line_project_root_name_for_cwd).


##### `ChatWidget::status_line_project_root_name_for_cwd`  (lines 449–455)

```
fn status_line_project_root_name_for_cwd(&self, cwd: &Path) -> Option<String>
```

**Purpose**: Gets a human-friendly project name for a given directory. It turns the project root path into just its folder name when possible.

**Data flow**: It receives a directory, asks for the project root, then returns the root folder’s final path component as text. If the root has no normal folder name, it formats the full directory path instead.

**Call relations**: ChatWidget::status_line_project_root_name calls this when the cached project-root name is missing or stale.

*Call graph*: calls 1 internal fn (status_line_project_root_for_cwd); called by 1 (status_line_project_root_name).


##### `ChatWidget::status_line_project_root_name`  (lines 458–472)

```
fn status_line_project_root_name(&mut self) -> Option<String>
```

**Purpose**: Returns the cached project name for the current working directory, recomputing it only when the directory changes. This matters because terminal-title refreshes can be very frequent.

**Data flow**: It gets the current status directory and checks whether the project-name cache was built for that same directory. If so, it returns the cached name. Otherwise it recomputes the name, stores it with the directory key, and returns it.

**Call relations**: Status-line item rendering and terminal-title project-name rendering both call this. It relies on ChatWidget::status_line_cwd and ChatWidget::status_line_project_root_name_for_cwd.

*Call graph*: calls 2 internal fn (status_line_cwd, status_line_project_root_name_for_cwd); called by 2 (status_line_value_for_item, terminal_title_project_name).


##### `ChatWidget::terminal_title_project_name`  (lines 478–490)

```
fn terminal_title_project_name(&mut self) -> Option<String>
```

**Purpose**: Produces the project-name segment used in the terminal title. It prefers the inferred project root name and falls back to the current directory name.

**Data flow**: It asks for the cached project-root name. If none is available, it derives a name from the current directory path. It then shortens the result to a safe title length and returns it.

**Call relations**: Terminal-title item rendering and status-surface preview rendering call this for project-name values. It uses ChatWidget::status_line_project_root_name and the title truncation helper.

*Call graph*: calls 1 internal fn (status_line_project_root_name); called by 2 (status_surface_preview_value_for_item, terminal_title_value_for_item); 1 external calls (truncate_terminal_title_part).


##### `ChatWidget::sync_status_line_branch_state`  (lines 496–508)

```
fn sync_status_line_branch_state(&mut self, cwd: &Path)
```

**Purpose**: Resets the cached git branch when the working directory changes. This prevents showing a branch from the wrong repository.

**Data flow**: It receives the current directory. If it matches the directory already tied to the branch cache, it does nothing. Otherwise it stores the new directory and clears the branch value, pending flag, and lookup-complete flag.

**Call relations**: ChatWidget::sync_status_surface_shared_state and ChatWidget::request_status_line_branch_refresh call this before requesting branch data.

*Call graph*: called by 2 (request_status_line_branch_refresh, sync_status_surface_shared_state); 1 external calls (to_path_buf).


##### `ChatWidget::sync_status_line_git_summary_state`  (lines 510–518)

```
fn sync_status_line_git_summary_state(&mut self, cwd: &Path)
```

**Purpose**: Resets cached pull request and branch-change summary data when the working directory changes. This keeps git summary details tied to the correct repository.

**Data flow**: It receives the current directory. If that directory is already the cache key, it returns. Otherwise it stores the new directory and clears the summary value, pending flag, and lookup-complete flag.

**Call relations**: ChatWidget::sync_status_surface_shared_state and ChatWidget::request_status_line_git_summary_refresh call this before requesting fresh summary data.

*Call graph*: called by 2 (request_status_line_git_summary_refresh, sync_status_surface_shared_state); 1 external calls (to_path_buf).


##### `ChatWidget::request_status_line_branch`  (lines 524–538)

```
fn request_status_line_branch(&mut self, cwd: PathBuf)
```

**Purpose**: Starts a background lookup for the current git branch, unless one is already running. This keeps the UI responsive while git work happens elsewhere.

**Data flow**: It receives a directory. If a branch lookup is already pending, it exits. If no workspace command runner is available, it marks lookup as complete with no result. Otherwise it marks the lookup pending, spawns an async task to get the branch name, and sends an app event containing the directory and branch result.

**Call relations**: The shared refresh path and direct branch refresh path call this after cache state is synced. The eventual app event lets later code accept or reject the result based on the directory it was requested for.

*Call graph*: calls 1 internal fn (current_branch_name); called by 2 (request_status_line_branch_refresh, sync_status_surface_shared_state); 1 external calls (spawn).


##### `ChatWidget::request_status_line_git_summary`  (lines 540–554)

```
fn request_status_line_git_summary(&mut self, cwd: PathBuf)
```

**Purpose**: Starts a background lookup for git summary information, such as pull request and change counts. It avoids blocking the UI and avoids duplicate simultaneous lookups.

**Data flow**: It receives a directory. If a summary lookup is already pending, it exits. If no command runner exists, it marks lookup as complete without data. Otherwise it marks the lookup pending, spawns an async task to compute the summary, and sends the result back as an app event with the directory.

**Call relations**: ChatWidget::sync_status_surface_shared_state and ChatWidget::request_status_line_git_summary_refresh call this when selected items need summary data.

*Call graph*: calls 1 internal fn (status_line_git_summary); called by 2 (request_status_line_git_summary_refresh, sync_status_surface_shared_state); 1 external calls (spawn).


##### `ChatWidget::status_line_value_for_item`  (lines 561–658)

```
fn status_line_value_for_item(&mut self, item: StatusLineItem) -> Option<String>
```

**Purpose**: Converts one status-line item into the text that should be displayed right now. Missing information returns no value so the line can stay clean while data is unavailable.

**Data flow**: It receives a status-line item enum. Depending on the item, it reads model settings, directory state, cached git data, run state, permissions, token usage, rate limits, session details, thread title, or task progress. It returns a display string, or nothing if the value is not currently meaningful.

**Call relations**: The footer renderer calls this for each selected status-line item. Preview and terminal-title helpers also reuse it so shared concepts, like permissions or token usage, are displayed consistently.

*Call graph*: calls 8 internal fn (model_with_reasoning_display_name, reasoning_display_name, run_state_status_text, status_line_cwd, status_line_project_root_name, terminal_title_task_progress, approval_mode_display, permissions_display); called by 3 (refresh_status_line_from_selections, status_surface_preview_value_for_item, terminal_title_value_for_item); 2 external calls (limit_label_for_window, format!).


##### `ChatWidget::status_line_pull_request_url`  (lines 660–665)

```
fn status_line_pull_request_url(&self) -> Option<String>
```

**Purpose**: Returns the web URL for the pull request currently shown in the status line, if one is known. This supports making the pull request label clickable.

**Data flow**: It reads the cached git summary. If that summary includes pull request data, it clones and returns the pull request URL; otherwise it returns nothing.

**Call relations**: The status-line refresh code uses this when the selected footer items include pull request number, so the rendered line can attach the matching hyperlink.


##### `ChatWidget::status_surface_preview_value_for_item`  (lines 667–701)

```
fn status_surface_preview_value_for_item(
        &mut self,
        item: StatusSurfacePreviewItem,
    ) -> Option<String>
```

**Purpose**: Provides sample or live values for status-surface preview items. This lets configuration or preview UI show what a chosen item would look like.

**Data flow**: It receives a preview item. Some items are answered directly, such as app name, project name, run status, or task progress. Most are mapped to an equivalent status-line item and then resolved through ChatWidget::status_line_value_for_item.

**Call relations**: This function reuses existing status-line and title value helpers rather than duplicating display rules. It calls ChatWidget::terminal_title_project_name, ChatWidget::run_state_status_text, ChatWidget::terminal_title_task_progress, and ChatWidget::status_line_value_for_item as needed.

*Call graph*: calls 4 internal fn (run_state_status_text, status_line_value_for_item, terminal_title_project_name, terminal_title_task_progress).


##### `ChatWidget::terminal_title_value_for_item`  (lines 706–770)

```
fn terminal_title_value_for_item(
        &mut self,
        item: TerminalTitleItem,
        now: Instant,
    ) -> Option<String>
```

**Purpose**: Converts one terminal-title item into the text segment that should appear in the window title. Long values are shortened so the title remains readable.

**Data flow**: It receives a title item and the current time. It reads app state such as project name, directory, spinner frame, run status, thread title, git branch, token use, rate limits, session ID, model information, or task progress. It returns a short string or nothing when the value is unavailable.

**Call relations**: ChatWidget::terminal_title_text_for_selections calls this while assembling the title. Many title items reuse ChatWidget::status_line_value_for_item to keep wording consistent with the footer.

*Call graph*: calls 8 internal fn (model_with_reasoning_display_name, reasoning_display_name, run_state_status_text, status_line_cwd, status_line_value_for_item, terminal_title_project_name, terminal_title_spinner_text_at, terminal_title_task_progress); 1 external calls (truncate_terminal_title_part).


##### `ChatWidget::reasoning_display_name`  (lines 772–775)

```
fn reasoning_display_name(&self) -> String
```

**Purpose**: Builds the short label for the model’s current reasoning effort. Reasoning effort is the setting that controls how much deliberate thinking the model should use.

**Data flow**: It reads the effective reasoning-effort setting and passes it to the shared label formatter. It returns the formatted label as a string.

**Call relations**: Model display helpers and item-value renderers call this whenever the status line or title needs to mention reasoning.

*Call graph*: called by 3 (model_with_reasoning_display_name, status_line_value_for_item, terminal_title_value_for_item); 1 external calls (status_line_reasoning_effort_label).


##### `ChatWidget::model_with_reasoning_display_name`  (lines 777–791)

```
fn model_with_reasoning_display_name(&self) -> String
```

**Purpose**: Builds a compact model label that includes both the model name and reasoning label, and sometimes a service-tier label. This gives users more context than the model name alone.

**Data flow**: It reads the reasoning display name, current service tier, available service tier commands, account type, and model display name. It combines those pieces into one string, adding the service tier only when it applies.

**Call relations**: ChatWidget::status_line_value_for_item and ChatWidget::terminal_title_value_for_item call this for the model-with-reasoning item. It depends on ChatWidget::reasoning_display_name.

*Call graph*: calls 1 internal fn (reasoning_display_name); called by 2 (status_line_value_for_item, terminal_title_value_for_item); 1 external calls (format!).


##### `ChatWidget::run_state_status_text`  (lines 797–818)

```
fn run_state_status_text(&self) -> String
```

**Purpose**: Returns a simple word for what Codex is doing, such as Starting, Ready, Working, Waiting, or Thinking. This is the status label used in both the footer and title.

**Data flow**: It first checks startup state, which takes priority. Then it reads the terminal-title status kind and whether a task is actually running. If the app is no longer actively working, it reports Ready even if the last status bucket was Working, Waiting, or Thinking.

**Call relations**: Status-line rendering, terminal-title rendering, and preview rendering all call this for consistent runtime status wording.

*Call graph*: called by 3 (status_line_value_for_item, status_surface_preview_value_for_item, terminal_title_value_for_item).


##### `ChatWidget::terminal_title_spinner_text_at`  (lines 820–830)

```
fn terminal_title_spinner_text_at(&self, now: Instant) -> Option<String>
```

**Purpose**: Returns the spinner character for the terminal title at a given time. It only shows a spinner when animations are enabled and Codex has active progress to show.

**Data flow**: It reads the animation setting and active-progress state. If either says no animation should show, it returns nothing. Otherwise it asks for the current spinner frame and returns it as text.

**Call relations**: ChatWidget::terminal_title_value_for_item calls this when the configured title contains the spinner item. It calls ChatWidget::terminal_title_has_active_progress and ChatWidget::terminal_title_spinner_frame_at.

*Call graph*: calls 2 internal fn (terminal_title_has_active_progress, terminal_title_spinner_frame_at); called by 1 (terminal_title_value_for_item).


##### `ChatWidget::terminal_title_spinner_frame_at`  (lines 832–837)

```
fn terminal_title_spinner_frame_at(&self, now: Instant) -> &'static str
```

**Purpose**: Picks which spinner glyph should be shown for the current moment. It creates the illusion of motion by cycling through a fixed list of characters.

**Data flow**: It compares the given time with the animation start time, divides elapsed time by the spinner interval, and uses that number to choose a frame from the spinner list. It returns the selected static string.

**Call relations**: ChatWidget::terminal_title_spinner_text_at calls this after deciding that a spinner should be visible.

*Call graph*: called by 1 (terminal_title_spinner_text_at); 1 external calls (saturating_duration_since).


##### `ChatWidget::terminal_title_uses_activity`  (lines 839–845)

```
fn terminal_title_uses_activity(&self) -> bool
```

**Purpose**: Checks whether the current terminal-title configuration includes the activity indicator. This matters because action-required and spinner behavior only make sense when activity is part of the title.

**Data flow**: It reads the raw terminal-title configuration. If no custom list exists, the default title is treated as using activity. If a custom list exists, it checks for either “activity” or “spinner”.

**Call relations**: ChatWidget::terminal_title_shows_action_required and ChatWidget::should_animate_terminal_title_spinner call this when deciding whether activity-related title behavior is enabled.

*Call graph*: called by 2 (should_animate_terminal_title_spinner, terminal_title_shows_action_required).


##### `ChatWidget::terminal_title_has_active_progress`  (lines 847–853)

```
fn terminal_title_has_active_progress(&self) -> bool
```

**Purpose**: Decides whether there is ongoing work worth showing with the title spinner. It deliberately suppresses spinner progress when action-required mode is active.

**Data flow**: It first checks whether the title is showing action-required state; if so, it returns false. Otherwise it returns true when startup is still happening or the bottom pane reports a running task.

**Call relations**: Spinner text and spinner animation decisions call this. It calls ChatWidget::terminal_title_shows_action_required to let the action-required alert take priority over normal progress.

*Call graph*: calls 1 internal fn (terminal_title_shows_action_required); called by 3 (should_animate_terminal_title_spinner, should_animate_terminal_title_spinner_with_selections, terminal_title_spinner_text_at).


##### `ChatWidget::should_animate_terminal_title_spinner`  (lines 855–859)

```
fn should_animate_terminal_title_spinner(&self) -> bool
```

**Purpose**: Reports whether the terminal-title spinner should currently animate under the current configuration. This is a general-purpose check not tied to a parsed selection snapshot.

**Data flow**: It reads the animation setting, whether the title uses activity, and whether there is active progress. It returns true only when all three conditions are true.

**Call relations**: Other parts of the UI can call this to know whether title spinner animation is needed. It uses ChatWidget::terminal_title_uses_activity and ChatWidget::terminal_title_has_active_progress.

*Call graph*: calls 2 internal fn (terminal_title_has_active_progress, terminal_title_uses_activity).


##### `ChatWidget::should_animate_terminal_title_action_required`  (lines 861–863)

```
fn should_animate_terminal_title_action_required(&self) -> bool
```

**Purpose**: Reports whether the action-required title alert should animate. This means animations are enabled and the title is currently in action-required mode.

**Data flow**: It reads the animation setting and the action-required title decision. It returns a boolean and changes no state.

**Call relations**: This helper exposes the action-required animation decision to surrounding UI code. It calls ChatWidget::terminal_title_shows_action_required.

*Call graph*: calls 1 internal fn (terminal_title_shows_action_required).


##### `ChatWidget::should_animate_terminal_title_spinner_with_selections`  (lines 865–874)

```
fn should_animate_terminal_title_spinner_with_selections(
        &self,
        selections: &StatusSurfaceSelections,
    ) -> bool
```

**Purpose**: Checks whether the spinner should animate for a specific parsed title selection. This avoids scheduling spinner frames when the selected title does not include a spinner.

**Data flow**: It reads the animation setting, checks whether the selection contains the spinner item, and checks whether there is active progress. It returns true only when all are true.

**Call relations**: ChatWidget::terminal_title_animation_interval_with_selections calls this after checking action-required animation, to decide whether the next title refresh should use the spinner interval.

*Call graph*: calls 1 internal fn (terminal_title_has_active_progress); called by 1 (terminal_title_animation_interval_with_selections).


##### `ChatWidget::terminal_title_task_progress`  (lines 877–883)

```
fn terminal_title_task_progress(&self) -> Option<String>
```

**Purpose**: Formats the latest plan progress for display, such as “Tasks 2/5”. This gives a compact sense of how much of the current task plan is complete.

**Data flow**: It reads the last recorded plan-progress pair from the transcript. If there is no progress or the total is zero, it returns nothing. Otherwise it returns a formatted completed-over-total string.

**Call relations**: Status-line item rendering, terminal-title item rendering, and preview rendering call this when task progress is selected.

*Call graph*: called by 3 (status_line_value_for_item, status_surface_preview_value_for_item, terminal_title_value_for_item); 1 external calls (format!).


##### `ChatWidget::truncate_terminal_title_part`  (lines 886–900)

```
fn truncate_terminal_title_part(value: String, max_chars: usize) -> String
```

**Purpose**: Shortens one terminal-title segment without splitting visible characters in the middle. This is important for names that include emoji or combined characters.

**Data flow**: It receives a string and a maximum character count. It counts user-visible characters, called grapheme clusters, not raw bytes. If the value is too long and there is room, it replaces the end with “...”; otherwise it returns the allowed head of the string.

**Call relations**: Terminal-title value helpers call this for potentially long pieces such as project names, directories, branches, model labels, and thread titles.

*Call graph*: 1 external calls (new).


##### `five_hour_status_window`  (lines 903–910)

```
fn five_hour_status_window(
    snapshot: &RateLimitSnapshotDisplay,
) -> Option<(&RateLimitWindowDisplay, bool)>
```

**Purpose**: Chooses the best rate-limit window to show for the five-hour Codex limit. It uses several fallbacks because the available rate-limit data can vary.

**Data flow**: It receives a rate-limit snapshot. It first looks for a primary five-hour window, then a secondary five-hour window when weekly data is also present, then falls back to non-weekly primary or secondary windows. It returns the chosen window plus whether it was secondary.

**Call relations**: ChatWidget::status_line_value_for_item uses this when rendering the five-hour limit item. It calls helper functions that inspect labels and primary/secondary windows.

*Call graph*: calls 1 internal fn (find_primary_codex_window).


##### `weekly_status_window`  (lines 912–917)

```
fn weekly_status_window(
    snapshot: &RateLimitSnapshotDisplay,
) -> Option<(&RateLimitWindowDisplay, bool)>
```

**Purpose**: Chooses the rate-limit window to show for the weekly Codex limit. It prefers a window explicitly labeled weekly.

**Data flow**: It receives a rate-limit snapshot. It searches both primary and secondary windows for a weekly label, and if none is found, it falls back to the secondary window when present. It returns the window and whether it is secondary.

**Call relations**: ChatWidget::status_line_value_for_item uses this when rendering the weekly limit item. It delegates label matching to find_codex_window.

*Call graph*: calls 1 internal fn (find_codex_window).


##### `find_codex_window`  (lines 919–936)

```
fn find_codex_window(
    snapshot: &'a RateLimitSnapshotDisplay,
    label: &str,
) -> Option<(&'a RateLimitWindowDisplay, bool)>
```

**Purpose**: Finds a rate-limit window, primary or secondary, whose duration label matches the requested label. It tells the caller whether the match came from the secondary slot.

**Data flow**: It receives a snapshot and a label such as “5h” or “weekly”. It checks the primary window first, then the secondary window, using label matching for each. It returns the matched window with a secondary flag, or nothing.

**Call relations**: weekly_status_window and secondary_window_with_label_when_weekly_is_available use this as their shared search helper.

*Call graph*: calls 1 internal fn (matches_window_label); called by 2 (secondary_window_with_label_when_weekly_is_available, weekly_status_window).


##### `find_primary_codex_window`  (lines 938–948)

```
fn find_primary_codex_window(
    snapshot: &'a RateLimitSnapshotDisplay,
    label: &str,
) -> Option<(&'a RateLimitWindowDisplay, bool)>
```

**Purpose**: Looks only at the primary rate-limit window for a specific label. This is used when primary data should be preferred before fallback choices.

**Data flow**: It receives a snapshot and a label. If a primary window exists and its label matches, it returns that window marked as not secondary; otherwise it returns nothing.

**Call relations**: five_hour_status_window calls this as its first choice for the five-hour limit display.

*Call graph*: calls 1 internal fn (matches_window_label); called by 1 (five_hour_status_window).


##### `secondary_window_with_label_when_weekly_is_available`  (lines 950–962)

```
fn secondary_window_with_label_when_weekly_is_available(
    snapshot: &'a RateLimitSnapshotDisplay,
    label: &str,
) -> Option<(&'a RateLimitWindowDisplay, bool)>
```

**Purpose**: Finds a secondary window with a requested label, but only when the snapshot also contains weekly data. This supports a specific fallback shape in Codex rate-limit displays.

**Data flow**: It receives a snapshot and label. It first confirms that some weekly window is present. Then it checks whether the secondary window exists and matches the requested label. If so, it returns that secondary window.

**Call relations**: five_hour_status_window uses this after failing to find a primary five-hour window. It calls find_codex_window and matches_window_label.

*Call graph*: calls 2 internal fn (find_codex_window, matches_window_label).


##### `non_weekly_primary_window`  (lines 964–973)

```
fn non_weekly_primary_window(
    snapshot: &RateLimitSnapshotDisplay,
) -> Option<(&RateLimitWindowDisplay, bool)>
```

**Purpose**: Returns the primary rate-limit window when it is not a weekly window. This is a fallback for showing a useful non-weekly limit even if it is not explicitly labeled five-hour.

**Data flow**: It receives a snapshot, reads the primary window, and rejects it if its label is weekly. Otherwise it returns the primary window marked as not secondary.

**Call relations**: five_hour_status_window uses this as a later fallback after more exact five-hour searches fail.

*Call graph*: calls 1 internal fn (matches_window_label).


##### `non_weekly_secondary_window_when_primary_is_weekly`  (lines 975–989)

```
fn non_weekly_secondary_window_when_primary_is_weekly(
    snapshot: &RateLimitSnapshotDisplay,
) -> Option<(&RateLimitWindowDisplay, bool)>
```

**Purpose**: Returns a non-weekly secondary rate-limit window only when the primary window is weekly. This helps choose a shorter-term limit when weekly data occupies the primary slot.

**Data flow**: It receives a snapshot. If the primary window is missing or not weekly, it returns nothing. If the secondary window exists and is not weekly, it returns it marked as secondary.

**Call relations**: five_hour_status_window uses this as its final fallback for the five-hour-style display.

*Call graph*: calls 1 internal fn (matches_window_label).


##### `matches_window_label`  (lines 991–997)

```
fn matches_window_label(window: &RateLimitWindowDisplay, label: &str) -> bool
```

**Purpose**: Checks whether a rate-limit window’s duration label matches a requested label, such as “5h” or “weekly”. This hides the detail of converting window minutes into a readable duration.

**Data flow**: It reads the window’s minute count, converts it into a duration label when possible, and compares that label to the requested string. It returns true for a match and false otherwise.

**Call relations**: All rate-limit window search helpers call this so they agree on how labels are interpreted.

*Call graph*: called by 5 (find_codex_window, find_primary_codex_window, non_weekly_primary_window, non_weekly_secondary_window_when_primary_is_weekly, secondary_window_with_label_when_weekly_is_available).


##### `permissions_display`  (lines 999–1026)

```
fn permissions_display(config: &Config) -> String
```

**Purpose**: Builds the short permissions label shown in the status line. It turns detailed sandbox and workspace-access settings into words users can quickly understand.

**Data flow**: It reads the active permission profile from config. If the user selected a named non-built-in profile, it returns that name. Otherwise it summarizes the effective permission profile and workspace roots, maps common read-only and workspace-write cases to simple labels, maps disabled permissions to “Full Access”, and uses “Custom permissions” for anything more complex.

**Call relations**: ChatWidget::status_line_value_for_item calls this when the permissions item is selected. It relies on the shared permission-profile summarizer for accurate interpretation.

*Call graph*: called by 1 (status_line_value_for_item); 2 external calls (effective_workspace_roots, summarize_permission_profile).


##### `approval_mode_display`  (lines 1028–1038)

```
fn approval_mode_display(config: &Config) -> String
```

**Purpose**: Builds the short approval-mode label shown in the status line. It explains whether Codex asks the user before certain actions or can auto-review requests.

**Data flow**: It reads the approval policy from config. If the policy is on-request, it looks at who reviews approvals and returns either “Approve for me” or “Ask for approval”. For other policies, it returns the policy’s own text.

**Call relations**: ChatWidget::status_line_value_for_item calls this when the approval-mode item is selected.

*Call graph*: calls 1 internal fn (from); called by 1 (status_line_value_for_item).


##### `parse_items_with_invalids`  (lines 1040–1058)

```
fn parse_items_with_invalids(ids: impl IntoIterator<Item = String>) -> (Vec<T>, Vec<String>)
```

**Purpose**: Parses a list of configured item names into typed item values while collecting unknown names. It is shared by status-line and terminal-title configuration parsing.

**Data flow**: It receives strings and tries to parse each one into the requested item type. Successful parses go into the item list. Failed parses are added to an invalid-name list only once, preserving first-seen order, and are quoted for warning messages. It returns both lists.

**Call relations**: ChatWidget::status_line_items_with_invalids and ChatWidget::terminal_title_items_with_invalids call this so both surfaces handle valid and invalid configuration in the same way.

*Call graph*: called by 2 (status_line_items_with_invalids, terminal_title_items_with_invalids); 3 external calls (new, new, format!).


### `tui/src/branch_summary.rs`

`domain_logic` · `status-line background refresh`

The TUI wants to show helpful project context without slowing down or breaking the interface. This file is the quiet background worker for that job. It asks Git for the checked-out branch, finds the repository’s default branch, counts committed line additions and deletions since the merge base, and asks the GitHub CLI for an open pull request linked to the current branch or commit. A merge base is the common ancestor commit where two branches last shared history, like the fork in a road before two paths split.

A key idea in this file is “best effort.” Every lookup can fail for normal reasons: the folder might not be a Git repository, `gh` might not be installed, the user might not be logged in, or a remote may not have a default branch configured. In all of those cases, the functions return `None` for that piece of information. The status line can then simply leave that label out.

The file also avoids running shell commands directly. It sends all commands through `WorkspaceCommandExecutor`, an abstraction that can run commands either locally or through a remote workspace server. That keeps the same logic usable in both embedded and remote TUI modes.

#### Function details

##### `current_branch_name`  (lines 100–112)

```
async fn current_branch_name(
    runner: &dyn WorkspaceCommandExecutor,
    cwd: &Path,
) -> Option<String>
```

**Purpose**: Finds the name of the currently checked-out Git branch for one working directory. If the directory is not a Git repository, the checkout is detached, or the command fails, it returns no branch name so the status line can stay quiet.

**Data flow**: It receives a command runner and a folder path. It asks Git to show the current branch, checks that the command succeeded, trims extra whitespace, and returns the branch name only if it is not empty.

**Call relations**: Status-line refresh code calls this when it needs the simple branch label, including after branch-related status requests and when an agent message completes. This function delegates the actual Git invocation to `run_git_command` so it works through the shared workspace command system.

*Call graph*: calls 1 internal fn (run_git_command); called by 2 (request_status_line_branch, on_agent_message_item_completed).


##### `status_line_git_summary`  (lines 119–131)

```
async fn status_line_git_summary(
    runner: &dyn WorkspaceCommandExecutor,
    cwd: &Path,
) -> StatusLineGitSummary
```

**Purpose**: Builds the combined Git summary used by the status line: the open pull request, if one can be found, and the branch change counts, if they can be calculated. It treats both pieces as optional.

**Data flow**: It receives a command runner and a folder path. It starts the pull-request lookup and the branch-diff lookup at the same time, then places whatever results come back into a `StatusLineGitSummary` object.

**Call relations**: The status-line summary request calls this as the main entry for richer Git metadata. It uses asynchronous joining so the independent GitHub and Git probes do not wait on each other unnecessarily.

*Call graph*: called by 1 (request_status_line_git_summary); 1 external calls (join!).


##### `branch_diff_stats_to_default_branch`  (lines 138–191)

```
async fn branch_diff_stats_to_default_branch(
    runner: &dyn WorkspaceCommandExecutor,
    cwd: &Path,
) -> Option<GitBranchDiffStats>
```

**Purpose**: Counts how many committed lines were added and deleted on the current branch compared with the repository’s default branch. It ignores uncommitted local edits because the status line is summarizing the branch’s committed work, not the dirty working tree.

**Data flow**: It receives a runner and folder path. It first confirms the folder is inside a Git repository, finds a reliable default branch reference, finds the merge base between `HEAD` and that reference, runs Git’s numeric diff for that commit range, adds up the reported additions and deletions, and returns those totals.

**Call relations**: This is the branch-change side of the summary lookup and is exercised directly by a test that checks remote default branches are preferred. It depends on `get_default_branch` to choose the comparison target and on `run_git_command` for each Git query.

*Call graph*: calls 2 internal fn (get_default_branch, run_git_command); called by 1 (branch_diff_stats_prefers_remote_default_ref_over_stale_local_branch); 1 external calls (format!).


##### `get_git_remotes`  (lines 198–210)

```
async fn get_git_remotes(runner: &dyn WorkspaceCommandExecutor, cwd: &Path) -> Option<Vec<String>>
```

**Purpose**: Reads the repository’s configured Git remotes and puts `origin` first when it exists. This improves the odds that the default branch is found from the repository’s usual upstream remote.

**Data flow**: It receives a runner and folder path. It runs `git remote`, turns each output line into a remote name, moves `origin` to the front if present, and returns the ordered list.

**Call relations**: `get_default_branch` calls this before trying to discover a remote default branch. It uses `run_git_command` so the command runs through the same workspace abstraction as the rest of the file.

*Call graph*: calls 1 internal fn (run_git_command); called by 1 (get_default_branch).


##### `get_default_branch`  (lines 217–236)

```
async fn get_default_branch(
    runner: &dyn WorkspaceCommandExecutor,
    cwd: &Path,
) -> Option<DefaultBranch>
```

**Purpose**: Chooses the best Git reference to use as the default branch for comparing branch changes. It prefers remote-tracking references because local `main` or `master` branches can be stale or missing.

**Data flow**: It receives a runner and folder path. It asks for remotes, tries each remote’s symbolic default branch first, then tries parsing `git remote show`, and finally falls back to local `main` or `master` if no remote answer works.

**Call relations**: `branch_diff_stats_to_default_branch` calls this before calculating the merge base. This function coordinates the three discovery helpers: symbolic remote lookup, remote-show parsing, and local fallback.

*Call graph*: calls 4 internal fn (get_default_branch_local, get_git_remotes, get_remote_default_branch_from_remote_show, get_remote_default_branch_from_symbolic_ref); called by 1 (branch_diff_stats_to_default_branch).


##### `get_remote_default_branch_from_symbolic_ref`  (lines 243–266)

```
async fn get_remote_default_branch_from_symbolic_ref(
    runner: &dyn WorkspaceCommandExecutor,
    cwd: &Path,
    remote: &str,
) -> Option<DefaultBranch>
```

**Purpose**: Finds a remote’s default branch using the remote `HEAD` symbolic reference. A symbolic reference is like a signpost that points from a generic name such as `origin/HEAD` to the real branch such as `origin/main`.

**Data flow**: It receives a runner, folder path, and remote name. It asks Git what `refs/remotes/<remote>/HEAD` points to, checks that the answer belongs to that remote, verifies that the pointed-to reference really exists, and returns it as the merge reference.

**Call relations**: `get_default_branch` tries this first for each remote because it is the most direct way to learn the default branch. It calls `git_ref_exists` before accepting the result, which prevents stale signposts from being used later.

*Call graph*: calls 2 internal fn (git_ref_exists, run_git_command); called by 1 (get_default_branch); 1 external calls (format!).


##### `get_remote_default_branch_from_remote_show`  (lines 273–300)

```
async fn get_remote_default_branch_from_remote_show(
    runner: &dyn WorkspaceCommandExecutor,
    cwd: &Path,
    remote: &str,
) -> Option<DefaultBranch>
```

**Purpose**: Uses `git remote show` as a fallback way to discover a remote’s default branch. This helps repositories where the local `origin/HEAD` style reference has not been set up.

**Data flow**: It receives a runner, folder path, and remote name. It reads the text output from `git remote show`, looks for the `HEAD branch:` line, builds the matching remote-tracking reference, verifies that the reference exists locally, and returns it if valid.

**Call relations**: `get_default_branch` calls this after symbolic-reference lookup fails for a remote. It uses `git_ref_exists` to make sure the reported branch is actually available for later merge-base comparison.

*Call graph*: calls 2 internal fn (git_ref_exists, run_git_command); called by 1 (get_default_branch); 1 external calls (format!).


##### `get_default_branch_local`  (lines 303–317)

```
async fn get_default_branch_local(
    runner: &dyn WorkspaceCommandExecutor,
    cwd: &Path,
) -> Option<DefaultBranch>
```

**Purpose**: Falls back to a local default branch when no remote default branch can be found. It only considers the common branch names `main` and `master`.

**Data flow**: It receives a runner and folder path. It checks whether `refs/heads/main` exists, then whether `refs/heads/master` exists, and returns the first existing one as the comparison branch.

**Call relations**: `get_default_branch` calls this last, after all remote-based discovery has failed. It relies on `git_ref_exists` for each candidate branch.

*Call graph*: calls 1 internal fn (git_ref_exists); called by 1 (get_default_branch); 1 external calls (format!).


##### `git_ref_exists`  (lines 320–332)

```
async fn git_ref_exists(
    runner: &dyn WorkspaceCommandExecutor,
    cwd: &Path,
    reference: &str,
) -> bool
```

**Purpose**: Checks whether a named Git reference exists in the current repository. This protects later Git commands from being given a branch or ref that only appears to exist.

**Data flow**: It receives a runner, folder path, and reference name. It runs Git’s quiet verification command and returns `true` only when the command succeeds.

**Call relations**: The default-branch discovery helpers call this before trusting symbolic refs, remote-show output, or local fallback branch names. It sends the actual command through `run_git_command`.

*Call graph*: calls 1 internal fn (run_git_command); called by 3 (get_default_branch_local, get_remote_default_branch_from_remote_show, get_remote_default_branch_from_symbolic_ref).


##### `open_pull_request`  (lines 339–348)

```
async fn open_pull_request(
    runner: &dyn WorkspaceCommandExecutor,
    cwd: &Path,
) -> Option<StatusLinePullRequest>
```

**Purpose**: Finds the open GitHub pull request connected to the current checkout, if one exists. It tries the cheap branch-based lookup first, then falls back to searching by the current commit.

**Data flow**: It receives a runner and folder path. It asks `open_pull_request_for_current_branch` for a PR; if that returns nothing, it asks `open_pull_request_for_head_commit`; it returns the first open PR found.

**Call relations**: The summary lookup uses this as the PR-discovery path, and tests call it to verify both the fast path and fallback path. It coordinates the two more specific lookup functions.

*Call graph*: calls 2 internal fn (open_pull_request_for_current_branch, open_pull_request_for_head_commit); called by 2 (open_pull_request_falls_back_to_parent_repo_commit_lookup, open_pull_request_uses_current_branch_view_first).


##### `open_pull_request_for_current_branch`  (lines 351–362)

```
async fn open_pull_request_for_current_branch(
    runner: &dyn WorkspaceCommandExecutor,
    cwd: &Path,
) -> Option<StatusLinePullRequest>
```

**Purpose**: Asks the GitHub CLI for the pull request associated with the current branch. This matches the common `gh pr view` behavior users expect.

**Data flow**: It receives a runner and folder path. It runs `gh pr view` asking for JSON fields, checks success, parses the JSON, and returns the PR only if it is open.

**Call relations**: `open_pull_request` calls this first because it is simple and fast. It hands command output to `pull_request_from_view_output` so parsing and filtering stay separate from command execution.

*Call graph*: calls 2 internal fn (pull_request_from_view_output, run_gh_command); called by 1 (open_pull_request).


##### `open_pull_request_for_head_commit`  (lines 365–392)

```
async fn open_pull_request_for_head_commit(
    runner: &dyn WorkspaceCommandExecutor,
    cwd: &Path,
) -> Option<StatusLinePullRequest>
```

**Purpose**: Looks for open pull requests that contain the current `HEAD` commit. This is a fallback for fork workflows where branch-based lookup may point at the fork while the real PR lives on the parent repository.

**Data flow**: It receives a runner and folder path. It reads the current commit SHA, gets a parent-first list of repositories to search, queries GitHub’s API for PRs associated with that commit in each repository, and returns the first open PR it finds.

**Call relations**: `open_pull_request` calls this only after the branch-based lookup fails. It depends on `current_head_sha`, `gh_repo_search_order`, `run_gh_command`, and `pull_request_from_api_output` to break the fallback search into clear steps.

*Call graph*: calls 4 internal fn (current_head_sha, gh_repo_search_order, pull_request_from_api_output, run_gh_command); called by 1 (open_pull_request); 1 external calls (format!).


##### `current_head_sha`  (lines 395–404)

```
async fn current_head_sha(runner: &dyn WorkspaceCommandExecutor, cwd: &Path) -> Option<String>
```

**Purpose**: Reads the exact commit identifier for the current `HEAD`. This identifier is needed when searching GitHub for pull requests that include the current commit.

**Data flow**: It receives a runner and folder path. It runs `git rev-parse HEAD`, checks that it succeeded, trims the output, and returns the SHA only if it is not empty.

**Call relations**: `open_pull_request_for_head_commit` calls this before it can query GitHub’s commit-to-pull-request API. It delegates the Git command itself to `run_git_command`.

*Call graph*: calls 1 internal fn (run_git_command); called by 1 (open_pull_request_for_head_commit).


##### `gh_repo_search_order`  (lines 407–423)

```
async fn gh_repo_search_order(
    runner: &dyn WorkspaceCommandExecutor,
    cwd: &Path,
) -> Option<Vec<String>>
```

**Purpose**: Finds which GitHub repositories should be searched for commit-associated pull requests. It puts a parent repository before the current repository so fork-based PRs are found in the likely upstream location first.

**Data flow**: It receives a runner and folder path. It runs `gh repo view` for the repository name and parent information, checks success, parses the JSON, and returns an ordered list of repository names.

**Call relations**: `open_pull_request_for_head_commit` calls this after it knows the current commit SHA. It uses `run_gh_command` for the GitHub CLI call and `repo_search_order_from_output` for parsing the JSON.

*Call graph*: calls 2 internal fn (repo_search_order_from_output, run_gh_command); called by 1 (open_pull_request_for_head_commit).


##### `pull_request_from_view_output`  (lines 426–435)

```
fn pull_request_from_view_output(stdout: &str) -> Option<StatusLinePullRequest>
```

**Purpose**: Parses the JSON returned by `gh pr view` and keeps it only if the pull request is open. Closed or merged pull requests are intentionally hidden from the status line.

**Data flow**: It receives raw JSON text. It decodes the PR number, URL, and state; if the state says `open` in any letter case, it returns a `StatusLinePullRequest`, otherwise it returns nothing.

**Call relations**: `open_pull_request_for_current_branch` calls this after a successful GitHub CLI branch lookup. The parser keeps command execution and JSON interpretation separate.

*Call graph*: called by 1 (open_pull_request_for_current_branch).


##### `pull_request_from_api_output`  (lines 438–447)

```
fn pull_request_from_api_output(stdout: &str) -> Option<StatusLinePullRequest>
```

**Purpose**: Parses GitHub API output for pull requests associated with a commit and returns the first open one. This filters out closed or merged PRs so the status line only shows active work.

**Data flow**: It receives raw JSON text containing a list of pull request records. It decodes the list, scans for the first item whose state is open, and returns its number and browser URL.

**Call relations**: `open_pull_request_for_head_commit` calls this for each repository it queries. If this parser finds an open PR, the fallback search can stop immediately.

*Call graph*: called by 1 (open_pull_request_for_head_commit).


##### `repo_search_order_from_output`  (lines 453–469)

```
fn repo_search_order_from_output(stdout: &str) -> Option<Vec<String>>
```

**Purpose**: Turns `gh repo view` JSON into the list of repositories to search for pull requests. It prefers the parent repository, then adds the current repository if it is different.

**Data flow**: It receives raw JSON text. It decodes the current repository and optional parent repository, builds a list with the parent first, avoids adding duplicates, and returns nothing if no repository name is available.

**Call relations**: `gh_repo_search_order` calls this after receiving GitHub CLI output. A test checks that fork information produces a parent-first order.

*Call graph*: called by 1 (gh_repo_search_order); 1 external calls (new).


##### `run_git_command`  (lines 472–487)

```
async fn run_git_command(
    runner: &dyn WorkspaceCommandExecutor,
    cwd: &Path,
    args: &[&str],
) -> Result<WorkspaceCommandOutput, crate::workspace_command::WorkspaceCommandError>
```

**Purpose**: Runs a Git command through the project’s workspace command system instead of spawning a process directly. It also disables optional Git locks to make these background status checks less intrusive.

**Data flow**: It receives a runner, folder path, and Git arguments. It builds a command starting with `git`, sets the working directory and `GIT_OPTIONAL_LOCKS=0`, sends it to the runner, and returns the command output or command error.

**Call relations**: All Git-reading helpers in this file go through this function. That makes branch names, refs, commits, remotes, and diffs work the same whether the TUI is connected to a local or remote workspace.

*Call graph*: calls 1 internal fn (new); called by 7 (branch_diff_stats_to_default_branch, current_branch_name, current_head_sha, get_git_remotes, get_remote_default_branch_from_remote_show, get_remote_default_branch_from_symbolic_ref, git_ref_exists); 3 external calls (to_path_buf, with_capacity, run).


##### `run_gh_command`  (lines 493–509)

```
async fn run_gh_command(
    runner: &dyn WorkspaceCommandExecutor,
    cwd: &Path,
    args: &[&str],
) -> Result<WorkspaceCommandOutput, crate::workspace_command::WorkspaceCommandError>
```

**Purpose**: Runs a GitHub CLI command through the workspace command system. It disables interactive prompts so background status-line work never waits for user input.

**Data flow**: It receives a runner, folder path, and GitHub CLI arguments. It builds a command starting with `gh`, sets the working directory, disables GitHub and Git terminal prompts, runs it through the runner, and returns the output or error.

**Call relations**: The pull-request and repository lookup helpers use this whenever they need GitHub information. It is the GitHub counterpart to `run_git_command`.

*Call graph*: calls 1 internal fn (new); called by 3 (gh_repo_search_order, open_pull_request_for_current_branch, open_pull_request_for_head_commit); 3 external calls (to_path_buf, with_capacity, run).


##### `tests::branch_diff_stats_prefers_remote_default_ref_over_stale_local_branch`  (lines 521–569)

```
async fn branch_diff_stats_prefers_remote_default_ref_over_stale_local_branch()
```

**Purpose**: Checks that branch diff stats compare against the remote default branch rather than a possibly stale local branch. This protects the status line from showing misleading change counts.

**Data flow**: The test creates a fake command runner with expected Git responses, calls the branch-diff function for a fake repository path, and verifies the returned additions and deletions. It also checks that the merge-base command used the remote-tracking reference.

**Call relations**: This test drives `branch_diff_stats_to_default_branch` through the same command interface used in production, but with `FakeRunner` supplying canned outputs instead of real Git commands.

*Call graph*: calls 1 internal fn (branch_diff_stats_to_default_branch); 5 external calls (new, assert!, assert_eq!, new, vec!).


##### `tests::open_pull_request_uses_current_branch_view_first`  (lines 572–591)

```
async fn open_pull_request_uses_current_branch_view_first()
```

**Purpose**: Checks that pull-request lookup uses the current-branch GitHub CLI path when it succeeds. This keeps the common case fast and avoids unnecessary fallback commands.

**Data flow**: The test prepares a fake successful `gh pr view` response, calls `open_pull_request`, and verifies the returned PR number and URL. It also verifies that the commit SHA lookup was not run.

**Call relations**: This test exercises `open_pull_request` and confirms it stops after `open_pull_request_for_current_branch` succeeds. `FakeRunner::saw` is used to prove the fallback path was skipped.

*Call graph*: calls 1 internal fn (open_pull_request); 5 external calls (new, assert!, assert_eq!, new, vec!).


##### `tests::open_pull_request_falls_back_to_parent_repo_commit_lookup`  (lines 594–642)

```
async fn open_pull_request_falls_back_to_parent_repo_commit_lookup()
```

**Purpose**: Checks that pull-request lookup can still find a PR when branch-based lookup fails, especially in fork workflows. It verifies that the parent repository is searched for the commit-associated PR.

**Data flow**: The test makes `gh pr view` fail, then supplies fake outputs for the current commit, repository parent information, and the GitHub API PR lookup. It calls `open_pull_request` and verifies that the expected open PR is returned.

**Call relations**: This test drives the fallback path inside `open_pull_request`, including commit SHA reading, repository search ordering, and API-output parsing. It also checks that the expected GitHub API endpoint was queried.

*Call graph*: calls 1 internal fn (open_pull_request); 5 external calls (new, assert!, assert_eq!, new, vec!).


##### `tests::status_line_pr_view_parser_requires_open_pr`  (lines 645–662)

```
fn status_line_pr_view_parser_requires_open_pr()
```

**Purpose**: Checks that the branch-view parser accepts open pull requests and rejects merged ones. This keeps inactive PRs out of the status line.

**Data flow**: The test feeds two JSON strings to the parser logic: one with state `OPEN` and one with state `MERGED`. It expects the open one to produce PR data and the merged one to produce nothing.

**Call relations**: This test focuses on the parsing rule used by `pull_request_from_view_output`, without involving fake command execution.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::status_line_pr_fallback_searches_parent_repo_first`  (lines 665–672)

```
fn status_line_pr_fallback_searches_parent_repo_first()
```

**Purpose**: Checks that repository search order prefers the parent repository before the fork. This matters because pull requests from forks usually live on the upstream parent repository.

**Data flow**: The test feeds repository JSON with a current fork and parent repository into the parser and verifies that the result lists the parent first and the fork second.

**Call relations**: This test focuses on `repo_search_order_from_output`, the parser used by `gh_repo_search_order` before commit-based PR lookup.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::response`  (lines 674–683)

```
fn response(argv: &[&str], exit_code: i32, stdout: &str) -> FakeResponse
```

**Purpose**: Builds one fake command response for tests. It keeps test setup short and readable.

**Data flow**: It receives an expected argument list, exit code, and standard output text. It converts those into a `FakeResponse` containing the expected command and a `WorkspaceCommandOutput` with empty standard error.

**Call relations**: The async tests use this helper to populate `FakeRunner` with canned Git and GitHub CLI responses. `FakeRunner::run` later matches real requested commands against these fake responses.

*Call graph*: 1 external calls (new).


##### `tests::FakeRunner::new`  (lines 696–701)

```
fn new(responses: Vec<FakeResponse>) -> Self
```

**Purpose**: Creates a fake workspace command runner for tests. The fake runner lets tests simulate Git and GitHub commands without touching the real machine.

**Data flow**: It receives a list of fake responses. It stores them in a queue protected by a mutex, which is a lock that stops two tasks from editing the same data at once, and creates a second locked list to record commands that were requested.

**Call relations**: Tests call this before exercising the production lookup functions. The created runner is passed anywhere a `WorkspaceCommandExecutor` is expected.

*Call graph*: 2 external calls (new, new).


##### `tests::FakeRunner::saw`  (lines 703–710)

```
fn saw(&self, argv: &[&str]) -> bool
```

**Purpose**: Checks whether a fake runner was asked to run a particular command. Tests use it to prove that expected paths were or were not taken.

**Data flow**: It receives an argument list to look for. It converts that list to owned strings, reads the runner’s recorded commands, and returns whether any recorded command exactly matches.

**Call relations**: The pull-request and branch-diff tests call this after running production logic. It reads the command history written by `tests::FakeRunner::run`.


##### `tests::FakeRunner::run`  (lines 714–737)

```
fn run(
            &self,
            command: WorkspaceCommand,
        ) -> Pin<
            Box<
                dyn Future<Output = Result<WorkspaceCommandOutput, WorkspaceCommandError>>
```

**Purpose**: Implements the workspace command interface for tests by returning prepared outputs instead of running real commands. It also records every requested command.

**Data flow**: It receives a `WorkspaceCommand`. It records the command arguments, searches the queued fake responses for a matching argument list, removes that response, and returns its output asynchronously; if no response matches, the test fails.

**Call relations**: Production functions call this through the `WorkspaceCommandExecutor` trait during tests. This lets tests exercise the real lookup code while fully controlling Git and GitHub CLI results.

*Call graph*: 1 external calls (pin).


### `tui/src/app/agent_status_feed.rs`

`domain_logic` · `UI rendering for /agent status`

When a user asks what sub-agents are doing, the app needs to answer quickly and clearly. A sub-agent may have a long thread of messages, tool calls, commands, and internal steps, so showing everything would be noisy. This file creates a bounded preview: only a few recent useful activity items, shortened to fit the screen.

The main display object is `AgentStatusHistoryCell`. It represents the whole `/agent` status block that appears in the conversation history. It prints a heading, then one entry per sub-agent. If there are no active sub-agents, it says so plainly.

Each sub-agent is represented by `AgentStatusThreadPreview`. It looks backward through that agent's buffered thread events, picks out started or completed items, skips duplicates, ignores items that are not useful for status, and converts the rest into short human-readable summaries. For example, a command becomes something like `$ cargo test`, a file edit becomes `Updated 2 file(s)`, and a web search becomes `Web search: ...`.

The file is careful to keep the preview small: it limits the number of activity items, wraps text to the available terminal width, keeps only the last few lines, and truncates very long text. Like a dashboard widget, it gives enough information to orient the user without trying to be the full record.

#### Function details

##### `AgentStatusHistoryCell::new`  (lines 27–29)

```
fn new(entries: Vec<AgentStatusThreadPreview>) -> Self
```

**Purpose**: Creates a status history cell from a list of sub-agent previews. This is used when the app is ready to show the `/agent` status block in the terminal history.

**Data flow**: It receives prepared `AgentStatusThreadPreview` entries, stores them inside a new `AgentStatusHistoryCell`, and returns that cell. It does not inspect or change the entries.

**Call relations**: The agent picker and tests call this after they have built previews for one or more sub-agents. The returned cell is later asked to produce display lines or plain raw lines.

*Call graph*: called by 3 (agent_status_uses_bounded_buffered_activity, agent_status_uses_reasoning_summaries_only, open_agent_picker).


##### `AgentStatusHistoryCell::display_lines`  (lines 33–58)

```
fn display_lines(&self, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Builds the styled terminal lines that the user sees for the `/agent` status output. It includes the heading, each sub-agent name, and a compact preview of recent activity.

**Data flow**: It receives the available terminal width. It starts with fixed heading lines, checks whether there are any sub-agent entries, and then asks each entry for its title and wrapped preview lines. It returns a list of styled `Line` values ready for the terminal UI.

**Call relations**: This is the main rendering method for the history cell. `raw_lines` calls it when it needs the same content without styling. Inside the method, each `AgentStatusThreadPreview` supplies its title and activity preview, and each preview line is indented before being added.

*Call graph*: called by 1 (raw_lines); 1 external calls (vec!).


##### `AgentStatusHistoryCell::raw_lines`  (lines 60–62)

```
fn raw_lines(&self) -> Vec<Line<'static>>
```

**Purpose**: Produces a plain-text version of the same status output. This is useful wherever the app needs the content without terminal colors or styles.

**Data flow**: It asks `display_lines` for the full-width styled view, then passes those lines through `plain_lines` to strip styling. The result is a list of plain lines with the same words.

**Call relations**: This method is part of the `HistoryCell` behavior. It reuses `display_lines` instead of rebuilding the content, so the styled and plain versions stay consistent.

*Call graph*: calls 2 internal fn (display_lines, plain_lines).


##### `AgentStatusThreadPreview::from_store`  (lines 72–74)

```
fn from_store(agent_path: String, store: &ThreadEventStore) -> Self
```

**Purpose**: Builds a preview for one sub-agent from that agent's buffered event store. It is the normal path when the app has recorded recent activity for the agent.

**Data flow**: It receives the sub-agent path and a `ThreadEventStore`, reads the store's buffered events from newest to oldest, and passes them into the shared event-processing routine. It returns a preview containing the agent path and selected activity summaries.

**Call relations**: The agent picker and tests call this when they want a real preview from stored events. It delegates the actual filtering and summary creation to `from_events`.

*Call graph*: called by 3 (agent_status_uses_bounded_buffered_activity, agent_status_uses_reasoning_summaries_only, open_agent_picker); 1 external calls (from_events).


##### `AgentStatusThreadPreview::empty`  (lines 76–78)

```
fn empty(agent_path: String) -> Self
```

**Purpose**: Creates a preview for a sub-agent that has no recorded recent activity. This lets the UI still show the agent's name with a friendly “No recent activity yet” message.

**Data flow**: It receives the sub-agent path and supplies an empty event iterator to the shared preview-building routine. The returned preview has the path but no activity summaries.

**Call relations**: The agent picker calls this when it needs to display an agent even though there are no buffered events for it. It uses `from_events` so empty previews are shaped the same way as normal previews.

*Call graph*: called by 1 (open_agent_picker); 2 external calls (from_events, empty).


##### `AgentStatusThreadPreview::from_events`  (lines 80–114)

```
fn from_events(
        agent_path: String,
        events: impl Iterator<Item = &'a ThreadBufferedEvent>,
    ) -> Self
```

**Purpose**: Turns a stream of thread events into the short list of activity summaries shown for one sub-agent. It chooses only useful, recent, non-duplicate events.

**Data flow**: It receives an agent path and an iterator of buffered events, usually ordered newest first. For each event, it keeps only started or completed thread items, skips repeated item IDs, asks `activity_summary` to describe useful items, and stops once the preview item limit is reached. Because it read newest first, it reverses the collected summaries before returning the preview so they display in natural order.

**Call relations**: `from_store` and `empty` both feed events into this routine. It is the central filter for preview content, and it hands each eligible thread item to `activity_summary` to turn technical event data into a user-facing phrase.

*Call graph*: calls 1 internal fn (activity_summary); 2 external calls (new, new).


##### `AgentStatusThreadPreview::title_line`  (lines 116–118)

```
fn title_line(&self) -> Line<'static>
```

**Purpose**: Creates the styled line that names a sub-agent in the status output. It makes the path stand out visually so users can tell which activity belongs to which agent.

**Data flow**: It reads the preview's stored `agent_path`, wraps it in backticks, applies terminal styling, and returns one display line starting with a bullet.

**Call relations**: `display_lines` calls this once for each sub-agent entry before adding that entry's activity preview underneath.

*Call graph*: 1 external calls (vec!).


##### `AgentStatusThreadPreview::preview_lines`  (lines 120–132)

```
fn preview_lines(&self, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Formats this sub-agent's activity summaries into a few terminal-sized lines. It keeps the preview readable by wrapping long text and showing only the most recent lines.

**Data flow**: It receives the available text width. It takes each stored activity summary, wraps it to that width, removes blank wrapped lines, dims the result for display, and trims the list down to the configured maximum number of preview lines. It returns those styled lines.

**Call relations**: `display_lines` calls this after the title line for each sub-agent. If it returns no lines, the caller prints a fallback message saying there is no recent activity.


##### `activity_summary`  (lines 135–196)

```
fn activity_summary(item: &ThreadItem) -> Option<String>
```

**Purpose**: Converts one thread item into a short phrase suitable for the status preview. It decides which kinds of activity are useful to show and hides items that would not help the user understand sub-agent progress.

**Data flow**: It receives a `ThreadItem`, checks what kind of item it is, and extracts or builds a human-readable summary. Messages, plans, and reasoning summaries use their text; commands, file changes, tool calls, web searches, image actions, review-mode changes, and context compaction get compact labels. User messages, hook prompts, and sleep items return nothing. Long or messy text is passed through `bounded_summary` or `truncate_text` before being returned.

**Call relations**: `from_events` calls this for each eligible started or completed item. This function is where raw protocol events become the plain phrases later wrapped and displayed by `preview_lines`.

*Call graph*: calls 2 internal fn (bounded_summary, truncate_text); called by 1 (from_events); 1 external calls (format!).


##### `bounded_summary`  (lines 198–202)

```
fn bounded_summary(summary: &str) -> Option<String>
```

**Purpose**: Cleans and limits a summary string so it is safe to place in the small status preview. It prevents very long or whitespace-heavy text from overwhelming the UI.

**Data flow**: It receives a text summary, truncates it to the configured character limit, collapses all whitespace into single spaces, and returns the cleaned string if anything remains. If the cleaned text is empty, it returns no summary.

**Call relations**: `activity_summary` uses this whenever an item's text may be long or irregular. The result is later stored in an `AgentStatusThreadPreview` and eventually displayed in the `/agent` status block.

*Call graph*: calls 1 internal fn (truncate_text); called by 1 (activity_summary).


##### `indent_preview_line`  (lines 204–207)

```
fn indent_preview_line(mut line: Line<'static>) -> Line<'static>
```

**Purpose**: Adds visual indentation to one activity preview line. This makes the activity read as belonging under the sub-agent title, like notes nested under a bullet point.

**Data flow**: It receives a styled terminal line, inserts four leading spaces at the front, and returns the modified line.

**Call relations**: `display_lines` uses this on each line returned by a sub-agent preview. It is the final formatting step before activity lines are added to the full status output.


### `tui/src/bottom_pane/pending_input_preview.rs`

`domain_logic` · `main loop rendering while input is queued`

When a terminal chat app is in the middle of a turn, the user may type more instructions before the system is ready to send them. This file provides the widget that shows those waiting inputs in the bottom pane. Think of it like a waiting-room notice board: it shows what is queued, where it will go next, and which key can change what happens. The widget separates three kinds of waiting text. Pending steers are instructions that should be sent after the next tool or result boundary. Rejected steers are instructions that could not be sent yet but will be retried at the end of the turn. Queued messages are ordinary follow-up messages from the user. The preview renders these sections in that order, with clear headings and small arrow prefixes. It wraps long text to fit the available terminal width and limits each preview to a few lines, adding an ellipsis when there is more. It also shows key hints, such as a key to interrupt and send pending steers immediately, or a key to pull the last queued message back into the composer for editing. If there is nothing to show, or the area is too narrow, it renders nothing. The tests make sure the display stays stable for common cases like wrapping, multiple messages, custom key bindings, and long URL-like text.

#### Function details

##### `PendingInputPreview::new`  (lines 37–45)

```
fn new() -> Self
```

**Purpose**: Creates an empty pending-input preview widget with sensible default key hints. By default, it shows Alt+Up as the edit shortcut and Esc as the interrupt shortcut.

**Data flow**: It starts with no pending steers, no rejected steers, and no queued messages. It builds default key-binding labels, stores them in the new widget, and returns that ready-to-fill widget.

**Call relations**: Other parts of the interface create this widget during setup, and the tests create it before filling it with sample messages. It calls the key-hint helpers that turn raw keys into displayable shortcut labels.

*Call graph*: calls 2 internal fn (alt, plain); called by 14 (new, desired_height_empty, desired_height_one_message, long_url_like_message_does_not_expand_into_wrapped_ellipsis_rows, render_many_line_message, render_more_than_three_messages, render_multiline_pending_steer_uses_single_prefix_and_truncates, render_one_message, render_one_message_with_shift_left_binding, render_one_pending_steer (+4 more)); 1 external calls (new).


##### `PendingInputPreview::set_edit_binding`  (lines 50–52)

```
fn set_edit_binding(&mut self, binding: Option<key_hint::KeyBinding>)
```

**Purpose**: Changes the shortcut shown for editing the last queued message. This matters because some terminals do not pass through every key combination, so the displayed hint must match the shortcut the app actually uses.

**Data flow**: It receives either a new key binding or no binding at all. It stores that value on the widget, so the next render will show the new shortcut or hide the edit hint if the binding is absent.

**Call relations**: A higher-level configuration path calls this when the queued-message edit shortcut changes. This function only changes the label shown here; the caller is responsible for wiring the matching key press elsewhere.

*Call graph*: called by 1 (set_queued_message_edit_binding).


##### `PendingInputPreview::set_interrupt_binding`  (lines 54–56)

```
fn set_interrupt_binding(&mut self, binding: Option<key_hint::KeyBinding>)
```

**Purpose**: Changes the shortcut shown for interrupting the current turn and sending pending steers immediately. This keeps the on-screen instruction accurate when the keymap is customized.

**Data flow**: It receives either a key binding or no binding. It saves that choice on the widget, and later rendering uses it in the pending-steers heading or leaves the shortcut text out.

**Call relations**: The app's keymap setup calls this when it decides which interrupt key is active. The rendering path later reads the stored binding inside the heading for pending steers.

*Call graph*: called by 1 (set_keymap_bindings).


##### `PendingInputPreview::push_truncated_preview_lines`  (lines 58–68)

```
fn push_truncated_preview_lines(
        lines: &mut Vec<Line<'static>>,
        wrapped: Vec<Line<'static>>,
        overflow_line: Line<'static>,
    )
```

**Purpose**: Adds a wrapped message preview to the list of lines, but keeps it short. It prevents one long message from taking over the whole bottom pane.

**Data flow**: It receives the growing list of display lines, the already-wrapped lines for one message, and an overflow line such as an ellipsis. It appends at most three preview lines; if there were more than three, it appends the overflow marker after them.

**Call relations**: The main rendering builder uses this for pending steers, rejected steers, and queued messages. It sits after text wrapping: wrapping decides how the text fits the width, and this helper decides how much of that wrapped text to show.


##### `PendingInputPreview::push_section_header`  (lines 70–77)

```
fn push_section_header(lines: &mut Vec<Line<'static>>, width: u16, header: Line<'static>)
```

**Purpose**: Adds a bullet-style section heading, wrapped to fit the terminal width. This gives each group of waiting inputs a readable label.

**Data flow**: It receives the display-line list, the available width, and the heading text. It prefixes the heading with a dim bullet, wraps it with an indent for continuation lines, and appends the resulting lines.

**Call relations**: The main renderer calls this before each non-empty section. It relies on the shared adaptive wrapping helper so headings behave well in narrow terminals.

*Call graph*: calls 2 internal fn (new, adaptive_wrap_lines); 3 external calls (from, once, vec!).


##### `PendingInputPreview::as_renderable`  (lines 79–168)

```
fn as_renderable(&self, width: u16) -> Box<dyn Renderable>
```

**Purpose**: Builds the actual thing that can be drawn on screen from the widget's current pending and queued text. This is the central formatting step for the preview.

**Data flow**: It reads the widget's three message lists, the stored key bindings, and the available width. If there is nothing useful to show, or the width is too small, it returns an empty renderable. Otherwise, it creates section headings, wraps each message with indentation, truncates long previews, adds blank lines between sections, and optionally adds the edit hint at the bottom. It returns a paragraph-like renderable ready to draw or measure.

**Call relations**: Both the screen drawing function and the height-measuring function call this, so they use the exact same layout rules. Inside, it hands text to the section-header and truncation helpers, plus the shared wrapping code, before returning a renderable object.

*Call graph*: calls 2 internal fn (new, adaptive_wrap_lines); called by 2 (desired_height, render); 6 external calls (new, from, new, push_section_header, push_truncated_preview_lines, vec!).


##### `PendingInputPreview::render`  (lines 172–178)

```
fn render(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Draws the pending-input preview into a rectangular area of the terminal screen. If the area has no space, it does nothing.

**Data flow**: It receives a screen rectangle and a mutable terminal buffer. It checks whether the rectangle is empty; if not, it builds the formatted renderable for that width and asks it to paint itself into the buffer.

**Call relations**: The terminal UI calls this when it redraws the bottom pane. It delegates the formatting work to `PendingInputPreview::as_renderable`, then uses the standard renderable interface to write into the buffer.

*Call graph*: calls 1 internal fn (as_renderable); 1 external calls (is_empty).


##### `PendingInputPreview::desired_height`  (lines 180–182)

```
fn desired_height(&self, width: u16) -> u16
```

**Purpose**: Reports how many terminal rows this preview wants for a given width. The layout system uses this before drawing so it can reserve enough vertical space.

**Data flow**: It receives an available width. It builds the same renderable that would be drawn at that width, asks it for its desired height, and returns that row count.

**Call relations**: The surrounding layout calls this while planning the screen. It shares `PendingInputPreview::as_renderable` with `render`, which keeps measuring and drawing consistent.

*Call graph*: calls 1 internal fn (as_renderable).


##### `tests::desired_height_empty`  (lines 192–195)

```
fn desired_height_empty()
```

**Purpose**: Checks that an empty preview asks for no screen height. This protects the interface from leaving blank space when there is nothing queued.

**Data flow**: It creates a fresh preview with no messages, asks for its height at a normal width, and verifies the answer is zero.

**Call relations**: The test runner calls this during automated tests. It exercises `PendingInputPreview::new` and `PendingInputPreview::desired_height` together.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `tests::desired_height_one_message`  (lines 198–202)

```
fn desired_height_one_message()
```

**Purpose**: Checks the height calculation for a simple queued message. It confirms that the widget reserves room for a header, the message, and the edit hint.

**Data flow**: It creates a preview, adds one queued message, asks for the desired height, and compares the result with the expected row count.

**Call relations**: The test runner uses this to catch layout regressions. It starts from `PendingInputPreview::new`, changes the public queued-message list, and then uses the normal height path.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `tests::render_one_message`  (lines 205–213)

```
fn render_one_message()
```

**Purpose**: Captures what the preview looks like with one normal queued message. This makes accidental visual changes easy to spot.

**Data flow**: It creates a preview, adds one queued message, calculates the needed height, creates an empty buffer, renders into it, and compares the buffer to a saved snapshot.

**Call relations**: The test runner calls this as a snapshot test. It follows the same measure-then-render path that the real terminal UI would use.

*Call graph*: calls 1 internal fn (new); 3 external calls (empty, new, assert_snapshot!).


##### `tests::render_one_message_with_shift_left_binding`  (lines 216–228)

```
fn render_one_message_with_shift_left_binding()
```

**Purpose**: Checks that a custom edit shortcut appears in the queued-message hint. This protects the configurable-key behavior.

**Data flow**: It creates a preview, adds one queued message, sets the edit binding to Shift+Left, renders the widget into a buffer, and compares the result with a saved snapshot.

**Call relations**: The test runner calls this to cover customized bindings. It uses `PendingInputPreview::new`, the key-hint helper for Shift, and `PendingInputPreview::set_edit_binding` before the normal render path.

*Call graph*: calls 2 internal fn (new, shift); 3 external calls (empty, new, assert_snapshot!).


##### `tests::render_two_messages`  (lines 231–242)

```
fn render_two_messages()
```

**Purpose**: Checks the visual output when two queued messages are waiting. It ensures both messages appear in order under the same section.

**Data flow**: It creates a preview, adds two queued messages, measures the height, renders into a buffer, and checks the output against a snapshot.

**Call relations**: The test runner calls this as part of the rendering test suite. It exercises the repeated-message part of `PendingInputPreview::as_renderable`.

*Call graph*: calls 1 internal fn (new); 3 external calls (empty, new, assert_snapshot!).


##### `tests::render_more_than_three_messages`  (lines 245–262)

```
fn render_more_than_three_messages()
```

**Purpose**: Checks that several queued messages render correctly together. Despite the name, it is testing multiple messages, not a global limit on the number of messages.

**Data flow**: It creates a preview, adds four queued messages, measures the required height, renders the widget, and compares the buffer with a saved snapshot.

**Call relations**: The test runner uses this to protect the multi-message layout. It drives the same render path that displays each queued message one after another.

*Call graph*: calls 1 internal fn (new); 3 external calls (empty, new, assert_snapshot!).


##### `tests::render_wrapped_message`  (lines 265–278)

```
fn render_wrapped_message()
```

**Purpose**: Checks that a long queued message wraps neatly instead of overflowing the terminal width. This keeps the preview readable in ordinary terminal sizes.

**Data flow**: It creates a preview with one longer message and another shorter message, renders at a fixed width, and compares the final buffer with a snapshot.

**Call relations**: The test runner calls this to exercise the adaptive wrapping used by `PendingInputPreview::as_renderable`. It confirms the wrapping and indentation choices stay stable.

*Call graph*: calls 1 internal fn (new); 3 external calls (empty, new, assert_snapshot!).


##### `tests::render_many_line_message`  (lines 281–291)

```
fn render_many_line_message()
```

**Purpose**: Checks how the preview shows a queued message that already contains several lines. It verifies that multiline user input is shown as a compact preview.

**Data flow**: It creates a preview, adds one queued message containing line breaks, measures, renders, and checks the snapshot output.

**Call relations**: The test runner calls this to cover the path where `as_renderable` splits message text into lines before wrapping and truncating it.

*Call graph*: calls 1 internal fn (new); 3 external calls (empty, new, assert_snapshot!).


##### `tests::long_url_like_message_does_not_expand_into_wrapped_ellipsis_rows`  (lines 294–323)

```
fn long_url_like_message_does_not_expand_into_wrapped_ellipsis_rows()
```

**Purpose**: Checks a special case for very long URL-like text. The goal is to avoid wasting rows on an ellipsis caused only by one long unbroken token.

**Data flow**: It creates a preview with one very long URL-like message, measures its height at a narrow width, and verifies the height is only three rows. It then renders the preview, reads the rendered rows back from the buffer, and asserts that no ellipsis row appears.

**Call relations**: The test runner calls this to guard against a subtle wrapping problem. It exercises `PendingInputPreview::new`, height calculation, rendering, and direct inspection of the buffer contents.

*Call graph*: calls 1 internal fn (new); 4 external calls (empty, new, assert!, assert_eq!).


##### `tests::render_one_pending_steer`  (lines 326–334)

```
fn render_one_pending_steer()
```

**Purpose**: Checks the display for one pending steering message. It makes sure the special heading and interrupt hint appear correctly.

**Data flow**: It creates a preview, adds one pending steer, measures the height, renders into a buffer, and compares the output with a snapshot.

**Call relations**: The test runner calls this to cover the pending-steers section of `PendingInputPreview::as_renderable`, separate from ordinary queued messages.

*Call graph*: calls 1 internal fn (new); 3 external calls (empty, new, assert_snapshot!).


##### `tests::render_one_pending_steer_with_remapped_interrupt_binding`  (lines 337–349)

```
fn render_one_pending_steer_with_remapped_interrupt_binding()
```

**Purpose**: Checks that a custom interrupt shortcut is shown for pending steers. This ensures the preview stays accurate when the keymap changes.

**Data flow**: It creates a preview, adds a pending steer, sets the interrupt binding to F12, renders into a buffer, and compares the result with a snapshot.

**Call relations**: The test runner calls this to cover `PendingInputPreview::set_interrupt_binding`. It uses the plain-key hint helper before sending the widget through the normal render path.

*Call graph*: calls 2 internal fn (new, plain); 4 external calls (empty, F, new, assert_snapshot!).


##### `tests::render_pending_steers_above_queued_messages`  (lines 352–372)

```
fn render_pending_steers_above_queued_messages()
```

**Purpose**: Checks the full ordering when all kinds of waiting input are present. Pending steers should appear first, rejected steers next, and ordinary queued messages last.

**Data flow**: It creates a preview, fills all three message lists with sample text, measures, renders, and compares the buffer with a snapshot.

**Call relations**: The test runner calls this as an end-to-end layout check for this widget. It exercises the section ordering and blank-line separation inside `PendingInputPreview::as_renderable`.

*Call graph*: calls 1 internal fn (new); 3 external calls (empty, new, assert_snapshot!).


##### `tests::render_multiline_pending_steer_uses_single_prefix_and_truncates`  (lines 375–388)

```
fn render_multiline_pending_steer_uses_single_prefix_and_truncates()
```

**Purpose**: Checks that a multiline pending steer is presented cleanly and shortened when needed. It protects the rule that one message preview should not grow without limit.

**Data flow**: It creates a preview with a pending steer containing four lines, measures and renders it, then compares the result with a saved snapshot.

**Call relations**: The test runner calls this to cover multiline pending-steer formatting. It specifically exercises the combination of wrapping, indentation, and `PendingInputPreview::push_truncated_preview_lines`.

*Call graph*: calls 1 internal fn (new); 3 external calls (empty, new, assert_snapshot!).


### `tui/src/bottom_pane/status_line_style.rs`

`domain_logic` · `rendering the bottom status line`

The bottom status line is the small footer that shows useful bits of context, such as the model name, current folder, Git branch, token usage, limits, or task progress. This file decides how those pieces should look when they are drawn in the terminal. Without it, the footer would either be plain text or each caller would need to know its own coloring rules, which would make the interface less consistent.

The file groups each kind of status-line item into a broader “accent,” such as model, path, branch, usage, or progress. Think of this like sorting labels into color families before painting them. If theme colors are enabled, it asks the syntax-highlighting theme for a suitable foreground color using familiar theme “scopes” such as strings, keywords, or numbers. If the theme cannot provide one, it uses simple fallback colors like cyan, green, or magenta.

Before using theme colors, it softens them. Very bright terminal colors can distract in a footer, so the code reduces the punch of RGB colors and maps light named colors to calmer versions. Items are joined with a dim separator, and pull request numbers get underlined so they read like links. If there are no items, no line is produced.

#### Function details

##### `StatusLineAccent::for_item`  (lines 31–55)

```
fn for_item(item: StatusLineItem) -> Self
```

**Purpose**: This chooses the broad visual category for one status-line item. For example, model-related items become the model accent, folder paths become the path accent, and token counts become the usage accent.

**Data flow**: It receives a specific status-line item, such as a Git branch or context usage string. It matches that item to a small set of color families. It returns the accent that later code can use to pick a theme color or fallback color.

**Call relations**: When the status line is being built, status_line_from_segments_with_resolver calls this first for each item that needs themed coloring. The returned accent becomes the bridge between raw footer content and the styling rules in this file.

*Call graph*: called by 1 (status_line_from_segments_with_resolver).


##### `StatusLineAccent::scopes`  (lines 57–70)

```
fn scopes(self) -> &'static [&'static str]
```

**Purpose**: This gives the theme lookup a short list of syntax-highlighting categories to try for a given accent. Those categories are names a theme may already know how to color, such as strings, keywords, or numbers.

**Data flow**: It receives an accent such as Path or Usage. It returns a fixed list of theme scope names that best match that kind of information. Nothing is changed; the list is only used as a hint for color selection.

**Call relations**: This supports the public status-line builder by translating footer concepts into theme concepts. It lets the footer reuse the same color language as the rest of the terminal UI instead of inventing unrelated color names.


##### `StatusLineAccent::fallback_style`  (lines 72–78)

```
fn fallback_style(self) -> Style
```

**Purpose**: This supplies a simple built-in color when the active theme does not provide one. It keeps the status line colored and readable even with incomplete or missing theme data.

**Data flow**: It receives an accent and chooses a default terminal style for it. Related accents share fallback colors: for example, model-like accents use cyan, path and usage-like accents use green, and branch-like accents use magenta. The result is a Style value ready to apply to text.

**Call relations**: It is part of the same styling path that builds a status line from segments. If a theme lookup does not produce a style, this fallback keeps status_line_from_segments_with_resolver from leaving themed items unstyled.

*Call graph*: 1 external calls (default).


##### `status_line_from_segments`  (lines 81–91)

```
fn status_line_from_segments(
    segments: I,
    use_theme_colors: bool,
) -> Option<Line<'static>>
```

**Purpose**: This is the normal entry point for making a styled footer line from status-line pieces. Callers give it the items and their text, and it returns a terminal line ready to render.

**Data flow**: It receives an ordered collection of pairs: what kind of item each piece is, and the text to show for it. It also receives a flag saying whether theme colors should be used. It passes that information to the more flexible helper, along with the real theme-color lookup, and returns either a completed Line or nothing if there were no pieces.

**Call relations**: This function is the simple public-facing wrapper. It hands the actual assembly work to status_line_from_segments_with_resolver so production code can use the real theme resolver while tests can provide fake resolvers.

*Call graph*: calls 1 internal fn (status_line_from_segments_with_resolver).


##### `status_line_from_segments_with_resolver`  (lines 93–124)

```
fn status_line_from_segments_with_resolver(
    segments: I,
    use_theme_colors: bool,
    theme_style_for_accent: F,
) -> Option<Line<'static>>
```

**Purpose**: This assembles the actual status line. It adds separators, chooses styles for each piece, softens theme colors, underlines pull request numbers, and returns the final line.

**Data flow**: It receives ordered status-line segments, a choice about whether to use theme colors, and a function that can turn an accent into a theme style. It walks through the segments in order, inserts a dim “ · ” separator between them, styles each text span, and collects the spans into one Line. If the input has no segments, it returns None instead of an empty footer.

**Call relations**: The normal wrapper status_line_from_segments calls this during real rendering. The tests call it directly because they can plug in controlled theme results and check exactly how the line is built. Inside the flow, it asks StatusLineAccent::for_item for the right accent and passes theme-derived styles through soften_status_line_style before applying them.

*Call graph*: calls 2 internal fn (for_item, soften_status_line_style); called by 6 (status_line_from_segments, pull_request_number_uses_link_style, status_line_segments_can_disable_theme_colors, status_line_segments_dim_separators_and_use_theme_styles_first, status_line_segments_preserve_order_and_plain_text, status_line_segments_soften_rgb_theme_styles_without_dimming_text); 3 external calls (styled, default, new).


##### `soften_status_line_style`  (lines 126–131)

```
fn soften_status_line_style(mut style: Style) -> Style
```

**Purpose**: This makes a style gentler if it has a foreground color. It prevents theme colors from looking too loud in the small footer area.

**Data flow**: It receives a Style value. If the style has a foreground color, it replaces that color with a softened version; if not, it leaves the style alone. It returns the adjusted Style.

**Call relations**: status_line_from_segments_with_resolver calls this after choosing a theme or fallback style. It delegates the color-specific work to soften_status_line_color, so the rest of the status-line builder does not need to know the color math.

*Call graph*: calls 1 internal fn (soften_status_line_color); called by 1 (status_line_from_segments_with_resolver).


##### `soften_status_line_color`  (lines 134–163)

```
fn soften_status_line_color(color: Color) -> Color
```

**Purpose**: This tones down individual colors for use in the footer. It treats full RGB colors carefully and maps bright named colors to calmer named colors.

**Data flow**: It receives one terminal color. For RGB colors, it calculates the color’s brightness, then softens each red, green, and blue channel toward that brightness. For named light colors like LightRed or White, it returns a darker equivalent such as Red or Gray. For already-muted colors, it returns the original color.

**Call relations**: soften_status_line_style calls this whenever a style has a foreground color. This function uses weighted_luma to estimate perceived brightness and soften_rgb_channel to adjust each RGB component.

*Call graph*: calls 2 internal fn (soften_rgb_channel, weighted_luma); called by 1 (soften_status_line_style); 1 external calls (Rgb).


##### `weighted_luma`  (lines 165–167)

```
fn weighted_luma(r: u8, g: u8, b: u8) -> u16
```

**Purpose**: This estimates how bright an RGB color looks to the human eye. Green counts more than red or blue because our eyes perceive green as brighter.

**Data flow**: It receives red, green, and blue channel values from 0 to 255. It combines them using weighted numbers and returns a single brightness value. That value becomes the neutral target used when softening the color.

**Call relations**: soften_status_line_color calls this for RGB colors before adjusting their channels. It gives soften_rgb_channel the brightness reference needed to reduce saturation without simply making the color gray.

*Call graph*: called by 1 (soften_status_line_color); 1 external calls (from).


##### `soften_rgb_channel`  (lines 169–177)

```
fn soften_rgb_channel(channel: u8, luma: u16) -> u8
```

**Purpose**: This adjusts one red, green, or blue channel so the overall color becomes less intense. It is the small arithmetic step that makes theme colors calmer in the footer.

**Data flow**: It receives one color channel and the color’s overall brightness. It blends the channel slightly toward that brightness using the file’s saturation setting, then applies the brightness setting. It returns the adjusted channel as a byte-sized color value.

**Call relations**: soften_status_line_color calls this three times for RGB colors: once each for red, green, and blue. Together, those three adjusted channels form the softened RGB color used in the status line.

*Call graph*: called by 1 (soften_status_line_color); 1 external calls (from).


##### `tests::line_text`  (lines 185–190)

```
fn line_text(line: &Line<'static>) -> String
```

**Purpose**: This test helper extracts the visible text from a styled terminal line. It lets tests compare the plain words without worrying about color or underline data.

**Data flow**: It receives a Line made of spans. It reads each span’s text content, joins those pieces together, and returns a plain String. It does not change the line.

**Call relations**: The tests use this helper when they need to prove that styling did not alter the order or text of the status-line content. It keeps those checks focused on the visible string.


##### `tests::status_line_segments_preserve_order_and_plain_text`  (lines 193–212)

```
fn status_line_segments_preserve_order_and_plain_text()
```

**Purpose**: This test proves that several status-line pieces are kept in the same order and joined with the expected separator. It also checks that fallback colors are applied when the theme resolver gives no color.

**Data flow**: It builds a sample line with model, path, and branch text. The theme resolver returns no style, so the status-line code must use fallback colors. The test checks the final plain text and confirms the expected colors appear on the right spans.

**Call relations**: This test calls status_line_from_segments_with_resolver directly so it can control the theme lookup. It verifies the basic assembly behavior that production callers rely on through status_line_from_segments.

*Call graph*: calls 1 internal fn (status_line_from_segments_with_resolver); 2 external calls (assert!, assert_eq!).


##### `tests::status_line_segments_dim_separators_and_use_theme_styles_first`  (lines 215–234)

```
fn status_line_segments_dim_separators_and_use_theme_styles_first()
```

**Purpose**: This test checks two visual rules: separators should be dim, and theme colors should win over fallback colors when available.

**Data flow**: It builds a line with a model item and a usage item. The fake theme resolver supplies a red style for the model accent only. The test confirms the model uses that theme color, the separator is dim, and the usage item falls back to its default green.

**Call relations**: This test exercises status_line_from_segments_with_resolver with a custom resolver. It documents the priority order: theme style first, fallback style second, and dim separators between items.

*Call graph*: calls 1 internal fn (status_line_from_segments_with_resolver); 2 external calls (assert!, assert_eq!).


##### `tests::status_line_segments_soften_rgb_theme_styles_without_dimming_text`  (lines 238–248)

```
fn status_line_segments_soften_rgb_theme_styles_without_dimming_text()
```

**Purpose**: This test makes sure RGB theme colors are softened but the text itself is not dimmed. The footer should look calm without becoming faded.

**Data flow**: It asks the builder to style a model item using a bright RGB red from the fake theme resolver. The status-line code softens that red into a less intense RGB value. The test checks the exact softened color and confirms the dim modifier was not added to the item text.

**Call relations**: This test calls status_line_from_segments_with_resolver to drive the same style path used during rendering. It specifically protects the behavior supplied by soften_status_line_style and soften_status_line_color.

*Call graph*: calls 1 internal fn (status_line_from_segments_with_resolver); 2 external calls (assert!, assert_eq!).


##### `tests::status_line_segments_can_disable_theme_colors`  (lines 251–268)

```
fn status_line_segments_can_disable_theme_colors()
```

**Purpose**: This test proves that callers can turn off theme colors entirely. When that happens, all text becomes simple dim footer text instead of colored theme text.

**Data flow**: It builds a line while passing false for theme-color use, even though the fake resolver could provide a red style. The builder ignores the resolver, uses no foreground color, and adds dim styling to both content spans and the separator. The test checks the text and those style choices.

**Call relations**: This test calls status_line_from_segments_with_resolver with theme colors disabled. It protects the plain, low-emphasis mode used when colored status-line accents are not wanted.

*Call graph*: calls 1 internal fn (status_line_from_segments_with_resolver); 2 external calls (assert!, assert_eq!).


##### `tests::pull_request_number_uses_link_style`  (lines 271–287)

```
fn pull_request_number_uses_link_style()
```

**Purpose**: This test checks the special styling for pull request numbers. They should be underlined so they look like a link or clickable reference.

**Data flow**: It builds a line containing only a pull request number while theme colors are disabled. The normal disabled-theme style makes the text dim, and the pull request rule adds underline. The test confirms both details are present.

**Call relations**: This test calls status_line_from_segments_with_resolver directly to isolate the pull request case. It protects the special-case underline rule inside the status-line assembly flow.

*Call graph*: calls 1 internal fn (status_line_from_segments_with_resolver); 2 external calls (assert!, assert_eq!).


##### `tests::status_line_segments_return_none_when_empty`  (lines 290–299)

```
fn status_line_segments_return_none_when_empty()
```

**Purpose**: This test confirms that an empty set of status-line pieces produces no line at all. That avoids drawing a blank footer object when there is nothing useful to show.

**Data flow**: It passes an empty list of segments into the status-line builder. Since no spans are created, the result should be None. The test compares that result with the expected empty outcome.

**Call relations**: This test protects the final decision in the status-line assembly path: only create a Line when at least one visible item exists. Render code can use that None result to skip drawing the footer content.

*Call graph*: 1 external calls (assert_eq!).


### `tui/src/chatwidget/goal_status.rs`

`domain_logic` · `main loop / UI refresh`

A “thread goal” is the app’s record of what the assistant is trying to accomplish in a chat thread, plus progress such as tokens used or time spent. This file is the translator between that server-side record and the compact status line in the terminal interface. Without it, the UI would either show raw goal data or fail to show useful progress like “12.5K / 50K” or “2m”.

The main wrapper, GoalStatusState, stores the latest goal snapshot and the time when the UI observed it. That observed time matters because an active goal keeps accumulating time after the last server update. When the UI asks for an indicator, the file can add the elapsed time from the current active turn, so the displayed time keeps moving instead of freezing.

The core conversion happens in goal_status_indicator_from_app_goal. It looks at the goal’s status and chooses the matching UI indicator. Active and complete goals may include usage text. If a token budget exists, token counts are preferred. If there is no token budget, elapsed time is shown instead. This is like a dashboard choosing the most useful gauge: if there is a fuel limit, show fuel used; otherwise, show how long the engine has been running.

#### Function details

##### `GoalStatusState::new`  (lines 18–20)

```
fn new(goal: AppThreadGoal, observed_at: Instant) -> Self
```

**Purpose**: Creates a stored UI-side snapshot of a thread goal and records when that snapshot was seen. This gives later UI refreshes a fixed reference point for estimating additional elapsed time.

**Data flow**: It receives a goal from the app server and an observation time. It stores both together in a new GoalStatusState and returns that state without changing the goal data.

**Call relations**: When the chat widget receives a goal update, on_thread_goal_updated uses this constructor to keep the newest goal state. The test helper tests::active_goal_state also uses it to build sample active goals for time-related tests.

*Call graph*: called by 2 (active_goal_state, on_thread_goal_updated).


##### `GoalStatusState::is_active`  (lines 22–24)

```
fn is_active(&self) -> bool
```

**Purpose**: Answers the simple question: is this stored goal currently active? Other UI code can use this to decide whether goal progress should be treated as still running.

**Data flow**: It reads the stored goal’s status field. If the status is Active it returns true; otherwise it returns false. It does not change anything.

**Call relations**: This is a small query method on GoalStatusState. The provided call graph does not show a caller, but it exists so surrounding chat UI code can check active state without knowing the exact server status type.


##### `GoalStatusState::indicator`  (lines 26–42)

```
fn indicator(
        &self,
        now: Instant,
        active_turn_started_at: Option<Instant>,
    ) -> Option<GoalStatusIndicator>
```

**Purpose**: Builds the current status-line indicator for the stored goal. For active goals, it can add time that has passed since the last server observation so the UI display stays current.

**Data flow**: It takes the current time and, optionally, the time when the current active turn began. It copies the stored goal, and if the copied goal is active, it adds only the safe amount of newly elapsed time. Then it passes the adjusted goal into the conversion function and returns the resulting optional UI indicator.

**Call relations**: The chat UI calls this when it needs to draw or refresh the goal status. After adjusting active elapsed time, it hands the goal to goal_status_indicator_from_app_goal, which chooses the final indicator shape and usage text.

*Call graph*: calls 1 internal fn (goal_status_indicator_from_app_goal); 4 external calls (clone, max, saturating_duration_since, try_from).


##### `goal_status_indicator_from_app_goal`  (lines 45–66)

```
fn goal_status_indicator_from_app_goal(
    goal: &AppThreadGoal,
) -> Option<GoalStatusIndicator>
```

**Purpose**: Converts the app server’s goal status into the terminal UI’s compact GoalStatusIndicator. This is the central mapping between backend goal states and what the user sees.

**Data flow**: It receives a goal record. It reads the status, token budget, tokens used, and time used. Depending on the status, it returns the matching indicator, sometimes with a short usage string produced by one of the helper functions.

**Call relations**: GoalStatusState::indicator calls this after any needed elapsed-time adjustment. This function then delegates the wording of usage text to active_goal_usage, stopped_goal_budget_usage, or completed_goal_usage depending on the kind of status being shown.

*Call graph*: calls 3 internal fn (active_goal_usage, completed_goal_usage, stopped_goal_budget_usage); called by 1 (indicator).


##### `active_goal_usage`  (lines 68–82)

```
fn active_goal_usage(
    token_budget: Option<i64>,
    tokens_used: i64,
    time_used_seconds: i64,
) -> Option<String>
```

**Purpose**: Creates the short usage text for a goal that is still running. It chooses token progress when a token budget exists, otherwise it shows elapsed time.

**Data flow**: It receives an optional token budget, the number of tokens already used, and elapsed seconds. If there is a budget, it formats used tokens and total budget as a compact fraction. If there is no budget, it converts elapsed seconds into a friendly time label. It returns the text wrapped in Some.

**Call relations**: goal_status_indicator_from_app_goal calls this when building an Active indicator. It relies on format_tokens_compact for short token numbers and format_goal_elapsed_seconds for readable time.

*Call graph*: calls 1 internal fn (format_goal_elapsed_seconds); called by 1 (goal_status_indicator_from_app_goal); 1 external calls (format!).


##### `stopped_goal_budget_usage`  (lines 84–92)

```
fn stopped_goal_budget_usage(token_budget: Option<i64>, tokens_used: i64) -> Option<String>
```

**Purpose**: Creates usage text for a goal that stopped because it hit a budget limit. It only shows text when there was actually a token budget to compare against.

**Data flow**: It receives an optional token budget and the tokens used. If a budget exists, it formats both numbers into a string such as used-over-budget plus the word “tokens”. If no budget exists, it returns None.

**Call relations**: goal_status_indicator_from_app_goal calls this for BudgetLimited goals. This keeps budget-limit indicators from showing misleading usage text when there was no token budget.

*Call graph*: called by 1 (goal_status_indicator_from_app_goal).


##### `completed_goal_usage`  (lines 94–104)

```
fn completed_goal_usage(
    token_budget: Option<i64>,
    tokens_used: i64,
    time_used_seconds: i64,
) -> String
```

**Purpose**: Creates the short final usage text for a completed goal. It shows token usage when the goal had a token budget, otherwise it shows total elapsed time.

**Data flow**: It receives an optional token budget, tokens used, and elapsed seconds. If a budget was present, it returns a compact token count. If not, it returns a friendly elapsed-time string.

**Call relations**: goal_status_indicator_from_app_goal calls this when building a Complete indicator. It uses the same display helpers as active_goal_usage so completed and active goals are formatted consistently.

*Call graph*: calls 1 internal fn (format_goal_elapsed_seconds); called by 1 (goal_status_indicator_from_app_goal); 1 external calls (format!).


##### `tests::active_goal_usage_prefers_token_budget`  (lines 119–128)

```
fn active_goal_usage_prefers_token_budget()
```

**Purpose**: Checks that an active goal with a token budget shows token progress instead of time. This protects the UI rule that budgets are the most important progress measure when present.

**Data flow**: It gives active_goal_usage a budget, used-token count, and elapsed time. It compares the result with the expected compact token fraction.

**Call relations**: This test directly exercises active_goal_usage. It uses an assertion to catch changes that would make active budgeted goals display time instead of token progress.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::active_goal_usage_reports_time_without_budget`  (lines 131–139)

```
fn active_goal_usage_reports_time_without_budget()
```

**Purpose**: Checks that an active goal without a token budget shows elapsed time. This ensures the user still gets useful progress information even when there is no token limit.

**Data flow**: It calls active_goal_usage with no budget, a token count, and 120 seconds. It expects the output to be the friendly time label “2m”.

**Call relations**: This test directly exercises active_goal_usage and confirms the no-budget branch uses time formatting.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::stopped_goal_budget_usage_reports_budgeted_tokens`  (lines 142–147)

```
fn stopped_goal_budget_usage_reports_budgeted_tokens()
```

**Purpose**: Checks that a budget-limited goal displays used tokens compared with the budget. This confirms the UI can explain why the goal stopped.

**Data flow**: It gives stopped_goal_budget_usage a budget and a used-token count above that budget. It expects a compact string showing both values and the word “tokens”.

**Call relations**: This test directly exercises stopped_goal_budget_usage, the helper used by the BudgetLimited indicator path.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::stopped_goal_budget_usage_omits_unbudgeted_usage`  (lines 150–155)

```
fn stopped_goal_budget_usage_omits_unbudgeted_usage()
```

**Purpose**: Checks that the budget-limit usage helper returns no text when there is no token budget. This prevents the UI from showing a budget comparison that would not make sense.

**Data flow**: It calls stopped_goal_budget_usage with no budget and a token count. It expects None as the result.

**Call relations**: This test directly exercises stopped_goal_budget_usage and protects the no-budget behavior used by goal_status_indicator_from_app_goal.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::completed_goal_usage_reports_tokens_when_budgeted`  (lines 158–167)

```
fn completed_goal_usage_reports_tokens_when_budgeted()
```

**Purpose**: Checks that a completed goal with a token budget reports final token usage. This keeps the completed status focused on budget-related progress when a budget existed.

**Data flow**: It passes completed_goal_usage a budget, used tokens, and elapsed time. It expects the output to be a compact token count, not a time label.

**Call relations**: This test directly exercises completed_goal_usage, which goal_status_indicator_from_app_goal uses for Complete indicators.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::completed_goal_usage_reports_time_without_token_budget`  (lines 170–178)

```
fn completed_goal_usage_reports_time_without_token_budget()
```

**Purpose**: Checks that a completed goal without a token budget reports elapsed time. This ensures completed unbudgeted goals still summarize the work in a useful way.

**Data flow**: It calls completed_goal_usage with no budget, a token count, and a long elapsed time. It expects the elapsed time to be formatted as hours and minutes.

**Call relations**: This test directly exercises completed_goal_usage and confirms its no-budget path uses the elapsed-time formatter.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::active_goal_status_includes_current_turn_elapsed_time`  (lines 181–194)

```
fn active_goal_status_includes_current_turn_elapsed_time()
```

**Purpose**: Checks that an active goal’s displayed time includes time from the current turn since the goal snapshot was observed. This protects the live-updating behavior of the status line.

**Data flow**: It records a current instant, builds an active goal state that already has 60 seconds used, then asks for an indicator 60 seconds later. It expects the indicator to show 2 minutes total.

**Call relations**: This test uses tests::active_goal_state to build the sample state, then calls GoalStatusState::indicator. It confirms that indicator adds current-turn elapsed time before handing off to the status conversion logic.

*Call graph*: 3 external calls (now, assert_eq!, active_goal_state).


##### `tests::active_goal_status_does_not_count_idle_time_before_turn_start`  (lines 197–211)

```
fn active_goal_status_does_not_count_idle_time_before_turn_start()
```

**Purpose**: Checks that the UI does not count idle time before an active turn actually begins. This prevents the displayed goal time from jumping upward just because the goal snapshot was old.

**Data flow**: It builds an active goal observed earlier, then sets the active turn start later. When it asks for an indicator after one minute of real active-turn time, it expects only that minute to be added to the existing minute.

**Call relations**: This test uses tests::active_goal_state and then calls GoalStatusState::indicator. It protects the logic that uses the later of the observation time and active-turn start time as the baseline.

*Call graph*: 4 external calls (from_secs, now, assert_eq!, active_goal_state).


##### `tests::active_goal_state`  (lines 213–227)

```
fn active_goal_state(observed_at: Instant, time_used_seconds: i64) -> GoalStatusState
```

**Purpose**: Builds a sample active GoalStatusState for the tests. It keeps the test setup short and consistent.

**Data flow**: It receives an observation time and an initial elapsed-time value. It creates a thread goal with Active status, no token budget, and the supplied time, then wraps it with GoalStatusState::new and returns it.

**Call relations**: The time-related tests call this helper before checking GoalStatusState::indicator. It hands off to GoalStatusState::new so the tests use the same constructor as production code.

*Call graph*: calls 1 internal fn (new).


### `tui/src/chatwidget/rate_limits.rs`

`domain_logic` · `request handling and UI updates`

Rate limits are the system’s way of saying “you can only use so much within this time window.” Without this file, the chat UI would still receive limit information, but users would get much less guidance about what it means or what to do next.

The file has three main jobs. First, it watches usage percentages and shows warnings only when the user crosses meaningful milestones, such as 75%, 90%, or 95%. It remembers which warnings have already been shown, so the user is not nagged repeatedly for the same threshold.

Second, it stores incoming rate-limit snapshots in the ChatWidget. A snapshot is a point-in-time report of current usage, credit status, plan type, and limit metadata. Full account snapshots and smaller rolling updates are merged carefully, so newer updates do not accidentally erase useful older details.

Third, it offers recovery paths. If Codex usage is high, the UI may suggest switching to a lower-cost model. If workspace credits or usage limits are exhausted, it can ask whether to notify the workspace owner. Think of this file like a dashboard assistant: it watches the gauges, warns before trouble, and offers the next practical button when trouble arrives.

#### Function details

##### `RateLimitWarningState::take_warnings`  (lines 20–73)

```
fn take_warnings(
        &mut self,
        secondary_used_percent: Option<f64>,
        secondary_window_minutes: Option<i64>,
        primary_used_percent: Option<f64>,
        primary_window_minut
```

**Purpose**: Creates user-facing warning messages when primary or secondary usage crosses preset warning levels. It also remembers which levels have already triggered, so the same warning is not shown again and again.

**Data flow**: It receives optional usage percentages and optional time-window lengths for two kinds of limits. It ignores the warning path if either limit is already exactly at 100%, then checks whether the current percentage has crossed any new thresholds. It returns a list of warning strings and updates its saved threshold positions.

**Call relations**: When ChatWidget receives a Codex rate-limit snapshot, it calls this function to turn raw percentages into plain warnings. This function asks limit_label_for_window to describe the time window in friendly words before handing the finished messages back to the chat history flow.

*Call graph*: calls 1 internal fn (limit_label_for_window); 3 external calls (new, format!, matches!).


##### `limit_label_for_window`  (lines 76–80)

```
fn limit_label_for_window(window_minutes: Option<i64>, is_secondary: bool) -> String
```

**Purpose**: Turns a limit window, such as a number of minutes, into a short label users can understand, like “daily” or “weekly.” If the window is missing or unfamiliar, it falls back to a generic label.

**Data flow**: It receives an optional window length and a flag saying whether this is the secondary limit. It tries to convert the minutes into a known duration label; if that fails, it chooses the appropriate fallback text. It returns one label string.

**Call relations**: RateLimitWarningState::take_warnings calls this while building warning messages, so the warning can say which kind of limit is running low instead of showing a raw number of minutes.

*Call graph*: called by 1 (take_warnings).


##### `get_limits_duration`  (lines 82–105)

```
fn get_limits_duration(windows_minutes: i64) -> Option<String>
```

**Purpose**: Recognizes common rate-limit windows from a number of minutes. It maps approximate durations to labels such as “5h,” “daily,” “weekly,” “monthly,” or “annual.”

**Data flow**: It receives a minute count, clamps negative values to zero, and compares it against known window sizes. If the number is close enough to one of those sizes, it returns the matching label; otherwise it returns nothing.

**Call relations**: This helper is used by limit_label_for_window as the first attempt at making a human-readable label. It delegates each “close enough?” check to is_approximate_window.

*Call graph*: calls 1 internal fn (is_approximate_window).


##### `fallback_limit_label`  (lines 107–113)

```
fn fallback_limit_label(is_secondary: bool) -> &'static str
```

**Purpose**: Provides a safe label when the system cannot identify a limit window. It keeps warning text understandable even when the server sends incomplete or unusual timing data.

**Data flow**: It receives whether the limit is secondary. It returns either the secondary fallback label or the primary fallback label, without changing anything else.

**Call relations**: This is the backup path for limit_label_for_window when there is no known duration label available.


##### `is_approximate_window`  (lines 115–119)

```
fn is_approximate_window(minutes: i64, expected_minutes: i64) -> bool
```

**Purpose**: Checks whether a reported time window is close enough to an expected duration. This avoids being too strict when server values are slightly off from exact calendar lengths.

**Data flow**: It receives an actual minute count and an expected minute count. It converts both to decimal numbers and tests whether the actual value is within 5% below or above the expected value. It returns true or false.

**Call relations**: get_limits_duration calls this repeatedly while trying to decide whether a window should be described as 5 hours, daily, weekly, monthly, or annual.

*Call graph*: called by 1 (get_limits_duration).


##### `app_server_rate_limit_error_kind`  (lines 136–147)

```
fn app_server_rate_limit_error_kind(
    info: &AppServerCodexErrorInfo,
) -> Option<RateLimitErrorKind>
```

**Purpose**: Classifies app-server errors that are related to rate limiting. This lets the UI react differently to overload, usage-limit exhaustion, and a more generic “too many requests” situation.

**Data flow**: It receives a structured error from the app server. It checks which variant of error it is and returns a matching rate-limit category when appropriate; unrelated errors return nothing.

**Call relations**: Other chat error-handling code can call this when an app-server error arrives, using the returned category to decide which message or prompt should be shown.


##### `is_app_server_cyber_policy_error`  (lines 149–151)

```
fn is_app_server_cyber_policy_error(info: &AppServerCodexErrorInfo) -> bool
```

**Purpose**: Identifies whether an app-server error is specifically a cyber policy error. This separates policy blocks from ordinary rate-limit or server problems.

**Data flow**: It receives a structured app-server error and checks whether it matches the cyber policy case. It returns true for that one case and false otherwise.

**Call relations**: This small classifier is available to the chat error flow when it needs to decide whether an error should be treated as a policy issue instead of a rate-limit issue.

*Call graph*: 1 external calls (matches!).


##### `ChatWidget::on_rate_limit_snapshot`  (lines 160–162)

```
fn on_rate_limit_snapshot(&mut self, snapshot: Option<RateLimitSnapshot>)
```

**Purpose**: Accepts a full account usage rate-limit snapshot and sends it into the shared snapshot-processing path. This is the normal entry point for complete limit information.

**Data flow**: It receives an optional snapshot. It passes that snapshot along with an “account usage” source label to the internal processing function, which updates stored state and UI output.

**Call relations**: This function is a thin front door into ChatWidget::on_rate_limit_snapshot_from. It is used when the UI gets a full account usage read rather than a smaller rolling update.

*Call graph*: calls 1 internal fn (on_rate_limit_snapshot_from).


##### `ChatWidget::on_rolling_rate_limit_snapshot`  (lines 164–167)

```
fn on_rolling_rate_limit_snapshot(&mut self, snapshot: RateLimitSnapshot)
```

**Purpose**: Accepts a rolling rate-limit update from the app server. Rolling updates are smaller, so this function marks them as such before sending them to the shared processing path.

**Data flow**: It receives a snapshot, wraps it as present, and passes it with a “rolling update” source label. The downstream logic can then preserve older details that the sparse update did not include.

**Call relations**: Like ChatWidget::on_rate_limit_snapshot, this calls ChatWidget::on_rate_limit_snapshot_from, but it tells that function the data came from a rolling notification.

*Call graph*: calls 1 internal fn (on_rate_limit_snapshot_from).


##### `ChatWidget::on_rate_limit_snapshot_from`  (lines 169–284)

```
fn on_rate_limit_snapshot_from(
        &mut self,
        snapshot: Option<RateLimitSnapshot>,
        source: RateLimitSnapshotSource,
    )
```

**Purpose**: This is the central rate-limit update routine for the chat UI. It stores fresh limit data, preserves useful older metadata when needed, creates warnings, and decides whether to prepare a model-switch prompt.

**Data flow**: It receives either a snapshot or no snapshot, plus where the snapshot came from. With a snapshot, it fills in missing labels or credit details, records plan and reached-limit information, checks warning thresholds, checks whether usage is high enough to suggest a cheaper model, stores a display-ready snapshot, and may add warning events to chat history. With no snapshot, it clears stored limit data. It finishes by refreshing the status line.

**Call relations**: Both ChatWidget::on_rate_limit_snapshot and ChatWidget::on_rolling_rate_limit_snapshot feed into this function. During processing it checks rate_limit_switch_prompt_hidden before preparing a model nudge, and it uses warning event creation when warnings need to appear in chat.

*Call graph*: calls 1 internal fn (rate_limit_switch_prompt_hidden); called by 2 (on_rate_limit_snapshot, on_rolling_rate_limit_snapshot); 4 external calls (now, new_warning_event, matches!, vec!).


##### `ChatWidget::stop_rate_limit_poller`  (lines 286–286)

```
fn stop_rate_limit_poller(&mut self)
```

**Purpose**: Provides a hook for stopping any background rate-limit polling. In this file it is currently an empty placeholder, which means no polling work is stopped here yet.

**Data flow**: It receives the chat widget as mutable state but does not read or change anything. It produces no return value.

**Call relations**: ChatWidget::prefetch_rate_limits calls this before prefetching. Because the function is empty, that call currently acts as a safe no-op placeholder for future polling behavior.

*Call graph*: called by 1 (prefetch_rate_limits).


##### `ChatWidget::prefetch_rate_limits`  (lines 289–291)

```
fn prefetch_rate_limits(&mut self)
```

**Purpose**: Starts the rate-limit prefetch path, though at present it only stops any existing poller. This keeps the public shape of the feature in place even if active prefetching is not implemented here.

**Data flow**: It receives the chat widget, calls the poller-stop hook, and returns nothing. No new data is fetched by this function as currently written.

**Call relations**: This function calls ChatWidget::stop_rate_limit_poller. It is likely invoked by surrounding setup or refresh code when the UI wants rate-limit information ready early.

*Call graph*: calls 1 internal fn (stop_rate_limit_poller).


##### `ChatWidget::should_prefetch_rate_limits`  (lines 294–296)

```
fn should_prefetch_rate_limits(&self) -> bool
```

**Purpose**: Decides whether this chat session should try to prefetch rate-limit information. It only says yes when the configured model provider needs OpenAI authentication and the user has a ChatGPT account.

**Data flow**: It reads configuration and account state from the chat widget. It combines those two booleans and returns true only when both conditions are met.

**Call relations**: Surrounding setup code can call this before attempting prefetch work, so rate-limit prefetching is skipped for sessions where it would not apply.


##### `ChatWidget::lower_cost_preset`  (lines 298–304)

```
fn lower_cost_preset(&self) -> Option<ModelPreset>
```

**Purpose**: Finds the model preset used for the lower-cost rate-limit suggestion. It looks specifically for the configured nudge model and only returns it if it is visible in the model picker.

**Data flow**: It asks the model catalog for available models. If that succeeds, it searches for a visible preset whose model name matches the nudge model, clones it, and returns it; if anything is missing, it returns nothing.

**Call relations**: ChatWidget::maybe_show_pending_rate_limit_prompt calls this before opening the prompt. If no suitable preset is found, the prompt is not shown.

*Call graph*: called by 1 (maybe_show_pending_rate_limit_prompt).


##### `ChatWidget::rate_limit_switch_prompt_hidden`  (lines 306–311)

```
fn rate_limit_switch_prompt_hidden(&self) -> bool
```

**Purpose**: Checks the user setting that hides future rate-limit model-switch reminders. This respects a user’s choice not to be nudged again.

**Data flow**: It reads the notice setting from configuration. If the setting is present, it returns that value; if it is absent, it treats the prompt as not hidden.

**Call relations**: ChatWidget::on_rate_limit_snapshot_from calls this before marking a model-switch prompt as pending, and ChatWidget::maybe_show_pending_rate_limit_prompt calls it again before actually showing anything.

*Call graph*: called by 2 (maybe_show_pending_rate_limit_prompt, on_rate_limit_snapshot_from).


##### `ChatWidget::maybe_show_pending_rate_limit_prompt`  (lines 313–330)

```
fn maybe_show_pending_rate_limit_prompt(&mut self)
```

**Purpose**: Shows the model-switch prompt if one has been prepared and is still allowed. It is the point where a background decision becomes an actual UI popup.

**Data flow**: It checks whether the prompt is hidden; if so, it resets the state to idle. If no prompt is pending, it does nothing. If a prompt is pending, it looks for the lower-cost preset; when found, it opens the prompt and marks it shown, otherwise it resets to idle.

**Call relations**: This function is called after ChatWidget::on_rate_limit_snapshot_from has set the prompt state to pending. It uses ChatWidget::lower_cost_preset to find the suggested model and hands that preset to ChatWidget::open_rate_limit_switch_prompt.

*Call graph*: calls 3 internal fn (lower_cost_preset, open_rate_limit_switch_prompt, rate_limit_switch_prompt_hidden); 1 external calls (matches!).


##### `ChatWidget::open_rate_limit_switch_prompt`  (lines 332–408)

```
fn open_rate_limit_switch_prompt(&mut self, preset: ModelPreset)
```

**Purpose**: Builds and displays the popup that asks whether the user wants to switch to a lower-cost model. It gives three choices: switch, keep the current model, or never show the reminder again.

**Data flow**: It receives a model preset. It extracts the model name, default reasoning effort, and description, builds actions for each choice, creates selection items, and sends them to the bottom pane for display. Choosing “switch” sends events to update the turn context, model, and reasoning effort; choosing “never” sends events to hide and persist the setting.

**Call relations**: ChatWidget::maybe_show_pending_rate_limit_prompt calls this once it has confirmed a pending prompt and found a valid lower-cost preset. The resulting selection view is then handled by the UI’s normal selection-action event flow.

*Call graph*: called by 1 (maybe_show_pending_rate_limit_prompt); 4 external calls (default, new, format!, vec!).


##### `ChatWidget::open_workspace_owner_nudge_prompt`  (lines 410–456)

```
fn open_workspace_owner_nudge_prompt(
        &mut self,
        credit_type: AddCreditsNudgeCreditType,
    )
```

**Purpose**: Shows a yes/no prompt asking whether to notify the workspace owner when credits or usage limits are blocking progress. It avoids opening a second prompt if an email request is already in progress.

**Data flow**: It receives the kind of credit-related problem. If an email request is already in flight, it returns immediately. Otherwise it chooses the right title and message, builds a “Yes” action that sends the email request event, builds a default “No” option, and displays the selection view.

**Call relations**: This function is used by the UI when the user hits a workspace credit or usage-limit wall. If the user chooses yes, the selection action sends an event that leads to the add-credits nudge email request flow.

*Call graph*: 2 external calls (default, vec!).


##### `ChatWidget::start_add_credits_nudge_email_request`  (lines 458–464)

```
fn start_add_credits_nudge_email_request(
        &mut self,
        credit_type: AddCreditsNudgeCreditType,
    ) -> bool
```

**Purpose**: Marks that a request to notify the workspace owner has started. This prevents duplicate requests from being launched at the same time.

**Data flow**: It receives the type of request, stores it as the current in-flight email request, and returns true to indicate the start was accepted.

**Call relations**: This is the beginning of the workspace-owner notification flow. Later, ChatWidget::finish_add_credits_nudge_email_request uses the stored request type to choose the correct completion message.


##### `ChatWidget::finish_add_credits_nudge_email_request`  (lines 466–501)

```
fn finish_add_credits_nudge_email_request(
        &mut self,
        result: Result<AddCreditsNudgeEmailStatus, String>,
    )
```

**Purpose**: Completes the workspace-owner notification flow and tells the user what happened. It produces different messages for success, cooldown, and failure, and for credits versus usage-limit requests.

**Data flow**: It receives the email request result. It removes the saved in-flight request type, chooses a human-readable status message based on the request type and result, adds that message to chat history as an info event, and asks the UI to redraw.

**Call relations**: This follows ChatWidget::start_add_credits_nudge_email_request in the notification flow. It uses info event creation so the outcome appears in the chat history.

*Call graph*: 1 external calls (new_info_event).


##### `ChatWidget::set_rate_limit_switch_prompt_hidden`  (lines 503–508)

```
fn set_rate_limit_switch_prompt_hidden(&mut self, hidden: bool)
```

**Purpose**: Updates the setting that controls whether rate-limit model-switch reminders should be hidden. If the user hides them, it also clears any pending prompt state.

**Data flow**: It receives a boolean. It writes that value into the notice configuration, and when the value is true it sets the prompt state back to idle. It returns nothing.

**Call relations**: This supports the “never show again” path from the model-switch prompt. Once set, ChatWidget::rate_limit_switch_prompt_hidden causes future snapshot processing and prompt display checks to skip the nudge.


### `tui/src/chatwidget/review.rs`

`data_model` · `active while entering, using, and leaving chat code-review mode`

This file is a simple storage box for the chat widget’s code-review flow. When the chat interface switches into review mode, the rest of the interface needs a few facts to stay consistent: it needs to know that review mode is on, it needs to show different layout or banner text, and it needs to avoid repeatedly asking for automatic review if recent attempts were denied. It also saves a snapshot of token usage before review mode starts, so the interface can put that information back when review mode ends.

The main type is `ReviewState`. It does not perform the review itself. Instead, it holds the shared facts that other parts of `ChatWidget` read and update while the review experience is running. An everyday analogy is a clipboard used during a store return: it does not do the return, but it keeps the needed notes in one place so each step knows the current situation.

The `pre_review_token_info` field is intentionally nested: it can mean “no snapshot has been saved yet,” or “a snapshot was saved and the previous value was itself empty.” That distinction matters when leaving review mode, because restoring “nothing was there” is different from “we never recorded what was there.”


### `tui/src/chatwidget/session_header.rs`

`data_model` · `chat UI setup and model-change updates`

A chat session header is the label area that tells the user important context about the current conversation, such as which AI model is being used. This file keeps that part deliberately simple: `SessionHeader` stores one piece of text, the model name. Without this small object, other parts of the terminal UI would need to carry that model string around themselves, which would make the display code more scattered and easier to get out of sync.

The file provides two actions. First, a header can be created with an initial model name. Second, the stored model name can be changed later. The update method checks whether the new text is actually different before replacing it. That is a small but useful guard: like not repainting a sign if the wording has not changed, it avoids unnecessary work and keeps state changes intentional.

There is no drawing code here. This file is only the state container for the header’s model label. Other UI code can create it, keep it as part of the chat widget, and ask it to update when the active model changes.

#### Function details

##### `SessionHeader::new`  (lines 6–8)

```
fn new(model: String) -> Self
```

**Purpose**: Creates a new session header state using the given model name. This is used when the chat UI is being built and needs an initial model label to show.

**Data flow**: A model name string goes in. The function stores that string inside a new `SessionHeader`. A ready-to-use header state object comes out.

**Call relations**: When `new_with_op_target` builds a larger chat UI object, it calls this function to prepare the header part. After that, the returned `SessionHeader` can be kept with the rest of the chat widget state.

*Call graph*: called by 1 (new_with_op_target).


##### `SessionHeader::set_model`  (lines 11–15)

```
fn set_model(&mut self, model: &str)
```

**Purpose**: Changes the model name stored in the session header, but only if the new name is different from the current one. This lets the UI keep the header label aligned with the active model.

**Data flow**: A borrowed model name text goes in, along with the existing header state. The function compares the new text with the stored text. If they differ, it copies the new text into the header; if they are the same, it leaves the header unchanged. Nothing is returned.

**Call relations**: This function is available for the part of the UI that notices the active model has changed. The call graph provided does not show a direct caller, but its role is to update this header state before the interface displays the current session information.


### `tui/src/chatwidget/status_controls.rs`

`orchestration` · `main loop and request handling`

This file is the control panel for status information inside `ChatWidget`, the main chat user interface widget. It does not draw most of the pixels itself. Instead, it gathers the current facts, updates stored state, opens setup screens, and asks other parts of the interface to refresh.

The file covers several related jobs. It can set the short status message shown near the chat, including optional details. It can push footer text, hyperlinks, and the active-agent label down into the bottom pane. It also owns the setup flow for the status line and terminal title: preview a choice, cancel and restore the old configuration, or confirm and keep the new one.

A second important job is keeping live data honest. Git branch and Git summary lookups happen asynchronously, meaning the answer may arrive later. This file checks that those answers still match the current working directory before showing them, so the interface does not display stale information. It also builds the history-facing `/status` output, including model, token use, rate limits, session identity, and agent information. Think of it like a receptionist board: it does not do all the work, but it collects reliable updates and makes sure the right signs are shown in the right places.

#### Function details

##### `ChatWidget::set_status`  (lines 13–54)

```
fn set_status(
        &mut self,
        header: String,
        details: Option<String>,
        details_capitalization: StatusDetailsCapitalization,
        details_max_lines: usize,
    )
```

**Purpose**: Updates the main status indicator with a header and optional detail text. It is used when the app needs to tell the user the current run state, such as what is happening now or why something changed.

**Data flow**: It receives a header, optional details, a rule for whether to capitalize the detail text, and a maximum number of detail lines. It trims and optionally capitalizes the details, stores the result in the widget status state, updates the bottom pane, and refreshes status-related surfaces if the terminal title depends on status text.

**Call relations**: This is the main status update path. `ChatWidget::set_status_header` calls it when only the header should change and any old details should be cleared.

*Call graph*: called by 1 (set_status_header).


##### `ChatWidget::set_status_header`  (lines 58–65)

```
fn set_status_header(&mut self, header: String)
```

**Purpose**: Sets just the status header and clears any previous detail text. It is a convenience shortcut for simple status changes.

**Data flow**: It receives a header string, supplies no details, chooses the default capitalization and line limit, and passes everything to `ChatWidget::set_status`. The visible result is a simpler status indicator with only the new header.

**Call relations**: This function is a thin wrapper around `ChatWidget::set_status`, used when callers do not need to control detail text themselves.

*Call graph*: calls 1 internal fn (set_status).


##### `ChatWidget::set_status_line`  (lines 68–70)

```
fn set_status_line(&mut self, status_line: Option<Line<'static>>)
```

**Purpose**: Sets the footer status line currently shown at the bottom of the chat interface. This is for short, already-rendered status text.

**Data flow**: It receives either a line of formatted text or `None`. It forwards that value to the bottom pane, which then shows the line or clears it.

**Call relations**: This is a pass-through from `ChatWidget` to the bottom pane. It keeps status-line ownership reachable from the chat widget while leaving rendering to the footer area.


##### `ChatWidget::set_status_line_hyperlink`  (lines 73–75)

```
fn set_status_line_hyperlink(&mut self, url: Option<String>)
```

**Purpose**: Sets or clears the link target attached to the footer status line. This lets a status message act like a clickable or terminal-recognized link when the terminal supports it.

**Data flow**: It receives an optional URL string. It sends that URL to the bottom pane, which associates it with the current footer status line or removes the link when the input is `None`.

**Call relations**: This function is another simple bridge into the bottom pane, used alongside status-line text updates.


##### `ChatWidget::set_active_agent_label`  (lines 81–83)

```
fn set_active_agent_label(&mut self, active_agent_label: Option<String>)
```

**Purpose**: Passes the label for the currently active agent to the footer. An agent here means a named assistant or working context that the user may be viewing.

**Data flow**: It receives an optional label string. It forwards the label to the bottom pane, which decides how to render it in the footer stack.

**Call relations**: The comment explains the split of responsibility: the wider app decides which agent is active, while this method forwards that decision into the footer display.


##### `ChatWidget::refresh_status_line`  (lines 95–97)

```
fn refresh_status_line(&mut self)
```

**Purpose**: Rebuilds the status-line display from current configuration and live runtime state. This is used when settings or facts change and the footer should be recalculated.

**Data flow**: It reads the widget’s current config and state indirectly by calling the shared status-surface refresh routine. The result is an updated status line with only currently available values included.

**Call relations**: `ChatWidget::setup_status_line` calls this after saving a new status-line selection, so the user immediately sees the confirmed choice.

*Call graph*: called by 1 (setup_status_line).


##### `ChatWidget::cancel_status_line_setup`  (lines 103–105)

```
fn cancel_status_line_setup(&self)
```

**Purpose**: Records that the user canceled status-line setup. It intentionally does not change settings, so the previous status-line configuration remains active.

**Data flow**: It takes no new settings and only writes an informational log message. No configuration is saved and no display state is changed.

**Call relations**: When the setup UI is dismissed without confirmation, this function is the endpoint. It calls the external logging macro `info!` to leave a trace for diagnostics.

*Call graph*: 1 external calls (info!).


##### `ChatWidget::setup_status_line`  (lines 110–118)

```
fn setup_status_line(&mut self, items: Vec<StatusLineItem>, use_theme_colors: bool)
```

**Purpose**: Applies the user’s confirmed status-line item choices to the in-memory configuration. It also records whether theme colors should be used.

**Data flow**: It receives selected status-line items and a color preference. It converts the items to their configuration IDs, stores them in `config.tui_status_line`, updates the color flag, and refreshes the status line so the new choice appears.

**Call relations**: This is the confirmation path from the setup view. It logs the choice with `info!`, then calls `ChatWidget::refresh_status_line` to apply it visually.

*Call graph*: calls 1 internal fn (refresh_status_line); 1 external calls (info!).


##### `ChatWidget::preview_terminal_title`  (lines 121–129)

```
fn preview_terminal_title(&mut self, items: Vec<TerminalTitleItem>)
```

**Purpose**: Temporarily applies a terminal-title selection while the setup screen is open. This lets the user see what the terminal title would look like before committing.

**Data flow**: It receives selected terminal-title items. If this is the first preview in the setup session, it saves the original title configuration, then writes the preview IDs into config and refreshes the terminal title.

**Call relations**: This is part of the terminal-title setup flow. Later, `ChatWidget::revert_terminal_title_setup_preview` can restore the saved original, or `ChatWidget::setup_terminal_title` can commit the new selection.


##### `ChatWidget::revert_terminal_title_setup_preview`  (lines 133–140)

```
fn revert_terminal_title_setup_preview(&mut self)
```

**Purpose**: Restores the terminal-title configuration that was active before preview mode started. It is used to undo temporary preview changes.

**Data flow**: It checks whether an original configuration snapshot exists. If one exists, it moves that snapshot back into config, clears the saved snapshot, and refreshes the terminal title; if not, it does nothing.

**Call relations**: `ChatWidget::cancel_terminal_title_setup` calls this when the user cancels the title setup screen.

*Call graph*: called by 1 (cancel_terminal_title_setup).


##### `ChatWidget::cancel_terminal_title_setup`  (lines 143–146)

```
fn cancel_terminal_title_setup(&mut self)
```

**Purpose**: Cancels terminal-title setup and returns the title to its previous configuration. It is the safe exit path for a user who tried changes but did not confirm them.

**Data flow**: It writes an informational log message, then asks `ChatWidget::revert_terminal_title_setup_preview` to restore the saved pre-preview configuration. The output is the old terminal title being restored when a preview was active.

**Call relations**: This function combines user-facing cancellation with cleanup. It calls the external logging macro `info!` and then hands the actual restoration to `ChatWidget::revert_terminal_title_setup_preview`.

*Call graph*: calls 1 internal fn (revert_terminal_title_setup_preview); 1 external calls (info!).


##### `ChatWidget::setup_terminal_title`  (lines 152–158)

```
fn setup_terminal_title(&mut self, items: Vec<TerminalTitleItem>)
```

**Purpose**: Commits the user’s confirmed terminal-title item selection. After this, preview rollback is no longer possible because the new choice is now the chosen configuration.

**Data flow**: It receives terminal-title items, converts them to configuration IDs, discards any saved original preview state, stores the new list in config, and refreshes the terminal title.

**Call relations**: This is the confirmation path for terminal-title setup. It logs the confirmed items with `info!` and then updates the title display.

*Call graph*: 1 external calls (info!).


##### `ChatWidget::set_status_line_branch`  (lines 164–173)

```
fn set_status_line_branch(&mut self, cwd: PathBuf, branch: Option<String>)
```

**Purpose**: Stores the result of an asynchronous Git branch lookup for the status line. It protects the UI from showing a branch name that belongs to an old directory.

**Data flow**: It receives the directory that was checked and an optional branch name. If that directory is no longer the one the status line is waiting for, it drops the result and clears the pending flag; otherwise it stores the branch, marks the lookup complete, and refreshes status surfaces.

**Call relations**: This function is called when a delayed branch lookup finishes. It reconnects the late answer to the current UI only if the working directory still matches.


##### `ChatWidget::set_status_line_git_summary`  (lines 176–189)

```
fn set_status_line_git_summary(
        &mut self,
        cwd: PathBuf,
        summary: StatusLineGitSummary,
    )
```

**Purpose**: Stores the result of an asynchronous Git summary lookup for the status line. A Git summary is a compact description of repository state, such as changes or status counts.

**Data flow**: It receives the directory that was checked and the computed summary. If the directory no longer matches the current pending lookup, it ignores the summary and clears the pending flag; otherwise it stores the summary, marks lookup complete, and refreshes status surfaces.

**Call relations**: Like the branch-result function, this is a late-result receiver. It makes sure background Git information is only displayed when it still belongs to the current directory.


##### `ChatWidget::add_status_output`  (lines 191–248)

```
fn add_status_output(
        &mut self,
        refreshing_rate_limits: bool,
        request_id: Option<u64>,
    )
```

**Purpose**: Adds a detailed `/status` entry to the chat history. This gives the user a snapshot of the current session, including model information, token use, rate limits, account/provider details, and agent setup.

**Data flow**: It reads many pieces of current widget state: token information, model choice, reasoning effort, rate-limit snapshots, thread identity, connection details, account display, plan type, and agent summary. It sends these facts to the status builder, receives a history cell plus a handle for later rate-limit updates, optionally stores that handle under a request ID, and appends the cell to chat history.

**Call relations**: This function calls external helpers to get the current time, compose the agent summary, create the status output, and supply default token usage when needed. If rate limits are being refreshed, `ChatWidget::finish_status_rate_limit_refresh` later uses the saved handle to update the same status output.

*Call graph*: 4 external calls (now, compose_agents_summary, new_status_output_with_rate_limits_handle, default).


##### `ChatWidget::finish_status_rate_limit_refresh`  (lines 250–275)

```
fn finish_status_rate_limit_refresh(&mut self, request_id: u64)
```

**Purpose**: Finishes updating any `/status` history entry that was waiting for refreshed rate-limit data. Rate limits are usage caps, and this keeps the displayed snapshot current once the refresh response arrives.

**Data flow**: It receives a request ID, collects the latest rate-limit snapshots, and checks saved pending status-output handles. Matching handles are updated with the new snapshots and current time; non-matching ones are kept for later. If anything was updated, it requests a screen redraw.

**Call relations**: This is the counterpart to `ChatWidget::add_status_output` when that function saved a refresh handle. It uses external time and vector-capacity helpers, then updates the waiting output cell through its handle.

*Call graph*: 2 external calls (now, with_capacity).


##### `ChatWidget::open_status_line_setup`  (lines 277–287)

```
fn open_status_line_setup(&mut self)
```

**Purpose**: Opens the interactive setup view for choosing what appears in the footer status line. It prepares the view with current choices and preview data.

**Data flow**: It reads the configured status-line items, the color preference, preview values, the app event sender, and the bottom-pane keymap. It builds a setup view from those pieces and asks the bottom pane to show it.

**Call relations**: This is the entry into status-line setup from the chat widget. It calls `ChatWidget::status_surface_preview_data` to provide examples, then constructs the setup view and hands it to the bottom pane.

*Call graph*: calls 2 internal fn (new, status_surface_preview_data); 1 external calls (new).


##### `ChatWidget::open_terminal_title_setup`  (lines 289–299)

```
fn open_terminal_title_setup(&mut self)
```

**Purpose**: Opens the interactive setup view for choosing what appears in the terminal window title. It also saves the current title configuration so preview changes can be undone.

**Data flow**: It reads the configured terminal-title items, stores the original title configuration, builds preview data, and creates a setup view with the event sender and keymap. It then asks the bottom pane to display that view.

**Call relations**: This starts the terminal-title setup flow. It calls `ChatWidget::terminal_title_preview_data` for example values before handing the new view to the bottom pane.

*Call graph*: calls 2 internal fn (new, terminal_title_preview_data); 1 external calls (new).


##### `ChatWidget::status_surface_preview_data`  (lines 301–321)

```
fn status_surface_preview_data(&mut self) -> StatusSurfacePreviewData
```

**Purpose**: Builds sample values for status-surface setup screens. These samples help the user understand what each selectable status item would show.

**Data flow**: It loops through all possible preview items, asks the widget for a live value for each one, and stores the available values in preview data. If Codex rate-limit data exists but specific limit values are unavailable, it suppresses placeholders for those missing limit items.

**Call relations**: `ChatWidget::open_status_line_setup` calls this to populate the status-line setup view. `ChatWidget::terminal_title_preview_data` also calls it as a base before adding terminal-title-specific live values.

*Call graph*: calls 2 internal fn (from_iter, iter); called by 2 (open_status_line_setup, terminal_title_preview_data).


##### `ChatWidget::terminal_title_preview_data`  (lines 323–336)

```
fn terminal_title_preview_data(&mut self) -> StatusSurfacePreviewData
```

**Purpose**: Builds preview values specifically for the terminal-title setup screen. It starts with general status preview data, then overlays values that only matter for the title.

**Data flow**: It creates base preview data from `ChatWidget::status_surface_preview_data`, records the current instant, loops through terminal-title item choices, and fills in live preview values where available. The result is preview data that reflects what the title can show right now.

**Call relations**: `ChatWidget::open_terminal_title_setup` calls this when building the title setup view. Internally it relies on `ChatWidget::status_surface_preview_data` and the terminal-title item iterator.

*Call graph*: calls 1 internal fn (status_surface_preview_data); called by 1 (open_terminal_title_setup); 2 external calls (now, iter).


##### `ChatWidget::status_line_context_window_size`  (lines 338–343)

```
fn status_line_context_window_size(&self) -> Option<i64>
```

**Purpose**: Finds the model context-window size to use in status-line calculations. A context window is the amount of text the model can consider at once.

**Data flow**: It first looks for a context-window value in live token information. If that is missing, it falls back to the configured model context window. It returns the size if either source has one.

**Call relations**: `ChatWidget::status_line_context_remaining_percent` calls this before calculating how much context remains.

*Call graph*: called by 1 (status_line_context_remaining_percent).


##### `ChatWidget::status_line_context_remaining_percent`  (lines 345–360)

```
fn status_line_context_remaining_percent(&self) -> Option<i64>
```

**Purpose**: Calculates the percentage of the model context window still unused. This helps the status line show how much room remains for conversation or prompt text.

**Data flow**: It asks for the context-window size. If no size is known, it returns 100 percent as a safe display value. Otherwise it reads the latest token usage, computes remaining capacity as a percent, clamps it between 0 and 100, and returns that number.

**Call relations**: This function calls `ChatWidget::status_line_context_window_size` and is itself used by `ChatWidget::status_line_context_used_percent`, which presents the same information from the opposite angle.

*Call graph*: calls 1 internal fn (status_line_context_window_size); called by 1 (status_line_context_used_percent); 1 external calls (default).


##### `ChatWidget::status_line_context_used_percent`  (lines 362–365)

```
fn status_line_context_used_percent(&self) -> Option<i64>
```

**Purpose**: Calculates the percentage of the model context window already used. It is the inverse of the remaining-context display.

**Data flow**: It gets the remaining percentage from `ChatWidget::status_line_context_remaining_percent`, defaults to 100 percent remaining if needed, subtracts that from 100, clamps the result, and returns the used percentage.

**Call relations**: This function builds directly on `ChatWidget::status_line_context_remaining_percent` so both used and remaining values stay consistent.

*Call graph*: calls 1 internal fn (status_line_context_remaining_percent).


##### `ChatWidget::status_line_total_usage`  (lines 367–372)

```
fn status_line_total_usage(&self) -> TokenUsage
```

**Purpose**: Returns total token usage for the current session. Tokens are chunks of text counted by the model for billing, limits, and context tracking.

**Data flow**: It checks whether live token information exists. If so, it clones and returns the total usage from that data; otherwise it returns an empty/default usage record.

**Call relations**: This is a small data accessor used by status-surface code when it needs total usage without worrying about whether token information has arrived yet.


##### `ChatWidget::status_line_limit_display`  (lines 374–382)

```
fn status_line_limit_display(
        &self,
        window: Option<&RateLimitWindowDisplay>,
        label: &str,
    ) -> Option<String>
```

**Purpose**: Formats a rate-limit window into a short human-readable string, such as a label followed by the percentage left. A rate-limit window is a period of time with a usage cap.

**Data flow**: It receives an optional rate-limit window and a label. If no window is present, it returns nothing; otherwise it subtracts the used percentage from 100, clamps the result between 0 and 100, and returns formatted text like “weekly 42% left.”

**Call relations**: This helper is used by status-line rendering code to turn raw rate-limit numbers into compact text. It calls the standard formatting macro to build the final string.

*Call graph*: 1 external calls (format!).


##### `ChatWidget::status_line_reasoning_effort_label`  (lines 384–391)

```
fn status_line_reasoning_effort_label(
        effort: Option<&ReasoningEffortConfig>,
    ) -> String
```

**Purpose**: Turns an optional reasoning-effort setting into the label shown in status displays. Reasoning effort is a model setting that affects how much effort the model should spend thinking.

**Data flow**: It receives an optional reasoning-effort configuration. If the value is missing or explicitly set to none, it returns “default”; otherwise it returns the setting’s own text label.

**Call relations**: This is a display helper for status surfaces that need a friendly label rather than the raw configuration value.


### `tui/src/status/account.rs`

`data_model` · `cross-cutting`

This file is a simple data model for the terminal user interface, often called a TUI, which means an app interface drawn with text instead of windows and buttons. The status area needs to show the user what kind of account or credentials are currently being used. Without a shared shape for that information, different parts of the interface might guess or format account state inconsistently.

The enum `StatusAccountDisplay` is like a small label card with two possible forms. One form says the user is signed in through ChatGPT, and it can carry an email address and a plan name if those are known. Both are optional because the program may know that ChatGPT login is being used without having every detail. The other form says the program is using an API key instead. That case has no extra fields because the interface only needs to know that key-based access is active, not display the secret key itself.

The derived traits let this value be printed for debugging, copied by cloning, and compared for equality. That is useful when the interface wants to check whether the displayed account status has changed.


### `tui/src/status/mod.rs`

`other` · `cross-cutting during status rendering and tests`

This module is like the contents page for the status area of the text user interface. The rest of the program should not need to know which small file formats account details, which one builds status cards, or which one prepares rate-limit information. This file names those internal parts and then re-exports the useful pieces through one stable place.

The problem it solves is separation. Transport-facing code receives protocol-level snapshots, which are raw reports from elsewhere in the system. Display code needs clearer, steadier shapes: account labels, compact token counts, directory names, agent summaries, rate-limit windows, and ready-made status output builders. By routing those through this module, the project keeps rendering concerns out of lower-level communication code.

One important piece is the rate-limit display path. Rate limits describe usage windows, such as how much quota is left and when it resets. This module exposes helpers that convert those raw windows into local-time labels and mark whether the information is fresh, stale, or missing.

Some exports only appear during tests. That lets tests build and inspect status output directly without making those helpers part of the normal internal interface.


### `tui/src/status/rate_limits.rs`

`domain_logic` · `status rendering and rate-limit refresh`

The backend sends rate-limit information in a machine-friendly shape: usage windows, reset timestamps, credit balances, and monthly spend limits. This file reshapes that into display-friendly data for the TUI, which is the text user interface. Without it, different status screens could label the same limit differently, show misleading reset times, or forget to warn when data is old.

The flow is like preparing a receipt for a person from a raw database record. First, protocol snapshots are converted into local display snapshots. Unix timestamps are turned into local reset-time text, percentages are copied into a UI-friendly form, and credit amounts are cleaned up for display. Then the file composes one or more snapshots into rows such as `5h limit`, `Credits`, or `Monthly credit limit`.

It also decides whether the data is fresh, stale, missing, or unavailable. Stale means the snapshot exists but was captured more than 15 minutes ago, so the UI can still show it while warning the user not to fully trust it. Finally, it provides small formatting helpers for progress bars and percent summaries. An important detail is that all time-based labels are calculated against a caller-provided timestamp, so one screen draw uses a coherent idea of “now.”

#### Function details

##### `RateLimitWindowDisplay::from_window`  (lines 79–91)

```
fn from_window(window: &RateLimitWindow, captured_at: DateTime<Local>) -> Self
```

**Purpose**: This converts one backend rate-limit window into a form that is ready to show in the terminal. It keeps the usage percentage, preserves the window length if known, and turns a reset timestamp into local human-readable text.

**Data flow**: It receives a raw `RateLimitWindow` and the local time when the snapshot was captured. It reads the used percentage, optional reset time, and optional window length; if a reset time exists, it converts it from a server timestamp into local time and formats it relative to the capture time. It returns a `RateLimitWindowDisplay` with those display-ready values.

**Call relations**: This is used while building a full display snapshot from backend data. `rate_limit_snapshot_display_for_limit` calls it for the primary and secondary windows so later row-building code does not need to know how server timestamps are interpreted.

*Call graph*: 1 external calls (from).


##### `rate_limit_snapshot_display`  (lines 137–142)

```
fn rate_limit_snapshot_display(
    snapshot: &RateLimitSnapshot,
    captured_at: DateTime<Local>,
) -> RateLimitSnapshotDisplay
```

**Purpose**: This test-only helper converts a backend snapshot into display data using the default limit name, `codex`. It gives tests a short path for making the same display object the real code uses.

**Data flow**: It receives a raw `RateLimitSnapshot` and a capture time. It adds the default limit name and passes everything through to the more general converter. The output is a `RateLimitSnapshotDisplay` ready for row composition.

**Call relations**: It is a convenience wrapper around `rate_limit_snapshot_display_for_limit`. It exists so tests or test-only code do not have to repeat the default limit name every time.

*Call graph*: calls 1 internal fn (rate_limit_snapshot_display_for_limit).


##### `rate_limit_snapshot_display_for_limit`  (lines 144–166)

```
fn rate_limit_snapshot_display_for_limit(
    snapshot: &RateLimitSnapshot,
    limit_name: String,
    captured_at: DateTime<Local>,
) -> RateLimitSnapshotDisplay
```

**Purpose**: This converts a complete backend rate-limit snapshot into the file’s display-friendly snapshot type. It is used when the caller knows which named limit bucket the data belongs to.

**Data flow**: It receives raw snapshot data, a limit name, and the local capture time. It converts primary and secondary windows with `RateLimitWindowDisplay::from_window`, converts credits with `CreditsSnapshotDisplay::from`, and converts monthly spend-control data with `SpendControlLimitSnapshotDisplay::from_limit` when possible. It returns one `RateLimitSnapshotDisplay` containing all display-ready pieces.

**Call relations**: The simpler `rate_limit_snapshot_display` calls this with the default `codex` name. The rows shown in status views are built later from the structure this function creates.

*Call graph*: called by 1 (rate_limit_snapshot_display).


##### `CreditsSnapshotDisplay::from`  (lines 169–175)

```
fn from(value: &CoreCreditsSnapshot) -> Self
```

**Purpose**: This copies backend credit information into a smaller display-focused structure. It keeps only the facts the status UI needs: whether credits exist, whether they are unlimited, and the balance text.

**Data flow**: It receives a backend credits snapshot. It copies the credit flags and clones the optional balance string. It returns a `CreditsSnapshotDisplay` without changing the meaning of the data.

**Call relations**: This conversion is used by `rate_limit_snapshot_display_for_limit` while preparing a full display snapshot. Later, `credit_status_row` decides whether that credit information should become a visible status row.


##### `SpendControlLimitSnapshotDisplay::from_limit`  (lines 179–191)

```
fn from_limit(
        value: &CoreSpendControlLimitSnapshot,
        captured_at: DateTime<Local>,
    ) -> Option<Self>
```

**Purpose**: This turns monthly spend-control data into a row-ready display object. It validates and formats credit amounts so the UI does not show broken or nonsensical numbers.

**Data flow**: It receives backend spend-control data and the capture time. It clamps the remaining percentage into the normal 0 to 100 range, formats the used and limit amounts as rounded credit counts with thousands separators, and formats the reset timestamp in local time. If either credit amount cannot be parsed safely, it returns nothing; otherwise it returns a display snapshot.

**Call relations**: This is called by `rate_limit_snapshot_display_for_limit` when a backend snapshot includes an individual monthly limit. It relies on `format_credit_amount` to clean up numeric strings before the row composer later turns the result into a `Monthly credit limit` row.

*Call graph*: calls 1 internal fn (format_credit_amount); 2 external calls (from_timestamp, from).


##### `compose_rate_limit_data`  (lines 198–206)

```
fn compose_rate_limit_data(
    snapshot: Option<&RateLimitSnapshotDisplay>,
    now: DateTime<Local>,
) -> StatusRateLimitData
```

**Purpose**: This is the single-snapshot entry point for building status data. It turns either one display snapshot or no snapshot into the status state the UI can render.

**Data flow**: It receives an optional `RateLimitSnapshotDisplay` and the current local time. If there is a snapshot, it wraps it as a one-item slice and sends it to `compose_rate_limit_data_many`; if there is no snapshot, it returns `Missing`. The result says whether display rows are available, stale, unavailable, or missing.

**Call relations**: Status code calls this during setup and after a rate-limit refresh finishes. It delegates the real row-building work to `compose_rate_limit_data_many` so single-snapshot and multi-snapshot paths behave the same way.

*Call graph*: calls 1 internal fn (compose_rate_limit_data_many); called by 2 (new, finish_rate_limit_refresh); 1 external calls (from_ref).


##### `compose_rate_limit_data_many`  (lines 208–337)

```
fn compose_rate_limit_data_many(
    snapshots: &[RateLimitSnapshotDisplay],
    now: DateTime<Local>,
) -> StatusRateLimitData
```

**Purpose**: This is the main row builder for the status display. It takes one or more display snapshots and produces the exact rows the TUI should show, while also deciding whether the data is stale.

**Data flow**: It receives a list of display snapshots and the current local time. It first returns `Missing` if the list is empty. For each snapshot, it checks whether the snapshot or its monthly limit is older than the 15-minute threshold, builds labels for primary and secondary usage windows, adds credit rows when credits are meaningful, and adds a monthly credit-limit row when present. At the end it returns `Unavailable` if no visible rows were produced, `Stale` if any included data is too old, or `Available` with the rows otherwise.

**Call relations**: This function is called directly by status setup and refresh code, by the single-snapshot wrapper `compose_rate_limit_data`, and by tests. It calls `credit_status_row` for the credits part and uses shared label helpers so rate-limit names match the rest of the chat/status UI.

*Call graph*: calls 1 internal fn (credit_status_row); called by 5 (new, finish_rate_limit_refresh, compose_rate_limit_data, non_codex_multi_limit_keeps_group_row, non_codex_single_limit_renders_combined_row); 11 external calls (minutes, signed_duration_since, new, with_capacity, format!, is_empty, len, Available, Stale, Text (+1 more)).


##### `render_status_limit_progress_bar`  (lines 343–353)

```
fn render_status_limit_progress_bar(percent_remaining: f64) -> String
```

**Purpose**: This draws a fixed-width text progress bar from a remaining percentage. It gives the terminal UI a compact visual indicator of how much limit is left.

**Data flow**: It receives a percentage remaining. It clamps that number into the valid 0 to 100 range, converts it into a number of filled blocks out of 20, fills the rest with empty blocks, and returns a string such as a bracketed bar. It does not change any outside state.

**Call relations**: Rendering code can call this after `compose_rate_limit_data_many` has produced window rows. The key convention is that the input is percent remaining, not percent used, so callers must convert if their source value is usage.

*Call graph*: 1 external calls (format!).


##### `format_status_limit_summary`  (lines 356–358)

```
fn format_status_limit_summary(percent_remaining: f64) -> String
```

**Purpose**: This turns a remaining percentage into a short phrase like `42% left`. It is used when the UI needs text beside or instead of a progress bar.

**Data flow**: It receives a percentage remaining. It rounds it to a whole-number display using formatting and returns a string ending in `% left`. It does not validate or store anything.

**Call relations**: The rate-limit row rendering path calls this when turning composed status rows into visible lines. It complements `render_status_limit_progress_bar` by providing the plain-text summary.

*Call graph*: called by 1 (rate_limit_row_lines); 1 external calls (format!).


##### `credit_status_row`  (lines 364–380)

```
fn credit_status_row(credits: &CreditsSnapshotDisplay) -> Option<StatusRateLimitRow>
```

**Purpose**: This decides whether credit information should appear as a status row, and if so, what that row should say. It hides accounts without credit tracking and avoids showing zero or invalid balances.

**Data flow**: It receives display-ready credit metadata. If credits are not enabled, it returns nothing. If credits are unlimited, it returns a `Credits` row with `Unlimited`. Otherwise it reads the balance string, formats it with `format_credit_balance`, and returns a `Credits` row like `25 credits` if the balance is positive and valid.

**Call relations**: `compose_rate_limit_data_many` calls this while assembling rows for each snapshot. This keeps credit-specific rules separate from the larger rate-limit row-building flow.

*Call graph*: calls 1 internal fn (format_credit_balance); called by 1 (compose_rate_limit_data_many); 2 external calls (format!, Text).


##### `format_credit_balance`  (lines 382–402)

```
fn format_credit_balance(raw: &str) -> Option<String>
```

**Purpose**: This cleans up a raw credit balance string for display. It accepts positive whole numbers or positive decimal numbers and rounds decimals to a whole credit count.

**Data flow**: It receives raw text, trims surrounding spaces, and rejects empty text. It first tries to parse a positive integer; if that works, it returns that number as text. If not, it tries to parse a positive decimal number, rounds it, and returns the rounded number as text. Invalid, zero, or negative input produces no result.

**Call relations**: `credit_status_row` uses this before showing a normal credit balance. By returning nothing for bad or non-positive input, it prevents the status UI from displaying misleading credit rows.

*Call graph*: called by 1 (credit_status_row).


##### `format_credit_amount`  (lines 404–410)

```
fn format_credit_amount(raw: &str) -> Option<String>
```

**Purpose**: This formats monthly spend-control amounts for display. It rounds a non-negative numeric string and adds separators so large credit amounts are easier to read.

**Data flow**: It receives raw text, trims and parses it as a decimal number, then rejects values that are not finite numbers or are below zero. Valid values are rounded to a whole number and formatted with separators, such as turning `12345` into `12,345`. It returns the formatted string or nothing if parsing fails.

**Call relations**: `SpendControlLimitSnapshotDisplay::from_limit` calls this for both the used amount and the limit amount. If either cannot be formatted, the monthly spend-control display is skipped rather than shown with bad data.

*Call graph*: calls 1 internal fn (format_with_separators); called by 1 (from_limit).


##### `tests::window`  (lines 422–428)

```
fn window(used_percent: f64) -> RateLimitWindowDisplay
```

**Purpose**: This test helper creates a simple rate-limit window display with a chosen used percentage. It keeps the tests focused on row-label behavior instead of repeating setup details.

**Data flow**: It receives a used percentage. It builds a `RateLimitWindowDisplay` with that percentage, a reset label of `soon`, and a five-hour window length. It returns the ready-made test window.

**Call relations**: The `tests::non_codex_single_limit_renders_combined_row` test calls this to create primary windows. It is only part of the test module and does not affect production behavior.


##### `tests::non_codex_single_limit_renders_combined_row`  (lines 431–474)

```
fn non_codex_single_limit_renders_combined_row()
```

**Purpose**: This test checks how labels are built when a non-default limit bucket has only one usage window. It verifies that the bucket name and window label are combined into one row instead of creating a separate group heading.

**Data flow**: It creates one default `codex` snapshot and one `codex-other` snapshot, each with a primary window and credits. It sends both through `compose_rate_limit_data_many`, extracts the row labels, and compares them with the expected labels. If the composed status is not available, the test fails.

**Call relations**: This test exercises `compose_rate_limit_data_many` and the `tests::window` helper. It protects the user-facing layout rule that a single non-default limit should read like `codex-other 5h limit` and should still show its credits row.

*Call graph*: calls 1 internal fn (compose_rate_limit_data_many); 4 external calls (now, assert_eq!, panic!, window).


##### `tests::non_codex_multi_limit_keeps_group_row`  (lines 477–509)

```
fn non_codex_multi_limit_keeps_group_row()
```

**Purpose**: This test checks how labels are built when a non-default limit bucket has both primary and secondary windows. It verifies that the UI keeps a separate group row for the bucket name.

**Data flow**: It creates a `codex-other` snapshot with two windows and no credits. It passes that snapshot into `compose_rate_limit_data_many`, extracts the labels, and compares them with the expected group label plus two limit labels. If row composition does not return available data, the test fails.

**Call relations**: This test directly exercises `compose_rate_limit_data_many`. It protects the layout rule that multiple limits under a non-default bucket should be grouped under a heading rather than repeating the bucket name on each row.

*Call graph*: calls 1 internal fn (compose_rate_limit_data_many); 3 external calls (now, assert_eq!, panic!).


### `tui/src/goal_files.rs`

`domain_logic` · `goal setup and goal editing`

A user can set a “goal” for a Codex thread, but that goal may include things that are awkward or impossible to send as plain inline text: huge pasted blocks, local image files, remote image links, or a very long objective. This file is the bridge between that rich draft and the simpler final objective that the app server can work with.

Its main job is like packing a large envelope: small notes can stay in the message, but bulky attachments get put into a folder, and the message says where to find them. It creates an attachment directory under `$CODEX_HOME/attachments/<random id>`, writes pasted text and images into that directory, and updates the goal text so Codex knows to read those files. If the whole objective is still too large, it writes the entire objective to `goal-objective.md` and replaces the submitted objective with a short instruction pointing to that file.

The file also supports editing later. If the current goal is just one of these “read this goal file” references, it can recognize the trusted path shape, read the file back, and show the real text to the user. Important safeguards include rejecting empty goals, checking that generated references are not themselves too long, and only treating objective-file references as valid when they match the expected attachments folder and random UUID directory.

#### Function details

##### `materialize_goal_draft`  (lines 33–138)

```
async fn materialize_goal_draft(
    app_server: &mut AppServerSession,
    codex_home: Option<&GoalFilePath>,
    draft: GoalDraft,
) -> Result<(String, Option<GoalFilePath>)>
```

**Purpose**: Turns a draft goal into the final goal text that can be submitted. It writes large pasted text, local images, and over-long objectives into app-server files, then replaces those parts with readable references.

**Data flow**: It receives an app-server session, an optional `$CODEX_HOME` path, and a `GoalDraft` containing the user's objective plus pasted text and images. It checks that the objective is not empty, creates an attachments folder only if needed, writes paste and image bytes into that folder, rewrites placeholders in the objective to point at those files, adds sections for unplaced images and remote image URLs, and finally writes the whole objective to `goal-objective.md` if it is still too long. It returns the final objective string plus the attachment directory path if one was created.

**Call relations**: This is called by `set_thread_goal_draft` when the user commits a goal draft. It leans on `ChatComposer::expand_pending_pastes` to replace placeholders, uses `ensure_goal_output_dir` before writing any attachment, uses `image_extension` to name image files safely, uses `write_goal_file` for app-server file writes, uses `append_section` to add readable image lists, and uses `objective_file_reference` when the full objective must become a file reference.

*Call graph*: calls 6 internal fn (expand_pending_pastes, append_section, ensure_goal_output_dir, image_extension, objective_file_reference, write_goal_file); called by 1 (set_thread_goal_draft); 5 external calls (new, bail!, format!, read, fs_remove_path).


##### `objective_text_for_edit`  (lines 140–155)

```
async fn objective_text_for_edit(
    app_server: &mut AppServerSession,
    codex_home: Option<&GoalFilePath>,
    objective: &str,
) -> Result<String>
```

**Purpose**: Gets the real editable goal text for the goal editor. If the stored objective is only a pointer to a goal file, it reads that file back; otherwise it returns the objective as-is.

**Data flow**: It receives an app-server session, an optional `$CODEX_HOME` path, and the current objective string. It asks `objective_file_path` whether the string is a valid generated file reference. If not, it returns the original text. If yes, it reads the referenced file through the app server and converts the bytes into UTF-8 text. The output is the text the editor should show to the user.

**Call relations**: This is called by `open_thread_goal_editor` when the UI needs to display an existing goal for editing. It delegates the safety check and path extraction to `objective_file_path`, then uses the app-server file-read operation to fetch the saved objective content.

*Call graph*: calls 1 internal fn (objective_file_path); called by 1 (open_thread_goal_editor); 2 external calls (from_utf8, fs_read_file_path).


##### `objective_file_path`  (lines 157–172)

```
fn objective_file_path(
    objective: &str,
    codex_home: Option<&GoalFilePath>,
) -> Option<GoalFilePath>
```

**Purpose**: Checks whether an objective string is one of this file's generated “read the goal file” references. It only accepts references that point to the expected goal-objective file under the current Codex attachments directory.

**Data flow**: It receives the objective text and the optional `$CODEX_HOME` path. It strips the known reference prefix and suffix, parses the middle as an absolute app-server path, and compares it with the exact expected path: `$CODEX_HOME/attachments/<uuid>/goal-objective.md`. It also checks that the attachment folder name is a valid UUID. It returns the path only if all checks pass; otherwise it returns nothing.

**Call relations**: This is used by `objective_text_for_edit` before reading any referenced file. Its job is to prevent arbitrary text from being treated as a file path, so the editor only opens goal files that match the format produced by this same module.

*Call graph*: calls 1 internal fn (from_absolute_str); called by 1 (objective_text_for_edit); 1 external calls (parse_str).


##### `objective_file_reference`  (lines 174–183)

```
fn objective_file_reference(path: &GoalFilePath) -> Result<String>
```

**Purpose**: Builds the short instruction that tells Codex to read a saved goal objective file. It also makes sure that this instruction is not longer than the protocol allows.

**Data flow**: It receives the app-server path to a saved goal file. It wraps that path in a fixed sentence: read this file before continuing. It counts the characters in that sentence and returns an error if even the reference is too long. Otherwise it returns the reference string.

**Call relations**: This is called by `materialize_goal_draft` when the full objective has exceeded the maximum allowed inline size. If this function fails, `materialize_goal_draft` cleans up the created output directory where possible and returns the error instead of submitting an unusable goal.

*Call graph*: called by 1 (materialize_goal_draft); 2 external calls (bail!, format!).


##### `ensure_goal_output_dir`  (lines 185–205)

```
async fn ensure_goal_output_dir(
    app_server: &mut AppServerSession,
    codex_home: Option<&GoalFilePath>,
    output_dir: &mut Option<GoalFilePath>,
) -> Result<GoalFilePath>
```

**Purpose**: Creates, or reuses, the attachment directory where goal-related files will be written. It avoids creating the directory until the code actually needs to store a paste, image, or full objective file.

**Data flow**: It receives the app-server session, the optional `$CODEX_HOME` path, and a mutable slot that may already contain the output directory. If the slot already has a path, it returns that path. If not, it requires `$CODEX_HOME`, makes a new directory under `attachments` using a fresh UUID as the folder name, stores that path in the slot, and returns it.

**Call relations**: This helper is called by `materialize_goal_draft` before every kind of file output. It centralizes the “make one attachment folder for this goal” behavior so pasted text, images, and the full goal file all land in the same generated directory.

*Call graph*: called by 1 (materialize_goal_draft); 2 external calls (new_v4, fs_create_directory_all_path).


##### `write_goal_file`  (lines 207–217)

```
async fn write_goal_file(
    app_server: &mut AppServerSession,
    path: GoalFilePath,
    bytes: Vec<u8>,
) -> Result<()>
```

**Purpose**: Writes one goal attachment file through the app server. It is the small wrapper that turns a target path and bytes into an app-server file write with a helpful error message if it fails.

**Data flow**: It receives the app-server session, the destination app-server path, and the file contents as bytes. It sends those bytes to the app server's file-writing API. It returns success when the write completes, or an error that names the file that could not be written.

**Call relations**: This is called by `materialize_goal_draft` for pasted text files, local image files, and the final `goal-objective.md` file. Keeping the write in one helper gives all those cases the same error handling.

*Call graph*: called by 1 (materialize_goal_draft); 1 external calls (fs_write_file_path).


##### `append_section`  (lines 218–228)

```
fn append_section(objective: &mut String, heading: &str, lines: Vec<String>)
```

**Purpose**: Adds a simple titled section to the end of the goal text, but only when there are lines to add. It is used for lists of referenced images and image URLs.

**Data flow**: It receives the objective string to modify, a heading, and a list of lines. If the list is empty, it changes nothing. If there are lines, it adds spacing if needed, appends the heading, then appends the lines joined by newlines. The same objective string is updated in place.

**Call relations**: This is called by `materialize_goal_draft` after paste and image placeholders have been processed. It adds human-readable sections for images that were not inserted through a placeholder and for remote image URLs supplied with the draft.

*Call graph*: called by 1 (materialize_goal_draft).


##### `image_extension`  (lines 230–242)

```
fn image_extension(path: &Path) -> String
```

**Purpose**: Chooses a safe file extension for a copied local image. It keeps only simple letters and numbers, limits the length, and falls back to `png` when no usable extension exists.

**Data flow**: It receives a local file path. It looks at the path's extension, converts it to text if possible, removes any non-alphanumeric characters, and keeps at most eight characters. If that produces an empty result, it returns `png`. The output is used as the extension for the image file written into the goal attachments folder.

**Call relations**: This is called by `materialize_goal_draft` while saving local images. It helps create predictable attachment filenames like `image-1.png` without trusting unusual or unsafe extension text from the original path.

*Call graph*: called by 1 (materialize_goal_draft); 1 external calls (extension).


### TUI transcript and history updates
These files project persisted or live thread items into transcript cells, separators, diff models, and terminal-history updates visible to the user.

### `tui/src/app/history_ui.rs`

`orchestration` · `cross-cutting during chat display, clear-screen actions, and link/Desktop handoff`

A terminal chat app has two kinds of memory: the conversation data it keeps internally, and the lines already drawn on the user’s screen. This file keeps those two in step. When a new history item arrives, it adds it to the transcript, redraws any transcript overlay, wraps the text to the current terminal width, and makes sure delayed usage information can appear at the right time. It also knows how to open ordinary links in a browser and how to hand the current thread to Codex Desktop using a special codex:// link.

The other major job is clearing the UI. Clearing a terminal is trickier than it sounds because some terminals keep old scrollback differently, and the app may be using an alternate screen, which is like a separate full-screen workspace. This file chooses the right kind of clear, drops any queued old lines so they cannot reappear, resets transcript-related state, and optionally redraws a fresh session header showing things like the model and working directory.

Think of it like a stage crew between scenes: it removes old props, resets the backdrop, and places the opening sign again so the next scene starts cleanly.

#### Function details

##### `App::insert_history_cell`  (lines 11–36)

```
fn insert_history_cell(&mut self, tui: &mut tui::Tui, cell: Box<dyn HistoryCell>)
```

**Purpose**: Adds one completed item to the visible chat history and to the app’s stored transcript. This is used when something should become a permanent part of the conversation display, such as a message or a usage card.

**Data flow**: It receives a history cell and the terminal UI object. It turns the cell into shared storage, adds it to any open transcript overlay, stores it in the app’s transcript list, renders its lines at the current wrap width, and finally asks the chat widget to check whether delayed usage output can now be shown.

**Call relations**: When pending usage output is ready, App::insert_pending_usage_output calls this function to commit those usage cells into history. If a transcript overlay is open, this function also asks the frame requester for a redraw so the overlay catches up with the newly inserted cell.

*Call graph*: called by 1 (insert_pending_usage_output); 1 external calls (frame_requester).


##### `App::pending_usage_output_insertion_blocked`  (lines 38–44)

```
fn pending_usage_output_insertion_blocked(&self) -> bool
```

**Purpose**: Answers the question: “Is it safe to insert delayed usage information into the history right now?” It prevents usage cards from appearing in the middle of an active or not-yet-settled message.

**Data flow**: It reads the chat widget’s insertion-blocked flag and checks the most recent transcript cell. If the chat widget says insertion is blocked, or the last cell is still an agent message, it returns true; otherwise it returns false.

**Call relations**: App::insert_pending_usage_output_if_ready asks this first before inserting usage output. This keeps usage information from being placed before the conversation has reached a clean stopping point.

*Call graph*: called by 1 (insert_pending_usage_output_if_ready).


##### `App::insert_pending_usage_output`  (lines 46–53)

```
fn insert_pending_usage_output(&mut self, tui: &mut tui::Tui)
```

**Purpose**: Moves completed usage-related notices from the chat widget into the permanent history. These notices can include token activity output or a rate-limit reset hint.

**Data flow**: It asks the chat widget whether there is completed token activity output waiting. If there is, it wraps that output as a history cell and inserts it. It then does the same for a pending rate-limit reset hint. The result is that queued notices become normal transcript entries.

**Call relations**: Both App::insert_pending_usage_output_if_ready and App::insert_pending_usage_output_after_stream_shutdown call this after deciding that insertion is allowed. This function then hands each produced cell to App::insert_history_cell so it is stored and rendered like any other history item.

*Call graph*: calls 1 internal fn (insert_history_cell); called by 2 (insert_pending_usage_output_after_stream_shutdown, insert_pending_usage_output_if_ready); 1 external calls (new).


##### `App::insert_pending_usage_output_if_ready`  (lines 55–60)

```
fn insert_pending_usage_output_if_ready(&mut self, tui: &mut tui::Tui)
```

**Purpose**: Inserts delayed usage information only if the current conversation state is safe for it. It is the cautious path used while the UI may still have active or provisional content.

**Data flow**: It receives the terminal UI object, checks whether usage insertion is blocked, and stops immediately if it is. If not blocked, it pulls pending usage output into the history.

**Call relations**: This function first consults App::pending_usage_output_insertion_blocked. If the answer is no, it continues to App::insert_pending_usage_output, which performs the actual insertion.

*Call graph*: calls 2 internal fn (insert_pending_usage_output, pending_usage_output_insertion_blocked).


##### `App::insert_pending_usage_output_after_stream_shutdown`  (lines 62–67)

```
fn insert_pending_usage_output_after_stream_shutdown(&mut self, tui: &mut tui::Tui)
```

**Purpose**: Inserts delayed usage information after a response stream has shut down, while still respecting the chat widget’s own blocking state. It is a slightly different timing path for the end of streaming output.

**Data flow**: It checks whether the chat widget still says usage history insertion is blocked. If blocked, nothing changes. If clear, it moves pending usage notices into the transcript.

**Call relations**: This function calls App::insert_pending_usage_output once stream shutdown has made insertion mostly safe. Unlike App::insert_pending_usage_output_if_ready, it does not also check whether the last transcript cell is an agent message.

*Call graph*: calls 1 internal fn (insert_pending_usage_output).


##### `App::open_url_in_browser`  (lines 69–78)

```
fn open_url_in_browser(&mut self, url: String)
```

**Purpose**: Opens a normal web link in the user’s default browser and reports success or failure inside the chat UI. This lets the terminal app launch external documentation or web pages without silently failing.

**Data flow**: It takes a URL string and asks the operating system to open it through the default browser. If that fails, it adds an error message to the chat widget. If it succeeds, it adds an informational message saying the link was opened.

**Call relations**: This function relies on the external browser-opening library to do the actual system handoff. It does not call other app functions; instead, it reports the result directly through the chat widget so the user gets immediate feedback.

*Call graph*: 2 external calls (format!, open).


##### `App::open_desktop_thread`  (lines 80–92)

```
fn open_desktop_thread(&mut self, thread_id: ThreadId)
```

**Purpose**: Opens the current Codex thread in Codex Desktop, when that is supported. It gives the user a bridge from the terminal session to the desktop app.

**Data flow**: It receives a thread identifier, builds a codex://threads/... link, and asks the operating system-specific helper to open it. On failure, it turns the error into a friendly chat message. On success, it adds a short confirmation message.

**Call relations**: This function calls open_desktop_thread_url for the platform-specific launch work. If that helper returns an error, it passes the error through desktop_thread_open_error_message so the user sees a clear next step.

*Call graph*: calls 2 internal fn (desktop_thread_open_error_message, open_desktop_thread_url); 1 external calls (format!).


##### `App::clear_ui_header_lines_with_version`  (lines 94–111)

```
fn clear_ui_header_lines_with_version(
        &self,
        width: u16,
        version: &'static str,
    ) -> Vec<Line<'static>>
```

**Purpose**: Builds the fresh session header lines that appear after the UI is cleared. The header summarizes the current session, such as model, reasoning setting, working directory, version, and special modes.

**Data flow**: It reads current display settings from the chat widget and configuration, combines them with the requested terminal width and supplied version string, creates a session header history cell, and asks that cell for display-ready lines.

**Call relations**: App::clear_ui_header_lines calls this with the normal CLI version. This function delegates the actual header layout to the session header history cell, while this method supplies the app-specific facts that should appear in it.

*Call graph*: calls 1 internal fn (new); called by 1 (clear_ui_header_lines); 1 external calls (is_yolo_mode).


##### `App::clear_ui_header_lines`  (lines 113–115)

```
fn clear_ui_header_lines(&self, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Builds the normal fresh session header using the app’s current CLI version. It is the standard path used when the screen is cleared and the header needs to be redrawn.

**Data flow**: It receives a target width, supplies the built-in Codex CLI version, and returns the formatted header lines produced for that width.

**Call relations**: App::queue_clear_ui_header calls this when it is time to put a new header into the terminal history. This function is a small wrapper around App::clear_ui_header_lines_with_version.

*Call graph*: calls 1 internal fn (clear_ui_header_lines_with_version); called by 1 (queue_clear_ui_header).


##### `App::queue_clear_ui_header`  (lines 117–126)

```
fn queue_clear_ui_header(&mut self, tui: &mut tui::Tui)
```

**Purpose**: Adds a freshly built session header to the terminal’s history output after a clear. This makes the cleared screen start with useful context instead of being completely blank.

**Data flow**: It reads the terminal’s last known width, asks the chat widget what wrapping width should be used, builds header lines, and inserts those lines into the terminal history if there is anything to show. It also records that history lines have been emitted.

**Call relations**: App::clear_terminal_ui calls this when the caller wants the header redrawn after clearing. It uses App::clear_ui_header_lines to create the text, then hands the finished lines to the TUI for insertion.

*Call graph*: calls 1 internal fn (clear_ui_header_lines); called by 1 (clear_terminal_ui); 1 external calls (insert_history_lines).


##### `App::clear_terminal_ui`  (lines 128–159)

```
fn clear_terminal_ui(
        &mut self,
        tui: &mut tui::Tui,
        redraw_header: bool,
    ) -> Result<()>
```

**Purpose**: Clears the visible terminal UI and, if requested, redraws a fresh session header. It prevents old transcript lines from coming back after a user runs clear-like actions such as /clear or Ctrl-L.

**Data flow**: It receives the terminal UI object and a flag saying whether to redraw the header. It first drops queued history lines, then chooses the correct clear method depending on whether the terminal is in the alternate screen. It resets the viewport position when needed, marks history as not emitted, optionally queues a new header, and returns success or an error from terminal clearing.

**Call relations**: This function is the main clear-screen operation in this file. It asks the TUI whether the alternate screen is active, tells the TUI to discard pending history lines, performs terminal clearing, and calls App::queue_clear_ui_header if a new header should be shown.

*Call graph*: calls 1 internal fn (queue_clear_ui_header); 2 external calls (clear_pending_history_lines, is_alt_screen_active).


##### `App::reset_app_ui_state_after_clear`  (lines 161–163)

```
fn reset_app_ui_state_after_clear(&mut self)
```

**Purpose**: Resets the app’s UI-related memory after a clear action. It is a simple public-facing step that keeps clear behavior consistent.

**Data flow**: It takes the current app state and forwards the reset work to the transcript-specific reset function. After it runs, transcript display state has been wiped clean.

**Call relations**: This function calls App::reset_transcript_state_after_clear. It exists as the broader app-level reset hook, even though today the work is transcript-focused.

*Call graph*: calls 1 internal fn (reset_transcript_state_after_clear).


##### `App::reset_transcript_state_after_clear`  (lines 165–177)

```
fn reset_transcript_state_after_clear(&mut self)
```

**Purpose**: Wipes transcript and history-display state after the screen is cleared. This stops old messages, overlays, queued redraws, and warning state from leaking into the new clean display.

**Data flow**: It mutates the app in place: removes any overlay, clears stored transcript cells and deferred lines, marks history as not emitted, clears reflow and pending usage hints, removes the initial replay buffer, resets backtracking state to its default, and clears skill-load warnings.

**Call relations**: App::reset_app_ui_state_after_clear calls this as the actual reset operation. It also relies on a default backtracking state so the app returns to a known clean baseline.

*Call graph*: called by 1 (reset_app_ui_state_after_clear); 1 external calls (default).


##### `desktop_thread_open_error_message`  (lines 180–184)

```
fn desktop_thread_open_error_message(err: &str) -> String
```

**Purpose**: Turns a low-level Codex Desktop launch error into a message a user can act on. It explains that opening failed and suggests installing or launching Codex Desktop.

**Data flow**: It receives an error string, places it inside a fuller sentence, and returns that finished message.

**Call relations**: App::open_desktop_thread calls this when open_desktop_thread_url fails. This keeps the user-facing wording in one place instead of spreading it through the launch logic.

*Call graph*: called by 1 (open_desktop_thread); 1 external calls (format!).


##### `windows_desktop_app_launch_script`  (lines 226–254)

```
fn windows_desktop_app_launch_script(url: &str) -> String
```

**Purpose**: Builds the PowerShell script used on Windows to launch Codex Desktop with a thread URL. It works around the need to locate the installed app package and start the correct executable with the correct arguments.

**Data flow**: It receives the codex:// URL, escapes it so it is safe inside a single-quoted PowerShell string, and returns a multi-line script. That script checks whether the Codex Desktop package, executable, and app bundle exist, then starts Codex.exe with the thread URL.

**Call relations**: The Windows version of open_desktop_thread_url calls this to get the script it will pass to PowerShell. It calls powershell_single_quoted_string first so the URL can be embedded safely.

*Call graph*: calls 1 internal fn (powershell_single_quoted_string); called by 1 (open_desktop_thread_url); 1 external calls (format!).


##### `powershell_single_quoted_string`  (lines 257–259)

```
fn powershell_single_quoted_string(value: &str) -> String
```

**Purpose**: Escapes a value so it can be safely placed inside a single-quoted PowerShell string. This avoids breaking the generated script when the value contains an apostrophe.

**Data flow**: It receives a plain string, doubles any single quote characters inside it, wraps the result in single quotes, and returns the escaped PowerShell literal.

**Call relations**: windows_desktop_app_launch_script calls this before inserting the URL into its generated script. That lets the script builder focus on the launch steps while this helper handles safe quoting.

*Call graph*: called by 1 (windows_desktop_app_launch_script); 1 external calls (format!).


##### `open_desktop_thread_url`  (lines 262–264)

```
fn open_desktop_thread_url(_url: &str) -> Result<(), String>
```

**Purpose**: Performs the operating-system-specific work of opening a Codex Desktop thread URL. On supported desktop systems it tries to launch the app; on unsupported systems it reports that Codex Desktop is unavailable.

**Data flow**: It receives a codex:// thread URL. Depending on the operating system, it may ask macOS to open the URL, run a generated PowerShell launch script on Windows, or immediately return an unsupported-platform error. It returns success if the launch command worked, or an error string explaining what failed.

**Call relations**: App::open_desktop_thread calls this after building the thread URL. On Windows, this helper uses windows_desktop_app_launch_script to prepare the PowerShell command, then turns command output or failure status into a message for the caller.

*Call graph*: calls 1 internal fn (windows_desktop_app_launch_script); called by 1 (open_desktop_thread); 3 external calls (from_utf8_lossy, new, format!).


### `tui/src/chatwidget/tool_lifecycle.rs`

`orchestration` · `during chat event handling and transcript rendering`

A chat answer is not always just text. The assistant may edit files, search the web, call an external MCP tool, generate or view an image, or coordinate with another agent. This file is the part of `ChatWidget` that makes those events understandable to the user by adding the right “cells” to the transcript, which is the visible chat history. Think of it like a stage manager: when a tool starts, it puts a live status card on stage; when the tool finishes, it replaces or completes that card so the audience sees what happened. Some events are shown immediately. Others may be deferred, meaning they are put in a small waiting line so the UI can keep related start and finish events in a sensible order. The file also keeps track of whether real work happened during the turn, which matters for later UI behavior. A key detail is the “active cell”: a temporary live transcript entry used for things in progress, such as a web search or MCP call. When the work finishes, the active cell is completed and flushed into normal history. If the matching live cell is missing, the code still creates a finished history entry so the user does not lose the event.

#### Function details

##### `ChatWidget::on_patch_apply_begin`  (lines 9–12)

```
fn on_patch_apply_begin(&mut self, changes: HashMap<PathBuf, FileChange>)
```

**Purpose**: Shows that a file patch is starting. It gives the user a visible summary of the files that are about to be changed.

**Data flow**: It receives a set of file changes and reads the current working directory from the widget configuration. It records that visible work happened, turns the changes into a patch-history cell with paths shown relative to the current project, and appends that cell to the transcript.

**Call relations**: When a patch-apply event arrives, this function creates the transcript entry through `new_patch_event`. Later completion is dealt with separately by the file-change completion path.

*Call graph*: 1 external calls (new_patch_event).


##### `ChatWidget::on_view_image_tool_call`  (lines 14–22)

```
fn on_view_image_tool_call(&mut self, path: AbsolutePathBuf)
```

**Purpose**: Adds a visible transcript entry when the assistant asks to view an image file. This keeps image inspection from being hidden behind plain text output.

**Data flow**: It receives an absolute image path, notes that visible activity happened, finishes any answer text currently streaming, builds an image-view history cell using the project directory for display, adds it to history, and asks the UI to redraw.

**Call relations**: This function is used when an image-view tool event arrives. It hands the display formatting to `new_view_image_tool_call` and then makes the chat screen refresh so the new entry appears.

*Call graph*: 1 external calls (new_view_image_tool_call).


##### `ChatWidget::on_image_generation_begin`  (lines 24–27)

```
fn on_image_generation_begin(&mut self)
```

**Purpose**: Prepares the transcript when image generation starts. It separates any in-progress assistant text from the upcoming image-generation result.

**Data flow**: It takes no event details. It records visible activity and flushes any streamed answer text with a separator, leaving the transcript ready for the image-generation completion entry.

**Call relations**: This is the beginning half of the image-generation flow. The matching ending details are shown later by `ChatWidget::on_image_generation_end`.


##### `ChatWidget::on_image_generation_end`  (lines 29–44)

```
fn on_image_generation_end(
        &mut self,
        call_id: String,
        status: String,
        revised_prompt: Option<String>,
        saved_path: Option<AbsolutePathBuf>,
    )
```

**Purpose**: Adds the final transcript entry for an image-generation request. It shows whether the request succeeded, what prompt was used or revised, and where the generated image was saved if available.

**Data flow**: It receives the tool call id, status text, optional revised prompt, and optional saved file path. It first finishes any streamed answer text, then creates and appends an image-generation history cell, and finally asks the UI to redraw.

**Call relations**: This function is the completion half of the image-generation flow. It uses `new_image_generation_call` to turn the raw result details into something the transcript can display.

*Call graph*: 1 external calls (new_image_generation_call).


##### `ChatWidget::on_file_change_completed`  (lines 46–52)

```
fn on_file_change_completed(&mut self, item: ThreadItem)
```

**Purpose**: Routes a completed file-change event either to be handled now or saved for later. This helps keep tool updates in a readable order on screen.

**Data flow**: It receives a thread item describing a file change. Because the item may need to be used in either a queue path or an immediate path, it makes a copy, then asks the widget to defer the item or process it right away.

**Call relations**: This function is the public event-facing wrapper for file-change completion. If handled immediately, it leads to `ChatWidget::handle_file_change_completed_now`; if deferred, the item is later completed through the queued-item completion path.

*Call graph*: 1 external calls (clone).


##### `ChatWidget::on_mcp_tool_call_started`  (lines 54–60)

```
fn on_mcp_tool_call_started(&mut self, item: ThreadItem)
```

**Purpose**: Routes the start of an MCP tool call so it can be displayed at the right time. MCP means Model Context Protocol, a standard way for the app to call external tools or services.

**Data flow**: It receives a thread item describing the MCP call. It copies the item, then either stores the start event in a queue or immediately starts the visible MCP tool-call cell.

**Call relations**: This is the event-facing wrapper for MCP tool starts. If the event is processed now, it hands off to `ChatWidget::handle_mcp_tool_call_started_now`; otherwise the queued start is later passed through `ChatWidget::handle_queued_item_started_now`.

*Call graph*: 1 external calls (clone).


##### `ChatWidget::on_mcp_tool_call_completed`  (lines 62–68)

```
fn on_mcp_tool_call_completed(&mut self, item: ThreadItem)
```

**Purpose**: Routes the completion of an MCP tool call so the transcript can show the final result in order. It prevents a finish message from appearing before the matching start display is ready.

**Data flow**: It receives a thread item describing the completed MCP call. It copies the item, then either queues the completion event or immediately updates the visible MCP tool-call entry.

**Call relations**: This is the event-facing wrapper for MCP tool completions. If processed now, it leads to `ChatWidget::handle_mcp_tool_call_completed_now`; if queued, it is later handled through `ChatWidget::handle_queued_item_completed_now`.

*Call graph*: 1 external calls (clone).


##### `ChatWidget::on_web_search_begin`  (lines 70–81)

```
fn on_web_search_begin(&mut self, call_id: String)
```

**Purpose**: Shows a live web-search entry while a search is in progress. This tells the user that the assistant is actively looking something up rather than silently waiting.

**Data flow**: It receives a search call id. It records visible activity, flushes any streamed answer text and any previous active cell, creates a new active web-search cell with an empty query for now, marks that active cell as changed, and requests a redraw.

**Call relations**: This starts the web-search display flow. It relies on `new_active_web_search_call` to create the live transcript cell, which `ChatWidget::on_web_search_end` later tries to complete.

*Call graph*: 3 external calls (new, new, new_active_web_search_call).


##### `ChatWidget::on_web_search_end`  (lines 83–109)

```
fn on_web_search_end(
        &mut self,
        call_id: String,
        query: String,
        action: codex_app_server_protocol::WebSearchAction,
    )
```

**Purpose**: Completes a web-search transcript entry. It either updates the live search card that is already on screen or creates a finished entry if the live card is no longer there.

**Data flow**: It receives the search call id, the final query text, and the search action/result description. It finishes any streamed answer text, checks whether the current active cell is the matching web-search cell, and if so updates, completes, and flushes it. If not, it creates a normal completed web-search history cell. It also marks that work activity happened.

**Call relations**: This is paired with `ChatWidget::on_web_search_begin`. It clones the action and query when updating the live cell, and falls back to `new_web_search_call` when there is no matching active cell to complete.

*Call graph*: 2 external calls (clone, new_web_search_call).


##### `ChatWidget::on_collab_event`  (lines 111–115)

```
fn on_collab_event(&mut self, cell: PlainHistoryCell)
```

**Purpose**: Adds a collaborator-related entry to the transcript. It is a small shared path used after collaborator events have already been turned into displayable cells.

**Data flow**: It receives a plain history cell. It flushes any streamed answer text first, appends the collaborator cell to the transcript, and requests a redraw so the user sees it.

**Call relations**: This helper is called by `ChatWidget::on_collab_agent_tool_call` and `ChatWidget::on_sub_agent_activity` after those functions decide what collaborator message should be shown.

*Call graph*: called by 2 (on_collab_agent_tool_call, on_sub_agent_activity).


##### `ChatWidget::on_collab_agent_tool_call`  (lines 117–147)

```
fn on_collab_agent_tool_call(&mut self, item: ThreadItem)
```

**Purpose**: Shows tool activity performed by a collaborating agent. It has special care for agent-spawning requests so the start details can still be shown when the completion event arrives.

**Data flow**: It receives a thread item and first checks that it is a collaborator tool-call item. For spawn-agent calls, it may save a short summary while the call is in progress, then remove and reuse that saved summary when the call finishes. It asks the multi-agent display code to build a history cell, and if one is produced, it sends it to `on_collab_event`.

**Call relations**: This function turns raw collaborator tool-call events into transcript entries. It uses `spawn_request_summary` to remember spawn details and `tool_call_history_cell` to make the visible cell, then delegates the actual transcript insertion to `ChatWidget::on_collab_event`.

*Call graph*: calls 3 internal fn (on_collab_event, spawn_request_summary, tool_call_history_cell); 1 external calls (matches!).


##### `ChatWidget::on_sub_agent_activity`  (lines 149–154)

```
fn on_sub_agent_activity(&mut self, item: ThreadItem)
```

**Purpose**: Shows activity reported by a sub-agent, which is another agent working under the main conversation. This keeps background collaboration visible to the user.

**Data flow**: It receives a thread item, records visible activity, asks the multi-agent code whether the item should become a history cell, and if so adds that cell to the transcript.

**Call relations**: This function is the sub-agent counterpart to collaborator tool-call rendering. It uses `sub_agent_activity_history_cell` to translate the event into display text, then passes the result to `ChatWidget::on_collab_event`.

*Call graph*: calls 2 internal fn (on_collab_event, sub_agent_activity_history_cell).


##### `ChatWidget::handle_file_change_completed_now`  (lines 156–167)

```
fn handle_file_change_completed_now(&mut self, item: ThreadItem)
```

**Purpose**: Immediately processes a completed file-change event. It only adds an extra transcript entry when the patch failed, because successful edits are already represented by the earlier “edited” display.

**Data flow**: It receives a thread item and ignores it unless it is a file-change item. If the status says the patch failed, it appends a patch-failure history cell. In all file-change cases that reach this point, it marks that real work activity happened.

**Call relations**: This is called from `ChatWidget::handle_queued_item_completed_now` when a queued file-change completion is ready to be processed. It uses `new_patch_apply_failure` only for the failure case.

*Call graph*: called by 1 (handle_queued_item_completed_now); 3 external calls (new, new_patch_apply_failure, matches!).


##### `ChatWidget::handle_mcp_tool_call_started_now`  (lines 169–194)

```
fn handle_mcp_tool_call_started_now(&mut self, item: ThreadItem)
```

**Purpose**: Immediately shows a live transcript cell for an MCP tool call that has just started. The user can see which external server and tool are being invoked.

**Data flow**: It receives a thread item and ignores it unless it is an MCP tool-call item. It extracts the call id, server, tool name, and arguments, flushes any answer text and current active cell, creates a new active MCP tool-call cell, marks it as changed, and requests a redraw.

**Call relations**: This function is called from `ChatWidget::handle_queued_item_started_now` for queued starts, and also serves the immediate path from the MCP start wrapper. It builds the live display with `new_active_mcp_tool_call`.

*Call graph*: called by 1 (handle_queued_item_started_now); 2 external calls (new, new_active_mcp_tool_call).


##### `ChatWidget::handle_mcp_tool_call_completed_now`  (lines 196–255)

```
fn handle_mcp_tool_call_completed_now(&mut self, item: ThreadItem)
```

**Purpose**: Immediately completes the display for an MCP tool call. It turns the raw success or error details into a finished transcript entry and preserves any extra output cell the MCP display creates.

**Data flow**: It receives a thread item and ignores it unless it is an MCP tool-call item. It extracts the call id, tool identity, arguments, result or error, and duration. It converts the duration into a time span and turns the result into either success data or an error message. If the current active cell matches the call id, it completes that cell; otherwise it creates a new active cell first so the completion still has somewhere to land. It flushes the finished cell, adds any extra cell produced by completion, and marks that work activity happened.

**Call relations**: This function is called from `ChatWidget::handle_queued_item_completed_now` for queued completions, and also supports the immediate MCP completion path. It uses `new_active_mcp_tool_call` as a fallback when the matching live cell is not already active.

*Call graph*: called by 1 (handle_queued_item_completed_now); 3 external calls (new, from_millis, new_active_mcp_tool_call).


##### `ChatWidget::handle_queued_item_started_now`  (lines 257–267)

```
fn handle_queued_item_started_now(&mut self, item: ThreadItem)
```

**Purpose**: Dispatches a queued “started” event to the right immediate handler. It is a small switchboard for start events that were delayed earlier.

**Data flow**: It receives a queued thread item. If it is a command execution, it forwards it to the command-start handler elsewhere in `ChatWidget`; if it is an MCP tool call, it forwards it to the MCP-start handler in this file. Other item kinds are ignored.

**Call relations**: This function connects the queue system to the real start handlers. In this file, its important handoff is to `ChatWidget::handle_mcp_tool_call_started_now`.

*Call graph*: calls 1 internal fn (handle_mcp_tool_call_started_now).


##### `ChatWidget::handle_queued_item_completed_now`  (lines 269–278)

```
fn handle_queued_item_completed_now(&mut self, item: ThreadItem)
```

**Purpose**: Dispatches a queued “completed” event to the right immediate handler. It lets delayed completion events re-enter the normal transcript update flow.

**Data flow**: It receives a queued thread item. If it is a command execution, it forwards it to the command-completion handler elsewhere in `ChatWidget`; if it is a file change, it calls the file-change completion handler; if it is an MCP tool call, it calls the MCP completion handler. Other item kinds are ignored.

**Call relations**: This function is the queue drain point for completion events covered by this file. It hands file changes to `ChatWidget::handle_file_change_completed_now` and MCP tool calls to `ChatWidget::handle_mcp_tool_call_completed_now`.

*Call graph*: calls 2 internal fn (handle_file_change_completed_now, handle_mcp_tool_call_completed_now).


### `tui/src/diff_model.rs`

`data_model` · `diff rendering and approval preview`

This file is a simple model for representing changes to files before they are shown to a user. Think of it like a change slip attached to a document: the slip says whether the document is new, removed, or edited, and carries the text needed to show that change clearly.

The main type is `FileChange`, an enum, which means a value can be one of several named forms. Here it can be `Add`, `Delete`, or `Update`. An added file carries its full new content. A deleted file carries the old content that is being removed. An updated file carries a `unified_diff`, which is a standard compact text format showing lines removed and added, and may also include a `move_path` if the file was renamed or moved.

The type can be serialized and deserialized, meaning it can be turned into stored or transmitted data and then rebuilt later. The `serde` settings make the saved form include a `type` field such as `add`, `delete`, or `update`, which keeps the data readable and predictable. Without this file, the TUI diff preview code would not have a shared, precise vocabulary for what kind of file change it is displaying.


### `tui/src/history_cell/separators.rs`

`domain_logic` · `transcript rendering after a turn completes`

A terminal chat transcript can become hard to scan if one assistant turn runs commands, calls tools, or streams many events. This file adds a visual pause between those turns, like a horizontal rule in a document. The divider is not just decoration: it can also carry a compact label saying things like “Worked for 1.2m” or “Local tools: 2 calls (340ms)”.

The main type is `FinalMessageSeparator`. It stores two optional pieces of information: how many seconds the turn took, and a summary of runtime metrics. When the terminal UI asks it to draw itself, it builds a list of label parts. Very short elapsed times are hidden, so the interface does not get noisy for quick replies. Runtime metrics are converted into plain text only if something actually happened.

If there is no label, the separator is just a dim horizontal line. If there is a label, the file places it inside the line and trims it to the available terminal width so it does not overflow. There is also a “raw” version that returns only the text label, useful when the history is exported or processed without terminal styling.

#### Function details

##### `FinalMessageSeparator::new`  (lines 17–25)

```
fn new(
        elapsed_seconds: Option<u64>,
        runtime_metrics: Option<RuntimeMetricsSummary>,
    ) -> Self
```

**Purpose**: Creates a separator object for a completed assistant turn. Callers provide the turn duration, if known, and a runtime summary, if one exists.

**Data flow**: It receives an optional elapsed time in seconds and an optional runtime metrics summary. It stores both values unchanged inside a new `FinalMessageSeparator`, which can later be drawn in the transcript.

**Call relations**: This is called when the system decides a finished turn needs a divider, such as from `handle_streaming_delta` or `on_task_complete`. Tests also call it to check that short durations are hidden and longer work labels appear.

*Call graph*: called by 4 (handle_streaming_delta, on_task_complete, final_message_separator_hides_short_worked_label_and_includes_runtime_metrics, final_message_separator_includes_worked_label_after_one_minute).


##### `FinalMessageSeparator::display_lines`  (lines 28–54)

```
fn display_lines(&self, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Builds the styled terminal line or lines that should be shown for this separator. It decides whether the divider is plain or whether it should include timing and runtime labels.

**Data flow**: It receives the available terminal width. It reads the separator’s stored elapsed time and runtime metrics, turns any useful information into short label text, trims that label to fit the width, and returns terminal `Line` values ready for display. It does not change the separator itself.

**Call relations**: The terminal history renderer calls this through the `HistoryCell` behavior when it needs visible, styled output. Inside this flow, the function relies on normal string formatting and vector creation, and it uses the runtime-metrics labeling logic to turn measurement data into readable text.

*Call graph*: 3 external calls (new, format!, vec!).


##### `FinalMessageSeparator::raw_lines`  (lines 56–73)

```
fn raw_lines(&self) -> Vec<Line<'static>>
```

**Purpose**: Produces an unstyled text version of the separator’s label. This is useful when the transcript needs content without the decorative horizontal rule.

**Data flow**: It reads the stored elapsed time and runtime metrics. If either produces a meaningful label, it joins the label pieces with a bullet separator and returns that as a single line. If there is nothing worth reporting, it returns no lines.

**Call relations**: This is the plain-text counterpart to `display_lines` in the `HistoryCell` implementation. It uses the same label-building idea but skips the terminal-width drawing and dim horizontal-line styling.

*Call graph*: 3 external calls (new, format!, vec!).


##### `runtime_metrics_label`  (lines 76–158)

```
fn runtime_metrics_label(summary: RuntimeMetricsSummary) -> Option<String>
```

**Purpose**: Turns a runtime metrics summary into a compact human-readable sentence fragment. It explains what happened during the turn, such as local tool calls, inference calls, WebSocket events, or Responses API timing.

**Data flow**: It receives a `RuntimeMetricsSummary`, checks each metric count or duration, and adds text only for values greater than zero. Durations are converted into milliseconds or seconds, counts are given singular or plural wording, and all non-empty parts are joined with bullet separators. It returns `None` if there is nothing to report, or `Some(text)` if there is.

**Call relations**: The separator rendering code uses this when it wants runtime details to appear beside the divider. This function delegates small wording tasks to `format_duration_ms` for time display and `pluralize` for choosing words like “call” versus “calls”.

*Call graph*: calls 2 internal fn (format_duration_ms, pluralize); 2 external calls (new, format!).


##### `format_duration_ms`  (lines 160–167)

```
fn format_duration_ms(duration_ms: u64) -> String
```

**Purpose**: Formats a duration stored in milliseconds into a short label that people can read quickly. Durations under one second stay as milliseconds; longer ones become seconds with one decimal place.

**Data flow**: It receives a number of milliseconds. If the value is at least 1000, it divides by 1000 and formats the result like `1.2s`; otherwise it formats the original value like `850ms`. The output is a string.

**Call relations**: `runtime_metrics_label` calls this whenever it needs to show how long a measured activity took. This keeps all metric labels using the same time style.

*Call graph*: called by 1 (runtime_metrics_label); 1 external calls (format!).


##### `pluralize`  (lines 169–171)

```
fn pluralize(count: u64, singular: &'static str, plural: &'static str) -> &'static str
```

**Purpose**: Chooses the correct word form for a count, such as `call` for one item and `calls` for anything else.

**Data flow**: It receives a count plus a singular word and a plural word. If the count is exactly 1, it returns the singular word; otherwise it returns the plural word. It does not allocate or change anything.

**Call relations**: `runtime_metrics_label` uses this while building metric text so labels read naturally to a person.

*Call graph*: called by 1 (runtime_metrics_label).


### `tui/src/insert_history.rs`

`io_transport` · `during TUI updates when finalized history is committed to terminal scrollback`

Codex has a live terminal user interface, but finalized chat history should not just be painted inside that live area. It should become part of the terminal scrollback, so users can scroll up and copy it like ordinary terminal text. This file is the bridge between those two worlds.

The main job is to take styled text lines, decide how they should wrap, and then send ANSI escape sequences, which are special text commands understood by terminals, to insert those lines above the current viewport. The viewport is the visible area where the active UI sits. The code carefully limits the terminal's scroll region, meaning the part of the screen allowed to move, so inserting history does not shove the prompt or composer into the wrong place.

Wrapping is subtle. Normal prose is pre-wrapped so indentation is preserved on continuation lines. Long URL-like text is often left unbroken so terminals can still recognize it as a clickable link. Mixed prose and links get a middle path: words wrap naturally, but links are not split apart unnecessarily.

The file also preserves colors, bold text, hyperlinks, and other styling while writing. It has a special raw mode for Zellij, a terminal multiplexer, because Zellij treats soft-wrapped rows differently. Without this file, finalized history could overwrite the live UI, lose colors or links, wrap badly, or fail to appear in scrollback at all.

#### Function details

##### `insert_history_lines`  (lines 61–69)

```
fn insert_history_lines(
    terminal: &mut crate::custom_terminal::Terminal<B>,
    lines: Vec<Line>,
) -> io::Result<()>
```

**Purpose**: This is the simple public entry point for adding finished history lines to terminal scrollback. It uses the normal wrapping behavior, which prepares most lines before sending them to the terminal.

**Data flow**: It receives a terminal object and a list of styled text lines. It passes them on unchanged, adding the default wrap policy, and returns success or an input/output error from the lower-level terminal-writing work.

**Call relations**: Most application and snapshot-test flows call this when they have ordinary history text to commit. It immediately hands the work to insert_history_lines_with_wrap_policy so callers do not need to know about wrapping options.

*Call graph*: calls 1 internal fn (insert_history_lines_with_wrap_policy); called by 22 (thread_goal_ephemeral_error_message_renders_snapshot, chained_config_error_wraps_in_history_snapshot, app_server_guardian_review_denied_renders_denied_request_snapshot, app_server_guardian_review_timed_out_renders_timed_out_request_snapshot, guardian_approved_exec_renders_approved_request, guardian_approved_request_permissions_renders_request_summary, guardian_denied_exec_renders_warning_and_denied_request, guardian_timed_out_exec_renders_warning_and_timed_out_request, app_server_mcp_startup_failure_renders_warning_history, chatwidget_exec_and_status_layout_vt100_snapshot (+12 more)).


##### `insert_history_lines_with_wrap_policy`  (lines 71–85)

```
fn insert_history_lines_with_wrap_policy(
    terminal: &mut crate::custom_terminal::Terminal<B>,
    lines: Vec<Line>,
    wrap_policy: HistoryLineWrapPolicy,
) -> io::Result<()>
```

**Purpose**: This variant lets a caller choose whether Codex should pre-wrap text or leave wrapping to the terminal. It is useful when preserving raw terminal wrapping matters more than Codex's word wrapping.

**Data flow**: It receives the terminal, styled lines, and a wrap policy. It adds the standard insertion mode, then forwards everything to the more general insertion function and returns that result.

**Call relations**: The basic insert_history_lines function uses this with the default policy. A test calls it directly to prove that terminal-controlled wrapping remains available.

*Call graph*: calls 1 internal fn (insert_history_lines_with_mode_and_wrap_policy); called by 2 (insert_history_lines, vt100_terminal_wrap_policy_does_not_pre_wrap_long_paragraph).


##### `insert_history_lines_with_mode_and_wrap_policy`  (lines 87–102)

```
fn insert_history_lines_with_mode_and_wrap_policy(
    terminal: &mut crate::custom_terminal::Terminal<B>,
    lines: Vec<Line>,
    mode: InsertHistoryMode,
    wrap_policy: HistoryLineWrapPolicy,
)
```

**Purpose**: This function adds one more choice: the insertion strategy. It converts ordinary styled lines into the hyperlink-aware form used by the lower-level writer.

**Data flow**: It receives styled text lines, an insertion mode, and a wrap policy. It first makes the lines owned/static and wraps them in plain hyperlink containers, then sends them to the hyperlink-aware insertion function. Its output is only success or failure.

**Call relations**: It sits between the simple public helpers and the full implementation. Tests call it directly for the special Zellij raw path, while normal callers reach it through the simpler wrappers.

*Call graph*: calls 2 internal fn (insert_history_hyperlink_lines_with_mode_and_wrap_policy, plain_hyperlink_lines); called by 3 (insert_history_lines_with_wrap_policy, vt100_zellij_raw_insert_keeps_soft_wrapped_tail_above_viewport, vt100_zellij_raw_replay_keeps_overflowing_soft_wrapped_tail_above_viewport).


##### `insert_history_hyperlink_lines_with_mode_and_wrap_policy`  (lines 104–256)

```
fn insert_history_hyperlink_lines_with_mode_and_wrap_policy(
    terminal: &mut crate::custom_terminal::Terminal<B>,
    lines: Vec<HyperlinkLine>,
    mode: InsertHistoryMode,
    wrap_policy: Histor
```

**Purpose**: This is the main engine that inserts history into the terminal scrollback. It decides wrapping, moves the terminal cursor, adjusts the scroll region, writes styled lines, and restores the live UI's cursor afterward.

**Data flow**: It reads the terminal size, current viewport area, and last known cursor position. It turns incoming hyperlink-aware lines into wrapped output rows according to the chosen policy, writes them with terminal commands, possibly moves the viewport down, records how many history rows were inserted, and returns any terminal I/O error.

**Call relations**: The wrapper functions feed ordinary history into it, and flush_pending_history_lines can call it when buffered hyperlink-aware history is ready. Inside, it uses leading_whitespace_prefix to keep indentation on wrapped rows, remap_wrapped_line and wrapping helpers to preserve span/link meaning, and write_history_line to actually print each styled row.

*Call graph*: calls 12 internal fn (backend, backend_mut, clear_after_position, note_history_rows_inserted, set_viewport_area, leading_whitespace_prefix, write_history_line, remap_wrapped_line, new, adaptive_wrap_line (+2 more)); called by 2 (insert_history_lines_with_mode_and_wrap_policy, flush_pending_history_lines); 4 external calls (new, new, queue!, vec!).


##### `leading_whitespace_prefix`  (lines 258–277)

```
fn leading_whitespace_prefix(line: &Line<'_>) -> Line<'static>
```

**Purpose**: This helper extracts the leading spaces or other whitespace from a styled line. It is used so wrapped continuation lines can keep the same indentation as the original line.

**Data flow**: It receives one styled line. It walks through the line's spans until it reaches the first non-whitespace character, copies only the leading whitespace with its styles, and returns that as a new owned line.

**Call relations**: The main insertion function uses it while pre-wrapping history. display_hyperlink_lines also relies on it for the same idea: continuation rows should line up visually with the start of the original text.

*Call graph*: called by 2 (display_hyperlink_lines, insert_history_hyperlink_lines_with_mode_and_wrap_policy); 3 external calls (from, styled, new).


##### `write_history_line`  (lines 282–329)

```
fn write_history_line(
    writer: &mut W,
    line: &HyperlinkLine,
    wrap_width: usize,
) -> io::Result<()>
```

**Purpose**: This writes one already-wrapped history line to the terminal, including colors, hyperlinks, and cleanup of any rows it may occupy. It prevents leftovers from previous longer text from showing through.

**Data flow**: It receives a writer, a hyperlink-aware line, and the terminal wrap width. It calculates how many physical terminal rows the line may cover, clears continuation rows if needed, applies line-level colors, merges those colors into spans, decorates spans with hyperlink escape codes, then writes the spans. It returns success or an I/O error.

**Call relations**: The main insertion routine calls this for every line it inserts. A hyperlink test also calls it directly to verify that link escape codes are emitted without changing the visible text.

*Call graph*: calls 3 internal fn (write_spans, width, decorate_spans); called by 2 (insert_history_hyperlink_lines_with_mode_and_wrap_policy, writes_semantic_web_link_without_changing_visible_text); 2 external calls (from, queue!).


##### `SetScrollRegion::write_ansi`  (lines 335–337)

```
fn write_ansi(&self, f: &mut impl fmt::Write) -> fmt::Result
```

**Purpose**: This writes the ANSI escape sequence that tells the terminal to limit scrolling to a specific vertical range. That lets Codex insert history without moving the live viewport unexpectedly.

**Data flow**: It receives a formatter and the stored start/end row range. It writes a terminal command in text form and returns whether formatting succeeded.

**Call relations**: Crossterm calls this when the file queues a SetScrollRegion command during standard history insertion. It is paired with ResetScrollRegion::write_ansi after the protected insertion is done.

*Call graph*: 1 external calls (write!).


##### `SetScrollRegion::execute_winapi`  (lines 340–342)

```
fn execute_winapi(&self) -> std::io::Result<()>
```

**Purpose**: This Windows-specific fallback deliberately refuses to use the old Windows console API for this command. The code expects the ANSI escape-code path instead.

**Data flow**: It receives no useful input besides the command value. If called, it panics rather than producing terminal output.

**Call relations**: It exists because the crossterm command trait requires a Windows execution method. In normal use, crossterm should use write_ansi instead.

*Call graph*: 1 external calls (panic!).


##### `SetScrollRegion::is_ansi_code_supported`  (lines 345–348)

```
fn is_ansi_code_supported(&self) -> bool
```

**Purpose**: This tells crossterm that the scroll-region command should be treated as ANSI-capable on Windows. In plain terms, it says the text escape-code version is the intended route.

**Data flow**: It reads no external data and always returns true.

**Call relations**: Crossterm may consult this before deciding how to execute SetScrollRegion on Windows. It supports the same ANSI path used by write_ansi.


##### `ResetScrollRegion::write_ansi`  (lines 355–357)

```
fn write_ansi(&self, f: &mut impl fmt::Write) -> fmt::Result
```

**Purpose**: This writes the ANSI escape sequence that removes any custom scroll region. It returns the terminal to normal scrolling after Codex finishes inserting history.

**Data flow**: It receives a formatter, writes the reset command, and returns whether formatting succeeded.

**Call relations**: The insertion code queues this after using SetScrollRegion. Together they act like temporarily putting rails around a moving area, then taking the rails away.

*Call graph*: 1 external calls (write!).


##### `ResetScrollRegion::execute_winapi`  (lines 360–362)

```
fn execute_winapi(&self) -> std::io::Result<()>
```

**Purpose**: This Windows-specific fallback intentionally panics if someone tries to reset the scroll region through the non-ANSI Windows API. The command is meant to be sent as an escape sequence.

**Data flow**: It receives no meaningful input and produces no normal output. Calling it stops execution with a panic.

**Call relations**: It satisfies crossterm's command interface, but normal terminal output should go through ResetScrollRegion::write_ansi.

*Call graph*: 1 external calls (panic!).


##### `ResetScrollRegion::is_ansi_code_supported`  (lines 365–368)

```
fn is_ansi_code_supported(&self) -> bool
```

**Purpose**: This reports that the ANSI reset-scroll-region command is supported. It helps crossterm choose the escape-code path.

**Data flow**: It reads nothing and returns true.

**Call relations**: Crossterm may use this when deciding how to execute ResetScrollRegion on Windows. It matches the file's expectation that ANSI terminal commands are used.


##### `ModifierDiff::queue`  (lines 377–435)

```
fn queue(self, mut w: W) -> io::Result<()>
```

**Purpose**: This emits only the style changes needed to move from one text modifier state to another, such as turning bold on or off. That keeps terminal output correct without resetting everything before every span.

**Data flow**: It receives a previous modifier set and a target modifier set, plus a writer. It computes what was removed and what was added, queues the corresponding terminal style commands, and returns success or an I/O error.

**Call relations**: write_spans uses it whenever the next span needs a different modifier style. It is the small translator between ratatui's style flags and crossterm's terminal attributes.

*Call graph*: 2 external calls (contains, queue!).


##### `write_spans`  (lines 438–477)

```
fn write_spans(mut writer: &mut impl Write, content: I) -> io::Result<()>
```

**Purpose**: This writes a sequence of styled text spans to the terminal while preserving foreground color, background color, and text modifiers. It resets styling at the end so later terminal output does not accidentally inherit it.

**Data flow**: It receives a writer and an iterable set of spans. For each span, it compares the span's style to the currently active style, queues only the needed color and modifier changes, prints the span text, and finally queues reset commands. It returns success or an I/O error.

**Call relations**: write_history_line calls this after hyperlink decoration. A unit test calls it directly to check that bold text is turned off before regular text is printed.

*Call graph*: called by 2 (writes_bold_then_regular_spans, write_history_line); 2 external calls (empty, queue!).


##### `tests::writes_bold_then_regular_spans`  (lines 488–513)

```
fn writes_bold_then_regular_spans()
```

**Purpose**: This test checks that bold styling does not leak into following plain text. It protects against a common terminal-output bug where once bold is turned on, later text stays bold by accident.

**Data flow**: It builds two spans, one bold and one regular, writes them into a byte buffer, builds the exact expected terminal command sequence, and compares the two strings.

**Call relations**: The test calls write_spans directly because that is the function responsible for modifier transitions. It does not exercise the full history insertion path.

*Call graph*: calls 1 internal fn (write_spans); 3 external calls (new, assert_eq!, queue!).


##### `tests::writes_semantic_web_link_without_changing_visible_text`  (lines 516–526)

```
fn writes_semantic_web_link_without_changing_visible_text()
```

**Purpose**: This test verifies that a URL gets terminal hyperlink metadata while the text users see stays exactly the same. It makes sure clickable links are added invisibly rather than by rewriting the message.

**Data flow**: It creates a line containing a URL, annotates it as a web link, writes it as a history line into a buffer, then checks that the output contains the hyperlink escape sequence and that the visible span content is unchanged.

**Call relations**: The test calls write_history_line directly because that is where hyperlink decoration is applied before spans are written.

*Call graph*: calls 2 internal fn (write_history_line, annotate_web_urls_in_line); 5 external calls (from, from_utf8, new, assert!, assert_eq!).


##### `tests::vt100_blockquote_line_emits_green_fg`  (lines 529–561)

```
fn vt100_blockquote_line_emits_green_fg()
```

**Purpose**: This test checks that a line-level green style, like one used for a markdown blockquote, reaches the terminal cells. It guards against losing styles that are attached to the whole line rather than individual spans.

**Data flow**: It creates an off-screen VT100-style terminal, sets the viewport, inserts one green styled line, then scans the terminal screen for any non-default foreground color.

**Call relations**: The test uses insert_history_lines, so it exercises the normal public insertion path and the lower-level writer together.

*Call graph*: calls 3 internal fn (with_options, insert_history_lines, new); 4 external calls (from, new, assert!, vec!).


##### `tests::vt100_blockquote_wrap_preserves_color_on_all_wrapped_lines`  (lines 564–627)

```
fn vt100_blockquote_wrap_preserves_color_on_all_wrapped_lines()
```

**Purpose**: This test ensures that when a styled blockquote wraps onto multiple terminal rows, the wrapped rows keep the same color. It protects against only the first row being styled.

**Data flow**: It creates a narrow off-screen terminal, inserts a long green blockquote line, gathers non-empty rows, and checks that every non-space character on those rows has a non-default foreground color.

**Call relations**: The test calls insert_history_lines to cover the normal wrapping and terminal-writing path together.

*Call graph*: calls 3 internal fn (with_options, insert_history_lines, new); 5 external calls (from, new, new, assert!, vec!).


##### `tests::vt100_colored_prefix_then_plain_text_resets_color`  (lines 630–685)

```
fn vt100_colored_prefix_then_plain_text_resets_color()
```

**Purpose**: This test makes sure a colored prefix, such as a list marker, does not color the following plain text. It protects the visual distinction between markers and content.

**Data flow**: It inserts a line whose first span is colored and whose later span is plain. It then inspects the off-screen terminal cells and verifies that the prefix cells are colored while the following text cells use the default color.

**Call relations**: The test uses insert_history_lines, which reaches write_history_line and write_spans where color changes and resets are actually produced.

*Call graph*: calls 3 internal fn (with_options, insert_history_lines, new); 5 external calls (from, new, assert!, assert_eq!, vec!).


##### `tests::vt100_deep_nested_mixed_list_third_level_marker_is_colored`  (lines 688–736)

```
fn vt100_deep_nested_mixed_list_third_level_marker_is_colored()
```

**Purpose**: This test checks markdown list rendering after it has been inserted into scrollback, especially for a deeply nested numbered marker. It confirms that the marker is colored but the list text after it returns to normal.

**Data flow**: It renders markdown into styled lines, inserts them into an off-screen terminal, finds the row containing the third-level list item, then checks the marker cells and the content cell colors.

**Call relations**: The test combines markdown rendering with insert_history_lines to catch style mistakes that only show up after history insertion.

*Call graph*: calls 4 internal fn (with_options, insert_history_lines, render_markdown_text, new); 3 external calls (assert!, assert_eq!, new).


##### `tests::vt100_prefixed_url_keeps_prefix_and_url_on_same_row`  (lines 739–762)

```
fn vt100_prefixed_url_keeps_prefix_and_url_on_same_row()
```

**Purpose**: This test ensures that a line prefix and a long URL with a scheme, such as http://, start on the same terminal row. It prevents awkward output where the prefix is stranded alone.

**Data flow**: It inserts a prefixed long URL into an off-screen terminal, reads the screen rows as strings, and checks for a row containing both the prefix and the URL start while rejecting an orphan prefix row.

**Call relations**: The test calls insert_history_lines to exercise the URL-aware wrapping rules in the main insertion path.

*Call graph*: calls 3 internal fn (with_options, insert_history_lines, new); 4 external calls (from, new, assert!, vec!).


##### `tests::vt100_prefixed_url_like_without_scheme_keeps_prefix_and_token_on_same_row`  (lines 765–790)

```
fn vt100_prefixed_url_like_without_scheme_keeps_prefix_and_token_on_same_row()
```

**Purpose**: This test checks the same behavior for URL-like text that does not include http:// or https://. It matters because paths like example.test/api should still be treated like link-shaped tokens.

**Data flow**: It inserts a prefixed URL-like token, collects off-screen terminal rows, and verifies that the prefix and token start appear together rather than the prefix being left by itself.

**Call relations**: The test reaches insert_history_lines and the URL-detection logic used before wrapping.

*Call graph*: calls 3 internal fn (with_options, insert_history_lines, new); 4 external calls (from, new, assert!, vec!).


##### `tests::vt100_prefixed_mixed_url_line_wraps_suffix_words_together`  (lines 793–820)

```
fn vt100_prefixed_mixed_url_line_wraps_suffix_words_together()
```

**Purpose**: This test checks wrapping for a line that contains a prefix, prose, a URL, and trailing prose. It ensures the ordinary words after the URL still wrap as readable words.

**Data flow**: It inserts a narrow-width mixed line into an off-screen terminal, reads the screen rows, and checks that the prose before the URL and the trailing phrase appear in sensible rows.

**Call relations**: The test uses insert_history_lines to cover the adaptive wrapping branch for mixed URL and non-URL content.

*Call graph*: calls 3 internal fn (with_options, insert_history_lines, new); 4 external calls (from, new, assert!, vec!).


##### `tests::vt100_prefixed_mixed_url_line_preserves_prefix_on_wrapped_rows`  (lines 823–853)

```
fn vt100_prefixed_mixed_url_line_preserves_prefix_on_wrapped_rows()
```

**Purpose**: This test makes sure wrapped continuation rows keep the original indentation for mixed URL/prose lines. It protects the visual structure of indented messages.

**Data flow**: It inserts a long indented line containing a URL and extra prose, finds a continuation row in the off-screen terminal output, and checks that the row starts with the original leading spaces.

**Call relations**: The test exercises insert_history_lines, including leading_whitespace_prefix and the adaptive wrapping path.

*Call graph*: calls 3 internal fn (with_options, insert_history_lines, new); 4 external calls (from, new, assert!, vec!).


##### `tests::vt100_prefixed_non_url_line_preserves_prefix_on_wrapped_rows`  (lines 856–885)

```
fn vt100_prefixed_non_url_line_preserves_prefix_on_wrapped_rows()
```

**Purpose**: This test checks that indentation is preserved even when the line contains no URL. It proves that prefix preservation is not limited to link handling.

**Data flow**: It inserts a long indented plain-text line, locates a wrapped continuation row, and verifies that it begins with the same leading spaces as the source line.

**Call relations**: The test calls insert_history_lines and covers the ordinary pre-wrap path that uses leading_whitespace_prefix.

*Call graph*: calls 3 internal fn (with_options, insert_history_lines, new); 4 external calls (from, new, assert!, vec!).


##### `tests::vt100_terminal_wrap_policy_does_not_pre_wrap_long_paragraph`  (lines 888–911)

```
fn vt100_terminal_wrap_policy_does_not_pre_wrap_long_paragraph()
```

**Purpose**: This test verifies that the terminal wrap policy really leaves wrapping to the terminal instead of Codex splitting words itself. This matters for raw output where terminal soft-wrap behavior should be preserved.

**Data flow**: It inserts a long paragraph with the Terminal wrap policy into a narrow off-screen terminal, reads the rows, and checks for the kind of cut that terminal character wrapping would produce.

**Call relations**: The test calls insert_history_lines_with_wrap_policy directly so it can choose the non-default wrapping behavior.

*Call graph*: calls 3 internal fn (with_options, insert_history_lines_with_wrap_policy, new); 4 external calls (from, new, assert!, vec!).


##### `tests::vt100_zellij_raw_insert_keeps_soft_wrapped_tail_above_viewport`  (lines 914–951)

```
fn vt100_zellij_raw_insert_keeps_soft_wrapped_tail_above_viewport()
```

**Purpose**: This test checks the special Zellij raw insertion mode for a line that soft-wraps. It ensures the wrapped tail remains in history above the viewport instead of leaking into the live UI area.

**Data flow**: It creates an off-screen terminal with a two-row viewport near the bottom, inserts one long raw line using ZellijRaw mode and Terminal wrapping, snapshots the rows, then checks that the tail text is in history rows and not viewport rows.

**Call relations**: The test calls insert_history_lines_with_mode_and_wrap_policy directly because the special mode is not used by the default public helper.

*Call graph*: calls 3 internal fn (with_options, insert_history_lines_with_mode_and_wrap_policy, new); 6 external calls (from, new, assert!, assert_snapshot!, from, vec!).


##### `tests::vt100_zellij_raw_replay_keeps_overflowing_soft_wrapped_tail_above_viewport`  (lines 954–990)

```
fn vt100_zellij_raw_replay_keeps_overflowing_soft_wrapped_tail_above_viewport()
```

**Purpose**: This test covers an even larger Zellij raw replay, where the inserted line is taller than the visible history space. It ensures overflow still ends up above the viewport rather than inside it.

**Data flow**: It starts with the viewport at the top, inserts a very long raw line in ZellijRaw mode, snapshots the terminal rows, and checks that the final tail text is in the history area but absent from the viewport.

**Call relations**: Like the previous Zellij test, it calls insert_history_lines_with_mode_and_wrap_policy directly to exercise the raw insertion branch.

*Call graph*: calls 3 internal fn (with_options, insert_history_lines_with_mode_and_wrap_policy, new); 7 external calls (from, new, assert!, format!, assert_snapshot!, from, vec!).


##### `tests::vt100_unwrapped_url_like_clears_continuation_rows`  (lines 993–1030)

```
fn vt100_unwrapped_url_like_clears_continuation_rows()
```

**Purpose**: This test makes sure an unbroken URL-like line clears the terminal rows it wraps across before writing. It prevents old characters from a previous longer line from remaining behind.

**Data flow**: It first inserts a long filler line, then inserts a shorter URL-like line that still soft-wraps. It reads the continuation row and checks that it contains the URL tail but no leftover filler characters.

**Call relations**: The test uses insert_history_lines to reach write_history_line, where continuation rows for wide lines are cleared.

*Call graph*: calls 3 internal fn (with_options, insert_history_lines, new); 4 external calls (from, new, assert!, vec!).


##### `tests::vt100_long_unwrapped_url_does_not_insert_extra_blank_gap_before_content`  (lines 1033–1065)

```
fn vt100_long_unwrapped_url_does_not_insert_extra_blank_gap_before_content()
```

**Purpose**: This test checks that a long URL-like history line appears promptly after the previous prompt line, without an unexpected blank gap. It protects the chat transcript from looking like content disappeared or was separated incorrectly.

**Data flow**: It inserts a prompt line, then inserts a very long URL line, reads the off-screen rows, finds both pieces of content, and checks that the URL starts close after the prompt.

**Call relations**: The test uses insert_history_lines through the normal path, focusing on the behavior for long unwrapped URL-like content.

*Call graph*: calls 3 internal fn (with_options, insert_history_lines, new); 5 external calls (from, new, assert!, format!, vec!).


### `tui/src/thread_transcript.rs`

`domain_logic` · `session or thread history loading`

A saved thread is stored as structured data: user messages, assistant messages, command runs, file changes, tool calls, image events, and more. The terminal interface cannot show those raw records directly. It needs “history cells,” which are small display objects that know how to draw one piece of conversation history. This file is the translator between those two worlds.

The main flow starts by asking the app server for a full thread, including its turns. A turn is one exchange or step in the conversation. The file then walks through every item in every turn and chooses the right kind of history cell. User messages become user cells, assistant markdown becomes assistant markdown cells, proposed plans become plan cells, and reasoning becomes a reasoning summary cell. There is also a switch for raw reasoning visibility: the interface can show either the detailed hidden reasoning content, when allowed, or just the saved summary.

For less central events, such as command execution or web search, the file creates simpler plain-text cells. These are fallback entries: not as rich as chat messages, but still enough to tell the reader what happened. If a thread has nothing displayable, it adds a quiet “No transcript content available” message so the screen is never blank without explanation.

#### Function details

##### `load_session_transcript`  (lines 28–41)

```
async fn load_session_transcript(
    app_server: &mut AppServerSession,
    thread_id: ThreadId,
    raw_reasoning_visibility: RawReasoningVisibility,
) -> std::io::Result<TranscriptCells>
```

**Purpose**: This function loads a saved thread from the app server and converts it into terminal history cells. It is used when the interface needs to show the transcript for an existing session.

**Data flow**: It receives a connection to the app server, the thread identifier to load, and a choice about whether raw reasoning should be visible. It asks the server to read the full thread, including its turns. If that succeeds, it passes the thread into the transcript converter and returns the finished list of display cells; if the server read fails, it turns that failure into a standard input/output error.

**Call relations**: When the app server page loader needs transcript content, it calls this function. This function is the bridge between fetching data and rendering data: it calls the server’s thread_read operation first, then hands the returned thread to thread_to_transcript_cells so the raw saved records become display-ready history cells.

*Call graph*: calls 2 internal fn (thread_read, thread_to_transcript_cells); called by 1 (spawn_app_server_page_loader).


##### `thread_to_transcript_cells`  (lines 43–121)

```
fn thread_to_transcript_cells(
    thread: &Thread,
    raw_reasoning_visibility: RawReasoningVisibility,
) -> TranscriptCells
```

**Purpose**: This function converts the contents of a thread into the list of history cells that the terminal interface can show. It is the main translator from saved conversation records into readable transcript blocks.

**Data flow**: It receives a thread and the raw-reasoning visibility setting. It looks at the thread’s working directory, then walks through each saved item inside each turn. Depending on the item type, it builds a user message cell, assistant markdown cell, proposed plan cell, reasoning cell, or a simpler fallback plain-text cell. Empty text is skipped. If nothing produces a cell, it returns one muted placeholder cell saying there is no transcript content.

**Call relations**: This is called after load_session_transcript has fetched a thread from the server. During conversion it calls parse_assistant_markdown so assistant text is cleaned up and split into visible markdown, uses the relevant history-cell constructors to make display objects, and calls fallback_transcript_cell for event types that do not have a richer custom cell.

*Call graph*: calls 5 internal fn (parse_assistant_markdown, new, new, new, fallback_transcript_cell); called by 1 (load_session_transcript); 5 external calls (new, new, new_proposed_plan, matches!, vec!).


##### `fallback_transcript_cell`  (lines 123–233)

```
fn fallback_transcript_cell(item: &ThreadItem) -> Option<PlainHistoryCell>
```

**Purpose**: This function creates a simple readable transcript entry for thread items that do not get a specialized display cell. It keeps important activity, such as command runs, file changes, tool calls, searches, and image events, from disappearing from the transcript.

**Data flow**: It receives one thread item. For supported event-style items, it turns the key details into one or more plain text lines, usually in a dim style so they read like activity notes rather than chat messages. For items already handled elsewhere, such as user messages, assistant messages, plans, reasoning, or sleep events, it returns nothing. When it does create lines, it wraps them in a PlainHistoryCell.

**Call relations**: thread_to_transcript_cells calls this only after it has ruled out the richer message, plan, and reasoning cases. In the larger flow, this function acts like a safety net: it gives the transcript a compact note for many kinds of background activity so the history still tells a complete story.

*Call graph*: called by 1 (thread_to_transcript_cells); 2 external calls (format!, vec!).

## 📊 State Registers Touched

- `reg-effective-config` — The final set of settings Codex runs with after combining files, policies, profiles, cloud settings, thread overrides, and command-line flags.
- `reg-feature-flags` — The shared list of enabled or disabled experimental and product features that changes what the app exposes.
- `reg-install-home-context` — The discovered Codex home folder, install location, bundled resources, and stable local installation identity.
- `reg-shell-workspace-environment` — The current machine, shell, PATH, working directory, project root, Git state, and environment variables used to make commands behave like the user’s terminal.
- `reg-auth-identity` — The signed-in user or service identity, including account facts such as email, plan, workspace, and login mode.
- `reg-rate-limit-quota` — The current account limits, credit status, token usage, and reset information used to avoid overusing backend services.
- `reg-state-databases` — The opened local SQLite stores and migration state that hold structured runtime data for threads, agents, goals, jobs, and summaries.
- `reg-rollout-thread-store` — The durable conversation log and searchable thread index used to resume, rebuild, archive, restore, and display sessions.
- `reg-cloud-config-cache` — The cached and refreshed cloud-delivered configuration bundles that can alter settings, requirements, and available features.
- `reg-model-provider-catalog` — The combined menu of usable model providers and models from bundled data, cache, live services, local servers, and account access.
- `reg-app-server-runtime` — The live app-server or daemon state, including open transports, connected clients, request routing, and server lifecycle status.
- `reg-permission-sandbox-policy` — The shared rules for file access, command execution, network access, approvals, and sandbox modes.
- `reg-exec-environment` — The active command-execution setup, including local or remote executor choice, sandbox helper paths, runtime paths, and process execution capabilities.
- `reg-process-registry` — The shared record of running or tracked external processes, their identifiers, input/output streams, terminal sizes, and completion state.
- `reg-mcp-server-sessions` — The configured and connected MCP tool servers, their tools, resources, login state, approval rules, and active sessions.
- `reg-plugin-marketplace-catalog` — The installed, built-in, workspace, and marketplace plugin information that controls extra tools, hooks, connectors, and prompt additions.
- `reg-extension-host-state` — The shared extension runtime state and contributor hooks that let add-ons react to threads, turns, tools, prompts, events, and MCP setup.
- `reg-skills-catalog` — The available skills list, including where each skill came from, whether it is enabled, and the instructions it can add to a session.
- `reg-memory-store` — The saved long-term user memories and memory search results that can be loaded, updated, and inserted into future conversations.
- `reg-live-session-services` — The toolbox attached to one running session, such as model access, auth, telemetry, approvals, tools, extensions, networking, and MCP connections.
- `reg-thread-session-state` — The live state of a conversation thread, including its identity, workspace, selected model, history, permissions, listeners, and lifecycle status.
- `reg-turn-state` — The shared clipboard for one active assistant turn, tracking the current task, pending replies, granted permissions, cancellations, and bookkeeping.
- `reg-conversation-history-budget` — The accumulated messages, compacted summaries, token counts, and trimming decisions that determine what conversation context still fits.
- `reg-prompt-context-stack` — The assembled prompt ingredients, including project instructions, permissions text, goals, memories, skills, plugin text, IDE details, warnings, and changed context.
- `reg-tool-catalog` — The current set of tools the model may call, with schemas, names, MCP conversions, plugin additions, and execution handlers.
- `reg-hook-rules` — The configured hooks and hook schemas that let external commands inspect or affect session starts, turns, tool calls, and other lifecycle events.
- `reg-agent-registry-graph` — The live and persisted map of parent agents, child agents, thread names, statuses, and which helper agents are still open.
- `reg-background-work-queues` — The shared set of background tasks such as cloud refreshes, cleanup jobs, memory jobs, skill watchers, agent jobs, update checks, and session maintenance.
- `reg-tui-visible-state` — The current terminal user-interface state, including visible transcript cells, inputs, popups, keymaps, headers, status lines, notifications, and restored history.
- `reg-observability-telemetry` — The shared logs, traces, metrics, analytics facts, rollout tracing, debug captures, and feedback evidence used to understand what happened.
- `reg-goal-state` — The live and persisted user goals, goal progress, and goal-thread associations synchronized into prompts, storage, analytics, and UI indicators.
- `reg-update-check-state` — Cached update notices, downloaded-or-pending update metadata, and daemon restart/update status produced by update checks and consumed by UI or teardown restart logic.
- `reg-external-import-ledger` — The persisted ledger of external-agent sessions already imported, used to avoid duplicate imports and track import provenance.
- `reg-cloud-task-state` — Cloud task lists, task details, submission attempts, selected task environments, and polling/refresh status shared by cloud task commands and clients.
- `reg-workspace-change-set` — Live and saved workspace change information, including file diffs, patch outcomes, reviewable changes, and rollback/snapshot data used by tools, UI, and persistence.
- `reg-session-connector-selection` — Per-session selected or enabled app/ChatGPT connectors used to decide which connector context and tools are exposed to the model.
