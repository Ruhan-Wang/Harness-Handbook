# TUI animation, motion, terminal media, and transient progress output  `stage-22.2.5`

This stage is shared presentation support for moments when the program wants to look alive in the terminal without being distracting. It sits behind the scenes during the main work of the app and in command-line diagnostics, adding movement, images, or temporary status text when the terminal can support them.

The pieces work like a small display toolbox. motion.rs is the front desk: other parts of the text UI ask it for a spinner, shimmer, or other activity hint, and it decides whether to show full animation or a reduced-motion fallback for people who prefer less movement. shimmer.rs creates the moving highlight effect that makes text look like light is passing over it, using rich color when available and simpler brightness changes otherwise.

ascii_animation.rs is the timing engine for text art. It picks which frame of an animation to show based on time and tells widgets when to redraw. frames.rs supplies the actual built-in frame sets and default timing, like a catalog of flipbook pages stored inside the program.

cli/src/doctor/progress.rs does a similar job for the doctor command, showing a temporary progress line on standard error or staying quiet when that is the safer choice.

## Files in this stage

### Motion coordination
These files define the motion-aware presentation layer, from centralized reduced-motion policy to shimmer text effects.

### `tui/src/motion.rs`

`util` · `cross-cutting during rendering`

This module defines the small abstraction layer between UI components and animated presentation. `MotionMode` captures whether animations are enabled, and `ReducedMotionIndicator` lets callers choose whether reduced-motion activity should disappear entirely or degrade to a static bullet. `activity_indicator` returns an optional `Span<'static>` based on those settings: animated mode delegates to `animated_activity_indicator`, while reduced mode either returns `None` or a dim bullet. `shimmer_text` similarly chooses between animated shimmer spans and plain text, returning an empty vector for empty reduced-motion strings.

The animated indicator adapts to terminal capabilities. If stdout reports 24-bit color support through `supports_color`, it reuses `shimmer_spans("•")` and takes the first span, falling back to a plain bullet if shimmer unexpectedly returns nothing. Otherwise it computes elapsed time from an optional `Instant` and alternates between a solid bullet and a dim hollow bullet every 600 ms. The tests verify reduced-motion behavior and include a source-tree scan that forbids direct `spinner(...)` or `shimmer_spans(...)` usage outside `motion.rs` and `shimmer.rs`, making this file the enforced gateway for animation primitives.

#### Function details

##### `MotionMode::from_animations_enabled`  (lines 20–26)

```
fn from_animations_enabled(animations_enabled: bool) -> Self
```

**Purpose**: Converts a plain boolean configuration flag into the explicit motion-mode enum used by rendering code.

**Data flow**: It takes `animations_enabled: bool` and returns `MotionMode::Animated` when true or `MotionMode::Reduced` when false. No state is read or written.

**Call relations**: Rendering code calls this helper before invoking `activity_indicator` or `shimmer_text`, keeping the rest of the UI independent of raw booleans.

*Call graph*: called by 5 (activity_marker, push_running_hook_header, display_lines, display_lines, render).


##### `activity_indicator`  (lines 35–47)

```
fn activity_indicator(
    start_time: Option<Instant>,
    motion_mode: MotionMode,
    reduced_motion_indicator: ReducedMotionIndicator,
) -> Option<Span<'static>>
```

**Purpose**: Produces the current activity marker span, or no marker, according to motion mode and reduced-motion policy.

**Data flow**: Inputs are an optional `start_time`, a `MotionMode`, and a `ReducedMotionIndicator`. In animated mode it returns `Some(animated_activity_indicator(start_time))`; in reduced mode it returns `None` for `Hidden` or `Some("•".dim())` for `StaticBullet`. It returns an `Option<Span<'static>>` and mutates no state.

**Call relations**: This is the public indicator helper used by multiple renderers. It delegates only the animated branch to `animated_activity_indicator`.

*Call graph*: calls 1 internal fn (animated_activity_indicator); called by 3 (activity_marker, push_running_hook_header, render).


##### `shimmer_text`  (lines 49–60)

```
fn shimmer_text(text: &str, motion_mode: MotionMode) -> Vec<Span<'static>>
```

**Purpose**: Returns either animated shimmer spans or a reduced-motion plain-text fallback for a given string.

**Data flow**: It takes `text: &str` and `motion_mode`. In animated mode it calls `shimmer_spans(text)` and returns that vector. In reduced mode it returns `Vec::new()` for empty text or a one-element vector containing the owned text span. No external state is modified.

**Call relations**: This helper is called by several UI renderers that want shimmer styling without directly depending on the shimmer module.

*Call graph*: calls 1 internal fn (shimmer_spans); called by 5 (render, push_running_hook_header, render_continue_in_browser, render_device_code_login, render); 2 external calls (new, vec!).


##### `animated_activity_indicator`  (lines 62–76)

```
fn animated_activity_indicator(start_time: Option<Instant>) -> Span<'static>
```

**Purpose**: Builds the animated activity bullet, choosing shimmer on capable terminals and a timed blink fallback otherwise.

**Data flow**: It takes an optional `Instant`, computes elapsed time or zero duration, then queries `supports_color::on_cached(Stream::Stdout)` for 24-bit color support. If true, it calls `shimmer_spans("•")`, takes the first span, and falls back to a plain bullet if absent. Otherwise it computes a 600 ms blink phase and returns either a plain `•` or dim `◦`. It returns a `Span<'static>` and writes no persistent state.

**Call relations**: This private helper is used only by `activity_indicator` to isolate terminal-capability and timing logic from the public API.

*Call graph*: calls 1 internal fn (shimmer_spans); called by 1 (activity_indicator); 1 external calls (on_cached).


##### `tests::reduced_motion_activity_indicator_uses_explicit_fallback`  (lines 89–106)

```
fn reduced_motion_activity_indicator_uses_explicit_fallback()
```

**Purpose**: Verifies the two reduced-motion indicator policies: hidden and static bullet.

**Data flow**: The test calls `activity_indicator` twice in `MotionMode::Reduced`, once with `Hidden` and once with `StaticBullet`, and asserts the returned `Option<Span>` values.

**Call relations**: It exercises the reduced-motion branch of `activity_indicator` without involving animation timing or terminal capability detection.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::reduced_motion_shimmer_text_is_plain_text`  (lines 109–118)

```
fn reduced_motion_shimmer_text_is_plain_text()
```

**Purpose**: Checks that reduced-motion shimmer output is plain text for non-empty input and empty for empty input.

**Data flow**: The test calls `shimmer_text` with `"Loading"` and `""` under `MotionMode::Reduced` and compares the returned vectors against explicit expectations.

**Call relations**: It validates the reduced-motion fallback branch in `shimmer_text`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::animation_primitives_are_only_used_by_motion_module`  (lines 121–167)

```
fn animation_primitives_are_only_used_by_motion_module()
```

**Purpose**: Scans the TUI source tree to ensure direct animation primitive calls are confined to the allowlisted modules.

**Data flow**: The test compiles regexes for `spinner(` and `shimmer_spans(`, locates the TUI `src` directory, recursively gathers Rust files with `collect_rust_files`, skips allowlisted paths via `animation_primitive_allowlisted_path`, reads each file, strips trailing `//` comments per line, records violations with file and line numbers, and asserts that the violation list is empty.

**Call relations**: This test enforces the architectural role of `motion.rs` as the sole public gateway for animation helpers, relying on the two local test helpers.

*Call graph*: 8 external calls (new, assert!, find_resource!, format!, read_to_string, new, animation_primitive_allowlisted_path, collect_rust_files).


##### `tests::collect_rust_files`  (lines 169–179)

```
fn collect_rust_files(dir: &Path, files: &mut Vec<PathBuf>) -> std::io::Result<()>
```

**Purpose**: Recursively collects `.rs` files under a directory for the architecture-enforcement test.

**Data flow**: It takes a directory path and mutable output vector, iterates `fs::read_dir`, recurses into subdirectories, and pushes paths whose extension is `rs`. It returns `std::io::Result<()>`.

**Call relations**: This helper is called by `animation_primitives_are_only_used_by_motion_module` to enumerate source files before scanning them.

*Call graph*: 2 external calls (read_dir, collect_rust_files).


##### `tests::animation_primitive_allowlisted_path`  (lines 181–183)

```
fn animation_primitive_allowlisted_path(relative_path: &str) -> bool
```

**Purpose**: Defines which relative source paths may directly call low-level animation primitives.

**Data flow**: It takes a relative path string and returns true only for `motion.rs` or `shimmer.rs` using a `matches!` check.

**Call relations**: This helper is used by the source-tree scan test to exempt the modules that are intentionally allowed to reference animation primitives directly.

*Call graph*: 1 external calls (matches!).


### `tui/src/shimmer.rs`

`util` · `cross-cutting during animated widget rendering`

This file implements a lightweight time-based text animation used by TUI widgets that want a moving highlight band. A process-global `OnceLock<Instant>` anchors the animation to process start so every caller sees the same sweep phase instead of each widget animating independently. `shimmer_spans` converts an input string into a `Vec<Span<'static>>`, one span per character, and computes a cosine-shaped intensity band that moves across the text over a fixed two-second cycle. The sweep includes left/right padding so the highlight can enter and leave smoothly rather than abruptly starting at the first character.

Rendering adapts to terminal capabilities. If stdout reports 24-bit color support, the code blends the terminal default background toward the default foreground using `crate::color::blend`, then applies bold styling to make the highlight read clearly while respecting the user’s palette. If true color is unavailable, it falls back to three discrete styles—dim, normal, bold—chosen by intensity thresholds. Empty input returns an empty vector immediately. The implementation intentionally uses terminal default foreground/background colors when available, with gray/white RGB fallbacks, so the shimmer remains legible across themes instead of hardcoding a fixed palette.

#### Function details

##### `elapsed_since_start`  (lines 16–19)

```
fn elapsed_since_start() -> Duration
```

**Purpose**: Returns the elapsed wall-clock duration since the first shimmer-related call in this process. It lazily initializes the shared start instant on first use.

**Data flow**: Reads the static `PROCESS_START` `OnceLock`; if unset, stores `Instant::now()`. It then computes `start.elapsed()` and returns that `Duration` without mutating any other state.

**Call relations**: This helper is only used by `shimmer_spans` to derive the current sweep position. Its role is to centralize animation timing so all shimmer consumers stay synchronized.

*Call graph*: called by 1 (shimmer_spans).


##### `shimmer_spans`  (lines 21–69)

```
fn shimmer_spans(text: &str) -> Vec<Span<'static>>
```

**Purpose**: Builds styled ratatui spans for each character in a string, applying a moving highlight band whose position depends on process uptime. It chooses either RGB blending or a simpler intensity fallback based on terminal color support.

**Data flow**: Takes `&str` text, collects it into `Vec<char>`, and returns early with an empty `Vec` if there are no characters. It reads elapsed time from `elapsed_since_start`, computes a padded sweep period and current band position, queries stdout color capability, reads default foreground/background colors, then for each character computes distance from the sweep center, converts that to a cosine intensity `t`, maps `t` to either a blended RGB `Style` or `color_for_level(t)`, and pushes `Span::styled(ch.to_string(), style)` into the output vector. It returns the completed `Vec<Span<'static>>` and writes no external state.

**Call relations**: This function is called by `animated_activity_indicator` and `shimmer_text` when those UI elements need animated text. It delegates timing to `elapsed_since_start`, palette lookup to `default_fg`/`default_bg`, color interpolation to `blend`, and non-RGB fallback styling to `color_for_level`.

*Call graph*: calls 5 internal fn (blend, color_for_level, elapsed_since_start, default_bg, default_fg); called by 2 (animated_activity_indicator, shimmer_text); 6 external calls (styled, default, new, with_capacity, Rgb, on_cached).


##### `color_for_level`  (lines 71–80)

```
fn color_for_level(intensity: f32) -> Style
```

**Purpose**: Maps a continuous shimmer intensity into a coarse fallback text style for terminals without true-color support. The thresholds are tuned so the moving band remains visible using only modifiers.

**Data flow**: Takes an `f32` intensity and compares it against fixed cutoffs. It returns a `Style` that is dim for low intensity, default for medium intensity, and bold for high intensity; it reads no external state and writes nothing.

**Call relations**: This helper is only reached from `shimmer_spans` when stdout lacks 24-bit color support. It isolates the fallback policy so the main shimmer loop can stay focused on animation math.

*Call graph*: called by 1 (shimmer_spans); 1 external calls (default).


### ASCII animation assets and driver
These files provide the built-in frame data and the reusable driver that turns those frames into timed terminal animations.

### `tui/src/ascii_animation.rs`

`util` · `render loop`

This file defines `AsciiAnimation`, a compact state holder for time-based ASCII art animation used across popups and onboarding widgets. The struct stores a `FrameRequester` callback object, a static slice of animation variants (`&'static [&'static [&'static str]]`), the currently selected variant index, the frame tick duration, and the `Instant` when animation timing began.

Construction happens through `new`, which uses the global `ALL_VARIANTS`, or `with_variants`, which accepts an explicit variant set and clamps the requested index to the last valid variant. The constructor asserts that at least one variant exists, making empty animation sets an invariant violation rather than a runtime edge case. `current_frame` computes the visible frame by dividing elapsed milliseconds by the tick duration and taking modulo the frame count; if the selected variant has no frames it returns an empty string, and if the tick duration is zero it pins to the first frame. `schedule_next_frame` aligns redraw scheduling to the next frame boundary rather than simply waiting a fixed duration from now, which keeps animation cadence stable even if rendering drifts. If duration conversion overflows, it falls back to an immediate frame request.

`pick_random_variant` changes to a different variant only when more than one exists, repeatedly sampling until it differs from the current index, then requests an immediate redraw. The private `frames` accessor simply returns the currently selected frame slice.

#### Function details

##### `AsciiAnimation::new`  (lines 21–23)

```
fn new(request_frame: FrameRequester) -> Self
```

**Purpose**: Constructs an animation using the shared global frame variants and the first variant as the initial selection.

**Data flow**: It takes a `FrameRequester`, forwards it together with `ALL_VARIANTS` and `variant_idx` 0 into `Self::with_variants`, and returns the resulting `AsciiAnimation`.

**Call relations**: This is the default constructor used by widget initialization. It delegates all validation and field setup to `with_variants`.

*Call graph*: called by 1 (new); 1 external calls (with_variants).


##### `AsciiAnimation::with_variants`  (lines 25–42)

```
fn with_variants(
        request_frame: FrameRequester,
        variants: &'static [&'static [&'static str]],
        variant_idx: usize,
    ) -> Self
```

**Purpose**: Constructs an animation from an explicit set of variants and an initial variant index, enforcing non-empty variants and clamping out-of-range indices.

**Data flow**: It takes a `FrameRequester`, a static nested slice of frame variants, and a requested `variant_idx`. It asserts `variants` is not empty, computes `clamped_idx = variant_idx.min(variants.len() - 1)`, stores the requester, variants, clamped index, `FRAME_TICK_DEFAULT`, and `Instant::now()`, and returns the new struct.

**Call relations**: Used by tests and variant-selection flows that need explicit control over the available animations. `new` is a thin wrapper over this constructor.

*Call graph*: called by 2 (ctrl_dot_changes_animation_variant, ctrl_shift_dot_changes_animation_variant); 2 external calls (now, assert!).


##### `AsciiAnimation::schedule_next_frame`  (lines 44–63)

```
fn schedule_next_frame(&self)
```

**Purpose**: Requests the next redraw at the next animation frame boundary based on elapsed time and configured tick duration.

**Data flow**: It reads `self.frame_tick.as_millis()`. If zero, it immediately calls `self.request_frame.schedule_frame()` and returns. Otherwise it computes elapsed milliseconds since `self.start`, finds the remainder modulo tick length, computes the delay until the next boundary, tries to convert that delay to `u64`, and either calls `schedule_frame_in(Duration::from_millis(delay))` or falls back to immediate `schedule_frame()` on conversion failure.

**Call relations**: Rendering code calls this after drawing animated widgets so another frame will be requested at the right time. It delegates actual redraw scheduling to the injected `FrameRequester`.

*Call graph*: calls 2 internal fn (schedule_frame, schedule_frame_in); called by 1 (render_ref); 4 external calls (as_millis, from_millis, elapsed, try_from).


##### `AsciiAnimation::current_frame`  (lines 65–77)

```
fn current_frame(&self) -> &'static str
```

**Purpose**: Returns the ASCII frame string that should currently be displayed for the selected variant.

**Data flow**: It reads the current variant's frame slice via `self.frames()`. If empty, it returns `""`. If `frame_tick` is zero, it returns the first frame. Otherwise it computes elapsed milliseconds since `self.start`, divides by tick length, takes modulo the frame count, indexes into the frame slice, and returns that `&'static str`.

**Call relations**: Render paths call this each frame to obtain the text to display. It depends on `frames()` for variant selection and shares the same timing basis as `schedule_next_frame`.

*Call graph*: calls 1 internal fn (frames); called by 1 (render_ref); 2 external calls (as_millis, elapsed).


##### `AsciiAnimation::pick_random_variant`  (lines 79–91)

```
fn pick_random_variant(&mut self) -> bool
```

**Purpose**: Switches to a different random animation variant and requests an immediate redraw.

**Data flow**: It reads `self.variants.len()`. If there is only one or zero variants, it returns `false` without mutation. Otherwise it creates a random number generator, repeatedly samples a new index until it differs from `self.variant_idx`, writes the new index back to `self.variant_idx`, calls `self.request_frame.schedule_frame()`, and returns `true`.

**Call relations**: Keyboard handling invokes this when the user requests a different animation variant. It changes only the selected variant; frame timing continues from the original `start` instant.

*Call graph*: calls 1 internal fn (schedule_frame); called by 1 (handle_key_event); 1 external calls (rng).


##### `AsciiAnimation::frames`  (lines 93–95)

```
fn frames(&self) -> &'static [&'static str]
```

**Purpose**: Returns the frame slice for the currently selected animation variant.

**Data flow**: It indexes `self.variants` by `self.variant_idx` and returns the referenced `&'static [&'static str]`.

**Call relations**: This private helper is used by `current_frame` to keep variant indexing in one place.

*Call graph*: called by 1 (current_frame).


##### `tests::frame_tick_must_be_nonzero`  (lines 103–105)

```
fn frame_tick_must_be_nonzero()
```

**Purpose**: Asserts that the default frame tick duration is positive.

**Data flow**: It reads `FRAME_TICK_DEFAULT.as_millis()` and asserts the value is greater than zero.

**Call relations**: This test protects the intended default timing invariant for the animation system.

*Call graph*: 1 external calls (assert!).


### `tui/src/frames.rs`

`data_model` · `cross-cutting`

This file is a pure asset-definition module for terminal animations. Its central piece is the `frames_for!` macro, which expands a directory name into a fixed `[&str; 36]` array by `include_str!`-embedding `frame_1.txt` through `frame_36.txt` from `tui/frames/<variant>/`. Because the frame text is compiled into the program, there is no runtime file I/O, no asset lookup failure path during execution, and each variant is guaranteed to have exactly 36 frames at build time. The module declares ten concrete frame arrays—`FRAMES_DEFAULT`, `FRAMES_CODEX`, `FRAMES_OPENAI`, `FRAMES_BLOCKS`, `FRAMES_DOTS`, `FRAMES_HASH`, `FRAMES_HBARS`, `FRAMES_VBARS`, `FRAMES_SHAPES`, and `FRAMES_SLUG`—all sharing the same shape and indexing semantics. `ALL_VARIANTS` then collects references to those arrays as a slice of frame-set references, giving higher-level code a simple way to enumerate or randomly choose among all bundled animations without knowing variant names individually. Finally, `FRAME_TICK_DEFAULT` fixes the standard playback interval at 80 milliseconds using `std::time::Duration`. The design here is intentionally static: frame count, ordering, and availability are compile-time invariants, which simplifies animation code elsewhere and avoids partial or malformed theme packs.


### Transient progress output
This file applies terminal capability checks to choose and render transient progress reporting for doctor runs.

### `cli/src/doctor/progress.rs`

`util` · `cross-cutting`

This module isolates progress reporting from the rest of doctor execution. The `DoctorProgress` trait defines four lifecycle hooks—`begin`, `heartbeat`, `finish`, and `settle`—with the explicit rule that implementations must never write to stdout, because stdout is reserved for the final human report or valid JSON output.

`doctor_progress` chooses the implementation at runtime. If output is JSON, stderr is not a terminal, or `TERM=dumb`, it returns `QuietProgress`, whose trait methods are all no-ops. Otherwise it returns `StderrProgress`, which maintains a small `StderrProgressState` behind a `Mutex` to remember whether it has written a transient line. `StderrProgress::render` writes `\r\x1b[2K` followed by the message to a locked stderr handle, flushes immediately, and marks `wrote_line = true`. `begin` and `heartbeat` format messages like `Checking config...` and `Still checking websocket... 3s`; `finish` intentionally does nothing so the current line remains until all checks settle; `settle` clears the transient line only if one was written.

The design is intentionally minimal: progress is advisory, stderr-only, and safe under redirected stdout. The tests focus on the gating logic in `should_show_progress`, ensuring progress appears only for interactive human-terminal runs.

#### Function details

##### `doctor_progress`  (lines 25–35)

```
fn doctor_progress(json: bool) -> std::sync::Arc<dyn DoctorProgress>
```

**Purpose**: Selects the appropriate progress implementation for the current doctor run.

**Data flow**: Accepts `json: bool`, reads `TERM` from the environment and whether stderr is a terminal, calls `should_show_progress`, and returns either `Arc::new(StderrProgress::default())` or `Arc::new(QuietProgress)` as `Arc<dyn DoctorProgress>`.

**Call relations**: It is called by `build_report` before any checks run. Its only decision point is whether interactive stderr progress is appropriate.

*Call graph*: calls 1 internal fn (should_show_progress); called by 1 (build_report); 4 external calls (default, stderr, var, new).


##### `should_show_progress`  (lines 37–39)

```
fn should_show_progress(json: bool, term: Option<&str>, stderr_is_tty: bool) -> bool
```

**Purpose**: Determines whether transient stderr progress should be shown.

**Data flow**: Returns true only when output is not JSON, stderr is a tty, and `TERM` is not `dumb`.

**Call relations**: Used by `doctor_progress` and directly unit-tested for all gating cases.

*Call graph*: called by 1 (doctor_progress).


##### `QuietProgress::begin`  (lines 44–44)

```
fn begin(&self, _label: &'static str)
```

**Purpose**: No-op begin hook for quiet progress mode.

**Data flow**: Ignores the label and performs no output or state changes.

**Call relations**: Implements `DoctorProgress` for runs where progress must stay silent.


##### `QuietProgress::heartbeat`  (lines 46–46)

```
fn heartbeat(&self, _label: &'static str, _elapsed: Duration)
```

**Purpose**: No-op heartbeat hook for quiet progress mode.

**Data flow**: Ignores the label and elapsed duration and performs no output or state changes.

**Call relations**: Implements `DoctorProgress` for silent runs.


##### `QuietProgress::finish`  (lines 48–48)

```
fn finish(&self, _label: &'static str, _status: CheckStatus)
```

**Purpose**: No-op finish hook for quiet progress mode.

**Data flow**: Ignores the label and status and performs no output or state changes.

**Call relations**: Implements `DoctorProgress` for silent runs.


##### `QuietProgress::settle`  (lines 50–50)

```
fn settle(&self)
```

**Purpose**: No-op settle hook for quiet progress mode.

**Data flow**: Performs no output or state changes.

**Call relations**: Implements `DoctorProgress` for silent runs.


##### `StderrProgress::render`  (lines 64–72)

```
fn render(&self, message: String)
```

**Purpose**: Writes or rewrites the transient stderr progress line and records that a line is currently displayed.

**Data flow**: Locks `self.state`; if locking fails it returns early. Otherwise it locks stderr, writes carriage-return plus ANSI clear-line plus the supplied message, flushes stderr, and sets `state.wrote_line = true`.

**Call relations**: Used internally by `StderrProgress::begin` and `StderrProgress::heartbeat`.

*Call graph*: called by 2 (begin, heartbeat); 2 external calls (stderr, write!).


##### `StderrProgress::begin`  (lines 76–78)

```
fn begin(&self, label: &'static str)
```

**Purpose**: Displays the initial `Checking <label>...` progress message on stderr.

**Data flow**: Formats `Checking {label}...` and passes it to `self.render(...)`.

**Call relations**: Called by the doctor wrappers when a check starts, but only when `doctor_progress` selected `StderrProgress`.

*Call graph*: calls 1 internal fn (render); 1 external calls (format!).


##### `StderrProgress::heartbeat`  (lines 80–82)

```
fn heartbeat(&self, label: &'static str, elapsed: Duration)
```

**Purpose**: Updates the transient stderr line for a slow-running check.

**Data flow**: Formats `Still checking {label}... {elapsed_secs}s` from the label and elapsed duration and passes it to `self.render(...)`.

**Call relations**: Called by `run_async_check` once a check exceeds the slow-check threshold.

*Call graph*: calls 1 internal fn (render); 1 external calls (format!).


##### `StderrProgress::finish`  (lines 84–84)

```
fn finish(&self, _label: &'static str, _status: CheckStatus)
```

**Purpose**: Intentionally does nothing when an individual check finishes.

**Data flow**: Ignores the label and status and leaves the current transient line untouched.

**Call relations**: Part of the `DoctorProgress` contract; the line is cleared later by `settle` instead of per-check.


##### `StderrProgress::settle`  (lines 86–97)

```
fn settle(&self)
```

**Purpose**: Clears the transient stderr progress line after all checks have settled.

**Data flow**: Locks `self.state`; if locking fails or `wrote_line` is false it returns. Otherwise it locks stderr, writes carriage-return plus ANSI clear-line, flushes, and resets `wrote_line` to false.

**Call relations**: Called by `build_report` after all checks complete so the final stdout report is not preceded by stale progress text.

*Call graph*: 2 external calls (stderr, write!).


##### `tests::progress_is_quiet_for_json`  (lines 105–111)

```
fn progress_is_quiet_for_json()
```

**Purpose**: Verifies that JSON mode suppresses progress output.

**Data flow**: Calls `should_show_progress` with `json = true` and asserts the result is false.

**Call relations**: Direct unit test for progress gating.

*Call graph*: 1 external calls (assert!).


##### `tests::progress_is_quiet_for_non_tty`  (lines 114–120)

```
fn progress_is_quiet_for_non_tty()
```

**Purpose**: Verifies that non-interactive stderr suppresses progress output.

**Data flow**: Calls `should_show_progress` with `stderr_is_tty = false` and asserts false.

**Call relations**: Direct unit test for progress gating.

*Call graph*: 1 external calls (assert!).


##### `tests::progress_is_quiet_for_dumb_terminal`  (lines 123–129)

```
fn progress_is_quiet_for_dumb_terminal()
```

**Purpose**: Verifies that `TERM=dumb` suppresses progress output.

**Data flow**: Calls `should_show_progress` with `term = Some("dumb")` and asserts false.

**Call relations**: Direct unit test for progress gating.

*Call graph*: 1 external calls (assert!).


##### `tests::progress_is_shown_for_human_tty_output`  (lines 132–138)

```
fn progress_is_shown_for_human_tty_output()
```

**Purpose**: Verifies that interactive human-terminal runs enable stderr progress.

**Data flow**: Calls `should_show_progress` with non-JSON, tty stderr, and a normal TERM value and asserts true.

**Call relations**: Direct unit test for the positive gating case.

*Call graph*: 1 external calls (assert!).
