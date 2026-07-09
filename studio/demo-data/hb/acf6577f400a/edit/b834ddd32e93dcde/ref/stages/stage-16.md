# Result persistence, projection, and user-visible state updates  `stage-16`

This stage is the “make it stick and show it” part of the system. After a turn of work produces events, these pieces save the important ones, rebuild the thread’s official history, update metadata like name and status, and push fresh information out to users and other programs.

At the core, rollout policy, stream-event mapping, tool-event helpers, shell-command formatting, and diff tracking decide which raw events become saved history and visible transcript items. Metadata extractors and thread-store files keep the file-based session record and the SQLite state database in sync, including archive, restore, and metadata edits. Reconstruction code can replay saved items later to rebuild a thread or explain startup errors.

On the app-server side, event-mapping and item-builder code translate low-level engine events into client notifications, thread items, summaries, token-usage replays, and live status values like idle or active. Import and resume-redaction handlers cover special cases for outside clients and imported sessions.

Finally, exec and TUI code turn those updates into machine-readable JSON output, transcript/history cells, status lines, goal and rate-limit displays, review text, and other user-facing views.

## Files in this stage

### App-server event projection
These files translate core execution events into app-server notifications, thread history projections, replayed usage updates, and externally visible thread status.

### `app-server/src/bespoke_event_handling.rs`

`orchestration` · `main loop`

This file is the app-server’s large event dispatcher for per-thread runtime activity. Its top-level `apply_bespoke_event_handling` destructures each `Event { id, msg }` and performs protocol-specific fanout: some messages become direct `ServerNotification`s, some mutate `ThreadState`, some trigger client approval requests and spawn async response handlers, and some are intentionally suppressed because v2 has a newer canonical representation.

State coordination is explicit. `ThreadState.turn_summary` tracks started command-execution items, pending interrupts, pending rollback request IDs, last turn error, and timestamps; helper functions such as `find_and_remove_turn_summary`, `handle_error`, `respond_to_pending_interrupts`, `start_command_execution_item`, and `complete_command_execution_item` keep those invariants consistent. `ThreadWatchManager` is updated on turn starts/completions, permission prompts, user-input prompts, interruptions, shutdown, and missing subagent cleanup. `ThreadScopedOutgoingMessageSender` is the sole transport for notifications, responses, request cancellation, and request tracking.

Several branches bridge client approvals back into core operations. File-change, command-exec approval, user-input, MCP elicitation, permissions, and dynamic tool calls all send a `ServerRequestPayload`, then spawn a task that awaits a `oneshot::Receiver<ClientRequestResult>`, resolves listener bookkeeping, maps turn-transition errors specially, deserializes protocol responses, and submits the corresponding `Op` back to `CodexThread`. Error handling is nuanced: rollback failures short-circuit pending rollback requests without emitting notifications; stream errors notify without mutating turn summary; turn-complete and turn-aborted always abort pending per-thread requests and flush pending interrupt responses. The file also contains formatting helpers for review output text, rollback reconstruction from persisted history, and raw-response item emission, plus extensive tests covering edge cases like duplicate command-exec lifecycle suppression, guardian review wrapping, permission intersection, and repo/thread watch cleanup.

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

**Purpose**: Dispatches one core event for a thread into the app-server’s concrete side effects: notifications, state updates, spawned approval-response tasks, rollback responses, and selective suppression of deprecated or duplicate surfaces. It is the file’s central control-flow hub.

**Data flow**: Takes an `Event`, thread identifiers, `Arc<CodexThread>`, `Arc<ThreadManager>`, a thread-scoped outgoing sender, shared `Arc<Mutex<ThreadState>>`, `ThreadWatchManager`, a semaphore permit for thread-list state, and a fallback model-provider string → matches on `EventMsg` → reads and mutates thread summary/watch state, constructs protocol notifications and request payloads, sends notifications/responses/errors, spawns async handlers for client-mediated approvals and tool calls, and sometimes submits `Op` values back into `conversation`.

**Call relations**: Called by runtime event consumers and directly by tests exercising specific branches. It delegates specialized work to helpers such as `handle_turn_complete`, `handle_turn_interrupted`, `handle_turn_diff`, `handle_turn_plan_update`, `handle_token_count_event`, `handle_error_notification`, `handle_thread_rollback_failed`, `respond_to_pending_interrupts`, `start_command_execution_item`, `complete_command_execution_item`, `maybe_emit_hook_prompt_item_completed`, and `maybe_emit_raw_response_item_completed` to keep branch logic localized.

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

**Purpose**: Converts a core `TurnDiffEvent` into the app-server `TurnDiffUpdatedNotification`. It preserves the unified diff text verbatim.

**Data flow**: Takes a `ThreadId`, turn ID string slice, `TurnDiffEvent`, and outgoing sender reference → builds `TurnDiffUpdatedNotification { thread_id, turn_id, diff }` → sends `ServerNotification::TurnDiffUpdated`.

**Call relations**: Used from the `EventMsg::TurnDiff` branch in `apply_bespoke_event_handling` and directly by its test to verify notification shape.

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

**Purpose**: Maps `update_plan` tool output into the v2 turn-plan notification format. It explicitly treats this as checklist/tool output rather than plan-mode state.

**Data flow**: Takes thread ID, turn ID, `UpdatePlanArgs`, and outgoing sender → converts each plan step into `TurnPlanStep`, preserves optional explanation, wraps in `TurnPlanUpdatedNotification` → sends `ServerNotification::TurnPlanUpdated`.

**Call relations**: Invoked from the `EventMsg::PlanUpdate` branch and by a dedicated test. It isolates the protocol conversion from the main dispatcher.

*Call graph*: calls 1 internal fn (send_server_notification); called by 2 (apply_bespoke_event_handling, test_handle_turn_plan_update_emits_notification_for_v2); 2 external calls (TurnPlanUpdated, to_string).


##### `emit_turn_completed_with_status`  (lines 1325–1347)

```
async fn emit_turn_completed_with_status(
    conversation_id: ThreadId,
    event_turn_id: String,
    turn_completion_metadata: TurnCompletionMetadata,
    outgoing: &ThreadScopedOutgoingMessageSend
```

**Purpose**: Builds and emits a `TurnCompletedNotification` from precomputed completion metadata. It always emits an empty `items` list with `TurnItemsView::NotLoaded` rather than replaying turn contents.

**Data flow**: Takes thread ID, event turn ID, `TurnCompletionMetadata`, and outgoing sender → constructs a `Turn` with status/error/timestamps from metadata and empty items → sends `ServerNotification::TurnCompleted`.

**Call relations**: Shared by `handle_turn_complete` and `handle_turn_interrupted` so both completion paths produce the same notification shape.

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

**Purpose**: Marks a command-execution item as started in thread summary and emits the corresponding `ItemStarted` notification only once per item ID. This prevents duplicate start notifications when multiple event sources describe the same command.

**Data flow**: Takes thread/turn/item identifiers, command text, cwd, parsed command actions, source enum, outgoing sender, and shared thread state → inserts `item_id` into `thread_state.turn_summary.command_execution_started` → if insertion was new, builds `ThreadItem::CommandExecution` with `InProgress` status and current timestamp and sends `ServerNotification::ItemStarted` → returns `true` if emitted, `false` if already tracked.

**Call relations**: Called from guardian-assessment and exec-approval branches in `apply_bespoke_event_handling`, and by tests validating duplicate suppression. Its paired completion path is `complete_command_execution_item`.

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

**Purpose**: Emits a terminal `ItemCompleted` for a previously started command-execution item and clears its pending-start marker. If the item was never marked started or was already completed, it emits nothing.

**Data flow**: Takes thread/turn/item identifiers, command metadata, optional process ID, source, parsed actions, terminal `CommandExecutionStatus`, outgoing sender, and thread state → removes `item_id` from `thread_state.turn_summary.command_execution_started` → if removal succeeded, builds completed `ThreadItem::CommandExecution` with timestamp and sends `ServerNotification::ItemCompleted`; otherwise returns early.

**Call relations**: Used by denial/failure branches in `apply_bespoke_event_handling` and by `on_command_execution_request_approval_response` after client approval decisions. It relies on `start_command_execution_item` having established the pending marker.

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

**Purpose**: Wraps a raw core response item in the app-server raw-response completion notification. Unlike hook-prompt extraction, it always emits for the provided item.

**Data flow**: Takes thread ID, turn ID, owned `codex_protocol::models::ResponseItem`, and outgoing sender → builds `RawResponseItemCompletedNotification` → sends `ServerNotification::RawResponseItemCompleted`.

**Call relations**: Called from the `EventMsg::RawResponseItem` branch after optional hook-prompt extraction.

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

**Purpose**: Detects whether a raw response item is a user hook-prompt message and, if so, emits a structured `ThreadItem::HookPrompt` completion notification. Non-message items, non-user messages, and unparsable messages are ignored.

**Data flow**: Takes thread ID, turn ID, borrowed `ResponseItem`, and outgoing sender → pattern-matches for `ResponseItem::Message { role, content, id, .. }`, requires `role == "user"`, parses with `parse_hook_prompt_message`, converts fragments into protocol `HookPromptFragment`s, timestamps the item, and sends `ServerNotification::ItemCompleted` with `ThreadItem::HookPrompt`.

**Call relations**: Called from `apply_bespoke_event_handling` before raw-response emission so hook prompts get a richer v2 item surface. Also exercised directly by a test.

*Call graph*: calls 3 internal fn (now_unix_timestamp_ms, send_server_notification, parse_hook_prompt_message); called by 2 (apply_bespoke_event_handling, test_hook_prompt_raw_response_emits_item_completed); 2 external calls (ItemCompleted, to_string).


##### `find_and_remove_turn_summary`  (lines 1495–1501)

```
async fn find_and_remove_turn_summary(
    _conversation_id: ThreadId,
    thread_state: &Arc<Mutex<ThreadState>>,
) -> TurnSummary
```

**Purpose**: Atomically extracts the current `TurnSummary` from thread state and replaces it with the default empty summary. This is the reset point between turns.

**Data flow**: Takes thread ID (unused) and shared thread state → locks state and `std::mem::take`s `state.turn_summary` → returns the previous summary.

**Call relations**: Used by both turn-completion helpers and by tests inspecting recorded errors. It ensures completion consumes, rather than borrows, accumulated turn metadata.

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

**Purpose**: Finalizes a turn after a normal `TurnCompleteEvent`, deriving completed vs failed status from the accumulated turn summary. It preserves the last recorded turn error if one exists.

**Data flow**: Takes thread ID, event turn ID, `TurnCompleteEvent`, outgoing sender, and thread state → extracts and clears the turn summary → maps `last_error` to either `(TurnStatus::Failed, Some(error))` or `(TurnStatus::Completed, None)` → forwards timestamps and status to `emit_turn_completed_with_status`.

**Call relations**: Called from the `EventMsg::TurnComplete` branch after pending requests/interrupts are cleaned up, and by tests covering success and failure cases.

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

**Purpose**: Finalizes a turn after interruption/abort, always reporting `TurnStatus::Interrupted` and intentionally dropping any previously recorded turn error from the completion payload. It still preserves the original start timestamp from the summary.

**Data flow**: Takes thread ID, event turn ID, `TurnAbortedEvent`, outgoing sender, and thread state → extracts and clears turn summary → builds `TurnCompletionMetadata` with interrupted status, no error, and abort timestamps → emits completion notification.

**Call relations**: Called from the `EventMsg::TurnAborted` branch after pending requests and interrupts are resolved, and by a dedicated test.

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

**Purpose**: Fails an in-flight `thread/rollback` request when core reports rollback failure, and clears the pending rollback slot so future rollbacks are not blocked. It deliberately does not emit a general error notification.

**Data flow**: Takes thread ID (unused), failure message, thread state, and outgoing sender → removes `pending_rollbacks` from state → if a request ID was pending, sends `invalid_request(message)` as an error response for that request.

**Call relations**: Reached only from the `EventMsg::Error` branch in `apply_bespoke_event_handling` when `codex_error_info` is `ThreadRollbackFailed`.

*Call graph*: calls 2 internal fn (invalid_request, send_error); called by 1 (apply_bespoke_event_handling).


##### `thread_rollback_response_from_stored_thread`  (lines 1571–1590)

```
fn thread_rollback_response_from_stored_thread(
    stored_thread: codex_thread_store::StoredThread,
    session_id: String,
    fallback_model_provider: &str,
    fallback_cwd: &AbsolutePathBuf,
```

**Purpose**: Reconstructs a `ThreadRollbackResponse` from persisted thread storage after rollback completes. It requires persisted history so the returned thread can have rebuilt turns.

**Data flow**: Takes a `codex_thread_store::StoredThread`, session ID string, fallback model-provider string, fallback cwd, and loaded `ThreadStatus` → converts stored thread via `thread_from_stored_thread`, injects the current session ID, errors if history is absent, repopulates turns from history with `populate_thread_turns_from_history`, sets thread status, and returns `ThreadRollbackResponse { thread }`.

**Call relations**: Used by the `EventMsg::ThreadRolledBack` branch after reading the rolled-back thread from storage, and by a test that verifies pathless-thread reconstruction.

*Call graph*: called by 2 (apply_bespoke_event_handling, rollback_response_rebuilds_pathless_thread_from_stored_history); 3 external calls (populate_thread_turns_from_history, thread_from_stored_thread, format!).


##### `respond_to_pending_interrupts`  (lines 1592–1606)

```
async fn respond_to_pending_interrupts(
    thread_state: &Arc<Mutex<ThreadState>>,
    outgoing: &ThreadScopedOutgoingMessageSender,
)
```

**Purpose**: Flushes all queued interrupt requests for the thread by replying success to each one. This prevents clients from hanging after a turn completes or aborts.

**Data flow**: Takes thread state and outgoing sender → atomically takes `state.pending_interrupts` → iterates request IDs and sends `TurnInterruptResponse {}` for each.

**Call relations**: Called from both turn-complete and turn-aborted branches in `apply_bespoke_event_handling` before final completion notifications.

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

**Purpose**: Emits token-usage and account-rate-limit notifications from a core `TokenCountEvent`. It may emit zero, one, or two notifications depending on which optional fields are present.

**Data flow**: Takes thread ID, turn ID, `TokenCountEvent { info, rate_limits }`, and outgoing sender → if `info` converts into `ThreadTokenUsage`, sends `ThreadTokenUsageUpdatedNotification`; if `rate_limits` is present, sends `AccountRateLimitsUpdatedNotification`.

**Call relations**: Called from the `EventMsg::TokenCount` branch and by tests covering both populated and empty events.

*Call graph*: calls 1 internal fn (send_server_notification); called by 3 (apply_bespoke_event_handling, test_handle_token_count_event_emits_usage_and_rate_limits, test_handle_token_count_event_without_usage_info); 3 external calls (AccountRateLimitsUpdated, ThreadTokenUsageUpdated, to_string).


##### `handle_error`  (lines 1636–1643)

```
async fn handle_error(
    _conversation_id: ThreadId,
    error: TurnError,
    thread_state: &Arc<Mutex<ThreadState>>,
)
```

**Purpose**: Records the latest terminal turn error into thread summary without notifying clients. It is the state-only half of error handling.

**Data flow**: Takes thread ID (unused), a `TurnError`, and thread state → locks state and assigns `state.turn_summary.last_error = Some(error)`.

**Call relations**: Used by `handle_error_notification` and directly by tests that verify turn-summary persistence across completion paths.

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

**Purpose**: Records a turn error and emits the corresponding non-retrying app-server error notification. It keeps thread summary and client-visible error state in sync.

**Data flow**: Takes thread ID, event turn ID, `TurnError`, outgoing sender, and thread state → clones and stores the error via `handle_error` → sends `ServerNotification::Error(ErrorNotification { will_retry: false, ... })`.

**Call relations**: Called from the main dispatcher for terminal `EventMsg::Error` cases that affect turn status, and from `on_request_permissions_response` when invalid localized permission paths force interruption.

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

**Purpose**: Consumes the client’s response to a tool user-input request and submits the normalized answer map back into core. Failures degrade to an empty answer set unless the request was invalidated by a turn transition.

**Data flow**: Takes event turn ID, pending request ID, oneshot receiver, `Arc<CodexThread>`, thread state, and a watch guard → awaits receiver, resolves listener bookkeeping, drops the guard, maps turn-transition errors to silent return, maps other errors/recv failures to empty `CoreRequestUserInputResponse`, deserializes `ToolRequestUserInputResponse` when possible, converts answers into core answer structs, and submits `Op::UserInputAnswer { id, response }`.

**Call relations**: Spawned from the `EventMsg::RequestUserInput` branch in `apply_bespoke_event_handling`. It is the async completion half of that request/response flow.

*Call graph*: calls 2 internal fn (is_turn_transition_server_request_error, resolve_server_request_on_thread_listener); called by 1 (apply_bespoke_event_handling); 2 external calls (new, error!).


##### `on_mcp_server_elicitation_response`  (lines 1744–1770)

```
async fn on_mcp_server_elicitation_response(
    server_name: String,
    request_id: codex_protocol::mcp::RequestId,
    pending_request_id: RequestId,
    receiver: oneshot::Receiver<ClientRequestRe
```

**Purpose**: Resolves an MCP elicitation request using the client’s decision and optional content/meta payload. It centralizes cleanup and fallback mapping before submitting the core operation.

**Data flow**: Takes server name, MCP request ID, pending app-server request ID, oneshot receiver, `Arc<CodexThread>`, thread state, and permission guard → awaits receiver, resolves listener bookkeeping, drops guard, converts the client result with `mcp_server_elicitation_response_from_client_result`, and submits `Op::ResolveElicitation` with the mapped action/content/meta.

**Call relations**: Spawned from the `EventMsg::ElicitationRequest` branch after the request is sent to the client.

*Call graph*: calls 2 internal fn (mcp_server_elicitation_response_from_client_result, resolve_server_request_on_thread_listener); called by 1 (apply_bespoke_event_handling); 1 external calls (error!).


##### `mcp_server_elicitation_response_from_client_result`  (lines 1772–1809)

```
fn mcp_server_elicitation_response_from_client_result(
    response: std::result::Result<ClientRequestResult, oneshot::error::RecvError>,
) -> McpServerElicitationRequestResponse
```

**Purpose**: Maps the raw client request result for MCP elicitation into a concrete response object with safe defaults. Turn-transition errors become `Cancel`; all other failures become `Decline`.

**Data flow**: Takes `Result<ClientRequestResult, oneshot::error::RecvError>` → on successful JSON value, deserializes `McpServerElicitationRequestResponse` or falls back to `{ action: Decline, content: None, meta: None }` on parse failure → on turn-transition client error returns `{ action: Cancel, ... }` → on other client/receiver errors logs and returns `Decline`.

**Call relations**: Used by `on_mcp_server_elicitation_response` and directly by a test that locks down turn-transition behavior.

*Call graph*: calls 1 internal fn (is_turn_transition_server_request_error); called by 2 (on_mcp_server_elicitation_response, mcp_server_elicitation_turn_transition_error_maps_to_cancel); 1 external calls (error!).


##### `on_request_permissions_response`  (lines 1811–1870)

```
async fn on_request_permissions_response(
    pending_response: PendingRequestPermissionsResponse,
    conversation: Arc<CodexThread>,
    thread_state: Arc<Mutex<ThreadState>>,
)
```

**Purpose**: Processes the client’s permission-grant decision, intersects granted permissions with the original request, tracks the effective approval, and submits the result back to core. Invalid localized filesystem paths are treated as a turn error and trigger interruption.

**Data flow**: Takes a `PendingRequestPermissionsResponse`, `Arc<CodexThread>`, and thread state → awaits the receiver, resolves listener bookkeeping, drops the active guard, converts the client result with `request_permissions_response_from_client_result`, returns early on turn-transition `None`, on path-localization error emits `handle_error_notification` and submits `Op::Interrupt`, otherwise records the effective approval on `outgoing` and submits `Op::RequestPermissionsResponse { id: call_id, response }`.

**Call relations**: Spawned from the `EventMsg::RequestPermissions` branch. It delegates result normalization to `request_permissions_response_from_client_result` and error surfacing to `handle_error_notification`.

*Call graph*: calls 3 internal fn (handle_error_notification, request_permissions_response_from_client_result, resolve_server_request_on_thread_listener); called by 1 (apply_bespoke_event_handling); 2 external calls (error!, format!).


##### `request_permissions_response_from_client_result`  (lines 1884–1944)

```
fn request_permissions_response_from_client_result(
    requested_permissions: CoreRequestPermissionProfile,
    response: std::result::Result<ClientRequestResult, oneshot::error::RecvError>,
    cwd:
```

**Purpose**: Normalizes a client permissions-approval reply into the core permission response, enforcing scope rules and intersecting grants with the originally requested profile. It never allows the client to broaden permissions beyond the request.

**Data flow**: Takes the originally requested `CoreRequestPermissionProfile`, a raw client result, and the request cwd path → on turn-transition error returns `Ok(None)` → on other client/receiver failures returns an empty turn-scoped grant → on success deserializes `PermissionsRequestApprovalResponse`, defaults malformed payloads to empty turn-scoped grants, rejects `strict_auto_review` combined with session scope by downgrading to empty turn-scoped grant, converts granted permissions into `CoreAdditionalPermissionProfile`, intersects them with the requested profile using `intersect_permission_profiles(cwd)`, and returns `Ok(Some(CoreRequestPermissionsResponse { permissions, scope, strict_auto_review }))`.

**Call relations**: Used by `on_request_permissions_response` and heavily exercised by tests covering partial grants, cwd scoping, session scope preservation, and strict-auto-review constraints.

*Call graph*: calls 2 internal fn (is_turn_transition_server_request_error, intersect_permission_profiles); called by 9 (on_request_permissions_response, request_permissions_response_accepts_explicit_child_grant_for_requested_cwd_scope, request_permissions_response_accepts_partial_network_and_file_system_grants, request_permissions_response_ignores_broader_cwd_grant_for_requested_child_path, request_permissions_response_preserves_session_scope, request_permissions_response_preserves_turn_scoped_strict_auto_review, request_permissions_response_rejects_child_grant_outside_requested_cwd_scope, request_permissions_response_rejects_session_scoped_strict_auto_review, request_permissions_turn_transition_error_is_ignored); 5 external calls (default, into, default, error!, matches!).


##### `render_review_output_text`  (lines 1948–1966)

```
fn render_review_output_text(output: &ReviewOutputEvent) -> String
```

**Purpose**: Formats review output into a single user-facing text block by combining the overall explanation and formatted findings. If both are empty, it returns a fixed fallback message.

**Data flow**: Takes `&ReviewOutputEvent` → trims `overall_explanation`, formats findings with `format_review_findings_block`, trims that block, collects non-empty sections, and joins them with blank lines → returns either the joined text or `REVIEW_FALLBACK_MESSAGE`.

**Call relations**: Used from the `EventMsg::ExitedReviewMode` branch to populate the synthetic review item shown to clients.

*Call graph*: calls 1 internal fn (format_review_findings_block); called by 1 (apply_bespoke_event_handling); 1 external calls (new).


##### `map_file_change_approval_decision`  (lines 1968–1975)

```
fn map_file_change_approval_decision(decision: FileChangeApprovalDecision) -> ReviewDecision
```

**Purpose**: Translates app-server file-change approval decisions into core `ReviewDecision` values. The mapping preserves session-scoped approval and distinguishes cancel from decline.

**Data flow**: Takes a `FileChangeApprovalDecision` → matches each variant → returns the corresponding `ReviewDecision`.

**Call relations**: Used by `on_file_change_request_approval_response` and validated by a unit test for the session-approval case.

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

**Purpose**: Consumes the client’s file-change approval response and submits the resulting patch-approval decision back to core. Turn-transition errors are ignored because the request became obsolete.

**Data flow**: Takes item ID, pending request ID, oneshot receiver, `Arc<CodexThread>`, thread state, and permission guard → awaits receiver, resolves listener bookkeeping, drops guard, deserializes `FileChangeRequestApprovalResponse` or defaults to decline, maps the decision with `map_file_change_approval_decision`, and submits `Op::PatchApproval { id: item_id, decision }`.

**Call relations**: Spawned from the `EventMsg::ApplyPatchApprovalRequest` branch in the main dispatcher.

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

**Purpose**: Processes the client’s command-execution approval decision, optionally emits a declined/failed completion item for the pending command, and submits the corresponding exec-approval operation to core. It contains special suppression logic for subcommand approvals so parent command items are not completed twice.

**Data flow**: Takes event turn ID, conversation ID, optional approval ID, item ID, optional `CommandExecutionCompletionItem`, pending request ID, oneshot receiver, `Arc<CodexThread>`, outgoing sender, thread state, and permission guard → awaits receiver, resolves listener bookkeeping, drops guard, deserializes `CommandExecutionRequestApprovalResponse` or defaults to decline, maps each decision variant into a core `ReviewDecision` plus optional terminal `CommandExecutionStatus`, checks whether a subcommand completion item should be suppressed when `approval_id` is present and the parent item is still tracked, optionally calls `complete_command_execution_item`, then submits `Op::ExecApproval { id: approval_id.unwrap_or(item_id), turn_id: Some(event_turn_id), decision }`.

**Call relations**: Spawned from the `EventMsg::ExecApprovalRequest` branch after the approval request is sent. It is the async completion half of command approval handling and coordinates with `start_command_execution_item`/`complete_command_execution_item`.

*Call graph*: calls 3 internal fn (complete_command_execution_item, is_turn_transition_server_request_error, resolve_server_request_on_thread_listener); called by 1 (apply_bespoke_event_handling); 1 external calls (error!).


##### `now_unix_timestamp_ms`  (lines 2148–2153)

```
fn now_unix_timestamp_ms() -> i64
```

**Purpose**: Returns the current wall-clock time in Unix milliseconds, defaulting to zero if the system clock is before the epoch. It is used for synthetic item timestamps.

**Data flow**: Reads `SystemTime::now()`, computes duration since `UNIX_EPOCH`, converts milliseconds to `i64`, and falls back to `0` on error.

**Call relations**: Used by synthetic item emission paths such as review-mode items, hook prompts, and command-execution lifecycle helpers.

*Call graph*: called by 4 (apply_bespoke_event_handling, complete_command_execution_item, maybe_emit_hook_prompt_item_completed, start_command_execution_item); 1 external calls (now).


##### `tests::new_thread_state`  (lines 2210–2212)

```
fn new_thread_state() -> Arc<Mutex<ThreadState>>
```

**Purpose**: Creates a fresh shared `ThreadState` wrapped in `Arc<Mutex<_>>` for tests. It standardizes test setup.

**Data flow**: Constructs `ThreadState::default()`, wraps it in `tokio::sync::Mutex`, then in `Arc`, and returns it.

**Call relations**: Used by many tests in this module as the canonical empty thread-state fixture.

*Call graph*: 3 external calls (new, new, default).


##### `tests::recv_broadcast_message`  (lines 2217–2228)

```
async fn recv_broadcast_message(
        rx: &mut mpsc::Receiver<OutgoingEnvelope>,
    ) -> Result<OutgoingMessage>
```

**Purpose**: Receives one outgoing envelope from the test channel and unwraps either broadcast or connection-scoped messages into the contained `OutgoingMessage`. It fails if no message arrives.

**Data flow**: Takes a mutable `mpsc::Receiver<OutgoingEnvelope>` → awaits `recv()` → converts `OutgoingEnvelope::Broadcast` or `OutgoingEnvelope::ToConnection` into the inner `OutgoingMessage` → returns `Result<OutgoingMessage>`.

**Call relations**: Shared by notification-oriented tests to inspect what the outgoing sender emitted.

*Call graph*: calls 1 internal fn (recv).


##### `tests::rollback_response_rebuilds_pathless_thread_from_stored_history`  (lines 2231–2299)

```
fn rollback_response_rebuilds_pathless_thread_from_stored_history() -> Result<()>
```

**Purpose**: Verifies that rollback reconstruction rebuilds turns from persisted history and preserves key thread metadata while leaving `path` unset. It checks the happy path of `thread_rollback_response_from_stored_thread`.

**Data flow**: Builds a synthetic `StoredThread` with history items and fallback cwd → calls `thread_rollback_response_from_stored_thread` → asserts thread ID, preview/name/status, absent path, and reconstructed turn/item counts.

**Call relations**: Exercises the rollback reconstruction helper directly.

*Call graph*: calls 3 internal fn (thread_rollback_response_from_stored_thread, read_only, from_string); 4 external calls (now, assert_eq!, test_path_buf, vec!).


##### `tests::turn_complete_event`  (lines 2301–2309)

```
fn turn_complete_event(turn_id: &str) -> TurnCompleteEvent
```

**Purpose**: Creates a deterministic `TurnCompleteEvent` fixture with fixed completion timestamp and duration. It reduces duplication across completion tests.

**Data flow**: Takes a turn ID string slice → returns `TurnCompleteEvent` populated with that ID and module constants for `completed_at` and `duration_ms`.

**Call relations**: Used by multiple turn-completion tests.


##### `tests::turn_aborted_event`  (lines 2311–2318)

```
fn turn_aborted_event(turn_id: &str) -> TurnAbortedEvent
```

**Purpose**: Creates a deterministic interrupted `TurnAbortedEvent` fixture for tests. It fixes the abort reason and timestamps.

**Data flow**: Takes a turn ID string slice → returns `TurnAbortedEvent` with `Interrupted` reason and module constants for completion timing.

**Call relations**: Used by interruption tests.


##### `tests::command_execution_completion_item`  (lines 2320–2328)

```
fn command_execution_completion_item(command: &str) -> CommandExecutionCompletionItem
```

**Purpose**: Builds a simple `CommandExecutionCompletionItem` fixture with a `/tmp` cwd and one parsed-command entry. It mirrors the data shape used by command lifecycle helpers.

**Data flow**: Takes a command string slice → returns `CommandExecutionCompletionItem { command, cwd, command_actions }`.

**Call relations**: Used by command-execution helper tests.

*Call graph*: 2 external calls (test_path_buf, vec!).


##### `tests::guardian_command_assessment`  (lines 2330–2376)

```
fn guardian_command_assessment(
        id: &str,
        turn_id: &str,
        status: GuardianAssessmentStatus,
    ) -> GuardianAssessmentEvent
```

**Purpose**: Constructs synthetic guardian assessment events for command actions across multiple statuses. It fills in status-dependent risk, authorization, rationale, and completion timing.

**Data flow**: Takes an item ID, turn ID, and `GuardianAssessmentStatus` → derives status-specific metadata, builds a JSON command action, deserializes it into the protocol action type, and returns a `GuardianAssessmentEvent`.

**Call relations**: Used by guardian-assessment tests to drive `apply_bespoke_event_handling` through realistic review lifecycles.

*Call graph*: 4 external calls (format!, json!, matches!, from_value).


##### `tests::GuardianAssessmentTestContext::apply_guardian_assessment_event`  (lines 2388–2405)

```
async fn apply_guardian_assessment_event(&self, assessment: GuardianAssessmentEvent)
```

**Purpose**: Convenience wrapper that feeds a guardian assessment event through the full bespoke event handler with the test context’s thread, manager, sender, and watch state. It keeps guardian tests concise.

**Data flow**: Takes `&self` and a `GuardianAssessmentEvent` → wraps it in `Event { id, msg: EventMsg::GuardianAssessment(...) }` → calls `apply_bespoke_event_handling` with cloned context fields and a one-permit semaphore.

**Call relations**: Used only by guardian lifecycle tests to invoke the main dispatcher.

*Call graph*: calls 1 internal fn (apply_bespoke_event_handling); 5 external calls (new, clone, clone, GuardianAssessment, new).


##### `tests::guardian_assessment_started_uses_event_turn_id_fallback`  (lines 2409–2452)

```
fn guardian_assessment_started_uses_event_turn_id_fallback()
```

**Purpose**: Verifies that guardian review-start notifications fall back to the outer event turn ID when the assessment payload omits `turn_id`. This locks down a subtle compatibility behavior.

**Data flow**: Builds a `GuardianAssessmentEvent` with empty `turn_id` → calls `guardian_auto_approval_review_notification` → pattern-matches the resulting notification and asserts thread/turn IDs and review fields.

**Call relations**: Tests notification construction behavior relied on by the guardian branch in `apply_bespoke_event_handling`.

*Call graph*: calls 1 internal fn (new); 5 external calls (new, assert_eq!, guardian_auto_approval_review_notification, test_path_buf, panic!).


##### `tests::guardian_assessment_completed_emits_review_payload`  (lines 2455–2505)

```
fn guardian_assessment_completed_emits_review_payload()
```

**Purpose**: Verifies the completed guardian review notification payload for a denied assessment, including decision source and risk metadata. It checks that assessment `turn_id` overrides the outer event ID.

**Data flow**: Builds a denied `GuardianAssessmentEvent` → calls `guardian_auto_approval_review_notification` → matches the completed notification and asserts all relevant fields.

**Call relations**: Covers the completed-review notification path used by the main dispatcher.

*Call graph*: calls 1 internal fn (new); 4 external calls (assert_eq!, guardian_auto_approval_review_notification, test_path_buf, panic!).


##### `tests::guardian_assessment_aborted_emits_completed_review_payload`  (lines 2508–2551)

```
fn guardian_assessment_aborted_emits_completed_review_payload()
```

**Purpose**: Verifies that an aborted guardian assessment still emits the completed-review notification variant with aborted status. It ensures aborted reviews are surfaced as terminal review events.

**Data flow**: Builds an aborted network-access assessment → calls `guardian_auto_approval_review_notification` → asserts the completed payload fields.

**Call relations**: Tests another guardian notification edge case consumed by the dispatcher.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, guardian_auto_approval_review_notification, panic!).


##### `tests::command_execution_started_helper_emits_once`  (lines 2554–2622)

```
async fn command_execution_started_helper_emits_once() -> Result<()>
```

**Purpose**: Confirms that `start_command_execution_item` emits exactly one `ItemStarted` notification per item ID and returns `false` on duplicate starts. This protects against duplicate command lifecycle rendering.

**Data flow**: Creates thread state and outgoing channel, builds a completion item, calls `start_command_execution_item` twice with the same IDs, inspects the first emitted message, and asserts no second message arrives.

**Call relations**: Directly exercises the helper used by guardian and exec-approval branches.

*Call graph*: calls 5 internal fn (disabled, start_command_execution_item, new, new, new); 9 external calls (new, command_execution_completion_item, new_thread_state, recv_broadcast_message, assert!, assert_eq!, bail!, channel, vec!).


##### `tests::complete_command_execution_item_emits_declined_once_for_pending_command`  (lines 2625–2701)

```
async fn complete_command_execution_item_emits_declined_once_for_pending_command() -> Result<()>
```

**Purpose**: Confirms that `complete_command_execution_item` emits one completion for a pending command and suppresses subsequent duplicate completions after the pending marker is cleared.

**Data flow**: Starts a command item, drains the start notification, completes it with `Declined`, inspects the completion message, then calls completion again and asserts no extra message is emitted.

**Call relations**: Directly validates the helper paired with `start_command_execution_item`.

*Call graph*: calls 6 internal fn (disabled, complete_command_execution_item, start_command_execution_item, new, new, new); 9 external calls (new, command_execution_completion_item, new_thread_state, recv_broadcast_message, assert!, assert_eq!, bail!, channel, vec!).


##### `tests::guardian_command_execution_notifications_wrap_review_lifecycle`  (lines 2704–2906)

```
async fn guardian_command_execution_notifications_wrap_review_lifecycle() -> Result<()>
```

**Purpose**: Exercises the full guardian-assessment branch of the dispatcher, verifying that command execution items are started for in-progress reviews, review notifications are emitted, approved reviews do not complete the command item, denied reviews do, and missing target IDs suppress command-item wrapping.

**Data flow**: Builds a real thread manager/thread plus outgoing channel and guardian context → feeds multiple synthetic guardian assessments through `apply_guardian_assessment_event` → receives and pattern-matches the resulting outgoing messages in sequence.

**Call relations**: This is an end-to-end test of the guardian-specific control flow inside `apply_bespoke_event_handling`.

*Call graph*: calls 7 internal fn (disabled, new, new, new, thread_manager_with_models_provider_and_home, default_for_tests, create_dummy_chatgpt_auth_for_testing); 11 external calls (new, new, guardian_command_assessment, new_thread_state, recv_broadcast_message, assert!, assert_eq!, bail!, load_default_config_for_test, channel (+1 more)).


##### `tests::file_change_accept_for_session_maps_to_approved_for_session`  (lines 2909–2913)

```
fn file_change_accept_for_session_maps_to_approved_for_session()
```

**Purpose**: Verifies the file-change decision mapping for the session-scoped approval case. It locks down one nontrivial enum translation.

**Data flow**: Calls `map_file_change_approval_decision(FileChangeApprovalDecision::AcceptForSession)` → asserts the result is `ReviewDecision::ApprovedForSession`.

**Call relations**: Directly tests the mapping helper used by file-change approval response handling.

*Call graph*: calls 1 internal fn (map_file_change_approval_decision); 1 external calls (assert_eq!).


##### `tests::mcp_server_elicitation_turn_transition_error_maps_to_cancel`  (lines 2916–2933)

```
fn mcp_server_elicitation_turn_transition_error_maps_to_cancel()
```

**Purpose**: Verifies that a turn-transition client error is interpreted as cancellation rather than decline for MCP elicitation. This preserves semantics when the request becomes obsolete due to turn state changes.

**Data flow**: Builds a JSON-RPC error with turn-transition metadata → passes it to `mcp_server_elicitation_response_from_client_result` → asserts the returned action is `Cancel` with no content/meta.

**Call relations**: Directly tests the normalization helper used by `on_mcp_server_elicitation_response`.

*Call graph*: calls 1 internal fn (mcp_server_elicitation_response_from_client_result); 2 external calls (assert_eq!, json!).


##### `tests::request_permissions_turn_transition_error_is_ignored`  (lines 2936–2951)

```
fn request_permissions_turn_transition_error_is_ignored()
```

**Purpose**: Verifies that turn-transition errors for permission requests produce `None`, meaning no response should be submitted back to core. This avoids acting on stale approvals.

**Data flow**: Builds a turn-transition JSON-RPC error → calls `request_permissions_response_from_client_result` with default requested permissions and current cwd → asserts the result is `None`.

**Call relations**: Tests the stale-request branch of the permissions normalization helper.

*Call graph*: calls 1 internal fn (request_permissions_response_from_client_result); 4 external calls (default, assert_eq!, json!, current_dir).


##### `tests::request_permissions_response_accepts_partial_network_and_file_system_grants`  (lines 2954–3055)

```
fn request_permissions_response_accepts_partial_network_and_file_system_grants()
```

**Purpose**: Verifies that permission responses are intersected with the original request and can preserve partial network/filesystem grants while ignoring unrelated or broader permissions. It covers several representative grant shapes.

**Data flow**: Builds a requested permission profile and multiple JSON grant cases → repeatedly calls `request_permissions_response_from_client_result` → asserts the resulting `CoreRequestPermissionsResponse` matches the expected intersected permissions.

**Call relations**: Exercises the core permission-intersection logic used by `on_request_permissions_response`.

*Call graph*: calls 1 internal fn (request_permissions_response_from_client_result); 6 external calls (from_read_write_roots, assert_eq!, cfg!, json!, current_dir, vec!).


##### `tests::request_permissions_response_preserves_session_scope`  (lines 3058–3078)

```
fn request_permissions_response_preserves_session_scope()
```

**Purpose**: Verifies that a valid session-scoped permission grant remains session-scoped in the normalized core response. It checks scope preservation independent of permissions content.

**Data flow**: Calls `request_permissions_response_from_client_result` with a JSON response specifying `scope: session` and empty permissions → asserts the returned scope is `CorePermissionGrantScope::Session`.

**Call relations**: Tests one branch of the permissions normalization helper.

*Call graph*: calls 1 internal fn (request_permissions_response_from_client_result); 4 external calls (default, assert_eq!, json!, current_dir).


##### `tests::request_permissions_response_rejects_session_scoped_strict_auto_review`  (lines 3081–3106)

```
fn request_permissions_response_rejects_session_scoped_strict_auto_review()
```

**Purpose**: Verifies that `strictAutoReview` is rejected when paired with session scope and downgraded to an empty turn-scoped grant. This enforces the helper’s scope invariant.

**Data flow**: Calls `request_permissions_response_from_client_result` with session scope, strict auto review, and a network grant → asserts the returned response is empty, turn-scoped, and `strict_auto_review == false`.

**Call relations**: Covers the explicit validation branch in the permissions normalization helper.

*Call graph*: calls 1 internal fn (request_permissions_response_from_client_result); 4 external calls (default, assert_eq!, json!, current_dir).


##### `tests::request_permissions_response_preserves_turn_scoped_strict_auto_review`  (lines 3109–3132)

```
fn request_permissions_response_preserves_turn_scoped_strict_auto_review()
```

**Purpose**: Verifies that `strictAutoReview` is preserved when the grant is turn-scoped and otherwise valid. This is the allowed counterpart to the previous test.

**Data flow**: Calls `request_permissions_response_from_client_result` with requested network permission and a turn-scoped strict-auto-review response → asserts turn scope and `strict_auto_review == true`.

**Call relations**: Tests the accepted strict-auto-review path.

*Call graph*: calls 1 internal fn (request_permissions_response_from_client_result); 5 external calls (default, assert!, assert_eq!, json!, current_dir).


##### `tests::request_permissions_response_accepts_explicit_child_grant_for_requested_cwd_scope`  (lines 3135–3176)

```
fn request_permissions_response_accepts_explicit_child_grant_for_requested_cwd_scope()
```

**Purpose**: Verifies that a child path grant is accepted when it falls under the requested cwd-scoped project-roots permission. It checks cwd-relative localization behavior.

**Data flow**: Creates a temp cwd and child path, builds a requested project-roots write permission, passes a response granting the child path, and asserts the normalized permissions include that child write root.

**Call relations**: Exercises path-localization and intersection logic in the permissions helper.

*Call graph*: calls 2 internal fn (request_permissions_response_from_client_result, from_absolute_path); 5 external calls (default, new, assert_eq!, json!, vec!).


##### `tests::request_permissions_response_rejects_child_grant_outside_requested_cwd_scope`  (lines 3179–3217)

```
fn request_permissions_response_rejects_child_grant_outside_requested_cwd_scope()
```

**Purpose**: Verifies that a child path outside the originally requested cwd scope is discarded. This prevents later cwd changes from broadening grants.

**Data flow**: Creates separate request and later cwd roots, requests project-roots write under the request cwd, grants a child under the later cwd, and asserts the normalized permissions are empty.

**Call relations**: Tests a security-sensitive path-scoping edge case in the permissions helper.

*Call graph*: calls 2 internal fn (request_permissions_response_from_client_result, from_absolute_path); 5 external calls (default, new, assert_eq!, json!, vec!).


##### `tests::request_permissions_response_ignores_broader_cwd_grant_for_requested_child_path`  (lines 3220–3259)

```
fn request_permissions_response_ignores_broader_cwd_grant_for_requested_child_path()
```

**Purpose**: Verifies that a broader project-roots grant is not accepted when the original request was only for a specific child path. The helper must not widen permissions.

**Data flow**: Builds a requested write permission for one child path, passes a response granting project-roots write, and asserts the normalized permissions are empty.

**Call relations**: Another intersection edge-case test for `request_permissions_response_from_client_result`.

*Call graph*: calls 2 internal fn (request_permissions_response_from_client_result, from_absolute_path); 6 external calls (from_read_write_roots, default, new, assert_eq!, json!, vec!).


##### `tests::test_handle_error_records_message`  (lines 3262–3287)

```
async fn test_handle_error_records_message() -> Result<()>
```

**Purpose**: Verifies that `handle_error` stores the provided `TurnError` in thread summary. It checks state mutation without notification emission.

**Data flow**: Creates thread state, calls `handle_error` with a sample error, then extracts the summary via `find_and_remove_turn_summary` and asserts `last_error` matches.

**Call relations**: Directly tests the state-only error helper.

*Call graph*: calls 3 internal fn (find_and_remove_turn_summary, handle_error, new); 2 external calls (new_thread_state, assert_eq!).


##### `tests::turn_started_omits_active_snapshot_items`  (lines 3290–3375)

```
async fn turn_started_omits_active_snapshot_items() -> Result<()>
```

**Purpose**: Verifies that the `TurnStarted` notification emitted by the dispatcher clears any previously tracked active-turn items and reports `TurnItemsView::NotLoaded`. This prevents stale items from leaking into a fresh turn-start payload.

**Data flow**: Seeds thread state with a tracked turn start and user message, invokes `apply_bespoke_event_handling` with a new `TurnStarted` event, receives the outgoing notification, and asserts the emitted turn has empty items.

**Call relations**: Exercises the `EventMsg::TurnStarted` branch of the main dispatcher.

*Call graph*: calls 8 internal fn (disabled, apply_bespoke_event_handling, new, new, new, thread_manager_with_models_provider_and_home, default_for_tests, create_dummy_chatgpt_auth_for_testing); 15 external calls (new, default, new, new, new_thread_state, recv_broadcast_message, assert!, assert_eq!, bail!, load_default_config_for_test (+5 more)).


##### `tests::interrupted_subagent_activity_removes_missing_thread_watch`  (lines 3378–3463)

```
async fn interrupted_subagent_activity_removes_missing_thread_watch() -> Result<()>
```

**Purpose**: Verifies that interrupted subagent activity for a missing child thread removes that thread from `ThreadWatchManager` and still emits the corresponding item notification. It checks cleanup behavior tied to thread-manager lookup failure.

**Data flow**: Creates a parent thread and a watched child thread ID not present in `ThreadManager`, invokes `apply_bespoke_event_handling` with `SubAgentActivityKind::Interrupted`, then asserts the child watch status is reset and inspects the emitted `ItemCompleted` notification.

**Call relations**: Exercises the `EventMsg::SubAgentActivity` branch in the dispatcher.

*Call graph*: calls 10 internal fn (disabled, apply_bespoke_event_handling, new, new, new, thread_manager_with_models_provider_and_home, default_for_tests, create_dummy_chatgpt_auth_for_testing, try_from, new); 11 external calls (new, new, new_thread_state, recv_broadcast_message, assert_eq!, bail!, load_default_config_for_test, channel, SubAgentActivity, new (+1 more)).


##### `tests::test_handle_turn_complete_emits_completed_without_error`  (lines 3466–3523)

```
async fn test_handle_turn_complete_emits_completed_without_error() -> Result<()>
```

**Purpose**: Verifies that `handle_turn_complete` emits a completed turn with no error when the summary contains no recorded failure. It also checks timestamp propagation.

**Data flow**: Seeds thread state with tracked turn-start and turn-complete events, calls `handle_turn_complete`, receives the outgoing message, and asserts the emitted `TurnCompleted` payload fields.

**Call relations**: Directly tests the normal completion helper.

*Call graph*: calls 5 internal fn (disabled, handle_turn_complete, new, new, new); 12 external calls (new, default, new_thread_state, recv_broadcast_message, turn_complete_event, assert!, assert_eq!, bail!, channel, TurnComplete (+2 more)).


##### `tests::test_handle_turn_interrupted_emits_interrupted_with_error`  (lines 3526–3573)

```
async fn test_handle_turn_interrupted_emits_interrupted_with_error() -> Result<()>
```

**Purpose**: Verifies that interrupted completion emits `TurnStatus::Interrupted` and suppresses any previously recorded error in the completion payload. This matches the helper’s design choice.

**Data flow**: Records an error in thread state, calls `handle_turn_interrupted`, receives the outgoing message, and asserts interrupted status with `error == None`.

**Call relations**: Directly tests the interruption helper.

*Call graph*: calls 6 internal fn (disabled, handle_error, handle_turn_interrupted, new, new, new); 9 external calls (new, new_thread_state, recv_broadcast_message, turn_aborted_event, assert!, assert_eq!, bail!, channel, vec!).


##### `tests::test_handle_turn_complete_emits_failed_with_error`  (lines 3576–3630)

```
async fn test_handle_turn_complete_emits_failed_with_error() -> Result<()>
```

**Purpose**: Verifies that `handle_turn_complete` emits `TurnStatus::Failed` and includes the recorded `TurnError` when the summary contains a terminal error. It checks the failure branch.

**Data flow**: Records an error in thread state, calls `handle_turn_complete`, receives the outgoing message, and asserts failed status plus the exact error payload.

**Call relations**: Directly tests the failure branch of turn completion.

*Call graph*: calls 6 internal fn (disabled, handle_error, handle_turn_complete, new, new, new); 9 external calls (new, new_thread_state, recv_broadcast_message, turn_complete_event, assert!, assert_eq!, bail!, channel, vec!).


##### `tests::test_handle_turn_plan_update_emits_notification_for_v2`  (lines 3633–3678)

```
async fn test_handle_turn_plan_update_emits_notification_for_v2() -> Result<()>
```

**Purpose**: Verifies the v2 turn-plan notification emitted by `handle_turn_plan_update`, including explanation and per-step status conversion. It locks down protocol mapping.

**Data flow**: Builds an `UpdatePlanArgs` with two steps, calls `handle_turn_plan_update`, receives the outgoing message, and asserts thread/turn IDs and converted plan contents.

**Call relations**: Directly tests the plan-update helper.

*Call graph*: calls 5 internal fn (disabled, handle_turn_plan_update, new, new, new); 7 external calls (new, recv_broadcast_message, assert!, assert_eq!, bail!, channel, vec!).


##### `tests::test_handle_token_count_event_emits_usage_and_rate_limits`  (lines 3681–3771)

```
async fn test_handle_token_count_event_emits_usage_and_rate_limits() -> Result<()>
```

**Purpose**: Verifies that `handle_token_count_event` emits both token-usage and account-rate-limit notifications when both inputs are present. It checks ordering and field conversion.

**Data flow**: Builds a populated `TokenCountEvent`, calls `handle_token_count_event`, receives two outgoing messages, and asserts the contents of each notification.

**Call relations**: Directly tests the token-count helper’s dual-notification path.

*Call graph*: calls 5 internal fn (disabled, handle_token_count_event, new, new, new); 7 external calls (new, recv_broadcast_message, assert!, assert_eq!, bail!, channel, vec!).


##### `tests::test_handle_token_count_event_without_usage_info`  (lines 3774–3804)

```
async fn test_handle_token_count_event_without_usage_info() -> Result<()>
```

**Purpose**: Verifies that no notifications are emitted when a token-count event contains neither usage info nor rate limits. It checks the helper’s no-op behavior.

**Data flow**: Calls `handle_token_count_event` with both fields `None` and asserts the outgoing channel remains empty.

**Call relations**: Covers the empty-input branch of the token-count helper.

*Call graph*: calls 5 internal fn (disabled, handle_token_count_event, new, new, new); 4 external calls (new, assert!, channel, vec!).


##### `tests::test_handle_turn_complete_emits_error_multiple_turns`  (lines 3807–3926)

```
async fn test_handle_turn_complete_emits_error_multiple_turns() -> Result<()>
```

**Purpose**: Verifies that turn-summary error state is consumed per completion and does not leak into later turns. It simulates multiple turns across two conversations using the shared helper state.

**Data flow**: Records errors and completes turns in sequence for two thread IDs, receives three completion notifications, and asserts the first two are failed with their respective errors while the final turn is completed without error.

**Call relations**: Tests the reset semantics implemented by `find_and_remove_turn_summary` and `handle_turn_complete`.

*Call graph*: calls 6 internal fn (disabled, handle_error, handle_turn_complete, new, new, new); 9 external calls (new, new_thread_state, recv_broadcast_message, turn_complete_event, assert!, assert_eq!, bail!, channel, vec!).


##### `tests::test_handle_turn_diff_emits_v2_notification`  (lines 3929–3966)

```
async fn test_handle_turn_diff_emits_v2_notification() -> Result<()>
```

**Purpose**: Verifies that `handle_turn_diff` emits the expected v2 diff notification with the unified diff text unchanged.

**Data flow**: Calls `handle_turn_diff` with a sample diff, receives the outgoing message, and asserts thread ID, turn ID, and diff contents.

**Call relations**: Directly tests the diff helper.

*Call graph*: calls 5 internal fn (disabled, handle_turn_diff, new, new, new); 7 external calls (new, recv_broadcast_message, assert!, assert_eq!, bail!, channel, vec!).


##### `tests::test_hook_prompt_raw_response_emits_item_completed`  (lines 3969–4017)

```
async fn test_hook_prompt_raw_response_emits_item_completed() -> Result<()>
```

**Purpose**: Verifies that a raw response item containing a hook prompt is recognized and emitted as a structured `ThreadItem::HookPrompt` completion. It checks fragment extraction and conversion.

**Data flow**: Builds a hook-prompt message with two fragments, calls `maybe_emit_hook_prompt_item_completed`, receives the outgoing message, and asserts the completed item payload.

**Call relations**: Directly tests the hook-prompt extraction helper used by the raw-response branch.

*Call graph*: calls 6 internal fn (disabled, maybe_emit_hook_prompt_item_completed, new, new, build_hook_prompt_message, new); 8 external calls (new, from_single_hook, recv_broadcast_message, assert!, assert_eq!, bail!, channel, vec!).


### `app-server/src/thread_status.rs`

`domain_logic` · `thread lifecycle tracking and notification during request handling and event streaming`

This module separates status bookkeeping into a public manager (`ThreadWatchManager`), a drop-based guard for pending interactive requests (`ThreadWatchActiveGuard`), and an internal mutable state map (`ThreadWatchState`). The manager owns an async `Mutex<ThreadWatchState>`, an optional `OutgoingMessageSender` for broadcasting `ServerNotification::ThreadStatusChanged`, and a `watch::Sender<usize>` that tracks how many threads are currently marked `running`.

Status is derived from `RuntimeFacts`, not stored directly. `loaded_thread_status` computes `ThreadStatus` from booleans/counters: unloaded threads are `NotLoaded`; running threads or threads with pending permission/user-input counters become `Active` with `ThreadActiveFlag::WaitingOnApproval` and/or `WaitingOnUserInput`; otherwise `has_system_error` yields `SystemError`; else `Idle`. `ThreadWatchState` updates these facts per thread, maintains optional per-thread `watch::Sender<ThreadStatus>` channels, and emits `ThreadStatusChangedNotification` only when the derived status actually changes.

The manager methods are thin orchestration wrappers around `mutate_and_publish`. `upsert_thread` and `remove_thread` create/remove tracked runtime entries. Turn lifecycle methods (`note_turn_started`, `note_turn_completed`, `note_turn_interrupted`, `note_thread_shutdown`, `note_system_error`) mutate runtime flags. Interactive waits use `note_permission_requested` and `note_user_input_requested`, which increment counters and return a `ThreadWatchActiveGuard`; when that guard is dropped, its `Drop` impl spawns an async decrement via the captured Tokio runtime handle. This design ensures pending-request state is automatically released even across early returns.

A subtle helper, `resolve_thread_status`, upgrades `Idle` or `NotLoaded` to `Active` when another subsystem knows a turn is already in progress but the watch state has not observed it yet, smoothing race windows between event streams and status reads.

#### Function details

##### `ThreadWatchActiveGuard::new`  (lines 34–45)

```
fn new(
        manager: ThreadWatchManager,
        thread_id: String,
        guard_type: ThreadWatchActiveGuardType,
    ) -> Self
```

**Purpose**: Creates a guard object representing one outstanding permission or user-input wait for a thread. The guard captures the current Tokio runtime so it can schedule cleanup when dropped.

**Data flow**: Consumes a `ThreadWatchManager`, `thread_id: String`, and `ThreadWatchActiveGuardType`; reads `tokio::runtime::Handle::current()` and stores all four fields in a new `ThreadWatchActiveGuard`. It returns the guard by value.

**Call relations**: Constructed only by `ThreadWatchManager::note_pending_request` after incrementing the corresponding pending counter. Its stored runtime handle is later used by the `Drop` implementation to enqueue the decrement asynchronously.

*Call graph*: called by 1 (note_pending_request); 1 external calls (current).


##### `ThreadWatchActiveGuard::drop`  (lines 49–58)

```
fn drop(&mut self)
```

**Purpose**: Schedules asynchronous release of the pending-request counter when the guard goes out of scope. This makes pending interactive state RAII-managed rather than manually balanced.

**Data flow**: On drop, clones the manager and thread ID, copies the guard type, and uses the stored Tokio runtime handle to spawn an async task that awaits `manager.note_active_guard_released(thread_id, guard_type)`. It does not block the dropping thread.

**Call relations**: Triggered automatically by Rust drop semantics whenever a permission/user-input guard is discarded. It delegates the actual counter decrement and status recomputation to `ThreadWatchManager::note_active_guard_released`.

*Call graph*: 2 external calls (spawn, clone).


##### `ThreadWatchManager::default`  (lines 68–70)

```
fn default() -> Self
```

**Purpose**: Provides the default constructor for the manager by delegating to `new`. It ensures `Default` and explicit construction behave identically.

**Data flow**: Takes no inputs and returns `Self::new()`. No external state is read or written.

**Call relations**: Used by generic initialization paths and tests. It simply forwards to the main constructor.

*Call graph*: 1 external calls (new).


##### `ThreadWatchManager::new`  (lines 74–81)

```
fn new() -> Self
```

**Purpose**: Constructs a status manager with no outgoing notification sink. It is suitable for internal tracking and tests that only inspect state locally.

**Data flow**: Creates a `watch::channel(0)` for running-turn count, initializes `state` with `ThreadWatchState::default()` inside `Arc<Mutex<_>>`, sets `outgoing` to `None`, stores the sender, and returns the manager.

**Call relations**: Called by production code that does not need broadcast notifications and by many tests. All status mutations later flow through the state and watch sender initialized here.

*Call graph*: called by 11 (guardian_command_execution_notifications_wrap_review_lifecycle, interrupted_subagent_activity_removes_missing_thread_watch, turn_started_omits_active_snapshot_items, has_running_turns_tracks_runtime_running_flag_only, loaded_status_defaults_to_not_loaded_for_untracked_threads, loaded_statuses_default_to_not_loaded_for_untracked_threads, shutdown_marks_thread_not_loaded, status_updates_track_single_thread, status_watchers_receive_only_their_thread_updates, system_error_sets_idle_flag_until_next_turn (+1 more)); 4 external calls (new, new, default, channel).


##### `ThreadWatchManager::new_with_outgoing`  (lines 83–90)

```
fn new_with_outgoing(outgoing: Arc<OutgoingMessageSender>) -> Self
```

**Purpose**: Constructs a status manager that will broadcast `thread/status/changed` notifications through an `OutgoingMessageSender`. It is the notifying variant of `new`.

**Data flow**: Accepts `Arc<OutgoingMessageSender>`, creates a `watch::channel(0)`, initializes default internal state, stores `Some(outgoing)`, and returns the manager.

**Call relations**: Used by app-server setup and notification-focused tests. `mutate_and_publish` consults the stored sender to emit notifications whenever a status transition occurs.

*Call graph*: called by 3 (new, silent_upsert_skips_initial_notification, status_change_emits_notification); 4 external calls (new, new, default, channel).


##### `ThreadWatchManager::upsert_thread`  (lines 92–97)

```
async fn upsert_thread(&self, thread: Thread)
```

**Purpose**: Marks a thread as tracked and loaded, and emits a status-change notification if that changes its visible status. This is the normal registration path for a thread entering the manager.

**Data flow**: Consumes a `Thread` value, moves `thread.id` into a closure, and calls `mutate_and_publish` with `state.upsert_thread(thread.id, true)`. The resulting mutation sets `is_loaded = true` for that thread and may publish a notification.

**Call relations**: Called when resuming or attaching a thread listener. It delegates all state mutation and notification logic to `ThreadWatchState::upsert_thread` via `mutate_and_publish`.

*Call graph*: calls 1 internal fn (mutate_and_publish); called by 2 (thread_resume_inner, try_attach_thread_listener).


##### `ThreadWatchManager::upsert_thread_silently`  (lines 99–104)

```
async fn upsert_thread_silently(&self, thread: Thread)
```

**Purpose**: Marks a thread as tracked and loaded without emitting the initial status-change notification. It is used when the thread should appear in state but not trigger an immediate client-visible update.

**Data flow**: Consumes a `Thread`, moves `thread.id` into a closure, and calls `mutate_and_publish` with `state.upsert_thread(thread.id, false)`. The thread becomes loaded in internal state, but the closure returns no notification.

**Call relations**: Used by flows such as thread fork or detached review startup where silent registration is desired. It shares the same underlying state mutation path as `upsert_thread` but suppresses the initial notification.

*Call graph*: calls 1 internal fn (mutate_and_publish); called by 2 (thread_fork_inner, start_detached_review).


##### `ThreadWatchManager::remove_thread`  (lines 106–110)

```
async fn remove_thread(&self, thread_id: &str)
```

**Purpose**: Stops tracking a thread and transitions its visible status to `NotLoaded`, optionally notifying clients if that is a real change. It is the inverse of thread upsert.

**Data flow**: Clones the input `&str` into an owned `String`, then calls `mutate_and_publish` with `state.remove_thread(&thread_id)`. The internal runtime facts are removed, any watcher is updated to `NotLoaded`, and a notification may be emitted.

**Call relations**: Called when a thread is unloaded or finalized. It delegates the actual removal and notification decision to `ThreadWatchState::remove_thread`.

*Call graph*: calls 1 internal fn (mutate_and_publish); called by 3 (apply_bespoke_event_handling, unload_thread_without_subscribers, finalize_thread_teardown).


##### `ThreadWatchManager::loaded_status_for_thread`  (lines 112–114)

```
async fn loaded_status_for_thread(&self, thread_id: &str) -> ThreadStatus
```

**Purpose**: Returns the current derived status for one thread, defaulting to `NotLoaded` when the thread is untracked. It is the primary read API for single-thread status.

**Data flow**: Locks `self.state`, calls `loaded_status_for_thread(thread_id)` on `ThreadWatchState`, and returns the resulting `ThreadStatus`. No mutation occurs.

**Call relations**: Queried by many response-building paths that need to include current thread status in API results. It is a thin async wrapper over the internal state object.

*Call graph*: called by 11 (apply_bespoke_event_handling, handle_pending_thread_resume_request, read_thread_view, resume_running_thread, thread_fork_inner, thread_metadata_update_response_inner, thread_resume_inner, thread_turns_list_response_inner, thread_unarchive_response, start_detached_review (+1 more)).


##### `ThreadWatchManager::loaded_statuses_for_threads`  (lines 116–128)

```
async fn loaded_statuses_for_threads(
        &self,
        thread_ids: Vec<String>,
    ) -> HashMap<String, ThreadStatus>
```

**Purpose**: Returns current derived statuses for a batch of thread IDs, filling in `NotLoaded` for any untracked IDs. It supports list/search responses that need status for many threads at once.

**Data flow**: Locks `self.state`, iterates the provided `Vec<String>`, computes `state.loaded_status_for_thread(&thread_id)` for each, and collects the pairs into a `HashMap<String, ThreadStatus>`. It does not mutate state.

**Call relations**: Used by thread list/search handlers to enrich thread summaries with runtime status. It repeatedly delegates to the internal single-thread status resolver while holding one lock.

*Call graph*: called by 2 (thread_list_response_inner, thread_search_response_inner).


##### `ThreadWatchManager::running_turn_count`  (lines 131–139)

```
async fn running_turn_count(&self) -> usize
```

**Purpose**: Test-only helper that counts how many tracked threads currently have `runtime.running == true`. It intentionally ignores pending permission/user-input counters.

**Data flow**: Locks `self.state`, iterates `runtime_by_thread_id.values()`, filters to `runtime.running`, counts them, and returns the count as `usize`. No state is changed.

**Call relations**: Used only in tests to validate the semantics of running-turn counting. Production code instead consumes the watch channel from `subscribe_running_turn_count`.


##### `ThreadWatchManager::subscribe_running_turn_count`  (lines 141–143)

```
fn subscribe_running_turn_count(&self) -> watch::Receiver<usize>
```

**Purpose**: Returns a watch receiver that updates whenever the number of currently running turns changes. This exposes aggregate activity as a reactive stream.

**Data flow**: Reads `self.running_turn_count_tx` and returns `self.running_turn_count_tx.subscribe()`. It does not mutate manager state.

**Call relations**: Called by code that wants to observe total running assistant turns. The sender side is updated inside `mutate_and_publish` after every state mutation.

*Call graph*: called by 1 (subscribe_running_assistant_turn_count); 1 external calls (subscribe).


##### `ThreadWatchManager::note_turn_started`  (lines 145–152)

```
async fn note_turn_started(&self, thread_id: &str)
```

**Purpose**: Marks a thread as loaded and actively running, clearing any prior system-error flag. This is the status transition for the start of a turn.

**Data flow**: Takes `&self` and `thread_id`, then calls `update_runtime_for_thread` with a closure that sets `runtime.is_loaded = true`, `runtime.running = true`, and `runtime.has_system_error = false`. The resulting mutation may emit a status-change notification and updates running-turn count.

**Call relations**: Called by bespoke event handling when a turn-start event arrives. It delegates mutation and publication to `update_runtime_for_thread` and ultimately `mutate_and_publish`.

*Call graph*: calls 1 internal fn (update_runtime_for_thread); called by 1 (apply_bespoke_event_handling).


##### `ThreadWatchManager::note_turn_completed`  (lines 154–156)

```
async fn note_turn_completed(&self, thread_id: &str, _failed: bool)
```

**Purpose**: Clears active-running and pending-request state after a turn completes. The `_failed` parameter is currently ignored for status purposes.

**Data flow**: Accepts `thread_id` and `_failed: bool`, then awaits `clear_active_state(thread_id)`, which sets `running = false` and zeroes pending counters. It returns `()`.

**Call relations**: Called by event handling on turn completion. It delegates all actual state changes to `clear_active_state`.

*Call graph*: calls 1 internal fn (clear_active_state); called by 1 (apply_bespoke_event_handling).


##### `ThreadWatchManager::note_turn_interrupted`  (lines 158–160)

```
async fn note_turn_interrupted(&self, thread_id: &str)
```

**Purpose**: Clears active-running and pending-request state after a turn is interrupted. Status-wise it behaves the same as completion.

**Data flow**: Accepts `thread_id` and awaits `clear_active_state(thread_id)`, which resets `running` and both pending counters. It returns `()`.

**Call relations**: Called by event handling on interruption. It shares the same cleanup path as `note_turn_completed`.

*Call graph*: calls 1 internal fn (clear_active_state); called by 1 (apply_bespoke_event_handling).


##### `ThreadWatchManager::note_thread_shutdown`  (lines 162–170)

```
async fn note_thread_shutdown(&self, thread_id: &str)
```

**Purpose**: Marks a thread as no longer loaded and clears all active/pending runtime facts. This transitions the thread toward `NotLoaded` status.

**Data flow**: Calls `update_runtime_for_thread` with a closure that sets `running = false`, both pending counters to `0`, and `is_loaded = false`. The mutation may emit a notification and updates aggregate running-turn count.

**Call relations**: Used when a thread shuts down cleanly. It delegates mutation and publication through the standard runtime-update path.

*Call graph*: calls 1 internal fn (update_runtime_for_thread); called by 1 (apply_bespoke_event_handling).


##### `ThreadWatchManager::note_system_error`  (lines 172–180)

```
async fn note_system_error(&self, thread_id: &str)
```

**Purpose**: Marks a thread as having encountered a system error while also clearing active-running and pending-request state. This drives the visible `SystemError` status.

**Data flow**: Calls `update_runtime_for_thread` with a closure that sets `running = false`, both pending counters to `0`, and `has_system_error = true`. It returns `()` after the mutation/publish cycle completes.

**Call relations**: Called by bespoke event handling when a system-level failure occurs. It uses the same mutation pipeline as other status transitions so watchers and notifications stay consistent.

*Call graph*: calls 1 internal fn (update_runtime_for_thread); called by 1 (apply_bespoke_event_handling).


##### `ThreadWatchManager::clear_active_state`  (lines 182–189)

```
async fn clear_active_state(&self, thread_id: &str)
```

**Purpose**: Internal helper that clears the runtime flags associated with an active turn or pending interactive waits. It leaves `is_loaded` and `has_system_error` untouched.

**Data flow**: Accepts `thread_id`, calls `update_runtime_for_thread` with a closure that sets `running = false`, `pending_permission_requests = 0`, and `pending_user_input_requests = 0`, then returns `()`. It mutates one thread’s `RuntimeFacts`.

**Call relations**: Used by both `note_turn_completed` and `note_turn_interrupted` to share identical cleanup behavior. It delegates publication and watcher updates to `update_runtime_for_thread`.

*Call graph*: calls 1 internal fn (update_runtime_for_thread); called by 2 (note_turn_completed, note_turn_interrupted).


##### `ThreadWatchManager::note_permission_requested`  (lines 191–197)

```
async fn note_permission_requested(
        &self,
        thread_id: &str,
    ) -> ThreadWatchActiveGuard
```

**Purpose**: Records that a thread is waiting on a permission decision and returns a guard whose lifetime represents that wait. The thread becomes `Active` with the approval flag while the guard exists.

**Data flow**: Accepts `thread_id`, awaits `note_pending_request(thread_id, ThreadWatchActiveGuardType::Permission)`, and returns the resulting `ThreadWatchActiveGuard`. The underlying mutation increments `pending_permission_requests`.

**Call relations**: Called by event handling when the server asks the client for approval. It is a typed wrapper over `note_pending_request` selecting the permission counter.

*Call graph*: calls 1 internal fn (note_pending_request); called by 1 (apply_bespoke_event_handling).


##### `ThreadWatchManager::note_user_input_requested`  (lines 199–205)

```
async fn note_user_input_requested(
        &self,
        thread_id: &str,
    ) -> ThreadWatchActiveGuard
```

**Purpose**: Records that a thread is waiting on user input and returns a guard whose lifetime represents that wait. The thread becomes `Active` with the user-input flag while the guard exists.

**Data flow**: Accepts `thread_id`, awaits `note_pending_request(thread_id, ThreadWatchActiveGuardType::UserInput)`, and returns the guard. The underlying mutation increments `pending_user_input_requests`.

**Call relations**: Called by event handling when the server requests user input. It is the user-input counterpart to `note_permission_requested`.

*Call graph*: calls 1 internal fn (note_pending_request); called by 1 (apply_bespoke_event_handling).


##### `ThreadWatchManager::note_pending_request`  (lines 207–219)

```
async fn note_pending_request(
        &self,
        thread_id: &str,
        guard_type: ThreadWatchActiveGuardType,
    ) -> ThreadWatchActiveGuard
```

**Purpose**: Internal helper that increments the appropriate pending-request counter for a thread and creates the corresponding RAII guard. It centralizes the shared logic for permission and user-input waits.

**Data flow**: Accepts `thread_id` and a `ThreadWatchActiveGuardType`, calls `update_runtime_for_thread` with a closure that sets `runtime.is_loaded = true`, selects the relevant counter via `pending_counter`, and increments it with `saturating_add(1)`. After the mutation it returns `ThreadWatchActiveGuard::new(self.clone(), thread_id.to_string(), guard_type)`.

**Call relations**: Invoked by `note_permission_requested` and `note_user_input_requested`. It delegates counter selection to `pending_counter`, status publication to `update_runtime_for_thread`, and guard construction to `ThreadWatchActiveGuard::new`.

*Call graph*: calls 2 internal fn (new, update_runtime_for_thread); called by 2 (note_permission_requested, note_user_input_requested).


##### `ThreadWatchManager::mutate_and_publish`  (lines 221–244)

```
async fn mutate_and_publish(&self, mutate: F)
```

**Purpose**: Runs one state mutation, recomputes aggregate running-turn count, updates the running-count watch channel, and optionally broadcasts a `ThreadStatusChanged` notification. It is the manager’s central mutation pipeline.

**Data flow**: Accepts a closure `FnOnce(&mut ThreadWatchState) -> Option<ThreadStatusChangedNotification>`. It locks `self.state`, applies the closure, counts `runtime.running` threads in `runtime_by_thread_id`, unlocks, sends the count on `running_turn_count_tx`, and if both a notification and `self.outgoing` exist, awaits `outgoing.send_server_notification(ServerNotification::ThreadStatusChanged(notification))`. It returns `()`.

**Call relations**: All public mutating manager methods funnel through this function either directly or via `update_runtime_for_thread`. It coordinates internal state changes with both local watch updates and external client notifications.

*Call graph*: called by 4 (remove_thread, update_runtime_for_thread, upsert_thread, upsert_thread_silently); 2 external calls (send, ThreadStatusChanged).


##### `ThreadWatchManager::subscribe`  (lines 246–251)

```
async fn subscribe(
        &self,
        thread_id: ThreadId,
    ) -> Option<watch::Receiver<ThreadStatus>>
```

**Purpose**: Subscribes to status updates for one thread and immediately yields a receiver seeded with the current status. It exposes per-thread status as a watch stream.

**Data flow**: Accepts a `ThreadId`, converts it to `String`, locks `self.state`, calls `state.subscribe(thread_id_string)`, and wraps the resulting `watch::Receiver<ThreadStatus>` in `Some(...)`. It does not currently return `None`.

**Call relations**: Used by code and tests that want reactive updates for a specific thread. It delegates receiver creation and seeding to `ThreadWatchState::subscribe`.

*Call graph*: 1 external calls (to_string).


##### `ThreadWatchManager::note_active_guard_released`  (lines 253–263)

```
async fn note_active_guard_released(
        &self,
        thread_id: String,
        guard_type: ThreadWatchActiveGuardType,
    )
```

**Purpose**: Internal counterpart to guard creation that decrements the appropriate pending-request counter when a `ThreadWatchActiveGuard` is dropped. It ensures counters cannot underflow.

**Data flow**: Accepts owned `thread_id: String` and `guard_type`, then calls `update_runtime_for_thread` with a closure that selects the relevant counter via `pending_counter` and decrements it using `saturating_sub(1)`. It returns `()`.

**Call relations**: Reached only from `ThreadWatchActiveGuard::drop`, which spawns it asynchronously. It shares the same mutation/publication path as all other runtime updates.

*Call graph*: calls 1 internal fn (update_runtime_for_thread).


##### `ThreadWatchManager::update_runtime_for_thread`  (lines 265–272)

```
async fn update_runtime_for_thread(&self, thread_id: &str, update: F)
```

**Purpose**: Wraps a mutation of one thread’s `RuntimeFacts` in the manager’s publish pipeline. It is the common helper behind all runtime-status transitions.

**Data flow**: Accepts `thread_id` and a closure `FnOnce(&mut RuntimeFacts)`, clones the thread ID into an owned `String`, and calls `mutate_and_publish(move |state| state.update_runtime(&thread_id, update))`. It returns `()` after the mutation and any notification complete.

**Call relations**: Used by turn lifecycle methods, pending-request methods, and guard-release handling. It delegates actual state mutation to `ThreadWatchState::update_runtime` and publication to `mutate_and_publish`.

*Call graph*: calls 1 internal fn (mutate_and_publish); called by 6 (clear_active_state, note_active_guard_released, note_pending_request, note_system_error, note_thread_shutdown, note_turn_started).


##### `ThreadWatchManager::pending_counter`  (lines 274–282)

```
fn pending_counter(
        runtime: &mut RuntimeFacts,
        guard_type: ThreadWatchActiveGuardType,
    ) -> &mut u32
```

**Purpose**: Selects which pending-request counter inside `RuntimeFacts` corresponds to a guard type. It avoids duplicating match logic in increment/decrement paths.

**Data flow**: Takes `&mut RuntimeFacts` and a `ThreadWatchActiveGuardType`, matches on the enum, and returns a mutable reference to either `pending_permission_requests` or `pending_user_input_requests`. It does not itself change the value.

**Call relations**: Used by both `note_pending_request` and `note_active_guard_released` to mutate the correct counter. It is a small internal utility within the status subsystem.


##### `resolve_thread_status`  (lines 285–299)

```
fn resolve_thread_status(
    status: ThreadStatus,
    has_in_progress_turn: bool,
) -> ThreadStatus
```

**Purpose**: Adjusts a derived thread status when another subsystem knows a turn is already in progress but the watch state has not yet reflected it. It closes a race window by preferring `Active` over stale `Idle`/`NotLoaded`.

**Data flow**: Accepts a `ThreadStatus` and `has_in_progress_turn: bool`. If the flag is true and the status is `Idle` or `NotLoaded`, it returns `ThreadStatus::Active { active_flags: Vec::new() }`; otherwise it returns the input status unchanged. No state is mutated.

**Call relations**: Called by code that combines watch-derived status with listener-observed active-turn state. It does not delegate beyond a simple pattern match and vector construction.

*Call graph*: called by 1 (resolves_in_progress_turn_to_active_status); 2 external calls (new, matches!).


##### `ThreadWatchState::upsert_thread`  (lines 308–325)

```
fn upsert_thread(
        &mut self,
        thread_id: String,
        emit_notification: bool,
    ) -> Option<ThreadStatusChangedNotification>
```

**Purpose**: Ensures a thread has runtime facts, marks it loaded, updates any watcher, and optionally produces a status-change notification. It is the internal implementation behind manager-level thread registration.

**Data flow**: Accepts `thread_id: String` and `emit_notification: bool`. It computes `previous_status` via `status_for`, inserts or gets `RuntimeFacts` in `runtime_by_thread_id`, sets `runtime.is_loaded = true`, updates the per-thread watcher via `update_status_watcher_for_thread`, and returns either `status_changed_notification(thread_id, previous_status)` or `None` depending on `emit_notification`.

**Call relations**: Called only through `ThreadWatchManager::{upsert_thread, upsert_thread_silently}`. It coordinates runtime-map insertion with watcher maintenance and optional notification generation.

*Call graph*: calls 3 internal fn (status_changed_notification, status_for, update_status_watcher_for_thread).


##### `ThreadWatchState::remove_thread`  (lines 327–339)

```
fn remove_thread(&mut self, thread_id: &str) -> Option<ThreadStatusChangedNotification>
```

**Purpose**: Deletes a thread’s runtime facts, pushes `NotLoaded` to any watcher, and emits a notification only if the visible status actually changed. It is the internal removal path.

**Data flow**: Accepts `&str thread_id`, computes `previous_status`, removes the thread from `runtime_by_thread_id`, updates any watcher to `ThreadStatus::NotLoaded`, and returns `Some(ThreadStatusChangedNotification { ... NotLoaded ... })` only when the thread previously existed and was not already `NotLoaded`; otherwise returns `None`.

**Call relations**: Used by `ThreadWatchManager::remove_thread`. It delegates watcher updates to `update_status_watcher` and bases notification emission on the prior derived status.

*Call graph*: calls 2 internal fn (status_for, update_status_watcher).


##### `ThreadWatchState::update_runtime`  (lines 341–358)

```
fn update_runtime(
        &mut self,
        thread_id: &str,
        mutate: F,
    ) -> Option<ThreadStatusChangedNotification>
```

**Purpose**: Applies an arbitrary mutation to one thread’s `RuntimeFacts`, ensures the thread is considered loaded, refreshes watchers, and emits a notification if the derived status changed. It is the internal workhorse for runtime transitions.

**Data flow**: Accepts `thread_id`, a mutation closure, computes `previous_status`, inserts or gets `RuntimeFacts`, sets `runtime.is_loaded = true`, applies the closure, updates the watcher via `update_status_watcher_for_thread`, and returns `status_changed_notification(thread_id.to_string(), previous_status)`. It mutates `runtime_by_thread_id` and possibly watcher state.

**Call relations**: Reached through `ThreadWatchManager::update_runtime_for_thread`. It centralizes status-delta detection so all runtime mutations share the same notification semantics.

*Call graph*: calls 3 internal fn (status_changed_notification, status_for, update_status_watcher_for_thread).


##### `ThreadWatchState::status_for`  (lines 360–364)

```
fn status_for(&self, thread_id: &str) -> Option<ThreadStatus>
```

**Purpose**: Computes the current derived status for a tracked thread if runtime facts exist. It is the internal optional-status accessor.

**Data flow**: Looks up `runtime_by_thread_id.get(thread_id)` and maps the `RuntimeFacts` through `loaded_thread_status`, returning `Option<ThreadStatus>`. It does not mutate state.

**Call relations**: Used by status reads, notification generation, and watcher updates. It is the common primitive for deriving status from runtime facts.

*Call graph*: called by 5 (loaded_status_for_thread, remove_thread, status_changed_notification, update_runtime, upsert_thread).


##### `ThreadWatchState::loaded_status_for_thread`  (lines 366–369)

```
fn loaded_status_for_thread(&self, thread_id: &str) -> ThreadStatus
```

**Purpose**: Returns a thread’s derived status, defaulting to `NotLoaded` when no runtime facts exist. It is the internal total-status accessor.

**Data flow**: Calls `status_for(thread_id)` and unwraps it with `ThreadStatus::NotLoaded` as the default. No state is changed.

**Call relations**: Used by manager read APIs, watcher seeding, and watcher refresh logic. It wraps `status_for` to avoid repeated defaulting logic.

*Call graph*: calls 1 internal fn (status_for); called by 2 (subscribe, update_status_watcher_for_thread).


##### `ThreadWatchState::subscribe`  (lines 371–378)

```
fn subscribe(&mut self, thread_id: String) -> watch::Receiver<ThreadStatus>
```

**Purpose**: Creates or reuses a per-thread watch sender and returns a receiver seeded with the thread’s current status. It is the internal implementation of per-thread status subscriptions.

**Data flow**: Accepts owned `thread_id: String`, computes the current status with `loaded_status_for_thread`, inserts a `watch::channel(status.clone()).0` into `status_watcher_by_thread_id` if absent, and returns `sender.subscribe()`. It mutates the watcher map when first subscribing.

**Call relations**: Called by `ThreadWatchManager::subscribe`. It ensures subscribers immediately observe the current status even if no future updates occur.

*Call graph*: calls 1 internal fn (loaded_status_for_thread).


##### `ThreadWatchState::update_status_watcher_for_thread`  (lines 380–383)

```
fn update_status_watcher_for_thread(&mut self, thread_id: &str)
```

**Purpose**: Refreshes a thread’s watcher with its current derived status. It is a convenience wrapper around status computation plus watcher update.

**Data flow**: Computes `status = loaded_status_for_thread(thread_id)` and passes it to `update_status_watcher(thread_id, &status)`. It may mutate or remove the watcher entry.

**Call relations**: Used after upsert and runtime updates so any subscribed receivers see the latest status. It delegates actual send/remove behavior to `update_status_watcher`.

*Call graph*: calls 2 internal fn (loaded_status_for_thread, update_status_watcher); called by 2 (update_runtime, upsert_thread).


##### `ThreadWatchState::update_status_watcher`  (lines 385–403)

```
fn update_status_watcher(&mut self, thread_id: &str, status: &ThreadStatus)
```

**Purpose**: Pushes a specific status into an existing per-thread watcher if it changed, and drops the watcher entry when there are no receivers left. It keeps the watcher map tidy and avoids redundant sends.

**Data flow**: Looks up `status_watcher_by_thread_id[thread_id]`; if present, clones the target status and calls `send_if_modified` to replace the current value only when different. It then checks `sender.receiver_count() == 0` and removes the watcher entry if no receivers remain. If no sender exists, it does nothing.

**Call relations**: Called by `remove_thread` and `update_status_watcher_for_thread`. It is the only place that mutates existing watcher senders and prunes unused watcher entries.

*Call graph*: called by 2 (remove_thread, update_status_watcher_for_thread); 1 external calls (clone).


##### `ThreadWatchState::status_changed_notification`  (lines 405–417)

```
fn status_changed_notification(
        &self,
        thread_id: String,
        previous_status: Option<ThreadStatus>,
    ) -> Option<ThreadStatusChangedNotification>
```

**Purpose**: Builds a `ThreadStatusChangedNotification` only when the current derived status differs from a previously captured status. It encapsulates the subsystem’s no-op suppression rule.

**Data flow**: Accepts owned `thread_id` and `previous_status: Option<ThreadStatus>`, recomputes the current status with `status_for(&thread_id)?`, compares it to `previous_status`, and returns `None` if unchanged or `Some(ThreadStatusChangedNotification { thread_id, status })` if changed. It does not mutate state.

**Call relations**: Used by both `upsert_thread` and `update_runtime` after they mutate runtime facts. It ensures notifications are emitted only on visible transitions.

*Call graph*: calls 1 internal fn (status_for); called by 2 (update_runtime, upsert_thread).


##### `loaded_thread_status`  (lines 429–451)

```
fn loaded_thread_status(runtime: &RuntimeFacts) -> ThreadStatus
```

**Purpose**: Derives the externally visible `ThreadStatus` from one thread’s raw runtime facts. This is the core status-resolution policy for the subsystem.

**Data flow**: Reads a `&RuntimeFacts`. If `is_loaded` is false it returns `NotLoaded`. Otherwise it builds `active_flags` by checking `pending_permission_requests` and `pending_user_input_requests`; if `running` is true or any active flags exist, it returns `Active { active_flags }`; else if `has_system_error` is true it returns `SystemError`; otherwise it returns `Idle`. It does not mutate input state.

**Call relations**: Called by `ThreadWatchState::status_for` whenever status must be derived. All manager reads, watcher updates, and notifications ultimately depend on this policy function.

*Call graph*: 1 external calls (new).


##### `tests::loaded_status_defaults_to_not_loaded_for_untracked_threads`  (lines 466–475)

```
async fn loaded_status_defaults_to_not_loaded_for_untracked_threads()
```

**Purpose**: Verifies that querying an unknown thread returns `ThreadStatus::NotLoaded`. It documents the manager’s default read behavior.

**Data flow**: Creates a fresh `ThreadWatchManager`, calls `loaded_status_for_thread` with an untracked ID, and asserts the result is `NotLoaded`. No external state is touched.

**Call relations**: This test exercises the manager read path on empty state. It guards the defaulting behavior implemented by `ThreadWatchState::loaded_status_for_thread`.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `tests::tracks_non_interactive_thread_status`  (lines 478–497)

```
async fn tracks_non_interactive_thread_status()
```

**Purpose**: Checks that a non-interactive thread still transitions to `Active` when a turn starts. It confirms status tracking is not limited to CLI-origin threads.

**Data flow**: Creates a manager, upserts a test thread with `SessionSource::AppServer`, calls `note_turn_started`, then reads and asserts the status is `Active { active_flags: vec![] }`. It mutates only local test manager state.

**Call relations**: This test covers the basic upsert-plus-turn-start path. It demonstrates that source metadata does not alter the runtime status policy.

*Call graph*: calls 1 internal fn (new); 2 external calls (test_thread, assert_eq!).


##### `tests::status_updates_track_single_thread`  (lines 500–575)

```
async fn status_updates_track_single_thread()
```

**Purpose**: Exercises the full lifecycle of one thread through running, waiting on approval, waiting on user input, guard drops, and completion. It validates both counter-based active flags and asynchronous guard-release behavior.

**Data flow**: Creates a manager, upserts a test thread, starts a turn, requests permission and user input to obtain two guards, repeatedly reads status after each step, drops each guard and waits until the expected status appears, then completes the turn and asserts the final status is `Idle`. It mutates only the test manager’s internal state.

**Call relations**: This is the most comprehensive status test in the file, covering `note_turn_started`, `note_permission_requested`, `note_user_input_requested`, guard `Drop`, `wait_for_status`, and `note_turn_completed`. It validates the intended interplay between counters and active flags.

*Call graph*: calls 1 internal fn (new); 4 external calls (test_thread, wait_for_status, assert_eq!, vec!).


##### `tests::resolves_in_progress_turn_to_active_status`  (lines 578–595)

```
fn resolves_in_progress_turn_to_active_status()
```

**Purpose**: Verifies that `resolve_thread_status` upgrades stale `Idle` and `NotLoaded` statuses to `Active` when `has_in_progress_turn` is true. It documents the race-window override behavior.

**Data flow**: Calls `resolve_thread_status` twice with `has_in_progress_turn = true`, once for `Idle` and once for `NotLoaded`, and asserts both results are `Active { active_flags: Vec::new() }`. No mutable state is involved.

**Call relations**: This test directly targets the standalone helper rather than manager state. It protects the special-case logic used when combining watch state with listener-observed activity.

*Call graph*: calls 1 internal fn (resolve_thread_status); 1 external calls (assert_eq!).


##### `tests::keeps_status_when_no_in_progress_turn`  (lines 598–610)

```
fn keeps_status_when_no_in_progress_turn()
```

**Purpose**: Verifies that `resolve_thread_status` leaves statuses unchanged when there is no known in-progress turn. It confirms the helper only overrides in the documented race case.

**Data flow**: Calls `resolve_thread_status` with `Idle` and `SystemError` while passing `false` for `has_in_progress_turn`, then asserts the outputs equal the inputs. No state is mutated.

**Call relations**: This is the negative counterpart to the previous helper test. It ensures the override does not mask legitimate non-active statuses in normal conditions.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::system_error_sets_idle_flag_until_next_turn`  (lines 613–641)

```
async fn system_error_sets_idle_flag_until_next_turn()
```

**Purpose**: Checks that a system error transitions a thread to `SystemError`, and that a subsequent turn start clears that error back to `Active`. It validates error recovery semantics.

**Data flow**: Creates a manager, upserts a thread, starts a turn, marks a system error, asserts `SystemError`, then starts another turn and asserts `Active { active_flags: vec![] }`. It mutates only local manager state.

**Call relations**: This test covers the interaction between `note_system_error` and `note_turn_started`, specifically the latter’s clearing of `has_system_error`. It documents that system error is not sticky across new turns.

*Call graph*: calls 1 internal fn (new); 2 external calls (test_thread, assert_eq!).


##### `tests::shutdown_marks_thread_not_loaded`  (lines 644–662)

```
async fn shutdown_marks_thread_not_loaded()
```

**Purpose**: Verifies that thread shutdown clears loaded/running state and yields `NotLoaded`. It documents the visible effect of `note_thread_shutdown`.

**Data flow**: Creates a manager, upserts a thread, starts a turn, calls `note_thread_shutdown`, then reads and asserts the status is `NotLoaded`. Only test-local manager state changes.

**Call relations**: This test exercises the shutdown path distinct from removal. It confirms that setting `is_loaded = false` dominates the derived status.

*Call graph*: calls 1 internal fn (new); 2 external calls (test_thread, assert_eq!).


##### `tests::loaded_statuses_default_to_not_loaded_for_untracked_threads`  (lines 665–692)

```
async fn loaded_statuses_default_to_not_loaded_for_untracked_threads()
```

**Purpose**: Verifies the batch status API returns real status for tracked threads and `NotLoaded` for untracked ones in the same response. It documents mixed-state behavior.

**Data flow**: Creates a manager, upserts and starts one thread, calls `loaded_statuses_for_threads` with that ID plus an unknown ID, and asserts the resulting map contains `Active` for the tracked thread and `NotLoaded` for the other. It mutates only local test state before the read.

**Call relations**: This test targets the batch read helper rather than single-thread reads. It ensures the manager applies the same defaulting semantics across collections.

*Call graph*: calls 1 internal fn (new); 3 external calls (test_thread, assert_eq!, vec!).


##### `tests::has_running_turns_tracks_runtime_running_flag_only`  (lines 695–718)

```
async fn has_running_turns_tracks_runtime_running_flag_only()
```

**Purpose**: Checks that aggregate running-turn count depends only on the `running` flag, not on pending approval/user-input counters. It distinguishes active waits from active execution.

**Data flow**: Creates a manager, upserts a thread, asserts running count `0`, requests permission and asserts count remains `0`, starts a turn and asserts count becomes `1`, then completes the turn and asserts it returns to `0`. It mutates only local manager state.

**Call relations**: This test validates the counting logic used in `mutate_and_publish` and the test helper `running_turn_count`. It documents that pending interactive requests do not contribute to the aggregate running-turn metric.

*Call graph*: calls 1 internal fn (new); 2 external calls (test_thread, assert_eq!).


##### `tests::status_change_emits_notification`  (lines 721–761)

```
async fn status_change_emits_notification()
```

**Purpose**: Verifies that status transitions emit `ThreadStatusChangedNotification` messages when the manager has an outgoing sender. It covers initial upsert, turn start, and removal.

**Data flow**: Creates an outgoing channel and `ThreadWatchManager::new_with_outgoing`, upserts a thread, starts a turn, removes the thread, and after each step receives one outgoing envelope and extracts/asserts the embedded `ThreadStatusChangedNotification`. It writes notifications into the test channel.

**Call relations**: This test exercises the full notification path through `mutate_and_publish` and `OutgoingMessageSender`. It confirms that visible status changes are broadcast in the expected order and shape.

*Call graph*: calls 3 internal fn (disabled, new, new_with_outgoing); 4 external calls (new, test_thread, assert_eq!, channel).


##### `tests::silent_upsert_skips_initial_notification`  (lines 764–801)

```
async fn silent_upsert_skips_initial_notification()
```

**Purpose**: Verifies that `upsert_thread_silently` updates internal status without emitting the initial notification, while later status changes still notify. It documents the silent-registration contract.

**Data flow**: Creates an outgoing-backed manager, silently upserts a thread, asserts local status is `Idle`, asserts no outgoing message arrives within a timeout, then starts a turn and asserts the next outgoing message is an `Active` status-change notification. It mutates local manager state and reads from the test channel.

**Call relations**: This test distinguishes `upsert_thread_silently` from `upsert_thread`. It confirms that only the initial registration is suppressed; subsequent transitions still flow through normal notification logic.

*Call graph*: calls 3 internal fn (disabled, new, new_with_outgoing); 5 external calls (new, test_thread, assert!, assert_eq!, channel).


##### `tests::status_watchers_receive_only_their_thread_updates`  (lines 804–850)

```
async fn status_watchers_receive_only_their_thread_updates()
```

**Purpose**: Verifies that per-thread watch receivers are isolated: a watcher only receives updates for its own thread. It tests the correctness of the watcher map and update routing.

**Data flow**: Creates a manager, upserts two threads, subscribes to each thread’s status watcher, starts a turn on only the interactive thread, waits for `interactive_rx.changed()`, asserts its borrowed value is `Active`, then asserts `non_interactive_rx.changed()` times out and its borrowed value remains `Idle`. It mutates local manager state and consumes watch notifications.

**Call relations**: This test exercises `ThreadWatchManager::subscribe`, `ThreadWatchState::subscribe`, and watcher updates triggered by `note_turn_started`. It confirms that `update_status_watcher_for_thread` targets only the mutated thread.

*Call graph*: calls 2 internal fn (new, from_string); 5 external calls (from_secs, test_thread, assert!, assert_eq!, timeout).


##### `tests::wait_for_status`  (lines 852–868)

```
async fn wait_for_status(
        manager: &ThreadWatchManager,
        thread_id: &str,
        expected_status: ThreadStatus,
    )
```

**Purpose**: Polls until a thread reaches an expected status or times out. It is a test helper for asynchronous guard-drop transitions.

**Data flow**: Accepts a manager reference, thread ID, and expected `ThreadStatus`; repeatedly calls `loaded_status_for_thread`, compares to the expected value, and yields with `tokio::task::yield_now()` until matched or a one-second timeout expires. It returns `()` or panics on timeout.

**Call relations**: Used by tests that rely on asynchronous status updates, especially those triggered by `ThreadWatchActiveGuard::drop`. It abstracts the eventual-consistency wait loop away from individual assertions.

*Call graph*: calls 1 internal fn (loaded_status_for_thread); 3 external calls (from_secs, yield_now, timeout).


##### `tests::recv_status_changed_notification`  (lines 870–887)

```
async fn recv_status_changed_notification(
        outgoing_rx: &mut mpsc::Receiver<OutgoingEnvelope>,
    ) -> ThreadStatusChangedNotification
```

**Purpose**: Receives and unwraps the next outgoing thread-status notification from the test channel, asserting the envelope and message variants are correct. It is a focused helper for notification tests.

**Data flow**: Accepts `&mut mpsc::Receiver<OutgoingEnvelope>`, awaits `recv()` under a one-second timeout, pattern-matches the envelope as `OutgoingEnvelope::Broadcast`, pattern-matches the message as `OutgoingMessage::AppServerNotification(ServerNotification::ThreadStatusChanged(notification))`, and returns the extracted notification. It panics if any shape is unexpected.

**Call relations**: Used by notification-emission tests to keep their bodies concise. It codifies the exact transport/message wrapping expected from `mutate_and_publish`.

*Call graph*: calls 1 internal fn (recv); 3 external calls (from_secs, panic!, timeout).


##### `tests::test_thread`  (lines 889–912)

```
fn test_thread(thread_id: &str, source: codex_app_server_protocol::SessionSource) -> Thread
```

**Purpose**: Builds a concrete `codex_app_server_protocol::Thread` fixture with stable defaults for tests. It lets tests focus on status behavior rather than thread struct construction.

**Data flow**: Accepts `thread_id: &str` and a `SessionSource`, then returns a populated `Thread` struct with matching `id` and `session_id`, empty preview/turns, fixed provider/version metadata, `status: NotLoaded`, and a test absolute cwd. It writes no external state.

**Call relations**: Used throughout the test module by upsert-related tests. It standardizes fixture shape so status assertions are not coupled to unrelated thread fields.

*Call graph*: 3 external calls (new, new, test_path_buf).


### `core/src/review_format.rs`

`domain_logic` · `review result rendering for UI messages and review-mode exit flows`

This module converts structured review protocol objects into readable text blocks while deliberately staying presentation-neutral. The smallest helper, `format_location`, turns a `ReviewFinding`'s absolute file path and line range into a compact `path:start-end` string using the path's display representation. The main formatter, `format_review_findings_block`, builds a multi-line block beginning with a blank line and a singular or plural header depending on the number of findings. It then emits one section per finding, separated by blank lines.

Each finding line includes the title and formatted location. When a `selection` slice is provided, the formatter prepends a checkbox marker: `[x]` for selected and `[ ]` for unselected. Importantly, if the selection slice is shorter than the findings list, missing indices default to selected rather than unselected. Without a selection slice, the output uses a simpler bullet form. The finding body is split on line boundaries and each line is indented by two spaces, preserving multi-line explanations.

`render_review_output_text` combines the optional overall explanation and the formatted findings block into a final user-facing summary. It trims the explanation, omits empty sections, inserts a blank line between explanation and findings when both exist, and falls back to the constant message `Reviewer failed to output a response.` when neither explanation nor findings contain usable content.

#### Function details

##### `format_location`  (lines 7–12)

```
fn format_location(item: &ReviewFinding) -> String
```

**Purpose**: Formats a review finding's source location as a single `path:start-end` string. It extracts the absolute file path and inclusive line range endpoints from the finding.

**Data flow**: It reads `item.code_location.absolute_file_path` and `item.code_location.line_range.{start,end}`, converts the path with `.display()`, interpolates those values into a formatted string, and returns that `String`. It does not mutate any state.

**Call relations**: This helper is called by `format_review_findings_block` for each finding so location formatting stays consistent across all rendered review lists.

*Call graph*: called by 1 (format_review_findings_block); 1 external calls (format!).


##### `format_review_findings_block`  (lines 23–58)

```
fn format_review_findings_block(
    findings: &[ReviewFinding],
    selection: Option<&[bool]>,
) -> String
```

**Purpose**: Builds the plain-text block listing one or more review findings, optionally annotated with checkbox selection markers. It handles headers, spacing, per-item titles and locations, and indented multi-line bodies.

**Data flow**: It takes a slice of `ReviewFinding` and an optional slice of selection flags. It creates a `Vec<String>`, pushes an initial blank line and either `Review comment:` or `Full review comments:` based on `findings.len()`, then iterates over findings with indices. For each item it computes the location via `format_location`, chooses either a checkbox-prefixed or plain bullet line, defaults missing selection entries to `true`, appends each body line prefixed with two spaces, and finally joins all accumulated lines with `"\n"` into the returned `String`.

**Call relations**: This formatter is called by `render_review_output_text` when findings are present, and also by `exit_review_mode` in flows that need a standalone findings block. It delegates only location rendering to `format_location`; all list assembly logic is local.

*Call graph*: calls 1 internal fn (format_location); called by 3 (render_review_output_text, render_review_output_text, exit_review_mode); 5 external calls (new, new, format!, iter, len).


##### `render_review_output_text`  (lines 64–82)

```
fn render_review_output_text(output: &ReviewOutputEvent) -> String
```

**Purpose**: Produces the final human-readable review summary from a `ReviewOutputEvent`, combining the overall explanation and findings block when present. It guarantees a non-empty fallback message if the event contains no usable text.

**Data flow**: It reads `output.overall_explanation` and `output.findings`, trims the explanation, conditionally pushes it into a `Vec<String>`, formats findings with `format_review_findings_block(..., None)` when the findings list is non-empty, trims that block before adding it, and returns either the fallback constant or the sections joined with a blank line separator. It writes no external state.

**Call relations**: This function is used by `exit_review_mode` and by a test validating review lifecycle/output behavior. It delegates findings rendering to `format_review_findings_block` and acts as the top-level text assembly step for review output.

*Call graph*: calls 1 internal fn (format_review_findings_block); called by 2 (exit_review_mode, review_op_emits_lifecycle_and_review_output); 1 external calls (new).


### `app-server-protocol/src/protocol/event_mapping.rs`

`domain_logic` · `request/event handling`

This file is a dense event translation table centered on `item_event_to_server_notification`, which pattern-matches over supported `EventMsg` variants and constructs the exact `ServerNotification` variant expected by the app-server protocol. The function eagerly clones the incoming `thread_id` and `turn_id` into owned `String`s, then builds typed notification payloads such as `ItemStartedNotification`, `ItemCompletedNotification`, `AgentMessageDeltaNotification`, `PlanDeltaNotification`, `ReasoningSummaryTextDeltaNotification`, `ReasoningTextDeltaNotification`, `ReasoningSummaryPartAddedNotification`, `FileChangePatchUpdatedNotification`, `CommandExecutionOutputDeltaNotification`, and `TerminalInteractionNotification`.

The most involved mappings are collaboration-agent events, which are normalized into `ThreadItem::CollabAgentToolCall` with a concrete `CollabAgentTool` (`SpawnAgent`, `SendInput`, `Wait`, `CloseAgent`, `ResumeAgent`), a derived `CollabAgentToolCallStatus`, receiver thread lists, and an `agents_states` `HashMap<String, CollabAgentState>`. Failure is inferred from `AgentStatus::Errored(_)` and `AgentStatus::NotFound`; spawn-end also fails when no receiver thread was created. Dynamic tool responses become `ThreadItem::DynamicToolCall`, including conversion of core output content items into protocol v2 `DynamicToolCallOutputContentItem` values and a fallible `u128`-to-`i64` duration conversion via `try_from(...).ok()`. Command execution begin/end reuse builder helpers, patch updates reuse `convert_patch_changes`, and command output bytes are decoded with `String::from_utf8_lossy`, preserving malformed UTF-8 as replacement characters instead of failing. Unsupported events are treated as programmer error with `unreachable!`, making the function intentionally partial despite its broad match coverage. The test module verifies representative mappings for resume begin/end and command output delta using small assertion helpers that destructure the resulting notification variant.

#### Function details

##### `item_event_to_server_notification`  (lines 30–464)

```
fn item_event_to_server_notification(
    msg: EventMsg,
    thread_id: &str,
    turn_id: &str,
) -> ServerNotification
```

**Purpose**: Converts one supported core `EventMsg` into the exact v2 `ServerNotification` emitted to app-server clients for that event. It performs only direct, stateless projection; callers are expected to do any sequencing, filtering, or side-effect management before invoking it.

**Data flow**: Inputs are an owned `EventMsg` plus borrowed `thread_id` and `turn_id` strings. The function copies the IDs into owned `String`s, matches on the event variant, and constructs a notification payload by moving event fields into protocol v2 structs and `ThreadItem` variants, deriving statuses where needed, converting patch changes and command items through helper functions, converting agent statuses through `CollabAgentState::from`, decoding command output bytes with `String::from_utf8_lossy`, and collecting receiver/state maps into `Vec<String>` and `HashMap<String, CollabAgentState>`. It returns a single `ServerNotification`; it does not mutate external state.

**Call relations**: This is the file's central translation routine and the target exercised by all three tests in the module. In its internal control flow it delegates specialized sub-conversions to `build_command_execution_begin_item`, `build_command_execution_end_item`, and `convert_patch_changes` for command and patch events, while directly constructing all other notification variants inline; unsupported variants terminate via `unreachable!` rather than being ignored.

*Call graph*: calls 4 internal fn (build_command_execution_begin_item, build_command_execution_end_item, convert_patch_changes, from); called by 3 (collab_resume_begin_maps_to_item_started_resume_agent, collab_resume_end_maps_to_item_completed_resume_agent, exec_command_output_delta_maps_to_command_execution_output_delta); 17 external calls (new, AgentMessageDelta, CommandExecutionOutputDelta, FileChangePatchUpdated, ItemCompleted, ItemStarted, PlanDelta, ReasoningSummaryPartAdded, ReasoningSummaryTextDelta, ReasoningTextDelta (+7 more)).


##### `tests::assert_item_started_server_notification`  (lines 476–484)

```
fn assert_item_started_server_notification(
        notification: ServerNotification,
        expected: ItemStartedNotification,
    )
```

**Purpose**: Test helper that verifies a produced `ServerNotification` is specifically `ServerNotification::ItemStarted` and that its payload exactly matches an expected `ItemStartedNotification`.

**Data flow**: It takes an actual `ServerNotification` and an expected `ItemStartedNotification`. The function pattern-matches the notification; on the `ItemStarted` branch it compares the payload with `assert_eq!`, and on any other variant it aborts the test with `panic!` including the unexpected value.

**Call relations**: This helper is used by the resume-begin test after calling `item_event_to_server_notification`, so it sits at the final assertion step of that test's flow. It delegates only to `assert_eq!` for structural comparison and `panic!` for variant mismatch reporting.

*Call graph*: 2 external calls (assert_eq!, panic!).


##### `tests::assert_item_completed_server_notification`  (lines 486–494)

```
fn assert_item_completed_server_notification(
        notification: ServerNotification,
        expected: ItemCompletedNotification,
    )
```

**Purpose**: Test helper that checks that a notification is the `ItemCompleted` variant and that the embedded `ItemCompletedNotification` equals the expected structure.

**Data flow**: It receives a `ServerNotification` and an expected `ItemCompletedNotification`. It destructures the notification, compares payloads with `assert_eq!` when the variant matches, and otherwise fails the test with `panic!` describing the unexpected variant.

**Call relations**: The resume-end test invokes this helper after obtaining a mapped notification from `item_event_to_server_notification`. Like the started-version helper, it is purely a terminal assertion wrapper around variant matching plus equality checking.

*Call graph*: 2 external calls (assert_eq!, panic!).


##### `tests::assert_command_execution_output_delta_server_notification`  (lines 496–506)

```
fn assert_command_execution_output_delta_server_notification(
        notification: ServerNotification,
        expected: CommandExecutionOutputDeltaNotification,
    )
```

**Purpose**: Test helper that asserts a notification is `ServerNotification::CommandExecutionOutputDelta` and that its payload matches the expected `CommandExecutionOutputDeltaNotification`.

**Data flow**: It accepts the actual `ServerNotification` and expected delta notification. The function matches on the notification, compares the extracted payload with `assert_eq!` if the variant is correct, and calls `panic!` if any other notification variant is returned.

**Call relations**: This helper is used only by the command-output-delta test, where it validates the final result of `item_event_to_server_notification`. It does not perform any conversion itself; it is the last verification step in that test path.

*Call graph*: 2 external calls (assert_eq!, panic!).


##### `tests::collab_resume_begin_maps_to_item_started_resume_agent`  (lines 509–543)

```
fn collab_resume_begin_maps_to_item_started_resume_agent()
```

**Purpose**: Verifies that a `CollabResumeBeginEvent` is translated into an `ItemStartedNotification` containing a `ThreadItem::CollabAgentToolCall` for `CollabAgentTool::ResumeAgent` with `InProgress` status and no agent-state map entries.

**Data flow**: The test constructs a `CollabResumeBeginEvent` with fresh `ThreadId` values, wraps it in `EventMsg::CollabResumeBegin`, and passes it with literal thread/turn IDs into `item_event_to_server_notification`. It then builds the exact expected `ItemStartedNotification`, including `receiver_thread_ids` as a one-element vector and `agents_states` as an empty `HashMap`, and feeds both actual and expected values into the assertion helper.

**Call relations**: This test drives the `CollabResumeBegin` branch of `item_event_to_server_notification`. After invoking the mapper, it delegates result checking to `tests::assert_item_started_server_notification`, making it a focused regression test for one collaboration-event projection.

*Call graph*: calls 2 internal fn (item_event_to_server_notification, new); 4 external calls (new, assert_item_started_server_notification, CollabResumeBegin, vec!).


##### `tests::collab_resume_end_maps_to_item_completed_resume_agent`  (lines 546–587)

```
fn collab_resume_end_maps_to_item_completed_resume_agent()
```

**Purpose**: Verifies that a `CollabResumeEndEvent` with `AgentStatus::NotFound` maps to a completed resume-agent item marked as failed and containing the receiver's derived `CollabAgentState`.

**Data flow**: The test creates a `CollabResumeEndEvent`, captures the receiver thread ID string for reuse, wraps the event in `EventMsg::CollabResumeEnd`, and sends it through `item_event_to_server_notification`. It constructs the expected `ItemCompletedNotification` with `CollabAgentTool::ResumeAgent`, `CollabAgentToolCallStatus::Failed`, a single receiver ID, and an `agents_states` map built from that receiver ID to `CollabAgentState::from(AgentStatus::NotFound)`, then compares actual and expected via the completed-notification assertion helper.

**Call relations**: This test exercises the failure-status derivation logic in the `CollabResumeEnd` match arm of `item_event_to_server_notification`. It relies on `tests::assert_item_completed_server_notification` for the final structural check and specifically confirms that `NotFound` is treated as failure rather than completion.

*Call graph*: calls 3 internal fn (item_event_to_server_notification, from, new); 3 external calls (assert_item_completed_server_notification, CollabResumeEnd, vec!).


##### `tests::exec_command_output_delta_maps_to_command_execution_output_delta`  (lines 590–610)

```
fn exec_command_output_delta_maps_to_command_execution_output_delta()
```

**Purpose**: Checks that an `ExecCommandOutputDeltaEvent` is converted into `ServerNotification::CommandExecutionOutputDelta` with the command call ID preserved as `item_id` and the byte chunk decoded into text.

**Data flow**: The test builds an `ExecCommandOutputDeltaEvent` with `Stdout` and a `b"hello"` chunk, wraps it in `EventMsg::ExecCommandOutputDelta`, and passes it to `item_event_to_server_notification` with fixed thread/turn IDs. It then constructs the expected `CommandExecutionOutputDeltaNotification` containing `item_id: "call-1"` and `delta: "hello"`, and validates the result through the dedicated assertion helper.

**Call relations**: This test targets the command-output branch of `item_event_to_server_notification`, specifically the conversion from raw output bytes to a string delta. After invoking the mapper, it delegates verification to `tests::assert_command_execution_output_delta_server_notification`.

*Call graph*: calls 1 internal fn (item_event_to_server_notification); 2 external calls (assert_command_execution_output_delta_server_notification, ExecCommandOutputDelta).


### `app-server-protocol/src/protocol/item_builders.rs`

`domain_logic` · `request handling`

This file is a projection layer between generic core protocol events and the app-server protocol’s UI-facing item model. Its main job is to turn patch, command-execution, and guardian-assessment events into concrete `ThreadItem` enum variants with the exact fields clients expect. For patch-related events, the three file-change builders all produce `ThreadItem::FileChange` values keyed by `call_id`, differing mainly in whether status is forced to `InProgress` or converted from the end-event status. They all rely on `convert_patch_changes`, which transforms a `HashMap<PathBuf, FileChange>` into a sorted `Vec<FileUpdateChange>` so output order is deterministic.

For command execution, the builders normalize argv vectors into a shell-escaped command string with `shlex_join`, preserve cwd/process/source metadata where available, derive `command_actions` from parsed command structures, and intentionally omit output/exit/duration until completion. The end builder additionally suppresses empty aggregated output by converting it to `None`, and saturates oversized durations to `i64::MAX` if millisecond conversion overflows.

The guardian helpers cover two distinct projections: `build_item_from_guardian_event` synthesizes command-like thread items only for guardian actions that correspond to executable commands, while `guardian_auto_approval_review_notification` emits started/completed review notifications with mapped status, decision source, rationale, and fallback turn/completion timestamps. Unsupported guardian actions deliberately produce no synthetic item, keeping this file focused on client-visible command/file-change representations rather than every core event type.

#### Function details

##### `build_file_change_approval_request_item`  (lines 40–48)

```
fn build_file_change_approval_request_item(
    payload: &ApplyPatchApprovalRequestEvent,
) -> ThreadItem
```

**Purpose**: Constructs a synthetic `ThreadItem::FileChange` for a patch approval request before any patch application has begun. It presents the requested file modifications as an in-progress item tied to the approval request’s `call_id`.

**Data flow**: Reads an `ApplyPatchApprovalRequestEvent` by borrowing `call_id` and `changes`. It clones the `call_id`, converts the `HashMap<PathBuf, FileChange>` through `convert_patch_changes` into sorted `FileUpdateChange` entries, and returns a new `ThreadItem::FileChange` with `PatchApplyStatus::InProgress`; it does not mutate external state.

**Call relations**: This builder is invoked from `handle_apply_patch_approval_request` when the server needs to surface an approval-stage patch item even though execution has not started. Its only delegated work is patch-change normalization via `convert_patch_changes`, so the caller gets the same file-change rendering used elsewhere.

*Call graph*: calls 1 internal fn (convert_patch_changes); called by 1 (handle_apply_patch_approval_request).


##### `build_file_change_begin_item`  (lines 50–56)

```
fn build_file_change_begin_item(payload: &PatchApplyBeginEvent) -> ThreadItem
```

**Purpose**: Builds the initial `ThreadItem::FileChange` representation for a real patch-apply start event. It mirrors the approval-request projection but uses the begin event payload as the source of truth.

**Data flow**: Consumes a borrowed `PatchApplyBeginEvent`, cloning `call_id` and converting `changes` with `convert_patch_changes`. It returns a `ThreadItem::FileChange` whose status is explicitly `PatchApplyStatus::InProgress`, with no side effects.

**Call relations**: Called by `handle_patch_apply_begin` when a patch application starts. It delegates the detailed per-file conversion to `convert_patch_changes` so begin-event items stay structurally aligned with approval and completion items.

*Call graph*: calls 1 internal fn (convert_patch_changes); called by 1 (handle_patch_apply_begin).


##### `build_file_change_end_item`  (lines 58–64)

```
fn build_file_change_end_item(payload: &PatchApplyEndEvent) -> ThreadItem
```

**Purpose**: Builds the terminal `ThreadItem::FileChange` for a completed patch application, preserving the final per-file change list and translating the core completion status into the app-server status enum.

**Data flow**: Reads a borrowed `PatchApplyEndEvent`, clones `call_id`, converts `changes` through `convert_patch_changes`, and converts `payload.status` into the app protocol’s `PatchApplyStatus` via `Into`. It returns the completed `ThreadItem::FileChange` and writes no external state.

**Call relations**: Used by `handle_patch_apply_end` when patch execution finishes. Like the other patch builders, it relies on `convert_patch_changes` for deterministic file rendering, but unlike them it derives status from the end-event payload.

*Call graph*: calls 1 internal fn (convert_patch_changes); called by 1 (handle_patch_apply_end).


##### `build_command_execution_approval_request_item`  (lines 66–86)

```
fn build_command_execution_approval_request_item(
    payload: &ExecApprovalRequestEvent,
) -> ThreadItem
```

**Purpose**: Creates a synthetic `ThreadItem::CommandExecution` for an execution approval request, representing a command that has been proposed but not yet started. It exposes both the shell-joined command string and any parsed command actions already available on the request.

**Data flow**: Reads an `ExecApprovalRequestEvent`, cloning `call_id`, `cwd`, and iterating over `parsed_cmd`. It converts the argv vector into a shell-safe string with `shlex_join`, maps each parsed command into `CommandAction::from_core_with_cwd(parsed, &payload.cwd)`, and returns a `ThreadItem::CommandExecution` with `process_id: None`, `source: Agent`, `status: InProgress`, and all runtime result fields (`aggregated_output`, `exit_code`, `duration_ms`) set to `None`.

**Call relations**: This function is used on approval-only paths where no actual process exists yet, so it does not appear in the live begin/end execution flow. Its main delegated work is command-string formatting via `shlex_join` while action derivation is performed inline.

*Call graph*: calls 1 internal fn (shlex_join).


##### `build_command_execution_begin_item`  (lines 88–106)

```
fn build_command_execution_begin_item(payload: &ExecCommandBeginEvent) -> ThreadItem
```

**Purpose**: Builds the live-start `ThreadItem::CommandExecution` for a command begin event, preserving process metadata and execution source while leaving result fields empty until completion.

**Data flow**: Reads an `ExecCommandBeginEvent`, cloning `call_id`, `cwd`, and `process_id`, converting `payload.source` into `CommandExecutionSource`, and shell-joining `payload.command` with `shlex_join`. It maps `parsed_cmd` entries into `CommandAction` values using the event cwd and returns a `ThreadItem::CommandExecution` with `status: InProgress` and no output/exit/duration yet.

**Call relations**: Called both by `handle_exec_command_begin` for direct event handling and by `item_event_to_server_notification` when generic item events are projected into notifications. It serves as the shared constructor for the start-of-execution representation and delegates only command-string formatting externally.

*Call graph*: calls 1 internal fn (shlex_join); called by 2 (item_event_to_server_notification, handle_exec_command_begin).


##### `build_command_execution_end_item`  (lines 108–133)

```
fn build_command_execution_end_item(payload: &ExecCommandEndEvent) -> ThreadItem
```

**Purpose**: Builds the completed `ThreadItem::CommandExecution` for a command end event, filling in final status, output, exit code, and elapsed time. It also normalizes empty output to absence rather than an empty string.

**Data flow**: Reads an `ExecCommandEndEvent`, clones identifiers and metadata, shell-joins the command argv with `shlex_join`, converts `payload.source` and `payload.status` into app-server enums, and maps `parsed_cmd` into `CommandAction` values. It transforms `payload.aggregated_output` into `None` when empty or `Some(clone)` otherwise, converts `payload.duration.as_millis()` to `i64` with `try_from`, falling back to `i64::MAX` on overflow, and returns a `ThreadItem::CommandExecution` with `exit_code` and `duration_ms` populated.

**Call relations**: Used by both `handle_exec_command_end` and `item_event_to_server_notification` to produce the terminal command item shown to clients. It is the completion counterpart to `build_command_execution_begin_item`, adding final-result normalization before the caller emits or stores the item.

*Call graph*: calls 1 internal fn (shlex_join); called by 2 (item_event_to_server_notification, handle_exec_command_end); 1 external calls (try_from).


##### `build_item_from_guardian_event`  (lines 139–204)

```
fn build_item_from_guardian_event(
    assessment: &GuardianAssessmentEvent,
    status: CommandExecutionStatus,
) -> Option<ThreadItem>
```

**Purpose**: Synthesizes a `ThreadItem::CommandExecution` from a guardian assessment when the assessed action corresponds to a command-like operation. It intentionally returns `None` for non-command guardian actions so only executable actions become thread items.

**Data flow**: Consumes a borrowed `GuardianAssessmentEvent` plus a target `CommandExecutionStatus`. It pattern-matches `assessment.action`: for `Command`, it requires `target_item_id`, clones the raw command string and cwd, and emits a single `CommandAction::Unknown`; for `Execve`, it requires `target_item_id`, reconstructs argv so the program is present even if `argv` is empty, shell-joins it, parses it with `parse_command`, and either maps parsed commands into `CommandAction::from_core_with_cwd` or falls back to `Unknown` if parsing yields nothing. For `ApplyPatch`, `NetworkAccess`, `McpToolCall`, and `RequestPermissions`, it returns `None`. No external state is modified.

**Call relations**: Called by `handle_guardian_assessment` when guardian events need to be surfaced as synthetic thread items. It bridges guardian-specific actions into the same command-execution presentation used elsewhere, delegating parsing and shell formatting only when handling `Execve` actions.

*Call graph*: calls 2 internal fn (parse_command, shlex_join); called by 1 (handle_guardian_assessment); 2 external calls (once, vec!).


##### `guardian_auto_approval_review_notification`  (lines 206–277)

```
fn guardian_auto_approval_review_notification(
    conversation_id: &ThreadId,
    event_turn_id: &str,
    assessment: &GuardianAssessmentEvent,
) -> ServerNotification
```

**Purpose**: Builds the app-server notification that reports a guardian approval review as either started or completed. It packages the review status, rationale, risk metadata, action, and timing into the correct notification variant based on the guardian assessment state.

**Data flow**: Reads a `ThreadId`, fallback `event_turn_id`, and `GuardianAssessmentEvent`. It chooses `turn_id` from `assessment.turn_id` unless that field is empty, maps the core guardian status into `GuardianApprovalReviewStatus`, converts optional `risk_level`, `user_authorization`, and `decision_source` into app-server enums, clones rationale and action, and then returns either `ServerNotification::ItemGuardianApprovalReviewStarted` for `InProgress` or `ServerNotification::ItemGuardianApprovalReviewCompleted` for terminal states. For completed notifications it uses `completed_at_ms.unwrap_or(started_at_ms)` as a fallback timestamp and defaults missing decision source to `AutoReviewDecisionSource::Agent`.

**Call relations**: This helper is part of the guardian event handling path, producing the notification object that callers can emit directly. Its internal branch on assessment status determines whether downstream consumers see a started or completed review event without requiring the caller to duplicate status-mapping logic.

*Call graph*: 3 external calls (ItemGuardianApprovalReviewCompleted, ItemGuardianApprovalReviewStarted, to_string).


##### `convert_patch_changes`  (lines 279–290)

```
fn convert_patch_changes(changes: &HashMap<PathBuf, FileChange>) -> Vec<FileUpdateChange>
```

**Purpose**: Transforms the core patch-change map into the app-server’s ordered list of `FileUpdateChange` records. It also computes the presentation-specific change kind and diff text for each file.

**Data flow**: Reads a `HashMap<PathBuf, FileChange>`, iterates over each `(path, change)` pair, converts the path to a lossy owned string, derives `kind` via `map_patch_change_kind`, derives `diff` via `format_file_change_diff`, collects the results into a `Vec<FileUpdateChange>`, sorts that vector lexicographically by `path`, and returns it. It does not mutate the input map.

**Call relations**: This is the shared conversion routine used by `build_file_change_approval_request_item`, `build_file_change_begin_item`, `build_file_change_end_item`, `item_event_to_server_notification`, and another `from` conversion path. Its role is to keep every patch-related projection consistent and deterministic regardless of where the item is built.

*Call graph*: called by 5 (item_event_to_server_notification, build_file_change_approval_request_item, build_file_change_begin_item, build_file_change_end_item, from).


##### `map_patch_change_kind`  (lines 292–300)

```
fn map_patch_change_kind(change: &FileChange) -> PatchChangeKind
```

**Purpose**: Maps a core `FileChange` variant into the app-server `PatchChangeKind` enum. For updates, it preserves any move destination path so rename/move information is not lost.

**Data flow**: Reads a borrowed `FileChange` and pattern-matches its variant. It returns `PatchChangeKind::Add` for `Add`, `PatchChangeKind::Delete` for `Delete`, and `PatchChangeKind::Update { move_path: ... }` for `Update`, cloning the optional `move_path` when present.

**Call relations**: This helper is used by `convert_patch_changes` during per-file projection. It isolates the enum translation so callers that need full `FileUpdateChange` records do not duplicate variant mapping logic.


##### `format_file_change_diff`  (lines 302–317)

```
fn format_file_change_diff(change: &FileChange) -> String
```

**Purpose**: Produces the displayable diff/body string for a single `FileChange`. It returns raw content for adds/deletes and appends move information to update diffs when a file was relocated.

**Data flow**: Reads a borrowed `FileChange` and matches on its variant. For `Add` and `Delete`, it clones and returns the stored `content`; for `Update`, it returns `unified_diff.clone()` when `move_path` is absent, or formats `"{unified_diff}\n\nMoved to: {path}"` when a destination path exists.

**Call relations**: This helper is called by `convert_patch_changes` as part of building each `FileUpdateChange`. It encapsulates the presentation rule that move targets are appended to update diffs rather than represented only structurally.

*Call graph*: 1 external calls (format!).


### `app-server/src/request_processors/token_usage_replay.rs`

`domain_logic` · `connection attach / historical token-usage replay`

This module handles one narrow lifecycle concern: when a client attaches to an existing thread, the server may need to replay the latest persisted token usage without re-emitting model events globally. `send_thread_token_usage_update_to_connection` is the outward-facing async helper. It asks the `CodexThread` for `token_usage_info`; if none exists, it returns silently. Otherwise it builds a `ThreadTokenUsageUpdatedNotification` targeted at a single `ConnectionId`, choosing the turn id from the caller-supplied attribution or from a fallback heuristic over the loaded `Thread`.

The attribution logic lives in `latest_token_usage_turn_id_from_rollout_items`. It rebuilds history incrementally with `ThreadHistoryBuilder`, watching for `RolloutItem::EventMsg(EventMsg::TokenCount(_))`. Whenever it sees one, it snapshots the currently active turn id and its position. After processing all items, it prefers the captured turn id if that id still exists in the rebuilt `turns`; if not, it falls back to the saved active-turn position, which handles histories where implicit turn ids were regenerated during reconstruction. `latest_token_usage_turn_id` is the final fallback when rollout attribution is unavailable: it picks the most recent completed or failed turn, otherwise the last turn, otherwise an empty string. The tests cover both exact-id attribution and position-based fallback after mutating a rebuilt turn id.

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

**Purpose**: Sends a connection-scoped `ThreadTokenUsageUpdated` notification using persisted token usage from an existing conversation. It avoids broadcasting historical usage to other subscribers.

**Data flow**: Accepts the shared `OutgoingMessageSender`, target `ConnectionId`, `ThreadId`, loaded API `Thread`, core `CodexThread`, and optional attributed turn id. It awaits `conversation.token_usage_info()`, returns early if absent, otherwise builds `ThreadTokenUsageUpdatedNotification` with `thread_id.to_string()`, a chosen turn id, and `ThreadTokenUsage::from(info)`, then sends it only to the specified connection.

**Call relations**: Called by higher-level attach/replay orchestration after request ordering has been handled. It delegates turn-id fallback to `latest_token_usage_turn_id` when the caller did not already derive one from rollout items.

*Call graph*: calls 2 internal fn (from, token_usage_info); 2 external calls (ThreadTokenUsageUpdated, to_string).


##### `latest_token_usage_turn_id_from_rollout_items`  (lines 69–98)

```
fn latest_token_usage_turn_id_from_rollout_items(
    rollout_items: &[RolloutItem],
    turns: &[Turn],
) -> Option<String>
```

**Purpose**: Finds which rebuilt turn should own the latest persisted `TokenCount` event by tracking the active turn during rollout replay. It prefers stable ids but can fall back to turn position when ids changed during reconstruction.

**Data flow**: Takes rollout items and rebuilt turns, initializes `ThreadHistoryBuilder`, iterates through rollout items, snapshots the active turn id and active-turn position whenever it encounters `RolloutItem::EventMsg(EventMsg::TokenCount(_))`, feeds every item into `builder.handle_rollout_item`, then returns the captured id if it still exists in `turns`, else the id at the captured position, else `None`.

**Call relations**: Used by attach/replay logic before calling `send_thread_token_usage_update_to_connection`. The tests in this module exercise both the id-match and position-fallback branches.

*Call graph*: calls 1 internal fn (new); 2 external calls (iter, matches!).


##### `latest_token_usage_turn_id`  (lines 105–114)

```
fn latest_token_usage_turn_id(thread: &Thread) -> String
```

**Purpose**: Chooses a best-effort fallback turn id for replayed token usage when rollout-based attribution is unavailable. It favors terminal turns over in-progress ones.

**Data flow**: Scans `thread.turns` in reverse, returns the id of the first turn whose status is `Completed` or `Failed`, otherwise the last turn's id, otherwise an empty string.

**Call relations**: Called only by `send_thread_token_usage_update_to_connection` as the final fallback to preserve a stable notification shape.


##### `tests::replay_attribution_uses_already_loaded_history`  (lines 126–134)

```
fn replay_attribution_uses_already_loaded_history()
```

**Purpose**: Verifies token-usage attribution uses the original rebuilt turn id when that id still exists in the loaded thread history. This is the preferred replay path.

**Data flow**: Builds rollout items with `token_usage_history`, rebuilds turns via `build_turns_from_rollout_items`, calls `latest_token_usage_turn_id_from_rollout_items`, and asserts it returns `Some(turns[0].id.clone())`.

**Call relations**: Test-harness coverage for the exact-id attribution branch.

*Call graph*: 3 external calls (token_usage_history, assert_eq!, build_turns_from_rollout_items).


##### `tests::replay_attribution_falls_back_to_rebuilt_turn_position`  (lines 137–146)

```
fn replay_attribution_falls_back_to_rebuilt_turn_position()
```

**Purpose**: Checks that attribution falls back to turn position when rebuilt history regenerated the original turn id. The latest token usage should still map to the corresponding rebuilt turn.

**Data flow**: Builds rollout items and turns, mutates `turns[0].id` to `rebuilt-turn-id`, calls `latest_token_usage_turn_id_from_rollout_items`, and asserts it returns that rebuilt id.

**Call relations**: Covers the position-based fallback branch in token-usage attribution.

*Call graph*: 3 external calls (token_usage_history, assert_eq!, build_turns_from_rollout_items).


##### `tests::token_usage_history`  (lines 148–176)

```
fn token_usage_history() -> Vec<RolloutItem>
```

**Purpose**: Creates a minimal rollout history containing two user turns with an agent reply and a `TokenCount` event after the first answer. This fixture is designed to make token-usage ownership unambiguous.

**Data flow**: Returns a `Vec<RolloutItem>` containing `UserMessage`, `AgentMessage`, `TokenCount`, and another `UserMessage` event in that order.

**Call relations**: Shared fixture helper for the replay attribution tests.

*Call graph*: 1 external calls (vec!).


### `app-server-protocol/src/protocol/thread_history.rs`

`domain_logic` · `request handling and rollout replay`

This file centers on `ThreadHistoryBuilder`, a stateful reducer that consumes `RolloutItem` and `EventMsg` values and emits a sequence of `crate::protocol::v2::Turn` records. Internally it keeps finished turns in `turns`, one mutable `PendingTurn` in `current_turn`, a monotonically increasing synthetic item id counter (`item-<n>`), rollout indexes used to derive stable fallback turn ids like `rollout-5`, and an optional `active_change_set` used to capture per-event deltas.

The builder understands a wide range of persisted protocol events and maps them into concrete `ThreadItem` variants: user and agent messages, reasoning summaries/raw content, web search, command execution, guardian review outcomes, patch/file changes, dynamic tool calls, MCP tool calls, image viewing/generation, collaboration-agent tool calls, review mode markers, hook prompts parsed from rollout response items, and context compaction markers. Some events append new items, while others upsert by item id so begin/end pairs or late completions replace earlier placeholders instead of duplicating them.

Turn boundaries are subtle. Explicit `TurnStarted`/`TurnComplete` events preserve canonical turn ids and metadata; otherwise implicit turns are created on demand. A new user message closes a prior implicit turn unless that turn is only a compaction placeholder. Empty implicit turns are dropped, but explicit or compaction-only turns are preserved. Errors only mark the active turn failed when `affects_turn_status()` says they should. Rollback truncates finished history, records removed turn ids for change tracking, and recomputes the next synthetic item id from remaining items. `ThreadHistoryChangeAccumulator` coalesces repeated item/turn updates across batches while removing stale changes for rolled-back turns.

#### Function details

##### `build_turns_from_rollout_items`  (lines 78–84)

```
fn build_turns_from_rollout_items(items: &[RolloutItem]) -> Vec<Turn>
```

**Purpose**: Replays a persisted rollout stream into a fully materialized vector of `Turn` values. It is the convenience entry for rebuilding thread history from storage.

**Data flow**: Takes a slice of `RolloutItem`; creates a fresh `ThreadHistoryBuilder`; feeds each item through rollout handling in order; finalizes any open turn; returns the builder's `Vec<Turn>`.

**Call relations**: Used by many tests as the top-level replay path. It delegates all actual reduction logic to `ThreadHistoryBuilder`, so persisted event ordering and turn/item reconstruction are governed by the builder methods.

*Call graph*: calls 1 internal fn (new); called by 29 (assigns_late_exec_completion_to_original_turn, drops_last_turns_on_thread_rollback, error_then_turn_complete_preserves_failed_status, ignores_plain_user_response_items_in_rollout_replay, ignores_user_message_item_lifecycle_events, late_turn_aborted_does_not_interrupt_active_turn, late_turn_complete_does_not_close_active_turn, marks_turn_as_interrupted_when_aborted, out_of_turn_error_does_not_create_or_fail_a_turn, preserves_agent_message_phase_in_history (+15 more)).


##### `ThreadHistoryChangeSet::is_empty`  (lines 114–118)

```
fn is_empty(&self) -> bool
```

**Purpose**: Checks whether a change set contains no item snapshots, no turn metadata snapshots, and no removed turn ids.

**Data flow**: Reads the three vectors on `self` and returns `true` only when all are empty.

**Call relations**: This is a leaf helper for callers that consume incremental updates and want to skip no-op batches.


##### `ThreadHistoryTurnChange::from_pending_turn`  (lines 122–131)

```
fn from_pending_turn(turn: &PendingTurn) -> Self
```

**Purpose**: Builds a lightweight turn metadata snapshot from an in-progress `PendingTurn`.

**Data flow**: Reads `id`, `status`, `error`, `started_at`, `completed_at`, and `duration_ms` from a `PendingTurn`; clones owned fields; returns a `ThreadHistoryTurnChange`.

**Call relations**: Used when the builder is tracking changes for the active mutable turn, especially when a turn is created or its metadata changes before being finalized.

*Call graph*: called by 1 (record_changed_pending_turn).


##### `ThreadHistoryTurnChange::from_turn`  (lines 133–142)

```
fn from_turn(turn: &Turn) -> Self
```

**Purpose**: Builds the same metadata snapshot from an already finalized `Turn`.

**Data flow**: Reads the finalized turn's id and status/error/timing fields; clones them into a new `ThreadHistoryTurnChange`.

**Call relations**: Used when late abort/complete events target a turn that is already in the finished `turns` list rather than the active pending turn.

*Call graph*: called by 2 (handle_turn_aborted, handle_turn_complete).


##### `ThreadHistoryChangeAccumulator::push`  (lines 159–169)

```
fn push(&mut self, changes: ThreadHistoryChangeSet)
```

**Purpose**: Merges one per-item/per-event `ThreadHistoryChangeSet` into an accumulator that preserves first-seen ordering but keeps only the latest snapshot for each item or turn.

**Data flow**: Consumes a `ThreadHistoryChangeSet`; first records removed turn ids, then item changes, then turn changes; updates internal vectors and index maps for deduplication.

**Call relations**: Called by batch handling to combine multiple single-item change sets. It delegates deduplication and rollback cleanup to the specialized `push_*` helpers.

*Call graph*: calls 3 internal fn (push_item_change, push_removed_turn_id, push_turn_change).


##### `ThreadHistoryChangeAccumulator::finish`  (lines 171–177)

```
fn finish(self) -> ThreadHistoryChangeSet
```

**Purpose**: Converts the accumulator's sparse internal storage into a final compact `ThreadHistoryChangeSet`.

**Data flow**: Consumes `self`; flattens `Vec<Option<...>>` collections for items and turns; returns a `ThreadHistoryChangeSet` with surviving snapshots and recorded removals.

**Call relations**: Used at the end of batch processing after repeated updates and rollback pruning have been applied.


##### `ThreadHistoryChangeAccumulator::push_item_change`  (lines 179–189)

```
fn push_item_change(&mut self, change: ThreadHistoryItemChange)
```

**Purpose**: Deduplicates item snapshots by `(turn_id, item_id)` while preserving the position of the first change for that item.

**Data flow**: Builds a key from `change.turn_id` and `change.item.id()`; if the key already exists, replaces the stored `Option` at that index; otherwise appends a new slot and records its index.

**Call relations**: Invoked from accumulator merging for every changed item. It ensures begin/end or streaming updates collapse to one final item snapshot per batch.

*Call graph*: called by 1 (push).


##### `ThreadHistoryChangeAccumulator::push_turn_change`  (lines 191–200)

```
fn push_turn_change(&mut self, change: ThreadHistoryTurnChange)
```

**Purpose**: Deduplicates turn metadata snapshots by turn id while preserving first-change order.

**Data flow**: Looks up `change.turn_id` in the turn index map; replaces an existing slot if present or appends a new one if not; updates the index map accordingly.

**Call relations**: Used during batch accumulation so repeated status/timing updates for the same turn emit only the latest metadata snapshot.

*Call graph*: called by 1 (push).


##### `ThreadHistoryChangeAccumulator::push_removed_turn_id`  (lines 202–224)

```
fn push_removed_turn_id(&mut self, turn_id: String)
```

**Purpose**: Records a rolled-back turn id and removes any previously accumulated item or turn snapshots for that turn.

**Data flow**: Adds the turn id to `removed_turn_ids` once; clears any matching entry in `changed_turns`; scans item keys for the same turn id and nulls those item slots too.

**Call relations**: Applied before later item/turn merges so rollback wins over earlier changes in the same batch.

*Call graph*: called by 1 (push).


##### `ThreadHistoryBuilder::default`  (lines 237–239)

```
fn default() -> Self
```

**Purpose**: Provides the default builder state by delegating to `new`.

**Data flow**: Creates and returns a fresh `ThreadHistoryBuilder` with empty history and counters reset.

**Call relations**: Supports standard Rust default construction and is also used indirectly by change-collection helpers.

*Call graph*: 1 external calls (new).


##### `ThreadHistoryBuilder::new`  (lines 243–252)

```
fn new() -> Self
```

**Purpose**: Initializes an empty thread-history reducer.

**Data flow**: Constructs a builder with no finished turns, no active turn, `next_item_index` set to 1, rollout indexes at 0, and no active change set.

**Call relations**: This is the root constructor used by replay helpers, tests, and reset/default paths.

*Call graph*: called by 15 (build_turns_from_rollout_items, apply_patch_approval_request_updates_active_turn_snapshot_with_file_change, builds_multiple_turns_with_reasoning_items, changed_rollout_item_reports_new_item_snapshot, changed_rollout_item_reports_streaming_item_mutation, changed_rollout_item_reports_turn_completion_metadata, changed_rollout_item_reports_updated_existing_item_snapshot, changed_rollout_items_dedupe_turn_metadata_snapshots, changed_rollout_items_dedupe_updated_item_snapshots, changed_rollout_items_drop_prior_changes_for_removed_turns (+5 more)); 1 external calls (new).


##### `ThreadHistoryBuilder::reset`  (lines 254–256)

```
fn reset(&mut self)
```

**Purpose**: Clears all accumulated history and returns the builder to its initial state.

**Data flow**: Overwrites `self` with a newly constructed builder.

**Call relations**: Used by external tracking code that wants to reuse the same builder instance across sessions or streams.

*Call graph*: called by 2 (clear_listener, track_current_turn_event); 1 external calls (new).


##### `ThreadHistoryBuilder::finish`  (lines 258–261)

```
fn finish(mut self) -> Vec<Turn>
```

**Purpose**: Finalizes any open turn and returns the completed turn list.

**Data flow**: Consumes the builder, calls `finish_current_turn` to flush `current_turn` if needed, then returns `turns`.

**Call relations**: Terminal step after replay or live accumulation; relies on `finish_current_turn` to enforce empty-turn dropping rules.

*Call graph*: calls 1 internal fn (finish_current_turn).


##### `ThreadHistoryBuilder::active_turn_snapshot`  (lines 263–268)

```
fn active_turn_snapshot(&self) -> Option<Turn>
```

**Purpose**: Returns the current active turn as a materialized `Turn`, or the last finished turn if no turn is open.

**Data flow**: Reads `current_turn`; if present clones it into `Turn`; otherwise clones the last element of `turns`; returns `Option<Turn>`.

**Call relations**: Used by callers that need a current view during streaming without finalizing the builder.

*Call graph*: called by 1 (active_turn_snapshot).


##### `ThreadHistoryBuilder::turn_snapshot`  (lines 270–276)

```
fn turn_snapshot(&self, turn_id: &str) -> Option<Turn>
```

**Purpose**: Looks up a specific turn id in either the active pending turn or the finished history.

**Data flow**: Compares the requested `turn_id` against `current_turn.id`, otherwise searches `turns`; returns a cloned `Turn` if found.

**Call relations**: Provides random access to a known turn id for projectors or UI code.


##### `ThreadHistoryBuilder::active_turn_position`  (lines 282–290)

```
fn active_turn_position(&self) -> Option<usize>
```

**Purpose**: Reports where the active turn would appear in the finalized turn list.

**Data flow**: If `current_turn` exists, returns `Some(turns.len())`; if no turns exist returns `None`; otherwise returns the index of the last finished turn.

**Call relations**: Useful for consumers that maintain parallel arrays or cursor positions while the active turn is still mutable.


##### `ThreadHistoryBuilder::has_active_turn`  (lines 292–294)

```
fn has_active_turn(&self) -> bool
```

**Purpose**: Indicates whether a pending turn is currently open.

**Data flow**: Returns whether `current_turn` is `Some`.

**Call relations**: Used by external current-turn tracking logic to decide whether incoming events belong to an active turn.

*Call graph*: called by 1 (track_current_turn_event).


##### `ThreadHistoryBuilder::active_turn_id_if_explicit`  (lines 296–301)

```
fn active_turn_id_if_explicit(&self) -> Option<String>
```

**Purpose**: Returns the active turn id only when the current turn was opened by explicit turn-boundary events.

**Data flow**: Reads `current_turn`; filters on `opened_explicitly`; clones and returns the id if the condition holds.

**Call relations**: Lets callers distinguish canonical explicit turn ids from synthetic implicit ones.


##### `ThreadHistoryBuilder::active_turn_start_index`  (lines 303–307)

```
fn active_turn_start_index(&self) -> Option<usize>
```

**Purpose**: Exposes the rollout index where the active turn began during replay.

**Data flow**: Reads `current_turn.rollout_start_index` and returns it as `Option<usize>`.

**Call relations**: Supports resume/rejoin logic that needs to correlate the active turn with rollout positions.


##### `ThreadHistoryBuilder::handle_event`  (lines 314–378)

```
fn handle_event(&mut self, event: &EventMsg)
```

**Purpose**: Dispatches one persisted/live protocol event to the specific reducer for that event type.

**Data flow**: Matches on `EventMsg`; forwards payloads to specialized handlers for messages, tools, turn lifecycle, rollback, errors, review mode, collaboration, compaction, and item lifecycle; ignores unsupported or intentionally irrelevant variants.

**Call relations**: This is the main event reducer called from rollout replay and live tracking. It fans out to all event-specific handlers and defines which persisted event variants affect thread history.

*Call graph*: calls 40 internal fn (handle_agent_message, handle_agent_reasoning, handle_agent_reasoning_raw_content, handle_apply_patch_approval_request, handle_collab_agent_interaction_begin, handle_collab_agent_interaction_end, handle_collab_agent_spawn_begin, handle_collab_agent_spawn_end, handle_collab_close_begin, handle_collab_close_end (+15 more)); called by 2 (handle_rollout_item, track_current_turn_event).


##### `ThreadHistoryBuilder::handle_rollout_item`  (lines 380–391)

```
fn handle_rollout_item(&mut self, item: &RolloutItem)
```

**Purpose**: Processes one persisted rollout record, including non-event records such as compaction markers and response items.

**Data flow**: Updates `current_rollout_index`/`next_rollout_index`; matches the `RolloutItem`; routes `EventMsg` to `handle_event`, `Compacted` to `handle_compacted`, `ResponseItem` to `handle_response_item`, and ignores metadata-only rollout variants.

**Call relations**: Used by replay paths. It wraps event handling with rollout-index bookkeeping so synthetic turn ids remain stable.

*Call graph*: calls 3 internal fn (handle_compacted, handle_event, handle_response_item).


##### `ThreadHistoryBuilder::handle_event_with_changes`  (lines 395–397)

```
fn handle_event_with_changes(&mut self, event: &EventMsg) -> ThreadHistoryChangeSet
```

**Purpose**: Processes one event while capturing only the item and turn snapshots changed by that event.

**Data flow**: Starts temporary change tracking via `collect_changes`, runs `handle_event`, and returns the resulting `ThreadHistoryChangeSet`.

**Call relations**: Used by incremental consumers that want event-local deltas instead of rebuilding the whole history.

*Call graph*: calls 1 internal fn (collect_changes).


##### `ThreadHistoryBuilder::handle_rollout_item_with_changes`  (lines 401–406)

```
fn handle_rollout_item_with_changes(
        &mut self,
        item: &RolloutItem,
    ) -> ThreadHistoryChangeSet
```

**Purpose**: Processes one rollout item and returns the snapshots changed by that append.

**Data flow**: Wraps `handle_rollout_item` inside `collect_changes` and returns the captured `ThreadHistoryChangeSet`.

**Call relations**: Feeds the batch coalescing path and supports append-driven projectors.

*Call graph*: calls 1 internal fn (collect_changes); called by 1 (handle_rollout_items_with_changes).


##### `ThreadHistoryBuilder::handle_rollout_items_with_changes`  (lines 411–420)

```
fn handle_rollout_items_with_changes(
        &mut self,
        items: &[RolloutItem],
    ) -> ThreadHistoryChangeSet
```

**Purpose**: Processes a batch of rollout items and returns a deduplicated end-of-batch change set.

**Data flow**: Creates a `ThreadHistoryChangeAccumulator`; for each item, obtains a per-item change set from `handle_rollout_item_with_changes`; merges them; returns the accumulator's final compacted result.

**Call relations**: This is the batch incremental API. It relies on the accumulator to collapse repeated updates and remove stale changes after rollback.

*Call graph*: calls 1 internal fn (handle_rollout_item_with_changes); 1 external calls (default).


##### `ThreadHistoryBuilder::collect_changes`  (lines 422–427)

```
fn collect_changes(&mut self, handle: impl FnOnce(&mut Self)) -> ThreadHistoryChangeSet
```

**Purpose**: Temporarily enables change tracking around an arbitrary builder mutation.

**Data flow**: Asserts no nested tracking is active; installs an empty `ThreadHistoryChangeSet` in `active_change_set`; executes the provided closure; removes and returns the collected changes, defaulting if absent.

**Call relations**: Internal scaffolding used by the event and rollout-item incremental APIs.

*Call graph*: called by 2 (handle_event_with_changes, handle_rollout_item_with_changes); 2 external calls (default, debug_assert!).


##### `ThreadHistoryBuilder::handle_response_item`  (lines 429–453)

```
fn handle_response_item(&mut self, item: &codex_protocol::models::ResponseItem)
```

**Purpose**: Extracts persisted hook-prompt messages from rollout response items and turns them into `ThreadItem::HookPrompt` entries.

**Data flow**: Pattern-matches only `ResponseItem::Message`; requires `role == "user"`; parses hook prompt fragments with `parse_hook_prompt_message`; converts fragments into v2 hook prompt fragments; pushes a `HookPrompt` item into the current turn.

**Call relations**: Called only during rollout replay for `RolloutItem::ResponseItem`. Plain user response messages that are not encoded hook prompts are ignored.

*Call graph*: calls 2 internal fn (push_item_in_current_turn, parse_hook_prompt_message); called by 1 (handle_rollout_item).


##### `ThreadHistoryBuilder::handle_user_message`  (lines 455–472)

```
fn handle_user_message(&mut self, payload: &UserMessageEvent)
```

**Purpose**: Adds a user message item to the current turn, creating or rotating implicit turns as needed.

**Data flow**: If an implicit current turn exists and is not just an empty compaction placeholder, finalizes it; allocates a synthetic item id; builds `Vec<UserInput>` from text, remote images, and local images; pushes `ThreadItem::UserMessage` with `client_id` and content.

**Call relations**: Invoked for `EventMsg::UserMessage`. It is the main trigger that splits implicit turns for backward-compatible streams lacking explicit turn boundaries.

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

**Purpose**: Appends a non-empty agent-visible message to the current turn.

**Data flow**: Rejects empty text; allocates a synthetic item id; constructs `ThreadItem::AgentMessage` with text, optional `MessagePhase`, and optional memory citation; pushes it into the current turn.

**Call relations**: Called from event dispatch for agent message events.

*Call graph*: calls 2 internal fn (next_item_id, push_item_in_current_turn); called by 1 (handle_event).


##### `ThreadHistoryBuilder::handle_agent_reasoning`  (lines 493–531)

```
fn handle_agent_reasoning(&mut self, payload: &AgentReasoningEvent)
```

**Purpose**: Accumulates summarized reasoning text, either by extending the last reasoning item or creating a new one.

**Data flow**: Ignores empty text; ensures a current turn exists; if the last item is `ThreadItem::Reasoning`, appends the text to its `summary` vector and records the mutated item when change tracking is active; otherwise allocates a new item id and pushes a fresh reasoning item with populated `summary` and empty `content`.

**Call relations**: Used for streamed reasoning-summary events. It cooperates with change tracking so in-place mutations still emit updated item snapshots.

*Call graph*: calls 5 internal fn (ensure_turn, is_tracking_changes, next_item_id, push_item_in_current_turn, record_changed_item); called by 1 (handle_event); 2 external calls (new, vec!).


##### `ThreadHistoryBuilder::handle_agent_reasoning_raw_content`  (lines 533–571)

```
fn handle_agent_reasoning_raw_content(&mut self, payload: &AgentReasoningRawContentEvent)
```

**Purpose**: Accumulates raw reasoning content, extending the last reasoning item when possible.

**Data flow**: Ignores empty text; ensures a current turn exists; if the last item is a reasoning item, appends to its `content` vector and records the updated snapshot when tracking changes; otherwise creates a new reasoning item with empty `summary` and one `content` entry.

**Call relations**: Parallel to `handle_agent_reasoning`, but for raw-content events rather than summary text.

*Call graph*: calls 5 internal fn (ensure_turn, is_tracking_changes, next_item_id, push_item_in_current_turn, record_changed_item); called by 1 (handle_event); 2 external calls (new, vec!).


##### `ThreadHistoryBuilder::handle_item_started`  (lines 573–601)

```
fn handle_item_started(&mut self, payload: &ItemStartedEvent)
```

**Purpose**: Reconstructs only selected persisted item lifecycle starts into thread history, currently plan and sleep items.

**Data flow**: Matches `payload.item`; for `Plan`, ignores empty text and upserts the converted item into the specified turn id; for `Sleep`, upserts directly; ignores lifecycle events for all other item kinds because they are reconstructed from dedicated events.

**Call relations**: Called from event dispatch for persisted `ItemStarted` events, mainly to preserve item types that otherwise have no dedicated begin/end reducer.

*Call graph*: calls 2 internal fn (upsert_item_in_turn_id, from); called by 1 (handle_event).


##### `ThreadHistoryBuilder::handle_item_completed`  (lines 603–631)

```
fn handle_item_completed(&mut self, payload: &ItemCompletedEvent)
```

**Purpose**: Reconstructs selected persisted item lifecycle completions into thread history, mirroring the start handler.

**Data flow**: Matches `payload.item`; for non-empty `Plan` and for `Sleep`, converts the core item into a v2 `ThreadItem` and upserts it into the target turn; ignores other item kinds.

**Call relations**: Used for persisted `ItemCompleted` events so replay can recover plan/sleep items even if only completion was stored.

*Call graph*: calls 2 internal fn (upsert_item_in_turn_id, from); called by 1 (handle_event).


##### `ThreadHistoryBuilder::handle_web_search_begin`  (lines 633–640)

```
fn handle_web_search_begin(&mut self, payload: &WebSearchBeginEvent)
```

**Purpose**: Creates or updates a placeholder web-search item when a search starts.

**Data flow**: Builds `ThreadItem::WebSearch` with the call id, empty query, and no action; upserts it into the current turn.

**Call relations**: Called on web-search begin events so later completion can replace the placeholder by item id.

*Call graph*: calls 1 internal fn (upsert_item_in_current_turn); called by 1 (handle_event); 1 external calls (new).


##### `ThreadHistoryBuilder::handle_web_search_end`  (lines 642–649)

```
fn handle_web_search_end(&mut self, payload: &WebSearchEndEvent)
```

**Purpose**: Stores the completed web-search query and action.

**Data flow**: Builds `ThreadItem::WebSearch` from the call id, final query string, and converted `WebSearchAction`; upserts it into the current turn.

**Call relations**: Completes or replaces the placeholder created by the begin handler.

*Call graph*: calls 2 internal fn (upsert_item_in_current_turn, from); called by 1 (handle_event).


##### `ThreadHistoryBuilder::handle_exec_command_begin`  (lines 651–654)

```
fn handle_exec_command_begin(&mut self, payload: &ExecCommandBeginEvent)
```

**Purpose**: Materializes a command-execution item from a command-start event and associates it with the event's turn id.

**Data flow**: Uses `build_command_execution_begin_item` to convert the payload into `ThreadItem::CommandExecution`; upserts it into the specified turn.

**Call relations**: Called for command begin events. Turn-id routing is explicit rather than based on the active turn.

*Call graph*: calls 2 internal fn (build_command_execution_begin_item, upsert_item_in_turn_id); called by 1 (handle_event).


##### `ThreadHistoryBuilder::handle_exec_command_end`  (lines 656–664)

```
fn handle_exec_command_end(&mut self, payload: &ExecCommandEndEvent)
```

**Purpose**: Materializes a completed command-execution item and routes it to the original turn, even if it arrives late.

**Data flow**: Converts the payload with `build_command_execution_end_item`; upserts the resulting item into `payload.turn_id`.

**Call relations**: Used for command completion events. The explicit turn-id lookup is important because command exits may be observed after a newer turn has already started.

*Call graph*: calls 2 internal fn (build_command_execution_end_item, upsert_item_in_turn_id); called by 1 (handle_event).


##### `ThreadHistoryBuilder::handle_guardian_assessment`  (lines 666–683)

```
fn handle_guardian_assessment(&mut self, payload: &GuardianAssessmentEvent)
```

**Purpose**: Turns guardian review events into command/file-change items when the guardian state is visible in history.

**Data flow**: Maps guardian statuses to `CommandExecutionStatus` (`InProgress`, `Declined`, `Failed`), skipping `Approved`; asks `build_item_from_guardian_event` to synthesize the corresponding `ThreadItem`; if a turn id is present, upserts into that turn, otherwise into the current turn.

**Call relations**: Called for guardian assessment events. It intentionally omits approved events because approval itself does not become a visible history item.

*Call graph*: calls 3 internal fn (build_item_from_guardian_event, upsert_item_in_current_turn, upsert_item_in_turn_id); called by 1 (handle_event).


##### `ThreadHistoryBuilder::handle_apply_patch_approval_request`  (lines 685–692)

```
fn handle_apply_patch_approval_request(&mut self, payload: &ApplyPatchApprovalRequestEvent)
```

**Purpose**: Creates a file-change item representing a patch approval request.

**Data flow**: Builds a `ThreadItem::FileChange` via `build_file_change_approval_request_item`; routes it to `payload.turn_id` when present, otherwise to the current turn.

**Call relations**: Used for approval-request events so the active turn snapshot reflects pending file changes before patch application completes.

*Call graph*: calls 3 internal fn (build_file_change_approval_request_item, upsert_item_in_current_turn, upsert_item_in_turn_id); called by 1 (handle_event).


##### `ThreadHistoryBuilder::handle_patch_apply_begin`  (lines 694–701)

```
fn handle_patch_apply_begin(&mut self, payload: &PatchApplyBeginEvent)
```

**Purpose**: Creates or updates an in-progress file-change item when patch application starts.

**Data flow**: Converts the payload with `build_file_change_begin_item`; upserts into the specified turn id or current turn if the id is empty.

**Call relations**: Pairs with patch-end handling to maintain one file-change item per patch call.

*Call graph*: calls 3 internal fn (build_file_change_begin_item, upsert_item_in_current_turn, upsert_item_in_turn_id); called by 1 (handle_event).


##### `ThreadHistoryBuilder::handle_patch_apply_end`  (lines 703–710)

```
fn handle_patch_apply_end(&mut self, payload: &PatchApplyEndEvent)
```

**Purpose**: Stores the final file-change result for a patch application.

**Data flow**: Builds the completed file-change item with `build_file_change_end_item`; routes by explicit turn id when available, otherwise by current turn.

**Call relations**: Completes or replaces the patch item created by approval/begin events.

*Call graph*: calls 3 internal fn (build_file_change_end_item, upsert_item_in_current_turn, upsert_item_in_turn_id); called by 1 (handle_event).


##### `ThreadHistoryBuilder::handle_dynamic_tool_call_request`  (lines 712–731)

```
fn handle_dynamic_tool_call_request(
        &mut self,
        payload: &codex_protocol::dynamic_tools::DynamicToolCallRequest,
    )
```

**Purpose**: Creates an in-progress dynamic-tool-call item from a request event.

**Data flow**: Builds `ThreadItem::DynamicToolCall` with call id, namespace, tool, arguments, `DynamicToolCallStatus::InProgress`, and empty result fields; upserts into the specified turn or current turn.

**Call relations**: Called when a dynamic tool request is emitted so later response data can overwrite the same item.

*Call graph*: calls 2 internal fn (upsert_item_in_current_turn, upsert_item_in_turn_id); called by 1 (handle_event).


##### `ThreadHistoryBuilder::handle_dynamic_tool_call_response`  (lines 733–755)

```
fn handle_dynamic_tool_call_response(&mut self, payload: &DynamicToolCallResponseEvent)
```

**Purpose**: Stores the final status and output content for a dynamic tool call.

**Data flow**: Derives completed/failed status from `payload.success`; converts duration to `Option<i64>` milliseconds; maps output content items into v2 equivalents; builds a populated `ThreadItem::DynamicToolCall`; upserts into the specified turn or current turn.

**Call relations**: Completes the item created by the request handler and uses item-id upsert semantics to avoid duplicates.

*Call graph*: calls 3 internal fn (upsert_item_in_current_turn, upsert_item_in_turn_id, convert_dynamic_tool_content_items); called by 1 (handle_event); 1 external calls (try_from).


##### `ThreadHistoryBuilder::handle_mcp_tool_call_begin`  (lines 757–775)

```
fn handle_mcp_tool_call_begin(&mut self, payload: &McpToolCallBeginEvent)
```

**Purpose**: Creates an in-progress MCP tool-call item in the current turn.

**Data flow**: Builds `ThreadItem::McpToolCall` from invocation server/tool/arguments, optional app resource URI and plugin id, with `McpToolCallStatus::InProgress` and no result/error/duration; upserts into the current turn.

**Call relations**: Called for MCP begin events. Unlike some other tool events, it does not route by explicit turn id.

*Call graph*: calls 1 internal fn (upsert_item_in_current_turn); called by 1 (handle_event).


##### `ThreadHistoryBuilder::handle_mcp_tool_call_end`  (lines 777–817)

```
fn handle_mcp_tool_call_end(&mut self, payload: &McpToolCallEndEvent)
```

**Purpose**: Stores the final MCP tool-call result or error payload.

**Data flow**: Computes completed/failed status from `payload.is_success()`; converts duration to milliseconds; transforms `payload.result` into either boxed `McpToolCallResult` or `McpToolCallError`; builds a final `ThreadItem::McpToolCall`; upserts into the current turn.

**Call relations**: Completes the MCP item started earlier, preserving structured content and metadata when the call succeeded.

*Call graph*: calls 2 internal fn (upsert_item_in_current_turn, is_success); called by 1 (handle_event); 2 external calls (new, try_from).


##### `ThreadHistoryBuilder::handle_view_image_tool_call`  (lines 819–825)

```
fn handle_view_image_tool_call(&mut self, payload: &ViewImageToolCallEvent)
```

**Purpose**: Adds an image-view tool-call item for a viewed local path.

**Data flow**: Builds `ThreadItem::ImageView` from the call id and path and upserts it into the current turn.

**Call relations**: Called directly from event dispatch for image-view tool events.

*Call graph*: calls 1 internal fn (upsert_item_in_current_turn); called by 1 (handle_event).


##### `ThreadHistoryBuilder::handle_image_generation_begin`  (lines 827–836)

```
fn handle_image_generation_begin(&mut self, payload: &ImageGenerationBeginEvent)
```

**Purpose**: Creates a placeholder image-generation item when generation starts.

**Data flow**: Builds `ThreadItem::ImageGeneration` with the call id and empty/default fields for status, prompt, result, and saved path; upserts into the current turn.

**Call relations**: Pairs with the end handler so the same item id is updated with final generation details.

*Call graph*: calls 1 internal fn (upsert_item_in_current_turn); called by 1 (handle_event); 1 external calls (new).


##### `ThreadHistoryBuilder::handle_image_generation_end`  (lines 838–847)

```
fn handle_image_generation_end(&mut self, payload: &ImageGenerationEndEvent)
```

**Purpose**: Stores the final image-generation status and outputs.

**Data flow**: Builds `ThreadItem::ImageGeneration` from the call id, status, revised prompt, result payload, and optional saved path; upserts into the current turn.

**Call relations**: Completes or replaces the placeholder created by image-generation begin.

*Call graph*: calls 1 internal fn (upsert_item_in_current_turn); called by 1 (handle_event).


##### `ThreadHistoryBuilder::handle_collab_agent_spawn_begin`  (lines 849–865)

```
fn handle_collab_agent_spawn_begin(
        &mut self,
        payload: &codex_protocol::protocol::CollabAgentSpawnBeginEvent,
    )
```

**Purpose**: Creates an in-progress collaboration tool-call item for spawning a sub-agent.

**Data flow**: Builds `ThreadItem::CollabAgentToolCall` with tool `SpawnAgent`, in-progress status, sender thread id, empty receiver list, prompt/model/reasoning metadata, and empty `agents_states`; upserts into the current turn.

**Call relations**: Called for collaboration spawn begin events so the UI can show the pending operation before the child thread exists.

*Call graph*: calls 1 internal fn (upsert_item_in_current_turn); called by 1 (handle_event); 2 external calls (new, new).


##### `ThreadHistoryBuilder::handle_collab_agent_spawn_end`  (lines 867–899)

```
fn handle_collab_agent_spawn_end(
        &mut self,
        payload: &codex_protocol::protocol::CollabAgentSpawnEndEvent,
    )
```

**Purpose**: Stores the outcome of a spawn-agent operation, including the new receiver thread and its state when available.

**Data flow**: Determines success from both `payload.status` and presence of `new_thread_id`; builds sorted receiver ids and an `agents_states` map when a child thread was created; constructs a completed or failed `CollabAgentToolCall` and upserts it into the current turn.

**Call relations**: Completes the spawn item created by the begin handler and preserves model/reasoning metadata from the request.

*Call graph*: calls 2 internal fn (upsert_item_in_current_turn, from); called by 1 (handle_event); 3 external calls (new, new, vec!).


##### `ThreadHistoryBuilder::handle_collab_agent_interaction_begin`  (lines 901–917)

```
fn handle_collab_agent_interaction_begin(
        &mut self,
        payload: &codex_protocol::protocol::CollabAgentInteractionBeginEvent,
    )
```

**Purpose**: Creates an in-progress collaboration tool-call item for sending input to another agent thread.

**Data flow**: Builds `ThreadItem::CollabAgentToolCall` with tool `SendInput`, sender and single receiver ids, prompt, and empty agent-state map; upserts into the current turn.

**Call relations**: Called when a send-input operation starts.

*Call graph*: calls 1 internal fn (upsert_item_in_current_turn); called by 1 (handle_event); 2 external calls (new, vec!).


##### `ThreadHistoryBuilder::handle_collab_agent_interaction_end`  (lines 919–940)

```
fn handle_collab_agent_interaction_end(
        &mut self,
        payload: &codex_protocol::protocol::CollabAgentInteractionEndEvent,
    )
```

**Purpose**: Stores the final status of a send-input collaboration call and the receiver agent's resulting state.

**Data flow**: Maps errored/not-found receiver statuses to failed tool-call status and all others to completed; converts the receiver `AgentStatus` into `CollabAgentState`; builds the final `CollabAgentToolCall`; upserts into the current turn.

**Call relations**: Completes the send-input item. Notably, an interrupted receiver still yields a completed tool call because the redirect operation itself succeeded.

*Call graph*: calls 2 internal fn (upsert_item_in_current_turn, from); called by 1 (handle_event); 1 external calls (vec!).


##### `ThreadHistoryBuilder::handle_sub_agent_activity`  (lines 942–952)

```
fn handle_sub_agent_activity(
        &mut self,
        payload: &codex_protocol::protocol::SubAgentActivityEvent,
    )
```

**Purpose**: Adds a sub-agent activity marker item to the current turn.

**Data flow**: Builds `ThreadItem::SubAgentActivity` from the event id, converted activity kind, agent thread id, and agent path string; upserts into the current turn.

**Call relations**: Called for sub-agent activity events to expose child-agent progress in thread history.

*Call graph*: calls 1 internal fn (upsert_item_in_current_turn); called by 1 (handle_event); 1 external calls (from).


##### `ThreadHistoryBuilder::handle_collab_waiting_begin`  (lines 954–974)

```
fn handle_collab_waiting_begin(
        &mut self,
        payload: &codex_protocol::protocol::CollabWaitingBeginEvent,
    )
```

**Purpose**: Creates an in-progress collaboration wait item for waiting on multiple receiver agents.

**Data flow**: Builds `ThreadItem::CollabAgentToolCall` with tool `Wait`, sender id, receiver ids copied from the payload, no prompt/model metadata, and empty states; upserts into the current turn.

**Call relations**: Called when a wait-for-agents operation begins.

*Call graph*: calls 1 internal fn (upsert_item_in_current_turn); called by 1 (handle_event); 1 external calls (new).


##### `ThreadHistoryBuilder::handle_collab_waiting_end`  (lines 976–1008)

```
fn handle_collab_waiting_end(
        &mut self,
        payload: &codex_protocol::protocol::CollabWaitingEndEvent,
    )
```

**Purpose**: Stores the final wait result across multiple receiver agents.

**Data flow**: Marks the tool call failed if any receiver status is errored or not found, otherwise completed; collects and sorts receiver thread ids from the status map; converts each receiver status into `CollabAgentState`; builds the final wait item and upserts it.

**Call relations**: Completes the wait item and normalizes receiver ordering for stable history output.

*Call graph*: calls 1 internal fn (upsert_item_in_current_turn); called by 1 (handle_event).


##### `ThreadHistoryBuilder::handle_collab_close_begin`  (lines 1010–1026)

```
fn handle_collab_close_begin(
        &mut self,
        payload: &codex_protocol::protocol::CollabCloseBeginEvent,
    )
```

**Purpose**: Creates an in-progress collaboration tool-call item for closing a child agent.

**Data flow**: Builds `ThreadItem::CollabAgentToolCall` with tool `CloseAgent`, sender id, one receiver id, and empty state metadata; upserts into the current turn.

**Call relations**: Called when a close-agent operation starts.

*Call graph*: calls 1 internal fn (upsert_item_in_current_turn); called by 1 (handle_event); 2 external calls (new, vec!).


##### `ThreadHistoryBuilder::handle_collab_close_end`  (lines 1028–1051)

```
fn handle_collab_close_end(&mut self, payload: &codex_protocol::protocol::CollabCloseEndEvent)
```

**Purpose**: Stores the final result of closing a child agent.

**Data flow**: Maps receiver `AgentStatus` to completed or failed tool-call status; converts the receiver status into a one-entry `agents_states` map; builds the final close-agent item and upserts it.

**Call relations**: Completes the close-agent item created by the begin handler.

*Call graph*: calls 2 internal fn (upsert_item_in_current_turn, from); called by 1 (handle_event); 1 external calls (vec!).


##### `ThreadHistoryBuilder::handle_collab_resume_begin`  (lines 1053–1069)

```
fn handle_collab_resume_begin(
        &mut self,
        payload: &codex_protocol::protocol::CollabResumeBeginEvent,
    )
```

**Purpose**: Creates an in-progress collaboration tool-call item for resuming a child agent.

**Data flow**: Builds `ThreadItem::CollabAgentToolCall` with tool `ResumeAgent`, sender id, one receiver id, and empty state metadata; upserts into the current turn.

**Call relations**: Called when a resume-agent operation starts.

*Call graph*: calls 1 internal fn (upsert_item_in_current_turn); called by 1 (handle_event); 2 external calls (new, vec!).


##### `ThreadHistoryBuilder::handle_collab_resume_end`  (lines 1071–1097)

```
fn handle_collab_resume_end(
        &mut self,
        payload: &codex_protocol::protocol::CollabResumeEndEvent,
    )
```

**Purpose**: Stores the final result of resuming a child agent.

**Data flow**: Maps receiver `AgentStatus` to completed or failed tool-call status; converts the receiver status into a one-entry `agents_states` map; builds the final resume-agent item and upserts it.

**Call relations**: Completes the resume-agent item created by the begin handler.

*Call graph*: calls 2 internal fn (upsert_item_in_current_turn, from); called by 1 (handle_event); 1 external calls (vec!).


##### `ThreadHistoryBuilder::handle_context_compacted`  (lines 1099–1102)

```
fn handle_context_compacted(&mut self, _payload: &ContextCompactedEvent)
```

**Purpose**: Adds a visible context-compaction marker item to the current turn.

**Data flow**: Allocates a synthetic item id and pushes `ThreadItem::ContextCompaction` into the current turn.

**Call relations**: Called for `ContextCompacted` events, distinct from `RolloutItem::Compacted`, which only marks turn preservation.

*Call graph*: calls 2 internal fn (next_item_id, push_item_in_current_turn); called by 1 (handle_event).


##### `ThreadHistoryBuilder::handle_entered_review_mode`  (lines 1104–1111)

```
fn handle_entered_review_mode(&mut self, payload: &codex_protocol::protocol::ReviewRequest)
```

**Purpose**: Adds an item indicating that review mode was entered, with a user-facing review hint.

**Data flow**: Uses `payload.user_facing_hint` when present or the fallback text `"Review requested."`; allocates a synthetic item id; pushes `ThreadItem::EnteredReviewMode`.

**Call relations**: Called from event dispatch when review mode begins.

*Call graph*: calls 2 internal fn (next_item_id, push_item_in_current_turn); called by 1 (handle_event).


##### `ThreadHistoryBuilder::handle_exited_review_mode`  (lines 1113–1124)

```
fn handle_exited_review_mode(
        &mut self,
        payload: &codex_protocol::protocol::ExitedReviewModeEvent,
    )
```

**Purpose**: Adds an item indicating that review mode ended, rendering the review output into plain text.

**Data flow**: If `payload.review_output` exists, converts it with `render_review_output_text`; otherwise uses `REVIEW_FALLBACK_MESSAGE`; allocates a synthetic item id; pushes `ThreadItem::ExitedReviewMode`.

**Call relations**: Called when review mode exits so the thread history captures the reviewer-visible summary.

*Call graph*: calls 2 internal fn (next_item_id, push_item_in_current_turn); called by 1 (handle_event).


##### `ThreadHistoryBuilder::handle_error`  (lines 1126–1145)

```
fn handle_error(&mut self, payload: &ErrorEvent)
```

**Purpose**: Marks the active turn as failed when an error event is considered turn-affecting.

**Data flow**: Checks `payload.affects_turn_status()`; if false, returns immediately; otherwise mutates `current_turn` status to `TurnStatus::Failed`, stores a `V2TurnError` with message and converted codex error info, and records a changed-turn snapshot when change tracking is active.

**Call relations**: Called for error events. It only affects an already active turn and intentionally does not create a new turn for request-level or out-of-turn failures.

*Call graph*: calls 3 internal fn (is_tracking_changes, record_changed_turn, affects_turn_status); called by 1 (handle_event).


##### `ThreadHistoryBuilder::handle_turn_aborted`  (lines 1147–1177)

```
fn handle_turn_aborted(&mut self, payload: &TurnAbortedEvent)
```

**Purpose**: Marks a targeted turn as interrupted, preferring an exact turn-id match and falling back to the active turn.

**Data flow**: Builds a small closure that sets status to `Interrupted` and copies completion timing; if `payload.turn_id` matches the active pending turn, mutates it and records a pending-turn snapshot; else if it matches a finished turn, mutates that turn and records a finalized snapshot; else, if any active turn exists, applies the interruption there.

**Call relations**: Called for abort events. The exact-id preference prevents late aborts for older turns from incorrectly interrupting the current active turn.

*Call graph*: calls 2 internal fn (record_changed_turn, from_turn); called by 1 (handle_event).


##### `ThreadHistoryBuilder::handle_turn_started`  (lines 1179–1188)

```
fn handle_turn_started(&mut self, payload: &TurnStartedEvent)
```

**Purpose**: Opens a new explicit turn with canonical id and in-progress metadata.

**Data flow**: Finalizes any existing current turn; creates a `PendingTurn` with the provided turn id, `TurnStatus::InProgress`, optional `started_at`, and `opened_explicitly = true`; records a changed-turn snapshot; stores it as `current_turn`.

**Call relations**: Called on explicit turn-start events and establishes the canonical turn boundary used by later turn-scoped items.

*Call graph*: calls 3 internal fn (finish_current_turn, new_turn, record_changed_pending_turn); called by 1 (handle_event).


##### `ThreadHistoryBuilder::handle_turn_complete`  (lines 1190–1233)

```
fn handle_turn_complete(&mut self, payload: &TurnCompleteEvent)
```

**Purpose**: Marks a turn completed, preferring an exact id match and only closing the active turn when that active turn is the target or the fallback target.

**Data flow**: Uses a closure to set completed status only when the turn was `Completed` or `InProgress`, then copies completion timing; first checks whether the active pending turn id matches `payload.turn_id`, records the change, and finalizes it; otherwise searches finished turns and updates one in place; if no match exists, applies completion to the active turn and finalizes it.

**Call relations**: Called for turn-complete events. The exact-id-first logic prevents late completion of an older turn from accidentally closing a newer active turn.

*Call graph*: calls 3 internal fn (finish_current_turn, record_changed_turn, from_turn); called by 1 (handle_event); 1 external calls (matches!).


##### `ThreadHistoryBuilder::handle_compacted`  (lines 1240–1242)

```
fn handle_compacted(&mut self, _payload: &CompactedItem)
```

**Purpose**: Marks the current turn as containing a persisted compaction marker so it will be preserved even if it has no renderable items.

**Data flow**: Ensures a current turn exists and sets `saw_compaction = true` on it.

**Call relations**: Called only for `RolloutItem::Compacted`, not for the visible `ContextCompacted` event item.

*Call graph*: calls 1 internal fn (ensure_turn); called by 1 (handle_rollout_item).


##### `ThreadHistoryBuilder::handle_thread_rollback`  (lines 1244–1268)

```
fn handle_thread_rollback(&mut self, payload: &ThreadRolledBackEvent)
```

**Purpose**: Removes the last N finished turns from history and resets synthetic item numbering to match the remaining items.

**Data flow**: Finalizes any active turn; converts `payload.num_turns` to `usize` with saturation fallback; computes the ids of turns to remove; records those ids in the active change set; truncates or clears `turns`; recomputes `next_item_index` as one plus the total remaining item count, saturating on conversion overflow.

**Call relations**: Called for rollback events. It interacts with change tracking so downstream projectors can drop stale turn and item state.

*Call graph*: calls 2 internal fn (finish_current_turn, record_removed_turn_ids); called by 1 (handle_event); 3 external calls (new, try_from, try_from).


##### `ThreadHistoryBuilder::finish_current_turn`  (lines 1270–1277)

```
fn finish_current_turn(&mut self)
```

**Purpose**: Moves the pending turn into the finished turn list unless it is an empty implicit non-compaction turn.

**Data flow**: Takes `current_turn`; if absent does nothing; if the turn has no items and was neither explicitly opened nor marked with compaction, drops it; otherwise converts it into `Turn` and pushes it onto `turns`.

**Call relations**: Used whenever a turn boundary is crossed or the builder is finalized. This is where empty-turn preservation rules are enforced.

*Call graph*: called by 5 (finish, handle_thread_rollback, handle_turn_complete, handle_turn_started, handle_user_message); 1 external calls (from).


##### `ThreadHistoryBuilder::new_turn`  (lines 1279–1299)

```
fn new_turn(&mut self, id: Option<String>) -> PendingTurn
```

**Purpose**: Constructs a fresh `PendingTurn` with either a supplied canonical id or a synthetic id derived from replay context.

**Data flow**: If `id` is provided, uses it; otherwise generates a UUID v7 when no rollout items have been seen yet, or `rollout-<current_rollout_index>` during replay; initializes empty items, completed status, no error/timing, `opened_explicitly = false`, `saw_compaction = false`, and stores the current rollout start index.

**Call relations**: Used by implicit turn creation and explicit turn-start handling.

*Call graph*: called by 2 (ensure_turn, handle_turn_started); 1 external calls (new).


##### `ThreadHistoryBuilder::ensure_turn`  (lines 1301–1313)

```
fn ensure_turn(&mut self) -> &mut PendingTurn
```

**Purpose**: Guarantees that `current_turn` exists and returns a mutable reference to it.

**Data flow**: If `current_turn` is `None`, creates a new implicit turn with `new_turn`, records its metadata snapshot when tracking changes, and stores it; then returns `&mut PendingTurn`; the `unreachable!` guards the postcondition.

**Call relations**: Central helper used by all item-appending/upserting paths that need an active turn.

*Call graph*: calls 2 internal fn (new_turn, record_changed_pending_turn); called by 5 (handle_agent_reasoning, handle_agent_reasoning_raw_content, handle_compacted, push_item_in_current_turn, upsert_item_in_current_turn); 1 external calls (unreachable!).


##### `ThreadHistoryBuilder::push_item_in_current_turn`  (lines 1315–1326)

```
fn push_item_in_current_turn(&mut self, item: ThreadItem)
```

**Purpose**: Appends a new item to the active turn without deduplicating by item id.

**Data flow**: Checks whether change tracking is active; ensures a current turn exists; clones `(turn_id, item)` for change reporting when needed; pushes the item onto `turn.items`; records the changed item snapshot if tracking.

**Call relations**: Used for naturally append-only items such as user messages, agent messages, review markers, and newly created reasoning/context-compaction items.

*Call graph*: calls 3 internal fn (ensure_turn, is_tracking_changes, record_changed_item); called by 8 (handle_agent_message, handle_agent_reasoning, handle_agent_reasoning_raw_content, handle_context_compacted, handle_entered_review_mode, handle_exited_review_mode, handle_response_item, handle_user_message).


##### `ThreadHistoryBuilder::upsert_item_in_turn_id`  (lines 1328–1358)

```
fn upsert_item_in_turn_id(&mut self, turn_id: &str, item: ThreadItem)
```

**Purpose**: Inserts or replaces an item in a specific turn identified by turn id.

**Data flow**: Checks the active turn first, then searches finished turns for `turn_id`; in the matching turn, calls `upsert_turn_item` to replace by item id or append if absent; records the changed item snapshot when tracking; if no turn matches, logs a warning and drops the item.

**Call relations**: Used by turn-scoped events whose completions may arrive after the active turn has changed, such as command execution and patch events.

*Call graph*: calls 3 internal fn (is_tracking_changes, record_changed_item, upsert_turn_item); called by 10 (handle_apply_patch_approval_request, handle_dynamic_tool_call_request, handle_dynamic_tool_call_response, handle_exec_command_begin, handle_exec_command_end, handle_guardian_assessment, handle_item_completed, handle_item_started, handle_patch_apply_begin, handle_patch_apply_end); 1 external calls (warn!).


##### `ThreadHistoryBuilder::upsert_item_in_current_turn`  (lines 1360–1370)

```
fn upsert_item_in_current_turn(&mut self, item: ThreadItem)
```

**Purpose**: Inserts or replaces an item in the active turn by item id.

**Data flow**: Checks change tracking; ensures a current turn exists; calls `upsert_turn_item` on `turn.items`; records the resulting item snapshot if tracking.

**Call relations**: Used for begin/end pairs and mutable tool-call items that always belong to the current turn.

*Call graph*: calls 4 internal fn (ensure_turn, is_tracking_changes, record_changed_item, upsert_turn_item); called by 24 (handle_apply_patch_approval_request, handle_collab_agent_interaction_begin, handle_collab_agent_interaction_end, handle_collab_agent_spawn_begin, handle_collab_agent_spawn_end, handle_collab_close_begin, handle_collab_close_end, handle_collab_resume_begin, handle_collab_resume_end, handle_collab_waiting_begin (+14 more)).


##### `ThreadHistoryBuilder::is_tracking_changes`  (lines 1372–1374)

```
fn is_tracking_changes(&self) -> bool
```

**Purpose**: Reports whether the builder is currently collecting incremental change snapshots.

**Data flow**: Returns whether `active_change_set` is `Some`.

**Call relations**: Queried by mutation helpers so they only clone and record snapshots during explicit change-collection calls.

*Call graph*: called by 7 (handle_agent_reasoning, handle_agent_reasoning_raw_content, handle_error, push_item_in_current_turn, record_changed_pending_turn, upsert_item_in_current_turn, upsert_item_in_turn_id).


##### `ThreadHistoryBuilder::record_changed_item`  (lines 1376–1382)

```
fn record_changed_item(&mut self, turn_id: String, item: ThreadItem)
```

**Purpose**: Appends one changed item snapshot to the active change set.

**Data flow**: If `active_change_set` exists, pushes `ThreadHistoryItemChange { turn_id, item }` into its `changed_items` vector.

**Call relations**: Called by append/upsert paths and by reasoning mutation handlers after in-place edits.

*Call graph*: called by 5 (handle_agent_reasoning, handle_agent_reasoning_raw_content, push_item_in_current_turn, upsert_item_in_current_turn, upsert_item_in_turn_id).


##### `ThreadHistoryBuilder::record_changed_pending_turn`  (lines 1384–1388)

```
fn record_changed_pending_turn(&mut self, turn: &PendingTurn)
```

**Purpose**: Records the current metadata snapshot of a pending turn when change tracking is enabled.

**Data flow**: Checks `is_tracking_changes`; if true, converts the `PendingTurn` with `ThreadHistoryTurnChange::from_pending_turn` and forwards it to `record_changed_turn`.

**Call relations**: Used when a new implicit or explicit turn is opened.

*Call graph*: calls 3 internal fn (is_tracking_changes, record_changed_turn, from_pending_turn); called by 2 (ensure_turn, handle_turn_started).


##### `ThreadHistoryBuilder::record_changed_turn`  (lines 1390–1394)

```
fn record_changed_turn(&mut self, turn: ThreadHistoryTurnChange)
```

**Purpose**: Appends one changed turn metadata snapshot to the active change set.

**Data flow**: If `active_change_set` exists, pushes the provided `ThreadHistoryTurnChange` into `changed_turns`.

**Call relations**: Called by turn lifecycle and error handlers, and indirectly by pending-turn recording.

*Call graph*: called by 4 (handle_error, handle_turn_aborted, handle_turn_complete, record_changed_pending_turn).


##### `ThreadHistoryBuilder::record_removed_turn_ids`  (lines 1396–1400)

```
fn record_removed_turn_ids(&mut self, removed_turn_ids: Vec<String>)
```

**Purpose**: Adds removed turn ids to the active change set during rollback.

**Data flow**: If `active_change_set` exists, extends its `removed_turn_ids` vector with the provided ids.

**Call relations**: Used only by rollback handling so downstream consumers can delete obsolete turn state.

*Call graph*: called by 1 (handle_thread_rollback).


##### `ThreadHistoryBuilder::next_item_id`  (lines 1402–1406)

```
fn next_item_id(&mut self) -> String
```

**Purpose**: Allocates the next synthetic sequential item id.

**Data flow**: Formats `item-<next_item_index>`, increments `next_item_index`, and returns the string.

**Call relations**: Used for item kinds that do not carry their own stable protocol id.

*Call graph*: called by 7 (handle_agent_message, handle_agent_reasoning, handle_agent_reasoning_raw_content, handle_context_compacted, handle_entered_review_mode, handle_exited_review_mode, handle_user_message); 1 external calls (format!).


##### `ThreadHistoryBuilder::build_user_inputs`  (lines 1408–1436)

```
fn build_user_inputs(&self, payload: &UserMessageEvent) -> Vec<UserInput>
```

**Purpose**: Converts a legacy `UserMessageEvent` payload into the v2 `Vec<UserInput>` representation.

**Data flow**: Starts with an empty vector; adds `UserInput::Text` when the trimmed message is non-empty, preserving `text_elements`; appends `UserInput::Image` entries from `images` paired with `image_details` by index; appends `UserInput::LocalImage` entries from `local_images` paired with `local_image_details`; returns the assembled vector.

**Call relations**: Used only by `handle_user_message` to preserve mixed text/image input content during replay.

*Call graph*: called by 1 (handle_user_message); 1 external calls (new).


##### `render_review_output_text`  (lines 1441–1448)

```
fn render_review_output_text(output: &ReviewOutputEvent) -> String
```

**Purpose**: Extracts the user-visible explanation text from a review output event, with a fallback when the explanation is blank.

**Data flow**: Trims `output.overall_explanation`; returns the fallback constant if empty, otherwise returns the trimmed explanation as an owned string.

**Call relations**: Used by review-mode exit handling to normalize reviewer output into a single display string.


##### `convert_dynamic_tool_content_items`  (lines 1450–1465)

```
fn convert_dynamic_tool_content_items(
    items: &[codex_protocol::dynamic_tools::DynamicToolCallOutputContentItem],
) -> Vec<DynamicToolCallOutputContentItem>
```

**Purpose**: Maps core dynamic-tool output content items into the v2 protocol equivalents.

**Data flow**: Iterates over the input slice, clones each item, pattern-matches `InputText` and `InputImage`, rebuilds the corresponding v2 enum variant, and collects the results into a vector.

**Call relations**: Used only when materializing dynamic tool call response items.

*Call graph*: called by 1 (handle_dynamic_tool_call_response); 1 external calls (iter).


##### `upsert_turn_item`  (lines 1467–1478)

```
fn upsert_turn_item(items: &mut Vec<ThreadItem>, item: ThreadItem) -> &ThreadItem
```

**Purpose**: Replaces an existing `ThreadItem` with the same item id in a turn, or appends the item if no match exists.

**Data flow**: Searches the mutable `items` vector for an element whose `id()` matches `item.id()`; if found, overwrites that slot and returns a reference to it; otherwise pushes the new item and returns a reference to the inserted element.

**Call relations**: Shared low-level helper behind both current-turn and explicit-turn upsert operations.

*Call graph*: called by 2 (upsert_item_in_current_turn, upsert_item_in_turn_id).


##### `PendingTurn::opened_explicitly`  (lines 1499–1502)

```
fn opened_explicitly(mut self) -> Self
```

**Purpose**: Marks a pending turn as originating from explicit turn-boundary events.

**Data flow**: Takes ownership of `self`, sets `opened_explicitly = true`, and returns the modified turn.

**Call relations**: Used during explicit turn-start construction so empty explicit turns are preserved.


##### `PendingTurn::with_status`  (lines 1504–1507)

```
fn with_status(mut self, status: TurnStatus) -> Self
```

**Purpose**: Sets the initial status on a newly built pending turn in builder-style fashion.

**Data flow**: Consumes `self`, assigns the provided `TurnStatus`, and returns the updated turn.

**Call relations**: Used when constructing explicit turns from `TurnStarted` events.


##### `PendingTurn::with_started_at`  (lines 1509–1512)

```
fn with_started_at(mut self, started_at: Option<i64>) -> Self
```

**Purpose**: Sets the start timestamp on a pending turn in builder-style fashion.

**Data flow**: Consumes `self`, assigns `started_at`, and returns the updated turn.

**Call relations**: Used alongside `with_status` and `opened_explicitly` during explicit turn creation.


##### `Turn::from`  (lines 1531–1542)

```
fn from(value: &PendingTurn) -> Self
```

**Purpose**: Converts a borrowed `PendingTurn` into a cloned materialized `Turn` snapshot.

**Data flow**: Clones the pending turn's id, items, error, status, and timing fields; sets `items_view` to `TurnItemsView::Full`; returns the new `Turn`.

**Call relations**: Used for active-turn snapshots and turn lookup without consuming the pending turn.


##### `tests::builds_multiple_turns_with_reasoning_items`  (lines 1591–1697)

```
fn builds_multiple_turns_with_reasoning_items()
```

**Purpose**: Verifies implicit turn splitting, synthetic ids, and reasoning summary/raw-content coalescing across two user turns.

**Data flow**: Builds a sequence of user, agent, and reasoning events; feeds them through a builder; finalizes turns; asserts exact `Turn` and `ThreadItem` contents.

**Call relations**: Exercises the basic replay path and the reasoning append-vs-create behavior.

*Call graph*: calls 1 internal fn (new); 4 external calls (assert!, assert_eq!, assert_ne!, vec!).


##### `tests::rebuilds_user_message_image_details_from_legacy_events`  (lines 1700–1738)

```
fn rebuilds_user_message_image_details_from_legacy_events()
```

**Purpose**: Checks that remote and local image detail metadata from legacy user-message events is preserved in rebuilt `UserInput` values.

**Data flow**: Creates one rollout item containing a `UserMessageEvent` with image detail arrays; rebuilds turns; asserts the resulting `ThreadItem::UserMessage` content vector.

**Call relations**: Covers `build_user_inputs` and rollout replay.

*Call graph*: calls 1 internal fn (build_turns_from_rollout_items); 3 external calls (from, assert_eq!, vec!).


##### `tests::ignores_user_message_item_lifecycle_events`  (lines 1741–1797)

```
fn ignores_user_message_item_lifecycle_events()
```

**Purpose**: Ensures persisted lifecycle events for user-message items do not duplicate the actual user message item.

**Data flow**: Replays explicit turn start, user message, `ItemStarted` for a user message, and turn complete; asserts only one user-message item remains.

**Call relations**: Validates the selective handling in `handle_item_started`.

*Call graph*: calls 2 internal fn (build_turns_from_rollout_items, new); 2 external calls (assert_eq!, vec!).


##### `tests::rebuilds_sleep_item_from_persisted_completion`  (lines 1800–1844)

```
fn rebuilds_sleep_item_from_persisted_completion()
```

**Purpose**: Confirms that a persisted sleep-item completion reconstructs a `ThreadItem::Sleep` even without a dedicated sleep event.

**Data flow**: Replays turn start, `ItemCompleted` carrying a core sleep item, and turn complete; asserts the resulting turn contains the converted sleep item.

**Call relations**: Exercises `handle_item_completed` for `Sleep`.

*Call graph*: calls 2 internal fn (build_turns_from_rollout_items, new); 3 external calls (Sleep, assert_eq!, vec!).


##### `tests::preserves_user_message_client_id_from_legacy_event`  (lines 1847–1905)

```
fn preserves_user_message_client_id_from_legacy_event()
```

**Purpose**: Checks that `client_id` survives replay when both lifecycle and legacy user-message events are present.

**Data flow**: Replays explicit turn start, a user-message lifecycle item with `client_id`, the legacy `UserMessageEvent`, and turn complete; asserts the rebuilt user message carries the client id.

**Call relations**: Covers backward-compatible reconstruction of user messages.

*Call graph*: calls 2 internal fn (build_turns_from_rollout_items, new); 2 external calls (assert_eq!, vec!).


##### `tests::preserves_agent_message_phase_in_history`  (lines 1908–1930)

```
fn preserves_agent_message_phase_in_history()
```

**Purpose**: Verifies that agent message phase metadata is preserved in thread history.

**Data flow**: Replays one agent message with `FinalAnswer` phase and asserts the resulting `ThreadItem::AgentMessage` contains the converted phase.

**Call relations**: Exercises `handle_agent_message` field preservation.

*Call graph*: calls 1 internal fn (build_turns_from_rollout_items); 2 external calls (assert_eq!, vec!).


##### `tests::replays_image_generation_end_events_into_turn_history`  (lines 1933–1997)

```
fn replays_image_generation_end_events_into_turn_history()
```

**Purpose**: Checks that image-generation completion events become `ThreadItem::ImageGeneration` entries in the correct turn.

**Data flow**: Replays explicit turn boundaries, a user message, and an image-generation end event; asserts the final turn structure and item contents.

**Call relations**: Covers image-generation replay without requiring a begin event.

*Call graph*: calls 1 internal fn (build_turns_from_rollout_items); 2 external calls (assert_eq!, vec!).


##### `tests::splits_reasoning_when_interleaved`  (lines 2000–2051)

```
fn splits_reasoning_when_interleaved()
```

**Purpose**: Ensures reasoning text is appended only to the immediately preceding reasoning item and starts a new item after interleaving content.

**Data flow**: Replays user message, reasoning summary, reasoning raw content, an agent message, and another reasoning summary; asserts two separate reasoning items exist.

**Call relations**: Validates the last-item check in reasoning handlers.

*Call graph*: calls 1 internal fn (build_turns_from_rollout_items); 2 external calls (assert_eq!, vec!).


##### `tests::marks_turn_as_interrupted_when_aborted`  (lines 2054–2144)

```
fn marks_turn_as_interrupted_when_aborted()
```

**Purpose**: Verifies that an abort event marks the targeted turn interrupted and that subsequent user input starts a new turn.

**Data flow**: Replays two implicit user turns with an abort event between them; rebuilds turns; asserts first turn status is `Interrupted` and second remains completed.

**Call relations**: Exercises abort handling and implicit turn rotation.

*Call graph*: calls 1 internal fn (build_turns_from_rollout_items); 2 external calls (assert_eq!, vec!).


##### `tests::drops_last_turns_on_thread_rollback`  (lines 2147–2240)

```
fn drops_last_turns_on_thread_rollback()
```

**Purpose**: Checks that rollback removes the requested number of most recent turns and that later events continue from the truncated history.

**Data flow**: Replays two implicit turns, a rollback of one turn, then another user turn; asserts only the first and third logical turns remain with expected synthetic ids and items.

**Call relations**: Covers rollback truncation and synthetic turn-id generation from rollout indexes.

*Call graph*: calls 1 internal fn (build_turns_from_rollout_items); 3 external calls (assert_eq!, assert_ne!, vec!).


##### `tests::thread_rollback_clears_all_turns_when_num_turns_exceeds_history`  (lines 2243–2280)

```
fn thread_rollback_clears_all_turns_when_num_turns_exceeds_history()
```

**Purpose**: Ensures rollback clears the entire history when asked to remove more turns than exist.

**Data flow**: Replays two turns and a rollback with `num_turns = 99`; asserts the rebuilt turn list is empty.

**Call relations**: Exercises the saturating branch in rollback handling.

*Call graph*: calls 1 internal fn (build_turns_from_rollout_items); 2 external calls (assert_eq!, vec!).


##### `tests::uses_explicit_turn_boundaries_for_mid_turn_steering`  (lines 2283–2345)

```
fn uses_explicit_turn_boundaries_for_mid_turn_steering()
```

**Purpose**: Verifies that multiple user messages remain in one explicit turn instead of splitting into separate implicit turns.

**Data flow**: Replays explicit turn start, two user messages, and turn complete; asserts a single turn contains both user-message items.

**Call relations**: Confirms the `opened_explicitly` guard in `handle_user_message`.

*Call graph*: calls 1 internal fn (build_turns_from_rollout_items); 2 external calls (assert_eq!, vec!).


##### `tests::reconstructs_tool_items_from_persisted_completion_events`  (lines 2348–2459)

```
fn reconstructs_tool_items_from_persisted_completion_events()
```

**Purpose**: Checks replay of web search, command execution, and MCP tool completion events into concrete thread items.

**Data flow**: Replays explicit turn boundaries, a user message, and completion events for web search, exec command, and MCP tool call; asserts exact reconstructed items and statuses.

**Call relations**: Exercises several event-specific reducers and item builders.

*Call graph*: calls 1 internal fn (build_turns_from_rollout_items); 2 external calls (assert_eq!, vec!).


##### `tests::reconstructs_mcp_tool_result_meta_from_persisted_completion_events`  (lines 2462–2525)

```
fn reconstructs_mcp_tool_result_meta_from_persisted_completion_events()
```

**Purpose**: Verifies successful MCP tool-call replay preserves structured content and metadata fields.

**Data flow**: Replays turn start and a successful MCP tool-call end event with content, structured content, and meta; asserts the resulting `ThreadItem::McpToolCall` contains all fields.

**Call relations**: Covers the success branch in `handle_mcp_tool_call_end`.

*Call graph*: calls 1 internal fn (build_turns_from_rollout_items); 2 external calls (assert_eq!, vec!).


##### `tests::reconstructs_dynamic_tool_items_from_request_and_response_events`  (lines 2528–2593)

```
fn reconstructs_dynamic_tool_items_from_request_and_response_events()
```

**Purpose**: Ensures dynamic tool request/response events upsert into one final `DynamicToolCall` item with output content and duration.

**Data flow**: Replays explicit turn boundaries, a user message, a dynamic tool request, and a successful response; asserts the final turn contains one completed dynamic tool item.

**Call relations**: Exercises request/response upsert behavior and content-item conversion.

*Call graph*: calls 1 internal fn (build_turns_from_rollout_items); 2 external calls (assert_eq!, vec!).


##### `tests::reconstructs_declined_exec_and_patch_items`  (lines 2596–2685)

```
fn reconstructs_declined_exec_and_patch_items()
```

**Purpose**: Checks that declined command and patch operations are reconstructed with declined statuses and visible outputs/diffs.

**Data flow**: Replays explicit turn boundaries, a user message, a declined exec completion, and a declined patch completion; asserts the resulting command and file-change items.

**Call relations**: Covers status mapping in command and patch item builders.

*Call graph*: calls 1 internal fn (build_turns_from_rollout_items); 2 external calls (assert_eq!, vec!).


##### `tests::reconstructs_declined_guardian_command_item`  (lines 2688–2771)

```
fn reconstructs_declined_guardian_command_item()
```

**Purpose**: Verifies guardian assessment events can synthesize a declined command-execution item.

**Data flow**: Replays explicit turn boundaries, a user message, an in-progress guardian assessment, and a denied guardian assessment for the same target item; asserts the final command item is declined.

**Call relations**: Exercises guardian-event conversion and upsert-by-target-item-id behavior.

*Call graph*: calls 1 internal fn (build_turns_from_rollout_items); 2 external calls (assert_eq!, vec!).


##### `tests::reconstructs_in_progress_guardian_execve_item`  (lines 2774–2837)

```
fn reconstructs_in_progress_guardian_execve_item()
```

**Purpose**: Checks that an in-progress guardian assessment for an execve action becomes an in-progress command item.

**Data flow**: Replays explicit turn boundaries, a user message, and one in-progress guardian assessment; asserts the resulting command-execution item fields.

**Call relations**: Covers the in-progress branch of guardian assessment handling.

*Call graph*: calls 1 internal fn (build_turns_from_rollout_items); 2 external calls (assert_eq!, vec!).


##### `tests::assigns_late_exec_completion_to_original_turn`  (lines 2840–2935)

```
fn assigns_late_exec_completion_to_original_turn()
```

**Purpose**: Ensures a command completion arriving after a newer turn starts is attached to the original turn id rather than the active turn.

**Data flow**: Replays two explicit turns with an exec completion for the first turn arriving during the second; asserts the command item appears in turn A and not turn B.

**Call relations**: Validates explicit turn-id routing in `handle_exec_command_end` and `upsert_item_in_turn_id`.

*Call graph*: calls 1 internal fn (build_turns_from_rollout_items); 2 external calls (assert_eq!, vec!).


##### `tests::drops_late_turn_scoped_item_for_unknown_turn_id`  (lines 2938–3027)

```
fn drops_late_turn_scoped_item_for_unknown_turn_id()
```

**Purpose**: Checks that a late turn-scoped item for a missing turn id is dropped instead of being attached to the wrong turn.

**Data flow**: Feeds events through a builder including an exec completion for `turn-missing`; finalizes turns; asserts neither existing turn received the command item.

**Call relations**: Exercises the warning/drop path in `upsert_item_in_turn_id`.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert_eq!, vec!).


##### `tests::patch_apply_begin_updates_active_turn_snapshot_with_file_change`  (lines 3030–3095)

```
fn patch_apply_begin_updates_active_turn_snapshot_with_file_change()
```

**Purpose**: Verifies the active-turn snapshot reflects an in-progress file-change item immediately after patch application begins.

**Data flow**: Builds a live builder, handles explicit turn start, user message, and patch-begin events; reads `active_turn_snapshot`; asserts the snapshot contains the in-progress file change.

**Call relations**: Covers snapshotting during an open turn.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert_eq!, vec!).


##### `tests::apply_patch_approval_request_updates_active_turn_snapshot_with_file_change`  (lines 3098–3165)

```
fn apply_patch_approval_request_updates_active_turn_snapshot_with_file_change()
```

**Purpose**: Verifies the active-turn snapshot reflects a file-change approval request before patch execution.

**Data flow**: Handles explicit turn start, user message, and approval-request events on a live builder; reads `active_turn_snapshot`; asserts the file-change item is present and in progress.

**Call relations**: Exercises approval-request item creation and active snapshot behavior.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert_eq!, vec!).


##### `tests::late_turn_complete_does_not_close_active_turn`  (lines 3168–3237)

```
fn late_turn_complete_does_not_close_active_turn()
```

**Purpose**: Ensures a late completion for an older turn does not close the newer active turn.

**Data flow**: Replays explicit turn A complete, explicit turn B start, a late completion for turn A, more activity in turn B, and turn B complete; asserts turn B still contains later items.

**Call relations**: Validates exact-id matching and fallback logic in `handle_turn_complete`.

*Call graph*: calls 1 internal fn (build_turns_from_rollout_items); 2 external calls (assert_eq!, vec!).


##### `tests::late_turn_aborted_does_not_interrupt_active_turn`  (lines 3240–3302)

```
fn late_turn_aborted_does_not_interrupt_active_turn()
```

**Purpose**: Ensures a late abort for an older turn does not interrupt the newer active turn.

**Data flow**: Replays explicit turn A complete, explicit turn B start, a late abort for turn A, and more activity in turn B; asserts turn B remains in progress with its items intact.

**Call relations**: Validates exact-id preference in `handle_turn_aborted`.

*Call graph*: calls 1 internal fn (build_turns_from_rollout_items); 2 external calls (assert_eq!, vec!).


##### `tests::preserves_compaction_only_turn`  (lines 3305–3342)

```
fn preserves_compaction_only_turn()
```

**Purpose**: Checks that an explicit turn containing only a persisted compaction marker is preserved instead of being dropped as empty.

**Data flow**: Replays explicit turn start, `RolloutItem::Compacted`, and turn complete; asserts one empty completed turn remains.

**Call relations**: Exercises `handle_compacted` and the empty-turn preservation rule in `finish_current_turn`.

*Call graph*: calls 1 internal fn (build_turns_from_rollout_items); 2 external calls (assert_eq!, vec!).


##### `tests::reconstructs_collab_resume_end_item`  (lines 3345–3397)

```
fn reconstructs_collab_resume_end_item()
```

**Purpose**: Verifies collaboration resume completion events become `CollabAgentToolCall` items with receiver state.

**Data flow**: Replays a user message and a collab resume end event; asserts the resulting item fields including sender/receiver ids and `agents_states`.

**Call relations**: Covers `handle_collab_resume_end`.

*Call graph*: calls 1 internal fn (build_turns_from_rollout_items); 2 external calls (assert_eq!, vec!).


##### `tests::reconstructs_collab_spawn_end_item_with_model_metadata`  (lines 3400–3457)

```
fn reconstructs_collab_spawn_end_item_with_model_metadata()
```

**Purpose**: Checks that collaboration spawn completion preserves prompt, model, reasoning effort, and spawned-agent state.

**Data flow**: Replays a user message and a collab spawn end event with a new thread id; asserts the resulting spawn tool-call item.

**Call relations**: Exercises the success branch of `handle_collab_agent_spawn_end`.

*Call graph*: calls 2 internal fn (build_turns_from_rollout_items, try_from); 2 external calls (assert_eq!, vec!).


##### `tests::reconstructs_interrupted_send_input_as_completed_collab_call`  (lines 3460–3529)

```
fn reconstructs_interrupted_send_input_as_completed_collab_call()
```

**Purpose**: Ensures a send-input redirect that leaves the receiver interrupted is still represented as a completed collaboration tool call.

**Data flow**: Replays a user message, collab interaction begin, and collab interaction end with receiver status `Interrupted`; asserts the tool-call status is completed while agent state is interrupted.

**Call relations**: Validates the nuanced status mapping in `handle_collab_agent_interaction_end`.

*Call graph*: calls 2 internal fn (build_turns_from_rollout_items, try_from); 2 external calls (assert_eq!, vec!).


##### `tests::rollback_failed_error_does_not_mark_turn_failed`  (lines 3532–3561)

```
fn rollback_failed_error_does_not_mark_turn_failed()
```

**Purpose**: Checks that rollback-failed errors do not mark the active turn as failed.

**Data flow**: Replays a user message, agent message, and an error event tagged `ThreadRollbackFailed`; asserts the resulting turn remains completed with no error.

**Call relations**: Exercises `ErrorEvent::affects_turn_status()` filtering through `handle_error`.

*Call graph*: calls 1 internal fn (build_turns_from_rollout_items); 2 external calls (assert_eq!, vec!).


##### `tests::out_of_turn_error_does_not_create_or_fail_a_turn`  (lines 3564–3620)

```
fn out_of_turn_error_does_not_create_or_fail_a_turn()
```

**Purpose**: Ensures request-level errors after a turn completes do not create a new failed turn or mutate the finished one.

**Data flow**: Replays explicit turn start, user message, turn complete, and a bad-request error; asserts the single completed turn is unchanged.

**Call relations**: Covers the no-active-turn path in `handle_error`.

*Call graph*: calls 1 internal fn (build_turns_from_rollout_items); 2 external calls (assert_eq!, vec!).


##### `tests::error_then_turn_complete_preserves_failed_status`  (lines 3623–3675)

```
fn error_then_turn_complete_preserves_failed_status()
```

**Purpose**: Verifies that once an active turn is marked failed by an error, a later turn-complete event does not overwrite that failed status.

**Data flow**: Replays explicit turn start, user message, a stream-disconnected error, and turn complete; asserts the final turn status is failed and the error payload is preserved.

**Call relations**: Exercises the guarded status update in `handle_turn_complete`.

*Call graph*: calls 1 internal fn (build_turns_from_rollout_items); 2 external calls (assert_eq!, vec!).


##### `tests::rebuilds_hook_prompt_items_from_rollout_response_items`  (lines 3678–3730)

```
fn rebuilds_hook_prompt_items_from_rollout_response_items()
```

**Purpose**: Checks that encoded hook prompt response items are parsed and replayed as `ThreadItem::HookPrompt` entries.

**Data flow**: Builds a hook prompt response message, replays it between explicit turn boundaries and a user message, and asserts the resulting hook prompt fragments.

**Call relations**: Exercises `handle_response_item` and hook-prompt parsing.

*Call graph*: calls 2 internal fn (build_turns_from_rollout_items, build_hook_prompt_message); 3 external calls (from_single_hook, assert_eq!, vec!).


##### `tests::ignores_plain_user_response_items_in_rollout_replay`  (lines 3733–3763)

```
fn ignores_plain_user_response_items_in_rollout_replay()
```

**Purpose**: Ensures ordinary user response items that are not hook prompts are ignored during rollout replay.

**Data flow**: Replays explicit turn boundaries with a plain user `ResponseItem::Message`; rebuilds turns; asserts the turn has no items.

**Call relations**: Validates the parse-and-ignore behavior in `handle_response_item`.

*Call graph*: calls 1 internal fn (build_turns_from_rollout_items); 3 external calls (assert!, assert_eq!, vec!).


##### `tests::changed_rollout_item_reports_new_item_snapshot`  (lines 3766–3805)

```
fn changed_rollout_item_reports_new_item_snapshot()
```

**Purpose**: Verifies that handling one rollout item with change tracking reports both the new item snapshot and the newly created turn metadata snapshot.

**Data flow**: Creates a builder, handles one user-message rollout item via the change-tracking API, and asserts the returned `ThreadHistoryChangeSet` contents.

**Call relations**: Exercises `collect_changes`, implicit turn creation, and item/turn change recording.

*Call graph*: calls 1 internal fn (new); 5 external calls (default, new, assert_eq!, UserMessage, EventMsg).


##### `tests::changed_rollout_item_reports_updated_existing_item_snapshot`  (lines 3808–3845)

```
fn changed_rollout_item_reports_updated_existing_item_snapshot()
```

**Purpose**: Checks that updating an existing item by id reports only the latest item snapshot in the per-item change set.

**Data flow**: Creates a web-search placeholder, then handles a web-search end event with change tracking; asserts the returned change set contains the updated search item only.

**Call relations**: Covers upsert behavior plus per-event change reporting.

*Call graph*: calls 1 internal fn (new); 4 external calls (assert_eq!, WebSearchBegin, WebSearchEnd, EventMsg).


##### `tests::changed_rollout_item_reports_streaming_item_mutation`  (lines 3848–3877)

```
fn changed_rollout_item_reports_streaming_item_mutation()
```

**Purpose**: Ensures in-place mutation of a reasoning item still emits a changed item snapshot.

**Data flow**: Creates a reasoning item, then handles raw-content append with change tracking; asserts the returned change set contains the mutated reasoning item.

**Call relations**: Validates explicit `record_changed_item` calls after mutating the last reasoning item.

*Call graph*: calls 1 internal fn (new); 4 external calls (assert_eq!, AgentReasoning, AgentReasoningRawContent, EventMsg).


##### `tests::changed_rollout_item_reports_turn_completion_metadata`  (lines 3880–3943)

```
fn changed_rollout_item_reports_turn_completion_metadata()
```

**Purpose**: Checks that turn-start and turn-complete events emit turn metadata snapshots with timing fields.

**Data flow**: Handles a turn-start event with change tracking, then a user message, then a turn-complete event with change tracking; asserts the returned change sets for start and completion.

**Call relations**: Exercises turn metadata recording for explicit lifecycle events.

*Call graph*: calls 1 internal fn (new); 7 external calls (default, new, assert_eq!, TurnComplete, TurnStarted, UserMessage, EventMsg).


##### `tests::changed_rollout_items_dedupe_updated_item_snapshots`  (lines 3946–3987)

```
fn changed_rollout_items_dedupe_updated_item_snapshots()
```

**Purpose**: Verifies batch change accumulation deduplicates multiple updates to the same item and keeps only the latest snapshot.

**Data flow**: Processes web-search begin and end in one batch via `handle_rollout_items_with_changes`; asserts the final change set contains one updated search item and one turn snapshot.

**Call relations**: Exercises `ThreadHistoryChangeAccumulator::push_item_change`.

*Call graph*: calls 1 internal fn (new); 4 external calls (assert_eq!, WebSearchBegin, WebSearchEnd, EventMsg).


##### `tests::changed_rollout_items_dedupe_turn_metadata_snapshots`  (lines 3990–4024)

```
fn changed_rollout_items_dedupe_turn_metadata_snapshots()
```

**Purpose**: Verifies batch accumulation deduplicates repeated turn metadata updates and keeps the latest turn snapshot.

**Data flow**: Processes turn start and turn complete in one batch; asserts the final change set contains only the completed turn metadata snapshot.

**Call relations**: Exercises `ThreadHistoryChangeAccumulator::push_turn_change`.

*Call graph*: calls 1 internal fn (new); 5 external calls (default, assert_eq!, TurnComplete, TurnStarted, EventMsg).


##### `tests::changed_rollout_items_drop_prior_changes_for_removed_turns`  (lines 4027–4058)

```
fn changed_rollout_items_drop_prior_changes_for_removed_turns()
```

**Purpose**: Ensures rollback within a batch removes previously accumulated item and turn changes for the rolled-back turn.

**Data flow**: Processes turn start, user message, and rollback in one batch; asserts the final change set contains only the removed turn id and no stale item/turn snapshots.

**Call relations**: Exercises `ThreadHistoryChangeAccumulator::push_removed_turn_id` and rollback-aware coalescing.

*Call graph*: calls 1 internal fn (new); 7 external calls (default, new, assert_eq!, ThreadRolledBack, TurnStarted, UserMessage, EventMsg).


### Rollout and metadata persistence
These files define what gets recorded, reconstruct persisted sessions, derive normalized metadata, and synchronize thread storage state across rollout files and databases.

### `app-server/src/request_processors/external_agent_session_import.rs`

`domain_logic` · `background import`

This file defines `ExternalAgentSessionImporter`, the specialized component used by external-agent config import to migrate session history into the thread store. It holds `codex_home`, a semaphore, `ThreadManager`, `ThreadStore`, `ConfigManager`, and `Arg0DispatchPaths`. Although `SESSION_IMPORT_CONCURRENCY` is 5 for per-session work, the importer also acquires a single semaphore permit before starting a batch, ensuring only one batch import runs at a time.

`import_sessions` is the batch entrypoint. It returns early for empty input, acquires the permit, then streams session imports with `buffer_unordered(SESSION_IMPORT_CONCURRENCY)`. Each completed import records success using source path and imported thread id; failures are converted into `record_import_error` entries tagged by stage. After all sessions finish, it writes a completed-import ledger under `codex_home` and records a `session_ledger_update` error if that bookkeeping fails.

Per session, `import_requested_session` first calls `prepare_session_import`, which runs `prepare_validated_session_import` inside `spawn_blocking` because validation/parsing is synchronous filesystem work. If preparation returns `None`, the session is skipped without error. Otherwise `persist_session` loads config with cwd and sandbox executable overrides, resolves the default model and model info, creates a fresh `ThreadId`, and constructs `CreateThreadParams` plus a rich `ThreadMetadataPatch`. It filters rollout items through `is_persisted_rollout_item`, normalizes the title, creates the thread, appends rollout items if any, updates metadata, persists the thread, and finally shuts it down. If appending rollout items fails after thread creation, it explicitly discards the thread to avoid leaving a partial import behind.

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

**Purpose**: Constructs the session importer with shared managers and a semaphore used to serialize batch imports.

**Data flow**: Takes `PathBuf codex_home`, `Arc<ThreadManager>`, `Arc<dyn ThreadStore>`, `ConfigManager`, and `Arg0DispatchPaths`; stores them in the struct and initializes `permits` as `Arc::new(Semaphore::new(1))`; returns `ExternalAgentSessionImporter`.

**Call relations**: Called by `ExternalAgentConfigRequestProcessor::new` when wiring migration support.

*Call graph*: called by 1 (new); 2 external calls (new, new).


##### `ExternalAgentSessionImporter::import_sessions`  (lines 63–118)

```
async fn import_sessions(
        &self,
        sessions: Vec<ExternalAgentSessionMigration>,
        mut item_result: ExternalAgentConfigImportItemResult,
    ) -> ExternalAgentConfigImportItemResul
```

**Purpose**: Imports a batch of external-agent sessions concurrently, records per-session successes/failures into the provided item result, and updates the completed-session ledger.

**Data flow**: Consumes a `Vec<ExternalAgentSessionMigration>` and mutable `ExternalAgentConfigImportItemResult`. If the session list is empty it returns immediately. Otherwise it acquires the batch semaphore permit; on permit failure it records a `session_permit` error and returns. It then creates a stream over sessions, clones `self` per item, asynchronously calls `import_requested_session`, and processes results as they complete with bounded concurrency. Successful imports record source-path/thread-id successes and are accumulated for ledger writing; `Ok(None)` is ignored; failures record stage-specific import errors. Finally it calls `record_completed_session_imports(&self.codex_home, completed_imports)` and records a `session_ledger_update` error if that fails, then returns the updated item result.

**Call relations**: Called from the background task spawned by external-agent config import. It delegates per-session work to `import_requested_session` and performs batch-level concurrency control and ledger bookkeeping.

*Call graph*: calls 2 internal fn (record_success, record_import_error); 4 external calls (new, record_completed_session_imports, pin_mut!, iter).


##### `ExternalAgentSessionImporter::import_requested_session`  (lines 120–149)

```
async fn import_requested_session(
        &self,
        session: ExternalAgentSessionMigration,
    ) -> Result<Option<CompletedExternalAgentSessionImport>, SessionImportFailure>
```

**Purpose**: Runs the full import pipeline for one requested session: prepare/validate it, persist it as a thread, and package the completion record.

**Data flow**: Consumes one `ExternalAgentSessionMigration`, clones its source path for error reporting, awaits `prepare_session_import`; preparation errors are wrapped into `SessionImportFailure` with stage `session_prepare`, `None` means skip without import, and a returned pending import is passed to `persist_session`. Persistence errors become `SessionImportFailure` with stage `session_persist`. On success it returns `Some(CompletedExternalAgentSessionImport)` containing source path, source content hash, and imported thread id.

**Call relations**: Used internally by `import_sessions` as the per-session async task body. It sequences the blocking preparation step before thread-store persistence.

*Call graph*: calls 2 internal fn (persist_session, prepare_session_import).


##### `ExternalAgentSessionImporter::prepare_session_import`  (lines 151–160)

```
async fn prepare_session_import(
        &self,
        session: ExternalAgentSessionMigration,
    ) -> Result<Option<PendingSessionImport>, String>
```

**Purpose**: Runs synchronous session validation and transformation on a blocking thread so the async runtime is not stalled by filesystem/parsing work.

**Data flow**: Consumes `ExternalAgentSessionMigration`, clones `self.codex_home`, spawns a blocking task that calls `prepare_validated_session_import(&codex_home, session)`, maps join failures into `external agent session preparation task failed: ...`, maps domain failures into `failed to prepare external agent session: ...`, and returns `Result<Option<PendingSessionImport>, String>`.

**Call relations**: Called by `import_requested_session` before any thread persistence. It isolates CPU/blocking validation from the async import loop.

*Call graph*: called by 1 (import_requested_session); 2 external calls (clone, spawn_blocking).


##### `ExternalAgentSessionImporter::persist_session`  (lines 162–279)

```
async fn persist_session(
        &self,
        session: ImportedExternalAgentSession,
    ) -> Result<ThreadId, String>
```

**Purpose**: Creates and persists a new Codex thread from an imported external-agent session, including config-derived defaults, metadata, rollout items, and final shutdown.

**Data flow**: Consumes `ImportedExternalAgentSession`, destructures cwd/title/first user message/rollout items, loads config with cwd and executable overrides via `self.config_manager.load_with_overrides`, resolves the default model and model info from the thread manager’s models manager, creates a new `ThreadId`, derives source, cwd, model provider, and memory mode from config, and builds `CreateThreadParams` with base instructions from either config or model defaults. It filters rollout items with `is_persisted_rollout_item`, normalizes the title, builds `ThreadMetadataPatch` including timestamps, source metadata, cwd, CLI version, preview, and memory mode, then calls `thread_store.create_thread`. If rollout items remain, it appends them; on append failure it discards the thread and returns an error. It then updates metadata, persists the thread, shuts it down, and returns the created `ThreadId` or a formatted error string from any failed step.

**Call relations**: Called by `import_requested_session` after preparation succeeds. It is the core persistence path, coordinating config resolution, model lookup, and thread-store operations.

*Call graph*: calls 2 internal fn (load_with_overrides, new); called by 1 (import_requested_session); 5 external calls (default, now, new, env!, format!).


### `app-server/src/request_processors/thread_resume_redaction.rs`

`domain_logic` · `thread resume response shaping for specific remote clients`

This file contains a narrowly scoped compatibility layer for `thread/resume`. Two constants define the replacement marker (`"[redacted]"`) and the exact remote client names that should trigger redaction (`codex_chatgpt_android_remote` and `codex_chatgpt_ios_remote`). `should_redact_thread_resume_payloads` is the gate: it checks the optional client name against that allowlist.

The main transformation is `redact_thread_resume_payloads`, which mutates a slice of `Turn` in place. It iterates through every turn and uses `retain_mut` on `turn.items` so it can both edit and remove items in one pass. `ThreadItem::McpToolCall` entries are preserved structurally but have `arguments` replaced with a JSON string marker, `result` replaced with a synthetic minimal `McpToolCallResult` if present, and `error.message` overwritten if an error exists. `ThreadItem::ImageGeneration` entries are dropped entirely, which avoids returning large base64 image payloads. All other item variants are left untouched. The helper `redacted_mcp_tool_call_result` constructs the canonical replacement result: a single text content block with no structured content or metadata. The tests verify both successful MCP results and MCP errors are rewritten exactly, while ordinary agent messages remain intact and image-generation items disappear.

#### Function details

##### `should_redact_thread_resume_payloads`  (lines 13–15)

```
fn should_redact_thread_resume_payloads(client_name: Option<&str>) -> bool
```

**Purpose**: Determines whether a `thread/resume` response should be redacted for the requesting client. It is a strict name-based compatibility check rather than a capability negotiation.

**Data flow**: Takes `Option<&str>` client name, returns `true` only when the option is `Some` and the contained name appears in `CHATGPT_REMOTE_CLIENT_NAMES`; otherwise returns `false`.

**Call relations**: Used by higher-level resume handling to decide whether to invoke payload redaction before sending the response.


##### `redact_thread_resume_payloads`  (lines 17–39)

```
fn redact_thread_resume_payloads(turns: &mut [Turn])
```

**Purpose**: Mutates resumed turns in place to remove or shrink large payload-bearing items. MCP tool calls are preserved but scrubbed; image-generation items are removed entirely.

**Data flow**: Accepts `&mut [Turn]`, loops over each turn, and applies `retain_mut` to `turn.items`. For `ThreadItem::McpToolCall`, it rewrites `arguments` to `JsonValue::String("[redacted]")`, replaces any existing `result` with `Some(Box::new(redacted_mcp_tool_call_result()))`, rewrites any `error.message`, and keeps the item. For `ThreadItem::ImageGeneration`, it returns `false` to drop the item. All other variants are retained unchanged.

**Call relations**: Called by resume-response code when `should_redact_thread_resume_payloads` is true. The tests in this file invoke it directly to verify exact mutation semantics.

*Call graph*: called by 2 (redacts_mcp_error_message, redacts_mcp_success_result_and_removes_image_generation).


##### `redacted_mcp_tool_call_result`  (lines 41–50)

```
fn redacted_mcp_tool_call_result() -> McpToolCallResult
```

**Purpose**: Builds the canonical replacement MCP result payload used during redaction. The replacement is intentionally minimal and text-only.

**Data flow**: Constructs and returns an `McpToolCallResult` whose `content` is a one-element vector containing a JSON object `{ "type": "text", "text": "[redacted]" }`, with `structured_content` and `meta` set to `None`.

**Call relations**: Used internally by `redact_thread_resume_payloads` and referenced by tests when asserting the exact redacted result shape.

*Call graph*: 1 external calls (vec!).


##### `tests::redacts_mcp_success_result_and_removes_image_generation`  (lines 67–130)

```
fn redacts_mcp_success_result_and_removes_image_generation()
```

**Purpose**: Verifies successful MCP tool calls are scrubbed and image-generation items are removed, while unrelated items remain unchanged. It asserts the exact post-redaction `ThreadItem` values.

**Data flow**: Builds a `Thread` fixture with an agent message, a completed `McpToolCall` containing arguments/result/metadata, and an `ImageGeneration` item; calls `redact_thread_resume_payloads(&mut thread.turns)`; then asserts the turn now contains only the agent message and a redacted MCP tool call.

**Call relations**: Test-harness coverage for the main redaction path, especially the combination of in-place mutation and item removal.

*Call graph*: calls 1 internal fn (redact_thread_resume_payloads); 3 external calls (test_thread, assert_eq!, vec!).


##### `tests::redacts_mcp_error_message`  (lines 133–168)

```
fn redacts_mcp_error_message()
```

**Purpose**: Checks that failed MCP tool calls have both arguments and error message redacted, even when no result payload exists. The item itself should remain in the turn.

**Data flow**: Creates a `Thread` containing one failed `ThreadItem::McpToolCall` with secret arguments and `McpToolCallError`, runs `redact_thread_resume_payloads`, and asserts the resulting item has redacted arguments and error message while preserving ids/status/duration.

**Call relations**: Complements the success-case test by covering the error-field rewrite branch.

*Call graph*: calls 1 internal fn (redact_thread_resume_payloads); 3 external calls (test_thread, assert_eq!, vec!).


##### `tests::test_thread`  (lines 170–202)

```
fn test_thread(items: Vec<ThreadItem>) -> Thread
```

**Purpose**: Constructs a minimal `Thread` fixture containing a single completed turn with caller-supplied items. It keeps all unrelated thread metadata stable across tests.

**Data flow**: Accepts `Vec<ThreadItem>`, wraps it in one `Turn` with `TurnItemsView::Full` and `TurnStatus::Completed`, and returns a `Thread` populated with fixed ids, preview, provider, cwd, source, and empty optional metadata.

**Call relations**: Shared fixture helper for the redaction tests so they can focus on item-level assertions.

*Call graph*: 2 external calls (test_path_buf, vec!).


### `app-server/src/request_processors/thread_summary.rs`

`domain_logic` · `thread listing, summary reconstruction, and thread metadata response building`

This file is the summary/adapter layer between persisted rollout or core snapshot data and app-server protocol responses. In test builds, `read_summary_from_rollout` reads the head of a rollout file, requires the first line to deserialize as `SessionMetaLine`, patches `SessionSource::SubAgent(ThreadSpawn)` with top-level `agent_nickname`/`agent_role` via `with_thread_spawn_agent_metadata`, computes `updated_at` from filesystem metadata, and then tries `extract_conversation_summary`. That helper scans the rollout head for the first parseable `ResponseItem` that core can interpret as a `TurnItem::UserMessage`, strips any `USER_MESSAGE_BEGIN` prefix, and uses it as the preview. If no user message exists, `read_summary_from_rollout` falls back to an empty preview while still preserving id, cwd, cli version, source, provider, and optional git info.

Outside tests, the file provides protocol adapters: `thread_response_active_permission_profile`, `thread_response_sandbox_policy`, `thread_settings_from_config_snapshot`, and `thread_settings_from_core_snapshot` convert core permission/config state into `ThreadSettings`. `thread_started_notification` intentionally clears `thread.turns` before emitting a `ThreadStartedNotification`, so startup notifications carry summary metadata rather than full history. In test builds, `summary_to_thread` reconstructs a lightweight `Thread` from `ConversationSummary`, parsing timestamps, normalizing cwd through `AbsolutePathBuf::relative_to_current_dir(path_utils::normalize_for_native_workdir(...))`, and falling back to a supplied cwd with a warning if normalization fails.

#### Function details

##### `read_summary_from_rollout`  (lines 9–81)

```
async fn read_summary_from_rollout(
    path: &Path,
    fallback_provider: &str,
) -> std::io::Result<ConversationSummary>
```

**Purpose**: Reads a rollout file header and produces a `ConversationSummary` suitable for thread listings. It prefers extracting a preview from the first user message but falls back to an empty preview when none is present.

**Data flow**: Accepts a rollout `&Path` and fallback provider string, reads the rollout head, errors if the file is empty or does not begin with `SessionMetaLine`, patches `session_meta.source` with `with_thread_spawn_agent_metadata`, computes `created_at` and `updated_at`, tries `extract_conversation_summary`, and otherwise returns a `ConversationSummary` built from session metadata plus fallback/default values.

**Call relations**: Used in tests and by summary-related code paths to validate rollout parsing behavior. It delegates preview extraction to `extract_conversation_summary`, timestamp fallback to `read_updated_at`, and source patching to `with_thread_spawn_agent_metadata`.

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

**Purpose**: Pulls the first meaningful user-message preview out of rollout head JSON and packages it with session metadata. It ignores non-user items and strips synthetic prompt prefixes.

**Data flow**: Takes the rollout path, a slice of JSON head values, `SessionMeta`, optional `CoreGitInfo`, fallback provider, and optional updated-at string. It deserializes head entries into `ResponseItem`, asks core to parse them into turn items, finds the first `TurnItem::UserMessage`, trims any `USER_MESSAGE_BEGIN` prefix from the message text, and returns `Some(ConversationSummary)`; if no user message is found, returns `None`.

**Call relations**: Called by `read_summary_from_rollout` as the preferred preview path. Its `None` result triggers the empty-preview fallback in the caller.

*Call graph*: called by 1 (read_summary_from_rollout); 1 external calls (iter).


##### `map_git_info`  (lines 133–139)

```
fn map_git_info(git_info: &CoreGitInfo) -> ConversationGitInfo
```

**Purpose**: Converts core git metadata into the app-server summary git shape. It preserves commit SHA, branch, and origin URL when present.

**Data flow**: Reads a `&CoreGitInfo` and returns `ConversationGitInfo` with `sha` extracted from `commit_hash`, plus cloned `branch` and `repository_url` as `origin_url`.

**Call relations**: Used by summary-building functions when optional git metadata is available.


##### `with_thread_spawn_agent_metadata`  (lines 141–170)

```
fn with_thread_spawn_agent_metadata(
    source: codex_protocol::protocol::SessionSource,
    agent_nickname: Option<String>,
    agent_role: Option<String>,
) -> codex_protocol::protocol::SessionSour
```

**Purpose**: Merges top-level agent nickname/role fields into a `SessionSource::SubAgent(ThreadSpawn)` source when those fields are missing there. Non-thread-spawn sources are left untouched.

**Data flow**: Accepts a core `SessionSource` plus optional nickname and role. If both options are `None`, it returns the original source immediately. Otherwise, when the source is `SubAgent(ThreadSpawn { ... })`, it rebuilds that variant using the provided nickname/role if present, falling back to existing embedded values; all other source variants are returned unchanged.

**Call relations**: Called by `read_summary_from_rollout` before summary extraction so downstream conversions can recover agent metadata from older or split metadata layouts.

*Call graph*: called by 1 (read_summary_from_rollout); 1 external calls (SubAgent).


##### `thread_response_active_permission_profile`  (lines 172–176)

```
fn thread_response_active_permission_profile(
    active_permission_profile: Option<codex_protocol::models::ActivePermissionProfile>,
) -> Option<codex_app_server_protocol::ActivePermissionProfile>
```

**Purpose**: Maps an optional core active permission profile into the app-server protocol equivalent. It is a thin `Into` adapter.

**Data flow**: Takes `Option<codex_protocol::models::ActivePermissionProfile>` and returns `Option<codex_app_server_protocol::ActivePermissionProfile>` by applying `Into::into` when present.

**Call relations**: Used by both thread-settings conversion functions so permission-profile details are exposed consistently in API responses.

*Call graph*: called by 2 (thread_settings_from_config_snapshot, thread_settings_from_core_snapshot).


##### `thread_response_sandbox_policy`  (lines 178–187)

```
fn thread_response_sandbox_policy(
    permission_profile: &codex_protocol::models::PermissionProfile,
    cwd: &Path,
) -> codex_app_server_protocol::SandboxPolicy
```

**Purpose**: Derives the API-visible sandbox policy from a permission profile and cwd. It uses the compatibility sandbox-policy computation shared with core sandboxing logic.

**Data flow**: Accepts a core `PermissionProfile` and cwd `&Path`, computes a compatibility sandbox policy with `codex_sandboxing::compatibility_sandbox_policy_for_permission_profile`, and converts the result into `codex_app_server_protocol::SandboxPolicy`.

**Call relations**: Called by both thread-settings conversion functions to keep sandbox-policy rendering aligned with permission-profile semantics.

*Call graph*: called by 2 (thread_settings_from_config_snapshot, thread_settings_from_core_snapshot); 1 external calls (compatibility_sandbox_policy_for_permission_profile).


##### `thread_settings_from_config_snapshot`  (lines 189–211)

```
fn thread_settings_from_config_snapshot(
    config_snapshot: &ThreadConfigSnapshot,
) -> ThreadSettings
```

**Purpose**: Builds API `ThreadSettings` from the server's richer `ThreadConfigSnapshot`. It exposes cwd, approval settings, sandbox state, model selection, reasoning settings, collaboration mode, and personality.

**Data flow**: Reads fields from `&ThreadConfigSnapshot`, computes `sandbox_policy` from `permission_profile` and `cwd()`, converts `approval_policy`, `approvals_reviewer`, and optional active permission profile, then returns a populated `ThreadSettings` struct.

**Call relations**: Used when the app server already has a `ThreadConfigSnapshot` and needs to serialize current settings for clients.

*Call graph*: calls 3 internal fn (thread_response_active_permission_profile, thread_response_sandbox_policy, cwd).


##### `thread_settings_from_core_snapshot`  (lines 213–247)

```
fn thread_settings_from_core_snapshot(
    snapshot: codex_protocol::protocol::ThreadSettingsSnapshot,
) -> ThreadSettings
```

**Purpose**: Builds API `ThreadSettings` from a core `ThreadSettingsSnapshot` value. It performs the same mapping as the config-snapshot path but starts from an owned core snapshot struct.

**Data flow**: Destructures `codex_protocol::protocol::ThreadSettingsSnapshot`, computes sandbox policy from the embedded permission profile and cwd, converts approval and active-permission fields, and returns `ThreadSettings` with the remaining fields moved through.

**Call relations**: Parallel adapter to `thread_settings_from_config_snapshot`, used when settings arrive from core rather than server-side config state.

*Call graph*: calls 2 internal fn (thread_response_active_permission_profile, thread_response_sandbox_policy).


##### `parse_datetime`  (lines 250–256)

```
fn parse_datetime(timestamp: Option<&str>) -> Option<DateTime<Utc>>
```

**Purpose**: Parses an optional RFC3339 timestamp string into `DateTime<Utc>`. Invalid or absent timestamps become `None` rather than errors.

**Data flow**: Accepts `Option<&str>`, attempts `chrono::DateTime::parse_from_rfc3339` when present, converts successful parses to UTC, and returns `Option<DateTime<Utc>>`.

**Call relations**: Used by `summary_to_thread` to convert summary timestamps into integer epoch seconds for API `Thread` fields.

*Call graph*: called by 1 (summary_to_thread).


##### `read_updated_at`  (lines 259–269)

```
async fn read_updated_at(path: &Path, created_at: Option<&str>) -> Option<String>
```

**Purpose**: Computes a summary `updated_at` timestamp from file metadata, falling back to the created-at string when metadata is unavailable. It formats filesystem modification time with millisecond precision.

**Data flow**: Takes a rollout `&Path` and optional created-at string, asynchronously reads file metadata, extracts modification time if possible, converts it to `DateTime<Utc>` and RFC3339 millis, and otherwise returns `created_at.map(str::to_string)`.

**Call relations**: Called by `read_summary_from_rollout` so summaries can reflect file modification time even when the rollout header lacks a distinct updated timestamp.

*Call graph*: called by 1 (read_summary_from_rollout); 1 external calls (metadata).


##### `thread_started_notification`  (lines 271–274)

```
fn thread_started_notification(mut thread: Thread) -> ThreadStartedNotification
```

**Purpose**: Builds a `ThreadStartedNotification` from a `Thread` while intentionally stripping any loaded turns. This keeps startup notifications lightweight and summary-oriented.

**Data flow**: Takes ownership of a `Thread`, clears `thread.turns`, and returns `ThreadStartedNotification { thread }`.

**Call relations**: Used by thread-start flows such as detached review creation before broadcasting a new thread to clients.


##### `summary_to_thread`  (lines 277–335)

```
fn summary_to_thread(
    summary: ConversationSummary,
    fallback_cwd: &AbsolutePathBuf,
) -> Thread
```

**Purpose**: Converts a lightweight `ConversationSummary` back into an API `Thread` shell for tests and summary-driven flows. It normalizes cwd, parses timestamps, and derives agent metadata from `SessionSource`.

**Data flow**: Consumes `ConversationSummary` plus a fallback `AbsolutePathBuf`, parses `timestamp` and `updated_at` with `parse_datetime`, maps optional git info into `ApiGitInfo`, normalizes `cwd` through `path_utils::normalize_for_native_workdir` and `AbsolutePathBuf::relative_to_current_dir` with warning-and-fallback on failure, then returns a `Thread` with `NotLoaded` status, empty turns, epoch-second timestamps, and nickname/role extracted from `source`.

**Call relations**: Used in tests and summary-based thread reconstruction paths. It depends on `parse_datetime` for timestamp conversion and on cwd normalization to produce an absolute API cwd.

*Call graph*: calls 2 internal fn (parse_datetime, relative_to_current_dir); 2 external calls (new, normalize_for_native_workdir).


### `core/src/session/rollout_reconstruction.rs`

`domain_logic` · `session resume/fork reconstruction`

This file implements the replay algorithm behind `Session::reconstruct_history_from_rollout`, which derives both the concrete `Vec<ResponseItem>` history and the metadata needed to resume or fork a conversation: `PreviousTurnSettings`, an optional `TurnContextItem` baseline, and a `window_id`. The code introduces two internal state carriers. `TurnReferenceContextItem` distinguishes three cases that matter during replay: no baseline ever observed, a baseline explicitly invalidated by compaction, or the latest surviving `TurnContextItem`. `ActiveReplaySegment` accumulates reverse-scanned facts for one logical turn segment, including turn identity, whether it should count as a user turn for rollback semantics, any turn settings, any replacement-history checkpoint, and compaction/window metadata.

The main algorithm scans `rollout_items` newest-to-oldest. It groups items into segments bounded by `EventMsg::TurnStarted`, tracks `ThreadRolledBack` as “skip the next N finalized user-turn segments,” and captures the newest surviving replacement-history checkpoint plus the newest surviving resume metadata. Once those are known, it stops scanning older items and replays only the surviving suffix forward through `ContextManager` to reconstruct exact history semantics. Forward replay applies `ResponseItem`s, converts `InterAgentCommunication` into model-input items, honors rollback events, and handles compaction either by replacing history from `replacement_history` or, for legacy compactions without it, rebuilding a compacted history from collected user messages. A notable invariant is that legacy compaction forces `reference_context_item` to `None`, because the reconstructed prompt shape cannot guarantee a valid persisted baseline insertion point.

#### Function details

##### `turn_ids_are_compatible`  (lines 40–43)

```
fn turn_ids_are_compatible(active_turn_id: Option<&str>, item_turn_id: Option<&str>) -> bool
```

**Purpose**: Checks whether a turn id already associated with the active reverse-replay segment can coexist with a turn id found on the current rollout item. It treats missing ids on either side as compatible and only rejects explicit mismatches.

**Data flow**: It reads `active_turn_id: Option<&str>` and `item_turn_id: Option<&str>`, applies nested `Option::is_none_or` checks, and returns a `bool`. No external state is read or mutated.

**Call relations**: This helper is used inside `Session::reconstruct_history_from_rollout` when reverse replay tries to attach `TurnContext` or `TurnStarted` items to the current `ActiveReplaySegment`. It lets the caller keep segment assembly permissive for partially annotated rollout items while still preventing metadata from crossing explicit turn boundaries.

*Call graph*: called by 1 (reconstruct_history_from_rollout).


##### `finalize_active_segment`  (lines 45–91)

```
fn finalize_active_segment(
    active_segment: ActiveReplaySegment<'a>,
    base_replacement_history: &mut Option<&'a [ResponseItem]>,
    previous_turn_settings: &mut Option<PreviousTurnSettings>,
```

**Purpose**: Commits one completed reverse-replay segment into the aggregate reconstruction state, applying rollback skipping rules and capturing the newest surviving metadata only once. It is the point where a buffered segment becomes eligible to contribute replacement history, previous-turn settings, reference context, and window id.

**Data flow**: It consumes an `ActiveReplaySegment` plus mutable references to the reconstruction accumulators: `base_replacement_history`, `previous_turn_settings`, `reference_context_item`, `window_id`, and `pending_rollback_turns`. If rollback turns are pending and the segment counts as a user turn, it decrements the counter and returns without writing metadata. Otherwise it conditionally writes the segment’s replacement-history slice into `base_replacement_history` if none is set yet, copies `window_id` if still unset, copies `previous_turn_settings` only from a surviving user turn, and installs `reference_context_item` only if the aggregate is still `NeverSet` and the segment either represents a user turn or an explicit baseline clear. It returns `()` and mutates only the passed-in accumulators.

**Call relations**: Only `Session::reconstruct_history_from_rollout` invokes this function, both when reverse replay reaches a matching `TurnStarted` boundary and once more after the loop to flush any unfinished trailing segment. It centralizes the “newest surviving segment wins” policy so the caller can focus on scanning and boundary detection.

*Call graph*: called by 1 (reconstruct_history_from_rollout); 1 external calls (matches!).


##### `Session::reconstruct_history_from_rollout`  (lines 94–335)

```
async fn reconstruct_history_from_rollout(
        &self,
        turn_context: &TurnContext,
        rollout_items: &[RolloutItem],
    ) -> RolloutReconstruction
```

**Purpose**: Reconstructs the effective session history and hydration metadata from a slice of `RolloutItem`s by combining a reverse metadata scan with a forward history replay. It returns a `RolloutReconstruction` containing the rebuilt `history`, `previous_turn_settings`, `reference_context_item`, and a resolved `window_id`.

**Data flow**: Inputs are `&self`, `turn_context: &TurnContext`, and `rollout_items: &[RolloutItem]`. It initializes aggregate state for replacement-history base, previous-turn settings, reference context, window id, rollback count, surviving suffix, and an optional `ActiveReplaySegment`. In the reverse pass, it inspects each `RolloutItem`: `Compacted` may set segment `window_id`, mark baseline clearing, and capture `replacement_history`; `ThreadRolledBack` increments pending rollback turns with saturating conversion from `num_turns`; `TurnComplete` and `TurnAborted` seed segment turn ids; `UserMessage`, `ResponseItem` via `is_user_turn_boundary`, and `InterAgentCommunication` mark segments as user turns; `TurnContext` may attach `PreviousTurnSettings` and a `TurnContextItem` baseline if turn ids are compatible; `TurnStarted` finalizes the segment when it matches. Once it has a surviving replacement-history checkpoint plus both resume metadata values, it breaks early. After flushing any remaining segment, it computes a fallback `window_id` from the count of `Compacted` items. It then creates a `ContextManager`, optionally seeds it with the replacement-history base, and replays `rollout_suffix` forward: `ResponseItem`s are recorded with `turn_context.truncation_policy`, `InterAgentCommunication` is converted to a model input item and recorded, `Compacted(Some(replacement_history))` replaces history directly, `Compacted(None)` triggers legacy rebuilding through `compact::collect_user_messages` and `compact::build_compacted_history`, and `ThreadRolledBack` drops the last N user turns. Finally it normalizes `TurnReferenceContextItem` into `Option<TurnContextItem>`, clears it if legacy compaction was encountered, and returns `RolloutReconstruction` with `history.raw_items().to_vec()` and `window_id.unwrap_or(fallback_window_id)`.

**Call relations**: This is the file’s orchestrating method and the only caller of both `turn_ids_are_compatible` and `finalize_active_segment`. During reverse replay it delegates turn-boundary classification to `is_user_turn_boundary`, segment compatibility checks to `turn_ids_are_compatible`, and segment commitment to `finalize_active_segment`; during forward replay it delegates history storage to `ContextManager::new`, `record_items`, `replace`, and `drop_last_n_user_turns`, and uses compaction helpers when replay encounters legacy compaction without embedded replacement history.

*Call graph*: calls 5 internal fn (build_compacted_history, collect_user_messages, new, finalize_active_segment, turn_ids_are_compatible); 10 external calls (new, default, new, Latest, is_user_turn_boundary, matches!, iter, once, try_from, try_from).


### `core/src/session_rollout_init_error.rs`

`util` · `startup / session initialization failure handling`

This file translates initialization failures during session rollout into clearer fatal errors. `map_session_init_error` walks the full `anyhow::Error` chain, extracts any embedded `std::io::Error` values, and asks `map_rollout_io_error` whether one of them corresponds to a known session-storage problem under the configured Codex home directory. If any cause maps successfully, that specialized `CodexErr` is returned immediately; otherwise the function falls back to a generic `CodexErr::Fatal` containing the formatted original error chain.

`map_rollout_io_error` focuses specifically on the sessions storage directory, computed as `codex_home.join(SESSIONS_SUBDIR)`. It pattern matches `io_err.kind()` and produces tailored remediation text for `PermissionDenied`, `NotFound`, `AlreadyExists`, `InvalidData`/`InvalidInput`, and directory-type mismatches (`IsADirectory`/`NotADirectory`). The permission-denied case is especially concrete, suggesting `sudo chown -R $(whoami)` when sessions were created with sudo. Unknown I/O kinds return `None`, allowing the caller to continue searching or fall back to the generic message. The design keeps rollout startup failures actionable without overfitting every possible error source.

#### Function details

##### `map_session_init_error`  (lines 7–17)

```
fn map_session_init_error(err: &anyhow::Error, codex_home: &Path) -> CodexErr
```

**Purpose**: Searches an initialization error chain for a recognizable rollout/session-storage I/O failure and converts it into a specialized fatal `CodexErr`. If no known I/O cause is found, it emits a generic fatal initialization error.

**Data flow**: It takes `&anyhow::Error` and `&Path` for `codex_home`, iterates `err.chain()`, downcasts causes to `std::io::Error`, passes each to `map_rollout_io_error`, and returns the first mapped `CodexErr` found. If none match, it returns `CodexErr::Fatal(format!("Failed to initialize session: {err:#}"))`.

**Call relations**: Used by session-startup code when initialization fails. It delegates the actual I/O-kind-specific hint generation to `map_rollout_io_error`.

*Call graph*: 3 external calls (chain, format!, Fatal).


##### `map_rollout_io_error`  (lines 19–49)

```
fn map_rollout_io_error(io_err: &std::io::Error, codex_home: &Path) -> Option<CodexErr>
```

**Purpose**: Converts specific `std::io::ErrorKind` values related to the sessions directory into actionable fatal errors. Unknown kinds are intentionally left unmapped.

**Data flow**: It takes a `&std::io::Error` and `codex_home: &Path`, computes `sessions_dir = codex_home.join(SESSIONS_SUBDIR)`, matches on `io_err.kind()`, builds a human-readable hint string for known kinds, and wraps it in `Some(CodexErr::Fatal(format!("{hint} (underlying error: {io_err})")))`. For unrecognized kinds it returns `None`.

**Call relations**: Called from `map_session_init_error` for each I/O error found in the error chain. It encapsulates the rollout-specific filesystem diagnostics.

*Call graph*: 4 external calls (join, kind, format!, Fatal).


### `external-agent-sessions/src/export.rs`

`domain_logic` · `session import preparation`

This file is the bridge from parsed external-agent records to Codex protocol objects. `load_session_for_import_with_content_sha256` reads a session through `records::read_session_import`, requires a discovered `cwd`, derives `first_user_message` by summarizing the first user text, chooses a title by preferring source-provided titles over that fallback, and converts the parsed `ConversationMessage` list into `Vec<RolloutItem>`. If there is no cwd or no rollout content, it returns `None` rather than an empty import.

The core conversion happens in `rollout_items_from_messages`. It walks messages in order, opening a new synthetic turn on each user message with IDs like `external-import-turn-1`. For each user message it emits both a visible `UserMessage` event and a `ResponseItem::Message` copy; assistant messages similarly produce visible `AgentMessage` events plus response items, but only if a user turn is already active. This means assistant-only prefixes are ignored. Byte counts from both user and assistant response items are accumulated and converted to approximate token counts using `approx_tokens_from_byte_count_i64`; at the end of the final open turn the function appends a special `<EXTERNAL SESSION IMPORTED>` agent message, a `TokenCount` event, and a `TurnComplete` event whose `last_agent_message` is intentionally left `None`.

Tests verify visible turn reconstruction, marker placement, title loading, duplication into response items and visible events, and token usage emission.

#### Function details

##### `load_session_for_import`  (lines 24–29)

```
fn load_session_for_import(path: &Path) -> io::Result<Option<ImportedExternalAgentSession>>
```

**Purpose**: Test-only wrapper that loads an importable session while discarding the content hash.

**Data flow**: It takes a session path, calls `load_session_for_import_with_content_sha256`, maps `Some((session, hash))` to `Some(session)`, and returns `io::Result<Option<ImportedExternalAgentSession>>`.

**Call relations**: This helper is only compiled for tests and is the entry used by all export tests so they can focus on rollout structure without asserting on hashes.

*Call graph*: calls 1 internal fn (load_session_for_import_with_content_sha256); called by 7 (adds_import_marker_without_copying_last_agent_message, builds_visible_turns_for_imported_history, emits_token_usage_for_imported_history, loads_ai_title_for_imported_session, loads_custom_title_for_imported_session, loads_custom_title_over_later_ai_title_for_imported_session, stores_imported_messages_as_response_items_and_visible_events).


##### `load_session_for_import_with_content_sha256`  (lines 31–57)

```
fn load_session_for_import_with_content_sha256(
    path: &Path,
) -> io::Result<Option<(ImportedExternalAgentSession, String)>>
```

**Purpose**: Reads a session file, validates that it has a cwd and importable messages, derives title metadata, and returns both the import payload and the source content hash.

**Data flow**: Its input is a session file path. It calls `read_session_import` to obtain parsed cwd, source title, messages, and SHA-256; if cwd is missing it returns `Ok(None)`. It finds the first user message to compute a summarized fallback label, chooses `title` as source title or that fallback, converts messages with `rollout_items_from_messages`, rejects empty rollout output, and returns `Some((ImportedExternalAgentSession { cwd, title, first_user_message, rollout_items }, content_sha256))`.

**Call relations**: This is the production loader used by `lib.rs` during validated import preparation, and by the test-only `load_session_for_import` wrapper. It delegates parsing to `read_session_import` and protocol conversion to `rollout_items_from_messages`.

*Call graph*: calls 2 internal fn (rollout_items_from_messages, read_session_import); called by 2 (load_session_for_import, load_importable_session).


##### `rollout_items_from_messages`  (lines 59–121)

```
fn rollout_items_from_messages(messages: Vec<ConversationMessage>) -> Vec<RolloutItem>
```

**Purpose**: Converts ordered conversation messages into Codex rollout items with synthetic turns, visible message events, response-item history, an import marker, token usage, and turn completion events.

**Data flow**: It consumes `Vec<ConversationMessage>`. As it iterates, user messages close any prior open turn, increment a turn counter, create a new turn ID, emit `TurnStarted`, `UserMessage`, and a user `ResponseItem`, and add the message byte count to a running total. Assistant messages are ignored until a user turn exists; once inside a turn they add byte count, update `last_model_visible_tokens` via `approx_tokens_from_byte_count_i64`, emit `AgentMessage`, and append an assistant `ResponseItem`. After the loop, if a turn remains open, it appends the external-session marker item, a token-count item using the last computed token estimate, and a final `TurnComplete` using the last message timestamp as `completed_at`. It returns the assembled `Vec<RolloutItem>`.

**Call relations**: Called only by `load_session_for_import_with_content_sha256`. It delegates construction of specific protocol fragments to `response_item`, `message_byte_count`, `external_session_imported_marker_item`, `token_count_item`, and `turn_complete_item`.

*Call graph*: calls 5 internal fn (external_session_imported_marker_item, message_byte_count, response_item, token_count_item, turn_complete_item); called by 1 (load_session_for_import_with_content_sha256); 9 external calls (default, new, approx_tokens_from_byte_count_i64, format!, AgentMessage, TurnStarted, UserMessage, EventMsg, ResponseItem).


##### `external_session_imported_marker_item`  (lines 123–129)

```
fn external_session_imported_marker_item() -> RolloutItem
```

**Purpose**: Builds the synthetic agent-message event that marks the boundary where imported history ends.

**Data flow**: It creates a `RolloutItem::EventMsg(EventMsg::AgentMessage(...))` whose message text is the constant `<EXTERNAL SESSION IMPORTED>` and whose optional fields are `None`.

**Call relations**: Used at the end of the final open turn by `rollout_items_from_messages` so imported history is visibly annotated in reconstructed threads.

*Call graph*: called by 1 (rollout_items_from_messages); 2 external calls (AgentMessage, EventMsg).


##### `response_item`  (lines 131–146)

```
fn response_item(message: ConversationMessage) -> ResponseItem
```

**Purpose**: Converts one conversation message into a protocol `ResponseItem::Message` with role-specific content type.

**Data flow**: It consumes a `ConversationMessage`, maps assistant text to `ContentItem::OutputText` and user text to `ContentItem::InputText`, sets the string role to `assistant` or `user`, wraps the content in a one-element vector, and returns the resulting `ResponseItem`.

**Call relations**: Called from `rollout_items_from_messages` for both user and assistant messages so imported history exists not only as visible events but also as response items.

*Call graph*: called by 1 (rollout_items_from_messages); 1 external calls (vec!).


##### `message_byte_count`  (lines 148–150)

```
fn message_byte_count(message: &ConversationMessage) -> i64
```

**Purpose**: Computes a saturating byte-count approximation for a message's text length.

**Data flow**: It reads `message.text.len()`, attempts to convert the `usize` length to `i64`, and returns the converted value or `i64::MAX` if conversion overflows.

**Call relations**: Used by `rollout_items_from_messages` to accumulate approximate visible output size before converting that total into token counts.

*Call graph*: called by 1 (rollout_items_from_messages); 1 external calls (try_from).


##### `token_count_item`  (lines 152–165)

```
fn token_count_item(last_model_visible_tokens: i64) -> RolloutItem
```

**Purpose**: Creates a token-usage event from the final approximate visible-token count.

**Data flow**: It takes `last_model_visible_tokens`, fills a `TokenUsage` with that value as `total_tokens`, clones it into both `total_token_usage` and `last_token_usage` inside `TokenUsageInfo`, wraps that in `TokenCountEvent`, and returns it as `RolloutItem::EventMsg(EventMsg::TokenCount(...))`.

**Call relations**: Appended by `rollout_items_from_messages` just before the final turn completion so imported history carries token accounting metadata.

*Call graph*: called by 1 (rollout_items_from_messages); 3 external calls (TokenCount, EventMsg, default).


##### `turn_complete_item`  (lines 167–175)

```
fn turn_complete_item(turn_id: String, completed_at: Option<i64>) -> RolloutItem
```

**Purpose**: Builds a `TurnComplete` event for a synthetic imported turn.

**Data flow**: It takes a `turn_id` and optional completion timestamp, fills a `TurnCompleteEvent` with `last_agent_message`, `duration_ms`, and `time_to_first_token_ms` all unset, and returns it wrapped as a rollout event.

**Call relations**: Used by `rollout_items_from_messages` both when closing a previous turn on a new user message and when finalizing the last turn after adding the import marker and token count.

*Call graph*: called by 1 (rollout_items_from_messages); 2 external calls (TurnComplete, EventMsg).


##### `tests::builds_visible_turns_for_imported_history`  (lines 187–219)

```
fn builds_visible_turns_for_imported_history()
```

**Purpose**: Verifies that imported rollout items reconstruct into visible turns with the import marker attached to the final turn.

**Data flow**: It writes a three-message session, loads it with `load_session_for_import`, converts rollout items into thread turns via `build_turns_from_rollout_items`, and asserts the number of turns, item counts, and exact marker placement.

**Call relations**: This test drives the full parse-and-export path through the test wrapper and then through an external turn builder to validate visible semantics.

*Call graph*: calls 1 internal fn (load_session_for_import); 7 external calls (new, assert_eq!, build_turns_from_rollout_items, jsonl, record, create_dir_all, write).


##### `tests::adds_import_marker_without_copying_last_agent_message`  (lines 222–263)

```
fn adds_import_marker_without_copying_last_agent_message()
```

**Purpose**: Checks that the synthetic import marker is appended as a visible agent message while `TurnComplete.last_agent_message` remains unset.

**Data flow**: It writes a one-turn user/assistant session, loads it, reconstructs visible turns, asserts the marker is the last visible item, then scans rollout items in reverse to find the final `TurnComplete` and asserts its `last_agent_message` is `None`.

**Call relations**: This test specifically validates the design choice encoded by `external_session_imported_marker_item` plus `turn_complete_item` usage in `rollout_items_from_messages`.

*Call graph*: calls 1 internal fn (load_session_for_import); 7 external calls (new, assert_eq!, build_turns_from_rollout_items, jsonl, record, create_dir_all, write).


##### `tests::stores_imported_messages_as_response_items_and_visible_events`  (lines 266–307)

```
fn stores_imported_messages_as_response_items_and_visible_events()
```

**Purpose**: Ensures imported messages are represented twice: once as visible events and once as response-item messages.

**Data flow**: It writes a session with large request and answer strings, loads it, counts rollout items matching `ResponseItem::Message`, separately counts visible `UserMessage` and `AgentMessage` events carrying the same texts, and asserts both counts are two.

**Call relations**: This test exercises the dual-emission behavior of `rollout_items_from_messages`, especially its calls to `response_item` alongside visible event creation.

*Call graph*: calls 1 internal fn (load_session_for_import); 6 external calls (new, assert_eq!, jsonl, record, create_dir_all, write).


##### `tests::loads_custom_title_for_imported_session`  (lines 310–329)

```
fn loads_custom_title_for_imported_session()
```

**Purpose**: Verifies that a custom title from the source session becomes the imported session title.

**Data flow**: It writes a session with a user message and a `custom-title` record, loads it, and asserts `imported.title` equals `named by source app`.

**Call relations**: This test reaches `load_session_for_import`, which in turn relies on `read_session_import` and title selection logic in `load_session_for_import_with_content_sha256`.

*Call graph*: calls 1 internal fn (load_session_for_import); 7 external calls (new, assert_eq!, custom_title_record, jsonl, record, create_dir_all, write).


##### `tests::loads_ai_title_for_imported_session`  (lines 332–351)

```
fn loads_ai_title_for_imported_session()
```

**Purpose**: Verifies that an AI-generated title is loaded when present.

**Data flow**: It writes a session with a user message and an `ai-title` record, loads it, and asserts the imported title matches the AI title.

**Call relations**: This test validates the source-title path in `load_session_for_import_with_content_sha256` using the test wrapper.

*Call graph*: calls 1 internal fn (load_session_for_import); 7 external calls (new, assert_eq!, ai_title_record, jsonl, record, create_dir_all, write).


##### `tests::loads_custom_title_over_later_ai_title_for_imported_session`  (lines 354–374)

```
fn loads_custom_title_over_later_ai_title_for_imported_session()
```

**Purpose**: Checks that custom titles outrank AI titles even when the AI title appears later.

**Data flow**: It writes a session containing both title record types, loads it, and asserts the imported title is the custom one.

**Call relations**: This test confirms the precedence already established by parsing and preserved by `load_session_for_import_with_content_sha256`.

*Call graph*: calls 1 internal fn (load_session_for_import); 8 external calls (new, assert_eq!, ai_title_record, custom_title_record, jsonl, record, create_dir_all, write).


##### `tests::emits_token_usage_for_imported_history`  (lines 377–406)

```
fn emits_token_usage_for_imported_history()
```

**Purpose**: Confirms that imported rollout items include a token-count event with nonzero usage and matching total/last usage values.

**Data flow**: It writes a multi-message session, loads it, scans rollout items for the first `TokenCount` event, extracts its `TokenUsageInfo`, and asserts `last_token_usage.total_tokens > 0` and equality between total and last usage.

**Call relations**: This test directly validates the `token_count_item` appended by `rollout_items_from_messages`.

*Call graph*: calls 1 internal fn (load_session_for_import); 7 external calls (new, assert!, assert_eq!, jsonl, record, create_dir_all, write).


##### `tests::record`  (lines 408–416)

```
fn record(role: &str, text: &str, cwd: &Path) -> JsonValue
```

**Purpose**: Creates a standard message record fixture for export tests.

**Data flow**: It takes role, text, and cwd, generates a current RFC3339 timestamp, and returns a JSON object with `type`, `cwd`, `timestamp`, and nested `message.content`.

**Call relations**: Used by all export tests to build session JSONL fixtures consumed by `load_session_for_import`.

*Call graph*: 2 external calls (now, json!).


##### `tests::custom_title_record`  (lines 418–423)

```
fn custom_title_record(title: &str) -> JsonValue
```

**Purpose**: Creates a custom-title JSON fixture record.

**Data flow**: It wraps the provided title into a JSON object with `type: "custom-title"` and `customTitle`.

**Call relations**: Used by title-loading tests to influence the parsed source title.

*Call graph*: 1 external calls (json!).


##### `tests::ai_title_record`  (lines 425–430)

```
fn ai_title_record(title: &str) -> JsonValue
```

**Purpose**: Creates an AI-title JSON fixture record.

**Data flow**: It wraps the provided title into a JSON object with `type: "ai-title"` and `aiTitle`.

**Call relations**: Used by AI-title and precedence tests that exercise the import loader.

*Call graph*: 1 external calls (json!).


##### `tests::jsonl`  (lines 432–438)

```
fn jsonl(records: &[JsonValue]) -> String
```

**Purpose**: Serializes fixture records into newline-delimited JSON text.

**Data flow**: It iterates the input `JsonValue` slice, stringifies each value, joins them with newlines, and returns the resulting `String`.

**Call relations**: Used by all export tests when writing session fixture files to disk.

*Call graph*: 1 external calls (iter).


### `rollout/src/policy.rs`

`domain_logic` · `cross-cutting during rollout recording and memory extraction`

This file is a pure policy table over protocol enums. `is_persisted_rollout_item` is the top-level classifier for rollout recording: `InterAgentCommunication`, `Compacted`, `TurnContext`, and `SessionMeta` are always kept; `ResponseItem` and `EventMsg` are delegated to narrower variant filters. `persisted_rollout_items` applies that predicate to a slice and clones only the allowed items, producing the canonical append set for live recording.

The response-item policy is intentionally asymmetric. `should_persist_response_item` keeps user/assistant messages, reasoning, shell/function/tool calls and outputs, web/image generation calls, and compaction records, but drops `CompactionTrigger` and `Other`. `should_persist_response_item_for_memories` is stricter: it excludes developer-role messages and omits agent-only or internal reasoning/compaction/image-generation variants, while still preserving tool invocation/output items that matter for memory formation.

`should_persist_event_msg` is the largest decision table. It keeps user-visible conversational and lifecycle events such as user/agent messages, reasoning text, token counts, thread-goal updates, review-mode transitions, turn start/complete/abort, rollback, web/image completion, and sub-agent activity. It also preserves `ItemCompleted` only for `TurnItem::Plan` and `TurnItem::Sleep`, because those have no equivalent raw `ResponseItem`. In contrast, low-level streaming deltas, begin/end plumbing for many tools, warnings, moderation metadata, realtime signaling, approval requests, and other transient operational events are explicitly excluded to avoid bloating rollouts with replay-irrelevant noise.

#### Function details

##### `is_persisted_rollout_item`  (lines 6–16)

```
fn is_persisted_rollout_item(item: &RolloutItem) -> bool
```

**Purpose**: Classifies a top-level `RolloutItem` as persisted or discarded for rollout files. It delegates variant-specific decisions for response items and event messages while hard-coding always-persisted structural items.

**Data flow**: Reads a borrowed `RolloutItem`; pattern-matches its enum variant; for `ResponseItem` calls `should_persist_response_item`, for `EventMsg` calls `should_persist_event_msg`, and for structural variants returns `true`; produces a boolean decision without side effects.

**Call relations**: Used by `persisted_rollout_items` as the per-item filter. It is the single entry point for rollout persistence policy at the `RolloutItem` level.

*Call graph*: calls 2 internal fn (should_persist_event_msg, should_persist_response_item); called by 1 (persisted_rollout_items).


##### `persisted_rollout_items`  (lines 19–27)

```
fn persisted_rollout_items(items: &[RolloutItem]) -> Vec<RolloutItem>
```

**Purpose**: Filters a batch of rollout items down to the canonical subset that should be appended to a live rollout file. It preserves original ordering and clones only accepted items.

**Data flow**: Consumes a slice of `RolloutItem`; iterates in order; calls `is_persisted_rollout_item` for each element; pushes `item.clone()` into a new `Vec<RolloutItem>` when allowed; returns that vector.

**Call relations**: This is the batch-oriented wrapper around `is_persisted_rollout_item`, used where callers already have a list of candidate items and need the persisted subset.

*Call graph*: calls 1 internal fn (is_persisted_rollout_item); 1 external calls (new).


##### `should_persist_response_item`  (lines 31–50)

```
fn should_persist_response_item(item: &ResponseItem) -> bool
```

**Purpose**: Defines which `codex_protocol::models::ResponseItem` variants belong in rollout files. It keeps semantically meaningful conversation/tool/compaction records and drops internal or placeholder variants.

**Data flow**: Reads a borrowed `ResponseItem`; matches on its variant; returns `true` for message, reasoning, tool call/output, web/image generation, and compaction variants, and `false` for `CompactionTrigger` and `Other`.

**Call relations**: Called only from `is_persisted_rollout_item` when the top-level rollout item wraps a response item. It provides the rollout-file policy, not the memory-specific one.

*Call graph*: called by 1 (is_persisted_rollout_item).


##### `should_persist_response_item_for_memories`  (lines 54–73)

```
fn should_persist_response_item_for_memories(item: &ResponseItem) -> bool
```

**Purpose**: Defines a narrower persistence policy for response items when building memories rather than rollout files. It excludes internal/developer-facing content while retaining user-visible messages and tool interactions.

**Data flow**: Accepts a borrowed `ResponseItem`; returns `true` for non-developer `Message` items and for shell/function/tool/web call and output variants; returns `false` for developer messages, agent messages, reasoning, image generation, compaction-related variants, and `Other`.

**Call relations**: This function is independent of the rollout-file filter and exists for memory-building codepaths elsewhere in the system that need a stricter semantic subset.


##### `should_persist_event_msg`  (lines 77–165)

```
fn should_persist_event_msg(ev: &EventMsg) -> bool
```

**Purpose**: Defines which `EventMsg` variants are durable enough to keep in rollout files. It preserves replay-relevant conversational and milestone events while excluding transient streaming, approval, and transport noise.

**Data flow**: Reads a borrowed `EventMsg`; matches many enum variants; returns `true` for selected user/agent/reasoning/turn/review/search/image/sub-agent events and for `ItemCompleted` only when the embedded `TurnItem` is `Plan` or `Sleep`; returns `false` for the large set of warnings, begin/delta events, realtime signaling, approval requests, and other transient operational messages.

**Call relations**: Invoked by `is_persisted_rollout_item` for `RolloutItem::EventMsg`. Its detailed allowlist is the event-level core of rollout persistence policy.

*Call graph*: called by 1 (is_persisted_rollout_item); 1 external calls (matches!).


### `rollout/src/metadata.rs`

`domain_logic` · `startup and background state-db reconciliation`

This file extracts durable thread metadata from rollout recordings and bulk-imports it into the state DB. The extraction path starts by deriving a `ThreadMetadataBuilder` either from the first available `RolloutItem::SessionMeta` or, if no session metadata exists, from the rollout filename via `parse_timestamp_uuid_from_filename`; that fallback reconstructs a `ThreadId`, creation timestamp, and default `SessionSource`. When a `SessionMetaLine` is present, the builder is populated with concrete fields from `session_meta.meta` such as provider, agent identity, cwd, CLI version, and git details, while forcing conservative defaults for sandboxing (`SandboxPolicy::new_read_only_policy`) and approvals (`AskForApproval::OnRequest`).

`extract_metadata_from_rollout` loads all rollout items through `RolloutRecorder::load_rollout_items`, rejects empty files, builds initial metadata, then replays every item through `codex_state::apply_rollout_item` so titles, previews, timestamps, and other derived fields reflect the full session. It also captures the latest `memory_mode` by scanning `SessionMeta` items from the end and overwrites `updated_at` with filesystem mtime when available.

The backfill path is lease-based to avoid duplicate workers. It reads and claims `BackfillState`, scans both active and archived session trees, computes stable path-based watermarks relative to `codex_home`, sorts and resumes after the last checkpoint, then processes files in batches of 200. Each successful extraction normalizes cwd for SQLite, preserves existing explicit titles and git fields when the DB already has better values, infers `archived_at` for archived rollouts from file mtime, upserts metadata, restores memory mode, checkpoints progress, and finally marks the backfill complete while emitting tracing warnings and OpenTelemetry counters/timers for failures, counts, and duration.

#### Function details

##### `builder_from_session_meta`  (lines 37–62)

```
fn builder_from_session_meta(
    session_meta: &SessionMetaLine,
    rollout_path: &Path,
) -> Option<ThreadMetadataBuilder>
```

**Purpose**: Constructs a `codex_state::ThreadMetadataBuilder` directly from a parsed `SessionMetaLine` and the rollout file path. It copies concrete session fields into the builder and seeds conservative approval/sandbox defaults plus optional git metadata.

**Data flow**: Reads `session_meta.meta.timestamp`, `id`, `source`, provider/agent/cwd/version fields, and optional `session_meta.git`; parses the timestamp into `DateTime<Utc>`; creates a builder with `ThreadMetadataBuilder::new`; mutates builder fields in place; returns `Some(builder)` on successful timestamp parsing or `None` if the timestamp cannot be converted.

**Call relations**: This is the preferred metadata-construction path and is invoked by `builder_from_items` when a rollout contains a `RolloutItem::SessionMeta`. It delegates timestamp parsing to `parse_timestamp_to_utc` because malformed or legacy timestamps should abort this richer path rather than fabricate partial metadata.

*Call graph*: calls 2 internal fn (parse_timestamp_to_utc, new); called by 1 (builder_from_items); 2 external calls (to_path_buf, new_read_only_policy).


##### `builder_from_items`  (lines 64–92)

```
fn builder_from_items(
    items: &[RolloutItem],
    rollout_path: &Path,
) -> Option<ThreadMetadataBuilder>
```

**Purpose**: Chooses how to initialize metadata for a rollout: first from embedded `SessionMeta`, otherwise from the rollout filename. The fallback keeps older or minimal rollouts indexable even when they lack explicit metadata lines.

**Data flow**: Consumes a slice of `RolloutItem` plus the rollout path; scans items for the first `RolloutItem::SessionMeta`; if found, forwards that line to `builder_from_session_meta`; otherwise reads the filename, strips compression naming via `compression::parse_rollout_file_name`, parses timestamp/UUID, converts them into a UTC creation time and `ThreadId`, and returns a new `ThreadMetadataBuilder` with `SessionSource::default()`.

**Call relations**: Called by `extract_metadata_from_rollout` during normal extraction and by other reconciliation codepaths that need a builder from already-loaded items. It acts as the decision point between rich in-band metadata and filename-derived reconstruction.

*Call graph*: calls 4 internal fn (from_string, parse_timestamp_uuid_from_filename, builder_from_session_meta, new); called by 2 (extract_metadata_from_rollout, apply_rollout_items); 6 external calls (from_timestamp, file_name, to_path_buf, default, parse_rollout_file_name, iter).


##### `extract_metadata_from_rollout`  (lines 94–131)

```
async fn extract_metadata_from_rollout(
    rollout_path: &Path,
    default_provider: &str,
) -> anyhow::Result<ExtractionOutcome>
```

**Purpose**: Loads a rollout file, derives thread metadata, replays all rollout items into that metadata, and returns the finished `ExtractionOutcome` including parse-error count and latest memory mode. It is the canonical single-file extraction routine used by backfill and reconciliation.

**Data flow**: Takes a rollout path and default provider; asynchronously loads `(items, thread_id, parse_errors)` from `RolloutRecorder::load_rollout_items`; errors on empty files or missing builder; builds initial metadata from `builder_from_items`; mutates metadata by applying every item through `apply_rollout_item`; optionally overwrites `updated_at` from `file_modified_time_utc`; scans items in reverse to extract the newest `SessionMeta.memory_mode`; returns `ExtractionOutcome { metadata, memory_mode, parse_errors }`.

**Call relations**: Invoked by `backfill_sessions_with_lease` for bulk import and by resume/reconcile paths when they need authoritative metadata from disk. It delegates parsing to the recorder and field derivation to `apply_rollout_item`, making it the central replay-based metadata synthesizer.

*Call graph*: calls 3 internal fn (builder_from_items, file_modified_time_utc, load_rollout_items); called by 4 (backfill_sessions_with_lease, resume_candidate_matches_cwd, reconcile_rollout, reconcile_rollout_preserves_existing_explicit_title); 2 external calls (anyhow!, apply_rollout_item).


##### `backfill_sessions`  (lines 133–145)

```
async fn backfill_sessions(
    runtime: &codex_state::StateRuntime,
    codex_home: &Path,
    default_provider: &str,
)
```

**Purpose**: Starts session backfill using the file’s standard lease duration constant. It is a thin wrapper that hides the test-vs-production lease configuration.

**Data flow**: Receives a `StateRuntime`, `codex_home`, and default provider; forwards them unchanged along with `BACKFILL_LEASE_SECONDS`; returns no value and performs work asynchronously.

**Call relations**: Called by the broader state-db startup gate when backfill should run. It exists so production code uses the configured lease while tests can override behavior through the lower-level helper.

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

**Purpose**: Performs the full lease-guarded rollout scan and metadata import into the state DB, with checkpointing, archived-session handling, and telemetry. It is the main backfill worker implementation.

**Data flow**: Reads backfill state from `runtime`, attempts to claim a lease, marks running if needed, scans `sessions` and archived-session roots under `codex_home`, collects rollout paths with relative-string watermarks, sorts and filters them after the last checkpoint, then for each batch extracts metadata, normalizes cwd, merges with existing DB metadata, sets archived timestamps for archived files, upserts threads, restores memory mode, updates `BackfillStats`, checkpoints the last watermark, and finally marks completion and emits counters/timer status.

**Call relations**: Reached from `backfill_sessions` and directly from tests/startup gates that need custom lease timing. It delegates file discovery to `collect_rollout_paths`, per-file extraction to `extract_metadata_from_rollout`, mtime lookup to `file_modified_time_utc`, and path normalization to `normalize_cwd_for_state_db`; its control flow is dominated by early returns on completed state, failed lease claims, or duplicate workers.

*Call graph*: calls 5 internal fn (collect_rollout_paths, extract_metadata_from_rollout, file_modified_time_utc, normalize_cwd_for_state_db, default); called by 2 (backfill_sessions, wait_for_backfill_gate); 15 external calls (default, join, new, global, info!, checkpoint_backfill, get_backfill_state, get_thread, mark_backfill_complete, mark_backfill_running (+5 more)).


##### `backfill_watermark_for_path`  (lines 359–364)

```
fn backfill_watermark_for_path(codex_home: &Path, path: &Path) -> String
```

**Purpose**: Computes the stable checkpoint string used to order and resume backfill processing. The watermark is the rollout path relative to `codex_home`, normalized to forward slashes.

**Data flow**: Takes `codex_home` and a rollout `path`; strips the home prefix when possible, converts the remaining path to lossy UTF-8, replaces backslashes with `/`, and returns the resulting `String`.

**Call relations**: Used only inside backfill path collection and checkpoint comparison. Its output becomes `BackfillState.last_watermark`, so the normalization choice directly defines resume ordering across platforms.

*Call graph*: 1 external calls (strip_prefix).


##### `file_modified_time_utc`  (lines 366–369)

```
async fn file_modified_time_utc(path: &Path) -> Option<DateTime<Utc>>
```

**Purpose**: Fetches a rollout file’s modification time and converts it into `chrono::DateTime<Utc>`. It provides the filesystem-derived `updated_at`/`archived_at` timestamps used during extraction and archived backfill.

**Data flow**: Accepts a path; calls `compression::file_modified_time`; propagates missing/failed metadata as `None`; converts the returned timestamp’s seconds and nanoseconds into `DateTime<Utc>`; returns `Option<DateTime<Utc>>`.

**Call relations**: Called by `extract_metadata_from_rollout` to refresh `updated_at` and by `backfill_sessions_with_lease` to infer `archived_at` for archived rollouts. It isolates the chrono conversion and optionality from the higher-level workflows.

*Call graph*: calls 1 internal fn (file_modified_time); called by 2 (backfill_sessions_with_lease, extract_metadata_from_rollout); 1 external calls (from_timestamp).


##### `parse_timestamp_to_utc`  (lines 371–381)

```
fn parse_timestamp_to_utc(ts: &str) -> Option<DateTime<Utc>>
```

**Purpose**: Parses session timestamps from either filename-style `YYYY-MM-DDTHH-MM-SS` strings or RFC3339 timestamps. It normalizes successful results to UTC and strips subsecond precision in the filename-format case.

**Data flow**: Consumes a timestamp string; first tries `NaiveDateTime::parse_from_str` with the filename format, converts that naive UTC value into `DateTime<Utc>`, and zeroes nanoseconds; if that fails, tries `DateTime::parse_from_rfc3339` and converts to UTC; returns `Some(DateTime<Utc>)` on success or `None` on total parse failure.

**Call relations**: Used by `builder_from_session_meta` to validate and normalize the timestamp embedded in `SessionMeta`. It encapsulates the dual-format compatibility needed for older and newer rollout metadata.

*Call graph*: called by 1 (builder_from_session_meta); 3 external calls (from_naive_utc_and_offset, parse_from_rfc3339, parse_from_str).


##### `collect_rollout_paths`  (lines 383–429)

```
async fn collect_rollout_paths(root: &Path) -> std::io::Result<Vec<PathBuf>>
```

**Purpose**: Recursively walks a sessions directory tree and returns every recognized rollout file path, including compressed variants normalized through `compression::RolloutFile`. It tolerates unreadable directories and entries by logging warnings and continuing.

**Data flow**: Starts from a root path, maintains a stack of directories, asynchronously reads each directory, inspects each entry’s file type, pushes subdirectories back onto the stack, ignores non-files, converts recognized rollout filenames via `compression::RolloutFile::from_path`, and accumulates canonical paths into a `Vec<PathBuf>` returned in `Ok`.

**Call relations**: Called by `backfill_sessions_with_lease` for both active and archived roots before sorting/checkpoint filtering. It is intentionally resilient: per-directory and per-entry failures do not abort the whole backfill scan.

*Call graph*: calls 1 internal fn (from_path); called by 1 (backfill_sessions_with_lease); 4 external calls (new, read_dir, vec!, warn!).


### `state/src/extract.rs`

`domain_logic` · `state update`

This file is the metadata-extraction core for persisted thread state. Its main entry point, `apply_rollout_item`, pattern-matches a `RolloutItem` and delegates to specialized helpers for session metadata, turn context, event messages, and response items, then ensures `metadata.model_provider` is never left empty by filling in the supplied default provider. The companion predicate `rollout_item_affects_thread_metadata` encodes which rollout item variants are worth considering for SQLite updates.

The update helpers are intentionally selective. `apply_session_meta_from_item` ignores `SessionMetaLine`s whose embedded thread ID does not match the canonical `metadata.id`, preventing forked rollouts from overwriting the destination thread’s identity. For matching session metadata it copies source, thread-source, agent fields, optional model provider, non-empty CLI version and cwd, and optional git details. `apply_turn_context` only fills `cwd` if session metadata has not already set it, but always updates model, reasoning effort, serialized permission profile, and approval mode.

`apply_event_msg` handles three event families: token counts update `tokens_used` from nonnegative totals; user messages derive a preview and title from the message body after stripping `USER_MESSAGE_BEGIN`; and thread-goal updates can seed the preview if it is still empty. Image-only user messages produce the placeholder `[Image]`. Response items currently do not mutate metadata at all. Utility helpers convert enums to strings via `serde_json`, preserve the first non-empty preview, and normalize user-message text extraction. The tests document subtle invariants such as not overriding session cwd with turn context and not treating response-item user content as the thread title.

#### Function details

##### `apply_rollout_item`  (lines 15–31)

```
fn apply_rollout_item(
    metadata: &mut ThreadMetadata,
    item: &RolloutItem,
    default_provider: &str,
)
```

**Purpose**: Applies one protocol rollout item to mutable `ThreadMetadata`, updating only the fields relevant to that item type. It also guarantees a fallback model provider when none has been set.

**Data flow**: It takes mutable metadata, a `RolloutItem`, and a `default_provider` string. It matches the item variant and delegates to `apply_session_meta_from_item`, `apply_turn_context`, `apply_event_msg`, or `apply_response_item`; `InterAgentCommunication` and `Compacted` are ignored. After delegation, if `metadata.model_provider` is empty, it sets it to `default_provider.to_string()`.

**Call relations**: This is the file’s main public mutation entry point. Tests call it directly with different rollout variants to verify the specialized helper behavior.

*Call graph*: calls 4 internal fn (apply_event_msg, apply_response_item, apply_session_meta_from_item, apply_turn_context); called by 10 (event_msg_blank_user_message_without_images_keeps_first_user_message_empty, event_msg_image_only_user_message_sets_image_placeholder_preview, event_msg_thread_goal_sets_preview_only_and_later_user_sets_message_title, event_msg_user_messages_set_title_and_first_user_message, response_item_user_messages_do_not_set_title_or_first_user_message, session_meta_does_not_set_model_or_reasoning_effort, turn_context_does_not_override_session_cwd, turn_context_sets_cwd_when_session_cwd_missing, turn_context_sets_model_and_reasoning_effort, turn_context_sets_permission_profile_metadata).


##### `rollout_item_affects_thread_metadata`  (lines 34–45)

```
fn rollout_item_affects_thread_metadata(item: &RolloutItem) -> bool
```

**Purpose**: Reports whether a rollout item type can change the thread metadata persisted in SQLite. It is a cheap filter for callers deciding whether an update pass is necessary.

**Data flow**: It pattern-matches a borrowed `RolloutItem` and returns `true` for `SessionMeta`, `TurnContext`, and selected `EventMsg` variants (`TokenCount`, `UserMessage`, `ThreadGoalUpdated`), and `false` for all other variants.

**Call relations**: This predicate complements `apply_rollout_item` by letting upstream code skip metadata work for rollout items known to be irrelevant.


##### `apply_session_meta_from_item`  (lines 47–73)

```
fn apply_session_meta_from_item(metadata: &mut ThreadMetadata, meta_line: &SessionMetaLine)
```

**Purpose**: Copies canonical session metadata fields into `ThreadMetadata` while ignoring embedded session metadata for other thread IDs. It is the authoritative source for identity, source, cwd, CLI version, and git metadata.

**Data flow**: It takes mutable metadata and a `SessionMetaLine`. If `metadata.id != meta_line.meta.id`, it returns immediately. Otherwise it copies the thread ID, serializes `source` with `enum_to_string`, clones optional thread-source and agent fields, copies `model_provider` when present, copies non-empty `cli_version` and non-empty `cwd`, and if git metadata exists, fills `git_sha`, `git_branch`, and `git_origin_url` from it.

**Call relations**: It is called only from `apply_rollout_item` when the rollout item is `RolloutItem::SessionMeta`.

*Call graph*: calls 1 internal fn (enum_to_string); called by 1 (apply_rollout_item).


##### `apply_turn_context`  (lines 75–84)

```
fn apply_turn_context(metadata: &mut ThreadMetadata, turn_ctx: &TurnContextItem)
```

**Purpose**: Updates metadata fields derived from a turn context, including model selection, reasoning effort, permission profile, and approval mode. It only uses turn-context cwd as a fallback when session metadata did not already provide one.

**Data flow**: It takes mutable metadata and a `TurnContextItem`. If `metadata.cwd` is empty, it clones `turn_ctx.cwd` into it. It then sets `metadata.model`, `metadata.reasoning_effort`, serializes `turn_ctx.permission_profile()` into `metadata.sandbox_policy` with `serde_json::to_string(...).unwrap_or_default()`, and stores the approval policy string via `enum_to_string`.

**Call relations**: This helper is invoked by `apply_rollout_item` for `RolloutItem::TurnContext` and is covered by tests around cwd precedence and permission-profile serialization.

*Call graph*: calls 2 internal fn (permission_profile, enum_to_string); called by 1 (apply_rollout_item); 1 external calls (to_string).


##### `apply_event_msg`  (lines 86–114)

```
fn apply_event_msg(metadata: &mut ThreadMetadata, event: &EventMsg)
```

**Purpose**: Applies metadata-relevant event messages such as token counts, user messages, and thread-goal updates. Other event variants are ignored.

**Data flow**: It matches the `EventMsg`: for `TokenCount`, if `info` exists it stores `total_tokens.max(0)` in `metadata.tokens_used`; for `UserMessage`, it computes a preview with `user_message_preview`, stores it as `first_user_message` if that field is still `None`, calls `set_preview_if_empty`, and if `metadata.title` is empty derives a title from `strip_user_message_prefix(user.message)`; for `ThreadGoalUpdated`, it trims the objective and, if non-empty, seeds `preview` via `set_preview_if_empty`. Other variants leave metadata unchanged.

**Call relations**: It is called by `apply_rollout_item` for `RolloutItem::EventMsg` and relies on the preview/title helpers in this file.

*Call graph*: calls 3 internal fn (set_preview_if_empty, strip_user_message_prefix, user_message_preview); called by 1 (apply_rollout_item).


##### `apply_response_item`  (lines 116–116)

```
fn apply_response_item(_metadata: &mut ThreadMetadata, _item: &ResponseItem)
```

**Purpose**: Placeholder hook for response-item metadata extraction that currently performs no updates. Its presence makes the dispatch in `apply_rollout_item` explicit.

**Data flow**: It accepts mutable metadata and a `ResponseItem` reference but ignores both and returns unit without changing state.

**Call relations**: It is called from `apply_rollout_item` for `RolloutItem::ResponseItem`, and tests verify that response-item user content does not affect title or first-user-message fields.

*Call graph*: called by 1 (apply_rollout_item).


##### `set_preview_if_empty`  (lines 118–122)

```
fn set_preview_if_empty(metadata: &mut ThreadMetadata, preview: Option<String>)
```

**Purpose**: Sets the metadata preview only if it has not already been established. This preserves the first meaningful preview source encountered.

**Data flow**: It takes mutable metadata and an `Option<String>` preview. If `metadata.preview` is `None`, it assigns the provided option; otherwise it leaves the existing preview unchanged.

**Call relations**: It is used by `apply_event_msg` for both user-message previews and thread-goal objectives so later events do not overwrite an earlier preview.

*Call graph*: called by 1 (apply_event_msg).


##### `strip_user_message_prefix`  (lines 124–129)

```
fn strip_user_message_prefix(text: &str) -> &str
```

**Purpose**: Removes the protocol’s `USER_MESSAGE_BEGIN` marker from a user message and trims surrounding whitespace. If the marker is absent, it simply trims the whole string.

**Data flow**: It takes a message `&str`, searches for `USER_MESSAGE_BEGIN`, and returns a borrowed subslice after the marker with `trim()` applied, or `text.trim()` when the marker is not found.

**Call relations**: This helper is used by both `apply_event_msg` when deriving titles and by `user_message_preview` when deriving preview text.

*Call graph*: called by 2 (apply_event_msg, user_message_preview).


##### `user_message_preview`  (lines 131–145)

```
fn user_message_preview(user: &UserMessageEvent) -> Option<String>
```

**Purpose**: Computes the preview text for a user message, including a placeholder for image-only messages. It encapsulates the precedence between textual content and attached images.

**Data flow**: It takes a `UserMessageEvent`, strips the protocol prefix from `user.message`, and if the resulting text is non-empty returns it as `Some(String)`. Otherwise, if `images` is present and non-empty or `local_images` is non-empty, it returns `Some("[Image]".to_string())`; if neither text nor images are present, it returns `None`.

**Call relations**: It is called by `apply_event_msg` when processing `EventMsg::UserMessage`.

*Call graph*: calls 1 internal fn (strip_user_message_prefix); called by 1 (apply_event_msg).


##### `enum_to_string`  (lines 147–153)

```
fn enum_to_string(value: &T) -> String
```

**Purpose**: Serializes an enum-like value into a string representation suitable for persisted metadata fields. It prefers plain strings when the serialized JSON value is itself a string.

**Data flow**: It takes any `Serialize` value, calls `serde_json::to_value`, and returns the inner string if the result is `Value::String`, `other.to_string()` for other JSON values, or an empty string if serialization fails.

**Call relations**: This utility is used by `apply_session_meta_from_item` and `apply_turn_context` to persist protocol enums such as source and approval policy.

*Call graph*: called by 4 (apply_session_meta_from_item, apply_turn_context, build, test_thread_metadata); 2 external calls (new, to_value).


##### `tests::response_item_user_messages_do_not_set_title_or_first_user_message`  (lines 185–202)

```
fn response_item_user_messages_do_not_set_title_or_first_user_message()
```

**Purpose**: Verifies that user-authored content embedded in a `ResponseItem` does not affect thread title, preview, or first-user-message metadata. This preserves the distinction between protocol response items and explicit user-message events.

**Data flow**: The test builds baseline metadata, constructs a `RolloutItem::ResponseItem(ResponseItem::Message { role: "user", ... })`, applies it with `apply_rollout_item`, and asserts that `first_user_message`, `preview`, and `title` remain unset.

**Call relations**: It directly validates the current no-op behavior of `apply_response_item` as reached through `apply_rollout_item`.

*Call graph*: calls 1 internal fn (apply_rollout_item); 4 external calls (assert_eq!, ResponseItem, metadata_for_test, vec!).


##### `tests::event_msg_user_messages_set_title_and_first_user_message`  (lines 205–224)

```
fn event_msg_user_messages_set_title_and_first_user_message()
```

**Purpose**: Checks that a normal user-message event populates first-user-message, preview, and title from the stripped message text. It covers the main user-message extraction path.

**Data flow**: The test creates metadata, constructs `RolloutItem::EventMsg(EventMsg::UserMessage(...))` with a message prefixed by `USER_MESSAGE_BEGIN`, applies it, and asserts that `first_user_message`, `preview`, and `title` all equal the stripped request text.

**Call relations**: It exercises `apply_rollout_item` through `apply_event_msg`, `user_message_preview`, and `strip_user_message_prefix`.

*Call graph*: calls 1 internal fn (apply_rollout_item); 7 external calls (default, assert_eq!, format!, UserMessage, EventMsg, metadata_for_test, vec!).


##### `tests::event_msg_image_only_user_message_sets_image_placeholder_preview`  (lines 227–249)

```
fn event_msg_image_only_user_message_sets_image_placeholder_preview()
```

**Purpose**: Verifies that a user message containing images but no text produces the `[Image]` placeholder for preview fields while leaving title empty. This captures the image-only edge case.

**Data flow**: The test constructs a `UserMessageEvent` with empty `message` and a non-empty `images` vector, applies it via `apply_rollout_item`, and asserts that `first_user_message` and `preview` equal the placeholder constant while `title` remains empty.

**Call relations**: It validates the image-detection branch in `user_message_preview` as used by `apply_event_msg`.

*Call graph*: calls 1 internal fn (apply_rollout_item); 7 external calls (default, new, assert_eq!, UserMessage, EventMsg, metadata_for_test, vec!).


##### `tests::event_msg_blank_user_message_without_images_keeps_first_user_message_empty`  (lines 252–268)

```
fn event_msg_blank_user_message_without_images_keeps_first_user_message_empty()
```

**Purpose**: Ensures that a blank user message with no images does not create synthetic preview or title metadata. It protects against storing meaningless whitespace-only content.

**Data flow**: The test builds a `UserMessageEvent` whose message is only spaces and whose image collections are empty, applies it, and asserts that `first_user_message`, `preview`, and `title` remain unset or empty.

**Call relations**: It exercises the `None` path from `user_message_preview` and the empty-title guard in `apply_event_msg`.

*Call graph*: calls 1 internal fn (apply_rollout_item); 6 external calls (default, assert_eq!, UserMessage, EventMsg, metadata_for_test, vec!).


##### `tests::event_msg_thread_goal_sets_preview_only_and_later_user_sets_message_title`  (lines 271–312)

```
fn event_msg_thread_goal_sets_preview_only_and_later_user_sets_message_title()
```

**Purpose**: Checks that a thread-goal update can seed the preview without setting title or first-user-message, and that a later user message sets those fields without overwriting the existing preview. It documents preview precedence.

**Data flow**: The test first applies a `ThreadGoalUpdated` event with a non-empty objective and asserts preview is set while title and first-user-message remain empty. It then applies a later `UserMessage` event and asserts preview stays on the goal text while first-user-message and title are populated from the user message.

**Call relations**: It validates `apply_event_msg`’s use of `set_preview_if_empty` across different event types.

*Call graph*: calls 1 internal fn (apply_rollout_item); 8 external calls (default, assert_eq!, format!, ThreadGoalUpdated, UserMessage, EventMsg, metadata_for_test, vec!).


##### `tests::turn_context_does_not_override_session_cwd`  (lines 315–380)

```
fn turn_context_does_not_override_session_cwd()
```

**Purpose**: Verifies that session metadata’s cwd takes precedence over turn-context cwd and that turn context still updates permission-profile and approval metadata. It captures an important field-precedence rule.

**Data flow**: The test starts with empty cwd, applies a matching `SessionMeta` carrying `/child/worktree`, then applies a `TurnContextItem` carrying `/parent/workspace`, and asserts that cwd remains `/child/worktree` while `sandbox_policy` and `approval_mode` reflect the turn context’s permission profile and approval policy.

**Call relations**: It exercises `apply_rollout_item` through both `apply_session_meta_from_item` and `apply_turn_context` to verify their interaction.

*Call graph*: calls 2 internal fn (from_string, apply_rollout_item); 7 external calls (from, new, now_v7, assert_eq!, SessionMeta, TurnContext, metadata_for_test).


##### `tests::turn_context_sets_permission_profile_metadata`  (lines 383–416)

```
fn turn_context_sets_permission_profile_metadata()
```

**Purpose**: Checks that turn context serializes the effective permission profile into the persisted sandbox-policy field. It ensures the metadata stores the normalized permission profile rather than the raw sandbox enum.

**Data flow**: The test creates a workspace-write `PermissionProfile`, embeds it in a `TurnContextItem`, applies the rollout item, and asserts that `metadata.sandbox_policy` equals `serde_json::to_string(&permission_profile)`.

**Call relations**: It directly validates the `turn_ctx.permission_profile()` serialization path inside `apply_turn_context`.

*Call graph*: calls 2 internal fn (workspace_write, apply_rollout_item); 4 external calls (from, assert_eq!, TurnContext, metadata_for_test).


##### `tests::turn_context_sets_cwd_when_session_cwd_missing`  (lines 419–449)

```
fn turn_context_sets_cwd_when_session_cwd_missing()
```

**Purpose**: Ensures turn context supplies cwd only as a fallback when session metadata did not already set one. This covers the opposite side of the cwd precedence rule.

**Data flow**: The test clears `metadata.cwd`, applies a `TurnContextItem` with `/fallback/workspace`, and asserts that cwd becomes that fallback path.

**Call relations**: It targets the `if metadata.cwd.as_os_str().is_empty()` branch in `apply_turn_context`.

*Call graph*: calls 1 internal fn (apply_rollout_item); 6 external calls (from, new, new_read_only_policy, assert_eq!, TurnContext, metadata_for_test).


##### `tests::turn_context_sets_model_and_reasoning_effort`  (lines 452–482)

```
fn turn_context_sets_model_and_reasoning_effort()
```

**Purpose**: Verifies that turn context updates the selected model and reasoning-effort metadata fields. These fields are sourced from turn context rather than session metadata.

**Data flow**: The test applies a `TurnContextItem` containing model `gpt-5` and `ReasoningEffort::High`, then asserts that `metadata.model` and `metadata.reasoning_effort` were set accordingly.

**Call relations**: It directly validates the model-related assignments in `apply_turn_context`.

*Call graph*: calls 1 internal fn (apply_rollout_item); 5 external calls (from, new_read_only_policy, assert_eq!, TurnContext, metadata_for_test).


##### `tests::session_meta_does_not_set_model_or_reasoning_effort`  (lines 485–518)

```
fn session_meta_does_not_set_model_or_reasoning_effort()
```

**Purpose**: Confirms that session metadata does not populate model or reasoning-effort fields. This preserves the separation between session-level and turn-level metadata sources.

**Data flow**: The test applies a matching `SessionMetaLine` to baseline metadata and asserts that `metadata.model` and `metadata.reasoning_effort` remain `None`.

**Call relations**: It verifies that `apply_session_meta_from_item` intentionally leaves those fields untouched.

*Call graph*: calls 1 internal fn (apply_rollout_item); 4 external calls (from, assert_eq!, SessionMeta, metadata_for_test).


##### `tests::metadata_for_test`  (lines 520–549)

```
fn metadata_for_test() -> ThreadMetadata
```

**Purpose**: Builds a representative `ThreadMetadata` fixture used across extraction tests. It centralizes consistent baseline values for IDs, timestamps, paths, and default metadata fields.

**Data flow**: It constructs a deterministic `ThreadId` from a fixed UUID, a fixed `created_at` timestamp, and returns a fully populated `ThreadMetadata` struct with default-like values for source, provider, cwd, policy fields, and optional metadata slots.

**Call relations**: Most tests in this module call it before applying rollout items so they can focus on the fields under test.

*Call graph*: calls 1 internal fn (from_string); 4 external calls (from_timestamp, from, new, from_u128).


##### `tests::diff_fields_detects_changes`  (lines 552–561)

```
fn diff_fields_detects_changes()
```

**Purpose**: Checks that `ThreadMetadata::diff_fields` reports changed field names between two metadata instances. Although the method lives elsewhere, this test anchors expected diff behavior near the extraction logic.

**Data flow**: The test creates a base metadata fixture, changes its ID and title, clones it, mutates `tokens_used` and `title` on the clone, calls `base.diff_fields(&other)`, and asserts that the returned field-name vector is `["title", "tokens_used"]`.

**Call relations**: It is adjacent to extraction tests because metadata diffing is relevant to deciding what changed after applying rollout items.

*Call graph*: calls 1 internal fn (from_string); 3 external calls (now_v7, assert_eq!, metadata_for_test).


### `thread-store/src/local/archive_thread.rs`

`io_transport` · `thread archival and post-run maintenance`

This local-store helper performs real filesystem archival for a thread identified by `ArchiveThreadParams`. It first asks the store for an optional state-db context, then resolves the current rollout path with `codex_rollout::find_thread_path_by_id_str`, passing the Codex home, thread ID string, and optional state-db context. Resolution failures are converted into `ThreadStoreError::InvalidRequest`, and a missing rollout becomes a specific `no rollout found` invalid request. Once a path is found, the function validates and canonicalizes it with `scoped_rollout_path` to ensure it lies under the active `sessions` directory, then derives the exact archived filename with `matching_rollout_file_name` so the thread ID and original path remain consistent.

The archive destination is `<codex_home>/archived_sessions/<file_name>`. The function creates that directory if needed, renames the active rollout file into it, and maps any filesystem errors to `ThreadStoreError::Internal` with a uniform `failed to archive thread` message. If a state-db context exists, it then best-effort calls `mark_archived(thread_id, archived_path, Utc::now())`; that async metadata update is intentionally ignored on failure so the file move remains authoritative. The accompanying tests verify both the filesystem move and the optional SQLite metadata update path, including that archived listings surface the moved rollout path and archived timestamp.

#### Function details

##### `archive_thread`  (lines 11–61)

```
async fn archive_thread(
    store: &LocalThreadStore,
    params: ArchiveThreadParams,
) -> ThreadStoreResult<()>
```

**Purpose**: Moves a local thread’s rollout file into the archived sessions directory and optionally marks the thread archived in the state database. It validates the source path before moving it.

**Data flow**: Takes a `&LocalThreadStore` and `ArchiveThreadParams`, reads `thread_id`, awaits `store.state_db()` for optional DB context, resolves the rollout path with `find_thread_path_by_id_str`, canonicalizes it with `scoped_rollout_path`, derives the expected filename with `matching_rollout_file_name`, creates the archive directory with `std::fs::create_dir_all`, renames the file with `std::fs::rename`, and if a DB context exists awaits `ctx.mark_archived(thread_id, archived_path.as_path(), Utc::now())` while ignoring its result. It returns `Ok(())` on success or a mapped `ThreadStoreError` on lookup/path/filesystem failures.

**Call relations**: This helper is called by the local thread store’s archive operation and is the concrete implementation behind local archival behavior.

*Call graph*: calls 3 internal fn (state_db, matching_rollout_file_name, scoped_rollout_path); called by 1 (archive_thread); 4 external calls (now, find_thread_path_by_id_str, create_dir_all, rename).


##### `tests::archive_thread_moves_rollout_to_archived_collection`  (lines 82–125)

```
async fn archive_thread_moves_rollout_to_archived_collection()
```

**Purpose**: Verifies that archiving physically moves the rollout file into the archived sessions directory and that archived thread listing reflects the moved file and archived timestamp semantics.

**Data flow**: Creates a temporary Codex home and `LocalThreadStore`, writes a synthetic active session file, calls `store.archive_thread(...)`, asserts the original path no longer exists and the archived path does, then lists archived threads and checks item count, thread ID, rollout path, and `archived_at == updated_at`.

**Call relations**: This test exercises the filesystem move path and the downstream archived-listing behavior exposed by the local store.

*Call graph*: calls 4 internal fn (from_string, new, test_config, write_session_file); 5 external calls (new, from_u128, new, assert!, assert_eq!).


##### `tests::archive_thread_updates_sqlite_metadata_when_present`  (lines 128–177)

```
async fn archive_thread_updates_sqlite_metadata_when_present()
```

**Purpose**: Checks that when a state database is configured, archiving updates the stored rollout path and sets an archived timestamp in SQLite metadata. It validates the optional metadata side effect beyond the file move itself.

**Data flow**: Creates a temporary home and config, initializes `codex_state::StateRuntime`, marks backfill complete, builds and upserts thread metadata for an active rollout path, constructs a `LocalThreadStore` with that runtime, archives the thread, then reads the thread metadata back from the runtime and asserts the rollout path now points to the archived location and `archived_at` is set.

**Call relations**: This test covers the branch in `archive_thread` that uses the optional state-db context to call `mark_archived` after the filesystem rename.

*Call graph*: calls 6 internal fn (from_string, new, init, new, test_config, write_session_file); 5 external calls (new, now, from_u128, assert!, assert_eq!).


### `thread-store/src/local/unarchive_thread.rs`

`domain_logic` · `request handling`

This file provides the local-thread-store path for reversing archival. The main async routine starts from `ArchiveThreadParams.thread_id`, asks `LocalThreadStore` for an optional state DB context, and uses rollout lookup helpers to find the archived rollout file under the configured Codex home. It treats lookup failures and missing results as `ThreadStoreError::InvalidRequest`, distinguishing user-facing bad input from internal filesystem failures.

Once a candidate path is found, the code hardens it with `scoped_rollout_path` against escaping the archived sessions subtree, then verifies the filename matches the requested thread via `matching_rollout_file_name`. It extracts `(year, month, day)` from the rollout filename timestamp using `rollout_date_parts`; if the filename lacks the expected timestamp structure, restoration is rejected. The destination path is reconstructed under the live `sessions/<year>/<month>/<day>` hierarchy, the directory is created, and the file is moved with `std::fs::rename`. After the move, `touch_modified_time` updates the restored file’s mtime so the unarchived thread appears freshly modified.

If a state DB exists, the function best-effort calls `mark_unarchived(thread_id, restored_path)` and intentionally ignores any error so filesystem restoration remains authoritative. Finally, it rereads the rollout contents with `read_thread_item_from_rollout` and converts that item into a `StoredThread` via `stored_thread_from_rollout_item`, forcing `archived` to `false` and supplying the configured default model provider. The tests verify both the on-disk move and the clearing of `archived_at` in returned/thread metadata.

#### Function details

##### `unarchive_thread`  (lines 15–101)

```
async fn unarchive_thread(
    store: &LocalThreadStore,
    params: ArchiveThreadParams,
) -> ThreadStoreResult<StoredThread>
```

**Purpose**: Restores one archived rollout file for the requested thread ID into the active sessions directory, refreshes its timestamp, optionally updates persisted metadata, and returns the reconstructed `StoredThread`.

**Data flow**: Inputs are a `&LocalThreadStore` and `ArchiveThreadParams` containing `thread_id`. It reads `store.config.codex_home`, `store.config.default_model_provider_id`, and the optional async state DB context from `store.state_db().await`. It resolves the archived rollout path with `find_archived_thread_path_by_id_str`, validates and canonicalizes that path with `scoped_rollout_path`, derives the expected filename with `matching_rollout_file_name`, and parses date components from the filename via `rollout_date_parts`. It then creates the destination directory, renames the file from archived to active storage, and updates the file mtime with `touch_modified_time`. If a DB context exists, it writes unarchive metadata through `mark_unarchived`. Finally it rereads the moved rollout using `read_thread_item_from_rollout`, converts it with `stored_thread_from_rollout_item`, and returns `ThreadStoreResult<StoredThread>`, mapping lookup/validation failures to `InvalidRequest` and filesystem/readback failures to `Internal`.

**Call relations**: This is the file’s core implementation, invoked by the higher-level store method for unarchiving a thread. Its flow is staged: locate archived rollout first, then validate path/filename, then move the file, then optionally synchronize the state DB, then reread the rollout to produce the API result. It delegates path safety and filename/thread-ID consistency to local helper functions, and delegates rollout discovery/parsing to `codex_rollout` helpers because those encode the archive layout and rollout file format.

*Call graph*: calls 5 internal fn (state_db, matching_rollout_file_name, scoped_rollout_path, stored_thread_from_rollout_item, touch_modified_time); called by 1 (unarchive_thread); 6 external calls (find_archived_thread_path_by_id_str, read_thread_item_from_rollout, rollout_date_parts, format!, create_dir_all, rename).


##### `tests::unarchive_thread_restores_rollout_and_returns_updated_thread`  (lines 119–146)

```
async fn unarchive_thread_restores_rollout_and_returns_updated_thread()
```

**Purpose**: Verifies the happy path without a state DB: an archived session file is moved into the live sessions tree and the returned `StoredThread` reflects an active, non-archived thread.

**Data flow**: The test creates a temporary Codex home, builds a `LocalThreadStore` with `test_config(...)` and no state DB, constructs a deterministic `ThreadId` from a fixed UUID, and writes an archived rollout fixture with `write_archived_session_file`. It invokes `store.unarchive_thread(...)`, then inspects filesystem state and returned thread fields. The assertions confirm the original archived path no longer exists, the restored path under `sessions/2025/01/03` exists, and the returned `StoredThread` has the expected `thread_id`, `rollout_path`, `archived_at == None`, preview text, and first user message.

**Call relations**: This test exercises the public unarchive path through `LocalThreadStore`, covering the branch where no SQLite/state runtime is present. It does not call helper functions directly; instead it validates the externally visible effects of the main `unarchive_thread` implementation on both disk layout and returned thread projection.

*Call graph*: calls 4 internal fn (from_string, new, test_config, write_archived_session_file); 4 external calls (new, from_u128, assert!, assert_eq!).


##### `tests::unarchive_thread_updates_sqlite_metadata_when_present`  (lines 149–199)

```
async fn unarchive_thread_updates_sqlite_metadata_when_present()
```

**Purpose**: Verifies that when a state runtime is configured, unarchiving also clears archived metadata and updates the stored rollout path in SQLite-backed thread metadata.

**Data flow**: The test creates a temporary home and config, derives a fixed `ThreadId`, writes an archived rollout fixture, and initializes `codex_state::StateRuntime`. It marks backfill complete, constructs thread metadata with `ThreadMetadataBuilder`, fills in provider/cwd/CLI version fields, sets `metadata.archived_at` to simulate an archived record, and persists it with `upsert_thread`. After invoking `store.unarchive_thread(...)`, it computes the expected restored path and reads the thread metadata back with `runtime.get_thread(thread_id)`. Assertions verify that `rollout_path` now points to the active sessions location and `archived_at` has been cleared.

**Call relations**: This test drives the same unarchive flow as the previous test but under the condition that `LocalThreadStore` has a live state DB context. Its role is to confirm the side effect of the implementation’s optional `mark_unarchived` call, proving that filesystem restoration and metadata synchronization stay aligned when the database layer is available.

*Call graph*: calls 6 internal fn (from_string, new, init, new, test_config, write_archived_session_file); 4 external calls (new, now, from_u128, assert_eq!).


### `thread-store/src/local/update_thread_metadata.rs`

`domain_logic` · `request handling`

This file is the core metadata-update path for `LocalThreadStore`. Its top-level async function first short-circuits empty patches by re-reading the thread, then decides whether the patch requires rollout compatibility work and whether SQLite write failures must be fatal. The main write phase, `apply_metadata_update`, updates or creates the SQLite metadata row using `ThreadMetadataBuilder` when necessary, merges `ThreadMetadataPatch` fields into stored metadata, normalizes `cwd`, serializes enum-like values through JSON, resolves partial git patches against existing git fields, and optionally stores memory mode separately. A notable design choice is that missing SQLite rows can be recreated from rollout location and patch data, including preserving archived status by setting `archived_at` when the resolved rollout path lives under `ARCHIVED_SESSIONS_SUBDIR`.

After the SQLite-oriented update, the file conditionally performs rollout compatibility writes for legacy/read-path consumers. It can flush a live writer copy, resolve the actual rollout path from live state, active sessions, or archived sessions, append `SessionMeta` markers for memory mode and git info, reconcile the rollout back into SQLite, and append a thread-name index entry. Git updates are handled carefully: partial patches require existing SQLite values, rollout writes verify the session metadata thread id matches the requested `ThreadId`, and memory-mode-only rollout updates intentionally omit git data so replay preserves prior git markers. The file ends with extensive tests covering active vs archived threads, external live rollouts, partial and clearing git updates, best-effort SQLite failures, title/name precedence, cwd normalization, and archived-row recreation.

#### Function details

##### `update_thread_metadata`  (lines 37–176)

```
async fn update_thread_metadata(
    store: &LocalThreadStore,
    params: UpdateThreadMetadataParams,
) -> ThreadStoreResult<StoredThread>
```

**Purpose**: Applies a metadata patch to a thread and returns the refreshed `StoredThread`, coordinating SQLite updates with rollout-file compatibility writes when needed. It is the public local-store update path for thread metadata changes such as names, previews, memory mode, and git information.

**Data flow**: It takes a `&LocalThreadStore` and `UpdateThreadMetadataParams`, extracts `thread_id`, `patch`, and `include_archived`, and immediately re-reads the thread if the patch is empty. Otherwise it computes two policy flags, invokes `apply_metadata_update` to merge the patch into SQLite-backed metadata, and if rollout compatibility is required it resolves the rollout path, optionally appends memory-mode and git `SessionMeta` markers, reconciles rollout state back into SQLite, updates the thread-name index, and finally re-reads the thread either by id or directly by rollout path. It returns the final `StoredThread`, overriding its `git_info` in-memory when a resolved git patch was just applied.

**Call relations**: This is invoked by the store-facing update operation. It delegates the primary metadata merge to `apply_metadata_update`, uses `needs_rollout_compatibility_update` and `sqlite_write_failure_should_block` to choose follow-up behavior, calls `live_writer::persist_thread` when a live rollout exists so compatibility writes target the latest file, uses `resolve_rollout_path` and `refresh_resolved_rollout_path` around rollout appends, and routes specific compatibility writes through `apply_thread_memory_mode`, `apply_thread_name`, `apply_thread_git_info_to_rollout`, and `apply_thread_git_info`.

*Call graph*: calls 17 internal fn (reconcile_rollout, state_db, git_info_from_parts, persist_thread, rollout_path, read_thread, read_thread_by_rollout_path, apply_metadata_update, apply_thread_git_info, apply_thread_git_info_to_rollout (+7 more)); called by 1 (update_thread_metadata); 1 external calls (format!).


##### `refresh_resolved_rollout_path`  (lines 178–182)

```
async fn refresh_resolved_rollout_path(resolved: &mut ResolvedRolloutPath)
```

**Purpose**: Refreshes a previously resolved rollout path to the currently existing on-disk path if the file has moved or been rewritten. This protects later compatibility writes from using a stale path.

**Data flow**: It takes a mutable `ResolvedRolloutPath`, queries `codex_rollout::existing_rollout_path` using the current `path`, and if a replacement path exists it overwrites `resolved.path`. It returns no value and mutates only the struct argument.

**Call relations**: It is called from `update_thread_metadata` after appending memory-mode or git metadata, where rollout writes may have changed the canonical file path and subsequent operations should follow the updated location.

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

**Purpose**: Performs the main SQLite-oriented metadata merge for a thread, including creating a metadata row when possible and updating all patchable fields. It encapsulates the best-effort vs blocking behavior for SQLite failures.

**Data flow**: Inputs are the store, target `ThreadId`, a `ThreadMetadataPatch`, `include_archived`, and a `require_sqlite_write` flag. It probes the live rollout path, derives whether that path is archived, fetches the optional state DB, and if SQLite is available loads any existing thread row; when no row exists and no rollout path is already known, it resolves one via `resolve_rollout_path`. It then either starts from the existing row or builds a new one with `ThreadMetadataBuilder`, filling defaults such as `created_at`, `source`, normalized `cwd`, and archived status. The function applies each optional patch field into the metadata row, converts enums with `enum_to_string`, maps permission profiles with `permission_profile_to_metadata_value`, merges git fields via `resolve_git_info_patch`, upserts the row, optionally stores memory mode via `memory_mode_as_str`, and then decides whether SQLite errors should be returned or only logged. On success or tolerated failure, it finishes by re-reading the thread through `read_thread::read_thread`.

**Call relations**: This is the first substantive step called by `update_thread_metadata`. It depends on `resolve_rollout_path` when reconstructing missing metadata rows, uses helper conversions like `normalize_cwd`, `enum_to_string`, `memory_mode_as_str`, and `git_info_from_parts`, and consults `sqlite_write_error_is_best_effort` to decide whether an internal SQLite error should abort the overall update.

*Call graph*: calls 11 internal fn (state_db, git_info_from_parts, permission_profile_to_metadata_value, rollout_path, read_thread, enum_to_string, memory_mode_as_str, normalize_cwd, resolve_git_info_patch, resolve_rollout_path (+1 more)); called by 1 (update_thread_metadata); 2 external calls (clone, warn!).


##### `needs_rollout_compatibility_update`  (lines 355–363)

```
fn needs_rollout_compatibility_update(patch: &ThreadMetadataPatch) -> bool
```

**Purpose**: Determines whether a patch must also be mirrored into rollout artifacts for compatibility with rollout-derived metadata readers. It treats explicit thread names as always requiring rollout updates and gates memory-mode/git rollout writes on whether the patch contains only compatibility-era fields.

**Data flow**: It reads a `&ThreadMetadataPatch`, checks `name`, `memory_mode`, and `git_info`, and consults `has_observed_metadata_facts` to distinguish explicit compatibility updates from richer observed metadata updates. It returns a boolean decision.

**Call relations**: Called by `update_thread_metadata` before any writes so the top-level flow can skip rollout work entirely for pure SQLite-observed metadata patches.

*Call graph*: calls 1 internal fn (has_observed_metadata_facts); called by 1 (update_thread_metadata).


##### `sqlite_write_failure_should_block`  (lines 365–372)

```
fn sqlite_write_failure_should_block(patch: &ThreadMetadataPatch) -> bool
```

**Purpose**: Classifies whether a SQLite write failure should abort the update instead of being logged and ignored. The rule preserves historical best-effort behavior for rollout-compatible metadata while requiring SQLite for git-only partial updates.

**Data flow**: It inspects a `&ThreadMetadataPatch`, checks whether `git_info` is present, and uses `has_observed_metadata_facts` to tell whether the patch includes independently observed metadata. It returns `true` only for explicit git-only style updates that need existing SQLite state to preserve unspecified fields.

**Call relations**: Used by `update_thread_metadata` to compute the `require_sqlite_write` flag passed into `apply_metadata_update`, shaping later error handling.

*Call graph*: calls 1 internal fn (has_observed_metadata_facts); called by 1 (update_thread_metadata).


##### `sqlite_write_error_is_best_effort`  (lines 374–376)

```
fn sqlite_write_error_is_best_effort(err: &ThreadStoreError) -> bool
```

**Purpose**: Marks which `ThreadStoreError` variants are considered tolerable best-effort SQLite failures. In this file, only internal errors qualify.

**Data flow**: It takes a `&ThreadStoreError`, pattern-matches it against `ThreadStoreError::Internal`, and returns a boolean.

**Call relations**: Called inside `apply_metadata_update` when deciding whether to return a SQLite failure or merely emit a warning and continue.

*Call graph*: called by 1 (apply_metadata_update); 1 external calls (matches!).


##### `has_observed_metadata_facts`  (lines 378–397)

```
fn has_observed_metadata_facts(patch: &ThreadMetadataPatch) -> bool
```

**Purpose**: Checks whether a patch contains metadata fields that come from observed transcript/session facts rather than explicit compatibility-only edits. This distinction drives rollout compatibility and SQLite failure policy.

**Data flow**: It reads a `&ThreadMetadataPatch` and returns `true` if any of many fields are present, including rollout path, preview, title, model/provider fields, timestamps, source fields, agent fields, cwd, CLI version, approval mode, permission profile, token usage, or first user message.

**Call relations**: It is a shared predicate used by both `needs_rollout_compatibility_update` and `sqlite_write_failure_should_block` to classify the patch.

*Call graph*: called by 2 (needs_rollout_compatibility_update, sqlite_write_failure_should_block).


##### `enum_to_string`  (lines 399–405)

```
fn enum_to_string(value: &T) -> String
```

**Purpose**: Serializes an enum-like value into the string form expected by stored metadata columns. It prefers plain JSON strings but falls back to JSON text for non-string serialized values.

**Data flow**: It accepts any `serde::Serialize` value, converts it with `serde_json::to_value`, and returns either the contained string, `other.to_string()` for non-string JSON values, or an empty string on serialization failure.

**Call relations**: Used by `apply_metadata_update` when storing fields such as `source` and `approval_mode` into string-backed metadata columns.

*Call graph*: called by 1 (apply_metadata_update); 2 external calls (new, to_value).


##### `normalize_cwd`  (lines 407–409)

```
fn normalize_cwd(cwd: PathBuf) -> PathBuf
```

**Purpose**: Canonicalizes a working-directory path into the normalized form used for path comparison and filtering. This avoids mismatches caused by segments like `..`.

**Data flow**: It takes a `PathBuf`, passes its `Path` view to `codex_utils_path::normalize_for_path_comparison`, and returns the normalized path if available or the original path otherwise.

**Call relations**: Called by `apply_metadata_update` when creating or updating metadata rows so later list/filter operations can compare cwd values consistently.

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

**Purpose**: Writes resolved git metadata fields directly into the SQLite thread row and verifies that the row still exists. It is the final SQLite-side commit for rollout-compatible git updates.

**Data flow**: It takes the store, `ThreadId`, and references to optional `sha`, `branch`, and `origin_url`. It requires `store.state_db()` to be present, calls `update_thread_git_info` with `Option<&str>` wrappers so explicit `None` can clear fields, and returns `Ok(())` only if the update reports that a row was modified; otherwise it returns an internal error describing missing state DB or vanished metadata.

**Call relations**: Called by `update_thread_metadata` after `apply_thread_git_info_to_rollout` succeeds, ensuring SQLite matches the rollout marker that was appended.

*Call graph*: calls 1 internal fn (state_db); called by 1 (update_thread_metadata); 1 external calls (format!).


##### `resolve_git_info_patch`  (lines 443–459)

```
fn resolve_git_info_patch(
    existing: Option<GitInfo>,
    git_info: GitInfoPatch,
) -> (Option<String>, Option<String>, Option<String>)
```

**Purpose**: Merges a partial `GitInfoPatch` with existing git metadata, preserving unspecified fields and allowing explicit clearing. It converts protocol-level `GitInfo` into the tuple form used by the update code.

**Data flow**: It accepts an `Option<GitInfo>` and a `GitInfoPatch`, extracts existing commit hash, branch, and repository URL into `Option<String>` values, then applies `unwrap_or` against each patch field so `Some(None)` clears a field while `None` preserves the existing value. It returns a `(Option<String>, Option<String>, Option<String>)` tuple for sha, branch, and origin URL.

**Call relations**: Used in both `apply_metadata_update` and `update_thread_metadata`: first to merge git fields into SQLite metadata rows, and later to compute the fully resolved git values that should be appended to rollout and written back to SQLite.

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

**Purpose**: Appends a `SessionMeta` rollout item carrying git metadata, while preserving or explicitly setting memory mode in the same marker. It validates that the rollout file actually belongs to the requested thread before writing.

**Data flow**: It takes a rollout `&Path`, `ThreadId`, optional git field references, and an optional memory-mode string. It reads the current session meta line from the rollout, checks `session_meta.meta.id` against `thread_id`, constructs a new `GitInfo` with optional commit hash, branch, and repository URL, sets `session_meta.meta.memory_mode`, and appends the updated `RolloutItem::SessionMeta` to the file. It returns `Ok(())` on append success or a `ThreadStoreError::Internal` on read, id-mismatch, or append failure.

**Call relations**: Called by `update_thread_metadata` when a patch includes git info and rollout compatibility is required. It follows rollout-path resolution and may be followed by `refresh_resolved_rollout_path` and `apply_thread_git_info`.

*Call graph*: called by 1 (update_thread_metadata); 4 external calls (append_rollout_item_to_path, read_session_meta_line, format!, SessionMeta).


##### `apply_thread_name`  (lines 497–521)

```
async fn apply_thread_name(
    store: &LocalThreadStore,
    thread_id: ThreadId,
    name: String,
) -> ThreadStoreResult<()>
```

**Purpose**: Updates the thread title in SQLite when available and appends the thread-name index entry under the Codex home directory. This keeps both metadata storage and name lookup/indexing in sync.

**Data flow**: It takes the store, `ThreadId`, and the new `String` name. If a state DB exists, it calls `update_thread_title` and errors if no row was updated; regardless of SQLite presence, it then calls `append_thread_name` rooted at `store.config.codex_home`. It returns `Ok(())` only if both applicable writes succeed.

**Call relations**: Invoked by `update_thread_metadata` for patches with `name`, after rollout reconciliation has run so the name index and SQLite title reflect the final update.

*Call graph*: calls 1 internal fn (state_db); called by 1 (update_thread_metadata); 2 external calls (append_thread_name, format!).


##### `apply_thread_memory_mode`  (lines 523–552)

```
async fn apply_thread_memory_mode(
    rollout_path: &Path,
    thread_id: ThreadId,
    memory_mode: ThreadMemoryMode,
) -> ThreadStoreResult<()>
```

**Purpose**: Appends a rollout `SessionMeta` marker that changes only memory mode and intentionally does not rewrite git metadata. This preserves prior git markers during rollout replay.

**Data flow**: It takes a rollout `&Path`, `ThreadId`, and `ThreadMemoryMode`. It reads the current session meta line, verifies the embedded thread id matches, clears `session_meta.git`, sets `session_meta.meta.memory_mode` using `memory_mode_as_str`, and appends the resulting `RolloutItem::SessionMeta` to the rollout file. It returns success or an internal error for read, mismatch, or append failures.

**Call relations**: Called by `update_thread_metadata` when a patch includes `memory_mode` and rollout compatibility is needed. After it appends the marker, the caller refreshes the rollout path and later reconciles rollout state back into SQLite.

*Call graph*: calls 1 internal fn (memory_mode_as_str); called by 1 (update_thread_metadata); 4 external calls (append_rollout_item_to_path, read_session_meta_line, format!, SessionMeta).


##### `memory_mode_as_str`  (lines 554–559)

```
fn memory_mode_as_str(mode: ThreadMemoryMode) -> &'static str
```

**Purpose**: Converts the `ThreadMemoryMode` enum into the exact persisted string literal used by SQLite and rollout metadata.

**Data flow**: It takes a `ThreadMemoryMode` and returns either `"enabled"` or `"disabled"` as a `&'static str`.

**Call relations**: Used by both `apply_metadata_update` for SQLite storage and `apply_thread_memory_mode` for rollout `SessionMeta` serialization.

*Call graph*: called by 2 (apply_metadata_update, apply_thread_memory_mode).


##### `resolve_rollout_path`  (lines 561–608)

```
async fn resolve_rollout_path(
    store: &LocalThreadStore,
    thread_id: ThreadId,
    include_archived: bool,
) -> ThreadStoreResult<ResolvedRolloutPath>
```

**Purpose**: Finds the concrete rollout file for a thread, preferring a live writer path and falling back to active then archived session lookup. It also reports whether the resolved path is archived.

**Data flow**: It takes the store, `ThreadId`, and `include_archived`. It first asks `live_writer::rollout_path`; if that succeeds it computes archived status with `rollout_path_is_archived`. Otherwise it fetches the optional state DB context and searches active sessions with `find_thread_path_by_id_str`; if not found and archived lookup is allowed, it searches archived sessions with `find_archived_thread_path_by_id_str`. It returns a `ResolvedRolloutPath { path, archived }` or an `InvalidRequest` error when lookup fails or archived access is disallowed.

**Call relations**: Called from `apply_metadata_update` when reconstructing missing SQLite metadata rows and from `update_thread_metadata` before rollout compatibility writes. It centralizes the active/live/archived lookup policy for the rest of the file.

*Call graph*: calls 3 internal fn (state_db, rollout_path, rollout_path_is_archived); called by 2 (apply_metadata_update, update_thread_metadata); 4 external calls (find_archived_thread_path_by_id_str, find_thread_path_by_id_str, format!, to_string).


##### `rollout_path_is_archived`  (lines 610–612)

```
fn rollout_path_is_archived(store: &LocalThreadStore, path: &Path) -> bool
```

**Purpose**: Determines whether a rollout path lives under the archived sessions directory configured for the store.

**Data flow**: It takes the store and a rollout `&Path`, joins `store.config.codex_home` with `ARCHIVED_SESSIONS_SUBDIR`, and returns whether the given path starts with that archived root.

**Call relations**: Used by `resolve_rollout_path` and indirectly by `apply_metadata_update` to preserve archived status when updating or recreating metadata rows.

*Call graph*: called by 1 (resolve_rollout_path); 1 external calls (starts_with).


##### `tests::update_thread_metadata_sets_name_on_active_rollout_and_indexes_name`  (lines 638–662)

```
async fn update_thread_metadata_sets_name_on_active_rollout_and_indexes_name()
```

**Purpose**: Verifies that setting `name` on an active rollout updates the returned thread and writes the thread-name index entry.

**Data flow**: The test creates a temporary home, a store without SQLite, and a session file, then calls `update_thread_metadata` with a `ThreadMetadataPatch` containing `name`. It asserts the returned thread name and the latest indexed name found via rollout helpers both equal the new value.

**Call relations**: This test exercises the top-level update path specifically through the rollout-compatibility branch for names, demonstrating that name updates work even without a state DB.

*Call graph*: calls 4 internal fn (from_string, new, test_config, write_session_file); 5 external calls (default, new, from_u128, assert_eq!, find_thread_name_by_id).


##### `tests::update_thread_metadata_sets_memory_mode_on_active_rollout`  (lines 665–702)

```
async fn update_thread_metadata_sets_memory_mode_on_active_rollout()
```

**Purpose**: Checks that a memory-mode patch appends a rollout `session_meta` marker and stores the mode in SQLite.

**Data flow**: It builds a temp store with initialized state DB and a session file, updates metadata with `memory_mode: Disabled`, then inspects the last rollout line and reads back the stored memory mode from the runtime. Assertions confirm both rollout and SQLite contain `disabled`.

**Call relations**: This test covers the combined path through `apply_metadata_update`, `apply_thread_memory_mode`, and subsequent readback.

*Call graph*: calls 5 internal fn (from_string, init, new, test_config, write_session_file); 5 external calls (default, new, from_u128, assert_eq!, last_rollout_item).


##### `tests::update_thread_metadata_preserves_memory_mode_when_updating_git_info`  (lines 705–771)

```
async fn update_thread_metadata_preserves_memory_mode_when_updating_git_info()
```

**Purpose**: Ensures that a later git-info update does not erase an already stored memory mode in rollout replay or SQLite.

**Data flow**: The test first sets memory mode, then applies a partial git patch containing only a branch. It checks the appended rollout item includes both `memory_mode: disabled` and the new git branch, then runs rollout reconciliation and verifies SQLite still reports the disabled memory mode.

**Call relations**: It validates the interaction between `apply_thread_memory_mode`, `apply_thread_git_info_to_rollout`, and rollout reconciliation, especially the preservation logic around memory mode.

*Call graph*: calls 6 internal fn (from_string, reconcile_rollout, init, new, test_config, write_session_file); 5 external calls (default, new, from_u128, assert_eq!, last_rollout_item).


##### `tests::update_thread_metadata_uses_live_rollout_path_for_external_resume`  (lines 774–811)

```
async fn update_thread_metadata_uses_live_rollout_path_for_external_resume()
```

**Purpose**: Confirms that metadata updates target the live rollout path registered by `resume_thread`, even when that path is outside the store's home directory.

**Data flow**: It creates separate home and external directories, writes a session file externally, resumes the thread with that rollout path, then updates memory mode. The test asserts the returned thread has a rollout path and that the external file received the appended `session_meta` marker.

**Call relations**: This test exercises the `live_writer::rollout_path` preference inside `resolve_rollout_path` and the top-level update flow.

*Call graph*: calls 4 internal fn (from_string, new, test_config, write_session_file); 7 external calls (default, new, from_u128, assert!, assert_eq!, last_rollout_item, test_thread_metadata).


##### `tests::update_thread_metadata_sets_git_info`  (lines 814–854)

```
async fn update_thread_metadata_sets_git_info()
```

**Purpose**: Verifies that a full git-info patch populates commit hash, branch, and repository URL on the returned thread.

**Data flow**: It initializes a store with SQLite and a session file, applies a patch containing all git fields, and inspects the returned `StoredThread.git_info`. Assertions confirm each field matches the supplied values.

**Call relations**: This test covers the normal git-update path through SQLite merge, rollout compatibility write, and final thread readback.

*Call graph*: calls 5 internal fn (from_string, init, new, test_config, write_session_file); 4 external calls (default, new, from_u128, assert_eq!).


##### `tests::update_thread_metadata_sets_permission_profile`  (lines 857–894)

```
async fn update_thread_metadata_sets_permission_profile()
```

**Purpose**: Checks that permission-profile updates are persisted into SQLite using the serialized sandbox-policy representation and surfaced on the returned thread.

**Data flow**: The test updates a thread with `permission_profile: Disabled`, asserts the returned thread reports that profile, then reads the SQLite metadata row and compares `sandbox_policy` to the JSON serialization of the enum.

**Call relations**: It specifically validates `permission_profile_to_metadata_value` usage inside `apply_metadata_update`.

*Call graph*: calls 5 internal fn (from_string, init, new, test_config, write_session_file); 4 external calls (default, new, from_u128, assert_eq!).


##### `tests::update_thread_metadata_partially_updates_git_info`  (lines 897–952)

```
async fn update_thread_metadata_partially_updates_git_info()
```

**Purpose**: Ensures partial git patches preserve unspecified existing git fields instead of clearing them.

**Data flow**: It seeds full git metadata, then applies a second patch containing only a new branch. The returned thread is checked to confirm the original commit hash and repository URL remain while the branch changes.

**Call relations**: This test directly validates `resolve_git_info_patch` behavior as used by the update flow.

*Call graph*: calls 5 internal fn (from_string, init, new, test_config, write_session_file); 4 external calls (default, new, from_u128, assert_eq!).


##### `tests::update_thread_metadata_clears_git_info_fields`  (lines 955–1123)

```
async fn update_thread_metadata_clears_git_info_fields()
```

**Purpose**: Exercises explicit clearing of git fields, subsequent memory-mode updates, reconciliation behavior, and partial git updates after the SQLite row has been deleted.

**Data flow**: The test seeds git metadata, applies a patch with `sha`, `branch`, and `origin_url` all set to `Some(None)` to clear them, inspects rollout output, reconciles, and verifies the thread has no git info. It then updates memory mode and confirms no stray git field is emitted, deletes the SQLite row, applies a partial git patch with only branch, and verifies the branch is restored without resurrecting cleared fields.

**Call relations**: This is the most comprehensive git edge-case test, covering `resolve_git_info_patch`, rollout append semantics, reconcile behavior, and missing-row recovery.

*Call graph*: calls 6 internal fn (from_string, reconcile_rollout, init, new, test_config, write_session_file); 6 external calls (default, new, from_u128, assert!, assert_eq!, last_rollout_item).


##### `tests::update_thread_metadata_rejects_mismatched_session_meta_id`  (lines 1126–1155)

```
async fn update_thread_metadata_rejects_mismatched_session_meta_id()
```

**Purpose**: Verifies that rollout compatibility writes fail when the rollout file's embedded session metadata id does not match the requested thread id.

**Data flow**: It writes a session file, rewrites its contents so the metadata id differs from the filename/thread id, then attempts a memory-mode update and expects an error. Assertions check the error is internal and mentions the metadata id mismatch.

**Call relations**: This test targets the defensive id checks in `apply_thread_memory_mode` and, by extension, the same pattern used for git rollout updates.

*Call graph*: calls 4 internal fn (from_string, new, test_config, write_session_file); 6 external calls (default, new, from_u128, assert!, read_to_string, write).


##### `tests::update_thread_metadata_applies_combined_explicit_patch`  (lines 1158–1208)

```
async fn update_thread_metadata_applies_combined_explicit_patch()
```

**Purpose**: Checks that a single patch containing name, memory mode, and git info applies all explicit compatibility updates together.

**Data flow**: The test creates a thread with SQLite, applies a patch containing `name`, `memory_mode`, and git branch, then verifies the returned thread fields, the appended rollout `session_meta`, the thread-name index entry, and the SQLite memory-mode value.

**Call relations**: It validates the full multi-step orchestration in `update_thread_metadata`, including rollout path refresh and mixed compatibility writes.

*Call graph*: calls 5 internal fn (from_string, init, new, test_config, write_session_file); 6 external calls (default, new, from_u128, assert_eq!, find_thread_name_by_id, last_rollout_item).


##### `tests::sqlite_failures_are_best_effort_for_legacy_rollout_compat_updates`  (lines 1211–1220)

```
fn sqlite_failures_are_best_effort_for_legacy_rollout_compat_updates()
```

**Purpose**: Asserts that SQLite failures should not block legacy compatibility-only updates such as thread names and memory mode.

**Data flow**: It constructs patches for `name` and `memory_mode` and checks that `sqlite_write_failure_should_block` returns `false` for both.

**Call relations**: This unit test documents the intended policy encoded in `sqlite_write_failure_should_block`.

*Call graph*: 1 external calls (assert!).


##### `tests::sqlite_failures_are_best_effort_for_observed_metadata_updates`  (lines 1223–1237)

```
fn sqlite_failures_are_best_effort_for_observed_metadata_updates()
```

**Purpose**: Asserts that patches containing observed metadata facts remain best-effort even when they also include git or memory-mode fields.

**Data flow**: It builds patches with `updated_at` and with a combination of `preview`, `git_info`, and `memory_mode`, then asserts `sqlite_write_failure_should_block` is `false`.

**Call relations**: This test reinforces the distinction between observed metadata and explicit git-only updates used by the top-level error policy.

*Call graph*: 1 external calls (assert!).


##### `tests::sqlite_failures_still_block_for_explicit_git_only_updates`  (lines 1240–1248)

```
fn sqlite_failures_still_block_for_explicit_git_only_updates()
```

**Purpose**: Confirms that explicit git-only updates still require SQLite and therefore should fail if SQLite writes fail.

**Data flow**: It creates a patch containing only a git branch update and asserts `sqlite_write_failure_should_block` returns `true`.

**Call relations**: This test captures the special-case policy needed because partial git patches depend on existing SQLite values.

*Call graph*: 1 external calls (assert!).


##### `tests::metadata_patch_applies_title_over_existing_name`  (lines 1251–1291)

```
async fn metadata_patch_applies_title_over_existing_name()
```

**Purpose**: Verifies that a later observed `title` update overrides a previously set explicit `name` in the stored thread view.

**Data flow**: The test first sets `name`, then applies a patch with `title` and `preview`, and finally asserts the returned thread name equals the newer title text.

**Call relations**: It exercises field precedence inside `apply_metadata_update`, where `title` assignment occurs after `name` assignment.

*Call graph*: calls 5 internal fn (from_string, init, new, test_config, write_session_file); 4 external calls (default, new, from_u128, assert_eq!).


##### `tests::metadata_patch_applies_latest_preview_and_first_user_message`  (lines 1294–1349)

```
async fn metadata_patch_applies_latest_preview_and_first_user_message()
```

**Purpose**: Checks that later observed preview and first-user-message values replace earlier SQLite metadata, while the returned thread may still derive display preview from transcript content.

**Data flow**: It writes initial preview and first-user-message values, applies later replacements, then asserts the returned thread still shows transcript-derived preview text while the SQLite metadata row stores the later observed values.

**Call relations**: This test highlights the distinction between persisted metadata updates in this file and read-time thread presentation logic elsewhere.

*Call graph*: calls 5 internal fn (from_string, init, new, test_config, write_session_file); 4 external calls (default, new, from_u128, assert_eq!).


##### `tests::observed_metadata_rejects_unknown_thread_without_rollout`  (lines 1352–1387)

```
async fn observed_metadata_rejects_unknown_thread_without_rollout()
```

**Purpose**: Ensures that observed metadata alone cannot create a brand-new thread when no rollout file exists to anchor it.

**Data flow**: It initializes a store and state DB without creating a session file, attempts to update `preview` for a nonexistent thread, expects an `InvalidRequest` saying the thread was not found, and confirms SQLite still has no row for that id.

**Call relations**: This test validates the `resolve_rollout_path` requirement used by `apply_metadata_update` when no existing metadata row is present.

*Call graph*: calls 4 internal fn (from_string, init, new, test_config); 4 external calls (default, new, from_u128, assert!).


##### `tests::update_thread_metadata_recreates_missing_archived_sqlite_row_as_archived`  (lines 1390–1427)

```
async fn update_thread_metadata_recreates_missing_archived_sqlite_row_as_archived()
```

**Purpose**: Verifies that updating an archived thread with no SQLite row recreates the row and preserves archived status.

**Data flow**: It writes an archived session file, initializes SQLite, applies an observed metadata patch with `include_archived: true`, and asserts both the returned thread and the recreated SQLite row have `archived_at` set.

**Call relations**: This test covers the missing-row builder path in `apply_metadata_update` together with archived-path detection from `resolve_rollout_path`.

*Call graph*: calls 5 internal fn (from_string, init, new, test_config, write_archived_session_file); 4 external calls (default, new, from_u128, assert!).


##### `tests::observed_metadata_normalizes_cwd_for_list_filters`  (lines 1430–1492)

```
async fn observed_metadata_normalizes_cwd_for_list_filters()
```

**Purpose**: Checks that observed cwd metadata is normalized before storage so later list filtering by cwd matches correctly.

**Data flow**: The test creates a workspace path and an unnormalized child/`..` path, updates metadata with that cwd and a preview, then reads the SQLite row to confirm normalization and runs `list_threads` with a cwd filter to ensure the thread is returned.

**Call relations**: It validates `normalize_cwd` inside `apply_metadata_update` and demonstrates why normalization matters to downstream listing logic.

*Call graph*: calls 5 internal fn (from_string, init, new, test_config, write_session_file); 8 external calls (default, new, from_u128, new, assert_eq!, normalize_for_path_comparison, create_dir_all, vec!).


##### `tests::update_thread_metadata_keeps_archived_thread_archived_in_sqlite`  (lines 1495–1555)

```
async fn update_thread_metadata_keeps_archived_thread_archived_in_sqlite()
```

**Purpose**: Ensures that updating metadata on an archived thread already represented in SQLite does not accidentally clear its archived status.

**Data flow**: It writes an archived session file, reconciles it into SQLite as archived, confirms `archived_at` is set, updates the thread name with `include_archived: true`, and then rechecks both the returned thread and SQLite row for archived status.

**Call relations**: This test exercises the update path against preexisting archived metadata and confirms no later write resets `archived_at`.

*Call graph*: calls 6 internal fn (from_string, reconcile_rollout, init, new, test_config, write_archived_session_file); 4 external calls (default, new, from_u128, assert!).


##### `tests::update_thread_metadata_keeps_live_archived_thread_archived_in_sqlite`  (lines 1558–1619)

```
async fn update_thread_metadata_keeps_live_archived_thread_archived_in_sqlite()
```

**Purpose**: Verifies that even when an archived thread is resumed as a live thread, metadata updates still preserve its archived status in SQLite.

**Data flow**: It writes and reconciles an archived session file, resumes that archived path as live, updates the thread name, and asserts both the returned thread and SQLite metadata remain archived.

**Call relations**: This test covers the interaction between live rollout-path preference and archived-state preservation in the metadata update logic.

*Call graph*: calls 6 internal fn (from_string, reconcile_rollout, init, new, test_config, write_archived_session_file); 5 external calls (default, new, from_u128, assert!, test_thread_metadata).


##### `tests::test_thread_metadata`  (lines 1621–1627)

```
fn test_thread_metadata() -> ThreadPersistenceMetadata
```

**Purpose**: Builds a reusable `ThreadPersistenceMetadata` fixture for tests that resume threads.

**Data flow**: It reads the current working directory and returns a `ThreadPersistenceMetadata` with that cwd, a fixed `model_provider`, and `ThreadMemoryMode::Enabled`.

**Call relations**: Used by tests that call `resume_thread`, supplying the metadata needed to register a live thread before invoking `update_thread_metadata`.

*Call graph*: 1 external calls (current_dir).


##### `tests::last_rollout_item`  (lines 1629–1637)

```
fn last_rollout_item(path: &std::path::Path) -> Value
```

**Purpose**: Reads the final JSONL record from a rollout file and parses it as JSON for assertions.

**Data flow**: It takes a rollout path, reads the file to a string, selects the last line, parses it with `serde_json::from_str`, and returns the resulting `serde_json::Value`.

**Call relations**: Shared by multiple tests that need to inspect the exact `session_meta` item appended by rollout compatibility writes.

*Call graph*: 2 external calls (from_str, read_to_string).


### Core result emission
These files turn streamed model and tool outcomes into persisted turn items, lifecycle callbacks, status updates, and user-visible command or diff records.

### `core/src/tools/events.rs`

`orchestration` · `request handling`

This file is the event-emission layer for shell commands, unified exec, and apply-patch operations. `ToolEventCtx` packages the `Session`, `TurnContext`, tool `call_id`, and optional shared `TurnDiffTracker`. `ToolEmitter` is the central enum describing what kind of tool activity is being reported: `Shell`, `ApplyPatch`, or `UnifiedExec`. Constructors precompute parsed commands where needed.

The main orchestration happens in `ToolEmitter::emit` and `ToolEmitter::finish`. `emit` maps a `ToolEventStage` (`Begin`, `Success`, or `Failure`) into concrete protocol actions. Shell and unified exec stages are funneled through `emit_exec_stage`, which emits `ExecCommandBeginEvent` or `ExecCommandEndEvent` with timestamps, command metadata, stdout/stderr, aggregated output, formatted output, and a status of completed/failed/declined. Apply-patch stages instead emit `TurnItem::FileChange` started/completed events and may update the shared diff tracker.

`finish` is the policy-heavy function: it converts `Result<ExecToolCallOutput, ToolError>` into both an emitted event and a `Result<String, FunctionCallError>` for the caller. Timeout and denied sandbox errors preserve output-bearing failure details; generic Codex errors become `execution error: ...`; `ToolError::Rejected("rejected by user")` is normalized into clearer tool-specific phrases. A subtle patch-specific rule handles denied apply-patch with a known committed prefix by treating it as a success-stage event for diff tracking while still returning a model-facing error.

`emit_patch_end` also manages `TurnDiffTracker`: it can track a known delta, invalidate the tracker, or leave it unchanged, and emits a `TurnDiffEvent` whenever the tracker changed and there was previous or current unified diff state. The tests focus on these patch/diff edge cases.

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

**Purpose**: Constructs the lightweight context object passed to event emitters. It bundles the session, turn, call id, and optional diff tracker reference without additional logic.

**Data flow**: Takes `session: &Session`, `turn: &TurnContext`, `call_id: &str`, and `turn_diff_tracker: Option<&SharedTurnDiffTracker>` → returns `ToolEventCtx { ... }` with those references copied into the struct.

**Call relations**: Callers across exec and patch handling create this context before invoking `ToolEmitter` methods or direct helpers like `emit_patch_end`. It serves as the shared input to all event-emission functions in this file.

*Call graph*: called by 9 (assert_failed_apply_patch_tracks_committed_delta, invalidation_emits_empty_turn_diff, net_zero_patch_emits_empty_turn_diff, handle_call, intercept_apply_patch, run_exec_like, emit_exec_end_for_unified_exec, emit_failed_exec_end_for_unified_exec, exec_command).


##### `tracker_update_for_known_delta`  (lines 81–93)

```
fn tracker_update_for_known_delta(
    environment_id: Option<&str>,
    delta: &'a AppliedPatchDelta,
) -> TurnDiffTrackerUpdate<'a>
```

**Purpose**: Determines how the turn-diff tracker should be updated for a known patch delta. Exact empty deltas are treated as no-op updates; all other known deltas are tracked.

**Data flow**: Takes `environment_id: Option<&str>` and `delta: &AppliedPatchDelta` → checks `delta.is_exact()` and `delta.is_empty()` → returns `TurnDiffTrackerUpdate::None` for exact empty deltas, otherwise `TurnDiffTrackerUpdate::Track { environment_id: environment_id.map(str::to_string), delta }`.

**Call relations**: This helper is used inside `ToolEmitter::emit` when apply-patch success or rejection includes a known delta. It centralizes the subtle distinction between a net-zero exact patch and a meaningful diff update.

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

**Purpose**: Sends an `ExecCommandBegin` protocol event for a shell or unified-exec tool invocation. It captures command metadata and the start timestamp.

**Data flow**: Takes `ToolEventCtx`, command slice, cwd, parsed command slice, source, optional interaction input, and optional process id → builds `ExecCommandBeginEvent` with cloned command/cwd/parsed_cmd, `call_id`, `turn_id`, and `started_at_ms = now_unix_timestamp_ms()` → wraps it in `EventMsg::ExecCommandBegin` and awaits `session.send_event(...)`.

**Call relations**: This function is called from `emit_exec_stage` when the stage is `Begin`. It delegates transport to `Session::send_event` and timestamp generation to `now_unix_timestamp_ms`.

*Call graph*: calls 1 internal fn (now_unix_timestamp_ms); called by 1 (emit_exec_stage); 3 external calls (to_vec, ExecCommandBegin, clone).


##### `ToolEmitter::shell`  (lines 144–152)

```
fn shell(command: Vec<String>, cwd: AbsolutePathBuf, source: ExecCommandSource) -> Self
```

**Purpose**: Constructs a `ToolEmitter::Shell` and precomputes the parsed command representation. It is the convenience constructor for ordinary shell exec tools.

**Data flow**: Takes owned `command: Vec<String>`, `cwd: AbsolutePathBuf`, and `source: ExecCommandSource` → parses the command with `parse_command(&command)` → returns `ToolEmitter::Shell { command, cwd, source, parsed_cmd }`.

**Call relations**: Exec-like tool runners call this before emitting begin/end events for shell commands. It delegates command parsing to `codex_shell_command::parse_command::parse_command`.

*Call graph*: calls 1 internal fn (parse_command); called by 1 (run_exec_like).


##### `ToolEmitter::apply_patch_for_environment`  (lines 154–164)

```
fn apply_patch_for_environment(
        changes: HashMap<PathBuf, FileChange>,
        auto_approved: bool,
        environment_id: String,
    ) -> Self
```

**Purpose**: Constructs a patch emitter that carries file changes, approval metadata, and an environment id for diff tracking. It is the convenience constructor for apply-patch operations tied to a specific environment.

**Data flow**: Takes `changes: HashMap<PathBuf, FileChange>`, `auto_approved: bool`, and `environment_id: String` → returns `ToolEmitter::ApplyPatch { changes, auto_approved, environment_id: Some(environment_id) }`.

**Call relations**: Apply-patch handlers call this before emitting patch lifecycle events. The stored environment id is later consumed by `ToolEmitter::emit` when deciding how to update the turn-diff tracker.

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

**Purpose**: Constructs a `ToolEmitter::UnifiedExec` with parsed command metadata and optional process id. It is the convenience constructor for unified exec event emission.

**Data flow**: Takes `command: &[String]`, `cwd`, `source`, and `process_id: Option<String>` → parses the command slice with `parse_command(command)` → clones the command into a `Vec<String>` → returns `ToolEmitter::UnifiedExec { ... }`.

**Call relations**: Unified exec code paths call this before emitting begin/end events. It parallels `ToolEmitter::shell` but preserves an optional process id for long-lived exec sessions.

*Call graph*: calls 1 internal fn (parse_command); called by 3 (emit_exec_end_for_unified_exec, emit_failed_exec_end_for_unified_exec, exec_command).


##### `ToolEmitter::emit`  (lines 182–338)

```
async fn emit(&self, ctx: ToolEventCtx<'_>, stage: ToolEventStage<'_>)
```

**Purpose**: Dispatches a tool lifecycle stage to the correct event-emission behavior for shell, unified exec, or apply-patch tools. It is the central stage-to-event router in the file.

**Data flow**: Takes `&self`, `ToolEventCtx`, and `ToolEventStage` → pattern matches on both emitter variant and stage. For `Shell` and `UnifiedExec`, it builds `ExecCommandInput::new(...)` and awaits `emit_exec_stage(...)`. For `ApplyPatch::Begin`, it emits a started `TurnItem::FileChange`. For apply-patch success/failure variants, it computes `PatchApplyStatus`, chooses a `TurnDiffTrackerUpdate` (track/invalidate/none), and awaits `emit_patch_end(...)` with cloned changes and stdout/stderr/message text.

**Call relations**: This method is called by `ToolEmitter::begin` and `ToolEmitter::finish`. It delegates exec-specific formatting to `emit_exec_stage` and patch completion plus diff tracking to `emit_patch_end`.

*Call graph*: calls 3 internal fn (new, emit_exec_stage, emit_patch_end); called by 2 (begin, finish); 2 external calls (new, FileChange).


##### `ToolEmitter::begin`  (lines 340–342)

```
async fn begin(&self, ctx: ToolEventCtx<'_>)
```

**Purpose**: Emits the begin-stage event for the configured tool emitter. It is a thin convenience wrapper around `emit`.

**Data flow**: Takes `&self` and `ToolEventCtx` → calls `self.emit(ctx, ToolEventStage::Begin).await` → returns `()`.

**Call relations**: Callers use this when a tool starts execution. It delegates all actual routing to `ToolEmitter::emit`.

*Call graph*: calls 1 internal fn (emit).


##### `ToolEmitter::format_exec_output_for_model`  (lines 344–350)

```
fn format_exec_output_for_model(
        &self,
        output: &ExecToolCallOutput,
        ctx: ToolEventCtx<'_>,
    ) -> String
```

**Purpose**: Formats an `ExecToolCallOutput` into the model-facing string representation using the turn's truncation policy. It isolates the formatting policy used by `finish`.

**Data flow**: Takes `&self`, `output: &ExecToolCallOutput`, and `ctx: ToolEventCtx` → reads `ctx.turn.truncation_policy` → calls `super::format_exec_output_for_model(output, policy)` → returns the formatted string.

**Call relations**: This helper is called only by `ToolEmitter::finish` before deciding whether to return success or a model-facing error. It delegates the actual formatting implementation to the parent module.

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

**Purpose**: Converts a completed exec/apply-patch result into both emitted lifecycle events and the caller-facing `Result<String, FunctionCallError>`. It contains the main policy for mapping tool errors, exit codes, and patch-specific edge cases.

**Data flow**: Takes `&self`, `ToolEventCtx`, `out: Result<ExecToolCallOutput, ToolError>`, and optional `applied_patch_delta` → matches on `out`. For `Ok(output)`, formats model text, emits `Success`, and returns `Ok(content)` if `exit_code == 0` else `Err(RespondToModel(content))`. For sandbox timeout, formats output, emits `Failure(Output(...))`, and returns model-facing error text. For sandbox denied, formats output and, if this is `ApplyPatch` with a known delta, emits `Success { output, applied_patch_delta }` so diff tracking can consume the committed prefix; otherwise emits `Failure(Output(...))`; return is still `Err(RespondToModel(response))`. Generic Codex errors become `execution error: {err:?}` with `Failure(Message(...))`. `ToolError::Rejected(msg)` is normalized to `exec command rejected by user` or `patch rejected by user` when the message is exactly `rejected by user`, then emitted as `Failure(Rejected { ... })` and returned as `RespondToModel(normalized)`. After choosing `(event, result)`, it awaits `self.emit(ctx, event)` and returns `result`.

**Call relations**: Callers invoke this after a tool completes. It delegates formatting to `format_exec_output_for_model` and event routing to `emit`, while embedding the file's key policy decisions about failure normalization and patch diff preservation.

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

**Purpose**: Constructs the borrowed exec-command input bundle used by exec event emitters. It packages command metadata without cloning.

**Data flow**: Takes borrowed command slice, cwd, parsed command slice, source, optional interaction input, and optional process id → returns `ExecCommandInput { ... }`.

**Call relations**: This helper is used inside `ToolEmitter::emit` before calling `emit_exec_stage`. It keeps the exec emission path concise and avoids repeated struct literals.

*Call graph*: called by 1 (emit).


##### `emit_exec_stage`  (lines 472–534)

```
async fn emit_exec_stage(
    ctx: ToolEventCtx<'_>,
    exec_input: ExecCommandInput<'_>,
    stage: ToolEventStage<'_>,
)
```

**Purpose**: Translates an exec lifecycle stage into either a begin event or an end event with a synthesized `ExecCommandResult`. It normalizes success, output-bearing failure, message failure, and rejection into a common end-event shape.

**Data flow**: Takes `ToolEventCtx`, `ExecCommandInput`, and `ToolEventStage` → on `Begin`, forwards metadata to `emit_exec_command_begin`. On `Success { output, .. }` or `Failure(Output(output))`, clones stdout/stderr/aggregated output, copies exit code and duration, formats output with `format_exec_output_str(&output, ctx.turn.truncation_policy)`, derives `ExecCommandStatus::Completed` or `Failed`, builds `ExecCommandResult`, and calls `emit_exec_end`. On `Failure(Message(message))`, builds an `ExecCommandResult` with empty stdout, stderr/aggregated/formatted text equal to the message, `exit_code = -1`, `duration = Duration::ZERO`, and status `Failed`, then emits end. On `Failure(Rejected { message, .. })`, builds the same shape but with status `Declined`.

**Call relations**: This function is called from `ToolEmitter::emit` for shell and unified exec emitters. It delegates begin-event transport to `emit_exec_command_begin` and end-event transport to `emit_exec_end`.

*Call graph*: calls 2 internal fn (emit_exec_command_begin, emit_exec_end); called by 1 (emit); 2 external calls (new, format_exec_output_str).


##### `emit_exec_end`  (lines 536–564)

```
async fn emit_exec_end(
    ctx: ToolEventCtx<'_>,
    exec_input: ExecCommandInput<'_>,
    exec_result: ExecCommandResult,
)
```

**Purpose**: Sends an `ExecCommandEnd` protocol event containing the final exec metadata and formatted output. It is the terminal transport step for exec lifecycle reporting.

**Data flow**: Takes `ToolEventCtx`, borrowed `ExecCommandInput`, and owned `ExecCommandResult` → builds `ExecCommandEndEvent` with cloned command/cwd/parsed_cmd, `call_id`, `turn_id`, `completed_at_ms = now_unix_timestamp_ms()`, optional process id and interaction input, stdout/stderr/aggregated output, exit code, duration, formatted output, and status → wraps in `EventMsg::ExecCommandEnd` and awaits `session.send_event(...)`.

**Call relations**: Called only by `emit_exec_stage` after it has normalized the stage into an `ExecCommandResult`. It delegates actual event delivery to `Session::send_event`.

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

**Purpose**: Emits the completed file-change turn item for an apply-patch operation and updates/emits turn diff state when a tracker is present. It is the patch-side counterpart to `emit_exec_end`.

**Data flow**: Takes `ToolEventCtx`, owned `changes`, `stdout`, `stderr`, `status`, and `tracker_update` → first awaits `session.emit_turn_item_completed(...)` with `TurnItem::FileChange(FileChangeItem { id, changes, status: Some(status), auto_approved: None, stdout: Some(stdout), stderr: Some(stderr) })`. If `ctx.turn_diff_tracker` exists, it locks the tracker, records whether a unified diff previously existed, applies `tracker_update` by either `track_delta`, `invalidate`, or no-op, fetches `get_unified_diff()`, computes whether a `TurnDiff` event should be emitted, drops the lock, and if needed sends `EventMsg::TurnDiff(TurnDiffEvent { unified_diff })`.

**Call relations**: This helper is called from `ToolEmitter::emit` for apply-patch success/failure stages and directly from tests. It delegates diff-state mutation to `TurnDiffTracker` methods and event transport to `Session` methods.

*Call graph*: called by 3 (emit, invalidation_emits_empty_turn_diff, net_zero_patch_emits_empty_turn_diff); 2 external calls (FileChange, TurnDiff).


##### `tests::assert_failed_apply_patch_tracks_committed_delta`  (lines 636–695)

```
async fn assert_failed_apply_patch_tracks_committed_delta(
        out: Result<ExecToolCallOutput, ToolError>,
        expected_status: PatchApplyStatus,
    )
```

**Purpose**: Shared async test helper that verifies a failed apply-patch operation still emits a file-change completion event and a turn diff containing the committed patch prefix. It covers the subtle case where failure happens after partial patch application.

**Data flow**: Creates a test session/turn/event receiver, a fresh `TurnDiffTracker`, and a temp directory; applies a patch to produce a real `AppliedPatchDelta`; constructs `ToolEmitter::ApplyPatch { ... }`; calls `.finish(...)` with the supplied failing `out` and `Some(&delta)` and expects an error; then reads events from the receiver, asserting the completed item has the expected `PatchApplyStatus` and that a later `TurnDiff` event contains the patched file path and added line.

**Call relations**: This helper is called by the denied and rejected apply-patch tests below. It exercises `ToolEventCtx::new`, `ToolEmitter::finish`, and the patch diff emission path end-to-end.

*Call graph*: calls 4 internal fn (make_session_and_context_with_dynamic_tools_and_rx, new, new, from_absolute_path); 9 external calls (new, from_secs, new, new, new, assert!, apply_patch, tempdir, timeout).


##### `tests::denied_apply_patch_tracks_committed_delta`  (lines 698–711)

```
async fn denied_apply_patch_tracks_committed_delta()
```

**Purpose**: Verifies that a sandbox-denied apply-patch still tracks and emits the committed delta as a failed patch. It covers the special `SandboxErr::Denied` branch in `ToolEmitter::finish`.

**Data flow**: Builds an `ExecToolCallOutput` with `exit_code = 1`, wraps it in `ToolError::Codex(CodexErr::Sandbox(SandboxErr::Denied { ... }))`, and passes it to `assert_failed_apply_patch_tracks_committed_delta(..., PatchApplyStatus::Failed)`.

**Call relations**: This test delegates all setup and assertions to `assert_failed_apply_patch_tracks_committed_delta`. It specifically targets the denied-sandbox branch in `ToolEmitter::finish`.

*Call graph*: 5 external calls (new, default, assert_failed_apply_patch_tracks_committed_delta, Codex, Sandbox).


##### `tests::rejected_apply_patch_tracks_committed_delta`  (lines 714–720)

```
async fn rejected_apply_patch_tracks_committed_delta()
```

**Purpose**: Verifies that a user-rejected apply-patch still emits the committed delta and marks the patch as declined. It covers the rejection normalization path for patch tools.

**Data flow**: Constructs `Err(ToolError::Rejected("rejected by user".to_string()))` and passes it to `assert_failed_apply_patch_tracks_committed_delta(..., PatchApplyStatus::Declined)`.

**Call relations**: This test reuses the shared helper and specifically exercises the `ToolError::Rejected` branch in `ToolEmitter::finish` for apply-patch emitters.

*Call graph*: 2 external calls (assert_failed_apply_patch_tracks_committed_delta, Rejected).


##### `tests::net_zero_patch_emits_empty_turn_diff`  (lines 723–773)

```
async fn net_zero_patch_emits_empty_turn_diff()
```

**Purpose**: Checks that tracking an add patch followed by a delete patch results in an empty unified diff on the second emission. It validates that exact net-zero patch state is represented as an empty diff rather than stale previous content.

**Data flow**: Creates a test session, turn, receiver, tracker, and temp cwd → for each of two patches (add then delete), applies the patch to get a delta, calls `emit_patch_end(...)` with `TurnDiffTrackerUpdate::Track { delta }`, consumes the item-completed event, then reads until a `TurnDiff` event arrives and asserts the first diff contains `+one` while the second equals `""`.

**Call relations**: This test calls `ToolEventCtx::new` and `emit_patch_end` directly rather than going through `ToolEmitter::finish`. It targets the tracker-update and diff-emission logic in isolation.

*Call graph*: calls 5 internal fn (make_session_and_context_with_dynamic_tools_and_rx, new, emit_patch_end, new, from_absolute_path); 9 external calls (new, new, new, new, new, assert!, assert_eq!, apply_patch, tempdir).


##### `tests::invalidation_emits_empty_turn_diff`  (lines 776–814)

```
async fn invalidation_emits_empty_turn_diff()
```

**Purpose**: Verifies that invalidating a tracker with existing diff state emits an empty turn diff. It protects the branch where patch state becomes unknown and must clear previously tracked changes.

**Data flow**: Creates a test session, turn, receiver, tracker, and temp cwd → applies a patch to get a delta and manually tracks it in the tracker → calls `emit_patch_end(...)` with `TurnDiffTrackerUpdate::Invalidate` → consumes the item-completed event, then waits for a `TurnDiff` event and asserts `unified_diff == ""`.

**Call relations**: This test directly exercises `emit_patch_end` and the `TurnDiffTrackerUpdate::Invalidate` branch. It confirms that invalidation produces a clearing diff event when prior diff state existed.

*Call graph*: calls 5 internal fn (make_session_and_context_with_dynamic_tools_and_rx, new, emit_patch_end, new, from_absolute_path); 8 external calls (new, new, new, new, new, assert_eq!, apply_patch, tempdir).


### `core/src/turn_diff_tracker.rs`

`domain_logic` · `during a turn after apply_patch mutations; queried when reporting accumulated workspace changes`

This module maintains an in-memory model of file contents before and after patch application so tools can report a turn-level unified diff cheaply. `TurnDiffTracker` stores baseline and current `TrackedContent` keyed by `TrackedPath`, where a tracked path combines `environment_id` and filesystem path so identical absolute paths in different environments remain distinct. Each stored content gets a monotonically increasing revision number; those revisions feed `DiffCacheKey`, allowing rendered file diffs to be reused when untouched paths survive later updates.

`track_delta` accepts only exact `AppliedPatchDelta` values. Any inexact delta invalidates the tracker, clearing cached diffs and suppressing future unified-diff output. Exact deltas are decomposed into `AppliedPatchChange` values and applied incrementally through `apply_add`, `apply_delete`, and `apply_update`. The update path also tracks renames via `origin_by_current_path`, preserving source-to-destination lineage so `refresh_unified_diff` can pair pure moves and moved edits correctly.

When refreshing, the tracker sorts all touched paths by display path, skips duplicate handling, detects rename pairs, and either reuses a cached rendered diff or calls `render_diff`. Rendering computes Git-style blob OIDs, emits `diff --git`, mode lines for adds/deletes, `index` lines, and a unified diff generated by `similar::TextDiff` with a 100 ms timeout. The timeout is a deliberate design choice: pathological rewrites fall back to a coarse but content-exact diff without stalling tool completion. Display paths can be relativized against per-environment roots and prefixed with environment ids when multiple environments are present.

#### Function details

##### `TrackedPath::new`  (lines 32–37)

```
fn new(environment_id: &str, path: &Path) -> Self
```

**Purpose**: Constructs a tracked path key from an environment id and filesystem path. This key is the unit of diff tracking across environments.

**Data flow**: Copies `environment_id` into a `String`, clones the provided `Path` into a `PathBuf`, and returns a new `TrackedPath`.

**Call relations**: Used when applying patch changes and in a large-file test that calls `render_diff` directly.

*Call graph*: called by 2 (apply_change, large_rewrite_returns_promptly_and_preserves_exact_content); 1 external calls (to_path_buf).


##### `TurnDiffTracker::default`  (lines 64–77)

```
fn default() -> Self
```

**Purpose**: Creates an initially valid tracker with empty baseline/current state, no cached diffs, and revision counter zero.

**Data flow**: Initializes all maps empty, `valid = true`, `next_revision = 0`, `unified_diff = None`, and in tests initializes `rendered_diff_count` to zero. Returns the new tracker.

**Call relations**: Backs `TurnDiffTracker::new` and is also used indirectly wherever a fresh tracker is needed for tool invocations or tests.

*Call graph*: called by 2 (invocation, multi_agent_v2_request_user_input_rejects_subagent_threads); 2 external calls (new, new).


##### `TurnDiffTracker::new`  (lines 81–83)

```
fn new() -> Self
```

**Purpose**: Convenience constructor returning the default tracker state.

**Data flow**: Calls `Self::default()` and returns the resulting `TurnDiffTracker`.

**Call relations**: Used widely when creating per-invocation diff trackers and by helper constructors such as `with_environment_display_roots`.

*Call graph*: called by 30 (fatal_tool_error_stops_turn_and_reports_error, guardian_allows_shell_command_additional_permissions_requests_past_policy_validation, guardian_allows_unified_exec_additional_permissions_requests_past_policy_validation, shell_command_allows_sticky_turn_permissions_without_inline_request_permissions_feature, strict_auto_review_turn_grant_forces_guardian_for_shell_command_policy_skip, rejects_escalated_permissions_when_policy_not_on_request, request_permissions_tool_rejects_unknown_environment_id, request_permissions_tool_resolves_relative_paths_against_selected_environment, test_tool_runtime, unified_exec_rejects_escalated_permissions_when_policy_not_on_request (+15 more)); 1 external calls (default).


##### `TurnDiffTracker::with_environment_display_roots`  (lines 85–91)

```
fn with_environment_display_roots(
        display_roots: impl IntoIterator<Item = (String, PathBuf)>,
    ) -> Self
```

**Purpose**: Creates a tracker whose rendered diff paths are relativized against configured display roots per environment.

**Data flow**: Starts from `Self::new()`, collects the provided `(String, PathBuf)` iterator into `display_roots_by_environment`, stores it, and returns the tracker.

**Call relations**: Used by runtime code and tests that need stable relative paths or multi-environment path prefixes in rendered diffs.

*Call graph*: called by 3 (run_turn, tracker_with_root, tracks_same_absolute_path_across_multiple_environments); 2 external calls (into_iter, new).


##### `TurnDiffTracker::track_delta`  (lines 93–107)

```
fn track_delta(&mut self, environment_id: &str, delta: &AppliedPatchDelta)
```

**Purpose**: Applies one committed patch delta to the tracker and refreshes the aggregate unified diff, unless the tracker has already been invalidated.

**Data flow**: Reads `self.valid`; if false it returns immediately. It checks `delta.is_exact()`, invalidates and returns on inexact deltas, otherwise iterates `delta.changes()`, applies each change with `apply_change`, then recomputes the aggregate via `refresh_unified_diff`.

**Call relations**: This is the main mutation entrypoint used after successful `apply_patch` operations.

*Call graph*: calls 5 internal fn (changes, is_exact, apply_change, invalidate, refresh_unified_diff).


##### `TurnDiffTracker::invalidate`  (lines 109–113)

```
fn invalidate(&mut self)
```

**Purpose**: Marks the tracker unusable for unified-diff reporting after an inexact or otherwise unsupported mutation sequence.

**Data flow**: Sets `valid` to false, clears `rendered_diffs`, and sets `unified_diff` to `None`.

**Call relations**: Called by `track_delta` when a delta is not exact; tests also verify its effect directly.

*Call graph*: called by 1 (track_delta).


##### `TurnDiffTracker::get_unified_diff`  (lines 115–117)

```
fn get_unified_diff(&self) -> Option<String>
```

**Purpose**: Returns the current aggregate unified diff string, if one exists.

**Data flow**: Clones `self.unified_diff` and returns the clone as `Option<String>`.

**Call relations**: Queried by callers and tests after one or more tracked patch applications.


##### `TurnDiffTracker::has_unified_diff`  (lines 119–121)

```
fn has_unified_diff(&self) -> bool
```

**Purpose**: Cheaply reports whether an aggregate unified diff is currently available.

**Data flow**: Checks `self.unified_diff.is_some()` and returns that boolean.

**Call relations**: Used by callers that only need presence/absence rather than the diff text.


##### `TurnDiffTracker::refresh_unified_diff`  (lines 123–183)

```
fn refresh_unified_diff(&mut self)
```

**Purpose**: Rebuilds the aggregate unified diff from tracked baseline/current state while reusing cached per-path rendered diffs whenever revisions have not changed.

**Data flow**: Computes rename pairs, gathers and sorts all baseline/current paths by `display_path`, deduplicates them, swaps out the previous `rendered_diffs` cache, then for each unhandled path chooses either a same-path diff or a rename-paired diff. It builds a `DiffCacheKey` from paths and content revisions, reuses a cached rendered diff if present or calls `render_diff`, concatenates non-empty diffs into `aggregated`, stores the new cache map, and sets `self.unified_diff` to `Some(aggregated)` only if non-empty.

**Call relations**: Called after every exact tracked delta. It is the core aggregation and caching routine of the tracker.

*Call graph*: calls 1 internal fn (rename_pairs); called by 1 (track_delta); 4 external calls (new, new, new, take).


##### `TurnDiffTracker::apply_change`  (lines 185–211)

```
fn apply_change(&mut self, environment_id: &str, change: &AppliedPatchChange)
```

**Purpose**: Dispatches one `AppliedPatchChange` to the appropriate add, delete, or update handler after attaching the environment id to its path fields.

**Data flow**: Builds a `TrackedPath` for `change.path`, pattern-matches `change.change`, and calls `apply_add`, `apply_delete`, or `apply_update`. For updates with `move_path`, it converts the destination path into an optional `TrackedPath` before delegating.

**Call relations**: Used only by `track_delta` while iterating exact patch changes.

*Call graph*: calls 4 internal fn (new, apply_add, apply_delete, apply_update); called by 1 (track_delta).


##### `TurnDiffTracker::apply_add`  (lines 213–225)

```
fn apply_add(&mut self, path: TrackedPath, content: &str, overwritten_content: Option<&str>)
```

**Purpose**: Updates tracker state for an added file, including the special case where the add overwrote an existing file and should therefore preserve baseline content.

**Data flow**: Removes any rename-origin mapping for the path. If the path is absent from both current and baseline state and `overwritten_content` is provided, it stores that overwritten content in `baseline_by_path`. It then stores the new content in `current_by_path` using a fresh tracked revision.

**Call relations**: Called from `apply_change` for `AppliedPatchFileChange::Add`.

*Call graph*: calls 1 internal fn (tracked_content); called by 1 (apply_change); 1 external calls (clone).


##### `TurnDiffTracker::apply_delete`  (lines 227–235)

```
fn apply_delete(&mut self, path: TrackedPath, content: &str)
```

**Purpose**: Updates tracker state for a deleted file, preserving baseline content if the file had not previously been tracked in this turn.

**Data flow**: Attempts to remove the path from `current_by_path`; if nothing was present and no baseline exists yet, it stores the provided deleted content in `baseline_by_path`. It also removes any rename-origin mapping for the path.

**Call relations**: Called from `apply_change` for `AppliedPatchFileChange::Delete`.

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

**Purpose**: Updates tracker state for in-place edits and moves, preserving original baseline content and tracking rename lineage across repeated moves.

**Data flow**: If the source path has never been seen, it stores `old_content` in `baseline_by_path`. For moves, it may also preserve overwritten destination content in baseline, resolves the original source from `origin_by_current_path`, removes current content at the source, inserts new content at the destination with a fresh revision, and updates `origin_by_current_path` so the destination points back to the original source when they differ. For non-moves, it simply replaces current content at the source path.

**Call relations**: Called from `apply_change` for `AppliedPatchFileChange::Update`; it is responsible for rename-aware diff semantics.

*Call graph*: calls 1 internal fn (tracked_content); called by 1 (apply_change); 1 external calls (clone).


##### `TurnDiffTracker::tracked_content`  (lines 282–289)

```
fn tracked_content(&mut self, content: &str) -> TrackedContent
```

**Purpose**: Wraps a content string with a fresh monotonically increasing revision number for cache invalidation.

**Data flow**: Reads `self.next_revision`, increments it, clones the input string into owned `content`, and returns `TrackedContent { content, revision }`.

**Call relations**: Used by add, delete, and update handlers whenever new baseline or current content snapshots are stored.

*Call graph*: called by 3 (apply_add, apply_delete, apply_update).


##### `TurnDiffTracker::rename_pairs`  (lines 291–307)

```
fn rename_pairs(&self) -> HashMap<TrackedPath, TrackedPath>
```

**Purpose**: Derives source-to-destination rename pairs that should be rendered as a single diff rather than separate delete/add entries.

**Data flow**: Iterates `origin_by_current_path` and filters to cases where destination differs from origin, the origin no longer exists in current state, the destination exists in current state, the origin exists in baseline, and the destination does not already exist in baseline. It returns a `HashMap<TrackedPath, TrackedPath>` from origin to destination.

**Call relations**: Used by `refresh_unified_diff` to pair moved files before rendering.

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

**Purpose**: Renders one Git-style unified diff between optional left and right file contents, including add/delete metadata and blob object ids.

**Data flow**: If left and right contents are equal it returns `None`. Otherwise it computes display paths, derives left/right blob OIDs using `git_blob_oid` or `ZERO_OID`, writes `diff --git`, optional mode lines, and `index` lines, chooses `a/...` or `/dev/null` headers based on file presence, then uses `similar::TextDiff::configure().timeout(DIFF_TIMEOUT)` to generate a unified diff with context radius 3. It returns the assembled diff string in `Some(...)`.

**Call relations**: Called by `refresh_unified_diff` when a cached rendered diff is unavailable; tests also call it directly for the large-rewrite timeout case.

*Call graph*: calls 1 internal fn (display_path); 2 external calls (format!, configure).


##### `TurnDiffTracker::rendered_diff_count`  (lines 369–371)

```
fn rendered_diff_count(&self) -> usize
```

**Purpose**: Test-only accessor exposing how many times `render_diff` has actually rendered a diff.

**Data flow**: Reads the `Cell<usize>` test counter and returns its current value.

**Call relations**: Used by caching tests to prove unchanged paths do not rerender.


##### `TurnDiffTracker::display_path`  (lines 373–385)

```
fn display_path(&self, path: &TrackedPath) -> String
```

**Purpose**: Computes the path string shown in rendered diffs, optionally relativized to an environment root and prefixed with the environment id when multiple environments are tracked.

**Data flow**: Looks up the environment's display root, strips it from `path.path` when possible, converts the resulting path to a slash-normalized string, and if more than one environment root exists and the environment id is non-empty, prefixes the display path with `environment_id/`.

**Call relations**: Used by `render_diff` to produce stable, human-readable diff headers.

*Call graph*: called by 1 (render_diff); 1 external calls (format!).


##### `git_blob_oid`  (lines 388–390)

```
fn git_blob_oid(data: &[u8]) -> String
```

**Purpose**: Formats the Git SHA-1 blob object id for a byte slice as lowercase hexadecimal.

**Data flow**: Calls `git_blob_sha1_hex_bytes(data)` and formats the resulting digest with `{:x}` into a `String`.

**Call relations**: Used by `render_diff` when constructing `index` lines.

*Call graph*: 1 external calls (format!).


##### `git_blob_sha1_hex_bytes`  (lines 393–400)

```
fn git_blob_sha1_hex_bytes(data: &[u8]) -> Output<sha1::Sha1>
```

**Purpose**: Computes the Git blob SHA-1 digest by hashing the `blob <len>\0` header followed by the raw content bytes.

**Data flow**: Builds the Git blob header string from `data.len()`, initializes a `sha1::Sha1` hasher, updates it with the header bytes and content bytes, finalizes the digest, and returns the raw `Output<sha1::Sha1>`.

**Call relations**: Used by `git_blob_oid` and by tests that independently compute expected blob ids.

*Call graph*: 2 external calls (format!, new).


### `core/src/agent/status.rs`

`domain_logic` · `event processing and agent lifecycle tracking`

This file contains two compact but central helpers for agent lifecycle tracking. `agent_status_from_event` inspects a single `codex_protocol::protocol::EventMsg` and returns an `Option<AgentStatus>` only for events that should advance externally visible status. The mapping is explicit: `TurnStarted` becomes `Running`; `TurnComplete` becomes `Completed` carrying the event’s `last_agent_message`; `TurnAborted` becomes `Interrupted` for `Interrupted` and `BudgetLimited` abort reasons but becomes `Errored` with a debug-formatted reason string for all other abort causes; `Error` becomes `Errored` with the event message; and `ShutdownComplete` becomes `Shutdown`. All other event variants are ignored by returning `None`, which lets callers process noisy event streams without changing status on every message.

`is_final` defines the terminal-state predicate used by higher-level watchers and cleanup logic. It treats `PendingInit`, `Running`, and `Interrupted` as non-final, and everything else as final. The notable design choice is that `Interrupted` is intentionally non-terminal here, allowing later transitions such as shutdown or completion-like cleanup to continue being observed by callers waiting for a definitive end state.

#### Function details

##### `agent_status_from_event`  (lines 6–21)

```
fn agent_status_from_event(msg: &EventMsg) -> Option<AgentStatus>
```

**Purpose**: Translates one protocol event into the next tracked `AgentStatus` when that event is status-relevant. Events that do not affect lifecycle state are ignored.

**Data flow**: Takes `&EventMsg`, pattern-matches on its variant, clones payload data where needed (`last_agent_message` or `message`), formats non-interruption abort reasons with `format!("{:?}", ev.reason)`, and returns `Some(AgentStatus::...)` or `None`.

**Call relations**: Status-tracking code feeds emitted events through this helper to derive state transitions without embedding protocol-specific matching logic everywhere.

*Call graph*: 3 external calls (format!, Completed, Errored).


##### `is_final`  (lines 23–28)

```
fn is_final(status: &AgentStatus) -> bool
```

**Purpose**: Determines whether an `AgentStatus` should be treated as terminal by watchers, cleanup routines, and parent-notification logic.

**Data flow**: Accepts `&AgentStatus`, checks it against a `matches!` pattern for the three non-final variants (`PendingInit`, `Running`, `Interrupted`), negates that result, and returns a `bool`.

**Call relations**: Multiple lifecycle-management paths call this predicate when deciding whether to stop waiting, notify parents, recover running items, or collect finished threads.

*Call graph*: called by 6 (maybe_start_completion_watcher, maybe_notify_parent_of_terminal_turn, find_finished_threads, recover_running_items, handle_call, wait_for_final_status); 1 external calls (matches!).


### `core/src/event_mapping.rs`

`domain_logic` · `cross-cutting`

This file sits at the boundary between raw model/session history and user-visible turn items. It first defines contextual-fragment classifiers. `is_contextual_user_message_content` delegates to `is_contextual_user_fragment` over message content, while developer contextuality is recognized by `is_contextual_dev_fragment`, which checks `ContentItem::InputText` prefixes against a fixed list including permissions instructions, model-switch tags, collaboration mode, realtime conversation tags, skills instructions, personality spec, and token budget. `has_non_contextual_dev_message_content` is the companion predicate used when a developer message mixes rollback-trimmable fragments with persistent text.

The parsing functions then convert `ResponseItem`s into `TurnItem`s. `parse_user_message` rejects contextual user messages entirely, then walks content items to build `Vec<UserInput>`, preserving text and images but skipping synthetic image label/open/close tag text when it directly surrounds an `InputImage`. Unexpected `OutputText` in a user message is logged. `parse_agent_message` accepts both `InputText` and `OutputText` for backward compatibility, converts them into `AgentMessageContent::Text`, warns on other content types, and synthesizes a UUID when the source message lacks an id.

`parse_turn_item` is the public dispatcher. It maps user messages first through `parse_visible_hook_prompt_message` so hook prompts become distinct `TurnItem::HookPrompt` values even when mixed with other contextual fragments; otherwise it falls back to `parse_user_message`. Assistant messages become `TurnItem::AgentMessage`, system and unknown roles are hidden, reasoning items are converted into summary/raw-content vectors, web search calls become `WebSearchItem`s with derived query text from `web_search_action_detail`, and image-generation calls are surfaced with their status, revised prompt, and result.

#### Function details

##### `is_contextual_user_message_content`  (lines 38–40)

```
fn is_contextual_user_message_content(message: &[ContentItem]) -> bool
```

**Purpose**: Determines whether any content item in a user message is a contextual fragment rather than visible user input.

**Data flow**: Iterates over `message: &[ContentItem]`, applies `is_contextual_user_fragment` to each item, and returns true if any item matches.

**Call relations**: Used by rollback logic, turn-boundary detection, transcript rendering, and user-message parsing.

*Call graph*: called by 5 (trim_pre_turn_context_updates, is_user_turn_boundary, parse_user_message, collect_guardian_transcript_entries, build_current_thread_section); 1 external calls (iter).


##### `is_contextual_dev_message_content`  (lines 47–49)

```
fn is_contextual_dev_message_content(message: &[ContentItem]) -> bool
```

**Purpose**: Determines whether a developer message contains any rollback-trimmable contextual fragment.

**Data flow**: Iterates over `message: &[ContentItem]`, applies `is_contextual_dev_fragment`, and returns true if any fragment matches.

**Call relations**: Used by rollback trimming to identify developer updates that should be removed with a rolled-back turn.

*Call graph*: called by 1 (trim_pre_turn_context_updates); 1 external calls (iter).


##### `has_non_contextual_dev_message_content`  (lines 53–57)

```
fn has_non_contextual_dev_message_content(message: &[ContentItem]) -> bool
```

**Purpose**: Determines whether a developer message contains any fragment outside the contextual-prefix set.

**Data flow**: Iterates over `message: &[ContentItem]` and returns true if any item does not satisfy `is_contextual_dev_fragment`.

**Call relations**: Used during rollback to decide whether trimming a developer message invalidates the stored reference context baseline.

*Call graph*: called by 1 (trim_pre_turn_context_updates); 1 external calls (iter).


##### `is_contextual_dev_fragment`  (lines 59–70)

```
fn is_contextual_dev_fragment(content_item: &ContentItem) -> bool
```

**Purpose**: Checks whether one content item is a developer contextual fragment based on case-insensitive tag-prefix matching.

**Data flow**: Accepts one `ContentItem`; non-`InputText` items return false. For text items, it trims leading whitespace and compares the start of the string against each entry in `CONTEXTUAL_DEVELOPER_PREFIXES` using case-insensitive prefix matching.

**Call relations**: Private helper behind both developer contextuality predicates.


##### `parse_user_message`  (lines 72–109)

```
fn parse_user_message(message: &[ContentItem]) -> Option<UserMessageItem>
```

**Purpose**: Converts a visible user `Message` into a `UserMessageItem`, skipping contextual messages and synthetic image-label text.

**Data flow**: Takes `&[ContentItem]`. If `is_contextual_user_message_content` is true, returns `None`. Otherwise it iterates with indices, converts `InputText` into `UserInput::Text` unless the text is an image open/close tag adjacent to an `InputImage`, converts `InputImage` into `UserInput::Image`, warns on `OutputText`, and returns `Some(UserMessageItem::new(&content))`.

**Call relations**: Called by `parse_turn_item` for user-role messages after hook-prompt parsing is attempted.

*Call graph*: calls 6 internal fn (is_contextual_user_message_content, new, is_image_close_tag_text, is_image_open_tag_text, is_local_image_close_tag_text, is_local_image_open_tag_text); 4 external calls (new, matches!, iter, warn!).


##### `parse_agent_message`  (lines 111–137)

```
fn parse_agent_message(
    id: Option<&String>,
    message: &[ContentItem],
    phase: Option<MessagePhase>,
) -> AgentMessageItem
```

**Purpose**: Converts an assistant message into an `AgentMessageItem`, preserving text content and tolerating legacy `InputText` payloads.

**Data flow**: Takes optional id, content slice, and optional `MessagePhase`. It iterates content items, converts `InputText` and `OutputText` into `AgentMessageContent::Text`, warns on anything else, chooses the provided id or generates a UUID, and returns `AgentMessageItem { id, content, phase, memory_citation: None }`.

**Call relations**: Used by `parse_turn_item` for assistant-role messages.

*Call graph*: called by 1 (parse_turn_item); 3 external calls (new, iter, warn!).


##### `parse_turn_item`  (lines 139–214)

```
fn parse_turn_item(item: &ResponseItem) -> Option<TurnItem>
```

**Purpose**: Maps one raw `ResponseItem` into an optional higher-level `TurnItem` suitable for visible transcript rendering.

**Data flow**: Pattern-matches the input item. User messages are first parsed as visible hook prompts via `parse_visible_hook_prompt_message`; if that fails, they are parsed as visible user messages via `parse_user_message`. Assistant messages become `TurnItem::AgentMessage(parse_agent_message(...))`; system and unknown-role messages return `None`. Reasoning items are converted into summary and raw-content vectors, web search calls become `TurnItem::WebSearch` with derived query/action, image-generation calls become `TurnItem::ImageGeneration`, and all other variants return `None`.

**Call relations**: Called by transcript-building code that needs to hide contextual scaffolding and expose only meaningful turn items.

*Call graph*: calls 2 internal fn (parse_agent_message, web_search_action_detail); called by 1 (insert_initial_context_before_last_real_user_or_summary); 6 external calls (new, AgentMessage, ImageGeneration, Reasoning, WebSearch, parse_visible_hook_prompt_message).


### `core/src/stream_events_utils.rs`

`domain_logic` · `streamed response handling during active turns`

This file contains the stream-finalization logic used when model output items complete. It covers several distinct concerns. First, it sanitizes assistant text: `strip_hidden_assistant_markup` and its memory-citation variant remove hidden citation markup and, in plan mode, `<proposed_plan>` blocks; `raw_assistant_output_text_from_item` extracts concatenated assistant output text from `ResponseItem::Message`. Second, it persists image-generation results under a host-owned path rooted at `codex_home/generated_images/<sanitized-session>/<sanitized-call>.png`, decoding only standard base64 and rejecting malformed payloads. Completed image items can also trigger an instructional conversation item telling the user where generated images are stored.

Third, it records completed response items into session history immediately, then performs side effects: deferring mailbox delivery to the next turn after visible final output, marking thread memory mode polluted when external-context items appear and memory disabling is configured, and recording stage-1 memory usage for cited threads via the optional `StateDbHandle`. Fourth, it converts non-tool `ResponseItem`s into `TurnItem`s, optionally runs extension `TurnItemContributor`s, strips hidden assistant markup into visible agent text, preserves or parses `MemoryCitation`, and persists completed image artifacts.

The central control flow is `handle_output_item_done`. It first asks `ToolRouter::build_tool_call` whether the item is a tool call. Tool calls are logged, persisted, and turned into an in-flight future. Non-tool items are finalized into turn items, emitted as started/completed events, and recorded with precomputed facts such as `last_agent_message` and whether mailbox delivery should now defer. Tool-call errors split into recoverable `RespondToModel`, which synthesizes a `FunctionCallOutput` transcript item and requests a follow-up, and fatal errors, which become `CodexErr::Fatal`.

#### Function details

##### `image_generation_artifact_path`  (lines 42–68)

```
fn image_generation_artifact_path(
    codex_home: &AbsolutePathBuf,
    session_id: &str,
    call_id: &str,
) -> AbsolutePathBuf
```

**Purpose**: Builds the canonical filesystem path where a generated image artifact should be stored under the session's codex home. It sanitizes both session ID and call ID so the path cannot escape the intended directory structure.

**Data flow**: It takes `&AbsolutePathBuf codex_home`, `&str session_id`, and `&str call_id`. A local sanitizer maps non-ASCII-alphanumeric/non-`-`/`_` characters to `_` and substitutes `generated_image` if the sanitized string is empty. The function then joins `codex_home`, the constant `generated_images`, the sanitized session ID, and a `"<sanitized-call>.png"` filename, returning the resulting `AbsolutePathBuf`.

**Call relations**: Used by image save, persistence, instruction-recording, and tests so all image-related paths are derived consistently. It is the shared path-construction primitive for the image-generation flow.

*Call graph*: calls 1 internal fn (join); called by 6 (handle_output_item_done_records_image_save_history_message, handle_output_item_done_skips_image_save_message_when_save_fails, persist_image_generation_item, record_image_generation_instructions, save_image_generation_result, image_generation_publication_is_finalized_by_core); 1 external calls (format!).


##### `strip_hidden_assistant_markup`  (lines 70–77)

```
fn strip_hidden_assistant_markup(text: &str, plan_mode: bool) -> String
```

**Purpose**: Removes hidden assistant-only markup from a text string, including memory citations and optionally proposed-plan blocks. It produces the visible text that should be shown or analyzed.

**Data flow**: It takes `&str text` and a `bool plan_mode`, calls `strip_citations` to remove citation markup, and if `plan_mode` is true further passes the result through `strip_proposed_plan_blocks`. It returns the cleaned `String`.

**Call relations**: Used by `last_assistant_message_from_item` when deciding whether an assistant message contains visible final text. It encapsulates the shared stripping rules outside of full turn-item finalization.

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

**Purpose**: Produces visible assistant text while also parsing any stripped memory citation into structured form. This lets finalization both clean the text and preserve citation metadata.

**Data flow**: It takes `&str text` and `bool plan_mode`, calls `strip_citations` to obtain citation-free text plus raw citation payload, optionally strips proposed-plan blocks in plan mode, parses the citation payload with `parse_memory_citation`, and returns `(visible_text, Option<MemoryCitation>)`.

**Call relations**: Called by `finalize_turn_item` when converting an assistant `TurnItem` into its final visible form. It combines two operations that must stay in sync: hidden-markup removal and memory-citation extraction.

*Call graph*: calls 1 internal fn (parse_memory_citation); called by 1 (finalize_turn_item); 2 external calls (strip_citations, strip_proposed_plan_blocks).


##### `raw_assistant_output_text_from_item`  (lines 95–109)

```
fn raw_assistant_output_text_from_item(item: &ResponseItem) -> Option<String>
```

**Purpose**: Extracts the concatenated raw output text from an assistant `ResponseItem::Message`. It ignores non-assistant messages and non-text content items.

**Data flow**: It takes `&ResponseItem`, pattern-matches for `ResponseItem::Message` with `role == "assistant"`, filters `content` for `ContentItem::OutputText`, concatenates their `text` fields into one `String`, and returns `Some(combined)`. For all other items it returns `None`.

**Call relations**: Used by memory-citation detection, last-message extraction, and other stream accounting paths that need the raw assistant text before turn-item conversion. It is a low-level extractor shared across several helpers.

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

**Purpose**: Decodes a completed image-generation payload and writes it to the canonical PNG artifact path on disk. It rejects malformed payloads as invalid requests.

**Data flow**: It takes codex home, session ID, call ID, and the base64 `result` string. The function trims and decodes the payload with standard base64, mapping decode failures to `CodexErr::InvalidRequest`; computes the output path with `image_generation_artifact_path`; creates parent directories if needed; writes the decoded bytes to the file; and returns `Result<AbsolutePathBuf>` with the saved path.

**Call relations**: Called only by `persist_image_generation_item` as the actual disk-write step for completed image items. It centralizes validation and filesystem I/O so callers can handle success/failure uniformly.

*Call graph*: calls 1 internal fn (image_generation_artifact_path); called by 1 (persist_image_generation_item); 2 external calls (create_dir_all, write).


##### `persist_image_generation_item`  (lines 130–166)

```
async fn persist_image_generation_item(
    sess: &Session,
    turn_context: &TurnContext,
    image_item: &mut ImageGenerationItem,
) -> Option<AbsolutePathBuf>
```

**Purpose**: Attempts to persist a completed `ImageGenerationItem` to disk and updates the item's `saved_path` field on success. On failure it logs a warning and leaves the item unsaved.

**Data flow**: It takes `&Session`, `&TurnContext`, and `&mut ImageGenerationItem`. The function clears `image_item.saved_path`, derives the session ID from `sess.thread_id`, calls `save_image_generation_result`, and on success stores `Some(path.clone())` back into `image_item.saved_path` and returns `Some(path)`. On error it computes the intended output directory for logging, emits a warning with `call_id` and `output_dir`, and returns `None`.

**Call relations**: Invoked by `finalize_turn_item` when an image-generation turn item has status `completed`. It delegates actual decoding/writing to `save_image_generation_result` and handles the mutation/logging policy around failures.

*Call graph*: calls 2 internal fn (image_generation_artifact_path, save_image_generation_result); called by 1 (finalize_turn_item); 1 external calls (warn!).


##### `record_image_generation_instructions`  (lines 168–188)

```
async fn record_image_generation_instructions(
    sess: &Session,
    turn_context: &TurnContext,
    image_item: &ImageGenerationItem,
)
```

**Purpose**: Adds a contextual user-facing transcript item explaining where generated images are stored, but only after an image item has been successfully persisted. It records directory and filename pattern information rather than the raw image bytes.

**Data flow**: It takes `&Session`, `&TurnContext`, and `&ImageGenerationItem`. If `saved_path` is `None`, it returns early. Otherwise it derives the session ID, computes a representative output path using `"<image_id>"`, derives the containing directory, builds an `ImageGenerationInstructions` message converted into a `ResponseItem` via `ContextualUserFragment::into`, and records that single item with `sess.record_conversation_items`.

**Call relations**: Called by `handle_non_tool_response_item` after a non-tool response item has been finalized into a `TurnItem::ImageGeneration`. It depends on prior persistence having populated `saved_path`.

*Call graph*: calls 3 internal fn (into, new, image_generation_artifact_path); called by 1 (handle_non_tool_response_item); 1 external calls (record_conversation_items).


##### `record_completed_response_item`  (lines 191–203)

```
async fn record_completed_response_item(
    sess: &Session,
    turn_context: &TurnContext,
    item: &ResponseItem,
)
```

**Purpose**: Records a completed raw response item into conversation history and triggers the standard post-recording side effects using default fact derivation. It is the convenience entry point when no precomputed finalization facts are available.

**Data flow**: It takes `&Session`, `&TurnContext`, and `&ResponseItem`, then forwards them to `record_completed_response_item_with_finalized_facts` with `finalized_facts` set to `None`. It returns after awaiting that helper.

**Call relations**: Used by `handle_output_item_done` in branches where the caller has not already computed mailbox/memory facts. It exists to funnel all recording through the richer helper.

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

**Purpose**: Persists a completed raw response item and performs all associated side effects: mailbox deferral, external-context memory pollution marking, memory-citation usage recording, and per-turn memory-citation tracking. If finalization facts are supplied, it reuses them instead of recomputing.

**Data flow**: It takes session, turn context, the raw `ResponseItem`, and optional `&FinalizedTurnItemFacts`. It first records the item into conversation history. It then determines whether mailbox delivery should defer either from supplied facts or by calling `completed_item_defers_mailbox_delivery_to_next_turn`; if true, it asks `sess.input_queue` to defer mailbox delivery for the active turn/subturn. Next it calls `mark_thread_memory_mode_polluted_if_external_context`. For memory citations, it either records usage from the supplied `MemoryCitation` or detects one from the raw item via `record_stage1_output_usage_and_detect_memory_citation`. If a citation was present, it calls `sess.record_memory_citation_for_turn`. It returns `()`.

**Call relations**: This helper is the central post-persistence side-effect path, called directly by plan-mode handling and by `handle_output_item_done`, and indirectly via `record_completed_response_item`. It delegates mailbox, pollution, and memory-usage substeps to specialized helpers.

*Call graph*: calls 3 internal fn (mark_thread_memory_mode_polluted_if_external_context, record_stage1_output_usage_and_detect_memory_citation, record_stage1_output_usage_for_memory_citation); called by 3 (handle_assistant_item_done_in_plan_mode, handle_output_item_done, record_completed_response_item); 3 external calls (record_conversation_items, record_memory_citation_for_turn, from_ref).


##### `response_item_may_include_external_context`  (lines 246–253)

```
fn response_item_may_include_external_context(item: &ResponseItem) -> bool
```

**Purpose**: Classifies whether a raw response item may have introduced external context into the thread. Only web search and tool-search related items are treated as polluting.

**Data flow**: It takes `&ResponseItem`, matches it against `ToolSearchCall`, `ToolSearchOutput`, or `WebSearchCall`, and returns `true` for those variants and `false` otherwise.

**Call relations**: Used by `mark_thread_memory_mode_polluted_if_external_context` to gate whether the thread's memory mode should be marked polluted. Tests document both included and excluded variants.

*Call graph*: called by 1 (mark_thread_memory_mode_polluted_if_external_context); 1 external calls (matches!).


##### `mark_thread_memory_mode_polluted_if_external_context`  (lines 255–271)

```
async fn mark_thread_memory_mode_polluted_if_external_context(
    sess: &Session,
    turn_context: &TurnContext,
    item: &ResponseItem,
)
```

**Purpose**: Marks the thread's memory mode as polluted in the state DB when external-context items appear and the session configuration says memories should be disabled in that case. It is a no-op when the feature is disabled or the item is non-polluting.

**Data flow**: It takes `&Session`, `&TurnContext`, and `&ResponseItem`. If `turn_context.config.memories.disable_on_external_context` is false or `response_item_may_include_external_context(item)` is false, it returns early. Otherwise it calls `state_db::mark_thread_memory_mode_polluted` with the optional DB handle, thread ID, and the reason string `"record_completed_response_item"`, then awaits completion.

**Call relations**: Called during completed-item recording and also from in-flight draining paths. It delegates the actual persistence/update to the rollout state DB layer.

*Call graph*: calls 2 internal fn (response_item_may_include_external_context, mark_thread_memory_mode_polluted); called by 2 (drain_in_flight, record_completed_response_item_with_finalized_facts).


##### `record_stage1_output_usage_and_detect_memory_citation`  (lines 273–286)

```
async fn record_stage1_output_usage_and_detect_memory_citation(
    state_db_ctx: Option<&state_db::StateDbHandle>,
    item: &ResponseItem,
) -> bool
```

**Purpose**: Detects a memory citation embedded in an assistant message's raw text and, if found, records stage-1 output usage for the cited threads. It returns whether a memory citation was present at all.

**Data flow**: It takes an optional state DB handle and `&ResponseItem`. The function extracts raw assistant text with `raw_assistant_output_text_from_item`; if absent, returns `false`. It strips citations from the text to obtain the citation payload, parses that payload with `parse_memory_citation`; if parsing yields `None`, returns `false`. Otherwise it forwards the parsed citation to `record_stage1_output_usage_for_memory_citation` and returns that helper's boolean result.

**Call relations**: Used by `record_completed_response_item_with_finalized_facts` when no precomputed memory citation is available from turn-item finalization. It composes lower-level extraction, parsing, and recording helpers.

*Call graph*: calls 3 internal fn (raw_assistant_output_text_from_item, record_stage1_output_usage_for_memory_citation, parse_memory_citation); called by 1 (record_completed_response_item_with_finalized_facts); 1 external calls (strip_citations).


##### `record_stage1_output_usage_for_memory_citation`  (lines 288–301)

```
async fn record_stage1_output_usage_for_memory_citation(
    state_db_ctx: Option<&state_db::StateDbHandle>,
    memory_citation: &MemoryCitation,
) -> bool
```

**Purpose**: Records stage-1 output usage for all thread IDs referenced by a parsed memory citation, if a state DB is available. It still reports success when the citation contains no thread IDs.

**Data flow**: It takes an optional DB handle and `&MemoryCitation`, derives thread IDs with `thread_ids_from_memory_citation`, and if the list is empty returns `true` immediately. If thread IDs exist and a DB handle is present, it calls `db.memories().record_stage1_output_usage(&thread_ids).await`, ignoring any error. It returns `true` whenever a citation existed, regardless of DB availability or write success.

**Call relations**: Called either directly from `record_completed_response_item_with_finalized_facts` when finalization already parsed the citation, or from `record_stage1_output_usage_and_detect_memory_citation` after raw-text detection. It isolates the DB-write semantics from citation parsing.

*Call graph*: calls 1 internal fn (thread_ids_from_memory_citation); called by 2 (record_completed_response_item_with_finalized_facts, record_stage1_output_usage_and_detect_memory_citation).


##### `apply_turn_item_contributors`  (lines 324–338)

```
async fn apply_turn_item_contributors(
    sess: &Session,
    turn_store: &ExtensionData,
    item: &mut TurnItem,
)
```

**Purpose**: Runs all registered extension turn-item contributors against a mutable `TurnItem`, allowing extensions to annotate or rewrite it before emission. Contributor failures are logged and do not abort processing.

**Data flow**: It takes `&Session`, `&ExtensionData turn_store`, and `&mut TurnItem`. The function clones the current contributor list from `sess.services.extensions.turn_item_contributors()`, iterates through it, and awaits each contributor's `contribute` call with thread and turn extension stores plus the mutable item. Errors are logged with `warn!`; the function returns `()`.

**Call relations**: Called by `finalize_turn_item` when contributor execution is enabled by `TurnItemContributorPolicy::Run`. It is the extension hook point in the turn-item finalization pipeline.

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

**Purpose**: Converts a non-tool raw response item into a finalized `TurnItem` plus derived facts such as visible last agent message, parsed memory citation, and mailbox-deferral behavior. It packages both the transformed item and metadata needed by later recording logic.

**Data flow**: It takes session, turn context, contributor policy, raw `ResponseItem`, and `plan_mode`. It first awaits `handle_non_tool_response_item`; if that returns `None`, this function returns `None`. Otherwise it inspects the resulting `TurnItem`: for `AgentMessage`, it concatenates visible text content, derives `last_agent_message` if nonblank, copies `memory_citation`, and sets `defers_mailbox_delivery_to_next_turn` unless the phase is commentary; for `ImageGeneration`, it sets deferral true; for other items, facts are empty/false. It returns `Some(FinalizedTurnItem { turn_item, facts })`.

**Call relations**: Used by `handle_output_item_done` and plan-mode assistant handling to avoid recomputing facts after turn-item conversion. It delegates the actual item conversion and contributor/image processing to `handle_non_tool_response_item`.

*Call graph*: calls 1 internal fn (handle_non_tool_response_item); called by 2 (handle_assistant_item_done_in_plan_mode, handle_output_item_done); 1 external calls (matches!).


##### `handle_output_item_done`  (lines 405–515)

```
async fn handle_output_item_done(
    ctx: &mut HandleOutputCtx,
    item: ResponseItem,
    previously_active_item: Option<TurnItem>,
) -> Result<OutputItemResult>
```

**Purpose**: Processes one completed streamed `ResponseItem`, deciding whether it is a tool call, a normal turn item, a recoverable tool-call error response, or a fatal error. It records transcript state immediately and returns an `OutputItemResult` describing follow-up work and the last visible agent message.

**Data flow**: It takes mutable `HandleOutputCtx`, an owned `ResponseItem`, and an optional previously active `TurnItem`. It initializes `OutputItemResult::default()` and computes `plan_mode`. It then calls `ToolRouter::build_tool_call(item.clone())`. For `Ok(Some(call))`, it reopens mailbox delivery for the current turn, logs the tool call, records the raw item, creates a child cancellation token, boxes a future from `tool_runtime.handle_tool_call`, and returns output with `needs_follow_up = true` and `tool_future = Some(...)`. For `Ok(None)`, it finalizes the item into a `TurnItem`, emits a started event if there was no previously active item (special-casing image generation to synthesize an `in_progress` started item), emits completion, records the raw item with finalized facts, and sets `last_agent_message` from those facts. For `Err(FunctionCallError::RespondToModel(message))`, it synthesizes a `ResponseInputItem::FunctionCallOutput`, records the raw item, converts the synthetic input to a `ResponseItem` if possible and records that too, and marks `needs_follow_up = true`. For `Err(FunctionCallError::Fatal(message))`, it returns `Err(CodexErr::Fatal(message))`.

**Call relations**: This is the central dispatcher used by stream-processing code such as sampling request execution. It delegates tool-call parsing to `ToolRouter`, non-tool conversion to `finalize_non_tool_response_item`, transcript side effects to the recording helpers, and synthetic transcript conversion to `response_input_to_response_item`.

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

**Purpose**: Converts a raw non-tool `ResponseItem` into a finalized `TurnItem` when the variant is one the UI/transcript layer understands. It ignores tool-output variants and unsupported items.

**Data flow**: It takes session, turn context, contributor policy, raw item, and `plan_mode`. After logging the item at debug level, it matches the variant: `Message`, `Reasoning`, `WebSearchCall`, and `ImageGenerationCall` are parsed with `parse_turn_item`, finalized via `finalize_turn_item`, and if the result is `TurnItem::ImageGeneration`, image-generation instructions are recorded. Tool-output variants log an `unexpected tool output from stream` debug message and return `None`; all other variants also return `None`.

**Call relations**: Called directly by stream-processing code and by `finalize_non_tool_response_item`. It delegates parsing to `parse_turn_item`, finalization to `finalize_turn_item`, and optional instruction recording to `record_image_generation_instructions`.

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

**Purpose**: Applies extension contributors and final cleanup/persistence rules to a mutable `TurnItem` before it is emitted. For agent messages it strips hidden markup and fills in memory citations; for completed image items it persists the artifact.

**Data flow**: It takes session, turn context, contributor policy, mutable `TurnItem`, and `plan_mode`. If contributor policy is `Run`, it awaits `apply_turn_item_contributors`. If the item is `TurnItem::AgentMessage`, it concatenates text content, strips hidden markup and parses memory citation with `strip_hidden_assistant_markup_and_parse_memory_citation`, replaces the content with a single visible text entry, and sets `memory_citation` only if the contributor did not already provide one. If the item is `TurnItem::ImageGeneration` with `status == "completed"`, it awaits `persist_image_generation_item`. It returns `()`.

**Call relations**: Used by `handle_non_tool_response_item` and other completion paths that need a fully finalized turn item. It is the main post-parse transformation stage in the non-tool pipeline.

*Call graph*: calls 3 internal fn (apply_turn_item_contributors, persist_image_generation_item, strip_hidden_assistant_markup_and_parse_memory_citation); called by 2 (handle_non_tool_response_item, emit_completed); 1 external calls (vec!).


##### `last_assistant_message_from_item`  (lines 588–603)

```
fn last_assistant_message_from_item(
    item: &ResponseItem,
    plan_mode: bool,
) -> Option<String>
```

**Purpose**: Extracts the visible assistant message text from a raw response item after stripping hidden citations and, in plan mode, proposed-plan blocks. It returns `None` when no visible text remains.

**Data flow**: It takes `&ResponseItem` and `bool plan_mode`, gets raw assistant text with `raw_assistant_output_text_from_item`, returns `None` if absent or empty, strips hidden markup with `strip_hidden_assistant_markup`, and returns `Some(stripped)` only if the stripped text is not all whitespace.

**Call relations**: Used by mailbox-deferral logic and other callers that need the final visible assistant text without fully converting to a `TurnItem`. It composes the raw-text extractor with the hidden-markup stripper.

*Call graph*: calls 2 internal fn (raw_assistant_output_text_from_item, strip_hidden_assistant_markup); called by 2 (get_last_assistant_message_from_turn, completed_item_defers_mailbox_delivery_to_next_turn).


##### `completed_item_defers_mailbox_delivery_to_next_turn`  (lines 605–621)

```
fn completed_item_defers_mailbox_delivery_to_next_turn(
    item: &ResponseItem,
    plan_mode: bool,
) -> bool
```

**Purpose**: Determines whether a completed raw response item should cause mailbox deliveries to be deferred to the next turn. Visible final assistant text and image-generation calls close the current turn for mailbox purposes; commentary does not.

**Data flow**: It takes `&ResponseItem` and `bool plan_mode`. For `ResponseItem::Message`, it returns `false` unless `role == "assistant"` and `phase` is not commentary; then it calls `last_assistant_message_from_item` and returns whether visible text exists. For `ImageGenerationCall` it returns `true`. All other variants return `false`.

**Call relations**: Used by `record_completed_response_item_with_finalized_facts` when no precomputed finalization facts are available. It encodes the mailbox-phase policy for raw response items.

*Call graph*: calls 1 internal fn (last_assistant_message_from_item); 1 external calls (matches!).


##### `response_input_to_response_item`  (lines 623–664)

```
fn response_input_to_response_item(input: &ResponseInputItem) -> Option<ResponseItem>
```

**Purpose**: Converts selected `ResponseInputItem` variants back into transcript `ResponseItem`s so synthetic tool responses can be recorded in history. Unsupported input variants are ignored.

**Data flow**: It takes `&ResponseInputItem` and matches supported variants: `FunctionCallOutput`, `CustomToolCallOutput`, `McpToolCallOutput` (converted through `as_function_call_output_payload()`), and `ToolSearchOutput`. For each supported case it clones the relevant fields into the corresponding `ResponseItem` with `metadata: None`; otherwise it returns `None`.

**Call relations**: Called by `handle_output_item_done` in the `RespondToModel` error branch so a synthesized tool-response input can also be persisted as a normal response item. It is a narrow conversion helper for transcript consistency.

*Call graph*: called by 1 (handle_output_item_done).


### `core/src/tasks/lifecycle.rs`

`orchestration` · `turn start/stop/abort/error and idle transitions`

This file adds a small set of lifecycle-emission methods onto `Session`. Each method iterates the relevant contributor list from `self.services.extensions` and awaits each callback sequentially, so extension hooks observe a stable ordering and receive fully constructed input payloads. The payloads consistently expose three extension data scopes: session-wide storage from `self.services.session_extension_data`, thread-wide storage from `self.services.thread_extension_data`, and per-turn storage from either `TurnContext::extension_data` or an explicit `ExtensionData` argument.

The methods correspond to concrete lifecycle moments: turn start includes the turn id, collaboration mode, and a snapshot of token usage at the beginning of the turn; turn stop only needs the stores; turn abort includes a cloned `TurnAbortReason`; turn error includes the turn id and a cloned `CodexErrorInfo`. The thread-idle path is the only one with gating logic: it first checks whether `active_turn` is still populated or whether the input queue contains mailbox items marked to trigger a turn, and emits nothing unless the session is truly idle. That prevents idle hooks from firing during races between task completion and queued follow-up work. The design here is intentionally thin: no transformation beyond packaging references and cloning owned error/abort values needed across awaited contributor calls.

#### Function details

##### `Session::emit_turn_start_lifecycle`  (lines 10–27)

```
async fn emit_turn_start_lifecycle(
        &self,
        turn_context: &TurnContext,
        token_usage_at_turn_start: &TokenUsage,
    )
```

**Purpose**: Invokes every registered turn lifecycle contributor's `on_turn_start` hook with the current turn identity, collaboration mode, token-usage baseline, and extension stores.

**Data flow**: Reads `turn_context.sub_id`, `turn_context.collaboration_mode`, `turn_context.extension_data`, and the session/thread extension stores from `self.services`, plus the caller-provided `token_usage_at_turn_start`. For each contributor, it builds a `codex_extension_api::TurnStartInput` borrowing those values and awaits the hook. It returns `()` and does not mutate session state directly.

**Call relations**: This method is called from task startup after pending input has been attached to the active turn state and before the background task is spawned into steady execution. It delegates only to extension contributors so external integrations can observe the beginning of a turn.


##### `Session::emit_turn_stop_lifecycle`  (lines 29–39)

```
async fn emit_turn_stop_lifecycle(&self, turn_store: &ExtensionData)
```

**Purpose**: Broadcasts a turn-stop notification to all turn lifecycle contributors using the supplied per-turn extension store.

**Data flow**: Consumes `turn_store: &ExtensionData` from the caller and reads session/thread extension stores from `self.services`. It constructs `codex_extension_api::TurnStopInput` for each contributor and awaits `on_turn_stop`. It returns `()` without changing internal state.

**Call relations**: This runs during normal task completion after metrics and analytics have been computed but before the final `TurnComplete` event is sent. Its only downstream work is contributor callbacks, giving extensions a uniform end-of-turn hook.


##### `Session::emit_thread_idle_lifecycle_if_idle`  (lines 41–56)

```
async fn emit_thread_idle_lifecycle_if_idle(&self)
```

**Purpose**: Emits thread-idle lifecycle callbacks only when there is no active turn and no queued mailbox work that should immediately wake the session.

**Data flow**: Reads `self.active_turn` under its async mutex and queries `self.input_queue.has_trigger_turn_mailbox_items()`. If either indicates work is active or pending, it returns early. Otherwise it reads session/thread extension stores and awaits each contributor's `on_thread_idle` with a `ThreadIdleInput`. It returns `()`.

**Call relations**: This is triggered after a task fully finishes and the active turn has been cleared. The guard conditions are crucial because callers may reach this point while follow-up work is already queued; only the truly idle path delegates to thread lifecycle contributors.


##### `Session::emit_turn_abort_lifecycle`  (lines 58–73)

```
async fn emit_turn_abort_lifecycle(
        &self,
        reason: TurnAbortReason,
        turn_store: &ExtensionData,
    )
```

**Purpose**: Notifies turn lifecycle contributors that a turn ended via abort, including the concrete abort reason.

**Data flow**: Takes an owned `TurnAbortReason` and a borrowed `turn_store`. For each contributor it clones the abort reason, combines it with session/thread/turn extension stores into `codex_extension_api::TurnAbortInput`, and awaits `on_turn_abort`. It returns `()`.

**Call relations**: Abort flows call this after task cancellation/cleanup has been processed and before pending input is cleared or replacement work may start. It delegates to contributors so extensions can distinguish aborts from normal completion.

*Call graph*: 1 external calls (clone).


##### `Session::emit_turn_error_lifecycle`  (lines 75–91)

```
async fn emit_turn_error_lifecycle(
        &self,
        turn_context: &TurnContext,
        error: CodexErrorInfo,
    )
```

**Purpose**: Emits a turn-error lifecycle event carrying the turn id and structured protocol error information.

**Data flow**: Consumes `error: CodexErrorInfo` and reads `turn_context.sub_id`, `turn_context.extension_data`, and session/thread extension stores. It clones the error for each contributor, builds `codex_extension_api::TurnErrorInput`, awaits `on_turn_error`, and returns `()`.

**Call relations**: This method is used by error-reporting paths elsewhere in the session subsystem when a turn fails but still needs extension visibility. Its only delegated work is the contributor callback fan-out.

*Call graph*: 1 external calls (clone).


### `core/src/tools/lifecycle.rs`

`orchestration` · `tool invocation start/finish/abort notifications`

This module is the bridge between the core tool runtime and extension-provided lifecycle hooks. Its inputs are internal execution structures—`ToolInvocation`, `Session`, `TurnContext`, `ToolCallSource`, and `ToolName`—while its outputs are asynchronous calls into each registered extension contributor returned by `session.services.extensions.tool_lifecycle_contributors()`.

`notify_tool_start` iterates contributors and awaits each `on_tool_start` callback with a `ToolStartInput` assembled from the invocation: session/thread extension stores, optional turn extension data, turn ID, call ID, tool name, and a source converted into the extension API’s enum. Finish notifications are funneled through `notify_tool_finish_parts`, which centralizes the shared payload-building logic for both normal completion and explicit abortion. `notify_tool_finish` extracts the needed pieces from a `ToolInvocation` and forwards the supplied `ToolCallOutcome`; `notify_tool_aborted` does the same from separate session/turn/call arguments while forcing `ToolCallOutcome::Aborted`.

A subtle design choice is that source conversion clones `ToolCallSource` before matching, because the same source may still be needed by callers or reused across contributor iterations. Another is that contributor callbacks are awaited sequentially, so lifecycle ordering is deterministic and a slow contributor delays later ones. The helper `extension_tool_call_source` preserves `CodeMode` metadata (`cell_id`, `runtime_tool_call_id`) exactly rather than flattening it, allowing extensions to distinguish direct calls from code-mode-originated tool invocations.

#### Function details

##### `notify_tool_start`  (lines 12–31)

```
async fn notify_tool_start(invocation: &ToolInvocation)
```

**Purpose**: Emits a start notification for a tool invocation to every registered lifecycle contributor. It packages the invocation’s IDs, stores, tool name, and source into the extension API format.

**Data flow**: Reads `invocation: &ToolInvocation`, including `session.services.session_extension_data`, `thread_extension_data`, `turn.extension_data`, `turn.sub_id`, `call_id`, `tool_name`, and `source` → converts the source with `extension_tool_call_source` → for each contributor, awaits `on_tool_start(ToolStartInput { ... })` → returns `()` without mutating core state.

**Call relations**: The dispatch path invokes this before tool execution begins. Within this file it delegates only to `extension_tool_call_source`; externally its role is to fan out the start event to extensions before the rest of the tool call proceeds.

*Call graph*: calls 1 internal fn (extension_tool_call_source); called by 1 (dispatch_any_with_terminal_outcome).


##### `notify_tool_finish`  (lines 33–43)

```
async fn notify_tool_finish(invocation: &ToolInvocation, outcome: ToolCallOutcome)
```

**Purpose**: Reports a completed tool invocation with a caller-supplied `ToolCallOutcome`. It is the convenience wrapper used when the caller already has a full `ToolInvocation` object.

**Data flow**: Reads `invocation: &ToolInvocation` and `outcome: ToolCallOutcome` → extracts `session`, `turn`, `call_id`, `tool_name`, and cloned `source` → forwards them to `notify_tool_finish_parts` → returns `()` after all contributor callbacks complete.

**Call relations**: This function is used by the finish-notification path that runs after a tool result is finalized and still unclaimed. It delegates all actual contributor iteration and payload construction to `notify_tool_finish_parts` so aborted and normal finish paths share identical formatting.

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

**Purpose**: Emits an aborted lifecycle event for a tool call when execution is cancelled. It exists for callers that have session/turn metadata but not a full `ToolInvocation` object.

**Data flow**: Reads `session`, `turn`, `call_id`, `tool_name`, and `source` → calls `notify_tool_finish_parts` with `ToolCallOutcome::Aborted` → returns `()` after contributors have been notified.

**Call relations**: Cancellation-handling code uses this path when a tool is aborted outside the normal completion flow. It delegates to the shared finish helper so aborted notifications carry the same stores and IDs as ordinary finish events.

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

**Purpose**: Implements the common finish-notification loop used by both normal completion and abortion. It constructs `ToolFinishInput` and awaits each contributor’s `on_tool_finish` callback.

**Data flow**: Reads `session`, `turn`, `call_id`, `tool_name`, `source`, and `outcome` → iterates `session.services.extensions.tool_lifecycle_contributors()` → clones and converts `source` for each iteration via `extension_tool_call_source(source.clone())` → awaits `on_tool_finish(ToolFinishInput { session_store, thread_store, turn_store, turn_id, call_id, tool_name, source, outcome })` for each contributor → returns `()`.

**Call relations**: Both `notify_tool_finish` and `notify_tool_aborted` funnel through this helper. Its role is to centralize finish-event fanout so all finish-like paths produce identical extension payloads and ordering.

*Call graph*: calls 1 internal fn (extension_tool_call_source); called by 2 (notify_tool_aborted, notify_tool_finish); 1 external calls (clone).


##### `extension_tool_call_source`  (lines 87–98)

```
fn extension_tool_call_source(source: ToolCallSource) -> ExtensionToolCallSource
```

**Purpose**: Translates the core tool-call source enum into the extension API’s corresponding enum. It preserves direct calls and code-mode metadata exactly.

**Data flow**: Consumes `source: ToolCallSource` → matches `Direct` to `ExtensionToolCallSource::Direct` and `CodeMode { cell_id, runtime_tool_call_id }` to the extension enum variant with the same fields → returns the converted enum without side effects.

**Call relations**: Both start and finish notification paths call this helper while building extension payloads. It is the only place in this file where internal and extension-facing source representations are coupled.

*Call graph*: called by 2 (notify_tool_finish_parts, notify_tool_start).


### `core/src/user_shell_command.rs`

`domain_logic` · `post-exec persistence and transcript construction`

This file is a small formatting adapter between execution results and the conversation/persistence model. The core helper, `user_shell_command_fragment`, takes the original command string, an `ExecToolCallOutput`, and the current `TurnContext`. It formats the execution result text with `format_exec_output_str`, using the turn’s truncation policy, then constructs a `UserShellCommand` containing the command, exit code, duration, and formatted output. That means the persisted shell-command record reflects the same truncation rules used elsewhere in the turn and prefers the execution-output formatting logic centralized in the tools layer.

Two thin wrappers expose that fragment in different forms. Under tests, `format_user_shell_command_record` renders the fragment directly to a `String`, making exact textual assertions easy. In production, `user_shell_command_record_item` converts the fragment into `ContextualUserFragment` and then into a `ResponseItem`, which is the protocol-level item persisted into conversation history. The file itself contains no parsing or business rules beyond choosing the formatting helper and preserving the command/exit metadata; its value is in keeping shell-command persistence consistent and isolated from the rest of the execution subsystem.

#### Function details

##### `user_shell_command_fragment`  (lines 9–16)

```
fn user_shell_command_fragment(
    command: &str,
    exec_output: &ExecToolCallOutput,
    turn_context: &TurnContext,
) -> UserShellCommand
```

**Purpose**: Constructs a `UserShellCommand` fragment from a command string and execution result using the turn’s truncation policy.

**Data flow**: Takes `command: &str`, `exec_output: &ExecToolCallOutput`, and `turn_context: &TurnContext`; formats output text via `format_exec_output_str(exec_output, turn_context.truncation_policy)`, then passes the command, `exec_output.exit_code`, `exec_output.duration`, and formatted output into `UserShellCommand::new`, returning the fragment.

**Call relations**: Shared internal helper used by both the test-only string renderer and the production `ResponseItem` constructor so both paths serialize the same underlying fragment.

*Call graph*: calls 2 internal fn (new, format_exec_output_str); called by 2 (format_user_shell_command_record, user_shell_command_record_item).


##### `format_user_shell_command_record`  (lines 19–25)

```
fn format_user_shell_command_record(
    command: &str,
    exec_output: &ExecToolCallOutput,
    turn_context: &TurnContext,
) -> String
```

**Purpose**: Test-only helper that renders the shell-command fragment into its final textual representation.

**Data flow**: Takes the same inputs as `user_shell_command_fragment`, builds the fragment, calls `.render()` on it, and returns the resulting `String`.

**Call relations**: Used only by tests to assert exact serialized output without going through the full `ResponseItem` wrapper.

*Call graph*: calls 1 internal fn (user_shell_command_fragment).


##### `user_shell_command_record_item`  (lines 27–37)

```
fn user_shell_command_record_item(
    command: &str,
    exec_output: &ExecToolCallOutput,
    turn_context: &TurnContext,
) -> ResponseItem
```

**Purpose**: Builds the persisted protocol item representing a user shell command and its result.

**Data flow**: Takes command, exec output, and turn context; constructs a `UserShellCommand` via `user_shell_command_fragment`; converts it into `ContextualUserFragment` and then into `ResponseItem`; returns that item.

**Call relations**: Called by `persist_user_shell_output` when execution results need to be written into the conversation/history model.

*Call graph*: calls 2 internal fn (into, user_shell_command_fragment); called by 1 (persist_user_shell_output).


### `tools/src/tool_output.rs`

`domain_logic` · `post-tool execution`

This file is the output conversion hub for tool execution. The `ToolOutput` trait specifies the behaviors every runtime result must provide: a log preview string, success status for logging, optional external-context signaling, conversion into a `ResponseInputItem`, optional post-tool-use hook identifiers/input/response payloads, and a default `code_mode_result` derived from the response item. Most hook-related methods default to pass-through or `None`, so output types opt in only when they have stable hook-facing data. There is a blanket `ToolOutput` impl for `Box<T>` that forwards every method to the inner value, allowing dispatch code to work with boxed trait objects transparently. `JsonToolOutput` is the main concrete implementation for JSON-valued results; it stores the raw `serde_json::Value`, an optional success flag, and an external-context bit. Its response conversion emits either `FunctionCallOutput` or `CustomToolCallOutput` depending on `ToolPayload`, strips output schema concerns down to serialized text, and preserves typed JSON for post-use hooks and code mode. The file also implements `ToolOutput` for MCP `CallToolResult`, preserving MCP-native output in protocol responses while serializing to JSON for code mode. Supporting helpers normalize arbitrary `ResponseInputItem` variants into code-mode JSON, flatten content items into newline-joined strings, and generate bounded telemetry previews by truncating at UTF-8 character boundaries and line limits before appending a truncation notice.

#### Function details

##### `ToolOutput::contains_external_context`  (lines 23–25)

```
fn contains_external_context(&self) -> bool
```

**Purpose**: Provides the default answer for whether a tool output contains external context that should suppress memory generation. The default is negative so output types must opt in explicitly.

**Data flow**: It takes `&self` and returns `false` unconditionally. It reads no additional state and writes nothing.

**Call relations**: Memory-generation or post-processing code can call this on any `ToolOutput`; concrete output types override it only when they carry externally sourced context.


##### `ToolOutput::post_tool_use_id`  (lines 30–32)

```
fn post_tool_use_id(&self, call_id: &str) -> String
```

**Purpose**: Supplies the tool call identifier exposed to post-tool-use hooks. The default implementation preserves the original call id unchanged.

**Data flow**: It takes a borrowed `call_id`, clones it into a new `String` with `to_string()`, and returns that string. It does not inspect payload or mutate state.

**Call relations**: Hook payload builders invoke this when assembling `PostToolUse` data; output types can override it if they need a different stable identifier than the raw call id.

*Call graph*: called by 2 (post_unified_exec_tool_use_payload, post_tool_use_payload).


##### `ToolOutput::post_tool_use_input`  (lines 35–37)

```
fn post_tool_use_input(&self, _payload: &ToolPayload) -> Option<JsonValue>
```

**Purpose**: Defines the hook-facing representation of the tool input. By default, outputs do not expose any input payload to post-use hooks.

**Data flow**: It accepts a `&ToolPayload` but ignores it and returns `None`. No state is read or written.

**Call relations**: Post-tool-use payload assembly calls this opportunistically; concrete outputs override it only when they want to surface a stable, hook-specific input JSON value.

*Call graph*: called by 3 (post_tool_use_payload, post_unified_exec_tool_use_payload, post_tool_use_payload).


##### `ToolOutput::post_tool_use_response`  (lines 46–48)

```
fn post_tool_use_response(&self, _call_id: &str, _payload: &ToolPayload) -> Option<JsonValue>
```

**Purpose**: Defines the stable hook-facing representation of the tool response. The default implementation opts the output out of post-use response payloads entirely.

**Data flow**: It accepts `call_id` and `payload` references but ignores them and returns `None`. It performs no mutation.

**Call relations**: Hook payload builders consult this method when deciding whether a tool output contributes a response body to `PostToolUse`; concrete output types override it to expose structured data.

*Call graph*: called by 5 (post_tool_use_payload, post_tool_use_payload, post_tool_use_payload, post_unified_exec_tool_use_payload, post_tool_use_payload).


##### `ToolOutput::code_mode_result`  (lines 50–52)

```
fn code_mode_result(&self, payload: &ToolPayload) -> JsonValue
```

**Purpose**: Computes the JSON value exposed to code mode from the output's protocol response representation. The default path reuses `to_response_item` and then normalizes that item into a `JsonValue`.

**Data flow**: It takes a `&ToolPayload`, calls `self.to_response_item("", payload)`, passes the resulting `ResponseInputItem` into `response_input_to_code_mode_result`, and returns the normalized `JsonValue`. It writes no state.

**Call relations**: Dispatch code calls this when it needs a code-mode result; output types can override it to preserve richer typed data than the generic response-item conversion would.

*Call graph*: calls 1 internal fn (response_input_to_code_mode_result); called by 1 (tool_dispatch_result).


##### `Box::log_preview`  (lines 59–61)

```
fn log_preview(&self) -> String
```

**Purpose**: Forwards `log_preview` through a boxed `ToolOutput`. It lets boxed trait objects behave exactly like their inner output values.

**Data flow**: It dereferences `self` twice to access the inner `ToolOutput` and returns that inner value's preview string. No mutation occurs.

**Call relations**: This forwarding impl is used whenever dispatch stores outputs behind `Box<T>` and still needs trait behavior without special casing.


##### `Box::success_for_logging`  (lines 63–65)

```
fn success_for_logging(&self) -> bool
```

**Purpose**: Forwards the logging success flag through a boxed output. It preserves the inner output's semantics unchanged.

**Data flow**: It dereferences the box, calls the inner `success_for_logging`, and returns the resulting `bool`. No state changes occur.

**Call relations**: This method supports generic logging code operating on boxed outputs.


##### `Box::contains_external_context`  (lines 67–69)

```
fn contains_external_context(&self) -> bool
```

**Purpose**: Forwards the external-context flag through a boxed output. It keeps memory-suppression decisions tied to the concrete inner type.

**Data flow**: It dereferences the box, calls the inner `contains_external_context`, and returns the `bool` result. It performs no writes.

**Call relations**: This forwarding path is used by downstream logic that only sees `Box<dyn ToolOutput>`.


##### `Box::to_response_item`  (lines 71–73)

```
fn to_response_item(&self, call_id: &str, payload: &ToolPayload) -> ResponseInputItem
```

**Purpose**: Forwards protocol response conversion through a boxed output. It avoids duplicating conversion logic for boxed trait objects.

**Data flow**: It takes `call_id` and `payload`, dereferences the box, invokes the inner `to_response_item`, and returns the resulting `ResponseInputItem`. No external state is modified.

**Call relations**: Dispatch and response assembly code rely on this when tool handlers return boxed outputs.


##### `Box::post_tool_use_id`  (lines 75–77)

```
fn post_tool_use_id(&self, call_id: &str) -> String
```

**Purpose**: Forwards hook id generation through a boxed output. The boxed wrapper does not alter hook identity semantics.

**Data flow**: It dereferences the box, passes `call_id` to the inner implementation, and returns the resulting `String`. No mutation occurs.

**Call relations**: Hook payload builders can call this uniformly on boxed outputs.


##### `Box::post_tool_use_input`  (lines 79–81)

```
fn post_tool_use_input(&self, payload: &ToolPayload) -> Option<JsonValue>
```

**Purpose**: Forwards hook input extraction through a boxed output. This preserves any concrete override implemented by the inner type.

**Data flow**: It dereferences the box, passes `payload` to the inner implementation, and returns the resulting `Option<JsonValue>`. No state is changed.

**Call relations**: Used by post-tool-use assembly code when outputs are boxed trait objects.


##### `Box::post_tool_use_response`  (lines 83–85)

```
fn post_tool_use_response(&self, call_id: &str, payload: &ToolPayload) -> Option<JsonValue>
```

**Purpose**: Forwards hook response extraction through a boxed output. It keeps hook payload generation delegated to the concrete output type.

**Data flow**: It dereferences the box, passes `call_id` and `payload` to the inner implementation, and returns the resulting `Option<JsonValue>`. It performs no writes.

**Call relations**: This is part of the blanket boxed forwarding layer used by hook-related orchestration.


##### `Box::code_mode_result`  (lines 87–89)

```
fn code_mode_result(&self, payload: &ToolPayload) -> JsonValue
```

**Purpose**: Forwards code-mode result generation through a boxed output. The wrapper does not change how code-mode JSON is computed.

**Data flow**: It dereferences the box, calls the inner `code_mode_result(payload)`, and returns the resulting `JsonValue`. No state is mutated.

**Call relations**: Tool dispatch uses this when it stores outputs as boxed trait objects but still needs code-mode conversion.


##### `JsonToolOutput::new`  (lines 100–106)

```
fn new(value: JsonValue) -> Self
```

**Purpose**: Constructs a successful JSON tool output with no external-context flag set. It is the convenience constructor for the common case of ordinary successful JSON results.

**Data flow**: It takes ownership of a `JsonValue`, stores it in `value`, sets `success` to `Some(true)`, sets `contains_external_context` to `false`, and returns the new `JsonToolOutput`. No external state is touched.

**Call relations**: Many tool handlers and tests use this as the standard way to wrap a JSON result before returning it through the `ToolOutput` trait.

*Call graph*: called by 13 (handle_call, handle_call, handle, exposes_generic_hook_payloads, post_tool_use_feedback_output_keeps_code_mode_result_typed, handle_call, handle, goal_response, handle_call, handle_call (+3 more)).


##### `JsonToolOutput::with_success`  (lines 108–114)

```
fn with_success(value: JsonValue, success: Option<bool>) -> Self
```

**Purpose**: Constructs a JSON tool output with an explicit optional success flag. This supports outputs that need to log failure or unknown success independently of their JSON body.

**Data flow**: It takes a `JsonValue` and an `Option<bool>`, stores them in a new `JsonToolOutput`, initializes `contains_external_context` to `false`, and returns the struct. It does not mutate external state.

**Call relations**: Callers use this when they need finer control over logging success semantics than `new` provides.


##### `JsonToolOutput::with_external_context`  (lines 116–119)

```
fn with_external_context(mut self) -> Self
```

**Purpose**: Marks an existing JSON output as containing external context. It is a builder-style modifier used after construction.

**Data flow**: It takes ownership of `self`, sets `self.contains_external_context = true`, and returns the modified `JsonToolOutput`. No external state is changed.

**Call relations**: This is called by tool handlers that know their output should disable memory generation under external-context policies.


##### `JsonToolOutput::log_preview`  (lines 123–125)

```
fn log_preview(&self) -> String
```

**Purpose**: Produces a bounded telemetry preview string for a JSON output by serializing the JSON and truncating it safely. This keeps logs readable and size-limited.

**Data flow**: It reads `self.value`, converts it to a string with `to_string()`, passes that string to `telemetry_preview`, and returns the preview. It does not mutate the output.

**Call relations**: Logging and telemetry code call this on JSON outputs to obtain a concise preview rather than the full serialized body.

*Call graph*: calls 1 internal fn (telemetry_preview); 1 external calls (to_string).


##### `JsonToolOutput::success_for_logging`  (lines 127–129)

```
fn success_for_logging(&self) -> bool
```

**Purpose**: Reports whether the JSON output should be considered successful in logs. Missing success metadata defaults to success.

**Data flow**: It reads `self.success`, unwraps it with `unwrap_or(true)`, and returns the resulting `bool`. No state changes occur.

**Call relations**: This feeds logging/telemetry paths that need a simple success bit independent of the output body.


##### `JsonToolOutput::contains_external_context`  (lines 131–133)

```
fn contains_external_context(&self) -> bool
```

**Purpose**: Returns the explicit external-context flag stored on the JSON output. Unlike the trait default, this reflects per-output state.

**Data flow**: It reads `self.contains_external_context` and returns that `bool`. It performs no mutation.

**Call relations**: Memory-related orchestration uses this override to detect outputs that should suppress memory generation.


##### `JsonToolOutput::to_response_item`  (lines 135–153)

```
fn to_response_item(&self, call_id: &str, payload: &ToolPayload) -> ResponseInputItem
```

**Purpose**: Converts a JSON output into the protocol response item expected by downstream model/runtime plumbing. It emits a custom-tool output variant for `ToolPayload::Custom` and a normal function-call output otherwise.

**Data flow**: It reads `self.value` and `self.success`, serializes the JSON body to text, wraps it in `FunctionCallOutputPayload { body: FunctionCallOutputBody::Text(...), success }`, then inspects `payload`. For `ToolPayload::Custom { .. }`, it returns `ResponseInputItem::CustomToolCallOutput` with the provided `call_id`, `name: None`, and the payload; for all other payload kinds it returns `ResponseInputItem::FunctionCallOutput` with the same `call_id` and payload. It allocates new strings for the call id and serialized body but does not mutate `self`.

**Call relations**: This is the main bridge from JSON-producing tool handlers into the shared response protocol consumed by model interaction and code-mode conversion.

*Call graph*: 3 external calls (to_string, matches!, Text).


##### `JsonToolOutput::post_tool_use_response`  (lines 155–157)

```
fn post_tool_use_response(&self, _call_id: &str, _payload: &ToolPayload) -> Option<JsonValue>
```

**Purpose**: Exposes the raw JSON value as the stable post-tool-use response payload. This opts JSON outputs into hook payload generation with typed data rather than serialized text.

**Data flow**: It ignores `call_id` and `payload`, clones `self.value`, wraps it in `Some(...)`, and returns it. No state is modified.

**Call relations**: Post-tool-use hook builders call this to obtain structured response data from JSON outputs.

*Call graph*: 1 external calls (clone).


##### `JsonToolOutput::code_mode_result`  (lines 159–161)

```
fn code_mode_result(&self, _payload: &ToolPayload) -> JsonValue
```

**Purpose**: Returns the underlying JSON value directly for code mode. This bypasses the generic response-item normalization so typed JSON is preserved.

**Data flow**: It ignores the payload, clones `self.value`, and returns the clone as `JsonValue`. It does not mutate state.

**Call relations**: This override is used by dispatch code instead of the trait default when the output is a `JsonToolOutput`, ensuring code mode receives the original typed JSON.

*Call graph*: 1 external calls (clone).


##### `CallToolResult::log_preview`  (lines 165–169)

```
fn log_preview(&self) -> String
```

**Purpose**: Builds a telemetry preview for an MCP tool result using its function-call-output representation when possible. It prefers textual body content but falls back to the payload's string form.

**Data flow**: It converts `self` to a `FunctionCallOutputPayload` via `as_function_call_output_payload()`, extracts text with `output.body.to_text()` or falls back to `output.to_string()`, passes the chosen string to `telemetry_preview`, and returns the preview. It does not mutate the MCP result.

**Call relations**: Logging code uses this implementation when a tool returns an MCP-native result rather than a JSON wrapper.

*Call graph*: calls 1 internal fn (telemetry_preview).


##### `CallToolResult::success_for_logging`  (lines 171–173)

```
fn success_for_logging(&self) -> bool
```

**Purpose**: Reports the MCP result's success status for logging. It delegates directly to the MCP type's own success indicator.

**Data flow**: It reads `self` and returns `self.success()`. No mutation occurs.

**Call relations**: This keeps logging semantics aligned with the MCP result's native success model.


##### `CallToolResult::to_response_item`  (lines 175–180)

```
fn to_response_item(&self, call_id: &str, _payload: &ToolPayload) -> ResponseInputItem
```

**Purpose**: Wraps an MCP tool result in the dedicated protocol response variant. Unlike JSON outputs, it preserves the MCP result structure directly.

**Data flow**: It takes `call_id`, clones `self`, and returns `ResponseInputItem::McpToolCallOutput { call_id: call_id.to_string(), output: self.clone() }`. The payload argument is ignored and no state is mutated.

**Call relations**: This path is used when dispatch needs to surface MCP-native outputs to downstream protocol consumers.


##### `CallToolResult::code_mode_result`  (lines 182–186)

```
fn code_mode_result(&self, _payload: &ToolPayload) -> JsonValue
```

**Purpose**: Serializes an MCP result into JSON for code mode, with a string fallback if serialization fails. This ensures code mode always receives some JSON value.

**Data flow**: It ignores the payload, calls `serde_json::to_value(self)`, returns the serialized `JsonValue` on success, and on error returns `JsonValue::String(format!("failed to serialize mcp result: {err}"))`. It does not mutate state.

**Call relations**: Dispatch code uses this override to obtain a code-mode-safe representation of MCP outputs.

*Call graph*: 1 external calls (to_value).


##### `response_input_to_code_mode_result`  (lines 189–221)

```
fn response_input_to_code_mode_result(response: ResponseInputItem) -> JsonValue
```

**Purpose**: Normalizes any `ResponseInputItem` into the JSON shape expected by code mode. It collapses text/content outputs to strings, preserves tool-search arrays, and serializes MCP outputs.

**Data flow**: It consumes a `ResponseInputItem` and pattern matches by variant. `Message` content is converted into `FunctionCallOutputContentItem`s and passed to `content_items_to_code_mode_result`; `FunctionCallOutput` and `CustomToolCallOutput` return either `JsonValue::String(text)` for text bodies or delegate content-item bodies to `content_items_to_code_mode_result`; `ToolSearchOutput` becomes `JsonValue::Array(tools)`; `McpToolCallOutput` is serialized with `serde_json::to_value(output)` and falls back to an error string on failure. It returns the resulting `JsonValue` without mutating external state.

**Call relations**: This helper underpins the default `ToolOutput::code_mode_result` implementation and centralizes variant-specific conversion rules.

*Call graph*: calls 1 internal fn (content_items_to_code_mode_result); called by 1 (code_mode_result); 3 external calls (Array, String, to_value).


##### `content_items_to_code_mode_result`  (lines 223–243)

```
fn content_items_to_code_mode_result(items: &[FunctionCallOutputContentItem]) -> JsonValue
```

**Purpose**: Flattens a list of function-call output content items into a single newline-joined string for code mode. It keeps only non-empty text and image URL content and ignores encrypted or blank items.

**Data flow**: It borrows a slice of `FunctionCallOutputContentItem`, iterates over it, filters and maps `InputText` items with non-blank `text` and `InputImage` items with non-blank `image_url` into owned strings, drops empty text/image items and all `EncryptedContent`, joins the collected strings with `"\n"`, wraps the result in `JsonValue::String`, and returns it.

**Call relations**: This helper is called from `response_input_to_code_mode_result` whenever a response variant carries structured content items instead of a plain text body.

*Call graph*: called by 1 (response_input_to_code_mode_result); 2 external calls (String, iter).


##### `telemetry_preview`  (lines 245–283)

```
fn telemetry_preview(content: &str) -> String
```

**Purpose**: Produces a bounded preview string for logs by truncating content at both a byte limit and a line limit while preserving UTF-8 boundaries. If truncation occurs, it appends a standard notice and preserves a trailing newline when appropriate.

**Data flow**: It takes an input `&str`, slices it with `take_bytes_at_char_boundary` to at most `TELEMETRY_PREVIEW_MAX_BYTES`, records whether byte truncation occurred, then iterates through at most `TELEMETRY_PREVIEW_MAX_LINES` lines building a new `String`. It checks whether additional lines remain, and if neither byte nor line truncation happened it returns the original content as a new `String`. Otherwise it conditionally restores a newline if the preview stopped exactly before one, ensures the preview ends with a newline when non-empty, appends `TELEMETRY_PREVIEW_TRUNCATION_NOTICE`, and returns the final preview string.

**Call relations**: Both `JsonToolOutput::log_preview` and `CallToolResult::log_preview` delegate here so all tool-output telemetry uses the same truncation policy.

*Call graph*: called by 2 (log_preview, log_preview); 2 external calls (new, take_bytes_at_char_boundary).


### Machine-readable and auxiliary outputs
These files adapt notifications into exec JSONL output and other specialized rendered progress or reporting surfaces outside the main thread UI.

### `cli/src/doctor/output.rs`

`orchestration` · `output rendering`

This module turns the structured doctor report into terminal output optimized for scanability. `render_human_report` writes a header, optional promoted notes, grouped check sections, a summary line, and a footer. Grouping is driven by the static `GROUPS` table, which maps category keys like `system`, `auth`, `websocket`, and `app-server` into titled sections such as Environment, Configuration, Connectivity, and Background Server. Checks not represented in `GROUPS` remain available in JSON but are omitted from human output.

Each row is rendered by `write_check_row`, which computes a display status (`Ok`, `Warning`, `Fail`, `Idle`, etc.), chooses a row description via `row_description`, and optionally expands details using `detail::detail_lines`. Warning/failure rows prefer structured issue causes over generic summaries, and remediation text is folded into the row headline when no issues exist. `notes_for_report` promotes certain conditions into a top Notes section without changing underlying check statuses: available updates, large rollout-file accumulation, non-restricted sandbox settings, all non-ok checks, and mixed auth signals between websocket auth mode and HTTP reachability mode.

The module also contains the redaction pipeline used by both human and JSON output. `redact_detail` preserves safe presence booleans and env-var names, but redacts secret-bearing labels and sanitizes URLs by stripping credentials, query strings, fragments, and deep path segments. Styling helpers color only status markers, flags, code spans, copyable paths/URLs, and low-signal values like `missing` or `unknown`, while `StatusCounts::from_report` computes the final ok/idle/note/warn/fail counts shown in the footer summary.

#### Function details

##### `render_human_report`  (lines 73–117)

```
fn render_human_report(report: &DoctorReport, options: HumanOutputOptions) -> String
```

**Purpose**: Formats a complete `DoctorReport` into the final grouped terminal string, including header, notes, grouped checks, summary, and footer.

**Data flow**: Accepts `report` and `HumanOutputOptions`, writes `Codex Doctor` plus `header_suffix`, computes promoted notes with `notes_for_report`, renders each note with `write_note_row`, iterates `GROUPS` and fetches matching checks via `checks_for_group`, renders each check with `write_check_row`, appends a separator, writes `summary_line`, then appends `write_footer` output and returns the accumulated `String`.

**Call relations**: It is called by `run_doctor` for non-JSON output and heavily exercised by snapshot and formatting tests. It delegates grouping, row rendering, note rendering, summary generation, and footer generation to local helpers.

*Call graph*: calls 5 internal fn (checks_for_group, notes_for_report, write_check_row, write_footer, write_note_row); called by 10 (render_human_report_can_emit_color, render_human_report_expands_feature_flags_with_all, render_human_report_explains_terminal_warning_issue, render_human_report_includes_details_by_default_without_color, render_human_report_includes_memories_db_in_state_health_summary, render_human_report_includes_redacted_details, render_human_report_includes_threads_row_in_environment, render_human_report_promotes_notes_without_changing_statuses, render_human_report_supports_ascii_output, render_human_report_supports_summary_output_without_color); 2 external calls (new, writeln!).


##### `checks_for_group`  (lines 119–130)

```
fn checks_for_group(report: &'a DoctorReport, group: &OutputGroup) -> Vec<&'a DoctorCheck>
```

**Purpose**: Selects report checks whose categories belong to one configured output group, preserving the group key order.

**Data flow**: Iterates the group’s category keys, filters `report.checks` for each key, and collects matching `&DoctorCheck` references into a vector.

**Call relations**: Used by `render_human_report` while walking the static `GROUPS` table.

*Call graph*: called by 1 (render_human_report).


##### `write_check_row`  (lines 132–148)

```
fn write_check_row(out: &mut String, check: &DoctorCheck, options: HumanOutputOptions)
```

**Purpose**: Renders one doctor check row and, when enabled, its expanded detail lines.

**Data flow**: Computes the row description with `row_description(check, options)` and display status with `display_status(check)`, writes the formatted row with a status marker and category column, then if `options.show_details` is true it obtains `detail_lines(check, options)` from the detail submodule and writes each via `write_detail_line`.

**Call relations**: Called by `render_human_report` for every displayed check. It bridges from report-level rows into the detail-rendering submodule.

*Call graph*: calls 4 internal fn (detail_lines, display_status, row_description, write_detail_line); called by 1 (render_human_report); 1 external calls (writeln!).


##### `write_note_row`  (lines 150–158)

```
fn write_note_row(out: &mut String, note: &DoctorNote, options: HumanOutputOptions)
```

**Purpose**: Renders one promoted note in the top Notes section.

**Data flow**: Formats the note’s display status marker, fixed-width name column, and styled summary into one output line appended to the mutable output string.

**Call relations**: Used by `render_human_report` for notes produced by `notes_for_report`.

*Call graph*: called by 1 (render_human_report); 1 external calls (writeln!).


##### `write_detail_line`  (lines 160–213)

```
fn write_detail_line(out: &mut String, detail: HumanDetail, options: HumanOutputOptions)
```

**Purpose**: Renders one `HumanDetail` variant into its terminal representation, including issue markers, continuation indentation, bullets, and remedies.

**Data flow**: Matches on `HumanDetail`. `Row` lines are formatted with a fixed-width label, styled value, and optional dimmed `(expected ...)` suffix; `Continuation` lines align under the value column; `Bullet` lines use a dim bullet marker; `Remedy` lines use an orange arrow marker and highlighted action text.

**Call relations**: Called by `write_check_row` for each detail line returned by `detail::detail_lines`.

*Call graph*: calls 1 internal fn (detail_value); called by 1 (write_check_row); 2 external calls (format!, writeln!).


##### `row_description`  (lines 215–229)

```
fn row_description(check: &DoctorCheck, options: HumanOutputOptions) -> String
```

**Purpose**: Chooses the headline text shown on a check row, preferring actionable issue/remediation text over generic summaries.

**Data flow**: If the check is warning/fail and has issues, returns `issue_summary(check)`. Otherwise, if warning/fail and `check.remediation` exists, it concatenates `summary` and remediation with either an em dash or ASCII dash depending on options. In all other cases it returns `display_summary(check, options)`.

**Call relations**: Used by `write_check_row` to decide what the main row text should emphasize.

*Call graph*: calls 2 internal fn (display_summary, issue_summary); called by 1 (write_check_row); 2 external calls (format!, matches!).


##### `issue_summary`  (lines 231–246)

```
fn issue_summary(check: &DoctorCheck) -> String
```

**Purpose**: Condenses a check’s issue list into a short row headline.

**Data flow**: Returns `check.summary` when there are no issues, the single issue’s cause when there is exactly one, or `<n> issues - <cause1>; <cause2>` using the first two causes when multiple issues exist.

**Call relations**: Used by both `row_description` and `actionable_note_summary`.

*Call graph*: called by 2 (actionable_note_summary, row_description); 1 external calls (format!).


##### `display_status`  (lines 264–280)

```
fn display_status(check: &DoctorCheck) -> DisplayStatus
```

**Purpose**: Maps a check’s status into the richer display-status enum used by the renderer, including an idle state for a non-running background server.

**Data flow**: Special-cases category `app-server` with `CheckStatus::Ok` plus a `status: not running` detail into `DisplayStatus::Idle`; otherwise maps `CheckStatus::Ok`, `Warning`, and `Fail` directly to `DisplayStatus::Ok`, `Warning`, and `Fail`.

**Call relations**: Used by row rendering and by `StatusCounts::from_report` when computing footer counts.

*Call graph*: called by 2 (from_report, write_check_row).


##### `status_marker`  (lines 282–308)

```
fn status_marker(status: DisplayStatus, options: HumanOutputOptions) -> String
```

**Purpose**: Returns the colored or plain marker glyph/string for a display status in Unicode or ASCII mode.

**Data flow**: Chooses a marker string based on `options.ascii` and `status`, then applies color styling with `green`, `amber`, `orange`, `red`, or `dim` depending on the status class.

**Call relations**: Used by `status_marker_slot` for both check rows and note rows.

*Call graph*: calls 5 internal fn (amber, dim, green, orange, red); called by 1 (status_marker_slot).


##### `status_marker_slot`  (lines 310–313)

```
fn status_marker_slot(status: DisplayStatus, options: HumanOutputOptions) -> String
```

**Purpose**: Formats a status marker with trailing spacing for row layout.

**Data flow**: Calls `status_marker(status, options)` and appends a trailing space.

**Call relations**: Used by `write_check_row` and `write_note_row`.

*Call graph*: calls 1 internal fn (status_marker); 1 external calls (format!).


##### `style_description`  (lines 315–326)

```
fn style_description(
    description: &str,
    status: DisplayStatus,
    options: HumanOutputOptions,
) -> String
```

**Purpose**: Applies status-sensitive styling to a row or note description after highlighting flags and code spans.

**Data flow**: Runs `highlight_actions(description, options)` first, then dims ok/idle text, ambers update text, and leaves warning/fail/note text un-dimmed except for embedded highlights.

**Call relations**: Used by `write_check_row` and `style_note_summary`.

*Call graph*: calls 3 internal fn (amber, dim, highlight_actions); called by 1 (style_note_summary).


##### `detail_marker`  (lines 328–333)

```
fn detail_marker(is_issue: bool, options: HumanOutputOptions) -> String
```

**Purpose**: Returns the marker shown before detail rows that correspond to issue fields.

**Data flow**: Returns a blank space for non-issue rows, or an orange `▸`/`>` depending on Unicode vs ASCII mode.

**Call relations**: Used by `write_detail_line` for `HumanDetail::Row` values with an expected field.

*Call graph*: calls 1 internal fn (orange).


##### `style_note_summary`  (lines 335–340)

```
fn style_note_summary(note: &DoctorNote, options: HumanOutputOptions) -> String
```

**Purpose**: Styles note summaries, giving update notes special version/context emphasis.

**Data flow**: If `note.status` is `Update`, delegates to `style_update_note_summary`; otherwise delegates to `style_description`.

**Call relations**: Used by `write_note_row`.

*Call graph*: calls 2 internal fn (style_description, style_update_note_summary).


##### `style_update_note_summary`  (lines 342–363)

```
fn style_update_note_summary(summary: &str, options: HumanOutputOptions) -> String
```

**Purpose**: Applies special coloring to update notes so the available version stands out and contextual parenthetical text is dimmed.

**Data flow**: If color is disabled, returns the summary unchanged. Otherwise it tries to split the summary around ` available` and ` (` so it can amber the version/action portion and dim the parenthetical context; if parsing fails it falls back to ambering the whole summary or remainder.

**Call relations**: Used by `style_note_summary` and directly unit-tested for color emphasis.

*Call graph*: calls 1 internal fn (amber); called by 2 (style_note_summary, update_note_emphasizes_available_version_and_dims_context); 1 external calls (format!).


##### `summary_line`  (lines 365–404)

```
fn summary_line(report: &DoctorReport, options: HumanOutputOptions) -> String
```

**Purpose**: Builds the footer summary line showing ok/idle/note/warn/fail counts and overall status.

**Data flow**: Computes promoted notes with `notes_for_report`, derives counts via `StatusCounts::from_report(report, notes.len())`, builds colored count labels with `count_label`, inserts an ASCII or Unicode separator, computes the overall status label with `overall_status_label`, styles it with `styled_overall_status`, and returns the final string.

**Call relations**: Used by `render_human_report` after all groups are rendered.

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

**Purpose**: Formats one numeric status count with dimmed number and status-colored label.

**Data flow**: Dims the numeric count, colors the label according to the supplied `DisplayStatus`, and returns `<count> <label>`.

**Call relations**: Used by `summary_line` for each count bucket.

*Call graph*: calls 5 internal fn (amber, dim, green, orange, red); called by 1 (summary_line); 1 external calls (format!).


##### `overall_status_label`  (lines 423–429)

```
fn overall_status_label(status: CheckStatus) -> &'static str
```

**Purpose**: Maps report-wide `CheckStatus` to the footer status word.

**Data flow**: Returns `ok`, `degraded`, or `failed` for `Ok`, `Warning`, and `Fail` respectively.

**Call relations**: Used by `summary_line` before optional color styling.

*Call graph*: called by 1 (summary_line).


##### `styled_overall_status`  (lines 431–441)

```
fn styled_overall_status(label: &str, status: CheckStatus, options: HumanOutputOptions) -> String
```

**Purpose**: Applies bold green/yellow/red styling to the overall footer status when color is enabled.

**Data flow**: Returns the plain label when color is disabled; otherwise colors and bolds it according to `CheckStatus`.

**Call relations**: Used by `summary_line`.


##### `write_footer`  (lines 443–478)

```
fn write_footer(out: &mut String, options: HumanOutputOptions)
```

**Purpose**: Appends the usage-hint footer, varying between detailed and summary modes.

**Data flow**: If `options.show_details` is true, writes lines advertising `--summary`, `--all`, and `--json`. Otherwise it writes a hint to rerun without `--summary`, then a line advertising `--all` and `--json`, and returns early.

**Call relations**: Called by `render_human_report` after the summary line.

*Call graph*: called by 1 (render_human_report); 1 external calls (writeln!).


##### `header_suffix`  (lines 480–490)

```
fn header_suffix(report: &DoctorReport) -> String
```

**Purpose**: Builds the header suffix containing the Codex version and, when available, the runtime platform detail.

**Data flow**: Starts with `v<codex_version>`, then searches `report.checks` for the `runtime` category and asks `detail::detail_value(check, "platform")`; if found it returns `v<version> · <platform>`, otherwise just the version string.

**Call relations**: Used by `render_human_report` for the first header line.

*Call graph*: 1 external calls (format!).


##### `notes_for_report`  (lines 492–516)

```
fn notes_for_report(report: &DoctorReport) -> Vec<DoctorNote>
```

**Purpose**: Promotes selected conditions into the top Notes section without altering the underlying checks.

**Data flow**: Starts with an empty vector, optionally appends an update note from the `updates` check, a rollout note from the `state` check, a sandbox note from the `sandbox` check, all non-ok notes from `non_ok_notes(report)`, and an auth-reachability note from `auth_reachability_note(report)`, then returns the collected notes.

**Call relations**: Used by both `render_human_report` and `summary_line`, so note promotion affects both the Notes section and the note count.

*Call graph*: calls 6 internal fn (auth_reachability_note, find_check, non_ok_notes, rollout_note, sandbox_note, update_note); called by 2 (render_human_report, summary_line); 1 external calls (new).


##### `find_check`  (lines 518–523)

```
fn find_check(report: &'a DoctorReport, category: &str) -> Option<&'a DoctorCheck>
```

**Purpose**: Finds the first check in a report with a given category.

**Data flow**: Scans `report.checks` and returns `Option<&DoctorCheck>` for the first category match.

**Call relations**: Used by `notes_for_report` and `auth_reachability_note`.

*Call graph*: called by 2 (auth_reachability_note, notes_for_report).


##### `update_note`  (lines 525–545)

```
fn update_note(check: &DoctorCheck, report: &DoctorReport) -> Option<DoctorNote>
```

**Purpose**: Promotes an available-update condition into a dedicated update note.

**Data flow**: Reads `latest version status` from the updates check; if it does not mention `newer version is available`, returns `None`. Otherwise it extracts `latest version` or `cached latest version`, optionally `dismissed version`, builds a parenthetical containing the current report version and dismissed version when truthy, and returns a `DoctorNote` with `DisplayStatus::Update`.

**Call relations**: Called by `notes_for_report` when an `updates` check exists.

*Call graph*: calls 2 internal fn (detail_value, is_falsy); called by 1 (notes_for_report); 1 external calls (format!).


##### `rollout_note`  (lines 547–562)

```
fn rollout_note(check: &DoctorCheck) -> Option<DoctorNote>
```

**Purpose**: Promotes unusually large active rollout-file accumulation into a warning note.

**Data flow**: Reads `active rollout files` from the state check, parses file and byte counts with `detail::rollout_files_and_bytes`, and returns `None` unless files are at least 1000 or bytes at least 1 GiB. Otherwise it formats a warning note using `detail::format_count` and `detail::format_bytes`.

**Call relations**: Used by `notes_for_report` for the `state` category.

*Call graph*: calls 2 internal fn (detail_value, rollout_files_and_bytes); called by 1 (notes_for_report); 1 external calls (format!).


##### `sandbox_note`  (lines 564–575)

```
fn sandbox_note(check: &DoctorCheck) -> Option<DoctorNote>
```

**Purpose**: Promotes non-restricted sandbox settings into a warning note.

**Data flow**: Reads `filesystem sandbox` and `network sandbox` from the sandbox check; if both are `restricted`, returns `None`, otherwise returns a warning note summarizing both values.

**Call relations**: Used by `notes_for_report` for the `sandbox` category.

*Call graph*: calls 1 internal fn (detail_value); called by 1 (notes_for_report); 1 external calls (format!).


##### `non_ok_notes`  (lines 577–588)

```
fn non_ok_notes(report: &DoctorReport) -> Vec<DoctorNote>
```

**Purpose**: Converts every warning or failing check into a note summary for the Notes section.

**Data flow**: Filters `report.checks` for warning/fail statuses, maps each to a `DoctorNote` using `display_status(check)` and `actionable_note_summary(check)`, and returns the resulting vector.

**Call relations**: Used by `notes_for_report` to surface all non-ok checks at the top of the report.

*Call graph*: called by 1 (notes_for_report).


##### `actionable_note_summary`  (lines 590–598)

```
fn actionable_note_summary(check: &DoctorCheck) -> String
```

**Purpose**: Chooses the note summary text for a non-ok check, preferring issue causes and remediation over generic summaries.

**Data flow**: Returns `issue_summary(check)` when issues exist, otherwise `"<summary> - <remediation>"` when remediation exists, otherwise `check.summary.clone()`.

**Call relations**: Used by `non_ok_notes`.

*Call graph*: calls 1 internal fn (issue_summary); 1 external calls (format!).


##### `auth_reachability_note`  (lines 600–615)

```
fn auth_reachability_note(report: &DoctorReport) -> Option<DoctorNote>
```

**Purpose**: Detects and surfaces mixed auth signals between websocket auth mode and HTTP reachability mode.

**Data flow**: Finds the `websocket` and `reachability` checks, extracts `auth mode` and `reachability mode` details, lowercases both, and when websocket auth looks ChatGPT-based while reachability mode looks API-key-based returns a warning note explaining the mismatch.

**Call relations**: Used by `notes_for_report` to add a cross-check note that no single check can express alone.

*Call graph*: calls 2 internal fn (detail_value, find_check); called by 1 (notes_for_report).


##### `display_summary`  (lines 617–635)

```
fn display_summary(check: &DoctorCheck, options: HumanOutputOptions) -> String
```

**Purpose**: Chooses a concise category-specific summary for ok rows and fallback cases.

**Data flow**: Matches `check.category` and delegates to specialized summary helpers for system, runtime, search, git, terminal, title, state, MCP, sandbox, network, websocket, and app-server; some categories like `install` and `config` collapse ok summaries to fixed words. Unknown categories fall back to `check.summary.clone()`.

**Call relations**: Used by `row_description` when no issue/remediation headline should override the summary.

*Call graph*: calls 12 internal fn (app_server_summary, git_summary, mcp_summary, network_summary, runtime_summary, sandbox_summary, search_summary, state_summary, system_summary, terminal_summary (+2 more)); called by 1 (row_description).


##### `system_summary`  (lines 637–639)

```
fn system_summary(check: &DoctorCheck) -> String
```

**Purpose**: Uses the detected OS language as the concise system-row summary when available.

**Data flow**: Reads `os language` from the check via `detail::detail_value`; falls back to `check.summary` if absent.

**Call relations**: Used by `display_summary` for the `system` category.

*Call graph*: calls 1 internal fn (detail_value); called by 1 (display_summary).


##### `runtime_summary`  (lines 641–648)

```
fn runtime_summary(check: &DoctorCheck) -> String
```

**Purpose**: Summarizes runtime provenance, special-casing local debug builds.

**Data flow**: If `current executable` contains `/target/debug/`, returns `local debug build`; otherwise it prefers the `install method` detail and falls back to `check.summary`.

**Call relations**: Used by `display_summary` for the `runtime` category.

*Call graph*: calls 1 internal fn (detail_value); called by 1 (display_summary).


##### `search_summary`  (lines 650–660)

```
fn search_summary(check: &DoctorCheck) -> String
```

**Purpose**: Builds a compact search summary from provider, command, and readiness details when the check is ok.

**Data flow**: Reads `search provider`, `search command`, and `search command readiness`; when all are present and status is ok it returns `<readiness> (<provider>, `<command>` )`, otherwise it falls back to `check.summary`.

**Call relations**: Used by `display_summary` for the `search` category.

*Call graph*: calls 1 internal fn (detail_value); called by 1 (display_summary); 1 external calls (format!).


##### `git_summary`  (lines 662–666)

```
fn git_summary(check: &DoctorCheck) -> String
```

**Purpose**: Uses Git version or selected Git path as the concise git-row summary.

**Data flow**: Prefers `git version`, then `selected git`, then falls back to `check.summary`.

**Call relations**: Used by `display_summary` for the `git` category.

*Call graph*: calls 1 internal fn (detail_value); called by 1 (display_summary).


##### `terminal_summary`  (lines 668–685)

```
fn terminal_summary(check: &DoctorCheck) -> String
```

**Purpose**: Builds a compact terminal summary from terminal name/version, multiplexer, and TERM.

**Data flow**: Collects `terminal`, optional `terminal version`, optional `multiplexer`, and optional `TERM` details into a parts vector and joins them with ` · `. If no parts are available it falls back to `check.summary`.

**Call relations**: Used by `display_summary` for the `terminal` category.

*Call graph*: calls 1 internal fn (detail_value); called by 1 (display_summary); 2 external calls (new, format!).


##### `title_summary`  (lines 687–698)

```
fn title_summary(check: &DoctorCheck, options: HumanOutputOptions) -> String
```

**Purpose**: Builds a concise terminal-title summary from title source and project value.

**Data flow**: Reads `terminal title source` and `terminal title project value`; when both exist it joins them with either ` · ` or ` | ` depending on ASCII mode, when only source exists it returns that, otherwise it falls back to `check.summary`.

**Call relations**: Used by `display_summary` for the `title` category.

*Call graph*: calls 1 internal fn (detail_value); called by 1 (display_summary); 1 external calls (format!).


##### `state_summary`  (lines 700–714)

```
fn state_summary(check: &DoctorCheck) -> String
```

**Purpose**: Collapses a healthy state check into `databases healthy` when all known DB integrity details are `ok`.

**Data flow**: Checks `state DB integrity`, `log DB integrity`, `goals DB integrity`, and `memories DB integrity` via `detail::detail_value`; if the check status is ok and all are `ok`, returns `databases healthy`, otherwise returns `check.summary`.

**Call relations**: Used by `display_summary` for the `state` category.

*Call graph*: called by 1 (display_summary).


##### `mcp_summary`  (lines 716–739)

```
fn mcp_summary(check: &DoctorCheck) -> String
```

**Purpose**: Builds a compact MCP summary from configured-server count, disabled count, and transport counts.

**Data flow**: Reads `configured servers` and `disabled servers`, scans raw detail strings for `<transport> servers: <count>` lines excluding `configured` and `disabled`, and returns either `<count> servers · <disabled> disabled` or `<count> server (<transport counts>) · <disabled> disabled`.

**Call relations**: Used by `display_summary` for the `mcp` category.

*Call graph*: calls 1 internal fn (detail_value); called by 1 (display_summary); 1 external calls (format!).


##### `sandbox_summary`  (lines 741–751)

```
fn sandbox_summary(check: &DoctorCheck) -> String
```

**Purpose**: Builds a concise sandbox summary from filesystem, network, and approval-policy details.

**Data flow**: Reads `approval policy`, `filesystem sandbox`, and `network sandbox`; when all are present it returns `<filesystem> fs + <network> network · approval <approval>`, otherwise it falls back to `check.summary`.

**Call relations**: Used by `display_summary` for the `sandbox` category.

*Call graph*: calls 1 internal fn (detail_value); called by 1 (display_summary); 1 external calls (format!).


##### `network_summary`  (lines 753–763)

```
fn network_summary(check: &DoctorCheck) -> String
```

**Purpose**: Summarizes network environment state based on whether proxy env vars are present.

**Data flow**: Reads `proxy env vars`; if the value is `none` it returns `no proxy env vars`, otherwise `proxy env vars present`. Missing detail falls back to `check.summary`.

**Call relations**: Used by `display_summary` for the `network` category.

*Call graph*: calls 1 internal fn (detail_value); called by 1 (display_summary).


##### `websocket_summary`  (lines 765–774)

```
fn websocket_summary(check: &DoctorCheck) -> String
```

**Purpose**: Builds a concise websocket summary from handshake status and connect timeout details.

**Data flow**: Reads `handshake result` or `handshake status` plus `connect timeout`, normalizes timeout strings like `3000 ms` to `3s`, and returns `connected (<status>) · <timeout> timeout` when both are present; otherwise it falls back to `check.summary`.

**Call relations**: Used by `display_summary` for the `websocket` category.

*Call graph*: calls 1 internal fn (detail_value); called by 1 (display_summary); 1 external calls (format!).


##### `app_server_summary`  (lines 776–783)

```
fn app_server_summary(check: &DoctorCheck) -> String
```

**Purpose**: Builds a concise app-server summary from status and mode details.

**Data flow**: Reads `status` and `mode`; when both are present it returns `<status> (<mode> mode)`, otherwise it falls back to `check.summary`.

**Call relations**: Used by `display_summary` for the `app-server` category.

*Call graph*: calls 1 internal fn (detail_value); called by 1 (display_summary); 1 external calls (format!).


##### `separator`  (lines 785–791)

```
fn separator(options: HumanOutputOptions) -> String
```

**Purpose**: Returns the horizontal separator line used between sections and before the footer summary.

**Data flow**: Returns either `-` repeated `SEPARATOR_WIDTH` times in ASCII mode or `─` repeated that many times otherwise.

**Call relations**: Used by `render_human_report` around the Notes section and footer.


##### `highlight_actions`  (lines 793–813)

```
fn highlight_actions(text: &str, options: HumanOutputOptions) -> String
```

**Purpose**: Highlights inline code spans and CLI flags inside descriptive text when color is enabled.

**Data flow**: If color is disabled it returns the input unchanged. Otherwise it splits on backticks, styles non-code segments with `highlight_flags`, styles code segments with `cyan`, and rejoins them.

**Call relations**: Used by `style_description` and remedy/detail rendering paths.

*Call graph*: calls 2 internal fn (cyan, highlight_flags); called by 1 (style_description); 1 external calls (new).


##### `highlight_flags`  (lines 815–830)

```
fn highlight_flags(text: &str, options: HumanOutputOptions) -> String
```

**Purpose**: Highlights `--flag` tokens inside plain text while preserving punctuation and whitespace.

**Data flow**: Splits the text inclusively on whitespace, trims trailing punctuation from each token, colors tokens starting with `--` via `cyan`, then reattaches punctuation and whitespace.

**Call relations**: Used by `highlight_actions`.

*Call graph*: called by 1 (highlight_actions).


##### `redact_detail`  (lines 832–860)

```
fn redact_detail(detail: &str) -> String
```

**Purpose**: Redacts secrets and sanitizes URLs in detail strings before they are shown or serialized.

**Data flow**: Lowercases the detail to inspect labels and keywords. If the label contains `env var`, it only sanitizes URLs. If the value side is a safe presence boolean like `present`, `missing`, or `true`, it also only sanitizes URLs. Otherwise, if the detail contains secret-bearing keywords such as `openai_api_key`, `token`, `secret`, or `authorization`, it preserves the label and replaces the value with `<redacted>`. All non-secret cases still pass through `redact_urls` to strip URL credentials, query strings, fragments, and deep path segments.

**Call relations**: Used by JSON serialization helpers in `doctor.rs` and by the detail submodule’s parsing path so human output also sees redacted values.

*Call graph*: calls 1 internal fn (redact_urls); called by 4 (redact_detail_sanitizes_secret_url_path_segments, redact_detail_sanitizes_urls, redacted_json_issue, structured_json_details); 1 external calls (format!).


##### `is_safe_presence_value`  (lines 862–867)

```
fn is_safe_presence_value(value: &str) -> bool
```

**Purpose**: Recognizes low-risk presence/boolean values that can be preserved verbatim even for sensitive-looking labels.

**Data flow**: Lowercases and trims the value and returns true for `true`, `false`, `yes`, `no`, `present`, `absent`, `missing`, and `not set`.

**Call relations**: Used by `redact_detail` to avoid over-redacting harmless presence indicators.

*Call graph*: 1 external calls (matches!).


##### `redact_urls`  (lines 869–874)

```
fn redact_urls(detail: &str) -> String
```

**Purpose**: Sanitizes every URL-like token in a detail string while leaving non-URL text untouched.

**Data flow**: Splits the string inclusively on whitespace, maps each token through `redact_url_token`, and concatenates the results.

**Call relations**: Used by `redact_detail`.

*Call graph*: called by 1 (redact_detail).


##### `redact_url_token`  (lines 876–914)

```
fn redact_url_token(token: &str) -> String
```

**Purpose**: Sanitizes one URL token by removing credentials, query strings, fragments, and sensitive deep path segments.

**Data flow**: Detects `://`; if absent returns the token unchanged. Otherwise it trims trailing punctuation/whitespace into a suffix, isolates the authority and path, strips any `user:pass@` credentials, drops query and fragment portions, shortens the path via `redact_url_path`, and reconstructs the sanitized token plus suffix.

**Call relations**: Used by `redact_urls`.

*Call graph*: calls 1 internal fn (redact_url_path); 2 external calls (format!, matches!).


##### `redact_url_path`  (lines 916–926)

```
fn redact_url_path(path: &str) -> String
```

**Purpose**: Preserves only the first path segment of multi-segment URL paths, replacing the remainder with `<redacted>`.

**Data flow**: Splits the path on `/`, ignores empty segments, and if there is more than one nonempty segment returns `/<first>/<redacted>`; otherwise it returns the original path.

**Call relations**: Used by `redact_url_token`.

*Call graph*: called by 1 (redact_url_token); 1 external calls (format!).


##### `StatusCounts::from_report`  (lines 938–953)

```
fn from_report(report: &DoctorReport, notes: usize) -> Self
```

**Purpose**: Counts displayed check statuses plus promoted notes for the footer summary.

**Data flow**: Starts with `notes` prefilled from the caller, iterates `report.checks`, maps each through `display_status`, increments `ok`, `idle`, `warning`, or `fail` accordingly, and ignores `Update`/`Note` because those are note-only display statuses.

**Call relations**: Used by `summary_line`.

*Call graph*: calls 1 internal fn (display_status); called by 1 (summary_line); 1 external calls (default).


##### `bold`  (lines 956–962)

```
fn bold(text: &str, options: HumanOutputOptions) -> String
```

**Purpose**: Applies bold styling when color output is enabled.

**Data flow**: Returns `text.bold().to_string()` when `options.color_enabled`, otherwise returns the plain text.

**Call relations**: Used by header and section-title rendering.


##### `dim`  (lines 964–970)

```
fn dim(text: &str, options: HumanOutputOptions) -> String
```

**Purpose**: Applies dim styling when color output is enabled.

**Data flow**: Returns `text.dimmed().to_string()` when color is enabled, otherwise the plain text.

**Call relations**: Used widely across separators, counts, descriptions, and low-signal detail styling.

*Call graph*: called by 5 (count_label, status_marker, style_description, style_detail_bare_token, summary_line).


##### `very_dim`  (lines 972–974)

```
fn very_dim(text: &str, options: HumanOutputOptions) -> String
```

**Purpose**: Applies a darker 256-color style for low-emphasis markers like bullets.

**Data flow**: Delegates to `color256(text, 238, options)`.

**Call relations**: Used by `write_detail_line` for bullet markers.

*Call graph*: calls 1 internal fn (color256).


##### `detail_label`  (lines 976–978)

```
fn detail_label(text: &str, options: HumanOutputOptions) -> String
```

**Purpose**: Applies subdued styling to detail labels.

**Data flow**: Delegates to `color256(text, 240, options)`.

**Call relations**: Used by `write_detail_line`.

*Call graph*: calls 1 internal fn (color256).


##### `detail_value`  (lines 980–985)

```
fn detail_value(text: &str, options: HumanOutputOptions) -> String
```

**Purpose**: Styles detail values, including inline code spans and low-signal tokens, when color is enabled.

**Data flow**: Returns the plain text when color is disabled; otherwise delegates to `style_detail_text`.

**Call relations**: Used by `write_detail_line` and directly unit-tested for token coloring.

*Call graph*: calls 1 internal fn (style_detail_text); called by 2 (detail_value_colors_inline_statuses_and_low_signal_values, write_detail_line).


##### `style_detail_text`  (lines 987–1003)

```
fn style_detail_text(text: &str, options: HumanOutputOptions) -> String
```

**Purpose**: Styles a detail value while preserving backtick-delimited code spans.

**Data flow**: Splits the text on backticks, styles non-code segments with `style_detail_plain_text`, styles code segments with `cyan`, and rejoins them.

**Call relations**: Used by `detail_value`.

*Call graph*: calls 2 internal fn (cyan, style_detail_plain_text); called by 1 (detail_value); 1 external calls (new).


##### `style_detail_plain_text`  (lines 1005–1009)

```
fn style_detail_plain_text(text: &str, options: HumanOutputOptions) -> String
```

**Purpose**: Styles plain-text detail content token by token.

**Data flow**: Splits the text inclusively on whitespace, maps each token through `style_detail_token`, and concatenates the results.

**Call relations**: Used by `style_detail_text`.

*Call graph*: called by 1 (style_detail_text).


##### `style_detail_token`  (lines 1011–1018)

```
fn style_detail_token(token: &str, options: HumanOutputOptions) -> String
```

**Purpose**: Styles one token while preserving trailing punctuation and whitespace.

**Data flow**: Separates trailing whitespace and punctuation from the token, styles the bare token with `style_detail_bare_token`, then reattaches punctuation and suffix.

**Call relations**: Used by `style_detail_plain_text`.

*Call graph*: calls 1 internal fn (style_detail_bare_token); 1 external calls (format!).


##### `style_detail_bare_token`  (lines 1020–1045)

```
fn style_detail_bare_token(bare: &str, options: HumanOutputOptions) -> String
```

**Purpose**: Applies semantic styling to bare detail tokens such as `<redacted>`, `ok`, falsy values, flags, and copyable paths/URLs.

**Data flow**: Returns empty string for empty tokens; styles `<redacted>` in italic gray; dims tokens containing `(missing)` or falsy values; dims falsy values after `label:` pairs; colors `ok` green; colors flags and copyable-looking paths/URLs cyan; dims unit tokens like `KB` and `files`; otherwise returns the token unchanged.

**Call relations**: Used by `style_detail_token` and depends on `detail::is_falsy` and `looks_copyable` for semantic classification.

*Call graph*: calls 6 internal fn (color256, cyan, is_falsy, dim, green, looks_copyable); called by 1 (style_detail_token); 3 external calls (new, format!, matches!).


##### `green`  (lines 1047–1049)

```
fn green(text: &str, options: HumanOutputOptions) -> String
```

**Purpose**: Applies the configured green 256-color style.

**Data flow**: Delegates to `color256(text, 10, options)`.

**Call relations**: Used for ok markers, ok labels, and `ok` detail tokens.

*Call graph*: calls 1 internal fn (color256); called by 3 (count_label, status_marker, style_detail_bare_token).


##### `amber`  (lines 1051–1053)

```
fn amber(text: &str, options: HumanOutputOptions) -> String
```

**Purpose**: Applies the configured amber 256-color style.

**Data flow**: Delegates to `color256(text, 220, options)`.

**Call relations**: Used for update markers/labels and update-note emphasis.

*Call graph*: calls 1 internal fn (color256); called by 4 (count_label, status_marker, style_description, style_update_note_summary).


##### `orange`  (lines 1055–1057)

```
fn orange(text: &str, options: HumanOutputOptions) -> String
```

**Purpose**: Applies the configured orange 256-color style.

**Data flow**: Delegates to `color256(text, 214, options)`.

**Call relations**: Used for warning markers/labels and issue/remedy markers.

*Call graph*: calls 1 internal fn (color256); called by 3 (count_label, detail_marker, status_marker).


##### `red`  (lines 1059–1061)

```
fn red(text: &str, options: HumanOutputOptions) -> String
```

**Purpose**: Applies the configured red 256-color style.

**Data flow**: Delegates to `color256(text, 196, options)`.

**Call relations**: Used for fail markers and labels.

*Call graph*: calls 1 internal fn (color256); called by 2 (count_label, status_marker).


##### `cyan`  (lines 1063–1065)

```
fn cyan(text: &str, options: HumanOutputOptions) -> String
```

**Purpose**: Applies the configured cyan 256-color style.

**Data flow**: Delegates to `color256(text, 117, options)`.

**Call relations**: Used for flags, code spans, copyable paths/URLs, and footer option names.

*Call graph*: calls 1 internal fn (color256); called by 3 (highlight_actions, style_detail_bare_token, style_detail_text).


##### `color256`  (lines 1067–1073)

```
fn color256(text: &str, code: u8, options: HumanOutputOptions) -> String
```

**Purpose**: Applies an arbitrary 256-color style when color output is enabled.

**Data flow**: If `options.color_enabled` is true, converts the numeric code into `XtermColors` and colors the text; otherwise returns the plain text.

**Call relations**: Underlying helper for all fixed-color styling functions.

*Call graph*: called by 8 (amber, cyan, detail_label, green, orange, red, style_detail_bare_token, very_dim); 1 external calls (from).


##### `looks_copyable`  (lines 1075–1083)

```
fn looks_copyable(text: &str) -> bool
```

**Purpose**: Recognizes tokens that look like URLs or filesystem paths and should be highlighted as copyable values.

**Data flow**: Returns true when the token starts with `http://`, `https://`, `wss://`, `~/`, `/`, `./`, or `../`.

**Call relations**: Used by `style_detail_bare_token`.

*Call graph*: called by 1 (style_detail_bare_token).


##### `tests::detailed_no_color_unicode_options`  (lines 1091–1098)

```
fn detailed_no_color_unicode_options() -> HumanOutputOptions
```

**Purpose**: Builds a no-color Unicode renderer option set with details enabled for tests.

**Data flow**: Returns a `HumanOutputOptions` struct with `show_details = true`, `show_all = false`, `ascii = false`, and `color_enabled = false`.

**Call relations**: Shared fixture helper for rendering tests.


##### `tests::summary_no_color_unicode_options`  (lines 1100–1107)

```
fn summary_no_color_unicode_options() -> HumanOutputOptions
```

**Purpose**: Builds a no-color Unicode renderer option set with summary-only output for tests.

**Data flow**: Returns `HumanOutputOptions` with details disabled and color disabled.

**Call relations**: Shared fixture helper for rendering tests.


##### `tests::detailed_all_no_color_unicode_options`  (lines 1109–1116)

```
fn detailed_all_no_color_unicode_options() -> HumanOutputOptions
```

**Purpose**: Builds a no-color Unicode renderer option set with details and `--all` expansion enabled for tests.

**Data flow**: Returns `HumanOutputOptions` with `show_details = true`, `show_all = true`, `ascii = false`, and `color_enabled = false`.

**Call relations**: Used by tests that verify expanded list rendering.


##### `tests::detailed_color_unicode_options`  (lines 1118–1125)

```
fn detailed_color_unicode_options() -> HumanOutputOptions
```

**Purpose**: Builds a color-enabled Unicode renderer option set for styling tests.

**Data flow**: Returns `HumanOutputOptions` with details enabled, Unicode mode, and `color_enabled = true`.

**Call relations**: Used by tests that inspect ANSI styling behavior.


##### `tests::sample_report`  (lines 1127–1237)

```
fn sample_report() -> DoctorReport
```

**Purpose**: Constructs a representative `DoctorReport` fixture spanning multiple categories for rendering tests.

**Data flow**: Builds a `DoctorReport` with a fixed version/timestamp/status and a vector of `DoctorCheck`s covering system, runtime, install, search, git, terminal, title, state, auth, updates, network, websocket, app-server, and reachability categories.

**Call relations**: Used by many rendering tests as the baseline report.

*Call graph*: 1 external calls (vec!).


##### `tests::render_human_report_includes_details_by_default_without_color`  (lines 1240–1300)

```
fn render_human_report_includes_details_by_default_without_color()
```

**Purpose**: Verifies the full detailed no-color Unicode rendering against an exact expected string.

**Data flow**: Renders `sample_report()` with detailed no-color options, builds an expected multiline string including separators, and asserts exact equality.

**Call relations**: End-to-end formatting test for `render_human_report`.

*Call graph*: calls 1 internal fn (render_human_report); 4 external calls (assert_eq!, detailed_no_color_unicode_options, sample_report, format!).


##### `tests::render_human_report_snapshot_covers_environment_rows`  (lines 1303–1308)

```
fn render_human_report_snapshot_covers_environment_rows()
```

**Purpose**: Captures a snapshot of the rendered environment rows for regression testing.

**Data flow**: Renders `sample_report()` with detailed no-color options and passes the result to `insta::assert_snapshot!`.

**Call relations**: Snapshot test for human rendering.

*Call graph*: 1 external calls (assert_snapshot!).


##### `tests::render_human_report_supports_summary_output_without_color`  (lines 1311–1355)

```
fn render_human_report_supports_summary_output_without_color()
```

**Purpose**: Verifies summary-only no-color Unicode rendering against an exact expected string.

**Data flow**: Renders `sample_report()` with summary options, builds the expected multiline string, and asserts exact equality.

**Call relations**: End-to-end formatting test for summary mode.

*Call graph*: calls 1 internal fn (render_human_report); 4 external calls (assert_eq!, sample_report, summary_no_color_unicode_options, format!).


##### `tests::render_human_report_includes_threads_row_in_environment`  (lines 1358–1377)

```
fn render_human_report_includes_threads_row_in_environment()
```

**Purpose**: Verifies that checks in the `threads` category appear under the Environment group.

**Data flow**: Adds a `threads` warning check to `sample_report`, renders summary output, finds the line containing `threads`, and asserts it contains the expected summary text.

**Call relations**: Tests category-to-group mapping via `GROUPS` and `checks_for_group`.

*Call graph*: calls 2 internal fn (new, render_human_report); 3 external calls (assert!, sample_report, summary_no_color_unicode_options).


##### `tests::render_human_report_includes_memories_db_in_state_health_summary`  (lines 1380–1408)

```
fn render_human_report_includes_memories_db_in_state_health_summary()
```

**Purpose**: Verifies that state rendering recognizes the memories DB as part of healthy database summaries and detailed rows.

**Data flow**: Builds a report with a state check containing all DB integrity details including memories, renders detailed output, and asserts both the `databases healthy` summary and the combined memories DB detail row.

**Call relations**: Tests `state_summary` and detail rendering integration.

*Call graph*: calls 1 internal fn (render_human_report); 3 external calls (assert!, detailed_no_color_unicode_options, vec!).


##### `tests::render_human_report_supports_ascii_output`  (lines 1411–1463)

```
fn render_human_report_supports_ascii_output()
```

**Purpose**: Verifies ASCII-mode rendering, including markers and separators, against an exact expected string.

**Data flow**: Renders `sample_report()` with ASCII summary options, builds the expected ASCII multiline string, and asserts exact equality.

**Call relations**: End-to-end formatting test for ASCII mode.

*Call graph*: calls 1 internal fn (render_human_report); 3 external calls (assert_eq!, sample_report, format!).


##### `tests::render_human_report_includes_redacted_details`  (lines 1466–1477)

```
fn render_human_report_includes_redacted_details()
```

**Purpose**: Verifies that rendered details include already-redacted sensitive fields rather than raw secrets.

**Data flow**: Renders `sample_report()` with detailed no-color options and asserts the output contains `OPENAI_API_KEY           present`.

**Call relations**: Tests integration between detail parsing and redaction.

*Call graph*: calls 1 internal fn (render_human_report); 2 external calls (assert!, sample_report).


##### `tests::render_human_report_explains_terminal_warning_issue`  (lines 1480–1516)

```
fn render_human_report_explains_terminal_warning_issue()
```

**Purpose**: Verifies that warning rows with structured issues show the issue cause, expected value, and remedy rather than a generic metadata summary.

**Data flow**: Builds a report with a terminal warning check containing details and one structured issue, renders detailed output, and asserts the row headline, issue detail marker with expected text, remedy line, and absence of the generic terminal metadata summary.

**Call relations**: Tests `row_description`, issue-aware detail rendering, and remedy rendering.

*Call graph*: calls 1 internal fn (render_human_report); 3 external calls (assert!, detailed_no_color_unicode_options, vec!).


##### `tests::render_human_report_promotes_notes_without_changing_statuses`  (lines 1519–1594)

```
fn render_human_report_promotes_notes_without_changing_statuses()
```

**Purpose**: Verifies note promotion for updates, rollout accumulation, sandbox looseness, MCP warnings, mixed auth signals, and idle app-server state.

**Data flow**: Builds a report with checks designed to trigger promoted notes, renders summary output, and asserts presence of update, rollout, sandbox, MCP, auth-mismatch, and idle app-server note/row text plus the expected footer counts.

**Call relations**: Tests `notes_for_report`, `display_status`, and footer counting.

*Call graph*: calls 1 internal fn (render_human_report); 3 external calls (assert!, summary_no_color_unicode_options, vec!).


##### `tests::render_human_report_expands_feature_flags_with_all`  (lines 1597–1623)

```
fn render_human_report_expands_feature_flags_with_all()
```

**Purpose**: Verifies that feature-flag details are compact by default and expanded when `show_all` is enabled.

**Data flow**: Builds a config-only report with feature-flag details, renders once with compact detailed options and once with `show_all`, then asserts the compact hint text and expanded enabled-flags row behavior.

**Call relations**: Tests integration with the detail submodule’s feature-flag presentation.

*Call graph*: calls 1 internal fn (render_human_report); 4 external calls (assert!, detailed_all_no_color_unicode_options, detailed_no_color_unicode_options, vec!).


##### `tests::detail_value_colors_inline_statuses_and_low_signal_values`  (lines 1626–1637)

```
fn detail_value_colors_inline_statuses_and_low_signal_values()
```

**Purpose**: Verifies semantic coloring of detail values such as falsy tokens, `ok`, paths, and `<redacted>`.

**Data flow**: Calls `detail_value` on a synthetic mixed-content string with color enabled and asserts the resulting ANSI output contains the expected color sequences for `no`, `unknown`, `ok`, a path, and `<redacted>`.

**Call relations**: Direct styling test for `detail_value` and its token-level helpers.

*Call graph*: calls 1 internal fn (detail_value); 2 external calls (assert!, detailed_color_unicode_options).


##### `tests::update_note_emphasizes_available_version_and_dims_context`  (lines 1640–1648)

```
fn update_note_emphasizes_available_version_and_dims_context()
```

**Purpose**: Verifies the special color treatment of update-note summaries.

**Data flow**: Calls `style_update_note_summary` with a representative update string and asserts the ANSI output contains amber version text and dimmed parenthetical context.

**Call relations**: Direct styling test for update-note formatting.

*Call graph*: calls 1 internal fn (style_update_note_summary); 2 external calls (assert!, detailed_color_unicode_options).


##### `tests::redact_detail_sanitizes_urls`  (lines 1651–1660)

```
fn redact_detail_sanitizes_urls()
```

**Purpose**: Verifies that URL redaction removes credentials, query strings, and fragments while preserving the host and first path segment.

**Data flow**: Calls `redact_detail` on a detail containing a credentialed URL with query and fragment and asserts the sanitized result.

**Call relations**: Direct unit test for URL sanitization.

*Call graph*: calls 1 internal fn (redact_detail); 1 external calls (assert_eq!).


##### `tests::redact_detail_sanitizes_secret_url_path_segments`  (lines 1663–1670)

```
fn redact_detail_sanitizes_secret_url_path_segments()
```

**Purpose**: Verifies that deep URL path segments are replaced with `<redacted>`.

**Data flow**: Calls `redact_detail` on a URL with multiple path segments and asserts the sanitized path keeps only the first segment.

**Call relations**: Direct unit test for `redact_url_path` behavior through `redact_detail`.

*Call graph*: calls 1 internal fn (redact_detail); 1 external calls (assert_eq!).


##### `tests::redact_detail_preserves_env_var_names`  (lines 1673–1678)

```
fn redact_detail_preserves_env_var_names()
```

**Purpose**: Verifies that env-var name lists are preserved rather than redacted wholesale.

**Data flow**: Asserts that `redact_detail` leaves an `auth env vars present: ...` string unchanged.

**Call relations**: Tests the env-var-label exception in `redact_detail`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::redact_detail_preserves_secret_presence_booleans`  (lines 1681–1690)

```
fn redact_detail_preserves_secret_presence_booleans()
```

**Purpose**: Verifies that harmless boolean presence indicators are preserved even for sensitive labels.

**Data flow**: Calls `redact_detail` on `stored ChatGPT tokens: true` and `false` and asserts both remain unchanged.

**Call relations**: Tests `is_safe_presence_value` integration in `redact_detail`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::render_human_report_can_emit_color`  (lines 1693–1704)

```
fn render_human_report_can_emit_color()
```

**Purpose**: Verifies that color-enabled rendering actually emits ANSI escape sequences.

**Data flow**: Renders `sample_report()` with color enabled and asserts the output contains `\u001b[`.

**Call relations**: Smoke test for colorized human rendering.

*Call graph*: calls 1 internal fn (render_human_report); 2 external calls (assert!, sample_report).


### `cli/src/doctor/output/detail.rs`

`util` · `output rendering`

This submodule sits between raw `DoctorCheck.details` strings and the terminal renderer. `detail_lines` is the entry point: it first parses and redacts raw detail strings into `ParsedDetail` records, then dispatches by check category to specialized layout functions such as `system_details`, `install_details`, `git_details`, `config_details`, and `state_details`. Those functions reorder important fields, collapse noisy raw details into more readable rows, and preserve unconsumed details via `push_remaining`.

Several category-specific transformations are notable. Installation and Git details collapse numbered PATH entries into one row plus continuations, truncating the list unless `show_all` is enabled. Config details summarize feature flags into counts and optional override lists, again expanding only under `--all`. State details merge each database path with its integrity result into a single row and convert rollout byte counts into human-readable sizes. Generic categories simply map `label: value` pairs to rows and unlabeled lines to bullets.

After category shaping, each detail is enriched by `attach_issue_metadata`, which matches issue `fields` against displayed labels so expected values can appear inline on the relevant row. `issue_remedies` appends deduplicated remedy lines at the end. Finally, `humanize_detail` shortens long path prefixes (including `HOME` → `~` replacement and middle truncation) and rewrites ISO-like timestamps into `YYYY-MM-DD HH:MM UTC`. The result is a presentation layer that keeps the underlying report schema flat while making terminal output compact and actionable.

#### Function details

##### `detail_lines`  (lines 37–56)

```
fn detail_lines(check: &DoctorCheck, options: HumanOutputOptions) -> Vec<HumanDetail>
```

**Purpose**: Converts one `DoctorCheck`’s raw detail strings and issues into the ordered `HumanDetail` rows consumed by the human renderer.

**Data flow**: Parses and redacts `check.details` with `parsed_details`, dispatches to a category-specific detail builder or `generic_details`, maps each resulting detail through `attach_issue_metadata` and `humanize_detail`, appends deduplicated remedy lines from `issue_remedies(check)`, and returns the final `Vec<HumanDetail>`.

**Call relations**: Called by `write_check_row` in the parent output module. It is the main bridge from raw report data to presentation-specific detail rows.

*Call graph*: calls 10 internal fn (config_details, generic_details, git_details, install_details, issue_remedies, parsed_details, runtime_details, state_details, system_details, title_details); called by 1 (write_check_row).


##### `system_details`  (lines 58–92)

```
fn system_details(parsed: &[ParsedDetail]) -> Vec<HumanDetail>
```

**Purpose**: Orders system details so OS, locale, and editor/pager environment values appear first and remaining details follow afterward.

**Data flow**: Builds a vector, pushes selected labels like `os`, `os language`, locale vars, and editor/pager vars via `push_row_if_present`, then appends all unconsumed details through `push_remaining`.

**Call relations**: Used by `detail_lines` for checks in the `system` category.

*Call graph*: calls 2 internal fn (push_remaining, push_row_if_present); called by 1 (detail_lines); 1 external calls (new).


##### `detail_value`  (lines 94–99)

```
fn detail_value(check: &DoctorCheck, label: &str) -> Option<String>
```

**Purpose**: Extracts the first parsed value for a given detail label from a check.

**Data flow**: Calls `parsed_details(check)`, finds the first `ParsedDetail` whose `label` matches the requested label, and returns its `value` as `Option<String>`.

**Call relations**: Used extensively by the parent renderer for concise summaries and promoted notes.

*Call graph*: calls 1 internal fn (parsed_details); called by 15 (app_server_summary, auth_reachability_note, git_summary, mcp_summary, network_summary, rollout_note, runtime_summary, sandbox_note, sandbox_summary, search_summary (+5 more)).


##### `rollout_summary`  (lines 101–114)

```
fn rollout_summary(value: &str) -> Option<String>
```

**Purpose**: Converts raw rollout aggregate text into a compact human-readable summary with formatted counts and byte sizes.

**Data flow**: Parses strings of the form `<files> files, <total> total bytes, <avg> average bytes`, converts the numeric fields to `u64`, formats them with `format_count` and `format_bytes`, and returns `<files> files · <total> (avg <avg>)`.

**Call relations**: Used by `state_details` when rendering active and archived rollout rows.

*Call graph*: called by 1 (state_details); 1 external calls (format!).


##### `rollout_files_and_bytes`  (lines 116–123)

```
fn rollout_files_and_bytes(value: &str) -> Option<(u64, u64)>
```

**Purpose**: Extracts just the file count and total bytes from a rollout aggregate string.

**Data flow**: Parses the `<files> files, <total> total bytes, ...` prefix and returns `(files, total_bytes)` as `Option<(u64, u64)>`.

**Call relations**: Used by the parent module’s `rollout_note` promotion logic.

*Call graph*: called by 1 (rollout_note).


##### `format_bytes`  (lines 125–140)

```
fn format_bytes(bytes: u64) -> String
```

**Purpose**: Formats a byte count into B, KB, MB, or GB with two decimal places for larger units.

**Data flow**: Converts `bytes: u64` to `f64`, compares against KiB/MiB/GiB thresholds, and returns a formatted size string.

**Call relations**: Used by `rollout_summary` and by note rendering in the parent module.

*Call graph*: 1 external calls (format!).


##### `format_count`  (lines 142–158)

```
fn format_count(count: u64) -> String
```

**Purpose**: Formats an integer count with comma thousands separators.

**Data flow**: Converts the count to a string, repeatedly splits off trailing three-digit groups, and rejoins them with commas.

**Call relations**: Used by `rollout_summary` and by the parent module’s rollout note.

*Call graph*: 2 external calls (new, format!).


##### `parsed_details`  (lines 160–178)

```
fn parsed_details(check: &DoctorCheck) -> Vec<ParsedDetail>
```

**Purpose**: Redacts and parses raw detail strings into `(label, value)` pairs, preserving unlabeled lines as empty-label entries.

**Data flow**: Iterates `check.details`, redacts each string with `redact_detail`, splits on the first `": "`, and returns a `Vec<ParsedDetail>` where unlabeled lines become `label = ""` and `value = full_detail`.

**Call relations**: Used by both `detail_lines` and `detail_value` as the common parsing layer.

*Call graph*: called by 2 (detail_lines, detail_value).


##### `runtime_details`  (lines 180–199)

```
fn runtime_details(parsed: &[ParsedDetail]) -> Vec<HumanDetail>
```

**Purpose**: Orders runtime details so version/provenance fields appear first and remaining details follow.

**Data flow**: Pushes `version`, `install method`, `commit`, and `current executable` rows when present, then appends all unconsumed details via `push_remaining`.

**Call relations**: Used by `detail_lines` for the `runtime` category.

*Call graph*: calls 2 internal fn (push_remaining, push_row_if_present); called by 1 (detail_lines); 1 external calls (new).


##### `install_details`  (lines 201–272)

```
fn install_details(parsed: &[ParsedDetail], options: HumanOutputOptions) -> Vec<HumanDetail>
```

**Purpose**: Transforms installation details into a compact presentation, including a synthesized managed-by row and truncated PATH-entry list.

**Data flow**: Pushes `install context` when present, converts the special inherited-managed-env message into a bullet, synthesizes a `managed by` row from `managed by npm`, `managed by bun`, and `managed package root`, gathers numbered `PATH codex #...` values with `numbered_values`, renders the first as a row plus continuations up to either 3 or all entries depending on `show_all`, adds an ellipsis continuation when truncated, then appends remaining unconsumed details.

**Call relations**: Used by `detail_lines` for the `install` category.

*Call graph*: calls 4 internal fn (numbered_values, push_remaining, push_row_if_present, value); called by 1 (detail_lines); 5 external calls (new, Bullet, Continuation, iter, format!).


##### `git_details`  (lines 274–331)

```
fn git_details(parsed: &[ParsedDetail], options: HumanOutputOptions) -> Vec<HumanDetail>
```

**Purpose**: Transforms Git details into ordered rows and a truncated PATH-entry list.

**Data flow**: Pushes selected Git metadata rows such as selected git, version, exec path, repo detection, repo root, `.git` entry, branch, and `core.fsmonitor`; gathers numbered `PATH git #...` values, renders them as one row plus continuations with optional truncation, then appends remaining unconsumed details.

**Call relations**: Used by `detail_lines` for the `git` category.

*Call graph*: calls 3 internal fn (numbered_values, push_remaining, push_row_if_present); called by 1 (detail_lines); 3 external calls (new, Continuation, format!).


##### `title_details`  (lines 333–363)

```
fn title_details(parsed: &[ParsedDetail]) -> Vec<HumanDetail>
```

**Purpose**: Orders terminal-title details so source, items, activity, and project metadata appear first.

**Data flow**: Pushes selected title-related labels when present, then appends any remaining unconsumed details.

**Call relations**: Used by `detail_lines` for the `title` category.

*Call graph*: calls 2 internal fn (push_remaining, push_row_if_present); called by 1 (detail_lines); 1 external calls (new).


##### `config_details`  (lines 365–418)

```
fn config_details(parsed: &[ParsedDetail], options: HumanOutputOptions) -> Vec<HumanDetail>
```

**Purpose**: Transforms config details into a compact presentation, including a combined model/provider row and feature-flag summary rows.

**Data flow**: If `model` exists, combines it with `model provider` into one `model` row. It then pushes cwd, config.toml, parse/read status, and MCP server count rows, delegates feature-flag presentation to `push_feature_flags`, emits one `legacy alias` row per `legacy feature flag`, and appends remaining unconsumed details.

**Call relations**: Used by `detail_lines` for the `config` category.

*Call graph*: calls 4 internal fn (push_feature_flags, push_remaining, push_row_if_present, value); called by 1 (detail_lines); 2 external calls (new, iter).


##### `state_details`  (lines 420–464)

```
fn state_details(parsed: &[ParsedDetail]) -> Vec<HumanDetail>
```

**Purpose**: Transforms state details into ordered rows, combining DB paths with integrity results and summarizing rollout aggregates.

**Data flow**: Pushes CODEX_HOME, log dir, and sqlite home rows; for each known DB label calls `push_database_row` to combine path and integrity; converts active and archived rollout aggregate strings through `rollout_summary` when possible; then appends remaining unconsumed details.

**Call relations**: Used by `detail_lines` for the `state` category.

*Call graph*: calls 5 internal fn (push_database_row, push_remaining, push_row_if_present, rollout_summary, value); called by 1 (detail_lines); 1 external calls (new).


##### `generic_details`  (lines 466–481)

```
fn generic_details(parsed: &[ParsedDetail]) -> Vec<HumanDetail>
```

**Purpose**: Provides the fallback detail rendering for categories without specialized layout rules.

**Data flow**: Maps each `ParsedDetail` to `HumanDetail::Bullet` when the label is empty, otherwise to `HumanDetail::Row` with `display_label(&detail.label)` and the raw value.

**Call relations**: Used by `detail_lines` for all categories not explicitly specialized.

*Call graph*: called by 1 (detail_lines); 1 external calls (iter).


##### `push_feature_flags`  (lines 483–513)

```
fn push_feature_flags(
    out: &mut Vec<HumanDetail>,
    parsed: &[ParsedDetail],
    options: HumanOutputOptions,
)
```

**Purpose**: Builds compact feature-flag summary rows and optional expanded lists.

**Data flow**: Reads `feature flags enabled`, parses override items from `feature flag overrides`, computes counts, emits a `feature flags` summary row with a `--all` hint when appropriate, emits an `overrides` row listing override names when any exist, and when `show_all` is true emits an `enabled flags` row from `enabled feature flags`.

**Call relations**: Used by `config_details`.

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

**Purpose**: Adds a comma-separated list row with optional truncation and `--all` hint.

**Data flow**: Chooses a limit of either all items or `LIST_LIMIT`, joins the visible items with commas, appends `, … (full list with --all)` when truncated, and pushes a `HumanDetail::Row` with the supplied label.

**Call relations**: Used by `push_feature_flags`.

*Call graph*: called by 1 (push_feature_flags).


##### `push_database_row`  (lines 542–556)

```
fn push_database_row(out: &mut Vec<HumanDetail>, parsed: &[ParsedDetail], label: &str)
```

**Purpose**: Adds one database row combining the DB path and its integrity result when both are present.

**Data flow**: Looks up the DB path by label and optional `<label> integrity`; if the path exists it pushes a row whose value is either just the path or `<path> · integrity <integrity>`.

**Call relations**: Used by `state_details` for state, log, goals, and memories DBs.

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

**Purpose**: Adds a labeled row when a source detail label exists.

**Data flow**: Looks up `source_label` with `value(parsed, source_label)` and, if found, pushes a `HumanDetail::Row` using `display_label` text supplied by the caller.

**Call relations**: Shared helper used by most category-specific detail builders.

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

**Purpose**: Appends all parsed details not already consumed by specialized layout logic.

**Data flow**: Iterates all parsed details, skips the special inherited-managed-env message and any labels/prefixes listed as consumed, then pushes unlabeled values as bullets and labeled values as rows using `display_label(&detail.label)`.

**Call relations**: Used by all specialized detail builders to preserve information they did not explicitly reorder.

*Call graph*: calls 1 internal fn (display_label); called by 7 (config_details, git_details, install_details, runtime_details, state_details, system_details, title_details); 1 external calls (Bullet).


##### `humanize_detail`  (lines 602–619)

```
fn humanize_detail(detail: HumanDetail, options: HumanOutputOptions) -> HumanDetail
```

**Purpose**: Applies value-level humanization such as path shortening and timestamp rewriting to a `HumanDetail`.

**Data flow**: Matches the detail variant and runs `humanize_value` on row values, continuation values, and bullet values, leaving remedy text unchanged.

**Call relations**: Used by `detail_lines` after issue metadata is attached.

*Call graph*: calls 1 internal fn (humanize_value); 3 external calls (Bullet, Continuation, Remedy).


##### `attach_issue_metadata`  (lines 621–636)

```
fn attach_issue_metadata(detail: HumanDetail, check: &DoctorCheck) -> HumanDetail
```

**Purpose**: Attaches expected-value metadata from matching issues to a displayed row.

**Data flow**: If the detail is a `HumanDetail::Row`, it preserves the label/value and fills `expected` from the existing field or from `issue_expected_for_label(check, &label)`; non-row details are returned unchanged.

**Call relations**: Used by `detail_lines` so issue expectations can be shown inline on the relevant detail row.


##### `issue_expected_for_label`  (lines 638–649)

```
fn issue_expected_for_label(check: &DoctorCheck, label: &str) -> Option<String>
```

**Purpose**: Finds the expected value from the first issue whose field list matches a displayed label.

**Data flow**: Scans `check.issues`, looking for any issue whose `fields` contain either the exact label or a field whose `display_label(field)` equals the label, then returns that issue’s `expected` clone.

**Call relations**: Used by `attach_issue_metadata`.


##### `issue_remedies`  (lines 651–661)

```
fn issue_remedies(check: &DoctorCheck) -> Vec<HumanDetail>
```

**Purpose**: Collects unique issue remedies into trailing remedy detail lines.

**Data flow**: Uses a `BTreeSet` to deduplicate `issue.remedy` strings across all issues, clones the unique remedies, wraps each in `HumanDetail::Remedy`, and returns the vector.

**Call relations**: Used by `detail_lines` after the main detail rows are built.

*Call graph*: called by 1 (detail_lines); 1 external calls (new).


##### `humanize_value`  (lines 663–671)

```
fn humanize_value(value: &str, _options: HumanOutputOptions) -> String
```

**Purpose**: Applies presentation-only normalization to a raw detail value.

**Data flow**: If the value looks like a path, returns `shorten_path_prefix(value)`; else if it looks like a UTC timestamp, returns `humanize_timestamp(value)`; otherwise returns the original string.

**Call relations**: Used by `humanize_detail`.

*Call graph*: calls 3 internal fn (humanize_timestamp, looks_like_path, shorten_path_prefix); called by 1 (humanize_detail).


##### `humanize_timestamp`  (lines 673–680)

```
fn humanize_timestamp(value: &str) -> Option<String>
```

**Purpose**: Reformats ISO-like UTC timestamps into a shorter `date time UTC` form.

**Data flow**: Requires a string ending in `Z` with at least 17 characters, splits on `T`, takes the first five characters of the time portion, and returns `YYYY-MM-DD HH:MM UTC`.

**Call relations**: Used by `humanize_value`.

*Call graph*: called by 1 (humanize_value); 1 external calls (format!).


##### `shorten_path_prefix`  (lines 682–690)

```
fn shorten_path_prefix(value: &str) -> String
```

**Purpose**: Shortens long path-like values by home-directory substitution and middle truncation while preserving any trailing parenthetical suffix.

**Data flow**: Splits the value into a path and optional ` (suffix`, rewrites the path through `home_shortened_path`, truncates it with `middle_truncate` to `PATH_LIMIT`, then rejoins the suffix.

**Call relations**: Used by `humanize_value`.

*Call graph*: calls 2 internal fn (home_shortened_path, middle_truncate); called by 1 (humanize_value); 1 external calls (format!).


##### `home_shortened_path`  (lines 692–702)

```
fn home_shortened_path(path: &str) -> String
```

**Purpose**: Rewrites paths under the current user’s home directory to use `~`.

**Data flow**: Reads `HOME` from the environment; if unavailable or non-Unicode it returns the original path. If the path equals HOME it returns `~`; if it starts with `HOME/`, it returns `~/...`; otherwise it returns the original path.

**Call relations**: Used by `shorten_path_prefix`.

*Call graph*: called by 1 (shorten_path_prefix); 2 external calls (var_os, format!).


##### `middle_truncate`  (lines 704–721)

```
fn middle_truncate(value: &str, max_chars: usize) -> String
```

**Purpose**: Truncates long strings by keeping the head and tail with a single ellipsis in the middle.

**Data flow**: Counts characters; if within `max_chars` it returns the original string. Otherwise it keeps roughly half the characters from the start and the remainder from the end, inserting `…` between them.

**Call relations**: Used by `shorten_path_prefix`.

*Call graph*: called by 1 (shorten_path_prefix); 1 external calls (format!).


##### `looks_like_path`  (lines 723–728)

```
fn looks_like_path(value: &str) -> bool
```

**Purpose**: Recognizes values that should be treated as filesystem paths for shortening.

**Data flow**: Returns true when the value starts with `/`, `~/`, `./`, or `../`.

**Call relations**: Used by `humanize_value`.

*Call graph*: called by 1 (humanize_value).


##### `numbered_values`  (lines 730–736)

```
fn numbered_values(parsed: &[ParsedDetail], prefix: &str) -> Vec<String>
```

**Purpose**: Collects values from parsed details whose labels share a numbered prefix.

**Data flow**: Filters `parsed` for labels starting with the given prefix and returns their values as a vector of strings.

**Call relations**: Used by `install_details` and `git_details` for PATH-entry lists.

*Call graph*: called by 2 (git_details, install_details); 1 external calls (iter).


##### `value`  (lines 738–743)

```
fn value(parsed: &'a [ParsedDetail], label: &str) -> Option<&'a str>
```

**Purpose**: Returns the first parsed detail value for an exact label.

**Data flow**: Scans the parsed detail slice for a matching label and returns `Option<&str>` pointing into the stored value.

**Call relations**: Shared lookup helper used throughout category-specific detail builders.

*Call graph*: called by 6 (config_details, install_details, push_database_row, push_feature_flags, push_row_if_present, state_details); 1 external calls (iter).


##### `display_label`  (lines 745–753)

```
fn display_label(label: &str) -> String
```

**Purpose**: Maps certain raw detail labels to friendlier display labels while leaving most labels unchanged.

**Data flow**: Special-cases labels like `codex-linux-sandbox helper` → `linux helper`, `optional reachability failed` → `optional reachability`, and `check for update on startup` → `startup update check`; otherwise returns the original label as a string.

**Call relations**: Used by `generic_details`, `push_remaining`, and issue-field matching.

*Call graph*: called by 1 (push_remaining).


##### `list_items`  (lines 755–765)

```
fn list_items(value: &str) -> Vec<String>
```

**Purpose**: Parses a comma-separated detail value into a list of trimmed items, treating falsy values as empty.

**Data flow**: If `is_falsy(value)` is true it returns an empty vector; otherwise it splits on commas, trims each item, drops empties, and collects owned strings.

**Call relations**: Used by `push_feature_flags`.

*Call graph*: calls 1 internal fn (is_falsy); called by 1 (push_feature_flags); 1 external calls (new).


##### `override_names`  (lines 767–773)

```
fn override_names(items: &[String]) -> Vec<String>
```

**Purpose**: Extracts just the feature names from `name=value` override strings.

**Data flow**: Maps each item to the substring before `=` when present, otherwise the whole item, and returns the resulting names as strings.

**Call relations**: Used by `push_feature_flags` when rendering override names.

*Call graph*: called by 1 (push_feature_flags).


##### `yes_no`  (lines 775–777)

```
fn yes_no(value: &str) -> &'static str
```

**Purpose**: Converts the string `true` into `yes` and everything else into `no` for compact display.

**Data flow**: Returns `yes` only when the input equals `true`; otherwise returns `no`.

**Call relations**: Used by `install_details` for the synthesized managed-by row.


##### `is_falsy`  (lines 779–784)

```
fn is_falsy(value: &str) -> bool
```

**Purpose**: Recognizes empty or low-signal values that should be treated as absent/false in presentation logic.

**Data flow**: Lowercases and trims the input and returns true for `""`, `false`, `none`, `not set`, `unknown`, `missing`, `absent`, `no`, `—`, and `-`.

**Call relations**: Used by list parsing, feature-flag rendering, and the parent renderer’s detail styling and update-note logic.

*Call graph*: called by 3 (list_items, style_detail_bare_token, update_note); 1 external calls (matches!).


### `exec/src/event_processor_with_jsonl_output.rs`

`domain_logic` · `request handling and shutdown serialization`

This file is the structured-output counterpart to the human renderer. `EventProcessorWithJsonOutput` maintains an optional last-message file path, an atomic counter for synthetic exec item ids, a `HashMap` from raw protocol item ids to emitted exec ids so started/completed events can be correlated, optional in-progress todo-list state for turn plans, the latest total token usage, the last critical thread error, and final-message/shutdown-emission state. `emit` serializes each `ThreadEvent` to JSON and prints it as one line, falling back to a minimal JSON error object if serialization itself fails.

The core translation logic lives in `collect_thread_events`. It pattern-matches `ServerNotification` values and produces zero or more `ThreadEvent`s plus a `CodexStatus`. Item notifications are converted through `map_started_item`, `map_completed_item_mut`, and the large `map_item_with_id`, which maps protocol `ThreadItem` variants into internal `exec_events` types for agent messages, reasoning, command execution, file changes, MCP calls, collaboration tool calls, and web search. Agent-message starts are intentionally ignored; reasoning items with empty summaries are suppressed. Turn-plan updates become a started or updated todo-list item, and turn completion reconciles any started-but-never-completed items by synthesizing completion events from the final turn snapshot. Successful turns emit `TurnCompleted` with usage totals and recover the final message from turn items; failed turns emit `TurnFailed`, preferring the turn error, then the last critical error, then a generic fallback. The `EventProcessor` trait implementation simply emits the collected events and writes the last-message file on shutdown only when a successful final message should be persisted.

#### Function details

##### `EventProcessorWithJsonOutput::new`  (lines 82–93)

```
fn new(last_message_path: Option<PathBuf>) -> Self
```

**Purpose**: Constructs a fresh JSONL event processor with empty mapping, todo, usage, error, and final-message state. It is the standard initializer for machine-readable exec output.

**Data flow**: It takes an optional `PathBuf` for the last-message file, initializes `next_item_id` to `AtomicU64::new(0)`, creates an empty `HashMap`, sets all optional runtime fields to `None`, and returns the new processor.

**Call relations**: This constructor is called by session orchestration and many unit tests before any notifications are processed.

*Call graph*: called by 32 (failed_turn_does_not_overwrite_output_last_message_file, mcp_tool_call_result_preserves_meta_in_jsonl_event, runtime_warning_emits_a_non_fatal_error_item, run_exec_session, agent_message_item_started_is_ignored, agent_message_item_updates_final_message, collab_spawn_begin_and_end_emit_item_events, command_execution_started_and_completed_translate_to_thread_events, empty_reasoning_items_are_ignored, failed_turn_clears_stale_final_message (+15 more)); 2 external calls (new, new).


##### `EventProcessorWithJsonOutput::final_message`  (lines 95–97)

```
fn final_message(&self) -> Option<&str>
```

**Purpose**: Returns the currently remembered final message, if any, as a borrowed string slice. It exposes internal state for tests and callers that need to inspect shutdown output.

**Data flow**: It reads `self.final_message` and returns `Option<&str>` via `as_deref()` without mutating state.

**Call relations**: This accessor is used primarily by tests after driving the processor through notifications.


##### `EventProcessorWithJsonOutput::next_item_id`  (lines 99–101)

```
fn next_item_id(&self) -> String
```

**Purpose**: Generates the next synthetic exec item id in the form `item_N`. These ids are used for emitted thread items and for correlating started/completed events.

**Data flow**: It atomically increments `self.next_item_id` with `fetch_add(1, Ordering::SeqCst)`, formats the previous counter value into a string, and returns it.

**Call relations**: This helper is used throughout event collection, directly for standalone items and indirectly by `started_item_id` when assigning ids to long-lived raw protocol items.

*Call graph*: called by 2 (collect_thread_events, started_item_id); 1 external calls (format!).


##### `EventProcessorWithJsonOutput::emit`  (lines 104–115)

```
fn emit(&self, event: ThreadEvent)
```

**Purpose**: Serializes a `ThreadEvent` to one JSON line on stdout. If serialization fails, it emits a fallback JSON error object describing the failure.

**Data flow**: It takes ownership of a `ThreadEvent`, attempts `serde_json::to_string(&event)`, falls back to a `json!` error payload on serialization failure, and prints the resulting string with `println!`.

**Call relations**: This low-level output primitive is called by `print_config_summary`, `process_server_notification`, and `process_warning` after events have been collected.

*Call graph*: called by 3 (print_config_summary, process_server_notification, process_warning); 1 external calls (println!).


##### `EventProcessorWithJsonOutput::usage_from_last_total`  (lines 117–127)

```
fn usage_from_last_total(&self) -> Usage
```

**Purpose**: Converts the most recent aggregate token-usage snapshot into the JSONL `Usage` structure. If no usage has been seen, it returns the default zeroed usage.

**Data flow**: It reads `self.last_total_token_usage`; when absent it returns `Usage::default()`, otherwise it copies `input_tokens`, `cached_input_tokens`, `output_tokens`, and `reasoning_output_tokens` from `usage.total` into a new `Usage` value.

**Call relations**: This helper is used when emitting a `TurnCompletedEvent` from `collect_thread_events`.

*Call graph*: called by 1 (collect_thread_events); 1 external calls (default).


##### `EventProcessorWithJsonOutput::map_todo_items`  (lines 129–139)

```
fn map_todo_items(plan: &[codex_app_server_protocol::TurnPlanStep]) -> Vec<TodoItem>
```

**Purpose**: Transforms protocol turn-plan steps into JSONL todo items while preserving text and completion state. It is the adapter for plan-update notifications.

**Data flow**: It iterates over a slice of protocol `TurnPlanStep` values, clones each `step.step` into `TodoItem.text`, marks `completed` true only for `TurnPlanStepStatus::Completed`, collects the mapped items into a `Vec<TodoItem>`, and returns it.

**Call relations**: This pure helper is called from `collect_thread_events` when handling `TurnPlanUpdated` notifications.

*Call graph*: called by 1 (map_todo_items_preserves_text_and_completion_state); 1 external calls (iter).


##### `EventProcessorWithJsonOutput::map_item_with_id`  (lines 141–316)

```
fn map_item_with_id(
        item: ThreadItem,
        make_id: impl FnOnce() -> String,
    ) -> Option<ExecThreadItem>
```

**Purpose**: Maps a protocol `ThreadItem` into the internal JSONL `ExecThreadItem` representation using a caller-supplied id generator. It performs the detailed variant-by-variant translation between protocol and emitted event schemas.

**Data flow**: It takes ownership of a `ThreadItem` and a closure that yields the exec item id. Depending on the variant, it constructs `ThreadItemDetails` for agent messages, reasoning summaries, command executions, file changes, MCP tool calls, collaboration tool calls, or web searches; it clones or moves fields like text, command, output, paths, statuses, arguments, results, errors, and agent states; converts protocol enums into corresponding `exec_events` enums; suppresses empty reasoning summaries by returning `None`; and returns `Option<ExecThreadItem>`.

**Call relations**: This is the central mapping helper used by both `map_started_item` and `map_completed_item_mut`. It isolates schema translation so notification handling can focus on lifecycle and state.

*Call graph*: 9 external calls (AgentMessage, CollabToolCall, CommandExecution, FileChange, McpToolCall, Reasoning, WebSearch, from_value, to_value).


##### `EventProcessorWithJsonOutput::started_item_id`  (lines 318–326)

```
fn started_item_id(&mut self, raw_id: &str) -> String
```

**Purpose**: Returns the stable exec item id for a raw protocol item that has started, creating one if necessary. This preserves identity across later completion events.

**Data flow**: It takes a raw item id string slice, looks it up in `self.raw_to_exec_item_id`, returns the existing mapped id if present, otherwise generates a new id with `next_item_id`, inserts the raw-to-exec mapping into the hash map, and returns the new exec id.

**Call relations**: This helper is used by `map_started_item` through the closure passed into `map_item_with_id`.

*Call graph*: calls 1 internal fn (next_item_id).


##### `EventProcessorWithJsonOutput::completed_item_id`  (lines 328–332)

```
fn completed_item_id(&mut self, raw_id: &str) -> String
```

**Purpose**: Returns the exec item id for a raw protocol item that is completing and removes the start-time mapping. If no mapping exists, it synthesizes a fresh id.

**Data flow**: It takes a raw item id string slice, removes any existing mapping from `self.raw_to_exec_item_id`, and returns that id or falls back to `self.next_item_id()` if the item was never seen as started.

**Call relations**: This helper is used by `map_completed_item_mut` so completion events either match prior start events or still produce a valid standalone item id.


##### `EventProcessorWithJsonOutput::map_started_item`  (lines 334–342)

```
fn map_started_item(&mut self, item: ThreadItem) -> Option<ExecThreadItem>
```

**Purpose**: Maps an item-start notification into an emitted exec item when that item type should have a start event. Agent messages and reasoning are intentionally omitted from start events.

**Data flow**: It takes ownership of a `ThreadItem`; if the item is `AgentMessage` or `Reasoning` it returns `None`, otherwise it derives the raw protocol id from `item.id()`, passes the item and a closure using `started_item_id` into `map_item_with_id`, and returns the mapped `Option<ExecThreadItem>`.

**Call relations**: This helper is called from `collect_thread_events` for `ServerNotification::ItemStarted`. It delegates actual schema conversion to `map_item_with_id`.

*Call graph*: called by 1 (collect_thread_events); 1 external calls (map_item_with_id).


##### `EventProcessorWithJsonOutput::map_completed_item_mut`  (lines 344–359)

```
fn map_completed_item_mut(&mut self, item: ThreadItem) -> Option<ExecThreadItem>
```

**Purpose**: Maps an item-completed notification into an emitted exec item, assigning ids appropriately and suppressing empty reasoning items. Unlike start mapping, agent messages and non-empty reasoning are emitted here.

**Data flow**: It takes ownership of a `ThreadItem`, first checks whether a reasoning item’s joined summary is blank and returns `None` in that case. For agent messages and reasoning it calls `map_item_with_id` with a fresh `next_item_id`; for other variants it derives the raw id and calls `map_item_with_id` with a closure using `completed_item_id`, thereby consuming any start-time mapping.

**Call relations**: This helper is used by `collect_thread_events` for `ItemCompleted` notifications and by `reconcile_unfinished_started_items` when synthesizing completions at turn end.

*Call graph*: called by 1 (collect_thread_events); 1 external calls (map_item_with_id).


##### `EventProcessorWithJsonOutput::reconcile_unfinished_started_items`  (lines 361–376)

```
fn reconcile_unfinished_started_items(
        &mut self,
        turn_items: &[ThreadItem],
    ) -> Vec<ThreadEvent>
```

**Purpose**: Synthesizes completion events for items that were started earlier but never received an explicit completion notification before turn end. It closes lifecycle gaps using the final turn snapshot.

**Data flow**: It iterates over the completed turn’s `ThreadItem` slice, checks whether each raw item id is still present in `self.raw_to_exec_item_id`, and for those still tracked calls `map_completed_item_mut(item.clone())`; each mapped item is wrapped as `ThreadEvent::ItemCompleted` and collected into a `Vec<ThreadEvent>`.

**Call relations**: This helper is called from `collect_thread_events` during `TurnCompleted` handling before the turn-status-specific event is emitted.

*Call graph*: called by 1 (collect_thread_events); 1 external calls (iter).


##### `EventProcessorWithJsonOutput::final_message_from_turn_items`  (lines 378–392)

```
fn final_message_from_turn_items(items: &[ThreadItem]) -> Option<String>
```

**Purpose**: Extracts the final textual answer from a completed turn’s items for JSONL shutdown/file-output purposes. It prefers the latest agent message and falls back to the latest plan.

**Data flow**: It reverse-iterates the item slice, first cloning the text of the last `AgentMessage` if present, otherwise cloning the text of the last `Plan`, and returns `Option<String>`.

**Call relations**: This helper is used inside `collect_thread_events` when a turn completes successfully.

*Call graph*: 1 external calls (iter).


##### `EventProcessorWithJsonOutput::thread_started_event`  (lines 394–398)

```
fn thread_started_event(session_configured: &SessionConfiguredEvent) -> ThreadEvent
```

**Purpose**: Builds the initial `ThreadStarted` event from session configuration metadata. It exposes the thread id to downstream JSONL consumers at startup.

**Data flow**: It reads `session_configured.thread_id`, converts it to string, wraps it in `ThreadStartedEvent`, and returns `ThreadEvent::ThreadStarted(...)`.

**Call relations**: This helper is called by `print_config_summary`, which uses the startup hook to emit a machine-readable thread-start event instead of a human banner.

*Call graph*: 1 external calls (ThreadStarted).


##### `EventProcessorWithJsonOutput::collect_warning`  (lines 400–410)

```
fn collect_warning(&mut self, message: String) -> CollectedThreadEvents
```

**Purpose**: Converts a local warning string into a non-fatal JSONL error item event. Warnings are represented as completed items rather than critical thread errors.

**Data flow**: It takes a warning `String`, allocates a fresh item id with `next_item_id`, wraps the message in `ThreadItemDetails::Error(ErrorItem { ... })`, places that inside `ThreadEvent::ItemCompleted`, and returns `CollectedThreadEvents { events, status: CodexStatus::Running }`.

**Call relations**: This helper is called from `collect_thread_events` for protocol warnings and from `process_warning` for local warnings.

*Call graph*: called by 2 (collect_thread_events, process_warning); 1 external calls (vec!).


##### `EventProcessorWithJsonOutput::collect_thread_events`  (lines 412–593)

```
fn collect_thread_events(
        &mut self,
        notification: ServerNotification,
    ) -> CollectedThreadEvents
```

**Purpose**: Transforms one server notification into zero or more JSONL thread events while updating processor state such as item-id mappings, todo lists, token usage, critical errors, and final-message/shutdown flags. It is the main state machine for structured output.

**Data flow**: It takes ownership of a `ServerNotification`, initializes an output `Vec<ThreadEvent>`, and pattern-matches the notification. Depending on the variant it may create error items for config warnings/deprecations/model reroutes, delegate warnings to `collect_warning`, store `last_critical_error` for protocol errors, map item starts/completions through `map_started_item` and `map_completed_item_mut`, update `last_total_token_usage`, start/update/complete a running todo list via `map_todo_items`, reconcile unfinished started items at turn end, recover or clear `final_message`, set `emit_final_message_on_shutdown`, and emit `TurnStarted`, `TurnCompleted`, or `TurnFailed` events. It returns `CollectedThreadEvents` containing the accumulated events and the resulting `CodexStatus`.

**Call relations**: This method is called by `process_server_notification` and underpins nearly all JSONL behavior. It delegates specialized work to the mapping helpers, warning collector, usage converter, todo mapper, and final-message extractor.

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

**Purpose**: Implements the startup hook for JSONL mode by emitting a `thread.started` event instead of a human-readable summary. The config and prompt are intentionally ignored in this backend.

**Data flow**: It takes `&Config`, prompt text, and `&SessionConfiguredEvent`, ignores the first two inputs, builds a startup event with `thread_started_event(session_configured)`, and emits it with `emit`.

**Call relations**: This trait method is invoked by session orchestration at startup. It delegates event construction to `thread_started_event` and output to `emit`.

*Call graph*: calls 1 internal fn (emit); 1 external calls (thread_started_event).


##### `EventProcessorWithJsonOutput::process_server_notification`  (lines 606–612)

```
fn process_server_notification(&mut self, notification: ServerNotification) -> CodexStatus
```

**Purpose**: Processes one server notification in JSONL mode by collecting the corresponding thread events and printing each as a JSON line. It returns the resulting run status to the caller.

**Data flow**: It takes a `ServerNotification`, calls `collect_thread_events` to obtain `CollectedThreadEvents`, iterates over `collected.events` and passes each to `emit`, then returns `collected.status`.

**Call relations**: This is the `EventProcessor` trait entrypoint used by the exec session loop. It delegates all translation/state logic to `collect_thread_events` and all serialization to `emit`.

*Call graph*: calls 2 internal fn (collect_thread_events, emit).


##### `EventProcessorWithJsonOutput::process_warning`  (lines 614–620)

```
fn process_warning(&mut self, message: String) -> CodexStatus
```

**Purpose**: Processes a local warning in JSONL mode by converting it into a non-fatal error item event and emitting it. It mirrors the warning path used for protocol warnings.

**Data flow**: It takes a warning `String`, calls `collect_warning`, emits each returned event with `emit`, and returns the collected status.

**Call relations**: This trait method may be called directly by orchestration for local warnings outside the protocol. It reuses the same warning-to-event mapping as `collect_thread_events`.

*Call graph*: calls 2 internal fn (collect_warning, emit).


##### `EventProcessorWithJsonOutput::print_final_output`  (lines 622–628)

```
fn print_final_output(&mut self)
```

**Purpose**: Writes the final message file during shutdown when a successful final message should be persisted. Unlike the human backend, it does not print any additional terminal summary.

**Data flow**: It reads `self.emit_final_message_on_shutdown`, `self.last_message_path`, and `self.final_message`; if emission is enabled and a path exists, it calls `handle_last_message(self.final_message.as_deref(), path)`. Otherwise it does nothing.

**Call relations**: This shutdown hook is invoked through the `EventProcessor` trait. It delegates file-writing semantics to the shared `handle_last_message` helper.

*Call graph*: calls 1 internal fn (handle_last_message).


### `exec/src/event_processor.rs`

`orchestration` · `cross-cutting / notification processing and shutdown output`

This file introduces two core pieces used by both human-readable and JSONL output modes. First, the `CodexStatus` enum communicates whether processing should continue (`Running`) or begin shutdown (`InitiateShutdown`) after a notification. Second, the `EventProcessor` trait specifies the renderer contract: print an initial configuration summary, consume typed `ServerNotification` values, consume local warnings that do not come from the app-server protocol, and optionally emit final output during shutdown. The default `print_final_output` implementation is intentionally empty so backends only override it when they need end-of-run behavior.

The shared helper `handle_last_message` encapsulates the semantics of `--output-last-message`: it writes the provided last agent message to a target path, but if no final message exists it still writes an empty file and emits a warning to stderr explaining that empty content was written. Actual disk I/O is isolated in `write_last_message_file`, which silently does nothing when no path is supplied and reports write failures to stderr instead of propagating errors. That design keeps shutdown output best-effort and non-fatal while making missing-final-message cases visible to users and tests.

#### Function details

##### `EventProcessor::print_final_output`  (lines 28–28)

```
fn print_final_output(&mut self)
```

**Purpose**: Provides a no-op default shutdown hook for event processors. Implementations override it only when they need to emit final summaries or write the last message file.

**Data flow**: It takes `&mut self` and performs no reads, writes, or returns beyond the unit value.

**Call relations**: Concrete processors may inherit or override this trait method. Tests can invoke it through the trait to verify backend-specific shutdown behavior.

*Call graph*: called by 1 (failed_turn_does_not_overwrite_output_last_message_file).


##### `handle_last_message`  (lines 31–40)

```
fn handle_last_message(last_agent_message: Option<&str>, output_file: &Path)
```

**Purpose**: Writes the final agent message to the configured output file, or writes an empty file and warns if no final message exists. It centralizes the user-visible semantics of `--output-last-message`.

**Data flow**: It accepts `Option<&str>` and `&Path`, converts the optional message to `""` with `unwrap_or_default`, passes the contents and path to `write_last_message_file`, and if the original option was `None` prints a warning to stderr naming the destination path.

**Call relations**: This helper is called by concrete `print_final_output` implementations in both output backends. It delegates actual filesystem writing to `write_last_message_file` so callers get consistent warning behavior.

*Call graph*: calls 1 internal fn (write_last_message_file); called by 2 (print_final_output, print_final_output); 1 external calls (eprintln!).


##### `write_last_message_file`  (lines 42–48)

```
fn write_last_message_file(contents: &str, last_message_path: Option<&Path>)
```

**Purpose**: Performs the best-effort filesystem write for the last-message output file. It reports write failures to stderr instead of failing the run.

**Data flow**: It takes message contents and an optional path; if a path is present it calls `std::fs::write(path, contents)`, and on error prints `Failed to write last message file ...` to stderr. If the path is `None`, it does nothing.

**Call relations**: This is an internal helper used only by `handle_last_message`. It isolates disk I/O from the higher-level missing-message warning logic.

*Call graph*: called by 1 (handle_last_message); 2 external calls (eprintln!, write).


### `ext/goal/src/accounting.rs`

`domain_logic` · `request handling and turn/idle progress accounting`

This file defines the bookkeeping layer behind goal usage accounting. `GoalAccountingState` wraps a `Mutex<GoalAccountingInner>` plus a single-permit `Semaphore` used to serialize snapshot/write/mark-accounted sequences so concurrent tool-finish hooks cannot double-charge the same token or elapsed time. `GoalAccountingInner` stores the current turn ID, a `HashMap<String, GoalTurnAccounting>` for per-turn token baselines and active goal IDs, a `GoalWallClockAccounting` baseline for idle or current-goal elapsed time, and a remembered `budget_limit_reported_goal_id` to suppress duplicate steering injections.

Turn startup records the turn’s initial `TokenUsage` and whether tokens should count at all; plan-mode turns are explicitly excluded. Token accounting is delta-based: each turn tracks `current_token_usage` and `last_accounted_token_usage`, and `token_delta_since_last_accounting` uses saturating subtraction before converting usage into billable goal tokens via `goal_token_delta_for_usage`, which excludes cached input tokens and clamps output contribution nonnegative. Wall-clock accounting is similarly baseline-based using `Instant`, with safe conversions and overflow fallbacks.

Snapshots are only produced when there is an active goal and positive unaccounted progress; active-turn snapshots may include both token and time deltas, while idle snapshots include only time. After persistence succeeds, `mark_*_accounted_for_status` advances baselines and optionally clears active goals depending on `ThreadGoalStatus` and `BudgetLimitedGoalDisposition`. The design is careful about poisoned mutexes, stale budget-limit notifications, and resetting baselines whenever active-goal identity changes.

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

**Purpose**: Registers a new current turn and seeds its accounting baseline from the token usage observed at turn start. It also decides whether token usage should be counted for this turn based on collaboration mode.

**Data flow**: Takes a turn ID, `ModeKind`, and starting `TokenUsage`. It locks internal state, stores the turn ID as `current_turn_id`, and inserts a new `GoalTurnAccounting` into `turns` keyed by that ID. The inserted turn copies the starting usage into both current and last-accounted baselines and sets `account_tokens` to false for `ModeKind::Plan`, true otherwise.

**Call relations**: Called by the extension’s turn-start hook when a turn begins. It delegates turn initialization details to `GoalTurnAccounting::new` so later token updates and snapshots have a baseline to compare against.

*Call graph*: calls 2 internal fn (inner, new); 4 external calls (clone, into, matches!, clone).


##### `GoalAccountingState::current_turn_id`  (lines 85–87)

```
fn current_turn_id(&self) -> Option<String>
```

**Purpose**: Returns the currently tracked turn ID, if any. It provides a cheap snapshot of which turn is considered active for accounting decisions.

**Data flow**: Locks the inner mutex, clones `inner.current_turn_id`, and returns that `Option<String>`. It does not mutate state.

**Call relations**: Used by runtime logic that needs to decide whether to account active-turn progress or idle progress, and whether a newly applied goal should attach to a current turn.

*Call graph*: calls 1 internal fn (inner).


##### `GoalAccountingState::progress_accounting_permit`  (lines 94–98)

```
async fn progress_accounting_permit(
        &self,
    ) -> Result<SemaphorePermit<'_>, tokio::sync::AcquireError>
```

**Purpose**: Acquires the semaphore permit that serializes progress snapshotting and marking. This prevents overlapping accounting operations from charging the same delta twice.

**Data flow**: Awaits acquisition on `progress_accounting_lock` and returns a `SemaphorePermit` or Tokio acquire error. It reads semaphore state and temporarily consumes the sole permit until the caller drops it.

**Call relations**: Runtime accounting paths hold this permit across database writes and subsequent baseline updates. The function exists specifically so callers can bracket snapshot creation and `mark_*_accounted` in one serialized critical section.

*Call graph*: 1 external calls (acquire).


##### `GoalAccountingState::turn_is_current_active_goal`  (lines 100–109)

```
fn turn_is_current_active_goal(&self, turn_id: &str) -> bool
```

**Purpose**: Checks whether a given turn is both the current turn and presently associated with an active goal whose tokens should be counted. It is stricter than merely checking turn existence.

**Data flow**: Locks inner state, compares `current_turn_id` to the provided `turn_id`, looks up the corresponding `GoalTurnAccounting`, and returns true only if `account_tokens` is true and `active_goal_id` is `Some`. It performs no mutation.

**Call relations**: Used by runtime stop logic before attempting terminal accounting and status transitions, ensuring only the currently active goal-bearing turn can be stopped this way.

*Call graph*: calls 1 internal fn (inner).


##### `GoalAccountingState::record_token_usage`  (lines 111–132)

```
fn record_token_usage(
        &self,
        turn_id: impl Into<String>,
        total_usage: &TokenUsage,
    ) -> Option<RecordedTokenDelta>
```

**Purpose**: Updates a turn’s observed total token usage and computes any newly unaccounted positive token delta. It also reports the aggregate unflushed token delta across all token-accounted turns.

**Data flow**: Accepts a turn ID and latest total `TokenUsage`, locks inner state, finds the turn, and replaces `current_token_usage` with the new total. If the turn is missing, in plan mode, or the computed delta since `last_accounted_token_usage` is nonpositive, it returns `None`. Otherwise it returns `RecordedTokenDelta { turn_delta, thread_unflushed_delta }`, where the second field is computed from all tracked turns via `thread_unflushed_token_delta`.

**Call relations**: Called from the token-usage contributor whenever usage updates arrive for a turn. It does not persist anything itself; it prepares state so later tool-finish or turn-end accounting can charge the accumulated delta.

*Call graph*: calls 1 internal fn (inner); 2 external calls (into, clone).


##### `GoalAccountingState::mark_turn_goal_active`  (lines 134–146)

```
fn mark_turn_goal_active(&self, turn_id: &str, goal_id: impl Into<String>)
```

**Purpose**: Associates a specific turn with an active goal ID and, if that turn is current, aligns wall-clock accounting with the same goal. It also clears stale budget-limit reporting state when switching goals.

**Data flow**: Locks inner state, converts the incoming goal ID to `String`, clears `budget_limit_reported_goal_id` unless it already matches the same goal, updates the target turn’s `active_goal_id`, and if the turn is the current turn calls `wall_clock.mark_active_goal(goal_id)`. It mutates both per-turn and possibly wall-clock state.

**Call relations**: Used when a turn starts and the persisted thread goal is already active or budget-limited. It delegates wall-clock baseline management to `GoalWallClockAccounting::mark_active_goal` when the activated turn is current.

*Call graph*: calls 1 internal fn (inner); 3 external calls (as_str, clone, into).


##### `GoalAccountingState::mark_current_turn_goal_active`  (lines 148–163)

```
fn mark_current_turn_goal_active(
        &self,
        goal_id: impl Into<String>,
    ) -> Option<String>
```

**Purpose**: Marks the current turn as active for a goal and resets that turn’s token baseline to the current usage so future accounting starts from the activation point. It also activates wall-clock accounting for the same goal.

**Data flow**: Locks inner state, clones `current_turn_id`, converts the goal ID, clears stale budget-limit reporting if the goal changed, finds the current turn, sets its `active_goal_id`, calls `reset_baseline_to_current` on the turn, marks the wall clock active for that goal, and returns the current turn ID. If there is no current turn or no matching turn entry, it returns `None`.

**Call relations**: Invoked when an external goal set makes a goal active during an already-running turn. Resetting the token baseline avoids charging tokens consumed before the goal became active.

*Call graph*: calls 1 internal fn (inner); 3 external calls (as_str, clone, into).


##### `GoalAccountingState::mark_idle_goal_active`  (lines 165–172)

```
fn mark_idle_goal_active(&self, goal_id: impl Into<String>)
```

**Purpose**: Starts idle wall-clock accounting for a goal when no turn is currently active. It also clears stale budget-limit reporting state if the goal identity changed.

**Data flow**: Locks inner state, converts the goal ID, clears `budget_limit_reported_goal_id` unless it already matches, and calls `wall_clock.mark_active_goal(goal_id)`. It mutates only wall-clock and budget-limit-reporting fields.

**Call relations**: Used by runtime resume and external goal-set flows when a goal becomes active outside a running turn. It relies on wall-clock accounting to measure idle continuation time.

*Call graph*: calls 1 internal fn (inner); 2 external calls (as_str, into).


##### `GoalAccountingState::clear_current_turn_goal`  (lines 174–183)

```
fn clear_current_turn_goal(&self) -> Option<String>
```

**Purpose**: Clears the active goal association from the current turn and resets wall-clock active-goal tracking. It also forgets any remembered budget-limit notification.

**Data flow**: Locks inner state, clones `current_turn_id`, sets that turn’s `active_goal_id` to `None` if present, calls `wall_clock.clear_active_goal()`, clears `budget_limit_reported_goal_id`, and returns the current turn ID if one existed.

**Call relations**: Called when plan-mode turns begin or when active-goal tracking must be explicitly detached from the current turn. It centralizes the paired clearing of turn-local and wall-clock active-goal state.

*Call graph*: calls 1 internal fn (inner).


##### `GoalAccountingState::clear_active_goal`  (lines 185–194)

```
fn clear_active_goal(&self)
```

**Purpose**: Clears whichever goal is currently considered active, whether attached to the current turn or only to wall-clock idle accounting. It is the broad reset operation for active-goal bookkeeping.

**Data flow**: Locks inner state, and if there is a current turn entry sets its `active_goal_id` to `None`. It then clears wall-clock active-goal state and resets `budget_limit_reported_goal_id` to `None`.

**Call relations**: Used by many runtime paths after terminal statuses, failed continuation conditions, or external clears. It is intentionally tolerant of missing current-turn entries.

*Call graph*: calls 1 internal fn (inner).


##### `GoalAccountingState::progress_snapshot`  (lines 196–219)

```
fn progress_snapshot(&self, turn_id: &str) -> Option<GoalProgressSnapshot>
```

**Purpose**: Builds a snapshot of unaccounted progress for a specific turn, combining token delta and possibly wall-clock delta if the wall clock is tracking the same goal. It returns nothing when there is no active goal or no positive progress to charge.

**Data flow**: Locks inner state, looks up the turn, rejects plan-mode turns, clones the turn’s active goal ID, computes token delta since the last accounting baseline, computes elapsed seconds only if `wall_clock.active_goal_id` matches that same goal, and returns `None` if both time delta is zero and token delta is nonpositive. Otherwise it returns `GoalProgressSnapshot` containing cloned current token usage, expected goal ID, elapsed seconds, and token delta.

**Call relations**: Called by runtime active-turn accounting while holding the semaphore permit. The returned snapshot is later persisted and then fed back into `mark_progress_accounted_for_status` to advance baselines consistently.

*Call graph*: calls 1 internal fn (inner).


##### `GoalAccountingState::idle_progress_snapshot`  (lines 221–232)

```
fn idle_progress_snapshot(&self) -> Option<IdleGoalProgressSnapshot>
```

**Purpose**: Builds a snapshot of idle wall-clock progress for the currently active goal when no turn-based token accounting is involved. It only emits a snapshot for positive elapsed whole seconds.

**Data flow**: Locks inner state, clones `wall_clock.active_goal_id`, computes elapsed seconds since the wall-clock baseline, and returns `None` if there is no active goal or the elapsed seconds are zero. Otherwise it returns `IdleGoalProgressSnapshot { expected_goal_id, time_delta_seconds }`.

**Call relations**: Used by runtime idle accounting before external mutations or idle continuation decisions. It is the idle counterpart to `progress_snapshot` and intentionally carries no token usage.

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

**Purpose**: Advances active-turn accounting baselines after a progress snapshot has been successfully persisted, and clears active-goal state when the resulting goal status requires it. It also resets budget-limit reporting unless the goal remains budget-limited.

**Data flow**: Takes a turn ID, previously emitted `GoalProgressSnapshot`, resulting `ThreadGoalStatus`, and `BudgetLimitedGoalDisposition`. It computes `clear_active_goal` via `should_clear_active_goal`, locks inner state, updates the turn’s `last_accounted_token_usage` to the snapshot’s `current_token_usage`, optionally clears the turn’s `active_goal_id`, advances wall-clock baseline by `snapshot.time_delta_seconds`, optionally clears wall-clock active-goal state, and clears `budget_limit_reported_goal_id` unless status is `BudgetLimited`.

**Call relations**: Called only after the database has accepted active-turn usage accounting. It pairs with `progress_snapshot`; together they form the read-persist-mark sequence protected by the semaphore permit.

*Call graph*: calls 2 internal fn (inner, should_clear_active_goal).


##### `GoalAccountingState::finish_turn`  (lines 258–264)

```
fn finish_turn(&self, turn_id: &str)
```

**Purpose**: Removes all accounting state for a completed or aborted turn and clears `current_turn_id` if it referred to that turn. It is the cleanup step at turn end.

**Data flow**: Locks inner state, removes the turn entry from `turns`, and if `current_turn_id` matches the provided ID sets it to `None`. It returns nothing.

**Call relations**: Invoked by turn-stop and turn-abort hooks after final accounting has run. It does not itself account remaining progress; callers are expected to do that first.

*Call graph*: calls 1 internal fn (inner).


##### `GoalAccountingState::mark_idle_progress_accounted_for_status`  (lines 266–281)

```
fn mark_idle_progress_accounted_for_status(
        &self,
        snapshot: &IdleGoalProgressSnapshot,
        status: ThreadGoalStatus,
        budget_limited_goal_disposition: BudgetLimitedGoalDisp
```

**Purpose**: Advances idle wall-clock accounting after idle progress has been persisted and clears active-goal state when the resulting status demands it. It mirrors the active-turn version but without token baselines.

**Data flow**: Computes whether to clear the active goal using `should_clear_active_goal`, locks inner state, advances wall-clock baseline by the snapshot’s accounted seconds, optionally clears wall-clock active-goal state, and clears `budget_limit_reported_goal_id` unless the resulting status is `BudgetLimited`.

**Call relations**: Used by runtime idle accounting after a successful database update. It is the idle analogue of `mark_progress_accounted_for_status`.

*Call graph*: calls 2 internal fn (inner, should_clear_active_goal).


##### `GoalAccountingState::reset_idle_progress_baseline_and_clear_active_goal`  (lines 283–288)

```
fn reset_idle_progress_baseline_and_clear_active_goal(&self)
```

**Purpose**: Drops any pending idle elapsed time and clears the active goal. This is used when an idle accounting attempt finds no persisted change and the local baseline should be restarted.

**Data flow**: Locks inner state, calls `wall_clock.reset_baseline()`, then `wall_clock.clear_active_goal()`, and clears `budget_limit_reported_goal_id`. The net effect is a fresh wall-clock baseline with no active goal.

**Call relations**: Called from runtime idle accounting when the state layer reports `GoalAccountingOutcome::Unchanged`. It prevents stale idle elapsed time from being retried indefinitely against a goal that no longer matches.

*Call graph*: calls 1 internal fn (inner).


##### `GoalAccountingState::mark_budget_limit_reported_if_new`  (lines 290–297)

```
fn mark_budget_limit_reported_if_new(&self, goal_id: &str) -> bool
```

**Purpose**: Records that budget-limit steering has been reported for a goal and suppresses duplicates for the same goal ID. It returns whether this call was the first report for that goal.

**Data flow**: Locks inner state, compares `budget_limit_reported_goal_id` to the provided goal ID, returns false if equal, otherwise stores `Some(goal_id.to_string())` and returns true.

**Call relations**: Used by the tool-finish hook after accounting pushes a goal into `BudgetLimited`. The caller uses the boolean result to decide whether to inject steering only once per goal activation.

*Call graph*: calls 1 internal fn (inner).


##### `GoalAccountingState::inner`  (lines 299–301)

```
fn inner(&self) -> std::sync::MutexGuard<'_, GoalAccountingInner>
```

**Purpose**: Obtains the mutex guard for the mutable accounting state, recovering even if the mutex was poisoned by a panic. It centralizes the poison-handling policy for all state accessors and mutators.

**Data flow**: Locks `self.inner` and, on poison, converts the `PoisonError` into its inner guard with `into_inner`. It returns `MutexGuard<'_, GoalAccountingInner>`.

**Call relations**: This private helper underpins nearly every method on `GoalAccountingState`. By swallowing poison and continuing with the inner state, it keeps accounting usable after panics in callers.

*Call graph*: called by 16 (clear_active_goal, clear_current_turn_goal, current_turn_id, finish_turn, idle_progress_snapshot, mark_budget_limit_reported_if_new, mark_current_turn_goal_active, mark_idle_goal_active, mark_idle_progress_accounted_for_status, mark_progress_accounted_for_status (+6 more)).


##### `GoalAccountingState::default`  (lines 305–310)

```
fn default() -> Self
```

**Purpose**: Constructs an empty accounting state with no current turn, no tracked turns, a fresh wall-clock baseline, and a single-permit semaphore. It is the standard initializer for per-thread accounting.

**Data flow**: Creates `GoalAccountingInner::default()` inside a `Mutex` and a `Semaphore::new(1)` for `progress_accounting_lock`, then returns the assembled `GoalAccountingState`.

**Call relations**: Used when a thread store first needs accounting state, including tests and extension startup. It delegates nested initialization to `GoalAccountingInner::default` and `GoalWallClockAccounting::new`.

*Call graph*: calls 1 internal fn (default); called by 2 (goal_accounting_ignores_plan_mode_turns, goal_accounting_uses_turn_start_baseline_for_exact_deltas); 2 external calls (new, new).


##### `token_delta_since_last_accounting`  (lines 313–326)

```
fn token_delta_since_last_accounting(last: &TokenUsage, current: &TokenUsage) -> i64
```

**Purpose**: Computes the billable token delta between two cumulative `TokenUsage` snapshots using saturating subtraction. It converts raw usage differences into goal-accounted tokens.

**Data flow**: Accepts `last` and `current` `TokenUsage` references, builds a delta `TokenUsage` whose fields are `current - last` with saturation at zero for each component, then passes that delta to `goal_token_delta_for_usage` and returns the resulting `i64`.

**Call relations**: Used by `GoalTurnAccounting::token_delta_since_last_accounting` to derive per-turn unaccounted token progress. The helper isolates the exact arithmetic and saturation behavior.

*Call graph*: calls 1 internal fn (goal_token_delta_for_usage); called by 1 (token_delta_since_last_accounting).


##### `goal_token_delta_for_usage`  (lines 328–333)

```
fn goal_token_delta_for_usage(usage: &TokenUsage) -> i64
```

**Purpose**: Defines the policy for converting a `TokenUsage` record into goal-billable tokens. Cached input tokens are excluded and output tokens contribute only if nonnegative.

**Data flow**: Reads `usage.input_tokens`, subtracts `usage.cached_input_tokens` with saturation, adds `usage.output_tokens.max(0)`, and returns the sum as `i64`. It does not mutate any state.

**Call relations**: Called by `token_delta_since_last_accounting` after raw cumulative differences are computed. This function encodes the accounting rule shared across turn snapshots.

*Call graph*: called by 1 (token_delta_since_last_accounting).


##### `GoalAccountingInner::default`  (lines 336–343)

```
fn default() -> Self
```

**Purpose**: Creates the empty inner accounting state. It initializes all collections and optional markers to their inactive values.

**Data flow**: Returns `GoalAccountingInner` with `current_turn_id: None`, `turns: HashMap::new()`, `wall_clock: GoalWallClockAccounting::new()`, and `budget_limit_reported_goal_id: None`.

**Call relations**: Used exclusively by `GoalAccountingState::default` to populate the mutex-protected inner state.

*Call graph*: calls 1 internal fn (new); called by 1 (default); 1 external calls (new).


##### `GoalAccountingInner::thread_unflushed_token_delta`  (lines 347–354)

```
fn thread_unflushed_token_delta(&self) -> i64
```

**Purpose**: Sums all positive unaccounted token deltas across tracked turns that are eligible for token accounting. It gives a thread-wide view of pending token usage not yet flushed to persistent state.

**Data flow**: Iterates over `self.turns.values()`, filters to `turn.account_tokens`, computes each turn’s `token_delta_since_last_accounting().max(0)`, and folds them with saturating addition into a single `i64` total.

**Call relations**: Called by `GoalAccountingState::record_token_usage` when returning `RecordedTokenDelta`. It is informational aggregation rather than persistence logic.


##### `GoalTurnAccounting::new`  (lines 358–365)

```
fn new(current_token_usage: TokenUsage, account_tokens: bool) -> Self
```

**Purpose**: Creates per-turn accounting state with the current usage also serving as the initial accounted baseline. This ensures only usage after turn start is considered unaccounted.

**Data flow**: Takes a `TokenUsage` and `account_tokens` flag, clones the usage into `last_accounted_token_usage`, stores the original as `current_token_usage`, sets `active_goal_id` to `None`, and returns the struct.

**Call relations**: Constructed by `GoalAccountingState::start_turn` whenever a turn begins. Its baseline setup is what makes later deltas exact relative to turn start.

*Call graph*: called by 1 (start_turn); 1 external calls (clone).


##### `GoalTurnAccounting::active_goal_id`  (lines 367–369)

```
fn active_goal_id(&self) -> Option<String>
```

**Purpose**: Returns the turn’s active goal ID as an owned `String`, if one is set. It avoids exposing internal references outside the mutex guard lifetime.

**Data flow**: Clones `self.active_goal_id` and returns the `Option<String>`. No mutation occurs.

**Call relations**: Used by `GoalAccountingState::progress_snapshot` to capture the expected goal ID into a snapshot that can outlive the mutex guard.


##### `GoalTurnAccounting::reset_baseline_to_current`  (lines 371–373)

```
fn reset_baseline_to_current(&mut self)
```

**Purpose**: Moves the token-accounting baseline up to the currently observed usage. This discards any previously accumulated delta.

**Data flow**: Clones `self.current_token_usage` into `self.last_accounted_token_usage`. It mutates only the baseline field.

**Call relations**: Called when a goal becomes active mid-turn so tokens consumed before activation are not charged to that goal.

*Call graph*: 1 external calls (clone).


##### `GoalTurnAccounting::token_delta_since_last_accounting`  (lines 375–380)

```
fn token_delta_since_last_accounting(&self) -> i64
```

**Purpose**: Computes this turn’s current unaccounted billable token delta. It is the per-turn wrapper around the file-level delta helper.

**Data flow**: Passes `&self.last_accounted_token_usage` and `&self.current_token_usage` to `token_delta_since_last_accounting` and returns the resulting `i64`.

**Call relations**: Used throughout turn accounting, including snapshot creation and thread-wide unflushed aggregation. It encapsulates the turn’s baseline/current pair.

*Call graph*: calls 1 internal fn (token_delta_since_last_accounting).


##### `GoalWallClockAccounting::new`  (lines 384–389)

```
fn new() -> Self
```

**Purpose**: Creates wall-clock accounting state with a fresh `Instant` baseline and no active goal. It is the starting point for idle and active-goal elapsed-time tracking.

**Data flow**: Captures `Instant::now()` into `last_accounted_at`, sets `active_goal_id` to `None`, and returns the struct.

**Call relations**: Used by `GoalAccountingInner::default` during accounting-state initialization.

*Call graph*: called by 1 (default); 1 external calls (now).


##### `GoalWallClockAccounting::time_delta_since_last_accounting`  (lines 391–393)

```
fn time_delta_since_last_accounting(&self) -> i64
```

**Purpose**: Returns the whole-second elapsed time since the wall-clock baseline, saturating to `i64::MAX` on conversion overflow. It is the source of time deltas for snapshots.

**Data flow**: Reads `self.last_accounted_at.elapsed().as_secs()`, converts it with `i64::try_from`, and falls back to `i64::MAX` if conversion fails. It does not mutate state.

**Call relations**: Called by both active-turn and idle snapshot builders to determine how much wall-clock time can be charged.

*Call graph*: 2 external calls (elapsed, try_from).


##### `GoalWallClockAccounting::mark_accounted`  (lines 395–404)

```
fn mark_accounted(&mut self, accounted_seconds: i64)
```

**Purpose**: Advances the wall-clock baseline by the amount of time that was successfully persisted. It leaves the baseline unchanged for nonpositive accounted durations.

**Data flow**: If `accounted_seconds <= 0`, returns immediately. Otherwise converts the seconds to `Duration`, attempts `checked_add` on `last_accounted_at`, and if that overflows resets the baseline to `Instant::now()`. It mutates `last_accounted_at`.

**Call relations**: Used after successful active-turn or idle accounting to avoid recharging the same elapsed time. The additive advance preserves any subsecond remainder implicitly held by the original `Instant`.

*Call graph*: 3 external calls (from_secs, checked_add, try_from).


##### `GoalWallClockAccounting::reset_baseline`  (lines 406–408)

```
fn reset_baseline(&mut self)
```

**Purpose**: Resets the wall-clock baseline to the current instant. This discards any previously accumulated elapsed time.

**Data flow**: Sets `self.last_accounted_at = Instant::now()`. No other fields are changed.

**Call relations**: Called when active-goal identity changes or is cleared, ensuring elapsed time is measured only from the new activation point.

*Call graph*: called by 2 (clear_active_goal, mark_active_goal); 1 external calls (now).


##### `GoalWallClockAccounting::mark_active_goal`  (lines 410–416)

```
fn mark_active_goal(&mut self, goal_id: impl Into<String>)
```

**Purpose**: Marks a goal as the wall-clock active goal and resets the baseline if the goal changed. Re-marking the same goal leaves the baseline untouched.

**Data flow**: Converts the incoming goal ID to `String`, compares it to `self.active_goal_id`, and if different calls `reset_baseline()` and stores `Some(goal_id)`. It mutates both active-goal identity and possibly the baseline.

**Call relations**: Used whenever a goal becomes active for the current turn or during idle periods. The conditional reset avoids losing elapsed time when reaffirming the same goal.

*Call graph*: calls 1 internal fn (reset_baseline); 2 external calls (as_str, into).


##### `GoalWallClockAccounting::clear_active_goal`  (lines 418–421)

```
fn clear_active_goal(&mut self)
```

**Purpose**: Clears wall-clock active-goal tracking and resets the baseline. It ensures no elapsed time carries over after deactivation.

**Data flow**: Sets `self.active_goal_id = None` and then calls `reset_baseline()`. It mutates both fields.

**Call relations**: Called by many clearing and terminal-status paths in `GoalAccountingState`. It is the canonical way to stop wall-clock accumulation.

*Call graph*: calls 1 internal fn (reset_baseline).


##### `should_clear_active_goal`  (lines 424–439)

```
fn should_clear_active_goal(
    status: ThreadGoalStatus,
    budget_limited_goal_disposition: BudgetLimitedGoalDisposition,
) -> bool
```

**Purpose**: Encodes the policy for whether an accounted goal should remain active after a status update. Budget-limited goals are configurable; all other non-active terminal or paused states clear activity.

**Data flow**: Matches on `ThreadGoalStatus` and `BudgetLimitedGoalDisposition`, returning false for `Active`, conditional behavior for `BudgetLimited`, and true for `Paused`, `Blocked`, `UsageLimited`, and `Complete`.

**Call relations**: Used by both active-turn and idle post-accounting functions to decide whether to clear active-goal state after persistence. Centralizing this logic keeps status handling consistent.

*Call graph*: called by 2 (mark_idle_progress_accounted_for_status, mark_progress_accounted_for_status); 1 external calls (matches!).


### `git-utils/src/baseline.rs`

`domain_logic` · `baseline initialization and later workspace diff generation`

This module uses `gix` plus a small amount of shell-out git to maintain a destructive, internal `.git` baseline inside a directory. `reset_git_repository` removes any existing `.git` metadata, initializes a fresh repository, commits the current tree with a fixed Codex signature and commit message, and rewrites the index from `HEAD`. `ensure_git_baseline_repository` preserves an existing usable baseline if `gix::open` succeeds and `head_file_entries` can read the HEAD tree; otherwise it rebuilds from scratch.

Diffing is done entirely against the baseline commit. The code walks the HEAD tree into a `BTreeMap<String, GitBaselineFileEntry>` and separately scans the current filesystem into the same shape, hashing current file contents with `compute_hash` rather than writing loose objects. Entries include both blob OID and mode, so executable-bit changes count as modifications. Symlinks are represented as link blobs containing the target path bytes. `diff_entries` computes added/modified/deleted files, and `render_unified_diff` renders each change with `similar::TextDiff`, adding git-style headers such as `new file mode`, `deleted file mode`, or `old mode/new mode` when modes differ.

Several helpers normalize paths and bytes across platforms. The implementation intentionally ignores `.git` during tree writing and scanning, skips empty directories, and uses `spawn_blocking` for all public async APIs because the work is filesystem- and CPU-heavy.

#### Function details

##### `GitBaselineChangeStatus::label`  (lines 30–36)

```
fn label(self) -> &'static str
```

**Purpose**: Returns the short git-style single-letter label for a baseline change status.

**Data flow**: Matches `self` and returns `"A"`, `"M"`, or `"D"` for added, modified, or deleted.

**Call relations**: A small presentation helper for callers that need compact status output.


##### `GitBaselineDiff::has_changes`  (lines 54–56)

```
fn has_changes(&self) -> bool
```

**Purpose**: Reports whether the baseline diff contains any changed files.

**Data flow**: Checks whether `self.changes` is empty and returns the negation.

**Call relations**: Used by higher-level rendering code to decide whether there is anything to report.

*Call graph*: called by 1 (render_workspace_diff_file).


##### `reset_git_repository`  (lines 69–72)

```
async fn reset_git_repository(root: &Path) -> anyhow::Result<()>
```

**Purpose**: Asynchronously rebuilds the baseline repository for a directory from scratch on a blocking worker thread.

**Data flow**: Clones `root` into an owned `PathBuf`, then runs `reset_git_repository_sync(&root)` inside `tokio::task::spawn_blocking`, propagating both join and operation errors.

**Call relations**: Public async entrypoint used by tests and callers that need a fresh baseline snapshot.

*Call graph*: called by 6 (diff_reports_added_modified_and_deleted_files, reports_executable_bit_changes_as_modified, reset_creates_fresh_baseline, reset_drops_previous_history, status_scan_does_not_write_added_file_blobs, write_index_ignores_configured_hooks_path); 2 external calls (to_path_buf, spawn_blocking).


##### `ensure_git_baseline_repository`  (lines 78–92)

```
async fn ensure_git_baseline_repository(root: &Path) -> anyhow::Result<()>
```

**Purpose**: Asynchronously ensures a usable baseline repository exists, preserving an existing healthy one and recreating broken or missing metadata.

**Data flow**: Moves `root` into a blocking task, creates the directory if needed, checks whether `.git` is a directory and whether `gix::open` plus `head_file_entries` succeed, and if not falls back to `reset_git_repository_sync(&root)`.

**Call relations**: Public async repair-or-create entrypoint; it avoids destructive reset when the baseline repo is already valid.

*Call graph*: called by 1 (ensure_recovers_from_unborn_repository); 2 external calls (to_path_buf, spawn_blocking).


##### `reset_git_repository_sync`  (lines 94–102)

```
fn reset_git_repository_sync(root: &Path) -> anyhow::Result<()>
```

**Purpose**: Performs the synchronous baseline reset sequence: create root, remove old git metadata, initialize repo, commit current tree, and sync the index to HEAD.

**Data flow**: Creates `root`, calls `remove_git_metadata`, initializes a repository with `gix::init`, commits the current worktree via `commit_current_tree`, then runs `write_index_from_head`.

**Call relations**: Internal worker used by both public baseline-creation APIs.

*Call graph*: calls 3 internal fn (commit_current_tree, remove_git_metadata, write_index_from_head); 2 external calls (create_dir_all, init).


##### `diff_since_latest_init`  (lines 105–120)

```
async fn diff_since_latest_init(root: &Path) -> anyhow::Result<GitBaselineDiff>
```

**Purpose**: Asynchronously computes the file-level changes and unified diff between the baseline commit and the current directory contents.

**Data flow**: Moves `root` into a blocking task, opens the repo with `gix::open`, loads HEAD entries via `head_file_entries`, scans current filesystem entries via `current_file_entries`, computes `changes` with `diff_entries`, renders `unified_diff` with `render_unified_diff`, and returns `GitBaselineDiff`.

**Call relations**: Public async diff entrypoint used after baseline initialization.

*Call graph*: called by 6 (diff_reports_added_modified_and_deleted_files, ensure_recovers_from_unborn_repository, reports_executable_bit_changes_as_modified, reset_creates_fresh_baseline, reset_drops_previous_history, status_scan_does_not_write_added_file_blobs); 2 external calls (to_path_buf, spawn_blocking).


##### `remove_git_metadata`  (lines 122–135)

```
fn remove_git_metadata(root: &Path) -> anyhow::Result<()>
```

**Purpose**: Deletes any existing `.git` entry under the root, whether it is a directory, file, or symlink.

**Data flow**: Builds `root/.git`, reads symlink metadata, returns success if not found, and otherwise removes it with `remove_dir_all` for real directories or `remove_file` for everything else.

**Call relations**: Called during destructive baseline reset before `gix::init` creates a fresh repository.

*Call graph*: called by 1 (reset_git_repository_sync); 4 external calls (join, remove_dir_all, remove_file, symlink_metadata).


##### `commit_current_tree`  (lines 137–155)

```
fn commit_current_tree(repo: &gix::Repository, message: &str) -> anyhow::Result<()>
```

**Purpose**: Writes the current worktree into git objects and creates the baseline commit at `HEAD` with a fixed Codex signature.

**Data flow**: Obtains the repository workdir, computes a tree object ID with `write_tree`, builds author/committer signatures via `codex_signature`, converts them to refs with a mutable time buffer, and calls `repo.commit_as(..., "HEAD", message, tree_id, Vec::<ObjectId>::new())`.

**Call relations**: Used only by `reset_git_repository_sync` as the commit-creation step of baseline initialization.

*Call graph*: calls 2 internal fn (codex_signature, write_tree); called by 1 (reset_git_repository_sync); 4 external calls (commit_as, workdir, new, default).


##### `write_index_from_head`  (lines 157–160)

```
fn write_index_from_head(root: &Path) -> anyhow::Result<()>
```

**Purpose**: Resets the git index to match `HEAD` using the system git command.

**Data flow**: Runs `git read-tree --reset HEAD` in `root` through `run_git_for_status` and wraps any failure with context.

**Call relations**: Called after baseline commit creation so the repository appears clean and indexed. Tests also call it directly to verify hook suppression behavior.

*Call graph*: calls 1 internal fn (run_git_for_status); called by 2 (reset_git_repository_sync, write_index_ignores_configured_hooks_path).


##### `codex_signature`  (lines 162–171)

```
fn codex_signature() -> gix::actor::Signature
```

**Purpose**: Constructs the fixed author/committer identity used for baseline commits.

**Data flow**: Returns `gix::actor::Signature` with name `Codex`, email `noreply@openai.com`, and current UTC timestamp with zero offset.

**Call relations**: Used by `commit_current_tree` for both author and committer fields.

*Call graph*: called by 1 (commit_current_tree); 1 external calls (now).


##### `write_tree`  (lines 173–227)

```
fn write_tree(repo: &gix::Repository, dir: &Path) -> anyhow::Result<ObjectId>
```

**Purpose**: Recursively writes the current filesystem subtree into git tree and blob objects, excluding `.git` and preserving file modes and symlink targets.

**Data flow**: Reads directory entries under `dir`, skips `.git`, and for each child: recurses into directories and writes non-empty child trees; reads regular-file bytes and writes blobs with mode from `file_mode`; reads symlink targets and writes link blobs from `path_to_bytes`. It converts filenames with `os_str_to_bstring`, sorts `Entry` values, writes a `Tree` object, and returns its detached `ObjectId`.

**Call relations**: Called recursively from itself and initially from `commit_current_tree`. It is the baseline snapshot writer.

*Call graph*: calls 3 internal fn (file_mode, os_str_to_bstring, path_to_bytes); called by 1 (commit_current_tree); 8 external calls (new, find_tree, write_blob, write_object, new, read, read_dir, read_link).


##### `head_file_entries`  (lines 229–237)

```
fn head_file_entries(
    repo: &gix::Repository,
) -> anyhow::Result<BTreeMap<String, GitBaselineFileEntry>>
```

**Purpose**: Loads all non-tree entries from the baseline commit’s HEAD tree into a path-keyed map.

**Data flow**: Reads `repo.head_tree_id()`, loads the tree object, initializes an empty `BTreeMap`, and fills it by calling `collect_tree_entries` starting at an empty prefix.

**Call relations**: Used by both baseline validation (`ensure_git_baseline_repository`) and diff generation (`diff_since_latest_init`).

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

**Purpose**: Recursively traverses a git tree object and records every file or symlink entry under slash-separated relative paths.

**Data flow**: Iterates tree entries, converts each filename from `BStr` to `PathBuf` with `bstr_to_path`, joins it onto the current prefix, recurses into child trees when `mode.is_tree()`, and otherwise inserts `GitBaselineFileEntry { oid, mode }` keyed by `path_to_slash_string(&path)`.

**Call relations**: Recursive helper used only by `head_file_entries`.

*Call graph*: calls 2 internal fn (bstr_to_path, path_to_slash_string); called by 1 (head_file_entries); 3 external calls (join, find_tree, iter).


##### `current_file_entries`  (lines 267–274)

```
fn current_file_entries(
    repo: &gix::Repository,
    root: &Path,
) -> anyhow::Result<BTreeMap<String, GitBaselineFileEntry>>
```

**Purpose**: Scans the current filesystem under the repository root into the same path-to-entry map shape used for HEAD entries.

**Data flow**: Creates an empty `BTreeMap`, calls `collect_current_entries(repo, root, root, &mut entries)`, and returns the filled map.

**Call relations**: Used by `diff_since_latest_init` before comparing against HEAD.

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

**Purpose**: Recursively scans the live filesystem, excluding `.git`, and records blob hashes and modes for files and symlinks without writing objects into the repository.

**Data flow**: Reads directory entries under `dir`, skips `.git`, recurses into directories, reads regular-file bytes and inserts `GitBaselineFileEntry { oid: blob_oid(repo, &bytes), mode: file_mode(...) }` under `relative_slash_path(root, &path)`, and for symlinks reads the target and hashes `path_to_bytes(&target)` with link mode.

**Call relations**: Recursive helper used only by `current_file_entries`. Its use of `blob_oid` avoids mutating the object database during status scans.

*Call graph*: calls 4 internal fn (blob_oid, file_mode, path_to_bytes, relative_slash_path); called by 1 (current_file_entries); 4 external calls (new, read, read_dir, read_link).


##### `blob_oid`  (lines 316–319)

```
fn blob_oid(repo: &gix::Repository, bytes: &[u8]) -> anyhow::Result<ObjectId>
```

**Purpose**: Computes the git blob object ID for arbitrary bytes using the repository’s object hash algorithm without storing the blob.

**Data flow**: Calls `gix::objs::compute_hash(repo.object_hash(), Kind::Blob, bytes)` and returns the resulting `ObjectId` with context on failure.

**Call relations**: Used while scanning current files and directly in a test that verifies scans do not write loose objects.

*Call graph*: called by 2 (collect_current_entries, status_scan_does_not_write_added_file_blobs); 2 external calls (object_hash, compute_hash).


##### `diff_entries`  (lines 321–349)

```
fn diff_entries(
    head: &BTreeMap<String, GitBaselineFileEntry>,
    current: &BTreeMap<String, GitBaselineFileEntry>,
) -> Vec<GitBaselineChange>
```

**Purpose**: Computes added, modified, and deleted file records by comparing baseline and current entry maps.

**Data flow**: Iterates current entries: missing in HEAD become `Added`, differing `GitBaselineFileEntry` values become `Modified`, identical entries are ignored. It then iterates HEAD keys absent from current as `Deleted`, sorts the resulting `Vec<GitBaselineChange>` by path, and returns it.

**Call relations**: Used by `diff_since_latest_init` before unified diff rendering.

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

**Purpose**: Concatenates per-file git-style unified diff sections for all computed changes.

**Data flow**: Starts with an empty `String`, iterates `changes`, appends each `render_change_diff(...)` result, and returns the final diff text.

**Call relations**: Called by `diff_since_latest_init`; delegates all per-file formatting to `render_change_diff`.

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

**Purpose**: Renders one changed file as a git-style diff section, including mode headers and a unified textual diff of old versus current content.

**Data flow**: Looks up old and new entries by `change.path`, reads old bytes from HEAD via `read_head_blob` and new bytes from disk via `read_current_file_bytes`, decodes both lossily as text, chooses `a/...` or `/dev/null` headers depending on presence, emits `diff --git` plus `new file mode`, `deleted file mode`, or `old mode/new mode` lines as needed, then uses `similar::TextDiff::from_lines(...).unified_diff().context_radius(3).header(...)` to generate the body. It ensures the section ends with a newline.

**Call relations**: Called for each change by `render_unified_diff`. It is the main textual diff formatter in the module.

*Call graph*: called by 1 (render_unified_diff); 4 external calls (from_utf8_lossy, new, from_lines, format!).


##### `read_head_blob`  (lines 433–436)

```
fn read_head_blob(repo: &gix::Repository, entry: &GitBaselineFileEntry) -> anyhow::Result<Vec<u8>>
```

**Purpose**: Loads the raw bytes of a blob referenced by a baseline tree entry.

**Data flow**: Finds the blob by `entry.oid` in the repository and returns its owned data via `take_data()`.

**Call relations**: Used by `render_change_diff` when a file existed in the baseline commit.

*Call graph*: 1 external calls (find_blob).


##### `read_current_file_bytes`  (lines 438–449)

```
fn read_current_file_bytes(root: &Path, relative_path: &str) -> anyhow::Result<Vec<u8>>
```

**Purpose**: Reads the current bytes for a relative path, treating symlinks as their target-path bytes to match git’s link blob representation.

**Data flow**: Joins `relative_path` onto `root`, reads symlink metadata, and if the path is a symlink returns `path_to_bytes(read_link(path))`; otherwise it reads and returns the file contents.

**Call relations**: Used by `render_change_diff` when a file exists in the current filesystem.

*Call graph*: calls 1 internal fn (path_to_bytes); 4 external calls (join, read, read_link, symlink_metadata).


##### `mode_label`  (lines 451–459)

```
fn mode_label(mode: EntryMode) -> &'static str
```

**Purpose**: Maps a git tree entry mode to the canonical numeric mode string used in diff headers.

**Data flow**: Matches `mode.kind()` and returns `100644`, `100755`, `120000`, `040000`, or `160000`.

**Call relations**: Used by `render_change_diff` when emitting file-mode metadata.

*Call graph*: 1 external calls (kind).


##### `file_mode`  (lines 474–476)

```
fn file_mode(_path: &Path, default: EntryKind) -> anyhow::Result<EntryMode>
```

**Purpose**: Determines the git entry mode for a filesystem path, upgrading regular blobs to executable blobs on Unix when any execute bit is set.

**Data flow**: On Unix, reads filesystem metadata and permissions, returning `default.into()` when no execute bits are set or `BlobExecutable.into()` otherwise. On non-Unix, simply returns `default.into()`.

**Call relations**: Used while writing the baseline tree and while scanning current files so mode changes can be detected.

*Call graph*: called by 2 (collect_current_entries, write_tree); 2 external calls (into, metadata).


##### `os_str_to_bstring`  (lines 486–488)

```
fn os_str_to_bstring(value: &OsStr) -> gix::bstr::BString
```

**Purpose**: Converts an `OsStr` filename into the byte-string type expected by `gix` tree entries.

**Data flow**: On Unix, converts raw OS bytes directly; on non-Unix, converts via lossy string bytes.

**Call relations**: Used by `write_tree` when constructing `gix::objs::tree::Entry` values.

*Call graph*: called by 1 (write_tree); 2 external calls (as_bytes, to_string_lossy).


##### `path_to_bytes`  (lines 498–500)

```
fn path_to_bytes(path: &Path) -> Vec<u8>
```

**Purpose**: Converts a path into the byte representation git stores for symlink targets.

**Data flow**: On Unix, returns raw OS bytes from the path; on non-Unix, returns lossy UTF-8 bytes.

**Call relations**: Used when writing symlink blobs, hashing current symlink targets, and reading current symlink content for diff rendering.

*Call graph*: called by 3 (collect_current_entries, read_current_file_bytes, write_tree); 2 external calls (as_os_str, to_string_lossy).


##### `bstr_to_path`  (lines 502–513)

```
fn bstr_to_path(value: &gix::bstr::BStr) -> PathBuf
```

**Purpose**: Converts a `gix` byte-string filename back into a `PathBuf`.

**Data flow**: On Unix, constructs an `OsStr` from raw bytes and then a `PathBuf`; on non-Unix, converts through `String`.

**Call relations**: Used while traversing HEAD trees in `collect_tree_entries`.

*Call graph*: called by 1 (collect_tree_entries); 3 external calls (to_string, from_bytes, from).


##### `relative_slash_path`  (lines 515–519)

```
fn relative_slash_path(root: &Path, path: &Path) -> anyhow::Result<String>
```

**Purpose**: Computes a slash-separated repository-relative path string for a filesystem path.

**Data flow**: Strips `root` from `path` with context on failure, then converts the remainder with `path_to_slash_string`.

**Call relations**: Used by `collect_current_entries` to key current filesystem entries consistently with HEAD entries.

*Call graph*: called by 1 (collect_current_entries); 1 external calls (strip_prefix).


##### `path_to_slash_string`  (lines 521–526)

```
fn path_to_slash_string(path: &Path) -> String
```

**Purpose**: Normalizes a path into a `/`-separated string regardless of platform separators.

**Data flow**: Iterates path components, converts each to lossy string, collects them into a vector, and joins with `/`.

**Call relations**: Used for both HEAD-tree traversal and current-filesystem scanning so paths compare consistently.

*Call graph*: called by 1 (collect_tree_entries); 1 external calls (components).


##### `tests::git_stdout`  (lines 536–549)

```
fn git_stdout(root: &Path, args: &[&str]) -> String
```

**Purpose**: Runs a git command in tests, asserting success and returning stdout as a string.

**Data flow**: Executes `git` with the provided args in `root`, asserts `status.success()`, and converts stdout lossily to `String`.

**Call relations**: Shared assertion helper for baseline tests.

*Call graph*: 3 external calls (from_utf8_lossy, assert!, new).


##### `tests::reset_creates_fresh_baseline`  (lines 552–567)

```
async fn reset_creates_fresh_baseline()
```

**Purpose**: Verifies that resetting creates a clean baseline repository with indexed files and no diff.

**Data flow**: Creates a directory and file, calls `reset_git_repository`, then asserts `.git` and `.git/index` exist, `diff_since_latest_init` reports no changes, and git status/ls-files reflect the baseline.

**Call relations**: End-to-end test of baseline initialization.

*Call graph*: calls 2 internal fn (diff_since_latest_init, reset_git_repository); 5 external calls (new, assert!, assert_eq!, create_dir_all, write).


##### `tests::ensure_recovers_from_unborn_repository`  (lines 570–585)

```
async fn ensure_recovers_from_unborn_repository()
```

**Purpose**: Checks that `ensure_git_baseline_repository` repairs an initialized-but-unborn repository into a usable baseline.

**Data flow**: Creates a directory and file, runs `gix::init` without a commit, calls `ensure_git_baseline_repository`, then asserts no diff and clean git status.

**Call relations**: Exercises the validation-and-repair branch of baseline setup.

*Call graph*: calls 2 internal fn (diff_since_latest_init, ensure_git_baseline_repository); 6 external calls (new, assert!, assert_eq!, create_dir_all, write, init).


##### `tests::write_index_ignores_configured_hooks_path`  (lines 589–630)

```
async fn write_index_ignores_configured_hooks_path()
```

**Purpose**: Ensures rewriting the baseline index does not execute repository-configured hook directories.

**Data flow**: Creates a repo, baseline, custom hooks path, and executable `post-index-change` hook that would write a marker file; configures `core.hooksPath`, calls `write_index_from_head`, and asserts the marker was not created.

**Call relations**: Validates the hook-disabling behavior inherited from `operations::run_git_for_status`.

*Call graph*: calls 2 internal fn (reset_git_repository, write_index_from_head); 8 external calls (new, assert!, format!, create_dir_all, metadata, set_permissions, write, git_stdout).


##### `tests::diff_reports_added_modified_and_deleted_files`  (lines 633–689)

```
async fn diff_reports_added_modified_and_deleted_files()
```

**Purpose**: Checks that baseline diffing reports all three change kinds and renders expected unified diff content.

**Data flow**: Creates initial files, resets baseline, mutates one file, adds another, deletes a third, calls `diff_since_latest_init`, and asserts both structured `changes` and key diff text fragments.

**Call relations**: End-to-end test of scanning, comparison, and diff rendering.

*Call graph*: calls 2 internal fn (diff_since_latest_init, reset_git_repository); 6 external calls (new, assert!, assert_eq!, create_dir_all, remove_file, write).


##### `tests::reset_drops_previous_history`  (lines 692–708)

```
async fn reset_drops_previous_history()
```

**Purpose**: Verifies that a second reset replaces repository history with a new single-parentless baseline commit.

**Data flow**: Creates a baseline, changes a file, resets again, opens the repo with `gix`, inspects HEAD commit parents, and asserts the diff is clean.

**Call relations**: Confirms the destructive semantics of baseline reset.

*Call graph*: calls 2 internal fn (diff_since_latest_init, reset_git_repository); 6 external calls (new, assert!, assert_eq!, create_dir_all, write, open).


##### `tests::status_scan_does_not_write_added_file_blobs`  (lines 711–728)

```
async fn status_scan_does_not_write_added_file_blobs()
```

**Purpose**: Ensures current-file scanning computes blob IDs without storing new loose objects in the repository.

**Data flow**: Creates an empty baseline, writes a new file, runs `diff_since_latest_init`, computes the expected blob OID with `blob_oid`, opens the repo, and asserts `find_blob` for that OID fails.

**Call relations**: Targets the non-mutating design of `collect_current_entries` and `blob_oid`.

*Call graph*: calls 3 internal fn (blob_oid, diff_since_latest_init, reset_git_repository); 5 external calls (new, assert!, create_dir_all, write, open).


##### `tests::reports_executable_bit_changes_as_modified`  (lines 732–755)

```
async fn reports_executable_bit_changes_as_modified()
```

**Purpose**: Checks that changing only the executable bit is treated as a modification and rendered with mode headers.

**Data flow**: Creates a file, resets baseline, changes permissions to add execute bits, runs `diff_since_latest_init`, and asserts the structured change plus `old mode`/`new mode` lines in the diff.

**Call relations**: Exercises Unix-specific mode tracking through `file_mode` and `render_change_diff`.

*Call graph*: calls 2 internal fn (diff_since_latest_init, reset_git_repository); 7 external calls (new, assert!, assert_eq!, create_dir_all, metadata, set_permissions, write).


### `ollama/src/pull.rs`

`domain_logic` · `model pull progress rendering`

This file is the presentation layer for Ollama model downloads. `PullEvent` is the central enum, carrying either a human-readable `Status(String)`, per-layer byte progress in `ChunkProgress { digest, total, completed }`, terminal `Success`, or terminal `Error(String)`. The `PullProgressReporter` trait abstracts how those events are rendered.

`CliProgressReporter` maintains enough mutable state to produce compact inline progress output on stderr: whether a total-size header has already been printed, the previous rendered line length for whitespace padding, the previous aggregate completed-byte count, the timestamp of the last speed calculation, and a `HashMap<String, (u64, u64)>` keyed by digest to accumulate total/completed bytes per layer. On status events it suppresses the noisy `pulling manifest` message, otherwise rewrites the current line with carriage-return padding. On chunk-progress events it updates the per-digest map, folds all entries into aggregate totals, prints a one-time `Downloading model: total X.XX GB` header once total size is known, computes instantaneous MB/s from the delta since the last event, and rewrites the line with `done/total GB`, percentage, and speed. `Error` is intentionally ignored so callers can decide how to surface failures without duplicate output, while `Success` emits a trailing newline. `TuiProgressReporter` is currently just a newtype wrapper that forwards `on_event` to an inner `CliProgressReporter`, keeping TUI and CLI behavior identical until a dedicated UI integration exists.

#### Function details

##### `CliProgressReporter::default`  (lines 39–41)

```
fn default() -> Self
```

**Purpose**: Provides the `Default` implementation by delegating to `CliProgressReporter::new`. This keeps all initialization logic in one place.

**Data flow**: Takes no inputs and returns the freshly initialized reporter produced by `Self::new()`.

**Call relations**: It is standard trait glue for callers that prefer `Default`; the real state setup happens in `CliProgressReporter::new`.

*Call graph*: 1 external calls (new).


##### `CliProgressReporter::new`  (lines 45–53)

```
fn new() -> Self
```

**Purpose**: Constructs a reporter with clean rendering state and an empty per-digest progress map. It establishes the baseline timestamp used for later speed calculations.

**Data flow**: Creates and returns `CliProgressReporter { printed_header: false, last_line_len: 0, last_completed_sum: 0, last_instant: Instant::now(), totals_by_digest: HashMap::new() }`.

**Call relations**: This constructor is called by `ensure_oss_ready` before invoking `pull_with_reporter`. All subsequent `on_event` calls mutate the state initialized here.

*Call graph*: called by 1 (ensure_oss_ready); 2 external calls (new, now).


##### `CliProgressReporter::on_event`  (lines 57–135)

```
fn on_event(&mut self, event: &PullEvent) -> io::Result<()>
```

**Purpose**: Renders each `PullEvent` to stderr as compact inline CLI progress, including aggregate size and transfer speed across all layer digests. It also suppresses duplicate or noisy output in a few special cases.

**Data flow**: Takes `&mut self` and `event: &PullEvent`, opens `std::io::stderr()`, and matches on the event. For `Status(status)`, it ignores case-insensitive `"pulling manifest"`; otherwise it computes padding from `last_line_len`, writes `\r{status}` plus spaces, updates `last_line_len`, and flushes. For `ChunkProgress`, it updates `totals_by_digest` with any provided `total` or `completed`, folds the map into aggregate totals, and if `sum_total > 0` may print a one-time header, compute elapsed time since `last_instant`, derive MB/s from the completed-byte delta, update `last_completed_sum` and `last_instant`, format a `done/total GB (pct%) speed MB/s` line with padding, write it, and flush. For `Error(_)`, it returns `Ok(())` without output. For `Success`, it writes a newline and flushes.

**Call relations**: This method is invoked by `OllamaClient::pull_with_reporter` for every streamed pull event. It does not call back into the client; its role is purely to transform event/state updates into terminal output.

*Call graph*: 3 external calls (format!, stderr, now).


##### `TuiProgressReporter::on_event`  (lines 144–146)

```
fn on_event(&mut self, event: &PullEvent) -> io::Result<()>
```

**Purpose**: Temporarily reuses the CLI reporter implementation for TUI contexts by forwarding events unchanged. This keeps behavior aligned until a dedicated TUI renderer is added.

**Data flow**: Accepts `&mut self` and `event: &PullEvent`, forwards the call to `self.0.on_event(event)`, and returns the resulting `io::Result<()>`.

**Call relations**: Any caller using `TuiProgressReporter` enters the same rendering path as `CliProgressReporter`. The wrapper exists as an API placeholder rather than a distinct implementation.


### TUI status and summary surfaces
These files maintain the TUI's status-oriented projections, including footer and header state, goal and rate-limit summaries, branch metadata, and `/status` display models.

### `tui/src/chatwidget/status_surfaces.rs`

`orchestration` · `status refreshes during main loop and UI redraws`

This module is the presentation orchestrator for the two lightweight status surfaces outside the main transcript: the footer status line and the terminal title. It begins by parsing configured item ids into typed `StatusLineItem` and `TerminalTitleItem` selections, collecting unknown ids so warnings can be emitted once per widget instance. `StatusSurfaceSelections` exists to share that parsed snapshot across one refresh pass and to answer whether git branch or git summary data is needed at all.

The refresh path is centralized in `refresh_status_surfaces()` and `refresh_terminal_title()`. Both compute selections, warn once about invalid ids, synchronize shared cached state, and then render. Shared state synchronization is important: if branch/summary items are not selected, the corresponding caches and pending flags are cleared; if they are selected, cwd-keyed caches are synced and async lookups are spawned through `workspace_command_runner` only when needed. Project-root naming is also cached by cwd in `CachedProjectRootName` to avoid repeated filesystem walks during frequent title refreshes.

Rendering is item-driven. `status_line_value_for_item()` and `terminal_title_value_for_item()` map each enum variant to concrete strings drawn from model selection, reasoning effort, cwd/project root, git metadata, token usage, context percentages, rate-limit windows, permissions, approval mode, thread identity, task progress, and runtime status. Terminal-title rendering adds truncation by grapheme cluster, spinner/action-required animation, and OSC write deduplication via `last_terminal_title`. The helper functions at the bottom encode nuanced rate-limit window selection and human-readable permission/approval labels, while `parse_items_with_invalids()` preserves insertion order and deduplicates invalid ids for clean warnings.

#### Function details

##### `StatusSurfaceSelections::uses_git_branch`  (lines 54–59)

```
fn uses_git_branch(&self) -> bool
```

**Purpose**: Reports whether either configured surface needs git branch data. It checks both status-line and terminal-title selections for branch-dependent items.

**Data flow**: Reads `self.status_line_items` and `self.terminal_title_items` → tests membership for `StatusLineItem::GitBranch` and `TerminalTitleItem::GitBranch` → returns `true` if either surface requires branch lookup.

**Call relations**: Called during shared-state synchronization so `ChatWidget` can decide whether to preserve/request branch metadata or clear branch-related caches entirely.

*Call graph*: called by 1 (sync_status_surface_shared_state).


##### `StatusSurfaceSelections::uses_git_summary`  (lines 61–67)

```
fn uses_git_summary(&self) -> bool
```

**Purpose**: Reports whether the status line needs richer git summary data such as PR number or branch diff stats. Terminal-title items do not currently consume this summary directly.

**Data flow**: Reads `self.status_line_items` → checks for `StatusLineItem::PullRequestNumber` or `StatusLineItem::BranchChanges` → returns a boolean indicating whether git summary lookup is necessary.

**Call relations**: Used by shared-state synchronization to gate async git-summary requests and to reset summary caches when no configured item depends on them.

*Call graph*: called by 1 (sync_status_surface_shared_state).


##### `ChatWidget::status_surface_selections`  (lines 82–92)

```
fn status_surface_selections(&self) -> StatusSurfaceSelections
```

**Purpose**: Builds one parsed snapshot of both status-surface configurations. It packages valid typed items and invalid raw ids together so one refresh pass can reuse them consistently.

**Data flow**: Reads widget config through `status_line_items_with_invalids()` and `terminal_title_items_with_invalids()` → constructs `StatusSurfaceSelections` containing parsed item vectors plus invalid-id vectors → returns that snapshot.

**Call relations**: This is the common first step for full surface refreshes, title-only refreshes, and explicit git refresh requests, ensuring all those paths operate from the same parsing rules.

*Call graph*: calls 2 internal fn (status_line_items_with_invalids, terminal_title_items_with_invalids); called by 4 (refresh_status_surfaces, refresh_terminal_title, request_status_line_branch_refresh, request_status_line_git_summary_refresh).


##### `ChatWidget::warn_invalid_status_line_items_once`  (lines 94–113)

```
fn warn_invalid_status_line_items_once(&mut self, invalid_items: &[String])
```

**Purpose**: Emits a single warning message if the configured status-line item list contains unknown ids. It suppresses warnings before a thread exists and deduplicates repeated refreshes with an atomic flag.

**Data flow**: Reads `self.thread_id`, `invalid_items`, and `self.status_line_invalid_items_warned` → if a thread is visible, invalid ids are present, and `compare_exchange(false, true, ...)` succeeds, formats a singular/plural warning using `proper_join` and sends it via `self.on_warning` → otherwise does nothing.

**Call relations**: Invoked from the full status-surface refresh path after parsing config; it exists so invalid config is surfaced to the user once without spamming every redraw.

*Call graph*: called by 1 (refresh_status_surfaces); 1 external calls (format!).


##### `ChatWidget::warn_invalid_terminal_title_items_once`  (lines 115–134)

```
fn warn_invalid_terminal_title_items_once(&mut self, invalid_items: &[String])
```

**Purpose**: Emits a one-time warning for unknown terminal-title item ids. Its behavior mirrors the status-line warning path but uses a separate atomic guard and message text.

**Data flow**: Reads `self.thread_id`, `invalid_items`, and `self.terminal_title_invalid_items_warned` → on the first eligible occurrence, formats `Ignored invalid terminal title item(s): ...` and routes it through `self.on_warning` → otherwise leaves state unchanged.

**Call relations**: Called by both full-surface and title-only refreshes so title config problems are reported even when only the terminal title is being recomputed.

*Call graph*: called by 2 (refresh_status_surfaces, refresh_terminal_title); 1 external calls (format!).


##### `ChatWidget::sync_status_surface_shared_state`  (lines 136–160)

```
fn sync_status_surface_shared_state(&mut self, selections: &StatusSurfaceSelections)
```

**Purpose**: Synchronizes all cached inputs shared by the status line and terminal title before rendering. In practice this means cwd-keyed git branch and git summary state, including clearing stale caches when selections no longer need them.

**Data flow**: Consumes `selections`, reads current cwd via `status_line_cwd()` → if `uses_git_branch()` is false, clears branch value/pending/complete flags; otherwise syncs branch cache to cwd and requests async lookup if incomplete. Repeats the same pattern for git summary using `uses_git_summary()`, `sync_status_line_git_summary_state()`, and `request_status_line_git_summary()` → returns `()` after mutating widget cache fields.

**Call relations**: Runs before either surface is rendered in refresh entrypoints, so rendering sees coherent branch/summary state and background lookups are started only when selected items actually need them.

*Call graph*: calls 7 internal fn (request_status_line_branch, request_status_line_git_summary, status_line_cwd, sync_status_line_branch_state, sync_status_line_git_summary_state, uses_git_branch, uses_git_summary); called by 2 (refresh_status_surfaces, refresh_terminal_title).


##### `ChatWidget::refresh_status_line_from_selections`  (lines 162–188)

```
fn refresh_status_line_from_selections(&mut self, selections: &StatusSurfaceSelections)
```

**Purpose**: Renders the footer status line from a parsed selection snapshot and applies the resulting text and hyperlink to the bottom pane. Empty selections disable the status line entirely.

**Data flow**: Reads `selections.status_line_items` → toggles `bottom_pane` status-line enabled state; if no items are configured, clears status line text and hyperlink and returns. Otherwise iterates items, calling `status_line_value_for_item()` and collecting only available `(item, value)` segments, then formats them with `status_line_from_segments(..., self.config.tui_status_line_use_colors)` and stores the result via `set_status_line`. If PR number is among the configured items, computes a hyperlink URL from `status_line_pull_request_url()` and stores it with `set_status_line_hyperlink`.

**Call relations**: Called only from the full refresh path after shared state has been synchronized, so branch/PR-dependent items can render immediately if cached or disappear cleanly while async lookups are pending.

*Call graph*: calls 1 internal fn (status_line_value_for_item); called by 1 (refresh_status_surfaces); 2 external calls (new, status_line_from_segments).


##### `ChatWidget::clear_managed_terminal_title`  (lines 195–202)

```
fn clear_managed_terminal_title(&mut self) -> std::io::Result<()>
```

**Purpose**: Clears the terminal title only if this widget previously wrote one. It does not attempt to restore any preexisting shell title; it just removes the managed title and clears the cache on success.

**Data flow**: Reads `self.last_terminal_title` → if it is `Some`, calls `clear_terminal_title()?` and then sets `self.last_terminal_title = None` → returns `std::io::Result<()>` indicating OSC write success or failure.

**Call relations**: Used by terminal-title refresh when selections become empty, rendered content becomes invisible, or title generation returns `None`, centralizing the cache-clearing side effect.

*Call graph*: called by 1 (refresh_terminal_title_from_selections).


##### `ChatWidget::refresh_terminal_title_from_selections`  (lines 211–254)

```
fn refresh_terminal_title_from_selections(&mut self, selections: &StatusSurfaceSelections)
```

**Purpose**: Computes, writes, caches, and schedules animation for the terminal title for one parsed selection snapshot. It also tracks whether the last written title represented an action-required state.

**Data flow**: Reads `selections`, updates `self.last_terminal_title_requires_action` from `terminal_title_shows_action_required_with_selections()`, and if no title items are configured attempts to clear the managed title. Otherwise captures `now`, computes `title` with `terminal_title_text_for_selections()`, and computes an optional animation interval. If the newly rendered title equals `self.last_terminal_title`, it skips the OSC write and only schedules the next frame when animation is active. If the title changed, it calls `set_terminal_title`; on `Applied`, caches the new string; on `NoVisibleContent` or `None`, clears the managed title; on error, logs a debug message. Finally, if animation is active, schedules the next frame through `frame_requester`.

**Call relations**: This is the terminal-title rendering sink used by both full-surface and title-only refreshes. It delegates title text generation and animation policy to helper methods, then performs the actual side effects and deduplication.

*Call graph*: calls 4 internal fn (clear_managed_terminal_title, terminal_title_animation_interval_with_selections, terminal_title_shows_action_required_with_selections, terminal_title_text_for_selections); called by 2 (refresh_status_surfaces, refresh_terminal_title); 2 external calls (now, debug!).


##### `ChatWidget::refresh_status_surfaces`  (lines 262–269)

```
fn refresh_status_surfaces(&mut self)
```

**Purpose**: Recomputes both the footer status line and terminal title from one shared config snapshot. It is the main coordinated refresh entrypoint for status surfaces.

**Data flow**: Builds `selections` via `status_surface_selections()` → warns once for invalid status-line and terminal-title ids, syncs shared git/project state, renders the status line, then renders the terminal title → mutates warning flags, cache state, bottom-pane status line, terminal-title cache, and possibly schedules animation frames.

**Call relations**: Called by higher-level widget logic whenever both surfaces should be refreshed together, ensuring parsing and shared-state work happen once per pass.

*Call graph*: calls 6 internal fn (refresh_status_line_from_selections, refresh_terminal_title_from_selections, status_surface_selections, sync_status_surface_shared_state, warn_invalid_status_line_items_once, warn_invalid_terminal_title_items_once).


##### `ChatWidget::refresh_terminal_title`  (lines 272–277)

```
fn refresh_terminal_title(&mut self)
```

**Purpose**: Recomputes only the terminal title while still honoring shared config parsing and git-state synchronization. It avoids touching the footer status line.

**Data flow**: Builds `selections`, warns once for invalid terminal-title ids, syncs shared state, then calls `refresh_terminal_title_from_selections()` → mutates title-related cache and any shared git lookup state needed by title items.

**Call relations**: Used by code paths that only need title updates, such as animation or title-specific state changes, without rebuilding the footer status line.

*Call graph*: calls 4 internal fn (refresh_terminal_title_from_selections, status_surface_selections, sync_status_surface_shared_state, warn_invalid_terminal_title_items_once).


##### `ChatWidget::terminal_title_requires_action`  (lines 279–281)

```
fn terminal_title_requires_action(&self) -> bool
```

**Purpose**: Asks the bottom pane whether the terminal title should indicate blocked-on-user-input state. It is a thin adapter around bottom-pane state.

**Data flow**: Reads `self.bottom_pane.terminal_title_requires_action()` → returns that boolean unchanged.

**Call relations**: Serves as the low-level predicate for action-required title behavior, feeding both public visibility checks and selection-aware rendering helpers.

*Call graph*: called by 2 (terminal_title_shows_action_required, terminal_title_shows_action_required_with_selections).


##### `ChatWidget::terminal_title_shows_action_required`  (lines 283–285)

```
fn terminal_title_shows_action_required(&self) -> bool
```

**Purpose**: Determines whether the title should currently display the action-required treatment under the widget’s configured title items. It requires both a blocked state and an activity/spinner item being in use.

**Data flow**: Reads `terminal_title_requires_action()` and `terminal_title_uses_activity()` → returns `true` only when both conditions hold.

**Call relations**: Used by animation-policy helpers and active-progress checks to suppress the normal spinner while the title is blinking an action-required prefix.

*Call graph*: calls 2 internal fn (terminal_title_requires_action, terminal_title_uses_activity); called by 2 (should_animate_terminal_title_action_required, terminal_title_has_active_progress).


##### `ChatWidget::terminal_title_text_for_selections`  (lines 287–312)

```
fn terminal_title_text_for_selections(
        &mut self,
        selections: &StatusSurfaceSelections,
        now: Instant,
    ) -> Option<String>
```

**Purpose**: Builds the final terminal-title string for a specific selection snapshot and instant. It either delegates to the special action-required formatter or concatenates ordinary item values in configured order.

**Data flow**: Consumes `selections` and `now` → if `terminal_title_shows_action_required_with_selections(selections)` is true, returns `Some(action_required_terminal_title_text(...))`. Otherwise iterates configured `terminal_title_items`, calls `terminal_title_value_for_item(item, now)`, skips `None` segments, inserts each item’s separator relative to the previous item, and folds them into one `String` → returns `Some(title)` if non-empty, else `None`.

**Call relations**: Called by terminal-title refresh right before OSC emission; it is the pure-ish rendering step that turns current widget state into a title string.

*Call graph*: calls 2 internal fn (action_required_terminal_title_text, terminal_title_shows_action_required_with_selections); called by 1 (refresh_terminal_title_from_selections); 1 external calls (new).


##### `ChatWidget::action_required_terminal_title_text`  (lines 314–325)

```
fn action_required_terminal_title_text(
        &mut self,
        selections: &StatusSurfaceSelections,
        now: Instant,
    ) -> String
```

**Purpose**: Builds the special terminal title shown when the agent is waiting on user action. It prepends a blinking or steady action-required prefix and excludes the ordinary status item from the remainder.

**Data flow**: Consumes `selections` and `now`, computes a prefix via `action_required_terminal_title_prefix_at(now)` → passes the prefix, configured title items, an exclusion slice containing `TerminalTitleItem::Status`, and a closure over `terminal_title_value_for_item` into `build_action_required_title_text` → returns the resulting `String`.

**Call relations**: Reached only from `terminal_title_text_for_selections` when action-required mode is active, encapsulating the alternate title composition policy.

*Call graph*: calls 1 internal fn (action_required_terminal_title_prefix_at); called by 1 (terminal_title_text_for_selections); 1 external calls (build_action_required_title_text).


##### `ChatWidget::action_required_terminal_title_prefix_at`  (lines 327–339)

```
fn action_required_terminal_title_prefix_at(&self, now: Instant) -> &'static str
```

**Purpose**: Chooses the visible or hidden action-required prefix for the current blink phase. When animations are disabled it always returns the visible prefix.

**Data flow**: Reads `self.config.animations` and `self.terminal_title_animation_origin`, computes elapsed time with `saturating_duration_since(now)`, divides by `TERMINAL_TITLE_ACTION_REQUIRED_INTERVAL`, and alternates between `TERMINAL_TITLE_ACTION_REQUIRED_PREFIX` and `_HIDDEN` on even/odd phases → returns a `&'static str`.

**Call relations**: Used only by the action-required title formatter to implement the one-second blink cadence without duplicating timing logic.

*Call graph*: called by 1 (action_required_terminal_title_text); 1 external calls (saturating_duration_since).


##### `ChatWidget::terminal_title_shows_action_required_with_selections`  (lines 341–349)

```
fn terminal_title_shows_action_required_with_selections(
        &self,
        selections: &StatusSurfaceSelections,
    ) -> bool
```

**Purpose**: Determines whether action-required rendering should be used for a specific parsed title selection set. Unlike the config-based helper, it checks directly for the parsed spinner item.

**Data flow**: Reads `terminal_title_requires_action()` and `selections.terminal_title_items.contains(&TerminalTitleItem::Spinner)` → returns `true` only when the widget is blocked and the parsed title selection includes spinner/activity.

**Call relations**: Used during title rendering and animation scheduling so one refresh pass can make decisions from the already-parsed selection snapshot.

*Call graph*: calls 1 internal fn (terminal_title_requires_action); called by 3 (refresh_terminal_title_from_selections, terminal_title_animation_interval_with_selections, terminal_title_text_for_selections).


##### `ChatWidget::terminal_title_animation_interval_with_selections`  (lines 351–363)

```
fn terminal_title_animation_interval_with_selections(
        &self,
        selections: &StatusSurfaceSelections,
    ) -> Option<Duration>
```

**Purpose**: Computes the next animation interval for the current title snapshot. Action-required blinking takes precedence over spinner animation.

**Data flow**: Reads `self.config.animations` and `selections` → if animations are enabled and action-required rendering applies, returns `Some(TERMINAL_TITLE_ACTION_REQUIRED_INTERVAL)`; otherwise, if `should_animate_terminal_title_spinner_with_selections(selections)` is true, returns `Some(TERMINAL_TITLE_SPINNER_INTERVAL)`; else returns `None`.

**Call relations**: Called by terminal-title refresh to decide whether to schedule another frame and at what cadence after the current title is rendered or deduplicated.

*Call graph*: calls 2 internal fn (should_animate_terminal_title_spinner_with_selections, terminal_title_shows_action_required_with_selections); called by 1 (refresh_terminal_title_from_selections).


##### `ChatWidget::request_status_line_branch_refresh`  (lines 365–373)

```
fn request_status_line_branch_refresh(&mut self)
```

**Purpose**: Forces a fresh branch lookup if the current status-surface configuration still uses branch data. It first re-syncs cwd-keyed branch cache state.

**Data flow**: Builds `selections`, checks `uses_git_branch()`, and returns early if branch data is unused. Otherwise reads the current cwd, calls `sync_status_line_branch_state(&cwd)`, then starts a lookup with `request_status_line_branch(cwd)` → mutates branch cache/pending flags.

**Call relations**: Used by external events that know branch information may have changed and want to refresh only when branch-dependent items are actually configured.

*Call graph*: calls 4 internal fn (request_status_line_branch, status_line_cwd, status_surface_selections, sync_status_line_branch_state).


##### `ChatWidget::request_status_line_git_summary_refresh`  (lines 375–383)

```
fn request_status_line_git_summary_refresh(&mut self)
```

**Purpose**: Forces a fresh git-summary lookup if the current status-line configuration still uses PR or branch-change data. It mirrors the branch-refresh path for summary state.

**Data flow**: Builds `selections`, checks `uses_git_summary()`, and returns if summary data is unused. Otherwise reads cwd, syncs summary cache state with `sync_status_line_git_summary_state(&cwd)`, then starts a lookup with `request_status_line_git_summary(cwd)` → mutates summary cache/pending flags.

**Call relations**: Called by external git-related events when PR/change stats may be stale, but only performs work if configured items depend on that summary.

*Call graph*: calls 4 internal fn (request_status_line_git_summary, status_line_cwd, status_surface_selections, sync_status_line_git_summary_state).


##### `ChatWidget::status_line_items_with_invalids`  (lines 388–390)

```
fn status_line_items_with_invalids(&self) -> (Vec<StatusLineItem>, Vec<String>)
```

**Purpose**: Parses configured status-line item ids into typed `StatusLineItem` values while collecting unknown ids for warnings. Invalid ids are deduplicated in insertion order.

**Data flow**: Reads raw ids from `configured_status_line_items()` → passes them to `parse_items_with_invalids` → returns `(Vec<StatusLineItem>, Vec<String>)` containing valid parsed items and quoted invalid ids.

**Call relations**: Used only when building the shared selection snapshot, so parsing and invalid-id collection happen once per refresh pass.

*Call graph*: calls 2 internal fn (configured_status_line_items, parse_items_with_invalids); called by 1 (status_surface_selections).


##### `ChatWidget::configured_status_line_items`  (lines 392–399)

```
fn configured_status_line_items(&self) -> Vec<String>
```

**Purpose**: Returns the raw configured status-line item ids, falling back to the built-in default ordering when the config field is unset.

**Data flow**: Reads `self.config.tui_status_line` → if `Some`, clones and returns it; otherwise maps `DEFAULT_STATUS_LINE_ITEMS` to owned `String`s and returns that vector.

**Call relations**: Feeds status-line parsing; separating this from parsing keeps default selection policy distinct from validation.

*Call graph*: called by 1 (status_line_items_with_invalids).


##### `ChatWidget::terminal_title_items_with_invalids`  (lines 404–406)

```
fn terminal_title_items_with_invalids(&self) -> (Vec<TerminalTitleItem>, Vec<String>)
```

**Purpose**: Parses configured terminal-title item ids into typed `TerminalTitleItem` values while collecting unknown ids. It mirrors the status-line parsing helper.

**Data flow**: Reads raw ids from `configured_terminal_title_items()` → passes them to `parse_items_with_invalids` → returns `(Vec<TerminalTitleItem>, Vec<String>)` with valid items and deduplicated invalid ids.

**Call relations**: Used when constructing the shared selection snapshot consumed by title refresh and shared-state synchronization.

*Call graph*: calls 2 internal fn (configured_terminal_title_items, parse_items_with_invalids); called by 1 (status_surface_selections).


##### `ChatWidget::configured_terminal_title_items`  (lines 409–416)

```
fn configured_terminal_title_items(&self) -> Vec<String>
```

**Purpose**: Returns the raw configured terminal-title item ids, or the minimal default ordering when the user has not configured one.

**Data flow**: Reads `self.config.tui_terminal_title` → if present, clones and returns it; otherwise converts `DEFAULT_TERMINAL_TITLE_ITEMS` into a `Vec<String>` and returns that.

**Call relations**: Supplies the raw ids that terminal-title parsing validates and converts into typed items.

*Call graph*: called by 1 (terminal_title_items_with_invalids).


##### `ChatWidget::status_line_cwd`  (lines 418–422)

```
fn status_line_cwd(&self) -> &Path
```

**Purpose**: Chooses the cwd that status surfaces should render against. It prefers the widget’s current cwd override and falls back to the configured cwd.

**Data flow**: Reads `self.current_cwd` and `self.config.cwd` → returns `self.current_cwd.as_deref().unwrap_or(self.config.cwd.as_path())` as `&Path`.

**Call relations**: This is the common cwd source for project-root naming, git lookups, and cwd-based status/title items, keeping all those surfaces aligned.

*Call graph*: called by 6 (request_status_line_branch_refresh, request_status_line_git_summary_refresh, status_line_project_root_name, status_line_value_for_item, sync_status_surface_shared_state, terminal_title_value_for_item).


##### `ChatWidget::status_line_project_root_for_cwd`  (lines 429–447)

```
fn status_line_project_root_for_cwd(&self, cwd: &Path) -> Option<PathBuf>
```

**Purpose**: Finds the project root associated with a cwd for display purposes. It prefers the git repository root and otherwise falls back to the nearest project config layer.

**Data flow**: Consumes `cwd: &Path` → first calls `get_git_repo_root(cwd)` and returns that if present. If not, iterates `self.config.config_layer_stack.get_layers(...)`, finds the first `ConfigLayerSource::Project`, and returns the parent directory of its `.codex` folder if available → returns `Option<PathBuf>`.

**Call relations**: Used only by project-root naming logic so both status line and terminal title can show a stable project label even outside git repos.

*Call graph*: called by 1 (status_line_project_root_name_for_cwd).


##### `ChatWidget::status_line_project_root_name_for_cwd`  (lines 449–455)

```
fn status_line_project_root_name_for_cwd(&self, cwd: &Path) -> Option<String>
```

**Purpose**: Converts a resolved project root path into a display name. It prefers the final path component and falls back to a formatted directory string when no file name exists.

**Data flow**: Consumes `cwd`, calls `status_line_project_root_for_cwd(cwd)` → maps the resulting root path to either `root.file_name().to_string_lossy()` or `format_directory_display(&root, None)` → returns `Option<String>`.

**Call relations**: This is the uncached naming helper used by the cwd-keyed project-root-name cache.

*Call graph*: calls 1 internal fn (status_line_project_root_for_cwd); called by 1 (status_line_project_root_name).


##### `ChatWidget::status_line_project_root_name`  (lines 458–472)

```
fn status_line_project_root_name(&mut self) -> Option<String>
```

**Purpose**: Returns the cached project-root display name for the active cwd, recomputing it only when the cwd changes. This avoids repeated filesystem/config traversal during frequent title refreshes.

**Data flow**: Reads current cwd via `status_line_cwd().to_path_buf()` and compares it to `self.status_line_project_root_name_cache.cwd` if present → on cache hit, clones and returns the cached `root_name`; on miss, computes a new name with `status_line_project_root_name_for_cwd(&cwd)`, stores `CachedProjectRootName { cwd, root_name: clone }` in `self.status_line_project_root_name_cache`, and returns the computed `Option<String>`.

**Call relations**: Used by both status-line and terminal-title project items, centralizing the cache so both surfaces share one lookup result.

*Call graph*: calls 2 internal fn (status_line_cwd, status_line_project_root_name_for_cwd); called by 2 (status_line_value_for_item, terminal_title_project_name).


##### `ChatWidget::terminal_title_project_name`  (lines 478–490)

```
fn terminal_title_project_name(&mut self) -> Option<String>
```

**Purpose**: Produces the terminal-title project segment. It prefers the cached project-root name and falls back to the current directory name, then truncates the result for title compactness.

**Data flow**: Reads `status_line_project_root_name()`; if that is `None`, derives a name from `status_line_cwd().file_name()` or `format_directory_display(cwd, None)` → truncates the chosen string with `truncate_terminal_title_part(..., 24)` → returns `Some(String)` unless no cwd-derived name can be formed.

**Call relations**: Used by terminal-title rendering and preview generation whenever the configured title includes the project name.

*Call graph*: calls 1 internal fn (status_line_project_root_name); called by 2 (status_surface_preview_value_for_item, terminal_title_value_for_item); 1 external calls (truncate_terminal_title_part).


##### `ChatWidget::sync_status_line_branch_state`  (lines 496–508)

```
fn sync_status_line_branch_state(&mut self, cwd: &Path)
```

**Purpose**: Resets branch cache state when the cwd used for branch lookup changes. This prevents stale branch names from leaking across directory changes.

**Data flow**: Consumes `cwd: &Path`, compares it to `self.status_line_branch_cwd` → if unchanged, returns immediately; otherwise stores `cwd.to_path_buf()` in `status_line_branch_cwd`, clears `status_line_branch`, and resets `status_line_branch_pending` and `status_line_branch_lookup_complete` to `false`.

**Call relations**: Called before branch requests from both shared-state sync and explicit branch refresh, ensuring async completions are interpreted against the correct cwd.

*Call graph*: called by 2 (request_status_line_branch_refresh, sync_status_surface_shared_state); 1 external calls (to_path_buf).


##### `ChatWidget::sync_status_line_git_summary_state`  (lines 510–518)

```
fn sync_status_line_git_summary_state(&mut self, cwd: &Path)
```

**Purpose**: Resets git-summary cache state when the cwd changes. It mirrors branch-state synchronization for PR/change-stat lookups.

**Data flow**: Consumes `cwd: &Path`, compares it to `self.status_line_git_summary_cwd` → if unchanged, returns; otherwise stores the new cwd and clears `status_line_git_summary`, `status_line_git_summary_pending`, and `status_line_git_summary_lookup_complete`.

**Call relations**: Used before summary requests so PR/change data remains keyed to the active cwd and stale completions can be rejected elsewhere.

*Call graph*: called by 2 (request_status_line_git_summary_refresh, sync_status_surface_shared_state); 1 external calls (to_path_buf).


##### `ChatWidget::request_status_line_branch`  (lines 524–538)

```
fn request_status_line_branch(&mut self, cwd: PathBuf)
```

**Purpose**: Starts an asynchronous branch-name lookup unless one is already pending. If no workspace command runner exists, it marks lookup complete so the UI stops waiting.

**Data flow**: Consumes `cwd: PathBuf`, reads `self.status_line_branch_pending` and `self.workspace_command_runner` → if already pending, returns; if no runner, sets `status_line_branch_lookup_complete = true` and returns. Otherwise sets `status_line_branch_pending = true`, clones `app_event_tx`, and spawns a task that awaits `branch_summary::current_branch_name(runner.as_ref(), &cwd)` and sends `AppEvent::StatusLineBranchUpdated { cwd, branch }`.

**Call relations**: Triggered by shared-state sync and explicit branch refresh. It delegates the expensive git call to a background task and reports completion back through the app event channel.

*Call graph*: calls 1 internal fn (current_branch_name); called by 2 (request_status_line_branch_refresh, sync_status_surface_shared_state); 1 external calls (spawn).


##### `ChatWidget::request_status_line_git_summary`  (lines 540–554)

```
fn request_status_line_git_summary(&mut self, cwd: PathBuf)
```

**Purpose**: Starts an asynchronous git-summary lookup unless one is already pending. Without a command runner it marks the lookup complete immediately.

**Data flow**: Consumes `cwd: PathBuf`, checks `self.status_line_git_summary_pending` and `self.workspace_command_runner` → if pending, returns; if no runner, sets `status_line_git_summary_lookup_complete = true` and returns. Otherwise sets `status_line_git_summary_pending = true`, clones `app_event_tx`, and spawns a task that awaits `branch_summary::status_line_git_summary(runner.as_ref(), &cwd)` and sends `AppEvent::StatusLineGitSummaryUpdated { cwd, summary }`.

**Call relations**: Started from shared-state sync and explicit summary refresh when PR/change-stat items are configured and cached data is missing.

*Call graph*: calls 1 internal fn (status_line_git_summary); called by 2 (request_status_line_git_summary_refresh, sync_status_surface_shared_state); 1 external calls (spawn).


##### `ChatWidget::status_line_value_for_item`  (lines 561–658)

```
fn status_line_value_for_item(&mut self, item: StatusLineItem) -> Option<String>
```

**Purpose**: Resolves one `StatusLineItem` into the exact string shown in the footer, or `None` when that item should be omitted for now. It is the main formatting switch for status-line content.

**Data flow**: Consumes `item`, reads a wide range of widget state (`model_display_name`, reasoning effort, cwd/project root, cached git branch and summary, `status_state`, permissions config, token usage, context percentages, rate-limit snapshots, thread metadata, service tier, raw-output mode, transcript plan progress) → matches on the enum and formats concrete strings such as `PR #123`, `+10 -2`, `Ready`, `Read Only`, `Ask for approval`, `12k used`, `Context 40% left`, limit labels, version strings, `Fast on/off`, thread title fallback, or `Tasks X/Y` → returns `Option<String>` and does not itself mutate state.

**Call relations**: Called while rendering the status line, generating previews, and deriving many terminal-title segments. It is intentionally tolerant of unavailable data so callers can skip missing segments without treating them as config errors.

*Call graph*: calls 8 internal fn (model_with_reasoning_display_name, reasoning_display_name, run_state_status_text, status_line_cwd, status_line_project_root_name, terminal_title_task_progress, approval_mode_display, permissions_display); called by 3 (refresh_status_line_from_selections, status_surface_preview_value_for_item, terminal_title_value_for_item); 2 external calls (limit_label_for_window, format!).


##### `ChatWidget::status_line_pull_request_url`  (lines 660–665)

```
fn status_line_pull_request_url(&self) -> Option<String>
```

**Purpose**: Extracts the pull-request URL from cached git summary data for hyperlinking the status line. It returns nothing when no PR summary is available.

**Data flow**: Reads `self.status_line_git_summary`, drills into `summary.pull_request.url`, clones the URL string, and returns it as `Option<String>`.

**Call relations**: Used only by status-line refresh when the configured items include `PullRequestNumber`, allowing the rendered footer segment to carry a clickable hyperlink.


##### `ChatWidget::status_surface_preview_value_for_item`  (lines 667–701)

```
fn status_surface_preview_value_for_item(
        &mut self,
        item: StatusSurfacePreviewItem,
    ) -> Option<String>
```

**Purpose**: Produces preview text for settings UIs that let users choose status-surface items. It maps preview-only item enums onto either direct literals or the same formatting logic used by live surfaces.

**Data flow**: Consumes `StatusSurfacePreviewItem`, matches it to either an immediate preview string (`codex`, current status text, project name, task progress) or a corresponding `StatusLineItem`, then delegates to `status_line_value_for_item` when appropriate → returns `Option<String>`.

**Call relations**: Used by preview-oriented UI flows rather than live rendering, but intentionally reuses the same formatting helpers so previews match actual surface output.

*Call graph*: calls 4 internal fn (run_state_status_text, status_line_value_for_item, terminal_title_project_name, terminal_title_task_progress).


##### `ChatWidget::terminal_title_value_for_item`  (lines 706–770)

```
fn terminal_title_value_for_item(
        &mut self,
        item: TerminalTitleItem,
        now: Instant,
    ) -> Option<String>
```

**Purpose**: Resolves one `TerminalTitleItem` into a compact title segment, truncating long values and omitting unavailable ones. It is the title-side counterpart to `status_line_value_for_item`.

**Data flow**: Consumes `item` and `now`, reads widget state including cwd/project name, spinner state, run-state text, thread title, cached branch, status-line-derived values, model/reasoning labels, and task progress → matches on the enum and returns strings such as `codex`, truncated project/cwd/thread/branch labels, spinner frame text, `Ready/Working/Thinking`, compact context/limit/token/version labels, model labels, or `Tasks X/Y` → returns `Option<String>` without mutating state.

**Call relations**: Called by terminal-title text generation and action-required title building. Many branches intentionally delegate to `status_line_value_for_item` so both surfaces share wording.

*Call graph*: calls 8 internal fn (model_with_reasoning_display_name, reasoning_display_name, run_state_status_text, status_line_cwd, status_line_value_for_item, terminal_title_project_name, terminal_title_spinner_text_at, terminal_title_task_progress); 1 external calls (truncate_terminal_title_part).


##### `ChatWidget::reasoning_display_name`  (lines 772–775)

```
fn reasoning_display_name(&self) -> String
```

**Purpose**: Formats the current reasoning-effort setting into the compact label used by status surfaces. It hides the underlying config representation behind a display helper.

**Data flow**: Reads `self.effective_reasoning_effort()`, passes the optional effort to `Self::status_line_reasoning_effort_label`, and returns the resulting `String`.

**Call relations**: Used by both status-line and terminal-title item formatting, and by the combined model-plus-reasoning label builder.

*Call graph*: called by 3 (model_with_reasoning_display_name, status_line_value_for_item, terminal_title_value_for_item); 1 external calls (status_line_reasoning_effort_label).


##### `ChatWidget::model_with_reasoning_display_name`  (lines 777–791)

```
fn model_with_reasoning_display_name(&self) -> String
```

**Purpose**: Builds a combined model label that includes reasoning effort and, when applicable, the human-readable service-tier name. This is the richer model label used by some status items.

**Data flow**: Reads `self.model_display_name()`, `reasoning_display_name()`, current service tier, available service-tier commands, and `self.has_chatgpt_account` → resolves an optional tier display name, prefixes it with a space when present, and formats `"<model> <reasoning><tier>"` → returns the combined `String`.

**Call relations**: Called by both status-line and terminal-title item formatting when the configured item requests the richer model label.

*Call graph*: calls 1 internal fn (reasoning_display_name); called by 2 (status_line_value_for_item, terminal_title_value_for_item); 1 external calls (format!).


##### `ChatWidget::run_state_status_text`  (lines 797–818)

```
fn run_state_status_text(&self) -> String
```

**Purpose**: Computes the compact word-based runtime status label shared by status-line and terminal-title `status` items. Startup overrides normal task states, and idle always renders as `Ready`.

**Data flow**: Reads `self.mcp_startup_status`, `self.status_state.terminal_title_status_kind`, and `self.bottom_pane.is_task_running()` → if startup is active returns `Starting`; otherwise maps each title-status bucket to `Ready` when no task is running, or to `Working`, `Waiting`, or `Thinking` while active → returns a `String`.

**Call relations**: Used by both surface formatters and preview generation so all word-based status displays stay consistent with the widget’s runtime state bucket.

*Call graph*: called by 3 (status_line_value_for_item, status_surface_preview_value_for_item, terminal_title_value_for_item).


##### `ChatWidget::terminal_title_spinner_text_at`  (lines 820–830)

```
fn terminal_title_spinner_text_at(&self, now: Instant) -> Option<String>
```

**Purpose**: Returns the current spinner frame for the terminal title when animations are enabled and there is active progress to show. Otherwise it suppresses the spinner entirely.

**Data flow**: Reads `self.config.animations` and `terminal_title_has_active_progress()` → if either condition fails, returns `None`; otherwise calls `terminal_title_spinner_frame_at(now)` and wraps the frame in `Some(String)`.

**Call relations**: Used by terminal-title item formatting for the spinner/activity segment, and indirectly drives whether title animation frames need to be scheduled.

*Call graph*: calls 2 internal fn (terminal_title_has_active_progress, terminal_title_spinner_frame_at); called by 1 (terminal_title_value_for_item).


##### `ChatWidget::terminal_title_spinner_frame_at`  (lines 832–837)

```
fn terminal_title_spinner_frame_at(&self, now: Instant) -> &'static str
```

**Purpose**: Computes the exact spinner frame string for a given instant based on the animation origin and fixed frame interval. It cycles through the braille spinner array.

**Data flow**: Consumes `now`, reads `self.terminal_title_animation_origin`, computes elapsed time with `saturating_duration_since`, divides by `TERMINAL_TITLE_SPINNER_INTERVAL`, and indexes `TERMINAL_TITLE_SPINNER_FRAMES` modulo its length → returns a `&'static str` frame.

**Call relations**: Called only by `terminal_title_spinner_text_at` to separate frame-index math from the higher-level visibility checks.

*Call graph*: called by 1 (terminal_title_spinner_text_at); 1 external calls (saturating_duration_since).


##### `ChatWidget::terminal_title_uses_activity`  (lines 839–845)

```
fn terminal_title_uses_activity(&self) -> bool
```

**Purpose**: Determines whether the configured terminal-title item list includes the activity/spinner concept. The default configuration counts as using activity.

**Data flow**: Reads `self.config.tui_terminal_title` → if unset, returns `true`; if set, scans the raw item ids for either `"activity"` or `"spinner"` → returns a boolean.

**Call relations**: Used by action-required and spinner-animation policy so those behaviors only activate when the title configuration actually includes an activity indicator.

*Call graph*: called by 2 (should_animate_terminal_title_spinner, terminal_title_shows_action_required).


##### `ChatWidget::terminal_title_has_active_progress`  (lines 847–853)

```
fn terminal_title_has_active_progress(&self) -> bool
```

**Purpose**: Determines whether the title should show active progress animation. Action-required state suppresses normal progress animation even if a task is running.

**Data flow**: Calls `terminal_title_shows_action_required()`; if true, returns `false`. Otherwise reads `self.mcp_startup_status.is_some()` and `self.bottom_pane.is_task_running()` → returns `true` when startup or a running task indicates active progress.

**Call relations**: Used by spinner visibility and animation-policy helpers to decide whether the title should animate as active work.

*Call graph*: calls 1 internal fn (terminal_title_shows_action_required); called by 3 (should_animate_terminal_title_spinner, should_animate_terminal_title_spinner_with_selections, terminal_title_spinner_text_at).


##### `ChatWidget::should_animate_terminal_title_spinner`  (lines 855–859)

```
fn should_animate_terminal_title_spinner(&self) -> bool
```

**Purpose**: Reports whether the terminal title spinner should currently animate under the widget’s configured title items. It combines animation enablement, activity-item presence, and active-progress state.

**Data flow**: Reads `self.config.animations`, `terminal_title_uses_activity()`, and `terminal_title_has_active_progress()` → returns `true` only when all three conditions hold.

**Call relations**: This is a public-ish helper for other widget code that needs to know whether spinner animation should be running outside the parsed-selection refresh path.

*Call graph*: calls 2 internal fn (terminal_title_has_active_progress, terminal_title_uses_activity).


##### `ChatWidget::should_animate_terminal_title_action_required`  (lines 861–863)

```
fn should_animate_terminal_title_action_required(&self) -> bool
```

**Purpose**: Reports whether the action-required title blink should animate right now. It is simply the conjunction of animation enablement and action-required visibility.

**Data flow**: Reads `self.config.animations` and `terminal_title_shows_action_required()` → returns the resulting boolean.

**Call relations**: Used by external code that needs a quick answer about whether the title is in blinking action-required mode.

*Call graph*: calls 1 internal fn (terminal_title_shows_action_required).


##### `ChatWidget::should_animate_terminal_title_spinner_with_selections`  (lines 865–874)

```
fn should_animate_terminal_title_spinner_with_selections(
        &self,
        selections: &StatusSurfaceSelections,
    ) -> bool
```

**Purpose**: Selection-aware version of spinner-animation eligibility. It checks the parsed title items directly instead of reparsing raw config.

**Data flow**: Reads `self.config.animations`, `selections.terminal_title_items.contains(&TerminalTitleItem::Spinner)`, and `terminal_title_has_active_progress()` → returns `true` only when the parsed selection includes spinner and active progress exists.

**Call relations**: Used by `terminal_title_animation_interval_with_selections` during one refresh pass so animation scheduling can rely on the already-parsed snapshot.

*Call graph*: calls 1 internal fn (terminal_title_has_active_progress); called by 1 (terminal_title_animation_interval_with_selections).


##### `ChatWidget::terminal_title_task_progress`  (lines 877–883)

```
fn terminal_title_task_progress(&self) -> Option<String>
```

**Purpose**: Formats the latest `update_plan` progress snapshot for display as `Tasks completed/total`. It suppresses output when there is no snapshot or the total is zero.

**Data flow**: Reads `self.transcript.last_plan_progress` → if absent, returns `None`; if present and `total == 0`, also returns `None`; otherwise formats `Tasks {completed}/{total}` and returns `Some(String)`.

**Call relations**: Used by both status-line and terminal-title item formatting, plus preview generation, to expose plan progress consistently.

*Call graph*: called by 3 (status_line_value_for_item, status_surface_preview_value_for_item, terminal_title_value_for_item); 1 external calls (format!).


##### `ChatWidget::truncate_terminal_title_part`  (lines 886–900)

```
fn truncate_terminal_title_part(value: String, max_chars: usize) -> String
```

**Purpose**: Truncates a terminal-title segment by grapheme cluster rather than byte or scalar count, appending `...` when truncation occurs and there is room. This avoids breaking multi-codepoint user-visible characters.

**Data flow**: Consumes `value: String` and `max_chars: usize` → if `max_chars == 0`, returns an empty string. Otherwise iterates graphemes, collects the first `max_chars` into `head`, and if more graphemes remain and `max_chars > 3`, rebuilds a shorter prefix of length `max_chars - 3` and appends `...`; else returns `head` unchanged.

**Call relations**: Used throughout terminal-title item formatting to keep segments compact without corrupting Unicode grapheme boundaries.

*Call graph*: 1 external calls (new).


##### `five_hour_status_window`  (lines 903–910)

```
fn five_hour_status_window(
    snapshot: &RateLimitSnapshotDisplay,
) -> Option<(&RateLimitWindowDisplay, bool)>
```

**Purpose**: Chooses the most appropriate rate-limit window to display as the five-hour status item from a `RateLimitSnapshotDisplay`. It applies a fallback chain that prefers explicit `5h` windows but can fall back to other non-weekly windows.

**Data flow**: Consumes `snapshot` → tries `find_primary_codex_window(snapshot, "5h")`, then `secondary_window_with_label_when_weekly_is_available(snapshot, "5h")`, then `non_weekly_primary_window(snapshot)`, then `non_weekly_secondary_window_when_primary_is_weekly(snapshot)` → returns the first matching `Option<(&RateLimitWindowDisplay, bool)>` where the boolean marks secondary windows.

**Call relations**: Used by status-line item formatting for `FiveHourLimit` so the UI can show a sensible codex limit window even when snapshots vary in labeling/layout.

*Call graph*: calls 1 internal fn (find_primary_codex_window).


##### `weekly_status_window`  (lines 912–917)

```
fn weekly_status_window(
    snapshot: &RateLimitSnapshotDisplay,
) -> Option<(&RateLimitWindowDisplay, bool)>
```

**Purpose**: Chooses the weekly rate-limit window to display from a snapshot. It prefers an explicitly labeled weekly window and otherwise falls back to the secondary window if present.

**Data flow**: Consumes `snapshot` → first tries `find_codex_window(snapshot, "weekly")`; if that fails, maps `snapshot.secondary` to `(window, true)` → returns `Option<(&RateLimitWindowDisplay, bool)>`.

**Call relations**: Used by status-line item formatting for `WeeklyLimit` to normalize differing snapshot shapes into one display choice.

*Call graph*: calls 1 internal fn (find_codex_window).


##### `find_codex_window`  (lines 919–936)

```
fn find_codex_window(
    snapshot: &'a RateLimitSnapshotDisplay,
    label: &str,
) -> Option<(&'a RateLimitWindowDisplay, bool)>
```

**Purpose**: Searches both primary and secondary rate-limit windows for one whose duration label matches a target string. It reports whether the match came from the secondary slot.

**Data flow**: Consumes `snapshot` and `label` → checks `snapshot.primary` with `matches_window_label`, returning `(primary, false)` on match; otherwise checks `snapshot.secondary`, returning `(secondary, true)` on match; otherwise returns `None`.

**Call relations**: Shared helper used by weekly-window selection and by the five-hour fallback that depends on weekly-window presence.

*Call graph*: calls 1 internal fn (matches_window_label); called by 2 (secondary_window_with_label_when_weekly_is_available, weekly_status_window).


##### `find_primary_codex_window`  (lines 938–948)

```
fn find_primary_codex_window(
    snapshot: &'a RateLimitSnapshotDisplay,
    label: &str,
) -> Option<(&'a RateLimitWindowDisplay, bool)>
```

**Purpose**: Returns the primary rate-limit window only if its duration label matches the requested label. It does not inspect the secondary slot.

**Data flow**: Consumes `snapshot` and `label`, reads `snapshot.primary.as_ref()?`, checks it with `matches_window_label`, and returns `Some((primary, false))` on match or `None` otherwise.

**Call relations**: Used as the first-choice branch in five-hour window selection, expressing the preference for a primary explicit `5h` window.

*Call graph*: calls 1 internal fn (matches_window_label); called by 1 (five_hour_status_window).


##### `secondary_window_with_label_when_weekly_is_available`  (lines 950–962)

```
fn secondary_window_with_label_when_weekly_is_available(
    snapshot: &'a RateLimitSnapshotDisplay,
    label: &str,
) -> Option<(&'a RateLimitWindowDisplay, bool)>
```

**Purpose**: Returns the secondary window when it matches a target label, but only if the snapshot also contains a weekly window somewhere. This supports snapshots where weekly occupies one slot and the desired shorter window occupies the other.

**Data flow**: Consumes `snapshot` and `label` → first requires `find_codex_window(snapshot, "weekly")?`, then reads `snapshot.secondary.as_ref()?`, checks it with `matches_window_label`, and returns `Some((secondary, true))` on match or `None` otherwise.

**Call relations**: Participates in the five-hour fallback chain to prefer a labeled secondary `5h` window when weekly data is also present.

*Call graph*: calls 2 internal fn (find_codex_window, matches_window_label).


##### `non_weekly_primary_window`  (lines 964–973)

```
fn non_weekly_primary_window(
    snapshot: &RateLimitSnapshotDisplay,
) -> Option<(&RateLimitWindowDisplay, bool)>
```

**Purpose**: Returns the primary rate-limit window only when it is not weekly. This is a generic fallback for displaying some shorter codex window when no explicit `5h` label is found.

**Data flow**: Consumes `snapshot`, reads `snapshot.primary.as_ref()?`, checks whether it matches `"weekly"`, and returns `Some((primary, false))` only when it does not.

**Call relations**: Used late in the five-hour fallback chain after explicit labeled-window searches fail.

*Call graph*: calls 1 internal fn (matches_window_label).


##### `non_weekly_secondary_window_when_primary_is_weekly`  (lines 975–989)

```
fn non_weekly_secondary_window_when_primary_is_weekly(
    snapshot: &RateLimitSnapshotDisplay,
) -> Option<(&RateLimitWindowDisplay, bool)>
```

**Purpose**: Returns the secondary rate-limit window when the primary is weekly and the secondary is not. This captures the common two-window layout of weekly plus another shorter window.

**Data flow**: Consumes `snapshot`, requires `snapshot.primary` to exist and match `"weekly"`, then reads `snapshot.secondary.as_ref()?` and returns `Some((secondary, true))` only if the secondary does not also match `"weekly"`.

**Call relations**: Final fallback in five-hour window selection when explicit labels are unavailable but the snapshot still clearly contains a non-weekly secondary window.

*Call graph*: calls 1 internal fn (matches_window_label).


##### `matches_window_label`  (lines 991–997)

```
fn matches_window_label(window: &RateLimitWindowDisplay, label: &str) -> bool
```

**Purpose**: Checks whether a rate-limit window’s `window_minutes` resolves to a specific compact duration label such as `5h` or `weekly`. It delegates minute-to-label conversion to the shared limits helper.

**Data flow**: Consumes `window` and `label`, reads `window.window_minutes`, converts it with `get_limits_duration`, and compares the resulting optional string slice to `Some(label)` → returns a boolean.

**Call relations**: Leaf predicate used by all rate-limit window selection helpers to keep label matching consistent.

*Call graph*: called by 5 (find_codex_window, find_primary_codex_window, non_weekly_primary_window, non_weekly_secondary_window_when_primary_is_weekly, secondary_window_with_label_when_weekly_is_available).


##### `permissions_display`  (lines 999–1026)

```
fn permissions_display(config: &Config) -> String
```

**Purpose**: Formats the current permission profile into a short human-readable label for status surfaces. It prefers explicit active-profile ids when they are user-facing, otherwise derives a summary from the effective sandbox configuration.

**Data flow**: Consumes `config`, reads `config.permissions.active_permission_profile()` → if present and its id does not start with `:`, returns that id directly. Otherwise reads the effective permission profile and workspace roots, summarizes them with `summarize_permission_profile`, and maps common summaries to `Read Only`, `Workspace`, or `Full Access` when `PermissionProfile::Disabled`; all other cases become `Custom permissions`.

**Call relations**: Called from status-line item formatting for the `Permissions` item so the footer can show a concise sandbox label without exposing raw config internals.

*Call graph*: called by 1 (status_line_value_for_item); 2 external calls (effective_workspace_roots, summarize_permission_profile).


##### `approval_mode_display`  (lines 1028–1038)

```
fn approval_mode_display(config: &Config) -> String
```

**Purpose**: Formats the current approval policy into the short label shown on status surfaces. It special-cases `OnRequest` to distinguish auto-review from explicit user approval.

**Data flow**: Consumes `config`, converts `config.permissions.approval_policy.value()` into `AskForApproval` → if it is `OnRequest`, returns either `Approve for me` or `Ask for approval` based on `config.approvals_reviewer`; otherwise returns the raw approval-policy value as a string.

**Call relations**: Used by status-line item formatting for the `ApprovalMode` item, translating low-level policy settings into user-facing wording.

*Call graph*: calls 1 internal fn (from); called by 1 (status_line_value_for_item).


##### `parse_items_with_invalids`  (lines 1040–1058)

```
fn parse_items_with_invalids(ids: impl IntoIterator<Item = String>) -> (Vec<T>, Vec<String>)
```

**Purpose**: Parses a sequence of raw item ids into typed enums while collecting unknown ids exactly once in insertion order. It is generic over any `FromStr` item enum.

**Data flow**: Consumes an iterator of `String` ids → iterates each id, attempts `id.parse::<T>()`, pushes successful parses into `items`, and for parse failures inserts the raw id into `invalid_seen` and, on first occurrence, pushes a quoted version into `invalid` → returns `(items, invalid)`.

**Call relations**: Shared by both status-line and terminal-title parsing helpers so invalid-id handling is consistent across the two configurable surfaces.

*Call graph*: called by 2 (status_line_items_with_invalids, terminal_title_items_with_invalids); 3 external calls (new, new, format!).


### `tui/src/branch_summary.rs`

`domain_logic` · `background status refresh`

This file implements asynchronous metadata probes for the TUI status line. Its public outputs are `current_branch_name`, which returns the checked-out branch name when available, and `status_line_git_summary`, which concurrently resolves an optional open pull request plus optional committed diff stats against the repository’s default branch. The data model is intentionally sparse: `StatusLineGitSummary` may contain either field independently, and all failures degrade to `None` rather than surfacing user-visible errors.

Branch diff computation first verifies the directory is a git repo, then resolves a comparison base through `get_default_branch`. That lookup prefers remote-tracking defaults: it gathers remotes with `origin` prioritized, tries `refs/remotes/<remote>/HEAD` via `symbolic-ref`, falls back to parsing `git remote show`, and only then falls back to local `refs/heads/main` or `master`. The chosen ref is verified with `git_ref_exists` before use. Diff stats are then computed from `git diff --numstat <merge-base>..HEAD` by summing parsed additions and deletions.

Pull-request lookup prefers `gh pr view --json number,url,state` for the current branch. If that fails, it falls back to commit-based lookup: resolve `HEAD`, query `gh repo view --json nameWithOwner,parent` to build a parent-first repository search order, then call the GitHub REST commit-to-PR endpoint for each repo until an open PR is found. `run_git_command` and `run_gh_command` centralize command construction and environment settings, including disabling prompts for background UI work.

#### Function details

##### `current_branch_name`  (lines 100–112)

```
async fn current_branch_name(
    runner: &dyn WorkspaceCommandExecutor,
    cwd: &Path,
) -> Option<String>
```

**Purpose**: Returns the current checked-out branch name for a workspace, omitting detached or unavailable states.

**Data flow**: Runs `git branch --show-current` through `run_git_command`, returns `None` on command error or non-success exit, trims stdout, filters out empty names, and otherwise returns `Some(String)`.

**Call relations**: Status-line refresh code calls this when it needs only the branch label without the heavier PR/diff summary.

*Call graph*: calls 1 internal fn (run_git_command); called by 2 (request_status_line_branch, on_agent_message_item_completed).


##### `status_line_git_summary`  (lines 119–131)

```
async fn status_line_git_summary(
    runner: &dyn WorkspaceCommandExecutor,
    cwd: &Path,
) -> StatusLineGitSummary
```

**Purpose**: Resolves the optional pull-request and branch-diff metadata for one working directory in parallel.

**Data flow**: Uses `tokio::join!` to await `open_pull_request(runner, cwd)` and `branch_diff_stats_to_default_branch(runner, cwd)` concurrently, then packages the two optional results into `StatusLineGitSummary`.

**Call relations**: The status-line refresh path uses this combined probe when it wants all git-related footer metadata in one cached result.

*Call graph*: called by 1 (request_status_line_git_summary); 1 external calls (join!).


##### `branch_diff_stats_to_default_branch`  (lines 138–191)

```
async fn branch_diff_stats_to_default_branch(
    runner: &dyn WorkspaceCommandExecutor,
    cwd: &Path,
) -> Option<GitBranchDiffStats>
```

**Purpose**: Computes committed additions and deletions between `HEAD` and the merge base with the repository’s default branch.

**Data flow**: Verifies the repo with `git rev-parse --git-dir`, resolves a `DefaultBranch`, computes `git merge-base HEAD <merge_ref>`, builds `<merge-base>..HEAD`, runs `git diff --numstat`, parses each tab-separated line’s first two columns as additions/deletions, sums them into `u64`s, and returns `Some(GitBranchDiffStats)` or `None` on any failure/empty merge base.

**Call relations**: This is one half of `status_line_git_summary`; tests also call it directly to verify default-branch preference behavior.

*Call graph*: calls 2 internal fn (get_default_branch, run_git_command); called by 1 (branch_diff_stats_prefers_remote_default_ref_over_stale_local_branch); 1 external calls (format!).


##### `get_git_remotes`  (lines 198–210)

```
async fn get_git_remotes(runner: &dyn WorkspaceCommandExecutor, cwd: &Path) -> Option<Vec<String>>
```

**Purpose**: Returns the repository’s remotes with `origin` moved to the front when present.

**Data flow**: Runs `git remote`, returns `None` on failure, collects stdout lines into `Vec<String>`, and if `origin` exists removes and reinserts it at index 0 before returning the vector.

**Call relations**: Default-branch discovery uses this ordering so the most likely upstream remote is tried first.

*Call graph*: calls 1 internal fn (run_git_command); called by 1 (get_default_branch).


##### `get_default_branch`  (lines 217–236)

```
async fn get_default_branch(
    runner: &dyn WorkspaceCommandExecutor,
    cwd: &Path,
) -> Option<DefaultBranch>
```

**Purpose**: Finds the best branch ref to use as the repository’s default-branch comparison base.

**Data flow**: Fetches remotes with `get_git_remotes().unwrap_or_default()`, then for each remote tries `get_remote_default_branch_from_symbolic_ref` and `get_remote_default_branch_from_remote_show` in order, returning the first success. If none succeed, it falls back to `get_default_branch_local`.

**Call relations**: Branch diff computation delegates here before running merge-base and diff commands.

*Call graph*: calls 4 internal fn (get_default_branch_local, get_git_remotes, get_remote_default_branch_from_remote_show, get_remote_default_branch_from_symbolic_ref); called by 1 (branch_diff_stats_to_default_branch).


##### `get_remote_default_branch_from_symbolic_ref`  (lines 243–266)

```
async fn get_remote_default_branch_from_symbolic_ref(
    runner: &dyn WorkspaceCommandExecutor,
    cwd: &Path,
    remote: &str,
) -> Option<DefaultBranch>
```

**Purpose**: Resolves a remote’s symbolic `HEAD` ref into a verified remote-tracking branch ref.

**Data flow**: Builds `refs/remotes/<remote>/HEAD`, runs `git symbolic-ref --quiet` on it, trims stdout, verifies it starts with `refs/remotes/<remote>/`, checks that the resolved ref exists with `git_ref_exists`, and returns `DefaultBranch { merge_ref }` on success.

**Call relations**: This is the preferred remote-default-branch lookup inside `get_default_branch` because it directly uses git’s symbolic HEAD metadata.

*Call graph*: calls 2 internal fn (git_ref_exists, run_git_command); called by 1 (get_default_branch); 1 external calls (format!).


##### `get_remote_default_branch_from_remote_show`  (lines 273–300)

```
async fn get_remote_default_branch_from_remote_show(
    runner: &dyn WorkspaceCommandExecutor,
    cwd: &Path,
    remote: &str,
) -> Option<DefaultBranch>
```

**Purpose**: Parses `git remote show <remote>` output to discover the remote’s default branch when symbolic HEAD is unavailable.

**Data flow**: Runs `git remote show <remote>`, scans trimmed stdout lines for `HEAD branch:`, extracts the branch name, constructs `refs/remotes/<remote>/<name>`, verifies that ref exists with `git_ref_exists`, and returns it wrapped in `DefaultBranch`.

**Call relations**: Used as a fallback inside `get_default_branch` when the symbolic-ref path fails.

*Call graph*: calls 2 internal fn (git_ref_exists, run_git_command); called by 1 (get_default_branch); 1 external calls (format!).


##### `get_default_branch_local`  (lines 303–317)

```
async fn get_default_branch_local(
    runner: &dyn WorkspaceCommandExecutor,
    cwd: &Path,
) -> Option<DefaultBranch>
```

**Purpose**: Falls back to local `main` or `master` refs when no remote default branch can be resolved.

**Data flow**: Iterates the candidates `main` and `master`, constructs `refs/heads/<candidate>`, checks each with `git_ref_exists`, and returns the first matching `DefaultBranch` or `None`.

**Call relations**: This is the final fallback in default-branch discovery.

*Call graph*: calls 1 internal fn (git_ref_exists); called by 1 (get_default_branch); 1 external calls (format!).


##### `git_ref_exists`  (lines 320–332)

```
async fn git_ref_exists(
    runner: &dyn WorkspaceCommandExecutor,
    cwd: &Path,
    reference: &str,
) -> bool
```

**Purpose**: Checks whether a specific git ref resolves successfully in the target workspace.

**Data flow**: Runs `git rev-parse --verify --quiet <reference>` and returns true only when the command succeeds and exits successfully.

**Call relations**: All default-branch discovery paths use this to avoid later merge-base failures on stale or missing refs.

*Call graph*: calls 1 internal fn (run_git_command); called by 3 (get_default_branch_local, get_remote_default_branch_from_remote_show, get_remote_default_branch_from_symbolic_ref).


##### `open_pull_request`  (lines 339–348)

```
async fn open_pull_request(
    runner: &dyn WorkspaceCommandExecutor,
    cwd: &Path,
) -> Option<StatusLinePullRequest>
```

**Purpose**: Finds the open pull request associated with the current checkout, preferring branch-based lookup and falling back to commit-based lookup.

**Data flow**: Calls `open_pull_request_for_current_branch`; if it returns `Some`, that value is returned immediately. Otherwise it awaits `open_pull_request_for_head_commit` and returns its result.

**Call relations**: This is the PR half of `status_line_git_summary`, and tests call it directly to verify branch-first and fallback behavior.

*Call graph*: calls 2 internal fn (open_pull_request_for_current_branch, open_pull_request_for_head_commit); called by 2 (open_pull_request_falls_back_to_parent_repo_commit_lookup, open_pull_request_uses_current_branch_view_first).


##### `open_pull_request_for_current_branch`  (lines 351–362)

```
async fn open_pull_request_for_current_branch(
    runner: &dyn WorkspaceCommandExecutor,
    cwd: &Path,
) -> Option<StatusLinePullRequest>
```

**Purpose**: Uses GitHub CLI’s branch-aware PR lookup for the current checkout.

**Data flow**: Runs `gh pr view --json number,url,state`, returns `None` on command failure or non-success exit, and otherwise parses stdout with `pull_request_from_view_output`.

**Call relations**: This is the cheap first attempt inside `open_pull_request`.

*Call graph*: calls 2 internal fn (pull_request_from_view_output, run_gh_command); called by 1 (open_pull_request).


##### `open_pull_request_for_head_commit`  (lines 365–392)

```
async fn open_pull_request_for_head_commit(
    runner: &dyn WorkspaceCommandExecutor,
    cwd: &Path,
) -> Option<StatusLinePullRequest>
```

**Purpose**: Looks up open PRs associated with the current `HEAD` commit across a parent-first repository search order.

**Data flow**: Resolves `head_sha` with `current_head_sha`, gets repositories from `gh_repo_search_order`, then for each repo builds `repos/<repo>/commits/<sha>/pulls`, runs `gh api -H Accept: application/vnd.github+json <endpoint>`, and returns the first open PR parsed by `pull_request_from_api_output`.

**Call relations**: This fallback path runs only when branch-based `gh pr view` lookup fails, supporting fork workflows where the PR lives on the parent repo.

*Call graph*: calls 4 internal fn (current_head_sha, gh_repo_search_order, pull_request_from_api_output, run_gh_command); called by 1 (open_pull_request); 1 external calls (format!).


##### `current_head_sha`  (lines 395–404)

```
async fn current_head_sha(runner: &dyn WorkspaceCommandExecutor, cwd: &Path) -> Option<String>
```

**Purpose**: Returns the current `HEAD` commit SHA.

**Data flow**: Runs `git rev-parse HEAD`, returns `None` on failure or non-success exit, trims stdout, filters out empty strings, and otherwise returns the SHA.

**Call relations**: Commit-based PR lookup uses this before querying GitHub’s commit-to-PR endpoint.

*Call graph*: calls 1 internal fn (run_git_command); called by 1 (open_pull_request_for_head_commit).


##### `gh_repo_search_order`  (lines 407–423)

```
async fn gh_repo_search_order(
    runner: &dyn WorkspaceCommandExecutor,
    cwd: &Path,
) -> Option<Vec<String>>
```

**Purpose**: Returns the repository names to query for commit-associated PRs, preferring the parent repository before the current fork.

**Data flow**: Runs `gh repo view --json nameWithOwner,parent`, returns `None` on failure or non-success exit, and otherwise parses stdout with `repo_search_order_from_output`.

**Call relations**: Commit-based PR lookup uses this to decide which repositories to query in order.

*Call graph*: calls 2 internal fn (repo_search_order_from_output, run_gh_command); called by 1 (open_pull_request_for_head_commit).


##### `pull_request_from_view_output`  (lines 426–435)

```
fn pull_request_from_view_output(stdout: &str) -> Option<StatusLinePullRequest>
```

**Purpose**: Parses `gh pr view` JSON output and returns a PR only when its state is open.

**Data flow**: Deserializes stdout into `GhPullRequestView`, checks `state.eq_ignore_ascii_case("open")`, and if true returns `StatusLinePullRequest { number, url }`.

**Call relations**: Branch-based PR lookup delegates parsing here.

*Call graph*: called by 1 (open_pull_request_for_current_branch).


##### `pull_request_from_api_output`  (lines 438–447)

```
fn pull_request_from_api_output(stdout: &str) -> Option<StatusLinePullRequest>
```

**Purpose**: Parses the GitHub REST commit-to-PR response and returns the first open PR item.

**Data flow**: Deserializes stdout into `Vec<GhPullRequestApiItem>`, finds the first item whose `state` is case-insensitively `open`, and maps it into `StatusLinePullRequest`.

**Call relations**: Commit-based PR lookup uses this after each `gh api` call.

*Call graph*: called by 1 (open_pull_request_for_head_commit).


##### `repo_search_order_from_output`  (lines 453–469)

```
fn repo_search_order_from_output(stdout: &str) -> Option<Vec<String>>
```

**Purpose**: Parses `gh repo view` JSON into a parent-first repository search order without duplicates.

**Data flow**: Deserializes stdout into `GhRepoView`, pushes `parent.name_with_owner` first when present, then pushes `name_with_owner` if present and not already included, returns `None` if the resulting vector is empty, otherwise `Some(Vec<String>)`.

**Call relations**: The `gh_repo_search_order` command wrapper delegates parsing here.

*Call graph*: called by 1 (gh_repo_search_order); 1 external calls (new).


##### `run_git_command`  (lines 472–487)

```
async fn run_git_command(
    runner: &dyn WorkspaceCommandExecutor,
    cwd: &Path,
    args: &[&str],
) -> Result<WorkspaceCommandOutput, crate::workspace_command::WorkspaceCommandError>
```

**Purpose**: Builds and executes a git command through the workspace-command abstraction with prompt-safe environment settings.

**Data flow**: Allocates an argv vector beginning with `git`, appends the provided args, constructs `WorkspaceCommand::new(argv).cwd(cwd.to_path_buf()).env("GIT_OPTIONAL_LOCKS", "0")`, and awaits `runner.run(...)`, returning the resulting `WorkspaceCommandOutput` or error.

**Call relations**: All git probes in this file route through this helper so command construction and environment policy stay centralized.

*Call graph*: calls 1 internal fn (new); called by 7 (branch_diff_stats_to_default_branch, current_branch_name, current_head_sha, get_git_remotes, get_remote_default_branch_from_remote_show, get_remote_default_branch_from_symbolic_ref, git_ref_exists); 3 external calls (to_path_buf, with_capacity, run).


##### `run_gh_command`  (lines 493–509)

```
async fn run_gh_command(
    runner: &dyn WorkspaceCommandExecutor,
    cwd: &Path,
    args: &[&str],
) -> Result<WorkspaceCommandOutput, crate::workspace_command::WorkspaceCommandError>
```

**Purpose**: Builds and executes a GitHub CLI command through the workspace-command abstraction with prompting disabled.

**Data flow**: Allocates an argv vector beginning with `gh`, appends the provided args, constructs `WorkspaceCommand::new(argv).cwd(cwd.to_path_buf()).env("GH_PROMPT_DISABLED", "1").env("GIT_TERMINAL_PROMPT", "0")`, and awaits `runner.run(...)`.

**Call relations**: All GitHub CLI probes use this helper so background status refreshes never block on authentication or interactive prompts.

*Call graph*: calls 1 internal fn (new); called by 3 (gh_repo_search_order, open_pull_request_for_current_branch, open_pull_request_for_head_commit); 3 external calls (to_path_buf, with_capacity, run).


##### `tests::branch_diff_stats_prefers_remote_default_ref_over_stale_local_branch`  (lines 521–569)

```
async fn branch_diff_stats_prefers_remote_default_ref_over_stale_local_branch()
```

**Purpose**: Verifies branch diff stats use the verified remote default branch rather than a potentially stale local branch.

**Data flow**: Builds a `FakeRunner` with scripted git responses, runs `branch_diff_stats_to_default_branch`, asserts the resulting stats, and checks that the merge-base command used `refs/remotes/origin/main`.

**Call relations**: This test covers the preferred remote-default-branch path through default-branch discovery.

*Call graph*: calls 1 internal fn (branch_diff_stats_to_default_branch); 5 external calls (new, assert!, assert_eq!, new, vec!).


##### `tests::open_pull_request_uses_current_branch_view_first`  (lines 572–591)

```
async fn open_pull_request_uses_current_branch_view_first()
```

**Purpose**: Ensures PR lookup returns the branch-based `gh pr view` result without falling back to commit lookup.

**Data flow**: Provides a fake successful `gh pr view` response, runs `open_pull_request`, asserts the parsed PR, and checks that no `git rev-parse HEAD` command was issued.

**Call relations**: Covers the fast-path branch-first behavior in `open_pull_request`.

*Call graph*: calls 1 internal fn (open_pull_request); 5 external calls (new, assert!, assert_eq!, new, vec!).


##### `tests::open_pull_request_falls_back_to_parent_repo_commit_lookup`  (lines 594–642)

```
async fn open_pull_request_falls_back_to_parent_repo_commit_lookup()
```

**Purpose**: Verifies PR lookup falls back to commit-based search and queries the parent repository first.

**Data flow**: Scripts a failing `gh pr view`, successful `git rev-parse HEAD`, parent/fork repo metadata, and a successful parent-repo commit-to-PR API response, then asserts the resulting PR and observed API command.

**Call relations**: Covers the fallback path through `current_head_sha`, `gh_repo_search_order`, and commit-based PR parsing.

*Call graph*: calls 1 internal fn (open_pull_request); 5 external calls (new, assert!, assert_eq!, new, vec!).


##### `tests::status_line_pr_view_parser_requires_open_pr`  (lines 645–662)

```
fn status_line_pr_view_parser_requires_open_pr()
```

**Purpose**: Checks that branch-view PR parsing accepts open PRs and rejects merged ones.

**Data flow**: Calls `pull_request_from_view_output` with OPEN and MERGED JSON payloads and asserts `Some` vs `None`.

**Call relations**: Directly validates the parser used by branch-based PR lookup.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::status_line_pr_fallback_searches_parent_repo_first`  (lines 665–672)

```
fn status_line_pr_fallback_searches_parent_repo_first()
```

**Purpose**: Checks parent-first repository ordering for fallback PR lookup.

**Data flow**: Parses a repo-view JSON payload with both fork and parent and asserts the resulting vector order is parent then fork.

**Call relations**: Directly validates the parser used by `gh_repo_search_order`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::response`  (lines 674–683)

```
fn response(argv: &[&str], exit_code: i32, stdout: &str) -> FakeResponse
```

**Purpose**: Builds a fake command-response record for the test runner.

**Data flow**: Converts an argv slice into `Vec<String>`, wraps the provided exit code and stdout in `WorkspaceCommandOutput`, and returns `FakeResponse { argv, output }`.

**Call relations**: The branch-summary tests use this helper to script expected command outputs.

*Call graph*: 1 external calls (new).


##### `tests::FakeRunner::new`  (lines 696–701)

```
fn new(responses: Vec<FakeResponse>) -> Self
```

**Purpose**: Constructs a fake workspace-command executor with queued responses and an empty seen-command log.

**Data flow**: Wraps the provided response vector in a `VecDeque` inside a `Mutex`, initializes an empty `seen` vector in another `Mutex`, and returns the runner.

**Call relations**: All tests in this file use this fake executor to drive deterministic command behavior.

*Call graph*: 2 external calls (new, new).


##### `tests::FakeRunner::saw`  (lines 703–710)

```
fn saw(&self, argv: &[&str]) -> bool
```

**Purpose**: Checks whether a specific argv sequence has been executed by the fake runner.

**Data flow**: Converts the queried argv slice into `Vec<String>`, locks `seen`, and returns true if any recorded command exactly matches it.

**Call relations**: Tests use this to assert which fallback paths were or were not taken.


##### `tests::FakeRunner::run`  (lines 714–737)

```
fn run(
            &self,
            command: WorkspaceCommand,
        ) -> Pin<
            Box<
                dyn Future<Output = Result<WorkspaceCommandOutput, WorkspaceCommandError>>
```

**Purpose**: Implements `WorkspaceCommandExecutor` by recording commands and returning the matching scripted fake response.

**Data flow**: Pushes `command.argv` into the `seen` log, then returns a boxed async block that locks the queued responses, finds the first response whose argv matches the command, removes it from the deque, and returns its `WorkspaceCommandOutput`.

**Call relations**: This fake executor stands in for the real workspace-command layer during all branch-summary tests.

*Call graph*: 1 external calls (pin).


### `tui/src/app/agent_status_feed.rs`

`domain_logic` · `status rendering / transcript insertion`

This module turns recent per-thread buffered events into compact status previews suitable for transcript/history display. It defines two main types: `AgentStatusHistoryCell`, which implements `HistoryCell` and renders the overall `/agent` output, and `AgentStatusThreadPreview`, which stores one agent path plus a bounded list of recent activity strings.

The preview pipeline is intentionally lossy and bounded. `AgentStatusThreadPreview::from_store` walks a thread's buffered events in reverse chronological order, deduplicates by `ThreadItem::id()` using a `HashSet`, converts recognized items into short summaries with `activity_summary`, stops after `AGENT_STATUS_PREVIEW_ITEMS`, then reverses the collected list back into chronological display order. Summaries are truncated to `AGENT_STATUS_PREVIEW_GRAPHEMES`, whitespace-normalized, and omitted entirely for unhelpful item types like user messages, hook prompts, and sleep.

Rendering also enforces limits. `AgentStatusHistoryCell::display_lines` emits a `/agent` header, a bold section title, and either an italic empty-state bullet or one titled block per preview. Each preview wraps activity text to the available width minus a fixed indent, dims preview lines, and keeps only the last `AGENT_STATUS_PREVIEW_LINES` wrapped lines so long outputs do not dominate the transcript. `raw_lines` reuses `display_lines(u16::MAX)` and strips styling via `plain_lines`.

The result is a best-effort status snapshot that favors recent, human-readable activity while avoiding unbounded transcript growth or expensive full-thread rendering.

#### Function details

##### `AgentStatusHistoryCell::new`  (lines 27–29)

```
fn new(entries: Vec<AgentStatusThreadPreview>) -> Self
```

**Purpose**: Constructs a history cell from a prepared list of per-thread status previews.

**Data flow**: Consumes `Vec<AgentStatusThreadPreview>` and stores it in the `entries` field of a new `AgentStatusHistoryCell`.

**Call relations**: This constructor is used by `/agent` UI code and tests once preview entries have already been assembled from thread event stores.

*Call graph*: called by 3 (agent_status_uses_bounded_buffered_activity, agent_status_uses_reasoning_summaries_only, open_agent_picker).


##### `AgentStatusHistoryCell::display_lines`  (lines 33–58)

```
fn display_lines(&self, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Renders the `/agent` status cell into styled terminal lines with headers, per-agent titles, and bounded preview text.

**Data flow**: Starts with header lines (`/agent`, `Sub-agents running`, blank line). If `entries` is empty, it appends an italic empty-state bullet and returns. Otherwise it iterates previews, appends each `title_line`, computes preview width as `width - indent` clamped to at least 1, gets wrapped preview lines from `preview_lines`, inserts either a dim italic `No recent activity yet.` line or the indented preview lines, and separates entries with blank lines before dropping the final trailing blank.

**Call relations**: This is the main rendering implementation for the history cell and is called by `raw_lines`. It delegates per-entry formatting to `title_line`, `preview_lines`, and `indent_preview_line`.

*Call graph*: called by 1 (raw_lines); 1 external calls (vec!).


##### `AgentStatusHistoryCell::raw_lines`  (lines 60–62)

```
fn raw_lines(&self) -> Vec<Line<'static>>
```

**Purpose**: Returns an unstyled version of the rendered status cell lines.

**Data flow**: Calls `display_lines(u16::MAX)` to render without practical width restriction, then passes the result to `plain_lines` to strip styling and returns the resulting lines.

**Call relations**: This method fulfills the `HistoryCell` trait's raw-text path by reusing the styled rendering logic rather than maintaining a separate formatting implementation.

*Call graph*: calls 2 internal fn (display_lines, plain_lines).


##### `AgentStatusThreadPreview::from_store`  (lines 72–74)

```
fn from_store(agent_path: String, store: &ThreadEventStore) -> Self
```

**Purpose**: Builds a preview from a thread's buffered event store using reverse chronological event traversal.

**Data flow**: Consumes an `agent_path` string and borrows a `ThreadEventStore`, then calls `from_events(agent_path, store.buffer.iter().rev())` to summarize the newest buffered events first.

**Call relations**: This is the normal constructor used by `/agent` status generation and tests. It delegates all summarization and bounding logic to `from_events`.

*Call graph*: called by 3 (agent_status_uses_bounded_buffered_activity, agent_status_uses_reasoning_summaries_only, open_agent_picker); 1 external calls (from_events).


##### `AgentStatusThreadPreview::empty`  (lines 76–78)

```
fn empty(agent_path: String) -> Self
```

**Purpose**: Creates a preview with no activity entries for an agent path.

**Data flow**: Consumes an `agent_path` string and calls `from_events(agent_path, std::iter::empty())`, producing a preview whose `activity` vector is empty.

**Call relations**: This helper is used when the app wants to show an agent row even though no buffered activity has been recorded yet.

*Call graph*: called by 1 (open_agent_picker); 2 external calls (from_events, empty).


##### `AgentStatusThreadPreview::from_events`  (lines 80–114)

```
fn from_events(
        agent_path: String,
        events: impl Iterator<Item = &'a ThreadBufferedEvent>,
    ) -> Self
```

**Purpose**: Summarizes an iterator of buffered thread events into a bounded, deduplicated list of recent activity strings.

**Data flow**: Consumes an `agent_path` and an iterator over `&ThreadBufferedEvent`. It initializes a `HashSet` of seen item ids and an output `Vec<String>`, iterates events newest-first, extracts only `ItemStarted` and `ItemCompleted` notifications, skips duplicate item ids, converts each item with `activity_summary`, pushes successful summaries until `AGENT_STATUS_PREVIEW_ITEMS` is reached, then reverses the collected summaries into chronological order and returns `AgentStatusThreadPreview { agent_path, activity }`.

**Call relations**: This is the core summarization engine behind both `from_store` and `empty`. It delegates item-to-text conversion to `activity_summary` and enforces the module's bounded-preview policy.

*Call graph*: calls 1 internal fn (activity_summary); 2 external calls (new, new).


##### `AgentStatusThreadPreview::title_line`  (lines 116–118)

```
fn title_line(&self) -> Line<'static>
```

**Purpose**: Formats the preview's title line as a bullet plus the agent path in cyan backticks.

**Data flow**: Reads `self.agent_path` and returns a `Line<'static>` composed from a dim bullet prefix and a cyan formatted `` `path` `` span.

**Call relations**: This helper is called by `AgentStatusHistoryCell::display_lines` when rendering each preview block.

*Call graph*: 1 external calls (vec!).


##### `AgentStatusThreadPreview::preview_lines`  (lines 120–132)

```
fn preview_lines(&self, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Wraps and truncates the preview's activity text into the bounded set of dim display lines shown under the title.

**Data flow**: Iterates over `self.activity`, wraps each string to the provided width with `textwrap::wrap`, filters out blank wrapped lines, converts them into dim `Line<'static>` values, and if the total exceeds `AGENT_STATUS_PREVIEW_LINES`, drains the oldest lines so only the most recent wrapped lines remain. It returns the resulting vector.

**Call relations**: This helper is used by `display_lines` to render each preview's body while enforcing the line-count bound independently of the item-count bound used during summarization.


##### `activity_summary`  (lines 135–196)

```
fn activity_summary(item: &ThreadItem) -> Option<String>
```

**Purpose**: Converts a `ThreadItem` into a short human-readable activity summary when that item type is useful for `/agent` status previews.

**Data flow**: Pattern-matches the `ThreadItem` variant. For text-bearing items like `AgentMessage`, `Plan`, and `Reasoning`, it selects the relevant text; for commands, file changes, MCP/dynamic tool calls, collaboration actions, sub-agent activity, web search, image view/generation, review-mode transitions, and context compaction, it formats a concise summary string, often truncating with `truncate_text` and passing through `bounded_summary`. For `UserMessage`, `HookPrompt`, and `Sleep`, it returns `None`.

**Call relations**: This function is called from `AgentStatusThreadPreview::from_events` for each candidate item. It is the semantic mapping layer that decides which backend events are worth surfacing and how they should be phrased.

*Call graph*: calls 2 internal fn (bounded_summary, truncate_text); called by 1 (from_events); 1 external calls (format!).


##### `bounded_summary`  (lines 198–202)

```
fn bounded_summary(summary: &str) -> Option<String>
```

**Purpose**: Normalizes and length-bounds a summary string, returning `None` if nothing meaningful remains.

**Data flow**: Takes a `&str`, truncates it to `AGENT_STATUS_PREVIEW_GRAPHEMES` with `truncate_text`, collapses all whitespace runs by splitting and rejoining with single spaces, and returns `Some(String)` only if the normalized result is nonempty.

**Call relations**: This helper is used by `activity_summary` to apply consistent truncation and whitespace cleanup across many item types.

*Call graph*: calls 1 internal fn (truncate_text); called by 1 (activity_summary).


##### `indent_preview_line`  (lines 204–207)

```
fn indent_preview_line(mut line: Line<'static>) -> Line<'static>
```

**Purpose**: Adds the fixed four-space indent prefix to a rendered preview line.

**Data flow**: Takes ownership of a `Line<'static>`, inserts a leading `"    "` span at index 0 of its spans vector, and returns the modified line.

**Call relations**: This helper is used by `AgentStatusHistoryCell::display_lines` when rendering wrapped preview lines beneath each agent title.


### `tui/src/bottom_pane/pending_input_preview.rs`

`domain_logic` · `rendering`

This widget is a presentation-only component that turns three queues of strings into a vertically stacked preview. `PendingInputPreview` stores `pending_steers`, `rejected_steers`, and `queued_messages`, plus optional `edit_binding` and `interrupt_binding` values used only for hint text. `new` seeds those bindings to Alt+Up for editing the last queued message and Esc for immediate interrupt/send of pending steers.

The rendering pipeline is centered on `as_renderable`. If there is nothing to show or the width is too narrow, it returns an empty renderable (`()`). Otherwise it builds a `Vec<Line<'static>>` section by section. Headers are emitted through `push_section_header`, which prepends a dim bullet and wraps the header text with a dim subsequent indent. Each message or steer is split on embedded newlines, wrapped with `adaptive_wrap_lines`, and prefixed with a dim arrow indent; queued messages are additionally italicized. `push_truncated_preview_lines` enforces `PREVIEW_LINE_LIMIT` per item, appending an overflow line like `…` when wrapping produced more than three lines. Blank lines separate non-empty sections. Only the queued-messages section gets the final edit hint line, and only when there are actual queued messages and an edit binding is configured. The `Renderable` impl simply delegates both sizing and drawing to the boxed renderable returned by `as_renderable`.

#### Function details

##### `PendingInputPreview::new`  (lines 37–45)

```
fn new() -> Self
```

**Purpose**: Constructs an empty preview widget with default displayed bindings for editing queued messages and interrupting pending steers. It establishes the widget's initial presentation state.

**Data flow**: Creates empty vectors for `pending_steers`, `rejected_steers`, and `queued_messages`, sets `edit_binding` to `Some(alt(Up))`, sets `interrupt_binding` to `Some(plain(Esc))`, and returns the struct.

**Call relations**: Used by production setup and all tests as the standard starting state.

*Call graph*: calls 2 internal fn (alt, plain); called by 14 (new, desired_height_empty, desired_height_one_message, long_url_like_message_does_not_expand_into_wrapped_ellipsis_rows, render_many_line_message, render_more_than_three_messages, render_multiline_pending_steer_uses_single_prefix_and_truncates, render_one_message, render_one_message_with_shift_left_binding, render_one_pending_steer (+4 more)); 1 external calls (new).


##### `PendingInputPreview::set_edit_binding`  (lines 50–52)

```
fn set_edit_binding(&mut self, binding: Option<key_hint::KeyBinding>)
```

**Purpose**: Overrides or removes the keybinding shown in the queued-message edit hint. It affects only rendered text, not actual input handling.

**Data flow**: Takes an `Option<KeyBinding>` and stores it into `self.edit_binding`.

**Call relations**: Called by higher-level configuration code when the displayed edit chord should match remapped runtime bindings.

*Call graph*: called by 1 (set_queued_message_edit_binding).


##### `PendingInputPreview::set_interrupt_binding`  (lines 54–56)

```
fn set_interrupt_binding(&mut self, binding: Option<key_hint::KeyBinding>)
```

**Purpose**: Overrides or removes the keybinding shown in the pending-steers header for immediate interrupt/send. Like `set_edit_binding`, it is purely presentational.

**Data flow**: Takes an `Option<KeyBinding>` and stores it into `self.interrupt_binding`.

**Call relations**: Called by surrounding UI setup when interrupt bindings are remapped.

*Call graph*: called by 1 (set_keymap_bindings).


##### `PendingInputPreview::push_truncated_preview_lines`  (lines 58–68)

```
fn push_truncated_preview_lines(
        lines: &mut Vec<Line<'static>>,
        wrapped: Vec<Line<'static>>,
        overflow_line: Line<'static>,
    )
```

**Purpose**: Appends up to three wrapped lines for one preview item and adds a synthetic overflow line when more wrapped lines existed. It enforces the per-item vertical cap used across all sections.

**Data flow**: Takes a mutable destination `lines`, a `wrapped` vector, and an `overflow_line`. It records `wrapped.len()`, extends `lines` with at most `PREVIEW_LINE_LIMIT` entries from `wrapped`, and if the original wrapped length exceeded the limit pushes `overflow_line` afterward.

**Call relations**: Used by `as_renderable` for pending steers, rejected steers, and queued messages after each item's wrapping step.


##### `PendingInputPreview::push_section_header`  (lines 70–77)

```
fn push_section_header(lines: &mut Vec<Line<'static>>, width: u16, header: Line<'static>)
```

**Purpose**: Builds and wraps a section header with a dim bullet prefix and hanging indent. It standardizes header formatting across all preview sections.

**Data flow**: Takes mutable `lines`, a `width`, and a `header` line. It constructs a span list beginning with dim `• `, appends the header's spans, wraps the resulting line with `adaptive_wrap_lines` using `RtOptions::new(width).subsequent_indent("  ")`, and extends `lines` with the wrapped output.

**Call relations**: Called by `as_renderable` before each non-empty section.

*Call graph*: calls 2 internal fn (new, adaptive_wrap_lines); 3 external calls (from, once, vec!).


##### `PendingInputPreview::as_renderable`  (lines 79–168)

```
fn as_renderable(&self, width: u16) -> Box<dyn Renderable>
```

**Purpose**: Converts the widget's current queued-input state into a concrete renderable paragraph or an empty renderable. It contains all section ordering, wrapping, truncation, and hint-line logic.

**Data flow**: Reads `pending_steers`, `rejected_steers`, `queued_messages`, `edit_binding`, `interrupt_binding`, and `width`. If all queues are empty or width is under 4, it returns `Box::new(())`. Otherwise it builds a `Vec<Line<'static>>`: pending steers first with an optional interrupt-binding clause in the header, then rejected steers, then queued messages. Each item is split into source lines, wrapped with `adaptive_wrap_lines` using arrow indents, truncated via `push_truncated_preview_lines`, and styled dim or dim+italic depending on section. If queued messages exist and `edit_binding` is set, it appends a final dim hint line. It wraps the final line list in `Paragraph::new(lines).into()` and returns it boxed.

**Call relations**: Used by both `render` and `desired_height`, making it the single source of truth for preview layout.

*Call graph*: calls 2 internal fn (new, adaptive_wrap_lines); called by 2 (desired_height, render); 6 external calls (new, from, new, push_section_header, push_truncated_preview_lines, vec!).


##### `PendingInputPreview::render`  (lines 172–178)

```
fn render(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Draws the preview into the target buffer if the area is non-empty. It delegates actual content generation to `as_renderable`.

**Data flow**: Takes `area` and mutable `buf`, returns early if `area.is_empty()`, otherwise builds a renderable with `as_renderable(area.width)` and renders it into the area.

**Call relations**: Called by the rendering framework and by snapshot-style tests.

*Call graph*: calls 1 internal fn (as_renderable); 1 external calls (is_empty).


##### `PendingInputPreview::desired_height`  (lines 180–182)

```
fn desired_height(&self, width: u16) -> u16
```

**Purpose**: Computes the preview's height by asking the generated renderable for its desired height at the given width. This keeps sizing aligned with actual wrapped content.

**Data flow**: Takes `width`, constructs the boxed renderable via `as_renderable(width)`, and returns its `desired_height(width)`.

**Call relations**: Used by layout code and tests before allocating a buffer for rendering.

*Call graph*: calls 1 internal fn (as_renderable).


##### `tests::desired_height_empty`  (lines 192–195)

```
fn desired_height_empty()
```

**Purpose**: Verifies that an empty preview consumes no vertical space. This confirms the empty-renderable fast path.

**Data flow**: Creates a new preview and asserts that `desired_height(40)` is zero.

**Call relations**: Exercises `new` and `desired_height` on the no-content case.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `tests::desired_height_one_message`  (lines 198–202)

```
fn desired_height_one_message()
```

**Purpose**: Checks the expected height for a single queued message plus its section header and edit hint. It validates the basic queued-message layout.

**Data flow**: Creates a preview, pushes one string into `queued_messages`, and asserts that `desired_height(40)` equals 3.

**Call relations**: Covers the queued-message section and hint-line inclusion.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `tests::render_one_message`  (lines 205–213)

```
fn render_one_message()
```

**Purpose**: Captures a snapshot of rendering for one queued message. It verifies concrete formatting and styling layout.

**Data flow**: Creates a preview with one queued message, computes height, renders into a `Buffer`, and snapshots the formatted buffer debug output.

**Call relations**: Exercises the full render path for the simplest non-empty queued-message case.

*Call graph*: calls 1 internal fn (new); 3 external calls (empty, new, assert_snapshot!).


##### `tests::render_one_message_with_shift_left_binding`  (lines 216–228)

```
fn render_one_message_with_shift_left_binding()
```

**Purpose**: Verifies that the queued-message edit hint reflects a remapped binding. It ensures the displayed hint is configurable.

**Data flow**: Creates a preview with one queued message, changes `edit_binding` to Shift+Left, renders into a buffer, and snapshots the result.

**Call relations**: Covers `set_edit_binding` and the conditional hint-line generation in `as_renderable`.

*Call graph*: calls 2 internal fn (new, shift); 3 external calls (empty, new, assert_snapshot!).


##### `tests::render_two_messages`  (lines 231–242)

```
fn render_two_messages()
```

**Purpose**: Snapshots rendering for multiple queued messages. It checks repeated item formatting within the same section.

**Data flow**: Creates a preview with two queued messages, renders it at width 40, and snapshots the buffer output.

**Call relations**: Exercises multiple-item accumulation in the queued-message section.

*Call graph*: calls 1 internal fn (new); 3 external calls (empty, new, assert_snapshot!).


##### `tests::render_more_than_three_messages`  (lines 245–262)

```
fn render_more_than_three_messages()
```

**Purpose**: Snapshots rendering when more than three queued messages are present. It validates per-item truncation behavior across a longer list.

**Data flow**: Creates a preview with four queued messages, renders it, and snapshots the output.

**Call relations**: Covers repeated use of `push_truncated_preview_lines` and overall section growth.

*Call graph*: calls 1 internal fn (new); 3 external calls (empty, new, assert_snapshot!).


##### `tests::render_wrapped_message`  (lines 265–278)

```
fn render_wrapped_message()
```

**Purpose**: Checks rendering of a queued message that wraps across lines. It validates wrapping plus truncation behavior for longer text.

**Data flow**: Creates a preview with a long queued message and a second shorter one, renders at width 40, and snapshots the buffer.

**Call relations**: Exercises `adaptive_wrap_lines` and wrapped queued-message formatting.

*Call graph*: calls 1 internal fn (new); 3 external calls (empty, new, assert_snapshot!).


##### `tests::render_many_line_message`  (lines 281–291)

```
fn render_many_line_message()
```

**Purpose**: Verifies handling of a queued message containing embedded newlines. It ensures multiline source text is rendered with a single arrow-prefix style and truncation rules.

**Data flow**: Creates a preview with one multiline queued message, renders it, and snapshots the output.

**Call relations**: Covers the `message.lines()` splitting path inside `as_renderable`.

*Call graph*: calls 1 internal fn (new); 3 external calls (empty, new, assert_snapshot!).


##### `tests::long_url_like_message_does_not_expand_into_wrapped_ellipsis_rows`  (lines 294–323)

```
fn long_url_like_message_does_not_expand_into_wrapped_ellipsis_rows()
```

**Purpose**: Ensures a long URL-like token does not produce extra wrapped ellipsis rows. It protects the wrapping behavior for long unbroken strings.

**Data flow**: Creates a preview with one very long URL-like queued message, asserts the computed height is exactly 3, renders into a buffer, reconstructs rendered rows as strings, and asserts none contain the ellipsis character.

**Call relations**: Validates interaction between wrapping logic and truncation for long unbreakable tokens.

*Call graph*: calls 1 internal fn (new); 4 external calls (empty, new, assert!, assert_eq!).


##### `tests::render_one_pending_steer`  (lines 326–334)

```
fn render_one_pending_steer()
```

**Purpose**: Snapshots rendering for a single pending steer. It verifies the pending-steers section header and item formatting.

**Data flow**: Creates a preview with one `pending_steers` entry, renders at width 48, and snapshots the buffer.

**Call relations**: Exercises the first section path in `as_renderable`.

*Call graph*: calls 1 internal fn (new); 3 external calls (empty, new, assert_snapshot!).


##### `tests::render_one_pending_steer_with_remapped_interrupt_binding`  (lines 337–349)

```
fn render_one_pending_steer_with_remapped_interrupt_binding()
```

**Purpose**: Checks that the pending-steers header reflects a remapped interrupt binding. It ensures the explanatory header text stays aligned with runtime key configuration.

**Data flow**: Creates a preview with one pending steer, sets `interrupt_binding` to F12, renders, and snapshots the output.

**Call relations**: Covers `set_interrupt_binding` and the optional interrupt-binding clause in the pending-steers header.

*Call graph*: calls 2 internal fn (new, plain); 4 external calls (empty, F, new, assert_snapshot!).


##### `tests::render_pending_steers_above_queued_messages`  (lines 352–372)

```
fn render_pending_steers_above_queued_messages()
```

**Purpose**: Verifies section ordering when all three categories are present. It ensures pending steers render first, rejected steers next, and queued messages last.

**Data flow**: Creates a preview with two pending steers, one rejected steer, and one queued message, renders at width 52, and snapshots the result.

**Call relations**: Exercises the full multi-section assembly path in `as_renderable`.

*Call graph*: calls 1 internal fn (new); 3 external calls (empty, new, assert_snapshot!).


##### `tests::render_multiline_pending_steer_uses_single_prefix_and_truncates`  (lines 375–388)

```
fn render_multiline_pending_steer_uses_single_prefix_and_truncates()
```

**Purpose**: Checks that a multiline pending steer uses the expected wrapped prefixing and truncates after the configured preview-line limit. It validates multiline handling in the pending-steers section.

**Data flow**: Creates a preview with one four-line pending steer, renders at width 48, and snapshots the output.

**Call relations**: Covers `push_truncated_preview_lines` on multiline pending-steer content.

*Call graph*: calls 1 internal fn (new); 3 external calls (empty, new, assert_snapshot!).


### `tui/src/bottom_pane/status_line_style.rs`

`domain_logic` · `status-line rendering`

This file is the styling layer for the configurable bottom-pane status line. Its core abstraction is the private `StatusLineAccent` enum, which groups many concrete `StatusLineItem` variants into a smaller set of semantic buckets such as model, path, branch, usage, mode, and progress. Each accent exposes a list of syntax-highlight scopes used to query the active theme and a fallback `Style` color when no theme-derived foreground is available.

The main rendering path is `status_line_from_segments`, which accepts ordered `(StatusLineItem, String)` pairs and produces an optional `Line<'static>`. It delegates to a resolver-aware helper so tests can inject deterministic styles instead of consulting the real theme. The helper preserves segment order, inserts a dimmed separator string `" · "` between items, and chooses either a softened theme/fallback foreground or a plain dim style when theme colors are disabled. Pull request numbers receive an additional underline modifier to read like links.

Color softening is intentionally conservative: named bright colors are downgraded to their normal variants, white becomes gray, and RGB colors are desaturated toward their weighted luma using fixed saturation/brightness percentages. Only the foreground is altered; existing modifiers are preserved. Empty input yields `None` rather than an empty line, which lets callers omit the status row entirely.

#### Function details

##### `StatusLineAccent::for_item`  (lines 31–55)

```
fn for_item(item: StatusLineItem) -> Self
```

**Purpose**: Maps a concrete `StatusLineItem` variant into one semantic accent bucket used for color selection.

**Data flow**: Reads a `StatusLineItem` enum value, matches it against grouped variants, and returns the corresponding `StatusLineAccent` such as `Model`, `Path`, `Branch`, or `Usage`. It does not mutate any state.

**Call relations**: This is used during status-line assembly when themed colors are enabled, so each segment can be resolved through theme scopes or a fallback accent color.

*Call graph*: called by 1 (status_line_from_segments_with_resolver).


##### `StatusLineAccent::scopes`  (lines 57–70)

```
fn scopes(self) -> &'static [&'static str]
```

**Purpose**: Returns the syntax-scope preference list associated with one accent category.

**Data flow**: Consumes `self` and returns a static slice of scope strings like `entity.name.type`, `string`, or `constant.numeric`. No state is read or written beyond the enum value.

**Call relations**: Its output is consumed by the theme resolver closure passed into status-line construction so accent categories can reuse the editor/theme highlight palette.


##### `StatusLineAccent::fallback_style`  (lines 72–78)

```
fn fallback_style(self) -> Style
```

**Purpose**: Provides a default `ratatui::style::Style` when no theme-derived foreground can be found for an accent.

**Data flow**: Matches on `self` and returns `Style::default()` tinted cyan, green, or magenta depending on the accent family. It creates a fresh style and does not touch shared state.

**Call relations**: Status-line construction falls back to this when the theme resolver returns `None`, ensuring every accent still renders with a stable color.

*Call graph*: 1 external calls (default).


##### `status_line_from_segments`  (lines 81–91)

```
fn status_line_from_segments(
    segments: I,
    use_theme_colors: bool,
) -> Option<Line<'static>>
```

**Purpose**: Public entrypoint that converts ordered status segments into a styled `Line` using the real theme resolver.

**Data flow**: Accepts an iterator of `(StatusLineItem, String)` and a `use_theme_colors` flag, wraps `foreground_style_for_scopes(accent.scopes())` in a closure, and forwards everything to the resolver-aware helper. It returns `Some(Line)` for non-empty input or `None` for no segments.

**Call relations**: Callers use this normal production path; it delegates all assembly details to `status_line_from_segments_with_resolver` so tests can exercise the same logic with injected styles.

*Call graph*: calls 1 internal fn (status_line_from_segments_with_resolver).


##### `status_line_from_segments_with_resolver`  (lines 93–124)

```
fn status_line_from_segments_with_resolver(
    segments: I,
    use_theme_colors: bool,
    theme_style_for_accent: F,
) -> Option<Line<'static>>
```

**Purpose**: Assembles the final span list for the footer status line, including separators, color selection, optional underlining, and empty-input suppression.

**Data flow**: Consumes an iterator of `(StatusLineItem, String)`, a boolean controlling theme usage, and a resolver `Fn(StatusLineAccent) -> Option<Style>`. It builds a `Vec<Span>` in order, inserts a dimmed separator before every segment after the first, computes either a softened themed/fallback style or `Style::default().dim()`, underlines `PullRequestNumber`, wraps each text in `Span::styled`, and returns `Line::from(spans)` only if at least one span was produced.

**Call relations**: This is the central implementation used by the public wrapper and all unit tests. During themed rendering it invokes `StatusLineAccent::for_item` and `soften_status_line_style`; otherwise it emits uniformly dim text.

*Call graph*: calls 2 internal fn (for_item, soften_status_line_style); called by 6 (status_line_from_segments, pull_request_number_uses_link_style, status_line_segments_can_disable_theme_colors, status_line_segments_dim_separators_and_use_theme_styles_first, status_line_segments_preserve_order_and_plain_text, status_line_segments_soften_rgb_theme_styles_without_dimming_text); 3 external calls (styled, default, new).


##### `soften_status_line_style`  (lines 126–131)

```
fn soften_status_line_style(mut style: Style) -> Style
```

**Purpose**: Applies footer-specific foreground softening to an existing `Style` without disturbing other style fields.

**Data flow**: Takes a mutable copy of a `Style`, checks whether `style.fg` is `Some`, replaces that foreground with `soften_status_line_color`, and returns the updated style. Background and modifiers are left unchanged.

**Call relations**: Status-line assembly uses this after theme or fallback style resolution so footer text stays less visually aggressive than full syntax-highlight colors.

*Call graph*: calls 1 internal fn (soften_status_line_color); called by 1 (status_line_from_segments_with_resolver).


##### `soften_status_line_color`  (lines 134–163)

```
fn soften_status_line_color(color: Color) -> Color
```

**Purpose**: Normalizes bright named colors and desaturates RGB colors for footer use.

**Data flow**: Matches on a `Color`. For `Color::Rgb(r,g,b)`, it computes luma with `weighted_luma` and softens each channel with `soften_rgb_channel`; for bright named colors it maps to the non-light equivalent; for white it returns gray; for reset, dark, indexed, and already-normal colors it returns the input unchanged.

**Call relations**: Called only from `soften_status_line_style`, it encapsulates the footer color policy so the rest of the renderer can work with ordinary `Style` values.

*Call graph*: calls 2 internal fn (soften_rgb_channel, weighted_luma); called by 1 (soften_status_line_style); 1 external calls (Rgb).


##### `weighted_luma`  (lines 165–167)

```
fn weighted_luma(r: u8, g: u8, b: u8) -> u16
```

**Purpose**: Computes an integer luma estimate from RGB channels using fixed perceptual weights.

**Data flow**: Converts `r`, `g`, and `b` from `u8` to `u16`, applies weights 77/150/29, divides by 256, and returns the resulting `u16` luma. It is pure and side-effect free.

**Call relations**: RGB softening uses this as the grayscale anchor when blending each channel toward a less saturated footer color.

*Call graph*: called by 1 (soften_status_line_color); 1 external calls (from).


##### `soften_rgb_channel`  (lines 169–177)

```
fn soften_rgb_channel(channel: u8, luma: u16) -> u8
```

**Purpose**: Blends one RGB channel toward the overall luma according to the configured saturation and brightness percentages.

**Data flow**: Takes a single `u8` channel and the precomputed `u16` luma, converts the channel to `u16`, computes a weighted average using `STATUS_LINE_COLOR_SATURATION_PERCENT`, applies `STATUS_LINE_COLOR_BRIGHTNESS_PERCENT`, rounds with `+50`, and returns the final `u8` channel value.

**Call relations**: This is the per-channel primitive used by `soften_status_line_color` for `Color::Rgb` inputs.

*Call graph*: called by 1 (soften_status_line_color); 1 external calls (from).


##### `tests::line_text`  (lines 185–190)

```
fn line_text(line: &Line<'static>) -> String
```

**Purpose**: Extracts the concatenated plain text from a rendered `Line` for assertions.

**Data flow**: Reads `line.spans`, maps each span to `span.content`, concatenates them into a `String`, and returns it. It does not inspect styling beyond content.

**Call relations**: Test cases use this helper to verify ordering and separator insertion independently of color/modifier assertions.


##### `tests::status_line_segments_preserve_order_and_plain_text`  (lines 193–212)

```
fn status_line_segments_preserve_order_and_plain_text()
```

**Purpose**: Verifies that multiple segments render in input order with separators and fallback accent colors when no theme style is resolved.

**Data flow**: Builds a line from model/path/branch segments using a resolver that always returns `None`, then asserts the concatenated text and foreground colors/modifiers of the resulting spans.

**Call relations**: This test exercises the main assembly helper’s ordering, separator placement, and fallback-style path.

*Call graph*: calls 1 internal fn (status_line_from_segments_with_resolver); 2 external calls (assert!, assert_eq!).


##### `tests::status_line_segments_dim_separators_and_use_theme_styles_first`  (lines 215–234)

```
fn status_line_segments_dim_separators_and_use_theme_styles_first()
```

**Purpose**: Checks that explicit theme styles override fallback colors and that separators remain dimmed independently.

**Data flow**: Constructs a two-segment line with a resolver returning red for `StatusLineAccent::Model`, then asserts the first span is red, the separator is dim, and the second span falls back to green.

**Call relations**: It validates the precedence order inside the resolver-aware assembly path: theme style first, fallback second, separator styling separate.

*Call graph*: calls 1 internal fn (status_line_from_segments_with_resolver); 2 external calls (assert!, assert_eq!).


##### `tests::status_line_segments_soften_rgb_theme_styles_without_dimming_text`  (lines 238–248)

```
fn status_line_segments_soften_rgb_theme_styles_without_dimming_text()
```

**Purpose**: Confirms that RGB theme colors are softened numerically rather than replaced with dim text.

**Data flow**: Supplies a single model segment and a resolver returning `Color::Rgb(255, 0, 0)`, then asserts the rendered foreground becomes the softened RGB value and that the text is not dimmed.

**Call relations**: This test specifically covers the RGB branch of the color-softening logic used during themed rendering.

*Call graph*: calls 1 internal fn (status_line_from_segments_with_resolver); 2 external calls (assert!, assert_eq!).


##### `tests::status_line_segments_can_disable_theme_colors`  (lines 251–268)

```
fn status_line_segments_can_disable_theme_colors()
```

**Purpose**: Ensures the renderer can ignore theme/fallback colors entirely and emit uniformly dim text.

**Data flow**: Builds a line with `use_theme_colors` set to `false`, even though the resolver returns red, then asserts all spans have no foreground color and carry the dim modifier.

**Call relations**: It covers the non-themed branch in the assembly helper, showing that the resolver is effectively bypassed for visible styling.

*Call graph*: calls 1 internal fn (status_line_from_segments_with_resolver); 2 external calls (assert!, assert_eq!).


##### `tests::pull_request_number_uses_link_style`  (lines 271–287)

```
fn pull_request_number_uses_link_style()
```

**Purpose**: Verifies that pull request segments are underlined in addition to their normal status-line styling.

**Data flow**: Creates a one-item line for `StatusLineItem::PullRequestNumber` with theme colors disabled and asserts the resulting span is dim and underlined.

**Call relations**: This test targets the special-case branch in status-line assembly that adds `UNDERLINED` for PR numbers.

*Call graph*: calls 1 internal fn (status_line_from_segments_with_resolver); 2 external calls (assert!, assert_eq!).


##### `tests::status_line_segments_return_none_when_empty`  (lines 290–299)

```
fn status_line_segments_return_none_when_empty()
```

**Purpose**: Checks that empty segment input suppresses rendering entirely.

**Data flow**: Calls the resolver-aware helper with an empty vector and asserts the return value is `None`.

**Call relations**: It validates the helper’s final empty-span guard, which callers rely on to omit the status line when nothing is available.

*Call graph*: 1 external calls (assert_eq!).


### `tui/src/chatwidget/goal_status.rs`

`domain_logic` · `cross-cutting`

This file is the status-line representation layer for thread goals. `GoalStatusState` stores the last observed `AppThreadGoal` plus the `Instant` when it was observed. Its `indicator` method clones the goal and, when the goal is active and there is an active turn start time, adds elapsed wall-clock time since the later of `observed_at` and the turn start. That prevents idle time before the current turn from being counted while still letting the active indicator tick forward locally between server updates.

The free function `goal_status_indicator_from_app_goal` converts a goal into a `GoalStatusIndicator` enum variant. Active goals include usage text from `active_goal_usage`; paused, blocked, and usage-limited goals map to simple marker variants; budget-limited goals include budget usage from `stopped_goal_budget_usage`; and complete goals include optional usage text from `completed_goal_usage`. The formatting rules intentionally differ by state: active goals prefer token budget usage when a budget exists, otherwise elapsed time; stopped budget-limited goals omit usage entirely when there is no budget; completed goals show total tokens when budgeted, otherwise elapsed time.

The test module verifies these formatting choices and the active-time accumulation logic, including the edge case where the active turn starts after the goal snapshot was observed.

#### Function details

##### `GoalStatusState::new`  (lines 18–20)

```
fn new(goal: AppThreadGoal, observed_at: Instant) -> Self
```

**Purpose**: Creates a cached goal-status snapshot paired with the instant it was observed. This snapshot is later used to derive a live-updating indicator.

**Data flow**: Takes an `AppThreadGoal` and `Instant`, stores them in `GoalStatusState { goal, observed_at }`, and returns the new struct.

**Call relations**: Constructed when goal state is updated, and also by the test helper `tests::active_goal_state` to exercise indicator behavior.

*Call graph*: called by 2 (active_goal_state, on_thread_goal_updated).


##### `GoalStatusState::is_active`  (lines 22–24)

```
fn is_active(&self) -> bool
```

**Purpose**: Reports whether the cached goal is currently active. It is a simple status predicate over the stored goal.

**Data flow**: Reads `self.goal.status` and returns true when it equals `AppThreadGoalStatus::Active`.

**Call relations**: This is a pure helper on the cached state, used wherever callers need to branch on active-vs-nonactive goal behavior.


##### `GoalStatusState::indicator`  (lines 26–42)

```
fn indicator(
        &self,
        now: Instant,
        active_turn_started_at: Option<Instant>,
    ) -> Option<GoalStatusIndicator>
```

**Purpose**: Builds the current `GoalStatusIndicator`, augmenting active goals with locally elapsed time since observation or turn start. It ensures active usage can advance in the UI without waiting for another backend update.

**Data flow**: Clones `self.goal` into a mutable local. If the goal status is `Active` and `active_turn_started_at` is provided, it computes `baseline = max(self.observed_at, active_turn_started_at)`, derives elapsed seconds with `now.saturating_duration_since(baseline).as_secs()`, converts that to `i64` with saturation fallback, and adds it to `goal.time_used_seconds` using `saturating_add`. It then passes the adjusted goal to `goal_status_indicator_from_app_goal` and returns the resulting `Option<GoalStatusIndicator>`.

**Call relations**: This is the main behavior method on `GoalStatusState`. It delegates final enum construction and usage-string formatting to `goal_status_indicator_from_app_goal`.

*Call graph*: calls 1 internal fn (goal_status_indicator_from_app_goal); 4 external calls (clone, max, saturating_duration_since, try_from).


##### `goal_status_indicator_from_app_goal`  (lines 45–66)

```
fn goal_status_indicator_from_app_goal(
    goal: &AppThreadGoal,
) -> Option<GoalStatusIndicator>
```

**Purpose**: Converts an application-level goal into the compact bottom-pane indicator enum, selecting the correct variant and usage text strategy for each status. It is the central mapping from backend goal state to UI indicator state.

**Data flow**: Matches `goal.status`. For `Active`, returns `GoalStatusIndicator::Active` with usage from `active_goal_usage(goal.token_budget, goal.tokens_used, goal.time_used_seconds)`. For `Paused`, `Blocked`, and `UsageLimited`, returns the corresponding marker variants. For `BudgetLimited`, returns `BudgetLimited` with usage from `stopped_goal_budget_usage`. For `Complete`, returns `Complete` with `Some(completed_goal_usage(...))`.

**Call relations**: Called by `GoalStatusState::indicator` after any local time adjustment. It delegates string formatting to the three local usage helpers.

*Call graph*: calls 3 internal fn (active_goal_usage, completed_goal_usage, stopped_goal_budget_usage); called by 1 (indicator).


##### `active_goal_usage`  (lines 68–82)

```
fn active_goal_usage(
    token_budget: Option<i64>,
    tokens_used: i64,
    time_used_seconds: i64,
) -> Option<String>
```

**Purpose**: Formats the usage text for an active goal, preferring token-budget progress when a budget exists and otherwise showing elapsed time. This keeps the active indicator focused on the most relevant live constraint.

**Data flow**: Accepts optional `token_budget`, `tokens_used`, and `time_used_seconds`. If `token_budget` is `Some`, returns `Some("{used} / {budget}")` using `format_tokens_compact` for both values. Otherwise returns `Some(format_goal_elapsed_seconds(time_used_seconds))`.

**Call relations**: Used only by `goal_status_indicator_from_app_goal` for active goals. Its behavior is covered by dedicated tests.

*Call graph*: calls 1 internal fn (format_goal_elapsed_seconds); called by 1 (goal_status_indicator_from_app_goal); 1 external calls (format!).


##### `stopped_goal_budget_usage`  (lines 84–92)

```
fn stopped_goal_budget_usage(token_budget: Option<i64>, tokens_used: i64) -> Option<String>
```

**Purpose**: Formats usage text for a budget-limited stopped goal, but only when a token budget exists. Unbudgeted stopped goals intentionally show no usage string.

**Data flow**: Takes optional `token_budget` and `tokens_used`. If a budget exists, maps it to `Some("{used} / {budget} tokens")` using compact token formatting; otherwise returns `None`.

**Call relations**: Used by `goal_status_indicator_from_app_goal` for `BudgetLimited` goals. Tests verify both the budgeted and unbudgeted cases.

*Call graph*: called by 1 (goal_status_indicator_from_app_goal).


##### `completed_goal_usage`  (lines 94–104)

```
fn completed_goal_usage(
    token_budget: Option<i64>,
    tokens_used: i64,
    time_used_seconds: i64,
) -> String
```

**Purpose**: Formats the usage text for a completed goal, showing total tokens when the goal was budgeted and elapsed time otherwise. This differs from active formatting because completion emphasizes final totals.

**Data flow**: Accepts optional `token_budget`, `tokens_used`, and `time_used_seconds`. If `token_budget.is_some()`, returns `"{tokens_used} tokens"` with compact formatting; otherwise returns `format_goal_elapsed_seconds(time_used_seconds)`.

**Call relations**: Used by `goal_status_indicator_from_app_goal` for completed goals. Its two formatting branches are covered by tests.

*Call graph*: calls 1 internal fn (format_goal_elapsed_seconds); called by 1 (goal_status_indicator_from_app_goal); 1 external calls (format!).


##### `tests::active_goal_usage_prefers_token_budget`  (lines 119–128)

```
fn active_goal_usage_prefers_token_budget()
```

**Purpose**: Verifies that active-goal usage formatting chooses token progress over elapsed time when a budget is present.

**Data flow**: Calls `active_goal_usage(Some(50_000), 12_500, 90)` and asserts that the returned value is `Some("12.5K / 50K".to_string())`.

**Call relations**: This unit test exercises the budgeted branch of `active_goal_usage`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::active_goal_usage_reports_time_without_budget`  (lines 131–139)

```
fn active_goal_usage_reports_time_without_budget()
```

**Purpose**: Verifies that active-goal usage falls back to elapsed time when no token budget exists.

**Data flow**: Calls `active_goal_usage(None, 12_500, 120)` and asserts that the result is `Some("2m".to_string())`.

**Call relations**: This unit test covers the unbudgeted branch of `active_goal_usage`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::stopped_goal_budget_usage_reports_budgeted_tokens`  (lines 142–147)

```
fn stopped_goal_budget_usage_reports_budgeted_tokens()
```

**Purpose**: Checks the exact string formatting for budget-limited stopped goals with a token budget.

**Data flow**: Calls `stopped_goal_budget_usage(Some(50_000), 63_876)` and asserts that the result is `Some("63.9K / 50K tokens".to_string())`.

**Call relations**: This test validates the positive-output branch of `stopped_goal_budget_usage`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::stopped_goal_budget_usage_omits_unbudgeted_usage`  (lines 150–155)

```
fn stopped_goal_budget_usage_omits_unbudgeted_usage()
```

**Purpose**: Ensures that stopped-goal budget usage is omitted entirely when there is no token budget.

**Data flow**: Calls `stopped_goal_budget_usage(None, 12_500)` and asserts that the result is `None`.

**Call relations**: This test validates the `None` branch of `stopped_goal_budget_usage`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::completed_goal_usage_reports_tokens_when_budgeted`  (lines 158–167)

```
fn completed_goal_usage_reports_tokens_when_budgeted()
```

**Purpose**: Verifies that completed-goal usage reports total tokens rather than elapsed time when the goal had a budget.

**Data flow**: Calls `completed_goal_usage(Some(50_000), 40_000, 120)` and asserts that the result is `"40K tokens".to_string()`.

**Call relations**: This test covers the budgeted branch of `completed_goal_usage`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::completed_goal_usage_reports_time_without_token_budget`  (lines 170–178)

```
fn completed_goal_usage_reports_time_without_token_budget()
```

**Purpose**: Verifies that completed-goal usage reports elapsed time when no token budget exists.

**Data flow**: Calls `completed_goal_usage(None, 40_000, 36_720)` and asserts that the result is `"10h 12m".to_string()`.

**Call relations**: This test covers the unbudgeted branch of `completed_goal_usage`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::active_goal_status_includes_current_turn_elapsed_time`  (lines 181–194)

```
fn active_goal_status_includes_current_turn_elapsed_time()
```

**Purpose**: Checks that an active goal indicator includes additional elapsed time from the current turn after the snapshot was observed.

**Data flow**: Creates `observed_at = Instant::now()`, builds a state with `active_goal_state(observed_at, 60)`, then calls `state.indicator(observed_at + 60s, Some(observed_at - 120s))` and asserts that the result is `Some(GoalStatusIndicator::Active { usage: Some("2m".to_string()) })`.

**Call relations**: This test exercises `GoalStatusState::indicator` with a turn that started before observation, confirming that elapsed time since observation is added.

*Call graph*: 3 external calls (now, assert_eq!, active_goal_state).


##### `tests::active_goal_status_does_not_count_idle_time_before_turn_start`  (lines 197–211)

```
fn active_goal_status_does_not_count_idle_time_before_turn_start()
```

**Purpose**: Checks that active-goal elapsed time does not include idle time before the current turn actually started.

**Data flow**: Creates `observed_at = Instant::now()`, sets `active_turn_started_at = observed_at + 120s`, builds a state with `active_goal_state(observed_at, 60)`, then calls `state.indicator(active_turn_started_at + 60s, Some(active_turn_started_at))` and asserts the same `2m` active indicator result.

**Call relations**: This test validates the `max(observed_at, active_turn_started_at)` baseline logic inside `GoalStatusState::indicator`.

*Call graph*: 4 external calls (from_secs, now, assert_eq!, active_goal_state).


##### `tests::active_goal_state`  (lines 213–227)

```
fn active_goal_state(observed_at: Instant, time_used_seconds: i64) -> GoalStatusState
```

**Purpose**: Builds a minimal active `GoalStatusState` fixture for the tests in this module. It standardizes the goal fields so tests can focus on time-accounting behavior.

**Data flow**: Takes `observed_at` and `time_used_seconds`, constructs an `AppThreadGoal` with fixed thread id, objective, active status, no token budget, zero tokens used, and fixed timestamps, then returns `GoalStatusState::new(goal, observed_at)`.

**Call relations**: This helper is called by the active-indicator tests to avoid repeating fixture construction.

*Call graph*: calls 1 internal fn (new).


### `tui/src/chatwidget/rate_limits.rs`

`domain_logic` · `cross-cutting`

This file contains both pure helpers and `ChatWidget` state transitions around rate limits. `RateLimitWarningState` tracks which warning thresholds have already been crossed for primary and secondary windows so the UI emits each warning once as usage rises through 75%, 90%, and 95%; hitting exactly 100% suppresses these generic warnings because a stronger limit-reached flow presumably applies elsewhere. Window labels are derived from approximate durations such as 5h, daily, weekly, monthly, and annual, with fallback labels for unknown windows.

On the widget side, `on_rate_limit_snapshot` and `on_rolling_rate_limit_snapshot` feed a shared `on_rate_limit_snapshot_from` path. That method preserves metadata across sparse rolling updates, updates `plan_type`, records codex-specific `rate_limit_reached_type`, computes threshold warnings only for the `codex` limit id, and stores a rendered display snapshot keyed by limit id. It also decides whether to queue a lower-cost model nudge: usage must be high, workspace credits absent, the notice not hidden, the current model not already the nudge model, and the prompt not already shown. Warnings are appended to history and trigger redraws; clearing snapshots resets stored displays and codex limit state.

The rest of the file manages prompt surfaces and related state: selecting a cheaper model sends override/update events without persistence, owner-credit nudges open yes/no popups and track an in-flight email request, completion of that request emits a success/cooldown/failure info message, and hiding the model-switch prompt persists a config-backed suppression flag. Several methods are currently stubs (`stop_rate_limit_poller`) or intentionally minimal wrappers.

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

**Purpose**: Determines which new threshold-crossing warning messages should be emitted for primary and secondary usage windows, while ensuring each threshold is announced only once. It suppresses generic warnings entirely when either limit has already reached 100%.

**Data flow**: Inputs are mutable warning-state indices plus optional used percentages and window durations for secondary and primary limits. It reads and advances `secondary_index` and `primary_index` while percentages exceed configured thresholds, formats at most one warning per side using `limit_label_for_window`, and returns a `Vec<String>` of newly triggered warning messages. The persistent output is the updated indices, which prevent duplicate warnings on later snapshots.

**Call relations**: This helper is called from `ChatWidget::on_rate_limit_snapshot_from` for codex snapshots. That caller uses the returned strings to append warning history cells and redraw the UI.

*Call graph*: calls 1 internal fn (limit_label_for_window); 3 external calls (new, format!, matches!).


##### `limit_label_for_window`  (lines 76–80)

```
fn limit_label_for_window(window_minutes: Option<i64>, is_secondary: bool) -> String
```

**Purpose**: Produces a human-readable label for a rate-limit window, preferring recognized durations and falling back to generic primary/secondary labels. It hides the duration-classification details from warning generation.

**Data flow**: It takes `window_minutes: Option<i64>` and `is_secondary: bool`, tries `get_limits_duration` when minutes are present, and otherwise returns `fallback_limit_label(is_secondary)` as an owned `String`.

**Call relations**: It is used by `RateLimitWarningState::take_warnings` to phrase warning text consistently for both primary and secondary limits.

*Call graph*: called by 1 (take_warnings).


##### `get_limits_duration`  (lines 82–105)

```
fn get_limits_duration(windows_minutes: i64) -> Option<String>
```

**Purpose**: Classifies a minute count into one of a small set of approximate named windows such as `5h`, `daily`, `weekly`, `monthly`, or `annual`. Values outside those tolerance bands return `None`.

**Data flow**: It accepts `windows_minutes: i64`, clamps negatives to zero, compares the value against several expected durations using `is_approximate_window`, and returns `Some(String)` for the first matching label or `None` if no standard window fits.

**Call relations**: This helper is called by `limit_label_for_window` as the first-choice label source.

*Call graph*: calls 1 internal fn (is_approximate_window).


##### `fallback_limit_label`  (lines 107–113)

```
fn fallback_limit_label(is_secondary: bool) -> &'static str
```

**Purpose**: Returns the generic label text used when a rate-limit window duration cannot be recognized. It distinguishes primary from secondary usage wording.

**Data flow**: It takes `is_secondary: bool` and returns either the `SECONDARY_LIMIT_FALLBACK_LABEL` or `PRIMARY_LIMIT_FALLBACK_LABEL` static string.

**Call relations**: It supports `limit_label_for_window` when no approximate duration label is available.


##### `is_approximate_window`  (lines 115–119)

```
fn is_approximate_window(minutes: i64, expected_minutes: i64) -> bool
```

**Purpose**: Checks whether a minute count falls within a ±5% tolerance band around an expected duration. This allows slightly noisy server durations to still map to named windows.

**Data flow**: It takes `minutes` and `expected_minutes`, converts both to `f64`, compares against 95%-105% bounds, and returns a boolean.

**Call relations**: It is used internally by `get_limits_duration` for each candidate duration bucket.

*Call graph*: called by 1 (get_limits_duration).


##### `app_server_rate_limit_error_kind`  (lines 136–147)

```
fn app_server_rate_limit_error_kind(
    info: &AppServerCodexErrorInfo,
) -> Option<RateLimitErrorKind>
```

**Purpose**: Classifies selected app-server `CodexErrorInfo` variants into the TUI’s coarse rate-limit error categories. It recognizes overloaded, usage-limit, and generic 429-too-many-failed-attempts cases.

**Data flow**: It takes a borrowed `AppServerCodexErrorInfo`, pattern-matches specific variants and fields, and returns `Some(RateLimitErrorKind)` for recognized rate-limit-like errors or `None` otherwise.

**Call relations**: This helper provides a normalized error categorization for higher-level error handling elsewhere in the chat widget.


##### `is_app_server_cyber_policy_error`  (lines 149–151)

```
fn is_app_server_cyber_policy_error(info: &AppServerCodexErrorInfo) -> bool
```

**Purpose**: Detects whether an app-server error is specifically the `CyberPolicy` variant. It is a narrow predicate used to separate policy failures from ordinary rate-limit failures.

**Data flow**: It takes a borrowed `AppServerCodexErrorInfo`, applies a `matches!` check, and returns `true` only for `CyberPolicy`.

**Call relations**: This helper is intended for callers that need to branch on policy-specific failures without re-matching the full error enum.

*Call graph*: 1 external calls (matches!).


##### `ChatWidget::on_rate_limit_snapshot`  (lines 160–162)

```
fn on_rate_limit_snapshot(&mut self, snapshot: Option<RateLimitSnapshot>)
```

**Purpose**: Processes a full account-usage rate-limit snapshot through the shared snapshot ingestion path. It marks the source as a complete account read.

**Data flow**: It takes `&mut self` and `snapshot: Option<RateLimitSnapshot>`, forwards both to `on_rate_limit_snapshot_from` with `RateLimitSnapshotSource::AccountUsage`, and returns unit.

**Call relations**: This is the public/full-snapshot entrypoint; it delegates all substantive work to `ChatWidget::on_rate_limit_snapshot_from`.

*Call graph*: calls 1 internal fn (on_rate_limit_snapshot_from).


##### `ChatWidget::on_rolling_rate_limit_snapshot`  (lines 164–167)

```
fn on_rolling_rate_limit_snapshot(&mut self, snapshot: RateLimitSnapshot)
```

**Purpose**: Processes a sparse rolling rate-limit update while preserving metadata learned from earlier full snapshots. It marks the source so the shared ingestion path knows to retain missing fields.

**Data flow**: It takes `&mut self` and a concrete `RateLimitSnapshot`, wraps it in `Some`, forwards it to `on_rate_limit_snapshot_from` with `RateLimitSnapshotSource::RollingUpdate`, and returns unit.

**Call relations**: Like the full-snapshot entrypoint, it delegates to `ChatWidget::on_rate_limit_snapshot_from`; the source flag changes preservation behavior for credits and individual-limit metadata.

*Call graph*: calls 1 internal fn (on_rate_limit_snapshot_from).


##### `ChatWidget::on_rate_limit_snapshot_from`  (lines 169–284)

```
fn on_rate_limit_snapshot_from(
        &mut self,
        snapshot: Option<RateLimitSnapshot>,
        source: RateLimitSnapshotSource,
    )
```

**Purpose**: Ingests one rate-limit snapshot update, merges it with preserved metadata, updates stored displays and codex-specific state, emits threshold warnings, and queues a lower-cost model prompt when usage is high. It is the core rate-limit state machine for the widget.

**Data flow**: Inputs are `&mut self`, an optional `RateLimitSnapshot`, and a `RateLimitSnapshotSource`. When a snapshot is present, it derives `limit_id`/`limit_label`, fills missing credits from `rate_limit_snapshots_by_limit_id`, optionally preserves `individual_limit` on rolling updates, updates `plan_type`, records `codex_rate_limit_reached_type` for the codex limit, computes warnings via `rate_limit_warnings.take_warnings`, checks high-usage/workspace-credit/prompt-hidden/current-model conditions to possibly set `rate_limit_switch_prompt = Pending`, builds a display via `rate_limit_snapshot_display_for_limit(Local::now())`, stores it in `rate_limit_snapshots_by_limit_id`, and appends warning history cells plus redraw if needed. When `snapshot` is `None`, it clears stored snapshots and codex reached-type. In all cases it refreshes the status line.

**Call relations**: This function is called by both `ChatWidget::on_rate_limit_snapshot` and `ChatWidget::on_rolling_rate_limit_snapshot`. It consults `ChatWidget::rate_limit_switch_prompt_hidden` to respect user suppression and prepares state later consumed by `ChatWidget::maybe_show_pending_rate_limit_prompt`.

*Call graph*: calls 1 internal fn (rate_limit_switch_prompt_hidden); called by 2 (on_rate_limit_snapshot, on_rolling_rate_limit_snapshot); 4 external calls (now, new_warning_event, matches!, vec!).


##### `ChatWidget::stop_rate_limit_poller`  (lines 286–286)

```
fn stop_rate_limit_poller(&mut self)
```

**Purpose**: Stub hook for stopping any background rate-limit polling. The current implementation intentionally does nothing.

**Data flow**: It takes `&mut self`, performs no reads or writes, and returns unit.

**Call relations**: It is invoked by `ChatWidget::prefetch_rate_limits`, preserving a lifecycle hook even though polling is not currently implemented here.

*Call graph*: called by 1 (prefetch_rate_limits).


##### `ChatWidget::prefetch_rate_limits`  (lines 289–291)

```
fn prefetch_rate_limits(&mut self)
```

**Purpose**: Entry point for prefetching rate limits that currently only stops any existing poller. It exists mainly as a lifecycle placeholder and test-visible hook.

**Data flow**: It takes `&mut self`, calls `stop_rate_limit_poller`, and returns unit.

**Call relations**: This method delegates entirely to `ChatWidget::stop_rate_limit_poller`; callers can use it without knowing whether polling is implemented.

*Call graph*: calls 1 internal fn (stop_rate_limit_poller).


##### `ChatWidget::should_prefetch_rate_limits`  (lines 294–296)

```
fn should_prefetch_rate_limits(&self) -> bool
```

**Purpose**: Determines whether rate-limit prefetching is relevant for the current session. It requires an OpenAI-auth-backed provider and a signed-in ChatGPT account.

**Data flow**: It reads `self.config.model_provider.requires_openai_auth` and `self.has_chatgpt_account`, combines them with `&&`, and returns the resulting boolean.

**Call relations**: This predicate is intended to gate whether callers bother invoking prefetch behavior.


##### `ChatWidget::lower_cost_preset`  (lines 298–304)

```
fn lower_cost_preset(&self) -> Option<ModelPreset>
```

**Purpose**: Looks up the advertised lower-cost model preset used by the rate-limit switch nudge. It specifically searches for the visible preset whose model slug matches `gpt-5.4-mini`.

**Data flow**: It reads the model catalog via `try_list_models()`, returns `None` on catalog failure, otherwise scans presets for one with `show_in_picker` and `model == NUDGE_MODEL_SLUG`, cloning and returning that `ModelPreset` if found.

**Call relations**: It is called by `ChatWidget::maybe_show_pending_rate_limit_prompt` to decide whether a concrete switch target exists before opening the prompt.

*Call graph*: called by 1 (maybe_show_pending_rate_limit_prompt).


##### `ChatWidget::rate_limit_switch_prompt_hidden`  (lines 306–311)

```
fn rate_limit_switch_prompt_hidden(&self) -> bool
```

**Purpose**: Reads the user-configured suppression flag for the model-switch nudge. Missing config defaults to visible.

**Data flow**: It reads `self.config.notices.hide_rate_limit_model_nudge`, unwraps it with `false` as the default, and returns the boolean.

**Call relations**: This helper is consulted both when snapshots decide whether to queue a prompt and when pending prompts are about to be shown.

*Call graph*: called by 2 (maybe_show_pending_rate_limit_prompt, on_rate_limit_snapshot_from).


##### `ChatWidget::maybe_show_pending_rate_limit_prompt`  (lines 313–330)

```
fn maybe_show_pending_rate_limit_prompt(&mut self)
```

**Purpose**: Shows the lower-cost model nudge only when the prompt is pending, not hidden, and a suitable preset exists. Otherwise it clears or leaves prompt state appropriately.

**Data flow**: It reads the hidden flag and current `rate_limit_switch_prompt` state. If hidden, it writes `Idle` and returns; if not `Pending`, it returns unchanged; if pending, it tries `lower_cost_preset()`, opens the prompt and writes `Shown` on success, or writes `Idle` if no preset is available.

**Call relations**: This method consumes the `Pending` state set by `ChatWidget::on_rate_limit_snapshot_from`. When a preset is available it delegates to `ChatWidget::open_rate_limit_switch_prompt` to build the actual selection UI.

*Call graph*: calls 3 internal fn (lower_cost_preset, open_rate_limit_switch_prompt, rate_limit_switch_prompt_hidden); 1 external calls (matches!).


##### `ChatWidget::open_rate_limit_switch_prompt`  (lines 332–408)

```
fn open_rate_limit_switch_prompt(&mut self, preset: ModelPreset)
```

**Purpose**: Builds and displays the popup that offers switching to a cheaper model, keeping the current model, or hiding future nudges. The switch option sends both turn-context override and immediate UI update events.

**Data flow**: It takes `&mut self` and a `ModelPreset`, extracts the target model slug and default reasoning effort, constructs three `SelectionItem`s with action closures: switch sends `AppEvent::CodexOp(AppCommand::override_turn_context(...))`, `AppEvent::UpdateModel`, and `AppEvent::UpdateReasoningEffort`; keep sends nothing; never-show-again sends hide/persist events. It derives a description from the preset, wraps the items in `SelectionViewParams`, and writes the popup into `self.bottom_pane`.

**Call relations**: It is called only by `ChatWidget::maybe_show_pending_rate_limit_prompt` once a pending prompt is ready to surface. Its action closures integrate with the broader app event loop rather than mutating all state directly.

*Call graph*: called by 1 (maybe_show_pending_rate_limit_prompt); 4 external calls (default, new, format!, vec!).


##### `ChatWidget::open_workspace_owner_nudge_prompt`  (lines 410–456)

```
fn open_workspace_owner_nudge_prompt(
        &mut self,
        credit_type: AddCreditsNudgeCreditType,
    )
```

**Purpose**: Shows a yes/no confirmation popup asking whether to notify the workspace owner about exhausted credits or request a usage-limit increase. It refuses to open if an email request is already in flight.

**Data flow**: Inputs are `&mut self` and an `AddCreditsNudgeCreditType`. It first reads `add_credits_nudge_email_in_flight` and returns early if set. Otherwise it selects title/prompt text based on credit type, builds `SelectionItem`s for Yes and No, where Yes sends `AppEvent::SendAddCreditsNudgeEmail { credit_type }`, and installs the selection view into `bottom_pane` with the No option preselected.

**Call relations**: This popup is part of the rate-limit/credits UX and pairs with `start_add_credits_nudge_email_request` and `finish_add_credits_nudge_email_request`, which track and resolve the resulting email request.

*Call graph*: 2 external calls (default, vec!).


##### `ChatWidget::start_add_credits_nudge_email_request`  (lines 458–464)

```
fn start_add_credits_nudge_email_request(
        &mut self,
        credit_type: AddCreditsNudgeCreditType,
    ) -> bool
```

**Purpose**: Marks an add-credits or limit-increase email request as in flight. It currently always succeeds and returns `true`.

**Data flow**: It takes `&mut self` and a `credit_type`, writes `self.add_credits_nudge_email_in_flight = Some(credit_type)`, and returns `true`.

**Call relations**: This method establishes the in-flight state later consumed by `ChatWidget::finish_add_credits_nudge_email_request` and checked by `ChatWidget::open_workspace_owner_nudge_prompt`.


##### `ChatWidget::finish_add_credits_nudge_email_request`  (lines 466–501)

```
fn finish_add_credits_nudge_email_request(
        &mut self,
        result: Result<AddCreditsNudgeEmailStatus, String>,
    )
```

**Purpose**: Completes an owner-notification or limit-increase request by clearing in-flight state and appending a user-facing success, cooldown, or failure message. The wording depends on both request type and result.

**Data flow**: It takes `&mut self` and `result: Result<AddCreditsNudgeEmailStatus, String>`. It removes `add_credits_nudge_email_in_flight`, defaulting to `Credits` if absent, matches `(credit_type, result)` into a fixed message string, appends an info history cell with `history_cell::new_info_event`, requests redraw, and returns unit.

**Call relations**: This is the completion half of the owner-nudge flow started by `ChatWidget::start_add_credits_nudge_email_request`.

*Call graph*: 1 external calls (new_info_event).


##### `ChatWidget::set_rate_limit_switch_prompt_hidden`  (lines 503–508)

```
fn set_rate_limit_switch_prompt_hidden(&mut self, hidden: bool)
```

**Purpose**: Persists the local hidden/not-hidden flag for future rate-limit model nudges and clears any pending/shown prompt when hiding is enabled. It updates config-backed notice state directly.

**Data flow**: It takes `&mut self` and `hidden: bool`, writes `self.config.notices.hide_rate_limit_model_nudge = Some(hidden)`, and if `hidden` is true also writes `self.rate_limit_switch_prompt = RateLimitSwitchPromptState::Idle`.

**Call relations**: This setter underlies the never-show-again action created by `ChatWidget::open_rate_limit_switch_prompt` and influences later checks in snapshot ingestion and prompt display.


### `tui/src/chatwidget/review.rs`

`data_model` · `interactive UI`

This file defines a single internal state struct, `ReviewState`, used by `ChatWidget` to remember review-related UI and workflow context across interactions. The struct derives `Debug` and `Default`, making it easy to initialize alongside the widget and inspect during debugging. Its `recent_auto_review_denials` field stores a `RecentAutoReviewDenials` value, which preserves recent automatic-review rejection history so the widget can avoid repeatedly triggering or can explain why review was denied. The `is_review_mode` boolean is the immediate mode switch used by the widget to alter layout and banners when the user is in a review flow. The `pre_review_token_info` field stores an `Option<Option<TokenUsageInfo>>`, which is a deliberate tri-state snapshot: it can represent “no snapshot taken yet,” “snapshot taken and there was no token info,” or “snapshot taken with concrete token usage.” That nuance matters when restoring the prior token-usage display after review mode exits. There are no methods here; the file’s value is in making review-mode state explicit and grouped, rather than scattering related flags and snapshots across the larger widget implementation.


### `tui/src/chatwidget/session_header.rs`

`data_model` · `cross-cutting UI state during model/session refresh`

This file contains a minimal state holder for the session header: a `SessionHeader` struct with a single `model: String` field. The type is intentionally narrow and keeps no rendering logic, layout state, or derived metadata; it simply preserves the model label that other `ChatWidget` code wants shown in the header.

The constructor takes ownership of a `String` and stores it directly. The setter is slightly defensive: it compares the incoming `&str` against the existing string and only allocates a new `String` when the text actually changes. That avoids unnecessary churn when repeated refreshes recompute the same effective model and call into the header update path.

Because this file is so small, its importance is mostly architectural: it isolates header-specific state from the larger widget and gives model-refresh code a stable target to mutate whenever collaboration mode or model selection changes.

#### Function details

##### `SessionHeader::new`  (lines 6–8)

```
fn new(model: String) -> Self
```

**Purpose**: Constructs a `SessionHeader` with an initial model label. It is the sole initializer for the header’s stored model string.

**Data flow**: It takes ownership of a `String` named `model` and returns `SessionHeader { model }`. It reads no external state and writes no side effects.

**Call relations**: This constructor is used when a larger widget/header structure is first assembled. After creation, later refresh paths update the same field through `SessionHeader::set_model` rather than rebuilding the header.

*Call graph*: called by 1 (new_with_op_target).


##### `SessionHeader::set_model`  (lines 11–15)

```
fn set_model(&mut self, model: &str)
```

**Purpose**: Updates the stored model text only when the new value differs from the current one. This avoids needless string replacement on no-op refreshes.

**Data flow**: It accepts `&mut self` and a `&str` model name, compares it to `self.model`, and if different replaces the field with `model.to_string()`. It returns nothing and mutates only the internal `model` field.

**Call relations**: This method is the mutation point used by higher-level model refresh logic. It performs no delegation and serves as the leaf update operation for header model text.


### `tui/src/chatwidget/status_controls.rs`

`orchestration` · `status updates, setup popups, async status refresh completion, and `/status` output`

This file sits between status rendering helpers and the rest of `ChatWidget`. The basic setters update the current status header/details, footer status line, status-line hyperlink, and active-agent label. `set_status` does a little normalization before storing state: empty details are dropped, leading whitespace is trimmed, and details can optionally have their first letter capitalized before being written into both `status_state` and the bottom pane. If the configured terminal title includes status-derived items, changing status also triggers a broader status-surface refresh.

The setup methods manage two interactive configuration flows. Status-line setup simply logs cancellation or stores the selected `StatusLineItem` ids and color preference before refreshing. Terminal-title setup additionally supports preview mode by snapshotting the original config the first time preview is invoked, applying temporary selections, and restoring the snapshot on cancel.

For async status data, the file stores git branch and git summary results only when they correspond to the currently pending cwd, dropping stale responses after directory changes. `/status` output generation gathers token usage, collaboration mode, effective reasoning effort, rate-limit snapshots, account/plan/thread metadata, and agent-summary text, then creates a history cell plus an optional refresh handle for later rate-limit updates. Preview-data helpers expose live or placeholder values for setup UIs, while small accessors compute context-window percentages, total usage, human-readable rate-limit labels, and reasoning-effort labels.

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

**Purpose**: Updates the current status header/details in both internal status state and the bottom pane, normalizing optional details text first. If the terminal title configuration references status/run-state items, it also refreshes broader status surfaces.

**Data flow**: Inputs are `header`, optional `details`, a `StatusDetailsCapitalization` mode, and `details_max_lines`. It filters out empty details, trims leading whitespace, optionally capitalizes the first character, stores a `StatusIndicatorState` in `self.status_state`, forwards the normalized values to `bottom_pane.update_status` using preserved capitalization, checks `self.config.tui_terminal_title` for `run-state` or `status`, and conditionally calls `refresh_status_surfaces()`. It returns nothing.

**Call relations**: This is the core status setter used by `ChatWidget::set_status_header` and other runtime paths. It coordinates internal state, footer rendering, and terminal-title refresh when status-derived title items are configured.

*Call graph*: called by 1 (set_status_header).


##### `ChatWidget::set_status_header`  (lines 58–65)

```
fn set_status_header(&mut self, header: String)
```

**Purpose**: Convenience wrapper that updates only the status header and clears any existing details. It uses the default details capitalization and max-line policy.

**Data flow**: It takes a `header` string and forwards it to `set_status(header, None, StatusDetailsCapitalization::CapitalizeFirst, STATUS_DETAILS_DEFAULT_MAX_LINES)`. It returns nothing.

**Call relations**: This helper is called by runtime flows that only need to change the headline status. It delegates all actual work to `ChatWidget::set_status`.

*Call graph*: calls 1 internal fn (set_status).


##### `ChatWidget::set_status_line`  (lines 68–70)

```
fn set_status_line(&mut self, status_line: Option<Line<'static>>)
```

**Purpose**: Sets the currently rendered footer status-line content directly on the bottom pane. It is a thin forwarding method.

**Data flow**: It takes `Option<Line<'static>>` and passes it to `bottom_pane.set_status_line`. It returns nothing.

**Call relations**: This setter is used by status-surface rendering code that has already composed the footer line.


##### `ChatWidget::set_status_line_hyperlink`  (lines 73–75)

```
fn set_status_line_hyperlink(&mut self, url: Option<String>)
```

**Purpose**: Sets the hyperlink target associated with the current footer status line. It forwards the optional URL to the bottom pane.

**Data flow**: It takes `Option<String>` and passes it to `bottom_pane.set_status_line_hyperlink`. It returns nothing.

**Call relations**: This is another thin adapter used by status rendering code when the footer line should be clickable.


##### `ChatWidget::set_active_agent_label`  (lines 81–83)

```
fn set_active_agent_label(&mut self, active_agent_label: Option<String>)
```

**Purpose**: Forwards the active-agent label into the bottom pane’s footer pipeline. `ChatWidget` intentionally remains a pass-through rather than owning active-thread selection policy.

**Data flow**: It takes `Option<String>` and passes it to `bottom_pane.set_active_agent_label`. It returns nothing.

**Call relations**: This helper is called by app-level orchestration that knows which agent/thread label should currently be shown.


##### `ChatWidget::refresh_status_line`  (lines 95–97)

```
fn refresh_status_line(&mut self)
```

**Purpose**: Triggers a recomputation of footer status-line content from current config and runtime state. In this module it is a thin alias for the broader status-surface refresh path.

**Data flow**: It takes no arguments, calls `refresh_status_surfaces()`, and returns nothing.

**Call relations**: This method is called after status-line setup changes and by model-dependent refresh logic elsewhere. It delegates all actual recomputation to the shared status-surface refresh implementation.

*Call graph*: called by 1 (setup_status_line).


##### `ChatWidget::cancel_status_line_setup`  (lines 103–105)

```
fn cancel_status_line_setup(&self)
```

**Purpose**: Records that status-line setup was canceled without changing config. The cancellation is intentionally side-effect free apart from logging.

**Data flow**: It takes no arguments, emits an informational log message, and returns nothing.

**Call relations**: This method is used by the status-line setup UI when the user cancels. It does not delegate or mutate widget state.

*Call graph*: 1 external calls (info!).


##### `ChatWidget::setup_status_line`  (lines 110–118)

```
fn setup_status_line(&mut self, items: Vec<StatusLineItem>, use_theme_colors: bool)
```

**Purpose**: Commits the selected status-line items and color preference into in-memory config, then refreshes the footer status line. An empty selection is stored explicitly as an empty list.

**Data flow**: It takes a vector of `StatusLineItem` and a `use_theme_colors` flag, logs the selection, converts items to their string ids, stores them in `self.config.tui_status_line`, stores the color flag in `self.config.tui_status_line_use_colors`, calls `refresh_status_line()`, and returns nothing.

**Call relations**: This is the confirmation handler for the status-line setup UI. It delegates the actual footer recomputation to `ChatWidget::refresh_status_line`.

*Call graph*: calls 1 internal fn (refresh_status_line); 1 external calls (info!).


##### `ChatWidget::preview_terminal_title`  (lines 121–129)

```
fn preview_terminal_title(&mut self, items: Vec<TerminalTitleItem>)
```

**Purpose**: Applies a temporary terminal-title selection while the setup UI is open, preserving the original config the first time preview is invoked. It lets the user see live title changes before confirming.

**Data flow**: It takes a vector of `TerminalTitleItem`, snapshots `self.config.tui_terminal_title.clone()` into `self.terminal_title_setup_original_items` if no snapshot exists yet, converts the items to string ids, stores them in `self.config.tui_terminal_title`, calls `refresh_terminal_title()`, and returns nothing.

**Call relations**: This method is used by the terminal-title setup UI during preview interactions. It pairs with `ChatWidget::revert_terminal_title_setup_preview` and `ChatWidget::setup_terminal_title`.


##### `ChatWidget::revert_terminal_title_setup_preview`  (lines 133–140)

```
fn revert_terminal_title_setup_preview(&mut self)
```

**Purpose**: Restores the terminal-title configuration that was active before preview began and ends the preview session. If no preview snapshot exists, it does nothing.

**Data flow**: It takes no arguments, removes `self.terminal_title_setup_original_items`, and if present writes that value back into `self.config.tui_terminal_title` before calling `refresh_terminal_title()`. It returns nothing.

**Call relations**: This helper is called by `ChatWidget::cancel_terminal_title_setup` and can also be used directly when preview changes should be discarded.

*Call graph*: called by 1 (cancel_terminal_title_setup).


##### `ChatWidget::cancel_terminal_title_setup`  (lines 143–146)

```
fn cancel_terminal_title_setup(&mut self)
```

**Purpose**: Cancels terminal-title setup, logs the cancellation, and restores the pre-setup title configuration. It is the explicit cancel action for the title setup UI.

**Data flow**: It logs an informational message, calls `revert_terminal_title_setup_preview()`, and returns nothing.

**Call relations**: This method is the cancel handler for terminal-title setup. It delegates restoration to `ChatWidget::revert_terminal_title_setup_preview`.

*Call graph*: calls 1 internal fn (revert_terminal_title_setup_preview); 1 external calls (info!).


##### `ChatWidget::setup_terminal_title`  (lines 152–158)

```
fn setup_terminal_title(&mut self, items: Vec<TerminalTitleItem>)
```

**Purpose**: Commits a confirmed terminal-title selection and discards any saved preview snapshot so future revert attempts become no-ops. It finalizes the setup session.

**Data flow**: It takes a vector of `TerminalTitleItem`, logs the selection, converts items to string ids, clears `self.terminal_title_setup_original_items`, stores the ids in `self.config.tui_terminal_title`, calls `refresh_terminal_title()`, and returns nothing.

**Call relations**: This is the confirmation handler for terminal-title setup. It complements preview/cancel behavior by making the previewed selection permanent.

*Call graph*: 1 external calls (info!).


##### `ChatWidget::set_status_line_branch`  (lines 164–173)

```
fn set_status_line_branch(&mut self, cwd: PathBuf, branch: Option<String>)
```

**Purpose**: Stores an async git-branch lookup result only if it matches the cwd currently being tracked for status-line branch lookup. Stale results are discarded by clearing the pending flag without updating the branch.

**Data flow**: It takes a `cwd` and optional `branch`. If `self.status_line_branch_cwd` does not equal that cwd, it sets `status_line_branch_pending` to `false` and returns. Otherwise it stores the branch, clears the pending flag, marks lookup complete, refreshes status surfaces, and returns.

**Call relations**: This method is called when asynchronous branch lookup completes. It protects the footer from showing branch names for an outdated cwd after directory changes.


##### `ChatWidget::set_status_line_git_summary`  (lines 176–189)

```
fn set_status_line_git_summary(
        &mut self,
        cwd: PathBuf,
        summary: StatusLineGitSummary,
    )
```

**Purpose**: Stores an async Git summary result for the current status-line cwd, ignoring stale responses for older directories. Successful updates mark lookup complete and refresh status surfaces.

**Data flow**: It takes a `cwd` and `StatusLineGitSummary`. If `self.status_line_git_summary_cwd` does not match, it clears `status_line_git_summary_pending` and returns. Otherwise it stores the summary in `self.status_line_git_summary`, clears the pending flag, marks lookup complete, refreshes status surfaces, and returns.

**Call relations**: This is the Git-summary counterpart to `ChatWidget::set_status_line_branch`, used by asynchronous status-line data fetches.


##### `ChatWidget::add_status_output`  (lines 191–248)

```
fn add_status_output(
        &mut self,
        refreshing_rate_limits: bool,
        request_id: Option<u64>,
    )
```

**Purpose**: Builds and appends the `/status` history cell, optionally registering a handle so rate-limit sections can be refreshed in place later. The output includes token usage, account/thread metadata, model/mode information, reasoning effort, rate limits, and agent summary text.

**Data flow**: Inputs are `refreshing_rate_limits` and optional `request_id`. It derives token usage from `self.token_info` with a default fallback, gets the collaboration-mode label and current model, looks up the model’s default reasoning effort from the catalog, computes the effective reasoning-effort override, clones current rate-limit snapshots, composes an agents summary from config and instruction source paths, and calls `crate::status::new_status_output_with_rate_limits_handle(...)` with all gathered state plus `Local::now()`. If `request_id` is present it stores `(request_id, handle)` in `self.refreshing_status_outputs`; then it appends the cell to history. It returns nothing.

**Call relations**: This method is used by `/status` command handling. It delegates summary composition to `crate::status::compose_agents_summary` and cell/handle creation to `crate::status::new_status_output_with_rate_limits_handle`.

*Call graph*: 4 external calls (now, compose_agents_summary, new_status_output_with_rate_limits_handle, default).


##### `ChatWidget::finish_status_rate_limit_refresh`  (lines 250–275)

```
fn finish_status_rate_limit_refresh(&mut self, request_id: u64)
```

**Purpose**: Completes a pending `/status` rate-limit refresh by updating only the history outputs associated with the matching request id. Other pending refresh handles are preserved.

**Data flow**: It takes a `request_id`, returns early if `refreshing_status_outputs` is empty, clones current rate-limit snapshots and `Local::now()`, drains the pending handle list, calls `handle.finish_rate_limit_refresh(...)` for entries whose request id matches, rebuilds the remaining list for nonmatching entries, stores it back, and requests redraw if any handle was updated. It returns nothing.

**Call relations**: This method is the completion path for asynchronous rate-limit refreshes started by `/status`. It operates on the handles previously stored by `ChatWidget::add_status_output`.

*Call graph*: 2 external calls (now, with_capacity).


##### `ChatWidget::open_status_line_setup`  (lines 277–287)

```
fn open_status_line_setup(&mut self)
```

**Purpose**: Builds and opens the status-line setup view using the currently configured items, color preference, live preview data, app-event sender, and list keymap. It is the widget-side entrypoint for status-line customization.

**Data flow**: It reads configured status-line items via `configured_status_line_items()`, computes preview data with `status_surface_preview_data()`, constructs a `StatusLineSetupView::new(...)`, and shows that view in the bottom pane. It returns nothing.

**Call relations**: This popup-opening method is triggered by slash/UI actions for status-line setup. It delegates preview-data generation to `ChatWidget::status_surface_preview_data` and interactive UI construction to `StatusLineSetupView::new`.

*Call graph*: calls 2 internal fn (new, status_surface_preview_data); 1 external calls (new).


##### `ChatWidget::open_terminal_title_setup`  (lines 289–299)

```
fn open_terminal_title_setup(&mut self)
```

**Purpose**: Builds and opens the terminal-title setup view, snapshotting the current title config so preview changes can later be reverted. It supplies live preview data and input bindings to the setup view.

**Data flow**: It reads configured terminal-title items via `configured_terminal_title_items()`, stores `self.config.tui_terminal_title.clone()` into `self.terminal_title_setup_original_items`, constructs a `TerminalTitleSetupView::new(...)` with preview data from `terminal_title_preview_data()`, and shows the view in the bottom pane. It returns nothing.

**Call relations**: This is the terminal-title counterpart to `ChatWidget::open_status_line_setup`. It delegates preview-data generation to `ChatWidget::terminal_title_preview_data` and view construction to `TerminalTitleSetupView::new`.

*Call graph*: calls 2 internal fn (new, terminal_title_preview_data); 1 external calls (new).


##### `ChatWidget::status_surface_preview_data`  (lines 301–321)

```
fn status_surface_preview_data(&mut self) -> StatusSurfacePreviewData
```

**Purpose**: Builds preview data for status-surface setup UIs by collecting live values for each previewable item and suppressing placeholders for codex rate-limit items when codex snapshots exist but a specific window is absent. It balances realism with stable setup rendering.

**Data flow**: It iterates `StatusSurfacePreviewItem::iter()`, asks `status_surface_preview_value_for_item(item)` for each live value, constructs `StatusSurfacePreviewData::from_iter(...)`, then if `rate_limit_snapshots_by_limit_id` contains `"codex"` suppresses placeholders for `FiveHourLimit` and `WeeklyLimit` when those specific preview values are absent. It returns the populated preview data.

**Call relations**: This helper is used by both `ChatWidget::open_status_line_setup` and `ChatWidget::terminal_title_preview_data` to seed setup previews with current runtime values.

*Call graph*: calls 2 internal fn (from_iter, iter); called by 2 (open_status_line_setup, terminal_title_preview_data).


##### `ChatWidget::terminal_title_preview_data`  (lines 323–336)

```
fn terminal_title_preview_data(&mut self) -> StatusSurfacePreviewData
```

**Purpose**: Extends general status-surface preview data with live terminal-title-specific values for each `TerminalTitleItem`. It produces the preview dataset used by the terminal-title setup UI.

**Data flow**: It starts from `status_surface_preview_data()`, captures `Instant::now()`, iterates `TerminalTitleItem::iter()`, maps each item to its preview item via `preview_item()`, asks `terminal_title_value_for_item(item, now)` for a live value, and writes that value into the preview data with `set_live`. It returns the augmented preview data.

**Call relations**: This helper is called by `ChatWidget::open_terminal_title_setup`. It builds on `ChatWidget::status_surface_preview_data` rather than duplicating common preview logic.

*Call graph*: calls 1 internal fn (status_surface_preview_data); called by 1 (open_terminal_title_setup); 2 external calls (now, iter).


##### `ChatWidget::status_line_context_window_size`  (lines 338–343)

```
fn status_line_context_window_size(&self) -> Option<i64>
```

**Purpose**: Returns the effective context-window size used for footer status calculations, preferring runtime token info and falling back to configured model context window. It is a small accessor for context usage math.

**Data flow**: It reads `self.token_info.as_ref().and_then(|info| info.model_context_window)` and falls back to `self.config.model_context_window`, returning `Option<i64>`. It mutates nothing.

**Call relations**: This helper is used by `ChatWidget::status_line_context_remaining_percent` to compute context usage percentages.

*Call graph*: called by 1 (status_line_context_remaining_percent).


##### `ChatWidget::status_line_context_remaining_percent`  (lines 345–360)

```
fn status_line_context_remaining_percent(&self) -> Option<i64>
```

**Purpose**: Computes the percentage of context window remaining for the footer status line. If no context-window size is known, it defaults to `100` rather than `None`.

**Data flow**: It calls `status_line_context_window_size()`. If that returns `None`, it returns `Some(100)`. Otherwise it reads the last token usage from `self.token_info` with a default fallback and calls `usage.percent_of_context_window_remaining(context_window).clamp(0, 100)`, returning that wrapped in `Some(...)`.

**Call relations**: This helper is used by `ChatWidget::status_line_context_used_percent` and any status rendering that wants remaining-context percentage.

*Call graph*: calls 1 internal fn (status_line_context_window_size); called by 1 (status_line_context_used_percent); 1 external calls (default).


##### `ChatWidget::status_line_context_used_percent`  (lines 362–365)

```
fn status_line_context_used_percent(&self) -> Option<i64>
```

**Purpose**: Computes the percentage of context window used by subtracting the remaining percentage from 100. The result is clamped to the valid range.

**Data flow**: It calls `status_line_context_remaining_percent().unwrap_or(100)`, computes `(100 - remaining).clamp(0, 100)`, wraps it in `Some(...)`, and returns it. It mutates no state.

**Call relations**: This helper is a simple derivative of `ChatWidget::status_line_context_remaining_percent` for renderers that prefer used rather than remaining context.

*Call graph*: calls 1 internal fn (status_line_context_remaining_percent).


##### `ChatWidget::status_line_total_usage`  (lines 367–372)

```
fn status_line_total_usage(&self) -> TokenUsage
```

**Purpose**: Returns the total accumulated token usage for status displays, defaulting to an empty `TokenUsage` when no runtime token info is available. It is a pure accessor.

**Data flow**: It reads `self.token_info`, clones `info.total_token_usage` when present, otherwise returns `TokenUsage::default()`. It mutates nothing.

**Call relations**: This helper supports status rendering and reporting code that needs total token counts.


##### `ChatWidget::status_line_limit_display`  (lines 374–382)

```
fn status_line_limit_display(
        &self,
        window: Option<&RateLimitWindowDisplay>,
        label: &str,
    ) -> Option<String>
```

**Purpose**: Formats a human-readable rate-limit label like `"Weekly 42% left"` from an optional rate-limit window snapshot. Missing windows yield `None`.

**Data flow**: It takes an optional `RateLimitWindowDisplay` reference and a label string, returns `None` if the window is absent, otherwise computes remaining percentage as `100.0 - used_percent` clamped to `[0, 100]` and formats the label string. It mutates no state.

**Call relations**: This is a pure formatting helper used by status-surface rendering code when composing rate-limit items.

*Call graph*: 1 external calls (format!).


##### `ChatWidget::status_line_reasoning_effort_label`  (lines 384–391)

```
fn status_line_reasoning_effort_label(
        effort: Option<&ReasoningEffortConfig>,
    ) -> String
```

**Purpose**: Formats the display label for a reasoning-effort setting, mapping `None` and explicit `ReasoningEffortConfig::None` to `"default"`. Other effort values use their `as_str()` representation.

**Data flow**: It takes `Option<&ReasoningEffortConfig>`, matches on it, and returns a new `String` containing either `"default"` or the effort’s string form. It mutates no state.

**Call relations**: This helper is used by status rendering to present reasoning effort consistently across footer and `/status` surfaces.


### `tui/src/status/account.rs`

`data_model` · `request handling`

This file contains a single enum, `StatusAccountDisplay`, which is a compact data model for presenting account information in status output. The `ChatGpt` variant carries two optional strings: `email` and `plan`. Both are optional, which allows callers to represent partially known account state without inventing placeholder text or conflating missing data with empty strings. The `ApiKey` variant represents the alternate authentication mode where no user email or subscription plan is expected to be shown. The enum derives `Debug`, `Clone`, `PartialEq`, and `Eq`, making it suitable for formatting, copying into UI state, and comparing in tests or diff-based rendering paths. This type is intentionally display-focused rather than protocol-focused: it captures only the fields needed by the TUI’s status surfaces and leaves transport-specific details elsewhere. The key invariant is that ChatGPT-backed status may have richer identity metadata, while API-key mode is modeled as a distinct case rather than a `ChatGpt` value with all fields absent, which keeps downstream formatting logic simpler and semantically clearer.


### `tui/src/status/mod.rs`

`orchestration` · `request handling`

This module is the façade for the TUI status subsystem. Its documentation explains the design intent: protocol-level snapshots are converted into stable display structures here, keeping rendering concerns separate from transport-facing code. Internally it declares submodules for account display, card/status output assembly, formatting helpers, generic helpers, rate-limit transformation, and remote connection state. It then selectively re-exports the types and constructors that other parts of the crate should use: `StatusAccountDisplay`, `StatusHistoryHandle`, `new_status_output_with_rate_limits_handle`, helper formatters such as `compose_agents_summary`, `format_directory_display`, `format_tokens_compact`, and `plan_type_display_name`, plus rate-limit display types and conversion entry points like `RateLimitSnapshotDisplay`, `RateLimitWindowDisplay`, and `rate_limit_snapshot_display_for_limit`. Test-only re-exports expose alternate constructors and snapshot helpers for assertions without widening the normal runtime API. The file itself contains no transformation logic, but it defines the subsystem boundary and the intended dependency direction: callers consume display-ready status abstractions from this module instead of reaching into lower-level formatting or protocol code. That organization is especially important for rate-limit handling, which the docs identify as the main status-line integration point and which likely encapsulates stale/missing-data classification behind these exports.


### `tui/src/status/rate_limits.rs`

`domain_logic` · `status snapshot shaping and refresh handling`

This module defines the display model for rate-limit status surfaces. The core structs are `RateLimitWindowDisplay`, `RateLimitSnapshotDisplay`, `CreditsSnapshotDisplay`, and `SpendControlLimitSnapshotDisplay`, which are derived from protocol payloads but normalized for rendering: percentages become `f64`, reset timestamps are converted from UTC epoch seconds into localized strings via `format_reset_timestamp`, and monthly spend-control amounts are rounded and formatted with separators.

The main orchestration function is `compose_rate_limit_data_many`. It accepts one or more `RateLimitSnapshotDisplay` values plus a render-time `now`, marks the whole result stale if either the snapshot capture time or an embedded monthly-limit capture time exceeds `RATE_LIMIT_STALE_THRESHOLD_MINUTES`, and then emits `StatusRateLimitRow` values. Label generation is careful: canonical `codex` limits omit a bucket prefix, non-codex limits with multiple windows get a group header row like `codex-other limit`, and non-codex limits with exactly one window fold the bucket name into the window label itself. Window labels come from `limit_label_for_window` with `fallback_limit_label` fallback, then `capitalize_first`.

Credits rows are only shown when `has_credits` is true; unlimited credits render as `Unlimited`, positive balances are rounded to whole credits, and zero/invalid balances suppress the row entirely. Monthly spend controls become a progress-bar-compatible window row whose `percent_used` is computed as `100 - percent_remaining` and whose detail text reads `X of Y credits used`. If no rows can be built, the module distinguishes `Unavailable` from `Missing` based on whether a snapshot existed at all.

#### Function details

##### `RateLimitWindowDisplay::from_window`  (lines 79–91)

```
fn from_window(window: &RateLimitWindow, captured_at: DateTime<Local>) -> Self
```

**Purpose**: Converts a protocol `RateLimitWindow` into a localized display struct with formatted reset text.

**Data flow**: It reads `used_percent`, `window_duration_mins`, and optional epoch-seconds `resets_at` from the input window, converts the timestamp through `DateTime::<Utc>::from_timestamp` into local time, formats it relative to `captured_at`, and returns a `RateLimitWindowDisplay`.

**Call relations**: It is used during snapshot conversion by `rate_limit_snapshot_display_for_limit` for both primary and secondary windows.

*Call graph*: 1 external calls (from).


##### `rate_limit_snapshot_display`  (lines 137–142)

```
fn rate_limit_snapshot_display(
    snapshot: &RateLimitSnapshot,
    captured_at: DateTime<Local>,
) -> RateLimitSnapshotDisplay
```

**Purpose**: Test-only convenience wrapper that converts a protocol snapshot using the default limit name `codex`.

**Data flow**: It takes a `&RateLimitSnapshot` and `captured_at`, forwards them with `"codex".to_string()` to `rate_limit_snapshot_display_for_limit`, and returns the resulting `RateLimitSnapshotDisplay`.

**Call relations**: This wrapper exists for tests and callers that do not need custom limit-bucket naming.

*Call graph*: calls 1 internal fn (rate_limit_snapshot_display_for_limit).


##### `rate_limit_snapshot_display_for_limit`  (lines 144–166)

```
fn rate_limit_snapshot_display_for_limit(
    snapshot: &RateLimitSnapshot,
    limit_name: String,
    captured_at: DateTime<Local>,
) -> RateLimitSnapshotDisplay
```

**Purpose**: Builds a full display snapshot from a protocol `RateLimitSnapshot` and an explicit limit bucket name.

**Data flow**: It takes the protocol snapshot, a `String` limit name, and `captured_at`; maps optional primary and secondary windows through `RateLimitWindowDisplay::from_window`; maps optional credits through `CreditsSnapshotDisplay::from`; maps optional spend controls through `SpendControlLimitSnapshotDisplay::from_limit`; and returns a populated `RateLimitSnapshotDisplay`.

**Call relations**: It is the canonical protocol-to-display conversion path, called directly by the test wrapper and by status code that needs named limit buckets.

*Call graph*: called by 1 (rate_limit_snapshot_display).


##### `CreditsSnapshotDisplay::from`  (lines 169–175)

```
fn from(value: &CoreCreditsSnapshot) -> Self
```

**Purpose**: Copies the backend credits snapshot into the simpler display struct used by status rendering.

**Data flow**: It reads `has_credits`, `unlimited`, and cloned `balance` from `&CoreCreditsSnapshot` and returns a `CreditsSnapshotDisplay`.

**Call relations**: It is used during snapshot conversion inside `rate_limit_snapshot_display_for_limit`.


##### `SpendControlLimitSnapshotDisplay::from_limit`  (lines 179–191)

```
fn from_limit(
        value: &CoreSpendControlLimitSnapshot,
        captured_at: DateTime<Local>,
    ) -> Option<Self>
```

**Purpose**: Converts a backend monthly spend-control snapshot into a display struct, rejecting invalid numeric fields.

**Data flow**: It takes a `&CoreSpendControlLimitSnapshot` and `captured_at`, clamps `remaining_percent` into `0..=100`, formats `used` and `limit` through `format_credit_amount`, converts `resets_at` from epoch seconds to local formatted text, and returns `Some(display)` or `None` if either amount cannot be parsed.

**Call relations**: It is called during snapshot conversion so invalid spend-control payloads are dropped before row composition.

*Call graph*: calls 1 internal fn (format_credit_amount); 2 external calls (from_timestamp, from).


##### `compose_rate_limit_data`  (lines 198–206)

```
fn compose_rate_limit_data(
    snapshot: Option<&RateLimitSnapshotDisplay>,
    now: DateTime<Local>,
) -> StatusRateLimitData
```

**Purpose**: Builds status-ready rate-limit data from an optional single snapshot, preserving the distinction between missing and present data.

**Data flow**: It takes `Option<&RateLimitSnapshotDisplay>` and `now`; for `Some`, it wraps the reference in a one-element slice and delegates to `compose_rate_limit_data_many`; for `None`, it returns `StatusRateLimitData::Missing`.

**Call relations**: It is used by status constructors and refresh completion paths that work with at most one snapshot.

*Call graph*: calls 1 internal fn (compose_rate_limit_data_many); called by 2 (new, finish_rate_limit_refresh); 1 external calls (from_ref).


##### `compose_rate_limit_data_many`  (lines 208–337)

```
fn compose_rate_limit_data_many(
    snapshots: &[RateLimitSnapshotDisplay],
    now: DateTime<Local>,
) -> StatusRateLimitData
```

**Purpose**: Transforms one or more display snapshots into ordered status rows and classifies the result as available, stale, unavailable, or missing.

**Data flow**: It reads each snapshot’s `captured_at`, windows, credits, monthly limit, and `limit_name`; computes staleness against `now`; derives labels for primary and secondary windows; conditionally inserts a non-codex group row; appends window rows, optional credits rows from `credit_status_row`, and optional monthly credit-limit rows; then returns `Missing` for empty input, `Unavailable` for snapshots that yielded no rows, `Stale(rows)` if any source is old, or `Available(rows)` otherwise.

**Call relations**: This is the module’s main composition routine. It is called by single-snapshot composition, by status rendering paths, and by tests covering codex/non-codex labeling and stale classification.

*Call graph*: calls 1 internal fn (credit_status_row); called by 5 (new, finish_rate_limit_refresh, compose_rate_limit_data, non_codex_multi_limit_keeps_group_row, non_codex_single_limit_renders_combined_row); 11 external calls (minutes, signed_duration_since, new, with_capacity, format!, is_empty, len, Available, Stale, Text (+1 more)).


##### `render_status_limit_progress_bar`  (lines 343–353)

```
fn render_status_limit_progress_bar(percent_remaining: f64) -> String
```

**Purpose**: Renders a fixed-width textual progress bar from a remaining-percentage value.

**Data flow**: It takes `percent_remaining`, clamps it into `0.0..=100.0`, converts that ratio into a rounded filled-segment count across `STATUS_LIMIT_BAR_SEGMENTS`, computes the remaining empty segments, and returns a bracketed string using `█` and `░`.

**Call relations**: It is a leaf formatter used by row-rendering code that turns `StatusRateLimitValue::Window` into visible progress bars.

*Call graph*: 1 external calls (format!).


##### `format_status_limit_summary`  (lines 356–358)

```
fn format_status_limit_summary(percent_remaining: f64) -> String
```

**Purpose**: Formats a short textual summary like `72% left` from a remaining percentage.

**Data flow**: It takes `percent_remaining`, rounds it to zero decimal places via formatting, and returns the resulting summary string.

**Call relations**: It is consumed by row-line rendering to accompany or replace the visual progress bar.

*Call graph*: called by 1 (rate_limit_row_lines); 1 external calls (format!).


##### `credit_status_row`  (lines 364–380)

```
fn credit_status_row(credits: &CreditsSnapshotDisplay) -> Option<StatusRateLimitRow>
```

**Purpose**: Builds the optional `Credits` row for a snapshot, suppressing it when credits are disabled or non-positive.

**Data flow**: It reads `has_credits`, `unlimited`, and optional `balance` from `CreditsSnapshotDisplay`. It returns `None` if credits are disabled, returns a `Text("Unlimited")` row if unlimited, otherwise parses and rounds the balance through `format_credit_balance` and returns `Text("{n} credits")` when positive.

**Call relations**: It is called from `compose_rate_limit_data_many` after window rows are added, encapsulating all credits-specific visibility rules.

*Call graph*: calls 1 internal fn (format_credit_balance); called by 1 (compose_rate_limit_data_many); 2 external calls (format!, Text).


##### `format_credit_balance`  (lines 382–402)

```
fn format_credit_balance(raw: &str) -> Option<String>
```

**Purpose**: Parses a raw credits balance string and returns a positive whole-number display value.

**Data flow**: It trims the input string, rejects empty input, first tries parsing as `i64` and accepts only values greater than zero, then tries parsing as `f64`, rounds positive finite values to `i64`, and returns `Some(string)` or `None` for zero/negative/invalid input.

**Call relations**: It is only used by `credit_status_row` to decide whether a credits balance should be shown.

*Call graph*: called by 1 (credit_status_row).


##### `format_credit_amount`  (lines 404–410)

```
fn format_credit_amount(raw: &str) -> Option<String>
```

**Purpose**: Parses and formats a non-negative credit amount with thousands separators for monthly spend-control displays.

**Data flow**: It trims and parses the input as `f64`, rejects non-finite or negative values, rounds to `i64`, formats with `format_with_separators`, and returns `Some(formatted)` or `None`.

**Call relations**: It is used by `SpendControlLimitSnapshotDisplay::from_limit` for both `used` and `limit` fields.

*Call graph*: calls 1 internal fn (format_with_separators); called by 1 (from_limit).


##### `tests::window`  (lines 422–428)

```
fn window(used_percent: f64) -> RateLimitWindowDisplay
```

**Purpose**: Creates a small `RateLimitWindowDisplay` fixture with a fixed reset label and 5-hour window duration.

**Data flow**: It takes `used_percent` and returns a `RateLimitWindowDisplay` with `resets_at = Some("soon")` and `window_minutes = Some(300)`.

**Call relations**: It is a local helper for the non-codex labeling tests.


##### `tests::non_codex_single_limit_renders_combined_row`  (lines 431–474)

```
fn non_codex_single_limit_renders_combined_row()
```

**Purpose**: Verifies that a non-codex snapshot with exactly one window folds the bucket name into the window label instead of emitting a separate group header.

**Data flow**: It constructs one `codex` and one `codex-other` snapshot, composes rows with `compose_rate_limit_data_many`, extracts labels, and asserts the expected sequence including two separate `Credits` rows.

**Call relations**: This test exercises the `combine_non_codex_single_limit` branch in `compose_rate_limit_data_many`.

*Call graph*: calls 1 internal fn (compose_rate_limit_data_many); 4 external calls (now, assert_eq!, panic!, window).


##### `tests::non_codex_multi_limit_keeps_group_row`  (lines 477–509)

```
fn non_codex_multi_limit_keeps_group_row()
```

**Purpose**: Checks that a non-codex snapshot with both primary and secondary windows keeps a standalone bucket header row.

**Data flow**: It builds a `codex-other` snapshot with two windows, composes rows, collects labels, and asserts the output starts with `codex-other limit` followed by generic usage labels.

**Call relations**: This test covers the opposite branch from the single-limit case, confirming grouped labeling behavior.

*Call graph*: calls 1 internal fn (compose_rate_limit_data_many); 3 external calls (now, assert_eq!, panic!).


### `tui/src/goal_files.rs`

`domain_logic` · `request handling`

This file implements the TUI-side policy for materializing goal content that cannot safely live inline in the thread objective string. `GoalDraft` collects the editable objective text plus structured `TextElement`s, pending pasted blobs, local image attachments, and remote image URLs. The main async entrypoint, `materialize_goal_draft`, validates that the objective is not effectively empty, expands pending paste placeholders to check that the resulting content still has substance, then walks active placeholders to decide which pastes and images need external files. It lazily creates a per-goal attachment directory under `$CODEX_HOME/attachments/<uuid>` using app-server filesystem RPCs, writes pasted text as numbered `.txt` files, copies local images with sanitized extensions, and replaces placeholders with imperative references like `Read this file before continuing.` Unreferenced local images are appended as a dedicated section, and remote image URLs become another appended section. If the final objective exceeds `MAX_THREAD_GOAL_OBJECTIVE_CHARS`, the full objective is written to `goal-objective.md` and replaced by a bounded reference sentence. `objective_file_path` and `objective_text_for_edit` reverse that process safely: they only treat an objective as file-backed if it matches the exact attachment-directory layout under the provided `codex_home` and contains a valid UUID path segment, preventing arbitrary path references from being reopened.

#### Function details

##### `materialize_goal_draft`  (lines 33–138)

```
async fn materialize_goal_draft(
    app_server: &mut AppServerSession,
    codex_home: Option<&GoalFilePath>,
    draft: GoalDraft,
) -> Result<(String, Option<GoalFilePath>)>
```

**Purpose**: Transforms a `GoalDraft` into a final objective string, optionally backed by app-server-host files for pasted text, images, or oversized content. It enforces non-empty objectives and returns both the rewritten objective and the attachment directory it created, if any.

**Data flow**: Consumes a mutable `AppServerSession`, optional `codex_home` path, and owned `GoalDraft`. It validates `draft.objective`, uses `ChatComposer::expand_pending_pastes` to detect whether pending placeholders would leave the objective empty, collects active placeholders from `text_elements`, then iterates pending pastes and local images. For each active paste/image placeholder it lazily creates an output directory via `ensure_goal_output_dir`, writes file bytes through `write_goal_file`, and records replacement text; for local images without placeholders it accumulates bullet lines for a later appended section. It then expands replacements into the objective, trims it, appends sections for referenced image files and remote image URLs, and if the character count still exceeds `MAX_THREAD_GOAL_OBJECTIVE_CHARS`, writes the full objective to `goal-objective.md` and replaces it with `objective_file_reference`. On success it returns `(objective, output_dir)`; on reference-generation failure after creating a directory, it attempts cleanup with `fs_remove_path`.

**Call relations**: This is invoked when the UI commits a goal draft. It orchestrates placeholder expansion, attachment-directory creation, file writes, and final objective rewriting by delegating to `ensure_goal_output_dir`, `write_goal_file`, `append_section`, `image_extension`, and `objective_file_reference`.

*Call graph*: calls 6 internal fn (expand_pending_pastes, append_section, ensure_goal_output_dir, image_extension, objective_file_reference, write_goal_file); called by 1 (set_thread_goal_draft); 5 external calls (new, bail!, format!, read, fs_remove_path).


##### `objective_text_for_edit`  (lines 140–155)

```
async fn objective_text_for_edit(
    app_server: &mut AppServerSession,
    codex_home: Option<&GoalFilePath>,
    objective: &str,
) -> Result<String>
```

**Purpose**: Loads the full editable objective text when the stored objective is actually a file reference. If the objective is inline text, it simply returns that text unchanged.

**Data flow**: Takes a mutable `AppServerSession`, optional `codex_home`, and borrowed objective string. It first calls `objective_file_path`; if that returns `None`, it clones and returns the original objective. Otherwise it reads bytes from the app server with `fs_read_file_path`, wraps read errors with the referenced path, decodes UTF-8 with `String::from_utf8`, and returns the decoded `String` or a contextualized error if the file is unreadable or invalid UTF-8.

**Call relations**: This function is used when opening the goal editor so file-backed objectives can be edited as their original full text. It depends on `objective_file_path` to reject malformed or untrusted references before attempting I/O.

*Call graph*: calls 1 internal fn (objective_file_path); called by 1 (open_thread_goal_editor); 2 external calls (from_utf8, fs_read_file_path).


##### `objective_file_path`  (lines 157–172)

```
fn objective_file_path(
    objective: &str,
    codex_home: Option<&GoalFilePath>,
) -> Option<GoalFilePath>
```

**Purpose**: Parses an objective string and recognizes only the specific file-reference format used for oversized goals. It validates both the sentence wrapper and the expected attachment-directory layout.

**Data flow**: Reads the objective string and optional `codex_home`, strips the fixed prefix and suffix, parses the remaining absolute path into `AppServerPath`, inspects its components to extract the parent attachment directory name, and builds the expected path `codex_home/attachments/<uuid>/goal-objective.md`. It returns `Some(path)` only if the parsed path exactly matches that expected location and the attachment directory name parses as a UUID; otherwise it returns `None`.

**Call relations**: This parser is called before reading a referenced objective file for editing. Its strict equality check prevents arbitrary absolute paths from being treated as trusted goal-objective files.

*Call graph*: calls 1 internal fn (from_absolute_str); called by 1 (objective_text_for_edit); 1 external calls (parse_str).


##### `objective_file_reference`  (lines 174–183)

```
fn objective_file_reference(path: &GoalFilePath) -> Result<String>
```

**Purpose**: Builds the inline sentence that tells Codex to read a materialized goal-objective file. It also enforces that the reference sentence itself fits within the protocol’s objective-length limit.

**Data flow**: Accepts a borrowed `GoalFilePath`, formats it into `Read the Codex goal objective file at <path> before continuing.`, counts Unicode scalar values with `.chars().count()`, and returns the `String` if within `MAX_THREAD_GOAL_OBJECTIVE_CHARS`. If the reference is too long, it returns an error via `bail!` describing the actual and allowed lengths.

**Call relations**: This helper is used by `materialize_goal_draft` only in the oversized-objective fallback path, just before writing `goal-objective.md`. Its failure path triggers best-effort cleanup of the newly created attachment directory.

*Call graph*: called by 1 (materialize_goal_draft); 2 external calls (bail!, format!).


##### `ensure_goal_output_dir`  (lines 185–205)

```
async fn ensure_goal_output_dir(
    app_server: &mut AppServerSession,
    codex_home: Option<&GoalFilePath>,
    output_dir: &mut Option<GoalFilePath>,
) -> Result<GoalFilePath>
```

**Purpose**: Lazily creates and memoizes the per-goal attachment directory on the app server. Repeated calls during one materialization reuse the same directory path.

**Data flow**: Takes a mutable `AppServerSession`, optional `codex_home`, and mutable `Option<GoalFilePath>` cache. If `output_dir` is already `Some`, it clones and returns it. Otherwise it requires `codex_home`, constructs `codex_home/attachments/<new uuid>`, creates the directory tree through `fs_create_directory_all_path`, stores the path back into `output_dir`, and returns the cloned path.

**Call relations**: This internal helper is called from `materialize_goal_draft` whenever the draft first needs a file for pasted text, images, or an oversized objective. It isolates the one-time directory creation and the `$CODEX_HOME` precondition.

*Call graph*: called by 1 (materialize_goal_draft); 2 external calls (new_v4, fs_create_directory_all_path).


##### `write_goal_file`  (lines 207–217)

```
async fn write_goal_file(
    app_server: &mut AppServerSession,
    path: GoalFilePath,
    bytes: Vec<u8>,
) -> Result<()>
```

**Purpose**: Writes a single attachment file to the app server with contextualized error reporting. It is the common sink for pasted text, copied images, and oversized objective markdown.

**Data flow**: Consumes a mutable `AppServerSession`, destination `GoalFilePath`, and owned byte buffer. It sends the bytes to `fs_write_file_path`, maps transport errors into `anyhow`, adds the destination path to the error context, and returns `Result<()>`.

**Call relations**: This helper is called by `materialize_goal_draft` after `ensure_goal_output_dir` has produced a destination path. It keeps all file-write failures consistently annotated with the target path.

*Call graph*: called by 1 (materialize_goal_draft); 1 external calls (fs_write_file_path).


##### `append_section`  (lines 218–228)

```
fn append_section(objective: &mut String, heading: &str, lines: Vec<String>)
```

**Purpose**: Appends a headed bullet-style section to the objective text only when there is content to add. It preserves readable spacing between the existing objective and appended metadata.

**Data flow**: Mutably borrows the objective `String`, plus a heading and a vector of already formatted lines. If `lines` is empty it returns immediately. Otherwise it ensures the objective ends with a blank-line separator, appends the heading, a newline, and the joined lines separated by `\n`.

**Call relations**: This internal string helper is used by `materialize_goal_draft` to add `Referenced image files:` and `Referenced image URLs:` sections after placeholder expansion.

*Call graph*: called by 1 (materialize_goal_draft).


##### `image_extension`  (lines 230–242)

```
fn image_extension(path: &Path) -> String
```

**Purpose**: Extracts a safe, short filename extension from a local image path for copied attachment files. It strips non-alphanumeric characters and falls back to `png` when no usable extension exists.

**Data flow**: Reads a borrowed `&Path`, inspects `path.extension()`, converts it to UTF-8 if possible, filters characters to ASCII alphanumerics, truncates to at most 8 characters, and returns the sanitized extension as a `String`. If any step fails or yields an empty extension, it returns `png`.

**Call relations**: This helper is called while `materialize_goal_draft` copies local image attachments into the app-server attachment directory, ensuring generated filenames remain simple and predictable.

*Call graph*: called by 1 (materialize_goal_draft); 1 external calls (extension).


### TUI transcript and history updates
These files project persisted or live thread items into transcript cells, separators, diff models, and terminal-history updates visible to the user.

### `tui/src/app/history_ui.rs`

`orchestration` · `ui rendering`

This module manages the visible transcript and the terminal state around it. `insert_history_cell` is the core insertion path: it converts a boxed history cell into `Arc<dyn HistoryCell>`, mirrors it into the transcript overlay if one is active, appends it to `self.transcript_cells`, renders its wrapped lines either directly or into the initial replay buffer, and then asks the chat widget to reconsider pending usage-card insertion because a committed cell may have unblocked it. The related helpers `pending_usage_output_insertion_blocked`, `insert_pending_usage_output`, `insert_pending_usage_output_if_ready`, and `insert_pending_usage_output_after_stream_shutdown` implement the subtle rule that `/usage` and rate-limit hint cells should not be inserted while the chat widget says usage insertion is blocked or while the transcript tail is still an `AgentMessageCell`.

The file also contains user-facing handoff helpers. `open_url_in_browser` wraps `webbrowser::open` with success/error messaging. `open_desktop_thread` builds a `codex://threads/{thread_id}` URL and delegates to platform-specific launch helpers; on Windows, that means generating a PowerShell script that locates the `OpenAI.Codex` AppX package and launches `Codex.exe` with the deep link.

For clear/reset behavior, `clear_ui_header_lines_with_version` builds a fresh `SessionHeaderHistoryCell` from current model, reasoning effort, fast-status visibility, cwd, version, and YOLO mode. `clear_terminal_ui` drops queued history lines, clears either the alt screen or scrollback+visible screen, resets the viewport origin, optionally redraws the fresh-session header, and clears the `has_emitted_history_lines` flag. `reset_transcript_state_after_clear` then wipes overlay state, transcript cells, deferred lines, replay buffer, backtrack state, pending usage refreshes, and skill-load warnings so `/clear` starts from a truly clean transcript state.

#### Function details

##### `App::insert_history_cell`  (lines 11–36)

```
fn insert_history_cell(&mut self, tui: &mut tui::Tui, cell: Box<dyn HistoryCell>)
```

**Purpose**: Commits a history cell into the transcript, overlay, and terminal output path. It is the canonical insertion point for settled transcript cells.

**Data flow**: Consumes `Box<dyn HistoryCell>`, converts it to `Arc<dyn HistoryCell>`, inserts it into the transcript overlay if present and schedules a frame, pushes it onto `self.transcript_cells`, renders its wrapped lines either through `insert_history_cell_lines_with_initial_replay_buffer` or `insert_history_cell_lines` depending on whether initial replay buffering is active, and finally asks the chat widget to request pending usage-output insertion.

**Call relations**: Used throughout the app whenever a committed history cell should appear. Within this file it is called by `insert_pending_usage_output` to insert completed usage-related cells.

*Call graph*: called by 1 (insert_pending_usage_output); 1 external calls (frame_requester).


##### `App::pending_usage_output_insertion_blocked`  (lines 38–44)

```
fn pending_usage_output_insertion_blocked(&self) -> bool
```

**Purpose**: Determines whether completed usage-related cells should be withheld from history for now. It blocks insertion while the chat widget says usage insertion is unsafe or while the transcript tail is still an active agent-message cell.

**Data flow**: Reads `self.chat_widget.usage_history_insertion_blocked()` and checks whether the last `transcript_cells` entry is dynamically an `history_cell::AgentMessageCell`. It returns `true` if either condition holds.

**Call relations**: Called by `insert_pending_usage_output_if_ready` to decide whether usage output can be committed immediately.

*Call graph*: called by 1 (insert_pending_usage_output_if_ready).


##### `App::insert_pending_usage_output`  (lines 46–53)

```
fn insert_pending_usage_output(&mut self, tui: &mut tui::Tui)
```

**Purpose**: Commits any completed token-activity or rate-limit-reset-hint cells that are waiting in the chat widget. It drains both pending sources in order.

**Data flow**: Calls `self.chat_widget.take_completed_token_activity_output()` and, if present, inserts that cell via `insert_history_cell`. It then calls `self.chat_widget.take_pending_rate_limit_reset_hint()` and inserts that cell the same way if present.

**Call relations**: This private helper is called by both `insert_pending_usage_output_if_ready` and `insert_pending_usage_output_after_stream_shutdown` once their respective blocking conditions are satisfied.

*Call graph*: calls 1 internal fn (insert_history_cell); called by 2 (insert_pending_usage_output_after_stream_shutdown, insert_pending_usage_output_if_ready); 1 external calls (new).


##### `App::insert_pending_usage_output_if_ready`  (lines 55–60)

```
fn insert_pending_usage_output_if_ready(&mut self, tui: &mut tui::Tui)
```

**Purpose**: Inserts pending usage-related output only when both transcript and chat-widget state say it is safe. It is the normal path used while other transcript activity may still be in flight.

**Data flow**: Checks `pending_usage_output_insertion_blocked()`. If blocked, it returns immediately; otherwise it calls `insert_pending_usage_output(tui)`.

**Call relations**: Called from other app code after usage/rate-limit refreshes complete and from history insertion paths that may have unblocked deferred usage output.

*Call graph*: calls 2 internal fn (insert_pending_usage_output, pending_usage_output_insertion_blocked).


##### `App::insert_pending_usage_output_after_stream_shutdown`  (lines 62–67)

```
fn insert_pending_usage_output_after_stream_shutdown(&mut self, tui: &mut tui::Tui)
```

**Purpose**: Inserts pending usage-related output after an answer stream has shut down, using a slightly weaker blocking rule. It ignores the transcript-tail `AgentMessageCell` check and only respects the chat widget’s own usage-blocked state.

**Data flow**: If `self.chat_widget.usage_history_insertion_blocked()` is true, it returns; otherwise it calls `insert_pending_usage_output(tui)`.

**Call relations**: Used after stream consolidation/shutdown, when provisional transcript tails have already been resolved and only the chat widget’s internal block remains relevant.

*Call graph*: calls 1 internal fn (insert_pending_usage_output).


##### `App::open_url_in_browser`  (lines 69–78)

```
fn open_url_in_browser(&mut self, url: String)
```

**Purpose**: Opens an arbitrary URL in the system browser and reports success or failure to the user.

**Data flow**: Calls `webbrowser::open(&url)`. On error it adds `Failed to open browser for {url}: {err}` to the chat widget and returns; on success it adds `Opened {url} in your browser.` as an info message.

**Call relations**: Invoked from the central event dispatcher for `AppEvent::OpenUrlInBrowser`.

*Call graph*: 2 external calls (format!, open).


##### `App::open_desktop_thread`  (lines 80–92)

```
fn open_desktop_thread(&mut self, thread_id: ThreadId)
```

**Purpose**: Attempts to open the current thread in Codex Desktop via a deep-link URL. It surfaces a friendly install/launch hint when the handoff fails.

**Data flow**: Formats `codex://threads/{thread_id}`, passes it to `open_desktop_thread_url`, and on failure adds `desktop_thread_open_error_message(&err)` to the chat widget. On success it adds the fixed `Opened this session in Codex Desktop.` info message.

**Call relations**: Called from the event dispatcher for `AppEvent::OpenDesktopThread`. It delegates platform-specific launching to `open_desktop_thread_url`.

*Call graph*: calls 2 internal fn (desktop_thread_open_error_message, open_desktop_thread_url); 1 external calls (format!).


##### `App::clear_ui_header_lines_with_version`  (lines 94–111)

```
fn clear_ui_header_lines_with_version(
        &self,
        width: u16,
        version: &'static str,
    ) -> Vec<Line<'static>>
```

**Purpose**: Builds the fresh-session header lines shown after a clear or at session start. The header reflects current model, reasoning effort, fast-status visibility, cwd, version, and YOLO mode.

**Data flow**: Constructs `history_cell::SessionHeaderHistoryCell::new(...)` from current model, current reasoning effort, `should_show_fast_status(...)`, current cwd, and the supplied version string; applies `.with_yolo_mode(history_cell::is_yolo_mode(&self.config))`; then returns the rendered `display_lines(width)`.

**Call relations**: Used by `clear_ui_header_lines`, which supplies the normal CLI version constant.

*Call graph*: calls 1 internal fn (new); called by 1 (clear_ui_header_lines); 1 external calls (is_yolo_mode).


##### `App::clear_ui_header_lines`  (lines 113–115)

```
fn clear_ui_header_lines(&self, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Convenience wrapper that builds fresh-session header lines using the current CLI version constant.

**Data flow**: Calls `clear_ui_header_lines_with_version(width, CODEX_CLI_VERSION)` and returns the resulting lines.

**Call relations**: Called by `queue_clear_ui_header` during clear/reset flows.

*Call graph*: calls 1 internal fn (clear_ui_header_lines_with_version); called by 1 (queue_clear_ui_header).


##### `App::queue_clear_ui_header`  (lines 117–126)

```
fn queue_clear_ui_header(&mut self, tui: &mut tui::Tui)
```

**Purpose**: Queues the fresh-session header lines into the terminal history output after a clear. It also marks that history lines have been emitted.

**Data flow**: Computes the wrapped history width from the terminal’s last known screen width, builds header lines via `clear_ui_header_lines`, and if the result is non-empty, passes them to `tui.insert_history_lines(...)` and sets `self.has_emitted_history_lines = true`.

**Call relations**: Called by `clear_terminal_ui` when the caller requests header redraw after clearing the screen.

*Call graph*: calls 1 internal fn (clear_ui_header_lines); called by 1 (clear_terminal_ui); 1 external calls (insert_history_lines).


##### `App::clear_terminal_ui`  (lines 128–159)

```
fn clear_terminal_ui(
        &mut self,
        tui: &mut tui::Tui,
        redraw_header: bool,
    ) -> Result<()>
```

**Purpose**: Clears the visible terminal UI and scrollback, resets the inline viewport origin, and optionally redraws a fresh header. It is the terminal-facing half of `/clear` and similar reset flows.

**Data flow**: Checks whether alt-screen is active, clears any queued history insertions via `tui.clear_pending_history_lines()`, then either clears the visible alt screen or emits a combined ANSI sequence to clear scrollback and visible screen. It resets the viewport area’s `y` to 0 when needed, sets `self.has_emitted_history_lines = false`, optionally calls `queue_clear_ui_header(tui)`, and returns `Result<()>` from the terminal operations.

**Call relations**: Called from the event dispatcher during `/clear`, clear-and-submit, and other UI reset flows. It is typically followed by `reset_app_ui_state_after_clear`.

*Call graph*: calls 1 internal fn (queue_clear_ui_header); 2 external calls (clear_pending_history_lines, is_alt_screen_active).


##### `App::reset_app_ui_state_after_clear`  (lines 161–163)

```
fn reset_app_ui_state_after_clear(&mut self)
```

**Purpose**: Resets app-side transcript/UI state after the terminal has been cleared. It currently delegates to transcript-state reset.

**Data flow**: Calls `self.reset_transcript_state_after_clear()` and returns no value.

**Call relations**: Used immediately after `clear_terminal_ui` in clear/reset event flows.

*Call graph*: calls 1 internal fn (reset_transcript_state_after_clear).


##### `App::reset_transcript_state_after_clear`  (lines 165–177)

```
fn reset_transcript_state_after_clear(&mut self)
```

**Purpose**: Wipes transcript-related app state so a cleared session starts from a truly empty transcript model. It resets both rendered cells and deferred/replay bookkeeping.

**Data flow**: Sets `self.overlay = None`, clears `transcript_cells`, `deferred_history_lines`, `transcript_reflow`, and `skill_load_warnings`, resets `has_emitted_history_lines`, clears pending token-activity and rate-limit-reset-hint state in the chat widget, drops `initial_history_replay_buffer`, resets `backtrack` to `BacktrackState::default()`, and clears `backtrack_render_pending`.

**Call relations**: Called by `reset_app_ui_state_after_clear` and indirectly by clear/reset event handling.

*Call graph*: called by 1 (reset_app_ui_state_after_clear); 1 external calls (default).


##### `desktop_thread_open_error_message`  (lines 180–184)

```
fn desktop_thread_open_error_message(err: &str) -> String
```

**Purpose**: Formats the user-facing error shown when opening a thread in Codex Desktop fails. It always includes an install/launch hint.

**Data flow**: Interpolates the incoming error string into `Failed to open this session in Codex Desktop: {err}. Install or launch Codex Desktop and try again.` and returns the resulting `String`.

**Call relations**: Used by `App::open_desktop_thread` to convert platform-specific launch failures into a consistent message.

*Call graph*: called by 1 (open_desktop_thread); 1 external calls (format!).


##### `windows_desktop_app_launch_script`  (lines 226–254)

```
fn windows_desktop_app_launch_script(url: &str) -> String
```

**Purpose**: Builds the PowerShell script used on Windows to locate and launch the Codex Desktop AppX package with a deep-link URL. It validates that both the executable and app bundle exist before launching.

**Data flow**: Escapes the URL with `powershell_single_quoted_string`, interpolates it into a multi-line PowerShell script that queries `Get-AppxPackage -Name OpenAI.Codex`, derives `app`, `Codex.exe`, and `resources\app.asar` paths, emits `Write-Error` and exits if required files are missing, and otherwise runs `Start-Process` with the deep-link argument.

**Call relations**: Called by the Windows implementation of `open_desktop_thread_url`.

*Call graph*: calls 1 internal fn (powershell_single_quoted_string); called by 1 (open_desktop_thread_url); 1 external calls (format!).


##### `powershell_single_quoted_string`  (lines 257–259)

```
fn powershell_single_quoted_string(value: &str) -> String
```

**Purpose**: Escapes a string for safe inclusion inside a single-quoted PowerShell literal. It doubles embedded single quotes.

**Data flow**: Replaces each `'` in `value` with `''`, wraps the result in outer single quotes via `format!`, and returns the escaped string.

**Call relations**: Used by `windows_desktop_app_launch_script` when embedding the deep-link URL.

*Call graph*: called by 1 (windows_desktop_app_launch_script); 1 external calls (format!).


##### `open_desktop_thread_url`  (lines 262–264)

```
fn open_desktop_thread_url(_url: &str) -> Result<(), String>
```

**Purpose**: Windows-specific launcher that executes the generated PowerShell script and converts process failures into readable error strings. It is the platform transport behind desktop deep-link handoff.

**Data flow**: Builds the script with `windows_desktop_app_launch_script(url)`, runs `powershell.exe -NoProfile -Command <script>`, and on success returns `Ok(())`. On failure it decodes `stderr` with `String::from_utf8_lossy`; if stderr is empty it returns a generic status-based error, otherwise it returns the stderr text.

**Call relations**: Called by `App::open_desktop_thread` on Windows. It delegates script generation to `windows_desktop_app_launch_script`.

*Call graph*: calls 1 internal fn (windows_desktop_app_launch_script); called by 1 (open_desktop_thread); 3 external calls (from_utf8_lossy, new, format!).


### `tui/src/chatwidget/tool_lifecycle.rs`

`domain_logic` · `request handling`

This `ChatWidget` extension is the transcript-facing side of tool execution. Its event-entry methods normalize incoming tool notifications into either immediate UI updates or deferred queue entries, depending on whether the widget can safely mutate visible state now. For patch and image events, the flow is straightforward: mark visible turn activity, flush any streaming assistant output so tool rows do not interleave with text, append a purpose-built history cell, and request redraw when the screen should update immediately.

The more stateful paths are web search and MCP. Both use `transcript.active_cell` to show an in-progress row with animation support; completion tries to downcast the active cell to the expected concrete cell type and complete it in place when the `call_id` matches. If the active cell is missing or mismatched, the code falls back to creating a completed history cell directly, preserving transcript correctness even when events arrive out of order or after replay/defer boundaries. MCP completion also reconstructs a `McpInvocation`, converts `duration_ms` into a nonnegative `Duration`, maps protocol `result`/`error` into a `Result<CallToolResult, String>`, and may emit an extra boxed history cell returned by the active cell’s `complete` method.

Collaborator events maintain a small cache of pending spawn-request summaries keyed by tool-call id so later terminal events can render richer history. Several completion handlers set `transcript.had_work_activity = true`, which later drives insertion of the final work separator at turn completion.

#### Function details

##### `ChatWidget::on_patch_apply_begin`  (lines 9–12)

```
fn on_patch_apply_begin(&mut self, changes: HashMap<PathBuf, FileChange>)
```

**Purpose**: Records the start of a patch-application event as a transcript history cell. It treats patch application as visible turn activity immediately, before any completion status arrives.

**Data flow**: Takes a `HashMap<PathBuf, FileChange>` describing changed files, reads `self.config.cwd` to render paths relative to the working directory, records visible-turn activity, then creates and appends a patch event history cell. It mutates transcript/history state but returns no value.

**Call relations**: This is invoked when patch application begins. It does not defer through the queue; instead it directly emits the initial 'edited' style transcript row by delegating cell construction to `history_cell::new_patch_event`.

*Call graph*: 1 external calls (new_patch_event).


##### `ChatWidget::on_view_image_tool_call`  (lines 14–22)

```
fn on_view_image_tool_call(&mut self, path: AbsolutePathBuf)
```

**Purpose**: Adds a transcript row for a tool request to view an image file. It ensures any in-progress assistant text is separated from the image-view event.

**Data flow**: Consumes an `AbsolutePathBuf`, records visible-turn activity, flushes the streamed answer with a separator, builds a history cell using the current working directory for display context, appends it to history, and requests a redraw. It updates transcript/history and UI invalidation state only.

**Call relations**: Called when the image-view tool is invoked. It delegates rendering details to `history_cell::new_view_image_tool_call` and explicitly redraws because the event should appear immediately.

*Call graph*: 1 external calls (new_view_image_tool_call).


##### `ChatWidget::on_image_generation_begin`  (lines 24–27)

```
fn on_image_generation_begin(&mut self)
```

**Purpose**: Marks the start of image generation without yet adding a completed transcript cell. Its main job is to separate subsequent image-generation output from any streamed assistant text.

**Data flow**: Reads no external inputs beyond `self`, records visible-turn activity, and flushes the answer stream with a separator. It mutates turn/transcript state and returns nothing.

**Call relations**: Used at image-generation start before the terminal event arrives. It prepares transcript layout so `on_image_generation_end` can later append the completed generation cell cleanly.


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

**Purpose**: Finalizes an image-generation tool call by appending a completed history cell with status and optional output metadata. It also forces the UI to repaint so the generated-image result becomes visible.

**Data flow**: Accepts `call_id`, `status`, optional `revised_prompt`, and optional saved image path. It flushes any streamed answer separator state, constructs a completed image-generation cell from those values, appends it to history, and requests redraw. It writes transcript/history state and returns no value.

**Call relations**: Called on terminal image-generation events after `on_image_generation_begin`. It delegates formatting to `history_cell::new_image_generation_call`.

*Call graph*: 1 external calls (new_image_generation_call).


##### `ChatWidget::on_file_change_completed`  (lines 46–52)

```
fn on_file_change_completed(&mut self, item: ThreadItem)
```

**Purpose**: Routes a completed file-change `ThreadItem` through the widget’s defer-or-handle mechanism. It preserves the original item for queueing and a clone for immediate handling.

**Data flow**: Takes a `ThreadItem`, clones it, then passes one copy into the deferred queue closure and the other into the immediate handler closure. It mutates either the input queue or current transcript state depending on widget readiness, and returns nothing.

**Call relations**: Invoked when a file-change completion event arrives. If the widget is deferring transcript mutations, it queues the item as completed; otherwise it dispatches to `ChatWidget::handle_file_change_completed_now`.

*Call graph*: 1 external calls (clone).


##### `ChatWidget::on_mcp_tool_call_started`  (lines 54–60)

```
fn on_mcp_tool_call_started(&mut self, item: ThreadItem)
```

**Purpose**: Routes an MCP tool-call start event into either deferred processing or immediate active-cell rendering. It mirrors the file-change completion pattern but for MCP startup.

**Data flow**: Consumes a `ThreadItem`, clones it, and feeds one copy to queue state and one to the immediate-start handler closure. It writes queue or transcript state and returns no value.

**Call relations**: Called when an MCP tool call starts. Depending on defer state, it either stores the start event for later replay or invokes `ChatWidget::handle_mcp_tool_call_started_now` to create the live MCP active cell.

*Call graph*: 1 external calls (clone).


##### `ChatWidget::on_mcp_tool_call_completed`  (lines 62–68)

```
fn on_mcp_tool_call_completed(&mut self, item: ThreadItem)
```

**Purpose**: Routes an MCP tool-call completion event through deferred or immediate handling. It ensures completion can be matched against a previously active MCP cell when possible.

**Data flow**: Accepts a `ThreadItem`, clones it, and passes one copy to the queue and one to the immediate completion handler. It mutates queue or transcript state and returns nothing.

**Call relations**: Triggered on MCP completion. If not deferred, it hands off to `ChatWidget::handle_mcp_tool_call_completed_now`, which performs the actual result conversion and active-cell completion.

*Call graph*: 1 external calls (clone).


##### `ChatWidget::on_web_search_begin`  (lines 70–81)

```
fn on_web_search_begin(&mut self, call_id: String)
```

**Purpose**: Starts a live web-search transcript cell and makes it the current active cell. This gives the UI an animated in-progress row while the search is running.

**Data flow**: Takes a `call_id`, records visible-turn activity, flushes streamed answer content and any existing active cell, then stores a boxed `WebSearchCell`-like active cell built with an empty query string and the animation setting from config. It bumps `active_cell_revision`, requests redraw, and returns nothing.

**Call relations**: Called when web search begins. It replaces any prior active cell and delegates concrete cell creation to `history_cell::new_active_web_search_call`.

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

**Purpose**: Completes a web-search event either by updating the matching active web-search cell in place or by appending a standalone completed history cell. It also marks the turn as having performed work.

**Data flow**: Consumes `call_id`, `query`, and a `WebSearchAction`. After flushing answer-stream separation, it inspects `self.transcript.active_cell`, downcasts it to `WebSearchCell`, and if the `call_id` matches, updates the cell with cloned action/query data, marks it complete, bumps revision, and flushes it into history. If no matching active cell exists, it creates a completed web-search history cell directly. Finally it sets `self.transcript.had_work_activity = true`.

**Call relations**: This is the terminal counterpart to `on_web_search_begin`. Its control flow prefers completing the live active cell, but falls back to `history_cell::new_web_search_call` when events are unmatched or reordered.

*Call graph*: 2 external calls (clone, new_web_search_call).


##### `ChatWidget::on_collab_event`  (lines 111–115)

```
fn on_collab_event(&mut self, cell: PlainHistoryCell)
```

**Purpose**: Appends a collaborator-related history cell after separating it from any streamed assistant output. It is the shared sink for collaborator tool-call and sub-agent activity rendering.

**Data flow**: Takes a ready-made `PlainHistoryCell`, flushes the answer stream with a separator, appends the cell to history, requests redraw, and returns nothing. It mutates transcript/history and UI state only.

**Call relations**: This helper is called by `ChatWidget::on_collab_agent_tool_call` and `ChatWidget::on_sub_agent_activity` once those functions have converted protocol items into displayable collaborator cells.

*Call graph*: called by 2 (on_collab_agent_tool_call, on_sub_agent_activity).


##### `ChatWidget::on_collab_agent_tool_call`  (lines 117–147)

```
fn on_collab_agent_tool_call(&mut self, item: ThreadItem)
```

**Purpose**: Transforms collaborator agent tool-call thread items into transcript cells, with special caching for spawn-agent request summaries. It emits collaborator history only when the helper can derive a meaningful cell from the item.

**Data flow**: Reads a `ThreadItem`, first records visible-turn activity, then pattern-matches it as `ThreadItem::CollabAgentToolCall`. For `SpawnAgent`, it may cache a spawn-request summary in `pending_collab_spawn_requests` while the call is in progress, or remove and reuse that cached summary once the call reaches a terminal status. It then asks `multi_agents::tool_call_history_cell` to build a `PlainHistoryCell`, supplying a metadata lookup closure, and forwards any resulting cell to `on_collab_event`.

**Call relations**: Called on collaborator tool-call lifecycle events. It delegates summary extraction to `multi_agents::spawn_request_summary`, cell construction to `multi_agents::tool_call_history_cell`, and final transcript insertion to `ChatWidget::on_collab_event`.

*Call graph*: calls 3 internal fn (on_collab_event, spawn_request_summary, tool_call_history_cell); 1 external calls (matches!).


##### `ChatWidget::on_sub_agent_activity`  (lines 149–154)

```
fn on_sub_agent_activity(&mut self, item: ThreadItem)
```

**Purpose**: Converts sub-agent activity items into collaborator transcript rows when possible. It is a thin adapter around the multi-agent history-cell builder.

**Data flow**: Accepts a `ThreadItem`, records visible-turn activity, asks `multi_agents::sub_agent_activity_history_cell` for an optional `PlainHistoryCell`, and if present appends it via `on_collab_event`. It mutates transcript/history state and returns nothing.

**Call relations**: Invoked for sub-agent activity notifications. It delegates interpretation of the thread item to `multi_agents::sub_agent_activity_history_cell` and uses `ChatWidget::on_collab_event` as the common rendering path.

*Call graph*: calls 2 internal fn (on_collab_event, sub_agent_activity_history_cell).


##### `ChatWidget::handle_file_change_completed_now`  (lines 156–167)

```
fn handle_file_change_completed_now(&mut self, item: ThreadItem)
```

**Purpose**: Immediately finalizes a file-change completion event in the transcript. Successful patch application leaves the earlier edit block alone, while failed application adds an explicit failure row.

**Data flow**: Consumes a `ThreadItem`, pattern-matches it as `ThreadItem::FileChange`, reads its `status`, and if the status is `PatchApplyStatus::Failed` appends a patch-apply-failure history cell with an empty message. Regardless of success or failure, it sets `self.transcript.had_work_activity = true` and returns nothing.

**Call relations**: This is the immediate handler reached from `ChatWidget::handle_queued_item_completed_now` when a queued completed item is a file change. It only emits extra transcript output on failure because the initial patch event already represents success.

*Call graph*: called by 1 (handle_queued_item_completed_now); 3 external calls (new, new_patch_apply_failure, matches!).


##### `ChatWidget::handle_mcp_tool_call_started_now`  (lines 169–194)

```
fn handle_mcp_tool_call_started_now(&mut self, item: ThreadItem)
```

**Purpose**: Immediately starts rendering an MCP tool call as the active transcript cell. It clears conflicting live content first so the MCP invocation owns the active-cell slot.

**Data flow**: Takes a `ThreadItem`, records visible-turn activity, pattern-matches `id`, `server`, `tool`, and `arguments` from `ThreadItem::McpToolCall`, flushes streamed answer content and any existing active cell, constructs an `McpInvocation` with `arguments: Some(arguments)`, stores a boxed active MCP tool-call cell using animation config, bumps the active-cell revision, requests redraw, and returns nothing.

**Call relations**: Reached from `ChatWidget::handle_queued_item_started_now` for MCP start items. It delegates active-cell construction to `history_cell::new_active_mcp_tool_call`.

*Call graph*: called by 1 (handle_queued_item_started_now); 2 external calls (new, new_active_mcp_tool_call).


##### `ChatWidget::handle_mcp_tool_call_completed_now`  (lines 196–255)

```
fn handle_mcp_tool_call_completed_now(&mut self, item: ThreadItem)
```

**Purpose**: Immediately completes an MCP tool call, reconciling the terminal event with any active MCP cell and converting protocol result/error payloads into the transcript cell’s completion format. It also records that real work occurred during the turn.

**Data flow**: Consumes a `ThreadItem`, flushes answer-stream separation, pattern-matches MCP fields including `result`, `error`, and `duration_ms`, rebuilds an `McpInvocation`, converts `duration_ms` into a nonnegative `Duration`, and maps `(result, error)` into `Result<codex_protocol::mcp::CallToolResult, String>`. It then tries to downcast the current active cell to `McpToolCallCell`; if the `call_id` matches, it completes that cell in place, otherwise it flushes any stale active cell, creates a fresh active MCP cell, completes it immediately, and stores it temporarily. After flushing the completed active cell, it appends any extra boxed history cell returned by `complete` and sets `self.transcript.had_work_activity = true`.

**Call relations**: This is the immediate completion path used by `ChatWidget::handle_queued_item_completed_now` for MCP items. It is the terminal counterpart to `ChatWidget::handle_mcp_tool_call_started_now`, but includes a fallback path for unmatched completions.

*Call graph*: called by 1 (handle_queued_item_completed_now); 3 external calls (new, from_millis, new_active_mcp_tool_call).


##### `ChatWidget::handle_queued_item_started_now`  (lines 257–267)

```
fn handle_queued_item_started_now(&mut self, item: ThreadItem)
```

**Purpose**: Dispatches a queued 'started' thread item to the correct immediate handler based on its variant. It only recognizes command execution and MCP tool-call starts.

**Data flow**: Takes a `ThreadItem`, matches on its enum variant, and forwards command-execution items to the command-start handler and MCP items to the MCP-start handler; all other variants are ignored. It mutates transcript/UI state indirectly through those delegated handlers and returns nothing.

**Call relations**: Used when draining deferred start events. For the functions listed here, its relevant delegation is to `ChatWidget::handle_mcp_tool_call_started_now` when the queued item is `ThreadItem::McpToolCall`.

*Call graph*: calls 1 internal fn (handle_mcp_tool_call_started_now).


##### `ChatWidget::handle_queued_item_completed_now`  (lines 269–278)

```
fn handle_queued_item_completed_now(&mut self, item: ThreadItem)
```

**Purpose**: Dispatches a queued 'completed' thread item to the appropriate immediate completion handler. It centralizes replay of deferred terminal events for command execution, file changes, and MCP calls.

**Data flow**: Consumes a `ThreadItem`, matches its variant, and forwards command execution, file change, and MCP completion items to their specialized handlers while ignoring unrelated variants. It returns no value and mutates transcript/UI state through the delegated handlers.

**Call relations**: This function is the queue-drain dispatcher for completed items. In this file it routes file changes to `ChatWidget::handle_file_change_completed_now` and MCP completions to `ChatWidget::handle_mcp_tool_call_completed_now`.

*Call graph*: calls 2 internal fn (handle_file_change_completed_now, handle_mcp_tool_call_completed_now).


### `tui/src/diff_model.rs`

`data_model` · `interactive UI`

This file introduces `FileChange`, a small enum that models the kinds of file modifications the TUI needs to display in diff-oriented interfaces. The enum derives `Debug`, `Clone`, `PartialEq`, `Serialize`, and `Deserialize`, which makes it suitable both for in-memory UI state comparisons and for transport or persistence through serde-based formats. Its serde configuration uses an externally tagged shape with a `type` discriminator in `snake_case`, so serialized values are explicit and stable across boundaries. The `Add` and `Delete` variants each carry the full file `content` as a `String`, reflecting that for pure additions or removals the renderer can show the entire body directly. The `Update` variant instead carries a `unified_diff` string plus an optional `move_path: Option<PathBuf>`, allowing the UI to render patch-style edits and also indicate renames or moves when the updated file originated from another path. The model is intentionally minimal: it does not attempt to represent every VCS nuance, only the information needed by TUI diff rendering and approval-preview flows. That keeps serialization simple and avoids coupling the UI to a heavier patch engine or repository-specific change model.


### `tui/src/history_cell/separators.rs`

`domain_logic` · `end-of-turn transcript rendering, especially after tool-heavy assistant turns complete`

This file renders the horizontal divider that can appear before a final assistant message when the turn performed concrete work. `FinalMessageSeparator` stores optional elapsed turn duration and optional `RuntimeMetricsSummary`. Its rich rendering first builds a list of label fragments: a `Worked for ...` fragment only when elapsed time exceeds 60 seconds, plus a metrics fragment from `runtime_metrics_label` when runtime counters are non-empty. If no fragments exist, it returns a full-width dim line of box-drawing `─` characters. Otherwise it joins fragments with ` • `, wraps them inside `─ <label> ─`, truncates the prefix to terminal width using `take_prefix_by_width`, and pads the remainder with more `─` characters so the separator always fills the viewport width.

Raw mode uses the same fragment-building logic but returns either an empty vector when there is nothing meaningful to say or a single plain line containing the joined label text. `runtime_metrics_label` is the substantive formatter: it inspects each metrics bucket in `RuntimeMetricsSummary` and emits human-readable fragments for local tool calls, inference/API calls, websocket sends and receives, streaming events, and several Responses API timing fields including overhead, inference time, TTFT, and TBT. Durations are normalized by `format_duration_ms`, which switches from milliseconds to one-decimal-place seconds at 1000 ms, and plural-sensitive nouns are chosen by `pluralize`.

#### Function details

##### `FinalMessageSeparator::new`  (lines 17–25)

```
fn new(
        elapsed_seconds: Option<u64>,
        runtime_metrics: Option<RuntimeMetricsSummary>,
    ) -> Self
```

**Purpose**: Constructs a separator cell from optional elapsed-turn duration and optional runtime metrics.

**Data flow**: It takes `elapsed_seconds: Option<u64>` and `runtime_metrics: Option<RuntimeMetricsSummary>`, stores them in a new `FinalMessageSeparator`, and returns it.

**Call relations**: Turn-completion and streaming-finalization paths create this cell when they want to insert a divider before the final assistant message; tests also instantiate it directly.

*Call graph*: called by 4 (handle_streaming_delta, on_task_complete, final_message_separator_hides_short_worked_label_and_includes_runtime_metrics, final_message_separator_includes_worked_label_after_one_minute).


##### `FinalMessageSeparator::display_lines`  (lines 28–54)

```
fn display_lines(&self, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Renders a full-width dim separator line, optionally embedding elapsed-work and runtime-metrics labels.

**Data flow**: It builds `label_parts` by formatting `elapsed_seconds` only when greater than 60 via `fmt_elapsed_compact`, and by converting `runtime_metrics` through `runtime_metrics_label`. If `label_parts` is empty it returns one line of repeated `─` sized to `width`. Otherwise it joins parts with ` • `, wraps them as `─ {label} ─`, truncates that prefix to fit `width` using `take_prefix_by_width`, appends enough `─` characters to fill the remaining width, dims the whole line, and returns it.

**Call relations**: Main viewport rendering uses this rich representation to visually separate work-heavy turns from the assistant’s final message.

*Call graph*: 3 external calls (new, format!, vec!).


##### `FinalMessageSeparator::raw_lines`  (lines 56–73)

```
fn raw_lines(&self) -> Vec<Line<'static>>
```

**Purpose**: Produces a plain-text separator summary containing only meaningful labels and omitting decorative line art when there is nothing to report.

**Data flow**: It rebuilds the same `label_parts` as `display_lines`; if none exist it returns an empty vector, otherwise it returns a single `Line` containing the joined fragments separated by ` • `.

**Call relations**: Raw transcript mode uses this to preserve semantic labels without decorative box-drawing characters.

*Call graph*: 3 external calls (new, format!, vec!).


##### `runtime_metrics_label`  (lines 76–158)

```
fn runtime_metrics_label(summary: RuntimeMetricsSummary) -> Option<String>
```

**Purpose**: Formats a `RuntimeMetricsSummary` into a single human-readable label string describing counts and durations for each non-empty metrics category.

**Data flow**: It inspects each field of `summary`: local tool calls, API calls, websocket sends, streaming events, websocket receives, Responses API overhead, inference time, TTFT, and TBT. For each non-zero count or duration it formats a fragment using `format_duration_ms` and `pluralize`, accumulates fragments in `parts`, and returns `None` if `parts` stays empty or `Some(parts.join(" • "))` otherwise.

**Call relations**: Both separator renderers call this helper to decide whether runtime metrics should appear and to obtain the exact label text.

*Call graph*: calls 2 internal fn (format_duration_ms, pluralize); 2 external calls (new, format!).


##### `format_duration_ms`  (lines 160–167)

```
fn format_duration_ms(duration_ms: u64) -> String
```

**Purpose**: Formats a duration in milliseconds as either `Nms` or `S.s` seconds depending on magnitude.

**Data flow**: It reads `duration_ms`; values at least 1000 are converted to floating-point seconds and formatted with one decimal place plus `s`, while smaller values are formatted as integer milliseconds plus `ms`.

**Call relations**: Only `runtime_metrics_label` uses this helper so all metrics durations share the same threshold and formatting style.

*Call graph*: called by 1 (runtime_metrics_label); 1 external calls (format!).


##### `pluralize`  (lines 169–171)

```
fn pluralize(count: u64, singular: &'static str, plural: &'static str) -> &'static str
```

**Purpose**: Chooses between singular and plural label text based on a numeric count.

**Data flow**: It reads `count`, `singular`, and `plural`, returning `singular` when `count == 1` and `plural` otherwise.

**Call relations**: `runtime_metrics_label` uses this helper to produce grammatically correct fragments such as `call` vs `calls` and `event` vs `events`.

*Call graph*: called by 1 (runtime_metrics_label).


### `tui/src/insert_history.rs`

`io_transport` · `history replay`

This module is the terminal-side plumbing for finalized transcript insertion. Rather than redrawing old history inside the ratatui viewport, it emits escape sequences through the terminal backend so completed rows live in the terminal’s own scrollback. The public entry points progressively add options: `insert_history_lines`, `insert_history_lines_with_wrap_policy`, and `insert_history_lines_with_mode_and_wrap_policy`, all funneling into `insert_history_hyperlink_lines_with_mode_and_wrap_policy`. That core function inspects the current screen size and viewport, pre-wraps lines when requested, and treats URL-heavy lines specially: pure URL-like lines are left unbroken so terminal hyperlink detection and soft-wrap metadata survive, while mixed URL/prose lines use adaptive wrapping with `leading_whitespace_prefix` as the continuation indent. Two insertion modes exist. `Standard` manipulates the terminal scroll region above the viewport, optionally scrolling the viewport downward to make room, writes each history line with `write_history_line`, then restores the cursor. `ZellijRaw` instead clears the viewport area, writes raw lines directly through the terminal to preserve soft-wrap behavior in Zellij, appends blank viewport rows, and updates the viewport origin accordingly. `write_history_line` clears continuation rows for wide lines, merges line-level style into spans, decorates hyperlinks, and delegates ANSI emission to `write_spans`. `ModifierDiff` computes incremental attribute changes so style transitions reset correctly, especially around bold/dim interactions. The extensive tests use a VT100 backend to verify color propagation, prefix preservation across wraps, URL handling, terminal-wrap mode, and Zellij raw replay behavior.

#### Function details

##### `insert_history_lines`  (lines 61–69)

```
fn insert_history_lines(
    terminal: &mut crate::custom_terminal::Terminal<B>,
    lines: Vec<Line>,
) -> io::Result<()>
```

**Purpose**: Convenience entry point that inserts plain `Line` history using the default pre-wrap policy.

**Data flow**: Consumes a mutable custom terminal and a `Vec<Line>`, forwards them to `insert_history_lines_with_wrap_policy` with `HistoryLineWrapPolicy::PreWrap`, and returns the resulting `io::Result<()>`.

**Call relations**: Called broadly by app code and tests whenever finalized history should be pushed into scrollback without special wrapping options.

*Call graph*: calls 1 internal fn (insert_history_lines_with_wrap_policy); called by 22 (thread_goal_ephemeral_error_message_renders_snapshot, chained_config_error_wraps_in_history_snapshot, app_server_guardian_review_denied_renders_denied_request_snapshot, app_server_guardian_review_timed_out_renders_timed_out_request_snapshot, guardian_approved_exec_renders_approved_request, guardian_approved_request_permissions_renders_request_summary, guardian_denied_exec_renders_warning_and_denied_request, guardian_timed_out_exec_renders_warning_and_timed_out_request, app_server_mcp_startup_failure_renders_warning_history, chatwidget_exec_and_status_layout_vt100_snapshot (+12 more)).


##### `insert_history_lines_with_wrap_policy`  (lines 71–85)

```
fn insert_history_lines_with_wrap_policy(
    terminal: &mut crate::custom_terminal::Terminal<B>,
    lines: Vec<Line>,
    wrap_policy: HistoryLineWrapPolicy,
) -> io::Result<()>
```

**Purpose**: Inserts plain `Line` history while letting the caller choose between Codex pre-wrapping and terminal soft-wrap behavior.

**Data flow**: Consumes the terminal, lines, and a `HistoryLineWrapPolicy`, forwards them to `insert_history_lines_with_mode_and_wrap_policy` with `InsertHistoryMode::Standard`, and returns its result.

**Call relations**: Used by the default entry point and tests that specifically exercise terminal-wrap behavior.

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

**Purpose**: Converts plain `Line` values into hyperlink-aware lines and inserts them using the selected mode and wrap policy.

**Data flow**: Consumes the terminal, lines, insertion mode, and wrap policy; converts each line to `'static` with `line_to_static`, wraps them with `plain_hyperlink_lines`, and forwards to `insert_history_hyperlink_lines_with_mode_and_wrap_policy`.

**Call relations**: Bridges plain history rendering to the hyperlink-aware core insertion path. Tests call it directly for Zellij raw mode.

*Call graph*: calls 2 internal fn (insert_history_hyperlink_lines_with_mode_and_wrap_policy, plain_hyperlink_lines); called by 3 (insert_history_lines_with_wrap_policy, vt100_zellij_raw_insert_keeps_soft_wrapped_tail_above_viewport, vt100_zellij_raw_replay_keeps_overflowing_soft_wrapped_tail_above_viewport).


##### `insert_history_hyperlink_lines_with_mode_and_wrap_policy`  (lines 104–256)

```
fn insert_history_hyperlink_lines_with_mode_and_wrap_policy(
    terminal: &mut crate::custom_terminal::Terminal<B>,
    lines: Vec<HyperlinkLine>,
    mode: InsertHistoryMode,
    wrap_policy: Histor
```

**Purpose**: Core scrollback insertion routine that wraps lines, writes them above the viewport, updates viewport geometry, and records inserted row counts.

**Data flow**: Reads screen size from the backend and current viewport/cursor state from the terminal. It computes `wrap_width`, transforms each `HyperlinkLine` according to `wrap_policy` and URL heuristics (`line_contains_url_like`, `line_has_mixed_url_and_non_url_tokens`, `adaptive_wrap_line`, `remap_wrapped_line`, `leading_whitespace_prefix`), counts resulting physical rows, and then executes one of two write strategies. In `ZellijRaw`, it clears the viewport area, writes lines directly with CRLFs and `write_history_line`, appends blank viewport rows, restores the cursor, and may move the viewport downward. In `Standard`, it may first scroll the viewport down by adjusting the lower scroll region, then sets the scroll region above the viewport, writes each line preceded by CRLF, resets the scroll region, and restores the cursor. Finally it updates the terminal viewport area if needed and calls `note_history_rows_inserted` when rows were added.

**Call relations**: This is the central implementation behind all public insertion APIs and the pending-history flush path. It delegates per-line output to `write_history_line` and wrapping details to helpers from `wrapping` and `terminal_hyperlinks`.

*Call graph*: calls 12 internal fn (backend, backend_mut, clear_after_position, note_history_rows_inserted, set_viewport_area, leading_whitespace_prefix, write_history_line, remap_wrapped_line, new, adaptive_wrap_line (+2 more)); called by 2 (insert_history_lines_with_mode_and_wrap_policy, flush_pending_history_lines); 4 external calls (new, new, queue!, vec!).


##### `leading_whitespace_prefix`  (lines 258–277)

```
fn leading_whitespace_prefix(line: &Line<'_>) -> Line<'static>
```

**Purpose**: Extracts the leading whitespace prefix from a styled line so wrapped continuation rows can preserve indentation.

**Data flow**: Borrows a `Line`, walks spans from the start, slices each span up to its first non-whitespace character, preserves span styles for those whitespace prefixes, stops once non-whitespace content is encountered, and returns a new `Line<'static>` containing only the collected prefix spans with the original line style.

**Call relations**: Used during adaptive wrapping in history insertion and elsewhere when wrapped continuation rows should align under existing indentation.

*Call graph*: called by 2 (display_hyperlink_lines, insert_history_hyperlink_lines_with_mode_and_wrap_policy); 3 external calls (from, styled, new).


##### `write_history_line`  (lines 282–329)

```
fn write_history_line(
    writer: &mut W,
    line: &HyperlinkLine,
    wrap_width: usize,
) -> io::Result<()>
```

**Purpose**: Writes one hyperlink-aware history line to the terminal, clearing any continuation rows and emitting merged ANSI styling.

**Data flow**: Accepts a writer, `HyperlinkLine`, and wrap width; computes how many physical rows the line will occupy, clears continuation rows below the cursor when the line spans multiple rows, sets line-level foreground/background colors, clears the current row, merges line style into each span, decorates spans with terminal hyperlink escape sequences, and writes the resulting spans via `write_spans`.

**Call relations**: Called by the core insertion routine for every rendered history line and directly by one hyperlink test. It sits between wrapped line preparation and low-level ANSI span emission.

*Call graph*: calls 3 internal fn (write_spans, width, decorate_spans); called by 2 (insert_history_hyperlink_lines_with_mode_and_wrap_policy, writes_semantic_web_link_without_changing_visible_text); 2 external calls (from, queue!).


##### `SetScrollRegion::write_ansi`  (lines 335–337)

```
fn write_ansi(&self, f: &mut impl fmt::Write) -> fmt::Result
```

**Purpose**: Serializes the custom scroll-region command as an ANSI escape sequence.

**Data flow**: Writes `\x1b[{start};{end}r` into the provided formatter using the stored `Range<u16>`.

**Call relations**: Used by crossterm `queue!` calls in standard history insertion when constraining scrolling above the viewport.

*Call graph*: 1 external calls (write!).


##### `SetScrollRegion::execute_winapi`  (lines 340–342)

```
fn execute_winapi(&self) -> std::io::Result<()>
```

**Purpose**: Rejects WinAPI execution for this command because the module expects ANSI-mode operation.

**Data flow**: Panics unconditionally with a message instructing callers to use ANSI instead.

**Call relations**: Only relevant on Windows builds if crossterm attempted a WinAPI path; the module intentionally relies on ANSI support.

*Call graph*: 1 external calls (panic!).


##### `SetScrollRegion::is_ansi_code_supported`  (lines 345–348)

```
fn is_ansi_code_supported(&self) -> bool
```

**Purpose**: Reports that ANSI execution is supported for the custom scroll-region command.

**Data flow**: Returns `true`.

**Call relations**: Part of the `crossterm::Command` implementation used during queued terminal writes.


##### `ResetScrollRegion::write_ansi`  (lines 355–357)

```
fn write_ansi(&self, f: &mut impl fmt::Write) -> fmt::Result
```

**Purpose**: Serializes the ANSI escape sequence that resets the terminal scroll region to the full screen.

**Data flow**: Writes `\x1b[r` into the provided formatter.

**Call relations**: Queued after history insertion to restore normal terminal scrolling.

*Call graph*: 1 external calls (write!).


##### `ResetScrollRegion::execute_winapi`  (lines 360–362)

```
fn execute_winapi(&self) -> std::io::Result<()>
```

**Purpose**: Rejects WinAPI execution for scroll-region reset for the same reason as `SetScrollRegion`.

**Data flow**: Panics unconditionally.

**Call relations**: Windows-only fallback guard in the custom command implementation.

*Call graph*: 1 external calls (panic!).


##### `ResetScrollRegion::is_ansi_code_supported`  (lines 365–368)

```
fn is_ansi_code_supported(&self) -> bool
```

**Purpose**: Reports that ANSI execution is supported for scroll-region reset.

**Data flow**: Returns `true`.

**Call relations**: Used by crossterm when queuing the reset command.


##### `ModifierDiff::queue`  (lines 377–435)

```
fn queue(self, mut w: W) -> io::Result<()>
```

**Purpose**: Emits the minimal sequence of crossterm attribute changes needed to transition from one `Modifier` set to another.

**Data flow**: Consumes `self` and a writer, computes removed modifiers (`from - to`) and added modifiers (`to - from`), queues the corresponding `SetAttribute` commands in an order that handles interactions like bold/dim reset correctly, and returns `io::Result<()>`.

**Call relations**: Used by `write_spans` whenever the next span’s modifier set differs from the previous one.

*Call graph*: 2 external calls (contains, queue!).


##### `write_spans`  (lines 438–477)

```
fn write_spans(mut writer: &mut impl Write, content: I) -> io::Result<()>
```

**Purpose**: Writes a sequence of styled spans as ANSI output, tracking foreground/background colors and text modifiers incrementally.

**Data flow**: Iterates borrowed spans, derives each span’s effective modifier set from `add_modifier` and `sub_modifier`, emits modifier transitions via `ModifierDiff::queue`, updates colors with `SetColors` when fg/bg change, prints span content, and finally resets foreground, background, and attributes to defaults.

**Call relations**: Called by `write_history_line` and directly by a unit test. It is the lowest-level style-emission helper in this module.

*Call graph*: called by 2 (writes_bold_then_regular_spans, write_history_line); 2 external calls (empty, queue!).


##### `tests::writes_bold_then_regular_spans`  (lines 488–513)

```
fn writes_bold_then_regular_spans()
```

**Purpose**: Verifies that `write_spans` emits the expected ANSI sequence when transitioning from bold text back to regular text.

**Data flow**: Builds two spans (`A` bold, `B` plain), writes them with `write_spans` into a byte buffer, constructs the expected crossterm command sequence into another buffer, and compares the UTF-8 strings.

**Call relations**: Direct unit test of `write_spans` and modifier reset behavior.

*Call graph*: calls 1 internal fn (write_spans); 3 external calls (new, assert_eq!, queue!).


##### `tests::writes_semantic_web_link_without_changing_visible_text`  (lines 516–526)

```
fn writes_semantic_web_link_without_changing_visible_text()
```

**Purpose**: Checks that hyperlink decoration adds OSC 8 escape sequences while leaving the visible text unchanged.

**Data flow**: Annotates a line containing a URL with `annotate_web_urls_in_line`, writes it with `write_history_line`, decodes the output, and asserts the hyperlink escape sequence is present while the original span content still equals the destination string.

**Call relations**: Exercises `write_history_line` plus hyperlink decoration from `terminal_hyperlinks`.

*Call graph*: calls 2 internal fn (write_history_line, annotate_web_urls_in_line); 5 external calls (from, from_utf8, new, assert!, assert_eq!).


##### `tests::vt100_blockquote_line_emits_green_fg`  (lines 529–561)

```
fn vt100_blockquote_line_emits_green_fg()
```

**Purpose**: Verifies that line-level foreground color on a blockquote-like line survives history insertion into a VT100 terminal backend.

**Data flow**: Creates a small off-screen terminal, positions the viewport at the bottom, builds a green `Line` beginning with `> `, inserts it with `insert_history_lines`, scans the VT100 screen for any non-default foreground cell, and asserts one exists.

**Call relations**: Integration-style test of line-style merging and ANSI emission through the full insertion path.

*Call graph*: calls 3 internal fn (with_options, insert_history_lines, new); 4 external calls (from, new, assert!, vec!).


##### `tests::vt100_blockquote_wrap_preserves_color_on_all_wrapped_lines`  (lines 564–627)

```
fn vt100_blockquote_wrap_preserves_color_on_all_wrapped_lines()
```

**Purpose**: Checks that a long colored blockquote keeps its non-default foreground color on every wrapped row, not just the first.

**Data flow**: Creates a narrow VT100 terminal, inserts a long green blockquote line, collects non-empty screen rows, asserts there are at least two, and then asserts every non-space cell on those rows has a non-default foreground color.

**Call relations**: Covers `write_history_line`’s line-style merging across wrapped physical rows.

*Call graph*: calls 3 internal fn (with_options, insert_history_lines, new); 5 external calls (from, new, new, assert!, vec!).


##### `tests::vt100_colored_prefix_then_plain_text_resets_color`  (lines 630–685)

```
fn vt100_colored_prefix_then_plain_text_resets_color()
```

**Purpose**: Verifies that a colored prefix span does not leak its color into following plain text after history insertion.

**Data flow**: Builds a line with a light-blue `1. ` prefix span and plain `Hello world` span, inserts it, finds the first non-empty row in the VT100 screen, and asserts the prefix cells are colored while the content cells are default-colored.

**Call relations**: Exercises span-level color transitions and reset behavior in `write_spans`.

*Call graph*: calls 3 internal fn (with_options, insert_history_lines, new); 5 external calls (from, new, assert!, assert_eq!, vec!).


##### `tests::vt100_deep_nested_mixed_list_third_level_marker_is_colored`  (lines 688–736)

```
fn vt100_deep_nested_mixed_list_third_level_marker_is_colored()
```

**Purpose**: Checks that markdown-rendered nested list markers retain their semantic color while following content resets to default.

**Data flow**: Renders nested markdown to `Line`s, inserts them into a VT100 terminal, reconstructs screen rows, locates the row containing `1. Third level (ordered)`, and asserts the `1.` marker cells are colored while the content cell after the space is default-colored.

**Call relations**: Integration test spanning markdown rendering, history insertion, and ANSI style transitions.

*Call graph*: calls 4 internal fn (with_options, insert_history_lines, render_markdown_text, new); 3 external calls (assert!, assert_eq!, new).


##### `tests::vt100_prefixed_url_keeps_prefix_and_url_on_same_row`  (lines 739–762)

```
fn vt100_prefixed_url_keeps_prefix_and_url_on_same_row()
```

**Purpose**: Verifies that a prefixed URL line is not pre-wrapped in a way that leaves the prefix orphaned on its own row.

**Data flow**: Creates a VT100 terminal, inserts one line consisting of prefix `  │ ` plus a long URL, collects screen rows, and asserts some row contains `│ http://a-long-url.com` while no row trims to just `│`.

**Call relations**: Covers the URL-only wrapping heuristic in `insert_history_hyperlink_lines_with_mode_and_wrap_policy`.

*Call graph*: calls 3 internal fn (with_options, insert_history_lines, new); 4 external calls (from, new, assert!, vec!).


##### `tests::vt100_prefixed_url_like_without_scheme_keeps_prefix_and_token_on_same_row`  (lines 765–790)

```
fn vt100_prefixed_url_like_without_scheme_keeps_prefix_and_token_on_same_row()
```

**Purpose**: Checks the same orphan-prefix avoidance for URL-like tokens that lack an explicit scheme.

**Data flow**: Inserts a prefixed URL-like token into a VT100 terminal, collects rows, and asserts the prefix and token start appear together while no row contains only the prefix.

**Call relations**: Exercises URL-like detection beyond standard `http://` URLs.

*Call graph*: calls 3 internal fn (with_options, insert_history_lines, new); 4 external calls (from, new, assert!, vec!).


##### `tests::vt100_prefixed_mixed_url_line_wraps_suffix_words_together`  (lines 793–820)

```
fn vt100_prefixed_mixed_url_line_wraps_suffix_words_together()
```

**Purpose**: Verifies adaptive wrapping for mixed prose + URL + trailing prose lines, ensuring suffix words wrap as a phrase rather than being split awkwardly.

**Data flow**: Inserts a line with prefix, `see `, a URL, and ` tail words`, collects screen rows, and asserts one row contains the prefixed prose and another contains `tail words` together.

**Call relations**: Covers the mixed URL/non-URL adaptive wrapping branch.

*Call graph*: calls 3 internal fn (with_options, insert_history_lines, new); 4 external calls (from, new, assert!, vec!).


##### `tests::vt100_prefixed_mixed_url_line_preserves_prefix_on_wrapped_rows`  (lines 823–853)

```
fn vt100_prefixed_mixed_url_line_preserves_prefix_on_wrapped_rows()
```

**Purpose**: Checks that wrapped continuation rows of mixed-content prefixed lines keep the original leading whitespace prefix.

**Data flow**: Inserts a long prefixed mixed-content line into a narrow VT100 terminal, finds a continuation row containing later prose, and asserts that row starts with the original two-space prefix.

**Call relations**: Exercises `leading_whitespace_prefix` as used during adaptive wrapping.

*Call graph*: calls 3 internal fn (with_options, insert_history_lines, new); 4 external calls (from, new, assert!, vec!).


##### `tests::vt100_prefixed_non_url_line_preserves_prefix_on_wrapped_rows`  (lines 856–885)

```
fn vt100_prefixed_non_url_line_preserves_prefix_on_wrapped_rows()
```

**Purpose**: Verifies the same continuation-prefix preservation for long non-URL lines.

**Data flow**: Inserts a long line beginning with six spaces, finds a continuation row containing later text, and asserts it starts with the same six-space prefix.

**Call relations**: Covers the non-URL adaptive wrapping path using `leading_whitespace_prefix`.

*Call graph*: calls 3 internal fn (with_options, insert_history_lines, new); 4 external calls (from, new, assert!, vec!).


##### `tests::vt100_terminal_wrap_policy_does_not_pre_wrap_long_paragraph`  (lines 888–911)

```
fn vt100_terminal_wrap_policy_does_not_pre_wrap_long_paragraph()
```

**Purpose**: Checks that `HistoryLineWrapPolicy::Terminal` leaves long paragraphs unbroken so the terminal performs soft wrapping itself.

**Data flow**: Inserts one long paragraph line with terminal-wrap policy into a narrow VT100 terminal, collects rows, and asserts a row contains the terminal-soft-wrapped fragment `alpha beta gamma del`.

**Call relations**: Directly tests the alternate wrap-policy branch in the public API.

*Call graph*: calls 3 internal fn (with_options, insert_history_lines_with_wrap_policy, new); 4 external calls (from, new, assert!, vec!).


##### `tests::vt100_zellij_raw_insert_keeps_soft_wrapped_tail_above_viewport`  (lines 914–951)

```
fn vt100_zellij_raw_insert_keeps_soft_wrapped_tail_above_viewport()
```

**Purpose**: Verifies that Zellij raw insertion preserves the soft-wrapped tail of a long raw line above the viewport rather than letting it spill through the viewport area.

**Data flow**: Creates a VT100 terminal with a two-row viewport near the bottom, inserts one long raw line using `InsertHistoryMode::ZellijRaw` and terminal wrapping, snapshots the full screen, then asserts `tail-must-remain` appears in rows above `viewport_area.y` and not inside viewport rows.

**Call relations**: Exercises the Zellij-specific raw insertion strategy and viewport repositioning logic.

*Call graph*: calls 3 internal fn (with_options, insert_history_lines_with_mode_and_wrap_policy, new); 6 external calls (from, new, assert!, assert_snapshot!, from, vec!).


##### `tests::vt100_zellij_raw_replay_keeps_overflowing_soft_wrapped_tail_above_viewport`  (lines 954–990)

```
fn vt100_zellij_raw_replay_keeps_overflowing_soft_wrapped_tail_above_viewport()
```

**Purpose**: Checks the same Zellij raw invariant when replay starts with the viewport at the top and the raw line overflows by many rows.

**Data flow**: Creates a VT100 terminal with viewport at y=0, inserts an extremely long raw line in Zellij raw mode, snapshots the screen, and asserts the tail text remains above the final viewport and not inside it.

**Call relations**: Covers the replay/overflow variant of the Zellij raw path.

*Call graph*: calls 3 internal fn (with_options, insert_history_lines_with_mode_and_wrap_policy, new); 7 external calls (from, new, assert!, format!, assert_snapshot!, from, vec!).


##### `tests::vt100_unwrapped_url_like_clears_continuation_rows`  (lines 993–1030)

```
fn vt100_unwrapped_url_like_clears_continuation_rows()
```

**Purpose**: Verifies that when an unwrapped URL-like line reuses continuation rows previously occupied by longer content, those rows are cleared before writing the new wrapped tail.

**Data flow**: Inserts a long filler line that wraps, then inserts a shorter URL-like line, collects screen rows, locates the URL row and its continuation row, and asserts the continuation contains the URL tail but no leftover `X` characters from the filler.

**Call relations**: Exercises `write_history_line`’s continuation-row clearing logic for terminal-soft-wrapped URL-like lines.

*Call graph*: calls 3 internal fn (with_options, insert_history_lines, new); 4 external calls (from, new, assert!, vec!).


##### `tests::vt100_long_unwrapped_url_does_not_insert_extra_blank_gap_before_content`  (lines 1033–1065)

```
fn vt100_long_unwrapped_url_does_not_insert_extra_blank_gap_before_content()
```

**Purpose**: Checks that inserting a long unwrapped URL-like line does not create an unexpected blank gap between the previous history row and the URL content.

**Data flow**: Inserts a prompt line, then inserts a long bullet-prefixed URL line, collects screen rows, finds the prompt row and URL row, and asserts the URL appears immediately after the prompt allowing at most one spacer row.

**Call relations**: Guards scroll-region and row-count accounting for long terminal-wrapped URL lines.

*Call graph*: calls 3 internal fn (with_options, insert_history_lines, new); 5 external calls (from, new, assert!, format!, vec!).


### `tui/src/thread_transcript.rs`

`domain_logic` · `history loading`

This file bridges stored thread data into the history-cell abstraction used by the TUI transcript view. `load_session_transcript` is the async entry point: it asks `AppServerSession` to read a thread with turns included, converts any app-server error into `std::io::Error`, and then delegates to `thread_to_transcript_cells`.

`thread_to_transcript_cells` walks every item in every turn, using the thread’s `cwd` as rendering context. It gives special treatment to the main conversational item types. `UserMessage` is converted into a core `UserMessageItem`, then wrapped in `UserHistoryCell` with extracted message text and image references. `AgentMessage` is parsed through `parse_assistant_markdown`, and only non-empty visible markdown becomes an `AgentMarkdownCell`, so hidden directives do not create blank transcript entries. `Plan` becomes a proposed-plan history cell only when non-blank. `Reasoning` chooses between raw `content` and summarized `summary` based on `RawReasoningVisibility`, joins paragraphs with blank lines, and emits a `ReasoningSummaryCell` only when the resulting text is non-empty.

All other supported protocol variants flow through `fallback_transcript_cell`, which synthesizes dim `PlainHistoryCell` lines for hook prompts, command executions, file changes, tool calls, sub-agent activity, web searches, image operations, review mode transitions, and context compaction. Some variants intentionally return `None`, including the already-special-cased message types and `Sleep`. If no cells are produced at all, the file inserts a single italic, dim `No transcript content available` placeholder.

#### Function details

##### `load_session_transcript`  (lines 28–41)

```
async fn load_session_transcript(
    app_server: &mut AppServerSession,
    thread_id: ThreadId,
    raw_reasoning_visibility: RawReasoningVisibility,
) -> std::io::Result<TranscriptCells>
```

**Purpose**: Fetches a persisted thread with turns from the app server and converts it into transcript cells for display. It is the async boundary between remote session state and local rendering structures.

**Data flow**: Takes a mutable `AppServerSession`, `thread_id`, and `raw_reasoning_visibility`. It awaits `app_server.thread_read(thread_id, true)`, maps any error with `std::io::Error::other`, then passes the returned `Thread` reference into `thread_to_transcript_cells` and returns the resulting `TranscriptCells` inside `io::Result`.

**Call relations**: Called by the app-server page loader when a transcript page needs to be populated. It delegates all item-by-item conversion logic to `thread_to_transcript_cells`.

*Call graph*: calls 2 internal fn (thread_read, thread_to_transcript_cells); called by 1 (spawn_app_server_page_loader).


##### `thread_to_transcript_cells`  (lines 43–121)

```
fn thread_to_transcript_cells(
    thread: &Thread,
    raw_reasoning_visibility: RawReasoningVisibility,
) -> TranscriptCells
```

**Purpose**: Transforms a protocol `Thread` into an ordered vector of `Arc<dyn HistoryCell>` objects, using specialized cell types for core conversational items and plain-text fallbacks for many auxiliary events.

**Data flow**: Reads `thread.cwd` and iterates `thread.turns` flattened to items. For `UserMessage`, it constructs a core `UserMessageItem` and then a `UserHistoryCell`; for `AgentMessage`, it parses markdown and conditionally creates `AgentMarkdownCell`; for `Plan`, it conditionally creates a proposed-plan cell; for `Reasoning`, it selects raw content or summary based on `raw_reasoning_visibility`, joins paragraphs, and conditionally creates `ReasoningSummaryCell`. All other items are passed to `fallback_transcript_cell`, and any returned `PlainHistoryCell` is boxed into `Arc<dyn HistoryCell>`. If no cells were produced, it appends a dim italic placeholder cell and returns the vector.

**Call relations**: This function is the core transcript conversion routine called by `load_session_transcript`. It delegates markdown parsing to `parse_assistant_markdown`, plan creation to `new_proposed_plan`, and miscellaneous item rendering to `fallback_transcript_cell`.

*Call graph*: calls 5 internal fn (parse_assistant_markdown, new, new, new, fallback_transcript_cell); called by 1 (load_session_transcript); 5 external calls (new, new, new_proposed_plan, matches!, vec!).


##### `fallback_transcript_cell`  (lines 123–233)

```
fn fallback_transcript_cell(item: &ThreadItem) -> Option<PlainHistoryCell>
```

**Purpose**: Builds a dim `PlainHistoryCell` summary for non-primary thread item variants that still deserve transcript visibility. It condenses structured protocol events into one or more human-readable lines.

**Data flow**: Takes `item: &ThreadItem`, matches on many variants, and constructs a `Vec<Line<'static>>` describing the event: hook prompt fragments, shell command plus status/output, file-change counts, MCP/dynamic/collab tool calls, sub-agent activity summaries, web searches, image views/generation, review mode transitions, and context compaction. For already-special-cased variants and `Sleep`, it returns `None`; otherwise it returns `Some(PlainHistoryCell::new(lines))` when lines are non-empty.

**Call relations**: Called from `thread_to_transcript_cells` for every thread item not handled by the primary match arms. It encapsulates the fallback rendering policy so the main conversion loop stays focused on richer cell types.

*Call graph*: called by 1 (thread_to_transcript_cells); 2 external calls (format!, vec!).

## 📊 State Registers Touched

- `reg-effective-config` — The final merged settings from defaults, managed config, user files, project files, thread overrides, and command-line flags.
- `reg-config-manager-and-lockfile` — The shared service that serves the latest config and records the exact config snapshot a session used.
- `reg-connector-and-app-catalog` — The merged list of external apps and connectors the system can use.
- `reg-state-runtime` — The shared runtime object holding opened local databases and services for state, logs, goals, and memories.
- `reg-sqlite-datastores` — The app’s on-disk SQLite databases that keep runtime metadata, queues, goals, logs, and related records.
- `reg-thread-store-and-rollout-history` — The durable record of threads, conversation items, and rollout history that lets sessions be resumed and replayed.
- `reg-thread-metadata-index` — The searchable metadata index for threads, including names, archive state, links, and sync status.
- `reg-rate-limit-status` — The current account usage and rate-limit status that can block or shape work.
- `reg-server-runtime` — The live server and daemon runtime that accepts clients, routes messages, and keeps shared server services running.
- `reg-connection-registry` — The shared record of connected clients, connection ids, subscriptions, and where replies should be sent.
- `reg-ui-session-state` — The live user-interface session state for terminal or exec mode, including startup flow, visible widgets, and status views.
- `reg-active-session-object` — The long-lived session object that carries shared services and conversation state across many turns.
- `reg-live-thread-registry` — The in-memory registry of currently loaded conversation threads and their live handles.
- `reg-thread-runtime-state` — The mutable per-thread runtime state used to track listeners, active turns, interrupts, and subscriptions.
- `reg-session-history-and-context` — The session-wide conversation history and restored context that later turns keep reading and updating.
- `reg-session-settings` — The session’s sticky runtime settings such as selected model, environment, connector choices, and memory mode.
- `reg-session-permission-grants` — The remembered approvals and sticky permission grants that survive across turns in a session.
- `reg-token-budget-and-compaction-state` — The running token budget, context-growth tracking, and compaction window state used to keep prompts within limits.
- `reg-current-turn-state` — The mutable state for the active turn, including waiters, per-turn permissions, review flags, and interruption handling.
- `reg-approval-and-review-state` — The shared state for pending approvals, guardian decisions, hook reviews, and user confirmations before actions run.
- `reg-thread-projection-state` — The rebuilt user-visible thread state, summaries, status, and transcript items derived from engine events.
- `reg-client-notification-stream` — The outgoing stream of notifications, item updates, and status changes sent to clients and UI surfaces.
- `reg-exec-output-state` — The accumulated machine-readable exec output and final result data for one-shot runs.
- `reg-observability-pipeline` — The shared traces, logs, and metrics pipeline that records what the system is doing across its lifetime.
- `reg-session-telemetry` — The per-session flight recorder of timings, feature measurements, and linked trace information.
- `reg-rollout-trace-log` — The detailed saved raw event log that can later be replayed into a readable timeline.
- `reg-feedback-capture-store` — The saved bug-report packages, logs, diagnostics, and attachments collected for troubleshooting.
- `reg-import-tracking-store` — The record of outside session files that were already imported and how they map into the app’s format.
- `reg-unified-exec-process-registry` — The live registry of spawned host processes, their identifiers, stdin/control channels, and watched exit state for long-running command execution.
- `reg-goals-store-and-state` — The persisted and live per-thread goal data, including goal records shown in UI and reused across session resume and later turns.
- `reg-realtime-session-state` — The live per-thread realtime conversation session state, including whether realtime mode is active and the append/stop stream context carried across requests.
- `reg-token-usage-accounting` — The accumulated token-usage counters and replayable usage snapshots for sessions/threads that feed limits, notifications, and later projections.
- `reg-background-terminal-state` — The live and persisted state of thread-scoped background terminal/process sessions exposed to clients, including lifecycle and output continuity across thread operations.
- `reg-turn-command-result-buffer` — The accumulated recent command/tool result fragments and warnings kept as reusable context material for subsequent prompt assembly within the active session.
- `reg-provider-verification-and-reroute-state` — The current provider-verification, fallback, and reroute decisions/notifications that influence how model requests are directed and explained to clients.
- `reg-guardian-review-telemetry-context` — The in-flight guardian/review timing and correlation context that survives across approval handling and analytics emission for a turn.
- `reg-session-resume-and-continue-state` — The remembered session/thread continuation choice and resume metadata used to restore prior conversations, onboarding handoff, and exec/session restart flows across startup and live session orchestration.
