# TUI animation, motion, terminal media, and transient progress output  `stage-22.2.5`

This stage is shared behind-the-scenes support for making the command-line interface feel alive without getting in the way. It is used while the program is running, especially when the interface needs to show that work is happening.

The motion file is the central switchboard for small movement effects, such as loading dots or animated highlights. It also respects reduced-motion settings, meaning users who prefer less animation still see clear, steady feedback. The shimmer file supplies one of those effects: it breaks text into styled pieces and changes their brightness over time, like a light sweeping across a sign. The ASCII animation file is the frame driver. It decides which text-art picture to show next and asks the interface to redraw at the right moments. The frames file is the art library, packaging those pictures and their normal playback speed into the program. Finally, the doctor progress file shows temporary “checking…” messages during health checks, sending them somewhere safe so they do not mix into the final report or JSON output.

## Files in this stage

### Motion coordination
These files define the motion-aware presentation layer, from centralized reduced-motion policy to shimmer text effects.

### `tui/src/motion.rs`

`domain_logic` · `cross-cutting during TUI rendering`

This file solves an accessibility and consistency problem. A terminal user interface often wants to show that something is still happening, like a loading dot or glowing text. But not every user wants moving effects, and not every terminal can show rich colors. This file acts like a central light switch and dimmer: callers ask it for a visual cue, and it decides whether that cue should move, stay still, or disappear.

The main choice is `MotionMode`, which is either animated or reduced. Code elsewhere can turn a simple setting, “animations enabled,” into that mode. For activity markers, callers also choose a reduced-motion fallback: hide the marker entirely, or show a static bullet. For shimmering text, animated mode delegates to the shimmer helper, while reduced mode returns ordinary plain text.

The private animated activity helper chooses the best animated-looking bullet for the terminal. If the terminal supports full color, it uses the shimmer effect. If not, it falls back to a simple blinking-style swap between a solid and dim bullet based on elapsed time.

The tests are important because they protect the design rule: other parts of the TUI should not call low-level animation helpers directly. They should go through this file, so reduced-motion behavior stays deliberate and predictable.

#### Function details

##### `MotionMode::from_animations_enabled`  (lines 20–26)

```
fn from_animations_enabled(animations_enabled: bool) -> Self
```

**Purpose**: Turns a plain yes-or-no animation setting into the file’s motion mode. This gives the rest of the TUI one clear language for deciding whether visual effects should move or stay calm.

**Data flow**: It receives a boolean value: `true` means animations are allowed, and `false` means they are not. It converts that into `MotionMode::Animated` or `MotionMode::Reduced`, then returns the chosen mode without changing anything else.

**Call relations**: Rendering code such as `activity_marker`, `push_running_hook_header`, `display_lines`, and `render` calls this when it has a user or app setting and needs a motion decision. The returned mode is then passed into functions like `activity_indicator` or `shimmer_text` so the actual display choice stays centralized here.

*Call graph*: called by 5 (activity_marker, push_running_hook_header, display_lines, display_lines, render).


##### `activity_indicator`  (lines 35–47)

```
fn activity_indicator(
    start_time: Option<Instant>,
    motion_mode: MotionMode,
    reduced_motion_indicator: ReducedMotionIndicator,
) -> Option<Span<'static>>
```

**Purpose**: Builds the small activity mark that tells the user something is in progress. It respects the motion mode, so animated users get movement while reduced-motion users get either no mark or a quiet static bullet.

**Data flow**: It receives an optional start time, a motion mode, and a reduced-motion fallback choice. In animated mode, it asks `animated_activity_indicator` to create a time-based marker. In reduced mode, it either returns nothing or returns a dim bullet. The result is an optional terminal text span ready to render.

**Call relations**: UI pieces such as `activity_marker`, `push_running_hook_header`, and `render` call this when they need an in-progress indicator. If animation is allowed, this function hands off to `animated_activity_indicator`; otherwise it stops there and returns the selected calm fallback.

*Call graph*: calls 1 internal fn (animated_activity_indicator); called by 3 (activity_marker, push_running_hook_header, render).


##### `shimmer_text`  (lines 49–60)

```
fn shimmer_text(text: &str, motion_mode: MotionMode) -> Vec<Span<'static>>
```

**Purpose**: Creates text that may shimmer when animations are enabled, or plain text when reduced motion is requested. It lets callers show the same message without each caller having to remember the accessibility rules.

**Data flow**: It receives the text to show and the current motion mode. In animated mode, it passes the text to `shimmer_spans`, which creates styled pieces of text. In reduced mode, it returns an empty list for empty text, or one plain text span for non-empty text. The output is a list of spans that the terminal renderer can draw.

**Call relations**: Several rendering paths call this, including `render`, `push_running_hook_header`, `render_continue_in_browser`, and `render_device_code_login`, when they want attention-grabbing text. This function is the gatekeeper that decides whether to call the lower-level shimmer helper or replace it with plain text.

*Call graph*: calls 1 internal fn (shimmer_spans); called by 5 (render, push_running_hook_header, render_continue_in_browser, render_device_code_login, render); 2 external calls (new, vec!).


##### `animated_activity_indicator`  (lines 62–76)

```
fn animated_activity_indicator(start_time: Option<Instant>) -> Span<'static>
```

**Purpose**: Creates the animated version of the activity bullet. It tries to use a richer color shimmer when the terminal supports it, and otherwise uses a simpler time-based bullet change.

**Data flow**: It receives an optional start time. It calculates how much time has passed, checks cached terminal color support for standard output, and then chooses a marker. With full color support it uses `shimmer_spans` on a bullet and takes the first span. Without full color support it alternates between a normal bullet and a dim hollow bullet based on elapsed time. It returns one span to draw.

**Call relations**: This is a private helper used only by `activity_indicator`. The bigger rendering code does not call it directly; that matters because `activity_indicator` first checks whether motion is allowed and applies reduced-motion rules when needed.

*Call graph*: calls 1 internal fn (shimmer_spans); called by 1 (activity_indicator); 1 external calls (on_cached).


##### `tests::reduced_motion_activity_indicator_uses_explicit_fallback`  (lines 89–106)

```
fn reduced_motion_activity_indicator_uses_explicit_fallback()
```

**Purpose**: Checks that reduced-motion activity markers do exactly what the caller asked for. This prevents accidental animation or accidental display when the reduced-motion fallback says the marker should be hidden.

**Data flow**: The test calls `activity_indicator` twice with reduced motion and no start time. First it asks for the hidden fallback and expects no span. Then it asks for the static bullet fallback and expects a dim bullet span. It compares each actual result with the expected one.

**Call relations**: This test exercises `activity_indicator` from the reduced-motion side. It supports the wider rule that UI code can safely call the motion module and trust it to honor explicit accessibility choices.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::reduced_motion_shimmer_text_is_plain_text`  (lines 109–118)

```
fn reduced_motion_shimmer_text_is_plain_text()
```

**Purpose**: Checks that shimmer text becomes ordinary text when motion is reduced. It also verifies that empty input stays empty instead of producing a meaningless span.

**Data flow**: The test sends `Loading` into `shimmer_text` with reduced motion and expects a single plain span containing `Loading`. It then sends an empty string and expects an empty list. Nothing outside the test is changed.

**Call relations**: This test exercises the calm branch of `shimmer_text`. It protects callers such as rendering and login screens from accidentally showing shimmer effects when they asked for reduced motion.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::animation_primitives_are_only_used_by_motion_module`  (lines 121–167)

```
fn animation_primitives_are_only_used_by_motion_module()
```

**Purpose**: Enforces the architectural rule that other TUI files should not call raw animation helpers directly. This keeps reduced-motion behavior from being bypassed by mistake.

**Data flow**: The test builds search patterns for direct `spinner(...)` and `shimmer_spans(...)` calls. It finds the TUI source directory, gathers Rust files with `collect_rust_files`, skips allowed files, reads each remaining file, and scans code lines while ignoring trailing comments. Any direct use becomes a human-readable violation message. The test passes only if no violations were found.

**Call relations**: This test calls `collect_rust_files` to walk the source tree and `animation_primitive_allowlisted_path` to decide which files are allowed to use animation primitives. It protects this file’s role as the central doorway to animation by failing if another module goes around it.

*Call graph*: 8 external calls (new, assert!, find_resource!, format!, read_to_string, new, animation_primitive_allowlisted_path, collect_rust_files).


##### `tests::collect_rust_files`  (lines 169–179)

```
fn collect_rust_files(dir: &Path, files: &mut Vec<PathBuf>) -> std::io::Result<()>
```

**Purpose**: Recursively gathers Rust source files under a directory for the architecture test. It is a small helper so the test can scan the whole TUI source tree.

**Data flow**: It receives a directory path and a mutable list. It reads the directory entries. For each subdirectory, it calls itself again. For each file ending in `.rs`, it adds the path to the list. It returns success or an input/output error if reading the filesystem fails.

**Call relations**: `tests::animation_primitives_are_only_used_by_motion_module` calls this before scanning for forbidden direct animation calls. This helper supplies the file list that makes the rule check cover nested source folders, not just one directory.

*Call graph*: 2 external calls (read_dir, collect_rust_files).


##### `tests::animation_primitive_allowlisted_path`  (lines 181–183)

```
fn animation_primitive_allowlisted_path(relative_path: &str) -> bool
```

**Purpose**: Says which source files are allowed to call the raw animation helpers. Only the central motion file and the shimmer implementation itself are allowed.

**Data flow**: It receives a relative source path as text. It compares that path with the allowed names, `motion.rs` and `shimmer.rs`, and returns `true` if it matches either one or `false` otherwise.

**Call relations**: `tests::animation_primitives_are_only_used_by_motion_module` calls this for every Rust file it finds. If this function says a file is not allowed, the test scans it for direct animation helper calls and reports any violations.

*Call graph*: 1 external calls (matches!).


### `tui/src/shimmer.rs`

`domain_logic` · `main loop / rendering`

This file solves a small but visible user-interface problem: how to show that something is active or loading without needing images, a mouse, or a graphical window. In a terminal app, text is the main building block, so the file makes text feel alive by coloring each character differently as time passes.

The main function, `shimmer_spans`, takes a string and returns a list of styled text pieces called spans. A span is a chunk of terminal text plus instructions for how it should look, such as color, boldness, or dimness. The function treats each character as its own span so the highlight can move smoothly across the word.

The animation is based on the time since the program first needed the shimmer effect. A sweep position moves across the text every two seconds, with extra padding so the highlight starts before the first character and exits after the last one. Characters close to the sweep are brighter; characters farther away stay normal or dim.

If the terminal supports true color, meaning full red-green-blue colors, the code blends the terminal’s normal foreground and background colors to create a smooth glow. If not, it falls back to simpler styling: dim, normal, or bold. This keeps the effect readable even in limited terminals.

#### Function details

##### `elapsed_since_start`  (lines 16–19)

```
fn elapsed_since_start() -> Duration
```

**Purpose**: This function gives the shimmer animation a shared clock. It records the first time the shimmer code asks for the time, then reports how much time has passed since then.

**Data flow**: It takes no direct input. It reads a process-wide saved start time, creating it if this is the first call, then compares that start time with the current moment. It returns a duration, which is the amount of elapsed time used to place the moving highlight.

**Call relations**: During rendering, `shimmer_spans` calls this function to know where the shimmer band should be right now. By using one shared start time, all shimmer text in the app can move in sync instead of each piece starting its own independent clock.

*Call graph*: called by 1 (shimmer_spans).


##### `shimmer_spans`  (lines 21–69)

```
fn shimmer_spans(text: &str) -> Vec<Span<'static>>
```

**Purpose**: This is the main function in the file. It turns plain text into terminal-ready styled spans, with a moving highlight that makes the text look animated.

**Data flow**: It receives a text string. It splits the string into characters, checks how much time has passed, calculates where the bright band should be, and gives each character a style based on its distance from that band. If the terminal supports full RGB color, it blends the default foreground and background colors for a smooth shimmer; otherwise it uses simpler dim, normal, and bold styles. It returns a vector of styled spans ready for the terminal renderer to draw.

**Call relations**: `animated_activity_indicator` and `shimmer_text` call this when they need animated-looking text. Inside, it asks `elapsed_since_start` for the animation clock, asks `default_fg` and `default_bg` for the terminal’s usual colors, uses `blend` to make intermediate colors when possible, and falls back to `color_for_level` when rich color is not available.

*Call graph*: calls 5 internal fn (blend, color_for_level, elapsed_since_start, default_bg, default_fg); called by 2 (animated_activity_indicator, shimmer_text); 6 external calls (styled, default, new, with_capacity, Rgb, on_cached).


##### `color_for_level`  (lines 71–80)

```
fn color_for_level(intensity: f32) -> Style
```

**Purpose**: This function chooses a simple fallback style for terminals that cannot show full RGB colors. It maps shimmer intensity to dim, normal, or bold text.

**Data flow**: It receives a number representing how close a character is to the shimmer highlight. Low intensity becomes dim text, medium intensity becomes plain text, and high intensity becomes bold text. It returns a terminal style object using only basic formatting that most terminals understand.

**Call relations**: `shimmer_spans` calls this only when true-color output is unavailable. It lets the shimmer effect still communicate motion and emphasis, even on older or more limited terminal displays.

*Call graph*: called by 1 (shimmer_spans); 1 external calls (default).


### ASCII animation assets and driver
These files provide the built-in frame data and the reusable driver that turns those frames into timed terminal animations.

### `tui/src/ascii_animation.rs`

`domain_logic` · `rendering and key-event handling`

This file is the small animation engine for text-based artwork used in popups and onboarding screens. In a terminal UI, nothing moves unless the program asks the screen to redraw. This code acts like a metronome: it tracks when the animation started, works out which frame should be visible now, and schedules the next redraw so the picture appears to animate smoothly.

The main type is `AsciiAnimation`. It stores a `FrameRequester`, which is the object used to ask the terminal UI for another render. It also stores a list of animation variants, the currently selected variant, the time between frames, and the start time. A “variant” is just one complete version of an animation, made from several text frames.

When drawing, callers ask `current_frame` for the frame that matches the current time. After drawing, they call `schedule_next_frame` so the UI wakes up again exactly when the next frame is due. The file also supports changing to a random different variant, useful for keyboard shortcuts that cycle the animation style.

One important detail is that timing is based on elapsed time since the animation was created, not on a manually increased counter. That means the displayed frame stays tied to real time, even if redraws happen slightly early or late.

#### Function details

##### `AsciiAnimation::new`  (lines 21–23)

```
fn new(request_frame: FrameRequester) -> Self
```

**Purpose**: Creates a normal ASCII animation using the project’s built-in animation variants. This is the simple constructor for callers that do not need to choose a special variant list.

**Data flow**: It takes a `FrameRequester`, which is the connection back to the UI redraw system. It passes that requester, the default list of variants, and starting variant index `0` into the more general constructor, then returns the ready-to-use animation object.

**Call relations**: This is the easy entry point for creating an animation. It immediately hands the real setup work to `AsciiAnimation::with_variants`, so all construction rules stay in one place.

*Call graph*: called by 1 (new); 1 external calls (with_variants).


##### `AsciiAnimation::with_variants`  (lines 25–42)

```
fn with_variants(
        request_frame: FrameRequester,
        variants: &'static [&'static [&'static str]],
        variant_idx: usize,
    ) -> Self
```

**Purpose**: Creates an ASCII animation from a caller-provided set of animation variants. This is useful when a screen or test wants to use a specific collection of frames rather than the default set.

**Data flow**: It receives a redraw requester, a list of variants, and the variant index the caller wants to start with. It first checks that the list is not empty, clamps the requested index so it cannot point past the end, records the default frame speed, captures the current time as the animation start, and returns a new `AsciiAnimation`.

**Call relations**: This is the shared setup path used by `AsciiAnimation::new` and by code that needs direct control over variants, such as animation-variant keyboard behavior. It prepares the state that later calls to `current_frame`, `schedule_next_frame`, and `pick_random_variant` rely on.

*Call graph*: called by 2 (ctrl_dot_changes_animation_variant, ctrl_shift_dot_changes_animation_variant); 2 external calls (now, assert!).


##### `AsciiAnimation::schedule_next_frame`  (lines 44–63)

```
fn schedule_next_frame(&self)
```

**Purpose**: Asks the UI to redraw when the next animation frame should appear. Without this, the animation could get stuck on one frame because the terminal screen would not know it needs to repaint.

**Data flow**: It reads the configured frame interval and the time elapsed since the animation started. If the frame interval is zero, it requests an immediate redraw. Otherwise, it calculates how many milliseconds remain until the next frame boundary and asks the `FrameRequester` to schedule a redraw after that delay. If the delay cannot safely fit into the needed number type, it falls back to an immediate redraw.

**Call relations**: The rendering code calls this after drawing, so the animation can continue. It hands off to `FrameRequester` through either `schedule_frame_in` for a timed redraw or `schedule_frame` for an immediate one.

*Call graph*: calls 2 internal fn (schedule_frame, schedule_frame_in); called by 1 (render_ref); 4 external calls (as_millis, from_millis, elapsed, try_from).


##### `AsciiAnimation::current_frame`  (lines 65–77)

```
fn current_frame(&self) -> &'static str
```

**Purpose**: Returns the exact ASCII art frame that should be displayed right now. Callers use this during rendering to know what text to draw on screen.

**Data flow**: It gets the frame list for the currently selected variant. If there are no frames, it returns an empty string. If the frame interval is zero, it always returns the first frame. Otherwise, it measures elapsed time, divides that by the frame interval, wraps the result around the number of frames, and returns the matching frame.

**Call relations**: The render path calls this when it needs to paint the animation. It uses the private `AsciiAnimation::frames` helper to fetch the active variant’s frame list before doing the time-based frame calculation.

*Call graph*: calls 1 internal fn (frames); called by 1 (render_ref); 2 external calls (as_millis, elapsed).


##### `AsciiAnimation::pick_random_variant`  (lines 79–91)

```
fn pick_random_variant(&mut self) -> bool
```

**Purpose**: Switches the animation to a different random variant, if more than one variant exists. This lets a user action change the look of the animation without restarting the whole UI.

**Data flow**: It checks how many variants are available. If there is only one or none to switch to, it returns `false` and changes nothing. Otherwise, it chooses random indexes until it finds one different from the current index, stores that as the new variant, asks the UI for a redraw, and returns `true`.

**Call relations**: Keyboard event handling calls this when the user requests an animation variant change. After updating the selected variant, it tells the redraw system through `schedule_frame` so the new artwork can appear promptly.

*Call graph*: calls 1 internal fn (schedule_frame); called by 1 (handle_key_event); 1 external calls (rng).


##### `AsciiAnimation::frames`  (lines 93–95)

```
fn frames(&self) -> &'static [&'static str]
```

**Purpose**: Returns the list of frames for the currently selected animation variant. It is a small helper that keeps the indexing logic in one place.

**Data flow**: It reads the current variant index from the animation object and uses it to pick the matching frame slice from the stored variant list. It returns that slice without changing any state.

**Call relations**: `AsciiAnimation::current_frame` calls this before choosing the time-appropriate frame. This helper is private because outside code does not need the whole frame list; it usually only needs the current frame to draw.

*Call graph*: called by 1 (current_frame).


##### `tests::frame_tick_must_be_nonzero`  (lines 103–105)

```
fn frame_tick_must_be_nonzero()
```

**Purpose**: Checks that the default frame interval is greater than zero milliseconds. This protects the expected animation timing behavior from accidental configuration changes.

**Data flow**: It reads `FRAME_TICK_DEFAULT`, converts it to milliseconds, and asserts that the value is above zero. The test produces no runtime output when it passes, but it fails during testing if the default tick becomes zero.

**Call relations**: This test supports the assumptions used by `schedule_next_frame` and `current_frame`. Those functions contain safe fallback behavior for a zero tick, but the project’s default animation speed is expected to be a real positive delay.

*Call graph*: 1 external calls (assert!).


### `tui/src/frames.rs`

`data_model` · `terminal rendering`

This file is like a small flipbook library for the terminal interface. Each animation style, such as dots, blocks, bars, or the OpenAI-themed version, is made from 36 plain text pictures stored in separate frame files. Instead of loading those files while the program is running, this file uses Rust’s compile-time include feature to bake the text directly into the application when it is built. That means the animation frames are always available later, even if the original frame files are not present beside the running program.

The `frames_for!` macro is a shortcut that says, in effect, “for this named animation folder, include frame_1.txt through frame_36.txt.” The file then uses that shortcut to create one constant array for each animation variant. `ALL_VARIANTS` gathers those arrays into one list, so other parts of the terminal UI can browse or choose among all available animations without knowing each constant by name.

Finally, `FRAME_TICK_DEFAULT` sets the normal delay between frames to 80 milliseconds. In human terms, this is the rhythm of the flipbook: short enough to feel animated, but not so fast that it becomes unreadable or wasteful.


### Transient progress output
This file applies terminal capability checks to choose and render transient progress reporting for doctor runs.

### `cli/src/doctor/progress.rs`

`io_transport` · `during doctor checks before final report output`

The doctor command needs to do two things at once: reassure a human that checks are still running, and keep the final output clean for people or tools that read it. This file solves that by defining a small progress interface, DoctorProgress, with events for starting a check, sending a heartbeat, finishing, and cleaning up. There are two implementations. QuietProgress does nothing, which is the safest choice for JSON output, redirected output, or simple terminals that may not understand cursor-control codes. StderrProgress writes a temporary status line to standard error, not standard output. Standard error is the side channel commonly used for logs and progress messages, while standard output is reserved for the actual report. StderrProgress rewrites the same terminal line using a carriage return and a clear-line escape code, like updating a sticky note in place instead of adding new notes. A mutex, which is a lock that prevents two threads from changing the same state at once, remembers whether a progress line was written so it can be erased before the final report appears. The main selection function, doctor_progress, chooses between the quiet and stderr versions based on JSON mode, whether stderr is an interactive terminal, and whether the terminal is marked as “dumb.”

#### Function details

##### `doctor_progress`  (lines 25–35)

```
fn doctor_progress(json: bool) -> std::sync::Arc<dyn DoctorProgress>
```

**Purpose**: Chooses the right progress reporter for the current doctor command output mode. It returns either a silent reporter or one that writes temporary progress text to stderr.

**Data flow**: It takes a boolean saying whether the final output should be JSON. It also reads the TERM environment variable and checks whether stderr is an interactive terminal. If progress is safe and useful, it creates a StderrProgress object; otherwise it creates QuietProgress. The result is returned behind a shared pointer so the report-building code can pass it around safely.

**Call relations**: build_report calls this when it is preparing to run doctor checks. doctor_progress asks should_show_progress for the decision, then hands back the chosen DoctorProgress implementation for the rest of the check lifecycle.

*Call graph*: calls 1 internal fn (should_show_progress); called by 1 (build_report); 4 external calls (default, stderr, var, new).


##### `should_show_progress`  (lines 37–39)

```
fn should_show_progress(json: bool, term: Option<&str>, stderr_is_tty: bool) -> bool
```

**Purpose**: Decides whether temporary progress messages should be shown at all. It protects machine-readable output and avoids using terminal tricks where they may not work.

**Data flow**: It receives three facts: whether JSON output is requested, what TERM says about the terminal, and whether stderr is actually a terminal. It returns true only when output is not JSON, stderr is interactive, and the terminal is not labelled “dumb.”

**Call relations**: doctor_progress calls this as its decision point. The tests also exercise this logic indirectly by checking the important combinations of output mode and terminal type.

*Call graph*: called by 1 (doctor_progress).


##### `QuietProgress::begin`  (lines 44–44)

```
fn begin(&self, _label: &'static str)
```

**Purpose**: Accepts the event that a check has started, but intentionally shows nothing. This is used when any progress text would be unwanted or unsafe.

**Data flow**: It receives the check label and ignores it. Nothing is written and no state changes.

**Call relations**: This is called through the DoctorProgress interface when the selected implementation is QuietProgress. It is the silent counterpart to StderrProgress::begin.


##### `QuietProgress::heartbeat`  (lines 46–46)

```
fn heartbeat(&self, _label: &'static str, _elapsed: Duration)
```

**Purpose**: Accepts a “still working” event, but intentionally produces no output. This keeps long-running checks quiet in JSON or non-interactive modes.

**Data flow**: It receives the check label and elapsed time, then ignores both. It returns without writing anything or changing anything.

**Call relations**: This is called through the DoctorProgress interface when quiet mode was selected. It mirrors StderrProgress::heartbeat without producing terminal text.


##### `QuietProgress::finish`  (lines 48–48)

```
fn finish(&self, _label: &'static str, _status: CheckStatus)
```

**Purpose**: Accepts the event that a check has finished, but does not display the result. The final doctor report is responsible for showing outcomes.

**Data flow**: It receives the check label and final status, then ignores both. No output is produced and no state is changed.

**Call relations**: This is called through DoctorProgress for quiet runs. It matches the interface used by StderrProgress, whose finish method is also intentionally silent.


##### `QuietProgress::settle`  (lines 50–50)

```
fn settle(&self)
```

**Purpose**: Performs the final cleanup step for progress output, but has nothing to clean because quiet mode never wrote anything.

**Data flow**: It receives no input and does nothing. The outside world is unchanged.

**Call relations**: The doctor flow can call settle without needing to know which progress implementation was chosen. For QuietProgress, that call is harmless.


##### `StderrProgress::render`  (lines 64–72)

```
fn render(&self, message: String)
```

**Purpose**: Writes one temporary progress message to stderr and remembers that a line was written. This is the shared drawing routine used for start and heartbeat messages.

**Data flow**: It receives a ready-made message string. It first locks its internal state so only one caller updates the terminal state at a time. Then it locks stderr, writes a carriage return plus a clear-line command followed by the message, flushes it so the user sees it immediately, and marks that a progress line exists. If the state lock cannot be taken, it quietly gives up rather than breaking the doctor command.

**Call relations**: StderrProgress::begin and StderrProgress::heartbeat call this after formatting their messages. Later, StderrProgress::settle uses the remembered state to know whether it needs to erase the temporary line.

*Call graph*: called by 2 (begin, heartbeat); 2 external calls (stderr, write!).


##### `StderrProgress::begin`  (lines 76–78)

```
fn begin(&self, label: &'static str)
```

**Purpose**: Shows that a particular doctor check has started. It gives an interactive user immediate feedback such as “Checking network...”.

**Data flow**: It receives the check label, builds a human-readable message from it, and passes that message to render. render then performs the actual stderr writing.

**Call relations**: This is called through the DoctorProgress interface when the selected implementation is StderrProgress. It hands off to StderrProgress::render so all terminal-writing behavior stays in one place.

*Call graph*: calls 1 internal fn (render); 1 external calls (format!).


##### `StderrProgress::heartbeat`  (lines 80–82)

```
fn heartbeat(&self, label: &'static str, elapsed: Duration)
```

**Purpose**: Shows that a check is still running and includes how many seconds have passed. This helps users understand that the command has not frozen.

**Data flow**: It receives the check label and elapsed duration. It turns the duration into seconds, builds a message like “Still checking cache... 12s,” and sends it to render. render updates the same stderr line.

**Call relations**: This is called through the DoctorProgress interface during a long-running check. Like begin, it delegates the actual terminal update to StderrProgress::render.

*Call graph*: calls 1 internal fn (render); 1 external calls (format!).


##### `StderrProgress::finish`  (lines 84–84)

```
fn finish(&self, _label: &'static str, _status: CheckStatus)
```

**Purpose**: Receives the event that a check ended, but intentionally does not print anything. The final report, not the transient progress line, is where results are shown.

**Data flow**: It receives the check label and status and ignores them. No terminal output is produced and no state is changed.

**Call relations**: This is part of the DoctorProgress interface so callers can signal a complete lifecycle. For StderrProgress, visible cleanup is deferred to settle rather than done per check finish.


##### `StderrProgress::settle`  (lines 86–97)

```
fn settle(&self)
```

**Purpose**: Clears the temporary stderr progress line before the final doctor report is printed. This prevents leftover “Checking...” text from sitting above or beside the real report.

**Data flow**: It locks the internal state and checks whether render wrote a line. If not, it returns. If a line was written, it locks stderr, writes the carriage return and clear-line command, flushes it, and records that there is no longer a visible progress line. If the state lock fails, it returns quietly.

**Call relations**: The doctor flow calls settle after progress activity and before final output. It relies on the state set by StderrProgress::render to decide whether cleanup is needed.

*Call graph*: 2 external calls (stderr, write!).


##### `tests::progress_is_quiet_for_json`  (lines 105–111)

```
fn progress_is_quiet_for_json()
```

**Purpose**: Checks that JSON output never shows progress text. This protects JSON output from being mixed with human-only status messages.

**Data flow**: It supplies should_show_progress with JSON mode turned on, a normal terminal name, and an interactive stderr. It expects the answer to be false.

**Call relations**: This test directly guards the same decision used by doctor_progress, ensuring JSON mode always selects the quiet path.

*Call graph*: 1 external calls (assert!).


##### `tests::progress_is_quiet_for_non_tty`  (lines 114–120)

```
fn progress_is_quiet_for_non_tty()
```

**Purpose**: Checks that progress is hidden when stderr is not an interactive terminal. This avoids writing cursor-control text into files, logs, or pipes.

**Data flow**: It calls should_show_progress with human output, a normal terminal name, but stderr marked as not a terminal. It expects false.

**Call relations**: This test protects the non-interactive branch that doctor_progress depends on when output is redirected or captured.

*Call graph*: 1 external calls (assert!).


##### `tests::progress_is_quiet_for_dumb_terminal`  (lines 123–129)

```
fn progress_is_quiet_for_dumb_terminal()
```

**Purpose**: Checks that progress is hidden for terminals marked as “dumb,” meaning they may not understand line-clearing commands. This prevents ugly escape codes from appearing to the user.

**Data flow**: It calls should_show_progress with human output, TERM set to “dumb,” and stderr marked as interactive. It expects false.

**Call relations**: This test covers the terminal-capability check used by doctor_progress before choosing StderrProgress.

*Call graph*: 1 external calls (assert!).


##### `tests::progress_is_shown_for_human_tty_output`  (lines 132–138)

```
fn progress_is_shown_for_human_tty_output()
```

**Purpose**: Checks the positive case: progress should be shown for normal human output in an interactive terminal. This confirms users get feedback when it is safe to display it.

**Data flow**: It calls should_show_progress with JSON mode off, a normal terminal name, and interactive stderr. It expects true.

**Call relations**: This test verifies the condition under which doctor_progress should choose StderrProgress instead of QuietProgress.

*Call graph*: 1 external calls (assert!).
