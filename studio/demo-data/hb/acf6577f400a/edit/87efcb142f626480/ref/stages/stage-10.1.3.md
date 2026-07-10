# Chat widget interaction and command flows  `stage-10.1.3`

This stage is the main “conversation control panel” of the terminal chat screen. It sits in the system’s main work loop: after startup, this is the part that reacts to what the user types, what the server sends back, and what the screen should show next.

At the center is chatwidget.rs, the stateful object that remembers the current chat, input box, notices, and popups. interaction.rs listens for keys and nearby actions like paste, copy, rename, interrupt, or quit. input_submission.rs turns drafted text, images, mentions, and extra context into actual requests, while input_flow.rs decides whether to send them now or queue them. input_queue.rs and input_restore.rs save unfinished drafts and bring them back later if a turn was interrupted.

slash_dispatch.rs routes slash commands like /usage, /goal, or /ide to the right feature modules. protocol.rs and protocol_requests.rs convert backend messages and requests into visible UI changes, approvals, and notices. rendering.rs draws the transcript, bottom pane, and temporary messages. The remaining files provide focused tools: notifications, interrupts, skills and connectors, hooks, goals, model and review popups, plan follow-up choices, reasoning shortcuts, and usage/token tracking. Together they make the chat widget feel responsive, stateful, and organized.

## Files in this stage

### Widget core and rendering
Defines the main chat widget state, renders its UI, and handles deferred interrupt-style events and notifications.

### `tui/src/chatwidget.rs`

`orchestration` · `main chat loop / request handling / rendering coordination`

This file is the top-level state hub for the chat screen. It defines `ChatWidgetInit`, the large `ChatWidget` struct, several small enums and helper structs, and a broad slice of the widget’s local behavior. `ChatWidget` owns transcript state, the bottom pane, config/runtime status, streaming controllers, review mode, plugin and MCP state, terminal-title caches, git-status caches, thread metadata, and many transient UI flags. The methods in this file mostly coordinate those subsystems rather than implementing low-level rendering themselves.

Several helpers normalize external data into UI-specific forms: terminal-dependent queued-message edit bindings, thread-name trimming, plan-keyword detection, approval-request conversion from app-server protocol structs, and token-usage conversion into `TokenUsageInfo`. The widget methods then use those values to drive UI flows: opening feedback and app-link views, showing enablement prompts for subagents and memories, updating token/context indicators in the bottom pane, recording committed user messages into transcript history, flushing active cells into committed history, and toggling raw-output or Vim modes with user-visible notices.

A recurring pattern is careful synchronization between live mutable cells and committed transcript history. `flush_active_cell`, `add_boxed_history`, `active_cell_transcript_key`, and `active_cell_transcript_hyperlink_lines` support the transcript overlay’s cached live tail while preserving grouping and separator invariants. Another pattern is redraw discipline: many mutators call `request_redraw()` after changing bottom-pane views, active cells, or status surfaces. The file also owns command submission plumbing through `submit_op`, including local pre-submission cleanup for interrupts and review-mode task-running state.

#### Function details

##### `queued_message_edit_binding_for_terminal`  (lines 217–241)

```
fn queued_message_edit_binding_for_terminal(terminal_info: TerminalInfo) -> KeyBinding
```

**Purpose**: Chooses the preferred keybinding for editing the most recently queued message based on terminal and multiplexer quirks.

**Data flow**: Reads a `TerminalInfo`, first checks whether it is running under tmux and returns `Shift+Left` in that case, otherwise matches on `TerminalName` and returns either `Shift+Left` for terminals known to swallow `Alt+Up` or `Alt+Up` for terminals that reliably pass it through.

**Call relations**: The hint-selection helper calls this to prefer a terminal-appropriate binding from the configured binding list.

*Call graph*: calls 2 internal fn (alt, shift); called by 1 (queued_message_edit_hint_binding); 1 external calls (matches!).


##### `queued_message_edit_hint_binding`  (lines 243–252)

```
fn queued_message_edit_hint_binding(
    bindings: &[KeyBinding],
    terminal_info: TerminalInfo,
) -> Option<KeyBinding>
```

**Purpose**: Selects which configured binding should be shown to the user for queued-message editing.

**Data flow**: Computes the terminal-preferred binding with `queued_message_edit_binding_for_terminal`, returns it if the provided binding slice contains it, otherwise falls back to the first configured binding if any.

**Call relations**: Constructor/setup code uses this to display a realistic shortcut hint without changing the actual configured bindings.

*Call graph*: calls 1 internal fn (queued_message_edit_binding_for_terminal); 1 external calls (contains).


##### `normalize_thread_name`  (lines 254–257)

```
fn normalize_thread_name(name: &str) -> Option<String>
```

**Purpose**: Trims a thread name and suppresses empty or whitespace-only names.

**Data flow**: Calls `trim()` on the input string and returns `Some(trimmed.to_string())` only when the trimmed result is non-empty.

**Call relations**: Thread metadata handling uses this to avoid storing blank names.


##### `contains_plan_keyword`  (lines 814–817)

```
fn contains_plan_keyword(text: &str) -> bool
```

**Purpose**: Checks whether text contains the standalone word `plan` according to the same lexical heuristic used elsewhere in the app.

**Data flow**: Splits the input on any non-alphanumeric, non-underscore character and returns true if any resulting token equals `plan` case-insensitively.

**Call relations**: Plan-mode suggestion and nudge logic can use this lexical helper without conflating it with slash-command or shell-command policy.


##### `ThreadItemRenderSource::is_replay`  (lines 826–828)

```
fn is_replay(self) -> bool
```

**Purpose**: Reports whether a thread item is being rendered from replayed history rather than live events.

**Data flow**: Matches `self` against `ThreadItemRenderSource::Replay(_)` and returns a boolean.

**Call relations**: Thread-item handling uses this to branch between replay-specific and live-event behavior.

*Call graph*: called by 1 (handle_thread_item); 1 external calls (matches!).


##### `ThreadItemRenderSource::replay_kind`  (lines 830–835)

```
fn replay_kind(self) -> Option<ReplayKind>
```

**Purpose**: Extracts the specific replay kind when the render source is a replay.

**Data flow**: Returns `Some(replay_kind)` for `Replay(replay_kind)` and `None` for `Live`.

**Call relations**: Thread-item handling uses this when replay-specific behavior depends on whether the source is initial-message replay or snapshot replay.

*Call graph*: called by 1 (handle_thread_item).


##### `exec_approval_request_from_params`  (lines 838–859)

```
fn exec_approval_request_from_params(
    params: CommandExecutionRequestApprovalParams,
    fallback_cwd: &AbsolutePathBuf,
) -> ExecApprovalRequestEvent
```

**Purpose**: Converts app-server command-approval parameters into the local `ExecApprovalRequestEvent` shape used by the TUI.

**Data flow**: Consumes `CommandExecutionRequestApprovalParams` plus a fallback cwd, splits the optional command string into argv with `split_command_string`, fills in cwd from params or fallback, and copies reason, network context, permissions, turn id, approval id, policy amendments, and available decisions into a new `ExecApprovalRequestEvent`.

**Call relations**: Approval-request handling uses this adapter when translating protocol requests into bottom-pane approval UI events.


##### `patch_approval_request_from_params`  (lines 861–871)

```
fn patch_approval_request_from_params(
    params: FileChangeRequestApprovalParams,
) -> ApplyPatchApprovalRequestEvent
```

**Purpose**: Converts app-server file-change approval parameters into the local patch-approval event type.

**Data flow**: Consumes `FileChangeRequestApprovalParams` and constructs `ApplyPatchApprovalRequestEvent` with the call id, turn id, an empty `HashMap` for changes, reason, and grant root.

**Call relations**: Patch-approval flows use this as the protocol-to-UI adapter before actual file-change details are populated.

*Call graph*: 1 external calls (new).


##### `request_permissions_from_params`  (lines 873–885)

```
fn request_permissions_from_params(
    params: codex_app_server_protocol::PermissionsRequestApprovalParams,
) -> std::io::Result<RequestPermissionsEvent>
```

**Purpose**: Converts app-server permissions-approval parameters into a `RequestPermissionsEvent`, validating the permissions payload.

**Data flow**: Consumes protocol params, attempts `params.permissions.try_into()?`, and on success returns a populated `RequestPermissionsEvent` containing turn/call/environment ids, timestamp, reason, converted permissions, and cwd.

**Call relations**: Permission-request handling uses this conversion before surfacing the request to the user.


##### `token_usage_info_from_app_server`  (lines 887–905)

```
fn token_usage_info_from_app_server(token_usage: ThreadTokenUsage) -> TokenUsageInfo
```

**Purpose**: Converts app-server thread token-usage data into the local `TokenUsageInfo` structure used by status surfaces.

**Data flow**: Copies total and last token counters from `ThreadTokenUsage` into two local `TokenUsage` structs and preserves `model_context_window`, returning the assembled `TokenUsageInfo`.

**Call relations**: Token-count update handling uses this adapter before updating bottom-pane context indicators.


##### `ChatWidget::set_collab_agent_metadata`  (lines 914–927)

```
fn set_collab_agent_metadata(
        &mut self,
        thread_id: ThreadId,
        agent_nickname: Option<String>,
        agent_role: Option<String>,
    )
```

**Purpose**: Stores or updates cached nickname/role metadata for a collaboration-agent thread.

**Data flow**: Inserts `AgentMetadata { agent_nickname, agent_role }` into `self.collab_agent_metadata` keyed by `thread_id`, overwriting any previous entry.

**Call relations**: Widget replacement and agent-picker synchronization call this before notifications referencing that thread are rendered.

*Call graph*: called by 1 (replace_chat_widget).


##### `ChatWidget::collab_agent_metadata`  (lines 930–935)

```
fn collab_agent_metadata(&self, thread_id: ThreadId) -> AgentMetadata
```

**Purpose**: Returns cached collaboration-agent metadata for a thread, defaulting to empty metadata when absent.

**Data flow**: Looks up `thread_id` in `self.collab_agent_metadata`, clones the stored `AgentMetadata` if present, or returns `AgentMetadata::default()`.

**Call relations**: Rendering and notification formatting use this to avoid exposing raw thread ids when friendly metadata is available.


##### `ChatWidget::restore_retry_status_header_if_present`  (lines 937–941)

```
fn restore_retry_status_header_if_present(&mut self)
```

**Purpose**: Restores a saved retry status header back into the visible status header slot if one was stashed.

**Data flow**: Calls `self.status_state.take_retry_status_header()`, and when it returns `Some(header)`, forwards that header to `self.set_status_header(header)`.

**Call relations**: Retry/error flows use this to reinstate status-header UI after temporary interruptions.

*Call graph*: calls 1 internal fn (take_retry_status_header).


##### `ChatWidget::record_agent_markdown`  (lines 944–948)

```
fn record_agent_markdown(&mut self, message: &str)
```

**Purpose**: Appends non-empty assistant markdown to the transcript’s raw-markdown recording buffer.

**Data flow**: Checks whether `message` is non-empty and, if so, calls `self.transcript.record_agent_markdown(message.to_string())`.

**Call relations**: Streaming or finalized assistant-message handling uses this to preserve markdown for later copy/export behavior.

*Call graph*: calls 1 internal fn (record_agent_markdown).


##### `ChatWidget::record_visible_user_turn_for_copy`  (lines 950–952)

```
fn record_visible_user_turn_for_copy(&mut self)
```

**Purpose**: Marks the current user turn as visible for transcript-copy bookkeeping.

**Data flow**: Delegates directly to `self.transcript.record_visible_user_turn()`.

**Call relations**: Called when a user message is actually rendered into history so copy/export logic tracks visible turns rather than merely submitted inputs.

*Call graph*: calls 1 internal fn (record_visible_user_turn); called by 1 (on_user_message_display).


##### `ChatWidget::open_feedback_note`  (lines 954–960)

```
fn open_feedback_note(
        &mut self,
        category: crate::app_event::FeedbackCategory,
        include_logs: bool,
    )
```

**Purpose**: Public wrapper that opens the feedback-note composer for a given category.

**Data flow**: Forwards `category` and `include_logs` to `show_feedback_note`.

**Call relations**: External callers use this entrypoint; the actual view construction lives in the private helper.

*Call graph*: calls 1 internal fn (show_feedback_note).


##### `ChatWidget::show_feedback_note`  (lines 962–975)

```
fn show_feedback_note(
        &mut self,
        category: crate::app_event::FeedbackCategory,
        include_logs: bool,
    )
```

**Purpose**: Creates and displays the feedback-note bottom-pane view, then schedules a redraw.

**Data flow**: Constructs `FeedbackNoteView::new(category, last_turn_id, app_event_tx.clone(), include_logs)`, passes it to `bottom_pane.show_view(Box::new(view))`, and calls `request_redraw()`.

**Call relations**: Used by `open_feedback_note` and any internal flow that needs to open the same feedback-note UI.

*Call graph*: calls 3 internal fn (show_view, new, request_redraw); called by 1 (open_feedback_note); 2 external calls (new, clone).


##### `ChatWidget::open_app_link_view`  (lines 977–985)

```
fn open_app_link_view(&mut self, params: crate::bottom_pane::AppLinkViewParams)
```

**Purpose**: Opens the app-link view with the current list keymap and requests a redraw.

**Data flow**: Builds `AppLinkView::new_with_keymap(params, app_event_tx.clone(), bottom_pane.list_keymap())`, shows it in the bottom pane, and schedules a frame.

**Call relations**: Called when the UI needs to present a link-oriented popup tied to app metadata.

*Call graph*: calls 4 internal fn (list_keymap, show_view, new_with_keymap, request_redraw); 2 external calls (new, clone).


##### `ChatWidget::dismiss_app_server_request`  (lines 987–995)

```
fn dismiss_app_server_request(&mut self, request: &ResolvedAppServerRequest)
```

**Purpose**: Removes a resolved app-server request from both deferred interrupt queues and any currently visible bottom-pane prompt.

**Data flow**: Calls `interrupts.remove_resolved_prompt(request)` and `bottom_pane.dismiss_app_server_request(request)`, then requests a redraw if either removal succeeded.

**Call relations**: Used when a remote request has already been resolved elsewhere and must no longer remain actionable in the UI.

*Call graph*: calls 3 internal fn (dismiss_app_server_request, request_redraw, remove_resolved_prompt).


##### `ChatWidget::open_feedback_consent`  (lines 997–1016)

```
fn open_feedback_consent(&mut self, category: crate::app_event::FeedbackCategory)
```

**Purpose**: Opens the feedback-upload consent selection view using current diagnostics and rollout context.

**Data flow**: Snapshots feedback state, conditionally checks for a Windows sandbox log, builds selection params with `feedback_upload_consent_params`, shows them via `bottom_pane.show_selection_view`, and requests a redraw.

**Call relations**: Feedback flows call this before uploading logs or diagnostics so the user can explicitly consent.

*Call graph*: calls 3 internal fn (snapshot, show_selection_view, request_redraw); 3 external calls (current_log_file_path_for_codex_home, feedback_upload_consent_params, clone).


##### `ChatWidget::open_multi_agent_enable_prompt`  (lines 1018–1051)

```
fn open_multi_agent_enable_prompt(&mut self)
```

**Purpose**: Shows a yes/no selection popup for enabling subagents in future sessions.

**Data flow**: Builds two `SelectionItem`s with actions that may send `AppEvent::UpdateFeatureFlags` and insert a warning history cell, wraps them in `SelectionViewParams` with title/subtitle/hint, and shows the selection view in the bottom pane.

**Call relations**: Called when the user tries to access subagent functionality while the feature flag is disabled.

*Call graph*: calls 2 internal fn (show_selection_view, standard_popup_hint_line); 2 external calls (default, vec!).


##### `ChatWidget::open_memories_popup`  (lines 1053–1066)

```
fn open_memories_popup(&mut self)
```

**Purpose**: Opens either the memories settings view or the memories-enable prompt depending on feature availability.

**Data flow**: Checks `config.features.enabled(Feature::MemoryTool)`; if disabled it calls `open_memories_enable_prompt`, otherwise it constructs `MemoriesSettingsView::new(...)` with current settings and keymap and shows it in the bottom pane.

**Call relations**: This is the main entrypoint for memories-related UI from the chat screen.

*Call graph*: calls 4 internal fn (list_keymap, show_view, new, open_memories_enable_prompt); 2 external calls (new, clone).


##### `ChatWidget::open_memories_enable_prompt`  (lines 1068–1102)

```
fn open_memories_enable_prompt(&mut self)
```

**Purpose**: Shows a yes/no selection popup for enabling the memories feature in future sessions.

**Data flow**: Builds two `SelectionItem`s, one of which sends `AppEvent::UpdateFeatureFlags` for `Feature::MemoryTool`, wraps them in `SelectionViewParams` with title/subtitle, a footer note linking to docs, and a standard hint line, then shows the selection view.

**Call relations**: Called by `open_memories_popup` when the memories feature is currently disabled.

*Call graph*: calls 2 internal fn (show_selection_view, standard_popup_hint_line); called by 1 (open_memories_popup); 3 external calls (default, from, vec!).


##### `ChatWidget::set_memory_settings`  (lines 1104–1107)

```
fn set_memory_settings(&mut self, use_memories: bool, generate_memories: bool)
```

**Purpose**: Updates the in-memory config flags controlling memory usage and memory generation.

**Data flow**: Writes the provided booleans into `self.config.memories.use_memories` and `self.config.memories.generate_memories`.

**Call relations**: Settings-confirmation flows use this after the user changes memory preferences.


##### `ChatWidget::set_token_info`  (lines 1109–1118)

```
fn set_token_info(&mut self, info: Option<TokenUsageInfo>)
```

**Purpose**: Updates token/context usage state and the bottom-pane context indicator from optional token-usage info.

**Data flow**: If `info` is `Some`, delegates to `apply_token_info`; if `None`, clears the bottom pane’s context window display and sets `self.token_info = None`.

**Call relations**: Token-count event handling calls this whenever fresh usage data arrives or needs to be cleared.

*Call graph*: calls 2 internal fn (set_context_window, apply_token_info); called by 1 (handle_token_count).


##### `ChatWidget::apply_token_info`  (lines 1120–1125)

```
fn apply_token_info(&mut self, info: TokenUsageInfo)
```

**Purpose**: Applies concrete token-usage info to both widget state and bottom-pane context display.

**Data flow**: Computes `percent` with `context_remaining_percent`, computes `used_tokens` with `context_used_tokens`, calls `bottom_pane.set_context_window(percent, used_tokens)`, and stores the full `TokenUsageInfo` in `self.token_info`.

**Call relations**: Used by normal token updates and by restoration after temporary review-mode overrides.

*Call graph*: calls 3 internal fn (set_context_window, context_remaining_percent, context_used_tokens); called by 2 (restore_pre_review_token_info, set_token_info).


##### `ChatWidget::context_remaining_percent`  (lines 1127–1132)

```
fn context_remaining_percent(&self, info: &TokenUsageInfo) -> Option<i64>
```

**Purpose**: Computes the remaining context-window percentage from token-usage info when the model context window is known.

**Data flow**: Reads `info.model_context_window` and, when present, calls `info.last_token_usage.percent_of_context_window_remaining(window)`.

**Call relations**: `apply_token_info` uses this to decide whether to show a percentage-based context indicator.

*Call graph*: called by 1 (apply_token_info).


##### `ChatWidget::context_used_tokens`  (lines 1134–1140)

```
fn context_used_tokens(&self, info: &TokenUsageInfo, percent_known: bool) -> Option<i64>
```

**Purpose**: Computes a fallback used-token count for the context indicator when a percentage cannot be shown.

**Data flow**: If `percent_known` is true it returns `None`; otherwise it returns `Some(info.total_token_usage.tokens_in_context_window())`.

**Call relations**: `apply_token_info` uses this so the bottom pane can still show context usage when the model window size is unknown.

*Call graph*: called by 1 (apply_token_info).


##### `ChatWidget::restore_pre_review_token_info`  (lines 1142–1153)

```
fn restore_pre_review_token_info(&mut self)
```

**Purpose**: Restores token/context display state that was saved before entering review mode.

**Data flow**: Takes `self.review.pre_review_token_info`; if it contains `Some(info)` it reapplies that info with `apply_token_info`, and if it contains `None` it clears the bottom-pane context display and `self.token_info`.

**Call relations**: Called when review mode ends so the ordinary session token display returns.

*Call graph*: calls 2 internal fn (set_context_window, apply_token_info); called by 1 (exit_review_mode_after_item).


##### `ChatWidget::handle_history_entry_response`  (lines 1155–1163)

```
fn handle_history_entry_response(&mut self, event: HistoryLookupResponse)
```

**Purpose**: Forwards an asynchronous history lookup response to the bottom pane.

**Data flow**: Destructures `HistoryLookupResponse { offset, log_id, entry }` and passes those fields to `bottom_pane.on_history_entry_response(log_id, offset, entry)`.

**Call relations**: History-navigation or lookup flows call this when a requested history entry arrives.

*Call graph*: calls 1 internal fn (on_history_entry_response).


##### `ChatWidget::pre_draw_tick`  (lines 1165–1182)

```
fn pre_draw_tick(&mut self)
```

**Purpose**: Runs per-frame maintenance before drawing, including hook visibility, pet animation, plan nudges, goal status, and terminal-title refresh decisions.

**Data flow**: Calls several internal maintenance methods, forwards `pre_draw_tick` to the bottom pane, schedules pet frames when needed, refreshes plan-mode and goal-status indicators, and conditionally refreshes the terminal title when action-required state or spinner/action-required animation state has changed.

**Call relations**: The main TUI draw loop and several delayed-redraw paths invoke this immediately before rendering.

*Call graph*: calls 1 internal fn (pre_draw_tick); called by 5 (handle_tui_event, show_shutdown_feedback, expire_quiet_hook_linger, reveal_running_hooks, reveal_running_hooks_after_delayed_redraw).


##### `ChatWidget::flush_active_cell`  (lines 1184–1190)

```
fn flush_active_cell(&mut self)
```

**Purpose**: Commits the current active transcript cell into history and marks that a separator may be needed afterward.

**Data flow**: Takes `self.transcript.active_cell`; if present, sets `transcript.needs_final_message_separator = true`, sends `AppEvent::InsertHistoryCell(active)` through `app_event_tx`, and requests pending usage-output insertion.

**Call relations**: History insertion, MCP loading transitions, session-info application, and review-mode exit all call this when a live cell must become committed history.

*Call graph*: calls 1 internal fn (send); called by 4 (add_boxed_history, add_mcp_output, apply_session_info_cell, exit_review_mode_after_item); 1 external calls (InsertHistoryCell).


##### `ChatWidget::add_to_history`  (lines 1192–1194)

```
fn add_to_history(&mut self, cell: impl HistoryCell + 'static)
```

**Purpose**: Convenience wrapper that boxes a concrete `HistoryCell` and inserts it into transcript history.

**Data flow**: Boxes the provided cell and forwards it to `add_boxed_history`.

**Call relations**: Many higher-level helpers use this to append info, warning, error, review, and process-output cells.

*Call graph*: calls 1 internal fn (add_boxed_history); called by 9 (add_debug_config_output, add_error_message, add_info_message, add_memories_enable_notice, add_ps_output, add_warning_message, enter_review_mode_with_hint, exit_review_mode_after_item, on_user_message_display); 1 external calls (new).


##### `ChatWidget::add_boxed_history`  (lines 1196–1217)

```
fn add_boxed_history(&mut self, cell: Box<dyn HistoryCell>)
```

**Purpose**: Adds a boxed history cell to committed history while preserving active-cell grouping and separator invariants.

**Data flow**: If an agent turn is running and the cell has visible lines, it records visible turn activity. It preserves a placeholder session header as the active cell until real session info arrives; otherwise, for visible cells and absent active stream tails, it flushes the current active cell and marks `needs_final_message_separator = true`. Finally it sends `AppEvent::InsertHistoryCell(cell)`.

**Call relations**: This is the central committed-history insertion path used by most helper methods and by active-cell finalization.

*Call graph*: calls 2 internal fn (send, flush_active_cell); called by 4 (add_plain_history_lines, add_to_history, apply_session_info_cell, finalize_active_cell_as_failed); 1 external calls (InsertHistoryCell).


##### `ChatWidget::enter_review_mode_with_hint`  (lines 1219–1230)

```
fn enter_review_mode_with_hint(&mut self, hint: String, from_replay: bool)
```

**Purpose**: Transitions the widget into review mode, preserving token state and appending a review-start banner.

**Data flow**: If no pre-review token snapshot exists, stores the current `token_info`; if not replaying and the bottom pane is not already marked running, sets task-running true; sets `review.is_review_mode = true`, formats a banner string, appends a review status-line history cell, and requests a redraw.

**Call relations**: Review-start flows call this when a code review begins, whether from live interaction or replay.

*Call graph*: calls 4 internal fn (is_task_running, set_task_running, add_to_history, request_redraw); 2 external calls (format!, new_review_status_line).


##### `ChatWidget::exit_review_mode_after_item`  (lines 1232–1242)

```
fn exit_review_mode_after_item(&mut self)
```

**Purpose**: Leaves review mode, flushes pending live output, restores token display, and appends a review-finished banner.

**Data flow**: Flushes answer stream separators, interrupt queue, and active cell, clears `review.is_review_mode`, restores pre-review token info, appends a finished review status-line cell, and requests a redraw.

**Call relations**: Called when the review item or review session completes.

*Call graph*: calls 4 internal fn (add_to_history, flush_active_cell, request_redraw, restore_pre_review_token_info); 1 external calls (new_review_status_line).


##### `ChatWidget::on_committed_user_message`  (lines 1244–1342)

```
fn on_committed_user_message(&mut self, items: &[UserInput], from_replay: bool)
```

**Purpose**: Processes a committed user message, deciding whether to record replay history, consume a pending steer, or append a visible user prompt cell.

**Data flow**: Builds a `UserMessageDisplay` from the input items. In replay mode, it may synthesize mention bindings, record replayed history in the bottom pane, and forward the display to `on_user_message_display` unless review mode suppresses it. In live mode, it compares the message against the front pending steer queue, may pop and render the queued display, warns on impossible mismatches, and otherwise renders the display unless it duplicates the last rendered user message or review mode suppresses it.

**Call relations**: Committed user-input handling calls this after protocol/user-input items have been finalized into a turn.

*Call graph*: calls 3 internal fn (record_replayed_user_message_history, on_user_message_display, user_message_display_for_history); 5 external calls (pending_steer_compare_key_from_items, user_message_display_from_inputs, new, iter, warn!).


##### `ChatWidget::on_user_message_display`  (lines 1344–1362)

```
fn on_user_message_display(&mut self, display: UserMessageDisplay)
```

**Purpose**: Records and renders a user message display into transcript history when it has visible content.

**Data flow**: Stores `display` in `last_rendered_user_message_display`, and if the message text or attachments are non-empty, records the visible user turn for copy/export and appends a `new_user_prompt` history cell containing message text, text elements, local images, and remote image URLs. It then clears `transcript.needs_final_message_separator`.

**Call relations**: Called by `on_committed_user_message` once duplicate suppression and replay/pending-steer logic have been resolved.

*Call graph*: calls 2 internal fn (add_to_history, record_visible_user_turn_for_copy); called by 1 (on_committed_user_message); 2 external calls (new_user_prompt, clone).


##### `ChatWidget::request_immediate_exit`  (lines 1368–1370)

```
fn request_immediate_exit(&self)
```

**Purpose**: Requests an immediate process exit without waiting for shutdown.

**Data flow**: Sends `AppEvent::Exit(ExitMode::Immediate)` through `app_event_tx`.

**Call relations**: Used for emergency or already-completed shutdown paths rather than ordinary user-initiated quit.

*Call graph*: calls 1 internal fn (send); 1 external calls (Exit).


##### `ChatWidget::request_quit_without_confirmation`  (lines 1376–1379)

```
fn request_quit_without_confirmation(&self)
```

**Purpose**: Requests a shutdown-first exit without additional confirmation.

**Data flow**: Sends `AppEvent::Exit(ExitMode::ShutdownFirst)` through `app_event_tx`.

**Call relations**: Explicit quit commands and double-press quit shortcuts use this path.

*Call graph*: calls 1 internal fn (send); 1 external calls (Exit).


##### `ChatWidget::show_shutdown_in_progress`  (lines 1381–1383)

```
fn show_shutdown_in_progress(&mut self)
```

**Purpose**: Tells the bottom pane to display its shutdown-in-progress UI.

**Data flow**: Delegates directly to `bottom_pane.show_shutdown_in_progress()`.

**Call relations**: Shutdown feedback flows call this while waiting for the app to terminate cleanly.

*Call graph*: calls 1 internal fn (show_shutdown_in_progress); called by 1 (show_shutdown_feedback).


##### `ChatWidget::request_redraw`  (lines 1385–1387)

```
fn request_redraw(&mut self)
```

**Purpose**: Schedules a future frame render for the chat widget.

**Data flow**: Calls `self.frame_requester.schedule_frame()`.

**Call relations**: Most UI-mutating helpers call this after changing visible state.

*Call graph*: calls 1 internal fn (schedule_frame); called by 17 (add_diff_in_progress, add_error_message, add_info_message, add_mcp_output, add_memories_enable_notice, add_plain_history_lines, add_warning_message, clear_mcp_inventory_loading, dismiss_app_server_request, enter_review_mode_with_hint (+7 more)).


##### `ChatWidget::bump_active_cell_revision`  (lines 1389–1391)

```
fn bump_active_cell_revision(&mut self)
```

**Purpose**: Increments the transcript active-cell revision used by the transcript overlay cache key.

**Data flow**: Delegates to `self.transcript.bump_active_cell_revision()`.

**Call relations**: Called whenever the active cell changes in place so the transcript overlay knows to recompute its live tail.

*Call graph*: calls 1 internal fn (bump_active_cell_revision); called by 2 (add_mcp_output, clear_mcp_inventory_loading).


##### `ChatWidget::finalize_active_cell_as_failed`  (lines 1394–1405)

```
fn finalize_active_cell_as_failed(&mut self)
```

**Purpose**: Marks the current active exec/tool cell as failed and commits it into history.

**Data flow**: Takes `transcript.active_cell`, downcasts it to `ExecCell` or `McpToolCallCell` when possible to call `mark_failed()`, then inserts it into history with `add_boxed_history` and requests pending usage-output insertion.

**Call relations**: Failure-handling paths use this when an in-flight active cell should be finalized with an error state.

*Call graph*: calls 1 internal fn (add_boxed_history).


##### `ChatWidget::set_pending_thread_approvals`  (lines 1407–1409)

```
fn set_pending_thread_approvals(&mut self, threads: Vec<String>)
```

**Purpose**: Updates the bottom pane’s list of threads with pending approvals.

**Data flow**: Passes the provided `Vec<String>` to `bottom_pane.set_pending_thread_approvals`.

**Call relations**: Approval-state synchronization uses this to keep the footer/status UI current.

*Call graph*: calls 1 internal fn (set_pending_thread_approvals).


##### `ChatWidget::clear_thread_rename_block`  (lines 1411–1413)

```
fn clear_thread_rename_block(&mut self)
```

**Purpose**: Clears any message explaining why thread renaming is currently blocked.

**Data flow**: Sets `self.thread_rename_block_message = None`.

**Call relations**: Thread-rename flows call this when the blocking condition is removed.


##### `ChatWidget::set_thread_rename_block_message`  (lines 1415–1417)

```
fn set_thread_rename_block_message(&mut self, message: impl Into<String>)
```

**Purpose**: Stores a message explaining why thread renaming is blocked.

**Data flow**: Converts the input into `String` and stores it in `self.thread_rename_block_message`.

**Call relations**: Thread-management flows use this to surface rename restrictions to the user.

*Call graph*: 1 external calls (into).


##### `ChatWidget::set_interrupted_turn_notice_mode`  (lines 1419–1421)

```
fn set_interrupted_turn_notice_mode(&mut self, mode: InterruptedTurnNoticeMode)
```

**Purpose**: Updates how interrupted-turn notices should be displayed.

**Data flow**: Writes the provided `InterruptedTurnNoticeMode` into `self.interrupted_turn_notice_mode`.

**Call relations**: Interrupt and replay flows use this to suppress or restore interruption notices.


##### `ChatWidget::add_diff_in_progress`  (lines 1423–1425)

```
fn add_diff_in_progress(&mut self)
```

**Purpose**: Triggers a redraw when diff rendering enters an in-progress state.

**Data flow**: Calls `request_redraw()` without mutating other state.

**Call relations**: Diff lifecycle hooks use this as a lightweight visual refresh trigger.

*Call graph*: calls 1 internal fn (request_redraw).


##### `ChatWidget::on_diff_complete`  (lines 1427–1429)

```
fn on_diff_complete(&mut self)
```

**Purpose**: Triggers a redraw when diff rendering completes.

**Data flow**: Calls `request_redraw()`.

**Call relations**: Complements `add_diff_in_progress` for diff lifecycle updates.

*Call graph*: calls 1 internal fn (request_redraw).


##### `ChatWidget::add_debug_config_output`  (lines 1431–1436)

```
fn add_debug_config_output(&mut self)
```

**Purpose**: Appends a history cell showing the current debug configuration and session network proxy state.

**Data flow**: Builds a cell with `crate::debug_config::new_debug_config_output(&self.config, self.session_network_proxy.as_ref())` and inserts it via `add_to_history`.

**Call relations**: Debug commands use this to surface configuration details in the transcript.

*Call graph*: calls 2 internal fn (add_to_history, new_debug_config_output).


##### `ChatWidget::add_ps_output`  (lines 1438–1448)

```
fn add_ps_output(&mut self)
```

**Purpose**: Appends a history cell describing active unified-exec background processes.

**Data flow**: Maps `self.unified_exec_processes` into `UnifiedExecProcessDetails` values containing command display and recent chunks, then inserts a `new_unified_exec_processes_output` history cell.

**Call relations**: The `/ps` command or equivalent UI action uses this to show background terminal details.

*Call graph*: calls 1 internal fn (add_to_history); 1 external calls (new_unified_exec_processes_output).


##### `ChatWidget::clean_background_terminals`  (lines 1450–1458)

```
fn clean_background_terminals(&mut self)
```

**Purpose**: Requests cleanup of all background terminals, clears local process state, syncs the footer, and informs the user.

**Data flow**: Submits `AppCommand::clean_background_terminals()`, clears `self.unified_exec_processes`, calls `sync_unified_exec_footer()`, and appends an informational history message.

**Call relations**: Invoked by commands like `/stop` that terminate unified-exec background sessions.

*Call graph*: calls 2 internal fn (add_info_message, submit_op); 1 external calls (clean_background_terminals).


##### `ChatWidget::plugins_for_mentions`  (lines 1460–1466)

```
fn plugins_for_mentions(&self) -> Option<&[PluginCapabilitySummary]>
```

**Purpose**: Returns the current plugin capability list for mention completion when the plugins feature is enabled.

**Data flow**: Checks `config.features.enabled(Feature::Plugins)` and returns `None` if disabled; otherwise returns `bottom_pane.plugins().map(Vec::as_slice)`.

**Call relations**: Mention-completion logic uses this to decide whether plugin mentions should be offered.

*Call graph*: calls 1 internal fn (plugins).


##### `ChatWidget::placeholder_session_header_cell`  (lines 1469–1482)

```
fn placeholder_session_header_cell(config: &Config) -> Box<dyn HistoryCell>
```

**Purpose**: Builds a dim italic placeholder session-header history cell shown before real session configuration arrives.

**Data flow**: Creates a placeholder `Style` with `DIM | ITALIC`, constructs `SessionHeaderHistoryCell::new_with_style` using `DEFAULT_MODEL_DISPLAY_NAME`, current cwd, and CLI version, optionally marks it as yolo mode, and returns it boxed as `dyn HistoryCell`.

**Call relations**: Session startup uses this placeholder so later real session info can merge into the same visual slot instead of creating duplicate header boxes.

*Call graph*: calls 1 internal fn (new_with_style); 3 external calls (new, default, is_yolo_mode).


##### `ChatWidget::apply_session_info_cell`  (lines 1485–1510)

```
fn apply_session_info_cell(&mut self, cell: history_cell::SessionInfoCell)
```

**Purpose**: Merges real session info into an existing placeholder header when possible, otherwise commits it as ordinary history.

**Data flow**: Boxes the incoming `SessionInfoCell`, checks whether the current active cell is a `SessionHeaderHistoryCell`, and if so replaces the active placeholder with the real cell before flushing. If no placeholder was merged, it flushes any active cell and inserts the session-info cell into history.

**Call relations**: Session-configured handling uses this to avoid rendering both a placeholder header and a real header.

*Call graph*: calls 2 internal fn (add_boxed_history, flush_active_cell); 1 external calls (new).


##### `ChatWidget::add_info_message`  (lines 1512–1515)

```
fn add_info_message(&mut self, message: String, hint: Option<String>)
```

**Purpose**: Appends an informational history event and schedules a redraw.

**Data flow**: Creates a `new_info_event(message, hint)` history cell, inserts it with `add_to_history`, and calls `request_redraw()`.

**Call relations**: Many user-visible toggles and background-terminal actions use this helper for lightweight notices.

*Call graph*: calls 2 internal fn (add_to_history, request_redraw); called by 3 (clean_background_terminals, set_raw_output_mode_and_notify, toggle_vim_mode_and_notify); 1 external calls (new_info_event).


##### `ChatWidget::add_memories_enable_notice`  (lines 1517–1522)

```
fn add_memories_enable_notice(&mut self)
```

**Purpose**: Appends the standard memories-enabled warning/notice cell and redraws.

**Data flow**: Creates `new_warning_event(MEMORIES_ENABLE_NOTICE.to_string())`, inserts it into history, and requests a redraw.

**Call relations**: Used after enabling memories so the user sees the deferred-effect notice.

*Call graph*: calls 2 internal fn (add_to_history, request_redraw); 1 external calls (new_warning_event).


##### `ChatWidget::add_plain_history_lines`  (lines 1524–1527)

```
fn add_plain_history_lines(&mut self, lines: Vec<Line<'static>>)
```

**Purpose**: Appends arbitrary plain transcript lines as a `PlainHistoryCell` and redraws.

**Data flow**: Wraps the provided `Vec<Line<'static>>` in `PlainHistoryCell::new`, boxes it, inserts it with `add_boxed_history`, and requests a redraw.

**Call relations**: Utility paths use this when they already have fully formatted lines rather than a specialized history-cell type.

*Call graph*: calls 3 internal fn (add_boxed_history, request_redraw, new); 1 external calls (new).


##### `ChatWidget::add_warning_message`  (lines 1529–1532)

```
fn add_warning_message(&mut self, message: String)
```

**Purpose**: Appends a warning history event and redraws.

**Data flow**: Creates `new_warning_event(message)`, inserts it with `add_to_history`, and requests a redraw.

**Call relations**: Used for non-fatal warnings that should appear in the transcript.

*Call graph*: calls 2 internal fn (add_to_history, request_redraw); 1 external calls (new_warning_event).


##### `ChatWidget::add_error_message`  (lines 1534–1537)

```
fn add_error_message(&mut self, message: String)
```

**Purpose**: Appends an error history event and redraws.

**Data flow**: Creates `new_error_event(message)`, inserts it with `add_to_history`, and requests a redraw.

**Call relations**: Stubbed or failed feature paths use this to surface errors in the transcript.

*Call graph*: calls 2 internal fn (add_to_history, request_redraw); called by 1 (add_app_server_stub_message); 1 external calls (new_error_event).


##### `ChatWidget::add_app_server_stub_message`  (lines 1539–1542)

```
fn add_app_server_stub_message(&mut self, feature: &str)
```

**Purpose**: Logs and displays a standard `Not available in TUI yet.` error for unsupported app-server features.

**Data flow**: Emits a warning log with the feature name and appends an error message combining the feature label with `TUI_STUB_MESSAGE`.

**Call relations**: Unsupported feature handlers call this instead of silently ignoring the request.

*Call graph*: calls 1 internal fn (add_error_message); 2 external calls (format!, warn!).


##### `ChatWidget::rename_confirmation_cell`  (lines 1544–1554)

```
fn rename_confirmation_cell(name: &str, thread_id: Option<ThreadId>) -> PlainHistoryCell
```

**Purpose**: Builds a plain history cell confirming a session rename and optionally includes a resume hint.

**Data flow**: Constructs a styled line beginning with a bullet and `Session renamed to`, colors the new name cyan, optionally appends `. To resume this session run <hint>` when `resume_hint` returns one, and wraps the line in `PlainHistoryCell`.

**Call relations**: Thread/session rename flows use this to acknowledge successful renames in the transcript.

*Call graph*: calls 1 internal fn (new); 2 external calls (resume_hint, vec!).


##### `ChatWidget::add_mcp_output`  (lines 1561–1573)

```
fn add_mcp_output(&mut self, detail: McpServerStatusDetail)
```

**Purpose**: Starts the asynchronous MCP inventory flow by showing a loading cell, bumping the active-cell revision, redrawing, and requesting inventory fetch.

**Data flow**: Flushes answer-stream separators and any active cell, sets `transcript.active_cell` to a new `McpInventoryLoadingCell`, bumps the active-cell revision, requests a redraw, and sends `AppEvent::FetchMcpInventory { detail, thread_id }`.

**Call relations**: Triggered when the user requests MCP inventory/status details from the chat UI.

*Call graph*: calls 5 internal fn (send, bump_active_cell_revision, flush_active_cell, request_redraw, thread_id); 2 external calls (new, new_mcp_inventory_loading).


##### `ChatWidget::clear_mcp_inventory_loading`  (lines 1579–1592)

```
fn clear_mcp_inventory_loading(&mut self)
```

**Purpose**: Removes the MCP inventory loading cell if it is still the current active cell.

**Data flow**: Checks whether `transcript.active_cell` exists and is of type `McpInventoryLoadingCell` via `Any`; if so, sets it to `None`, bumps the active-cell revision, and requests a redraw.

**Call relations**: Called when MCP inventory results arrive so a stale loading spinner does not remain visible.

*Call graph*: calls 2 internal fn (bump_active_cell_revision, request_redraw).


##### `ChatWidget::apply_file_search_result`  (lines 1595–1597)

```
fn apply_file_search_result(&mut self, query: String, matches: Vec<FileMatch>)
```

**Purpose**: Forwards file-search results to the bottom pane.

**Data flow**: Passes the query string and `Vec<FileMatch>` directly to `bottom_pane.on_file_search_result`.

**Call relations**: Asynchronous file-search completion handlers use this to update the active bottom-pane search UI.

*Call graph*: calls 1 internal fn (on_file_search_result).


##### `ChatWidget::current_stream_width`  (lines 1604–1614)

```
fn current_stream_width(&self, reserved_cols: usize) -> Option<usize>
```

**Purpose**: Computes the usable markdown body width for live stream controllers based on the last rendered terminal width and reserved wrapper columns.

**Data flow**: Reads `last_rendered_width`; if absent or zero returns `None`. Otherwise it converts the width to `u16`, computes the history wrap width, subtracts reserved columns with `crate::width::usable_content_width`, and returns at least 1 column.

**Call relations**: Terminal-resize handling uses this to keep active stream wrapping aligned with finalized transcript layout.

*Call graph*: called by 1 (on_terminal_resize).


##### `ChatWidget::raw_output_mode`  (lines 1616–1618)

```
fn raw_output_mode(&self) -> bool
```

**Purpose**: Returns whether raw transcript rendering mode is enabled.

**Data flow**: Reads and returns `self.raw_output_mode`.

**Call relations**: Rendering and toggle logic use this to choose between raw and rich transcript modes.


##### `ChatWidget::history_render_mode`  (lines 1620–1626)

```
fn history_render_mode(&self) -> HistoryRenderMode
```

**Purpose**: Maps the raw-output flag to the corresponding `HistoryRenderMode` enum.

**Data flow**: Returns `HistoryRenderMode::Raw` when `raw_output_mode` is true and `HistoryRenderMode::Rich` otherwise.

**Call relations**: Stream-controller updates use this when raw-output mode changes.

*Call graph*: called by 1 (set_raw_output_mode).


##### `ChatWidget::set_raw_output_mode`  (lines 1628–1639)

```
fn set_raw_output_mode(&mut self, enabled: bool)
```

**Purpose**: Updates raw-output mode, persists it into config, updates active stream controllers, and refreshes status surfaces.

**Data flow**: Writes `enabled` into `self.raw_output_mode` and `config.tui_raw_output_mode`, computes the new `HistoryRenderMode`, updates both stream controllers if present, and calls `refresh_status_surfaces()`.

**Call relations**: Called by the notifying toggle helper and any direct settings application path.

*Call graph*: calls 1 internal fn (history_render_mode); called by 1 (set_raw_output_mode_and_notify).


##### `ChatWidget::raw_output_mode_notice`  (lines 1641–1647)

```
fn raw_output_mode_notice(enabled: bool) -> &'static str
```

**Purpose**: Returns the user-facing notice string corresponding to enabling or disabling raw-output mode.

**Data flow**: Matches on the boolean and returns one of two static explanatory strings.

**Call relations**: The notifying setter uses this to append an informational transcript message.


##### `ChatWidget::set_raw_output_mode_and_notify`  (lines 1649–1655)

```
fn set_raw_output_mode_and_notify(&mut self, enabled: bool)
```

**Purpose**: Changes raw-output mode and appends a transcript notice describing the new state.

**Data flow**: Calls `set_raw_output_mode(enabled)` and then `add_info_message(Self::raw_output_mode_notice(enabled).to_string(), None)`.

**Call relations**: Used by the toggle helper and any UI action that should both change the mode and inform the user.

*Call graph*: calls 2 internal fn (add_info_message, set_raw_output_mode); called by 1 (toggle_raw_output_mode_and_notify); 1 external calls (raw_output_mode_notice).


##### `ChatWidget::toggle_raw_output_mode_and_notify`  (lines 1657–1661)

```
fn toggle_raw_output_mode_and_notify(&mut self) -> bool
```

**Purpose**: Flips raw-output mode, emits the corresponding notice, and returns the new enabled state.

**Data flow**: Computes `enabled = !self.raw_output_mode`, calls `set_raw_output_mode_and_notify(enabled)`, and returns `enabled`.

**Call relations**: Bound to the user-facing raw-output toggle action.

*Call graph*: calls 1 internal fn (set_raw_output_mode_and_notify).


##### `ChatWidget::on_terminal_resize`  (lines 1667–1682)

```
fn on_terminal_resize(&mut self, width: u16)
```

**Purpose**: Updates width-sensitive stream-controller state after a terminal resize and triggers an initial redraw when width becomes known.

**Data flow**: Records whether a width had previously been rendered, stores the new width in `last_rendered_width`, computes body widths for ordinary and plan streams with `current_stream_width`, updates both stream controllers if present, syncs the active stream tail, and requests a redraw if this was the first known width.

**Call relations**: Terminal resize events call this so live streaming wraps consistently with the current viewport.

*Call graph*: calls 2 internal fn (current_stream_width, request_redraw).


##### `ChatWidget::has_active_agent_stream`  (lines 1685–1687)

```
fn has_active_agent_stream(&self) -> bool
```

**Purpose**: Reports whether a normal assistant-message stream controller is currently active.

**Data flow**: Returns `self.stream_controller.is_some()`.

**Call relations**: Higher-level UI logic uses this to distinguish active assistant streaming from idle or plan-stream states.


##### `ChatWidget::has_active_plan_stream`  (lines 1690–1692)

```
fn has_active_plan_stream(&self) -> bool
```

**Purpose**: Reports whether a proposed-plan stream controller is currently active.

**Data flow**: Returns `self.plan_stream_controller.is_some()`.

**Call relations**: Used by UI logic that needs to know whether plan output is currently streaming.


##### `ChatWidget::is_plan_streaming_in_tui`  (lines 1694–1696)

```
fn is_plan_streaming_in_tui(&self) -> bool
```

**Purpose**: Internal synonym for checking whether a plan stream is active.

**Data flow**: Returns `self.plan_stream_controller.is_some()`.

**Call relations**: Internal plan-stream logic uses this helper for readability.


##### `ChatWidget::composer_is_empty`  (lines 1698–1700)

```
fn composer_is_empty(&self) -> bool
```

**Purpose**: Reports whether the bottom-pane composer currently has no user input.

**Data flow**: Delegates to `bottom_pane.composer_is_empty()`.

**Call relations**: Submission and shortcut logic use this to decide whether certain actions are allowed.

*Call graph*: calls 1 internal fn (composer_is_empty).


##### `ChatWidget::is_task_running_for_test`  (lines 1703–1705)

```
fn is_task_running_for_test(&self) -> bool
```

**Purpose**: Test-only accessor exposing whether the bottom pane currently considers a task to be running.

**Data flow**: Delegates to `bottom_pane.is_task_running()`.

**Call relations**: Tests use this to assert task-running synchronization behavior.

*Call graph*: calls 1 internal fn (is_task_running).


##### `ChatWidget::toggle_vim_mode_and_notify`  (lines 1707–1715)

```
fn toggle_vim_mode_and_notify(&mut self)
```

**Purpose**: Toggles Vim editing in the bottom-pane composer and appends a notice describing the new state.

**Data flow**: Calls `bottom_pane.toggle_vim_enabled()`, chooses either `"Vim mode enabled."` or `"Vim mode disabled."`, and appends it via `add_info_message`.

**Call relations**: Bound to the user-facing Vim-mode toggle action.

*Call graph*: calls 2 internal fn (toggle_vim_enabled, add_info_message).


##### `ChatWidget::is_normal_backtrack_mode`  (lines 1720–1722)

```
fn is_normal_backtrack_mode(&self) -> bool
```

**Purpose**: Reports whether the bottom pane is in its ordinary composer state with no running task or modal overlay.

**Data flow**: Delegates to `bottom_pane.is_normal_backtrack_mode()`.

**Call relations**: Escape/backtrack routing uses this to decide when Esc-Esc should navigate backward rather than cancel a popup.

*Call graph*: calls 1 internal fn (is_normal_backtrack_mode).


##### `ChatWidget::should_handle_vim_insert_escape`  (lines 1724–1727)

```
fn should_handle_vim_insert_escape(&self, key_event: KeyEvent) -> bool
```

**Purpose**: Asks the bottom-pane composer whether a given Escape event should be consumed as a Vim insert-mode transition.

**Data flow**: Delegates the `KeyEvent` to `bottom_pane.composer_should_handle_vim_insert_escape(key_event)`.

**Call relations**: Top-level key routing uses this before applying broader chat-widget Escape behavior.

*Call graph*: calls 1 internal fn (composer_should_handle_vim_insert_escape).


##### `ChatWidget::insert_str`  (lines 1729–1731)

```
fn insert_str(&mut self, text: &str)
```

**Purpose**: Inserts text into the bottom-pane composer.

**Data flow**: Delegates the provided string slice to `bottom_pane.insert_str(text)`.

**Call relations**: External helpers use this when they need to programmatically type into the composer.

*Call graph*: calls 1 internal fn (insert_str).


##### `ChatWidget::set_composer_text`  (lines 1734–1743)

```
fn set_composer_text(
        &mut self,
        text: String,
        text_elements: Vec<TextElement>,
        local_image_paths: Vec<PathBuf>,
    )
```

**Purpose**: Replaces the composer contents, including text elements and local image attachments, and refreshes plan-mode nudges.

**Data flow**: Passes the provided text, `Vec<TextElement>`, and local image paths to `bottom_pane.set_composer_text`, then calls `refresh_plan_mode_nudge()`.

**Call relations**: Draft restore and queued-message edit flows use this to repopulate the composer.

*Call graph*: calls 1 internal fn (set_composer_text).


##### `ChatWidget::set_remote_image_urls`  (lines 1745–1747)

```
fn set_remote_image_urls(&mut self, remote_image_urls: Vec<String>)
```

**Purpose**: Stores the current set of remote image URLs in the bottom-pane composer state.

**Data flow**: Delegates the provided vector to `bottom_pane.set_remote_image_urls`.

**Call relations**: Image-attachment flows use this when remote image selections are applied.

*Call graph*: calls 1 internal fn (set_remote_image_urls).


##### `ChatWidget::take_remote_image_urls`  (lines 1749–1751)

```
fn take_remote_image_urls(&mut self) -> Vec<String>
```

**Purpose**: Removes and returns the current remote image URLs from the bottom-pane composer state.

**Data flow**: Delegates to `bottom_pane.take_remote_image_urls()` and returns the resulting vector.

**Call relations**: Submission flows use this when consuming composer attachments.

*Call graph*: calls 1 internal fn (take_remote_image_urls).


##### `ChatWidget::remote_image_urls`  (lines 1754–1756)

```
fn remote_image_urls(&self) -> Vec<String>
```

**Purpose**: Test-only accessor returning the current remote image URLs from the bottom pane.

**Data flow**: Delegates to `bottom_pane.remote_image_urls()`.

**Call relations**: Tests use this to inspect attachment state.

*Call graph*: calls 1 internal fn (remote_image_urls).


##### `ChatWidget::pending_thread_approvals`  (lines 1759–1761)

```
fn pending_thread_approvals(&self) -> &[String]
```

**Purpose**: Test-only accessor returning the current pending-thread-approval list from the bottom pane.

**Data flow**: Delegates to `bottom_pane.pending_thread_approvals()`.

**Call relations**: Tests use this to verify approval-state propagation.

*Call graph*: calls 1 internal fn (pending_thread_approvals).


##### `ChatWidget::has_active_view`  (lines 1764–1766)

```
fn has_active_view(&self) -> bool
```

**Purpose**: Test-only accessor reporting whether the bottom pane currently has an active modal view.

**Data flow**: Delegates to `bottom_pane.has_active_view()`.

**Call relations**: Tests use this to assert popup/view lifecycle behavior.

*Call graph*: calls 1 internal fn (has_active_view).


##### `ChatWidget::show_esc_backtrack_hint`  (lines 1768–1770)

```
fn show_esc_backtrack_hint(&mut self)
```

**Purpose**: Asks the bottom pane to display its Escape backtrack hint.

**Data flow**: Delegates to `bottom_pane.show_esc_backtrack_hint()`.

**Call relations**: Navigation/backtrack flows use this when the user should be reminded of Esc-Esc behavior.

*Call graph*: calls 1 internal fn (show_esc_backtrack_hint).


##### `ChatWidget::clear_esc_backtrack_hint`  (lines 1772–1774)

```
fn clear_esc_backtrack_hint(&mut self)
```

**Purpose**: Asks the bottom pane to hide its Escape backtrack hint.

**Data flow**: Delegates to `bottom_pane.clear_esc_backtrack_hint()`.

**Call relations**: Called when the hint is no longer relevant.

*Call graph*: calls 1 internal fn (clear_esc_backtrack_hint).


##### `ChatWidget::refresh_skills_for_current_cwd`  (lines 1776–1781)

```
fn refresh_skills_for_current_cwd(&mut self, force_reload: bool)
```

**Purpose**: Requests a skill list refresh for the current working directory, optionally forcing reload.

**Data flow**: Builds `AppCommand::list_skills(vec![self.config.cwd.to_path_buf()], force_reload)` and submits it through `submit_op`.

**Call relations**: Skill-refresh actions use this to ask core for updated skill metadata.

*Call graph*: calls 1 internal fn (submit_op); 2 external calls (list_skills, vec!).


##### `ChatWidget::submit_op`  (lines 1784–1806)

```
fn submit_op(&mut self, op: T) -> bool
```

**Purpose**: Submits an `AppCommand` either directly to codex or indirectly via `AppEvent`, while performing local pre-submission bookkeeping.

**Data flow**: Converts the input into `AppCommand`, calls `prepare_local_op_submission(&op)`, marks the bottom pane task-running for review ops when needed, then either logs and sends the op through a direct `UnboundedSender<AppCommand>` or wraps it in `AppEvent::CodexOp` and sends it through `app_event_tx`. It returns `false` only if direct send fails.

**Call relations**: Many chat-widget actions use this as the canonical command-submission path to core.

*Call graph*: calls 5 internal fn (send, is_task_running, set_task_running, prepare_local_op_submission, log_outbound_op); called by 2 (clean_background_terminals, refresh_skills_for_current_cwd); 4 external calls (into, is_review, CodexOp, error!).


##### `ChatWidget::append_message_history_entry`  (lines 1808–1815)

```
fn append_message_history_entry(&self, text: String)
```

**Purpose**: Requests persistence of a submitted message into per-thread message history when a thread id is available.

**Data flow**: If `self.thread_id` is `Some`, sends `AppEvent::AppendMessageHistoryEntry { thread_id, text }`; otherwise logs a warning and does nothing.

**Call relations**: Submission/history flows use this after successful message handling.

*Call graph*: calls 1 internal fn (send); 1 external calls (warn!).


##### `ChatWidget::prepare_local_op_submission`  (lines 1817–1833)

```
fn prepare_local_op_submission(&mut self, op: &AppCommand)
```

**Purpose**: Performs local UI cleanup before certain commands, especially interrupts, are sent to core.

**Data flow**: If the op is `AppCommand::Interrupt` during an active agent turn, it may arm cancel-edit restoration for `RestorePromptIfNoOutput`, clears queued chunks in both stream controllers if present, clears the active stream tail, and requests a redraw.

**Call relations**: Called by `submit_op` before every outbound command so interrupt-specific local state is synchronized immediately.

*Call graph*: calls 1 internal fn (request_redraw); called by 1 (submit_op).


##### `ChatWidget::on_list_skills`  (lines 1835–1838)

```
fn on_list_skills(&mut self, ev: SkillsListResponse)
```

**Purpose**: Applies a skills-list response and refreshes plugin mentions afterward.

**Data flow**: Calls `self.set_skills_from_response(&ev)` and then `self.refresh_plugin_mentions()`.

**Call relations**: Skill-list response handling uses this to keep both skill state and mention suggestions current.

*Call graph*: calls 1 internal fn (refresh_plugin_mentions).


##### `ChatWidget::refresh_plugin_mentions`  (lines 1840–1847)

```
fn refresh_plugin_mentions(&mut self)
```

**Purpose**: Requests refreshed plugin mention data when plugins are enabled, or clears plugin mentions otherwise.

**Data flow**: If the plugins feature is disabled, calls `bottom_pane.set_plugin_mentions(None)` and returns. Otherwise it sends `AppEvent::RefreshPluginMentions`.

**Call relations**: Called after skill updates and config changes that may affect mention availability.

*Call graph*: calls 2 internal fn (send, set_plugin_mentions); called by 1 (on_list_skills).


##### `ChatWidget::on_plugin_mentions_loaded`  (lines 1849–1857)

```
fn on_plugin_mentions_loaded(
        &mut self,
        plugins: Option<Vec<PluginCapabilitySummary>>,
    )
```

**Purpose**: Applies newly loaded plugin mention capabilities to the bottom pane only when they differ from the current set.

**Data flow**: Compares `bottom_pane.plugins()` to the incoming `Option<Vec<PluginCapabilitySummary>>`; if unchanged it returns, otherwise it forwards the new value to `bottom_pane.set_plugin_mentions`.

**Call relations**: Plugin-mention refresh responses use this to avoid unnecessary UI churn.

*Call graph*: calls 2 internal fn (plugins, set_plugin_mentions).


##### `ChatWidget::sync_plugin_mentions_config`  (lines 1859–1865)

```
fn sync_plugin_mentions_config(&mut self, config: &Config)
```

**Purpose**: Copies plugin- and mention-related config fields from an updated config into the widget and refreshes mention-mode state.

**Data flow**: Overwrites `self.config.features`, `config_layer_stack`, `memories`, and `terminal_resize_reflow` from the provided config, then calls `sync_mentions_v2_enabled()`.

**Call relations**: Live config-update handling uses this to keep mention behavior aligned with current settings.


##### `ChatWidget::token_usage`  (lines 1867–1872)

```
fn token_usage(&self) -> TokenUsage
```

**Purpose**: Returns the total token usage for the current thread, defaulting to zeroed usage when unavailable.

**Data flow**: Reads `self.token_info`, clones `total_token_usage` when present, or returns `TokenUsage::default()`.

**Call relations**: Status and telemetry surfaces use this accessor when they need aggregate token counts.


##### `ChatWidget::thread_id`  (lines 1874–1876)

```
fn thread_id(&self) -> Option<ThreadId>
```

**Purpose**: Returns the current thread id, if one has been assigned.

**Data flow**: Returns `self.thread_id`.

**Call relations**: Used by MCP inventory requests and other flows that need to tag app events with the active thread.

*Call graph*: called by 1 (add_mcp_output).


##### `ChatWidget::thread_name`  (lines 1878–1880)

```
fn thread_name(&self) -> Option<String>
```

**Purpose**: Returns the current thread name as an owned string when available.

**Data flow**: Clones and returns `self.thread_name`.

**Call relations**: Thread-management and title/status rendering use this accessor.


##### `ChatWidget::rollout_path`  (lines 1887–1889)

```
fn rollout_path(&self) -> Option<PathBuf>
```

**Purpose**: Returns the current thread’s rollout path, if known.

**Data flow**: Clones and returns `self.current_rollout_path`.

**Call relations**: Feedback and persistence flows use this when they need the current rollout file location.


##### `ChatWidget::active_cell_transcript_key`  (lines 1901–1924)

```
fn active_cell_transcript_key(&self) -> Option<ActiveCellTranscriptKey>
```

**Purpose**: Builds the cache key describing the current live transcript tail for the transcript overlay.

**Data flow**: Reads the active transcript cell, active hook cell, pending token-activity cell, and pending rate-limit-reset hint. If all are absent it returns `None`; otherwise it returns `ActiveCellTranscriptKey { revision, is_stream_continuation, animation_tick }`, deriving continuation and animation tick from the active cell or hook cell.

**Call relations**: The transcript overlay uses this key to decide when its cached live tail must be recomputed.


##### `ChatWidget::active_cell_transcript_hyperlink_lines`  (lines 1932–1963)

```
fn active_cell_transcript_hyperlink_lines(
        &self,
        width: u16,
    ) -> Option<Vec<HyperlinkLine>>
```

**Purpose**: Collects the current live transcript tail as hyperlink-aware lines for a given width.

**Data flow**: Starts with an empty vector, appends transcript lines from the active cell, then from the active hook cell, pending token-activity cell, and pending rate-limit-reset hint, inserting blank separator lines between non-empty sections. It returns `Some(lines)` only when at least one line was produced.

**Call relations**: The transcript overlay calls this when it needs the actual rendered live-tail content corresponding to `active_cell_transcript_key`.

*Call graph*: calls 1 internal fn (from); called by 1 (active_cell_transcript_lines); 1 external calls (new).


##### `ChatWidget::active_cell_transcript_lines`  (lines 1966–1969)

```
fn active_cell_transcript_lines(&self, width: u16) -> Option<Vec<Line<'static>>>
```

**Purpose**: Test-only convenience wrapper that converts hyperlink-aware live-tail lines into visible `Line<'static>` values.

**Data flow**: Calls `active_cell_transcript_hyperlink_lines(width)` and maps the result through `crate::terminal_hyperlinks::visible_lines`.

**Call relations**: Tests use this to inspect live-tail transcript output without hyperlink metadata.

*Call graph*: calls 1 internal fn (active_cell_transcript_hyperlink_lines).


##### `ChatWidget::config_ref`  (lines 1973–1975)

```
fn config_ref(&self) -> &Config
```

**Purpose**: Returns a shared reference to the widget’s current runtime config snapshot.

**Data flow**: Returns `&self.config`.

**Call relations**: Callers use this when they need to inspect config after runtime overrides have been applied.


##### `ChatWidget::status_line_text`  (lines 1978–1980)

```
fn status_line_text(&self) -> Option<String>
```

**Purpose**: Test-only accessor returning the current bottom-pane status-line text.

**Data flow**: Delegates to `bottom_pane.status_line_text()`.

**Call relations**: Tests use this to assert status-line rendering outcomes.

*Call graph*: calls 1 internal fn (status_line_text); called by 1 (status_line_text).


##### `ChatWidget::clear_token_usage`  (lines 1982–1984)

```
fn clear_token_usage(&mut self)
```

**Purpose**: Clears the cached token-usage info without updating the bottom-pane display.

**Data flow**: Sets `self.token_info = None`.

**Call relations**: Used by flows that need to discard cached usage state before a later refresh repopulates it.


##### `has_websocket_timing_metrics`  (lines 1987–1994)

```
fn has_websocket_timing_metrics(summary: RuntimeMetricsSummary) -> bool
```

**Purpose**: Checks whether any websocket timing metrics in a runtime summary are non-zero.

**Data flow**: Returns true if any of the six timing fields on `RuntimeMetricsSummary` exceed zero.

**Call relations**: Telemetry/status logic can use this to decide whether websocket timing details are worth surfacing.


##### `ChatWidget::drop`  (lines 1997–1999)

```
fn drop(&mut self)
```

**Purpose**: Performs widget teardown by stopping the rate-limit poller when the chat widget is dropped.

**Data flow**: Calls `self.stop_rate_limit_poller()` during `Drop`.

**Call relations**: This ensures background polling tied to the widget lifecycle is cleaned up automatically.


##### `extract_first_bold`  (lines 2021–2047)

```
fn extract_first_bold(s: &str) -> Option<String>
```

**Purpose**: Extracts the first Markdown bold span `**...**` from a string and returns its trimmed inner text.

**Data flow**: Scans the byte slice for an opening `**`, then searches forward for the next closing `**`; if found, trims the inner substring and returns it when non-empty, otherwise returns `None`. If no closing delimiter exists after an opening one, it stops and returns `None`.

**Call relations**: Streaming/commentary parsing can use this to derive a heading-like label from partially accumulated markdown.


### `tui/src/chatwidget/interrupts.rs`

`orchestration` · `interrupt handling`

This file defines a small deferred-interrupt subsystem. `QueuedInterrupt` is an enum covering every interrupt-style event that may need to wait behind another visible prompt: exec approval, apply-patch approval, MCP elicitation, permission requests, tool user-input requests, and thread-item lifecycle notifications (`ItemStarted` / `ItemCompleted`). `InterruptManager` then wraps a `VecDeque<QueuedInterrupt>` and provides typed push methods so callers do not construct enum variants manually.

The manager’s behavior is intentionally simple and ordered. `new` starts with an empty queue, `is_empty` exposes whether anything is pending, and each `push_*` appends to the back. `remove_resolved_prompt` supports prompt dismissal races: when some app-server request has already been resolved elsewhere, it removes matching queued prompt overlays by retaining only entries whose `matches_resolved_prompt` returns false. Lifecycle events are deliberately never considered removable by this path.

`flush_all` is the replay mechanism. It repeatedly pops from the front and invokes the corresponding immediate `ChatWidget` handler, preserving original arrival order across heterogeneous interrupt types. `QueuedInterrupt::matches_resolved_prompt` contains the concrete matching rules for each prompt-bearing variant, including the subtle exec-approval case where the effective approval id, not necessarily the raw call id, must match the resolved request. The tests lock in user-input matching, exec-approval-id matching, and the invariant that lifecycle events survive prompt-removal filtering.

#### Function details

##### `InterruptManager::new`  (lines 36–40)

```
fn new() -> Self
```

**Purpose**: Constructs an empty interrupt queue manager.

**Data flow**: Allocates a new empty `VecDeque` and returns `InterruptManager { queue }`.

**Call relations**: Used during chat-widget construction and in tests as the starting point for deferred interrupt handling.

*Call graph*: called by 4 (new_with_op_target, remove_resolved_prompt_keeps_lifecycle_events, remove_resolved_prompt_matches_exec_approval_id, remove_resolved_prompt_removes_matching_user_input_only); 1 external calls (new).


##### `InterruptManager::is_empty`  (lines 43–45)

```
fn is_empty(&self) -> bool
```

**Purpose**: Reports whether there are any deferred interrupts waiting to be flushed.

**Data flow**: Reads `self.queue.is_empty()` and returns that boolean.

**Call relations**: Used by higher-level orchestration to decide whether deferred interrupt processing is needed.

*Call graph*: 1 external calls (is_empty).


##### `InterruptManager::push_exec_approval`  (lines 47–49)

```
fn push_exec_approval(&mut self, ev: ExecApprovalRequestEvent)
```

**Purpose**: Appends an exec-approval prompt event to the deferred interrupt queue.

**Data flow**: Wraps `ev: ExecApprovalRequestEvent` in `QueuedInterrupt::ExecApproval` and pushes it to the back of `self.queue`.

**Call relations**: Called when an exec approval arrives while another interrupt/prompt is already visible.

*Call graph*: 2 external calls (push_back, ExecApproval).


##### `InterruptManager::push_apply_patch_approval`  (lines 51–54)

```
fn push_apply_patch_approval(&mut self, ev: ApplyPatchApprovalRequestEvent)
```

**Purpose**: Appends an apply-patch approval prompt event to the deferred queue.

**Data flow**: Wraps `ev: ApplyPatchApprovalRequestEvent` in `QueuedInterrupt::ApplyPatchApproval` and pushes it onto `self.queue`.

**Call relations**: Used by approval-event handling when patch approval cannot be shown immediately.

*Call graph*: 2 external calls (push_back, ApplyPatchApproval).


##### `InterruptManager::push_elicitation`  (lines 56–63)

```
fn push_elicitation(
        &mut self,
        request_id: AppServerRequestId,
        params: McpServerElicitationRequestParams,
    )
```

**Purpose**: Queues an MCP elicitation request identified by request id and parameter payload.

**Data flow**: Builds `QueuedInterrupt::Elicitation { request_id, params }` from the arguments and pushes it to the back of `self.queue`.

**Call relations**: Used when elicitation prompts must wait behind another visible interrupt.

*Call graph*: 1 external calls (push_back).


##### `InterruptManager::push_request_permissions`  (lines 65–68)

```
fn push_request_permissions(&mut self, ev: RequestPermissionsEvent)
```

**Purpose**: Queues a permissions-approval request for later display.

**Data flow**: Wraps `ev: RequestPermissionsEvent` in `QueuedInterrupt::RequestPermissions` and pushes it onto `self.queue`.

**Call relations**: Called by permission-request handling when immediate presentation is not possible.

*Call graph*: 2 external calls (push_back, RequestPermissions).


##### `InterruptManager::push_user_input`  (lines 70–72)

```
fn push_user_input(&mut self, ev: ToolRequestUserInputParams)
```

**Purpose**: Queues a tool-originated user-input request for later handling.

**Data flow**: Wraps `ev: ToolRequestUserInputParams` in `QueuedInterrupt::RequestUserInput` and pushes it to the back of `self.queue`.

**Call relations**: Used when tool questions arrive while another interrupt overlay is active.

*Call graph*: 2 external calls (push_back, RequestUserInput).


##### `InterruptManager::push_item_started`  (lines 74–76)

```
fn push_item_started(&mut self, item: ThreadItem)
```

**Purpose**: Queues a thread-item started lifecycle event so it can be replayed after the current interrupt UI clears.

**Data flow**: Wraps `item: ThreadItem` in `QueuedInterrupt::ItemStarted` and pushes it onto `self.queue`.

**Call relations**: Used for deferred tool/lifecycle activity that should preserve ordering relative to queued prompts.

*Call graph*: 2 external calls (push_back, ItemStarted).


##### `InterruptManager::push_item_completed`  (lines 78–80)

```
fn push_item_completed(&mut self, item: ThreadItem)
```

**Purpose**: Queues a thread-item completed lifecycle event for later replay.

**Data flow**: Wraps `item: ThreadItem` in `QueuedInterrupt::ItemCompleted` and pushes it onto `self.queue`.

**Call relations**: Pairs with `push_item_started` to defer lifecycle updates while another interrupt is visible.

*Call graph*: 2 external calls (push_back, ItemCompleted).


##### `InterruptManager::remove_resolved_prompt`  (lines 82–87)

```
fn remove_resolved_prompt(&mut self, request: &ResolvedAppServerRequest) -> bool
```

**Purpose**: Removes queued prompt overlays that correspond to an app-server request already resolved elsewhere, and reports whether anything was removed.

**Data flow**: Reads the original queue length, retains only queued entries for which `matches_resolved_prompt(request)` is false, compares the new length to the original, and returns `true` if the queue shrank.

**Call relations**: Called by prompt-dismissal logic when a request is resolved before its deferred overlay is shown. It relies on `QueuedInterrupt::matches_resolved_prompt` for variant-specific matching.

*Call graph*: called by 1 (dismiss_app_server_request); 2 external calls (len, retain).


##### `InterruptManager::flush_all`  (lines 89–105)

```
fn flush_all(&mut self, chat: &mut ChatWidget)
```

**Purpose**: Replays every deferred interrupt into the live `ChatWidget` in FIFO order using the corresponding immediate handler.

**Data flow**: Takes `chat: &mut ChatWidget`, repeatedly pops the front of `self.queue`, matches on the `QueuedInterrupt` variant, and invokes the matching `chat.handle_*_now(...)` method with the stored payload. The queue is empty when the loop finishes.

**Call relations**: Used when the current interrupt UI clears and deferred events can finally be surfaced. It is the execution counterpart to the various `push_*` methods.

*Call graph*: 8 external calls (pop_front, handle_apply_patch_approval_now, handle_elicitation_request_now, handle_exec_approval_now, handle_queued_item_completed_now, handle_queued_item_started_now, handle_request_permissions_now, handle_request_user_input_now).


##### `QueuedInterrupt::matches_resolved_prompt`  (lines 109–135)

```
fn matches_resolved_prompt(&self, request: &ResolvedAppServerRequest) -> bool
```

**Purpose**: Determines whether a queued interrupt corresponds to a specific resolved app-server request and should therefore be removed from the deferred queue.

**Data flow**: Reads `self` and `request` and pattern-matches both. It compares exec approvals by `effective_approval_id()`, patch approvals by `call_id`, elicitation requests by both `server_name` and `request_id`, permission approvals by `call_id`, and tool user-input requests by `item_id`. It always returns `false` for `ItemStarted` and `ItemCompleted`.

**Call relations**: Used exclusively by `InterruptManager::remove_resolved_prompt` to implement variant-specific prompt-removal semantics.

*Call graph*: 1 external calls (matches!).


##### `tests::user_input`  (lines 149–157)

```
fn user_input(call_id: &str, turn_id: &str) -> ToolRequestUserInputParams
```

**Purpose**: Builds a minimal `ToolRequestUserInputParams` fixture for interrupt-manager tests.

**Data flow**: Takes `call_id` and `turn_id`, fills the remaining fields with fixed values (`thread-1`, empty questions, `None` auto-resolution), and returns the struct.

**Call relations**: Used by the user-input removal test to create queued request fixtures.

*Call graph*: 1 external calls (new).


##### `tests::exec_approval`  (lines 159–173)

```
fn exec_approval(call_id: &str, approval_id: Option<&str>) -> ExecApprovalRequestEvent
```

**Purpose**: Builds an `ExecApprovalRequestEvent` fixture with configurable call id and optional approval id for matching tests.

**Data flow**: Takes `call_id` and `approval_id`, constructs an `ExecApprovalRequestEvent` with fixed command/turn values, current working directory, and `None` for optional policy/amendment fields, then returns it.

**Call relations**: Used by the exec-approval matching test to verify that removal keys off the effective approval id.

*Call graph*: calls 1 internal fn (current_dir); 1 external calls (vec!).


##### `tests::command_execution`  (lines 175–188)

```
fn command_execution(call_id: &str) -> ThreadItem
```

**Purpose**: Builds a `ThreadItem::CommandExecution` fixture for lifecycle-event queue tests.

**Data flow**: Takes `call_id`, constructs a `ThreadItem::CommandExecution` with fixed command, current directory, agent source, in-progress status, and empty optional output/action fields, and returns it.

**Call relations**: Used by the lifecycle-event test to ensure `remove_resolved_prompt` does not remove non-prompt queue entries.

*Call graph*: calls 1 internal fn (current_dir); 1 external calls (new).


##### `tests::remove_resolved_prompt_removes_matching_user_input_only`  (lines 191–207)

```
fn remove_resolved_prompt_removes_matching_user_input_only()
```

**Purpose**: Verifies that removing a resolved user-input request deletes only the matching queued prompt and leaves other queued user-input requests intact.

**Data flow**: Creates a new manager, queues two user-input fixtures with different call ids, removes one via `ResolvedAppServerRequest::UserInput`, asserts the removal returned true, asserts queue length is now one, and pattern-matches the remaining front entry to confirm its `item_id` is the other call id.

**Call relations**: Exercises `InterruptManager::remove_resolved_prompt` and `QueuedInterrupt::matches_resolved_prompt` for the user-input variant.

*Call graph*: calls 1 internal fn (new); 4 external calls (assert!, assert_eq!, panic!, user_input).


##### `tests::remove_resolved_prompt_matches_exec_approval_id`  (lines 210–227)

```
fn remove_resolved_prompt_matches_exec_approval_id()
```

**Purpose**: Checks that exec-approval removal matches the effective approval id rather than the raw call id.

**Data flow**: Creates a manager, queues one exec-approval fixture with `call` and approval id `approval`, attempts removal with resolved id `call` and asserts nothing was removed, then attempts removal with resolved id `approval` and asserts the queue becomes empty.

**Call relations**: Locks in the subtle exec-approval matching rule implemented by `QueuedInterrupt::matches_resolved_prompt`.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert!, assert_eq!, exec_approval).


##### `tests::remove_resolved_prompt_keeps_lifecycle_events`  (lines 230–245)

```
fn remove_resolved_prompt_keeps_lifecycle_events()
```

**Purpose**: Ensures lifecycle events such as `ItemStarted` are never removed by prompt-resolution filtering.

**Data flow**: Creates a manager, queues one `ItemStarted` fixture, calls `remove_resolved_prompt` with an unrelated exec-approval resolution, asserts the method returned false, asserts queue length remains one, and confirms the remaining entry is still `ItemStarted`.

**Call relations**: Protects the invariant that only prompt-bearing queued interrupts participate in resolved-request removal.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert!, assert_eq!, command_execution).


### `tui/src/chatwidget/notifications.rs`

`util` · `cross-cutting during event handling and redraw/post-render notification flush`

This file gives the chat widget a single pending desktop notification slot rather than posting every event immediately. `ChatWidget::notify` first checks the user’s notification settings against the notification’s type, then compares priorities so a lower-priority event cannot replace a more important pending one. If accepted, the notification is stored in `self.pending_notification` and a redraw is requested; actual delivery is deferred until `maybe_post_pending_notification`, which drains the slot and calls the outer TUI’s notifier.

The `Notification` enum covers five concrete cases: completed agent turns, execution approval requests, edit approval requests, elicitation requests from MCP servers, and Plan-mode prompts. `display` turns each variant into user-facing text. It truncates long command strings, summarizes file edits as either a single displayed path or a file count, and uses a normalized preview of agent responses when possible.

Two small policy helpers support coalescing and filtering: `type_name` maps variants onto stable configuration keys, intentionally grouping all approval-style prompts under `approval-requested`, and `priority` gives approvals and Plan prompts precedence over passive completion notices. `agent_turn_preview` aggressively normalizes whitespace before truncation so notifications do not contain line breaks or repeated spacing, while `user_input_request_summary` extracts a short summary from the first tool-input question header or body.

#### Function details

##### `ChatWidget::notify`  (lines 6–17)

```
fn notify(&mut self, notification: Notification)
```

**Purpose**: Queues a desktop notification if it is allowed by configuration and not superseded by a higher-priority pending notification.

**Data flow**: It takes a `Notification`, reads `self.config.tui_notifications.notifications`, checks `notification.allowed_for(...)`, compares `existing.priority()` against `notification.priority()` when `self.pending_notification` is already set, and if accepted writes `Some(notification)` into `self.pending_notification` and requests redraw.

**Call relations**: This is the widget-side enqueue point for desktop notifications. It relies on `Notification::allowed_for` and `Notification::priority` to enforce filtering and coalescing before `ChatWidget::maybe_post_pending_notification` eventually emits the message.

*Call graph*: calls 2 internal fn (allowed_for, priority).


##### `ChatWidget::maybe_post_pending_notification`  (lines 19–23)

```
fn maybe_post_pending_notification(&mut self, tui: &mut crate::tui::Tui)
```

**Purpose**: Posts the currently queued notification to the outer TUI and clears it.

**Data flow**: It takes `&mut crate::tui::Tui`, removes `self.pending_notification` with `take()`, converts it to display text with `notif.display()`, and passes that string to `tui.notify(...)`. If no notification is pending, it does nothing.

**Call relations**: This is the flush side of the notification pipeline. It is called later than `ChatWidget::notify`, after the widget has had a chance to coalesce multiple events into one pending notification.

*Call graph*: 1 external calls (notify).


##### `Notification::display`  (lines 36–66)

```
fn display(&self) -> String
```

**Purpose**: Formats each notification variant into the exact desktop-notification string shown to the user.

**Data flow**: It matches on `self`. For `AgentTurnComplete` it calls `agent_turn_preview` and falls back to `Agent turn complete`; for command approvals it truncates the command; for edit approvals it formats either one displayed path relative to `cwd` or an `N files` summary; for elicitation and Plan prompts it interpolates the server name or title. It returns the final `String` without mutating state.

**Call relations**: This formatter is used by `ChatWidget::maybe_post_pending_notification` right before the notification is handed to the TUI backend.

*Call graph*: calls 1 internal fn (agent_turn_preview); 1 external calls (format!).


##### `Notification::type_name`  (lines 68–76)

```
fn type_name(&self) -> &str
```

**Purpose**: Maps a notification variant to the stable configuration category string used by custom notification settings.

**Data flow**: It matches on `self` and returns a `&str`: `agent-turn-complete`, `approval-requested`, or `plan-mode-prompt`. Multiple approval-like variants intentionally share the same category.

**Call relations**: This helper feeds `Notification::allowed_for`, which compares the returned category against the user’s configured allowlist.


##### `Notification::priority`  (lines 78–86)

```
fn priority(&self) -> u8
```

**Purpose**: Assigns a numeric priority used to decide whether a new notification may replace an already pending one.

**Data flow**: It matches on `self` and returns `0` for `AgentTurnComplete` and `1` for all approval-style and Plan-mode prompt notifications. It reads no external state.

**Call relations**: This function is consulted by `ChatWidget::notify` when a pending notification already exists; higher-priority pending notifications block replacement by lower-priority ones.

*Call graph*: called by 1 (notify).


##### `Notification::allowed_for`  (lines 88–93)

```
fn allowed_for(&self, settings: &Notifications) -> bool
```

**Purpose**: Checks whether a notification type is enabled under the current notification settings.

**Data flow**: It takes a `&Notifications` setting. For `Notifications::Enabled(enabled)` it returns that boolean directly; for `Notifications::Custom(allowed)` it returns whether any configured string equals `self.type_name()`.

**Call relations**: This policy check is used by `ChatWidget::notify` before a notification is queued.

*Call graph*: called by 1 (notify).


##### `Notification::agent_turn_preview`  (lines 95–109)

```
fn agent_turn_preview(response: &str) -> Option<String>
```

**Purpose**: Normalizes an agent response into a single-line preview suitable for a desktop notification, or returns `None` if the response is effectively empty.

**Data flow**: It takes a response string slice, splits on whitespace, rebuilds a normalized string with single spaces, trims it, and returns `None` if empty; otherwise it truncates the normalized text to `AGENT_NOTIFICATION_PREVIEW_GRAPHEMES` and returns `Some(String)`.

**Call relations**: This helper is used by `Notification::display` for `AgentTurnComplete` and elsewhere in task-completion handling to derive concise previews from full responses.

*Call graph*: called by 2 (display, on_task_complete); 1 external calls (new).


##### `Notification::user_input_request_summary`  (lines 111–125)

```
fn user_input_request_summary(
        questions: &[codex_app_server_protocol::ToolRequestUserInputQuestion],
    ) -> Option<String>
```

**Purpose**: Extracts a short summary line from the first tool user-input question for use in notifications or prompts.

**Data flow**: It takes a slice of `ToolRequestUserInputQuestion`, reads the first element if present, prefers its trimmed `header` when non-empty and otherwise its trimmed `question`, returns `None` if the chosen text is empty, and otherwise truncates it to 30 graphemes.

**Call relations**: This helper is used when the widget needs a concise summary of a user-input request, notably in the request-user-input handling path.

*Call graph*: called by 1 (handle_request_user_input_now); 1 external calls (first).


### `tui/src/chatwidget/rendering.rs`

`orchestration` · `main loop`

This file defines how the chat widget becomes a `Renderable`. `ChatWidget::as_renderable` builds a `FlexRenderable` stack representing the visible surface. It first computes the right-column reserve needed for the ambient pet/composer area, then wraps the active transcript cell, active hook cell, pending token-activity output, and pending rate-limit reset hint in `TranscriptAreaRenderable` adapters that apply a top inset and right-side width reservation. The bottom pane is wrapped separately in `BottomPaneComposerReserveRenderable`, then inset by one row at the top so it sits beneath transcript content.

`BottomPaneComposerReserveRenderable` is a thin adapter that forwards rendering, desired-height, cursor position, and cursor style queries to `BottomPane` methods that understand the reserved right margin. `TranscriptAreaRenderable` is more involved: it computes a child area by subtracting top and right insets, asks the `HistoryCell` for display lines at the available width, constructs a wrapped `Paragraph`, and scrolls vertically so the bottom of overflowing content remains visible. It clears the target area before rendering and computes desired height as the child’s desired height plus the top inset.

Finally, `ChatWidget` implements `Renderable` by delegating all four trait methods to a freshly built render tree from `as_renderable`. The `render` method additionally records the last rendered width in `last_rendered_width`, which other layout-sensitive behavior can consult later.

#### Function details

##### `ChatWidget::as_renderable`  (lines 6–60)

```
fn as_renderable(&self) -> RenderableItem<'_>
```

**Purpose**: Builds the composite render tree for the chat surface, stacking transcript content, hook output, transient notices, and the bottom pane with consistent right-margin reservation. It is the single source of layout composition for the widget.

**Data flow**: It reads `self.transcript.active_cell`, `self.active_hook_cell`, `pending_token_activity_output()`, `pending_rate_limit_reset_hint()`, `self.bottom_pane`, and `ambient_pet_wrap_reserved_cols()`. It wraps present cells in `TranscriptAreaRenderable`, pushes them into a `FlexRenderable` with chosen flex weights, wraps the bottom pane in `BottomPaneComposerReserveRenderable` plus an inset, and returns the whole structure as a `RenderableItem<'_>`.

**Call relations**: All `Renderable` trait methods on `ChatWidget` call this function so rendering, sizing, and cursor queries share the same composed layout.

*Call graph*: calls 2 internal fn (tlbr, new); called by 4 (cursor_pos, cursor_style, desired_height, render); 2 external calls (new, Owned).


##### `BottomPaneComposerReserveRenderable::render`  (lines 69–72)

```
fn render(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Renders the bottom pane while honoring the reserved composer-right margin. It is a direct adapter over the bottom pane’s specialized render method.

**Data flow**: It takes `&self`, a `Rect`, and a mutable `Buffer`, then forwards them plus `self.right_reserve` to `bottom_pane.render_with_composer_right_reserve`. It returns unit.

**Call relations**: This method is used when the composite render tree built by `ChatWidget::as_renderable` renders the bottom-pane segment.

*Call graph*: calls 1 internal fn (render_with_composer_right_reserve).


##### `BottomPaneComposerReserveRenderable::desired_height`  (lines 74–77)

```
fn desired_height(&self, width: u16) -> u16
```

**Purpose**: Reports the bottom pane’s desired height under the same right-margin reservation used for rendering. This keeps layout measurement consistent with actual drawing.

**Data flow**: It takes `&self` and `width: u16`, forwards both plus `self.right_reserve` to `bottom_pane.desired_height_with_composer_right_reserve`, and returns the resulting height.

**Call relations**: The composite layout uses this through the render tree returned by `ChatWidget::as_renderable` during height calculation.

*Call graph*: calls 1 internal fn (desired_height_with_composer_right_reserve).


##### `BottomPaneComposerReserveRenderable::cursor_pos`  (lines 79–82)

```
fn cursor_pos(&self, area: Rect) -> Option<(u16, u16)>
```

**Purpose**: Computes the cursor position for the bottom pane with the reserved right margin applied. It preserves correct cursor placement when the composer shares horizontal space.

**Data flow**: It takes `&self` and an `area: Rect`, forwards them plus `self.right_reserve` to `bottom_pane.cursor_pos_with_composer_right_reserve`, and returns the optional `(x, y)` cursor position.

**Call relations**: This adapter participates in cursor queries initiated through `ChatWidget`’s `Renderable` implementation.

*Call graph*: calls 1 internal fn (cursor_pos_with_composer_right_reserve).


##### `BottomPaneComposerReserveRenderable::cursor_style`  (lines 84–87)

```
fn cursor_style(&self, area: Rect) -> crossterm::cursor::SetCursorStyle
```

**Purpose**: Returns the cursor style the bottom pane wants under the reserved-right layout. It is a direct forwarding adapter.

**Data flow**: It takes `&self` and an `area: Rect`, forwards them plus `self.right_reserve` to `bottom_pane.cursor_style_with_composer_right_reserve`, and returns the resulting `SetCursorStyle`.

**Call relations**: Like `cursor_pos`, this is used through the composite render tree assembled by `ChatWidget::as_renderable`.

*Call graph*: calls 1 internal fn (cursor_style_with_composer_right_reserve).


##### `TranscriptAreaRenderable::render`  (lines 97–111)

```
fn render(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Renders a single `HistoryCell` into a transcript sub-area with top/right insets and bottom-aligned vertical scrolling for overflow. It ensures the newest lines remain visible when content exceeds the available height.

**Data flow**: It takes `&self`, an `area: Rect`, and a mutable `Buffer`. It computes the child area via `child_area`, asks the `HistoryCell` for `display_lines(area.width)`, wraps them in a `Paragraph`, computes overflow by comparing `line_count` to available height, converts that overflow to a scroll offset, clears the area, and renders the paragraph scrolled by `(y, 0)`.

**Call relations**: Instances of this adapter are created by `ChatWidget::as_renderable` for active transcript cells, hook cells, and transient notice cells.

*Call graph*: calls 1 internal fn (child_area); 5 external calls (new, from, display_lines, try_from, from).


##### `TranscriptAreaRenderable::desired_height`  (lines 113–116)

```
fn desired_height(&self, width: u16) -> u16
```

**Purpose**: Computes the total height needed for a transcript child including its top inset and reduced width from right reservation. It delegates the content-specific sizing to the `HistoryCell`.

**Data flow**: It takes `&self` and `width: u16`, computes `child_width = width.saturating_sub(self.right).max(1)`, asks `HistoryCell::desired_height(self.child, child_width)`, adds `self.top`, and returns the sum.

**Call relations**: This sizing method is used by the composite layout built in `ChatWidget::as_renderable`.

*Call graph*: calls 1 internal fn (desired_height).


##### `TranscriptAreaRenderable::child_area`  (lines 120–129)

```
fn child_area(&self, area: Rect) -> Rect
```

**Purpose**: Derives the inner rectangle available to the wrapped transcript child after applying top and right reservations. It guarantees a minimum width of one column.

**Data flow**: It takes `&self` and an outer `Rect`, computes a y-offset by adding `self.top`, reduces height by the same amount, subtracts `self.right` from width with saturation and `max(1)`, constructs a new `Rect`, and returns it.

**Call relations**: This helper is called by `TranscriptAreaRenderable::render` before line generation and paragraph rendering.

*Call graph*: called by 1 (render); 1 external calls (new).


##### `ChatWidget::render`  (lines 133–136)

```
fn render(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Renders the full chat widget using the composed render tree and records the width that was last drawn. The width cache supports later layout-sensitive behavior elsewhere in the widget.

**Data flow**: It takes `&self`, an `area: Rect`, and a mutable `Buffer`, calls `self.as_renderable().render(area, buf)`, then writes `Some(area.width as usize)` into `self.last_rendered_width`. It returns unit.

**Call relations**: This is the `Renderable` trait entrypoint for drawing the widget and delegates actual composition to `ChatWidget::as_renderable`.

*Call graph*: calls 1 internal fn (as_renderable).


##### `ChatWidget::desired_height`  (lines 138–140)

```
fn desired_height(&self, width: u16) -> u16
```

**Purpose**: Reports the widget’s desired height by delegating to the composed render tree. It keeps sizing logic centralized in `as_renderable`.

**Data flow**: It takes `&self` and `width: u16`, calls `self.as_renderable().desired_height(width)`, and returns the resulting height.

**Call relations**: This trait method relies entirely on `ChatWidget::as_renderable` so measurement matches rendering.

*Call graph*: calls 1 internal fn (as_renderable).


##### `ChatWidget::cursor_pos`  (lines 142–144)

```
fn cursor_pos(&self, area: Rect) -> Option<(u16, u16)>
```

**Purpose**: Returns the cursor position for the current composed chat surface. It delegates to the same render tree used for drawing.

**Data flow**: It takes `&self` and an `area: Rect`, calls `self.as_renderable().cursor_pos(area)`, and returns the optional cursor coordinates.

**Call relations**: This trait method shares layout logic with rendering through `ChatWidget::as_renderable`.

*Call graph*: calls 1 internal fn (as_renderable).


##### `ChatWidget::cursor_style`  (lines 146–148)

```
fn cursor_style(&self, area: Rect) -> crossterm::cursor::SetCursorStyle
```

**Purpose**: Returns the cursor style for the current composed chat surface. It delegates to the render tree so style follows whichever child currently owns the cursor.

**Data flow**: It takes `&self` and an `area: Rect`, calls `self.as_renderable().cursor_style(area)`, and returns the resulting cursor style.

**Call relations**: This is the final `Renderable` trait adapter over `ChatWidget::as_renderable`.

*Call graph*: calls 1 internal fn (as_renderable).


### Interaction and input pipeline
Covers user interaction handling from keyboard/composer actions through queued input management, restoration, and final submission.

### `tui/src/chatwidget/input_queue.rs`

`data_model` · `cross-cutting`

This file is the data-centric half of chat input queueing. `InputQueueState` groups all mutable queues that represent deferred user intent: `queued_user_messages` for ordinary follow-ups, `rejected_steers_queue` for steer messages that must be retried before regular queued input, `pending_steers` for steers already sent to core but not yet committed into history, and booleans controlling pending-start and autosend behavior. Two parallel `VecDeque<UserMessageHistoryRecord>` fields intentionally mirror the queued and rejected message deques because slash-command submissions can render different history text than the payload sent to core; missing history entries are treated as plain user-message text by consumers.

The behavior here is deliberately reducer-like. `has_queued_follow_up_messages` collapses the two deferred-message categories into one predicate. `clear` resets every queue and all interrupt-related flags except `suppress_queue_autosend`, which is notably preserved because autosend suppression is a separate policy toggle rather than transient queue content. `preview` converts the three queue categories into display strings while keeping them separate, using `user_message_preview_text` and index-based lookup into the parallel history-record deques. The tests lock in two important invariants: preview output must not merge categories, and `clear` must fully empty all queue-like state and reset pending-turn / pending-steer restoration flags.

#### Function details

##### `InputQueueState::has_queued_follow_up_messages`  (lines 48–50)

```
fn has_queued_follow_up_messages(&self) -> bool
```

**Purpose**: Reports whether there is any deferred user input waiting outside the pending-steer list. It treats rejected steers and ordinary queued messages as the two follow-up categories.

**Data flow**: Reads `self.rejected_steers_queue.is_empty()` and `self.queued_user_messages.is_empty()`, negates the emptiness checks, and returns true if either deque contains entries.

**Call relations**: Used by higher-level chat-widget logic when deciding whether queued drafts exist, including interrupt restore and queued-message editing flows.

*Call graph*: 1 external calls (is_empty).


##### `InputQueueState::clear`  (lines 52–60)

```
fn clear(&mut self)
```

**Purpose**: Resets the queue state to an empty baseline after thread restoration or teardown-like transitions. It clears all queued/pending message collections and transient restoration flags.

**Data flow**: Calls `clear()` on `queued_user_messages`, `queued_user_message_history_records`, `rejected_steers_queue`, `rejected_steer_history_records`, and `pending_steers`; sets `user_turn_pending_start` and `submit_pending_steers_after_interrupt` to `false`. It returns no value.

**Call relations**: Called from thread-input restoration when no saved state exists. The tests verify that it fully empties queue content and resets the associated booleans.

*Call graph*: 1 external calls (clear).


##### `InputQueueState::preview`  (lines 62–95)

```
fn preview(&self) -> PendingInputPreview
```

**Purpose**: Builds a UI-friendly snapshot of queued input text grouped into queued messages, pending steers, and rejected steers. It preserves category boundaries instead of flattening everything into one list.

**Data flow**: Iterates over `queued_user_messages` with indices and maps each entry plus the optional parallel history record to `user_message_preview_text`. It separately maps `pending_steers` using each steer's embedded `history_record`, and maps `rejected_steers_queue` with indexed lookup into `rejected_steer_history_records`. It returns a `PendingInputPreview` containing the three collected `Vec<String>` lists.

**Call relations**: Consumed by `ChatWidget::refresh_pending_input_preview` to update the bottom-pane preview after queue mutations.

*Call graph*: 1 external calls (iter).


##### `tests::preview_keeps_queue_categories_separate`  (lines 105–130)

```
fn preview_keeps_queue_categories_separate()
```

**Purpose**: Verifies that `preview()` reports queued messages, pending steers, and rejected steers in distinct output vectors rather than merging or reordering them.

**Data flow**: Creates a default `InputQueueState`, pushes one sample message into each queue category, calls `state.preview()`, and asserts equality with an explicit `PendingInputPreview` containing one string in each corresponding field.

**Call relations**: This test exercises the preview-building logic directly and protects the UI contract relied on by the pending-input preview.

*Call graph*: calls 1 internal fn (from); 2 external calls (assert_eq!, default).


##### `tests::clear_resets_all_input_queues`  (lines 133–153)

```
fn clear_resets_all_input_queues()
```

**Purpose**: Checks that `clear()` empties every queue and resets the pending-turn and pending-steer restoration flags.

**Data flow**: Builds a non-empty `InputQueueState`, sets `user_turn_pending_start` and `submit_pending_steers_after_interrupt` true, invokes `state.clear()`, and asserts that all deques are empty and both booleans are false.

**Call relations**: This test locks in the reset semantics used by thread-state restoration when discarding prior input state.

*Call graph*: calls 1 internal fn (from); 2 external calls (assert!, default).


### `tui/src/chatwidget/input_restore.rs`

`domain_logic` · `interrupt handling`

This module covers the recovery side of chat input. One cluster of methods manages `cancel_edit`: after a visible user message is submitted, `record_cancel_edit_candidate` stores it as a possible restoration target; later UI activity can disqualify it, and `arm_cancel_edit` only arms restoration when the composer is empty, there are no pending or queued follow-ups, and no side conversation is active. `take_armed_cancel_edit_prompt` then restores that prompt only for `TurnAbortReason::Interrupted`.

The queue-restore path is more involved. `pop_next_queued_user_message` gives queue draining a priority rule: if any rejected steers exist, they are drained and merged into one `QueuedUserMessage` with a merged history record before ordinary queued messages are considered. `pop_latest_queued_composer_state` supports “edit queued message” by pulling the newest queued or rejected item back into a `ThreadComposerState`. `enqueue_rejected_steer` moves the oldest pending steer into the rejected queue when core reports the active turn was not steerable.

`on_interrupted_turn` finalizes the turn, emits either an interruption notice or a steer-submission notice, then either immediately resubmits merged pending steers or restores all pending content into the composer. `drain_pending_messages_for_restore` is the key merger: it drains rejected steers, pending steers, queued messages, and the current composer draft; converts history-aware representations back into editable `UserMessage`s; remaps colliding paste placeholders with a shared `HashSet`; merges messages in stable order; and returns a single `ThreadComposerState`. The file also snapshots and restores full `ThreadInputState`, carefully resizing parallel history-record vectors and reconstructing missing `PendingSteerCompareKey` values when older snapshots lack them.

#### Function details

##### `ChatWidget::record_cancel_edit_candidate`  (lines 9–13)

```
fn record_cancel_edit_candidate(&mut self, prompt: UserMessage)
```

**Purpose**: Stores the just-submitted prompt as the candidate to restore if the turn is later interrupted before meaningful visible activity occurs.

**Data flow**: Takes a `UserMessage` and writes it into `self.cancel_edit.prompt = Some(prompt)`, sets `eligible = true`, and clears `armed = false`.

**Call relations**: Called after successful user-message submission in the normal render-in-history path so later interrupt handling can optionally restore that prompt.


##### `ChatWidget::record_visible_turn_activity`  (lines 15–18)

```
fn record_visible_turn_activity(&mut self)
```

**Purpose**: Disqualifies cancel-edit restoration once the turn has produced visible activity. After this point an interrupt should not silently restore the original prompt as if nothing happened.

**Data flow**: Mutates `self.cancel_edit.eligible` and `self.cancel_edit.armed` to `false`. It leaves any stored prompt in place.

**Call relations**: Used by turn-lifecycle code outside this file when visible output arrives, narrowing the conditions under which `on_interrupted_turn` may restore a cancelled prompt.


##### `ChatWidget::arm_cancel_edit`  (lines 20–27)

```
fn arm_cancel_edit(&mut self)
```

**Purpose**: Arms prompt restoration for a future interrupt only when the UI is in a clean state with no competing draft or queued input.

**Data flow**: Reads `self.cancel_edit.eligible`, whether a prompt exists, `self.bottom_pane.composer_is_empty()`, `self.input_queue.pending_steers.is_empty()`, `self.has_queued_follow_up_messages()`, and `self.active_side_conversation`. It writes the conjunction of those conditions into `self.cancel_edit.armed`.

**Call relations**: This method prepares the state later consumed by `take_armed_cancel_edit_prompt` during interrupted-turn handling.


##### `ChatWidget::take_armed_cancel_edit_prompt`  (lines 29–35)

```
fn take_armed_cancel_edit_prompt(&mut self, reason: TurnAbortReason) -> Option<UserMessage>
```

**Purpose**: Consumes and returns the stored cancel-edit prompt only for a user interrupt and only if restoration was both eligible and armed.

**Data flow**: Takes `reason: TurnAbortReason`, checks whether it equals `Interrupted` and whether `self.cancel_edit.armed` and `eligible` are true, then `take()`s `self.cancel_edit.prompt` and returns the resulting `Option<UserMessage>`. Otherwise it returns `None` without mutation.

**Call relations**: Called at the start of `on_interrupted_turn` to decide whether the interrupted turn should restore the original prompt via an app event.

*Call graph*: called by 1 (on_interrupted_turn).


##### `ChatWidget::clear_cancel_edit`  (lines 37–39)

```
fn clear_cancel_edit(&mut self)
```

**Purpose**: Resets all cancel-edit tracking to its default empty state.

**Data flow**: Replaces `self.cancel_edit` with `CancelEditState::default()`. It returns no value.

**Call relations**: Used when the widget needs to discard any pending cancel-edit restoration context entirely.

*Call graph*: 1 external calls (default).


##### `ChatWidget::set_initial_user_message_submit_suppressed`  (lines 41–43)

```
fn set_initial_user_message_submit_suppressed(&mut self, suppressed: bool)
```

**Purpose**: Enables or disables deferred submission of the initial user message. This is a simple policy flag setter.

**Data flow**: Writes the `suppressed` argument into `self.suppress_initial_user_message_submit`.

**Call relations**: Consulted later by `submit_initial_user_message_if_pending` during startup-like flows.


##### `ChatWidget::submit_initial_user_message_if_pending`  (lines 45–56)

```
fn submit_initial_user_message_if_pending(&mut self)
```

**Purpose**: Submits the stored initial user message once startup conditions allow it. It respects explicit suppression and a Windows sandbox setup gate.

**Data flow**: Reads `self.suppress_initial_user_message_submit`; on Windows/test builds also checks `self.elevated_windows_sandbox_setup_required()`. If neither blocks submission and `self.initial_user_message.take()` yields a message, it submits that message via `submit_user_message`.

**Call relations**: Used during early thread/session setup to release an initial prompt that was staged before the widget was ready.


##### `ChatWidget::pop_next_queued_user_message`  (lines 58–96)

```
fn pop_next_queued_user_message(
        &mut self,
    ) -> Option<(QueuedUserMessage, UserMessageHistoryRecord)>
```

**Purpose**: Removes the next queued input to process, giving rejected steers priority and merging all rejected steers into one synthetic queued message when present.

**Data flow**: If `rejected_steers_queue` is empty, it pops the front `QueuedUserMessage` and the matching front history record from `queued_user_message_history_records`, defaulting missing history to `UserMessageText`, and returns the pair. Otherwise it drains all rejected steer messages and all rejected history records into vectors, resizes the history vector to match message count with default records, merges them via `merge_user_messages_with_history_record`, wraps the merged message in `QueuedUserMessage::from`, and returns that plus the merged history record.

**Call relations**: Consumed by `maybe_send_next_queued_input` so queue draining always retries rejected steers before ordinary queued follow-ups.

*Call graph*: calls 1 internal fn (from).


##### `ChatWidget::pop_latest_queued_composer_state`  (lines 98–126)

```
fn pop_latest_queued_composer_state(&mut self) -> Option<ThreadComposerState>
```

**Purpose**: Pops the most recently queued draft-like input and converts it back into editable composer state for the “edit queued message” shortcut.

**Data flow**: First tries `queued_user_messages.pop_back()` and the matching history record from `queued_user_message_history_records.pop_back()`, defaulting missing history. It extracts `user_message` and `pending_pastes`, converts the message through `user_message_for_restore`, then through `composer_state_from_user_message`, and returns the resulting `ThreadComposerState`. If no queued message exists, it instead pops the newest rejected steer and matching history record, converts it similarly, and returns that state with empty pending pastes. If neither queue has entries, it returns `None`.

**Call relations**: Called from keyboard interaction when the user requests to edit the latest queued message instead of leaving it in the queue.

*Call graph*: 2 external calls (composer_state_from_user_message, new).


##### `ChatWidget::enqueue_rejected_steer`  (lines 128–143)

```
fn enqueue_rejected_steer(&mut self) -> bool
```

**Purpose**: Moves the oldest pending steer into the rejected-steer queue after core reports that the active turn could not accept steer input.

**Data flow**: Attempts to pop the front `PendingSteer` from `self.input_queue.pending_steers`. If none exists, it logs a warning and returns `false`. Otherwise it pushes the steer's `user_message` and `history_record` onto the rejected-steer queues, refreshes the pending-input preview, and returns `true`.

**Call relations**: Used by error-handling paths outside this file when an active-turn-not-steerable response arrives. It preserves the steer for retry before later queued messages.

*Call graph*: 1 external calls (warn!).


##### `ChatWidget::on_interrupted_turn`  (lines 149–198)

```
fn on_interrupted_turn(&mut self, reason: TurnAbortReason)
```

**Purpose**: Handles turn abortion by finalizing running state, surfacing the right interruption notice, and either restoring pending input into the composer or immediately resubmitting pending steers.

**Data flow**: Takes `reason`, first consumes any armed cancel-edit prompt via `take_armed_cancel_edit_prompt`, then calls `finalize_turn()`. It reads and clears `input_queue.submit_pending_steers_after_interrupt`. Unless a cancel-edit prompt exists or notices are suppressed, it appends either an info event about interrupting to submit steers or an error event from `interrupted_turn_message(reason)`. If pending steers should be sent immediately, it drains `pending_steers`, merges them with history if non-empty, and submits them; otherwise, or if no pending steers remained, it calls `drain_pending_messages_for_restore()` and restores the resulting composer state if any. It refreshes the pending preview, emits `AppEvent::RestoreCancelledTurn(prompt)` if a cancel-edit prompt was taken, and requests redraw.

**Call relations**: This is the central interrupt-recovery orchestrator. It depends on `take_armed_cancel_edit_prompt` and `drain_pending_messages_for_restore`, and delegates actual composer restoration to `restore_composer_state`.

*Call graph*: calls 3 internal fn (drain_pending_messages_for_restore, restore_composer_state, take_armed_cancel_edit_prompt); 3 external calls (RestoreCancelledTurn, new_error_event, new_info_event).


##### `ChatWidget::drain_pending_messages_for_restore`  (lines 207–292)

```
fn drain_pending_messages_for_restore(&mut self) -> Option<ThreadComposerState>
```

**Purpose**: Drains all locally tracked pending input sources and merges them into one `ThreadComposerState` suitable for restoring into the composer after an interrupt.

**Data flow**: If both `pending_steers` and queued follow-up messages are empty, it returns `None`. Otherwise it snapshots the current composer draft into an `existing_message`, drains rejected steers plus history records and converts them with `user_message_for_restore`, drains pending steers similarly, then drains queued user messages plus history records. For each queued message it calls `remap_colliding_paste_placeholders`, accumulating remapped messages and `pending_pastes` while tracking used placeholders in a `HashSet`. If the current composer already has content, it also remaps its placeholders and appends it. Finally it merges all collected `UserMessage`s with `merge_user_messages`, converts the result plus accumulated `pending_pastes` through `composer_state_from_user_message`, and returns `Some(ThreadComposerState)`.

**Call relations**: Called only by `on_interrupted_turn`. It encapsulates the tricky restore-time invariants around placeholder collision avoidance, history-aware text restoration, and stable merge ordering.

*Call graph*: calls 1 internal fn (remap_colliding_paste_placeholders); called by 1 (on_interrupted_turn); 3 external calls (new, composer_state_from_user_message, new).


##### `ChatWidget::restore_user_message_to_composer`  (lines 294–299)

```
fn restore_user_message_to_composer(&mut self, user_message: UserMessage)
```

**Purpose**: Restores a single `UserMessage` into the composer without any pending-paste metadata. It is a convenience wrapper for blocked or deferred submissions.

**Data flow**: Takes a `UserMessage`, converts it to `ThreadComposerState` with empty `pending_pastes` via `composer_state_from_user_message`, and passes that state to `restore_composer_state`.

**Call relations**: Used by submission logic when a message cannot be sent and should be put back into the composer intact.

*Call graph*: calls 1 internal fn (restore_composer_state); 2 external calls (composer_state_from_user_message, new).


##### `ChatWidget::restore_composer_state`  (lines 301–319)

```
fn restore_composer_state(&mut self, composer: ThreadComposerState)
```

**Purpose**: Applies a full `ThreadComposerState` snapshot back into the bottom-pane composer, including text, images, mentions, and pending pastes.

**Data flow**: Destructures the `ThreadComposerState` into text, image lists, text elements, mention bindings, and pending pastes. It maps `local_images` to their paths, writes remote image URLs via `set_remote_image_urls`, updates the composer text and mention bindings with `bottom_pane.set_composer_text_with_mention_bindings(...)`, and restores pending pastes with `bottom_pane.set_composer_pending_pastes(...)`.

**Call relations**: Called from interrupted-turn recovery, thread-state restoration, and single-message restoration helpers whenever the widget needs to repopulate the composer UI.

*Call graph*: called by 3 (on_interrupted_turn, restore_thread_input_state, restore_user_message_to_composer).


##### `ChatWidget::composer_state_from_user_message`  (lines 321–340)

```
fn composer_state_from_user_message(
        user_message: UserMessage,
        pending_pastes: Vec<(String, String)>,
    ) -> ThreadComposerState
```

**Purpose**: Converts a `UserMessage` plus pending-paste metadata into the `ThreadComposerState` shape used by restore and snapshot code.

**Data flow**: Consumes a `UserMessage` and `pending_pastes`, destructures the message fields, and returns a `ThreadComposerState` containing the same text, images, text elements, mention bindings, and the supplied pending pastes.

**Call relations**: Used internally by restore helpers to normalize message-shaped data into the composer-state representation expected by `restore_composer_state`.


##### `ChatWidget::capture_thread_input_state`  (lines 342–385)

```
fn capture_thread_input_state(&self) -> Option<ThreadInputState>
```

**Purpose**: Snapshots the current composer and all queue-related input state so it can be restored when switching threads or rebuilding widget state.

**Data flow**: Reads a composer draft snapshot from `bottom_pane`, wraps it into `ThreadComposerState`, and stores it as `Some` only if `has_content()` is true. It clones pending steers into parallel vectors of messages, history records, and compare keys; clones rejected-steer and queued-message deques plus their history-record deques; copies `user_turn_pending_start`, current/active collaboration mode fields, `bottom_pane.is_task_running()`, and `turn_lifecycle.agent_turn_running`; and returns `Some(ThreadInputState { ... })`.

**Call relations**: Paired with `restore_thread_input_state`. It is used when preserving per-thread draft and queue state across thread switches.


##### `ChatWidget::restore_thread_input_state`  (lines 387–449)

```
fn restore_thread_input_state(&mut self, input_state: Option<ThreadInputState>)
```

**Purpose**: Rehydrates the composer, queue state, and collaboration/task indicators from an optional `ThreadInputState` snapshot, or clears them when no snapshot exists.

**Data flow**: Reads whether the incoming snapshot claimed `task_running`. If `Some`, it restores collaboration mode fields, running-state flags, `user_turn_pending_start`, model-dependent surfaces, and composer state. It then reconstructs `input_queue.pending_steers` by zipping saved pending-steer messages with resized history records and compare keys, synthesizing a `PendingSteerCompareKey` from message text and image count when missing. It restores rejected and queued deques plus their history-record deques, resizing those history deques to match queue lengths. If `None`, it clears running state, calls `input_queue.clear()`, and restores an empty composer. In both cases it refreshes task-running state, forces the bottom pane's task-running indicator back on if the snapshot said so but the current state did not, refreshes the pending preview, and requests redraw.

**Call relations**: This is the inverse of `capture_thread_input_state`. It delegates composer application to `restore_composer_state` and uses `InputQueueState::clear` when discarding prior thread input.

*Call graph*: calls 1 internal fn (restore_composer_state); 2 external calls (default, now).


##### `ChatWidget::set_queue_autosend_suppressed`  (lines 451–453)

```
fn set_queue_autosend_suppressed(&mut self, suppressed: bool)
```

**Purpose**: Toggles the flag that prevents queued inputs from being auto-submitted when the widget becomes idle.

**Data flow**: Writes the `suppressed` argument into `self.input_queue.suppress_queue_autosend`.

**Call relations**: This flag is later consulted by `maybe_send_next_queued_input` in the input-flow module.


### `tui/src/chatwidget/input_submission.rs`

`domain_logic` · `request handling`

This file is the core submission pipeline for chat input. `user_message_from_submission` captures the transient composer-side attachments and mention bindings that accompany submitted text. From there, shell-prefixed input and normal model input diverge. `submit_shell_command` trims the command, emits a help info event for empty `!` submissions, or sends `AppCommand::run_user_shell_command`; `submit_queued_shell_prompt` reuses that behavior when draining queued messages.

The main logic lives in `submit_user_message_with_history_and_shell_escape_policy`. It first enforces preconditions: unconfigured sessions cause front-of-queue insertion instead of loss, empty messages are rejected, and image-bearing messages are restored to the composer with a warning if the current model lacks image support. For accepted messages, it constructs `Vec<UserInput>` in protocol order: remote images, local images, then text with converted `TextElement`s. It resolves mentions from both explicit `mention_bindings` and parsed text mentions, deduplicating selected skills, plugins, and apps with `HashSet`s and preserving bound mentions over heuristic discovery.

Before sending, it validates that the effective collaboration mode has a non-empty model, optionally injects IDE context, computes collaboration-mode and personality/service-tier metadata, and builds `AppCommand::user_turn`. After successful submission it updates pending-turn state, appends encoded history text with mention placeholders, tracks pending steers for non-history-rendered submissions, records cancel-edit candidates for visible user turns, and emits the display-form user message into transcript history. The blocked-image restore path intentionally restores mention bindings too, so retries preserve exact mention resolution rather than degrading to plain text tokens.

#### Function details

##### `ChatWidget::user_message_from_submission`  (lines 6–22)

```
fn user_message_from_submission(
        &mut self,
        text: String,
        text_elements: Vec<TextElement>,
    ) -> UserMessage
```

**Purpose**: Packages submitted composer text together with the attachments and mention bindings captured at submission time into a `UserMessage`.

**Data flow**: Takes `text` and `text_elements`, drains recent local images from `bottom_pane.take_recent_submission_images_with_placeholders()`, drains remote image URLs from `self.take_remote_image_urls()`, drains mention bindings from `bottom_pane.take_recent_submission_mention_bindings()`, and returns a `UserMessage` containing all of those fields.

**Call relations**: Used by input-flow code whenever the composer reports a submitted or queued message so later submission/queue logic works with a complete message object.


##### `ChatWidget::submit_shell_command`  (lines 24–38)

```
fn submit_shell_command(&mut self, command: &str) -> QueueDrain
```

**Purpose**: Executes a local shell command requested via `!` syntax, or shows shell-command help when the command body is empty after trimming.

**Data flow**: Reads `command`, trims it to `cmd`, and branches. If `cmd` is empty, it sends `AppEvent::InsertHistoryCell` containing an info event with `USER_SHELL_COMMAND_HELP_TITLE` and `USER_SHELL_COMMAND_HELP_HINT`, then returns `QueueDrain::Continue`. Otherwise it submits `AppCommand::run_user_shell_command(cmd.to_string())` and returns `QueueDrain::Stop`.

**Call relations**: This is the primitive shell-execution helper. `submit_shell_command_with_history` wraps it to append history only when an actual command was launched.

*Call graph*: called by 1 (submit_shell_command_with_history); 4 external calls (new, run_user_shell_command, InsertHistoryCell, new_info_event).


##### `ChatWidget::submit_shell_command_with_history`  (lines 40–50)

```
fn submit_shell_command_with_history(
        &mut self,
        command: &str,
        history_text: &str,
    ) -> QueueDrain
```

**Purpose**: Runs a shell command and records the original `!` text in message history only when execution actually starts.

**Data flow**: Takes `command` and `history_text`, delegates to `submit_shell_command`, and if the returned `QueueDrain` is `Stop`, appends `history_text.to_string()` to message history. It returns the same `QueueDrain` value.

**Call relations**: Called from both queued-shell submission and the main user-message submission path when shell escapes are allowed.

*Call graph*: calls 1 internal fn (submit_shell_command); called by 2 (submit_queued_shell_prompt, submit_user_message_with_history_and_shell_escape_policy).


##### `ChatWidget::submit_queued_shell_prompt`  (lines 52–63)

```
fn submit_queued_shell_prompt(&mut self, user_message: UserMessage) -> QueueDrain
```

**Purpose**: Processes a queued message that may represent either a shell escape or a normal user message. It preserves the original queued text for history when executing shell commands.

**Data flow**: Consumes a `UserMessage` and checks `user_message.text.strip_prefix('!')`. If present, it clones the full original text into `history_text` and delegates to `submit_shell_command_with_history`; otherwise it submits the message normally with `submit_user_message` and returns `QueueDrain::Stop`.

**Call relations**: Used by queue draining for `QueuedInputAction::RunShell`, allowing queued shell prompts to share the same shell/help/history semantics as immediate submissions.

*Call graph*: calls 2 internal fn (submit_shell_command_with_history, submit_user_message).


##### `ChatWidget::submit_user_message`  (lines 65–70)

```
fn submit_user_message(&mut self, user_message: UserMessage)
```

**Purpose**: Submits a user message using the default history-record behavior and ignores the returned acceptance flag.

**Data flow**: Takes a `UserMessage`, calls `submit_user_message_with_history_record(user_message, UserMessageHistoryRecord::UserMessageText)`, stores the boolean in `_accepted`, and returns no value.

**Call relations**: This is the common convenience entry used by queue draining and other callers that do not need custom history rendering.

*Call graph*: calls 1 internal fn (submit_user_message_with_history_record); called by 1 (submit_queued_shell_prompt).


##### `ChatWidget::submit_user_message_with_history_record`  (lines 72–83)

```
fn submit_user_message_with_history_record(
        &mut self,
        user_message: UserMessage,
        history_record: UserMessageHistoryRecord,
    ) -> bool
```

**Purpose**: Submits a user message with an explicit history-record policy while allowing shell escapes. It returns whether the submission was accepted.

**Data flow**: Takes `user_message` and `history_record`, forwards them plus `ShellEscapePolicy::Allow` to `submit_user_message_with_history_and_shell_escape_policy`, and returns the boolean acceptance component of the tuple.

**Call relations**: Called by `submit_user_message` and queue-drain code when slash-command-derived history text may differ from the actual payload.

*Call graph*: calls 1 internal fn (submit_user_message_with_history_and_shell_escape_policy); called by 1 (submit_user_message).


##### `ChatWidget::submit_user_message_with_shell_escape_policy`  (lines 85–96)

```
fn submit_user_message_with_shell_escape_policy(
        &mut self,
        user_message: UserMessage,
        shell_escape_policy: ShellEscapePolicy,
    ) -> Option<AppCommand>
```

**Purpose**: Submits a user message while letting the caller control whether leading `!` should be interpreted as a shell escape. It returns the generated `AppCommand` when one was produced.

**Data flow**: Takes `user_message` and `shell_escape_policy`, forwards them with `UserMessageHistoryRecord::UserMessageText` to the main submission routine, and returns the optional `AppCommand` component of the result tuple.

**Call relations**: Used by callers that need access to the exact operation generated by submission or need to disable shell-escape interpretation.

*Call graph*: calls 1 internal fn (submit_user_message_with_history_and_shell_escape_policy).


##### `ChatWidget::submit_user_message_with_history_and_shell_escape_policy`  (lines 98–421)

```
fn submit_user_message_with_history_and_shell_escape_policy(
        &mut self,
        user_message: UserMessage,
        history_record: UserMessageHistoryRecord,
        shell_escape_policy: ShellE
```

**Purpose**: Validates, transforms, and submits a `UserMessage` as either a shell command or a model user turn, while updating queue state, transcript history, pending steers, and restoration state.

**Data flow**: Consumes `user_message`, `history_record`, and `shell_escape_policy`. If the session is not configured, it warns, pushes the message and history record to the front of the queued-message deques, refreshes the preview, and returns `(true, None)`. If the message has no text or images, it returns `(false, None)`. If it contains images unsupported by the current model, it converts the message through `user_message_for_restore`, restores it to the composer with `restore_blocked_image_submission`, and returns `(false, None)`. Otherwise it destructures the message, computes whether to render in history based on `agent_turn_running`, and builds `items: Vec<UserInput>`: shell escape handling may short-circuit to `submit_shell_command_with_history`; otherwise remote images become `UserInput::Image`, local images become `UserInput::LocalImage`, and non-empty text becomes `UserInput::Text` with converted text elements. It parses mentions, deduplicates and appends `UserInput::Skill` and `UserInput::Mention` entries from explicit bindings and discovered mentions across skills, plugins, and apps. It validates that `effective_collaboration_mode().model()` is non-empty, restoring the message to the composer and emitting an error if not. It then mutates `items` via `maybe_apply_ide_context`, computes optional collaboration-mode metadata, optional `PendingSteer`, personality, service tier, and permission settings, builds `AppCommand::user_turn`, and submits it. On success it may set `input_queue.user_turn_pending_start`, append encoded history text with mention placeholders, push a pending steer and refresh the preview, record a cancel-edit candidate, emit a display-form user message into transcript history, clear `transcript.needs_final_message_separator`, and return `(true, Some(op))`.

**Call relations**: This is the central submission engine called by both public submission wrappers. It delegates blocked-image restoration, shell execution, and IDE-context augmentation to specialized helpers while owning the overall acceptance/rejection and bookkeeping flow.

*Call graph*: calls 5 internal fn (from, connector_mention_slug, restore_blocked_image_submission, submit_shell_command_with_history, from); called by 2 (submit_user_message_with_history_record, submit_user_message_with_shell_escape_policy); 8 external calls (new, new, new, new, run_user_shell_command, user_turn, format!, warn!).


##### `ChatWidget::restore_blocked_image_submission`  (lines 430–451)

```
fn restore_blocked_image_submission(
        &mut self,
        text: String,
        text_elements: Vec<TextElement>,
        local_images: Vec<LocalImageAttachment>,
        mention_bindings: Vec<Me
```

**Purpose**: Restores an image-bearing draft back into the composer when the current model cannot accept image inputs, preserving mention bindings for an accurate retry.

**Data flow**: Takes text, text elements, local images, mention bindings, and remote image URLs. It maps local images to their paths, writes remote URLs via `set_remote_image_urls`, restores the composer text plus mention bindings with `bottom_pane.set_composer_text_with_mention_bindings(...)`, appends a warning history event from `image_inputs_not_supported_message()`, and requests redraw.

**Call relations**: Called only from the main submission routine when image support validation fails. It intentionally keeps the draft editable instead of dropping or partially restoring it.

*Call graph*: called by 1 (submit_user_message_with_history_and_shell_escape_policy); 1 external calls (new_warning_event).


### `tui/src/chatwidget/input_flow.rs`

`orchestration` · `request handling`

This module is the bridge between low-level composer results and the rest of the chat turn lifecycle. `handle_composer_input_result` interprets `InputResult` variants from the bottom pane: submitted text becomes a `UserMessage`, slash commands are dispatched, queued actions preserve extra queue metadata, and empty submissions are dropped if they contain no text or images. The method also decides whether a submitted message should go out immediately or be queued, based on session configuration, plan-streaming mode, and a special case where only user shell commands are currently running; in that case non-`!` text is deferred instead of interleaving with shell activity.

Queueing is represented in `self.input_queue` as `QueuedUserMessage` plus a parallel history-record deque. `queue_user_message_with_options` either appends to those deques and refreshes the pending-input preview, or bypasses the queue and submits immediately when the session is configured and idle. `maybe_send_next_queued_input` is the queue drain loop: unless autosend is suppressed or a turn is already pending/running, it repeatedly pops the next queued item and dispatches exactly one actionable follow-up, respecting `QueuedInputAction::Plain`, `ParseSlash`, and `RunShell`. It stops as soon as a new turn starts or a delegated parser/shell path requests a stop. The file also exposes small state predicates and a mode-aware submission helper that prevents collaboration-mode changes mid-turn and injects configured plan-mode reasoning effort.

#### Function details

##### `ChatWidget::handle_composer_input_result`  (lines 10–70)

```
fn handle_composer_input_result(
        &mut self,
        input_result: InputResult,
        had_modal_or_popup: bool,
    )
```

**Purpose**: Consumes the bottom pane's `InputResult` and performs the corresponding chat-widget action: submit, queue, dispatch a command, or do nothing. It also opportunistically drains queued input after modal/popup dismissal and refreshes plan-mode nudges.

**Data flow**: Takes `input_result` and `had_modal_or_popup`. For `Submitted`, it builds a `UserMessage`, drops it if text and both image lists are empty, computes whether immediate submission is allowed, and either submits now, queues it, or queues it specially when only user shell commands are running and the text is not a shell escape. For `Queued`, it builds a `UserMessage` and enqueues it with the provided `QueuedInputAction` and `pending_pastes`. For command variants it dispatches to slash/service-tier handlers. After the match, if a modal/popup had been active and none remains, it may autosend the next queued input; finally it refreshes the plan-mode nudge state.

**Call relations**: This is the main consumer of composer output from key handling. It delegates queue insertion to `queue_user_message` or `queue_user_message_with_options`, checks `only_user_shell_commands_running` for the shell-only deferral rule, and invokes `maybe_send_next_queued_input` after UI overlays close.

*Call graph*: calls 4 internal fn (maybe_send_next_queued_input, only_user_shell_commands_running, queue_user_message, queue_user_message_with_options); 1 external calls (from).


##### `ChatWidget::queue_user_message`  (lines 72–74)

```
fn queue_user_message(&mut self, user_message: UserMessage)
```

**Purpose**: Queues a plain user message using default queue semantics. It is a convenience wrapper for the more general queueing API.

**Data flow**: Accepts a `UserMessage`, constructs the default action `QueuedInputAction::Plain` and an empty `Vec` of pending pastes, and forwards all of that to `queue_user_message_with_options`. It returns no value.

**Call relations**: Used by immediate input handling and mode-based submission when the widget decides a message should wait rather than submit now. It exists to keep common plain-message queueing concise.

*Call graph*: calls 1 internal fn (queue_user_message_with_options); called by 2 (handle_composer_input_result, submit_user_message_with_mode); 1 external calls (new).


##### `ChatWidget::set_queue_submissions_until_session_configured`  (lines 76–79)

```
fn set_queue_submissions_until_session_configured(&mut self, queue: bool)
```

**Purpose**: Controls whether the bottom pane should visually indicate that submissions are being queued until session setup completes. The flag is masked off once the session is already configured.

**Data flow**: Takes `queue: bool`, combines it with `!self.is_session_configured()`, and writes the result into `self.bottom_pane.set_queue_submissions(...)`. It does not touch the actual queue contents.

**Call relations**: This is a UI-state setter used around session setup phases so the composer can reflect whether user submissions will be deferred.


##### `ChatWidget::queue_user_message_with_options`  (lines 81–102)

```
fn queue_user_message_with_options(
        &mut self,
        user_message: UserMessage,
        action: QueuedInputAction,
        pending_pastes: Vec<(String, String)>,
    )
```

**Purpose**: Either appends a message to the pending-input queue with its action/history metadata or submits it immediately if the widget is ready and idle. It is the central queue insertion point.

**Data flow**: Consumes a `UserMessage`, a `QueuedInputAction`, and `pending_pastes`. It checks `!self.is_session_configured() || self.is_user_turn_pending_or_running()`. If true, it pushes a `QueuedUserMessage { user_message, action, pending_pastes }` onto `input_queue.queued_user_messages`, pushes `UserMessageHistoryRecord::UserMessageText` onto the parallel history deque, and refreshes the pending-input preview. Otherwise it bypasses the queue and calls `submit_user_message(user_message)`.

**Call relations**: Called by both `handle_composer_input_result` and the plain wrapper `queue_user_message`. It relies on `is_user_turn_pending_or_running` to preserve the invariant that queued messages are only stored while the widget cannot start a new turn.

*Call graph*: calls 2 internal fn (is_user_turn_pending_or_running, refresh_pending_input_preview); called by 2 (handle_composer_input_result, queue_user_message).


##### `ChatWidget::maybe_send_next_queued_input`  (lines 105–144)

```
fn maybe_send_next_queued_input(&mut self) -> bool
```

**Purpose**: If autosend is allowed and no turn is active, drains queued follow-up inputs until one actually starts work or the queue is exhausted. It submits at most one actionable follow-up turn per invocation.

**Data flow**: Reads `self.input_queue.suppress_queue_autosend` and `self.is_user_turn_pending_or_running()` to decide whether to return `false` immediately. Otherwise it loops while no turn is pending/running, popping the next queued message/history pair. `QueuedInputAction::Plain` submits via `submit_user_message_with_history_record` and breaks. `ParseSlash` delegates to `submit_queued_slash_prompt`; `RunShell` delegates to `submit_queued_shell_prompt`; either delegated path may return `QueueDrain::Stop`, in which case the method records whether a turn is now pending/running and breaks. After the loop it refreshes the pending-input preview and returns whether a follow-up was submitted.

**Call relations**: Triggered after composer interactions when a modal/popup closes. It depends on `pop_next_queued_user_message` from the restore module and uses `is_user_turn_pending_or_running` both as a precondition and as the loop stop condition.

*Call graph*: calls 2 internal fn (is_user_turn_pending_or_running, refresh_pending_input_preview); called by 1 (handle_composer_input_result).


##### `ChatWidget::is_user_turn_pending_or_running`  (lines 146–148)

```
fn is_user_turn_pending_or_running(&self) -> bool
```

**Purpose**: Reports whether the widget is between submission and `TurnStarted` or already executing a task. This is the queueing gate used throughout input flow.

**Data flow**: Reads `self.input_queue.user_turn_pending_start` and `self.bottom_pane.is_task_running()`, ORs them, and returns the resulting boolean.

**Call relations**: Used by queue insertion and queue draining to avoid starting a new user turn while one is already pending or active.

*Call graph*: called by 2 (maybe_send_next_queued_input, queue_user_message_with_options).


##### `ChatWidget::only_user_shell_commands_running`  (lines 150–157)

```
fn only_user_shell_commands_running(&self) -> bool
```

**Purpose**: Detects the special state where an agent turn is active solely because user-triggered shell commands are still running. In that state, normal text submissions are queued instead of being mixed into the running shell activity.

**Data flow**: Reads `self.turn_lifecycle.agent_turn_running`, `self.running_commands`, and each command's `source`. It returns true only when an agent turn is running, the running-command map is non-empty, and every command has `source == ExecCommandSource::UserShell`.

**Call relations**: Consulted by `handle_composer_input_result` during immediate-submission decisions. It provides the narrow exception that queues non-`!` text even when the session is otherwise configured.

*Call graph*: called by 1 (handle_composer_input_result).


##### `ChatWidget::refresh_pending_input_preview`  (lines 160–167)

```
fn refresh_pending_input_preview(&mut self)
```

**Purpose**: Recomputes the bottom-pane preview of queued messages, pending steers, and rejected steers from the queue state. It is the UI synchronization point after any queue mutation.

**Data flow**: Calls `self.input_queue.preview()` to obtain a `PendingInputPreview`, then writes its `queued_messages`, `pending_steers`, and `rejected_steers` vectors into `self.bottom_pane.set_pending_input_preview(...)`.

**Call relations**: Invoked after queue insertions and queue draining so the composer-adjacent preview always reflects the current queue contents.

*Call graph*: called by 2 (maybe_send_next_queued_input, queue_user_message_with_options).


##### `ChatWidget::submit_user_message_with_mode`  (lines 169–201)

```
fn submit_user_message_with_mode(
        &mut self,
        text: String,
        mut collaboration_mode: CollaborationModeMask,
    )
```

**Purpose**: Submits or queues a plain text user message while first applying a requested collaboration mode change. It also injects configured plan-mode reasoning effort and blocks mode switches during an active turn.

**Data flow**: Takes `text` and mutable `collaboration_mode`. If the requested mode is `ModeKind::Plan` and config provides `plan_mode_reasoning_effort`, it writes that into the mask. If an agent turn is running and the requested mask differs from `self.active_collaboration_mask`, it emits an error and returns. Otherwise it updates the active collaboration mask, computes whether plan streaming requires queueing, constructs a `UserMessage` with the given text and empty image/text-element/mention fields, and either queues or submits it.

**Call relations**: This helper is used by callers that want a mode change and a message submission to be treated as one user action. It delegates actual queueing through `queue_user_message` when plan streaming is active.

*Call graph*: calls 1 internal fn (queue_user_message); 1 external calls (new).


##### `ChatWidget::queued_user_message_texts`  (lines 204–216)

```
fn queued_user_message_texts(&self) -> Vec<String>
```

**Purpose**: Test-only accessor that exposes the visible text of rejected steers followed by queued user messages. It supports assertions about queue contents without inspecting internal deques directly.

**Data flow**: Iterates over `self.input_queue.rejected_steers_queue` and `self.input_queue.queued_user_messages`, clones each message text, chains the two iterators, and collects them into `Vec<String>`.

**Call relations**: Compiled only in tests. It gives test code a stable summary of queue ordering across the two queue categories.


### `tui/src/chatwidget/interaction.rs`

`orchestration` · `main loop`

This file is the chat widget’s interactive front door. `handle_key_event` first gives active bottom-pane views priority, except for a small set of app-level shortcuts such as Ctrl+C, Ctrl+R, and Ctrl+U. It then handles reasoning shortcuts, copy-last-response, Ctrl+C/Ctrl+D quit-or-interrupt behavior, Ctrl/Alt+V image paste, queued-message editing, steer-specific interrupt rules during review, pending-steer interrupt submission, plan-mode nudge dismissal, plugin popup routing, collaboration-mode cycling on BackTab, and finally ordinary composer key handling. After delegated bottom-pane handling it feeds the resulting `InputResult` into the input-flow module.

The rest of the file exposes focused UI helpers. Image attachment checks model capabilities before mutating the composer. External-editor state, footer hints, selection views, paste handling, and paste-burst ticking are thin wrappers around bottom-pane behavior plus redraw/nudge refresh. Copy support reads `transcript.last_agent_markdown`, uses an injectable clipboard backend for tests, stores any returned clipboard lease, and emits precise info/error history events, including a special rollback-eviction message.

Quit behavior is a small state machine in `ChatWidget`: `on_ctrl_c` and `on_ctrl_d` interpret double-press quit semantics using `quit_shortcut_key` and `quit_shortcut_expires_at`, while still interrupting cancellable work when appropriate. `pause_active_goal_for_interrupt` sends a `SetThreadGoalStatus::Paused` app event only when an agent turn is running, the current goal is active, and a thread id exists. Rename prompting is similarly guarded by `thread_rename_block_message` and uses a `CustomPromptView` callback that normalizes names and reports empty-name errors through history.

#### Function details

##### `ChatWidget::handle_key_event`  (lines 6–172)

```
fn handle_key_event(&mut self, key_event: KeyEvent)
```

**Purpose**: Central keyboard dispatcher for the chat widget. It decides whether a key goes to an active bottom-pane view, triggers an app-level shortcut, edits queued input, interrupts work, changes collaboration mode, or becomes ordinary composer input.

**Data flow**: Consumes a `KeyEvent` and reads extensive widget state: active views, modal/popup presence, review mode, pending steers, task-running state, plan-mode nudge visibility, and keymap bindings. Depending on the branch it may delegate directly to `bottom_pane.handle_key_event`, clear quit-shortcut state, invoke reasoning/copy/interrupt handlers, paste an image from the clipboard and attach it, restore the latest queued composer state, set `submit_pending_steers_after_interrupt` and submit an interrupt op, dismiss the plan-mode nudge, route plugin-popup keys, cycle collaboration mode, or pass the event to the bottom pane and then process the resulting `InputResult` via `handle_composer_input_result`.

**Call relations**: This is the top-level key-routing entrypoint for the widget. It delegates to many specialized helpers in this file and to input-flow methods once a key has been interpreted as composer output.

*Call graph*: calls 5 internal fn (attach_image, copy_last_agent_markdown, on_ctrl_c, on_ctrl_d, ctrl); 7 external calls (Char, interrupt, format!, new_error_event, matches!, debug!, warn!).


##### `ChatWidget::attach_image`  (lines 178–189)

```
fn attach_image(&mut self, path: PathBuf)
```

**Purpose**: Adds a local image attachment to the composer only when the active model supports image inputs. Otherwise it leaves the draft untouched and warns the user.

**Data flow**: Takes `path: PathBuf`, checks `current_model_supports_images()`, and either appends a warning history event plus redraw or logs the path, calls `bottom_pane.attach_image(path)`, and requests redraw.

**Call relations**: Called from keyboard handling after a successful clipboard-image paste, and potentially from other UI paths that attach local images.

*Call graph*: called by 1 (handle_key_event); 2 external calls (new_warning_event, info!).


##### `ChatWidget::composer_text_with_pending`  (lines 191–193)

```
fn composer_text_with_pending(&self) -> String
```

**Purpose**: Returns the composer text including any pending paste-burst content not yet flushed into the visible draft.

**Data flow**: Reads and returns `self.bottom_pane.composer_text_with_pending()` unchanged.

**Call relations**: Used by external editor or state-inspection code that needs the effective current composer text.


##### `ChatWidget::apply_external_edit`  (lines 195–199)

```
fn apply_external_edit(&mut self, text: String)
```

**Purpose**: Applies text produced by an external editor back into the composer and refreshes related UI hints.

**Data flow**: Takes `text`, passes it to `bottom_pane.apply_external_edit(text)`, refreshes the plan-mode nudge, and requests redraw.

**Call relations**: Used when an external editing workflow returns modified text to the chat widget.


##### `ChatWidget::external_editor_state`  (lines 201–203)

```
fn external_editor_state(&self) -> ExternalEditorState
```

**Purpose**: Exposes the widget’s current external-editor state flag.

**Data flow**: Reads and returns `self.external_editor_state` by value.

**Call relations**: Used by surrounding orchestration to inspect whether an external editor session is active or pending.


##### `ChatWidget::set_external_editor_state`  (lines 205–207)

```
fn set_external_editor_state(&mut self, state: ExternalEditorState)
```

**Purpose**: Updates the widget’s external-editor state flag.

**Data flow**: Writes the provided `state` into `self.external_editor_state`.

**Call relations**: Called by external-editor orchestration code to keep the widget’s state machine in sync.


##### `ChatWidget::set_footer_hint_override`  (lines 209–211)

```
fn set_footer_hint_override(&mut self, items: Option<Vec<(String, String)>>)
```

**Purpose**: Overrides the bottom-pane footer hints with caller-provided items or clears the override.

**Data flow**: Passes `items: Option<Vec<(String, String)>>` directly to `self.bottom_pane.set_footer_hint_override(items)`.

**Call relations**: Used by higher-level flows that need temporary footer guidance independent of the normal keymap hints.


##### `ChatWidget::show_selection_view`  (lines 213–217)

```
fn show_selection_view(&mut self, params: SelectionViewParams)
```

**Purpose**: Displays a selection-style view in the bottom pane and refreshes plan-mode hinting around that UI change.

**Data flow**: Takes `SelectionViewParams`, forwards them to `bottom_pane.show_selection_view(params)`, refreshes the plan-mode nudge, and requests redraw.

**Call relations**: Used by picker-like flows, including keymap and other selection UIs, to present a modal selection surface.


##### `ChatWidget::no_modal_or_popup_active`  (lines 219–221)

```
fn no_modal_or_popup_active(&self) -> bool
```

**Purpose**: Reports whether the bottom pane currently has no modal or popup UI active.

**Data flow**: Returns `self.bottom_pane.no_modal_or_popup_active()`.

**Call relations**: This is a convenience predicate used by callers that need to know whether app-level shortcuts or autosend behavior should proceed.


##### `ChatWidget::can_launch_external_editor`  (lines 223–225)

```
fn can_launch_external_editor(&self) -> bool
```

**Purpose**: Checks whether the bottom pane is currently in a state that allows launching the external editor.

**Data flow**: Returns `self.bottom_pane.can_launch_external_editor()`.

**Call relations**: Consulted by external-editor launch code before attempting to open an editor.


##### `ChatWidget::can_run_ctrl_l_clear_now`  (lines 227–238)

```
fn can_run_ctrl_l_clear_now(&mut self) -> bool
```

**Purpose**: Implements the current rule for Ctrl+L clearing: it is blocked while a task is running and otherwise allowed.

**Data flow**: Reads `self.bottom_pane.is_task_running()`. If false, returns `true`. If true, it appends an error history event saying Ctrl+L is disabled during a task, requests redraw, and returns `false`.

**Call relations**: Used by the Ctrl+L clear path outside this file to enforce the same runtime restriction as `/clear`.

*Call graph*: 1 external calls (new_error_event).


##### `ChatWidget::copy_last_agent_markdown`  (lines 241–243)

```
fn copy_last_agent_markdown(&mut self)
```

**Purpose**: Copies the last agent response to the clipboard using the production clipboard backend.

**Data flow**: Calls `copy_last_agent_markdown_with(crate::clipboard_copy::copy_to_clipboard)` and returns no value.

**Call relations**: Triggered by the configured copy shortcut in `handle_key_event`; the injectable inner helper contains the actual logic.

*Call graph*: calls 1 internal fn (copy_last_agent_markdown_with); called by 1 (handle_key_event).


##### `ChatWidget::truncate_agent_copy_history_to_user_turn_count`  (lines 245–251)

```
fn truncate_agent_copy_history_to_user_turn_count(
        &mut self,
        user_turn_count: usize,
    )
```

**Purpose**: Trims stored copyable agent-response history to match a reduced number of user turns, such as after rollback.

**Data flow**: Passes `user_turn_count` to `self.transcript.truncate_copy_history_to_user_turn_count(user_turn_count)`.

**Call relations**: Used by transcript/rollback flows to keep copy history aligned with visible conversation history.


##### `ChatWidget::copy_last_agent_markdown_with`  (lines 254–281)

```
fn copy_last_agent_markdown_with(
        &mut self,
        copy_fn: impl FnOnce(&str) -> Result<Option<crate::clipboard_copy::ClipboardLease>, String>,
    )
```

**Purpose**: Copies the last agent markdown using an injected clipboard function and reports success or failure through history events.

**Data flow**: Reads `self.transcript.last_agent_markdown.clone()` and `copy_history_evicted_by_rollback`. If non-empty markdown exists, it calls `copy_fn(&markdown)`: on success it stores the returned clipboard lease in `self.clipboard_lease` and appends an info event; on error it appends an error event. If no markdown exists but copy history was evicted by rollback, it appends a specific error mentioning `MAX_AGENT_COPY_HISTORY`; otherwise it appends a generic “No agent response to copy” error. It always requests redraw.

**Call relations**: Called by the public copy method and designed for testability by allowing a fake clipboard backend.

*Call graph*: called by 1 (copy_last_agent_markdown); 3 external calls (format!, new_error_event, new_info_event).


##### `ChatWidget::last_agent_markdown_text`  (lines 284–286)

```
fn last_agent_markdown_text(&self) -> Option<&str>
```

**Purpose**: Test-only accessor for the currently stored last-agent markdown text.

**Data flow**: Returns `self.transcript.last_agent_markdown.as_deref()`, yielding `Option<&str>`.

**Call relations**: Used in tests to assert copy-related transcript state without exposing mutable internals.


##### `ChatWidget::show_rename_prompt`  (lines 288–316)

```
fn show_rename_prompt(&mut self)
```

**Purpose**: Opens a prompt view that lets the user name or rename the current thread, with validation and persistence routed through app events.

**Data flow**: First checks `ensure_thread_rename_allowed()`. If allowed, it clones `app_event_tx`, derives the existing non-empty thread name, chooses the title `Rename thread` or `Name thread`, constructs a `CustomPromptView` with initial text and a callback that normalizes the entered name, emits an error history cell if normalization returns `None`, or calls `tx.set_thread_name(name)` otherwise, and shows that view in the bottom pane.

**Call relations**: Invoked by rename UI actions. It depends on `ensure_thread_rename_allowed` for policy gating and uses a callback so the actual rename flows back through the app-event channel.

*Call graph*: calls 2 internal fn (new, ensure_thread_rename_allowed); 1 external calls (new).


##### `ChatWidget::ensure_thread_rename_allowed`  (lines 318–326)

```
fn ensure_thread_rename_allowed(&mut self) -> bool
```

**Purpose**: Checks whether thread renaming is currently blocked and surfaces the blocking reason if so.

**Data flow**: Reads `self.thread_rename_block_message.clone()`. If `Some(message)`, it emits that as an error message and returns `false`; otherwise it returns `true`.

**Call relations**: Used by `show_rename_prompt` as a guard before opening the rename UI.

*Call graph*: called by 1 (show_rename_prompt).


##### `ChatWidget::handle_paste`  (lines 328–331)

```
fn handle_paste(&mut self, text: String)
```

**Purpose**: Passes pasted text into the bottom pane and refreshes plan-mode hinting.

**Data flow**: Takes `text`, forwards it to `bottom_pane.handle_paste(text)`, and refreshes the plan-mode nudge.

**Call relations**: Used by paste event handling outside this file; paste-burst timing is handled separately by `handle_paste_burst_tick`.


##### `ChatWidget::handle_paste_burst_tick`  (lines 334–350)

```
fn handle_paste_burst_tick(&mut self, frame_requester: FrameRequester) -> bool
```

**Purpose**: Advances paste-burst batching and decides whether the current frame should be skipped because another redraw is imminent.

**Data flow**: Takes a `FrameRequester`. If `bottom_pane.flush_paste_burst_if_due()` returns true, it refreshes the plan-mode nudge, requests redraw, and returns `true`. Else if `bottom_pane.is_in_paste_burst()` is true, it schedules a future frame using `ChatComposer::recommended_paste_flush_delay()` and returns `true`. Otherwise it returns `false`.

**Call relations**: Called from the render loop or frame scheduler to coalesce rapid paste events without redundant intermediate renders.

*Call graph*: calls 2 internal fn (recommended_paste_flush_delay, schedule_frame_in).


##### `ChatWidget::on_ctrl_c`  (lines 360–402)

```
fn on_ctrl_c(&mut self)
```

**Purpose**: Implements Ctrl+C semantics at the chat-widget layer: dismiss active views when they handle it, arm or consume the double-press quit shortcut, and interrupt cancellable work when appropriate.

**Data flow**: Builds the Ctrl+C `KeyBinding`, checks whether a modal/popup is active, and first delegates to `bottom_pane.on_ctrl_c()`. If that reports handled, it may arm or clear the quit shortcut depending on double-press settings and modal state, then returns. Without double-press support, it either interrupts cancellable work—clearing quit state, pausing any active goal, and submitting `AppCommand::interrupt_and_restore_prompt_if_no_output()`—or requests quit immediately. With double-press enabled, it quits immediately if the shortcut is already active for Ctrl+C; otherwise it arms the shortcut and, if cancellable work is active, pauses the goal and submits the interrupt op.

**Call relations**: Called from `handle_key_event` on Ctrl+C presses. It relies on `quit_shortcut_active_for`, `arm_quit_shortcut`, `is_cancellable_work_active`, and `pause_active_goal_for_interrupt` to implement the state machine.

*Call graph*: calls 5 internal fn (arm_quit_shortcut, is_cancellable_work_active, pause_active_goal_for_interrupt, quit_shortcut_active_for, ctrl); called by 1 (handle_key_event); 2 external calls (Char, interrupt_and_restore_prompt_if_no_output).


##### `ChatWidget::on_ctrl_d`  (lines 408–433)

```
fn on_ctrl_d(&mut self) -> bool
```

**Purpose**: Implements Ctrl+D quit behavior, but only when the composer is empty and no modal/popup is active. It participates in the same optional double-press quit shortcut as Ctrl+C.

**Data flow**: Builds the Ctrl+D `KeyBinding`. Without double-press support, it returns `false` if the composer is non-empty or a modal/popup is active; otherwise it requests quit and returns `true`. With double-press enabled, it quits and returns `true` if the shortcut is already active for Ctrl+D; if the composer is non-empty or a modal/popup is active it returns `false`; otherwise it arms the shortcut and returns `true`.

**Call relations**: Called from `handle_key_event` on Ctrl+D presses. Its boolean return tells the caller whether the key was fully handled at the chat-widget layer.

*Call graph*: calls 3 internal fn (arm_quit_shortcut, quit_shortcut_active_for, ctrl); called by 1 (handle_key_event); 1 external calls (Char).


##### `ChatWidget::quit_shortcut_active_for`  (lines 436–441)

```
fn quit_shortcut_active_for(&self, key: KeyBinding) -> bool
```

**Purpose**: Checks whether a given key matches the currently armed quit shortcut and whether the timeout window is still open.

**Data flow**: Reads `self.quit_shortcut_key` and `self.quit_shortcut_expires_at`, compares the key for equality, checks `Instant::now() < expires_at` when an expiry exists, and returns the combined boolean.

**Call relations**: Used by both `on_ctrl_c` and `on_ctrl_d` to detect the second press that should trigger immediate quit.

*Call graph*: called by 2 (on_ctrl_c, on_ctrl_d).


##### `ChatWidget::arm_quit_shortcut`  (lines 448–454)

```
fn arm_quit_shortcut(&mut self, key: KeyBinding)
```

**Purpose**: Arms the double-press quit shortcut for a specific key and shows the corresponding footer hint.

**Data flow**: Computes `quit_shortcut_expires_at` as `Instant::now().checked_add(QUIT_SHORTCUT_TIMEOUT)` with a fallback to `Some(Instant::now())`, stores the provided `key` in `quit_shortcut_key`, and calls `bottom_pane.show_quit_shortcut_hint(key)`.

**Call relations**: Called by `on_ctrl_c` and `on_ctrl_d` when the first press should prepare a time-bounded second-press quit.

*Call graph*: called by 2 (on_ctrl_c, on_ctrl_d); 1 external calls (now).


##### `ChatWidget::is_cancellable_work_active`  (lines 457–459)

```
fn is_cancellable_work_active(&self) -> bool
```

**Purpose**: Reports whether Ctrl+C should interrupt work instead of acting purely as a quit shortcut. Review mode counts as cancellable work even without a running task.

**Data flow**: Reads `self.bottom_pane.is_task_running()` and `self.review.is_review_mode`, ORs them, and returns the result.

**Call relations**: Consulted by `on_ctrl_c` to decide whether an interrupt op should be submitted.

*Call graph*: called by 1 (on_ctrl_c).


##### `ChatWidget::pause_active_goal_for_interrupt`  (lines 461–479)

```
fn pause_active_goal_for_interrupt(&self)
```

**Purpose**: Marks the current thread goal as paused before interrupting an active agent turn, but only when a goal is actually active and a thread id is known.

**Data flow**: Reads `self.turn_lifecycle.agent_turn_running`, `self.current_goal_status`, and `self.thread_id`. If any prerequisite fails it returns early. Otherwise it sends `AppEvent::SetThreadGoalStatus { thread_id, status: AppThreadGoalStatus::Paused }` through `app_event_tx`.

**Call relations**: Called from `on_ctrl_c` immediately before submitting an interrupt op so goal state stays consistent with the impending interruption.

*Call graph*: called by 1 (on_ctrl_c).


### Command and context features
Routes slash commands and supports the contextual command features that enrich or specialize chat input.

### `tui/src/chatwidget/skills.rs`

`domain_logic` · `skills popup interaction, skills refresh, and mention parsing during input handling`

This file has two distinct responsibilities. On the UI side, it opens the skills list/menu, builds the manage-skills popup, tracks the initial enabled/disabled state while that popup is open, applies toggles back into `skills_all`, and emits a summary info message when the popup closes with changes. It also loads skill metadata from `SkillsListResponse` by selecting the entry matching the current cwd and converting enabled protocol skills into core `SkillMetadata` for mention completion.

On the parsing side, it provides the mention-resolution utilities used to interpret `$name`/`@name`-style tool mentions and linked markdown mentions like `[$foo](skill://...)` or `[$bar](app://...)`. The parser scans raw bytes, recognizes mention-name characters (`[A-Za-z0-9_-]`), ignores common environment-variable names such as `PATH` and `HOME`, and records both plain names and linked paths. Skill matching prefers exact normalized skill-path matches first, then falls back to unique skill-name matches while deduplicating by both path and name. App matching similarly honors explicit `app://` bindings first, then unique connector slugs for accessible and enabled apps, while avoiding collisions with skill names.

The file also includes tests that verify inaccessible or disabled apps are excluded from app-mention resolution for both slug-only and bound-path cases.

#### Function details

##### `ChatWidget::open_skills_list`  (lines 27–33)

```
fn open_skills_list(&mut self)
```

**Purpose**: Inserts the mention trigger character into the composer to open the skills list directly. The trigger is `@` when MentionsV2 is enabled and `$` otherwise.

**Data flow**: It reads the MentionsV2 feature flag from config, chooses either `"@"` or `"$"`, and passes that string to `self.insert_str(...)`. It returns nothing.

**Call relations**: This is the direct-entry action for opening skill mentions from the UI. It does not build a popup itself; it relies on the composer’s mention behavior after inserting the trigger.


##### `ChatWidget::open_skills_menu`  (lines 35–71)

```
fn open_skills_menu(&mut self)
```

**Purpose**: Builds and shows a small popup with two skills actions: open the list directly or open the enable/disable management popup. The description text includes the current direct-open shortcut.

**Data flow**: It reads the MentionsV2 feature flag to choose the shortcut character, constructs two `SelectionItem`s whose actions send `AppEvent::OpenSkillsList` or `AppEvent::OpenManageSkillsPopup`, wraps them in `SelectionViewParams` with title/subtitle/footer hint, and shows the selection view in the bottom pane. It returns nothing.

**Call relations**: This method is the higher-level skills menu entrypoint. It delegates footer-hint generation to `standard_popup_hint_line` and popup rendering to the bottom pane.

*Call graph*: calls 1 internal fn (standard_popup_hint_line); 2 external calls (default, vec!).


##### `ChatWidget::open_manage_skills_popup`  (lines 73–110)

```
fn open_manage_skills_popup(&mut self)
```

**Purpose**: Opens the interactive enable/disable skills view for the currently loaded skills. It snapshots the initial enabled state so changes can be summarized when the popup closes.

**Data flow**: It first checks `self.skills_all`; if empty it adds an info message and returns. Otherwise it builds a `HashMap<AbsolutePathBuf, bool>` of initial enabled states into `self.skills_initial_state`, converts each protocol skill to core metadata with `protocol_skill_to_core`, maps those into `SkillsToggleItem`s, constructs a `SkillsToggleView` with the items, app-event sender, and list keymap, and shows that view in the bottom pane. It returns nothing.

**Call relations**: This popup builder is triggered from the skills menu. It depends on `protocol_skill_to_core` for metadata conversion and delegates the interactive UI to `SkillsToggleView::new`.

*Call graph*: calls 1 internal fn (new); 2 external calls (new, new).


##### `ChatWidget::update_skill_enabled`  (lines 112–119)

```
fn update_skill_enabled(&mut self, path: AbsolutePathBuf, enabled: bool)
```

**Purpose**: Updates the enabled flag for a single skill identified by path and refreshes the bottom pane’s mentionable skills list to include only enabled skills. It mutates the in-memory `skills_all` cache in place.

**Data flow**: It takes a skill `path` and `enabled` boolean, iterates `self.skills_all` mutably to update matching entries, computes the enabled core skills via `enabled_skills_for_mentions(&self.skills_all)`, and forwards them through `self.set_skills(Some(...))`. It returns nothing.

**Call relations**: This method is used by the manage-skills UI when toggles change. It delegates enabled-skill extraction to `enabled_skills_for_mentions` and then updates the bottom pane through `ChatWidget::set_skills`.

*Call graph*: calls 1 internal fn (enabled_skills_for_mentions).


##### `ChatWidget::handle_manage_skills_closed`  (lines 121–152)

```
fn handle_manage_skills_closed(&mut self)
```

**Purpose**: Compares the current skill enabled-state map against the snapshot taken when the manage-skills popup opened and emits a summary info message if any skills changed. No message is shown when nothing changed or no snapshot exists.

**Data flow**: It takes no arguments, removes `self.skills_initial_state`, builds a current-state map from `self.skills_all`, counts transitions from disabled→enabled and enabled→disabled for paths present in both maps, and if either count is nonzero adds an info message like `"X skills enabled, Y skills disabled"`. It returns nothing.

**Call relations**: This close-handler complements `ChatWidget::open_manage_skills_popup`, which stored the initial state. It performs all comparison locally and only emits a summary message when there were actual changes.

*Call graph*: 2 external calls (new, format!).


##### `ChatWidget::set_skills_from_response`  (lines 154–158)

```
fn set_skills_from_response(&mut self, response: &SkillsListResponse)
```

**Purpose**: Loads the current cwd’s skills from a `SkillsListResponse`, caches the full protocol metadata list, and refreshes the mentionable enabled-skill list. It is the app-server response ingestion point for skills.

**Data flow**: It takes a `&SkillsListResponse`, selects the matching cwd entry via `skills_for_cwd(&self.config.cwd, &response.data)`, stores that vector in `self.skills_all`, computes enabled core skills with `enabled_skills_for_mentions`, and forwards them through `self.set_skills(Some(...))`. It returns nothing.

**Call relations**: This method is called when fresh skills metadata arrives from the server. It delegates cwd filtering to `skills_for_cwd` and enabled-skill extraction to `enabled_skills_for_mentions`.

*Call graph*: calls 2 internal fn (enabled_skills_for_mentions, skills_for_cwd).


##### `ChatWidget::annotate_skill_reads_in_parsed_cmd`  (lines 160–187)

```
fn annotate_skill_reads_in_parsed_cmd(
        &self,
        mut parsed_cmd: Vec<ParsedCommand>,
    ) -> Vec<ParsedCommand>
```

**Purpose**: Best-effort annotates parsed `Read` commands that target `SKILL.md` with the corresponding skill name, making command displays more informative. Only exact path matches against the loaded skills list are annotated.

**Data flow**: It takes ownership of `Vec<ParsedCommand>`, returns early unchanged if `skills_all` is empty, otherwise iterates mutably through commands, finds `ParsedCommand::Read { name, path, .. }` entries whose `name` is exactly `"SKILL.md"`, looks for a loaded skill whose path matches `path`, and rewrites the command name to `"SKILL.md (<skill name> skill)"`. It returns the modified vector.

**Call relations**: This helper is used when displaying parsed command activity so skill reads are easier to interpret. It does not delegate beyond string formatting and local skill lookup.

*Call graph*: 1 external calls (format!).


##### `skills_for_cwd`  (lines 190–199)

```
fn skills_for_cwd(
    cwd: &AbsolutePathBuf,
    skills_entries: &[SkillsListEntry],
) -> Vec<ProtocolSkillMetadata>
```

**Purpose**: Selects the protocol skill list entry whose cwd matches the provided cwd and returns its skills vector. If no entry matches, it returns an empty vector.

**Data flow**: It takes a `cwd` and a slice of `SkillsListEntry`, searches for the first entry whose `entry.cwd` path equals `cwd`, clones that entry’s `skills` vector when found, and otherwise returns `Vec::new()`. It mutates no external state.

**Call relations**: This helper is called by `ChatWidget::set_skills_from_response` to extract only the skills relevant to the widget’s current working directory.

*Call graph*: called by 1 (set_skills_from_response); 1 external calls (iter).


##### `enabled_skills_for_mentions`  (lines 201–207)

```
fn enabled_skills_for_mentions(skills: &[ProtocolSkillMetadata]) -> Vec<SkillMetadata>
```

**Purpose**: Filters a protocol skill list down to enabled skills and converts each one into core `SkillMetadata` suitable for mention completion. Invalid protocol entries are skipped.

**Data flow**: It takes a slice of `ProtocolSkillMetadata`, filters to `skill.enabled == true`, runs each through `protocol_skill_to_core`, drops `None` results, and returns the collected `Vec<SkillMetadata>`. It mutates no state.

**Call relations**: This helper is used by both `ChatWidget::set_skills_from_response` and `ChatWidget::update_skill_enabled` to derive the bottom pane’s mentionable skills.

*Call graph*: called by 2 (set_skills_from_response, update_skill_enabled); 1 external calls (iter).


##### `protocol_skill_to_core`  (lines 209–255)

```
fn protocol_skill_to_core(skill: &ProtocolSkillMetadata) -> Option<SkillMetadata>
```

**Purpose**: Converts app-server `ProtocolSkillMetadata` into core `SkillMetadata`, including nested interface and tool-dependency structures. Scope conversion is performed through JSON round-tripping and failures are logged and dropped.

**Data flow**: It takes a protocol skill reference, serializes `skill.scope` with `serde_json::to_value`, deserializes it into the core scope type, logs a warning and returns `None` on conversion failure, and otherwise constructs a new `SkillMetadata` by cloning/copying the protocol fields into core equivalents, including mapped `SkillInterface`, `SkillDependencies`, and `SkillToolDependency` values. It returns `Option<SkillMetadata>`.

**Call relations**: This converter is used by popup-building and mention-preparation helpers whenever protocol skill metadata must be consumed by core/UI code.

*Call graph*: 1 external calls (to_value).


##### `collect_tool_mentions`  (lines 257–268)

```
fn collect_tool_mentions(
    text: &str,
    mention_paths: &HashMap<String, String>,
) -> ToolMentions
```

**Purpose**: Parses tool mentions from raw text and enriches them with explicit linked paths from a provided mention-binding map when the mentioned names match. It produces the combined `ToolMentions` structure used by skill/app resolution.

**Data flow**: It takes input `text` and a `HashMap<String, String>` of `mention_paths`, calls `extract_tool_mentions_from_text(text)` to get initial names and linked paths, then for each binding inserts the path into `mentions.linked_paths` when the mention name is present in `mentions.names`. It returns the enriched `ToolMentions`.

**Call relations**: This helper is used by the tests in this file and by higher-level mention resolution code. It delegates raw parsing to `extract_tool_mentions_from_text`.

*Call graph*: calls 1 internal fn (extract_tool_mentions_from_text); called by 2 (find_app_mentions_requires_accessible_enabled_apps_for_bound_paths, find_app_mentions_requires_accessible_enabled_apps_for_slugs).


##### `find_skill_mentions_with_tool_mentions`  (lines 270–308)

```
fn find_skill_mentions_with_tool_mentions(
    mentions: &ToolMentions,
    skills: &[SkillMetadata],
) -> Vec<SkillMetadata>
```

**Purpose**: Resolves a parsed `ToolMentions` set against available skills, preferring exact linked skill-path matches and then falling back to unique skill-name matches. It deduplicates by both skill path and skill name.

**Data flow**: It takes `mentions` and a slice of core `SkillMetadata`, builds a normalized set of linked skill paths from `mentions.linked_paths`, then performs two passes over `skills`: first selecting exact path matches, then selecting remaining name matches from `mentions.names` while tracking `seen_names` and `seen_paths`. It returns the ordered `Vec<SkillMetadata>` matches.

**Call relations**: This is the skill-resolution half of mention handling. It depends on `is_skill_path` and `normalize_skill_path` semantics encoded earlier in the file and performs all matching locally.

*Call graph*: 2 external calls (new, new).


##### `find_app_mentions`  (lines 310–346)

```
fn find_app_mentions(
    mentions: &ToolMentions,
    apps: &[AppInfo],
    skill_names_lower: &HashSet<String>,
) -> Vec<AppInfo>
```

**Purpose**: Resolves tool mentions to connector `AppInfo` entries, honoring explicit `app://` bindings first and then unique connector slugs for accessible, enabled apps that do not collide with skill names. It filters out inaccessible or disabled apps throughout.

**Data flow**: Inputs are `mentions`, a slice of `AppInfo`, and a set of lowercased skill names. It first scans `mentions.linked_paths`, extracting explicit app ids via `app_id_from_path` into `selected_ids` and recording explicit names. It then counts mention slugs among mentionable apps, performs a second pass to add uniquely matching slug mentions that are not explicit and do not collide with skill names, and finally returns cloned apps whose ids are in `selected_ids` and which satisfy `is_app_mentionable`. It mutates no external state.

**Call relations**: This helper is the app-resolution counterpart to skill matching. It delegates slug generation to `codex_connectors::metadata::connector_mention_slug`, explicit-path parsing to `app_id_from_path`, and accessibility filtering to `is_app_mentionable`.

*Call graph*: calls 2 internal fn (connector_mention_slug, app_id_from_path); 3 external calls (new, new, iter).


##### `is_app_mentionable`  (lines 348–350)

```
fn is_app_mentionable(app: &AppInfo) -> bool
```

**Purpose**: Returns whether an app is eligible for mention resolution. Both accessibility and enabled state must be true.

**Data flow**: It reads `app.is_accessible` and `app.is_enabled`, returns their conjunction, and mutates nothing.

**Call relations**: This predicate is used by `find_app_mentions` to consistently exclude unavailable connectors.


##### `extract_tool_mentions_from_text`  (lines 357–359)

```
fn extract_tool_mentions_from_text(text: &str) -> ToolMentions
```

**Purpose**: Parses tool mentions from text using the default tool-mention sigil configured by `TOOL_MENTION_SIGIL`. It is a thin wrapper around the sigil-parameterized parser.

**Data flow**: It takes `&str text`, calls `extract_tool_mentions_from_text_with_sigil(text, TOOL_MENTION_SIGIL)`, and returns the resulting `ToolMentions`. It mutates no state.

**Call relations**: This wrapper is called by `collect_tool_mentions` so most callers do not need to know the configured sigil.

*Call graph*: calls 1 internal fn (extract_tool_mentions_from_text_with_sigil); called by 1 (collect_tool_mentions).


##### `extract_tool_mentions_from_text_with_sigil`  (lines 361–418)

```
fn extract_tool_mentions_from_text_with_sigil(text: &str, sigil: char) -> ToolMentions
```

**Purpose**: Scans raw text bytes for plain and linked tool mentions using a specified sigil, collecting mention names and linked paths while ignoring common environment-variable names. Linked skill paths also contribute their names to the plain-name set.

**Data flow**: It takes `text` and a `sigil`, iterates byte-by-byte through `text.as_bytes()`, first attempting to parse markdown-style linked mentions with `parse_linked_tool_mention`, then recognizing plain sigil-prefixed names composed of `is_mention_name_char` bytes. It filters out names like `PATH` via `is_common_env_var`, records linked paths, inserts names into a `HashSet`, and returns `ToolMentions { names, linked_paths }`.

**Call relations**: This is the core mention parser used by `extract_tool_mentions_from_text`. It delegates linked-mention parsing to `parse_linked_tool_mention` and uses `is_common_env_var`, `is_mention_name_char`, and `is_skill_path` to enforce parsing rules.

*Call graph*: calls 4 internal fn (is_common_env_var, is_mention_name_char, is_skill_path, parse_linked_tool_mention); called by 1 (extract_tool_mentions_from_text); 2 external calls (new, new).


##### `parse_linked_tool_mention`  (lines 420–475)

```
fn parse_linked_tool_mention(
    text: &'a str,
    text_bytes: &[u8],
    start: usize,
    sigil: char,
) -> Option<(&'a str, &'a str, usize)>
```

**Purpose**: Parses a markdown-style linked tool mention of the form `[@name](path)` or `[$name](path)` starting at a given byte index. It validates sigil, mention-name characters, closing bracket/parenthesis, and non-empty path.

**Data flow**: It takes the original `text`, its byte slice, a `start` index, and the expected `sigil`. It checks for `'['`, the sigil byte, a valid first name byte, consumes subsequent mention-name bytes, requires `']'`, skips whitespace, requires `'('`, scans until `')'`, trims the path, and returns `Some((name, path, end_index))` or `None` on any structural failure. It mutates no state.

**Call relations**: This parser is called from `extract_tool_mentions_from_text_with_sigil` whenever a `[` byte is encountered. It relies on `is_mention_name_char` for name validation.

*Call graph*: calls 1 internal fn (is_mention_name_char); called by 1 (extract_tool_mentions_from_text_with_sigil).


##### `is_common_env_var`  (lines 477–493)

```
fn is_common_env_var(name: &str) -> bool
```

**Purpose**: Recognizes environment-variable-like names that should not be treated as tool mentions. The check is case-insensitive via uppercase normalization.

**Data flow**: It takes a `&str`, converts it to uppercase ASCII, matches it against a fixed set such as `PATH`, `HOME`, `USER`, `PWD`, `TMPDIR`, and returns a boolean. It mutates nothing.

**Call relations**: This predicate is used by the mention parser to suppress false positives from shell/environment text.

*Call graph*: called by 1 (extract_tool_mentions_from_text_with_sigil); 1 external calls (matches!).


##### `is_mention_name_char`  (lines 495–497)

```
fn is_mention_name_char(byte: u8) -> bool
```

**Purpose**: Defines the allowed byte set for mention names: ASCII letters, digits, underscore, and hyphen. It is the lexical rule shared by plain and linked mention parsing.

**Data flow**: It takes a `u8` byte and returns whether it matches the allowed ranges/characters. No state is read or mutated.

**Call relations**: This helper is used by both `extract_tool_mentions_from_text_with_sigil` and `parse_linked_tool_mention` to keep mention-name parsing consistent.

*Call graph*: called by 2 (extract_tool_mentions_from_text_with_sigil, parse_linked_tool_mention); 1 external calls (matches!).


##### `is_skill_path`  (lines 499–501)

```
fn is_skill_path(path: &str) -> bool
```

**Purpose**: Classifies a linked mention path as a skill path rather than an app/MCP/plugin path. Any path not starting with `app://`, `mcp://`, or `plugin://` is treated as a skill path.

**Data flow**: It takes a `&str path`, checks its prefixes, and returns a boolean. It mutates no state.

**Call relations**: This helper is used during mention parsing and skill matching to distinguish skill links from connector/plugin links.

*Call graph*: called by 1 (extract_tool_mentions_from_text_with_sigil).


##### `normalize_skill_path`  (lines 503–505)

```
fn normalize_skill_path(path: &str) -> &str
```

**Purpose**: Normalizes a skill path by stripping the optional `skill://` prefix. Paths without that prefix are returned unchanged.

**Data flow**: It takes a `&str path`, applies `strip_prefix("skill://")`, and returns the stripped or original `&str`. It mutates nothing.

**Call relations**: This helper is used by skill mention matching so linked skill paths compare correctly against stored filesystem-like skill paths.


##### `app_id_from_path`  (lines 507–510)

```
fn app_id_from_path(path: &str) -> Option<&str>
```

**Purpose**: Extracts the connector app id from an `app://...` linked mention path, rejecting empty ids. Non-app paths return `None`.

**Data flow**: It takes a `&str path`, strips the `app://` prefix, filters out empty results, and returns `Option<&str>`. It mutates no state.

**Call relations**: This helper is used by `find_app_mentions` to honor explicit app bindings from linked mentions.

*Call graph*: called by 1 (find_app_mentions).


##### `tests::app`  (lines 517–533)

```
fn app(id: &str, name: &str) -> AppInfo
```

**Purpose**: Constructs a minimal accessible, enabled `AppInfo` fixture for mention-resolution tests. Callers can then override fields with struct update syntax.

**Data flow**: It takes `id` and `name` strings, allocates owned `String` fields, fills the remaining `AppInfo` fields with `None`, empty vectors, or `true` accessibility/enabled defaults, and returns the new `AppInfo`.

**Call relations**: This helper is used only by the tests in this module to reduce fixture boilerplate.

*Call graph*: 1 external calls (new).


##### `tests::find_app_mentions_requires_accessible_enabled_apps_for_slugs`  (lines 536–554)

```
fn find_app_mentions_requires_accessible_enabled_apps_for_slugs()
```

**Purpose**: Verifies that slug-based app mention resolution returns only apps that are both accessible and enabled. Inaccessible and disabled apps are intentionally excluded even when mentioned by slug.

**Data flow**: It builds a test `apps` vector with one normal app and two unavailable variants, parses mentions from a slug-only string via `collect_tool_mentions`, calls `find_app_mentions`, and asserts that only the accessible enabled app is returned.

**Call relations**: This test exercises the interaction between `collect_tool_mentions`, `find_app_mentions`, and `is_app_mentionable` for plain slug mentions.

*Call graph*: calls 1 internal fn (collect_tool_mentions); 3 external calls (new, assert_eq!, vec!).


##### `tests::find_app_mentions_requires_accessible_enabled_apps_for_bound_paths`  (lines 557–580)

```
fn find_app_mentions_requires_accessible_enabled_apps_for_bound_paths()
```

**Purpose**: Verifies that explicit `app://` mention bindings still respect accessibility and enabled-state filtering. Bound paths do not bypass availability checks.

**Data flow**: It constructs the same app fixtures as the slug test, builds a `mention_paths` map from slugs to `app://` ids, parses mentions with `collect_tool_mentions`, resolves apps with `find_app_mentions`, and asserts that only the accessible enabled app is returned.

**Call relations**: This test covers the explicit-binding branch in `find_app_mentions`, confirming that path-based selection still flows through `is_app_mentionable`.

*Call graph*: calls 1 internal fn (collect_tool_mentions); 3 external calls (from, assert_eq!, vec!).


### `tui/src/chatwidget/ide_context.rs`

`domain_logic` · `request handling`

This file keeps the IDE-context feature state small and explicit: `IdeContextState` tracks whether prompt injection is enabled and whether the user has already been warned that context fetch failed for the current enabled period. The `ChatWidget` methods then use that state in two distinct flows: command handling (`/ide`, `/ide on|off|status`) and per-message prompt augmentation before submission.

The command path toggles or sets the feature, updates the bottom-pane indicator, and emits concrete info/error messages. Enabling is optimistic only until `add_ide_context_status_message` verifies connectivity by calling `crate::ide_context::fetch_ide_context(&self.config.cwd)`. A successful fetch keeps the feature enabled, clears warning suppression, and tailors the status hint depending on `has_prompt_context`; a failed fetch immediately disables the feature and shows the backend-provided user-facing hint.

The submission path in `maybe_apply_ide_context` is intentionally softer: if IDE context is enabled but fetching fails for a particular outgoing turn, the turn still proceeds without IDE context. The method updates the status indicator either way, applies `apply_ide_context_to_user_input` only on success, and emits the “skipped for this message” notice at most once until a later successful fetch resets `prompt_fetch_warned`. The indicator reflects only the enabled flag, not whether the latest fetch produced prompt material.

#### Function details

##### `IdeContextState::is_enabled`  (lines 14–16)

```
fn is_enabled(&self) -> bool
```

**Purpose**: Returns the current on/off flag for IDE context injection. It is the single read accessor used by chat-widget command and submission logic.

**Data flow**: Reads `self.enabled` and returns that boolean unchanged. It does not mutate any state or emit UI effects.

**Call relations**: This predicate gates both command toggling and prompt injection paths: callers check it before deciding whether to disable the feature, fetch IDE context, or update the status indicator.


##### `IdeContextState::enable`  (lines 18–21)

```
fn enable(&mut self)
```

**Purpose**: Turns IDE context on and resets one-shot warning suppression. Enabling always starts from a clean warning state so the next fetch failure can be surfaced again.

**Data flow**: Mutates `self.enabled` to `true` and `self.prompt_fetch_warned` to `false`. It returns no value.

**Call relations**: Used by the `/ide` command handlers before they show status. The later status/fetch path determines whether the feature remains enabled or is immediately disabled due to fetch failure.


##### `IdeContextState::disable`  (lines 23–26)

```
fn disable(&mut self)
```

**Purpose**: Turns IDE context off and clears any remembered fetch-warning state. Disabling fully resets the feature state rather than preserving prior transient failures.

**Data flow**: Mutates `self.enabled` to `false` and `self.prompt_fetch_warned` to `false`. It returns no value.

**Call relations**: Invoked when `/ide` toggles off, when `/ide off` is issued explicitly, and when status probing during enablement fails and the widget decides the feature cannot stay active.


##### `IdeContextState::mark_available`  (lines 28–30)

```
fn mark_available(&mut self)
```

**Purpose**: Marks IDE context as successfully available by clearing the warning latch. This lets a later fetch failure produce a fresh informational warning.

**Data flow**: Writes `self.prompt_fetch_warned = false` and leaves `enabled` unchanged. It returns no value.

**Call relations**: Called after successful IDE-context fetches from both the status-message path and the outgoing-turn augmentation path so transient failures do not permanently suppress future notices.


##### `ChatWidget::handle_ide_command`  (lines 34–43)

```
fn handle_ide_command(&mut self)
```

**Purpose**: Implements bare `/ide` as a toggle. It flips the enabled state, synchronizes the bottom-pane indicator, and emits either an immediate off message or the richer enable/status flow.

**Data flow**: Reads `self.ide_context.is_enabled()`. If already enabled, it disables the state, updates the indicator, and writes an info history message saying IDE context is off; otherwise it enables the state and delegates status verification/message generation.

**Call relations**: This is the no-argument branch used by `ChatWidget::handle_ide_command_args`. On the disable path it directly calls `sync_ide_context_status_indicator`; on the enable path it delegates to `add_ide_context_status_message` so fetch validation and user messaging stay centralized.

*Call graph*: calls 2 internal fn (add_ide_context_status_message, sync_ide_context_status_indicator); called by 1 (handle_ide_command_args).


##### `ChatWidget::handle_ide_command_args`  (lines 45–64)

```
fn handle_ide_command_args(&mut self, args: &str)
```

**Purpose**: Parses `/ide` subcommands and dispatches to the appropriate enable/disable/status behavior. It accepts empty input, `on`, `off`, and `status`, and rejects anything else with usage text.

**Data flow**: Consumes `args: &str`, lowercases it with ASCII semantics, and matches the resulting string. Depending on the branch it toggles via `handle_ide_command`, forces enable plus status message, forces disable plus indicator sync and off message, emits status only, or writes an error message with the accepted syntax.

**Call relations**: Acts as the command dispatcher entry for `/ide ...`. It routes empty args through `handle_ide_command` and otherwise funnels user-visible status work through `add_ide_context_status_message` and `sync_ide_context_status_indicator`.

*Call graph*: calls 3 internal fn (add_ide_context_status_message, handle_ide_command, sync_ide_context_status_indicator).


##### `ChatWidget::maybe_apply_ide_context`  (lines 67–89)

```
fn maybe_apply_ide_context(&mut self, items: &mut Vec<UserInput>)
```

**Purpose**: Fetches current IDE context just before a user turn is sent and appends that context to the outgoing `UserInput` list when available. Failures are non-fatal and only suppress IDE augmentation for that one message.

**Data flow**: Takes `items: &mut Vec<UserInput>` and first reads `self.ide_context.is_enabled()`. If disabled, it returns immediately. If enabled, it calls external `fetch_ide_context(&self.config.cwd)`; on success it clears warning suppression, syncs the indicator, and mutates `items` via external `apply_ide_context_to_user_input`. On error it still syncs the indicator and, if `prompt_fetch_warned` is still false, sets that flag true and writes a one-time informational message using `err.prompt_skip_hint()`.

**Call relations**: This method sits in the user-message submission pipeline before the final `AppCommand::user_turn` is sent. It delegates actual IDE probing and prompt-item construction to the `crate::ide_context` helpers, while keeping UI warning throttling local to `ChatWidget`.

*Call graph*: calls 1 internal fn (sync_ide_context_status_indicator); 2 external calls (apply_ide_context_to_user_input, fetch_ide_context).


##### `ChatWidget::add_ide_context_status_message`  (lines 91–126)

```
fn add_ide_context_status_message(&mut self)
```

**Purpose**: Produces the user-facing status result for IDE context, including connectivity validation and explanatory hints. It is the authoritative status-reporting path for both enabling and explicit `/ide status` checks.

**Data flow**: Reads `self.ide_context.is_enabled()`. If disabled, it syncs the indicator and writes an off info message. If enabled, it fetches IDE context from `self.config.cwd`; on success it clears warning suppression, syncs the indicator, checks external `has_prompt_context(&context)`, and writes an info message whose hint distinguishes between full prompt injection and mere IDE connectivity. On fetch error it disables IDE context, syncs the indicator, and writes an info message saying enablement failed with `err.user_facing_hint()`.

**Call relations**: Called from both `handle_ide_command` and `handle_ide_command_args` whenever the widget needs a definitive status message. It centralizes the fetch/validate/report logic so command handlers do not duplicate success/failure messaging.

*Call graph*: calls 1 internal fn (sync_ide_context_status_indicator); called by 2 (handle_ide_command, handle_ide_command_args); 2 external calls (fetch_ide_context, has_prompt_context).


##### `ChatWidget::sync_ide_context_status_indicator`  (lines 128–131)

```
fn sync_ide_context_status_indicator(&mut self)
```

**Purpose**: Pushes the current IDE-context enabled flag into the bottom-pane status indicator. It keeps the visual indicator aligned with `IdeContextState` after command changes and fetch attempts.

**Data flow**: Reads `self.ide_context.is_enabled()` and passes that boolean to `self.bottom_pane.set_ide_context_active(...)`. It returns no value and does not alter `IdeContextState` itself.

**Call relations**: This is the shared UI-sync helper used after toggles, status checks, and per-turn fetch attempts. Other methods call it whenever they may have changed or validated the IDE-context state.

*Call graph*: called by 4 (add_ide_context_status_message, handle_ide_command, handle_ide_command_args, maybe_apply_ide_context).


### `tui/src/chatwidget/goal_menu.rs`

`domain_logic` · `request handling`

This file contains the user-facing goal menu helpers for `ChatWidget`. The widget methods are thin UI actions around `AppThreadGoal` state. `show_goal_summary` renders a compact transcript summary by delegating to `goal_summary_lines`, which builds styled `Line<'static>` rows for status, objective, elapsed time, tokens used, optional token budget, and a command hint tailored to the goal's status. The status wording is centralized in `goal_status_label`.

`show_goal_edit_prompt` opens a `CustomPromptView` prefilled with the current objective. Its submit closure captures the thread id, the edited-status mapping, and token budget, then sends `AppEvent::SetThreadGoalDraft` with a `goal_files::GoalDraft` containing the new objective and `ThreadGoalSetMode::UpdateExisting`. The helper `edited_goal_status` preserves paused/blocked/usage-limited states but resets budget-limited and complete goals back to active when edited.

`show_resume_paused_goal_prompt` presents a two-item selection popup asking whether to resume a paused goal. Choosing the first item sends `AppEvent::SetThreadGoalStatus { status: Active }`; the second simply dismisses the popup. Finally, `on_thread_goal_cleared` clears `self.current_goal_status` and refreshes the collaboration mode indicator only when the cleared thread id matches the currently active thread.

#### Function details

##### `ChatWidget::show_goal_summary`  (lines 9–11)

```
fn show_goal_summary(&mut self, goal: AppThreadGoal)
```

**Purpose**: Adds a formatted summary of the current thread goal to chat history. It is the output path for the bare `/goal` command.

**Data flow**: Takes an `AppThreadGoal`, passes a reference to `goal_summary_lines(&goal)`, and feeds the resulting `Vec<Line<'static>>` into `self.add_plain_history_lines(...)`.

**Call relations**: This is a simple wrapper around the local formatter `goal_summary_lines`, used when the user requests goal information rather than an edit action.

*Call graph*: calls 1 internal fn (goal_summary_lines).


##### `ChatWidget::show_goal_edit_prompt`  (lines 13–37)

```
fn show_goal_edit_prompt(&mut self, thread_id: ThreadId, goal: AppThreadGoal)
```

**Purpose**: Opens a text prompt for editing an existing goal objective and wires submission to a goal-draft update event. It preserves or adjusts the goal status according to edit semantics.

**Data flow**: Accepts `thread_id` and `goal`, clones `self.app_event_tx`, computes `status = edited_goal_status(goal.status)` and captures `token_budget`. It constructs a `CustomPromptView` with title, prompt text, and initial objective. The submit closure receives a new `objective` string and sends `AppEvent::SetThreadGoalDraft` containing the thread id, a `goal_files::GoalDraft` with that objective and defaulted remaining fields, and `ThreadGoalSetMode::UpdateExisting { status, token_budget }`. The view is then shown in the bottom pane.

**Call relations**: This method is invoked when the user chooses to edit a goal. It relies on `edited_goal_status` to preserve the intended lifecycle semantics of edited goals.

*Call graph*: calls 2 internal fn (new, edited_goal_status); 1 external calls (new).


##### `ChatWidget::show_resume_paused_goal_prompt`  (lines 39–72)

```
fn show_resume_paused_goal_prompt(
        &mut self,
        thread_id: ThreadId,
        objective: String,
    )
```

**Purpose**: Shows a confirmation popup for resuming a paused goal. The popup offers either resuming immediately or leaving the goal paused.

**Data flow**: Takes `thread_id` and `objective`, builds a `Vec<SelectionAction>` whose action closure sends `AppEvent::SetThreadGoalStatus { thread_id, status: Active }`, then calls `self.show_selection_view(...)` with `SelectionViewParams` containing title, subtitle, footer hint, initial selection, and two `SelectionItem`s: 'Resume goal' with the action and 'Leave paused' with no action.

**Call relations**: This is a specialized UI path for paused goals. It does not itself mutate goal state; it emits the status-change event only if the user selects the resume option.

*Call graph*: 3 external calls (default, format!, vec!).


##### `ChatWidget::on_thread_goal_cleared`  (lines 74–82)

```
fn on_thread_goal_cleared(&mut self, thread_id: &str)
```

**Purpose**: Clears the widget's cached goal-status indicator when the active thread's goal has been removed. It avoids touching state for unrelated threads.

**Data flow**: Reads `self.thread_id` and compares its string form to the provided `thread_id`. If they match, it sets `self.current_goal_status = None` and calls `self.update_collaboration_mode_indicator()`.

**Call relations**: This is an event reaction used when thread-goal state changes externally. Its effect is limited to the currently displayed thread.


##### `goal_summary_lines`  (lines 85–120)

```
fn goal_summary_lines(goal: &AppThreadGoal) -> Vec<Line<'static>>
```

**Purpose**: Formats an `AppThreadGoal` into the exact transcript lines shown by `/goal`. It includes status, objective, usage metrics, optional budget, and a status-dependent command hint.

**Data flow**: Reads fields from `goal` to build a `Vec<Line<'static>>`: bold 'Goal', status line using `goal_status_label`, objective line, time-used line via `format_goal_elapsed_seconds`, tokens-used line via `format_tokens_compact`, and optionally a token-budget line. It then selects a command-hint string based on `goal.status`, appends a blank line and the dimmed hint, and returns the vector.

**Call relations**: Called only by `ChatWidget::show_goal_summary`. It centralizes the transcript formatting so the widget method remains a thin wrapper.

*Call graph*: called by 1 (show_goal_summary); 3 external calls (default, from, vec!).


##### `goal_status_label`  (lines 122–131)

```
fn goal_status_label(status: AppThreadGoalStatus) -> &'static str
```

**Purpose**: Maps `AppThreadGoalStatus` to the lowercase human-readable label used in goal summaries. It covers all goal status variants explicitly.

**Data flow**: Matches the input status and returns one of the static strings: `active`, `paused`, `blocked`, `usage limited`, `limited by budget`, or `complete`.

**Call relations**: Used by `goal_summary_lines` to keep status wording consistent in the `/goal` transcript output.


##### `edited_goal_status`  (lines 133–143)

```
fn edited_goal_status(status: AppThreadGoalStatus) -> AppThreadGoalStatus
```

**Purpose**: Determines what status an edited goal should keep after the objective is changed. It preserves in-progress paused/blocked states but reactivates completed or budget-limited goals.

**Data flow**: Matches the input `AppThreadGoalStatus` and returns the same status for `Active`, `Paused`, `Blocked`, and `UsageLimited`; returns `Active` for `BudgetLimited` and `Complete`.

**Call relations**: Used by `ChatWidget::show_goal_edit_prompt` when constructing the update event so editing a goal carries the intended lifecycle semantics.

*Call graph*: called by 1 (show_goal_edit_prompt).


### `tui/src/chatwidget/hooks.rs`

`orchestration` · `request handling`

This file is a small orchestration layer around the hooks browser UI. `add_hooks_output` initiates loading by sending `AppEvent::FetchHooksList` with the widget's current configured working directory. When results arrive, `on_hooks_loaded` first checks that the response's `cwd` still matches `self.config.cwd`; this guards against stale asynchronous responses after the user has changed directories or context. If the cwd matches and the fetch succeeded, it reduces the full `HooksListResponse` to the relevant `HooksListEntry` for that cwd using `hooks_list_entry_for_cwd` and opens the browser. On failure, it surfaces a concrete error message in the chat history.

`open_hooks_browser` constructs a `HooksBrowserView` from the selected entry, the app-event sender, and the bottom pane's list keymap, then installs that view into the bottom pane and requests a redraw. The file intentionally contains no hook-editing logic or lifecycle state; it is only the transport from a fetch result into the dedicated browser view.

#### Function details

##### `ChatWidget::add_hooks_output`  (lines 11–15)

```
fn add_hooks_output(&mut self)
```

**Purpose**: Starts loading the hooks list for the widget's current working directory. It is the command/output entrypoint for opening hooks UI.

**Data flow**: Reads `self.config.cwd`, clones it to a `PathBuf`, and sends `AppEvent::FetchHooksList { cwd }` through `self.app_event_tx`.

**Call relations**: This is the initial trigger for the hooks browser flow. The eventual response is handled by `ChatWidget::on_hooks_loaded`.


##### `ChatWidget::on_hooks_loaded`  (lines 17–32)

```
fn on_hooks_loaded(
        &mut self,
        cwd: PathBuf,
        result: Result<HooksListResponse, String>,
    )
```

**Purpose**: Consumes the asynchronous hooks-list result, discarding stale responses for old working directories and opening the hooks browser on success. It reports fetch failures as user-visible error messages.

**Data flow**: Takes a `cwd` and `Result<HooksListResponse, String>`. If `self.config.cwd.as_path() != cwd.as_path()`, it returns without side effects. Otherwise, on `Ok(response)` it computes the relevant `HooksListEntry` with `hooks_list_entry_for_cwd(response, &cwd)` and passes it to `open_hooks_browser`. On `Err(err)`, it formats `"Failed to load hooks: {err}"` and calls `self.add_error_message(...)`.

**Call relations**: This is the result handler paired with `add_hooks_output`. It delegates successful UI opening to `ChatWidget::open_hooks_browser`.

*Call graph*: calls 2 internal fn (open_hooks_browser, hooks_list_entry_for_cwd); 2 external calls (as_path, format!).


##### `ChatWidget::open_hooks_browser`  (lines 34–42)

```
fn open_hooks_browser(&mut self, entry: HooksListEntry)
```

**Purpose**: Installs the hooks browser view into the bottom pane and redraws the UI. It packages the selected hooks entry together with the event sender and list key bindings.

**Data flow**: Accepts a `HooksListEntry`, constructs `HooksBrowserView::from_entry(entry, self.app_event_tx.clone(), self.bottom_pane.list_keymap())`, boxes it, passes it to `self.bottom_pane.show_view(...)`, and then calls `self.request_redraw()`.

**Call relations**: Called from `on_hooks_loaded` after a successful fetch and cwd validation. It is the final UI-opening step in the hooks browser flow.

*Call graph*: calls 1 internal fn (from_entry); called by 1 (on_hooks_loaded); 1 external calls (new).


### `tui/src/chatwidget/slash_dispatch.rs`

`orchestration` · `request handling for slash commands and queued startup input`

This file is the command dispatcher for the TUI chat surface. It defines a small internal source enum (`Live` vs `Queued`) and a `PreparedSlashCommandArgs` bundle so inline-argument commands can be processed uniformly whether they came directly from the composer or from queued startup input. The top-level wrappers also preserve local slash-command recall semantics by recording staged command history only after dispatch succeeds.

`dispatch_command` handles the large bare-command matrix. Before branching, it enforces side-conversation restrictions, review-mode restrictions for `/side`, and task-running restrictions for commands that are not allowed mid-task. The match arms then either mutate widget state directly, open popups, send `AppEvent`s, submit user messages or ops, spawn async work (for `/diff`), or emit usage/help errors. Several commands have special policy: `/plan` switches collaboration mode, `/goal` opens menus or appends history, `/raw` emits a separate raw-output-mode-changed event, and Windows-only sandbox elevation is guarded by runtime checks even though the command should normally be hidden.

Inline-argument handling is split into preparation and execution. Live commands may reuse already prepared composer submission state or harvest recent images/mention bindings; queued commands reconstruct argument text-element ranges with `slash_command_args_elements`. `dispatch_prepared_command_with_args` then implements argument-aware variants such as `/goal`, `/plan`, `/rename`, `/usage`, `/mcp`, `/keymap`, `/side`, and `/pets`, including queueing `/goal` before session startup and draining composer submission state only for live non-goal commands. The file also computes built-in command flags for slash lookup and decides whether queued command draining should continue after each command.

#### Function details

##### `ChatWidget::handle_slash_command_dispatch`  (lines 47–53)

```
fn handle_slash_command_dispatch(&mut self, cmd: SlashCommand)
```

**Purpose**: Dispatches a bare slash command and then commits the staged local slash-history entry so Up-arrow recall treats it like submitted input. `/goal` additionally drains pending submission state after dispatch.

**Data flow**: It takes a `SlashCommand`, calls `dispatch_command(cmd)`, conditionally drains pending submission state when `cmd == SlashCommand::Goal`, then calls `bottom_pane.record_pending_slash_command_history()`. It returns nothing.

**Call relations**: This is the main entrypoint for slash commands without inline args. It delegates actual command behavior to `ChatWidget::dispatch_command` and then performs the local-history bookkeeping wrapper described in the module docs.

*Call graph*: calls 1 internal fn (dispatch_command).


##### `ChatWidget::handle_service_tier_command_dispatch`  (lines 55–67)

```
fn handle_service_tier_command_dispatch(&mut self, command: ServiceTierCommand)
```

**Purpose**: Dispatches a service-tier slash command, but blocks it inside side conversations with a user-facing error. In either case it records slash-command history afterward.

**Data flow**: It takes a `ServiceTierCommand`, checks `self.active_side_conversation`, and if true adds an error message, drains pending submission state, records slash history, and returns. Otherwise it calls `toggle_service_tier_from_ui(command)` and records slash history. It returns nothing.

**Call relations**: This wrapper is used from queued slash-prompt handling when slash lookup resolves to a service-tier command. It is separate from builtin command dispatch because service-tier commands are represented by a different slash-command item type.

*Call graph*: called by 1 (submit_queued_slash_prompt); 1 external calls (format!).


##### `ChatWidget::handle_slash_command_with_args_dispatch`  (lines 74–82)

```
fn handle_slash_command_with_args_dispatch(
        &mut self,
        cmd: SlashCommand,
        args: String,
        text_elements: Vec<TextElement>,
    )
```

**Purpose**: Dispatches an inline slash command with arguments and then records the staged slash-history entry exactly once. It prevents double-recording when inline args later flow through normal submission preparation.

**Data flow**: It takes a `SlashCommand`, raw `args`, and `text_elements`, forwards them to `dispatch_command_with_args`, then calls `bottom_pane.record_pending_slash_command_history()`. It returns nothing.

**Call relations**: This is the entry wrapper for slash commands that arrived with inline arguments from the composer. It delegates all command semantics to `ChatWidget::dispatch_command_with_args` and handles only recall-history bookkeeping.

*Call graph*: calls 1 internal fn (dispatch_command_with_args).


##### `ChatWidget::apply_plan_slash_command`  (lines 84–102)

```
fn apply_plan_slash_command(&mut self) -> bool
```

**Purpose**: Attempts to switch the widget into Plan collaboration mode via the catalog’s Plan preset. It emits explanatory info messages when collaboration modes are disabled or no Plan preset is available.

**Data flow**: It checks `collaboration_modes_enabled()`, and if false adds an info message plus hint and returns `false`. Otherwise it asks `collaboration_modes::plan_mask(self.model_catalog.as_ref())` for a Plan mask; if present it applies it through `set_collaboration_mask_from_user_action(mask)` and returns `true`, else it adds an info message and returns `false`.

**Call relations**: This helper is used by both bare `/plan` dispatch and inline `/plan ...` handling. It encapsulates the mode-switch policy so both paths share the same availability checks and user messaging.

*Call graph*: calls 1 internal fn (plan_mask); called by 2 (dispatch_command, dispatch_prepared_command_with_args).


##### `ChatWidget::request_side_conversation`  (lines 104–115)

```
fn request_side_conversation(
        &mut self,
        parent_thread_id: ThreadId,
        user_message: Option<UserMessage>,
    )
```

**Purpose**: Starts side-conversation creation by updating the footer/context label, requesting redraw, and sending the `StartSide` app event with optional initial user message. It is the common launch path for empty and inline-message side threads.

**Data flow**: It takes a `parent_thread_id` and optional `UserMessage`, sets the side-conversation context label to `"Side starting..."`, requests redraw, and sends `AppEvent::StartSide { parent_thread_id, user_message }` through `app_event_tx`. It returns nothing.

**Call relations**: This helper is called by `ChatWidget::request_empty_side_conversation` and by inline `/side` or `/btw` handling in `dispatch_prepared_command_with_args`.

*Call graph*: called by 2 (dispatch_prepared_command_with_args, request_empty_side_conversation).


##### `ChatWidget::request_empty_side_conversation`  (lines 117–127)

```
fn request_empty_side_conversation(&mut self, cmd: SlashCommand)
```

**Purpose**: Starts a side conversation without an initial message, but only after a session/thread exists. Before session startup it emits a command-specific error instead.

**Data flow**: It takes the triggering `SlashCommand`, reads `self.thread_id`, and if absent formats and adds an error message like `'/side' is unavailable before the session starts.`. If present, it forwards the thread id and `None` user message to `request_side_conversation`. It returns nothing.

**Call relations**: This helper is used by bare `/side` and `/btw` dispatch in `ChatWidget::dispatch_command`. It centralizes the pre-session guard and delegates successful launches to `ChatWidget::request_side_conversation`.

*Call graph*: calls 2 internal fn (request_side_conversation, command); called by 1 (dispatch_command); 1 external calls (format!).


##### `ChatWidget::emit_raw_output_mode_changed`  (lines 129–132)

```
fn emit_raw_output_mode_changed(&self, enabled: bool)
```

**Purpose**: Broadcasts the current raw-output-mode state to the app layer. It is a tiny event-emission helper used after `/raw` changes.

**Data flow**: It takes a boolean `enabled` and sends `AppEvent::RawOutputModeChanged { enabled }` through `app_event_tx`. It returns nothing.

**Call relations**: This helper is called from both bare and inline `/raw` command handling so the event emission stays consistent.

*Call graph*: called by 2 (dispatch_command, dispatch_prepared_command_with_args).


##### `ChatWidget::dispatch_command`  (lines 134–525)

```
fn dispatch_command(&mut self, cmd: SlashCommand)
```

**Purpose**: Executes a bare slash command after enforcing side-conversation, review-mode, and task-running restrictions. Its match arms cover the full builtin command set, including popup opening, app-event emission, message submission, async diff computation, status output, and platform-specific sandbox actions.

**Data flow**: It takes a `SlashCommand`, first checks `ensure_slash_command_allowed_in_side_conversation`, `ensure_side_command_allowed_outside_review`, and `cmd.available_during_task()` against task-running state. If allowed, it matches on `cmd` and performs command-specific actions: sending `AppEvent`s, opening selection views/popups, mutating widget state, submitting user messages or ops, spawning async `/diff` work, adding history/status output, toggling raw/vim/service-tier state, or emitting usage/help errors. It returns nothing; outputs are widget mutations, history cells, redraw requests, spawned tasks, and app events.

**Call relations**: This is the central bare-command dispatcher, called by `handle_slash_command_dispatch`, by `dispatch_command_with_args` when a command has no usable args, by `dispatch_prepared_command_with_args` as a fallback, and by `submit_queued_slash_prompt` for queued bare commands. It delegates to many helpers in this file such as `apply_plan_slash_command`, `request_empty_side_conversation`, `emit_raw_output_mode_changed`, `ensure_usage_command_available`, and the side/review restriction guards.

*Call graph*: calls 8 internal fn (apply_plan_slash_command, emit_raw_output_mode_changed, ensure_side_command_allowed_outside_review, ensure_slash_command_allowed_in_side_conversation, ensure_usage_command_available, request_empty_side_conversation, available_during_task, level_from_config); called by 4 (dispatch_command_with_args, dispatch_prepared_command_with_args, handle_slash_command_dispatch, submit_queued_slash_prompt); 12 external calls (default, from, from, DiffResult, feedback_disabled_params, feedback_selection_params, format!, new_error_event, include_str!, matches! (+2 more)).


##### `ChatWidget::dispatch_command_with_args`  (lines 532–597)

```
fn dispatch_command_with_args(
        &mut self,
        cmd: SlashCommand,
        args: String,
        text_elements: Vec<TextElement>,
    )
```

**Purpose**: Runs an inline slash command, deciding whether to fall back to bare dispatch, prepare live inline arguments from composer state, or execute the argument-aware path directly. It also enforces the same side/review/task restrictions as bare dispatch.

**Data flow**: It takes a `SlashCommand`, raw `args`, and `text_elements`, checks side/review restrictions and task-running availability, falls back to `dispatch_command(cmd)` when the command does not support inline args or the trimmed args are empty, special-cases `/goal` to preserve pending pastes/images/URLs from the composer, otherwise obtains prepared args/elements from `prepare_live_inline_args` and forwards a `PreparedSlashCommandArgs` bundle to `dispatch_prepared_command_with_args`. It returns nothing.

**Call relations**: This method is called by `handle_slash_command_with_args_dispatch`. It delegates fallback behavior to `ChatWidget::dispatch_command`, live preparation to `ChatWidget::prepare_live_inline_args`, and actual argument-aware execution to `ChatWidget::dispatch_prepared_command_with_args`.

*Call graph*: calls 7 internal fn (dispatch_command, dispatch_prepared_command_with_args, ensure_side_command_allowed_outside_review, ensure_slash_command_allowed_in_side_conversation, prepare_live_inline_args, available_during_task, supports_inline_args); called by 1 (handle_slash_command_with_args_dispatch); 3 external calls (new, format!, new_error_event).


##### `ChatWidget::prepare_live_inline_args`  (lines 599–610)

```
fn prepare_live_inline_args(
        &mut self,
        args: String,
        text_elements: Vec<TextElement>,
    ) -> Option<(String, Vec<TextElement>)>
```

**Purpose**: Determines how to obtain the final inline-argument text and text elements for a live slash command. If the composer is otherwise empty, it uses the provided args directly; otherwise it asks the bottom pane to prepare a submission snapshot.

**Data flow**: It takes raw `args` and `text_elements`. If `bottom_pane.composer_text()` is empty, it returns `Some((args, text_elements))`; otherwise it calls `bottom_pane.prepare_inline_args_submission(false)` and returns that `Option<(String, Vec<TextElement>)>`. It mutates only whatever state the bottom pane preparation path changes.

**Call relations**: This helper is used only by `ChatWidget::dispatch_command_with_args` to normalize live inline-argument preparation before dispatch.

*Call graph*: called by 1 (dispatch_command_with_args).


##### `ChatWidget::clear_live_goal_submission`  (lines 612–617)

```
fn clear_live_goal_submission(&mut self)
```

**Purpose**: Clears the composer text, text elements, pending pastes, and staged submission state for a live `/goal` command after the command has been consumed locally. It prevents stale draft state from lingering in the composer.

**Data flow**: It resets the composer text/elements/images to empty via `bottom_pane.set_composer_text(String::new(), Vec::new(), Vec::new())`, clears pending pastes with `set_composer_pending_pastes(Vec::new())`, drains pending submission state, and returns nothing.

**Call relations**: This cleanup helper is called from several `/goal` branches inside `ChatWidget::dispatch_prepared_command_with_args`, especially when the goal command is handled locally rather than submitted as a normal user turn.

*Call graph*: called by 1 (dispatch_prepared_command_with_args); 2 external calls (new, new).


##### `ChatWidget::prepared_inline_user_message`  (lines 619–642)

```
fn prepared_inline_user_message(
        &mut self,
        args: String,
        text_elements: Vec<TextElement>,
        mut local_images: Vec<LocalImageAttachment>,
        mut remote_image_urls: V
```

**Purpose**: Builds a `UserMessage` from prepared inline slash-command arguments, optionally replacing the supplied images/URLs/mention bindings with the most recent live submission artifacts. This keeps live inline commands aligned with the composer’s actual staged attachments and mentions.

**Data flow**: Inputs are `args`, `text_elements`, vectors of local images, remote image URLs, mention bindings, and a `SlashCommandDispatchSource`. For `Live` source it overwrites those attachment/binding vectors by taking recent submission images with placeholders, remote image URLs, and mention bindings from the widget/bottom pane; then it returns a `UserMessage { text: args, local_images, remote_image_urls, text_elements, mention_bindings }`.

**Call relations**: This helper is used by `ChatWidget::dispatch_prepared_command_with_args` for inline `/plan` and `/side` submissions so both live and queued sources produce a consistent `UserMessage` structure.

*Call graph*: called by 1 (dispatch_prepared_command_with_args).


##### `ChatWidget::dispatch_prepared_command_with_args`  (lines 644–888)

```
fn dispatch_prepared_command_with_args(
        &mut self,
        cmd: SlashCommand,
        prepared: PreparedSlashCommandArgs,
    )
```

**Purpose**: Executes the argument-aware behavior for prepared slash commands, covering commands like `/usage`, `/mcp`, `/keymap`, `/raw`, `/rename`, `/plan`, `/goal`, `/side`, `/review`, `/resume`, `/sandbox-add-read-dir`, and `/pets`. It is the main inline-command execution engine for both live and queued sources.

**Data flow**: It takes a `SlashCommand` and a `PreparedSlashCommandArgs` bundle, destructures the bundle, trims the args, and matches on `cmd`. Depending on the command it may parse token-activity views, validate keymap config, toggle raw mode, normalize and submit thread renames, switch to Plan mode and submit or queue a `UserMessage`, interpret `/goal` control commands (`clear`, `edit`, `pause`, `resume`) or build a `GoalDraft`, start side conversations with an inline message, submit review ops, resume sessions by id/name, begin Windows sandbox read-root setup, disable/select pets, or fall back to `dispatch_command(cmd)`. For live non-goal commands it drains pending submission state at the end. It returns nothing.

**Call relations**: This method is called from `ChatWidget::dispatch_command_with_args` for live inline commands and from `ChatWidget::submit_queued_slash_prompt` for queued slash prompts with args. It delegates to helpers in this file such as `apply_plan_slash_command`, `clear_live_goal_submission`, `prepared_inline_user_message`, `request_side_conversation`, `emit_raw_output_mode_changed`, and `ensure_usage_command_available`, and falls back to `ChatWidget::dispatch_command` when no specialized arg handling applies.

*Call graph*: calls 10 internal fn (apply_plan_slash_command, clear_live_goal_submission, dispatch_command, emit_raw_output_mode_changed, ensure_usage_command_available, prepared_inline_user_message, request_side_conversation, parse, from_config, command); called by 2 (dispatch_command_with_args, submit_queued_slash_prompt); 7 external calls (SetStatus, from, new, review, ResumeSessionByIdOrName, format!, matches!).


##### `ChatWidget::submit_queued_slash_prompt`  (lines 890–996)

```
fn submit_queued_slash_prompt(
        &mut self,
        queued_message: QueuedUserMessage,
    ) -> QueueDrain
```

**Purpose**: Consumes a queued user message that may begin with a slash command, resolves and dispatches that command if recognized, or falls back to normal message submission otherwise. It also decides whether queue draining should continue after the command runs.

**Data flow**: It takes a `QueuedUserMessage`, destructures out the `UserMessage` and `pending_pastes`, parses the leading slash name with `parse_slash_name(&text)`, and if parsing fails or the name contains `/` submits the message normally and returns `QueueDrain::Stop`. Otherwise it computes service-tier commands, resolves the slash item with `find_slash_command(name, self.builtin_command_flags(), &service_tier_commands)`, emits an info message and returns `QueueDrain::Continue` for unknown commands, dispatches bare builtin or service-tier commands when no args remain, or for inline-arg builtins trims/restores argument text elements via `slash_command_args_elements` and calls `dispatch_prepared_command_with_args` with `source: Queued`. It returns the `QueueDrain` decision from `queued_command_drain_result` or immediate branches.

**Call relations**: This is the queued-input counterpart to live slash dispatch. It delegates slash parsing to `parse_slash_name`, command lookup to `find_slash_command`, builtin flag computation to `ChatWidget::builtin_command_flags`, execution to `ChatWidget::dispatch_command`, `ChatWidget::handle_service_tier_command_dispatch`, or `ChatWidget::dispatch_prepared_command_with_args`, and post-command queue policy to `ChatWidget::queued_command_drain_result`.

*Call graph*: calls 7 internal fn (parse_slash_name, find_slash_command, builtin_command_flags, dispatch_command, dispatch_prepared_command_with_args, handle_service_tier_command_dispatch, queued_command_drain_result); 2 external calls (slash_command_args_elements, format!).


##### `ChatWidget::builtin_command_flags`  (lines 998–1018)

```
fn builtin_command_flags(&self) -> BuiltinCommandFlags
```

**Purpose**: Builds the `BuiltinCommandFlags` snapshot used during slash-command lookup so only currently valid commands are recognized. The flags reflect collaboration modes, connectors, plugins, goals, service-tier commands, personality support, side-conversation state, and Windows sandbox elevation availability.

**Data flow**: It reads multiple widget/config fields and feature flags, computes `allow_elevate_sandbox` from the Windows sandbox level on Windows or `false` elsewhere, and returns a populated `BuiltinCommandFlags` struct. It mutates no state.

**Call relations**: This helper is called by `ChatWidget::submit_queued_slash_prompt` before `find_slash_command` so queued slash parsing uses the same runtime availability rules as live command menus.

*Call graph*: calls 1 internal fn (level_from_config); called by 1 (submit_queued_slash_prompt); 1 external calls (matches!).


##### `ChatWidget::ensure_usage_command_available`  (lines 1020–1026)

```
fn ensure_usage_command_available(&mut self) -> bool
```

**Purpose**: Checks whether `/usage` is currently allowed by backend authentication state. If not, it emits a fixed error message and returns `false`.

**Data flow**: It reads `self.has_codex_backend_auth`; if true it returns `true`, otherwise it adds an error message using `USAGE_CHATGPT_LOGIN_REQUIRED` and returns `false`. It mutates history/UI state only in the failure case.

**Call relations**: This guard is used by both bare and inline `/usage` handling so the command’s auth requirement is enforced consistently.

*Call graph*: called by 2 (dispatch_command, dispatch_prepared_command_with_args).


##### `ChatWidget::queued_command_drain_result`  (lines 1028–1089)

```
fn queued_command_drain_result(&self, cmd: SlashCommand) -> QueueDrain
```

**Purpose**: Determines whether queued-input draining should continue after a queued slash command executes. Commands that open modals, start tasks, or otherwise change interaction context generally stop draining.

**Data flow**: It takes a `SlashCommand`, first checks whether a user turn is pending/running or a modal/popup is active and returns `QueueDrain::Stop` in that case. Otherwise it matches the command against a hard-coded allowlist of commands that return `QueueDrain::Continue`; all others return `QueueDrain::Stop`.

**Call relations**: This helper is called only by `ChatWidget::submit_queued_slash_prompt` after queued command execution. It encapsulates queue-drain policy separately from command semantics.

*Call graph*: called by 1 (submit_queued_slash_prompt).


##### `ChatWidget::slash_command_args_elements`  (lines 1091–1114)

```
fn slash_command_args_elements(
        rest: &str,
        rest_offset: usize,
        text_elements: &[TextElement],
    ) -> Vec<TextElement>
```

**Purpose**: Rebases `TextElement` byte ranges from the full slash-command text onto just the argument substring. Elements entirely before the argument offset or outside the trimmed argument length are dropped.

**Data flow**: It takes the trimmed argument string `rest`, its byte offset within the original text, and a slice of original `text_elements`. If either input is empty it returns an empty vector. Otherwise it iterates elements, skips those ending before the offset, subtracts `rest_offset` from start/end, clamps end to `rest.len()`, drops empty/out-of-range spans, and returns the remapped `Vec<TextElement>`.

**Call relations**: This helper is used by `ChatWidget::submit_queued_slash_prompt` when reconstructing inline-argument metadata for queued slash commands.

*Call graph*: 3 external calls (new, is_empty, iter).


##### `ChatWidget::ensure_slash_command_allowed_in_side_conversation`  (lines 1116–1126)

```
fn ensure_slash_command_allowed_in_side_conversation(&mut self, cmd: SlashCommand) -> bool
```

**Purpose**: Rejects slash commands that are not permitted while a side conversation is active, emitting a standard error and draining pending submission state. Commands explicitly marked side-safe are allowed through.

**Data flow**: It takes a `SlashCommand`, checks `self.active_side_conversation` and `cmd.available_in_side_conversation()`, returns `true` when allowed, and otherwise adds an error message mentioning the command, drains pending submission state, and returns `false`.

**Call relations**: This guard is called at the start of both `ChatWidget::dispatch_command` and `ChatWidget::dispatch_command_with_args` so side-conversation restrictions apply uniformly to bare and inline slash commands.

*Call graph*: calls 1 internal fn (available_in_side_conversation); called by 2 (dispatch_command, dispatch_command_with_args); 1 external calls (format!).


##### `ChatWidget::ensure_side_command_allowed_outside_review`  (lines 1128–1139)

```
fn ensure_side_command_allowed_outside_review(&mut self, cmd: SlashCommand) -> bool
```

**Purpose**: Rejects `/side` and `/btw` while code review mode is active, since side conversations are unavailable during review. Other commands pass through unchanged.

**Data flow**: It takes a `SlashCommand`, returns `true` unless the command is `Side` or `Btw` and `self.review.is_review_mode` is true. In the blocked case it adds an error message, drains pending submission state, and returns `false`.

**Call relations**: This guard is called by both `ChatWidget::dispatch_command` and `ChatWidget::dispatch_command_with_args` immediately after the side-conversation availability check.

*Call graph*: calls 1 internal fn (command); called by 2 (dispatch_command, dispatch_command_with_args); 2 external calls (format!, matches!).


### Protocol-driven updates
Maps backend notifications and requests into concrete chat-widget lifecycle, approval, and shutdown UI behavior.

### `tui/src/chatwidget/protocol.rs`

`orchestration` · `request handling`

This file is the notification-side protocol adapter for `ChatWidget`. Its central method, `handle_server_notification`, first rejects misrouted `McpServerStatusUpdated` events when the embedded thread id does not match the widget’s current thread, specifically to avoid shared notification handling mutating the wrong parent widget. It then derives replay-related flags (`from_replay`, `is_resume_initial_replay`) and retry-error state so it can suppress live-only effects during replay and preserve retry headers while a retryable error is active.

The large `match` translates each `ServerNotification` variant into a focused widget callback: token usage becomes `set_token_info`, thread metadata updates call thread-specific handlers, turn lifecycle notifications update `turn_lifecycle.last_turn_id`, clear `last_non_retry_error`, and invoke task start/completion flows, and item notifications are split into started/completed paths. Streaming deltas for agent text, plans, reasoning, terminal I/O, command output, patch output, and turn diffs are forwarded immediately. Several protocol enums are normalized into UI enums, notably turn-plan step statuses.

Error handling is careful: retryable errors only surface as stream errors for live traffic, while non-retry errors are memoized in `last_non_retry_error` so a later failed `TurnCompleted` echo does not duplicate the same failure UI. `handle_turn_completed_notification` also resets user-message dedupe state at turn end and distinguishes completed, interrupted, failed, and still-in-progress turns. Item-start handling intentionally triggers only side-effect-safe beginnings, and item completion delegates to the replay-aware thread-item renderer.

#### Function details

##### `ChatWidget::handle_server_notification`  (lines 4–227)

```
fn handle_server_notification(
        &mut self,
        notification: ServerNotification,
        replay_kind: Option<ReplayKind>,
    )
```

**Purpose**: Consumes one `ServerNotification` and routes it to the exact `ChatWidget` update path for that notification type, while filtering replay-only and thread-mismatch cases. It also maintains turn/error bookkeeping that later completion handlers rely on.

**Data flow**: Inputs are `&mut self`, a `ServerNotification`, and an optional `ReplayKind`. It reads widget state such as the current thread id, config flags, retry header state, `turn_lifecycle`, and `last_non_retry_error`; computes replay/error booleans; may early-return on mismatched MCP child-thread updates; then pattern-matches the notification into concrete UI callbacks and state mutations. Outputs are mutations to widget state and downstream UI/event side effects such as redraw requests, warnings, review prompts, shutdown, token info updates, and history entries via delegated methods.

**Call relations**: This is the top-level notification entry for chat protocol traffic. When a turn or item lifecycle event arrives, it delegates to `ChatWidget::handle_turn_completed_notification`, `ChatWidget::handle_item_started_notification`, or `ChatWidget::handle_item_completed_notification` so those narrower routines can apply turn-end dedupe and replay-aware item rendering. It also invokes `ThreadId::from_string` to validate thread-name updates and logs invalid ids instead of poisoning widget state.

*Call graph*: calls 4 internal fn (from_string, handle_item_completed_notification, handle_item_started_notification, handle_turn_completed_notification); 2 external calls (matches!, warn!).


##### `ChatWidget::handle_turn_completed_notification`  (lines 229–277)

```
fn handle_turn_completed_notification(
        &mut self,
        notification: TurnCompletedNotification,
        replay_kind: Option<ReplayKind>,
    )
```

**Purpose**: Finalizes UI state for a completed turn based on the server-reported `TurnStatus`, including success, interruption, and failure paths. It also clears prompt-echo dedupe so future identical user messages are rendered normally.

**Data flow**: Inputs are `&mut self`, a `TurnCompletedNotification`, and optional `ReplayKind`. It clears `last_rendered_user_message_display`, reads `notification.turn.status`, `notification.turn.duration_ms`, `notification.turn.error`, and `turn_lifecycle` budget-limit markers, then updates `last_non_retry_error` and invokes completion/interruption/error-finalization methods accordingly. It returns no value; effects are state cleanup, redraw/finalization calls, and possibly queue advancement after errorless failed turns.

**Call relations**: It is invoked only from `ChatWidget::handle_server_notification` when a `TurnCompleted` notification arrives, and also indirectly during replay because replay synthesizes a `TurnCompletedNotification` and routes it through the same path. Its duplicate-error suppression depends on `handle_server_notification` having stored `last_non_retry_error` when the non-retry `Error` notification arrived earlier.

*Call graph*: called by 1 (handle_server_notification).


##### `ChatWidget::handle_item_started_notification`  (lines 279–323)

```
fn handle_item_started_notification(
        &mut self,
        notification: ItemStartedNotification,
        from_replay: bool,
    )
```

**Purpose**: Processes `ItemStartedNotification` variants that should create immediate in-progress UI affordances, such as command execution, patch application, web search, image generation, collaboration calls, and review mode entry. It intentionally ignores item kinds that have no start-time surface.

**Data flow**: Inputs are `&mut self`, an `ItemStartedNotification`, and a `from_replay` flag. It reads `notification.item`, destructures specific `ThreadItem` variants, transforms file-change `changes` through `file_update_changes_to_display`, and forwards reconstructed or borrowed items into start handlers. It returns nothing and mutates transcript/review state through delegated widget methods.

**Call relations**: This function is called by `ChatWidget::handle_server_notification` for `ServerNotification::ItemStarted`. The caller passes `replay_kind.is_some()` so this routine can suppress live-only review-mode entry when the item came from replay, while still allowing other start markers to be rendered.

*Call graph*: called by 1 (handle_server_notification).


##### `ChatWidget::handle_item_completed_notification`  (lines 325–335)

```
fn handle_item_completed_notification(
        &mut self,
        notification: ItemCompletedNotification,
        replay_kind: Option<ReplayKind>,
    )
```

**Purpose**: Converts an item-completed protocol event into the unified thread-item rendering path with the correct live-vs-replay source tag. It is the thin bridge from protocol completion events to transcript rendering.

**Data flow**: Inputs are `&mut self`, an `ItemCompletedNotification`, and optional `ReplayKind`. It extracts `notification.item` and `notification.turn_id`, maps the replay flag into `ThreadItemRenderSource::Live` or `ThreadItemRenderSource::Replay`, and passes all three values to `handle_thread_item`. It returns no value; the resulting transcript/history mutations happen in the delegated renderer.

**Call relations**: It is called by `ChatWidget::handle_server_notification` for `ServerNotification::ItemCompleted`. Rather than duplicating item-specific completion logic here, it funnels all completed items through the same replay-aware rendering path used by explicit replay code.

*Call graph*: called by 1 (handle_server_notification).


### `tui/src/chatwidget/protocol_requests.rs`

`orchestration` · `request handling`

This module handles protocol messages that require user interaction or one-off UI reactions rather than transcript streaming. `handle_server_request` extracts a stable request id string and matches each `ServerRequest` variant into the corresponding widget flow: command execution approvals are localized with a fallback cwd from `self.config.cwd`, patch approvals are converted and shown, MCP elicitation requests are forwarded directly, permission approvals are localized through `request_permissions_from_params`, and tool-input requests open the user-input path. Unsupported request types that the TUI does not implement emit a stub error only for live traffic, not replay.

The file also contains several small adapters for adjacent protocol surfaces. `handle_skills_list_response` simply forwards a skills-list response into the widget’s skills UI. `on_guardian_review_notification` is more substantial: it converts app-server guardian review structures into the TUI’s `GuardianAssessmentEvent`, including path-localization via `try_into`, optional completion timestamps, status mapping, risk-level mapping, user-authorization mapping, and decision-source mapping. Localization failures are surfaced as user-visible error messages and abort processing.

The remaining methods are narrow UI hooks: shutdown completion requests immediate exit, turn diffs are logged and cause a status-line refresh, deprecation notices are appended to transcript history and redrawn, and patch-apply output deltas are currently a no-op placeholder.

#### Function details

##### `ChatWidget::handle_server_request`  (lines 9–57)

```
fn handle_server_request(
        &mut self,
        request: ServerRequest,
        replay_kind: Option<ReplayKind>,
    )
```

**Purpose**: Routes a single `ServerRequest` into the matching approval or input UI flow, using the request id as the interaction key. It also emits a stub message for unsupported live-only request types.

**Data flow**: Inputs are `&mut self`, a `ServerRequest`, and optional `ReplayKind`. It reads the request id via `request.id()`, reads config cwd for command-approval fallback localization, converts protocol params into widget events where needed, and either invokes the corresponding request handler or appends an error message. It returns no value; outputs are widget state/UI changes through delegated methods.

**Call relations**: This is the request dispatcher for chat protocol traffic. For supported variants it delegates into specialized widget handlers such as approval, elicitation, permissions, and user-input flows; for unsupported variants it only surfaces `TUI_STUB_MESSAGE` when the request is live, avoiding replay noise.

*Call graph*: 2 external calls (id, format!).


##### `ChatWidget::handle_skills_list_response`  (lines 59–61)

```
fn handle_skills_list_response(&mut self, response: SkillsListResponse)
```

**Purpose**: Forwards a `SkillsListResponse` into the widget’s skills rendering/update path. It exists as a narrow protocol adapter rather than adding response-specific logic inline elsewhere.

**Data flow**: It takes `&mut self` and a `SkillsListResponse`, passes the response unchanged to `on_list_skills`, and returns nothing. All state mutation occurs in the delegated handler.

**Call relations**: This function is a simple bridge from protocol response handling into the widget’s skills UI flow.


##### `ChatWidget::on_patch_apply_output_delta`  (lines 63–63)

```
fn on_patch_apply_output_delta(&mut self, _item_id: String, _delta: String)
```

**Purpose**: Placeholder hook for patch-apply output streaming. The current implementation intentionally ignores both item id and delta.

**Data flow**: It accepts `&mut self`, an `_item_id: String`, and a `_delta: String`, performs no reads or writes, and returns unit.

**Call relations**: It is called from notification dispatch when `FileChangeOutputDelta` arrives, but currently acts as a stub so the protocol surface is wired without rendering behavior yet.


##### `ChatWidget::on_guardian_review_notification`  (lines 65–153)

```
fn on_guardian_review_notification(
        &mut self,
        id: String,
        turn_id: String,
        started_at_ms: i64,
        review: codex_app_server_protocol::GuardianApprovalReview,
```

**Purpose**: Converts app-server guardian review start/completion notifications into a normalized `GuardianAssessmentEvent` for the TUI. It performs enum translation, optional completion shaping, and path-localization validation before emitting the assessment.

**Data flow**: Inputs are `&mut self`, review identifiers/timestamps, an app-server `GuardianApprovalReview`, optional completion tuple, and a `GuardianApprovalReviewAction`. It first attempts `try_into()` on the action; on failure it writes an error message and returns early. Otherwise it expands the optional completion into `(completed_at_ms, decision_source)` options, maps app-server status/risk/user-authorization/decision-source enums into local protocol enums, constructs a `GuardianAssessmentEvent`, and passes it to `on_guardian_assessment`.

**Call relations**: This method is reached from notification dispatch for both guardian-review-started and guardian-review-completed notifications. The caller supplies `completion` as `None` or `Some(...)`, and this function centralizes the shared conversion logic so both notification variants produce the same downstream assessment event shape.

*Call graph*: 2 external calls (try_into, format!).


##### `ChatWidget::on_shutdown_complete`  (lines 155–157)

```
fn on_shutdown_complete(&mut self)
```

**Purpose**: Triggers immediate application exit once the server reports the thread/session has closed. It is the UI-side completion hook for shutdown.

**Data flow**: It takes `&mut self`, calls `request_immediate_exit`, and returns unit. The only output is the widget/application exit request state.

**Call relations**: Notification dispatch invokes this only for live `ThreadClosed` events; replayed closures are intentionally ignored so historical sessions do not terminate the UI.


##### `ChatWidget::on_turn_diff`  (lines 159–162)

```
fn on_turn_diff(&mut self, unified_diff: String)
```

**Purpose**: Records receipt of a turn diff for diagnostics and refreshes the status line. It does not currently render the diff body into transcript history.

**Data flow**: It accepts `&mut self` and a `unified_diff: String`, logs the diff with `debug!`, refreshes the status line, and returns unit. No persistent transcript state is changed here.

**Call relations**: It is called from notification dispatch when `TurnDiffUpdated` arrives, serving as the current UI hook for that protocol event.

*Call graph*: 1 external calls (debug!).


##### `ChatWidget::on_deprecation_notice`  (lines 164–167)

```
fn on_deprecation_notice(&mut self, summary: String, details: Option<String>)
```

**Purpose**: Adds a deprecation notice cell to transcript history and schedules a redraw so the warning becomes visible immediately. It is the user-facing surface for server deprecation notices.

**Data flow**: Inputs are `&mut self`, a `summary: String`, and optional `details: Option<String>`. It builds a history cell with `history_cell::new_deprecation_notice`, appends it to history, requests redraw, and returns unit.

**Call relations**: Notification dispatch calls this for `DeprecationNotice` events. It encapsulates the exact history-cell construction so the dispatcher only needs to forward summary/details.

*Call graph*: 1 external calls (new_deprecation_notice).


### Selection and action popups
Builds the popup flows for models, reviews, plans, and connector browsing that let users choose follow-up actions.

### `tui/src/chatwidget/connectors.rs`

`domain_logic` · `request handling`

This file encapsulates the connectors/apps subsystem inside `ChatWidget`. It defines `ConnectorsCacheState` with explicit `Uninitialized`, `Loading`, `Ready(ConnectorsSnapshot)`, and `Failed(String)` states, plus `ConnectorsState`, which adds `partial_snapshot`, `prefetch_in_flight`, and `force_refetch_pending` flags. Together these fields let the widget prefetch connector metadata, show partial installed-app results while a full fetch is still running, and queue a forced refetch if a second request arrives during an in-flight load.

The public entrypoints are `refresh_connectors`, `prefetch_connectors`, `connectors_for_mentions`, `add_connectors_output`, `on_connectors_loaded`, and `update_connector_enabled`. Refresh requests are funneled through `queue_connectors_refresh` and `begin_connectors_refresh`, which gate on feature/account availability and suppress duplicate fetches. UI rendering is split between a loading popup and a searchable connectors popup built from `SelectionViewParams`; each `SelectionItem` includes labels, descriptions, search text, and an action closure that either opens an app-management link or inserts an informational history cell when no link exists.

When results arrive, the file merges `is_enabled` flags from the previous ready snapshot into the new snapshot, updates the bottom pane's connectors snapshot, refreshes any open popup while preserving selection, and falls back gracefully on errors: keep the old ready snapshot if possible, otherwise promote a partial snapshot, otherwise mark the cache failed.

#### Function details

##### `ChatWidget::refresh_connectors`  (lines 24–26)

```
fn refresh_connectors(&mut self, force_refetch: bool)
```

**Purpose**: Starts a connectors refresh request, optionally forcing a refetch from the source rather than relying on cached data. It is the explicit user-facing refresh entrypoint.

**Data flow**: Takes a `force_refetch` boolean and forwards it unchanged to `self.queue_connectors_refresh(force_refetch)`. It does not directly mutate state beyond whatever the delegated refresh path changes.

**Call relations**: This is a thin wrapper used when callers want an explicit refresh. All actual gating, state mutation, and event emission happen in `ChatWidget::queue_connectors_refresh` and `ChatWidget::begin_connectors_refresh`.

*Call graph*: calls 1 internal fn (queue_connectors_refresh).


##### `ChatWidget::prefetch_connectors`  (lines 28–30)

```
fn prefetch_connectors(&mut self)
```

**Purpose**: Starts a non-forced background connectors fetch intended to warm the cache before the user opens the apps UI. It avoids stronger invalidation semantics.

**Data flow**: Calls `self.queue_connectors_refresh(false)`, relying on the shared refresh machinery to decide whether a fetch should actually be sent.

**Call relations**: This is the prefetch counterpart to `refresh_connectors`. It feeds into the same queueing path but always requests the non-forced mode.

*Call graph*: calls 1 internal fn (queue_connectors_refresh).


##### `ChatWidget::queue_connectors_refresh`  (lines 32–37)

```
fn queue_connectors_refresh(&mut self, force_refetch: bool)
```

**Purpose**: Centralizes the decision to emit a `FetchConnectorsList` app event. It only sends the event if refresh state transitions successfully into an in-flight fetch.

**Data flow**: Accepts `force_refetch`, calls `begin_connectors_refresh(force_refetch)`, and if that returns true sends `AppEvent::FetchConnectorsList { force_refetch }` through `self.app_event_tx`.

**Call relations**: This function is the shared dispatch point used by explicit refresh, prefetch, popup-opening logic, and deferred force-refetch retries after a prior load completes. It delegates all eligibility checks to `begin_connectors_refresh`.

*Call graph*: calls 1 internal fn (begin_connectors_refresh); called by 4 (add_connectors_output, on_connectors_loaded, prefetch_connectors, refresh_connectors).


##### `ChatWidget::begin_connectors_refresh`  (lines 39–55)

```
fn begin_connectors_refresh(&mut self, force_refetch: bool) -> bool
```

**Purpose**: Transitions connector refresh state into an in-flight fetch when allowed, while coalescing overlapping requests. It also records a pending forced refetch if a stronger request arrives during an existing fetch.

**Data flow**: Reads `self.connectors_enabled()` and returns false immediately if apps are unavailable. If `self.connectors.prefetch_in_flight` is already true, it sets `self.connectors.force_refetch_pending = true` when `force_refetch` is requested and returns false. Otherwise it sets `prefetch_in_flight = true`, changes `self.connectors.cache` to `Loading` unless it is already `Ready(_)`, and returns true.

**Call relations**: Called only by `queue_connectors_refresh`. Its boolean return controls whether that caller emits a fetch event or merely records pending intent.

*Call graph*: calls 1 internal fn (connectors_enabled); called by 1 (queue_connectors_refresh); 1 external calls (matches!).


##### `ChatWidget::connectors_enabled`  (lines 57–59)

```
fn connectors_enabled(&self) -> bool
```

**Purpose**: Determines whether the connectors/apps feature should be exposed in the UI at all. It requires both the feature flag and a ChatGPT account.

**Data flow**: Reads `self.config.features.enabled(Feature::Apps)` and `self.has_chatgpt_account`, returning true only when both are true.

**Call relations**: This predicate gates refresh initiation, mention completion exposure, and the `/apps` output path. It is a pure capability check used throughout the connectors subsystem.

*Call graph*: called by 3 (add_connectors_output, begin_connectors_refresh, connectors_for_mentions).


##### `ChatWidget::connectors_for_mentions`  (lines 61–74)

```
fn connectors_for_mentions(&self) -> Option<&[AppInfo]>
```

**Purpose**: Returns the currently available connectors list for mention/autocomplete use, preferring a partial in-progress snapshot when present. It hides connectors entirely when the feature is disabled.

**Data flow**: Checks `connectors_enabled()` and returns `None` if false. If `self.connectors.partial_snapshot` exists, returns a slice of its `connectors`; otherwise matches `self.connectors.cache` and returns the ready snapshot's connector slice or `None` for loading/uninitialized/failed states.

**Call relations**: This is a read-only accessor used by mention-related UI. It intentionally prefers partial data so autocomplete can work before the final full snapshot arrives.

*Call graph*: calls 1 internal fn (connectors_enabled).


##### `ChatWidget::add_connectors_output`  (lines 76–106)

```
fn add_connectors_output(&mut self)
```

**Purpose**: Responds to the user requesting apps output by refreshing connector data if needed and opening the appropriate UI: info message, loading popup, connectors popup, or error history cell. It also decides when to force a refetch based on current cache state.

**Data flow**: First checks `connectors_enabled()`; if false, inserts an info message explaining that apps are disabled and returns. Otherwise it clones `self.connectors.cache`, computes `should_force_refetch` as true when no fetch is in flight or the cache is already ready, and calls `queue_connectors_refresh(should_force_refetch)`. It then matches the cloned cache: `Ready(snapshot)` opens a popup or emits a 'No apps available' info message if empty; `Failed(err)` inserts an error history cell; `Loading` or `Uninitialized` opens the loading popup. Finally it requests redraw.

**Call relations**: This is the main user-facing apps command handler. It delegates popup construction to `open_connectors_loading_popup` or `open_connectors_popup` and uses the shared refresh queue to ensure data is being fetched in parallel with whatever UI it shows.

*Call graph*: calls 4 internal fn (connectors_enabled, open_connectors_loading_popup, open_connectors_popup, queue_connectors_refresh); 2 external calls (new_error_event, matches!).


##### `ChatWidget::open_connectors_loading_popup`  (lines 108–116)

```
fn open_connectors_loading_popup(&mut self)
```

**Purpose**: Shows or refreshes the loading-state selection popup for connectors. It prefers replacing an already-open connectors popup rather than stacking a new view.

**Data flow**: Builds popup parameters via `self.connectors_loading_popup_params()`. It first tries `self.bottom_pane.replace_selection_view_if_active(CONNECTORS_SELECTION_VIEW_ID, ...)`; if that returns false, it calls `show_selection_view(...)` with the same params.

**Call relations**: Used from `add_connectors_output` when connector data is not yet ready. It is the loading-state counterpart to `open_connectors_popup`.

*Call graph*: calls 1 internal fn (connectors_loading_popup_params); called by 1 (add_connectors_output).


##### `ChatWidget::open_connectors_popup`  (lines 118–122)

```
fn open_connectors_popup(&mut self, connectors: &[AppInfo])
```

**Purpose**: Displays the searchable connectors/apps selection popup populated with the provided connector list. It always opens with no preselected connector id.

**Data flow**: Accepts a slice of `AppInfo` and passes `self.connectors_popup_params(connectors, None)` into `self.bottom_pane.show_selection_view(...)`.

**Call relations**: Called from `add_connectors_output` once a ready snapshot exists. The detailed item construction is delegated to `connectors_popup_params`.

*Call graph*: calls 1 internal fn (connectors_popup_params); called by 1 (add_connectors_output).


##### `ChatWidget::connectors_loading_popup_params`  (lines 124–140)

```
fn connectors_loading_popup_params(&self) -> SelectionViewParams
```

**Purpose**: Constructs the `SelectionViewParams` for the temporary loading popup shown while the connectors list is being fetched. The popup contains a static header and one disabled placeholder row.

**Data flow**: Creates a `ColumnRenderable` header with bold 'Apps' and a dim loading subtitle, then returns `SelectionViewParams` with `view_id` set to `CONNECTORS_SELECTION_VIEW_ID`, that header boxed, and a single disabled `SelectionItem` named 'Loading apps...' with explanatory description. Remaining fields use defaults.

**Call relations**: This helper is used only by `open_connectors_loading_popup`. It isolates the exact popup shape for the loading state.

*Call graph*: calls 1 internal fn (new); called by 1 (open_connectors_loading_popup); 4 external calls (new, default, from, vec!).


##### `ChatWidget::connectors_popup_params`  (lines 142–239)

```
fn connectors_popup_params(
        &self,
        connectors: &[AppInfo],
        selected_connector_id: Option<&str>,
    ) -> SelectionViewParams
```

**Purpose**: Builds the full searchable connectors selection model, including header statistics, preserved selection, per-app descriptions, and action closures for opening install/manage links or reporting missing links. It is the core UI formatter for the apps browser.

**Data flow**: Takes a connector slice and optional selected connector id. It computes total and installed counts, builds a multi-line header, derives `initial_selected_idx` by matching the selected id, and then iterates over each `AppInfo`. For each connector it computes display label, title, long and brief descriptions, status label, and search text; creates a `SelectionItem`; and attaches an action closure. If `install_url` exists, the closure sends `AppEvent::OpenAppLink` with app metadata and install/manage instructions. Otherwise the closure sends `AppEvent::InsertHistoryCell` containing an info event that the app link is unavailable. It marks items dismiss-on-select and sets selected descriptions accordingly. Finally it returns `SelectionViewParams` with search enabled, footer hint from the bottom pane, auto column width, and the computed initial selection.

**Call relations**: This helper is used both when first opening the connectors popup and when refreshing an already-open popup after data changes. It depends on the local description/status helpers to keep item text consistent.

*Call graph*: calls 2 internal fn (connector_display_label, new); called by 2 (open_connectors_popup, refresh_connectors_popup_if_open); 11 external calls (new, default, from, connector_brief_description, connector_description, connector_status_label, with_capacity, iter, len, format! (+1 more)).


##### `ChatWidget::refresh_connectors_popup_if_open`  (lines 241–259)

```
fn refresh_connectors_popup_if_open(&mut self, connectors: &[AppInfo])
```

**Purpose**: Rebuilds the connectors popup in place if that popup is currently active, preserving the user's selected connector when possible. It avoids opening a popup when none is visible.

**Data flow**: Reads the selected index for the active connectors view from `self.bottom_pane`. If there is a selected index and the cache is `Ready(snapshot)`, it maps that index back to the previously selected connector id from the old snapshot; otherwise selected id is `None`. It then calls `replace_selection_view_if_active` with fresh params from `connectors_popup_params(connectors, selected_connector_id)` and ignores the boolean result.

**Call relations**: This is used after connector data loads and after a connector's enabled flag changes. It keeps the popup synchronized with cache updates without disrupting the current browsing context.

*Call graph*: calls 1 internal fn (connectors_popup_params); called by 2 (on_connectors_loaded, update_connector_enabled).


##### `ChatWidget::connector_brief_description`  (lines 261–267)

```
fn connector_brief_description(connector: &AppInfo) -> String
```

**Purpose**: Formats the short one-line description shown in the connectors popup by combining status and optional connector description text. It ensures every item has at least a status label.

**Data flow**: Accepts an `AppInfo`, computes `status_label` via `connector_status_label`, then calls `connector_description`. If a description exists, returns `"{status} · {description}"`; otherwise returns the status label alone as an owned `String`.

**Call relations**: Used during popup item construction inside `connectors_popup_params`. It is a presentation helper layered on top of the lower-level status and description extractors.

*Call graph*: 3 external calls (connector_description, connector_status_label, format!).


##### `ChatWidget::connector_status_label`  (lines 269–279)

```
fn connector_status_label(connector: &AppInfo) -> &'static str
```

**Purpose**: Maps connector accessibility and enabled state into the exact status text shown in the popup. It distinguishes installed-enabled, installed-disabled, and not-yet-installed connectors.

**Data flow**: Reads `connector.is_accessible` and `connector.is_enabled`, returning one of three static strings: `Installed`, `Installed · Disabled`, or `Can be installed`.

**Call relations**: This pure formatter is used by both `connector_brief_description` and `connectors_popup_params` so status wording stays consistent across item body and selected-description text.


##### `ChatWidget::connector_description`  (lines 281–288)

```
fn connector_description(connector: &AppInfo) -> Option<String>
```

**Purpose**: Extracts a cleaned optional description from connector metadata. It trims whitespace and suppresses empty descriptions.

**Data flow**: Reads `connector.description`, converts the `Option<String>` to `Option<&str>`, trims it, filters out empty strings, and returns an owned `Option<String>`.

**Call relations**: Used by popup formatting helpers to avoid displaying blank or whitespace-only descriptions.


##### `ChatWidget::on_connectors_loaded`  (lines 290–350)

```
fn on_connectors_loaded(
        &mut self,
        result: Result<ConnectorsSnapshot, String>,
        is_final: bool,
    )
```

**Purpose**: Consumes connector fetch results, updates cache and bottom-pane snapshots, refreshes any open popup, and handles partial/fallback/error cases. It also triggers a queued forced refetch after the current fetch finishes when necessary.

**Data flow**: Takes `result` and `is_final`. If `is_final`, it clears `prefetch_in_flight` and, when `force_refetch_pending` was set, clears that flag and remembers to trigger another refresh afterward. On `Ok(mut snapshot)`, it preserves `is_enabled` values from any existing ready snapshot by id, then either stores the snapshot as `partial_snapshot` (non-final) or clears partial state, refreshes an open popup, and writes `self.connectors.cache = Ready(snapshot.clone())` (final). In both success cases it updates `self.bottom_pane.set_connectors_snapshot(Some(snapshot))`. On `Err(err)`, it first takes any partial snapshot. If a ready snapshot already exists, it logs a warning and keeps that snapshot in the bottom pane. Else if a partial snapshot exists, it warns, refreshes the popup with partial connectors, promotes that partial snapshot to `Ready`, and updates the bottom pane. Otherwise it stores `ConnectorsCacheState::Failed(err)` and clears the bottom-pane snapshot. At the end, if a pending forced refetch was deferred, it calls `queue_connectors_refresh(true)`.

**Call relations**: This is the result handler for `FetchConnectorsList`. It is the only place that transitions connector cache state based on backend responses and the only place that consumes `force_refetch_pending`.

*Call graph*: calls 2 internal fn (queue_connectors_refresh, refresh_connectors_popup_if_open); 3 external calls (Failed, Ready, warn!).


##### `ChatWidget::update_connector_enabled`  (lines 352–373)

```
fn update_connector_enabled(&mut self, connector_id: &str, enabled: bool)
```

**Purpose**: Applies a local enabled/disabled toggle to a connector already present in the ready cache and propagates the change to both popup UI and bottom-pane snapshot. It is a no-op when the cache is not ready or the value is unchanged.

**Data flow**: Clones the current ready snapshot from `self.connectors.cache`; if the cache is not `Ready`, returns. It scans `snapshot.connectors` for the matching `connector_id`, updates `is_enabled`, and tracks whether anything changed. If unchanged, returns. Otherwise it refreshes any open popup with the updated connector list, writes the modified snapshot back into `self.connectors.cache = Ready(snapshot.clone())`, and calls `self.bottom_pane.set_connectors_snapshot(Some(snapshot))`.

**Call relations**: This method is used when connector enablement changes independently of a full reload. It reuses `refresh_connectors_popup_if_open` to keep the visible popup synchronized with the cache mutation.

*Call graph*: calls 1 internal fn (refresh_connectors_popup_if_open); 1 external calls (Ready).


### `tui/src/chatwidget/model_popups.rs`

`orchestration` · `interactive popup handling during command/input flows`

This file contains the UI decision tree for choosing models and reasoning levels. It starts with `open_model_popup`, which blocks selection until session startup is complete and gracefully handles a temporarily unavailable model catalog. The popup flow is intentionally split: quick “auto” presets are shown first, while non-auto presets are routed into a fuller picker and then, if needed, a reasoning-effort picker.

`open_model_popup_with_presets` filters out presets hidden from the picker, identifies the current model label, partitions presets into auto and non-auto groups, sorts auto presets with a fixed preference order, and creates `SelectionItem`s whose actions either immediately update/persist model settings or redirect into a Plan-mode scope prompt. If no auto presets exist, it jumps straight to `open_all_models_popup`.

The Plan-mode logic is subtle. `should_prompt_plan_mode_reasoning_scope` only prompts when collaboration modes are enabled, the active mode is `Plan`, the selected model matches the current model, and the chosen effort would change either the effective Plan-mode reasoning or the stored defaults. `open_plan_reasoning_scope_prompt` then offers two concrete write paths: update only the Plan override, or update both global defaults and the Plan override.

`open_reasoning_popup` handles models with one or many supported reasoning efforts, computes default/highlighted choices differently depending on whether the model is current and whether Plan mode is active, and adds rate-limit warnings for high-effort GPT-5.x Codex models. The helper label functions normalize enum values into display text, while `apply_model_and_effort` and its non-persisting variant send the exact `AppEvent`s that mutate runtime state and saved configuration.

#### Function details

##### `ChatWidget::open_model_popup`  (lines 11–31)

```
fn open_model_popup(&mut self)
```

**Purpose**: Starts model selection by validating that the session is ready, fetching the current model catalog, and opening the quick model picker.

**Data flow**: It reads session readiness via `is_session_configured()` and the model catalog via `self.model_catalog.try_list_models()`. On failure paths it writes informational history/messages to the widget; on success it passes the fetched `Vec<ModelPreset>` to `open_model_popup_with_presets` and returns no value.

**Call relations**: This is the top-level entry for `/model`-style interaction. It delegates all actual popup construction to `ChatWidget::open_model_popup_with_presets`, but short-circuits first when startup is incomplete or the catalog is mid-refresh.

*Call graph*: calls 1 internal fn (open_model_popup_with_presets).


##### `ChatWidget::model_menu_header`  (lines 33–43)

```
fn model_menu_header(&self, title: &str, subtitle: &str) -> Box<dyn Renderable>
```

**Purpose**: Constructs a reusable popup header with a bold title, dim subtitle, and an optional warning line about unsupported custom OpenAI base URLs.

**Data flow**: It takes `title` and `subtitle` string slices, clones them into owned `String`s, builds a `ColumnRenderable`, pushes formatted `Line`s, optionally appends the result of `model_menu_warning_line`, and returns the header boxed as `Box<dyn Renderable>`.

**Call relations**: This helper is used by both `ChatWidget::open_model_popup_with_presets` and `ChatWidget::open_all_models_popup` so the quick picker and full picker share the same warning and visual structure.

*Call graph*: calls 2 internal fn (model_menu_warning_line, new); called by 2 (open_all_models_popup, open_model_popup_with_presets); 2 external calls (new, from).


##### `ChatWidget::model_menu_warning_line`  (lines 45–51)

```
fn model_menu_warning_line(&self) -> Option<Line<'static>>
```

**Purpose**: Produces a red warning line when the widget is configured to use a non-default OpenAI base URL.

**Data flow**: It reads `custom_openai_base_url()`. If that returns a URL, it formats a warning string mentioning the override and wraps it in a red `Line<'static>`; otherwise it returns `None`.

**Call relations**: This is only called from `ChatWidget::model_menu_header`, where it conditionally augments model-selection headers with a compatibility warning.

*Call graph*: calls 1 internal fn (custom_openai_base_url); called by 1 (model_menu_header); 2 external calls (from, format!).


##### `ChatWidget::custom_openai_base_url`  (lines 53–70)

```
fn custom_openai_base_url(&self) -> Option<String>
```

**Purpose**: Determines whether the current model provider is OpenAI with a meaningful, non-default custom base URL that should be surfaced to the user.

**Data flow**: It reads `self.config.model_provider`, checks that the provider is OpenAI, extracts `base_url`, trims whitespace and trailing slashes, compares the normalized value against `DEFAULT_OPENAI_BASE_URL`, and returns `Some(trimmed.to_string())` only for non-empty, non-default overrides.

**Call relations**: This helper feeds `ChatWidget::model_menu_warning_line`; it encapsulates the normalization rules so popup code does not duplicate provider and URL checks.

*Call graph*: called by 1 (model_menu_warning_line).


##### `ChatWidget::open_model_popup_with_presets`  (lines 72–155)

```
fn open_model_popup_with_presets(&mut self, presets: Vec<ModelPreset>)
```

**Purpose**: Builds the first-stage model picker, emphasizing quick auto presets and optionally adding an “All models” row that opens the full model-and-effort picker.

**Data flow**: It consumes a `Vec<ModelPreset>`, filters out presets with `show_in_picker == false`, reads the current model and display name, partitions presets into auto and non-auto groups, sorts auto presets by `auto_model_order`, maps each auto preset into a `SelectionItem` with actions from `model_selection_actions`, and may append an “All models” item whose action sends `AppEvent::OpenAllModelsPopup`. It then builds a header with `model_menu_header` and writes the resulting `SelectionViewParams` into `self.bottom_pane`.

**Call relations**: This function is called by `ChatWidget::open_model_popup` after catalog retrieval. If there are no auto presets it delegates immediately to `ChatWidget::open_all_models_popup`; otherwise it becomes the main quick-selection surface.

*Call graph*: calls 2 internal fn (model_menu_header, open_all_models_popup); called by 1 (open_model_popup); 3 external calls (default, format!, vec!).


##### `ChatWidget::is_auto_model`  (lines 157–159)

```
fn is_auto_model(model: &str) -> bool
```

**Purpose**: Classifies model IDs that belong to the quick auto-mode family.

**Data flow**: It takes a model string slice and returns `true` when it starts with the literal prefix `codex-auto-`; it reads no widget state and writes nothing.

**Call relations**: This pure helper is used while partitioning presets in `ChatWidget::open_model_popup_with_presets`.


##### `ChatWidget::auto_model_order`  (lines 161–168)

```
fn auto_model_order(model: &str) -> usize
```

**Purpose**: Assigns a stable display order to known auto models so the quick picker shows fast, balanced, and thorough in a predictable sequence.

**Data flow**: It matches the input model string and returns `0` for `codex-auto-fast`, `1` for `codex-auto-balanced`, `2` for `codex-auto-thorough`, and `3` for any other auto model.

**Call relations**: This helper is used by `ChatWidget::open_model_popup_with_presets` when sorting auto presets before rendering them.


##### `ChatWidget::open_all_models_popup`  (lines 170–214)

```
fn open_all_models_popup(&mut self, presets: Vec<ModelPreset>)
```

**Purpose**: Shows the full model picker for non-auto presets, with each row opening a second-stage reasoning-effort popup.

**Data flow**: It consumes a `Vec<ModelPreset>`. If empty, it writes an informational message and returns. Otherwise it iterates presets, derives descriptions and current/default flags, computes whether each preset supports only one reasoning effort, creates `SelectionItem`s whose actions send `AppEvent::OpenReasoningPopup { model: preset }`, and writes a `SelectionViewParams` with a shared header into `self.bottom_pane`.

**Call relations**: This function is reached either directly from `ChatWidget::open_model_popup_with_presets` when no auto presets exist or via the “All models” action created there. It hands off per-model effort selection to `ChatWidget::open_reasoning_popup` through emitted app events.

*Call graph*: calls 1 internal fn (model_menu_header); called by 1 (open_model_popup_with_presets); 3 external calls (default, new, vec!).


##### `ChatWidget::model_selection_actions`  (lines 216–237)

```
fn model_selection_actions(
        model_for_action: String,
        effort_for_action: Option<ReasoningEffortConfig>,
        should_prompt_plan_mode_scope: bool,
    ) -> Vec<SelectionAction>
```

**Purpose**: Creates the action closure for a direct model selection row, either prompting for Plan-mode scope or immediately updating and persisting the chosen model/effort.

**Data flow**: It takes an owned model string, an optional `ReasoningEffortConfig`, and a boolean `should_prompt_plan_mode_scope`. It returns a one-element `Vec<SelectionAction>` whose closure sends either `AppEvent::OpenPlanReasoningScopePrompt` or the trio `UpdateModel`, `UpdateReasoningEffort`, and `PersistModelSelection`.

**Call relations**: This helper is used by `ChatWidget::open_model_popup_with_presets` to attach concrete behavior to quick auto-model rows.

*Call graph*: 1 external calls (vec!).


##### `ChatWidget::should_prompt_plan_mode_reasoning_scope`  (lines 239–257)

```
fn should_prompt_plan_mode_reasoning_scope(
        &self,
        selected_model: &str,
        selected_effort: Option<ReasoningEffortConfig>,
    ) -> bool
```

**Purpose**: Decides whether selecting a model/effort while in Plan mode should branch into a scope prompt instead of silently updating defaults.

**Data flow**: It reads collaboration-mode enablement, the active mode kind, the current model, the effective reasoning effort, and `self.current_collaboration_mode`’s model/effort. Given a selected model and optional effort, it returns `true` only when the selection is in Plan mode on the current model and would change either the active Plan-mode effective reasoning or the stored global/default Plan-mode settings.

**Call relations**: This predicate is consulted by `ChatWidget::open_model_popup_with_presets` and `ChatWidget::open_reasoning_popup` before wiring selection actions, ensuring Plan-mode changes are scoped explicitly only when needed.

*Call graph*: called by 1 (open_reasoning_popup).


##### `ChatWidget::open_plan_reasoning_scope_prompt`  (lines 259–348)

```
fn open_plan_reasoning_scope_prompt(
        &mut self,
        model: String,
        effort: Option<ReasoningEffortConfig>,
    )
```

**Purpose**: Shows a two-choice popup asking whether a selected reasoning level should apply only to Plan mode or to all modes plus the Plan override.

**Data flow**: It takes a selected model and optional effort, derives human-readable reasoning phrases and the current source of Plan-mode reasoning from config or built-in masks, builds two `SelectionItem`s with closures that send different combinations of `UpdateModel`, `UpdateReasoningEffort`, `UpdatePlanModeReasoningEffort`, `PersistPlanModeReasoningEffort`, and `PersistModelSelection`, writes the popup to `self.bottom_pane`, and emits a desktop `Notification::PlanModePrompt` via `notify`.

**Call relations**: This popup is opened when `ChatWidget::should_prompt_plan_mode_reasoning_scope` says a selection is not a no-op in Plan mode. It is reached from quick model actions or reasoning-popup actions through `AppEvent::OpenPlanReasoningScopePrompt`.

*Call graph*: calls 1 internal fn (plan_mask); 3 external calls (default, format!, vec!).


##### `ChatWidget::open_reasoning_popup`  (lines 351–498)

```
fn open_reasoning_popup(&mut self, preset: ModelPreset)
```

**Purpose**: Shows the second-stage picker for a model’s supported reasoning efforts, including defaults, current selection highlighting, and high-effort warnings for certain models.

**Data flow**: It consumes a `ModelPreset`, extracts its default effort and supported effort options, computes whether the widget is currently in Plan mode, derives a warning effort/text for `High` or `XHigh`, builds the list of selectable efforts (falling back to the default if none are listed), and either applies the single available effort immediately or constructs `SelectionItem`s for each effort. It reads current model/effective reasoning/config Plan override to choose highlighted and initially selected rows, and writes the resulting popup to `self.bottom_pane`; in the single-choice case it may send an app event for the Plan scope prompt or call `apply_model_and_effort` directly.

**Call relations**: This function is the second stage after `ChatWidget::open_all_models_popup`. It consults `ChatWidget::should_prompt_plan_mode_reasoning_scope` for each possible effort and delegates final application to `ChatWidget::apply_model_and_effort` when no extra prompt is needed.

*Call graph*: calls 3 internal fn (apply_model_and_effort, should_prompt_plan_mode_reasoning_scope, new); 7 external calls (new, default, from, reasoning_effort_label, new, format!, vec!).


##### `ChatWidget::reasoning_effort_label`  (lines 500–510)

```
fn reasoning_effort_label(effort: &ReasoningEffortConfig) -> String
```

**Purpose**: Converts a `ReasoningEffortConfig` enum value into the title-cased label shown in popup rows.

**Data flow**: It matches the enum and returns owned strings such as `None`, `Minimal`, `Low`, `Medium`, `High`, `Extra high`, or the raw custom value.

**Call relations**: This helper is used by `ChatWidget::open_reasoning_popup` and indirectly by sentence-label generation to keep effort naming consistent across popups.


##### `ChatWidget::reasoning_effort_sentence_label`  (lines 512–517)

```
fn reasoning_effort_sentence_label(effort: &ReasoningEffortConfig) -> String
```

**Purpose**: Converts a reasoning effort into a phrase-friendly lowercase label for explanatory sentences, preserving custom values verbatim.

**Data flow**: It matches `ReasoningEffortConfig::Custom` specially and otherwise lowercases the result of `reasoning_effort_label`, returning an owned `String`.

**Call relations**: This helper is used by `ChatWidget::open_plan_reasoning_scope_prompt` when composing explanatory text about where a reasoning choice will apply.

*Call graph*: 1 external calls (reasoning_effort_label).


##### `ChatWidget::apply_model_and_effort_without_persist`  (lines 519–527)

```
fn apply_model_and_effort_without_persist(
        &self,
        model: String,
        effort: Option<ReasoningEffortConfig>,
    )
```

**Purpose**: Applies a model and reasoning effort to the live session without saving them to persistent configuration.

**Data flow**: It takes an owned model string and optional effort and sends `AppEvent::UpdateModel(model)` followed by `AppEvent::UpdateReasoningEffort(effort)` on `self.app_event_tx`. It does not mutate widget fields directly and returns no value.

**Call relations**: This is the runtime-only half of model application. It is called by `ChatWidget::apply_model_and_effort`, which adds persistence on top.

*Call graph*: called by 1 (apply_model_and_effort); 2 external calls (UpdateModel, UpdateReasoningEffort).


##### `ChatWidget::apply_model_and_effort`  (lines 529–533)

```
fn apply_model_and_effort(&self, model: String, effort: Option<ReasoningEffortConfig>)
```

**Purpose**: Applies a model/effort immediately and also persists the selection as the new default.

**Data flow**: It takes an owned model string and optional effort, first delegates to `apply_model_and_effort_without_persist` to send live update events, then sends `AppEvent::PersistModelSelection { model, effort }` to save the choice.

**Call relations**: This helper is used by `ChatWidget::open_reasoning_popup` in the single-choice fast path when no Plan-mode scope prompt is required.

*Call graph*: calls 1 internal fn (apply_model_and_effort_without_persist); called by 1 (open_reasoning_popup).


### `tui/src/chatwidget/review_popups.rs`

`orchestration` · `request handling`

This file contains the UI surfaces for starting code review actions from the chat widget. `open_review_popup` creates the top-level preset menu with four choices: review against a base branch, review uncommitted changes, review a commit, or provide custom review instructions. Each `SelectionItem` carries closures that either send an `AppEvent` to open a child picker using the current cwd or directly invoke `tx.review(...)` for immediate review targets. The popup is shown in the bottom pane with the standard footer hint.

The two async picker methods populate searchable selection views from local git state. `show_review_branch_picker` awaits `local_git_branches(cwd)` and `current_branch_name(cwd)`, falling back to `"(detached HEAD)"` when needed, then builds items whose labels show `current -> target` and whose actions request `ReviewTarget::BaseBranch { branch }`. `show_review_commit_picker` awaits up to 100 recent commits, then builds searchable items keyed by subject and sha that request `ReviewTarget::Commit { sha, title }`.

`show_review_custom_prompt` opens a `CustomPromptView` instead of a selection list. Its submit closure trims the entered text, ignores empty submissions, and sends `ReviewTarget::Custom { instructions }` for non-empty input. A test-only helper mirrors the commit-picker construction using injected commit entries, allowing deterministic tests without shelling out to git.

#### Function details

##### `ChatWidget::open_review_popup`  (lines 6–61)

```
fn open_review_popup(&mut self)
```

**Purpose**: Shows the top-level review preset menu with branch-based, uncommitted, commit-based, and custom-instructions options. Each option is wired to the appropriate review action or child picker event.

**Data flow**: It takes `&mut self`, builds a `Vec<SelectionItem>` by reading `self.config.cwd` for picker-launching closures, attaches actions that send `AppEvent::OpenReviewBranchPicker`, `tx.review(ReviewTarget::UncommittedChanges)`, `AppEvent::OpenReviewCommitPicker`, or `AppEvent::OpenReviewCustomPrompt`, wraps them in `SelectionViewParams`, and writes the popup into `self.bottom_pane`.

**Call relations**: This is the entrypoint for review popup UX. Some selections complete immediately, while others open child flows later handled by `show_review_branch_picker`, `show_review_commit_picker`, or `show_review_custom_prompt`.

*Call graph*: 3 external calls (default, new, vec!).


##### `ChatWidget::show_review_branch_picker`  (lines 63–93)

```
async fn show_review_branch_picker(&mut self, cwd: &Path)
```

**Purpose**: Loads local git branches and presents them as a searchable base-branch picker for review. Each selection starts a review against the chosen branch.

**Data flow**: Inputs are `&mut self` and `cwd: &Path`. It asynchronously reads `branches = local_git_branches(cwd).await` and `current_branch_name(cwd).await`, defaulting detached HEAD text on failure, allocates a selection-item vector sized to the branch count, formats each item label as `current_branch -> branch`, stores the raw branch name as `search_value`, and shows the resulting searchable selection view in `bottom_pane`.

**Call relations**: This async picker is typically reached after the top-level review popup sends `AppEvent::OpenReviewBranchPicker`.

*Call graph*: 4 external calls (default, with_capacity, format!, vec!).


##### `ChatWidget::show_review_commit_picker`  (lines 95–126)

```
async fn show_review_commit_picker(&mut self, cwd: &Path)
```

**Purpose**: Loads recent commits and presents them as a searchable commit picker for review. Selecting an entry starts a review targeting that commit sha and subject.

**Data flow**: Inputs are `&mut self` and `cwd: &Path`. It asynchronously fetches `recent_commits(cwd, 100).await`, allocates a vector sized to the commit count, clones each entry’s subject and sha into a `SelectionItem` whose action sends `ReviewTarget::Commit { sha, title: Some(subject) }`, sets a combined `search_value` of subject plus sha, and shows the searchable selection view in `bottom_pane`.

**Call relations**: This async picker is typically reached after the top-level review popup sends `AppEvent::OpenReviewCommitPicker`.

*Call graph*: 4 external calls (default, with_capacity, format!, vec!).


##### `ChatWidget::show_review_custom_prompt`  (lines 128–146)

```
fn show_review_custom_prompt(&mut self)
```

**Purpose**: Opens a freeform prompt view for custom review instructions. Submitting non-empty text starts a custom review request.

**Data flow**: It takes `&mut self`, clones `self.app_event_tx`, constructs a `CustomPromptView` with title, prompt text, empty initial text, no context label, and a submit closure that trims the entered string and sends `tx.review(ReviewTarget::Custom { instructions: trimmed })` only when the trimmed text is non-empty. It then shows that view in `bottom_pane`.

**Call relations**: This method is the child flow behind the top-level popup’s custom-instructions option.

*Call graph*: calls 1 internal fn (new); 2 external calls (new, new).


##### `show_review_commit_picker_with_entries`  (lines 150–182)

```
fn show_review_commit_picker_with_entries(
    chat: &mut ChatWidget,
    entries: Vec<CommitLogEntry>,
)
```

**Purpose**: Test helper that builds the same commit-review picker UI from injected commit entries instead of querying git. It enables deterministic tests of picker contents and actions.

**Data flow**: Inputs are `chat: &mut ChatWidget` and `entries: Vec<CommitLogEntry>`. It allocates a vector sized to the entry count, clones each subject and sha into `SelectionItem`s with commit-review actions and searchable subject+sha values, then installs the same searchable commit selection view into `chat.bottom_pane`.

**Call relations**: This helper mirrors `ChatWidget::show_review_commit_picker` for tests, replacing the async git fetch with caller-provided data.

*Call graph*: 4 external calls (default, with_capacity, format!, vec!).


### `tui/src/chatwidget/plan_implementation.rs`

`orchestration` · `post-plan approval prompt`

This small file is a focused popup builder for the transition out of Plan mode after a plan has been approved. It defines the user-facing strings for the title, button labels, the canned implementation message, and the long prefix used when the user chooses to clear context and carry the approved plan into a fresh thread.

The single function, `selection_view_params`, takes three pieces of state: an optional default collaboration-mode mask, optional approved plan markdown, and an optional usage label describing current context consumption. From those inputs it constructs two actionable rows and one passive cancel row. The “implement” row is enabled only when a default mode mask exists; its action sends `AppEvent::SubmitUserMessageWithMode` using the fixed message `Implement the plan.` and the provided default mask. The “clear context” row is stricter: it requires both a default mode and non-empty plan markdown, then sends `AppEvent::ClearUiAndSubmitUserMessage` with a prompt consisting of the fixed explanatory prefix followed by the approved plan text.

When prerequisites are missing, the corresponding row is disabled with explicit reasons (`Default mode unavailable` or `No approved plan available`). The optional usage label is folded only into the clear-context description, producing either a generic “Fresh thread with this plan.” or a more specific “Fresh thread. Context: …”. The function returns a fully populated `SelectionViewParams` with the standard popup hint line and no side effects.

#### Function details

##### `selection_view_params`  (lines 28–114)

```
fn selection_view_params(
    default_mask: Option<CollaborationModeMask>,
    plan_markdown: Option<&str>,
    clear_context_usage_label: Option<&str>,
) -> SelectionViewParams
```

**Purpose**: Constructs the selection-view model for the “Implement this plan?” prompt, including enabled/disabled actions and explanatory copy based on available default mode and approved plan text.

**Data flow**: It takes `default_mask: Option<CollaborationModeMask>`, `plan_markdown: Option<&str>`, and `clear_context_usage_label: Option<&str>`. It derives action vectors and disabled reasons for the implement and clear-context rows, formats the clear-context description with or without the usage label, and returns a `SelectionViewParams` containing three `SelectionItem`s: implement, clear context, and stay in Plan mode. The action closures send either `SubmitUserMessageWithMode` or `ClearUiAndSubmitUserMessage`.

**Call relations**: This pure builder is called by the Plan-mode prompt flow when the UI needs to present the post-approval decision. It does not perform the transition itself; instead it packages the exact actions that later selection handling will execute.

*Call graph*: calls 1 internal fn (standard_popup_hint_line); called by 2 (plan_implementation_clear_context_requires_default_mode_and_plan, open_plan_implementation_prompt); 4 external calls (default, new, format!, vec!).


### Usage and reasoning controls
Implements token and usage flows alongside quick controls for adjusting model reasoning effort.

### `tui/src/chatwidget/reasoning_shortcuts.rs`

`domain_logic` · `request handling`

This module isolates a small state machine for `Alt+,` / `Alt+.` style reasoning-effort shortcuts from the larger chat key dispatcher. `ReasoningShortcutDirection` captures whether the user wants to lower or raise effort and can generate a boundary message using the same sentence labels the rest of the widget uses.

`handle_reasoning_shortcut` is the main entry point. It first recognizes whether the incoming `KeyEvent` matches the configured increase/decrease bindings; unrecognized keys return `false` so normal input handling can continue. Even recognized shortcuts are ignored when a modal or popup owns focus. Once active, the method requires the session to be configured and the current model to exist in the model catalog; otherwise it emits an informational message and reports the key as handled. For supported models, it derives the ordered reasoning choices from the preset’s advertised efforts, anchors the current effort to either the effective effort, the preset default, or the first advertised choice, and computes the next effort with `next_reasoning_effort`.

If the user is already at the boundary, the method emits a direction-specific info message. Otherwise it applies the change differently by mode: in collaboration Plan mode it sends `AppEvent::UpdatePlanModeReasoningEffort`, while in normal mode it updates model/effort through the non-persisting application path. The helper functions are intentionally pure and tested for default anchoring, unsupported current values, custom ordering, bounds clamping, and single-option no-ops.

#### Function details

##### `ReasoningShortcutDirection::bound_message`  (lines 32–38)

```
fn bound_message(self, effort: &ReasoningEffortConfig) -> String
```

**Purpose**: Builds the informational message shown when the user tries to move past the lowest or highest supported reasoning level. The wording depends on direction and includes the human-readable effort label.

**Data flow**: It takes `self` and a borrowed `ReasoningEffortConfig`, converts the effort to a sentence label via `ChatWidget::reasoning_effort_sentence_label`, formats the lower- or upper-bound message string, and returns it.

**Call relations**: This helper is used by `ChatWidget::handle_reasoning_shortcut` when `next_reasoning_effort` reports there is no further step in the requested direction.

*Call graph*: 2 external calls (format!, reasoning_effort_sentence_label).


##### `ChatWidget::handle_reasoning_shortcut`  (lines 53–120)

```
fn handle_reasoning_shortcut(&mut self, key_event: KeyEvent) -> bool
```

**Purpose**: Recognizes reasoning-effort shortcut keys and applies the next lower or higher supported effort for the current model, respecting modal focus and Plan-mode scoping. It returns whether the key was consumed.

**Data flow**: Inputs are `&mut self` and a `KeyEvent`. It reads the configured key bindings, bottom-pane modal state, session-configuration state, current model string, current model preset, effective reasoning effort, collaboration-mode enablement, and active mode kind. It computes the direction, derives supported choices with `reasoning_choices`, anchors the current effort, computes the next effort with `next_reasoning_effort`, and either writes an info message, sends `AppEvent::UpdatePlanModeReasoningEffort(Some(next_effort))`, or calls `apply_model_and_effort_without_persist(current_model, Some(next_effort))`. It returns `true` for recognized shortcuts it handled and `false` for unrelated keys or when a popup/modal blocks shortcut handling.

**Call relations**: This method is the main shortcut entrypoint and delegates model lookup to `ChatWidget::current_model_preset`, choice extraction to `reasoning_choices`, and stepping logic to `next_reasoning_effort`. Its Plan-mode branch intentionally bypasses the broader scope-selection prompt used by settings popups.

*Call graph*: calls 3 internal fn (current_model_preset, next_reasoning_effort, reasoning_choices); 2 external calls (UpdatePlanModeReasoningEffort, format!).


##### `ChatWidget::current_model_preset`  (lines 122–129)

```
fn current_model_preset(&self) -> Option<ModelPreset>
```

**Purpose**: Finds the full `ModelPreset` for the widget’s currently selected model. It returns `None` if the model catalog cannot be listed or the current model is absent.

**Data flow**: It reads `self.current_model()`, queries `self.model_catalog.try_list_models()`, converts catalog failure into `None`, scans the presets for one whose `model` equals the current model, and returns that preset.

**Call relations**: It is called by `ChatWidget::handle_reasoning_shortcut` to determine whether reasoning shortcuts are supported and to obtain the preset’s default and advertised efforts.

*Call graph*: called by 1 (handle_reasoning_shortcut).


##### `reasoning_choices`  (lines 132–142)

```
fn reasoning_choices(preset: &ModelPreset) -> Vec<ReasoningEffortConfig>
```

**Purpose**: Extracts the ordered list of reasoning efforts a model advertises, falling back to the preset default when no explicit supported-efforts list exists. The returned order is preserved exactly.

**Data flow**: It takes a borrowed `ModelPreset`, maps `supported_reasoning_efforts` into a `Vec<ReasoningEffortConfig>`, pushes `default_reasoning_effort` if the list would otherwise be empty, and returns the vector.

**Call relations**: This pure helper is used by `ChatWidget::handle_reasoning_shortcut` before stepping through efforts.

*Call graph*: called by 1 (handle_reasoning_shortcut).


##### `next_reasoning_effort`  (lines 144–161)

```
fn next_reasoning_effort(
    choices: &[ReasoningEffortConfig],
    current_effort: Option<ReasoningEffortConfig>,
    direction: ReasoningShortcutDirection,
) -> Option<ReasoningEffortConfig>
```

**Purpose**: Computes the adjacent reasoning effort in the requested direction within an ordered choices list. It does not infer positions for unsupported current values and returns `None` at bounds.

**Data flow**: Inputs are a slice of `ReasoningEffortConfig`, an optional current effort, and a `ReasoningShortcutDirection`. It returns early on `None` current effort, searches `choices` for the current effort, and if found returns the previous or next element depending on direction using index arithmetic and safe access; otherwise it returns `None`.

**Call relations**: This helper is called by `ChatWidget::handle_reasoning_shortcut` after that method has anchored the current effort to a supported value when possible.

*Call graph*: called by 1 (handle_reasoning_shortcut); 2 external calls (get, iter).


##### `tests::next_reasoning_effort_raises_from_default_anchor`  (lines 169–185)

```
fn next_reasoning_effort_raises_from_default_anchor()
```

**Purpose**: Verifies that stepping upward from a middle/default-like effort returns the next advertised effort. It checks the normal increasing path.

**Data flow**: The test constructs a vector of ordered efforts, calls `next_reasoning_effort` with `Medium` and `Raise`, and asserts that the result is `Some(High)`.

**Call relations**: This test exercises the pure stepping helper directly to lock in upward traversal behavior.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `tests::next_reasoning_effort_lowers_from_default_anchor`  (lines 188–203)

```
fn next_reasoning_effort_lowers_from_default_anchor()
```

**Purpose**: Verifies that stepping downward from a middle/default-like effort returns the previous advertised effort. It checks the normal decreasing path.

**Data flow**: The test builds an ordered effort vector, calls `next_reasoning_effort` with `Medium` and `Lower`, and asserts that the result is `Some(Low)`.

**Call relations**: This test complements the upward-step test by covering the opposite direction on the same helper.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `tests::next_reasoning_effort_does_not_infer_position_for_unsupported_current`  (lines 206–224)

```
fn next_reasoning_effort_does_not_infer_position_for_unsupported_current()
```

**Purpose**: Ensures the stepping helper refuses to guess where an unsupported current effort belongs in the advertised order. Both directions should return `None`.

**Data flow**: The test creates choices `[Low, High]`, calls `next_reasoning_effort` twice with unsupported `Medium` for `Raise` and `Lower`, and asserts the pair is `(None, None)`.

**Call relations**: This test documents the invariant that unsupported current values are not interpolated by `next_reasoning_effort` itself.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `tests::next_reasoning_effort_uses_advertised_order_for_custom_levels`  (lines 227–253)

```
fn next_reasoning_effort_uses_advertised_order_for_custom_levels()
```

**Purpose**: Checks that the helper respects the exact advertised order, even when it is nonstandard and includes custom effort labels. It proves the function is order-driven rather than semantically sorted.

**Data flow**: The test constructs a custom effort plus an intentionally unusual order `[High, Low, Custom("max")]`, then asserts that raising from `High` yields `Low` and lowering from the custom effort also yields `Low`.

**Call relations**: This test guards the design choice that `next_reasoning_effort` follows catalog order exactly.

*Call graph*: 3 external calls (Custom, assert_eq!, vec!).


##### `tests::next_reasoning_effort_clamps_at_bounds`  (lines 256–279)

```
fn next_reasoning_effort_clamps_at_bounds()
```

**Purpose**: Verifies that stepping below the first choice or above the last choice returns `None`. It covers both lower and upper boundaries.

**Data flow**: The test builds `[Low, Medium, High]`, calls `next_reasoning_effort` with `Low/Lower` and `High/Raise`, and asserts both results are `None`.

**Call relations**: This test confirms the boundary behavior that drives `bound_message` handling in the widget.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `tests::next_reasoning_effort_single_option_is_noop`  (lines 282–301)

```
fn next_reasoning_effort_single_option_is_noop()
```

**Purpose**: Ensures a model with only one supported reasoning effort cannot be stepped in either direction. Both attempts should be no-ops represented by `None`.

**Data flow**: The test creates a single-element choices vector `[High]`, calls `next_reasoning_effort` for both `Raise` and `Lower`, and asserts both results are `None`.

**Call relations**: This test covers the degenerate one-choice case for the stepping helper.

*Call graph*: 2 external calls (assert_eq!, vec!).


### `tui/src/chatwidget/tokens.rs`

`domain_logic` · `request handling`

This module owns the non-rendering mechanics behind `/usage` token activity. The central state machine is `TokenActivityState`, which moves from `Loading` to either `Loaded { response, today }` or `Error`. That state is wrapped in `Arc<RwLock<_>>` inside `TokenActivityHandle`, allowing the background completion path and the widget-owned transient card to share one mutable render state safely. `new_token_activity_output` constructs a `CompositeHistoryCell` containing both the echoed slash command (`PlainHistoryCell`) and a `TokenActivityHistoryCell` that reads from the shared state.

`TokenActivityHistoryCell` implements `HistoryCell`: `display_lines` renders a loading stub, a stable unavailable message, or delegates to `chart::loaded_lines` for the full chart and summary. On the widget side, `ChatWidget::add_token_activity_output` allocates a monotonically wrapping request ID, clears any previously completed card, stores the new pending output, bumps active-cell revision, requests redraw, and emits `AppEvent::RefreshTokenActivity`.

Completion is guarded by request correlation in `finish_token_activity_refresh`: only the currently pending request ID may transition into `completed_token_activity_output`; late responses are rejected and the pending output is restored unchanged. The module also defines the insertion barrier logic used by usage-related output generally: active streams, pending stream consolidations, active transcript cells, and active hook cells all block history insertion. Helper methods increment/decrement consolidation counters, expose pending/completed output for rendering, request deferred insertion retries, and clear stale token-activity state during transcript resets or replacement flows.

#### Function details

##### `TokenActivityHandle::finish`  (lines 74–76)

```
fn finish(&self, result: Result<GetAccountTokenUsageResponse, String>)
```

**Purpose**: Completes a token-activity card using the current UTC date as the chart anchor. It is the normal production entry point for turning a backend result into a terminal render state.

**Data flow**: Takes `&self` and a `Result<GetAccountTokenUsageResponse, String>`, reads the current date via `Utc::now().date_naive()`, and forwards both to `finish_with_today`. It returns no value and mutates the shared `RwLock<TokenActivityState>` indirectly.

**Call relations**: Called from `ChatWidget::finish_token_activity_refresh` after request-ID matching succeeds. It delegates the actual state replacement to `finish_with_today` so tests can inject a fixed date separately.

*Call graph*: calls 1 internal fn (finish_with_today); 1 external calls (now).


##### `TokenActivityHandle::finish_with_today`  (lines 78–90)

```
fn finish_with_today(
        &self,
        result: Result<GetAccountTokenUsageResponse, String>,
        today: NaiveDate,
    )
```

**Purpose**: Replaces the shared token-activity state with either a loaded response anchored to a supplied date or a generic error state. This is the deterministic completion primitive used by both production code and tests.

**Data flow**: Accepts `&self`, a backend result, and a `NaiveDate` named `today`. It maps `Ok(response)` to `TokenActivityState::Loaded { response, today }` and any `Err(_)` to `TokenActivityState::Error`, acquires a write lock on `self.state`, and overwrites the previous state in place.

**Call relations**: Used by `TokenActivityHandle::finish`, and directly by tests that need a stable anchor date. It performs no request correlation itself; callers are expected to ensure they are completing the correct card.

*Call graph*: called by 1 (finish).


##### `new_token_activity_output`  (lines 105–122)

```
fn new_token_activity_output(
    view: TokenActivityView,
) -> (CompositeHistoryCell, TokenActivityHandle)
```

**Purpose**: Builds the initial composite `/usage` output and the shared completion handle for one invocation. The returned card starts in loading state and includes the echoed slash command line above the chart area.

**Data flow**: Takes a `TokenActivityView`, formats `/usage <label>` using the view’s lowercase label into a magenta `PlainHistoryCell`, allocates `Arc<RwLock<TokenActivityState::Loading>>`, constructs a `TokenActivityHandle` and `TokenActivityHistoryCell` sharing that state, and returns `(CompositeHistoryCell, TokenActivityHandle)`.

**Call relations**: Called only by `ChatWidget::add_token_activity_output` when a new `/usage` request starts. It isolates the card/handle construction so the widget method can focus on request bookkeeping and event dispatch.

*Call graph*: calls 2 internal fn (new, new); called by 1 (add_token_activity_output); 4 external calls (clone, new, new, vec!).


##### `TokenActivityHistoryCell::display_lines`  (lines 125–143)

```
fn display_lines(&self, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Renders the token-activity portion of the `/usage` card according to the shared asynchronous state. It emits a loading stub, a fixed unavailable message, or the full chart and summary.

**Data flow**: Reads `self.state` through an `RwLock` read guard and matches on `TokenActivityState`. For `Loading`, it returns two lines (`Token activity` and dim `Loading...`); for `Error`, two lines with `Token activity unavailable`; for `Loaded`, it passes `self.view`, the stored response, stored `today`, and the requested width into `chart::loaded_lines` and returns those lines.

**Call relations**: This method is invoked through the `HistoryCell` trait wherever the composite card is rendered. `raw_lines` delegates to it, and loaded rendering further delegates into the pure chart module.

*Call graph*: calls 1 internal fn (loaded_lines); called by 1 (raw_lines); 1 external calls (vec!).


##### `TokenActivityHistoryCell::raw_lines`  (lines 145–147)

```
fn raw_lines(&self) -> Vec<Line<'static>>
```

**Purpose**: Produces an unwrapped plain-text version of the rendered token-activity card. It is used for raw/copy-style output paths that want the same content without width constraints or styling structure.

**Data flow**: Calls `self.display_lines(u16::MAX)` to render without practical width limits, then passes the resulting styled lines through `plain_lines` and returns the flattened `Vec<Line<'static>>`.

**Call relations**: Called via the `HistoryCell` trait’s raw-output path. It depends entirely on `display_lines` for content selection and only strips styling/formatting afterward.

*Call graph*: calls 2 internal fn (display_lines, plain_lines).


##### `ChatWidget::add_token_activity_output`  (lines 156–171)

```
fn add_token_activity_output(&mut self, view: TokenActivityView)
```

**Purpose**: Starts a new asynchronous token-activity refresh and installs its loading card as the widget’s transient usage output. It also emits the app event that asks the backend layer to fetch usage data.

**Data flow**: Reads `self.next_token_activity_request_id`, increments it with wrapping arithmetic, calls `new_token_activity_output(view)` to get a loading card and handle, clears `self.completed_token_activity_output`, stores a new `PendingTokenActivityOutput` in `self.refreshing_token_activity_output`, bumps active-cell revision, requests redraw, and sends `AppEvent::RefreshTokenActivity { request_id }` on `self.app_event_tx`.

**Call relations**: This widget method is entered when `/usage` token activity is requested. It delegates card construction to `new_token_activity_output` and hands off actual data fetching to the outer app via the emitted event.

*Call graph*: calls 1 internal fn (new_token_activity_output).


##### `ChatWidget::pending_token_activity_output`  (lines 178–187)

```
fn pending_token_activity_output(&self) -> Option<&dyn HistoryCell>
```

**Purpose**: Exposes whichever token-activity card should currently render above the composer. A still-refreshing loading card takes precedence over a completed card waiting to be inserted into transcript history.

**Data flow**: Reads widget state immutably. If `self.refreshing_token_activity_output` is `Some`, it returns a trait-object reference to that pending composite cell; otherwise it falls back to `self.completed_token_activity_output` and returns a trait-object reference if present; otherwise it returns `None`.

**Call relations**: Used by rendering code that needs to show transient usage output without taking ownership. It does not mutate state and serves as the read-side counterpart to the add/finish/take methods.


##### `ChatWidget::finish_token_activity_refresh`  (lines 194–211)

```
fn finish_token_activity_refresh(
        &mut self,
        request_id: u64,
        result: Result<GetAccountTokenUsageResponse, String>,
    ) -> bool
```

**Purpose**: Applies a backend usage result to the currently pending token-activity request if and only if the request IDs match. Matching completions move the card from the refreshing slot into the completed slot for later history insertion.

**Data flow**: Takes a mutable widget, a `request_id`, and a backend result. It removes `self.refreshing_token_activity_output`; if none exists it returns `false`. If the stored request ID differs, it restores the pending output unchanged and returns `false`. On a match, it calls `output.handle.finish(result)`, stores `output.cell` into `self.completed_token_activity_output`, bumps active-cell revision, requests redraw, and returns `true`.

**Call relations**: This method is called when the backend responds to `AppEvent::RefreshTokenActivity`. It performs the request-correlation gate before delegating state mutation to `TokenActivityHandle::finish`, preventing late responses from mutating newer cards.


##### `ChatWidget::usage_history_insertion_blocked`  (lines 218–224)

```
fn usage_history_insertion_blocked(&self) -> bool
```

**Purpose**: Reports whether usage-related output must remain transient instead of being inserted into transcript history. It centralizes all barriers that could reorder usage cards relative to visible work.

**Data flow**: Reads five widget fields: `stream_controller`, `plan_stream_controller`, `pending_stream_consolidations`, `transcript.active_cell`, and `active_hook_cell`. It returns `true` if any stream controller exists, any consolidation count is positive, or any active transcript/hook cell is present; otherwise `false`.

**Call relations**: Consulted by higher-level usage-output insertion logic, including tests around deferred startup hints and token activity. It does not trigger retries itself; the request methods below do that.


##### `ChatWidget::note_stream_consolidation_queued`  (lines 230–233)

```
fn note_stream_consolidation_queued(&mut self)
```

**Purpose**: Adds one pending stream-consolidation barrier to the usage-output insertion gate. This prevents completed usage cards from being inserted while stream output still needs consolidation.

**Data flow**: Mutably increments `self.pending_stream_consolidations` using `saturating_add(1)`. It returns no value and has no side effects beyond the counter update.

**Call relations**: Called by stream lifecycle code when a consolidation task is queued. It pairs conceptually with `note_stream_consolidation_completed`, which removes the barrier later.


##### `ChatWidget::note_stream_consolidation_completed`  (lines 239–242)

```
fn note_stream_consolidation_completed(&mut self)
```

**Purpose**: Removes one pending stream-consolidation barrier from the usage-output insertion gate. The counter saturates at zero to avoid underflow on mismatched completions.

**Data flow**: Mutably decrements `self.pending_stream_consolidations` using `saturating_sub(1)`. It returns no value and only updates the barrier counter.

**Call relations**: Called after a queued consolidation finishes. It is the release-side counterpart to `note_stream_consolidation_queued` and affects `usage_history_insertion_blocked` results.


##### `ChatWidget::take_completed_token_activity_output`  (lines 249–253)

```
fn take_completed_token_activity_output(&mut self) -> Option<CompositeHistoryCell>
```

**Purpose**: Transfers ownership of a completed token-activity card out of the transient render area and into the history insertion path. Taking the card also marks the active-cell view as changed.

**Data flow**: Mutably takes `self.completed_token_activity_output`; if absent, returns `None`. If present, it bumps active-cell revision and returns the `CompositeHistoryCell` inside `Some(...)`.

**Call relations**: Used by code that commits completed usage output into transcript history once insertion barriers clear. It is the ownership-moving counterpart to `pending_token_activity_output`, which only borrows.


##### `ChatWidget::request_pending_usage_output_insertion`  (lines 259–265)

```
fn request_pending_usage_output_insertion(&self)
```

**Purpose**: Asks the outer app loop to retry committing deferred usage output into history. It only emits the retry event when there is actually completed token activity or a pending rate-limit-reset hint waiting.

**Data flow**: Reads `self.completed_token_activity_output` and `self.pending_rate_limit_reset_hint()`. If either is present, it sends `AppEvent::CommitPendingUsageOutput` on `self.app_event_tx`; otherwise it does nothing.

**Call relations**: Called after lifecycle changes that may have removed insertion barriers. It does not insert output itself; it schedules the app-level commit path to re-check conditions.


##### `ChatWidget::request_pending_usage_output_insertion_after_stream_shutdown`  (lines 267–274)

```
fn request_pending_usage_output_insertion_after_stream_shutdown(&self)
```

**Purpose**: Requests a specialized retry of deferred usage-output insertion after stream shutdown. It mirrors the normal retry method but emits a distinct event for the post-shutdown phase.

**Data flow**: Reads the same waiting-output conditions as `request_pending_usage_output_insertion`. If either a completed token card or pending reset hint exists, it sends `AppEvent::CommitPendingUsageOutputAfterStreamShutdown` on `self.app_event_tx`.

**Call relations**: Used by stream shutdown paths that need a separate app-event variant. It plays the same scheduling role as `request_pending_usage_output_insertion` but for a different point in the stream lifecycle.


##### `ChatWidget::clear_pending_token_activity_refreshes`  (lines 280–287)

```
fn clear_pending_token_activity_refreshes(&mut self)
```

**Purpose**: Drops both in-flight and completed token-activity cards when they are no longer valid, such as after transcript resets or replacement flows. If anything was cleared, it also triggers the necessary UI refresh bookkeeping.

**Data flow**: Mutably takes `self.refreshing_token_activity_output` and `self.completed_token_activity_output`, recording whether either existed. If at least one was removed, it bumps active-cell revision and requests redraw; otherwise it leaves the widget untouched.

**Call relations**: Called by transcript-management flows that invalidate widget-owned transient usage state. It prevents late backend responses from updating cards that should no longer exist.


### `tui/src/chatwidget/usage.rs`

`domain_logic` · `request handling`

This module manages a small popup-driven workflow around account usage and rate-limit reset credits. `open_usage_menu` shows a two-item selection view: one action opens token activity, the other opens the reset-credit flow. Whether the reset action is enabled and how it is described depends on account eligibility (`has_chatgpt_account` and non-workspace plan) plus any cached `available_rate_limit_reset_credits`.

The reset-credit flow is request-id based to avoid stale async responses mutating the wrong popup. `show_rate_limit_reset_loading_popup`, `show_rate_limit_reset_consuming_popup`, and `start_rate_limit_reset_startup_check` each allocate a monotonically wrapping request id via `take_next_rate_limit_reset_request_id`, store it in the appropriate pending field, and clear any pending transcript hint first. Completion methods reject mismatched ids early. Refresh completion either replaces the popup with a confirmation view, a simple message view, or leaves it unchanged on stale responses. Consumption completion distinguishes successful reset/already-redeemed outcomes from `NothingToReset`, `NoCredit`, and transport errors; success transitions into a second loading popup so remaining credits can be refreshed, while errors offer a retry action that reuses the same idempotency key.

The file also manages a transient `pending_rate_limit_reset_hint` rendered like an info history cell. Startup refresh can populate this hint only for authenticated non-workspace users with positive available credits. Clearing or taking the hint bumps the transcript active-cell revision so overlay caches notice the change.

#### Function details

##### `ChatWidget::open_usage_menu`  (lines 12–57)

```
fn open_usage_menu(&mut self)
```

**Purpose**: Shows the top-level usage popup with actions to view token usage or redeem a rate-limit reset. It computes reset eligibility and descriptive text from account state and cached credit availability.

**Data flow**: Clears any pending reset hint, reads `has_chatgpt_account`, `plan_type`, and `available_rate_limit_reset_credits`, derives whether reset redemption should be enabled plus a description string, builds a `SelectionViewParams` with two `SelectionItem`s that send `AppEvent::OpenTokenActivity` or `AppEvent::OpenRateLimitResetCredits`, shows the selection view in the bottom pane, requests redraw, and returns nothing.

**Call relations**: Called when the user opens the usage UI. It is the entrypoint into the popup-based usage/reset workflow and delegates actual actions to emitted `AppEvent`s.

*Call graph*: calls 1 internal fn (clear_pending_rate_limit_reset_hint); 3 external calls (default, format!, vec!).


##### `ChatWidget::show_rate_limit_reset_loading_popup`  (lines 59–76)

```
fn show_rate_limit_reset_loading_popup(&mut self) -> u64
```

**Purpose**: Shows a loading popup while the widget checks how many rate-limit reset credits are available. It also establishes the request id that later refresh results must match.

**Data flow**: Clears any pending reset hint, allocates a new request id via `take_next_rate_limit_reset_request_id`, stores it in `pending_rate_limit_reset_request_id`, shows a disabled 'Loading...' selection view under the reset popup id, requests redraw, and returns the request id.

**Call relations**: Used when beginning an explicit refresh of reset-credit availability. Later `finish_rate_limit_reset_credits_refresh` calls must present the same request id to update this popup.

*Call graph*: calls 2 internal fn (clear_pending_rate_limit_reset_hint, take_next_rate_limit_reset_request_id); 2 external calls (default, vec!).


##### `ChatWidget::finish_rate_limit_reset_credits_refresh`  (lines 78–110)

```
fn finish_rate_limit_reset_credits_refresh(
        &mut self,
        request_id: u64,
        result: Result<RateLimitResetCreditsSummary, String>,
    ) -> bool
```

**Purpose**: Completes the availability-refresh step for rate-limit reset credits and replaces the loading popup with either a confirmation or message view. It ignores stale responses whose request id no longer matches.

**Data flow**: Takes a `request_id` and `Result<RateLimitResetCreditsSummary, String>`. If the id does not equal `pending_rate_limit_reset_request_id`, it returns `false`. Otherwise it clears the pending id, updates `available_rate_limit_reset_credits` on success, chooses popup params: confirmation when `available_count > 0`, a no-credits message when zero, or a generic failure message on error. It asks the bottom pane to replace the popup if present, requests redraw only when replacement occurred, and returns whether replacement happened.

**Call relations**: This is the completion counterpart to `show_rate_limit_reset_loading_popup`. It delegates popup construction to `rate_limit_reset_confirmation_params` or `rate_limit_reset_message_params`.

*Call graph*: 2 external calls (rate_limit_reset_confirmation_params, rate_limit_reset_message_params).


##### `ChatWidget::rate_limit_reset_confirmation_params`  (lines 112–143)

```
fn rate_limit_reset_confirmation_params(available_count: i64) -> SelectionViewParams
```

**Purpose**: Builds the confirmation popup shown when the user has at least one reset credit available. It embeds a fresh idempotency key into the 'Use a reset' action.

**Data flow**: Takes `available_count: i64`, generates a UUID string idempotency key, constructs `SelectionViewParams` with a subtitle describing the available count, a 'Use a reset' item that sends `AppEvent::ConsumeRateLimitResetCredit { idempotency_key }`, and a 'Cancel' item, sets the initial selection to Cancel, and returns the params.

**Call relations**: Used by `finish_rate_limit_reset_credits_refresh` to replace the loading popup with a redeem-or-cancel confirmation view.

*Call graph*: 4 external calls (default, new_v4, format!, vec!).


##### `ChatWidget::rate_limit_reset_message_params`  (lines 145–157)

```
fn rate_limit_reset_message_params(message: &str) -> SelectionViewParams
```

**Purpose**: Builds a simple one-button informational popup for the rate-limit reset flow. It is used for no-credit, success, and generic error messages.

**Data flow**: Takes a message `&str`, constructs `SelectionViewParams` with the reset popup id, a fixed title, the provided subtitle, and a single dismissing 'Close' item, then returns the params.

**Call relations**: Used by several completion paths whenever the flow should end in an informational message rather than another action choice.

*Call graph*: 2 external calls (default, vec!).


##### `ChatWidget::show_rate_limit_reset_consuming_popup`  (lines 159–177)

```
fn show_rate_limit_reset_consuming_popup(&mut self) -> u64
```

**Purpose**: Shows a non-cancelable loading popup while a reset credit is being redeemed. It also establishes the request id for the consume operation.

**Data flow**: Clears any pending reset hint, allocates a new request id, stores it in `pending_rate_limit_reset_request_id`, shows a reset popup with subtitle 'Resetting your usage...' and a disabled 'Using a reset...' item, sets `allow_cancel = false`, requests redraw, and returns the request id.

**Call relations**: Used when the user confirms redemption. Later `finish_rate_limit_reset_consume` must present the same request id to update this popup.

*Call graph*: calls 2 internal fn (clear_pending_rate_limit_reset_hint, take_next_rate_limit_reset_request_id); 2 external calls (default, vec!).


##### `ChatWidget::finish_rate_limit_reset_consume`  (lines 179–245)

```
fn finish_rate_limit_reset_consume(
        &mut self,
        request_id: u64,
        idempotency_key: String,
        result: Result<ConsumeAccountRateLimitResetCreditResponse, String>,
    ) -> bo
```

**Purpose**: Completes the consume-reset request, branching among success, no-op outcomes, no-credit outcomes, and retryable transport failures. It updates cached credit availability and popup contents accordingly.

**Data flow**: Takes a `request_id`, `idempotency_key`, and `Result<ConsumeAccountRateLimitResetCreditResponse, String>`. If the request id is stale it returns `false`. On successful `Reset` or `AlreadyRedeemed`, it clears cached available credits, replaces the popup with a success-loading view for the follow-up refresh, and returns `true`. On successful `NothingToReset` or `NoCredit`, it clears the pending id, optionally caches zero credits, replaces the popup with an informational message, and returns `false`. On error, it clears the pending id and replaces the popup with a retry/close view whose retry action resends `ConsumeRateLimitResetCredit` with the same idempotency key, then returns `false`.

**Call relations**: This is the completion counterpart to `show_rate_limit_reset_consuming_popup`. It delegates popup replacement to `replace_rate_limit_reset_popup` and uses `rate_limit_reset_success_loading_params` or `rate_limit_reset_message_params` depending on outcome.

*Call graph*: calls 1 internal fn (replace_rate_limit_reset_popup); 6 external calls (default, rate_limit_reset_message_params, rate_limit_reset_success_loading_params, matches!, unreachable!, vec!).


##### `ChatWidget::finish_post_consume_reset_credits_refresh`  (lines 247–270)

```
fn finish_post_consume_reset_credits_refresh(
        &mut self,
        request_id: u64,
        result: Result<RateLimitResetCreditsSummary, String>,
    ) -> bool
```

**Purpose**: Completes the follow-up refresh after a successful reset redemption and shows the final remaining-credit message. It also ignores stale responses by request id.

**Data flow**: Takes a `request_id` and `Result<RateLimitResetCreditsSummary, String>`. If the id is stale it returns `false`. Otherwise it clears the pending id, updates `available_rate_limit_reset_credits` on success, builds either a message like 'Usage reset. You have N resets left.' or the fallback 'Usage reset.', replaces the popup with that message view, and returns `true`.

**Call relations**: Used after `finish_rate_limit_reset_consume` transitions into the success-loading popup. It finalizes the happy-path flow by replacing that loading state with a terminal message.

*Call graph*: calls 1 internal fn (replace_rate_limit_reset_popup); 2 external calls (rate_limit_reset_message_params, format!).


##### `ChatWidget::rate_limit_reset_success_loading_params`  (lines 272–285)

```
fn rate_limit_reset_success_loading_params() -> SelectionViewParams
```

**Purpose**: Builds the intermediate non-cancelable popup shown after a reset succeeds but before remaining credits are refreshed. It communicates that the reset worked and a follow-up check is in progress.

**Data flow**: Constructs and returns `SelectionViewParams` with the reset popup id, a fixed title, subtitle 'Usage reset. Checking your remaining resets...', a disabled 'Refreshing...' item, and `allow_cancel = false`.

**Call relations**: Used by `finish_rate_limit_reset_consume` for successful or already-redeemed outcomes before the post-consume refresh completes.

*Call graph*: 2 external calls (default, vec!).


##### `ChatWidget::replace_rate_limit_reset_popup`  (lines 287–294)

```
fn replace_rate_limit_reset_popup(&mut self, params: SelectionViewParams)
```

**Purpose**: Replaces the currently visible rate-limit reset popup if it is still present and redraws only when replacement succeeds. It centralizes the popup-update-and-redraw pattern.

**Data flow**: Takes `SelectionViewParams`, asks `bottom_pane.replace_selection_view_if_present` to replace the popup identified by `RATE_LIMIT_RESET_VIEW_ID`, requests redraw if replacement occurred, and returns nothing.

**Call relations**: Called by `finish_rate_limit_reset_consume` and `finish_post_consume_reset_credits_refresh` to update the existing popup in place.

*Call graph*: called by 2 (finish_post_consume_reset_credits_refresh, finish_rate_limit_reset_consume).


##### `ChatWidget::start_rate_limit_reset_startup_check`  (lines 296–301)

```
fn start_rate_limit_reset_startup_check(&mut self) -> u64
```

**Purpose**: Begins the background startup check for available reset credits and records the hint-refresh request id. It clears any stale hint before starting.

**Data flow**: Clears any pending reset hint, allocates a new request id, stores it in `pending_rate_limit_reset_hint_request_id`, and returns the id.

**Call relations**: Used during startup or auth-refresh flows that want to populate the passive transcript hint rather than open a popup.

*Call graph*: calls 2 internal fn (clear_pending_rate_limit_reset_hint, take_next_rate_limit_reset_request_id).


##### `ChatWidget::finish_rate_limit_reset_hint_refresh`  (lines 303–323)

```
fn finish_rate_limit_reset_hint_refresh(
        &mut self,
        request_id: u64,
        result: Result<RateLimitResetCreditsSummary, String>,
    ) -> bool
```

**Purpose**: Completes the startup/background refresh for reset-credit availability and optionally installs a passive transcript hint. It respects auth and workspace-account gating.

**Data flow**: Takes a `request_id` and `Result<RateLimitResetCreditsSummary, String>`. If the id is stale it returns `false`. Otherwise it clears `pending_rate_limit_reset_hint_request_id`, returns `false` immediately if backend auth is unavailable, returns `true` without hinting for workspace accounts, and on successful responses caches `available_rate_limit_reset_credits` and calls `set_rate_limit_reset_available_hint(response.available_count)`. It returns `true` once the response was accepted, even if no hint was shown.

**Call relations**: This is the completion counterpart to `start_rate_limit_reset_startup_check`. It delegates actual hint creation to `set_rate_limit_reset_available_hint`.

*Call graph*: calls 1 internal fn (set_rate_limit_reset_available_hint).


##### `ChatWidget::clear_pending_rate_limit_reset_requests`  (lines 325–331)

```
fn clear_pending_rate_limit_reset_requests(&mut self)
```

**Purpose**: Clears all in-flight reset-credit request tracking, cached availability, pending hint state, and any visible reset popup. It is the full reset path for this feature’s local state.

**Data flow**: Sets `pending_rate_limit_reset_request_id = None`, `available_rate_limit_reset_credits = None`, calls `clear_pending_rate_limit_reset_hint()`, dismisses the reset popup by id from the bottom pane, and returns nothing.

**Call relations**: Used when account/session state changes or the feature needs to be fully reset so no stale popup or hint survives.

*Call graph*: calls 1 internal fn (clear_pending_rate_limit_reset_hint).


##### `ChatWidget::clear_pending_rate_limit_reset_hint`  (lines 333–340)

```
fn clear_pending_rate_limit_reset_hint(&mut self)
```

**Purpose**: Removes any pending passive reset hint and invalidates transcript overlay caches if one was present. It also clears the associated hint-refresh request id.

**Data flow**: Sets `pending_rate_limit_reset_hint_request_id = None`, takes and discards `pending_rate_limit_reset_hint`, and if a hint actually existed bumps the active-cell revision and requests redraw. It returns nothing.

**Call relations**: Called before opening usage/reset popups and when clearing all pending reset state, so stale passive hints do not coexist with active reset UI.

*Call graph*: called by 5 (clear_pending_rate_limit_reset_requests, open_usage_menu, show_rate_limit_reset_consuming_popup, show_rate_limit_reset_loading_popup, start_rate_limit_reset_startup_check).


##### `ChatWidget::pending_rate_limit_reset_hint`  (lines 342–344)

```
fn pending_rate_limit_reset_hint(&self) -> Option<&PlainHistoryCell>
```

**Purpose**: Returns a shared reference to the currently pending passive reset hint, if any. It is a read-only accessor for transcript rendering code.

**Data flow**: Reads `self.pending_rate_limit_reset_hint` and returns `Option<&PlainHistoryCell>`. It does not mutate state.

**Call relations**: Used by rendering paths that need to know whether a passive reset hint should be displayed alongside transcript content.


##### `ChatWidget::take_pending_rate_limit_reset_hint`  (lines 346–350)

```
fn take_pending_rate_limit_reset_hint(&mut self) -> Option<PlainHistoryCell>
```

**Purpose**: Consumes and returns the pending passive reset hint, invalidating transcript overlay caches when one is removed. It is the mutable counterpart to the read-only accessor.

**Data flow**: Takes `self.pending_rate_limit_reset_hint`; if absent returns `None`. If present, bumps the active-cell revision and returns `Some(PlainHistoryCell)`. It mutates hint storage and cache-invalidation state.

**Call relations**: Used when the hint is being moved out of pending state into another transcript/rendering location.


##### `ChatWidget::set_rate_limit_reset_available_hint`  (lines 352–365)

```
fn set_rate_limit_reset_available_hint(&mut self, available_count: i64)
```

**Purpose**: Installs a passive info-style transcript hint advertising available reset credits, but only when the count is positive. It also invalidates transcript overlay caches so the hint becomes visible.

**Data flow**: Takes `available_count: i64`, returns early if the count is nonpositive, otherwise creates an info history cell with text like 'You have N resets available. Run /usage to use one.', stores it in `pending_rate_limit_reset_hint`, bumps the active-cell revision, requests redraw, and returns nothing.

**Call relations**: Called by `finish_rate_limit_reset_hint_refresh` after a successful background refresh for eligible users.

*Call graph*: called by 1 (finish_rate_limit_reset_hint_refresh); 2 external calls (format!, new_info_event).


##### `ChatWidget::take_next_rate_limit_reset_request_id`  (lines 367–373)

```
fn take_next_rate_limit_reset_request_id(&mut self) -> u64
```

**Purpose**: Allocates the next request id for reset-credit operations using wrapping arithmetic. It provides simple monotonic correlation for async popup and hint refreshes.

**Data flow**: Reads `next_rate_limit_reset_request_id`, returns the current value, then increments the stored counter with `wrapping_add(1)`. It mutates only the counter field.

**Call relations**: Used by popup-opening and startup-check methods to tag each async reset-credit request so stale responses can be ignored.

*Call graph*: called by 3 (show_rate_limit_reset_consuming_popup, show_rate_limit_reset_loading_popup, start_rate_limit_reset_startup_check).


##### `reset_label`  (lines 376–382)

```
fn reset_label(count: i64) -> &'static str
```

**Purpose**: Returns the singular or plural label for a rate-limit reset count. It keeps user-facing strings grammatically correct.

**Data flow**: Takes `count: i64` and returns the static string `"rate-limit reset"` when the count is exactly 1, otherwise `"rate-limit resets"`. It does not mutate state.

**Call relations**: Used throughout this file when constructing subtitles and hint text that mention the number of available resets.
