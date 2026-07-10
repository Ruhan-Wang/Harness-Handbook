# Specialized interactive flows and auxiliary TUI handlers  `stage-10.1.4`

This stage covers the app’s special side journeys: focused interactive screens and helpers that sit next to the main chat loop. Think of it as the set of tool panels, popups, and mini-workflows that let a user inspect, choose, undo, import, or customize things without changing the core event system.

Several files build complete interactive views. The cloud-tasks files store the screen state for task lists and new-task composition, then draw those screens, overlays, and dialogs in the terminal UI. The keymap files power the guided “change my shortcuts” flow: one file lists the actions that can be rebound, others show the picker, capture key presses, and offer a debug view that explains what key the terminal actually sent.

Other files support browsing and recovery. Backtracking and pager overlays let users review transcript history, preview rollback, and confirm undo steps. Multi-agent navigation keeps track of agent threads and turns raw events into readable picker labels. Pet and theme pickers build selection popups, while pet runtime code loads animations and schedules frames. Clipboard and external-import helpers connect the UI to the outside world by reading pasted content, normalizing paths, and guiding config import flows.

## Files in this stage

### Cloud tasks UI state
These files define the cloud-tasks TUI state, initialize the new-task composer, and render the task-oriented interface and overlays.

### `cloud-tasks/src/app.rs`

`data_model` · `main loop`

This file is the state container for the cloud-tasks terminal UI. It defines plain structs for environment rows and modal state, the main `App` struct that tracks task list contents, selection, status text, spinner flags, environment filter state, new-task page state, apply/preflight state, and some background coordination fields, plus `AppEvent`, the message enum used by background tasks to feed results back into the main event loop.

It also defines the detail-overlay model. `DiffOverlay` owns the currently viewed task title/ID, a `ScrollableDiff`, duplicated display fields (`diff_lines`, `text_lines`, `prompt`) for the selected attempt, and a vector of `AttemptView` entries representing the base attempt plus any siblings. The overlay can switch between `DetailView::Diff` and `DetailView::Prompt`, cycle attempts circularly, and project the selected attempt into the scrollable widget content. The invariant is that attempt 0 is always the base attempt; `base_attempt_mut` ensures it exists.

`load_tasks` is the only backend-facing function here: it wraps `backend.list_tasks` in a 5-second timeout, requests up to 20 tasks, and filters out review-only tasks before returning them. The test module uses a small fake backend to verify that environment filtering is passed through correctly.

#### Function details

##### `App::new`  (lines 78–102)

```
fn new() -> Self
```

**Purpose**: Constructs the initial TUI state with empty task data, no overlays or modals, default status text, and all inflight flags cleared.

**Data flow**: It allocates fresh empty vectors and a fresh `HashSet`, sets `selected` to 0, `status` to `"Press r to refresh"`, all optional modal/overlay fields to `None`, `best_of_n` to 1, and all loading/apply flags to `false`. It returns the fully initialized `App`.

**Call relations**: This is called at TUI startup before the event loop begins. Subsequent event handling mutates the fields initialized here.

*Call graph*: called by 1 (run_main); 2 external calls (new, new).


##### `App::next`  (lines 104–109)

```
fn next(&mut self)
```

**Purpose**: Moves the selected task index down by one without exceeding the last task.

**Data flow**: It reads `self.tasks.len()`, returns immediately if the list is empty, otherwise increments `self.selected` and clamps it to `len - 1` using `min` and `saturating_sub`.

**Call relations**: Used by list-view key handling to navigate downward through tasks.


##### `App::prev`  (lines 111–118)

```
fn prev(&mut self)
```

**Purpose**: Moves the selected task index up by one without going below zero.

**Data flow**: It returns immediately if there are no tasks; otherwise, if `self.selected > 0`, it decrements `self.selected` by one.

**Call relations**: Used by list-view key handling to navigate upward through tasks.


##### `load_tasks`  (lines 121–134)

```
async fn load_tasks(
    backend: &dyn CloudBackend,
    env: Option<&str>,
) -> anyhow::Result<Vec<TaskSummary>>
```

**Purpose**: Fetches the current task page from the backend with a timeout and removes review-only tasks before handing results to the UI.

**Data flow**: It takes a `CloudBackend` reference and optional environment string, wraps `backend.list_tasks(env, Some(20), None)` in `tokio::time::timeout(Duration::from_secs(5), ...)`, awaits both timeout and backend result, filters `tasks.tasks` to keep only entries where `!t.is_review`, and returns the filtered `Vec<TaskSummary>`.

**Call relations**: This is the shared background-load primitive used by the TUI startup refresh flow and tested by `tests::load_tasks_uses_env_parameter`.

*Call graph*: called by 2 (load_tasks_uses_env_parameter, run_main); 3 external calls (from_secs, list_tasks, timeout).


##### `AttemptView::has_diff`  (lines 164–166)

```
fn has_diff(&self) -> bool
```

**Purpose**: Reports whether an attempt currently has any diff lines loaded for display.

**Data flow**: It reads `self.diff_lines` and returns `true` when the vector is non-empty.

**Call relations**: Used by overlay key handling to decide whether switching to diff view is meaningful.


##### `AttemptView::has_text`  (lines 168–170)

```
fn has_text(&self) -> bool
```

**Purpose**: Reports whether an attempt has any prompt or assistant text content available.

**Data flow**: It checks whether `self.text_lines` is non-empty or `self.prompt` is `Some`, and returns that boolean.

**Call relations**: Used by overlay key handling to decide whether switching to prompt/text view is meaningful.


##### `DiffOverlay::new`  (lines 174–192)

```
fn new(task_id: TaskId, title: String, attempt_total_hint: Option<usize>) -> Self
```

**Purpose**: Creates an empty detail overlay for a task with a blank scrollable widget and one default base attempt slot.

**Data flow**: It takes a `TaskId`, title, and optional attempt-total hint; creates a new `ScrollableDiff`, seeds it with empty content, initializes display fields and sibling metadata to empty values, inserts `vec![AttemptView::default()]` as the attempts list, sets `selected_attempt` to 0 and `current_view` to `Prompt`, and returns the overlay.

**Call relations**: The TUI opens this immediately when entering task details, then later fills in diff/text data as background events arrive.

*Call graph*: calls 1 internal fn (new); 2 external calls (new, vec!).


##### `DiffOverlay::current_attempt`  (lines 194–196)

```
fn current_attempt(&self) -> Option<&AttemptView>
```

**Purpose**: Returns the currently selected attempt view if the selection index is valid.

**Data flow**: It reads `self.selected_attempt` and returns `self.attempts.get(index)`, yielding `Option<&AttemptView>`.

**Call relations**: This is a small accessor used by `apply_selection_to_fields` and `current_can_apply` to avoid indexing directly.

*Call graph*: called by 2 (apply_selection_to_fields, current_can_apply).


##### `DiffOverlay::base_attempt_mut`  (lines 198–203)

```
fn base_attempt_mut(&mut self) -> &mut AttemptView
```

**Purpose**: Returns a mutable reference to the base attempt, creating a default one if the attempts vector is unexpectedly empty.

**Data flow**: It checks `self.attempts.is_empty()`, pushes `AttemptView::default()` if needed, and then returns `&mut self.attempts[0]`.

**Call relations**: Used when background detail events populate the primary attempt’s diff/text fields. It preserves the invariant that attempt 0 always exists.

*Call graph*: 1 external calls (default).


##### `DiffOverlay::set_view`  (lines 205–208)

```
fn set_view(&mut self, view: DetailView)
```

**Purpose**: Switches the overlay between prompt and diff modes and refreshes the projected display fields accordingly.

**Data flow**: It writes the provided `DetailView` into `self.current_view` and then calls `apply_selection_to_fields()` to update `diff_lines`, `text_lines`, `prompt`, and scrollable content.

**Call relations**: Invoked by left/right navigation in the detail overlay.

*Call graph*: calls 1 internal fn (apply_selection_to_fields).


##### `DiffOverlay::expected_attempts`  (lines 210–218)

```
fn expected_attempts(&self) -> Option<usize>
```

**Purpose**: Returns the backend-provided attempt-total hint when available, otherwise infers a count from the loaded attempts vector.

**Data flow**: It reads `self.attempt_total_hint`; if present, returns it. Otherwise it returns `None` when `self.attempts` is empty or `Some(self.attempts.len())` when attempts exist.

**Call relations**: Used by `attempt_display_total` to decide what total count to show in the UI.

*Call graph*: called by 1 (attempt_display_total).


##### `DiffOverlay::attempt_count`  (lines 220–222)

```
fn attempt_count(&self) -> usize
```

**Purpose**: Returns the number of attempt entries currently loaded into the overlay.

**Data flow**: It reads `self.attempts.len()` and returns that `usize`.

**Call relations**: Used by overlay navigation logic to decide whether attempt cycling is possible.


##### `DiffOverlay::attempt_display_total`  (lines 224–227)

```
fn attempt_display_total(&self) -> usize
```

**Purpose**: Computes the total attempt count to display, guaranteeing at least one.

**Data flow**: It calls `expected_attempts()` and returns that value when present; otherwise it returns `self.attempts.len().max(1)`.

**Call relations**: Used by the UI when reporting which attempt is currently selected.

*Call graph*: calls 1 internal fn (expected_attempts).


##### `DiffOverlay::step_attempt`  (lines 229–242)

```
fn step_attempt(&mut self, delta: isize) -> bool
```

**Purpose**: Cycles the selected attempt forward or backward with wraparound and refreshes the visible content.

**Data flow**: It reads the current attempt count, returns `false` if there is only one or zero attempts, otherwise computes a wrapped next index using modular arithmetic on `delta`, writes it to `self.selected_attempt`, calls `apply_selection_to_fields()`, and returns `true`.

**Call relations**: Called by Tab, BackTab, and bracket-key handlers in the detail overlay.

*Call graph*: calls 1 internal fn (apply_selection_to_fields).


##### `DiffOverlay::current_can_apply`  (lines 244–251)

```
fn current_can_apply(&self) -> bool
```

**Purpose**: Determines whether the currently selected overlay state represents an applyable diff.

**Data flow**: It checks that `self.current_view` is `DetailView::Diff`, then inspects the current attempt’s `diff_raw` and returns true only when a non-empty raw diff string exists.

**Call relations**: Used before opening the apply modal so the UI only offers apply/preflight when a real diff is selected.

*Call graph*: calls 1 internal fn (current_attempt); 1 external calls (matches!).


##### `DiffOverlay::apply_selection_to_fields`  (lines 253–288)

```
fn apply_selection_to_fields(&mut self)
```

**Purpose**: Projects the currently selected attempt into the overlay’s top-level display fields and updates the scrollable widget content based on the active view.

**Data flow**: It reads `current_attempt()`. If no attempt exists, it clears `diff_lines`, `text_lines`, and `prompt`, sets the scrollable content to `"<loading attempt>"`, and returns. Otherwise it clones the selected attempt’s diff lines, text lines, and prompt into the overlay fields, then sets the scrollable content to either the diff lines or `"<no diff available>"` in diff view, or the text lines or `"<no output>"` in prompt view.

**Call relations**: This is the central synchronization method called after view changes and attempt changes, and after background events mutate attempt data.

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

**Purpose**: Generates deterministic fake task pages keyed by environment for the `load_tasks` unit test.

**Data flow**: It maps the optional environment to a vector of titles from `by_env` or a default pair, builds `TaskSummary` values with generated IDs, `Ready` status, current timestamps, environment IDs, default diff summaries, and `attempt_total: Some(1)`, then applies the requested `limit` capped at 20 and returns a `TaskListPage` preserving the incoming cursor.

**Call relations**: This fake backend method is used by the test-only `CloudBackend` implementation and reused by `tests::FakeBackend::get_task_summary`.

*Call graph*: called by 1 (get_task_summary); 7 external calls (pin, now, new, default, new, list_tasks, format!).


##### `tests::FakeBackend::get_task_summary`  (lines 441–443)

```
fn get_task_summary(&self, id: TaskId) -> CloudBackendFuture<'_, TaskSummary>
```

**Purpose**: Looks up one fake task summary by ID from the generated fake task list.

**Data flow**: It calls `self.list_tasks(None, None, None).await`, consumes the returned tasks, searches for a matching ID, and returns that summary or a `CloudTaskError::Msg` if absent.

**Call relations**: Used only in the test backend implementation to satisfy the trait.

*Call graph*: calls 1 internal fn (list_tasks); 2 external calls (pin, get_task_summary).


##### `tests::FakeBackend::get_task_diff`  (lines 445–451)

```
fn get_task_diff(&self, _id: TaskId) -> CloudBackendFuture<'_, Option<String>>
```

**Purpose**: Marks diff retrieval as intentionally unsupported in this test backend.

**Data flow**: It ignores the task ID and returns a boxed async error `CloudTaskError::Unimplemented("not used in test")`.

**Call relations**: Present only to satisfy the `CloudBackend` trait for the `load_tasks` test.

*Call graph*: 2 external calls (pin, Unimplemented).


##### `tests::FakeBackend::get_task_messages`  (lines 453–455)

```
fn get_task_messages(&self, _id: TaskId) -> CloudBackendFuture<'_, Vec<String>>
```

**Purpose**: Returns an empty assistant-message list in the test backend.

**Data flow**: It ignores the task ID and returns `Ok(vec![])` from a boxed async block.

**Call relations**: Unused by the current test but required by the trait implementation.

*Call graph*: 2 external calls (pin, vec!).


##### `tests::FakeBackend::get_task_text`  (lines 457–462)

```
fn get_task_text(
            &self,
            id: TaskId,
        ) -> CloudBackendFuture<'_, codex_cloud_tasks_client::TaskText>
```

**Purpose**: Returns a simple fake `TaskText` payload for tests that need the trait method implemented.

**Data flow**: It ignores the task ID and returns `TaskText { prompt: Some("Example prompt"), messages: [], turn_id: Some("fake-turn"), sibling_turn_ids: [], attempt_placement: Some(0), attempt_status: Completed }`.

**Call relations**: Used only to complete the test backend trait implementation.

*Call graph*: 3 external calls (pin, new, get_task_text).


##### `tests::FakeBackend::list_sibling_attempts`  (lines 464–470)

```
fn list_sibling_attempts(
            &self,
            _task: TaskId,
            _turn_id: String,
        ) -> CloudBackendFuture<'_, Vec<codex_cloud_tasks_client::TurnAttempt>>
```

**Purpose**: Returns no sibling attempts in the test backend.

**Data flow**: It ignores both task ID and turn ID and returns `Ok(Vec::new())` from a boxed async block.

**Call relations**: Unused by the current test but required by the trait.

*Call graph*: 2 external calls (pin, new).


##### `tests::FakeBackend::apply_task`  (lines 472–482)

```
fn apply_task(
            &self,
            _id: TaskId,
            _diff_override: Option<String>,
        ) -> CloudBackendFuture<'_, codex_cloud_tasks_client::ApplyOutcome>
```

**Purpose**: Marks apply as unsupported in the test backend.

**Data flow**: It ignores inputs and returns `CloudTaskError::Unimplemented("not used in test")` from a boxed async block.

**Call relations**: Only present to satisfy the trait in tests.

*Call graph*: 2 external calls (pin, Unimplemented).


##### `tests::FakeBackend::apply_task_preflight`  (lines 484–494)

```
fn apply_task_preflight(
            &self,
            _id: TaskId,
            _diff_override: Option<String>,
        ) -> CloudBackendFuture<'_, codex_cloud_tasks_client::ApplyOutcome>
```

**Purpose**: Marks preflight apply as unsupported in the test backend.

**Data flow**: It ignores inputs and returns `CloudTaskError::Unimplemented("not used in test")` from a boxed async block.

**Call relations**: Only present to satisfy the trait in tests.

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

**Purpose**: Marks task creation as unsupported in the test backend.

**Data flow**: It ignores all creation parameters and returns `CloudTaskError::Unimplemented("not used in test")` from a boxed async block.

**Call relations**: Only present to satisfy the trait in tests.

*Call graph*: 2 external calls (pin, Unimplemented).


##### `tests::load_tasks_uses_env_parameter`  (lines 513–533)

```
async fn load_tasks_uses_env_parameter()
```

**Purpose**: Verifies that `load_tasks` forwards the selected environment to the backend and returns the corresponding task set.

**Data flow**: It constructs a `FakeBackend` with different title vectors for `None`, `env-A`, and `env-B`, calls `load_tasks` three times with those filters, unwraps the results, and asserts the returned lengths and titles.

**Call relations**: This test exercises the file’s only backend-facing helper, `load_tasks`, using the local fake backend.

*Call graph*: calls 1 internal fn (load_tasks); 3 external calls (assert_eq!, new, vec!).


### `cloud-tasks/src/new_task.rs`

`data_model` · `new-task composition`

This file is a small UI-state wrapper around `codex_tui::ComposerInput`. `NewTaskPage` stores the live composer widget, whether submission is currently in progress, the selected environment ID to display and submit against, and the chosen best-of-N attempt count. Its constructor configures the composer with the exact footer hints the TUI expects: Enter to send, Shift+Enter for newline, Ctrl+O to switch environments, Ctrl+N to change attempts, and Ctrl+C to quit.

The type intentionally contains almost no behavior beyond construction. All editing, paste handling, submission, and modal interactions are driven from the main event loop in `lib.rs`; this file just packages the state needed for that page into one struct and ensures the composer starts with the right affordances. The `Default` implementation delegates to `new(None, 1)`, making the empty page correspond to no selected environment and a single attempt.

#### Function details

##### `NewTaskPage::new`  (lines 11–26)

```
fn new(env_id: Option<String>, best_of_n: usize) -> Self
```

**Purpose**: Creates a new task-composer page with a fresh composer widget, submission flag cleared, and the provided environment and best-of-N settings.

**Data flow**: It takes an optional environment ID and a `best_of_n` count, constructs `ComposerInput::new()`, sets its hint items to the fixed key/action pairs used by the TUI, and returns `NewTaskPage { composer, submitting: false, env_id, best_of_n }`.

**Call relations**: Called whenever the TUI opens the new-task page from the base list or environment modal. It delegates text-editing behavior to the embedded `ComposerInput`.

*Call graph*: calls 1 internal fn (new); 1 external calls (vec!).


##### `NewTaskPage::default`  (lines 32–34)

```
fn default() -> Self
```

**Purpose**: Builds the default new-task page with no selected environment and a single attempt.

**Data flow**: It calls `Self::new(None, 1)` and returns that value.

**Call relations**: Used wherever a generic empty `NewTaskPage` is needed without explicitly specifying environment or attempt count.

*Call graph*: 1 external calls (new).


### `cloud-tasks/src/ui.rs`

`orchestration` · `main loop`

This file is the presentation layer for the TUI. The top-level `draw` function splits the terminal into a main pane and a two-line footer, chooses between the task list and new-task composer, and then conditionally paints overlays and modals on top of the base screen. Shared overlay geometry is centralized in `overlay_outer`, `overlay_block`, and `overlay_content`, with rounded borders controlled once via `OnceLock<bool>` and the `CODEX_TUI_ROUNDED` environment variable.

The list view renders `TaskSummary` entries as four-line `ListItem`s with status color, environment label, relative timestamp, and diff summary. It dims the background whenever a modal or overlay is active and computes a simple selection-based percentage for the title. The footer combines keybinding hints, a right-aligned spinner area for inflight operations, and a sanitized single-line status message.

The diff overlay is the most stateful path: it derives title styling from applyability and failure text, optionally shows a status bar for prompt/diff view switching and attempt selection, updates the embedded `ScrollableDiff` width and viewport from the current rectangle, and then renders either syntax-colored diff lines or conversation-style lines. Conversation styling reconstructs semantic structure from wrapped rows using source-line indices, tracking speaker sections, fenced code blocks, and bullet indentation so wrapped continuations stay aligned. Additional modal renderers cover environment selection, parallel-attempt selection, and apply confirmation/results, each with focused layout and spinner behavior.

#### Function details

##### `draw`  (lines 28–57)

```
fn draw(frame: &mut Frame, app: &mut App)
```

**Purpose**: Composes the entire frame for the current application state, drawing the base page first and then any active overlays or modals. It is the single entry point for per-frame UI rendering.

**Data flow**: Takes a mutable `Frame` and mutable `App`; reads frame area and multiple `App` flags (`new_task`, `diff_overlay`, `env_modal`, `best_of_modal`, `apply_modal`) to choose layouts and subviews. It writes rendered widgets into the frame and may allow child functions to mutate UI-related app state such as spinner timestamps or embedded scroll geometry.

**Call relations**: The outer event/render loop calls this each frame. It delegates base content to `draw_new_task_page` or `draw_list`, always draws `draw_footer`, and conditionally layers `draw_diff_overlay`, `draw_env_modal`, `draw_best_of_modal`, and `draw_apply_modal` when those states are present.

*Call graph*: calls 8 internal fn (draw_apply_modal, draw_best_of_modal, draw_diff_overlay, draw_env_modal, draw_footer, draw_list, draw_new_task_page, area); 3 external calls (Length, Min, default).


##### `rounded_enabled`  (lines 62–69)

```
fn rounded_enabled() -> bool
```

**Purpose**: Lazily resolves whether overlay borders should use rounded corners, caching the decision for the process lifetime. The default is enabled unless an environment variable explicitly disables it.

**Data flow**: Reads `CODEX_TUI_ROUNDED` from the environment through a `OnceLock<bool>` initializer; interprets value `"1"` as enabled and falls back to `true` when unset or unreadable. Returns the cached boolean without mutating UI state after initialization.

**Call relations**: Only `overlay_block` consults this helper when constructing shared modal/overlay blocks, so all overlays get consistent border styling.

*Call graph*: called by 1 (overlay_block).


##### `overlay_outer`  (lines 71–88)

```
fn overlay_outer(area: Rect) -> Rect
```

**Purpose**: Computes the centered outer rectangle used by full-screen overlays and modals. It reserves 10% margins on all sides and returns the middle 80% region.

**Data flow**: Takes a `Rect`, applies a vertical `Layout` with 10/80/10 percentage splits, then applies the same horizontal split to the middle band, and returns the center rectangle. It does not mutate external state.

**Call relations**: All overlay/modal renderers call this first to get a consistent centered canvas before adding their own inner layout.

*Call graph*: called by 4 (draw_apply_modal, draw_best_of_modal, draw_diff_overlay, draw_env_modal); 2 external calls (Percentage, default).


##### `overlay_block`  (lines 90–98)

```
fn overlay_block() -> Block<'static>
```

**Purpose**: Builds the standard bordered and padded `Block` used by overlays and modals. It encapsulates border style and interior padding in one place.

**Data flow**: Creates a default `Block` with all borders, conditionally applies `BorderType::Rounded` based on `rounded_enabled()`, then adds symmetric horizontal padding and top/bottom padding. Returns the configured `Block<'static>`.

**Call relations**: Used directly by each modal/overlay renderer and indirectly by `overlay_content` to ensure geometry calculations match the actual block styling.

*Call graph*: calls 1 internal fn (rounded_enabled); called by 5 (draw_apply_modal, draw_best_of_modal, draw_diff_overlay, draw_env_modal, overlay_content); 2 external calls (default, new).


##### `overlay_content`  (lines 100–102)

```
fn overlay_content(area: Rect) -> Rect
```

**Purpose**: Calculates the inner content rectangle inside the shared overlay block chrome. This keeps content layout aligned with the exact padding and borders used for rendering.

**Data flow**: Takes an outer `Rect`, constructs the standard overlay block via `overlay_block()`, calls `.inner(area)`, and returns the resulting inner `Rect`.

**Call relations**: Called by all overlay/modal renderers after they choose an outer rectangle, so content placement stays synchronized with `overlay_block`.

*Call graph*: calls 1 internal fn (overlay_block); called by 4 (draw_apply_modal, draw_best_of_modal, draw_diff_overlay, draw_env_modal).


##### `draw_new_task_page`  (lines 104–174)

```
fn draw_new_task_page(frame: &mut Frame, area: Rect, app: &mut App)
```

**Purpose**: Renders the full-screen new-task composer page, including a dynamic title that reflects selected environment and parallel-attempt count. It also sizes and positions the composer near the bottom and places the terminal cursor where the composer requests.

**Data flow**: Reads `app.new_task`, `app.environments`, and frame dimensions to build title spans and compute a desired composer height bounded between 3 rows and terminal height minus 6. It clears and draws the page block, renders the composer into the bottom row allocation via `render_ref`, and writes cursor position into the frame when `cursor_pos` returns coordinates.

**Call relations**: Called by `draw` when `app.new_task` is active instead of the task list. It does not render footer hints itself beyond the composer because `draw` still invokes `draw_footer` separately.

*Call graph*: calls 3 internal fn (area, buffer_mut, set_cursor_position); called by 1 (draw); 8 external calls (default, Length, Min, default, from, format!, render_widget, vec!).


##### `draw_list`  (lines 176–234)

```
fn draw_list(frame: &mut Frame, area: Rect, app: &mut App)
```

**Purpose**: Renders the main task list view with selection highlighting, environment-filter title suffix, selection-based percent indicator, and optional dimming when focus belongs to an overlay. It also shows an in-box loading spinner during refreshes.

**Data flow**: Reads `app.tasks`, `app.selected`, modal/overlay presence flags, `app.env_filter`, `app.environments`, and `app.refresh_inflight`. It maps tasks through `render_task_item`, constructs `ListState` with the selected index, renders the surrounding block and inner list, and may mutate `app.spinner_start` when drawing the centered spinner.

**Call relations**: This is the normal base-page renderer when no new-task page is open. `draw` invokes it, and it delegates per-row formatting to `render_task_item` and loading feedback to `draw_centered_spinner`.

*Call graph*: calls 1 internal fn (draw_centered_spinner); called by 1 (draw); 12 external calls (default, Length, Min, default, from, new, default, default, format!, render_stateful_widget (+2 more)).


##### `draw_footer`  (lines 236–310)

```
fn draw_footer(frame: &mut Frame, area: Rect, app: &mut App)
```

**Purpose**: Paints the two-line footer containing keybinding help, a right-aligned activity spinner, and the current status/log message. It adapts the help text to overlay state and apply availability.

**Data flow**: Reads many `App` flags (`diff_overlay`, `new_task`, inflight booleans, `best_of_n`, `status`) to assemble help spans and choose whether to render a spinner. It writes widgets into the top and bottom footer rows, clears stale spinner/status regions, truncates overly long status text to 2000 characters, and may mutate `app.spinner_start` through `draw_inline_spinner`.

**Call relations**: Always called by `draw` after the main content area. It delegates spinner rendering to `draw_inline_spinner` when any background operation is active.

*Call graph*: calls 1 internal fn (draw_inline_spinner); called by 1 (draw); 8 external calls (Fill, Length, default, from, new, format!, render_widget, vec!).


##### `draw_diff_overlay`  (lines 312–467)

```
fn draw_diff_overlay(frame: &mut Frame, area: Rect, app: &mut App)
```

**Purpose**: Renders the centered details/diff overlay, including title state, optional prompt/diff status bar, attempt navigation hints, scroll geometry updates, and the final styled text body or loading spinner. It is the main consumer of `ScrollableDiff`.

**Data flow**: Reads `app.diff_overlay`, `app.details_inflight`, and `app.spinner_start`; derives `ov_can_apply`, failure state from the first wrapped line, title text, current view, attempt counts, and whether prompt/diff text exists. It clears and draws the overlay block, computes content rows, mutates the overlay’s `ScrollableDiff` via `set_width` and `set_viewport`, builds styled lines using either `style_diff_line` or `style_conversation_lines`, and renders a scrolled `Paragraph` or a centered spinner.

**Call relations**: Called by `draw` only when a diff overlay exists. It delegates geometry helpers to `overlay_outer`, `overlay_block`, and `overlay_content`, styling to `style_diff_line` or `style_conversation_lines`, and loading feedback to `draw_centered_spinner`.

*Call graph*: calls 4 internal fn (draw_centered_spinner, overlay_block, overlay_content, overlay_outer); called by 1 (draw); 11 external calls (Length, Min, default, from, new, from, new, format!, matches!, render_widget (+1 more)).


##### `draw_apply_modal`  (lines 469–550)

```
fn draw_apply_modal(frame: &mut Frame, area: Rect, app: &mut App)
```

**Purpose**: Displays the apply-confirmation/result modal with a header, body, and footer instructions. Depending on state, the body shows a spinner, a result message, and optional conflict/skipped path lists.

**Data flow**: Reads `app.apply_modal`, `app.apply_preflight_inflight`, `app.apply_inflight`, and `app.spinner_start`. It computes overlay geometry, renders the titled block, splits content into header/body/footer rows, and either draws centered spinners or constructs colored `Line` values from `result_message`, `result_level`, `conflict_paths`, and `skipped_paths` before rendering them in a wrapped paragraph.

**Call relations**: Invoked by `draw` when the apply modal is active. It uses the shared overlay helpers and delegates transient loading states to `draw_centered_spinner`.

*Call graph*: calls 4 internal fn (draw_centered_spinner, overlay_block, overlay_content, overlay_outer); called by 1 (draw); 10 external calls (Length, Min, default, from, new, new, format!, matches!, render_widget, vec!).


##### `style_conversation_lines`  (lines 558–652)

```
fn style_conversation_lines(
    sd: &crate::scrollable_diff::ScrollableDiff,
    attempt: Option<&AttemptView>,
) -> Vec<Line<'static>>
```

**Purpose**: Transforms wrapped conversation text into styled ratatui lines with speaker gutters, section headers, markdown-ish formatting, code-block coloring, and bullet continuation alignment. It reconstructs semantic structure from wrapped rows using source-line indices.

**Data flow**: Reads wrapped display lines, wrapped source indices, and raw source lines from a `ScrollableDiff`, plus optional `AttemptView` for assistant status. It tracks mutable local state for current speaker, fenced-code mode, previous source index, and bullet indentation; for each wrapped row it may emit speaker header lines, blank gutter lines, or content lines built from `conversation_gutter_span` and `conversation_text_spans`. It returns a `Vec<Line<'static>>`.

**Call relations**: Used by `draw_diff_overlay` when the active detail view is conversation/prompt rather than diff. It delegates header creation to `conversation_header_line`, gutter styling to `conversation_gutter_span`, and per-line text styling to `conversation_text_spans`.

*Call graph*: calls 6 internal fn (raw_line_at, wrapped_lines, wrapped_src_indices, conversation_gutter_span, conversation_header_line, conversation_text_spans); 4 external calls (from, raw, new, new).


##### `conversation_header_line`  (lines 654–678)

```
fn conversation_header_line(
    speaker: ConversationSpeaker,
    attempt: Option<&AttemptView>,
) -> Line<'static>
```

**Purpose**: Builds the decorative header line that starts a user or assistant section in conversation view. Assistant headers can include a colored attempt-status badge.

**Data flow**: Takes a `ConversationSpeaker` and optional `AttemptView`; creates a span vector beginning with a dim `╭ ` marker, appends speaker-specific labels, and for assistants optionally appends the result of `attempt_status_span(attempt.status)`. Returns a styled `Line<'static>`.

**Call relations**: Called from `style_conversation_lines` whenever a raw line exactly matches `user:` or `assistant:`. It delegates status coloring to `attempt_status_span`.

*Call graph*: calls 1 internal fn (attempt_status_span); called by 1 (style_conversation_lines); 2 external calls (from, vec!).


##### `conversation_gutter_span`  (lines 680–685)

```
fn conversation_gutter_span(speaker: ConversationSpeaker) -> ratatui::text::Span<'static>
```

**Purpose**: Returns the colored vertical gutter prefix used on conversation body lines. The gutter color matches the active speaker.

**Data flow**: Matches on `ConversationSpeaker` and returns either a cyan-dim or magenta-dim `Span<'static>` containing `"│ "`.

**Call relations**: Used by `style_conversation_lines` for both blank and nonblank body rows so speaker sections remain visually grouped.

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

**Purpose**: Styles one wrapped display fragment of conversation text, with special handling for fenced code blocks, markdown headings, and bullet lists whose wrapped continuations need indentation. For ordinary prose it reuses markdown text rendering.

**Data flow**: Consumes `display`, `in_code`, `is_new_raw`, and `bullet_indent`. If inside code, it returns a single cyan span. If the line begins a bullet item, it rewrites the marker to `• ` and preserves indentation; wrapped continuations get `indent + 2` spaces. If the line begins a markdown heading on a new raw line, it returns a bold magenta span. Otherwise it calls `render_markdown_text(display)`, extracts spans from the first rendered line when available, and falls back to a raw span if rendering yields nothing.

**Call relations**: This is the text-formatting worker used by `style_conversation_lines` after speaker and structural state have been determined. It is intentionally line-local and does not inspect the `ScrollableDiff` directly.

*Call graph*: called by 1 (style_conversation_lines); 5 external calls (raw, new, new, render_markdown_text, vec!).


##### `attempt_status_span`  (lines 742–751)

```
fn attempt_status_span(status: AttemptStatus) -> Option<ratatui::text::Span<'static>>
```

**Purpose**: Maps an `AttemptStatus` enum to a colored label span suitable for assistant conversation headers. Unknown status intentionally produces no badge.

**Data flow**: Matches the input `AttemptStatus` and returns `Some(Span)` for `Completed`, `Failed`, `InProgress`, `Pending`, and `Cancelled`, or `None` for `Unknown`.

**Call relations**: Only `conversation_header_line` calls this, and only for assistant sections where attempt metadata is relevant.

*Call graph*: called by 1 (conversation_header_line).


##### `style_diff_line`  (lines 753–786)

```
fn style_diff_line(raw: &str) -> Line<'static>
```

**Purpose**: Applies simple unified-diff coloring to a single raw line. It distinguishes hunk headers, file headers, additions, deletions, and unchanged lines by prefix.

**Data flow**: Reads `raw: &str`, checks prefixes in order (`@@`, `+++`/`---`, `+`, `-`), and returns a `Line<'static>` containing one styled or raw span. It does not mutate external state.

**Call relations**: Used by `draw_diff_overlay` when the current detail view is diff mode. It is intentionally stateless because diff styling depends only on each line’s prefix.

*Call graph*: 2 external calls (from, vec!).


##### `render_task_item`  (lines 788–844)

```
fn render_task_item(_app: &App, t: &codex_cloud_tasks_client::TaskSummary) -> ListItem<'static>
```

**Purpose**: Formats one task summary into the four-line list item shown in the main task list: status/title, metadata, diff summary, and a blank spacer row. It encodes task status and summary counts with color.

**Data flow**: Reads a `TaskSummary`’s `status`, `title`, `environment_label`, `updated_at`, and summary counters. It computes a colored status span, calls `format_relative_time_now` for the timestamp, builds either a `+adds/−dels • files` summary or `no diff`, appends a blank spacer line, and returns a `ListItem<'static>`.

**Call relations**: Mapped over `app.tasks` by `draw_list` to produce the visible list contents. The `_app` parameter is currently unused, signaling formatting is task-local.

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

**Purpose**: Renders a compact one-line spinner with a blinking dot and cyan label inside a fixed rectangle. The blink phase is derived from elapsed wall-clock time since the first use.

**Data flow**: Takes a mutable `spinner_start: &mut Option<Instant>` and inserts `Instant::now()` if absent, computes a 600 ms blink cadence from elapsed milliseconds, chooses either `• ` or dim `◦ `, combines it with the label, and renders a `Paragraph` into `area`.

**Call relations**: Called directly by `draw_footer` for the footer’s right-hand activity indicator and indirectly by `draw_centered_spinner` for centered loading states.

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

**Purpose**: Centers the inline spinner within a larger rectangle by carving out a one-row, fixed-width middle cell. It is a layout wrapper around `draw_inline_spinner`.

**Data flow**: Splits `area` vertically into 50% / 1 row / 49% and horizontally into 50% / 18 columns / 50%, then forwards the center cell plus `spinner_start` and `label` to `draw_inline_spinner`. It writes only through the delegated render call.

**Call relations**: Used by list, diff overlay, apply modal, and environment modal loading states whenever a spinner should appear centered rather than inline.

*Call graph*: calls 1 internal fn (draw_inline_spinner); called by 4 (draw_apply_modal, draw_diff_overlay, draw_env_modal, draw_list); 3 external calls (Length, Percentage, default).


##### `draw_env_modal`  (lines 893–991)

```
fn draw_env_modal(frame: &mut Frame, area: Rect, app: &mut App)
```

**Purpose**: Renders the environment-selection modal with a usage subheader, search query line, and filtered result list including a synthetic global option. It also shows a loading spinner while environments are being fetched.

**Data flow**: Reads `app.env_loading`, `app.env_modal`, and `app.environments`; computes overlay geometry; if loading, draws a centered spinner and returns early. Otherwise it lowercases the query, filters environments by substring match across label, id, and repo hints, builds `ListItem`s with pinned badges and dim metadata, clamps the selected index to the filtered list length plus the global row, and renders the stateful list.

**Call relations**: Called by `draw` when the environment modal is active. It uses shared overlay helpers and delegates loading feedback to `draw_centered_spinner`.

*Call graph*: calls 4 internal fn (draw_centered_spinner, overlay_block, overlay_content, overlay_outer); called by 1 (draw); 15 external calls (default, Length, Min, default, from, new, new, default, new, default (+5 more)).


##### `draw_best_of_modal`  (lines 993–1046)

```
fn draw_best_of_modal(frame: &mut Frame, area: Rect, app: &mut App)
```

**Purpose**: Displays a compact centered modal for choosing the number of parallel attempts, with fixed option rows for 1 through 4 and a marker for the current setting. It constrains modal size within min/max bounds before rendering.

**Data flow**: Reads `app.best_of_modal` and `app.best_of_n`, computes a centered modal rectangle inside `overlay_outer(area)` with width and height clamped to configured min/max constants, renders the titled block and hint row, builds list items for attempt counts 1..=4 with `Current` tagging when matching `best_of_n`, clamps the selected index, and renders the stateful list.

**Call relations**: Invoked by `draw` when the best-of modal is active. It shares overlay styling with other modals but has its own tighter geometry logic.

*Call graph*: calls 3 internal fn (overlay_block, overlay_content, overlay_outer); called by 1 (draw); 16 external calls (default, Length, Min, default, from, new, new, default, new, new (+6 more)).


### Transcript and navigation overlays
These files provide reusable overlay browsing plus the state and formatting logic behind transcript backtracking and multi-agent navigation flows.

### `tui/src/app/agent_navigation.rs`

`domain_logic` · `interactive navigation / picker rendering`

This module defines `AgentNavigationState`, a compact state container with two coordinated collections: `threads: HashMap<ThreadId, AgentPickerThreadEntry>` for the latest metadata per thread and `order: Vec<ThreadId>` for stable first-seen traversal order. The central invariant is that a thread id is appended to `order` only once, so later metadata updates never reshuffle keyboard next/previous navigation or picker row order.

Mutation methods are intentionally narrow. `upsert` inserts or refreshes nickname/role/closed-state while preserving any previously known `agent_path` and running flag. `record_sub_agent_activity` opportunistically creates or updates entries from activity notifications, `set_running` and `set_agent_path` patch individual fields, `mark_closed` flips closed/running state without removing the thread, `remove` fully deletes ghost entries, and `clear` resets the cache. Query methods expose emptiness, direct lookup, ordered rows, path-backed sub-agent subsets, tracked ids, and whether any non-primary thread exists.

Two methods derive user-facing behavior. `adjacent_thread_id` performs wraparound traversal in stable spawn order, returning `None` when there are fewer than two tracked threads or the current thread is unknown. `active_agent_label` produces the footer label for the currently displayed thread, preferring a non-empty `agent_path` for sub-agents and otherwise falling back to `format_agent_picker_item_name`. `picker_subtitle` derives its text from the actual shortcut helpers so the picker copy stays synchronized with key bindings. The included tests lock down ordering, wraparound traversal, shortcut mention text, and active-label formatting.

#### Function details

##### `AgentNavigationState::get`  (lines 63–65)

```
fn get(&self, thread_id: &ThreadId) -> Option<&AgentPickerThreadEntry>
```

**Purpose**: Returns the latest cached picker metadata for a specific thread id, if present.

**Data flow**: Borrows `self` and a `ThreadId`, performs a `HashMap::get` lookup in `threads`, and returns `Option<&AgentPickerThreadEntry>` without mutation.

**Call relations**: This is a simple query helper used by app code that already knows which thread it wants to inspect and needs the current cached metadata.


##### `AgentNavigationState::is_empty`  (lines 71–73)

```
fn is_empty(&self) -> bool
```

**Purpose**: Reports whether the navigation cache currently tracks any threads at all.

**Data flow**: Borrows `self`, checks `self.threads.is_empty()`, and returns the resulting boolean.

**Call relations**: App code uses this as a cheap gate before opening or populating the agent picker.


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

**Purpose**: Inserts or updates a thread's picker entry while preserving its original first-seen position in traversal order.

**Data flow**: Consumes a `ThreadId`, optional nickname/role, and `is_closed` flag. If the thread id is not already in `threads`, it appends it to `order`. It then reads any previous `agent_path` and `is_running`, and inserts a fresh `AgentPickerThreadEntry` that preserves the old path, keeps running true only if it was previously running and the thread is not now closed, and stores the new nickname/role/closed state.

**Call relations**: This is the primary mutation path for picker metadata and is also called by `mark_closed` when a close event arrives for an unknown thread. It enforces the module's stable-order invariant.

*Call graph*: called by 1 (mark_closed).


##### `AgentNavigationState::record_sub_agent_activity`  (lines 107–124)

```
fn record_sub_agent_activity(&mut self, activity: SubAgentActivityDisplay)
```

**Purpose**: Updates picker metadata from a `SubAgentActivityDisplay`, creating the thread entry if it has not been seen before.

**Data flow**: Consumes an activity record containing thread id, agent path, and running hint. It appends the thread id to `order` if absent, then gets or inserts a default `AgentPickerThreadEntry` and updates `agent_path`, `is_running`, and `is_closed` accordingly.

**Call relations**: This method is used when the app learns about sub-agent threads from activity notifications rather than explicit picker metadata, allowing the picker to surface them promptly.


##### `AgentNavigationState::set_running`  (lines 126–130)

```
fn set_running(&mut self, thread_id: ThreadId, is_running: bool)
```

**Purpose**: Updates only the running-state flag for an already tracked thread.

**Data flow**: Looks up the mutable entry for `thread_id` in `threads` and, if found, assigns `entry.is_running = is_running`. Missing threads are ignored.

**Call relations**: This targeted mutator is used by app lifecycle code when execution state changes but other picker metadata should remain untouched.


##### `AgentNavigationState::set_agent_path`  (lines 132–138)

```
fn set_agent_path(&mut self, thread_id: ThreadId, agent_path: Option<String>)
```

**Purpose**: Stores a non-empty agent path for an already tracked thread when one becomes known later.

**Data flow**: Accepts a `ThreadId` and `Option<String>`. If the option is `Some(agent_path)` and the thread exists in `threads`, it writes that path into `entry.agent_path`; `None` inputs and unknown threads are ignored.

**Call relations**: This helper lets app code enrich existing picker entries with path information discovered after initial insertion.


##### `AgentNavigationState::mark_closed`  (lines 146–156)

```
fn mark_closed(&mut self, thread_id: ThreadId)
```

**Purpose**: Marks a thread as closed while keeping it in the stable traversal cache.

**Data flow**: If the thread exists, it sets `is_closed = true` and `is_running = false`. If it does not exist, it calls `upsert` with no nickname/role and `is_closed = true`, thereby creating a placeholder entry and preserving order semantics.

**Call relations**: This method is used when threads terminate but should remain inspectable in the picker. It delegates to `upsert` only for the unknown-thread edge case.

*Call graph*: calls 1 internal fn (upsert).


##### `AgentNavigationState::clear`  (lines 162–165)

```
fn clear(&mut self)
```

**Purpose**: Resets all cached picker metadata and traversal order.

**Data flow**: Mutably clears both `threads` and `order`, leaving the state empty.

**Call relations**: App teardown or session-reset code uses this to discard all multi-agent navigation state at once.


##### `AgentNavigationState::remove`  (lines 172–175)

```
fn remove(&mut self, thread_id: ThreadId)
```

**Purpose**: Completely removes a thread from both metadata and traversal order.

**Data flow**: Deletes the thread id from `threads` and filters `order` to retain only ids not equal to the removed thread.

**Call relations**: This stronger deletion path is reserved for ghost or opportunistically discovered threads that should not remain visible once confirmed gone.


##### `AgentNavigationState::has_non_primary_thread`  (lines 182–186)

```
fn has_non_primary_thread(&self, primary_thread_id: Option<ThreadId>) -> bool
```

**Purpose**: Reports whether any tracked thread differs from the current primary thread.

**Data flow**: Iterates over `threads.keys()` and returns true if any key is not equal to `primary_thread_id`.

**Call relations**: The app uses this to decide whether multi-agent UI affordances should remain available even when collaboration features are otherwise disabled.


##### `AgentNavigationState::ordered_threads`  (lines 193–198)

```
fn ordered_threads(&self) -> Vec<(ThreadId, &AgentPickerThreadEntry)>
```

**Purpose**: Returns tracked threads in stable first-seen order, filtering out any ids whose metadata is currently missing.

**Data flow**: Iterates over `order`, looks up each id in `threads`, and collects only successful lookups into `Vec<(ThreadId, &AgentPickerThreadEntry)>`.

**Call relations**: This is the canonical ordered view used by traversal and picker-building methods such as `adjacent_thread_id`, `tracked_thread_ids`, and `ordered_path_backed_subagent_threads`.

*Call graph*: called by 4 (adjacent_thread_id, ordered_path_backed_subagent_threads, ordered_thread_ids, tracked_thread_ids).


##### `AgentNavigationState::ordered_path_backed_subagent_threads`  (lines 200–214)

```
fn ordered_path_backed_subagent_threads(
        &self,
        primary_thread_id: Option<ThreadId>,
    ) -> Vec<(ThreadId, &AgentPickerThreadEntry)>
```

**Purpose**: Returns only non-primary tracked threads that have a nonblank `agent_path`, preserving stable order.

**Data flow**: Calls `ordered_threads()`, then filters out the primary thread and any entries whose `agent_path` is absent or trims to empty. It returns the remaining ordered `(ThreadId, &AgentPickerThreadEntry)` pairs.

**Call relations**: This helper is used when the app needs a subset of sub-agents suitable for path-based displays or actions while preserving picker order.

*Call graph*: calls 1 internal fn (ordered_threads).


##### `AgentNavigationState::tracked_thread_ids`  (lines 217–222)

```
fn tracked_thread_ids(&self) -> Vec<ThreadId>
```

**Purpose**: Returns just the tracked thread ids in stable picker order.

**Data flow**: Calls `ordered_threads()`, maps each pair to its `ThreadId`, and collects the ids into a vector.

**Call relations**: This is a convenience projection over `ordered_threads` for callers that need ordering but not the associated metadata.

*Call graph*: calls 1 internal fn (ordered_threads).


##### `AgentNavigationState::adjacent_thread_id`  (lines 230–255)

```
fn adjacent_thread_id(
        &self,
        current_displayed_thread_id: Option<ThreadId>,
        direction: AgentNavigationDirection,
    ) -> Option<ThreadId>
```

**Purpose**: Computes the next or previous thread id relative to the currently displayed thread, wrapping around in stable spawn order.

**Data flow**: Builds `ordered_threads()`, returns `None` if fewer than two threads are tracked or if `current_displayed_thread_id` is absent/unknown, finds the current index, computes the adjacent index according to `AgentNavigationDirection` with wraparound, and returns the corresponding thread id.

**Call relations**: This method powers keyboard next/previous agent navigation. It depends on `ordered_threads` so traversal follows first-seen order rather than map iteration or thread-id sort order.

*Call graph*: calls 1 internal fn (ordered_threads).


##### `AgentNavigationState::active_agent_label`  (lines 263–298)

```
fn active_agent_label(
        &self,
        current_displayed_thread_id: Option<ThreadId>,
        primary_thread_id: Option<ThreadId>,
    ) -> Option<String>
```

**Purpose**: Derives the footer label for the currently displayed thread, suppressing the label entirely in single-thread sessions.

**Data flow**: Returns `None` if `threads.len() <= 1` or if no current displayed thread id is provided. Otherwise it determines whether the thread is primary, looks up the entry, and returns either a backticked nonblank `agent_path` for sub-agents or the result of `format_agent_picker_item_name` using nickname/role and primary status. If metadata is missing, it falls back to generic naming rules.

**Call relations**: The app uses this to populate contextual footer text while watching different threads. It intentionally shares naming logic with picker rows via `format_agent_picker_item_name`.


##### `AgentNavigationState::picker_subtitle`  (lines 304–311)

```
fn picker_subtitle() -> String
```

**Purpose**: Builds the `/agent` picker subtitle text from the actual previous/next shortcut definitions.

**Data flow**: Calls `previous_agent_shortcut()` and `next_agent_shortcut()`, converts them into `Span`s, reads their textual `content`, and interpolates both into a fixed instructional sentence.

**Call relations**: This helper is called by picker-opening code and by a unit test. By deriving text from the shortcut helpers, it prevents the picker subtitle from drifting away from real key bindings.

*Call graph*: calls 2 internal fn (next_agent_shortcut, previous_agent_shortcut); called by 2 (picker_subtitle_mentions_shortcuts, open_agent_picker); 1 external calls (format!).


##### `AgentNavigationState::ordered_thread_ids`  (lines 318–323)

```
fn ordered_thread_ids(&self) -> Vec<ThreadId>
```

**Purpose**: Test-only helper that returns ordered thread ids without exposing full picker entries.

**Data flow**: Calls `ordered_threads()`, maps each pair to its `ThreadId`, and collects the ids into a vector.

**Call relations**: This helper exists solely for focused tests of ordering invariants and delegates entirely to the production ordering logic.

*Call graph*: calls 1 internal fn (ordered_threads).


##### `tests::populated_state`  (lines 331–360)

```
fn populated_state() -> (AgentNavigationState, ThreadId, ThreadId, ThreadId)
```

**Purpose**: Creates a representative navigation state with one primary thread and two sub-agent threads for reuse across tests.

**Data flow**: Constructs a default `AgentNavigationState`, parses three fixed UUID strings into `ThreadId`s, inserts them with `upsert`, and returns the populated state plus the three ids.

**Call relations**: This fixture helper is called by multiple tests so they all exercise the same baseline ordering and metadata setup.

*Call graph*: calls 1 internal fn (from_string); 1 external calls (default).


##### `tests::upsert_preserves_first_seen_order`  (lines 363–377)

```
fn upsert_preserves_first_seen_order()
```

**Purpose**: Verifies that updating an existing thread via `upsert` does not move it in traversal order.

**Data flow**: Obtains a populated state, calls `upsert` again on the first agent with changed metadata and closed status, then asserts that `ordered_thread_ids()` still returns the original insertion order.

**Call relations**: This test directly guards the module's core invariant that updates must not reshuffle stable picker order.

*Call graph*: 2 external calls (assert_eq!, populated_state).


##### `tests::adjacent_thread_id_wraps_in_spawn_order`  (lines 380–395)

```
fn adjacent_thread_id_wraps_in_spawn_order()
```

**Purpose**: Checks that next/previous navigation wraps correctly at both ends of the stable order.

**Data flow**: Builds the populated state and asserts expected outputs from `adjacent_thread_id` for several current-thread/direction combinations, including wraparound from the last thread to the first and from the first to the last.

**Call relations**: This test validates the traversal logic used by keyboard agent navigation.

*Call graph*: 2 external calls (assert_eq!, populated_state).


##### `tests::picker_subtitle_mentions_shortcuts`  (lines 398–405)

```
fn picker_subtitle_mentions_shortcuts()
```

**Purpose**: Ensures the picker subtitle string includes the actual previous and next shortcut text.

**Data flow**: Builds the expected shortcut spans from `previous_agent_shortcut` and `next_agent_shortcut`, calls `AgentNavigationState::picker_subtitle()`, and asserts the resulting string contains both shortcut contents.

**Call relations**: This test protects the coupling between picker instructional text and the canonical shortcut helpers.

*Call graph*: calls 3 internal fn (picker_subtitle, next_agent_shortcut, previous_agent_shortcut); 1 external calls (assert!).


##### `tests::active_agent_label_tracks_current_thread`  (lines 408–419)

```
fn active_agent_label_tracks_current_thread()
```

**Purpose**: Verifies that the active-agent footer label reflects the currently displayed thread and distinguishes primary from sub-agent naming.

**Data flow**: Uses the populated state, calls `active_agent_label` for a sub-agent and for the primary thread, and asserts the returned strings match the expected formatted labels.

**Call relations**: This test covers the user-facing label derivation logic that the app uses in the footer while switching watched threads.

*Call graph*: 2 external calls (assert_eq!, populated_state).


### `tui/src/app_backtrack.rs`

`domain_logic` · `interactive transcript navigation and rollback handling`

This module is a small state machine layered onto `App`. `BacktrackState` tracks whether Esc has primed backtrack mode, which thread the selection is anchored to, the selected user-message index since the last session start, whether the transcript overlay is in preview mode, and any `PendingBacktrackRollback` awaiting server confirmation. The main interaction paths are split between the normal view and the transcript overlay: Esc in the main view primes backtrack, opens the overlay, or steps backward through user messages; overlay key handling maps Esc/Left/Right/Enter to stepping or confirming while forwarding all other events to the overlay widget. Confirmation computes a `BacktrackSelection` from the chosen `UserHistoryCell`, immediately prefills the composer and image state, and submits `AppCommand::thread_rollback(num_turns)` while recording a pending rollback guard tied to the current thread id. Actual transcript mutation is deferred until rollback success, at which point either `finish_pending_backtrack` trims to the selected user boundary or `apply_non_pending_thread_rollback` drops the last N user turns for externally initiated rollbacks. Helper functions define rollback semantics over `transcript_cells`: user positions are counted only after the most recent `SessionInfoCell`, and trimming removes the selected user cell and everything newer. The overlay path has special draw handling: on `Draw`/`Resize`, it asks `ChatWidget` for an active-cell cache key and render lines, appends that as a live tail to `TranscriptOverlay`, and schedules animation frames when needed so Ctrl+T reflects streaming output without waiting for transcript flushes.

#### Function details

##### `App::handle_backtrack_overlay_event`  (lines 113–171)

```
async fn handle_backtrack_overlay_event(
        &mut self,
        tui: &mut tui::Tui,
        event: TuiEvent,
    ) -> Result<bool>
```

**Purpose**: Routes keyboard and draw events while the transcript overlay is open, with special behavior when backtrack preview mode is active. It turns overlay navigation keys into backtrack selection changes or confirmation.

**Data flow**: It takes a mutable `App`, mutable `tui::Tui`, and a `TuiEvent`. If `self.backtrack.overlay_preview_active` is true, Esc/Left call `overlay_step_backtrack`, Right calls `overlay_step_backtrack_forward`, Enter calls `overlay_confirm_backtrack`, and all other events are forwarded to `overlay_forward_event`; each handled branch returns `Ok(true)`. If preview is inactive, a pressed/repeated Esc starts preview via `begin_overlay_backtrack_preview`, otherwise the event is forwarded to the overlay. State changes occur through those delegated helpers.

**Call relations**: Called by the app's event loop whenever the transcript overlay is active. It is the top-level dispatcher for overlay-specific backtrack behavior.

*Call graph*: calls 5 internal fn (begin_overlay_backtrack_preview, overlay_confirm_backtrack, overlay_forward_event, overlay_step_backtrack, overlay_step_backtrack_forward).


##### `App::handle_backtrack_esc_key`  (lines 174–186)

```
fn handle_backtrack_esc_key(&mut self, tui: &mut tui::Tui)
```

**Purpose**: Handles Esc presses in the main chat view when no overlay event routing is active. It primes backtrack, opens the preview overlay, or steps the current selection depending on state.

**Data flow**: It first returns if the composer is not empty. If `self.backtrack.primed` is false it calls `prime_backtrack()`. Else if no overlay is open it calls `open_backtrack_preview(tui)`. Else if overlay preview is active it calls `step_backtrack_and_highlight(tui)`. It mutates only backtrack/overlay state through those helpers.

**Call relations**: Used by the main key-handling path for Esc in normal chat mode.

*Call graph*: calls 3 internal fn (open_backtrack_preview, prime_backtrack, step_backtrack_and_highlight).


##### `App::apply_backtrack_rollback`  (lines 195–240)

```
fn apply_backtrack_rollback(&mut self, selection: BacktrackSelection)
```

**Purpose**: Stages a rollback request from a chosen backtrack selection, prefills the composer with the selected prompt, and submits the rollback command. It refuses side conversations and duplicate in-flight rollbacks.

**Data flow**: It takes a `BacktrackSelection`. If `chat_widget.side_conversation_active()` is true, it resets backtrack state and emits `SIDE_EDIT_PREVIOUS_UNAVAILABLE_MESSAGE`. It counts user turns with `user_count(&self.transcript_cells)` and returns if there are none. If `pending_rollback` already exists it emits an error and returns. It computes `num_turns = user_total.saturating_sub(selection.nth_user_message)`, converts to `u32` with saturation to `u32::MAX`, and returns if zero. It clones prefill/text/image data, stores `PendingBacktrackRollback { selection, thread_id: self.chat_widget.thread_id() }`, submits `AppCommand::thread_rollback(num_turns)` through the chat widget, sets remote image URLs, and if any prompt content exists sets the composer text and attachments.

**Call relations**: Called from overlay confirmation, explicit backtrack selection application, and cancelled-turn edit handling. It initiates rollback but leaves transcript trimming to later success handlers.

*Call graph*: calls 2 internal fn (reset_backtrack_state, user_count); called by 3 (apply_backtrack_selection, apply_cancelled_turn_edit, overlay_confirm_backtrack); 2 external calls (thread_rollback, try_from).


##### `App::apply_cancelled_turn_edit`  (lines 242–272)

```
fn apply_cancelled_turn_edit(&mut self, prompt: UserMessage)
```

**Purpose**: Converts a cancelled user turn into a rollback/edit flow that restores the cancelled prompt into the composer. It handles the special case where there is no committed user history yet.

**Data flow**: It derives `user_total` from `user_count`, builds a `BacktrackSelection` from the supplied `UserMessage` by copying text, text elements, local image paths, and remote image URLs, and then branches. If `user_total == 0`, it either emits an in-progress rollback error if `pending_rollback` exists or stores a one-turn `PendingBacktrackRollback`, submits `AppCommand::thread_rollback(1)`, and restores the prompt to the composer. Otherwise it delegates to `apply_backtrack_rollback(selection)` and then restores the prompt to the composer.

**Call relations**: Used when a turn is cancelled and the UI wants to reopen the user's prompt for editing while keeping rollback semantics consistent.

*Call graph*: calls 2 internal fn (apply_backtrack_rollback, user_count); 1 external calls (thread_rollback).


##### `App::open_transcript_overlay`  (lines 275–282)

```
fn open_transcript_overlay(&mut self, tui: &mut tui::Tui)
```

**Purpose**: Enters alternate-screen transcript overlay mode and seeds the overlay with the current committed transcript cells. It is the generic overlay-opening helper used by backtrack preview.

**Data flow**: It calls `tui.enter_alt_screen()`, sets `self.overlay = Some(Overlay::new_transcript(self.transcript_cells.clone(), self.keymap.pager.clone()))`, and schedules a frame through `tui.frame_requester().schedule_frame()`. It ignores alt-screen entry errors.

**Call relations**: Called by `open_backtrack_preview` when Esc transitions from primed mode into transcript preview.

*Call graph*: calls 1 internal fn (new_transcript); called by 1 (open_backtrack_preview); 2 external calls (enter_alt_screen, frame_requester).


##### `App::close_transcript_overlay`  (lines 285–302)

```
fn close_transcript_overlay(&mut self, tui: &mut tui::Tui)
```

**Purpose**: Closes the transcript overlay, restores normal screen mode, flushes any deferred history lines, and resets backtrack preview state. If the overlay had been used for backtracking, it fully resets backtrack state as well.

**Data flow**: It leaves alt-screen via `tui.leave_alt_screen()`, remembers whether backtrack preview was active, flushes `self.deferred_history_lines` into the terminal with the current wrap policy if non-empty, sets `self.overlay = None`, clears `self.backtrack.overlay_preview_active`, schedules a frame, and if `was_backtrack` calls `reset_backtrack_state()`.

**Call relations**: Called when the overlay is dismissed normally, when preview cannot start due to no user messages, and after confirming a backtrack selection.

*Call graph*: calls 1 internal fn (reset_backtrack_state); called by 3 (begin_overlay_backtrack_preview, overlay_confirm_backtrack, overlay_forward_event); 4 external calls (frame_requester, insert_history_hyperlink_lines_with_wrap_policy, leave_alt_screen, take).


##### `App::prime_backtrack`  (lines 305–312)

```
fn prime_backtrack(&mut self)
```

**Purpose**: Arms backtrack mode from the main view and captures the current thread as the rollback base. It also shows the Esc hint when there is at least one eligible user message.

**Data flow**: It sets `self.backtrack.primed = true`, `nth_user_message = usize::MAX`, and `base_id = self.chat_widget.thread_id()`. If `has_backtrack_target(&self.transcript_cells)` is true, it calls `chat_widget.show_esc_backtrack_hint()`.

**Call relations**: Called by `handle_backtrack_esc_key` on the first Esc press in the main view.

*Call graph*: calls 1 internal fn (has_backtrack_target); called by 1 (handle_backtrack_esc_key).


##### `App::open_backtrack_preview`  (lines 315–329)

```
fn open_backtrack_preview(&mut self, tui: &mut tui::Tui)
```

**Purpose**: Opens the transcript overlay and immediately begins backtrack preview mode. If there is no previous user message to edit, it resets state and shows an informational message instead.

**Data flow**: It checks `has_backtrack_target(&self.transcript_cells)`. If false, it resets backtrack state, adds `NO_PREVIOUS_MESSAGE_TO_EDIT` as an info message, schedules a frame, and returns. Otherwise it opens the transcript overlay, sets `overlay_preview_active = true`, clears the composer Esc hint, and calls `step_backtrack_and_highlight(tui)`.

**Call relations**: Called from `handle_backtrack_esc_key` when backtrack is already primed and no overlay is open.

*Call graph*: calls 4 internal fn (open_transcript_overlay, reset_backtrack_state, step_backtrack_and_highlight, has_backtrack_target); called by 1 (handle_backtrack_esc_key); 1 external calls (frame_requester).


##### `App::begin_overlay_backtrack_preview`  (lines 332–349)

```
fn begin_overlay_backtrack_preview(&mut self, tui: &mut tui::Tui)
```

**Purpose**: Starts backtrack preview from within an already open transcript overlay. It selects the latest user message as the initial target.

**Data flow**: If `has_backtrack_target` is false, it closes the overlay, emits `NO_PREVIOUS_MESSAGE_TO_EDIT`, schedules a frame, and returns. Otherwise it sets `backtrack.primed = true`, captures `base_id` from the current thread, sets `overlay_preview_active = true`, computes the user count, and if there is at least one user message applies the last index via `apply_backtrack_selection_internal(last)`. It then schedules a frame.

**Call relations**: Called by `handle_backtrack_overlay_event` when Esc is pressed in the overlay before preview mode has started.

*Call graph*: calls 4 internal fn (apply_backtrack_selection_internal, close_transcript_overlay, has_backtrack_target, user_count); called by 1 (handle_backtrack_overlay_event); 1 external calls (frame_requester).


##### `App::step_backtrack_and_highlight`  (lines 352–372)

```
fn step_backtrack_and_highlight(&mut self, tui: &mut tui::Tui)
```

**Purpose**: Moves the backtrack selection to the next older user message and updates the overlay highlight. Repeated Esc/Left presses walk backward through user prompts.

**Data flow**: It computes `count = user_count(&self.transcript_cells)` and returns if zero. It derives `last_index = count - 1` and then chooses `next_selection`: latest user if no selection exists yet, zero if already at the oldest, otherwise `nth_user_message - 1` clamped to `last_index`. It applies that selection with `apply_backtrack_selection_internal` and schedules a frame.

**Call relations**: Called from main-view Esc handling, initial preview opening, and overlay backtrack stepping.

*Call graph*: calls 2 internal fn (apply_backtrack_selection_internal, user_count); called by 3 (handle_backtrack_esc_key, open_backtrack_preview, overlay_step_backtrack); 1 external calls (frame_requester).


##### `App::step_forward_backtrack_and_highlight`  (lines 375–393)

```
fn step_forward_backtrack_and_highlight(&mut self, tui: &mut tui::Tui)
```

**Purpose**: Moves the backtrack selection toward newer user messages and updates the overlay highlight. This is the Right-arrow counterpart to backward stepping.

**Data flow**: It counts user messages, returns if zero, computes `last_index`, and chooses `next_selection`: latest user if no selection exists yet, otherwise `nth_user_message + 1` clamped to `last_index`. It applies the selection and schedules a frame.

**Call relations**: Called only from `overlay_step_backtrack_forward` while preview mode is active.

*Call graph*: calls 2 internal fn (apply_backtrack_selection_internal, user_count); called by 1 (overlay_step_backtrack_forward); 1 external calls (frame_requester).


##### `App::apply_backtrack_selection_internal`  (lines 396–408)

```
fn apply_backtrack_selection_internal(&mut self, nth_user_message: usize)
```

**Purpose**: Commits a computed user-message index into backtrack state and updates the transcript overlay highlight to the corresponding cell. Missing selections clear the highlight.

**Data flow**: It calls `nth_user_position(&self.transcript_cells, nth_user_message)`. On `Some(cell_idx)`, it stores `self.backtrack.nth_user_message = nth_user_message` and, if the overlay is `Overlay::Transcript`, calls `t.set_highlight_cell(Some(cell_idx))`. On `None`, it resets `nth_user_message` to `usize::MAX` and clears the overlay highlight.

**Call relations**: Used by all selection-stepping paths and by overlay-sync logic after transcript trimming.

*Call graph*: calls 1 internal fn (nth_user_position); called by 4 (begin_overlay_backtrack_preview, step_backtrack_and_highlight, step_forward_backtrack_and_highlight, sync_overlay_after_transcript_trim).


##### `App::overlay_forward_event`  (lines 423–459)

```
fn overlay_forward_event(&mut self, tui: &mut tui::Tui, event: TuiEvent) -> Result<()>
```

**Purpose**: Forwards events to the overlay widget, with special draw-time logic that injects the chat widget's live active cell as a render-only tail into the transcript overlay. It also closes the overlay when the widget reports completion.

**Data flow**: For `TuiEvent::Draw` or `Resize`, if the overlay is a transcript overlay it fetches `active_key` from `chat_widget.active_cell_transcript_key()`, then calls `tui.draw(...)` to compute width, sync the overlay's live tail from `chat_widget.active_cell_transcript_hyperlink_lines(width)`, and render the overlay. It checks `t.is_done()` to close the overlay if needed, and if the active key indicates animation and the overlay is scrolled to bottom, schedules another frame in 50 ms. For all other cases, if any overlay exists it forwards the event with `overlay.handle_event(tui, event)` and closes/schedules a frame if `overlay.is_done()`. It returns `Result<()>`.

**Call relations**: Called from overlay event routing and from backtrack stepping fallbacks when preview mode is not armed.

*Call graph*: calls 1 internal fn (close_transcript_overlay); called by 3 (handle_backtrack_overlay_event, overlay_step_backtrack, overlay_step_backtrack_forward); 4 external calls (draw, frame_requester, matches!, from_millis).


##### `App::overlay_confirm_backtrack`  (lines 462–470)

```
fn overlay_confirm_backtrack(&mut self, tui: &mut tui::Tui)
```

**Purpose**: Confirms the currently highlighted backtrack selection from the overlay, closes the overlay, and starts the rollback flow if a valid selection exists.

**Data flow**: It reads `self.backtrack.nth_user_message`, computes `selection = self.backtrack_selection(nth_user_message)`, closes the transcript overlay, and if `selection` is `Some`, calls `apply_backtrack_rollback(selection)` and schedules a frame.

**Call relations**: Called by `handle_backtrack_overlay_event` when Enter is pressed during overlay preview.

*Call graph*: calls 3 internal fn (apply_backtrack_rollback, backtrack_selection, close_transcript_overlay); called by 1 (handle_backtrack_overlay_event); 1 external calls (frame_requester).


##### `App::overlay_step_backtrack`  (lines 473–480)

```
fn overlay_step_backtrack(&mut self, tui: &mut tui::Tui, event: TuiEvent) -> Result<()>
```

**Purpose**: Handles backward stepping keys in overlay preview mode, but falls back to normal overlay event forwarding if preview is not properly armed. This preserves overlay navigation semantics outside backtrack mode.

**Data flow**: If `self.backtrack.base_id.is_some()`, it calls `step_backtrack_and_highlight(tui)`; otherwise it forwards the original event to `overlay_forward_event(tui, event)`. It returns `Result<()>`.

**Call relations**: Called from `handle_backtrack_overlay_event` for Esc and Left while preview mode is active.

*Call graph*: calls 2 internal fn (overlay_forward_event, step_backtrack_and_highlight); called by 1 (handle_backtrack_overlay_event).


##### `App::overlay_step_backtrack_forward`  (lines 483–494)

```
fn overlay_step_backtrack_forward(
        &mut self,
        tui: &mut tui::Tui,
        event: TuiEvent,
    ) -> Result<()>
```

**Purpose**: Handles forward stepping keys in overlay preview mode, with fallback to normal overlay forwarding when preview is not armed. It is the Right-arrow counterpart to `overlay_step_backtrack`.

**Data flow**: If `self.backtrack.base_id.is_some()`, it calls `step_forward_backtrack_and_highlight(tui)`; otherwise it forwards the event to `overlay_forward_event(tui, event)`. It returns `Result<()>`.

**Call relations**: Called from `handle_backtrack_overlay_event` for Right-arrow presses during overlay preview.

*Call graph*: calls 2 internal fn (overlay_forward_event, step_forward_backtrack_and_highlight); called by 1 (handle_backtrack_overlay_event).


##### `App::confirm_backtrack_from_main`  (lines 498–502)

```
fn confirm_backtrack_from_main(&mut self) -> Option<BacktrackSelection>
```

**Purpose**: Computes the current backtrack selection from main-view state and then resets backtrack mode. It does not itself submit the rollback.

**Data flow**: It calls `backtrack_selection(self.backtrack.nth_user_message)` to obtain an optional `BacktrackSelection`, then calls `reset_backtrack_state()` and returns the selection.

**Call relations**: Used by main-view confirmation flows outside the overlay to convert current selection state into a rollback candidate.

*Call graph*: calls 2 internal fn (backtrack_selection, reset_backtrack_state).


##### `App::reset_backtrack_state`  (lines 505–511)

```
fn reset_backtrack_state(&mut self)
```

**Purpose**: Clears all backtrack-mode state and removes any Esc hint from the composer. It is the common cleanup path after cancellation or confirmation.

**Data flow**: It sets `primed = false`, `base_id = None`, `nth_user_message = usize::MAX`, and calls `chat_widget.clear_esc_backtrack_hint()`. It does not touch `pending_rollback`.

**Call relations**: Called by several setup/teardown paths including overlay close, failed side-conversation rollback attempts, and main-view confirmation.

*Call graph*: called by 4 (apply_backtrack_rollback, close_transcript_overlay, confirm_backtrack_from_main, open_backtrack_preview).


##### `App::apply_backtrack_selection`  (lines 513–520)

```
fn apply_backtrack_selection(
        &mut self,
        tui: &mut tui::Tui,
        selection: BacktrackSelection,
    )
```

**Purpose**: Applies a precomputed backtrack selection and schedules a redraw. It is a small convenience wrapper around rollback staging.

**Data flow**: It forwards `selection` to `apply_backtrack_rollback(selection)` and then schedules a frame through `tui.frame_requester().schedule_frame()`. It returns `()`.

**Call relations**: Used by callers that already computed a `BacktrackSelection` and just need to trigger the rollback flow.

*Call graph*: calls 1 internal fn (apply_backtrack_rollback); 1 external calls (frame_requester).


##### `App::handle_backtrack_rollback_succeeded`  (lines 522–529)

```
fn handle_backtrack_rollback_succeeded(&mut self, num_turns: u32)
```

**Purpose**: Handles a successful rollback confirmation from the backend. If the rollback corresponds to an in-flight backtrack request, it finishes that request locally; otherwise it emits an app event for generic rollback trimming.

**Data flow**: It checks `self.backtrack.pending_rollback`. If present, it calls `finish_pending_backtrack()`. Otherwise it sends `AppEvent::ApplyThreadRollback { num_turns }` through `app_event_tx`.

**Call relations**: Called from thread-routing rollback response handling after the server confirms rollback.

*Call graph*: calls 1 internal fn (finish_pending_backtrack).


##### `App::handle_backtrack_rollback_failed`  (lines 531–533)

```
fn handle_backtrack_rollback_failed(&mut self)
```

**Purpose**: Clears the in-flight backtrack rollback guard after a rollback failure. It leaves any composer prefill intact for user convenience.

**Data flow**: It sets `self.backtrack.pending_rollback = None` and returns `()`. No other state is changed.

**Call relations**: Called when rollback RPC submission fails so the user can retry another backtrack action.


##### `App::apply_non_pending_thread_rollback`  (lines 539–550)

```
fn apply_non_pending_thread_rollback(&mut self, num_turns: u32) -> bool
```

**Purpose**: Applies local transcript trimming for a rollback that was not initiated by this TUI's backtrack flow. It drops the last N user turns and refreshes transcript-related UI state.

**Data flow**: It calls `trim_transcript_cells_drop_last_n_user_turns(&mut self.transcript_cells, num_turns)` and returns false immediately if nothing changed. On change it clears pending token activity and rate-limit hints in the chat widget, truncates agent copy history to the new `user_count`, calls `sync_overlay_after_transcript_trim()`, sets `backtrack_render_pending = true`, and returns true.

**Call relations**: Used when rollback effects arrive without a matching `pending_rollback`, complementing `finish_pending_backtrack`.

*Call graph*: calls 3 internal fn (sync_overlay_after_transcript_trim, trim_transcript_cells_drop_last_n_user_turns, user_count).


##### `App::finish_pending_backtrack`  (lines 556–575)

```
fn finish_pending_backtrack(&mut self)
```

**Purpose**: Completes a rollback that was initiated by this TUI's backtrack flow, but only if the response still targets the currently displayed thread. It trims transcript cells to the selected user boundary and refreshes dependent UI state.

**Data flow**: It takes and clears `self.backtrack.pending_rollback`; if absent it returns. If `pending.thread_id != self.chat_widget.thread_id()`, it returns without trimming. Otherwise it calls `trim_transcript_cells_to_nth_user(&mut self.transcript_cells, pending.selection.nth_user_message)`, and on success clears pending token/rate-limit hints, truncates agent copy history to the new `user_count`, syncs the overlay after trim, and sets `backtrack_render_pending = true`.

**Call relations**: Called only from `handle_backtrack_rollback_succeeded` when there is an in-flight pending rollback.

*Call graph*: calls 3 internal fn (sync_overlay_after_transcript_trim, trim_transcript_cells_to_nth_user, user_count); called by 1 (handle_backtrack_rollback_succeeded).


##### `App::backtrack_selection`  (lines 577–604)

```
fn backtrack_selection(&self, nth_user_message: usize) -> Option<BacktrackSelection>
```

**Purpose**: Builds a `BacktrackSelection` from the currently selected user-history cell, but only if the visible thread still matches the backtrack base thread. This prevents stale selections from crossing thread switches.

**Data flow**: It reads `self.backtrack.base_id`; if absent or if `self.chat_widget.thread_id()` differs, it returns `None`. Otherwise it finds the transcript cell index with `nth_user_position`, downcasts that cell to `UserHistoryCell`, and clones its message, text elements, local image paths, and remote image URLs. If lookup/downcast fails, it falls back to empty prompt data. It returns `Some(BacktrackSelection { nth_user_message, ... })`.

**Call relations**: Used by overlay confirmation and main-view confirmation to convert selection state into rollback input.

*Call graph*: calls 1 internal fn (nth_user_position); called by 2 (confirm_backtrack_from_main, overlay_confirm_backtrack).


##### `App::sync_overlay_after_transcript_trim`  (lines 613–631)

```
fn sync_overlay_after_transcript_trim(&mut self)
```

**Purpose**: Realigns overlay and backtrack selection state after transcript cells have been trimmed by rollback. It also drops deferred history lines that might reference removed cells.

**Data flow**: If the overlay is a transcript overlay, it replaces its committed cells with `self.transcript_cells.clone()`. If backtrack preview is active, it recomputes the valid selection range from `user_count(&self.transcript_cells)` and reapplies a clamped selection via `apply_backtrack_selection_internal`. Finally it clears `self.deferred_history_lines`.

**Call relations**: Called after both pending and non-pending rollback trims so overlay rendering and buffered history output cannot drift from the trimmed transcript.

*Call graph*: calls 2 internal fn (apply_backtrack_selection_internal, user_count); called by 2 (apply_non_pending_thread_rollback, finish_pending_backtrack).


##### `trim_transcript_cells_to_nth_user`  (lines 634–648)

```
fn trim_transcript_cells_to_nth_user(
    transcript_cells: &mut Vec<Arc<dyn crate::history_cell::HistoryCell>>,
    nth_user_message: usize,
) -> bool
```

**Purpose**: Implements backtrack trimming semantics for a selected user-message index: remove that user message and everything newer. It returns whether the transcript actually changed.

**Data flow**: It takes a mutable vector of `Arc<dyn HistoryCell>` and an index. If the index is `usize::MAX`, it returns false. Otherwise it finds the corresponding cell index with `nth_user_position`, records the original length, truncates the vector at that cell index, and returns whether the new length differs from the original.

**Call relations**: Used by `finish_pending_backtrack` and directly tested with several transcript-shape scenarios.

*Call graph*: calls 1 internal fn (nth_user_position); called by 4 (finish_pending_backtrack, trim_transcript_for_first_user_drops_user_and_newer_cells, trim_transcript_for_later_user_keeps_prior_history, trim_transcript_preserves_cells_before_selected_user).


##### `trim_transcript_cells_drop_last_n_user_turns`  (lines 650–672)

```
fn trim_transcript_cells_drop_last_n_user_turns(
    transcript_cells: &mut Vec<Arc<dyn crate::history_cell::HistoryCell>>,
    num_turns: u32,
) -> bool
```

**Purpose**: Drops the last N user turns from a transcript according to rollback semantics, preserving any leading non-user cells before the earliest remaining user turn. It tolerates oversized `num_turns` by trimming back to the first user turn.

**Data flow**: It returns false immediately for `num_turns == 0`. Otherwise it collects user cell positions with `user_positions_iter`, returns false if there are no user cells, converts `num_turns` to `usize` with saturation, computes `cut_idx` as either the first user index (overflow case) or the position of the Nth user from the end, truncates the transcript at `cut_idx`, and returns whether the length changed.

**Call relations**: Used by `apply_non_pending_thread_rollback` and covered by dedicated tests for normal and overflow trimming.

*Call graph*: calls 1 internal fn (user_positions_iter); called by 3 (apply_non_pending_thread_rollback, trim_drop_last_n_user_turns_allows_overflow, trim_drop_last_n_user_turns_applies_rollback_semantics); 1 external calls (try_from).


##### `user_count`  (lines 674–676)

```
fn user_count(cells: &[Arc<dyn crate::history_cell::HistoryCell>]) -> usize
```

**Purpose**: Counts user-history cells in the current session segment of the transcript. Cells before the most recent `SessionInfoCell` are ignored.

**Data flow**: It delegates to `user_positions_iter(cells).count()` and returns the resulting `usize`.

**Call relations**: Used throughout backtrack logic for selection bounds, rollback depth computation, and post-trim copy-history truncation.

*Call graph*: calls 1 internal fn (user_positions_iter); called by 10 (backtrack_selection_with_duplicate_history_targets_unique_turn, apply_backtrack_rollback, apply_cancelled_turn_edit, apply_non_pending_thread_rollback, begin_overlay_backtrack_preview, finish_pending_backtrack, step_backtrack_and_highlight, step_forward_backtrack_and_highlight, sync_overlay_after_transcript_trim, has_backtrack_target).


##### `has_backtrack_target`  (lines 678–680)

```
fn has_backtrack_target(cells: &[Arc<dyn crate::history_cell::HistoryCell>]) -> bool
```

**Purpose**: Reports whether there is at least one eligible user message to backtrack to in the current session segment. It is the gate for showing hints and opening preview.

**Data flow**: It calls `user_count(cells)` and returns whether the count is greater than zero.

**Call relations**: Used by priming and overlay-opening paths to decide whether backtrack UX should proceed.

*Call graph*: calls 1 internal fn (user_count); called by 3 (begin_overlay_backtrack_preview, open_backtrack_preview, prime_backtrack).


##### `nth_user_position`  (lines 682–689)

```
fn nth_user_position(
    cells: &[Arc<dyn crate::history_cell::HistoryCell>],
    nth: usize,
) -> Option<usize>
```

**Purpose**: Maps a logical user-message index within the current session segment to the corresponding transcript cell index. This is the bridge between backtrack selection state and actual transcript storage.

**Data flow**: It iterates `user_positions_iter(cells)` with enumeration, finds the first `(i, idx)` where `i == nth`, and returns `Some(idx)`; otherwise `None`.

**Call relations**: Used by selection highlighting, selection extraction, and transcript trimming helpers.

*Call graph*: calls 1 internal fn (user_positions_iter); called by 3 (apply_backtrack_selection_internal, backtrack_selection, trim_transcript_cells_to_nth_user).


##### `user_positions_iter`  (lines 691–708)

```
fn user_positions_iter(
    cells: &[Arc<dyn crate::history_cell::HistoryCell>],
) -> impl Iterator<Item = usize> + '_
```

**Purpose**: Iterates transcript indices of `UserHistoryCell`s after the most recent session-start marker. This defines the universe of backtrackable user turns.

**Data flow**: It computes `session_start_type = TypeId::of::<SessionInfoCell>()` and `user_type = TypeId::of::<UserHistoryCell>()`, finds the index after the last session-start cell (or zero if none), then iterates `cells` from that point and yields indices whose runtime type id matches `user_type`.

**Call relations**: This iterator underpins `user_count`, `nth_user_position`, and rollback trimming semantics.

*Call graph*: called by 3 (nth_user_position, trim_transcript_cells_drop_last_n_user_turns, user_count).


##### `agent_group_count`  (lines 711–713)

```
fn agent_group_count(cells: &[Arc<dyn crate::history_cell::HistoryCell>]) -> usize
```

**Purpose**: Counts distinct agent message groups in the current session segment for tests. It ignores stream continuations and non-agent cells.

**Data flow**: It delegates to `agent_group_positions_iter(cells).count()` and returns the count.

**Call relations**: Used only in tests to validate transcript grouping behavior around compacted-context markers.

*Call graph*: calls 1 internal fn (agent_group_positions_iter).


##### `agent_group_positions_iter`  (lines 716–736)

```
fn agent_group_positions_iter(
    cells: &[Arc<dyn crate::history_cell::HistoryCell>],
) -> impl Iterator<Item = usize> + '_
```

**Purpose**: Iterates indices of agent message cells that begin a new copy-source group after the most recent session start. Stream continuations are excluded.

**Data flow**: It finds the start index after the last `SessionInfoCell`, then iterates cells from there, downcasts each to `AgentMessageCell`, checks `!cell.is_stream_continuation()`, and yields indices for those first-in-group agent cells.

**Call relations**: Used only by `agent_group_count` in tests.

*Call graph*: called by 1 (agent_group_count).


##### `tests::render_lines`  (lines 747–757)

```
fn render_lines(lines: &[Line<'static>]) -> Vec<String>
```

**Purpose**: Converts rendered `ratatui::Line` values into plain strings for snapshot-style assertions. It strips styling and concatenates span contents.

**Data flow**: It iterates over the input lines, then over each line's spans, concatenates `span.content` into a `String`, and collects the strings into a `Vec<String>`.

**Call relations**: Used by the snapshot-oriented test at the end of the module.

*Call graph*: 1 external calls (iter).


##### `tests::trim_transcript_for_first_user_drops_user_and_newer_cells`  (lines 760–776)

```
fn trim_transcript_for_first_user_drops_user_and_newer_cells()
```

**Purpose**: Verifies that trimming to the first user message removes that user cell and everything after it. This is the most aggressive valid backtrack trim.

**Data flow**: It builds a transcript with one user cell followed by one agent cell, calls `trim_transcript_cells_to_nth_user(&mut cells, 0)`, and asserts that the resulting vector is empty.

**Call relations**: This test directly exercises the selected-user trimming helper.

*Call graph*: calls 1 internal fn (trim_transcript_cells_to_nth_user); 2 external calls (assert!, vec!).


##### `tests::trim_transcript_preserves_cells_before_selected_user`  (lines 779–811)

```
fn trim_transcript_preserves_cells_before_selected_user()
```

**Purpose**: Checks that trimming to a selected user preserves earlier non-user context cells. Introductory agent output before the selected user should remain.

**Data flow**: It builds a transcript of intro agent, first user, and trailing agent cells, trims to user index 0, then asserts that only the intro agent cell remains and that its rendered text is unchanged.

**Call relations**: This test covers the boundary where trimming should stop exactly at the selected user cell.

*Call graph*: calls 1 internal fn (trim_transcript_cells_to_nth_user); 2 external calls (assert_eq!, vec!).


##### `tests::trim_transcript_for_later_user_keeps_prior_history`  (lines 814–873)

```
fn trim_transcript_for_later_user_keeps_prior_history()
```

**Purpose**: Verifies that trimming to a later user keeps all earlier transcript history intact while removing the selected user and newer cells. This models rewinding to an intermediate prompt.

**Data flow**: It constructs a transcript with intro agent, first user, between agent, second user, and tail agent cells, trims to user index 1, and asserts that the first three cells remain with their original contents.

**Call relations**: This test exercises `trim_transcript_cells_to_nth_user` on a nonzero user index.

*Call graph*: calls 1 internal fn (trim_transcript_cells_to_nth_user); 2 external calls (assert_eq!, vec!).


##### `tests::trim_drop_last_n_user_turns_applies_rollback_semantics`  (lines 876–910)

```
fn trim_drop_last_n_user_turns_applies_rollback_semantics()
```

**Purpose**: Checks the helper that drops the last N user turns by count rather than by explicit selection. Dropping one turn should remove the newest user turn and its following cells.

**Data flow**: It builds a transcript with two user turns and trailing agent cells, calls `trim_transcript_cells_drop_last_n_user_turns(&mut cells, 1)`, and asserts that the function returned true, the transcript now has two cells, and the remaining user cell is the first one.

**Call relations**: This test covers the generic rollback-trim helper used for non-pending rollbacks.

*Call graph*: calls 1 internal fn (trim_transcript_cells_drop_last_n_user_turns); 3 external calls (assert!, assert_eq!, vec!).


##### `tests::trim_drop_last_n_user_turns_allows_overflow`  (lines 913–946)

```
fn trim_drop_last_n_user_turns_allows_overflow()
```

**Purpose**: Verifies that requesting more turns than exist trims back to the first user turn rather than failing. Leading non-user context should still be preserved.

**Data flow**: It builds a transcript with intro agent, one user, and trailing agent, calls `trim_transcript_cells_drop_last_n_user_turns(&mut cells, u32::MAX)`, and asserts that only the intro agent cell remains with its original rendered text.

**Call relations**: This test covers the overflow/saturation branch of the rollback-trim helper.

*Call graph*: calls 1 internal fn (trim_transcript_cells_drop_last_n_user_turns); 3 external calls (assert!, assert_eq!, vec!).


##### `tests::agent_group_count_ignores_context_compacted_marker`  (lines 949–966)

```
fn agent_group_count_ignores_context_compacted_marker()
```

**Purpose**: Ensures that context-compacted info cells do not count as agent message groups. Only actual first-in-group agent cells should be counted.

**Data flow**: It builds a transcript with agent, info-event, and agent cells, calls `agent_group_count(&cells)`, and asserts that the count is 2.

**Call relations**: This test validates the grouping iterator used only in test support.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `tests::backtrack_target_requires_user_message`  (lines 969–991)

```
fn backtrack_target_requires_user_message()
```

**Purpose**: Checks that backtrack availability depends on the presence of at least one user message, not merely any transcript content. Agent-only and info-only transcripts should not enable backtrack.

**Data flow**: It builds a transcript with an agent cell and an info event, asserts `!has_backtrack_target(&cells)`, then pushes a `UserHistoryCell` and asserts `has_backtrack_target(&cells)`.

**Call relations**: This test locks down the gate used by backtrack priming and overlay opening.

*Call graph*: 4 external calls (new, new, assert!, vec!).


##### `tests::backtrack_unavailable_info_message_snapshot`  (lines 994–1002)

```
fn backtrack_unavailable_info_message_snapshot()
```

**Purpose**: Snapshots the rendered informational message shown when there is no previous user message to edit. This protects the exact user-facing wording and formatting.

**Data flow**: It creates an info history cell with `NO_PREVIOUS_MESSAGE_TO_EDIT`, renders its display lines to plain strings via `render_lines`, joins them with newlines, and snapshots the result with `insta`.

**Call relations**: This test covers the user-visible fallback path used by `open_backtrack_preview` and `begin_overlay_backtrack_preview`.

*Call graph*: 3 external calls (new_info_event, assert_snapshot!, render_lines).


### `tui/src/multi_agents.rs`

`domain_logic` · `history rendering, agent picker display, and keyboard handling during interactive sessions`

This module is the presentation layer for multi-agent activity. It defines lightweight display structs such as `AgentPickerThreadEntry`, `SubAgentActivityDisplay`, `AgentMetadata`, and `SpawnRequestSummary`, then uses them to render collaboration events into `PlainHistoryCell`s and picker labels. The formatting code is intentionally concrete: spawn, send-input, resume, wait, close, and sub-agent activity events each map to specific title lines and optional detail lines. Titles are built from styled `Span`s, prefixed with a dim bullet, and may include agent nickname/role plus spawn-request model and reasoning-effort details. Prompt and status messages are truncated to fixed grapheme limits so history rows stay compact.

The main dispatcher is `tool_call_history_cell`, which pattern-matches `ThreadItem::CollabAgentToolCall`, suppresses some in-progress rows, parses receiver thread IDs, and routes to helpers like `spawn_end`, `waiting_begin`, `waiting_end`, or `resume_end`. Waiting completion merges receiver order with any extra agent states, deduplicates by parsed `ThreadId`, and sorts extras for stable output. Status rendering distinguishes pending, running, interrupted, completed-with-preview, errored-with-preview, shutdown, and not-found states.

The file also owns fast-switch keyboard semantics for previous/next agent navigation. Canonical bindings are Alt-Left and Alt-Right, with macOS-only Option-b/f fallbacks gated by `allow_word_motion_fallback` so empty-composer navigation works without stealing normal word-motion editing.

#### Function details

##### `agent_picker_status_dot_spans`  (lines 75–82)

```
fn agent_picker_status_dot_spans(is_closed: bool) -> Vec<Span<'static>>
```

**Purpose**: Builds the colored status-dot prefix shown for agent picker entries.

**Data flow**: It takes `is_closed: bool`, chooses a plain bullet for closed agents or a green bullet for active/open agents, appends a trailing space span, and returns the two-span vector.

**Call relations**: This helper is used by picker rendering code to keep status-dot styling consistent across agent rows.

*Call graph*: 1 external calls (vec!).


##### `format_agent_picker_item_name`  (lines 84–103)

```
fn format_agent_picker_item_name(
    agent_nickname: Option<&str>,
    agent_role: Option<&str>,
    is_primary: bool,
) -> String
```

**Purpose**: Formats the human-readable picker label from optional nickname and role, with a special label for the primary thread.

**Data flow**: Inputs are optional nickname and role strings plus `is_primary`. If primary, it returns `Main [default]`. Otherwise it trims and filters empty nickname/role values, then returns one of `nickname [role]`, `nickname`, `[role]`, or `Agent`.

**Call relations**: This function is consumed by picker UI code that needs a stable display name independent of the underlying thread ID.

*Call graph*: 1 external calls (format!).


##### `previous_agent_shortcut`  (lines 105–107)

```
fn previous_agent_shortcut() -> crate::key_hint::KeyBinding
```

**Purpose**: Returns the canonical key binding for switching to the previous agent.

**Data flow**: It constructs and returns `crate::key_hint::alt(KeyCode::Left)`. No state is read or written.

**Call relations**: This binding is used both for display in picker subtitles and for matching actual key events in `previous_agent_shortcut_matches`.

*Call graph*: calls 1 internal fn (alt); called by 3 (picker_subtitle, picker_subtitle_mentions_shortcuts, previous_agent_shortcut_matches).


##### `next_agent_shortcut`  (lines 109–111)

```
fn next_agent_shortcut() -> crate::key_hint::KeyBinding
```

**Purpose**: Returns the canonical key binding for switching to the next agent.

**Data flow**: It constructs and returns `crate::key_hint::alt(KeyCode::Right)`. No state is mutated.

**Call relations**: Like the previous binding, this is used for both UI hints and event matching via `next_agent_shortcut_matches`.

*Call graph*: calls 1 internal fn (alt); called by 3 (picker_subtitle, picker_subtitle_mentions_shortcuts, next_agent_shortcut_matches).


##### `previous_agent_shortcut_matches`  (lines 115–121)

```
fn previous_agent_shortcut_matches(
    key_event: KeyEvent,
    allow_word_motion_fallback: bool,
) -> bool
```

**Purpose**: Checks whether a key event should be interpreted as the previous-agent command, including optional platform fallback behavior.

**Data flow**: It takes a `KeyEvent` and `allow_word_motion_fallback`. It returns true if the event matches `previous_agent_shortcut().is_press(...)` or if `previous_agent_word_motion_fallback(...)` returns true.

**Call relations**: Callers use this predicate instead of hard-coding key combinations; it delegates fallback-specific logic to `previous_agent_word_motion_fallback`.

*Call graph*: calls 2 internal fn (previous_agent_shortcut, previous_agent_word_motion_fallback).


##### `next_agent_shortcut_matches`  (lines 125–131)

```
fn next_agent_shortcut_matches(
    key_event: KeyEvent,
    allow_word_motion_fallback: bool,
) -> bool
```

**Purpose**: Checks whether a key event should be interpreted as the next-agent command, including optional platform fallback behavior.

**Data flow**: It takes a `KeyEvent` and `allow_word_motion_fallback`. It returns true if the event matches `next_agent_shortcut().is_press(...)` or if `next_agent_word_motion_fallback(...)` returns true.

**Call relations**: This is the symmetric companion to `previous_agent_shortcut_matches`, delegating fallback handling to `next_agent_word_motion_fallback`.

*Call graph*: calls 2 internal fn (next_agent_shortcut, next_agent_word_motion_fallback).


##### `previous_agent_word_motion_fallback`  (lines 155–160)

```
fn previous_agent_word_motion_fallback(
    _key_event: KeyEvent,
    _allow_word_motion_fallback: bool,
) -> bool
```

**Purpose**: Implements the macOS-specific Option-b fallback for previous-agent navigation when enhanced keyboard reporting is unavailable.

**Data flow**: On macOS it inspects the full `KeyEvent` and returns true only when fallback is allowed and the event is an Alt-`b` press or repeat; on non-macOS builds it ignores inputs and returns false.

**Call relations**: This helper is only consulted by `previous_agent_shortcut_matches`, keeping platform-specific fallback logic isolated.

*Call graph*: called by 1 (previous_agent_shortcut_matches); 1 external calls (matches!).


##### `next_agent_word_motion_fallback`  (lines 181–186)

```
fn next_agent_word_motion_fallback(
    _key_event: KeyEvent,
    _allow_word_motion_fallback: bool,
) -> bool
```

**Purpose**: Implements the macOS-specific Option-f fallback for next-agent navigation when enhanced keyboard reporting is unavailable.

**Data flow**: On macOS it returns true only when fallback is allowed and the event is an Alt-`f` press or repeat; on non-macOS builds it always returns false.

**Call relations**: This helper is only used by `next_agent_shortcut_matches`.

*Call graph*: called by 1 (next_agent_shortcut_matches); 1 external calls (matches!).


##### `spawn_request_summary`  (lines 188–201)

```
fn spawn_request_summary(item: &ThreadItem) -> Option<SpawnRequestSummary>
```

**Purpose**: Extracts the requested model and reasoning effort from a spawn-agent tool call when both fields are present.

**Data flow**: It pattern-matches a `ThreadItem`. For `ThreadItem::CollabAgentToolCall` with `tool: SpawnAgent`, `model: Some`, and `reasoning_effort: Some`, it clones those values into `SpawnRequestSummary`; otherwise it returns `None`.

**Call relations**: This helper is used by higher-level collaboration handling and by `tool_call_history_cell` to annotate spawn history rows with request details.

*Call graph*: called by 2 (on_collab_agent_tool_call, tool_call_history_cell).


##### `tool_call_history_cell`  (lines 203–279)

```
fn tool_call_history_cell(
    item: &ThreadItem,
    cached_spawn_request: Option<&SpawnRequestSummary>,
    mut agent_metadata: impl FnMut(ThreadId) -> AgentMetadata,
) -> Option<PlainHistoryCell>
```

**Purpose**: Converts a collaboration tool-call `ThreadItem` into a rendered history cell, or suppresses it when the event should not yet appear.

**Data flow**: It takes a `ThreadItem`, an optional cached spawn request, and an `agent_metadata` lookup closure. It first rejects non-`CollabAgentToolCall` items. For matching items it parses the first receiver thread ID, normalizes the prompt, then dispatches by `tool`: completed spawn calls become `spawn_end`, completed send-input calls become `interaction_end`, resume calls become `resume_begin` or `resume_end` depending on status, wait calls become `waiting_begin` or `waiting_end`, and completed close calls become `close_end`. Some in-progress tools return `None` to avoid premature rows. It returns `Option<PlainHistoryCell>`.

**Call relations**: This is the main formatter used by collaboration event handling and tests. It delegates concrete row construction to the specialized helpers for each tool type.

*Call graph*: calls 4 internal fn (spawn_end, spawn_request_summary, waiting_begin, waiting_end); called by 4 (on_collab_agent_tool_call, collab_events_snapshot, collab_resume_interrupted_snapshot, title_styles_nickname_and_role); 1 external calls (matches!).


##### `sub_agent_activity_display`  (lines 281–296)

```
fn sub_agent_activity_display(item: &ThreadItem) -> Option<SubAgentActivityDisplay>
```

**Purpose**: Extracts a compact display record from a `SubAgentActivity` thread item.

**Data flow**: It pattern-matches `ThreadItem::SubAgentActivity`, parses `agent_thread_id` into `ThreadId`, clones `agent_path`, and sets `is_running_hint` to false only for `Interrupted`. It returns `Some(SubAgentActivityDisplay)` or `None`.

**Call relations**: This helper is used by higher-level activity handling that needs structured sub-agent display data rather than a rendered history cell.

*Call graph*: calls 1 internal fn (parse_thread_id); 1 external calls (matches!).


##### `sub_agent_activity_history_cell`  (lines 298–309)

```
fn sub_agent_activity_history_cell(item: &ThreadItem) -> Option<PlainHistoryCell>
```

**Purpose**: Formats a sub-agent activity event into a simple collaboration history cell.

**Data flow**: It matches `ThreadItem::SubAgentActivity`, builds a title line with `sub_agent_activity_title`, passes that plus an empty details vector to `collab_event`, and returns the resulting `PlainHistoryCell` inside `Some`; non-matching items return `None`.

**Call relations**: This function is called by sub-agent activity handling code and delegates title construction and common cell assembly to local helpers.

*Call graph*: calls 2 internal fn (collab_event, sub_agent_activity_title); called by 1 (on_sub_agent_activity); 1 external calls (new).


##### `sub_agent_activity_summary`  (lines 311–317)

```
fn sub_agent_activity_summary(kind: SubAgentActivityKind, agent_path: &str) -> String
```

**Purpose**: Produces a plain string summary for a sub-agent activity kind and path.

**Data flow**: It takes a `SubAgentActivityKind` and `agent_path` and returns one of `Started`, `Interacted with`, or `Interrupted` followed by the path in backticks.

**Call relations**: This helper provides a non-rich-text summary parallel to `sub_agent_activity_title` for contexts that need plain strings.

*Call graph*: 1 external calls (format!).


##### `sub_agent_activity_title`  (lines 319–329)

```
fn sub_agent_activity_title(kind: SubAgentActivityKind, agent_path: &str) -> Line<'static>
```

**Purpose**: Builds the styled title line for a sub-agent activity history row.

**Data flow**: It maps the activity kind to a bold prefix string, wraps the path in cyan backticks, passes the span vector to `title_spans_line`, and returns the resulting `Line<'static>`.

**Call relations**: This helper is used by `sub_agent_activity_history_cell` to produce the row title before common cell assembly.

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

**Purpose**: Builds the history cell shown when a spawn-agent call completes or fails.

**Data flow**: Inputs are an optional new thread ID, the spawn prompt, optional spawn-request details, and an agent metadata lookup closure. If a thread ID exists it builds a `Spawned ...` title with `title_with_agent`; otherwise it uses `title_text("Agent spawn failed")`. It optionally adds a truncated prompt detail via `prompt_line`, then returns `collab_event(title, details)`.

**Call relations**: This helper is called from `tool_call_history_cell` for completed spawn calls.

*Call graph*: calls 5 internal fn (agent_label, collab_event, prompt_line, title_text, title_with_agent); called by 1 (tool_call_history_cell); 1 external calls (new).


##### `interaction_end`  (lines 353–369)

```
fn interaction_end(
    receiver_thread_id: ThreadId,
    prompt: &str,
    agent_metadata: &mut impl FnMut(ThreadId) -> AgentMetadata,
) -> PlainHistoryCell
```

**Purpose**: Builds the history cell for a completed send-input action to an existing agent.

**Data flow**: It takes the receiver thread ID, prompt text, and metadata lookup closure, builds a `Sent input to ...` title with `title_with_agent`, optionally appends a truncated prompt detail from `prompt_line`, and returns the assembled `PlainHistoryCell` via `collab_event`.

**Call relations**: This helper is reached from `tool_call_history_cell` for completed `SendInput` tool calls.

*Call graph*: calls 4 internal fn (agent_label, collab_event, prompt_line, title_with_agent); 1 external calls (new).


##### `waiting_begin`  (lines 371–401)

```
fn waiting_begin(
    receiver_thread_ids: &[String],
    agent_metadata: &mut impl FnMut(ThreadId) -> AgentMetadata,
) -> PlainHistoryCell
```

**Purpose**: Builds the history cell shown while waiting on one or more agents.

**Data flow**: It takes receiver thread ID strings and a metadata lookup closure, parses valid thread IDs, fetches metadata for each, and chooses a title based on count: `Waiting for <agent>`, `Waiting for agents`, or `Waiting for N agents`. For multi-agent waits it also builds one detail line per agent label. It returns the final `PlainHistoryCell` via `collab_event`.

**Call relations**: This helper is called by `tool_call_history_cell` for in-progress `Wait` tool calls.

*Call graph*: calls 4 internal fn (agent_label, collab_event, title_text, title_with_agent); called by 1 (tool_call_history_cell); 2 external calls (new, format!).


##### `waiting_end`  (lines 403–410)

```
fn waiting_end(
    receiver_thread_ids: &[String],
    agents_states: &std::collections::HashMap<String, CollabAgentState>,
    agent_metadata: &mut impl FnMut(ThreadId) -> AgentMetadata,
) -> PlainH
```

**Purpose**: Builds the history cell shown when a wait operation completes and agent statuses are available.

**Data flow**: It takes receiver thread IDs, the `agents_states` map, and a metadata lookup closure. It computes detail lines with `wait_complete_lines`, uses `title_text("Finished waiting")` for the title, and returns `collab_event(title, details)`.

**Call relations**: This helper is called by `tool_call_history_cell` for completed `Wait` tool calls.

*Call graph*: calls 3 internal fn (collab_event, title_text, wait_complete_lines); called by 1 (tool_call_history_cell).


##### `close_end`  (lines 412–424)

```
fn close_end(
    receiver_thread_id: ThreadId,
    agent_metadata: &mut impl FnMut(ThreadId) -> AgentMetadata,
) -> PlainHistoryCell
```

**Purpose**: Builds the history cell for a completed close-agent action.

**Data flow**: It takes the receiver thread ID and metadata lookup closure, creates a `Closed ...` title with `title_with_agent`, passes an empty details vector to `collab_event`, and returns the resulting cell.

**Call relations**: This helper is used by `tool_call_history_cell` for completed `CloseAgent` calls.

*Call graph*: calls 3 internal fn (agent_label, collab_event, title_with_agent); 1 external calls (new).


##### `resume_begin`  (lines 426–438)

```
fn resume_begin(
    receiver_thread_id: ThreadId,
    agent_metadata: &mut impl FnMut(ThreadId) -> AgentMetadata,
) -> PlainHistoryCell
```

**Purpose**: Builds the history cell shown while an agent resume action is in progress.

**Data flow**: It takes the receiver thread ID and metadata lookup closure, creates a `Resuming ...` title with `title_with_agent`, and returns a no-details `collab_event` cell.

**Call relations**: This helper is used by `tool_call_history_cell` for in-progress `ResumeAgent` calls.

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

**Purpose**: Builds the history cell for a completed resume action, including a status or fallback error detail line.

**Data flow**: It takes the receiver thread ID, optional `CollabAgentState`, a fallback error string, and metadata lookup closure. It creates a `Resumed ...` title with `title_with_agent`, computes one detail line with `status_summary_line`, and returns the assembled cell via `collab_event`.

**Call relations**: This helper is called by `tool_call_history_cell` for completed `ResumeAgent` calls after `first_agent_state` selects the relevant status.

*Call graph*: calls 3 internal fn (agent_label, collab_event, title_with_agent); 1 external calls (vec!).


##### `collab_event`  (lines 456–462)

```
fn collab_event(title: Line<'static>, details: Vec<Line<'static>>) -> PlainHistoryCell
```

**Purpose**: Assembles a collaboration history cell from a title line and optional detail lines with tree-style prefixes.

**Data flow**: It takes a title `Line<'static>` and a vector of detail lines. It starts a `Vec<Line<'static>>` with the title, and if details are present it prefixes them using `prefix_lines(details, "  └ ".dim(), "    ".into())`, then constructs and returns `PlainHistoryCell::new(lines)`.

**Call relations**: This is the common cell-construction helper used by all specific event-formatting functions in the module.

*Call graph*: calls 2 internal fn (new, prefix_lines); called by 8 (close_end, interaction_end, resume_begin, resume_end, spawn_end, sub_agent_activity_history_cell, waiting_begin, waiting_end); 1 external calls (vec!).


##### `title_text`  (lines 464–466)

```
fn title_text(title: impl Into<String>) -> Line<'static>
```

**Purpose**: Builds a bold bullet-prefixed title line from plain text.

**Data flow**: It takes any `Into<String>` title, wraps it in a bold `Span`, passes that vector to `title_spans_line`, and returns the resulting line.

**Call relations**: This helper is used when a title does not need agent-specific spans, such as generic waiting or failure messages.

*Call graph*: calls 1 internal fn (title_spans_line); called by 3 (spawn_end, waiting_begin, waiting_end); 1 external calls (vec!).


##### `title_with_agent`  (lines 468–477)

```
fn title_with_agent(
    prefix: &str,
    agent: AgentLabel<'_>,
    spawn_request: Option<&SpawnRequestSummary>,
) -> Line<'static>
```

**Purpose**: Builds a bullet-prefixed title line that includes an action prefix, styled agent label, and optional spawn-request details.

**Data flow**: It takes a prefix string, an `AgentLabel`, and optional `SpawnRequestSummary`. It starts with a bold `"<prefix> "` span, extends with `agent_label_spans(agent)`, then with `spawn_request_spans(spawn_request)`, and converts the result through `title_spans_line`.

**Call relations**: This helper is used by most collaboration event formatters to keep agent-bearing titles consistent.

*Call graph*: calls 3 internal fn (agent_label_spans, spawn_request_spans, title_spans_line); called by 6 (close_end, interaction_end, resume_begin, resume_end, spawn_end, waiting_begin); 1 external calls (vec!).


##### `title_spans_line`  (lines 479–484)

```
fn title_spans_line(mut spans: Vec<Span<'static>>) -> Line<'static>
```

**Purpose**: Prepends the standard dim bullet marker to a title span list and converts it into a `Line`.

**Data flow**: It takes a mutable vector of title spans, allocates a new vector with one extra slot, pushes `"• ".dim()`, appends the provided spans, and returns the resulting `Line<'static>`.

**Call relations**: This is the final common step used by `sub_agent_activity_title`, `title_text`, and `title_with_agent`.

*Call graph*: called by 3 (sub_agent_activity_title, title_text, title_with_agent); 2 external calls (from, with_capacity).


##### `parse_thread_id`  (lines 486–488)

```
fn parse_thread_id(thread_id: &str) -> Option<ThreadId>
```

**Purpose**: Parses a protocol thread ID string into a typed `ThreadId`.

**Data flow**: It takes `&str`, calls `ThreadId::from_string(thread_id).ok()`, and returns `Option<ThreadId>`.

**Call relations**: This helper is used where protocol payloads carry thread IDs as strings, notably in `sub_agent_activity_display`.

*Call graph*: calls 1 internal fn (from_string); called by 1 (sub_agent_activity_display).


##### `agent_label`  (lines 490–496)

```
fn agent_label(thread_id: ThreadId, metadata: &AgentMetadata) -> AgentLabel<'_>
```

**Purpose**: Packages a thread ID and optional metadata references into the internal `AgentLabel` struct used for rendering.

**Data flow**: It takes a `ThreadId` and borrowed `AgentMetadata`, then returns `AgentLabel { thread_id: Some(thread_id), nickname: ..., role: ... }` using `as_deref()` on the optional strings.

**Call relations**: This helper is used by the event-formatting functions before passing labels into `title_with_agent` or `agent_label_line`.

*Call graph*: called by 6 (close_end, interaction_end, resume_begin, resume_end, spawn_end, waiting_begin).


##### `agent_label_line`  (lines 498–500)

```
fn agent_label_line(agent: AgentLabel<'_>) -> Line<'static>
```

**Purpose**: Converts an `AgentLabel` into a standalone rendered line.

**Data flow**: It takes an `AgentLabel`, calls `agent_label_spans(agent)`, and converts the resulting span vector into a `Line<'static>`.

**Call relations**: This helper is used by `waiting_begin` when listing multiple agents in detail lines.

*Call graph*: calls 1 internal fn (agent_label_spans).


##### `agent_label_spans`  (lines 502–524)

```
fn agent_label_spans(agent: AgentLabel<'_>) -> Vec<Span<'static>>
```

**Purpose**: Builds the styled span sequence for an agent label, preferring nickname, then thread ID, then a generic fallback, and optionally appending the role.

**Data flow**: It takes an `AgentLabel`, trims and filters empty nickname/role values, then pushes a cyan bold nickname if present, otherwise a cyan thread ID if present, otherwise cyan `agent`. If a role exists it appends a dim space and an unstyled `[role]` span. It returns the span vector.

**Call relations**: This is the core label-rendering helper used by both `title_with_agent` and `agent_label_line`.

*Call graph*: called by 2 (agent_label_line, title_with_agent); 3 external calls (from, new, format!).


##### `spawn_request_spans`  (lines 526–543)

```
fn spawn_request_spans(spawn_request: Option<&SpawnRequestSummary>) -> Vec<Span<'static>>
```

**Purpose**: Formats optional spawn-request model and reasoning-effort details for inclusion in a title line.

**Data flow**: It takes `Option<&SpawnRequestSummary>`. If absent, or if the trimmed model is empty and reasoning effort equals the default, it returns an empty vector. Otherwise it formats either `(effort)` or `(model effort)`, prefixes it with a dim space span, colors the details magenta, and returns the two-span vector.

**Call relations**: This helper is used only by `title_with_agent` so spawn rows can show the requested model configuration inline.

*Call graph*: called by 1 (title_with_agent); 4 external calls (default, new, format!, vec!).


##### `prompt_line`  (lines 545–555)

```
fn prompt_line(prompt: &str) -> Option<Line<'static>>
```

**Purpose**: Turns a prompt string into an optional truncated detail line for history display.

**Data flow**: It trims the input prompt and returns `None` if empty. Otherwise it truncates the text with `truncate_text(..., COLLAB_PROMPT_PREVIEW_GRAPHEMES)`, wraps it in a `Span` and `Line`, and returns `Some(line)`.

**Call relations**: This helper is used by `spawn_end` and `interaction_end` to attach prompt previews only when meaningful text exists.

*Call graph*: calls 1 internal fn (truncate_text); called by 2 (interaction_end, spawn_end); 2 external calls (from, from).


##### `wait_complete_lines`  (lines 557–597)

```
fn wait_complete_lines(
    receiver_thread_ids: &[String],
    agents_states: &std::collections::HashMap<String, CollabAgentState>,
    agent_metadata: &mut impl FnMut(ThreadId) -> AgentMetadata,
) -
```

**Purpose**: Builds the per-agent status detail lines shown after a wait operation completes.

**Data flow**: Inputs are receiver thread ID strings, the `agents_states` map, and a metadata lookup closure. It parses receiver IDs, looks up matching states, tracks seen IDs in a `HashSet`, then collects extra states not listed among receivers, sorts those extras by thread ID string, and appends them. If no entries remain it returns a single `No agents completed yet` line; otherwise it renders each entry as `agent_label: status_summary_spans(status)`.

**Call relations**: This helper is called by `waiting_end` and encapsulates the deduplication, ordering, and status formatting for completed waits.

*Call graph*: called by 1 (waiting_end); 2 external calls (new, vec!).


##### `first_agent_state`  (lines 599–612)

```
fn first_agent_state(
    receiver_thread_ids: &[String],
    agents_states: &'a std::collections::HashMap<String, CollabAgentState>,
) -> Option<&'a CollabAgentState>
```

**Purpose**: Selects the most relevant agent state for single-target resume completion, preferring receiver order and falling back to the lexicographically smallest available state entry.

**Data flow**: It takes receiver thread ID strings and the `agents_states` map. It first searches receiver IDs in order for a matching state; if none match, it picks the minimum map key and returns that state reference. The result is `Option<&CollabAgentState>`.

**Call relations**: This helper is used by `tool_call_history_cell` before calling `resume_end`.


##### `status_summary_line`  (lines 614–619)

```
fn status_summary_line(status: Option<&CollabAgentState>, fallback_error: &str) -> Line<'static>
```

**Purpose**: Converts an optional agent state into a rendered status line, using a fallback error when no state is available.

**Data flow**: It takes `Option<&CollabAgentState>` and a fallback error string. If a state exists it converts `status_summary_spans(status)` into a line; otherwise it converts `error_summary_spans(fallback_error)` into a line.

**Call relations**: This helper is used by `resume_end` to produce its single detail line.

*Call graph*: calls 2 internal fn (error_summary_spans, status_summary_spans).


##### `status_summary_spans`  (lines 621–648)

```
fn status_summary_spans(status: &CollabAgentState) -> Vec<Span<'static>>
```

**Purpose**: Formats a `CollabAgentState` into styled status spans, including truncated message previews for completed and errored states.

**Data flow**: It matches `status.status`: pending init becomes cyan `Pending init`, running becomes cyan bold `Running`, interrupted becomes yellow `Interrupted`, completed becomes green `Completed` plus an optional dim separator and truncated normalized message preview, errored delegates to `error_summary_spans`, shutdown becomes plain `Shutdown`, and not found becomes red `Not found`. It returns a span vector.

**Call relations**: This helper is used by `status_summary_line` and indirectly by wait-completion rendering to keep status formatting consistent.

*Call graph*: calls 2 internal fn (error_summary_spans, truncate_text); called by 1 (status_summary_line); 2 external calls (from, vec!).


##### `error_summary_spans`  (lines 650–661)

```
fn error_summary_spans(error: &str) -> Vec<Span<'static>>
```

**Purpose**: Formats an error label and optional truncated error preview into styled spans.

**Data flow**: It takes an error string, starts with red `Error`, normalizes whitespace and truncates the message with `truncate_text(..., COLLAB_AGENT_ERROR_PREVIEW_GRAPHEMES)`, and if non-empty appends a dim separator plus the preview. It returns the span vector.

**Call relations**: This helper is used directly by `status_summary_line` and by `status_summary_spans` for errored agent states.

*Call graph*: calls 1 internal fn (truncate_text); called by 2 (status_summary_line, status_summary_spans); 2 external calls (from, vec!).


##### `tests::collab_events_snapshot`  (lines 678–795)

```
fn collab_events_snapshot()
```

**Purpose**: Builds a representative sequence of collaboration tool-call cells and snapshots their rendered text.

**Data flow**: The test constructs several `ThreadItem::CollabAgentToolCall` values for spawn, send-input, wait begin, wait end, and close; renders each through `tool_call_history_cell`; converts the resulting cells to plain text with local helpers; joins them; and snapshots the transcript.

**Call relations**: It exercises the main dispatcher and most event-formatting helpers across realistic multi-agent scenarios.

*Call graph*: calls 2 internal fn (from_string, tool_call_history_cell); 5 external calls (from, new, assert_snapshot!, agent_state, vec!).


##### `tests::agent_shortcut_matches_option_arrow_word_motion_fallbacks_only_when_allowed`  (lines 799–824)

```
fn agent_shortcut_matches_option_arrow_word_motion_fallbacks_only_when_allowed()
```

**Purpose**: On macOS, verifies that canonical Alt-arrow shortcuts always match and Option-b/f fallbacks only match when explicitly allowed.

**Data flow**: The test creates several `KeyEvent`s and asserts the boolean results of `previous_agent_shortcut_matches` and `next_agent_shortcut_matches` under both allowed and disallowed fallback settings.

**Call relations**: It covers the platform-specific fallback logic behind the shortcut-matching helpers.

*Call graph*: 1 external calls (assert!).


##### `tests::agent_shortcut_matches_option_arrows_only`  (lines 828–845)

```
fn agent_shortcut_matches_option_arrows_only()
```

**Purpose**: On non-macOS platforms, verifies that only Alt-arrow shortcuts match and Alt-b/f do not.

**Data flow**: The test constructs Alt-left, Alt-right, Alt-b, and Alt-f events and asserts the expected results from the shortcut-matching helpers.

**Call relations**: It validates the non-macOS stub implementations of the word-motion fallback helpers.

*Call graph*: 1 external calls (assert!).


##### `tests::title_styles_nickname_and_role`  (lines 848–883)

```
fn title_styles_nickname_and_role()
```

**Purpose**: Checks that rendered title spans apply the expected styling to agent nickname, role, and spawn-request details.

**Data flow**: The test renders a spawn tool-call cell through `tool_call_history_cell`, inspects the first display line's spans, and asserts exact content and style properties such as cyan bold nickname, plain role text, and magenta model/effort details.

**Call relations**: It exercises `title_with_agent`, `agent_label_spans`, and `spawn_request_spans` through the main history-cell path.

*Call graph*: calls 2 internal fn (from_string, tool_call_history_cell); 6 external calls (from, new, assert!, assert_eq!, agent_state, vec!).


##### `tests::collab_resume_interrupted_snapshot`  (lines 886–913)

```
fn collab_resume_interrupted_snapshot()
```

**Purpose**: Snapshots the rendered output for a completed resume action whose resulting agent state is interrupted.

**Data flow**: The test constructs a resume `ThreadItem`, renders it with `tool_call_history_cell`, converts the cell to text, and snapshots the result.

**Call relations**: It specifically covers the `ResumeAgent` completed path and interrupted-status formatting.

*Call graph*: calls 2 internal fn (from_string, tool_call_history_cell); 4 external calls (from, assert_snapshot!, agent_state, vec!).


##### `tests::agent_state`  (lines 915–920)

```
fn agent_state(status: CollabAgentStatus, message: Option<&str>) -> CollabAgentState
```

**Purpose**: Creates a `CollabAgentState` test fixture from a status and optional message.

**Data flow**: It takes a `CollabAgentStatus` and optional `&str`, converts the message to `Option<String>`, and returns the populated `CollabAgentState`.

**Call relations**: This helper is used by the collaboration rendering tests to build concise fixture data.


##### `tests::metadata_for`  (lines 922–936)

```
fn metadata_for(thread_id: ThreadId, robie_id: ThreadId, bob_id: ThreadId) -> AgentMetadata
```

**Purpose**: Returns deterministic test metadata for known thread IDs and default metadata for others.

**Data flow**: It compares the input `thread_id` against two fixture IDs and returns `AgentMetadata` with nickname/role for Robie or Bob, otherwise `AgentMetadata::default()`.

**Call relations**: This helper is passed as the metadata lookup closure in tests that render collaboration history cells.

*Call graph*: 1 external calls (default).


##### `tests::cell_to_text`  (lines 938–944)

```
fn cell_to_text(cell: &PlainHistoryCell) -> String
```

**Purpose**: Converts a `PlainHistoryCell` into newline-joined plain text for snapshot assertions.

**Data flow**: It calls `cell.display_lines(200)`, maps each line through `line_to_text`, collects the strings, joins them with newlines, and returns the result.

**Call relations**: This helper is used by snapshot tests to compare rendered collaboration cells without style metadata.

*Call graph*: calls 1 internal fn (display_lines).


##### `tests::line_to_text`  (lines 946–952)

```
fn line_to_text(line: &Line<'static>) -> String
```

**Purpose**: Flattens a styled `Line<'static>` into its concatenated textual content.

**Data flow**: It iterates the line's spans, extracts each span's `content`, collects them into a vector, joins them, and returns the resulting string.

**Call relations**: This helper supports `cell_to_text` in the collaboration rendering tests.


### `tui/src/pager_overlay.rs`

`domain_logic` · `overlay display and transcript browsing`

This module provides two overlay types behind a common `Overlay` enum: `TranscriptOverlay` for transcript history plus optional live in-flight output, and `StaticOverlay` for arbitrary static lines or renderables. Both are built on `PagerView`, which owns a list of `Renderable` chunks, scroll state, title, pager keymap, cached content-height metadata, and an optional pending chunk to scroll into view after wrapping is known. `PagerView::render` draws a dim slash-style header, computes the content area, clamps scroll offset, renders only visible chunks (including partial top chunks via `render_offset_content`), fills unused rows with `~`, and draws a bottom bar with scroll percentage.

Transcript rendering wraps each `HistoryCell` in `CellRenderable`, preserving semantic hyperlinks by rendering `HyperlinkLine`s and then calling `mark_buffer_hyperlinks`. User cells receive `user_message_style`, optionally reversed when highlighted. To avoid repeated height recomputation, chunks are wrapped in `CachedRenderable`. `TranscriptOverlay` maintains committed cells separately from the optional live tail; the tail is represented as one extra renderable appended after committed cells and is rebuilt only when a `LiveTailKey` changes. That key includes width, active-cell revision, stream-continuation spacing, and optional animation tick, so Ctrl+T can stay synchronized with in-place streaming updates without recomputing on every draw. Insert, replace, and consolidate operations preserve bottom-follow behavior and remap highlighted cell indices carefully. Footer hints are rendered from the pager keymap and change when a cell is highlighted to advertise edit navigation.

#### Function details

##### `Overlay::new_transcript`  (lines 59–61)

```
fn new_transcript(cells: Vec<Arc<dyn HistoryCell>>, keymap: PagerKeymap) -> Self
```

**Purpose**: Constructs an `Overlay::Transcript` from committed history cells and a pager keymap. It is the enum-level constructor for transcript overlays.

**Data flow**: Takes a `Vec<Arc<dyn HistoryCell>>` and `PagerKeymap`, creates `TranscriptOverlay::new(cells, keymap)`, wraps it in `Overlay::Transcript`, and returns it. It does not mutate external state.

**Call relations**: Called by higher-level app code when opening transcript overlays. It delegates all transcript-specific setup to `TranscriptOverlay::new`.

*Call graph*: calls 1 internal fn (new); called by 5 (handle_key_event, clear_only_ui_reset_preserves_chat_session_state, queued_rollback_syncs_overlay_and_clears_deferred_history, open_transcript_overlay, open_pending_transcript_if_ready); 1 external calls (Transcript).


##### `Overlay::new_static_with_lines`  (lines 63–69)

```
fn new_static_with_lines(
        lines: Vec<Line<'static>>,
        title: String,
        keymap: PagerKeymap,
    ) -> Self
```

**Purpose**: Constructs an `Overlay::Static` from plain lines and a title. It is the convenience constructor for simple static pager content.

**Data flow**: Accepts `Vec<Line<'static>>`, a title string, and a keymap, creates `StaticOverlay::with_title`, wraps it in `Overlay::Static`, and returns it. It has no side effects.

**Call relations**: Used by callers that want a pager overlay without building custom renderables.

*Call graph*: calls 1 internal fn (with_title); called by 1 (handle_event); 1 external calls (Static).


##### `Overlay::new_static_with_renderables`  (lines 71–77)

```
fn new_static_with_renderables(
        renderables: Vec<Box<dyn Renderable>>,
        title: String,
        keymap: PagerKeymap,
    ) -> Self
```

**Purpose**: Constructs an `Overlay::Static` from arbitrary renderables and a title. It is the flexible constructor for static overlays.

**Data flow**: Takes a vector of boxed renderables, title, and keymap, creates `StaticOverlay::with_renderables`, wraps it in `Overlay::Static`, and returns it. It writes no state.

**Call relations**: Used by callers that already have custom renderable chunks to page through.

*Call graph*: calls 1 internal fn (with_renderables); called by 1 (handle_event); 1 external calls (Static).


##### `Overlay::handle_event`  (lines 79–84)

```
fn handle_event(&mut self, tui: &mut tui::Tui, event: TuiEvent) -> Result<()>
```

**Purpose**: Dispatches an overlay event to the concrete transcript or static overlay implementation. It is the enum-level event adapter.

**Data flow**: Matches `self` and forwards the mutable `Tui` and `TuiEvent` to the contained overlay's `handle_event`, returning that `Result<()>`. It mutates only the delegated overlay.

**Call relations**: Called by higher-level app code while an overlay is active.


##### `Overlay::is_done`  (lines 86–91)

```
fn is_done(&self) -> bool
```

**Purpose**: Reports whether the active overlay has been closed. It hides the distinction between transcript and static overlays.

**Data flow**: Matches `self` and returns the contained overlay's `is_done()` boolean. It has no side effects.

**Call relations**: Used by overlay-driving code to know when to dismiss the alternate-screen view.


##### `first_or_empty`  (lines 94–96)

```
fn first_or_empty(bindings: &[KeyBinding]) -> Vec<KeyBinding>
```

**Purpose**: Returns a one-element vector containing the first key binding from a slice, or an empty vector if the slice is empty. It simplifies footer-hint assembly.

**Data flow**: Reads `bindings.first()`, copies it if present, converts the optional item into an iterator, collects into `Vec<KeyBinding>`, and returns it. It writes no state.

**Call relations**: Used by both transcript and static footer-hint renderers to show only the primary binding for each action.

*Call graph*: called by 2 (render_hints, render_hints); 1 external calls (first).


##### `render_key_hints`  (lines 99–117)

```
fn render_key_hints(area: Rect, buf: &mut Buffer, pairs: &[(Vec<KeyBinding>, &str)])
```

**Purpose**: Renders one dim footer line of key hints from `(keys, description)` pairs. It formats multiple keys with `/` separators and spaces between hint groups.

**Data flow**: Builds a `Vec<Span>` starting with a leading space, appends each key binding and description pair with separators, wraps the spans in a single `Line`, and renders a dim `Paragraph` into the provided buffer area. It writes only to the render buffer.

**Call relations**: Called by `TranscriptOverlay::render_hints` and `StaticOverlay::render_hints` to draw their two-line footer help.

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

**Purpose**: Constructs the shared pager state for an overlay, including renderables, title, initial scroll offset, and keymap. It initializes all cached layout metadata as unknown.

**Data flow**: Stores the provided renderables, title, scroll offset, and keymap, and initializes `last_content_height`, `last_rendered_height`, and `pending_scroll_chunk` to `None`. It returns the new `PagerView`.

**Call relations**: Used by both overlay types and by tests that exercise pager behavior directly.

*Call graph*: called by 3 (with_renderables, new, pager_view).


##### `PagerView::content_height`  (lines 149–154)

```
fn content_height(&self, width: u16) -> usize
```

**Purpose**: Computes the total wrapped content height of all renderable chunks at a given width. This is the basis for scroll clamping and percentage display.

**Data flow**: Iterates `self.renderables`, calls each chunk's `desired_height(width)`, sums the results as `usize`, and returns the total. It does not mutate state.

**Call relations**: Called during `PagerView::render` after the content area width is known.

*Call graph*: called by 1 (render).


##### `PagerView::render`  (lines 156–175)

```
fn render(&mut self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Renders the full pager view: clear, header, scrollable content, and bottom bar. It also updates cached layout metadata and satisfies any pending scroll-to-chunk request once wrapping is known.

**Data flow**: Clears the area, renders the header, computes the content area, stores its height via `update_last_content_height`, computes total content height, stores it in `last_rendered_height`, optionally calls `ensure_chunk_visible` for `pending_scroll_chunk`, clamps `scroll_offset` against the maximum scrollable range, renders visible content, and finally renders the bottom bar. It writes to the buffer and mutates pager scroll/cache fields.

**Call relations**: Called by both `TranscriptOverlay::render` and `StaticOverlay::render`. It is the core rendering engine shared by all pager overlays.

*Call graph*: calls 7 internal fn (content_area, content_height, ensure_chunk_visible, render_bottom_bar, render_content, render_header, update_last_content_height); called by 2 (render, render).


##### `PagerView::render_header`  (lines 177–183)

```
fn render_header(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Draws the dim slash-style header line containing the pager title. It gives overlays a consistent visual chrome.

**Data flow**: Renders a repeated `/ ` pattern dimmed across the width, then formats `/ {title}` and renders it dimmed over the same area. It writes only to the buffer.

**Call relations**: Called internally by `PagerView::render` before content rendering.

*Call graph*: called by 1 (render); 2 external calls (from, format!).


##### `PagerView::render_content`  (lines 185–219)

```
fn render_content(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Draws the visible portion of the scrollable renderable chunks and fills any remaining rows with `~` markers. It supports partially visible top chunks by rendering into a temporary buffer and copying from an offset.

**Data flow**: Uses `scroll_offset` to track a virtual y-position across `self.renderables`, skips chunks entirely above the viewport, stops after chunks entirely below it, renders partially clipped top chunks via `render_offset_content`, renders fully visible chunks directly, tracks the lowest drawn row, and fills the rest of the content area with a leading `~` and spaces. It writes to the buffer but does not change pager state.

**Call relations**: Called by `PagerView::render` after scroll clamping. It delegates partial-chunk rendering to `render_offset_content`.

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

**Purpose**: Draws the separator line below content and the current scroll percentage. The percentage is based on the current offset relative to the maximum scroll range.

**Data flow**: Computes the separator row from `content_area.bottom()`, renders a dim horizontal rule, calculates percentage as 100 for empty or fully fitting content or as rounded offset/max-scroll otherwise, formats ` {percent}% `, and renders it near the right edge. It writes only to the buffer.

**Call relations**: Called by `PagerView::render` after content rendering.

*Call graph*: called by 1 (render); 4 external calls (bottom, new, from, format!).


##### `PagerView::handle_key_event`  (lines 253–292)

```
fn handle_key_event(&mut self, tui: &mut tui::Tui, key_event: KeyEvent) -> Result<()>
```

**Purpose**: Processes pager navigation keys for line scrolling, page scrolling, half-page scrolling, and jumps to top or bottom. It updates scroll offset and schedules a redraw when a recognized key is handled.

**Data flow**: Matches the incoming `KeyEvent` against the configured pager keymap, mutates `scroll_offset` accordingly using `page_height` or `content_area` where needed, and schedules a frame on the provided `Tui`'s frame requester when a navigation action occurs. It returns `Ok(())` whether or not a key matched.

**Call relations**: Called by both `TranscriptOverlay::handle_event` and `StaticOverlay::handle_event` for non-close key events. It is the shared input engine for pager navigation.

*Call graph*: calls 2 internal fn (content_area, page_height); called by 2 (handle_event, handle_event); 1 external calls (frame_requester).


##### `PagerView::page_height`  (lines 299–302)

```
fn page_height(&self, viewport_area: Rect) -> usize
```

**Purpose**: Returns the effective content-page height used for page-up/page-down operations. It prefers the last rendered content height so paging matches the actual chrome-adjusted viewport.

**Data flow**: Reads `last_content_height` and returns it if present; otherwise computes `self.content_area(viewport_area).height as usize`. It does not mutate state.

**Call relations**: Used by `PagerView::handle_key_event` for page-up and page-down calculations.

*Call graph*: called by 1 (handle_key_event).


##### `PagerView::update_last_content_height`  (lines 304–306)

```
fn update_last_content_height(&mut self, height: u16)
```

**Purpose**: Stores the most recently rendered content-area height. This cached value is later used for paging and bottom-follow calculations.

**Data flow**: Writes `Some(height as usize)` into `last_content_height`. It returns nothing.

**Call relations**: Called from `PagerView::render` once the content area has been computed.

*Call graph*: called by 1 (render).


##### `PagerView::content_area`  (lines 308–313)

```
fn content_area(&self, area: Rect) -> Rect
```

**Purpose**: Computes the inner scrollable area by removing one row for the header and one row for the bottom bar separator/footer chrome. It standardizes pager layout geometry.

**Data flow**: Takes a `Rect`, increments `y` by 1, subtracts 2 from `height` with saturation, and returns the adjusted rectangle. It does not mutate pager state.

**Call relations**: Used by rendering and key handling whenever pager logic needs the actual scrollable viewport.

*Call graph*: called by 2 (handle_key_event, render).


##### `PagerView::is_scrolled_to_bottom`  (lines 317–335)

```
fn is_scrolled_to_bottom(&self) -> bool
```

**Purpose**: Reports whether the pager is effectively pinned to the bottom, accounting for the special `usize::MAX` sentinel and wrapped content height. This supports follow-along behavior for transcript updates.

**Data flow**: Reads `scroll_offset`, `last_content_height`, `last_rendered_height`, and `renderables`, returning true for the explicit bottom sentinel, empty content, or content that fully fits, and otherwise comparing `scroll_offset` against the computed maximum scroll. It writes no state.

**Call relations**: Used by transcript overlay mutation methods to preserve bottom-follow behavior when cells or live tail content change.

*Call graph*: called by 5 (consolidate_cells, insert_cell, is_scrolled_to_bottom, replace_cells, sync_live_tail).


##### `PagerView::scroll_chunk_into_view`  (lines 338–340)

```
fn scroll_chunk_into_view(&mut self, chunk_index: usize)
```

**Purpose**: Requests that a specific renderable chunk be made visible on the next render pass. It defers the actual scroll calculation until wrapping width is known.

**Data flow**: Writes `Some(chunk_index)` into `pending_scroll_chunk`. It returns `()`.

**Call relations**: Called by `TranscriptOverlay::set_highlight_cell` so the highlighted transcript cell becomes visible after render-time wrapping is computed.

*Call graph*: called by 1 (set_highlight_cell).


##### `PagerView::ensure_chunk_visible`  (lines 342–360)

```
fn ensure_chunk_visible(&mut self, idx: usize, area: Rect)
```

**Purpose**: Adjusts `scroll_offset` so the specified renderable chunk is fully visible within the current content area if possible. It scrolls upward or downward only when needed.

**Data flow**: Given a chunk index and content area, it computes the chunk's start and end rows by summing `desired_height(area.width)` across preceding renderables, compares those bounds to the current visible top and bottom derived from `scroll_offset`, and mutates `scroll_offset` to bring the chunk into view. It returns nothing.

**Call relations**: Called from `PagerView::render` when a pending scroll-to-chunk request exists.

*Call graph*: called by 1 (render).


##### `CachedRenderable::new`  (lines 371–377)

```
fn new(renderable: impl Into<Box<dyn Renderable>>) -> Self
```

**Purpose**: Wraps another renderable with width-sensitive desired-height caching. This avoids recomputing wrapped heights on every draw when width is unchanged.

**Data flow**: Consumes any value convertible into `Box<dyn Renderable>`, stores it, and initializes cached `height` and `last_width` cells to `None`. It returns the wrapper.

**Call relations**: Used when building transcript cell renderables and live-tail renderables so repeated pager layout passes are cheaper.

*Call graph*: called by 1 (live_tail_renderable); 2 external calls (into, new).


##### `CachedRenderable::render`  (lines 381–383)

```
fn render(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Forwards rendering to the wrapped renderable without altering the cache. It preserves the original drawing behavior.

**Data flow**: Calls `self.renderable.render(area, buf)` with the provided area and buffer. It writes only through the wrapped renderable.

**Call relations**: Invoked by pager rendering whenever a cached renderable is visible.


##### `CachedRenderable::desired_height`  (lines 384–391)

```
fn desired_height(&self, width: u16) -> u16
```

**Purpose**: Returns the wrapped renderable's desired height, recomputing only when the width changes. It is the caching logic behind `CachedRenderable`.

**Data flow**: Reads `last_width`; if it differs from the requested width, it calls the wrapped renderable's `desired_height(width)`, stores the result in `height`, updates `last_width`, and then returns the cached height or zero. It mutates the cache cells.

**Call relations**: Used by pager layout code through the `Renderable` trait whenever chunk heights are needed.


##### `CellRenderable::render`  (lines 400–407)

```
fn render(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Renders one committed transcript history cell while preserving semantic hyperlinks. It converts the cell's hyperlink-aware transcript lines into visible text and then marks the corresponding buffer cells.

**Data flow**: Calls `self.cell.transcript_hyperlink_lines(area.width)`, converts those lines to visible `Line`s with `visible_lines`, renders them in a styled wrapped `Paragraph`, and then calls `mark_buffer_hyperlinks` over the same area with zero scroll rows. It writes to the buffer but does not mutate the cell.

**Call relations**: Used inside transcript overlays for each committed `HistoryCell`, typically wrapped in `CachedRenderable` and sometimes `InsetRenderable`.

*Call graph*: calls 2 internal fn (mark_buffer_hyperlinks, visible_lines); 2 external calls (new, from).


##### `CellRenderable::desired_height`  (lines 409–411)

```
fn desired_height(&self, width: u16) -> u16
```

**Purpose**: Returns the wrapped transcript cell's desired transcript height at the given width. It delegates height calculation to the cell itself.

**Data flow**: Calls `self.cell.desired_transcript_height(width)` and returns the result. It has no side effects.

**Call relations**: Used by pager layout through the `Renderable` trait for committed transcript cells.


##### `HyperlinkLinesRenderable::render`  (lines 419–424)

```
fn render(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Renders a precomputed set of hyperlink-aware lines, preserving semantic links in the buffer. It is used for the transcript overlay's live tail.

**Data flow**: Converts `self.lines.clone()` to visible lines with `visible_lines`, renders them in a wrapped `Paragraph`, and then calls `mark_buffer_hyperlinks` over the same area. It writes to the buffer but does not mutate the stored lines.

**Call relations**: Constructed by `TranscriptOverlay::live_tail_renderable` for the optional in-flight active-cell tail.

*Call graph*: calls 2 internal fn (mark_buffer_hyperlinks, visible_lines); 2 external calls (new, from).


##### `HyperlinkLinesRenderable::desired_height`  (lines 426–432)

```
fn desired_height(&self, width: u16) -> u16
```

**Purpose**: Computes the wrapped height of the stored hyperlink lines at a given width. It mirrors the rendering path's wrapping behavior.

**Data flow**: Builds a wrapped `Paragraph` from `visible_lines(self.lines.clone())`, calls `line_count(width)`, converts the result to `u16`, and returns zero on conversion failure. It does not mutate state.

**Call relations**: Used by pager layout for live-tail chunks.

*Call graph*: calls 1 internal fn (visible_lines); 2 external calls (new, from).


##### `TranscriptOverlay::new`  (lines 469–482)

```
fn new(transcript_cells: Vec<Arc<dyn HistoryCell>>, keymap: PagerKeymap) -> Self
```

**Purpose**: Constructs a transcript overlay from committed transcript cells and a pager keymap, initially scrolled to the bottom. It starts with no highlighted cell and no live tail.

**Data flow**: Builds initial renderables from `render_cells(&transcript_cells, None)`, creates a `PagerView` titled `T R A N S C R I P T` with `scroll_offset = usize::MAX`, stores the committed cells, sets `highlight_cell` and `live_tail_key` to `None`, and `is_done` to false. It returns the overlay.

**Call relations**: Called by `Overlay::new_transcript` and transcript-overlay tests. It delegates chunk construction to `render_cells`.

*Call graph*: calls 1 internal fn (new); called by 2 (new_transcript, transcript_overlay); 1 external calls (render_cells).


##### `TranscriptOverlay::render_cells`  (lines 484–520)

```
fn render_cells(
        cells: &[Arc<dyn HistoryCell>],
        highlight_cell: Option<usize>,
    ) -> Vec<Box<dyn Renderable>>
```

**Purpose**: Converts committed history cells into pager renderables with appropriate styling and spacing. User cells get user-message styling, highlighted user cells are reversed, and non-continuation cells after the first receive a top inset.

**Data flow**: Iterates the input cells with indices, creates a `CellRenderable` for each, wraps it in `CachedRenderable`, conditionally wraps that in `InsetRenderable` when the cell is not a stream continuation and is not the first cell, and collects the boxed renderables into a vector. It returns the vector without mutating overlay state.

**Call relations**: Used during overlay construction and whenever committed cells are rebuilt after insert/replace/consolidate/highlight changes.


##### `TranscriptOverlay::insert_cell`  (lines 532–560)

```
fn insert_cell(&mut self, cell: Arc<dyn HistoryCell>)
```

**Purpose**: Appends one committed transcript cell while preserving any cached live tail and maintaining bottom-follow behavior when appropriate. It also fixes live-tail spacing if the first committed cell arrives after a tail-only state.

**Data flow**: Checks whether the pager was scrolled to bottom, records whether there were prior committed cells, removes any live-tail renderable via `take_live_tail_renderable`, pushes the new cell into `self.cells`, rebuilds committed renderables with `render_cells`, conditionally rewraps the tail in a top inset if it now follows the first committed cell and is not a stream continuation, reattaches the tail, and restores `scroll_offset = usize::MAX` if bottom-follow was active.

**Call relations**: Called by higher-level app code when a new committed history cell arrives while the transcript overlay is open. It relies on `take_live_tail_renderable` and `render_cells` to preserve the committed/live-tail invariant.

*Call graph*: calls 4 internal fn (is_scrolled_to_bottom, take_live_tail_renderable, tlbr, new); 2 external calls (new, render_cells).


##### `TranscriptOverlay::replace_cells`  (lines 567–580)

```
fn replace_cells(&mut self, cells: Vec<Arc<dyn HistoryCell>>)
```

**Purpose**: Replaces the committed transcript cell list wholesale while preserving any cached live tail and bottom-follow behavior. It is used when transcript history is trimmed or rewritten.

**Data flow**: Checks bottom-follow state, overwrites `self.cells`, clears `highlight_cell` if it now points past the end, rebuilds renderables via `rebuild_renderables`, and restores bottom-follow by setting `scroll_offset = usize::MAX` when needed. It returns `()`.

**Call relations**: Called by higher-level synchronization logic when the overlay's committed transcript must be replaced to match the main transcript.

*Call graph*: calls 2 internal fn (is_scrolled_to_bottom, rebuild_renderables).


##### `TranscriptOverlay::consolidate_cells`  (lines 589–623)

```
fn consolidate_cells(
        &mut self,
        range: std::ops::Range<usize>,
        consolidated: Arc<dyn HistoryCell>,
    )
```

**Purpose**: Replaces a range of committed cells with one consolidated cell while remapping any highlighted cell index and preserving bottom-follow behavior. It mirrors transcript consolidation performed elsewhere in the app.

**Data flow**: Checks bottom-follow state, clamps the requested range to the current cell count, adjusts `highlight_cell` if it falls inside or after the removed range, splices `self.cells` to replace the clamped range with `consolidated`, clears highlight if it now points past the end, rebuilds renderables, and restores bottom-follow if previously active.

**Call relations**: Called by higher-level app logic when agent messages are consolidated. It depends on `rebuild_renderables` to preserve any live tail while updating committed chunks.

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

**Purpose**: Synchronizes the optional render-only live tail with the current active-cell transcript state, recomputing it only when a cache key changes. This keeps Ctrl+T overlays in sync with in-flight output without unnecessary work.

**Data flow**: Builds an optional `LiveTailKey` from `width` and `active_key`; if it matches `self.live_tail_key`, returns immediately. Otherwise it records whether the pager was at bottom, removes any existing tail via `take_live_tail_renderable`, stores the new key, calls `compute_lines(width)` when a key exists, and if non-empty lines are returned pushes a new tail renderable from `live_tail_renderable(lines, !self.cells.is_empty(), key.is_stream_continuation)`. If bottom-follow was active, it resets `scroll_offset = usize::MAX`.

**Call relations**: Called by the app draw loop while a transcript overlay is open. It relies on callers to provide an `ActiveCellTranscriptKey` that changes when active-cell transcript output changes or animates.

*Call graph*: calls 2 internal fn (is_scrolled_to_bottom, take_live_tail_renderable); 1 external calls (live_tail_renderable).


##### `TranscriptOverlay::set_highlight_cell`  (lines 673–679)

```
fn set_highlight_cell(&mut self, cell: Option<usize>)
```

**Purpose**: Sets which committed transcript cell is highlighted and requests that it be scrolled into view. Highlighting affects styling and footer hints.

**Data flow**: Writes `highlight_cell`, rebuilds renderables via `rebuild_renderables`, and if a highlight index is present stores it in the pager via `scroll_chunk_into_view`. It returns `()`.

**Call relations**: Called by higher-level transcript-edit navigation logic. It ties together visual highlighting and deferred scroll positioning.

*Call graph*: calls 2 internal fn (scroll_chunk_into_view, rebuild_renderables).


##### `TranscriptOverlay::is_scrolled_to_bottom`  (lines 685–687)

```
fn is_scrolled_to_bottom(&self) -> bool
```

**Purpose**: Exposes whether the transcript overlay's pager is currently pinned to the bottom. This is used by the app to decide whether live-tail animations are worth driving.

**Data flow**: Delegates directly to `self.view.is_scrolled_to_bottom()` and returns the boolean. It has no side effects.

**Call relations**: Queried by external app code during draw scheduling and transcript synchronization.

*Call graph*: calls 1 internal fn (is_scrolled_to_bottom).


##### `TranscriptOverlay::rebuild_renderables`  (lines 689–695)

```
fn rebuild_renderables(&mut self)
```

**Purpose**: Rebuilds committed transcript renderables while preserving any existing live-tail renderable at the end. It maintains the invariant that committed chunks come first and the optional tail comes last.

**Data flow**: Removes any tail via `take_live_tail_renderable`, rebuilds committed chunks from `self.cells` and `highlight_cell` using `render_cells`, then reattaches the tail if one existed. It mutates `self.view.renderables`.

**Call relations**: Used internally by replace, consolidate, and highlight changes whenever committed-cell presentation must be regenerated.

*Call graph*: calls 1 internal fn (take_live_tail_renderable); called by 3 (consolidate_cells, replace_cells, set_highlight_cell); 1 external calls (render_cells).


##### `TranscriptOverlay::take_live_tail_renderable`  (lines 702–704)

```
fn take_live_tail_renderable(&mut self) -> Option<Box<dyn Renderable>>
```

**Purpose**: Removes and returns the optional live-tail renderable if one is currently appended after the committed cells. It relies on the invariant that the tail, when present, is the final renderable.

**Data flow**: Compares `self.view.renderables.len()` against `self.cells.len()` and pops the last renderable only when there are more renderables than committed cells. It returns `Option<Box<dyn Renderable>>` and mutates the renderables vector when a tail exists.

**Call relations**: Used by insert, rebuild, and live-tail sync operations to temporarily detach the tail while committed chunks are rebuilt.

*Call graph*: called by 3 (insert_cell, rebuild_renderables, sync_live_tail).


##### `TranscriptOverlay::live_tail_renderable`  (lines 706–722)

```
fn live_tail_renderable(
        lines: Vec<HyperlinkLine>,
        has_prior_cells: bool,
        is_stream_continuation: bool,
    ) -> Box<dyn Renderable>
```

**Purpose**: Builds the boxed renderable used for the optional live tail, adding top spacing when it follows prior committed cells and is not a stream continuation. It encapsulates the tail-spacing rule.

**Data flow**: Wraps `HyperlinkLinesRenderable { lines }` in `CachedRenderable`, then conditionally wraps that in `InsetRenderable` with a one-row top inset when `has_prior_cells && !is_stream_continuation`. It returns the boxed renderable.

**Call relations**: Called by `sync_live_tail` when a non-empty active-cell tail should be displayed.

*Call graph*: calls 3 internal fn (new, tlbr, new); 1 external calls (new).


##### `TranscriptOverlay::render_hints`  (lines 724–771)

```
fn render_hints(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Renders the transcript overlay's two-line footer hints, including scroll/page/jump controls and edit-navigation hints that depend on whether a cell is highlighted. It adapts the footer to transcript-specific interactions.

**Data flow**: Splits the footer area into two one-line rectangles, builds key-hint pairs from the pager keymap using `first_or_empty`, conditionally adds edit-prev/edit-next/edit-message hints based on `highlight_cell`, and renders both lines via `render_key_hints`. It writes only to the buffer.

**Call relations**: Called by `TranscriptOverlay::render` after the pager view itself has been drawn.

*Call graph*: calls 2 internal fn (first_or_empty, render_key_hints); called by 1 (render); 2 external calls (new, vec!).


##### `TranscriptOverlay::render`  (lines 773–779)

```
fn render(&mut self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Renders the transcript overlay by splitting the area into pager content and footer hints. It is the top-level drawing method for transcript overlays.

**Data flow**: Computes a top area of `height - 3` rows and a bottom 3-row footer area, calls `self.view.render(top, buf)`, then `self.render_hints(bottom, buf)`. It writes to the buffer and may mutate pager layout caches during the delegated render.

**Call relations**: Called from `TranscriptOverlay::handle_event` on draw/resize and directly by tests.

*Call graph*: calls 2 internal fn (render, render_hints); called by 1 (transcript_line_numbers); 1 external calls (new).


##### `TranscriptOverlay::handle_event`  (lines 783–802)

```
fn handle_event(&mut self, tui: &mut tui::Tui, event: TuiEvent) -> Result<()>
```

**Purpose**: Processes overlay events for transcript overlays: close keys, pager navigation keys, and redraw events. It is the event-loop entry point for transcript overlays.

**Data flow**: Matches the incoming `TuiEvent`; on key events it closes the overlay if either close binding matches, otherwise delegates to `self.view.handle_key_event`; on draw/resize it asks `tui.draw` to render the overlay; all other events are ignored. It mutates `is_done` and pager state as needed and returns `Result<()>`.

**Call relations**: Called through `Overlay::handle_event` by higher-level app code while a transcript overlay is active.

*Call graph*: calls 1 internal fn (handle_key_event); 1 external calls (draw).


##### `TranscriptOverlay::is_done`  (lines 803–805)

```
fn is_done(&self) -> bool
```

**Purpose**: Returns whether the transcript overlay has been closed. It is the transcript-specific completion flag accessor.

**Data flow**: Reads and returns `self.is_done`. It has no side effects.

**Call relations**: Used by `Overlay::is_done` and potentially by tests or overlay-driving code.


##### `TranscriptOverlay::committed_cell_count`  (lines 808–810)

```
fn committed_cell_count(&self) -> usize
```

**Purpose**: Returns the number of committed transcript cells currently stored in the overlay. It is a test-only inspection helper.

**Data flow**: Reads `self.cells.len()` and returns it. It does not mutate state.

**Call relations**: Available only under `#[cfg(test)]` for assertions about overlay synchronization.


##### `StaticOverlay::with_title`  (lines 819–830)

```
fn with_title(
        lines: Vec<Line<'static>>,
        title: String,
        keymap: PagerKeymap,
    ) -> Self
```

**Purpose**: Constructs a static overlay from plain lines by wrapping them in a paragraph renderable. It is the convenience constructor for simple static pager content.

**Data flow**: Builds a wrapped `Paragraph` from the provided lines, boxes it inside `CachedRenderable`, places it in a one-element renderables vector, and delegates to `with_renderables`. It returns the new `StaticOverlay`.

**Call relations**: Called by `Overlay::new_static_with_lines` and by static-overlay tests.

*Call graph*: called by 2 (new_static_with_lines, static_overlay); 4 external calls (new, with_renderables, from, vec!).


##### `StaticOverlay::with_renderables`  (lines 832–841)

```
fn with_renderables(
        renderables: Vec<Box<dyn Renderable>>,
        title: String,
        keymap: PagerKeymap,
    ) -> Self
```

**Purpose**: Constructs a static overlay from arbitrary renderables and a title. It initializes the shared pager view at the top of the content.

**Data flow**: Creates `PagerView::new(renderables, title, 0, keymap)`, stores it with `is_done = false`, and returns the overlay. It writes no external state.

**Call relations**: Called by `Overlay::new_static_with_renderables` and by `with_title`.

*Call graph*: calls 1 internal fn (new); called by 1 (new_static_with_renderables).


##### `StaticOverlay::render_hints`  (lines 843–876)

```
fn render_hints(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Renders the static overlay's two-line footer hints for scrolling, paging, jumping, and quitting. Unlike transcript overlays, it has no edit-navigation hints.

**Data flow**: Builds two footer lines from the pager keymap using `first_or_empty` and `render_key_hints`, with the second line containing only the close hint. It writes only to the buffer.

**Call relations**: Called by `StaticOverlay::render` after the pager view itself has been drawn.

*Call graph*: calls 2 internal fn (first_or_empty, render_key_hints); called by 1 (render); 2 external calls (new, vec!).


##### `StaticOverlay::render`  (lines 878–884)

```
fn render(&mut self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Renders the static overlay by splitting the area into pager content and footer hints. It is the top-level drawing method for static overlays.

**Data flow**: Computes top and bottom areas, calls `self.view.render(top, buf)`, then `self.render_hints(bottom, buf)`. It writes to the buffer and may mutate pager caches through the delegated render.

**Call relations**: Called from `StaticOverlay::handle_event` on draw/resize and directly by tests.

*Call graph*: calls 2 internal fn (render, render_hints); 1 external calls (new).


##### `StaticOverlay::handle_event`  (lines 888–905)

```
fn handle_event(&mut self, tui: &mut tui::Tui, event: TuiEvent) -> Result<()>
```

**Purpose**: Processes overlay events for static overlays: close keys, pager navigation keys, and redraw events. It is the event-loop entry point for static overlays.

**Data flow**: Matches the incoming `TuiEvent`; on key events it closes the overlay if the close binding matches, otherwise delegates to `self.view.handle_key_event`; on draw/resize it redraws via `tui.draw`; other events are ignored. It mutates `is_done` and pager state as needed and returns `Result<()>`.

**Call relations**: Called through `Overlay::handle_event` by higher-level app code while a static overlay is active.

*Call graph*: calls 1 internal fn (handle_key_event); 1 external calls (draw).


##### `StaticOverlay::is_done`  (lines 906–908)

```
fn is_done(&self) -> bool
```

**Purpose**: Returns whether the static overlay has been closed. It is the static-overlay completion accessor.

**Data flow**: Reads and returns `self.is_done`. It has no side effects.

**Call relations**: Used by `Overlay::is_done` and by overlay-driving code.


##### `render_offset_content`  (lines 911–936)

```
fn render_offset_content(
    area: Rect,
    buf: &mut Buffer,
    renderable: &dyn Renderable,
    scroll_offset: u16,
) -> u16
```

**Purpose**: Renders a renderable into a temporary tall buffer and copies only the visible rows starting at a vertical offset into the destination buffer. It is how the pager displays a partially clipped top chunk.

**Data flow**: Computes the renderable's desired height, allocates a temporary `Buffer` tall enough for the visible slice, renders the full chunk into that buffer, computes `copy_height` from the destination area and `scroll_offset`, copies the relevant cells row-by-row into the destination buffer, and returns the number of rows copied. It writes to the destination buffer and allocates a temporary buffer.

**Call relations**: Called by `PagerView::render_content` when the first visible chunk begins above the viewport top.

*Call graph*: called by 1 (render_content); 4 external calls (empty, new, desired_height, render).


##### `tests::TestCell::display_lines`  (lines 966–968)

```
fn display_lines(&self, _width: u16) -> Vec<Line<'static>>
```

**Purpose**: Returns the test cell's stored lines for generic display rendering. It is part of the minimal `HistoryCell` test implementation.

**Data flow**: Ignores width and clones `self.lines`. It has no side effects.

**Call relations**: Used implicitly by code paths that render or inspect generic history-cell display output in tests.


##### `tests::TestCell::raw_lines`  (lines 970–972)

```
fn raw_lines(&self) -> Vec<Line<'static>>
```

**Purpose**: Returns the test cell's stored lines as raw lines. It satisfies the `HistoryCell` trait for tests.

**Data flow**: Clones and returns `self.lines`. It does not mutate state.

**Call relations**: Part of the test-only `HistoryCell` implementation used throughout overlay tests.


##### `tests::TestCell::transcript_lines`  (lines 974–976)

```
fn transcript_lines(&self, _width: u16) -> Vec<Line<'static>>
```

**Purpose**: Returns the test cell's stored lines for transcript rendering. It gives transcript overlay tests deterministic content.

**Data flow**: Ignores width and clones `self.lines`. It has no side effects.

**Call relations**: Used by transcript overlay rendering paths in tests.


##### `tests::paragraph_block`  (lines 979–986)

```
fn paragraph_block(label: &str, lines: usize) -> Box<dyn Renderable>
```

**Purpose**: Builds a boxed paragraph renderable containing numbered lines with a common label prefix. It is a helper for pager-layout tests.

**Data flow**: Creates `Line`s `label0`, `label1`, ... up to the requested count, wraps them in `Text` and `Paragraph`, boxes the paragraph as `Box<dyn Renderable>`, and returns it. It mutates no external state.

**Call relations**: Used by pager-view tests that need simple renderables with predictable heights and contents.

*Call graph*: 3 external calls (new, new, from).


##### `tests::default_pager_keymap`  (lines 988–990)

```
fn default_pager_keymap() -> crate::keymap::PagerKeymap
```

**Purpose**: Returns the default pager keymap from the runtime keymap defaults. It keeps tests aligned with production bindings.

**Data flow**: Calls `crate::keymap::RuntimeKeymap::defaults().pager` and returns the resulting `PagerKeymap`. It has no side effects.

**Call relations**: Used by test constructors for transcript overlays, static overlays, and pager views.

*Call graph*: calls 1 internal fn (defaults).


##### `tests::transcript_overlay`  (lines 992–994)

```
fn transcript_overlay(cells: Vec<Arc<dyn HistoryCell>>) -> TranscriptOverlay
```

**Purpose**: Constructs a transcript overlay test fixture with the default pager keymap. It shortens test setup.

**Data flow**: Takes committed cells, calls `TranscriptOverlay::new(cells, default_pager_keymap())`, and returns the overlay. It mutates no external state.

**Call relations**: Used by many transcript overlay tests in this file.

*Call graph*: calls 1 internal fn (new); 1 external calls (default_pager_keymap).


##### `tests::static_overlay`  (lines 996–998)

```
fn static_overlay(lines: Vec<Line<'static>>, title: &str) -> StaticOverlay
```

**Purpose**: Constructs a static overlay test fixture with the default pager keymap. It is a convenience helper for static-overlay tests.

**Data flow**: Takes lines and a title, calls `StaticOverlay::with_title(..., default_pager_keymap())`, and returns the overlay. It has no side effects.

**Call relations**: Used by static overlay snapshot and wrapping tests.

*Call graph*: calls 1 internal fn (with_title); 1 external calls (default_pager_keymap).


##### `tests::pager_view`  (lines 1000–1011)

```
fn pager_view(
        renderables: Vec<Box<dyn Renderable>>,
        title: &str,
        scroll_offset: usize,
    ) -> PagerView
```

**Purpose**: Constructs a pager view test fixture with the default pager keymap. It simplifies direct pager-behavior tests.

**Data flow**: Takes renderables, title, and initial scroll offset, calls `PagerView::new(..., default_pager_keymap())`, and returns the pager view. It writes no external state.

**Call relations**: Used by tests that exercise pager internals without going through an overlay wrapper.

*Call graph*: calls 1 internal fn (new); 1 external calls (default_pager_keymap).


##### `tests::edit_prev_hint_is_visible`  (lines 1014–1029)

```
fn edit_prev_hint_is_visible()
```

**Purpose**: Verifies that the transcript overlay footer shows the `edit prev` hint even when no cell is highlighted. This locks in the footer help text for transcript browsing.

**Data flow**: Creates a one-cell transcript overlay, renders it into a wide buffer, converts the buffer to text with `buffer_to_text`, and asserts that the text contains `edit prev`. It mutates only the test buffer.

**Call relations**: Exercises `TranscriptOverlay::render_hints` through the full render path.

*Call graph*: 6 external calls (empty, new, assert!, buffer_to_text, transcript_overlay, vec!).


##### `tests::edit_next_hint_is_visible_when_highlighted`  (lines 1032–1048)

```
fn edit_next_hint_is_visible_when_highlighted()
```

**Purpose**: Verifies that the transcript overlay footer adds the `edit next` hint when a cell is highlighted. This covers the highlight-dependent footer branch.

**Data flow**: Creates a one-cell transcript overlay, calls `set_highlight_cell(Some(0))`, renders into a wide buffer, converts to text, and asserts that `edit next` appears. It mutates the overlay and test buffer.

**Call relations**: Exercises the highlighted-cell branch of `TranscriptOverlay::render_hints`.

*Call graph*: 6 external calls (empty, new, assert!, buffer_to_text, transcript_overlay, vec!).


##### `tests::transcript_overlay_snapshot_basic`  (lines 1051–1068)

```
fn transcript_overlay_snapshot_basic()
```

**Purpose**: Captures a baseline snapshot of transcript overlay rendering with several simple cells. It guards the overall pager layout and transcript presentation.

**Data flow**: Builds a transcript overlay with three test cells, renders it into a `TestBackend` terminal, and snapshots the backend output. It writes only to the test terminal buffer.

**Call relations**: Exercises the standard transcript overlay render path.

*Call graph*: 5 external calls (new, assert_snapshot!, new, transcript_overlay, vec!).


##### `tests::transcript_overlay_preserves_semantic_web_links`  (lines 1071–1089)

```
fn transcript_overlay_preserves_semantic_web_links()
```

**Purpose**: Ensures that transcript overlay rendering preserves OSC 8 semantic hyperlinks from markdown cells. This verifies that hyperlink metadata survives pager rendering.

**Data flow**: Creates a transcript overlay containing an `AgentMarkdownCell` with a long destination URL, renders into a buffer, and asserts that some cell symbol contains the OSC 8 open sequence for that destination. It mutates only the test buffer.

**Call relations**: Exercises `CellRenderable::render` and `mark_buffer_hyperlinks` through the transcript overlay.

*Call graph*: 5 external calls (empty, new, assert!, transcript_overlay, vec!).


##### `tests::transcript_overlay_renders_live_tail`  (lines 1092–1110)

```
fn transcript_overlay_renders_live_tail()
```

**Purpose**: Captures a snapshot showing that a live tail appended via `sync_live_tail` is rendered after committed transcript cells. It verifies the basic live-tail feature.

**Data flow**: Creates a one-cell transcript overlay, calls `sync_live_tail` with a non-empty active-cell key and a closure returning one `HyperlinkLine`, renders into a test terminal, and snapshots the output. It mutates the overlay's live-tail state.

**Call relations**: Exercises `TranscriptOverlay::sync_live_tail` and the tail-rendering path.

*Call graph*: 5 external calls (new, assert_snapshot!, new, transcript_overlay, vec!).


##### `tests::transcript_overlay_live_tail_preserves_semantic_web_links`  (lines 1113–1141)

```
fn transcript_overlay_live_tail_preserves_semantic_web_links()
```

**Purpose**: Ensures that semantic hyperlinks are preserved in the live tail just as they are for committed cells. This covers the hyperlink-aware tail renderable path.

**Data flow**: Creates an empty transcript overlay, computes live-tail lines from an `AgentMarkdownCell`, syncs the tail, renders into a buffer, and asserts that some cell symbol contains the destination's OSC 8 sequence. It mutates the overlay and test buffer.

**Call relations**: Exercises `HyperlinkLinesRenderable::render` through `TranscriptOverlay::sync_live_tail`.

*Call graph*: calls 1 internal fn (new); 6 external calls (empty, new, new, assert!, new, transcript_overlay).


##### `tests::transcript_overlay_sync_live_tail_is_noop_for_identical_key`  (lines 1144–1166)

```
fn transcript_overlay_sync_live_tail_is_noop_for_identical_key()
```

**Purpose**: Verifies that `sync_live_tail` does not recompute the tail when called again with an identical cache key. This locks in the caching behavior.

**Data flow**: Creates a transcript overlay, defines a `Cell<usize>` call counter and one `ActiveCellTranscriptKey`, calls `sync_live_tail` twice with closures that increment the counter, and asserts that the counter is only 1. It mutates the overlay and local counter.

**Call relations**: Directly tests the key-equality early return in `TranscriptOverlay::sync_live_tail`.

*Call graph*: 4 external calls (assert_eq!, new, transcript_overlay, vec!).


##### `tests::buffer_to_text`  (lines 1168–1186)

```
fn buffer_to_text(buf: &Buffer, area: Rect) -> String
```

**Purpose**: Converts a rendered buffer region into plain text for assertions and snapshots, trimming trailing spaces per row for stability. It is a general overlay test helper.

**Data flow**: Iterates all cells in the given area row by row, appends the first character of each symbol or a space, trims trailing spaces after each row, appends a newline, and returns the resulting string. It does not mutate the buffer.

**Call relations**: Used by multiple tests that assert on rendered textual content rather than full terminal snapshots.

*Call graph*: 3 external calls (bottom, right, new).


##### `tests::transcript_overlay_apply_patch_scroll_vt100_clears_previous_page`  (lines 1189–1251)

```
fn transcript_overlay_apply_patch_scroll_vt100_clears_previous_page()
```

**Purpose**: Regression-tests transcript overlay rendering after scrolling around a sequence of patch and command cells, ensuring stale content from a previous page is cleared. It targets VT100-style redraw correctness.

**Data flow**: Builds a realistic transcript with patch events, approval decisions, and a completed exec cell, renders the overlay into a buffer, manually resets `scroll_offset` to the top, renders again into the same buffer, converts the buffer to text, and snapshots it. It mutates the overlay and test buffer.

**Call relations**: Exercises pager redraw behavior, especially `PagerView::render_content` and its clearing/fill logic.

*Call graph*: 15 external calls (new, empty, from_millis, new, from, new, new, assert_snapshot!, new_active_exec_command, new_patch_event (+5 more)).


##### `tests::transcript_overlay_keeps_scroll_pinned_at_bottom`  (lines 1254–1278)

```
fn transcript_overlay_keeps_scroll_pinned_at_bottom()
```

**Purpose**: Verifies that inserting a committed cell preserves bottom-follow behavior when the overlay was already at the bottom. This is important for live transcript viewing.

**Data flow**: Creates a long transcript overlay, renders once to populate layout caches, asserts `is_scrolled_to_bottom()`, inserts a new cell, and asserts that `scroll_offset` is the bottom sentinel `usize::MAX`. It mutates the overlay under test.

**Call relations**: Exercises the follow-bottom branch in `TranscriptOverlay::insert_cell`.

*Call graph*: 7 external calls (new, new, assert!, assert_eq!, new, transcript_overlay, vec!).


##### `tests::transcript_overlay_preserves_manual_scroll_position`  (lines 1281–1302)

```
fn transcript_overlay_preserves_manual_scroll_position()
```

**Purpose**: Verifies that inserting a committed cell does not force-scroll to the bottom when the user has manually scrolled upward. This preserves user browsing position.

**Data flow**: Creates and renders a long transcript overlay, manually sets `scroll_offset = 0`, inserts a new cell, and asserts that the offset remains 0. It mutates the overlay under test.

**Call relations**: Exercises the non-follow-bottom branch in `TranscriptOverlay::insert_cell`.

*Call graph*: 6 external calls (new, new, assert_eq!, new, transcript_overlay, vec!).


##### `tests::transcript_overlay_consolidation_remaps_highlight_inside_range`  (lines 1305–1329)

```
fn transcript_overlay_consolidation_remaps_highlight_inside_range()
```

**Purpose**: Checks that when a highlighted cell lies inside a consolidated range, the highlight moves to the replacement cell. This preserves a meaningful highlight after consolidation.

**Data flow**: Creates a transcript overlay, highlights cell 3, consolidates range `2..5` into one replacement cell, and asserts that `highlight_cell` becomes `Some(2)`. It mutates the overlay under test.

**Call relations**: Exercises the inside-range highlight remapping logic in `TranscriptOverlay::consolidate_cells`.

*Call graph*: 4 external calls (new, assert_eq!, transcript_overlay, vec!).


##### `tests::transcript_overlay_consolidation_remaps_highlight_after_range`  (lines 1332–1356)

```
fn transcript_overlay_consolidation_remaps_highlight_after_range()
```

**Purpose**: Checks that when a highlighted cell lies after a consolidated range, the highlight shifts left by the number of removed cells minus one. This keeps the highlight attached to the same logical later cell.

**Data flow**: Creates a transcript overlay, highlights cell 6, consolidates range `2..5`, and asserts that `highlight_cell` becomes `Some(4)`. It mutates the overlay under test.

**Call relations**: Exercises the after-range highlight remapping branch in `TranscriptOverlay::consolidate_cells`.

*Call graph*: 4 external calls (new, assert_eq!, transcript_overlay, vec!).


##### `tests::static_overlay_snapshot_basic`  (lines 1359–1369)

```
fn static_overlay_snapshot_basic()
```

**Purpose**: Captures a baseline snapshot of static overlay rendering with a few lines. It guards the shared pager chrome for static content.

**Data flow**: Builds a static overlay, renders it into a `TestBackend` terminal, and snapshots the backend output. It writes only to the test terminal buffer.

**Call relations**: Exercises `StaticOverlay::render` and the shared pager rendering path.

*Call graph*: 5 external calls (new, assert_snapshot!, new, static_overlay, vec!).


##### `tests::transcript_line_numbers`  (lines 1372–1395)

```
fn transcript_line_numbers(overlay: &mut TranscriptOverlay, area: Rect) -> Vec<usize>
```

**Purpose**: Renders a transcript overlay and extracts visible `line-NN` numbers from the content area in order. It is a helper for paging continuity tests.

**Data flow**: Renders the overlay into a buffer, computes the transcript content area from the overlay's pager geometry, scans each visible row for tokens prefixed with `line-`, parses the numbers, and returns them as a vector. It mutates only the test buffer.

**Call relations**: Used by the paging round-trip test to compare visible content before and after page movements.

*Call graph*: calls 1 internal fn (render); 4 external calls (empty, new, new, new).


##### `tests::transcript_overlay_paging_is_continuous_and_round_trips`  (lines 1398–1463)

```
fn transcript_overlay_paging_is_continuous_and_round_trips()
```

**Purpose**: Verifies that page-down/page-up behavior is continuous and reversible across several scenarios. It ensures paging uses the real content height and does not skip or duplicate lines unexpectedly.

**Data flow**: Creates a 50-line transcript overlay, renders once to populate `last_content_height`, computes `page_height`, then manually adjusts `scroll_offset` through several scenarios while collecting visible line numbers with `transcript_line_numbers`, asserting continuity and round-trip equality. It mutates the overlay and test buffer repeatedly.

**Call relations**: Exercises `PagerView::page_height`, content-area calculations, and the overall paging semantics of transcript overlays.

*Call graph*: 5 external calls (empty, new, assert_eq!, transcript_line_numbers, transcript_overlay).


##### `tests::static_overlay_wraps_long_lines`  (lines 1466–1475)

```
fn static_overlay_wraps_long_lines()
```

**Purpose**: Captures a snapshot showing that long static-overlay lines wrap correctly in a narrow pager width. It guards wrapping behavior for static content.

**Data flow**: Builds a static overlay with one long line, renders it into a narrow `TestBackend` terminal, and snapshots the output. It writes only to the test terminal buffer.

**Call relations**: Exercises `StaticOverlay::render` and wrapped paragraph height calculation.

*Call graph*: 5 external calls (new, assert_snapshot!, new, static_overlay, vec!).


##### `tests::pager_view_content_height_counts_renderables`  (lines 1478–1489)

```
fn pager_view_content_height_counts_renderables()
```

**Purpose**: Verifies that pager content height is the sum of each renderable's desired height. It is a direct unit test of the pager's height accounting.

**Data flow**: Builds a pager view from two paragraph blocks of known heights, calls `content_height(80)`, and asserts that the result is 5. It mutates no state.

**Call relations**: Directly tests `PagerView::content_height`.

*Call graph*: 3 external calls (assert_eq!, pager_view, vec!).


##### `tests::pager_view_ensure_chunk_visible_scrolls_down_when_needed`  (lines 1492–1524)

```
fn pager_view_ensure_chunk_visible_scrolls_down_when_needed()
```

**Purpose**: Verifies that `ensure_chunk_visible` scrolls downward enough to bring a lower chunk fully into view. It checks the downward-adjustment branch.

**Data flow**: Builds a pager view with three chunks, computes the content area, calls `ensure_chunk_visible(2, content_area)`, renders the pager into a buffer, converts it to text, and asserts that all lines of chunk `c` are visible. It mutates the pager's `scroll_offset` and the test buffer.

**Call relations**: Directly exercises `PagerView::ensure_chunk_visible` and then validates the result through rendering.

*Call graph*: 6 external calls (empty, new, assert!, buffer_to_text, pager_view, vec!).


##### `tests::pager_view_ensure_chunk_visible_scrolls_up_when_needed`  (lines 1527–1543)

```
fn pager_view_ensure_chunk_visible_scrolls_up_when_needed()
```

**Purpose**: Verifies that `ensure_chunk_visible` scrolls upward when the requested chunk lies above the current viewport. It checks the upward-adjustment branch.

**Data flow**: Builds a pager view, sets `scroll_offset = 6`, calls `ensure_chunk_visible(0, area)`, and asserts that the offset becomes 0. It mutates the pager under test.

**Call relations**: Directly tests the upward branch of `PagerView::ensure_chunk_visible`.

*Call graph*: 4 external calls (new, assert_eq!, pager_view, vec!).


##### `tests::pager_view_is_scrolled_to_bottom_accounts_for_wrapped_height`  (lines 1546–1569)

```
fn pager_view_is_scrolled_to_bottom_accounts_for_wrapped_height()
```

**Purpose**: Verifies that bottom detection uses wrapped content height rather than only raw chunk count, and that the bottom sentinel is honored. This protects follow-bottom logic for wrapped content.

**Data flow**: Builds a pager view with one 10-line paragraph block, renders it once into a buffer, asserts that `is_scrolled_to_bottom()` is false at offset 0, then sets `scroll_offset = usize::MAX`, renders again, and asserts that bottom detection is true. It mutates the pager and test buffer.

**Call relations**: Exercises `PagerView::is_scrolled_to_bottom` in both ordinary and sentinel-bottom cases.

*Call graph*: 5 external calls (empty, new, assert!, pager_view, vec!).


### Keymap editing flow
These files define configurable keymap actions and build the picker, editor, debug inspector, and chat-widget integration for interactive remapping.

### `tui/src/chatwidget/keymap_picker.rs`

`orchestration` · `request handling`

This module is the `ChatWidget` side of keymap editing. It does not define picker models itself; instead it bridges between persisted config, runtime keymap derivation, bottom-pane view presentation, and the widget fields that cache active bindings. `open_keymap_picker` is the root entry: it validates `self.config.tui_keymap` by constructing a `RuntimeKeymap`, then builds filtered picker parameters using `keymap_action_filter`; invalid config is surfaced immediately as an error rather than letting the user edit against stale or partial bindings.

The remaining openers each target a specific step in the flow: action menu, capture view, debug inspector, and replace-binding menu. They all pass the already-resolved `RuntimeKeymap` through to `keymap_setup` builders so the UI reflects the exact binding state associated with the triggering event. `return_to_keymap_picker` is careful about navigation stack hygiene: it tries to replace known keymap-related active views in place so repeated edits do not accumulate obsolete submenus, and falls back to showing a fresh picker if the expected stack is no longer active.

`apply_keymap_update` enforces the file’s key invariant that a committed edit must update three places together: persisted in-memory config (`self.config.tui_keymap`), app-level shortcut caches (`copy_last_response_binding`, `chat_keymap`, and the derived queued-message edit hint), and the bottom pane’s runtime bindings. It also recomputes the queued-message edit hint using terminal capabilities from `terminal_info()` before requesting redraw.

#### Function details

##### `ChatWidget::open_keymap_picker`  (lines 30–44)

```
fn open_keymap_picker(&mut self)
```

**Purpose**: Opens the root `/keymap` picker using the current persisted keymap configuration after validating it into a runtime keymap.

**Data flow**: Reads `self.config.tui_keymap` and calls `RuntimeKeymap::from_config(...)`. On success it computes a `KeymapActionFilter` from `keymap_action_filter()`, builds selection params with `build_keymap_picker_params_with_filter`, and shows them in the bottom pane. On error it formats and emits an error message describing the invalid config.

**Call relations**: This is the entrypoint into the keymap-editing UI. It depends on `keymap_action_filter` so the picker can hide or show actions based on current widget capabilities such as fast mode.

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

**Purpose**: Shows the per-action menu for a selected keymap action using the runtime keymap associated with that selection.

**Data flow**: Takes `context`, `action`, and `runtime_keymap`, builds selection params with `keymap_setup::build_keymap_action_menu_params(context, action, runtime_keymap, &self.config.tui_keymap)`, and passes them to `bottom_pane.show_selection_view`.

**Call relations**: Called after the user selects an action in the root picker. It intentionally uses the caller-provided runtime keymap rather than recomputing one.

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

**Purpose**: Opens the key-capture view for a specific keymap edit intent and wires it back into the app-event path.

**Data flow**: Takes `context`, `action`, `intent`, and `runtime_keymap`, builds a capture view with `keymap_setup::build_keymap_capture_view(..., self.app_event_tx.clone())`, shows it via `bottom_pane.show_view(Box::new(view))`, and requests redraw.

**Call relations**: Used from keymap menus when the next step is to capture a new key binding. The injected event sender ensures the captured key returns through the normal persistence/update flow.

*Call graph*: calls 1 internal fn (build_keymap_capture_view); 1 external calls (new).


##### `ChatWidget::open_keymap_debug`  (lines 90–94)

```
fn open_keymap_debug(&mut self, runtime_keymap: &RuntimeKeymap)
```

**Purpose**: Shows the keypress inspector/debug view for the current runtime keymap.

**Data flow**: Builds a debug view with `keymap_setup::build_keymap_debug_view(runtime_keymap, &self.config.tui_keymap)`, shows it in the bottom pane, and requests redraw.

**Call relations**: Used by keymap tooling to inspect how current bindings resolve without modifying them.

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

**Purpose**: Shows the menu for choosing which existing binding of a multi-bound action should be replaced.

**Data flow**: Takes `context`, `action`, and `runtime_keymap`, builds selection params with `build_keymap_replace_binding_menu_params`, and shows them in the bottom pane.

**Call relations**: Used only in the branch of the keymap-edit flow where an action has multiple effective bindings and the user must choose one to replace.

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

**Purpose**: Navigates back to the root keymap picker with the edited action selected, replacing stale submenu views when possible.

**Data flow**: Builds picker params for the selected action using `build_keymap_picker_params_for_selected_action_with_filter(runtime_keymap, &self.config.tui_keymap, self.keymap_action_filter(), context, action)`. It then asks `bottom_pane.replace_active_views_with_selection_view` to replace a known stack of keymap view ids with the new picker. If replacement fails, it rebuilds the same params and shows a fresh selection view instead. Finally it requests redraw.

**Call relations**: Called after a keymap edit completes so the user lands back on the relevant picker row. It uses `keymap_action_filter` and coordinates with bottom-pane view-stack replacement semantics.

*Call graph*: calls 1 internal fn (keymap_action_filter); 1 external calls (build_keymap_picker_params_for_selected_action_with_filter).


##### `ChatWidget::keymap_action_filter`  (lines 152–156)

```
fn keymap_action_filter(&self) -> keymap_setup::KeymapActionFilter
```

**Purpose**: Builds the current action-filter settings used when generating keymap picker rows.

**Data flow**: Reads `self.fast_mode_enabled()` and returns `keymap_setup::KeymapActionFilter { fast_mode_enabled: ... }`.

**Call relations**: Used by both `open_keymap_picker` and `return_to_keymap_picker` so picker contents stay consistent with current widget capabilities.

*Call graph*: called by 2 (open_keymap_picker, return_to_keymap_picker).


##### `ChatWidget::apply_keymap_update`  (lines 164–180)

```
fn apply_keymap_update(
        &mut self,
        keymap_config: TuiKeymap,
        runtime_keymap: &RuntimeKeymap,
    )
```

**Purpose**: Applies a committed keymap edit to all live widget state that depends on key bindings, keeping config, cached shortcuts, and bottom-pane bindings synchronized.

**Data flow**: Takes a new `TuiKeymap` config and a `RuntimeKeymap`. It writes `self.config.tui_keymap = keymap_config`, updates `self.copy_last_response_binding` from `runtime_keymap.app.copy`, updates `self.chat_keymap` from `runtime_keymap.chat`, recomputes `self.queued_message_edit_hint_binding` using `queued_message_edit_hint_binding(&self.chat_keymap.edit_queued_message, terminal_info())`, pushes that hint binding into the bottom pane, updates bottom-pane runtime bindings with `set_keymap_bindings(runtime_keymap)`, and requests redraw.

**Call relations**: Called after config persistence succeeds for a keymap edit. It is the final synchronization step that makes the new bindings take effect immediately in both app-level and bottom-pane handlers.

*Call graph*: 2 external calls (terminal_info, queued_message_edit_hint_binding).


### `tui/src/keymap_setup.rs`

`orchestration` · `interactive keymap editing in the bottom pane`

This module is the UI-side companion to `keymap.rs`. It starts from a resolved `RuntimeKeymap` plus the root `TuiKeymap` config and builds selection views for editing shortcuts. `build_keymap_action_menu_params` inspects both runtime bindings and root config state to decide which operations are available: unbound actions only offer “Set key”, single-binding actions offer replace/add, and multi-binding actions add a replace-one submenu. The menu header explicitly shows the active binding summary, whether the source is default or custom, and the exact `tui.keymap.<context>.<action>` path that will be written.

Actual edits are computed by `keymap_with_edit`. It reads the current effective bindings from the runtime map, applies `ReplaceAll`, `AddAlternate`, or `ReplaceOne`, rejects stale replace-one selections, de-duplicates replacements, and returns either `KeymapEditOutcome::Updated` with a new boxed `TuiKeymap` plus status message, or `Unchanged` when the effective set did not change. `keymap_with_bindings` and `keymap_without_custom_binding` mutate the concrete root config slot selected through `actions::binding_slot`.

The transient `KeymapCaptureView` renders instructions, captures exactly one non-release `KeyEvent`, treats `Esc` as cancel, converts the event into a canonical config key string via `key_event_to_config_key_spec`, and emits `AppEvent::KeymapCaptured`. Serialization is strict: only ctrl/alt/shift modifiers, printable ASCII chars, supported named keys, and function keys up to `MAX_FUNCTION_KEY` are accepted. Uppercase chars are normalized into lowercase plus `shift`, and `-` is stored as `minus`.

#### Function details

##### `key_binding_span`  (lines 85–91)

```
fn key_binding_span(binding: &str) -> ratatui::text::Span<'static>
```

**Purpose**: Formats one binding label for menu display, dimming the special `unbound` marker and coloring actual bindings cyan.

**Data flow**: Reads a binding string slice, compares it to `"unbound"`, and returns a styled `Span<'static>` built from an owned string.

**Call relations**: Used when building action-menu headers so the current binding summary is visually distinct.


##### `keymap_action_menu_hint_line`  (lines 93–100)

```
fn keymap_action_menu_hint_line() -> Line<'static>
```

**Purpose**: Builds the standard footer hint line for keymap action menus. It advertises Enter for selection and Esc for going back.

**Data flow**: Constructs and returns a `Line<'static>` from styled text fragments.

**Call relations**: Shared by both the main action menu and the replace-one binding picker.

*Call graph*: called by 2 (build_keymap_action_menu_params, build_keymap_replace_binding_menu_params); 2 external calls (from, vec!).


##### `open_capture_action`  (lines 102–114)

```
fn open_capture_action(
    context: String,
    action: String,
    intent: KeymapEditIntent,
) -> Box<dyn Fn(&AppEventSender) + Send + Sync>
```

**Purpose**: Creates a reusable selection-item callback that opens the key-capture view for a specific context/action/intent triple.

**Data flow**: Captures owned `context`, `action`, and `KeymapEditIntent` values in a boxed closure; when invoked with an `AppEventSender`, the closure sends `AppEvent::OpenKeymapCapture` containing cloned copies.

**Call relations**: Used by `action_menu_item` to wire menu rows into the app event loop.

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

**Purpose**: Constructs one standard `SelectionItem` row for the action menu. It packages labels, descriptions, and the callback that opens capture for a chosen edit intent.

**Data flow**: Takes display strings plus context/action/intent, builds a `SelectionItem` with those texts and a single action closure from `open_capture_action`, and returns it.

**Call relations**: Called by `build_keymap_action_menu_params` for the common replace/add/set rows.

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

**Purpose**: Builds the second-step menu shown after the user selects a shortcut action in `/keymap`. The menu adapts to the action’s current effective binding count and whether a root override exists.

**Data flow**: Reads runtime bindings via `active_binding_specs`, checks root-config presence with `has_custom_binding`, looks up descriptor metadata in `KEYMAP_ACTIONS`, builds a `ColumnRenderable` header showing label, context, current binding summary, source, config path, and description, then assembles `SelectionItem`s for set/replace/add/remove/back and returns a populated `SelectionViewParams`.

**Call relations**: Opened by higher-level app code after the picker selection. It delegates binding introspection to `active_binding_specs`, descriptor labeling to `action_label`, and uses `action_menu_item` plus custom closures for replace-one and clear actions.

*Call graph*: calls 6 internal fn (action_menu_item, action_label, active_binding_specs, has_custom_binding, keymap_action_menu_hint_line, new); called by 6 (open_keymap_action_menu, action_menu_content_snapshot, action_menu_disables_clear_when_action_has_no_custom_binding, capture_completion_returns_to_selected_keymap_picker_row, clear_completion_returns_to_selected_keymap_picker_row, replace_one_completion_drops_focused_keymap_submenus); 6 external calls (new, default, from, new, format!, vec!).


##### `build_keymap_replace_binding_menu_params`  (lines 305–354)

```
fn build_keymap_replace_binding_menu_params(
    context: String,
    action: String,
    runtime_keymap: &RuntimeKeymap,
) -> SelectionViewParams
```

**Purpose**: Builds the submenu used when an action currently has multiple bindings and the user wants to replace exactly one of them.

**Data flow**: Reads the active binding specs for the selected action, builds a header naming the action and context, maps each current binding string into a `SelectionItem` whose callback sends `AppEvent::OpenKeymapCapture` with `KeymapEditIntent::ReplaceOne { old_key }`, and returns `SelectionViewParams` for the submenu.

**Call relations**: Opened from the main action menu when an action has more than one active binding.

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

**Purpose**: Builds a conflict dialog shown after capture when the proposed edit fails runtime keymap validation. It gives the user a retry path without losing the selected action and intent.

**Data flow**: Takes the selected context/action, captured key string, edit intent, and error text; builds a `SelectionViewParams` with a title, subtitle, footer note containing the error, standard popup hints, and two items: retry capture or cancel.

**Call relations**: Used by the app-layer capture-apply flow when `RuntimeKeymap::from_config` rejects the edited config.

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

**Purpose**: Creates the transient bottom-pane view that waits for one keypress for a pending edit. It shows the action label and current effective binding summary before capture.

**Data flow**: Looks up the selected action’s runtime bindings with `bindings_for_action`, formats them with `format_binding_summary`, derives a display label with `action_label`, and constructs a `KeymapCaptureView` with those values plus the app event sender.

**Call relations**: Opened by app code in response to `AppEvent::OpenKeymapCapture` from the action menu or replace-one submenu.

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

**Purpose**: Test-only convenience wrapper that replaces an action’s bindings with a single key string.

**Data flow**: Passes the provided single key as a one-element slice into `keymap_with_bindings` and returns the resulting edited `TuiKeymap` or error.

**Call relations**: Used by tests to build simple customized keymaps without repeating slice construction.

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

**Purpose**: Applies one logical edit operation—replace all, add alternate, or replace one—to a selected action and returns either an updated config snapshot or an unchanged result. It operates on effective runtime bindings so edits preserve defaults when needed.

**Data flow**: Reads the current effective binding specs via `active_binding_specs`; computes `next_bindings` based on the `KeymapEditIntent`, rejecting stale `old_key` values and de-duplicating replace-one results with `dedup_bindings`; compares the new list to the current list; if unchanged returns `KeymapEditOutcome::Unchanged`, otherwise writes the new list into a cloned config via `keymap_with_bindings` and returns `KeymapEditOutcome::Updated` with the new boxed config, final binding strings, and a status message.

**Call relations**: Called by the app-layer capture handler after a key is captured. It delegates slot mutation to `keymap_with_bindings` and relies on later runtime resolution to catch conflicts.

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

**Purpose**: Writes a concrete binding list into the root config slot for one action. It preserves the distinction between one binding and many bindings in the serialized config shape.

**Data flow**: Clones the input `TuiKeymap`, locates the mutable `Option<KeybindingsSpec>` slot with `binding_slot`, errors if the action is unknown, then writes `Some(KeybindingsSpec::One(...))` for a single key or `Some(KeybindingsSpec::Many(...))` for multiple keys and returns the cloned config.

**Call relations**: Used by `keymap_with_edit` and test helpers as the low-level config mutation primitive.

*Call graph*: calls 1 internal fn (binding_slot); called by 6 (keymap_with_edit, keymap_with_replacement, action_menu_content_snapshot, replace_all_collapses_multi_binding_to_single, replace_one_deduplicates_replacement, replace_one_preserves_other_bindings); 4 external calls (new, Many, One, clone).


##### `active_binding_specs`  (lines 536–548)

```
fn active_binding_specs(
    runtime_keymap: &RuntimeKeymap,
    context: &str,
    action: &str,
) -> Result<Vec<String>, String>
```

**Purpose**: Converts the currently active runtime bindings for one action back into canonical config strings. This lets the editor preserve effective defaults and alternates when building new root overrides.

**Data flow**: Looks up the action’s `&[KeyBinding]` via `bindings_for_action`, errors if the action is unknown, maps each binding through `binding_to_config_key_spec`, and collects the resulting `Vec<String>`.

**Call relations**: Used by menus for display and by `keymap_with_edit` when computing edits against the effective runtime state.

*Call graph*: calls 1 internal fn (bindings_for_action); called by 3 (build_keymap_action_menu_params, build_keymap_replace_binding_menu_params, keymap_with_edit).


##### `dedup_bindings`  (lines 550–557)

```
fn dedup_bindings(bindings: Vec<String>) -> Vec<String>
```

**Purpose**: Removes duplicate canonical key strings while preserving first-seen order.

**Data flow**: Consumes a `Vec<String>`, folds it into a new vector, and only pushes keys not already present.

**Call relations**: Used by `keymap_with_edit` for replace-one operations where the replacement may already exist elsewhere in the binding list.

*Call graph*: called by 1 (keymap_with_edit); 1 external calls (new).


##### `keymap_without_custom_binding`  (lines 564–575)

```
fn keymap_without_custom_binding(
    keymap: &TuiKeymap,
    context: &str,
    action: &str,
) -> Result<TuiKeymap, String>
```

**Purpose**: Clears the root-level override for one action so runtime resolution falls back to defaults or global fallback again.

**Data flow**: Clones the input `TuiKeymap`, locates the mutable slot with `binding_slot`, sets it to `None`, and returns the edited config or an unknown-action error.

**Call relations**: Called by the app-layer clear action after the user chooses “Remove custom binding”.

*Call graph*: calls 1 internal fn (binding_slot); called by 2 (apply_keymap_clear, clear_removes_custom_binding); 1 external calls (clone).


##### `has_custom_binding`  (lines 577–583)

```
fn has_custom_binding(keymap: &TuiKeymap, context: &str, action: &str) -> Result<bool, String>
```

**Purpose**: Checks whether a selected action currently has a root-level override in config.

**Data flow**: Clones the `TuiKeymap`, locates the slot with `binding_slot`, and returns `Ok(slot.is_some())` or an unknown-action error.

**Call relations**: Used by action-menu construction and picker row generation to distinguish custom overrides from inherited defaults.

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

**Purpose**: Constructs the transient capture view state for one pending keymap edit.

**Data flow**: Stores the provided context, action, intent, label, current binding summary, and `AppEventSender` into a new `KeymapCaptureView`, initializing `complete` to `false` and `error_message` to `None`.

**Call relations**: Called by `build_keymap_capture_view` and directly by snapshot tests.

*Call graph*: called by 2 (build_keymap_capture_view, capture_view_snapshot).


##### `KeymapCaptureView::lines`  (lines 623–650)

```
fn lines(&self, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Builds the rendered text lines for the capture view, including any wrapped validation error.

**Data flow**: Computes a wrap width from the provided terminal width, creates base lines for title, action, current binding, and instructions, and if `error_message` is present wraps it with `textwrap` into additional red lines before returning the full `Vec<Line<'static>>`.

**Call relations**: Used by both `render` and `desired_height` so layout and drawing stay consistent.

*Call graph*: called by 2 (desired_height, render); 5 external calls (from, new, wrap, from, vec!).


##### `KeymapCaptureView::render`  (lines 654–656)

```
fn render(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Renders the capture view into the bottom-pane buffer.

**Data flow**: Calls `self.lines(area.width)` to build the content and passes it into a `Paragraph` rendered into the provided `Buffer` and `Rect`.

**Call relations**: Implements the `Renderable` trait for the capture view.

*Call graph*: calls 1 internal fn (lines); called by 1 (render_capture); 1 external calls (new).


##### `KeymapCaptureView::desired_height`  (lines 658–660)

```
fn desired_height(&self, width: u16) -> u16
```

**Purpose**: Reports how many terminal rows the capture view needs at a given width.

**Data flow**: Builds the line vector with `self.lines(width)` and returns its length as `u16`.

**Call relations**: Used by layout code through the `Renderable` trait.

*Call graph*: calls 1 internal fn (lines).


##### `KeymapCaptureView::handle_key_event`  (lines 664–688)

```
fn handle_key_event(&mut self, key_event: KeyEvent)
```

**Purpose**: Consumes one terminal key event for the pending edit. It ignores release events, treats `Esc` as cancel, and otherwise serializes the key into a config string and emits `AppEvent::KeymapCaptured`.

**Data flow**: Reads a `KeyEvent`; returns immediately on `KeyEventKind::Release`; if the code is `Esc`, marks `complete = true`; otherwise converts the event with `key_event_to_config_key_spec`, on success sends `AppEvent::KeymapCaptured { context, action, key, intent }` through `app_event_tx` and marks complete, and on failure stores the error string in `error_message`.

**Call relations**: Called by the bottom-pane event loop while the capture view is active.

*Call graph*: calls 2 internal fn (send, key_event_to_config_key_spec); 1 external calls (clone).


##### `KeymapCaptureView::is_complete`  (lines 690–692)

```
fn is_complete(&self) -> bool
```

**Purpose**: Reports whether the capture view should be dismissed.

**Data flow**: Returns the current boolean `complete` flag.

**Call relations**: Queried by the bottom-pane framework after key handling.


##### `KeymapCaptureView::on_ctrl_c`  (lines 694–697)

```
fn on_ctrl_c(&mut self) -> CancellationEvent
```

**Purpose**: Handles Ctrl+C as an explicit cancellation of the capture view.

**Data flow**: Sets `complete = true` and returns `CancellationEvent::Handled`.

**Call relations**: Implements the `BottomPaneView` cancellation hook.


##### `KeymapCaptureView::prefer_esc_to_handle_key_event`  (lines 699–701)

```
fn prefer_esc_to_handle_key_event(&self) -> bool
```

**Purpose**: Requests that Esc be delivered to this view instead of being intercepted by outer popup dismissal logic.

**Data flow**: Returns `true` with no side effects.

**Call relations**: Lets the capture view inspect Esc as a captured/cancel key.


##### `key_event_to_config_key_spec`  (lines 704–706)

```
fn key_event_to_config_key_spec(key_event: KeyEvent) -> Result<String, String>
```

**Purpose**: Converts a raw terminal `KeyEvent` into the canonical string form stored in `tui.keymap`.

**Data flow**: Normalizes the event into a `KeyBinding` with `KeyBinding::from_event`, then delegates to `binding_to_config_key_spec` and returns `Result<String, String>`.

**Call relations**: Used by `KeymapCaptureView::handle_key_event` during capture.

*Call graph*: calls 2 internal fn (from_event, binding_to_config_key_spec); called by 1 (handle_key_event).


##### `binding_to_config_key_spec`  (lines 708–711)

```
fn binding_to_config_key_spec(binding: KeyBinding) -> Result<String, String>
```

**Purpose**: Converts a `KeyBinding` into a canonical config key string.

**Data flow**: Extracts `(KeyCode, KeyModifiers)` from the binding with `parts()` and passes them to `key_parts_to_config_key_spec`.

**Call relations**: Shared conversion helper used by event capture and runtime-binding display.

*Call graph*: calls 2 internal fn (parts, key_parts_to_config_key_spec); called by 1 (key_event_to_config_key_spec).


##### `key_parts_to_config_key_spec`  (lines 713–767)

```
fn key_parts_to_config_key_spec(
    code: KeyCode,
    mut modifiers: KeyModifiers,
) -> Result<String, String>
```

**Purpose**: Serializes normalized key parts into the exact canonical syntax accepted by `tui.keymap`. It rejects unsupported modifiers, unsupported key codes, non-ASCII printable chars, and out-of-range function keys.

**Data flow**: Normalizes `(code, modifiers)` with `crate::key_hint::normalize_key_parts`, checks that only CONTROL/ALT/SHIFT remain, maps supported `KeyCode` variants to canonical names, converts uppercase chars into lowercase plus inserted SHIFT, special-cases `-` as `minus`, and returns either `Ok(format_key_spec(...))` or a descriptive `Err(String)`.

**Call relations**: This is the core serializer behind capture and debug display of config-compatible key specs.

*Call graph*: calls 2 internal fn (normalize_key_parts, format_key_spec); called by 1 (binding_to_config_key_spec); 3 external calls (difference, insert, format!).


##### `format_key_spec`  (lines 769–782)

```
fn format_key_spec(modifiers: KeyModifiers, key: &str) -> String
```

**Purpose**: Formats a modifier bitset plus canonical key name into the stored `ctrl-alt-shift-key` string order.

**Data flow**: Builds a `Vec<&str>` in fixed modifier order—control, alt, shift—appends the key name, joins with `-`, and returns the resulting `String`.

**Call relations**: Used by `key_parts_to_config_key_spec` after key normalization and validation.

*Call graph*: called by 1 (key_parts_to_config_key_spec); 2 external calls (contains, new).


##### `tests::app_event_sender`  (lines 803–806)

```
fn app_event_sender() -> AppEventSender
```

**Purpose**: Creates a throwaway `AppEventSender` for UI tests.

**Data flow**: Creates an unbounded channel, discards the receiver, wraps the sender in `AppEventSender`, and returns it.

**Call relations**: Shared by rendering and capture-view tests.

*Call graph*: calls 1 internal fn (new); 1 external calls (unbounded_channel).


##### `tests::render_capture`  (lines 808–813)

```
fn render_capture(view: &KeymapCaptureView, width: u16, height: u16) -> Buffer
```

**Purpose**: Renders a `KeymapCaptureView` into a test buffer of fixed size.

**Data flow**: Creates a `Rect`, allocates an empty `Buffer`, calls `view.render`, and returns the filled buffer.

**Call relations**: Used by snapshot tests for the capture view.

*Call graph*: calls 1 internal fn (render); 2 external calls (empty, new).


##### `tests::render_debug`  (lines 815–821)

```
fn render_debug(view: &KeymapDebugView, width: u16) -> String
```

**Purpose**: Renders a debug inspector view into a string snapshot.

**Data flow**: Computes desired height, renders the view into a buffer, converts the buffer to text with `render_buffer`, and returns the string.

**Call relations**: Used by debug-view snapshot tests.

*Call graph*: calls 2 internal fn (desired_height, render); 3 external calls (empty, new, render_buffer).


##### `tests::render_picker`  (lines 823–827)

```
fn render_picker(params: SelectionViewParams, width: u16) -> String
```

**Purpose**: Builds and renders a picker selection view from params for snapshot testing.

**Data flow**: Constructs a `ListSelectionView` with the provided params, a test sender, and default list keymap, then delegates to `render_picker_from_view`.

**Call relations**: Used by picker snapshot tests.

*Call graph*: calls 2 internal fn (new, defaults); 2 external calls (app_event_sender, render_picker_from_view).


##### `tests::render_picker_from_view`  (lines 829–835)

```
fn render_picker_from_view(view: &ListSelectionView, width: u16) -> String
```

**Purpose**: Renders an existing picker view into a string snapshot.

**Data flow**: Computes desired height, renders into a buffer, converts the buffer to text, and returns the string.

**Call relations**: Shared by picker rendering tests.

*Call graph*: calls 2 internal fn (desired_height, render); 3 external calls (empty, new, render_buffer).


##### `tests::fast_mode_action_filter`  (lines 837–841)

```
fn fast_mode_action_filter() -> KeymapActionFilter
```

**Purpose**: Builds a `KeymapActionFilter` with fast mode enabled for tests that need gated actions visible.

**Data flow**: Returns a `KeymapActionFilter { fast_mode_enabled: true }` value.

**Call relations**: Used by picker tests covering feature-gated actions.


##### `tests::render_buffer`  (lines 843–860)

```
fn render_buffer(buf: &Buffer) -> String
```

**Purpose**: Converts a `ratatui::Buffer` into a trimmed multiline string for assertions and snapshots.

**Data flow**: Iterates over every cell in the buffer area, concatenates symbols row by row, trims trailing spaces per line, joins lines with newlines, and returns the resulting string.

**Call relations**: Shared by capture, picker, and debug rendering tests.

*Call graph*: 1 external calls (area).


##### `tests::test_pane`  (lines 862–876)

```
fn test_pane() -> (BottomPane, AppEventSender, UnboundedReceiver<AppEvent>)
```

**Purpose**: Creates a fully wired `BottomPane` plus event channel for interaction tests.

**Data flow**: Creates an unbounded `AppEvent` channel, wraps the sender, constructs `BottomPane` with test parameters and a dummy frame requester, and returns `(pane, sender, receiver)`.

**Call relations**: Used by tests that simulate menu navigation and capture completion.

*Call graph*: calls 3 internal fn (new, new, test_dummy); 1 external calls (new).


##### `tests::selection_tab`  (lines 878–884)

```
fn selection_tab(params: &'a SelectionViewParams, id: &str) -> &'a SelectionTab
```

**Purpose**: Finds a tab by id inside `SelectionViewParams` during tests.

**Data flow**: Searches `params.tabs` for a matching `id` and returns a borrowed `SelectionTab`, panicking if absent.

**Call relations**: Shared helper for picker tests.


##### `tests::selection_item`  (lines 886–892)

```
fn selection_item(params: &'a SelectionViewParams, name: &str) -> &'a SelectionItem
```

**Purpose**: Finds a selection item by name inside `SelectionViewParams` during tests.

**Data flow**: Searches `params.items` for a matching `name` and returns a borrowed `SelectionItem`, panicking if absent.

**Call relations**: Used by action-menu tests.


##### `tests::action_menu_rows`  (lines 894–908)

```
fn action_menu_rows(params: &SelectionViewParams) -> String
```

**Purpose**: Formats action-menu items into a compact text representation for snapshot assertions.

**Data flow**: Maps each `SelectionItem` to `name | description | disabled_reason-or-enabled`, joins the rows with newlines, and returns the string.

**Call relations**: Used by the action-menu snapshot test.


##### `tests::picker_covers_every_replaceable_action`  (lines 911–937)

```
fn picker_covers_every_replaceable_action()
```

**Purpose**: Verifies the picker exposes every cataloged action and that each catalog entry is both writable in config and readable from runtime state.

**Data flow**: Builds a filtered picker, inspects the All tab, checks item counts and dismissal behavior, and asserts every `KEYMAP_ACTIONS` descriptor has both a `binding_slot` and `bindings_for_action` mapping.

**Call relations**: Cross-checks the picker against the action catalog and accessors.

*Call graph*: calls 2 internal fn (defaults, build_keymap_picker_params_with_filter); 5 external calls (assert!, assert_eq!, default, fast_mode_action_filter, selection_tab).


##### `tests::picker_hides_fast_mode_action_when_feature_is_disabled`  (lines 940–951)

```
fn picker_hides_fast_mode_action_when_feature_is_disabled()
```

**Purpose**: Ensures the fast-mode action is omitted when the feature filter is off.

**Data flow**: Builds the default picker and asserts the All tab contains no item named `Toggle Fast Mode`.

**Call relations**: Covers feature gating in picker construction.

*Call graph*: calls 2 internal fn (defaults, build_keymap_picker_params); 3 external calls (assert!, default, selection_tab).


##### `tests::picker_shows_fast_mode_action_when_feature_is_enabled`  (lines 954–973)

```
fn picker_shows_fast_mode_action_when_feature_is_enabled()
```

**Purpose**: Ensures the fast-mode action appears in all relevant tabs when the feature filter is enabled.

**Data flow**: Builds a filtered picker and checks the All, Common, App, and Unbound tabs for an item named `Toggle Fast Mode`.

**Call relations**: Another feature-gating picker test.

*Call graph*: calls 2 internal fn (defaults, build_keymap_picker_params_with_filter); 4 external calls (assert!, default, fast_mode_action_filter, selection_tab).


##### `tests::keymap_picker_fast_mode_enabled_snapshot`  (lines 976–988)

```
fn keymap_picker_fast_mode_enabled_snapshot()
```

**Purpose**: Captures a snapshot of the picker UI with fast mode enabled.

**Data flow**: Builds the filtered picker and renders it at width 120 for snapshot comparison.

**Call relations**: Regression coverage for picker presentation.

*Call graph*: calls 2 internal fn (defaults, build_keymap_picker_params_with_filter); 3 external calls (assert_snapshot!, default, fast_mode_action_filter).


##### `tests::picker_common_tab_lists_curated_actions`  (lines 991–1034)

```
fn picker_common_tab_lists_curated_actions()
```

**Purpose**: Checks the curated ordering and membership of the Common tab.

**Data flow**: Builds the picker, extracts the first two search-value tokens from each Common-tab item, and compares the resulting action list to the expected sequence.

**Call relations**: Guards the curated common-action subset.

*Call graph*: calls 2 internal fn (defaults, build_keymap_picker_params); 3 external calls (assert_eq!, default, selection_tab).


##### `tests::picker_approval_tab_lists_all_approval_actions`  (lines 1037–1068)

```
fn picker_approval_tab_lists_all_approval_actions()
```

**Purpose**: Checks that the Approval tab contains every approval action in the expected order.

**Data flow**: Builds the picker, extracts action identifiers from the Approval tab items, and compares them to the expected list.

**Call relations**: Covers context-tab grouping for approval actions.

*Call graph*: calls 2 internal fn (defaults, build_keymap_picker_params); 3 external calls (assert_eq!, default, selection_tab).


##### `tests::picker_content_snapshot`  (lines 1071–1094)

```
fn picker_content_snapshot()
```

**Purpose**: Captures a textual snapshot of tab counts and the first visible actions in the picker.

**Data flow**: Builds the picker, formats tab labels plus selectable counts and the first 12 All-tab rows into a string, and snapshots it.

**Call relations**: Broad regression coverage for picker content.

*Call graph*: calls 2 internal fn (defaults, build_keymap_picker_params); 3 external calls (assert_snapshot!, default, selection_tab).


##### `tests::picker_customized_tab_contains_root_overrides`  (lines 1097–1120)

```
fn picker_customized_tab_contains_root_overrides()
```

**Purpose**: Ensures the Customized tab reflects root-level overrides and that the corresponding context tab shows the overridden binding summary.

**Data flow**: Creates a config overriding `composer.submit`, resolves runtime state, builds the picker, and asserts the Customized tab contains only `Submit` while the Composer tab shows `ctrl-enter` in its description.

**Call relations**: Tests interaction between root config state and picker row summaries.

*Call graph*: calls 3 internal fn (from_config, keymap_with_replacement, build_keymap_picker_params); 4 external calls (assert!, assert_eq!, default, selection_tab).


##### `tests::picker_unbound_tab_lists_default_unbound_actions`  (lines 1123–1135)

```
fn picker_unbound_tab_lists_default_unbound_actions()
```

**Purpose**: Checks that actions with no active binding appear in the Unbound tab and remain selectable.

**Data flow**: Builds the default picker and asserts the Unbound tab contains `Toggle Vim Mode` and `Kill Whole Line`, both described as `unbound` and not disabled.

**Call relations**: Covers unbound-row classification in picker construction.

*Call graph*: calls 2 internal fn (defaults, build_keymap_picker_params); 4 external calls (assert!, assert_eq!, default, selection_tab).


##### `tests::picker_debug_tab_is_last_and_opens_inspector`  (lines 1138–1157)

```
fn picker_debug_tab_is_last_and_opens_inspector()
```

**Purpose**: Ensures the Debug tab is appended last and contains the inspector launcher row plus a tab-specific footer hint.

**Data flow**: Builds the picker, inspects the last tab and footer hints, and compares ids, labels, descriptions, and counts.

**Call relations**: Covers the special debug tab wiring.

*Call graph*: calls 2 internal fn (defaults, build_keymap_picker_params); 3 external calls (assert!, assert_eq!, default).


##### `tests::picker_selected_action_starts_on_matching_all_tab_row`  (lines 1160–1175)

```
fn picker_selected_action_starts_on_matching_all_tab_row()
```

**Purpose**: Checks that rebuilding the picker for a selected action restores focus to the matching row in the All tab.

**Data flow**: Builds picker params for `composer.submit`, inspects `initial_tab_id` and `initial_selected_idx`, and compares them to the matching row position.

**Call relations**: Supports the UX of returning to the edited row after save/clear.

*Call graph*: calls 2 internal fn (defaults, build_keymap_picker_params_for_selected_action); 3 external calls (assert_eq!, default, selection_tab).


##### `tests::picker_all_tab_items_remain_searchable`  (lines 1178–1198)

```
fn picker_all_tab_items_remain_searchable()
```

**Purpose**: Captures a snapshot proving All-tab rows include the expected search metadata and visible descriptions.

**Data flow**: Builds the picker, formats the first 12 All-tab items into `name | description | search_value` lines, and snapshots the result.

**Call relations**: Regression coverage for picker search indexing.

*Call graph*: calls 2 internal fn (defaults, build_keymap_picker_params); 3 external calls (assert_snapshot!, default, selection_tab).


##### `tests::picker_wide_render_snapshot`  (lines 1201–1206)

```
fn picker_wide_render_snapshot()
```

**Purpose**: Captures a wide-layout snapshot of the picker.

**Data flow**: Builds the picker and renders it at width 120 for snapshot comparison.

**Call relations**: Presentation regression test.

*Call graph*: calls 2 internal fn (defaults, build_keymap_picker_params); 2 external calls (assert_snapshot!, default).


##### `tests::picker_narrow_render_snapshot`  (lines 1209–1214)

```
fn picker_narrow_render_snapshot()
```

**Purpose**: Captures a narrow-layout snapshot of the picker.

**Data flow**: Builds the picker and renders it at width 78 for snapshot comparison.

**Call relations**: Presentation regression test for compact layouts.

*Call graph*: calls 2 internal fn (defaults, build_keymap_picker_params); 2 external calls (assert_snapshot!, default).


##### `tests::picker_custom_render_snapshot`  (lines 1217–1225)

```
fn picker_custom_render_snapshot()
```

**Purpose**: Captures a picker snapshot when a custom binding is present.

**Data flow**: Creates a customized keymap, resolves runtime state, builds the picker, renders it at width 120, and snapshots the output.

**Call relations**: Regression coverage for custom-binding indicators.

*Call graph*: calls 3 internal fn (from_config, keymap_with_replacement, build_keymap_picker_params); 2 external calls (assert_snapshot!, default).


##### `tests::picker_narrow_uses_compact_tabs`  (lines 1228–1238)

```
fn picker_narrow_uses_compact_tabs()
```

**Purpose**: Checks that narrow rendering uses the compact picker presentation rather than the wider detail-heavy layout.

**Data flow**: Builds and renders the picker at width 78, then asserts the output contains compact essentials and omits wider-detail phrases.

**Call relations**: Layout behavior test for narrow widths.

*Call graph*: calls 2 internal fn (defaults, build_keymap_picker_params); 3 external calls (assert!, default, render_picker).


##### `tests::action_menu_content_snapshot`  (lines 1241–1298)

```
fn action_menu_content_snapshot()
```

**Purpose**: Captures snapshots of action-menu variants for unbound, single-binding, multi-binding, and replace-one states.

**Data flow**: Builds several keymap/runtime combinations, constructs the corresponding action and replace menus, formats their rows with `action_menu_rows`, and snapshots the combined text.

**Call relations**: Regression coverage for adaptive action-menu construction.

*Call graph*: calls 5 internal fn (from_config, build_keymap_action_menu_params, build_keymap_replace_binding_menu_params, keymap_with_bindings, keymap_with_replacement); 3 external calls (assert_snapshot!, default, action_menu_rows).


##### `tests::action_menu_disables_clear_when_action_has_no_custom_binding`  (lines 1301–1332)

```
fn action_menu_disables_clear_when_action_has_no_custom_binding()
```

**Purpose**: Ensures the remove-custom-binding row is disabled when the action only inherits defaults, and checks dismissal behavior of menu rows.

**Data flow**: Builds the action menu for default `composer.submit`, finds specific rows, and asserts disabled reasons and `dismiss_on_select` flags.

**Call relations**: Covers menu-state logic tied to root config presence.

*Call graph*: calls 2 internal fn (defaults, build_keymap_action_menu_params); 4 external calls (assert!, assert_eq!, default, selection_item).


##### `tests::capture_view_snapshot`  (lines 1335–1349)

```
fn capture_view_snapshot()
```

**Purpose**: Captures a snapshot of the initial key-capture view.

**Data flow**: Constructs a `KeymapCaptureView`, renders it into a buffer, formats the buffer with `Debug`, and snapshots the result.

**Call relations**: Presentation regression test for capture UI.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert_snapshot!, app_event_sender).


##### `tests::debug_view_initial_snapshot`  (lines 1352–1359)

```
fn debug_view_initial_snapshot()
```

**Purpose**: Captures the initial state of the keypress inspector view.

**Data flow**: Builds a debug view from defaults, renders it, and snapshots the output.

**Call relations**: Regression coverage for the debug inspector UI.

*Call graph*: calls 2 internal fn (defaults, build_keymap_debug_view); 2 external calls (assert_snapshot!, default).


##### `tests::debug_view_shows_delayed_missing_key_hint`  (lines 1362–1369)

```
fn debug_view_shows_delayed_missing_key_hint()
```

**Purpose**: Checks that the inspector switches from the short hint to the delayed explanatory hint after enough time passes without a keypress.

**Data flow**: Builds a debug view, forces the delayed-hint state, renders it, asserts the hint text is present, and snapshots the output.

**Call relations**: Covers time-based hint behavior in the debug view.

*Call graph*: calls 2 internal fn (defaults, build_keymap_debug_view); 4 external calls (assert!, assert_snapshot!, default, render_debug).


##### `tests::debug_view_reports_detected_key_and_matching_actions`  (lines 1372–1381)

```
fn debug_view_reports_detected_key_and_matching_actions()
```

**Purpose**: Ensures the inspector reports a captured key and the actions currently assigned to it.

**Data flow**: Builds a debug view, forces delayed-hint eligibility, feeds it `Ctrl+O`, renders, asserts the waiting hint disappeared, and snapshots the report.

**Call relations**: Exercises debug matching against the runtime keymap.

*Call graph*: calls 2 internal fn (defaults, build_keymap_debug_view); 6 external calls (Char, new, assert!, assert_snapshot!, default, render_debug).


##### `tests::debug_view_uses_custom_binding_source`  (lines 1384–1395)

```
fn debug_view_uses_custom_binding_source()
```

**Purpose**: Checks that the inspector labels matches as `[Custom]` when the action has a root override.

**Data flow**: Creates a keymap overriding `global.copy`, resolves runtime state, feeds the inspector `Ctrl+X`, renders, and asserts the output names the action and source label.

**Call relations**: Covers debug binding-source classification.

*Call graph*: calls 3 internal fn (from_config, build_keymap_debug_view, keymap_with_replacement); 5 external calls (Char, new, assert!, default, render_debug).


##### `tests::debug_view_labels_custom_global_fallback_source`  (lines 1398–1409)

```
fn debug_view_labels_custom_global_fallback_source()
```

**Purpose**: Checks that composer actions inherited from custom global fallback are labeled `[Custom global]` in the inspector.

**Data flow**: Sets `global.queue`, resolves runtime state, feeds the inspector `Ctrl+Q`, renders, and asserts the output names `composer.queue` and the custom-global source label.

**Call relations**: Exercises the debug source logic for global fallback.

*Call graph*: calls 2 internal fn (from_config, build_keymap_debug_view); 7 external calls (Char, new, assert!, new, One, default, render_debug).


##### `tests::capture_completion_returns_to_selected_keymap_picker_row`  (lines 1412–1484)

```
fn capture_completion_returns_to_selected_keymap_picker_row()
```

**Purpose**: Simulates the full replace-all capture flow and verifies the UI returns to the refreshed picker focused on the edited action.

**Data flow**: Creates a test pane and event channel, opens picker and action menu, triggers capture, feeds a key event, reads the emitted `OpenKeymapCapture` and `KeymapCaptured` events, applies the replacement to config, rebuilds picker params for the selected action, replaces active views, and asserts focus and popup stack behavior.

**Call relations**: Integration-style test covering action menu, capture view, event emission, config editing, and picker restoration.

*Call graph*: calls 7 internal fn (defaults, from_config, build_keymap_action_menu_params, build_keymap_capture_view, keymap_with_replacement, build_keymap_picker_params, build_keymap_picker_params_for_selected_action); 8 external calls (new, Char, new, assert!, assert_eq!, default, panic!, test_pane).


##### `tests::clear_completion_returns_to_selected_keymap_picker_row`  (lines 1487–1544)

```
fn clear_completion_returns_to_selected_keymap_picker_row()
```

**Purpose**: Simulates clearing a custom binding and verifies the UI returns to the refreshed picker focused on the cleared action.

**Data flow**: Builds a customized keymap, opens picker and action menu, navigates to the clear row, triggers it, reads `AppEvent::KeymapCleared`, rebuilds picker params for the selected action using defaults, replaces active views, and asserts focus restoration and popup cleanup.

**Call relations**: Integration test for the clear-binding flow.

*Call graph*: calls 6 internal fn (defaults, from_config, build_keymap_action_menu_params, keymap_with_replacement, build_keymap_picker_params, build_keymap_picker_params_for_selected_action); 6 external calls (new, assert!, assert_eq!, default, panic!, test_pane).


##### `tests::replace_one_completion_drops_focused_keymap_submenus`  (lines 1547–1591)

```
fn replace_one_completion_drops_focused_keymap_submenus()
```

**Purpose**: Ensures that after a replace-one flow completes, both the replace submenu and its parent action menu are removed when returning to the picker.

**Data flow**: Opens picker, action menu, and replace-binding submenu, rebuilds picker params for the selected action, replaces the active view stack, and asserts only the picker remains active after dismissal.

**Call relations**: Covers submenu-stack cleanup behavior.

*Call graph*: calls 5 internal fn (defaults, build_keymap_action_menu_params, build_keymap_replace_binding_menu_params, build_keymap_picker_params, build_keymap_picker_params_for_selected_action); 5 external calls (new, assert!, assert_eq!, default, test_pane).


##### `tests::key_capture_serializes_modifier_order_for_config`  (lines 1594–1604)

```
fn key_capture_serializes_modifier_order_for_config()
```

**Purpose**: Checks that captured uppercase modified characters serialize in canonical modifier order and include implied shift.

**Data flow**: Creates a `KeyEvent` for uppercase `K` with CONTROL|ALT, converts it to a config key spec, and compares the result to `ctrl-alt-shift-k`.

**Call relations**: Exercises normalization and formatting in key capture serialization.

*Call graph*: 3 external calls (Char, new, assert_eq!).


##### `tests::key_capture_serializes_special_keys`  (lines 1607–1612)

```
fn key_capture_serializes_special_keys()
```

**Purpose**: Checks serialization of named non-character keys with modifiers.

**Data flow**: Converts `Shift+PageDown` to a config key spec and compares it to `shift-page-down`.

**Call relations**: Covers named-key serialization.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::key_capture_serializes_function_keys_through_f24`  (lines 1615–1628)

```
fn key_capture_serializes_function_keys_through_f24()
```

**Purpose**: Verifies serialization of supported function keys and rejection of unsupported ones.

**Data flow**: Converts `F13`, `F24`, and `F25` key events and compares the results to expected success or error strings.

**Call relations**: Covers function-key bounds in capture serialization.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::key_capture_serializes_c0_control_chars_as_ctrl_bindings`  (lines 1631–1653)

```
fn key_capture_serializes_c0_control_chars_as_ctrl_bindings()
```

**Purpose**: Checks that C0 control characters emitted by terminals normalize into canonical ctrl-letter bindings.

**Data flow**: Converts key events carrying `\u000a`, `\u0015`, and `\u0010` chars with no modifiers and compares them to `ctrl-j`, `ctrl-u`, and `ctrl-p`.

**Call relations**: Exercises `normalize_key_parts` integration in serialization.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::key_capture_serializes_minus_as_named_key`  (lines 1656–1672)

```
fn key_capture_serializes_minus_as_named_key()
```

**Purpose**: Verifies that the hyphen key is stored as the named `minus` token with modifiers in canonical order.

**Data flow**: Converts plain, alt, and ctrl-alt `-` key events and compares them to `minus`, `alt-minus`, and `ctrl-alt-minus`.

**Call relations**: Covers the serializer’s special-case handling for `-`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::replacement_sets_single_binding`  (lines 1675–1686)

```
fn replacement_sets_single_binding()
```

**Purpose**: Checks that replacing an action with one key writes `KeybindingsSpec::One` rather than a multi-binding list.

**Data flow**: Calls `keymap_with_replacement` for `composer.submit` and compares the resulting config slot to `Some(KeybindingsSpec::One(...))`.

**Call relations**: Tests low-level config writing shape.

*Call graph*: calls 1 internal fn (keymap_with_replacement); 2 external calls (assert_eq!, default).


##### `tests::replace_all_collapses_multi_binding_to_single`  (lines 1689–1723)

```
fn replace_all_collapses_multi_binding_to_single()
```

**Purpose**: Ensures `ReplaceAll` on a multi-binding action produces a single binding in both the returned binding list and config shape.

**Data flow**: Builds a multi-binding config and runtime map, applies `keymap_with_edit` with `ReplaceAll`, destructures the `Updated` outcome, and compares both `bindings` and the resulting config slot.

**Call relations**: Covers replace-all edit semantics.

*Call graph*: calls 3 internal fn (from_config, keymap_with_bindings, keymap_with_edit); 3 external calls (assert_eq!, default, panic!).


##### `tests::add_alternate_grows_single_binding`  (lines 1726–1754)

```
fn add_alternate_grows_single_binding()
```

**Purpose**: Checks that adding an alternate to a single-binding action materializes both the existing effective binding and the new one into root config.

**Data flow**: Starts from defaults, applies `AddAlternate` to `composer.submit`, destructures the `Updated` outcome, and compares the returned binding list and config slot to the expected two-entry `Many` list.

**Call relations**: Exercises add-alternate behavior against inherited defaults.

*Call graph*: calls 2 internal fn (defaults, keymap_with_edit); 3 external calls (assert_eq!, default, panic!).


##### `tests::add_alternate_grows_default_multi_binding`  (lines 1757–1786)

```
fn add_alternate_grows_default_multi_binding()
```

**Purpose**: Checks that adding an alternate to an action with multiple default bindings preserves all effective defaults before appending the new key.

**Data flow**: Starts from defaults, applies `AddAlternate` to `editor.move_left`, and compares the resulting binding list and config slot to the expected three-entry list.

**Call relations**: Covers add-alternate behavior for default multi-binding actions.

*Call graph*: calls 2 internal fn (defaults, keymap_with_edit); 3 external calls (assert_eq!, default, panic!).


##### `tests::add_alternate_duplicate_is_noop`  (lines 1789–1807)

```
fn add_alternate_duplicate_is_noop()
```

**Purpose**: Ensures adding an already-present binding returns `Unchanged` instead of rewriting config.

**Data flow**: Applies `AddAlternate` with `enter` to default `composer.submit` and compares the outcome to the expected `Unchanged` variant and message.

**Call relations**: Covers no-op detection in `keymap_with_edit`.

*Call graph*: calls 2 internal fn (defaults, keymap_with_edit); 2 external calls (assert_eq!, default).


##### `tests::replace_one_preserves_other_bindings`  (lines 1810–1847)

```
fn replace_one_preserves_other_bindings()
```

**Purpose**: Checks that replacing one binding in a multi-binding action leaves the other bindings untouched.

**Data flow**: Builds a two-binding config and runtime map, applies `ReplaceOne` for `ctrl-enter`, destructures the `Updated` outcome, and compares the resulting binding list and config slot.

**Call relations**: Covers replace-one semantics.

*Call graph*: calls 3 internal fn (from_config, keymap_with_bindings, keymap_with_edit); 3 external calls (assert_eq!, default, panic!).


##### `tests::replace_one_deduplicates_replacement`  (lines 1850–1886)

```
fn replace_one_deduplicates_replacement()
```

**Purpose**: Ensures replace-one collapses duplicates when the replacement key already exists elsewhere in the binding list.

**Data flow**: Builds a two-binding config where the replacement already exists, applies `ReplaceOne`, and asserts the result is a single-binding config and one-entry binding list.

**Call relations**: Exercises `dedup_bindings` through replace-one.

*Call graph*: calls 3 internal fn (from_config, keymap_with_bindings, keymap_with_edit); 3 external calls (assert_eq!, default, panic!).


##### `tests::replace_one_rejects_stale_old_key`  (lines 1889–1905)

```
fn replace_one_rejects_stale_old_key()
```

**Purpose**: Checks that replace-one fails if the selected old binding is no longer active by the time the edit is applied.

**Data flow**: Starts from defaults, applies `ReplaceOne { old_key: "alt-enter" }` to `composer.submit`, expects an error, and asserts the message mentions both the action and stale key.

**Call relations**: Covers stale-menu protection in `keymap_with_edit`.

*Call graph*: calls 2 internal fn (defaults, keymap_with_edit); 2 external calls (assert!, default).


##### `tests::clear_removes_custom_binding`  (lines 1908–1923)

```
fn clear_removes_custom_binding()
```

**Purpose**: Verifies that clearing a custom binding sets the root config slot back to `None` and updates `has_custom_binding` accordingly.

**Data flow**: Creates a customized keymap, checks `has_custom_binding == true`, clears the binding with `keymap_without_custom_binding`, then asserts the slot is `None` and `has_custom_binding == false`.

**Call relations**: Tests the clear-binding mutation path.

*Call graph*: calls 2 internal fn (keymap_with_replacement, keymap_without_custom_binding); 2 external calls (assert_eq!, default).


##### `tests::replacement_rejects_unknown_action`  (lines 1926–1931)

```
fn replacement_rejects_unknown_action()
```

**Purpose**: Ensures attempts to edit an unknown context/action pair fail with a stale-selection style error.

**Data flow**: Calls `keymap_with_replacement` for `composer.nope`, expects an error, and asserts the message mentions the unknown action path.

**Call relations**: Covers unknown-action handling via `binding_slot` lookup failure.

*Call graph*: calls 1 internal fn (keymap_with_replacement); 2 external calls (assert!, default).


### `tui/src/keymap_setup/debug.rs`

`orchestration` · `interactive `/keymap` debug inspector session`

This module defines `KeymapDebugView`, a bottom-pane inspector backed by a cloned `RuntimeKeymap` and `TuiKeymap`. Its state is intentionally small: `opened_at` tracks when the inspector started, `last_report` stores the most recent inspected keypress as a `KeymapDebugReport`, and `complete` marks Ctrl+C dismissal. The report captures four concrete pieces of data: the normalized `KeyBinding` detected from the event, the canonical config key string or serialization error, a raw debug summary of the original `KeyEvent`, and the list of matching actions returned by `actions::matching_actions_for_key_event`.

Rendering is line-oriented. `lines_at` builds a title, instructions, and either a short or delayed hint depending on how long the view has been waiting without any keypress. Once a key is captured, it renders the detected display label, the config key or wrapped unsupported-key error, the raw event summary, and a wrapped list of assigned actions including their source labels (`Custom`, `Custom global`, or `Default`). `push_wrapped_dim` centralizes wrapped dim styling for long explanatory lines.

Input handling is simple and diagnostic-focused: release events are ignored, all other keypresses—including `Esc`—are inspected rather than dismissed, and Ctrl+C is the explicit exit path. `next_frame_delay` requests a redraw exactly when the delayed hint should appear, so the waiting message upgrades automatically without user input.

#### Function details

##### `build_keymap_debug_view`  (lines 44–55)

```
fn build_keymap_debug_view(
    runtime_keymap: &RuntimeKeymap,
    keymap_config: &TuiKeymap,
) -> KeymapDebugView
```

**Purpose**: Constructs a fresh keypress inspector view from the current runtime keymap and root config snapshot.

**Data flow**: Clones the provided `RuntimeKeymap` and `TuiKeymap`, records `Instant::now()` as `opened_at`, initializes `last_report` to `None` and `complete` to `false`, and returns the new `KeymapDebugView`.

**Call relations**: Opened from the picker’s Debug tab and used directly by debug-view tests.

*Call graph*: called by 5 (debug_view_initial_snapshot, debug_view_labels_custom_global_fallback_source, debug_view_reports_detected_key_and_matching_actions, debug_view_shows_delayed_missing_key_hint, debug_view_uses_custom_binding_source); 3 external calls (now, clone, clone).


##### `KeymapDebugView::lines`  (lines 58–60)

```
fn lines(&self, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Builds the current rendered lines using the real current time.

**Data flow**: Calls `lines_at(width, Instant::now())` and returns the resulting `Vec<Line<'static>>`.

**Call relations**: Shared by `render` and `desired_height`.

*Call graph*: calls 1 internal fn (lines_at); called by 2 (desired_height, render); 1 external calls (now).


##### `KeymapDebugView::lines_at`  (lines 62–130)

```
fn lines_at(&self, width: u16, now: Instant) -> Vec<Line<'static>>
```

**Purpose**: Builds the full textual report for the inspector at a specific instant, including waiting hints, captured key details, and matching actions.

**Data flow**: Computes wrap width, creates title and instruction lines, chooses either `SHORT_MISSING_KEY_HINT` or `DELAYED_MISSING_KEY_HINT` via `should_show_delayed_hint`, wraps that hint with `push_wrapped_dim`, and then either renders a waiting message when `last_report` is `None` or renders detected key, config key or wrapped error, raw event summary, and wrapped matched-action lines from `last_report`.

**Call relations**: This is the core rendering routine behind the inspector UI.

*Call graph*: calls 2 internal fn (should_show_delayed_hint, push_wrapped_dim); called by 1 (lines); 4 external calls (from, format!, from, vec!).


##### `KeymapDebugView::should_show_delayed_hint`  (lines 132–134)

```
fn should_show_delayed_hint(&self, now: Instant) -> bool
```

**Purpose**: Determines whether the longer explanatory hint should replace the short waiting hint.

**Data flow**: Returns `true` only when `last_report` is still `None` and `now.duration_since(opened_at)` is at least `MISSING_KEY_HINT_DELAY`.

**Call relations**: Used by `lines_at` and mirrored by `next_frame_delay` scheduling.

*Call graph*: called by 1 (lines_at); 1 external calls (duration_since).


##### `KeymapDebugView::show_delayed_hint_for_test`  (lines 137–139)

```
fn show_delayed_hint_for_test(&mut self)
```

**Purpose**: Test-only helper that forces the view into the delayed-hint state without waiting in real time.

**Data flow**: Sets `opened_at` to `Instant::now() - MISSING_KEY_HINT_DELAY`.

**Call relations**: Used by tests that snapshot the delayed hint.

*Call graph*: 1 external calls (now).


##### `KeymapDebugView::render`  (lines 143–145)

```
fn render(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Renders the inspector view into the bottom-pane buffer.

**Data flow**: Builds the current lines with `self.lines(area.width)` and renders them through a `Paragraph` into the provided `Buffer` and `Rect`.

**Call relations**: Implements the `Renderable` trait for the inspector.

*Call graph*: calls 1 internal fn (lines); called by 1 (render_debug); 1 external calls (new).


##### `KeymapDebugView::desired_height`  (lines 147–149)

```
fn desired_height(&self, width: u16) -> u16
```

**Purpose**: Reports how many terminal rows the inspector needs at a given width.

**Data flow**: Calls `self.lines(width)`, takes the vector length, and returns it as `u16`.

**Call relations**: Used by layout code and rendering tests.

*Call graph*: calls 1 internal fn (lines); called by 1 (render_debug).


##### `KeymapDebugView::handle_key_event`  (lines 153–168)

```
fn handle_key_event(&mut self, key_event: KeyEvent)
```

**Purpose**: Captures one inspected keypress and stores a full debug report for rendering. It ignores release events and inspects all press events, including Esc.

**Data flow**: Reads a `KeyEvent`; returns immediately on `KeyEventKind::Release`; otherwise builds a `KeymapDebugReport` containing `KeyBinding::from_event(key_event)`, `key_event_to_config_key_spec(key_event)`, `key_event_debug_summary(key_event)`, and `matching_actions_for_key_event(&runtime_keymap, &keymap_config, key_event)`, then stores it in `last_report`.

**Call relations**: Called by the bottom-pane event loop while the inspector is active.

*Call graph*: calls 3 internal fn (from_event, matching_actions_for_key_event, key_event_debug_summary); 1 external calls (key_event_to_config_key_spec).


##### `KeymapDebugView::is_complete`  (lines 170–172)

```
fn is_complete(&self) -> bool
```

**Purpose**: Reports whether the inspector should be dismissed.

**Data flow**: Returns the `complete` flag.

**Call relations**: Queried by the bottom-pane framework.


##### `KeymapDebugView::on_ctrl_c`  (lines 174–177)

```
fn on_ctrl_c(&mut self) -> CancellationEvent
```

**Purpose**: Handles Ctrl+C as the explicit exit path for the inspector.

**Data flow**: Sets `complete = true` and returns `CancellationEvent::Handled`.

**Call relations**: Implements the `BottomPaneView` cancellation hook.


##### `KeymapDebugView::prefer_esc_to_handle_key_event`  (lines 179–181)

```
fn prefer_esc_to_handle_key_event(&self) -> bool
```

**Purpose**: Requests that Esc be delivered to the inspector as an inspected key rather than dismissing the popup.

**Data flow**: Returns `true` with no side effects.

**Call relations**: Allows the inspector to debug Esc itself.


##### `KeymapDebugView::next_frame_delay`  (lines 183–192)

```
fn next_frame_delay(&self) -> Option<Duration>
```

**Purpose**: Schedules a redraw exactly when the delayed waiting hint should appear, but only while no key has been inspected yet.

**Data flow**: If `last_report` is already present, returns `None`; otherwise computes `opened_at + MISSING_KEY_HINT_DELAY`, subtracts `Instant::now()`, filters out zero delays, and returns the remaining `Duration` if any.

**Call relations**: Used by the bottom-pane framework to refresh the inspector without user input.

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

**Purpose**: Wraps a long string into one or more dim-styled `Line`s with configurable initial and subsequent indentation.

**Data flow**: Builds `textwrap::Options` from the provided width and indents, wraps the text, converts each wrapped segment into a dim `Line<'static>`, and appends them to the mutable output vector.

**Call relations**: Used by `lines_at` for hints, raw-event summaries, unsupported-key messages, and matched-action descriptions.

*Call graph*: called by 1 (lines_at); 2 external calls (new, wrap).


##### `key_event_debug_summary`  (lines 212–219)

```
fn key_event_debug_summary(key_event: KeyEvent) -> String
```

**Purpose**: Formats a raw `KeyEvent` into a concise debug string showing code, modifiers, and kind.

**Data flow**: Reads `key_event.code`, formats modifiers through `key_modifiers_debug_label`, includes `key_event.kind`, and returns the assembled `String`.

**Call relations**: Stored in `KeymapDebugReport` by `handle_key_event`.

*Call graph*: called by 1 (handle_key_event); 1 external calls (format!).


##### `key_modifiers_debug_label`  (lines 221–243)

```
fn key_modifiers_debug_label(modifiers: KeyModifiers) -> String
```

**Purpose**: Formats a `KeyModifiers` bitset into a human-readable debug label, preserving unknown modifier bits when present.

**Data flow**: Returns `"none"` for an empty set; otherwise appends `ctrl`, `alt`, and `shift` labels for known bits, computes any remaining bits with `difference`, appends their debug representation if non-empty, joins parts with `|`, and returns the string.

**Call relations**: Used by `key_event_debug_summary` to make raw event output readable.

*Call graph*: 5 external calls (contains, difference, is_empty, new, format!).


### `tui/src/keymap_setup/actions.rs`

`domain_logic` · `used whenever `/keymap` builds menus, edits config, or inspects key matches`

This file is the authoritative inventory of editable shortcuts. `KeymapActionDescriptor` stores the stable config `context` and `action` segments, a human-facing `context_label`, a short description, and an optional feature gate. The large `KEYMAP_ACTIONS` constant enumerates every action exposed by `/keymap`, including app/global, chat, composer, editor, Vim, pager, list, and approval actions. The small `action` and `gated_action` constructors keep that table concise, while `KeymapActionFilter` and `KeymapActionDescriptor::is_visible` hide gated entries such as `toggle_fast_mode` unless the relevant feature is enabled.

Two long match-based accessors keep the catalog aligned with actual data structures. `binding_slot` maps `(context, action)` to the mutable `Option<KeybindingsSpec>` field inside `TuiKeymap`, preserving the distinction between `None` (inherit), `Some(One/Many)` (custom binding), and `Some(Many([]))` (explicit unbind). `bindings_for_action` maps the same identifiers to the resolved `&[KeyBinding]` slice inside `RuntimeKeymap`, so UI code always displays effective bindings after fallback and validation.

The file also provides `action_label`, which turns stable snake_case action names into title-cased UI labels without changing the underlying identifiers, and `format_binding_summary`, which converts runtime bindings back into canonical config strings while de-duplicating normalized equivalents. For the debug inspector, `matching_actions_for_key_event` finds all descriptors whose runtime bindings match a `KeyEvent`, and `debug_binding_source` classifies each match as `Custom`, `CustomGlobal`, or `Default` by inspecting root config and composer global-fallback slots.

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

**Purpose**: Builds a non-gated `KeymapActionDescriptor` constant entry.

**Data flow**: Takes static context, context label, action name, and description strings and returns a `KeymapActionDescriptor` with `required_feature: None`.

**Call relations**: Used only in the `KEYMAP_ACTIONS` constant to define always-visible actions.


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

**Purpose**: Builds a feature-gated `KeymapActionDescriptor` constant entry.

**Data flow**: Takes the same descriptor fields as `action` plus a `KeymapActionFeature`, and returns a descriptor with `required_feature: Some(feature)`.

**Call relations**: Used in `KEYMAP_ACTIONS` for actions like fast mode that should only appear when enabled.


##### `KeymapActionDescriptor::is_visible`  (lines 79–84)

```
fn is_visible(self, filter: KeymapActionFilter) -> bool
```

**Purpose**: Determines whether a catalog entry should be shown under the current feature filter.

**Data flow**: Reads `self.required_feature` and the provided `KeymapActionFilter`; returns `true` for ungated actions and checks `filter.fast_mode_enabled` for `FastMode`-gated entries.

**Call relations**: Called by picker construction when filtering `KEYMAP_ACTIONS` into visible rows.


##### `action_label`  (lines 205–217)

```
fn action_label(action: &str) -> String
```

**Purpose**: Converts a stable snake_case action identifier into a title-cased display label for menus and headers.

**Data flow**: Splits the input string on underscores, uppercases the first character of each segment, concatenates the untouched remainder, joins the words with spaces, and returns the resulting `String`.

**Call relations**: Used by action menus, capture views, replace-binding menus, and debug matches for presentation only.

*Call graph*: called by 3 (build_keymap_action_menu_params, build_keymap_capture_view, build_keymap_replace_binding_menu_params).


##### `binding_slot`  (lines 226–343)

```
fn binding_slot(
    keymap: &'a mut TuiKeymap,
    context: &str,
    action: &str,
) -> Option<&'a mut Option<KeybindingsSpec>>
```

**Purpose**: Maps a catalog `(context, action)` pair to the mutable root-config slot that stores that action’s override in `TuiKeymap`.

**Data flow**: Pattern-matches on the provided context and action strings and returns `Some(&mut Option<KeybindingsSpec>)` for known actions or `None` for unknown pairs.

**Call relations**: This is the write-side bridge used by keymap editing, custom-binding checks, and debug source classification.

*Call graph*: called by 4 (debug_binding_source, has_custom_binding, keymap_with_bindings, keymap_without_custom_binding).


##### `bindings_for_action`  (lines 351–468)

```
fn bindings_for_action(
    runtime_keymap: &'a RuntimeKeymap,
    context: &str,
    action: &str,
) -> Option<&'a [KeyBinding]>
```

**Purpose**: Maps a catalog `(context, action)` pair to the resolved runtime binding slice for that action.

**Data flow**: Pattern-matches on the provided context and action strings and returns `Some(&[KeyBinding])` borrowed from the appropriate field inside `RuntimeKeymap`, or `None` for unknown pairs.

**Call relations**: This is the read-side bridge used by picker rows, action menus, capture views, and debug matching.

*Call graph*: called by 2 (active_binding_specs, build_keymap_capture_view).


##### `format_binding_summary`  (lines 475–487)

```
fn format_binding_summary(bindings: &[KeyBinding]) -> String
```

**Purpose**: Formats a runtime binding slice into a compact comma-separated summary suitable for menus. It hides duplicate normalized variants so compatibility aliases do not look like separate user choices.

**Data flow**: Iterates over the input bindings, converts each to a canonical config string with `super::binding_to_config_key_spec`, inserts unseen strings into a `BTreeSet`, collects them into a vector, and returns either `"unbound"` or the joined summary string.

**Call relations**: Used by picker rows and capture-view headers to display effective bindings.

*Call graph*: called by 1 (build_keymap_capture_view); 2 external calls (new, iter).


##### `KeymapDebugBindingSource::label`  (lines 497–503)

```
fn label(&self) -> &'static str
```

**Purpose**: Returns the short UI label for a debug binding source classification.

**Data flow**: Matches `self` and returns one of the static strings `Custom`, `Custom global`, or `Default`.

**Call relations**: Used by the debug inspector when rendering matched actions.


##### `matching_actions_for_key_event`  (lines 515–537)

```
fn matching_actions_for_key_event(
    runtime_keymap: &RuntimeKeymap,
    keymap_config: &TuiKeymap,
    event: KeyEvent,
) -> Vec<KeymapDebugActionMatch>
```

**Purpose**: Finds every cataloged action whose resolved runtime bindings match a captured `KeyEvent`, and annotates each match with display metadata and source classification.

**Data flow**: Iterates over `KEYMAP_ACTIONS`, looks up each action’s runtime bindings with `bindings_for_action`, checks whether any binding reports `is_press(event)`, and collects matching descriptors into `KeymapDebugActionMatch` values containing context, action, label, description, and `debug_binding_source(...)`.

**Call relations**: Called by the debug inspector view whenever the user presses a key to inspect.

*Call graph*: called by 1 (handle_key_event).


##### `debug_binding_source`  (lines 539–559)

```
fn debug_binding_source(
    keymap_config: &TuiKeymap,
    descriptor: &KeymapActionDescriptor,
) -> KeymapDebugBindingSource
```

**Purpose**: Classifies where a matched runtime binding came from: a direct custom override, a composer global fallback override, or the built-in defaults.

**Data flow**: Clones the `TuiKeymap`, looks up the direct slot with `binding_slot`, returns `Custom` if that slot is `Some`, otherwise checks `global_fallback_slot` for composer actions and returns `CustomGlobal` if present, falling back to `Default` in all other cases.

**Call relations**: Used by `matching_actions_for_key_event` to enrich debug matches with source labels.

*Call graph*: calls 2 internal fn (binding_slot, global_fallback_slot); 1 external calls (clone).


##### `global_fallback_slot`  (lines 561–575)

```
fn global_fallback_slot(
    keymap: &'a mut TuiKeymap,
    descriptor: &KeymapActionDescriptor,
) -> Option<&'a mut Option<KeybindingsSpec>>
```

**Purpose**: Returns the relevant global fallback config slot for composer actions that support global reuse.

**Data flow**: Checks whether the descriptor context is `composer`; if so, matches the action name and returns the corresponding mutable `keymap.global.submit`, `queue`, or `toggle_shortcuts` slot, otherwise returns `None`.

**Call relations**: Used only by `debug_binding_source` to distinguish direct custom bindings from inherited custom-global ones.

*Call graph*: called by 1 (debug_binding_source).


### `tui/src/keymap_setup/picker.rs`

`orchestration` · `interactive `/keymap` picker display and refresh`

This module turns the action catalog plus current runtime/config state into `SelectionViewParams` for the main `/keymap` picker. The internal `KeymapActionRow` stores the normalized row data needed for display: stable context/action identifiers, human-facing labels, the short description, a formatted binding summary, and whether the action has a root-level custom override. `build_keymap_rows` derives those rows by filtering `KEYMAP_ACTIONS` through `KeymapActionFilter`, reading effective bindings from `RuntimeKeymap` via `bindings_for_action`, formatting them with `format_binding_summary`, and checking root overrides with `has_custom_binding`.

`build_keymap_picker_params_for_action` is the main assembler. It computes counts for total, customized, and unbound actions; optionally finds the selected row index for focus restoration; calculates a name-column width using Unicode display width; and then builds a tab set. Tabs include All, Common (a curated subset from `KEYMAP_COMMON_ACTIONS`), Customized, Unbound, several context-group tabs from `KEYMAP_CONTEXT_TABS`, and a final Debug tab that launches the keypress inspector. Empty tabs get a disabled placeholder row instead of an empty list.

Each action row becomes a `SelectionItem` with a prefixed context label and indicator: `*` in accent style for custom bindings, `-` dimmed for unbound actions, and blank otherwise. The row’s action sends `AppEvent::OpenKeymapActionMenu { context, action }`, keeping the picker open underneath. Footer hints explain tab switching, editing, and the meaning of the custom/unbound indicators.

#### Function details

##### `KeymapActionRow::is_unbound`  (lines 49–51)

```
fn is_unbound(&self) -> bool
```

**Purpose**: Reports whether a picker row currently has no active binding.

**Data flow**: Compares `self.binding_summary` to the literal string `"unbound"` and returns the resulting boolean.

**Call relations**: Used when building row prefixes and unbound-tab membership.

*Call graph*: called by 1 (keymap_row_prefix).


##### `build_keymap_picker_params`  (lines 125–134)

```
fn build_keymap_picker_params(
    runtime_keymap: &RuntimeKeymap,
    keymap_config: &TuiKeymap,
) -> SelectionViewParams
```

**Purpose**: Builds the default picker params with no feature gates enabled.

**Data flow**: Delegates to `build_keymap_picker_params_with_filter` using `KeymapActionFilter::default()` and returns the resulting `SelectionViewParams`.

**Call relations**: Used by most picker call sites and tests when fast-mode gating is not needed.

*Call graph*: calls 1 internal fn (build_keymap_picker_params_with_filter); called by 15 (capture_completion_returns_to_selected_keymap_picker_row, clear_completion_returns_to_selected_keymap_picker_row, picker_all_tab_items_remain_searchable, picker_approval_tab_lists_all_approval_actions, picker_common_tab_lists_curated_actions, picker_content_snapshot, picker_custom_render_snapshot, picker_customized_tab_contains_root_overrides, picker_debug_tab_is_last_and_opens_inspector, picker_hides_fast_mode_action_when_feature_is_disabled (+5 more)); 1 external calls (default).


##### `build_keymap_picker_params_with_filter`  (lines 136–147)

```
fn build_keymap_picker_params_with_filter(
    runtime_keymap: &RuntimeKeymap,
    keymap_config: &TuiKeymap,
    action_filter: KeymapActionFilter,
) -> SelectionViewParams
```

**Purpose**: Builds picker params using an explicit action-visibility filter.

**Data flow**: Passes the runtime keymap, root config, filter, and no selected action into `build_keymap_picker_params_for_action` and returns the result.

**Call relations**: Used when the caller needs feature-gated actions like fast mode to appear.

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

**Purpose**: Builds picker params that restore focus to a specific action using the default feature filter.

**Data flow**: Delegates to `build_keymap_picker_params_for_selected_action_with_filter` with `KeymapActionFilter::default()` and the provided context/action.

**Call relations**: Used after successful edits or clears so the picker reopens focused on the edited row.

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

**Purpose**: Builds picker params that restore focus to a specific action under an explicit feature filter.

**Data flow**: Calls `build_keymap_picker_params_for_action` with `Some((context, action))` as the selected action and returns the resulting params.

**Call relations**: Used by focus-restoration flows when feature-gated actions may be visible.

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

**Purpose**: Assembles the full tabbed `/keymap` picker view from current runtime/config state. It computes row data, tab contents, counts, search metadata, and initial selection.

**Data flow**: Builds all visible rows with `build_keymap_rows`, computes total/custom/unbound counts and optional selected-row index, derives `name_column_width` from Unicode widths, constructs All, Common, Customized, Unbound, context-group, and Debug tabs using `keymap_header`, `keymap_selection_items`, `keymap_common_rows`, `action_count_line`, and `keymap_debug_tab`, then returns a populated `SelectionViewParams` with search enabled and footer hints configured.

**Call relations**: This is the central picker-construction routine used by all public picker builders.

*Call graph*: calls 7 internal fn (action_count_line, build_keymap_rows, keymap_common_rows, keymap_debug_tab, keymap_header, keymap_picker_hint_line, keymap_selection_items); called by 2 (build_keymap_picker_params_for_selected_action_with_filter, build_keymap_picker_params_with_filter); 5 external calls (new, default, new, format!, vec!).


##### `keymap_debug_tab`  (lines 302–327)

```
fn keymap_debug_tab() -> SelectionTab
```

**Purpose**: Builds the special Debug tab that launches the keypress inspector instead of editing a specific action.

**Data flow**: Constructs a `SelectionTab` with a header from `keymap_header` and a single `SelectionItem` whose callback sends `AppEvent::OpenKeymapDebug`, plus a search string describing the inspector.

**Call relations**: Appended by `build_keymap_picker_params_for_action` as the final tab.

*Call graph*: calls 1 internal fn (keymap_header); called by 1 (build_keymap_picker_params_for_action); 1 external calls (vec!).


##### `build_keymap_rows`  (lines 329–358)

```
fn build_keymap_rows(
    runtime_keymap: &RuntimeKeymap,
    keymap_config: &TuiKeymap,
    action_filter: KeymapActionFilter,
) -> Vec<KeymapActionRow>
```

**Purpose**: Normalizes the visible action catalog into picker row data with effective binding summaries and custom-binding flags.

**Data flow**: Iterates over `KEYMAP_ACTIONS`, filters descriptors with `descriptor.is_visible(action_filter)`, reads runtime bindings with `bindings_for_action`, formats them with `format_binding_summary`, checks root overrides with `has_custom_binding`, and collects `KeymapActionRow` values.

**Call relations**: Used only by the main picker builder as the source row set for all tabs.

*Call graph*: called by 1 (build_keymap_picker_params_for_action).


##### `keymap_common_rows`  (lines 360–368)

```
fn keymap_common_rows(rows: &[KeymapActionRow]) -> Vec<&KeymapActionRow>
```

**Purpose**: Extracts the curated Common-tab subset from the full row list while preserving the explicit order defined in `KEYMAP_COMMON_ACTIONS`.

**Data flow**: Iterates over the `(context, action)` pairs in `KEYMAP_COMMON_ACTIONS`, finds the matching row in the provided slice for each pair, and collects the found row references.

**Call relations**: Used by `build_keymap_picker_params_for_action` when constructing the Common tab.

*Call graph*: called by 1 (build_keymap_picker_params_for_action).


##### `keymap_selection_items`  (lines 370–389)

```
fn keymap_selection_items(
    rows: impl IntoIterator<Item = &'a KeymapActionRow>,
    empty_name: &str,
    empty_description: &str,
) -> Vec<SelectionItem>
```

**Purpose**: Converts a row iterator into picker `SelectionItem`s, or emits a disabled placeholder row when the iterator is empty.

**Data flow**: Maps each input row through `keymap_selection_item` into a vector; if the vector is empty, returns a one-item disabled placeholder list using the provided empty-state texts.

**Call relations**: Used for every picker tab so empty tabs still render explanatory content.

*Call graph*: called by 1 (build_keymap_picker_params_for_action); 2 external calls (into_iter, vec!).


##### `keymap_selection_item`  (lines 391–417)

```
fn keymap_selection_item(row: &KeymapActionRow) -> SelectionItem
```

**Purpose**: Builds one picker row item for a configurable action, including its prefix, binding summary, search text, and action-menu callback.

**Data flow**: Copies the row’s context and action into owned strings for closure capture, derives a source label (`Custom` or `Default`), builds a searchable text blob from context/action/label/description/binding/source, constructs prefix spans with `keymap_row_prefix`, and returns a `SelectionItem` whose callback sends `AppEvent::OpenKeymapActionMenu { context, action }`.

**Call relations**: Used by `keymap_selection_items` for all non-placeholder picker rows.

*Call graph*: calls 1 internal fn (keymap_row_prefix); 3 external calls (default, format!, vec!).


##### `keymap_row_prefix`  (lines 419–438)

```
fn keymap_row_prefix(row: &KeymapActionRow) -> Vec<Span<'static>>
```

**Purpose**: Builds the left-side prefix shown before each picker row name: padded context label plus a custom/unbound indicator.

**Data flow**: Chooses an indicator span based on `row.custom_binding` and `row.is_unbound()`, formats the context label to `KEYMAP_CONTEXT_LABEL_WIDTH`, dims the label and spacing, and returns the resulting `Vec<Span<'static>>`.

**Call relations**: Used by `keymap_selection_item` to visually encode row state.

*Call graph*: calls 2 internal fn (is_unbound, accent_style); called by 1 (keymap_selection_item); 1 external calls (vec!).


##### `keymap_header`  (lines 440–446)

```
fn keymap_header(description: String, summary: String) -> Box<dyn Renderable>
```

**Purpose**: Builds a standard three-line header block for picker tabs.

**Data flow**: Creates a `ColumnRenderable`, pushes a bold `Keymap` title plus dimmed description and summary lines, boxes it as `Box<dyn Renderable>`, and returns it.

**Call relations**: Used by all picker tabs, including the Debug tab.

*Call graph*: calls 1 internal fn (new); called by 2 (build_keymap_picker_params_for_action, keymap_debug_tab); 2 external calls (new, from).


##### `action_count_line`  (lines 448–453)

```
fn action_count_line(count: usize) -> String
```

**Purpose**: Formats a singular or plural action-count summary for tab headers.

**Data flow**: Matches the provided count and returns either `"1 action."` or `"{count} actions."`.

**Call relations**: Used by the main picker builder for Common, Customized, Unbound, and context-group tab summaries.

*Call graph*: called by 1 (build_keymap_picker_params_for_action); 1 external calls (format!).


##### `keymap_picker_hint_line`  (lines 455–469)

```
fn keymap_picker_hint_line() -> Line<'static>
```

**Purpose**: Builds the standard footer hint line for the main picker, including tab navigation, edit action, and indicator legend.

**Data flow**: Uses `accent_style()` to style key tokens, assembles the hint fragments into a `Line<'static>`, and returns it.

**Call relations**: Attached to the picker by `build_keymap_picker_params_for_action`.

*Call graph*: calls 1 internal fn (accent_style); called by 1 (build_keymap_picker_params_for_action); 2 external calls (from, vec!).


##### `keymap_debug_hint_line`  (lines 471–479)

```
fn keymap_debug_hint_line() -> Line<'static>
```

**Purpose**: Builds the footer hint line shown specifically on the Debug tab.

**Data flow**: Uses `accent_style()` to style Enter and Esc tokens, assembles the fragments into a `Line<'static>`, and returns it.

**Call relations**: Registered as a tab-specific footer hint for the Debug tab.

*Call graph*: calls 1 internal fn (accent_style); 2 external calls (from, vec!).


### Pet selection and runtime rendering
These files cover pet runtime animation state, preview data, picker construction, and app-level handling for selecting and persisting pets.

### `tui/src/pets/picker.rs`

`orchestration` · `request handling`

This file is the orchestration layer for the pet picker dialog. Its central job is to turn several pet sources into a single ordered list of `SelectionItem`s: bundled pets from `catalog::BUILTIN_PETS`, a synthetic `DISABLED_PET_ID` entry, and custom pets loaded from the user's `codex_home`. Internally it uses a private `PetPickerEntry` struct to normalize those sources into a common shape with `selector`, optional `legacy_selector`, display name, and optional description.

`build_pet_picker_params` performs the full assembly. It chooses `DEFAULT_PET_ID` as the preferred selection when no pet is configured, sorts entries by `display_name`, then forcibly moves the disable entry to index 0 so it remains easy to find regardless of alphabetical order. While converting entries into `SelectionItem`s, it computes both `is_current` and `initial_selected_idx`, with explicit compatibility for legacy custom-pet identifiers via `legacy_selector`. Search behavior is also specialized: the disable row gets a synonym-rich search string (`disable disabled hide hidden off none`), while normal pets search by selector.

The picker itself does not load images. Instead, it wires `on_selection_changed` to emit `AppEvent::PetPreviewRequested` for the currently highlighted pet, and each selectable row emits either `AppEvent::PetSelected` or `AppEvent::PetDisabled`. Side content comes from `PetPickerPreviewState::renderable()`, so preview rendering can be updated asynchronously outside the popup widget tree.

Custom pet discovery scans both modern `pets/<id>/pet.json` and legacy `avatars/<id>/avatar.json` layouts. Entries are deduplicated by normalized selector in a `HashMap`, skip reserved names like `DISABLED_PET_ID` and already-prefixed custom IDs, and silently ignore unreadable directories or invalid manifests by continuing rather than surfacing errors in the picker.

#### Function details

##### `build_pet_picker_params`  (lines 46–136)

```
fn build_pet_picker_params(
    current_pet: Option<&str>,
    codex_home: &Path,
    preview_state: PetPickerPreviewState,
) -> SelectionViewParams
```

**Purpose**: Constructs the full `SelectionViewParams` for the pet picker, including sorted items, current/preselected state, footer text, search metadata, preview side pane, and event callbacks for both selection and preview changes.

**Data flow**: Inputs are the currently configured pet ID as `Option<&str>`, the `codex_home` path used for custom pet discovery, and a `PetPickerPreviewState`. It reads built-in and custom pet metadata via `available_pet_entries`, sorts and reorders entries, derives `initial_selected_idx`, converts each entry into a `SelectionItem` with `SelectionAction` closures that send `AppEvent::PetSelected` or `AppEvent::PetDisabled`, and builds an `on_selection_changed` callback that sends `AppEvent::PetPreviewRequested`. It returns a populated `SelectionViewParams` containing the item list and preview renderable; it does not mutate external state directly.

**Call relations**: This is the file's top-level constructor and is exercised by all picker tests. In its internal flow it first delegates source collection to `available_pet_entries`, then delegates side-pane creation to `PetPickerPreviewState::renderable`, and uses the standard popup hint helper for footer text. The surrounding UI is expected to consume the returned actions/callbacks rather than mutating pet state directly.

*Call graph*: calls 3 internal fn (standard_popup_hint_line, available_pet_entries, renderable); called by 4 (picker_imports_legacy_avatar_manifests, picker_lists_app_bundled_and_custom_pets, picker_marks_disabled_pet_as_current, picker_preselects_codex_without_marking_it_current_when_no_pet_is_configured); 3 external calls (new, default, Fixed).


##### `available_pet_entries`  (lines 138–156)

```
fn available_pet_entries(codex_home: &Path) -> Vec<PetPickerEntry>
```

**Purpose**: Builds the unified list of picker entries by combining bundled pets, the synthetic disable row, and custom pets discovered under the user's home directory.

**Data flow**: It takes `codex_home`, reads `catalog::BUILTIN_PETS` into `PetPickerEntry` values, appends a hard-coded disable entry using `DISABLED_PET_ID`, then extends the vector with the result of `custom_pet_entries`. It returns the combined `Vec<PetPickerEntry>` without sorting.

**Call relations**: This helper is only used by `build_pet_picker_params` as the source-gathering phase before sorting and item conversion. It delegates all filesystem-backed discovery and legacy compatibility logic to `custom_pet_entries`.

*Call graph*: calls 1 internal fn (custom_pet_entries); called by 1 (build_pet_picker_params).


##### `custom_pet_entries`  (lines 158–194)

```
fn custom_pet_entries(codex_home: &Path) -> Vec<PetPickerEntry>
```

**Purpose**: Discovers user-managed pets from both current and legacy on-disk layouts and converts valid manifests into picker entries with normalized selectors.

**Data flow**: It takes `codex_home`, iterates over `avatars/avatar.json` and `pets/pet.json` directory conventions, reads child directories with `fs::read_dir`, filters out entries lacking the expected manifest file, extracts the folder name as an ID, skips reserved IDs and already-prefixed custom IDs, converts the raw ID with `custom_pet_selector`, and attempts to load a `Pet` via `Pet::load_with_codex_home`. Successful loads are inserted into a `HashMap<String, PetPickerEntry>` keyed by selector, with `legacy_selector` set to the raw folder name and empty descriptions normalized to `None`. It returns the map's values as a vector.

**Call relations**: This function is called only from `available_pet_entries` to supply the custom portion of the picker. It delegates selector normalization to `custom_pet_selector` and manifest parsing/validation to `Pet::load_with_codex_home`, using a map so duplicate discoveries across legacy and current directories collapse to one selector.

*Call graph*: calls 2 internal fn (load_with_codex_home, custom_pet_selector); called by 1 (available_pet_entries); 3 external calls (new, join, read_dir).


##### `tests::write_pet`  (lines 200–216)

```
fn write_pet(dir: &Path, folder_name: &str, display_name: &str)
```

**Purpose**: Creates a minimal modern custom pet fixture on disk for picker tests.

**Data flow**: It receives a temp root directory, folder name, and display name; creates `pets/<folder_name>`, writes a `pet.json` manifest containing ID, display name, description, and spritesheet path, then writes a test spritesheet file. It returns no value and mutates the filesystem under the provided temp directory.

**Call relations**: This helper is used by `tests::picker_lists_app_bundled_and_custom_pets` to seed a valid custom pet before invoking `build_pet_picker_params`.

*Call graph*: calls 1 internal fn (write_test_spritesheet); 4 external calls (join, format!, create_dir_all, write).


##### `tests::write_legacy_avatar`  (lines 218–233)

```
fn write_legacy_avatar(dir: &Path, folder_name: &str, display_name: &str)
```

**Purpose**: Creates a minimal legacy avatar-style custom pet fixture so the picker's backward-compatibility path can be tested.

**Data flow**: It takes a temp root directory, folder name, and display name; creates `avatars/<folder_name>`, writes an `avatar.json` manifest with display name, description, and spritesheet path, and writes a test spritesheet asset. It returns no value and changes the temp filesystem layout.

**Call relations**: This helper is used by `tests::picker_imports_legacy_avatar_manifests` to exercise the legacy discovery branch inside `custom_pet_entries` and the legacy-selector matching logic in `build_pet_picker_params`.

*Call graph*: calls 1 internal fn (write_test_spritesheet); 4 external calls (join, format!, create_dir_all, write).


##### `tests::picker_lists_app_bundled_and_custom_pets`  (lines 236–270)

```
fn picker_lists_app_bundled_and_custom_pets()
```

**Purpose**: Verifies that the picker merges bundled pets with a custom pet, sorts them by display name while pinning the disable row first, and preselects the current custom pet correctly.

**Data flow**: It creates a temporary codex home, writes a custom pet fixture, calls `build_pet_picker_params` with `Some("chefito")` and a default preview state, then inspects the returned `SelectionViewParams` to assert item ordering, selected index, and custom search value. It writes only test fixtures and performs assertions on the returned data.

**Call relations**: This test drives the main constructor path through custom discovery and item assembly, relying on `tests::write_pet` to prepare the filesystem.

*Call graph*: calls 1 internal fn (build_pet_picker_params); 4 external calls (assert_eq!, tempdir, write_pet, default).


##### `tests::picker_preselects_codex_without_marking_it_current_when_no_pet_is_configured`  (lines 273–284)

```
fn picker_preselects_codex_without_marking_it_current_when_no_pet_is_configured()
```

**Purpose**: Checks the special-case UX where no configured pet still preselects the default pet entry without claiming it is already active.

**Data flow**: It creates a temporary codex home, calls `build_pet_picker_params` with `current_pet` set to `None`, and asserts that the returned params select the Codex row by index and name while leaving `is_current` false. It does not mutate state beyond tempdir creation.

**Call relations**: This test exercises the `preferred_pet = current_pet.unwrap_or(DEFAULT_PET_ID)` branch in `build_pet_picker_params` and confirms that preselection and current-state marking are intentionally separate.

*Call graph*: calls 1 internal fn (build_pet_picker_params); 4 external calls (assert!, assert_eq!, tempdir, default).


##### `tests::picker_marks_disabled_pet_as_current`  (lines 287–303)

```
fn picker_marks_disabled_pet_as_current()
```

**Purpose**: Ensures the synthetic disable entry behaves like a real current selection, including index placement, lack of description, and custom search synonyms.

**Data flow**: It creates a temporary codex home, calls `build_pet_picker_params` with `Some(DISABLED_PET_ID)`, and asserts properties of the first returned item: selected index 0, expected label, `None` description, `is_current = true`, and the disable-specific search string. It only reads the returned params.

**Call relations**: This test validates the reorder-to-front logic and the special-case item construction branch for `DISABLED_PET_ID` inside `build_pet_picker_params`.

*Call graph*: calls 1 internal fn (build_pet_picker_params); 4 external calls (assert!, assert_eq!, tempdir, default).


##### `tests::picker_imports_legacy_avatar_manifests`  (lines 306–323)

```
fn picker_imports_legacy_avatar_manifests()
```

**Purpose**: Confirms that legacy avatar manifests are imported into the picker and matched against the normalized custom selector.

**Data flow**: It creates a temporary codex home, writes a legacy avatar fixture, calls `build_pet_picker_params` with `Some("custom:legacy")`, finds the resulting item by display name, and asserts that it is marked current and searchable by the normalized selector. It mutates only the temp fixture directory.

**Call relations**: This test covers the legacy `avatars` scan in `custom_pet_entries` and the `legacy_selector` compatibility checks used by `build_pet_picker_params` when determining current and preferred entries.

*Call graph*: calls 1 internal fn (build_pet_picker_params); 5 external calls (assert!, assert_eq!, tempdir, write_legacy_avatar, default).


### `tui/src/app/pets.rs`

`orchestration` · `interactive settings changes and background asset loading during UI runtime`

This module centralizes the TUI app's pet-specific control flow. Two error handlers distinguish terminal failures from asset failures: terminal errors are escalated as `Err(...)` because they indicate TUI rendering infrastructure problems, while asset errors merely disable or clear the affected pet UI and log warnings. `disable_ambient_pet_before_shutdown` proactively disables the session pet and tries to clear the terminal image before shutdown feedback is shown. `handle_ambient_pet_image_render_error` disables ambient pets for the session after an asset-render failure and attempts to clear the stale image; `handle_pet_picker_preview_image_render_error` instead marks the preview as failed in the widget and clears the preview image slot.

Selection and loading are split into asynchronous phases. `handle_pet_selected` immediately shows a loading popup, schedules a frame, clones the needed config and sender state, and spawns blocking work that ensures the builtin pet pack exists and then loads `crate::pets::AmbientPet`; the result is sent back as `AppEvent::PetSelectionLoaded`. `handle_pet_selection_loaded` consumes that event, ignores stale request IDs by checking whether the popup is still active, persists the chosen pet via `ConfigEditsBuilder` and `tui_pet_edit`, updates `self.config.tui_pet`, and installs the loaded pet into the widget. `handle_pet_disabled` persists the disabled sentinel pet ID and synchronizes widget/config state. Preview and configured-pet completion handlers update the widget only when the result still matches the current configured pet, preventing stale background loads from overwriting newer choices.

#### Function details

##### `App::disable_ambient_pet_before_shutdown`  (lines 6–20)

```
fn disable_ambient_pet_before_shutdown(&mut self, tui: &mut tui::Tui) -> Result<()>
```

**Purpose**: Turns off the ambient pet for the current session and clears any rendered pet image before shutdown UI proceeds. It treats terminal-clear failures as fatal but only logs asset-clear failures.

**Data flow**: Mutates `chat_widget` by calling `disable_ambient_pet_for_session()`, then calls `tui.clear_ambient_pet_image()`. If clearing fails with `PetImageRenderError::Terminal`, it converts and returns that error; if it fails with `Asset`, it logs a warning and still returns `Ok(())`.

**Call relations**: Used during shutdown-related flow before terminal feedback is shown. It delegates image clearing to the TUI layer and keeps session-level pet state aligned with the cleared terminal.

*Call graph*: 2 external calls (clear_ambient_pet_image, warn!).


##### `App::handle_ambient_pet_image_render_error`  (lines 22–49)

```
fn handle_ambient_pet_image_render_error(
        &mut self,
        tui: &mut tui::Tui,
        err: crate::pets::PetImageRenderError,
    ) -> Result<()>
```

**Purpose**: Handles failures while rendering the ambient pet image. Terminal failures propagate upward, while asset failures disable pets for the session and attempt to clear the broken image.

**Data flow**: Consumes a `PetImageRenderError`. For `Terminal(err)`, it returns `Err(err.into())`. For `Asset(err)`, it logs a warning, disables ambient pets in `chat_widget`, calls `tui.clear_ambient_pet_image()`, and again propagates terminal clear failures while only warning on asset clear failures. Successful asset-error handling returns `Ok(())`.

**Call relations**: Called when ambient pet rendering fails elsewhere in the app. It is the recovery path that prevents repeated asset-render failures from continuing to affect the session.

*Call graph*: 3 external calls (clear_ambient_pet_image, warn!, into).


##### `App::handle_pet_picker_preview_image_render_error`  (lines 51–76)

```
fn handle_pet_picker_preview_image_render_error(
        &mut self,
        tui: &mut tui::Tui,
        err: crate::pets::PetImageRenderError,
    ) -> Result<()>
```

**Purpose**: Handles failures while rendering the pet picker's preview image. It records preview failure text in the widget and clears the preview slot when the failure is asset-related.

**Data flow**: Matches on `PetImageRenderError`: terminal errors are converted into `Err`, while asset errors are logged, converted to a string for `chat_widget.fail_pet_picker_preview_render`, and followed by `tui.draw_pet_picker_preview_image(None)` to clear the preview. Terminal failures during clearing are returned; asset failures during clearing are only warned about.

**Call relations**: Used by pet-picker preview rendering flow. It differs from ambient-pet error handling by preserving the rest of pet functionality and only marking the preview request as failed.

*Call graph*: 4 external calls (draw_pet_picker_preview_image, warn!, into, to_string).


##### `App::handle_pet_selected`  (lines 78–103)

```
fn handle_pet_selected(&mut self, tui: &mut tui::Tui, pet_id: String)
```

**Purpose**: Starts asynchronous loading of a newly selected pet and shows immediate loading UI. It offloads filesystem/asset work to a blocking task and arranges for completion to come back as an app event.

**Data flow**: Reads the selected `pet_id`, asks `chat_widget` to show a pet-selection loading popup and capture its `request_id`, schedules a frame, clones `codex_home`, a frame requester, the animations flag, and `app_event_tx`, then spawns a blocking closure. That closure ensures the builtin pack exists, loads `crate::pets::AmbientPet::load(...)`, wraps success as `Some(ambient_pet)` or stringifies errors, and sends `AppEvent::PetSelectionLoaded { request_id, pet_id, result }` through the app event channel.

**Call relations**: Triggered when the user chooses a pet in the UI. It does not finish the selection itself; instead it kicks off background work whose result is later consumed by `handle_pet_selection_loaded`.

*Call graph*: 3 external calls (frame_requester, drop, spawn_blocking).


##### `App::handle_pet_disabled`  (lines 105–121)

```
async fn handle_pet_disabled(&mut self, tui: &mut tui::Tui)
```

**Purpose**: Persists the disabled-pet setting and updates in-memory/UI state accordingly. It is the explicit disable action rather than a transient session-only suppression.

**Data flow**: Builds a config edit with `tui_pet_edit(crate::pets::DISABLED_PET_ID)`, applies it asynchronously through `ConfigEditsBuilder::new(&self.config.codex_home).with_edits([edit]).apply().await`, and on success calls `self.sync_tui_pet_disabled()` and schedules a frame. On failure it appends an error message to the chat widget.

**Call relations**: Called when the user disables pets from the UI. It bridges the UI action into persistent config storage and then refreshes visible state.

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

**Purpose**: Completes a pet preview load request by handing the result to the chat widget and redrawing. It is the lightweight completion path for preview-only loads.

**Data flow**: Consumes a `request_id` and `Result<AmbientPet, String>`, passes them to `chat_widget.finish_pet_picker_preview_load`, and schedules a frame via the TUI frame requester. It returns no value.

**Call relations**: Called when background preview loading finishes. It delegates stale-request handling and UI update details to the chat widget.

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

**Purpose**: Finalizes a pet selection after background loading completes, persisting the chosen pet and installing the loaded ambient pet into the widget. It ignores stale completion events whose loading popup is no longer active.

**Data flow**: Consumes the popup `request_id`, selected `pet_id`, and `Result<Option<AmbientPet>, String>`. It first asks `chat_widget.finish_pet_selection_loading_popup(request_id)` whether this completion is still current; if not, it returns `Ok(AppRunControl::Continue)` immediately. On successful pet load it persists the selection with `ConfigEditsBuilder` and `tui_pet_edit`, updates `self.config.tui_pet`, and calls `chat_widget.set_tui_pet_loaded(Some(pet_id), ambient_pet)`. On persistence or load failure it adds an error message. It always schedules a frame before returning `Continue`.

**Call relations**: Consumes the `AppEvent::PetSelectionLoaded` emitted by `handle_pet_selected`'s background task. It is the authoritative completion step that commits the selection to config and visible UI.

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

**Purpose**: Applies the result of loading the pet currently configured in app settings, but only if the completion still matches the active configured pet ID. This prevents stale background loads from overwriting newer config changes.

**Data flow**: Reads `self.config.tui_pet` and compares it to the supplied `pet_id`; if they differ, it returns early. If they match and the result is `Ok(ambient_pet)`, it calls `chat_widget.set_tui_pet_loaded(Some(pet_id), ambient_pet)` and schedules a frame. If the result is `Err(err)`, it adds a warning message instead of an error.

**Call relations**: Used when loading the configured pet outside the explicit selection flow, such as startup or config refresh. Its early-return guard is the key stale-result protection.

*Call graph*: 2 external calls (frame_requester, format!).


### `tui/src/pets/ambient.rs`

`domain_logic` · `request handling and main UI redraw loop for ambient pet state`

This module is the behavioral core of ambient pet rendering. `AmbientPet` owns a loaded `Pet` model, terminal image support snapshot, extracted PNG frame paths, a sixel cache directory, a `FrameRequester`, optional transient notification state, and the `Instant` from which the current animation timeline is measured. Notifications are represented by `PetNotificationKind` plus `PetNotification`; each kind maps to a specific animation name (`running`, `waiting`, `review`, `failed`), UI label, fallback body text, and expiration lifetime ranging from minutes to days.

`load` resolves the selected pet id, computes a cache path under `CODEX_HOME/cache/tui-pets/frame-cache/<pet-id>/<frame-cache-key>/`, extracts per-frame PNGs, snapshots protocol support, and initializes animation timing. Rendering is split into two request builders: `draw_request` anchors the sprite above the composer while reserving vertical space for notification text and refusing to draw if the image would overlap reserved UI; `preview_draw_request` instead centers a stable first idle frame in the picker pane. Animation selection prefers the visible notification’s animation, falls back to `idle`, and for non-looping animations switches to the animation named by `fallback` once total duration elapses. Frame timing is computed in nanoseconds, including loop-prefix handling and per-frame remaining delay, so `schedule_next_frame` can request the next repaint only when protocol support and animation settings allow it. The module also includes compact test helpers and regression tests for vocabulary, frame timing, and reduced-motion behavior.

#### Function details

##### `PetNotificationKind::animation_name`  (lines 55–62)

```
fn animation_name(self) -> &'static str
```

**Purpose**: Maps each semantic notification kind to the animation track name expected in `Pet.animations`. This is the bridge from high-level pet state to animation lookup keys.

**Data flow**: It takes `self` as a `PetNotificationKind` and returns a static string literal: `running`, `waiting`, `review`, or `failed`. It reads no external state and writes nothing.

**Call relations**: Used indirectly by animation selection when `AmbientPet::current_animation` decides which track should be active for a visible notification.


##### `PetNotificationKind::label`  (lines 64–71)

```
fn label(self) -> &'static str
```

**Purpose**: Returns the short UI-facing label associated with a notification kind. These labels are also used to decide whether the notification occupies one or two terminal rows.

**Data flow**: It takes a `PetNotificationKind` and returns one of the fixed strings `Running`, `Needs input`, `Ready`, or `Blocked`. No state is read or mutated.

**Call relations**: Consumed by notification layout logic and tested to keep terminology aligned with the broader app vocabulary.


##### `PetNotificationKind::fallback_body`  (lines 73–80)

```
fn fallback_body(self) -> &'static str
```

**Purpose**: Provides default body text when a notification is created without an explicit message. The defaults mostly mirror the label, except `Running` falls back to `Thinking`.

**Data flow**: Input is the enum variant; output is a static string literal for the default body. It has no side effects.

**Call relations**: Called from `PetNotification::new` so notification creation can always populate a body string.


##### `PetNotificationKind::lifetime`  (lines 82–89)

```
fn lifetime(self) -> Duration
```

**Purpose**: Defines how long each notification kind remains visible before expiring. Different states intentionally persist for very different durations.

**Data flow**: It maps the enum variant to one of the module constants: 3 minutes for running, 24 hours for waiting, 7 days for review, and 1 hour for failed. It returns a `Duration` and touches no mutable state.

**Call relations**: This is used by `PetNotification::is_expired` to decide whether the current notification should still influence animation and layout.

*Call graph*: called by 1 (is_expired).


##### `PetNotification::new`  (lines 100–106)

```
fn new(kind: PetNotificationKind, body: Option<String>) -> Self
```

**Purpose**: Constructs a notification record with a concrete body string and a fresh timestamp. It normalizes absent bodies to the kind-specific fallback text.

**Data flow**: Inputs are a `PetNotificationKind` and an `Option<String>` body. It chooses the provided body or allocates a new `String` from `fallback_body`, stamps `updated_at` with `Instant::now()`, and returns a new `PetNotification` value.

**Call relations**: Called only from `AmbientPet::set_notification`, which resets the animation timeline whenever a new notification arrives.

*Call graph*: called by 1 (set_notification); 1 external calls (now).


##### `PetNotification::is_expired`  (lines 108–110)

```
fn is_expired(&self, now: Instant) -> bool
```

**Purpose**: Checks whether a notification has outlived its configured visibility window. It uses saturating time arithmetic so clock/timestamp anomalies do not panic.

**Data flow**: It takes `&self` and a `now: Instant`, computes `now.saturating_duration_since(self.updated_at)`, compares that duration against `self.kind.lifetime()`, and returns a boolean. No state is modified.

**Call relations**: Used by `AmbientPet::visible_notification` to filter stale notifications before animation or layout decisions are made.

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

**Purpose**: Loads the selected pet definition, prepares its extracted PNG frame cache, and initializes ambient-rendering state. It is the constructor that turns persisted selection plus `CODEX_HOME` into a ready-to-draw `AmbientPet`.

**Data flow**: Inputs are an optional selected pet id, the `codex_home` path, a `FrameRequester`, and an `animations_enabled` flag. It resolves the pet via `Pet::load_with_codex_home`, computes a cache directory keyed by pet id and `frame_cache_key`, prepares PNG frames into `<cache>/frames`, stores `<cache>/sixel` for later sixel caching, snapshots `default_image_support`, sets `notification` to `None`, stamps `animation_started_at` with `Instant::now()`, and returns `Result<AmbientPet>`.

**Call relations**: Called by higher-level pet-loading orchestration. It delegates pet resolution to the model layer and frame extraction to `frames::prepare_png_frames`, then becomes the long-lived state object used by draw and scheduling methods.

*Call graph*: calls 3 internal fn (default_image_support, prepare_png_frames, load_with_codex_home); called by 1 (load_ambient_pet); 2 external calls (now, join).


##### `AmbientPet::set_notification`  (lines 178–181)

```
fn set_notification(&mut self, kind: PetNotificationKind, body: Option<String>)
```

**Purpose**: Installs a new semantic notification and restarts the animation timeline from the beginning. This ensures state-change animations begin at frame zero when the notification changes.

**Data flow**: Inputs are `&mut self`, a `PetNotificationKind`, and an optional body string. It replaces `self.notification` with `Some(PetNotification::new(...))`, resets `self.animation_started_at` to `Instant::now()`, and returns unit.

**Call relations**: Invoked by surrounding UI/application state transitions when the pet should reflect running, waiting, review, or failed status. It delegates notification construction to `PetNotification::new`.

*Call graph*: calls 1 internal fn (new); 1 external calls (now).


##### `AmbientPet::image_enabled`  (lines 183–185)

```
fn image_enabled(&self) -> bool
```

**Purpose**: Reports whether the current terminal support snapshot exposes any usable image protocol. It is a simple capability check for callers deciding whether to attempt pet rendering.

**Data flow**: It reads `self.support`, calls `protocol()`, and returns `true` if that yields `Some(_)` and `false` otherwise. No state changes occur.

**Call relations**: Used by higher layers that need a yes/no answer rather than the specific protocol. It depends on `PetImageSupport::protocol` from the image-protocol module.

*Call graph*: calls 1 internal fn (protocol).


##### `AmbientPet::image_columns`  (lines 187–189)

```
fn image_columns(&self) -> u16
```

**Purpose**: Returns the computed terminal-cell width of the pet image at the fixed target pixel height. This lets layout code reserve horizontal space without building a full draw request.

**Data flow**: It reads pet geometry through `self.image_size()` and returns the `columns` field from the resulting `ImageSize`. No mutation occurs.

**Call relations**: Called by layout code that needs the pet’s width estimate; it delegates the actual aspect-ratio math to `AmbientPet::image_size`.

*Call graph*: calls 1 internal fn (image_size).


##### `AmbientPet::set_image_support_for_tests`  (lines 192–194)

```
fn set_image_support_for_tests(&mut self, support: PetImageSupport)
```

**Purpose**: Overrides the detected image support in test builds so unit tests can force supported or unsupported protocol scenarios. It exists only behind `#[cfg(test)]`.

**Data flow**: It takes `&mut self` and a `PetImageSupport`, assigns that value into `self.support`, and returns unit.

**Call relations**: Used by tests to bypass environment-based protocol detection and exercise draw/scheduling branches deterministically.


##### `AmbientPet::schedule_next_frame`  (lines 196–200)

```
fn schedule_next_frame(&self)
```

**Purpose**: Requests a future redraw at the exact delay needed for the next animation frame, if animation is active. It is the outward-facing scheduling hook used after a frame is rendered.

**Data flow**: It reads `self.next_frame_delay()`. If that returns `Some(delay)`, it forwards the delay to `self.frame_requester.schedule_frame_in(delay)`; otherwise it does nothing.

**Call relations**: Called by the UI loop after drawing or state updates. It delegates all timing decisions to `AmbientPet::next_frame_delay` and only performs the side effect of scheduling when a delay exists.

*Call graph*: calls 2 internal fn (next_frame_delay, schedule_frame_in).


##### `AmbientPet::next_frame_delay`  (lines 202–212)

```
fn next_frame_delay(&self) -> Option<Duration>
```

**Purpose**: Computes how long until the current animation should advance to its next frame. It suppresses scheduling entirely when images are unsupported or reduced-motion mode is active.

**Data flow**: It reads `self.support.protocol()` and `self.animations_enabled`; if either disables animation, it returns `None`. Otherwise it obtains the current animation via `self.current_animation()`, computes the active frame tick with `current_animation_frame(animation, self.animation_started_at.elapsed())`, and returns that tick’s optional `delay`.

**Call relations**: Used only by `AmbientPet::schedule_next_frame`. It depends on `current_animation` to choose the active track and on `current_animation_frame` to convert elapsed time into per-frame timing.

*Call graph*: calls 3 internal fn (current_animation, current_animation_frame, protocol); called by 1 (schedule_next_frame); 1 external calls (elapsed).


##### `AmbientPet::draw_request`  (lines 221–249)

```
fn draw_request(
        &self,
        area: Rect,
        composer_bottom_y: u16,
    ) -> Option<AmbientPetDraw>
```

**Purpose**: Builds a concrete `AmbientPetDraw` describing where and how to render the ambient sprite above the composer, or returns `None` when rendering would overlap reserved UI or no protocol is available. It is the main layout-to-image bridge for live ambient pets.

**Data flow**: Inputs are the available `Rect` and the composer’s bottom Y coordinate. It reads the active protocol from `self.support`, computes image size, checks for a visible non-expired notification and its row cost, derives the sprite bottom position by subtracting `composer_gap_rows()`, rejects layouts that are too short or too narrow, computes right-aligned `x` and top `y`, resolves the current frame path, clones `self.sixel_dir`, and returns `Some(AmbientPetDraw)` or `None`.

**Call relations**: Called by the TUI rendering path when deciding whether to emit an ambient image after the ratatui frame. It delegates notification filtering to `visible_notification`, geometry math to `image_size` and `composer_gap_rows`, and frame selection to `current_frame_path`.

*Call graph*: calls 5 internal fn (current_frame_path, image_size, visible_notification, composer_gap_rows, protocol); 2 external calls (now, clone).


##### `AmbientPet::preview_draw_request`  (lines 256–275)

```
fn preview_draw_request(&self, area: Rect) -> Option<AmbientPetDraw>
```

**Purpose**: Builds a centered preview image request for the `/pets` picker side pane using a stable idle frame instead of the live animation state. This keeps browsing deterministic and avoids coupling previews to ambient animation timing.

**Data flow**: Input is a `Rect` for the preview area. It reads the active protocol and computed image size, returns `None` if the area is too small, otherwise centers the image horizontally and vertically, resolves the first idle frame path, clones `self.sixel_dir`, and returns an `AmbientPetDraw` whose `clear_top_y` starts at the image’s own top row.

**Call relations**: Used by picker-preview rendering rather than the ambient transcript/composer layout. It delegates frame lookup to `first_idle_frame_path` and size computation to `image_size`.

*Call graph*: calls 3 internal fn (first_idle_frame_path, image_size, protocol); 1 external calls (clone).


##### `AmbientPet::visible_notification`  (lines 277–281)

```
fn visible_notification(&self, now: Instant) -> Option<&PetNotification>
```

**Purpose**: Returns the current notification only if it has not expired at the supplied instant. This isolates expiration filtering from the rest of the animation and layout code.

**Data flow**: It reads `self.notification.as_ref()`, applies a predicate using `PetNotification::is_expired(now)`, and returns `Option<&PetNotification>`. No state is changed.

**Call relations**: Called by both `current_animation` and `draw_request`, so the same expiration rule controls animation selection and reserved notification height.

*Call graph*: called by 2 (current_animation, draw_request).


##### `AmbientPet::current_animation`  (lines 283–301)

```
fn current_animation(&self) -> Option<&Animation>
```

**Purpose**: Chooses the active animation track based on the visible notification, with fallback to `idle`, and handles one-shot animations that should hand off to another track after completion. It encapsulates the semantic-to-track selection policy.

**Data flow**: It reads the current visible notification at `Instant::now()`, derives an animation name from the notification kind or defaults to `idle`, looks up that animation in `self.pet.animations` with fallback to `idle`, and if the chosen animation has `loop_start == None` and elapsed time exceeds `animation.total_duration()`, it attempts to return the animation named by `animation.fallback`; otherwise it returns the chosen animation reference.

**Call relations**: Used by `current_frame_path` and `next_frame_delay`. It depends on `visible_notification` for state filtering and on `Animation::total_duration` plus elapsed time to implement one-shot-to-fallback transitions.

*Call graph*: calls 1 internal fn (visible_notification); called by 2 (current_frame_path, next_frame_delay); 2 external calls (elapsed, now).


##### `AmbientPet::current_frame_path`  (lines 303–316)

```
fn current_frame_path(&self) -> Option<PathBuf>
```

**Purpose**: Resolves the filesystem path of the frame image that should be drawn right now. It respects reduced-motion mode by pinning to the first frame of the active animation.

**Data flow**: It reads the current animation via `current_animation()`. If animations are enabled, it computes the current `sprite_index` with `current_animation_frame(animation, elapsed)`; otherwise it takes the first frame’s `sprite_index`. If no animation/frame exists it falls back to index `0`, then maps that sprite index to a cached PNG path with `frame_path_for_sprite_index` and returns `Option<PathBuf>`.

**Call relations**: Called by `draw_request` to populate the image payload path. It delegates animation choice to `current_animation` and sprite-index-to-file mapping to `frame_path_for_sprite_index`.

*Call graph*: calls 2 internal fn (current_animation, frame_path_for_sprite_index); called by 1 (draw_request).


##### `AmbientPet::first_idle_frame_path`  (lines 318–326)

```
fn first_idle_frame_path(&self) -> Option<PathBuf>
```

**Purpose**: Returns the cached PNG path for the first frame of the `idle` animation, defaulting to sprite index 0 if idle is absent. This is used for stable previews.

**Data flow**: It reads `self.pet.animations.get("idle")`, takes the first frame’s `sprite_index` if present, otherwise uses `0`, then resolves that index through `frame_path_for_sprite_index` and returns `Option<PathBuf>`.

**Call relations**: Used only by `preview_draw_request`, which intentionally avoids live animation state.

*Call graph*: calls 1 internal fn (frame_path_for_sprite_index); called by 1 (preview_draw_request).


##### `AmbientPet::frame_path_for_sprite_index`  (lines 328–332)

```
fn frame_path_for_sprite_index(&self, sprite_index: usize) -> Option<PathBuf>
```

**Purpose**: Maps a sprite index from animation metadata to one of the extracted PNG frame paths, clamping out-of-range indices to the last available frame. This prevents panics if metadata and extracted frame counts drift.

**Data flow**: Input is a `usize` sprite index. It reads `self.frames`, computes `sprite_index.min(self.frames.len().saturating_sub(1))`, clones the corresponding `PathBuf` if present, and returns `Option<PathBuf>`.

**Call relations**: This is the final lookup step used by both `current_frame_path` and `first_idle_frame_path`.

*Call graph*: called by 2 (current_frame_path, first_idle_frame_path).


##### `AmbientPet::image_size`  (lines 334–345)

```
fn image_size(&self) -> ImageSize
```

**Purpose**: Computes the pet image’s terminal-cell dimensions from a fixed target pixel height and the pet’s frame aspect ratio. The width calculation includes a 0.52 scaling factor to account for terminal cell proportions.

**Data flow**: It reads constants `PET_TARGET_HEIGHT_PX` and `TERMINAL_ROW_HEIGHT_PX` plus `self.pet.frame_height` and `self.pet.frame_width`. It converts the target height into rounded terminal rows, derives an aspect ratio adjusted by `0.52`, computes rounded columns from rows/aspect, clamps rows and columns to at least 1, and returns an `ImageSize { columns, rows, height_px }`.

**Call relations**: Used by `draw_request`, `preview_draw_request`, and `image_columns` so all layout code shares the same geometry calculation.

*Call graph*: called by 3 (draw_request, image_columns, preview_draw_request); 1 external calls (from).


##### `composer_gap_rows`  (lines 348–351)

```
fn composer_gap_rows() -> u16
```

**Purpose**: Converts the fixed pixel gap above the composer into a minimum one-row terminal spacing. This keeps the ambient sprite from touching the composer pane.

**Data flow**: It reads `PET_COMPOSER_GAP_PX` and `TERMINAL_ROW_HEIGHT_PX`, divides and rounds to terminal rows, clamps the result to at least 1, and returns a `u16`.

**Call relations**: Called by `draw_request` when computing the sprite’s bottom anchor above the composer.

*Call graph*: called by 1 (draw_request); 1 external calls (from).


##### `default_image_support`  (lines 359–361)

```
fn default_image_support() -> PetImageSupport
```

**Purpose**: Provides the initial terminal image support snapshot used when constructing an `AmbientPet`. In tests it deliberately returns an unsupported value instead of probing the real terminal.

**Data flow**: In non-test builds it resolves `ProtocolSelection::Auto`; in test builds it returns `PetImageSupport::Unsupported(Terminal)`. It has no inputs and returns a `PetImageSupport`.

**Call relations**: Called only from `AmbientPet::load` so newly loaded pets capture protocol support once at construction time.

*Call graph*: called by 1 (load); 1 external calls (Unsupported).


##### `current_animation_frame`  (lines 376–412)

```
fn current_animation_frame(animation: &Animation, elapsed: Duration) -> Option<AnimationFrameTick>
```

**Purpose**: Converts an animation plus elapsed time into the currently visible sprite index and the remaining delay until the next frame boundary. It handles single-frame animations, looping suffixes, and non-looping animations that settle on their last frame.

**Data flow**: Inputs are `&Animation` and an elapsed `Duration`. It returns `Some(AnimationFrameTick)` with `sprite_index` and optional `delay`, or `None` if the animation has no frames. For multi-frame animations it computes elapsed nanoseconds, optionally splits the animation into a non-looping prefix and looping suffix using `loop_start`, folds elapsed time into the loop region when appropriate, and delegates frame selection to `frame_at_elapsed`; if there is no valid loop and elapsed exceeds total duration, it returns the last frame with `delay: None`.

**Call relations**: Used by `AmbientPet::next_frame_delay` for scheduling. `AmbientPet::current_frame_path` also relies on the same timing logic indirectly when animations are enabled.

*Call graph*: calls 2 internal fn (frame_at_elapsed, total_duration); called by 1 (next_frame_delay); 1 external calls (as_nanos).


##### `frame_at_elapsed`  (lines 414–431)

```
fn frame_at_elapsed(animation: &Animation, elapsed_nanos: u128) -> Option<AnimationFrameTick>
```

**Purpose**: Walks an animation’s frames to find which frame covers a given elapsed nanosecond offset and how much time remains in that frame. It treats zero-duration frames as lasting at least one nanosecond.

**Data flow**: Inputs are `&Animation` and `elapsed_nanos: u128`. It iterates through `animation.frames`, subtracting each frame’s duration in nanoseconds from a running remainder until the remainder falls inside a frame; it then returns that frame’s `sprite_index` and a `delay` computed by `nanos_to_duration(frame_nanos - remaining_elapsed)`. If elapsed runs past all frames, it returns the last frame with `delay: None`.

**Call relations**: This is the low-level helper used by `current_animation_frame` after loop/non-loop elapsed-time normalization.

*Call graph*: calls 1 internal fn (nanos_to_duration); called by 1 (current_animation_frame).


##### `nanos_to_duration`  (lines 433–435)

```
fn nanos_to_duration(nanos: u128) -> Duration
```

**Purpose**: Safely converts a `u128` nanosecond count into `std::time::Duration` by saturating at `u64::MAX`. This avoids overflow when constructing durations from large intermediate values.

**Data flow**: Input is a nanosecond count as `u128`. It clamps that value to `u64::MAX`, casts to `u64`, and returns `Duration::from_nanos(...)`.

**Call relations**: Used only by `frame_at_elapsed` to turn remaining frame time into a schedulable `Duration`.

*Call graph*: called by 1 (frame_at_elapsed); 2 external calls (from_nanos, from).


##### `notification_height`  (lines 437–443)

```
fn notification_height(notification: &PetNotification) -> u16
```

**Purpose**: Determines how many terminal rows a notification reserves above the sprite. A notification whose body exactly matches its label uses one row; otherwise it uses two.

**Data flow**: Input is `&PetNotification`. It compares `notification.body` to `notification.kind.label()` and returns `1` or `2` as `u16`.

**Call relations**: Called by `draw_request` so ambient layout can reserve enough vertical space for the visible notification text.


##### `test_ambient_pet`  (lines 446–473)

```
fn test_ambient_pet(
    frame_requester: FrameRequester,
    animations_enabled: bool,
) -> AmbientPet
```

**Purpose**: Builds a deterministic in-memory `AmbientPet` fixture for unit tests without touching disk or real terminal detection. The fixture starts slightly into a looping two-frame idle animation.

**Data flow**: Inputs are a `FrameRequester` and an `animations_enabled` flag. It constructs a synthetic `Pet` with fixed geometry and one idle animation from `test_animation()`, marks image support as `Supported(ImageProtocol::Kitty)`, seeds two frame paths, sets `notification` to `None`, backdates `animation_started_at` by 15 ms from `Instant::now()`, and returns the assembled `AmbientPet`.

**Call relations**: Used by reduced-motion and timing tests to exercise `current_frame_path` and `next_frame_delay` without invoking `AmbientPet::load`.

*Call graph*: calls 1 internal fn (test_animation); called by 1 (reduced_motion_uses_stable_first_frame_and_schedules_no_follow_up); 8 external calls (from_millis, from, now, from, new, new, Supported, vec!).


##### `test_animation`  (lines 476–491)

```
fn test_animation() -> Animation
```

**Purpose**: Creates a simple two-frame looping animation used by tests. Each frame lasts 10 ms and the loop starts at frame 0.

**Data flow**: It has no inputs and returns an `Animation` containing two `AnimationFrame` values with sprite indices 0 and 1, equal durations, `loop_start: Some(0)`, and fallback `idle`.

**Call relations**: Used by both `test_ambient_pet` and the frame-duration unit test to provide a compact predictable animation.

*Call graph*: called by 2 (test_ambient_pet, animation_frame_uses_per_frame_duration); 1 external calls (vec!).


##### `tests::notification_labels_match_codex_app_vocabulary`  (lines 498–503)

```
fn notification_labels_match_codex_app_vocabulary()
```

**Purpose**: Checks that each `PetNotificationKind` label string matches the expected app-facing wording. This guards against accidental terminology drift.

**Data flow**: It calls `label()` on each enum variant and asserts the returned strings equal the expected literals.

**Call relations**: This test exercises the static mapping in `PetNotificationKind::label`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::animation_frame_uses_per_frame_duration`  (lines 506–516)

```
fn animation_frame_uses_per_frame_duration()
```

**Purpose**: Verifies that frame selection honors individual frame durations rather than assuming a uniform or frame-count-based schedule. The chosen elapsed time lands inside the second frame with 5 ms remaining.

**Data flow**: It builds the test animation, calls `current_animation_frame(&animation, 15 ms)`, and asserts the result is `Some(AnimationFrameTick { sprite_index: 1, delay: Some(5 ms) })`.

**Call relations**: This test directly validates the timing logic implemented by `current_animation_frame` and `frame_at_elapsed`.

*Call graph*: calls 1 internal fn (test_animation); 1 external calls (assert_eq!).


##### `tests::reduced_motion_uses_stable_first_frame_and_schedules_no_follow_up`  (lines 519–527)

```
fn reduced_motion_uses_stable_first_frame_and_schedules_no_follow_up()
```

**Purpose**: Confirms that disabling animations pins the pet to the first frame and suppresses future frame scheduling. This is the reduced-motion behavior contract.

**Data flow**: It creates a test pet with `animations_enabled` set to `false`, reads `current_frame_path()` and `next_frame_delay()`, and asserts they are `Some("frame-0.png")` and `None` respectively.

**Call relations**: This test drives the reduced-motion branches in `AmbientPet::current_frame_path` and `AmbientPet::next_frame_delay` using the `test_ambient_pet` fixture.

*Call graph*: calls 2 internal fn (test_ambient_pet, test_dummy); 1 external calls (assert_eq!).


### `tui/src/pets/preview.rs`

`data_model` · `request handling`

This file provides the small state model behind the pet picker's preview pane. The core type is `PetPickerPreviewState`, which wraps an `Arc<Mutex<PetPickerPreviewInner>>` so both the popup renderer and external async controllers can observe and update the same preview status. The inner state stores two pieces of data: a `PetPickerPreviewStatus` enum (`Hidden`, `Loading`, `Disabled`, `Ready`, or `Error { message }`) and `last_area: Option<Rect>`, which remembers the most recent render rectangle.

The design is intentionally tolerant of lock failures: every mutator funnels through `update`, which simply does nothing if the mutex is poisoned, and `area()` returns `None` if locking fails. That keeps preview support from destabilizing the rest of the picker UI. `clear()` is the only state transition that also resets geometry, because hidden previews should not leave stale render coordinates behind.

`PetPickerPreviewRenderable` implements the shared `Renderable` trait. On each render it records the current `Rect` into `last_area`, then either exits immediately (`Hidden` and `Ready`) or draws centered status text for loading, disabled, or error states. `Ready` intentionally renders nothing because actual pet image drawing happens elsewhere using the remembered area. The helper `centered_text_area` vertically centers one or two lines of text within the side pane and clamps requested height to the available area.

#### Function details

##### `PetPickerPreviewState::renderable`  (lines 33–37)

```
fn renderable(&self) -> PetPickerPreviewRenderable
```

**Purpose**: Creates a lightweight renderable view object that shares the same underlying preview state as the controller.

**Data flow**: It reads `self.inner`, clones the `Arc`, and returns a new `PetPickerPreviewRenderable { inner }`. No preview status changes occur; the returned wrapper simply points at the same mutex-backed state.

**Call relations**: This method is called by `build_pet_picker_params` when wiring the picker side pane. It exists so the popup can render preview status while external code continues to mutate the same state object.

*Call graph*: called by 1 (build_pet_picker_params); 1 external calls (clone).


##### `PetPickerPreviewState::set_loading`  (lines 39–43)

```
fn set_loading(&self)
```

**Purpose**: Marks the preview as currently loading.

**Data flow**: It takes `&self`, acquires mutable access through `update`, and sets `inner.status` to `PetPickerPreviewStatus::Loading`. It returns no value and leaves `last_area` unchanged.

**Call relations**: This is one of several thin status setters that all delegate to `PetPickerPreviewState::update`, allowing external preview-loading code to drive the side pane state machine.

*Call graph*: calls 1 internal fn (update).


##### `PetPickerPreviewState::set_disabled`  (lines 45–49)

```
fn set_disabled(&self)
```

**Purpose**: Marks the preview pane as representing the disabled-pets state.

**Data flow**: It updates the shared inner state by setting `status` to `PetPickerPreviewStatus::Disabled` through `update`. It does not alter the remembered render area.

**Call relations**: Like the other setters, this is a convenience wrapper over `update` for callers that need the side pane to show the disabled explanatory message.

*Call graph*: calls 1 internal fn (update).


##### `PetPickerPreviewState::set_ready`  (lines 51–55)

```
fn set_ready(&self)
```

**Purpose**: Marks the preview as ready for out-of-band image rendering.

**Data flow**: It sets `inner.status` to `PetPickerPreviewStatus::Ready` via `update`. No text is stored and `last_area` remains available for external renderers to query.

**Call relations**: This setter is used by preview-loading control flow to transition from loading/error states into the mode where `PetPickerPreviewRenderable::render` records geometry but draws no placeholder text.

*Call graph*: calls 1 internal fn (update).


##### `PetPickerPreviewState::set_error`  (lines 57–61)

```
fn set_error(&self, message: String)
```

**Purpose**: Stores an error message to be shown in the preview pane when preview generation fails.

**Data flow**: It takes an owned `String` message, passes a closure to `update`, and replaces `inner.status` with `PetPickerPreviewStatus::Error { message }`. It returns no value and preserves `last_area`.

**Call relations**: This method is another external control hook; once set, `PetPickerPreviewRenderable::render` will display a fixed title plus the stored message.

*Call graph*: calls 1 internal fn (update).


##### `PetPickerPreviewState::clear`  (lines 63–68)

```
fn clear(&self)
```

**Purpose**: Resets the preview state to hidden and forgets the last render rectangle.

**Data flow**: Through `update`, it sets `inner.status` to `PetPickerPreviewStatus::Hidden` and `inner.last_area` to `None`. It returns no value.

**Call relations**: This is the only mutator that clears geometry as well as status, ensuring stale preview coordinates are not reused after the pane is hidden.

*Call graph*: calls 1 internal fn (update).


##### `PetPickerPreviewState::area`  (lines 70–72)

```
fn area(&self) -> Option<Rect>
```

**Purpose**: Returns the most recently rendered preview rectangle, if one has been recorded.

**Data flow**: It locks `self.inner`, reads `inner.last_area`, and returns `Option<Rect>`. If locking fails, it returns `None` rather than propagating an error.

**Call relations**: This accessor supports the out-of-band image rendering design: after `PetPickerPreviewRenderable::render` records the area, external code can query it to know where to draw the actual pet preview.


##### `PetPickerPreviewState::update`  (lines 74–78)

```
fn update(&self, f: impl FnOnce(&mut PetPickerPreviewInner))
```

**Purpose**: Provides the shared mutation primitive for all preview-state setters.

**Data flow**: It takes a closure `FnOnce(&mut PetPickerPreviewInner)`, attempts to lock the mutex, and if successful applies the closure to the inner state. It returns no value and silently ignores poisoned-lock failures.

**Call relations**: All state-changing methods (`set_loading`, `set_disabled`, `set_ready`, `set_error`, `clear`) funnel through this helper so lock handling is centralized and non-fatal.

*Call graph*: called by 5 (clear, set_disabled, set_error, set_loading, set_ready).


##### `PetPickerPreviewRenderable::render`  (lines 104–133)

```
fn render(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Renders the preview side pane's placeholder/status text and records the pane's last on-screen area for external image rendering.

**Data flow**: It receives a `Rect` and mutable `Buffer`, locks the shared inner state, stores `last_area = Some(area)`, then branches on `status`. For `Hidden` and `Ready` it returns immediately; for `Loading`, `Disabled`, and `Error` it derives a title and optional body string, computes a vertically centered text area with `centered_text_area`, builds `Line` values with bold/dim styling, and renders a centered `Paragraph` into the buffer.

**Call relations**: This method is invoked by the popup rendering system through the `Renderable` trait after `build_pet_picker_params` installs the preview wrapper as side content. It delegates geometry calculation to `centered_text_area` and intentionally leaves actual image drawing to external code when status is `Ready`.

*Call graph*: calls 1 internal fn (centered_text_area); 3 external calls (from, new, vec!).


##### `PetPickerPreviewRenderable::desired_height`  (lines 135–137)

```
fn desired_height(&self, _width: u16) -> u16
```

**Purpose**: Reports a fixed preferred height for the preview side pane content.

**Data flow**: It ignores the provided width and returns `4`. It does not read or mutate shared state.

**Call relations**: This is the `Renderable` sizing hook used by layout code when placing the preview pane; it complements `render` by advertising a small constant height.


##### `centered_text_area`  (lines 140–144)

```
fn centered_text_area(area: Rect, height: u16) -> Rect
```

**Purpose**: Computes a rectangle centered vertically within a larger area for one- or two-line preview status text.

**Data flow**: It takes an outer `Rect` and requested `height`, clamps the height to `area.height`, computes a centered `y` using `saturating_sub`, and returns a new `Rect` with the same `x` and `width`. It does not mutate external state.

**Call relations**: This helper is used only by `PetPickerPreviewRenderable::render` to place loading/disabled/error text in the middle of the preview pane.

*Call graph*: called by 1 (render); 1 external calls (new).


##### `tests::centered_text_area_centers_vertically`  (lines 151–163)

```
fn centered_text_area_centers_vertically()
```

**Purpose**: Verifies that `centered_text_area` computes the expected vertically centered rectangle.

**Data flow**: It constructs a sample outer `Rect`, calls `centered_text_area` with a smaller height, and asserts that the returned rectangle has the expected `y` offset and dimensions. It performs no side effects.

**Call relations**: This unit test directly exercises the geometry helper used by preview rendering.

*Call graph*: 1 external calls (assert_eq!).


### Auxiliary picker and import helpers
These files implement adjacent interactive helpers for platform actions, clipboard and external imports, and standalone theme selection.

### `tui/src/app/platform_actions.rs`

`util` · `cross-cutting during input handling and Windows-specific safety setup`

This module contains two distinct concerns. First, it defines `WindowsSandboxState`, which stores app-level Windows sandbox bookkeeping: when setup started and whether the next world-writable scan should be skipped once after user confirmation. Second, it provides helper actions and predicates used by the broader app. On Windows only, `App::spawn_world_writable_scan` derives sandbox permissions from the current `PermissionProfile` and workspace roots, then launches a blocking scan that applies world-writable checks and deny rules using `codex_windows_sandbox`. If permission resolution fails, it silently returns without spawning work. If the scan itself fails, it emits an `AppEvent::OpenWorldWritableWarningConfirmation` with `failed_scan: true`, no preset/profile selection, and no sample paths, signaling the UI to warn without concrete examples.

The cross-platform helper `side_return_shortcut_matches` recognizes Ctrl-C and Ctrl-D key presses, case-insensitively, but only for `KeyEventKind::Press`; release events and unrelated keys do not match. This predicate is consumed by higher-level input dispatch to implement a quick return from side conversations without conflating it with ordinary Esc handling. The included test locks down both accepted and rejected key forms.

#### Function details

##### `App::spawn_world_writable_scan`  (lines 17–49)

```
fn spawn_world_writable_scan(
        cwd: AbsolutePathBuf,
        workspace_roots: Vec<AbsolutePathBuf>,
        env_map: std::collections::HashMap<String, String>,
        logs_base_dir: AbsolutePa
```

**Purpose**: Starts a background Windows-only scan that applies world-writable checks and deny rules for the current workspace and permission profile. If the scan later fails, it triggers a warning-confirmation app event.

**Data flow**: Consumes the current cwd, workspace roots, environment map, logs directory, permission profile, and app event sender. It first derives `ResolvedWindowsSandboxPermissions` from the permission profile and workspace roots; if that fails, it returns immediately. Otherwise it spawns a blocking task that calls `apply_world_writable_scan_and_denies_for_permissions(...)` and, on error, sends a failure warning event via `send_world_writable_scan_failed`.

**Call relations**: Called from Windows-specific app setup or permission flows when sandbox scanning is needed. It delegates permission derivation and the actual filesystem scan to the `codex_windows_sandbox` crate, and delegates failure reporting to `send_world_writable_scan_failed`.

*Call graph*: calls 1 internal fn (try_from_permission_profile_for_workspace_roots); 1 external calls (spawn_blocking).


##### `send_world_writable_scan_failed`  (lines 53–61)

```
fn send_world_writable_scan_failed(tx: &AppEventSender)
```

**Purpose**: Sends a standardized app event indicating that the Windows world-writable scan failed and the UI should open a warning confirmation without sample paths. It packages the failure into one consistent event shape.

**Data flow**: Accepts an `AppEventSender`, constructs `AppEvent::OpenWorldWritableWarningConfirmation` with `preset: None`, `profile_selection: None`, empty `sample_paths`, `extra_count: 0`, and `failed_scan: true`, and sends it through the channel. It returns unit.

**Call relations**: Used only by the background scan task in `App::spawn_world_writable_scan` when the scan operation returns an error. It isolates the exact warning payload from the scanning logic.

*Call graph*: calls 1 internal fn (send); 1 external calls (new).


##### `side_return_shortcut_matches`  (lines 63–74)

```
fn side_return_shortcut_matches(key_event: KeyEvent) -> bool
```

**Purpose**: Recognizes the Ctrl-C and Ctrl-D key presses that act as side-conversation return shortcuts. It is intentionally limited to press events so releases do not trigger navigation.

**Data flow**: Reads a `KeyEvent`, pattern-matches for `KeyCode::Char(c)` with `KeyModifiers::CONTROL` and `KeyEventKind::Press`, then returns true when `c` is ASCII-equal to `c` or `d` in either case. It mutates no state.

**Call relations**: Called by higher-level input dispatch in `App::handle_key_event` before ordinary widget handling. It encapsulates the exact shortcut predicate so the input module does not duplicate key matching logic.

*Call graph*: 1 external calls (matches!).


##### `tests::side_return_shortcuts_match_ctrl_c_and_ctrl_d`  (lines 81–108)

```
fn side_return_shortcuts_match_ctrl_c_and_ctrl_d()
```

**Purpose**: Verifies that the side-return shortcut predicate accepts Ctrl-C/Ctrl-D in either case and rejects unrelated Esc press/release events. It locks down the intended key semantics.

**Data flow**: Constructs several `KeyEvent` values with `KeyEvent::new` and `KeyEvent::new_with_kind`, passes them to `side_return_shortcut_matches`, and asserts the expected true/false outcomes. It mutates no shared state.

**Call relations**: Run by the test harness as the specification for `side_return_shortcut_matches`. It directly exercises the predicate with representative accepted and rejected inputs.

*Call graph*: 1 external calls (assert!).


### `tui/src/clipboard_paste.rs`

`io_transport` · `user paste handling and related normalization tests`

This module covers two related but distinct concerns: image paste from the clipboard and normalization of pasted text into search queries or paths. For images, it defines `PasteImageError` with user-facing variants for clipboard access, missing image data, encoding failure, and I/O failure, plus `EncodedImageFormat` and `PastedImageInfo` metadata. `paste_image_as_png` is the core non-Android implementation: it opens `arboard::Clipboard`, prefers clipboard file-list entries that can be opened by `image::open`, otherwise falls back to raw clipboard image bytes from `get_image`, reconstructs an `image::RgbaImage`, and encodes the resulting `DynamicImage` to PNG bytes while recording tracing spans. `paste_image_to_temp_png` then persists those bytes to a uniquely named tempfile and, on Linux, falls back to a WSL-specific path if clipboard access failed.

The WSL fallback path is careful and narrow: only clipboard-unavailable or no-image errors trigger it, `is_probably_wsl` must succeed, PowerShell is asked to dump the Windows clipboard image to a temporary PNG, and the resulting Windows path is converted to a `/mnt/<drive>/...` WSL path before dimensions are probed.

The text normalization helpers collapse whitespace for search queries and parse pasted paths from `file://` URLs, quoted strings, shell-escaped single paths, Windows drive paths, and UNC paths. On Linux under WSL, Windows drive-letter paths are converted into WSL mount paths. The tests focus on these normalization rules and extension-based image-format inference.

#### Function details

##### `PasteImageError::fmt`  (lines 14–21)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Formats each `PasteImageError` variant into a user-facing message with a stable prefix describing the failure category. It gives callers readable errors without exposing enum internals.

**Data flow**: It matches on `self` and writes one of four strings into the provided formatter: `clipboard unavailable: ...`, `no image on clipboard: ...`, `could not encode image: ...`, or `io error: ...`.

**Call relations**: This `Display` implementation is used implicitly whenever paste-image errors are rendered or logged. It does not participate in control flow beyond formatting.

*Call graph*: 1 external calls (write!).


##### `EncodedImageFormat::label`  (lines 33–39)

```
fn label(self) -> &'static str
```

**Purpose**: Returns a short uppercase label for an encoded image format. The labels are intended for compact UI display.

**Data flow**: It matches `self` and returns the static string `PNG`, `JPEG`, or `IMG`.

**Call relations**: This is a pure helper on the enum and is used wherever the UI needs a concise format label.


##### `paste_image_as_png`  (lines 113–117)

```
fn paste_image_as_png() -> Result<(Vec<u8>, PastedImageInfo), PasteImageError>
```

**Purpose**: Reads an image from the system clipboard and encodes it as PNG bytes along with width, height, and format metadata. It accepts either clipboard file references or raw image data and prefers files when both are present.

**Data flow**: On non-Android targets it enters tracing spans, creates `arboard::Clipboard::new()`, and maps clipboard-construction errors to `PasteImageError::ClipboardUnavailable`. It then tries `cb.get().file_list()`, converting errors to the same variant; if any listed file can be opened with `image::open`, that `DynamicImage` is used. Otherwise it calls `cb.get_image()`, maps failure to `PasteImageError::NoImage`, converts the returned width, height, and owned RGBA bytes into `image::RgbaImage::from_raw`, and errors with `EncodeFailed("invalid RGBA buffer")` if reconstruction fails. The chosen image is written to a `Vec<u8>` through a `Cursor` using `image::ImageFormat::Png`, with encoding errors mapped to `EncodeFailed`. On success it returns `(png_bytes, PastedImageInfo { width, height, encoded_format: EncodedImageFormat::Png })`.

**Call relations**: This is the primary clipboard-image reader and is called by `paste_image_to_temp_png`. If it fails on Linux with clipboard-unavailable or no-image errors, the caller may attempt the WSL fallback path.

*Call graph*: calls 1 internal fn (new); called by 1 (paste_image_to_temp_png); 8 external calls (new, new, ImageRgba8, from_raw, debug!, debug_span!, ClipboardUnavailable, EncodeFailed).


##### `try_wsl_clipboard_fallback`  (lines 159–193)

```
fn try_wsl_clipboard_fallback(
    error: &PasteImageError,
) -> Result<(PathBuf, PastedImageInfo), PasteImageError>
```

**Purpose**: Attempts to recover clipboard image paste under WSL by asking Windows PowerShell to dump the clipboard image to a temporary PNG and then mapping that path back into WSL. It only activates for clipboard-access or no-image failures that are plausibly caused by WSL clipboard limitations.

**Data flow**: It takes the original `PasteImageError` by reference, returns `Err(error.clone())` immediately unless `is_probably_wsl()` is true and the error matches `ClipboardUnavailable(_) | NoImage(_)`, then logs a debug message and calls `try_dump_windows_clipboard_image()`. If no Windows path is produced, path conversion fails, or `image::image_dimensions(&mapped_path)` fails, it returns the cloned original error. Otherwise it returns `(mapped_path, PastedImageInfo { width: w, height: h, encoded_format: EncodedImageFormat::Png })` without copying the file.

**Call relations**: This helper is called only from `paste_image_to_temp_png` on Linux after `paste_image_as_png` fails. It delegates Windows-side extraction to `try_dump_windows_clipboard_image` and path translation to `convert_windows_path_to_wsl`.

*Call graph*: calls 3 internal fn (convert_windows_path_to_wsl, is_probably_wsl, try_dump_windows_clipboard_image); called by 1 (paste_image_to_temp_png); 4 external calls (image_dimensions, matches!, debug!, clone).


##### `try_dump_windows_clipboard_image`  (lines 199–229)

```
fn try_dump_windows_clipboard_image() -> Option<String>
```

**Purpose**: Runs a PowerShell script under several common executable names to save the Windows clipboard image to a temporary PNG and print the resulting Windows path. It returns `None` if no command succeeds or no image is present.

**Data flow**: It defines a PowerShell script that forces UTF-8 output, calls `Get-Clipboard -Format Image`, saves the image to a temp `.png`, and writes the path. It iterates over `powershell.exe`, `pwsh`, and `powershell`, spawning each with `-NoProfile -Command <script>` and capturing output. For the first successful command with non-empty stdout, it decodes stdout with `String::from_utf8_lossy`, trims it, logs a debug message, and returns `Some(win_path)`; non-zero exits and spawn failures are logged and skipped. If all commands fail, it returns `None`.

**Call relations**: This function is used exclusively by `try_wsl_clipboard_fallback` as the Windows-side extraction step.

*Call graph*: called by 1 (try_wsl_clipboard_fallback); 3 external calls (from_utf8_lossy, new, debug!).


##### `paste_image_to_temp_png`  (lines 232–237)

```
fn paste_image_to_temp_png() -> Result<(PathBuf, PastedImageInfo), PasteImageError>
```

**Purpose**: Convenience wrapper that turns clipboard image paste into a persisted temporary PNG file path plus metadata. It handles both the normal clipboard path and the Linux WSL fallback path.

**Data flow**: On non-Android targets it first calls `paste_image_as_png()`. On success it creates a tempfile with prefix `codex-clipboard-` and suffix `.png` using `tempfile::Builder`, writes the PNG bytes to `tmp.path()`, persists the tempfile with `keep()`, and returns the resulting `PathBuf` plus the original `PastedImageInfo`. On error, Linux builds call `try_wsl_clipboard_fallback(&e).or(Err(e))`, while other platforms simply return the original error.

**Call relations**: This is the higher-level image-paste API used by the TUI when it wants a file path rather than in-memory bytes. It delegates clipboard reading to `paste_image_as_png` and only invokes `try_wsl_clipboard_fallback` when the primary path fails on Linux.

*Call graph*: calls 2 internal fn (paste_image_as_png, try_wsl_clipboard_fallback); 3 external calls (new, write, ClipboardUnavailable).


##### `normalize_pasted_search_query`  (lines 240–243)

```
fn normalize_pasted_search_query(pasted: &str) -> Option<String>
```

**Purpose**: Normalizes arbitrary pasted text into a single-line search query by collapsing all whitespace runs to single spaces. It rejects inputs that become empty after normalization.

**Data flow**: It splits `pasted` on Unicode whitespace, collects the pieces into a `Vec<_>`, joins them with single spaces, and returns `Some(normalized)` only if the result is non-empty; otherwise it returns `None`.

**Call relations**: This helper is called by paste-handling code for search inputs. It is intentionally simple and independent of the image/path logic in the rest of the module.

*Call graph*: called by 2 (handle_paste, handle_paste).


##### `normalize_pasted_path`  (lines 251–287)

```
fn normalize_pasted_path(pasted: &str) -> Option<PathBuf>
```

**Purpose**: Attempts to interpret pasted text as exactly one filesystem path across several common representations, including file URLs, quoted paths, shell-escaped paths, Windows drive paths, and UNC paths. It avoids POSIX shell parsing pitfalls for raw Windows paths containing backslashes.

**Data flow**: It trims the input, strips matching single or double quotes when present, and first tries to parse the unquoted text as a `url::Url`; if the scheme is `file`, it returns `url.to_file_path().ok()`. Next it calls `normalize_windows_path(unquoted)` and returns that if successful, bypassing `shlex` for raw Windows paths. Otherwise it tokenizes the original `pasted` string with `shlex::Shlex`; if exactly one token results, it checks that token again with `normalize_windows_path` and falls back to `PathBuf::from(part)`. If multiple tokens remain, it returns `None`.

**Call relations**: This function is used by paste handlers that accept image/file paths and is heavily covered by unit tests for URLs, quoting, shell escaping, Windows paths, and UNC paths. It delegates Windows-specific recognition and optional WSL conversion to `normalize_windows_path`.

*Call graph*: calls 1 internal fn (normalize_windows_path); called by 12 (handle_paste_image_path, normalize_double_quoted_windows_path, normalize_file_url, normalize_file_url_windows, normalize_multiple_tokens_returns_none, normalize_shell_escaped_single_path, normalize_simple_quoted_path_fallback, normalize_single_quoted_unix_path, normalize_single_quoted_windows_path, normalize_unc_windows_path (+2 more)); 3 external calls (from, new, parse).


##### `is_probably_wsl`  (lines 290–303)

```
fn is_probably_wsl() -> bool
```

**Purpose**: Heuristically detects whether the current Linux process is running under WSL. It combines `/proc/version` inspection with environment-variable fallbacks for nonstandard kernels.

**Data flow**: It first tries to read `/proc/version`; if successful, it lowercases the contents and returns `true` if they contain `microsoft` or `wsl`. If not, it checks whether `WSL_DISTRO_NAME` or `WSL_INTEROP` is present in the environment and returns that boolean.

**Call relations**: This detector is used by both clipboard and path-normalization logic: `try_wsl_clipboard_fallback`, `normalize_windows_path`, and the clipboard-copy module's `is_wsl_session` all rely on it to enable WSL-specific behavior.

*Call graph*: called by 11 (footer_props, paste_image_shortcut_prefers_ctrl_alt_v_under_wsl, is_wsl_session, normalize_windows_path, normalize_double_quoted_windows_path, normalize_file_url_windows, normalize_single_quoted_windows_path, normalize_unquoted_windows_path_with_spaces, normalize_windows_path_in_wsl, try_wsl_clipboard_fallback (+1 more)); 2 external calls (var_os, read_to_string).


##### `convert_windows_path_to_wsl`  (lines 306–331)

```
fn convert_windows_path_to_wsl(input: &str) -> Option<PathBuf>
```

**Purpose**: Converts a Windows drive-letter path into the corresponding `/mnt/<drive>/...` WSL path. It intentionally refuses UNC paths because there is no simple direct mapping here.

**Data flow**: It returns `None` immediately for inputs starting with `\\`. Otherwise it extracts the first character as a drive letter, requires it to be ASCII alphabetic, requires `:` at index 1, and builds a `PathBuf` starting with `/mnt/<lowercased-drive>`. It then trims leading separators from the remainder, splits on both `\` and `/`, filters empty components, pushes each component onto the path, and returns `Some(result)`.

**Call relations**: This helper is called by `normalize_windows_path` and `try_wsl_clipboard_fallback` whenever a Windows path needs to be mapped into the Linux filesystem view under WSL.

*Call graph*: called by 6 (normalize_windows_path, normalize_double_quoted_windows_path, normalize_file_url_windows, normalize_single_quoted_windows_path, normalize_unquoted_windows_path_with_spaces, try_wsl_clipboard_fallback); 2 external calls (from, format!).


##### `normalize_windows_path`  (lines 333–361)

```
fn normalize_windows_path(input: &str) -> Option<PathBuf>
```

**Purpose**: Recognizes Windows drive-letter and UNC paths and returns them as `PathBuf`s, optionally converting drive-letter paths into WSL mount paths when running under WSL. It exists to avoid misparsing backslashes as shell escapes.

**Data flow**: It inspects the input to determine whether it matches a drive path like `C:\` or `C:/` or a UNC path beginning with `\\`. If neither pattern matches, it returns `None`. On Linux, if `is_probably_wsl()` is true and `convert_windows_path_to_wsl(input)` succeeds, it returns the converted path; otherwise it returns `Some(PathBuf::from(input))` unchanged.

**Call relations**: This helper is called by `normalize_pasted_path` before and after shell tokenization. It centralizes Windows-path recognition and the optional WSL conversion policy.

*Call graph*: calls 2 internal fn (convert_windows_path_to_wsl, is_probably_wsl); called by 1 (normalize_pasted_path); 1 external calls (from).


##### `pasted_image_format`  (lines 364–375)

```
fn pasted_image_format(path: &Path) -> EncodedImageFormat
```

**Purpose**: Infers a coarse encoded image format from a file path's extension. It is used for UI metadata when a pasted image path already exists on disk.

**Data flow**: It reads `path.extension()`, converts it to lowercase text when possible, and returns `EncodedImageFormat::Png` for `png`, `EncodedImageFormat::Jpeg` for `jpg` or `jpeg`, and `EncodedImageFormat::Other` otherwise.

**Call relations**: This helper is called by paste-handling code that accepts image file paths rather than clipboard image bytes. It is also covered by tests for Unix and Windows-style paths.

*Call graph*: called by 1 (handle_paste_image_path); 1 external calls (extension).


##### `pasted_search_query_tests::collapses_whitespace`  (lines 382–387)

```
fn collapses_whitespace()
```

**Purpose**: Tests that pasted search queries collapse mixed whitespace into single spaces. It verifies the normalization contract for search input.

**Data flow**: It calls `normalize_pasted_search_query` with a string containing spaces, tabs, and newlines and asserts that the result is `Some("alpha beta gamma")`.

**Call relations**: This test directly exercises `normalize_pasted_search_query`.

*Call graph*: 1 external calls (assert_eq!).


##### `pasted_paths_tests::normalize_file_url`  (lines 396–400)

```
fn normalize_file_url()
```

**Purpose**: Tests that a Unix `file://` URL is converted into the corresponding local path. It validates the URL parsing branch of path normalization.

**Data flow**: It passes `file:///tmp/example.png` to `normalize_pasted_path`, unwraps the result, and asserts equality with `PathBuf::from("/tmp/example.png")`.

**Call relations**: This test covers the early file-URL branch in `normalize_pasted_path`.

*Call graph*: calls 1 internal fn (normalize_pasted_path); 1 external calls (assert_eq!).


##### `pasted_paths_tests::normalize_file_url_windows`  (lines 403–417)

```
fn normalize_file_url_windows()
```

**Purpose**: Tests normalization of a Windows drive path input, including optional conversion to a WSL mount path when running under WSL. It verifies that raw Windows paths are accepted without shell parsing.

**Data flow**: It calls `normalize_pasted_path` on `C:\Temp\example.png`, computes the expected path as either `convert_windows_path_to_wsl(input)` under WSL or the original `PathBuf` otherwise, and asserts equality.

**Call relations**: This test exercises `normalize_windows_path` through `normalize_pasted_path` and also validates the WSL conversion branch when applicable.

*Call graph*: calls 3 internal fn (convert_windows_path_to_wsl, is_probably_wsl, normalize_pasted_path); 2 external calls (from, assert_eq!).


##### `pasted_paths_tests::normalize_shell_escaped_single_path`  (lines 420–424)

```
fn normalize_shell_escaped_single_path()
```

**Purpose**: Tests that a shell-escaped Unix path containing spaces is unescaped into a single `PathBuf`. It validates the `shlex` single-token branch.

**Data flow**: It passes `/home/user/My\ File.png` to `normalize_pasted_path`, unwraps the result, and asserts equality with `/home/user/My File.png`.

**Call relations**: This test covers the shell-tokenization fallback path in `normalize_pasted_path`.

*Call graph*: calls 1 internal fn (normalize_pasted_path); 1 external calls (assert_eq!).


##### `pasted_paths_tests::normalize_simple_quoted_path_fallback`  (lines 427–431)

```
fn normalize_simple_quoted_path_fallback()
```

**Purpose**: Tests that a simply double-quoted Unix path is accepted after trimming quotes. It validates the initial quote-stripping logic.

**Data flow**: It calls `normalize_pasted_path` with `"/home/user/My File.png"` and asserts the resulting `PathBuf` equals `/home/user/My File.png`.

**Call relations**: This test exercises the quote-stripping branch before URL and shell parsing.

*Call graph*: calls 1 internal fn (normalize_pasted_path); 1 external calls (assert_eq!).


##### `pasted_paths_tests::normalize_single_quoted_unix_path`  (lines 434–438)

```
fn normalize_single_quoted_unix_path()
```

**Purpose**: Tests that a single-quoted Unix path is normalized correctly. It verifies that quoted single-path inputs survive normalization.

**Data flow**: It passes `'/home/user/My File.png'` to `normalize_pasted_path`, unwraps the result, and asserts equality with the unquoted path.

**Call relations**: This test covers another quote-handling case in `normalize_pasted_path`.

*Call graph*: calls 1 internal fn (normalize_pasted_path); 1 external calls (assert_eq!).


##### `pasted_paths_tests::normalize_multiple_tokens_returns_none`  (lines 441–446)

```
fn normalize_multiple_tokens_returns_none()
```

**Purpose**: Tests that pasted text representing more than one shell token is rejected as ambiguous rather than treated as a path. It enforces the single-path invariant.

**Data flow**: It passes `/home/user/a\ b.png /home/user/c.png` to `normalize_pasted_path` and asserts that the result is `None`.

**Call relations**: This test targets the `parts.len() != 1` rejection branch in `normalize_pasted_path`.

*Call graph*: calls 1 internal fn (normalize_pasted_path); 1 external calls (assert!).


##### `pasted_paths_tests::pasted_image_format_png_jpeg_unknown`  (lines 449–470)

```
fn pasted_image_format_png_jpeg_unknown()
```

**Purpose**: Tests extension-based image format inference for PNG, JPEG, missing extension, and unknown extension cases. It verifies case-insensitive matching.

**Data flow**: It calls `pasted_image_format` on several `Path` values and asserts the expected `EncodedImageFormat` for each.

**Call relations**: This test directly exercises `pasted_image_format`.

*Call graph*: 1 external calls (assert_eq!).


##### `pasted_paths_tests::normalize_single_quoted_windows_path`  (lines 473–489)

```
fn normalize_single_quoted_windows_path()
```

**Purpose**: Tests that a single-quoted Windows path is accepted and optionally converted under WSL. It validates quote stripping plus Windows-path recognition.

**Data flow**: It passes a single-quoted Windows path to `normalize_pasted_path`, computes the expected result as either a WSL-converted path or the original Windows path, and asserts equality.

**Call relations**: This test covers the interaction between quote stripping and `normalize_windows_path`.

*Call graph*: calls 3 internal fn (convert_windows_path_to_wsl, is_probably_wsl, normalize_pasted_path); 2 external calls (from, assert_eq!).


##### `pasted_paths_tests::normalize_double_quoted_windows_path`  (lines 492–508)

```
fn normalize_double_quoted_windows_path()
```

**Purpose**: Tests that a double-quoted Windows path is accepted and optionally converted under WSL. It mirrors the previous test for double quotes.

**Data flow**: It calls `normalize_pasted_path` with a double-quoted Windows path, computes the expected path using `is_probably_wsl` and `convert_windows_path_to_wsl` when relevant, and asserts equality.

**Call relations**: This test exercises the same normalization path as the single-quoted Windows case but with double-quote stripping.

*Call graph*: calls 3 internal fn (convert_windows_path_to_wsl, is_probably_wsl, normalize_pasted_path); 2 external calls (from, assert_eq!).


##### `pasted_paths_tests::normalize_unquoted_windows_path_with_spaces`  (lines 511–525)

```
fn normalize_unquoted_windows_path_with_spaces()
```

**Purpose**: Tests that an unquoted Windows path containing spaces is still recognized as a single path. It validates the deliberate bypass of POSIX `shlex` for raw Windows paths.

**Data flow**: It passes an unquoted Windows path with spaces to `normalize_pasted_path`, computes the expected WSL-converted or unchanged path, and asserts equality.

**Call relations**: This test specifically validates why `normalize_pasted_path` checks `normalize_windows_path` before shell tokenization.

*Call graph*: calls 3 internal fn (convert_windows_path_to_wsl, is_probably_wsl, normalize_pasted_path); 2 external calls (from, assert_eq!).


##### `pasted_paths_tests::normalize_unc_windows_path`  (lines 528–535)

```
fn normalize_unc_windows_path()
```

**Purpose**: Tests that UNC paths are accepted as Windows paths and preserved as-is. It verifies the UNC recognition branch.

**Data flow**: It passes a UNC path string to `normalize_pasted_path`, unwraps the result, and asserts equality with the same UNC `PathBuf`.

**Call relations**: This test covers the UNC branch in `normalize_windows_path`, which intentionally does not convert UNC paths to WSL paths.

*Call graph*: calls 1 internal fn (normalize_pasted_path); 1 external calls (assert_eq!).


##### `pasted_paths_tests::pasted_image_format_with_windows_style_paths`  (lines 538–551)

```
fn pasted_image_format_with_windows_style_paths()
```

**Purpose**: Tests image-format inference on Windows-style path strings. It ensures extension parsing works regardless of path separator style.

**Data flow**: It calls `pasted_image_format` on Windows-style `Path` values ending in `.PNG`, `.jpeg`, and no extension, then asserts the expected enum values.

**Call relations**: This test extends `pasted_image_format` coverage to Windows-style paths.

*Call graph*: 1 external calls (assert_eq!).


##### `pasted_paths_tests::normalize_windows_path_in_wsl`  (lines 555–567)

```
fn normalize_windows_path_in_wsl()
```

**Purpose**: Tests actual Windows-to-WSL path conversion on real WSL systems. It is skipped when not running under WSL.

**Data flow**: It first checks `is_probably_wsl()` and returns early if false. Otherwise it passes a Windows path to `normalize_pasted_path`, unwraps the result, and asserts equality with the expected `/mnt/c/...` path.

**Call relations**: This test directly validates the runtime WSL conversion branch in `normalize_windows_path`.

*Call graph*: calls 2 internal fn (is_probably_wsl, normalize_pasted_path); 1 external calls (assert_eq!).


### `tui/src/external_agent_config_migration_flow.rs`

`orchestration` · `request handling`

This file is the orchestration layer around the migration prompt and app-server APIs. It defines four public message constants for finished, no-items, remote-unavailable, and daemon-unavailable cases, plus the `ExternalAgentConfigMigrationFlowOutcome` enum used by callers to distinguish a started import from a no-op or cancellation.

The main async function, `handle_external_agent_config_migration_prompt`, first enforces environment constraints in a strict order: remote workspaces are rejected, non-embedded app-server sessions are rejected, and an already-running import is rejected using the shared in-progress message constant. It then captures `config.cwd`, asks the app server to detect importable Claude Code configuration with `include_home: true` and the current working directory in `cwds`, and logs a warning plus returns a formatted error if detection fails.

If no items are detected, it returns `NoItems`. Otherwise it initializes `selected_items` to all detected items and enters a loop that repeatedly shows `run_external_agent_config_migration_prompt`, passing any prior import error back into the UI. On `Proceed(items)`, it attempts `external_agent_config_import(items)`. Success returns `Started(...)` with a message built from the number of remaining unselected items; failure logs and stores `Import failed: ...` so the prompt reopens with inline feedback. On `Skip`, it returns `Cancelled`. The helper functions encapsulate the exact wording for the success message and the optional handoff text when some items remain for a later `/import` run.

#### Function details

##### `external_agent_config_migration_success_message`  (lines 22–28)

```
fn external_agent_config_migration_success_message(remaining_item_count: usize) -> String
```

**Purpose**: Builds the success text shown after an import starts, optionally appending guidance about items left for a later run. It keeps the base message stable while delegating pluralization and omission rules to a helper.

**Data flow**: It takes `remaining_item_count`, starts from a fixed base sentence, calls `remaining_items_handoff(remaining_item_count)`, and either concatenates the returned suffix with `format!` or returns the base sentence unchanged. It reads no external state and returns a `String`.

**Call relations**: This helper is called only from `handle_external_agent_config_migration_prompt` after a successful `external_agent_config_import`. It depends on `remaining_items_handoff` to decide whether there is any follow-up guidance to append.

*Call graph*: calls 1 internal fn (remaining_items_handoff); called by 1 (handle_external_agent_config_migration_prompt); 1 external calls (format!).


##### `remaining_items_handoff`  (lines 30–41)

```
fn remaining_items_handoff(remaining_item_count: usize) -> Option<String>
```

**Purpose**: Formats the optional follow-up sentence describing how many importable items remain after the current selection. It handles the zero, singular, and plural cases explicitly.

**Data flow**: It takes `remaining_item_count`, matches on the count, and returns `None` for zero, a fixed singular sentence for one, or a pluralized `format!` string for any larger count. It has no side effects and returns `Option<String>`.

**Call relations**: This function is used only by `external_agent_config_migration_success_message` to keep count-specific wording separate from the base success text.

*Call graph*: called by 1 (external_agent_config_migration_success_message); 1 external calls (format!).


##### `handle_external_agent_config_migration_prompt`  (lines 43–120)

```
async fn handle_external_agent_config_migration_prompt(
    tui: &mut tui::Tui,
    app_server: &mut AppServerSession,
    config: &Config,
) -> Result<ExternalAgentConfigMigrationFlowOutcome, String>
```

**Purpose**: Runs the full import interaction: validates whether import is allowed, detects candidate items, shows the prompt, retries on import failure, and returns a flow outcome for the caller. It is the single driver for this feature from the TUI event layer.

**Data flow**: It receives mutable access to the `tui::Tui` and `AppServerSession`, plus immutable `Config`. It reads app-server state via `uses_remote_workspace`, `uses_embedded_app_server`, and `external_agent_config_import_in_progress`; reads `config.cwd`; calls `external_agent_config_detect` with `include_home: true` and the current cwd; then either returns an error string, `NoItems`, or enters a loop. Inside the loop it passes `detected_items`, current `selected_items`, and optional `error` text into `run_external_agent_config_migration_prompt`. On `Proceed(items)`, it writes `selected_items = items.clone()`, calls `external_agent_config_import(items)`, and on success returns `Started(success_message)`; on failure it logs and updates `error` so the next prompt render includes the failure. On `Skip`, it returns `Cancelled`.

**Call relations**: The TUI event handler invokes this async function when the user triggers the import command. It delegates UI interaction to `run_external_agent_config_migration_prompt`, delegates detection/import RPCs to `AppServerSession`, and uses `external_agent_config_migration_success_message` only after the import request has been accepted.

*Call graph*: calls 7 internal fn (external_agent_config_detect, external_agent_config_import, external_agent_config_import_in_progress, uses_embedded_app_server, uses_remote_workspace, run_external_agent_config_migration_prompt, external_agent_config_migration_success_message); called by 1 (handle_event); 4 external calls (format!, warn!, Started, vec!).


### `tui/src/theme_picker.rs`

`domain_logic` · `interactive picker rendering`

This file assembles the complete theme-picker experience for the TUI. It defines small preview-domain types (`PreviewDiffKind`, `PreviewRow`) plus two fixed preview datasets: a 4-line narrow diff and an 8-line wide diff. These samples are rendered by `render_preview`, which syntax-highlights the concatenated Rust snippet, computes line-number width, maps preview row kinds into `DiffLineType`, wraps each row using the same diff-render helpers as real diffs, and paints only the first wrapped line into the provided `Buffer`. Wide mode vertically centers the preview and applies a two-column left inset; narrow mode renders flush-left below the list.

The picker subtitle is width-sensitive. `subtitle_available_width` computes the usable list width based on popup sizing and whether side-by-side layout fits. `theme_picker_subtitle` prefers a concrete message pointing users to `{CODEX_HOME}/themes`, but only when the formatted path begins with `~` and the full sentence fits the available width; otherwise it falls back to a generic preview instruction string.

`build_theme_picker_params` is the orchestration point. It snapshots the current syntax theme for cancel-restore, lists available bundled and custom themes, resolves the effective current theme name by honoring `current_name` only if it is actually available, and builds `SelectionItem`s whose actions send `AppEvent::SyntaxThemeSelected`. It separately derives preview theme names from the final item list so preview indexing stays aligned even if item construction changes. The `on_selection_changed` callback resolves and applies the highlighted theme, then emits `SyntaxThemePreviewed`; `on_cancel` restores the original theme and emits the same event. The returned `SelectionViewParams` enables search, side content, stacked fallback preview, and background preservation.

#### Function details

##### `preview_diff_line_type`  (lines 148–154)

```
fn preview_diff_line_type(kind: PreviewDiffKind) -> DiffLineType
```

**Purpose**: Maps the local preview-specific diff kind enum into the shared diff renderer’s `DiffLineType`. This keeps preview sample rows compatible with the normal diff styling pipeline.

**Data flow**: Takes `kind: PreviewDiffKind`, matches `Context`, `Added`, or `Removed`, and returns `DiffLineType::Context`, `Insert`, or `Delete` respectively.

**Call relations**: Used only by `render_preview` while converting static preview rows into renderable diff lines.

*Call graph*: called by 1 (render_preview).


##### `centered_offset`  (lines 156–164)

```
fn centered_offset(available: u16, content: u16, min_frame: u16) -> u16
```

**Purpose**: Computes a vertical offset that centers content within available space while optionally preserving a minimum frame padding on top and bottom. It avoids negative math by using saturating arithmetic.

**Data flow**: Consumes `available`, `content`, and `min_frame`, computes free space, decides whether both top and bottom frame padding can be honored, and returns the top offset as `u16`.

**Call relations**: Called by `render_preview` only when wide preview mode requests vertical centering.

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

**Purpose**: Renders a fixed diff-style code preview into a Ratatui buffer, optionally vertically centered and horizontally inset. It reuses the real syntax-highlighting and diff-wrapping pipeline so theme previews look like actual code blocks.

**Data flow**: Takes a target `Rect`, mutable `Buffer`, a slice of `PreviewRow`, and layout flags. It early-returns on zero-sized areas or empty row lists, joins preview code into one Rust snippet, syntax-highlights it, computes line-number width from the maximum preview line number, derives top/left padding, then iterates visible rows. For each row it maps kind via `preview_diff_line_type`, wraps/stylizes the line using either syntax-aware or plain diff helpers, selects the first wrapped `Line`, and renders it into the buffer.

**Call relations**: This is the shared renderer behind both `ThemePreviewWideRenderable::render` and `ThemePreviewNarrowRenderable::render`. It delegates styling and wrapping to the diff/highlight subsystems so preview visuals stay consistent with the rest of the TUI.

*Call graph*: calls 7 internal fn (current_diff_render_style_context, line_number_width, push_wrapped_diff_line_with_style_context, push_wrapped_diff_line_with_syntax_and_style_context, highlight_code_to_styled_spans, centered_offset, preview_diff_line_type); called by 2 (render, render); 4 external calls (new, is_empty, iter, len).


##### `ThemePreviewWideRenderable::desired_height`  (lines 238–240)

```
fn desired_height(&self, _width: u16) -> u16
```

**Purpose**: Advertises that the wide preview can consume all available vertical space. This allows the side panel to fill its container and let the preview center itself vertically.

**Data flow**: Ignores the provided width and returns `u16::MAX`.

**Call relations**: Used by layout code through the `Renderable` trait when sizing side content for the theme picker.


##### `ThemePreviewWideRenderable::render`  (lines 242–250)

```
fn render(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Renders the wide side-panel preview using the larger sample diff, vertical centering, and a two-column inset.

**Data flow**: Receives `area` and mutable `buf`, then calls `render_preview(area, buf, &WIDE_PREVIEW_ROWS, true, WIDE_PREVIEW_LEFT_INSET)`.

**Call relations**: This is the concrete side-content renderer installed by `build_theme_picker_params` for side-by-side layouts.

*Call graph*: calls 1 internal fn (render_preview).


##### `ThemePreviewNarrowRenderable::desired_height`  (lines 254–256)

```
fn desired_height(&self, _width: u16) -> u16
```

**Purpose**: Reports the exact height needed for the compact stacked preview. The height equals the number of fixed preview rows.

**Data flow**: Ignores width and returns `NARROW_PREVIEW_ROWS.len() as u16`.

**Call relations**: Used by layout code through the `Renderable` trait when stacked preview mode is active.


##### `ThemePreviewNarrowRenderable::render`  (lines 258–266)

```
fn render(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Renders the compact stacked preview using the four-line sample diff without centering or inset.

**Data flow**: Receives `area` and mutable `buf`, then calls `render_preview(area, buf, &NARROW_PREVIEW_ROWS, false, 0)`.

**Call relations**: Installed by `build_theme_picker_params` as `stacked_side_content` for narrow terminals.

*Call graph*: calls 1 internal fn (render_preview).


##### `subtitle_available_width`  (lines 269–281)

```
fn subtitle_available_width(terminal_width: Option<u16>) -> usize
```

**Purpose**: Computes how much horizontal space the picker subtitle can safely occupy, accounting for popup width and whether side-by-side preview layout will split the content area.

**Data flow**: Takes `terminal_width: Option<u16>`, defaults to 80 when absent, computes popup content width, then either returns the list-pane width from `side_by_side_layout_widths` or the full popup content width as `usize`.

**Call relations**: Called by `theme_picker_subtitle` to decide whether the path-specific subtitle sentence will fit.

*Call graph*: called by 1 (theme_picker_subtitle); 2 external calls (popup_content_width, side_by_side_layout_widths).


##### `theme_picker_subtitle`  (lines 283–300)

```
fn theme_picker_subtitle(codex_home: Option<&Path>, terminal_width: Option<u16>) -> String
```

**Purpose**: Builds the subtitle shown under the theme picker title, preferring a concrete `~/.codex/themes` guidance sentence when it fits and falling back to a generic live-preview hint otherwise.

**Data flow**: Takes optional `codex_home` and `terminal_width`, derives `themes_dir = codex_home.join("themes")`, formats it with `format_directory_display`, computes available width via `subtitle_available_width`, and if the formatted path starts with `~` and the full sentence fits by display width, returns that sentence. Otherwise it returns `PREVIEW_FALLBACK_SUBTITLE.to_string()`.

**Call relations**: Used by `build_theme_picker_params` when assembling the picker view model. Several tests call it directly to verify width-sensitive and tilde-path fallback behavior.

*Call graph*: calls 1 internal fn (subtitle_available_width); called by 5 (build_theme_picker_params, subtitle_falls_back_for_94_column_terminal_side_by_side_layout, subtitle_falls_back_to_preview_instructions_without_tilde_path, subtitle_falls_back_when_tilde_path_subtitle_is_too_wide, subtitle_uses_tilde_path_when_codex_home_under_home_directory); 2 external calls (width, format!).


##### `build_theme_picker_params`  (lines 312–410)

```
fn build_theme_picker_params(
    current_name: Option<&str>,
    codex_home: Option<&Path>,
    terminal_width: Option<u16>,
) -> SelectionViewParams
```

**Purpose**: Constructs the full `SelectionViewParams` for the `/theme` picker, including items, initial selection, live preview callback, cancel-restore callback, subtitle, search settings, and responsive preview renderables.

**Data flow**: Consumes `current_name`, `codex_home`, and `terminal_width`. It snapshots `highlight::current_syntax_theme()`, loads theme entries with `highlight::list_available_themes`, resolves an effective current theme name by validating `current_name` against available entries or falling back to `highlight::configured_theme_name()`, then maps entries into `SelectionItem`s with display names, `is_current`, canonical `search_value`, and actions that send `AppEvent::SyntaxThemeSelected`. It derives `preview_theme_names` from the final items, builds `on_selection_changed` to resolve and apply the selected theme then send `SyntaxThemePreviewed`, builds `on_cancel` to restore the original theme and send the same event, and returns a populated `SelectionViewParams` with title, subtitle, footer hint, search config, side content, stacked fallback, and background-preservation flags.

**Call relations**: This function is called when the `/theme` command opens the picker and by tests validating picker configuration. It orchestrates helpers in this file plus the highlight subsystem and app-event channel, but does not itself persist config; instead item actions emit `AppEvent::SyntaxThemeSelected` for downstream handling.

*Call graph*: calls 5 internal fn (standard_popup_hint_line, configured_theme_name, current_syntax_theme, list_available_themes, theme_picker_subtitle); called by 6 (theme_picker_enables_side_content_background_preservation, theme_picker_subtitle_uses_fallback_text_in_94x35_terminal, open_theme_picker, theme_picker_items_include_search_values_for_preview_mapping, theme_picker_uses_half_width_with_stacked_fallback_preview, unavailable_configured_theme_falls_back_to_configured_or_default_selection); 2 external calls (new, default).


##### `tests::render_buffer`  (lines 418–423)

```
fn render_buffer(renderable: &dyn Renderable, width: u16, height: u16) -> Buffer
```

**Purpose**: Renders any `Renderable` into a fresh Ratatui `Buffer` for inspection in tests.

**Data flow**: Takes a `&dyn Renderable`, width, and height; creates a `Rect`, allocates `Buffer::empty(area)`, calls `renderable.render(area, &mut buf)`, and returns the filled buffer.

**Call relations**: Used by preview-rendering tests as the lowest-level helper for inspecting symbols and styles.

*Call graph*: 3 external calls (empty, new, render).


##### `tests::render_lines`  (lines 425–441)

```
fn render_lines(renderable: &dyn Renderable, width: u16, height: u16) -> Vec<String>
```

**Purpose**: Converts a rendered buffer into a vector of plain text lines for easier assertions in tests.

**Data flow**: Calls `render_buffer`, then iterates each row and column, reading `buf[(col, row)].symbol()`, substituting spaces for empty symbols, concatenating each row into a `String`, and returning `Vec<String>`.

**Call relations**: Used by multiple preview tests that assert line numbers, markers, padding, and textual layout.

*Call graph*: 1 external calls (render_buffer).


##### `tests::first_non_space_style_after_marker`  (lines 443–452)

```
fn first_non_space_style_after_marker(buf: &Buffer, row: u16, width: u16) -> Option<Modifier>
```

**Purpose**: Finds the first styled code cell after a diff marker on a given row and returns its modifier flags. It is used to verify deleted-line dimming.

**Data flow**: Scans columns in the provided `Buffer` row to find a `-` or `+` marker, then scans subsequent columns until a non-space symbol appears and returns that cell’s `style().add_modifier` as `Option<Modifier>`.

**Call relations**: Used by the deleted-preview styling test to inspect rendered style metadata rather than just text.


##### `tests::preview_line_number`  (lines 454–465)

```
fn preview_line_number(line: &str) -> Option<usize>
```

**Purpose**: Parses a rendered preview line to extract its leading line number if present.

**Data flow**: Trims leading spaces, counts leading ASCII digits, verifies they are followed by a space, parses the digit slice as `usize`, and returns `Option<usize>`.

**Call relations**: Used by preview layout tests to identify which rendered rows correspond to preview content.


##### `tests::preview_line_marker`  (lines 467–478)

```
fn preview_line_marker(line: &str) -> Option<char>
```

**Purpose**: Parses a rendered preview line to extract the diff marker character following the line number.

**Data flow**: Trims leading spaces, counts leading ASCII digits, verifies a separating space, then returns the next character as `Option<char>`.

**Call relations**: Used by preview tests to count and locate added and removed lines.


##### `tests::theme_picker_uses_half_width_with_stacked_fallback_preview`  (lines 481–488)

```
fn theme_picker_uses_half_width_with_stacked_fallback_preview()
```

**Purpose**: Verifies that the picker is configured for half-width side content with a stacked fallback preview.

**Data flow**: Builds picker params with default-ish inputs and asserts `side_content_width`, `side_content_min_width`, and presence of `stacked_side_content`.

**Call relations**: This test validates the structural layout choices made by `build_theme_picker_params`.

*Call graph*: calls 1 internal fn (build_theme_picker_params); 2 external calls (assert!, assert_eq!).


##### `tests::theme_picker_items_include_search_values_for_preview_mapping`  (lines 491–499)

```
fn theme_picker_items_include_search_values_for_preview_mapping()
```

**Purpose**: Ensures every picker item carries a canonical `search_value`, which the live-preview callback relies on for stable index-to-theme mapping.

**Data flow**: Builds picker params and asserts that all items have `search_value.is_some()`.

**Call relations**: This test protects the invariant documented in `build_theme_picker_params` about deriving preview targets from final items.

*Call graph*: calls 1 internal fn (build_theme_picker_params); 1 external calls (assert!).


##### `tests::wide_preview_renders_all_lines_with_vertical_center_and_left_inset`  (lines 502–549)

```
fn wide_preview_renders_all_lines_with_vertical_center_and_left_inset()
```

**Purpose**: Checks that the wide preview renders every sample row, is vertically centered within a taller area, starts after the expected left inset, and includes both addition and removal markers.

**Data flow**: Renders `ThemePreviewWideRenderable` to text lines, extracts numbered rows and markers, and asserts row count, top/bottom padding, left inset in the first line, and presence of `+` and `-` markers.

**Call relations**: This test validates `render_preview` behavior as configured by `ThemePreviewWideRenderable::render`.

*Call graph*: 3 external calls (assert!, assert_eq!, render_lines).


##### `tests::narrow_preview_renders_single_add_and_single_remove_in_four_lines`  (lines 552–579)

```
fn narrow_preview_renders_single_add_and_single_remove_in_four_lines()
```

**Purpose**: Verifies that the narrow preview renders the exact four fixed rows with one addition and one removal, aligned at the left edge.

**Data flow**: Renders `ThemePreviewNarrowRenderable`, parses line numbers and markers from the output, and asserts the exact sequence `[12, 13, 13, 14]`, marker counts, and left-edge alignment of the first numbered line.

**Call relations**: This test validates the compact preview dataset and the no-inset rendering mode.

*Call graph*: 3 external calls (assert!, assert_eq!, render_lines).


##### `tests::deleted_preview_code_uses_dim_overlay_like_real_diff_renderer`  (lines 582–598)

```
fn deleted_preview_code_uses_dim_overlay_like_real_diff_renderer()
```

**Purpose**: Checks that deleted preview lines inherit the dim styling used by the real diff renderer.

**Data flow**: Renders the narrow preview to both buffer and text lines, locates the row containing a `-` marker, extracts the first non-space style modifier after the marker, and asserts it contains `Modifier::DIM`.

**Call relations**: This test confirms that `render_preview` is correctly reusing the shared diff styling pipeline.

*Call graph*: 4 external calls (assert!, first_non_space_style_after_marker, render_buffer, render_lines).


##### `tests::subtitle_uses_tilde_path_when_codex_home_under_home_directory`  (lines 601–609)

```
fn subtitle_uses_tilde_path_when_codex_home_under_home_directory()
```

**Purpose**: Verifies that the subtitle uses a concrete tilde-prefixed themes directory path when `codex_home` is under the user’s home directory and there is enough width.

**Data flow**: Builds a `codex_home` under `dirs::home_dir()`, calls `theme_picker_subtitle`, and asserts the returned string contains `~` and `directory`.

**Call relations**: This test covers the preferred subtitle branch in `theme_picker_subtitle`.

*Call graph*: calls 1 internal fn (theme_picker_subtitle); 2 external calls (assert!, home_dir).


##### `tests::subtitle_falls_back_when_tilde_path_subtitle_is_too_wide`  (lines 612–620)

```
fn subtitle_falls_back_when_tilde_path_subtitle_is_too_wide()
```

**Purpose**: Ensures the subtitle falls back to the generic preview hint when the concrete path-based sentence would exceed available width.

**Data flow**: Constructs a very long `codex_home` path under the home directory, calls `theme_picker_subtitle` with a finite terminal width, and asserts the fallback subtitle is returned.

**Call relations**: This test validates the width-check branch in `theme_picker_subtitle`.

*Call graph*: calls 1 internal fn (theme_picker_subtitle); 2 external calls (assert_eq!, home_dir).


##### `tests::subtitle_falls_back_to_preview_instructions_without_tilde_path`  (lines 623–627)

```
fn subtitle_falls_back_to_preview_instructions_without_tilde_path()
```

**Purpose**: Ensures the generic fallback subtitle is used when no `codex_home` path is available.

**Data flow**: Calls `theme_picker_subtitle(None, None)` and asserts the result equals `PREVIEW_FALLBACK_SUBTITLE`.

**Call relations**: This test covers the no-path branch of `theme_picker_subtitle`.

*Call graph*: calls 1 internal fn (theme_picker_subtitle); 1 external calls (assert_eq!).


##### `tests::subtitle_falls_back_for_94_column_terminal_side_by_side_layout`  (lines 630–637)

```
fn subtitle_falls_back_for_94_column_terminal_side_by_side_layout()
```

**Purpose**: Verifies that a 94-column terminal leaves too little list width for the path-based subtitle once side-by-side layout is considered, so the fallback text is used.

**Data flow**: Builds a home-based `codex_home`, calls `theme_picker_subtitle` with width 94, and asserts the fallback subtitle is returned.

**Call relations**: This test specifically exercises the interaction between `subtitle_available_width` and `theme_picker_subtitle`.

*Call graph*: calls 1 internal fn (theme_picker_subtitle); 2 external calls (assert_eq!, home_dir).


##### `tests::unavailable_configured_theme_falls_back_to_configured_or_default_selection`  (lines 640–656)

```
fn unavailable_configured_theme_falls_back_to_configured_or_default_selection()
```

**Purpose**: Checks that when the caller supplies a nonexistent current theme name, the picker preselects the configured/default theme rather than the first arbitrary entry.

**Data flow**: Reads `highlight::configured_theme_name()`, builds picker params with `Some("not-a-real-theme")`, extracts `initial_selected_idx` and the selected item’s `search_value`, and asserts it matches the configured/default theme name.

**Call relations**: This test validates the effective-theme resolution logic inside `build_theme_picker_params`.

*Call graph*: calls 2 internal fn (configured_theme_name, build_theme_picker_params); 1 external calls (assert_eq!).
