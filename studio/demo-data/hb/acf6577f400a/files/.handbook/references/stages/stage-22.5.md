# Async primitives, image handling, and miscellaneous small support libraries  `stage-22.5`

This stage is a toolbox of small behind-the-scenes helpers used by many larger parts of the system. The image pieces prepare pictures for safe use: pet files split spritesheets, choose terminal image protocols, and encode Sixel frames; image utilities read, resize, validate, and report clear errors; core and tool helpers manage “original detail” image requests and replace unusable images with text placeholders. Async helpers act like traffic signals: cancellation stops waiting work, readiness lets tasks wait for a safe start, the pauseable stopwatch enforces time limits, and the frame-rate limiter avoids excessive terminal redraws. Sleep-inhibitor files keep the computer awake during an active turn, with separate implementations for macOS, Linux, Windows, and a harmless dummy fallback. Other utilities translate V8 JavaScript results into Rust-friendly values, prove basic V8 linking, cache recent async values with SHA-1 keys, filter replayed interface events, and turn sandbox or configuration settings into compact human-readable summaries. Together these pieces do not drive the main story, but they make startup, display, tool output, and long-running work smoother and safer.

## Files in this stage

### Terminal pet image rendering
These files prepare cached pet animation frames and choose or encode the terminal image protocol payloads used to display them.

### `tui/src/pets/frames.rs`

`domain_logic` · `pet loading / asset preparation`

A pet’s artwork is stored as a spritesheet: one image containing many small frames laid out in rows and columns, like a sheet of stickers. This file prepares those stickers for use by slicing the sheet into individual PNG files named in order, such as frame_000.png and frame_001.png.

The main function first makes sure the target frame folder exists. It then builds the full list of frame paths it expects to find, based on the pet’s declared frame count. If every expected file is already there, it does nothing more and returns the list. This avoids repeating image work on later loads.

If any frame is missing, it treats the folder as incomplete. It removes old frame_*.png files so stale images do not mix with new ones, opens the pet’s spritesheet, and walks through each row and column. For each cell, it calculates the pixel rectangle for that frame, cuts it out, and saves it as a PNG.

The code is careful about bad numbers: it checks for arithmetic overflow and reports useful errors if frame positions or counts do not make sense. Without this file, pet animation loading would either need to understand spritesheets directly or would fail to find the individual frame images it expects.

#### Function details

##### `prepare_png_frames`  (lines 11–52)

```
fn prepare_png_frames(pet: &Pet, frame_dir: &Path) -> Result<Vec<PathBuf>>
```

**Purpose**: This function prepares the image files needed to animate one pet. Given a pet description and a folder, it makes sure that folder contains one correctly named PNG file for each frame in the pet’s spritesheet.

**Data flow**: It receives a Pet, which says where the spritesheet is and how it is divided, plus a destination folder path. It creates the folder if needed, builds the list of expected frame filenames, and checks whether they already exist. If the set is incomplete, it deletes old frame PNGs, opens the spritesheet, cuts it into rectangles using the pet’s frame size, rows, and columns, and writes each rectangle as a PNG. It returns the ordered list of frame file paths, or an error with context if reading, writing, or frame math fails.

**Call relations**: This is called by the pet loading flow, named load in the call graph, when pet assets need to be ready for use. It calls glob_frame_files only when it needs to clean an incomplete frame folder, then relies on filesystem and image library operations to create directories, remove old files, open the spritesheet, and save the new frames. The test also calls it directly to prove the slicing works without an outside image command.

*Call graph*: calls 2 internal fn (glob_frame_files, frame_count); called by 2 (load, prepare_png_frames_slices_spritesheet_without_external_command); 4 external calls (create_dir_all, remove_file, open, try_from).


##### `glob_frame_files`  (lines 54–71)

```
fn glob_frame_files(frame_dir: &Path) -> Result<Vec<PathBuf>>
```

**Purpose**: This helper finds existing generated frame images in a folder. It looks only for files whose names match the project’s generated-frame pattern: starting with frame_ and ending with .png.

**Data flow**: It receives a folder path. If the folder does not exist, it returns an empty list. Otherwise, it reads the folder entries one by one, keeps paths whose filename looks like a generated frame PNG, and returns those paths. If the folder cannot be read, it returns an error that says which folder caused the problem.

**Call relations**: prepare_png_frames calls this when it discovers the frame folder is incomplete. The returned paths are then removed so that an old partial set of frames is cleared before fresh slices are written.

*Call graph*: called by 1 (prepare_png_frames); 3 external calls (exists, new, read_dir).


##### `tests::prepare_png_frames_slices_spritesheet_without_external_command`  (lines 83–115)

```
fn prepare_png_frames_slices_spritesheet_without_external_command()
```

**Purpose**: This test checks that frame preparation can slice a spritesheet using the Rust image library alone, without depending on an external command-line image tool.

**Data flow**: It creates a temporary folder, writes a tiny two-pixel spritesheet with one red pixel and one green pixel, and builds a Pet description saying that the sheet has two one-pixel frames. It calls prepare_png_frames with that pet and a frames folder. Afterward, it checks that two frame paths were returned and that both files exist.

**Call relations**: This test exercises prepare_png_frames in isolation. It supplies a very small, controlled spritesheet so the test can confirm the main frame-slicing path works end to end: make folders, read the image, split it, save frame files, and report the resulting paths.

*Call graph*: calls 1 internal fn (prepare_png_frames); 6 external calls (new, from_fn, new, assert!, assert_eq!, tempdir).


### `tui/src/pets/image_protocol.rs`

`io_transport` · `rendering and terminal capability detection`

Terminal pets are images drawn inside a text terminal. That is harder than it sounds because different terminals speak different image “languages,” and some environments, such as tmux or Zellij, can make images leak between panes or damage scrollback. This file is the safety check and translator for that feature.

First, it detects the user’s terminal environment. It looks for known environment variables, terminal names, versions, and multiplexers. A multiplexer is a tool that splits one terminal into panes, like tmux. If the environment is unsafe, it returns a clear reason and message instead of trying to draw. If it is safe, it chooses Kitty graphics, Kitty local-file graphics for newer iTerm2, or Sixel.

Second, it turns image files into terminal commands. Kitty-style terminals receive special escape sequences, which are hidden control strings that tell the terminal to draw an image. Large inline images are split into chunks. For iTerm2’s local-file mode, the file path is sent instead of the whole image. For Sixel terminals, the file is resized, encoded, and cached on disk so the same frame does not need to be rebuilt every time.

The tests in this file protect the tricky parts: environment detection, version parsing, tmux wrapping, command formatting, and Sixel encoding.

#### Function details

##### `PetImageSupport::protocol`  (lines 40–45)

```
fn protocol(self) -> Option<ImageProtocol>
```

**Purpose**: Returns the chosen image protocol if pets are supported, or nothing if they are not. Other pet drawing code uses this as a simple yes-or-no gateway before trying to render images.

**Data flow**: It starts with a PetImageSupport value. If that value says “supported,” it extracts the ImageProtocol inside it. If it says “unsupported,” it returns no protocol.

**Call relations**: The drawing-related code paths, including draw_request, image_enabled, next_frame_delay, and preview_draw_request, call this when they need to know whether there is a usable image protocol before continuing.

*Call graph*: called by 4 (draw_request, image_enabled, next_frame_delay, preview_draw_request).


##### `PetImageSupport::unsupported_message`  (lines 47–52)

```
fn unsupported_message(self) -> Option<&'static str>
```

**Purpose**: Returns a human-readable explanation when pets cannot be shown. This lets the user see why the feature is unavailable instead of silently failing.

**Data flow**: It receives a PetImageSupport value. If pets are supported, it returns nothing. If they are unsupported, it asks the stored reason for its message and returns that text.

**Call relations**: This is the companion to protocol: callers can use protocol when they want to draw, and unsupported_message when they want to explain why drawing is disabled.


##### `PetImageUnsupportedReason::message`  (lines 64–79)

```
fn message(self) -> &'static str
```

**Purpose**: Turns an internal unsupported reason into the exact message shown to users. The messages explain both what happened and what the user can do about it.

**Data flow**: It receives a reason such as tmux, Zellij, old iTerm2, or unsupported terminal. It matches that reason to a fixed help message and returns the message text.

**Call relations**: PetImageSupport::unsupported_message calls this when it needs to translate a stored reason into user-facing words.


##### `ProtocolSelection::resolve`  (lines 90–96)

```
fn resolve(self) -> PetImageSupport
```

**Purpose**: Converts a user’s protocol choice into an actual support decision. If the user picked a specific protocol, it honors that; if they picked auto, it detects the best option.

**Data flow**: It starts with a ProtocolSelection value. Kitty and Sixel become supported choices immediately. Auto runs terminal detection and returns whatever that detection finds.

**Call relations**: This is the bridge between configuration and runtime behavior. It calls detect_pet_image_support only for automatic selection; explicit choices bypass the safety-based auto detection.

*Call graph*: calls 1 internal fn (detect_pet_image_support); 1 external calls (Supported).


##### `ProtocolSelection::from_str`  (lines 102–109)

```
fn from_str(value: &str) -> Result<Self>
```

**Purpose**: Reads a text setting such as “auto,” “kitty,” or “sixel” and turns it into a ProtocolSelection value. It rejects unknown text with a clear error.

**Data flow**: It receives a string from configuration or command input. Known words become matching protocol selection values. Any other word becomes an error explaining the allowed choices.

**Call relations**: This supports configuration parsing. If parsing fails, it uses the error path so the caller can report the bad protocol name instead of guessing.

*Call graph*: 1 external calls (bail!).


##### `detect_pet_image_support`  (lines 112–133)

```
fn detect_pet_image_support() -> PetImageSupport
```

**Purpose**: Checks the current process environment and decides whether terminal pets should be enabled automatically. It prioritizes safety, especially avoiding environments where images may behave badly.

**Data flow**: It reads environment variables such as TMUX, ZELLIJ, KITTY_WINDOW_ID, and WEZTERM_VERSION. Unsafe multiplexers return unsupported reasons. Known Kitty-compatible terminals return Kitty support. Otherwise it asks the terminal detection library for fuller terminal information and passes that on.

**Call relations**: ProtocolSelection::resolve calls this for the Auto setting. This function does quick environment checks first, then hands detailed terminal information to pet_image_support_for_terminal.

*Call graph*: calls 1 internal fn (pet_image_support_for_terminal); called by 1 (resolve); 4 external calls (terminal_info, var_os, Supported, Unsupported).


##### `pet_image_support_for_terminal`  (lines 135–163)

```
fn pet_image_support_for_terminal(info: &TerminalInfo) -> PetImageSupport
```

**Purpose**: Makes the detailed protocol decision from a TerminalInfo record. It decides between safe rejection, Kitty local-file support, Kitty inline support, Sixel support, or no support.

**Data flow**: It receives structured terminal facts: terminal name, program name, version, TERM string, and multiplexer status. It first rejects tmux and Zellij. Then it checks for new enough iTerm2, old iTerm2, Kitty-style terminals, Sixel terminals, and finally falls back to unsupported.

**Call relations**: detect_pet_image_support calls this after collecting terminal facts. It delegates smaller checks to supports_iterm2_kitty_graphics, is_iterm2_terminal, supports_kitty_graphics, and supports_sixel.

*Call graph*: calls 4 internal fn (is_iterm2_terminal, supports_iterm2_kitty_graphics, supports_kitty_graphics, supports_sixel); called by 1 (detect_pet_image_support); 2 external calls (Supported, Unsupported).


##### `supports_iterm2_kitty_graphics`  (lines 165–171)

```
fn supports_iterm2_kitty_graphics(info: &TerminalInfo) -> bool
```

**Purpose**: Checks whether the terminal is iTerm2 and new enough to use Kitty-style local-file image graphics. This special path exists because recent iTerm2 supports a compatible image route.

**Data flow**: It receives terminal information. It verifies that the terminal looks like iTerm2, then parses the version and compares it with the minimum supported version.

**Call relations**: pet_image_support_for_terminal calls this before general Kitty or Sixel checks. It relies on is_iterm2_terminal and version_is_at_least to make the decision.

*Call graph*: calls 2 internal fn (is_iterm2_terminal, version_is_at_least); called by 1 (pet_image_support_for_terminal).


##### `is_iterm2_terminal`  (lines 173–176)

```
fn is_iterm2_terminal(info: &TerminalInfo) -> bool
```

**Purpose**: Identifies whether the terminal appears to be iTerm2. It checks both a structured terminal name and looser program-name text.

**Data flow**: It receives terminal information. It returns true if the detected terminal name is iTerm2 or if the TERM_PROGRAM-like field contains “iterm” in any letter case.

**Call relations**: pet_image_support_for_terminal uses this to reject old iTerm2 versions, and supports_iterm2_kitty_graphics uses it before checking the version.

*Call graph*: calls 1 internal fn (terminal_field_contains); called by 2 (pet_image_support_for_terminal, supports_iterm2_kitty_graphics); 1 external calls (matches!).


##### `supports_kitty_graphics`  (lines 178–188)

```
fn supports_kitty_graphics(info: &TerminalInfo) -> bool
```

**Purpose**: Checks whether the terminal is likely to understand the Kitty graphics protocol. Kitty graphics are escape-sequence commands used by several modern terminals to display images.

**Data flow**: It receives terminal information. It looks for known terminal names such as Ghostty, Kitty, and WezTerm, and also searches terminal text fields for those names.

**Call relations**: pet_image_support_for_terminal calls this after iTerm2-specific checks. It uses terminal_field_contains to do safe, case-insensitive text matching.

*Call graph*: calls 1 internal fn (terminal_field_contains); called by 1 (pet_image_support_for_terminal); 1 external calls (matches!).


##### `supports_sixel`  (lines 190–195)

```
fn supports_sixel(info: &TerminalInfo) -> bool
```

**Purpose**: Checks whether the terminal is likely to support Sixel, an older terminal image format. This gives pet images a second path on terminals that do not use Kitty graphics.

**Data flow**: It receives terminal information. It returns true for Windows Terminal or when the terminal’s TERM text mentions Sixel-friendly terminals such as sixel, mlterm, or foot.

**Call relations**: pet_image_support_for_terminal calls this after Kitty checks. It uses terminal_field_contains for the string searches.

*Call graph*: calls 1 internal fn (terminal_field_contains); called by 1 (pet_image_support_for_terminal); 1 external calls (matches!).


##### `terminal_field_contains`  (lines 197–199)

```
fn terminal_field_contains(value: Option<&str>, needle: &str) -> bool
```

**Purpose**: Performs a safe, case-insensitive substring check on an optional terminal text field. It avoids repeated boilerplate in terminal detection code.

**Data flow**: It receives an optional string and a search word. If the string exists, it lowercases it and checks whether it contains the search word. If the string is missing, it returns false.

**Call relations**: is_iterm2_terminal, supports_kitty_graphics, and supports_sixel call this whenever they need to inspect terminal text fields.

*Call graph*: called by 3 (is_iterm2_terminal, supports_kitty_graphics, supports_sixel).


##### `version_is_at_least`  (lines 201–203)

```
fn version_is_at_least(version: Option<&str>, minimum: (u64, u64, u64)) -> bool
```

**Purpose**: Checks whether a version string meets a minimum version. It is used to make sure iTerm2 is new enough before enabling its image support.

**Data flow**: It receives an optional version string and a minimum version tuple. It parses the string into numeric parts and compares the result with the minimum. Missing or malformed versions count as not good enough.

**Call relations**: supports_iterm2_kitty_graphics calls this after confirming the terminal appears to be iTerm2. It depends on parse_dotted_version for the parsing step.

*Call graph*: calls 1 internal fn (parse_dotted_version); called by 1 (supports_iterm2_kitty_graphics).


##### `parse_dotted_version`  (lines 205–217)

```
fn parse_dotted_version(version: Option<&str>) -> Option<(u64, u64, u64)>
```

**Purpose**: Parses simple version text like “3.6.10” into three numbers. It intentionally accepts only plain numeric dotted versions so version comparisons stay predictable.

**Data flow**: It receives an optional string. If present, it splits it on dots, reads major, minor, and patch numbers, fills missing minor or patch as zero, and rejects extra or non-numeric parts. It returns the three numbers or nothing.

**Call relations**: version_is_at_least calls this before comparing versions. The tests cover normal, shortened, missing, and malformed version strings.

*Call graph*: called by 1 (version_is_at_least).


##### `kitty_delete_image`  (lines 219–221)

```
fn kitty_delete_image(image_id: u32) -> String
```

**Purpose**: Builds a Kitty graphics command that asks the terminal to delete a previously drawn image by ID. This is used to clean up terminal images instead of leaving stale drawings behind.

**Data flow**: It receives an image ID number. It formats a Kitty delete escape sequence for that ID, then wraps it for tmux if tmux wrapping is needed. It returns the command string to write to the terminal.

**Call relations**: This uses wrap_for_tmux_if_needed so deletion commands follow the same terminal-routing rules as drawing commands.

*Call graph*: calls 1 internal fn (wrap_for_tmux_if_needed); 1 external calls (format!).


##### `kitty_transmit_png_with_id`  (lines 223–252)

```
fn kitty_transmit_png_with_id(
    path: &Path,
    columns: u16,
    rows: u16,
    image_id: Option<u32>,
) -> Result<String>
```

**Purpose**: Builds Kitty graphics commands that send the actual PNG file contents directly to the terminal. It is used when the terminal expects inline image data.

**Data flow**: It receives a PNG path, target size in terminal columns and rows, and an optional image ID. It reads the file, base64-encodes the bytes into terminal-safe text, splits the text into chunks, formats Kitty transfer commands, optionally includes the image ID, wraps for tmux if needed, and returns the final command string.

**Call relations**: render_pet_image calls this when drawing a pet through inline Kitty graphics. The test kitty_png_transmission_encodes_inline_data checks that the command contains the encoded PNG data and proper control sequence framing.

*Call graph*: calls 2 internal fn (kitty_image_id_arg, wrap_for_tmux_if_needed); called by 2 (kitty_png_transmission_encodes_inline_data, render_pet_image); 5 external calls (new, format!, read, from_utf8, from).


##### `kitty_transmit_png_file_with_id`  (lines 254–268)

```
fn kitty_transmit_png_file_with_id(
    path: &Path,
    columns: u16,
    rows: u16,
    image_id: Option<u32>,
) -> Result<String>
```

**Purpose**: Builds a Kitty-compatible command that tells the terminal to load a PNG from a local file path. This is useful for terminals such as newer iTerm2 that support file references instead of inline data.

**Data flow**: It receives a PNG path, target terminal size, and optional image ID. It canonicalizes the path to make it absolute and normalized, base64-encodes the path text, formats a local-file graphics command, wraps for tmux if needed, and returns the command string.

**Call relations**: render_pet_image calls this for the local-file protocol. The test kitty_file_png_transmission_encodes_local_file_reference verifies the exact command shape.

*Call graph*: calls 2 internal fn (kitty_image_id_arg, wrap_for_tmux_if_needed); called by 2 (kitty_file_png_transmission_encodes_local_file_reference, render_pet_image); 3 external calls (canonicalize, to_string_lossy, format!).


##### `kitty_image_id_arg`  (lines 270–274)

```
fn kitty_image_id_arg(image_id: Option<u32>) -> String
```

**Purpose**: Formats the optional Kitty image ID part of a command. It keeps the drawing functions from duplicating the same small formatting rule.

**Data flow**: It receives an optional image ID. If there is an ID, it returns text like “,i=7”. If there is no ID, it returns an empty string.

**Call relations**: kitty_transmit_png_with_id and kitty_transmit_png_file_with_id call this while building their first command segment.

*Call graph*: called by 2 (kitty_transmit_png_file_with_id, kitty_transmit_png_with_id).


##### `wrap_for_tmux_if_needed`  (lines 276–283)

```
fn wrap_for_tmux_if_needed(command: &str) -> String
```

**Purpose**: Wraps terminal image commands so tmux can pass them through to the real terminal. Tmux is like a middle layer; without the wrapper, it may swallow or misread the escape sequence.

**Data flow**: It receives a terminal command string. If TMUX is not set, it returns the command unchanged. If TMUX is set, it doubles escape characters and surrounds the command with tmux passthrough markers.

**Call relations**: kitty_delete_image, kitty_transmit_png_with_id, and kitty_transmit_png_file_with_id all call this before returning commands. The tmux_passthrough_wraps_and_escapes_control_sequence test checks the wrapping behavior.

*Call graph*: called by 3 (kitty_delete_image, kitty_transmit_png_file_with_id, kitty_transmit_png_with_id); 2 external calls (var_os, format!).


##### `sixel_frame`  (lines 285–310)

```
fn sixel_frame(frame_path: &Path, cache_dir: &Path, height_px: u16) -> Result<PathBuf>
```

**Purpose**: Creates or reuses a cached Sixel version of an image frame at a requested pixel height. This avoids repeatedly resizing and encoding the same pet frame.

**Data flow**: It receives the source frame path, a cache directory, and desired height in pixels. It creates the cache directory, builds a cache filename from the source name and height, returns it immediately if it already exists, otherwise opens the image, resizes it while preserving aspect ratio, converts it to RGBA pixels, encodes those pixels as Sixel text, writes the cached file, and returns the cache path.

**Call relations**: render_pet_image calls this when using the Sixel protocol. It hands pixel data to sixel::encode_rgba for encoding, and the sixel_frame_encodes_without_external_crate test verifies the generated Sixel output.

*Call graph*: calls 1 internal fn (encode_rgba); called by 2 (sixel_frame_encodes_without_external_crate, render_pet_image); 8 external calls (file_stem, join, format!, create_dir_all, write, open, from, from).


##### `tests::EnvVarGuard::new`  (lines 324–331)

```
fn new(name: &'static str, value: Option<&str>) -> Self
```

**Purpose**: Temporarily changes an environment variable for a test and remembers its old value. This keeps tests from permanently changing the process environment.

**Data flow**: It receives an environment variable name and either a new value or no value. It records the current value, sets or removes the variable for the test, and returns a guard object holding the original state.

**Call relations**: Many tests call this before checking environment-sensitive behavior, such as tmux, Zellij, Kitty, and WezTerm detection. Its paired drop method restores the environment afterward.

*Call graph*: 3 external calls (remove_var, set_var, var_os).


##### `tests::EnvVarGuard::drop`  (lines 335–340)

```
fn drop(&mut self)
```

**Purpose**: Restores an environment variable when the test guard goes out of scope. This cleanup prevents one test’s environment changes from leaking into another test.

**Data flow**: It reads the saved previous value from the guard. If there was a previous value, it sets the environment variable back. If there was not, it removes the variable.

**Call relations**: Rust calls this automatically when an EnvVarGuard is dropped. It completes the temporary setup started by tests::EnvVarGuard::new.

*Call graph*: 2 external calls (remove_var, set_var).


##### `tests::kitty_png_transmission_encodes_inline_data`  (lines 345–359)

```
fn kitty_png_transmission_encodes_inline_data()
```

**Purpose**: Checks that inline Kitty PNG transmission reads a file, base64-encodes it, and wraps it in the expected Kitty control sequence.

**Data flow**: The test clears TMUX, writes a tiny fake PNG file, calls kitty_transmit_png_with_id, then checks the command prefix, encoded payload text, and ending marker.

**Call relations**: This test directly exercises kitty_transmit_png_with_id and protects render_pet_image from receiving malformed Kitty inline commands.

*Call graph*: calls 1 internal fn (kitty_transmit_png_with_id); 4 external calls (new, assert!, write, tempdir).


##### `tests::tmux_passthrough_wraps_and_escapes_control_sequence`  (lines 363–369)

```
fn tmux_passthrough_wraps_and_escapes_control_sequence()
```

**Purpose**: Checks that terminal commands are correctly wrapped for tmux passthrough. This protects the special escaping needed when tmux sits between Codex and the terminal.

**Data flow**: The test sets TMUX, passes a small escape sequence to wrap_for_tmux_if_needed, and compares the result with the exact expected wrapped string.

**Call relations**: It covers the helper used by Kitty drawing and deletion commands, confirming that wrap_for_tmux_if_needed behaves correctly in a tmux environment.

*Call graph*: 2 external calls (new, assert_eq!).


##### `tests::parses_protocol_selection`  (lines 372–385)

```
fn parses_protocol_selection()
```

**Purpose**: Checks that text protocol settings are parsed into the correct selection values. This protects user-facing configuration input.

**Data flow**: The test parses “auto,” “kitty,” and “sixel” as ProtocolSelection values and compares each result with the expected enum value.

**Call relations**: It exercises ProtocolSelection::from_str, which configuration or command parsing code relies on.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::auto_protocol_is_disabled_inside_tmux`  (lines 389–396)

```
fn auto_protocol_is_disabled_inside_tmux()
```

**Purpose**: Verifies that automatic protocol detection disables pets inside tmux. This protects users from the known unsafe tmux image behavior.

**Data flow**: The test sets TMUX, resolves the Auto protocol selection, and expects an unsupported result with the tmux reason.

**Call relations**: It exercises ProtocolSelection::resolve and, through it, detect_pet_image_support.

*Call graph*: 2 external calls (new, assert_eq!).


##### `tests::explicit_protocol_still_resolves_inside_tmux`  (lines 400–411)

```
fn explicit_protocol_still_resolves_inside_tmux()
```

**Purpose**: Verifies that explicit user choices still resolve to the requested protocol even inside tmux. This shows that auto-detection is safety-first, but manual override is still respected.

**Data flow**: The test sets TMUX, resolves explicit Kitty and Sixel selections, and expects supported results for each.

**Call relations**: It exercises ProtocolSelection::resolve for non-auto choices, confirming that those paths do not call automatic detection.

*Call graph*: 2 external calls (new, assert_eq!).


##### `tests::pet_image_support_prefers_multiplexer_safety`  (lines 414–433)

```
fn pet_image_support_prefers_multiplexer_safety()
```

**Purpose**: Checks that tmux and Zellij are rejected before considering terminal image capabilities. Safety wins even if the underlying terminal would normally support images.

**Data flow**: The test builds fake terminal information for Kitty-like terminals running under tmux or Zellij. It passes those records to pet_image_support_for_terminal and expects unsupported multiplexer reasons.

**Call relations**: It directly tests pet_image_support_for_terminal’s priority order.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::pet_image_support_detects_iterm2_kitty_file_graphics`  (lines 436–458)

```
fn pet_image_support_detects_iterm2_kitty_file_graphics()
```

**Purpose**: Checks that new enough iTerm2 is recognized as supporting Kitty local-file graphics. This protects the special iTerm2 path.

**Data flow**: The test builds terminal records that look like iTerm2 version 3.6.10, passes them to pet_image_support_for_terminal, and expects KittyLocalFile support.

**Call relations**: It exercises the path through supports_iterm2_kitty_graphics, is_iterm2_terminal, and version_is_at_least.

*Call graph*: 2 external calls (assert_eq!, terminal_info_with_version_for_test).


##### `tests::pet_image_support_rejects_old_iterm2_versions`  (lines 461–490)

```
fn pet_image_support_rejects_old_iterm2_versions()
```

**Purpose**: Checks that old or unknown iTerm2 versions are rejected with the iTerm2-too-old reason. This prevents enabling a protocol that older iTerm2 versions may not support.

**Data flow**: The test creates several iTerm2-like terminal records with version 3.5, missing version, or shortened old version. Each is passed to pet_image_support_for_terminal and expected to return the old-iTerm2 unsupported reason.

**Call relations**: It covers the negative side of the iTerm2 version logic used by pet_image_support_for_terminal.

*Call graph*: 2 external calls (assert_eq!, terminal_info_with_version_for_test).


##### `tests::pet_image_support_old_iterm2_message_mentions_upgrade`  (lines 493–501)

```
fn pet_image_support_old_iterm2_message_mentions_upgrade()
```

**Purpose**: Checks that the old-iTerm2 unsupported message tells the user to upgrade. This protects the helpful wording shown when pets are unavailable.

**Data flow**: The test creates an unsupported PetImageSupport value with the Iterm2TooOld reason, asks for its message, and compares it with the expected text.

**Call relations**: It exercises PetImageSupport::unsupported_message and PetImageUnsupportedReason::message.

*Call graph*: 2 external calls (assert_eq!, Unsupported).


##### `tests::pet_image_support_detects_kitty_graphics_terminals`  (lines 504–548)

```
fn pet_image_support_detects_kitty_graphics_terminals()
```

**Purpose**: Checks that common Kitty-compatible terminals are detected correctly. This includes known names and looser TERM or program-name hints.

**Data flow**: The test builds several terminal records for Ghostty, Kitty, WezTerm, and text hints such as xterm-kitty. Each record is passed to pet_image_support_for_terminal and expected to return Kitty support.

**Call relations**: It covers the supports_kitty_graphics branch of pet_image_support_for_terminal.

*Call graph*: 2 external calls (assert_eq!, terminal_info_for_test).


##### `tests::pet_image_support_detects_sixel_terminals`  (lines 551–583)

```
fn pet_image_support_detects_sixel_terminals()
```

**Purpose**: Checks that Sixel-capable terminals are detected correctly. This protects the fallback image path for terminals that do not use Kitty graphics.

**Data flow**: The test builds terminal records with Sixel-related TERM values or Windows Terminal as the detected name. Each is passed to pet_image_support_for_terminal and expected to return Sixel support.

**Call relations**: It covers the supports_sixel branch of pet_image_support_for_terminal.

*Call graph*: 2 external calls (assert_eq!, terminal_info_for_test).


##### `tests::wezterm_env_uses_kitty_graphics_for_ambient_pets`  (lines 587–601)

```
fn wezterm_env_uses_kitty_graphics_for_ambient_pets()
```

**Purpose**: Checks that WezTerm environment variables are enough for automatic detection to choose Kitty graphics. This catches cases where terminal detection can be decided from the process environment alone.

**Data flow**: The test clears tmux, Zellij, and Kitty environment markers, sets WEZTERM_VERSION, calls detect_pet_image_support, and expects Kitty support.

**Call relations**: It directly exercises detect_pet_image_support’s early environment-variable checks.

*Call graph*: 2 external calls (new, assert_eq!).


##### `tests::pet_image_support_rejects_unknown_terminals`  (lines 604–614)

```
fn pet_image_support_rejects_unknown_terminals()
```

**Purpose**: Checks that an ordinary unknown terminal is rejected instead of guessing. This avoids sending image control codes to terminals that may not understand them.

**Data flow**: The test builds a terminal record with an unknown name and a generic xterm-256color TERM value. It passes that to pet_image_support_for_terminal and expects the generic terminal unsupported reason.

**Call relations**: It covers the final fallback path in pet_image_support_for_terminal.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::terminal_info_for_test`  (lines 616–629)

```
fn terminal_info_for_test(
        name: TerminalName,
        multiplexer: Option<Multiplexer>,
        term_program: Option<&str>,
        term: Option<&str>,
    ) -> TerminalInfo
```

**Purpose**: Builds a TerminalInfo test record without a version number. It keeps test setup short and readable.

**Data flow**: It receives a terminal name, optional multiplexer, optional program name, and optional TERM value. It forwards those values with no version to the fuller test helper and returns a TerminalInfo record.

**Call relations**: Several detection tests call this when they do not need to test version-specific behavior.

*Call graph*: 1 external calls (terminal_info_with_version_for_test).


##### `tests::terminal_info_with_version_for_test`  (lines 631–645)

```
fn terminal_info_with_version_for_test(
        name: TerminalName,
        multiplexer: Option<Multiplexer>,
        term_program: Option<&str>,
        version: Option<&str>,
        term: Option<&s
```

**Purpose**: Builds a complete TerminalInfo test record, including an optional version. This gives tests precise fake terminal environments without relying on the real user’s terminal.

**Data flow**: It receives terminal name, multiplexer, program name, version, and TERM text. It converts optional string slices into owned strings and returns a TerminalInfo value.

**Call relations**: Version-sensitive tests call this directly, and tests::terminal_info_for_test uses it as its shared builder.


##### `tests::parse_dotted_version_requires_simple_numeric_components`  (lines 648–655)

```
fn parse_dotted_version_requires_simple_numeric_components()
```

**Purpose**: Checks that version parsing accepts only simple numeric dotted versions. This protects version comparison from ambiguous strings such as beta labels.

**Data flow**: The test calls parse_dotted_version with full, shortened, too-long, non-numeric, and missing versions. It compares each result with the expected parsed tuple or no result.

**Call relations**: It directly covers parse_dotted_version, which feeds version_is_at_least for iTerm2 support detection.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::sixel_frame_encodes_without_external_crate`  (lines 658–672)

```
fn sixel_frame_encodes_without_external_crate()
```

**Purpose**: Checks that Sixel frame generation works and produces recognizable Sixel output. This protects the image resizing, encoding, and cache-writing path.

**Data flow**: The test creates a temporary 1-by-1 red image, saves it, calls sixel_frame, reads the generated Sixel file, and checks for expected start, color, pixel, and ending markers.

**Call relations**: It exercises sixel_frame and, through it, the internal Sixel encoder used by render_pet_image.

*Call graph*: calls 1 internal fn (sixel_frame); 5 external calls (assert!, read_to_string, Rgba, from_pixel, tempdir).


##### `tests::kitty_file_png_transmission_encodes_local_file_reference`  (lines 676–696)

```
fn kitty_file_png_transmission_encodes_local_file_reference()
```

**Purpose**: Checks that local-file Kitty transmission encodes the file path and includes the optional image ID. This protects the command format used for iTerm2-style file references.

**Data flow**: The test clears TMUX, writes a temporary file, calls kitty_transmit_png_file_with_id with image ID 7, computes the expected base64-encoded canonical path, and compares the full command string.

**Call relations**: It directly exercises kitty_transmit_png_file_with_id, which render_pet_image uses for the KittyLocalFile protocol.

*Call graph*: calls 1 internal fn (kitty_transmit_png_file_with_id); 4 external calls (new, assert_eq!, write, tempdir).


### `tui/src/pets/sixel.rs`

`io_transport` · `rendering pet frames`

This file is a compact image encoder built for one job: showing pet sprites in a terminal. The input is an RGBA image, meaning every pixel has red, green, blue, and alpha values; alpha is the transparency value. The output is a Sixel escape sequence, which is a stream of bytes a compatible terminal reads as an image.

The encoder first checks that the image size is valid and that the byte buffer really contains four bytes per pixel. It then builds a small palette of only the visible colors used by the image. To keep things simple and predictable, it reduces colors to RGB332: 3 bits of red, 3 bits of green, and 2 bits of blue, for at most 256 possible colors. Think of this like sorting many paint shades into a fixed 256-slot crayon box.

Sixel draws images in horizontal strips that are 6 pixels tall. For each strip, this file finds which colors appear, then writes one color layer at a time. Transparent pixels are skipped rather than painted. Repeated identical Sixel bytes are compressed with Sixel run-length encoding, which is like writing “four of these” instead of writing the same mark four times. Without this file, pet images would remain raw pixels and could not be sent to the terminal as drawable Sixel graphics.

#### Function details

##### `encode_rgba`  (lines 18–41)

```
fn encode_rgba(rgba: &[u8], width: u32, height: u32) -> Result<Vec<u8>>
```

**Purpose**: This is the main entry point for converting a small RGBA image into Sixel bytes. It validates the image, builds the color palette, writes the Sixel header and pixel data, and returns the complete byte sequence for the terminal.

**Data flow**: It receives raw RGBA bytes plus a width and height. It checks that the dimensions are not zero and that the buffer length matches width × height × 4, then creates a palette from visible pixels, writes Sixel setup bytes, writes palette definitions and pixel data, appends the Sixel ending marker, and returns the finished byte vector or an error.

**Call relations**: Pet rendering code calls this through sixel_frame when it needs a terminal-ready image. The tests also call it directly to prove normal pixels, transparent pixels, multi-band images, repeated runs, and invalid buffer sizes behave correctly. Inside, it delegates palette creation to Palette::from_rgba, size checking to pixel_count, and image body writing to write_pixels.

*Call graph*: calls 3 internal fn (from_rgba, pixel_count, write_pixels); called by 6 (sixel_frame, encodes_red_pixel_with_palette_and_pixel_data, multi_band_images_advance_to_next_sixel_band, rejects_mismatched_rgba_buffer_length, repeated_cells_use_sixel_run_length_encoding, transparent_pixels_do_not_emit_palette_or_pixel_data); 3 external calls (new, bail!, format!).


##### `write_pixels`  (lines 43–78)

```
fn write_pixels(
    output: &mut Vec<u8>,
    rgba: &[u8],
    width: u32,
    height: u32,
    palette: &Palette,
) -> Result<()>
```

**Purpose**: This writes the actual Sixel drawing commands for the image pixels after the header and palette have been prepared. It walks through the image in 6-pixel-tall bands, because that is how Sixel represents vertical pixel groups.

**Data flow**: It receives the output byte buffer, RGBA image data, image size, and palette. For each 6-row band, it finds the colors that appear in that band, writes one color plane at a time, turns each column into a Sixel byte, compresses repeated bytes, and appends band movement markers when moving downward.

**Call relations**: encode_rgba calls this once the palette and header are ready. It asks active_colors_for_band which colors matter, asks sixel_data_for_column what byte represents each column for a color, and uses push_run and flush_run to keep the output compact.

*Call graph*: calls 4 internal fn (active_colors_for_band, flush_run, push_run, sixel_data_for_column); called by 1 (encode_rgba); 1 external calls (format!).


##### `active_colors_for_band`  (lines 80–100)

```
fn active_colors_for_band(
    rgba: &[u8],
    width: u32,
    height: u32,
    band_top: u32,
    palette: &Palette,
) -> Result<Vec<u8>>
```

**Purpose**: This finds which palette colors are actually present in one 6-pixel-tall Sixel band. It avoids writing color layers that would draw nothing.

**Data flow**: It receives the image data, dimensions, the top row of the band, and the palette. It scans visible pixels in that band, marks their reduced color indexes as active, then returns those active indexes in palette order.

**Call relations**: write_pixels calls this at the start of each band. It uses color_index_at to interpret each pixel and Palette::indices to keep the returned colors limited to colors known by the palette.

*Call graph*: calls 2 internal fn (indices, color_index_at); called by 1 (write_pixels); 1 external calls (from).


##### `sixel_data_for_column`  (lines 102–123)

```
fn sixel_data_for_column(
    rgba: &[u8],
    width: u32,
    height: u32,
    band_top: u32,
    x: u32,
    color_index: u8,
) -> Result<u8>
```

**Purpose**: This turns one vertical stack of up to 6 pixels into the single byte Sixel expects for one column and one color. Each bit in the byte says whether that color appears at a row within the 6-pixel stack.

**Data flow**: It receives the image data, dimensions, band top row, x position, and color index. It checks up to six pixels in that column, sets a bit for each visible pixel matching the requested color, converts that bit mask into the Sixel character range, and returns the byte.

**Call relations**: write_pixels calls this while writing each color layer across a band. It relies on color_index_at to decide whether each source pixel is transparent or belongs to the requested reduced color.

*Call graph*: calls 1 internal fn (color_index_at); called by 1 (write_pixels).


##### `color_index_at`  (lines 125–137)

```
fn color_index_at(rgba: &[u8], width: u32, x: u32, y: u32) -> Result<Option<u8>>
```

**Purpose**: This reads one pixel and answers which reduced palette color it belongs to, or says there is no color if the pixel is transparent. It is the central rule for treating transparency consistently.

**Data flow**: It receives the RGBA buffer, image width, and pixel coordinates. It computes the byte offset, reads the alpha value, returns None for pixels below the transparency threshold, or converts the red, green, and blue bytes into an RGB332 color index.

**Call relations**: active_colors_for_band calls this while discovering which colors exist in a band. sixel_data_for_column calls it while building the bit pattern for one Sixel column. It depends on pixel_offset for safe indexing and rgb332_index for color reduction.

*Call graph*: calls 2 internal fn (pixel_offset, rgb332_index); called by 2 (active_colors_for_band, sixel_data_for_column).


##### `push_run`  (lines 139–150)

```
fn push_run(run_char: &mut Option<u8>, run_len: &mut usize, output: &mut Vec<u8>, byte: u8)
```

**Purpose**: This adds one Sixel byte to the current run of repeated bytes. It helps compress the output when many neighboring columns look the same.

**Data flow**: It receives the current run character, current run length, output buffer, and the next byte. If the byte matches the current run, it increases the count; otherwise it flushes the old run to output and starts a new one with the new byte.

**Call relations**: write_pixels calls this for each column byte. When a byte changes, push_run hands off to flush_run so the completed repeated sequence is written before a new sequence begins.

*Call graph*: calls 1 internal fn (flush_run); called by 1 (write_pixels).


##### `flush_run`  (lines 152–164)

```
fn flush_run(run_char: &mut Option<u8>, run_len: &mut usize, output: &mut Vec<u8>)
```

**Purpose**: This writes the current repeated-byte run into the output buffer. Long runs use Sixel’s compact repeat form; short runs are written out plainly.

**Data flow**: It receives the current run character, run length, and output buffer. If there is no run, it does nothing. If the run length is greater than 3, it writes a repeat command like “repeat this byte N times”; otherwise it writes the byte the needed number of times. It then clears the run length.

**Call relations**: push_run calls this whenever a run ends because a different byte appears. write_pixels also calls it at the end of each color row so the final pending run is not lost.

*Call graph*: called by 2 (push_run, write_pixels); 2 external calls (format!, repeat_n).


##### `pixel_offset`  (lines 166–175)

```
fn pixel_offset(width: u32, x: u32, y: u32) -> Result<usize>
```

**Purpose**: This safely converts pixel coordinates into the byte position inside the RGBA buffer. It protects the encoder from arithmetic overflow when calculating indexes.

**Data flow**: It receives image width and x/y coordinates. It computes y × width + x to get the pixel number, multiplies by 4 because RGBA uses four bytes per pixel, checks each arithmetic step for overflow, and returns the byte offset as a usize or an error.

**Call relations**: color_index_at calls this before reading a pixel. This keeps all pixel reads using the same checked indexing path.

*Call graph*: called by 1 (color_index_at); 2 external calls (from, try_from).


##### `pixel_count`  (lines 177–182)

```
fn pixel_count(width: u32, height: u32) -> Result<usize>
```

**Purpose**: This safely computes how many pixels an image contains. It is used before checking the expected RGBA buffer length.

**Data flow**: It receives width and height. It multiplies them using checked arithmetic, converts the result into the platform’s usize type, and returns either the count or an error if the value is too large.

**Call relations**: encode_rgba calls this during input validation, before it trusts the RGBA buffer size.

*Call graph*: called by 1 (encode_rgba); 2 external calls (from, try_from).


##### `rgb332_index`  (lines 184–189)

```
fn rgb332_index(red: u8, green: u8, blue: u8) -> u8
```

**Purpose**: This reduces a full red-green-blue color into one of 256 RGB332 palette slots. It trades fine color detail for a fixed, simple palette that Sixel can define predictably.

**Data flow**: It receives red, green, and blue bytes. It keeps the top 3 bits of red, top 3 bits of green, and top 2 bits of blue, then packs those bits into one 8-bit color index.

**Call relations**: Palette::from_rgba uses this to record which colors the image uses. color_index_at uses it to identify the reduced color of each visible pixel while writing image data.

*Call graph*: called by 2 (from_rgba, color_index_at).


##### `rgb332_color`  (lines 191–200)

```
fn rgb332_color(index: u8) -> (u8, u8, u8)
```

**Purpose**: This turns an RGB332 palette index back into approximate red, green, and blue byte values. It is used when writing Sixel palette definitions.

**Data flow**: It receives a packed color index. It separates the red, green, and blue buckets, scales each bucket back to the 0–255 color range, and returns the three approximate color bytes.

**Call relations**: Palette::write_definitions calls this for every used palette index so the Sixel output can tell the terminal what each color number means. It uses scale_bucket_to_byte for the bucket-to-byte conversion.

*Call graph*: calls 1 internal fn (scale_bucket_to_byte); called by 1 (write_definitions).


##### `scale_bucket_to_byte`  (lines 202–205)

```
fn scale_bucket_to_byte(bucket: u8, max: u8) -> u8
```

**Purpose**: This expands a small color bucket number back into a normal 0–255 color byte. It is the helper that turns reduced RGB332 values into displayable color intensities.

**Data flow**: It receives a bucket value and the maximum bucket value for that channel. It scales the bucket proportionally into the 0–255 range and returns the result as a byte, falling back safely if conversion somehow exceeds the byte range.

**Call relations**: rgb332_color calls this once for each color channel when reconstructing palette colors for Sixel definitions.

*Call graph*: called by 1 (rgb332_color); 2 external calls (from, try_from).


##### `byte_to_sixel_percent`  (lines 207–210)

```
fn byte_to_sixel_percent(value: u8) -> u8
```

**Purpose**: This converts a normal 0–255 color value into the 0–100 percentage format used by Sixel palette definitions. Sixel describes palette colors as percentages rather than raw bytes.

**Data flow**: It receives one color byte. It scales that byte from the 0–255 range into 0–100 and returns the percentage as a byte.

**Call relations**: Palette::write_definitions uses this conversion while writing each color definition, after rgb332_color has produced approximate red, green, and blue byte values.

*Call graph*: 2 external calls (from, try_from).


##### `Palette::from_rgba`  (lines 217–228)

```
fn from_rgba(rgba: &[u8]) -> Self
```

**Purpose**: This builds the image’s Sixel palette from visible pixels only. Transparent pixels do not reserve colors because they will not be drawn.

**Data flow**: It receives the whole RGBA buffer. It reads pixels four bytes at a time, skips any pixel below the transparency threshold, converts visible pixels to RGB332 indexes, marks those indexes as used, and returns a Palette containing that used-color table.

**Call relations**: encode_rgba calls this before writing any Sixel data. Later, Palette::indices and Palette::write_definitions use the recorded color table to decide which colors need to appear in the output.

*Call graph*: calls 1 internal fn (rgb332_index); called by 1 (encode_rgba); 1 external calls (from).


##### `Palette::indices`  (lines 230–232)

```
fn indices(&self) -> impl Iterator<Item = u8> + '_
```

**Purpose**: This lists the palette color indexes that are actually used by the image. It gives the rest of the encoder a clean way to loop only over meaningful colors.

**Data flow**: It reads the Palette’s internal 256-entry used-color table. It yields each color index whose entry is marked true.

**Call relations**: Palette::write_definitions calls this to write definitions only for used colors. active_colors_for_band calls it to return active colors in palette order for each 6-pixel band.

*Call graph*: called by 2 (write_definitions, active_colors_for_band).


##### `Palette::write_definitions`  (lines 234–247)

```
fn write_definitions(&self, output: &mut Vec<u8>)
```

**Purpose**: This writes Sixel palette definitions into the output. These definitions tell the terminal what red, green, and blue values each palette number should represent.

**Data flow**: It receives the palette and the output byte buffer. For each used color index, it converts the RGB332 index back to approximate RGB bytes, converts those bytes into Sixel percentages, formats a Sixel color definition, and appends it to the output.

**Call relations**: encode_rgba uses this after writing the Sixel header and before writing pixels. It relies on Palette::indices to find used colors, rgb332_color to reconstruct color values, and byte_to_sixel_percent to express those values in Sixel’s required percentage scale.

*Call graph*: calls 2 internal fn (indices, rgb332_color); 1 external calls (format!).


##### `tests::encodes_red_pixel_with_palette_and_pixel_data`  (lines 257–265)

```
fn encodes_red_pixel_with_palette_and_pixel_data()
```

**Purpose**: This test checks the simplest visible image: one opaque red pixel. It proves the encoder writes the transparent-background header, defines the red palette entry, emits the pixel data, and closes the Sixel sequence.

**Data flow**: It creates a one-pixel RGBA buffer for solid red, passes it to encode_rgba, converts the returned bytes into text, and compares the whole output with the expected Sixel string.

**Call relations**: The test calls encode_rgba directly. It protects the main path where Palette::from_rgba, Palette::write_definitions, and write_pixels all need to work together correctly.

*Call graph*: calls 1 internal fn (encode_rgba); 2 external calls (from_utf8, assert_eq!).


##### `tests::transparent_pixels_do_not_emit_palette_or_pixel_data`  (lines 268–276)

```
fn transparent_pixels_do_not_emit_palette_or_pixel_data()
```

**Purpose**: This test checks that a fully transparent pixel produces no palette entry and no drawn pixel. It confirms transparency is treated as absence, not as a visible color.

**Data flow**: It creates a one-pixel RGBA buffer with alpha 0, encodes it, turns the result into text, and compares it with a Sixel sequence containing only the header, size, and ending marker.

**Call relations**: The test calls encode_rgba directly. It verifies the transparency choices made by Palette::from_rgba and color_index_at show up correctly in the final output.

*Call graph*: calls 1 internal fn (encode_rgba); 2 external calls (from_utf8, assert_eq!).


##### `tests::multi_band_images_advance_to_next_sixel_band`  (lines 279–294)

```
fn multi_band_images_advance_to_next_sixel_band()
```

**Purpose**: This test checks that images taller than 6 pixels move correctly from one Sixel band to the next. That matters because Sixel encodes vertical data in 6-pixel chunks.

**Data flow**: It builds a 1-pixel-wide, 7-pixel-tall red image, encodes it, converts the output into text, and compares it with an expected string that includes the band-advance marker.

**Call relations**: The test calls encode_rgba, which reaches write_pixels and sixel_data_for_column. It specifically guards the logic that separates the first 6 rows from the next row.

*Call graph*: calls 1 internal fn (encode_rgba); 3 external calls (from_utf8, new, assert_eq!).


##### `tests::repeated_cells_use_sixel_run_length_encoding`  (lines 297–307)

```
fn repeated_cells_use_sixel_run_length_encoding()
```

**Purpose**: This test checks that repeated Sixel cells are compressed using Sixel run-length encoding. This keeps output shorter when adjacent columns are identical.

**Data flow**: It builds a 4-pixel-wide row of identical red pixels, encodes it, converts the result into text, and checks that the output contains the compact repeat form for four identical cells.

**Call relations**: The test calls encode_rgba and indirectly exercises write_pixels, push_run, and flush_run. It confirms the compression helpers are actually used in the generated Sixel.

*Call graph*: calls 1 internal fn (encode_rgba); 3 external calls (from_utf8, new, assert!).


##### `tests::rejects_mismatched_rgba_buffer_length`  (lines 310–314)

```
fn rejects_mismatched_rgba_buffer_length()
```

**Purpose**: This test checks that the encoder refuses an RGBA buffer whose length does not match the declared image size. It prevents accidental reads of incomplete or malformed image data.

**Data flow**: It passes three bytes for a 1-by-1 image, where four bytes are required. It expects encode_rgba to return an error and then compares the error message with the expected explanation.

**Call relations**: The test calls encode_rgba directly. It protects the input validation path that uses pixel_count before any palette or pixel-writing work begins.

*Call graph*: calls 1 internal fn (encode_rgba); 1 external calls (assert_eq!).


### Image ingestion and detail policy
These files define image-processing errors, ingest and normalize prompt images, and apply shared policy helpers for image detail selection and preprocessing.

### `utils/image/src/error.rs`

`data_model` · `cross-cutting during image reading, validation, decoding, and encoding`

Image processing can fail for several different reasons: the file may not be readable, the bytes may not be a real image, the format may not be supported, or the image may be too large. This file collects those cases into one shared error type, `ImageProcessingError`, so callers do not have to guess what happened from a vague failure.

Think of it like a set of labeled warning slips. Instead of just saying “something failed,” the code can attach the right slip: “failed to read this path,” “failed to decode this image,” “unsupported image type,” or “this data URL is invalid.” Each variant keeps the details needed to explain the problem to a human or to let later code make a decision.

The file also adds two small helper methods. One turns a lower-level image decoding failure into either a true “decode failed” error or an “unsupported format” error, based on what the image library reported. The other answers a simple question: “Was this error caused by invalid image contents?” That is useful when higher-level code wants to treat a bad uploaded image differently from, for example, a disk read problem.

#### Function details

##### `ImageProcessingError::decode_error`  (lines 39–52)

```
fn decode_error(path: &std::path::Path, source: image::ImageError) -> Self
```

**Purpose**: This function converts an error from the image library into this project’s clearer image error type. It separates “the image data is broken” from “we do not support or recognize this image format,” which helps later code give a better explanation.

**Data flow**: It receives a file path and an image library error. If the library says the problem was decoding, it copies the path into the error and returns a `Decode` error. Otherwise, it guesses the file’s media type, also called a MIME type, from the path extension; if it cannot guess, it uses `unknown`. It then returns an `UnsupportedImageFormat` error with that MIME string.

**Call relations**: Image loading code calls this when the underlying image library cannot decode a file. This helper turns that low-level failure into a project-specific error that can be shown, logged, or inspected by higher-level image-processing flows.

*Call graph*: 3 external calls (to_path_buf, matches!, from_path).


##### `ImageProcessingError::is_invalid_image`  (lines 54–62)

```
fn is_invalid_image(&self) -> bool
```

**Purpose**: This function answers whether this error means the image contents themselves were invalid. It is a quick check for code that wants to handle bad image data differently from other failures.

**Data flow**: It receives an existing `ImageProcessingError`. It looks at the error’s shape and returns `true` only when it is a decode error caused by the image library’s decoding failure. For every other kind of error, such as read failure, unsupported format, invalid data URL, or size limit, it returns `false`.

**Call relations**: Higher-level code can call this after an image operation fails to decide what kind of response to give. It does not call into other project code; it simply inspects the error value it was given.

*Call graph*: 1 external calls (matches!).


### `utils/image/src/lib.rs`

`domain_logic` · `request handling`

This file is the project’s image preparation station. When a user supplies an image, the rest of the system needs a clean, predictable result: bytes in a supported format, a correct media type, and dimensions that obey prompt limits. Without this file, very large images could waste memory or exceed model limits, unsupported formats might be passed along, and images could lose important display details such as color profile or camera orientation.

The main path starts with either raw bytes from a file or a data URL, which is a string like “data:image/png;base64,...” containing image bytes inside text. The file checks that the input is sane, decodes it, and asks the image library what format it is. If the image is already a safe format, such as PNG, JPEG, or WebP, and it does not need resizing, the original bytes can be reused. That is like leaving a sealed package unopened when the label is already acceptable.

If the image is too large, has a patch budget limit, or uses a format that should not be passed through directly, it is decoded into pixels and re-encoded, usually as PNG unless JPEG or WebP is safe. A small least-recently-used cache keeps recently processed images so repeated use does not redo the expensive work.

#### Function details

##### `EncodedImage::into_data_url`  (lines 47–49)

```
fn into_data_url(self) -> String
```

**Purpose**: Turns an already prepared image into a data URL string. This is useful when another part of the system needs the image embedded directly in text rather than kept as separate bytes.

**Data flow**: It starts with an EncodedImage containing image bytes and a MIME type such as image/png. It passes those two pieces to the shared data URL builder. The result is a single string containing the MIME type and base64-encoded image data.

**Call relations**: This is a convenience method on EncodedImage. When someone has a prepared image and wants a data URL, it delegates the actual string construction to data_url_from_bytes.

*Call graph*: calls 1 internal fn (data_url_from_bytes).


##### `data_url_from_bytes`  (lines 53–56)

```
fn data_url_from_bytes(mime: &str, bytes: &[u8]) -> String
```

**Purpose**: Builds a data URL from a MIME type and raw bytes without checking whether the bytes are really a valid image. It is a simple wrapping step, not an image validator.

**Data flow**: It receives a media type and a byte slice. It base64-encodes the bytes, then formats them as data:<mime>;base64,<encoded text>. It returns that final string and does not change the input bytes.

**Call relations**: EncodedImage::into_data_url calls this when an EncodedImage needs to become text. This function does the small, focused job of creating the standard data URL shape.

*Call graph*: called by 1 (into_data_url); 1 external calls (format!).


##### `load_for_prompt_bytes`  (lines 87–193)

```
fn load_for_prompt_bytes(
    path: &Path,
    file_bytes: Vec<u8>,
    mode: PromptImageMode,
) -> Result<EncodedImage, ImageProcessingError>
```

**Purpose**: Converts raw image file bytes into an EncodedImage that is safe and suitable for prompt use. It detects the format, optionally resizes the image, preserves key metadata when possible, and avoids repeated work through caching.

**Data flow**: It receives a path, the image bytes, and a mode that says whether to keep the original size or resize. It copies the path for error messages, computes a SHA-1 digest of the bytes to make a cache key, and first checks whether the processed result is already cached. If not, it decodes the image, records useful metadata such as color profile and EXIF information, decides whether resizing is needed, and either keeps the original bytes or re-encodes the pixels. It returns an EncodedImage containing bytes, MIME type, width, and height, and it may add that result to the cache.

**Call relations**: load_data_url_for_prompt hands decoded data URL bytes to this function. During its work it uses cache_image to store successful results, and it uses sha1_digest to recognize repeated inputs even if they arrive again later.

*Call graph*: calls 1 internal fn (cache_image); called by 1 (load_data_url_for_prompt); 2 external calls (to_path_buf, sha1_digest).


##### `cache_image`  (lines 195–213)

```
fn cache_image(cache: &ImageCache, key: ImageCacheKey, image: EncodedImage, byte_capacity: usize)
```

**Purpose**: Stores a processed image in the shared image cache while keeping the cache from growing beyond a byte limit. It prevents repeated image decoding and resizing from costing time again and again.

**Data flow**: It receives the cache, a key that identifies the original image and resize mode, an EncodedImage, and a maximum total byte capacity. If the image alone is bigger than the allowed cache size, it is not cached. Otherwise, the function inserts it, totals the bytes currently stored, and removes the least-recently-used entries until the cache is back under the limit.

**Call relations**: load_for_prompt_bytes calls this after it finishes preparing an image. The cache mutation happens inside the cache’s with_mut operation, which is the protected section where entries can be safely changed.

*Call graph*: called by 1 (load_for_prompt_bytes); 1 external calls (with_mut).


##### `load_data_url_for_prompt`  (lines 215–262)

```
fn load_data_url_for_prompt(
    image_url: &str,
    mode: PromptImageMode,
) -> Result<EncodedImage, ImageProcessingError>
```

**Purpose**: Accepts an image written as a data URL and turns it into the same prepared EncodedImage used for file bytes. It checks that the URL is actually base64 data and rejects extremely large inputs before decoding them.

**Data flow**: It receives the data URL text and a resize mode. It verifies the string starts with data:, splits metadata from payload at the comma, checks for the base64 marker, and rejects payloads that exceed the configured size guard. It decodes the base64 text into bytes, checks the decoded size too, then passes those bytes to load_for_prompt_bytes using a placeholder path for error reporting. The output is the processed EncodedImage.

**Call relations**: This is the entry point for image inputs that arrive as text instead of file bytes. After validating and decoding the text form, it hands the real image work to load_for_prompt_bytes.

*Call graph*: calls 1 internal fn (load_for_prompt_bytes); 1 external calls (new).


##### `prompt_image_output_dimensions_for_limits`  (lines 264–299)

```
fn prompt_image_output_dimensions_for_limits(
    width: u32,
    height: u32,
    limits: PromptImageResizeLimits,
) -> (u32, u32)
```

**Purpose**: Calculates the resized width and height needed to obey prompt image limits. The limits include both a maximum side length and a maximum number of image patches, where a patch is a 32-by-32 pixel block used for budgeting image size.

**Data flow**: It receives the current width, height, and resize limits. It first treats zero dimensions as at least one pixel, then checks whether the image already fits. If not, it scales the image down to fit the maximum side length. If that still uses too many patches, it scales by area so the patch grid fits within the patch budget, rounding down carefully so the final integer dimensions stay inside the limit. It returns the chosen width and height.

**Call relations**: This function uses prompt_image_dimensions_fit as its repeated yes-or-no test. It is the calculator that decides what size a limited prompt image should become before the image is actually resized.

*Call graph*: calls 1 internal fn (prompt_image_dimensions_fit); 1 external calls (from).


##### `prompt_image_dimensions_fit`  (lines 301–308)

```
fn prompt_image_dimensions_fit(width: u32, height: u32, limits: PromptImageResizeLimits) -> bool
```

**Purpose**: Answers whether a proposed image size satisfies the prompt limits. It checks both normal pixel dimensions and the patch count used by the prompt system.

**Data flow**: It receives a width, height, and set of limits. It rounds each dimension up into 32-pixel patch counts, multiplies them to get the total number of patches, and compares width, height, and patch total against the limits. It returns true if all checks pass, otherwise false.

**Call relations**: prompt_image_output_dimensions_for_limits calls this while deciding whether the original size, the dimension-limited size, or a further patch-limited size is acceptable.

*Call graph*: called by 1 (prompt_image_output_dimensions_for_limits); 1 external calls (from).


##### `can_preserve_source_bytes`  (lines 310–317)

```
fn can_preserve_source_bytes(format: ImageFormat) -> bool
```

**Purpose**: Decides whether an image format is safe to pass through unchanged. This matters because keeping original bytes is faster and preserves exact data, but only safe for formats the system knows it can send as-is.

**Data flow**: It receives an image format. It compares that format against the safe pass-through set: PNG, JPEG, and WebP. It returns true for those formats and false for others, such as GIF, where byte-for-byte preservation is not treated as generally safe here.

**Call relations**: This is a small decision helper used by the image preparation flow when choosing between keeping original bytes and re-encoding the image into a safer output format.

*Call graph*: 1 external calls (matches!).


##### `encode_image`  (lines 319–380)

```
fn encode_image(
    image: &DynamicImage,
    preferred_format: ImageFormat,
    metadata: ImageMetadata,
) -> Result<(Vec<u8>, ImageFormat), ImageProcessingError>
```

**Purpose**: Turns decoded image pixels back into bytes in a supported output format. It is used when the image has been resized or when the original format should not be passed through directly.

**Data flow**: It receives a decoded DynamicImage, a preferred output format, and metadata to preserve. It chooses JPEG, WebP, or PNG, falling back to PNG for unsupported preferences. It creates an encoder for that format, applies color profile and EXIF metadata when possible, writes the pixel data into a byte buffer, and returns the new bytes together with the actual output format.

**Call relations**: This function calls apply_image_metadata before writing the image data, so the encoded result keeps important display information when the format encoder supports it. It is the re-packaging step in the broader prompt-image preparation flow.

*Call graph*: calls 1 internal fn (apply_image_metadata); 8 external calls (height, to_rgba8, width, new_with_quality, new, new, new_lossless, unreachable!).


##### `apply_image_metadata`  (lines 382–405)

```
fn apply_image_metadata(
    encoder: &mut impl ImageEncoder,
    icc_profile: Option<Vec<u8>>,
    exif: Option<Vec<u8>>,
    format: ImageFormat,
) -> Result<(), ImageProcessingError>
```

**Purpose**: Copies important display metadata into a new encoded image. The metadata includes an ICC color profile, which helps colors appear correctly, and EXIF data, which can include camera orientation.

**Data flow**: It receives an image encoder, optional ICC profile bytes, optional EXIF bytes, and the output format for error reporting. If a color profile is present, it asks the encoder to attach it. If EXIF data is present, it asks the encoder to attach that too. It returns success or an encoding error if the encoder rejects the metadata.

**Call relations**: encode_image calls this just before writing PNG, JPEG, or WebP bytes. This keeps metadata handling in one place instead of repeating it for every encoder.

*Call graph*: called by 1 (encode_image); 2 external calls (set_exif_metadata, set_icc_profile).


##### `format_to_mime`  (lines 407–414)

```
fn format_to_mime(format: ImageFormat) -> String
```

**Purpose**: Converts an internal image format name into the MIME type string used in web-style image data. A MIME type is a label such as image/png that tells readers what kind of bytes they are looking at.

**Data flow**: It receives an ImageFormat value. It maps JPEG, GIF, and WebP to their matching MIME strings, and uses image/png as the default for other cases. It returns the MIME type as a String.

**Call relations**: This helper is used by the image preparation flow whenever prepared image bytes need to be labeled with the correct media type in the resulting EncodedImage.


### `tools/src/image_detail.rs`

`domain_logic` · `request handling`

Some models can inspect images at an “original” detail level, while others cannot. This file is the small gatekeeper for that difference. Without it, a tool could return an image marked as needing original-detail handling, and the next model call might fail or behave unpredictably because that model does not support that option.

The file works in two places. First, when code is deciding what image detail setting to send, `normalize_output_image_detail` checks the chosen setting against the model’s abilities. If the requested setting is safe, it keeps it. If the request is for original detail but the model does not support that, it removes the setting so the system can fall back to normal behavior.

Second, when tool output already contains image items, `sanitize_original_image_detail` walks through those items and rewrites any unsupported “original” detail request to the project’s default image detail. This is like a ticket checker at a venue: if a ticket asks for an access level the venue does not offer, it is changed to a standard valid ticket before entry.

The important behavior is that “original” is treated specially. Other image detail levels, such as automatic, low, or high, are passed through unchanged.

#### Function details

##### `can_request_original_image_detail`  (lines 6–8)

```
fn can_request_original_image_detail(model_info: &ModelInfo) -> bool
```

**Purpose**: This function answers a simple yes-or-no question: does this model support asking for original image detail? Other code uses it before allowing the special original-detail option through.

**Data flow**: It receives `ModelInfo`, which describes what a model can do. It reads the model’s `supports_image_detail_original` flag and returns that same true-or-false answer without changing anything.

**Call relations**: When `normalize_output_image_detail` needs to decide whether an original-detail request is allowed, it calls this function as the central check. This keeps the rule in one obvious place instead of repeating the field lookup.

*Call graph*: called by 1 (normalize_output_image_detail).


##### `normalize_output_image_detail`  (lines 10–21)

```
fn normalize_output_image_detail(
    model_info: &ModelInfo,
    detail: Option<ImageDetail>,
) -> Option<ImageDetail>
```

**Purpose**: This function cleans up a requested image detail setting so it is safe for the chosen model. It keeps supported settings, but removes an unsupported request for original image detail.

**Data flow**: It receives the model’s capability information and an optional requested image detail. If the request is `Original` and the model supports it, the function returns `Some(Original)`. If the request is `Original` but unsupported, or if there was no request, it returns `None`. If the request is `Auto`, `Low`, or `High`, it returns that request unchanged.

**Call relations**: This function calls `can_request_original_image_detail` when it sees the special `Original` setting. It acts as the decision point before image detail information is sent onward, making sure later code does not try to use an unsupported option.

*Call graph*: calls 1 internal fn (can_request_original_image_detail).


##### `sanitize_original_image_detail`  (lines 23–38)

```
fn sanitize_original_image_detail(
    can_request_original_image_detail: bool,
    items: &mut [FunctionCallOutputContentItem],
)
```

**Purpose**: This function edits a batch of tool output items so unsupported original-detail image requests are replaced with the default image detail. It is used when image content has already been built and needs to be made safe before being passed along.

**Data flow**: It receives a true-or-false value saying whether original detail is allowed, plus a mutable list of output content items. If original detail is allowed, it leaves the list untouched. If not, it scans each item; for every input-image item whose detail is `Original`, it changes that detail to `DEFAULT_IMAGE_DETAIL`. It does not create a new list; it updates the existing one in place.

**Call relations**: This function is used as a final cleanup step for tool output content. Internally it uses a pattern check to find only image items with `Original` detail, then rewrites just those unsafe values while leaving all other content alone.

*Call graph*: 1 external calls (matches!).


### `core/src/original_image_detail.rs`

`util` · `cross-cutting`

Some parts of the system may need to deal with requests for “original image detail,” meaning a higher-detail look at an image rather than a reduced or simplified version. The actual rules for this live in another module or crate called `codex_tools`. This file does not add new behavior of its own. Instead, it re-exports two existing helpers: one that checks whether original image detail can be requested, and one that sanitizes such a request so it is safe and acceptable.

Think of this file like a signpost or front desk. Other code in `core` can come here for these image-detail tools, without needing to know the deeper location where they are implemented. That keeps imports cleaner and gives the project one stable place to expose this small piece of functionality.

If this file were removed, any core code that imports these helpers through `original_image_detail` would break. The underlying logic might still exist elsewhere, but callers would lose this convenient, crate-local path to it.


### `core/src/image_preparation.rs`

`domain_logic` · `conversation preparation`

This file is a cleanup station for images before conversation history or reconstructed rollout data is used elsewhere. Some messages and tool outputs can contain images as data URLs, which means the image bytes are embedded directly in the text string. Those images may be too large, in an unsupported detail mode, or otherwise impossible to process. Without this file, an oversized or bad image could break later processing or be sent in a form the model cannot accept.

The main flow starts with response items, which are the mixed pieces of a conversation: normal messages, tool outputs, reasoning items, and other event types. This file only touches places where user-visible image content can appear: message content and function/custom tool output content. For each embedded image, it checks whether the URL starts with `data:`. Non-data URLs are left alone, like a package already stored elsewhere.

For data URLs, it chooses resize limits based on the requested image detail. `high` and `auto` use stricter limits, while `original` allows larger images. `low` is not supported here. If image processing succeeds, the original data URL is replaced with a processed one. If it fails, the image item is replaced with a plain text explanation, and a warning is logged. This keeps the conversation usable while making the missing image visible to the model and to users.

#### Function details

##### `ImagePreparationError::placeholder`  (lines 34–42)

```
fn placeholder(&self) -> &'static str
```

**Purpose**: This turns an image preparation failure into a short message that can be placed into the conversation instead of the image. It gives different explanations for an unsupported low-detail request, an image that is too large, and other processing failures.

**Data flow**: It starts with a specific image preparation error. It checks what kind of error it is, then returns a fixed human-readable text message. It does not change the error or any outside data; it only supplies the replacement wording.

**Call relations**: When image preparation fails inside message or tool-output preparation, those functions use this method to decide what text should replace the unusable image. It is the bridge between a technical failure and a readable placeholder in the conversation.


##### `prepare_response_items`  (lines 45–70)

```
fn prepare_response_items(items: &mut [ResponseItem])
```

**Purpose**: This walks through a batch of conversation response items and prepares any image content found in messages or tool outputs. Someone would use it before saving, replaying, or sending conversation items so embedded images are resized or safely replaced.

**Data flow**: It receives a mutable list of response items. For each item, it looks at its kind: message items have their message content prepared, and function or custom tool output items have their output content prepared if that output exposes content items. Other response item kinds are left unchanged. The same list comes out modified in place where images needed resizing or replacement.

**Call relations**: This is the public entry point of the file. It is called when rollout reconstruction and conversation-history preparation need to sanitize images. It then hands message content to prepare_message_content and tool output content to prepare_tool_output_content, depending on where the images may be hiding.

*Call graph*: calls 2 internal fn (prepare_message_content, prepare_tool_output_content); called by 2 (apply_rollout_reconstruction, prepare_conversation_items_for_history).


##### `prepare_message_content`  (lines 72–84)

```
fn prepare_message_content(items: &mut [ContentItem])
```

**Purpose**: This prepares images that appear inside normal message content. It focuses only on embedded data-URL images, resizing them when possible and replacing them with text when not.

**Data flow**: It receives a mutable list of message content items. For each item, it checks whether it is an input image, whether the image URL is a data URL, and whether prepare_image can process it. If processing succeeds, the image URL inside the item is updated. If processing fails, it logs a warning and replaces that image item with an input text item containing the matching placeholder message.

**Call relations**: prepare_response_items calls this whenever it sees a normal message. This function uses is_data_url as a quick filter, then delegates the actual image loading and resizing to prepare_image. If prepare_image reports a problem, this function turns that problem into a safe text replacement.

*Call graph*: calls 2 internal fn (is_data_url, prepare_image); called by 1 (prepare_response_items); 1 external calls (warn!).


##### `prepare_tool_output_content`  (lines 86–98)

```
fn prepare_tool_output_content(items: &mut [FunctionCallOutputContentItem])
```

**Purpose**: This prepares images that appear inside function-call or custom-tool output content. It gives tool-produced embedded images the same safety treatment as images in regular messages.

**Data flow**: It receives a mutable list of tool output content items. For each image item whose URL is embedded as a data URL, it asks prepare_image to process the image according to its requested detail. A successful result updates the image URL in place. A failure logs a warning and changes the item into a text item explaining why the image was omitted.

**Call relations**: prepare_response_items calls this when a response item contains tool output content. Like prepare_message_content, it first uses is_data_url to avoid touching non-embedded image references, then relies on prepare_image for the real image conversion work.

*Call graph*: calls 2 internal fn (is_data_url, prepare_image); called by 1 (prepare_response_items); 1 external calls (warn!).


##### `is_data_url`  (lines 100–104)

```
fn is_data_url(image_url: &str) -> bool
```

**Purpose**: This checks whether an image URL is an embedded data URL. It is used to decide whether this file should try to load and resize the image directly.

**Data flow**: It receives an image URL string. It looks only at the beginning of the string and compares it to `data:` without caring about letter case. It returns true if the URL begins that way and false otherwise, without changing anything.

**Call relations**: Both message-content and tool-output preparation call this before doing heavier image work. It acts like a quick label check: only images packed directly into the URL are passed on to prepare_image.

*Call graph*: called by 2 (prepare_message_content, prepare_tool_output_content).


##### `prepare_image`  (lines 106–118)

```
fn prepare_image(
    image_url: &mut String,
    detail: Option<ImageDetail>,
) -> Result<(), ImagePreparationError>
```

**Purpose**: This does the actual image preparation for one embedded image. It chooses the right size limits from the requested detail setting, rejects unsupported low-detail images, and rewrites the data URL with the processed image.

**Data flow**: It receives a mutable image URL string and an optional image detail setting. It turns the detail into resize limits: auto, high, and missing detail use the high-detail limits; original uses larger limits; low becomes an error. It then loads the image from the data URL using the image utility library in resize-with-limits mode. On success, it replaces the original URL string with the processed image's new data URL and returns success. On failure, it returns an image preparation error and leaves replacement decisions to its caller.

**Call relations**: prepare_message_content and prepare_tool_output_content call this after confirming an item contains a data URL image. This function hands off low-level decoding and resizing to load_data_url_for_prompt from the image utility code, then reports either a cleaned-up image URL or a reason the caller should replace the image with text.

*Call graph*: called by 2 (prepare_message_content, prepare_tool_output_content); 2 external calls (load_data_url_for_prompt, ResizeWithLimits).


### Async control primitives
These files provide small reusable primitives for cancellation, readiness signaling, and pause-aware timeout budgeting.

### `async-utils/src/lib.rs`

`util` · `cross-cutting async waiting and shutdown`

Async programs often start work that may no longer be needed: a request may close, a service may shut down, or a parent task may decide to stop its children. This file solves that problem by adding a small helper, `or_cancel`, to futures. A future is Rust’s value for work that will finish later, and a `CancellationToken` is a shared signal that can be flipped to say “please stop.”

The main idea is like waiting for either the kettle to boil or the fire alarm to ring. If the future finishes first, the caller gets its normal result. If the cancellation token fires first, the caller gets `CancelErr::Cancelled` instead. The code uses Tokio’s `select!` macro, which waits on two async events at the same time and continues with whichever one completes first.

The `CancelErr` enum is intentionally tiny: it has only one reason, `Cancelled`, because this helper is only about cancellation, not about the underlying work’s own errors. The tests check the three important cases: the work wins the race, cancellation wins the race, and the token was already cancelled before waiting began.

#### Function details

##### `F::or_cancel`  (lines 25–30)

```
async fn or_cancel(self, token: &CancellationToken) -> Result<Self::Output, CancelErr>
```

**Purpose**: This adds a cancellation-aware wrapper around any sendable future. Someone uses it when they want to wait for async work, but also want to stop waiting promptly if a shared cancellation token is triggered.

**Data flow**: It takes an unfinished future and a reference to a cancellation token. It waits for two things at once: the token’s cancelled signal and the future’s normal result. If the token finishes first, it returns `Err(CancelErr::Cancelled)`; if the future finishes first, it returns `Ok(result)` with the future’s output.

**Call relations**: This is the core helper the rest of the file is built around. Internally it hands the race between “cancelled” and “completed” to Tokio’s `select!` macro, which chooses whichever async event happens first. The tests call this method in different timing situations to prove both branches behave as intended.

*Call graph*: 1 external calls (select!).


##### `tests::returns_ok_when_future_completes_first`  (lines 42–49)

```
async fn returns_ok_when_future_completes_first()
```

**Purpose**: This test proves that `or_cancel` does not interfere with normal work. If the future finishes before any cancellation happens, the original value should come back wrapped in `Ok`.

**Data flow**: It creates a fresh cancellation token that is never cancelled, then creates a tiny async value that immediately produces `42`. It waits on that value through `or_cancel`, then checks that the result is `Ok(42)`.

**Call relations**: This test exercises the successful path of `F::or_cancel`. It uses a new token and an assertion to show that, when cancellation is absent, the helper behaves like a normal await with a small `Result` wrapper around the answer.

*Call graph*: 2 external calls (new, assert_eq!).


##### `tests::returns_err_when_token_cancelled_first`  (lines 52–70)

```
async fn returns_err_when_token_cancelled_first()
```

**Purpose**: This test proves that `or_cancel` stops waiting when cancellation arrives before the future finishes. It checks the most important shutdown-style behavior.

**Data flow**: It creates a cancellation token and a clone of it, then starts a separate async task that waits briefly and cancels the clone. Meanwhile, the main future sleeps longer before returning `7`. Because cancellation happens first, `or_cancel` returns `Err(CancelErr::Cancelled)`, and the test confirms that result.

**Call relations**: This test drives the cancellation branch of `F::or_cancel`. It uses Tokio’s task spawning and sleeping tools to create a controlled race: the cancel task fires after a short delay, while the wrapped future is deliberately slower.

*Call graph*: 5 external calls (new, from_millis, assert_eq!, spawn, sleep).


##### `tests::returns_err_when_token_already_cancelled`  (lines 73–85)

```
async fn returns_err_when_token_already_cancelled()
```

**Purpose**: This test proves that `or_cancel` notices a token that was cancelled before waiting even starts. That matters because callers should not have to check cancellation separately before using the helper.

**Data flow**: It creates a token, cancels it immediately, then wraps a future that would otherwise sleep and return `5`. Since the token is already in the cancelled state, `or_cancel` returns `Err(CancelErr::Cancelled)` instead of waiting for the future’s value.

**Call relations**: This test covers an edge case for `F::or_cancel`: cancellation does not need to happen during the wait. The helper relies on the token’s cancelled signal, which is already ready when the token has previously been cancelled.

*Call graph*: 4 external calls (new, from_millis, assert_eq!, sleep).


### `utils/readiness/src/lib.rs`

`util` · `cross-cutting startup and async coordination`

This file is like a controlled green light. Other parts of the program can ask, “Are we ready yet?”, wait until the answer becomes yes, or subscribe for a token that gives them permission to turn the light green. The token matters because it prevents random code from declaring the system ready by mistake.

The main type is `ReadinessFlag`. It keeps a fast yes/no value for readiness, a counter for making unique tokens, a locked set of currently valid tokens, and a Tokio `watch` channel, which is an async notification line that wakes waiters when the value changes.

The flag starts as not ready. A caller can subscribe and receive a `Token`. Later, only that token can successfully call `mark_ready`. Once ready, the flag stays ready forever; it cannot be reset. Waiting tasks use `wait_ready`, which returns immediately if readiness is already true, or listens for the notification.

One important behavior is that if nobody has subscribed, asking `is_ready` can mark the flag ready automatically. In plain terms: if there are no outstanding “I will decide readiness” claims, the flag treats itself as ready. The file also protects against getting stuck on the token lock by timing out after one second and returning a clear error.

#### Function details

##### `ReadinessFlag::new`  (lines 60–68)

```
fn new() -> Self
```

**Purpose**: Creates a fresh readiness flag in the not-ready state. Use this when a component needs a new shared signal that other async tasks can wait on or complete.

**Data flow**: It starts with no input except the request to create the flag. It builds an internal notification channel set to `false`, creates an empty token set, sets the next token number to 1, and stores `ready` as false. The result is a usable `ReadinessFlag` waiting for subscribers or readiness checks.

**Call relations**: This is the starting point for almost every flow in this file. The tests call it to create isolated flags, and `ReadinessFlag::default` delegates to it so default construction behaves exactly like explicit construction.

*Call graph*: called by 9 (is_ready_without_subscribers_marks_flag_ready, mark_ready_rejects_unknown_token, mark_ready_twice_uses_single_token, subscribe_after_ready_returns_none, subscribe_and_mark_ready_roundtrip, subscribe_avoids_duplicate_tokens, subscribe_returns_error_when_lock_is_held, subscribe_skips_zero_token, wait_ready_unblocks_after_mark_ready); 5 external calls (new, new, new, new, channel).


##### `ReadinessFlag::with_tokens`  (lines 70–78)

```
async fn with_tokens(
        &self,
        f: impl FnOnce(&mut HashSet<Token>) -> R,
    ) -> Result<R, errors::ReadinessError>
```

**Purpose**: Safely opens the internal token set for a short operation. It exists so subscribing and marking ready can change the token list without two tasks editing it at the same time.

**Data flow**: It receives a small piece of work to run against the token set. It tries to acquire the mutex, which is a lock that lets only one task touch the set at once, but gives up after a fixed timeout. If the lock is acquired, it runs the provided work and returns that result; if not, it returns a token-lock error.

**Call relations**: `subscribe` uses this to add a new valid token, and `mark_ready` uses it to remove and verify a token. It is the shared doorway that keeps token changes orderly and prevents indefinite waiting on a stuck lock.

*Call graph*: called by 2 (mark_ready, subscribe); 1 external calls (timeout).


##### `ReadinessFlag::load_ready`  (lines 80–82)

```
fn load_ready(&self) -> bool
```

**Purpose**: Reads the current ready/not-ready value quickly. It is a small helper so the rest of the file checks readiness in one consistent way.

**Data flow**: It reads the atomic boolean, meaning a yes/no value that can be safely checked from multiple threads without taking a lock. It returns `true` if the flag has been marked ready and `false` otherwise.

**Call relations**: This helper is used by formatting, readiness checks, subscribing, and marking ready. It provides the fast first answer before those functions decide whether they need slower token or notification work.

*Call graph*: called by 4 (fmt, is_ready, mark_ready, subscribe); 1 external calls (load).


##### `ReadinessFlag::default`  (lines 86–88)

```
fn default() -> Self
```

**Purpose**: Lets callers create a `ReadinessFlag` using Rust’s standard default-construction pattern. It produces the same kind of not-ready flag as `new`.

**Data flow**: It takes no special input. It calls `ReadinessFlag::new` and returns the newly created flag.

**Call relations**: This function is a convenience wrapper around `new`. Any caller using `Default` gets the same setup path as callers who explicitly call `new`.

*Call graph*: 1 external calls (new).


##### `ReadinessFlag::fmt`  (lines 92–96)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Provides a simple debug view of the flag. It shows whether the flag is ready without exposing internal token details.

**Data flow**: It receives a formatter from Rust’s debug-printing system. It reads the readiness value and writes a debug structure containing that value. The visible output is a compact representation of the flag’s public state.

**Call relations**: When code prints a `ReadinessFlag` for debugging, this function is invoked. It relies on `load_ready` so debug output reflects the same readiness value used elsewhere.

*Call graph*: calls 1 internal fn (load_ready); 1 external calls (debug_struct).


##### `ReadinessFlag::is_ready`  (lines 100–117)

```
fn is_ready(&self) -> bool
```

**Purpose**: Answers whether the flag is ready right now. It also has the special rule that if nobody has subscribed to claim responsibility for readiness, the flag becomes ready automatically.

**Data flow**: It first reads the fast readiness value. If already ready, it returns `true`. If not, it tries to look at the token set without waiting; when the set is empty, it flips readiness to true and notifies waiters. If it cannot prove the set is empty, it returns the latest readiness value.

**Call relations**: `wait_ready` calls this before waiting so it can return immediately when possible. It also sends the readiness notification itself when the no-subscriber rule causes the flag to become ready.

*Call graph*: calls 1 internal fn (load_ready); called by 1 (wait_ready); 2 external calls (swap, send).


##### `ReadinessFlag::subscribe`  (lines 119–143)

```
async fn subscribe(&self) -> Result<Token, errors::ReadinessError>
```

**Purpose**: Gives a caller a token that authorizes it to mark the flag ready later. It refuses new subscriptions once readiness has already happened.

**Data flow**: It first checks whether the flag is already ready. If so, it returns an error. Otherwise it locks the token set, checks readiness again while protected by the lock, generates a non-zero token number, avoids duplicates even if the counter wraps around, stores the token, and returns it. If readiness happened during the process, it returns the already-ready error instead.

**Call relations**: This is the first half of the token-based readiness flow. It uses `load_ready` for quick checks and `with_tokens` to safely insert the token. Later, the caller is expected to pass the returned token to `mark_ready`.

*Call graph*: calls 2 internal fn (load_ready, with_tokens).


##### `ReadinessFlag::mark_ready`  (lines 145–169)

```
async fn mark_ready(&self, token: Token) -> Result<bool, errors::ReadinessError>
```

**Purpose**: Attempts to turn the flag ready using a previously issued token. It succeeds only once and only for a token that is still valid.

**Data flow**: It receives a token. If the flag is already ready or the token is zero, it returns `false`. Otherwise it locks the token set, removes the matching token if present, stores readiness as true, clears all remaining tokens because they are no longer needed, and returns `true`. After a successful mark, it notifies waiting tasks.

**Call relations**: This is the second half of the subscribe-and-complete flow. It uses `load_ready` for the quick already-ready case, `with_tokens` for safe token validation, and the notification channel to wake `wait_ready` callers.

*Call graph*: calls 2 internal fn (load_ready, with_tokens); 1 external calls (send).


##### `ReadinessFlag::wait_ready`  (lines 171–186)

```
async fn wait_ready(&self)
```

**Purpose**: Pauses an async task until the flag becomes ready. Callers use it when they cannot continue safely until another part of the program has finished its readiness step.

**Data flow**: It first asks `is_ready`; if readiness is already true, it returns immediately. If not, it subscribes to the internal notification channel, checks the current channel value once more to avoid missing a fast update, then waits for changes until it sees `true`. It returns no value; its completion is the signal that readiness has arrived.

**Call relations**: This function is used by tasks that need to wait instead of poll repeatedly. It depends on `is_ready` for the fast path and then listens for notifications sent by `mark_ready` or by `is_ready` when the no-subscriber rule marks readiness.

*Call graph*: calls 1 internal fn (is_ready); 1 external calls (subscribe).


##### `tests::subscribe_and_mark_ready_roundtrip`  (lines 213–220)

```
async fn subscribe_and_mark_ready_roundtrip() -> Result<(), ReadinessError>
```

**Purpose**: Checks the normal successful path: subscribe, receive a token, use that token to mark ready, and then observe readiness.

**Data flow**: It creates a new flag, subscribes to get a token, passes that token into `mark_ready`, and checks that the operation succeeds. It then checks that `is_ready` reports true.

**Call relations**: The test runner calls this as an async Tokio test. It exercises the intended relationship between `ReadinessFlag::new`, `subscribe`, `mark_ready`, and `is_ready`.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert!).


##### `tests::subscribe_after_ready_returns_none`  (lines 223–230)

```
async fn subscribe_after_ready_returns_none() -> Result<(), ReadinessError>
```

**Purpose**: Verifies that nobody can subscribe after the flag is already ready. This protects the one-way nature of readiness.

**Data flow**: It creates a flag, subscribes once, marks the flag ready with the token, and then tries to subscribe again. The expected result is an error from the second subscription.

**Call relations**: The test runner invokes it to confirm `subscribe` respects the state set by `mark_ready`. It demonstrates that readiness closes the door to future token claims.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert!).


##### `tests::mark_ready_rejects_unknown_token`  (lines 233–239)

```
async fn mark_ready_rejects_unknown_token() -> Result<(), ReadinessError>
```

**Purpose**: Checks that a made-up token cannot mark the flag ready. This proves the token authorization is not just decorative.

**Data flow**: It creates a new flag and calls `mark_ready` with `Token(42)`, which was never issued. The call should return `false` and not set the internal ready value directly. The later `is_ready` call can still return true because there are no subscribers, triggering the file’s no-subscriber readiness rule.

**Call relations**: The test runner uses this to exercise the rejection path in `mark_ready`. It also shows how `is_ready` can independently mark readiness when no valid subscribers exist.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert!).


##### `tests::wait_ready_unblocks_after_mark_ready`  (lines 242–256)

```
async fn wait_ready_unblocks_after_mark_ready() -> Result<(), ReadinessError>
```

**Purpose**: Confirms that a task waiting for readiness wakes up when another task marks the flag ready. This protects the async notification behavior.

**Data flow**: It creates a shared flag, subscribes to get a token, and starts a separate async task that calls `wait_ready`. The test then marks the flag ready with the token and waits for the spawned task to finish. Successful completion means the waiting task was notified.

**Call relations**: The test runner calls it under Tokio. It ties together `new`, shared ownership through `Arc`, task spawning, `wait_ready`, and `mark_ready` to prove the notification channel works across tasks.

*Call graph*: calls 1 internal fn (new); 4 external calls (clone, new, assert!, spawn).


##### `tests::mark_ready_twice_uses_single_token`  (lines 259–266)

```
async fn mark_ready_twice_uses_single_token() -> Result<(), ReadinessError>
```

**Purpose**: Checks that the same token cannot be used to mark readiness twice. This matters because tokens are meant to be single-use authorization.

**Data flow**: It creates a flag, subscribes to get one token, and calls `mark_ready` with that token twice. The first call should return `true`; the second should return `false` because the flag is already ready and the token has already been consumed.

**Call relations**: The test runner uses this to confirm the one-way, one-success behavior of `mark_ready`. It focuses on the state transition after the first successful token use.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert!).


##### `tests::is_ready_without_subscribers_marks_flag_ready`  (lines 269–279)

```
async fn is_ready_without_subscribers_marks_flag_ready() -> Result<(), ReadinessError>
```

**Purpose**: Verifies the special rule that a flag with no subscribers becomes ready when checked. This captures an important behavior that may surprise new readers.

**Data flow**: It creates a new flag with no tokens. The first `is_ready` call should return true and make the flag ready. A second `is_ready` call should also return true, and a later subscription attempt should fail because the flag is now already ready.

**Call relations**: The test runner calls this to document and protect the behavior inside `is_ready`. It also confirms that this automatic readiness affects `subscribe` afterward.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert!, assert_matches!).


##### `tests::subscribe_returns_error_when_lock_is_held`  (lines 282–313)

```
async fn subscribe_returns_error_when_lock_is_held()
```

**Purpose**: Checks that subscription fails clearly if the token lock cannot be acquired in time. This prevents a caller from waiting forever on a stuck lock.

**Data flow**: It creates a shared flag and starts a separate operating-system thread that grabs the token lock and holds it. Once the test knows the lock is held, it calls `subscribe`. Because `with_tokens` times out, the result should be a `TokenLockFailed` error. The test then releases the lock and joins the thread.

**Call relations**: The test runner invokes this to exercise the timeout path in `with_tokens` through `subscribe`. It uses channels and a spawned thread to deliberately create lock contention.

*Call graph*: calls 1 internal fn (new); 5 external calls (clone, new, assert_matches!, channel, spawn).


##### `tests::subscribe_skips_zero_token`  (lines 316–324)

```
async fn subscribe_skips_zero_token() -> Result<(), ReadinessError>
```

**Purpose**: Verifies that token zero is never handed out. Zero is reserved as an invalid token, so giving it to a caller would break the authorization rule.

**Data flow**: It creates a flag and manually sets the next token number to zero. When it subscribes, the subscription loop skips zero and returns a different token. The test then confirms that the returned token can successfully mark the flag ready.

**Call relations**: The test runner uses this to check the token-generation loop inside `subscribe`. It supports the matching rule in `mark_ready`, where token zero is always rejected.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert!, assert_ne!).


##### `tests::subscribe_avoids_duplicate_tokens`  (lines 327–335)

```
async fn subscribe_avoids_duplicate_tokens() -> Result<(), ReadinessError>
```

**Purpose**: Checks that subscription does not issue the same token twice, even if the internal counter points back to an existing token. This matters because each subscriber must have a distinct authorization token.

**Data flow**: It creates a flag, subscribes once, then manually resets the next token counter to the first token’s number. A second subscription should notice the duplicate and keep trying until it finds a different token. The test confirms the two tokens are not equal.

**Call relations**: The test runner calls this to protect the duplicate-avoidance behavior in `subscribe`. It specifically exercises the logic that checks the token set before accepting a generated token.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_ne!).


### `shell-escalation/src/unix/stopwatch.rs`

`util` · `cross-cutting during async operations with deadlines`

This file solves a subtle timing problem: sometimes the program needs a deadline, but some waiting periods should not count against that deadline. For example, if the system is waiting for a user to answer a permission prompt, it may want to pause the clock so the operation is not cancelled just because the user took time to respond.

The main type, `Stopwatch`, is like a kitchen timer with a pause button. It records how much time has already counted, whether it is currently running, and how many active pauses exist. The “how many pauses” part matters because two pieces of code may pause it at the same time; the stopwatch should only restart after both have finished.

A stopwatch can have a fixed limit, or it can be unlimited. When code asks for a cancellation token, the stopwatch starts a background async task. A cancellation token is a shared signal that other tasks can wait on; when it is cancelled, they know the time limit has expired. The background task sleeps only for the remaining running time. If the stopwatch is paused or resumed, it is notified and recalculates the remaining time.

The file also includes tests that check the timer fires, pauses really stop the deadline, overlapping pauses are counted correctly, and unlimited timers never cancel.

#### Function details

##### `Stopwatch::new`  (lines 25–35)

```
fn new(limit: Duration) -> Self
```

**Purpose**: Creates a stopwatch with a fixed time limit and starts it immediately. Code uses this when an operation should be cancelled after a certain amount of counted running time.

**Data flow**: It receives a duration, which is the maximum allowed running time. It builds a shared internal state with zero elapsed time, records the current moment as the start time, sets the pause count to zero, and stores the limit. The result is a `Stopwatch` that can be cloned and shared safely between async tasks.

**Call relations**: Higher-level escalation and sandbox-related flows create this stopwatch when they need a bounded wait or operation. The tests also create it to prove that its cancellation behavior and pause behavior match the intended deadline rules.

*Call graph*: called by 8 (try_run_zsh_fork, denied_reads_keep_granular_sandbox_rejection_for_escalation, denied_reads_keep_prefix_rule_allow_inside_sandbox, execve_permission_request_hook_short_circuits_prompt, preapproved_additional_permissions_escalate_intercepted_exec, cancellation_receiver_fires_after_limit, overlapping_pauses_only_resume_once, pause_prevents_timeout_until_resumed); 4 external calls (new, now, new, new).


##### `Stopwatch::unlimited`  (lines 37–47)

```
fn unlimited() -> Self
```

**Purpose**: Creates a stopwatch that never expires. This is useful when the same code path expects a stopwatch, but a particular run should have no deadline.

**Data flow**: It takes no input. It creates the same shared running state as a limited stopwatch, but stores no time limit. The result is a `Stopwatch` whose cancellation token will not cancel by itself.

**Call relations**: Some execution setup paths use this when they want the stopwatch interface without an actual timeout. The matching test confirms that waiting on its cancellation signal does not complete within a short period.

*Call graph*: called by 2 (prepare_unified_exec_zsh_fork, unlimited_stopwatch_never_cancels); 4 external calls (new, now, new, new).


##### `Stopwatch::cancellation_token`  (lines 49–91)

```
fn cancellation_token(&self) -> CancellationToken
```

**Purpose**: Creates a cancellation signal tied to the stopwatch’s time limit. Other async code can wait on this signal to stop work once the counted time has run out.

**Data flow**: It starts by creating a fresh cancellation token. If the stopwatch has no limit, it simply returns that token and does not start a timer. If there is a limit, it starts a background task that repeatedly checks the stored elapsed time, accounts for the current running stretch, waits for the remaining time, and cancels the token when the limit is reached. If the stopwatch is paused or resumed, the background task wakes up and recalculates.

**Call relations**: After callers create a stopwatch, they ask this function for the signal they can wait on. Internally, it uses the stopwatch state and notification channel so `pause` and `resume` can interrupt the waiting task whenever the clock changes.

*Call graph*: 6 external calls (clone, new, pin!, select!, spawn, sleep).


##### `Stopwatch::pause_for`  (lines 97–105)

```
async fn pause_for(&self, fut: F) -> T
```

**Purpose**: Runs an async operation while the stopwatch is paused, then resumes the stopwatch afterward. It is meant for waits that should not count against the deadline.

**Data flow**: It receives a future, which is an async piece of work that will finish later. Before awaiting that work, it pauses the stopwatch. Once the future finishes, it resumes the stopwatch and returns the future’s result unchanged.

**Call relations**: The prompt flow calls this when waiting for something that should not consume the stopwatch’s allowed time. It delegates the actual state changes to `Stopwatch::pause` before the wait and `Stopwatch::resume` after the wait.

*Call graph*: calls 2 internal fn (pause, resume); called by 1 (prompt).


##### `Stopwatch::pause`  (lines 107–116)

```
async fn pause(&self)
```

**Purpose**: Stops counted time from advancing. It also supports nested or overlapping pauses, so one pause ending does not restart the clock while another pause is still active.

**Data flow**: It locks the shared stopwatch state so only one task changes it at a time. It increases the active pause count. If this is the first active pause, it records how much time has passed since the stopwatch last started running, adds that to total elapsed time, marks the stopwatch as not currently running, and wakes any timer task so it can stop sleeping toward the deadline.

**Call relations**: `Stopwatch::pause_for` calls this before awaiting the protected async work. The cancellation-token background task reacts to the notification sent here and changes from countdown mode into paused waiting mode.

*Call graph*: called by 1 (pause_for).


##### `Stopwatch::resume`  (lines 118–128)

```
async fn resume(&self)
```

**Purpose**: Restarts counted time after a pause, but only when all overlapping pauses have ended. This prevents the clock from restarting too early.

**Data flow**: It locks the shared state, checks whether there is actually an active pause, and returns if there is not. Otherwise it lowers the pause count by one. If that was the last active pause, it records the current moment as the new running start time and wakes the background timer task so it can resume counting down.

**Call relations**: `Stopwatch::pause_for` calls this after the awaited work finishes. Its notification tells the cancellation-token background task to recalculate how much counted time remains.

*Call graph*: called by 1 (pause_for); 1 external calls (now).


##### `tests::cancellation_receiver_fires_after_limit`  (lines 140–146)

```
async fn cancellation_receiver_fires_after_limit()
```

**Purpose**: Checks that a limited stopwatch really cancels after its time limit has passed. This protects the basic deadline behavior from regressions.

**Data flow**: It creates a stopwatch with a short limit, asks for its cancellation token, records the current time, and waits until the token is cancelled. After cancellation, it verifies that at least the configured amount of time elapsed.

**Call relations**: This test exercises `Stopwatch::new` and `Stopwatch::cancellation_token` together, matching the normal use case where callers create a timer and wait for its cancellation signal.

*Call graph*: calls 1 internal fn (new); 3 external calls (from_millis, now, assert!).


##### `tests::pause_prevents_timeout_until_resumed`  (lines 149–173)

```
async fn pause_prevents_timeout_until_resumed()
```

**Purpose**: Checks that pausing the stopwatch prevents the deadline from firing while the pause is active. This proves that waiting time inside `pause_for` is not counted.

**Data flow**: It creates a limited stopwatch and cancellation token, then starts another async task that pauses the stopwatch while sleeping for longer than the limit. The test first confirms the token does not cancel during the pause. After the pause task finishes, it waits again and expects the token to cancel.

**Call relations**: This test uses `Stopwatch::new`, `Stopwatch::cancellation_token`, and `Stopwatch::pause_for` in the same pattern as real prompt-like code: pause during a wait, then resume normal deadline counting afterward.

*Call graph*: calls 1 internal fn (new); 4 external calls (from_millis, assert!, spawn, sleep).


##### `tests::overlapping_pauses_only_resume_once`  (lines 176–224)

```
async fn overlapping_pauses_only_resume_once()
```

**Purpose**: Checks that two pauses at the same time are counted correctly. The stopwatch must stay paused until the longer pause ends, even if the shorter one finishes first.

**Data flow**: It creates a limited stopwatch and starts two async pause blocks, one longer and one shorter. It verifies the cancellation token does not fire while both are active, then verifies it still does not fire after only the short pause finishes. Once the long pause ends, the test waits for cancellation and expects it to happen.

**Call relations**: This test focuses on the pause-counting behavior inside `Stopwatch::pause` and `Stopwatch::resume`. It proves the background cancellation task is not allowed to resume its countdown until all pause users have released their pause.

*Call graph*: calls 1 internal fn (new); 4 external calls (from_millis, assert!, spawn, sleep).


##### `tests::unlimited_stopwatch_never_cancels`  (lines 227–236)

```
async fn unlimited_stopwatch_never_cancels()
```

**Purpose**: Checks that an unlimited stopwatch does not produce an automatic cancellation. This protects callers that deliberately choose to run without a timeout.

**Data flow**: It creates an unlimited stopwatch, asks for a cancellation token, and waits briefly for cancellation. The wait times out, which is the expected result because there is no limit.

**Call relations**: This test exercises `Stopwatch::unlimited` and `Stopwatch::cancellation_token` together. It confirms that the no-limit path returns a usable token without starting a deadline that might unexpectedly stop work.

*Call graph*: calls 1 internal fn (unlimited); 1 external calls (assert!).


### Sleep inhibition backends
These files expose the cross-platform sleep-inhibition API and its platform-specific or no-op implementations.

### `utils/sleep-inhibitor/src/lib.rs`

`orchestration` · `active during turn execution`

This file is the front door for the sleep-prevention feature. The problem it solves is simple: if the program is doing a long-running turn and the computer goes to sleep, the work may pause or fail. Different operating systems prevent sleep in different ways, so this file chooses the right platform-specific helper at compile time and gives the rest of the program a single object to use: `SleepInhibitor`.

Think of it like a universal light switch wired to different electrical systems in different countries. The caller only flips “turn is running” on or off. This file decides whether to ask the operating system to stay awake.

`SleepInhibitor` keeps three pieces of state: whether the feature is enabled, whether the caller currently says a turn is running, and the platform-specific backend that actually talks to the operating system. If the feature is disabled, it still remembers the requested turn state, but it always releases any sleep block. If enabled, setting the turn state to true acquires sleep prevention; setting it to false releases it.

The tests check that toggling works without crashing, that the disabled mode is safe, and that repeated “true” calls do not cause trouble.

#### Function details

##### `SleepInhibitor::new`  (lines 37–43)

```
fn new(enabled: bool) -> Self
```

**Purpose**: Creates a new sleep inhibitor object. A caller uses this when it wants a reusable switch for keeping the machine awake during turns.

**Data flow**: It receives one input: whether sleep prevention should be enabled. It stores that choice, starts with no turn running, creates the platform-specific helper for the current operating system, and returns the completed `SleepInhibitor`.

**Call relations**: This is the setup step. Tests call it to build an inhibitor before exercising behavior, and normal application code would do the same before turns begin. Inside, it calls the selected platform backend’s `new` function so the right operating-system-specific helper is ready.

*Call graph*: calls 1 internal fn (new).


##### `SleepInhibitor::set_turn_running`  (lines 46–58)

```
fn set_turn_running(&mut self, turn_running: bool)
```

**Purpose**: Updates whether a turn is currently running and turns sleep prevention on or off to match. This is the main method other code uses during work.

**Data flow**: It receives the latest turn-running value from the caller. It records that value first. If the whole feature is disabled, it releases sleep prevention and stops. If the feature is enabled, a true value causes it to acquire sleep prevention, while a false value causes it to release sleep prevention.

**Call relations**: This is the central switch used after construction. When a turn starts, callers pass true and it hands off to `SleepInhibitor::acquire`; when the turn ends, callers pass false and it hands off to `SleepInhibitor::release`. The tests exercise it repeatedly to make sure these transitions are safe.

*Call graph*: calls 2 internal fn (acquire, release).


##### `SleepInhibitor::acquire`  (lines 60–62)

```
fn acquire(&mut self)
```

**Purpose**: Asks the platform-specific backend to start preventing system sleep. It is a small private helper so the public logic does not need to know platform details.

**Data flow**: It takes the existing `SleepInhibitor`, reaches into its platform backend, and tells that backend to acquire the sleep block. It does not return a value; the effect is that the backend should now be actively keeping the computer awake if supported.

**Call relations**: `SleepInhibitor::set_turn_running` calls this when sleep prevention is enabled and the caller says a turn has started. This method then delegates to the backend’s own `acquire` function, which is where macOS, Linux, Windows, or dummy behavior happens.

*Call graph*: calls 1 internal fn (acquire); called by 1 (set_turn_running).


##### `SleepInhibitor::release`  (lines 64–66)

```
fn release(&mut self)
```

**Purpose**: Asks the platform-specific backend to stop preventing system sleep. It is used both when a turn ends and when the feature is disabled.

**Data flow**: It takes the existing `SleepInhibitor`, reaches into its platform backend, and tells that backend to release the sleep block. It does not return a value; afterward, the machine is allowed to sleep normally unless something else is preventing it.

**Call relations**: `SleepInhibitor::set_turn_running` calls this when a turn stops, or immediately if sleep prevention is disabled. This method then delegates to the backend’s own `release` function so each operating system can clean up in its own way.

*Call graph*: calls 1 internal fn (release); called by 1 (set_turn_running).


##### `SleepInhibitor::is_turn_running`  (lines 69–71)

```
fn is_turn_running(&self) -> bool
```

**Purpose**: Reports the most recent turn-running value that the caller set. This is useful for checking the object’s current remembered state.

**Data flow**: It reads the stored `turn_running` flag from the `SleepInhibitor` and returns it as a true-or-false answer. It does not change anything.

**Call relations**: Tests use this after calling `SleepInhibitor::set_turn_running` to confirm that the requested state was recorded. In normal use, other code could use it to inspect whether the inhibitor believes a turn is currently active.


##### `tests::sleep_inhibitor_toggles_without_panicking`  (lines 79–85)

```
fn sleep_inhibitor_toggles_without_panicking()
```

**Purpose**: Checks the basic happy path: with sleep prevention enabled, the inhibitor can be turned on and then off without crashing, and it remembers the state correctly.

**Data flow**: It creates an enabled inhibitor, sets the turn state to true, checks that the object reports true, then sets the state to false and checks that it reports false. The output is a passing or failing test result.

**Call relations**: This test calls `SleepInhibitor::new` to create the object and then drives the public turn-state API. It indirectly exercises the acquire and release path through `SleepInhibitor::set_turn_running`.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert!).


##### `tests::sleep_inhibitor_disabled_does_not_panic`  (lines 88–94)

```
fn sleep_inhibitor_disabled_does_not_panic()
```

**Purpose**: Checks that disabled sleep prevention is still safe to use. Even when the feature is off, callers should be able to report turn starts and stops without errors.

**Data flow**: It creates an inhibitor with the enabled flag set to false. It sets the turn state to true and confirms the state is remembered, then sets it to false and confirms the remembered state changes back. The test passes if no crash occurs and the state checks are correct.

**Call relations**: This test calls `SleepInhibitor::new` and then uses `SleepInhibitor::set_turn_running` in disabled mode. That path should release rather than acquire, proving callers do not need special-case code when the feature is turned off.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert!).


##### `tests::sleep_inhibitor_multiple_true_calls_are_idempotent`  (lines 97–103)

```
fn sleep_inhibitor_multiple_true_calls_are_idempotent()
```

**Purpose**: Checks that saying “a turn is running” several times in a row is harmless. Idempotent means repeating the same request should not create a bad extra effect.

**Data flow**: It creates an enabled inhibitor, calls the turn-running update with true three times, then calls it with false once. The test does not inspect a return value; it succeeds if those repeated calls do not crash or leave the object unable to release.

**Call relations**: This test calls `SleepInhibitor::new` and repeatedly drives `SleepInhibitor::set_turn_running`. It is meant to catch problems where repeated acquire requests might confuse a platform backend.

*Call graph*: calls 1 internal fn (new).


##### `tests::sleep_inhibitor_can_toggle_multiple_times`  (lines 106–112)

```
fn sleep_inhibitor_can_toggle_multiple_times()
```

**Purpose**: Checks that the inhibitor can be reused across more than one start-and-stop cycle. This matters if the program runs many turns over its lifetime.

**Data flow**: It creates an enabled inhibitor, turns sleep prevention on, turns it off, turns it on again, and turns it off again. There is no returned data; the test passes if all transitions complete safely.

**Call relations**: This test calls `SleepInhibitor::new` and then exercises repeated calls through `SleepInhibitor::set_turn_running`. It indirectly tests that acquire and release can alternate cleanly instead of only working once.

*Call graph*: calls 1 internal fn (new).


### `utils/sleep-inhibitor/src/dummy.rs`

`domain_logic` · `runtime when sleep prevention is toggled`

A sleep inhibitor is normally the part of an app that tells the operating system, “please do not let the computer go to sleep right now.” This file is the fallback version: it has the same shape as a real sleep inhibitor, but it deliberately does nothing.

That may sound pointless, but it is useful. Other parts of the project can call the same methods whether sleep prevention is available or not. Without this dummy version, the rest of the code would need many special cases, or the program might fail to build on systems that do not have a sleep-prevention API.

The file defines a small `SleepInhibitor` type. Creating one simply returns an empty object. Calling `acquire` is meant to mean “start preventing sleep,” and calling `release` is meant to mean “stop preventing sleep.” In this dummy implementation, both calls are harmless no-ops: they change nothing and return nothing. Think of it like a light switch that is installed only so the room layout stays the same, but it is not connected to any light. Code can still flip it safely.

#### Function details

##### `SleepInhibitor::new`  (lines 5–7)

```
fn new() -> Self
```

**Purpose**: Creates a dummy `SleepInhibitor` object. It is used when the program needs something that looks like a sleep inhibitor, even though this version will not actually talk to the operating system.

**Data flow**: Nothing is passed in. The function creates and returns an empty `SleepInhibitor` value. No files, system settings, or outside services are touched.

**Call relations**: Higher-level setup code and tests call this when they need a sleep inhibitor instance. After it is created, wrapper functions or feature code may call `acquire` or `release` on it, but in this dummy version those later calls are intentionally harmless.

*Call graph*: called by 7 (new, set_prevent_idle_sleep, new, sleep_inhibitor_can_toggle_multiple_times, sleep_inhibitor_disabled_does_not_panic, sleep_inhibitor_multiple_true_calls_are_idempotent, sleep_inhibitor_toggles_without_panicking).


##### `SleepInhibitor::acquire`  (lines 9–9)

```
fn acquire(&mut self)
```

**Purpose**: Pretends to turn on sleep prevention. In this dummy implementation, it exists so callers can request sleep prevention without needing to know whether real support is available.

**Data flow**: It receives a mutable reference to the dummy object, meaning the caller is prepared for the object to change. The function does nothing with it and returns nothing, so the before and after state are the same.

**Call relations**: A higher-level `acquire` function calls this when the program wants to prevent idle sleep. In a real implementation this would hand the request to the operating system; here the call stops immediately and safely.

*Call graph*: called by 1 (acquire).


##### `SleepInhibitor::release`  (lines 11–11)

```
fn release(&mut self)
```

**Purpose**: Pretends to turn off sleep prevention. It lets callers follow the normal cleanup path even when no real sleep-prevention request was ever made.

**Data flow**: It receives a mutable reference to the dummy object. It makes no changes and returns nothing, leaving the object exactly as it was.

**Call relations**: A higher-level `release` function calls this when the program no longer needs to prevent idle sleep. In this fallback implementation there is no operating-system request to undo, so the function simply returns.

*Call graph*: called by 1 (release).


### `utils/sleep-inhibitor/src/iokit_bindings.rs`

`generated` · `runtime, when the sleep-inhibitor starts or stops preventing system sleep`

This is automatically generated glue code. The real power-management features live in macOS, not in this project, and they are exposed as C functions. Rust cannot call those C functions directly unless it knows their names, argument types, and return types. This file supplies that map.

The main idea is simple: macOS lets an app create a “power assertion,” which is like putting a temporary note on the system saying, “please do not sleep yet; I am doing something important.” The file defines the Rust names for the pieces involved: success and on/off constants, pointer types for macOS strings, an assertion ID, and the two external macOS calls used to create and release an assertion.

Because these declarations cross from Rust into Apple’s system libraries, the functions are marked unsafe. That means Rust cannot guarantee by itself that the pointers and IDs passed in are valid; the higher-level sleep-inhibitor code must use them carefully. Without this file, the rest of the Rust code would have no typed way to talk to IOKit, the macOS framework that provides these power-management calls.


### `utils/sleep-inhibitor/src/linux_inhibitor.rs`

`domain_logic` · `cross-cutting during active turns; cleanup on release or drop`

This file is the Linux-specific part of Codex’s “please stay awake” feature. When Codex is running an active turn, the user may not be touching the keyboard or mouse, but the machine still needs to stay awake. Without this file, a Linux laptop or desktop could dim, lock, suspend, or otherwise interrupt work in the middle of a turn.

The main type, `LinuxSleepInhibitor`, works like a temporary “do not disturb” sign for system sleep. Calling `acquire` tries to put the sign up. It first checks whether an earlier helper process is still alive. If it is, nothing more is needed. If it died, the code tries again.

Linux does not have just one universal way to block sleep, so the file tries two backends: `systemd-inhibit` first, then `gnome-session-inhibit`. Each backend is launched running a very long `sleep` command. As long as that child process stays alive, the desktop or system service treats Codex as actively requesting that idle sleep be blocked.

Calling `release` removes the sign by killing and waiting for the helper process. The `Drop` implementation also calls `release`, so cleanup happens automatically if the inhibitor object is discarded. The code is careful to avoid noisy repeated warnings when no backend exists, and it arranges for the helper process to receive a termination signal if the parent Codex process dies unexpectedly.

#### Function details

##### `LinuxSleepInhibitor::new`  (lines 39–41)

```
fn new() -> Self
```

**Purpose**: Creates a fresh Linux sleep inhibitor in the inactive state. Code uses this when it wants an object that can later turn sleep blocking on and off.

**Data flow**: No outside data goes in. The function asks Rust for the default value of `LinuxSleepInhibitor`, which means no active helper process, no preferred backend yet, and no missing-backend warning recorded. It returns that ready-to-use object.

**Call relations**: This is the simple starting point for the sleep-inhibitor object. Later, callers use `LinuxSleepInhibitor::acquire` to start blocking sleep and `LinuxSleepInhibitor::release` to stop.

*Call graph*: 1 external calls (default).


##### `LinuxSleepInhibitor::acquire`  (lines 43–143)

```
fn acquire(&mut self)
```

**Purpose**: Turns on Linux sleep blocking, if possible. It keeps the computer awake by making sure one of the supported Linux inhibitor helper programs is running.

**Data flow**: It starts with the inhibitor’s current state. If a helper process is already active, it checks whether that process is still running. If it is still alive, the function returns without changing anything. If it has exited or cannot be checked, the function resets the state and tries to start a backend helper. It prefers the backend that worked before, then falls back to the other one. On success, it stores the running child process and remembers the working backend. On failure, it may log warnings, and if no backend is available it records that so the same warning is not repeated every time.

**Call relations**: This is the main entry into the file’s behavior. It calls `spawn_backend` to launch either `systemd-inhibit` or `gnome-session-inhibit`. When cleanup of a failed child process reports an error, it asks `child_exited` whether that error simply means the child was already gone. It uses warning logs to explain unexpected backend exits, startup failures, and missing support.

*Call graph*: calls 2 internal fn (child_exited, spawn_backend); 1 external calls (warn!).


##### `LinuxSleepInhibitor::release`  (lines 145–161)

```
fn release(&mut self)
```

**Purpose**: Turns off Linux sleep blocking. It stops the helper process that was keeping the machine awake and waits for the operating system to finish cleaning it up.

**Data flow**: It takes the current state out of the inhibitor and replaces it with inactive. If there was no active helper, nothing happens. If there was an active helper, it sends a kill signal to that child process, then waits for it to exit. If either step reports an error, it checks whether the child had already exited; only unexpected problems are logged.

**Call relations**: Callers use this when Codex no longer needs to keep the machine awake. `LinuxSleepInhibitor::drop` also calls it automatically, so the helper process is not left behind when the inhibitor object goes away. It uses `child_exited` to avoid treating an already-finished child process as a real failure.

*Call graph*: calls 1 internal fn (child_exited); called by 1 (drop); 2 external calls (take, warn!).


##### `LinuxSleepInhibitor::drop`  (lines 165–167)

```
fn drop(&mut self)
```

**Purpose**: Automatically cleans up sleep blocking when the inhibitor object is destroyed. This is a safety net so Codex does not accidentally leave a helper process running.

**Data flow**: It receives the inhibitor object just before Rust frees it. It calls `release`, which changes any active state to inactive and stops the child process if one exists. It returns nothing; its effect is cleanup.

**Call relations**: Rust calls this automatically as part of object destruction. It delegates the actual work to `LinuxSleepInhibitor::release`, keeping the cleanup path the same whether shutdown is explicit or automatic.

*Call graph*: calls 1 internal fn (release).


##### `spawn_backend`  (lines 170–226)

```
fn spawn_backend(backend: LinuxBackend) -> Result<Child, std::io::Error>
```

**Purpose**: Starts one specific Linux sleep-inhibitor backend as a child process. This is the low-level function that turns a backend choice into an actual running operating-system process.

**Data flow**: It receives a backend choice: either `systemd-inhibit` or `gnome-session-inhibit`. It builds the matching command line, including the reason Codex wants to block idle sleep and a very long `sleep` command to keep the inhibition alive. It redirects standard input, output, and error to nowhere, so the helper does not interact with the terminal. Before the child program starts, it installs a parent-death signal so the helper is told to stop if the Codex process dies. It returns either the newly spawned child process or an operating-system error explaining why spawning failed.

**Call relations**: `LinuxSleepInhibitor::acquire` calls this while trying possible backends. If this function succeeds, `acquire` checks that the child is still running and then stores it as the active blocker. If it fails, `acquire` moves on to the next backend or logs a warning.

*Call graph*: called by 1 (acquire); 3 external calls (null, new, getpid).


##### `child_exited`  (lines 228–230)

```
fn child_exited(error: &std::io::Error) -> bool
```

**Purpose**: Recognizes a harmless cleanup case: an error that means the child process was already gone. This prevents misleading warnings when cleanup races with a process that has just exited on its own.

**Data flow**: It receives an operating-system error. It checks the error kind and returns `true` only when the kind is `InvalidInput`, which this code treats as the signal that the child process has already exited. Otherwise it returns `false`.

**Call relations**: `LinuxSleepInhibitor::acquire` uses this while cleaning up a backend that could not be checked properly after spawning. `LinuxSleepInhibitor::release` uses it while killing and waiting for the active helper. In both places, it helps separate expected “already gone” cases from problems worth warning about.

*Call graph*: called by 2 (acquire, release); 1 external calls (matches!).


##### `tests::sleep_seconds_is_i32_max`  (lines 237–239)

```
fn sleep_seconds_is_i32_max()
```

**Purpose**: Checks that the long helper sleep time is exactly the largest 32-bit signed integer value. This guards the assumption that the blocker can sleep for a very long time while still using a value accepted by common `sleep` commands.

**Data flow**: It reads the `BLOCKER_SLEEP_SECONDS` constant and compares it with `i32::MAX` formatted as text. If the strings match, the test passes. If someone changes the constant to a different value, the test fails.

**Call relations**: This is a small test inside the same file. It does not participate in normal runtime sleep blocking. It runs during testing to protect the constant used by `spawn_backend` when building the helper command.

*Call graph*: 1 external calls (assert_eq!).


### `utils/sleep-inhibitor/src/macos.rs`

`domain_logic` · `active turn / request handling`

This is the macOS-specific part of the sleep-inhibitor utility. Its job is to stop the computer from automatically sleeping during an active Codex turn, so a long-running task is not interrupted halfway through. Without this file on macOS, Codex could be paused or disrupted if the user’s machine decides it has been idle too long.

The main public-facing piece is `SleepInhibitor`. It stores an optional `MacSleepAssertion`, meaning it either currently has a sleep-prevention request active or it does not. Calling `acquire` creates that request if one is not already active. Calling `release` removes it by dropping the stored assertion.

The lower-level piece, `MacSleepAssertion`, talks directly to Apple’s IOKit framework. IOKit is a macOS system framework for hardware and power-management features. The file creates Core Foundation strings, passes them to the macOS function that creates a power assertion, and stores the returned assertion ID. When the `MacSleepAssertion` is dropped, it automatically releases the assertion with macOS. This is similar to borrowing a “do not sleep” token from the operating system and making sure it is returned when no longer needed.

If creating or releasing the assertion fails, the file logs a warning instead of crashing. That means sleep prevention is best-effort: useful when available, but not allowed to bring the program down.

#### Function details

##### `SleepInhibitor::new`  (lines 34–36)

```
fn new() -> Self
```

**Purpose**: Creates a new sleep inhibitor with no active sleep-prevention request yet. A caller uses this when it wants an object it can later ask to keep the Mac awake.

**Data flow**: It takes no extra information beyond constructing the object. It uses the default empty state, where there is no stored `MacSleepAssertion`, and returns a ready-to-use `SleepInhibitor`.

**Call relations**: This is the starting point for code that wants to control sleep prevention. After creating the object, later code can call `SleepInhibitor::acquire` to begin preventing sleep and `SleepInhibitor::release` to stop.

*Call graph*: 1 external calls (default).


##### `SleepInhibitor::acquire`  (lines 38–54)

```
fn acquire(&mut self)
```

**Purpose**: Turns on sleep prevention if it is not already on. It is careful not to create duplicate macOS assertions, because one active assertion is enough.

**Data flow**: It looks at the inhibitor’s current stored assertion. If one is already present, nothing changes. If none is present, it asks `MacSleepAssertion::create` to request a macOS sleep-prevention assertion using the fixed reason text. On success, it stores the new assertion; on failure, it leaves the inhibitor unchanged and writes a warning with the macOS error code.

**Call relations**: This is called when Codex starts work that should not be interrupted by system sleep. It delegates the operating-system-specific work to `MacSleepAssertion::create`, then keeps the returned assertion alive by storing it. If the lower-level call fails, it reports the problem through the tracing warning system.

*Call graph*: calls 1 internal fn (create); 1 external calls (warn!).


##### `SleepInhibitor::release`  (lines 56–58)

```
fn release(&mut self)
```

**Purpose**: Turns off sleep prevention if it is currently active. A caller uses this when the protected work is finished and the Mac may sleep normally again.

**Data flow**: It replaces the stored assertion with nothing. If an assertion was present, removing it causes the `MacSleepAssertion` to be dropped, and that drop action releases the macOS power assertion.

**Call relations**: This is the matching cleanup step after `SleepInhibitor::acquire`. It does not call the macOS release function directly; instead, it relies on `MacSleepAssertion::drop` to return the assertion to the operating system when the stored value is removed.


##### `MacSleepAssertion::create`  (lines 67–90)

```
fn create(name: &str) -> Result<Self, IOReturn>
```

**Purpose**: Asks macOS to create a real sleep-prevention assertion and wraps the returned assertion ID in a Rust object. This is the bridge between the project’s simple sleep-inhibitor idea and Apple’s power-management API.

**Data flow**: It receives a human-readable reason string, builds the Core Foundation strings macOS expects, and prepares a place for macOS to write back an assertion ID. It calls `IOPMAssertionCreateWithName`. If macOS reports success, it returns a `MacSleepAssertion` containing the ID; otherwise, it returns the macOS error code.

**Call relations**: This function is called by `SleepInhibitor::acquire` when no assertion is currently active. It performs the unsafe operating-system call in one contained place, then hands back either a safe wrapper object or an error that `acquire` can log.

*Call graph*: called by 1 (acquire); 2 external calls (new, IOPMAssertionCreateWithName).


##### `MacSleepAssertion::drop`  (lines 94–106)

```
fn drop(&mut self)
```

**Purpose**: Releases the macOS sleep-prevention assertion when the wrapper object goes away. This makes cleanup automatic, so callers do not have to remember a separate low-level release call.

**Data flow**: It reads the stored assertion ID and passes it to `IOPMAssertionRelease`. If macOS says the release succeeded, nothing else happens. If macOS reports an error, it logs a warning with that error code.

**Call relations**: This runs automatically when a `MacSleepAssertion` is dropped, most commonly because `SleepInhibitor::release` removes it or because the owning `SleepInhibitor` itself is destroyed. It is the counterpart to `MacSleepAssertion::create`, returning the borrowed sleep-prevention token to macOS.

*Call graph*: 2 external calls (IOPMAssertionRelease, warn!).


### `utils/sleep-inhibitor/src/windows_inhibitor.rs`

`util` · `active during an active Codex turn; cleanup happens when the turn ends or the inhibitor is dropped`

When Codex is in the middle of an active turn, the machine going to sleep could interrupt the work. This file solves that Windows-specific problem by asking the operating system to treat Codex as something that still needs the system awake. It does not keep the screen on; it only prevents idle system sleep, matching the behavior used on macOS.

The main public piece is `WindowsSleepInhibitor`, also exported as `SleepInhibitor` for this platform. It stores an optional `PowerRequest`. Think of `PowerRequest` like a claim ticket given by Windows: while Codex holds the ticket, Windows knows not to put the system to sleep for idleness. When the ticket is dropped, the request is cleared and the ticket is closed.

Calling `acquire` creates the Windows power request if one is not already active. It includes a human-readable reason, “Codex is running an active turn,” so Windows can record why sleep is being blocked. If Windows refuses or something goes wrong, the file logs a warning instead of crashing. Calling `release` removes the stored request, which automatically triggers cleanup through Rust’s `Drop` behavior. The most important safety rule here is ownership: once a Windows handle is created, this file is responsible for clearing and closing it exactly once.

#### Function details

##### `WindowsSleepInhibitor::new`  (lines 27–29)

```
fn new() -> Self
```

**Purpose**: Creates a new sleep inhibitor that is not yet preventing sleep. Code uses this when it wants a ready-to-use object that can later be told to acquire or release the sleep-prevention request.

**Data flow**: It takes no outside data. It builds the default `WindowsSleepInhibitor`, whose stored request is empty, and returns that fresh object to the caller.

**Call relations**: This is the simple starting point for the Windows sleep-prevention helper. Later, the owner of this object calls `WindowsSleepInhibitor::acquire` when Codex begins work and `WindowsSleepInhibitor::release` when that work is done.

*Call graph*: 1 external calls (default).


##### `WindowsSleepInhibitor::acquire`  (lines 31–47)

```
fn acquire(&mut self)
```

**Purpose**: Starts preventing Windows from putting the system to sleep because Codex is actively running. If sleep prevention is already active, it quietly does nothing so duplicate requests are not created.

**Data flow**: It reads its own stored `request`. If a request already exists, nothing changes. If there is no request, it asks `PowerRequest::new_system_required` to create a Windows power request with the Codex reason string. On success, it stores the new request. On failure, it leaves itself unchanged and writes a warning log.

**Call relations**: This is the high-level method other Codex code would call at the start of an active turn. It delegates the Windows-specific work to `PowerRequest::new_system_required`, then keeps the returned request alive for as long as sleep should be blocked.

*Call graph*: calls 1 internal fn (new_system_required); 1 external calls (warn!).


##### `WindowsSleepInhibitor::release`  (lines 49–51)

```
fn release(&mut self)
```

**Purpose**: Stops preventing system sleep. It is used when Codex no longer needs to keep the computer awake.

**Data flow**: It replaces its stored request with `None`. If a `PowerRequest` was present, removing it causes Rust to drop that object, which clears the Windows power request and closes the underlying Windows handle.

**Call relations**: This is the matching cleanup step after `WindowsSleepInhibitor::acquire`. It does not directly call Windows itself; instead, it relies on `PowerRequest::drop` to perform the actual operating-system cleanup when the stored request is removed.


##### `PowerRequest::new_system_required`  (lines 61–95)

```
fn new_system_required(reason: &str) -> Result<Self, String>
```

**Purpose**: Creates the actual Windows power request that tells the operating system the system is required to stay awake. This is the low-level bridge between Rust code and the Windows power-management functions.

**Data flow**: It receives a plain-text reason string. It converts that string into the wide-character format Windows expects, builds a Windows reason context, and calls `PowerCreateRequest` to get a handle. If handle creation fails, it returns an error message. If creation succeeds, it calls `PowerSetRequest` with the system-required request type. If setting the request fails, it closes the handle and returns an error. If everything works, it returns a `PowerRequest` containing the handle and the request type needed for later cleanup.

**Call relations**: This function is called by `WindowsSleepInhibitor::acquire` when no sleep-prevention request is currently active. It does the platform-specific setup and hands back a `PowerRequest` that must stay alive for the request to remain in effect.

*Call graph*: called by 1 (acquire); 7 external calls (new, last_os_error, format!, once, CloseHandle, PowerCreateRequest, PowerSetRequest).


##### `PowerRequest::drop`  (lines 99–118)

```
fn drop(&mut self)
```

**Purpose**: Cleans up a Windows power request when the Rust object is no longer kept. This prevents Codex from accidentally blocking sleep forever and prevents leaking the Windows handle.

**Data flow**: It reads the stored Windows handle and request type from the `PowerRequest`. It asks Windows to clear the sleep-prevention request. If that fails, it logs a warning. Then it closes the Windows handle. If closing fails, it also logs a warning. It does not return a value; its effect is cleanup.

**Call relations**: This runs automatically when a `PowerRequest` is dropped, most commonly after `WindowsSleepInhibitor::release` removes it from storage or when the inhibitor itself is destroyed. It is the final step in the acquire-release story: `acquire` creates and stores the request, and `drop` clears and closes it.

*Call graph*: 4 external calls (last_os_error, warn!, CloseHandle, PowerClearRequest).


### Runtime and UI support helpers
These files supply compact support utilities for runtime value conversion, replay filtering, frame-rate limiting, and lightweight caching.

### `code-mode/src/runtime/value.rs`

`util` · `cross-cutting during JavaScript callback and tool-output handling`

Code mode runs JavaScript, but the surrounding system is written in Rust and expects well-defined data. This file sits at that border. It is like a customs desk: JavaScript values arrive in many shapes, and this code checks them, converts them, and rejects anything unsafe or unclear.

For text output, it accepts simple JavaScript values directly and turns more complex objects into JSON text. For image output, it accepts a plain image URL string, an object with an image_url field, or a raw MCP image block. MCP means Model Context Protocol, a standard way tools can describe content such as images. The file also blocks remote http and https image URLs in tool output, requiring embedded base64 data instead, so the system does not depend on fetching outside resources later.

The file also converts values both ways between V8 JavaScript values and serde_json::Value, Rust’s common JSON representation. That lets callbacks store, load, and pass structured data safely. Finally, it has small helpers for turning thrown JavaScript values into readable error messages and for throwing type errors back into JavaScript when a callback receives the wrong kind of value.

#### Function details

##### `serialize_output_text`  (lines 11–37)

```
fn serialize_output_text(
    scope: &mut v8::PinScope<'_, '_>,
    value: v8::Local<'_, v8::Value>,
) -> Result<String, String>
```

**Purpose**: Turns a JavaScript value into the text that should be sent as tool or notification output. Simple values become their normal string form, while objects and arrays are converted to JSON text when possible.

**Data flow**: It receives a V8 execution scope and one JavaScript value. If the value is undefined, null, a boolean, a number, a bigint, or a string, it directly reads it as text. Otherwise it tries to JSON-stringify the value inside a JavaScript try/catch area; if JavaScript throws during that process, it returns the thrown error as readable text. The result is either a Rust String or an error String.

**Call relations**: This is used when notify_callback or text_callback needs to turn JavaScript output into plain text for the Rust side. When JSON stringification fails, it relies on the same error-text style used elsewhere so callers can report a human-readable failure.

*Call graph*: called by 2 (notify_callback, text_callback); 9 external calls (is_big_int, is_boolean, is_null, is_number, is_string, is_undefined, to_rust_string_lossy, pin!, stringify).


##### `normalize_output_image`  (lines 39–96)

```
fn normalize_output_image(
    scope: &mut v8::PinScope<'_, '_>,
    value: v8::Local<'_, v8::Value>,
    detail_override: Option<String>,
) -> Result<FunctionCallOutputContentItem, ()>
```

**Purpose**: Checks and converts JavaScript image output into the protocol’s standard image item. It accepts a few friendly input shapes but enforces the system’s safety rule that tool outputs must not point to remote web images.

**Data flow**: It receives a V8 scope, a JavaScript value, and an optional detail override such as low or high. It reads the image URL and optional detail from either a string, an object with image_url, or an MCP image block. It rejects empty values, http or https URLs, and unknown detail levels. On success it returns a FunctionCallOutputContentItem::InputImage with a data URL and an ImageDetail value; on failure it throws a JavaScript TypeError and returns an error marker.

**Call relations**: generated_image_callback and image_callback call this when JavaScript code says it produced an image. Internally it uses the image-parsing helpers to understand the allowed shapes, then calls throw_type_error when the value cannot be accepted.

*Call graph*: calls 1 internal fn (throw_type_error); called by 2 (generated_image_callback, image_callback).


##### `parse_non_mcp_output_image`  (lines 98–117)

```
fn parse_non_mcp_output_image(
    scope: &mut v8::PinScope<'_, '_>,
    object: v8::Local<'_, v8::Object>,
) -> Result<Option<(String, Option<String>)>, String>
```

**Purpose**: Reads the simple image object form used by code mode: an object with image_url and, optionally, detail. It returns nothing if the object is not using that form, so another parser can try the MCP form.

**Data flow**: It receives a V8 scope and a JavaScript object. It looks for an image_url property. If that property is absent or undefined, it reports that this is not the simple image form. If image_url is present but not a string, it returns an error. It also reads the optional detail property using parse_image_detail_value. The result is either an image URL plus optional detail, no match, or an error message.

**Call relations**: This helper is part of the image-normalizing path used before falling back to MCP image parsing. It delegates the small but important detail-field rules to parse_image_detail_value so those rules stay consistent.

*Call graph*: calls 1 internal fn (parse_image_detail_value); 2 external calls (get, new).


##### `parse_mcp_output_image`  (lines 119–164)

```
fn parse_mcp_output_image(
    scope: &mut v8::PinScope<'_, '_>,
    value: v8::Local<'_, v8::Value>,
) -> Result<(String, Option<String>), String>
```

**Purpose**: Reads an MCP image block and turns it into the image URL form expected by code mode. This lets tool output reuse MCP’s structured image format while still producing the protocol item this runtime needs.

**Data flow**: It receives a V8 scope and a JavaScript value. First it converts the JavaScript value into JSON. Then it checks that the JSON object has type equal to image and contains non-empty image data. If the data is already a data URI, it keeps it. Otherwise it wraps the base64 data with a data: URL prefix, using the provided MIME type or a safe default. It also reads a Codex-specific image detail value from _meta when present and valid. The result is an image URL and optional detail, or an explanatory error.

**Call relations**: This is the fallback image parser used when the simpler image_url object shape does not apply. It calls v8_value_to_json because MCP blocks are easiest to inspect as JSON-like objects.

*Call graph*: calls 1 internal fn (v8_value_to_json); 1 external calls (format!).


##### `parse_image_detail_value`  (lines 166–176)

```
fn parse_image_detail_value(
    scope: &mut v8::PinScope<'s, '_>,
    value: Option<v8::Local<'s, v8::Value>>,
) -> Result<Option<String>, String>
```

**Purpose**: Reads the optional detail setting from an image object. Detail tells the model how much image detail to use, such as low, high, auto, or original.

**Data flow**: It receives a V8 scope and maybe a JavaScript value. If the value is a string, it returns that string. If the value is null, undefined, or missing, it returns no detail. If the value is present but not a string, it returns an error saying the detail must be a string.

**Call relations**: parse_non_mcp_output_image calls this while reading the optional detail property. The broader image-normalizing step later checks whether the string is one of the accepted detail names.

*Call graph*: called by 1 (parse_non_mcp_output_image).


##### `v8_value_to_json`  (lines 178–196)

```
fn v8_value_to_json(
    scope: &mut v8::PinScope<'_, '_>,
    value: v8::Local<'_, v8::Value>,
) -> Result<Option<JsonValue>, String>
```

**Purpose**: Converts a JavaScript value into Rust JSON so Rust code can inspect or store it as structured data. It is used when callbacks need more than a plain string.

**Data flow**: It receives a V8 scope and a JavaScript value. It asks V8 to JSON-stringify the value inside a try/catch area. If JavaScript throws, it returns a readable error. If V8 cannot stringify the value but did not throw, it returns no JSON value. If stringification works, it parses the JSON text into serde_json::Value and returns it, or returns a parse error if the text cannot be read as JSON.

**Call relations**: store_callback and tool_callback use this to move JavaScript data into Rust-owned JSON. parse_mcp_output_image also uses it so it can inspect MCP image blocks with normal JSON field lookups.

*Call graph*: called by 3 (store_callback, tool_callback, parse_mcp_output_image); 3 external calls (from_str, pin!, stringify).


##### `json_to_v8`  (lines 198–205)

```
fn json_to_v8(
    scope: &mut v8::PinScope<'s, '_>,
    value: &JsonValue,
) -> Option<v8::Local<'s, v8::Value>>
```

**Purpose**: Converts Rust JSON back into a JavaScript value. This is useful when stored data or tool responses need to be handed back to JavaScript code.

**Data flow**: It receives a V8 scope and a serde_json::Value. It serializes the Rust JSON to text, creates a JavaScript string from that text, and asks V8 to parse it as JSON. If any step fails, it returns no value; otherwise it returns the new JavaScript value.

**Call relations**: load_callback uses this when JavaScript asks to load stored data. resolve_tool_response uses it when a Rust-side tool response needs to become a JavaScript value again.

*Call graph*: called by 2 (load_callback, resolve_tool_response); 3 external calls (to_string, new, parse).


##### `value_to_error_text`  (lines 207–220)

```
fn value_to_error_text(
    scope: &mut v8::PinScope<'_, '_>,
    value: v8::Local<'_, v8::Value>,
) -> String
```

**Purpose**: Turns a thrown JavaScript value into the most useful error text available. If the value has a stack trace, it prefers that, because a stack trace usually explains where the problem happened.

**Data flow**: It receives a V8 scope and a JavaScript value. If the value is an object with a string stack property, it returns that stack text. Otherwise it falls back to the value’s ordinary string form. The output is always a Rust String.

**Call relations**: completion_state and evaluate_main_module call this when JavaScript execution fails and the Rust side needs a readable message. Other conversion paths use the same idea when reporting exceptions from stringification.

*Call graph*: called by 2 (completion_state, evaluate_main_module); 4 external calls (is_object, to_rust_string_lossy, try_from, new).


##### `throw_type_error`  (lines 222–226)

```
fn throw_type_error(scope: &mut v8::PinScope<'_, '_>, message: &str)
```

**Purpose**: Throws a JavaScript TypeError-style exception message from Rust code. It is used when a callback receives a value in the wrong shape, such as an invalid image or bad timeout argument.

**Data flow**: It receives a V8 scope and a message string. It creates a JavaScript string for the message and throws it into the current V8 execution context. It does not return a data value; its effect is to mark the JavaScript call as failed.

**Call relations**: Many callbacks use this common helper, including clear_timeout_callback, generated_image_callback, image_callback, load_callback, notify_callback, set_timeout_callback, store_callback, and text_callback. normalize_output_image also calls it after turning image validation failures into messages JavaScript code can see.

*Call graph*: called by 10 (clear_timeout_callback, generated_image_callback, image_callback, load_callback, notify_callback, set_timeout_callback, store_callback, text_callback, tool_callback, normalize_output_image); 2 external calls (throw_exception, new).


### `tui/src/app/replay_filter.rs`

`domain_logic` · `thread switching`

When a user moves from one thread to another, the app may have a buffer of past events for that thread. Replaying everything blindly could be noisy, but skipping the wrong thing could hide an important question the system is waiting for the user to answer. This file provides two small checks that make that decision safer.

The first check looks at a saved snapshot of a thread and asks: “Is there any pending interactive request here?” In plain terms, it searches for events where the server is waiting for the user to approve something, provide input, respond to a permission request, or answer a tool or MCP server prompt. If such an event exists, the interface knows the thread still needs human attention.

The second check asks whether a single event is just a notice-style warning. These are server notifications such as regular warnings, guardian warnings, or configuration warnings. Marking them separately lets the replay logic treat warnings differently from requests that block progress.

Together, these helpers act like labels on mail in an inbox: some messages are just notices, while others are forms that must be signed before anything can continue.

#### Function details

##### `snapshot_has_pending_interactive_request`  (lines 9–22)

```
fn snapshot_has_pending_interactive_request(snapshot: &ThreadEventSnapshot) -> bool
```

**Purpose**: Checks whether a thread snapshot contains any event where the app is waiting for the user to respond. This matters because those events should not be silently ignored when a user returns to a thread.

**Data flow**: It receives a ThreadEventSnapshot, which contains a list of buffered events. It scans the events one by one and looks for request events such as approval prompts, permission requests, file-change approvals, MCP elicitation prompts, or tool input requests. It returns true if it finds at least one such pending user-facing request, and false if it does not change anything and finds none.

**Call relations**: When replay_thread_snapshot is deciding how to replay a saved thread, it calls this function to learn whether the thread still has an unresolved interactive prompt. The result helps the replay step avoid treating an attention-needed thread like ordinary background history.

*Call graph*: called by 1 (replay_thread_snapshot).


##### `event_is_notice`  (lines 24–33)

```
fn event_is_notice(event: &ThreadBufferedEvent) -> bool
```

**Purpose**: Checks whether one buffered event is a warning-style notice rather than an interactive request or other kind of event. This lets replay code recognize messages that are informational and may be displayed differently.

**Data flow**: It receives one ThreadBufferedEvent. It uses Rust pattern matching to see whether the event is a notification containing a warning, guardian warning, or configuration warning. It returns true for those notice events and false for every other kind of buffered event, without modifying the event.

**Call relations**: replay_thread_snapshot calls this function while deciding what to do with each buffered event during thread replay. Inside the function, the matching expression is the actual decision point: it compares the event against the known notice notification shapes and reports whether it fits.

*Call graph*: called by 1 (replay_thread_snapshot); 1 external calls (matches!).


### `tui/src/tui/frame_rate_limiter.rs`

`util` · `cross-cutting during frame scheduling`

This file is a small helper for pacing screen redraws in the text user interface. Some widgets may repeatedly ask for a new frame, especially during rapid updates. Without a limiter, the app could spend time drawing far more often than needed, like someone repainting a sign hundreds of times a second when passersby would only notice a few changes.

The main idea is simple: remember when the last draw notification was sent, then refuse to schedule the next one earlier than a small minimum gap after that. The constant `MIN_FRAME_INTERVAL` is that gap: about 8.33 milliseconds, which corresponds to 120 frames per second.

`FrameRateLimiter` stores one piece of state: the time when the most recent draw was emitted. If no draw has happened yet, it lets the requested deadline pass through unchanged. If a draw did happen recently, it pushes the requested deadline forward when needed so the next draw cannot happen too soon.

The file also includes tests that check both important cases: a fresh limiter does not delay the first frame, and after a frame is marked as emitted, a too-early request is delayed to the minimum allowed time.

#### Function details

##### `FrameRateLimiter::clamp_deadline`  (lines 23–31)

```
fn clamp_deadline(&self, requested: Instant) -> Instant
```

**Purpose**: This function decides the earliest safe time for the next draw notification. It returns the requested time unless that would make frames happen faster than the 120 FPS limit.

**Data flow**: It receives a requested time for a future draw and reads the limiter's remembered last emission time. If there is no previous emission, the requested time comes back unchanged. If there was a previous emission, it calculates the earliest allowed next time and returns whichever is later: the requested time or that minimum allowed time.

**Call relations**: This is the function the frame scheduling code would call before committing to a draw deadline. Internally, it compares two times using `max` so that an overly eager request is pushed forward instead of being accepted too soon.

*Call graph*: 1 external calls (max).


##### `FrameRateLimiter::mark_emitted`  (lines 34–36)

```
fn mark_emitted(&mut self, emitted_at: Instant)
```

**Purpose**: This function records that a draw notification actually happened at a given time. It gives the limiter the memory it needs to slow down later requests.

**Data flow**: It receives the time when a draw was emitted. It stores that time inside the `FrameRateLimiter`, replacing any older remembered emission time. It does not return a value; its effect is the updated internal state.

**Call relations**: The frame scheduler would call this after it sends a draw notification. Later, `FrameRateLimiter::clamp_deadline` uses the stored time to decide whether the next requested draw is too soon.


##### `tests::default_does_not_clamp`  (lines 45–49)

```
fn default_does_not_clamp()
```

**Purpose**: This test proves that a brand-new limiter does not delay the first requested frame. That matters because the rate limit should only apply after a frame has already been emitted.

**Data flow**: It takes the current time, creates a default `FrameRateLimiter`, and asks it to clamp that time. The expected result is the same time, showing that no hidden delay is added before the first emission.

**Call relations**: This test calls the limiter's default constructor and then exercises `FrameRateLimiter::clamp_deadline`. It uses an equality assertion to confirm the first request passes through unchanged.

*Call graph*: 3 external calls (now, assert_eq!, default).


##### `tests::clamps_to_min_interval_since_last_emit`  (lines 52–61)

```
fn clamps_to_min_interval_since_last_emit()
```

**Purpose**: This test proves that once a frame has been emitted, a new request that comes too soon is delayed. It checks the core promise of the limiter: do not exceed the maximum frame rate.

**Data flow**: It starts with the current time and a fresh limiter, confirms the first deadline is unchanged, then records a frame emission at that time. It creates a second requested time only 1 millisecond later, which is too soon, and checks that the returned time is moved forward to the minimum allowed interval.

**Call relations**: This test uses `FrameRateLimiter::mark_emitted` to create the remembered last-frame state, then calls `FrameRateLimiter::clamp_deadline` to verify the limiter responds correctly. It also uses standard time helpers to build the too-early request.

*Call graph*: 4 external calls (from_millis, now, assert_eq!, default).


### `utils/cache/src/lib.rs`

`util` · `cross-cutting`

This file solves a common speed problem: if the program keeps recomputing the same expensive answer, it can save time by remembering recent answers. The main type, BlockingLruCache, is an LRU cache, meaning “least recently used”: when it gets full, it throws away the item that has gone unused the longest, like clearing the oldest papers off a crowded desk. The cache is protected by a Tokio mutex, which is a lock that stops two tasks from changing the cache at the same time. That matters because async programs may have many tasks running side by side.

A key detail is that this cache only really stores data when it is used inside a Tokio runtime, which is the async engine running the program. If code calls it outside that runtime, cache operations become safe no-ops: reads find nothing, writes do not persist, and “get or insert” simply computes the value without storing it. This avoids panics or unsafe blocking in the wrong context.

The file also provides direct cache access for advanced callers, plus a sha1_digest helper. That helper turns raw bytes into a fixed 20-byte SHA-1 digest, useful when the program wants cache keys based on file contents rather than just names or paths.

#### Function details

##### `BlockingLruCache::new`  (lines 23–27)

```
fn new(capacity: NonZeroUsize) -> Self
```

**Purpose**: Creates a new cache with a fixed, non-zero size limit. Someone uses this when they want to remember only the most recent items and automatically evict older ones when the cache fills up.

**Data flow**: It receives a capacity value that is guaranteed not to be zero. It builds an LRU cache of that size, wraps it in a Tokio mutex so only one task can edit it at a time, and returns the ready-to-use BlockingLruCache.

**Call relations**: The tests call this to create small caches before checking storage, retrieval, eviction, and behavior outside a Tokio runtime. Internally it relies on the external LRU cache and mutex constructors to build the two parts of the cache.

*Call graph*: called by 3 (disabled_without_runtime, evicts_least_recently_used, stores_and_retrieves_values); 2 external calls (new, new).


##### `BlockingLruCache::get_or_insert_with`  (lines 30–44)

```
fn get_or_insert_with(&self, key: K, value: impl FnOnce() -> V) -> V
```

**Purpose**: Looks up a key and returns its cached value if present; otherwise it computes the value, stores it, and returns it. This is useful when making a value is expensive and the program should avoid doing the work twice.

**Data flow**: It receives a key and a one-time value-making function. If a Tokio runtime is available, it locks the cache, checks for the key, returns a clone of the stored value if found, or computes and stores a new value if not found. If no runtime is available, it skips the cache and just computes the value.

**Call relations**: This function depends on lock_if_runtime to decide whether real cache access is safe. In the normal cache path it keeps ownership of one copy inside the cache and returns another copy to the caller; outside Tokio it behaves like a plain function call with no memory.

*Call graph*: calls 1 internal fn (lock_if_runtime).


##### `BlockingLruCache::get_or_try_insert_with`  (lines 47–64)

```
fn get_or_try_insert_with(
        &self,
        key: K,
        value: impl FnOnce() -> Result<V, E>,
    ) -> Result<V, E>
```

**Purpose**: Like get_or_insert_with, but for value-making work that can fail. It returns either the cached or newly computed value, or passes the error back to the caller.

**Data flow**: It receives a key and a function that returns either a value or an error. With a Tokio runtime, it locks the cache, returns a cloned cached value if available, or runs the function and stores the successful result. If the function fails, nothing is inserted and the error comes out. Without a runtime, it just runs the function and returns its result.

**Call relations**: It uses lock_if_runtime for the same safe-access gate as the other cache methods. It fits the bigger flow wherever callers want caching but also need to preserve errors from loading, parsing, or computing data.

*Call graph*: calls 1 internal fn (lock_if_runtime).


##### `BlockingLruCache::try_with_capacity`  (lines 68–70)

```
fn try_with_capacity(capacity: usize) -> Option<Self>
```

**Purpose**: Builds a cache only if the requested capacity is greater than zero. This gives callers an easy way to treat zero as “caching disabled.”

**Data flow**: It receives a plain usize capacity. If the number is zero, it returns None. If it is non-zero, it converts it to a non-zero capacity and returns a newly created BlockingLruCache.

**Call relations**: This is a convenience constructor that leads into BlockingLruCache::new when caching should exist. It avoids making every caller separately check whether a zero-sized cache is valid.

*Call graph*: 1 external calls (new).


##### `BlockingLruCache::get`  (lines 73–81)

```
fn get(&self, key: &Q) -> Option<V>
```

**Purpose**: Returns a clone of a stored value for a key, if that key is currently in the cache. Reading also marks the item as recently used, which helps it avoid eviction.

**Data flow**: It receives a borrowed key, meaning the caller does not have to give up ownership of a key object. If a Tokio runtime is available, it locks the cache, looks up the entry, clones the value, and returns it. If there is no runtime or no entry, it returns None.

**Call relations**: It asks lock_if_runtime for safe access before touching the shared cache. The tests use it to prove that inserted values can be read, that least-recently-used ordering changes after a read, and that no stored value appears outside a Tokio runtime.

*Call graph*: calls 1 internal fn (lock_if_runtime).


##### `BlockingLruCache::insert`  (lines 84–87)

```
fn insert(&self, key: K, value: V) -> Option<V>
```

**Purpose**: Stores a value under a key and returns the old value if that key was already present. This is the direct “put this in the cache” operation.

**Data flow**: It receives an owned key and value. If a Tokio runtime is available, it locks the cache and inserts the pair, possibly evicting the least recently used item if the cache is full. It returns any previous value for the same key. Without a runtime, it stores nothing and returns None.

**Call relations**: It uses lock_if_runtime to avoid touching the mutex outside the right async environment. The tests call it before get operations and before eviction checks to show how the cache changes as items are added.

*Call graph*: calls 1 internal fn (lock_if_runtime).


##### `BlockingLruCache::remove`  (lines 90–97)

```
fn remove(&self, key: &Q) -> Option<V>
```

**Purpose**: Deletes a cached entry for a key and returns the removed value if it existed. Callers use this when a cached answer is no longer valid.

**Data flow**: It receives a borrowed key. If a Tokio runtime is available, it locks the cache, removes the matching entry, and returns the removed value. If no runtime is available, or the key is absent, it returns None.

**Call relations**: It follows the same safe-lock pattern through lock_if_runtime. The outside-runtime test calls it to confirm that removal is also harmless and does not pretend anything was stored.

*Call graph*: calls 1 internal fn (lock_if_runtime).


##### `BlockingLruCache::clear`  (lines 100–104)

```
fn clear(&self)
```

**Purpose**: Empties the whole cache. This is useful when all remembered answers should be forgotten, for example after a broad configuration or data change.

**Data flow**: It takes no key or value. If a Tokio runtime is available, it locks the cache and removes every entry. If no runtime is available, it does nothing.

**Call relations**: It uses lock_if_runtime before clearing shared state. The outside-runtime test calls it to confirm that clearing is safe even when the cache is effectively disabled.

*Call graph*: calls 1 internal fn (lock_if_runtime).


##### `BlockingLruCache::with_mut`  (lines 107–114)

```
fn with_mut(&self, callback: impl FnOnce(&mut LruCache<K, V>) -> R) -> R
```

**Purpose**: Lets a caller run custom code against the underlying LRU cache. This is for cases where the simple get, insert, and remove operations are not enough.

**Data flow**: It receives a callback function. If a Tokio runtime is available, it locks the real cache and gives the callback mutable access to it. If no runtime is available, it creates a temporary unbounded cache, passes that to the callback, returns the callback’s result, and then discards the temporary cache.

**Call relations**: It relies on lock_if_runtime for the real-cache path and uses an external unbounded LRU cache as a throwaway stand-in outside Tokio. The test for disabled caching uses this to show that the callback can still run, but anything placed in the temporary cache does not persist afterward.

*Call graph*: calls 1 internal fn (lock_if_runtime); 1 external calls (unbounded).


##### `BlockingLruCache::blocking_lock`  (lines 117–119)

```
fn blocking_lock(&self) -> Option<MutexGuard<'_, LruCache<K, V>>>
```

**Purpose**: Gives advanced callers direct locked access to the internal LRU cache, but only when that is safe inside a Tokio runtime. Most code should use the simpler methods instead.

**Data flow**: It takes the cache itself as input. It asks for a runtime-aware lock; if successful, it returns a guard object, which is the locked access token for the cache. If no Tokio runtime is present, it returns None.

**Call relations**: This is a thin public wrapper around lock_if_runtime. The outside-runtime test checks that it returns None when there is no Tokio runtime, matching the file’s no-op behavior.

*Call graph*: calls 1 internal fn (lock_if_runtime).


##### `lock_if_runtime`  (lines 122–128)

```
fn lock_if_runtime(m: &Mutex<LruCache<K, V>>) -> Option<MutexGuard<'_, LruCache<K, V>>>
```

**Purpose**: Checks whether the code is currently running inside Tokio, and only then locks the cache. This is the safety gate that makes all cache operations become no-ops outside the async runtime.

**Data flow**: It receives a reference to the mutex-protected LRU cache. It first asks Tokio whether a current runtime exists. If not, it returns None. If yes, it uses Tokio’s block_in_place helper to take a blocking lock without disrupting the async runtime, then returns the lock guard.

**Call relations**: All cache operations that need to read or change stored data call this helper first. It centralizes the important rule: no Tokio runtime means no real cache access; Tokio runtime means the caller gets safe exclusive access.

*Call graph*: called by 8 (blocking_lock, clear, get, get_or_insert_with, get_or_try_insert_with, insert, remove, with_mut); 2 external calls (try_current, block_in_place).


##### `sha1_digest`  (lines 135–142)

```
fn sha1_digest(bytes: &[u8]) -> [u8; 20]
```

**Purpose**: Computes a SHA-1 digest, a fixed-size fingerprint, for a slice of bytes. This is useful for cache keys based on content, so changed content gets a different key even if a path or name stays the same.

**Data flow**: It receives raw bytes. It feeds them into a SHA-1 hasher, finalizes the hash, copies the resulting 20 bytes into a fixed-size array, and returns that array.

**Call relations**: This helper is independent of BlockingLruCache. It supports cache users that need stable content-based keys rather than relying on less reliable identifiers such as file paths.

*Call graph*: 1 external calls (new).


##### `tests::stores_and_retrieves_values`  (lines 150–156)

```
async fn stores_and_retrieves_values()
```

**Purpose**: Checks the basic promise of the cache: after storing a value, reading the same key should return it. This protects against regressions in the simplest use case.

**Data flow**: It creates a cache with room for two entries, checks that a missing key returns nothing, inserts one value, and then checks that the same key returns that value.

**Call relations**: This test calls BlockingLruCache::new to build the cache and then exercises the public get and insert behavior. It runs inside a Tokio runtime, so it verifies the real caching path rather than the disabled fallback.

*Call graph*: calls 1 internal fn (new); 3 external calls (new, assert!, assert_eq!).


##### `tests::evicts_least_recently_used`  (lines 159–170)

```
async fn evicts_least_recently_used()
```

**Purpose**: Checks that the cache evicts the least recently used item when it becomes full. This confirms the main reason to use an LRU cache instead of an ordinary map.

**Data flow**: It creates a two-entry cache, inserts two values, reads one of them to mark it as recently used, then inserts a third value. After that, it checks that the untouched older value was removed while the recently used and newly inserted values remain.

**Call relations**: This test calls BlockingLruCache::new and then uses insert and get to drive the eviction behavior. It demonstrates how reading an item affects which entry is considered safe to discard next.

*Call graph*: calls 1 internal fn (new); 3 external calls (new, assert!, assert_eq!).


##### `tests::disabled_without_runtime`  (lines 173–192)

```
fn disabled_without_runtime()
```

**Purpose**: Checks the file’s special fallback behavior outside Tokio: cache operations should not crash, but they also should not store lasting data. This is important for code that may run in plain synchronous tests or setup paths.

**Data flow**: It creates a cache without starting a Tokio runtime, tries inserting, reading, computing, removing, clearing, using with_mut, and taking a direct lock. The observed result is that normal cache storage does not persist, computed values are still returned directly, temporary with_mut changes disappear, and direct locking is unavailable.

**Call relations**: This test calls BlockingLruCache::new and exercises the public methods that depend on lock_if_runtime. It proves that the helper’s “no runtime means no real cache” rule is consistently followed.

*Call graph*: calls 1 internal fn (new); 3 external calls (new, assert!, assert_eq!).


### Sandbox summaries and V8 probe
These files package human-readable sandbox/config summaries and a small proof-of-concept crate for validating V8 linkage and behavior.

### `utils/sandbox-summary/src/lib.rs`

`orchestration` · `cross-cutting`

This file does not contain the actual summary logic itself. Instead, it works like the front desk of a small office: it knows which rooms exist, and it makes the important services easy to ask for. The two internal modules, `config_summary` and `sandbox_summary`, contain the real code for turning configuration and sandbox policy information into readable summaries. This file declares those modules and then re-exports selected functions from them, meaning outside code can import these functions directly from the crate instead of reaching into the internal module names.

That matters because it gives the library a clean public face. If other parts of the project need to summarize a permission profile, a sandbox policy, or configuration entries, they can call the exported functions from one stable place. The internal organization can later change without forcing every caller to update its imports, as long as this public doorway keeps offering the same names.

There are no functions defined in this file. Its job is structural: it connects the outside world to the useful summary functions implemented elsewhere.


### `utils/sandbox-summary/src/config_summary.rs`

`config` · `config reporting`

This file exists so the sandbox summary tool can explain its setup in plain, compact terms. A configuration object can contain many nested settings, and some of those settings are not immediately friendly to display. This code picks out the most important ones and formats them as simple labels and strings, like a small receipt for the current run.

The summary always includes the working directory, the model name, the model provider, the approval policy, and the sandbox policy. The sandbox policy is passed to another helper, `summarize_sandbox_policy`, which turns the detailed sandbox rules into a human-readable description. That matters because sandboxing is about what the tool is allowed to read, write, or run; without a clear summary, a user might misunderstand what is protected.

There is one conditional detail. If the selected model provider uses the “Responses” wire API — meaning a particular way of talking to the model service over the network — the summary also includes reasoning-related settings. If those settings are absent, it prints `none` rather than leaving the reader guessing.

In short, this file is the translation layer between internal configuration data and a clear status display.

#### Function details

##### `create_config_summary_entries`  (lines 7–44)

```
fn create_config_summary_entries(config: &Config, model: &str) -> Vec<(&'static str, String)>
```

**Purpose**: Builds a list of readable configuration entries for display. Someone would use it when they need to show the user what working directory, model, provider, approval mode, sandbox mode, and optional reasoning settings are in effect.

**Data flow**: It receives a `Config` object and a model name string. It reads selected fields from the configuration, converts them into plain strings, asks `summarize_sandbox_policy` to describe the sandbox rules, and returns a list of label/value pairs. It does not change the configuration; it only reads and formats it.

**Call relations**: This function is the point where the summary list is assembled. It creates the list directly, using Rust’s vector-building macro, and hands sandbox details to `summarize_sandbox_policy` so that policy-specific wording stays in the sandbox summary code. Callers can then print or otherwise display the returned entries as the user-facing configuration summary.

*Call graph*: 1 external calls (vec!).


### `utils/sandbox-summary/src/sandbox_summary.rs`

`util` · `cross-cutting`

A sandbox is a safety boundary: it decides what files a process may write and whether it may use the network. Those settings are important, but the raw internal data can be too detailed or technical to show directly. This file acts like a label maker. It reads the sandbox or permission setup and produces a compact summary such as “read-only”, “workspace-write [workdir, /tmp]”, or “danger-full-access”.

The main function, summarize_sandbox_policy, works directly from a SandboxPolicy. It names the broad mode first, then adds important details. For workspace-write mode, it lists the places that can be written to: the current work directory, temporary directories if allowed, and any extra writable roots. If network access is enabled, it adds that as a visible suffix.

The second function, summarize_permission_profile, starts from a newer PermissionProfile. It tries to translate that profile into the older sandbox-policy shape so it can reuse the same summary style. For workspace-write profiles, it deliberately uses the runtime workspace roots passed in by the caller, rather than exposing internal writable paths. If the profile is too custom to summarize as a known policy, it falls back to “custom permissions”, with a network note if needed.

The tests make sure these summaries stay clear and accurate, especially around network access and writable workspace roots.

#### Function details

##### `summarize_sandbox_policy`  (lines 6–52)

```
fn summarize_sandbox_policy(sandbox_policy: &SandboxPolicy) -> String
```

**Purpose**: Turns a SandboxPolicy into a short display string that a person can understand. It explains the access level and, when needed, shows which locations are writable and whether network access is allowed.

**Data flow**: It receives one sandbox policy. It looks at which kind of policy it is: full access, read-only, external sandbox, or workspace-write. It builds a string from that choice, adds writable locations for workspace-write, and appends “network access enabled” when the policy allows network use. The result is a plain text summary; it does not change the policy.

**Call relations**: This is the basic formatter that other code can call when it already has a SandboxPolicy. summarize_permission_profile uses it after converting a permission profile into a legacy sandbox policy. The test functions call it directly to check that each important sandbox mode produces the expected wording.

*Call graph*: called by 5 (summarize_permission_profile, summarizes_external_sandbox_with_enabled_network, summarizes_external_sandbox_without_network_access_suffix, summarizes_read_only_with_enabled_network, workspace_write_summary_still_includes_network_access); 3 external calls (new, format!, matches!).


##### `summarize_permission_profile`  (lines 54–96)

```
fn summarize_permission_profile(
    permission_profile: &PermissionProfile,
    cwd: &AbsolutePathBuf,
    workspace_roots: &[AbsolutePathBuf],
) -> String
```

**Purpose**: Turns a PermissionProfile into a user-facing summary. It exists because permission profiles may contain richer or newer permission rules than the older SandboxPolicy type, but users still need a simple explanation.

**Data flow**: It receives a permission profile, the current working directory, and the known workspace roots. First it asks the profile to convert itself into an older sandbox policy using the current directory. If that works and the result is workspace-write, it builds a summary using the visible workspace roots supplied at runtime, while still showing temporary-directory and network access rules. If the converted policy is another known kind, it passes it to summarize_sandbox_policy. If conversion fails, it returns “custom permissions”, adding a network-access note if the profile says networking is enabled.

**Call relations**: This function sits one level above summarize_sandbox_policy. It is used when the caller has a PermissionProfile rather than a plain SandboxPolicy. The test permission_profile_summary_uses_runtime_workspace_roots_and_hides_internal_writes calls it to confirm that user-visible workspace roots are shown and internal writable paths are not exposed.

*Call graph*: calls 4 internal fn (network_sandbox_policy, to_legacy_sandbox_policy, as_path, summarize_sandbox_policy); called by 1 (permission_profile_summary_uses_runtime_workspace_roots_and_hides_internal_writes); 3 external calls (format!, iter, vec!).


##### `tests::summarizes_external_sandbox_without_network_access_suffix`  (lines 106–111)

```
fn summarizes_external_sandbox_without_network_access_suffix()
```

**Purpose**: Checks that an external sandbox with restricted network access is summarized simply as “external-sandbox”. This protects against accidentally implying that network access is available when it is not.

**Data flow**: It creates an ExternalSandbox policy with restricted network access, sends it into summarize_sandbox_policy, and compares the returned text with the expected string. Nothing outside the test is changed.

**Call relations**: This test exercises summarize_sandbox_policy for the external-sandbox path where networking is not enabled. It uses an equality assertion to lock in the exact user-facing wording.

*Call graph*: calls 1 internal fn (summarize_sandbox_policy); 1 external calls (assert_eq!).


##### `tests::summarizes_external_sandbox_with_enabled_network`  (lines 114–119)

```
fn summarizes_external_sandbox_with_enabled_network()
```

**Purpose**: Checks that an external sandbox clearly says when network access is enabled. This matters because network access is a major safety and privacy detail for users.

**Data flow**: It creates an ExternalSandbox policy with enabled network access, passes it to summarize_sandbox_policy, and verifies that the returned text includes the network-access suffix.

**Call relations**: This test covers the enabled-network branch inside summarize_sandbox_policy for external sandboxes. It makes sure the summary does not hide a meaningful permission.

*Call graph*: calls 1 internal fn (summarize_sandbox_policy); 1 external calls (assert_eq!).


##### `tests::summarizes_read_only_with_enabled_network`  (lines 122–127)

```
fn summarizes_read_only_with_enabled_network()
```

**Purpose**: Checks that read-only file access can still be reported together with enabled network access. The two permissions are separate, so the summary must mention both when needed.

**Data flow**: It builds a read-only sandbox policy with network access set to true, formats it with summarize_sandbox_policy, and compares the result to the expected text.

**Call relations**: This test calls summarize_sandbox_policy for the read-only branch. It protects the behavior where file restrictions and network permission are both visible in the same summary.

*Call graph*: calls 1 internal fn (summarize_sandbox_policy); 1 external calls (assert_eq!).


##### `tests::workspace_write_summary_still_includes_network_access`  (lines 130–146)

```
fn workspace_write_summary_still_includes_network_access()
```

**Purpose**: Checks that workspace-write summaries still show network access when it is enabled. It also verifies that extra writable roots are included in the displayed list.

**Data flow**: It chooses a platform-appropriate path, turns it into an absolute path value, and creates a workspace-write policy that allows that root and network access while excluding temporary directories. It then formats the policy and checks that the output lists the work directory, the extra writable root, and the network-access suffix.

**Call relations**: This test exercises the workspace-write branch of summarize_sandbox_policy. It uses platform-aware path setup because Windows and Unix-like systems write absolute paths differently.

*Call graph*: calls 2 internal fn (try_from, summarize_sandbox_policy); 3 external calls (assert_eq!, cfg!, vec!).


##### `tests::permission_profile_summary_uses_runtime_workspace_roots_and_hides_internal_writes`  (lines 149–181)

```
fn permission_profile_summary_uses_runtime_workspace_roots_and_hides_internal_writes()
```

**Purpose**: Checks that permission-profile summaries show the workspace roots the user should care about, not internal writable paths used by the application. This keeps the summary useful and avoids confusing users with hidden implementation details.

**Data flow**: It creates a current directory, an extra workspace root, and an internal hidden root. It builds a workspace-write permission profile that includes the hidden root internally, then asks summarize_permission_profile to summarize it using only the current directory and extra workspace root as runtime workspace roots. The expected output includes the work directory, temporary locations, and the extra workspace root, but not the hidden internal root.

**Call relations**: This test calls summarize_permission_profile, which in turn may convert the permission profile and format the result. The test confirms the higher-level behavior that distinguishes user-facing workspace roots from internal write allowances.

*Call graph*: calls 3 internal fn (workspace_write_with, try_from, summarize_permission_profile); 3 external calls (assert_eq!, cfg!, from_ref).


### `v8-poc/src/lib.rs`

`domain_logic` · `cross-cutting; public probes during use, deeper checks during tests`

This crate is like a smoke test for future V8 work. V8 is the engine that runs JavaScript in Chrome and Node.js, and linking it into a Rust project can be delicate because it depends on the right native library, build flags, and initialization steps. This file gives the rest of the project a few simple ways to ask, “Which target is this?”, “Which V8 version did we link?”, and “Was V8 built with its sandbox enabled?” The sandbox is an extra safety boundary inside V8 that helps isolate risky memory behavior.

The public functions are intentionally tiny. One returns the Bazel build label for this crate. One asks V8 for its embedded version string. One calls a low-level V8 symbol to check whether the linked library has sandbox support.

Most of the file is test code. The tests initialize V8 once, create a fresh JavaScript execution environment, run small expressions, and check the results. They also verify that V8’s Chrome DevTools Protocol helper can parse a dispatchable message. Without this file, the project would have less confidence that its Bazel wiring, Rust-to-V8 binding, sandbox feature flag, and basic script execution are all aligned.

#### Function details

##### `bazel_target`  (lines 5–7)

```
fn bazel_target() -> &'static str
```

**Purpose**: Returns the Bazel build label for this proof-of-concept crate. This is a simple identity check so other code or tests can confirm they are referring to the expected target.

**Data flow**: It takes no input. It returns the fixed text string "//codex-rs/v8-poc:v8-poc" and does not change anything.

**Call relations**: This is a public library function and is checked by the test `tests::exposes_expected_bazel_target`. It does not hand work off to anything else because the answer is a fixed label.


##### `embedded_v8_version`  (lines 11–13)

```
fn embedded_v8_version() -> &'static str
```

**Purpose**: Asks the linked V8 library what version it is. This helps confirm that Rust is talking to a real V8 build and can report which one.

**Data flow**: It takes no input. It calls V8’s version lookup function, receives a version string from the linked V8 library, and returns that string to the caller.

**Call relations**: This public function delegates directly to V8 through `get_version`. The test `tests::exposes_embedded_v8_version` uses it to make sure the version is present rather than empty.

*Call graph*: 1 external calls (get_version).


##### `linked_v8_has_sandbox`  (lines 17–24)

```
fn linked_v8_has_sandbox() -> bool
```

**Purpose**: Checks whether the linked V8 library was built with V8’s in-process sandbox enabled. This matters because the Rust feature setting and the actual native V8 build need to agree.

**Data flow**: It takes no input. It calls a low-level external V8 symbol, receives a true-or-false answer, and returns that answer. Because this crosses into native code directly, the call is marked unsafe in Rust.

**Call relations**: The test `tests::sandbox_feature_matches_linked_v8` compares this runtime answer with Rust’s compile-time `sandbox` feature flag. That makes sure the project did not accidentally compile Rust one way while linking a differently configured V8 library.


##### `tests::initialize_v8`  (lines 33–40)

```
fn initialize_v8()
```

**Purpose**: Starts V8 for the test process, but only once. V8 needs global setup before JavaScript can run, and repeating that setup can be unsafe or wasteful.

**Data flow**: It takes no input. It uses a one-time lock-like helper called `Once` to run V8 platform creation and V8 initialization a single time, even if several tests ask for it. It returns nothing, but after it runs V8 is ready for test code.

**Call relations**: This is a test helper used before evaluating JavaScript. `tests::evaluate_expression` calls on it so each expression test can safely assume V8 has already been prepared.

*Call graph*: 1 external calls (new).


##### `tests::evaluate_expression`  (lines 42–55)

```
fn evaluate_expression(expression: &str) -> String
```

**Purpose**: Runs a small JavaScript expression in V8 during tests and returns the result as a Rust string. It lets the tests prove that V8 is not merely linked, but actually able to execute code.

**Data flow**: It receives a JavaScript expression as text. It first makes sure V8 is initialized, then creates an isolate, which is V8’s separate execution space, and a context, which is like a fresh global environment for the script. It turns the input text into a V8 string, compiles it as JavaScript, runs it, converts the result back into a Rust string, and returns that string.

**Call relations**: The expression-based tests call this helper with examples like integer addition and string concatenation. Inside, it hands work to V8 constructors, the V8 scope macro, and the script compiler so the tests can stay short and focused on expected results.

*Call graph*: 8 external calls (default, initialize_v8, new, new, new, compile, new, scope!).


##### `tests::exposes_expected_bazel_target`  (lines 58–60)

```
fn exposes_expected_bazel_target()
```

**Purpose**: Checks that the crate reports the exact Bazel target label expected by the build setup.

**Data flow**: It takes no input. It calls `bazel_target`, compares the returned string with the known expected label, and fails the test if they differ.

**Call relations**: This test is the direct safety check for `bazel_target`. It uses an equality assertion to catch accidental renames or wrong build-label wiring.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::exposes_embedded_v8_version`  (lines 63–65)

```
fn exposes_embedded_v8_version()
```

**Purpose**: Checks that the linked V8 library can report a non-empty version string.

**Data flow**: It takes no input. It calls `embedded_v8_version`, checks whether the returned string has content, and fails the test if the string is empty.

**Call relations**: This test exercises the public version probe. By relying on V8’s version call, it gives a quick sign that the Rust binding can reach the linked V8 library.

*Call graph*: 1 external calls (assert!).


##### `tests::sandbox_feature_matches_linked_v8`  (lines 68–70)

```
fn sandbox_feature_matches_linked_v8()
```

**Purpose**: Checks that the Rust feature flag for V8 sandboxing matches the actual V8 library that was linked.

**Data flow**: It takes no input. It calls `linked_v8_has_sandbox`, compares that true-or-false result with whether Rust was compiled with the `sandbox` feature, and fails if the two do not match.

**Call relations**: This test protects against a build mismatch. It uses `linked_v8_has_sandbox` as the runtime truth from V8 and compares it with Rust’s compile-time configuration.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::evaluates_integer_addition`  (lines 73–75)

```
fn evaluates_integer_addition()
```

**Purpose**: Checks that V8 can evaluate a basic arithmetic expression.

**Data flow**: It gives the text `1 + 2` to `tests::evaluate_expression`. It receives the result as text and asserts that the answer is `3`.

**Call relations**: This test depends on `tests::evaluate_expression` to do the V8 setup, compilation, execution, and result conversion. It is a simple end-to-end proof that JavaScript execution works.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::evaluates_string_concatenation`  (lines 78–80)

```
fn evaluates_string_concatenation()
```

**Purpose**: Checks that V8 can evaluate a basic string expression.

**Data flow**: It gives the JavaScript text `'hello ' + 'world'` to `tests::evaluate_expression`. It receives the result as text and asserts that the answer is `hello world`.

**Call relations**: Like the integer test, this uses `tests::evaluate_expression` as the shared path into V8. It proves the test setup works for more than just numbers.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::parses_crdtp_dispatchable_messages`  (lines 83–91)

```
fn parses_crdtp_dispatchable_messages()
```

**Purpose**: Checks that V8’s Chrome DevTools Protocol helper can parse a simple message. The Chrome DevTools Protocol is the message format used to talk to and inspect JavaScript runtimes.

**Data flow**: It starts with a JSON message containing an id, a method name, and empty parameters. It asks V8’s protocol helper to convert that JSON into CBOR, a compact binary data format, then wraps the binary message as a dispatchable message. It checks that parsing succeeded, that the call id is 7, and that the method name is `Runtime.evaluate`.

**Call relations**: This test hands the raw JSON to `json_to_cbor`, then gives the binary result to `Dispatchable::new`. The assertions confirm that V8’s protocol parsing path can understand the message well enough to dispatch it.

*Call graph*: 4 external calls (assert!, assert_eq!, new, json_to_cbor).
