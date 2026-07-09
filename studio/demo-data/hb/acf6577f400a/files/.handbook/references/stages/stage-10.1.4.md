# Specialized interactive flows and auxiliary TUI handlers  `stage-10.1.4`

This stage covers special side flows in the terminal interface. These are not the main chat loop, but popups, pickers, previews, and helpers that users open while working. The cloud-tasks files form a small app inside the app: one file stores the task list, selected row, popups, and loaded details; another stores the “new task” form; the UI file draws the list, editor, overlays, confirmations, and spinners.

Several files support navigation through complex conversations. Agent navigation and multi-agent display keep agent threads in a stable order, show readable status rows, and let users switch agents. Backtrack lets a user return to an earlier prompt and roll the conversation back. Pager overlays show long transcripts or help pages.

Other files customize the interface. The keymap files provide the shortcut editor, action catalog, searchable picker, and keypress inspector. Theme picker previews and saves color themes. Pet files handle selecting, previewing, drawing, disabling, and cleaning up the companion pet.

Finally, platform actions, clipboard paste, and external import flows connect the app to the outside world: operating-system checks, pasted images or paths, and importing settings from Claude Code.

## Files in this stage

### Cloud tasks UI state
These files define the cloud-tasks TUI state, initialize the new-task composer, and render the task-oriented interface and overlays.

### `cloud-tasks/src/app.rs`

`orchestration` · `main loop`

This file is the app’s shared notebook. A terminal user interface has to remember many small things at once: which task is selected, whether a refresh is running, which environment is filtered, whether a modal window is open, and what detail text is being shown. Without this file, the rest of the app would have no single, consistent place to read or update that state.

The `App` type holds the top-level screen state. It tracks the list of cloud tasks, status text, loading spinners, environment selection, new-task form state, and apply-patch progress. The `load_tasks` helper asks the cloud backend for recent tasks, times out after five seconds, and hides review-only tasks so the main list stays focused.

The `DiffOverlay` type is the detail pane shown for one task. It can show either the task’s prompt/output or its code diff, and it can switch between multiple attempts. Think of it like a folder with several drafts inside: the overlay remembers which draft is open and updates the visible page when the user switches views or attempts.

`AppEvent` describes messages sent back from background work, such as “tasks loaded,” “details failed,” or “apply finished.” This lets slow network work happen without freezing the terminal interface.

#### Function details

##### `App::new`  (lines 78–102)

```
fn new() -> Self
```

**Purpose**: Creates a fresh app state before the terminal interface starts. It fills in sensible defaults, such as an empty task list, the first selected row, no open pop-ups, and a status message telling the user how to refresh.

**Data flow**: Nothing comes in. The function builds an `App` value with empty collections, false loading flags, no selected environment, no active detail overlay, and `best_of_n` set to 1. The completed `App` state comes out ready for the main program to use.

**Call relations**: The main runner calls this during startup. It also creates empty helper collections, such as the set used to remember background work already in flight.

*Call graph*: called by 1 (run_main); 2 external calls (new, new).


##### `App::next`  (lines 104–109)

```
fn next(&mut self)
```

**Purpose**: Moves the task-list selection down by one row. It stops at the bottom so the selection never points outside the task list.

**Data flow**: It reads the current task list and selected index. If there are no tasks, nothing changes. Otherwise it increases the selected index, but clamps it to the last valid row.

**Call relations**: No direct caller is shown in the graph, but this is the kind of method the keyboard input loop uses when the user presses a down key. It only changes `App.selected`; drawing code can then show the new selected row.


##### `App::prev`  (lines 111–118)

```
fn prev(&mut self)
```

**Purpose**: Moves the task-list selection up by one row. It stops at the top so the selection cannot become negative.

**Data flow**: It reads the current task list and selected index. If the list is empty or the selection is already at the first row, nothing changes. Otherwise it subtracts one from the selected index.

**Call relations**: No direct caller is shown in the graph, but it exists for navigation from the UI input loop. After it runs, the rest of the app can redraw using the updated selection.


##### `load_tasks`  (lines 121–134)

```
async fn load_tasks(
    backend: &dyn CloudBackend,
    env: Option<&str>,
) -> anyhow::Result<Vec<TaskSummary>>
```

**Purpose**: Fetches a short page of cloud tasks, optionally limited to one environment. It protects the interface from hanging forever by giving the backend five seconds to answer.

**Data flow**: It receives a cloud backend and an optional environment id. It asks the backend for up to 20 tasks, waits with a five-second timeout, then removes tasks marked as review-only. It returns the filtered list or an error if the backend fails or takes too long.

**Call relations**: The main runner calls this when it needs to refresh the visible task list. The test `tests::load_tasks_uses_env_parameter` also calls it to prove that the environment filter is passed through correctly.

*Call graph*: called by 2 (load_tasks_uses_env_parameter, run_main); 3 external calls (from_secs, list_tasks, timeout).


##### `AttemptView::has_diff`  (lines 164–166)

```
fn has_diff(&self) -> bool
```

**Purpose**: Answers whether this attempt has any diff lines to show. A diff is the text form of code changes.

**Data flow**: It reads the attempt’s stored diff lines. If that list is not empty, it returns `true`; otherwise it returns `false`. It does not change the attempt.

**Call relations**: No direct caller is shown in the graph. It is a small convenience check for UI code that needs to decide whether a diff tab or action should be available.


##### `AttemptView::has_text`  (lines 168–170)

```
fn has_text(&self) -> bool
```

**Purpose**: Answers whether this attempt has prompt or message text to show. This helps the UI know whether the non-diff view has useful content.

**Data flow**: It reads the attempt’s text lines and optional prompt. It returns `true` if there are message lines or a prompt, and `false` if both are missing. It does not modify anything.

**Call relations**: No direct caller is shown in the graph. It is intended as a simple readiness check for display code.


##### `DiffOverlay::new`  (lines 174–192)

```
fn new(task_id: TaskId, title: String, attempt_total_hint: Option<usize>) -> Self
```

**Purpose**: Creates the detail overlay for a selected task. The overlay starts empty, ready to be filled by background detail-loading work.

**Data flow**: It receives a task id, a title, and an optional hint for how many attempts exist. It creates an empty scrollable diff viewer, stores the task identity, starts with one blank attempt, selects the prompt view, and returns the new overlay.

**Call relations**: Code that opens task details uses this as the starting container. It calls `ScrollableDiff::new` and then gives that viewer empty content so the UI has a valid display object immediately.

*Call graph*: calls 1 internal fn (new); 2 external calls (new, vec!).


##### `DiffOverlay::current_attempt`  (lines 194–196)

```
fn current_attempt(&self) -> Option<&AttemptView>
```

**Purpose**: Returns the attempt that is currently selected in the overlay. If the selected index does not point to an existing attempt, it returns nothing.

**Data flow**: It reads `selected_attempt` and looks up that position in the attempts list. The result is either a shared reference to the attempt or `None`. No state changes.

**Call relations**: `DiffOverlay::apply_selection_to_fields` uses this when copying the selected attempt into the visible fields. `DiffOverlay::current_can_apply` uses it to check whether the selected attempt has an applyable raw diff.

*Call graph*: called by 2 (apply_selection_to_fields, current_can_apply).


##### `DiffOverlay::base_attempt_mut`  (lines 198–203)

```
fn base_attempt_mut(&mut self) -> &mut AttemptView
```

**Purpose**: Gives mutable access to the first attempt, creating a blank one if the list is empty. This protects callers from having to check for a missing base attempt themselves.

**Data flow**: It looks at the attempts list. If the list is empty, it inserts a default blank `AttemptView`. It then returns a mutable reference to the first attempt so the caller can fill in details.

**Call relations**: No direct caller is shown in the graph. It is meant for detail-loading code that receives the first, or base, attempt’s data and needs a guaranteed place to store it.

*Call graph*: 1 external calls (default).


##### `DiffOverlay::set_view`  (lines 205–208)

```
fn set_view(&mut self, view: DetailView)
```

**Purpose**: Switches the overlay between the diff view and the prompt/output view. It immediately refreshes the visible scroll content to match the new view.

**Data flow**: It receives the desired `DetailView`. It stores that view on the overlay, then calls `apply_selection_to_fields` to copy the selected attempt’s relevant text into the display area.

**Call relations**: When UI code changes tabs, this method is the bridge between the user’s choice and the data shown on screen. It hands off to `DiffOverlay::apply_selection_to_fields` so the scrollable viewer is updated consistently.

*Call graph*: calls 1 internal fn (apply_selection_to_fields).


##### `DiffOverlay::expected_attempts`  (lines 210–218)

```
fn expected_attempts(&self) -> Option<usize>
```

**Purpose**: Reports how many attempts the overlay expects to exist. It prefers a backend-provided total, but can fall back to the number of attempts already loaded.

**Data flow**: It reads `attempt_total_hint` first. If that hint is present, it returns it. If not, it returns the current attempts length when at least one attempt exists, otherwise it returns nothing.

**Call relations**: `DiffOverlay::attempt_display_total` calls this when deciding what total number to show in the UI, such as “attempt 1 of 3.”

*Call graph*: called by 1 (attempt_display_total).


##### `DiffOverlay::attempt_count`  (lines 220–222)

```
fn attempt_count(&self) -> usize
```

**Purpose**: Returns how many attempt records are currently stored in the overlay. This is the loaded count, not necessarily the final total from the backend.

**Data flow**: It reads the attempts list length and returns that number. It does not change the overlay.

**Call relations**: No direct caller is shown in the graph. It is a simple information method for UI or loading code that needs to know how many attempts are already present.


##### `DiffOverlay::attempt_display_total`  (lines 224–227)

```
fn attempt_display_total(&self) -> usize
```

**Purpose**: Returns the total attempt count that should be displayed to the user. It always gives at least one so the UI does not show an empty or confusing total.

**Data flow**: It asks `expected_attempts` for the best known total. If no total is known, it uses the current number of stored attempts, with a minimum of one. The chosen number is returned.

**Call relations**: It builds directly on `DiffOverlay::expected_attempts`. Display code can use this when rendering attempt navigation text.

*Call graph*: calls 1 internal fn (expected_attempts).


##### `DiffOverlay::step_attempt`  (lines 229–242)

```
fn step_attempt(&mut self, delta: isize) -> bool
```

**Purpose**: Moves the selected attempt forward or backward, wrapping around at the ends. This lets the user cycle through attempts like turning a carousel.

**Data flow**: It receives a signed step amount, such as `1` for next or `-1` for previous. If there is only one attempt, it returns `false` and changes nothing. Otherwise it calculates the wrapped new index, stores it, refreshes the visible fields, and returns `true`.

**Call relations**: User navigation code can call this when the user switches attempts. After changing the index, it calls `DiffOverlay::apply_selection_to_fields` so the screen shows the newly selected attempt.

*Call graph*: calls 1 internal fn (apply_selection_to_fields).


##### `DiffOverlay::current_can_apply`  (lines 244–251)

```
fn current_can_apply(&self) -> bool
```

**Purpose**: Checks whether the currently selected attempt can be applied as a patch. Applying is only allowed while viewing a non-empty diff.

**Data flow**: It reads the current view and the selected attempt. It returns `true` only when the view is `Diff` and the selected attempt has a raw diff string that is not empty. Otherwise it returns `false`.

**Call relations**: It calls `DiffOverlay::current_attempt` to inspect the selected attempt. UI code can use this to enable or disable an apply action.

*Call graph*: calls 1 internal fn (current_attempt); 1 external calls (matches!).


##### `DiffOverlay::apply_selection_to_fields`  (lines 253–288)

```
fn apply_selection_to_fields(&mut self)
```

**Purpose**: Copies the selected attempt’s content into the overlay fields that the screen actually draws. It also fills in friendly placeholder text when content is missing.

**Data flow**: It reads the currently selected attempt. If no attempt is available, it clears stored lines, clears the prompt, and shows “<loading attempt>”. If an attempt exists, it copies its diff lines, text lines, and prompt into the overlay. Then it updates the scrollable viewer with either the diff, the prompt/output text, or a placeholder such as “<no diff available>” or “<no output>”.

**Call relations**: `DiffOverlay::set_view` calls this after a tab change, and `DiffOverlay::step_attempt` calls it after attempt navigation. It calls `DiffOverlay::current_attempt` to find the source data and `ScrollableDiff::set_content` to update what the user sees.

*Call graph*: calls 2 internal fn (current_attempt, set_content); called by 2 (set_view, step_attempt); 1 external calls (vec!).


##### `tests::FakeBackend::list_tasks`  (lines 432–439)

```
fn list_tasks(
            &'a self,
            env: Option<&'a str>,
            limit: Option<i64>,
            cursor: Option<&'a str>,
        ) -> CloudBackendFuture<'a, codex_cloud_tasks_client
```

**Purpose**: Provides fake task-list data for tests without contacting a real cloud service. It can return different titles for different environment filters.

**Data flow**: It receives an optional environment id, a limit, and a cursor. It looks up matching test titles, turns each title into a `TaskSummary`, applies the requested limit up to 20 items, and returns a fake task-list page.

**Call relations**: `tests::FakeBackend::get_task_summary` calls this to search the fake list. When `load_tasks` is tested with this fake backend, this method supplies the controlled data that proves filtering works.

*Call graph*: called by 1 (get_task_summary); 7 external calls (pin, now, new, default, new, list_tasks, format!).


##### `tests::FakeBackend::get_task_summary`  (lines 441–443)

```
fn get_task_summary(&self, id: TaskId) -> CloudBackendFuture<'_, TaskSummary>
```

**Purpose**: Finds one fake task summary by id for tests. It mimics the backend operation that fetches a single task’s basic information.

**Data flow**: It receives a task id. It asks the fake backend for its default task list, searches for a matching id, and returns that task if found. If no match exists, it returns a test error saying the task was not found.

**Call relations**: It calls `tests::FakeBackend::list_tasks` rather than duplicating fake task creation. This keeps the fake single-task lookup consistent with the fake list operation.

*Call graph*: calls 1 internal fn (list_tasks); 2 external calls (pin, get_task_summary).


##### `tests::FakeBackend::get_task_diff`  (lines 445–451)

```
fn get_task_diff(&self, _id: TaskId) -> CloudBackendFuture<'_, Option<String>>
```

**Purpose**: Stubs out diff fetching in the fake backend. The current test does not need diffs, so this deliberately reports that the operation is not implemented.

**Data flow**: It ignores the incoming task id. It returns an `Unimplemented` error inside the async backend shape expected by the real code.

**Call relations**: No test in this file relies on this result. It exists because the fake backend must implement the full `CloudBackend` interface.

*Call graph*: 2 external calls (pin, Unimplemented).


##### `tests::FakeBackend::get_task_messages`  (lines 453–455)

```
fn get_task_messages(&self, _id: TaskId) -> CloudBackendFuture<'_, Vec<String>>
```

**Purpose**: Returns an empty message list for tests. This satisfies the backend interface without adding message-related test data.

**Data flow**: It ignores the task id and returns an empty vector of messages. Nothing is stored or changed.

**Call relations**: It is part of the fake `CloudBackend` implementation. The environment-filter test does not depend on messages, so this method stays minimal.

*Call graph*: 2 external calls (pin, vec!).


##### `tests::FakeBackend::get_task_text`  (lines 457–462)

```
fn get_task_text(
            &self,
            id: TaskId,
        ) -> CloudBackendFuture<'_, codex_cloud_tasks_client::TaskText>
```

**Purpose**: Returns simple fake text details for a task. This gives tests a complete-looking backend even when they only care about task listing.

**Data flow**: It receives a task id but does not need to inspect it. It returns a `TaskText` value with an example prompt, no messages, a fake turn id, no siblings, placement zero, and a completed status.

**Call relations**: The trait implementation wraps this fake response so any code asking for task text during a test can get a predictable answer.

*Call graph*: 3 external calls (pin, new, get_task_text).


##### `tests::FakeBackend::list_sibling_attempts`  (lines 464–470)

```
fn list_sibling_attempts(
            &self,
            _task: TaskId,
            _turn_id: String,
        ) -> CloudBackendFuture<'_, Vec<codex_cloud_tasks_client::TurnAttempt>>
```

**Purpose**: Returns no sibling attempts in tests. Sibling attempts are alternative runs for the same task turn.

**Data flow**: It ignores the task id and turn id. It returns an empty list, meaning the fake task has no alternative attempts.

**Call relations**: It exists to complete the fake backend interface. Tests focused on task loading do not need attempt navigation data.

*Call graph*: 2 external calls (pin, new).


##### `tests::FakeBackend::apply_task`  (lines 472–482)

```
fn apply_task(
            &self,
            _id: TaskId,
            _diff_override: Option<String>,
        ) -> CloudBackendFuture<'_, codex_cloud_tasks_client::ApplyOutcome>
```

**Purpose**: Stubs out actually applying a task patch in tests. The task-list test should never perform a real apply operation.

**Data flow**: It ignores the task id and optional diff override. It returns an `Unimplemented` error instead of producing an apply result.

**Call relations**: It is included because the real backend interface requires an apply method. If a test accidentally tried to apply a patch through this fake backend, the explicit error would make that clear.

*Call graph*: 2 external calls (pin, Unimplemented).


##### `tests::FakeBackend::apply_task_preflight`  (lines 484–494)

```
fn apply_task_preflight(
            &self,
            _id: TaskId,
            _diff_override: Option<String>,
        ) -> CloudBackendFuture<'_, codex_cloud_tasks_client::ApplyOutcome>
```

**Purpose**: Stubs out the preflight check for applying a patch. A preflight is a dry run that checks what would happen before making changes.

**Data flow**: It ignores the task id and optional diff override. It returns an `Unimplemented` error because the environment-filter test does not need apply checking.

**Call relations**: It fills in the required backend interface. Its explicit failure helps catch accidental use in tests that did not set up apply behavior.

*Call graph*: 2 external calls (pin, Unimplemented).


##### `tests::FakeBackend::create_task`  (lines 496–509)

```
fn create_task(
            &'a self,
            _env_id: &'a str,
            _prompt: &'a str,
            _git_ref: &'a str,
            _qa_mode: bool,
            _best_of_n: usize,
        ) ->
```

**Purpose**: Stubs out cloud task creation in tests. This file’s test is about listing tasks, not making new ones.

**Data flow**: It receives an environment id, prompt, git reference, QA-mode flag, and best-of count, but ignores them. It returns an `Unimplemented` error rather than a created task.

**Call relations**: It is present so `FakeBackend` can stand in for a full `CloudBackend`. The task-loading test does not call it.

*Call graph*: 2 external calls (pin, Unimplemented).


##### `tests::load_tasks_uses_env_parameter`  (lines 513–533)

```
async fn load_tasks_uses_env_parameter()
```

**Purpose**: Checks that `load_tasks` passes the requested environment filter to the backend. This guards against a bug where the UI might show tasks from the wrong environment.

**Data flow**: It builds a fake backend with separate task titles for no environment, `env-A`, and `env-B`. It calls `load_tasks` three times with those filters and checks that the returned lengths and titles match the expected fake data.

**Call relations**: This test drives `load_tasks` directly. The fake backend supplies controlled responses, and the assertions confirm that the environment argument changes which tasks come back.

*Call graph*: calls 1 internal fn (load_tasks); 3 external calls (assert_eq!, new, vec!).


### `cloud-tasks/src/new_task.rs`

`data_model` · `screen setup`

This file is a small blueprint for one screen: the page where a user writes and starts a new cloud task. The central type, `NewTaskPage`, keeps together the pieces of information that screen needs. It owns a `ComposerInput`, which is the editable text area where the user types the task. It also remembers whether the task is currently being submitted, which environment is selected, and how many attempts should be requested through `best_of_n`.

The most important work happens when the page is created. The constructor builds a fresh composer and gives it visible keyboard hints, such as Enter to send, Shift+Enter for a newline, and shortcuts for choosing an environment or changing the number of attempts. This is like putting labels on the controls of a small machine before handing it to the user.

Without this file, the rest of the terminal app would not have a clear, reusable object representing the new-task screen. Other code would have to assemble the text input, defaults, and shortcut labels by hand, which would make the screen easier to break or keep inconsistent.

#### Function details

##### `NewTaskPage::new`  (lines 11–26)

```
fn new(env_id: Option<String>, best_of_n: usize) -> Self
```

**Purpose**: Creates a ready-to-use new-task page. It prepares the text input area, adds helpful keyboard shortcut hints, and stores the chosen environment and attempt count.

**Data flow**: It receives an optional environment ID and a number saying how many task attempts to use. It creates a fresh composer input, adds the shortcut labels that will be shown to the user, then returns a `NewTaskPage` with `submitting` set to false, because nothing has been sent yet.

**Call relations**: This is the main way other parts of the terminal interface build the new-task screen. It relies on the composer input’s own creation function to make the text box, then finishes the page-specific setup itself.

*Call graph*: calls 1 internal fn (new); 1 external calls (vec!).


##### `NewTaskPage::default`  (lines 32–34)

```
fn default() -> Self
```

**Purpose**: Creates the standard new-task page when no special starting options are provided. It uses no preselected environment and defaults to one attempt.

**Data flow**: It takes no input. It calls the page constructor with `None` for the environment and `1` for the attempt count, and returns the fully initialized page that constructor creates.

**Call relations**: This is the convenient fallback path for code that just needs a normal new-task screen. Instead of duplicating setup choices, it hands off to `NewTaskPage::new`, keeping the default behavior in sync with the main constructor.

*Call graph*: 1 external calls (new).


### `cloud-tasks/src/ui.rs`

`orchestration` · `main loop render frame`

This file is the app’s drawing desk. Each time the terminal screen needs repainting, it looks at the current App state and decides what the user should see. Without it, the program might still know about tasks, environments, diffs, and apply results, but none of that would be presented in a usable way.

The main draw function first divides the terminal into a large content area and a small footer. If the user is writing a new task, it draws the task composer. Otherwise it draws the task list. It always draws the footer, then adds any open pop-up layers on top, such as the diff/details view, environment selector, attempt-count selector, or apply confirmation.

Most pop-ups share the same geometry helpers, so they appear centered and styled consistently. The file also contains small styling helpers that make diffs readable, mark added and removed lines with colors, and make conversations easier to scan by labeling User and Assistant sections. Loading states are shown with simple blinking dot spinners. In short, this file is the part that translates “what is happening in the app” into “what the user sees right now.”

#### Function details

##### `draw`  (lines 28–57)

```
fn draw(frame: &mut Frame, app: &mut App)
```

**Purpose**: Draws one complete frame of the terminal interface. It decides which main page to show and which pop-up overlays should be layered on top.

**Data flow**: It receives the terminal frame to draw into and the current App state. It reads whether a new task page or any modal overlays are open, draws the matching screen sections, and updates only visual output in the frame.

**Call relations**: This is the top-level drawing function for the file. During each render pass it calls the page drawers, footer drawer, and overlay drawers in the order needed so background content appears first and pop-ups appear above it.

*Call graph*: calls 8 internal fn (draw_apply_modal, draw_best_of_modal, draw_diff_overlay, draw_env_modal, draw_footer, draw_list, draw_new_task_page, area); 3 external calls (Length, Min, default).


##### `rounded_enabled`  (lines 62–69)

```
fn rounded_enabled() -> bool
```

**Purpose**: Decides whether pop-up borders should use rounded corners. It lets an environment variable turn rounded borders on or off.

**Data flow**: It reads CODEX_TUI_ROUNDED from the process environment the first time it runs, stores the answer, and returns a true-or-false value on later calls without rereading the environment.

**Call relations**: overlay_block calls this when building the standard pop-up border style, so all modals share the same rounded-corner setting.

*Call graph*: called by 1 (overlay_block).


##### `overlay_outer`  (lines 71–88)

```
fn overlay_outer(area: Rect) -> Rect
```

**Purpose**: Computes the rectangle where a large overlay should appear. It centers the overlay by leaving margins around the edges of the terminal.

**Data flow**: It takes the full screen area, cuts off about ten percent on each side, and returns the middle eighty percent as the overlay area.

**Call relations**: The modal and overlay drawers call this first so the diff view, apply dialog, environment picker, and attempt selector all start from the same centered layout.

*Call graph*: called by 4 (draw_apply_modal, draw_best_of_modal, draw_diff_overlay, draw_env_modal); 2 external calls (Percentage, default).


##### `overlay_block`  (lines 90–98)

```
fn overlay_block() -> Block<'static>
```

**Purpose**: Creates the shared border and padding style for overlays. This keeps pop-up windows visually consistent.

**Data flow**: It builds a bordered block, optionally gives it rounded corners, adds padding inside the border, and returns that reusable block object.

**Call relations**: All overlay drawers call this when painting their window. overlay_content also uses it to calculate the inner usable area after borders and padding.

*Call graph*: calls 1 internal fn (rounded_enabled); called by 5 (draw_apply_modal, draw_best_of_modal, draw_diff_overlay, draw_env_modal, overlay_content); 2 external calls (default, new).


##### `overlay_content`  (lines 100–102)

```
fn overlay_content(area: Rect) -> Rect
```

**Purpose**: Finds the usable content area inside an overlay’s border and padding. It answers, “where can the actual text or list go?”

**Data flow**: It takes an overlay rectangle, applies the standard overlay block’s inner-area calculation, and returns the smaller rectangle for content.

**Call relations**: Overlay drawing functions call this after drawing their border so headers, lists, messages, and spinners land inside the padded box.

*Call graph*: calls 1 internal fn (overlay_block); called by 4 (draw_apply_modal, draw_best_of_modal, draw_diff_overlay, draw_env_modal).


##### `draw_new_task_page`  (lines 104–174)

```
fn draw_new_task_page(frame: &mut Frame, area: Rect, app: &mut App)
```

**Purpose**: Draws the screen used to compose a new cloud task. It shows the chosen environment, the number of parallel attempts, and the text editor area.

**Data flow**: It reads the new-task state from App, including environment ID, environment labels, attempt count, and the composer widget. It draws a bordered page, sizes the composer based on terminal width and height, renders the composer, and places the terminal cursor where typing should continue.

**Call relations**: draw calls this instead of the task list when app.new_task is present. It relies on the composer object in the new-task state to render text and report the cursor position.

*Call graph*: calls 3 internal fn (area, buffer_mut, set_cursor_position); called by 1 (draw); 8 external calls (default, Length, Min, default, from, format!, render_widget, vec!).


##### `draw_list`  (lines 176–234)

```
fn draw_list(frame: &mut Frame, area: Rect, app: &mut App)
```

**Purpose**: Draws the main cloud task list. It shows task status, titles, metadata, diff summaries, the current environment filter, and scroll position.

**Data flow**: It reads App.tasks, App.selected, environment filter information, and overlay/loading flags. It turns each task into a list item, dims the list if a modal has focus, and may draw a centered loading spinner while tasks are refreshing.

**Call relations**: draw calls this when the user is not composing a new task. It uses render_task_item for each row and draw_centered_spinner when a refresh is in progress.

*Call graph*: calls 1 internal fn (draw_centered_spinner); called by 1 (draw); 12 external calls (default, Length, Min, default, from, new, default, default, format!, render_stateful_widget (+2 more)).


##### `draw_footer`  (lines 236–310)

```
fn draw_footer(frame: &mut Frame, area: Rect, app: &mut App)
```

**Purpose**: Draws the two-line footer at the bottom of the terminal. The footer tells the user which keys are useful right now and shows the latest status message.

**Data flow**: It reads App state such as open overlays, loading flags, new-task mode, attempt count, and status text. It builds a help line, shows or clears a small spinner area, sanitizes the status line, and writes both rows to the frame.

**Call relations**: draw calls this every frame after the main page. It calls draw_inline_spinner when any background operation is running, so the footer gives constant feedback.

*Call graph*: calls 1 internal fn (draw_inline_spinner); called by 1 (draw); 8 external calls (Fill, Length, default, from, new, format!, render_widget, vec!).


##### `draw_diff_overlay`  (lines 312–467)

```
fn draw_diff_overlay(frame: &mut Frame, area: Rect, app: &mut App)
```

**Purpose**: Draws the task details overlay, which can show a conversation, a code diff, failure details, and attempt-switching information. This is the main “open task” view.

**Data flow**: It reads the current diff overlay from App, decides whether the content is a diff, conversation, or error message, calculates scroll and viewport size, styles the visible lines, and either renders text or a loading spinner.

**Call relations**: draw calls this when app.diff_overlay is present. It uses the shared overlay helpers for shape, draw_centered_spinner while details load, and the conversation/diff styling helpers to make the content readable.

*Call graph*: calls 4 internal fn (draw_centered_spinner, overlay_block, overlay_content, overlay_outer); called by 1 (draw); 11 external calls (Length, Min, default, from, new, from, new, format!, matches!, render_widget (+1 more)).


##### `draw_apply_modal`  (lines 469–550)

```
fn draw_apply_modal(frame: &mut Frame, area: Rect, app: &mut App)
```

**Purpose**: Draws the confirmation and result dialog for applying a task’s changes. It tells the user whether they can apply, preflight-check, or cancel.

**Data flow**: It reads App.apply_modal and apply-related loading flags. It draws the title, instructions, a spinner while checking or applying, and then a result message with conflict or skipped file paths when available.

**Call relations**: draw calls this when an apply modal is open. It shares the overlay layout helpers and uses draw_centered_spinner for preflight, apply, and initial loading states.

*Call graph*: calls 4 internal fn (draw_centered_spinner, overlay_block, overlay_content, overlay_outer); called by 1 (draw); 10 external calls (Length, Min, default, from, new, new, format!, matches!, render_widget, vec!).


##### `style_conversation_lines`  (lines 558–652)

```
fn style_conversation_lines(
    sd: &crate::scrollable_diff::ScrollableDiff,
    attempt: Option<&AttemptView>,
) -> Vec<Line<'static>>
```

**Purpose**: Turns raw wrapped conversation text into styled terminal lines. It makes User and Assistant sections visually distinct and improves readability for code blocks, bullets, headings, and markdown-like text.

**Data flow**: It reads wrapped display lines, their original source-line indexes, and the current attempt. It tracks who is speaking, whether the text is inside a code block, and whether a bullet list is continuing, then outputs styled lines for display.

**Call relations**: The diff/details overlay uses this when the current view is a conversation rather than a diff. It delegates small pieces to conversation_header_line, conversation_gutter_span, conversation_text_spans, and attempt_status_span.

*Call graph*: calls 6 internal fn (raw_line_at, wrapped_lines, wrapped_src_indices, conversation_gutter_span, conversation_header_line, conversation_text_spans); 4 external calls (from, raw, new, new).


##### `conversation_header_line`  (lines 654–678)

```
fn conversation_header_line(
    speaker: ConversationSpeaker,
    attempt: Option<&AttemptView>,
) -> Line<'static>
```

**Purpose**: Creates the labeled header for a User prompt or Assistant response in the conversation view. For assistant messages, it can also include the attempt’s status.

**Data flow**: It receives the speaker and optionally an attempt. It builds styled text spans such as “User prompt” or “Assistant response,” adds a colored status when one is known, and returns one styled line.

**Call relations**: style_conversation_lines calls this whenever it sees a raw “user:” or “assistant:” marker. It calls attempt_status_span to translate an attempt status into a human-readable colored label.

*Call graph*: calls 1 internal fn (attempt_status_span); called by 1 (style_conversation_lines); 2 external calls (from, vec!).


##### `conversation_gutter_span`  (lines 680–685)

```
fn conversation_gutter_span(speaker: ConversationSpeaker) -> ratatui::text::Span<'static>
```

**Purpose**: Creates the small colored vertical marker shown beside each line of a conversation section. It helps the eye follow whether text belongs to the user or assistant.

**Data flow**: It receives the speaker and returns a short styled span, cyan for the user and magenta for the assistant.

**Call relations**: style_conversation_lines calls this for normal and blank lines after a speaker has been detected, so the conversation has a consistent left-side guide.

*Call graph*: called by 1 (style_conversation_lines).


##### `conversation_text_spans`  (lines 687–740)

```
fn conversation_text_spans(
    display: &str,
    in_code: bool,
    is_new_raw: bool,
    bullet_indent: Option<usize>,
) -> Vec<ratatui::text::Span<'static>>
```

**Purpose**: Styles one visible line of conversation text. It gives special treatment to code, bullet lists, headings, and simple markdown formatting.

**Data flow**: It receives the display text plus context flags: whether the line is inside code, whether it starts a new raw line, and whether it belongs to a bullet. It returns one or more styled spans ready to place in a terminal line.

**Call relations**: style_conversation_lines calls this after adding any speaker gutter. It hands ordinary text to render_markdown_text so lightweight markdown formatting can be reused.

*Call graph*: called by 1 (style_conversation_lines); 5 external calls (raw, new, new, render_markdown_text, vec!).


##### `attempt_status_span`  (lines 742–751)

```
fn attempt_status_span(status: AttemptStatus) -> Option<ratatui::text::Span<'static>>
```

**Purpose**: Converts an attempt status into a colored label for the conversation header. Unknown statuses are deliberately hidden.

**Data flow**: It receives an AttemptStatus value and returns either a styled word such as “Completed,” “Failed,” or “Pending,” or no value for Unknown.

**Call relations**: conversation_header_line calls this for assistant responses when an attempt is available, so users can see whether that attempt succeeded, failed, or is still running.

*Call graph*: called by 1 (conversation_header_line).


##### `style_diff_line`  (lines 753–786)

```
fn style_diff_line(raw: &str) -> Line<'static>
```

**Purpose**: Styles one line of a code diff so changes are easy to scan. Added lines become green, removed lines red, section headers magenta, and file headers dim.

**Data flow**: It receives a raw diff line, checks its prefix, and returns a styled terminal line with the appropriate color or emphasis.

**Call relations**: The diff overlay uses this when the active details view is a diff. It is the small rulebook that turns plain diff text into readable colored output.

*Call graph*: 2 external calls (from, vec!).


##### `render_task_item`  (lines 788–844)

```
fn render_task_item(_app: &App, t: &codex_cloud_tasks_client::TaskSummary) -> ListItem<'static>
```

**Purpose**: Builds the visible list entry for one cloud task. It summarizes status, title, environment, update time, and size of the change.

**Data flow**: It receives a task summary, reads its status, title, environment label, update time, and diff summary. It produces a multi-line ListItem with colored status and change counts, or “no diff” when there are no changes.

**Call relations**: draw_list calls this for every task before rendering the list. It also calls format_relative_time_now so timestamps appear as friendly relative times instead of raw dates.

*Call graph*: calls 1 internal fn (format_relative_time_now); 4 external calls (from, new, new, vec!).


##### `draw_inline_spinner`  (lines 846–863)

```
fn draw_inline_spinner(
    frame: &mut Frame,
    area: Rect,
    spinner_start: &mut Option<Instant>,
    label: &str,
)
```

**Purpose**: Draws a small one-line loading indicator with a blinking dot and label. It is used where space is tight, such as the footer.

**Data flow**: It receives a frame, target area, mutable spinner start time, and label. It initializes the start time if needed, uses elapsed time to choose a filled or hollow dot, and renders the label into the area.

**Call relations**: draw_footer calls this directly for footer loading feedback. draw_centered_spinner also calls it after first choosing a centered position.

*Call graph*: called by 2 (draw_centered_spinner, draw_footer); 4 external calls (from, new, render_widget, vec!).


##### `draw_centered_spinner`  (lines 865–889)

```
fn draw_centered_spinner(
    frame: &mut Frame,
    area: Rect,
    spinner_start: &mut Option<Instant>,
    label: &str,
)
```

**Purpose**: Draws the same loading indicator as draw_inline_spinner, but centered inside a larger rectangle. It is used for empty loading panels and modal bodies.

**Data flow**: It receives a frame, area, spinner timer, and label. It splits the area into rows and columns to find a centered one-line slot, then draws the inline spinner there.

**Call relations**: Task list, detail overlay, apply modal, and environment modal call this when their content is not ready yet. It delegates the actual spinner drawing to draw_inline_spinner.

*Call graph*: calls 1 internal fn (draw_inline_spinner); called by 4 (draw_apply_modal, draw_diff_overlay, draw_env_modal, draw_list); 3 external calls (Length, Percentage, default).


##### `draw_env_modal`  (lines 893–991)

```
fn draw_env_modal(frame: &mut Frame, area: Rect, app: &mut App)
```

**Purpose**: Draws the environment selection modal. It lets the user search environments and choose either a specific environment or the global “all environments” option.

**Data flow**: It reads environment loading state, the modal query and selected row, and the known environment list. It shows a loading spinner if needed, filters environments by case-insensitive search text, builds list rows with labels, IDs, pinned marks, and hints, then renders the selectable list.

**Call relations**: draw calls this when app.env_modal is present. It uses the shared overlay helpers for layout and draw_centered_spinner while environments are loading.

*Call graph*: calls 4 internal fn (draw_centered_spinner, overlay_block, overlay_content, overlay_outer); called by 1 (draw); 15 external calls (default, Length, Min, default, from, new, new, default, new, default (+5 more)).


##### `draw_best_of_modal`  (lines 993–1046)

```
fn draw_best_of_modal(frame: &mut Frame, area: Rect, app: &mut App)
```

**Purpose**: Draws the small modal for choosing how many parallel attempts a new task should run. The options are one through four attempts.

**Data flow**: It reads the current and selected attempt count from App, builds a compact centered dialog, marks the current choice, and renders a selectable list of attempt-count options.

**Call relations**: draw calls this when app.best_of_modal is present. It uses the same overlay styling helpers as the other modals, but further shrinks and centers the box so this simple choice does not take over the whole screen.

*Call graph*: calls 3 internal fn (overlay_block, overlay_content, overlay_outer); called by 1 (draw); 16 external calls (default, Length, Min, default, from, new, new, default, new, new (+6 more)).


### Transcript and navigation overlays
These files provide reusable overlay browsing plus the state and formatting logic behind transcript backtracking and multi-agent navigation flows.

### `tui/src/app/agent_navigation.rs`

`domain_logic` · `main loop and user interaction`

This file is the memory and rulebook for navigating multiple agent threads in the terminal user interface. A “thread” is one conversation or agent run, identified by a `ThreadId`. The main app discovers threads and decides which one is currently visible; this file keeps the quieter bookkeeping: what threads are known, what order they first appeared in, whether they are running or closed, and what text should be shown to users.

The important idea is stable spawn order. Once a thread is first seen, its id is placed in an order list and stays in that position. Later updates can change its nickname, role, path, or closed state, but not its place. This matters because keyboard navigation should feel like moving around a fixed carousel, not a list that reshuffles under the user.

The state is split into two parts: a map from thread id to the latest display details, and a list of thread ids in first-seen order. Most functions either update those two structures carefully or read them back as user-facing picker rows, footer labels, or adjacent thread ids. Closed threads are not automatically removed, so users can still inspect them and navigation remains predictable. A few tests at the bottom protect the main promises: updates preserve order, navigation wraps around, shortcut text stays accurate, and labels follow the currently displayed thread.

#### Function details

##### `AgentNavigationState::get`  (lines 63–65)

```
fn get(&self, thread_id: &ThreadId) -> Option<&AgentPickerThreadEntry>
```

**Purpose**: Looks up the cached display information for one thread. It is useful when another part of the app already knows the thread id and needs the latest nickname, role, path, or status for display.

**Data flow**: It receives a thread id reference, checks the internal thread map, and returns either the matching saved entry or nothing if that thread is not currently cached. It does not change any state.

**Call relations**: No internal caller is shown in the provided call facts. It is a read-only doorway for code outside this helper to inspect one known thread without rebuilding the whole picker list.


##### `AgentNavigationState::is_empty`  (lines 71–73)

```
fn is_empty(&self) -> bool
```

**Purpose**: Answers whether the navigation cache currently knows about any agent threads. The app can use this to decide whether to show an empty-picker message instead of a list.

**Data flow**: It reads the internal map of thread entries and returns true if that map has no entries, otherwise false. Nothing is modified.

**Call relations**: No internal caller is shown in the provided call facts. It serves as a quick check before code tries to show or populate the agent picker.


##### `AgentNavigationState::upsert`  (lines 80–105)

```
fn upsert(
        &mut self,
        thread_id: ThreadId,
        agent_nickname: Option<String>,
        agent_role: Option<String>,
        is_closed: bool,
    )
```

**Purpose**: Adds a new thread or refreshes an existing thread’s display details while keeping the original first-seen order. This is the main gatekeeper that prevents the picker order from changing just because metadata changed.

**Data flow**: It receives a thread id, optional nickname, optional role, and a closed/not-closed flag. If the thread is new, it appends the id to the order list. It keeps any previously known agent path and running state where appropriate, then stores a fresh picker entry in the map. The result is updated cached metadata with stable navigation order.

**Call relations**: Most updates can use this as the normal insert-or-update path. `AgentNavigationState::mark_closed` calls it when a thread is being closed but was not already known, so even that late-discovered thread gets a proper cached entry.

*Call graph*: called by 1 (mark_closed).


##### `AgentNavigationState::record_sub_agent_activity`  (lines 107–124)

```
fn record_sub_agent_activity(&mut self, activity: SubAgentActivityDisplay)
```

**Purpose**: Records activity reported by a sub-agent, especially its file or path information and whether it appears to be running. This lets agents discovered through activity still appear in the picker.

**Data flow**: It receives a `SubAgentActivityDisplay`, which includes a thread id, an agent path, and a running hint. If the thread is new, its id is added to the stable order list and a default entry is created. Then the entry’s path, running flag, and closed flag are updated so the picker reflects fresh activity.

**Call relations**: No internal caller is shown in the provided call facts. It complements `upsert`: instead of updating nickname and role, it updates activity-derived details such as path and running state.


##### `AgentNavigationState::set_running`  (lines 126–130)

```
fn set_running(&mut self, thread_id: ThreadId, is_running: bool)
```

**Purpose**: Changes the running/not-running status for a known thread. This gives the user interface a way to reflect that an agent has started or stopped without altering its name or position.

**Data flow**: It receives a thread id and a boolean running flag. If that thread exists in the map, it updates only the `is_running` field. If the thread is unknown, it leaves the state unchanged.

**Call relations**: No internal caller is shown in the provided call facts. It is a small targeted update used when only the activity status changes and the rest of the picker entry should stay as it is.


##### `AgentNavigationState::set_agent_path`  (lines 132–138)

```
fn set_agent_path(&mut self, thread_id: ThreadId, agent_path: Option<String>)
```

**Purpose**: Stores a path-like label for a known agent thread when a non-empty path is available. This path can later be used as a clearer label for sub-agents.

**Data flow**: It receives a thread id and an optional path string. If the path exists and the thread is already cached, it saves that path in the entry. If there is no path or no matching thread, nothing changes.

**Call relations**: No internal caller is shown in the provided call facts. It feeds later display functions, especially labels and filtered lists that care whether a sub-agent has a usable path.


##### `AgentNavigationState::mark_closed`  (lines 146–156)

```
fn mark_closed(&mut self, thread_id: ThreadId)
```

**Purpose**: Marks a thread as closed while keeping it in the picker and navigation order. This preserves the user’s ability to review old agent threads and keeps keyboard cycling stable.

**Data flow**: It receives a thread id. If the thread already exists, it sets `is_closed` to true and `is_running` to false. If the thread is not known yet, it creates a closed entry with no nickname or role by calling `AgentNavigationState::upsert`.

**Call relations**: This function calls `AgentNavigationState::upsert` only for the fallback case where a closing thread was not already cached. It is the safe closing path because it does not remove the thread from the stable order list.

*Call graph*: calls 1 internal fn (upsert).


##### `AgentNavigationState::clear`  (lines 162–165)

```
fn clear(&mut self)
```

**Purpose**: Resets all cached navigation state. This is used when the app needs to return the multi-agent picker to a fresh, empty session state.

**Data flow**: It takes the current map of thread entries and the order list, then empties both. Afterward there are no remembered threads, labels, statuses, or navigation positions.

**Call relations**: No internal caller is shown in the provided call facts. It is the teardown-style counterpart to the update functions: instead of preserving order, it deliberately forgets everything.


##### `AgentNavigationState::remove`  (lines 172–175)

```
fn remove(&mut self, thread_id: ThreadId)
```

**Purpose**: Completely removes one thread from both display metadata and navigation order. Unlike closing, this is for entries that should no longer appear at all, such as ghost rows discovered opportunistically.

**Data flow**: It receives a thread id, deletes that id from the thread map, and filters it out of the order list. The result is that future picker rows and navigation skips no longer include that thread.

**Call relations**: No internal caller is shown in the provided call facts. It is intentionally separate from `mark_closed`, because removing a thread changes the shape of navigation while closing keeps it visible.


##### `AgentNavigationState::has_non_primary_thread`  (lines 182–186)

```
fn has_non_primary_thread(&self, primary_thread_id: Option<ThreadId>) -> bool
```

**Purpose**: Checks whether there is at least one tracked thread besides the main thread. This helps the app decide whether existing sub-agent conversations should remain accessible.

**Data flow**: It receives the optional primary thread id, scans the cached thread ids, and returns true if any cached id is different from the primary one. It does not inspect or change the thread entries themselves.

**Call relations**: No internal caller is shown in the provided call facts. It supports higher-level UI decisions about whether multi-agent navigation is meaningful even when only some features are enabled.


##### `AgentNavigationState::ordered_threads`  (lines 193–198)

```
fn ordered_threads(&self) -> Vec<(ThreadId, &AgentPickerThreadEntry)>
```

**Purpose**: Builds the picker-ready list of known threads in the same stable order used for keyboard cycling. It is the central read path for anything that needs ordered thread entries.

**Data flow**: It walks the saved first-seen order list and, for each id, looks up the current metadata in the map. If an id is in the order list but missing from the map, it is skipped. The output is a vector of thread id plus entry references in display order.

**Call relations**: `AgentNavigationState::adjacent_thread_id`, `AgentNavigationState::ordered_path_backed_subagent_threads`, `AgentNavigationState::tracked_thread_ids`, and the test-only `AgentNavigationState::ordered_thread_ids` all call this function. It acts like the common sorting counter: callers ask for ordered data here instead of each re-creating the ordering rule.

*Call graph*: called by 4 (adjacent_thread_id, ordered_path_backed_subagent_threads, ordered_thread_ids, tracked_thread_ids).


##### `AgentNavigationState::ordered_path_backed_subagent_threads`  (lines 200–214)

```
fn ordered_path_backed_subagent_threads(
        &self,
        primary_thread_id: Option<ThreadId>,
    ) -> Vec<(ThreadId, &AgentPickerThreadEntry)>
```

**Purpose**: Returns only non-primary sub-agent threads that have a meaningful path saved. This is useful when the app needs threads that can be tied back to a concrete agent path.

**Data flow**: It receives the optional primary thread id, asks `AgentNavigationState::ordered_threads` for the stable ordered list, then filters out the primary thread and any entry with no path or a blank path. The result keeps the original order but contains only path-backed sub-agents.

**Call relations**: It depends on `AgentNavigationState::ordered_threads` for the canonical order, then narrows the list for a more specific use. No internal caller is shown in the provided call facts.

*Call graph*: calls 1 internal fn (ordered_threads).


##### `AgentNavigationState::tracked_thread_ids`  (lines 217–222)

```
fn tracked_thread_ids(&self) -> Vec<ThreadId>
```

**Purpose**: Returns just the ids of tracked threads in picker order. This is useful when code needs the identity list but not the full display metadata.

**Data flow**: It calls `AgentNavigationState::ordered_threads`, discards each entry’s metadata, and keeps only the thread ids. The output is a vector of ids in stable first-seen order.

**Call relations**: It relies on `AgentNavigationState::ordered_threads` so it inherits the same filtering and ordering behavior. No internal caller is shown in the provided call facts.

*Call graph*: calls 1 internal fn (ordered_threads).


##### `AgentNavigationState::adjacent_thread_id`  (lines 230–255)

```
fn adjacent_thread_id(
        &self,
        current_displayed_thread_id: Option<ThreadId>,
        direction: AgentNavigationDirection,
    ) -> Option<ThreadId>
```

**Purpose**: Finds the next or previous thread to show when the user presses an agent navigation shortcut. It wraps around at the ends, like moving around a circular list.

**Data flow**: It receives the currently displayed thread id and a direction. It builds the ordered thread list, refuses to navigate if there are fewer than two threads, finds the current thread’s position, moves one slot forward or backward with wraparound, and returns the neighboring thread id. If the current thread is missing or unknown, it returns nothing.

**Call relations**: It calls `AgentNavigationState::ordered_threads` to use the same order as the picker. The test `tests::adjacent_thread_id_wraps_in_spawn_order` exercises this behavior, checking both forward and backward wraparound.

*Call graph*: calls 1 internal fn (ordered_threads).


##### `AgentNavigationState::active_agent_label`  (lines 263–298)

```
fn active_agent_label(
        &self,
        current_displayed_thread_id: Option<ThreadId>,
        primary_thread_id: Option<ThreadId>,
    ) -> Option<String>
```

**Purpose**: Creates the short footer label for the thread currently being watched. It avoids showing a label when there is only one thread, because that would waste space saying something obvious.

**Data flow**: It receives the currently displayed thread id and optional primary thread id. If there is only one cached thread or no current thread, it returns nothing. Otherwise it decides whether the thread is primary, prefers a non-blank agent path for non-primary agents, and falls back to the shared picker naming rules using nickname, role, and primary status.

**Call relations**: No internal caller is shown in the provided call facts. The test `tests::active_agent_label_tracks_current_thread` checks that the label follows the displayed thread and formats both sub-agent and main-thread labels correctly.


##### `AgentNavigationState::picker_subtitle`  (lines 304–311)

```
fn picker_subtitle() -> String
```

**Purpose**: Builds the help text shown under the `/agent` picker title, including the real keyboard shortcuts for previous and next. This keeps the on-screen instructions matched to the actual key bindings.

**Data flow**: It asks `previous_agent_shortcut` and `next_agent_shortcut` for the current shortcut labels, converts them into text spans, and formats a sentence such as selecting an agent and using previous/next. It returns that sentence as a string.

**Call relations**: It calls `previous_agent_shortcut`, `next_agent_shortcut`, and formatting. It is called by `open_agent_picker` in the app flow and by the test `tests::picker_subtitle_mentions_shortcuts`, which verifies that the subtitle contains both shortcut labels.

*Call graph*: calls 2 internal fn (next_agent_shortcut, previous_agent_shortcut); called by 2 (picker_subtitle_mentions_shortcuts, open_agent_picker); 1 external calls (format!).


##### `AgentNavigationState::ordered_thread_ids`  (lines 318–323)

```
fn ordered_thread_ids(&self) -> Vec<ThreadId>
```

**Purpose**: Provides a test-only shortcut for reading the ordered thread ids without full entry details. It exists to make ordering tests simple and focused.

**Data flow**: It calls `AgentNavigationState::ordered_threads`, drops the metadata, and returns only the thread ids. It does not change the state.

**Call relations**: It calls `AgentNavigationState::ordered_threads`, so tests check the same ordering path used by real navigation. It is used by `tests::upsert_preserves_first_seen_order` to confirm that updates do not reshuffle entries.

*Call graph*: calls 1 internal fn (ordered_threads).


##### `tests::populated_state`  (lines 331–360)

```
fn populated_state() -> (AgentNavigationState, ThreadId, ThreadId, ThreadId)
```

**Purpose**: Creates a small sample navigation state for tests: one main thread and two agent threads. This avoids repeating setup code in each test.

**Data flow**: It starts from a default empty `AgentNavigationState`, creates three fixed thread ids using `from_string`, inserts them with names and roles through `upsert`, and returns the populated state plus the three ids. The output gives tests a predictable mini-world to inspect.

**Call relations**: It calls `from_string` and default construction. The tests `tests::upsert_preserves_first_seen_order`, `tests::adjacent_thread_id_wraps_in_spawn_order`, and `tests::active_agent_label_tracks_current_thread` call it when they need consistent starting data.

*Call graph*: calls 1 internal fn (from_string); 1 external calls (default).


##### `tests::upsert_preserves_first_seen_order`  (lines 363–377)

```
fn upsert_preserves_first_seen_order()
```

**Purpose**: Checks that updating an existing thread does not move it in the navigation order. This protects the core promise that picker order follows first discovery, not the latest update.

**Data flow**: It gets a prefilled state from `tests::populated_state`, updates the first agent with changed role and closed status, then reads the ordered ids and compares them with the original expected order. The state is allowed to change metadata, but the id order must stay the same.

**Call relations**: It calls `tests::populated_state` and uses an assertion macro. It indirectly validates `AgentNavigationState::upsert` and the test-only `AgentNavigationState::ordered_thread_ids` path.

*Call graph*: 2 external calls (assert_eq!, populated_state).


##### `tests::adjacent_thread_id_wraps_in_spawn_order`  (lines 380–395)

```
fn adjacent_thread_id_wraps_in_spawn_order()
```

**Purpose**: Checks that next and previous navigation move through threads in spawn order and wrap around at the ends. This guards the carousel-like behavior users expect from keyboard shortcuts.

**Data flow**: It builds a sample state, asks for the next thread after the last agent, the previous thread before that same agent, and the previous thread before the main thread. Each returned id is compared with the expected neighbor.

**Call relations**: It calls `tests::populated_state` and assertion macros. It directly exercises `AgentNavigationState::adjacent_thread_id`, which itself uses `AgentNavigationState::ordered_threads`.

*Call graph*: 2 external calls (assert_eq!, populated_state).


##### `tests::picker_subtitle_mentions_shortcuts`  (lines 398–405)

```
fn picker_subtitle_mentions_shortcuts()
```

**Purpose**: Checks that the picker subtitle includes the actual previous and next shortcut text. This helps prevent the help text from drifting away from the real key bindings.

**Data flow**: It asks the shortcut helpers for the current previous and next labels, builds the subtitle with `AgentNavigationState::picker_subtitle`, and asserts that both labels appear in the returned string.

**Call relations**: It calls `AgentNavigationState::picker_subtitle`, `previous_agent_shortcut`, `next_agent_shortcut`, and assertion macros. It verifies the same subtitle function that `open_agent_picker` uses in the app.

*Call graph*: calls 3 internal fn (picker_subtitle, next_agent_shortcut, previous_agent_shortcut); 1 external calls (assert!).


##### `tests::active_agent_label_tracks_current_thread`  (lines 408–419)

```
fn active_agent_label_tracks_current_thread()
```

**Purpose**: Checks that the footer label is based on the thread currently displayed, not merely on some other active bookkeeping. This protects users from seeing the wrong agent name in the footer.

**Data flow**: It creates a sample state, asks for the label of a named sub-agent while the main thread is primary, and then asks for the label of the main thread. It compares both results with the expected display strings.

**Call relations**: It calls `tests::populated_state` and assertion macros. It directly validates `AgentNavigationState::active_agent_label` for both sub-agent and primary-thread cases.

*Call graph*: 2 external calls (assert_eq!, populated_state).


### `tui/src/app_backtrack.rs`

`orchestration` · `main loop and request handling`

This file exists so the chat interface can safely rewind a conversation without the screen and the real agent state drifting apart. The user-facing idea is simple: press Esc to arm backtracking, open the transcript, choose an earlier user message, and press Enter to edit from there. Behind the scenes, this is treated carefully. The app first records which thread is being edited, then sends a rollback request to the core system. It only cuts local transcript history after the core confirms the rollback worked. That is like waiting for the librarian to confirm a page was removed before updating your table of contents.

The file also owns how the transcript overlay behaves while backtracking. It highlights the selected user message, moves the highlight backward or forward, closes the overlay when needed, and restores the prompt text, text elements, and attached images into the composer. It blocks side conversations from editing earlier prompts, because rolling back the main thread from a side thread would be unsafe.

A second important job is rendering. The transcript overlay normally shows committed transcript cells, but the current assistant/tool output may still be “live” and not yet stored as history. During draw events, this file asks the chat widget for that live tail and temporarily appends it for display, so the overlay does not look stale while work is still streaming.

#### Function details

##### `App::handle_backtrack_overlay_event`  (lines 113–171)

```
async fn handle_backtrack_overlay_event(
        &mut self,
        tui: &mut tui::Tui,
        event: TuiEvent,
    ) -> Result<bool>
```

**Purpose**: Routes keyboard and draw events while the transcript overlay is open. If backtrack preview mode is active, it turns Esc, Left, Right, and Enter into selection or confirmation actions; otherwise it lets the overlay behave normally, except Esc starts preview mode.

**Data flow**: It receives the terminal object and one UI event. It checks whether backtrack preview is active, interprets special keys, and either updates the selected message, confirms the rollback choice, starts preview mode, or forwards the event to the overlay. It returns whether the event was consumed, wrapped in a result in case overlay drawing or event handling fails.

**Call relations**: This is the overlay-side dispatcher. It calls the preview starter, step functions, confirmation function, or normal overlay forwarding function depending on what the user pressed.

*Call graph*: calls 5 internal fn (begin_overlay_backtrack_preview, overlay_confirm_backtrack, overlay_forward_event, overlay_step_backtrack, overlay_step_backtrack_forward).


##### `App::handle_backtrack_esc_key`  (lines 174–186)

```
fn handle_backtrack_esc_key(&mut self, tui: &mut tui::Tui)
```

**Purpose**: Handles Esc presses from the main chat view when no overlay action has already taken over. It primes backtracking on the first Esc and opens or advances the backtrack preview on later Esc presses.

**Data flow**: It reads whether the composer is empty, whether backtracking is already primed, whether an overlay is open, and whether preview mode is active. If the composer has text, it does nothing. Otherwise it updates backtrack state or opens/steps the transcript preview.

**Call relations**: This is the main-view entry point for the backtrack key flow. It calls `prime_backtrack`, `open_backtrack_preview`, or `step_backtrack_and_highlight` as the user repeats Esc.

*Call graph*: calls 3 internal fn (open_backtrack_preview, prime_backtrack, step_backtrack_and_highlight).


##### `App::apply_backtrack_rollback`  (lines 195–240)

```
fn apply_backtrack_rollback(&mut self, selection: BacktrackSelection)
```

**Purpose**: Turns a chosen earlier user message into a rollback request sent to the core conversation engine. It also pre-fills the composer right away so the user can edit the old prompt while waiting for confirmation.

**Data flow**: It receives a `BacktrackSelection` containing the chosen message and attachments. It checks for side conversations, counts user turns, refuses duplicate rollback requests, calculates how many turns must be removed, records a pending rollback guard, sends the rollback command, and restores the selected prompt content into the composer. It changes app state and does not return a value.

**Call relations**: This is called after a selection is confirmed from the overlay, from a direct selection helper, or when a cancelled edit needs rollback behavior. It uses `user_count` to compute rollback depth and calls `reset_backtrack_state` when side conversations make rollback unavailable.

*Call graph*: calls 2 internal fn (reset_backtrack_state, user_count); called by 3 (apply_backtrack_selection, apply_cancelled_turn_edit, overlay_confirm_backtrack); 2 external calls (thread_rollback, try_from).


##### `App::apply_cancelled_turn_edit`  (lines 242–272)

```
fn apply_cancelled_turn_edit(&mut self, prompt: UserMessage)
```

**Purpose**: Restores a cancelled user turn into the composer and asks the core to roll back the matching turn. This covers the special case where the edit was cancelled but the user’s prompt should be recovered.

**Data flow**: It receives a `UserMessage` with text and image information. It builds a `BacktrackSelection` for the latest user message, counts existing user turns, and either sends a one-turn rollback directly for an empty transcript or delegates to the normal rollback path. It then restores the original user message to the composer.

**Call relations**: This function feeds into `apply_backtrack_rollback` for the usual case. When there are no counted user turns, it sends the rollback command itself and records the same pending rollback guard.

*Call graph*: calls 2 internal fn (apply_backtrack_rollback, user_count); 1 external calls (thread_rollback).


##### `App::open_transcript_overlay`  (lines 275–282)

```
fn open_transcript_overlay(&mut self, tui: &mut tui::Tui)
```

**Purpose**: Opens the full transcript overlay so the user can browse history or choose a backtrack target. It switches the terminal into an alternate screen so the overlay can take over the display.

**Data flow**: It receives the terminal object, enters alternate-screen mode, creates a transcript overlay from the current transcript cells and pager keymap, stores it on the app, and requests a redraw.

**Call relations**: This is called by `open_backtrack_preview` when the main-view Esc flow needs to show the transcript and begin highlighting messages.

*Call graph*: calls 1 internal fn (new_transcript); called by 1 (open_backtrack_preview); 2 external calls (enter_alt_screen, frame_requester).


##### `App::close_transcript_overlay`  (lines 285–302)

```
fn close_transcript_overlay(&mut self, tui: &mut tui::Tui)
```

**Purpose**: Closes the transcript overlay and restores the normal chat screen. If the overlay was used for backtracking, it also clears the backtrack state so stale selections do not linger.

**Data flow**: It receives the terminal object, leaves alternate-screen mode, flushes any deferred history lines back into the normal history area, clears the overlay, turns off preview mode, schedules a redraw, and optionally resets backtrack state.

**Call relations**: This is used by preview startup when there is no valid target, by confirmation after Enter, and by overlay forwarding when the overlay reports it is done.

*Call graph*: calls 1 internal fn (reset_backtrack_state); called by 3 (begin_overlay_backtrack_preview, overlay_confirm_backtrack, overlay_forward_event); 4 external calls (frame_requester, insert_history_hyperlink_lines_with_wrap_policy, leave_alt_screen, take).


##### `App::prime_backtrack`  (lines 305–312)

```
fn prime_backtrack(&mut self)
```

**Purpose**: Starts the first stage of backtracking from the main view. It records the current thread as the only valid rollback target and shows a hint if there is a previous user message to edit.

**Data flow**: It reads the current thread id and transcript cells. It marks backtracking as primed, clears the current selection to “none,” stores the base thread id, and may ask the chat widget to show an Esc-backtrack hint.

**Call relations**: This is called by `handle_backtrack_esc_key` on the first Esc press. It uses `has_backtrack_target` to decide whether a useful hint should appear.

*Call graph*: calls 1 internal fn (has_backtrack_target); called by 1 (handle_backtrack_esc_key).


##### `App::open_backtrack_preview`  (lines 315–329)

```
fn open_backtrack_preview(&mut self, tui: &mut tui::Tui)
```

**Purpose**: Opens the transcript overlay directly into backtrack preview mode. If there is no previous user message, it tells the user that editing is unavailable instead of opening an empty preview.

**Data flow**: It checks the transcript for at least one user message. If none exists, it resets backtrack state, shows an informational message, and redraws. If a target exists, it opens the transcript overlay, marks preview mode active, clears the composer hint, selects the latest user message, and requests a redraw.

**Call relations**: This is called from the main Esc handler after backtracking has already been primed. It relies on `open_transcript_overlay`, `step_backtrack_and_highlight`, `reset_backtrack_state`, and `has_backtrack_target`.

*Call graph*: calls 4 internal fn (open_transcript_overlay, reset_backtrack_state, step_backtrack_and_highlight, has_backtrack_target); called by 1 (handle_backtrack_esc_key); 1 external calls (frame_requester).


##### `App::begin_overlay_backtrack_preview`  (lines 332–349)

```
fn begin_overlay_backtrack_preview(&mut self, tui: &mut tui::Tui)
```

**Purpose**: Starts backtrack preview while the transcript overlay is already open. This lets a user press Esc inside the transcript overlay to begin selecting an earlier prompt.

**Data flow**: It checks whether the transcript has a user message. If not, it closes the overlay and shows a no-target message. If yes, it primes backtracking for the current thread, turns on overlay preview mode, selects the latest user message, and schedules a redraw.

**Call relations**: This is called by `handle_backtrack_overlay_event` when Esc is pressed in the overlay before preview mode is active. It uses `user_count` and `apply_backtrack_selection_internal` to highlight the newest selectable prompt.

*Call graph*: calls 4 internal fn (apply_backtrack_selection_internal, close_transcript_overlay, has_backtrack_target, user_count); called by 1 (handle_backtrack_overlay_event); 1 external calls (frame_requester).


##### `App::step_backtrack_and_highlight`  (lines 352–372)

```
fn step_backtrack_and_highlight(&mut self, tui: &mut tui::Tui)
```

**Purpose**: Moves the backtrack selection to the next older user message and updates the overlay highlight. Repeated Esc or Left presses use this to walk backward through prompts.

**Data flow**: It counts user messages in the transcript. If there are none, it does nothing. Otherwise it computes the previous selectable index, stores it through the internal selection helper, and asks for a redraw.

**Call relations**: This is called from the main Esc flow, when opening preview, and from overlay backtracking. It delegates the actual highlight update to `apply_backtrack_selection_internal`.

*Call graph*: calls 2 internal fn (apply_backtrack_selection_internal, user_count); called by 3 (handle_backtrack_esc_key, open_backtrack_preview, overlay_step_backtrack); 1 external calls (frame_requester).


##### `App::step_forward_backtrack_and_highlight`  (lines 375–393)

```
fn step_forward_backtrack_and_highlight(&mut self, tui: &mut tui::Tui)
```

**Purpose**: Moves the backtrack selection to the next newer user message and updates the overlay highlight. It is the forward counterpart to stepping backward.

**Data flow**: It counts user messages, calculates the next newer selection without going past the latest user message, applies that selection internally, and schedules a redraw. With no user messages, it leaves state unchanged.

**Call relations**: This is called by `overlay_step_backtrack_forward` when the user presses Right during preview mode.

*Call graph*: calls 2 internal fn (apply_backtrack_selection_internal, user_count); called by 1 (overlay_step_backtrack_forward); 1 external calls (frame_requester).


##### `App::apply_backtrack_selection_internal`  (lines 396–408)

```
fn apply_backtrack_selection_internal(&mut self, nth_user_message: usize)
```

**Purpose**: Applies a selected user-message number to the app state and transcript overlay. It converts “the third user message” into the actual transcript cell that should be highlighted.

**Data flow**: It receives a user-message index. It looks up the matching cell position in the transcript. If found, it stores that index as the current selection and tells the transcript overlay to highlight the cell. If not found, it clears both the selection and the highlight.

**Call relations**: This helper is used by preview startup, backward and forward stepping, and overlay resynchronization after transcript trimming. It depends on `nth_user_position` for the filtered lookup.

*Call graph*: calls 1 internal fn (nth_user_position); called by 4 (begin_overlay_backtrack_preview, step_backtrack_and_highlight, step_forward_backtrack_and_highlight, sync_overlay_after_transcript_trim).


##### `App::overlay_forward_event`  (lines 423–459)

```
fn overlay_forward_event(&mut self, tui: &mut tui::Tui, event: TuiEvent) -> Result<()>
```

**Purpose**: Passes events to the overlay when backtracking does not need to intercept them, and closes the overlay if it finishes. For draw and resize events, it also adds the currently live chat output to the transcript overlay before rendering.

**Data flow**: It receives the terminal object and one UI event. For transcript draw or resize events, it asks the chat widget for the active-cell cache key and display lines, syncs that live tail into the overlay, draws it, and schedules animation frames if needed. For other events, it forwards them to the overlay. If the overlay says it is done, it closes it and requests a redraw.

**Call relations**: This is called by the overlay event router and by backtrack step functions when they decide an event should behave like a normal overlay event. It calls `close_transcript_overlay` when the overlay lifecycle ends.

*Call graph*: calls 1 internal fn (close_transcript_overlay); called by 3 (handle_backtrack_overlay_event, overlay_step_backtrack, overlay_step_backtrack_forward); 4 external calls (draw, frame_requester, matches!, from_millis).


##### `App::overlay_confirm_backtrack`  (lines 462–470)

```
fn overlay_confirm_backtrack(&mut self, tui: &mut tui::Tui)
```

**Purpose**: Confirms the currently highlighted backtrack choice from the transcript overlay. It closes the overlay and starts the rollback request if the selection is still valid.

**Data flow**: It reads the selected user-message number, turns it into a `BacktrackSelection`, closes the overlay, and, if a valid selection exists, applies the rollback and schedules a redraw.

**Call relations**: This is called by `handle_backtrack_overlay_event` on Enter during preview mode. It uses `backtrack_selection` to build the rollback input and `apply_backtrack_rollback` to send the request.

*Call graph*: calls 3 internal fn (apply_backtrack_rollback, backtrack_selection, close_transcript_overlay); called by 1 (handle_backtrack_overlay_event); 1 external calls (frame_requester).


##### `App::overlay_step_backtrack`  (lines 473–480)

```
fn overlay_step_backtrack(&mut self, tui: &mut tui::Tui, event: TuiEvent) -> Result<()>
```

**Purpose**: Handles Esc or Left while overlay backtrack preview is active. If backtracking is properly armed, it moves to an older message; otherwise it lets the overlay process the event normally.

**Data flow**: It checks whether a base thread id has been recorded. With one present, it steps the selection backward and highlights it. Without one, it forwards the event to the overlay. It returns a result in case forwarding fails.

**Call relations**: This is called by the overlay event router for Esc and Left. It chooses between `step_backtrack_and_highlight` and `overlay_forward_event`.

*Call graph*: calls 2 internal fn (overlay_forward_event, step_backtrack_and_highlight); called by 1 (handle_backtrack_overlay_event).


##### `App::overlay_step_backtrack_forward`  (lines 483–494)

```
fn overlay_step_backtrack_forward(
        &mut self,
        tui: &mut tui::Tui,
        event: TuiEvent,
    ) -> Result<()>
```

**Purpose**: Handles Right while overlay backtrack preview is active. If backtracking is armed, it moves the selection toward newer messages; otherwise it treats Right as a normal overlay event.

**Data flow**: It checks for a stored base thread id. If present, it advances the selected user message and redraws. If absent, it forwards the event to the overlay. It returns a result for possible overlay errors.

**Call relations**: This is called by `handle_backtrack_overlay_event` on Right. It chooses between `step_forward_backtrack_and_highlight` and `overlay_forward_event`.

*Call graph*: calls 2 internal fn (overlay_forward_event, step_forward_backtrack_and_highlight); called by 1 (handle_backtrack_overlay_event).


##### `App::confirm_backtrack_from_main`  (lines 498–502)

```
fn confirm_backtrack_from_main(&mut self) -> Option<BacktrackSelection>
```

**Purpose**: Confirms a backtrack selection when the confirmation comes from the main view instead of the overlay. It returns the selection to the caller and clears the temporary backtrack state.

**Data flow**: It reads the current selected user-message number, tries to build a `BacktrackSelection`, resets the backtrack state, and returns either that selection or nothing.

**Call relations**: This calls `backtrack_selection` to gather prompt data, then `reset_backtrack_state` so the caller can decide what to do next without leaving the app in preview mode.

*Call graph*: calls 2 internal fn (backtrack_selection, reset_backtrack_state).


##### `App::reset_backtrack_state`  (lines 505–511)

```
fn reset_backtrack_state(&mut self)
```

**Purpose**: Clears all temporary backtrack state. This prevents old thread ids, old selections, or old hints from affecting later user actions.

**Data flow**: It sets the primed flag to false, removes the base thread id, resets the selected message index to “none,” and clears the Esc-backtrack hint from the chat widget.

**Call relations**: This is used after failed or unavailable flows, when closing a backtrack overlay, and after main-view confirmation. It is also called by rollback application when side conversations make editing previous prompts unsafe.

*Call graph*: called by 4 (apply_backtrack_rollback, close_transcript_overlay, confirm_backtrack_from_main, open_backtrack_preview).


##### `App::apply_backtrack_selection`  (lines 513–520)

```
fn apply_backtrack_selection(
        &mut self,
        tui: &mut tui::Tui,
        selection: BacktrackSelection,
    )
```

**Purpose**: Applies a backtrack selection and immediately asks the UI to redraw. It is a small convenience wrapper for callers that already have a completed selection.

**Data flow**: It receives the terminal object and a `BacktrackSelection`, sends the selection through the normal rollback path, and schedules a new frame.

**Call relations**: This delegates the real work to `apply_backtrack_rollback`. It adds the UI refresh step that an event handler usually needs afterward.

*Call graph*: calls 1 internal fn (apply_backtrack_rollback); 1 external calls (frame_requester).


##### `App::handle_backtrack_rollback_succeeded`  (lines 522–529)

```
fn handle_backtrack_rollback_succeeded(&mut self, num_turns: u32)
```

**Purpose**: Responds when the core system reports that a rollback succeeded. It decides whether this success belongs to this app’s own pending backtrack request or should be applied as a general thread rollback event.

**Data flow**: It receives the number of turns rolled back. If a pending backtrack exists, it finishes that pending local trim. If not, it sends an app event asking the normal event queue to apply the rollback in order.

**Call relations**: This is part of the confirmation boundary between the UI and the core system. It calls `finish_pending_backtrack` for guarded backtrack requests; otherwise it hands work to the app event channel.

*Call graph*: calls 1 internal fn (finish_pending_backtrack).


##### `App::handle_backtrack_rollback_failed`  (lines 531–533)

```
fn handle_backtrack_rollback_failed(&mut self)
```

**Purpose**: Clears the pending rollback guard after the core reports failure. This lets the user try another backtrack request later.

**Data flow**: It reads no extra input and simply removes the stored pending rollback. The transcript is not trimmed because the core did not confirm success.

**Call relations**: This is the failure counterpart to `handle_backtrack_rollback_succeeded`. It does not call other helpers because the safe response is just to unlock future rollback attempts.


##### `App::apply_non_pending_thread_rollback`  (lines 539–550)

```
fn apply_non_pending_thread_rollback(&mut self, num_turns: u32) -> bool
```

**Purpose**: Applies a confirmed rollback that was not started by this TUI’s backtrack preview. It trims the local transcript by a number of user turns and cleans up related chat UI state.

**Data flow**: It receives a count of user turns to remove. It trims transcript cells from the end according to that count. If anything changed, it clears stale token/rate-limit hints, truncates copied-agent history to match the remaining user turns, syncs the overlay, marks rendering as pending, and returns true. If nothing changed, it returns false.

**Call relations**: This is used when rollback success arrives without a matching pending backtrack guard. It calls `trim_transcript_cells_drop_last_n_user_turns`, `user_count`, and `sync_overlay_after_transcript_trim`.

*Call graph*: calls 3 internal fn (sync_overlay_after_transcript_trim, trim_transcript_cells_drop_last_n_user_turns, user_count).


##### `App::finish_pending_backtrack`  (lines 556–575)

```
fn finish_pending_backtrack(&mut self)
```

**Purpose**: Completes a rollback that this UI requested through backtracking. It only trims local history if the confirmation still matches the active thread.

**Data flow**: It takes the stored pending rollback, compares its thread id with the current chat thread, and stops if they differ. If they match, it trims transcript cells up to the selected user message, clears stale chat-widget refresh state, truncates copied-agent history, syncs any open overlay, and marks rendering as pending.

**Call relations**: This is called by `handle_backtrack_rollback_succeeded`. It uses `trim_transcript_cells_to_nth_user` to make the local transcript match the selected rollback point.

*Call graph*: calls 3 internal fn (sync_overlay_after_transcript_trim, trim_transcript_cells_to_nth_user, user_count); called by 1 (handle_backtrack_rollback_succeeded).


##### `App::backtrack_selection`  (lines 577–604)

```
fn backtrack_selection(&self, nth_user_message: usize) -> Option<BacktrackSelection>
```

**Purpose**: Builds the full rollback selection for a chosen user-message number. It gathers the original prompt text and attachments so they can be put back into the composer.

**Data flow**: It receives a user-message index. It first checks that the current thread still matches the thread recorded when backtracking began. Then it finds the matching user history cell and copies its message text, text elements, local image paths, and remote image URLs. It returns a `BacktrackSelection`, or nothing if the thread check fails.

**Call relations**: This is called by overlay confirmation and main-view confirmation. It uses `nth_user_position` to find the right transcript cell.

*Call graph*: calls 1 internal fn (nth_user_position); called by 2 (confirm_backtrack_from_main, overlay_confirm_backtrack).


##### `App::sync_overlay_after_transcript_trim`  (lines 613–631)

```
fn sync_overlay_after_transcript_trim(&mut self)
```

**Purpose**: Keeps the transcript overlay and related buffered output consistent after history has been cut. Without this, the overlay could still show removed messages.

**Data flow**: It replaces overlay transcript cells with the trimmed transcript if the overlay is open. If preview mode is active, it clamps the selected user-message index to what still exists and reapplies the highlight. It also clears deferred history lines that may refer to removed cells.

**Call relations**: This is called after both pending and non-pending rollback trims. It uses `user_count` and `apply_backtrack_selection_internal` to repair the highlighted selection.

*Call graph*: calls 2 internal fn (apply_backtrack_selection_internal, user_count); called by 2 (apply_non_pending_thread_rollback, finish_pending_backtrack).


##### `trim_transcript_cells_to_nth_user`  (lines 634–648)

```
fn trim_transcript_cells_to_nth_user(
    transcript_cells: &mut Vec<Arc<dyn crate::history_cell::HistoryCell>>,
    nth_user_message: usize,
) -> bool
```

**Purpose**: Cuts transcript history just before a chosen user message. This is used after a confirmed backtrack so the selected old prompt and everything after it disappear from local history.

**Data flow**: It receives the mutable transcript cell list and a user-message index. If the index is invalid, it does nothing. Otherwise it finds that user message’s cell position, truncates the list before that position, and returns whether the list actually changed.

**Call relations**: This is called by `finish_pending_backtrack` and by tests that verify rollback trimming behavior. It relies on `nth_user_position` for the filtered user-message lookup.

*Call graph*: calls 1 internal fn (nth_user_position); called by 4 (finish_pending_backtrack, trim_transcript_for_first_user_drops_user_and_newer_cells, trim_transcript_for_later_user_keeps_prior_history, trim_transcript_preserves_cells_before_selected_user).


##### `trim_transcript_cells_drop_last_n_user_turns`  (lines 650–672)

```
fn trim_transcript_cells_drop_last_n_user_turns(
    transcript_cells: &mut Vec<Arc<dyn crate::history_cell::HistoryCell>>,
    num_turns: u32,
) -> bool
```

**Purpose**: Cuts transcript history by dropping the last N user turns. This supports rollback confirmations that arrive as a turn count rather than as a specific selected prompt.

**Data flow**: It receives the mutable transcript cell list and a number of user turns. If the number is zero or there are no user messages, it does nothing. Otherwise it finds all user-message positions since the latest session start, chooses the cut point, truncates the transcript, and returns whether anything was removed.

**Call relations**: This is called by `apply_non_pending_thread_rollback` and by tests. It uses `user_positions_iter` to understand where user turns begin.

*Call graph*: calls 1 internal fn (user_positions_iter); called by 3 (apply_non_pending_thread_rollback, trim_drop_last_n_user_turns_allows_overflow, trim_drop_last_n_user_turns_applies_rollback_semantics); 1 external calls (try_from).


##### `user_count`  (lines 674–676)

```
fn user_count(cells: &[Arc<dyn crate::history_cell::HistoryCell>]) -> usize
```

**Purpose**: Counts user messages in the current session portion of the transcript. It ignores anything before the most recent session-start marker.

**Data flow**: It receives a slice of transcript cells, walks the user positions found by `user_positions_iter`, and returns the count.

**Call relations**: Many backtrack functions use this to decide whether backtracking is possible, how far selection can move, and how much copied-agent history should remain after trimming.

*Call graph*: calls 1 internal fn (user_positions_iter); called by 10 (backtrack_selection_with_duplicate_history_targets_unique_turn, apply_backtrack_rollback, apply_cancelled_turn_edit, apply_non_pending_thread_rollback, begin_overlay_backtrack_preview, finish_pending_backtrack, step_backtrack_and_highlight, step_forward_backtrack_and_highlight, sync_overlay_after_transcript_trim, has_backtrack_target).


##### `has_backtrack_target`  (lines 678–680)

```
fn has_backtrack_target(cells: &[Arc<dyn crate::history_cell::HistoryCell>]) -> bool
```

**Purpose**: Answers the simple question: is there any user message that can be selected for backtracking? It is used before showing hints or opening preview mode.

**Data flow**: It receives transcript cells, counts the current-session user messages, and returns true if the count is greater than zero.

**Call relations**: This is called when priming backtrack, opening backtrack preview, and starting preview from an already-open overlay.

*Call graph*: calls 1 internal fn (user_count); called by 3 (begin_overlay_backtrack_preview, open_backtrack_preview, prime_backtrack).


##### `nth_user_position`  (lines 682–689)

```
fn nth_user_position(
    cells: &[Arc<dyn crate::history_cell::HistoryCell>],
    nth: usize,
) -> Option<usize>
```

**Purpose**: Finds the transcript cell position for the Nth user message in the current session. This bridges the user-facing selection number and the raw transcript list index.

**Data flow**: It receives transcript cells and a zero-based user-message number. It walks the filtered user-message positions and returns the matching cell index if one exists.

**Call relations**: This helper is used when highlighting selections, building rollback selections, and trimming to a selected user message.

*Call graph*: calls 1 internal fn (user_positions_iter); called by 3 (apply_backtrack_selection_internal, backtrack_selection, trim_transcript_cells_to_nth_user).


##### `user_positions_iter`  (lines 691–708)

```
fn user_positions_iter(
    cells: &[Arc<dyn crate::history_cell::HistoryCell>],
) -> impl Iterator<Item = usize> + '_
```

**Purpose**: Produces the transcript indexes of user messages after the most recent session-start marker. This is the shared definition of which user messages count for backtracking.

**Data flow**: It receives transcript cells, finds the latest `SessionInfoCell`, starts after it, and yields indexes whose cells are `UserHistoryCell` values.

**Call relations**: This iterator feeds `user_count`, `nth_user_position`, and turn-count trimming. It keeps all those operations using the same current-session boundary.

*Call graph*: called by 3 (nth_user_position, trim_transcript_cells_drop_last_n_user_turns, user_count).


##### `agent_group_count`  (lines 711–713)

```
fn agent_group_count(cells: &[Arc<dyn crate::history_cell::HistoryCell>]) -> usize
```

**Purpose**: Counts agent message groups in tests. It helps verify that special informational cells do not get mistaken for assistant output groups.

**Data flow**: It receives transcript cells, counts positions yielded by `agent_group_positions_iter`, and returns the total.

**Call relations**: This test-only helper is used by the agent-group test. It delegates the actual filtering rules to `agent_group_positions_iter`.

*Call graph*: calls 1 internal fn (agent_group_positions_iter).


##### `agent_group_positions_iter`  (lines 716–736)

```
fn agent_group_positions_iter(
    cells: &[Arc<dyn crate::history_cell::HistoryCell>],
) -> impl Iterator<Item = usize> + '_
```

**Purpose**: Finds the transcript indexes of top-level agent message groups for tests. It ignores stream continuations so one assistant response is counted as one group.

**Data flow**: It receives transcript cells, starts after the latest session marker, and yields indexes for `AgentMessageCell` values that are not stream continuations.

**Call relations**: This is called by `agent_group_count` in test builds. It mirrors the session-boundary idea used by user-message iteration.

*Call graph*: called by 1 (agent_group_count).


##### `tests::render_lines`  (lines 747–757)

```
fn render_lines(lines: &[Line<'static>]) -> Vec<String>
```

**Purpose**: Turns rendered terminal lines into plain strings for snapshot tests. This makes it easy to compare what the user would see.

**Data flow**: It receives a list of styled terminal lines, joins each line’s spans into ordinary text, and returns a vector of strings.

**Call relations**: This is used by the snapshot test for the “no previous message to edit” info message.

*Call graph*: 1 external calls (iter).


##### `tests::trim_transcript_for_first_user_drops_user_and_newer_cells`  (lines 760–776)

```
fn trim_transcript_for_first_user_drops_user_and_newer_cells()
```

**Purpose**: Checks that trimming to the first user message removes that user message and everything after it. This protects the basic rollback-to-start behavior.

**Data flow**: It builds a transcript with a user message and an assistant response, trims to user message zero, and asserts that the transcript becomes empty.

**Call relations**: This test calls `trim_transcript_cells_to_nth_user`, exercising the helper used by pending backtrack completion.

*Call graph*: calls 1 internal fn (trim_transcript_cells_to_nth_user); 2 external calls (assert!, vec!).


##### `tests::trim_transcript_preserves_cells_before_selected_user`  (lines 779–811)

```
fn trim_transcript_preserves_cells_before_selected_user()
```

**Purpose**: Checks that cells before the selected user message are kept when trimming. This matters because intro or earlier assistant context should not be deleted by mistake.

**Data flow**: It builds a transcript with an intro assistant cell, a user message, and a later assistant cell. After trimming to the user message, it verifies only the intro cell remains and still renders as expected.

**Call relations**: This test calls `trim_transcript_cells_to_nth_user` to confirm the cut happens just before the chosen user cell.

*Call graph*: calls 1 internal fn (trim_transcript_cells_to_nth_user); 2 external calls (assert_eq!, vec!).


##### `tests::trim_transcript_for_later_user_keeps_prior_history`  (lines 814–873)

```
fn trim_transcript_for_later_user_keeps_prior_history()
```

**Purpose**: Checks that trimming to a later user message keeps all earlier conversation history. This ensures backtracking to the second prompt does not erase the first prompt and its preceding response.

**Data flow**: It builds a multi-turn transcript, trims to the second user message, and asserts that the intro, first user message, and between-assistant message remain.

**Call relations**: This test exercises `trim_transcript_cells_to_nth_user` for a non-first selection.

*Call graph*: calls 1 internal fn (trim_transcript_cells_to_nth_user); 2 external calls (assert_eq!, vec!).


##### `tests::trim_drop_last_n_user_turns_applies_rollback_semantics`  (lines 876–910)

```
fn trim_drop_last_n_user_turns_applies_rollback_semantics()
```

**Purpose**: Verifies that dropping the last user turn removes the latest user message and later assistant output while preserving earlier turns.

**Data flow**: It builds a two-turn transcript, drops one user turn from the end, and checks that only the first turn remains.

**Call relations**: This test calls `trim_transcript_cells_drop_last_n_user_turns`, the helper used for non-pending rollback confirmations.

*Call graph*: calls 1 internal fn (trim_transcript_cells_drop_last_n_user_turns); 3 external calls (assert!, assert_eq!, vec!).


##### `tests::trim_drop_last_n_user_turns_allows_overflow`  (lines 913–946)

```
fn trim_drop_last_n_user_turns_allows_overflow()
```

**Purpose**: Checks that asking to drop more turns than exist is safe. The function should trim back to the first user turn without crashing or underflowing.

**Data flow**: It builds a transcript with an intro assistant cell and one user turn, asks to drop an extremely large number of turns, and verifies the intro cell remains.

**Call relations**: This test calls `trim_transcript_cells_drop_last_n_user_turns` to cover oversized rollback counts.

*Call graph*: calls 1 internal fn (trim_transcript_cells_drop_last_n_user_turns); 3 external calls (assert!, assert_eq!, vec!).


##### `tests::agent_group_count_ignores_context_compacted_marker`  (lines 949–966)

```
fn agent_group_count_ignores_context_compacted_marker()
```

**Purpose**: Ensures that an informational “Context compacted” marker is not counted as an assistant message group. This keeps test helper counting aligned with real transcript meaning.

**Data flow**: It builds cells with two assistant messages separated by an info event, counts agent groups, and asserts the count is two.

**Call relations**: This test uses `agent_group_count`, which in turn uses `agent_group_positions_iter`.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `tests::backtrack_target_requires_user_message`  (lines 969–991)

```
fn backtrack_target_requires_user_message()
```

**Purpose**: Confirms that backtracking is only available when there is at least one user message. Assistant or info-only transcripts should not offer an edit target.

**Data flow**: It first builds a transcript without user messages and asserts no target exists. Then it adds a user message and asserts a target is available.

**Call relations**: This test covers the behavior behind `has_backtrack_target`, which is used before showing hints or opening preview mode.

*Call graph*: 4 external calls (new, new, assert!, vec!).


##### `tests::backtrack_unavailable_info_message_snapshot`  (lines 994–1002)

```
fn backtrack_unavailable_info_message_snapshot()
```

**Purpose**: Checks the rendered text for the “No previous message to edit” message. This helps prevent accidental changes to a visible user-facing message.

**Data flow**: It creates an info-event cell with the unavailable message, renders it into plain text lines, joins them, and compares the result with a stored snapshot.

**Call relations**: This test uses `tests::render_lines` and the history-cell info-message constructor to verify the exact display output.

*Call graph*: 3 external calls (new_info_event, assert_snapshot!, render_lines).


### `tui/src/multi_agents.rs`

`domain_logic` · `TUI event rendering and keyboard handling`

When the app can run more than one agent thread, the terminal interface needs to explain that activity without overwhelming the user. This file is like the sign-maker for a busy workshop: it does not decide which worker does a job, but it writes the labels, progress notes, and shortcut hints that help a person understand the workshop. It builds rows for the history view when an agent is spawned, sent input, resumed, waited on, interrupted, completed, errored, or closed. It also formats names for the `/agent` picker, including nicknames and roles such as `Robie [explorer]`, and provides the keyboard bindings for moving to the previous or next agent. A few details are deliberately user-friendly: long prompts and error messages are shortened, empty names are ignored, and status text is colored so success, running work, and errors are easy to scan. The file also has small tests that lock down the expected wording and styling. Without this file, multi-agent actions would still happen in the backend, but the TUI would have no consistent way to show them, making agent collaboration hard to follow.

#### Function details

##### `agent_picker_status_dot_spans`  (lines 75–82)

```
fn agent_picker_status_dot_spans(is_closed: bool) -> Vec<Span<'static>>
```

**Purpose**: Creates the small dot shown beside an agent in the picker. The dot is green when the agent is still considered active and plain when it is closed.

**Data flow**: It receives whether the agent is closed. It chooses a styled bullet symbol and adds a following space. It returns these pieces as terminal text spans that the picker can draw.

**Call relations**: This is used when building agent picker rows, where each row needs a quick visual status cue before the agent name.

*Call graph*: 1 external calls (vec!).


##### `format_agent_picker_item_name`  (lines 84–103)

```
fn format_agent_picker_item_name(
    agent_nickname: Option<&str>,
    agent_role: Option<&str>,
    is_primary: bool,
) -> String
```

**Purpose**: Builds the human-readable name shown for an agent in the `/agent` picker. It combines a nickname and role when available, and gives the main thread a special default label.

**Data flow**: It receives an optional nickname, optional role, and a flag saying whether this is the primary thread. It trims empty text away, chooses the clearest available label, and returns a single display string.

**Call relations**: Picker-building code calls this when it needs the row title for a thread. It keeps naming rules in one place so the picker and footer labels stay consistent.

*Call graph*: 1 external calls (format!).


##### `previous_agent_shortcut`  (lines 105–107)

```
fn previous_agent_shortcut() -> crate::key_hint::KeyBinding
```

**Purpose**: Defines the standard keyboard shortcut for moving to the previous agent. In this file, that shortcut is Alt plus the left arrow key.

**Data flow**: It takes no input. It asks the shared key-hint helper to describe Alt+Left. It returns a key binding object that can be shown to users or matched against input.

**Call relations**: Shortcut display code uses this to print hints, and `previous_agent_shortcut_matches` uses it when checking actual key presses.

*Call graph*: calls 1 internal fn (alt); called by 3 (picker_subtitle, picker_subtitle_mentions_shortcuts, previous_agent_shortcut_matches).


##### `next_agent_shortcut`  (lines 109–111)

```
fn next_agent_shortcut() -> crate::key_hint::KeyBinding
```

**Purpose**: Defines the standard keyboard shortcut for moving to the next agent. In this file, that shortcut is Alt plus the right arrow key.

**Data flow**: It takes no input. It asks the shared key-hint helper to describe Alt+Right. It returns a key binding object for display and matching.

**Call relations**: Shortcut display code uses this to print hints, and `next_agent_shortcut_matches` uses it when checking actual key presses.

*Call graph*: calls 1 internal fn (alt); called by 3 (picker_subtitle, picker_subtitle_mentions_shortcuts, next_agent_shortcut_matches).


##### `previous_agent_shortcut_matches`  (lines 115–121)

```
fn previous_agent_shortcut_matches(
    key_event: KeyEvent,
    allow_word_motion_fallback: bool,
) -> bool
```

**Purpose**: Checks whether a key press should switch to the previous agent. It accepts both the normal shortcut and, on supported platforms, a fallback key sequence.

**Data flow**: It receives a keyboard event and a flag saying whether word-motion fallback is safe to use. It tests the event against Alt+Left, then against the fallback rule. It returns true only if one of those should mean previous agent.

**Call relations**: The TUI input loop can call this when a key arrives. It delegates the normal binding to `previous_agent_shortcut` and platform-specific backup behavior to `previous_agent_word_motion_fallback`.

*Call graph*: calls 2 internal fn (previous_agent_shortcut, previous_agent_word_motion_fallback).


##### `next_agent_shortcut_matches`  (lines 125–131)

```
fn next_agent_shortcut_matches(
    key_event: KeyEvent,
    allow_word_motion_fallback: bool,
) -> bool
```

**Purpose**: Checks whether a key press should switch to the next agent. It accepts both the normal shortcut and, on supported platforms, a fallback key sequence.

**Data flow**: It receives a keyboard event and a flag saying whether fallback behavior is allowed. It tests the event against Alt+Right, then against the fallback rule. It returns true if the key should move forward through agents.

**Call relations**: The TUI input loop can call this when processing keys. It delegates the normal binding to `next_agent_shortcut` and platform-specific backup behavior to `next_agent_word_motion_fallback`.

*Call graph*: calls 2 internal fn (next_agent_shortcut, next_agent_word_motion_fallback).


##### `previous_agent_word_motion_fallback`  (lines 155–160)

```
fn previous_agent_word_motion_fallback(
    _key_event: KeyEvent,
    _allow_word_motion_fallback: bool,
) -> bool
```

**Purpose**: Recognizes a backup previous-agent shortcut on systems where terminals may report Option+Left as Option+b. This matters most on macOS terminals without enhanced keyboard reporting.

**Data flow**: It receives a key event and a permission flag. On macOS, it checks for Alt+b press or repeat only when fallback is allowed; on other systems it always returns false. The output is a yes-or-no match.

**Call relations**: `previous_agent_shortcut_matches` calls this after checking the main shortcut. Callers should only allow this fallback when it will not interfere with text editing.

*Call graph*: called by 1 (previous_agent_shortcut_matches); 1 external calls (matches!).


##### `next_agent_word_motion_fallback`  (lines 181–186)

```
fn next_agent_word_motion_fallback(
    _key_event: KeyEvent,
    _allow_word_motion_fallback: bool,
) -> bool
```

**Purpose**: Recognizes a backup next-agent shortcut on systems where terminals may report Option+Right as Option+f. This keeps agent switching usable in some macOS terminal setups.

**Data flow**: It receives a key event and a permission flag. On macOS, it checks for Alt+f press or repeat only when fallback is allowed; on other systems it always returns false. It returns whether the fallback matched.

**Call relations**: `next_agent_shortcut_matches` calls this after checking the main shortcut. It is deliberately gated so normal word-by-word cursor movement in the composer is not stolen.

*Call graph*: called by 1 (next_agent_shortcut_matches); 1 external calls (matches!).


##### `spawn_request_summary`  (lines 188–201)

```
fn spawn_request_summary(item: &ThreadItem) -> Option<SpawnRequestSummary>
```

**Purpose**: Pulls out the model and reasoning effort from a completed agent-spawn request. This lets the UI later say not just that an agent was spawned, but what kind of model settings were requested.

**Data flow**: It receives a thread history item. If the item is a spawn-agent tool call with both model and reasoning effort present, it copies those values into a small summary object. Otherwise it returns nothing.

**Call relations**: Collaboration event processing and `tool_call_history_cell` use this to preserve spawn details for display, especially when the final event needs a compact label like a model name plus reasoning level.

*Call graph*: called by 2 (on_collab_agent_tool_call, tool_call_history_cell).


##### `tool_call_history_cell`  (lines 203–279)

```
fn tool_call_history_cell(
    item: &ThreadItem,
    cached_spawn_request: Option<&SpawnRequestSummary>,
    mut agent_metadata: impl FnMut(ThreadId) -> AgentMetadata,
) -> Option<PlainHistoryCell>
```

**Purpose**: Converts a multi-agent tool-call event into one displayable history cell. It is the main translator from backend collaboration events into readable TUI transcript rows.

**Data flow**: It receives a thread item, an optional cached spawn summary, and a lookup function for agent metadata. It checks what kind of agent tool call happened, ignores some in-progress events that should not be shown yet, builds the right title and details, and returns a `PlainHistoryCell` when there is something to display.

**Call relations**: Event-handling code calls this when a collaboration tool call arrives. It hands off to helpers such as `spawn_end`, `waiting_begin`, and `waiting_end` so each kind of row has consistent wording.

*Call graph*: calls 4 internal fn (spawn_end, spawn_request_summary, waiting_begin, waiting_end); called by 4 (on_collab_agent_tool_call, collab_events_snapshot, collab_resume_interrupted_snapshot, title_styles_nickname_and_role); 1 external calls (matches!).


##### `sub_agent_activity_display`  (lines 281–296)

```
fn sub_agent_activity_display(item: &ThreadItem) -> Option<SubAgentActivityDisplay>
```

**Purpose**: Extracts the compact information needed to update the visible state of a sub-agent. It tells the UI which thread the activity belongs to, where the agent lives, and whether it looks active.

**Data flow**: It receives a thread item. If the item is sub-agent activity, it parses the agent thread id, copies the agent path, and marks it as running unless the activity says it was interrupted. It returns that display data or nothing if the item is not relevant.

**Call relations**: Sub-agent activity handling can call this before updating picker or activity state. It relies on `parse_thread_id` so invalid thread identifiers do not enter the display state.

*Call graph*: calls 1 internal fn (parse_thread_id); 1 external calls (matches!).


##### `sub_agent_activity_history_cell`  (lines 298–309)

```
fn sub_agent_activity_history_cell(item: &ThreadItem) -> Option<PlainHistoryCell>
```

**Purpose**: Turns a sub-agent activity event into a simple history row. This gives the transcript short notes such as started, interacted with, or interrupted.

**Data flow**: It receives a thread item. If it is sub-agent activity, it builds a styled title from the activity kind and agent path, adds no extra detail lines, and returns a `PlainHistoryCell`. Other item types produce no cell.

**Call relations**: Sub-agent event handling calls this when it wants an activity event to appear in the transcript. It delegates title wording to `sub_agent_activity_title` and row assembly to `collab_event`.

*Call graph*: calls 2 internal fn (collab_event, sub_agent_activity_title); called by 1 (on_sub_agent_activity); 1 external calls (new).


##### `sub_agent_activity_summary`  (lines 311–317)

```
fn sub_agent_activity_summary(kind: SubAgentActivityKind, agent_path: &str) -> String
```

**Purpose**: Creates a one-line plain-text summary of a sub-agent activity. This is useful in places that need text rather than styled terminal spans.

**Data flow**: It receives the activity kind and the agent path. It chooses the correct verb, inserts the path, and returns a string like `Started <path>` or `Interrupted <path>`.

**Call relations**: Any UI component needing a compact activity label can use this instead of rebuilding the wording itself.

*Call graph*: 1 external calls (format!).


##### `sub_agent_activity_title`  (lines 319–329)

```
fn sub_agent_activity_title(kind: SubAgentActivityKind, agent_path: &str) -> Line<'static>
```

**Purpose**: Builds the styled title line for a sub-agent activity history row. It bolds the action words and colors the agent path so it stands out.

**Data flow**: It receives an activity kind and an agent path. It chooses a prefix such as `Started` or `Interrupted`, wraps the path in backticks, styles the pieces, and returns one terminal line.

**Call relations**: `sub_agent_activity_history_cell` calls this before wrapping the title into a full history cell.

*Call graph*: calls 1 internal fn (title_spans_line); called by 1 (sub_agent_activity_history_cell); 1 external calls (vec!).


##### `spawn_end`  (lines 331–351)

```
fn spawn_end(
    new_thread_id: Option<ThreadId>,
    prompt: &str,
    spawn_request: Option<&SpawnRequestSummary>,
    agent_metadata: &mut impl FnMut(ThreadId) -> AgentMetadata,
) -> PlainHistoryC
```

**Purpose**: Builds the history row shown after an agent spawn request finishes. It shows either the new agent label or a failure message, plus a short prompt preview if there was one.

**Data flow**: It receives the new thread id if one exists, the spawn prompt, optional model settings, and a metadata lookup. It builds a title, adds a truncated prompt detail when useful, and returns a display cell.

**Call relations**: `tool_call_history_cell` calls this for finished spawn-agent tool calls. It uses label and title helpers so spawned-agent rows match the rest of the collaboration transcript.

*Call graph*: calls 5 internal fn (agent_label, collab_event, prompt_line, title_text, title_with_agent); called by 1 (tool_call_history_cell); 1 external calls (new).


##### `interaction_end`  (lines 353–369)

```
fn interaction_end(
    receiver_thread_id: ThreadId,
    prompt: &str,
    agent_metadata: &mut impl FnMut(ThreadId) -> AgentMetadata,
) -> PlainHistoryCell
```

**Purpose**: Builds the history row shown after input has been sent to an agent. It makes clear which agent received the message and shows a short preview of the message.

**Data flow**: It receives the receiver thread id, prompt text, and metadata lookup. It creates a title like `Sent input to Robie`, adds a truncated prompt line if non-empty, and returns a display cell.

**Call relations**: The tool-call rendering path uses this for completed send-input events. It shares `prompt_line`, `agent_label`, and `collab_event` with spawn rendering so similar events look alike.

*Call graph*: calls 4 internal fn (agent_label, collab_event, prompt_line, title_with_agent); 1 external calls (new).


##### `waiting_begin`  (lines 371–401)

```
fn waiting_begin(
    receiver_thread_ids: &[String],
    agent_metadata: &mut impl FnMut(ThreadId) -> AgentMetadata,
) -> PlainHistoryCell
```

**Purpose**: Builds the history row shown when the app starts waiting for one or more agents. It adapts the wording for one agent, many agents, or an unknown list.

**Data flow**: It receives receiver thread id strings and a metadata lookup. It parses valid ids, fetches names and roles, chooses an appropriate title, and, for multiple agents, adds one detail line per agent. It returns a display cell.

**Call relations**: `tool_call_history_cell` calls this for in-progress wait events. It uses shared label and title helpers so waiting rows match other agent rows.

*Call graph*: calls 4 internal fn (agent_label, collab_event, title_text, title_with_agent); called by 1 (tool_call_history_cell); 2 external calls (new, format!).


##### `waiting_end`  (lines 403–410)

```
fn waiting_end(
    receiver_thread_ids: &[String],
    agents_states: &std::collections::HashMap<String, CollabAgentState>,
    agent_metadata: &mut impl FnMut(ThreadId) -> AgentMetadata,
) -> PlainH
```

**Purpose**: Builds the history row shown when waiting for agents has finished. It summarizes the outcome for each agent that completed or reported a status.

**Data flow**: It receives receiver thread ids, a map of agent states, and a metadata lookup. It asks `wait_complete_lines` to turn those statuses into detail lines, adds the title `Finished waiting`, and returns a display cell.

**Call relations**: `tool_call_history_cell` calls this for completed wait events. It delegates the per-agent status formatting to `wait_complete_lines` and the final cell shape to `collab_event`.

*Call graph*: calls 3 internal fn (collab_event, title_text, wait_complete_lines); called by 1 (tool_call_history_cell).


##### `close_end`  (lines 412–424)

```
fn close_end(
    receiver_thread_id: ThreadId,
    agent_metadata: &mut impl FnMut(ThreadId) -> AgentMetadata,
) -> PlainHistoryCell
```

**Purpose**: Builds the history row shown after an agent has been closed. It names the closed agent so the user can connect the close action to the right thread.

**Data flow**: It receives the receiver thread id and metadata lookup. It formats the agent label, creates a `Closed ...` title, adds no details, and returns a display cell.

**Call relations**: The tool-call rendering path uses this for completed close-agent events. It relies on the same label and event helpers as spawn, send, and resume rows.

*Call graph*: calls 3 internal fn (agent_label, collab_event, title_with_agent); 1 external calls (new).


##### `resume_begin`  (lines 426–438)

```
fn resume_begin(
    receiver_thread_id: ThreadId,
    agent_metadata: &mut impl FnMut(ThreadId) -> AgentMetadata,
) -> PlainHistoryCell
```

**Purpose**: Builds the history row shown while an agent is being resumed. This gives immediate feedback that a resume action has started.

**Data flow**: It receives the receiver thread id and metadata lookup. It creates a `Resuming ...` title with the agent label and returns a display cell with no detail lines.

**Call relations**: The tool-call rendering path uses this for in-progress resume-agent events. It passes through `title_with_agent` and `collab_event` for consistent transcript formatting.

*Call graph*: calls 3 internal fn (agent_label, collab_event, title_with_agent); 1 external calls (new).


##### `resume_end`  (lines 440–454)

```
fn resume_end(
    receiver_thread_id: ThreadId,
    status: Option<&CollabAgentState>,
    fallback_error: &str,
    agent_metadata: &mut impl FnMut(ThreadId) -> AgentMetadata,
) -> PlainHistoryCell
```

**Purpose**: Builds the history row shown after an agent resume request finishes. It includes a status line so the user can see whether the resumed agent is running, interrupted, errored, or otherwise unavailable.

**Data flow**: It receives the receiver thread id, optional agent state, fallback error text, and metadata lookup. It creates a `Resumed ...` title and adds one detail line based on the status or fallback error. It returns a display cell.

**Call relations**: The tool-call rendering path uses this for finished resume-agent events. It relies on `status_summary_line` for the result wording and on shared title/event helpers for layout.

*Call graph*: calls 3 internal fn (agent_label, collab_event, title_with_agent); 1 external calls (vec!).


##### `collab_event`  (lines 456–462)

```
fn collab_event(title: Line<'static>, details: Vec<Line<'static>>) -> PlainHistoryCell
```

**Purpose**: Assembles a title and optional detail lines into a plain history cell. It gives collaboration events a common shape in the transcript.

**Data flow**: It receives a title line and a list of detail lines. It puts the title first, indents detail lines under it with a branch-like prefix, and returns a `PlainHistoryCell` containing all lines.

**Call relations**: Most row-building helpers call this as their final step, including spawn, wait, resume, close, interaction, and sub-agent activity rendering.

*Call graph*: calls 2 internal fn (new, prefix_lines); called by 8 (close_end, interaction_end, resume_begin, resume_end, spawn_end, sub_agent_activity_history_cell, waiting_begin, waiting_end); 1 external calls (vec!).


##### `title_text`  (lines 464–466)

```
fn title_text(title: impl Into<String>) -> Line<'static>
```

**Purpose**: Creates a simple bold title line without an agent label. It is used for generic messages such as failures or finished waiting.

**Data flow**: It receives text that can become a string. It wraps the text in a bold span, adds the standard leading bullet through `title_spans_line`, and returns a terminal line.

**Call relations**: Helpers such as `spawn_end`, `waiting_begin`, and `waiting_end` use this when the title does not need a specific agent label.

*Call graph*: calls 1 internal fn (title_spans_line); called by 3 (spawn_end, waiting_begin, waiting_end); 1 external calls (vec!).


##### `title_with_agent`  (lines 468–477)

```
fn title_with_agent(
    prefix: &str,
    agent: AgentLabel<'_>,
    spawn_request: Option<&SpawnRequestSummary>,
) -> Line<'static>
```

**Purpose**: Creates a styled title line that includes an action, an agent label, and optional spawn settings. This is the standard title builder for agent-specific rows.

**Data flow**: It receives an action prefix, an agent label, and optional spawn request details. It styles the prefix, expands the agent label into spans, appends model/reasoning details if present, and returns one title line.

**Call relations**: Spawn, send-input, wait, close, and resume row builders call this whenever the row is about a particular agent.

*Call graph*: calls 3 internal fn (agent_label_spans, spawn_request_spans, title_spans_line); called by 6 (close_end, interaction_end, resume_begin, resume_end, spawn_end, waiting_begin); 1 external calls (vec!).


##### `title_spans_line`  (lines 479–484)

```
fn title_spans_line(mut spans: Vec<Span<'static>>) -> Line<'static>
```

**Purpose**: Adds the standard leading bullet to a set of styled title pieces. This keeps all collaboration event titles visually aligned.

**Data flow**: It receives a list of terminal spans. It creates a new list starting with a dim bullet, appends the supplied spans, and returns them as one terminal line.

**Call relations**: `title_text`, `title_with_agent`, and `sub_agent_activity_title` use this as the last step in creating a title.

*Call graph*: called by 3 (sub_agent_activity_title, title_text, title_with_agent); 2 external calls (from, with_capacity).


##### `parse_thread_id`  (lines 486–488)

```
fn parse_thread_id(thread_id: &str) -> Option<ThreadId>
```

**Purpose**: Safely converts a thread id string into the strongly typed thread identifier used by the program. Invalid ids are rejected instead of being displayed as if they were valid.

**Data flow**: It receives a string. It asks the `ThreadId` parser to read it and returns the parsed id on success or nothing on failure.

**Call relations**: `sub_agent_activity_display` uses this before exposing sub-agent state to the UI. Other rendering helpers also depend on parsed ids when they need metadata for a thread.

*Call graph*: calls 1 internal fn (from_string); called by 1 (sub_agent_activity_display).


##### `agent_label`  (lines 490–496)

```
fn agent_label(thread_id: ThreadId, metadata: &AgentMetadata) -> AgentLabel<'_>
```

**Purpose**: Packages a thread id together with optional nickname and role into a lightweight label description. This separates choosing label data from turning it into styled text.

**Data flow**: It receives a thread id and an `AgentMetadata` record. It borrows the nickname and role text if present and returns an `AgentLabel` containing those references plus the id.

**Call relations**: Agent-specific row builders call this before passing the label to title or line-formatting helpers.

*Call graph*: called by 6 (close_end, interaction_end, resume_begin, resume_end, spawn_end, waiting_begin).


##### `agent_label_line`  (lines 498–500)

```
fn agent_label_line(agent: AgentLabel<'_>) -> Line<'static>
```

**Purpose**: Turns an agent label into a full terminal line. This is mainly useful when an agent needs to appear as its own detail row.

**Data flow**: It receives an `AgentLabel`. It converts the label into styled spans using `agent_label_spans` and returns those spans as a line.

**Call relations**: `waiting_begin` uses this style of output when listing multiple agents being waited on.

*Call graph*: calls 1 internal fn (agent_label_spans).


##### `agent_label_spans`  (lines 502–524)

```
fn agent_label_spans(agent: AgentLabel<'_>) -> Vec<Span<'static>>
```

**Purpose**: Turns an agent label into styled pieces of terminal text. It prefers a nickname, falls back to the thread id, and finally to the word `agent` if neither is available.

**Data flow**: It receives an `AgentLabel`. It trims empty nickname and role text, colors the main name cyan, bolds nicknames, appends a role like `[worker]` when present, and returns the styled spans.

**Call relations**: `title_with_agent`, `agent_label_line`, and status detail builders use this so every place names agents the same way.

*Call graph*: called by 2 (agent_label_line, title_with_agent); 3 external calls (from, new, format!).


##### `spawn_request_spans`  (lines 526–543)

```
fn spawn_request_spans(spawn_request: Option<&SpawnRequestSummary>) -> Vec<Span<'static>>
```

**Purpose**: Formats optional spawn settings for display after an agent name. It shows the model and reasoning effort only when there is meaningful information.

**Data flow**: It receives an optional spawn request summary. If none is present, or if the model is empty and reasoning effort is default, it returns no spans. Otherwise it returns dim spacing plus a magenta detail like `(gpt-5 high)`.

**Call relations**: `title_with_agent` calls this when building a spawn title that may include model settings.

*Call graph*: called by 1 (title_with_agent); 4 external calls (default, new, format!, vec!).


##### `prompt_line`  (lines 545–555)

```
fn prompt_line(prompt: &str) -> Option<Line<'static>>
```

**Purpose**: Creates a short display line for a prompt or message sent to an agent. It hides empty prompts and shortens long ones so history rows stay readable.

**Data flow**: It receives prompt text. It trims whitespace, returns nothing if the prompt is empty, or truncates it to the configured preview length and returns it as a terminal line.

**Call relations**: `spawn_end` and `interaction_end` call this when adding prompt previews below their titles.

*Call graph*: calls 1 internal fn (truncate_text); called by 2 (interaction_end, spawn_end); 2 external calls (from, from).


##### `wait_complete_lines`  (lines 557–597)

```
fn wait_complete_lines(
    receiver_thread_ids: &[String],
    agents_states: &std::collections::HashMap<String, CollabAgentState>,
    agent_metadata: &mut impl FnMut(ThreadId) -> AgentMetadata,
) -
```

**Purpose**: Builds the per-agent detail lines shown after waiting finishes. It lists known receiver agents first and then any extra agent states in a stable order.

**Data flow**: It receives receiver thread id strings, a map from thread ids to agent states, and a metadata lookup. It parses ids, matches them with statuses, fetches display names, formats each status, and returns lines; if none are available, it returns `No agents completed yet`.

**Call relations**: `waiting_end` calls this to create the body of the finished-waiting history cell. It uses label and status summary helpers so each line reads like `Robie: Completed - result`.

*Call graph*: called by 1 (waiting_end); 2 external calls (new, vec!).


##### `first_agent_state`  (lines 599–612)

```
fn first_agent_state(
    receiver_thread_ids: &[String],
    agents_states: &'a std::collections::HashMap<String, CollabAgentState>,
) -> Option<&'a CollabAgentState>
```

**Purpose**: Finds the best available agent state when only one status line is needed. It prefers the first requested receiver, then falls back to the first state by id.

**Data flow**: It receives the receiver thread ids and the map of agent states. It looks for a state belonging to one of the requested ids in order, otherwise picks the lowest id in the map. It returns a borrowed state or nothing.

**Call relations**: Resume completion rendering uses this idea to choose which status should explain the result of a resume attempt.


##### `status_summary_line`  (lines 614–619)

```
fn status_summary_line(status: Option<&CollabAgentState>, fallback_error: &str) -> Line<'static>
```

**Purpose**: Turns an optional agent state into one display line. If no state exists, it shows a fallback error instead.

**Data flow**: It receives an optional state and fallback error text. With a state, it delegates to `status_summary_spans`; without one, it delegates to `error_summary_spans`. It returns the resulting spans as a line.

**Call relations**: `resume_end` uses this to add the outcome line under a resumed-agent title.

*Call graph*: calls 2 internal fn (error_summary_spans, status_summary_spans).


##### `status_summary_spans`  (lines 621–648)

```
fn status_summary_spans(status: &CollabAgentState) -> Vec<Span<'static>>
```

**Purpose**: Formats an agent's current status as styled terminal text. It gives each state a clear word such as running, completed, interrupted, or not found, and may include a short message preview.

**Data flow**: It receives an agent state. It matches the status value, chooses wording and color, normalizes and truncates any message where appropriate, and returns styled spans.

**Call relations**: `status_summary_line` and finished-wait detail rendering use this to explain agent outcomes consistently. It calls `error_summary_spans` when the state is errored.

*Call graph*: calls 2 internal fn (error_summary_spans, truncate_text); called by 1 (status_summary_line); 2 external calls (from, vec!).


##### `error_summary_spans`  (lines 650–661)

```
fn error_summary_spans(error: &str) -> Vec<Span<'static>>
```

**Purpose**: Formats an error as short styled terminal text. It marks the word `Error` in red and appends a compact preview of the error message if one exists.

**Data flow**: It receives an error string. It collapses whitespace, truncates the preview to the configured length, and returns red error text plus optional message spans.

**Call relations**: `status_summary_line` uses this when there is no agent state, and `status_summary_spans` uses it for errored agent states.

*Call graph*: calls 1 internal fn (truncate_text); called by 2 (status_summary_line, status_summary_spans); 2 external calls (from, vec!).


##### `tests::collab_events_snapshot`  (lines 678–795)

```
fn collab_events_snapshot()
```

**Purpose**: Checks that a typical sequence of collaboration events renders exactly as expected. It covers spawning, sending input, waiting, finishing with mixed results, and closing.

**Data flow**: It builds fake thread ids, fake tool-call history items, and metadata. It passes them through `tool_call_history_cell`, converts the cells to plain text, and compares the result to a stored snapshot.

**Call relations**: This test protects the transcript wording and layout produced by the main rendering path. If a helper changes the visible output, the snapshot will reveal it.

*Call graph*: calls 2 internal fn (from_string, tool_call_history_cell); 5 external calls (from, new, assert_snapshot!, agent_state, vec!).


##### `tests::agent_shortcut_matches_option_arrow_word_motion_fallbacks_only_when_allowed`  (lines 799–824)

```
fn agent_shortcut_matches_option_arrow_word_motion_fallbacks_only_when_allowed()
```

**Purpose**: On macOS, checks that agent-switch shortcuts recognize both Option-arrow and the Option-b/f fallback only when allowed. This prevents shortcut support from breaking normal text editing.

**Data flow**: It creates several key events and passes them to the previous/next shortcut matchers with fallback enabled or disabled. It asserts which ones should match and which ones should not.

**Call relations**: This test exercises `previous_agent_shortcut_matches` and `next_agent_shortcut_matches`, especially their platform fallback behavior.

*Call graph*: 1 external calls (assert!).


##### `tests::agent_shortcut_matches_option_arrows_only`  (lines 828–845)

```
fn agent_shortcut_matches_option_arrows_only()
```

**Purpose**: On non-macOS systems, checks that only the normal Alt-arrow shortcuts switch agents. The word-motion fallback is expected to stay disabled there.

**Data flow**: It creates Alt-left, Alt-right, Alt-b, and Alt-f key events. It sends them through the shortcut matchers and asserts that only the arrow events match.

**Call relations**: This test protects the non-macOS behavior of the previous and next shortcut matchers.

*Call graph*: 1 external calls (assert!).


##### `tests::title_styles_nickname_and_role`  (lines 848–883)

```
fn title_styles_nickname_and_role()
```

**Purpose**: Checks that an agent title is styled correctly when both nickname, role, model, and reasoning effort are present. This catches subtle visual regressions, not just text changes.

**Data flow**: It builds a spawn event with metadata for an agent named Robie. It renders the history cell, inspects the title spans, and asserts the expected text, colors, and bold styling.

**Call relations**: This test goes through `tool_call_history_cell` and indirectly checks helpers such as `title_with_agent`, `agent_label_spans`, and `spawn_request_spans`.

*Call graph*: calls 2 internal fn (from_string, tool_call_history_cell); 6 external calls (from, new, assert!, assert_eq!, agent_state, vec!).


##### `tests::collab_resume_interrupted_snapshot`  (lines 886–913)

```
fn collab_resume_interrupted_snapshot()
```

**Purpose**: Checks the transcript output for a resume event where the agent ends up interrupted. This locks down the wording for an important edge case.

**Data flow**: It builds a completed resume tool-call item with an interrupted agent state. It renders it through `tool_call_history_cell` and compares the text output to a stored snapshot.

**Call relations**: This test covers the resume-completion branch and the interrupted status formatting used by `status_summary_spans`.

*Call graph*: calls 2 internal fn (from_string, tool_call_history_cell); 4 external calls (from, assert_snapshot!, agent_state, vec!).


##### `tests::agent_state`  (lines 915–920)

```
fn agent_state(status: CollabAgentStatus, message: Option<&str>) -> CollabAgentState
```

**Purpose**: Creates a small fake agent state for tests. It keeps the test setup shorter and easier to read.

**Data flow**: It receives a status and optional message string. It copies the message into an owned string when present and returns a `CollabAgentState`.

**Call relations**: The snapshot and styling tests call this whenever they need a realistic agent state without repeating struct construction.


##### `tests::metadata_for`  (lines 922–936)

```
fn metadata_for(thread_id: ThreadId, robie_id: ThreadId, bob_id: ThreadId) -> AgentMetadata
```

**Purpose**: Provides predictable fake nicknames and roles for test thread ids. This lets tests verify rendered labels such as `Robie [explorer]` and `Bob [worker]`.

**Data flow**: It receives a thread id plus the known ids for Robie and Bob. It returns matching metadata for those ids, or empty default metadata for any other id.

**Call relations**: Tests pass this as the metadata lookup function to `tool_call_history_cell`, mimicking how the real app supplies agent display names.

*Call graph*: 1 external calls (default).


##### `tests::cell_to_text`  (lines 938–944)

```
fn cell_to_text(cell: &PlainHistoryCell) -> String
```

**Purpose**: Converts a rendered history cell into plain text for snapshot comparisons. It removes styling so tests can focus on the visible words and layout.

**Data flow**: It receives a `PlainHistoryCell`. It asks the cell for display lines at a wide test width, converts each line to text, joins them with newlines, and returns the string.

**Call relations**: Snapshot tests use this after rendering cells through the production helpers.

*Call graph*: calls 1 internal fn (display_lines).


##### `tests::line_to_text`  (lines 946–952)

```
fn line_to_text(line: &Line<'static>) -> String
```

**Purpose**: Converts one styled terminal line into plain text. It is a small test helper for stripping colors and styles away.

**Data flow**: It receives a terminal line made of spans. It reads each span's text content, joins the pieces together, and returns the resulting string.

**Call relations**: `tests::cell_to_text` calls this for each line before snapshot comparison.


### `tui/src/pager_overlay.rs`

`domain_logic` · `during TUI overlay display, draw, resize, and key-event handling`

This module is the terminal UI’s “reading room.” When the normal chat view is too small for a full transcript, help text, or another long block of content, this file draws an alternate full-screen overlay with a title, scrollable body, progress indicator, and key hints. Without it, users would be stuck with only the main viewport and could not reliably inspect long conversation history or static pages.

The core piece is `PagerView`, a reusable scrollable page. It knows how tall its content is, draws only the visible part, clamps scrolling so it does not wander past the end, and shows a bottom percentage like a document viewer. Content is supplied as `Renderable` objects, meaning small pieces that know how to draw themselves and report their height.

`TranscriptOverlay` uses that pager for conversation history. It renders committed history cells and can append a temporary “live tail” for the message or command still streaming. That live tail is cached, like keeping a sticky note instead of rewriting it every frame, and is rebuilt only when width, revision, continuation state, or animation tick changes. `StaticOverlay` is the simpler version for fixed text or fixed renderable blocks. The file also includes tests that check scrolling, hints, wrapping, hyperlinks, and keeping the transcript synchronized when history changes.

#### Function details

##### `Overlay::new_transcript`  (lines 59–61)

```
fn new_transcript(cells: Vec<Arc<dyn HistoryCell>>, keymap: PagerKeymap) -> Self
```

**Purpose**: Creates an overlay that shows the conversation transcript in a scrollable full-screen pager. It is used when the app wants to open the transcript view with the current saved history.

**Data flow**: It receives committed history cells and a pager keymap. It passes them into `TranscriptOverlay::new`, wraps the result as the transcript variant of `Overlay`, and returns that ready-to-use overlay.

**Call relations**: Higher-level app flows call this when opening or restoring the transcript overlay. It hands construction to `TranscriptOverlay::new`, so callers can work with the general `Overlay` enum instead of knowing the exact overlay type.

*Call graph*: calls 1 internal fn (new); called by 5 (handle_key_event, clear_only_ui_reset_preserves_chat_session_state, queued_rollback_syncs_overlay_and_clears_deferred_history, open_transcript_overlay, open_pending_transcript_if_ready); 1 external calls (Transcript).


##### `Overlay::new_static_with_lines`  (lines 63–69)

```
fn new_static_with_lines(
        lines: Vec<Line<'static>>,
        title: String,
        keymap: PagerKeymap,
    ) -> Self
```

**Purpose**: Creates a scrollable overlay for fixed text lines, such as help or informational content. It gives static content the same pager behavior as the transcript view.

**Data flow**: It receives already-built terminal text lines, a title, and key bindings. It asks `StaticOverlay::with_title` to build the page, wraps it as the static variant, and returns it.

**Call relations**: Event-handling code uses this when it needs to show simple fixed text. It delegates the real setup to `StaticOverlay::with_title` and exposes the result through the shared `Overlay` type.

*Call graph*: calls 1 internal fn (with_title); called by 1 (handle_event); 1 external calls (Static).


##### `Overlay::new_static_with_renderables`  (lines 71–77)

```
fn new_static_with_renderables(
        renderables: Vec<Box<dyn Renderable>>,
        title: String,
        keymap: PagerKeymap,
    ) -> Self
```

**Purpose**: Creates a static overlay from drawable content blocks instead of plain text lines. This is useful when the page is made from richer widgets that already know how to render themselves.

**Data flow**: It receives a list of renderable blocks, a title, and key bindings. It builds a `StaticOverlay` from those blocks and returns it as an `Overlay`.

**Call relations**: Callers that already have renderable widgets use this path. It forwards setup to `StaticOverlay::with_renderables`, then lets the rest of the app treat the result like any other overlay.

*Call graph*: calls 1 internal fn (with_renderables); called by 1 (handle_event); 1 external calls (Static).


##### `Overlay::handle_event`  (lines 79–84)

```
fn handle_event(&mut self, tui: &mut tui::Tui, event: TuiEvent) -> Result<()>
```

**Purpose**: Routes keyboard, draw, resize, and other terminal events to the active overlay type. This keeps the app from needing separate event code for transcript and static overlays.

**Data flow**: It receives a mutable overlay, the TUI object, and an event. It checks which overlay variant is active, passes the event to that overlay’s own handler, and returns any I/O error from drawing.

**Call relations**: The main TUI loop calls this whenever an overlay is open. It dispatches to either `TranscriptOverlay::handle_event` or `StaticOverlay::handle_event`, which then decide whether to scroll, draw, or close.


##### `Overlay::is_done`  (lines 86–91)

```
fn is_done(&self) -> bool
```

**Purpose**: Reports whether the current overlay has been closed by the user. The app uses this to know when to leave the alternate screen and return to the normal chat view.

**Data flow**: It reads the active overlay variant and asks that overlay for its `is_done` flag. It returns true when the overlay should be dismissed, otherwise false.

**Call relations**: After events are handled, the outer UI can call this shared method without caring whether the overlay is transcript or static. It delegates to the matching overlay’s `is_done` method.


##### `first_or_empty`  (lines 94–96)

```
fn first_or_empty(bindings: &[KeyBinding]) -> Vec<KeyBinding>
```

**Purpose**: Picks the first key binding from a list, or returns no key if the list is empty. This keeps footer hints short instead of showing every possible shortcut.

**Data flow**: It receives a slice of key bindings. It copies the first binding if one exists, puts it in a one-item vector, or returns an empty vector if there is no binding.

**Call relations**: Both overlay hint renderers call this while building the footer. The result is then passed to `render_key_hints` to draw compact instructions.

*Call graph*: called by 2 (render_hints, render_hints); 1 external calls (first).


##### `render_key_hints`  (lines 99–117)

```
fn render_key_hints(area: Rect, buf: &mut Buffer, pairs: &[(Vec<KeyBinding>, &str)])
```

**Purpose**: Draws one footer line of shortcut hints, such as keys for scrolling or quitting. It turns key-and-description pairs into readable dim text.

**Data flow**: It receives a screen rectangle, a buffer to draw into, and pairs of key bindings plus labels. It builds styled spans with spacing between groups, then renders them as one paragraph line into the buffer.

**Call relations**: `TranscriptOverlay::render_hints` and `StaticOverlay::render_hints` use this as their shared hint drawer. It relies on the key binding display formatting and the terminal paragraph widget to do the actual drawing.

*Call graph*: called by 2 (render_hints, render_hints); 3 external calls (new, from, vec!).


##### `PagerView::new`  (lines 132–147)

```
fn new(
        renderables: Vec<Box<dyn Renderable>>,
        title: String,
        scroll_offset: usize,
        keymap: PagerKeymap,
    ) -> Self
```

**Purpose**: Creates the reusable scrollable pager state. It stores the content blocks, title, initial scroll position, and keys used for navigation.

**Data flow**: It receives renderables, a title, a starting scroll offset, and a keymap. It packages them with empty cached layout information and no pending scroll target, then returns the pager view.

**Call relations**: `TranscriptOverlay::new`, `StaticOverlay::with_renderables`, and test helpers call this to create a pager. Later draw and key-event methods use the stored state.

*Call graph*: called by 3 (with_renderables, new, pager_view).


##### `PagerView::content_height`  (lines 149–154)

```
fn content_height(&self, width: u16) -> usize
```

**Purpose**: Calculates how many terminal rows all content needs at a given width. This matters because wrapping changes height when the terminal gets narrower or wider.

**Data flow**: It receives a width. It asks each renderable how tall it wants to be at that width, adds those heights together, and returns the total.

**Call relations**: `PagerView::render` calls this before drawing so it can clamp scrolling and compute the bottom progress indicator.

*Call graph*: called by 1 (render).


##### `PagerView::render`  (lines 156–175)

```
fn render(&mut self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Draws the whole pager: clears the area, paints the title, draws visible content, and shows the bottom progress bar. It also resolves any pending request to scroll a chosen content chunk into view.

**Data flow**: It receives a screen rectangle and output buffer. It clears the rectangle, computes the content area, updates layout caches, adjusts scroll position, draws content, and writes the bottom bar.

**Call relations**: `TranscriptOverlay::render` and `StaticOverlay::render` call this for the main upper part of their overlays. Internally it coordinates `render_header`, `content_area`, `content_height`, `ensure_chunk_visible`, `render_content`, and `render_bottom_bar`.

*Call graph*: calls 7 internal fn (content_area, content_height, ensure_chunk_visible, render_bottom_bar, render_content, render_header, update_last_content_height); called by 2 (render, render).


##### `PagerView::render_header`  (lines 177–183)

```
fn render_header(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Draws the pager’s title line. It gives the overlay a visible header so the user knows what screen they are reading.

**Data flow**: It receives the full area and buffer. It writes a dim slash pattern across the line, then writes the title over it.

**Call relations**: `PagerView::render` calls this at the start of each draw. It only paints the header; the body and footer are handled by other pager methods.

*Call graph*: called by 1 (render); 2 external calls (from, format!).


##### `PagerView::render_content`  (lines 185–219)

```
fn render_content(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Draws just the currently visible slice of the scrollable content. It skips content above the viewport and stops when content is below it, which avoids unnecessary drawing.

**Data flow**: It receives the content area and buffer. It walks through renderable blocks, compares each block’s vertical position with the current scroll offset, draws visible blocks directly or through an offset buffer, and fills leftover empty rows with a `~` marker.

**Call relations**: `PagerView::render` calls this after scroll position is settled. If a renderable starts above the visible area, it calls `render_offset_content` to copy only the visible lower part.

*Call graph*: calls 1 internal fn (render_offset_content); called by 1 (render); 4 external calls (from, bottom, new, right).


##### `PagerView::render_bottom_bar`  (lines 221–251)

```
fn render_bottom_bar(
        &self,
        full_area: Rect,
        content_area: Rect,
        buf: &mut Buffer,
        total_len: usize,
    )
```

**Purpose**: Draws the separator line and scroll percentage at the bottom of the pager. This tells users how far through the content they are.

**Data flow**: It receives the full overlay area, the content area, the output buffer, and total content height. It draws a dim horizontal line, calculates percent based on scroll offset versus maximum scroll, and writes that percent near the right edge.

**Call relations**: `PagerView::render` calls this after content rendering. It uses the same height calculations that keep scrolling bounded, so the progress display matches what the user sees.

*Call graph*: called by 1 (render); 4 external calls (bottom, new, from, format!).


##### `PagerView::handle_key_event`  (lines 253–292)

```
fn handle_key_event(&mut self, tui: &mut tui::Tui, key_event: KeyEvent) -> Result<()>
```

**Purpose**: Applies pager navigation keys such as up, down, page up, page down, half-page moves, top, and bottom. It lets both overlay types share the same scrolling behavior.

**Data flow**: It receives the TUI object and a key event. If the key matches a navigation binding, it changes `scroll_offset` safely and schedules another frame; if not, it leaves state unchanged.

**Call relations**: Both `TranscriptOverlay::handle_event` and `StaticOverlay::handle_event` pass unhandled keys here. It calls `page_height` and `content_area` when a key needs a viewport-sized movement, then asks the TUI frame requester to redraw.

*Call graph*: calls 2 internal fn (content_area, page_height); called by 2 (handle_event, handle_event); 1 external calls (frame_requester).


##### `PagerView::page_height`  (lines 299–302)

```
fn page_height(&self, viewport_area: Rect) -> usize
```

**Purpose**: Returns how many content rows count as one page jump. It prefers the last real rendered height so page movement lines up with what was actually visible.

**Data flow**: It receives the terminal viewport area. It returns the cached content-area height if available, otherwise computes the content area from the viewport and returns that height.

**Call relations**: `PagerView::handle_key_event` calls this for page-up and page-down keys. This helps paging stay continuous after the pager has been drawn once.

*Call graph*: called by 1 (handle_key_event).


##### `PagerView::update_last_content_height`  (lines 304–306)

```
fn update_last_content_height(&mut self, height: u16)
```

**Purpose**: Stores the most recent visible content height. This cache lets later key presses know how big a page is.

**Data flow**: It receives a height in terminal rows and saves it as `last_content_height`.

**Call relations**: `PagerView::render` calls this every draw after calculating the content area. `page_height` later reads the stored value.

*Call graph*: called by 1 (render).


##### `PagerView::content_area`  (lines 308–313)

```
fn content_area(&self, area: Rect) -> Rect
```

**Purpose**: Calculates the rectangle where scrollable content should be drawn. It reserves one row for the header and one row for the bottom bar.

**Data flow**: It receives the full pager area. It moves the top down by one row and reduces height by two rows, using saturating arithmetic so tiny areas do not underflow.

**Call relations**: `PagerView::render` uses this for layout, and `PagerView::handle_key_event` uses it to compute half-page movement.

*Call graph*: called by 2 (handle_key_event, render).


##### `PagerView::is_scrolled_to_bottom`  (lines 317–335)

```
fn is_scrolled_to_bottom(&self) -> bool
```

**Purpose**: Tells whether the pager is currently following the end of the content. This is important for transcript behavior: if the user is at the bottom, new output should keep them at the bottom; if they scrolled up, it should not yank them down.

**Data flow**: It reads the current scroll offset, last content height, renderable list, and last rendered content height. It returns true for the special bottom marker, empty or short content, or an offset at or past the maximum scroll.

**Call relations**: Transcript update methods call this before inserting, replacing, consolidating, or syncing live-tail content. `TranscriptOverlay::is_scrolled_to_bottom` also exposes it to the app draw loop.

*Call graph*: called by 5 (consolidate_cells, insert_cell, is_scrolled_to_bottom, replace_cells, sync_live_tail).


##### `PagerView::scroll_chunk_into_view`  (lines 338–340)

```
fn scroll_chunk_into_view(&mut self, chunk_index: usize)
```

**Purpose**: Requests that a particular content block be made visible on the next render. It delays the actual scroll calculation until the pager knows the current wrapping width.

**Data flow**: It receives a renderable index and stores it as `pending_scroll_chunk`. Nothing is drawn immediately.

**Call relations**: `TranscriptOverlay::set_highlight_cell` calls this after selecting a transcript cell. `PagerView::render` later consumes the pending request and calls `ensure_chunk_visible`.

*Call graph*: called by 1 (set_highlight_cell).


##### `PagerView::ensure_chunk_visible`  (lines 342–360)

```
fn ensure_chunk_visible(&mut self, idx: usize, area: Rect)
```

**Purpose**: Adjusts scrolling so a selected content block appears in the visible area. It is like asking a document viewer to scroll just enough to show a paragraph.

**Data flow**: It receives a renderable index and current content area. It calculates the block’s top and bottom row from previous renderable heights, compares that with the visible window, and updates `scroll_offset` only if needed.

**Call relations**: `PagerView::render` calls this when a pending scroll request exists. Tests call it directly to confirm that selected chunks scroll into view.

*Call graph*: called by 1 (render).


##### `CachedRenderable::new`  (lines 371–377)

```
fn new(renderable: impl Into<Box<dyn Renderable>>) -> Self
```

**Purpose**: Wraps a renderable with a small height cache. This avoids repeatedly recalculating wrapped height when the terminal width has not changed.

**Data flow**: It receives something that can become a boxed renderable. It stores that renderable and initializes cached height and cached width as empty.

**Call relations**: Transcript cell rendering and live-tail rendering use this wrapper, and static text pages use it too. It later serves calls through the `Renderable` trait methods.

*Call graph*: called by 1 (live_tail_renderable); 2 external calls (into, new).


##### `CachedRenderable::render`  (lines 381–383)

```
fn render(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Draws the wrapped content without changing the cache. The cache is only for height, not for the actual terminal buffer.

**Data flow**: It receives an area and buffer. It forwards both directly to the inner renderable’s `render` method.

**Call relations**: The pager calls this through the generic `Renderable` trait whenever a cached block is visible. It acts as a transparent wrapper around the real renderer.


##### `CachedRenderable::desired_height`  (lines 384–391)

```
fn desired_height(&self, width: u16) -> u16
```

**Purpose**: Returns the wrapped content’s height, recalculating only when the width changes. This saves work for content whose height is expensive to compute.

**Data flow**: It receives a width. If the width differs from the cached width, it asks the inner renderable for its height and stores the answer; then it returns the cached height, or zero if none is present.

**Call relations**: The pager calls this often while laying out and scrolling. By caching, it protects transcript rendering from repeated wrapping calculations.


##### `CellRenderable::render`  (lines 400–407)

```
fn render(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Draws one committed history cell in transcript form, preserving terminal hyperlinks. This is how chat messages, command output, and other history entries appear in the transcript overlay.

**Data flow**: It receives an area and buffer. It asks the history cell for hyperlink-aware transcript lines at the current width, converts them to visible text, draws them with the cell style, and then marks the buffer cells that should behave as hyperlinks.

**Call relations**: Transcript renderables use this through `CachedRenderable`. The pager calls it only for visible cells, while hyperlink helpers preserve links after wrapping.

*Call graph*: calls 2 internal fn (mark_buffer_hyperlinks, visible_lines); 2 external calls (new, from).


##### `CellRenderable::desired_height`  (lines 409–411)

```
fn desired_height(&self, width: u16) -> u16
```

**Purpose**: Reports how many rows a history cell needs in transcript form. The pager uses this before drawing to know where each cell begins and ends.

**Data flow**: It receives a width and asks the underlying history cell for its desired transcript height at that width. It returns that height.

**Call relations**: The pager calls this through `Renderable` during layout, scrolling, and height calculations. It lets each history cell own its own wrapping rules.


##### `HyperlinkLinesRenderable::render`  (lines 419–424)

```
fn render(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Draws a set of already-prepared hyperlink-aware lines. This is used mainly for the live tail, where content comes from the active in-progress cell rather than committed history.

**Data flow**: It receives an area and buffer. It turns stored hyperlink lines into visible text, renders them with wrapping, and then marks hyperlink spans in the output buffer.

**Call relations**: `TranscriptOverlay::live_tail_renderable` wraps this in `CachedRenderable`. The pager later draws it as the optional final block in the transcript.

*Call graph*: calls 2 internal fn (mark_buffer_hyperlinks, visible_lines); 2 external calls (new, from).


##### `HyperlinkLinesRenderable::desired_height`  (lines 426–432)

```
fn desired_height(&self, width: u16) -> u16
```

**Purpose**: Calculates how tall prepared hyperlink-aware lines will be after wrapping. This lets the pager place the live tail correctly.

**Data flow**: It receives a width, converts hyperlink lines into visible text, asks the paragraph widget for its wrapped line count, converts that count to a terminal-row height, and returns zero if conversion fails.

**Call relations**: The pager calls this through the renderable interface when laying out the live tail. It uses the same wrapping rules as `HyperlinkLinesRenderable::render`.

*Call graph*: calls 1 internal fn (visible_lines); 2 external calls (new, from).


##### `TranscriptOverlay::new`  (lines 469–482)

```
fn new(transcript_cells: Vec<Arc<dyn HistoryCell>>, keymap: PagerKeymap) -> Self
```

**Purpose**: Builds a transcript overlay from committed conversation history. It starts at the bottom so the newest transcript entries are visible first.

**Data flow**: It receives history cells and a keymap. It turns the cells into renderable blocks, creates a `PagerView` titled `T R A N S C R I P T` with a bottom scroll marker, and stores the cells plus overlay state.

**Call relations**: `Overlay::new_transcript` and test helpers call this. It uses `TranscriptOverlay::render_cells` to convert history into pager content.

*Call graph*: calls 1 internal fn (new); called by 2 (new_transcript, transcript_overlay); 1 external calls (render_cells).


##### `TranscriptOverlay::render_cells`  (lines 484–520)

```
fn render_cells(
        cells: &[Arc<dyn HistoryCell>],
        highlight_cell: Option<usize>,
    ) -> Vec<Box<dyn Renderable>>
```

**Purpose**: Converts committed history cells into drawable transcript blocks. It also adds spacing between separate transcript entries and special styling for user messages or highlighted messages.

**Data flow**: It receives a slice of history cells and an optional highlighted cell index. For each cell, it builds a `CellRenderable`, wraps it in a height cache, applies user/highlight style when appropriate, adds a top inset when the cell starts a new stream, and returns the renderable list.

**Call relations**: `TranscriptOverlay::new`, `insert_cell`, and `rebuild_renderables` use this whenever committed transcript content must be rebuilt. The resulting blocks become `PagerView` content.


##### `TranscriptOverlay::insert_cell`  (lines 532–560)

```
fn insert_cell(&mut self, cell: Arc<dyn HistoryCell>)
```

**Purpose**: Adds one newly committed transcript cell while preserving any in-progress live tail already shown at the end. It keeps “follow the bottom” behavior when the user was already at the bottom.

**Data flow**: It checks whether the pager was at the bottom, removes the live tail if present, pushes the new committed cell, rebuilds committed renderables, reattaches the tail with correct spacing if needed, and restores bottom scrolling when appropriate.

**Call relations**: The app calls this as new history becomes committed after the overlay has opened. It uses `PagerView::is_scrolled_to_bottom`, `take_live_tail_renderable`, and `render_cells` to update without losing the active tail.

*Call graph*: calls 4 internal fn (is_scrolled_to_bottom, take_live_tail_renderable, tlbr, new); 2 external calls (new, render_cells).


##### `TranscriptOverlay::replace_cells`  (lines 567–580)

```
fn replace_cells(&mut self, cells: Vec<Arc<dyn HistoryCell>>)
```

**Purpose**: Replaces the committed transcript history shown by the overlay. This keeps the overlay accurate when the main app trims or rolls back history.

**Data flow**: It checks whether the view was following the bottom, replaces the stored cells, clears an out-of-range highlight, rebuilds renderables while preserving the live tail, and restores bottom scrolling if needed.

**Call relations**: Higher-level transcript synchronization code calls this after history changes. It relies on `rebuild_renderables` so the live tail is temporarily removed and reattached safely.

*Call graph*: calls 2 internal fn (is_scrolled_to_bottom, rebuild_renderables).


##### `TranscriptOverlay::consolidate_cells`  (lines 589–623)

```
fn consolidate_cells(
        &mut self,
        range: std::ops::Range<usize>,
        consolidated: Arc<dyn HistoryCell>,
    )
```

**Purpose**: Replaces a range of committed cells with one combined cell. This mirrors main transcript consolidation so the overlay does not show stale separate entries.

**Data flow**: It checks bottom-follow state, clamps the requested range to the overlay’s current cells, adjusts any highlighted index, splices in the consolidated cell, rebuilds renderables, and restores bottom-follow scrolling if needed.

**Call relations**: The app uses this when an agent message or related history entries are merged. It calls `PagerView::is_scrolled_to_bottom` and `rebuild_renderables` to preserve user position and live-tail state.

*Call graph*: calls 2 internal fn (is_scrolled_to_bottom, rebuild_renderables); 1 external calls (once).


##### `TranscriptOverlay::sync_live_tail`  (lines 637–671)

```
fn sync_live_tail(
        &mut self,
        width: u16,
        active_key: Option<ActiveCellTranscriptKey>,
        compute_lines: impl FnOnce(u16) -> Option<Vec<HyperlinkLine>>,
    )
```

**Purpose**: Keeps the optional in-progress transcript tail up to date. It avoids expensive rebuilding unless the active cell’s cache key changes.

**Data flow**: It receives the width, an optional active-cell key, and a function that can compute tail lines. It builds the next cache key, returns early if unchanged, removes the old tail, stores the new key, computes and appends a new tail if needed, and preserves bottom-follow scrolling.

**Call relations**: The app draw loop calls this before rendering the transcript overlay. It uses `take_live_tail_renderable` and `live_tail_renderable`; the supplied callback does the actual active-cell line generation only when necessary.

*Call graph*: calls 2 internal fn (is_scrolled_to_bottom, take_live_tail_renderable); 1 external calls (live_tail_renderable).


##### `TranscriptOverlay::set_highlight_cell`  (lines 673–679)

```
fn set_highlight_cell(&mut self, cell: Option<usize>)
```

**Purpose**: Sets or clears the highlighted transcript cell used for edit navigation. When a cell is highlighted, the overlay scrolls it into view.

**Data flow**: It receives an optional cell index, stores it, rebuilds committed renderables with the new highlight style, and if a cell is selected, records a pending scroll-to-cell request.

**Call relations**: Editing flows call this when the user moves through transcript messages. It calls `rebuild_renderables` and then `PagerView::scroll_chunk_into_view`, which is resolved on the next render.

*Call graph*: calls 2 internal fn (scroll_chunk_into_view, rebuild_renderables).


##### `TranscriptOverlay::is_scrolled_to_bottom`  (lines 685–687)

```
fn is_scrolled_to_bottom(&self) -> bool
```

**Purpose**: Exposes whether the transcript pager is pinned to the bottom. The app uses this to decide whether live-tail animations should keep running.

**Data flow**: It reads the inner pager state and returns the result of its bottom-checking logic.

**Call relations**: The app draw loop can call this without reaching into `PagerView`. It simply delegates to `PagerView::is_scrolled_to_bottom`.

*Call graph*: calls 1 internal fn (is_scrolled_to_bottom).


##### `TranscriptOverlay::rebuild_renderables`  (lines 689–695)

```
fn rebuild_renderables(&mut self)
```

**Purpose**: Rebuilds the committed transcript renderables while preserving the optional live tail. This is the safe reset path after history or highlighting changes.

**Data flow**: It removes the live tail if present, rebuilds renderables from the committed cells and highlight setting, then appends the saved tail again.

**Call relations**: `replace_cells`, `consolidate_cells`, and `set_highlight_cell` call this after changing transcript state. It depends on `take_live_tail_renderable` and `render_cells`.

*Call graph*: calls 1 internal fn (take_live_tail_renderable); called by 3 (consolidate_cells, replace_cells, set_highlight_cell); 1 external calls (render_cells).


##### `TranscriptOverlay::take_live_tail_renderable`  (lines 702–704)

```
fn take_live_tail_renderable(&mut self) -> Option<Box<dyn Renderable>>
```

**Purpose**: Removes and returns the cached live-tail renderable if one is currently appended. It treats the live tail as the single extra block after all committed cells.

**Data flow**: It compares the number of renderables with the number of committed cells. If there is an extra final renderable, it pops and returns it; otherwise it returns nothing.

**Call relations**: `insert_cell`, `rebuild_renderables`, and `sync_live_tail` call this before changing committed content or replacing the tail. The method relies on the invariant that the live tail is always last.

*Call graph*: called by 3 (insert_cell, rebuild_renderables, sync_live_tail).


##### `TranscriptOverlay::live_tail_renderable`  (lines 706–722)

```
fn live_tail_renderable(
        lines: Vec<HyperlinkLine>,
        has_prior_cells: bool,
        is_stream_continuation: bool,
    ) -> Box<dyn Renderable>
```

**Purpose**: Builds the renderable block for in-progress transcript output. It adds top spacing when the live tail follows prior non-continuation content.

**Data flow**: It receives hyperlink-aware lines, whether committed cells come before it, and whether the tail continues the previous stream. It wraps the lines in a cached renderable and, when needed, wraps that in an inset that adds one blank row above.

**Call relations**: `sync_live_tail` calls this after computing fresh live-tail lines. The returned block is appended to the pager after committed cells.

*Call graph*: calls 3 internal fn (new, tlbr, new); 1 external calls (new).


##### `TranscriptOverlay::render_hints`  (lines 724–771)

```
fn render_hints(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Draws the two-line footer of keyboard hints for the transcript overlay. It includes scrolling shortcuts, quit instructions, and edit-navigation hints.

**Data flow**: It receives a footer area and buffer. It splits the footer into two rows, picks compact key examples from the keymap, builds hint pairs, and draws them through `render_key_hints`.

**Call relations**: `TranscriptOverlay::render` calls this after drawing the pager. It uses `first_or_empty` and shared hint rendering so hints match the configured keymap.

*Call graph*: calls 2 internal fn (first_or_empty, render_key_hints); called by 1 (render); 2 external calls (new, vec!).


##### `TranscriptOverlay::render`  (lines 773–779)

```
fn render(&mut self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Draws the full transcript overlay, including the pager and bottom shortcut hints. It reserves the last three rows for help text.

**Data flow**: It receives the whole terminal area and buffer. It splits the area into a main pager region and a footer region, renders the pager above, then renders transcript-specific hints below.

**Call relations**: `TranscriptOverlay::handle_event` calls this during draw and resize events, and tests call it directly. It delegates the main document work to `PagerView::render`.

*Call graph*: calls 2 internal fn (render, render_hints); called by 1 (transcript_line_numbers); 1 external calls (new).


##### `TranscriptOverlay::handle_event`  (lines 783–802)

```
fn handle_event(&mut self, tui: &mut tui::Tui, event: TuiEvent) -> Result<()>
```

**Purpose**: Responds to terminal events while the transcript overlay is active. It closes on close keys, scrolls on pager keys, and redraws on draw or resize events.

**Data flow**: It receives the TUI object and an event. For key events, it sets `is_done` on close keys or passes navigation keys to the pager; for draw and resize, it asks the TUI to draw the overlay; other events are ignored.

**Call relations**: `Overlay::handle_event` routes transcript events here. It calls `PagerView::handle_key_event` for scrolling and the TUI draw function for screen updates.

*Call graph*: calls 1 internal fn (handle_key_event); 1 external calls (draw).


##### `TranscriptOverlay::is_done`  (lines 803–805)

```
fn is_done(&self) -> bool
```

**Purpose**: Reports whether the transcript overlay should close. It becomes true when the user presses a configured close key.

**Data flow**: It reads and returns the overlay’s `is_done` flag.

**Call relations**: `Overlay::is_done` delegates here when the active overlay is a transcript overlay. The flag is set by `TranscriptOverlay::handle_event`.


##### `TranscriptOverlay::committed_cell_count`  (lines 808–810)

```
fn committed_cell_count(&self) -> usize
```

**Purpose**: Returns the number of committed transcript cells for tests. It helps verify that overlay synchronization keeps the expected committed history.

**Data flow**: It reads the `cells` vector length and returns it.

**Call relations**: This function is compiled only for tests. It gives tests a safe way to inspect internal transcript state without exposing it in normal builds.


##### `StaticOverlay::with_title`  (lines 819–830)

```
fn with_title(
        lines: Vec<Line<'static>>,
        title: String,
        keymap: PagerKeymap,
    ) -> Self
```

**Purpose**: Builds a static overlay from plain text lines and a title. It is the simple path for fixed pages that do not need custom renderable widgets.

**Data flow**: It receives text lines, a title, and a keymap. It creates a wrapped paragraph from the lines, wraps that in a cached renderable, and forwards to `StaticOverlay::with_renderables`.

**Call relations**: `Overlay::new_static_with_lines` and test helpers call this. It converts plain text into the richer renderable form used by the pager.

*Call graph*: called by 2 (new_static_with_lines, static_overlay); 4 external calls (new, with_renderables, from, vec!).


##### `StaticOverlay::with_renderables`  (lines 832–841)

```
fn with_renderables(
        renderables: Vec<Box<dyn Renderable>>,
        title: String,
        keymap: PagerKeymap,
    ) -> Self
```

**Purpose**: Builds a static overlay from renderable content blocks. This is the base constructor for fixed-content pager screens.

**Data flow**: It receives renderables, a title, and a keymap. It creates a `PagerView` starting at the top and stores it with `is_done` set to false.

**Call relations**: `Overlay::new_static_with_renderables` calls this directly, and `with_title` calls it after turning lines into a paragraph. It uses `PagerView::new` for the shared scrolling machinery.

*Call graph*: calls 1 internal fn (new); called by 1 (new_static_with_renderables).


##### `StaticOverlay::render_hints`  (lines 843–876)

```
fn render_hints(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Draws the footer shortcuts for a static overlay. It shows scrolling, paging, jumping, and quitting instructions.

**Data flow**: It receives a footer area and buffer. It splits the area into two rows, collects representative keys from the keymap, and draws both hint lines with `render_key_hints`.

**Call relations**: `StaticOverlay::render` calls this after drawing the pager. It shares `first_or_empty` and `render_key_hints` with the transcript footer.

*Call graph*: calls 2 internal fn (first_or_empty, render_key_hints); called by 1 (render); 2 external calls (new, vec!).


##### `StaticOverlay::render`  (lines 878–884)

```
fn render(&mut self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Draws the full static overlay, with scrollable content above and key hints below. It uses the same visual layout as the transcript overlay.

**Data flow**: It receives the full terminal area and buffer. It reserves three rows at the bottom, renders the pager in the top area, and paints static-overlay hints in the bottom area.

**Call relations**: `StaticOverlay::handle_event` calls this during draw and resize events, and tests call it directly. It delegates scrolling layout to `PagerView::render`.

*Call graph*: calls 2 internal fn (render, render_hints); 1 external calls (new).


##### `StaticOverlay::handle_event`  (lines 888–905)

```
fn handle_event(&mut self, tui: &mut tui::Tui, event: TuiEvent) -> Result<()>
```

**Purpose**: Responds to terminal events while a static overlay is active. It closes on the close key, scrolls on pager keys, and redraws when asked.

**Data flow**: It receives the TUI object and an event. Key events either set `is_done` or go to the pager; draw and resize events cause the overlay to be drawn; all other events are ignored.

**Call relations**: `Overlay::handle_event` routes static-overlay events here. It uses `PagerView::handle_key_event` for navigation and the TUI draw call for screen updates.

*Call graph*: calls 1 internal fn (handle_key_event); 1 external calls (draw).


##### `StaticOverlay::is_done`  (lines 906–908)

```
fn is_done(&self) -> bool
```

**Purpose**: Reports whether the static overlay has been closed. The app uses this to know when it can leave overlay mode.

**Data flow**: It returns the stored `is_done` flag.

**Call relations**: `Overlay::is_done` delegates here for static overlays. The flag is changed by `StaticOverlay::handle_event` when the close key is pressed.


##### `render_offset_content`  (lines 911–936)

```
fn render_offset_content(
    area: Rect,
    buf: &mut Buffer,
    renderable: &dyn Renderable,
    scroll_offset: u16,
) -> u16
```

**Purpose**: Draws the lower visible part of a renderable whose top has scrolled off-screen. It is a small off-screen drawing trick used when a content block starts above the viewport.

**Data flow**: It receives the visible area, output buffer, renderable, and number of rows to skip. It renders the needed portion into a temporary buffer, copies the visible rows into the real buffer, and returns how many rows were copied.

**Call relations**: `PagerView::render_content` calls this when a renderable is partly above the visible area. This lets renderables stay simple: they can draw from their own top, while this helper handles clipping.

*Call graph*: called by 1 (render_content); 4 external calls (empty, new, desired_height, render).


##### `tests::TestCell::display_lines`  (lines 966–968)

```
fn display_lines(&self, _width: u16) -> Vec<Line<'static>>
```

**Purpose**: Provides simple display lines for the test history cell. It lets tests use a minimal fake cell instead of real chat history types.

**Data flow**: It ignores the width and returns a clone of the stored lines.

**Call relations**: Tests use `TestCell` anywhere a `HistoryCell` is needed. This method satisfies the `HistoryCell` trait.


##### `tests::TestCell::raw_lines`  (lines 970–972)

```
fn raw_lines(&self) -> Vec<Line<'static>>
```

**Purpose**: Provides raw lines for the fake test cell. For this simple cell, raw lines are the same as displayed lines.

**Data flow**: It returns a clone of the stored test lines.

**Call relations**: This exists to complete the `HistoryCell` trait for `TestCell`. The tests can then pass `TestCell` into transcript overlay constructors.


##### `tests::TestCell::transcript_lines`  (lines 974–976)

```
fn transcript_lines(&self, _width: u16) -> Vec<Line<'static>>
```

**Purpose**: Provides transcript lines for the fake test cell. It keeps tests predictable by returning exactly the lines placed in the cell.

**Data flow**: It ignores width and returns a clone of the stored lines.

**Call relations**: Transcript rendering code calls this through the `HistoryCell` trait during tests. It makes snapshot and scrolling tests easy to reason about.


##### `tests::paragraph_block`  (lines 979–986)

```
fn paragraph_block(label: &str, lines: usize) -> Box<dyn Renderable>
```

**Purpose**: Creates a simple renderable paragraph with numbered lines for pager tests. It is used to test content height and chunk scrolling without real transcript cells.

**Data flow**: It receives a label and line count. It builds lines like `label0`, `label1`, wraps them in text and a paragraph widget, boxes the paragraph, and returns it as a renderable.

**Call relations**: Pager-specific tests call this to build predictable renderable chunks. Those chunks are then passed to `tests::pager_view`.

*Call graph*: 3 external calls (new, new, from).


##### `tests::default_pager_keymap`  (lines 988–990)

```
fn default_pager_keymap() -> crate::keymap::PagerKeymap
```

**Purpose**: Returns the default pager key bindings for tests. This avoids repeating keymap setup in every test.

**Data flow**: It asks the runtime keymap for defaults and returns the pager portion.

**Call relations**: Test helper constructors call this when creating transcript overlays, static overlays, or pager views.

*Call graph*: calls 1 internal fn (defaults).


##### `tests::transcript_overlay`  (lines 992–994)

```
fn transcript_overlay(cells: Vec<Arc<dyn HistoryCell>>) -> TranscriptOverlay
```

**Purpose**: Builds a transcript overlay for tests using the default pager keymap. It keeps test setup short.

**Data flow**: It receives test history cells, gets the default keymap, creates a `TranscriptOverlay`, and returns it.

**Call relations**: Many transcript overlay tests call this helper. It delegates to `TranscriptOverlay::new`.

*Call graph*: calls 1 internal fn (new); 1 external calls (default_pager_keymap).


##### `tests::static_overlay`  (lines 996–998)

```
fn static_overlay(lines: Vec<Line<'static>>, title: &str) -> StaticOverlay
```

**Purpose**: Builds a static overlay for tests from lines and a title. It supplies default pager keys automatically.

**Data flow**: It receives lines and a title string, creates a default keymap, calls `StaticOverlay::with_title`, and returns the overlay.

**Call relations**: Static overlay snapshot and wrapping tests use this helper. It delegates to the production constructor.

*Call graph*: calls 1 internal fn (with_title); 1 external calls (default_pager_keymap).


##### `tests::pager_view`  (lines 1000–1011)

```
fn pager_view(
        renderables: Vec<Box<dyn Renderable>>,
        title: &str,
        scroll_offset: usize,
    ) -> PagerView
```

**Purpose**: Builds a pager view for tests with predictable title, content, scroll offset, and default keys. It lets tests exercise pager behavior directly.

**Data flow**: It receives renderables, title, and scroll offset. It adds the default pager keymap and returns a `PagerView`.

**Call relations**: Pager unit tests call this helper before checking height, scrolling, and bottom detection. It delegates to `PagerView::new`.

*Call graph*: calls 1 internal fn (new); 1 external calls (default_pager_keymap).


##### `tests::edit_prev_hint_is_visible`  (lines 1014–1029)

```
fn edit_prev_hint_is_visible()
```

**Purpose**: Checks that the transcript overlay footer shows the `edit prev` hint. This protects a user-facing shortcut prompt from disappearing.

**Data flow**: It creates a one-cell transcript overlay, renders it into a wide buffer, converts the buffer to text, and asserts that the text contains `edit prev`.

**Call relations**: This test uses `tests::transcript_overlay` and `tests::buffer_to_text`. It indirectly exercises `TranscriptOverlay::render_hints`.

*Call graph*: 6 external calls (empty, new, assert!, buffer_to_text, transcript_overlay, vec!).


##### `tests::edit_next_hint_is_visible_when_highlighted`  (lines 1032–1048)

```
fn edit_next_hint_is_visible_when_highlighted()
```

**Purpose**: Checks that the `edit next` hint appears when a transcript cell is highlighted. This confirms the footer changes when edit navigation mode is active.

**Data flow**: It creates an overlay, highlights the first cell, renders into a buffer, turns the buffer into text, and asserts that `edit next` is present.

**Call relations**: This test calls `TranscriptOverlay::set_highlight_cell` through normal overlay state, then verifies the rendered hints.

*Call graph*: 6 external calls (empty, new, assert!, buffer_to_text, transcript_overlay, vec!).


##### `tests::transcript_overlay_snapshot_basic`  (lines 1051–1068)

```
fn transcript_overlay_snapshot_basic()
```

**Purpose**: Captures the basic look of a transcript overlay with a few cells. Snapshot testing helps catch accidental visual changes.

**Data flow**: It creates an overlay with three fake cells, draws it into a test terminal, and compares the backend output to a stored snapshot.

**Call relations**: This test uses `tests::transcript_overlay` and the real `TranscriptOverlay::render` path through terminal drawing.

*Call graph*: 5 external calls (new, assert_snapshot!, new, transcript_overlay, vec!).


##### `tests::transcript_overlay_preserves_semantic_web_links`  (lines 1071–1089)

```
fn transcript_overlay_preserves_semantic_web_links()
```

**Purpose**: Verifies that committed transcript content keeps terminal hyperlinks after rendering. This protects clickable links in the transcript overlay.

**Data flow**: It creates a markdown history cell containing a URL, renders the overlay into a buffer, and asserts that at least one buffer cell contains the terminal hyperlink escape sequence for that URL.

**Call relations**: This test exercises `CellRenderable::render`, `visible_lines`, and `mark_buffer_hyperlinks` through normal transcript overlay rendering.

*Call graph*: 5 external calls (empty, new, assert!, transcript_overlay, vec!).


##### `tests::transcript_overlay_renders_live_tail`  (lines 1092–1110)

```
fn transcript_overlay_renders_live_tail()
```

**Purpose**: Checks that the transcript overlay can show in-progress live-tail content after committed cells. It verifies the visible layout with a snapshot.

**Data flow**: It creates an overlay with one committed cell, syncs a live tail containing `tail`, draws the overlay, and compares the terminal output to a snapshot.

**Call relations**: This test drives `TranscriptOverlay::sync_live_tail` and then normal rendering. It confirms that the live tail is appended to pager content.

*Call graph*: 5 external calls (new, assert_snapshot!, new, transcript_overlay, vec!).


##### `tests::transcript_overlay_live_tail_preserves_semantic_web_links`  (lines 1113–1141)

```
fn transcript_overlay_live_tail_preserves_semantic_web_links()
```

**Purpose**: Verifies that live-tail content also preserves terminal hyperlinks. This matters because streamed output may contain links before it is committed.

**Data flow**: It creates a markdown cell with a URL, opens an empty transcript overlay, syncs the live tail from that cell’s hyperlink lines, renders, and checks the buffer for the hyperlink escape sequence.

**Call relations**: This test exercises `TranscriptOverlay::sync_live_tail`, `HyperlinkLinesRenderable::render`, and hyperlink marking for uncommitted content.

*Call graph*: calls 1 internal fn (new); 6 external calls (empty, new, new, assert!, new, transcript_overlay).


##### `tests::transcript_overlay_sync_live_tail_is_noop_for_identical_key`  (lines 1144–1166)

```
fn transcript_overlay_sync_live_tail_is_noop_for_identical_key()
```

**Purpose**: Checks that live-tail recomputation is skipped when the cache key has not changed. This protects the performance optimization described at the top of the file.

**Data flow**: It creates an overlay and a call counter, syncs a live tail twice with the same key, and asserts that the line-computing callback ran only once.

**Call relations**: This test focuses on `TranscriptOverlay::sync_live_tail`. It confirms that identical keys return early before calling the supplied compute function again.

*Call graph*: 4 external calls (assert_eq!, new, transcript_overlay, vec!).


##### `tests::buffer_to_text`  (lines 1168–1186)

```
fn buffer_to_text(buf: &Buffer, area: Rect) -> String
```

**Purpose**: Turns a terminal buffer region into plain text for assertions. It makes visual tests easier to read and compare.

**Data flow**: It receives a buffer and rectangle. It walks each cell, appends the first displayed character or a space, trims trailing spaces per line, and returns the accumulated string.

**Call relations**: Several tests call this after rendering overlays or pager views. It is a test-only inspection helper, not part of production drawing.

*Call graph*: 3 external calls (bottom, right, new).


##### `tests::transcript_overlay_apply_patch_scroll_vt100_clears_previous_page`  (lines 1189–1251)

```
fn transcript_overlay_apply_patch_scroll_vt100_clears_previous_page()
```

**Purpose**: Checks that rendering after scrolling does not leave stale characters from a previous page. This protects terminal output correctness for complex transcript cells.

**Data flow**: It builds several realistic history cells involving patch events, approval decisions, and command output, renders the overlay, changes scroll offset, renders again into the same buffer, converts it to text, and compares a snapshot.

**Call relations**: This test exercises the real transcript rendering path, including `PagerView::render_content` cleanup behavior. It helps ensure old buffer contents are cleared when the visible page changes.

*Call graph*: 15 external calls (new, empty, from_millis, new, from, new, new, assert_snapshot!, new_active_exec_command, new_patch_event (+5 more)).


##### `tests::transcript_overlay_keeps_scroll_pinned_at_bottom`  (lines 1254–1278)

```
fn transcript_overlay_keeps_scroll_pinned_at_bottom()
```

**Purpose**: Verifies that adding a committed cell keeps the transcript at the bottom when it was already following the bottom. This is the expected live transcript behavior.

**Data flow**: It creates a long overlay, renders once to establish layout, asserts it is at bottom, inserts a new cell, and checks that the scroll offset is the special bottom marker.

**Call relations**: This test drives `TranscriptOverlay::insert_cell` after `PagerView::is_scrolled_to_bottom` has been primed by rendering.

*Call graph*: 7 external calls (new, new, assert!, assert_eq!, new, transcript_overlay, vec!).


##### `tests::transcript_overlay_preserves_manual_scroll_position`  (lines 1281–1302)

```
fn transcript_overlay_preserves_manual_scroll_position()
```

**Purpose**: Verifies that adding a cell does not drag the user to the bottom if they manually scrolled up. This protects readers from losing their place.

**Data flow**: It creates and renders a long overlay, manually sets the scroll offset to the top, inserts a new cell, and asserts the offset is still zero.

**Call relations**: This test exercises the non-following branch of `TranscriptOverlay::insert_cell`.

*Call graph*: 6 external calls (new, new, assert_eq!, new, transcript_overlay, vec!).


##### `tests::transcript_overlay_consolidation_remaps_highlight_inside_range`  (lines 1305–1329)

```
fn transcript_overlay_consolidation_remaps_highlight_inside_range()
```

**Purpose**: Checks that when highlighted cells are consolidated, a highlight inside the replaced range moves to the new consolidated cell. This keeps edit selection meaningful after history changes.

**Data flow**: It creates an overlay, highlights a cell within a range, consolidates that range into one cell, and asserts the highlight now points to the replacement index.

**Call relations**: This test focuses on the highlight-adjustment logic inside `TranscriptOverlay::consolidate_cells`.

*Call graph*: 4 external calls (new, assert_eq!, transcript_overlay, vec!).


##### `tests::transcript_overlay_consolidation_remaps_highlight_after_range`  (lines 1332–1356)

```
fn transcript_overlay_consolidation_remaps_highlight_after_range()
```

**Purpose**: Checks that a highlighted cell after a consolidated range shifts left by the right amount. This keeps highlight indices aligned with the changed cell list.

**Data flow**: It creates an overlay, highlights a later cell, consolidates earlier cells into one, and asserts the highlight index moved to the new equivalent position.

**Call relations**: This test exercises the second highlight-remapping path inside `TranscriptOverlay::consolidate_cells`.

*Call graph*: 4 external calls (new, assert_eq!, transcript_overlay, vec!).


##### `tests::static_overlay_snapshot_basic`  (lines 1359–1369)

```
fn static_overlay_snapshot_basic()
```

**Purpose**: Captures the basic appearance of a static overlay. It guards against accidental visual changes to fixed-content pages.

**Data flow**: It creates a static overlay with three lines and a title, draws it in a test terminal, and compares the backend output with a snapshot.

**Call relations**: This test uses `tests::static_overlay` and the production `StaticOverlay::render` path.

*Call graph*: 5 external calls (new, assert_snapshot!, new, static_overlay, vec!).


##### `tests::transcript_line_numbers`  (lines 1372–1395)

```
fn transcript_line_numbers(overlay: &mut TranscriptOverlay, area: Rect) -> Vec<usize>
```

**Purpose**: Extracts visible `line-NN` numbers from a rendered transcript overlay. It supports paging tests by turning rendered output into a simple list of visible line indexes.

**Data flow**: It renders the overlay into a buffer, calculates the pager content area, scans each visible row for words starting with `line-`, parses numbers, and returns them in display order.

**Call relations**: `tests::transcript_overlay_paging_is_continuous_and_round_trips` calls this repeatedly to inspect what page is visible after scroll changes.

*Call graph*: calls 1 internal fn (render); 4 external calls (empty, new, new, new).


##### `tests::transcript_overlay_paging_is_continuous_and_round_trips`  (lines 1398–1463)

```
fn transcript_overlay_paging_is_continuous_and_round_trips()
```

**Purpose**: Verifies that page up and page down move by exactly one visible page and can round-trip. This protects paging from skipping or repeating lines unexpectedly.

**Data flow**: It creates a 50-line transcript, renders once to prime layout, records visible line numbers at different scroll offsets, simulates page movements by changing offset, and asserts continuity and reversibility.

**Call relations**: This test uses `tests::transcript_line_numbers` and indirectly checks `PagerView::page_height` and layout caching.

*Call graph*: 5 external calls (empty, new, assert_eq!, transcript_line_numbers, transcript_overlay).


##### `tests::static_overlay_wraps_long_lines`  (lines 1466–1475)

```
fn static_overlay_wraps_long_lines()
```

**Purpose**: Checks that long static overlay lines wrap correctly in a narrow terminal. This protects readability on small screens.

**Data flow**: It creates a static overlay with one long line, draws it in a narrow test terminal, and compares the result to a snapshot.

**Call relations**: This test exercises `StaticOverlay::with_title`, paragraph wrapping, and `PagerView::render`.

*Call graph*: 5 external calls (new, assert_snapshot!, new, static_overlay, vec!).


##### `tests::pager_view_content_height_counts_renderables`  (lines 1478–1489)

```
fn pager_view_content_height_counts_renderables()
```

**Purpose**: Verifies that pager content height is the sum of its renderable blocks. This is a basic layout rule used by scrolling.

**Data flow**: It builds a pager with two paragraph blocks of known heights, asks for content height, and asserts the total equals the expected sum.

**Call relations**: This test directly checks `PagerView::content_height` using renderables from `tests::paragraph_block`.

*Call graph*: 3 external calls (assert_eq!, pager_view, vec!).


##### `tests::pager_view_ensure_chunk_visible_scrolls_down_when_needed`  (lines 1492–1524)

```
fn pager_view_ensure_chunk_visible_scrolls_down_when_needed()
```

**Purpose**: Checks that the pager scrolls down enough to show a later content chunk. This protects highlighted-cell scrolling and similar navigation.

**Data flow**: It creates a pager with several chunks, asks it to ensure the third chunk is visible, renders, converts the buffer to text, and asserts all lines of that chunk are visible.

**Call relations**: This test calls `PagerView::ensure_chunk_visible` directly and then confirms the result through `PagerView::render` and `tests::buffer_to_text`.

*Call graph*: 6 external calls (empty, new, assert!, buffer_to_text, pager_view, vec!).


##### `tests::pager_view_ensure_chunk_visible_scrolls_up_when_needed`  (lines 1527–1543)

```
fn pager_view_ensure_chunk_visible_scrolls_up_when_needed()
```

**Purpose**: Checks that the pager scrolls upward when the desired chunk is above the current view. This complements the scroll-down case.

**Data flow**: It creates a pager, sets its scroll offset below the first chunk, asks for the first chunk to be visible, and asserts the scroll offset becomes zero.

**Call relations**: This test directly targets the upward branch of `PagerView::ensure_chunk_visible`.

*Call graph*: 4 external calls (new, assert_eq!, pager_view, vec!).


##### `tests::pager_view_is_scrolled_to_bottom_accounts_for_wrapped_height`  (lines 1546–1569)

```
fn pager_view_is_scrolled_to_bottom_accounts_for_wrapped_height()
```

**Purpose**: Verifies that bottom detection uses rendered content height, including wrapping. This prevents the overlay from wrongly thinking it is at the bottom.

**Data flow**: It creates a pager with tall content, renders it, checks that offset zero is not bottom, then sets the offset to the special bottom marker, renders again, and checks that it is bottom.

**Call relations**: This test exercises `PagerView::render` and `PagerView::is_scrolled_to_bottom` together, using cached layout height from the render.

*Call graph*: 5 external calls (empty, new, assert!, pager_view, vec!).


### Keymap editing flow
These files define configurable keymap actions and build the picker, editor, debug inspector, and chat-widget integration for interactive remapping.

### `tui/src/chatwidget/keymap_picker.rs`

`orchestration` · `request handling`

This file is the bridge between the main chat widget and the keymap setup screens. A keymap is the list of keyboard shortcuts the terminal user interface responds to. The actual picker screens and editing rules live elsewhere, in `keymap_setup`; this file decides when to open those screens, what current shortcut data to pass in, and how to refresh the chat widget after a change.

The main idea is consistency. If a user remaps a key, the program must not only change the stored configuration. It must also update the live shortcut tables that are already being used by the chat screen and bottom pane. Otherwise the interface could show the new shortcut while parts of the app still listen for the old one.

The methods here open the root keymap picker, action-specific menus, key-capture views, a debug inspector, and a replacement menu for actions that have more than one shortcut. They also guide the user back to the right row after an edit, like returning someone to the same shelf in a store after they changed an item. If the saved keymap is invalid, the file shows an error instead of building a picker from bad data.

#### Function details

##### `ChatWidget::open_keymap_picker`  (lines 30–44)

```
fn open_keymap_picker(&mut self)
```

**Purpose**: Opens the main `/keymap` picker using the current saved shortcut settings. It first checks that those settings can be turned into a working runtime keymap, so the user does not edit from broken or stale shortcut data.

**Data flow**: It reads `self.config.tui_keymap`, tries to build a `RuntimeKeymap` from it, and then uses that working keymap plus a small action filter to build the picker rows. If that succeeds, the bottom pane changes to the selection view. If it fails, the chat widget adds an error message explaining that the `tui.keymap` configuration is invalid.

**Call relations**: This is the entry point when the chat widget needs to show the root keymap picker. It calls `keymap_action_filter` to include current widget state, asks `RuntimeKeymap::from_config` to validate and expand the saved settings, and then hands the prepared picker parameters to the bottom pane.

*Call graph*: calls 2 internal fn (keymap_action_filter, from_config); 2 external calls (format!, build_keymap_picker_params_with_filter).


##### `ChatWidget::open_keymap_action_menu`  (lines 51–64)

```
fn open_keymap_action_menu(
        &mut self,
        context: String,
        action: String,
        runtime_keymap: &RuntimeKeymap,
    )
```

**Purpose**: Opens the menu for one specific shortcut action, such as an action the user selected from the root picker. It shows the choices for that action using the already-resolved runtime keymap passed in by the caller.

**Data flow**: It receives a context name, an action name, and a `RuntimeKeymap`. It combines those with the saved keymap configuration to build menu parameters, then tells the bottom pane to show that selection menu.

**Call relations**: This is used after a user chooses an action from the keymap picker. Instead of recalculating the keymap, it trusts the runtime keymap supplied with that app event, then calls `build_keymap_action_menu_params` to prepare the submenu shown in the bottom pane.

*Call graph*: calls 1 internal fn (build_keymap_action_menu_params).


##### `ChatWidget::open_keymap_capture`  (lines 71–87)

```
fn open_keymap_capture(
        &mut self,
        context: String,
        action: String,
        intent: KeymapEditIntent,
        runtime_keymap: &RuntimeKeymap,
    )
```

**Purpose**: Opens a view that waits for the user to press a key for a shortcut edit. This is used when the user wants to set, replace, or add an alternate binding for an action.

**Data flow**: It receives the action location, the edit intent, and the current runtime keymap. It also clones the chat widget’s app-event sender so the capture view can report the pressed key back through the normal event path. The resulting capture view is placed in the bottom pane, and the screen is marked for redraw.

**Call relations**: This follows a menu choice that requires a new keypress from the user. It delegates the actual key interpretation to `build_keymap_capture_view`, then wraps the view for the bottom pane. By sending the captured key back through the app-event path, later persistence and live keymap refresh logic are not skipped.

*Call graph*: calls 1 internal fn (build_keymap_capture_view); 1 external calls (new).


##### `ChatWidget::open_keymap_debug`  (lines 90–94)

```
fn open_keymap_debug(&mut self, runtime_keymap: &RuntimeKeymap)
```

**Purpose**: Opens a keypress inspector that shows how the current shortcut bindings are understood. This is useful for diagnosing what the terminal is sending and which bindings are active.

**Data flow**: It receives the current runtime keymap and reads the saved keymap configuration. It builds a debug view from those two sources, places that view in the bottom pane, and requests a redraw so it appears immediately.

**Call relations**: This is called when the keymap flow needs to show diagnostic information rather than an editing menu. It hands the current keymap data to `build_keymap_debug_view`, then displays the resulting view through the same bottom-pane mechanism as the other keymap screens.

*Call graph*: 2 external calls (new, build_keymap_debug_view).


##### `ChatWidget::open_keymap_replace_binding_menu`  (lines 101–110)

```
fn open_keymap_replace_binding_menu(
        &mut self,
        context: String,
        action: String,
        runtime_keymap: &RuntimeKeymap,
    )
```

**Purpose**: Opens a menu that lets the user choose which existing shortcut binding should be replaced. This matters for actions that have multiple keys, because replacing one should not accidentally remove the others.

**Data flow**: It receives a context, an action, and the current runtime keymap. It builds selection parameters for the replace-binding menu and asks the bottom pane to show that menu.

**Call relations**: This sits between choosing an action and capturing a new key when there is more than one existing binding. It calls `build_keymap_replace_binding_menu_params` so the next capture step can know exactly which old binding the user meant to replace.

*Call graph*: calls 1 internal fn (build_keymap_replace_binding_menu_params).


##### `ChatWidget::return_to_keymap_picker`  (lines 118–150)

```
fn return_to_keymap_picker(
        &mut self,
        context: &str,
        action: &str,
        runtime_keymap: &RuntimeKeymap,
    )
```

**Purpose**: Returns the user to the root keymap picker after an edit, with the edited action selected. It tries to replace old keymap submenus instead of piling up outdated screens in the bottom pane’s navigation stack.

**Data flow**: It receives the edited context and action plus the current runtime keymap. It builds picker parameters that highlight that action, then asks the bottom pane to replace any active keymap picker or submenu views with the refreshed picker. If that replacement is not possible, it shows a fresh picker instead. Finally, it requests a redraw.

**Call relations**: This is used after a keymap edit has been applied or when navigation should return to the main picker. It calls `keymap_action_filter` and `build_keymap_picker_params_for_selected_action_with_filter`; then it either refreshes the existing keymap view stack or falls back to opening a new picker so the user does not remain on stale edit screens.

*Call graph*: calls 1 internal fn (keymap_action_filter); 1 external calls (build_keymap_picker_params_for_selected_action_with_filter).


##### `ChatWidget::keymap_action_filter`  (lines 152–156)

```
fn keymap_action_filter(&self) -> keymap_setup::KeymapActionFilter
```

**Purpose**: Builds a small filter describing which keymap actions should be shown for the chat widget’s current mode. Right now it records whether fast mode is enabled.

**Data flow**: It reads `self.fast_mode_enabled()` from the chat widget and places that boolean value into a `KeymapActionFilter`. The returned filter is then used when building picker rows.

**Call relations**: This helper is called by `open_keymap_picker` and `return_to_keymap_picker`. In both cases, it gives the picker-building code just enough current widget state to decide which shortcut actions are relevant.

*Call graph*: called by 2 (open_keymap_picker, return_to_keymap_picker).


##### `ChatWidget::apply_keymap_update`  (lines 164–180)

```
fn apply_keymap_update(
        &mut self,
        keymap_config: TuiKeymap,
        runtime_keymap: &RuntimeKeymap,
    )
```

**Purpose**: Applies an already-committed shortcut update to the live chat widget. The caller is expected to have saved the configuration first; this method makes the running interface agree with that saved change.

**Data flow**: It receives the new `TuiKeymap` configuration and the matching `RuntimeKeymap`. It stores the new config in the widget, refreshes cached shortcut bindings such as copy-last-response and queued-message editing, updates the bottom pane’s shortcut bindings, and requests a redraw.

**Call relations**: This is called after a keymap edit has been accepted and persisted. It calls `queued_message_edit_hint_binding` with terminal information from `terminal_info` so the visible hint matches the current terminal, then pushes the updated bindings into the bottom pane. This keeps saved settings, cached app shortcuts, and active UI handlers in sync.

*Call graph*: 2 external calls (terminal_info, queued_message_edit_hint_binding).


### `tui/src/keymap_setup.rs`

`domain_logic` · `request handling`

This file is the guided remapping flow for keyboard shortcuts. Without it, users could see shortcuts elsewhere in the app, but they would not have an in-app way to safely change them. The flow works like a small wizard: first it shows the user a list of actions, then an action-specific menu, then a temporary screen that waits for exactly one keypress. The file does not write config files itself. Instead, it sends app events with enough information for the main app layer to validate, save, reload, and report errors.

A key idea here is that the currently active shortcut may come from defaults, from a global fallback, or from user config. The menus show that resolved, current truth. But when the user edits, the result is written to a concrete root config slot such as `tui.keymap.composer.submit`.

The file also converts terminal key events into config strings like `ctrl-alt-k` or `shift-page-down`. It rejects keys that cannot be stored. Conflict checking is intentionally left to the runtime keymap code, so the same rules are used everywhere instead of being copied into this UI.

#### Function details

##### `key_binding_span`  (lines 85–91)

```
fn key_binding_span(binding: &str) -> ratatui::text::Span<'static>
```

**Purpose**: Formats a shortcut name for display in the terminal UI. It makes real bindings stand out and makes the word `unbound` look quieter.

**Data flow**: It receives a binding string. If the string is `unbound`, it creates a dim display span; otherwise it creates a cyan display span. The returned span is later placed into menu text.

**Call relations**: This is a small display helper used while building keymap UI text. It supports the action menu by making the current binding easy to scan.


##### `keymap_action_menu_hint_line`  (lines 93–100)

```
fn keymap_action_menu_hint_line() -> Line<'static>
```

**Purpose**: Builds the short footer hint shown at the bottom of keymap menus. It tells the user that Enter selects and Esc goes back.

**Data flow**: It takes no input. It creates a styled line made from the words `enter`, `select`, `esc`, and `back`. The line is returned for use by selection views.

**Call relations**: The action menu and the replace-binding menu both call this when they prepare their footer. It keeps those menus using the same instructions.

*Call graph*: called by 2 (build_keymap_action_menu_params, build_keymap_replace_binding_menu_params); 2 external calls (from, vec!).


##### `open_capture_action`  (lines 102–114)

```
fn open_capture_action(
    context: String,
    action: String,
    intent: KeymapEditIntent,
) -> Box<dyn Fn(&AppEventSender) + Send + Sync>
```

**Purpose**: Creates a menu action that opens the key-capture screen for a chosen shortcut edit. It packages the chosen context, action, and edit intent into an app event.

**Data flow**: It receives the shortcut context, action, and intent. It returns a boxed callback; when that callback is later run with an event sender, it sends an `OpenKeymapCapture` event using cloned copies of those values.

**Call relations**: Menu rows use this helper when selecting a row should move the user into key capture. The actual opening is done later by the app event loop.

*Call graph*: 1 external calls (new).


##### `action_menu_item`  (lines 116–135)

```
fn action_menu_item(
    name: &str,
    description: &str,
    selected_description: String,
    context: &str,
    action: &str,
    intent: KeymapEditIntent,
) -> SelectionItem
```

**Purpose**: Builds one selectable row in the action-specific shortcut menu. It is used for choices such as replacing a binding or adding an alternate binding.

**Data flow**: It receives the row label, descriptions, target shortcut, and edit intent. It creates a `SelectionItem` with one action: open the key-capture view for that edit. The finished row is returned to the menu builder.

**Call relations**: The main action-menu builder calls this several times so repeated row setup stays consistent. The row hands off to `open_capture_action` so selection becomes an app event.

*Call graph*: called by 1 (build_keymap_action_menu_params); 2 external calls (default, vec!).


##### `build_keymap_action_menu_params`  (lines 144–303)

```
fn build_keymap_action_menu_params(
    context: String,
    action: String,
    runtime_keymap: &RuntimeKeymap,
    keymap_config: &TuiKeymap,
) -> SelectionViewParams
```

**Purpose**: Builds the menu shown after a user chooses one shortcut action. This menu decides whether the user can set, replace, add, replace one of many, or clear a custom binding.

**Data flow**: It receives the selected context and action, the resolved runtime keymap, and the root keymap config. It reads the active bindings and whether a custom config value exists, builds a header explaining the current state, creates the right menu rows, and returns `SelectionViewParams` for the bottom-pane selection UI.

**Call relations**: The app calls this when opening the action menu, and tests exercise it directly. It relies on helpers such as `active_binding_specs`, `has_custom_binding`, `action_menu_item`, and `keymap_action_menu_hint_line`; selected rows then emit events that continue the remapping flow.

*Call graph*: calls 6 internal fn (action_menu_item, action_label, active_binding_specs, has_custom_binding, keymap_action_menu_hint_line, new); called by 6 (open_keymap_action_menu, action_menu_content_snapshot, action_menu_disables_clear_when_action_has_no_custom_binding, capture_completion_returns_to_selected_keymap_picker_row, clear_completion_returns_to_selected_keymap_picker_row, replace_one_completion_drops_focused_keymap_submenus); 6 external calls (new, default, from, new, format!, vec!).


##### `build_keymap_replace_binding_menu_params`  (lines 305–354)

```
fn build_keymap_replace_binding_menu_params(
    context: String,
    action: String,
    runtime_keymap: &RuntimeKeymap,
) -> SelectionViewParams
```

**Purpose**: Builds the submenu used when an action has multiple shortcuts and the user wants to replace just one. It lets the user choose which existing key should be swapped out.

**Data flow**: It receives a context, action, and runtime keymap. It looks up the active binding strings, turns each one into a selectable row, and returns menu parameters whose row actions open key capture with a `ReplaceOne` intent.

**Call relations**: The app opens this after the main action menu asks for `Replace one binding...`. Each row sends an `OpenKeymapCapture` event so the next step can capture the replacement key.

*Call graph*: calls 4 internal fn (action_label, active_binding_specs, keymap_action_menu_hint_line, new); called by 3 (open_keymap_replace_binding_menu, action_menu_content_snapshot, replace_one_completion_drops_focused_keymap_submenus); 4 external calls (new, default, from, vec!).


##### `build_keymap_conflict_params`  (lines 356–395)

```
fn build_keymap_conflict_params(
    context: String,
    action: String,
    key: String,
    intent: KeymapEditIntent,
    error: String,
) -> SelectionViewParams
```

**Purpose**: Builds the popup shown when a captured key cannot be used for the chosen shortcut. It gives the user a simple choice: try another key or cancel.

**Data flow**: It receives the shortcut identity, the attempted key, the original edit intent, and an error message. It creates selection parameters with a title, explanatory text, and two rows. The retry row sends another `OpenKeymapCapture` event.

**Call relations**: The app calls this after applying a captured key fails validation. It keeps the user in the same editing story instead of leaving them with only an error.

*Call graph*: calls 1 internal fn (standard_popup_hint_line); called by 1 (apply_keymap_capture); 4 external calls (default, from, format!, vec!).


##### `build_keymap_capture_view`  (lines 403–422)

```
fn build_keymap_capture_view(
    context: String,
    action: String,
    intent: KeymapEditIntent,
    runtime_keymap: &RuntimeKeymap,
    app_event_tx: AppEventSender,
) -> KeymapCaptureView
```

**Purpose**: Creates the temporary screen that waits for the user's next keypress. It shows the action being edited and its current binding before capture begins.

**Data flow**: It receives the target shortcut, edit intent, current runtime keymap, and app event sender. It looks up and formats the current binding summary, labels the action, and returns a new `KeymapCaptureView` ready to render and receive key events.

**Call relations**: The app calls this when it handles an `OpenKeymapCapture` event. The returned view later sends a `KeymapCaptured` event after the user presses a valid key.

*Call graph*: calls 4 internal fn (new, action_label, bindings_for_action, format_binding_summary); called by 2 (open_keymap_capture, capture_completion_returns_to_selected_keymap_picker_row).


##### `keymap_with_replacement`  (lines 425–432)

```
fn keymap_with_replacement(
    keymap: &TuiKeymap,
    context: &str,
    action: &str,
    key: &str,
) -> Result<TuiKeymap, String>
```

**Purpose**: Test-only helper that creates a copy of a keymap with one action replaced by one key. It makes tests shorter and easier to read.

**Data flow**: It receives a keymap, context, action, and key string. It wraps the key in a one-item list and delegates to `keymap_with_bindings`. The result is either the edited keymap or an error for an unknown action.

**Call relations**: Many tests call this to prepare customized keymaps. It is a narrow wrapper around the more general `keymap_with_bindings` helper.

*Call graph*: calls 1 internal fn (keymap_with_bindings); called by 9 (action_menu_content_snapshot, capture_completion_returns_to_selected_keymap_picker_row, clear_completion_returns_to_selected_keymap_picker_row, clear_removes_custom_binding, debug_view_uses_custom_binding_source, picker_custom_render_snapshot, picker_customized_tab_contains_root_overrides, replacement_rejects_unknown_action, replacement_sets_single_binding).


##### `keymap_with_edit`  (lines 442–507)

```
fn keymap_with_edit(
    keymap: &TuiKeymap,
    runtime_keymap: &RuntimeKeymap,
    context: &str,
    action: &str,
    key: &str,
    intent: &KeymapEditIntent,
) -> Result<KeymapEditOutcome, Strin
```

**Purpose**: Applies one captured key to one shortcut action and returns the edited root keymap config. It is the main editing rule engine for replace, add alternate, and replace-one operations.

**Data flow**: It receives the old root config, the current resolved runtime keymap, the selected action, the captured key, and the edit intent. It reads the active bindings, computes the next binding list, detects no-op changes and stale replace-one choices, then returns either an unchanged message or an updated config plus a user-facing message.

**Call relations**: The app calls this after key capture. It relies on `active_binding_specs`, `dedup_bindings`, and `keymap_with_bindings`, while tests cover the important edit cases and stale-menu protection.

*Call graph*: calls 3 internal fn (active_binding_specs, dedup_bindings, keymap_with_bindings); called by 8 (apply_keymap_capture, add_alternate_duplicate_is_noop, add_alternate_grows_default_multi_binding, add_alternate_grows_single_binding, replace_all_collapses_multi_binding_to_single, replace_one_deduplicates_replacement, replace_one_preserves_other_bindings, replace_one_rejects_stale_old_key); 3 external calls (new, format!, vec!).


##### `keymap_with_bindings`  (lines 509–528)

```
fn keymap_with_bindings(
    keymap: &TuiKeymap,
    context: &str,
    action: &str,
    keys: &[String],
) -> Result<TuiKeymap, String>
```

**Purpose**: Writes a concrete list of key strings into one root keymap slot. It is the low-level helper that actually changes the copied config object.

**Data flow**: It receives a keymap, context, action, and list of key strings. It clones the keymap, finds the matching config slot, stores either a single binding or many bindings, and returns the changed copy. If the action is unknown, it returns an error.

**Call relations**: `keymap_with_edit` and test helpers call this when they need to materialize a new config value. It depends on `binding_slot` from the actions module to find the right field.

*Call graph*: calls 1 internal fn (binding_slot); called by 6 (keymap_with_edit, keymap_with_replacement, action_menu_content_snapshot, replace_all_collapses_multi_binding_to_single, replace_one_deduplicates_replacement, replace_one_preserves_other_bindings); 4 external calls (new, Many, One, clone).


##### `active_binding_specs`  (lines 536–548)

```
fn active_binding_specs(
    runtime_keymap: &RuntimeKeymap,
    context: &str,
    action: &str,
) -> Result<Vec<String>, String>
```

**Purpose**: Returns the active shortcuts for one action as config-style strings. This lets the UI show and preserve the same binding names that the config file uses.

**Data flow**: It receives the runtime keymap plus a context and action. It looks up the resolved bindings for that action, converts each terminal binding back into a config string, and returns the list. If the action is no longer known, it returns a stale-selection error.

**Call relations**: The action menu, replace-binding menu, and edit application path all call this. It keeps display and editing based on the resolved runtime keymap instead of guessing from raw config.

*Call graph*: calls 1 internal fn (bindings_for_action); called by 3 (build_keymap_action_menu_params, build_keymap_replace_binding_menu_params, keymap_with_edit).


##### `dedup_bindings`  (lines 550–557)

```
fn dedup_bindings(bindings: Vec<String>) -> Vec<String>
```

**Purpose**: Removes duplicate key strings while preserving the first occurrence. This prevents a replace-one edit from leaving the same shortcut listed twice.

**Data flow**: It receives a list of binding strings. It walks through them in order, keeps a new list, and only adds a key if it has not already appeared. The cleaned list is returned.

**Call relations**: `keymap_with_edit` calls this after replacing one binding, because the replacement key might already be used as another alternate for the same action.

*Call graph*: called by 1 (keymap_with_edit); 1 external calls (new).


##### `keymap_without_custom_binding`  (lines 564–575)

```
fn keymap_without_custom_binding(
    keymap: &TuiKeymap,
    context: &str,
    action: &str,
) -> Result<TuiKeymap, String>
```

**Purpose**: Removes the explicit root-level shortcut override for one action. This restores default or fallback behavior instead of explicitly unbinding the action.

**Data flow**: It receives a keymap, context, and action. It clones the keymap, finds the matching slot, sets that slot to `None`, and returns the changed copy. Unknown actions produce an error.

**Call relations**: The app calls this when handling a clear-keymap request. Tests verify that clearing is different from setting an empty binding list.

*Call graph*: calls 1 internal fn (binding_slot); called by 2 (apply_keymap_clear, clear_removes_custom_binding); 1 external calls (clone).


##### `has_custom_binding`  (lines 577–583)

```
fn has_custom_binding(keymap: &TuiKeymap, context: &str, action: &str) -> Result<bool, String>
```

**Purpose**: Checks whether one action currently has a root-level custom binding in the user config. It does not care what the resolved runtime shortcut is.

**Data flow**: It receives a keymap, context, and action. It clones the keymap, finds the matching slot, and returns whether that slot contains a value. Unknown actions produce an error.

**Call relations**: The action-menu builder calls this to decide whether the `Remove custom binding` row should be enabled or disabled.

*Call graph*: calls 1 internal fn (binding_slot); called by 1 (build_keymap_action_menu_params); 1 external calls (clone).


##### `KeymapCaptureView::new`  (lines 603–621)

```
fn new(
        context: String,
        action: String,
        intent: KeymapEditIntent,
        label: String,
        current_binding: String,
        app_event_tx: AppEventSender,
    ) -> Self
```

**Purpose**: Creates a new key-capture view with all the information needed to show instructions and report the captured key. It starts incomplete and with no error message.

**Data flow**: It receives the target action, edit intent, display label, current binding summary, and app event sender. It stores these values in a `KeymapCaptureView` and initializes `complete` to false. The view object is returned.

**Call relations**: `build_keymap_capture_view` uses this during normal app flow, while a snapshot test uses it directly to check the rendered screen.

*Call graph*: called by 2 (build_keymap_capture_view, capture_view_snapshot).


##### `KeymapCaptureView::lines`  (lines 623–650)

```
fn lines(&self, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Builds the text lines displayed by the capture screen. If the user pressed an unsupported key, it includes a wrapped error message.

**Data flow**: It receives the available width. It creates lines for the title, action, current binding, and instructions; if an error is stored, it wraps that error to fit the width and adds it in red. The list of lines is returned.

**Call relations**: Both rendering and height calculation call this, so the screen draws exactly as tall as the text it produces.

*Call graph*: called by 2 (desired_height, render); 5 external calls (from, new, wrap, from, vec!).


##### `KeymapCaptureView::render`  (lines 654–656)

```
fn render(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Draws the key-capture view into the terminal UI buffer. It shows the lines produced by `KeymapCaptureView::lines`.

**Data flow**: It receives a rectangle and a mutable screen buffer. It builds the display lines for the rectangle width, wraps them in a paragraph widget, and paints that paragraph into the buffer. It returns nothing but changes the buffer contents.

**Call relations**: The bottom-pane rendering system calls this through the `Renderable` trait. Tests also call it through a helper to compare snapshots.

*Call graph*: calls 1 internal fn (lines); called by 1 (render_capture); 1 external calls (new).


##### `KeymapCaptureView::desired_height`  (lines 658–660)

```
fn desired_height(&self, width: u16) -> u16
```

**Purpose**: Reports how many terminal rows the capture view wants. This lets the bottom pane reserve enough space for the instructions and any error.

**Data flow**: It receives a width, rebuilds the same lines that rendering would show, counts them, and returns that count as a height.

**Call relations**: The layout system calls this before rendering. It shares `lines` with `render`, which keeps sizing and drawing in sync.

*Call graph*: calls 1 internal fn (lines).


##### `KeymapCaptureView::handle_key_event`  (lines 664–688)

```
fn handle_key_event(&mut self, key_event: KeyEvent)
```

**Purpose**: Responds to the user's keypress while the capture view is active. It either cancels, ignores release events, sends a captured-key event, or shows an error for unsupported keys.

**Data flow**: It receives one terminal key event. Key-release events are ignored; Esc marks the view complete; other keys are converted to config strings. A valid key sends a `KeymapCaptured` event and completes the view, while an invalid key stores an error message for display.

**Call relations**: The bottom pane calls this when key input reaches the capture view. It hands successful captures back to the app layer by sending an event rather than editing config directly.

*Call graph*: calls 2 internal fn (send, key_event_to_config_key_spec); 1 external calls (clone).


##### `KeymapCaptureView::is_complete`  (lines 690–692)

```
fn is_complete(&self) -> bool
```

**Purpose**: Tells the bottom pane whether the capture view is done. A completed view can be dismissed.

**Data flow**: It reads the view's `complete` flag and returns it unchanged.

**Call relations**: The bottom pane checks this after input. `handle_key_event` and `on_ctrl_c` are the methods that set the flag.


##### `KeymapCaptureView::on_ctrl_c`  (lines 694–697)

```
fn on_ctrl_c(&mut self) -> CancellationEvent
```

**Purpose**: Handles Ctrl+C while capturing a shortcut by cancelling the capture. It marks the view complete and says the cancellation was handled.

**Data flow**: It mutates the view by setting `complete` to true, then returns a `Handled` cancellation result. No keymap event is sent.

**Call relations**: The bottom pane calls this when Ctrl+C is pressed. It gives the user a clean way to leave capture without changing the keymap.


##### `KeymapCaptureView::prefer_esc_to_handle_key_event`  (lines 699–701)

```
fn prefer_esc_to_handle_key_event(&self) -> bool
```

**Purpose**: Tells the bottom pane that this view wants to receive Esc itself. That allows Esc to cancel capture instead of being intercepted by a parent popup first.

**Data flow**: It takes no meaningful input and always returns true.

**Call relations**: The bottom pane uses this preference when routing Esc. The capture view then handles Esc in `handle_key_event`.


##### `key_event_to_config_key_spec`  (lines 704–706)

```
fn key_event_to_config_key_spec(key_event: KeyEvent) -> Result<String, String>
```

**Purpose**: Converts one terminal key event into the string format used in `tui.keymap`. For example, a terminal Ctrl+K event can become `ctrl-k`.

**Data flow**: It receives a terminal `KeyEvent`, turns it into the app's `KeyBinding` type, and delegates to `binding_to_config_key_spec`. The result is either a config string or an explanatory error.

**Call relations**: `KeymapCaptureView::handle_key_event` calls this after the user presses a key. It is the first step in making captured terminal input safe to store in config.

*Call graph*: calls 2 internal fn (from_event, binding_to_config_key_spec); called by 1 (handle_key_event).


##### `binding_to_config_key_spec`  (lines 708–711)

```
fn binding_to_config_key_spec(binding: KeyBinding) -> Result<String, String>
```

**Purpose**: Converts an internal key binding into the config-file spelling for that binding. It separates the key code from modifier keys before formatting.

**Data flow**: It receives a `KeyBinding`, extracts its key code and modifiers, and passes those pieces to `key_parts_to_config_key_spec`. It returns that function's success string or error.

**Call relations**: This is used by captured key conversion and by `active_binding_specs` through the same conversion path. It bridges the runtime key representation and stored config text.

*Call graph*: calls 2 internal fn (parts, key_parts_to_config_key_spec); called by 1 (key_event_to_config_key_spec).


##### `key_parts_to_config_key_spec`  (lines 713–767)

```
fn key_parts_to_config_key_spec(
    code: KeyCode,
    mut modifiers: KeyModifiers,
) -> Result<String, String>
```

**Purpose**: Turns a key code plus modifier keys into a valid keymap config string. It enforces which keys can be saved and normalizes things like uppercase letters into `shift-` forms.

**Data flow**: It receives a terminal key code and modifier flags. It normalizes them, rejects unsupported modifiers and unsupported keys, maps special keys to names such as `page-down` or `space`, adjusts uppercase characters to include Shift, and returns a formatted string.

**Call relations**: `binding_to_config_key_spec` delegates the real conversion rules here. This function calls `format_key_spec` once it has a safe key name.

*Call graph*: calls 2 internal fn (normalize_key_parts, format_key_spec); called by 1 (binding_to_config_key_spec); 3 external calls (difference, insert, format!).


##### `format_key_spec`  (lines 769–782)

```
fn format_key_spec(modifiers: KeyModifiers, key: &str) -> String
```

**Purpose**: Assembles modifier names and the base key name into the final config string. It keeps modifier order consistent.

**Data flow**: It receives modifier flags and a key name. It adds `ctrl`, `alt`, and `shift` in that order when present, appends the key, joins everything with hyphens, and returns the resulting string.

**Call relations**: `key_parts_to_config_key_spec` calls this for all supported keys. Tests check that the ordering is stable.

*Call graph*: called by 1 (key_parts_to_config_key_spec); 2 external calls (contains, new).


##### `tests::app_event_sender`  (lines 803–806)

```
fn app_event_sender() -> AppEventSender
```

**Purpose**: Creates a throwaway app event sender for tests. It lets UI objects be built without needing a full running application.

**Data flow**: It creates an unbounded channel, wraps the sender side in `AppEventSender`, ignores the receiver, and returns the sender.

**Call relations**: Rendering tests and picker tests call this when they need a sender but do not care about received events.

*Call graph*: calls 1 internal fn (new); 1 external calls (unbounded_channel).


##### `tests::render_capture`  (lines 808–813)

```
fn render_capture(view: &KeymapCaptureView, width: u16, height: u16) -> Buffer
```

**Purpose**: Renders a capture view into a test buffer. This makes snapshot tests compare the exact terminal output.

**Data flow**: It receives a capture view plus width and height. It creates an empty buffer, asks the view to render into it, and returns the filled buffer.

**Call relations**: The capture-view snapshot test uses this helper to keep rendering setup out of the assertion.

*Call graph*: calls 1 internal fn (render); 2 external calls (empty, new).


##### `tests::render_debug`  (lines 815–821)

```
fn render_debug(view: &KeymapDebugView, width: u16) -> String
```

**Purpose**: Renders the debug keymap view into a plain string for tests. It sizes the buffer using the view's requested height.

**Data flow**: It receives a debug view and width. It asks for the height, renders into a buffer, converts that buffer to text, and returns the text.

**Call relations**: Debug-view tests use this to compare initial, delayed-hint, and key-detected displays.

*Call graph*: calls 2 internal fn (desired_height, render); 3 external calls (empty, new, render_buffer).


##### `tests::render_picker`  (lines 823–827)

```
fn render_picker(params: SelectionViewParams, width: u16) -> String
```

**Purpose**: Renders picker parameters as a list selection view for snapshot tests. It supplies a default runtime key list and dummy sender.

**Data flow**: It receives selection parameters and width. It constructs a `ListSelectionView`, then delegates to `render_picker_from_view` to produce text.

**Call relations**: Several picker snapshot tests call this so they can test the final rendered menu rather than only the raw parameters.

*Call graph*: calls 2 internal fn (new, defaults); 2 external calls (app_event_sender, render_picker_from_view).


##### `tests::render_picker_from_view`  (lines 829–835)

```
fn render_picker_from_view(view: &ListSelectionView, width: u16) -> String
```

**Purpose**: Renders an already-built list selection view into a string. This is the common lower-level picker rendering helper for tests.

**Data flow**: It receives a list selection view and width. It asks the view for its height, renders it into a buffer, converts the buffer into lines of text, and returns the string.

**Call relations**: `tests::render_picker` calls this, and it can also be used when a test wants to inspect a view that was built separately.

*Call graph*: calls 2 internal fn (desired_height, render); 3 external calls (empty, new, render_buffer).


##### `tests::fast_mode_action_filter`  (lines 837–841)

```
fn fast_mode_action_filter() -> KeymapActionFilter
```

**Purpose**: Builds a test filter that enables fast-mode shortcut rows. It makes tests explicit about the feature being on.

**Data flow**: It takes no input and returns a `KeymapActionFilter` with `fast_mode_enabled` set to true.

**Call relations**: Fast-mode picker tests pass this into the picker builder to check that the optional action appears when enabled.


##### `tests::render_buffer`  (lines 843–860)

```
fn render_buffer(buf: &Buffer) -> String
```

**Purpose**: Converts a terminal buffer into a normal string for assertions. It trims empty space at the end of each line.

**Data flow**: It receives a buffer, walks through every row and column, reads each cell's symbol, substitutes spaces for empty cells, trims the right side of each row, and joins rows with newlines.

**Call relations**: Rendering helpers use this to turn UI output into snapshot-friendly text.

*Call graph*: 1 external calls (area).


##### `tests::test_pane`  (lines 862–876)

```
fn test_pane() -> (BottomPane, AppEventSender, UnboundedReceiver<AppEvent>)
```

**Purpose**: Creates a bottom pane, event sender, and event receiver for interaction tests. It gives tests a small working UI environment.

**Data flow**: It creates an event channel, wraps the sender, builds a `BottomPane` with test settings and focus enabled, and returns the pane, sender, and receiver.

**Call relations**: Completion-flow tests use this to simulate menu navigation, key capture, and view replacement without running the full app.

*Call graph*: calls 3 internal fn (new, new, test_dummy); 1 external calls (new).


##### `tests::selection_tab`  (lines 878–884)

```
fn selection_tab(params: &'a SelectionViewParams, id: &str) -> &'a SelectionTab
```

**Purpose**: Finds one tab inside selection parameters by id. It fails the test clearly if the tab is missing.

**Data flow**: It receives selection parameters and a tab id. It searches the tab list and returns a reference to the matching tab, or panics with `selection tab`.

**Call relations**: Many picker tests use this to inspect a specific tab such as All, Common, Custom, or Debug.


##### `tests::selection_item`  (lines 886–892)

```
fn selection_item(params: &'a SelectionViewParams, name: &str) -> &'a SelectionItem
```

**Purpose**: Finds one selection item by visible name. It keeps tests focused on the row they care about.

**Data flow**: It receives selection parameters and an item name. It searches the item list and returns the matching item, or panics with `selection item`.

**Call relations**: Action-menu tests use this to check row behavior such as whether `Remove custom binding` is disabled.


##### `tests::action_menu_rows`  (lines 894–908)

```
fn action_menu_rows(params: &SelectionViewParams) -> String
```

**Purpose**: Summarizes action-menu rows into simple text. It makes snapshot output small and readable.

**Data flow**: It receives selection parameters. For each item, it collects the name, description, and disabled reason or `enabled`, then joins those summaries with newlines.

**Call relations**: The action-menu snapshot test uses this instead of snapshotting the full UI object.


##### `tests::picker_covers_every_replaceable_action`  (lines 911–937)

```
fn picker_covers_every_replaceable_action()
```

**Purpose**: Checks that the keymap picker includes every action that can be remapped. It also verifies that each action has both a config slot and runtime bindings.

**Data flow**: It builds the default runtime keymap and picker parameters with fast mode enabled. It inspects the All tab and asserts that all action descriptors are represented and selectable without dismissing the picker.

**Call relations**: This test protects the contract between the action catalog, config slots, runtime keymap, and picker UI.

*Call graph*: calls 2 internal fn (defaults, build_keymap_picker_params_with_filter); 5 external calls (assert!, assert_eq!, default, fast_mode_action_filter, selection_tab).


##### `tests::picker_hides_fast_mode_action_when_feature_is_disabled`  (lines 940–951)

```
fn picker_hides_fast_mode_action_when_feature_is_disabled()
```

**Purpose**: Verifies that the fast-mode shortcut is hidden when the feature is not enabled. This prevents users from seeing a shortcut for unavailable behavior.

**Data flow**: It builds the default picker without the fast-mode filter. It inspects the All tab and asserts that no row is named `Toggle Fast Mode`.

**Call relations**: This test complements the enabled-fast-mode test and checks the picker filter behavior.

*Call graph*: calls 2 internal fn (defaults, build_keymap_picker_params); 3 external calls (assert!, default, selection_tab).


##### `tests::picker_shows_fast_mode_action_when_feature_is_enabled`  (lines 954–973)

```
fn picker_shows_fast_mode_action_when_feature_is_enabled()
```

**Purpose**: Verifies that the fast-mode shortcut appears when the feature is enabled. It checks several tabs, not just the full list.

**Data flow**: It builds picker parameters with a fast-mode-enabled filter. It reads the relevant tabs and asserts that each includes `Toggle Fast Mode`.

**Call relations**: This test proves that the action filter feeds into tab construction consistently.

*Call graph*: calls 2 internal fn (defaults, build_keymap_picker_params_with_filter); 4 external calls (assert!, default, fast_mode_action_filter, selection_tab).


##### `tests::keymap_picker_fast_mode_enabled_snapshot`  (lines 976–988)

```
fn keymap_picker_fast_mode_enabled_snapshot()
```

**Purpose**: Captures the rendered picker when fast mode is enabled. The snapshot catches accidental UI changes.

**Data flow**: It builds a default runtime keymap and picker with fast mode enabled, renders the picker at a wide width, and compares the result with a saved snapshot.

**Call relations**: This test uses the same picker-building path as normal UI code, then relies on snapshot testing for visual regression coverage.

*Call graph*: calls 2 internal fn (defaults, build_keymap_picker_params_with_filter); 3 external calls (assert_snapshot!, default, fast_mode_action_filter).


##### `tests::picker_common_tab_lists_curated_actions`  (lines 991–1034)

```
fn picker_common_tab_lists_curated_actions()
```

**Purpose**: Checks that the Common tab contains the intended hand-picked actions in the intended order. This keeps the shortcut editor useful for common tasks.

**Data flow**: It builds default picker parameters, finds the Common tab, extracts each item's searchable context/action identity, and compares the sequence to the expected list.

**Call relations**: This test guards the curated tab definition used by the picker module.

*Call graph*: calls 2 internal fn (defaults, build_keymap_picker_params); 3 external calls (assert_eq!, default, selection_tab).


##### `tests::picker_approval_tab_lists_all_approval_actions`  (lines 1037–1068)

```
fn picker_approval_tab_lists_all_approval_actions()
```

**Purpose**: Checks that the approval-related tab lists all approval shortcuts. This prevents approval controls from being accidentally omitted from remapping.

**Data flow**: It builds the default picker, finds the approval tab, extracts context/action identities from search values, and compares them with the expected approval action list.

**Call relations**: This test focuses on one action category and protects the picker tab grouping.

*Call graph*: calls 2 internal fn (defaults, build_keymap_picker_params); 3 external calls (assert_eq!, default, selection_tab).


##### `tests::picker_content_snapshot`  (lines 1071–1094)

```
fn picker_content_snapshot()
```

**Purpose**: Snapshots a concise summary of picker tab counts and the first actions. This catches broad changes to picker contents without storing the whole render.

**Data flow**: It builds default picker parameters, summarizes each tab's selectable count, adds details for the first All-tab rows, and compares the text with a snapshot.

**Call relations**: This test sits between detailed structural tests and full rendered snapshots.

*Call graph*: calls 2 internal fn (defaults, build_keymap_picker_params); 3 external calls (assert_snapshot!, default, selection_tab).


##### `tests::picker_customized_tab_contains_root_overrides`  (lines 1097–1120)

```
fn picker_customized_tab_contains_root_overrides()
```

**Purpose**: Verifies that actions with root-level custom bindings appear in the Custom tab. It also checks that normal category tabs show the custom binding text.

**Data flow**: It creates a keymap where `composer.submit` is customized, builds a runtime keymap from it, builds picker parameters, and inspects the Custom and Composer tabs.

**Call relations**: This test confirms that picker content reflects both raw config overrides and resolved runtime bindings.

*Call graph*: calls 3 internal fn (from_config, keymap_with_replacement, build_keymap_picker_params); 4 external calls (assert!, assert_eq!, default, selection_tab).


##### `tests::picker_unbound_tab_lists_default_unbound_actions`  (lines 1123–1135)

```
fn picker_unbound_tab_lists_default_unbound_actions()
```

**Purpose**: Checks that the Unbound tab lists actions that have no active default binding. It ensures those actions are still selectable for assignment.

**Data flow**: It builds the default picker, finds the Unbound tab, and asserts the expected two rows, their `unbound` descriptions, and that they are not disabled.

**Call relations**: This test protects the path for assigning shortcuts to actions that start without keys.

*Call graph*: calls 2 internal fn (defaults, build_keymap_picker_params); 4 external calls (assert!, assert_eq!, default, selection_tab).


##### `tests::picker_debug_tab_is_last_and_opens_inspector`  (lines 1138–1157)

```
fn picker_debug_tab_is_last_and_opens_inspector()
```

**Purpose**: Verifies that the Debug tab appears last and contains the keypress inspector entry. This gives users a way to diagnose what the terminal is sending.

**Data flow**: It builds default picker parameters, reads the last tab, and checks its id, label, item text, description, and footer hint.

**Call relations**: This test ties the picker UI to the debug view exposed by this module.

*Call graph*: calls 2 internal fn (defaults, build_keymap_picker_params); 3 external calls (assert!, assert_eq!, default).


##### `tests::picker_selected_action_starts_on_matching_all_tab_row`  (lines 1160–1175)

```
fn picker_selected_action_starts_on_matching_all_tab_row()
```

**Purpose**: Checks that reopening the picker after an edit returns focus to the edited action. This makes the user experience feel continuous.

**Data flow**: It builds picker parameters for a selected `composer.submit` action, finds the All tab, and asserts the initial tab and selected index match the Submit row.

**Call relations**: Completion-flow tests depend on this behavior after save or clear operations refresh the picker.

*Call graph*: calls 2 internal fn (defaults, build_keymap_picker_params_for_selected_action); 3 external calls (assert_eq!, default, selection_tab).


##### `tests::picker_all_tab_items_remain_searchable`  (lines 1178–1198)

```
fn picker_all_tab_items_remain_searchable()
```

**Purpose**: Ensures rows in the All tab keep useful search text. This protects keyboard searching inside the shortcut picker.

**Data flow**: It builds the default picker, extracts the first All-tab rows' names, descriptions, and search values, and compares that summary with a snapshot.

**Call relations**: This test watches the search metadata produced by the picker builder.

*Call graph*: calls 2 internal fn (defaults, build_keymap_picker_params); 3 external calls (assert_snapshot!, default, selection_tab).


##### `tests::picker_wide_render_snapshot`  (lines 1201–1206)

```
fn picker_wide_render_snapshot()
```

**Purpose**: Snapshots the keymap picker at a wide terminal width. It catches layout and content regressions in the full-width presentation.

**Data flow**: It builds default picker parameters, renders them at width 120, and compares the rendered text to a snapshot.

**Call relations**: This test uses the shared rendering helper and complements the narrow-width snapshot.

*Call graph*: calls 2 internal fn (defaults, build_keymap_picker_params); 2 external calls (assert_snapshot!, default).


##### `tests::picker_narrow_render_snapshot`  (lines 1209–1214)

```
fn picker_narrow_render_snapshot()
```

**Purpose**: Snapshots the keymap picker at a narrower terminal width. It protects the compact layout used in smaller terminals.

**Data flow**: It builds default picker parameters, renders them at width 78, and compares the result with a snapshot.

**Call relations**: Together with the wide snapshot, this checks that the picker adapts across terminal sizes.

*Call graph*: calls 2 internal fn (defaults, build_keymap_picker_params); 2 external calls (assert_snapshot!, default).


##### `tests::picker_custom_render_snapshot`  (lines 1217–1225)

```
fn picker_custom_render_snapshot()
```

**Purpose**: Snapshots the picker when a shortcut has been customized. This checks that custom bindings are displayed correctly.

**Data flow**: It creates a custom `composer.submit` binding, builds a runtime keymap and picker, renders the picker at a wide width, and compares the output to a snapshot.

**Call relations**: This test exercises the picker path with non-default config, using `keymap_with_replacement` as setup.

*Call graph*: calls 3 internal fn (from_config, keymap_with_replacement, build_keymap_picker_params); 2 external calls (assert_snapshot!, default).


##### `tests::picker_narrow_uses_compact_tabs`  (lines 1228–1238)

```
fn picker_narrow_uses_compact_tabs()
```

**Purpose**: Checks that the narrow picker render uses the compact tab layout. It ensures details that do not fit are omitted while key content remains.

**Data flow**: It renders the default picker at narrow width and asserts that important text is present while wide-only details are absent.

**Call relations**: This test gives targeted assertions alongside the narrow snapshot, making the intended compact behavior clear.

*Call graph*: calls 2 internal fn (defaults, build_keymap_picker_params); 3 external calls (assert!, default, render_picker).


##### `tests::action_menu_content_snapshot`  (lines 1241–1298)

```
fn action_menu_content_snapshot()
```

**Purpose**: Snapshots the rows shown by action menus for unbound, single-binding, multi-binding, and replace-binding cases. It protects the menu choices users see.

**Data flow**: It prepares several keymap states, builds the corresponding action or replace menus, summarizes their rows with `action_menu_rows`, and compares the combined text to a snapshot.

**Call relations**: This test covers the branching logic in `build_keymap_action_menu_params` and `build_keymap_replace_binding_menu_params`.

*Call graph*: calls 5 internal fn (from_config, build_keymap_action_menu_params, build_keymap_replace_binding_menu_params, keymap_with_bindings, keymap_with_replacement); 3 external calls (assert_snapshot!, default, action_menu_rows).


##### `tests::action_menu_disables_clear_when_action_has_no_custom_binding`  (lines 1301–1332)

```
fn action_menu_disables_clear_when_action_has_no_custom_binding()
```

**Purpose**: Verifies that `Remove custom binding` is disabled when there is no custom root override. It prevents a misleading clear action.

**Data flow**: It builds the action menu for a default binding, finds key rows, and asserts the remove row has the expected disabled reason while other row dismissal behavior is correct.

**Call relations**: This test specifically checks the `has_custom_binding` decision inside the action-menu builder.

*Call graph*: calls 2 internal fn (defaults, build_keymap_action_menu_params); 4 external calls (assert!, assert_eq!, default, selection_item).


##### `tests::capture_view_snapshot`  (lines 1335–1349)

```
fn capture_view_snapshot()
```

**Purpose**: Snapshots the key-capture screen. This protects the instructions and action display shown while waiting for a keypress.

**Data flow**: It constructs a `KeymapCaptureView`, renders it into a buffer, formats that buffer for debugging, and compares it with a snapshot.

**Call relations**: This test exercises `KeymapCaptureView::new`, `render`, and the line-building logic.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert_snapshot!, app_event_sender).


##### `tests::debug_view_initial_snapshot`  (lines 1352–1359)

```
fn debug_view_initial_snapshot()
```

**Purpose**: Snapshots the initial keymap debug view. This catches accidental changes to the keypress-inspector opening screen.

**Data flow**: It builds the debug view from default runtime and config keymaps, renders it, and compares it to a saved snapshot.

**Call relations**: This test covers the debug submodule re-exported by this file.

*Call graph*: calls 2 internal fn (defaults, build_keymap_debug_view); 2 external calls (assert_snapshot!, default).


##### `tests::debug_view_shows_delayed_missing_key_hint`  (lines 1362–1369)

```
fn debug_view_shows_delayed_missing_key_hint()
```

**Purpose**: Checks that the debug view can show a delayed hint when no keypress arrives. This helps users troubleshoot terminals that are not sending events.

**Data flow**: It builds the default debug view, forces the delayed hint for the test, renders it, checks for the hint text, and snapshots the result.

**Call relations**: This test exercises debug-view state changes without needing real time to pass.

*Call graph*: calls 2 internal fn (defaults, build_keymap_debug_view); 4 external calls (assert!, assert_snapshot!, default, render_debug).


##### `tests::debug_view_reports_detected_key_and_matching_actions`  (lines 1372–1381)

```
fn debug_view_reports_detected_key_and_matching_actions()
```

**Purpose**: Verifies that the debug view reports a pressed key and the actions that match it. This is the main diagnostic behavior of the inspector.

**Data flow**: It builds the debug view, forces the delayed hint, sends a Ctrl+O key event, renders the view, asserts the waiting hint is gone, and snapshots the match report.

**Call relations**: This test connects terminal key input to runtime keymap lookup inside the debug view.

*Call graph*: calls 2 internal fn (defaults, build_keymap_debug_view); 6 external calls (Char, new, assert!, assert_snapshot!, default, render_debug).


##### `tests::debug_view_uses_custom_binding_source`  (lines 1384–1395)

```
fn debug_view_uses_custom_binding_source()
```

**Purpose**: Checks that the debug view labels a direct custom binding as custom. This helps users understand why a key maps to an action.

**Data flow**: It creates a keymap with `global.copy` set to `ctrl-x`, builds runtime and debug views, sends Ctrl+X, renders the output, and asserts that the action and `[Custom]` label appear.

**Call relations**: This test verifies that debug output reflects root-level override information.

*Call graph*: calls 3 internal fn (from_config, build_keymap_debug_view, keymap_with_replacement); 5 external calls (Char, new, assert!, default, render_debug).


##### `tests::debug_view_labels_custom_global_fallback_source`  (lines 1398–1409)

```
fn debug_view_labels_custom_global_fallback_source()
```

**Purpose**: Checks that the debug view distinguishes custom global fallback bindings. This matters when a global binding affects another context.

**Data flow**: It sets a custom global binding for queue, builds runtime and debug views, sends Ctrl+Q, renders the output, and checks for the composer action plus `[Custom global]`.

**Call relations**: This test protects the source-labeling behavior for fallback resolution.

*Call graph*: calls 2 internal fn (from_config, build_keymap_debug_view); 7 external calls (Char, new, assert!, new, One, default, render_debug).


##### `tests::capture_completion_returns_to_selected_keymap_picker_row`  (lines 1412–1484)

```
fn capture_completion_returns_to_selected_keymap_picker_row()
```

**Purpose**: Tests the full happy path after capturing a replacement key. It ensures the UI returns to the refreshed main picker with the edited row selected.

**Data flow**: It creates a test pane, opens the picker and action menu, selects replace, receives the open-capture event, shows the capture view, sends a key, receives the captured event, applies a replacement in test setup, rebuilds picker parameters for the selected action, and replaces active views.

**Call relations**: This interaction test ties together menu actions, capture view events, key conversion, keymap editing setup, and bottom-pane view replacement.

*Call graph*: calls 7 internal fn (defaults, from_config, build_keymap_action_menu_params, build_keymap_capture_view, keymap_with_replacement, build_keymap_picker_params, build_keymap_picker_params_for_selected_action); 8 external calls (new, Char, new, assert!, assert_eq!, default, panic!, test_pane).


##### `tests::clear_completion_returns_to_selected_keymap_picker_row`  (lines 1487–1544)

```
fn clear_completion_returns_to_selected_keymap_picker_row()
```

**Purpose**: Tests the UI flow after clearing a custom binding. It ensures the refreshed picker is shown at the same action and old stacked popups are removed.

**Data flow**: It prepares a customized keymap, opens picker and action menu, selects clear, receives the clear event, rebuilds the default picker for the same action, replaces active views, and checks final navigation behavior.

**Call relations**: This test mirrors the real clear-completion flow used by the app after `keymap_without_custom_binding` succeeds.

*Call graph*: calls 6 internal fn (defaults, from_config, build_keymap_action_menu_params, keymap_with_replacement, build_keymap_picker_params, build_keymap_picker_params_for_selected_action); 6 external calls (new, assert!, assert_eq!, default, panic!, test_pane).


##### `tests::replace_one_completion_drops_focused_keymap_submenus`  (lines 1547–1591)

```
fn replace_one_completion_drops_focused_keymap_submenus()
```

**Purpose**: Checks that completing a replace-one edit removes both the replace submenu and its parent action menu. This avoids leaving stale menus behind.

**Data flow**: It opens the picker, action menu, and replace-binding submenu in a test pane. It then rebuilds picker parameters for the edited action, replaces all keymap-related active views, and verifies only the picker remains.

**Call relations**: This test protects bottom-pane cleanup after the deepest keymap editing path.

*Call graph*: calls 5 internal fn (defaults, build_keymap_action_menu_params, build_keymap_replace_binding_menu_params, build_keymap_picker_params, build_keymap_picker_params_for_selected_action); 5 external calls (new, assert!, assert_eq!, default, test_pane).


##### `tests::key_capture_serializes_modifier_order_for_config`  (lines 1594–1604)

```
fn key_capture_serializes_modifier_order_for_config()
```

**Purpose**: Checks that captured modifier keys are serialized in a stable order. Stable spelling avoids needless config churn and confusing output.

**Data flow**: It creates a Ctrl+Alt+uppercase K key event, converts it, and asserts the result is `ctrl-alt-shift-k`.

**Call relations**: This test covers `key_event_to_config_key_spec`, uppercase normalization, and `format_key_spec` ordering.

*Call graph*: 3 external calls (Char, new, assert_eq!).


##### `tests::key_capture_serializes_special_keys`  (lines 1607–1612)

```
fn key_capture_serializes_special_keys()
```

**Purpose**: Verifies that special keys such as Page Down can be saved with modifiers. This protects non-letter shortcut support.

**Data flow**: It creates a Shift+PageDown event, converts it, and checks for `shift-page-down`.

**Call relations**: This test covers the special-key mapping branch in `key_parts_to_config_key_spec`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::key_capture_serializes_function_keys_through_f24`  (lines 1615–1628)

```
fn key_capture_serializes_function_keys_through_f24()
```

**Purpose**: Checks the supported range for function keys. It allows F1 through F24 and rejects higher function keys with a clear message.

**Data flow**: It converts F13, F24, and F25 events. The first two must succeed, and F25 must return the expected error.

**Call relations**: This test protects the function-key limit based on `MAX_FUNCTION_KEY`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::key_capture_serializes_c0_control_chars_as_ctrl_bindings`  (lines 1631–1653)

```
fn key_capture_serializes_c0_control_chars_as_ctrl_bindings()
```

**Purpose**: Verifies that low-level terminal control characters become normal Ctrl bindings. Some terminals report Ctrl keys this way.

**Data flow**: It creates key events for control characters corresponding to Ctrl+J, Ctrl+U, and Ctrl+P, converts each, and checks the resulting strings.

**Call relations**: This test depends on key normalization before config formatting.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::key_capture_serializes_minus_as_named_key`  (lines 1656–1672)

```
fn key_capture_serializes_minus_as_named_key()
```

**Purpose**: Checks that the minus key is stored as `minus`, with modifiers when present. This avoids ambiguity with the hyphen separator used in key specs.

**Data flow**: It converts plain minus, Alt+minus, and Ctrl+Alt+minus events, then checks the returned strings.

**Call relations**: This test protects the special minus handling in `key_parts_to_config_key_spec`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::replacement_sets_single_binding`  (lines 1675–1686)

```
fn replacement_sets_single_binding()
```

**Purpose**: Verifies that replacing a binding writes a single binding value in the config. This checks the simplest config mutation shape.

**Data flow**: It creates a replacement keymap for `composer.submit` and asserts that the config slot contains exactly one `ctrl-enter` binding.

**Call relations**: This test covers `keymap_with_replacement` and the single-binding branch of `keymap_with_bindings`.

*Call graph*: calls 1 internal fn (keymap_with_replacement); 2 external calls (assert_eq!, default).


##### `tests::replace_all_collapses_multi_binding_to_single`  (lines 1689–1723)

```
fn replace_all_collapses_multi_binding_to_single()
```

**Purpose**: Checks that replacing all bindings turns a multi-binding action into a single captured key. This matches the meaning of `Replace all`.

**Data flow**: It starts with two bindings for `composer.submit`, builds a runtime keymap, applies a ReplaceAll edit, and asserts both the returned binding list and config contain only the new key.

**Call relations**: This test covers the ReplaceAll branch of `keymap_with_edit`.

*Call graph*: calls 3 internal fn (from_config, keymap_with_bindings, keymap_with_edit); 3 external calls (assert_eq!, default, panic!).


##### `tests::add_alternate_grows_single_binding`  (lines 1726–1754)

```
fn add_alternate_grows_single_binding()
```

**Purpose**: Checks that adding an alternate to a default single-binding action preserves the default and appends the new key. The default is materialized into config.

**Data flow**: It uses the default runtime keymap, applies AddAlternate to `composer.submit` with `ctrl-enter`, and asserts the result contains `enter` plus `ctrl-enter` as a multi-binding config value.

**Call relations**: This test covers the AddAlternate path in `keymap_with_edit` when the current binding comes from defaults.

*Call graph*: calls 2 internal fn (defaults, keymap_with_edit); 3 external calls (assert_eq!, default, panic!).


##### `tests::add_alternate_grows_default_multi_binding`  (lines 1757–1786)

```
fn add_alternate_grows_default_multi_binding()
```

**Purpose**: Checks that adding an alternate to an action with multiple default bindings keeps all existing defaults. The new key is appended after them.

**Data flow**: It applies AddAlternate to `editor.move_left`, then asserts the returned bindings and config include `left`, `ctrl-b`, and the new `ctrl-shift-b` key.

**Call relations**: This test protects the behavior where default runtime bindings are copied into root config before adding another binding.

*Call graph*: calls 2 internal fn (defaults, keymap_with_edit); 3 external calls (assert_eq!, default, panic!).


##### `tests::add_alternate_duplicate_is_noop`  (lines 1789–1807)

```
fn add_alternate_duplicate_is_noop()
```

**Purpose**: Verifies that adding an alternate key already used by the action does not change the config. It should report a friendly no-change message.

**Data flow**: It applies AddAlternate with `enter` to `composer.submit`, which already uses `enter` by default, and asserts the outcome is `Unchanged` with the expected message.

**Call relations**: This test covers the duplicate check in `keymap_with_edit`.

*Call graph*: calls 2 internal fn (defaults, keymap_with_edit); 2 external calls (assert_eq!, default).


##### `tests::replace_one_preserves_other_bindings`  (lines 1810–1847)

```
fn replace_one_preserves_other_bindings()
```

**Purpose**: Checks that replacing one binding leaves the action's other bindings alone. Only the selected old key should change.

**Data flow**: It starts with two bindings, applies ReplaceOne to swap `ctrl-enter` for `ctrl-shift-enter`, and asserts the other binding remains in the returned list and config.

**Call relations**: This test covers the ReplaceOne mapping logic in `keymap_with_edit`.

*Call graph*: calls 3 internal fn (from_config, keymap_with_bindings, keymap_with_edit); 3 external calls (assert_eq!, default, panic!).


##### `tests::replace_one_deduplicates_replacement`  (lines 1850–1886)

```
fn replace_one_deduplicates_replacement()
```

**Purpose**: Checks that replacing one binding with a key already present collapses duplicates. The final action should not list the same key twice.

**Data flow**: It starts with `ctrl-enter` and `ctrl-shift-enter`, replaces `ctrl-enter` with `ctrl-shift-enter`, and asserts the final config has one binding.

**Call relations**: This test specifically exercises the `dedup_bindings` call inside the ReplaceOne branch.

*Call graph*: calls 3 internal fn (from_config, keymap_with_bindings, keymap_with_edit); 3 external calls (assert_eq!, default, panic!).


##### `tests::replace_one_rejects_stale_old_key`  (lines 1889–1905)

```
fn replace_one_rejects_stale_old_key()
```

**Purpose**: Verifies that ReplaceOne fails if the selected old key is no longer active. This prevents stale menus from overwriting newer shortcut state.

**Data flow**: It uses the default runtime keymap and asks to replace a non-active `alt-enter` binding for `composer.submit`. It expects an error mentioning the action and stale key.

**Call relations**: This test protects the stale-selection guard in `keymap_with_edit`.

*Call graph*: calls 2 internal fn (defaults, keymap_with_edit); 2 external calls (assert!, default).


##### `tests::clear_removes_custom_binding`  (lines 1908–1923)

```
fn clear_removes_custom_binding()
```

**Purpose**: Checks that clearing a custom binding sets the config slot back to absent. That means defaults can take over again.

**Data flow**: It creates a custom binding, confirms `has_custom_binding` is true, clears it with `keymap_without_custom_binding`, then checks the slot is `None` and custom status is false.

**Call relations**: This test covers both the clear helper and the custom-binding detector.

*Call graph*: calls 2 internal fn (keymap_with_replacement, keymap_without_custom_binding); 2 external calls (assert_eq!, default).


##### `tests::replacement_rejects_unknown_action`  (lines 1926–1931)

```
fn replacement_rejects_unknown_action()
```

**Purpose**: Verifies that trying to edit an unknown action returns a useful error. This protects users from stale UI selections after config or code changes.

**Data flow**: It calls the replacement helper with context `composer` and action `nope`, expects an error, and checks that the unknown action name appears in it.

**Call relations**: This test covers the error path through `keymap_with_replacement` and `keymap_with_bindings`.

*Call graph*: calls 1 internal fn (keymap_with_replacement); 2 external calls (assert!, default).


### `tui/src/keymap_setup/debug.rs`

`domain_logic` · `active while the keymap debug bottom pane is open`

This file exists to solve a very practical shortcut problem: terminals do not always send the keys people think they send. A key may be swallowed by the terminal, changed into another key code, or arrive with different modifier keys such as Ctrl or Alt. Without this view, users trying to customize shortcuts would have to guess why a key binding does not work.

The main piece is `KeymapDebugView`, a small bottom-pane screen. When it opens, it shows instructions and waits for a keypress. If no key arrives after a few seconds, it changes the hint to explain that Codex can only inspect keys the terminal actually sends. This is like checking whether a doorbell is wired: if pressing the button produces no signal, the app cannot assign meaning to it.

When a key event does arrive, the view records a report. That report includes a friendly detected key label, the configuration spelling for that key if one exists, the raw terminal event for troubleshooting, and any Codex actions already assigned to that key. The view then renders those details as wrapped, dimmed terminal text so long messages still fit inside a narrow pane.

The pane treats Esc as another inspectable key rather than an automatic close command. Ctrl+C is the explicit way to close it.

#### Function details

##### `build_keymap_debug_view`  (lines 44–55)

```
fn build_keymap_debug_view(
    runtime_keymap: &RuntimeKeymap,
    keymap_config: &TuiKeymap,
) -> KeymapDebugView
```

**Purpose**: Creates a fresh keypress inspector view from the current runtime keymap and keymap configuration. It takes a snapshot of those settings so the debug screen can compare incoming keys against the bindings that are active when the view opens.

**Data flow**: It receives references to the active keymap and the saved keymap configuration. It clones both, records the current time as the opening time, starts with no key report, and marks the view as not complete. The result is a ready-to-render `KeymapDebugView`.

**Call relations**: Tests call this to create the debug pane in known states. In normal use, this is the constructor other keymap setup code would call when the user asks to inspect shortcut keys.

*Call graph*: called by 5 (debug_view_initial_snapshot, debug_view_labels_custom_global_fallback_source, debug_view_reports_detected_key_and_matching_actions, debug_view_shows_delayed_missing_key_hint, debug_view_uses_custom_binding_source); 3 external calls (now, clone, clone).


##### `KeymapDebugView::lines`  (lines 58–60)

```
fn lines(&self, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Builds the text lines that should be shown right now in the debug pane. It is the everyday rendering helper used by both drawing and height calculation.

**Data flow**: It takes the pane width, reads the current clock time, and passes both to `KeymapDebugView::lines_at`. It returns a list of styled terminal text lines ready to display.

**Call relations**: `render` uses this to draw the pane, and `desired_height` uses it to know how much vertical space the pane needs. It delegates the actual content choices to `lines_at`.

*Call graph*: calls 1 internal fn (lines_at); called by 2 (desired_height, render); 1 external calls (now).


##### `KeymapDebugView::lines_at`  (lines 62–130)

```
fn lines_at(&self, width: u16, now: Instant) -> Vec<Line<'static>>
```

**Purpose**: Assembles the full visible text for the keypress inspector. It decides whether to show the waiting message or the latest key report, and formats the report in a readable way.

**Data flow**: It receives a width and a time. It starts with the title and instructions, chooses either the short or delayed hint, wraps that hint to fit the width, and then checks whether a key has been recorded. If no key has been recorded, it adds a waiting message. If a report exists, it adds the detected key, configuration key or error, raw terminal event, and any matching assigned actions. It returns all of those as styled lines.

**Call relations**: `lines` calls this whenever the UI needs the current text. It calls `should_show_delayed_hint` to decide which hint to show, and `push_wrapped_dim` whenever a line may be too long for the pane.

*Call graph*: calls 2 internal fn (should_show_delayed_hint, push_wrapped_dim); called by 1 (lines); 4 external calls (from, format!, from, vec!).


##### `KeymapDebugView::should_show_delayed_hint`  (lines 132–134)

```
fn should_show_delayed_hint(&self, now: Instant) -> bool
```

**Purpose**: Decides whether the waiting hint should become more explicit. It helps users understand that if no key appears after a short wait, the terminal may not be sending that key to Codex at all.

**Data flow**: It receives the current time and reads when the view was opened and whether any key report exists. If no key has been received and at least three seconds have passed, it returns true. Otherwise it returns false.

**Call relations**: `lines_at` calls this while building the visible message. Its answer changes the text from a short tip to a fuller explanation.

*Call graph*: called by 1 (lines_at); 1 external calls (duration_since).


##### `KeymapDebugView::show_delayed_hint_for_test`  (lines 137–139)

```
fn show_delayed_hint_for_test(&mut self)
```

**Purpose**: For tests only, forces the view into the state where the delayed missing-key hint should appear. This avoids making tests actually wait for several seconds.

**Data flow**: It changes the stored opening time to appear as though the pane opened at least three seconds ago. It does not return anything; it only updates the view’s internal clock marker.

**Call relations**: Test code can call this before rendering the view. Then the normal `lines_at` path will show the delayed hint without any special testing branch in the display code.

*Call graph*: 1 external calls (now).


##### `KeymapDebugView::render`  (lines 143–145)

```
fn render(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Draws the keypress inspector into the terminal screen area assigned to it. This is the bridge between the view’s text model and the terminal UI drawing system.

**Data flow**: It receives a rectangle describing where to draw and a buffer representing the terminal screen being prepared. It asks `lines` for the current text, puts those lines into a paragraph widget, and renders that paragraph into the buffer. The buffer is changed; no separate value is returned.

**Call relations**: The broader terminal rendering code calls this through the `Renderable` interface. It depends on `lines` for the content and on the UI library’s paragraph widget to paint that content.

*Call graph*: calls 1 internal fn (lines); called by 1 (render_debug); 1 external calls (new).


##### `KeymapDebugView::desired_height`  (lines 147–149)

```
fn desired_height(&self, width: u16) -> u16
```

**Purpose**: Reports how many terminal rows the debug pane would like to use at a given width. This lets the layout code reserve enough space for the wrapped text.

**Data flow**: It receives the available width, builds the current display lines with `lines`, counts them, and returns that count as a height. It does not change the view.

**Call relations**: The rendering flow calls this before or during layout. Because it uses the same `lines` helper as `render`, the requested height matches what will actually be drawn.

*Call graph*: calls 1 internal fn (lines); called by 1 (render_debug).


##### `KeymapDebugView::handle_key_event`  (lines 153–168)

```
fn handle_key_event(&mut self, key_event: KeyEvent)
```

**Purpose**: Records what happened when the user pressed a key inside the inspector. It turns the raw terminal key event into a useful report for humans.

**Data flow**: It receives a key event from the terminal. If the event is only a key release, it ignores it because releases are not useful for shortcut binding. Otherwise it builds a new report: a friendly detected key label, the configuration spelling or an unsupported-key error, a raw debug summary, and the list of actions currently matched by that key. It stores that report as the latest report shown by the pane.

**Call relations**: The bottom-pane input system calls this when key events arrive. It hands off to `KeyBinding::from_event`, `key_event_to_config_key_spec`, `key_event_debug_summary`, and `matching_actions_for_key_event` to translate the raw event into the pieces shown by `lines_at`.

*Call graph*: calls 3 internal fn (from_event, matching_actions_for_key_event, key_event_debug_summary); 1 external calls (key_event_to_config_key_spec).


##### `KeymapDebugView::is_complete`  (lines 170–172)

```
fn is_complete(&self) -> bool
```

**Purpose**: Tells the surrounding UI whether this debug pane has finished and can be closed. In this view, completion means the user pressed Ctrl+C.

**Data flow**: It reads the view’s internal `complete` flag and returns it. It does not change anything.

**Call relations**: The bottom-pane controller can call this after input handling or during its update loop. `on_ctrl_c` is the function that changes the flag this function reports.


##### `KeymapDebugView::on_ctrl_c`  (lines 174–177)

```
fn on_ctrl_c(&mut self) -> CancellationEvent
```

**Purpose**: Closes the keypress inspector when the user presses Ctrl+C. This gives the view a clear exit key while still allowing Esc to be inspected as a normal key.

**Data flow**: It changes the internal `complete` flag to true and returns a cancellation result saying the Ctrl+C was handled by this pane. After this, `is_complete` will report that the view is done.

**Call relations**: The bottom-pane input system calls this for Ctrl+C. It works together with `prefer_esc_to_handle_key_event`, which keeps Esc available for inspection instead of using it as the close action.


##### `KeymapDebugView::prefer_esc_to_handle_key_event`  (lines 179–181)

```
fn prefer_esc_to_handle_key_event(&self) -> bool
```

**Purpose**: Says that Esc should be passed into the inspector as a key to examine. This is important because users may want to know what Esc looks like and whether it is bound to anything.

**Data flow**: It takes no outside data beyond the view itself and always returns true. It does not change any state.

**Call relations**: The bottom-pane input system uses this preference when deciding whether Esc should close the pane or be delivered to `handle_key_event`. Because it returns true, Esc goes through the same reporting path as other keys.


##### `KeymapDebugView::next_frame_delay`  (lines 183–192)

```
fn next_frame_delay(&self) -> Option<Duration>
```

**Purpose**: Tells the UI when it should redraw next while waiting for the first keypress. This is needed so the short waiting hint can turn into the longer hint after three seconds even if the user does nothing.

**Data flow**: It checks whether a key report already exists. If a key has been received, it returns no delay because there is no timed hint left to show. If no key has been received, it calculates how long remains until the delayed hint should appear and returns that duration if it is still in the future.

**Call relations**: The UI loop can call this to schedule a future redraw. It supports the hint timing used by `should_show_delayed_hint` and `lines_at`.

*Call graph*: 1 external calls (checked_add).


##### `push_wrapped_dim`  (lines 195–210)

```
fn push_wrapped_dim(
    lines: &mut Vec<Line<'static>>,
    text: String,
    wrap_width: usize,
    initial_indent: &'static str,
    subsequent_indent: &'static str,
)
```

**Purpose**: Adds one or more dimmed text lines to the display, wrapping long text so it fits the pane width. It keeps messages readable in narrow terminal windows.

**Data flow**: It receives the growing list of lines, the text to add, the wrap width, and indentation strings for the first and following lines. It breaks the text into wrapped pieces, applies dim styling to each piece, and appends them to the line list. It changes the supplied list and returns nothing.

**Call relations**: `lines_at` calls this for hints, raw event text, unsupported-key messages, and action descriptions. It is the shared formatting helper that keeps the debug view from overflowing horizontally.

*Call graph*: called by 1 (lines_at); 2 external calls (new, wrap).


##### `key_event_debug_summary`  (lines 212–219)

```
fn key_event_debug_summary(key_event: KeyEvent) -> String
```

**Purpose**: Creates a compact raw summary of a terminal key event for troubleshooting. This is useful when the friendly key name is not enough to explain what the terminal sent.

**Data flow**: It receives a key event and reads its key code, modifier keys, and event kind. It formats those pieces into a single string, using `key_modifiers_debug_label` to make the modifiers readable. The string is returned for display in the report.

**Call relations**: `handle_key_event` calls this while building the latest report. The resulting text is later shown by `lines_at` under “Raw event.”

*Call graph*: called by 1 (handle_key_event); 1 external calls (format!).


##### `key_modifiers_debug_label`  (lines 221–243)

```
fn key_modifiers_debug_label(modifiers: KeyModifiers) -> String
```

**Purpose**: Turns modifier-key flags into a readable label such as `ctrl|alt` or `none`. Modifier keys are keys like Ctrl, Alt, and Shift that change the meaning of another keypress.

**Data flow**: It receives the set of modifier flags from a key event. If no modifiers are present, it returns `none`. Otherwise it checks for Ctrl, Alt, and Shift, adds their names, and also includes any unusual modifier flags in debug form. It returns the names joined with vertical bars.

**Call relations**: `key_event_debug_summary` uses this helper when building the raw event string. It keeps modifier formatting in one place so the summary stays simple and consistent.

*Call graph*: 5 external calls (contains, difference, is_empty, new, format!).


### `tui/src/keymap_setup/actions.rs`

`domain_logic` · `active during /keymap setup, shortcut display, and key-event debugging`

This file is like the index at the front of a keyboard-shortcut manual. It lists every configurable action, such as submitting a message, scrolling a pager, or approving a request, and gives each one a stable config name plus a friendly label and description for the UI.

The key problem it solves is consistency. A shortcut appears in several places: in the user-facing `/keymap` picker, in the editable configuration file, and in the resolved runtime keymap that the app actually uses while running. If these drift apart, the UI could show an action that cannot be edited, or edit a setting that does not affect the running app. This file keeps those links together.

It also handles a few user-facing details. It can hide actions that require a feature flag, turn an internal name like `open_transcript` into `Open Transcript`, summarize active bindings as text, and tell the debug UI whether a matching key came from a custom setting, a custom global fallback, or the default. The global fallback is important for composer actions: some old or shared global settings can still supply bindings for submit, queue, and shortcut toggling.

#### Function details

##### `action`  (lines 37–50)

```
fn action(
    context: &'static str,
    context_label: &'static str,
    action: &'static str,
    description: &'static str,
) -> KeymapActionDescriptor
```

**Purpose**: Creates a normal keymap action descriptor for an action that is always available. It is used to keep each catalog entry short and consistent.

**Data flow**: It takes the config context, the friendly group label, the action name, and the description. It packs those into a `KeymapActionDescriptor` and marks it as not requiring any special feature. The result is a descriptor ready to be placed in the action catalog.

**Call relations**: This helper feeds the `KEYMAP_ACTIONS` table. Later code reads those descriptors when building keymap menus, looking up bindings, or checking which action a pressed key matches.


##### `gated_action`  (lines 52–66)

```
fn gated_action(
    context: &'static str,
    context_label: &'static str,
    action: &'static str,
    description: &'static str,
    required_feature: KeymapActionFeature,
) -> KeymapActionDescri
```

**Purpose**: Creates a keymap action descriptor for an action that should only appear when a feature is enabled. In this file, that is used for actions such as Fast mode.

**Data flow**: It receives the same action details as `action`, plus the required feature. It returns a descriptor that carries that feature requirement, so visibility can be checked later.

**Call relations**: This helper is used when filling the action catalog with feature-gated entries. `KeymapActionDescriptor::is_visible` later reads the stored requirement to decide whether the UI should show the action.


##### `KeymapActionDescriptor::is_visible`  (lines 79–84)

```
fn is_visible(self, filter: KeymapActionFilter) -> bool
```

**Purpose**: Decides whether one catalog action should be shown to the user under the current feature settings. This keeps unavailable actions out of the `/keymap` UI.

**Data flow**: It takes a descriptor and a `KeymapActionFilter`, which currently says whether Fast mode is enabled. If the descriptor has no required feature, it returns `true`. If it requires Fast mode, it returns the filter’s Fast mode setting.

**Call relations**: Menu-building code can call this while walking through the action catalog. It uses the feature requirement recorded by `action` or `gated_action` and turns it into a simple yes-or-no display decision.


##### `action_label`  (lines 205–217)

```
fn action_label(action: &str) -> String
```

**Purpose**: Turns a stable internal action name into text that looks good in menus. For example, it changes an underscore-separated name into title-like words.

**Data flow**: It receives a string such as `open_transcript`. It splits the string on underscores, capitalizes the first letter of each part, and joins the parts with spaces. It returns a display string such as `Open Transcript` without changing the original config name.

**Call relations**: Keymap menu and capture screens call this when they need a friendly label. The important rule is one-way use: the display label is for humans, while the original action name remains the reliable config identifier.

*Call graph*: called by 3 (build_keymap_action_menu_params, build_keymap_capture_view, build_keymap_replace_binding_menu_params).


##### `binding_slot`  (lines 226–343)

```
fn binding_slot(
    keymap: &'a mut TuiKeymap,
    context: &str,
    action: &str,
) -> Option<&'a mut Option<KeybindingsSpec>>
```

**Purpose**: Finds the editable configuration field for a given action. This is what lets the `/keymap` editor read, change, remove, or explicitly unbind a shortcut in the user’s `TuiKeymap` settings.

**Data flow**: It receives a mutable `TuiKeymap`, plus a context name and action name. It matches that pair against the known catalog and returns a mutable pointer to the matching optional binding setting. If the pair is not recognized, it returns nothing.

**Call relations**: Editing helpers call this when checking whether a binding is custom, adding or replacing bindings, or removing a custom binding. `debug_binding_source` also uses it to tell whether a matching key came from an action-specific custom setting.

*Call graph*: called by 4 (debug_binding_source, has_custom_binding, keymap_with_bindings, keymap_without_custom_binding).


##### `bindings_for_action`  (lines 351–468)

```
fn bindings_for_action(
    runtime_keymap: &'a RuntimeKeymap,
    context: &str,
    action: &str,
) -> Option<&'a [KeyBinding]>
```

**Purpose**: Looks up the active runtime bindings for one action. Unlike `binding_slot`, this reads the already-resolved keymap, so it reflects defaults, fallbacks, unbindings, and validation.

**Data flow**: It receives a `RuntimeKeymap`, a context, and an action name. It matches the pair to the corresponding runtime binding list and returns that list as a slice. If the action is unknown, it returns nothing.

**Call relations**: Screens that display current shortcuts call this so the UI shows what will actually work right now. `matching_actions_for_key_event` also relies on it while checking whether a pressed key activates any catalog action.

*Call graph*: called by 2 (active_binding_specs, build_keymap_capture_view).


##### `format_binding_summary`  (lines 475–487)

```
fn format_binding_summary(bindings: &[KeyBinding]) -> String
```

**Purpose**: Turns a list of active key bindings into a compact string for menu display. It also avoids showing duplicate-looking bindings that come from compatibility variants.

**Data flow**: It receives a list of `KeyBinding` values. Each binding is converted back into a config-style key string when possible, duplicates are removed in sorted-set order, and the remaining strings are joined with commas. If nothing remains, it returns `unbound`.

**Call relations**: The keymap capture view calls this after it gets active bindings. It depends on the shared binding-to-config conversion so the text shown to users matches the format they would write in configuration.

*Call graph*: called by 1 (build_keymap_capture_view); 2 external calls (new, iter).


##### `KeymapDebugBindingSource::label`  (lines 497–503)

```
fn label(&self) -> &'static str
```

**Purpose**: Provides a short human-readable name for where a binding came from. This is useful in debug views that explain why a key press matches an action.

**Data flow**: It reads the enum value: custom action binding, custom global fallback, or default. It returns the matching label text: `Custom`, `Custom global`, or `Default`.

**Call relations**: Code that presents keymap debug matches can call this after `matching_actions_for_key_event` has identified the source. It turns the internal source category into text suitable for the UI.


##### `matching_actions_for_key_event`  (lines 515–537)

```
fn matching_actions_for_key_event(
    runtime_keymap: &RuntimeKeymap,
    keymap_config: &TuiKeymap,
    event: KeyEvent,
) -> Vec<KeymapDebugActionMatch>
```

**Purpose**: Finds every catalog action that would respond to a specific key press. This supports debugging or explaining keyboard behavior when a user presses a key.

**Data flow**: It receives the resolved runtime keymap, the original editable keymap config, and a terminal key event. It walks through the action catalog, gets each action’s active bindings, checks whether any binding matches the key press, and builds a list of matches with labels, descriptions, and source information.

**Call relations**: The key-event handler calls this when it needs to explain what a key does. Inside, it uses `bindings_for_action` to check the actual active bindings, `action_label` for display text, and `debug_binding_source` to say whether the match came from custom or default configuration.

*Call graph*: called by 1 (handle_key_event).


##### `debug_binding_source`  (lines 539–559)

```
fn debug_binding_source(
    keymap_config: &TuiKeymap,
    descriptor: &KeymapActionDescriptor,
) -> KeymapDebugBindingSource
```

**Purpose**: Figures out why a matched binding exists: because the user customized that exact action, because a composer action inherited a custom global fallback, or because it came from defaults.

**Data flow**: It receives the editable keymap config and an action descriptor. It clones the config so it can reuse mutable slot-finding helpers without changing the caller’s data. It first checks the action’s own config slot; if that is set, it returns `Custom`. If not, it checks a possible global fallback slot; if that is set, it returns `CustomGlobal`. Otherwise it returns `Default`.

**Call relations**: Only `matching_actions_for_key_event` calls this in this file’s flow. It delegates the exact field lookups to `binding_slot` and `global_fallback_slot`, then hands back a simple source category for the debug match record.

*Call graph*: calls 2 internal fn (binding_slot, global_fallback_slot); 1 external calls (clone).


##### `global_fallback_slot`  (lines 561–575)

```
fn global_fallback_slot(
    keymap: &'a mut TuiKeymap,
    descriptor: &KeymapActionDescriptor,
) -> Option<&'a mut Option<KeybindingsSpec>>
```

**Purpose**: Finds the older or shared global setting that can act as a fallback for certain composer actions. This preserves expected behavior for submit, queue, and shortcut-toggle bindings.

**Data flow**: It receives a mutable `TuiKeymap` and an action descriptor. If the descriptor is not in the `composer` context, it returns nothing. For the supported composer actions, it returns the matching mutable global config slot; otherwise it returns nothing.

**Call relations**: `debug_binding_source` calls this only after an action has no direct custom binding. Its answer lets the debug view distinguish a true default from a user-provided global binding that is being reused.

*Call graph*: called by 1 (debug_binding_source).


### `tui/src/keymap_setup/picker.rs`

`orchestration` · `when the /keymap picker is opened or refreshed`

When a user opens `/keymap`, they need a clear way to see every configurable shortcut, find the one they care about, and open its edit menu. This file prepares that whole picker screen. Think of it like arranging a store directory: it gathers all shortcut “products,” marks which ones are customized or missing a key, groups them into useful aisles, and gives the screen the text it needs to guide the user.

The file starts from the known list of configurable actions. For each action, it looks up the active key bindings from the runtime keymap, checks whether the user has overridden that shortcut in configuration, and creates a `KeymapActionRow`. Each row carries the action’s context, friendly label, description, current binding text, and whether it is custom.

The main builder then creates tabs: all shortcuts, common shortcuts, customized shortcuts, unbound shortcuts, context-specific groups like Editor or Vim, and a Debug tab for inspecting raw keypresses. It also sets search behavior, column sizing, footer hints, and which row should be selected when returning from editing a shortcut.

Without this file, the shortcut editing feature would still have raw data, but no organized picker screen for users to browse, search, understand, or act on it.

#### Function details

##### `KeymapActionRow::is_unbound`  (lines 49–51)

```
fn is_unbound(&self) -> bool
```

**Purpose**: This small check answers whether a shortcut action currently has no active key assigned to it. The picker uses that to mark the row as unbound.

**Data flow**: It reads the row’s `binding_summary` text. If that text is exactly `"unbound"`, it returns true; otherwise it returns false. It does not change anything.

**Call relations**: When a row is being decorated for display, `keymap_row_prefix` calls this check to decide whether to show the unbound marker. That marker helps the user spot actions that have no shortcut.

*Call graph*: called by 1 (keymap_row_prefix).


##### `build_keymap_picker_params`  (lines 125–134)

```
fn build_keymap_picker_params(
    runtime_keymap: &RuntimeKeymap,
    keymap_config: &TuiKeymap,
) -> SelectionViewParams
```

**Purpose**: This test-only helper builds the normal keymap picker with no special filtering. Tests use it to check what the picker would show in the usual case.

**Data flow**: It receives the current runtime keymap and the configured keymap. It adds the default action filter, then passes everything onward. The result is a complete `SelectionViewParams` value, which is the recipe for drawing and operating the picker.

**Call relations**: Snapshot and behavior tests call this when they want the standard picker. It hands the work to `build_keymap_picker_params_with_filter`, which then moves into the shared picker-building path.

*Call graph*: calls 1 internal fn (build_keymap_picker_params_with_filter); called by 15 (capture_completion_returns_to_selected_keymap_picker_row, clear_completion_returns_to_selected_keymap_picker_row, picker_all_tab_items_remain_searchable, picker_approval_tab_lists_all_approval_actions, picker_common_tab_lists_curated_actions, picker_content_snapshot, picker_custom_render_snapshot, picker_customized_tab_contains_root_overrides, picker_debug_tab_is_last_and_opens_inspector, picker_hides_fast_mode_action_when_feature_is_disabled (+5 more)); 1 external calls (default).


##### `build_keymap_picker_params_with_filter`  (lines 136–147)

```
fn build_keymap_picker_params_with_filter(
    runtime_keymap: &RuntimeKeymap,
    keymap_config: &TuiKeymap,
    action_filter: KeymapActionFilter,
) -> SelectionViewParams
```

**Purpose**: This builds the keymap picker while allowing some actions to be included or hidden by a filter. It is useful when feature flags or test cases need a slightly different action list.

**Data flow**: It receives the runtime keymap, the configured keymap, and an action filter. It does not choose a starting row, so it passes `None` for the selected action. It returns the completed picker parameters.

**Call relations**: The plain builder calls this with the default filter. Some tests call it directly to check filtered versions of the picker. It delegates to `build_keymap_picker_params_for_action`, the central builder.

*Call graph*: calls 1 internal fn (build_keymap_picker_params_for_action); called by 4 (build_keymap_picker_params, keymap_picker_fast_mode_enabled_snapshot, picker_covers_every_replaceable_action, picker_shows_fast_mode_action_when_feature_is_enabled).


##### `build_keymap_picker_params_for_selected_action`  (lines 150–163)

```
fn build_keymap_picker_params_for_selected_action(
    runtime_keymap: &RuntimeKeymap,
    keymap_config: &TuiKeymap,
    context: &str,
    action: &str,
) -> SelectionViewParams
```

**Purpose**: This test-only helper builds the normal picker but asks it to start with a particular action selected. It is used to verify that the interface returns focus to the right shortcut after editing.

**Data flow**: It receives the keymaps plus a context and action name that identify the desired row. It adds the default filter and forwards that selected action request. The output is picker parameters with an initial selected row if the action is found.

**Call relations**: Tests call this when they simulate returning from a shortcut edit flow. It hands the request to `build_keymap_picker_params_for_selected_action_with_filter`.

*Call graph*: calls 1 internal fn (build_keymap_picker_params_for_selected_action_with_filter); called by 4 (capture_completion_returns_to_selected_keymap_picker_row, clear_completion_returns_to_selected_keymap_picker_row, picker_selected_action_starts_on_matching_all_tab_row, replace_one_completion_drops_focused_keymap_submenus); 1 external calls (default).


##### `build_keymap_picker_params_for_selected_action_with_filter`  (lines 165–178)

```
fn build_keymap_picker_params_for_selected_action_with_filter(
    runtime_keymap: &RuntimeKeymap,
    keymap_config: &TuiKeymap,
    action_filter: KeymapActionFilter,
    context: &str,
    action:
```

**Purpose**: This builds a filtered keymap picker and asks it to select a specific shortcut row at startup. It combines filtering with focus restoration.

**Data flow**: It receives the runtime keymap, configuration, filter, context, and action. It wraps the context and action as the requested selection and passes them into the shared builder. The returned picker parameters include the matching row index when available.

**Call relations**: The selected-action test helper calls this. It then uses `build_keymap_picker_params_for_action` so all picker variants share the same tab and row construction.

*Call graph*: calls 1 internal fn (build_keymap_picker_params_for_action); called by 1 (build_keymap_picker_params_for_selected_action).


##### `build_keymap_picker_params_for_action`  (lines 180–300)

```
fn build_keymap_picker_params_for_action(
    runtime_keymap: &RuntimeKeymap,
    keymap_config: &TuiKeymap,
    action_filter: KeymapActionFilter,
    selected_action: Option<(&str, &str)>,
) -> Sele
```

**Purpose**: This is the main assembly function for the keymap picker. It gathers rows, counts important categories, builds every tab, sets search and display options, and chooses the initial selected row if one was requested.

**Data flow**: It starts with the runtime keymap, user keymap configuration, an action filter, and optionally a target action to select. It builds all shortcut rows, counts customized and unbound actions, creates tab contents, prepares headers and footer hints, calculates a useful name-column width, and returns a `SelectionViewParams` object. That object is the complete set of instructions the selection UI needs.

**Call relations**: Both public picker-building paths flow into this function. It calls helpers such as `build_keymap_rows`, `keymap_common_rows`, `keymap_selection_items`, `keymap_header`, `action_count_line`, `keymap_debug_tab`, and `keymap_picker_hint_line` to assemble smaller pieces into the final picker.

*Call graph*: calls 7 internal fn (action_count_line, build_keymap_rows, keymap_common_rows, keymap_debug_tab, keymap_header, keymap_picker_hint_line, keymap_selection_items); called by 2 (build_keymap_picker_params_for_selected_action_with_filter, build_keymap_picker_params_with_filter); 5 external calls (new, default, new, format!, vec!).


##### `keymap_debug_tab`  (lines 302–327)

```
fn keymap_debug_tab() -> SelectionTab
```

**Purpose**: This creates the special Debug tab, where users can inspect what keypresses the terminal sends and which shortcuts match them. This is helpful because terminal key names can be surprising or different across environments.

**Data flow**: It builds one tab with a header, one selectable item, explanatory text, and an action. When that item is activated, it sends an app event asking to open the keymap debug inspector.

**Call relations**: `build_keymap_picker_params_for_action` adds this tab after the normal shortcut groups. The tab uses `keymap_header` for the same visual style as the other tabs, then hands off to the app event system when the user starts inspection.

*Call graph*: calls 1 internal fn (keymap_header); called by 1 (build_keymap_picker_params_for_action); 1 external calls (vec!).


##### `build_keymap_rows`  (lines 329–358)

```
fn build_keymap_rows(
    runtime_keymap: &RuntimeKeymap,
    keymap_config: &TuiKeymap,
    action_filter: KeymapActionFilter,
) -> Vec<KeymapActionRow>
```

**Purpose**: This turns the project’s catalog of configurable actions into rows the picker can show. Each row combines human-friendly action information with the user’s current binding state.

**Data flow**: It reads the known shortcut action list, keeps only actions allowed by the filter, looks up each action’s active bindings in the runtime keymap, formats those bindings as display text, and checks the configuration for a custom override. It outputs a list of `KeymapActionRow` values.

**Call relations**: The main builder calls this first, because every tab is based on these rows. The rows it returns are later filtered into groups like Common, Customized, Unbound, and context-specific tabs.

*Call graph*: called by 1 (build_keymap_picker_params_for_action).


##### `keymap_common_rows`  (lines 360–368)

```
fn keymap_common_rows(rows: &[KeymapActionRow]) -> Vec<&KeymapActionRow>
```

**Purpose**: This picks out a curated set of commonly used or commonly customized shortcuts. It makes the Common tab useful instead of forcing users to search the full list.

**Data flow**: It receives all built shortcut rows. It walks through the predefined common-action list and finds matching rows by context and action name. It returns references to those matching rows, in the curated order.

**Call relations**: `build_keymap_picker_params_for_action` calls this while creating the Common tab. The returned rows are then passed to `keymap_selection_items` to become clickable picker entries.

*Call graph*: called by 1 (build_keymap_picker_params_for_action).


##### `keymap_selection_items`  (lines 370–389)

```
fn keymap_selection_items(
    rows: impl IntoIterator<Item = &'a KeymapActionRow>,
    empty_name: &str,
    empty_description: &str,
) -> Vec<SelectionItem>
```

**Purpose**: This converts shortcut rows into selection-list items for a tab. It also creates a friendly disabled placeholder when a tab has no real rows.

**Data flow**: It receives rows plus the placeholder title and description to use if there are none. For each row, it creates a selectable item. If the resulting list is empty, it returns one disabled item explaining that there is nothing in that tab.

**Call relations**: The main builder calls this for the All, Common, Customized, Unbound, and context tabs. It relies on `keymap_selection_item` to turn each real shortcut row into one interactive entry.

*Call graph*: called by 1 (build_keymap_picker_params_for_action); 2 external calls (into_iter, vec!).


##### `keymap_selection_item`  (lines 391–417)

```
fn keymap_selection_item(row: &KeymapActionRow) -> SelectionItem
```

**Purpose**: This builds one clickable row in the shortcut picker. Activating the row opens the action menu where the user can edit or inspect that shortcut.

**Data flow**: It receives a `KeymapActionRow`. It copies the row’s label and binding summary for display, builds a searchable text string from the context, action, description, binding, and source, adds a visual prefix, and stores an action closure. When the closure runs, it sends an app event with the row’s context and action.

**Call relations**: `keymap_selection_items` uses this for every real row. It calls `keymap_row_prefix` to create the left-side context and status marker, then connects the row to the wider app by sending `OpenKeymapActionMenu` when selected.

*Call graph*: calls 1 internal fn (keymap_row_prefix); 3 external calls (default, format!, vec!).


##### `keymap_row_prefix`  (lines 419–438)

```
fn keymap_row_prefix(row: &KeymapActionRow) -> Vec<Span<'static>>
```

**Purpose**: This creates the small label shown before each shortcut name. It shows the shortcut’s area, such as Editor or Vim, and marks custom or unbound rows.

**Data flow**: It receives a shortcut row. It formats the context label to a fixed width, then chooses an indicator: `*` for custom bindings, `-` for unbound actions, or a blank marker otherwise. It returns styled text spans ready for display.

**Call relations**: `keymap_selection_item` calls this while building each row. It calls `KeymapActionRow::is_unbound` to decide whether the unbound marker should appear, and uses the shared accent style so markers match the rest of the interface.

*Call graph*: calls 2 internal fn (is_unbound, accent_style); called by 1 (keymap_selection_item); 1 external calls (vec!).


##### `keymap_header`  (lines 440–446)

```
fn keymap_header(description: String, summary: String) -> Box<dyn Renderable>
```

**Purpose**: This builds the header shown above a keymap picker tab. The header tells the user what section they are viewing and gives a short summary.

**Data flow**: It receives a description line and a summary line. It creates a small column of three lines: the title `Keymap`, the description, and the summary. It returns that column as a renderable object the UI can draw.

**Call relations**: The main picker builder uses this for normal tabs, and `keymap_debug_tab` uses it for the Debug tab. This keeps all tab headers visually consistent.

*Call graph*: calls 1 internal fn (new); called by 2 (build_keymap_picker_params_for_action, keymap_debug_tab); 2 external calls (new, from).


##### `action_count_line`  (lines 448–453)

```
fn action_count_line(count: usize) -> String
```

**Purpose**: This formats a count of shortcut actions into a readable sentence. It exists so tab summaries say `1 action.` instead of the awkward `1 actions.`

**Data flow**: It receives a number. If the number is one, it returns `"1 action."`; otherwise it returns a plural sentence with the count. It does not change anything else.

**Call relations**: `build_keymap_picker_params_for_action` calls this while preparing tab headers. The resulting text is passed into `keymap_header` as the summary line.

*Call graph*: called by 1 (build_keymap_picker_params_for_action); 1 external calls (format!).


##### `keymap_picker_hint_line`  (lines 455–469)

```
fn keymap_picker_hint_line() -> Line<'static>
```

**Purpose**: This creates the footer help text for the main keymap picker. It reminds users how to switch groups, edit a shortcut, read the custom and unbound markers, and close the picker.

**Data flow**: It uses the app’s accent style and builds a single line made from styled text pieces. The output is a `Line` ready to be shown in the picker footer.

**Call relations**: `build_keymap_picker_params_for_action` includes this line in the returned picker parameters. The selection UI then displays it while the user browses shortcut tabs.

*Call graph*: calls 1 internal fn (accent_style); called by 1 (build_keymap_picker_params_for_action); 2 external calls (from, vec!).


##### `keymap_debug_hint_line`  (lines 471–479)

```
fn keymap_debug_hint_line() -> Line<'static>
```

**Purpose**: This creates the footer help text for the Debug tab. It tells users that Enter starts the key inspector and Escape closes the picker.

**Data flow**: It uses the app’s accent style and combines the key names and explanations into one styled line. The output is a footer hint line for the debug view.

**Call relations**: The picker setup supplies this as the special footer hint for the Debug tab. That way the instructions change when the user moves from browsing shortcuts to inspecting keypresses.

*Call graph*: calls 1 internal fn (accent_style); 2 external calls (from, vec!).


### Pet selection and runtime rendering
These files cover pet runtime animation state, preview data, picker construction, and app-level handling for selecting and persisting pets.

### `tui/src/pets/picker.rs`

`domain_logic` · `active when the `/pets` picker is opened`

When a user types `/pets`, the app needs to show a friendly picker instead of making them remember pet IDs by hand. This file creates that picker: its title, list items, search text, preview area, and the actions that happen when the user chooses something. Think of it like preparing a menu for a café: it gathers the regular menu items, adds a “no thanks” option, includes any custom items the customer brought in, then marks the right starting choice.

The picker intentionally does not load preview images itself. Instead, when the highlighted row changes, it sends an app event asking another part of the TUI to load the preview. When the user selects a row, it sends either a “pet selected” event or a “pets disabled” event. This keeps the picker focused on building the menu, while the surrounding chat interface handles downloading assets, drawing previews, and saving the final setting.

Custom pets are found under the user’s Codex home directory. The file supports both the newer `pets/<name>/pet.json` layout and an older `avatars/<name>/avatar.json` layout, so older user content still appears. It also normalizes custom pet names into the modern `custom:<id>` selector format.

#### Function details

##### `build_pet_picker_params`  (lines 46–136)

```
fn build_pet_picker_params(
    current_pet: Option<&str>,
    codex_home: &Path,
    preview_state: PetPickerPreviewState,
) -> SelectionViewParams
```

**Purpose**: Builds the full set of instructions the bottom-pane selection widget needs to show the pet picker. It decides which rows to show, which row starts selected, what search text each row uses, what preview panel to attach, and what event to send when the user moves or chooses.

**Data flow**: It receives the currently configured pet, the user’s Codex home folder, and the current preview state. It gathers all available pet entries, sorts them by display name, moves the “disable terminal pets” entry to the top, and turns each entry into a selectable UI item. It returns a `SelectionViewParams` value, which is the finished recipe for drawing and operating the popup.

**Call relations**: The test functions call this directly to verify the picker behavior. Inside the real flow, it asks `available_pet_entries` for the raw pet list, asks the preview state for something renderable for the side panel, uses `standard_popup_hint_line` for the footer help text, and creates callbacks that send app events when the selection changes or when a row is chosen.

*Call graph*: calls 3 internal fn (standard_popup_hint_line, available_pet_entries, renderable); called by 4 (picker_imports_legacy_avatar_manifests, picker_lists_app_bundled_and_custom_pets, picker_marks_disabled_pet_as_current, picker_preselects_codex_without_marking_it_current_when_no_pet_is_configured); 3 external calls (new, default, Fixed).


##### `available_pet_entries`  (lines 138–156)

```
fn available_pet_entries(codex_home: &Path) -> Vec<PetPickerEntry>
```

**Purpose**: Creates the combined list of pets that can appear in the picker. This includes bundled pets, the special disable option, and any custom pets found on disk.

**Data flow**: It starts with the built-in pet catalog and turns each catalog pet into a picker entry with an ID, display name, and description. It then adds one extra entry for disabling terminal pets. Finally, it appends the custom entries found under the supplied Codex home path and returns the whole list.

**Call relations**: This is called by `build_pet_picker_params` before the picker rows are sorted and converted into UI items. It delegates the filesystem search for user-created pets to `custom_pet_entries`, keeping the main picker builder from needing to know those folder details.

*Call graph*: calls 1 internal fn (custom_pet_entries); called by 1 (build_pet_picker_params).


##### `custom_pet_entries`  (lines 158–194)

```
fn custom_pet_entries(codex_home: &Path) -> Vec<PetPickerEntry>
```

**Purpose**: Finds user-managed custom pets in the Codex home directory and turns them into picker entries. It also supports legacy avatar folders so older custom content can still be selected.

**Data flow**: It looks in two places: `avatars` folders containing `avatar.json`, and `pets` folders containing `pet.json`. For each valid folder, it skips reserved or already-prefixed IDs, converts the folder name into a modern custom selector such as `custom:name`, then loads the pet manifest to get its display name and description. It returns the successfully loaded custom pets, de-duplicated by selector.

**Call relations**: `available_pet_entries` calls this while building the full picker list. This function hands off manifest parsing to `Pet::load_with_codex_home` and uses `custom_pet_selector` to produce the selector format that the rest of the pet system expects.

*Call graph*: calls 2 internal fn (load_with_codex_home, custom_pet_selector); called by 1 (available_pet_entries); 3 external calls (new, join, read_dir).


##### `tests::write_pet`  (lines 200–216)

```
fn write_pet(dir: &Path, folder_name: &str, display_name: &str)
```

**Purpose**: Creates a temporary modern custom pet folder for tests. It gives the picker something realistic to discover under `pets/<folder_name>/pet.json`.

**Data flow**: It receives a temporary root directory, a folder name, and a display name. It creates the pet directory, writes a small `pet.json` manifest, and writes a test spritesheet file beside it. It does not return a value; it changes the temporary filesystem used by the test.

**Call relations**: The `picker_lists_app_bundled_and_custom_pets` test calls this before building picker parameters. It uses `catalog::write_test_spritesheet` so the generated manifest points to an image file that the pet loader accepts.

*Call graph*: calls 1 internal fn (write_test_spritesheet); 4 external calls (join, format!, create_dir_all, write).


##### `tests::write_legacy_avatar`  (lines 218–233)

```
fn write_legacy_avatar(dir: &Path, folder_name: &str, display_name: &str)
```

**Purpose**: Creates a temporary legacy custom avatar folder for tests. This checks that old-style `avatars/<folder_name>/avatar.json` content still appears in the pet picker.

**Data flow**: It receives a temporary root directory, a folder name, and a display name. It creates the avatar directory, writes an `avatar.json` manifest, and writes a test spritesheet file. Its result is the changed test directory structure.

**Call relations**: The `picker_imports_legacy_avatar_manifests` test calls this before building picker parameters. Like `tests::write_pet`, it uses `catalog::write_test_spritesheet` to make the fake custom asset loadable.

*Call graph*: calls 1 internal fn (write_test_spritesheet); 4 external calls (join, format!, create_dir_all, write).


##### `tests::picker_lists_app_bundled_and_custom_pets`  (lines 236–270)

```
fn picker_lists_app_bundled_and_custom_pets()
```

**Purpose**: Verifies that the picker shows both built-in pets and a modern custom pet, in the expected order. It also checks that a custom pet can be treated as the current selection.

**Data flow**: It creates a temporary Codex home, writes one custom pet named Chefito, then builds the picker with Chefito as the current pet. It inspects the returned picker parameters to confirm the item names, the initially selected row, and the custom pet’s search value.

**Call relations**: This test uses `tests::write_pet` to prepare the filesystem and then calls `build_pet_picker_params`, exercising the normal path through `available_pet_entries` and `custom_pet_entries`.

*Call graph*: calls 1 internal fn (build_pet_picker_params); 4 external calls (assert_eq!, tempdir, write_pet, default).


##### `tests::picker_preselects_codex_without_marking_it_current_when_no_pet_is_configured`  (lines 273–284)

```
fn picker_preselects_codex_without_marking_it_current_when_no_pet_is_configured()
```

**Purpose**: Verifies the picker’s default starting point when the user has not configured any pet. It should highlight Codex as a sensible default, but not falsely mark it as already active.

**Data flow**: It creates an empty temporary Codex home and builds the picker with no current pet. It then checks that the initial selection points to the Codex row and that this row is not marked as current.

**Call relations**: This test calls `build_pet_picker_params` directly. It protects an important distinction in the picker: “highlight this as the default choice” is not the same as “this is already the user’s active setting.”

*Call graph*: calls 1 internal fn (build_pet_picker_params); 4 external calls (assert!, assert_eq!, tempdir, default).


##### `tests::picker_marks_disabled_pet_as_current`  (lines 287–303)

```
fn picker_marks_disabled_pet_as_current()
```

**Purpose**: Verifies that the special disable option behaves like a real selectable setting. If pets are currently disabled, the picker should show that row as current.

**Data flow**: It creates an empty temporary Codex home and builds the picker with the disabled pet ID as the current value. It checks that the disable row is first, selected, has no description, is marked current, and has helpful search keywords such as “off” and “none.”

**Call relations**: This test calls `build_pet_picker_params` and checks the special row that `available_pet_entries` adds. It guards the user experience for people who want to turn terminal pets off.

*Call graph*: calls 1 internal fn (build_pet_picker_params); 4 external calls (assert!, assert_eq!, tempdir, default).


##### `tests::picker_imports_legacy_avatar_manifests`  (lines 306–323)

```
fn picker_imports_legacy_avatar_manifests()
```

**Purpose**: Verifies that older custom avatar manifests are still imported into the pet picker. This prevents existing user-created avatars from disappearing after the system moved to the newer pet format.

**Data flow**: It creates a temporary Codex home, writes a legacy avatar named Legacy, and builds the picker with `custom:legacy` as the current pet. It finds the Legacy row and checks that it is marked current and uses the modern `custom:legacy` search value.

**Call relations**: This test uses `tests::write_legacy_avatar` to prepare old-style test data, then calls `build_pet_picker_params`. That call reaches `custom_pet_entries`, which is responsible for recognizing `avatars/<name>/avatar.json` and translating it into the current selector format.

*Call graph*: calls 1 internal fn (build_pet_picker_params); 5 external calls (assert!, assert_eq!, tempdir, write_legacy_avatar, default).


### `tui/src/app/pets.rs`

`orchestration` · `main loop, request handling, and shutdown`

The terminal app can show a small “ambient pet” image and a pet picker preview. This file is the app-level traffic controller for those pet features. It does not define what a pet is or how images are drawn. Instead, it reacts to events and keeps the chat widget, terminal drawing layer, saved configuration, and background loading work in sync.

The main job is to make pet changes feel safe and responsive. For example, choosing a pet may require reading files from disk and loading image assets, which could be slow. So the file starts that work in a blocking background task and sends an app event back when it finishes. While that is happening, it shows a loading popup and asks the terminal to redraw.

It also separates two kinds of image failures. A terminal error means the drawing system itself had a serious problem, so the error is returned upward. An asset error means a pet image file or resource failed, so the app logs a warning, disables or clears the affected pet display, and keeps running.

When a user disables or selects a pet, this file also writes that choice into the app configuration, so the choice survives future runs. In short, it is the glue that makes pet UI actions become visible changes, saved settings, and redraw requests.

#### Function details

##### `App::disable_ambient_pet_before_shutdown`  (lines 6–20)

```
fn disable_ambient_pet_before_shutdown(&mut self, tui: &mut tui::Tui) -> Result<()>
```

**Purpose**: Turns off the ambient pet just before the app shuts down, so the terminal is left clean. This is like wiping a whiteboard before leaving the room.

**Data flow**: It receives the app state and the terminal drawing object. It tells the chat widget not to use the pet for the rest of this session, then asks the terminal layer to clear the pet image. If clearing fails because the terminal itself failed, it returns an error. If clearing fails because of a pet asset problem, it logs a warning and still allows shutdown to continue.

**Call relations**: This runs during shutdown cleanup. It hands the actual screen-clearing work to the terminal layer, and only escalates problems that mean the terminal drawing system itself is in trouble.

*Call graph*: 2 external calls (clear_ambient_pet_image, warn!).


##### `App::handle_ambient_pet_image_render_error`  (lines 22–49)

```
fn handle_ambient_pet_image_render_error(
        &mut self,
        tui: &mut tui::Tui,
        err: crate::pets::PetImageRenderError,
    ) -> Result<()>
```

**Purpose**: Responds when drawing the normal ambient pet image fails. It decides whether the app must stop with an error or can recover by disabling the pet for the current session.

**Data flow**: It receives an image-rendering error. If the error came from the terminal system, it turns that into the app’s normal error type and returns it. If the error came from a missing or bad pet asset, it logs the problem, disables the pet in the chat widget, and tries to clear any leftover pet image from the terminal. The result is either successful recovery or a returned terminal error.

**Call relations**: This is called after a failed ambient pet render attempt. It asks the terminal layer to clear the image when recovery is possible, and it updates the chat widget so the same broken pet is not repeatedly drawn during this session.

*Call graph*: 3 external calls (clear_ambient_pet_image, warn!, into).


##### `App::handle_pet_picker_preview_image_render_error`  (lines 51–76)

```
fn handle_pet_picker_preview_image_render_error(
        &mut self,
        tui: &mut tui::Tui,
        err: crate::pets::PetImageRenderError,
    ) -> Result<()>
```

**Purpose**: Responds when the pet picker preview image cannot be drawn. It records the preview failure in the UI and tries to remove the broken preview from the terminal.

**Data flow**: It receives the app state, terminal drawing object, and the render error. A terminal-level error is returned upward. An asset-level error is logged, converted into a readable message for the chat widget, and the preview area is cleared by asking the terminal to draw no preview image. If clearing also hits only an asset problem, that is logged and ignored; if it hits a terminal problem, that error is returned.

**Call relations**: This is used while the pet picker is open and a preview image fails. It passes a user-facing failure message to the chat widget and relies on the terminal layer to remove the failed preview from the display.

*Call graph*: 4 external calls (draw_pet_picker_preview_image, warn!, into, to_string).


##### `App::handle_pet_selected`  (lines 78–103)

```
fn handle_pet_selected(&mut self, tui: &mut tui::Tui, pet_id: String)
```

**Purpose**: Starts the work needed after the user chooses a pet. It shows a loading popup immediately, then loads the pet in the background so the interface does not freeze.

**Data flow**: It receives the chosen pet ID. It asks the chat widget to show a loading popup and gets a request ID for matching the later result. It copies the needed configuration values, frame requester, and event sender into a background task. That task makes sure the built-in pet pack exists, loads the pet, converts any failure into text, and sends a PetSelectionLoaded event back to the app.

**Call relations**: This is the first step in the pet-selection flow. It schedules a redraw so the loading state appears, then hands slow file and asset work to a blocking background task. The result later returns through the app event channel and is handled by App::handle_pet_selection_loaded.

*Call graph*: 3 external calls (frame_requester, drop, spawn_blocking).


##### `App::handle_pet_disabled`  (lines 105–121)

```
async fn handle_pet_disabled(&mut self, tui: &mut tui::Tui)
```

**Purpose**: Saves the user’s choice to disable pets and updates the current interface. This makes the setting persist instead of only hiding the pet temporarily.

**Data flow**: It builds a configuration edit that sets the pet value to the special disabled-pet ID, then applies that edit to the app’s configuration files. If saving succeeds, it updates the running app state to match and asks for a redraw. If saving fails, it adds an error message to the chat widget so the user can see what went wrong.

**Call relations**: This is called when the user chooses to disable pets. It uses the configuration edit system to write the setting, then either refreshes the UI state or reports the failure in the chat area.

*Call graph*: calls 2 internal fn (new, tui_pet_edit); 2 external calls (frame_requester, format!).


##### `App::handle_pet_preview_loaded`  (lines 123–132)

```
fn handle_pet_preview_loaded(
        &mut self,
        tui: &mut tui::Tui,
        request_id: u64,
        result: Result<crate::pets::AmbientPet, String>,
    )
```

**Purpose**: Finishes a pet preview load in the picker. It gives the loaded preview, or its error, back to the chat widget and asks the screen to update.

**Data flow**: It receives a request ID and either a loaded AmbientPet or an error message. It passes both to the chat widget, which can match the result to the preview request that started it. Then it schedules a terminal frame so the preview success or failure becomes visible.

**Call relations**: This is called after background preview loading completes. It is the return path from asynchronous loading back into the visible pet picker UI.

*Call graph*: 1 external calls (frame_requester).


##### `App::handle_pet_selection_loaded`  (lines 134–173)

```
async fn handle_pet_selection_loaded(
        &mut self,
        tui: &mut tui::Tui,
        request_id: u64,
        pet_id: String,
        result: Result<Option<crate::pets::AmbientPet>, String>,
```

**Purpose**: Completes the pet-selection flow after the background load finishes. It closes the loading popup, saves the selected pet if loading succeeded, and updates the UI.

**Data flow**: It receives the loading request ID, selected pet ID, and either a loaded pet result or an error message. First it asks the chat widget to finish the matching loading popup; if the request is no longer current, it does nothing more. If loading succeeded, it writes the selected pet into the configuration and, on success, updates the in-memory config and chat widget with the loaded pet. If saving fails or loading failed, it adds an error message. It then schedules a redraw and tells the app to keep running.

**Call relations**: This is called in response to the PetSelectionLoaded event sent by App::handle_pet_selected’s background task. It connects the completed load to saved configuration and visible UI state, then returns control to the main app loop.

*Call graph*: calls 2 internal fn (new, tui_pet_edit); 2 external calls (frame_requester, format!).


##### `App::handle_configured_pet_loaded`  (lines 175–196)

```
fn handle_configured_pet_loaded(
        &mut self,
        tui: &mut tui::Tui,
        pet_id: String,
        result: Result<Option<crate::pets::AmbientPet>, String>,
    )
```

**Purpose**: Applies a pet that was loaded from the saved configuration, but only if it still matches the current configuration. This prevents an old background result from overwriting a newer choice.

**Data flow**: It receives the pet ID that was loaded and either the loaded pet or an error message. It first checks whether the app’s current configured pet is still the same ID. If not, it ignores the result. If the load succeeded, it gives the pet to the chat widget and schedules a redraw. If it failed, it adds a warning message instead of treating it as a fatal error.

**Call relations**: This is used when the app is loading the pet named in the configuration, usually around startup or configuration refresh. It protects the UI from stale background results and only updates the chat widget when the result still belongs to the active setting.

*Call graph*: 2 external calls (frame_requester, format!).


### `tui/src/pets/ambient.rs`

`domain_logic` · `rendering and animation updates during the main TUI loop`

The ambient pet is the small animated companion that sits near the bottom of the terminal while the main text interface remains controlled by ratatui, the library that draws the text user interface. This file is the bridge between those two worlds. It does not decide which pet the user picked, and it does not directly paint pixels itself. Instead, it prepares a clear request that says: use this image frame, draw it at this terminal position, and leave these rows clear.

The main object, AmbientPet, loads the selected pet, extracts its sprite frames into a cache, remembers what image protocol the terminal supports, and tracks the current notification state. A notification is the pet’s mood-like status, such as running, waiting for input, ready for review, or blocked. Each status maps to an animation name, a short label, fallback text, and a lifetime so stale messages eventually disappear.

During each render pass, this file calculates the pet’s size in terminal rows and columns, checks whether there is enough room above the composer, and picks the correct frame based on elapsed time. Think of it like a flipbook: the code knows how long each page should stay visible and schedules the next page turn. It also supports reduced motion by freezing on the first frame and scheduling no follow-up animation frames.

#### Function details

##### `PetNotificationKind::animation_name`  (lines 55–62)

```
fn animation_name(self) -> &'static str
```

**Purpose**: Returns the animation name that matches a pet status, such as using the running animation while Codex is thinking.

**Data flow**: It takes one notification kind → matches it to a fixed text name used in the pet animation data → returns that name.

**Call relations**: This is used when AmbientPet::current_animation decides which animation should play for the visible notification.


##### `PetNotificationKind::label`  (lines 64–71)

```
fn label(self) -> &'static str
```

**Purpose**: Returns the short human-readable label for a notification kind, using the same wording as the wider Codex app.

**Data flow**: It takes a notification kind → converts it to display text like “Running” or “Blocked” → returns that text.

**Call relations**: The notification_height helper uses this label to decide whether the notification can be shown as one line or needs extra space. A test also protects these labels from drifting away from app vocabulary.


##### `PetNotificationKind::fallback_body`  (lines 73–80)

```
fn fallback_body(self) -> &'static str
```

**Purpose**: Provides default notification text when the caller does not supply a custom message.

**Data flow**: It takes a notification kind → chooses a simple fallback phrase → returns that phrase.

**Call relations**: PetNotification::new calls this when it creates a notification without a provided body.


##### `PetNotificationKind::lifetime`  (lines 82–89)

```
fn lifetime(self) -> Duration
```

**Purpose**: Defines how long each kind of pet notification should remain visible before it is considered stale.

**Data flow**: It takes a notification kind → maps it to a fixed duration, from minutes to days depending on importance → returns that duration.

**Call relations**: PetNotification::is_expired calls this when deciding whether an old notification should still affect the pet.

*Call graph*: called by 1 (is_expired).


##### `PetNotification::new`  (lines 100–106)

```
fn new(kind: PetNotificationKind, body: Option<String>) -> Self
```

**Purpose**: Creates a fresh pet notification and records the time it was created.

**Data flow**: It receives a notification kind and optional body text → fills in fallback text if needed and stores the current time → returns a PetNotification ready to display.

**Call relations**: AmbientPet::set_notification calls this whenever the pet’s status changes.

*Call graph*: called by 1 (set_notification); 1 external calls (now).


##### `PetNotification::is_expired`  (lines 108–110)

```
fn is_expired(&self, now: Instant) -> bool
```

**Purpose**: Checks whether a notification has lived longer than its allowed lifetime.

**Data flow**: It receives the current time → compares it with the notification’s saved update time and lifetime → returns true if the notification should no longer be shown.

**Call relations**: AmbientPet::visible_notification relies on this check before letting a notification influence layout or animation.

*Call graph*: calls 1 internal fn (lifetime); 1 external calls (saturating_duration_since).


##### `AmbientPet::load`  (lines 146–176)

```
fn load(
        selected_pet: Option<&str>,
        codex_home: &std::path::Path,
        frame_requester: FrameRequester,
        animations_enabled: bool,
    ) -> Result<Self>
```

**Purpose**: Loads the active pet and prepares the image frames needed for ambient rendering.

**Data flow**: It receives the selected pet id, the Codex home folder, a frame scheduler, and the animation setting → loads the pet definition, builds cache paths, extracts PNG frames, detects image support, and records startup time → returns a ready AmbientPet or an error.

**Call relations**: The higher-level load_ambient_pet flow calls this during pet setup. It hands off pet loading to Pet::load_with_codex_home, frame extraction to frames::prepare_png_frames, and image capability detection to default_image_support.

*Call graph*: calls 3 internal fn (default_image_support, prepare_png_frames, load_with_codex_home); called by 1 (load_ambient_pet); 2 external calls (now, join).


##### `AmbientPet::set_notification`  (lines 178–181)

```
fn set_notification(&mut self, kind: PetNotificationKind, body: Option<String>)
```

**Purpose**: Updates the pet’s current status message and restarts the animation timing for that status.

**Data flow**: It receives a notification kind and optional body text → builds a PetNotification and resets the animation start time to now → changes the AmbientPet’s stored notification state.

**Call relations**: Other parts of the TUI call this when Codex starts running, needs input, finishes work, or hits a blocked state. Later draw and animation functions read the stored notification.

*Call graph*: calls 1 internal fn (new); 1 external calls (now).


##### `AmbientPet::image_enabled`  (lines 183–185)

```
fn image_enabled(&self) -> bool
```

**Purpose**: Reports whether the current terminal can show the pet as an image.

**Data flow**: It reads the stored terminal image support → checks whether a usable protocol is available → returns true or false.

**Call relations**: Callers can use this as a quick gate before expecting pet images to appear.

*Call graph*: calls 1 internal fn (protocol).


##### `AmbientPet::image_columns`  (lines 187–189)

```
fn image_columns(&self) -> u16
```

**Purpose**: Tells callers how many terminal text columns the pet image will occupy.

**Data flow**: It reads the pet’s frame shape → computes the terminal-sized image dimensions → returns only the column count.

**Call relations**: This is a small wrapper around AmbientPet::image_size for layout code that only needs width.

*Call graph*: calls 1 internal fn (image_size).


##### `AmbientPet::set_image_support_for_tests`  (lines 192–194)

```
fn set_image_support_for_tests(&mut self, support: PetImageSupport)
```

**Purpose**: Lets tests replace the detected terminal image support with a controlled value.

**Data flow**: It receives a PetImageSupport value → stores it on the AmbientPet → later rendering decisions use that test-provided support.

**Call relations**: This is only compiled for tests, where code needs predictable behavior instead of depending on the developer’s real terminal.


##### `AmbientPet::schedule_next_frame`  (lines 196–200)

```
fn schedule_next_frame(&self)
```

**Purpose**: Asks the TUI to redraw when the next animation frame should appear.

**Data flow**: It asks next_frame_delay for the time until the next frame → if there is a delay, it passes that delay to the frame requester → the UI will be prompted to render again later.

**Call relations**: This connects animation timing to the broader rendering loop by calling FrameRequester::schedule_frame_in.

*Call graph*: calls 2 internal fn (next_frame_delay, schedule_frame_in).


##### `AmbientPet::next_frame_delay`  (lines 202–212)

```
fn next_frame_delay(&self) -> Option<Duration>
```

**Purpose**: Calculates how long to wait before the pet animation needs another redraw.

**Data flow**: It checks whether images and animations are enabled → finds the current animation and current frame from elapsed time → returns the remaining time for this frame, or nothing if no follow-up is needed.

**Call relations**: AmbientPet::schedule_next_frame calls this. It delegates frame timing to current_animation_frame after choosing the active animation.

*Call graph*: calls 3 internal fn (current_animation, current_animation_frame, protocol); called by 1 (schedule_next_frame); 1 external calls (elapsed).


##### `AmbientPet::draw_request`  (lines 221–249)

```
fn draw_request(
        &self,
        area: Rect,
        composer_bottom_y: u16,
    ) -> Option<AmbientPetDraw>
```

**Purpose**: Builds the draw instructions for the live ambient pet, anchored above the composer area.

**Data flow**: It receives the available screen rectangle and composer bottom row → checks image support, computes image size, accounts for notification height and the safety gap, picks the current frame, and calculates x/y position → returns an AmbientPetDraw request or None if the pet would not fit.

**Call relations**: The main renderer calls this after normal layout decisions. It uses current_frame_path for the image, visible_notification for extra space needs, and composer_gap_rows to avoid crowding the input composer.

*Call graph*: calls 5 internal fn (current_frame_path, image_size, visible_notification, composer_gap_rows, protocol); 2 external calls (now, clone).


##### `AmbientPet::preview_draw_request`  (lines 256–275)

```
fn preview_draw_request(&self, area: Rect) -> Option<AmbientPetDraw>
```

**Purpose**: Builds a centered draw request for showing a stable pet preview in the /pets picker.

**Data flow**: It receives the preview area → checks that image support exists and the area is large enough → chooses the first idle frame and centers it → returns an AmbientPetDraw request or None.

**Call relations**: The pet picker uses this instead of the live animation path so browsing pets does not depend on notification state or animation timing.

*Call graph*: calls 3 internal fn (first_idle_frame_path, image_size, protocol); 1 external calls (clone).


##### `AmbientPet::visible_notification`  (lines 277–281)

```
fn visible_notification(&self, now: Instant) -> Option<&PetNotification>
```

**Purpose**: Returns the current notification only if it has not expired.

**Data flow**: It receives the current time → looks at the stored optional notification and filters out expired ones → returns a reference to the still-visible notification or None.

**Call relations**: AmbientPet::draw_request uses it to reserve notification space, and AmbientPet::current_animation uses it to choose the matching animation.

*Call graph*: called by 2 (current_animation, draw_request).


##### `AmbientPet::current_animation`  (lines 283–301)

```
fn current_animation(&self) -> Option<&Animation>
```

**Purpose**: Chooses which animation should be considered active right now.

**Data flow**: It checks for a visible notification → uses that notification’s animation name or falls back to idle → looks up the animation, handles completed non-looping animations by switching to their fallback → returns the animation to use.

**Call relations**: AmbientPet::current_frame_path and AmbientPet::next_frame_delay both call this before deciding which frame is visible or when to redraw.

*Call graph*: calls 1 internal fn (visible_notification); called by 2 (current_frame_path, next_frame_delay); 2 external calls (elapsed, now).


##### `AmbientPet::current_frame_path`  (lines 303–316)

```
fn current_frame_path(&self) -> Option<PathBuf>
```

**Purpose**: Finds the image file for the frame that should be visible right now.

**Data flow**: It chooses the current animation → either advances by elapsed time or, if animations are disabled, takes the first frame → converts the sprite index into a cached file path → returns that path if available.

**Call relations**: AmbientPet::draw_request calls this when creating the actual live pet draw request.

*Call graph*: calls 2 internal fn (current_animation, frame_path_for_sprite_index); called by 1 (draw_request).


##### `AmbientPet::first_idle_frame_path`  (lines 318–326)

```
fn first_idle_frame_path(&self) -> Option<PathBuf>
```

**Purpose**: Finds a calm, stable image for previewing the pet.

**Data flow**: It looks up the idle animation → takes its first frame’s sprite index, or zero if missing → converts that index to a cached file path → returns the path if available.

**Call relations**: AmbientPet::preview_draw_request calls this so the /pets picker preview stays still and predictable.

*Call graph*: calls 1 internal fn (frame_path_for_sprite_index); called by 1 (preview_draw_request).


##### `AmbientPet::frame_path_for_sprite_index`  (lines 328–332)

```
fn frame_path_for_sprite_index(&self, sprite_index: usize) -> Option<PathBuf>
```

**Purpose**: Converts a sprite frame number into the matching cached PNG file path.

**Data flow**: It receives a sprite index → clamps it to the available frame list so it does not go past the end → returns a cloned path to that frame.

**Call relations**: Both current_frame_path and first_idle_frame_path use this as the final lookup step after choosing a sprite index.

*Call graph*: called by 2 (current_frame_path, first_idle_frame_path).


##### `AmbientPet::image_size`  (lines 334–345)

```
fn image_size(&self) -> ImageSize
```

**Purpose**: Calculates how large the pet should be in terminal rows and columns.

**Data flow**: It reads the pet frame’s pixel width and height → targets a fixed pixel height, converts that into terminal rows, estimates columns from the frame’s shape, and ensures neither value drops below one → returns an ImageSize.

**Call relations**: draw_request, preview_draw_request, and image_columns all use this so every layout path agrees on the pet’s size.

*Call graph*: called by 3 (draw_request, image_columns, preview_draw_request); 1 external calls (from).


##### `composer_gap_rows`  (lines 348–351)

```
fn composer_gap_rows() -> u16
```

**Purpose**: Converts the desired pixel gap above the composer into terminal text rows.

**Data flow**: It starts with a fixed pixel gap → divides by the assumed terminal row height and rounds → returns at least one row.

**Call relations**: AmbientPet::draw_request uses this to keep the pet from sitting directly on top of the input composer.

*Call graph*: called by 1 (draw_request); 1 external calls (from).


##### `default_image_support`  (lines 359–361)

```
fn default_image_support() -> PetImageSupport
```

**Purpose**: Chooses the default terminal image capability used by a newly loaded ambient pet.

**Data flow**: In normal builds it auto-detects the best supported image protocol; in test builds it returns an unsupported value unless a test overrides it → the result is stored on AmbientPet.

**Call relations**: AmbientPet::load calls this while constructing the pet. Later draw functions consult the stored support before producing image requests.

*Call graph*: called by 1 (load); 1 external calls (Unsupported).


##### `current_animation_frame`  (lines 376–412)

```
fn current_animation_frame(animation: &Animation, elapsed: Duration) -> Option<AnimationFrameTick>
```

**Purpose**: Chooses which frame of an animation should be visible at a given elapsed time.

**Data flow**: It receives an animation and elapsed duration → handles single-frame animations, looping sections, and finished non-looping animations → returns the sprite index plus the time until the next frame, if any.

**Call relations**: AmbientPet::next_frame_delay uses this for redraw timing, and current_frame_path uses it indirectly through the animation flow. It calls frame_at_elapsed for the frame-by-frame timing work.

*Call graph*: calls 2 internal fn (frame_at_elapsed, total_duration); called by 1 (next_frame_delay); 1 external calls (as_nanos).


##### `frame_at_elapsed`  (lines 414–431)

```
fn frame_at_elapsed(animation: &Animation, elapsed_nanos: u128) -> Option<AnimationFrameTick>
```

**Purpose**: Walks through an animation’s frames to find the one that contains a specific elapsed time.

**Data flow**: It receives an animation and elapsed nanoseconds → subtracts each frame’s duration until it finds the active frame → returns that frame’s sprite index and remaining delay, or the last frame if time has run out.

**Call relations**: current_animation_frame calls this after deciding whether the animation is looping or still in its normal timeline.

*Call graph*: calls 1 internal fn (nanos_to_duration); called by 1 (current_animation_frame).


##### `nanos_to_duration`  (lines 433–435)

```
fn nanos_to_duration(nanos: u128) -> Duration
```

**Purpose**: Safely converts a large nanosecond count into a Duration value.

**Data flow**: It receives a nanosecond count as a wide integer → caps it at the largest value Duration::from_nanos accepts → returns a Duration.

**Call relations**: frame_at_elapsed uses this when reporting how long remains before the next animation frame.

*Call graph*: called by 1 (frame_at_elapsed); 2 external calls (from_nanos, from).


##### `notification_height`  (lines 437–443)

```
fn notification_height(notification: &PetNotification) -> u16
```

**Purpose**: Estimates how many terminal rows a notification needs above or beside the pet.

**Data flow**: It receives a notification → compares its body text with the short label → returns one row for label-only text or two rows when there is a separate body.

**Call relations**: AmbientPet::draw_request uses this to decide whether the pet and its notification can fit without overlapping the rest of the interface.


##### `test_ambient_pet`  (lines 446–473)

```
fn test_ambient_pet(
    frame_requester: FrameRequester,
    animations_enabled: bool,
) -> AmbientPet
```

**Purpose**: Builds a small fake AmbientPet for tests without loading real pet files from disk.

**Data flow**: It receives a frame requester and animation setting → creates a hard-coded pet, fake frame paths, supported image protocol, and a started animation clock → returns the ready test AmbientPet.

**Call relations**: The reduced-motion test calls this to check animation behavior in a controlled setup. It uses test_animation for the fake animation data.

*Call graph*: calls 1 internal fn (test_animation); called by 1 (reduced_motion_uses_stable_first_frame_and_schedules_no_follow_up); 8 external calls (from_millis, from, now, from, new, new, Supported, vec!).


##### `test_animation`  (lines 476–491)

```
fn test_animation() -> Animation
```

**Purpose**: Creates a simple two-frame looping animation for tests.

**Data flow**: It builds two frames with short durations and a loop starting at the first frame → returns an Animation that is easy to reason about.

**Call relations**: test_ambient_pet uses it to populate fake pet data, and the animation timing test uses it directly.

*Call graph*: called by 2 (test_ambient_pet, animation_frame_uses_per_frame_duration); 1 external calls (vec!).


##### `tests::notification_labels_match_codex_app_vocabulary`  (lines 498–503)

```
fn notification_labels_match_codex_app_vocabulary()
```

**Purpose**: Checks that pet notification labels match the wording used by the Codex app.

**Data flow**: It calls each label method → compares the returned text with the expected app vocabulary → the test fails if any label changes unexpectedly.

**Call relations**: This protects PetNotificationKind::label because those labels are visible to users and should stay consistent.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::animation_frame_uses_per_frame_duration`  (lines 506–516)

```
fn animation_frame_uses_per_frame_duration()
```

**Purpose**: Verifies that animation timing respects each frame’s own duration.

**Data flow**: It creates the test animation → asks which frame is active after 15 milliseconds → expects the second frame with 5 milliseconds left.

**Call relations**: This test exercises current_animation_frame through a simple case built by test_animation.

*Call graph*: calls 1 internal fn (test_animation); 1 external calls (assert_eq!).


##### `tests::reduced_motion_uses_stable_first_frame_and_schedules_no_follow_up`  (lines 519–527)

```
fn reduced_motion_uses_stable_first_frame_and_schedules_no_follow_up()
```

**Purpose**: Verifies that reduced-motion mode freezes the pet on a stable frame and does not schedule more animation redraws.

**Data flow**: It builds a test AmbientPet with animations disabled → checks that the current frame is the first frame and that there is no next-frame delay → the test fails if reduced motion would still animate.

**Call relations**: This test uses test_ambient_pet and then checks AmbientPet::current_frame_path and AmbientPet::next_frame_delay behavior.

*Call graph*: calls 2 internal fn (test_ambient_pet, test_dummy); 1 external calls (assert_eq!).


### `tui/src/pets/preview.rs`

`domain_logic` · `active during pet picker rendering and preview state updates`

The pet picker has a side pane that can either show a pet preview or explain why no preview is visible. This file keeps that pane simple but coordinated. The key idea is a shared state object, `PetPickerPreviewState`, that can be safely updated from different parts of the program. It uses a mutex, which is a lock that stops two pieces of code from changing the same data at the same time, wrapped in `Arc`, which lets several owners share the same state.

One part of the picker can create a renderable view of this state. Another part, such as code reacting to selection changes or preview loading, can set the state to loading, ready, disabled, error, or hidden. When the terminal UI redraws, `PetPickerPreviewRenderable::render` looks at the current state and decides what text, if any, should be painted in the side pane.

A small but important detail is that rendering records the last screen rectangle used for the preview pane. That remembered area lets image-rendering code outside the normal widget tree know where to place the pet image. In everyday terms, this file is like a shared notice board: one worker updates the message, the display reads it, and the display also marks where the picture should go.

#### Function details

##### `PetPickerPreviewState::renderable`  (lines 33–37)

```
fn renderable(&self) -> PetPickerPreviewRenderable
```

**Purpose**: Creates a drawable wrapper for the preview pane. The wrapper shares the same underlying state, so the UI can redraw current preview messages without rebuilding the whole picker.

**Data flow**: It starts with a `PetPickerPreviewState` that owns shared preview data. It clones the shared pointer, which is cheap and still points to the same locked state. It returns a `PetPickerPreviewRenderable` that can be given to the UI rendering system.

**Call relations**: When the pet picker is being assembled, `build_pet_picker_params` calls this so the picker can include the preview pane. Later, the returned renderable reads the same state that selection-change or loading code updates.

*Call graph*: called by 1 (build_pet_picker_params); 1 external calls (clone).


##### `PetPickerPreviewState::set_loading`  (lines 39–43)

```
fn set_loading(&self)
```

**Purpose**: Marks the preview pane as waiting for preview data. This is used when a pet preview has been requested but is not ready yet.

**Data flow**: It takes the current shared state, locks it through `update`, and changes the status to `Loading`. Nothing is returned; the visible effect appears the next time the pane is rendered.

**Call relations**: This is one of the public state-changing helpers that funnels through `PetPickerPreviewState::update`. After it changes the status, `PetPickerPreviewRenderable::render` can show a loading message.

*Call graph*: calls 1 internal fn (update).


##### `PetPickerPreviewState::set_disabled`  (lines 45–49)

```
fn set_disabled(&self)
```

**Purpose**: Marks the preview pane as disabled. This tells the user that terminal pets are turned off and no pet will be shown.

**Data flow**: It locks the shared preview state through `update` and changes the status to `Disabled`. It does not return a value; it changes what the next UI redraw will display.

**Call relations**: Like the other status setters, it uses `PetPickerPreviewState::update` to safely edit the shared state. The renderable later turns this status into a short title and explanation.

*Call graph*: calls 1 internal fn (update).


##### `PetPickerPreviewState::set_ready`  (lines 51–55)

```
fn set_ready(&self)
```

**Purpose**: Marks the preview as ready. In this state, the text pane does not draw a message, leaving room for the actual pet preview image to appear.

**Data flow**: It locks the shared state through `update` and sets the status to `Ready`. It returns nothing; the important change is stored in the shared state.

**Call relations**: This setter shares the same update path as loading, disabled, and error states. When `PetPickerPreviewRenderable::render` sees `Ready`, it records the area but does not draw text over it.

*Call graph*: calls 1 internal fn (update).


##### `PetPickerPreviewState::set_error`  (lines 57–61)

```
fn set_error(&self, message: String)
```

**Purpose**: Stores an error message for the preview pane. This lets the UI explain why a preview could not be shown instead of silently leaving the pane blank.

**Data flow**: It receives a message string, locks the shared state through `update`, and stores the status as `Error` together with that message. It returns nothing, but the message becomes available for the next render.

**Call relations**: This is called by code that knows a preview failed. It hands the stored message to `PetPickerPreviewRenderable::render`, which displays it under a general error title.

*Call graph*: calls 1 internal fn (update).


##### `PetPickerPreviewState::clear`  (lines 63–68)

```
fn clear(&self)
```

**Purpose**: Resets the preview pane to an empty hidden state. It also forgets the last known screen area, because there is no current preview location to reuse.

**Data flow**: It locks the shared state through `update`, changes the status to `Hidden`, and sets the remembered area to `None`. Nothing is returned; the shared state is simply reset.

**Call relations**: This uses the same safe update helper as the other setters. After clearing, rendering exits without drawing text, and callers asking for `area` will no longer receive an old rectangle.

*Call graph*: calls 1 internal fn (update).


##### `PetPickerPreviewState::area`  (lines 70–72)

```
fn area(&self) -> Option<Rect>
```

**Purpose**: Returns the last screen area where the preview pane was rendered, if one is known. Other code can use this to place an out-of-band pet image in the right spot.

**Data flow**: It tries to lock the shared state and read `last_area`. If the lock succeeds and an area has been recorded, it returns that rectangle. If the lock fails or no area has been recorded, it returns `None`.

**Call relations**: The remembered area is written by `PetPickerPreviewRenderable::render`. This function is the read side of that exchange, giving preview image code a way to find the pane without knowing the picker layout details.


##### `PetPickerPreviewState::update`  (lines 74–78)

```
fn update(&self, f: impl FnOnce(&mut PetPickerPreviewInner))
```

**Purpose**: Safely edits the shared preview state. It is the common helper used by the status-changing methods so they all lock the state in the same careful way.

**Data flow**: It receives a small editing function. It tries to lock the shared state; if that works, it gives mutable access to the inner data and runs the edit. If locking fails, it quietly does nothing.

**Call relations**: `set_loading`, `set_disabled`, `set_ready`, `set_error`, and `clear` all call this instead of touching the locked data directly. This keeps the lock-and-edit pattern in one place.

*Call graph*: called by 5 (clear, set_disabled, set_error, set_loading, set_ready).


##### `PetPickerPreviewRenderable::render`  (lines 104–133)

```
fn render(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Draws the preview pane’s text message into the terminal buffer when a message is needed. It also records the pane’s current screen area so other preview code knows where the pet image belongs.

**Data flow**: It receives a rectangle describing where the pane is on screen and a buffer, which is the terminal drawing surface. It locks the shared state, saves the rectangle as the latest area, checks the current status, and decides whether to draw nothing or draw one or two centered lines. For loading, disabled, and error states it writes styled text into the buffer; for hidden and ready states it leaves the buffer alone.

**Call relations**: The terminal UI calls this during redraws through the `Renderable` interface. It uses `centered_text_area` to place messages vertically in the pane, and it reads statuses set earlier by the `PetPickerPreviewState` methods.

*Call graph*: calls 1 internal fn (centered_text_area); 3 external calls (from, new, vec!).


##### `PetPickerPreviewRenderable::desired_height`  (lines 135–137)

```
fn desired_height(&self, _width: u16) -> u16
```

**Purpose**: Tells the layout system that this preview pane would like to be four rows tall. This gives the picker a simple fixed height hint for arranging the UI.

**Data flow**: It receives an available width but does not need it. It always returns `4`, meaning four terminal rows.

**Call relations**: The UI layout code can ask this renderable how much vertical space it wants before drawing. The returned value helps reserve enough room for the preview message area.


##### `centered_text_area`  (lines 140–144)

```
fn centered_text_area(area: Rect, height: u16) -> Rect
```

**Purpose**: Calculates a smaller rectangle that vertically centers a block of text inside a larger area. This keeps preview messages from sticking awkwardly to the top of the pane.

**Data flow**: It receives the full pane rectangle and the desired text height. It caps the text height so it cannot exceed the pane, computes a centered vertical position, and returns a new rectangle with the same x-position and width but adjusted y-position and height.

**Call relations**: `PetPickerPreviewRenderable::render` calls this right before drawing text. It supplies the neat placement box that the terminal paragraph widget uses.

*Call graph*: called by 1 (render); 1 external calls (new).


##### `tests::centered_text_area_centers_vertically`  (lines 151–163)

```
fn centered_text_area_centers_vertically()
```

**Purpose**: Checks that `centered_text_area` places a short text block in the vertical middle of a taller rectangle. This protects the small layout calculation from accidental changes.

**Data flow**: It builds a sample outer rectangle and asks for a two-row text area. It compares the result with the exact rectangle expected for vertical centering. The test passes if both rectangles match.

**Call relations**: This test exercises `centered_text_area` directly. It is not part of the running picker; it runs during testing to confirm the helper still behaves as the rendering code expects.

*Call graph*: 1 external calls (assert_eq!).


### Auxiliary picker and import helpers
These files implement adjacent interactive helpers for platform actions, clipboard and external imports, and standalone theme selection.

### `tui/src/app/platform_actions.rs`

`orchestration` · `cross-cutting: active during keyboard input handling and Windows sandbox setup`

This file is a small bridge between the general terminal app and details that only matter in certain situations. On Windows, the app may need to scan the current workspace for directories that are “world-writable,” meaning many users or processes could write there. That matters because a sandbox is meant to limit what the app can touch; unsafe writable folders can weaken that protection. This file starts that scan in the background so the user interface does not freeze, and sends a warning event if the scan itself fails.

It also defines a tiny piece of Windows sandbox state. One field remembers when sandbox setup began, and another lets the app skip exactly one scan after the user has already confirmed they understand the warning. Think of it like a one-use hall pass: it avoids nagging immediately after a choice, but does not permanently disable checking.

Finally, the file contains a keyboard shortcut rule for side conversations. It says that a key press counts as a “return” shortcut only when the user presses Control with C or D, in either uppercase or lowercase. That keeps shortcut behavior consistent and avoids treating unrelated keys, such as Escape, as the same action.

#### Function details

##### `App::spawn_world_writable_scan`  (lines 17–49)

```
fn spawn_world_writable_scan(
        cwd: AbsolutePathBuf,
        workspace_roots: Vec<AbsolutePathBuf>,
        env_map: std::collections::HashMap<String, String>,
        logs_base_dir: AbsolutePa
```

**Purpose**: On Windows, this starts a safety scan for writable workspace paths without blocking the terminal interface. It is used when the app needs to check whether the configured sandbox permissions are safe enough for the current workspace.

**Data flow**: It receives the current folder, workspace roots, environment variables, a log directory, a permission profile, and an event sender. First it turns the permission profile into concrete Windows sandbox permissions for those workspace roots; if that cannot be done, it quietly stops. If permissions are resolved, it starts a background blocking task, runs the scan with the paths and environment it was given, and if the scan fails it sends a warning event back to the app.

**Call relations**: When the app decides a Windows sandbox scan is needed, it calls this method. The method asks `try_from_permission_profile_for_workspace_roots` to translate the user-facing permission profile into concrete sandbox rules, then hands the slower scan work to `spawn_blocking` so the user interface can keep running. If that background work reports an error, it relies on `send_world_writable_scan_failed` to notify the rest of the app.

*Call graph*: calls 1 internal fn (try_from_permission_profile_for_workspace_roots); 1 external calls (spawn_blocking).


##### `send_world_writable_scan_failed`  (lines 53–61)

```
fn send_world_writable_scan_failed(tx: &AppEventSender)
```

**Purpose**: This sends a specific app event saying that the Windows world-writable scan failed. The event opens a warning confirmation screen, but without example paths because the scan did not produce any.

**Data flow**: It takes an app event sender as input. It builds an `OpenWorldWritableWarningConfirmation` event with no preset, no profile selection, no sample paths, zero extra paths, and a flag saying the scan failed. It sends that event outward, changing the app’s event stream rather than returning a value.

**Call relations**: This helper is used after the Windows scan task detects a failure. It calls the sender’s `send` method to hand the warning event back to the app, where normal event processing can show the appropriate confirmation UI.

*Call graph*: calls 1 internal fn (send); 1 external calls (new).


##### `side_return_shortcut_matches`  (lines 63–74)

```
fn side_return_shortcut_matches(key_event: KeyEvent) -> bool
```

**Purpose**: This checks whether a keyboard event is the shortcut for returning from a side conversation. The accepted shortcuts are Ctrl+C and Ctrl+D, regardless of letter case.

**Data flow**: It receives one key event. It looks at the key code, modifier keys, and whether the event is an actual press. It returns `true` only for a pressed character key where Control is held and the character is C or D; otherwise it returns `false`.

**Call relations**: Code that reads keyboard input can call this function before deciding what action to take. Internally it uses Rust’s pattern-matching form, `matches!`, to express the rule in one place so the rest of the app does not need to repeat the shortcut details.

*Call graph*: 1 external calls (matches!).


##### `tests::side_return_shortcuts_match_ctrl_c_and_ctrl_d`  (lines 81–108)

```
fn side_return_shortcuts_match_ctrl_c_and_ctrl_d()
```

**Purpose**: This test proves that the side-return shortcut accepts Ctrl+C and Ctrl+D in both uppercase and lowercase forms, and rejects unrelated Escape key events. It protects the shortcut rule from accidental changes.

**Data flow**: It creates several sample key events, feeds them into `side_return_shortcut_matches`, and checks the returned true-or-false result. The expected result is true for Control plus C or D, and false for Escape presses or releases without Control.

**Call relations**: During test runs, this function exercises `side_return_shortcut_matches` directly. It uses assertions to make the shortcut contract explicit, so future edits that broaden or break the shortcut behavior are caught quickly.

*Call graph*: 1 external calls (assert!).


### `tui/src/clipboard_paste.rs`

`io_transport` · `request handling, when the user pastes text, paths, or images`

When a user pastes into the terminal interface, the app cannot assume the pasted data is already tidy. An image might arrive as raw clipboard pixels, as a copied file, or through the Windows clipboard while the app is running under WSL. A path might be quoted, shell-escaped, written as a file:// URL, or use Windows backslashes. This file is the adapter that turns those messy real-world clipboard inputs into predictable Rust values.

For images, it first tries the normal system clipboard route. If the clipboard points to image files, it prefers opening those files. Otherwise it reads raw image data from the clipboard. In both cases it re-encodes the image as PNG, records its width and height, and can optionally write it to a uniquely named temporary .png file. On Android it returns a clear “unsupported” error because the clipboard library used here does not work there.

On Linux, it has a special WSL escape hatch. If the normal Linux clipboard access fails, it can ask Windows PowerShell to save the Windows clipboard image to a temporary PNG, then translate a path like C:\Temp\x.png into /mnt/c/Temp/x.png.

For text, the file offers small cleanup tools: one for turning pasted search text into a single spaced line, and one for recognizing pasted filesystem paths safely.

#### Function details

##### `PasteImageError::fmt`  (lines 14–21)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: This turns a paste-image error into a clear sentence for logs or user-facing messages. It explains whether the clipboard was unavailable, no image was found, image encoding failed, or file input/output failed.

**Data flow**: It receives one PasteImageError value and a text formatter. It chooses the matching human-readable prefix, adds the stored error message, and writes that text into the formatter. Nothing else is changed.

**Call relations**: Rust calls this automatically whenever a PasteImageError needs to be displayed as text. The image paste functions create these errors when clipboard access, image conversion, or file writing fails, and this formatter makes those failures understandable.

*Call graph*: 1 external calls (write!).


##### `EncodedImageFormat::label`  (lines 33–39)

```
fn label(self) -> &'static str
```

**Purpose**: This gives a short display label for an image format. It is useful when the interface wants to show “PNG”, “JPEG”, or a generic “IMG” without exposing internal enum names.

**Data flow**: It receives an EncodedImageFormat value. It matches that value to a fixed text label and returns that label. It does not read or change anything else.

**Call relations**: Code that receives image information can call this when it needs a user-friendly format name. It sits beside PastedImageInfo as a small presentation helper.


##### `paste_image_as_png`  (lines 113–117)

```
fn paste_image_as_png() -> Result<(Vec<u8>, PastedImageInfo), PasteImageError>
```

**Purpose**: This reads an image from the system clipboard and returns it as PNG bytes with basic information such as width and height. It exists so the rest of the app can treat pasted images the same way no matter how the operating system provided them.

**Data flow**: It starts by opening the system clipboard. It first looks for copied files and tries to open the first file that is actually an image; if that does not work, it reads raw image pixels from the clipboard. It converts the resulting image into PNG bytes, then returns those bytes together with image metadata. If the platform is Android, or if the clipboard/image conversion fails, it returns a PasteImageError instead.

**Call relations**: paste_image_to_temp_png calls this as its first attempt at image paste. Inside, it relies on the clipboard library for clipboard access and the image library for decoding and PNG encoding. Its result is the clean image payload that later code can write to disk or send onward.

*Call graph*: calls 1 internal fn (new); called by 1 (paste_image_to_temp_png); 8 external calls (new, new, ImageRgba8, from_raw, debug!, debug_span!, ClipboardUnavailable, EncodeFailed).


##### `try_wsl_clipboard_fallback`  (lines 159–193)

```
fn try_wsl_clipboard_fallback(
    error: &PasteImageError,
) -> Result<(PathBuf, PastedImageInfo), PasteImageError>
```

**Purpose**: This is the backup route for image paste when the app is running in WSL and normal Linux clipboard access cannot see the Windows clipboard. It tries to bridge from Linux into Windows to recover the pasted image.

**Data flow**: It receives the original paste error. If the machine does not look like WSL, or the error is not the kind this fallback can fix, it returns that original error again. Otherwise it asks PowerShell to save the Windows clipboard image, converts the returned Windows path into a WSL path, checks the image dimensions, and returns that path with image information.

**Call relations**: paste_image_to_temp_png calls this only after the normal clipboard route fails on Linux. This function calls is_probably_wsl to decide whether the fallback is appropriate, try_dump_windows_clipboard_image to ask Windows for the image, and convert_windows_path_to_wsl so Linux-side code can read the file.

*Call graph*: calls 3 internal fn (convert_windows_path_to_wsl, is_probably_wsl, try_dump_windows_clipboard_image); called by 1 (paste_image_to_temp_png); 4 external calls (image_dimensions, matches!, debug!, clone).


##### `try_dump_windows_clipboard_image`  (lines 199–229)

```
fn try_dump_windows_clipboard_image() -> Option<String>
```

**Purpose**: This asks Windows PowerShell to save the current clipboard image as a temporary PNG file. It is used only as a WSL workaround when Linux clipboard access cannot reach the Windows clipboard directly.

**Data flow**: It builds a small PowerShell script that reads an image from the Windows clipboard, saves it as a PNG in a temporary location, and prints the file path. It tries several common PowerShell command names. If one succeeds and prints a non-empty path, that Windows path is returned; otherwise it returns None.

**Call relations**: try_wsl_clipboard_fallback calls this after deciding that a WSL fallback is worth trying. This function hands back a Windows-style path, which the caller then translates into a Linux-readable WSL path.

*Call graph*: called by 1 (try_wsl_clipboard_fallback); 3 external calls (from_utf8_lossy, new, debug!).


##### `paste_image_to_temp_png`  (lines 232–237)

```
fn paste_image_to_temp_png() -> Result<(PathBuf, PastedImageInfo), PasteImageError>
```

**Purpose**: This gives callers a ready-to-use temporary PNG file for the pasted image instead of raw bytes. That is useful when later code expects a file path rather than an in-memory image.

**Data flow**: It first calls paste_image_as_png. If that succeeds, it creates a unique temporary .png file, writes the PNG bytes into it, keeps the file so it remains after the temporary handle is dropped, and returns the path plus image information. If normal paste fails on Linux, it may try the WSL fallback. On Android it returns a clear unsupported error.

**Call relations**: This is the main convenience entry point for image paste as a file. It delegates image reading and encoding to paste_image_as_png, uses the WSL fallback when needed, and returns the final path to the caller that will attach, serialize, or display the pasted image.

*Call graph*: calls 2 internal fn (paste_image_as_png, try_wsl_clipboard_fallback); 3 external calls (new, write, ClipboardUnavailable).


##### `normalize_pasted_search_query`  (lines 240–243)

```
fn normalize_pasted_search_query(pasted: &str) -> Option<String>
```

**Purpose**: This turns pasted text into a clean single-line search query. It removes leading and trailing blank space and collapses any internal whitespace, such as newlines and tabs, into single spaces.

**Data flow**: It receives pasted text. It splits the text wherever there is whitespace, joins the pieces back together with one space between each, and returns the cleaned string. If the paste contained no real text, it returns None.

**Call relations**: handle_paste calls this when pasted text is meant for search. It gives that higher-level paste flow a simple answer: either a useful one-line query or nothing to search for.

*Call graph*: called by 2 (handle_paste, handle_paste).


##### `normalize_pasted_path`  (lines 251–287)

```
fn normalize_pasted_path(pasted: &str) -> Option<PathBuf>
```

**Purpose**: This tries to understand pasted text as one filesystem path. It accepts common forms people paste, including file:// URLs, quoted paths, shell-escaped Unix paths, Windows drive paths, and UNC network paths.

**Data flow**: It receives pasted text and trims outer whitespace. It removes simple matching quotes if present, converts file:// URLs into local paths, recognizes Windows-style paths before shell parsing can damage their backslashes, and otherwise uses shell-style splitting to unescape a single path. It returns a PathBuf when the paste clearly means one path, or None when it looks like multiple tokens or not a path.

**Call relations**: handle_paste_image_path calls this when the user pastes a path to an image. The tests also exercise many edge cases. It calls normalize_windows_path for Windows-specific recognition and conversion, and uses URL and shell parsing libraries for the other formats.

*Call graph*: calls 1 internal fn (normalize_windows_path); called by 12 (handle_paste_image_path, normalize_double_quoted_windows_path, normalize_file_url, normalize_file_url_windows, normalize_multiple_tokens_returns_none, normalize_shell_escaped_single_path, normalize_simple_quoted_path_fallback, normalize_single_quoted_unix_path, normalize_single_quoted_windows_path, normalize_unc_windows_path (+2 more)); 3 external calls (from, new, parse).


##### `is_probably_wsl`  (lines 290–303)

```
fn is_probably_wsl() -> bool
```

**Purpose**: This detects whether the app is likely running inside WSL, the Windows Subsystem for Linux. That matters because paths and clipboard access behave differently there than on normal Linux.

**Data flow**: It reads /proc/version and looks for WSL-related words. If that does not prove anything, it checks environment variables commonly set by WSL. It returns true when either check suggests WSL, and false otherwise.

**Call relations**: Several parts of the app call this to choose WSL-specific behavior. In this file, normalize_windows_path uses it before translating Windows paths, and try_wsl_clipboard_fallback uses it before trying the PowerShell clipboard bridge.

*Call graph*: called by 11 (footer_props, paste_image_shortcut_prefers_ctrl_alt_v_under_wsl, is_wsl_session, normalize_windows_path, normalize_double_quoted_windows_path, normalize_file_url_windows, normalize_single_quoted_windows_path, normalize_unquoted_windows_path_with_spaces, normalize_windows_path_in_wsl, try_wsl_clipboard_fallback (+1 more)); 2 external calls (var_os, read_to_string).


##### `convert_windows_path_to_wsl`  (lines 306–331)

```
fn convert_windows_path_to_wsl(input: &str) -> Option<PathBuf>
```

**Purpose**: This translates a Windows drive path into the matching WSL path. For example, it can turn C:\Users\Alice\file.png into /mnt/c/Users/Alice/file.png.

**Data flow**: It receives a text path. If the path is a UNC network path or does not begin with a drive letter and colon, it returns None. Otherwise it builds a new PathBuf under /mnt/<drive>, splits the rest of the path on slashes or backslashes, appends each component, and returns the converted path.

**Call relations**: try_wsl_clipboard_fallback uses this after PowerShell reports where it saved a clipboard image. normalize_windows_path also uses it when a pasted Windows path appears while running under WSL.

*Call graph*: called by 6 (normalize_windows_path, normalize_double_quoted_windows_path, normalize_file_url_windows, normalize_single_quoted_windows_path, normalize_unquoted_windows_path_with_spaces, try_wsl_clipboard_fallback); 2 external calls (from, format!).


##### `normalize_windows_path`  (lines 333–361)

```
fn normalize_windows_path(input: &str) -> Option<PathBuf>
```

**Purpose**: This recognizes Windows-style paths and optionally adapts them for WSL. It protects paths like C:\Users\Alice\file.png from being misread as shell-escaped Unix text.

**Data flow**: It receives a text path. It checks whether it looks like a drive-letter path or a UNC network path. If not, it returns None. On Linux under WSL, it tries to convert drive-letter paths into /mnt/<drive> form. Otherwise it returns the original path as a PathBuf.

**Call relations**: normalize_pasted_path calls this before and after shell-style parsing. It calls is_probably_wsl and convert_windows_path_to_wsl only when WSL conversion might be needed.

*Call graph*: calls 2 internal fn (convert_windows_path_to_wsl, is_probably_wsl); called by 1 (normalize_pasted_path); 1 external calls (from).


##### `pasted_image_format`  (lines 364–375)

```
fn pasted_image_format(path: &Path) -> EncodedImageFormat
```

**Purpose**: This guesses an image format from a file path extension. It is a lightweight way to label pasted image paths as PNG, JPEG, or an unknown image type.

**Data flow**: It receives a filesystem path, reads its extension, lowercases it, and compares it with known image extensions. It returns Png for .png, Jpeg for .jpg or .jpeg, and Other for anything else or no extension.

**Call relations**: handle_paste_image_path calls this after a pasted path has been normalized. It gives the paste flow a simple format label without opening or decoding the image file.

*Call graph*: called by 1 (handle_paste_image_path); 1 external calls (extension).


##### `pasted_search_query_tests::collapses_whitespace`  (lines 382–387)

```
fn collapses_whitespace()
```

**Purpose**: This test proves that pasted search text with spaces, tabs, and newlines becomes one clean query line.

**Data flow**: It feeds a messy string into normalize_pasted_search_query and checks that the result is “alpha beta gamma”. The test passes only if extra whitespace is removed and word order is kept.

**Call relations**: The test runner calls this during tests. It protects the behavior used by handle_paste when pasted text is treated as a search query.

*Call graph*: 1 external calls (assert_eq!).


##### `pasted_paths_tests::normalize_file_url`  (lines 396–400)

```
fn normalize_file_url()
```

**Purpose**: This test checks that a Unix-style file:// URL is converted into a normal filesystem path.

**Data flow**: It gives normalize_pasted_path the text file:///tmp/example.png. It expects the returned path to be /tmp/example.png.

**Call relations**: The test runner calls this on non-Windows systems. It verifies the URL branch inside normalize_pasted_path.

*Call graph*: calls 1 internal fn (normalize_pasted_path); 1 external calls (assert_eq!).


##### `pasted_paths_tests::normalize_file_url_windows`  (lines 403–417)

```
fn normalize_file_url_windows()
```

**Purpose**: This test checks that a Windows drive path is accepted as a single pasted path. On WSL, it also checks that the path can be converted into /mnt/<drive> form.

**Data flow**: It sends C:\Temp\example.png into normalize_pasted_path. It builds the expected result based on whether the test is running under WSL, then compares the actual path with that expectation.

**Call relations**: The test runner calls this to protect Windows-path recognition. It exercises normalize_pasted_path and, on Linux, the WSL detection and path conversion helpers.

*Call graph*: calls 3 internal fn (convert_windows_path_to_wsl, is_probably_wsl, normalize_pasted_path); 2 external calls (from, assert_eq!).


##### `pasted_paths_tests::normalize_shell_escaped_single_path`  (lines 420–424)

```
fn normalize_shell_escaped_single_path()
```

**Purpose**: This test checks that a Unix path with a shell-escaped space becomes a normal path with a real space.

**Data flow**: It passes /home/user/My\ File.png into normalize_pasted_path and expects /home/user/My File.png back.

**Call relations**: The test runner calls this to verify the shell-style unescaping branch of normalize_pasted_path.

*Call graph*: calls 1 internal fn (normalize_pasted_path); 1 external calls (assert_eq!).


##### `pasted_paths_tests::normalize_simple_quoted_path_fallback`  (lines 427–431)

```
fn normalize_simple_quoted_path_fallback()
```

**Purpose**: This test checks that a double-quoted path is accepted even when it contains spaces.

**Data flow**: It passes a quoted /home/user/My File.png string into normalize_pasted_path. It expects the quotes to be removed and the inner path to be returned.

**Call relations**: The test runner calls this to protect the simple quote-stripping behavior in normalize_pasted_path.

*Call graph*: calls 1 internal fn (normalize_pasted_path); 1 external calls (assert_eq!).


##### `pasted_paths_tests::normalize_single_quoted_unix_path`  (lines 434–438)

```
fn normalize_single_quoted_unix_path()
```

**Purpose**: This test checks that a single-quoted Unix path is accepted and returned without the quotes.

**Data flow**: It gives normalize_pasted_path the text '/home/user/My File.png'. It expects a PathBuf for /home/user/My File.png.

**Call relations**: The test runner calls this to confirm that quoted pasted paths with spaces remain one path instead of being rejected as multiple words.

*Call graph*: calls 1 internal fn (normalize_pasted_path); 1 external calls (assert_eq!).


##### `pasted_paths_tests::normalize_multiple_tokens_returns_none`  (lines 441–446)

```
fn normalize_multiple_tokens_returns_none()
```

**Purpose**: This test checks that two pasted paths are not mistaken for one path. That prevents ambiguous paste input from being silently interpreted incorrectly.

**Data flow**: It passes text that shell-splits into two paths. It expects normalize_pasted_path to return None.

**Call relations**: The test runner calls this to protect the “single path only” rule in normalize_pasted_path.

*Call graph*: calls 1 internal fn (normalize_pasted_path); 1 external calls (assert!).


##### `pasted_paths_tests::pasted_image_format_png_jpeg_unknown`  (lines 449–470)

```
fn pasted_image_format_png_jpeg_unknown()
```

**Purpose**: This test checks format guessing for common image extensions. It makes sure PNG and JPEG are recognized and unknown or missing extensions stay generic.

**Data flow**: It passes several paths into pasted_image_format and compares each returned enum value with the expected format. The test includes uppercase extensions to confirm matching is case-insensitive.

**Call relations**: The test runner calls this to protect pasted_image_format, which is used when a pasted path points to an image file.

*Call graph*: 1 external calls (assert_eq!).


##### `pasted_paths_tests::normalize_single_quoted_windows_path`  (lines 473–489)

```
fn normalize_single_quoted_windows_path()
```

**Purpose**: This test checks that a single-quoted Windows path is still recognized as a Windows path after quotes are removed.

**Data flow**: It passes a quoted Windows path into normalize_pasted_path. It computes the expected result, converting to WSL form when appropriate, and checks that the returned path matches.

**Call relations**: The test runner calls this to cover the interaction between quote removal, Windows path recognition, and optional WSL conversion.

*Call graph*: calls 3 internal fn (convert_windows_path_to_wsl, is_probably_wsl, normalize_pasted_path); 2 external calls (from, assert_eq!).


##### `pasted_paths_tests::normalize_double_quoted_windows_path`  (lines 492–508)

```
fn normalize_double_quoted_windows_path()
```

**Purpose**: This test checks that a double-quoted Windows path is accepted and normalized correctly.

**Data flow**: It sends a double-quoted Windows path into normalize_pasted_path. It expects either the original Windows path or, under WSL, the converted /mnt/<drive> path.

**Call relations**: The test runner calls this to ensure normalize_pasted_path treats quoted Windows paths the same way as unquoted ones after removing the quotes.

*Call graph*: calls 3 internal fn (convert_windows_path_to_wsl, is_probably_wsl, normalize_pasted_path); 2 external calls (from, assert_eq!).


##### `pasted_paths_tests::normalize_unquoted_windows_path_with_spaces`  (lines 511–525)

```
fn normalize_unquoted_windows_path_with_spaces()
```

**Purpose**: This test checks that an unquoted Windows path containing spaces is still accepted as one path. This is important because Windows paths often contain folder names like “My Pictures”.

**Data flow**: It passes an unquoted Windows path with spaces into normalize_pasted_path. It expects the whole string to remain one path, with WSL conversion applied only when running under WSL.

**Call relations**: The test runner calls this to make sure Windows-path detection happens before shell-style splitting, which would otherwise treat spaces as separators.

*Call graph*: calls 3 internal fn (convert_windows_path_to_wsl, is_probably_wsl, normalize_pasted_path); 2 external calls (from, assert_eq!).


##### `pasted_paths_tests::normalize_unc_windows_path`  (lines 528–535)

```
fn normalize_unc_windows_path()
```

**Purpose**: This test checks that a UNC network path, such as \\server\share\folder\file.jpg, is accepted.

**Data flow**: It passes a UNC-style Windows network path into normalize_pasted_path and expects the same path back as a PathBuf.

**Call relations**: The test runner calls this to verify the UNC branch inside normalize_windows_path, reached through normalize_pasted_path.

*Call graph*: calls 1 internal fn (normalize_pasted_path); 1 external calls (assert_eq!).


##### `pasted_paths_tests::pasted_image_format_with_windows_style_paths`  (lines 538–551)

```
fn pasted_image_format_with_windows_style_paths()
```

**Purpose**: This test checks that image format guessing still works when the path text uses Windows-style backslashes.

**Data flow**: It passes Windows-looking paths ending in .PNG, .jpeg, and no extension into pasted_image_format. It expects PNG, JPEG, and Other respectively.

**Call relations**: The test runner calls this to protect extension-based format detection for paths pasted from Windows.

*Call graph*: 1 external calls (assert_eq!).


##### `pasted_paths_tests::normalize_windows_path_in_wsl`  (lines 555–567)

```
fn normalize_windows_path_in_wsl()
```

**Purpose**: This test checks the real WSL conversion behavior for Windows drive paths. It only performs the assertion when the test is actually running under WSL.

**Data flow**: It first asks is_probably_wsl whether the environment is WSL. If not, it exits early. If yes, it passes a Windows path into normalize_pasted_path and expects the matching /mnt/c/... path.

**Call relations**: The test runner calls this on Linux builds. It ties together is_probably_wsl, normalize_pasted_path, normalize_windows_path, and convert_windows_path_to_wsl in the environment where that conversion matters.

*Call graph*: calls 2 internal fn (is_probably_wsl, normalize_pasted_path); 1 external calls (assert_eq!).


### `tui/src/external_agent_config_migration_flow.rs`

`orchestration` · `request handling`

This file is the traffic controller for the `/import` experience in the text user interface. Its job is to safely start a migration from Claude Code configuration into Codex, without surprising the user or starting work in an unsupported situation.

The flow begins by checking the current app-server connection. Import is only allowed for a local Codex session using the embedded app server. It is blocked in remote workspaces, when Codex is connected to a separate local daemon, or when another import is already running. These checks matter because the import needs access to local files and must not overlap with another import job.

If import is allowed, the file asks the app server to detect Claude Code setup items. It looks both in the user’s home area and in the current working directory. If nothing is found, it reports that there is nothing to import.

When items are found, it shows an interactive prompt in the TUI. The user can choose items and either proceed or cancel. If import fails, the same prompt is shown again with the error message, like a form that stays open after a failed submission. If import starts successfully, the file returns a message explaining that the work is happening in the background and, if needed, that more items can be reviewed later.

#### Function details

##### `external_agent_config_migration_success_message`  (lines 22–28)

```
fn external_agent_config_migration_success_message(remaining_item_count: usize) -> String
```

**Purpose**: Builds the success text shown after an import has started. It also adds a note if there are still more detected items that were not included in this import.

**Data flow**: It receives the number of remaining items. It starts with a standard success sentence, asks `remaining_items_handoff` whether an extra follow-up sentence is needed, and returns either the plain success message or the success message plus that extra guidance.

**Call relations**: This is called by `handle_external_agent_config_migration_prompt` after the app server accepts an import request. It delegates the wording about leftover items to `remaining_items_handoff` so the main success message stays simple.

*Call graph*: calls 1 internal fn (remaining_items_handoff); called by 1 (handle_external_agent_config_migration_prompt); 1 external calls (format!).


##### `remaining_items_handoff`  (lines 30–41)

```
fn remaining_items_handoff(remaining_item_count: usize) -> Option<String>
```

**Purpose**: Creates the small follow-up note that tells the user whether more importable items remain. It handles the wording carefully so zero, one, and many items read naturally.

**Data flow**: It receives a count. If the count is zero, it returns nothing. If the count is one, it returns a sentence using singular wording. If the count is more than one, it returns a sentence with the exact number and plural wording.

**Call relations**: This helper is used only by `external_agent_config_migration_success_message`. It supplies the optional second sentence that tells the user to run `/import` again later if more items still need review.

*Call graph*: called by 1 (external_agent_config_migration_success_message); 1 external calls (format!).


##### `handle_external_agent_config_migration_prompt`  (lines 43–120)

```
async fn handle_external_agent_config_migration_prompt(
    tui: &mut tui::Tui,
    app_server: &mut AppServerSession,
    config: &Config,
) -> Result<ExternalAgentConfigMigrationFlowOutcome, String>
```

**Purpose**: Runs the complete Claude Code import flow from the TUI side. It decides whether import is allowed, asks the app server what can be imported, shows the user a selection prompt, and starts the import if the user chooses to proceed.

**Data flow**: It receives the TUI, the app-server session, and the current configuration. First it reads the app-server state to reject unsupported cases: remote workspace, non-embedded daemon mode, or an import already in progress. Then it reads the current working directory from the config and asks the app server to detect importable Claude Code setup items. If none are found, it returns `NoItems`. If items are found, it repeatedly shows a prompt with the detected items, the currently selected items, and any previous error. If the user cancels, it returns `Cancelled`. If the user proceeds, it asks the app server to start importing the chosen items. On success it returns `Started` with a user-facing message; on failure it records the error and shows the prompt again.

**Call relations**: This function is called by `handle_event` when the user triggers the import action. It coordinates lower-level pieces: it asks `AppServerSession` about connection mode and import state, calls the app server to detect and import configuration, uses `run_external_agent_config_migration_prompt` to interact with the user, and uses `external_agent_config_migration_success_message` to prepare the final confirmation text.

*Call graph*: calls 7 internal fn (external_agent_config_detect, external_agent_config_import, external_agent_config_import_in_progress, uses_embedded_app_server, uses_remote_workspace, run_external_agent_config_migration_prompt, external_agent_config_migration_success_message); called by 1 (handle_event); 4 external calls (format!, warn!, Started, vec!).


### `tui/src/theme_picker.rs`

`orchestration` · `request handling, when the user opens the /theme picker`

This file is the theme chooser for the terminal UI. Without it, users could not browse available syntax themes from inside the app, see what a theme looks like before choosing it, or safely back out without changing anything.

The file does three main jobs. First, it prepares the list of themes: built-in themes plus custom `.tmTheme` files found in the user’s Codex themes folder. Second, it builds a small preview of Rust code shown as a diff, meaning it includes unchanged lines, added lines, and removed lines. That preview uses the same syntax highlighting and diff styling as real code output, so the user sees a realistic sample. Third, it wires the dialog behavior: moving the cursor temporarily applies the highlighted theme, confirming sends an app event to save the choice, and canceling restores the theme that was active before the picker opened.

There are two preview layouts. On wider terminals, a larger preview sits beside the theme list. On narrower terminals, a compact four-line preview is stacked below the list. This is like a clothing store mirror that changes size depending on the room, but still lets you see the outfit before buying it.

#### Function details

##### `preview_diff_line_type`  (lines 148–154)

```
fn preview_diff_line_type(kind: PreviewDiffKind) -> DiffLineType
```

**Purpose**: Converts the preview’s simple idea of a line type — unchanged, added, or removed — into the diff line type used by the normal diff renderer. This lets the fake preview snippet look like real added and deleted code.

**Data flow**: It receives a preview line kind. It matches that kind to the renderer’s diff category, then returns the matching value: context for unchanged text, insert for added text, or delete for removed text.

**Call relations**: The preview renderer calls this for each preview row before drawing it, so every sample line is styled the same way a real diff line would be.

*Call graph*: called by 1 (render_preview).


##### `centered_offset`  (lines 156–164)

```
fn centered_offset(available: u16, content: u16, min_frame: u16) -> u16
```

**Purpose**: Calculates how much empty space should appear before vertically centered preview content. It keeps the wide preview from sticking to the top when there is room to make it look balanced.

**Data flow**: It receives the available height, the content height, and a minimum frame padding. It works out the leftover space, reserves a small frame if possible, and returns the top offset to use before drawing.

**Call relations**: The shared preview renderer uses this only when drawing the wide preview, where the code sample should be centered in the side panel.

*Call graph*: called by 1 (render_preview).


##### `render_preview`  (lines 166–235)

```
fn render_preview(
    area: Rect,
    buf: &mut Buffer,
    preview_rows: &[PreviewRow],
    center_vertically: bool,
    left_inset: u16,
)
```

**Purpose**: Draws the theme preview snippet into the terminal buffer. It shows line numbers, diff markers, syntax colors, and diff styling so the sample resembles real code output.

**Data flow**: It receives a screen area, a drawing buffer, a list of preview rows, and layout choices such as whether to center vertically and how far to inset from the left. It turns the sample code into syntax-highlighted spans, computes line number width, styles each row as added, removed, or unchanged, and writes the first rendered line for each preview row into the buffer.

**Call relations**: Both preview widgets call this function: the wide widget passes the larger sample and asks for vertical centering, while the narrow widget passes the compact sample and draws from the top. It relies on the diff rendering helpers and syntax highlighter so the preview matches the rest of the app.

*Call graph*: calls 7 internal fn (current_diff_render_style_context, line_number_width, push_wrapped_diff_line_with_style_context, push_wrapped_diff_line_with_syntax_and_style_context, highlight_code_to_styled_spans, centered_offset, preview_diff_line_type); called by 2 (render, render); 4 external calls (new, is_empty, iter, len).


##### `ThemePreviewWideRenderable::desired_height`  (lines 238–240)

```
fn desired_height(&self, _width: u16) -> u16
```

**Purpose**: Tells the layout system that the wide preview is happy to use as much vertical space as it can get. This helps it fill the side panel beside the theme list.

**Data flow**: It receives a width value but does not need it. It returns the largest possible height request, signaling that the preview can occupy the full available height.

**Call relations**: The selection dialog’s layout code asks this renderable how tall it wants to be when deciding how to place the side-by-side preview.


##### `ThemePreviewWideRenderable::render`  (lines 242–250)

```
fn render(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Draws the wide, side-panel version of the theme preview. It uses the longer code sample and centers it vertically with a small left inset.

**Data flow**: It receives the drawing area and terminal buffer. It passes those, along with the wide preview rows and layout settings, into the shared preview drawing function, which writes the preview into the buffer.

**Call relations**: The selection dialog calls this when the terminal is wide enough for a side-by-side layout. It delegates the actual drawing to `render_preview` so wide and narrow previews stay consistent.

*Call graph*: calls 1 internal fn (render_preview).


##### `ThemePreviewNarrowRenderable::desired_height`  (lines 254–256)

```
fn desired_height(&self, _width: u16) -> u16
```

**Purpose**: Tells the layout system that the narrow preview needs exactly enough height for its compact four-line sample. This keeps it small when stacked under the theme list.

**Data flow**: It receives a width value but does not need it. It returns the number of rows in the narrow preview sample.

**Call relations**: The selection dialog’s layout code uses this when the terminal is too narrow for a side panel and must stack the preview below the list.


##### `ThemePreviewNarrowRenderable::render`  (lines 258–266)

```
fn render(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Draws the compact preview used on narrower terminals. It shows a short diff with both an added and a removed line so users still see the important colors.

**Data flow**: It receives the drawing area and terminal buffer. It passes those, along with the narrow preview rows and non-centered layout settings, into the shared preview renderer, which writes the sample into the buffer.

**Call relations**: The selection dialog calls this as the fallback preview when side-by-side layout does not fit. Like the wide renderer, it hands the actual drawing to `render_preview`.

*Call graph*: calls 1 internal fn (render_preview).


##### `subtitle_available_width`  (lines 269–281)

```
fn subtitle_available_width(terminal_width: Option<u16>) -> usize
```

**Purpose**: Figures out how much horizontal room the theme picker subtitle can safely use. This prevents long helper text from overflowing or crowding the list.

**Data flow**: It receives the terminal width, or assumes a default if none is known. It calculates the popup’s content width, then checks whether the popup will use a side-by-side layout; if so, it returns the list column width, otherwise it returns the full content width.

**Call relations**: The subtitle builder calls this before deciding whether a path-based subtitle will fit. It relies on the same popup layout helpers used by the actual picker.

*Call graph*: called by 1 (theme_picker_subtitle); 2 external calls (popup_content_width, side_by_side_layout_widths).


##### `theme_picker_subtitle`  (lines 283–300)

```
fn theme_picker_subtitle(codex_home: Option<&Path>, terminal_width: Option<u16>) -> String
```

**Purpose**: Creates the small explanatory line shown under the theme picker title. When possible, it tells users where to put custom `.tmTheme` files; otherwise it shows simple preview instructions.

**Data flow**: It receives the Codex home directory and terminal width. It builds the expected `themes` directory path, formats it for display, checks whether the text fits in the available subtitle space, and returns either the custom-theme directory message or a fallback message about moving up and down to preview themes.

**Call relations**: The main picker builder uses this when filling in the dialog parameters. Several tests call it directly to make sure it chooses readable text for different terminal widths and directory paths.

*Call graph*: calls 1 internal fn (subtitle_available_width); called by 5 (build_theme_picker_params, subtitle_falls_back_for_94_column_terminal_side_by_side_layout, subtitle_falls_back_to_preview_instructions_without_tilde_path, subtitle_falls_back_when_tilde_path_subtitle_is_too_wide, subtitle_uses_tilde_path_when_codex_home_under_home_directory); 2 external calls (width, format!).


##### `build_theme_picker_params`  (lines 312–410)

```
fn build_theme_picker_params(
    current_name: Option<&str>,
    codex_home: Option<&Path>,
    terminal_width: Option<u16>,
) -> SelectionViewParams
```

**Purpose**: Builds the complete set of settings for the `/theme` selection dialog. This includes the theme list, search behavior, preview widgets, live preview callback, cancel restore callback, and confirmation action.

**Data flow**: It receives the currently configured theme name, the Codex home directory, and terminal width. It records the current active theme, loads available themes, decides which entry should start selected, turns each theme into a selectable item, attaches an action that sends a theme-selected event, prepares live-preview data, and returns a `SelectionViewParams` object used by the bottom-pane selection UI.

**Call relations**: The app calls this when opening the theme picker. The returned callbacks later run as the user moves through the list or cancels: selection changes temporarily set the syntax theme and notify the app to redraw, while cancel restores the saved original theme.

*Call graph*: calls 5 internal fn (standard_popup_hint_line, configured_theme_name, current_syntax_theme, list_available_themes, theme_picker_subtitle); called by 6 (theme_picker_enables_side_content_background_preservation, theme_picker_subtitle_uses_fallback_text_in_94x35_terminal, open_theme_picker, theme_picker_items_include_search_values_for_preview_mapping, theme_picker_uses_half_width_with_stacked_fallback_preview, unavailable_configured_theme_falls_back_to_configured_or_default_selection); 2 external calls (new, default).


##### `tests::render_buffer`  (lines 418–423)

```
fn render_buffer(renderable: &dyn Renderable, width: u16, height: u16) -> Buffer
```

**Purpose**: Test helper that renders a preview widget into an in-memory terminal buffer. It lets tests inspect what would have appeared on screen without opening a real terminal.

**Data flow**: It receives a renderable preview object plus a width and height. It creates an empty buffer of that size, asks the renderable to draw into it, and returns the filled buffer.

**Call relations**: Preview rendering tests call this when they need to check either the visible characters or the styling stored in the buffer.

*Call graph*: 3 external calls (empty, new, render).


##### `tests::render_lines`  (lines 425–441)

```
fn render_lines(renderable: &dyn Renderable, width: u16, height: u16) -> Vec<String>
```

**Purpose**: Test helper that converts a rendered buffer into plain strings, one per terminal row. This makes it easy for tests to check line numbers, diff markers, and spacing.

**Data flow**: It receives a renderable preview object and dimensions. It renders the object into a buffer, walks through each cell, turns empty cells into spaces, and returns the resulting list of text lines.

**Call relations**: Most preview layout tests call this to make assertions about what the wide and narrow previews display.

*Call graph*: 1 external calls (render_buffer).


##### `tests::first_non_space_style_after_marker`  (lines 443–452)

```
fn first_non_space_style_after_marker(buf: &Buffer, row: u16, width: u16) -> Option<Modifier>
```

**Purpose**: Finds the text style applied to the first visible code character after a diff marker. Tests use it to confirm that deleted preview code is dimmed like real deleted code.

**Data flow**: It receives a rendered buffer, a row number, and a width. It finds the `-` or `+` marker on that row, scans to the next non-space cell, and returns that cell’s style modifier if found.

**Call relations**: The deleted-line styling test uses this helper after rendering the narrow preview, so it can inspect styling rather than only visible text.


##### `tests::preview_line_number`  (lines 454–465)

```
fn preview_line_number(line: &str) -> Option<usize>
```

**Purpose**: Extracts the line number from a rendered preview line. This helps tests verify that preview rows appear in the expected order.

**Data flow**: It receives one rendered line of text. It trims leading spaces, reads the starting digits, checks that they are followed by a space, and returns the parsed number if the format matches.

**Call relations**: The preview layout tests use this to identify which rendered rows are actual preview lines and to confirm their line numbers.


##### `tests::preview_line_marker`  (lines 467–478)

```
fn preview_line_marker(line: &str) -> Option<char>
```

**Purpose**: Extracts the diff marker character from a rendered preview line. This lets tests count added and removed lines in the sample.

**Data flow**: It receives one rendered line of text. It trims leading spaces, skips the line number and following space, then returns the next character if the line matches the expected preview format.

**Call relations**: The wide and narrow preview tests use this helper to confirm that the preview includes `+` added lines and `-` removed lines.


##### `tests::theme_picker_uses_half_width_with_stacked_fallback_preview`  (lines 481–488)

```
fn theme_picker_uses_half_width_with_stacked_fallback_preview()
```

**Purpose**: Checks that the theme picker asks for a half-width side preview and also provides a stacked fallback preview. This protects the responsive layout behavior.

**Data flow**: It builds default theme picker parameters, then checks the side-content width setting, minimum preview width, and presence of stacked preview content.

**Call relations**: This test calls the main picker builder and verifies that the layout choices needed by the bottom-pane UI are present.

*Call graph*: calls 1 internal fn (build_theme_picker_params); 2 external calls (assert!, assert_eq!).


##### `tests::theme_picker_items_include_search_values_for_preview_mapping`  (lines 491–499)

```
fn theme_picker_items_include_search_values_for_preview_mapping()
```

**Purpose**: Checks that every theme item stores its real theme name as a search value. The live preview depends on those names staying aligned with the visible list.

**Data flow**: It builds theme picker parameters, inspects every item, and asserts that each one has a search value.

**Call relations**: This test protects the connection between the final item list and the live-preview callback created by `build_theme_picker_params`.

*Call graph*: calls 1 internal fn (build_theme_picker_params); 1 external calls (assert!).


##### `tests::wide_preview_renders_all_lines_with_vertical_center_and_left_inset`  (lines 502–549)

```
fn wide_preview_renders_all_lines_with_vertical_center_and_left_inset()
```

**Purpose**: Verifies that the wide preview draws every sample row, is vertically centered, and starts after the intended left inset. It also confirms that both added and removed lines are visible.

**Data flow**: It renders the wide preview into text lines, finds rows with preview line numbers, checks their count and vertical position, checks the first line’s indentation, and gathers diff markers to ensure both `+` and `-` appear.

**Call relations**: This test exercises `ThemePreviewWideRenderable::render` through the rendering helpers, indirectly checking the shared preview drawing logic.

*Call graph*: 3 external calls (assert!, assert_eq!, render_lines).


##### `tests::narrow_preview_renders_single_add_and_single_remove_in_four_lines`  (lines 552–579)

```
fn narrow_preview_renders_single_add_and_single_remove_in_four_lines()
```

**Purpose**: Verifies that the narrow preview stays compact and still shows one added and one removed line. This protects the fallback layout for small terminals.

**Data flow**: It renders the narrow preview into text lines, extracts line numbers and markers, and checks that the sample has four expected rows with exactly one `+` and one `-` marker.

**Call relations**: This test exercises `ThemePreviewNarrowRenderable::render` through the rendering helpers, making sure the compact sample remains useful.

*Call graph*: 3 external calls (assert!, assert_eq!, render_lines).


##### `tests::deleted_preview_code_uses_dim_overlay_like_real_diff_renderer`  (lines 582–598)

```
fn deleted_preview_code_uses_dim_overlay_like_real_diff_renderer()
```

**Purpose**: Checks that removed code in the preview is dimmed, matching the app’s real diff renderer. This matters because the preview should be a trustworthy sample of actual code output.

**Data flow**: It renders the narrow preview, finds the row marked as deleted, looks up the style of the first code character after the marker, and asserts that the dim style is present.

**Call relations**: This test combines the buffer and line helpers to inspect both the rendered text and the style data produced by the shared preview renderer.

*Call graph*: 4 external calls (assert!, first_non_space_style_after_marker, render_buffer, render_lines).


##### `tests::subtitle_uses_tilde_path_when_codex_home_under_home_directory`  (lines 601–609)

```
fn subtitle_uses_tilde_path_when_codex_home_under_home_directory()
```

**Purpose**: Checks that the subtitle can show a friendly `~` home-directory path when there is enough room. This makes the custom theme folder easier for users to recognize.

**Data flow**: It gets the user’s home directory, builds a Codex home path under it, asks for a subtitle with a wide terminal, and asserts that the result includes `~` and mentions a directory.

**Call relations**: This test calls `theme_picker_subtitle` directly to verify the user-facing helper text.

*Call graph*: calls 1 internal fn (theme_picker_subtitle); 2 external calls (assert!, home_dir).


##### `tests::subtitle_falls_back_when_tilde_path_subtitle_is_too_wide`  (lines 612–620)

```
fn subtitle_falls_back_when_tilde_path_subtitle_is_too_wide()
```

**Purpose**: Checks that an overly long custom-theme path is not shown in the subtitle. Instead, the picker should use the short fallback instruction.

**Data flow**: It builds a very long Codex home path under the user’s home directory, asks for a subtitle with limited width, and confirms the returned text is the fallback message.

**Call relations**: This test calls `theme_picker_subtitle` directly and protects the width check that keeps the dialog readable.

*Call graph*: calls 1 internal fn (theme_picker_subtitle); 2 external calls (assert_eq!, home_dir).


##### `tests::subtitle_falls_back_to_preview_instructions_without_tilde_path`  (lines 623–627)

```
fn subtitle_falls_back_to_preview_instructions_without_tilde_path()
```

**Purpose**: Checks that the subtitle uses the fallback preview instruction when there is no Codex home path. This avoids showing misleading custom-theme folder text.

**Data flow**: It asks for a subtitle without a Codex home directory and confirms that the fallback message is returned.

**Call relations**: This test calls `theme_picker_subtitle` directly for the no-path case.

*Call graph*: calls 1 internal fn (theme_picker_subtitle); 1 external calls (assert_eq!).


##### `tests::subtitle_falls_back_for_94_column_terminal_side_by_side_layout`  (lines 630–637)

```
fn subtitle_falls_back_for_94_column_terminal_side_by_side_layout()
```

**Purpose**: Checks a specific terminal width where the side-by-side layout leaves too little room for the custom-theme path subtitle. The picker should choose the shorter fallback text.

**Data flow**: It builds a normal Codex home path, asks for a subtitle at 94 columns, and confirms the fallback message is returned.

**Call relations**: This test calls `theme_picker_subtitle`, which in turn uses the available-width calculation tied to the picker layout.

*Call graph*: calls 1 internal fn (theme_picker_subtitle); 2 external calls (assert_eq!, home_dir).


##### `tests::unavailable_configured_theme_falls_back_to_configured_or_default_selection`  (lines 640–656)

```
fn unavailable_configured_theme_falls_back_to_configured_or_default_selection()
```

**Purpose**: Checks that if the saved theme name is not available, the picker still selects the app’s configured or default theme instead of an unrelated first item. This keeps opening the picker from accidentally previewing the wrong theme.

**Data flow**: It reads the configured-or-default theme name, builds picker parameters with a fake missing current theme, finds the initially selected item, and checks that its stored theme name matches the fallback theme.

**Call relations**: This test calls `build_theme_picker_params` and protects the selection logic used when the current configuration points to a theme that cannot be found.

*Call graph*: calls 2 internal fn (configured_theme_name, build_theme_picker_params); 1 external calls (assert_eq!).
