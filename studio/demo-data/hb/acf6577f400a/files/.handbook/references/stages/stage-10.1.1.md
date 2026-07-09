# App-level event dispatch and thread routing  `stage-10.1.1`

This stage is the TUI’s main traffic system during normal use. It sits between the user, the screen, the app server, and multiple chat threads. app_event_sender gives other UI code a simple way to send actions into the main loop. app_command defines the allowed kinds of actions, so messages have clear meaning. event_dispatch is the central switchboard: it receives each event and sends it to the right handler.

User key presses go through input, which handles global shortcuts such as switching threads, opening views, clearing the screen, or backing out with Escape. frame_requester asks for screen redraws in a careful way, combining repeated requests so the UI does not waste work.

Messages from the app server go through app_server_events. Server requests that need a later user answer are tracked by app_server_requests. pending_interactive_replay remembers which prompts are still unresolved when a thread is replayed. thread_routing keeps events and actions tied to the correct conversation thread. background_requests runs slower server queries off to the side, then returns their results as normal app events.

## Files in this stage

### Event ingress and dispatch
These files define how app events enter the TUI and get routed into concrete app behavior and redraw scheduling.

### `tui/src/app_event_sender.rs`

`orchestration` · `cross-cutting during TUI event handling`

The TUI and the app core communicate through an event channel, which is like a mailbox: different parts of the interface drop messages into it, and the main app loop reads them later. This file wraps that mailbox in `AppEventSender`, a small helper that turns common user-facing actions into the right `AppEvent` messages.

Its main job is to keep event sending uniform. Before most events are sent, they are also written to the session log so a session can be replayed later with high detail. One important exception is `CodexOp` events, because those are logged elsewhere when they are submitted; logging them here too would create duplicates.

Most methods are convenience shortcuts. For example, `interrupt` builds an interrupt command and sends it. Approval-related methods, such as `exec_approval` and `patch_approval`, include a `thread_id` so the answer goes back to the correct conversation thread. The elicitation method is similar, but for prompts coming from an MCP server, where an external tool asks the user for a decision or extra information.

If sending fails, the file does not crash the interface. It records an error instead. That makes this sender a safe bridge between UI actions and the app’s central event processing.

#### Function details

##### `AppEventSender::new`  (lines 28–30)

```
fn new(app_event_tx: UnboundedSender<AppEvent>) -> Self
```

**Purpose**: Creates an `AppEventSender` around an existing app event channel. Other parts of the TUI use this so they can send app events without directly touching the raw channel.

**Data flow**: It receives an `UnboundedSender<AppEvent>`, which is the mailbox used to send events to the app loop. It stores that sender inside a new `AppEventSender` and returns the wrapper.

**Call relations**: Startup and setup code, including `run`, creates this wrapper and passes it into many UI helpers and tests. After that, those callers use the wrapper’s higher-level methods instead of constructing and sending raw channel messages themselves.

*Call graph*: called by 345 (run, render_skill_load_warning_cells, accepted_model_migration_persists_target_default_reasoning_effort, auth_suggestion_with_reason_snapshot, declined_tool_suggestion_resolves_elicitation_decline, enable_suggestion_with_reason_snapshot, enable_tool_suggestion_resolves_elicitation_after_enable, generic_url_elicitation_confirmation_snapshot, generic_url_elicitation_resolves_without_connector_refresh, generic_url_elicitation_snapshot (+15 more)).


##### `AppEventSender::send`  (lines 34–43)

```
fn send(&self, event: AppEvent)
```

**Purpose**: Sends one app event into the main event channel, while also recording most incoming events in the session log. This is the central doorway used by the other methods in this file.

**Data flow**: It takes an `AppEvent`. If the event is not a `CodexOp`, it writes the event to the session log for replay. Then it tries to place the event into the channel. If the channel is closed or sending otherwise fails, it logs an error and returns without panicking.

**Call relations**: Many parts of the TUI call this when they need to report something to the app loop, such as startup work, configuration warnings, or direct UI events. The convenience methods in this file also call it after they have wrapped a user action into the correct `AppEvent` shape.

*Call graph*: calls 1 internal fn (log_inbound_app_event); called by 53 (handle_tui_event, send_world_writable_scan_failed, spawn_startup_thread_start, apply_accepted_model_migration, emit_project_config_warnings, emit_skill_load_warnings, emit_system_bwrap_warning, handle_model_migration_prompt_if_needed, compact, exec_approval (+15 more)); 3 external calls (send, matches!, error!).


##### `AppEventSender::interrupt`  (lines 45–47)

```
fn interrupt(&self)
```

**Purpose**: Requests that the current Codex operation be interrupted. This is used when the user presses an interrupt key or otherwise asks the assistant to stop what it is doing.

**Data flow**: It takes no extra input. It creates an interrupt `AppCommand`, wraps it as a `CodexOp` event, and sends that event through the shared sender.

**Call relations**: Keyboard handling code, such as `handle_key_event` and `on_ctrl_c`, calls this when the user signals interruption. This method then hands the request to `send`, which delivers it to the app loop.

*Call graph*: calls 1 internal fn (send); called by 2 (handle_key_event, on_ctrl_c); 2 external calls (interrupt, CodexOp).


##### `AppEventSender::interrupt_and_restore_prompt_if_no_output`  (lines 49–53)

```
fn interrupt_and_restore_prompt_if_no_output(&self)
```

**Purpose**: Requests an interrupt, with the extra instruction to restore the prompt if nothing was produced. This supports a smoother user experience when stopping work before any visible output appears.

**Data flow**: It takes no extra input. It builds a special interrupt command, wraps it in a `CodexOp` event, and sends it to the app event channel.

**Call relations**: This is part of the interruption flow and is called by higher-level interrupt handling. It delegates final delivery to `send`, just like the simpler interrupt method.

*Call graph*: calls 1 internal fn (send); called by 1 (interrupt); 2 external calls (interrupt_and_restore_prompt_if_no_output, CodexOp).


##### `AppEventSender::compact`  (lines 55–57)

```
fn compact(&self)
```

**Purpose**: Asks the app to compact the conversation or working context. In plain terms, this is a request to shrink or summarize accumulated state so the session can continue more efficiently.

**Data flow**: It takes no arguments. It creates a compact command, wraps it as a `CodexOp` event, and sends it through the app event channel.

**Call relations**: When some UI path decides compaction is needed, this method provides the standard command-building step. It relies on `send` to deliver the command to the main app loop.

*Call graph*: calls 1 internal fn (send); 2 external calls (compact, CodexOp).


##### `AppEventSender::set_thread_name`  (lines 59–61)

```
fn set_thread_name(&self, name: String)
```

**Purpose**: Requests a rename for the current conversation thread. This lets the UI send a human-readable thread name into the app core.

**Data flow**: It receives a `String` containing the new name. It puts that name into a set-thread-name command, wraps the command as a `CodexOp`, and sends it.

**Call relations**: Callers use this when a thread title changes or needs to be set. The method converts that intent into the app’s command format and passes it to `send`.

*Call graph*: calls 1 internal fn (send); 2 external calls (set_thread_name, CodexOp).


##### `AppEventSender::review`  (lines 63–65)

```
fn review(&self, target: ReviewTarget)
```

**Purpose**: Starts a review action for a specified target. The target describes what should be reviewed, such as a piece of work or code-related output.

**Data flow**: It receives a `ReviewTarget`. It builds a review command for that target, wraps it in a `CodexOp` event, and sends it to the app loop.

**Call relations**: This method is the TUI’s shortcut for launching review work. It prepares the correct command and lets `send` handle logging and channel delivery.

*Call graph*: calls 1 internal fn (send); 2 external calls (review, CodexOp).


##### `AppEventSender::list_skills`  (lines 67–72)

```
fn list_skills(&self, cwds: Vec<PathBuf>, force_reload: bool)
```

**Purpose**: Asks the app to list available skills for one or more working directories. It can also force the skill list to be refreshed instead of using cached information.

**Data flow**: It receives a list of directory paths and a `force_reload` flag. It builds a list-skills command with those values, wraps it as a `CodexOp`, and sends it through the event channel.

**Call relations**: This is called during close-related UI flow when skill information needs to be requested. The method packages the request and passes it through `send` for delivery.

*Call graph*: calls 1 internal fn (send); called by 1 (close); 2 external calls (list_skills, CodexOp).


##### `AppEventSender::user_input_answer`  (lines 74–78)

```
fn user_input_answer(&self, id: String, response: ToolRequestUserInputResponse)
```

**Purpose**: Sends the user’s answer to a tool or app prompt that was waiting for input. This is how typed answers from the UI get back to the request that asked for them.

**Data flow**: It receives an input request ID and a structured response. It creates a user-input-answer command linking that response to the ID, wraps it as a `CodexOp`, and sends it.

**Call relations**: Answer-submission code, such as `submit_answers` and `submit_empty_auto_resolution`, calls this after collecting or deciding on a response. The method forwards that answer into the main event flow.

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

**Purpose**: Sends the user’s decision about whether a command execution should be allowed. This is used when the app asks for confirmation before running something potentially important or risky.

**Data flow**: It receives the target thread ID, the approval request ID, and the user’s decision. It builds an execution-approval command, places it inside a `SubmitThreadOp` event so it goes to the right thread, and sends it.

**Call relations**: `handle_exec_decision` calls this after the user chooses whether to approve command execution. This method turns that choice into a thread-specific event and hands it to `send`.

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

**Purpose**: Sends the user’s response to a permissions request. This is used when the app needs to know whether it may use certain capabilities or access.

**Data flow**: It receives the thread ID, the permissions request ID, and the response. It builds a permissions-response command, wraps it in a `SubmitThreadOp` event for that thread, and sends it.

**Call relations**: `handle_permissions_decision` calls this after the UI has a permissions decision. The method packages the answer for the correct thread and sends it onward.

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

**Purpose**: Sends the user’s decision about whether a proposed file change should be applied. This protects the user from silent edits by requiring an explicit approval path.

**Data flow**: It receives the thread ID, the patch approval request ID, and the user’s decision. It builds a patch-approval command, wraps it in a thread-targeted event, and sends it through the channel.

**Call relations**: `handle_patch_decision` calls this after the user approves or rejects a file change. The method routes that decision back to the correct conversation thread through `send`.

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

**Purpose**: Answers an elicitation request from an MCP server. An elicitation is a prompt from an external tool or server asking the user to choose an action, provide content, or confirm something.

**Data flow**: It receives the thread ID, server name, server request ID, the user’s decision, and optional JSON content and metadata. It builds a resolve-elicitation command with all of that information, wraps it in a thread-specific event, and sends it.

**Call relations**: Elicitation-related flows call this when the user responds, cancels, or submits answers, including `handle_elicitation_decision`, `dispatch_cancel`, and another higher-level `resolve_elicitation` path. This method is the final packaging step before the response enters the main app loop.

*Call graph*: calls 1 internal fn (send); called by 4 (resolve_elicitation, handle_elicitation_decision, dispatch_cancel, submit_answers); 1 external calls (resolve_elicitation).


### `tui/src/tui/frame_requester.rs`

`orchestration` · `main loop`

A terminal screen should redraw when something changes, but not every tiny change should cause its own full redraw. Without this file, animations, typing, status updates, and background events could either feel stale or flood the app with too many redraws. The file solves that with a small “request desk” model. Widgets and background tasks hold a clone of `FrameRequester`, which is like a button they can press to say “please draw soon” or “please draw after this delay.” Those requests are sent to a background `FrameScheduler` task through a channel, which is a safe queue for messages between asynchronous tasks. The scheduler keeps only the earliest needed draw time, so three requests for nearly the same moment become one draw notification. When the chosen time arrives, it broadcasts a simple signal to the main TUI event loop, which is the part that actually redraws the screen. It also uses `FrameRateLimiter` to avoid sending draw signals faster than 120 frames per second. The tests use paused virtual time so they can prove the timing behavior without waiting in real time.

#### Function details

##### `FrameRequester::new`  (lines 39–46)

```
fn new(draw_tx: broadcast::Sender<()>) -> Self
```

**Purpose**: Creates a redraw requester that other parts of the TUI can clone and use. It also starts the private scheduler task that turns many requested draw times into broadcast redraw signals.

**Data flow**: It takes a broadcast sender that the main TUI event loop listens to. It creates an internal message queue, gives the receiving end to a new `FrameScheduler`, starts that scheduler in the background, and returns a `FrameRequester` holding the sending end of the queue.

**Call relations**: This is the setup point for the requester/scheduler pair. Production code and the tests create a requester with it; it immediately hands the queue receiver and draw broadcaster to `FrameScheduler::new`, then starts `FrameScheduler::run` so later calls to `schedule_frame` or `schedule_frame_in` have somewhere to go.

*Call graph*: calls 1 internal fn (new); called by 9 (new, test_coalesces_mixed_immediate_and_delayed_requests, test_coalesces_multiple_requests_into_single_draw, test_limits_draw_notifications_to_120fps, test_multiple_delayed_requests_coalesce_to_earliest, test_rate_limit_clamps_early_delayed_requests, test_rate_limit_does_not_delay_future_draws, test_schedule_frame_immediate_triggers_once, test_schedule_frame_in_triggers_at_delay); 2 external calls (unbounded_channel, spawn).


##### `FrameRequester::schedule_frame`  (lines 49–51)

```
fn schedule_frame(&self)
```

**Purpose**: Asks the TUI to redraw as soon as it reasonably can. This is used when something visible has changed now, such as input, selection, size, or animation state.

**Data flow**: It reads the current time, sends that time into the scheduler’s queue, and returns without waiting. The function does not redraw itself; it only places a request for the scheduler to process.

**Call relations**: Many UI actions call this when they need the screen refreshed. The request travels to `FrameScheduler::run`, where it may be combined with other requests and delayed slightly if the frame-rate limit says a draw just happened.

*Call graph*: called by 33 (handle_draw_size_change, pick_random_variant, schedule_next_frame, request_redraw, request_redraw, handle_key, select, set_highlight, back_to_summary, customize (+15 more)); 2 external calls (now, send).


##### `FrameRequester::schedule_frame_in`  (lines 54–56)

```
fn schedule_frame_in(&self, dur: Duration)
```

**Purpose**: Asks the TUI to redraw after a chosen delay. This is useful for timers, animations, paste bursts, or background work that knows the next visible update should happen later.

**Data flow**: It takes a duration, adds it to the current time to make a target draw time, and sends that target into the scheduler’s queue. It returns immediately after queuing the request.

**Call relations**: Callers use this when the next redraw should happen in the future instead of right now. `FrameScheduler::run` receives the requested time, applies the frame-rate limit if needed, and decides whether this request should become the next draw deadline.

*Call graph*: called by 8 (handle_draw_size_change, schedule_next_frame, request_redraw_in, handle_paste_burst_tick, render, render_continue_in_browser, schedule_next_frame, render); 2 external calls (now, send).


##### `FrameRequester::test_dummy`  (lines 62–67)

```
fn test_dummy() -> Self
```

**Purpose**: Creates a fake requester for tests that need a `FrameRequester` value but do not want a real scheduler or real redraws. It is only compiled for tests.

**Data flow**: It creates an internal queue and keeps only the sending side inside a `FrameRequester`; the receiving side is discarded. Any redraw requests sent to this dummy go nowhere.

**Call relations**: Many UI tests call this when they are testing other behavior and redraw scheduling is not the focus. It avoids starting `FrameScheduler::run`, so those tests can supply a harmless stand-in.

*Call graph*: called by 135 (enqueue_primary_thread_session_replays_turns_before_initial_prompt_submit, height_shrink_schedules_resize_reflow, replace_chat_widget_reseeds_collab_agent_metadata_for_replay, composer_shown_after_denied_while_task_running, ctrl_c_cancels_history_search_without_clearing_draft_or_showing_quit_hint, ctrl_c_on_modal_consumes_without_showing_quit_hint, drain_pending_submission_state_clears_remote_image_urls, esc_interrupts_running_task_when_no_popup, esc_release_after_dismissing_agent_picker_does_not_interrupt_task, esc_routes_to_handle_key_event_when_requested (+15 more)); 1 external calls (unbounded_channel).


##### `FrameScheduler::new`  (lines 84–90)

```
fn new(receiver: mpsc::UnboundedReceiver<Instant>, draw_tx: broadcast::Sender<()>) -> Self
```

**Purpose**: Builds the private scheduler that receives requested draw times and later notifies the TUI event loop. It also creates the frame-rate limiter used to avoid drawing too often.

**Data flow**: It takes the receiving end of the request queue and the broadcast sender for draw notifications. It stores both, adds a default `FrameRateLimiter`, and returns the scheduler object ready to run.

**Call relations**: `FrameRequester::new` calls this during setup. The returned scheduler is then passed to the background task that runs `FrameScheduler::run`.

*Call graph*: called by 1 (new); 1 external calls (default).


##### `FrameScheduler::run`  (lines 96–127)

```
async fn run(mut self)
```

**Purpose**: Runs the background scheduling loop that turns many redraw requests into a single timed redraw signal. It keeps the UI responsive while avoiding repeated, unnecessary redraws.

**Data flow**: It waits for either a new requested draw time or for the current draw deadline to arrive. For each incoming request, it clamps the requested time through the frame-rate limiter and keeps the earliest pending deadline. When that deadline arrives, it clears the pending deadline, records that a draw was emitted, and broadcasts a draw notification. If all request senders are gone, it exits.

**Call relations**: This task is started by `FrameRequester::new` and then lives behind the scenes. `schedule_frame` and `schedule_frame_in` feed it requested times; it hands off only the final redraw signal to the main TUI event loop through the broadcast channel.

*Call graph*: 4 external calls (from_secs, pin!, select!, sleep_until).


##### `tests::test_schedule_frame_immediate_triggers_once`  (lines 137–157)

```
async fn test_schedule_frame_immediate_triggers_once()
```

**Purpose**: Checks that one immediate redraw request produces exactly one draw notification. It protects against both missing the redraw and accidentally sending duplicates.

**Data flow**: The test creates a broadcast channel and requester, asks for an immediate frame, advances paused test time slightly, then reads from the draw receiver. It expects one successful notification and then no second notification.

**Call relations**: This test exercises `FrameRequester::new` and `FrameRequester::schedule_frame` through the real scheduler. It confirms the basic path from requester to scheduler to broadcast receiver works once.

*Call graph*: calls 1 internal fn (new); 4 external calls (from_millis, assert!, channel, advance).


##### `tests::test_schedule_frame_in_triggers_at_delay`  (lines 160–183)

```
async fn test_schedule_frame_in_triggers_at_delay()
```

**Purpose**: Checks that a delayed redraw does not happen before its requested delay and does happen after it. This proves delayed scheduling respects time.

**Data flow**: The test schedules a frame 50 milliseconds in the future, advances time by less than that and expects no notification, then advances past the delay and expects one notification. It also checks that no extra notification follows.

**Call relations**: This test drives `FrameRequester::schedule_frame_in` and observes the scheduler through the broadcast channel. It verifies that `FrameScheduler::run` waits until the requested deadline instead of firing immediately.

*Call graph*: calls 1 internal fn (new); 4 external calls (from_millis, assert!, channel, advance).


##### `tests::test_coalesces_multiple_requests_into_single_draw`  (lines 186–209)

```
async fn test_coalesces_multiple_requests_into_single_draw()
```

**Purpose**: Checks that several immediate redraw requests made together become one draw notification. This protects the app from wasting work when many UI parts ask for a redraw at once.

**Data flow**: The test sends three immediate frame requests, advances paused time enough for the scheduler to act, and reads from the draw channel. It expects one notification and then no more for that batch.

**Call relations**: This test uses `FrameRequester::schedule_frame` repeatedly to feed the scheduler. It confirms `FrameScheduler::run` combines pending requests instead of broadcasting once per request.

*Call graph*: calls 1 internal fn (new); 4 external calls (from_millis, assert!, channel, advance).


##### `tests::test_coalesces_mixed_immediate_and_delayed_requests`  (lines 212–232)

```
async fn test_coalesces_mixed_immediate_and_delayed_requests()
```

**Purpose**: Checks that an immediate redraw and a later redraw request made together are merged into one immediate draw. This matters because the earlier draw will already refresh the screen.

**Data flow**: The test first schedules a delayed frame, then schedules an immediate frame, advances time slightly, and expects one draw notification. It then waits past the original delayed time and expects no second notification.

**Call relations**: This test combines `FrameRequester::schedule_frame_in` and `FrameRequester::schedule_frame`. It verifies that `FrameScheduler::run` chooses the earliest pending deadline and treats the later request as covered by the earlier draw.

*Call graph*: calls 1 internal fn (new); 4 external calls (from_millis, assert!, channel, advance).


##### `tests::test_limits_draw_notifications_to_120fps`  (lines 235–263)

```
async fn test_limits_draw_notifications_to_120fps()
```

**Purpose**: Checks that the scheduler does not emit redraw notifications faster than the configured maximum rate. This prevents rapid updates from overworking the terminal renderer.

**Data flow**: The test triggers one draw and receives it, then immediately requests another. It advances time by a very small amount and expects no draw yet, then advances by the minimum frame interval and expects the second draw.

**Call relations**: This test uses the public requester API but is really checking the scheduler’s use of `FrameRateLimiter`. It proves `FrameScheduler::run` delays too-early requests rather than broadcasting them immediately.

*Call graph*: calls 1 internal fn (new); 4 external calls (from_millis, assert!, channel, advance).


##### `tests::test_rate_limit_clamps_early_delayed_requests`  (lines 266–295)

```
async fn test_rate_limit_clamps_early_delayed_requests()
```

**Purpose**: Checks that even delayed requests are pushed back if they would still happen too soon after the last draw. This keeps the frame-rate limit consistent for all kinds of requests.

**Data flow**: The test emits an initial draw, then schedules another draw only 1 millisecond later. It advances time partway through the minimum allowed interval and expects no notification, then advances enough time and expects the draw.

**Call relations**: This test drives `FrameRequester::schedule_frame_in` after an earlier draw has been emitted. It verifies that `FrameScheduler::run` asks the frame-rate limiter to clamp an overly early deadline.

*Call graph*: calls 1 internal fn (new); 4 external calls (from_millis, assert!, channel, advance).


##### `tests::test_rate_limit_does_not_delay_future_draws`  (lines 298–324)

```
async fn test_rate_limit_does_not_delay_future_draws()
```

**Purpose**: Checks that the rate limiter does not unnecessarily delay a redraw that is already far enough in the future. This protects legitimate timers and animations from being made late.

**Data flow**: The test emits one draw, then schedules another 50 milliseconds later. It advances to just before that time and expects no draw, then advances to the target time and expects the notification.

**Call relations**: This test confirms the cooperation between `FrameRequester::schedule_frame_in`, `FrameScheduler::run`, and the frame-rate limiter. It shows that clamping only affects requests that are too close to the previous draw.

*Call graph*: calls 1 internal fn (new); 4 external calls (from_millis, assert!, channel, advance).


##### `tests::test_multiple_delayed_requests_coalesce_to_earliest`  (lines 327–353)

```
async fn test_multiple_delayed_requests_coalesce_to_earliest()
```

**Purpose**: Checks that several delayed redraw requests are merged and the earliest requested time wins. This avoids extra redraws for later requests that are already covered by the first refresh.

**Data flow**: The test schedules draws at several future delays, advances time to before the earliest one and expects no notification, then advances past the earliest and expects one notification. It waits longer and expects no additional notifications for the later requests.

**Call relations**: This test feeds multiple `schedule_frame_in` requests into the scheduler. It verifies that `FrameScheduler::run` keeps the minimum pending deadline and drops the rest of the batch after one broadcast.

*Call graph*: calls 1 internal fn (new); 4 external calls (from_millis, assert!, channel, advance).


### `tui/src/app/event_dispatch.rs`

`orchestration` · `main loop / event handling`

The TUI app works by sending itself named events, such as “open the session picker,” “submit this message,” “show the diff,” “save this setting,” or “exit now.” This file is where those events are sorted and routed. Think of it like a train station signal box: many trains arrive on one track, and this code sends each one to the right platform.

The main piece is `App::handle_event`. It looks at the incoming `AppEvent` and then updates the screen, talks to the app server, writes configuration, starts background work, or asks smaller app modules to do focused jobs. The file intentionally keeps most detailed behavior elsewhere, so this central dispatcher stays mostly responsible for “what should happen next?” rather than “how exactly is this feature implemented?”

It also contains a few local helper actions that are tightly tied to dispatching: saving or clearing keyboard shortcuts, refreshing plugin mentions after config changes, shutting down cleanly, and archiving or deleting the current conversation thread. Without this file, user actions and background responses would arrive but not reliably reach the parts of the app that can act on them.

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

**Purpose**: This is the app’s main event router. Whenever the terminal app receives an `AppEvent`, this function decides whether to update the chat view, call the app server, open a popup, write settings, start background work, or exit.

**Data flow**: It takes the current app state, the terminal UI object, the app-server session, and one event. It reads the event’s details, changes app state or screen state as needed, may send requests to the app server, may queue new events, and finally returns whether the app should keep running or stop. Most events end with “continue”; exit, archive, delete, and some thread-switching paths can return an exit or other run-control result.

**Call relations**: The main run loop feeds events into this function. Inside, it acts as the dispatcher for many smaller features: session resume, message submission, plugin loading, rate-limit display, Windows sandbox setup, keymap editing, approval screens, theme changes, and more. When a task is too specific, it hands off to helper functions such as `App::apply_keymap_capture`, `App::apply_keymap_clear`, `App::handle_exit_mode`, `App::archive_current_thread`, and `App::delete_current_thread`.

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

**Purpose**: This saves a newly chosen keyboard shortcut. It checks whether the new shortcut is valid, turns it into the app’s runtime shortcut map, writes it to configuration, and updates the visible shortcut picker.

**Data flow**: It receives a shortcut context, an action name, the pressed key, and the user’s editing intent. It combines that with the current saved keymap, tries to produce a new keymap, checks whether the runtime keymap can be built without conflicts, writes the change to config, and then updates both the in-memory app state and the chat widget. If anything goes wrong, it shows an error or a conflict-selection view instead of saving.

**Call relations**: This is called by `App::handle_event` when a key-capture event arrives from the UI. It uses the keymap setup code to decide what the edited shortcut should look like, uses config-editing code to persist it, and then returns control to the keymap picker so the user sees the updated shortcut immediately.

*Call graph*: calls 4 internal fn (keymap_bindings_edit, from_config, build_keymap_conflict_params, keymap_with_edit); called by 1 (handle_event); 3 external calls (for_config, format!, error!).


##### `App::refresh_plugin_mentions_after_config_write`  (lines 2181–2184)

```
fn refresh_plugin_mentions_after_config_write(&mut self)
```

**Purpose**: This tells the UI and the running agent that plugin-related configuration has changed. It is used after installing, uninstalling, enabling, disabling, or otherwise changing plugins so autocomplete-style plugin mentions do not become stale.

**Data flow**: It reads no outside input besides the current app object. It asks the chat widget to refresh plugin mentions, then submits an app command telling the agent side to reload the user configuration. The visible result is that plugin references in the UI and backend behavior can catch up with the latest config.

**Call relations**: This helper is called by `App::handle_event` after successful plugin or marketplace configuration writes. It bridges the user-facing chat widget and the backend command stream, making sure both sides learn about the same configuration change.

*Call graph*: called by 1 (handle_event); 1 external calls (reload_user_config).


##### `App::apply_keymap_clear`  (lines 2186–2232)

```
async fn apply_keymap_clear(&mut self, context: String, action: String)
```

**Purpose**: This removes a custom keyboard shortcut for a given action. It restores that action to whatever the default or remaining keymap says, saves the removal, and refreshes the shortcut UI.

**Data flow**: It receives the shortcut context and action name. It builds a keymap with the custom binding removed, checks that this keymap can run, writes a config edit that clears the binding, updates the app’s stored config and runtime keymap, and shows a confirmation message. If the removal or reload fails, it leaves the old state in place and shows an error.

**Call relations**: This is called by `App::handle_event` when the user chooses to clear a shortcut. It relies on keymap setup code to compute the cleaned keymap and config-editing code to save it, then hands the updated map back to the chat widget so the picker stays in sync.

*Call graph*: calls 3 internal fn (keymap_binding_clear_edit, from_config, keymap_without_custom_binding); called by 1 (handle_event); 3 external calls (for_config, format!, error!).


##### `App::handle_exit_mode`  (lines 2234–2269)

```
async fn handle_exit_mode(
        &mut self,
        app_server: &mut AppServerSession,
        mode: ExitMode,
    ) -> AppRunControl
```

**Purpose**: This decides how the app should quit. It supports a graceful shutdown that first asks the current thread to stop, and an immediate shutdown that exits without waiting.

**Data flow**: It receives the app-server session and an exit mode. For graceful shutdown, it records which thread is being intentionally stopped, waits briefly for the current thread to shut down, and then clears that marker. For immediate shutdown, it skips the wait. In both cases it returns a run-control value telling the outer app loop to exit because the user requested it.

**Call relations**: This is called by `App::handle_event` for exit and logout paths. It hands off to the current-thread shutdown logic when graceful exit is requested, but it also protects the UI from hanging forever by using a short timeout before returning the final exit instruction.

*Call graph*: called by 1 (handle_event); 3 external calls (timeout, warn!, Exit).


##### `App::archive_current_thread`  (lines 2271–2296)

```
async fn archive_current_thread(
        &mut self,
        app_server: &mut AppServerSession,
    ) -> AppRunControl
```

**Purpose**: This archives the active conversation thread and exits the app if the archive succeeds. Archiving is a way to hide or retire a saved chat without deleting it.

**Data flow**: It looks for the current thread id from app state or the chat widget. If no thread exists yet, or if the user is inside a side conversation where archiving is not allowed, it shows an explanatory error and keeps the app running. Otherwise it asks the app server to archive the thread; success returns an exit instruction, while failure shows an error and continues.

**Call relations**: This is called by `App::handle_event` when the archive command event arrives. It is deliberately small: the dispatcher chooses this path, this helper checks whether archiving is allowed, and the app server performs the actual archive operation.

*Call graph*: calls 1 internal fn (thread_archive); called by 1 (handle_event); 2 external calls (format!, Exit).


##### `App::delete_current_thread`  (lines 2298–2323)

```
async fn delete_current_thread(
        &mut self,
        app_server: &mut AppServerSession,
    ) -> AppRunControl
```

**Purpose**: This deletes the active conversation thread and exits the app if the delete succeeds. It is the destructive counterpart to archiving, so it first checks that there is a normal current thread to delete.

**Data flow**: It reads the current thread id from app state or the chat widget. If there is no thread, or if the active conversation is a side thread where deletion is blocked, it adds an error message and returns “continue.” If deletion is allowed, it asks the app server to delete the thread; success returns an exit instruction, and failure reports the problem to the user.

**Call relations**: This is called by `App::handle_event` when the delete command event is dispatched. The helper keeps the safety checks near the server request, while the actual removal is delegated to the app server.

*Call graph*: calls 1 internal fn (thread_delete); called by 1 (handle_event); 2 external calls (format!, Exit).


### Global input and command vocabulary
These files describe the app-wide command language and the top-level keyboard handling that turns user input into those actions.

### `tui/src/app_command.rs`

`data_model` · `cross-cutting`

Think of this file as the order pad for the TUI, the text-based user interface. When a user submits a prompt, approves a shell command, asks for a review, reloads settings, or interrupts current work, the interface needs to package that intent in a form the app can safely understand. `AppCommand` is that package: an enum, meaning a value that can be exactly one of several named choices, each with the extra details that choice needs.

The file does not execute the commands itself. Instead, it defines the messages that another part of the app will receive and act on. For example, a `UserTurn` carries the user’s input, current folder, model settings, approval rules, and collaboration options. An `ExecApproval` carries a decision about whether a proposed command may run. A `ReloadUserConfig` needs no extra data because the request itself is enough.

Most functions here are small constructor helpers. They make it easy and consistent for other code to create the right `AppCommand` value without spelling out the enum fields every time. There is also a small check for whether a command is a review request, and a clone-based conversion from a borrowed command to an owned one.

#### Function details

##### `AppCommand::interrupt`  (lines 114–118)

```
fn interrupt() -> Self
```

**Purpose**: Creates a command that asks the app to interrupt whatever it is currently doing. This is the normal stop request, like pressing a stop button.

**Data flow**: It takes no input. It creates an `AppCommand::Interrupt` value with the default interrupt behavior. The output is that command value, ready to be sent to the app’s command-processing path.

**Call relations**: Other TUI code can call this when the user asks to stop ongoing work. This function only builds the message; a later command receiver is responsible for noticing the interrupt and actually stopping work.


##### `AppCommand::interrupt_and_restore_prompt_if_no_output`  (lines 120–124)

```
fn interrupt_and_restore_prompt_if_no_output() -> Self
```

**Purpose**: Creates an interrupt command with a gentler display behavior: if nothing was produced yet, the prompt should be restored. This helps the interface feel clean when a cancellation happens early.

**Data flow**: It takes no input. It returns an `AppCommand::Interrupt` value whose behavior is `RestorePromptIfNoOutput`. Nothing else is changed at creation time.

**Call relations**: This is used by UI code that wants cancellation to preserve or restore the prompt when there is no visible output. The command-processing side later decides how to apply that behavior.


##### `AppCommand::clean_background_terminals`  (lines 126–128)

```
fn clean_background_terminals() -> Self
```

**Purpose**: Creates a command asking the app to clean up background terminal sessions. This is useful when leftover command windows or terminal tasks should be cleared away.

**Data flow**: It takes no input and returns the `CleanBackgroundTerminals` command. No cleanup happens inside this function; it only creates the request.

**Call relations**: A caller uses this to tell the main app flow that terminal cleanup is needed. The receiving side performs the actual cleanup when it processes the command.


##### `AppCommand::run_user_shell_command`  (lines 130–132)

```
fn run_user_shell_command(command: String) -> Self
```

**Purpose**: Creates a command to run a shell command typed or chosen by the user. A shell command is text that the operating system command line can execute.

**Data flow**: It receives the command text as a string. It wraps that text in `AppCommand::RunUserShellCommand` and returns it. The command is not executed here.

**Call relations**: UI code can call this after the user requests a direct shell action. The returned command is handed to the app’s command runner, which later decides how and whether to execute it.


##### `AppCommand::user_turn`  (lines 135–162)

```
fn user_turn(
        items: Vec<UserInput>,
        cwd: PathBuf,
        approval_policy: AskForApproval,
        active_permission_profile: Option<ActivePermissionProfile>,
        model: String,
```

**Purpose**: Creates the command for a normal user turn: the user has submitted input and the app should respond. It bundles the prompt content together with the working folder, approval policy, model choice, reasoning settings, and related options.

**Data flow**: It receives the user input items, current working directory, approval policy, optional permission profile, model name, optional reasoning and summary settings, optional service tier, optional final-output JSON schema, collaboration mode, and personality. It places those values into `AppCommand::UserTurn`, sets `approvals_reviewer` to `None`, and returns the completed command.

**Call relations**: This is one of the central message builders for the TUI. A prompt submission flow can call it to package everything the app needs for the next assistant response; later processing code reads the fields to start the turn under the right settings.


##### `AppCommand::override_turn_context`  (lines 165–193)

```
fn override_turn_context(
        cwd: Option<PathBuf>,
        approval_policy: Option<AskForApproval>,
        approvals_reviewer: Option<ApprovalsReviewer>,
        permission_profile: Option<Permi
```

**Purpose**: Creates a command that changes the settings used for future or current turns, such as folder, approvals, permissions, sandbox level, model, or personality. It is like updating the instructions on the app’s clipboard before more work continues.

**Data flow**: It receives many optional values. Each `Option` says either “change this setting to this value” or “leave this setting alone.” It returns an `AppCommand::OverrideTurnContext` containing those requested changes.

**Call relations**: Configuration or UI flows can call this when the user changes context. The command receiver later applies only the supplied overrides and leaves missing fields unchanged.


##### `AppCommand::exec_approval`  (lines 195–205)

```
fn exec_approval(
        id: String,
        turn_id: Option<String>,
        decision: CommandExecutionApprovalDecision,
    ) -> Self
```

**Purpose**: Creates a response to a request for permission to run a command. It records which approval request is being answered, which turn it may belong to, and the user’s decision.

**Data flow**: It takes an approval request id, an optional turn id, and a command-execution decision. It returns an `AppCommand::ExecApproval` carrying those values.

**Call relations**: When the app asks the user whether a shell command may run, UI code can call this after the user answers. The approval-processing side later matches the id to the waiting request.


##### `AppCommand::patch_approval`  (lines 207–209)

```
fn patch_approval(id: String, decision: FileChangeApprovalDecision) -> Self
```

**Purpose**: Creates a response to a request for permission to change files. It records the request id and whether the change was accepted or rejected.

**Data flow**: It takes the file-change approval id and the decision. It wraps them in `AppCommand::PatchApproval` and returns that command.

**Call relations**: A file-edit approval prompt can call this when the user decides. The receiving app logic later uses the id to continue or cancel the pending file change.


##### `AppCommand::resolve_elicitation`  (lines 211–225)

```
fn resolve_elicitation(
        server_name: String,
        request_id: AppServerRequestId,
        decision: McpServerElicitationAction,
        content: Option<Value>,
        meta: Option<Value>,
```

**Purpose**: Creates a command that answers an elicitation request from an MCP server. In plain terms, an external tool server asked the user for extra information, and this command carries the user’s answer or decision back.

**Data flow**: It receives the server name, request id, chosen action, optional content, and optional metadata. It returns an `AppCommand::ResolveElicitation` containing that response package.

**Call relations**: When a connected tool server needs user input, the UI can collect the answer and call this function. Later, the app-server communication layer can route the response back to the right server request.


##### `AppCommand::user_input_answer`  (lines 227–229)

```
fn user_input_answer(id: String, response: ToolRequestUserInputResponse) -> Self
```

**Purpose**: Creates a command that answers a tool’s request for user input. It ties the response to the request id that was waiting for it.

**Data flow**: It takes an id and a structured user-input response. It returns an `AppCommand::UserInputAnswer` with both pieces.

**Call relations**: UI code can call this after the user fills in or chooses an answer for a tool prompt. The command receiver later uses the id to wake up the waiting tool request.


##### `AppCommand::request_permissions_response`  (lines 231–236)

```
fn request_permissions_response(
        id: String,
        response: RequestPermissionsResponse,
    ) -> Self
```

**Purpose**: Creates a command that answers a permissions request. This is used when something asks for a broader permission decision and the user or system responds.

**Data flow**: It takes the request id and the permissions response. It returns an `AppCommand::RequestPermissionsResponse` carrying that answer.

**Call relations**: A permissions prompt or policy flow can call this after a decision is made. The app’s permission-handling code later matches the response to the original request.


##### `AppCommand::reload_user_config`  (lines 238–240)

```
fn reload_user_config() -> Self
```

**Purpose**: Creates a command asking the app to reload the user’s configuration. This lets changes to settings be picked up without inventing a separate message shape.

**Data flow**: It takes no input and returns `AppCommand::ReloadUserConfig`. The configuration is not read here; this only creates the reload request.

**Call relations**: UI code can call this after the user asks to refresh settings. The actual config-loading code runs later when the command is processed.


##### `AppCommand::list_skills`  (lines 242–244)

```
fn list_skills(cwds: Vec<PathBuf>, force_reload: bool) -> Self
```

**Purpose**: Creates a command asking the app to list available skills for one or more working folders. A skill is a reusable capability or instruction set the app can discover.

**Data flow**: It takes a list of current working directories and a `force_reload` flag. It returns `AppCommand::ListSkills` with those values, telling the receiver where to look and whether cached information should be ignored.

**Call relations**: A UI action for showing skills can call this. The later command handler performs the actual skill lookup or reload.


##### `AppCommand::compact`  (lines 246–248)

```
fn compact() -> Self
```

**Purpose**: Creates a command asking the app to compact the conversation or working context. This usually means reducing stored context so the session can continue with less clutter.

**Data flow**: It takes no input and returns `AppCommand::Compact`. No compaction happens here.

**Call relations**: The TUI can call this when the user requests compaction. The command-processing flow later performs the actual shrinking or summarizing work.


##### `AppCommand::set_thread_name`  (lines 250–252)

```
fn set_thread_name(name: String) -> Self
```

**Purpose**: Creates a command to rename the current thread or conversation. The name is stored as part of the command.

**Data flow**: It receives the new name as a string. It returns `AppCommand::SetThreadName` containing that name.

**Call relations**: A rename action in the interface can call this. The app later applies the new name to the conversation or thread state.


##### `AppCommand::shutdown`  (lines 255–257)

```
fn shutdown() -> Self
```

**Purpose**: Creates a command asking the app to shut down. It is marked as currently unused by the compiler annotation, but it defines the message shape for a shutdown request.

**Data flow**: It takes no input and returns `AppCommand::Shutdown`. It does not stop the program by itself.

**Call relations**: If a shutdown flow uses it, this function would create the message and the command receiver would perform the actual teardown. The file marks it as allowed dead code, meaning it may not be called in the current build.


##### `AppCommand::thread_rollback`  (lines 259–261)

```
fn thread_rollback(num_turns: u32) -> Self
```

**Purpose**: Creates a command to roll back a conversation by a given number of turns. A turn is one exchange or step in the conversation history.

**Data flow**: It takes the number of turns to roll back. It returns `AppCommand::ThreadRollback` with that number.

**Call relations**: A history or undo-style UI action can call this. The app’s thread-state logic later removes or rewinds the requested amount.


##### `AppCommand::review`  (lines 263–265)

```
fn review(target: ReviewTarget) -> Self
```

**Purpose**: Creates a command asking the app to review a target. The target describes what should be reviewed, such as code or another reviewable item.

**Data flow**: It receives a `ReviewTarget` and returns `AppCommand::Review` containing it. The review itself does not happen here.

**Call relations**: A review-starting UI path can call this to package the target. Later, command processing recognizes it as a review request and starts the review workflow.


##### `AppCommand::approve_guardian_denied_action`  (lines 267–269)

```
fn approve_guardian_denied_action(event: GuardianAssessmentEvent) -> Self
```

**Purpose**: Creates a command that approves an action previously denied by the guardian safety or policy layer. It carries the original assessment event so the app knows exactly what is being reconsidered.

**Data flow**: It receives a `GuardianAssessmentEvent`. It returns `AppCommand::ApproveGuardianDeniedAction` with that event attached.

**Call relations**: When the guardian blocks something and the user or reviewer chooses to approve it anyway, UI code can call this. The receiving logic later uses the event details to continue the denied action in a controlled way.


##### `AppCommand::is_review`  (lines 271–273)

```
fn is_review(&self) -> bool
```

**Purpose**: Checks whether this command is specifically a review request. This is a convenience test for code that needs to treat review commands differently.

**Data flow**: It reads the current `AppCommand` value by reference. It uses Rust’s pattern-matching check, `matches!`, to see whether the value is the `Review` variant. It returns `true` for review commands and `false` for all others.

**Call relations**: Code that has a general `AppCommand` can call this before deciding how to route or display it. Internally it only calls the standard `matches!` macro and does not hand work off elsewhere.

*Call graph*: 1 external calls (matches!).


##### `AppCommand::from`  (lines 277–279)

```
fn from(value: &AppCommand) -> Self
```

**Purpose**: Creates an owned `AppCommand` from a borrowed one by cloning it. This is useful when code has a reference but needs its own separate command value.

**Data flow**: It receives a borrowed `AppCommand`. It calls `clone` to copy the command and all of its stored data, then returns the copied command.

**Call relations**: This implements Rust’s standard `From<&AppCommand> for AppCommand` conversion. Any code using that conversion gets a fresh owned command; the original borrowed command is left unchanged.

*Call graph*: 1 external calls (clone).


### `tui/src/app/input.rs`

`orchestration` · `main loop / key input handling`

This file is the keyboard traffic controller for the terminal user interface. The chat composer itself knows how to edit text, but some key presses mean bigger app actions: open a full transcript view, clear the terminal, toggle display modes, jump between agent conversations, or send the draft to an outside text editor. Without this layer, those global shortcuts would either not work or would accidentally interfere with normal typing.

The main idea is to check the app’s current state before deciding what a key means. For example, Alt+Left can mean “move one word left” while typing, but when the draft is empty it can mean “switch to the previous agent thread.” The file protects the typing experience by only using those shortcuts when it is safe. It also blocks app-level shortcuts while an overlay, modal, or popup is open, so the visible UI gets first chance to respond.

The external editor flow is also here. The app finds the user’s editor command from environment settings, temporarily restores the terminal so the editor can run normally, then brings the edited text back into the composer. Another important part is Escape handling: in a very specific normal state, Escape starts or advances “backtracking,” which lets the user revisit earlier messages. In other states, Escape is passed to the chat widget so popups, Vim-style editing, or other controls can use it.

#### Function details

##### `App::launch_external_editor`  (lines 10–54)

```
async fn launch_external_editor(&mut self, tui: &mut tui::Tui)
```

**Purpose**: This opens the user’s chosen external text editor so they can edit the current draft outside the terminal chat box. It matters because longer prompts are often easier to write in a full editor than in a single-line composer.

**Data flow**: It starts by looking up the editor command from the user’s environment, such as VISUAL or EDITOR. If no editor is configured, it writes an error into the chat history and closes the editor state. If an editor is found, it takes the current composer text as the starting content, temporarily restores the terminal to a normal state, runs the editor, then trims trailing whitespace from the returned text and puts it back into the chat composer. It always asks the UI to redraw afterward.

**Call relations**: This is the second half of the external editor story. A key press first calls App::request_external_editor_launch to mark that an editor should open; then this function does the actual work. It uses App::reset_external_editor_state when setup fails or after the editor returns, so the footer and internal state do not stay stuck in an “editor opening” state.

*Call graph*: calls 2 internal fn (reset_external_editor_state, resolve_editor_command); 4 external calls (frame_requester, with_restored, format!, new_error_event).


##### `App::request_external_editor_launch`  (lines 56–64)

```
fn request_external_editor_launch(&mut self, tui: &mut tui::Tui)
```

**Purpose**: This marks the external editor as requested and updates the footer hint so the user sees that the app is about to leave the normal composer flow. It does not open the editor itself; it prepares the UI for that next step.

**Data flow**: It changes the chat widget’s external editor state from closed to requested, sets a temporary footer message, and asks the terminal UI to draw another frame. Nothing is returned, but the visible UI and chat widget state are changed.

**Call relations**: App::handle_key_event calls this when the configured external-editor shortcut is pressed and the app is in a safe state for launching one. The actual editor launch is handled later by App::launch_external_editor.

*Call graph*: called by 1 (handle_key_event); 2 external calls (frame_requester, vec!).


##### `App::reset_external_editor_state`  (lines 66–71)

```
fn reset_external_editor_state(&mut self, tui: &mut tui::Tui)
```

**Purpose**: This returns the app to its normal state after an external editor attempt finishes or fails. It clears the special footer hint so the user is not left with stale information.

**Data flow**: It sets the chat widget’s external editor state back to closed, removes the footer override, and requests a new UI frame. It does not produce a value, but it cleans up visible and internal editor state.

**Call relations**: App::launch_external_editor calls this after resolving the editor fails and after the editor process finishes. It is the cleanup step that keeps the external-editor workflow from leaving the app half-open.

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

**Purpose**: This turns raw output display on or off. Raw output mode means the transcript is shown closer to the original unprocessed text, which can help users inspect exactly what came back.

**Data flow**: It receives the desired enabled-or-disabled value and a flag saying whether to notify the user. It updates the chat widget’s raw output setting, then immediately tries to reflow the transcript, meaning it recalculates how the text should wrap and fit on screen. If that redraw work fails, it logs a warning and shows an error in the chat. Finally it asks the UI to repaint.

**Call relations**: App::handle_key_event calls this when the raw-output shortcut is pressed. This function then coordinates with the chat widget for the mode change and with the transcript redraw path so the screen matches the new setting right away.

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

**Purpose**: This is the central decision point for keyboard input in the app. It decides whether a key press should trigger an app-wide action, switch agent threads, control backtracking, or simply be passed to the chat widget for normal typing and editing.

**Data flow**: It receives the terminal UI, the app server session, and one key event. It checks the current screen state, the composer text, active overlays or popups, and the configured keymap. Depending on those facts, it may switch to a neighboring agent thread, return from a side conversation, toggle Vim mode, toggle fast mode, toggle raw output, open the transcript overlay, request an external editor, clear the terminal UI, confirm a backtrack selection, reject a side backtrack, or forward the key to the chat widget. Its output is mostly changes to app state and screen state rather than a returned value.

**Call relations**: This function is called during normal input handling whenever the terminal reports a key event. It uses small helper functions in this file, such as App::app_keymap_shortcuts_available, App::should_handle_backtrack_esc, App::should_reject_side_backtrack_esc, App::reject_side_backtrack_esc, App::request_external_editor_launch, and App::apply_raw_output_mode, to keep each decision readable. When a key belongs to the lower-level chat interface, it hands the event off to the chat widget instead of consuming it.

*Call graph*: calls 7 internal fn (app_keymap_shortcuts_available, apply_raw_output_mode, reject_side_backtrack_esc, request_external_editor_launch, should_handle_backtrack_esc, should_reject_side_backtrack_esc, new_transcript); 5 external calls (enter_alt_screen, frame_requester, format!, matches!, warn!).


##### `App::should_handle_backtrack_esc`  (lines 257–262)

```
fn should_handle_backtrack_esc(&self, key_event: KeyEvent) -> bool
```

**Purpose**: This answers whether Escape should be used for the app’s main backtracking feature. Backtracking is only allowed when the user is in the normal main conversation, the composer is empty, and Escape is not needed for Vim-style insert-mode behavior.

**Data flow**: It reads the chat widget’s state: whether a side conversation is active, whether the app is in normal backtrack mode, whether the composer is empty, and whether Vim insert mode should receive Escape instead. It returns true only when all conditions say the app should treat Escape as a backtrack command.

**Call relations**: App::handle_key_event calls this during Escape-key handling. If it returns true, the main input flow advances or primes backtracking instead of sending Escape to the chat widget.

*Call graph*: called by 1 (handle_key_event).


##### `App::should_reject_side_backtrack_esc`  (lines 264–269)

```
fn should_reject_side_backtrack_esc(&self, key_event: KeyEvent) -> bool
```

**Purpose**: This answers whether Escape looks like a backtrack attempt inside a side conversation, where that action is not allowed. It lets the app give a clear error instead of silently doing nothing.

**Data flow**: It checks whether a side conversation is active, the app is in normal backtrack mode, the composer is empty, and Vim insert mode does not need Escape. If those are all true, it returns true to signal that this Escape press should be rejected as an unavailable side-conversation backtrack.

**Call relations**: App::handle_key_event calls this after checking the main backtrack case. If it returns true, App::handle_key_event calls App::reject_side_backtrack_esc to reset backtrack state and show the user a message.

*Call graph*: called by 1 (handle_key_event).


##### `App::reject_side_backtrack_esc`  (lines 271–275)

```
fn reject_side_backtrack_esc(&mut self)
```

**Purpose**: This tells the user that editing a previous message is not available from the current side conversation. It also clears any partially prepared backtrack state so the app is not left in a confusing mode.

**Data flow**: It resets the app’s backtrack state, then adds a fixed error message to the chat widget. It returns nothing, but it changes both internal state and the visible chat history.

**Call relations**: App::handle_key_event calls this when App::should_reject_side_backtrack_esc says the user pressed Escape in a side conversation where backtracking is not supported.

*Call graph*: called by 1 (handle_key_event).


##### `App::app_keymap_shortcuts_available`  (lines 277–279)

```
fn app_keymap_shortcuts_available(&self) -> bool
```

**Purpose**: This checks whether app-wide keyboard shortcuts are currently allowed. It prevents global shortcuts from stealing keys while an overlay, modal, or popup is open.

**Data flow**: It reads whether an overlay is active and asks the chat widget whether any modal or popup is active. It returns true only when the main app is clear to receive global shortcuts.

**Call relations**: App::handle_key_event uses this before applying shortcuts such as toggling modes, opening the transcript, launching the editor, or clearing the terminal. The test in this file also checks this rule when the keymap view is open.

*Call graph*: called by 1 (handle_key_event).


##### `App::refresh_status_line`  (lines 281–283)

```
fn refresh_status_line(&mut self)
```

**Purpose**: This refreshes the status line shown by the chat widget. The status line is the small area that tells the user about current mode, state, or hints.

**Data flow**: It simply asks the chat widget to refresh its status line. It does not take extra input or return a value; the effect is an updated piece of UI state.

**Call relations**: This is a small forwarding method on App. Other parts of the app can call it when something changes that should be reflected in the chat widget’s status line.


##### `tests::app_keymap_shortcuts_are_disabled_while_keymap_view_is_active`  (lines 291–299)

```
async fn app_keymap_shortcuts_are_disabled_while_keymap_view_is_active()
```

**Purpose**: This test confirms that app-wide shortcuts are turned off while the keymap debug view is open. That protects the keymap screen from having its own keys accidentally interpreted as global app commands.

**Data flow**: It creates a test app, first checks that app shortcuts are available, then opens the keymap debug view in the chat widget. After that, it checks that App::app_keymap_shortcuts_available returns false.

**Call relations**: The test exercises the helper used by App::handle_key_event. It proves that when a popup-like keymap view is active, the main keyboard dispatcher should not treat key presses as app-level shortcuts.

*Call graph*: calls 1 internal fn (make_test_app); 1 external calls (assert!).


### App-server event and request handling
These files bridge protocol-level app-server traffic into TUI-managed events, pending approvals, and serialized user responses.

### `tui/src/app/app_server_events.rs`

`orchestration` · `main loop event handling`

The TUI talks to an app server that can send many kinds of events: notifications, requests that need an answer, account updates, connector lists, plugin/config changes, and disconnection warnings. This file is the traffic director for those events. Without it, the terminal app could miss important server messages, show stale account or connector information, leave permission requests hanging, or fail to tell the user when the server connection has died.

The main entry point is `App::handle_app_server_event`. It looks at the broad event type first. If the event stream fell behind, it resets the expected MCP startup state. MCP servers are external tool servers the app may start and connect to. If the server disconnected, it shows an error and asks the app to exit. Otherwise, it sends notifications and requests to more focused helper functions.

Notifications are mostly one-way updates from the server. Some affect the whole app, such as account state, rate limits, connector lists, or imported external-agent configuration. Others belong to a particular conversation thread, so this file finds the right destination and queues them there. Requests are different: the server is asking the UI/user to do something or decide something. This file records pending requests, rejects unsupported ones, and routes supported ones to the correct thread. In short, it is like a mailroom: it opens each envelope enough to know where it belongs, then delivers it to the right desk.

#### Function details

##### `App::refresh_mcp_startup_expected_servers_from_config`  (lines 18–28)

```
fn refresh_mcp_startup_expected_servers_from_config(&mut self)
```

**Purpose**: This updates the chat UI with the list of MCP servers that the current configuration says should be enabled at startup. It helps the UI know which tool servers it is still waiting for or should display during startup.

**Data flow**: It reads the app configuration, looks through the configured MCP servers, keeps only the ones marked enabled, and collects their names. It then gives that list to the chat widget, replacing the widget's idea of the expected startup servers.

**Call relations**: This is used when the event stream has lagged and when the server reports MCP status changes. In both cases, the app may no longer trust its old startup picture, so the broader event handlers call this function to rebuild the UI's expected-server list from the source of truth: the current config.

*Call graph*: called by 2 (handle_app_server_event, handle_server_notification_event).


##### `App::handle_app_server_event`  (lines 30–58)

```
async fn handle_app_server_event(
        &mut self,
        app_server_client: &AppServerSession,
        event: AppServerEvent,
    )
```

**Purpose**: This is the first stop for each event received from the app server. It decides whether the event is a notification, a request, a lag warning, or a disconnection, and then starts the right response.

**Data flow**: It receives the current app-server session and one server event. If events were skipped because the UI fell behind, it logs a warning and resets MCP startup state. If the event is a notification, it passes the notification to the notification handler. If it is a request, it passes the request to the request handler. If the server disconnected, it shows the user an error and sends a fatal-exit request into the app's event channel.

**Call relations**: This function is the dispatcher for this file. When the app's event loop receives an `AppServerEvent`, it calls here, and this function either deals with the event immediately or hands it to `App::handle_server_notification_event` or `App::handle_server_request_event` for more detailed routing.

*Call graph*: calls 3 internal fn (handle_server_notification_event, handle_server_request_event, refresh_mcp_startup_expected_servers_from_config); 2 external calls (FatalExitRequest, warn!).


##### `App::handle_server_notification_event`  (lines 60–173)

```
async fn handle_server_notification_event(
        &mut self,
        app_server_client: &AppServerSession,
        notification: ServerNotification,
    )
```

**Purpose**: This processes one-way updates from the app server and makes sure they change the right part of the terminal UI. Some notifications update global UI state, while others are delivered to a specific conversation thread.

**Data flow**: It receives the app-server session and a server notification. First it checks for special notification types: resolved server requests are dismissed from the UI, MCP status changes refresh startup expectations, rate-limit snapshots update rate-limit display, account updates refresh the displayed account and plan state, imported external-agent config triggers config reload and plugin refresh, and connector-list updates refresh connector data. If none of those special cases apply, it asks which thread the notification belongs to. Thread-specific notifications are queued for the primary thread or another thread. Invalid or app-scoped notifications may be ignored with a log message. Global notifications are passed directly to the chat widget.

**Call relations**: It is called by `App::handle_app_server_event` whenever a server notification arrives. During its work it relies on helper logic such as `server_notification_thread_target` to decide where the message belongs, `status_account_display_from_auth_mode` to turn login details into user-facing account text, and session/config helpers when an external-agent import finishes.

*Call graph*: calls 4 internal fn (server_notification_thread_target, refresh_mcp_startup_expected_servers_from_config, consume_external_agent_config_import_completion, status_account_display_from_auth_mode); called by 1 (handle_app_server_event); 4 external calls (reload_user_config, matches!, debug!, warn!).


##### `App::handle_server_request_event`  (lines 175–218)

```
async fn handle_server_request_event(
        &mut self,
        app_server_client: &AppServerSession,
        request: ServerRequest,
    )
```

**Purpose**: This processes requests from the app server that may need attention from the UI or user. It records supported requests, rejects unsupported ones, and delivers valid thread-specific requests to the right conversation.

**Data flow**: It receives the app-server session and a server request. It first asks the pending-request tracker to note the request; if that tracker says the request is unsupported, the function warns, shows an error, and sends a rejection back to the server. If the request is supported, it extracts the thread ID. Requests without a thread are ignored with a warning. Requests with a thread ID are queued either for the primary thread or for another matching thread, and any queueing failure is logged.

**Call relations**: It is called by `App::handle_app_server_event` whenever the incoming app-server event is a request. It uses `server_request_thread_id` to decide where the request belongs, and it hands the request off to the app's thread queues so the appropriate conversation can show or answer it.

*Call graph*: calls 1 internal fn (server_request_thread_id); called by 1 (handle_app_server_event); 1 external calls (warn!).


### `tui/src/app/app_server_requests.rs`

`domain_logic` · `request handling`

The app server can ask the terminal UI for several kinds of decisions: approve a command, approve a file change, grant permissions, answer a tool’s question, or respond to an MCP elicitation request. These requests arrive with app-server request IDs, while the rest of the UI often talks in terms of item IDs, approval IDs, turn IDs, or server names. This file is the small “claim ticket desk” between those two worlds: it records each incoming ticket, then later uses the ticket to send the right answer back.

The main type, `PendingAppServerRequests`, stores separate lookup tables for each request kind. When a server request arrives, `note_server_request` records it if the TUI supports that request. Some unsupported requests are returned with a clear rejection message instead of being stored. Permission requests get an extra safety check so invalid filesystem paths are rejected early, before the server is left waiting.

When the user or UI produces an `AppCommand`, `take_resolution` looks for a matching pending request, removes it, and turns the answer into the JSON shape the app server protocol expects. If the app server later reports that a request was resolved elsewhere, `resolve_notification` removes the matching pending entry so the UI does not keep showing stale work. User-input requests are queued per turn, so multiple questions in the same turn are answered in first-in, first-out order.

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

**Purpose**: Sends a formal rejection back to the app server for a request the TUI cannot or will not satisfy. It wraps the human-readable reason in the JSON-RPC error format, which is the request/response error format used by the app server protocol.

**Data flow**: It receives an app-server session, the request ID to reject, and a reason string. It builds an error object with a generic server error code and that reason, sends it through the session, and returns success or a plain error message if sending fails.

**Call relations**: This is used when earlier request-checking code decides a server request is unsupported or invalid. It hands the actual network/protocol reply off to `reject_server_request`, keeping this file focused on translating the TUI’s decision into the app server’s expected rejection shape.

*Call graph*: calls 1 internal fn (reject_server_request).


##### `PendingAppServerRequests::clear`  (lines 80–86)

```
fn clear(&mut self)
```

**Purpose**: Forgets every app-server request currently waiting for a UI response. This is useful when the session is reset or the UI must discard old pending work.

**Data flow**: It takes the current pending-request store and empties all of its internal lookup tables and queues. Nothing is returned; after it runs, there are no remembered approvals, permission requests, user-input prompts, or MCP elicitation requests.

**Call relations**: This is a housekeeping method for the owner of `PendingAppServerRequests`. It does not call other helpers because each stored category can simply be cleared directly.


##### `PendingAppServerRequests::note_server_request`  (lines 88–171)

```
fn note_server_request(
        &mut self,
        request: &ServerRequest,
    ) -> Option<UnsupportedAppServerRequest>
```

**Purpose**: Records a newly arrived app-server request so a later UI action can be matched back to it. If the request is not supported by the TUI, it returns a rejection message instead of storing it.

**Data flow**: It receives a `ServerRequest` from the app server. For supported approval, permission, user-input, and MCP requests, it saves the app-server request ID under the ID that the UI will later use. For permission requests, it first checks that requested filesystem paths can be understood locally. It returns `None` when the request was accepted for tracking, or an `UnsupportedAppServerRequest` containing the original request ID and a message when the request should be rejected.

**Call relations**: This is the intake point for pending work. Later, `take_resolution` uses the records created here to answer requests, while `resolve_notification` can remove them if the app server says they were resolved elsewhere. It calls the permission conversion check for permission requests because bad paths must be rejected before the UI delivery path loses the clean app-server rejection route.

*Call graph*: 2 external calls (try_from, format!).


##### `PendingAppServerRequests::take_resolution`  (lines 173–273)

```
fn take_resolution(
        &mut self,
        op: T,
    ) -> Result<Option<AppServerRequestResolution>, String>
```

**Purpose**: Turns a UI-side decision into the exact response needed by the matching app-server request. It also removes the request from the pending list so it cannot be answered twice.

**Data flow**: It receives something that can become an `AppCommand`, such as an approval decision or a user-input answer. It converts that input into an `AppCommand`, looks in the appropriate pending-request table, removes the matching request if found, and serializes the response into JSON. It returns either no match, a ready-to-send `AppServerRequestResolution`, or an error string if response serialization fails.

**Call relations**: This is the main outgoing bridge from UI actions back to the app server. It relies on entries previously recorded by `note_server_request`. For user input, it calls `pop_user_input_request_for_turn` so multiple prompts for the same turn are answered in arrival order.

*Call graph*: calls 1 internal fn (pop_user_input_request_for_turn); 1 external calls (into).


##### `PendingAppServerRequests::resolve_notification`  (lines 275–325)

```
fn resolve_notification(
        &mut self,
        request_id: &AppServerRequestId,
    ) -> Option<ResolvedAppServerRequest>
```

**Purpose**: Removes a pending request when the app server notifies the TUI that the request has already been resolved. This prevents the UI from continuing to show a prompt that no longer needs an answer.

**Data flow**: It receives an app-server request ID. It searches all pending categories for that ID, removes the matching record if one exists, and returns a small description of what was removed, such as an exec approval ID or user-input call ID. If no pending request matches, it returns nothing.

**Call relations**: This is the cleanup path for server-side resolution events. It complements `take_resolution`: `take_resolution` removes a request because the TUI is answering it, while this method removes a request because the server says it is done. For user-input requests, it calls `remove_user_input_request` to search inside the per-turn queues.

*Call graph*: calls 1 internal fn (remove_user_input_request).


##### `PendingAppServerRequests::contains_server_request`  (lines 327–358)

```
fn contains_server_request(&self, request: &ServerRequest) -> bool
```

**Purpose**: Checks whether a server request is already known to the pending-request tracker. This helps avoid treating duplicate or already-accounted-for requests as new work.

**Data flow**: It receives a `ServerRequest` and compares its request ID with the IDs stored in the matching pending category. For queued user-input requests, it searches through all per-turn queues. It returns `true` if the request is considered present or already accounted for, and `false` if a supported trackable request is not found.

**Call relations**: This is a read-only helper used by surrounding request-handling code before deciding what to do with a server request. Unlike `note_server_request`, it does not store, remove, reject, or serialize anything.


##### `PendingAppServerRequests::pop_user_input_request_for_turn`  (lines 360–376)

```
fn pop_user_input_request_for_turn(
        &mut self,
        turn_id: &str,
    ) -> Option<PendingUserInputRequest>
```

**Purpose**: Takes the oldest pending user-input request for a given turn. This matters because the same turn can ask more than one question, and answers should be matched in the same order the questions arrived.

**Data flow**: It receives a turn ID, finds the queue of user-input requests for that turn, and removes the front entry. If the queue becomes empty, it removes the queue itself. It returns the removed pending request, or nothing if that turn has no waiting input request.

**Call relations**: This private helper is called by `take_resolution` when the UI sends a `UserInputAnswer`. It keeps the first-in, first-out behavior in one place so the main resolution code does not need to know the queue details.

*Call graph*: called by 1 (take_resolution).


##### `PendingAppServerRequests::remove_user_input_request`  (lines 378–394)

```
fn remove_user_input_request(
        &mut self,
        request_id: &AppServerRequestId,
    ) -> Option<PendingUserInputRequest>
```

**Purpose**: Removes a specific pending user-input request by its app-server request ID, even though user-input requests are grouped by turn. This is needed when the server identifies the resolved request by request ID rather than by turn.

**Data flow**: It receives an app-server request ID, searches every turn’s queue for a matching pending user-input request, removes that one entry, and deletes the turn queue if it becomes empty. It returns the removed request, or nothing if no match exists.

**Call relations**: This private helper is called by `resolve_notification`. It handles the more expensive search needed for server resolution notifications, while normal UI answers use `pop_user_input_request_for_turn` instead.

*Call graph*: called by 1 (resolve_notification).


##### `tests::resolves_exec_approval_through_app_server_request_id`  (lines 445–480)

```
fn resolves_exec_approval_through_app_server_request_id()
```

**Purpose**: Checks that a command-execution approval request is recorded and later resolved using the original app-server request ID. This protects the basic approval round trip for commands.

**Data flow**: The test creates an empty pending-request tracker, records a command approval request with app-server request ID 41 and approval ID `approval-1`, then sends an accept decision for that approval ID. It expects the produced resolution to target request ID 41 and contain JSON saying the decision was accepted.

**Call relations**: This test exercises `note_server_request` followed by `take_resolution` for the command-approval path. It confirms that the UI-facing approval ID is correctly linked back to the app-server request ID.

*Call graph*: 3 external calls (Integer, assert_eq!, default).


##### `tests::rejects_permissions_with_paths_that_cannot_be_localized`  (lines 483–528)

```
fn rejects_permissions_with_paths_that_cannot_be_localized()
```

**Purpose**: Checks that permission requests with invalid filesystem paths are rejected immediately instead of being stored as pending. This prevents the app server from waiting forever for a request the UI cannot safely present or answer.

**Data flow**: The test builds a permission request containing a relative path, which cannot be localized as an absolute filesystem path. It records the request and expects an `UnsupportedAppServerRequest` with the same request ID and a message explaining the path-localization failure.

**Call relations**: This test focuses on the validation branch inside `note_server_request`. It confirms that the permission conversion check runs before the request is added to the pending permission approvals table.

*Call graph*: calls 1 internal fn (try_from); 7 external calls (Integer, from, try_from, assert_eq!, cfg!, default, vec!).


##### `tests::resolves_permissions_and_user_input_through_app_server_request_id`  (lines 531–662)

```
fn resolves_permissions_and_user_input_through_app_server_request_id()
```

**Purpose**: Checks two important resolution paths: permission approval and tool user input. It verifies that both are matched back to their app-server request IDs and serialized into the protocol shape the server expects.

**Data flow**: The test records one permission request and one user-input request. It then submits a permission response with network and filesystem grants, expecting a response tied to request ID 7, and submits a user-input answer for the turn, expecting a response tied to request ID 8. It also decodes the JSON responses to prove their contents are correct.

**Call relations**: This test covers `note_server_request` and `take_resolution` for permission approvals and user-input answers. For user input, it indirectly checks `pop_user_input_request_for_turn`, because the answer is matched by turn ID.

*Call graph*: calls 1 internal fn (from_read_write_roots); 5 external calls (assert_eq!, cfg!, once, default, vec!).


##### `tests::correlates_mcp_elicitation_server_request_with_resolution`  (lines 665–710)

```
fn correlates_mcp_elicitation_server_request_with_resolution()
```

**Purpose**: Checks that an MCP elicitation request is tracked using both the MCP server name and the app-server request ID. MCP here means Model Context Protocol, a way for external tools or servers to ask for structured input.

**Data flow**: The test records an MCP elicitation request from server `example` with request ID 12. It then sends an accept decision with content and metadata, and expects the resulting app-server response to use request ID 12 and contain the matching JSON fields.

**Call relations**: This test exercises the MCP branch of `note_server_request` and `take_resolution`. It confirms that the compound key used for MCP requests points back to the correct app-server request.

*Call graph*: 4 external calls (Integer, assert_eq!, json!, default).


##### `tests::rejects_dynamic_tool_calls_as_unsupported`  (lines 713–734)

```
fn rejects_dynamic_tool_calls_as_unsupported()
```

**Purpose**: Checks that dynamic tool calls are clearly rejected because this TUI does not support them yet. This keeps unsupported features from being silently ignored.

**Data flow**: The test sends a dynamic tool call request into the pending tracker. It expects `note_server_request` to return an unsupported-request object with the same request ID and the fixed message saying dynamic tool calls are not available in the TUI yet.

**Call relations**: This test covers one of the unsupported branches in `note_server_request`. It supports the flow where calling code can pass the returned rejection to `App::reject_app_server_request`.

*Call graph*: 4 external calls (Integer, assert_eq!, json!, default).


##### `tests::does_not_mark_chatgpt_auth_refresh_as_unsupported`  (lines 737–750)

```
fn does_not_mark_chatgpt_auth_refresh_as_unsupported()
```

**Purpose**: Checks that a ChatGPT authentication-token refresh request is not treated as an unsupported TUI request. The TUI does not track it here, but this code also should not reject it.

**Data flow**: The test creates an authentication-refresh server request and passes it to `note_server_request`. It expects `None`, meaning no pending UI approval was recorded and no unsupported rejection was requested.

**Call relations**: This test documents the special case in `note_server_request` for authentication refreshes. It distinguishes that request type from truly unsupported request types such as dynamic tool calls.

*Call graph*: 2 external calls (assert_eq!, default).


##### `tests::resolves_patch_approval_through_app_server_request_id`  (lines 753–780)

```
fn resolves_patch_approval_through_app_server_request_id()
```

**Purpose**: Checks that a file-change approval request, also represented in the UI as a patch approval, resolves back to the correct app-server request ID.

**Data flow**: The test records a file-change request with item ID `patch-1` and app-server request ID 13. It then sends a cancel decision for `patch-1` and expects a resolution for request ID 13 with JSON saying the decision was canceled.

**Call relations**: This test exercises the file-change branch of `note_server_request` and the patch-approval branch of `take_resolution`. It proves the UI’s patch ID is correctly connected to the server’s request ID.

*Call graph*: 2 external calls (assert_eq!, default).


##### `tests::resolve_notification_returns_resolved_exec_request`  (lines 783–818)

```
fn resolve_notification_returns_resolved_exec_request()
```

**Purpose**: Checks that when the app server reports a command approval as resolved, the pending tracker removes it and reports which UI approval ID was affected.

**Data flow**: The test records a command approval request, then calls `resolve_notification` with that request ID. It expects a resolved exec-approval result containing `approval-1`, and a second call with the same request ID returns nothing because the entry was already removed.

**Call relations**: This test exercises `note_server_request` followed by `resolve_notification` for command approvals. It confirms that server-side cleanup is one-time and removes stale pending state.

*Call graph*: 2 external calls (assert_eq!, default).


##### `tests::resolve_notification_returns_resolved_mcp_request`  (lines 821–852)

```
fn resolve_notification_returns_resolved_mcp_request()
```

**Purpose**: Checks that server-side resolution notifications also work for MCP elicitation requests. The UI needs to know which MCP prompt disappeared so it can stop showing it.

**Data flow**: The test records an MCP elicitation request from server `example` with request ID 12. It then calls `resolve_notification` with request ID 12 and expects a resolved MCP result containing the server name and request ID.

**Call relations**: This test covers the MCP branch of `resolve_notification`. It confirms that the MCP request key stored by `note_server_request` can be found and removed by app-server request ID.

*Call graph*: 2 external calls (assert_eq!, default).


##### `tests::resolve_notification_returns_resolved_user_input_item_id`  (lines 855–874)

```
fn resolve_notification_returns_resolved_user_input_item_id()
```

**Purpose**: Checks that a server-side notification for a user-input request returns the tool call ID that the UI understands. This lets the UI clear the correct prompt.

**Data flow**: The test records a tool user-input request with request ID 8 and item ID `tool-1`. It then resolves by request ID 8 and expects a user-input result containing call ID `tool-1`.

**Call relations**: This test exercises `resolve_notification` for user input and indirectly tests `remove_user_input_request`. It shows how the tracker translates from app-server request ID back to the UI’s tool call ID.

*Call graph*: 4 external calls (Integer, new, assert_eq!, default).


##### `tests::same_turn_user_input_answers_resolve_app_server_requests_fifo`  (lines 877–912)

```
fn same_turn_user_input_answers_resolve_app_server_requests_fifo()
```

**Purpose**: Checks that multiple user-input requests in the same turn are answered in first-in, first-out order. This prevents a later answer from accidentally being sent to an earlier question, or vice versa.

**Data flow**: The test records two user-input requests for the same turn, with request IDs 8 and 9. It sends two answers for that turn and expects the first answer to resolve request ID 8 and the second answer to resolve request ID 9.

**Call relations**: This test focuses on the queue behavior used by `take_resolution`. It indirectly verifies `pop_user_input_request_for_turn`, which removes the oldest queued request for a turn each time an answer arrives.

*Call graph*: 5 external calls (Integer, new, new, assert_eq!, default).


### Thread routing and interactive replay
These files manage per-thread state, route thread-scoped commands and events, and preserve unresolved interactive prompts across thread switches.

### `tui/src/app/pending_interactive_replay.rs`

`domain_logic` · `request handling, thread snapshot replay, and thread teardown`

The TUI keeps a buffer of recent thread events so it can rebuild the screen when the user switches between threads or agents. Most events can be replayed exactly as they happened. Interactive prompts are different: an approval request, a form-like elicitation, or a tool asking the user a question should only be replayed if it is still waiting for an answer. This file is the bookkeeping for that rule.

It works like a checklist at a front desk. When the server asks for something interactive, the prompt is added to the checklist. When the user answers, the server says the request is resolved, the turn ends, the thread closes, or the old event is evicted from the buffer, the prompt is crossed off. Later, when the event buffer is turned into a snapshot, this state decides whether each prompt should still be included.

The code tracks several prompt types separately: command approvals, file-change approvals, MCP elicitations, permission requests, and user-input requests. It stores both quick lookup sets and per-turn queues. The per-turn queues matter because some answers identify only the turn, not the exact prompt; in that case the oldest waiting prompt for that turn is removed first. The tests at the bottom prove the important behaviors: pending prompts stay visible, answered prompts vanish, multiple queued prompts are handled in order, and closing a thread clears everything.

#### Function details

##### `ElicitationRequestKey::new`  (lines 16–21)

```
fn new(server_name: String, request_id: AppServerRequestId) -> Self
```

**Purpose**: Builds a small identifier for an MCP elicitation request. It combines the server name with the server request id, because the request id alone is not enough to clearly describe which elicitation is being tracked.

**Data flow**: It receives a server name and a request id. It puts both values into a new key object. The result is used as a stable label for adding, finding, or removing that elicitation from the pending set.

**Call relations**: The pending-state code calls this whenever it sees, resolves, evicts, or checks an elicitation request. It gives those flows a shared way to talk about the same prompt.

*Call graph*: called by 4 (note_evicted_server_request, note_outbound_op, note_server_request, should_replay_snapshot_request).


##### `PendingInteractiveReplayState::op_can_change_state`  (lines 73–87)

```
fn op_can_change_state(op: T) -> bool
```

**Purpose**: Quickly answers whether an outgoing app command might change the pending-prompt checklist. This lets higher-level code avoid unnecessary work for commands that cannot resolve or clear prompts.

**Data flow**: It receives something that can be turned into an AppCommand. It converts it, checks whether it is one of the prompt-resolving or shutdown commands, and returns true or false.

**Call relations**: The outer thread event store calls this through its own helper before deciding whether an outgoing operation might affect replay state. It does not change anything itself; it is only a filter.

*Call graph*: called by 1 (op_can_change_pending_replay_state); 2 external calls (into, matches!).


##### `PendingInteractiveReplayState::note_outbound_op`  (lines 89–170)

```
fn note_outbound_op(&mut self, op: T)
```

**Purpose**: Updates the pending-prompt checklist after the TUI sends an answer or shutdown command outward. This prevents prompts the user already answered from being replayed later.

**Data flow**: It receives an outgoing AppCommand. If the command accepts or rejects an approval, resolves an elicitation, answers a permission request, answers a user-input prompt, or shuts down, it removes the matching pending entries. For user-input answers, it removes the oldest queued prompt for that turn because the answer names the turn rather than the exact prompt.

**Call relations**: The surrounding event store calls this when an operation leaves the UI. It uses helper removal functions for per-turn lists, uses ElicitationRequestKey::new for elicitation lookup, and calls clear when shutdown means no pending prompt should remain.

*Call graph*: calls 2 internal fn (new, clear); called by 1 (note_outbound_op); 3 external calls (remove_call_id_from_turn_map, remove_call_id_from_turn_map_entry, into).


##### `PendingInteractiveReplayState::note_server_request`  (lines 172–250)

```
fn note_server_request(&mut self, request: &ServerRequest)
```

**Purpose**: Records a new interactive request from the server as pending. This is how the replay system learns that a prompt should be shown again if the thread view is rebuilt before it is answered.

**Data flow**: It receives a ServerRequest. If the request is one of the interactive types, it stores its id in the right lookup set, records it under its turn when applicable, and stores a request-id mapping so a later server resolution can remove it.

**Call relations**: The thread event store calls this when a request is pushed into the event buffer. It creates elicitation keys through ElicitationRequestKey::new and creates PendingInteractiveRequest records so later notifications and outbound answers can find the same prompt.

*Call graph*: calls 1 internal fn (new); called by 1 (push_request); 1 external calls (Elicitation).


##### `PendingInteractiveReplayState::note_server_notification`  (lines 252–283)

```
fn note_server_notification(&mut self, notification: &ServerNotification)
```

**Purpose**: Updates pending prompts when the server sends a lifecycle notification. It clears prompts that are no longer valid because work started, a turn completed, a request was resolved, or the thread closed.

**Data flow**: It receives a ServerNotification. Depending on the notification type, it removes individual approval ids, clears all prompts tied to a completed turn, removes a request by request id, or clears the entire state.

**Call relations**: The event store calls this when a notification is pushed. This function hands off to the turn-clearing helpers, remove_request, clear, and the shared call-id removal helper so all internal lookup tables stay in sync.

*Call graph*: calls 6 internal fn (clear, clear_exec_approval_turn, clear_patch_approval_turn, clear_request_permissions_turn, clear_request_user_input_turn, remove_request); called by 1 (push_notification); 1 external calls (remove_call_id_from_turn_map).


##### `PendingInteractiveReplayState::note_evicted_server_request`  (lines 285–352)

```
fn note_evicted_server_request(&mut self, request: &ServerRequest)
```

**Purpose**: Forgets a pending prompt when the original request event falls out of the replay buffer. If the event can no longer be replayed, the pending-state checklist must not keep pointing to it.

**Data flow**: It receives the server request being evicted. It removes that request’s identifiers from the relevant sets and per-turn lists, then removes matching request-id records from the pending map.

**Call relations**: The event store calls this when adding new events forces old requests out, and also from notification-related buffer maintenance. It uses ElicitationRequestKey::new and removal helpers to keep all indexes consistent.

*Call graph*: calls 1 internal fn (new); called by 2 (push_notification, push_request); 1 external calls (remove_call_id_from_turn_map_entry).


##### `PendingInteractiveReplayState::should_replay_snapshot_request`  (lines 354–376)

```
fn should_replay_snapshot_request(&self, request: &ServerRequest) -> bool
```

**Purpose**: Decides whether a request from the event buffer should be included in a replay snapshot. For interactive prompts, it says yes only if the prompt is still pending.

**Data flow**: It receives a ServerRequest. For tracked prompt types, it checks the matching pending set; for other request types, it returns true because ordinary requests can be replayed normally.

**Call relations**: Snapshot-building code uses this as the final gate before replaying buffered requests. It uses ElicitationRequestKey::new to check MCP elicitations by their combined server-name and request-id key.

*Call graph*: calls 1 internal fn (new).


##### `PendingInteractiveReplayState::has_pending_thread_approvals`  (lines 378–383)

```
fn has_pending_thread_approvals(&self) -> bool
```

**Purpose**: Reports whether the current thread has unresolved approval-like prompts. This helps the UI show that a thread still needs user attention.

**Data flow**: It reads the sets for command approvals, file-change approvals, elicitations, and permission requests. If any of them is non-empty, it returns true; user-input questions are intentionally not counted here.

**Call relations**: Higher-level status helpers call this when building pending-status indicators. It is a read-only view of the state maintained by the request, notification, eviction, and outbound-operation paths.

*Call graph*: called by 2 (has_pending_thread_approvals, side_parent_pending_status).


##### `PendingInteractiveReplayState::has_pending_thread_user_input`  (lines 385–387)

```
fn has_pending_thread_user_input(&self) -> bool
```

**Purpose**: Reports whether the current thread has unresolved user-input questions. This is separate from approvals because the UI may display or prioritize them differently.

**Data flow**: It checks the set of pending user-input call ids. It returns true if at least one question is still waiting for an answer.

**Call relations**: The side-panel pending-status flow calls this alongside the approval check. It depends on the same bookkeeping updated when requests arrive and answers or resolutions happen.

*Call graph*: called by 1 (side_parent_pending_status).


##### `PendingInteractiveReplayState::clear_request_user_input_turn`  (lines 389–400)

```
fn clear_request_user_input_turn(&mut self, turn_id: &str)
```

**Purpose**: Removes all pending user-input questions for one completed turn. Once a turn is complete, old unanswered questions from that turn should not be replayed.

**Data flow**: It receives a turn id. It removes the queued call ids for that turn, deletes those ids from the main user-input set, and drops matching records from the request-id map.

**Call relations**: note_server_notification calls this when it receives a TurnCompleted notification. It is one of several turn-specific cleanup helpers used to clear stale prompts.

*Call graph*: called by 1 (note_server_notification).


##### `PendingInteractiveReplayState::clear_request_permissions_turn`  (lines 402–413)

```
fn clear_request_permissions_turn(&mut self, turn_id: &str)
```

**Purpose**: Removes all pending permission requests for one completed turn. This keeps permission prompts from surviving after the turn they belonged to has finished.

**Data flow**: It receives a turn id. It removes all permission request ids stored for that turn, deletes them from the quick lookup set, and removes matching pending request records.

**Call relations**: note_server_notification calls this during turn completion cleanup. It mirrors the other per-turn clear helpers for different prompt types.

*Call graph*: called by 1 (note_server_notification).


##### `PendingInteractiveReplayState::clear_exec_approval_turn`  (lines 415–426)

```
fn clear_exec_approval_turn(&mut self, turn_id: &str)
```

**Purpose**: Removes all pending command-execution approvals for one completed turn. A command approval tied to a finished turn is no longer a live prompt.

**Data flow**: It receives a turn id. It removes the stored command approval ids for that turn, deletes each from the main approval set, and removes matching request-id records.

**Call relations**: note_server_notification calls this when the server says a turn completed. It keeps command-approval replay state aligned with turn lifecycle.

*Call graph*: called by 1 (note_server_notification).


##### `PendingInteractiveReplayState::clear_patch_approval_turn`  (lines 428–439)

```
fn clear_patch_approval_turn(&mut self, turn_id: &str)
```

**Purpose**: Removes all pending file-change approvals for one completed turn. This stops old patch approvals from being replayed after their turn ends.

**Data flow**: It receives a turn id. It removes the file-change ids queued under that turn, deletes them from the main patch-approval set, and drops matching pending request records.

**Call relations**: note_server_notification calls this during turn completion handling. It works alongside the command, permission, and user-input turn cleanup helpers.

*Call graph*: called by 1 (note_server_notification).


##### `PendingInteractiveReplayState::remove_call_id_from_turn_map`  (lines 441–449)

```
fn remove_call_id_from_turn_map(
        call_ids_by_turn_id: &mut HashMap<String, Vec<String>>,
        call_id: &str,
    )
```

**Purpose**: Removes a prompt id from every per-turn queue in a map. This is useful when the code knows the prompt id but may not know which turn list contains it.

**Data flow**: It receives a map from turn ids to lists of prompt ids, plus the prompt id to remove. It scans every list, removes that id wherever it appears, and deletes any turn entries left empty.

**Call relations**: Several cleanup paths use this helper after item-started notifications or outbound approvals. It is a small internal tool that keeps per-turn queues tidy.


##### `PendingInteractiveReplayState::remove_call_id_from_turn_map_entry`  (lines 451–466)

```
fn remove_call_id_from_turn_map_entry(
        call_ids_by_turn_id: &mut HashMap<String, Vec<String>>,
        turn_id: &str,
        call_id: &str,
    )
```

**Purpose**: Removes a prompt id from one known turn’s queue. This is the faster, more precise version used when both the turn id and prompt id are known.

**Data flow**: It receives a per-turn map, a turn id, and a prompt id. It edits only that turn’s list, removes the prompt id, and removes the whole turn entry if its list becomes empty.

**Call relations**: Outbound handling, eviction handling, and remove_request call this when they can identify the exact turn. It helps keep the quick lookup sets and per-turn queues in agreement.


##### `PendingInteractiveReplayState::clear`  (lines 468–479)

```
fn clear(&mut self)
```

**Purpose**: Erases all pending interactive replay state. This is used when the thread is closed or the app shuts down, when no old prompt should remain active.

**Data flow**: It reads no outside data. It clears every set, every per-turn map, and the request-id mapping, leaving the state as if no prompts had ever been recorded.

**Call relations**: note_outbound_op calls this for shutdown, and note_server_notification calls it when a thread closes. It is the full reset path for this file.

*Call graph*: called by 2 (note_outbound_op, note_server_notification).


##### `PendingInteractiveReplayState::remove_request`  (lines 481–525)

```
fn remove_request(&mut self, request_id: &AppServerRequestId)
```

**Purpose**: Removes one pending prompt by the server’s request id. This handles the case where the server explicitly says a request has been resolved.

**Data flow**: It receives a request id. It looks up the stored PendingInteractiveRequest, removes it from the request-id map, then removes the matching id or key from the prompt-specific sets and per-turn queues.

**Call relations**: note_server_notification calls this for ServerRequestResolved notifications. It delegates per-turn queue cleanup to remove_call_id_from_turn_map_entry when the prompt type has a turn.

*Call graph*: called by 1 (note_server_notification); 1 external calls (remove_call_id_from_turn_map_entry).


##### `PendingInteractiveReplayState::request_matches_server_request`  (lines 527–560)

```
fn request_matches_server_request(
        pending: &PendingInteractiveRequest,
        request: &ServerRequest,
    ) -> bool
```

**Purpose**: Checks whether a stored pending prompt describes the same prompt as a specific server request. This is used when an event is evicted and the code needs to remove its matching pending record.

**Data flow**: It receives a PendingInteractiveRequest and a ServerRequest. It compares the relevant fields for that prompt type, such as turn id, item id, approval id, server name, and request id, then returns true or false.

**Call relations**: note_evicted_server_request uses this as a matching test while pruning the request-id map. It centralizes the comparison rules so eviction cleanup removes the right pending entry.


##### `tests::request_user_input_request`  (lines 592–603)

```
fn request_user_input_request(call_id: &str, turn_id: &str) -> ServerRequest
```

**Purpose**: Builds a test server request for a tool asking the user for input. It keeps the tests short and focused on behavior instead of setup details.

**Data flow**: It receives a call id and turn id. It creates a ToolRequestUserInput server request with those values and fixed test defaults, then returns it.

**Call relations**: Many tests call this helper before pushing a user-input request into the ThreadEventStore. It supplies the event that the pending replay state should track or drop.

*Call graph*: 2 external calls (Integer, new).


##### `tests::exec_approval_request`  (lines 605–629)

```
fn exec_approval_request(
        call_id: &str,
        approval_id: Option<&str>,
        turn_id: &str,
    ) -> ServerRequest
```

**Purpose**: Builds a test server request for approving command execution. It lets tests cover command approval replay without repeating the full request structure each time.

**Data flow**: It receives a call id, an optional approval id, and a turn id. It creates a CommandExecutionRequestApproval with test defaults such as a sample command and working directory, then returns it.

**Call relations**: Approval-related tests call this helper before pushing requests into the store. The pending replay code then uses its ids to decide whether the approval should remain in snapshots.

*Call graph*: 2 external calls (Integer, test_path_buf).


##### `tests::patch_approval_request`  (lines 631–643)

```
fn patch_approval_request(call_id: &str, turn_id: &str) -> ServerRequest
```

**Purpose**: Builds a test server request for approving a file change. It provides a compact way for tests to create patch approval prompts.

**Data flow**: It receives a call id and turn id. It fills a FileChangeRequestApproval with those values and fixed test defaults, then returns it.

**Call relations**: Patch-approval tests call this helper before pushing the request into the event store. It creates the prompt that later outbound approvals or turn completion should remove.

*Call graph*: 1 external calls (Integer).


##### `tests::elicitation_request`  (lines 645–664)

```
fn elicitation_request(server_name: &str, request_id: &str, turn_id: &str) -> ServerRequest
```

**Purpose**: Builds a test MCP elicitation request, which is a server asking the user for structured information or confirmation. It gives tests a realistic elicitation prompt to track.

**Data flow**: It receives a server name, request id, and turn id. It creates a form-style elicitation request with a simple message and empty schema, then returns it.

**Call relations**: The elicitation resolution test uses this helper to add a pending elicitation to the store. The outbound ResolveElicitation command should then remove it from replay snapshots.

*Call graph*: 2 external calls (String, new).


##### `tests::turn_completed`  (lines 666–680)

```
fn turn_completed(turn_id: &str) -> ServerNotification
```

**Purpose**: Builds a test notification saying a turn has completed. Tests use it to check that prompts tied to a finished turn are cleaned up.

**Data flow**: It receives a turn id. It creates a TurnCompleted notification with that id and basic completed-turn metadata, then returns it.

**Call relations**: Turn-completion tests push this notification into the store after adding pending prompts. That triggers the production cleanup path in note_server_notification.

*Call graph*: 2 external calls (TurnCompleted, new).


##### `tests::thread_closed`  (lines 682–686)

```
fn thread_closed() -> ServerNotification
```

**Purpose**: Builds a test notification saying the thread has closed. It lets tests verify that closing a thread clears all pending prompt state.

**Data flow**: It takes no input. It returns a ThreadClosed notification for the fixed test thread id.

**Call relations**: The thread-close test pushes this notification after adding a pending request. The production notification path should then clear the state.

*Call graph*: 1 external calls (ThreadClosed).


##### `tests::request_resolved`  (lines 688–693)

```
fn request_resolved(request_id: AppServerRequestId) -> ServerNotification
```

**Purpose**: Builds a test notification saying a specific server request was resolved. Tests use it to simulate the server confirming that a prompt is no longer pending.

**Data flow**: It receives a request id. It wraps that id in a ServerRequestResolved notification for the fixed test thread and returns it.

**Call relations**: Several tests push this notification after adding a pending request. It exercises remove_request through the normal notification flow.

*Call graph*: 1 external calls (ServerRequestResolved).


##### `tests::thread_event_snapshot_keeps_pending_request_user_input`  (lines 696–709)

```
fn thread_event_snapshot_keeps_pending_request_user_input()
```

**Purpose**: Checks that an unanswered user-input request is still present when the thread snapshot is built. This protects the basic rule that live prompts must replay.

**Data flow**: It creates a ThreadEventStore, pushes one user-input request, then asks for a snapshot. It verifies that the snapshot contains that request with the expected item id.

**Call relations**: The test uses request_user_input_request to create the event and then relies on the store’s push and snapshot paths to call the pending replay logic.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert!, assert_eq!, request_user_input_request).


##### `tests::thread_event_snapshot_drops_resolved_request_user_input_after_user_answer`  (lines 712–728)

```
fn thread_event_snapshot_drops_resolved_request_user_input_after_user_answer()
```

**Purpose**: Checks that a user-input prompt disappears from replay after the user answers it. This prevents answered questions from popping up again after a thread switch.

**Data flow**: It creates a store, pushes a user-input request, records an outbound UserInputAnswer for the same turn, then builds a snapshot. It expects the snapshot to be empty.

**Call relations**: The test drives the normal outbound-operation path, which calls note_outbound_op and removes the oldest queued user-input prompt for that turn.

*Call graph*: calls 1 internal fn (new); 3 external calls (new, assert!, request_user_input_request).


##### `tests::thread_event_snapshot_drops_resolved_request_user_input_after_server_resolution`  (lines 731–747)

```
fn thread_event_snapshot_drops_resolved_request_user_input_after_server_resolution()
```

**Purpose**: Checks that a user-input prompt disappears when the server says the request was resolved. This covers resolution that comes from the server rather than directly from the local answer path.

**Data flow**: It pushes a user-input request, pushes a ServerRequestResolved notification for that request id, then snapshots the store. It verifies no user-input request remains in the replay events.

**Call relations**: The test uses request_resolved to exercise note_server_notification and remove_request through the store’s notification path.

*Call graph*: calls 1 internal fn (new); 4 external calls (Integer, assert!, request_resolved, request_user_input_request).


##### `tests::thread_event_snapshot_drops_resolved_exec_approval_after_outbound_approval_id`  (lines 750–769)

```
fn thread_event_snapshot_drops_resolved_exec_approval_after_outbound_approval_id()
```

**Purpose**: Checks that a command approval is removed from replay after the UI sends a decision using the approval id. This matters because command approvals can have an approval id separate from the item id.

**Data flow**: It pushes a command approval request with approval id "approval-1", sends an outbound ExecApproval decision for that id, then snapshots. It expects no replay events.

**Call relations**: The test uses exec_approval_request and then exercises note_outbound_op through the store. It confirms the production code removes the approval by the correct identifier.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert!, exec_approval_request).


##### `tests::thread_event_snapshot_drops_resolved_exec_approval_after_server_resolution`  (lines 772–794)

```
fn thread_event_snapshot_drops_resolved_exec_approval_after_server_resolution()
```

**Purpose**: Checks that a command approval is removed when the server reports the request resolved. This ensures server-side resolution also cleans up approval prompts.

**Data flow**: It pushes a command approval request, then pushes a resolved notification for that request id. The snapshot is checked to make sure no command approval request remains.

**Call relations**: The test drives the notification path with request_resolved, which should call remove_request and update the pending replay state.

*Call graph*: calls 1 internal fn (new); 4 external calls (Integer, assert!, exec_approval_request, request_resolved).


##### `tests::thread_event_snapshot_drops_answered_request_user_input_for_multi_prompt_turn`  (lines 797–817)

```
fn thread_event_snapshot_drops_answered_request_user_input_for_multi_prompt_turn()
```

**Purpose**: Checks that when a turn has multiple user-input prompts over time, answering one does not erase a later new prompt. It protects the first-in, first-out behavior for turn-based answers.

**Data flow**: It pushes one user-input prompt, sends an answer for the turn, then pushes a second prompt for the same turn. The snapshot should contain only the second prompt.

**Call relations**: The test uses request_user_input_request twice and drives the outbound answer path between them. It confirms note_outbound_op removes only the oldest queued prompt.

*Call graph*: calls 1 internal fn (new); 4 external calls (new, assert!, assert_eq!, request_user_input_request).


##### `tests::thread_event_snapshot_keeps_newer_request_user_input_pending_when_same_turn_has_queue`  (lines 820–839)

```
fn thread_event_snapshot_keeps_newer_request_user_input_pending_when_same_turn_has_queue()
```

**Purpose**: Checks that if two user-input prompts are already queued for the same turn, one answer removes only the older one. The newer unanswered prompt must still replay.

**Data flow**: It pushes two user-input requests for the same turn, sends one UserInputAnswer, then snapshots. It verifies only the second request remains.

**Call relations**: This test directly exercises the per-turn queue behavior inside note_outbound_op. It proves that user-input answers are matched in queue order.

*Call graph*: calls 1 internal fn (new); 4 external calls (new, assert!, assert_eq!, request_user_input_request).


##### `tests::thread_event_snapshot_drops_resolved_patch_approval_after_outbound_approval`  (lines 842–856)

```
fn thread_event_snapshot_drops_resolved_patch_approval_after_outbound_approval()
```

**Purpose**: Checks that a file-change approval is removed after the user sends an approval decision. This prevents resolved patch prompts from reappearing.

**Data flow**: It pushes a patch approval request, sends an outbound PatchApproval decision for that id, then snapshots. It expects the snapshot to be empty.

**Call relations**: The test uses patch_approval_request and then exercises the outbound-operation cleanup path in the pending replay state.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert!, patch_approval_request).


##### `tests::thread_event_snapshot_drops_pending_approvals_when_turn_completes`  (lines 859–877)

```
fn thread_event_snapshot_drops_pending_approvals_when_turn_completes()
```

**Purpose**: Checks that pending command and file-change approvals are cleared when their turn completes. A finished turn should not keep stale approval prompts alive.

**Data flow**: It pushes one command approval and one patch approval for the same turn, then pushes a TurnCompleted notification. The snapshot is checked to ensure neither approval request remains.

**Call relations**: The test uses turn_completed to drive note_server_notification, which should call the turn cleanup helpers for command and patch approvals.

*Call graph*: calls 1 internal fn (new); 4 external calls (assert!, exec_approval_request, patch_approval_request, turn_completed).


##### `tests::thread_event_snapshot_drops_resolved_elicitation_after_outbound_resolution`  (lines 880–898)

```
fn thread_event_snapshot_drops_resolved_elicitation_after_outbound_resolution()
```

**Purpose**: Checks that an MCP elicitation prompt is removed after the UI sends a resolution. This prevents already answered server elicitations from replaying.

**Data flow**: It pushes an elicitation request, sends an outbound ResolveElicitation command with the same server name and request id, then snapshots. It expects no replay events.

**Call relations**: The test uses elicitation_request and drives the outbound-operation path. It confirms elicitation matching uses the combined server name and request id.

*Call graph*: calls 1 internal fn (new); 3 external calls (String, assert!, elicitation_request).


##### `tests::thread_event_store_reports_pending_thread_approvals`  (lines 901–918)

```
fn thread_event_store_reports_pending_thread_approvals()
```

**Purpose**: Checks the public pending-approval indicator on the thread event store. It should be false when no approval is waiting, true after an approval request, and false again after the approval is answered.

**Data flow**: It creates a store, reads the pending approval status, pushes a command approval request, reads the status again, then sends an approval decision and reads the status a final time.

**Call relations**: The test exercises the store-level wrapper around has_pending_thread_approvals while using the normal request and outbound-operation paths to change the state.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert_eq!, exec_approval_request).


##### `tests::request_user_input_does_not_count_as_pending_thread_approval`  (lines 921–926)

```
fn request_user_input_does_not_count_as_pending_thread_approval()
```

**Purpose**: Checks that user-input questions are not counted as approval prompts. This keeps the UI from labeling ordinary questions as approvals.

**Data flow**: It pushes a user-input request into a new store and then checks the pending approval status. The expected result is false.

**Call relations**: The test uses request_user_input_request and the store-level approval status call. It confirms has_pending_thread_approvals deliberately excludes user-input prompts.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert_eq!, request_user_input_request).


##### `tests::thread_event_snapshot_drops_pending_requests_when_thread_closes`  (lines 929–942)

```
fn thread_event_snapshot_drops_pending_requests_when_thread_closes()
```

**Purpose**: Checks that closing a thread clears pending requests from replay. Once a thread is closed, no old prompt from it should remain visible.

**Data flow**: It pushes a command approval request, then pushes a ThreadClosed notification. The snapshot is checked to ensure no command approval request remains.

**Call relations**: The test uses thread_closed to drive the notification path, which should call clear and empty all pending interactive replay state.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert!, exec_approval_request, thread_closed).


### `tui/src/app/thread_routing.rs`

`orchestration` · `main loop, thread switching, request handling, shutdown`

The TUI can show and work with more than one conversation thread, such as a main chat plus agent or review threads. This file makes that possible without mixing their messages, approvals, history, or shutdown events. Think of it like a train station switchboard: each thread has its own track, incoming server events are routed onto the right track, and only the currently visible track is played live on screen.

The file creates and stores per-thread event channels, marks one thread as active, saves the user’s input when switching away, and replays buffered messages when switching back. It also turns backend requests, such as command approvals or file-change approvals, into UI prompts the user can answer. When the user submits something, interrupts a turn, rolls back, starts a review, or changes settings, this file decides whether that action resolves a pending server request or must be sent as a new command to the app server.

It also protects important edge cases. If an inactive thread needs approval, the UI can still surface it. If a non-primary agent thread closes unexpectedly, the app tries to return the user to the main thread. If cached session details are incomplete before replay, it refreshes them from the server.

#### Function details

##### `App::shutdown_current_thread`  (lines 11–20)

```
async fn shutdown_current_thread(&mut self, app_server: &mut AppServerSession)
```

**Purpose**: Stops listening to the thread currently shown in the chat. This is used when leaving or replacing a thread so the app does not keep receiving live events for something the user is no longer viewing.

**Data flow**: It reads the current thread id from the chat widget. If one exists, it clears any pending rollback state, asks the app server to unsubscribe from that thread, logs a warning if that fails, and then aborts the local listener task for that thread.

**Call relations**: When a thread is being shut down from the TUI side, this function coordinates the server unsubscribe and then hands local cleanup to App::abort_thread_event_listener.

*Call graph*: calls 2 internal fn (abort_thread_event_listener, thread_unsubscribe); 1 external calls (warn!).


##### `App::abort_thread_event_listener`  (lines 22–26)

```
fn abort_thread_event_listener(&mut self, thread_id: ThreadId)
```

**Purpose**: Cancels the background task that listens for events for one thread. This prevents old listener tasks from continuing to feed events after a thread has been left.

**Data flow**: It receives a thread id, looks up the listener task stored for that id, removes it from the app’s task map, and aborts it if found. It returns nothing.

**Call relations**: App::shutdown_current_thread calls this after asking the server to unsubscribe, so both remote and local event flow are stopped together.

*Call graph*: called by 1 (shutdown_current_thread).


##### `App::abort_all_thread_event_listeners`  (lines 28–36)

```
fn abort_all_thread_event_listeners(&mut self)
```

**Purpose**: Cancels every background thread event listener known to the app. This is useful during broader cleanup, such as app shutdown.

**Data flow**: It drains the map of listener tasks, taking ownership of each task handle, and aborts each one. Afterward, no listener handles remain stored in the app.

**Call relations**: This is a bulk cleanup helper for the same kind of listener task that App::abort_thread_event_listener cancels one at a time.


##### `App::ensure_thread_channel`  (lines 38–42)

```
fn ensure_thread_channel(&mut self, thread_id: ThreadId) -> &mut ThreadEventChannel
```

**Purpose**: Makes sure a conversation thread has a local event channel and storage area. Without this, incoming events for a thread would have nowhere safe to wait.

**Data flow**: It takes a thread id, checks whether a channel already exists for it, and creates a new buffered channel if not. It returns a mutable reference to that channel.

**Call relations**: Several routing paths call this before adding notifications, requests, history results, primary sessions, or review-thread state, so later code can assume the channel exists.

*Call graph*: called by 5 (enqueue_primary_thread_session, enqueue_thread_history_entry_response, enqueue_thread_notification, enqueue_thread_request, try_submit_active_thread_op_via_app_server).


##### `App::set_thread_active`  (lines 44–49)

```
async fn set_thread_active(&mut self, thread_id: ThreadId, active: bool)
```

**Purpose**: Marks a thread’s stored event state as active or inactive. The active flag decides whether new buffered events should also be sent immediately to the visible UI receiver.

**Data flow**: It receives a thread id and a true-or-false active value. If that thread has a channel, it locks the thread’s store and updates the active flag.

**Call relations**: App::activate_thread_channel uses it when a thread becomes visible, and App::clear_active_thread uses it when the current thread is no longer visible.

*Call graph*: called by 2 (activate_thread_channel, clear_active_thread).


##### `App::activate_thread_channel`  (lines 51–64)

```
async fn activate_thread_channel(&mut self, thread_id: ThreadId)
```

**Purpose**: Makes a thread the current live thread, but only if no other thread is already active. It connects the thread’s receiver so the UI can drain live events from it.

**Data flow**: It takes a thread id, returns early if another active thread already exists, marks the requested thread active, moves that thread’s receiver into the app’s active receiver slot, records the active id, and refreshes the pending-approval indicator.

**Call relations**: App::enqueue_primary_thread_session calls this when the primary session is first installed. It uses App::set_thread_active and then App::refresh_pending_thread_approvals to keep UI state consistent.

*Call graph*: calls 2 internal fn (refresh_pending_thread_approvals, set_thread_active); called by 1 (enqueue_primary_thread_session).


##### `App::store_active_thread_receiver`  (lines 66–80)

```
async fn store_active_thread_receiver(&mut self)
```

**Purpose**: Parks the current thread’s live receiver back in its channel before switching away. It also saves the draft input state so the user can return without losing what they typed.

**Data flow**: It reads the active thread id and captures the chat widget’s input state. It then moves the active receiver back into that thread’s channel, marks the store inactive, saves the input state, and leaves the app without an active receiver.

**Call relations**: This supports thread switching by preserving the live event pipe and text-entry state before another thread is activated or replayed.


##### `App::activate_thread_for_replay`  (lines 82–92)

```
async fn activate_thread_for_replay(
        &mut self,
        thread_id: ThreadId,
    ) -> Option<(mpsc::Receiver<ThreadBufferedEvent>, ThreadEventSnapshot)>
```

**Purpose**: Prepares a thread to be replayed on screen. It gives the caller both the live receiver and a snapshot of stored past events.

**Data flow**: It receives a thread id, finds that thread’s channel, takes its receiver, marks its store active, snapshots stored session, turns, buffered events, and input state, and returns the receiver plus snapshot. If anything is missing, it returns nothing.

**Call relations**: This is used by thread-switching code outside this file before replaying a thread with App::replay_thread_snapshot.


##### `App::clear_active_thread`  (lines 94–100)

```
async fn clear_active_thread(&mut self)
```

**Purpose**: Forgets which thread is currently active. This is used when a live event stream disconnects or a thread switch needs to leave no active thread temporarily.

**Data flow**: It takes the current active thread id if present, marks that thread inactive, clears the active receiver, and refreshes the pending-approval display.

**Call relations**: App::drain_active_thread_events, App::handle_active_thread_event, and App::handle_thread_rollback_response call this when the active receiver is no longer usable or the visible thread must be cleared.

*Call graph*: calls 2 internal fn (refresh_pending_thread_approvals, set_thread_active); called by 3 (drain_active_thread_events, handle_active_thread_event, handle_thread_rollback_response).


##### `App::note_thread_outbound_op`  (lines 102–108)

```
async fn note_thread_outbound_op(&mut self, thread_id: ThreadId, op: &AppCommand)
```

**Purpose**: Records that the user sent an operation for a particular thread. This helps the replay buffer know which pending approval or request state may have changed.

**Data flow**: It receives a thread id and an app command. If the thread channel exists, it locks that thread’s store and lets the store update its outbound-operation bookkeeping.

**Call relations**: App::submit_thread_op and App::try_resolve_app_server_request call this after successfully sending or resolving commands that can affect pending replay state. App::note_active_thread_outbound_op uses it for the active thread.

*Call graph*: called by 3 (note_active_thread_outbound_op, submit_thread_op, try_resolve_app_server_request).


##### `App::note_active_thread_outbound_op`  (lines 110–118)

```
async fn note_active_thread_outbound_op(&mut self, op: &AppCommand)
```

**Purpose**: Records an outbound operation for the active thread, but only when that operation can affect replayed pending-request state.

**Data flow**: It receives an app command, first checks whether the command type matters for pending replay state, then reads the active thread id and records the operation for that thread if possible.

**Call relations**: This is a convenience wrapper around App::note_thread_outbound_op. It relies on ThreadEventStore::op_can_change_pending_replay_state to avoid unnecessary bookkeeping.

*Call graph*: calls 2 internal fn (op_can_change_pending_replay_state, note_thread_outbound_op).


##### `App::active_turn_id_for_thread`  (lines 120–124)

```
async fn active_turn_id_for_thread(&self, thread_id: ThreadId) -> Option<String>
```

**Purpose**: Looks up the currently running turn for a thread. A turn is one assistant work cycle, and its id is needed for actions like interrupting or steering that work.

**Data flow**: It receives a thread id, finds the thread channel, locks its store, copies the active turn id if one exists, and returns it.

**Call relations**: App::try_submit_active_thread_op_via_app_server calls this before sending interrupt or user-turn steering commands to the app server.

*Call graph*: called by 1 (try_submit_active_thread_op_via_app_server).


##### `App::thread_label`  (lines 126–151)

```
fn thread_label(&self, thread_id: ThreadId) -> String
```

**Purpose**: Builds a human-friendly name for a thread. This keeps prompts and pickers from showing only long internal thread ids.

**Data flow**: It receives a thread id, checks whether it is the primary thread, chooses a fallback label such as main or agent plus a short id, then prefers stored agent nickname or role metadata when available.

**Call relations**: App::interactive_request_for_thread_request uses this label when building approval prompts so the user can tell which thread is asking.

*Call graph*: called by 1 (interactive_request_for_thread_request); 3 external calls (format!, chars, to_string).


##### `App::current_displayed_thread_id`  (lines 159–161)

```
fn current_displayed_thread_id(&self) -> Option<ThreadId>
```

**Purpose**: Returns the thread the user is actually looking at. It accounts for short transition moments where the app’s active-thread bookkeeping and the chat widget may briefly disagree.

**Data flow**: It reads the app’s active thread id first. If that is missing, it falls back to the chat widget’s thread id, then returns the result.

**Call relations**: App::sync_active_agent_label uses this to make footer labels follow the visible transcript rather than a half-completed switch.

*Call graph*: called by 1 (sync_active_agent_label).


##### `App::ignore_same_thread_resume`  (lines 163–176)

```
fn ignore_same_thread_resume(
        &mut self,
        target_session: &crate::resume_picker::SessionTarget,
    ) -> bool
```

**Purpose**: Stops a resume action when the requested session is already being viewed. This avoids doing a pointless reload and gives the user a clear message instead.

**Data flow**: It receives a resume target, compares its thread id with the active thread id, and returns false if they differ. If they match, it adds an informational message to the chat widget and returns true.

**Call relations**: Resume-selection code can call this before attempting a switch or reload, using the true result as a signal that the request has already been handled.

*Call graph*: 1 external calls (format!).


##### `App::sync_active_agent_label`  (lines 184–190)

```
fn sync_active_agent_label(&mut self)
```

**Purpose**: Updates the footer area with the label for the currently viewed agent thread. It hides unnecessary labeling when there is only one thread.

**Data flow**: It asks the agent-navigation state for a label using the displayed thread id and primary thread id, sends that label to the chat widget, and then synchronizes side-thread UI state.

**Call relations**: App::cache_collab_receiver_threads_for_notification calls this when new collaboration activity changes what agent label should be shown.

*Call graph*: calls 1 internal fn (current_displayed_thread_id); called by 1 (cache_collab_receiver_threads_for_notification).


##### `App::thread_cwd`  (lines 192–196)

```
async fn thread_cwd(&self, thread_id: ThreadId) -> Option<AbsolutePathBuf>
```

**Purpose**: Finds the working directory for a thread. The working directory is the folder that file operations and patches are relative to.

**Data flow**: It receives a thread id, finds the channel, locks the store, reads the stored session if any, clones its working directory, and returns it.

**Call relations**: App::interactive_request_for_thread_request uses this when preparing file-change approval prompts, falling back to the global config directory if the thread has no stored session.

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

**Purpose**: Retrieves the detailed file changes tied to a file-approval request. This lets the UI show what a patch would actually change.

**Data flow**: It receives a thread id, turn id, and item id. It locks the thread store and asks it for the saved file-update changes matching those identifiers, returning the list if found.

**Call relations**: App::interactive_request_for_thread_request calls this while converting a backend file-change approval into a user-facing patch approval prompt.

*Call graph*: called by 1 (interactive_request_for_thread_request).


##### `App::interactive_request_for_thread_request`  (lines 209–330)

```
async fn interactive_request_for_thread_request(
        &self,
        thread_id: ThreadId,
        request: &ServerRequest,
    ) -> std::io::Result<Option<ThreadInteractiveRequest>>
```

**Purpose**: Converts a raw app-server request into something the TUI can show and ask the user about. It covers approvals for commands, patches, permissions, and external tool elicitation.

**Data flow**: It receives a thread id and server request. It adds a thread label, copies relevant request fields, looks up extra context such as working directory or patch details when needed, and returns a typed interactive request or nothing if the request does not need UI treatment.

**Call relations**: App::enqueue_thread_request uses this for inactive threads, and App::surface_pending_inactive_thread_interactive_requests uses it when replaying stored pending requests. It calls App::thread_label, App::thread_cwd, and App::thread_file_change_changes to make prompts understandable.

*Call graph*: calls 5 internal fn (thread_cwd, thread_file_change_changes, thread_label, from_url_app_server_request, from_app_server_request); called by 2 (enqueue_thread_request, surface_pending_inactive_thread_interactive_requests); 3 external calls (AppLink, Approval, McpServerElicitation).


##### `App::push_thread_interactive_request`  (lines 332–346)

```
fn push_thread_interactive_request(&mut self, request: ThreadInteractiveRequest)
```

**Purpose**: Places an interactive request into the chat UI. Depending on the request type, it opens an app-link view, shows an approval card, or shows a form-style elicitation request.

**Data flow**: It receives a prepared interactive request. It may add a patch preview first, then sends the request to the appropriate chat widget method.

**Call relations**: App::enqueue_thread_request and App::surface_pending_inactive_thread_interactive_requests call this after converting server requests into user-facing prompts. It delegates patch-preview display to App::render_inactive_patch_preview.

*Call graph*: calls 1 internal fn (render_inactive_patch_preview); called by 2 (enqueue_thread_request, surface_pending_inactive_thread_interactive_requests).


##### `App::render_inactive_patch_preview`  (lines 348–363)

```
fn render_inactive_patch_preview(&mut self, request: &ApprovalRequest)
```

**Purpose**: Adds a patch preview to chat history for an inactive thread’s file-change approval. This gives the user visible context before deciding on the approval.

**Data flow**: It receives an approval request and only continues if it is an apply-patch approval with a thread label and non-empty changes. It creates a patch history cell and appends it to the chat history.

**Call relations**: App::push_thread_interactive_request calls this before pushing approval requests, so inactive-thread patch approvals are not shown as context-free prompts.

*Call graph*: called by 1 (push_thread_interactive_request); 1 external calls (new_patch_event).


##### `App::pending_inactive_thread_requests`  (lines 365–387)

```
async fn pending_inactive_thread_requests(&self) -> Vec<(ThreadId, ServerRequest)>
```

**Purpose**: Collects pending server requests from threads that are not currently active. This lets the app surface important approvals even when the user is viewing another thread.

**Data flow**: It copies thread ids and shared store handles, skips the active thread, locks each remaining store, extracts requests that are pending for replay, and returns them paired with their thread ids.

**Call relations**: App::surface_pending_inactive_thread_interactive_requests calls this first, then converts each raw request into UI prompts.

*Call graph*: called by 1 (surface_pending_inactive_thread_interactive_requests); 1 external calls (new).


##### `App::surface_pending_inactive_thread_interactive_requests`  (lines 389–406)

```
async fn surface_pending_inactive_thread_interactive_requests(
        &mut self,
    ) -> Result<()>
```

**Purpose**: Shows pending interactive requests from inactive threads, unless the UI is already focused on a side-parent flow. This keeps important approvals from being hidden in background threads.

**Data flow**: It checks whether a side-parent thread is active, then gathers pending inactive requests. For each one, it converts the raw server request into an interactive UI request and pushes it into the chat if applicable.

**Call relations**: It ties together App::pending_inactive_thread_requests, App::interactive_request_for_thread_request, and App::push_thread_interactive_request.

*Call graph*: calls 3 internal fn (interactive_request_for_thread_request, pending_inactive_thread_requests, push_thread_interactive_request).


##### `App::submit_active_thread_op`  (lines 408–420)

```
async fn submit_active_thread_op(
        &mut self,
        app_server: &mut AppServerSession,
        op: AppCommand,
    ) -> Result<()>
```

**Purpose**: Submits a user operation for the currently active thread. If no thread is active, it reports that problem in the chat instead of sending a command to nowhere.

**Data flow**: It receives the app server and command, reads the active thread id, and either shows an error or forwards the command and thread id to App::submit_thread_op.

**Call relations**: This is the active-thread entry point for command submission. App::submit_thread_op does the detailed routing work.

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

**Purpose**: Routes a user command for a specific thread. It first tries to use the command as an answer to a pending server request, then tries to send it as a real app-server operation.

**Data flow**: It logs the outgoing command, checks whether it resolves a pending request, then checks whether the app server supports this command. On success it updates thread replay bookkeeping and status indicators when needed; on failure it adds an error message to the chat.

**Call relations**: App::submit_active_thread_op calls this for the visible thread. It coordinates App::try_resolve_app_server_request, App::try_submit_active_thread_op_via_app_server, App::note_thread_outbound_op, App::refresh_pending_thread_approvals, and App::refresh_side_parent_status_from_store.

*Call graph*: calls 7 internal fn (op_can_change_pending_replay_state, note_thread_outbound_op, refresh_pending_thread_approvals, refresh_side_parent_status_from_store, try_resolve_app_server_request, try_submit_active_thread_op_via_app_server, log_outbound_op); called by 1 (submit_active_thread_op); 1 external calls (format!).


##### `App::append_message_history_entry`  (lines 455–471)

```
fn append_message_history_entry(&self, thread_id: ThreadId, text: String)
```

**Purpose**: Saves a submitted prompt into the local message history. This makes it available across sessions for later recall.

**Data flow**: It receives a thread id and text, builds history configuration from the chat widget config, then spawns a background task to append the entry. If writing fails, the background task logs a warning.

**Call relations**: This runs independently of the main UI path so disk history writing does not block the TUI.

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

**Purpose**: Looks up one local message-history entry for a thread. This supports history navigation, such as asking for an older prompt by offset.

**Data flow**: It receives a thread id, offset, and log id, builds history configuration, and spawns work that performs the lookup off the main async task. It sends the found text, or no entry, back through the app event channel.

**Call relations**: The result re-enters the normal event system as AppEvent::ThreadHistoryEntryResponse, which can later be enqueued to the relevant thread.

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

**Purpose**: Sends supported thread commands to the app server. It knows how to interrupt, steer or start turns, list skills, compact, rename, roll back, start reviews, clean terminals, run shell commands, reload config, change turn context, and approve guarded actions.

**Data flow**: It receives a thread id and command, matches the command type, gathers any needed local state such as active turn id, permissions, or config, calls the matching app-server method, updates local stores for cases like review or rollback, and returns true if the command was handled.

**Call relations**: App::submit_thread_op calls this after checking pending request resolution. It uses helpers such as App::active_turn_id_for_thread, App::ensure_thread_channel, App::handle_skills_list_result, and App::handle_thread_rollback_response as needed for individual command types.

*Call graph*: calls 18 internal fn (from_string, active_turn_id_for_thread, ensure_thread_channel, handle_skills_list_result, handle_thread_rollback_response, reload_user_config, review_start, skills_list, startup_interrupt, thread_approve_guardian_denied_action (+8 more)); called by 1 (submit_thread_op); 3 external calls (clone, turn_permissions_override_from_config, unreachable!).


##### `App::turn_permissions_override_from_config`  (lines 737–763)

```
fn turn_permissions_override_from_config(
        config: &Config,
        active_permission_profile: Option<&ActivePermissionProfile>,
        runtime_permission_profile_override: Option<&PermissionP
```

**Purpose**: Decides what permission information to send when starting a new turn. This protects server-side permission snapshots while still honoring explicit local overrides.

**Data flow**: It receives the app config, an optional active permission profile, and an optional runtime override. If an active profile exists, it returns that. If a runtime override matches the effective local profile after workspace-root expansion, it sends the legacy sandbox profile. Otherwise it asks the server to preserve its current permission state.

**Call relations**: App::try_submit_active_thread_op_via_app_server uses this while starting a user turn. The tests in this file focus on this decision logic.

*Call graph*: 2 external calls (ActiveProfile, LegacySandbox).


##### `App::handle_skills_list_result`  (lines 765–778)

```
fn handle_skills_list_result(
        &mut self,
        result: Result<SkillsListResponse>,
        failure_message: &str,
    )
```

**Purpose**: Processes the result of asking the app server for available skills. It either forwards the successful response or reports the failure to the user.

**Data flow**: It receives a result and failure-message prefix. On success, it calls App::handle_skills_list_response. On error, it logs a warning and adds an error message to the chat widget.

**Call relations**: App::try_submit_active_thread_op_via_app_server calls this after the skills-list server request completes.

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

**Purpose**: Checks whether a user command is actually an answer to a pending app-server request, such as an approval decision. If so, it sends that answer back to the server.

**Data flow**: It receives the app server, thread id, and command. It asks the pending-request tracker whether the command resolves anything. If yes, it sends the resolution to the server, updates replay and status bookkeeping on success, and shows an error message if the server rejects it.

**Call relations**: App::submit_thread_op calls this before trying to submit the command as a new thread operation. It uses App::note_thread_outbound_op, App::refresh_pending_thread_approvals, and App::refresh_side_parent_status_from_store after successful resolution.

*Call graph*: calls 5 internal fn (op_can_change_pending_replay_state, note_thread_outbound_op, refresh_pending_thread_approvals, refresh_side_parent_status_from_store, resolve_server_request); called by 1 (submit_thread_op); 1 external calls (format!).


##### `App::refresh_pending_thread_approvals`  (lines 815–844)

```
async fn refresh_pending_thread_approvals(&mut self)
```

**Purpose**: Updates the UI list of background threads that have pending approvals. This gives the user a visible signal that another thread needs attention.

**Data flow**: It gathers thread stores, skips the active thread and active side-parent thread, checks each store for pending approvals, sorts the thread ids, converts them to display labels, and sends that list to the chat widget.

**Call relations**: This is called after thread activation, clearing, new requests or notifications, command submission, and request resolution so the footer or status area stays current.

*Call graph*: called by 6 (activate_thread_channel, clear_active_thread, enqueue_thread_notification, enqueue_thread_request, submit_thread_op, try_resolve_app_server_request); 1 external calls (new).


##### `App::refresh_side_parent_status_from_store`  (lines 846–859)

```
async fn refresh_side_parent_status_from_store(&mut self, thread_id: ThreadId)
```

**Purpose**: Refreshes the side-parent status indicator from a thread’s stored state. A side-parent status tells the UI whether a related background thread is waiting, working, or needs action.

**Data flow**: It receives a thread id, locks that thread’s store, asks for its side-parent pending status, and either sets or clears the side-parent status in the app.

**Call relations**: App::submit_thread_op and App::try_resolve_app_server_request call this after outbound operations that may change what a side thread is waiting for.

*Call graph*: called by 2 (submit_thread_op, try_resolve_app_server_request).


##### `App::enqueue_thread_notification`  (lines 861–919)

```
async fn enqueue_thread_notification(
        &mut self,
        thread_id: ThreadId,
        notification: ServerNotification,
    ) -> Result<()>
```

**Purpose**: Routes a server notification into the correct thread’s buffer and, if that thread is active, into its live event channel. Notifications are backend updates such as turn started, token usage changed, settings changed, or thread closed.

**Data flow**: It receives a thread id and notification. It may ignore irrelevant settings updates, applies settings to cached session state, infers session state from thread-start notifications, ensures a channel exists, stores the notification, sends it live if the thread is active, updates side-parent status, and refreshes pending-approval indicators.

**Call relations**: App::enqueue_primary_thread_notification and App::enqueue_primary_thread_session call this for primary-thread events. It uses App::ensure_thread_channel, App::infer_session_for_thread_notification, and App::refresh_pending_thread_approvals.

*Call graph*: calls 4 internal fn (for_notification, ensure_thread_channel, infer_session_for_thread_notification, refresh_pending_thread_approvals); called by 2 (enqueue_primary_thread_notification, enqueue_primary_thread_session); 6 external calls (clone, clone, matches!, spawn, warn!, Notification).


##### `App::cache_collab_receiver_threads_for_notification`  (lines 927–965)

```
fn cache_collab_receiver_threads_for_notification(
        &mut self,
        notification: &ServerNotification,
    )
```

**Purpose**: Locally remembers agent threads mentioned by collaboration notifications. This lets the picker and footer show those threads quickly without waiting for extra server reads.

**Data flow**: It receives a notification, first checks for a displayable sub-agent activity item and records it if present. Otherwise it extracts receiver thread ids, skips missing or invalid ones, and creates placeholder agent-picker entries for new valid threads.

**Call relations**: App::handle_thread_event_now calls this before rendering live notifications, so navigation metadata is updated as collaboration events arrive. It calls App::sync_active_agent_label when activity changes the visible label.

*Call graph*: calls 2 internal fn (from_string, sync_active_agent_label); called by 1 (handle_thread_event_now); 1 external calls (warn!).


##### `App::infer_session_for_thread_notification`  (lines 967–998)

```
async fn infer_session_for_thread_notification(
        &mut self,
        thread_id: ThreadId,
        notification: &ServerNotification,
    ) -> Option<ThreadSessionState>
```

**Purpose**: Builds session state from a thread-started notification when the app has enough primary-session information to clone from. This fills in metadata for newly discovered agent or review threads.

**Data flow**: It receives a thread id and notification, returns nothing unless the notification says a thread started, clones the primary session configuration, replaces thread-specific fields such as id, name, provider, working directory, model, and rollout path, updates the agent picker, and returns the new session state.

**Call relations**: App::enqueue_thread_notification calls this before storing notifications so a thread’s store can gain session context as soon as the server announces the thread.

*Call graph*: calls 1 internal fn (read_session_model); called by 1 (enqueue_thread_notification).


##### `App::enqueue_thread_request`  (lines 1000–1047)

```
async fn enqueue_thread_request(
        &mut self,
        thread_id: ThreadId,
        request: ServerRequest,
    ) -> Result<()>
```

**Purpose**: Routes a server request into the correct thread’s buffer and optionally shows it immediately. Requests are things that expect a user answer, such as approvals.

**Data flow**: It receives a thread id and request. If the thread is inactive, it tries to build a user-facing interactive request first. It then stores the raw request, sends it live if the thread is active, otherwise may push the interactive prompt into the current UI, updates side-parent status, and refreshes pending approvals.

**Call relations**: App::enqueue_primary_thread_request and App::enqueue_primary_thread_session call this for primary-thread requests. It relies on App::interactive_request_for_thread_request, App::push_thread_interactive_request, App::ensure_thread_channel, and App::refresh_pending_thread_approvals.

*Call graph*: calls 5 internal fn (for_request, ensure_thread_channel, interactive_request_for_thread_request, push_thread_interactive_request, refresh_pending_thread_approvals); called by 2 (enqueue_primary_thread_request, enqueue_primary_thread_session); 5 external calls (clone, clone, spawn, warn!, Request).


##### `App::enqueue_thread_history_entry_response`  (lines 1049–1091)

```
async fn enqueue_thread_history_entry_response(
        &mut self,
        thread_id: ThreadId,
        event: HistoryLookupResponse,
    ) -> Result<()>
```

**Purpose**: Routes a message-history lookup result into a thread’s buffer and live channel if active. This keeps history navigation responses tied to the thread that requested them.

**Data flow**: It receives a thread id and history response, ensures the thread channel exists, appends the response to the store buffer, evicts old buffered events if over capacity, records any evicted pending request, and sends the response live if the thread is active.

**Call relations**: App::enqueue_primary_thread_session calls this when replaying pending primary events that arrived before the primary thread was fully set up.

*Call graph*: calls 1 internal fn (ensure_thread_channel); called by 1 (enqueue_primary_thread_session); 5 external calls (clone, spawn, warn!, HistoryEntryResponse, clone).


##### `App::enqueue_primary_thread_session`  (lines 1093–1148)

```
async fn enqueue_primary_thread_session(
        &mut self,
        session: ThreadSessionState,
        turns: Vec<Turn>,
    ) -> Result<()>
```

**Purpose**: Installs the primary thread session and replays its saved turns into the UI. This is the point where the main conversation becomes known and visible.

**Data flow**: It receives session state and past turns, records the primary thread id and configured session, updates the agent picker, stores the session and turns, activates the thread channel, suppresses premature initial-message sending, renders the session and turn history, drains pending primary events into the normal per-thread routes, then re-enables initial-message submission.

**Call relations**: This function calls App::ensure_thread_channel, App::activate_thread_channel, App::enqueue_thread_notification, App::enqueue_thread_request, and App::enqueue_thread_history_entry_response to move from startup buffering into normal thread routing.

*Call graph*: calls 5 internal fn (activate_thread_channel, enqueue_thread_history_entry_response, enqueue_thread_notification, enqueue_thread_request, ensure_thread_channel); 2 external calls (take, clone).


##### `App::enqueue_primary_thread_notification`  (lines 1150–1162)

```
async fn enqueue_primary_thread_notification(
        &mut self,
        notification: ServerNotification,
    ) -> Result<()>
```

**Purpose**: Accepts a notification for the primary thread even before the primary thread id is known. This prevents early backend notifications from being lost during startup.

**Data flow**: It receives a notification. If the primary thread id exists, it routes the notification normally; otherwise it stores it in a pending primary-events queue.

**Call relations**: Once App::enqueue_primary_thread_session establishes the primary thread, it drains these pending events through App::enqueue_thread_notification.

*Call graph*: calls 1 internal fn (enqueue_thread_notification); 1 external calls (Notification).


##### `App::enqueue_primary_thread_request`  (lines 1164–1174)

```
async fn enqueue_primary_thread_request(
        &mut self,
        request: ServerRequest,
    ) -> Result<()>
```

**Purpose**: Accepts a request for the primary thread even before the primary thread id is known. This preserves early approvals or prompts that arrive during startup.

**Data flow**: It receives a request. If the primary thread id exists, it routes the request normally; otherwise it stores it in the pending primary-events queue.

**Call relations**: App::enqueue_primary_thread_session later drains the queued request through App::enqueue_thread_request.

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

**Purpose**: Refreshes incomplete thread session details before replaying a snapshot. This helps avoid showing stale or missing model and rollout information after switching threads.

**Data flow**: It receives the app server, thread id, a replay-only flag, and a mutable snapshot. If App::should_refresh_snapshot_session says refresh is needed, it asks the server to resume the thread and applies the fresh session and turns to the snapshot; failures are logged but do not stop the UI.

**Call relations**: It coordinates App::should_refresh_snapshot_session, the server resume call, and App::apply_refreshed_snapshot_thread before the snapshot is replayed elsewhere.

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

**Purpose**: Decides whether a thread snapshot’s session data is too incomplete to replay as-is. It avoids unnecessary server calls for replay-only work or side threads.

**Data flow**: It receives a thread id, replay-only flag, and snapshot. It returns true only when this is not replay-only, the thread is not a side thread, and the snapshot has no session or lacks important fields such as model or rollout path.

**Call relations**: App::refresh_snapshot_session_if_needed calls this before contacting the app server.

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

**Purpose**: Applies freshly fetched session and turn data to both the stored thread channel and the snapshot about to be replayed.

**Data flow**: It receives a thread id, server-started-thread data, and a mutable snapshot. It updates the thread store if present, rebases the buffered events after the session refresh, writes the fresh session and turns into the snapshot, and removes snapshot events that should not survive the refresh.

**Call relations**: App::refresh_snapshot_session_if_needed calls this after a successful server resume.

*Call graph*: called by 1 (refresh_snapshot_session_if_needed).


##### `App::drain_active_thread_events`  (lines 1243–1270)

```
async fn drain_active_thread_events(&mut self, tui: &mut tui::Tui) -> Result<()>
```

**Purpose**: Pulls all currently available live events from the active thread receiver and renders them immediately. This is part of the TUI’s main event loop.

**Data flow**: It takes the active receiver if present, repeatedly reads events without waiting, sends each to App::handle_thread_event_now, restores the receiver if still connected, or clears the active thread if disconnected. It also schedules a redraw when backtrack rendering is pending.

**Call relations**: This is the fast path for normal live event handling. It calls App::handle_thread_event_now for each event and App::clear_active_thread if the channel has closed.

*Call graph*: calls 2 internal fn (clear_active_thread, handle_thread_event_now); 1 external calls (frame_requester).


##### `App::active_non_primary_shutdown_target`  (lines 1283–1296)

```
fn active_non_primary_shutdown_target(
        &self,
        notification: &ServerNotification,
    ) -> Option<(ThreadId, ThreadId)>
```

**Purpose**: Detects when the currently active non-primary thread has closed unexpectedly and the app should try to switch back to the primary thread.

**Data flow**: It receives a notification and checks that it is a thread-closed notification, that there is an active and primary thread, that the active thread is not the one intentionally shutting down for exit, and that active differs from primary. It returns the closed active id and primary id when failover is needed.

**Call relations**: App::handle_active_thread_event calls this before normal event handling so unexpected agent-thread deaths can trigger failover instead of simply rendering a close event.

*Call graph*: called by 1 (handle_active_thread_event); 1 external calls (matches!).


##### `App::replay_thread_snapshot`  (lines 1298–1347)

```
fn replay_thread_snapshot(
        &mut self,
        snapshot: ThreadEventSnapshot,
        resume_restored_queue: bool,
    )
```

**Purpose**: Rebuilds the chat screen from a stored thread snapshot when the user switches threads. It restores session info, input text, past turns, and buffered events.

**Data flow**: It receives a snapshot and a flag saying whether to resume the restored input queue. It may mark replay buffering, restores session and input state, replays turns, replays buffered events while optionally hiding duplicate notices, ends buffering, re-enables queued input behavior, optionally sends the next queued input, and refreshes the status line.

**Call relations**: Thread-switching code prepares snapshots with functions such as App::activate_thread_for_replay, and this function renders them by calling App::handle_thread_event_replay for each stored event.

*Call graph*: calls 3 internal fn (event_is_notice, snapshot_has_pending_interactive_request, handle_thread_event_replay).


##### `App::should_wait_for_initial_session`  (lines 1349–1354)

```
fn should_wait_for_initial_session(session_selection: &SessionSelection) -> bool
```

**Purpose**: Decides whether startup should wait for the initial session to be configured. Fresh starts and exits need that wait state; resumed sessions do not follow the same path.

**Data flow**: It receives the session selection and returns true for start-fresh or exit selections, false otherwise.

**Call relations**: Startup orchestration code can use this small decision helper to control when active thread events are allowed to be processed.

*Call graph*: 1 external calls (matches!).


##### `App::should_prompt_for_paused_goal_after_startup_resume`  (lines 1356–1364)

```
fn should_prompt_for_paused_goal_after_startup_resume(
        session_selection: &SessionSelection,
        initial_prompt: &Option<String>,
        initial_images: &[PathBuf],
    ) -> bool
```

**Purpose**: Decides whether to ask the user about a paused goal after resuming a session. It only does so when there is no new prompt text or image input already supplied.

**Data flow**: It receives the session selection, optional initial prompt, and initial image paths. It returns true only for resume selections with no prompt and no images.

**Call relations**: Startup resume flow can call this to avoid prompting when the user already provided new input.

*Call graph*: 2 external calls (is_empty, matches!).


##### `App::should_handle_active_thread_events`  (lines 1366–1371)

```
fn should_handle_active_thread_events(
        waiting_for_initial_session_configured: bool,
        has_active_thread_receiver: bool,
    ) -> bool
```

**Purpose**: Decides whether live active-thread events should be processed right now. It prevents event handling while startup is still waiting for the initial session setup.

**Data flow**: It receives whether startup is waiting and whether an active receiver exists. It returns true only when a receiver exists and startup is not waiting.

**Call relations**: The main loop can use this as a clear gate before draining or handling active-thread events.


##### `App::should_stop_waiting_for_initial_session`  (lines 1373–1378)

```
fn should_stop_waiting_for_initial_session(
        waiting_for_initial_session_configured: bool,
        primary_thread_id: Option<ThreadId>,
    ) -> bool
```

**Purpose**: Decides when startup can stop waiting for initial session configuration. Once the primary thread id exists, the initial session is considered available.

**Data flow**: It receives the current waiting flag and optional primary thread id. It returns true only if the app was waiting and a primary thread id has now been set.

**Call relations**: Startup orchestration code can use this alongside App::should_handle_active_thread_events to move from startup mode into normal event handling.


##### `App::handle_skills_list_response`  (lines 1381–1387)

```
fn handle_skills_list_response(&mut self, response: SkillsListResponse)
```

**Purpose**: Applies a successful skills-list response to the UI and emits any newly active skill-load warnings. Skills are reusable capabilities loaded from the current workspace.

**Data flow**: It receives the skills response, reads the current working directory from config, extracts errors relevant to that directory, filters to newly active warnings, emits warning events, and passes the response to the chat widget.

**Call relations**: App::handle_skills_list_result calls this on successful server responses.

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

**Purpose**: Updates local state after the app server rolls a thread back by one or more turns. Rollback removes recent conversation work and must also clear stale live events.

**Data flow**: It receives the thread id, number of turns, and rollback response. It applies the rollback to the thread store, drains and discards any queued live events for that active thread, clears the active thread if the receiver disconnected, and marks the backtrack operation as succeeded.

**Call relations**: App::try_submit_active_thread_op_via_app_server calls this after a successful rollback command. It may call App::clear_active_thread if the active receiver is gone.

*Call graph*: calls 1 internal fn (clear_active_thread); called by 1 (try_submit_active_thread_op_via_app_server).


##### `App::handle_thread_event_now`  (lines 1423–1454)

```
fn handle_thread_event_now(&mut self, event: ThreadBufferedEvent)
```

**Purpose**: Renders one live event from the active thread immediately. This is used for events arriving while the user is watching that thread.

**Data flow**: It receives a buffered event. Notifications update collaboration cache and go to the chat widget, requests are shown if still pending, history responses update history navigation, and feedback events go to feedback handling. Some notifications also trigger a status-line refresh.

**Call relations**: App::drain_active_thread_events and App::handle_active_thread_event call this for live handling. It calls App::cache_collab_receiver_threads_for_notification before rendering notifications.

*Call graph*: calls 1 internal fn (cache_collab_receiver_threads_for_notification); called by 2 (drain_active_thread_events, handle_active_thread_event); 1 external calls (matches!).


##### `App::handle_thread_event_replay`  (lines 1456–1471)

```
fn handle_thread_event_replay(&mut self, event: ThreadBufferedEvent)
```

**Purpose**: Renders one stored event while replaying a thread snapshot. It tells the chat widget that these events are historical replay, not brand-new live events.

**Data flow**: It receives a buffered event and forwards it to the appropriate chat widget or feedback handler, tagging server notifications and requests with thread-snapshot replay context.

**Call relations**: App::replay_thread_snapshot calls this for each buffered event that survives replay filtering.

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

**Purpose**: Handles one event from the active thread with extra shutdown safety. It distinguishes user-requested exits from unexpected agent-thread deaths.

**Data flow**: It receives the TUI, app server, and event. It checks whether a tracked shutdown has completed, detects unexpected non-primary thread closure and tries to switch back to the primary thread, clears the shutdown marker when appropriate, otherwise renders the event normally, and schedules a redraw if needed.

**Call relations**: This is the safer active-event path when individual events are processed with access to the TUI and app server. It calls App::active_non_primary_shutdown_target, may call App::clear_active_thread, and otherwise delegates rendering to App::handle_thread_event_now.

*Call graph*: calls 3 internal fn (active_non_primary_shutdown_target, clear_active_thread, handle_thread_event_now); 3 external calls (frame_requester, format!, matches!).


##### `tests::config_with_workspace_profile`  (lines 1548–1559)

```
async fn config_with_workspace_profile() -> Config
```

**Purpose**: Builds a test configuration that uses the built-in workspace permission profile. This gives the permission tests a realistic config without touching a real user home directory.

**Data flow**: It creates a temporary directory, sets it as the Codex home, applies a default workspace permission override, builds the config asynchronously, and returns it.

**Call relations**: The three permission tests call this helper before checking App::turn_permissions_override_from_config.

*Call graph*: 3 external calls (default, default, tempdir).


##### `tests::turn_permissions_use_active_profile_when_available`  (lines 1562–1576)

```
async fn turn_permissions_use_active_profile_when_available()
```

**Purpose**: Checks that an active permission profile wins when starting a turn. This confirms the app sends the explicitly active profile rather than falling back to older behavior.

**Data flow**: It builds the workspace-profile config, extracts the active permission profile, calls App::turn_permissions_override_from_config, and asserts that the result is an active-profile override.

**Call relations**: This test covers the first branch of App::turn_permissions_override_from_config.

*Call graph*: 2 external calls (assert_eq!, config_with_workspace_profile).


##### `tests::turn_permissions_preserve_server_snapshot_without_local_override`  (lines 1579–1593)

```
async fn turn_permissions_preserve_server_snapshot_without_local_override()
```

**Purpose**: Checks that the app preserves the server’s permission snapshot when there is no local runtime override. This prevents the TUI from accidentally overwriting server-side permission state.

**Data flow**: It builds a config, changes its permission profile to read-only, calls App::turn_permissions_override_from_config with no active profile and no runtime override, and asserts that the result is preserve.

**Call relations**: This test covers the safe default branch of App::turn_permissions_override_from_config.

*Call graph*: calls 1 internal fn (read_only); 2 external calls (assert_eq!, config_with_workspace_profile).


##### `tests::turn_permissions_send_legacy_sandbox_for_local_override`  (lines 1596–1613)

```
async fn turn_permissions_send_legacy_sandbox_for_local_override()
```

**Purpose**: Checks that an explicit local runtime permission override is sent using the legacy sandbox form. This keeps older server behavior working when the user has changed permissions locally.

**Data flow**: It builds a config, sets a workspace-write permission profile, computes the effective profile, calls App::turn_permissions_override_from_config with that runtime override, and asserts that the legacy sandbox override is returned.

**Call relations**: This test covers the local-override branch of App::turn_permissions_override_from_config.

*Call graph*: calls 1 internal fn (workspace_write); 2 external calls (assert_eq!, config_with_workspace_profile).


### Background side effects
This file offloads network and disk-heavy work into spawned tasks and returns their outcomes back through app events.

### `tui/src/app/background_requests.rs`

`orchestration` · `cross-cutting background request handling`

The terminal UI needs many things from the app server: plugin lists, skill metadata, MCP server inventory, account usage, rate limits, connector lists, marketplace changes, hook settings, and feedback uploads. Any of these can take time. If the app waited directly, typing and rendering could stall. This file is the app's "runner in the background": it clones a request handle, starts an async task, waits for the server response, turns errors into user-friendly text, and sends an `AppEvent` back to the main event loop.

Most functions follow the same pattern. An `App` method gathers context from the current screen, such as the current working directory or thread id. It then spawns a task with `tokio::spawn` (start this work separately). A helper function builds the actual typed app-server request. When the answer arrives, the task sends one event back. The UI then handles that event on its normal single-threaded path, which avoids two tasks changing screen state at once.

The file also includes small policy decisions: timeouts for account data, hiding plugin marketplaces meant only for the command-line flow, adding next-step advice to remote plugin errors, queueing rapid enable/disable writes so only the latest choice matters, and routing feedback results back to the thread where feedback was submitted.

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

**Purpose**: Starts a background load of MCP server inventory, which is the list of external tool servers and what tools or resources they provide. It keeps the UI responsive while the inventory is fetched.

**Data flow**: It receives the app-server session, the amount of detail wanted, and an optional thread id. It chooses whether that thread id should be included, starts a background task, fetches all pages of MCP status data, converts any error to text, and sends an `McpInventoryLoaded` event back to the app.

**Call relations**: This is the App-level launcher. Before calling `fetch_all_mcp_server_statuses`, it asks `App::mcp_inventory_request_thread_id` whether the request should be tied to the current thread, then the spawned task reports back through the app event channel.

*Call graph*: calls 3 internal fn (mcp_inventory_request_thread_id, fetch_all_mcp_server_statuses, request_handle); 1 external calls (spawn).


##### `App::mcp_inventory_request_thread_id`  (lines 57–65)

```
fn mcp_inventory_request_thread_id(&self, thread_id: Option<ThreadId>) -> Option<ThreadId>
```

**Purpose**: Decides whether an MCP inventory request should include a thread id. It avoids asking the server for thread-specific MCP data when that thread is no longer active or has been closed.

**Data flow**: It takes an optional thread id and compares it with the app's active thread and agent navigation state. It returns the same id only if the thread is still the active, open one; otherwise it returns nothing.

**Call relations**: This is a guard used by `App::fetch_mcp_inventory` before the background request starts. Its job is to prevent stale thread context from leaking into the server request.

*Call graph*: called by 1 (fetch_mcp_inventory).


##### `App::refresh_rate_limits`  (lines 74–97)

```
fn refresh_rate_limits(
        &mut self,
        app_server: &AppServerSession,
        origin: RateLimitRefreshOrigin,
    )
```

**Purpose**: Starts a background refresh of the user's account rate limits. This lets startup, status commands, and reset-credit flows get fresh quota information without blocking the UI.

**Data flow**: It takes the app-server session and a reason for the refresh. It calls the account rate-limit helper in a spawned task, adds a timeout for reset-credit-related refreshes, turns errors into strings, and sends a `RateLimitsLoaded` event with the original reason attached.

**Call relations**: This method launches `fetch_account_rate_limits`. The completion event lets later UI code know whether the request came from startup, a `/status` command, or a reset-credit action.

*Call graph*: calls 2 internal fn (fetch_account_rate_limits, request_handle); 2 external calls (spawn, timeout).


##### `App::refresh_token_activity`  (lines 99–116)

```
fn refresh_token_activity(
        &mut self,
        app_server: &AppServerSession,
        request_id: u64,
    )
```

**Purpose**: Starts a background fetch of recent token usage for an account. Token usage can be slow to retrieve, so this protects the terminal from hanging.

**Data flow**: It receives a server session and request id, starts a timed background request, and sends either the token activity response or an error string in `TokenActivityLoaded`.

**Call relations**: This is the App wrapper around `fetch_account_token_activity`. The request id is carried back so the UI can match the answer to the card or command that asked for it.

*Call graph*: calls 2 internal fn (fetch_account_token_activity, request_handle); 2 external calls (spawn, timeout).


##### `App::refresh_rate_limit_reset_credits`  (lines 118–135)

```
fn refresh_rate_limit_reset_credits(
        &mut self,
        app_server: &AppServerSession,
        request_id: u64,
    )
```

**Purpose**: Loads the account's available rate-limit reset credits in the background. These credits are used to reset a quota limit when allowed.

**Data flow**: It takes a request id and app-server session, runs a timed request for reset-credit summary data, converts timeout or server errors to text, and sends `RateLimitResetCreditsLoaded`.

**Call relations**: This method launches `fetch_rate_limit_reset_credits`. The result flows back through the event queue rather than updating UI state directly.

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

**Purpose**: Starts the server request that spends one rate-limit reset credit. The idempotency key helps the server avoid double-spending if the same operation is retried.

**Data flow**: It receives a request id and idempotency key, sends the consume request in a timed background task, and returns the original key plus the server result in a `RateLimitResetCreditConsumed` event.

**Call relations**: This is the App-level launcher for `consume_rate_limit_reset_credit_request`. The event handler can later use the idempotency key to connect the server answer to the user's attempted action.

*Call graph*: calls 2 internal fn (consume_rate_limit_reset_credit_request, request_handle); 2 external calls (spawn, timeout).


##### `App::send_add_credits_nudge_email`  (lines 161–174)

```
fn send_add_credits_nudge_email(
        &mut self,
        app_server: &AppServerSession,
        credit_type: AddCreditsNudgeCreditType,
    )
```

**Purpose**: Asks the server to send an email nudging the user to add more credits. It runs in the background because sending email depends on the server.

**Data flow**: It receives the credit type, sends a request through the app server, converts any failure to text, and posts `AddCreditsNudgeEmailFinished` when done.

**Call relations**: This App method calls the free helper `send_add_credits_nudge_email` inside a spawned task. The helper does the server call; this method connects it to the app event loop.

*Call graph*: calls 2 internal fn (send_add_credits_nudge_email, request_handle); 1 external calls (spawn).


##### `App::refresh_startup_skills`  (lines 183–193)

```
fn refresh_startup_skills(&mut self, app_server: &AppServerSession)
```

**Purpose**: Loads skill metadata during startup without delaying the first visible screen. Skills can later be used for mentions and the skills UI.

**Data flow**: It reads the current working directory from config, starts a background skills-list request, formats any rich error into text, and sends `SkillsListLoaded`.

**Call relations**: This startup path calls `fetch_skills_list`. Unlike user-requested refreshes, it is intentionally fire-and-forget so the first frame can render quickly.

*Call graph*: calls 2 internal fn (fetch_skills_list, request_handle); 1 external calls (spawn).


##### `App::fetch_connectors_list`  (lines 195–214)

```
fn fetch_connectors_list(
        &mut self,
        app_server: &AppServerSession,
        force_refetch: bool,
    )
```

**Purpose**: Fetches the list of connected apps or connectors from the server. It can force a fresh fetch and can include the currently displayed thread for context.

**Data flow**: It reads the current displayed thread id, starts a background apps-list request, wraps the server data into a connectors snapshot, and sends `ConnectorsLoaded` marked as final.

**Call relations**: This App launcher calls the free `fetch_connectors_list` helper. The helper talks to the server; this method preserves UI context and sends the answer back as an event.

*Call graph*: calls 2 internal fn (fetch_connectors_list, request_handle); 1 external calls (spawn).


##### `App::fetch_plugins_list`  (lines 216–246)

```
fn fetch_plugins_list(&mut self, app_server: &AppServerSession, cwd: PathBuf)
```

**Purpose**: Loads the plugin menu data for a working directory, then optionally loads extra remote plugin sections. It also tells the chat widget immediately that plugin loading has started.

**Data flow**: It receives a directory, records that plugin loading began, reads feature flags for plugin sharing and remote plugins, fetches the main plugin list, sends `PluginsLoaded`, and if that succeeded fetches extra remote sections and sends `PluginRemoteSectionsLoaded`.

**Call relations**: This method first calls the free `fetch_plugins_list`. On success, it continues with `fetch_additional_plugin_remote_sections`, so the UI can show local plugin data quickly and remote sections when ready.

*Call graph*: calls 3 internal fn (fetch_additional_plugin_remote_sections, fetch_plugins_list, request_handle); 2 external calls (clone, spawn).


##### `App::fetch_hooks_list`  (lines 248–257)

```
fn fetch_hooks_list(&mut self, app_server: &AppServerSession, cwd: PathBuf)
```

**Purpose**: Loads configured hooks for a working directory in the background. Hooks are user or workspace actions that can run around Codex activity.

**Data flow**: It receives a directory, clones it for the eventual event, calls the hooks RPC helper, converts errors to strings, and sends `HooksLoaded`.

**Call relations**: This method delegates the server request to `fetch_hooks_list` from the hooks RPC module. It exists here to connect that request to the app's background-event pattern.

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

**Purpose**: Fetches detailed information for one plugin. This is used when the user opens or inspects a plugin rather than just seeing it in a list.

**Data flow**: It takes the working directory and plugin read parameters, sends the read request in a background task, converts any error to text, and emits `PluginDetailLoaded`.

**Call relations**: This App method wraps the free `fetch_plugin_detail` helper. It keeps the directory alongside the result so the UI can ignore or place the result correctly.

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

**Purpose**: Adds a plugin marketplace, such as a local folder or remote source, without blocking the UI. A marketplace is a catalog where plugins can be found.

**Data flow**: It receives the current directory and source string, preserves copies for the event, asks the server to add the marketplace, formats failure as a clear message, and sends `MarketplaceAddLoaded`.

**Call relations**: This method calls the free `fetch_marketplace_add` helper. The helper prepares the server request; this method ties it to the current screen and app event flow.

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

**Purpose**: Removes a plugin marketplace in the background. It keeps both the internal name and display name so the UI can show a useful result.

**Data flow**: It receives the directory, marketplace name, and display name, sends the remove request, formats any failure, and emits `MarketplaceRemoveLoaded` with identifying details.

**Call relations**: This App launcher calls `fetch_marketplace_remove`. It carries user-facing names through the async boundary for later UI messages.

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

**Purpose**: Requests an upgrade of one marketplace or all marketplaces. This can update plugin catalogs without freezing the terminal.

**Data flow**: It takes the directory and optional marketplace name, runs the upgrade request in the background, formats errors, and sends `MarketplaceUpgradeLoaded`.

**Call relations**: This method delegates to the free `fetch_marketplace_upgrade` helper and posts the result back through the event channel.

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

**Purpose**: Installs a plugin from a local or remote marketplace. It runs asynchronously because installation may involve file or network work on the server side.

**Data flow**: It receives the directory, plugin location, plugin name, and display name. It sends an install request, preserves copies of identifying data, and emits `PluginInstallLoaded` with success or a formatted failure.

**Call relations**: This App method calls `fetch_plugin_install`. It keeps enough context for the UI to update the right plugin row and show the correct display name.

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

**Purpose**: Uninstalls a plugin in the background. It avoids blocking the interface while the server removes the plugin.

**Data flow**: It receives the directory, plugin id, and display name, sends an uninstall request, and emits `PluginUninstallLoaded` with either the response or an error message.

**Call relations**: This method wraps the free `fetch_plugin_uninstall` helper and routes the result back through the event loop.

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

**Purpose**: Records a user's request to enable or disable a plugin, while avoiding overlapping writes for the same plugin. If a write is already in progress, it remembers only the latest desired value.

**Data flow**: It checks the pending-write map for the plugin id. If a write is already active, it stores the new desired setting for later; otherwise it marks a write as active and starts `spawn_plugin_enabled_write`.

**Call relations**: This function is the queueing front door. It calls `App::spawn_plugin_enabled_write` only when no write for that plugin is currently running.

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

**Purpose**: Actually starts the background config write that enables or disables a plugin. It is separated from `set_plugin_enabled` so queued follow-up writes can reuse it.

**Data flow**: It takes the directory, plugin id, and desired enabled flag, sends a config write request, maps success to an empty result, formats errors, and sends `PluginEnabledSet`.

**Call relations**: This is called by `App::set_plugin_enabled`. It delegates the server write to `write_plugin_enabled` and reports completion through the app event channel.

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

**Purpose**: Records a user's request to enable or disable a hook while avoiding overlapping config writes for the same hook. Rapid toggles are collapsed to the latest choice.

**Data flow**: It checks whether a write for the hook key is already pending. If so, it stores the new desired value; if not, it marks the hook as pending and starts `spawn_hook_enabled_write`.

**Call relations**: This is the queueing layer for hook enablement. It calls `App::spawn_hook_enabled_write` only when the hook has no active write.

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

**Purpose**: Starts the background config write that enables or disables a hook. It reports formatted configuration errors that are easier for users to understand.

**Data flow**: It receives a hook key and enabled flag, sends a batch config write, converts success to an empty result, formats failures, and emits `HookEnabledSet`.

**Call relations**: This is called by `App::set_hook_enabled`. It uses `write_hook_enabled` for the app-server request and sends completion back as an app event.

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

**Purpose**: Marks one hook as trusted for its current content hash. This is a safety step so changed hook code is not silently accepted.

**Data flow**: It takes the hook key and current hash, asks the server to write that trust decision, formats config-related errors, and sends `HookTrusted`.

**Call relations**: This App method delegates to `write_hook_trust` from the hooks RPC module. It follows the same background-event pattern as other writes.

*Call graph*: calls 2 internal fn (request_handle, write_hook_trust); 1 external calls (spawn).


##### `App::trust_hooks`  (lines 493–507)

```
fn trust_hooks(
        &mut self,
        app_server: &AppServerSession,
        updates: Vec<HookTrustUpdate>,
    )
```

**Purpose**: Marks several hooks as trusted in one background request. This is useful when the user accepts multiple trust updates at once.

**Data flow**: It receives a list of trust updates, sends them through the hooks RPC helper, formats any configuration error, and emits `HookTrusted`.

**Call relations**: This method calls `write_hook_trusts` from the hooks RPC module and reports the single combined result through the app event queue.

*Call graph*: calls 2 internal fn (request_handle, write_hook_trusts); 1 external calls (spawn).


##### `App::refresh_plugin_mentions`  (lines 509–530)

```
fn refresh_plugin_mentions(&mut self, app_server: &AppServerSession)
```

**Purpose**: Refreshes the plugin names available for mention suggestions. If plugins are disabled, it immediately tells the UI there are no plugin mention candidates.

**Data flow**: It reads the current directory and plugin feature flag. If plugins are off, it sends `PluginMentionsLoaded` with no plugins; otherwise it fetches mention data in the background and sends it on success, logging a warning on failure.

**Call relations**: This method calls `fetch_plugin_mentions` only when the plugin feature is enabled. Unlike many other requests, failed mention refreshes are just logged because they should not interrupt the user.

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

**Purpose**: Uploads user feedback, optionally with logs, without blocking the chat UI. It remembers the thread where feedback was submitted so the result can appear in the right place.

**Data flow**: It gathers the current thread id and optional rollout log path, builds upload parameters, sends the feedback upload request in a background task, extracts the returned thread id on success, and emits `FeedbackSubmitted`.

**Call relations**: This method first uses `build_feedback_upload_params`, then calls `fetch_feedback_upload`. The later event is handled by `App::handle_feedback_submitted`.

*Call graph*: calls 3 internal fn (build_feedback_upload_params, fetch_feedback_upload, request_handle); 1 external calls (spawn).


##### `App::handle_feedback_thread_event`  (lines 570–587)

```
fn handle_feedback_thread_event(&mut self, event: FeedbackThreadEvent)
```

**Purpose**: Displays the result of a feedback upload in chat history. Success gets a friendly confirmation cell; failure gets an error cell.

**Data flow**: It receives a feedback event containing category, log choice, audience, and result. If successful, it appends a success message with the feedback thread id; otherwise it appends an error message.

**Call relations**: This is called by `App::handle_feedback_submitted` when the feedback result should be shown immediately in the current UI instead of being routed through a thread buffer.

*Call graph*: called by 1 (handle_feedback_submitted); 3 external calls (feedback_success_cell, format!, new_error_event).


##### `App::enqueue_thread_feedback_event`  (lines 589–630)

```
async fn enqueue_thread_feedback_event(
        &mut self,
        thread_id: ThreadId,
        event: FeedbackThreadEvent,
    )
```

**Purpose**: Stores a feedback result for a specific thread and sends it to that thread if the thread is active. This keeps feedback messages attached to the conversation where they belong.

**Data flow**: It finds or creates the thread channel, pushes the feedback event into that thread's buffer, evicts old buffered items if over capacity, and if the channel is active tries to send the event immediately or spawns a send if the channel is full.

**Call relations**: This is called by `App::handle_feedback_submitted` when feedback came from a known thread. It uses thread buffering so inactive or background threads still receive their feedback result later.

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

**Purpose**: Turns the completed feedback upload event into a thread-specific UI event. It decides whether to enqueue it for a thread or show it immediately.

**Data flow**: It receives the original thread id, feedback category, log flag, and upload result. It builds a `FeedbackThreadEvent` with the current audience setting, then either enqueues it for that thread or passes it directly to the display helper.

**Call relations**: This is the completion handler for the event sent by `App::submit_feedback`. It calls `App::enqueue_thread_feedback_event` for known threads and `App::handle_feedback_thread_event` when no thread id was available.

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

**Purpose**: Updates the chat after an MCP inventory request finishes. It removes loading indicators and shows either an error, an empty-state message, or the inventory listing.

**Data flow**: It receives the fetched statuses, requested detail level, and optional thread id. If the result belongs to another displayed thread, it ignores it; otherwise it clears loading cells, handles errors, handles an empty list, or appends the rendered MCP tools output.

**Call relations**: This is the UI-side counterpart to `App::fetch_mcp_inventory`. It calls `App::clear_committed_mcp_inventory_loading` before adding the final inventory output.

*Call graph*: calls 1 internal fn (clear_committed_mcp_inventory_loading); 3 external calls (format!, empty_mcp_output, new_mcp_tools_output_from_statuses).


##### `App::clear_committed_mcp_inventory_loading`  (lines 691–704)

```
fn clear_committed_mcp_inventory_loading(&mut self)
```

**Purpose**: Removes a committed MCP inventory loading cell from transcript history. This prevents the spinner-like loading entry from staying visible after the real result arrives.

**Data flow**: It searches the transcript cells from the end for an MCP inventory loading cell. If found, it removes that cell and refreshes the transcript overlay if one is open.

**Call relations**: This is called by `App::handle_mcp_inventory_result` as cleanup before the final MCP inventory message is shown.

*Call graph*: called by 1 (handle_mcp_inventory_result).


##### `fetch_all_mcp_server_statuses`  (lines 707–739)

```
async fn fetch_all_mcp_server_statuses(
    request_handle: AppServerRequestHandle,
    detail: McpServerStatusDetail,
    thread_id: Option<ThreadId>,
) -> Result<Vec<McpServerStatus>>
```

**Purpose**: Fetches every page of MCP server status data from the app server. It hides pagination from callers so they receive one complete list.

**Data flow**: It receives a request handle, detail level, and optional thread id. It repeatedly sends `McpServerStatusList` requests with a cursor, appends each page of data, and stops when the server provides no next cursor, returning the combined statuses.

**Call relations**: This helper is called by `App::fetch_mcp_inventory` inside a background task. It is the low-level server conversation behind the MCP inventory UI.

*Call graph*: calls 1 internal fn (request_typed); called by 1 (fetch_mcp_inventory); 3 external calls (new, String, format!).


##### `fetch_account_rate_limits`  (lines 741–752)

```
async fn fetch_account_rate_limits(
    request_handle: AppServerRequestHandle,
) -> Result<GetAccountRateLimitsResponse>
```

**Purpose**: Asks the app server for the account's current rate limits. The result includes quota information used by status and reset-credit flows.

**Data flow**: It receives a request handle, creates a unique request id, sends a typed account rate-limits request, and returns the server response or a wrapped error.

**Call relations**: This helper is called by `App::refresh_rate_limits`. The App method decides timeout behavior and event routing.

*Call graph*: calls 1 internal fn (request_typed); called by 1 (refresh_rate_limits); 2 external calls (String, format!).


##### `fetch_account_token_activity`  (lines 754–765)

```
async fn fetch_account_token_activity(
    request_handle: AppServerRequestHandle,
) -> Result<codex_app_server_protocol::GetAccountTokenUsageResponse>
```

**Purpose**: Asks the app server for account token usage activity. This supports UI views that explain recent usage.

**Data flow**: It takes a request handle, creates a unique request id, sends a token-usage request, and returns either the usage response or an error with context.

**Call relations**: This helper is launched by `App::refresh_token_activity`, which adds a timeout and sends the final event.

*Call graph*: calls 1 internal fn (request_typed); called by 1 (refresh_token_activity); 2 external calls (String, format!).


##### `fetch_rate_limit_reset_credits`  (lines 767–783)

```
async fn fetch_rate_limit_reset_credits(
    request_handle: AppServerRequestHandle,
) -> Result<RateLimitResetCreditsSummary>
```

**Purpose**: Extracts the reset-credit summary from the account rate-limits response. It treats missing reset-credit data as an error because the caller specifically asked for it.

**Data flow**: It sends an account rate-limits request, receives the full rate-limit response, and returns the `rate_limit_reset_credits` field if present; otherwise it returns a descriptive error.

**Call relations**: This helper is called by `App::refresh_rate_limit_reset_credits`. It reuses the rate-limits endpoint rather than a separate reset-credit endpoint.

*Call graph*: calls 1 internal fn (request_typed); called by 1 (refresh_rate_limit_reset_credits); 2 external calls (String, format!).


##### `consume_rate_limit_reset_credit_request`  (lines 785–797)

```
async fn consume_rate_limit_reset_credit_request(
    request_handle: AppServerRequestHandle,
    idempotency_key: String,
) -> Result<ConsumeAccountRateLimitResetCreditResponse>
```

**Purpose**: Sends the request that spends one rate-limit reset credit. The idempotency key helps make the operation safe to retry.

**Data flow**: It receives a request handle and key, creates a unique request id, sends `ConsumeAccountRateLimitResetCredit`, and returns the server response or an error with context.

**Call relations**: This helper is called by `App::consume_rate_limit_reset_credit`, which adds a timeout and event reporting.

*Call graph*: calls 1 internal fn (request_typed); called by 1 (consume_rate_limit_reset_credit); 2 external calls (String, format!).


##### `send_add_credits_nudge_email`  (lines 799–813)

```
async fn send_add_credits_nudge_email(
    request_handle: AppServerRequestHandle,
    credit_type: AddCreditsNudgeCreditType,
) -> Result<codex_app_server_protocol::AddCreditsNudgeEmailStatus>
```

**Purpose**: Requests that the server send an add-credits nudge email and returns the email status. It is the low-level server call behind the App method with the same name.

**Data flow**: It receives a request handle and credit type, sends `SendAddCreditsNudgeEmail`, and returns only the response status field.

**Call relations**: This free helper is called by `App::send_add_credits_nudge_email`. The App method turns the result into an app event.

*Call graph*: calls 1 internal fn (request_typed); called by 1 (send_add_credits_nudge_email); 2 external calls (String, format!).


##### `fetch_skills_list`  (lines 815–832)

```
async fn fetch_skills_list(
    request_handle: AppServerRequestHandle,
    cwd: PathBuf,
) -> Result<SkillsListResponse>
```

**Purpose**: Loads the list of skills for a working directory. Skills metadata feeds mention suggestions and skills-related UI.

**Data flow**: It receives a request handle and directory, sends `SkillsList` with that directory and `force_reload` enabled, and returns the server's skills list response.

**Call relations**: This helper is used by `App::refresh_startup_skills`, which runs it in the background during startup.

*Call graph*: calls 1 internal fn (request_typed); called by 1 (refresh_startup_skills); 3 external calls (String, format!, vec!).


##### `fetch_connectors_list`  (lines 834–855)

```
async fn fetch_connectors_list(
    request_handle: AppServerRequestHandle,
    force_refetch: bool,
    thread_id: Option<String>,
) -> Result<ConnectorsSnapshot>
```

**Purpose**: Loads app connector data from the server and wraps it in the UI's snapshot type. Connectors represent external apps available to the session.

**Data flow**: It receives a request handle, a force-refresh flag, and optional thread id. It sends `AppsList`, then returns a `ConnectorsSnapshot` containing the response data.

**Call relations**: This helper is called by `App::fetch_connectors_list`. The App method supplies the current thread context and posts the result to the event loop.

*Call graph*: calls 1 internal fn (request_typed); called by 1 (fetch_connectors_list); 2 external calls (String, format!).


##### `fetch_plugins_list`  (lines 857–866)

```
async fn fetch_plugins_list(
    request_handle: AppServerRequestHandle,
    cwd: PathBuf,
) -> Result<PluginListResponse>
```

**Purpose**: Loads the main plugin list for a directory and removes marketplaces that should not be shown in this UI. It gives callers a cleaned-up plugin list.

**Data flow**: It receives a request handle and directory, calls `request_plugin_list`, removes hidden command-line-only marketplaces from the response, and returns the filtered response.

**Call relations**: This helper is called by `App::fetch_plugins_list`. It delegates the raw request to `request_plugin_list` and the filtering to `hide_cli_only_plugin_marketplaces`.

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

**Purpose**: Loads extra remote plugin sections such as workspace plugins and shared plugins. It also creates user-facing section errors when a remote catalog cannot be loaded.

**Data flow**: It receives feature flags, builds the list of remote sections to try, fetches each section by marketplace kind, filters hidden marketplaces, appends successful marketplaces, and records helpful error messages for failures or disabled sharing.

**Call relations**: This helper is called after the main plugin list succeeds in `App::fetch_plugins_list`. It uses `request_plugin_list_for_kinds`, `hide_cli_only_plugin_marketplaces`, `plugin_remote_section_error_message`, and `plugin_sharing_disabled_remote_section_error`.

*Call graph*: calls 4 internal fn (hide_cli_only_plugin_marketplaces, plugin_remote_section_error_message, plugin_sharing_disabled_remote_section_error, request_plugin_list_for_kinds); called by 1 (fetch_plugins_list); 5 external calls (clone, new, clone, format!, vec!).


##### `plugin_remote_section_error_message`  (lines 921–928)

```
fn plugin_remote_section_error_message(label: &str, err: &str) -> String
```

**Purpose**: Adds a concrete next step to a remote plugin section error when the file recognizes the problem. This turns raw server errors into advice users can act on.

**Data flow**: It receives a section label and error text, asks for a matching next-step sentence, and returns either the original error or the error plus that sentence.

**Call relations**: This helper is used by `fetch_additional_plugin_remote_sections` when a remote plugin section fails. It delegates the pattern matching to `plugin_remote_section_error_next_step`.

*Call graph*: calls 1 internal fn (plugin_remote_section_error_next_step); called by 1 (fetch_additional_plugin_remote_sections); 1 external calls (format!).


##### `plugin_remote_section_error_next_step`  (lines 930–966)

```
fn plugin_remote_section_error_next_step(label: &str, err: &str) -> &'static str
```

**Purpose**: Chooses a helpful next-step sentence for common remote plugin failures. Examples include signing in, switching workspaces, asking an admin, updating Codex, or trying again later.

**Data flow**: It lowercases the error text, checks it for known phrases, and returns a static advice string or an empty string if no advice matches.

**Call relations**: This function is called only by `plugin_remote_section_error_message`, which attaches the returned advice to the visible error.

*Call graph*: called by 1 (plugin_remote_section_error_message).


##### `plugin_sharing_disabled_remote_section_error`  (lines 968–974)

```
fn plugin_sharing_disabled_remote_section_error() -> PluginRemoteSectionError
```

**Purpose**: Builds the standard error shown for the "Shared with me" plugin section when plugin sharing is disabled. This makes the missing section explicit instead of silently omitting it.

**Data flow**: It takes no input and returns a `PluginRemoteSectionError` with the shared-with-me section id, label, and a message explaining that plugin sharing must be enabled.

**Call relations**: This helper is used by `fetch_additional_plugin_remote_sections` when the plugin sharing feature flag is off.

*Call graph*: called by 1 (fetch_additional_plugin_remote_sections).


##### `hide_cli_only_plugin_marketplaces`  (lines 978–982)

```
fn hide_cli_only_plugin_marketplaces(response: &mut PluginListResponse)
```

**Purpose**: Removes plugin marketplaces that should not appear in the terminal UI's plugin menu. Currently it hides the `openai-bundled` marketplace.

**Data flow**: It receives a mutable plugin list response and filters its marketplace list in place, keeping only marketplaces whose names are not in the hidden list.

**Call relations**: This helper is used after plugin-list responses in `fetch_plugins_list` and `fetch_additional_plugin_remote_sections`. A unit test also calls it to verify the filtering behavior.

*Call graph*: called by 3 (fetch_additional_plugin_remote_sections, fetch_plugins_list, hide_cli_only_plugin_marketplaces_removes_openai_bundled).


##### `request_plugin_list`  (lines 984–990)

```
async fn request_plugin_list(
    request_handle: AppServerRequestHandle,
    cwd: PathBuf,
) -> Result<PluginListResponse>
```

**Purpose**: Requests the default plugin list for a directory. It is a convenience wrapper for the more general marketplace-kind request helper.

**Data flow**: It receives a request handle and directory, passes them to `request_plugin_list_with_marketplace_kinds` with no marketplace-kind filter, and returns that result.

**Call relations**: This helper is called by `fetch_plugins_list` and also by plugin mention loading elsewhere. It funnels default plugin-list requests into the shared request builder.

*Call graph*: calls 1 internal fn (request_plugin_list_with_marketplace_kinds); called by 2 (fetch_plugins_list, fetch_plugin_mentions).


##### `request_plugin_list_for_kinds`  (lines 992–998)

```
async fn request_plugin_list_for_kinds(
    request_handle: AppServerRequestHandle,
    cwd: PathBuf,
    marketplace_kinds: Vec<PluginListMarketplaceKind>,
) -> Result<PluginListResponse>
```

**Purpose**: Requests plugin listings limited to particular marketplace kinds. This is used for remote plugin sections that should be loaded separately.

**Data flow**: It receives a request handle, directory, and marketplace-kind list, then calls `request_plugin_list_with_marketplace_kinds` with that filter.

**Call relations**: This helper is called by `fetch_additional_plugin_remote_sections`. It shares the actual app-server request code with `request_plugin_list`.

*Call graph*: calls 1 internal fn (request_plugin_list_with_marketplace_kinds); called by 1 (fetch_additional_plugin_remote_sections).


##### `request_plugin_list_with_marketplace_kinds`  (lines 1000–1017)

```
async fn request_plugin_list_with_marketplace_kinds(
    request_handle: AppServerRequestHandle,
    cwd: PathBuf,
    marketplace_kinds: Option<Vec<PluginListMarketplaceKind>>,
) -> Result<PluginList
```

**Purpose**: Builds and sends the actual plugin-list request to the app server. It can request all marketplaces or only selected kinds.

**Data flow**: It receives a request handle, directory, and optional marketplace-kind filter. It first requires the directory to be an absolute path, then sends `PluginList` with a unique request id and returns the response.

**Call relations**: This is the shared low-level helper used by both `request_plugin_list` and `request_plugin_list_for_kinds`.

*Call graph*: calls 2 internal fn (request_typed, try_from); called by 2 (request_plugin_list, request_plugin_list_for_kinds); 3 external calls (String, format!, vec!).


##### `fetch_plugin_detail`  (lines 1019–1028)

```
async fn fetch_plugin_detail(
    request_handle: AppServerRequestHandle,
    params: PluginReadParams,
) -> Result<PluginReadResponse>
```

**Purpose**: Sends the server request to read detailed data for a plugin. It is the low-level helper behind the App method with the same name.

**Data flow**: It receives a request handle and plugin read parameters, creates a unique request id, sends `PluginRead`, and returns the plugin detail response or an error.

**Call relations**: This helper is called by `App::fetch_plugin_detail`, which wraps it in a background task and sends an event.

*Call graph*: calls 1 internal fn (request_typed); called by 1 (fetch_plugin_detail); 2 external calls (String, format!).


##### `fetch_marketplace_add`  (lines 1030–1049)

```
async fn fetch_marketplace_add(
    request_handle: AppServerRequestHandle,
    cwd: PathBuf,
    source: String,
) -> Result<MarketplaceAddResponse>
```

**Purpose**: Sends the server request to add a plugin marketplace. It also normalizes relative local paths before sending them.

**Data flow**: It receives a request handle, current directory, and source string. It requires the directory to be absolute, rewrites relative local sources against that directory, sends `MarketplaceAdd`, and returns the server response.

**Call relations**: This helper is called by `App::fetch_marketplace_add`. It uses `marketplace_add_source_for_request` to prepare the source string.

*Call graph*: calls 3 internal fn (request_typed, marketplace_add_source_for_request, try_from); called by 1 (fetch_marketplace_add); 3 external calls (as_path, String, format!).


##### `marketplace_add_source_for_request`  (lines 1051–1076)

```
fn marketplace_add_source_for_request(cwd: &std::path::Path, source: String) -> String
```

**Purpose**: Turns relative local marketplace paths into absolute paths while leaving remote-looking sources alone. This prevents the server from interpreting `./marketplace` without knowing the user's current directory.

**Data flow**: It receives the current directory and source string. It separates any branch or ref suffix like `#main` or `@tag`, resolves relative local path forms against the directory, restores the suffix, and otherwise returns the original source.

**Call relations**: This helper is used by `fetch_marketplace_add` and tested directly by `tests::marketplace_add_source_for_request_resolves_relative_local_paths`.

*Call graph*: calls 1 internal fn (resolve_path_against_base); called by 2 (fetch_marketplace_add, marketplace_add_source_for_request_resolves_relative_local_paths); 2 external calls (format!, matches!).


##### `fetch_marketplace_remove`  (lines 1078–1090)

```
async fn fetch_marketplace_remove(
    request_handle: AppServerRequestHandle,
    marketplace_name: String,
) -> Result<MarketplaceRemoveResponse>
```

**Purpose**: Sends the server request to remove a plugin marketplace by name.

**Data flow**: It receives a request handle and marketplace name, creates a unique request id, sends `MarketplaceRemove`, and returns the response or an error.

**Call relations**: This helper is called by `App::fetch_marketplace_remove`, which preserves UI labels and reports completion through an event.

*Call graph*: calls 1 internal fn (request_typed); called by 1 (fetch_marketplace_remove); 2 external calls (String, format!).


##### `fetch_marketplace_upgrade`  (lines 1092–1104)

```
async fn fetch_marketplace_upgrade(
    request_handle: AppServerRequestHandle,
    marketplace_name: Option<String>,
) -> Result<MarketplaceUpgradeResponse>
```

**Purpose**: Sends the server request to upgrade one marketplace or all marketplaces. Upgrading refreshes marketplace content known to the plugin system.

**Data flow**: It receives a request handle and optional marketplace name, creates a unique request id, sends `MarketplaceUpgrade`, and returns the response.

**Call relations**: This helper is called by `App::fetch_marketplace_upgrade`, which runs it in the background.

*Call graph*: calls 1 internal fn (request_typed); called by 1 (fetch_marketplace_upgrade); 2 external calls (String, format!).


##### `fetch_plugin_install`  (lines 1105–1123)

```
async fn fetch_plugin_install(
    request_handle: AppServerRequestHandle,
    location: PluginLocation,
    plugin_name: String,
) -> Result<PluginInstallResponse>
```

**Purpose**: Sends the server request to install a plugin from the chosen location. The location may be a local marketplace path or a remote marketplace name.

**Data flow**: It receives a request handle, plugin location, and plugin name. It converts the location into exactly the request fields the server expects, sends `PluginInstall`, and returns the install response.

**Call relations**: This helper is called by `App::fetch_plugin_install`. It relies on `PluginLocation::into_request_params` to express local versus remote install sources.

*Call graph*: calls 2 internal fn (request_typed, into_request_params); called by 1 (fetch_plugin_install); 2 external calls (String, format!).


##### `fetch_plugin_uninstall`  (lines 1125–1137)

```
async fn fetch_plugin_uninstall(
    request_handle: AppServerRequestHandle,
    plugin_id: String,
) -> Result<PluginUninstallResponse>
```

**Purpose**: Sends the server request to uninstall a plugin by id.

**Data flow**: It receives a request handle and plugin id, creates a unique request id, sends `PluginUninstall`, and returns the server response or a wrapped error.

**Call relations**: This helper is called by `App::fetch_plugin_uninstall`, which adds UI context and event delivery.

*Call graph*: calls 1 internal fn (request_typed); called by 1 (fetch_plugin_uninstall); 2 external calls (String, format!).


##### `write_plugin_enabled`  (lines 1139–1158)

```
async fn write_plugin_enabled(
    request_handle: AppServerRequestHandle,
    plugin_id: String,
    enabled: bool,
) -> Result<ConfigWriteResponse>
```

**Purpose**: Writes the enabled or disabled state for one plugin into configuration through the app server. It uses an upsert write, meaning it creates or updates the setting.

**Data flow**: It receives a request handle, plugin id, and enabled flag. It builds a config key like `plugins.<id>`, writes JSON containing the enabled value, and returns the config write response.

**Call relations**: This helper is called by `App::spawn_plugin_enabled_write`, after `App::set_plugin_enabled` decides a write should start.

*Call graph*: calls 1 internal fn (request_typed); called by 1 (spawn_plugin_enabled_write); 3 external calls (String, format!, json!).


##### `write_hook_enabled`  (lines 1160–1186)

```
async fn write_hook_enabled(
    request_handle: AppServerRequestHandle,
    key: String,
    enabled: bool,
) -> Result<ConfigWriteResponse>
```

**Purpose**: Writes the enabled or disabled state for one hook into configuration. It uses a batch config write and asks the app server to reload user config afterward.

**Data flow**: It receives a request handle, hook key, and enabled flag. It sends a config batch edit under `hooks.state` with the new value and returns the write response.

**Call relations**: This helper is called by `App::spawn_hook_enabled_write`, after `App::set_hook_enabled` decides a write should start.

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

**Purpose**: Builds the structured feedback upload request from UI choices. It decides which optional pieces, such as logs and turn id tags, should be included.

**Data flow**: It receives the originating thread id, optional rollout log path, category, optional reason, optional turn id, and log-inclusion flag. It converts the category to a classification string, includes thread id and tags when present, includes log files only when logs are requested, and returns `FeedbackUploadParams`.

**Call relations**: This helper is called by `App::submit_feedback` before the server upload. Unit tests call it to check both log-including and log-omitting cases.

*Call graph*: called by 3 (submit_feedback, build_feedback_upload_params_includes_thread_id_and_rollout_path, build_feedback_upload_params_omits_rollout_path_without_logs); 1 external calls (feedback_classification).


##### `fetch_feedback_upload`  (lines 1212–1221)

```
async fn fetch_feedback_upload(
    request_handle: AppServerRequestHandle,
    params: FeedbackUploadParams,
) -> Result<FeedbackUploadResponse>
```

**Purpose**: Sends the feedback upload request to the app server. It is the low-level request helper behind feedback submission.

**Data flow**: It receives a request handle and prepared feedback parameters, creates a unique request id, sends `FeedbackUpload`, and returns the upload response or an error.

**Call relations**: This helper is called by `App::submit_feedback`, which extracts the returned thread id and posts a completion event.

*Call graph*: calls 1 internal fn (request_typed); called by 1 (submit_feedback); 2 external calls (String, format!).


##### `mcp_inventory_maps_from_statuses`  (lines 1236–1261)

```
fn mcp_inventory_maps_from_statuses(statuses: Vec<McpServerStatus>) -> McpInventoryMaps
```

**Purpose**: Converts MCP status responses into maps used by older or in-process MCP code during tests. The production TUI renders directly from the status list, so this helper is test-only.

**Data flow**: It receives a list of server statuses. For each server it records auth status, resources, resource templates, and inserts each tool under a combined key like `mcp__server__tool`, then returns all four maps.

**Call relations**: This test-only helper is called by `tests::mcp_inventory_maps_prefix_tool_names_by_server` to verify the conversion and tool-name prefixing.

*Call graph*: called by 1 (mcp_inventory_maps_prefix_tool_names_by_server); 2 external calls (new, format!).


##### `tests::test_absolute_path`  (lines 1272–1274)

```
fn test_absolute_path(path: &str) -> AbsolutePathBuf
```

**Purpose**: Creates an absolute path value for tests. It keeps repeated test setup short and explicit.

**Data flow**: It receives a path string, turns it into a `PathBuf`, converts it to an `AbsolutePathBuf`, and fails the test if the path is not absolute.

**Call relations**: Several plugin marketplace tests use this helper when they need an absolute marketplace path.

*Call graph*: calls 1 internal fn (try_from); 1 external calls (from).


##### `tests::marketplace_add_source_for_request_resolves_relative_local_paths`  (lines 1277–1299)

```
fn marketplace_add_source_for_request_resolves_relative_local_paths()
```

**Purpose**: Checks that relative marketplace paths are resolved against the current directory, while remote-style and home-relative strings are left unchanged.

**Data flow**: It creates a platform-appropriate current directory, calls `marketplace_add_source_for_request` with several source forms, and asserts the expected resolved or unchanged strings.

**Call relations**: This test directly protects the path-normalizing behavior used by `fetch_marketplace_add`.

*Call graph*: calls 1 internal fn (marketplace_add_source_for_request); 4 external calls (from, assert!, assert_eq!, cfg!).


##### `tests::hide_cli_only_plugin_marketplaces_removes_openai_bundled`  (lines 1302–1333)

```
fn hide_cli_only_plugin_marketplaces_removes_openai_bundled()
```

**Purpose**: Verifies that the hidden command-line-only plugin marketplace is removed from plugin list responses.

**Data flow**: It builds a plugin list with `openai-bundled` and another marketplace, calls `hide_cli_only_plugin_marketplaces`, and asserts that only the visible marketplace remains.

**Call relations**: This test covers the filtering helper used by `fetch_plugins_list` and `fetch_additional_plugin_remote_sections`.

*Call graph*: calls 1 internal fn (hide_cli_only_plugin_marketplaces); 3 external calls (new, assert_eq!, vec!).


##### `tests::plugin_location_request_params_select_exactly_one_location`  (lines 1336–1353)

```
fn plugin_location_request_params_select_exactly_one_location()
```

**Purpose**: Checks that plugin install locations translate into the correct request fields. Local installs should use a path, and remote installs should use a marketplace name.

**Data flow**: It creates a local absolute path, converts both local and remote `PluginLocation` values into request parameters, and asserts that exactly one of the two location fields is set in each case.

**Call relations**: This test protects the location conversion used by `fetch_plugin_install` before it sends an install request.

*Call graph*: 2 external calls (assert_eq!, test_absolute_path).


##### `tests::plugin_remote_section_error_message_adds_concrete_next_steps`  (lines 1356–1406)

```
fn plugin_remote_section_error_message_adds_concrete_next_steps()
```

**Purpose**: Verifies that common remote plugin errors get helpful next-step advice. This keeps user-facing remote section failures actionable.

**Data flow**: It defines several section labels, raw errors, and expected advice strings. For each case it calls `plugin_remote_section_error_message` and asserts that the advice is appended.

**Call relations**: This test covers `plugin_remote_section_error_message` and, through it, the matching rules in `plugin_remote_section_error_next_step`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::plugin_sharing_disabled_remote_section_error_targets_shared_with_me`  (lines 1409–1418)

```
fn plugin_sharing_disabled_remote_section_error_targets_shared_with_me()
```

**Purpose**: Checks that the disabled-sharing error points to the correct remote plugin section. The section should be `Shared with me`.

**Data flow**: It calls `plugin_sharing_disabled_remote_section_error` and compares the whole returned error object to the expected id, label, and message.

**Call relations**: This test protects the error object inserted by `fetch_additional_plugin_remote_sections` when plugin sharing is off.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::mcp_inventory_maps_prefix_tool_names_by_server`  (lines 1421–1470)

```
fn mcp_inventory_maps_prefix_tool_names_by_server()
```

**Purpose**: Verifies that MCP tools are keyed with their server name when converted into maps. This avoids collisions when different servers expose tools with the same name.

**Data flow**: It builds sample MCP statuses, calls `mcp_inventory_maps_from_statuses`, sorts map keys where needed, and asserts that tools, resources, templates, and auth statuses are recorded as expected.

**Call relations**: This test covers the test-only MCP conversion helper `mcp_inventory_maps_from_statuses`.

*Call graph*: calls 1 internal fn (mcp_inventory_maps_from_statuses); 2 external calls (assert_eq!, vec!).


##### `tests::mcp_inventory_omits_thread_id_for_closed_agent_thread`  (lines 1473–1490)

```
async fn mcp_inventory_omits_thread_id_for_closed_agent_thread()
```

**Purpose**: Checks that MCP inventory requests stop including a thread id after the agent thread is closed. This prevents stale thread-specific requests.

**Data flow**: It creates a test app, marks a new thread as active and open, verifies the id is accepted, then marks the thread closed and verifies the helper returns no id.

**Call relations**: This test covers `App::mcp_inventory_request_thread_id`, which is used by `App::fetch_mcp_inventory`.

*Call graph*: calls 2 internal fn (new, make_test_app); 1 external calls (assert_eq!).


##### `tests::build_feedback_upload_params_includes_thread_id_and_rollout_path`  (lines 1493–1519)

```
fn build_feedback_upload_params_includes_thread_id_and_rollout_path()
```

**Purpose**: Verifies that feedback upload parameters include thread id, reason, turn id tag, and rollout log path when logs are requested.

**Data flow**: It creates a thread id and rollout path, builds feedback parameters with logs enabled, and asserts that all expected fields are present.

**Call relations**: This test covers the log-including branch of `build_feedback_upload_params`, used by `App::submit_feedback`.

*Call graph*: calls 2 internal fn (new, build_feedback_upload_params); 2 external calls (from, assert_eq!).


##### `tests::build_feedback_upload_params_omits_rollout_path_without_logs`  (lines 1522–1538)

```
fn build_feedback_upload_params_omits_rollout_path_without_logs()
```

**Purpose**: Verifies that feedback upload parameters do not attach log files when the user chose not to include logs.

**Data flow**: It builds feedback parameters with a rollout path available but logs disabled, then asserts that optional reason, thread id, tags, and extra log files are absent as expected.

**Call relations**: This test covers the privacy-sensitive log-omitting branch of `build_feedback_upload_params`.

*Call graph*: calls 1 internal fn (build_feedback_upload_params); 2 external calls (from, assert_eq!).
