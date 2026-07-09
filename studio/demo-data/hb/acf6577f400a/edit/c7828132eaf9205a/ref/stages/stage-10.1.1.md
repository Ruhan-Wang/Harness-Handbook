# App-level event dispatch and thread routing  `stage-10.1.1`

This stage is the traffic-control center of the text user interface. It sits in the app’s main work loop. Its job is to take input from many places—keyboard shortcuts, server messages, and background tasks—and send each one to the right part of the app, especially the right conversation thread.

At the center, event_dispatch.rs is the main switchboard. It reads queued app events and decides what should happen next: update the screen, call the server, save settings, switch threads, or exit. app_event_sender.rs makes it easy for other UI code to submit those events and commands in a consistent way. app_command.rs defines that command language.

input.rs handles app-wide key presses before they reach the chat area, like global shortcuts or opening an external editor. frame_requester.rs asks for redraws without overloading the screen refresh rate.

On the server side, app_server_events.rs translates incoming server events into UI actions, while app_server_requests.rs keeps track of requests that need a later user answer. thread_routing.rs manages per-thread state, buffering and replaying events when the user switches threads. pending_interactive_replay.rs makes sure only still-unanswered prompts are replayed. background_requests.rs sends slow network or disk work off to helper tasks, then reports results back as app events.

## Files in this stage

### Event ingress and dispatch
These files define how app events enter the TUI and get routed into concrete app behavior and redraw scheduling.

### `tui/src/app_event_sender.rs`

`util` · `cross-cutting`

This file defines `AppEventSender`, a thin convenience wrapper around `tokio::sync::mpsc::UnboundedSender<AppEvent>`. Its main job is to centralize two behaviors that would otherwise be duplicated across widgets and handlers: converting common user actions into the right `AppEvent` shape, and recording inbound events to the session log before they enter the app loop.

The core method is `send`, which logs every non-`AppEvent::CodexOp` event via `session_log::log_inbound_app_event` and then attempts to enqueue it on the unbounded channel. Channel send failures are intentionally swallowed after emitting a `tracing::error!`, reflecting that the UI often cannot recover meaningfully once the receiver side is gone. The remaining methods are narrowly scoped helpers that package specific `AppCommand`s into either `AppEvent::CodexOp` or `AppEvent::SubmitThreadOp`, depending on whether the command targets the currently active thread or an explicit `ThreadId`.

A subtle but important invariant is the logging rule in `send`: raw app events are logged here, but `CodexOp` events are excluded because operation submission is logged at the point where the command is created. That avoids duplicate replay records while still preserving high-fidelity session reconstruction.

#### Function details

##### `AppEventSender::new`  (lines 28–30)

```
fn new(app_event_tx: UnboundedSender<AppEvent>) -> Self
```

**Purpose**: Constructs an `AppEventSender` from an existing unbounded app-event channel sender.

**Data flow**: It takes an `UnboundedSender<AppEvent>` and stores it in the `app_event_tx` field of a new `AppEventSender`, returning that wrapper by value. No side effects occur.

**Call relations**: This is the entry point used wherever code needs a typed event sender, including app startup and many tests/snapshots. Callers create the wrapper once and then use its helper methods instead of interacting with the raw channel directly.

*Call graph*: called by 345 (run, render_skill_load_warning_cells, accepted_model_migration_persists_target_default_reasoning_effort, auth_suggestion_with_reason_snapshot, declined_tool_suggestion_resolves_elicitation_decline, enable_suggestion_with_reason_snapshot, enable_tool_suggestion_resolves_elicitation_after_enable, generic_url_elicitation_confirmation_snapshot, generic_url_elicitation_resolves_without_connector_refresh, generic_url_elicitation_snapshot (+15 more)).


##### `AppEventSender::send`  (lines 34–43)

```
fn send(&self, event: AppEvent)
```

**Purpose**: Logs an inbound app event when appropriate and forwards it to the app loop channel, tolerating receiver shutdown.

**Data flow**: It accepts an `AppEvent`. If the event is not `AppEvent::CodexOp(_)`, it reads the event value to pass it to `session_log::log_inbound_app_event`. It then attempts `self.app_event_tx.send(event)`. On error, it writes a tracing error log and returns `()`. It does not propagate send failures.

**Call relations**: This is the common sink behind nearly every helper in this file and is also called directly by higher-level app code when emitting one-off events. It delegates to session logging first, then to the Tokio channel, and intentionally suppresses channel errors so callers do not need to handle them.

*Call graph*: calls 1 internal fn (log_inbound_app_event); called by 53 (handle_tui_event, send_world_writable_scan_failed, spawn_startup_thread_start, apply_accepted_model_migration, emit_project_config_warnings, emit_skill_load_warnings, emit_system_bwrap_warning, handle_model_migration_prompt_if_needed, compact, exec_approval (+15 more)); 3 external calls (send, matches!, error!).


##### `AppEventSender::interrupt`  (lines 45–47)

```
fn interrupt(&self)
```

**Purpose**: Submits an interrupt command for the active thread through the app event bus.

**Data flow**: It reads no external state beyond `self`, constructs `AppCommand::interrupt()`, wraps it in `AppEvent::CodexOp`, and forwards it through `send`. It returns `()`.

**Call relations**: This helper is invoked from keyboard handling paths such as Ctrl-C. It delegates all actual delivery and logging behavior to `send`, keeping key handlers free of event-construction details.

*Call graph*: calls 1 internal fn (send); called by 2 (handle_key_event, on_ctrl_c); 2 external calls (interrupt, CodexOp).


##### `AppEventSender::interrupt_and_restore_prompt_if_no_output`  (lines 49–53)

```
fn interrupt_and_restore_prompt_if_no_output(&self)
```

**Purpose**: Submits the specialized interrupt command that restores the composer prompt when the interrupted turn produced no visible output.

**Data flow**: It constructs `AppCommand::interrupt_and_restore_prompt_if_no_output()`, wraps it in `AppEvent::CodexOp`, and sends it via `send`. No state is mutated locally.

**Call relations**: This is used by interrupt flows that need rollback-to-composer semantics rather than a plain stop. It sits one layer above `send`, packaging the exact command variant expected by the app loop.

*Call graph*: calls 1 internal fn (send); called by 1 (interrupt); 2 external calls (interrupt_and_restore_prompt_if_no_output, CodexOp).


##### `AppEventSender::compact`  (lines 55–57)

```
fn compact(&self)
```

**Purpose**: Requests thread compaction through the standard app-command path.

**Data flow**: It creates `AppCommand::compact()`, wraps it as `AppEvent::CodexOp`, and enqueues it with `send`, returning `()`. No local state changes.

**Call relations**: This is a convenience wrapper for callers that want compaction without manually constructing the nested event and command types. It relies on `send` for logging and channel delivery.

*Call graph*: calls 1 internal fn (send); 2 external calls (compact, CodexOp).


##### `AppEventSender::set_thread_name`  (lines 59–61)

```
fn set_thread_name(&self, name: String)
```

**Purpose**: Packages a thread-renaming request as a codex operation event.

**Data flow**: It takes a `String` name, builds `AppCommand::set_thread_name(name)`, wraps it in `AppEvent::CodexOp`, and forwards it through `send`. Ownership of the name moves into the command.

**Call relations**: Used by UI flows that rename the current thread. It delegates the actual submission mechanics to `send` and the eventual RPC translation to downstream app-command handling.

*Call graph*: calls 1 internal fn (send); 2 external calls (set_thread_name, CodexOp).


##### `AppEventSender::review`  (lines 63–65)

```
fn review(&self, target: ReviewTarget)
```

**Purpose**: Starts a review operation for the given `ReviewTarget` on the active thread.

**Data flow**: It consumes a `ReviewTarget`, constructs `AppCommand::review(target)`, wraps it in `AppEvent::CodexOp`, and sends it. It returns `()`.

**Call relations**: This helper is used by review UI actions to enter the normal command-submission pipeline. It does not perform review logic itself; it only packages the request for the app loop.

*Call graph*: calls 1 internal fn (send); 2 external calls (review, CodexOp).


##### `AppEventSender::list_skills`  (lines 67–72)

```
fn list_skills(&self, cwds: Vec<PathBuf>, force_reload: bool)
```

**Purpose**: Requests a skills refresh/listing for one or more working directories, optionally forcing reload.

**Data flow**: It takes `cwds: Vec<PathBuf>` and `force_reload: bool`, builds `AppCommand::list_skills(cwds, force_reload)`, wraps it in `AppEvent::CodexOp`, and sends it. The vector is moved into the command.

**Call relations**: Called when UI flows need the app-command path to refresh visible skills state. It delegates event emission to `send` and leaves actual RPC execution to later app-server handling.

*Call graph*: calls 1 internal fn (send); called by 1 (close); 2 external calls (list_skills, CodexOp).


##### `AppEventSender::user_input_answer`  (lines 74–78)

```
fn user_input_answer(&self, id: String, response: ToolRequestUserInputResponse)
```

**Purpose**: Submits a response to a tool-request user-input prompt back to the active thread.

**Data flow**: It takes a prompt `id` and a `ToolRequestUserInputResponse`, constructs `AppCommand::user_input_answer(id, response)`, wraps it in `AppEvent::CodexOp`, and sends it. Ownership of both arguments moves into the command.

**Call relations**: Used by answer-submission paths for elicitation/user-input prompts. It packages the response into the same command pipeline as other active-thread operations.

*Call graph*: calls 1 internal fn (send); called by 2 (submit_answers, submit_empty_auto_resolution); 2 external calls (user_input_answer, CodexOp).


##### `AppEventSender::exec_approval`  (lines 80–90)

```
fn exec_approval(
        &self,
        thread_id: ThreadId,
        id: String,
        decision: CommandExecutionApprovalDecision,
    )
```

**Purpose**: Submits an execution-approval decision to a specific thread rather than whichever thread is currently focused.

**Data flow**: It takes `thread_id`, approval `id`, and a `CommandExecutionApprovalDecision`, constructs `AppCommand::exec_approval(id, None, decision)`, wraps that in `AppEvent::SubmitThreadOp { thread_id, op }`, and sends it. It returns `()`.

**Call relations**: This is called from execution-approval UI handlers. Unlike active-thread helpers, it targets an explicit thread via `SubmitThreadOp`, ensuring the decision reaches the correct thread even if focus changed before the user responded.

*Call graph*: calls 1 internal fn (send); called by 1 (handle_exec_decision); 1 external calls (exec_approval).


##### `AppEventSender::request_permissions_response`  (lines 92–102)

```
fn request_permissions_response(
        &self,
        thread_id: ThreadId,
        id: String,
        response: RequestPermissionsResponse,
    )
```

**Purpose**: Submits a permissions-request response to a specific thread.

**Data flow**: It accepts `thread_id`, request `id`, and a `RequestPermissionsResponse`, builds `AppCommand::request_permissions_response(id, response)`, wraps it in `AppEvent::SubmitThreadOp`, and sends it. No local state is modified.

**Call relations**: Used by permission-decision handlers when the response must be correlated with a particular thread. It delegates transport and logging to `send` while preserving explicit thread routing.

*Call graph*: calls 1 internal fn (send); called by 1 (handle_permissions_decision); 1 external calls (request_permissions_response).


##### `AppEventSender::patch_approval`  (lines 104–114)

```
fn patch_approval(
        &self,
        thread_id: ThreadId,
        id: String,
        decision: FileChangeApprovalDecision,
    )
```

**Purpose**: Submits a file-change approval decision for a specific thread.

**Data flow**: It takes `thread_id`, approval `id`, and a `FileChangeApprovalDecision`, constructs `AppCommand::patch_approval(id, decision)`, wraps it in `AppEvent::SubmitThreadOp`, and sends it. It returns `()`.

**Call relations**: This helper is used by patch-approval UI flows. Like other explicit-thread approval helpers, it ensures the decision is delivered to the originating thread regardless of current UI focus.

*Call graph*: calls 1 internal fn (send); called by 1 (handle_patch_decision); 1 external calls (patch_approval).


##### `AppEventSender::resolve_elicitation`  (lines 116–129)

```
fn resolve_elicitation(
        &self,
        thread_id: ThreadId,
        server_name: String,
        request_id: AppServerRequestId,
        decision: McpServerElicitationAction,
        content:
```

**Purpose**: Packages an MCP/server elicitation resolution, including optional structured content and metadata, for a specific thread.

**Data flow**: It takes `thread_id`, `server_name`, `request_id`, `decision`, optional JSON `content`, and optional JSON `meta`; constructs `AppCommand::resolve_elicitation(...)`; wraps it in `AppEvent::SubmitThreadOp`; and sends it. All owned inputs move into the command.

**Call relations**: Called by elicitation resolution paths, including explicit decisions, cancellation, and answer submission. It bridges UI responses into the thread-specific command pipeline so downstream app-server code can answer the pending server request.

*Call graph*: calls 1 internal fn (send); called by 4 (resolve_elicitation, handle_elicitation_decision, dispatch_cancel, submit_answers); 1 external calls (resolve_elicitation).


### `tui/src/tui/frame_requester.rs`

`orchestration` · `main loop`

This file provides the redraw scheduling mechanism used throughout the TUI. `FrameRequester` is the lightweight handle cloned by widgets and background tasks; internally it just owns an `mpsc::UnboundedSender<Instant>` carrying requested draw times. `FrameRequester::new` creates that channel, constructs a private `FrameScheduler`, spawns its `run` loop on Tokio, and returns the sender side. Immediate and delayed redraws are represented uniformly as absolute `Instant`s via `schedule_frame` and `schedule_frame_in`.

`FrameScheduler` owns the receiver, the broadcast sender used by the main event loop, and a `FrameRateLimiter`. Its `run` loop maintains `next_deadline: Option<Instant>`. Each iteration computes a sleep target: either the earliest pending deadline or a far-future sentinel (`ONE_YEAR`) when idle. Inside `tokio::select!`, incoming requests are clamped through the rate limiter and merged into `next_deadline` by taking the earlier of the existing and new deadlines. The scheduler intentionally does not emit immediately on receipt; instead it loops so multiple requests before the deadline collapse into one notification. When the sleep branch fires and a deadline was pending, it clears `next_deadline`, marks the emission time in the limiter, and sends a single `()` on the draw broadcast channel.

The tests cover immediate scheduling, delayed scheduling, coalescing of repeated or mixed requests, and the 120 FPS cap inherited from `FrameRateLimiter`.

#### Function details

##### `FrameRequester::new`  (lines 39–46)

```
fn new(draw_tx: broadcast::Sender<()>) -> Self
```

**Purpose**: Creates a frame-request handle and starts the background scheduler task that will emit draw notifications.

**Data flow**: Consumes a `broadcast::Sender<()>`, creates an unbounded MPSC channel of `Instant`, constructs `FrameScheduler::new(rx, draw_tx)`, spawns `scheduler.run()` on Tokio, and returns `FrameRequester { frame_schedule_tx: tx }`.

**Call relations**: Called during `Tui::new` and by tests. It is the public entrypoint that wires request producers to the scheduler actor.

*Call graph*: calls 1 internal fn (new); called by 9 (new, test_coalesces_mixed_immediate_and_delayed_requests, test_coalesces_multiple_requests_into_single_draw, test_limits_draw_notifications_to_120fps, test_multiple_delayed_requests_coalesce_to_earliest, test_rate_limit_clamps_early_delayed_requests, test_rate_limit_does_not_delay_future_draws, test_schedule_frame_immediate_triggers_once, test_schedule_frame_in_triggers_at_delay); 2 external calls (unbounded_channel, spawn).


##### `FrameRequester::schedule_frame`  (lines 49–51)

```
fn schedule_frame(&self)
```

**Purpose**: Requests a redraw as soon as possible.

**Data flow**: Captures `Instant::now()`, sends it on `frame_schedule_tx`, ignores send failure, and returns `()`. If the scheduler has exited, the request is silently dropped.

**Call relations**: Widely called across the TUI whenever state changes require repaint. The scheduler later coalesces and rate-limits these requests.

*Call graph*: called by 33 (handle_draw_size_change, pick_random_variant, schedule_next_frame, request_redraw, request_redraw, handle_key, select, set_highlight, back_to_summary, customize (+15 more)); 2 external calls (now, send).


##### `FrameRequester::schedule_frame_in`  (lines 54–56)

```
fn schedule_frame_in(&self, dur: Duration)
```

**Purpose**: Requests a redraw after a specified delay.

**Data flow**: Captures `Instant::now() + dur`, sends that absolute deadline on `frame_schedule_tx`, ignores send failure, and returns `()`. The delay is converted immediately into an `Instant`.

**Call relations**: Used by animations, delayed UI updates, and other code that wants a future repaint rather than an immediate one.

*Call graph*: called by 8 (handle_draw_size_change, schedule_next_frame, request_redraw_in, handle_paste_burst_tick, render, render_continue_in_browser, schedule_next_frame, render); 2 external calls (now, send).


##### `FrameRequester::test_dummy`  (lines 62–67)

```
fn test_dummy() -> Self
```

**Purpose**: Creates a no-op requester for tests that need a `FrameRequester` value without a running scheduler.

**Data flow**: Creates an unbounded channel, discards the receiver, stores the sender in `FrameRequester`, and returns it.

**Call relations**: Used by many unrelated tests elsewhere in the crate to satisfy dependencies on a frame requester without spawning async infrastructure.

*Call graph*: called by 135 (enqueue_primary_thread_session_replays_turns_before_initial_prompt_submit, height_shrink_schedules_resize_reflow, replace_chat_widget_reseeds_collab_agent_metadata_for_replay, composer_shown_after_denied_while_task_running, ctrl_c_cancels_history_search_without_clearing_draft_or_showing_quit_hint, ctrl_c_on_modal_consumes_without_showing_quit_hint, drain_pending_submission_state_clears_remote_image_urls, esc_interrupts_running_task_when_no_popup, esc_release_after_dismissing_agent_picker_does_not_interrupt_task, esc_routes_to_handle_key_event_when_requested (+15 more)); 1 external calls (unbounded_channel).


##### `FrameScheduler::new`  (lines 84–90)

```
fn new(receiver: mpsc::UnboundedReceiver<Instant>, draw_tx: broadcast::Sender<()>) -> Self
```

**Purpose**: Constructs the internal scheduler state from a request receiver and draw broadcast sender.

**Data flow**: Stores the provided `receiver` and `draw_tx`, initializes `rate_limiter` with `FrameRateLimiter::default()`, and returns `Self`.

**Call relations**: Called only by `FrameRequester::new` before the scheduler task is spawned.

*Call graph*: called by 1 (new); 1 external calls (default).


##### `FrameScheduler::run`  (lines 96–127)

```
async fn run(mut self)
```

**Purpose**: Runs the scheduler actor loop, merging requested draw times into one earliest pending deadline and emitting draw notifications when due.

**Data flow**: Owns `self` asynchronously. It keeps `next_deadline: Option<Instant>`, computes a sleep target from that or a one-year sentinel, pins a `sleep_until`, and `select!`s between incoming request times and the deadline. Received times are clamped via `rate_limiter.clamp_deadline` and merged into `next_deadline` using `min`; channel closure breaks the loop. When the deadline fires and one was pending, it clears `next_deadline`, records the emission with `mark_emitted(target)`, sends `()` on `draw_tx`, and continues.

**Call relations**: Spawned once per `FrameRequester::new`. It is the sole consumer of frame requests and the sole producer of draw broadcast notifications.

*Call graph*: 4 external calls (from_secs, pin!, select!, sleep_until).


##### `tests::test_schedule_frame_immediate_triggers_once`  (lines 137–157)

```
async fn test_schedule_frame_immediate_triggers_once()
```

**Purpose**: Tests that one immediate frame request produces exactly one draw notification.

**Data flow**: Creates a requester and draw receiver under paused Tokio time, schedules an immediate frame, advances time slightly, awaits one successful draw receive, then asserts a second receive times out.

**Call relations**: Covers the simplest scheduler path from immediate request to single emitted draw.

*Call graph*: calls 1 internal fn (new); 4 external calls (from_millis, assert!, channel, advance).


##### `tests::test_schedule_frame_in_triggers_at_delay`  (lines 160–183)

```
async fn test_schedule_frame_in_triggers_at_delay()
```

**Purpose**: Tests that delayed frame requests do not fire early and do fire once after the requested delay.

**Data flow**: Schedules a frame 50 ms in the future, advances time by 30 ms and asserts no draw arrives, then advances past the deadline, asserts one draw arrives, and confirms no second draw follows.

**Call relations**: Validates delayed scheduling behavior in `FrameScheduler::run`.

*Call graph*: calls 1 internal fn (new); 4 external calls (from_millis, assert!, channel, advance).


##### `tests::test_coalesces_multiple_requests_into_single_draw`  (lines 186–209)

```
async fn test_coalesces_multiple_requests_into_single_draw()
```

**Purpose**: Tests that several immediate requests before the deadline collapse into one draw notification.

**Data flow**: Schedules three immediate frames, advances time enough for processing, receives one draw successfully, and asserts no second draw arrives.

**Call relations**: Exercises the scheduler’s decision to defer emission until the sleep branch so multiple requests can merge.

*Call graph*: calls 1 internal fn (new); 4 external calls (from_millis, assert!, channel, advance).


##### `tests::test_coalesces_mixed_immediate_and_delayed_requests`  (lines 212–232)

```
async fn test_coalesces_mixed_immediate_and_delayed_requests()
```

**Purpose**: Tests that an immediate request and a later delayed request coalesce to the earlier immediate deadline.

**Data flow**: Schedules a delayed frame at 100 ms and then an immediate frame, advances time slightly, asserts one draw arrives promptly, and confirms no later second draw appears from the delayed request.

**Call relations**: Covers merging logic where `next_deadline` keeps the minimum of pending deadlines.

*Call graph*: calls 1 internal fn (new); 4 external calls (from_millis, assert!, channel, advance).


##### `tests::test_limits_draw_notifications_to_120fps`  (lines 235–263)

```
async fn test_limits_draw_notifications_to_120fps()
```

**Purpose**: Tests that back-to-back immediate requests are separated by at least `MIN_FRAME_INTERVAL`.

**Data flow**: Schedules and receives one immediate draw, schedules another immediate draw, advances time by only 1 ms and asserts no draw arrives, then advances by `MIN_FRAME_INTERVAL` and asserts the second draw arrives.

**Call relations**: Validates integration between `FrameScheduler` and `FrameRateLimiter`.

*Call graph*: calls 1 internal fn (new); 4 external calls (from_millis, assert!, channel, advance).


##### `tests::test_rate_limit_clamps_early_delayed_requests`  (lines 266–295)

```
async fn test_rate_limit_clamps_early_delayed_requests()
```

**Purpose**: Tests that even delayed requests are clamped forward when their requested time is still too soon after the last emitted frame.

**Data flow**: Emits one draw, schedules another for 1 ms later, advances half the minimum interval and asserts no draw, then advances enough to pass the clamp point and asserts the draw arrives.

**Call relations**: Covers the case where `schedule_frame_in` still lands inside the rate-limit window.

*Call graph*: calls 1 internal fn (new); 4 external calls (from_millis, assert!, channel, advance).


##### `tests::test_rate_limit_does_not_delay_future_draws`  (lines 298–324)

```
async fn test_rate_limit_does_not_delay_future_draws()
```

**Purpose**: Tests that requests already far enough in the future are not delayed beyond their own deadline by the rate limiter.

**Data flow**: Emits one immediate draw, schedules another 50 ms later, advances to just before 50 ms and asserts no draw, then advances to the deadline and asserts the draw arrives.

**Call relations**: Confirms `clamp_deadline` uses `max(requested, min_allowed)` rather than always adding the minimum interval.

*Call graph*: calls 1 internal fn (new); 4 external calls (from_millis, assert!, channel, advance).


##### `tests::test_multiple_delayed_requests_coalesce_to_earliest`  (lines 327–353)

```
async fn test_multiple_delayed_requests_coalesce_to_earliest()
```

**Purpose**: Tests that several delayed requests merge into a single draw at the earliest requested deadline.

**Data flow**: Schedules delayed draws at 100, 20, and 120 ms, advances to just before the earliest and asserts no draw, then advances past it, receives one draw, and confirms no later draws arrive from the superseded deadlines.

**Call relations**: Exercises the scheduler’s `cur.min(draw_at)` merge rule for multiple future requests.

*Call graph*: calls 1 internal fn (new); 4 external calls (from_millis, assert!, channel, advance).


### `tui/src/app/event_dispatch.rs`

`orchestration` · `main loop`

This file is the heart of the app’s single-threaded control flow. `App::handle_event` is an exhaustive async match over `AppEvent`, and nearly every subsystem feeds into it: session lifecycle (`NewSession`, `ClearUi`, resume picker, fork, archive/delete), transcript consolidation, overlays, plugin and marketplace flows, MCP inventory, rate limits and token usage, feedback, permissions and approvals, feature flags, memory settings, Windows sandbox setup, keymap editing, status line and terminal title persistence, syntax theme selection, and many more. The method’s role is intentionally orchestration-heavy: it rarely contains deep business logic itself, instead delegating to focused helpers and submodules while preserving ordering guarantees in the main loop.

Several branches encode subtle sequencing rules. `/clear` and clear-and-submit both clear terminal state, reset transcript state, and then start a fresh session. Plugin/hook enablement completion branches consult pending-write maps to coalesce rapid toggles and replay only the latest desired state. Rate-limit and token-activity completion branches may defer history insertion until no transient stream cell blocks usage-card insertion. Windows sandbox setup branches enforce requirement checks before setup, spawn blocking setup work, persist the resulting mode, and then patch live turn context and permission profile state. Persistence branches for model, personality, service tier, approvals reviewer, plan-mode effort, and keymap edits all update runtime state only after durable config writes succeed.

Outside the giant dispatcher, `apply_keymap_capture` and `apply_keymap_clear` compute edited keymap configs, validate them into a `RuntimeKeymap`, persist the corresponding config edit, and then update both app and widget state or surface conflicts/errors. `refresh_plugin_mentions_after_config_write` is a tiny helper that refreshes mention candidates and submits `reload_user_config`. `handle_exit_mode` implements the two exit policies, including a two-second timeout for graceful thread shutdown in `ShutdownFirst`. `archive_current_thread` and `delete_current_thread` enforce that a real, non-side thread exists before calling the corresponding app-server RPC and exiting on success.

#### Function details

##### `App::handle_event`  (lines 16–2111)

```
async fn handle_event(
        &mut self,
        tui: &mut tui::Tui,
        app_server: &mut AppServerSession,
        event: AppEvent,
    ) -> Result<AppRunControl>
```

**Purpose**: Dispatches every `AppEvent` variant to the appropriate app behavior and returns whether the main loop should continue or exit. It is the central coordinator for UI actions, background completions, config persistence, thread lifecycle, and app-server interactions.

**Data flow**: Consumes a mutable `App`, mutable `tui::Tui`, mutable `AppServerSession`, and one `AppEvent`. Depending on the variant it may mutate transcript state, chat-widget state, config, overlays, pending-write maps, thread/session state, or telemetry; call into app-server RPCs; launch background tasks; persist config edits; enqueue further `AppEvent`s; or return `AppRunControl::Exit(...)`. Most branches return `Ok(AppRunControl::Continue)` after side effects, while explicit exit/archive/delete/fatal branches return an exit control value.

**Call relations**: This method is invoked by the app’s main event loop for every queued event. It delegates specialized work to many helpers across the app, including background request launchers, config persistence helpers, thread/session handlers, and the local helpers `apply_keymap_capture`, `apply_keymap_clear`, `refresh_plugin_mentions_after_config_write`, `handle_exit_mode`, `archive_current_thread`, and `delete_current_thread`.

*Call graph*: calls 32 internal fn (from, status_line_items_edit, status_line_use_colors_edit, syntax_theme_edit, terminal_title_items_edit, active, from_config, apply_keymap_capture, apply_keymap_clear, archive_current_thread (+15 more)); 37 external calls (new, now, from, new, personality_label, reasoning_label_for, spawn_world_writable_scan, new, override_turn_context, new (+15 more)).


##### `App::apply_keymap_capture`  (lines 2113–2179)

```
async fn apply_keymap_capture(
        &mut self,
        context: String,
        action: String,
        key: String,
        intent: crate::app_event::KeymapEditIntent,
    )
```

**Purpose**: Applies a requested key binding edit, validates the resulting runtime keymap, persists the config change, and updates the keymap UI. It also handles conflict-resolution flows when the edited keymap cannot be materialized directly.

**Data flow**: Accepts keymap `context`, `action`, `key`, and edit `intent`. It computes an edit outcome via `crate::keymap_setup::keymap_with_edit`; on error it shows a chat-widget error and returns. If the outcome is unchanged it shows an info message and returns. Otherwise it attempts `RuntimeKeymap::from_config(&keymap_config)`; if that fails, it builds conflict-selection params and opens the selection view. If runtime validation succeeds, it persists the binding edit with `ConfigEditsBuilder`, and on success updates `self.config.tui_keymap`, `self.keymap`, the chat widget’s keymap state, returns to the keymap picker, and shows the success message; on persistence failure it logs and reports an error.

**Call relations**: Called only from `App::handle_event` for `AppEvent::KeymapCaptured`. It delegates edit computation to `keymap_setup` helpers and persistence to `ConfigEditsBuilder`.

*Call graph*: calls 4 internal fn (keymap_bindings_edit, from_config, build_keymap_conflict_params, keymap_with_edit); called by 1 (handle_event); 3 external calls (for_config, format!, error!).


##### `App::refresh_plugin_mentions_after_config_write`  (lines 2181–2184)

```
fn refresh_plugin_mentions_after_config_write(&mut self)
```

**Purpose**: Triggers the two runtime actions needed after plugin-related config changes: refresh mention candidates and reload user config in the active session.

**Data flow**: Calls `self.chat_widget.refresh_plugin_mentions()` and submits `AppCommand::reload_user_config()` through `self.chat_widget.submit_op(...)`. It returns no value.

**Call relations**: Used from multiple plugin/marketplace success branches inside `App::handle_event` after config-affecting operations complete.

*Call graph*: called by 1 (handle_event); 1 external calls (reload_user_config).


##### `App::apply_keymap_clear`  (lines 2186–2232)

```
async fn apply_keymap_clear(&mut self, context: String, action: String)
```

**Purpose**: Removes a custom key binding for one action, validates the resulting runtime keymap, persists the removal, and updates the keymap UI. It is the inverse of `apply_keymap_capture`.

**Data flow**: Accepts `context` and `action`, computes a new keymap config via `crate::keymap_setup::keymap_without_custom_binding`, validates it with `RuntimeKeymap::from_config`, persists a `keymap_binding_clear_edit` through `ConfigEditsBuilder`, and on success updates `self.config.tui_keymap`, `self.keymap`, the chat widget’s keymap state, returns to the keymap picker, and shows an info message. Any computation, validation, or persistence error is surfaced through the chat widget, with persistence failures also logged.

**Call relations**: Called only from `App::handle_event` for `AppEvent::KeymapCleared`.

*Call graph*: calls 3 internal fn (keymap_binding_clear_edit, from_config, keymap_without_custom_binding); called by 1 (handle_event); 3 external calls (for_config, format!, error!).


##### `App::handle_exit_mode`  (lines 2234–2269)

```
async fn handle_exit_mode(
        &mut self,
        app_server: &mut AppServerSession,
        mode: ExitMode,
    ) -> AppRunControl
```

**Purpose**: Implements the app’s two exit policies: immediate exit or best-effort graceful shutdown of the current thread before exiting. It also suppresses agent failover during an intentional shutdown-first exit.

**Data flow**: Accepts mutable `App`, mutable `AppServerSession`, and an `ExitMode`. For `ShutdownFirst`, it records `pending_shutdown_exit_thread_id` from the active/chat-widget thread, waits up to `SHUTDOWN_FIRST_EXIT_TIMEOUT` for `shutdown_current_thread(app_server)` if a thread exists, logs a warning on timeout, clears the pending shutdown marker, and returns `AppRunControl::Exit(ExitReason::UserRequested)`. For `Immediate`, it clears the marker and returns the same exit reason without waiting.

**Call relations**: Called from `App::handle_event` for `AppEvent::Exit` and after successful logout. It delegates the actual graceful shutdown to `shutdown_current_thread` elsewhere in the app.

*Call graph*: called by 1 (handle_event); 3 external calls (timeout, warn!, Exit).


##### `App::archive_current_thread`  (lines 2271–2296)

```
async fn archive_current_thread(
        &mut self,
        app_server: &mut AppServerSession,
    ) -> AppRunControl
```

**Purpose**: Archives the current thread through the app server and exits the app on success. It rejects the operation when no thread exists or when the user is in a side conversation.

**Data flow**: Determines the current thread ID from `active_thread_id` or `chat_widget.thread_id()`. If absent, it adds an error message and returns `Continue`. If the thread is a side thread, it adds a side-conversation-specific error and returns `Continue`. Otherwise it awaits `app_server.thread_archive(thread_id)` and returns `Exit(UserRequested)` on success or reports `Failed to archive current thread: {err}` and returns `Continue` on failure.

**Call relations**: Called from `App::handle_event` for `AppEvent::ArchiveCurrentThread`.

*Call graph*: calls 1 internal fn (thread_archive); called by 1 (handle_event); 2 external calls (format!, Exit).


##### `App::delete_current_thread`  (lines 2298–2323)

```
async fn delete_current_thread(
        &mut self,
        app_server: &mut AppServerSession,
    ) -> AppRunControl
```

**Purpose**: Deletes the current thread through the app server and exits the app on success. Like archiving, it is unavailable before a thread exists and inside side conversations.

**Data flow**: Finds the current thread ID from `active_thread_id` or `chat_widget.thread_id()`. If none exists, it reports that a thread must start first; if the thread is a side conversation, it reports that `/delete` is unavailable there. Otherwise it awaits `app_server.thread_delete(thread_id)` and returns `Exit(UserRequested)` on success or reports `Failed to delete current thread: {err}` and returns `Continue` on failure.

**Call relations**: Called from `App::handle_event` for `AppEvent::DeleteCurrentThread`.

*Call graph*: calls 1 internal fn (thread_delete); called by 1 (handle_event); 2 external calls (format!, Exit).


### Global input and command vocabulary
These files describe the app-wide command language and the top-level keyboard handling that turns user input into those actions.

### `tui/src/app_command.rs`

`data_model` · `cross-cutting command construction and dispatch`

This file is primarily a typed command model. `AppCommand` is a large serialized enum spanning user-turn submission, interrupt behavior, approval responses, MCP elicitation resolution, permission responses, thread rollback, review start, thread naming, shell commands, config reload, and context overrides. The `UserTurn` and `OverrideTurnContext` variants carry the richest payloads: cwd, approval policy, optional reviewer/profile overrides, model, reasoning effort/summary, service tier, collaboration mode, personality, and optional JSON schema for final output. `InterruptBehavior` is a small companion enum that distinguishes a normal interrupt from one that should restore the prompt if no output was produced. The impl block is intentionally thin: each method is a constructor that returns a specific variant with the right field defaults, such as `user_turn` forcing `approvals_reviewer: None` and `thread_rollback` wrapping a `u32` count. The only behavioral helper is `is_review`, which pattern-matches the enum to identify review commands. Finally, `impl From<&AppCommand> for AppCommand` clones a borrowed command into an owned one, supporting generic APIs elsewhere that accept `Into<AppCommand>` for replay bookkeeping. This file contains almost no control flow; its value is in centralizing the exact shape of commands that thread routing and replay logic understand.

#### Function details

##### `AppCommand::interrupt`  (lines 114–118)

```
fn interrupt() -> Self
```

**Purpose**: Constructs the standard interrupt command. This variant requests interruption without any prompt-restoration special case.

**Data flow**: It takes no arguments and returns `AppCommand::Interrupt { behavior: InterruptBehavior::Default }`.

**Call relations**: Used by UI code that wants to stop the current turn through the normal interrupt path.


##### `AppCommand::interrupt_and_restore_prompt_if_no_output`  (lines 120–124)

```
fn interrupt_and_restore_prompt_if_no_output() -> Self
```

**Purpose**: Constructs an interrupt command that asks downstream logic to restore the prompt if the interrupted turn produced no output. This supports a more forgiving UX for early interruptions.

**Data flow**: It takes no arguments and returns `AppCommand::Interrupt { behavior: InterruptBehavior::RestorePromptIfNoOutput }`.

**Call relations**: Used by interrupt flows that need the alternate post-interrupt prompt behavior.


##### `AppCommand::clean_background_terminals`  (lines 126–128)

```
fn clean_background_terminals() -> Self
```

**Purpose**: Constructs the command that asks the backend to clean background terminals for the current thread. It carries no additional payload.

**Data flow**: It returns the unit-like variant `AppCommand::CleanBackgroundTerminals`.

**Call relations**: Submitted through thread-routing command dispatch when the user invokes terminal cleanup.


##### `AppCommand::run_user_shell_command`  (lines 130–132)

```
fn run_user_shell_command(command: String) -> Self
```

**Purpose**: Constructs a command to run a user-specified shell command in the current thread context. The payload is the raw command string.

**Data flow**: It takes a `String` and returns `AppCommand::RunUserShellCommand { command }`.

**Call relations**: Used by shell-command UI actions before thread-routing maps it to `thread_shell_command` RPC.


##### `AppCommand::user_turn`  (lines 135–162)

```
fn user_turn(
        items: Vec<UserInput>,
        cwd: PathBuf,
        approval_policy: AskForApproval,
        active_permission_profile: Option<ActivePermissionProfile>,
        model: String,
```

**Purpose**: Constructs a user-turn submission command with all turn-start parameters except an explicit approvals reviewer. It is the main command used for sending prompt/input items to the backend.

**Data flow**: It takes `items`, `cwd`, `approval_policy`, optional `active_permission_profile`, `model`, optional `effort`, optional `summary`, optional nested `service_tier`, optional final-output JSON schema, optional `collaboration_mode`, and optional `personality`. It returns `AppCommand::UserTurn` with those fields plus `approvals_reviewer: None`.

**Call relations**: Created by chat submission paths and later consumed by thread-routing logic, which may steer an active turn or start a new one.


##### `AppCommand::override_turn_context`  (lines 165–193)

```
fn override_turn_context(
        cwd: Option<PathBuf>,
        approval_policy: Option<AskForApproval>,
        approvals_reviewer: Option<ApprovalsReviewer>,
        permission_profile: Option<Permi
```

**Purpose**: Constructs a command that overrides thread/turn context settings such as cwd, approvals, permissions, model, and collaboration settings. This packages a broad set of optional overrides into one variant.

**Data flow**: It takes optional values for cwd, approval policy, approvals reviewer, permission profile, active permission profile, Windows sandbox level, model, nested optional effort, summary, nested optional service tier, collaboration mode, and personality, and returns `AppCommand::OverrideTurnContext` containing those exact fields.

**Call relations**: Used by settings/context UI flows and later translated by thread-routing into a thread-settings update RPC.


##### `AppCommand::exec_approval`  (lines 195–205)

```
fn exec_approval(
        id: String,
        turn_id: Option<String>,
        decision: CommandExecutionApprovalDecision,
    ) -> Self
```

**Purpose**: Constructs a command that answers a command-execution approval request. It carries the approval id, optional turn id, and chosen decision.

**Data flow**: It takes `id`, `turn_id`, and `decision`, and returns `AppCommand::ExecApproval { id, turn_id, decision }`.

**Call relations**: Used when the user approves or denies an execution request; thread-routing may resolve it against a pending app-server request.


##### `AppCommand::patch_approval`  (lines 207–209)

```
fn patch_approval(id: String, decision: FileChangeApprovalDecision) -> Self
```

**Purpose**: Constructs a command that answers a file-change approval request. The payload is the item id and chosen patch decision.

**Data flow**: It takes `id` and `decision` and returns `AppCommand::PatchApproval { id, decision }`.

**Call relations**: Used by patch approval UI and later consumed by request-resolution logic.


##### `AppCommand::resolve_elicitation`  (lines 211–225)

```
fn resolve_elicitation(
        server_name: String,
        request_id: AppServerRequestId,
        decision: McpServerElicitationAction,
        content: Option<Value>,
        meta: Option<Value>,
```

**Purpose**: Constructs a command that resolves an MCP server elicitation request. It carries server identity, request id, decision, and optional structured content/meta payloads.

**Data flow**: It takes `server_name`, `request_id`, `decision`, optional `content`, and optional `meta`, and returns `AppCommand::ResolveElicitation { ... }`.

**Call relations**: Used by MCP elicitation UI and by auto-decline paths for unsupported URL elicitation requests.


##### `AppCommand::user_input_answer`  (lines 227–229)

```
fn user_input_answer(id: String, response: ToolRequestUserInputResponse) -> Self
```

**Purpose**: Constructs a command that answers a tool/user-input request. The payload is the request id and typed response object.

**Data flow**: It takes `id` and `response` and returns `AppCommand::UserInputAnswer { id, response }`.

**Call relations**: Used by interactive request handling when the user responds to a tool's input prompt.


##### `AppCommand::request_permissions_response`  (lines 231–236)

```
fn request_permissions_response(
        id: String,
        response: RequestPermissionsResponse,
    ) -> Self
```

**Purpose**: Constructs a command that answers a permissions request. It packages the request id and the chosen permission response.

**Data flow**: It takes `id` and `response` and returns `AppCommand::RequestPermissionsResponse { id, response }`.

**Call relations**: Used by permissions approval UI before request-resolution logic sends the answer to the backend.


##### `AppCommand::reload_user_config`  (lines 238–240)

```
fn reload_user_config() -> Self
```

**Purpose**: Constructs the command that asks the backend to reload user configuration. It has no payload.

**Data flow**: It returns the unit-like variant `AppCommand::ReloadUserConfig`.

**Call relations**: Submitted through thread-routing, which maps it to `reload_user_config()` on the app server.


##### `AppCommand::list_skills`  (lines 242–244)

```
fn list_skills(cwds: Vec<PathBuf>, force_reload: bool) -> Self
```

**Purpose**: Constructs a command to list or refresh skills for one or more working directories. It carries the cwd list and a force-reload flag.

**Data flow**: It takes `cwds: Vec<PathBuf>` and `force_reload: bool`, and returns `AppCommand::ListSkills { cwds, force_reload }`.

**Call relations**: Used by skills-refresh UI and later dispatched to the app server's skills-list RPC.


##### `AppCommand::compact`  (lines 246–248)

```
fn compact() -> Self
```

**Purpose**: Constructs the command that starts thread compaction. It carries no additional data.

**Data flow**: It returns `AppCommand::Compact`.

**Call relations**: Used by compaction UI and dispatched by thread-routing to `thread_compact_start`.


##### `AppCommand::set_thread_name`  (lines 250–252)

```
fn set_thread_name(name: String) -> Self
```

**Purpose**: Constructs a command to rename the current thread. The payload is the new thread name.

**Data flow**: It takes `name: String` and returns `AppCommand::SetThreadName { name }`.

**Call relations**: Used by thread-renaming UI before thread-routing maps it to `thread_set_name`.


##### `AppCommand::shutdown`  (lines 255–257)

```
fn shutdown() -> Self
```

**Purpose**: Constructs the shutdown command variant. This is currently marked dead-code tolerant but remains part of the command model.

**Data flow**: It takes no arguments and returns `AppCommand::Shutdown`.

**Call relations**: Available for shutdown flows even if not currently exercised in all builds.


##### `AppCommand::thread_rollback`  (lines 259–261)

```
fn thread_rollback(num_turns: u32) -> Self
```

**Purpose**: Constructs a rollback command targeting the last `num_turns` user turns. This is the command emitted by backtrack logic.

**Data flow**: It takes `num_turns: u32` and returns `AppCommand::ThreadRollback { num_turns }`.

**Call relations**: Used by backtrack and cancelled-turn edit flows, then dispatched by thread-routing to the rollback RPC.


##### `AppCommand::review`  (lines 263–265)

```
fn review(target: ReviewTarget) -> Self
```

**Purpose**: Constructs a command to start a review thread for a given target. The payload is the backend `ReviewTarget`.

**Data flow**: It takes `target` and returns `AppCommand::Review { target }`.

**Call relations**: Used by review-start UI and later dispatched to `review_start` in thread-routing.


##### `AppCommand::approve_guardian_denied_action`  (lines 267–269)

```
fn approve_guardian_denied_action(event: GuardianAssessmentEvent) -> Self
```

**Purpose**: Constructs a command that approves a previously guardian-denied action. The payload is the recorded guardian assessment event.

**Data flow**: It takes `event: GuardianAssessmentEvent` and returns `AppCommand::ApproveGuardianDeniedAction { event }`.

**Call relations**: Used by guardian-approval UI and dispatched by thread-routing to the corresponding app-server RPC.


##### `AppCommand::is_review`  (lines 271–273)

```
fn is_review(&self) -> bool
```

**Purpose**: Reports whether a command is the `Review` variant. This is the only behavioral predicate on the command enum.

**Data flow**: It pattern-matches `self` against `Self::Review { .. }` and returns the resulting boolean.

**Call relations**: Used by callers that need to special-case review commands without destructuring the full enum.

*Call graph*: 1 external calls (matches!).


##### `AppCommand::from`  (lines 277–279)

```
fn from(value: &AppCommand) -> Self
```

**Purpose**: Clones a borrowed `AppCommand` into an owned one for APIs that accept `Into<AppCommand>`. This supports generic replay bookkeeping helpers.

**Data flow**: It takes `&AppCommand`, clones it, and returns the owned `AppCommand`.

**Call relations**: Used implicitly by generic code such as thread-event replay bookkeeping that accepts borrowed or owned commands interchangeably.

*Call graph*: 1 external calls (clone).


### `tui/src/app/input.rs`

`orchestration` · `main loop request handling for keyboard events and UI mode transitions`

This module extends `App` with the global input policy that coordinates terminal state, overlays, side conversations, and composer editing. The largest routine, `handle_key_event`, first reserves certain key combinations for agent navigation and side-return shortcuts when no overlay or modal is active and the composer is empty, deliberately avoiding stealing Option/Alt word-motion keys from text editing on terminals without enhanced keyboard reporting. It then gates app-level shortcuts behind `app_keymap_shortcuts_available`, which requires both `overlay.is_none()` and `chat_widget.no_modal_or_popup_active()`. From there it toggles vim mode, fast mode, and raw output; opens the transcript overlay by entering the alternate screen and constructing `Overlay::new_transcript`; and requests external-editor launch only when the bottom pane is free and the editor state is `Closed`.

External editor support is split into request, launch, and reset phases. Launch resolves `$VISUAL`/`$EDITOR`, temporarily restores terminal state with `tui.with_restored`, seeds the editor with pending composer text, trims trailing whitespace from the edited result, and reports failures into history. Esc handling is nuanced: in normal backtrack mode with an empty composer it primes or advances backtracking, but in side conversations it instead emits `SIDE_EDIT_PREVIOUS_UNAVAILABLE_MESSAGE`; otherwise Esc is forwarded to the widget so modals, popups, or vim insert mode can consume it. Ctrl-L clearing also resets app UI state and queues header redraws after a successful terminal clear. A small test confirms that opening the keymap debug view disables these app-level shortcuts.

#### Function details

##### `App::launch_external_editor`  (lines 10–54)

```
async fn launch_external_editor(&mut self, tui: &mut tui::Tui)
```

**Purpose**: Runs the configured external editor against the current composer draft and applies the edited text back into the chat widget. It also reports missing-editor and launch failures as history error events and always restores the editor UI state afterward.

**Data flow**: Reads editor configuration via `external_editor::resolve_editor_command`, current draft text via `chat_widget.composer_text_with_pending`, and terminal restoration support from `tui`. On success it invokes `external_editor::run_editor` inside `tui.with_restored(tui::RestoreMode::KeepRaw, ...)`, trims trailing whitespace from the returned text, and writes it back with `chat_widget.apply_external_edit`. On failure it appends a `history_cell::new_error_event` to chat history. In all early-return and post-run paths it calls `reset_external_editor_state` and schedules a frame through `tui.frame_requester()`.

**Call relations**: Called after the app has already entered the requested external-editor state elsewhere in the app flow. It delegates command resolution and editor execution to the external-editor subsystem, then hands the resulting text or error back to `chat_widget`; `reset_external_editor_state` is its cleanup step regardless of outcome.

*Call graph*: calls 2 internal fn (reset_external_editor_state, resolve_editor_command); 4 external calls (frame_requester, with_restored, format!, new_error_event).


##### `App::request_external_editor_launch`  (lines 56–64)

```
fn request_external_editor_launch(&mut self, tui: &mut tui::Tui)
```

**Purpose**: Marks the external editor as requested and updates the footer hint so the UI reflects the pending launch. It does not actually spawn the editor.

**Data flow**: Mutates `chat_widget` by setting `ExternalEditorState::Requested` and installing a footer hint override containing `EXTERNAL_EDITOR_HINT`, then schedules a redraw through `tui.frame_requester().schedule_frame()`. It returns no value.

**Call relations**: Invoked from `App::handle_key_event` when the external-editor keybinding is pressed and the app is in a state where launching is allowed. It prepares visible UI state so a later async phase can perform the actual editor launch.

*Call graph*: called by 1 (handle_key_event); 2 external calls (frame_requester, vec!).


##### `App::reset_external_editor_state`  (lines 66–71)

```
fn reset_external_editor_state(&mut self, tui: &mut tui::Tui)
```

**Purpose**: Returns the external-editor UI state to normal after a launch attempt completes or aborts. It clears both the state flag and the temporary footer hint.

**Data flow**: Writes `ExternalEditorState::Closed` into `chat_widget`, removes the footer hint override by passing `None`, and schedules a frame via the TUI frame requester. It has no return value.

**Call relations**: Used by `App::launch_external_editor` on all completion paths, including missing-editor and runtime-error cases. It is the common cleanup routine that restores the normal bottom-pane presentation.

*Call graph*: called by 1 (launch_external_editor); 1 external calls (frame_requester).


##### `App::apply_raw_output_mode`  (lines 73–90)

```
fn apply_raw_output_mode(
        &mut self,
        tui: &mut tui::Tui,
        enabled: bool,
        notify: bool,
    )
```

**Purpose**: Toggles raw-output transcript rendering and immediately reflows the transcript so the visible history matches the new mode. It optionally emits the widget-level notification associated with the toggle.

**Data flow**: Consumes `enabled` and `notify` flags, updates raw-output mode through either `chat_widget.set_raw_output_mode_and_notify` or `chat_widget.set_raw_output_mode`, then calls `self.reflow_transcript_now(tui)`. If reflow fails it logs a warning and appends an error message to the chat widget; regardless, it schedules a frame. It returns nothing.

**Call relations**: Called from `App::handle_key_event` when the raw-output keybinding is pressed. It bridges a simple keybinding into both widget state mutation and transcript layout recomputation.

*Call graph*: called by 1 (handle_key_event); 3 external calls (frame_requester, format!, warn!).


##### `App::handle_key_event`  (lines 92–255)

```
async fn handle_key_event(
        &mut self,
        tui: &mut tui::Tui,
        app_server: &mut AppServerSession,
        key_event: KeyEvent,
    )
```

**Purpose**: Implements the app-wide keyboard dispatch tree, deciding which keys trigger global actions and which should be forwarded to the chat widget. It encodes precedence rules for agent switching, side-return, overlays, backtracking, terminal clearing, and ordinary text input.

**Data flow**: Reads `overlay`, `enhanced_keys_supported`, composer contents, modal/popup state, keymap bindings, backtrack state, and various chat-widget capability predicates. Depending on the key event, it may asynchronously fetch adjacent thread IDs and switch agents, return from a side conversation, toggle vim/fast/raw-output modes, enter the transcript overlay after `tui.enter_alt_screen()`, request external-editor launch, clear terminal UI and reset app state, confirm a primed backtrack selection, or forward the event to `chat_widget.handle_key_event`. It mutates app fields such as `overlay` and backtrack state, updates widget state, may log warnings and add error messages, and schedules redraws when UI changes occur.

**Call relations**: This is the central keyboard entrypoint used by the app event loop. It calls helper predicates like `app_keymap_shortcuts_available`, `should_handle_backtrack_esc`, and `should_reject_side_backtrack_esc` to keep the branching readable, and delegates concrete actions to methods such as `apply_raw_output_mode`, `request_external_editor_launch`, `reject_side_backtrack_esc`, transcript overlay construction, and chat-widget key handling.

*Call graph*: calls 7 internal fn (app_keymap_shortcuts_available, apply_raw_output_mode, reject_side_backtrack_esc, request_external_editor_launch, should_handle_backtrack_esc, should_reject_side_backtrack_esc, new_transcript); 5 external calls (enter_alt_screen, frame_requester, format!, matches!, warn!).


##### `App::should_handle_backtrack_esc`  (lines 257–262)

```
fn should_handle_backtrack_esc(&self, key_event: KeyEvent) -> bool
```

**Purpose**: Determines whether an Esc key event should be interpreted as main-thread backtrack priming/advancement instead of being passed through. The predicate is intentionally strict so Esc keeps its normal meaning in side conversations and vim insert mode.

**Data flow**: Reads chat-widget state: whether a side conversation is active, whether the widget is in normal backtrack mode, whether the composer is empty, and whether vim insert mode wants to consume this Esc. It returns a boolean and mutates nothing.

**Call relations**: Called from `App::handle_key_event` inside the Esc-specific branch. It acts as the gate before `handle_backtrack_esc_key` is allowed to run.

*Call graph*: called by 1 (handle_key_event).


##### `App::should_reject_side_backtrack_esc`  (lines 264–269)

```
fn should_reject_side_backtrack_esc(&self, key_event: KeyEvent) -> bool
```

**Purpose**: Determines whether Esc should explicitly reject backtrack behavior in a side conversation and show the unavailable message. It mirrors the main backtrack predicate but requires side-conversation activity.

**Data flow**: Reads side-conversation status, normal backtrack mode, composer emptiness, and vim insert-mode Esc handling from `chat_widget`, then returns `true` only when all conditions indicate a side-edit backtrack attempt should be rejected. It writes no state.

**Call relations**: Used by `App::handle_key_event` after `should_handle_backtrack_esc` fails in the Esc branch. A true result causes `reject_side_backtrack_esc` to run instead of forwarding Esc to the widget.

*Call graph*: called by 1 (handle_key_event).


##### `App::reject_side_backtrack_esc`  (lines 271–275)

```
fn reject_side_backtrack_esc(&mut self)
```

**Purpose**: Cancels any primed backtrack state and emits the fixed error message explaining that editing previous turns is unavailable from a side conversation. It provides explicit user feedback instead of silently ignoring Esc.

**Data flow**: Mutates app backtrack state via `reset_backtrack_state` and appends `SIDE_EDIT_PREVIOUS_UNAVAILABLE_MESSAGE.to_string()` to the chat widget's error messages. It returns no value.

**Call relations**: Called only from `App::handle_key_event` when Esc is pressed in a side conversation under backtrack-eligible conditions. It is the side-conversation rejection path paired with `should_reject_side_backtrack_esc`.

*Call graph*: called by 1 (handle_key_event).


##### `App::app_keymap_shortcuts_available`  (lines 277–279)

```
fn app_keymap_shortcuts_available(&self) -> bool
```

**Purpose**: Reports whether app-level keybindings should currently be active. It disables them whenever an overlay, modal, or popup would make global shortcuts unsafe or confusing.

**Data flow**: Reads `self.overlay` and `chat_widget.no_modal_or_popup_active()` and returns a boolean. It has no side effects.

**Call relations**: Queried by `App::handle_key_event` before processing most global shortcuts. The test module also calls it directly to verify that opening the keymap debug view suppresses app-level bindings.

*Call graph*: called by 1 (handle_key_event).


##### `App::refresh_status_line`  (lines 281–283)

```
fn refresh_status_line(&mut self)
```

**Purpose**: Forwards a status-line refresh request to the chat widget. It exists as a narrow app-level wrapper.

**Data flow**: Calls `self.chat_widget.refresh_status_line()` and returns unit. No other state is read or written here.

**Call relations**: Used by higher-level app flow outside this file when the status line needs recomputation. It delegates all actual work to the widget.


##### `tests::app_keymap_shortcuts_are_disabled_while_keymap_view_is_active`  (lines 291–299)

```
async fn app_keymap_shortcuts_are_disabled_while_keymap_view_is_active()
```

**Purpose**: Verifies that opening the keymap debug view disables app-level shortcut handling. This protects the invariant that modal/keymap UI owns keyboard input while visible.

**Data flow**: Builds a test app with `make_test_app().await`, asserts that `app_keymap_shortcuts_available()` is initially true, clones the app keymap, opens the keymap debug view on `chat_widget`, and asserts the predicate becomes false. It mutates only the test-local app instance.

**Call relations**: Run by the async Tokio test harness. It directly exercises the helper predicate rather than going through full key dispatch, isolating the shortcut-availability rule.

*Call graph*: calls 1 internal fn (make_test_app); 1 external calls (assert!).


### App-server event and request handling
These files bridge protocol-level app-server traffic into TUI-managed events, pending approvals, and serialized user responses.

### `tui/src/app/app_server_events.rs`

`orchestration` · `main loop`

This file implements the top-level app-server event handlers on `App`. `refresh_mcp_startup_expected_servers_from_config` derives the list of enabled MCP server names from `self.config.mcp_servers` and pushes that expectation into the chat widget, so startup progress can be interpreted against current config. `handle_app_server_event` is the outer dispatcher for `AppServerEvent`: lag notifications trigger a warning plus MCP startup recovery, server notifications and requests are delegated to dedicated async handlers, and disconnection both surfaces an error in the UI and emits `AppEvent::FatalExitRequest`.

`handle_server_notification_event` first intercepts several notification types with app-wide side effects before any thread routing occurs. It resolves pending app-server requests when `ServerRequestResolved` arrives, refreshes MCP startup expectations on `McpServerStatusUpdated`, updates rolling rate-limit/account display state, and performs a multi-step config/plugin refresh after `ExternalAgentConfigImportCompleted`—including disk reload, plugin mention refresh, `reload_user_config`, plugin list fetch, and optional completion messaging. `AppListUpdated` is also consumed directly into a `ConnectorsSnapshot`.

All remaining notifications are classified by `server_notification_thread_target`. Thread-targeted notifications are enqueued either to the primary thread or a side thread depending on `self.primary_thread_id`; invalid IDs are logged and dropped; app-scoped MCP startup notices are currently ignored with a debug log; and global notifications are handed directly to `chat_widget.handle_server_notification`. `handle_server_request_event` mirrors this structure for requests: it first records or rejects unsupported requests via `pending_app_server_requests.note_server_request`, then extracts a thread ID with `server_request_thread_id`, warns on threadless requests, and enqueues the request to the primary or side-thread queue.

#### Function details

##### `App::refresh_mcp_startup_expected_servers_from_config`  (lines 18–28)

```
fn refresh_mcp_startup_expected_servers_from_config(&mut self)
```

**Purpose**: Recomputes which MCP servers should be considered expected during startup based on the current config. It keeps the chat widget’s startup-progress UI aligned with enabled server definitions.

**Data flow**: Reads `self.config.mcp_servers.get()`, filters entries whose `enabled` flag is true, collects their names into `Vec<String>`, and passes that vector to `self.chat_widget.set_mcp_startup_expected_servers`. It returns no value and updates only widget state.

**Call relations**: This helper is called when the app-server event stream lags and when MCP status notifications arrive, so startup expectations are refreshed whenever config or event ordering may have changed.

*Call graph*: called by 2 (handle_app_server_event, handle_server_notification_event).


##### `App::handle_app_server_event`  (lines 30–58)

```
async fn handle_app_server_event(
        &mut self,
        app_server_client: &AppServerSession,
        event: AppServerEvent,
    )
```

**Purpose**: Acts as the outer dispatcher for all `AppServerEvent` values arriving from the app-server session. It translates transport-level events into app actions, warnings, and follow-up handlers.

**Data flow**: Consumes an `AppServerEvent` plus references to the current `AppServerSession`. For `Lagged`, it logs the skipped count, refreshes expected MCP servers, and tells the chat widget to finish startup after lag; for `ServerNotification` and `ServerRequest`, it awaits the corresponding internal handler; for `Disconnected`, it logs, adds an error message, and sends `AppEvent::FatalExitRequest(message)` through `app_event_tx`.

**Call relations**: This method is invoked by the main app loop whenever a new app-server event is received. It delegates detailed notification/request processing to `App::handle_server_notification_event` and `App::handle_server_request_event`.

*Call graph*: calls 3 internal fn (handle_server_notification_event, handle_server_request_event, refresh_mcp_startup_expected_servers_from_config); 2 external calls (FatalExitRequest, warn!).


##### `App::handle_server_notification_event`  (lines 60–173)

```
async fn handle_server_notification_event(
        &mut self,
        app_server_client: &AppServerSession,
        notification: ServerNotification,
    )
```

**Purpose**: Processes a single `ServerNotification`, applying app-wide side effects first and then routing thread-bound notifications into the correct queue. It is the main notification bridge from protocol events to TUI state.

**Data flow**: Takes ownership of a `ServerNotification`. It may resolve and dismiss pending requests, refresh MCP startup expectations, update rate-limit snapshots, update account/auth display state, or perform external-agent-config import follow-up work including config reload, plugin mention refresh, `reload_user_config`, plugin list fetch, and optional info messaging. If not returned early, it classifies the notification with `server_notification_thread_target`; thread-targeted notifications are enqueued to the primary or side-thread queue based on `self.primary_thread_id`, invalid IDs are logged and dropped, app-scoped notifications are ignored, and global notifications are forwarded to `self.chat_widget.handle_server_notification`.

**Call relations**: Called only from `App::handle_app_server_event` for `AppServerEvent::ServerNotification`. It depends on `server_notification_thread_target` for routing and on several other app methods for queueing, config refresh, and plugin/account UI updates.

*Call graph*: calls 4 internal fn (server_notification_thread_target, refresh_mcp_startup_expected_servers_from_config, consume_external_agent_config_import_completion, status_account_display_from_auth_mode); called by 1 (handle_app_server_event); 4 external calls (reload_user_config, matches!, debug!, warn!).


##### `App::handle_server_request_event`  (lines 175–218)

```
async fn handle_server_request_event(
        &mut self,
        app_server_client: &AppServerSession,
        request: ServerRequest,
    )
```

**Purpose**: Records, rejects, and routes incoming app-server requests to the appropriate thread queue. It ensures unsupported requests are rejected promptly and supported ones are correlated before delivery.

**Data flow**: Consumes a `ServerRequest` and first passes a shared reference to `self.pending_app_server_requests.note_server_request`. If that returns an `UnsupportedAppServerRequest`, it logs, shows the message in the chat widget, asynchronously rejects the RPC via `reject_app_server_request`, and returns. Otherwise it extracts a thread ID with `server_request_thread_id`; missing IDs are warned and ignored, while valid IDs are used to enqueue the request to the primary thread or a side thread depending on `self.primary_thread_id`, with enqueue failures logged.

**Call relations**: This method is called from `App::handle_app_server_event` for `AppServerEvent::ServerRequest`. It relies on `PendingAppServerRequests` to maintain request correlation and on `server_request_thread_id` to decide whether and where the request can be delivered.

*Call graph*: calls 1 internal fn (server_request_thread_id); called by 1 (handle_app_server_event); 1 external calls (warn!).


### `tui/src/app/app_server_requests.rs`

`domain_logic` · `request handling`

This module contains both a small `App` helper for rejecting unsupported requests and the core `PendingAppServerRequests` state machine. `App::reject_app_server_request` wraps `AppServerSession::reject_server_request` with a fixed JSON-RPC error shape (`code: -32000`) and a user-visible reason string.

`PendingAppServerRequests` stores pending requests in several maps keyed by the identifier the UI will later use: command approvals by approval/item ID, file changes by item ID, permissions by item ID, user-input requests as FIFO `VecDeque`s per `turn_id`, and MCP elicitation requests by `(server_name, request_id)`. `note_server_request` is the ingestion point: it records supported requests, validates permission paths early via `CoreRequestPermissionProfile::try_from` so invalid filesystem paths can be rejected before UI delivery, and returns `UnsupportedAppServerRequest` for unsupported variants like dynamic tool calls and legacy approval APIs.

`take_resolution` converts an `AppCommand` into an optional `AppServerRequestResolution` by removing the matching pending entry and serializing the appropriate protocol response type with `serde_json::to_value`. The mapping is concrete: exec approvals become `CommandExecutionRequestApprovalResponse`, patch approvals become `FileChangeRequestApprovalResponse`, permission responses convert granted permissions and scope, user-input answers pop the oldest request for a turn, and MCP elicitation resolutions serialize action/content/meta. `resolve_notification` performs the inverse correlation when the server later emits `ServerRequestResolved`, removing the matching pending entry and returning a `ResolvedAppServerRequest` so the UI can dismiss the right prompt. Helper methods preserve FIFO semantics for same-turn user-input requests and clean up empty queues. The extensive tests cover serialization, unsupported-request rejection, permission-path validation, FIFO ordering, and notification correlation.

#### Function details

##### `App::reject_app_server_request`  (lines 18–35)

```
async fn reject_app_server_request(
        &self,
        app_server_client: &AppServerSession,
        request_id: AppServerRequestId,
        reason: String,
    ) -> std::result::Result<(), String
```

**Purpose**: Sends a JSON-RPC rejection back to the app server for a request the TUI cannot or will not handle. It standardizes the error code and wraps transport failures in a user-readable string.

**Data flow**: Accepts an `AppServerSession`, a protocol `request_id`, and a rejection `reason`. It constructs `JSONRPCErrorError { code: -32000, message: reason, data: None }`, awaits `app_server_client.reject_server_request`, and returns `Ok(())` on success or `Err("failed to reject app-server request: ...")` on failure.

**Call relations**: This helper is called from `App::handle_server_request_event` when `PendingAppServerRequests::note_server_request` reports an unsupported request. It delegates the actual RPC transmission to the app-server session.

*Call graph*: calls 1 internal fn (reject_server_request).


##### `PendingAppServerRequests::clear`  (lines 80–86)

```
fn clear(&mut self)
```

**Purpose**: Drops all tracked pending app-server requests. It resets every correlation map and queue to an empty state.

**Data flow**: Mutably borrows `self` and clears `exec_approvals`, `file_change_approvals`, `permissions_approvals`, `user_inputs`, and `mcp_requests`. It returns no value.

**Call relations**: This is a local state-reset helper used when the app needs to discard all pending request bookkeeping, such as during broader session resets elsewhere in the app.


##### `PendingAppServerRequests::note_server_request`  (lines 88–171)

```
fn note_server_request(
        &mut self,
        request: &ServerRequest,
    ) -> Option<UnsupportedAppServerRequest>
```

**Purpose**: Registers a newly arrived `ServerRequest` in the appropriate pending map or rejects it as unsupported. It is the authoritative ingestion point for request correlation state.

**Data flow**: Reads a `&ServerRequest`, matches its variant, and inserts the protocol `request_id` into one of several maps keyed by approval ID, item ID, turn ID queue, or MCP `(server_name, request_id)` pair. For permissions requests it first validates `params.permissions` via `CoreRequestPermissionProfile::try_from`; validation failure returns `Some(UnsupportedAppServerRequest)` with a formatted localization error instead of recording the request. Unsupported variants like `DynamicToolCall`, `AttestationGenerate`, `ApplyPatchApproval`, and `ExecCommandApproval` return `Some(UnsupportedAppServerRequest)` with fixed messages; supported variants return `None`.

**Call relations**: Called by `App::handle_server_request_event` before any request is routed to a thread. Its output determines whether the request is delivered to the UI or immediately rejected through `App::reject_app_server_request`.

*Call graph*: 2 external calls (try_from, format!).


##### `PendingAppServerRequests::take_resolution`  (lines 173–273)

```
fn take_resolution(
        &mut self,
        op: T,
    ) -> Result<Option<AppServerRequestResolution>, String>
```

**Purpose**: Consumes a user-originated `AppCommand` and, if it corresponds to a pending app-server request, produces the serialized protocol response payload to send back. It also removes the matched pending entry so the request cannot be resolved twice.

**Data flow**: Accepts any `T: Into<AppCommand>`, converts it, and matches the resulting command. For exec, patch, permissions, user-input, and MCP elicitation commands, it removes the corresponding pending request from the relevant map or queue, serializes the concrete response struct into `serde_json::Value`, and returns `Ok(Some(AppServerRequestResolution { request_id, result }))`. Serialization failures become `Err(String)`. Commands unrelated to app-server requests return `Ok(None)`.

**Call relations**: This method is used by higher-level command submission code when the user answers an approval or elicitation prompt. It delegates turn-based user-input lookup to `pop_user_input_request_for_turn` and relies on the pending maps populated by `note_server_request`.

*Call graph*: calls 1 internal fn (pop_user_input_request_for_turn); 1 external calls (into).


##### `PendingAppServerRequests::resolve_notification`  (lines 275–325)

```
fn resolve_notification(
        &mut self,
        request_id: &AppServerRequestId,
    ) -> Option<ResolvedAppServerRequest>
```

**Purpose**: Matches a `ServerRequestResolved` notification back to the pending request it completes and returns a UI-facing description of what was resolved. It also removes the request from tracking state.

**Data flow**: Takes a borrowed protocol `request_id`, scans each pending collection for a matching stored request ID, removes the first match found, and returns a typed `ResolvedAppServerRequest` describing the resolved exec approval, file-change approval, permissions approval, user-input call ID, or MCP elicitation key. If no pending entry matches, it returns `None`.

**Call relations**: Called from `App::handle_server_notification_event` when a `ServerNotification::ServerRequestResolved` arrives. It uses `remove_user_input_request` for the queued user-input case and lets the caller dismiss the corresponding UI prompt.

*Call graph*: calls 1 internal fn (remove_user_input_request).


##### `PendingAppServerRequests::contains_server_request`  (lines 327–358)

```
fn contains_server_request(&self, request: &ServerRequest) -> bool
```

**Purpose**: Checks whether a given `ServerRequest` is already represented in pending state. It supports deduplication and replay logic by answering whether the request is known.

**Data flow**: Reads `&self` and `&ServerRequest`, then searches the relevant map values or queued user-input entries for the request’s `request_id`. For unsupported or legacy request variants it returns `true` unconditionally, treating them as effectively known/non-deliverable. It does not mutate state.

**Call relations**: This helper is used by surrounding replay and buffering code to avoid reintroducing duplicate pending requests after thread event replays or queue reconstruction.


##### `PendingAppServerRequests::pop_user_input_request_for_turn`  (lines 360–376)

```
fn pop_user_input_request_for_turn(
        &mut self,
        turn_id: &str,
    ) -> Option<PendingUserInputRequest>
```

**Purpose**: Removes the oldest pending user-input request for a given turn. It enforces FIFO semantics when multiple tool questions are queued on the same turn.

**Data flow**: Looks up `self.user_inputs[turn_id]`, pops the front `PendingUserInputRequest` from its `VecDeque`, removes the entire map entry if the queue becomes empty, and returns the popped request or `None` if no queue exists.

**Call relations**: This private helper is called by `PendingAppServerRequests::take_resolution` when handling `AppCommand::UserInputAnswer`, ensuring repeated answers for the same turn resolve requests in arrival order.

*Call graph*: called by 1 (take_resolution).


##### `PendingAppServerRequests::remove_user_input_request`  (lines 378–394)

```
fn remove_user_input_request(
        &mut self,
        request_id: &AppServerRequestId,
    ) -> Option<PendingUserInputRequest>
```

**Purpose**: Finds and removes a pending user-input request by protocol `request_id` regardless of which turn queue contains it. It supports reverse correlation from server resolution notifications.

**Data flow**: Searches all `user_inputs` queues to find the `(turn_id, index)` of the first pending entry whose `request_id` matches, removes that entry from the queue, deletes the queue map entry if it becomes empty, and returns the removed `PendingUserInputRequest` or `None`.

**Call relations**: This private helper is used by `PendingAppServerRequests::resolve_notification` to translate a `ServerRequestResolved` notification into a `ResolvedAppServerRequest::UserInput` carrying the original `item_id`.

*Call graph*: called by 1 (resolve_notification).


##### `tests::resolves_exec_approval_through_app_server_request_id`  (lines 445–480)

```
fn resolves_exec_approval_through_app_server_request_id()
```

**Purpose**: Verifies that a recorded command-execution approval request can be resolved from an `AppCommand::ExecApproval` into the original app-server `request_id` and serialized decision payload.

**Data flow**: Creates a default `PendingAppServerRequests`, records a `CommandExecutionRequestApproval` with explicit approval ID, calls `take_resolution` with an accept decision, and asserts the returned `AppServerRequestResolution` contains `RequestId::Integer(41)` and JSON `{ "decision": "accept" }`.

**Call relations**: This test exercises the `note_server_request` and `take_resolution` path for exec approvals, documenting the approval-ID keying behavior.

*Call graph*: 3 external calls (Integer, assert_eq!, default).


##### `tests::rejects_permissions_with_paths_that_cannot_be_localized`  (lines 483–528)

```
fn rejects_permissions_with_paths_that_cannot_be_localized()
```

**Purpose**: Checks that invalid permission paths are rejected immediately instead of being recorded as pending. It covers the early validation branch for permissions requests.

**Data flow**: Builds a permissions payload containing a relative filesystem path, confirms core localization fails, wraps it in `ServerRequest::PermissionsRequestApproval`, passes it to `note_server_request`, and asserts the result is `Some(UnsupportedAppServerRequest)` with the formatted localization error message.

**Call relations**: This test targets the duplicate-validation logic in `note_server_request` that exists specifically to preserve a clean rejection path before UI delivery.

*Call graph*: calls 1 internal fn (try_from); 7 external calls (Integer, from, try_from, assert_eq!, cfg!, default, vec!).


##### `tests::resolves_permissions_and_user_input_through_app_server_request_id`  (lines 531–662)

```
fn resolves_permissions_and_user_input_through_app_server_request_id()
```

**Purpose**: Validates both permission-response serialization and user-input response serialization, including conversion of granted permissions back into protocol form. It also confirms each response resolves to the correct original request ID.

**Data flow**: Records a permissions approval request and a tool user-input request, then calls `take_resolution` first with `AppCommand::RequestPermissionsResponse` and then with `AppCommand::UserInputAnswer`. It asserts the returned request IDs are 7 and 8 respectively and deserializes the JSON payloads back into protocol response structs to verify exact contents.

**Call relations**: This test covers two branches of `take_resolution`: permission approvals, which invoke granted-permission conversion, and user-input answers, which consume the oldest queued request for a turn.

*Call graph*: calls 1 internal fn (from_read_write_roots); 5 external calls (assert_eq!, cfg!, once, default, vec!).


##### `tests::correlates_mcp_elicitation_server_request_with_resolution`  (lines 665–710)

```
fn correlates_mcp_elicitation_server_request_with_resolution()
```

**Purpose**: Ensures MCP elicitation requests are keyed and resolved by `(server_name, request_id)` and serialized with action, content, and `_meta`. It protects the MCP-specific correlation path.

**Data flow**: Records an `McpServerElicitationRequest`, resolves it with `AppCommand::ResolveElicitation`, and asserts the resulting `AppServerRequestResolution` carries the original integer request ID and JSON containing `action`, `content`, and `_meta`.

**Call relations**: This test exercises the MCP branch of both `note_server_request` and `take_resolution`, documenting the custom `McpRequestKey` behavior.

*Call graph*: 4 external calls (Integer, assert_eq!, json!, default).


##### `tests::rejects_dynamic_tool_calls_as_unsupported`  (lines 713–734)

```
fn rejects_dynamic_tool_calls_as_unsupported()
```

**Purpose**: Confirms that dynamic tool calls are not accepted by the TUI request tracker. The test locks in the exact unsupported-message text.

**Data flow**: Creates a `DynamicToolCall` request, passes it to `note_server_request`, unwraps the returned `UnsupportedAppServerRequest`, and asserts both the request ID and rejection message match expectations.

**Call relations**: This test covers one of the explicit unsupported branches in `note_server_request` that causes `App::handle_server_request_event` to reject the RPC.

*Call graph*: 4 external calls (Integer, assert_eq!, json!, default).


##### `tests::does_not_mark_chatgpt_auth_refresh_as_unsupported`  (lines 737–750)

```
fn does_not_mark_chatgpt_auth_refresh_as_unsupported()
```

**Purpose**: Verifies that ChatGPT auth-token refresh requests are not treated as unsupported even though they are not thread-routed here. This preserves compatibility with app-scoped auth flows.

**Data flow**: Creates a `ChatgptAuthTokensRefresh` request, passes it to `note_server_request`, and asserts the result is `None`.

**Call relations**: This test documents the special-case branch in `note_server_request` where the request is neither recorded in a pending map nor rejected.

*Call graph*: 2 external calls (assert_eq!, default).


##### `tests::resolves_patch_approval_through_app_server_request_id`  (lines 753–780)

```
fn resolves_patch_approval_through_app_server_request_id()
```

**Purpose**: Checks that file-change approval requests are correlated by item ID and serialized into the expected cancel/accept payload. It covers the patch-approval branch of the resolution logic.

**Data flow**: Records a `FileChangeRequestApproval`, resolves it with `AppCommand::PatchApproval { decision: Cancel }`, and asserts the returned request ID is 13 with JSON `{ "decision": "cancel" }`.

**Call relations**: This test exercises the file-change branch of `note_server_request` and `take_resolution`.

*Call graph*: 2 external calls (assert_eq!, default).


##### `tests::resolve_notification_returns_resolved_exec_request`  (lines 783–818)

```
fn resolve_notification_returns_resolved_exec_request()
```

**Purpose**: Verifies that a server-side resolution notification removes a pending exec approval and returns the corresponding UI-facing resolved value exactly once.

**Data flow**: Records a command-execution approval request, calls `resolve_notification` with its request ID, asserts it returns `Some(ResolvedAppServerRequest::ExecApproval { ... })`, then calls again and asserts `None` because the entry was removed.

**Call relations**: This test covers the exec-approval branch of `resolve_notification` and confirms the method is destructive.

*Call graph*: 2 external calls (assert_eq!, default).


##### `tests::resolve_notification_returns_resolved_mcp_request`  (lines 821–852)

```
fn resolve_notification_returns_resolved_mcp_request()
```

**Purpose**: Checks that `resolve_notification` can recover MCP elicitation metadata from a resolved request ID. It ensures the server name and request ID are preserved in the returned enum.

**Data flow**: Records an MCP elicitation request, calls `resolve_notification` with request ID 12, and asserts it returns `ResolvedAppServerRequest::McpElicitation { server_name: "example", request_id: 12 }`.

**Call relations**: This test exercises the MCP branch of `resolve_notification`, which scans `mcp_requests` for a matching stored request ID.

*Call graph*: 2 external calls (assert_eq!, default).


##### `tests::resolve_notification_returns_resolved_user_input_item_id`  (lines 855–874)

```
fn resolve_notification_returns_resolved_user_input_item_id()
```

**Purpose**: Ensures a resolved user-input request maps back to the original tool call/item ID rather than only the turn ID. That is the identifier the UI needs to dismiss the right prompt.

**Data flow**: Records a `ToolRequestUserInput` request, calls `resolve_notification` with its request ID, and asserts the result is `ResolvedAppServerRequest::UserInput { call_id: "tool-1" }`.

**Call relations**: This test covers the user-input branch of `resolve_notification`, which delegates queue removal to `remove_user_input_request`.

*Call graph*: 4 external calls (Integer, new, assert_eq!, default).


##### `tests::same_turn_user_input_answers_resolve_app_server_requests_fifo`  (lines 877–912)

```
fn same_turn_user_input_answers_resolve_app_server_requests_fifo()
```

**Purpose**: Verifies FIFO ordering for multiple pending user-input requests on the same turn. It prevents later prompts from being answered before earlier ones when both share a turn ID.

**Data flow**: Records two `ToolRequestUserInput` requests for `turn-1` with request IDs 8 and 9, then calls `take_resolution` twice with `AppCommand::UserInputAnswer { id: "turn-1" }`. It asserts the first returned resolution uses request ID 8 and the second uses request ID 9.

**Call relations**: This test specifically validates the queue behavior implemented by `pop_user_input_request_for_turn`, which `take_resolution` uses for user-input answers.

*Call graph*: 5 external calls (Integer, new, new, assert_eq!, default).


### Thread routing and interactive replay
These files manage per-thread state, route thread-scoped commands and events, and preserve unresolved interactive prompts across thread switches.

### `tui/src/app/pending_interactive_replay.rs`

`domain_logic` · `cross-cutting during event buffering, snapshot creation, thread switching, and prompt resolution`

This module implements the state machine behind interactive prompt replay filtering. `PendingInteractiveReplayState` stores several parallel indexes: fast membership sets keyed by approval/item/request identity, per-turn `HashMap<String, Vec<String>>` queues for prompt cleanup on turn completion, and `pending_requests_by_request_id` so server-side resolution notifications can remove the exact pending request. `ElicitationRequestKey` combines MCP `server_name` with app-server `RequestId`, because request IDs alone are not the only semantic discriminator used elsewhere.

State enters through `note_server_request`, which recognizes five interactive `ServerRequest` variants: command execution approval, file change approval, MCP elicitation, tool user input, and permissions approval. Each inserts into the relevant set and turn queue, and records a `PendingInteractiveRequest` enum in the request-ID map. State leaves through three channels: outbound user actions in `note_outbound_op`, inbound notifications in `note_server_notification`, and buffer eviction in `note_evicted_server_request`. The outbound path mirrors protocol semantics carefully: `UserInputAnswer` identifies a turn rather than a prompt call ID, so removal is FIFO from that turn's queue; `ExecApproval` may use `approval_id` instead of `item_id`; `Shutdown` clears everything. Notification handling also clears all prompts tied to a completed turn and wipes state on thread close.

The replay decision itself is `should_replay_snapshot_request`, which returns true only if the corresponding prompt identity is still present in the relevant pending set; noninteractive requests always replay. Helper methods expose whether a thread still has pending approvals or pending user input, and internal cleanup helpers keep the set/map invariants aligned so no stale prompt survives in one index after removal from another. The extensive tests drive this indirectly through `ThreadEventStore`, validating replay retention and removal across outbound answers, server resolutions, turn completion, and thread closure.

#### Function details

##### `ElicitationRequestKey::new`  (lines 16–21)

```
fn new(server_name: String, request_id: AppServerRequestId) -> Self
```

**Purpose**: Constructs the composite key used to identify a pending MCP elicitation by both server name and request ID. This avoids ambiguous lookups when replay-filtering elicitation prompts.

**Data flow**: Consumes a `String` server name and an `AppServerRequestId`, stores them into a new `ElicitationRequestKey`, and returns it. It has no side effects.

**Call relations**: Used wherever elicitation prompts are inserted, removed, or checked: outbound resolution, inbound request tracking, eviction cleanup, and replay filtering all create this key to address the `elicitation_requests` set consistently.

*Call graph*: called by 4 (note_evicted_server_request, note_outbound_op, note_server_request, should_replay_snapshot_request).


##### `PendingInteractiveReplayState::op_can_change_state`  (lines 73–87)

```
fn op_can_change_state(op: T) -> bool
```

**Purpose**: Reports whether a given outbound app command is one of the command types that can alter pending interactive replay state. It acts as a cheap prefilter before doing full state updates.

**Data flow**: Accepts any `T: Into<AppCommand>`, converts it into an `AppCommand`, pattern-matches against the interactive-resolution variants plus `Shutdown`, and returns a boolean. It reads no internal state and writes none.

**Call relations**: Called by higher-level buffering logic before deciding whether to route an outbound operation into `note_outbound_op`. It encapsulates the list of command variants that matter to this module.

*Call graph*: called by 1 (op_can_change_pending_replay_state); 2 external calls (into, matches!).


##### `PendingInteractiveReplayState::note_outbound_op`  (lines 89–170)

```
fn note_outbound_op(&mut self, op: T)
```

**Purpose**: Applies the effect of an outbound user/app command that resolves or clears pending interactive prompts. It removes matching entries from all relevant indexes so resolved prompts stop replaying.

**Data flow**: Consumes an operation convertible into `AppCommand`, matches on the concrete variant, and mutates the pending sets, per-turn maps, and `pending_requests_by_request_id`. `ExecApproval` removes by approval ID and optional turn ID; `PatchApproval` and `RequestPermissionsResponse` remove by item ID; `ResolveElicitation` removes the composite elicitation key; `UserInputAnswer` pops the oldest queued call ID for the specified turn and removes that prompt; `Shutdown` calls `clear()`. It returns unit.

**Call relations**: Invoked by the surrounding thread-event store when outbound operations are recorded. It delegates repeated map cleanup to `remove_call_id_from_turn_map` and `remove_call_id_from_turn_map_entry`, and uses `ElicitationRequestKey::new` for elicitation identity.

*Call graph*: calls 2 internal fn (new, clear); called by 1 (note_outbound_op); 3 external calls (remove_call_id_from_turn_map, remove_call_id_from_turn_map_entry, into).


##### `PendingInteractiveReplayState::note_server_request`  (lines 172–250)

```
fn note_server_request(&mut self, request: &ServerRequest)
```

**Purpose**: Registers a newly buffered interactive server request as pending. It populates both replay-membership sets and request-ID bookkeeping so later resolutions can remove the prompt accurately.

**Data flow**: Reads a borrowed `ServerRequest`, matches the interactive variants, and inserts identifiers into the corresponding `HashSet`s and per-turn `HashMap<String, Vec<String>>` queues. It also inserts a `PendingInteractiveRequest` enum into `pending_requests_by_request_id`, using `approval_id` when present for command execution approvals and `ElicitationRequestKey::new` for MCP requests. Noninteractive requests are ignored.

**Call relations**: Called by the thread-event store when a request enters the buffer. It is the primary state-ingest path that later cleanup methods rely on.

*Call graph*: calls 1 internal fn (new); called by 1 (push_request); 1 external calls (Elicitation).


##### `PendingInteractiveReplayState::note_server_notification`  (lines 252–283)

```
fn note_server_notification(&mut self, notification: &ServerNotification)
```

**Purpose**: Updates pending prompt state in response to server notifications such as item start, turn completion, request resolution, or thread closure. It removes prompts that are no longer actionable even if no outbound command was observed locally.

**Data flow**: Consumes a borrowed `ServerNotification` and mutates internal indexes according to variant. `ItemStarted` removes matching exec/file-change approvals by item ID; `TurnCompleted` clears all prompt categories tied to that turn; `ServerRequestResolved` removes the exact pending request by request ID; `ThreadClosed` clears all state. Other notifications are ignored.

**Call relations**: Called by the thread-event store when notifications are buffered. It delegates category-specific cleanup to `clear_exec_approval_turn`, `clear_patch_approval_turn`, `clear_request_permissions_turn`, `clear_request_user_input_turn`, `remove_request`, and the generic turn-map removal helper.

*Call graph*: calls 6 internal fn (clear, clear_exec_approval_turn, clear_patch_approval_turn, clear_request_permissions_turn, clear_request_user_input_turn, remove_request); called by 1 (push_notification); 1 external calls (remove_call_id_from_turn_map).


##### `PendingInteractiveReplayState::note_evicted_server_request`  (lines 285–352)

```
fn note_evicted_server_request(&mut self, request: &ServerRequest)
```

**Purpose**: Removes pending-state bookkeeping for an interactive request that has been evicted from the bounded event buffer. This prevents replay state from claiming a prompt exists when its source event is no longer retained.

**Data flow**: Reads a borrowed `ServerRequest`, removes the corresponding identifiers from the relevant pending sets and per-turn maps, handles FIFO-map cleanup for user-input and permissions requests, and finally prunes `pending_requests_by_request_id` by retaining only entries that do not match the evicted request according to `request_matches_server_request`. It returns unit.

**Call relations**: Called by the thread-event store when pushing a request or notification causes older buffered requests to be dropped. It uses `ElicitationRequestKey::new` for elicitation removal and `remove_call_id_from_turn_map_entry` where turn-specific deletion is available.

*Call graph*: calls 1 internal fn (new); called by 2 (push_notification, push_request); 1 external calls (remove_call_id_from_turn_map_entry).


##### `PendingInteractiveReplayState::should_replay_snapshot_request`  (lines 354–376)

```
fn should_replay_snapshot_request(&self, request: &ServerRequest) -> bool
```

**Purpose**: Decides whether a buffered server request should be included when replaying a thread snapshot. Interactive requests replay only if their identity is still marked pending; all other requests replay unconditionally.

**Data flow**: Reads a borrowed `ServerRequest` and checks the appropriate pending set: exec approvals by `approval_id` or fallback `item_id`, patch approvals by `item_id`, elicitation requests by composite key, user-input requests by `item_id`, and permissions approvals by `item_id`. It returns a boolean and mutates nothing.

**Call relations**: Used during snapshot filtering to suppress stale prompts after thread switches. It relies on the state previously maintained by `note_server_request`, `note_outbound_op`, `note_server_notification`, and `note_evicted_server_request`.

*Call graph*: calls 1 internal fn (new).


##### `PendingInteractiveReplayState::has_pending_thread_approvals`  (lines 378–383)

```
fn has_pending_thread_approvals(&self) -> bool
```

**Purpose**: Reports whether the current buffered thread still has any unresolved approval-like prompts. User-input prompts are intentionally excluded from this aggregate.

**Data flow**: Reads the emptiness of `exec_approval_call_ids`, `patch_approval_call_ids`, `elicitation_requests`, and `request_permissions_call_ids`, combines them with OR logic, and returns a boolean. No state changes occur.

**Call relations**: Queried by higher-level UI logic such as thread pending-status indicators. It summarizes several internal collections into one approval-focused signal.

*Call graph*: called by 2 (has_pending_thread_approvals, side_parent_pending_status).


##### `PendingInteractiveReplayState::has_pending_thread_user_input`  (lines 385–387)

```
fn has_pending_thread_user_input(&self) -> bool
```

**Purpose**: Reports whether any unresolved `request_user_input` prompts remain pending for the thread. It is separate from approval status because the UI treats these prompts differently.

**Data flow**: Checks whether `request_user_input_call_ids` is empty and returns the negated result. It does not mutate state.

**Call relations**: Used by higher-level pending-status logic alongside `has_pending_thread_approvals` to distinguish user-input prompts from approvals.

*Call graph*: called by 1 (side_parent_pending_status).


##### `PendingInteractiveReplayState::clear_request_user_input_turn`  (lines 389–400)

```
fn clear_request_user_input_turn(&mut self, turn_id: &str)
```

**Purpose**: Removes all pending user-input prompts associated with a completed or otherwise cleared turn. It keeps both the per-turn queue and global membership set in sync.

**Data flow**: Takes a `turn_id`, removes that turn's queued call IDs from `request_user_input_call_ids_by_turn_id`, deletes each from `request_user_input_call_ids`, and prunes matching `PendingInteractiveRequest::RequestUserInput` entries from `pending_requests_by_request_id`. It returns unit.

**Call relations**: Called from `note_server_notification` when a turn completes. It is the turn-scoped bulk cleanup path for user-input prompts.

*Call graph*: called by 1 (note_server_notification).


##### `PendingInteractiveReplayState::clear_request_permissions_turn`  (lines 402–413)

```
fn clear_request_permissions_turn(&mut self, turn_id: &str)
```

**Purpose**: Clears all pending permissions-approval prompts for a specific turn. This ensures completed turns cannot leave stale permission requests behind.

**Data flow**: Removes the turn's queued item IDs from `request_permissions_call_ids_by_turn_id`, deletes each from `request_permissions_call_ids`, and retains only nonmatching entries in `pending_requests_by_request_id`. It returns unit.

**Call relations**: Invoked by `note_server_notification` on turn completion. It is the permissions counterpart to the other turn-clearing helpers.

*Call graph*: called by 1 (note_server_notification).


##### `PendingInteractiveReplayState::clear_exec_approval_turn`  (lines 415–426)

```
fn clear_exec_approval_turn(&mut self, turn_id: &str)
```

**Purpose**: Clears all pending command-execution approvals tied to a given turn. It is used when a turn completes and any remaining approvals should no longer replay.

**Data flow**: Removes the turn's approval IDs from `exec_approval_call_ids_by_turn_id`, deletes them from `exec_approval_call_ids`, and prunes matching `PendingInteractiveRequest::ExecApproval` entries from `pending_requests_by_request_id`. It returns unit.

**Call relations**: Called by `note_server_notification` for `TurnCompleted`. It bulk-removes exec approvals instead of requiring individual resolution events.

*Call graph*: called by 1 (note_server_notification).


##### `PendingInteractiveReplayState::clear_patch_approval_turn`  (lines 428–439)

```
fn clear_patch_approval_turn(&mut self, turn_id: &str)
```

**Purpose**: Clears all pending file-change approvals associated with a turn. This prevents stale patch prompts from surviving after turn completion.

**Data flow**: Removes the turn's item IDs from `patch_approval_call_ids_by_turn_id`, deletes them from `patch_approval_call_ids`, and prunes matching `PendingInteractiveRequest::PatchApproval` entries from `pending_requests_by_request_id`. It returns unit.

**Call relations**: Used by `note_server_notification` when a turn completes. It mirrors the exec-approval turn cleanup for patch approvals.

*Call graph*: called by 1 (note_server_notification).


##### `PendingInteractiveReplayState::remove_call_id_from_turn_map`  (lines 441–449)

```
fn remove_call_id_from_turn_map(
        call_ids_by_turn_id: &mut HashMap<String, Vec<String>>,
        call_id: &str,
    )
```

**Purpose**: Deletes a call/item ID from every turn queue in a `HashMap<String, Vec<String>>`, dropping any turn entries that become empty. It is the generic cleanup helper when the turn is not known or not trusted.

**Data flow**: Mutably borrows a turn-to-call-ID map and a target `call_id`, retains only queued IDs not equal to the target within each vector, and retains only nonempty vectors in the map. It returns unit.

**Call relations**: Used by outbound and notification cleanup paths for prompt types where removal is keyed by call ID alone. It centralizes the retain-and-prune pattern shared across maps.


##### `PendingInteractiveReplayState::remove_call_id_from_turn_map_entry`  (lines 451–466)

```
fn remove_call_id_from_turn_map_entry(
        call_ids_by_turn_id: &mut HashMap<String, Vec<String>>,
        turn_id: &str,
        call_id: &str,
    )
```

**Purpose**: Deletes a call/item ID from one known turn queue and removes the turn entry if it becomes empty. It is a more targeted variant of the generic map cleanup helper.

**Data flow**: Mutably borrows a turn map, a `turn_id`, and a `call_id`; if the turn exists, it retains only queued IDs not equal to the target and then removes the whole turn entry if the vector is empty. It returns unit.

**Call relations**: Called from several precise cleanup paths, including outbound exec approval removal, eviction handling, and request-ID-based removal. It avoids scanning unrelated turns when the owning turn is known.


##### `PendingInteractiveReplayState::clear`  (lines 468–479)

```
fn clear(&mut self)
```

**Purpose**: Resets all pending interactive replay state to empty. It is the full teardown path used on shutdown or thread closure.

**Data flow**: Clears every `HashSet`, every per-turn `HashMap`, and `pending_requests_by_request_id`, leaving the struct in its default empty state. It returns unit.

**Call relations**: Called by `note_outbound_op` for `Shutdown` and by `note_server_notification` for `ThreadClosed`. It is the broadest cleanup operation in the module.

*Call graph*: called by 2 (note_outbound_op, note_server_notification).


##### `PendingInteractiveReplayState::remove_request`  (lines 481–525)

```
fn remove_request(&mut self, request_id: &AppServerRequestId)
```

**Purpose**: Removes one pending interactive request by app-server request ID and cleans up all secondary indexes associated with it. This is the canonical response to `ServerRequestResolved` notifications.

**Data flow**: Looks up and removes the `PendingInteractiveRequest` from `pending_requests_by_request_id`; if absent, it returns early. Otherwise it matches the removed enum and deletes the corresponding approval/item/composite key from the relevant pending set and per-turn map using `remove_call_id_from_turn_map_entry` where applicable. It returns unit.

**Call relations**: Called from `note_server_notification` when the server reports a request resolved. It translates request-ID identity back into the concrete prompt identifiers stored in the other indexes.

*Call graph*: called by 1 (note_server_notification); 1 external calls (remove_call_id_from_turn_map_entry).


##### `PendingInteractiveReplayState::request_matches_server_request`  (lines 527–560)

```
fn request_matches_server_request(
        pending: &PendingInteractiveRequest,
        request: &ServerRequest,
    ) -> bool
```

**Purpose**: Checks whether an internal `PendingInteractiveRequest` record corresponds to a concrete `ServerRequest`. It is used to prune request-ID bookkeeping when the original buffered request is evicted.

**Data flow**: Reads a borrowed `PendingInteractiveRequest` and `ServerRequest`, pattern-matches compatible variant pairs, and compares turn IDs plus approval/item IDs or elicitation server/request identity as appropriate. It returns `true` only for an exact semantic match and mutates nothing.

**Call relations**: Used by `note_evicted_server_request` inside a `retain` call over `pending_requests_by_request_id`. It bridges between the enum stored internally and the protocol request object being removed from the buffer.


##### `tests::request_user_input_request`  (lines 592–603)

```
fn request_user_input_request(call_id: &str, turn_id: &str) -> ServerRequest
```

**Purpose**: Builds a `ServerRequest::ToolRequestUserInput` fixture for replay-state tests. It provides a concise way to vary call ID and turn ID.

**Data flow**: Accepts `call_id` and `turn_id` strings, constructs a `ToolRequestUserInputParams` with fixed thread ID and empty questions, wraps it in `ServerRequest::ToolRequestUserInput` with integer request ID 1, and returns the request. No external state is touched.

**Call relations**: Used by multiple tests that verify pending user-input prompts are retained or removed under different resolution paths.

*Call graph*: 2 external calls (Integer, new).


##### `tests::exec_approval_request`  (lines 605–629)

```
fn exec_approval_request(
        call_id: &str,
        approval_id: Option<&str>,
        turn_id: &str,
    ) -> ServerRequest
```

**Purpose**: Builds a command-execution approval request fixture with optional distinct `approval_id`. It lets tests cover both item-ID and approval-ID resolution semantics.

**Data flow**: Consumes a call ID, optional approval ID, and turn ID; constructs `CommandExecutionRequestApprovalParams` with fixed thread ID, command, cwd, and timestamps; wraps them in `ServerRequest::CommandExecutionRequestApproval` with integer request ID 2; and returns the request.

**Call relations**: Used by tests that validate exec approval replay removal after outbound approval, server resolution, turn completion, and thread closure.

*Call graph*: 2 external calls (Integer, test_path_buf).


##### `tests::patch_approval_request`  (lines 631–643)

```
fn patch_approval_request(call_id: &str, turn_id: &str) -> ServerRequest
```

**Purpose**: Builds a file-change approval request fixture for tests. It isolates the protocol boilerplate for patch approval scenarios.

**Data flow**: Accepts a call ID and turn ID, constructs `FileChangeRequestApprovalParams` with fixed thread ID and timestamps, wraps them in `ServerRequest::FileChangeRequestApproval` with integer request ID 3, and returns the request.

**Call relations**: Used by tests covering patch approval removal and turn-completion cleanup.

*Call graph*: 1 external calls (Integer).


##### `tests::elicitation_request`  (lines 645–664)

```
fn elicitation_request(server_name: &str, request_id: &str, turn_id: &str) -> ServerRequest
```

**Purpose**: Builds an MCP elicitation request fixture with a string request ID and simple form schema. It supports tests for pending elicitation replay behavior.

**Data flow**: Consumes server name, request ID string, and turn ID; constructs `McpServerElicitationRequestParams` with a form request and empty object schema; wraps them in `ServerRequest::McpServerElicitationRequest` using `AppServerRequestId::String`; and returns the request.

**Call relations**: Used by the elicitation-resolution test to verify that outbound `ResolveElicitation` removes the prompt from replay.

*Call graph*: 2 external calls (String, new).


##### `tests::turn_completed`  (lines 666–680)

```
fn turn_completed(turn_id: &str) -> ServerNotification
```

**Purpose**: Builds a `ServerNotification::TurnCompleted` fixture for a given turn. It lets tests trigger bulk cleanup of prompts tied to that turn.

**Data flow**: Accepts a turn ID, constructs a `Turn` with completed status and fixed timing fields, wraps it in `TurnCompletedNotification`, then in `ServerNotification::TurnCompleted`, and returns the notification.

**Call relations**: Used by tests that verify pending approvals are dropped when a turn completes.

*Call graph*: 2 external calls (TurnCompleted, new).


##### `tests::thread_closed`  (lines 682–686)

```
fn thread_closed() -> ServerNotification
```

**Purpose**: Builds a `ServerNotification::ThreadClosed` fixture. It supports tests for full pending-state reset on thread closure.

**Data flow**: Constructs `ThreadClosedNotification` with fixed thread ID, wraps it in `ServerNotification::ThreadClosed`, and returns it. No state is mutated.

**Call relations**: Used by the thread-closure test to drive the `clear()` path indirectly through the event store.

*Call graph*: 1 external calls (ThreadClosed).


##### `tests::request_resolved`  (lines 688–693)

```
fn request_resolved(request_id: AppServerRequestId) -> ServerNotification
```

**Purpose**: Builds a `ServerNotification::ServerRequestResolved` fixture for a specific request ID. It is the test helper for request-ID-based cleanup.

**Data flow**: Consumes an `AppServerRequestId`, wraps it in `ServerRequestResolvedNotification` with fixed thread ID, then in `ServerNotification::ServerRequestResolved`, and returns the notification.

**Call relations**: Used by tests that verify server-side resolution removes pending user-input and exec-approval prompts from snapshots.

*Call graph*: 1 external calls (ServerRequestResolved).


##### `tests::thread_event_snapshot_keeps_pending_request_user_input`  (lines 696–709)

```
fn thread_event_snapshot_keeps_pending_request_user_input()
```

**Purpose**: Verifies that an unresolved `request_user_input` prompt remains present in a thread snapshot. This is the baseline retention case for pending interactive replay.

**Data flow**: Creates a `ThreadEventStore`, pushes one user-input request fixture, snapshots the store, asserts there is exactly one event, and pattern-matches that it is the expected `ToolRequestUserInput` request with item ID `call-1`.

**Call relations**: Run by the test harness to confirm that pending prompts are not over-filtered. It exercises this module indirectly through `ThreadEventStore::push_request` and `snapshot()`.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert!, assert_eq!, request_user_input_request).


##### `tests::thread_event_snapshot_drops_resolved_request_user_input_after_user_answer`  (lines 712–728)

```
fn thread_event_snapshot_drops_resolved_request_user_input_after_user_answer()
```

**Purpose**: Checks that answering a user-input prompt via outbound operation removes it from future snapshot replay. It validates the FIFO turn-based removal logic for `UserInputAnswer`.

**Data flow**: Creates a store, pushes one user-input request, records an outbound `Op::UserInputAnswer` for the same turn with empty answers, snapshots the store, and asserts the snapshot event list is empty.

**Call relations**: Exercises the `note_outbound_op` path indirectly through the event store. It specifically covers the case where the outbound answer identifies only the turn, not the prompt call ID.

*Call graph*: calls 1 internal fn (new); 3 external calls (new, assert!, request_user_input_request).


##### `tests::thread_event_snapshot_drops_resolved_request_user_input_after_server_resolution`  (lines 731–747)

```
fn thread_event_snapshot_drops_resolved_request_user_input_after_server_resolution()
```

**Purpose**: Verifies that a server-side request-resolution notification removes a pending user-input prompt from replay. This covers cleanup without a local outbound answer.

**Data flow**: Creates a store, pushes one user-input request, pushes a `ServerRequestResolved` notification for request ID 1, snapshots the store, and asserts no remaining event is a `ToolRequestUserInput` request.

**Call relations**: Drives the `remove_request` path indirectly via `note_server_notification`. It complements the outbound-answer test with the server-notification resolution path.

*Call graph*: calls 1 internal fn (new); 4 external calls (Integer, assert!, request_resolved, request_user_input_request).


##### `tests::thread_event_snapshot_drops_resolved_exec_approval_after_outbound_approval_id`  (lines 750–769)

```
fn thread_event_snapshot_drops_resolved_exec_approval_after_outbound_approval_id()
```

**Purpose**: Checks that an exec approval prompt keyed by explicit `approval_id` disappears after the corresponding outbound approval command. It verifies that approval ID, not just item ID, is honored.

**Data flow**: Creates a store, pushes an exec approval request with `approval_id = Some("approval-1")`, records an outbound `Op::ExecApproval` using that approval ID and turn ID, snapshots the store, and asserts the snapshot is empty.

**Call relations**: Exercises the exec-approval branch of `note_outbound_op` through the event store. It specifically covers the alternate identifier path where `approval_id` differs from `item_id`.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert!, exec_approval_request).


##### `tests::thread_event_snapshot_drops_resolved_exec_approval_after_server_resolution`  (lines 772–794)

```
fn thread_event_snapshot_drops_resolved_exec_approval_after_server_resolution()
```

**Purpose**: Verifies that a server request-resolution notification removes a pending exec approval prompt from replay. It covers request-ID-based cleanup for command approvals.

**Data flow**: Creates a store, pushes an exec approval request with explicit approval ID, pushes a `ServerRequestResolved` notification for request ID 2, snapshots the store, and asserts no remaining event is a command-execution approval request.

**Call relations**: Indirectly tests `remove_request` for `PendingInteractiveRequest::ExecApproval`. It complements the outbound-approval test with the server-driven resolution path.

*Call graph*: calls 1 internal fn (new); 4 external calls (Integer, assert!, exec_approval_request, request_resolved).


##### `tests::thread_event_snapshot_drops_answered_request_user_input_for_multi_prompt_turn`  (lines 797–817)

```
fn thread_event_snapshot_drops_answered_request_user_input_for_multi_prompt_turn()
```

**Purpose**: Ensures that when multiple user-input prompts occur in the same turn over time, answering one removes only the oldest queued prompt. It validates FIFO semantics across sequential prompt arrival.

**Data flow**: Creates a store, pushes `call-1` for `turn-1`, records one outbound `UserInputAnswer` for that turn, then pushes `call-2` for the same turn, snapshots the store, and asserts exactly one remaining event exists and it is `call-2`.

**Call relations**: Exercises the queue behavior in `note_outbound_op` indirectly. It proves that answering a turn does not wipe later prompts for that same turn.

*Call graph*: calls 1 internal fn (new); 4 external calls (new, assert!, assert_eq!, request_user_input_request).


##### `tests::thread_event_snapshot_keeps_newer_request_user_input_pending_when_same_turn_has_queue`  (lines 820–839)

```
fn thread_event_snapshot_keeps_newer_request_user_input_pending_when_same_turn_has_queue()
```

**Purpose**: Verifies FIFO removal when multiple user-input prompts are already queued for the same turn before an answer arrives. Only the oldest prompt should be consumed.

**Data flow**: Creates a store, pushes `call-1` and `call-2` for the same turn, records one outbound `UserInputAnswer`, snapshots the store, and asserts the only remaining prompt is `call-2`.

**Call relations**: Another indirect test of the turn-queue logic in `note_outbound_op`. It covers the case where multiple prompts are pending simultaneously rather than sequentially.

*Call graph*: calls 1 internal fn (new); 4 external calls (new, assert!, assert_eq!, request_user_input_request).


##### `tests::thread_event_snapshot_drops_resolved_patch_approval_after_outbound_approval`  (lines 842–856)

```
fn thread_event_snapshot_drops_resolved_patch_approval_after_outbound_approval()
```

**Purpose**: Checks that a file-change approval prompt is removed from replay after the outbound patch approval command is sent. It validates patch approval cleanup.

**Data flow**: Creates a store, pushes one patch approval request, records an outbound `Op::PatchApproval` accepting that item ID, snapshots the store, and asserts the snapshot is empty.

**Call relations**: Indirectly exercises the patch-approval branch of `note_outbound_op` through the event store.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert!, patch_approval_request).


##### `tests::thread_event_snapshot_drops_pending_approvals_when_turn_completes`  (lines 859–877)

```
fn thread_event_snapshot_drops_pending_approvals_when_turn_completes()
```

**Purpose**: Verifies that unresolved exec and patch approvals tied to a turn are dropped once the server reports that turn completed. This ensures stale prompts do not replay after completion.

**Data flow**: Creates a store, pushes one exec approval and one patch approval for `turn-1`, pushes a `TurnCompleted` notification for that turn, snapshots the store, and asserts no remaining event is either approval request type.

**Call relations**: Indirectly tests the turn-clearing helpers invoked by `note_server_notification`. It covers bulk cleanup rather than individual resolution.

*Call graph*: calls 1 internal fn (new); 4 external calls (assert!, exec_approval_request, patch_approval_request, turn_completed).


##### `tests::thread_event_snapshot_drops_resolved_elicitation_after_outbound_resolution`  (lines 880–898)

```
fn thread_event_snapshot_drops_resolved_elicitation_after_outbound_resolution()
```

**Purpose**: Checks that an MCP elicitation prompt is removed from replay after an outbound elicitation resolution command. It validates composite-key cleanup for elicitation requests.

**Data flow**: Creates a store, pushes one elicitation request, records an outbound `Op::ResolveElicitation` with matching server name and request ID, snapshots the store, and asserts the snapshot is empty.

**Call relations**: Indirectly exercises the elicitation branch of `note_outbound_op`, including `ElicitationRequestKey` matching.

*Call graph*: calls 1 internal fn (new); 3 external calls (String, assert!, elicitation_request).


##### `tests::thread_event_store_reports_pending_thread_approvals`  (lines 901–918)

```
fn thread_event_store_reports_pending_thread_approvals()
```

**Purpose**: Verifies the aggregate approval-status signal exposed by the event store. It confirms that pending exec approvals set the flag and outbound approval clears it.

**Data flow**: Creates a store, asserts `has_pending_thread_approvals()` is initially false, pushes an exec approval request, asserts the flag becomes true, records an outbound `ExecApproval`, and asserts the flag returns to false.

**Call relations**: Indirectly tests `PendingInteractiveReplayState::has_pending_thread_approvals` through the store's public API.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert_eq!, exec_approval_request).


##### `tests::request_user_input_does_not_count_as_pending_thread_approval`  (lines 921–926)

```
fn request_user_input_does_not_count_as_pending_thread_approval()
```

**Purpose**: Ensures that `request_user_input` prompts do not contribute to the approval-status aggregate. This preserves the intended distinction between approvals and user-input prompts.

**Data flow**: Creates a store, pushes one user-input request, and asserts `has_pending_thread_approvals()` remains false.

**Call relations**: Indirectly validates the scope of `has_pending_thread_approvals`, confirming that only approval-like categories are counted.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert_eq!, request_user_input_request).


##### `tests::thread_event_snapshot_drops_pending_requests_when_thread_closes`  (lines 929–942)

```
fn thread_event_snapshot_drops_pending_requests_when_thread_closes()
```

**Purpose**: Verifies that closing a thread clears pending interactive requests so none replay afterward. It covers the full-state reset path.

**Data flow**: Creates a store, pushes one exec approval request, pushes a `ThreadClosed` notification, snapshots the store, and asserts no remaining event is a command-execution approval request.

**Call relations**: Indirectly exercises the `clear()` path triggered by `note_server_notification` on thread closure.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert!, exec_approval_request, thread_closed).


### `tui/src/app/thread_routing.rs`

`orchestration` · `main loop, thread switching, and app-server event routing`

This is the main orchestration layer for multi-thread behavior. It maintains `thread_event_channels`, the currently active receiver, and the relationship between visible thread state and backend subscriptions. Activation paths move an `mpsc::Receiver<ThreadBufferedEvent>` out of a `ThreadEventChannel`, mark the store active, and later stash the receiver plus captured composer state back into the channel when switching away. Incoming notifications and requests are buffered into each thread's `ThreadEventStore`, optionally forwarded live to the active receiver, and used to refresh badges such as pending approvals and side-parent status. The module also infers session snapshots for newly seen threads from `ThreadStarted` notifications, refreshes incomplete snapshots by calling `resume_thread`, and replays `ThreadEventSnapshot` contents into the chat widget when the user switches threads. On the command side, `submit_thread_op` first tries to resolve pending app-server requests, then dispatches supported `AppCommand` variants to concrete RPCs such as `turn_start`, `turn_steer`, `turn_interrupt`, rollback, review start, shell command execution, and thread settings updates. Several branches contain race recovery: interrupt and steer retry once when the server reports a different active turn than the local cache. The file also defines startup gating helpers, same-thread resume suppression, failover from unexpectedly closed non-primary threads back to the primary thread, and local message-history append/lookup tasks. Overall, it is where thread-local stores, app-server RPCs, and chat-widget replay/rendering are stitched into one coherent event loop.

#### Function details

##### `App::shutdown_current_thread`  (lines 11–20)

```
async fn shutdown_current_thread(&mut self, app_server: &mut AppServerSession)
```

**Purpose**: Unsubscribes the currently displayed thread from the app server and stops its listener task. It also clears any pending rollback guard because thread switching invalidates in-flight backtrack assumptions.

**Data flow**: It reads `self.chat_widget.thread_id()`, and if present sets `self.backtrack.pending_rollback = None`, awaits `app_server.thread_unsubscribe(thread_id)`, logs a warning on failure, and then calls `abort_thread_event_listener(thread_id)`. It returns no value.

**Call relations**: Used during thread switches or teardown. It delegates backend unsubscription to `AppServerSession` and local task cleanup to `abort_thread_event_listener`.

*Call graph*: calls 2 internal fn (abort_thread_event_listener, thread_unsubscribe); 1 external calls (warn!).


##### `App::abort_thread_event_listener`  (lines 22–26)

```
fn abort_thread_event_listener(&mut self, thread_id: ThreadId)
```

**Purpose**: Stops the background task responsible for listening to one thread's live events. It is a pure local cleanup operation.

**Data flow**: It removes the join handle for `thread_id` from `self.thread_event_listener_tasks`; if one existed, it calls `abort()` on the handle. No value is returned.

**Call relations**: Called by `shutdown_current_thread` and other cleanup paths when a thread should no longer have a live listener.

*Call graph*: called by 1 (shutdown_current_thread).


##### `App::abort_all_thread_event_listeners`  (lines 28–36)

```
fn abort_all_thread_event_listeners(&mut self)
```

**Purpose**: Aborts every registered thread event listener task. This is the bulk cleanup variant used when the app is tearing down or resetting routing state.

**Data flow**: It drains `self.thread_event_listener_tasks`, iterates over the removed handles, and aborts each one. It mutates only the task map and returns nothing.

**Call relations**: This is a top-level cleanup helper for broader shutdown/reset flows rather than single-thread switching.


##### `App::ensure_thread_channel`  (lines 38–42)

```
fn ensure_thread_channel(&mut self, thread_id: ThreadId) -> &mut ThreadEventChannel
```

**Purpose**: Returns the `ThreadEventChannel` for a thread, creating one on demand with the standard capacity. It is the canonical entry point for lazily materializing per-thread routing state.

**Data flow**: It indexes `self.thread_event_channels` by `thread_id` and inserts `ThreadEventChannel::new(THREAD_EVENT_CHANNEL_CAPACITY)` if absent, then returns a mutable reference to the channel.

**Call relations**: Called by notification/request/session enqueue paths and review-start handling whenever routing code needs a channel/store for a thread id.

*Call graph*: called by 5 (enqueue_primary_thread_session, enqueue_thread_history_entry_response, enqueue_thread_notification, enqueue_thread_request, try_submit_active_thread_op_via_app_server).


##### `App::set_thread_active`  (lines 44–49)

```
async fn set_thread_active(&mut self, thread_id: ThreadId, active: bool)
```

**Purpose**: Marks a thread store as active or inactive. This flag controls whether buffered events should also be forwarded live through the channel receiver.

**Data flow**: It looks up the channel for `thread_id`, locks `channel.store`, and writes `store.active = active` if the channel exists. It returns `()`.

**Call relations**: Used by activation and deactivation paths around thread switches so enqueue logic knows whether to live-send events.

*Call graph*: called by 2 (activate_thread_channel, clear_active_thread).


##### `App::activate_thread_channel`  (lines 51–64)

```
async fn activate_thread_channel(&mut self, thread_id: ThreadId)
```

**Purpose**: Promotes a thread channel to be the app's active live receiver. It transfers ownership of the channel receiver into `self.active_thread_rx` and refreshes approval badges.

**Data flow**: If `self.active_thread_id` is already set, it returns early. Otherwise it marks the thread active via `set_thread_active`, takes the optional receiver out of the channel if present, stores `Some(thread_id)` in `self.active_thread_id`, assigns the receiver to `self.active_thread_rx`, and awaits `refresh_pending_thread_approvals()`.

**Call relations**: Called when the primary thread session is first installed and by thread-switch flows elsewhere. It depends on `ensure_thread_channel` having already created the channel.

*Call graph*: calls 2 internal fn (refresh_pending_thread_approvals, set_thread_active); called by 1 (enqueue_primary_thread_session).


##### `App::store_active_thread_receiver`  (lines 66–80)

```
async fn store_active_thread_receiver(&mut self)
```

**Purpose**: Detaches the current active receiver and saves it back into the thread channel along with captured composer/input state. This preserves per-thread draft input across thread switches.

**Data flow**: It reads `self.active_thread_id`; if absent it returns. It captures `input_state` from `chat_widget.capture_thread_input_state()`, looks up the active channel, takes `self.active_thread_rx`, locks the store, sets `store.active = false`, stores `store.input_state = input_state`, and if a receiver was taken, puts it back into `channel.receiver`.

**Call relations**: Used during thread-switch orchestration before another thread is activated, so the old thread can later be replayed with its saved input state.


##### `App::activate_thread_for_replay`  (lines 82–92)

```
async fn activate_thread_for_replay(
        &mut self,
        thread_id: ThreadId,
    ) -> Option<(mpsc::Receiver<ThreadBufferedEvent>, ThreadEventSnapshot)>
```

**Purpose**: Detaches a thread's receiver and returns it together with a replay snapshot, preparing that thread to become visible. Unlike `activate_thread_channel`, it also hands the caller the snapshot needed to rebuild the UI.

**Data flow**: It looks up the channel for `thread_id`, returns `None` if missing or if the receiver is already absent, locks the store, sets `store.active = true`, computes `store.snapshot()`, and returns `Some((receiver, snapshot))`.

**Call relations**: Used by thread-switch code that needs both live event delivery and a replayable snapshot before swapping the visible thread.


##### `App::clear_active_thread`  (lines 94–100)

```
async fn clear_active_thread(&mut self)
```

**Purpose**: Clears the app's notion of an active thread and drops the active receiver. It also recomputes pending-approval badges because the active/inactive partition changed.

**Data flow**: If `self.active_thread_id.take()` yields an id, it marks that thread inactive via `set_thread_active`. It then sets `self.active_thread_rx = None` and awaits `refresh_pending_thread_approvals()`. No value is returned.

**Call relations**: Called when a receiver disconnects, rollback handling drains a dead channel, or failover logic cannot keep the current thread active.

*Call graph*: calls 2 internal fn (refresh_pending_thread_approvals, set_thread_active); called by 3 (drain_active_thread_events, handle_active_thread_event, handle_thread_rollback_response).


##### `App::note_thread_outbound_op`  (lines 102–108)

```
async fn note_thread_outbound_op(&mut self, thread_id: ThreadId, op: &AppCommand)
```

**Purpose**: Records an outbound command against a specific thread's replay store so pending interactive state can be updated. It is a thin wrapper around the store-level bookkeeping.

**Data flow**: It looks up the channel for `thread_id`; if absent it returns. Otherwise it locks the store and calls `store.note_outbound_op(op)`. It mutates only replay bookkeeping and returns `()`.

**Call relations**: Used after successful command submission or request resolution, either directly or via `note_active_thread_outbound_op`.

*Call graph*: called by 3 (note_active_thread_outbound_op, submit_thread_op, try_resolve_app_server_request).


##### `App::note_active_thread_outbound_op`  (lines 110–118)

```
async fn note_active_thread_outbound_op(&mut self, op: &AppCommand)
```

**Purpose**: Conditionally records an outbound command for the currently active thread, but only if that command can affect pending replay state. This avoids unnecessary locking for unrelated commands.

**Data flow**: It first checks `ThreadEventStore::op_can_change_pending_replay_state(op)` and returns early if false. It then reads `self.active_thread_id`; if present, it forwards the op to `note_thread_outbound_op(thread_id, op).await`.

**Call relations**: Called by higher-level command paths that operate on the active thread and want replay bookkeeping updated only when relevant.

*Call graph*: calls 2 internal fn (op_can_change_pending_replay_state, note_thread_outbound_op).


##### `App::active_turn_id_for_thread`  (lines 120–124)

```
async fn active_turn_id_for_thread(&self, thread_id: ThreadId) -> Option<String>
```

**Purpose**: Reads the cached active turn id for a thread from its event store. This supports interrupt and steer decisions without a fresh server read.

**Data flow**: It looks up the channel for `thread_id`, locks the store, calls `store.active_turn_id()`, clones the borrowed id into an owned `String`, and returns `Option<String>`.

**Call relations**: Used by `try_submit_active_thread_op_via_app_server` when deciding whether to interrupt/steer an existing turn or start a new one.

*Call graph*: called by 1 (try_submit_active_thread_op_via_app_server).


##### `App::thread_label`  (lines 126–151)

```
fn thread_label(&self, thread_id: ThreadId) -> String
```

**Purpose**: Computes the human-facing label for a thread, using agent metadata when available and falling back to main-thread or short-id labels otherwise. This label is shown in approval prompts and footer context.

**Data flow**: It compares `thread_id` to `self.primary_thread_id` to choose a fallback (`Main [default]` or `Agent (<short id>)`), then checks `self.agent_navigation` for metadata. If metadata exists it formats a label with `format_agent_picker_item_name`; if that result is the generic `Agent`, it appends the short id, otherwise it returns the formatted label. If no metadata exists it returns the fallback.

**Call relations**: Called when converting server requests into thread-scoped interactive UI requests and when aggregating pending-thread approval labels.

*Call graph*: called by 1 (interactive_request_for_thread_request); 3 external calls (format!, chars, to_string).


##### `App::current_displayed_thread_id`  (lines 159–161)

```
fn current_displayed_thread_id(&self) -> Option<ThreadId>
```

**Purpose**: Returns the thread whose transcript the user is effectively looking at. It prefers `active_thread_id` but falls back to the chat widget's thread id during transitions.

**Data flow**: It reads `self.active_thread_id` and, if absent, `self.chat_widget.thread_id()`, returning the first `Some(ThreadId)` found. No mutation occurs.

**Call relations**: Used by UI synchronization and stale-thread guards in other modules so rendering follows what is actually on screen.

*Call graph*: called by 1 (sync_active_agent_label).


##### `App::ignore_same_thread_resume`  (lines 163–176)

```
fn ignore_same_thread_resume(
        &mut self,
        target_session: &crate::resume_picker::SessionTarget,
    ) -> bool
```

**Purpose**: Detects and short-circuits resume requests that target the already active thread. Instead of reattaching, it emits an informational message and reports that the request was ignored.

**Data flow**: It compares `self.active_thread_id` to `target_session.thread_id`; if they differ it returns false. On a match it adds an info message `Already viewing <display label>.` to the chat widget and returns true.

**Call relations**: Called by resume orchestration before doing any backend work. Tests in `startup.rs` lock down both the active-thread and inactive-thread-visible cases.

*Call graph*: 1 external calls (format!).


##### `App::sync_active_agent_label`  (lines 184–190)

```
fn sync_active_agent_label(&mut self)
```

**Purpose**: Updates the footer's active-agent label to match the currently displayed thread and then refreshes related side-thread UI. It hides redundant labels in single-thread situations via `agent_navigation` policy.

**Data flow**: It computes a label from `self.agent_navigation.active_agent_label(self.current_displayed_thread_id(), self.primary_thread_id)`, writes that label into `chat_widget.set_active_agent_label`, and then calls `self.sync_side_thread_ui()`. It returns no value.

**Call relations**: Triggered after local agent-navigation metadata changes, especially from collaboration notifications cached by `cache_collab_receiver_threads_for_notification`.

*Call graph*: calls 1 internal fn (current_displayed_thread_id); called by 1 (cache_collab_receiver_threads_for_notification).


##### `App::thread_cwd`  (lines 192–196)

```
async fn thread_cwd(&self, thread_id: ThreadId) -> Option<AbsolutePathBuf>
```

**Purpose**: Returns the cached working directory for a thread from its session snapshot. This is used when building approval UIs that need a cwd context.

**Data flow**: It looks up the channel for `thread_id`, locks the store, and maps `store.session.as_ref()` to a cloned `cwd`, returning `Option<AbsolutePathBuf>`.

**Call relations**: Called by `interactive_request_for_thread_request` when constructing patch approval requests.

*Call graph*: called by 1 (interactive_request_for_thread_request).


##### `App::thread_file_change_changes`  (lines 198–207)

```
async fn thread_file_change_changes(
        &self,
        thread_id: ThreadId,
        turn_id: &str,
        item_id: &str,
    ) -> Option<Vec<codex_app_server_protocol::FileUpdateChange>>
```

**Purpose**: Looks up the file diff associated with a file-change approval request in a thread's store. It is an async wrapper around the store's synchronous search helper.

**Data flow**: It finds the channel for `thread_id`, locks the store, calls `store.file_change_changes(turn_id, item_id)`, and returns the resulting optional vector of `FileUpdateChange`s.

**Call relations**: Used only while converting `ServerRequest::FileChangeRequestApproval` into a displayable `ApprovalRequest::ApplyPatch`.

*Call graph*: called by 1 (interactive_request_for_thread_request).


##### `App::interactive_request_for_thread_request`  (lines 209–330)

```
async fn interactive_request_for_thread_request(
        &self,
        thread_id: ThreadId,
        request: &ServerRequest,
    ) -> std::io::Result<Option<ThreadInteractiveRequest>>
```

**Purpose**: Transforms selected app-server requests into TUI-native interactive request models for approvals, MCP elicitation forms, or app-link views. Unsupported requests return `None`.

**Data flow**: Inputs are a `thread_id` and borrowed `ServerRequest`. It first computes `thread_label = Some(self.thread_label(thread_id))`. For command-exec approvals it builds `ApprovalRequest::Exec`, deriving the approval id, splitting the command string, and synthesizing default decisions when the server omitted them. For file-change approvals it fetches cwd and file changes asynchronously and builds `ApprovalRequest::ApplyPatch`. For MCP elicitation it first tries `AppLinkViewParams::from_url_app_server_request`, then `McpServerElicitationFormRequest::from_app_server_request`, then falls back to a generic approval-style MCP prompt for form requests; URL requests that cannot be rendered are auto-declined by sending a resolve event through `app_event_tx` and returning `None`. For permissions approvals it localizes permissions via `try_into()`, returning an `io::Error` on localization failure, and otherwise builds `ApprovalRequest::Permissions`. Other request variants yield `Ok(None)`.

**Call relations**: Called when surfacing pending inactive-thread requests and when enqueueing a request for an inactive thread. It bridges raw protocol requests into the chat widget's interactive UI types.

*Call graph*: calls 5 internal fn (thread_cwd, thread_file_change_changes, thread_label, from_url_app_server_request, from_app_server_request); called by 2 (enqueue_thread_request, surface_pending_inactive_thread_interactive_requests); 3 external calls (AppLink, Approval, McpServerElicitation).


##### `App::push_thread_interactive_request`  (lines 332–346)

```
fn push_thread_interactive_request(&mut self, request: ThreadInteractiveRequest)
```

**Purpose**: Routes a prepared thread-interactive request into the appropriate chat-widget UI surface. Patch approvals also trigger a transcript preview for inactive threads.

**Data flow**: It matches on `ThreadInteractiveRequest`: `AppLink` opens an app-link view, `Approval` first calls `render_inactive_patch_preview(&request)` and then pushes the approval request into the chat widget, and `McpServerElicitation` pushes the elicitation request into the widget. It returns `()`.

**Call relations**: Used after `interactive_request_for_thread_request` succeeds, both for newly arrived inactive-thread requests and for replaying pending inactive requests.

*Call graph*: calls 1 internal fn (render_inactive_patch_preview); called by 2 (enqueue_thread_request, surface_pending_inactive_thread_interactive_requests).


##### `App::render_inactive_patch_preview`  (lines 348–363)

```
fn render_inactive_patch_preview(&mut self, request: &ApprovalRequest)
```

**Purpose**: Adds a history-cell patch preview when an approval request for an inactive thread includes file changes and a thread label. This gives the user immediate context before opening the approval UI.

**Data flow**: It pattern-matches the request; only `ApprovalRequest::ApplyPatch` is relevant. If `thread_label` is `None` or `changes` is empty it returns. Otherwise it creates a patch history cell with `history_cell::new_patch_event(changes.clone(), cwd)` and appends it to chat history via `chat_widget.add_to_history`.

**Call relations**: Called only from `push_thread_interactive_request` before the approval request is shown.

*Call graph*: called by 1 (push_thread_interactive_request); 1 external calls (new_patch_event).


##### `App::pending_inactive_thread_requests`  (lines 365–387)

```
async fn pending_inactive_thread_requests(&self) -> Vec<(ThreadId, ServerRequest)>
```

**Purpose**: Collects all replayable pending requests from inactive threads. The active thread is excluded because its requests are already handled directly in the visible UI.

**Data flow**: It clones `(ThreadId, Arc<Mutex<ThreadEventStore>>)` pairs out of `self.thread_event_channels`, iterates them, skips `self.active_thread_id`, locks each store, calls `store.pending_replay_requests()`, and extends a result vector with `(thread_id, request)` tuples. The vector is returned.

**Call relations**: Used by `surface_pending_inactive_thread_interactive_requests` to rebuild approval/input prompts for background threads.

*Call graph*: called by 1 (surface_pending_inactive_thread_interactive_requests); 1 external calls (new).


##### `App::surface_pending_inactive_thread_interactive_requests`  (lines 389–406)

```
async fn surface_pending_inactive_thread_interactive_requests(
        &mut self,
    ) -> Result<()>
```

**Purpose**: Pushes all currently pending interactive requests from inactive threads into the visible UI, unless a side-parent thread is already active. This is how background approvals bubble into the main view.

**Data flow**: It first checks `self.active_side_parent_thread_id()` and returns `Ok(())` if one exists. Otherwise it awaits `pending_inactive_thread_requests()`, converts each request with `interactive_request_for_thread_request`, and for each `Some(...)` result calls `push_thread_interactive_request`. Errors from request conversion are propagated.

**Call relations**: Called by higher-level UI refresh flows when the app needs to surface background-thread work. It composes the inactive-request collector, request conversion, and widget insertion.

*Call graph*: calls 3 internal fn (interactive_request_for_thread_request, pending_inactive_thread_requests, push_thread_interactive_request).


##### `App::submit_active_thread_op`  (lines 408–420)

```
async fn submit_active_thread_op(
        &mut self,
        app_server: &mut AppServerSession,
        op: AppCommand,
    ) -> Result<()>
```

**Purpose**: Submits an `AppCommand` against the currently active thread, or reports that no active thread exists. It is the convenience wrapper used by most UI-originated commands.

**Data flow**: It reads `self.active_thread_id`; if absent it adds an error message to the chat widget and returns `Ok(())`. Otherwise it forwards to `submit_thread_op(app_server, thread_id, op).await` and returns that result.

**Call relations**: This is the active-thread entry point above the more general `submit_thread_op`.

*Call graph*: calls 1 internal fn (submit_thread_op).


##### `App::submit_thread_op`  (lines 422–452)

```
async fn submit_thread_op(
        &mut self,
        app_server: &mut AppServerSession,
        thread_id: ThreadId,
        op: AppCommand,
    ) -> Result<()>
```

**Purpose**: Logs, resolves, or submits a thread-scoped command and then updates local replay/badge state when appropriate. It is the central command-dispatch wrapper for thread operations.

**Data flow**: It takes a target `thread_id` and owned `AppCommand`, logs it via `session_log::log_outbound_op`, then first awaits `try_resolve_app_server_request`; if that returns true, submission is complete. Otherwise it awaits `try_submit_active_thread_op_via_app_server`; if that returns true and the op can change pending replay state, it records the op with `note_thread_outbound_op`, refreshes pending approvals, and refreshes side-parent status. If neither path handled the command, it adds a `Not available in TUI yet for thread ...` error and returns `Ok(())`.

**Call relations**: Called by `submit_active_thread_op` and indirectly by many UI actions. It orchestrates request-resolution shortcuts, concrete app-server RPC submission, and local bookkeeping refreshes.

*Call graph*: calls 7 internal fn (op_can_change_pending_replay_state, note_thread_outbound_op, refresh_pending_thread_approvals, refresh_side_parent_status_from_store, try_resolve_app_server_request, try_submit_active_thread_op_via_app_server, log_outbound_op); called by 1 (submit_active_thread_op); 1 external calls (format!).


##### `App::append_message_history_entry`  (lines 455–471)

```
fn append_message_history_entry(&self, thread_id: ThreadId, text: String)
```

**Purpose**: Persists a prompt text into the local cross-session message history asynchronously. Failures are logged but do not block the UI.

**Data flow**: It builds a `codex_message_history::HistoryConfig` from the chat widget's codex-home and history config, then spawns a Tokio task that awaits `codex_message_history::append_entry(&text, thread_id, &history_config)`. If that async append fails, the task logs a warning with the thread id and error.

**Call relations**: Used after user submissions so prompt text can later be recalled independently of server-side thread history.

*Call graph*: calls 1 internal fn (new); 3 external calls (append_entry, spawn, warn!).


##### `App::lookup_message_history_entry`  (lines 474–505)

```
async fn lookup_message_history_entry(
        &mut self,
        thread_id: ThreadId,
        offset: usize,
        log_id: u64,
    ) -> Result<()>
```

**Purpose**: Fetches one local message-history entry for a thread and sends the result back into the app event loop. The actual lookup runs off the async runtime's blocking pool.

**Data flow**: It constructs a `HistoryConfig`, clones `app_event_tx`, and spawns an async task. That task runs `codex_message_history::lookup(log_id, offset, &history_config)` inside `spawn_blocking`, converts join failure into a warning and `None`, then sends `AppEvent::ThreadHistoryEntryResponse { thread_id, event: HistoryLookupResponse { offset, log_id, entry: entry_opt.map(|e| e.text) } }` through `app_event_tx`. The outer function returns `Ok(())` immediately.

**Call relations**: Called when the UI requests local prompt-history recall. It bridges blocking disk lookup back into the app's event-driven thread routing.

*Call graph*: calls 1 internal fn (new); 2 external calls (spawn, spawn_blocking).


##### `App::try_submit_active_thread_op_via_app_server`  (lines 507–735)

```
async fn try_submit_active_thread_op_via_app_server(
        &mut self,
        app_server: &mut AppServerSession,
        thread_id: ThreadId,
        op: &AppCommand,
    ) -> Result<bool>
```

**Purpose**: Implements the concrete app-server RPC mapping for supported `AppCommand` variants. It contains the detailed control flow for interrupts, turn steering/start, rollback, review creation, settings overrides, and several utility commands.

**Data flow**: It matches on `op`. `Interrupt` uses `active_turn_id_for_thread`; if a turn id exists it calls `turn_interrupt`, retrying once when `active_turn_interrupt_race` reports a mismatched active turn, otherwise it falls back to `startup_interrupt`. `UserTurn` first tries to steer an existing active turn with `turn_steer`; non-steerable-turn errors are converted into queueing or an error message, missing-turn races clear the cached active turn and fall through to starting a new turn, and expected-turn mismatches may update the cached active turn and retry once. Starting a new turn computes approvals reviewer and permissions override from config and calls `turn_start`. Other handled variants call their corresponding RPCs: `skills_list`, `thread_compact_start`, `thread_set_name`, `thread_rollback` plus local rollback handling, `review_start` plus creation/updating of a review thread channel's `active_turn_id`, `thread_background_terminals_clean`, `thread_shell_command`, `reload_user_config`, `sync_override_turn_context_settings`, and `thread_approve_guardian_denied_action`. It returns `Ok(true)` when a variant was handled, `Ok(false)` for unsupported commands, or propagates errors for failed RPCs.

**Call relations**: This function is called only from `submit_thread_op`. It is the main delegation point from abstract `AppCommand` values to concrete app-server methods and local post-processing.

*Call graph*: calls 18 internal fn (from_string, active_turn_id_for_thread, ensure_thread_channel, handle_skills_list_result, handle_thread_rollback_response, reload_user_config, review_start, skills_list, startup_interrupt, thread_approve_guardian_denied_action (+8 more)); called by 1 (submit_thread_op); 3 external calls (clone, turn_permissions_override_from_config, unreachable!).


##### `App::turn_permissions_override_from_config`  (lines 737–763)

```
fn turn_permissions_override_from_config(
        config: &Config,
        active_permission_profile: Option<&ActivePermissionProfile>,
        runtime_permission_profile_override: Option<&PermissionP
```

**Purpose**: Determines what permission override, if any, should be sent when starting a turn. It preserves server snapshot settings unless the active profile or a matching runtime override requires an explicit override.

**Data flow**: It takes the current `Config`, an optional `ActivePermissionProfile`, and an optional runtime `PermissionProfile` override. If an active profile exists, it returns `TurnPermissionsOverride::ActiveProfile(active_profile.clone())`. Otherwise it computes the effective permission profile from config, materializes any runtime override against workspace roots, and if that override equals the effective profile returns `LegacySandbox(effective_permission_profile)`; in all other cases it returns `Preserve`.

**Call relations**: Used inside the `UserTurn` branch of `try_submit_active_thread_op_via_app_server` to decide how much permission state to send to the backend.

*Call graph*: 2 external calls (ActiveProfile, LegacySandbox).


##### `App::handle_skills_list_result`  (lines 765–778)

```
fn handle_skills_list_result(
        &mut self,
        result: Result<SkillsListResponse>,
        failure_message: &str,
    )
```

**Purpose**: Normalizes the result of a skills-list RPC into either a successful response handler call or a logged/displayed error. It keeps the command-submission path concise.

**Data flow**: It matches on `result: Result<SkillsListResponse>`. On success it forwards the response to `handle_skills_list_response`. On error it logs a warning with `failure_message` and the formatted error, then adds an error message with the same text to the chat widget.

**Call relations**: Called from the `ListSkills` branch of `try_submit_active_thread_op_via_app_server`.

*Call graph*: calls 1 internal fn (handle_skills_list_response); called by 1 (try_submit_active_thread_op_via_app_server); 2 external calls (format!, warn!).


##### `App::try_resolve_app_server_request`  (lines 780–813)

```
async fn try_resolve_app_server_request(
        &mut self,
        app_server: &AppServerSession,
        thread_id: ThreadId,
        op: &AppCommand,
    ) -> Result<bool>
```

**Purpose**: Checks whether an outbound command should resolve a pending app-server interactive request instead of being submitted as a normal thread operation. Successful resolutions also update replay bookkeeping and badges.

**Data flow**: It asks `self.pending_app_server_requests.take_resolution(op)` for a resolution, converting any internal error into an eyre error. If there is no resolution it returns `Ok(false)`. Otherwise it awaits `app_server.resolve_server_request(resolution.request_id, resolution.result)`. On success, if the op can change pending replay state, it records the op with `note_thread_outbound_op`, refreshes pending approvals, and refreshes side-parent status, then returns `Ok(true)`. On RPC failure it adds an error message naming the thread and returns `Ok(false)`.

**Call relations**: This is the first branch inside `submit_thread_op`, allowing approval/input responses to short-circuit normal command submission.

*Call graph*: calls 5 internal fn (op_can_change_pending_replay_state, note_thread_outbound_op, refresh_pending_thread_approvals, refresh_side_parent_status_from_store, resolve_server_request); called by 1 (submit_thread_op); 1 external calls (format!).


##### `App::refresh_pending_thread_approvals`  (lines 815–844)

```
async fn refresh_pending_thread_approvals(&mut self)
```

**Purpose**: Recomputes the list of inactive threads that currently have pending approvals and pushes their labels into the chat widget. The active thread and active side-parent thread are excluded.

**Data flow**: It captures `side_parent_thread_id`, clones `(ThreadId, Arc<Mutex<ThreadEventStore>>)` pairs from `self.thread_event_channels`, iterates them, skips the active and side-parent threads, locks each store, and collects thread ids whose store reports `has_pending_thread_approvals()`. It sorts those ids by string form, maps them through `thread_label`, and passes the resulting labels to `chat_widget.set_pending_thread_approvals`.

**Call relations**: Called after activation changes, request/notification enqueueing, and outbound operations that may resolve approvals.

*Call graph*: called by 6 (activate_thread_channel, clear_active_thread, enqueue_thread_notification, enqueue_thread_request, submit_thread_op, try_resolve_app_server_request); 1 external calls (new).


##### `App::refresh_side_parent_status_from_store`  (lines 846–859)

```
async fn refresh_side_parent_status_from_store(&mut self, thread_id: ThreadId)
```

**Purpose**: Synchronizes one thread's side-parent pending status from its event store into the side-thread UI state. It clears the status when no pending input or approval remains.

**Data flow**: It looks up the channel for `thread_id`; if absent it returns. Otherwise it locks the store, reads `store.side_parent_pending_status()`, and then either calls `set_side_parent_status(thread_id, Some(status))` or `clear_side_parent_action_status(thread_id)` depending on whether a status was present.

**Call relations**: Called after outbound operations and request resolutions that may change pending interactive state for a side thread.

*Call graph*: called by 2 (submit_thread_op, try_resolve_app_server_request).


##### `App::enqueue_thread_notification`  (lines 861–919)

```
async fn enqueue_thread_notification(
        &mut self,
        thread_id: ThreadId,
        notification: ServerNotification,
    ) -> Result<()>
```

**Purpose**: Buffers a server notification into the target thread store, optionally forwards it live to the active receiver, updates cached session/settings metadata, and refreshes approval/side-parent UI state. It is the main ingress path for thread notifications.

**Data flow**: It first drops `ThreadSettingsUpdated` notifications for unknown non-primary threads once a primary thread exists, avoiding spurious channel creation. For settings updates it applies the settings to cached session state. It then tries to infer a session snapshot from the notification, ensures a thread channel, clones the sender and store, locks the store to install inferred session if missing, pushes the notification into the store, and captures `(guard.active, guard.side_parent_pending_status())`. If the thread is active it tries `sender.try_send(Notification(notification))`, falling back to a spawned async `send` on full channels and logging on closed channels. Finally it updates side-parent status either from pending status or from `SideParentStatusChange::for_notification`, refreshes pending approvals, and returns `Ok(())`.

**Call relations**: Called by primary-thread enqueue wrappers and by startup/session replay flows. It composes session inference, store buffering, live delivery, and UI badge maintenance.

*Call graph*: calls 4 internal fn (for_notification, ensure_thread_channel, infer_session_for_thread_notification, refresh_pending_thread_approvals); called by 2 (enqueue_primary_thread_notification, enqueue_primary_thread_session); 6 external calls (clone, clone, matches!, spawn, warn!, Notification).


##### `App::cache_collab_receiver_threads_for_notification`  (lines 927–965)

```
fn cache_collab_receiver_threads_for_notification(
        &mut self,
        notification: &ServerNotification,
    )
```

**Purpose**: Locally records thread ids referenced by collaboration notifications so the agent picker and footer can mention them without blocking on backend reads. It also records sub-agent activity summaries when available.

**Data flow**: It first checks whether the notification contains sub-agent activity display data; if so it records that activity in `agent_navigation`, calls `sync_active_agent_label`, and returns. Otherwise it extracts receiver thread ids, skips any marked not-found, parses each id with `ThreadId::from_string`, logs and skips invalid ids, ignores ids already present in `agent_navigation`, and inserts missing ones via `upsert_agent_picker_thread(..., is_closed = false)`.

**Call relations**: Called from `handle_thread_event_now` before the notification is rendered, so local navigation metadata stays ahead of or in sync with visible collaboration events.

*Call graph*: calls 2 internal fn (from_string, sync_active_agent_label); called by 1 (handle_thread_event_now); 1 external calls (warn!).


##### `App::infer_session_for_thread_notification`  (lines 967–998)

```
async fn infer_session_for_thread_notification(
        &mut self,
        thread_id: ThreadId,
        notification: &ServerNotification,
    ) -> Option<ThreadSessionState>
```

**Purpose**: Synthesizes a `ThreadSessionState` for a newly seen thread from a `ThreadStarted` notification plus the primary session template. This avoids an immediate backend read on the hot notification path.

**Data flow**: It returns `None` unless the notification is `ServerNotification::ThreadStarted` and `self.primary_session_configured` exists. Starting from a clone of the primary session, it rewrites `thread_id`, `thread_name`, `model_provider_id`, cwd/workspace-root retargeting, and `rollout_path`; it then tries `read_session_model(self.state_db.as_deref(), thread_id, rollout_path.as_deref()).await` to fill `session.model`, clearing the model if a rollout path exists but no model is found. It clears `message_history`, updates agent-navigation metadata from the notification, and returns `Some(session)`.

**Call relations**: Used by `enqueue_thread_notification` so a thread can have a minimally useful session snapshot before any explicit resume/read call.

*Call graph*: calls 1 internal fn (read_session_model); called by 1 (enqueue_thread_notification).


##### `App::enqueue_thread_request`  (lines 1000–1047)

```
async fn enqueue_thread_request(
        &mut self,
        thread_id: ThreadId,
        request: ServerRequest,
    ) -> Result<()>
```

**Purpose**: Buffers a server request into the target thread store, optionally forwards it live, and may immediately surface an interactive UI prompt when the request belongs to an inactive thread. It also updates side-parent and approval badges.

**Data flow**: If the target thread is inactive, it first tries to convert the request into a `ThreadInteractiveRequest` via `interactive_request_for_thread_request`. It then ensures a channel, clones sender/store, locks the store to `push_request(request.clone())`, and captures `(guard.active, guard.side_parent_pending_status())`. If active, it tries to send `ThreadBufferedEvent::Request` through the channel with the same full/closed fallback behavior as notifications. If inactive and no side-parent thread is active, it pushes any converted interactive request directly into the UI. It then sets side-parent status from either the store-derived pending status or `SideParentStatus::for_request(&request)`, refreshes pending approvals, and returns `Ok(())`.

**Call relations**: Called by primary-thread request wrappers and replay/session setup. It is the request-side counterpart to `enqueue_thread_notification`.

*Call graph*: calls 5 internal fn (for_request, ensure_thread_channel, interactive_request_for_thread_request, push_thread_interactive_request, refresh_pending_thread_approvals); called by 2 (enqueue_primary_thread_request, enqueue_primary_thread_session); 5 external calls (clone, clone, spawn, warn!, Request).


##### `App::enqueue_thread_history_entry_response`  (lines 1049–1091)

```
async fn enqueue_thread_history_entry_response(
        &mut self,
        thread_id: ThreadId,
        event: HistoryLookupResponse,
    ) -> Result<()>
```

**Purpose**: Buffers a local message-history lookup response into a thread and forwards it live if that thread is active. It uses the same bounded-buffer eviction semantics as other thread events.

**Data flow**: It ensures a channel, clones sender/store, locks the store, pushes `ThreadBufferedEvent::HistoryEntryResponse(event.clone())` onto `guard.buffer`, evicts the oldest event if over capacity, and if the evicted event was a request informs `pending_interactive_replay.note_evicted_server_request`. It records whether the store is active, then if active tries to send the history-response event through the channel with full/closed fallback logging. It returns `Ok(())`.

**Call relations**: Called when asynchronous local history lookups complete and by primary-thread session setup when draining pending primary events.

*Call graph*: calls 1 internal fn (ensure_thread_channel); called by 1 (enqueue_primary_thread_session); 5 external calls (clone, spawn, warn!, HistoryEntryResponse, clone).


##### `App::enqueue_primary_thread_session`  (lines 1093–1148)

```
async fn enqueue_primary_thread_session(
        &mut self,
        session: ThreadSessionState,
        turns: Vec<Turn>,
    ) -> Result<()>
```

**Purpose**: Installs the primary thread session and initial turns, activates its channel, replays history into the chat widget, and drains any notifications/requests that arrived before the primary thread was configured. This is the key startup attachment path.

**Data flow**: It takes a `ThreadSessionState` and `Vec<Turn>`, stores `primary_thread_id` and `primary_session_configured`, upserts the primary thread into agent navigation, ensures a channel, locks its store to `set_session(session.clone(), turns.clone())`, activates the channel, suppresses initial user-message submission, and hands the session to `chat_widget.handle_thread_session`. If there are turns, it emits begin/end replay-buffer app events around `chat_widget.replay_thread_turns(turns, ReplayKind::ResumeInitialMessages)`. It then drains `self.pending_primary_events` and re-enqueues each buffered notification, request, history response, or feedback event through the normal per-thread enqueue functions. Finally it unsuppresses initial submission and asks the chat widget to submit any pending initial user message.

**Call relations**: Called during startup once the primary thread is known. It ties together channel activation, transcript replay, and deferred-event draining.

*Call graph*: calls 5 internal fn (activate_thread_channel, enqueue_thread_history_entry_response, enqueue_thread_notification, enqueue_thread_request, ensure_thread_channel); 2 external calls (take, clone).


##### `App::enqueue_primary_thread_notification`  (lines 1150–1162)

```
async fn enqueue_primary_thread_notification(
        &mut self,
        notification: ServerNotification,
    ) -> Result<()>
```

**Purpose**: Routes a notification to the primary thread if it exists, or buffers it in `pending_primary_events` until startup finishes configuring the primary thread. This prevents early notifications from being lost.

**Data flow**: If `self.primary_thread_id` is `Some(thread_id)`, it forwards to `enqueue_thread_notification(thread_id, notification).await`. Otherwise it pushes `ThreadBufferedEvent::Notification(notification)` onto `self.pending_primary_events` and returns `Ok(())`.

**Call relations**: Used by startup-time event ingestion before `enqueue_primary_thread_session` has attached the primary thread.

*Call graph*: calls 1 internal fn (enqueue_thread_notification); 1 external calls (Notification).


##### `App::enqueue_primary_thread_request`  (lines 1164–1174)

```
async fn enqueue_primary_thread_request(
        &mut self,
        request: ServerRequest,
    ) -> Result<()>
```

**Purpose**: Routes a request to the primary thread if configured, or buffers it until the primary thread session is installed. It is the request-side startup buffer.

**Data flow**: If `self.primary_thread_id` exists it forwards to `enqueue_thread_request(thread_id, request).await`; otherwise it pushes `ThreadBufferedEvent::Request(request)` into `self.pending_primary_events` and returns `Ok(())`.

**Call relations**: Paired with `enqueue_primary_thread_notification` for startup buffering of primary-thread requests.

*Call graph*: calls 1 internal fn (enqueue_thread_request); 1 external calls (Request).


##### `App::refresh_snapshot_session_if_needed`  (lines 1176–1203)

```
async fn refresh_snapshot_session_if_needed(
        &mut self,
        app_server: &mut AppServerSession,
        thread_id: ThreadId,
        is_replay_only: bool,
        snapshot: &mut ThreadEvent
```

**Purpose**: Refreshes a thread snapshot from the app server before replay when the cached snapshot is incomplete and the thread is not replay-only. This fills in missing model/path data for inferred sessions.

**Data flow**: It checks `should_refresh_snapshot_session(thread_id, is_replay_only, snapshot)` and returns early if false. Otherwise it awaits `app_server.resume_thread(self.config.clone(), thread_id)`. On success it calls `apply_refreshed_snapshot_thread(thread_id, started, snapshot).await`; on failure it logs a warning with the thread id and error.

**Call relations**: Used during thread-switch replay preparation. It delegates the decision to `should_refresh_snapshot_session` and the state update to `apply_refreshed_snapshot_thread`.

*Call graph*: calls 3 internal fn (apply_refreshed_snapshot_thread, should_refresh_snapshot_session, resume_thread); 1 external calls (warn!).


##### `App::should_refresh_snapshot_session`  (lines 1205–1216)

```
fn should_refresh_snapshot_session(
        &self,
        thread_id: ThreadId,
        is_replay_only: bool,
        snapshot: &ThreadEventSnapshot,
    ) -> bool
```

**Purpose**: Decides whether a replay snapshot is incomplete enough to justify a backend refresh. Replay-only channels and side threads are intentionally excluded.

**Data flow**: It returns true only when `is_replay_only` is false, the thread id is not present in `self.side_threads`, and `snapshot.session` is absent or has an empty/whitespace model or missing `rollout_path`. It reads state only and does not mutate anything.

**Call relations**: Called by `refresh_snapshot_session_if_needed` before issuing a potentially expensive `resume_thread` RPC.

*Call graph*: called by 1 (refresh_snapshot_session_if_needed).


##### `App::apply_refreshed_snapshot_thread`  (lines 1218–1235)

```
async fn apply_refreshed_snapshot_thread(
        &mut self,
        thread_id: ThreadId,
        started: AppServerStartedThread,
        snapshot: &mut ThreadEventSnapshot,
    )
```

**Purpose**: Applies a freshly resumed thread snapshot to both the persistent store and the in-flight replay snapshot. It also prunes buffered events that should not survive the refresh.

**Data flow**: It destructures `AppServerStartedThread` into `session` and `turns`. If a channel exists for `thread_id`, it locks the store, calls `store.set_session(session.clone(), turns.clone())`, and then `store.rebase_buffer_after_session_refresh()`. It writes `snapshot.session = Some(session)`, `snapshot.turns = turns`, and retains only `ThreadEventStore::event_survives_session_refresh` in `snapshot.events`.

**Call relations**: Called only from `refresh_snapshot_session_if_needed` after a successful backend refresh.

*Call graph*: called by 1 (refresh_snapshot_session_if_needed).


##### `App::drain_active_thread_events`  (lines 1243–1270)

```
async fn drain_active_thread_events(&mut self, tui: &mut tui::Tui) -> Result<()>
```

**Purpose**: Non-blockingly drains all currently queued live events from the active thread receiver and applies them immediately. If the receiver has disconnected, it clears the active thread.

**Data flow**: It takes `self.active_thread_rx`, returning early if absent. It loops on `rx.try_recv()`: each event is passed to `handle_thread_event_now`, `Empty` breaks, and `Disconnected` marks a flag. If not disconnected it stores the receiver back into `self.active_thread_rx`; otherwise it awaits `clear_active_thread()`. If `self.backtrack_render_pending` is true it schedules a frame via `tui.frame_requester().schedule_frame()`. It returns `Ok(())`.

**Call relations**: Called from the main event loop to process live thread traffic without awaiting on the channel.

*Call graph*: calls 2 internal fn (clear_active_thread, handle_thread_event_now); 1 external calls (frame_requester).


##### `App::active_non_primary_shutdown_target`  (lines 1283–1296)

```
fn active_non_primary_shutdown_target(
        &self,
        notification: &ServerNotification,
    ) -> Option<(ThreadId, ThreadId)>
```

**Purpose**: Determines whether a `ThreadClosed` notification from the active thread should trigger failover back to the primary thread. User-requested shutdown completions are explicitly excluded.

**Data flow**: It returns `None` unless the notification is `ServerNotification::ThreadClosed`, both `active_thread_id` and `primary_thread_id` are set, the active thread is not `pending_shutdown_exit_thread_id`, and the active thread differs from the primary. In the eligible case it returns `Some((active_thread_id, primary_thread_id))`.

**Call relations**: Used by `handle_active_thread_event` before normal event handling so unexpected side-thread death can be handled as a routing transition.

*Call graph*: called by 1 (handle_active_thread_event); 1 external calls (matches!).


##### `App::replay_thread_snapshot`  (lines 1298–1347)

```
fn replay_thread_snapshot(
        &mut self,
        snapshot: ThreadEventSnapshot,
        resume_restored_queue: bool,
    )
```

**Purpose**: Rebuilds the visible chat state from a `ThreadEventSnapshot`, including session metadata, turns, buffered events, and saved input state. It suppresses noisy notices when replay contains pending interactive requests.

**Data flow**: It refreshes MCP startup expectations, decides whether to emit begin/end replay-buffer app events based on whether turns or events exist, and computes `suppress_replay_notices` from `replay_filter::snapshot_has_pending_interactive_request(&snapshot)`. If a session exists, it routes it to `handle_side_thread_session`, `handle_thread_session_quiet`, or `handle_thread_session` depending on side-thread membership and suppression mode. It suppresses queue autosend, restores saved input state, replays turns with `ReplayKind::ThreadSnapshot`, iterates buffered events and skips notice events when suppression is active, forwarding the rest to `handle_thread_event_replay`. It then ends buffering, unsuppresses autosend and initial submission, submits any pending initial message, optionally sends the next queued input, and refreshes the status line.

**Call relations**: Called during thread switches after a snapshot has been prepared, and works in tandem with `activate_thread_for_replay` and optional snapshot refresh.

*Call graph*: calls 3 internal fn (event_is_notice, snapshot_has_pending_interactive_request, handle_thread_event_replay).


##### `App::should_wait_for_initial_session`  (lines 1349–1354)

```
fn should_wait_for_initial_session(session_selection: &SessionSelection) -> bool
```

**Purpose**: Defines which startup session selections require the app to wait for primary-session configuration before processing active-thread events. Only fresh-start and exit selections are gated.

**Data flow**: It pattern-matches `session_selection` and returns true for `SessionSelection::StartFresh` or `SessionSelection::Exit`, false otherwise.

**Call relations**: Used by startup orchestration and covered by dedicated tests in `tests/startup.rs`.

*Call graph*: 1 external calls (matches!).


##### `App::should_prompt_for_paused_goal_after_startup_resume`  (lines 1356–1364)

```
fn should_prompt_for_paused_goal_after_startup_resume(
        session_selection: &SessionSelection,
        initial_prompt: &Option<String>,
        initial_images: &[PathBuf],
    ) -> bool
```

**Purpose**: Determines whether startup resume should trigger a paused-goal prompt. The prompt is reserved for quiet resumes with no initial prompt text and no startup images.

**Data flow**: It returns true only when `session_selection` matches `SessionSelection::Resume(_)`, `initial_prompt.is_none()`, and `initial_images.is_empty()`. It reads inputs only.

**Call relations**: Consulted by startup/resume flow before calling `maybe_prompt_resume_paused_goal_after_resume`; tests in `startup.rs` define the exact gate.

*Call graph*: 2 external calls (is_empty, matches!).


##### `App::should_handle_active_thread_events`  (lines 1366–1371)

```
fn should_handle_active_thread_events(
        waiting_for_initial_session_configured: bool,
        has_active_thread_receiver: bool,
    ) -> bool
```

**Purpose**: Combines startup waiting state and receiver presence into the final decision about whether active-thread events may be drained. It is a tiny but explicit startup gate.

**Data flow**: It returns `has_active_thread_receiver && !waiting_for_initial_session_configured`. No state is read beyond the arguments.

**Call relations**: Used by startup event-loop logic and validated by startup tests.


##### `App::should_stop_waiting_for_initial_session`  (lines 1373–1378)

```
fn should_stop_waiting_for_initial_session(
        waiting_for_initial_session_configured: bool,
        primary_thread_id: Option<ThreadId>,
    ) -> bool
```

**Purpose**: Determines when the startup waiting gate can be lifted. Waiting stops as soon as a primary thread id exists.

**Data flow**: It returns `waiting_for_initial_session_configured && primary_thread_id.is_some()`. It has no side effects.

**Call relations**: Used by startup orchestration to transition from initial buffering to normal active-thread event handling.


##### `App::handle_skills_list_response`  (lines 1381–1387)

```
fn handle_skills_list_response(&mut self, response: SkillsListResponse)
```

**Purpose**: Processes a successful skills-list response by extracting newly active load warnings and forwarding the full response to the chat widget. It keeps warning emission centralized.

**Data flow**: It clones the current cwd from the chat widget config, computes `errors_for_cwd(&cwd, &response)`, filters them through `self.skill_load_warnings.newly_active_errors(&errors)`, emits those warnings via `emit_skill_load_warnings(&self.app_event_tx, &errors)`, and then calls `chat_widget.handle_skills_list_response(response)`.

**Call relations**: Called only from `handle_skills_list_result` after a successful backend skills-list RPC.

*Call graph*: called by 1 (handle_skills_list_result).


##### `App::handle_thread_rollback_response`  (lines 1389–1421)

```
async fn handle_thread_rollback_response(
        &mut self,
        thread_id: ThreadId,
        num_turns: u32,
        response: &ThreadRollbackResponse,
    )
```

**Purpose**: Applies server-confirmed rollback state to the thread store, drains any stale queued live events for the active thread, and then completes local backtrack handling. This keeps replay state and transcript trimming aligned with the rollback.

**Data flow**: It looks up the channel for `thread_id`, locks the store, and calls `store.apply_thread_rollback(response)`. If the rolled-back thread is active and `self.active_thread_rx` exists, it temporarily takes the receiver and drains/discards all queued events until empty or disconnected; on disconnect it clears the active thread, otherwise it stores the receiver back. Finally it calls `handle_backtrack_rollback_succeeded(num_turns)`.

**Call relations**: Invoked from the `ThreadRollback` branch of `try_submit_active_thread_op_via_app_server` after a successful rollback RPC.

*Call graph*: calls 1 internal fn (clear_active_thread); called by 1 (try_submit_active_thread_op_via_app_server).


##### `App::handle_thread_event_now`  (lines 1423–1454)

```
fn handle_thread_event_now(&mut self, event: ThreadBufferedEvent)
```

**Purpose**: Immediately applies one buffered thread event to the visible UI and related local caches. It is used for live event draining rather than replay.

**Data flow**: It first computes `needs_refresh` for `TurnStarted` and `ThreadTokenUsageUpdated` notifications. It then matches the event: notifications are passed through `cache_collab_receiver_threads_for_notification` and `chat_widget.handle_server_notification(..., None)`; requests are only forwarded to `chat_widget.handle_server_request(..., None)` if `pending_app_server_requests.contains_server_request(&request)` still holds; history responses go to `chat_widget.handle_history_entry_response`; feedback submissions go to `handle_feedback_thread_event`. If `needs_refresh` is true it calls `refresh_status_line()`.

**Call relations**: Called by `drain_active_thread_events` and `handle_active_thread_event`. It is the live-event counterpart to `handle_thread_event_replay`.

*Call graph*: calls 1 internal fn (cache_collab_receiver_threads_for_notification); called by 2 (drain_active_thread_events, handle_active_thread_event); 1 external calls (matches!).


##### `App::handle_thread_event_replay`  (lines 1456–1471)

```
fn handle_thread_event_replay(&mut self, event: ThreadBufferedEvent)
```

**Purpose**: Replays one buffered thread event into the chat widget using replay semantics. Unlike live handling, it always forwards requests because the snapshot has already been filtered.

**Data flow**: It matches the `ThreadBufferedEvent` and forwards notifications and requests to the chat widget with `Some(ReplayKind::ThreadSnapshot)`, history responses to `handle_history_entry_response`, and feedback submissions to `handle_feedback_thread_event`. It returns `()`.

**Call relations**: Used only by `replay_thread_snapshot` while rebuilding the visible thread from a snapshot.

*Call graph*: called by 1 (replay_thread_snapshot).


##### `App::handle_active_thread_event`  (lines 1478–1539)

```
async fn handle_active_thread_event(
        &mut self,
        tui: &mut tui::Tui,
        app_server: &mut AppServerSession,
        event: ThreadBufferedEvent,
    ) -> Result<()>
```

**Purpose**: Processes a live event from the active thread while enforcing shutdown-intent routing. Unexpected side-thread shutdowns trigger failover to the primary thread before normal event handling.

**Data flow**: It first computes whether this event is the completion of a user-requested shutdown by checking for `ThreadClosed` on `self.pending_shutdown_exit_thread_id == self.active_thread_id`. If the event is a notification and `active_non_primary_shutdown_target(notification)` returns `(closed_thread_id, primary_thread_id)`, it marks the closed thread as closed in the picker, discards side-thread state if needed, attempts to switch back to the primary thread via `select_agent_thread` or `select_agent_thread_and_discard_side`, and then emits either an info message on success or clears the active thread plus emits an error on failure; in that case it returns early. Otherwise, if the event completed the tracked shutdown, it clears `pending_shutdown_exit_thread_id`, forwards the event to `handle_thread_event_now`, and schedules a frame if `backtrack_render_pending` is set.

**Call relations**: Called by the main event loop for active-thread events that need shutdown-aware routing rather than simple immediate handling.

*Call graph*: calls 3 internal fn (active_non_primary_shutdown_target, clear_active_thread, handle_thread_event_now); 3 external calls (frame_requester, format!, matches!).


##### `tests::config_with_workspace_profile`  (lines 1548–1559)

```
async fn config_with_workspace_profile() -> Config
```

**Purpose**: Builds a test `Config` whose default permissions use the built-in workspace profile. This fixture supports permission-override tests.

**Data flow**: It creates a temporary directory, feeds its path plus a `ConfigOverrides` with `default_permissions = Some(BUILT_IN_PERMISSION_PROFILE_WORKSPACE.to_string())` into `ConfigBuilder`, awaits `build()`, and returns the resulting `Config`.

**Call relations**: Used by the permission-override tests in this module to create a consistent baseline configuration.

*Call graph*: 3 external calls (default, default, tempdir).


##### `tests::turn_permissions_use_active_profile_when_available`  (lines 1562–1576)

```
async fn turn_permissions_use_active_profile_when_available()
```

**Purpose**: Verifies that an active permission profile takes precedence over all other permission override logic. The result should be `TurnPermissionsOverride::ActiveProfile`.

**Data flow**: It awaits `config_with_workspace_profile()`, extracts `active_permission_profile`, calls `App::turn_permissions_override_from_config(&config, active_permission_profile.as_ref(), None)`, and asserts equality with an `ActiveProfile` built from the workspace profile id.

**Call relations**: This test directly exercises the first branch of `turn_permissions_override_from_config`.

*Call graph*: 2 external calls (assert_eq!, config_with_workspace_profile).


##### `tests::turn_permissions_preserve_server_snapshot_without_local_override`  (lines 1579–1593)

```
async fn turn_permissions_preserve_server_snapshot_without_local_override()
```

**Purpose**: Checks that when there is no active profile and no runtime override, the app preserves the server's existing permission snapshot instead of sending a local override. This avoids unnecessary churn.

**Data flow**: It builds a workspace-profile config, mutates `config.permissions` to `PermissionProfile::read_only()`, calls `turn_permissions_override_from_config` with no active profile and no runtime override, and asserts the result is `TurnPermissionsOverride::Preserve`.

**Call relations**: This test covers the default/no-override branch of the permission override helper.

*Call graph*: calls 1 internal fn (read_only); 2 external calls (assert_eq!, config_with_workspace_profile).


##### `tests::turn_permissions_send_legacy_sandbox_for_local_override`  (lines 1596–1613)

```
async fn turn_permissions_send_legacy_sandbox_for_local_override()
```

**Purpose**: Verifies that when a runtime permission override matches the effective local profile, the app sends a legacy sandbox override to the server. This preserves compatibility with server-side snapshot semantics.

**Data flow**: It builds a workspace-profile config, sets the config permission profile to `workspace_write`, captures the effective permission profile, calls `turn_permissions_override_from_config` with that runtime override, and asserts the result is `TurnPermissionsOverride::LegacySandbox(effective_permission_profile)`.

**Call relations**: This test covers the branch where a runtime override should be materialized and sent explicitly.

*Call graph*: calls 1 internal fn (workspace_write); 2 external calls (assert_eq!, config_with_workspace_profile).


### Background side effects
This file offloads network and disk-heavy work into spawned tasks and returns their outcomes back through app events.

### `tui/src/app/background_requests.rs`

`io_transport` · `cross-cutting`

This module is the app’s asynchronous request toolbox. The `App` methods at the top are thin orchestration wrappers: they clone an `AppServerRequestHandle`, capture any needed context such as cwd, thread ID, feature flags, or request IDs, spawn a Tokio task, await a helper RPC function, normalize errors into strings, and send a typed `AppEvent` back to the main loop. That pattern is used for MCP inventory, account rate limits and token activity, rate-limit reset credits and consumption, add-credit nudges, startup skills, connectors, plugins, hooks, marketplace operations, plugin install/uninstall/detail, plugin mention refresh, hook trust writes, and feedback uploads.

Several methods contain important local policy. `mcp_inventory_request_thread_id` only forwards a thread ID when it is the active thread and not a closed agent thread, preventing stale agent context from leaking into inventory requests. `set_plugin_enabled` and `set_hook_enabled` coalesce repeated toggles by storing `pending_*_writes`; if a write is already in flight, only the latest desired state is queued, and completion handlers can spawn a follow-up write if needed. `handle_mcp_inventory_result` ignores results for non-visible threads, clears loading indicators in both widget and transcript overlay, and renders either an error, an empty-state cell, or a full MCP tools cell.

The lower half contains the actual RPC helpers. Each constructs a unique `RequestId::String` using `Uuid`, issues a typed `ClientRequest`, and wraps failures with context. Plugin helpers also hide CLI-only marketplaces (`openai-bundled`), split remote plugin catalogs into labeled sections with tailored next-step error messages, and normalize relative marketplace-add sources against the current cwd while preserving `#ref` or `@ref` suffixes. Feedback helpers package thread ID, optional rollout logs, and turn tags into `FeedbackUploadParams`. Test-only code converts flat `McpServerStatus` responses into per-server maps for MCP subsystem assertions.

#### Function details

##### `App::fetch_mcp_inventory`  (lines 36–55)

```
fn fetch_mcp_inventory(
        &mut self,
        app_server: &AppServerSession,
        detail: McpServerStatusDetail,
        thread_id: Option<ThreadId>,
    )
```

**Purpose**: Starts a background fetch of MCP server inventory and routes the result back as `AppEvent::McpInventoryLoaded`. It optionally scopes the request to the currently active thread when that thread is still eligible.

**Data flow**: Reads an `AppServerSession`, desired `McpServerStatusDetail`, and optional `ThreadId`; derives a request-scoped thread ID via `mcp_inventory_request_thread_id`, clones the request handle and event sender, spawns a task that awaits `fetch_all_mcp_server_statuses`, converts any error to `String`, and sends `AppEvent::McpInventoryLoaded { result, detail, thread_id }`.

**Call relations**: Triggered from the central event dispatcher when `AppEvent::FetchMcpInventory` arrives. It delegates thread-ID filtering to `App::mcp_inventory_request_thread_id` and the actual paginated RPC loop to `fetch_all_mcp_server_statuses`.

*Call graph*: calls 3 internal fn (mcp_inventory_request_thread_id, fetch_all_mcp_server_statuses, request_handle); 1 external calls (spawn).


##### `App::mcp_inventory_request_thread_id`  (lines 57–65)

```
fn mcp_inventory_request_thread_id(&self, thread_id: Option<ThreadId>) -> Option<ThreadId>
```

**Purpose**: Determines whether an MCP inventory request should include a thread ID. It suppresses thread scoping for inactive or closed agent threads.

**Data flow**: Takes `Option<ThreadId>` and returns the same ID only if it matches `self.active_thread_id` and `self.agent_navigation` either has no entry or reports `is_closed == false`; otherwise it returns `None`.

**Call relations**: Used only by `App::fetch_mcp_inventory` to avoid sending stale thread context to the app server.

*Call graph*: called by 1 (fetch_mcp_inventory).


##### `App::refresh_rate_limits`  (lines 74–97)

```
fn refresh_rate_limits(
        &mut self,
        app_server: &AppServerSession,
        origin: RateLimitRefreshOrigin,
    )
```

**Purpose**: Fetches account rate limits in the background and reports completion through `AppEvent::RateLimitsLoaded`. It applies a timeout only for post-consume refreshes, where responsiveness matters most.

**Data flow**: Captures a request handle, event sender, and `RateLimitRefreshOrigin`, spawns a task, builds the future from `fetch_account_rate_limits`, and either awaits it directly or wraps it in `tokio::time::timeout(RATE_LIMIT_RESET_REQUEST_TIMEOUT, ...)` for `ResetConsume`. The task converts transport/timeouts into `String` and sends `AppEvent::RateLimitsLoaded { origin, result }`.

**Call relations**: Called from the event dispatcher for `AppEvent::RefreshRateLimits`. The resulting event is later consumed in `App::handle_event` to update snapshots, status cards, and reset-credit UI.

*Call graph*: calls 2 internal fn (fetch_account_rate_limits, request_handle); 2 external calls (spawn, timeout).


##### `App::refresh_token_activity`  (lines 99–116)

```
fn refresh_token_activity(
        &mut self,
        app_server: &AppServerSession,
        request_id: u64,
    )
```

**Purpose**: Starts a timed background fetch of token-usage activity for the `/usage` UI. It ensures the request cannot hang indefinitely.

**Data flow**: Clones the request handle and event sender, spawns a task, wraps `fetch_account_token_activity` in `TOKEN_ACTIVITY_FETCH_TIMEOUT`, maps timeout or RPC errors to strings, and sends `AppEvent::TokenActivityLoaded { request_id, result }`.

**Call relations**: Invoked from the event dispatcher when token activity is requested. The completion event is later used to settle or defer insertion of the usage history cell.

*Call graph*: calls 2 internal fn (fetch_account_token_activity, request_handle); 2 external calls (spawn, timeout).


##### `App::refresh_rate_limit_reset_credits`  (lines 118–135)

```
fn refresh_rate_limit_reset_credits(
        &mut self,
        app_server: &AppServerSession,
        request_id: u64,
    )
```

**Purpose**: Fetches the current rate-limit reset credit summary in the background. It is used by the reset-credit popup flow.

**Data flow**: Captures request handle and sender, spawns a task, wraps `fetch_rate_limit_reset_credits` in `RATE_LIMIT_RESET_REQUEST_TIMEOUT`, converts timeout/RPC failures to strings, and emits `AppEvent::RateLimitResetCreditsLoaded { request_id, result }`.

**Call relations**: Started from `AppEvent::OpenRateLimitResetCredits`; the resulting event is handled in the main dispatcher to populate the popup.

*Call graph*: calls 2 internal fn (fetch_rate_limit_reset_credits, request_handle); 2 external calls (spawn, timeout).


##### `App::consume_rate_limit_reset_credit`  (lines 137–159)

```
fn consume_rate_limit_reset_credit(
        &mut self,
        app_server: &AppServerSession,
        request_id: u64,
        idempotency_key: String,
    )
```

**Purpose**: Consumes one reset credit asynchronously and reports the result back to the UI. It preserves the idempotency key in the completion event so the popup can correlate the response.

**Data flow**: Clones request handle and sender, spawns a task, wraps `consume_rate_limit_reset_credit_request(request_handle, idempotency_key.clone())` in a timeout, maps errors to strings, and sends `AppEvent::RateLimitResetCreditConsumed { request_id, idempotency_key, result }`.

**Call relations**: Triggered by `AppEvent::ConsumeRateLimitResetCredit`. On success, the event dispatcher follows up with a rate-limit refresh to show the updated credit balance.

*Call graph*: calls 2 internal fn (consume_rate_limit_reset_credit_request, request_handle); 2 external calls (spawn, timeout).


##### `App::send_add_credits_nudge_email`  (lines 161–174)

```
fn send_add_credits_nudge_email(
        &mut self,
        app_server: &AppServerSession,
        credit_type: AddCreditsNudgeCreditType,
    )
```

**Purpose**: Launches the add-credits nudge email RPC without blocking the UI. It reports only success or failure status back to the chat widget.

**Data flow**: Clones request handle and sender, spawns a task, awaits `send_add_credits_nudge_email(request_handle, credit_type)`, stringifies any error, and sends `AppEvent::AddCreditsNudgeEmailFinished { result }`.

**Call relations**: Started from the event dispatcher after the chat widget marks the request as in progress. The completion event is consumed to finish the request UI.

*Call graph*: calls 2 internal fn (send_add_credits_nudge_email, request_handle); 1 external calls (spawn).


##### `App::refresh_startup_skills`  (lines 183–193)

```
fn refresh_startup_skills(&mut self, app_server: &AppServerSession)
```

**Purpose**: Begins the initial skills-list fetch after startup without delaying the first frame. It lets the UI become interactive before skill metadata arrives.

**Data flow**: Captures request handle, event sender, and current config cwd, spawns a task, awaits `fetch_skills_list`, formats any error with alternate debug formatting, and sends `AppEvent::SkillsListLoaded { result }`.

**Call relations**: Used during startup orchestration. The main event loop later handles `SkillsListLoaded` through the normal skills-result path.

*Call graph*: calls 2 internal fn (fetch_skills_list, request_handle); 1 external calls (spawn).


##### `App::fetch_connectors_list`  (lines 195–214)

```
fn fetch_connectors_list(
        &mut self,
        app_server: &AppServerSession,
        force_refetch: bool,
    )
```

**Purpose**: Fetches the connectors/app list in the background, optionally forcing a refetch. It includes the currently displayed thread ID string when available.

**Data flow**: Reads `self.current_displayed_thread_id()`, converts it to `Option<String>`, clones request handle and sender, spawns a task, awaits `fetch_connectors_list(request_handle, force_refetch, thread_id)`, stringifies errors, and sends `AppEvent::ConnectorsLoaded { result, is_final: true }`.

**Call relations**: Called from `AppEvent::FetchConnectorsList`. It delegates the actual RPC to the free `fetch_connectors_list` helper and the UI update to the later completion event.

*Call graph*: calls 2 internal fn (fetch_connectors_list, request_handle); 1 external calls (spawn).


##### `App::fetch_plugins_list`  (lines 216–246)

```
fn fetch_plugins_list(&mut self, app_server: &AppServerSession, cwd: PathBuf)
```

**Purpose**: Loads the plugin list and, if successful, follows up with additional remote plugin sections. It also marks the plugin UI as loading immediately.

**Data flow**: Calls `self.chat_widget.on_plugins_list_fetch_started(cwd.clone())`, captures request handle, sender, cwd, and feature flags for plugin sharing and remote plugins, then spawns a task. The task awaits `fetch_plugins_list`, sends `AppEvent::PluginsLoaded`, and if that succeeded, awaits `fetch_additional_plugin_remote_sections` and sends `AppEvent::PluginRemoteSectionsLoaded` with marketplaces and section errors.

**Call relations**: Started from several UI flows, including explicit plugin refreshes and post-config-import refreshes. It delegates base list loading to the free `fetch_plugins_list` helper and remote-section fan-out to `fetch_additional_plugin_remote_sections`.

*Call graph*: calls 3 internal fn (fetch_additional_plugin_remote_sections, fetch_plugins_list, request_handle); 2 external calls (clone, spawn).


##### `App::fetch_hooks_list`  (lines 248–257)

```
fn fetch_hooks_list(&mut self, app_server: &AppServerSession, cwd: PathBuf)
```

**Purpose**: Fetches hook configuration data for a given cwd in the background. The result is returned as a single `HooksLoaded` event.

**Data flow**: Clones request handle and sender, spawns a task, awaits `crate::hooks_rpc::fetch_hooks_list(request_handle, cwd.clone())`, stringifies errors, and sends `AppEvent::HooksLoaded { cwd, result }`.

**Call relations**: Triggered by `AppEvent::FetchHooksList` and consumed later by the chat widget’s hooks UI.

*Call graph*: calls 2 internal fn (request_handle, fetch_hooks_list); 2 external calls (clone, spawn).


##### `App::fetch_plugin_detail`  (lines 259–273)

```
fn fetch_plugin_detail(
        &mut self,
        app_server: &AppServerSession,
        cwd: PathBuf,
        params: PluginReadParams,
    )
```

**Purpose**: Loads detailed metadata for one plugin asynchronously. It is used when opening or refreshing a plugin detail view.

**Data flow**: Captures request handle, sender, cwd, and `PluginReadParams`, spawns a task, awaits the free `fetch_plugin_detail` RPC helper, maps errors to strings, and sends `AppEvent::PluginDetailLoaded { cwd, result }`.

**Call relations**: Started from `AppEvent::FetchPluginDetail` and also after successful installs when the detail view should refresh.

*Call graph*: calls 2 internal fn (fetch_plugin_detail, request_handle); 1 external calls (spawn).


##### `App::fetch_marketplace_add`  (lines 275–295)

```
fn fetch_marketplace_add(
        &mut self,
        app_server: &AppServerSession,
        cwd: PathBuf,
        source: String,
    )
```

**Purpose**: Adds a plugin marketplace source in the background and reports the result with enough context to update the originating UI. It preserves both cwd and source string for the completion event.

**Data flow**: Clones request handle and sender, captures `cwd` and `source` for both request and event payloads, spawns a task, awaits the free `fetch_marketplace_add` helper, rewrites any error as `Failed to add marketplace: ...`, and sends `AppEvent::MarketplaceAddLoaded { cwd, source, result }`.

**Call relations**: Triggered by `AppEvent::FetchMarketplaceAdd`. The completion event may cause a plugin list refresh if the add succeeded in the currently viewed cwd.

*Call graph*: calls 2 internal fn (fetch_marketplace_add, request_handle); 2 external calls (clone, spawn).


##### `App::fetch_marketplace_remove`  (lines 297–319)

```
fn fetch_marketplace_remove(
        &mut self,
        app_server: &AppServerSession,
        cwd: PathBuf,
        marketplace_name: String,
        marketplace_display_name: String,
    )
```

**Purpose**: Removes a marketplace asynchronously and returns the result along with display metadata for the confirmation/loading UI. It keeps the user-facing marketplace name available even after the request completes.

**Data flow**: Captures request handle, sender, cwd, marketplace name, and display name, spawns a task, awaits `fetch_marketplace_remove`, maps errors to `Failed to remove marketplace: ...`, and sends `AppEvent::MarketplaceRemoveLoaded` with all original context plus the result.

**Call relations**: Started from `AppEvent::FetchMarketplaceRemove`; successful completion can trigger plugin mention refresh and plugin list reload.

*Call graph*: calls 2 internal fn (fetch_marketplace_remove, request_handle); 2 external calls (clone, spawn).


##### `App::fetch_marketplace_upgrade`  (lines 321–339)

```
fn fetch_marketplace_upgrade(
        &mut self,
        app_server: &AppServerSession,
        cwd: PathBuf,
        marketplace_name: Option<String>,
    )
```

**Purpose**: Runs a marketplace upgrade in the background, either for one marketplace or all marketplaces. It reports completion with the cwd so the plugin UI can refresh appropriately.

**Data flow**: Clones request handle and sender, captures cwd and optional marketplace name, spawns a task, awaits `fetch_marketplace_upgrade`, maps errors to `Failed to upgrade marketplace: ...`, and sends `AppEvent::MarketplaceUpgradeLoaded { cwd, result }`.

**Call relations**: Triggered by `AppEvent::FetchMarketplaceUpgrade`. The completion handler may refresh plugin mentions if marketplace contents changed.

*Call graph*: calls 2 internal fn (fetch_marketplace_upgrade, request_handle); 2 external calls (clone, spawn).


##### `App::fetch_plugin_install`  (lines 341–366)

```
fn fetch_plugin_install(
        &mut self,
        app_server: &AppServerSession,
        cwd: PathBuf,
        location: PluginLocation,
        plugin_name: String,
        plugin_display_name: Str
```

**Purpose**: Installs a plugin asynchronously from either a local or remote marketplace location. It preserves enough context for the completion handler to refresh both list and detail views.

**Data flow**: Captures request handle, sender, cwd, `PluginLocation`, plugin name, and display name, spawns a task, awaits `fetch_plugin_install`, maps errors to `Failed to install plugin: ...`, and sends `AppEvent::PluginInstallLoaded` with the original context and result.

**Call relations**: Started from `AppEvent::FetchPluginInstall`. The completion event may refresh plugin mentions, plugin lists, and plugin detail depending on success and current cwd.

*Call graph*: calls 2 internal fn (fetch_plugin_install, request_handle); 3 external calls (clone, spawn, clone).


##### `App::fetch_plugin_uninstall`  (lines 368–390)

```
fn fetch_plugin_uninstall(
        &mut self,
        app_server: &AppServerSession,
        cwd: PathBuf,
        plugin_id: String,
        plugin_display_name: String,
    )
```

**Purpose**: Uninstalls a plugin in the background and reports the result with cwd and display metadata. It supports the uninstall confirmation/loading flow.

**Data flow**: Clones request handle and sender, captures cwd, plugin ID, and display name, spawns a task, awaits `fetch_plugin_uninstall`, maps errors to `Failed to uninstall plugin: ...`, and sends `AppEvent::PluginUninstallLoaded { cwd, plugin_id, plugin_display_name, result }`.

**Call relations**: Triggered by `AppEvent::FetchPluginUninstall`; successful completion can refresh plugin mentions and the plugin list.

*Call graph*: calls 2 internal fn (fetch_plugin_uninstall, request_handle); 2 external calls (clone, spawn).


##### `App::set_plugin_enabled`  (lines 392–407)

```
fn set_plugin_enabled(
        &mut self,
        app_server: &AppServerSession,
        cwd: PathBuf,
        plugin_id: String,
        enabled: bool,
    )
```

**Purpose**: Queues or starts a plugin-enabled config write while coalescing rapid repeated toggles. It ensures only one write per plugin is in flight at a time.

**Data flow**: Checks `self.pending_plugin_enabled_writes` for `plugin_id`. If a write is already pending, it stores `Some(enabled)` as the queued desired state and returns. Otherwise it inserts `None` to mark an in-flight write and calls `spawn_plugin_enabled_write`.

**Call relations**: Called from the event dispatcher for `AppEvent::SetPluginEnabled`. Completion handling in `App::handle_event` consults the same pending map to decide whether to apply the result or immediately launch a follow-up write.

*Call graph*: calls 1 internal fn (spawn_plugin_enabled_write).


##### `App::spawn_plugin_enabled_write`  (lines 409–432)

```
fn spawn_plugin_enabled_write(
        &mut self,
        app_server: &AppServerSession,
        cwd: PathBuf,
        plugin_id: String,
        enabled: bool,
    )
```

**Purpose**: Performs the actual asynchronous plugin-enabled config write and emits a completion event. It is separated from `set_plugin_enabled` so retries can reuse the same spawn logic.

**Data flow**: Clones request handle and sender, captures cwd, plugin ID, and enabled flag, spawns a task, awaits `write_plugin_enabled`, maps success to `()` and errors to `Failed to update plugin config: ...`, and sends `AppEvent::PluginEnabledSet { cwd, plugin_id, enabled, result }`.

**Call relations**: Called initially by `App::set_plugin_enabled` and again by the event dispatcher when a queued plugin toggle must be replayed after an earlier write completes.

*Call graph*: calls 2 internal fn (write_plugin_enabled, request_handle); called by 1 (set_plugin_enabled); 2 external calls (clone, spawn).


##### `App::set_hook_enabled`  (lines 434–447)

```
fn set_hook_enabled(
        &mut self,
        app_server: &AppServerSession,
        key: String,
        enabled: bool,
    )
```

**Purpose**: Queues or starts a hook-enabled config write with the same coalescing strategy used for plugins. It prevents overlapping writes for the same hook key.

**Data flow**: Looks up `self.pending_hook_enabled_writes[key]`; if present, replaces it with `Some(enabled)` and returns. Otherwise inserts `None` and calls `spawn_hook_enabled_write`.

**Call relations**: Triggered by `AppEvent::SetHookEnabled`. The completion branch in the event dispatcher uses the pending map to decide whether to apply the result or launch another write.

*Call graph*: calls 1 internal fn (spawn_hook_enabled_write).


##### `App::spawn_hook_enabled_write`  (lines 449–474)

```
fn spawn_hook_enabled_write(
        &mut self,
        app_server: &AppServerSession,
        key: String,
        enabled: bool,
    )
```

**Purpose**: Runs the asynchronous hook-enabled config write and emits `HookEnabledSet`. It formats config errors through the shared config-error helper.

**Data flow**: Clones request handle and sender, captures hook key and enabled flag, spawns a task, awaits `write_hook_enabled`, maps success to `()`, formats failures as `Failed to update hook config: ...`, and sends `AppEvent::HookEnabledSet { key, enabled, result }`.

**Call relations**: Called by `App::set_hook_enabled` and by the event dispatcher when a queued hook toggle needs to be replayed.

*Call graph*: calls 2 internal fn (write_hook_enabled, request_handle); called by 1 (set_hook_enabled); 1 external calls (spawn).


##### `App::trust_hook`  (lines 476–491)

```
fn trust_hook(
        &mut self,
        app_server: &AppServerSession,
        key: String,
        current_hash: String,
    )
```

**Purpose**: Writes trust for a single hook hash in the background. It reports only success or a formatted config error.

**Data flow**: Clones request handle and sender, spawns a task, awaits `write_hook_trust(request_handle, key, current_hash)`, maps success to `()`, formats failures as `Failed to trust hook: ...`, and sends `AppEvent::HookTrusted { result }`.

**Call relations**: Started from `AppEvent::TrustHook`; the completion event is handled centrally to surface any error.

*Call graph*: calls 2 internal fn (request_handle, write_hook_trust); 1 external calls (spawn).


##### `App::trust_hooks`  (lines 493–507)

```
fn trust_hooks(
        &mut self,
        app_server: &AppServerSession,
        updates: Vec<HookTrustUpdate>,
    )
```

**Purpose**: Writes trust updates for multiple hooks in one background operation. It is the batch counterpart to `trust_hook`.

**Data flow**: Clones request handle and sender, spawns a task, awaits `write_hook_trusts(request_handle, updates)`, maps success to `()`, formats failures as `Failed to trust hooks: ...`, and sends `AppEvent::HookTrusted { result }`.

**Call relations**: Triggered by `AppEvent::TrustHooks`; the same `HookTrusted` completion path handles both single and batch trust writes.

*Call graph*: calls 2 internal fn (request_handle, write_hook_trusts); 1 external calls (spawn).


##### `App::refresh_plugin_mentions`  (lines 509–530)

```
fn refresh_plugin_mentions(&mut self, app_server: &AppServerSession)
```

**Purpose**: Refreshes the lightweight plugin-mention candidate list used by the chat UI. If the Plugins feature is disabled, it immediately clears mention candidates instead of making an RPC.

**Data flow**: Reads current cwd, request handle, sender, and feature flags. If `Feature::Plugins` is disabled, it sends `AppEvent::PluginMentionsLoaded { plugins: None }` synchronously and returns. Otherwise it spawns a task that awaits `fetch_plugin_mentions`, sends `PluginMentionsLoaded { plugins: Some(plugins) }` on success, and logs a warning on failure without emitting an error event.

**Call relations**: Called from explicit refresh events and after config/plugin changes. It delegates the actual mention extraction to `plugin_mentions::fetch_plugin_mentions`.

*Call graph*: calls 2 internal fn (fetch_plugin_mentions, request_handle); 2 external calls (spawn, warn!).


##### `App::submit_feedback`  (lines 532–568)

```
fn submit_feedback(
        &mut self,
        app_server: &AppServerSession,
        category: FeedbackCategory,
        reason: Option<String>,
        turn_id: Option<String>,
        include_logs:
```

**Purpose**: Packages feedback metadata and uploads it asynchronously. It preserves the originating thread so success/failure can be routed back into the correct transcript.

**Data flow**: Reads the current thread ID and, if `include_logs` is true, the rollout path from `chat_widget`; builds `FeedbackUploadParams` via `build_feedback_upload_params`; clones request handle and sender; spawns a task that awaits `fetch_feedback_upload`, maps success to the returned feedback thread ID string, stringifies errors, and sends `AppEvent::FeedbackSubmitted { origin_thread_id, category, include_logs, result }`.

**Call relations**: Triggered by `AppEvent::SubmitFeedback`. The completion event is handled by `App::handle_feedback_submitted`, which either inserts feedback status into the current transcript or enqueues it for another thread.

*Call graph*: calls 3 internal fn (build_feedback_upload_params, fetch_feedback_upload, request_handle); 1 external calls (spawn).


##### `App::handle_feedback_thread_event`  (lines 570–587)

```
fn handle_feedback_thread_event(&mut self, event: FeedbackThreadEvent)
```

**Purpose**: Renders the final feedback-upload outcome into chat history for the current thread. Success produces a specialized success cell; failure produces a generic error event.

**Data flow**: Consumes a `FeedbackThreadEvent`. On `Ok(thread_id)` it builds a success history cell with `feedback_success_cell` using category, include-logs flag, returned thread ID, and audience, then adds it to history. On `Err(err)` it formats `Failed to upload feedback: {err}` and inserts an error history cell.

**Call relations**: Called by `App::handle_feedback_submitted` when the feedback originated from the currently active/global context rather than another thread’s buffered event stream.

*Call graph*: called by 1 (handle_feedback_submitted); 3 external calls (feedback_success_cell, format!, new_error_event).


##### `App::enqueue_thread_feedback_event`  (lines 589–630)

```
async fn enqueue_thread_feedback_event(
        &mut self,
        thread_id: ThreadId,
        event: FeedbackThreadEvent,
    )
```

**Purpose**: Buffers a feedback result into another thread’s event channel and replay store. It preserves feedback notifications for inactive threads and handles bounded-buffer eviction bookkeeping.

**Data flow**: Ensures a thread channel exists, clones its sender and store, locks the store, pushes `ThreadBufferedEvent::FeedbackSubmission(event.clone())` into the buffer, evicts the oldest entry if capacity is exceeded, and if the evicted entry was a buffered request, records that eviction in `pending_interactive_replay`. It then checks whether the thread channel is active; if so, it tries `sender.try_send`, falls back to spawning an async `send` on `Full`, and logs warnings on closed channels.

**Call relations**: Called by `App::handle_feedback_submitted` when feedback belongs to a non-current thread. It mirrors the buffering behavior used for other per-thread events so replay state stays consistent.

*Call graph*: called by 1 (handle_feedback_submitted); 5 external calls (clone, spawn, warn!, clone, FeedbackSubmission).


##### `App::handle_feedback_submitted`  (lines 632–650)

```
async fn handle_feedback_submitted(
        &mut self,
        origin_thread_id: Option<ThreadId>,
        category: FeedbackCategory,
        include_logs: bool,
        result: Result<String, String
```

**Purpose**: Routes a completed feedback upload either to the current transcript or to the originating thread’s buffered event stream. It centralizes the thread-aware delivery decision.

**Data flow**: Builds a `FeedbackThreadEvent` from `origin_thread_id`, category, include-logs flag, current `self.feedback_audience`, and the upload result. If `origin_thread_id` is `Some`, it awaits `enqueue_thread_feedback_event`; otherwise it calls `handle_feedback_thread_event` directly.

**Call relations**: Invoked by the main event dispatcher when `AppEvent::FeedbackSubmitted` arrives from the background upload task.

*Call graph*: calls 2 internal fn (enqueue_thread_feedback_event, handle_feedback_thread_event).


##### `App::handle_mcp_inventory_result`  (lines 657–689)

```
fn handle_mcp_inventory_result(
        &mut self,
        result: Result<Vec<McpServerStatus>, String>,
        detail: McpServerStatusDetail,
        thread_id: Option<ThreadId>,
    )
```

**Purpose**: Finalizes the MCP inventory loading UI and renders the result into history if it still applies to the currently displayed thread. It handles stale results, errors, empty inventories, and populated inventories distinctly.

**Data flow**: Accepts `Result<Vec<McpServerStatus>, String>`, detail level, and optional thread ID. If the result is for a non-visible thread, it returns immediately. Otherwise it clears MCP loading indicators in both chat widget and transcript overlay, then on error adds `Failed to load MCP inventory: ...`; on an empty status list inserts `history_cell::empty_mcp_output()`; and on success inserts `history_cell::new_mcp_tools_output_from_statuses(&statuses, detail)`.

**Call relations**: Called from the event dispatcher on `AppEvent::McpInventoryLoaded`. It relies on `clear_committed_mcp_inventory_loading` to remove any committed loading cell before rendering the final state.

*Call graph*: calls 1 internal fn (clear_committed_mcp_inventory_loading); 3 external calls (format!, empty_mcp_output, new_mcp_tools_output_from_statuses).


##### `App::clear_committed_mcp_inventory_loading`  (lines 691–704)

```
fn clear_committed_mcp_inventory_loading(&mut self)
```

**Purpose**: Removes the most recent committed MCP inventory loading cell from the transcript and overlay. It keeps the transcript consistent once a fetch settles.

**Data flow**: Searches `self.transcript_cells` from the end for a cell whose dynamic type is `history_cell::McpInventoryLoadingCell`; if found, removes it and, if the current overlay is a transcript overlay, replaces the overlay’s cells with the updated transcript clone.

**Call relations**: Used by `App::handle_mcp_inventory_result` immediately before inserting the final MCP inventory output.

*Call graph*: called by 1 (handle_mcp_inventory_result).


##### `fetch_all_mcp_server_statuses`  (lines 707–739)

```
async fn fetch_all_mcp_server_statuses(
    request_handle: AppServerRequestHandle,
    detail: McpServerStatusDetail,
    thread_id: Option<ThreadId>,
) -> Result<Vec<McpServerStatus>>
```

**Purpose**: Fetches all pages of MCP server status data from the app server. It loops until `next_cursor` is absent and concatenates all returned `data` entries.

**Data flow**: Takes an `AppServerRequestHandle`, detail level, and optional `ThreadId`; converts the thread ID to `Option<String>`, initializes `cursor = None` and `statuses = Vec::new()`, then repeatedly issues `ClientRequest::McpServerStatusList` with a fresh string request ID, `limit: Some(100)`, the current cursor, detail, and thread ID. Each response’s `data` is appended to `statuses`; `next_cursor` drives the loop; the final vector is returned or an eyre-wrapped error is propagated.

**Call relations**: Called only by `App::fetch_mcp_inventory` inside a spawned task. It encapsulates the pagination logic so the app method only has to launch the background work.

*Call graph*: calls 1 internal fn (request_typed); called by 1 (fetch_mcp_inventory); 3 external calls (new, String, format!).


##### `fetch_account_rate_limits`  (lines 741–752)

```
async fn fetch_account_rate_limits(
    request_handle: AppServerRequestHandle,
) -> Result<GetAccountRateLimitsResponse>
```

**Purpose**: Issues the typed RPC to read account rate limits. It is the low-level transport helper behind rate-limit refreshes.

**Data flow**: Builds a unique string `RequestId`, sends `ClientRequest::GetAccountRateLimits { params: None }` through `request_handle.request_typed`, and returns the typed `GetAccountRateLimitsResponse` or a wrapped error.

**Call relations**: Used by `App::refresh_rate_limits` and indirectly by reset-credit refresh flows.

*Call graph*: calls 1 internal fn (request_typed); called by 1 (refresh_rate_limits); 2 external calls (String, format!).


##### `fetch_account_token_activity`  (lines 754–765)

```
async fn fetch_account_token_activity(
    request_handle: AppServerRequestHandle,
) -> Result<codex_app_server_protocol::GetAccountTokenUsageResponse>
```

**Purpose**: Reads account token-usage activity from the app server. It is the transport helper for the `/usage` token activity view.

**Data flow**: Constructs a unique request ID, sends `ClientRequest::GetAccountTokenUsage { params: None }`, and returns the typed token-usage response or a wrapped error.

**Call relations**: Called by `App::refresh_token_activity` inside a timeout-wrapped background task.

*Call graph*: calls 1 internal fn (request_typed); called by 1 (refresh_token_activity); 2 external calls (String, format!).


##### `fetch_rate_limit_reset_credits`  (lines 767–783)

```
async fn fetch_rate_limit_reset_credits(
    request_handle: AppServerRequestHandle,
) -> Result<RateLimitResetCreditsSummary>
```

**Purpose**: Extracts the `rate_limit_reset_credits` field from the account rate-limits response and errors if the field is absent. It narrows a broader response into the specific summary needed by the reset-credit UI.

**Data flow**: Sends `ClientRequest::GetAccountRateLimits`, awaits a `GetAccountRateLimitsResponse`, then returns `response.rate_limit_reset_credits` if present or constructs an eyre error stating the response omitted `rateLimitResetCredits`.

**Call relations**: Used by `App::refresh_rate_limit_reset_credits`; unlike `fetch_account_rate_limits`, it enforces the presence of the reset-credit subfield.

*Call graph*: calls 1 internal fn (request_typed); called by 1 (refresh_rate_limit_reset_credits); 2 external calls (String, format!).


##### `consume_rate_limit_reset_credit_request`  (lines 785–797)

```
async fn consume_rate_limit_reset_credit_request(
    request_handle: AppServerRequestHandle,
    idempotency_key: String,
) -> Result<ConsumeAccountRateLimitResetCreditResponse>
```

**Purpose**: Performs the RPC that consumes one rate-limit reset credit. It is the transport helper behind the consume-credit popup flow.

**Data flow**: Builds a unique request ID, sends `ClientRequest::ConsumeAccountRateLimitResetCredit` with `ConsumeAccountRateLimitResetCreditParams { idempotency_key }`, and returns the typed consume response or a wrapped error.

**Call relations**: Called by `App::consume_rate_limit_reset_credit` inside a timeout-wrapped spawned task.

*Call graph*: calls 1 internal fn (request_typed); called by 1 (consume_rate_limit_reset_credit); 2 external calls (String, format!).


##### `send_add_credits_nudge_email`  (lines 799–813)

```
async fn send_add_credits_nudge_email(
    request_handle: AppServerRequestHandle,
    credit_type: AddCreditsNudgeCreditType,
) -> Result<codex_app_server_protocol::AddCreditsNudgeEmailStatus>
```

**Purpose**: Sends the add-credits nudge email request and returns only the resulting status enum. It hides the full response wrapper from callers.

**Data flow**: Creates a unique request ID, sends `ClientRequest::SendAddCreditsNudgeEmail` with `SendAddCreditsNudgeEmailParams { credit_type }`, awaits the typed response, and returns `response.status` or a wrapped error.

**Call relations**: Used by `App::send_add_credits_nudge_email` in the background task launched from the event dispatcher.

*Call graph*: calls 1 internal fn (request_typed); called by 1 (send_add_credits_nudge_email); 2 external calls (String, format!).


##### `fetch_skills_list`  (lines 815–832)

```
async fn fetch_skills_list(
    request_handle: AppServerRequestHandle,
    cwd: PathBuf,
) -> Result<SkillsListResponse>
```

**Purpose**: Loads the skills list for a single cwd with `force_reload: true`. It is specifically tuned for startup refresh behavior.

**Data flow**: Builds a unique request ID, sends `ClientRequest::SkillsList` with `SkillsListParams { cwds: vec![cwd], force_reload: true }`, and returns the typed `SkillsListResponse` or a wrapped error.

**Call relations**: Called by `App::refresh_startup_skills` so startup can fetch skills metadata without borrowing the full session across first-frame rendering.

*Call graph*: calls 1 internal fn (request_typed); called by 1 (refresh_startup_skills); 3 external calls (String, format!, vec!).


##### `fetch_connectors_list`  (lines 834–855)

```
async fn fetch_connectors_list(
    request_handle: AppServerRequestHandle,
    force_refetch: bool,
    thread_id: Option<String>,
) -> Result<ConnectorsSnapshot>
```

**Purpose**: Reads the connectors/app list from the app server and repackages it into the TUI’s `ConnectorsSnapshot`. It supports optional thread scoping and force-refetch behavior.

**Data flow**: Creates a unique request ID, sends `ClientRequest::AppsList` with `AppsListParams { cursor: None, limit: None, thread_id, force_refetch }`, awaits `AppsListResponse`, and returns `ConnectorsSnapshot { connectors: response.data }` or a wrapped error.

**Call relations**: Used by `App::fetch_connectors_list` in a spawned task and by no other helper in this file.

*Call graph*: calls 1 internal fn (request_typed); called by 1 (fetch_connectors_list); 2 external calls (String, format!).


##### `fetch_plugins_list`  (lines 857–866)

```
async fn fetch_plugins_list(
    request_handle: AppServerRequestHandle,
    cwd: PathBuf,
) -> Result<PluginListResponse>
```

**Purpose**: Loads the base plugin list and removes marketplaces that should stay hidden in the CLI. It is the canonical plugin-list transport helper for the TUI.

**Data flow**: Calls `request_plugin_list(request_handle, cwd)`, wraps any failure with plugin-menu-specific context, mutably filters the returned `PluginListResponse` through `hide_cli_only_plugin_marketplaces`, and returns the cleaned response.

**Call relations**: Called by `App::fetch_plugins_list` before any remote-section fan-out. It delegates the actual RPC to `request_plugin_list`.

*Call graph*: calls 2 internal fn (hide_cli_only_plugin_marketplaces, request_plugin_list); called by 1 (fetch_plugins_list).


##### `fetch_additional_plugin_remote_sections`  (lines 868–919)

```
async fn fetch_additional_plugin_remote_sections(
    request_handle: AppServerRequestHandle,
    cwd: PathBuf,
    plugin_sharing_enabled: bool,
    remote_plugin_enabled: bool,
) -> (Vec<PluginMarke
```

**Purpose**: Loads extra remote plugin marketplace sections such as OpenAI curated, workspace, and shared-with-me, collecting both successful marketplace entries and per-section error messages with actionable guidance.

**Data flow**: Builds a list of section descriptors based on `plugin_sharing_enabled` and `remote_plugin_enabled`, pre-populating a synthetic error for disabled sharing when needed. For each section it calls `request_plugin_list_for_kinds`, hides CLI-only marketplaces on success and extends the aggregate marketplace list, or formats the error with `plugin_remote_section_error_message` and pushes a `PluginRemoteSectionError { section_id, label, message }`. It returns `(marketplaces, section_errors)`.

**Call relations**: Called only by `App::fetch_plugins_list` after the base plugin list succeeds. It relies on `request_plugin_list_for_kinds`, `hide_cli_only_plugin_marketplaces`, and the error-message helpers to build the remote sections payload.

*Call graph*: calls 4 internal fn (hide_cli_only_plugin_marketplaces, plugin_remote_section_error_message, plugin_sharing_disabled_remote_section_error, request_plugin_list_for_kinds); called by 1 (fetch_plugins_list); 5 external calls (clone, new, clone, format!, vec!).


##### `plugin_remote_section_error_message`  (lines 921–928)

```
fn plugin_remote_section_error_message(label: &str, err: &str) -> String
```

**Purpose**: Appends a concrete next-step hint to a remote plugin section error when one can be inferred from the error text. Otherwise it returns the original error unchanged.

**Data flow**: Accepts a section label and raw error string, computes a hint via `plugin_remote_section_error_next_step`, and returns either `err.to_string()` if the hint is empty or `format!("{err} {next_step}")`.

**Call relations**: Used by `fetch_additional_plugin_remote_sections` to turn raw remote-catalog failures into user-facing section errors.

*Call graph*: calls 1 internal fn (plugin_remote_section_error_next_step); called by 1 (fetch_additional_plugin_remote_sections); 1 external calls (format!).


##### `plugin_remote_section_error_next_step`  (lines 930–966)

```
fn plugin_remote_section_error_next_step(label: &str, err: &str) -> &'static str
```

**Purpose**: Maps common remote plugin catalog failure substrings to short remediation advice. It encodes the TUI’s heuristics for turning backend/auth/workspace errors into actionable guidance.

**Data flow**: Lowercases the incoming error string and checks it against a sequence of substring patterns covering API-key auth, missing authentication, disabled plugin sharing, workspace mismatch, 404/not found, stale builds, transient service/request failures, admin disablement, and a shared-with-me-specific disabled-plugin case. It returns a static hint string or `""` if no heuristic matches.

**Call relations**: Called only by `plugin_remote_section_error_message` as the decision table behind user-facing next-step text.

*Call graph*: called by 1 (plugin_remote_section_error_message).


##### `plugin_sharing_disabled_remote_section_error`  (lines 968–974)

```
fn plugin_sharing_disabled_remote_section_error() -> PluginRemoteSectionError
```

**Purpose**: Constructs the synthetic error entry shown when plugin sharing is disabled locally, so the shared-with-me section can still render a meaningful explanation.

**Data flow**: Returns a fixed `PluginRemoteSectionError` with `section_id = "shared-with-me"`, label `"Shared with me"`, and a message instructing the user to enable plugin sharing.

**Call relations**: Used by `fetch_additional_plugin_remote_sections` when the feature flag disables shared plugin loading before any RPC is attempted.

*Call graph*: called by 1 (fetch_additional_plugin_remote_sections).


##### `hide_cli_only_plugin_marketplaces`  (lines 978–982)

```
fn hide_cli_only_plugin_marketplaces(response: &mut PluginListResponse)
```

**Purpose**: Filters plugin marketplace results to remove marketplaces that should not appear in the TUI. Currently it hides the `openai-bundled` marketplace.

**Data flow**: Mutably borrows a `PluginListResponse` and retains only marketplaces whose `name` is not contained in the `CLI_HIDDEN_PLUGIN_MARKETPLACES` slice.

**Call relations**: Called by both plugin-list fetch helpers and covered by a dedicated unit test to lock in the hidden-marketplace policy.

*Call graph*: called by 3 (fetch_additional_plugin_remote_sections, fetch_plugins_list, hide_cli_only_plugin_marketplaces_removes_openai_bundled).


##### `request_plugin_list`  (lines 984–990)

```
async fn request_plugin_list(
    request_handle: AppServerRequestHandle,
    cwd: PathBuf,
) -> Result<PluginListResponse>
```

**Purpose**: Requests the plugin list without restricting marketplace kinds. It is a convenience wrapper around the more general helper.

**Data flow**: Forwards `request_handle` and `cwd` to `request_plugin_list_with_marketplace_kinds` with `None` for `marketplace_kinds`, returning the resulting `PluginListResponse` or error.

**Call relations**: Used by `fetch_plugins_list` and by plugin-mention fetching code elsewhere in the app.

*Call graph*: calls 1 internal fn (request_plugin_list_with_marketplace_kinds); called by 2 (fetch_plugins_list, fetch_plugin_mentions).


##### `request_plugin_list_for_kinds`  (lines 992–998)

```
async fn request_plugin_list_for_kinds(
    request_handle: AppServerRequestHandle,
    cwd: PathBuf,
    marketplace_kinds: Vec<PluginListMarketplaceKind>,
) -> Result<PluginListResponse>
```

**Purpose**: Requests the plugin list restricted to a specific set of marketplace kinds. It supports the remote-section fan-out logic.

**Data flow**: Passes `request_handle`, `cwd`, and `Some(marketplace_kinds)` to `request_plugin_list_with_marketplace_kinds` and returns the resulting response or error.

**Call relations**: Called by `fetch_additional_plugin_remote_sections` for each remote section.

*Call graph*: calls 1 internal fn (request_plugin_list_with_marketplace_kinds); called by 1 (fetch_additional_plugin_remote_sections).


##### `request_plugin_list_with_marketplace_kinds`  (lines 1000–1017)

```
async fn request_plugin_list_with_marketplace_kinds(
    request_handle: AppServerRequestHandle,
    cwd: PathBuf,
    marketplace_kinds: Option<Vec<PluginListMarketplaceKind>>,
) -> Result<PluginList
```

**Purpose**: Performs the underlying plugin-list RPC, validating that cwd is absolute and optionally restricting marketplace kinds. It is the shared transport implementation for all plugin-list reads.

**Data flow**: Converts `cwd: PathBuf` into `AbsolutePathBuf` with `try_from`, builds a unique request ID, sends `ClientRequest::PluginList` with `PluginListParams { cwds: Some(vec![cwd]), marketplace_kinds }`, and returns the typed `PluginListResponse` or a wrapped error.

**Call relations**: This private helper is called by both `request_plugin_list` and `request_plugin_list_for_kinds`.

*Call graph*: calls 2 internal fn (request_typed, try_from); called by 2 (request_plugin_list, request_plugin_list_for_kinds); 3 external calls (String, format!, vec!).


##### `fetch_plugin_detail`  (lines 1019–1028)

```
async fn fetch_plugin_detail(
    request_handle: AppServerRequestHandle,
    params: PluginReadParams,
) -> Result<PluginReadResponse>
```

**Purpose**: Reads detailed plugin metadata for a specific plugin request. It is the low-level transport helper behind plugin detail views.

**Data flow**: Builds a unique request ID, sends `ClientRequest::PluginRead { request_id, params }`, and returns the typed `PluginReadResponse` or a wrapped error.

**Call relations**: Called by `App::fetch_plugin_detail` in a spawned task.

*Call graph*: calls 1 internal fn (request_typed); called by 1 (fetch_plugin_detail); 2 external calls (String, format!).


##### `fetch_marketplace_add`  (lines 1030–1049)

```
async fn fetch_marketplace_add(
    request_handle: AppServerRequestHandle,
    cwd: PathBuf,
    source: String,
) -> Result<MarketplaceAddResponse>
```

**Purpose**: Adds a marketplace source after normalizing cwd and resolving relative local paths in the source string. It preserves git-style `#ref` or `@ref` suffixes while resolving local paths.

**Data flow**: Converts `cwd` to `AbsolutePathBuf`, rewrites `source` through `marketplace_add_source_for_request(cwd.as_path(), source)`, builds a unique request ID, sends `ClientRequest::MarketplaceAdd` with `MarketplaceAddParams { source, ref_name: None, sparse_paths: None }`, and returns the typed response or a wrapped error.

**Call relations**: Used by `App::fetch_marketplace_add`; it delegates source normalization to `marketplace_add_source_for_request`.

*Call graph*: calls 3 internal fn (request_typed, marketplace_add_source_for_request, try_from); called by 1 (fetch_marketplace_add); 3 external calls (as_path, String, format!).


##### `marketplace_add_source_for_request`  (lines 1051–1076)

```
fn marketplace_add_source_for_request(cwd: &std::path::Path, source: String) -> String
```

**Purpose**: Resolves relative local marketplace sources against the current cwd while leaving remote identifiers and home-relative paths untouched. It also preserves trailing branch/tag suffixes.

**Data flow**: Splits the incoming `source` into a base and optional `#...` or `@...` suffix using `rsplit_once`. If the base is `.`/`..` or starts with `./`, `../`, `.\`, or `..\`, it resolves the base against `cwd` via `AbsolutePathBuf::resolve_path_against_base`, converts it back to a string, reattaches any suffix, and returns the resolved path. Otherwise it returns the original source unchanged.

**Call relations**: Called by `fetch_marketplace_add` and covered by a unit test that checks relative-path resolution and suffix preservation.

*Call graph*: calls 1 internal fn (resolve_path_against_base); called by 2 (fetch_marketplace_add, marketplace_add_source_for_request_resolves_relative_local_paths); 2 external calls (format!, matches!).


##### `fetch_marketplace_remove`  (lines 1078–1090)

```
async fn fetch_marketplace_remove(
    request_handle: AppServerRequestHandle,
    marketplace_name: String,
) -> Result<MarketplaceRemoveResponse>
```

**Purpose**: Performs the marketplace removal RPC. It is the transport helper behind the remove-marketplace flow.

**Data flow**: Builds a unique request ID, sends `ClientRequest::MarketplaceRemove { params: MarketplaceRemoveParams { marketplace_name } }`, and returns the typed `MarketplaceRemoveResponse` or a wrapped error.

**Call relations**: Called by `App::fetch_marketplace_remove`.

*Call graph*: calls 1 internal fn (request_typed); called by 1 (fetch_marketplace_remove); 2 external calls (String, format!).


##### `fetch_marketplace_upgrade`  (lines 1092–1104)

```
async fn fetch_marketplace_upgrade(
    request_handle: AppServerRequestHandle,
    marketplace_name: Option<String>,
) -> Result<MarketplaceUpgradeResponse>
```

**Purpose**: Performs the marketplace upgrade RPC for one marketplace or all marketplaces. It is the transport helper behind upgrade actions.

**Data flow**: Builds a unique request ID, sends `ClientRequest::MarketplaceUpgrade { params: MarketplaceUpgradeParams { marketplace_name } }`, and returns the typed `MarketplaceUpgradeResponse` or a wrapped error.

**Call relations**: Called by `App::fetch_marketplace_upgrade`.

*Call graph*: calls 1 internal fn (request_typed); called by 1 (fetch_marketplace_upgrade); 2 external calls (String, format!).


##### `fetch_plugin_install`  (lines 1105–1123)

```
async fn fetch_plugin_install(
    request_handle: AppServerRequestHandle,
    location: PluginLocation,
    plugin_name: String,
) -> Result<PluginInstallResponse>
```

**Purpose**: Performs the plugin install RPC after converting `PluginLocation` into exactly one request location field. It supports both local-path and remote-marketplace installs.

**Data flow**: Builds a unique request ID, calls `location.into_request_params()` to obtain `(marketplace_path, remote_marketplace_name)`, sends `ClientRequest::PluginInstall` with those fields plus `plugin_name`, and returns the typed install response or a wrapped error.

**Call relations**: Called by `App::fetch_plugin_install`; the location conversion behavior is covered by a unit test in this file.

*Call graph*: calls 2 internal fn (request_typed, into_request_params); called by 1 (fetch_plugin_install); 2 external calls (String, format!).


##### `fetch_plugin_uninstall`  (lines 1125–1137)

```
async fn fetch_plugin_uninstall(
    request_handle: AppServerRequestHandle,
    plugin_id: String,
) -> Result<PluginUninstallResponse>
```

**Purpose**: Performs the plugin uninstall RPC. It is the low-level transport helper for uninstall actions.

**Data flow**: Builds a unique request ID, sends `ClientRequest::PluginUninstall { params: PluginUninstallParams { plugin_id } }`, and returns the typed uninstall response or a wrapped error.

**Call relations**: Called by `App::fetch_plugin_uninstall`.

*Call graph*: calls 1 internal fn (request_typed); called by 1 (fetch_plugin_uninstall); 2 external calls (String, format!).


##### `write_plugin_enabled`  (lines 1139–1158)

```
async fn write_plugin_enabled(
    request_handle: AppServerRequestHandle,
    plugin_id: String,
    enabled: bool,
) -> Result<ConfigWriteResponse>
```

**Purpose**: Writes plugin enablement into config via a single-value upsert. It targets the `plugins.{plugin_id}` key path with a JSON object containing the enabled flag.

**Data flow**: Builds a unique request ID, sends `ClientRequest::ConfigValueWrite` with `ConfigValueWriteParams { key_path: format!("plugins.{plugin_id}"), value: json!({"enabled": enabled}), merge_strategy: Upsert, file_path: None, expected_version: None }`, and returns the typed `ConfigWriteResponse` or a wrapped error.

**Call relations**: Called by `App::spawn_plugin_enabled_write` as the actual config-write transport.

*Call graph*: calls 1 internal fn (request_typed); called by 1 (spawn_plugin_enabled_write); 3 external calls (String, format!, json!).


##### `write_hook_enabled`  (lines 1160–1186)

```
async fn write_hook_enabled(
    request_handle: AppServerRequestHandle,
    key: String,
    enabled: bool,
) -> Result<ConfigWriteResponse>
```

**Purpose**: Writes hook enablement into config via a batch edit that updates `hooks.state`. It requests a user-config reload after the write.

**Data flow**: Builds a unique request ID, sends `ClientRequest::ConfigBatchWrite` with one `ConfigEdit` targeting `hooks.state` and a nested JSON object `{ key: { "enabled": enabled } }`, plus `reload_user_config: true`, and returns the typed `ConfigWriteResponse` or a wrapped error.

**Call relations**: Called by `App::spawn_hook_enabled_write`.

*Call graph*: calls 1 internal fn (request_typed); called by 1 (spawn_hook_enabled_write); 3 external calls (String, format!, vec!).


##### `build_feedback_upload_params`  (lines 1188–1210)

```
fn build_feedback_upload_params(
    origin_thread_id: Option<ThreadId>,
    rollout_path: Option<PathBuf>,
    category: FeedbackCategory,
    reason: Option<String>,
    turn_id: Option<String>,
```

**Purpose**: Constructs the protocol payload for feedback uploads from current thread/log context and user selections. It decides whether rollout logs and turn tags should be included.

**Data flow**: Accepts optional origin thread ID, optional rollout path, feedback category, optional reason, optional turn ID, and `include_logs`. It converts the category to a classification string via `feedback_classification`, stringifies the thread ID if present, includes `extra_log_files` only when logs are requested, builds `tags` as a one-entry `BTreeMap` containing `turn_id` when provided, and returns a `FeedbackUploadParams` struct.

**Call relations**: Used by `App::submit_feedback` and covered by tests that verify inclusion and omission of rollout paths and thread IDs.

*Call graph*: called by 3 (submit_feedback, build_feedback_upload_params_includes_thread_id_and_rollout_path, build_feedback_upload_params_omits_rollout_path_without_logs); 1 external calls (feedback_classification).


##### `fetch_feedback_upload`  (lines 1212–1221)

```
async fn fetch_feedback_upload(
    request_handle: AppServerRequestHandle,
    params: FeedbackUploadParams,
) -> Result<FeedbackUploadResponse>
```

**Purpose**: Performs the feedback upload RPC. It is the transport helper behind the feedback submission flow.

**Data flow**: Builds a unique request ID, sends `ClientRequest::FeedbackUpload { request_id, params }`, and returns the typed `FeedbackUploadResponse` or a wrapped error.

**Call relations**: Called by `App::submit_feedback` inside a spawned task.

*Call graph*: calls 1 internal fn (request_typed); called by 1 (submit_feedback); 2 external calls (String, format!).


##### `mcp_inventory_maps_from_statuses`  (lines 1236–1261)

```
fn mcp_inventory_maps_from_statuses(statuses: Vec<McpServerStatus>) -> McpInventoryMaps
```

**Purpose**: Converts flat `McpServerStatus` records into the per-server maps used by MCP-related tests. It prefixes tool names with `mcp__{server}__{tool}` and preserves per-server resources, templates, and auth status.

**Data flow**: Consumes `Vec<McpServerStatus>`, initializes four maps, then for each status inserts a converted auth status, stores `resources` and `resource_templates` under the server name, and inserts each tool into the tools map under a prefixed composite key. It returns the tuple `(tools, resources, resource_templates, auth_statuses)`.

**Call relations**: This helper is compiled only for tests and is exercised by `tests::mcp_inventory_maps_prefix_tool_names_by_server`.

*Call graph*: called by 1 (mcp_inventory_maps_prefix_tool_names_by_server); 2 external calls (new, format!).


##### `tests::test_absolute_path`  (lines 1272–1274)

```
fn test_absolute_path(path: &str) -> AbsolutePathBuf
```

**Purpose**: Creates an `AbsolutePathBuf` fixture from a string path for plugin-marketplace tests. It keeps test setup concise.

**Data flow**: Converts the input `&str` into `PathBuf`, then into `AbsolutePathBuf` with `try_from`, panicking if the path is not absolute.

**Call relations**: Used by tests that need stable absolute marketplace paths.

*Call graph*: calls 1 internal fn (try_from); 1 external calls (from).


##### `tests::marketplace_add_source_for_request_resolves_relative_local_paths`  (lines 1277–1299)

```
fn marketplace_add_source_for_request_resolves_relative_local_paths()
```

**Purpose**: Verifies that relative local marketplace sources are resolved against cwd while remote identifiers and `~` paths are left unchanged. It also checks suffix preservation for `#main`.

**Data flow**: Builds a platform-specific cwd, calls `marketplace_add_source_for_request` with several source strings, asserts the resolved local path is absolute and equals `cwd.join(...)`, and asserts remote and home-relative inputs are returned unchanged.

**Call relations**: This test directly covers the path-normalization helper used by `fetch_marketplace_add`.

*Call graph*: calls 1 internal fn (marketplace_add_source_for_request); 4 external calls (from, assert!, assert_eq!, cfg!).


##### `tests::hide_cli_only_plugin_marketplaces_removes_openai_bundled`  (lines 1302–1333)

```
fn hide_cli_only_plugin_marketplaces_removes_openai_bundled()
```

**Purpose**: Checks that the CLI-specific marketplace filter removes `openai-bundled` while leaving other marketplaces intact.

**Data flow**: Constructs a `PluginListResponse` with two marketplaces, mutably passes it to `hide_cli_only_plugin_marketplaces`, and asserts only the non-hidden marketplace remains.

**Call relations**: This test locks in the filtering policy implemented by `hide_cli_only_plugin_marketplaces`.

*Call graph*: calls 1 internal fn (hide_cli_only_plugin_marketplaces); 3 external calls (new, assert_eq!, vec!).


##### `tests::plugin_location_request_params_select_exactly_one_location`  (lines 1336–1353)

```
fn plugin_location_request_params_select_exactly_one_location()
```

**Purpose**: Verifies that `PluginLocation` converts into request parameters with exactly one of `marketplace_path` or `remote_marketplace_name` populated.

**Data flow**: Creates both `PluginLocation::Local` and `PluginLocation::Remote`, calls `into_request_params()` on each, and asserts the returned tuples contain the expected `Some/None` combinations.

**Call relations**: This test documents the conversion relied on by `fetch_plugin_install`.

*Call graph*: 2 external calls (assert_eq!, test_absolute_path).


##### `tests::plugin_remote_section_error_message_adds_concrete_next_steps`  (lines 1356–1406)

```
fn plugin_remote_section_error_message_adds_concrete_next_steps()
```

**Purpose**: Checks that representative remote plugin errors receive the intended remediation hints. It validates the heuristic mapping from backend/auth/workspace failures to user guidance.

**Data flow**: Iterates over labeled `(section, err, next_step)` cases, calls `plugin_remote_section_error_message`, and asserts the returned string equals the original error plus the expected hint.

**Call relations**: This test covers the combined behavior of `plugin_remote_section_error_message` and `plugin_remote_section_error_next_step`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::plugin_sharing_disabled_remote_section_error_targets_shared_with_me`  (lines 1409–1418)

```
fn plugin_sharing_disabled_remote_section_error_targets_shared_with_me()
```

**Purpose**: Verifies the synthetic disabled-sharing error targets the shared-with-me section with the exact expected message.

**Data flow**: Calls `plugin_sharing_disabled_remote_section_error()` and asserts the returned `PluginRemoteSectionError` matches the fixed section ID, label, and message.

**Call relations**: This test documents the fallback error object inserted by `fetch_additional_plugin_remote_sections` when plugin sharing is disabled.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::mcp_inventory_maps_prefix_tool_names_by_server`  (lines 1421–1470)

```
fn mcp_inventory_maps_prefix_tool_names_by_server()
```

**Purpose**: Ensures the test-only MCP inventory map conversion prefixes tool keys by server and preserves per-server resource/template/auth entries.

**Data flow**: Builds two `McpServerStatus` fixtures, calls `mcp_inventory_maps_from_statuses`, sorts resource/template keys for stable comparison, and asserts the tool key list, resource/template server names, and auth status map contents are correct.

**Call relations**: This test exercises the test-only conversion helper used to validate MCP inventory shaping.

*Call graph*: calls 1 internal fn (mcp_inventory_maps_from_statuses); 2 external calls (assert_eq!, vec!).


##### `tests::mcp_inventory_omits_thread_id_for_closed_agent_thread`  (lines 1473–1490)

```
async fn mcp_inventory_omits_thread_id_for_closed_agent_thread()
```

**Purpose**: Verifies that MCP inventory requests stop carrying a thread ID once the corresponding agent thread is marked closed. This prevents stale closed-agent context from affecting inventory reads.

**Data flow**: Creates a test app, sets `active_thread_id`, inserts an open agent-navigation entry, asserts `mcp_inventory_request_thread_id(Some(thread_id))` returns `Some(thread_id)`, marks the agent thread closed, and asserts the helper now returns `None`.

**Call relations**: This test directly covers the gating logic in `App::mcp_inventory_request_thread_id`, which is used by `App::fetch_mcp_inventory`.

*Call graph*: calls 2 internal fn (new, make_test_app); 1 external calls (assert_eq!).


##### `tests::build_feedback_upload_params_includes_thread_id_and_rollout_path`  (lines 1493–1519)

```
fn build_feedback_upload_params_includes_thread_id_and_rollout_path()
```

**Purpose**: Checks that feedback upload params include thread ID, rollout log path, reason, and turn tag when logs are requested and metadata is present.

**Data flow**: Creates a thread ID and rollout path, calls `build_feedback_upload_params` with `include_logs = true`, and asserts the returned struct contains the expected classification, reason, thread ID string, `turn_id` tag, `include_logs = true`, and `extra_log_files = Some(vec![rollout_path])`.

**Call relations**: This test documents the positive inclusion behavior of `build_feedback_upload_params`.

*Call graph*: calls 2 internal fn (new, build_feedback_upload_params); 2 external calls (from, assert_eq!).


##### `tests::build_feedback_upload_params_omits_rollout_path_without_logs`  (lines 1522–1538)

```
fn build_feedback_upload_params_omits_rollout_path_without_logs()
```

**Purpose**: Verifies that feedback upload params omit rollout logs and optional metadata when logs are not requested. It covers the negative branch of the payload builder.

**Data flow**: Calls `build_feedback_upload_params` with no thread ID, no reason, no turn ID, and `include_logs = false`, then asserts the returned struct has the expected classification, `None` metadata fields, `include_logs = false`, and `extra_log_files = None`.

**Call relations**: This test complements the previous feedback test by covering the omission path in `build_feedback_upload_params`.

*Call graph*: calls 1 internal fn (build_feedback_upload_params); 2 external calls (from, assert_eq!).
