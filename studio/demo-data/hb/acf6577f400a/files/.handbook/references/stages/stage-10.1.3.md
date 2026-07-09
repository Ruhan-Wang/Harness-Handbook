# Chat widget interaction and command flows  `stage-10.1.3`

This stage is the main control room for the terminal chat screen. It runs during normal use, after startup, while the user is talking to the agent. The central chat widget keeps the transcript, input box, status messages, popups, and streaming replies in sync. Rendering turns that state into terminal rows. Protocol files listen for server events and turn them into visible changes, such as approvals, tool prompts, review results, and notices.

User input passes through several gates. Interaction handles keys, paste, images, copy, interrupt, and quit. Input submission and input flow decide whether text is sent now, queued, treated as a slash command, or held until the current turn finishes. The queue and restore code protect drafts, rejected messages, steering instructions, and attachments from being lost.

Other parts add focused features. Slash dispatch runs commands like `/new` or `/diff`. Skills, connectors, IDE context, goals, hooks, usage, tokens, reviews, model popups, plan implementation, and reasoning shortcuts build the small menus and actions around chat. Interrupt and notification helpers make sure prompts and alerts appear in a useful order.

## Files in this stage

### Widget core and rendering
Defines the main chat widget state, renders its UI, and handles deferred interrupt-style events and notifications.

### `tui/src/chatwidget.rs`

`orchestration` · `main loop`

Think of ChatWidget as the control desk for the terminal chat experience. It does not run the AI agent itself. Instead, it listens to events from the agent and app server, turns them into visible transcript entries, and sends user actions back out as commands. Without this file, the TUI would have no central place to connect typed messages, streamed assistant replies, approvals, tool output, status lines, and overlays into one coherent screen.

The file keeps two kinds of transcript content. Finished items become history cells, like permanent lines in a logbook. In-progress content stays in an active cell, so it can change while a command runs or a model response streams. When that live content is ready, ChatWidget flushes it into the committed history.

It also owns many small user-facing flows: feedback forms, memory and multi-agent prompts, raw-output mode, review mode, shutdown messages, file-search results, token usage, and terminal resize behavior. The bottom pane is the input and popup area; ChatWidget tells it what to show and when. It also requests redraws whenever something changes, like ringing a bell to tell the UI to repaint.

A lot of this file is glue code. Its importance is that it keeps several moving parts—agent progress, app-server requests, transcript rendering, keyboard behavior, and user prompts—from drifting out of sync.

#### Function details

##### `queued_message_edit_binding_for_terminal`  (lines 217–241)

```
fn queued_message_edit_binding_for_terminal(terminal_info: TerminalInfo) -> KeyBinding
```

**Purpose**: Chooses the keyboard shortcut that should edit the most recently queued message. Some terminals intercept Alt+Up, so this picks a safer fallback for those environments.

**Data flow**: It receives detected terminal information, including the terminal name and whether the user is inside tmux. It checks that environment and returns either Shift+Left or Alt+Up as the shortcut to display and accept.

**Call relations**: queued_message_edit_hint_binding calls this first to learn the terminal-specific preferred shortcut before comparing it with the configured shortcuts.

*Call graph*: calls 2 internal fn (alt, shift); called by 1 (queued_message_edit_hint_binding); 1 external calls (matches!).


##### `queued_message_edit_hint_binding`  (lines 243–252)

```
fn queued_message_edit_hint_binding(
    bindings: &[KeyBinding],
    terminal_info: TerminalInfo,
) -> Option<KeyBinding>
```

**Purpose**: Picks the actual shortcut hint to show for editing a queued message. It prefers the terminal-safe shortcut, but falls back to the first configured binding if needed.

**Data flow**: It takes a list of allowed key bindings and terminal information. It computes the best binding for that terminal, checks whether it is present in the configured list, and returns that binding or the first available one.

**Call relations**: This is the small bridge between terminal detection and the user-visible key hint. It relies on queued_message_edit_binding_for_terminal to avoid showing a shortcut that the terminal may swallow.

*Call graph*: calls 1 internal fn (queued_message_edit_binding_for_terminal); 1 external calls (contains).


##### `normalize_thread_name`  (lines 254–257)

```
fn normalize_thread_name(name: &str) -> Option<String>
```

**Purpose**: Cleans up a proposed thread name and rejects empty names. This prevents whitespace-only session names from being saved or shown.

**Data flow**: It receives a name string, trims leading and trailing whitespace, and returns the cleaned string only if something meaningful remains.

**Call relations**: This helper supports thread naming flows elsewhere in the chat UI by turning raw user or server text into a safe optional display name.


##### `contains_plan_keyword`  (lines 814–817)

```
fn contains_plan_keyword(text: &str) -> bool
```

**Purpose**: Checks whether text contains the standalone word “plan”. It is used for plan-mode suggestions without being fooled by words like “planning”.

**Data flow**: It receives text, splits it around non-word separators, compares each word case-insensitively with “plan”, and returns true if there is an exact word match.

**Call relations**: Other chat-widget logic can use this to decide whether to show plan-mode nudges while keeping the text-matching rule simple and predictable.


##### `ThreadItemRenderSource::is_replay`  (lines 826–828)

```
fn is_replay(self) -> bool
```

**Purpose**: Tells whether a thread item is being rendered from saved history rather than from live activity. That distinction matters because replayed content should not always trigger live-side effects.

**Data flow**: It reads the enum value and returns true for replay sources and false for live sources.

**Call relations**: handle_thread_item calls this when deciding how to treat an incoming thread item, especially whether to behave as if the user or agent just did something live.

*Call graph*: called by 1 (handle_thread_item); 1 external calls (matches!).


##### `ThreadItemRenderSource::replay_kind`  (lines 830–835)

```
fn replay_kind(self) -> Option<ReplayKind>
```

**Purpose**: Returns what kind of replay is happening, if any. This lets callers distinguish resumed initial messages from full thread snapshot playback.

**Data flow**: It reads the enum value. Live input becomes None; replay input becomes the stored ReplayKind.

**Call relations**: handle_thread_item calls this when it needs more detail than a simple live-versus-replay answer.

*Call graph*: called by 1 (handle_thread_item).


##### `exec_approval_request_from_params`  (lines 838–859)

```
fn exec_approval_request_from_params(
    params: CommandExecutionRequestApprovalParams,
    fallback_cwd: &AbsolutePathBuf,
) -> ExecApprovalRequestEvent
```

**Purpose**: Converts an app-server command-approval request into the TUI’s internal approval event. This lets the approval popup show the command, working directory, reason, and permission choices in the format the UI expects.

**Data flow**: It receives protocol parameters and a fallback working directory. It splits the command text into command parts, fills in the working directory if the server did not provide one, copies approval metadata, and returns an ExecApprovalRequestEvent.

**Call relations**: This is an adapter between the app-server protocol and the bottom-pane approval flow. Later UI code can work with one local approval type instead of raw server parameters.


##### `patch_approval_request_from_params`  (lines 861–871)

```
fn patch_approval_request_from_params(
    params: FileChangeRequestApprovalParams,
) -> ApplyPatchApprovalRequestEvent
```

**Purpose**: Converts an app-server file-change approval request into the TUI’s internal patch-approval event. It prepares the request for the approval UI.

**Data flow**: It receives protocol parameters, copies identifiers and the reason, starts with an empty change map, and returns an ApplyPatchApprovalRequestEvent.

**Call relations**: This adapter lets file-change approval handling use the same internal event type as other TUI approval flows.

*Call graph*: 1 external calls (new).


##### `request_permissions_from_params`  (lines 873–885)

```
fn request_permissions_from_params(
    params: codex_app_server_protocol::PermissionsRequestApprovalParams,
) -> std::io::Result<RequestPermissionsEvent>
```

**Purpose**: Converts a server request for broader permissions into the TUI’s internal permission request. It can fail if the protocol permission list cannot be converted.

**Data flow**: It receives server parameters, converts the permission description into the internal type, attaches identifiers, timing, reason, and current directory, and returns either the request event or an input-output error.

**Call relations**: This prepares permission prompts for the UI layer, separating protocol decoding from the code that shows or routes the prompt.


##### `token_usage_info_from_app_server`  (lines 887–905)

```
fn token_usage_info_from_app_server(token_usage: ThreadTokenUsage) -> TokenUsageInfo
```

**Purpose**: Translates token usage reported by the app server into the local token-usage structure. Tokens are pieces of text counted by the model, and this data powers context-window displays.

**Data flow**: It receives total and last-turn token counts from the protocol. It copies each count into local TokenUsage values and returns a TokenUsageInfo object with the optional model context window.

**Call relations**: Later token display code can use the local structure without knowing the app-server protocol shape.


##### `ChatWidget::set_collab_agent_metadata`  (lines 914–927)

```
fn set_collab_agent_metadata(
        &mut self,
        thread_id: ThreadId,
        agent_nickname: Option<String>,
        agent_role: Option<String>,
    )
```

**Purpose**: Stores the nickname and role for a collaborative agent thread. This makes notifications and transcript entries show a friendly label instead of a raw thread id.

**Data flow**: It receives a thread id plus optional nickname and role, wraps them in AgentMetadata, and inserts or replaces that entry in the widget’s metadata map.

**Call relations**: replace_chat_widget calls this when rebuilding the chat widget so agent metadata survives and stays aligned with the navigation cache.

*Call graph*: called by 1 (replace_chat_widget).


##### `ChatWidget::collab_agent_metadata`  (lines 930–935)

```
fn collab_agent_metadata(&self, thread_id: ThreadId) -> AgentMetadata
```

**Purpose**: Looks up the friendly metadata for a collaborative agent thread. If nothing was saved, it returns an empty default instead of failing.

**Data flow**: It receives a thread id, checks the internal metadata map, clones the saved metadata if present, or returns a default metadata value.

**Call relations**: Rendering and notification code can call this before showing an agent-related item so the UI has the best available label.


##### `ChatWidget::restore_retry_status_header_if_present`  (lines 937–941)

```
fn restore_retry_status_header_if_present(&mut self)
```

**Purpose**: Restores a saved status header after retry-related UI state has temporarily replaced it. This keeps the status area from getting stuck on retry text.

**Data flow**: It asks status_state for a saved retry header. If one is returned, it installs it as the current status header.

**Call relations**: It depends on status_state.take_retry_status_header, and it fits into flows that temporarily alter the status header during retry handling.

*Call graph*: calls 1 internal fn (take_retry_status_header).


##### `ChatWidget::record_agent_markdown`  (lines 944–948)

```
fn record_agent_markdown(&mut self, message: &str)
```

**Purpose**: Stores the raw markdown text for the current assistant turn. This is useful for transcript copying or later processing that needs the original model text.

**Data flow**: It receives a message string. If it is not empty, it copies the text into transcript state as agent markdown.

**Call relations**: Streaming and message-handling code can call this as assistant text arrives so the transcript has both rendered output and original markdown.

*Call graph*: calls 1 internal fn (record_agent_markdown).


##### `ChatWidget::record_visible_user_turn_for_copy`  (lines 950–952)

```
fn record_visible_user_turn_for_copy(&mut self)
```

**Purpose**: Marks that a user turn is visible in the transcript and should count for copy-history behavior. This helps copy features know where user-visible conversation turns occur.

**Data flow**: It reads no external input and updates transcript state to record a visible user turn.

**Call relations**: on_user_message_display calls this before adding a visible user prompt to history.

*Call graph*: calls 1 internal fn (record_visible_user_turn); called by 1 (on_user_message_display).


##### `ChatWidget::open_feedback_note`  (lines 954–960)

```
fn open_feedback_note(
        &mut self,
        category: crate::app_event::FeedbackCategory,
        include_logs: bool,
    )
```

**Purpose**: Opens the feedback note UI for a chosen feedback category. It is a public wrapper used by other parts of the app.

**Data flow**: It receives the feedback category and whether logs should be included, then passes both to show_feedback_note.

**Call relations**: This function delegates the actual view creation to show_feedback_note, keeping the external entry point small.

*Call graph*: calls 1 internal fn (show_feedback_note).


##### `ChatWidget::show_feedback_note`  (lines 962–975)

```
fn show_feedback_note(
        &mut self,
        category: crate::app_event::FeedbackCategory,
        include_logs: bool,
    )
```

**Purpose**: Creates and displays the feedback note form in the bottom pane. It also asks the UI to redraw so the form appears immediately.

**Data flow**: It receives a category and log-inclusion flag, builds a FeedbackNoteView using the last turn id and event sender, installs that view in the bottom pane, and schedules a redraw.

**Call relations**: open_feedback_note calls this. It hands off to the bottom pane, which owns modal views shown below the transcript.

*Call graph*: calls 3 internal fn (show_view, new, request_redraw); called by 1 (open_feedback_note); 2 external calls (new, clone).


##### `ChatWidget::open_app_link_view`  (lines 977–985)

```
fn open_app_link_view(&mut self, params: crate::bottom_pane::AppLinkViewParams)
```

**Purpose**: Shows a bottom-pane view for linking or opening an app connection. It wires the view to the current app-event sender and list keymap.

**Data flow**: It receives view parameters, creates an AppLinkView with those parameters and UI key bindings, displays it in the bottom pane, and schedules a redraw.

**Call relations**: This is used when an app-link flow needs to interrupt the normal composer and ask the user to act.

*Call graph*: calls 4 internal fn (list_keymap, show_view, new_with_keymap, request_redraw); 2 external calls (new, clone).


##### `ChatWidget::dismiss_app_server_request`  (lines 987–995)

```
fn dismiss_app_server_request(&mut self, request: &ResolvedAppServerRequest)
```

**Purpose**: Removes an app-server request that has already been resolved somewhere else. This prevents the user from acting on a stale approval or prompt.

**Data flow**: It receives the resolved request, removes matching deferred prompts from the interrupt manager, asks the bottom pane to dismiss a visible matching request, and redraws if anything changed.

**Call relations**: It coordinates two places where a request might live: queued behind streaming in interrupts, or currently visible in the bottom pane.

*Call graph*: calls 3 internal fn (dismiss_app_server_request, request_redraw, remove_resolved_prompt).


##### `ChatWidget::open_feedback_consent`  (lines 997–1016)

```
fn open_feedback_consent(&mut self, category: crate::app_event::FeedbackCategory)
```

**Purpose**: Shows a consent prompt before uploading feedback details and optional logs. This gives the user control over what diagnostic information is sent.

**Data flow**: It receives a feedback category, takes a snapshot of available feedback diagnostics, checks whether a Windows sandbox log exists on Windows, builds selection-view parameters, shows them, and redraws.

**Call relations**: This starts the feedback-upload consent flow by handing a configured selection view to the bottom pane.

*Call graph*: calls 3 internal fn (snapshot, show_selection_view, request_redraw); 3 external calls (current_log_file_path_for_codex_home, feedback_upload_consent_params, clone).


##### `ChatWidget::open_multi_agent_enable_prompt`  (lines 1018–1051)

```
fn open_multi_agent_enable_prompt(&mut self)
```

**Purpose**: Shows a prompt asking whether to enable subagents. The prompt explains that the setting will apply in a future session.

**Data flow**: It builds two selection items: one that sends a feature-flag update and inserts a notice, and one that dismisses the prompt. It then shows those choices in the bottom pane.

**Call relations**: This function is used when a multi-agent feature is requested but currently disabled in configuration.

*Call graph*: calls 2 internal fn (show_selection_view, standard_popup_hint_line); 2 external calls (default, vec!).


##### `ChatWidget::open_memories_popup`  (lines 1053–1066)

```
fn open_memories_popup(&mut self)
```

**Purpose**: Opens the memory settings UI if memories are enabled, or an enable prompt if they are not. Memories are saved facts the assistant can use in future sessions.

**Data flow**: It checks the feature flag. If disabled, it calls open_memories_enable_prompt. If enabled, it creates a MemoriesSettingsView with current settings and key bindings and shows it in the bottom pane.

**Call relations**: This is the main entry point for memory-related UI; it delegates the disabled-feature case to open_memories_enable_prompt.

*Call graph*: calls 4 internal fn (list_keymap, show_view, new, open_memories_enable_prompt); 2 external calls (new, clone).


##### `ChatWidget::open_memories_enable_prompt`  (lines 1068–1102)

```
fn open_memories_enable_prompt(&mut self)
```

**Purpose**: Shows a prompt asking whether to enable the memories feature. It includes a documentation link so users can learn what the feature does.

**Data flow**: It builds Yes and No selection items. The Yes action sends a feature-flag update; both choices dismiss the prompt. It then shows the selection view in the bottom pane.

**Call relations**: open_memories_popup calls this when the memory feature is currently disabled.

*Call graph*: calls 2 internal fn (show_selection_view, standard_popup_hint_line); called by 1 (open_memories_popup); 3 external calls (default, from, vec!).


##### `ChatWidget::set_memory_settings`  (lines 1104–1107)

```
fn set_memory_settings(&mut self, use_memories: bool, generate_memories: bool)
```

**Purpose**: Updates the in-session memory settings stored in the widget’s config. This reflects user choices from the memory settings UI.

**Data flow**: It receives two booleans, one for using memories and one for generating memories, and writes them into the config copy held by ChatWidget.

**Call relations**: Memory settings views can call this after the user changes memory preferences so later UI state reflects the new values.


##### `ChatWidget::set_token_info`  (lines 1109–1118)

```
fn set_token_info(&mut self, info: Option<TokenUsageInfo>)
```

**Purpose**: Sets or clears the token-usage display. Tokens are the model’s text units, and this information helps users understand how much context is being used.

**Data flow**: It receives optional TokenUsageInfo. If present, it passes it to apply_token_info; if absent, it clears the bottom-pane context display and removes stored token info.

**Call relations**: handle_token_count calls this when fresh token-count information arrives.

*Call graph*: calls 2 internal fn (set_context_window, apply_token_info); called by 1 (handle_token_count).


##### `ChatWidget::apply_token_info`  (lines 1120–1125)

```
fn apply_token_info(&mut self, info: TokenUsageInfo)
```

**Purpose**: Applies token usage to both internal state and the bottom-pane display. It chooses whether to show remaining percentage or a raw token count.

**Data flow**: It receives TokenUsageInfo, computes the remaining-context percent if a context window is known, computes used tokens when percent is not known, updates the bottom pane, and saves the info.

**Call relations**: set_token_info and restore_pre_review_token_info call this when token information should be visible again.

*Call graph*: calls 3 internal fn (set_context_window, context_remaining_percent, context_used_tokens); called by 2 (restore_pre_review_token_info, set_token_info).


##### `ChatWidget::context_remaining_percent`  (lines 1127–1132)

```
fn context_remaining_percent(&self, info: &TokenUsageInfo) -> Option<i64>
```

**Purpose**: Computes how much of the model’s context window remains, as a percentage, when the model’s context size is known.

**Data flow**: It receives token info, reads the optional context-window size, and if present asks the last-turn token usage to compute remaining percentage.

**Call relations**: apply_token_info calls this before updating the bottom-pane context display.

*Call graph*: called by 1 (apply_token_info).


##### `ChatWidget::context_used_tokens`  (lines 1134–1140)

```
fn context_used_tokens(&self, info: &TokenUsageInfo, percent_known: bool) -> Option<i64>
```

**Purpose**: Chooses whether to show a raw count of used context tokens. It only shows this count when a percentage is not available.

**Data flow**: It receives token info and a flag saying whether percentage is known. If percentage is known it returns None; otherwise it returns the total tokens currently in the context window.

**Call relations**: apply_token_info calls this as the fallback display value when it cannot show a context percentage.

*Call graph*: called by 1 (apply_token_info).


##### `ChatWidget::restore_pre_review_token_info`  (lines 1142–1153)

```
fn restore_pre_review_token_info(&mut self)
```

**Purpose**: Restores the token display that was visible before code review mode changed it. This avoids leaving review-specific token state on screen.

**Data flow**: It takes saved pre-review token info from review state. If it contains info, it reapplies it; if it says there was no info, it clears the context display and stored token info.

**Call relations**: exit_review_mode_after_item calls this when review mode ends.

*Call graph*: calls 2 internal fn (set_context_window, apply_token_info); called by 1 (exit_review_mode_after_item).


##### `ChatWidget::handle_history_entry_response`  (lines 1155–1163)

```
fn handle_history_entry_response(&mut self, event: HistoryLookupResponse)
```

**Purpose**: Delivers an asynchronous message-history lookup result to the composer area. This supports browsing or recalling prior messages.

**Data flow**: It receives a lookup response, unpacks the offset, log id, and entry, and forwards them to the bottom pane.

**Call relations**: The bottom pane owns the composer history UI, so ChatWidget simply routes the response there.

*Call graph*: calls 1 internal fn (on_history_entry_response).


##### `ChatWidget::pre_draw_tick`  (lines 1165–1182)

```
fn pre_draw_tick(&mut self)
```

**Purpose**: Performs small time-based updates just before drawing the screen. This keeps animations, hints, pets, hooks, goal status, and terminal-title state fresh.

**Data flow**: It reads current widget state, updates hook visibility and timers, ticks the bottom pane, schedules pet frames, refreshes plan and goal hints, and refreshes the terminal title when its animated or action-required state changes.

**Call relations**: handle_tui_event and several hook-related redraw paths call this before rendering so time-sensitive UI pieces are current.

*Call graph*: calls 1 internal fn (pre_draw_tick); called by 5 (handle_tui_event, show_shutdown_feedback, expire_quiet_hook_linger, reveal_running_hooks, reveal_running_hooks_after_delayed_redraw).


##### `ChatWidget::flush_active_cell`  (lines 1184–1190)

```
fn flush_active_cell(&mut self)
```

**Purpose**: Moves the current in-progress transcript cell into committed history. This turns live output into a permanent transcript entry.

**Data flow**: It takes the active cell out of transcript state. If one exists, it marks that a separator may be needed, sends an InsertHistoryCell app event, and requests pending usage-output insertion.

**Call relations**: add_boxed_history, add_mcp_output, apply_session_info_cell, and exit_review_mode_after_item call this before adding new committed content or changing modes.

*Call graph*: calls 1 internal fn (send); called by 4 (add_boxed_history, add_mcp_output, apply_session_info_cell, exit_review_mode_after_item); 1 external calls (InsertHistoryCell).


##### `ChatWidget::add_to_history`  (lines 1192–1194)

```
fn add_to_history(&mut self, cell: impl HistoryCell + 'static)
```

**Purpose**: Adds a typed history cell to the transcript. It is a convenience wrapper for callers that have a concrete cell value.

**Data flow**: It receives a history cell, boxes it as a trait object, and passes it to add_boxed_history.

**Call relations**: Many user-facing message helpers call this, including info, warning, error, debug, process-list, and review-status insertions.

*Call graph*: calls 1 internal fn (add_boxed_history); called by 9 (add_debug_config_output, add_error_message, add_info_message, add_memories_enable_notice, add_ps_output, add_warning_message, enter_review_mode_with_hint, exit_review_mode_after_item, on_user_message_display); 1 external calls (new).


##### `ChatWidget::add_boxed_history`  (lines 1196–1217)

```
fn add_boxed_history(&mut self, cell: Box<dyn HistoryCell>)
```

**Purpose**: Adds a boxed history cell while preserving transcript grouping rules. It decides when live output must be flushed before the new cell is inserted.

**Data flow**: It receives a boxed HistoryCell, checks whether it has visible lines, records turn activity if an agent turn is running, keeps a placeholder session header active when needed, flushes active cells when appropriate, and sends an InsertHistoryCell event.

**Call relations**: add_to_history and several lower-level flows call this when they need exact control over committed transcript insertion.

*Call graph*: calls 2 internal fn (send, flush_active_cell); called by 4 (add_plain_history_lines, add_to_history, apply_session_info_cell, finalize_active_cell_as_failed); 1 external calls (InsertHistoryCell).


##### `ChatWidget::enter_review_mode_with_hint`  (lines 1219–1230)

```
fn enter_review_mode_with_hint(&mut self, hint: String, from_replay: bool)
```

**Purpose**: Starts code review mode and shows a visible banner explaining what review began. It also preserves token display state so it can be restored later.

**Data flow**: It receives a hint string and whether the transition came from replay. It saves current token info if needed, marks the task as running for live review, enables review mode, inserts a review-start status line, and redraws.

**Call relations**: Review flows call this when the app enters review mode; exit_review_mode_after_item is the matching cleanup path.

*Call graph*: calls 4 internal fn (is_task_running, set_task_running, add_to_history, request_redraw); 2 external calls (format!, new_review_status_line).


##### `ChatWidget::exit_review_mode_after_item`  (lines 1232–1242)

```
fn exit_review_mode_after_item(&mut self)
```

**Purpose**: Ends code review mode after the relevant item finishes. It flushes live content, restores previous token info, and adds a review-finished banner.

**Data flow**: It flushes answer streaming, deferred interrupts, and the active cell, turns off review mode, restores pre-review token information, inserts a finished status line, and redraws.

**Call relations**: This is the counterpart to enter_review_mode_with_hint and is called when a review item is complete.

*Call graph*: calls 4 internal fn (add_to_history, flush_active_cell, request_redraw, restore_pre_review_token_info); 1 external calls (new_review_status_line).


##### `ChatWidget::on_committed_user_message`  (lines 1244–1342)

```
fn on_committed_user_message(&mut self, items: &[UserInput], from_replay: bool)
```

**Purpose**: Responds when a user message becomes part of the committed thread. It avoids double-rendering messages that were already previewed or replayed.

**Data flow**: It receives user-input items and a replay flag. For replay, it reconstructs display text, mention bindings, and history entries, then records and renders them. For live input, it compares against pending queued messages and renders only when needed.

**Call relations**: It hands actual prompt rendering to on_user_message_display and also records replayed messages in the bottom-pane history.

*Call graph*: calls 3 internal fn (record_replayed_user_message_history, on_user_message_display, user_message_display_for_history); 5 external calls (pending_steer_compare_key_from_items, user_message_display_from_inputs, new, iter, warn!).


##### `ChatWidget::on_user_message_display`  (lines 1344–1362)

```
fn on_user_message_display(&mut self, display: UserMessageDisplay)
```

**Purpose**: Adds a user prompt to visible history and records it for copy behavior. Empty prompts with no attachments are ignored.

**Data flow**: It receives a prepared UserMessageDisplay, stores it as the last rendered display, checks whether it contains text or attachments, records a visible user turn, inserts a user-prompt history cell, and resets separator state.

**Call relations**: on_committed_user_message calls this after deciding that a user message should actually appear in the transcript.

*Call graph*: calls 2 internal fn (add_to_history, record_visible_user_turn_for_copy); called by 1 (on_committed_user_message); 2 external calls (new_user_prompt, clone).


##### `ChatWidget::request_immediate_exit`  (lines 1368–1370)

```
fn request_immediate_exit(&self)
```

**Purpose**: Requests that the TUI exit immediately. This is meant for fallback or already-finished shutdown situations, not the usual user quit path.

**Data flow**: It sends an AppEvent::Exit with Immediate mode through the app event sender.

**Call relations**: Other shutdown logic can call this when waiting for graceful shutdown is no longer appropriate.

*Call graph*: calls 1 internal fn (send); 1 external calls (Exit).


##### `ChatWidget::request_quit_without_confirmation`  (lines 1376–1379)

```
fn request_quit_without_confirmation(&self)
```

**Purpose**: Requests a graceful shutdown-first quit without asking for more confirmation. This is used for explicit quit commands and double-press quit shortcuts.

**Data flow**: It sends an AppEvent::Exit with ShutdownFirst mode through the app event sender.

**Call relations**: Quit-handling code calls this when the user has clearly chosen to leave but the app should still shut down cleanly.

*Call graph*: calls 1 internal fn (send); 1 external calls (Exit).


##### `ChatWidget::show_shutdown_in_progress`  (lines 1381–1383)

```
fn show_shutdown_in_progress(&mut self)
```

**Purpose**: Shows the user that shutdown is underway. This prevents the interface from looking frozen after a quit request.

**Data flow**: It tells the bottom pane to show its shutdown-in-progress state.

**Call relations**: show_shutdown_feedback calls this while the app is winding down.

*Call graph*: calls 1 internal fn (show_shutdown_in_progress); called by 1 (show_shutdown_feedback).


##### `ChatWidget::request_redraw`  (lines 1385–1387)

```
fn request_redraw(&mut self)
```

**Purpose**: Schedules the terminal UI to repaint. It is the common “something changed” signal inside ChatWidget.

**Data flow**: It calls the frame requester to schedule a new frame; it does not draw immediately.

**Call relations**: Many flows call this after changing visible state, including message insertion, popups, resize handling, MCP loading, and feedback views.

*Call graph*: calls 1 internal fn (schedule_frame); called by 17 (add_diff_in_progress, add_error_message, add_info_message, add_mcp_output, add_memories_enable_notice, add_plain_history_lines, add_warning_message, clear_mcp_inventory_loading, dismiss_app_server_request, enter_review_mode_with_hint (+7 more)).


##### `ChatWidget::bump_active_cell_revision`  (lines 1389–1391)

```
fn bump_active_cell_revision(&mut self)
```

**Purpose**: Marks the active transcript cell as changed. This helps cached transcript overlays know they must refresh their live tail.

**Data flow**: It increments or updates the active-cell revision inside transcript state.

**Call relations**: add_mcp_output and clear_mcp_inventory_loading call this when the live MCP loading cell appears or disappears.

*Call graph*: calls 1 internal fn (bump_active_cell_revision); called by 2 (add_mcp_output, clear_mcp_inventory_loading).


##### `ChatWidget::finalize_active_cell_as_failed`  (lines 1394–1405)

```
fn finalize_active_cell_as_failed(&mut self)
```

**Purpose**: Marks the current active tool or command cell as failed and commits it to history. This makes failures visible instead of leaving a live spinner behind.

**Data flow**: It takes the active cell, checks whether it is an exec or MCP tool cell, marks that cell failed when possible, adds it to history, and requests pending usage-output insertion.

**Call relations**: Failure paths can use this to close out live cells consistently before continuing with later transcript content.

*Call graph*: calls 1 internal fn (add_boxed_history).


##### `ChatWidget::set_pending_thread_approvals`  (lines 1407–1409)

```
fn set_pending_thread_approvals(&mut self, threads: Vec<String>)
```

**Purpose**: Updates the bottom pane with threads that are waiting for approval. This gives the user a visible indication of pending decisions.

**Data flow**: It receives a list of thread identifiers and forwards it to the bottom pane.

**Call relations**: Thread approval tracking code uses this to keep the footer or approval UI current.

*Call graph*: calls 1 internal fn (set_pending_thread_approvals).


##### `ChatWidget::clear_thread_rename_block`  (lines 1411–1413)

```
fn clear_thread_rename_block(&mut self)
```

**Purpose**: Clears the message that blocks thread renaming. This allows rename UI to proceed again once the blocking condition is gone.

**Data flow**: It sets the stored thread_rename_block_message to None.

**Call relations**: Rename-related flows can call this after a previous rename restriction no longer applies.


##### `ChatWidget::set_thread_rename_block_message`  (lines 1415–1417)

```
fn set_thread_rename_block_message(&mut self, message: impl Into<String>)
```

**Purpose**: Stores a reason that thread renaming is currently blocked. The UI can show this message instead of allowing a rename.

**Data flow**: It receives any string-like message, converts it into a String, and saves it in thread_rename_block_message.

**Call relations**: Rename validation or app-server responses can call this to explain why a rename cannot happen.

*Call graph*: 1 external calls (into).


##### `ChatWidget::set_interrupted_turn_notice_mode`  (lines 1419–1421)

```
fn set_interrupted_turn_notice_mode(&mut self, mode: InterruptedTurnNoticeMode)
```

**Purpose**: Changes how the widget should show notices for interrupted turns. This lets some flows suppress the normal interruption message.

**Data flow**: It receives an InterruptedTurnNoticeMode value and stores it.

**Call relations**: Interrupt-handling code can set this before or during turn cancellation to control later user-facing messages.


##### `ChatWidget::add_diff_in_progress`  (lines 1423–1425)

```
fn add_diff_in_progress(&mut self)
```

**Purpose**: Notifies the UI that diff-related work has begun by requesting a redraw. A diff is a view of file changes.

**Data flow**: It does not store new data; it simply schedules a new frame.

**Call relations**: Diff-start flows call this so any current progress indicators or status changes can appear.

*Call graph*: calls 1 internal fn (request_redraw).


##### `ChatWidget::on_diff_complete`  (lines 1427–1429)

```
fn on_diff_complete(&mut self)
```

**Purpose**: Notifies the UI that diff-related work has finished by requesting a redraw. This lets progress indicators disappear or update.

**Data flow**: It schedules a new frame without changing other state directly.

**Call relations**: Diff-completion flows call this after file-change rendering or calculation finishes.

*Call graph*: calls 1 internal fn (request_redraw).


##### `ChatWidget::add_debug_config_output`  (lines 1431–1436)

```
fn add_debug_config_output(&mut self)
```

**Purpose**: Adds a debug view of the current configuration to the transcript. This helps users or developers inspect what settings are active.

**Data flow**: It reads the widget config and session network proxy state, builds a debug-config history cell, and adds it to history.

**Call relations**: Debug commands can call this to print configuration details in the same transcript as other chat output.

*Call graph*: calls 2 internal fn (add_to_history, new_debug_config_output).


##### `ChatWidget::add_ps_output`  (lines 1438–1448)

```
fn add_ps_output(&mut self)
```

**Purpose**: Adds a process-list style summary of background terminal commands to the transcript. This helps users see what background executions are still around.

**Data flow**: It reads stored unified exec process summaries, converts each to display details, builds a history cell, and adds it to history.

**Call relations**: Process-inspection commands can call this to show background command state.

*Call graph*: calls 1 internal fn (add_to_history); 1 external calls (new_unified_exec_processes_output).


##### `ChatWidget::clean_background_terminals`  (lines 1450–1458)

```
fn clean_background_terminals(&mut self)
```

**Purpose**: Requests that all background terminals stop, clears the local process summary, updates the footer, and tells the user what happened.

**Data flow**: It submits a clean-background-terminals command, clears the stored process list, syncs the exec footer, and adds an informational transcript message.

**Call relations**: It uses submit_op to send the cleanup request and add_info_message to make the action visible to the user.

*Call graph*: calls 2 internal fn (add_info_message, submit_op); 1 external calls (clean_background_terminals).


##### `ChatWidget::plugins_for_mentions`  (lines 1460–1466)

```
fn plugins_for_mentions(&self) -> Option<&[PluginCapabilitySummary]>
```

**Purpose**: Returns the plugin list that can be used for @-style mentions, but only when the plugins feature is enabled.

**Data flow**: It checks the feature flag. If plugins are disabled, it returns None; otherwise it returns the bottom pane’s plugin list as a slice if available.

**Call relations**: Mention-building code can use this to decide whether plugin names should appear in mention suggestions.

*Call graph*: calls 1 internal fn (plugins).


##### `ChatWidget::placeholder_session_header_cell`  (lines 1469–1482)

```
fn placeholder_session_header_cell(config: &Config) -> Box<dyn HistoryCell>
```

**Purpose**: Builds a temporary session header while real session information is still loading. This avoids showing a blank transcript at startup.

**Data flow**: It receives config, creates a dim italic session header using a loading model name, current directory, CLI version, and yolo-mode state, then returns it boxed as a history cell.

**Call relations**: Session startup code can install this placeholder and later replace or merge it through apply_session_info_cell.

*Call graph*: calls 1 internal fn (new_with_style); 3 external calls (new, default, is_yolo_mode).


##### `ChatWidget::apply_session_info_cell`  (lines 1485–1510)

```
fn apply_session_info_cell(&mut self, cell: history_cell::SessionInfoCell)
```

**Purpose**: Installs the real session information cell without duplicating the startup placeholder. It keeps the transcript tidy during startup.

**Data flow**: It receives a real session info cell, checks whether the active cell is a placeholder session header, replaces it when possible, flushes the active cell, and otherwise adds the real cell to history.

**Call relations**: This is the transition from placeholder startup UI to real configured-session UI. It uses flush_active_cell and add_boxed_history to preserve transcript ordering.

*Call graph*: calls 2 internal fn (add_boxed_history, flush_active_cell); 1 external calls (new).


##### `ChatWidget::add_info_message`  (lines 1512–1515)

```
fn add_info_message(&mut self, message: String, hint: Option<String>)
```

**Purpose**: Adds an informational message to the transcript and redraws. It is used for neutral status updates that the user should see.

**Data flow**: It receives a message and optional hint, builds an info history cell, inserts it, and schedules a redraw.

**Call relations**: clean_background_terminals, set_raw_output_mode_and_notify, and toggle_vim_mode_and_notify call this to confirm user-visible changes.

*Call graph*: calls 2 internal fn (add_to_history, request_redraw); called by 3 (clean_background_terminals, set_raw_output_mode_and_notify, toggle_vim_mode_and_notify); 1 external calls (new_info_event).


##### `ChatWidget::add_memories_enable_notice`  (lines 1517–1522)

```
fn add_memories_enable_notice(&mut self)
```

**Purpose**: Adds the standard notice that memories will be enabled in the next session. This confirms the user’s feature choice.

**Data flow**: It builds a warning-style history cell containing the memory enable notice, adds it to history, and redraws.

**Call relations**: Memory enable flows can call this after the feature flag has been changed.

*Call graph*: calls 2 internal fn (add_to_history, request_redraw); 1 external calls (new_warning_event).


##### `ChatWidget::add_plain_history_lines`  (lines 1524–1527)

```
fn add_plain_history_lines(&mut self, lines: Vec<Line<'static>>)
```

**Purpose**: Adds already-formatted plain lines to the transcript. This is useful when another part of the UI has prepared the exact text layout.

**Data flow**: It receives a vector of terminal text lines, wraps them in a PlainHistoryCell, commits that cell, and schedules a redraw.

**Call relations**: Callers use this when they need simple transcript output without a special warning, error, or info style.

*Call graph*: calls 3 internal fn (add_boxed_history, request_redraw, new); 1 external calls (new).


##### `ChatWidget::add_warning_message`  (lines 1529–1532)

```
fn add_warning_message(&mut self, message: String)
```

**Purpose**: Adds a warning message to the transcript and redraws. Warnings are for important user-visible issues that are not necessarily fatal errors.

**Data flow**: It receives message text, builds a warning history cell, inserts it, and schedules a redraw.

**Call relations**: Warning-producing flows can call this to surface a caution in the main chat history.

*Call graph*: calls 2 internal fn (add_to_history, request_redraw); 1 external calls (new_warning_event).


##### `ChatWidget::add_error_message`  (lines 1534–1537)

```
fn add_error_message(&mut self, message: String)
```

**Purpose**: Adds an error message to the transcript and redraws. This gives failures a consistent visible style.

**Data flow**: It receives message text, builds an error history cell, inserts it, and schedules a redraw.

**Call relations**: add_app_server_stub_message calls this when the user reaches an unsupported app-server feature in the TUI.

*Call graph*: calls 2 internal fn (add_to_history, request_redraw); called by 1 (add_app_server_stub_message); 1 external calls (new_error_event).


##### `ChatWidget::add_app_server_stub_message`  (lines 1539–1542)

```
fn add_app_server_stub_message(&mut self, feature: &str)
```

**Purpose**: Shows a clear error for an app-server feature that is not implemented in the TUI yet. It also logs a warning for developers.

**Data flow**: It receives a feature name, logs that the feature is stubbed, formats a user-facing unsupported-feature message, and adds it as an error.

**Call relations**: Unsupported feature paths call this instead of failing silently.

*Call graph*: calls 1 internal fn (add_error_message); 2 external calls (format!, warn!).


##### `ChatWidget::rename_confirmation_cell`  (lines 1544–1554)

```
fn rename_confirmation_cell(name: &str, thread_id: Option<ThreadId>) -> PlainHistoryCell
```

**Purpose**: Builds a small transcript cell confirming that the session was renamed. When possible, it includes a command hint for resuming that session later.

**Data flow**: It receives the new name and optional thread id, formats a confirmation line, asks for a resume hint, appends that hint if available, and returns a PlainHistoryCell.

**Call relations**: Thread rename flows can insert the returned cell into history after a successful rename.

*Call graph*: calls 1 internal fn (new); 2 external calls (resume_hint, vec!).


##### `ChatWidget::add_mcp_output`  (lines 1561–1573)

```
fn add_mcp_output(&mut self, detail: McpServerStatusDetail)
```

**Purpose**: Starts the MCP inventory display flow. MCP servers are external tool servers; this shows a loading cell while the app server gathers their status.

**Data flow**: It flushes current answer and active cells, sets a new MCP loading cell as the active cell, bumps the active-cell revision, redraws, and sends a FetchMcpInventory event with detail and thread id.

**Call relations**: clear_mcp_inventory_loading is the cleanup partner that removes the spinner when the inventory result arrives.

*Call graph*: calls 5 internal fn (send, bump_active_cell_revision, flush_active_cell, request_redraw, thread_id); 2 external calls (new, new_mcp_inventory_loading).


##### `ChatWidget::clear_mcp_inventory_loading`  (lines 1579–1592)

```
fn clear_mcp_inventory_loading(&mut self)
```

**Purpose**: Removes the MCP loading spinner if it is still the live active cell. It carefully avoids clearing unrelated content that may have appeared later.

**Data flow**: It checks whether the active cell exists and is specifically an MCP inventory loading cell. If so, it clears it, bumps the active-cell revision, and redraws.

**Call relations**: This finishes the loading state started by add_mcp_output.

*Call graph*: calls 2 internal fn (bump_active_cell_revision, request_redraw).


##### `ChatWidget::apply_file_search_result`  (lines 1595–1597)

```
fn apply_file_search_result(&mut self, query: String, matches: Vec<FileMatch>)
```

**Purpose**: Forwards file-search results to the bottom pane. This supports mention or file-picking UI in the composer.

**Data flow**: It receives the original query and matching files, then passes both to the bottom pane’s file-search result handler.

**Call relations**: Search result events are routed through ChatWidget because it owns the bottom pane instance.

*Call graph*: calls 1 internal fn (on_file_search_result).


##### `ChatWidget::current_stream_width`  (lines 1604–1614)

```
fn current_stream_width(&self, reserved_cols: usize) -> Option<usize>
```

**Purpose**: Computes the text width available for live streamed output. This keeps streaming text wrapping close to how finalized history cells will wrap.

**Data flow**: It reads the last rendered terminal width, subtracts history wrapping and reserved columns, and returns a usable content width if the terminal width is known and nonzero.

**Call relations**: on_terminal_resize calls this to update stream controllers after the terminal changes size.

*Call graph*: called by 1 (on_terminal_resize).


##### `ChatWidget::raw_output_mode`  (lines 1616–1618)

```
fn raw_output_mode(&self) -> bool
```

**Purpose**: Reports whether raw output mode is enabled. Raw mode favors clean selectable text over rich formatting.

**Data flow**: It returns the widget’s raw_output_mode boolean.

**Call relations**: Other UI code can query this when choosing how to render or display transcript content.


##### `ChatWidget::history_render_mode`  (lines 1620–1626)

```
fn history_render_mode(&self) -> HistoryRenderMode
```

**Purpose**: Chooses the transcript render mode based on raw-output setting. It maps a simple boolean into the render-mode type used by history cells and stream controllers.

**Data flow**: It reads raw_output_mode and returns HistoryRenderMode::Raw when enabled, otherwise HistoryRenderMode::Rich.

**Call relations**: set_raw_output_mode calls this before updating active stream controllers.

*Call graph*: called by 1 (set_raw_output_mode).


##### `ChatWidget::set_raw_output_mode`  (lines 1628–1639)

```
fn set_raw_output_mode(&mut self, enabled: bool)
```

**Purpose**: Turns raw transcript output on or off and updates stream rendering to match. This lets the user switch between rich display and easier terminal text selection.

**Data flow**: It receives the desired enabled flag, stores it in widget state and config, computes the render mode, updates any active assistant or plan stream controller, and refreshes status surfaces.

**Call relations**: set_raw_output_mode_and_notify calls this before adding a user-visible notice.

*Call graph*: calls 1 internal fn (history_render_mode); called by 1 (set_raw_output_mode_and_notify).


##### `ChatWidget::raw_output_mode_notice`  (lines 1641–1647)

```
fn raw_output_mode_notice(enabled: bool) -> &'static str
```

**Purpose**: Returns the message shown when raw output mode changes. This keeps the on/off wording consistent.

**Data flow**: It receives a boolean and returns one of two static strings explaining whether raw mode is now on or off.

**Call relations**: set_raw_output_mode_and_notify uses this text in the info message added to history.


##### `ChatWidget::set_raw_output_mode_and_notify`  (lines 1649–1655)

```
fn set_raw_output_mode_and_notify(&mut self, enabled: bool)
```

**Purpose**: Changes raw output mode and tells the user what changed. This is the user-facing version of the raw-mode setter.

**Data flow**: It receives the desired enabled flag, calls set_raw_output_mode, gets the matching notice text, and adds it as an info message.

**Call relations**: toggle_raw_output_mode_and_notify calls this after flipping the current setting.

*Call graph*: calls 2 internal fn (add_info_message, set_raw_output_mode); called by 1 (toggle_raw_output_mode_and_notify); 1 external calls (raw_output_mode_notice).


##### `ChatWidget::toggle_raw_output_mode_and_notify`  (lines 1657–1661)

```
fn toggle_raw_output_mode_and_notify(&mut self) -> bool
```

**Purpose**: Flips raw output mode and returns the new state. It also adds a transcript notice.

**Data flow**: It negates the current raw_output_mode value, applies it through set_raw_output_mode_and_notify, and returns the new boolean.

**Call relations**: Keyboard shortcuts or commands can call this when the user toggles raw output mode.

*Call graph*: calls 1 internal fn (set_raw_output_mode_and_notify).


##### `ChatWidget::on_terminal_resize`  (lines 1667–1682)

```
fn on_terminal_resize(&mut self, width: u16)
```

**Purpose**: Updates resize-sensitive chat state after the terminal width changes. This keeps live streamed text wrapping correctly.

**Data flow**: It receives the new width, stores it, calculates stream widths for normal and plan output, updates active stream controllers, syncs the active stream tail, and requests an initial redraw if this is the first known width.

**Call relations**: Terminal resize handling calls this so live output and later finalized transcript layout stay aligned.

*Call graph*: calls 2 internal fn (current_stream_width, request_redraw).


##### `ChatWidget::has_active_agent_stream`  (lines 1685–1687)

```
fn has_active_agent_stream(&self) -> bool
```

**Purpose**: Reports whether a normal assistant response is currently streaming. This excludes plan streams.

**Data flow**: It checks whether the main stream controller exists and returns a boolean.

**Call relations**: Other UI logic can use this to decide whether output is still arriving from the assistant.


##### `ChatWidget::has_active_plan_stream`  (lines 1690–1692)

```
fn has_active_plan_stream(&self) -> bool
```

**Purpose**: Reports whether a proposed plan is currently streaming. Plan output has its own controller and layout.

**Data flow**: It checks whether the plan stream controller exists and returns a boolean.

**Call relations**: Plan-mode UI code can use this to decide whether plan streaming is active.


##### `ChatWidget::is_plan_streaming_in_tui`  (lines 1694–1696)

```
fn is_plan_streaming_in_tui(&self) -> bool
```

**Purpose**: Checks whether plan streaming is active in the terminal UI. It is a private convenience wrapper.

**Data flow**: It returns true if the plan stream controller is present.

**Call relations**: Internal plan-related logic can call this when it needs a readable plan-streaming check.


##### `ChatWidget::composer_is_empty`  (lines 1698–1700)

```
fn composer_is_empty(&self) -> bool
```

**Purpose**: Reports whether the input composer currently has no user-entered content.

**Data flow**: It asks the bottom pane whether its composer is empty and returns that answer.

**Call relations**: Chat-level input handling uses this because the bottom pane owns the composer text.

*Call graph*: calls 1 internal fn (composer_is_empty).


##### `ChatWidget::is_task_running_for_test`  (lines 1703–1705)

```
fn is_task_running_for_test(&self) -> bool
```

**Purpose**: Exposes the bottom pane’s task-running state to tests. This helps tests check spinner or busy-state behavior.

**Data flow**: It asks the bottom pane whether a task is running and returns the result.

**Call relations**: This is compiled for tests and mirrors the same state used by normal UI busy indicators.

*Call graph*: calls 1 internal fn (is_task_running).


##### `ChatWidget::toggle_vim_mode_and_notify`  (lines 1707–1715)

```
fn toggle_vim_mode_and_notify(&mut self)
```

**Purpose**: Turns Vim-style editing mode on or off and adds a confirmation message. Vim mode means the composer uses keyboard behavior inspired by the Vim editor.

**Data flow**: It asks the bottom pane to toggle Vim mode, chooses an enabled or disabled message based on the result, and adds that message to history.

**Call relations**: User commands or shortcuts call this; it delegates editing-mode state to the bottom pane and uses add_info_message for feedback.

*Call graph*: calls 2 internal fn (toggle_vim_enabled, add_info_message).


##### `ChatWidget::is_normal_backtrack_mode`  (lines 1720–1722)

```
fn is_normal_backtrack_mode(&self) -> bool
```

**Purpose**: Reports whether the UI is in a plain composer state where Escape-Escape backtracking is allowed. Backtracking means stepping back through recent input or UI state.

**Data flow**: It asks the bottom pane whether it is in normal backtrack mode and returns the answer.

**Call relations**: Keyboard handling uses this check before treating Escape sequences as backtracking commands.

*Call graph*: calls 1 internal fn (is_normal_backtrack_mode).


##### `ChatWidget::should_handle_vim_insert_escape`  (lines 1724–1727)

```
fn should_handle_vim_insert_escape(&self, key_event: KeyEvent) -> bool
```

**Purpose**: Decides whether a given Escape key event should be handled by Vim insert-mode behavior in the composer.

**Data flow**: It receives a key event and asks the bottom pane’s composer logic whether Vim insert escape should consume it.

**Call relations**: Key handling calls this before applying chat-level Escape behavior.

*Call graph*: calls 1 internal fn (composer_should_handle_vim_insert_escape).


##### `ChatWidget::insert_str`  (lines 1729–1731)

```
fn insert_str(&mut self, text: &str)
```

**Purpose**: Inserts text into the composer. This is used when another UI action wants to add text as if the user typed it.

**Data flow**: It receives a string slice and forwards it to the bottom pane composer.

**Call relations**: ChatWidget owns the bottom pane, so external paste or insertion flows route through this method.

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

**Purpose**: Replaces the composer contents, including rich text elements and local image attachments. It also refreshes plan-mode nudges afterward.

**Data flow**: It receives text, text elements, and local image paths, passes them to the bottom pane, then refreshes the plan-mode nudge state.

**Call relations**: Restore, edit, or queued-message flows can call this when they need to put a full draft back into the composer.

*Call graph*: calls 1 internal fn (set_composer_text).


##### `ChatWidget::set_remote_image_urls`  (lines 1745–1747)

```
fn set_remote_image_urls(&mut self, remote_image_urls: Vec<String>)
```

**Purpose**: Sets remote image URLs attached to the current composer draft. These are images referenced by URL rather than local files.

**Data flow**: It receives a list of URL strings and forwards it to the bottom pane.

**Call relations**: Attachment-handling code uses this because the bottom pane owns draft attachments.

*Call graph*: calls 1 internal fn (set_remote_image_urls).


##### `ChatWidget::take_remote_image_urls`  (lines 1749–1751)

```
fn take_remote_image_urls(&mut self) -> Vec<String>
```

**Purpose**: Removes and returns the remote image URLs currently attached to the composer draft. This is useful when submitting a message.

**Data flow**: It asks the bottom pane to take its stored remote image URLs, leaving that list empty there, and returns the taken URLs.

**Call relations**: Message-submission code can call this to move image URLs from draft state into the outgoing user message.

*Call graph*: calls 1 internal fn (take_remote_image_urls).


##### `ChatWidget::remote_image_urls`  (lines 1754–1756)

```
fn remote_image_urls(&self) -> Vec<String>
```

**Purpose**: Returns the current remote image URLs for tests. It lets tests inspect composer attachment state.

**Data flow**: It asks the bottom pane for its remote image URLs and returns a copy.

**Call relations**: This test-only helper mirrors the attachment state used by normal message submission.

*Call graph*: calls 1 internal fn (remote_image_urls).


##### `ChatWidget::pending_thread_approvals`  (lines 1759–1761)

```
fn pending_thread_approvals(&self) -> &[String]
```

**Purpose**: Returns the pending thread approvals for tests. This lets tests verify approval state shown by the bottom pane.

**Data flow**: It asks the bottom pane for its pending thread approvals and returns the slice.

**Call relations**: This test-only helper exposes the same approval list set through set_pending_thread_approvals.

*Call graph*: calls 1 internal fn (pending_thread_approvals).


##### `ChatWidget::has_active_view`  (lines 1764–1766)

```
fn has_active_view(&self) -> bool
```

**Purpose**: Reports whether the bottom pane currently has a modal or special view open. This is mainly useful in tests.

**Data flow**: It asks the bottom pane whether an active view exists and returns the result.

**Call relations**: Tests can use this to verify that prompts, popups, or forms were opened or dismissed.

*Call graph*: calls 1 internal fn (has_active_view).


##### `ChatWidget::show_esc_backtrack_hint`  (lines 1768–1770)

```
fn show_esc_backtrack_hint(&mut self)
```

**Purpose**: Asks the bottom pane to show a hint about Escape-Escape backtracking. This guides users when that shortcut is available.

**Data flow**: It forwards the request to the bottom pane.

**Call relations**: Input-handling logic can call this when it detects a situation where the hint should be visible.

*Call graph*: calls 1 internal fn (show_esc_backtrack_hint).


##### `ChatWidget::clear_esc_backtrack_hint`  (lines 1772–1774)

```
fn clear_esc_backtrack_hint(&mut self)
```

**Purpose**: Asks the bottom pane to hide the Escape-Escape backtracking hint.

**Data flow**: It forwards the clear request to the bottom pane.

**Call relations**: Input-handling logic can call this when the hint no longer applies.

*Call graph*: calls 1 internal fn (clear_esc_backtrack_hint).


##### `ChatWidget::refresh_skills_for_current_cwd`  (lines 1776–1781)

```
fn refresh_skills_for_current_cwd(&mut self, force_reload: bool)
```

**Purpose**: Requests a fresh list of skills for the current working directory. Skills are reusable tool-like abilities available to the assistant.

**Data flow**: It receives a force-reload flag, builds a list-skills command for the current directory, and submits it through submit_op.

**Call relations**: It uses submit_op to send the request into the app command flow.

*Call graph*: calls 1 internal fn (submit_op); 2 external calls (list_skills, vec!).


##### `ChatWidget::submit_op`  (lines 1784–1806)

```
fn submit_op(&mut self, op: T) -> bool
```

**Purpose**: Sends an app command to Codex or wraps it as an app event, depending on how this widget was constructed. It is the main outgoing command path from the chat UI.

**Data flow**: It receives something convertible into AppCommand, converts it, prepares local UI state, marks review tasks running when needed, then either sends it directly through a command channel or through AppEvent::CodexOp. It returns whether direct sending succeeded.

**Call relations**: clean_background_terminals and refresh_skills_for_current_cwd call this. It calls prepare_local_op_submission before handing the command off.

*Call graph*: calls 5 internal fn (send, is_task_running, set_task_running, prepare_local_op_submission, log_outbound_op); called by 2 (clean_background_terminals, refresh_skills_for_current_cwd); 4 external calls (into, is_review, CodexOp, error!).


##### `ChatWidget::append_message_history_entry`  (lines 1808–1815)

```
fn append_message_history_entry(&self, text: String)
```

**Purpose**: Requests that a text entry be appended to the current thread’s message history. It warns if there is no active thread yet.

**Data flow**: It receives text, checks for a thread id, and sends an AppendMessageHistoryEntry event with that id and text. If no thread id exists, it logs a warning and does nothing.

**Call relations**: Message-submission or slash-command flows can use this to persist recall history after a thread is known.

*Call graph*: calls 1 internal fn (send); 1 external calls (warn!).


##### `ChatWidget::prepare_local_op_submission`  (lines 1817–1833)

```
fn prepare_local_op_submission(&mut self, op: &AppCommand)
```

**Purpose**: Updates local UI state before an outgoing command is submitted. It especially cleans up streaming state before interrupts.

**Data flow**: It receives an AppCommand reference. If it is an interrupt during an active agent turn, it may arm cancel-edit restore, clears queued stream-controller output, clears the active stream tail, and redraws.

**Call relations**: submit_op calls this before sending every command so local UI state stays consistent with outgoing actions.

*Call graph*: calls 1 internal fn (request_redraw); called by 1 (submit_op).


##### `ChatWidget::on_list_skills`  (lines 1835–1838)

```
fn on_list_skills(&mut self, ev: SkillsListResponse)
```

**Purpose**: Applies a skill-list response and then refreshes plugin mention suggestions. This keeps mention autocomplete in sync with available tools.

**Data flow**: It receives a SkillsListResponse, stores the skills through the response handler, and calls refresh_plugin_mentions.

**Call relations**: Skill-list response handling calls this after the app server returns available skills.

*Call graph*: calls 1 internal fn (refresh_plugin_mentions).


##### `ChatWidget::refresh_plugin_mentions`  (lines 1840–1847)

```
fn refresh_plugin_mentions(&mut self)
```

**Purpose**: Refreshes the plugin mention list used by the composer. If plugins are disabled, it clears plugin mentions instead.

**Data flow**: It checks the plugins feature flag. If disabled, it tells the bottom pane there are no plugin mentions. If enabled, it sends a RefreshPluginMentions app event.

**Call relations**: on_list_skills calls this after skill updates, because skill and plugin mentions share the composer suggestion experience.

*Call graph*: calls 2 internal fn (send, set_plugin_mentions); called by 1 (on_list_skills).


##### `ChatWidget::on_plugin_mentions_loaded`  (lines 1849–1857)

```
fn on_plugin_mentions_loaded(
        &mut self,
        plugins: Option<Vec<PluginCapabilitySummary>>,
    )
```

**Purpose**: Installs newly loaded plugin mention data in the bottom pane, but only if it changed. This avoids unnecessary UI churn.

**Data flow**: It receives optional plugin summaries, compares them with the bottom pane’s current plugin list, and updates the bottom pane when different.

**Call relations**: Plugin mention loading code calls this after the app event requested by refresh_plugin_mentions completes.

*Call graph*: calls 2 internal fn (plugins, set_plugin_mentions).


##### `ChatWidget::sync_plugin_mentions_config`  (lines 1859–1865)

```
fn sync_plugin_mentions_config(&mut self, config: &Config)
```

**Purpose**: Copies the parts of configuration that affect mention behavior into the widget. This keeps plugin and mention UI aligned after config changes.

**Data flow**: It receives a config reference and copies feature flags, config-layer stack, memory settings, and resize-reflow setting into the widget config, then syncs mentions-v2 enabled state.

**Call relations**: Config update flows call this when the app’s configuration changes while the chat widget is already alive.


##### `ChatWidget::token_usage`  (lines 1867–1872)

```
fn token_usage(&self) -> TokenUsage
```

**Purpose**: Returns the total token usage known to the widget. If no token info is available, it returns a default zero-like usage value.

**Data flow**: It reads token_info, clones total_token_usage if present, or returns the default TokenUsage.

**Call relations**: Status and reporting code can query this when it needs current token totals.


##### `ChatWidget::thread_id`  (lines 1874–1876)

```
fn thread_id(&self) -> Option<ThreadId>
```

**Purpose**: Returns the current thread id, if the session has one. A thread id identifies the conversation on the app/server side.

**Data flow**: It reads and returns the optional thread_id field.

**Call relations**: add_mcp_output calls this when sending a FetchMcpInventory event so the request can be tied to the active thread.

*Call graph*: called by 1 (add_mcp_output).


##### `ChatWidget::thread_name`  (lines 1878–1880)

```
fn thread_name(&self) -> Option<String>
```

**Purpose**: Returns the current thread name, if known. This is the user-friendly session title.

**Data flow**: It clones and returns the optional thread_name field.

**Call relations**: Status, navigation, or resume-hint code can call this when it needs the display name for the active conversation.


##### `ChatWidget::rollout_path`  (lines 1887–1889)

```
fn rollout_path(&self) -> Option<PathBuf>
```

**Purpose**: Returns the file path where the current thread’s rollout may be stored. A rollout is the persisted record of a session.

**Data flow**: It clones and returns current_rollout_path, which may exist even before the file has been created.

**Call relations**: Feedback and persistence-related flows can use this to attach or locate the active session’s stored record.


##### `ChatWidget::active_cell_transcript_key`  (lines 1901–1924)

```
fn active_cell_transcript_key(&self) -> Option<ActiveCellTranscriptKey>
```

**Purpose**: Builds a cache key for the transcript overlay’s live tail. The live tail is the in-progress content shown alongside committed transcript entries.

**Data flow**: It checks active, hook, token-activity, and rate-limit hint cells. If none exist, it returns None. Otherwise it returns a key containing the active-cell revision, stream-continuation flag, and any animation tick.

**Call relations**: The transcript overlay uses this key to decide whether it must recompute in-flight transcript lines instead of reusing cached ones.


##### `ChatWidget::active_cell_transcript_hyperlink_lines`  (lines 1932–1963)

```
fn active_cell_transcript_hyperlink_lines(
        &self,
        width: u16,
    ) -> Option<Vec<HyperlinkLine>>
```

**Purpose**: Collects the transcript-overlay lines for all current in-flight cells, preserving hyperlinks. It inserts blank separators between non-empty live sections.

**Data flow**: It receives a width, asks the active cell, hook cell, pending token-activity cell, and rate-limit hint for transcript lines, joins non-empty sections with blank lines, and returns None if there is nothing to show.

**Call relations**: active_cell_transcript_lines calls this and then strips hyperlink metadata for tests or plain visible-line use.

*Call graph*: calls 1 internal fn (from); called by 1 (active_cell_transcript_lines); 1 external calls (new).


##### `ChatWidget::active_cell_transcript_lines`  (lines 1966–1969)

```
fn active_cell_transcript_lines(&self, width: u16) -> Option<Vec<Line<'static>>>
```

**Purpose**: Returns visible transcript lines for the active live tail without hyperlink metadata. This is a test-friendly convenience helper.

**Data flow**: It receives a width, calls active_cell_transcript_hyperlink_lines, and converts hyperlink lines into ordinary visible terminal lines if any exist.

**Call relations**: It is built directly on active_cell_transcript_hyperlink_lines so tests inspect the same live-tail content the overlay uses.

*Call graph*: calls 1 internal fn (active_cell_transcript_hyperlink_lines).


##### `ChatWidget::config_ref`  (lines 1973–1975)

```
fn config_ref(&self) -> &Config
```

**Purpose**: Returns a reference to the widget’s current config. This includes runtime changes made through the TUI.

**Data flow**: It returns a shared reference to the config field without copying it.

**Call relations**: Other code can read effective chat-widget configuration through this method without taking ownership.


##### `ChatWidget::status_line_text`  (lines 1978–1980)

```
fn status_line_text(&self) -> Option<String>
```

**Purpose**: Returns the current status-line text for tests. The status line is the compact footer summary shown in the bottom pane.

**Data flow**: It asks the bottom pane for its status-line text and returns the optional string.

**Call relations**: Test code calls this to verify what the bottom pane is displaying.

*Call graph*: calls 1 internal fn (status_line_text); called by 1 (status_line_text).


##### `ChatWidget::clear_token_usage`  (lines 1982–1984)

```
fn clear_token_usage(&mut self)
```

**Purpose**: Clears stored token usage from the widget. This removes the remembered token counts, though it does not itself update all displays.

**Data flow**: It sets token_info to None.

**Call relations**: Token-reset flows can use this when old token counts should no longer be considered current.


##### `has_websocket_timing_metrics`  (lines 1987–1994)

```
fn has_websocket_timing_metrics(summary: RuntimeMetricsSummary) -> bool
```

**Purpose**: Checks whether runtime metrics contain any websocket timing data. This helps decide whether there is meaningful timing information to show or report.

**Data flow**: It receives a RuntimeMetricsSummary and returns true if any of several timing fields is greater than zero.

**Call relations**: Metrics display or logging code can call this before including websocket timing details.


##### `ChatWidget::drop`  (lines 1997–1999)

```
fn drop(&mut self)
```

**Purpose**: Cleans up when the chat widget is destroyed. It stops the rate-limit poller so background polling does not continue after the widget is gone.

**Data flow**: When Rust drops the ChatWidget, this method calls stop_rate_limit_poller.

**Call relations**: This runs automatically during teardown; callers do not invoke it directly.


##### `extract_first_bold`  (lines 2021–2047)

```
fn extract_first_bold(s: &str) -> Option<String>
```

**Purpose**: Finds the first non-empty Markdown bold phrase written as **text**. It is useful for extracting a short header from streamed markdown.

**Data flow**: It scans the input string byte by byte for an opening ** and closing **. If it finds a non-empty trimmed inner value, it returns that text; if the bold text is empty or incomplete, it returns None.

**Call relations**: Streaming or reasoning-summary code can use this helper when it wants a compact title from markdown content.


### `tui/src/chatwidget/interrupts.rs`

`orchestration` · `request handling`

The chat screen can be interrupted by several kinds of urgent events: a command may need approval, a file change may need permission, a tool may ask the user a question, or a background item may start or finish. The interface can only show one such overlay at a time. This file provides the waiting-room for the rest.

The main piece is InterruptManager. It owns a queue, which is like a line at a service desk: new interruptions join the back, and when the chat is ready, the oldest one is taken from the front. Each item in the line is a QueuedInterrupt, an enum, meaning a value that can be one of several known shapes. The enum records exactly what kind of interruption is waiting and carries the data needed to show it later.

A key detail is that prompts can be resolved outside this queue. For example, an approval request might be answered before it reaches the screen. remove_resolved_prompt scans the queue and drops any waiting prompt that matches that completed request, so the user is not asked again. It deliberately does not remove lifecycle updates such as “item started” or “item completed,” because those are not answerable prompts.

When the UI becomes free, flush_all drains the queue and hands each event to the matching ChatWidget method that displays or applies it immediately.

#### Function details

##### `InterruptManager::new`  (lines 36–40)

```
fn new() -> Self
```

**Purpose**: Creates a fresh interrupt manager with an empty waiting line. Code uses this when a chat widget or test needs somewhere to store interruptions that cannot be shown yet.

**Data flow**: It takes no input. It creates an empty first-in, first-out queue, where the oldest saved interruption will be handled first. It returns a new InterruptManager containing that empty queue.

**Call relations**: During normal setup, new_with_op_target creates one so the chat area can defer interruptions. The tests also create managers this way before checking how queued prompts are removed.

*Call graph*: called by 4 (new_with_op_target, remove_resolved_prompt_keeps_lifecycle_events, remove_resolved_prompt_matches_exec_approval_id, remove_resolved_prompt_removes_matching_user_input_only); 1 external calls (new).


##### `InterruptManager::is_empty`  (lines 43–45)

```
fn is_empty(&self) -> bool
```

**Purpose**: Answers the simple question: are there any delayed interruptions waiting? This lets other code decide whether there is deferred work to flush.

**Data flow**: It reads the manager’s queue. If the queue has no entries, it returns true; otherwise it returns false. It does not change anything.

**Call relations**: This is a small status check for the broader chat flow. Other code can call it before deciding whether to drain the queue or leave the interrupt system alone.

*Call graph*: 1 external calls (is_empty).


##### `InterruptManager::push_exec_approval`  (lines 47–49)

```
fn push_exec_approval(&mut self, ev: ExecApprovalRequestEvent)
```

**Purpose**: Adds a command-execution approval request to the back of the waiting line. This is used when a command wants permission but another interruption is already visible.

**Data flow**: It receives an ExecApprovalRequestEvent containing the command approval details. It wraps that event as a queued execution approval and appends it to the queue. Nothing is returned; the manager’s queue is changed.

**Call relations**: This is one of the entry points for putting work into the interrupt queue. Later, flush_all takes the saved approval back out and asks ChatWidget to show the execution approval immediately.

*Call graph*: 2 external calls (push_back, ExecApproval).


##### `InterruptManager::push_apply_patch_approval`  (lines 51–54)

```
fn push_apply_patch_approval(&mut self, ev: ApplyPatchApprovalRequestEvent)
```

**Purpose**: Adds a file-change approval request to the waiting line. This keeps patch approval prompts from colliding with whatever prompt is already on screen.

**Data flow**: It receives an ApplyPatchApprovalRequestEvent describing the requested file change. It stores that event inside a queued apply-patch approval and appends it to the queue. The function returns nothing and mutates the queue.

**Call relations**: This feeds patch approvals into the same deferred-interrupt path as other prompt types. When flush_all reaches this item, it hands it to ChatWidget’s immediate apply-patch approval handler.

*Call graph*: 2 external calls (push_back, ApplyPatchApproval).


##### `InterruptManager::push_elicitation`  (lines 56–63)

```
fn push_elicitation(
        &mut self,
        request_id: AppServerRequestId,
        params: McpServerElicitationRequestParams,
    )
```

**Purpose**: Queues an elicitation request, which is a server-driven request for extra information from the user. It preserves both the request identity and the prompt details so the question can be shown later.

**Data flow**: It receives a request ID and request parameters. It packages both into an elicitation queued item and appends that item to the queue. It does not return a value.

**Call relations**: This stores server questions while another interruption is active. Later, flush_all passes the same request ID and parameters to ChatWidget so it can display the elicitation prompt and respond to the right server request.

*Call graph*: 1 external calls (push_back).


##### `InterruptManager::push_request_permissions`  (lines 65–68)

```
fn push_request_permissions(&mut self, ev: RequestPermissionsEvent)
```

**Purpose**: Queues a permissions request, such as a tool asking for extra rights. This prevents permission prompts from being lost or stacked on top of another visible prompt.

**Data flow**: It receives a RequestPermissionsEvent with the permission request details. It wraps the event as a queued permissions request and appends it to the queue. It changes the queue and returns nothing.

**Call relations**: This function adds permission prompts to the deferred flow. When the queue is flushed, ChatWidget receives the stored request through its immediate permissions handler.

*Call graph*: 2 external calls (push_back, RequestPermissions).


##### `InterruptManager::push_user_input`  (lines 70–72)

```
fn push_user_input(&mut self, ev: ToolRequestUserInputParams)
```

**Purpose**: Queues a tool’s request for user input. This is used when a tool needs answers from the user but the interface is not ready to ask yet.

**Data flow**: It receives ToolRequestUserInputParams, which include the tool item ID and the questions to ask. It wraps those parameters as a queued user-input request and appends them to the queue. The queue is updated; no value is returned.

**Call relations**: This lets tool questions wait their turn. Later, flush_all sends the saved input request to ChatWidget so the user can answer it.

*Call graph*: 2 external calls (push_back, RequestUserInput).


##### `InterruptManager::push_item_started`  (lines 74–76)

```
fn push_item_started(&mut self, item: ThreadItem)
```

**Purpose**: Queues a notification that a thread item has started, such as a command beginning to run. This lets the chat display stay in the correct order even while a prompt is blocking immediate updates.

**Data flow**: It receives a ThreadItem describing the started item. It wraps it as an item-started queued event and appends it to the queue. It returns nothing and changes only the queue.

**Call relations**: This adds lifecycle updates to the same line as prompts. When flush_all later sees this event, it tells ChatWidget to apply the queued “started” update immediately.

*Call graph*: 2 external calls (push_back, ItemStarted).


##### `InterruptManager::push_item_completed`  (lines 78–80)

```
fn push_item_completed(&mut self, item: ThreadItem)
```

**Purpose**: Queues a notification that a thread item has completed. This keeps completion updates from being applied out of order while another interruption is visible.

**Data flow**: It receives a ThreadItem describing the completed item. It wraps it as an item-completed queued event and appends it to the queue. The manager stores the event and returns nothing.

**Call relations**: This is the companion to push_item_started for deferred lifecycle updates. During flushing, ChatWidget receives the completed item and updates the chat display.

*Call graph*: 2 external calls (push_back, ItemCompleted).


##### `InterruptManager::remove_resolved_prompt`  (lines 82–87)

```
fn remove_resolved_prompt(&mut self, request: &ResolvedAppServerRequest) -> bool
```

**Purpose**: Removes any queued prompt that has already been resolved elsewhere. This prevents the user from seeing an old approval or input request after it has already been answered.

**Data flow**: It receives a ResolvedAppServerRequest, which identifies a completed prompt. It checks the current queue length, keeps only queued items that do not match that resolved prompt, then compares the new length with the old one. It returns true if something was removed, and false if the queue stayed the same.

**Call relations**: dismiss_app_server_request calls this when the app learns that a server request is no longer pending. The actual matching decision is delegated to QueuedInterrupt::matches_resolved_prompt, so this function can focus on cleaning the queue.

*Call graph*: called by 1 (dismiss_app_server_request); 2 external calls (len, retain).


##### `InterruptManager::flush_all`  (lines 89–105)

```
fn flush_all(&mut self, chat: &mut ChatWidget)
```

**Purpose**: Drains every waiting interruption and applies it to the chat widget in order. This is what turns deferred events back into visible UI work once the chat is ready.

**Data flow**: It receives a mutable ChatWidget and repeatedly removes the oldest queued item. For each item, it looks at its kind and calls the matching ChatWidget method with the saved data. When it finishes, the queue is empty; the chat widget may have shown prompts or applied updates.

**Call relations**: This is the bridge from storage back to action. The push functions put events into the queue, and flush_all later hands each one to the appropriate immediate ChatWidget handler, such as execution approval, patch approval, elicitation, permissions, user input, item started, or item completed.

*Call graph*: 8 external calls (pop_front, handle_apply_patch_approval_now, handle_elicitation_request_now, handle_exec_approval_now, handle_queued_item_completed_now, handle_queued_item_started_now, handle_request_permissions_now, handle_request_user_input_now).


##### `QueuedInterrupt::matches_resolved_prompt`  (lines 109–135)

```
fn matches_resolved_prompt(&self, request: &ResolvedAppServerRequest) -> bool
```

**Purpose**: Decides whether one queued interruption is the same prompt as a resolved server request. This is the safety check that stops already-answered prompts from being shown later.

**Data flow**: It reads the queued interruption and the resolved request. For prompt-like items, it compares the relevant IDs, such as approval ID, call ID, request ID, or server name. It returns true only when the queued prompt and resolved request refer to the same thing; lifecycle events always return false.

**Call relations**: InterruptManager::remove_resolved_prompt uses this for each queued item while cleaning the queue. It does not display anything itself; it only supplies the yes-or-no matching rule.

*Call graph*: 1 external calls (matches!).


##### `tests::user_input`  (lines 149–157)

```
fn user_input(call_id: &str, turn_id: &str) -> ToolRequestUserInputParams
```

**Purpose**: Builds a small fake user-input request for tests. It saves each test from repeating the same setup fields.

**Data flow**: It receives a call ID and a turn ID. It fills in a ToolRequestUserInputParams value with fixed thread information, the provided IDs, no questions, and no automatic timeout. It returns that ready-to-queue test value.

**Call relations**: The user-input removal test calls this helper to create two different queued input prompts. Those prompts are then used to prove that only the matching one is removed.

*Call graph*: 1 external calls (new).


##### `tests::exec_approval`  (lines 159–173)

```
fn exec_approval(call_id: &str, approval_id: Option<&str>) -> ExecApprovalRequestEvent
```

**Purpose**: Builds a fake command approval request for tests. It lets the test control whether the approval has a separate approval ID.

**Data flow**: It receives a command call ID and an optional approval ID. It creates an ExecApprovalRequestEvent for a harmless command, using the current directory as the working directory and leaving optional permission fields empty. It returns that event for the test to queue.

**Call relations**: The execution-approval test uses this helper to check an important distinction: a queued execution approval may match by its effective approval ID rather than only by the command call ID.

*Call graph*: calls 1 internal fn (current_dir); 1 external calls (vec!).


##### `tests::command_execution`  (lines 175–188)

```
fn command_execution(call_id: &str) -> ThreadItem
```

**Purpose**: Builds a fake in-progress command item for tests. This represents a lifecycle update, not a prompt that the user can answer.

**Data flow**: It receives a call ID. It creates a ThreadItem for a command execution marked as in progress, with a simple command and the current directory as its working directory. It returns that thread item.

**Call relations**: The lifecycle-event test uses this helper to queue an “item started” event. That test then confirms that resolving a prompt does not accidentally remove ordinary progress updates.

*Call graph*: calls 1 internal fn (current_dir); 1 external calls (new).


##### `tests::remove_resolved_prompt_removes_matching_user_input_only`  (lines 191–207)

```
fn remove_resolved_prompt_removes_matching_user_input_only()
```

**Purpose**: Checks that resolving one user-input request removes only that matching queued prompt. This protects against accidentally deleting unrelated user questions.

**Data flow**: The test creates a manager, queues two fake user-input requests with different IDs, then asks the manager to remove the one whose call ID is resolved. It verifies that removal happened, that one item remains, and that the remaining item is the other request.

**Call relations**: This test exercises InterruptManager::new, the user-input helper, the queueing path, and remove_resolved_prompt. It proves the matching logic is precise for tool user-input prompts.

*Call graph*: calls 1 internal fn (new); 4 external calls (assert!, assert_eq!, panic!, user_input).


##### `tests::remove_resolved_prompt_matches_exec_approval_id`  (lines 210–227)

```
fn remove_resolved_prompt_matches_exec_approval_id()
```

**Purpose**: Checks that execution approvals are removed using the effective approval ID when one exists. This matters because the approval may be identified by a separate approval ID rather than the command’s call ID.

**Data flow**: The test creates a manager, queues one fake execution approval with both a call ID and an approval ID, then tries to remove it first using the call ID. That should fail. It then removes it using the approval ID, which should succeed and leave the queue empty.

**Call relations**: This test drives InterruptManager::new, the execution-approval helper, and remove_resolved_prompt. It verifies the ID comparison inside QueuedInterrupt::matches_resolved_prompt for execution approvals.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert!, assert_eq!, exec_approval).


##### `tests::remove_resolved_prompt_keeps_lifecycle_events`  (lines 230–245)

```
fn remove_resolved_prompt_keeps_lifecycle_events()
```

**Purpose**: Checks that lifecycle updates are not removed when a prompt with a similar ID is resolved. This prevents progress messages from disappearing just because an approval was answered.

**Data flow**: The test creates a manager, queues an item-started event for a command, then reports an execution approval with the same ID as resolved. It verifies that nothing was removed and that the queued item-started event is still present.

**Call relations**: This test uses InterruptManager::new, the command-execution helper, and remove_resolved_prompt. It confirms the rule in QueuedInterrupt::matches_resolved_prompt that item-started and item-completed events are never treated as resolved prompts.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert!, assert_eq!, command_execution).


### `tui/src/chatwidget/notifications.rs`

`domain_logic` · `main loop`

This file is the notification helper for the terminal chat screen. Its job is to turn important chat events into short desktop messages, while avoiding spam. Think of it like a receptionist who decides which note is important enough to put on your desk, and waits for the right moment to deliver it.

The main flow starts when `ChatWidget` is told about a possible `Notification`. The widget first checks the user's notification settings. Notifications can be completely on or off, or limited to selected kinds such as completed agent turns or approval requests. If the new notification is allowed, the widget compares it with any notification already waiting to be shown. A higher-priority pending notification is kept, so a routine “agent turn complete” message cannot overwrite an approval request that needs the user's attention.

The actual desktop popup is not sent immediately. Instead, the notification is stored as `pending_notification` and the widget asks for a redraw. Later, `maybe_post_pending_notification` takes the stored notification, converts it into friendly text, and sends it through the TUI object.

The `Notification` enum lists the kinds of messages the app can show: agent completion, command approval, edit approval, server/user approval, and plan mode prompts. Helper methods create short display text, classify notification types for settings, set priority, and trim long text so popups stay readable.

#### Function details

##### `ChatWidget::notify`  (lines 6–17)

```
fn notify(&mut self, notification: Notification)
```

**Purpose**: This records a notification that may be shown to the user later. It filters out notifications the user has disabled and prevents a less important message from replacing a more important one already waiting.

**Data flow**: A `Notification` comes in, along with the widget's current notification settings and any already pending notification. The function checks whether this kind of notification is allowed, compares priorities if another notification is already waiting, and either ignores the new one or stores it as the new pending notification. If it stores one, it asks the chat widget to redraw so the pending work can be processed.

**Call relations**: This is called when the chat widget learns about an event worth surfacing. It asks `Notification::allowed_for` whether the settings permit the message, and uses `Notification::priority` to decide whether it should replace an existing pending message. The stored result is later picked up by `ChatWidget::maybe_post_pending_notification`.

*Call graph*: calls 2 internal fn (allowed_for, priority).


##### `ChatWidget::maybe_post_pending_notification`  (lines 19–23)

```
fn maybe_post_pending_notification(&mut self, tui: &mut crate::tui::Tui)
```

**Purpose**: This sends the waiting notification to the desktop notification system, if one is queued. It is the final delivery step after `ChatWidget::notify` has decided what should be shown.

**Data flow**: The function looks inside the widget for `pending_notification`. If there is none, nothing changes. If there is one, it removes it from the widget, turns it into display text with `Notification::display`, and passes that text to the TUI's notification sender.

**Call relations**: This runs later in the UI flow, after `ChatWidget::notify` has queued a notification and requested a redraw. It hands the finished message to `tui.notify`, which is outside this file and is responsible for the actual desktop popup.

*Call graph*: 1 external calls (notify).


##### `Notification::display`  (lines 36–66)

```
fn display(&self) -> String
```

**Purpose**: This turns an internal notification into the short human-readable message that appears in a desktop popup. It keeps messages concise by using previews and truncating long commands or titles.

**Data flow**: The function receives a `Notification` value. It looks at which kind it is, pulls out the useful details, and builds a string: a preview of the agent's response, a shortened command, a path or file count for edits, a server approval message, or a plan mode prompt title. The result is plain text ready to show to the user.

**Call relations**: This is used by `ChatWidget::maybe_post_pending_notification` when a queued notification is finally delivered. For agent completion messages, it delegates to `Notification::agent_turn_preview` so long or messy responses become a clean one-line preview.

*Call graph*: calls 1 internal fn (agent_turn_preview); 1 external calls (format!).


##### `Notification::type_name`  (lines 68–76)

```
fn type_name(&self) -> &str
```

**Purpose**: This gives each notification a stable text label used by notification settings. It lets user configuration refer to categories such as `agent-turn-complete` or `approval-requested` without caring about the exact internal enum variant.

**Data flow**: The function receives a notification and returns a short string name for its category. Several approval-related variants share the same returned name, because the settings treat them as one kind of alert.

**Call relations**: This is used inside `Notification::allowed_for`. When custom notification settings list allowed categories, `allowed_for` compares those setting strings against the value returned here.


##### `Notification::priority`  (lines 78–86)

```
fn priority(&self) -> u8
```

**Purpose**: This assigns a simple importance level to each notification. Agent completion is lower priority, while approvals and plan prompts are higher priority because they may require the user's action.

**Data flow**: The function receives a notification and returns a small number representing its importance. Agent turn completion returns `0`; approval requests and plan mode prompts return `1`.

**Call relations**: This is called by `ChatWidget::notify` when a new notification arrives and another one is already pending. The priority value decides whether the new notification can replace the old one or should be ignored.

*Call graph*: called by 1 (notify).


##### `Notification::allowed_for`  (lines 88–93)

```
fn allowed_for(&self, settings: &Notifications) -> bool
```

**Purpose**: This checks whether the user's settings permit this notification to be shown. It supports both a simple on/off setting and a custom allow-list of notification categories.

**Data flow**: The function receives a notification and the current notification settings. If settings are simply enabled or disabled, it returns that boolean value. If settings are custom, it gets the notification's category name and returns true only if that category appears in the allowed list.

**Call relations**: This is called by `ChatWidget::notify` before a notification is queued. It relies on `Notification::type_name` to translate the notification into the same category names used by the settings.

*Call graph*: called by 1 (notify).


##### `Notification::agent_turn_preview`  (lines 95–109)

```
fn agent_turn_preview(response: &str) -> Option<String>
```

**Purpose**: This creates a clean, short preview of the agent's final response for a desktop notification. It removes extra whitespace and avoids showing an empty popup if the response has no visible text.

**Data flow**: The function receives the agent's response text. It splits the text into words, joins them back with single spaces, trims the result, and returns nothing if the result is empty. Otherwise, it returns the cleaned text shortened to the notification preview limit.

**Call relations**: This is used by `Notification::display` when building an `AgentTurnComplete` message. It is also called from `on_task_complete`, so task completion can create a suitable summary before a notification is shown.

*Call graph*: called by 2 (display, on_task_complete); 1 external calls (new).


##### `Notification::user_input_request_summary`  (lines 111–125)

```
fn user_input_request_summary(
        questions: &[codex_app_server_protocol::ToolRequestUserInputQuestion],
    ) -> Option<String>
```

**Purpose**: This creates a short summary for a request that asks the user for input. It chooses the first question's header if available, otherwise the question text, and trims it for display.

**Data flow**: The function receives a list of user-input questions. It looks at the first question only. If that question has a non-empty header, the header becomes the summary; otherwise the question text is used. If the chosen text is empty, it returns nothing; otherwise it returns a shortened version.

**Call relations**: This is called by `handle_request_user_input_now` when the app needs to summarize a user-input request. It does not send a notification itself; it prepares the concise text that other chat-widget code can use in that flow.

*Call graph*: called by 1 (handle_request_user_input_now); 1 external calls (first).


### `tui/src/chatwidget/rendering.rs`

`domain_logic` · `main loop rendering`

The chat screen is made from several pieces: the conversation transcript, a possible active “hook” message, optional temporary messages such as token activity or rate-limit hints, and the bottom input pane where the user types. This file is the layout recipe that stacks those pieces into one renderable surface.

The main idea is similar to arranging panels in a window. `ChatWidget::as_renderable` builds a vertical flexible layout. The main transcript gets room to grow, temporary cells can be added when they exist, and the bottom pane stays at the bottom. Some columns on the right may be reserved, so transcript text and the composer do not draw underneath another UI element.

Two small wrapper renderables make the parts fit this shared layout. `TranscriptAreaRenderable` draws a history cell with a top margin and right-side reserve, and scrolls to the bottom if the text is taller than the available space. `BottomPaneComposerReserveRenderable` forwards drawing, height, and cursor questions to the bottom pane while applying the same right-side reserve.

Finally, `ChatWidget` itself implements the common `Renderable` interface, so the rest of the terminal UI can ask it to draw, report its desired height, and say where and how the cursor should appear.

#### Function details

##### `ChatWidget::as_renderable`  (lines 6–60)

```
fn as_renderable(&self) -> RenderableItem<'_>
```

**Purpose**: Builds a single drawable layout for the whole chat widget. It gathers the currently visible chat pieces and arranges them in the order they should appear on screen.

**Data flow**: It reads the widget’s transcript, optional active hook cell, optional pending token activity message, optional rate-limit hint, bottom pane, and the number of right-side columns that must be kept clear. From those inputs it creates a vertical flexible layout, wrapping transcript-like items so they get the right padding and top spacing. It returns that layout as one renderable object that other code can draw or query.

**Call relations**: The public rendering methods on `ChatWidget` all call this first, so there is one shared layout recipe for drawing, height calculation, cursor position, and cursor style. It creates the flex container and wraps child pieces so the later render step can treat the whole chat widget as one item.

*Call graph*: calls 2 internal fn (tlbr, new); called by 4 (cursor_pos, cursor_style, desired_height, render); 2 external calls (new, Owned).


##### `BottomPaneComposerReserveRenderable::render`  (lines 69–72)

```
fn render(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Draws the bottom input pane while keeping a reserved space on the right side. This prevents the composer from painting into space needed by another UI element.

**Data flow**: It receives a screen rectangle and a mutable terminal buffer. It passes those, plus the stored right-side reserve width, to the bottom pane’s specialized drawing method. The buffer is changed to contain the bottom pane’s visible text and decorations.

**Call relations**: This wrapper is inserted by `ChatWidget::as_renderable` into the overall chat layout. When the layout reaches the bottom pane during drawing, this method hands the actual drawing work to the bottom pane with the reserve value included.

*Call graph*: calls 1 internal fn (render_with_composer_right_reserve).


##### `BottomPaneComposerReserveRenderable::desired_height`  (lines 74–77)

```
fn desired_height(&self, width: u16) -> u16
```

**Purpose**: Asks how tall the bottom input pane wants to be when some right-side space is unavailable. This helps the layout reserve enough vertical room for the composer.

**Data flow**: It receives the available width. It combines that width with the stored right-side reserve and asks the bottom pane to calculate its preferred height under those conditions. It returns that height.

**Call relations**: After `ChatWidget::as_renderable` includes this wrapper in the flex layout, the layout system calls this when deciding how much vertical space the bottom pane needs before drawing.

*Call graph*: calls 1 internal fn (desired_height_with_composer_right_reserve).


##### `BottomPaneComposerReserveRenderable::cursor_pos`  (lines 79–82)

```
fn cursor_pos(&self, area: Rect) -> Option<(u16, u16)>
```

**Purpose**: Finds where the text cursor should appear inside the bottom pane, taking the right-side reserve into account. This is what lets the terminal cursor line up with the user’s typing area.

**Data flow**: It receives the screen rectangle assigned to the bottom pane. It passes that rectangle and the reserve width to the bottom pane, which returns either a cursor coordinate or nothing if no cursor should be shown there.

**Call relations**: When the surrounding UI asks the chat widget for the cursor location, the request flows through the renderable layout built by `ChatWidget::as_renderable`. If the bottom pane owns the cursor, this wrapper delegates the answer to the bottom pane.

*Call graph*: calls 1 internal fn (cursor_pos_with_composer_right_reserve).


##### `BottomPaneComposerReserveRenderable::cursor_style`  (lines 84–87)

```
fn cursor_style(&self, area: Rect) -> crossterm::cursor::SetCursorStyle
```

**Purpose**: Asks the bottom pane what the terminal cursor should look like, while using the same reserved-right-space rules as drawing. Cursor style means things like a block cursor or a bar cursor.

**Data flow**: It receives the bottom pane’s screen rectangle. It sends that rectangle and the right-side reserve to the bottom pane’s cursor-style method, then returns the style chosen by the bottom pane.

**Call relations**: The chat widget’s cursor-style query goes through the composed renderable layout. This wrapper keeps the bottom pane’s answer consistent with the space it was actually given for rendering.

*Call graph*: calls 1 internal fn (cursor_style_with_composer_right_reserve).


##### `TranscriptAreaRenderable::render`  (lines 97–111)

```
fn render(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Draws one transcript-style cell inside its allotted area. If the cell has more lines than fit, it shows the bottom portion, which is usually the newest and most relevant part.

**Data flow**: It starts with the screen rectangle assigned by the layout and the terminal buffer to draw into. It first shrinks the rectangle using `child_area`, leaving the requested top gap and right-side reserve. It asks the history cell for display lines at that width, turns those lines into a paragraph, computes how far to scroll if the paragraph is too tall, clears the target area, and draws the paragraph into the buffer.

**Call relations**: This renderable is created by `ChatWidget::as_renderable` for active transcript cells and temporary transcript-like messages. During the draw pass, it uses `child_area` to apply spacing before handing text to the terminal paragraph renderer.

*Call graph*: calls 1 internal fn (child_area); 5 external calls (new, from, display_lines, try_from, from).


##### `TranscriptAreaRenderable::desired_height`  (lines 113–116)

```
fn desired_height(&self, width: u16) -> u16
```

**Purpose**: Reports how much vertical space a transcript cell would like. It includes both the cell’s own text height and the extra top spacing used by this wrapper.

**Data flow**: It receives the available width, subtracts the right-side reserve without going below one column, and asks the history cell how tall it wants to be at that usable width. It adds the top margin and returns the total.

**Call relations**: The flexible layout asks this before drawing so it can divide the chat area sensibly. Because `ChatWidget::as_renderable` wraps transcript cells in this type, transcript height calculations match the same padding used during rendering.

*Call graph*: calls 1 internal fn (desired_height).


##### `TranscriptAreaRenderable::child_area`  (lines 120–129)

```
fn child_area(&self, area: Rect) -> Rect
```

**Purpose**: Calculates the exact rectangle where a transcript cell’s text should be drawn. It applies the wrapper’s top spacing and right-side reserve.

**Data flow**: It receives the larger rectangle assigned to the transcript wrapper. It moves the top edge down by the configured amount, reduces the height by that same amount, and reduces the width by the right-side reserve while keeping at least one column. It returns the smaller rectangle for the child content.

**Call relations**: This is a helper used by `TranscriptAreaRenderable::render`. It keeps the rectangle math in one place so rendering can focus on turning the history cell’s lines into terminal output.

*Call graph*: called by 1 (render); 1 external calls (new).


##### `ChatWidget::render`  (lines 133–136)

```
fn render(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Draws the entire chat widget into the terminal buffer. It also remembers the width it was last drawn at, which other parts of the widget can use later.

**Data flow**: It receives the screen area for the chat widget and the mutable terminal buffer. It builds the current renderable layout with `as_renderable`, asks that layout to draw into the buffer, then stores the area width as the last rendered width.

**Call relations**: This is the main draw entry for the chat widget through the shared `Renderable` interface. It relies on `ChatWidget::as_renderable` so drawing uses the same layout recipe as height and cursor queries.

*Call graph*: calls 1 internal fn (as_renderable).


##### `ChatWidget::desired_height`  (lines 138–140)

```
fn desired_height(&self, width: u16) -> u16
```

**Purpose**: Reports how tall the chat widget would like to be for a given width. The surrounding terminal layout uses this to decide how much space to give it.

**Data flow**: It receives an available width. It builds the current renderable layout with `as_renderable`, asks that layout for its desired height at that width, and returns the result.

**Call relations**: This method is part of the chat widget’s `Renderable` interface. By going through `as_renderable`, it keeps size planning consistent with the actual pieces that will be drawn.

*Call graph*: calls 1 internal fn (as_renderable).


##### `ChatWidget::cursor_pos`  (lines 142–144)

```
fn cursor_pos(&self, area: Rect) -> Option<(u16, u16)>
```

**Purpose**: Finds the terminal cursor position for the chat widget, usually so the cursor appears in the input area where the user is typing.

**Data flow**: It receives the rectangle occupied by the chat widget. It builds the current renderable layout with `as_renderable`, asks that layout where the cursor should be, and returns either a coordinate or no cursor position.

**Call relations**: The larger UI calls this after or around rendering when it needs to place the terminal cursor. The request flows through the same composed layout, which lets the bottom pane answer when it owns the cursor.

*Call graph*: calls 1 internal fn (as_renderable).


##### `ChatWidget::cursor_style`  (lines 146–148)

```
fn cursor_style(&self, area: Rect) -> crossterm::cursor::SetCursorStyle
```

**Purpose**: Chooses the visual style of the terminal cursor for the chat widget. This keeps the cursor appearance aligned with the active input state.

**Data flow**: It receives the chat widget’s screen rectangle. It builds the current renderable layout with `as_renderable`, asks that layout for the cursor style, and returns the chosen terminal cursor style.

**Call relations**: The surrounding terminal UI calls this when it needs to set the cursor appearance. Like drawing and cursor positioning, it goes through `as_renderable` so the answer comes from the same current layout.

*Call graph*: calls 1 internal fn (as_renderable).


### Interaction and input pipeline
Covers user interaction handling from keyboard/composer actions through queued input management, restoration, and final submission.

### `tui/src/chatwidget/input_queue.rs`

`data_model` · `main loop / chat turn handling`

In a chat interface, a user can type more input while the system is still working on the previous turn. This file is the waiting room for that input. Without it, follow-up messages could be lost, sent at the wrong time, or shown incorrectly in the UI.

The central type is `InputQueueState`, a small state bag used by `ChatWidget`. It stores several queues. One queue holds normal user messages waiting for the current turn to finish. Another holds “rejected steers”: messages that tried to guide, or steer, a turn that was not in the right state to accept them. A third queue holds “pending steers” that have already been sent to the core system but are not yet safely recorded in chat history.

The file also keeps matching history records beside some queues. This matters because what the user sees in history can differ from the exact text sent internally. For example, a slash command such as `/goal` may be displayed in a friendlier form. Think of it like keeping both the kitchen ticket and the customer-facing receipt.

The methods here answer simple questions, reset the queues, and build a preview of pending input so the UI can show what is waiting without mixing the categories together.

#### Function details

##### `InputQueueState::has_queued_follow_up_messages`  (lines 48–50)

```
fn has_queued_follow_up_messages(&self) -> bool
```

**Purpose**: This function answers whether there is any user input waiting to be sent after the current work finishes. It looks at both normal queued messages and rejected steering messages, because either one means there is follow-up input still pending.

**Data flow**: It starts with the current `InputQueueState`. It checks whether the rejected-steer queue and the normal-message queue are empty. It returns `true` if at least one of those queues has something in it, and `false` only when both are empty.

**Call relations**: Other chat-widget code can call this when deciding whether there is more user input to send next. Internally it only asks the queues whether they are empty; it does not move or change any messages.

*Call graph*: 1 external calls (is_empty).


##### `InputQueueState::clear`  (lines 52–60)

```
fn clear(&mut self)
```

**Purpose**: This function wipes all pending input state and resets the related flags. It is used when the chat widget needs to forget queued work, such as after a reset or cleanup.

**Data flow**: It takes the existing mutable `InputQueueState`, empties every queue of messages, history records, rejected steers, and pending steers, then sets the pending-start and retry-after-interrupt flags back to `false`. Afterward, the input queue state is back to a clean empty condition.

**Call relations**: Chat-widget flow calls this when queued input should no longer survive. It hands off only to the standard queue-clearing operation for each stored list, and it does not produce a separate return value because it changes the state directly.

*Call graph*: 1 external calls (clear).


##### `InputQueueState::preview`  (lines 62–95)

```
fn preview(&self) -> PendingInputPreview
```

**Purpose**: This function builds a user-facing snapshot of everything currently waiting in the input queues. It keeps normal queued messages, pending steers, and rejected steers separate so the UI can show them clearly.

**Data flow**: It reads the current queues from `InputQueueState`. For each normal queued message, it pairs the message with its matching history record if one exists, then turns it into preview text. It does the same for pending steers, using their stored history records, and for rejected steers, using their matching rejected-steer history records. It returns a `PendingInputPreview` containing three lists of strings.

**Call relations**: The chat UI can call this when it needs to display what is waiting to be sent or committed. This function relies on `user_message_preview_text` to turn each internal message plus optional history information into the text a person should see.

*Call graph*: 1 external calls (iter).


##### `tests::preview_keeps_queue_categories_separate`  (lines 105–130)

```
fn preview_keeps_queue_categories_separate()
```

**Purpose**: This test proves that `preview` does not blend different kinds of pending input together. A normal queued message, a pending steer, and a rejected steer should each appear in their own preview list.

**Data flow**: The test creates an empty `InputQueueState`, adds one message to each relevant category, then calls `preview`. It compares the returned `PendingInputPreview` with the expected three separate lists: queued, pending, and rejected.

**Call relations**: This test calls `InputQueueState::preview` in a controlled setup. It protects the behavior that the rest of the chat UI depends on when showing pending input to the user.

*Call graph*: calls 1 internal fn (from); 2 external calls (assert_eq!, default).


##### `tests::clear_resets_all_input_queues`  (lines 133–153)

```
fn clear_resets_all_input_queues()
```

**Purpose**: This test checks that `clear` really resets the input queue state, not just part of it. It makes sure messages and important flags are all removed or turned off.

**Data flow**: The test creates an `InputQueueState`, adds queued and rejected messages, and turns on two boolean flags. It then calls `clear` and checks that all queues are empty and the flags are back to `false`.

**Call relations**: This test calls `InputQueueState::clear` and verifies the cleanup contract used by the chat widget. It helps catch future changes that might accidentally leave stale pending input behind.

*Call graph*: calls 1 internal fn (from); 2 external calls (assert!, default).


### `tui/src/chatwidget/input_restore.rs`

`domain_logic` · `chat turn interruption, input queue processing, and thread state restore`

This part of `ChatWidget` is like the chat screen’s lost-and-found desk. In this app, a user can type a message while another turn is running, queue follow-up messages, add images, paste larger content, or send “steer” instructions that guide the active model turn. If the turn is interrupted, if the server rejects a steer, or if the user switches away and comes back, those pieces of input need to be put somewhere safe and then restored in a sensible order.

The file mainly does three jobs. First, it tracks whether an interrupted turn should restore the prompt that was being edited, especially for a cancel-edit flow. Second, it moves messages between several waiting areas: pending steers, rejected steers, queued user messages, and the visible composer where the user types. Third, it can take a snapshot of all thread input state and later rebuild it.

A subtle but important detail is attachment and paste restoration. Several messages may each refer to images or pasted blocks using placeholders. When messages are merged back into one draft after an interrupt, this file renumbers or remaps those placeholders so the text still points to the right attachment. Without this file, interruptions and thread switches could lose drafts, submit text at the wrong time, or restore a message with broken image and paste references.

#### Function details

##### `ChatWidget::record_cancel_edit_candidate`  (lines 9–13)

```
fn record_cancel_edit_candidate(&mut self, prompt: UserMessage)
```

**Purpose**: Marks a user prompt as something that may be restored if the current edit is cancelled. This is used to make cancel/edit behavior feel reversible instead of losing the prompt.

**Data flow**: A `UserMessage` comes in. The function stores it in the widget’s cancel-edit state, marks that state as eligible, and leaves it unarmed for now. Nothing is returned; the widget’s internal state is updated.

**Call relations**: This is an early setup step for the cancel-edit path. Later, `ChatWidget::arm_cancel_edit` decides whether the saved prompt is safe to restore, and `ChatWidget::on_interrupted_turn` may recover it through `ChatWidget::take_armed_cancel_edit_prompt`.


##### `ChatWidget::record_visible_turn_activity`  (lines 15–18)

```
fn record_visible_turn_activity(&mut self)
```

**Purpose**: Marks that visible activity happened during the turn, so the saved cancel-edit prompt should no longer be treated as cleanly restorable. This prevents the interface from restoring stale input after the conversation has visibly moved on.

**Data flow**: No outside data is passed in. The function changes two cancel-edit flags, making the prompt ineligible and disarmed. It returns nothing.

**Call relations**: Other ChatWidget code calls this when the active turn has produced visible activity. It blocks the later cancel-edit restore path that would otherwise be checked by `ChatWidget::arm_cancel_edit` and `ChatWidget::take_armed_cancel_edit_prompt`.


##### `ChatWidget::arm_cancel_edit`  (lines 20–27)

```
fn arm_cancel_edit(&mut self)
```

**Purpose**: Decides whether the saved cancel-edit prompt is currently safe to restore if the turn is interrupted. It only arms the restore when the composer is empty and there are no other queued or active side inputs that could conflict.

**Data flow**: It reads the cancel-edit state, the composer contents, pending steer queue, queued follow-up messages, and whether a side conversation is active. From those conditions it sets one internal boolean, `armed`, to true or false. It returns nothing.

**Call relations**: This prepares the state that `ChatWidget::take_armed_cancel_edit_prompt` checks during an interrupted turn. It acts like locking in a possible undo only when the chat input area is quiet enough.


##### `ChatWidget::take_armed_cancel_edit_prompt`  (lines 29–35)

```
fn take_armed_cancel_edit_prompt(&mut self, reason: TurnAbortReason) -> Option<UserMessage>
```

**Purpose**: Retrieves the saved cancel-edit prompt, but only for the specific case where an interruption should restore it. “Take” means it removes the prompt from storage so it cannot be restored twice.

**Data flow**: It receives the reason the turn was aborted. If the reason is `Interrupted` and the cancel-edit state is both armed and eligible, it removes and returns the saved `UserMessage`; otherwise it returns nothing.

**Call relations**: This is called by `ChatWidget::on_interrupted_turn` at the start of interruption handling. If it returns a prompt, that interruption flow later sends a restore event instead of treating the situation like an ordinary interrupted turn.

*Call graph*: called by 1 (on_interrupted_turn).


##### `ChatWidget::clear_cancel_edit`  (lines 37–39)

```
fn clear_cancel_edit(&mut self)
```

**Purpose**: Resets all cancel-edit tracking back to its empty default state. This is used when any saved cancel-edit prompt should be forgotten.

**Data flow**: No input is needed. The function replaces the current cancel-edit state with a fresh default value. It returns nothing.

**Call relations**: This is a cleanup helper for other ChatWidget flows. It calls the default constructor for the cancel-edit state so the rest of the widget starts from a known blank slate.

*Call graph*: 1 external calls (default).


##### `ChatWidget::set_initial_user_message_submit_suppressed`  (lines 41–43)

```
fn set_initial_user_message_submit_suppressed(&mut self, suppressed: bool)
```

**Purpose**: Turns automatic submission of the initial user message on or off. This lets startup or setup code delay the first message when the app is not ready to send it yet.

**Data flow**: A boolean comes in: true means suppress automatic submit, false means allow it. The function stores that choice in the widget. It returns nothing.

**Call relations**: This setting is later read by `ChatWidget::submit_initial_user_message_if_pending`. Other setup code can use it as a safety switch before the initial message is allowed to leave the composer.


##### `ChatWidget::submit_initial_user_message_if_pending`  (lines 45–56)

```
fn submit_initial_user_message_if_pending(&mut self)
```

**Purpose**: Submits the initial user message if one exists and submission is currently allowed. It prevents early sending when submission has been suppressed or, on supported builds, when required Windows sandbox setup is still pending.

**Data flow**: It reads the suppression flag, possible platform setup state, and the stored initial message. If sending is allowed and a message is present, it removes that message from storage and submits it. It returns nothing.

**Call relations**: This is called by surrounding ChatWidget startup or readiness code when the app may be ready to send the first message. If it does send, it hands the message to the normal user-message submission path.


##### `ChatWidget::pop_next_queued_user_message`  (lines 58–96)

```
fn pop_next_queued_user_message(
        &mut self,
    ) -> Option<(QueuedUserMessage, UserMessageHistoryRecord)>
```

**Purpose**: Takes the next message that should be sent from the waiting queue. Rejected steer instructions get priority and are merged together so they can be resent as one message.

**Data flow**: It looks first at the rejected-steer queue. If there are no rejected steers, it removes the oldest queued user message and its matching history record. If rejected steers exist, it drains all of them, fills in any missing history records with a safe default, merges them, and returns that combined message. The output is either a queued message plus its history record, or nothing if no message is waiting.

**Call relations**: This is used by the broader input queue flow when ChatWidget needs the next item to send. It relies on message conversion and merging helpers so callers receive one clean message/history pair rather than several fragmented queue entries.

*Call graph*: calls 1 internal fn (from).


##### `ChatWidget::pop_latest_queued_composer_state`  (lines 98–126)

```
fn pop_latest_queued_composer_state(&mut self) -> Option<ThreadComposerState>
```

**Purpose**: Pulls the most recent queued input back into a composer-shaped draft. This is useful when the user needs the latest waiting message restored for editing instead of being sent.

**Data flow**: It first tries to remove the newest queued user message and its history record. If none exists, it tries the newest rejected steer instead. The selected message is adjusted for restore display and converted into a `ThreadComposerState`, including pending paste data when available. It returns that composer state or nothing.

**Call relations**: This function is part of the “bring it back into the text box” path. It uses `ChatWidget::composer_state_from_user_message` to turn a stored message into the same shape that the composer understands.

*Call graph*: 2 external calls (composer_state_from_user_message, new).


##### `ChatWidget::enqueue_rejected_steer`  (lines 128–143)

```
fn enqueue_rejected_steer(&mut self) -> bool
```

**Purpose**: Moves the oldest pending steer instruction into the rejected-steer queue after the app learns it could not be applied to the active turn. This keeps the user’s instruction available instead of dropping it.

**Data flow**: It removes one pending steer from the front of the pending-steer queue. If one exists, it stores its message and history record in the rejected queues, refreshes the pending-input preview, and returns true. If no matching pending steer exists, it logs a warning and returns false.

**Call relations**: This is called when the system reports that an active turn was not steerable. It feeds later restore or resend paths, such as `ChatWidget::pop_next_queued_user_message` and `ChatWidget::drain_pending_messages_for_restore`, by preserving the rejected input.

*Call graph*: 1 external calls (warn!).


##### `ChatWidget::on_interrupted_turn`  (lines 149–198)

```
fn on_interrupted_turn(&mut self, reason: TurnAbortReason)
```

**Purpose**: Responds when a model turn stops early, such as from the user pressing Escape, running out of budget, or completing review. Its main job is to end the running turn cleanly and make sure any unsent input is either restored to the composer or submitted in the right way.

**Data flow**: It receives the abort reason. It checks whether a cancel-edit prompt should be restored, finalizes the turn, decides whether to show an informational or error notice, then drains or submits pending input depending on queue settings. It refreshes previews, may send an app event to restore a cancelled prompt, and asks the interface to redraw.

**Call relations**: This is the central interruption flow in this file. It calls `ChatWidget::take_armed_cancel_edit_prompt` first, uses `ChatWidget::drain_pending_messages_for_restore` when queued input should return to the composer, calls `ChatWidget::restore_composer_state` to put that draft back on screen, and creates history notices with the info/error event helpers.

*Call graph*: calls 3 internal fn (drain_pending_messages_for_restore, restore_composer_state, take_armed_cancel_edit_prompt); 3 external calls (RestoreCancelledTurn, new_error_event, new_info_event).


##### `ChatWidget::drain_pending_messages_for_restore`  (lines 207–292)

```
fn drain_pending_messages_for_restore(&mut self) -> Option<ThreadComposerState>
```

**Purpose**: Combines all waiting input into one composer draft after an interrupt. It preserves the user’s words, images, mentions, and pasted blocks while making sure placeholders still point to the right content.

**Data flow**: It reads and drains rejected steers, pending steers, queued user messages, their history records, and the current composer draft. It converts each message into restore form, remaps paste placeholders to avoid collisions, merges the messages in order, and packages the result as a `ThreadComposerState`. If there is nothing to restore, it returns nothing.

**Call relations**: This helper is called by `ChatWidget::on_interrupted_turn` when pending input should be returned to the text box instead of auto-submitted. It uses `remap_colliding_paste_placeholders` for paste safety and `ChatWidget::composer_state_from_user_message` to produce the final composer state.

*Call graph*: calls 1 internal fn (remap_colliding_paste_placeholders); called by 1 (on_interrupted_turn); 3 external calls (new, composer_state_from_user_message, new).


##### `ChatWidget::restore_user_message_to_composer`  (lines 294–299)

```
fn restore_user_message_to_composer(&mut self, user_message: UserMessage)
```

**Purpose**: Places a single user message back into the composer so the user can see and edit it. This is a simple bridge from stored message form to visible draft form.

**Data flow**: A `UserMessage` comes in. The function turns it into a `ThreadComposerState` with no pending paste entries, then applies that state to the composer. It returns nothing.

**Call relations**: This function calls `ChatWidget::composer_state_from_user_message` and then `ChatWidget::restore_composer_state`. It is used by higher-level flows that already know exactly which one message should reappear in the input box.

*Call graph*: calls 1 internal fn (restore_composer_state); 2 external calls (composer_state_from_user_message, new).


##### `ChatWidget::restore_composer_state`  (lines 301–319)

```
fn restore_composer_state(&mut self, composer: ThreadComposerState)
```

**Purpose**: Rebuilds the visible composer from a saved composer state. This is the final step that actually puts restored text, images, mentions, remote image links, and pending paste data back into the UI.

**Data flow**: It receives a `ThreadComposerState`. It separates text, local images, remote image URLs, text metadata, mention bindings, and pending pastes; converts local image records into paths for the composer; updates remote image URLs; sets the composer text and bindings; and restores pending paste entries. It returns nothing.

**Call relations**: This is the shared restore endpoint for several flows. `ChatWidget::on_interrupted_turn`, `ChatWidget::restore_user_message_to_composer`, and `ChatWidget::restore_thread_input_state` all call it when they have reconstructed what the input box should contain.

*Call graph*: called by 3 (on_interrupted_turn, restore_thread_input_state, restore_user_message_to_composer).


##### `ChatWidget::composer_state_from_user_message`  (lines 321–340)

```
fn composer_state_from_user_message(
        user_message: UserMessage,
        pending_pastes: Vec<(String, String)>,
    ) -> ThreadComposerState
```

**Purpose**: Wraps a stored user message in the shape used by the thread composer. It is a small adapter between “message ready to send” data and “draft visible in the input box” data.

**Data flow**: It receives a `UserMessage` plus pending paste entries. It moves the message’s text, image lists, text element metadata, and mention bindings into a new `ThreadComposerState`, attaching the paste entries as well. The new composer state is returned.

**Call relations**: Several restore paths use this conversion before calling `ChatWidget::restore_composer_state` or returning composer state to a caller. It keeps the mapping between message data and composer data consistent.


##### `ChatWidget::capture_thread_input_state`  (lines 342–385)

```
fn capture_thread_input_state(&self) -> Option<ThreadInputState>
```

**Purpose**: Takes a snapshot of all input-related state for the current chat thread. This lets the app restore the user’s draft and queues later, for example after switching threads or rebuilding the UI.

**Data flow**: It reads the current composer draft, pending steers, rejected steers, queued messages, history records, collaboration settings, and running-task flags. It packages those values into a `ThreadInputState`, omitting the composer part if the draft has no content. It returns that snapshot wrapped in `Some`.

**Call relations**: This is the save half of the thread-input restore pair. `ChatWidget::restore_thread_input_state` is the matching load half that consumes this kind of snapshot and rebuilds the widget state.


##### `ChatWidget::restore_thread_input_state`  (lines 387–449)

```
fn restore_thread_input_state(&mut self, input_state: Option<ThreadInputState>)
```

**Purpose**: Restores the chat input area and its queues from a saved thread snapshot, or clears them when no snapshot is available. This is what makes switching back to a thread feel like returning to the same desk with the same draft still there.

**Data flow**: It receives an optional `ThreadInputState`. If a snapshot exists, it restores collaboration settings, running-turn state, composer contents, pending steers, rejected steers, queued messages, and missing default history records where needed. If no snapshot exists, it clears the input queue and composer. In both cases it refreshes task state, pending previews, status surfaces when needed, and redraws the UI.

**Call relations**: This is the load half of the snapshot system started by `ChatWidget::capture_thread_input_state`. It calls `ChatWidget::restore_composer_state` for the visible draft and uses the current time when rebuilding turn-running status.

*Call graph*: calls 1 internal fn (restore_composer_state); 2 external calls (default, now).


##### `ChatWidget::set_queue_autosend_suppressed`  (lines 451–453)

```
fn set_queue_autosend_suppressed(&mut self, suppressed: bool)
```

**Purpose**: Turns automatic sending of queued messages on or off. This gives other parts of the app a way to pause queue sending during sensitive moments.

**Data flow**: A boolean comes in. The function stores it in the input queue’s `suppress_queue_autosend` flag. It returns nothing.

**Call relations**: Other ChatWidget queue-control code reads this flag before automatically sending waiting messages. This function is the simple switch used by higher-level flows that need to temporarily stop autosend.


### `tui/src/chatwidget/input_submission.rs`

`domain_logic` · `input submission`

This file is the chat input gatekeeper. When a user sends something, it has to decide: is this a normal message for the model, a local shell command that starts with `!`, a message with images, or a message that must wait because the chat session is not ready yet? Without this code, pressing enter could lose drafts, send unsupported images, forget mention links, or fail to record message history.

The main flow builds a `UserMessage`, which is the user's visible text plus extras such as attached images and mention bindings. A mention binding is the hidden link behind something like a named tool, skill, plugin, or connected app, so the app knows exactly what the user meant instead of guessing from the name alone.

For normal chat messages, the file converts the message into `UserInput` items: text, local images, remote image URLs, selected skills, plugins, apps, and optional editor context. It checks whether the current model is available and whether it supports images or personality settings. Then it creates an `AppCommand` for a user turn and submits it to the rest of the application.

It also keeps the user experience safe. If a session is not configured, it queues the message. If images are blocked by the selected model, it restores the draft to the composer so the user can fix it. If another agent turn is already running, it stores the new input as a pending steer rather than simply showing it as a fresh chat turn.

#### Function details

##### `ChatWidget::user_message_from_submission`  (lines 6–22)

```
fn user_message_from_submission(
        &mut self,
        text: String,
        text_elements: Vec<TextElement>,
    ) -> UserMessage
```

**Purpose**: Builds a complete `UserMessage` from what the user just submitted. It gathers the visible text plus hidden extras like image attachments, remote image links, rich text pieces, and mention bindings.

**Data flow**: It receives the submitted text and its text elements. It then takes recent local images and mention bindings out of the bottom composer area, takes any remote image URLs stored on the widget, and packages everything into one `UserMessage` that can travel through the submission pipeline.

**Call relations**: This is the first packing step after the composer gives up its current contents. Later submission functions expect one complete `UserMessage`, so this function acts like putting all items from a desk into one envelope before mailing it.


##### `ChatWidget::submit_shell_command`  (lines 24–38)

```
fn submit_shell_command(&mut self, command: &str) -> QueueDrain
```

**Purpose**: Runs a user-entered local shell command when the command is not empty. If the user only typed the shell prefix without a real command, it shows a help message instead.

**Data flow**: It receives a command string, trims extra spaces, and checks whether anything remains. If empty, it sends an app event that inserts an informational history cell explaining shell command help and returns a signal to keep draining queued input. If non-empty, it creates and submits an app command to run that shell command, then returns a signal to stop draining.

**Call relations**: It is called by `ChatWidget::submit_shell_command_with_history`, which adds history behavior around it. Inside, it hands real commands off to `AppCommand::run_user_shell_command`; for empty commands, it uses a history info event instead of running anything.

*Call graph*: called by 1 (submit_shell_command_with_history); 4 external calls (new, run_user_shell_command, InsertHistoryCell, new_info_event).


##### `ChatWidget::submit_shell_command_with_history`  (lines 40–50)

```
fn submit_shell_command_with_history(
        &mut self,
        command: &str,
        history_text: &str,
    ) -> QueueDrain
```

**Purpose**: Runs a shell command and records it in message history only when it was actually accepted as a real command. This prevents a blank `!` help prompt from being saved as if it were a command.

**Data flow**: It receives the command to execute and the text that should be stored in history. It calls `ChatWidget::submit_shell_command`. If that call says the queue should stop, meaning a real command was submitted, it appends the history text. It returns the same queue-draining decision it got back.

**Call relations**: It wraps `ChatWidget::submit_shell_command` for both queued shell prompts and inline `!command` submissions from normal message handling. It is the small bridge between command execution and durable message history.

*Call graph*: calls 1 internal fn (submit_shell_command); called by 2 (submit_queued_shell_prompt, submit_user_message_with_history_and_shell_escape_policy).


##### `ChatWidget::submit_queued_shell_prompt`  (lines 52–63)

```
fn submit_queued_shell_prompt(&mut self, user_message: UserMessage) -> QueueDrain
```

**Purpose**: Submits a message that was waiting in the input queue, while preserving the special rule that text starting with `!` is treated as a shell command. This is used when queued input is later replayed.

**Data flow**: It receives a queued `UserMessage`. If the text starts with `!`, it removes that prefix and submits the rest as a shell command, using the original text for history. If it does not start with `!`, it submits the message as a normal user chat message. The result tells the queue whether to continue or stop.

**Call relations**: When queued input is being processed, this function chooses between `ChatWidget::submit_shell_command_with_history` and `ChatWidget::submit_user_message`. It keeps queued shell prompts from accidentally being sent to the model as ordinary text.

*Call graph*: calls 2 internal fn (submit_shell_command_with_history, submit_user_message).


##### `ChatWidget::submit_user_message`  (lines 65–70)

```
fn submit_user_message(&mut self, user_message: UserMessage)
```

**Purpose**: Submits a normal user message using the standard history behavior. It is the simple entry point when the caller does not need special history or shell-escape rules.

**Data flow**: It receives a `UserMessage` and passes it along with the default `UserMessageHistoryRecord::UserMessageText` setting. It ignores the detailed success value because this wrapper is used when callers only want to fire the submission through the normal path.

**Call relations**: It is called by `ChatWidget::submit_queued_shell_prompt` for queued messages that are not shell commands. It delegates the real work to `ChatWidget::submit_user_message_with_history_record`.

*Call graph*: calls 1 internal fn (submit_user_message_with_history_record); called by 1 (submit_queued_shell_prompt).


##### `ChatWidget::submit_user_message_with_history_record`  (lines 72–83)

```
fn submit_user_message_with_history_record(
        &mut self,
        user_message: UserMessage,
        history_record: UserMessageHistoryRecord,
    ) -> bool
```

**Purpose**: Submits a user message while letting the caller choose what text should be saved in history. It still uses the normal rule that `!command` can escape to the local shell.

**Data flow**: It receives a `UserMessage` and a history-record choice. It forwards both into the main submission function with shell escaping allowed, then returns only the boolean part: whether the message was accepted.

**Call relations**: This function is called by `ChatWidget::submit_user_message` and feeds into `ChatWidget::submit_user_message_with_history_and_shell_escape_policy`, the main worker. It is a convenience layer for callers that care about history but not about the generated app command.

*Call graph*: calls 1 internal fn (submit_user_message_with_history_and_shell_escape_policy); called by 1 (submit_user_message).


##### `ChatWidget::submit_user_message_with_shell_escape_policy`  (lines 85–96)

```
fn submit_user_message_with_shell_escape_policy(
        &mut self,
        user_message: UserMessage,
        shell_escape_policy: ShellEscapePolicy,
    ) -> Option<AppCommand>
```

**Purpose**: Submits a user message while letting the caller decide whether leading `!` should be treated as a shell command or just ordinary text. It returns the app command if one was created.

**Data flow**: It receives a `UserMessage` and a `ShellEscapePolicy`. It uses the normal message text as the history record, passes everything to the main submission function, and returns the optional `AppCommand` that resulted.

**Call relations**: This wrapper is for flows that need control over shell escaping. It delegates to `ChatWidget::submit_user_message_with_history_and_shell_escape_policy`, which performs the real checks, conversions, and submission.

*Call graph*: calls 1 internal fn (submit_user_message_with_history_and_shell_escape_policy).


##### `ChatWidget::submit_user_message_with_history_and_shell_escape_policy`  (lines 98–421)

```
fn submit_user_message_with_history_and_shell_escape_policy(
        &mut self,
        user_message: UserMessage,
        history_record: UserMessageHistoryRecord,
        shell_escape_policy: ShellE
```

**Purpose**: This is the main submission engine for user input. It validates the message, turns it into model-ready input items, resolves mentions, applies current chat settings, submits the app command, and updates history and pending-input state.

**Data flow**: It receives a full `UserMessage`, a rule for what to save in history, and a rule for whether `!` may run a shell command. First it queues the message if the session is not ready. It rejects completely empty input. It restores image drafts if the current model cannot accept images. If shell escaping is allowed and the text starts with `!`, it routes the input to shell-command submission instead of the model. Otherwise, it builds a list of user input items from remote images, local images, text, skills, plugins, apps, and optional editor context. It checks that a model is available, gathers settings such as approval policy, permission profile, collaboration mode, personality, and service tier, creates an `AppCommand::user_turn`, and submits it. After submission, it records history, pending steers, cancel/edit candidates, visible transcript content, and redraw-related state as needed. It returns whether the input was accepted and the command that was submitted, if any.

**Call relations**: The simpler submission wrappers all lead here. It calls `ChatWidget::submit_shell_command_with_history` for `!command` input, calls `ChatWidget::restore_blocked_image_submission` when images cannot be sent, uses mention and connector lookup helpers to turn typed names into concrete inputs, and finally hands the completed user turn to the app through `submit_op`.

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

**Purpose**: Puts a blocked image message back into the composer so the user does not lose their draft. This matters when the selected model cannot accept image inputs.

**Data flow**: It receives the text, text elements, local image attachments, mention bindings, and remote image URLs from the blocked submission. It stores the remote image URLs back on the widget, puts the text, local image paths, and mention bindings back into the composer, adds a warning message to the conversation history, and requests a redraw so the user sees the restored draft and warning.

**Call relations**: It is called by `ChatWidget::submit_user_message_with_history_and_shell_escape_policy` when image input is present but unsupported. It uses a warning history cell to explain the problem, then returns control to the normal UI instead of submitting anything.

*Call graph*: called by 1 (submit_user_message_with_history_and_shell_escape_policy); 1 external calls (new_warning_event).


### `tui/src/chatwidget/input_flow.rs`

`orchestration` · `request handling`

This file is the traffic controller for user input in the terminal chat screen. When a user presses Enter, the input might be a normal chat message, a slash command, a shell command, or something that must wait because the session is not ready or another turn is still running. Without this logic, messages could be sent at the wrong time, dropped, or hidden from the user while the assistant is busy.

The main idea is a queue, like a small waiting line at a counter. If the app is ready, a message can go straight to submission. If the app is still setting up, streaming a plan, or running a previous turn, the message is saved in `input_queue`. The bottom pane then shows a preview so the user can see what is waiting.

The file also protects special cases. For example, if only user-started shell commands are running, a normal chat message is queued instead of interrupting that work. When a modal window or popup closes, the file may send the next queued input. It sends at most one normal follow-up at a time, so each assistant turn has a clear beginning and end.

A few helper methods answer questions such as “is a turn already running?” and “are only user shell commands active?” Other methods refresh the visible pending-input preview or submit text with a chosen collaboration mode, such as plan mode.

#### Function details

##### `ChatWidget::handle_composer_input_result`  (lines 10–70)

```
fn handle_composer_input_result(
        &mut self,
        input_result: InputResult,
        had_modal_or_popup: bool,
    )
```

**Purpose**: This is the main decision point after the composer reports what the user did. It turns submitted text into a chat message, routes commands to command handling, queues messages when the app is busy, and starts submission when it is safe.

**Data flow**: It receives an `InputResult`, which says what came from the input box, plus a flag saying whether a modal or popup had been open. For submitted text, it builds a user message, ignores it if it is completely empty, then either submits it or places it in the queue. For queued input, it stores the message with its requested action. For commands, it sends them to the appropriate command dispatcher. Afterward, if a popup just cleared, it may send the next queued input, and it refreshes the plan-mode hint shown to the user.

**Call relations**: This function sits at the front of the input flow. When it needs to postpone work, it calls `ChatWidget::queue_user_message` or `ChatWidget::queue_user_message_with_options`. Before sending a normal message while commands are running, it checks `ChatWidget::only_user_shell_commands_running`. If the screen just became clear after a modal or popup, it calls `ChatWidget::maybe_send_next_queued_input` to resume the waiting line.

*Call graph*: calls 4 internal fn (maybe_send_next_queued_input, only_user_shell_commands_running, queue_user_message, queue_user_message_with_options); 1 external calls (from).


##### `ChatWidget::queue_user_message`  (lines 72–74)

```
fn queue_user_message(&mut self, user_message: UserMessage)
```

**Purpose**: This is the simple way to put a normal user message into the queue. It is used when there are no special queue actions or pending paste details to preserve.

**Data flow**: It receives a `UserMessage`. It wraps that message with the default queue action, meaning “send this as plain chat later,” and uses an empty list for pending pastes. It then passes everything to the more detailed queueing function.

**Call relations**: This is a convenience step used by `ChatWidget::handle_composer_input_result` when a submitted message must wait, and by `ChatWidget::submit_user_message_with_mode` when plan streaming means the new text should not be sent immediately. It delegates the real queue decision to `ChatWidget::queue_user_message_with_options`.

*Call graph*: calls 1 internal fn (queue_user_message_with_options); called by 2 (handle_composer_input_result, submit_user_message_with_mode); 1 external calls (new).


##### `ChatWidget::set_queue_submissions_until_session_configured`  (lines 76–79)

```
fn set_queue_submissions_until_session_configured(&mut self, queue: bool)
```

**Purpose**: This tells the bottom pane whether new submissions should be visibly held back until the chat session is ready. It prevents the interface from pretending a message can be sent before the backend session exists.

**Data flow**: It receives a boolean request to queue submissions. It combines that request with the current session state: queueing is enabled only if the caller asked for it and the session is not configured yet. It then updates the bottom pane’s submission behavior.

**Call relations**: This method is a small control switch for startup or session-change flows elsewhere in `ChatWidget`. It does not call the queue-draining helpers itself; instead, it changes how the input area behaves while the session is still being prepared.


##### `ChatWidget::queue_user_message_with_options`  (lines 81–102)

```
fn queue_user_message_with_options(
        &mut self,
        user_message: UserMessage,
        action: QueuedInputAction,
        pending_pastes: Vec<(String, String)>,
    )
```

**Purpose**: This is the full queueing path for user messages. It either stores a message for later, along with extra instructions, or submits it immediately if the app is idle and ready.

**Data flow**: It receives a user message, a queue action such as plain chat or slash-command parsing, and any pending paste data. It checks whether the session is configured and whether a user turn is already pending or running. If the app is not ready, it appends the message to the queue, records a matching history placeholder, and refreshes the pending-input preview. If the app is ready, it submits the message right away.

**Call relations**: `ChatWidget::handle_composer_input_result` calls this for explicitly queued input, and `ChatWidget::queue_user_message` calls it for ordinary queued messages. It relies on `ChatWidget::is_user_turn_pending_or_running` to avoid overlapping turns, and calls `ChatWidget::refresh_pending_input_preview` when the visible waiting list changes.

*Call graph*: calls 2 internal fn (is_user_turn_pending_or_running, refresh_pending_input_preview); called by 2 (handle_composer_input_result, queue_user_message).


##### `ChatWidget::maybe_send_next_queued_input`  (lines 105–144)

```
fn maybe_send_next_queued_input(&mut self) -> bool
```

**Purpose**: This tries to start the next waiting user input, but only when it is safe. It is careful to submit one normal follow-up at a time so turns do not blur together.

**Data flow**: It first checks whether automatic queue sending is suppressed, then checks whether a user turn is already pending or running. If sending is allowed, it repeatedly takes the next queued message. Plain messages are submitted as the next chat turn and then the function stops. Queued slash prompts and shell prompts are interpreted through their special submission paths, and those paths can say whether queue draining should continue or stop. At the end, it refreshes the pending-input preview and returns whether a follow-up was submitted.

**Call relations**: `ChatWidget::handle_composer_input_result` calls this after a modal or popup closes and no other popup is active. During its loop it repeatedly asks `ChatWidget::is_user_turn_pending_or_running` whether it must stop, and after changing the queue it calls `ChatWidget::refresh_pending_input_preview` so the bottom pane matches reality.

*Call graph*: calls 2 internal fn (is_user_turn_pending_or_running, refresh_pending_input_preview); called by 1 (handle_composer_input_result).


##### `ChatWidget::is_user_turn_pending_or_running`  (lines 146–148)

```
fn is_user_turn_pending_or_running(&self) -> bool
```

**Purpose**: This answers the simple question: is the chat already in the middle of starting or running a user turn? Other methods use it to avoid sending two turns at once.

**Data flow**: It reads two pieces of state: whether a turn has been marked as pending start, and whether the bottom pane reports a running task. If either is true, it returns true. It does not change anything.

**Call relations**: `ChatWidget::queue_user_message_with_options` uses this check to decide between storing a message and submitting it immediately. `ChatWidget::maybe_send_next_queued_input` uses it before and during queue draining so it stops as soon as a turn is active.

*Call graph*: called by 2 (maybe_send_next_queued_input, queue_user_message_with_options).


##### `ChatWidget::only_user_shell_commands_running`  (lines 150–157)

```
fn only_user_shell_commands_running(&self) -> bool
```

**Purpose**: This checks for a special busy state: the assistant turn is active, and the only running commands are shell commands started by the user. In that case, ordinary chat should wait rather than collide with those commands.

**Data flow**: It reads the turn lifecycle state and the map of running commands. It returns true only when an agent turn is marked running, there is at least one running command, and every running command came from the user-shell source. It does not modify state.

**Call relations**: `ChatWidget::handle_composer_input_result` calls this before submitting a normal message. If this check is true and the message is not explicitly a shell-style command starting with `!`, the message is queued instead of submitted immediately.

*Call graph*: called by 1 (handle_composer_input_result).


##### `ChatWidget::refresh_pending_input_preview`  (lines 160–167)

```
fn refresh_pending_input_preview(&mut self)
```

**Purpose**: This rebuilds the small preview of queued input shown in the bottom pane. It keeps the user informed about messages or steering instructions that are waiting.

**Data flow**: It asks the input queue to produce a preview. That preview contains queued messages, pending steering items, and rejected steering items. The method then sends those pieces to the bottom pane so the visible interface updates.

**Call relations**: `ChatWidget::queue_user_message_with_options` calls this after adding something to the queue. `ChatWidget::maybe_send_next_queued_input` calls it after draining or attempting to drain queued input, so the display reflects what remains.

*Call graph*: called by 2 (maybe_send_next_queued_input, queue_user_message_with_options).


##### `ChatWidget::submit_user_message_with_mode`  (lines 169–201)

```
fn submit_user_message_with_mode(
        &mut self,
        text: String,
        mut collaboration_mode: CollaborationModeMask,
    )
```

**Purpose**: This submits text while also applying a chosen collaboration mode, such as plan mode. It is used when the user action is not just “send this text,” but “send this text under this working mode.”

**Data flow**: It receives message text and a collaboration-mode setting. If the mode is plan mode and the configuration specifies a reasoning effort for plan mode, it adds that effort to the mode. If a turn is already running and the requested mode differs from the active one, it shows an error and stops. Otherwise, it records the selected mode, builds a plain `UserMessage` from the text, and either queues it during plan streaming or submits it immediately.

**Call relations**: This method is called from higher-level user actions that choose a mode before sending text. When plan streaming means the app should wait, it calls `ChatWidget::queue_user_message`; otherwise it continues into the normal submission path.

*Call graph*: calls 1 internal fn (queue_user_message); 1 external calls (new).


##### `ChatWidget::queued_user_message_texts`  (lines 204–216)

```
fn queued_user_message_texts(&self) -> Vec<String>
```

**Purpose**: This test-only helper returns the text of messages currently waiting in the input queues. It gives tests an easy way to check that queueing happened in the expected order.

**Data flow**: It reads rejected steering messages first, then ordinary queued user messages. From each queued item, it takes the text field and collects all of those strings into a vector. It does not change the queue.

**Call relations**: Because it is compiled only for tests, this function supports test code rather than normal runtime behavior. It lets tests inspect the queue state without needing to know the internal queue structure.


### `tui/src/chatwidget/interaction.rs`

`orchestration` · `request handling`

This file gives `ChatWidget` most of its direct user-interaction behavior. In plain terms, it answers: “The user pressed this key — should it type into the composer, close a popup, interrupt the assistant, paste an image, copy the last answer, rename the chat, or quit?” Without this layer, keystrokes would either go to the wrong place or trigger dangerous actions too easily.

The main routine first checks whether the bottom pane has an active view, such as a popup or modal. If so, most keys are handed there, like giving the front desk first chance to answer a question. Some global shortcuts, especially quit and reset-style shortcuts, are kept at the chat-widget level so they work consistently.

The file also protects users from surprises. Quitting can require pressing the same shortcut twice within a short time. Ctrl+C interrupts active work before it quits. Ctrl+D only starts quitting when the composer is empty. Image paste only attaches if the current model supports images; otherwise a warning is shown. Large paste bursts are delayed and flushed together so the interface does not redraw wastefully on every small paste fragment.

Several small helper methods expose composer state, external-editor state, footer hints, selection views, and copy history. Together they make the chat screen feel responsive while keeping risky actions deliberate.

#### Function details

##### `ChatWidget::handle_key_event`  (lines 6–172)

```
fn handle_key_event(&mut self, key_event: KeyEvent)
```

**Purpose**: This is the main keyboard router for the chat screen. It decides whether a key press belongs to a popup, the composer, a global shortcut, an image paste action, queued-message editing, collaboration mode switching, or interrupt/quit behavior.

**Data flow**: A raw `KeyEvent` comes in. The function checks the current UI state, such as whether a modal is open, whether a task is running, whether review mode is active, and whether queued input exists. It either forwards the key to the bottom pane, changes chat state, submits an app command, adds a history message, attaches an image, or asks for a redraw.

**Call relations**: This is the entry point for key handling inside this file. When it recognizes special shortcuts, it hands off to helpers such as `ChatWidget::on_ctrl_c`, `ChatWidget::on_ctrl_d`, `ChatWidget::attach_image`, and `ChatWidget::copy_last_agent_markdown`; otherwise it lets the bottom pane process the key and then reacts to the result.

*Call graph*: calls 5 internal fn (attach_image, copy_last_agent_markdown, on_ctrl_c, on_ctrl_d, ctrl); 7 external calls (Char, interrupt, format!, new_error_event, matches!, debug!, warn!).


##### `ChatWidget::attach_image`  (lines 178–189)

```
fn attach_image(&mut self, path: PathBuf)
```

**Purpose**: This adds a local image file to the message draft, but only if the current model can accept image input. If images are not supported, it leaves the draft alone and tells the user why.

**Data flow**: A file path comes in. The function checks the active model’s image support. If images are supported, it passes the path to the bottom pane and requests a redraw; if not, it adds a warning message to the chat history and redraws.

**Call relations**: `ChatWidget::handle_key_event` calls this after a successful image paste shortcut. This helper keeps the model-safety check close to the UI action so pasted images are not silently attached when they cannot be used.

*Call graph*: called by 1 (handle_key_event); 2 external calls (new_warning_event, info!).


##### `ChatWidget::composer_text_with_pending`  (lines 191–193)

```
fn composer_text_with_pending(&self) -> String
```

**Purpose**: This returns the current composer text, including any text that is still pending inside the composer. It is used when another part of the app needs to know what the user is preparing to send.

**Data flow**: It reads the bottom pane’s composer state and returns a `String` containing the visible draft plus pending input. It does not change the UI.

**Call relations**: This is a small pass-through from `ChatWidget` to the bottom pane. It lets outside chat-widget code ask for composer text without needing to know the bottom pane’s internal structure.


##### `ChatWidget::apply_external_edit`  (lines 195–199)

```
fn apply_external_edit(&mut self, text: String)
```

**Purpose**: This replaces or updates the composer text with content returned from an external editor. It then refreshes any plan-mode hint that depends on the draft text.

**Data flow**: Edited text comes in as a `String`. The function sends it to the bottom pane, refreshes the plan-mode nudge, and requests a redraw so the new draft appears on screen.

**Call relations**: This method is used after an external editing flow completes. It does not do the editing itself; it applies the finished text to the composer and updates nearby UI state.


##### `ChatWidget::external_editor_state`  (lines 201–203)

```
fn external_editor_state(&self) -> ExternalEditorState
```

**Purpose**: This reports the current state of the external editor flow. Other code can use it to know whether an editor is idle, launching, or otherwise in progress.

**Data flow**: It reads the `external_editor_state` field from the chat widget and returns it. No UI state is changed.

**Call relations**: This is a simple state accessor for code that coordinates launching or tracking an outside text editor.


##### `ChatWidget::set_external_editor_state`  (lines 205–207)

```
fn set_external_editor_state(&mut self, state: ExternalEditorState)
```

**Purpose**: This records a new state for the external editor flow. It is used so the chat widget knows where that flow currently stands.

**Data flow**: A new `ExternalEditorState` comes in. The function stores it in the chat widget. It returns nothing and does not redraw by itself.

**Call relations**: This pairs with `ChatWidget::external_editor_state`: one reads the state, the other updates it. Other orchestration code can use these methods without touching the field directly.


##### `ChatWidget::set_footer_hint_override`  (lines 209–211)

```
fn set_footer_hint_override(&mut self, items: Option<Vec<(String, String)>>)
```

**Purpose**: This temporarily changes the footer hints shown near the composer. Footer hints are the small key-command reminders shown to the user.

**Data flow**: It receives either a list of hint label/value pairs or `None`. It passes that override to the bottom pane, which is responsible for displaying the footer.

**Call relations**: This is a bridge from chat-level code to the bottom pane’s footer display. It lets other flows change the visible hints without owning the rendering details.


##### `ChatWidget::show_selection_view`  (lines 213–217)

```
fn show_selection_view(&mut self, params: SelectionViewParams)
```

**Purpose**: This opens a selection-style view in the bottom pane, such as a small chooser the user can navigate. It also updates plan-mode hints because opening a view can change what the user should see next.

**Data flow**: Selection view parameters come in. The function tells the bottom pane to show that view, refreshes the plan-mode nudge, and requests a redraw.

**Call relations**: This is used by higher-level chat flows that need the user to choose something. The actual view is shown by the bottom pane; this method wires it into the chat widget’s refresh behavior.


##### `ChatWidget::no_modal_or_popup_active`  (lines 219–221)

```
fn no_modal_or_popup_active(&self) -> bool
```

**Purpose**: This answers whether the chat screen is currently free of modal dialogs or popups. Many shortcuts only run when no temporary view is in the way.

**Data flow**: It asks the bottom pane whether any modal or popup is active and returns a boolean answer. It does not change state.

**Call relations**: This is a convenience wrapper around the bottom pane. It helps other chat-widget code make safe decisions about whether global actions should run.


##### `ChatWidget::can_launch_external_editor`  (lines 223–225)

```
fn can_launch_external_editor(&self) -> bool
```

**Purpose**: This answers whether it is currently safe to open an external editor for the composer. For example, the app may avoid launching one while another view is active.

**Data flow**: It asks the bottom pane for its current editor-launch availability and returns that yes-or-no result. Nothing is changed.

**Call relations**: External-editor orchestration can call this before starting the editor. The bottom pane remains the source of truth for whether the composer is ready.


##### `ChatWidget::can_run_ctrl_l_clear_now`  (lines 227–238)

```
fn can_run_ctrl_l_clear_now(&mut self) -> bool
```

**Purpose**: This checks whether Ctrl+L is allowed to clear the screen right now. It blocks clearing while a task is running, so the user does not lose useful visible context during active work.

**Data flow**: It reads whether the bottom pane reports a running task. If no task is running, it returns `true`. If a task is running, it adds an error message to history, requests a redraw, and returns `false`.

**Call relations**: Other key-command code can call this before performing the clear action. It uses the same rule as the `/clear` command and reports the reason through a history error event.

*Call graph*: 1 external calls (new_error_event).


##### `ChatWidget::copy_last_agent_markdown`  (lines 241–243)

```
fn copy_last_agent_markdown(&mut self)
```

**Purpose**: This copies the assistant’s most recent response, in raw Markdown form, to the system clipboard. It is the normal user-facing copy action.

**Data flow**: It takes no direct input. It calls the more general copy helper with the real clipboard function, which reads the saved last assistant message, attempts the copy, and records success or failure.

**Call relations**: `ChatWidget::handle_key_event` calls this when the configured copy shortcut is pressed. This wrapper keeps normal app behavior simple while `ChatWidget::copy_last_agent_markdown_with` supports testing with a fake clipboard.

*Call graph*: calls 1 internal fn (copy_last_agent_markdown_with); called by 1 (handle_key_event).


##### `ChatWidget::truncate_agent_copy_history_to_user_turn_count`  (lines 245–251)

```
fn truncate_agent_copy_history_to_user_turn_count(
        &mut self,
        user_turn_count: usize,
    )
```

**Purpose**: This trims stored copyable assistant responses so they match a given number of user turns. It helps keep copy history consistent after rewinding or shortening a conversation.

**Data flow**: A target user-turn count comes in. The function tells the transcript to discard copy-history entries beyond that point. It returns nothing.

**Call relations**: This is a chat-widget doorway into transcript maintenance. Other conversation-lifecycle code can use it when the visible thread history changes.


##### `ChatWidget::copy_last_agent_markdown_with`  (lines 254–281)

```
fn copy_last_agent_markdown_with(
        &mut self,
        copy_fn: impl FnOnce(&str) -> Result<Option<crate::clipboard_copy::ClipboardLease>, String>,
    )
```

**Purpose**: This is the inner copy routine, written so tests can provide a fake clipboard. It copies the saved assistant response when possible and shows a clear success or error message.

**Data flow**: It receives a clipboard-copy function. It reads the transcript’s last saved assistant Markdown. If text exists, it passes that text to the copy function and stores any clipboard lease it returns; if copying fails or no copyable response exists, it adds an error event. It always requests a redraw at the end.

**Call relations**: `ChatWidget::copy_last_agent_markdown` calls this with the real clipboard backend. The helper adds history messages using info or error events so the user gets feedback after the shortcut.

*Call graph*: called by 1 (copy_last_agent_markdown); 3 external calls (format!, new_error_event, new_info_event).


##### `ChatWidget::last_agent_markdown_text`  (lines 284–286)

```
fn last_agent_markdown_text(&self) -> Option<&str>
```

**Purpose**: This test-only helper exposes the saved last assistant response as plain text. It exists so tests can check copy-related state without reaching into private fields.

**Data flow**: It reads `last_agent_markdown` from the transcript and returns it as an optional string slice. It does not change anything.

**Call relations**: Because it is compiled only for tests, it supports verification around transcript and copy behavior rather than normal runtime interaction.


##### `ChatWidget::show_rename_prompt`  (lines 288–316)

```
fn show_rename_prompt(&mut self)
```

**Purpose**: This opens a small prompt that lets the user name or rename the current chat thread. It prevents the prompt from opening when renaming is blocked.

**Data flow**: It first checks whether renaming is allowed. If allowed, it builds a prompt title and initial text from the existing thread name, then shows a custom prompt in the bottom pane. When the user submits text, the prompt normalizes the name, reports an error if it is empty, or sends an event to update the thread name.

**Call relations**: This method calls `ChatWidget::ensure_thread_rename_allowed` before creating the prompt. It hands the finished view to the bottom pane, while the prompt callback sends app events when the user confirms a name.

*Call graph*: calls 2 internal fn (new, ensure_thread_rename_allowed); 1 external calls (new).


##### `ChatWidget::ensure_thread_rename_allowed`  (lines 318–326)

```
fn ensure_thread_rename_allowed(&mut self) -> bool
```

**Purpose**: This checks whether the current thread may be renamed. If renaming is blocked, it tells the user the reason.

**Data flow**: It reads an optional stored block message. If a message exists, it adds that message as an error and returns `false`; otherwise it returns `true`.

**Call relations**: `ChatWidget::show_rename_prompt` calls this before opening the rename UI. This keeps the prompt from appearing when the app already knows the rename cannot succeed.

*Call graph*: called by 1 (show_rename_prompt).


##### `ChatWidget::handle_paste`  (lines 328–331)

```
fn handle_paste(&mut self, text: String)
```

**Purpose**: This sends pasted text into the composer. It also refreshes plan-mode guidance because pasted content can change what mode or hint should be shown.

**Data flow**: A pasted text string comes in. The function passes it to the bottom pane’s paste handling and then refreshes the plan-mode nudge. It does not directly return a value.

**Call relations**: Paste delivery code can call this when the terminal reports pasted text. The bottom pane updates the draft, while this method keeps chat-level hinting in sync.


##### `ChatWidget::handle_paste_burst_tick`  (lines 334–350)

```
fn handle_paste_burst_tick(&mut self, frame_requester: FrameRequester) -> bool
```

**Purpose**: This smooths out rapid paste input so the interface does not redraw too often while a large paste is still arriving. It decides whether the current frame should be skipped because a better one is coming soon.

**Data flow**: A frame requester comes in. The function asks the bottom pane whether a paste burst is ready to flush. If it flushes, the plan nudge is refreshed, a redraw is requested, and `true` is returned. If the burst is still ongoing, it schedules another frame after the recommended delay and returns `true`. If no burst is active, it returns `false`.

**Call relations**: The render or frame loop can call this during paste bursts. It uses the composer’s recommended paste delay and the frame requester to avoid redundant redraws.

*Call graph*: calls 2 internal fn (recommended_paste_flush_delay, schedule_frame_in).


##### `ChatWidget::on_ctrl_c`  (lines 360–402)

```
fn on_ctrl_c(&mut self)
```

**Purpose**: This defines what Ctrl+C means on the chat screen. Depending on state, it can let the bottom pane cancel something, arm a double-press quit shortcut, interrupt active work, pause an active goal, or quit.

**Data flow**: It reads whether a modal is open, whether the bottom pane consumes Ctrl+C, whether double-press quit is enabled, whether work is cancellable, and whether the quit shortcut is already armed. It then clears or arms quit state, sends interrupt commands when needed, pauses an active goal when appropriate, or requests quitting.

**Call relations**: `ChatWidget::handle_key_event` calls this when it sees Ctrl+C. This method relies on `ChatWidget::arm_quit_shortcut`, `ChatWidget::quit_shortcut_active_for`, `ChatWidget::is_cancellable_work_active`, and `ChatWidget::pause_active_goal_for_interrupt` to keep the behavior safe and predictable.

*Call graph*: calls 5 internal fn (arm_quit_shortcut, is_cancellable_work_active, pause_active_goal_for_interrupt, quit_shortcut_active_for, ctrl); called by 1 (handle_key_event); 2 external calls (Char, interrupt_and_restore_prompt_if_no_output).


##### `ChatWidget::on_ctrl_d`  (lines 408–433)

```
fn on_ctrl_d(&mut self) -> bool
```

**Purpose**: This defines what Ctrl+D means on the chat screen. It only participates in quitting when the composer is empty and no popup or modal is active.

**Data flow**: It checks the double-press quit setting, the current quit shortcut state, whether the composer is empty, and whether a modal or popup is open. It either requests quit, arms the quit shortcut, returns `false` so the key can be routed elsewhere, or returns `true` to say it handled the key.

**Call relations**: `ChatWidget::handle_key_event` calls this when it sees Ctrl+D. It uses `ChatWidget::quit_shortcut_active_for` and `ChatWidget::arm_quit_shortcut` for the double-press quit flow.

*Call graph*: calls 3 internal fn (arm_quit_shortcut, quit_shortcut_active_for, ctrl); called by 1 (handle_key_event); 1 external calls (Char).


##### `ChatWidget::quit_shortcut_active_for`  (lines 436–441)

```
fn quit_shortcut_active_for(&self, key: KeyBinding) -> bool
```

**Purpose**: This checks whether a specific quit shortcut is currently armed and still within its short time window. It prevents an old first key press from causing a quit much later.

**Data flow**: A key binding comes in. The function compares it with the stored quit shortcut key and checks whether the stored expiry time is still in the future. It returns `true` only when both match.

**Call relations**: `ChatWidget::on_ctrl_c` and `ChatWidget::on_ctrl_d` call this before deciding that a second shortcut press should quit. It is the timer check for the double-press safety feature.

*Call graph*: called by 2 (on_ctrl_c, on_ctrl_d).


##### `ChatWidget::arm_quit_shortcut`  (lines 448–454)

```
fn arm_quit_shortcut(&mut self, key: KeyBinding)
```

**Purpose**: This starts the short window where pressing the same quit shortcut again will exit the app. It also shows a footer hint so the user knows what just happened.

**Data flow**: A key binding comes in. The function records that key, sets an expiry time a short duration in the future, and tells the bottom pane to show the quit-shortcut hint.

**Call relations**: `ChatWidget::on_ctrl_c` and `ChatWidget::on_ctrl_d` call this when the first quit-related shortcut press should not quit immediately. It stores the state in `ChatWidget` and delegates the visual hint to the bottom pane.

*Call graph*: called by 2 (on_ctrl_c, on_ctrl_d); 1 external calls (now).


##### `ChatWidget::is_cancellable_work_active`  (lines 457–459)

```
fn is_cancellable_work_active(&self) -> bool
```

**Purpose**: This answers whether Ctrl+C should interrupt work instead of simply quitting. Review mode counts as cancellable work, even if the bottom pane is not reporting a normal running task.

**Data flow**: It reads whether the bottom pane has a running task and whether review mode is active. It returns `true` if either condition is true.

**Call relations**: `ChatWidget::on_ctrl_c` calls this to decide whether to submit an interrupt command. This keeps the interrupt-versus-quit decision in one small place.

*Call graph*: called by 1 (on_ctrl_c).


##### `ChatWidget::pause_active_goal_for_interrupt`  (lines 461–479)

```
fn pause_active_goal_for_interrupt(&self)
```

**Purpose**: This marks the current thread goal as paused when the user interrupts an active assistant turn. It keeps goal status aligned with the user’s decision to stop the running work.

**Data flow**: It reads whether an agent turn is running, whether the current goal status is active, and whether there is a thread id. If all are true, it sends an app event changing that thread’s goal status to paused. If any condition is missing, it does nothing.

**Call relations**: `ChatWidget::on_ctrl_c` calls this before submitting an interrupt command. It does not interrupt by itself; it updates the thread-goal status so the rest of the app sees that the goal was paused because of the interrupt.

*Call graph*: called by 1 (on_ctrl_c).


### Command and context features
Routes slash commands and supports the contextual command features that enrich or specialize chat input.

### `tui/src/chatwidget/skills.rs`

`domain_logic` · `request handling`

A “skill” here is an add-on the assistant can use, described by a SKILL.md file. This file is the chat widget’s skill control center. It gives users two main doors: a quick way to open the skill mention list by typing the mention symbol, and a menu where they can choose to list skills or turn skills on and off.

It also keeps the chat widget’s local skill list in sync with data from the server. When the server sends many skill lists for different working folders, this file picks the one for the current folder. It then converts enabled skills into the core format used by mention autocomplete and later assistant behavior.

Another important job is reading the user’s typed message and finding mentions such as `$my-skill` or linked mentions like `[$my-skill](skill://...)`. Think of this as a receptionist checking names on a guest list: it extracts the names, connects them to known skill paths when possible, and avoids mistaking common environment variables like `$PATH` for skill mentions. It can also recognize app mentions such as `app://google_drive`, but only if the app is both accessible and enabled.

Finally, it improves command display by labeling reads of SKILL.md files with the skill name, so users can better understand why a file was read.

#### Function details

##### `ChatWidget::open_skills_list`  (lines 27–33)

```
fn open_skills_list(&mut self)
```

**Purpose**: This opens the skill mention list from the chat input. It inserts the right mention symbol into the input box, using `@` when the newer mentions feature is enabled and `$` otherwise.

**Data flow**: It reads the chat widget configuration to see which mentions feature is active. Based on that setting, it adds one character to the current input text. It does not return a value; the visible chat input changes.

**Call relations**: This is used when the user asks to open the skills list directly. It does not build the list itself; it nudges the existing input and mention system by inserting the trigger character.


##### `ChatWidget::open_skills_menu`  (lines 35–71)

```
fn open_skills_menu(&mut self)
```

**Purpose**: This opens a small menu called “Skills” with choices for listing skills or enabling and disabling them. It gives users a friendly control panel instead of requiring them to remember shortcuts.

**Data flow**: It reads the feature flag to decide whether the direct-list shortcut should be shown as `@` or `$`. It builds two menu items, each with an action that sends an app event when selected, then asks the bottom pane to show that selection view.

**Call relations**: When the user opens the skills menu, this function prepares the visible choices. Selecting “List skills” sends an event to open the list, while selecting “Enable/Disable Skills” sends an event that later leads to `ChatWidget::open_manage_skills_popup`.

*Call graph*: calls 1 internal fn (standard_popup_hint_line); 2 external calls (default, vec!).


##### `ChatWidget::open_manage_skills_popup`  (lines 73–110)

```
fn open_manage_skills_popup(&mut self)
```

**Purpose**: This opens the popup where users can turn individual skills on or off. If there are no skills, it tells the user instead of showing an empty control.

**Data flow**: It reads all known skills from the chat widget. First it records each skill’s current enabled state so later it can report what changed. Then it converts each server-format skill into the core skill format, builds a toggle row with a display name, description, path, and current on/off state, and shows the toggle view in the bottom pane.

**Call relations**: This function is reached from the skills menu flow. It relies on `protocol_skill_to_core` to translate server skill records into the format expected by UI helper functions, then hands the finished rows to `SkillsToggleView` for display.

*Call graph*: calls 1 internal fn (new); 2 external calls (new, new).


##### `ChatWidget::update_skill_enabled`  (lines 112–119)

```
fn update_skill_enabled(&mut self, path: AbsolutePathBuf, enabled: bool)
```

**Purpose**: This records that one skill has been turned on or off. It also refreshes the set of enabled skills used by mention autocomplete.

**Data flow**: It receives a skill file path and a new enabled value. It scans the stored skill list, changes the matching skill’s enabled flag, then rebuilds the enabled-skill list and gives it back to the chat widget’s skill mention system.

**Call relations**: The skills toggle popup calls this kind of update when a user flips a switch. It then uses `enabled_skills_for_mentions` so the mention list immediately reflects the user’s choices.

*Call graph*: calls 1 internal fn (enabled_skills_for_mentions).


##### `ChatWidget::handle_manage_skills_closed`  (lines 121–152)

```
fn handle_manage_skills_closed(&mut self)
```

**Purpose**: This reports how many skills were enabled or disabled while the manage-skills popup was open. It avoids bothering the user if nothing changed.

**Data flow**: It takes the saved starting state, compares it with the current skill states, counts how many changed from off to on and from on to off, and adds an informational chat message if either count is nonzero. It also clears the saved starting state.

**Call relations**: This belongs at the end of the manage-skills popup flow. `ChatWidget::open_manage_skills_popup` saves the original states; this function compares against them when the popup closes.

*Call graph*: 2 external calls (new, format!).


##### `ChatWidget::set_skills_from_response`  (lines 154–158)

```
fn set_skills_from_response(&mut self, response: &SkillsListResponse)
```

**Purpose**: This updates the chat widget when the app server sends a list of available skills. It keeps only the skills that apply to the current working folder.

**Data flow**: It receives a server response containing skill lists for one or more folders. It reads the chat widget’s current folder, picks the matching skill list, stores it as the full skill list, then separately prepares the enabled skills for mentions.

**Call relations**: This is the entry point for fresh skill data from the server. It delegates folder matching to `skills_for_cwd` and enabled-skill filtering and conversion to `enabled_skills_for_mentions`.

*Call graph*: calls 2 internal fn (enabled_skills_for_mentions, skills_for_cwd).


##### `ChatWidget::annotate_skill_reads_in_parsed_cmd`  (lines 160–187)

```
fn annotate_skill_reads_in_parsed_cmd(
        &self,
        mut parsed_cmd: Vec<ParsedCommand>,
    ) -> Vec<ParsedCommand>
```

**Purpose**: This makes command summaries clearer when the assistant reads a skill file. If a parsed command says it read `SKILL.md`, this function can add the skill name beside it.

**Data flow**: It receives a list of parsed command records. For each record that is a file read named `SKILL.md`, it compares the read path with known skill paths. When it finds an exact match, it changes the displayed name to include the skill’s name. It returns the updated command list.

**Call relations**: This is used after commands have already been parsed and before they are shown to the user. It does not discover skills itself; it uses the skill list already stored in the chat widget.

*Call graph*: 1 external calls (format!).


##### `skills_for_cwd`  (lines 190–199)

```
fn skills_for_cwd(
    cwd: &AbsolutePathBuf,
    skills_entries: &[SkillsListEntry],
) -> Vec<ProtocolSkillMetadata>
```

**Purpose**: This picks the skills that belong to the current working directory. It prevents the chat screen from showing skills meant for a different folder.

**Data flow**: It receives the current folder path and a list of server entries, where each entry has a folder and its skills. It searches for the entry whose folder matches the current one and returns that entry’s skills, or an empty list if there is no match.

**Call relations**: It is called by `ChatWidget::set_skills_from_response` when fresh server data arrives. Its output becomes the chat widget’s full local skill list.

*Call graph*: called by 1 (set_skills_from_response); 1 external calls (iter).


##### `enabled_skills_for_mentions`  (lines 201–207)

```
fn enabled_skills_for_mentions(skills: &[ProtocolSkillMetadata]) -> Vec<SkillMetadata>
```

**Purpose**: This creates the list of skills that should appear in mention suggestions. Disabled skills are left out.

**Data flow**: It receives all server-format skills. It keeps only those marked enabled, converts each one to the core skill format, skips any that cannot be converted, and returns the converted list.

**Call relations**: It is called after skill data is loaded and after a user toggles a skill. `ChatWidget::set_skills_from_response` uses it for initial setup, and `ChatWidget::update_skill_enabled` uses it after changes.

*Call graph*: called by 2 (set_skills_from_response, update_skill_enabled); 1 external calls (iter).


##### `protocol_skill_to_core`  (lines 209–255)

```
fn protocol_skill_to_core(skill: &ProtocolSkillMetadata) -> Option<SkillMetadata>
```

**Purpose**: This translates a skill record from the app-server format into the core skill format used inside the client. It is a bridge between two parts of the system that describe the same idea with different data types.

**Data flow**: It receives one server skill record. It converts the skill scope, copies names and descriptions, converts optional interface details, converts tool dependencies, fills in client-only fields such as policy and plugin ID as absent, and returns a core skill record. If the scope conversion fails, it logs a warning and returns nothing.

**Call relations**: Several flows need this translation before skills can be displayed or used for mentions. It is used by `ChatWidget::open_manage_skills_popup` and by `enabled_skills_for_mentions`.

*Call graph*: 1 external calls (to_value).


##### `collect_tool_mentions`  (lines 257–268)

```
fn collect_tool_mentions(
    text: &str,
    mention_paths: &HashMap<String, String>,
) -> ToolMentions
```

**Purpose**: This extracts tool-like mentions from user text and connects them to known paths when the caller has that information. It turns raw typing into structured mention data.

**Data flow**: It receives the text the user typed and a map from mention names to paths. It first scans the text for mention names. Then, for any extracted name that appears in the provided path map, it records the matching path. It returns a `ToolMentions` object containing names and linked paths.

**Call relations**: This is the public helper for mention collection in this file. It calls `extract_tool_mentions_from_text` for the scan, then enriches the result with caller-provided path bindings. The tests use it before checking app mention matching.

*Call graph*: calls 1 internal fn (extract_tool_mentions_from_text); called by 2 (find_app_mentions_requires_accessible_enabled_apps_for_bound_paths, find_app_mentions_requires_accessible_enabled_apps_for_slugs).


##### `find_skill_mentions_with_tool_mentions`  (lines 270–308)

```
fn find_skill_mentions_with_tool_mentions(
    mentions: &ToolMentions,
    skills: &[SkillMetadata],
) -> Vec<SkillMetadata>
```

**Purpose**: This matches extracted mentions against known skills. It supports both exact path-based mentions and plain name-based mentions.

**Data flow**: It receives parsed mentions and a list of available core skills. First it looks for linked mention paths that point to skill files, normalizes those paths, and matches skills by path. Then it looks for remaining skills whose names were mentioned directly. It avoids returning the same skill twice and returns the matched skills.

**Call relations**: This function sits after mention extraction. `collect_tool_mentions` produces the mention data, and this function turns that data into actual skill records the rest of the system can use.

*Call graph*: 2 external calls (new, new).


##### `find_app_mentions`  (lines 310–346)

```
fn find_app_mentions(
    mentions: &ToolMentions,
    apps: &[AppInfo],
    skill_names_lower: &HashSet<String>,
) -> Vec<AppInfo>
```

**Purpose**: This finds app mentions in the user’s text. It only returns apps that are enabled and accessible, so the assistant does not try to use unavailable apps.

**Data flow**: It receives parsed mentions, a list of apps, and lower-case skill names that could conflict with app slugs. It first accepts explicit linked paths like `app://...`. Then it checks plain mention names against each app’s generated mention slug, but only when the slug uniquely identifies one app and does not collide with a skill name. It returns the matching app records.

**Call relations**: This function uses `app_id_from_path` for explicit app links and `is_app_mentionable` to filter out apps the user cannot use. The tests in this file verify that inaccessible or disabled apps are not returned.

*Call graph*: calls 2 internal fn (connector_mention_slug, app_id_from_path); 3 external calls (new, new, iter).


##### `is_app_mentionable`  (lines 348–350)

```
fn is_app_mentionable(app: &AppInfo) -> bool
```

**Purpose**: This answers a simple yes-or-no question: can this app be mentioned and used right now? An app must be both accessible and enabled.

**Data flow**: It receives an app record, reads its `is_accessible` and `is_enabled` flags, and returns true only if both are true. It does not change anything.

**Call relations**: It is used by `find_app_mentions` whenever that function considers app candidates. This keeps the availability rule in one small, easy-to-read place.


##### `extract_tool_mentions_from_text`  (lines 357–359)

```
fn extract_tool_mentions_from_text(text: &str) -> ToolMentions
```

**Purpose**: This scans user text for tool mentions using the standard mention symbol. It is the normal entry point for raw mention extraction.

**Data flow**: It receives plain text. It passes that text and the configured tool mention symbol to the lower-level scanner, then returns the extracted mention names and linked paths.

**Call relations**: It is called by `collect_tool_mentions`. The actual scanning rules live in `extract_tool_mentions_from_text_with_sigil`, which this function calls with the standard symbol.

*Call graph*: calls 1 internal fn (extract_tool_mentions_from_text_with_sigil); called by 1 (collect_tool_mentions).


##### `extract_tool_mentions_from_text_with_sigil`  (lines 361–418)

```
fn extract_tool_mentions_from_text_with_sigil(text: &str, sigil: char) -> ToolMentions
```

**Purpose**: This is the detailed scanner that finds mention names in text. It understands both simple mentions like `$name` and linked mentions like `[$name](some/path)`.

**Data flow**: It receives text and the mention symbol to look for. It walks through the text byte by byte, collecting names made of letters, numbers, underscores, and hyphens. For linked mentions, it also records the path. It skips common environment variables such as `$PATH`, and for linked skill paths it records the name as a mention. It returns a `ToolMentions` object.

**Call relations**: This function is called by `extract_tool_mentions_from_text`. It calls `parse_linked_tool_mention` when it sees a possible linked form, and uses small helper checks such as `is_common_env_var`, `is_mention_name_char`, and `is_skill_path` while scanning.

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

**Purpose**: This tries to read one linked mention from a specific place in the text. A linked mention looks like a label plus a path, similar to a Markdown link.

**Data flow**: It receives the full text, its bytes, a starting position, and the mention symbol. It checks for the exact pattern `[symbol name](path)`, verifies the name characters, trims the path, and rejects empty paths. If the pattern is valid, it returns the name, path, and the position after the linked mention; otherwise it returns nothing.

**Call relations**: The main scanner, `extract_tool_mentions_from_text_with_sigil`, calls this whenever it sees `[` and wants to know whether a linked mention starts there. This helper keeps that special parsing separate from the simpler `$name` scan.

*Call graph*: calls 1 internal fn (is_mention_name_char); called by 1 (extract_tool_mentions_from_text_with_sigil).


##### `is_common_env_var`  (lines 477–493)

```
fn is_common_env_var(name: &str) -> bool
```

**Purpose**: This prevents ordinary shell environment variables from being mistaken for tool or skill mentions. For example, `$PATH` should usually mean the system path, not a skill named PATH.

**Data flow**: It receives a name, converts it to uppercase, and checks it against a fixed list of common environment variable names. It returns true for those common names and false otherwise.

**Call relations**: It is used by `extract_tool_mentions_from_text_with_sigil` after a possible mention name is found. This keeps mention detection from being too eager in command-like text.

*Call graph*: called by 1 (extract_tool_mentions_from_text_with_sigil); 1 external calls (matches!).


##### `is_mention_name_char`  (lines 495–497)

```
fn is_mention_name_char(byte: u8) -> bool
```

**Purpose**: This defines which characters are allowed inside a mention name. Allowed names can contain letters, numbers, underscores, and hyphens.

**Data flow**: It receives one byte from the text and returns true if that byte is an allowed mention-name character. It does not inspect the whole string or change anything.

**Call relations**: Both `extract_tool_mentions_from_text_with_sigil` and `parse_linked_tool_mention` use this helper while reading mention names. It gives both simple and linked mentions the same naming rules.

*Call graph*: called by 2 (extract_tool_mentions_from_text_with_sigil, parse_linked_tool_mention); 1 external calls (matches!).


##### `is_skill_path`  (lines 499–501)

```
fn is_skill_path(path: &str) -> bool
```

**Purpose**: This decides whether a linked path should be treated as a skill path rather than an app, MCP server, or plugin path. MCP is an external tool connection protocol, and those paths are intentionally excluded here.

**Data flow**: It receives a path string and checks its prefix. If the path starts with `app://`, `mcp://`, or `plugin://`, it returns false; otherwise it returns true.

**Call relations**: It is used while extracting linked mentions and while matching skill mentions. It helps keep different mention types from being mixed together.

*Call graph*: called by 1 (extract_tool_mentions_from_text_with_sigil).


##### `normalize_skill_path`  (lines 503–505)

```
fn normalize_skill_path(path: &str) -> &str
```

**Purpose**: This removes the optional `skill://` prefix from a skill path. It lets prefixed and unprefixed forms compare as the same path.

**Data flow**: It receives a path string. If the string starts with `skill://`, it returns the part after that prefix; otherwise it returns the original string unchanged.

**Call relations**: It is used by `find_skill_mentions_with_tool_mentions` when comparing linked mention paths with known skill file paths. This makes matching more forgiving.


##### `app_id_from_path`  (lines 507–510)

```
fn app_id_from_path(path: &str) -> Option<&str>
```

**Purpose**: This extracts an app ID from a linked app path such as `app://google_drive`. It rejects empty app IDs.

**Data flow**: It receives a path string. If the path starts with `app://` and has non-empty text after that prefix, it returns that text as the app ID. Otherwise it returns nothing.

**Call relations**: It is called by `find_app_mentions` when processing explicitly linked app mentions. The extracted ID is then used to select the matching app from the app list.

*Call graph*: called by 1 (find_app_mentions).


##### `tests::app`  (lines 517–533)

```
fn app(id: &str, name: &str) -> AppInfo
```

**Purpose**: This test helper creates a simple enabled and accessible app record. It keeps the tests short and focused on mention behavior instead of repeated setup details.

**Data flow**: It receives an app ID and name. It builds an `AppInfo` record with those values, most optional fields empty, and both availability flags set to true. It returns the app record.

**Call relations**: The tests call this helper to create base app objects, sometimes overriding one field such as `is_accessible` or `is_enabled` to check filtering behavior.

*Call graph*: 1 external calls (new).


##### `tests::find_app_mentions_requires_accessible_enabled_apps_for_slugs`  (lines 536–554)

```
fn find_app_mentions_requires_accessible_enabled_apps_for_slugs()
```

**Purpose**: This test proves that plain app-name mentions only select apps that are both accessible and enabled. It protects against accidentally offering apps the user cannot use.

**Data flow**: It builds three apps: one usable, one inaccessible, and one disabled. It extracts mentions from text containing all three app slugs, runs `find_app_mentions`, and checks that only the usable app is returned.

**Call relations**: This test exercises the slug-based branch of `find_app_mentions`. It uses `collect_tool_mentions` to parse the typed text before matching apps.

*Call graph*: calls 1 internal fn (collect_tool_mentions); 3 external calls (new, assert_eq!, vec!).


##### `tests::find_app_mentions_requires_accessible_enabled_apps_for_bound_paths`  (lines 557–580)

```
fn find_app_mentions_requires_accessible_enabled_apps_for_bound_paths()
```

**Purpose**: This test proves that even explicit linked app paths must point to apps that are accessible and enabled. A direct path is not allowed to bypass availability rules.

**Data flow**: It builds three apps and a mention-path map linking all three names to `app://...` paths. It extracts mentions from text, attaches the paths, runs `find_app_mentions`, and checks that only the usable app is returned.

**Call relations**: This test exercises the explicit-path branch of `find_app_mentions`. It confirms that `app_id_from_path` can identify linked app IDs, but `is_app_mentionable` still filters the final result.

*Call graph*: calls 1 internal fn (collect_tool_mentions); 3 external calls (from, assert_eq!, vec!).


### `tui/src/chatwidget/ide_context.rs`

`orchestration` · `chat command handling and message send`

This file is the bridge between the chat widget and the user’s IDE, meaning their code editor or development environment. The feature is meant to help the assistant answer with more awareness of what the user is currently doing, such as their selected text or open tabs. Without this file, the chat UI would not know how to respond to `/ide`, and outgoing messages would not automatically include fresh editor context.

It keeps a small piece of state, `IdeContextState`, with two facts: whether IDE context is turned on, and whether the user has already been warned that fetching context failed. That warning flag matters because the app should not nag the user on every message if the IDE connection is unavailable.

The `ChatWidget` methods do the visible work. They parse `/ide`, `/ide on`, `/ide off`, and `/ide status`; update the bottom-pane status indicator; and show friendly messages explaining what happened. When the user sends a message, `maybe_apply_ide_context` checks whether the feature is enabled. If it is, it asks the shared IDE-context code to fetch the latest context from the current working directory, then folds that context into the outgoing user input. If fetching fails, the message still goes out, but the user is told that IDE context was skipped.

#### Function details

##### `IdeContextState::is_enabled`  (lines 14–16)

```
fn is_enabled(&self) -> bool
```

**Purpose**: This reports whether IDE context is currently turned on. Other parts of the chat widget use it before deciding whether to fetch editor information or show the feature as active.

**Data flow**: It reads the stored `enabled` flag from `IdeContextState` and returns that true-or-false value. It does not change anything.

**Call relations**: This is the small gatekeeper used by the chat widget’s IDE-related flow. Command handling, status messages, prompt injection, and the bottom-pane indicator all rely on this answer to decide what should happen next.


##### `IdeContextState::enable`  (lines 18–21)

```
fn enable(&mut self)
```

**Purpose**: This turns IDE context on. It also clears the previous fetch-warning memory so that, after enabling, the user can be warned once if the IDE context cannot be fetched.

**Data flow**: It takes the current state, sets `enabled` to true, and resets `prompt_fetch_warned` to false. It returns nothing, but the state is changed for later chat actions.

**Call relations**: This is used when the chat widget accepts `/ide` as a toggle or `/ide on` as an explicit request. After it runs, the surrounding chat code usually checks whether IDE context can actually be reached and then updates the UI.


##### `IdeContextState::disable`  (lines 23–26)

```
fn disable(&mut self)
```

**Purpose**: This turns IDE context off. It also clears the warning flag because skipped-context warnings no longer matter while the feature is disabled.

**Data flow**: It takes the current state, sets `enabled` to false, and resets `prompt_fetch_warned` to false. It returns nothing, but future sends will no longer try to include IDE context.

**Call relations**: This is used when the user runs `/ide off`, toggles the feature off, or when enabling fails during a status check. The chat widget then updates the status indicator and tells the user IDE context is off or could not be enabled.


##### `IdeContextState::mark_available`  (lines 28–30)

```
fn mark_available(&mut self)
```

**Purpose**: This records that IDE context was successfully reached. Its main job is to clear the one-time warning flag after a successful fetch.

**Data flow**: It changes `prompt_fetch_warned` back to false and leaves the enabled/disabled setting alone. Nothing is returned.

**Call relations**: This is called after the chat widget successfully fetches IDE context, either while preparing a message or while checking status. It makes future failures eligible to show a warning again, because the connection had recovered.


##### `ChatWidget::handle_ide_command`  (lines 34–43)

```
fn handle_ide_command(&mut self)
```

**Purpose**: This implements plain `/ide` as a toggle. If IDE context is on, it turns it off; if it is off, it tries to turn it on and report the result.

**Data flow**: It reads the current IDE-context state. If enabled, it disables the state, updates the bottom-pane indicator, and adds an informational chat message saying the feature is off. If disabled, it enables the state and asks `add_ide_context_status_message` to verify and explain the new status.

**Call relations**: This is the simple toggle path used by `ChatWidget::handle_ide_command_args` when the user enters `/ide` with no extra words. It hands status reporting to `add_ide_context_status_message` when turning on, and uses `sync_ide_context_status_indicator` directly when turning off.

*Call graph*: calls 2 internal fn (add_ide_context_status_message, sync_ide_context_status_indicator); called by 1 (handle_ide_command_args).


##### `ChatWidget::handle_ide_command_args`  (lines 45–64)

```
fn handle_ide_command_args(&mut self, args: &str)
```

**Purpose**: This reads the words after `/ide` and turns them into actions. It supports no argument, `on`, `off`, and `status`, and shows a usage error for anything else.

**Data flow**: It receives the raw argument text, lowercases it, and compares it to the supported commands. Depending on the match, it toggles the feature, enables it, disables it, reports status, or adds an error message. The result is visible UI feedback and an updated IDE-context state when appropriate.

**Call relations**: This is the command dispatcher for the `/ide` family. For the empty case it delegates to `ChatWidget::handle_ide_command`; for `on` and `status` it relies on `add_ide_context_status_message`; for `off` it updates the state and calls `sync_ide_context_status_indicator` so the UI matches the new setting.

*Call graph*: calls 3 internal fn (add_ide_context_status_message, handle_ide_command, sync_ide_context_status_indicator).


##### `ChatWidget::maybe_apply_ide_context`  (lines 67–89)

```
fn maybe_apply_ide_context(&mut self, items: &mut Vec<UserInput>)
```

**Purpose**: This is called before sending a user message, and it adds fresh IDE context to that message if the feature is enabled. If context cannot be fetched, it lets the message continue without it and warns the user only once until the connection succeeds again.

**Data flow**: It receives the outgoing list of `UserInput` items. First it checks whether IDE context is enabled; if not, it leaves the list unchanged. If enabled, it asks `fetch_ide_context` for current editor information using the configured working directory. On success, it clears the warning flag, refreshes the status indicator, and calls `apply_ide_context_to_user_input` to insert the editor context into the outgoing input. On failure, it refreshes the indicator and may add an informational message with a hint, while leaving the outgoing input without IDE context.

**Call relations**: This function sits in the send-message path rather than the command path. It depends on the shared IDE-context module to fetch and apply the context, and it calls `sync_ide_context_status_indicator` so the visible UI stays consistent with the feature state.

*Call graph*: calls 1 internal fn (sync_ide_context_status_indicator); 2 external calls (apply_ide_context_to_user_input, fetch_ide_context).


##### `ChatWidget::add_ide_context_status_message`  (lines 91–126)

```
fn add_ide_context_status_message(&mut self)
```

**Purpose**: This checks the current IDE-context situation and adds a user-facing status message. It is used after enabling the feature or when the user asks for `/ide status`.

**Data flow**: It first checks whether IDE context is enabled. If not, it updates the indicator and says the feature is off. If enabled, it tries to fetch IDE context for the configured working directory. On success, it marks the context as available, updates the indicator, and tells the user the feature is on, with a more specific hint if prompt-worthy context such as selection or tabs is present. On failure, it disables IDE context, updates the indicator, and explains why it could not be enabled.

**Call relations**: This is the status-and-verification step used by `ChatWidget::handle_ide_command` and `ChatWidget::handle_ide_command_args`. It calls the shared IDE-context fetcher to prove the connection works, uses `has_prompt_context` to decide how much context is available, and then calls `sync_ide_context_status_indicator` to keep the bottom pane in step with the state.

*Call graph*: calls 1 internal fn (sync_ide_context_status_indicator); called by 2 (handle_ide_command, handle_ide_command_args); 2 external calls (fetch_ide_context, has_prompt_context).


##### `ChatWidget::sync_ide_context_status_indicator`  (lines 128–131)

```
fn sync_ide_context_status_indicator(&mut self)
```

**Purpose**: This updates the bottom-pane UI so it shows whether IDE context is active. It keeps the small visual indicator in sync with the stored state.

**Data flow**: It reads whether IDE context is enabled, then passes that true-or-false value to the bottom pane with `set_ide_context_active`. It returns nothing, but the UI state changes.

**Call relations**: This is the shared UI-sync helper used after command changes, status checks, and send-time fetch attempts. The rest of the file changes or checks IDE-context state, then calls this function so the visible indicator does not drift out of date.

*Call graph*: called by 4 (add_ide_context_status_message, handle_ide_command, handle_ide_command_args, maybe_apply_ide_context).


### `tui/src/chatwidget/goal_menu.rs`

`domain_logic` · `user command handling`

A “goal” here is the task the assistant is meant to keep working toward in a chat thread. This file is the chat widget’s small goal-control panel: it shows a readable summary for `/goal`, opens an edit prompt for changing the goal text, asks whether to resume a paused goal, and clears the visible goal state when the active thread’s goal is removed.

The file mostly translates between stored goal information and things a person can see or choose in the terminal. For example, `goal_summary_lines` turns fields like status, objective, time used, tokens used, and optional token budget into formatted lines. It also chooses the right command hint, so a paused goal suggests `/goal resume`, while an active goal suggests `/goal pause`.

Editing works by showing a custom prompt at the bottom of the chat. When the user presses Enter, the prompt sends an application event with a new goal draft. That event is how the rest of the program learns that the goal should be updated. Resuming a paused goal works similarly, but through a selection menu with “Resume goal” and “Leave paused.”

One important detail is that editing a completed or budget-limited goal makes it active again. That avoids saving an edited goal that still looks finished or blocked by its old budget state.

#### Function details

##### `ChatWidget::show_goal_summary`  (lines 9–11)

```
fn show_goal_summary(&mut self, goal: AppThreadGoal)
```

**Purpose**: Shows a plain goal summary in the chat history. This is what the user sees after asking for the current goal with the bare `/goal` command.

**Data flow**: It receives an `AppThreadGoal`, which contains the goal’s objective, status, time used, token usage, and optional budget. It passes that goal to `goal_summary_lines`, then appends the returned display lines to the chat history. The visible result is a compact goal report in the conversation area.

**Call relations**: This is the entry point in this file for displaying goal information. It relies on `goal_summary_lines` to do the wording and formatting, then uses the chat widget’s normal history display path to show the result.

*Call graph*: calls 1 internal fn (goal_summary_lines).


##### `ChatWidget::show_goal_edit_prompt`  (lines 13–37)

```
fn show_goal_edit_prompt(&mut self, thread_id: ThreadId, goal: AppThreadGoal)
```

**Purpose**: Opens a bottom-panel prompt where the user can rewrite the current goal objective. When the user submits the new text, it asks the wider app to update the stored goal.

**Data flow**: It receives the thread id and the existing goal. It keeps the old token budget, chooses the status the edited goal should have, and pre-fills the prompt with the current objective. When the user enters a new objective, the prompt sends an `AppEvent::SetThreadGoalDraft` containing the new text and the preserved settings.

**Call relations**: This function is used when the chat UI needs to edit an existing goal. It calls `edited_goal_status` to decide whether the old status should be kept or reset to active, then builds a `CustomPromptView` and hands it to the bottom pane for display.

*Call graph*: calls 2 internal fn (new, edited_goal_status); 1 external calls (new).


##### `ChatWidget::show_resume_paused_goal_prompt`  (lines 39–72)

```
fn show_resume_paused_goal_prompt(
        &mut self,
        thread_id: ThreadId,
        objective: String,
    )
```

**Purpose**: Shows a small choice menu asking whether to resume a paused goal. It gives the user a safe confirmation step instead of immediately changing the goal state.

**Data flow**: It receives the thread id and the goal objective. It builds two menu items: one sends an event that marks the goal active, and the other simply leaves the goal paused. The output is a selection pop-up shown in the chat interface.

**Call relations**: This function fits into the flow for `/goal resume` or similar resume actions. It prepares the menu and passes it to the chat widget’s selection-view machinery; if the user chooses “Resume goal,” the stored goal status is changed through an application event.

*Call graph*: 3 external calls (default, format!, vec!).


##### `ChatWidget::on_thread_goal_cleared`  (lines 74–82)

```
fn on_thread_goal_cleared(&mut self, thread_id: &str)
```

**Purpose**: Updates the chat widget after a goal has been cleared from a thread. It prevents the UI from showing stale goal status for the currently open thread.

**Data flow**: It receives the id of the thread whose goal was cleared. If that id matches the chat widget’s active thread, it removes the widget’s current goal status and refreshes the collaboration-mode indicator. If the cleared goal belongs to another thread, it leaves this widget unchanged.

**Call relations**: This function is called after the app reports that a thread goal was removed. It only acts when the event belongs to the thread currently displayed, then refreshes the visible status indicator so the chat screen matches reality.


##### `goal_summary_lines`  (lines 85–120)

```
fn goal_summary_lines(goal: &AppThreadGoal) -> Vec<Line<'static>>
```

**Purpose**: Builds the formatted text lines used for the goal summary. It turns raw goal fields into labels a person can quickly read in the terminal.

**Data flow**: It receives a reference to an `AppThreadGoal`. It creates lines for the title, status, objective, elapsed time, tokens used, and token budget if one exists. It then adds a blank line and a command hint that depends on the goal’s status. The result is a list of display lines ready to be added to chat history.

**Call relations**: `ChatWidget::show_goal_summary` calls this helper when it needs the actual text for the `/goal` summary. Inside the helper, goal values are converted into compact display strings, including formatted time and token counts, before being returned to the chat widget.

*Call graph*: called by 1 (show_goal_summary); 3 external calls (default, from, vec!).


##### `goal_status_label`  (lines 122–131)

```
fn goal_status_label(status: AppThreadGoalStatus) -> &'static str
```

**Purpose**: Converts an internal goal status into a short lowercase label for people to read. For example, it turns the program’s `BudgetLimited` status into “limited by budget.”

**Data flow**: It receives an `AppThreadGoalStatus` value. It matches that value against the known goal states and returns the corresponding display text. It does not change any state.

**Call relations**: This helper supports the summary-building path by keeping status wording in one clear place. When goal text is prepared for display, this function supplies the human-friendly status label.


##### `edited_goal_status`  (lines 133–143)

```
fn edited_goal_status(status: AppThreadGoalStatus) -> AppThreadGoalStatus
```

**Purpose**: Decides what status an existing goal should have after the user edits it. This keeps sensible states: paused or blocked goals stay that way, but completed or budget-limited goals become active again after their objective changes.

**Data flow**: It receives the goal’s current status. It returns the same status for active, paused, blocked, and usage-limited goals. It returns active for completed or budget-limited goals, because editing those goals means they should be ready to run again.

**Call relations**: `ChatWidget::show_goal_edit_prompt` calls this before creating the edit prompt. The chosen status is later included in the application event that updates the stored goal, so this small decision affects how the rest of the app treats the edited goal.

*Call graph*: called by 1 (show_goal_edit_prompt).


### `tui/src/chatwidget/hooks.rs`

`orchestration` · `user action and async result handling`

This file is a small bridge between the chat interface, the background app event system, and the hooks browser shown in the bottom pane. When the user asks to see hooks, the chat widget does not load them directly. Instead, it sends an app event saying, in effect, “please fetch the hooks for the current working folder.” That keeps the interface responsive while another part of the app does the work.

When the results come back, the file first checks that they still belong to the folder the user is currently in. This matters because the user may have changed directories while the request was running. Without this check, the app could show hooks for the wrong project, like receiving mail for an old address after you have moved.

If loading succeeds, the response is converted into the single hooks-list entry the browser needs, then the bottom pane is switched to a HooksBrowserView. If loading fails, the chat widget shows a plain error message instead. After opening the browser, it asks the terminal UI to redraw so the new pane becomes visible.

#### Function details

##### `ChatWidget::add_hooks_output`  (lines 11–15)

```
fn add_hooks_output(&mut self)
```

**Purpose**: Starts the process of showing hooks by asking the rest of the app to fetch the hooks list for the chat widget's current folder. It is used when the UI needs hook information but should not block while loading it.

**Data flow**: It reads the current working directory from the chat widget's configuration, copies it into a path value, and sends an AppEvent::FetchHooksList message through the app event channel. Nothing is returned directly; the visible result comes later when the fetch finishes and another callback receives the answer.

**Call relations**: This is the first step in the hooks-view flow. It hands the request to the app event system, which is responsible for doing the actual fetch and eventually causing ChatWidget::on_hooks_loaded to run with either the loaded data or an error.


##### `ChatWidget::on_hooks_loaded`  (lines 17–32)

```
fn on_hooks_loaded(
        &mut self,
        cwd: PathBuf,
        result: Result<HooksListResponse, String>,
    )
```

**Purpose**: Receives the result of a hooks-list fetch and decides whether to show it or report an error. It also protects the UI from showing stale hook data for a folder that is no longer current.

**Data flow**: It receives the folder path that was used for the fetch and a result that is either a HooksListResponse or an error string. First it compares that folder with the chat widget's current folder; if they differ, it stops and changes nothing. If the result is successful, it reshapes the response into the entry needed by the hooks browser and opens that browser. If the result is an error, it adds a failure message to the chat.

**Call relations**: This function is the return point for the earlier fetch request. On success, it calls hooks_list_entry_for_cwd to pick or build the hooks entry for the current folder, then calls ChatWidget::open_hooks_browser to display it. On failure, it stays inside the chat widget and shows an error instead.

*Call graph*: calls 2 internal fn (open_hooks_browser, hooks_list_entry_for_cwd); 2 external calls (as_path, format!).


##### `ChatWidget::open_hooks_browser`  (lines 34–42)

```
fn open_hooks_browser(&mut self, entry: HooksListEntry)
```

**Purpose**: Displays the hooks browser in the bottom pane of the terminal interface. It is the final UI step after hook data has been successfully loaded and prepared.

**Data flow**: It receives a HooksListEntry, builds a HooksBrowserView from that entry, a cloned app event sender, and the bottom pane's list key bindings. It then tells the bottom pane to show this new view and requests a redraw so the screen updates.

**Call relations**: ChatWidget::on_hooks_loaded calls this after it has confirmed the loaded hooks belong to the current folder. This function hands the prepared data into HooksBrowserView::from_entry and gives the resulting view to the bottom pane, which takes over displaying and interacting with the hooks list.

*Call graph*: calls 1 internal fn (from_entry); called by 1 (on_hooks_loaded); 1 external calls (new).


### `tui/src/chatwidget/slash_dispatch.rs`

`orchestration` · `input handling`

This file is the switchboard for slash commands inside `ChatWidget`, the terminal chat interface. The text composer can recognize that the user typed a command, but this file decides what that command actually means for the app. Without it, typing `/model` would not open the model picker, `/diff` would not fetch a git diff, `/goal` would not update a thread goal, and queued slash commands would not be replayed correctly when a session finally starts.

The code first checks whether a command is allowed in the current situation. For example, some commands cannot run during an active task, some are blocked inside side conversations, and `/usage` requires ChatGPT sign-in. Then it either performs the action directly, opens a popup, sends an app event to another part of the program, or submits a user message to the assistant.

Commands with extra text need more care. `/rename my task` means something different from bare `/rename`, and `/goal improve tests` may include pasted text, images, or mentions. The file packages that extra material into a `UserMessage` or a goal draft while preserving the right text ranges.

Queued commands are handled too. If a message was saved before the session was ready, this file later re-parses it and decides whether to run the command or send it as ordinary chat text.

#### Function details

##### `ChatWidget::handle_slash_command_dispatch`  (lines 47–53)

```
fn handle_slash_command_dispatch(&mut self, cmd: SlashCommand)
```

**Purpose**: Runs a slash command that has no inline text after it, then records it for local command recall. This is the safe entry point for a live command because it avoids recording a command before the app has accepted it.

**Data flow**: It receives a parsed `SlashCommand`. It sends that command into the main dispatcher, clears special pending state for `/goal`, and then records the staged slash command in the bottom pane history. The visible result is whatever the command does, plus correct Up-arrow recall afterward.

**Call relations**: This wrapper hands the actual work to `ChatWidget::dispatch_command`. It exists so live command input goes through one place before the bottom pane saves the command for recall.

*Call graph*: calls 1 internal fn (dispatch_command).


##### `ChatWidget::handle_service_tier_command_dispatch`  (lines 55–67)

```
fn handle_service_tier_command_dispatch(&mut self, command: ServiceTierCommand)
```

**Purpose**: Runs a service-tier slash command, such as a command that changes the model speed or service mode. It refuses to do this inside a side conversation, where changing the service tier is not allowed.

**Data flow**: It receives a `ServiceTierCommand`. If the chat is currently in a side conversation, it shows an error, clears pending submission state, records the command history, and stops. Otherwise it toggles the service tier and records the command for recall.

**Call relations**: Queued slash command processing calls this when it recognizes a service-tier command. Unlike built-in commands, it does not go through `dispatch_command`; it has its own small path because service-tier commands are represented separately.

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

**Purpose**: Runs a slash command that was typed with extra text, such as `/rename New title` or `/goal improve coverage`. It also records the original command invocation for local history.

**Data flow**: It receives the command, the raw argument text, and text metadata such as mention ranges. It passes them to the inline-command dispatcher, then records the pending slash command history entry. The output is the command’s effect and a single recall entry, not a duplicate.

**Call relations**: This is the live-input wrapper around `ChatWidget::dispatch_command_with_args`. It keeps history recording outside the lower-level dispatcher so commands with arguments are not saved twice.

*Call graph*: calls 1 internal fn (dispatch_command_with_args).


##### `ChatWidget::apply_plan_slash_command`  (lines 84–102)

```
fn apply_plan_slash_command(&mut self) -> bool
```

**Purpose**: Switches the conversation into plan mode when `/plan` is allowed. Plan mode is a collaboration mode where the assistant is guided to plan before acting.

**Data flow**: It reads whether collaboration modes are enabled and whether the current model catalog can provide a plan-mode mask. If either check fails, it shows an informational message and returns `false`. If both pass, it applies the plan mask and returns `true`.

**Call relations**: `dispatch_command` uses this for bare `/plan`, and `dispatch_prepared_command_with_args` uses it before sending `/plan` text as a user message. It calls `plan_mask` to find the concrete mode setting to apply.

*Call graph*: calls 1 internal fn (plan_mask); called by 2 (dispatch_command, dispatch_prepared_command_with_args).


##### `ChatWidget::request_side_conversation`  (lines 104–115)

```
fn request_side_conversation(
        &mut self,
        parent_thread_id: ThreadId,
        user_message: Option<UserMessage>,
    )
```

**Purpose**: Starts a side conversation linked to the current thread. A side conversation is like opening a smaller side chat while keeping the main thread as its parent.

**Data flow**: It receives the parent thread ID and optionally a user message to seed the side conversation. It updates the side-conversation label to show that startup is in progress, asks the UI to redraw, and sends a `StartSide` event to the app.

**Call relations**: `request_empty_side_conversation` calls it for bare `/side` or `/btw`. `dispatch_prepared_command_with_args` calls it when those commands include an initial message.

*Call graph*: called by 2 (dispatch_prepared_command_with_args, request_empty_side_conversation).


##### `ChatWidget::request_empty_side_conversation`  (lines 117–127)

```
fn request_empty_side_conversation(&mut self, cmd: SlashCommand)
```

**Purpose**: Starts a side conversation without an initial user message. It also gives a clear error if the main session has not started yet.

**Data flow**: It receives the slash command that requested the side chat. It checks whether there is a current thread ID. If there is none, it shows an error saying the command cannot be used before the session starts. If there is one, it asks `request_side_conversation` to start the side chat with no message.

**Call relations**: `dispatch_command` calls this for bare `/side` and `/btw`. It is a small guard around `request_side_conversation` that makes the missing-thread case user-friendly.

*Call graph*: calls 2 internal fn (request_side_conversation, command); called by 1 (dispatch_command); 1 external calls (format!).


##### `ChatWidget::emit_raw_output_mode_changed`  (lines 129–132)

```
fn emit_raw_output_mode_changed(&self, enabled: bool)
```

**Purpose**: Tells the rest of the app that raw output mode has been turned on or off. Raw output mode changes how assistant output is displayed, so other parts of the app need to know.

**Data flow**: It receives a boolean value meaning enabled or disabled. It sends an `RawOutputModeChanged` event through the app event channel. It does not return a value; the change is carried by the event.

**Call relations**: `dispatch_command` calls this after toggling raw mode with bare `/raw`. `dispatch_prepared_command_with_args` calls it when `/raw on` or `/raw off` explicitly sets the mode.

*Call graph*: called by 2 (dispatch_command, dispatch_prepared_command_with_args).


##### `ChatWidget::dispatch_command`  (lines 134–525)

```
fn dispatch_command(&mut self, cmd: SlashCommand)
```

**Purpose**: Performs the action for a bare slash command. This is the main command switchboard for commands that do not need extra text.

**Data flow**: It receives a `SlashCommand`. First it checks whether the command is allowed in the current state, such as side conversation, review mode, or active task. Then it matches the command and either updates UI state, opens a popup, sends an app event, submits a message, starts background work, or shows an error. It changes the widget and app state through those actions rather than returning a result.

**Call relations**: Live command handling, queued command handling, and fallback paths from argument dispatch all call this function. It delegates special pieces to helpers such as `apply_plan_slash_command`, `request_empty_side_conversation`, `ensure_usage_command_available`, and `emit_raw_output_mode_changed` when a command needs shared checks or side effects.

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

**Purpose**: Decides how to run a live slash command that came with inline text. It separates commands that truly support arguments from commands that should be treated as bare commands.

**Data flow**: It receives a command, the typed argument text, and text metadata. It checks whether the command is allowed, whether it supports inline arguments, whether a task blocks it, and whether the arguments are empty. It then prepares the argument text and any attached input data, and passes a packaged command to `dispatch_prepared_command_with_args`.

**Call relations**: `handle_slash_command_with_args_dispatch` calls this for live input. It may fall back to `dispatch_command` for unsupported or empty arguments, and it uses `prepare_live_inline_args` when the composer still holds richer submitted input.

*Call graph*: calls 7 internal fn (dispatch_command, dispatch_prepared_command_with_args, ensure_side_command_allowed_outside_review, ensure_slash_command_allowed_in_side_conversation, prepare_live_inline_args, available_during_task, supports_inline_args); called by 1 (handle_slash_command_with_args_dispatch); 3 external calls (new, format!, new_error_event).


##### `ChatWidget::prepare_live_inline_args`  (lines 599–610)

```
fn prepare_live_inline_args(
        &mut self,
        args: String,
        text_elements: Vec<TextElement>,
    ) -> Option<(String, Vec<TextElement>)>
```

**Purpose**: Gets the final argument text and text metadata for a live inline command. This matters when the composer still contains the submitted text and can provide a more accurate prepared submission.

**Data flow**: It receives the current argument string and text elements. If the composer text is already empty, it returns those values unchanged. Otherwise it asks the bottom pane to prepare the inline submission without recording normal history, and returns the prepared text and metadata if that succeeds.

**Call relations**: `dispatch_command_with_args` calls this before packaging most live inline commands. It keeps slash-command history separate from normal message history.

*Call graph*: called by 1 (dispatch_command_with_args).


##### `ChatWidget::clear_live_goal_submission`  (lines 612–617)

```
fn clear_live_goal_submission(&mut self)
```

**Purpose**: Clears the live composer state after a `/goal` command has been consumed. `/goal` has special handling because it can be transformed into a goal draft or queued slash command rather than an ordinary message.

**Data flow**: It empties the composer text, clears pending pasted content, and drains pending submission state. Nothing is returned; the bottom pane is left clean so the same goal input is not submitted again.

**Call relations**: `dispatch_prepared_command_with_args` calls this in several live `/goal` paths after the command has been accepted, rejected, queued, or converted into a goal action.

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

**Purpose**: Builds a `UserMessage` from prepared slash-command arguments. A `UserMessage` is the package of text and attachments that can be sent to the assistant or used to start a side conversation.

**Data flow**: It receives argument text, text metadata, images, remote image URLs, mention bindings, and whether the command came from live input or the queue. For live input, it replaces the supplied attachment lists with the most recent submitted images, URLs, and mentions from the bottom pane. It returns a complete `UserMessage`.

**Call relations**: `dispatch_prepared_command_with_args` uses this for commands like `/plan` with text and `/side` with an initial message. It hides the difference between live input, where attachments must be taken from the composer, and queued input, where attachments are already stored.

*Call graph*: called by 1 (dispatch_prepared_command_with_args).


##### `ChatWidget::dispatch_prepared_command_with_args`  (lines 644–888)

```
fn dispatch_prepared_command_with_args(
        &mut self,
        cmd: SlashCommand,
        prepared: PreparedSlashCommandArgs,
    )
```

**Purpose**: Runs a slash command after its inline arguments and attachments have already been prepared. This is the detailed dispatcher for commands like `/usage weekly`, `/raw on`, `/goal ...`, `/side ...`, and `/rename ...`.

**Data flow**: It receives a command plus a prepared bundle containing argument text, text elements, pasted content, images, URLs, mentions, and whether the input was live or queued. It trims and interprets the arguments, then performs the command-specific action: open a filtered usage view, change raw mode, rename a thread, submit a plan message, set or edit a goal, start a side conversation, and more. For live commands, it drains pending submission state when appropriate.

**Call relations**: `dispatch_command_with_args` calls this for live inline commands, and `submit_queued_slash_prompt` calls it when replaying queued slash input. It uses helpers such as `apply_plan_slash_command`, `prepared_inline_user_message`, `clear_live_goal_submission`, `request_side_conversation`, `ensure_usage_command_available`, and `emit_raw_output_mode_changed`, and falls back to `dispatch_command` when the argument form is not special.

*Call graph*: calls 10 internal fn (apply_plan_slash_command, clear_live_goal_submission, dispatch_command, emit_raw_output_mode_changed, ensure_usage_command_available, prepared_inline_user_message, request_side_conversation, parse, from_config, command); called by 2 (dispatch_command_with_args, submit_queued_slash_prompt); 7 external calls (SetStatus, from, new, review, ResumeSessionByIdOrName, format!, matches!).


##### `ChatWidget::submit_queued_slash_prompt`  (lines 890–996)

```
fn submit_queued_slash_prompt(
        &mut self,
        queued_message: QueuedUserMessage,
    ) -> QueueDrain
```

**Purpose**: Processes a queued user message that might be a slash command. Queued messages happen when input is saved before the session is ready and replayed later.

**Data flow**: It receives a queued message with text, attachments, mentions, and pending pasted content. It tries to parse a slash command name from the text. If the text is not a valid command, it submits it as a normal user message. If the command is recognized, it runs the bare command or prepares and dispatches its arguments. It returns a `QueueDrain` value telling the queue whether to continue draining more items or stop.

**Call relations**: This is the queued-input counterpart to live slash dispatch. It calls `parse_slash_name`, asks `builtin_command_flags` which commands are currently available, uses `find_slash_command` to identify the command, then calls `dispatch_command`, `handle_service_tier_command_dispatch`, or `dispatch_prepared_command_with_args`. After running a command, it asks `queued_command_drain_result` whether more queued input can safely proceed.

*Call graph*: calls 7 internal fn (parse_slash_name, find_slash_command, builtin_command_flags, dispatch_command, dispatch_prepared_command_with_args, handle_service_tier_command_dispatch, queued_command_drain_result); 2 external calls (slash_command_args_elements, format!).


##### `ChatWidget::builtin_command_flags`  (lines 998–1018)

```
fn builtin_command_flags(&self) -> BuiltinCommandFlags
```

**Purpose**: Builds the set of feature flags that decide which built-in slash commands are visible and valid right now. For example, some commands depend on enabled features, authentication, platform, or whether a side conversation is active.

**Data flow**: It reads app configuration, feature flags, authentication state, current mode, and on Windows the sandbox level. It returns a `BuiltinCommandFlags` value describing which slash-command families should be enabled.

**Call relations**: `submit_queued_slash_prompt` uses this before calling command lookup. That way queued command parsing follows the same availability rules as the rest of the UI.

*Call graph*: calls 1 internal fn (level_from_config); called by 1 (submit_queued_slash_prompt); 1 external calls (matches!).


##### `ChatWidget::ensure_usage_command_available`  (lines 1020–1026)

```
fn ensure_usage_command_available(&mut self) -> bool
```

**Purpose**: Checks whether the `/usage` command can be used. The command needs ChatGPT backend authentication, so unsigned-in users get a clear message instead of a broken view.

**Data flow**: It reads whether backend authentication is present. If yes, it returns `true`. If not, it shows an error saying sign-in is required and returns `false`.

**Call relations**: `dispatch_command` calls this before opening the usage menu, and `dispatch_prepared_command_with_args` calls it before showing a specific usage view such as daily or weekly.

*Call graph*: called by 2 (dispatch_command, dispatch_prepared_command_with_args).


##### `ChatWidget::queued_command_drain_result`  (lines 1028–1089)

```
fn queued_command_drain_result(&self, cmd: SlashCommand) -> QueueDrain
```

**Purpose**: Decides whether the queued-input system should keep processing after a queued slash command runs. Some commands are quick and safe to continue past; others open UI or start work, so the queue should pause.

**Data flow**: It receives the command that just ran. It first checks whether a user turn is pending or a modal popup is active; if so, it returns `Stop`. Otherwise it classifies the command and returns either `Continue` for lightweight informational commands or `Stop` for commands that likely need user attention or change session flow.

**Call relations**: `submit_queued_slash_prompt` calls this after running a queued built-in command. Its return value controls whether the queue drains the next saved input or waits.

*Call graph*: called by 1 (submit_queued_slash_prompt).


##### `ChatWidget::slash_command_args_elements`  (lines 1091–1114)

```
fn slash_command_args_elements(
        rest: &str,
        rest_offset: usize,
        text_elements: &[TextElement],
    ) -> Vec<TextElement>
```

**Purpose**: Extracts the text metadata that belongs only to a slash command’s arguments, not to the command name itself. This preserves things like mention ranges after `/goal ` or `/side ` is removed.

**Data flow**: It receives the argument text, the byte offset where those arguments began in the original message, and the original text elements. It filters out elements that ended before the arguments, shifts remaining byte ranges so they are relative to the argument text, clips them to the argument length, and returns the adjusted list.

**Call relations**: `submit_queued_slash_prompt` uses this when replaying a queued slash command with inline arguments. It lets `dispatch_prepared_command_with_args` receive clean argument metadata as if the user had typed only the argument body.

*Call graph*: 3 external calls (new, is_empty, iter).


##### `ChatWidget::ensure_slash_command_allowed_in_side_conversation`  (lines 1116–1126)

```
fn ensure_slash_command_allowed_in_side_conversation(&mut self, cmd: SlashCommand) -> bool
```

**Purpose**: Blocks slash commands that are not allowed inside side conversations. This protects the side chat from commands that only make sense in the main thread.

**Data flow**: It receives a command and checks whether the widget is currently in a side conversation and whether that command is permitted there. If allowed, it returns `true`. If blocked, it shows an error, clears pending submission state, and returns `false`.

**Call relations**: `dispatch_command` and `dispatch_command_with_args` call this before doing any command-specific work. It acts like a gate at the front of both bare and inline command paths.

*Call graph*: calls 1 internal fn (available_in_side_conversation); called by 2 (dispatch_command, dispatch_command_with_args); 1 external calls (format!).


##### `ChatWidget::ensure_side_command_allowed_outside_review`  (lines 1128–1139)

```
fn ensure_side_command_allowed_outside_review(&mut self, cmd: SlashCommand) -> bool
```

**Purpose**: Prevents `/side` and `/btw` from starting side conversations while code review mode is running. That avoids mixing a review workflow with a new side thread at the wrong time.

**Data flow**: It receives a command. If the command is not `/side` or `/btw`, or if review mode is not active, it returns `true`. If side-chat creation is blocked by review mode, it shows an error, clears pending submission state, and returns `false`.

**Call relations**: `dispatch_command` and `dispatch_command_with_args` call this near the start of command processing. It is a focused rule that only applies to side-conversation commands during review.

*Call graph*: calls 1 internal fn (command); called by 2 (dispatch_command, dispatch_command_with_args); 2 external calls (format!, matches!).


### Protocol-driven updates
Maps backend notifications and requests into concrete chat-widget lifecycle, approval, and shutdown UI behavior.

### `tui/src/chatwidget/protocol.rs`

`orchestration` · `main loop event handling`

The chat screen does not create all of its own state. It is constantly told by the app server that something happened: a turn started, a message grew by a few words, a command produced output, a plan changed, an error occurred, and so on. This file is the traffic director for those messages.

The main method, `handle_server_notification`, takes one server notification and routes it to the right ChatWidget behavior. Before it does that, it rejects some updates that belong to a different child thread, so one chat does not accidentally show another chat’s status. It also pays attention to whether the notification is live or being replayed from history. That matters because replayed events should rebuild the screen without re-triggering some live-only behavior, such as shutdown completion or task-start side effects.

Most notification types are translated into more focused UI actions: token usage updates refresh the token display, message deltas append text, command output is added to an execution cell, warning messages become visible warnings, and completed items are rendered into the conversation. Turn completion gets special care because completed, interrupted, and failed turns each need a different cleanup path. In short, this file is like a receptionist for the chat UI: it reads each incoming notice, checks who it belongs to, and sends it to the right desk.

#### Function details

##### `ChatWidget::handle_server_notification`  (lines 4–227)

```
fn handle_server_notification(
        &mut self,
        notification: ServerNotification,
        replay_kind: Option<ReplayKind>,
    )
```

**Purpose**: Receives one notification from the server and turns it into the appropriate chat-screen update. This is the central routing point for live and replayed server events.

**Data flow**: It starts with a server notification and optional replay information. It first checks whether certain child-thread updates belong to this widget; if not, it ignores them. It then notes whether the event is from replay, restores retry-related UI state when appropriate, and matches the notification type. Depending on the kind of event, it updates stored state, calls UI methods to add text or output, records errors, refreshes skills, shows warnings, or delegates more detailed work to helper methods. The result is usually a changed ChatWidget state and a requested visual update rather than a returned value.

**Call relations**: This is the method the rest of the chat event flow calls when a server-side event arrives. For complex cases it hands off to `ChatWidget::handle_turn_completed_notification`, `ChatWidget::handle_item_started_notification`, or `ChatWidget::handle_item_completed_notification` so that turn endings and item lifecycle events stay easier to reason about. It also parses thread IDs when thread names change and logs a warning if the server sends an invalid one.

*Call graph*: calls 4 internal fn (from_string, handle_item_completed_notification, handle_item_started_notification, handle_turn_completed_notification); 2 external calls (matches!, warn!).


##### `ChatWidget::handle_turn_completed_notification`  (lines 229–277)

```
fn handle_turn_completed_notification(
        &mut self,
        notification: TurnCompletedNotification,
        replay_kind: Option<ReplayKind>,
    )
```

**Purpose**: Finishes the UI work for a turn after the server says that turn ended. It separates successful, interrupted, failed, and still-running turns so the chat screen cleans up correctly.

**Data flow**: It receives a completed-turn notification plus replay information. First it clears a short-lived deduplication marker used to avoid showing the same locally typed user message twice. If the turn completed normally, it clears remembered errors and marks the task complete. If it was interrupted, it decides whether the reason was a budget limit or a normal interruption and updates the UI accordingly. If it failed, it either avoids repeating an error already shown earlier or displays the failure now; if no error is attached, it finalizes the turn, redraws, and may send queued input. It does not return data; it changes the widget’s state and visible conversation flow.

**Call relations**: It is called by `ChatWidget::handle_server_notification` when a `TurnCompleted` server notification arrives. It is the specialized cleanup branch for turn endings, so the main notification router does not need to carry all the details for success, interruption, and failure handling.

*Call graph*: called by 1 (handle_server_notification).


##### `ChatWidget::handle_item_started_notification`  (lines 279–323)

```
fn handle_item_started_notification(
        &mut self,
        notification: ItemStartedNotification,
        from_replay: bool,
    )
```

**Purpose**: Responds when the server says a new work item has begun, such as a command, file edit, web search, image generation, tool call, or review mode entry. It creates or updates the right kind of in-progress UI element.

**Data flow**: It receives an item-start notification and a simple flag saying whether this came from replay. It looks at the item type. For command execution it starts a command display; for file changes it converts the changes into a display-friendly form and starts a patch view; for tool calls, web searches, image generation, collaboration activity, and sub-agent activity it calls the matching UI entry point. If the item is entering review mode, it only opens review mode for live events, not replayed history. It produces no return value; it prepares the chat screen to show ongoing work.

**Call relations**: It is called by `ChatWidget::handle_server_notification` when an `ItemStarted` notification arrives. It acts as the small dispatcher for beginnings of individual items, while completed items are sent through `ChatWidget::handle_item_completed_notification`.

*Call graph*: called by 1 (handle_server_notification).


##### `ChatWidget::handle_item_completed_notification`  (lines 325–335)

```
fn handle_item_completed_notification(
        &mut self,
        notification: ItemCompletedNotification,
        replay_kind: Option<ReplayKind>,
    )
```

**Purpose**: Renders a finished conversation item after the server says it is complete. This is how completed messages, tool results, file changes, and similar items become final chat entries.

**Data flow**: It receives an item-completed notification and optional replay information. It takes the completed item and its turn ID, converts the replay information into a render source label — live event or replayed event — and passes everything to the general thread-item renderer. The output is not a returned value; the chat widget’s conversation display is updated.

**Call relations**: It is called by `ChatWidget::handle_server_notification` for `ItemCompleted` events. Its job is deliberately narrow: it hands the finished item to the existing thread-item rendering path and preserves whether the item came from live server activity or from replayed history.

*Call graph*: called by 1 (handle_server_notification).


### `tui/src/chatwidget/protocol_requests.rs`

`orchestration` · `request handling`

The terminal chat widget receives many kinds of messages from the app server. Those messages are written in the server protocol, which is a shared language used between parts of the app. This file translates that shared language into actions the chat screen understands.

Think of it like a front desk clerk. The server sends a form saying, for example, “ask the user before running this command” or “show this guardian review result.” This file reads the form, checks what kind it is, reshapes the data if needed, and sends it to the right part of ChatWidget.

The biggest function, handle_server_request, sorts incoming server requests. Some requests become approval prompts for commands or file changes. Some become permission requests, user-input prompts, or elicitation prompts. If a newer or unsupported request reaches this terminal UI during a live run, it shows a clear stub error instead of silently doing nothing.

The guardian review notification path is more involved. It converts review status, risk level, user authorization, and decision source from app-server types into the internal approval types used by the chat UI. If filesystem paths cannot be converted into local paths, it reports that error to the user and stops.

The file also contains small notification handlers for shutdown, turn diffs, skill-list responses, and deprecation notices.

#### Function details

##### `ChatWidget::handle_server_request`  (lines 9–57)

```
fn handle_server_request(
        &mut self,
        request: ServerRequest,
        replay_kind: Option<ReplayKind>,
    )
```

**Purpose**: Receives one request from the app server and routes it to the right chat-widget flow. This is how server-side events become visible prompts or messages in the terminal UI.

**Data flow**: A ServerRequest comes in, along with optional replay information that says whether this is being replayed rather than happening live. The function reads the request id, looks at the request kind, converts the request data into the widget’s local shape when needed, and calls the matching ChatWidget action. If path conversion for a permissions request fails, it adds an error message. If the request kind is not implemented for the terminal UI and this is not a replay, it adds a stub error message.

**Call relations**: This is the main dispatch point for app-server requests aimed at ChatWidget. It first asks the request for its id, then branches by request type. Successful branches hand off to more focused widget flows such as execution approval, patch approval, permissions, elicitation, or tool user input. Error branches build user-facing messages with formatting so the problem appears in the chat instead of disappearing silently.

*Call graph*: 2 external calls (id, format!).


##### `ChatWidget::handle_skills_list_response`  (lines 59–61)

```
fn handle_skills_list_response(&mut self, response: SkillsListResponse)
```

**Purpose**: Receives the server’s response containing available skills and passes it to the chat widget’s skill-list display flow.

**Data flow**: A SkillsListResponse comes in from the server. The function does not change it; it forwards the response directly to the widget logic that knows how to show or use the skills list. Nothing is returned.

**Call relations**: This function is a small adapter between the server protocol response and the ChatWidget’s internal skill-list behavior. It exists so the protocol-facing code has one clear place to send a skills response.


##### `ChatWidget::on_patch_apply_output_delta`  (lines 63–63)

```
fn on_patch_apply_output_delta(&mut self, _item_id: String, _delta: String)
```

**Purpose**: Currently does nothing when partial output from applying a patch arrives. It is present as a placeholder for a notification type the protocol can send.

**Data flow**: It receives an item id and a text delta, meaning a small new piece of output. Both inputs are intentionally ignored, and the chat widget is left unchanged.

**Call relations**: This is a no-op hook in the protocol notification surface. If patch-apply streaming output is supported later, this is the place where that incoming notification can be connected to visible chat UI updates.


##### `ChatWidget::on_guardian_review_notification`  (lines 65–153)

```
fn on_guardian_review_notification(
        &mut self,
        id: String,
        turn_id: String,
        started_at_ms: i64,
        review: codex_app_server_protocol::GuardianApprovalReview,
```

**Purpose**: Turns a guardian review notification from the app server into a guardian assessment event the chat widget can display. A guardian review is an automated safety or approval check around an action.

**Data flow**: The function receives identifiers, timing information, a review object, optional completion information, and the action that was reviewed. It first tries to convert the action into the local form used by the UI; if that fails, it shows an error and stops. It then separates completion time and decision source, converts review status, risk level, user authorization, and decision source into internal approval types, and builds a GuardianAssessmentEvent. That event is passed into the widget so the review can be shown or updated.

**Call relations**: This function sits between app-server guardian notifications and the chat widget’s guardian-assessment display logic. It relies on conversion for the reviewed action and uses formatted error messages if conversion fails. Once the data is in the UI’s expected shape, it hands the completed assessment event to the widget’s guardian assessment flow.

*Call graph*: 2 external calls (try_into, format!).


##### `ChatWidget::on_shutdown_complete`  (lines 155–157)

```
fn on_shutdown_complete(&mut self)
```

**Purpose**: Tells the terminal UI to exit as soon as the server says shutdown is complete.

**Data flow**: No extra data comes in. The function changes the widget/application state by requesting an immediate exit. It does not return a value.

**Call relations**: This is the final notification hook for shutdown. When the app server confirms that shutdown work is done, this function connects that confirmation to the UI’s exit request.


##### `ChatWidget::on_turn_diff`  (lines 159–162)

```
fn on_turn_diff(&mut self, unified_diff: String)
```

**Purpose**: Receives a diff for the current turn and refreshes the status line. A diff is a text summary of what changed, often in the familiar plus-and-minus format used by version control tools.

**Data flow**: A unified diff string comes in. The function writes it to the debug log for developers and then asks the widget to refresh its status line. The diff is not shown directly here, and no value is returned.

**Call relations**: This notification hook connects turn-diff events to lightweight UI refresh work. It uses debug logging so developers can inspect the diff while keeping the visible user-facing behavior focused on updating the status line.

*Call graph*: 1 external calls (debug!).


##### `ChatWidget::on_deprecation_notice`  (lines 164–167)

```
fn on_deprecation_notice(&mut self, summary: String, details: Option<String>)
```

**Purpose**: Shows a deprecation notice in the chat history and asks the UI to redraw. A deprecation notice warns the user that something is outdated and may be removed or changed later.

**Data flow**: A short summary and optional details come in. The function builds a history cell for the notice, appends it to the chat history, and requests a redraw so the new notice appears on screen. It does not return a value.

**Call relations**: This function connects server-side deprecation warnings to the visible chat timeline. It uses the history-cell helper to create the display item, then hands that item to the chat history and asks the screen to repaint.

*Call graph*: 1 external calls (new_deprecation_notice).


### Selection and action popups
Builds the popup flows for models, reviews, plans, and connector browsing that let users choose follow-up actions.

### `tui/src/chatwidget/connectors.rs`

`orchestration` · `main loop and user interaction`

This file is the chat widget’s small control center for app connectors. A connector is an app integration that can be installed, enabled, disabled, or mentioned in a prompt. The file keeps track of whether the app list has never been loaded, is loading, is ready, or failed. It also remembers partial results, so the UI can show something useful while a fuller list is still arriving.

The flow is like a shop window that refreshes its catalog in the background. When the user opens the apps popup, the widget asks for a refresh, but it can still show the last known list immediately. If the list is not ready yet, it shows a loading popup. When results arrive, it updates the cache, refreshes the popup if it is open, and shares the snapshot with the bottom pane so mentions and search can use it.

The file is careful not to start duplicate fetches. If a refresh is already running and a stronger “force refresh” request comes in, it records that request and runs it after the current one finishes. It also handles failures gently: if a fresh load fails but an older or partial list exists, it keeps showing that instead of leaving the user with nothing.

#### Function details

##### `ChatWidget::refresh_connectors`  (lines 24–26)

```
fn refresh_connectors(&mut self, force_refetch: bool)
```

**Purpose**: Starts a user-visible refresh of the apps list. The caller can ask for a forced refresh, which means the list should be fetched again even if cached data already exists.

**Data flow**: It receives a true-or-false refresh preference, passes that preference into the shared refresh queue, and returns without producing a direct value. Any visible result comes later through app events and cache updates.

**Call relations**: This is a public-facing entry point for code that wants the chat widget to refresh apps. It immediately hands the work to `ChatWidget::queue_connectors_refresh`, which decides whether a fetch should actually be sent.

*Call graph*: calls 1 internal fn (queue_connectors_refresh).


##### `ChatWidget::prefetch_connectors`  (lines 28–30)

```
fn prefetch_connectors(&mut self)
```

**Purpose**: Starts a quiet background load of the apps list before the user explicitly opens the apps popup. This helps the popup feel faster when the user later asks for it.

**Data flow**: It has no input beyond the current widget state. It requests a normal, non-forced refresh and leaves the eventual result to be delivered later through the same connector-loading path.

**Call relations**: This is used when the app wants to warm up the connector cache. It delegates to `ChatWidget::queue_connectors_refresh`, just like the explicit refresh path, but always asks for a non-forced fetch.

*Call graph*: calls 1 internal fn (queue_connectors_refresh).


##### `ChatWidget::queue_connectors_refresh`  (lines 32–37)

```
fn queue_connectors_refresh(&mut self, force_refetch: bool)
```

**Purpose**: Decides whether to send a request to fetch the apps list, and sends that request if the widget is ready for one. It is the shared doorway for all connector refresh attempts.

**Data flow**: It receives whether this should be a forced refresh. It asks `ChatWidget::begin_connectors_refresh` to mark the refresh as started if allowed. If that succeeds, it sends an `AppEvent::FetchConnectorsList` message to the wider application; if not, it does nothing.

**Call relations**: This function is called when prefetching, when the user asks for apps, when a refresh is requested directly, and when a pending forced refresh must run after another fetch finishes. It hands off the actual fetching to the application event system.

*Call graph*: calls 1 internal fn (begin_connectors_refresh); called by 4 (add_connectors_output, on_connectors_loaded, prefetch_connectors, refresh_connectors).


##### `ChatWidget::begin_connectors_refresh`  (lines 39–55)

```
fn begin_connectors_refresh(&mut self, force_refetch: bool) -> bool
```

**Purpose**: Checks whether a connector fetch is allowed right now and updates the widget’s loading flags. This prevents duplicate requests and keeps the cache state honest.

**Data flow**: It reads feature/account state and the connector refresh flags. If apps are disabled, it returns false. If a fetch is already running, it may remember that a forced refresh is pending, then returns false. Otherwise it marks a fetch as in flight, sets the cache to loading when there is no ready list yet, and returns true.

**Call relations**: This is called only by `ChatWidget::queue_connectors_refresh`. It acts as the gatekeeper before an app-list fetch event is sent.

*Call graph*: calls 1 internal fn (connectors_enabled); called by 1 (queue_connectors_refresh); 1 external calls (matches!).


##### `ChatWidget::connectors_enabled`  (lines 57–59)

```
fn connectors_enabled(&self) -> bool
```

**Purpose**: Answers whether apps should be available in this chat session. Apps require both the apps feature flag and a ChatGPT account.

**Data flow**: It reads the current configuration and account flag from the widget. It returns true only when the apps feature is enabled and the user has the needed account.

**Call relations**: This check is used before fetching, before showing the apps UI, and before offering connectors for mentions. It keeps disabled app features from leaking into the rest of the UI.

*Call graph*: called by 3 (add_connectors_output, begin_connectors_refresh, connectors_for_mentions).


##### `ChatWidget::connectors_for_mentions`  (lines 61–74)

```
fn connectors_for_mentions(&self) -> Option<&[AppInfo]>
```

**Purpose**: Provides the current app list for mention suggestions, such as when the user types an app mention trigger. It returns nothing if apps are not available or no usable list has loaded yet.

**Data flow**: It first checks whether connectors are enabled. If they are, it prefers a partial snapshot when one exists, because that may contain early useful results. Otherwise it returns the ready cached connector list, or no list if loading failed or has not completed.

**Call relations**: This function is a read-only supplier for mention-related UI. It relies on `ChatWidget::connectors_enabled` to avoid offering suggestions when the apps feature should not be active.

*Call graph*: calls 1 internal fn (connectors_enabled).


##### `ChatWidget::add_connectors_output`  (lines 76–106)

```
fn add_connectors_output(&mut self)
```

**Purpose**: Responds when the user asks to see apps, such as through `$` or `/apps`. It either shows an app popup, a loading popup, an error, or a friendly disabled/no-apps message.

**Data flow**: It checks whether apps are enabled. If not, it adds an informational chat message. If enabled, it starts or queues a refresh, then looks at the current cache copy. A ready non-empty list opens the apps popup; an empty list adds a “No apps available” message; a failure adds an error to history; a loading or uninitialized state opens the loading popup. It then requests a redraw so the screen updates.

**Call relations**: This is the main user-facing connector action. It calls the refresh queue so the list stays current, then calls either `ChatWidget::open_connectors_popup` or `ChatWidget::open_connectors_loading_popup` depending on what is already known.

*Call graph*: calls 4 internal fn (connectors_enabled, open_connectors_loading_popup, open_connectors_popup, queue_connectors_refresh); 2 external calls (new_error_event, matches!).


##### `ChatWidget::open_connectors_loading_popup`  (lines 108–116)

```
fn open_connectors_loading_popup(&mut self)
```

**Purpose**: Shows the temporary popup that tells the user the app list is still loading. If that same popup is already open, it replaces it instead of opening a duplicate.

**Data flow**: It builds loading-popup settings through `ChatWidget::connectors_loading_popup_params`. It then asks the bottom pane to replace the active apps selection view if possible; if there is no active one to replace, it opens a new selection view.

**Call relations**: This is called by `ChatWidget::add_connectors_output` when the user asks for apps before the list is ready. It hands the finished popup description to the bottom pane, which is responsible for displaying it.

*Call graph*: calls 1 internal fn (connectors_loading_popup_params); called by 1 (add_connectors_output).


##### `ChatWidget::open_connectors_popup`  (lines 118–122)

```
fn open_connectors_popup(&mut self, connectors: &[AppInfo])
```

**Purpose**: Opens the real searchable apps popup for a known list of connectors. This is what the user sees when app data is ready.

**Data flow**: It receives a slice of app connector records. It turns those records into popup settings with `ChatWidget::connectors_popup_params`, then tells the bottom pane to show that selection view.

**Call relations**: This is called by `ChatWidget::add_connectors_output` when the cache already contains a usable app list. The detailed item-building work is delegated to `ChatWidget::connectors_popup_params`.

*Call graph*: calls 1 internal fn (connectors_popup_params); called by 1 (add_connectors_output).


##### `ChatWidget::connectors_loading_popup_params`  (lines 124–140)

```
fn connectors_loading_popup_params(&self) -> SelectionViewParams
```

**Purpose**: Builds the contents of the loading version of the apps popup. It gives the user a clear title and a disabled placeholder row instead of an empty screen.

**Data flow**: It creates a header saying “Apps” and explaining that installed and available apps are loading. It returns a `SelectionViewParams` value with one disabled item that says the list will update when ready.

**Call relations**: This is used by `ChatWidget::open_connectors_loading_popup`. It does not show anything itself; it only prepares the description that the bottom pane uses to draw the popup.

*Call graph*: calls 1 internal fn (new); called by 1 (open_connectors_loading_popup); 4 external calls (new, default, from, vec!).


##### `ChatWidget::connectors_popup_params`  (lines 142–239)

```
fn connectors_popup_params(
        &self,
        connectors: &[AppInfo],
        selected_connector_id: Option<&str>,
    ) -> SelectionViewParams
```

**Purpose**: Turns raw app connector records into a searchable popup the user can interact with. It decides the text, status labels, descriptions, and what happens when the user presses Enter on each app.

**Data flow**: It receives the connector list and, optionally, the connector that should stay selected. It counts installed apps, builds a header, finds the initial selected row, and creates one selection item per connector. Each item gets a display name, search text, short description, and an action: open the app’s install/manage link when available, or insert an informational message when no link exists. It returns a complete `SelectionViewParams` object for the bottom pane.

**Call relations**: This is called when first opening the apps popup and when refreshing an already open popup. It uses the helper functions for connector description and status wording, and it packages user actions as app events for the rest of the application to perform.

*Call graph*: calls 2 internal fn (connector_display_label, new); called by 2 (open_connectors_popup, refresh_connectors_popup_if_open); 11 external calls (new, default, from, connector_brief_description, connector_description, connector_status_label, with_capacity, iter, len, format! (+1 more)).


##### `ChatWidget::refresh_connectors_popup_if_open`  (lines 241–259)

```
fn refresh_connectors_popup_if_open(&mut self, connectors: &[AppInfo])
```

**Purpose**: Updates the apps popup in place when new connector data arrives or an app’s enabled state changes. It tries to keep the same app selected so the UI does not jump around unexpectedly.

**Data flow**: It asks the bottom pane which row is selected in the active apps popup. If the cache has a ready snapshot, it translates that row into a connector id. It then rebuilds popup settings for the new connector list, using that id as the preferred selection, and asks the bottom pane to replace the active popup if it is open.

**Call relations**: This is used after connector loading completes and after a connector’s enabled state changes. It relies on `ChatWidget::connectors_popup_params` to rebuild the popup contents.

*Call graph*: calls 1 internal fn (connectors_popup_params); called by 2 (on_connectors_loaded, update_connector_enabled).


##### `ChatWidget::connector_brief_description`  (lines 261–267)

```
fn connector_brief_description(connector: &AppInfo) -> String
```

**Purpose**: Creates the one-line summary shown for an app in the popup list. It combines the app’s install/enabled status with its trimmed description when one exists.

**Data flow**: It receives one connector record. It gets the status text, then looks for a clean description. If there is a description, it returns text like “Installed · description”; otherwise it returns only the status text.

**Call relations**: This helper is used while building popup rows in `ChatWidget::connectors_popup_params`. It depends on `ChatWidget::connector_status_label` and `ChatWidget::connector_description` for the two pieces of text.

*Call graph*: 3 external calls (connector_description, connector_status_label, format!).


##### `ChatWidget::connector_status_label`  (lines 269–279)

```
fn connector_status_label(connector: &AppInfo) -> &'static str
```

**Purpose**: Chooses the short status phrase for an app connector. This tells the user whether the app is installed, installed but disabled, or available to install.

**Data flow**: It reads the connector’s accessibility and enabled flags. Accessible and enabled becomes “Installed”; accessible but disabled becomes “Installed · Disabled”; not accessible becomes “Can be installed”. It returns that fixed text.

**Call relations**: This helper feeds popup descriptions and selected-row instructions. It is part of the wording layer used by `ChatWidget::connectors_popup_params` and `ChatWidget::connector_brief_description`.


##### `ChatWidget::connector_description`  (lines 281–288)

```
fn connector_description(connector: &AppInfo) -> Option<String>
```

**Purpose**: Extracts a clean app description, if the connector has one. Blank or whitespace-only descriptions are treated as missing.

**Data flow**: It reads the optional description field from a connector. If present, it trims extra surrounding whitespace, rejects it if it becomes empty, and returns a new string containing the cleaned description. If there is no usable description, it returns nothing.

**Call relations**: This helper is used when building popup item text. It keeps the rest of the popup code from having to repeat the same cleanup rules.


##### `ChatWidget::on_connectors_loaded`  (lines 290–350)

```
fn on_connectors_loaded(
        &mut self,
        result: Result<ConnectorsSnapshot, String>,
        is_final: bool,
    )
```

**Purpose**: Receives the result of an app-list fetch and updates the cache, popup, and mention data. It handles both partial and final results, and it protects the user from losing an older usable list when a refresh fails.

**Data flow**: It receives either a successful connector snapshot or an error string, plus a flag saying whether this is the final result. Final results clear the in-flight flag and may trigger a delayed forced refresh afterward. On success, it preserves existing enabled/disabled states where possible, stores partial results separately or final results in the cache, refreshes the popup when appropriate, and shares the snapshot with the bottom pane. On failure, it keeps a ready old snapshot if one exists, falls back to a partial snapshot if possible, or records a failed cache state and clears the bottom pane snapshot if there is no usable data.

**Call relations**: This is called when the wider application finishes fetching connectors. It may call `ChatWidget::refresh_connectors_popup_if_open` so visible UI updates immediately, and it may call `ChatWidget::queue_connectors_refresh` if a forced refresh was requested while another fetch was still running.

*Call graph*: calls 2 internal fn (queue_connectors_refresh, refresh_connectors_popup_if_open); 3 external calls (Failed, Ready, warn!).


##### `ChatWidget::update_connector_enabled`  (lines 352–373)

```
fn update_connector_enabled(&mut self, connector_id: &str, enabled: bool)
```

**Purpose**: Updates the cached enabled/disabled state for one app connector after that state changes elsewhere. This keeps the apps popup and mention data consistent without requiring a full refetch.

**Data flow**: It receives a connector id and the new enabled value. If there is no ready cache, it stops. Otherwise it copies the ready snapshot, finds the matching connector, changes its enabled flag if needed, and stops if nothing changed. When there is a real change, it refreshes any open popup, stores the updated snapshot back in the cache, and shares it with the bottom pane.

**Call relations**: This is used after an app’s enabled state changes. It calls `ChatWidget::refresh_connectors_popup_if_open` so the visible app list reflects the new state right away.

*Call graph*: calls 1 internal fn (refresh_connectors_popup_if_open); 1 external calls (Ready).


### `tui/src/chatwidget/model_popups.rs`

`orchestration` · `user interaction`

This file is the control panel for model choice inside `ChatWidget`, the main chat screen. Without it, the user could not safely switch between quick “auto” models, browse all available models, or choose how much reasoning effort the model should use.

The flow starts with the model picker. It first checks that startup has finished and that the model list is available. Then it splits models into quick “auto” choices and the larger “all models” list. The quick menu is like a short menu at a restaurant: fast, balanced, or thorough. If the user needs more detail, the “All models” item opens a second picker.

The all-models picker sends the user to a reasoning picker when needed. “Reasoning effort” means how much internal problem-solving work the model is asked to spend before answering. Higher effort may give better results, but can use limits faster, so the file adds warnings for expensive choices.

Plan mode adds one important wrinkle. If the user changes reasoning while already in Plan mode, the UI may ask whether the change should affect only Plan mode or become the global default. The file does this by building selection items whose actions send application events, rather than changing everything directly.

#### Function details

##### `ChatWidget::open_model_popup`  (lines 11–31)

```
fn open_model_popup(&mut self)
```

**Purpose**: Starts the model selection flow when the user asks to choose a model. It protects the user from opening the picker before startup is complete or while the model list is being refreshed.

**Data flow**: It reads the session state and asks the model catalog for the available presets. If the session is not ready or the catalog cannot be read, it adds a friendly message to the chat. If the presets are available, it passes them into the next step that builds the actual picker.

**Call relations**: This is the front door for the model popup. After doing readiness checks, it hands the model list to `ChatWidget::open_model_popup_with_presets`, which decides what kind of model menu to show.

*Call graph*: calls 1 internal fn (open_model_popup_with_presets).


##### `ChatWidget::model_menu_header`  (lines 33–43)

```
fn model_menu_header(&self, title: &str, subtitle: &str) -> Box<dyn Renderable>
```

**Purpose**: Creates the reusable header shown at the top of model-related menus. It gives the menu a title, a short explanation, and, when needed, a warning about custom OpenAI server settings.

**Data flow**: It receives title and subtitle text, turns them into styled display lines, asks whether a warning line is needed, and returns a renderable header object for the popup to display.

**Call relations**: Both `ChatWidget::open_model_popup_with_presets` and `ChatWidget::open_all_models_popup` call this when they need a consistent heading. It calls `ChatWidget::model_menu_warning_line` so the warning logic stays in one place.

*Call graph*: calls 2 internal fn (model_menu_warning_line, new); called by 2 (open_all_models_popup, open_model_popup_with_presets); 2 external calls (new, from).


##### `ChatWidget::model_menu_warning_line`  (lines 45–51)

```
fn model_menu_warning_line(&self) -> Option<Line<'static>>
```

**Purpose**: Builds a red warning line when the app is using a custom OpenAI base URL. This matters because model selection may not work correctly against a non-standard server.

**Data flow**: It asks `ChatWidget::custom_openai_base_url` whether there is a meaningful custom URL. If there is one, it formats a warning message and returns it as a display line. If not, it returns nothing.

**Call relations**: This is used only by `ChatWidget::model_menu_header`. It keeps the header simple by hiding the details of when the warning should appear.

*Call graph*: calls 1 internal fn (custom_openai_base_url); called by 1 (model_menu_header); 2 external calls (from, format!).


##### `ChatWidget::custom_openai_base_url`  (lines 53–70)

```
fn custom_openai_base_url(&self) -> Option<String>
```

**Purpose**: Checks whether the current OpenAI provider has been pointed at a non-default server address. It avoids warning users when they are using the normal OpenAI URL or no URL at all.

**Data flow**: It reads the configured model provider. If the provider is not OpenAI, has no base URL, has an empty URL, or matches the default OpenAI URL after trimming trailing slashes, it returns nothing. Otherwise it returns the configured URL text.

**Call relations**: This supports `ChatWidget::model_menu_warning_line`, which turns the result into a visible warning in model menus.

*Call graph*: called by 1 (model_menu_warning_line).


##### `ChatWidget::open_model_popup_with_presets`  (lines 72–155)

```
fn open_model_popup_with_presets(&mut self, presets: Vec<ModelPreset>)
```

**Purpose**: Builds the first model picker from a supplied list of model presets. It favors quick auto choices, while still offering an “All models” route for more specific selection.

**Data flow**: It takes model presets, removes any that should not appear in the picker, finds the current model label, and separates quick auto models from the rest. Auto models become selectable rows with actions that update the model and reasoning effort, or ask a Plan mode scope question first. If there are other models, it adds an “All models” row that opens the full picker.

**Call relations**: `ChatWidget::open_model_popup` calls this after it has successfully loaded presets. This function may call `ChatWidget::open_all_models_popup` directly if there are no quick auto models, and it uses `ChatWidget::model_menu_header` to make the popup heading.

*Call graph*: calls 2 internal fn (model_menu_header, open_all_models_popup); called by 1 (open_model_popup); 3 external calls (default, format!, vec!).


##### `ChatWidget::is_auto_model`  (lines 157–159)

```
fn is_auto_model(model: &str) -> bool
```

**Purpose**: Identifies whether a model name belongs to the quick auto-model family. These are the models shown in the short first-level picker.

**Data flow**: It receives a model name as text and returns true if the name starts with the expected auto-model prefix. It does not change any state.

**Call relations**: It is used as part of the quick-picker decision inside `ChatWidget::open_model_popup_with_presets`, helping split models into quick choices and the larger browse list.


##### `ChatWidget::auto_model_order`  (lines 161–168)

```
fn auto_model_order(model: &str) -> usize
```

**Purpose**: Defines the display order for quick auto models so the menu appears in a sensible sequence: fast, balanced, then thorough.

**Data flow**: It receives a model name and returns a sorting number. Known auto models get fixed positions, while unknown ones go after the known choices.

**Call relations**: It supports `ChatWidget::open_model_popup_with_presets` when that function sorts quick auto choices before showing them.


##### `ChatWidget::open_all_models_popup`  (lines 170–214)

```
fn open_all_models_popup(&mut self, presets: Vec<ModelPreset>)
```

**Purpose**: Shows the full model list when the quick picker is not enough. Each model row leads to a reasoning-effort choice, unless the model has only one possible effort.

**Data flow**: It receives model presets. If the list is empty, it adds a message saying no additional models are available. Otherwise it turns each preset into a selectable row, marks the current and default models, and attaches an action that opens the reasoning popup for that model.

**Call relations**: `ChatWidget::open_model_popup_with_presets` calls this when the user chooses “All models” or when there are no quick auto choices. It uses `ChatWidget::model_menu_header` for the shared heading style.

*Call graph*: calls 1 internal fn (model_menu_header); called by 1 (open_model_popup_with_presets); 3 external calls (default, new, vec!).


##### `ChatWidget::model_selection_actions`  (lines 216–237)

```
fn model_selection_actions(
        model_for_action: String,
        effort_for_action: Option<ReasoningEffortConfig>,
        should_prompt_plan_mode_scope: bool,
    ) -> Vec<SelectionAction>
```

**Purpose**: Creates the action that runs when a quick model choice is selected. The action either updates the model immediately or opens the Plan mode scope question first.

**Data flow**: It receives the selected model, the selected reasoning effort, and a flag saying whether Plan mode needs a follow-up question. It returns a list containing one action. When that action runs, it sends events to update and persist the choice, or sends an event to open the Plan mode prompt instead.

**Call relations**: This action builder is used by the quick model picker in `ChatWidget::open_model_popup_with_presets`. It does not perform the UI update itself; it hands instructions to the app event system.

*Call graph*: 1 external calls (vec!).


##### `ChatWidget::should_prompt_plan_mode_reasoning_scope`  (lines 239–257)

```
fn should_prompt_plan_mode_reasoning_scope(
        &self,
        selected_model: &str,
        selected_effort: Option<ReasoningEffortConfig>,
    ) -> bool
```

**Purpose**: Decides whether changing reasoning while in Plan mode needs an extra confirmation about where the change should apply. This prevents the app from silently changing both Plan-specific settings and global defaults when the user may only intend one of them.

**Data flow**: It reads whether collaboration modes are enabled, whether the active mode is Plan, what model is currently selected, the effective reasoning effort, and the stored Plan/global settings. It returns true only when the selected model is the current one and the reasoning change is not a true no-op for both Plan mode and the stored defaults.

**Call relations**: `ChatWidget::open_reasoning_popup` calls this before applying a reasoning choice. Quick model actions are also built around the same decision so they can route the user to `ChatWidget::open_plan_reasoning_scope_prompt` when needed.

*Call graph*: called by 1 (open_reasoning_popup).


##### `ChatWidget::open_plan_reasoning_scope_prompt`  (lines 259–348)

```
fn open_plan_reasoning_scope_prompt(
        &mut self,
        model: String,
        effort: Option<ReasoningEffortConfig>,
    )
```

**Purpose**: Shows the special Plan mode question: apply this reasoning level only to Plan mode, or apply it to all modes. This makes an otherwise hidden configuration consequence visible to the user.

**Data flow**: It receives the selected model and reasoning effort. It builds human-readable descriptions, including where the current Plan reasoning setting came from, then creates two choices. The Plan-only choice updates and persists the Plan override. The all-modes choice updates the model, global reasoning, Plan reasoning, and persists both relevant settings. It also sends a notification that the prompt is open.

**Call relations**: Other selection actions open this prompt when `ChatWidget::should_prompt_plan_mode_reasoning_scope` says the user needs to choose the scope. The prompt then sends application events that perform the actual setting changes.

*Call graph*: calls 1 internal fn (plan_mask); 3 external calls (default, format!, vec!).


##### `ChatWidget::open_reasoning_popup`  (lines 351–498)

```
fn open_reasoning_popup(&mut self, preset: ModelPreset)
```

**Purpose**: Shows the second step of model selection: choosing the reasoning effort for a chosen model. If there is only one possible effort, it applies that choice directly instead of making the user click through another menu.

**Data flow**: It receives a model preset, reads its default and supported reasoning efforts, and builds a list of choices. It highlights the current or default effort, adds warning text for high-effort choices on certain models, and creates actions that update and persist the selected model and effort. If there is only one choice, it either opens the Plan mode scope prompt or applies the model and effort immediately.

**Call relations**: `ChatWidget::open_all_models_popup` sends users here after they choose a specific model. This function consults `ChatWidget::should_prompt_plan_mode_reasoning_scope` before applying changes and calls `ChatWidget::apply_model_and_effort` for the simple one-choice case.

*Call graph*: calls 3 internal fn (apply_model_and_effort, should_prompt_plan_mode_reasoning_scope, new); 7 external calls (new, default, from, reasoning_effort_label, new, format!, vec!).


##### `ChatWidget::reasoning_effort_label`  (lines 500–510)

```
fn reasoning_effort_label(effort: &ReasoningEffortConfig) -> String
```

**Purpose**: Turns an internal reasoning-effort value into a short label suitable for menus, such as “Low” or “Extra high.”

**Data flow**: It receives a reasoning-effort setting and returns display text. Built-in values become fixed labels, while a custom value is shown as the custom text itself.

**Call relations**: Reasoning popups and Plan mode descriptions use this labeling helper so effort names are presented consistently to the user.


##### `ChatWidget::reasoning_effort_sentence_label`  (lines 512–517)

```
fn reasoning_effort_sentence_label(effort: &ReasoningEffortConfig) -> String
```

**Purpose**: Turns a reasoning-effort value into wording that fits naturally inside a sentence. For example, menu label “High” becomes sentence text like “high reasoning.”

**Data flow**: It receives a reasoning-effort setting. Custom values are returned unchanged, while standard values are converted through `ChatWidget::reasoning_effort_label` and lowercased.

**Call relations**: `ChatWidget::open_plan_reasoning_scope_prompt` uses this helper to write readable descriptions for the Plan-only and all-modes choices.

*Call graph*: 1 external calls (reasoning_effort_label).


##### `ChatWidget::apply_model_and_effort_without_persist`  (lines 519–527)

```
fn apply_model_and_effort_without_persist(
        &self,
        model: String,
        effort: Option<ReasoningEffortConfig>,
    )
```

**Purpose**: Applies a model and reasoning effort for the current running session without saving that choice as the new default. This is useful when another path is responsible for persistence, or when the change should be temporary.

**Data flow**: It receives a model name and an optional reasoning effort. It sends one event to update the active model and another event to update the active reasoning effort. It does not write the choice to stored configuration.

**Call relations**: `ChatWidget::apply_model_and_effort` calls this as its first step, then adds persistence afterward. This keeps the “apply now” part separate from the “remember for later” part.

*Call graph*: called by 1 (apply_model_and_effort); 2 external calls (UpdateModel, UpdateReasoningEffort).


##### `ChatWidget::apply_model_and_effort`  (lines 529–533)

```
fn apply_model_and_effort(&self, model: String, effort: Option<ReasoningEffortConfig>)
```

**Purpose**: Applies a model and reasoning effort now, and also asks the app to remember that choice for future use.

**Data flow**: It receives a model name and an optional reasoning effort. First it sends the live update events through `ChatWidget::apply_model_and_effort_without_persist`. Then it sends a persistence event containing the same model and effort.

**Call relations**: `ChatWidget::open_reasoning_popup` uses this in the simple case where a selected model has only one reasoning choice and no Plan mode scope prompt is needed.

*Call graph*: calls 1 internal fn (apply_model_and_effort_without_persist); called by 1 (open_reasoning_popup).


### `tui/src/chatwidget/review_popups.rs`

`orchestration` · `user interaction`

This file is the user-facing doorway into review mode inside the terminal chat interface. Instead of making the user remember commands, it shows small popups: review against a branch, review uncommitted changes, review one commit, or type custom review instructions. Think of it like a restaurant menu: the user picks the kind of review they want, and the code sends the order to the rest of the app.

The main popup is built by `ChatWidget::open_review_popup`. Some choices immediately start a review, such as reviewing uncommitted changes. Other choices open a second popup, such as a searchable list of Git branches or recent commits. Git is the version-control tool used to track project history; branches and commits are different ways to point at code changes.

The branch and commit pickers fetch real repository data from the current working directory, turn each branch or commit into a selectable row, and attach an action to that row. When the user selects one, the action sends a `ReviewTarget`, which tells the app exactly what to review. The custom prompt view is slightly different: it asks the user to type free-form instructions, ignores empty text, and sends the typed instructions as the review target.

There is also a test-only helper that builds the commit picker from supplied commit entries, so tests can check the popup behavior without reading an actual Git repository.

#### Function details

##### `ChatWidget::open_review_popup`  (lines 6–61)

```
fn open_review_popup(&mut self)
```

**Purpose**: Shows the first review menu, where the user chooses what kind of review they want. This is the starting point for review selection in the chat interface.

**Data flow**: It starts with the chat widget's current state, especially the configured working directory. It builds a list of visible menu choices, and each choice carries a small action to run later if selected. The result is a selection popup shown in the bottom pane; nothing is reviewed yet unless the user picks an item.

**Call relations**: This function is called when the app wants to open the review menu. It creates choices that either send an event to open a follow-up picker, such as the branch or commit picker, or directly send a review request for uncommitted changes. It hands the finished menu to the bottom pane so the user can interact with it.

*Call graph*: 3 external calls (default, new, vec!).


##### `ChatWidget::show_review_branch_picker`  (lines 63–93)

```
async fn show_review_branch_picker(&mut self, cwd: &Path)
```

**Purpose**: Shows a searchable list of local Git branches so the user can choose a base branch for a pull-request-style review. A base branch is the branch the current work should be compared against.

**Data flow**: It receives a repository folder path. It reads the local branch names and the current branch name, then turns each possible target branch into a row labeled like "current branch -> target branch." When the user selects a row, the attached action sends a review request containing that branch name. The output is a searchable selection popup in the bottom pane.

**Call relations**: This is reached after the first review menu asks to open the branch picker. It relies on Git-reading helpers to supply branch information, then connects each branch choice to the app's review event sender. Once a branch is selected, the rest of the app receives a `BaseBranch` review target and can begin the review.

*Call graph*: 4 external calls (default, with_capacity, format!, vec!).


##### `ChatWidget::show_review_commit_picker`  (lines 95–126)

```
async fn show_review_commit_picker(&mut self, cwd: &Path)
```

**Purpose**: Shows a searchable list of recent commits so the user can pick one commit to review. A commit is a saved snapshot of changes in Git history.

**Data flow**: It receives a repository folder path, asks for up to 100 recent commits, and builds one selectable row per commit. Each row displays the commit subject and stores searchable text made from the subject and commit ID. When selected, the row sends a review request containing the commit ID and title. The result is a commit picker shown in the bottom pane.

**Call relations**: This is opened from the main review menu when the user chooses to review a commit. It gathers recent history, turns that history into UI choices, and wires each choice to a `Commit` review target so the review system knows exactly which commit to inspect.

*Call graph*: 4 external calls (default, with_capacity, format!, vec!).


##### `ChatWidget::show_review_custom_prompt`  (lines 128–146)

```
fn show_review_custom_prompt(&mut self)
```

**Purpose**: Shows a text box where the user can type custom review instructions. This lets the user describe a review request that does not fit the preset branch, commit, or uncommitted-change choices.

**Data flow**: It copies the app event sender from the chat widget, creates a custom prompt view with a title and placeholder instructions, and gives that view a callback to run when the user submits text. The callback trims extra whitespace, ignores empty submissions, and sends a review request containing the typed instructions. The output is a custom prompt view shown in the bottom pane.

**Call relations**: This is opened from the main review menu when the user chooses custom instructions. It hands control to `CustomPromptView`, and that view later calls the provided callback when the user presses Enter. The callback sends a `Custom` review target into the app event flow.

*Call graph*: calls 1 internal fn (new); 2 external calls (new, new).


##### `show_review_commit_picker_with_entries`  (lines 150–182)

```
fn show_review_commit_picker_with_entries(
    chat: &mut ChatWidget,
    entries: Vec<CommitLogEntry>,
)
```

**Purpose**: Builds the commit picker from commit entries supplied directly by a test. This lets tests exercise the picker without depending on a real Git repository or recent commit history.

**Data flow**: It receives a mutable chat widget and a list of commit entries. It converts each entry into a selectable row, including display text, searchable text, and an action that sends a commit review request. It then shows the same searchable commit selection popup that the normal commit picker would show.

**Call relations**: This helper exists only when tests are compiled. It mirrors the normal commit picker’s UI-building path, but skips the Git lookup step by accepting prepared commit data. That makes the picker behavior easier to test in isolation.

*Call graph*: 4 external calls (default, with_capacity, format!, vec!).


### `tui/src/chatwidget/plan_implementation.rs`

`orchestration` · `after plan approval, during prompt/request handling`

This file is about the handoff from “planning” to “coding.” In Plan mode, the assistant may first discuss and approve a plan before changing files. Once that plan is ready, the user needs a clear choice: go ahead and implement it, start a fresh conversation using that plan, or keep planning.

The file defines the wording for that prompt and builds the menu items that appear in the terminal user interface. Each menu choice carries both display text and, when appropriate, an action to run if the user selects it. The first choice sends a normal user message saying “Implement the plan” while switching to the default collaboration mode. The second choice clears the current user interface context and submits a longer message that includes the approved plan, so the coding work can begin in a fresh thread. The third choice does nothing except close the prompt, leaving the user in Plan mode.

The important safety detail is that some choices can be disabled. If the default mode is unavailable, implementation choices are not clickable. If there is no approved non-empty plan, the “clear context and implement” option is also disabled. This prevents the interface from offering actions that cannot actually work.

#### Function details

##### `selection_view_params`  (lines 28–114)

```
fn selection_view_params(
    default_mask: Option<CollaborationModeMask>,
    plan_markdown: Option<&str>,
    clear_context_usage_label: Option<&str>,
) -> SelectionViewParams
```

**Purpose**: Builds the confirmation popup that asks whether to implement an approved plan. It packages the visible menu text, short descriptions, disabled-state messages, and the actions that should happen when each choice is selected.

**Data flow**: It receives three pieces of information: whether Default mode is available, the approved plan text if there is one, and an optional label showing how much context is already used. From that, it creates a `SelectionViewParams` value, which is the full recipe for drawing the popup. If Default mode is available, the normal implementation option sends an app event that submits “Implement the plan.” in that mode. If a non-empty plan is available too, the fresh-context option sends an app event that clears the UI and submits a longer message containing the plan. If required information is missing, the matching menu item is returned with a disabled reason instead of an action.

**Call relations**: This function is used when the chat widget opens the plan-implementation prompt, and it is also exercised by a test that checks the fresh-context option requires both Default mode and an approved plan. Inside, it borrows the shared standard popup hint line so this prompt behaves like other selection popups, then hands back the finished selection-view description for the rest of the UI to display and execute.

*Call graph*: calls 1 internal fn (standard_popup_hint_line); called by 2 (plan_implementation_clear_context_requires_default_mode_and_plan, open_plan_implementation_prompt); 4 external calls (default, new, format!, vec!).


### Usage and reasoning controls
Implements token and usage flows alongside quick controls for adjusting model reasoning effort.

### `tui/src/chatwidget/reasoning_shortcuts.rs`

`domain_logic` · `chat key handling`

This file solves a user-interface problem: when a person presses the shortcut for “think less” or “think more,” the app needs to adjust the active model’s reasoning setting safely and predictably. “Reasoning effort” means how much work the model is asked to spend thinking before answering, where supported levels might be low, medium, high, or custom values.

The main function first checks whether the pressed key is one of the reasoning shortcuts. If not, it leaves the key alone so normal chat typing can use it. It also refuses to act while a popup or modal window owns the keyboard, much like ignoring a TV remote shortcut while a settings menu is open.

Once the shortcut is accepted, the code looks up the current model’s preset. A preset describes what reasoning levels that model actually supports and what its default is. The file then builds the allowed list, anchors the current setting to a safe value if it is missing or unsupported, and steps one slot up or down in the model’s advertised order. If the user is already at the lowest or highest level, it shows a friendly message instead of changing anything.

There is one important split: in normal chat mode, the new effort is applied temporarily without saving it permanently. In Plan mode, the shortcut updates only the Plan-mode override, avoiding a broader “global or Plan?” prompt.

#### Function details

##### `ReasoningShortcutDirection::bound_message`  (lines 32–38)

```
fn bound_message(self, effort: &ReasoningEffortConfig) -> String
```

**Purpose**: This creates the message shown when the user tries to lower or raise reasoning effort past the allowed edge. It turns a bare boundary case into a clear sentence like “already at the lowest level.”

**Data flow**: It receives the shortcut direction and the effort level currently at the boundary. It asks ChatWidget for a human-friendly label for that effort, then formats a sentence. The result is a string that can be displayed to the user.

**Call relations**: When ChatWidget::handle_reasoning_shortcut discovers there is no next level to move to, it uses this helper to explain why nothing changed. The helper depends on the shared label wording so the message matches the rest of the chat interface.

*Call graph*: 2 external calls (format!, reasoning_effort_sentence_label).


##### `ChatWidget::handle_reasoning_shortcut`  (lines 53–120)

```
fn handle_reasoning_shortcut(&mut self, key_event: KeyEvent) -> bool
```

**Purpose**: This is the main shortcut handler for raising or lowering reasoning effort from the chat screen. It decides whether the key press belongs to this feature, checks whether it is safe to act, picks the next valid effort level, and applies it.

**Data flow**: It takes a keyboard event as input and reads the chat widget’s current state: key bindings, popup state, session readiness, current model, model catalog, current reasoning effort, and active mode. If the key is not a reasoning shortcut, it returns false. If it is a shortcut, it either shows an informational message, sends a Plan-mode update event, or applies a temporary model-and-effort change, then returns true.

**Call relations**: This function is meant to run before the general chat key dispatcher, so recognized shortcuts do not get treated as ordinary typing. It calls ChatWidget::current_model_preset to find the active model’s rules, reasoning_choices to get the allowed effort list, and next_reasoning_effort to choose the neighboring level. If the app is in Plan mode, it hands the change to the app event system with UpdatePlanModeReasoningEffort; otherwise it applies the change directly without persisting it.

*Call graph*: calls 3 internal fn (current_model_preset, next_reasoning_effort, reasoning_choices); 2 external calls (UpdatePlanModeReasoningEffort, format!).


##### `ChatWidget::current_model_preset`  (lines 122–129)

```
fn current_model_preset(&self) -> Option<ModelPreset>
```

**Purpose**: This finds the preset information for the model currently selected in the chat widget. The preset is needed because different models can support different reasoning levels.

**Data flow**: It reads the current model name from the widget and asks the model catalog for the available presets. If the catalog can be listed and a preset has the same model name, it returns that preset. If listing fails or no match exists, it returns nothing.

**Call relations**: ChatWidget::handle_reasoning_shortcut calls this before trying to change reasoning effort. Without a preset, the shortcut handler cannot know which effort levels are valid, so it shows a message and stops.

*Call graph*: called by 1 (handle_reasoning_shortcut).


##### `reasoning_choices`  (lines 132–142)

```
fn reasoning_choices(preset: &ModelPreset) -> Vec<ReasoningEffortConfig>
```

**Purpose**: This builds the list of reasoning effort levels that the active model says it supports. It also provides a fallback so there is at least one usable level when the model preset does not advertise any choices.

**Data flow**: It receives a model preset. It reads the preset’s supported reasoning efforts and copies their effort values into a new list. If that list is empty, it inserts the preset’s default reasoning effort. The output is the ordered list that shortcut stepping should follow.

**Call relations**: ChatWidget::handle_reasoning_shortcut uses this before choosing the next level. The order matters because next_reasoning_effort treats the list like a ladder: lower moves one rung backward and raise moves one rung forward.

*Call graph*: called by 1 (handle_reasoning_shortcut).


##### `next_reasoning_effort`  (lines 144–161)

```
fn next_reasoning_effort(
    choices: &[ReasoningEffortConfig],
    current_effort: Option<ReasoningEffortConfig>,
    direction: ReasoningShortcutDirection,
) -> Option<ReasoningEffortConfig>
```

**Purpose**: This chooses the next reasoning effort one step lower or higher than the current one. It is the small, focused rule that makes the shortcut behave like stepping through a fixed menu rather than guessing.

**Data flow**: It receives an ordered list of allowed choices, the current effort if there is one, and the requested direction. If there is no current effort, or the current effort is not in the list, it returns nothing. If the current effort is found, it returns the previous item for Lower, the next item for Raise, or nothing if the current effort is already at the edge.

**Call relations**: ChatWidget::handle_reasoning_shortcut calls this after it has already anchored the current effort to a safe supported value. The tests in this file focus heavily on this function because it holds the core stepping behavior and boundary rules.

*Call graph*: called by 1 (handle_reasoning_shortcut); 2 external calls (get, iter).


##### `tests::next_reasoning_effort_raises_from_default_anchor`  (lines 169–185)

```
fn next_reasoning_effort_raises_from_default_anchor()
```

**Purpose**: This test checks that raising from a middle effort level moves to the next higher advertised level. It protects the ordinary “increase reasoning” shortcut path.

**Data flow**: It creates a list ordered from Low through XHigh and uses Medium as the current effort. It asks next_reasoning_effort to raise the level. The expected result is High.

**Call relations**: This test exercises next_reasoning_effort directly. It represents the situation ChatWidget::handle_reasoning_shortcut reaches after it has chosen the current model’s supported effort list and current anchor.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `tests::next_reasoning_effort_lowers_from_default_anchor`  (lines 188–203)

```
fn next_reasoning_effort_lowers_from_default_anchor()
```

**Purpose**: This test checks that lowering from a middle effort level moves to the previous advertised level. It protects the ordinary “decrease reasoning” shortcut path.

**Data flow**: It creates a list ordered Low, Medium, High and uses Medium as the current effort. It asks next_reasoning_effort to lower the level. The expected result is Low.

**Call relations**: This test calls next_reasoning_effort in the same way the shortcut handler would after preparing a valid current value. It confirms the downward movement uses the list order.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `tests::next_reasoning_effort_does_not_infer_position_for_unsupported_current`  (lines 206–224)

```
fn next_reasoning_effort_does_not_infer_position_for_unsupported_current()
```

**Purpose**: This test makes sure the stepping function does not guess where an unsupported current effort belongs. That matters because different models may support unusual or sparse effort lists.

**Data flow**: It creates a choices list containing Low and High, then uses Medium as the current effort even though Medium is not supported. It tries both raising and lowering. Both results are expected to be nothing.

**Call relations**: This test checks next_reasoning_effort by itself. The larger shortcut handler normally anchors unsupported values before calling it, but this test keeps the helper honest: it only steps from values that are actually present in the provided list.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `tests::next_reasoning_effort_uses_advertised_order_for_custom_levels`  (lines 227–253)

```
fn next_reasoning_effort_uses_advertised_order_for_custom_levels()
```

**Purpose**: This test confirms that custom or unusual effort levels follow the model’s advertised order, not a built-in assumption about what “low” or “high” means. This keeps the shortcut flexible for models with nonstandard choices.

**Data flow**: It creates a custom effort named “max” and a deliberately unusual order: High, Low, then custom max. It raises from High and lowers from custom max. In both cases, the expected neighboring level is Low, because Low sits next to those entries in the provided list.

**Call relations**: This test exercises next_reasoning_effort directly. It supports the behavior used by ChatWidget::handle_reasoning_shortcut when the active model catalog supplies custom reasoning options.

*Call graph*: 3 external calls (Custom, assert_eq!, vec!).


##### `tests::next_reasoning_effort_clamps_at_bounds`  (lines 256–279)

```
fn next_reasoning_effort_clamps_at_bounds()
```

**Purpose**: This test checks that the stepping function stops at the lowest and highest available levels. It prevents shortcuts from wrapping around or producing invalid values at the edges.

**Data flow**: It creates a Low, Medium, High list. It tries lowering from Low and raising from High. Both operations are expected to return nothing, meaning there is no valid next step.

**Call relations**: This test covers the boundary behavior that ChatWidget::handle_reasoning_shortcut turns into a user-facing message through ReasoningShortcutDirection::bound_message.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `tests::next_reasoning_effort_single_option_is_noop`  (lines 282–301)

```
fn next_reasoning_effort_single_option_is_noop()
```

**Purpose**: This test checks the case where a model has only one available reasoning effort. In that situation, both shortcut directions should do nothing because there is nowhere to move.

**Data flow**: It creates a list with only High. It asks next_reasoning_effort to raise and lower from High. Both results are expected to be nothing.

**Call relations**: This test exercises next_reasoning_effort directly and protects the shortcut handler’s behavior for models with no real choice of reasoning level. In the full chat flow, that no-change result becomes an informational boundary message.

*Call graph*: 2 external calls (assert_eq!, vec!).


### `tui/src/chatwidget/tokens.rs`

`orchestration` · `request handling and main loop`

When a user types `/usage`, the app needs to fetch token-usage data from the account service. That takes time, but the interface should still respond right away. This file creates a temporary card that says “Loading...” and shows it above the message composer instead of immediately writing it into the permanent transcript. Think of it like putting a “your receipt is printing” slip on the counter before stapling the final receipt into the record book.

The main pieces are a shared card state, a completion handle, and chat-widget methods that decide when the card may enter history. `TokenActivityHandle` is held by the background request path. The visible card and the handle share the same state through a lock, so the background result can change the card from loading to loaded or unavailable. A request ID is kept with each pending card so a slow response from an older `/usage` command cannot overwrite a newer one.

Once the right response arrives, the card moves from “refreshing” to “completed.” It still may not be inserted into history immediately, because active streams or transcript updates could make the output appear in the wrong order. This file checks those blockers, retries insertion when they clear, and can clear pending cards when the transcript is reset or replaced.

#### Function details

##### `TokenActivityHandle::finish`  (lines 74–76)

```
fn finish(&self, result: Result<GetAccountTokenUsageResponse, String>)
```

**Purpose**: Marks a token-activity request as finished using the current date. Callers use this when the background account lookup returns either real usage data or an error.

**Data flow**: It receives a result: either the token-usage response or an error message. It reads the current UTC date, then passes both the result and date to `TokenActivityHandle::finish_with_today`. The shared card state is changed indirectly, so the visible card can stop showing the loading message.

**Call relations**: This is the public completion step for the handle created with a `/usage` card. `ChatWidget::finish_token_activity_refresh` calls it after confirming the request ID matches, and it delegates the actual state replacement to `TokenActivityHandle::finish_with_today`.

*Call graph*: calls 1 internal fn (finish_with_today); 1 external calls (now).


##### `TokenActivityHandle::finish_with_today`  (lines 78–90)

```
fn finish_with_today(
        &self,
        result: Result<GetAccountTokenUsageResponse, String>,
        today: NaiveDate,
    )
```

**Purpose**: Changes the shared card state from loading into either loaded data or an error state, using a supplied date. The explicit date makes the rendering consistent and easy to test.

**Data flow**: It receives the account response result and a date called `today`. If the result is successful, it stores the response together with that date. If the result is an error, it stores a simple error state. It writes this new state into the shared locked storage used by the card.

**Call relations**: This is called by `TokenActivityHandle::finish`. It is the low-level state update that lets the already-created history cell render different text the next time the chat widget redraws.

*Call graph*: called by 1 (finish).


##### `new_token_activity_output`  (lines 105–122)

```
fn new_token_activity_output(
    view: TokenActivityView,
) -> (CompositeHistoryCell, TokenActivityHandle)
```

**Purpose**: Builds the visible `/usage` output card and the handle that will later complete it. It gives the user immediate feedback by creating a composite cell that contains the echoed command plus a loading card.

**Data flow**: It receives a `TokenActivityView`, which describes which usage view is being requested. It creates a small command line like `/usage daily`, creates shared state set to loading, builds a `TokenActivityHandle` pointing at that state, and builds a `TokenActivityHistoryCell` that reads the same state. It returns the combined history cell and the handle as a pair.

**Call relations**: This is called by `ChatWidget::add_token_activity_output` when a new `/usage` command starts. The returned cell stays with the chat widget for rendering, while the returned handle is kept so the matching background response can update the card.

*Call graph*: calls 2 internal fn (new, new); called by 1 (add_token_activity_output); 4 external calls (clone, new, new, vec!).


##### `TokenActivityHistoryCell::display_lines`  (lines 125–143)

```
fn display_lines(&self, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Turns the current token-activity card state into lines of text for the terminal. It decides whether the user sees a loading message, an unavailable message, or the finished chart.

**Data flow**: It receives the available display width. It reads the shared card state through a read lock. If the state is loading, it returns a bold title and dim loading text. If the state is an error, it returns a stable unavailable message. If the state has data, it asks the chart code to format the response for the given width.

**Call relations**: This method is part of the `HistoryCell` interface, so the chat rendering system can draw this card like any other history item. `TokenActivityHistoryCell::raw_lines` also calls it when plain, unstyled lines are needed.

*Call graph*: calls 1 internal fn (loaded_lines); called by 1 (raw_lines); 1 external calls (vec!).


##### `TokenActivityHistoryCell::raw_lines`  (lines 145–147)

```
fn raw_lines(&self) -> Vec<Line<'static>>
```

**Purpose**: Produces a plain-text version of the token-activity card. This is useful when the app needs the card content without terminal styling.

**Data flow**: It asks `TokenActivityHistoryCell::display_lines` to render the card at a very wide width, then passes those styled lines through `plain_lines` to strip or normalize styling. The output is a list of plain text lines.

**Call relations**: This is the raw-text side of the `HistoryCell` interface. It relies on `display_lines` so the plain version stays consistent with what the user sees on screen.

*Call graph*: calls 2 internal fn (display_lines, plain_lines).


##### `ChatWidget::add_token_activity_output`  (lines 156–171)

```
fn add_token_activity_output(&mut self, view: TokenActivityView)
```

**Purpose**: Starts a new `/usage` refresh in the chat widget. It replaces any current temporary usage card, shows a new loading card, and asks the rest of the app to fetch the data.

**Data flow**: It receives the requested token-activity view. It takes the next request ID, increments the counter for future requests, and calls `new_token_activity_output` to get a loading cell and completion handle. It clears any previously completed usage card, stores the new pending output, marks the active display as changed, requests a redraw, and sends an app event asking for token-activity refresh for that request ID.

**Call relations**: This is the starting point for the `/usage` card lifecycle inside the widget. It creates the pending state that later functions read, complete, render, or clear.

*Call graph*: calls 1 internal fn (new_token_activity_output).


##### `ChatWidget::pending_token_activity_output`  (lines 178–187)

```
fn pending_token_activity_output(&self) -> Option<&dyn HistoryCell>
```

**Purpose**: Returns the token-activity card that should currently be shown above the composer. It prefers a still-loading card, but can also return a completed card that has not yet been inserted into history.

**Data flow**: It reads the widget’s pending token-activity fields. If a refreshing output exists, it returns a borrowed view of that composite cell. Otherwise, if a completed output is waiting, it returns that cell. If neither exists, it returns nothing. It does not move or change ownership of the card.

**Call relations**: The rendering path calls this when deciding what temporary output to draw outside the permanent transcript. It bridges the widget’s internal pending/completed slots to the generic history-cell rendering system.


##### `ChatWidget::finish_token_activity_refresh`  (lines 194–211)

```
fn finish_token_activity_refresh(
        &mut self,
        request_id: u64,
        result: Result<GetAccountTokenUsageResponse, String>,
    ) -> bool
```

**Purpose**: Applies a background `/usage` result to the correct pending card. It protects the interface from late responses by checking the request ID before changing anything.

**Data flow**: It receives a request ID and either a usage response or an error. It takes the current refreshing output, if any. If there is no pending output, or the ID does not match, it restores state as needed and returns `false`. If the ID matches, it uses the output’s handle to store the result, moves the cell into the completed slot, marks the display as changed, requests a redraw, and returns `true`.

**Call relations**: This is called when the background account request finishes. It hands the actual state update to `TokenActivityHandle::finish`, then prepares the completed card for later history insertion.


##### `ChatWidget::usage_history_insertion_blocked`  (lines 218–224)

```
fn usage_history_insertion_blocked(&self) -> bool
```

**Purpose**: Checks whether it is currently unsafe to insert a completed usage card into chat history. This avoids putting the card in the wrong order while other output is still being streamed or consolidated.

**Data flow**: It reads several widget fields that indicate active work: normal streaming, plan streaming, queued stream consolidation, an active transcript cell, or an active hook cell. If any of these are present, it returns `true`; otherwise it returns `false`.

**Call relations**: Code that wants to commit completed usage output calls this before taking the completed card. If it reports a blocker, insertion is delayed and retried later.


##### `ChatWidget::note_stream_consolidation_queued`  (lines 230–233)

```
fn note_stream_consolidation_queued(&mut self)
```

**Purpose**: Records that a stream-consolidation step has been queued, so usage-card insertion should wait. A stream consolidation is a cleanup step that turns streamed pieces into stable transcript content.

**Data flow**: It reads the current count of pending stream consolidations and adds one, using saturating arithmetic so the number cannot overflow in normal use. The changed counter becomes one of the blockers checked before usage output is inserted.

**Call relations**: This is called when the chat system queues consolidation work. It pairs with `ChatWidget::note_stream_consolidation_completed`, which removes the blocker later.


##### `ChatWidget::note_stream_consolidation_completed`  (lines 239–242)

```
fn note_stream_consolidation_completed(&mut self)
```

**Purpose**: Records that one queued stream-consolidation step has finished. This may help clear the way for a completed usage card to be inserted into history.

**Data flow**: It reads the pending consolidation count and subtracts one, using saturating arithmetic so an extra completion call cannot make the count go below zero. The resulting count is later checked by `ChatWidget::usage_history_insertion_blocked`.

**Call relations**: This is the counterpart to `ChatWidget::note_stream_consolidation_queued`. After stream cleanup finishes, callers use it so delayed usage output can eventually be committed.


##### `ChatWidget::take_completed_token_activity_output`  (lines 249–253)

```
fn take_completed_token_activity_output(&mut self) -> Option<CompositeHistoryCell>
```

**Purpose**: Removes the completed token-activity card from the temporary area and hands it to the history insertion path. Callers should only use this after checking that insertion is not blocked.

**Data flow**: It looks for a completed token-activity output. If none exists, it returns nothing. If one exists, it takes ownership of the cell, clears the completed slot, marks the active display as changed, and returns the cell for insertion into transcript history.

**Call relations**: This is used after `ChatWidget::usage_history_insertion_blocked` says it is safe to proceed. It is the handoff point between temporary rendering and permanent history.


##### `ChatWidget::request_pending_usage_output_insertion`  (lines 259–265)

```
fn request_pending_usage_output_insertion(&self)
```

**Purpose**: Asks the app to try committing pending usage-related output if there is anything waiting. This is a retry signal for cases where an earlier insertion attempt was blocked.

**Data flow**: It checks whether a completed token-activity card exists or whether a rate-limit reset hint is pending. If either is present, it sends an app event requesting `CommitPendingUsageOutput`. It does not itself insert the card.

**Call relations**: This is called after events that might have cleared insertion blockers. It nudges the app event loop to come back and run the commit path at a safe time.


##### `ChatWidget::request_pending_usage_output_insertion_after_stream_shutdown`  (lines 267–274)

```
fn request_pending_usage_output_insertion_after_stream_shutdown(&self)
```

**Purpose**: Asks the app to try committing pending usage-related output after stream shutdown has finished. It is a more specific retry signal for the end of streaming activity.

**Data flow**: It checks for the same waiting work as `ChatWidget::request_pending_usage_output_insertion`: a completed token-activity card or a pending rate-limit reset hint. If either exists, it sends `CommitPendingUsageOutputAfterStreamShutdown` to the app event channel.

**Call relations**: This is used around stream shutdown, where insertion must happen only after streaming state is fully cleared. It tells the event loop to retry the pending usage-output commit in that safer phase.


##### `ChatWidget::clear_pending_token_activity_refreshes`  (lines 280–287)

```
fn clear_pending_token_activity_refreshes(&mut self)
```

**Purpose**: Drops any temporary or completed token-activity cards that should no longer affect the transcript. This is important after resets, backtracking, or replacement flows where old background results must be ignored.

**Data flow**: It removes the current refreshing output and the completed output, if they exist. If anything was actually cleared, it marks the active display as changed and requests a redraw. It does not cancel a background request directly, but it removes the widget-owned card that the result would have completed.

**Call relations**: This is called when the chat state changes in a way that makes pending `/usage` cards obsolete. Later calls to `ChatWidget::finish_token_activity_refresh` for those old requests will not find matching pending output, so they cannot mutate visible history.


### `tui/src/chatwidget/usage.rs`

`domain_logic` · `startup, user menu interaction, and async server response handling`

This file is the user-interface flow for `/usage` inside the terminal chat widget. Its main job is to let a person view token usage or redeem a rate-limit reset, which is like using a spare ticket to clear current usage limits. Without this file, the app might still know about resets in the background, but users would not get a clear menu, loading state, success message, retry option, or startup hint.

The code works like a small receptionist. When the user opens the usage menu, it builds a menu with “Show usage” and “Redeem rate limit reset.” If the app needs to ask the server how many resets are available, it shows a loading popup and records a request number. That request number matters because server replies can arrive late; the widget only accepts the reply that matches the latest request.

If resets are available, the file builds a confirmation popup. Choosing “Use a reset” sends an app event with an idempotency key, which is a unique safety label that helps avoid charging the same reset twice if a request is retried. After a reset succeeds, the file shows another loading screen while it refreshes the remaining count. It also supports a startup hint that tells users they have resets available, then removes that hint once it is no longer needed.

#### Function details

##### `ChatWidget::open_usage_menu`  (lines 12–57)

```
fn open_usage_menu(&mut self)
```

**Purpose**: Opens the Usage menu in the bottom pane. It gives the user a choice between viewing token activity and redeeming a rate-limit reset, while disabling the reset option when the account is not eligible.

**Data flow**: It reads the account type, plan type, and any known number of available reset credits. From that, it builds menu text and enabled or disabled menu items, clears any pending reset hint, shows the menu, and asks the screen to redraw.

**Call relations**: This is the front door for the usage flow. Before showing the menu, it asks `ChatWidget::clear_pending_rate_limit_reset_hint` to remove any old hint so the popup and chat history do not compete for attention. The menu actions then hand off to app-level events for token activity or reset-credit checking.

*Call graph*: calls 1 internal fn (clear_pending_rate_limit_reset_hint); 3 external calls (default, format!, vec!).


##### `ChatWidget::show_rate_limit_reset_loading_popup`  (lines 59–76)

```
fn show_rate_limit_reset_loading_popup(&mut self) -> u64
```

**Purpose**: Shows a temporary popup while the app checks how many rate-limit resets the user has. It also creates a request number so the later server reply can be matched to this exact check.

**Data flow**: It clears any existing hint, takes the next request ID, stores it as the pending reset request, builds a disabled “Loading...” selection view, displays it, redraws the screen, and returns the request ID to the caller.

**Call relations**: This starts the visible refresh flow after the user asks to redeem a reset. It relies on `ChatWidget::take_next_rate_limit_reset_request_id` for a fresh tracking number and later expects `ChatWidget::finish_rate_limit_reset_credits_refresh` to receive the matching response.

*Call graph*: calls 2 internal fn (clear_pending_rate_limit_reset_hint, take_next_rate_limit_reset_request_id); 2 external calls (default, vec!).


##### `ChatWidget::finish_rate_limit_reset_credits_refresh`  (lines 78–110)

```
fn finish_rate_limit_reset_credits_refresh(
        &mut self,
        request_id: u64,
        result: Result<RateLimitResetCreditsSummary, String>,
    ) -> bool
```

**Purpose**: Finishes the check for available reset credits and replaces the loading popup with either a confirmation screen or an explanatory message. It ignores replies that do not belong to the current pending request.

**Data flow**: It receives a request ID and either a reset-credit summary or an error message. If the ID is stale, it returns `false` and changes nothing. If it matches, it clears the pending request, stores the available count on success, chooses the right popup content, replaces the existing popup if it is still visible, redraws if needed, and returns whether the popup was replaced.

**Call relations**: This is the follow-up to `ChatWidget::show_rate_limit_reset_loading_popup`. When credits are available it uses `ChatWidget::rate_limit_reset_confirmation_params`; otherwise it uses `ChatWidget::rate_limit_reset_message_params` to explain that there are no credits or that loading failed.

*Call graph*: 2 external calls (rate_limit_reset_confirmation_params, rate_limit_reset_message_params).


##### `ChatWidget::rate_limit_reset_confirmation_params`  (lines 112–143)

```
fn rate_limit_reset_confirmation_params(available_count: i64) -> SelectionViewParams
```

**Purpose**: Builds the confirmation popup shown when the user has reset credits available. It prepares the “Use a reset” action and a safer default selection of “Cancel.”

**Data flow**: It receives the available reset count, creates a fresh unique idempotency key, and returns popup settings with a title, count summary, footer hint, a “Use a reset” item, and a “Cancel” item. Selecting “Use a reset” sends an app event carrying the unique key.

**Call relations**: This helper is used by `ChatWidget::finish_rate_limit_reset_credits_refresh` after the server says credits exist. It hands control back to the larger app by wiring the menu action to a consume-reset event.

*Call graph*: 4 external calls (default, new_v4, format!, vec!).


##### `ChatWidget::rate_limit_reset_message_params`  (lines 145–157)

```
fn rate_limit_reset_message_params(message: &str) -> SelectionViewParams
```

**Purpose**: Builds a simple informational popup for the rate-limit reset flow. It is used when there is nothing for the user to choose except closing the message.

**Data flow**: It takes a message string, places it in the popup subtitle, adds a single “Close” item, and returns the completed popup settings.

**Call relations**: Several finish functions use this helper when the flow ends with a plain explanation, such as no credits available, nothing to reset, a loading failure, or final success.

*Call graph*: 2 external calls (default, vec!).


##### `ChatWidget::show_rate_limit_reset_consuming_popup`  (lines 159–177)

```
fn show_rate_limit_reset_consuming_popup(&mut self) -> u64
```

**Purpose**: Shows a non-cancelable popup while the app is actively redeeming a reset credit. This prevents the user from starting another conflicting action while the reset is in progress.

**Data flow**: It clears any old hint, gets and stores a new request ID, creates a disabled “Using a reset...” popup, marks it as not cancelable, displays it, redraws the screen, and returns the request ID.

**Call relations**: This begins the redeem step after the user has chosen to use a reset. It uses `ChatWidget::take_next_rate_limit_reset_request_id` for tracking, and the matching result is later handled by `ChatWidget::finish_rate_limit_reset_consume`.

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

**Purpose**: Processes the server's answer after the user tries to redeem a reset. It shows success, explains why no reset happened, or offers a retry if the request failed.

**Data flow**: It receives the request ID, the idempotency key used for the redeem attempt, and either a server response or an error. If the ID is not current, it returns `false`. If the reset succeeded or was already redeemed, it clears the known credit count, switches to a success-and-refreshing popup, and returns `true`. If the server says there was nothing to reset or no credit, it clears the pending request, shows a message, and returns `false`. If there was an error, it clears the pending request and shows “Try again” and “Close”; retrying reuses the same idempotency key.

**Call relations**: This is the main decision point after `ChatWidget::show_rate_limit_reset_consuming_popup`. It uses `ChatWidget::replace_rate_limit_reset_popup` to update the visible popup, `ChatWidget::rate_limit_reset_success_loading_params` when a follow-up refresh is needed, and `ChatWidget::rate_limit_reset_message_params` for final explanatory messages.

*Call graph*: calls 1 internal fn (replace_rate_limit_reset_popup); 6 external calls (default, rate_limit_reset_message_params, rate_limit_reset_success_loading_params, matches!, unreachable!, vec!).


##### `ChatWidget::finish_post_consume_reset_credits_refresh`  (lines 247–270)

```
fn finish_post_consume_reset_credits_refresh(
        &mut self,
        request_id: u64,
        result: Result<RateLimitResetCreditsSummary, String>,
    ) -> bool
```

**Purpose**: Finishes the extra refresh that happens after a successful reset, so the user can see how many resets remain. Even if the refresh fails, it still tells the user that the reset happened.

**Data flow**: It receives a request ID and either a fresh reset-credit summary or an error. If the ID is stale, it returns `false`. If it matches, it clears the pending request, updates the stored count when available, builds a final success message, replaces the popup, and returns `true`.

**Call relations**: This follows the success path from `ChatWidget::finish_rate_limit_reset_consume`. It uses `ChatWidget::rate_limit_reset_message_params` to build the final closeable message and `ChatWidget::replace_rate_limit_reset_popup` to put that message on screen.

*Call graph*: calls 1 internal fn (replace_rate_limit_reset_popup); 2 external calls (rate_limit_reset_message_params, format!).


##### `ChatWidget::rate_limit_reset_success_loading_params`  (lines 272–285)

```
fn rate_limit_reset_success_loading_params() -> SelectionViewParams
```

**Purpose**: Builds the interim popup shown right after a reset succeeds while the app checks the remaining reset count. It tells the user that the important action worked and that a refresh is still underway.

**Data flow**: It creates popup settings with a success message, a disabled “Refreshing...” row, and cancellation turned off, then returns those settings.

**Call relations**: This helper is used by `ChatWidget::finish_rate_limit_reset_consume` when the server confirms the reset. It prepares the screen for the next step, which is handled by `ChatWidget::finish_post_consume_reset_credits_refresh`.

*Call graph*: 2 external calls (default, vec!).


##### `ChatWidget::replace_rate_limit_reset_popup`  (lines 287–294)

```
fn replace_rate_limit_reset_popup(&mut self, params: SelectionViewParams)
```

**Purpose**: Replaces the current rate-limit reset popup if it is still open. It is a small safety wrapper that redraws the screen only when something actually changed.

**Data flow**: It receives new popup settings, asks the bottom pane to replace the popup with the rate-limit reset view ID, and requests a redraw if the replacement happened.

**Call relations**: Both `ChatWidget::finish_rate_limit_reset_consume` and `ChatWidget::finish_post_consume_reset_credits_refresh` call this when a server response changes what the user should see next.

*Call graph*: called by 2 (finish_post_consume_reset_credits_refresh, finish_rate_limit_reset_consume).


##### `ChatWidget::start_rate_limit_reset_startup_check`  (lines 296–301)

```
fn start_rate_limit_reset_startup_check(&mut self) -> u64
```

**Purpose**: Starts a quiet startup check for reset credits. This is used to decide whether the chat should later show a helpful hint that resets are available.

**Data flow**: It clears any previous hint state, creates a new request ID, stores it as the pending hint request, and returns the ID so the server reply can be matched later.

**Call relations**: This begins the background hint flow during startup. It uses `ChatWidget::take_next_rate_limit_reset_request_id` for tracking, and the matching response is processed by `ChatWidget::finish_rate_limit_reset_hint_refresh`.

*Call graph*: calls 2 internal fn (clear_pending_rate_limit_reset_hint, take_next_rate_limit_reset_request_id).


##### `ChatWidget::finish_rate_limit_reset_hint_refresh`  (lines 303–323)

```
fn finish_rate_limit_reset_hint_refresh(
        &mut self,
        request_id: u64,
        result: Result<RateLimitResetCreditsSummary, String>,
    ) -> bool
```

**Purpose**: Finishes the startup reset-credit check and, when appropriate, creates a chat hint telling the user they have resets available. It avoids showing the hint for signed-out users or workspace accounts.

**Data flow**: It receives a request ID and either a reset-credit summary or an error. If the ID is not the pending hint request, it returns `false`. If it matches, it clears the pending hint request, checks whether the account should see hints, stores the available count on success, creates a hint when the count is positive, and returns whether the response was accepted.

**Call relations**: This is the response side of `ChatWidget::start_rate_limit_reset_startup_check`. When a useful positive count comes back, it hands off to `ChatWidget::set_rate_limit_reset_available_hint` to create the visible chat-history notice.

*Call graph*: calls 1 internal fn (set_rate_limit_reset_available_hint).


##### `ChatWidget::clear_pending_rate_limit_reset_requests`  (lines 325–331)

```
fn clear_pending_rate_limit_reset_requests(&mut self)
```

**Purpose**: Clears all in-progress rate-limit reset state and dismisses the reset popup. This is useful when the account or session state changes and old reset information should no longer be trusted.

**Data flow**: It removes the pending reset request ID, forgets the cached available credit count, clears any pending hint, and asks the bottom pane to close the rate-limit reset popup.

**Call relations**: This is the broad cleanup path. It uses `ChatWidget::clear_pending_rate_limit_reset_hint` so both normal popups and background hints are reset together.

*Call graph*: calls 1 internal fn (clear_pending_rate_limit_reset_hint).


##### `ChatWidget::clear_pending_rate_limit_reset_hint`  (lines 333–340)

```
fn clear_pending_rate_limit_reset_hint(&mut self)
```

**Purpose**: Removes any pending chat-history hint about available reset credits. If removing the hint changes what is displayed, it marks the chat cell as changed and redraws the screen.

**Data flow**: It clears the pending hint request ID and takes the stored hint out of the widget. If a hint was actually present, it bumps the display revision and requests a redraw.

**Call relations**: This cleanup helper is called before opening the usage menu, before showing reset loading or consuming popups, before startup checks, and during full reset cleanup. That keeps old hints from lingering after the user starts a more direct reset flow.

*Call graph*: called by 5 (clear_pending_rate_limit_reset_requests, open_usage_menu, show_rate_limit_reset_consuming_popup, show_rate_limit_reset_loading_popup, start_rate_limit_reset_startup_check).


##### `ChatWidget::pending_rate_limit_reset_hint`  (lines 342–344)

```
fn pending_rate_limit_reset_hint(&self) -> Option<&PlainHistoryCell>
```

**Purpose**: Returns the current reset-available hint without removing it. Other parts of the chat UI can use this to decide whether there is a hint ready to display.

**Data flow**: It reads the optional stored hint and returns a borrowed view of it if one exists. It does not change the widget.

**Call relations**: This is a read-only access point for the hint created by `ChatWidget::set_rate_limit_reset_available_hint`. It lets display code look at the hint without consuming it.


##### `ChatWidget::take_pending_rate_limit_reset_hint`  (lines 346–350)

```
fn take_pending_rate_limit_reset_hint(&mut self) -> Option<PlainHistoryCell>
```

**Purpose**: Removes and returns the pending reset-available hint. This is used when the hint is being moved into the visible chat history.

**Data flow**: It tries to take the stored hint. If none exists, it returns nothing. If one exists, it removes it, marks the active cell as changed, and returns the hint object.

**Call relations**: This is the consuming partner to `ChatWidget::pending_rate_limit_reset_hint`. After `ChatWidget::set_rate_limit_reset_available_hint` creates a hint, another part of the chat widget can call this to claim it for display.


##### `ChatWidget::set_rate_limit_reset_available_hint`  (lines 352–365)

```
fn set_rate_limit_reset_available_hint(&mut self, available_count: i64)
```

**Purpose**: Creates a friendly chat hint when the user has one or more reset credits available. The hint tells the user to run `/usage` if they want to use one.

**Data flow**: It receives an available count. If the count is zero or negative, it does nothing. Otherwise, it builds an informational history cell, stores it as the pending hint, bumps the display revision, and requests a redraw.

**Call relations**: This is called by `ChatWidget::finish_rate_limit_reset_hint_refresh` after a successful background check. It creates the hint that can later be read or taken by the chat display flow.

*Call graph*: called by 1 (finish_rate_limit_reset_hint_refresh); 2 external calls (format!, new_info_event).


##### `ChatWidget::take_next_rate_limit_reset_request_id`  (lines 367–373)

```
fn take_next_rate_limit_reset_request_id(&mut self) -> u64
```

**Purpose**: Provides the next tracking number for a rate-limit reset request. These numbers help the widget ignore late replies from older requests.

**Data flow**: It reads the current next request ID, increments the stored counter with wraparound behavior, and returns the original value as the ID for the new request.

**Call relations**: This helper is used whenever the file starts an async reset-related check: loading credits, consuming a reset, or doing the startup hint check. The returned ID is later compared by the corresponding finish function.

*Call graph*: called by 3 (show_rate_limit_reset_consuming_popup, show_rate_limit_reset_loading_popup, start_rate_limit_reset_startup_check).


##### `reset_label`  (lines 376–382)

```
fn reset_label(count: i64) -> &'static str
```

**Purpose**: Chooses the correct singular or plural label for reset credits. It keeps user-facing messages grammatically correct.

**Data flow**: It receives a count. If the count is exactly one, it returns “rate-limit reset”; otherwise it returns “rate-limit resets.”

**Call relations**: This small formatting helper supports the menu, confirmation popup, success message, and startup hint wherever the reset count is shown to the user.
