# Async primitives, image handling, and miscellaneous small support libraries  `stage-22.5`

This stage is shared behind-the-scenes support. It is a box of small tools that other parts of the system rely on during normal work, rather than one big feature on its own.

Several pieces deal with images. The image utility crate reads images from raw bytes or data URLs, resizes and re-encodes them safely, caches them by content, and reports clear image errors. Image-preparation uses that to shrink inline chat images so later prompt-building code does not get overloaded, or swaps bad images for explanatory text. The image-detail helpers decide when a model may ask for the untouched original image. In the terminal UI, pet sprite sheets are split into per-frame PNG files, cached, and then turned into terminal-specific output. The protocol layer picks Kitty or Sixel, and the Sixel encoder produces compact text-based image data.

Other helpers keep the app steady. Async utilities support cancellation, readiness waiting, and timeout budgets. Sleep-inhibitor prevents the computer from dozing off during active work on Linux, macOS, or Windows, with a dummy fallback. Small libraries also handle runtime value conversion, replay filtering, frame-rate limiting, lightweight caching, and human-readable sandbox summaries.

## Files in this stage

### Terminal pet image rendering
These files prepare cached pet animation frames and choose or encode the terminal image protocol payloads used to display them.

### `tui/src/pets/frames.rs`

`io_transport` · `pet load / frame-cache preparation before rendering`

This module performs one concrete job: given a loaded `Pet` and a target frame directory, ensure there is a numbered PNG file for every sprite in the pet’s frame grid. `prepare_png_frames` first creates the frame directory, then computes the full expected output list as `frame_000.png`, `frame_001.png`, and so on up to `pet.frame_count() - 1`. If every expected file already exists, it returns that list immediately and avoids reopening the spritesheet.

When the cache is incomplete, the function aggressively cleans up stale frame files matching the `frame_*.png` naming convention before regenerating everything. It opens the spritesheet image once, then iterates row-major over `pet.rows` and `pet.columns`, computing each frame index with checked arithmetic to catch overflow, converting the index to `usize`, and looking up the corresponding expected output path. For each cell it computes pixel offsets from `frame_width` and `frame_height`, takes a view into the spritesheet with `try_view`, converts that view into an owned image, and saves it as PNG. The helper `glob_frame_files` is intentionally narrow: it only returns files in the target directory whose names start with `frame_` and end with `.png`, leaving unrelated files untouched. The included test verifies that slicing happens entirely in-process without relying on external image tools.

#### Function details

##### `prepare_png_frames`  (lines 11–52)

```
fn prepare_png_frames(pet: &Pet, frame_dir: &Path) -> Result<Vec<PathBuf>>
```

**Purpose**: Ensures that a complete set of per-frame PNG files exists for the given pet and returns their paths in sprite-index order. It regenerates the entire cache when any expected frame is missing.

**Data flow**: Inputs are `pet: &Pet` and `frame_dir: &Path`. It creates `frame_dir`, builds the expected `Vec<PathBuf>` from `0..pet.frame_count()`, checks whether all expected files exist, and if not removes stale `frame_*.png` files from `glob_frame_files(frame_dir)`, opens `pet.spritesheet_path`, slices each grid cell using checked row/column/index/x/y arithmetic, saves each slice as PNG to the corresponding expected path, and finally returns the expected path vector.

**Call relations**: Called by `AmbientPet::load` during frame-cache preparation and by the unit test that verifies spritesheet slicing. It delegates stale-file discovery to `glob_frame_files`.

*Call graph*: calls 2 internal fn (glob_frame_files, frame_count); called by 2 (load, prepare_png_frames_slices_spritesheet_without_external_command); 4 external calls (create_dir_all, remove_file, open, try_from).


##### `glob_frame_files`  (lines 54–71)

```
fn glob_frame_files(frame_dir: &Path) -> Result<Vec<PathBuf>>
```

**Purpose**: Lists cached frame files in a directory using the module’s `frame_*.png` naming convention. It returns an empty list when the directory does not yet exist.

**Data flow**: Input is `frame_dir: &Path`. It checks `frame_dir.exists()`, returns `Ok(Vec::new())` if absent, otherwise reads directory entries, converts each entry to a path, filters by filename prefix `frame_` and suffix `.png`, collects matching paths into a `Vec<PathBuf>`, and returns it.

**Call relations**: Used only by `prepare_png_frames` to remove stale cached frame files before regenerating a complete set.

*Call graph*: called by 1 (prepare_png_frames); 3 external calls (exists, new, read_dir).


##### `tests::prepare_png_frames_slices_spritesheet_without_external_command`  (lines 83–115)

```
fn prepare_png_frames_slices_spritesheet_without_external_command()
```

**Purpose**: Verifies that frame extraction slices a tiny spritesheet into separate PNG files entirely within Rust code. It guards against regressions that would require external image-processing commands.

**Data flow**: It creates a temporary directory, writes a 2×1 test spritesheet with distinct pixel colors, constructs a minimal `Pet` describing two 1×1 frames, calls `prepare_png_frames`, and asserts that the returned vector has length 2 and both output files exist.

**Call relations**: This test directly exercises `prepare_png_frames` end-to-end with a synthetic in-memory image fixture.

*Call graph*: calls 1 internal fn (prepare_png_frames); 6 external calls (new, from_fn, new, assert!, assert_eq!, tempdir).


### `tui/src/pets/image_protocol.rs`

`io_transport` · `startup capability detection and per-frame image payload generation during rendering`

This module combines capability detection with protocol-specific serialization. The detection side revolves around `PetImageSupport`, `PetImageUnsupportedReason`, and `ProtocolSelection`. `ProtocolSelection::Auto` probes the environment and terminal metadata, explicitly disabling pets inside tmux or Zellij before considering image support. It prefers direct Kitty support when `KITTY_WINDOW_ID` or WezTerm environment variables are present, otherwise inspects `TerminalInfo`: iTerm2 3.6+ gets `KittyLocalFile`, older iTerm2 is rejected with a dedicated upgrade message, known Kitty-family terminals get `Kitty`, known sixel terminals get `Sixel`, and everything else is unsupported. Helper functions normalize case-insensitive terminal-field matching and parse dotted versions conservatively.

The rendering side emits escape sequences rather than drawing directly. Kitty support includes deletion commands, inline PNG transmission with base64 chunking (`KITTY_CHUNK_SIZE` 4096), and local-file transmission for terminals like modern iTerm2 that support Kitty graphics via file references. All Kitty commands are optionally wrapped in tmux passthrough sequences by doubling ESC bytes when `TMUX` is set. Sixel support is file-based: `sixel_frame` creates a versioned cached `.six` file under a caller-provided cache directory, resizing the source PNG to the requested pixel height with Lanczos3 filtering, preserving aspect ratio, encoding RGBA bytes through the local `sixel` encoder, and reusing the cached file if it already exists. The extensive tests lock down environment precedence, terminal heuristics, version parsing, tmux wrapping, and both Kitty and Sixel payload formats.

#### Function details

##### `PetImageSupport::protocol`  (lines 40–45)

```
fn protocol(self) -> Option<ImageProtocol>
```

**Purpose**: Extracts the usable `ImageProtocol` from a support verdict, if one exists. It collapses the richer supported/unsupported enum into a simple optional protocol.

**Data flow**: It takes `self: PetImageSupport` and returns `Some(protocol)` for `Supported(protocol)` or `None` for `Unsupported(_)`. No external state is read.

**Call relations**: Used by ambient rendering code to gate drawing and scheduling without caring about the specific unsupported reason.

*Call graph*: called by 4 (draw_request, image_enabled, next_frame_delay, preview_draw_request).


##### `PetImageSupport::unsupported_message`  (lines 47–52)

```
fn unsupported_message(self) -> Option<&'static str>
```

**Purpose**: Returns a human-readable explanation when pets are unavailable in the current environment. Supported states yield no message.

**Data flow**: It matches on `self`, returning `None` for `Supported(_)` and `Some(reason.message())` for `Unsupported(reason)`.

**Call relations**: This is the presentation helper for callers that need to surface why pet images are disabled.


##### `PetImageUnsupportedReason::message`  (lines 64–79)

```
fn message(self) -> &'static str
```

**Purpose**: Maps each unsupported reason to a detailed user-facing explanation string. The messages emphasize pane-locality and upgrade requirements where relevant.

**Data flow**: Input is the enum variant; output is a static explanatory string for `Tmux`, `Zellij`, `Iterm2TooOld`, or generic `Terminal` lack of support.

**Call relations**: Used by `PetImageSupport::unsupported_message` to expose the reason text.


##### `ProtocolSelection::resolve`  (lines 90–96)

```
fn resolve(self) -> PetImageSupport
```

**Purpose**: Turns a configured protocol selection into an actual support verdict. Explicit selections bypass auto-detection safety checks, while `Auto` performs environment and terminal probing.

**Data flow**: It takes `self: ProtocolSelection` and returns `PetImageSupport::Supported(ImageProtocol::Kitty)` for `Kitty`, `Supported(Sixel)` for `Sixel`, or the result of `detect_pet_image_support()` for `Auto`.

**Call relations**: Used when constructing ambient pet state or parsing user configuration. It delegates only the auto branch to `detect_pet_image_support`.

*Call graph*: calls 1 internal fn (detect_pet_image_support); 1 external calls (Supported).


##### `ProtocolSelection::from_str`  (lines 102–109)

```
fn from_str(value: &str) -> Result<Self>
```

**Purpose**: Parses textual protocol configuration values into the `ProtocolSelection` enum. Only `auto`, `kitty`, and `sixel` are accepted.

**Data flow**: Input is `value: &str`. It matches exact strings and returns the corresponding enum variant or an `anyhow` error describing the accepted values.

**Call relations**: This parser is used wherever protocol selection is read from text configuration or command input.

*Call graph*: 1 external calls (bail!).


##### `detect_pet_image_support`  (lines 112–133)

```
fn detect_pet_image_support() -> PetImageSupport
```

**Purpose**: Performs environment-first detection of whether ambient pet images can be used and which protocol should be preferred. It short-circuits on known multiplexer and terminal-specific environment variables before consulting generic terminal detection.

**Data flow**: It reads environment variables `TMUX`, `TMUX_PANE`, `ZELLIJ`, `ZELLIJ_SESSION_NAME`, `ZELLIJ_VERSION`, `KITTY_WINDOW_ID`, `WEZTERM_EXECUTABLE`, and `WEZTERM_VERSION`. Depending on those values it returns `Unsupported(Tmux)`, `Unsupported(Zellij)`, `Supported(Kitty)`, or delegates to `pet_image_support_for_terminal(&terminal_info())`.

**Call relations**: Called only from `ProtocolSelection::resolve` for the auto-detection path. It delegates the fallback heuristic to `pet_image_support_for_terminal`.

*Call graph*: calls 1 internal fn (pet_image_support_for_terminal); called by 1 (resolve); 4 external calls (terminal_info, var_os, Supported, Unsupported).


##### `pet_image_support_for_terminal`  (lines 135–163)

```
fn pet_image_support_for_terminal(info: &TerminalInfo) -> PetImageSupport
```

**Purpose**: Determines image support from a `TerminalInfo` snapshot, prioritizing multiplexer safety over terminal capabilities. It encodes the protocol preference order for non-env-based detection.

**Data flow**: Input is `&TerminalInfo`. It first checks `info.multiplexer` for tmux or Zellij and returns unsupported if present, then tests for modern iTerm2 Kitty file graphics, old iTerm2 rejection, generic Kitty graphics support, and Sixel support in that order, finally returning generic terminal unsupported if none match.

**Call relations**: Used by `detect_pet_image_support` after environment shortcuts. It delegates specific heuristics to `supports_iterm2_kitty_graphics`, `is_iterm2_terminal`, `supports_kitty_graphics`, and `supports_sixel`.

*Call graph*: calls 4 internal fn (is_iterm2_terminal, supports_iterm2_kitty_graphics, supports_kitty_graphics, supports_sixel); called by 1 (detect_pet_image_support); 2 external calls (Supported, Unsupported).


##### `supports_iterm2_kitty_graphics`  (lines 165–171)

```
fn supports_iterm2_kitty_graphics(info: &TerminalInfo) -> bool
```

**Purpose**: Checks whether a terminal is iTerm2 and new enough to support Kitty graphics via local-file references. The minimum accepted version is 3.6.0.

**Data flow**: Input is `&TerminalInfo`. It returns `true` only if `is_iterm2_terminal(info)` is true and `version_is_at_least(info.version.as_deref(), (3, 6, 0))` is also true.

**Call relations**: Called by `pet_image_support_for_terminal` before generic iTerm2 rejection so modern iTerm2 gets a supported protocol instead of an unsupported reason.

*Call graph*: calls 2 internal fn (is_iterm2_terminal, version_is_at_least); called by 1 (pet_image_support_for_terminal).


##### `is_iterm2_terminal`  (lines 173–176)

```
fn is_iterm2_terminal(info: &TerminalInfo) -> bool
```

**Purpose**: Recognizes iTerm2 terminals from structured terminal name or `TERM_PROGRAM` text. It is intentionally tolerant of incomplete terminal metadata.

**Data flow**: Input is `&TerminalInfo`. It returns true if `info.name` is `TerminalName::Iterm2` or if `info.term_program` contains `iterm` case-insensitively.

**Call relations**: Used by both `supports_iterm2_kitty_graphics` and `pet_image_support_for_terminal`.

*Call graph*: calls 1 internal fn (terminal_field_contains); called by 2 (pet_image_support_for_terminal, supports_iterm2_kitty_graphics); 1 external calls (matches!).


##### `supports_kitty_graphics`  (lines 178–188)

```
fn supports_kitty_graphics(info: &TerminalInfo) -> bool
```

**Purpose**: Heuristically detects terminals that should accept Kitty graphics commands. It checks both structured terminal names and lowercase substring matches in `TERM` and `TERM_PROGRAM`.

**Data flow**: Input is `&TerminalInfo`. It returns true for known names `Ghostty`, `Kitty`, or `WezTerm`, or when `term`/`term_program` contain `kitty`, `ghostty`, or `wezterm`.

**Call relations**: Called by `pet_image_support_for_terminal` after iTerm2-specific handling and before Sixel fallback.

*Call graph*: calls 1 internal fn (terminal_field_contains); called by 1 (pet_image_support_for_terminal); 1 external calls (matches!).


##### `supports_sixel`  (lines 190–195)

```
fn supports_sixel(info: &TerminalInfo) -> bool
```

**Purpose**: Heuristically detects terminals that should accept Sixel image data. It recognizes Windows Terminal and several `TERM` strings associated with sixel-capable terminals.

**Data flow**: Input is `&TerminalInfo`. It returns true if the terminal name is `WindowsTerminal` or if `term` contains `sixel`, `mlterm`, or `foot`.

**Call relations**: Used by `pet_image_support_for_terminal` as the final supported-protocol fallback after Kitty checks.

*Call graph*: calls 1 internal fn (terminal_field_contains); called by 1 (pet_image_support_for_terminal); 1 external calls (matches!).


##### `terminal_field_contains`  (lines 197–199)

```
fn terminal_field_contains(value: Option<&str>, needle: &str) -> bool
```

**Purpose**: Performs case-insensitive substring matching on optional terminal metadata fields. It centralizes the lowercase conversion and `Option` handling used by the detection heuristics.

**Data flow**: Inputs are `value: Option<&str>` and `needle: &str`. It lowercases the present value and returns whether it contains `needle`; absent values yield `false`.

**Call relations**: Shared helper for `is_iterm2_terminal`, `supports_kitty_graphics`, and `supports_sixel`.

*Call graph*: called by 3 (is_iterm2_terminal, supports_kitty_graphics, supports_sixel).


##### `version_is_at_least`  (lines 201–203)

```
fn version_is_at_least(version: Option<&str>, minimum: (u64, u64, u64)) -> bool
```

**Purpose**: Compares an optional dotted version string against a minimum semantic-ish tuple. Invalid or missing versions are treated as not meeting the minimum.

**Data flow**: Inputs are `version: Option<&str>` and `minimum: (u64, u64, u64)`. It parses the version with `parse_dotted_version` and returns whether the parsed tuple is greater than or equal to `minimum`.

**Call relations**: Used by `supports_iterm2_kitty_graphics` to enforce the iTerm2 3.6.0 minimum.

*Call graph*: calls 1 internal fn (parse_dotted_version); called by 1 (supports_iterm2_kitty_graphics).


##### `parse_dotted_version`  (lines 205–217)

```
fn parse_dotted_version(version: Option<&str>) -> Option<(u64, u64, u64)>
```

**Purpose**: Parses a simple `major[.minor[.patch]]` numeric version string into a three-part tuple. It rejects extra components and non-numeric segments.

**Data flow**: Input is `Option<&str>`. It returns `None` for absent input, otherwise splits on `.`, parses up to three numeric components with defaults of `0` for missing minor/patch, rejects any fourth component, and returns `Some((major, minor, patch))` on success.

**Call relations**: Called only by `version_is_at_least`; tests lock down its intentionally strict parsing behavior.

*Call graph*: called by 1 (version_is_at_least).


##### `kitty_delete_image`  (lines 219–221)

```
fn kitty_delete_image(image_id: u32) -> String
```

**Purpose**: Builds a Kitty graphics command that deletes a previously displayed image by image id. The command is tmux-wrapped when necessary.

**Data flow**: Input is `image_id: u32`. It formats the Kitty delete escape sequence using `ESC` and `ST`, passes it through `wrap_for_tmux_if_needed`, and returns the resulting `String`.

**Call relations**: Used by the pet rendering module whenever a Kitty-family image needs to be cleared before redraw or when no draw request is present.

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

**Purpose**: Encodes a PNG file’s bytes into one or more Kitty inline-transmission commands, optionally tagging the image with an id. It chunks the base64 payload to respect the configured chunk size.

**Data flow**: Inputs are `path`, terminal `columns`, terminal `rows`, and optional `image_id`. It reads the PNG bytes from disk, base64-encodes them, splits the encoded payload into 4096-byte chunks, emits a first Kitty command containing geometry and optional image id plus `m=<more_flag>`, emits continuation chunks as needed, wraps the concatenated command for tmux if required, and returns `Result<String>`.

**Call relations**: Called by `render_pet_image` for `ImageProtocol::Kitty` and by a unit test that verifies inline encoding.

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

**Purpose**: Builds a Kitty graphics command that references a local PNG file path instead of embedding the file contents inline. This is used for terminals such as modern iTerm2 that support Kitty file references.

**Data flow**: Inputs are `path`, `columns`, `rows`, and optional `image_id`. It canonicalizes the path, base64-encodes the canonical path string, formats a Kitty `t=f` command with geometry and optional image id, wraps it for tmux if needed, and returns `Result<String>`.

**Call relations**: Called by `render_pet_image` for `ImageProtocol::KittyLocalFile` and by a unit test that verifies file-reference encoding.

*Call graph*: calls 2 internal fn (kitty_image_id_arg, wrap_for_tmux_if_needed); called by 2 (kitty_file_png_transmission_encodes_local_file_reference, render_pet_image); 3 external calls (canonicalize, to_string_lossy, format!).


##### `kitty_image_id_arg`  (lines 270–274)

```
fn kitty_image_id_arg(image_id: Option<u32>) -> String
```

**Purpose**: Formats the optional `,i=<id>` fragment used in Kitty commands. It keeps image-id formatting consistent across inline and file-reference transmissions.

**Data flow**: Input is `Option<u32>`. It returns `",i=<id>"` when present or an empty `String` when absent.

**Call relations**: Shared helper for both Kitty transmission functions.

*Call graph*: called by 2 (kitty_transmit_png_file_with_id, kitty_transmit_png_with_id).


##### `wrap_for_tmux_if_needed`  (lines 276–283)

```
fn wrap_for_tmux_if_needed(command: &str) -> String
```

**Purpose**: Wraps an image-protocol command in tmux passthrough framing when running inside tmux, escaping embedded ESC bytes as required. Outside tmux it returns the command unchanged.

**Data flow**: Input is a command string slice. It reads the `TMUX` environment variable; if absent it returns `command.to_string()`, otherwise it doubles ESC bytes in the command and wraps the result in `ESC Ptmux; ... ST`.

**Call relations**: Used by all Kitty command builders so the rendering layer does not need to know about tmux passthrough details.

*Call graph*: called by 3 (kitty_delete_image, kitty_transmit_png_file_with_id, kitty_transmit_png_with_id); 2 external calls (var_os, format!).


##### `sixel_frame`  (lines 285–310)

```
fn sixel_frame(frame_path: &Path, cache_dir: &Path, height_px: u16) -> Result<PathBuf>
```

**Purpose**: Creates or reuses a cached sixel-encoded version of a PNG frame at a requested pixel height. It performs image resizing, RGBA extraction, sixel encoding, and versioned cache naming.

**Data flow**: Inputs are `frame_path`, `cache_dir`, and `height_px`. It creates `cache_dir`, derives a cache filename from the frame stem plus height and `SIXEL_CACHE_VERSION`, returns the existing path if already cached, otherwise opens the source image, computes a resized width preserving aspect ratio, resizes with `FilterType::Lanczos3`, converts to RGBA8, encodes the raw bytes with `sixel::encode_rgba`, writes the resulting bytes to the cache path, and returns that path.

**Call relations**: Called by `render_pet_image` for `ImageProtocol::Sixel` and by a unit test that verifies sixel encoding without external crates.

*Call graph*: calls 1 internal fn (encode_rgba); called by 2 (sixel_frame_encodes_without_external_crate, render_pet_image); 8 external calls (file_stem, join, format!, create_dir_all, write, open, from, from).


##### `tests::EnvVarGuard::new`  (lines 324–331)

```
fn new(name: &'static str, value: Option<&str>) -> Self
```

**Purpose**: Temporarily sets or removes an environment variable for a test while remembering its previous value. It provides deterministic setup for environment-sensitive protocol detection tests.

**Data flow**: Inputs are the variable name and an optional new string value. It reads the previous value with `env::var_os`, then either sets or removes the variable using unsafe std env mutation APIs, stores the previous value in the guard, and returns `EnvVarGuard`.

**Call relations**: Used by multiple serial tests to isolate environment changes around `detect_pet_image_support` and tmux wrapping behavior.

*Call graph*: 3 external calls (remove_var, set_var, var_os).


##### `tests::EnvVarGuard::drop`  (lines 335–340)

```
fn drop(&mut self)
```

**Purpose**: Restores the original environment variable state when the guard goes out of scope. This prevents one test’s environment mutations from leaking into another.

**Data flow**: It takes `&mut self`, consumes `self.previous`, and either resets the variable to its saved value or removes it if it was previously absent.

**Call relations**: Runs automatically at the end of tests that constructed `EnvVarGuard` values.

*Call graph*: 2 external calls (remove_var, set_var).


##### `tests::kitty_png_transmission_encodes_inline_data`  (lines 345–359)

```
fn kitty_png_transmission_encodes_inline_data()
```

**Purpose**: Checks that inline Kitty PNG transmission emits the expected command framing and includes the base64-encoded file contents. It also verifies the command terminates correctly.

**Data flow**: It clears `TMUX`, writes a small `frame.png` file containing `png`, calls `kitty_transmit_png_with_id`, and asserts that the returned command starts with the expected Kitty header, contains `cG5n`, and ends with the string terminator.

**Call relations**: This test exercises `kitty_transmit_png_with_id` in the non-tmux path.

*Call graph*: calls 1 internal fn (kitty_transmit_png_with_id); 4 external calls (new, assert!, write, tempdir).


##### `tests::tmux_passthrough_wraps_and_escapes_control_sequence`  (lines 363–369)

```
fn tmux_passthrough_wraps_and_escapes_control_sequence()
```

**Purpose**: Verifies that tmux passthrough wrapping doubles ESC bytes and adds the correct outer framing. This protects a subtle but necessary transport detail.

**Data flow**: It sets `TMUX`, calls `wrap_for_tmux_if_needed` on a short control sequence, and asserts the exact wrapped string.

**Call relations**: This test directly validates the tmux-specific branch of `wrap_for_tmux_if_needed`.

*Call graph*: 2 external calls (new, assert_eq!).


##### `tests::parses_protocol_selection`  (lines 372–385)

```
fn parses_protocol_selection()
```

**Purpose**: Confirms that the textual protocol parser accepts the three supported keywords. It locks down the user-facing configuration vocabulary.

**Data flow**: It parses `auto`, `kitty`, and `sixel` into `ProtocolSelection` values and asserts equality with the expected enum variants.

**Call relations**: This test exercises the `FromStr` implementation for `ProtocolSelection`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::auto_protocol_is_disabled_inside_tmux`  (lines 389–396)

```
fn auto_protocol_is_disabled_inside_tmux()
```

**Purpose**: Checks that auto-detection refuses to enable pet images inside tmux even if a protocol might otherwise be available. Safety takes precedence over capability.

**Data flow**: It sets `TMUX`, resolves `ProtocolSelection::Auto`, and asserts the result is `Unsupported(Tmux)`.

**Call relations**: This test validates the early environment short-circuit in `detect_pet_image_support` as reached through `ProtocolSelection::resolve`.

*Call graph*: 2 external calls (new, assert_eq!).


##### `tests::explicit_protocol_still_resolves_inside_tmux`  (lines 400–411)

```
fn explicit_protocol_still_resolves_inside_tmux()
```

**Purpose**: Verifies that explicit protocol selections bypass auto-detection’s tmux safety rejection. This preserves the distinction between automatic and user-forced behavior.

**Data flow**: It sets `TMUX`, resolves `ProtocolSelection::Kitty` and `ProtocolSelection::Sixel`, and asserts both return `Supported(...)` values.

**Call relations**: This test exercises the explicit branches of `ProtocolSelection::resolve`.

*Call graph*: 2 external calls (new, assert_eq!).


##### `tests::pet_image_support_prefers_multiplexer_safety`  (lines 414–433)

```
fn pet_image_support_prefers_multiplexer_safety()
```

**Purpose**: Ensures that terminal capability heuristics do not override explicit multiplexer detection. Even a Kitty-capable terminal is rejected when nested inside tmux or Zellij.

**Data flow**: It constructs `TerminalInfo` fixtures with Kitty-family terminal names plus tmux or Zellij multiplexers, passes them to `pet_image_support_for_terminal`, and asserts unsupported results.

**Call relations**: This test validates the first branch in `pet_image_support_for_terminal`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::pet_image_support_detects_iterm2_kitty_file_graphics`  (lines 436–458)

```
fn pet_image_support_detects_iterm2_kitty_file_graphics()
```

**Purpose**: Checks that modern iTerm2 is recognized as supporting Kitty graphics via local-file references rather than generic inline Kitty or unsupported status.

**Data flow**: It builds two `TerminalInfo` fixtures representing iTerm2 3.6.10, calls `pet_image_support_for_terminal` for each, and asserts `Supported(KittyLocalFile)`.

**Call relations**: This test covers the `supports_iterm2_kitty_graphics` branch and the tolerant iTerm2 identification logic.

*Call graph*: 2 external calls (assert_eq!, terminal_info_with_version_for_test).


##### `tests::pet_image_support_rejects_old_iterm2_versions`  (lines 461–490)

```
fn pet_image_support_rejects_old_iterm2_versions()
```

**Purpose**: Verifies that older or versionless iTerm2 terminals are rejected with the dedicated `Iterm2TooOld` reason. This prevents accidental use of unsupported file-graphics behavior.

**Data flow**: It constructs several old-iTerm2 `TerminalInfo` fixtures, passes them to `pet_image_support_for_terminal`, and asserts `Unsupported(Iterm2TooOld)`.

**Call relations**: This test exercises the `is_iterm2_terminal` fallback rejection path after `supports_iterm2_kitty_graphics` fails.

*Call graph*: 2 external calls (assert_eq!, terminal_info_with_version_for_test).


##### `tests::pet_image_support_old_iterm2_message_mentions_upgrade`  (lines 493–501)

```
fn pet_image_support_old_iterm2_message_mentions_upgrade()
```

**Purpose**: Checks the exact user-facing message for the old-iTerm2 unsupported reason. The wording explicitly tells users to upgrade.

**Data flow**: It constructs `PetImageSupport::Unsupported(Iterm2TooOld)`, calls `unsupported_message()`, and asserts the returned string matches the expected message.

**Call relations**: This test validates the interaction between `PetImageSupport::unsupported_message` and `PetImageUnsupportedReason::message`.

*Call graph*: 2 external calls (assert_eq!, Unsupported).


##### `tests::pet_image_support_detects_kitty_graphics_terminals`  (lines 504–548)

```
fn pet_image_support_detects_kitty_graphics_terminals()
```

**Purpose**: Confirms that several known Kitty-family terminals and TERM/TERM_PROGRAM combinations are recognized as supporting Kitty graphics. It covers both structured and heuristic detection paths.

**Data flow**: It builds multiple `TerminalInfo` fixtures for Ghostty, Kitty, WezTerm, and unknown terminals with kitty-like TERM fields, passes each to `pet_image_support_for_terminal`, and asserts `Supported(Kitty)`.

**Call relations**: This test exercises `supports_kitty_graphics` through `pet_image_support_for_terminal`.

*Call graph*: 2 external calls (assert_eq!, terminal_info_for_test).


##### `tests::pet_image_support_detects_sixel_terminals`  (lines 551–583)

```
fn pet_image_support_detects_sixel_terminals()
```

**Purpose**: Checks that known sixel-capable terminals are recognized when Kitty support is absent. This locks down the Sixel fallback heuristics.

**Data flow**: It builds `TerminalInfo` fixtures for TERM values like `xterm-sixel`, `foot`, `mlterm`, and for `WindowsTerminal`, then asserts `pet_image_support_for_terminal` returns `Supported(Sixel)`.

**Call relations**: This test covers the `supports_sixel` branch in `pet_image_support_for_terminal`.

*Call graph*: 2 external calls (assert_eq!, terminal_info_for_test).


##### `tests::wezterm_env_uses_kitty_graphics_for_ambient_pets`  (lines 587–601)

```
fn wezterm_env_uses_kitty_graphics_for_ambient_pets()
```

**Purpose**: Verifies that WezTerm-specific environment variables are enough for auto-detection to choose Kitty graphics. This bypasses generic terminal probing.

**Data flow**: It clears tmux/Zellij/Kitty env vars, sets `WEZTERM_VERSION`, calls `detect_pet_image_support()`, and asserts `Supported(Kitty)`.

**Call relations**: This test exercises the WezTerm environment shortcut in `detect_pet_image_support`.

*Call graph*: 2 external calls (new, assert_eq!).


##### `tests::pet_image_support_rejects_unknown_terminals`  (lines 604–614)

```
fn pet_image_support_rejects_unknown_terminals()
```

**Purpose**: Ensures that terminals with no recognized Kitty or Sixel signals are rejected rather than guessed. This keeps protocol detection conservative.

**Data flow**: It constructs an unknown `TerminalInfo` with a generic `xterm-256color` TERM, passes it to `pet_image_support_for_terminal`, and asserts `Unsupported(Terminal)`.

**Call relations**: This test validates the final fallback branch of `pet_image_support_for_terminal`.

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

**Purpose**: Convenience helper that builds a `TerminalInfo` fixture without a version string. It reduces duplication across detection tests.

**Data flow**: Inputs are terminal name, optional multiplexer, optional `term_program`, and optional `term`. It forwards those values plus `None` version to `terminal_info_with_version_for_test` and returns the resulting `TerminalInfo`.

**Call relations**: Used by multiple tests that do not care about terminal version metadata.

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

**Purpose**: Constructs a complete `TerminalInfo` fixture with optional version and string fields converted into owned `String`s. It is the low-level test data builder for detection heuristics.

**Data flow**: Inputs are `TerminalName`, optional `Multiplexer`, optional `term_program`, optional `version`, and optional `term`. It returns a `TerminalInfo` struct populated with owned strings where provided.

**Call relations**: Used by `terminal_info_for_test` and directly by tests that need to vary the version field.


##### `tests::parse_dotted_version_requires_simple_numeric_components`  (lines 648–655)

```
fn parse_dotted_version_requires_simple_numeric_components()
```

**Purpose**: Locks down the strict parsing rules for dotted versions. It verifies accepted shorthand forms and rejection of extra or non-numeric components.

**Data flow**: It calls `parse_dotted_version` with several inputs and asserts the returned `Option<(u64,u64,u64)>` values match expectations.

**Call relations**: This test directly validates the helper used by iTerm2 version gating.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::sixel_frame_encodes_without_external_crate`  (lines 658–672)

```
fn sixel_frame_encodes_without_external_crate()
```

**Purpose**: Checks that sixel encoding produces a plausible sixel payload from a tiny PNG frame using the in-tree encoder path. It avoids dependence on external sixel tooling.

**Data flow**: It creates a 1×1 red PNG, calls `sixel_frame` with height 1, reads the generated `.six` file as text, and asserts that the payload starts, contains color and pixel data markers, and ends with the sixel terminator.

**Call relations**: This test exercises `sixel_frame` end-to-end, including cache-file creation and sixel encoding.

*Call graph*: calls 1 internal fn (sixel_frame); 5 external calls (assert!, read_to_string, Rgba, from_pixel, tempdir).


##### `tests::kitty_file_png_transmission_encodes_local_file_reference`  (lines 676–696)

```
fn kitty_file_png_transmission_encodes_local_file_reference()
```

**Purpose**: Verifies that Kitty local-file transmission encodes the canonical file path rather than inline PNG bytes and includes the requested image id. This protects the iTerm2-compatible transport format.

**Data flow**: It clears `TMUX`, writes a small PNG file, calls `kitty_transmit_png_file_with_id` with image id 7, canonicalizes the path, base64-encodes that path, and asserts the returned command exactly matches the expected Kitty file-reference sequence.

**Call relations**: This test directly validates `kitty_transmit_png_file_with_id`.

*Call graph*: calls 1 internal fn (kitty_transmit_png_file_with_id); 4 external calls (new, assert_eq!, write, tempdir).


### `tui/src/pets/sixel.rs`

`io_transport` · `request handling`

This file contains a focused encoder for turning RGBA sprite frames into terminal Sixel byte streams. It is deliberately narrow in scope: images are assumed to be small, already decoded RGBA, and transparency is handled by omission rather than compositing. The top-level `encode_rgba` validates non-zero dimensions and exact buffer length (`width * height * 4`), then emits a transparent-background DCS prefix, raster attributes, palette definitions, pixel data, and the terminating `ST` sequence.

Color reduction is fixed to RGB332. `Palette::from_rgba` scans all non-transparent pixels and marks which of the 256 quantized colors are actually used. `Palette::write_definitions` then emits only those palette entries, converting bucket indices back to approximate RGB values and then to Sixel percentage units. Transparency is threshold-based: any alpha below `TRANSPARENT_ALPHA_THRESHOLD` is treated as absent.

Pixel emission is organized into horizontal bands of six rows, matching Sixel's vertical cell structure. For each band, `active_colors_for_band` determines which palette indices appear, then `write_pixels` emits one color plane at a time. Within each plane, `sixel_data_for_column` builds the 6-bit mask for each x-coordinate, and `push_run`/`flush_run` apply Sixel run-length encoding when repeated bytes exceed three cells. Band separators use `-`, and color-plane separators use `$`, with a special `$-` sequence when advancing after non-empty color output.

Overflow-sensitive indexing is guarded with checked arithmetic in `pixel_count` and `pixel_offset`, returning contextual `anyhow` errors instead of panicking on large dimensions.

#### Function details

##### `encode_rgba`  (lines 18–41)

```
fn encode_rgba(rgba: &[u8], width: u32, height: u32) -> Result<Vec<u8>>
```

**Purpose**: Validates an RGBA image buffer and encodes it into a complete Sixel byte sequence with palette definitions and pixel data.

**Data flow**: It takes a raw RGBA byte slice plus `width` and `height`. It rejects zero dimensions, computes the expected pixel count via `pixel_count`, checks that `rgba.len()` equals `width * height * 4`, constructs a `Palette` with `Palette::from_rgba`, appends the transparent-background DCS prefix and raster header to an output `Vec<u8>`, writes palette definitions, delegates pixel-plane emission to `write_pixels`, appends the `ST` terminator, and returns `Result<Vec<u8>>`.

**Call relations**: This is the module entrypoint used by pet-frame rendering code and all encoder tests. It delegates palette construction to `Palette::from_rgba`, size validation to `pixel_count`, and the bulk of image serialization to `write_pixels`.

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

**Purpose**: Serializes the image body as Sixel color planes grouped into six-row bands, applying run-length encoding within each plane.

**Data flow**: It receives the mutable output buffer, RGBA bytes, dimensions, and a prepared `Palette`. It computes the number of six-row bands, loops over each band, asks `active_colors_for_band` which palette indices are present there, emits a `#<color>` selector for each active color, computes one Sixel data byte per column with `sixel_data_for_column`, compresses repeated bytes through `push_run` and `flush_run`, inserts `$` between colors, and emits `-` or `$-` between bands. It returns `Result<()>`.

**Call relations**: This function is called only by `encode_rgba` after header and palette setup. It delegates per-band color discovery to `active_colors_for_band`, per-column mask generation to `sixel_data_for_column`, and byte-run compression to `push_run`/`flush_run`.

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

**Purpose**: Determines which palette indices actually appear in a given six-row band of the image.

**Data flow**: It takes the RGBA buffer, dimensions, the top y-coordinate of the band, and the palette. It scans each pixel in the band's y-range, calls `color_index_at` to ignore transparent pixels and quantize opaque ones, marks active indices in a fixed `[bool; 256]` array, then iterates `palette.indices()` and collects only those marked active into a `Vec<u8>`. It returns `Result<Vec<u8>>`.

**Call relations**: This helper is used by `write_pixels` to avoid emitting empty color planes. It relies on `color_index_at` for transparency-aware quantization and on `Palette::indices` to preserve palette iteration order.

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

**Purpose**: Builds the single Sixel character representing one column of one color plane within a six-row band.

**Data flow**: It takes the RGBA buffer, dimensions, band top, x-coordinate, and target `color_index`. It iterates the six bit positions in the band, skips rows beyond image height, calls `color_index_at` for each pixel, sets bits where the pixel matches the target color, then returns `b'?' + mask` as the encoded Sixel byte.

**Call relations**: This function is called from `write_pixels` inside the innermost x-loop for each active color plane. It delegates pixel lookup and transparency handling to `color_index_at`.

*Call graph*: calls 1 internal fn (color_index_at); called by 1 (write_pixels).


##### `color_index_at`  (lines 125–137)

```
fn color_index_at(rgba: &[u8], width: u32, x: u32, y: u32) -> Result<Option<u8>>
```

**Purpose**: Reads one pixel from the RGBA buffer, applies the transparency threshold, and quantizes opaque RGB values to an RGB332 palette index.

**Data flow**: It takes the RGBA slice, image width, and pixel coordinates `x` and `y`. It computes the byte offset with `pixel_offset`, reads alpha and returns `Ok(None)` if alpha is below `TRANSPARENT_ALPHA_THRESHOLD`; otherwise it computes `rgb332_index(r, g, b)` from the pixel's RGB bytes and returns `Ok(Some(index))`.

**Call relations**: This is the shared pixel-decoding primitive used by both `active_colors_for_band` and `sixel_data_for_column`. It depends on `pixel_offset` for checked indexing and `rgb332_index` for deterministic quantization.

*Call graph*: calls 2 internal fn (pixel_offset, rgb332_index); called by 2 (active_colors_for_band, sixel_data_for_column).


##### `push_run`  (lines 139–150)

```
fn push_run(run_char: &mut Option<u8>, run_len: &mut usize, output: &mut Vec<u8>, byte: u8)
```

**Purpose**: Accumulates repeated Sixel bytes into a pending run, flushing the previous run when the byte value changes.

**Data flow**: It takes mutable references to the current run byte and length, the output buffer, and the next byte to emit. If the byte matches the current run, it increments `run_len`; otherwise it flushes the previous run with `flush_run`, stores the new byte in `run_char`, and resets the run length to 1. It returns no value.

**Call relations**: This helper is called repeatedly by `write_pixels` while scanning columns. It delegates actual serialization of completed runs to `flush_run`.

*Call graph*: calls 1 internal fn (flush_run); called by 1 (write_pixels).


##### `flush_run`  (lines 152–164)

```
fn flush_run(run_char: &mut Option<u8>, run_len: &mut usize, output: &mut Vec<u8>)
```

**Purpose**: Writes the currently accumulated run of identical Sixel bytes to the output buffer, using Sixel run-length encoding when beneficial.

**Data flow**: It takes mutable references to the pending run byte and length plus the output buffer. If there is no pending byte it returns immediately; otherwise it removes the byte from `run_char`, emits either `!<len><byte>` when `run_len > 3` or the byte repeated `run_len` times for shorter runs, then resets `run_len` to 0.

**Call relations**: This function is invoked by `push_run` whenever the byte changes and by `write_pixels` at the end of each color plane to flush the final pending run.

*Call graph*: called by 2 (push_run, write_pixels); 2 external calls (format!, repeat_n).


##### `pixel_offset`  (lines 166–175)

```
fn pixel_offset(width: u32, x: u32, y: u32) -> Result<usize>
```

**Purpose**: Computes the byte offset of a pixel in the flat RGBA buffer using checked arithmetic.

**Data flow**: It takes `width`, `x`, and `y`, computes `((y * width) + x) * 4` in `u64` with overflow checks, then converts the result to `usize`. It returns `Result<usize>` with contextual errors on multiplication/addition or conversion overflow.

**Call relations**: This low-level helper is used only by `color_index_at` so pixel reads fail gracefully instead of panicking on oversized coordinates or dimensions.

*Call graph*: called by 1 (color_index_at); 2 external calls (from, try_from).


##### `pixel_count`  (lines 177–182)

```
fn pixel_count(width: u32, height: u32) -> Result<usize>
```

**Purpose**: Computes the total number of pixels in an image using checked multiplication.

**Data flow**: It takes `width` and `height`, multiplies them in `u64`, converts the result to `usize`, and returns `Result<usize>` with context if the count overflows. It does not inspect image bytes.

**Call relations**: This helper is called by `encode_rgba` during upfront buffer-length validation.

*Call graph*: called by 1 (encode_rgba); 2 external calls (from, try_from).


##### `rgb332_index`  (lines 184–189)

```
fn rgb332_index(red: u8, green: u8, blue: u8) -> u8
```

**Purpose**: Quantizes 8-bit RGB components into a single 8-bit RGB332 palette index.

**Data flow**: It takes `red`, `green`, and `blue` bytes, truncates them to 3, 3, and 2 high bits respectively, packs them into `(red << 5) | (green << 2) | blue`, and returns the resulting `u8` index.

**Call relations**: This pure quantizer is used when scanning opaque pixels in both `Palette::from_rgba` and `color_index_at`.

*Call graph*: called by 2 (from_rgba, color_index_at).


##### `rgb332_color`  (lines 191–200)

```
fn rgb332_color(index: u8) -> (u8, u8, u8)
```

**Purpose**: Expands an RGB332 palette index back into approximate 8-bit RGB values for palette definition output.

**Data flow**: It takes an 8-bit palette index, extracts the 3/3/2-bit red, green, and blue buckets, scales each bucket to 0-255 using `scale_bucket_to_byte`, and returns `(u8, u8, u8)`.

**Call relations**: This helper is used by `Palette::write_definitions` when converting quantized palette indices into Sixel palette declarations.

*Call graph*: calls 1 internal fn (scale_bucket_to_byte); called by 1 (write_definitions).


##### `scale_bucket_to_byte`  (lines 202–205)

```
fn scale_bucket_to_byte(bucket: u8, max: u8) -> u8
```

**Purpose**: Maps a quantized bucket value to the nearest 0-255 byte range endpoint for a given bucket maximum.

**Data flow**: It takes a bucket number and its maximum possible value, computes `(bucket * 255) / max` in `u16`, converts to `u8`, and falls back to `u8::MAX` if conversion somehow fails. It returns the scaled byte.

**Call relations**: This helper is only used by `rgb332_color` to reconstruct approximate RGB channel values from bucket indices.

*Call graph*: called by 1 (rgb332_color); 2 external calls (from, try_from).


##### `byte_to_sixel_percent`  (lines 207–210)

```
fn byte_to_sixel_percent(value: u8) -> u8
```

**Purpose**: Converts an 8-bit color channel value into Sixel's 0-100 percentage scale.

**Data flow**: It takes a byte value, computes `(value * 100) / 255` in `u16`, converts to `u8`, and falls back to `100` on conversion failure. It returns the percentage value.

**Call relations**: This helper is used indirectly by palette serialization in `Palette::write_definitions`.

*Call graph*: 2 external calls (from, try_from).


##### `Palette::from_rgba`  (lines 217–228)

```
fn from_rgba(rgba: &[u8]) -> Self
```

**Purpose**: Builds the set of RGB332 palette entries actually used by opaque pixels in an RGBA image.

**Data flow**: It takes the RGBA byte slice, iterates over `chunks_exact(4)`, skips pixels whose alpha is below `TRANSPARENT_ALPHA_THRESHOLD`, computes each opaque pixel's RGB332 index with `rgb332_index`, marks that slot in a `[bool; 256]` array, and returns `Palette { used }`.

**Call relations**: This constructor is called by `encode_rgba` before any output is written, so later stages can emit only palette entries that are needed.

*Call graph*: calls 1 internal fn (rgb332_index); called by 1 (encode_rgba); 1 external calls (from).


##### `Palette::indices`  (lines 230–232)

```
fn indices(&self) -> impl Iterator<Item = u8> + '_
```

**Purpose**: Iterates over palette indices that are marked as used.

**Data flow**: It reads the `used` boolean array and returns an iterator over `u8` values from 0 through 255 whose slots are true. It does not allocate by itself.

**Call relations**: This iterator is consumed by both `active_colors_for_band` and `Palette::write_definitions`, ensuring consistent palette ordering across definition and pixel-emission phases.

*Call graph*: called by 2 (write_definitions, active_colors_for_band).


##### `Palette::write_definitions`  (lines 234–247)

```
fn write_definitions(&self, output: &mut Vec<u8>)
```

**Purpose**: Appends Sixel palette definition commands for every used RGB332 color.

**Data flow**: It takes `&self` and a mutable output buffer, iterates `self.indices()`, converts each index to approximate RGB bytes with `rgb332_color`, converts those bytes to Sixel percentages with `byte_to_sixel_percent`, formats `#<index>;2;<r>;<g>;<b>` commands, and appends them to `output`. It returns no value.

**Call relations**: This method is called by `encode_rgba` after the raster header and before pixel data so all referenced color indices are defined up front.

*Call graph*: calls 2 internal fn (indices, rgb332_color); 1 external calls (format!).


##### `tests::encodes_red_pixel_with_palette_and_pixel_data`  (lines 257–265)

```
fn encodes_red_pixel_with_palette_and_pixel_data()
```

**Purpose**: Checks that a single opaque red pixel produces the expected DCS prefix, palette definition, pixel data, and terminator.

**Data flow**: It calls `encode_rgba` on a 1x1 red RGBA buffer, converts the returned bytes to UTF-8, and asserts exact string equality against the expected Sixel sequence. It performs no external side effects.

**Call relations**: This test exercises the full happy path through `encode_rgba`, including palette generation and one-band pixel emission.

*Call graph*: calls 1 internal fn (encode_rgba); 2 external calls (from_utf8, assert_eq!).


##### `tests::transparent_pixels_do_not_emit_palette_or_pixel_data`  (lines 268–276)

```
fn transparent_pixels_do_not_emit_palette_or_pixel_data()
```

**Purpose**: Verifies that fully transparent pixels are omitted entirely from both palette definitions and pixel planes.

**Data flow**: It encodes a 1x1 RGBA buffer with alpha 0, converts the result to a string, and asserts that only the DCS prefix, raster header, and terminator remain. It reads only the encoder output.

**Call relations**: This test validates the transparency threshold behavior implemented in `Palette::from_rgba` and `color_index_at`.

*Call graph*: calls 1 internal fn (encode_rgba); 2 external calls (from_utf8, assert_eq!).


##### `tests::multi_band_images_advance_to_next_sixel_band`  (lines 279–294)

```
fn multi_band_images_advance_to_next_sixel_band()
```

**Purpose**: Ensures images taller than six rows are split into multiple Sixel bands with the correct band separator.

**Data flow**: It builds a 1x7 opaque red RGBA buffer, encodes it, converts to UTF-8, and asserts exact equality with a string containing one full-band byte, a `$-` band advance, and a second-band byte. It mutates only a local vector.

**Call relations**: This test covers the band-loop logic in `write_pixels` and the six-row packing in `sixel_data_for_column`.

*Call graph*: calls 1 internal fn (encode_rgba); 3 external calls (from_utf8, new, assert_eq!).


##### `tests::repeated_cells_use_sixel_run_length_encoding`  (lines 297–307)

```
fn repeated_cells_use_sixel_run_length_encoding()
```

**Purpose**: Checks that repeated identical Sixel bytes are compressed using `!<count>` run-length syntax instead of being emitted literally.

**Data flow**: It builds a 4x1 opaque red RGBA buffer, encodes it, converts to UTF-8, and asserts that the output contains `#224!4@`. It only inspects the returned string.

**Call relations**: This test specifically validates the interaction between `write_pixels`, `push_run`, and `flush_run` for runs longer than three cells.

*Call graph*: calls 1 internal fn (encode_rgba); 3 external calls (from_utf8, new, assert!).


##### `tests::rejects_mismatched_rgba_buffer_length`  (lines 310–314)

```
fn rejects_mismatched_rgba_buffer_length()
```

**Purpose**: Verifies that the encoder rejects RGBA buffers whose byte length does not match the declared dimensions.

**Data flow**: It calls `encode_rgba` with a 3-byte buffer for a 1x1 image, captures the error, and asserts on its string form. It does not write any output.

**Call relations**: This test exercises the upfront validation branch in `encode_rgba` that uses `pixel_count` and the expected `* 4` byte count.

*Call graph*: calls 1 internal fn (encode_rgba); 1 external calls (assert_eq!).


### Image ingestion and detail policy
These files define image-processing errors, ingest and normalize prompt images, and apply shared policy helpers for image detail selection and preprocessing.

### `utils/image/src/error.rs`

`data_model` · `cross-cutting`

This file is the crate’s error vocabulary for prompt-image ingestion and re-encoding. The central type is the `ImageProcessingError` enum, derived with `thiserror::Error`, whose variants preserve concrete context: filesystem `PathBuf` for read/decode failures, `ImageFormat` for encode failures, MIME text for unsupported formats, free-form reasons for malformed data URLs, and explicit byte counts for size-limit violations. The design distinguishes true decode failures from unsupported formats: `decode_error` inspects an `image::ImageError` and only produces `Decode` when the source is specifically `ImageError::Decoding(_)`; all other image-library failures are normalized into `UnsupportedImageFormat` using `mime_guess` on the path. That means callers can treat “bad image bytes” differently from “format not accepted by this subsystem.” The helper `is_invalid_image` intentionally recognizes only the decoding case, not every error variant, so higher layers can classify user-supplied corrupt images without conflating them with transport, size, or unsupported-format problems. This file contains no I/O itself; it packages lower-level errors into stable, user-facing messages and preserves enough structured data for tests and callers to branch on exact failure modes.

#### Function details

##### `ImageProcessingError::decode_error`  (lines 39–52)

```
fn decode_error(path: &std::path::Path, source: image::ImageError) -> Self
```

**Purpose**: Builds an `ImageProcessingError` from an image-library decode/format-detection failure, choosing between a concrete `Decode` error and an `UnsupportedImageFormat` classification.

**Data flow**: It takes a `&Path` and an `image::ImageError`. If the source matches `ImageError::Decoding(_)`, it clones the path into a `PathBuf` and returns `ImageProcessingError::Decode { path, source }`. Otherwise it guesses a MIME type from the path extension via `mime_guess::from_path(...).first()`, falls back to `"unknown"`, and returns `UnsupportedImageFormat { mime }`.

**Call relations**: This helper is used by image-loading code when `image::guess_format`, decoder construction, or full decode fails. It centralizes the crate’s policy for mapping raw `image` crate failures into either “invalid image bytes” or “unsupported format,” so callers do not duplicate that branching.

*Call graph*: 3 external calls (to_path_buf, matches!, from_path).


##### `ImageProcessingError::is_invalid_image`  (lines 54–62)

```
fn is_invalid_image(&self) -> bool
```

**Purpose**: Reports whether an error represents a genuine image-decoding failure rather than another processing problem.

**Data flow**: It reads `self` and pattern-matches for the specific shape `ImageProcessingError::Decode { source: ImageError::Decoding(_), .. }`. It returns `true` only for that case and `false` for read, encode, unsupported-format, malformed-data-URL, and size-limit errors.

**Call relations**: This is a classification helper for higher-level callers and tests that need to recognize corrupt image content. It does not delegate further; it encapsulates the invariant established by `decode_error` about what counts as an invalid image.

*Call graph*: 1 external calls (matches!).


### `utils/image/src/lib.rs`

`domain_logic` · `request handling`

This file contains the full prompt-image pipeline. Its public data model is `EncodedImage`, which stores encoded bytes in `Arc<[u8]>` plus MIME type and dimensions, and can render itself as a base64 data URL. The main entrypoint, `load_for_prompt_bytes`, computes a SHA-1 digest plus `PromptImageMode` cache key, checks a global `BlockingLruCache`, then decodes the image with the `image` crate. It accepts PNG, JPEG, GIF, and WebP as inputs, but only preserves original bytes for PNG/JPEG/WebP; GIF is decoded and re-encoded as PNG. Before decoding pixels, it extracts ICC and EXIF metadata from the decoder, but keeps ICC only when bytes 16..20 equal `b"RGB "`, avoiding unsafe reuse of CMYK/YCCK profiles after RGB conversion. Resizing follows either a simple `MAX_DIMENSION` bound or explicit `PromptImageResizeLimits`, whose helper computes dimensions that satisfy both max side length and patch-budget constraints using `PROMPT_IMAGE_PATCH_SIZE` and careful floor/round logic. Re-encoding uses PNG, JPEG, or lossless WebP encoders and reapplies metadata through `apply_image_metadata`, wrapping encoder failures as `ImageProcessingError::Encode`. `load_data_url_for_prompt` adds transport parsing: it validates a case-insensitive `data:` prefix, requires a `base64` marker, enforces byte-size guards on both encoded and decoded payloads, then delegates to the byte loader. The private `cache_image` function enforces a total byte budget by evicting least-recently-used entries and refusing to cache oversized outputs.

#### Function details

##### `EncodedImage::into_data_url`  (lines 47–49)

```
fn into_data_url(self) -> String
```

**Purpose**: Converts an already-processed encoded image into a `data:` URL string using its stored MIME type and bytes.

**Data flow**: It consumes `self`, reads `self.mime` and `self.bytes`, and passes them to `data_url_from_bytes`. It returns the formatted base64 data URL string and does not mutate external state.

**Call relations**: This is a convenience wrapper over the standalone formatter. Callers use it after image processing when they need inline transport encoding rather than raw bytes.

*Call graph*: calls 1 internal fn (data_url_from_bytes).


##### `data_url_from_bytes`  (lines 53–56)

```
fn data_url_from_bytes(mime: &str, bytes: &[u8]) -> String
```

**Purpose**: Formats arbitrary bytes as a base64 `data:` URL without validating that the bytes are a real image.

**Data flow**: It takes a MIME string and a byte slice, base64-encodes the bytes with `BASE64_STANDARD`, interpolates both into `data:{mime};base64,{encoded}`, and returns the resulting `String`.

**Call relations**: This helper underpins `EncodedImage::into_data_url` and test fixture generation. It is intentionally transport-only and does not inspect image contents.

*Call graph*: called by 1 (into_data_url); 1 external calls (format!).


##### `load_for_prompt_bytes`  (lines 87–193)

```
fn load_for_prompt_bytes(
    path: &Path,
    file_bytes: Vec<u8>,
    mode: PromptImageMode,
) -> Result<EncodedImage, ImageProcessingError>
```

**Purpose**: Processes raw image bytes into an `EncodedImage`, optionally resizing and re-encoding while preserving safe metadata and caching the result.

**Data flow**: Inputs are a logical `&Path`, owned `Vec<u8>` file bytes, and a `PromptImageMode`. It clones the path into a `PathBuf`, computes an `ImageCacheKey` from `sha1_digest(&file_bytes)` and mode, and returns a cached `EncodedImage` if present. Otherwise it guesses the format, restricts accepted source formats to PNG/JPEG/GIF/WebP, constructs a decoder, extracts RGB-only ICC plus EXIF metadata, decodes to `DynamicImage`, computes target dimensions based on mode, and either preserves original bytes, or re-encodes resized/original pixels via `encode_image`. It writes the finished image into the global cache through `cache_image` and returns it.

**Call relations**: This is the core API used directly by tests and indirectly by `load_data_url_for_prompt`. Internally it delegates format-specific output work to `encode_image`, MIME selection to `format_to_mime`, geometry decisions to `prompt_image_output_dimensions_for_limits`, and cache insertion to `cache_image`.

*Call graph*: calls 1 internal fn (cache_image); called by 1 (load_data_url_for_prompt); 2 external calls (to_path_buf, sha1_digest).


##### `cache_image`  (lines 195–213)

```
fn cache_image(cache: &ImageCache, key: ImageCacheKey, image: EncodedImage, byte_capacity: usize)
```

**Purpose**: Inserts an encoded image into an LRU cache while enforcing a total byte-capacity budget.

**Data flow**: It takes a cache reference, key, `EncodedImage`, and byte-capacity limit. If the image’s byte length exceeds the capacity, it returns immediately without caching. Otherwise it mutates the cache: inserts the new entry, sums cached byte lengths, and repeatedly pops least-recently-used entries until total cached bytes are within budget.

**Call relations**: This helper is called only after successful processing in `load_for_prompt_bytes`. It encapsulates cache sizing policy so the loader can remain focused on decode/resize/encode logic.

*Call graph*: called by 1 (load_for_prompt_bytes); 1 external calls (with_mut).


##### `load_data_url_for_prompt`  (lines 215–262)

```
fn load_data_url_for_prompt(
    image_url: &str,
    mode: PromptImageMode,
) -> Result<EncodedImage, ImageProcessingError>
```

**Purpose**: Parses a base64 image data URL, enforces input-size limits, decodes the payload, and then runs the normal prompt-image pipeline.

**Data flow**: It takes the raw URL string and a `PromptImageMode`. It verifies a case-insensitive `data:` prefix, splits metadata from payload at the first comma, requires some semicolon-delimited metadata part equal to `base64` ignoring ASCII case, checks the encoded payload length against `MAX_PROMPT_IMAGE_INPUT_BYTES`, base64-decodes it, checks decoded length against the same limit, and passes the bytes to `load_for_prompt_bytes` using the synthetic path `<data-url-image>`.

**Call relations**: This is the transport-facing companion to `load_for_prompt_bytes`. It handles syntax and size validation itself, then delegates all image semantics—format detection, resizing, metadata, caching—to the byte loader.

*Call graph*: calls 1 internal fn (load_for_prompt_bytes); 1 external calls (new).


##### `prompt_image_output_dimensions_for_limits`  (lines 264–299)

```
fn prompt_image_output_dimensions_for_limits(
    width: u32,
    height: u32,
    limits: PromptImageResizeLimits,
) -> (u32, u32)
```

**Purpose**: Computes resized dimensions that satisfy both a maximum side length and a patch-count budget while preserving aspect ratio.

**Data flow**: It takes source `width`, `height`, and `PromptImageResizeLimits`. It clamps dimensions to at least 1, returns them unchanged if they already fit, otherwise scales them down to `limits.max_dimension`, checks again, and if still too large computes an area-based scale from `PROMPT_IMAGE_PATCH_SIZE` and `limits.max_patches`. It then adjusts that scale downward so the floored patch grid stays within budget and returns floored dimensions, each at least 1.

**Call relations**: This helper is used by `load_for_prompt_bytes` only in `ResizeWithLimits` mode. It relies on `prompt_image_dimensions_fit` for both the initial and post-dimension-cap checks.

*Call graph*: calls 1 internal fn (prompt_image_dimensions_fit); 1 external calls (from).


##### `prompt_image_dimensions_fit`  (lines 301–308)

```
fn prompt_image_dimensions_fit(width: u32, height: u32, limits: PromptImageResizeLimits) -> bool
```

**Purpose**: Tests whether given dimensions satisfy both the explicit maximum dimension and patch-count constraints.

**Data flow**: It takes width, height, and limits, computes patch counts with `div_ceil(PROMPT_IMAGE_PATCH_SIZE)`, multiplies them as `u64`, and returns `true` only if width and height are each within `limits.max_dimension` and total patches do not exceed `limits.max_patches`.

**Call relations**: This predicate is called by `prompt_image_output_dimensions_for_limits` to short-circuit when no resize is needed and to validate the intermediate max-dimension-scaled result.

*Call graph*: called by 1 (prompt_image_output_dimensions_for_limits); 1 external calls (from).


##### `can_preserve_source_bytes`  (lines 310–317)

```
fn can_preserve_source_bytes(format: ImageFormat) -> bool
```

**Purpose**: Declares which decoded input formats may be passed through byte-for-byte when no resize or conversion is required.

**Data flow**: It takes an `ImageFormat` and returns `true` only for `Png`, `Jpeg`, and `WebP`; all other formats return `false`.

**Call relations**: This helper is consulted inside `load_for_prompt_bytes` both when deciding whether to keep original bytes unchanged and when choosing a preferred output format after resizing.

*Call graph*: 1 external calls (matches!).


##### `encode_image`  (lines 319–380)

```
fn encode_image(
    image: &DynamicImage,
    preferred_format: ImageFormat,
    metadata: ImageMetadata,
) -> Result<(Vec<u8>, ImageFormat), ImageProcessingError>
```

**Purpose**: Re-encodes a `DynamicImage` into PNG, JPEG, or lossless WebP and reapplies preserved ICC/EXIF metadata.

**Data flow**: It takes a decoded image, a preferred `ImageFormat`, and `ImageMetadata`. It normalizes the target format to JPEG, WebP, or PNG fallback, allocates an output buffer, destructures metadata, and runs the corresponding encoder: PNG and WebP convert to RGBA bytes and call `write_image`, while JPEG uses `encode_image` directly. Before writing pixels it calls `apply_image_metadata`; any encoder failure is wrapped as `ImageProcessingError::Encode { format, source }`. It returns `(Vec<u8>, ImageFormat)`.

**Call relations**: This function is called by `load_for_prompt_bytes` whenever original bytes cannot be preserved or resizing occurred. It delegates metadata attachment to `apply_image_metadata` so format-specific pixel encoding stays separate from metadata error handling.

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

**Purpose**: Attaches optional ICC and EXIF metadata to an encoder, converting unsupported metadata-setting failures into the crate’s encode error type.

**Data flow**: It takes a mutable generic `impl ImageEncoder`, optional ICC bytes, optional EXIF bytes, and the target `ImageFormat`. For each present metadata field it calls the encoder setter; if the setter fails, it wraps the unsupported-operation error as `ImageProcessingError::Encode` with `image::ImageError::Unsupported(source)`. It returns `Ok(())` when both metadata applications succeed or are absent.

**Call relations**: This helper is used only by `encode_image` before pixel data is written. It isolates metadata-specific error mapping from the rest of the encoding logic.

*Call graph*: called by 1 (encode_image); 2 external calls (set_exif_metadata, set_icc_profile).


##### `format_to_mime`  (lines 407–414)

```
fn format_to_mime(format: ImageFormat) -> String
```

**Purpose**: Maps an `ImageFormat` to the MIME string used in `EncodedImage` and data URLs.

**Data flow**: It takes an `ImageFormat` and returns a newly allocated `String`: `image/jpeg` for JPEG, `image/gif` for GIF, `image/webp` for WebP, and `image/png` for all other cases.

**Call relations**: This helper is used by `load_for_prompt_bytes` after deciding the final output format. It keeps MIME selection centralized and consistent across pass-through and re-encoded outputs.


### `tools/src/image_detail.rs`

`domain_logic` · `request handling`

This file contains the image-detail compatibility logic shared by tool/output processing. The simplest helper, `can_request_original_image_detail`, is just a capability probe over `ModelInfo.supports_image_detail_original`. `normalize_output_image_detail` uses that probe to normalize an optional requested detail before it is sent onward: explicit `Original` is preserved only when the model advertises support, while `None` and unsupported `Original` both collapse to `None`; the other explicit variants (`Auto`, `Low`, `High`) pass through unchanged. That means callers can distinguish between “request a supported original image” and “omit the detail field entirely.” The mutating helper, `sanitize_original_image_detail`, applies the same policy to already-built `FunctionCallOutputContentItem` arrays. If original detail is unsupported, it scans the slice in place, touches only `InputImage` variants, and rewrites `detail: Some(ImageDetail::Original)` to `Some(DEFAULT_IMAGE_DETAIL)`. Non-image items and non-original image details are left untouched. The design intentionally separates pure normalization of a single optional value from bulk in-place sanitation of heterogeneous output content items, making capability checks reusable in both request construction and post-processing paths.

#### Function details

##### `can_request_original_image_detail`  (lines 6–8)

```
fn can_request_original_image_detail(model_info: &ModelInfo) -> bool
```

**Purpose**: Returns whether a model explicitly supports requesting original image detail.

**Data flow**: Takes `&ModelInfo`, reads its `supports_image_detail_original` boolean field, and returns that boolean unchanged. It does not mutate any state.

**Call relations**: This helper is called by `normalize_output_image_detail` when deciding whether an explicit `ImageDetail::Original` should survive normalization. It serves as the single capability predicate so callers do not duplicate field access logic.

*Call graph*: called by 1 (normalize_output_image_detail).


##### `normalize_output_image_detail`  (lines 10–21)

```
fn normalize_output_image_detail(
    model_info: &ModelInfo,
    detail: Option<ImageDetail>,
) -> Option<ImageDetail>
```

**Purpose**: Normalizes an optional requested image detail against model support, dropping unsupported or absent original-detail requests while preserving other explicit levels.

**Data flow**: Accepts `&ModelInfo` and `Option<ImageDetail>`. It pattern-matches the option: supported `Some(Original)` becomes `Some(Original)`, unsupported `Some(Original)` becomes `None`, `None` stays `None`, and `Some(Auto|Low|High)` is returned unchanged. It reads model capability through `can_request_original_image_detail` and produces a new `Option<ImageDetail>` without side effects.

**Call relations**: Callers use this before emitting image-detail settings. Internally it delegates the capability check to `can_request_original_image_detail` specifically on the `Original` branch, centralizing the policy for whether that enum variant may be requested.

*Call graph*: calls 1 internal fn (can_request_original_image_detail).


##### `sanitize_original_image_detail`  (lines 23–38)

```
fn sanitize_original_image_detail(
    can_request_original_image_detail: bool,
    items: &mut [FunctionCallOutputContentItem],
)
```

**Purpose**: Walks mutable output content items and downgrades unsupported `Original` image detail requests to the protocol default detail.

**Data flow**: Takes a precomputed boolean `can_request_original_image_detail` and a mutable slice of `FunctionCallOutputContentItem`. If the boolean is true it returns immediately. Otherwise it iterates through the slice, matches `InputImage { detail, .. }` items, and when `detail` is `Some(ImageDetail::Original)` replaces it in place with `Some(DEFAULT_IMAGE_DETAIL)`. It returns unit and mutates only the matching image items.

**Call relations**: This function is used when content items have already been assembled and need post-hoc sanitation. Unlike `normalize_output_image_detail`, it does not inspect `ModelInfo` itself; callers supply the capability decision up front, and the function performs the in-place rewrite over mixed content.

*Call graph*: 1 external calls (matches!).


### `core/src/original_image_detail.rs`

`util` · `request handling`

This file re-exports two crate-private helpers from `codex_tools`: `can_request_original_image_detail` and `sanitize_original_image_detail`. Together, these names indicate a two-step policy boundary around image-processing requests: first determining whether a caller/context is allowed to ask for original-detail image handling, and then cleaning or constraining the requested detail setting into an acceptable form. The functions remain implemented in the tools crate, but this module gives codex-core's image and tool orchestration code a local import path and keeps image-detail policy grouped with other core image-related modules. Because both exports are `pub(crate)`, the functionality is intentionally internal to codex-core rather than part of its public API, suggesting that callers should rely on higher-level image preparation or tool invocation flows instead of invoking these helpers directly from outside the crate.


### `core/src/image_preparation.rs`

`util` · `history preparation and rollout reconstruction`

This file walks mutable `ResponseItem` history and rewrites embedded image content in place before the items are persisted or reconstructed. It only touches image-bearing content variants: `ContentItem::InputImage` inside message content and `FunctionCallOutputContentItem::InputImage` inside function/custom tool outputs. For each image, it first checks whether the URL is a `data:` URL; non-data URLs are left untouched. Data URLs are then passed through `prepare_image`, which chooses resize limits based on `ImageDetail`: `Auto` and `High` use the stricter `HIGH_DETAIL_LIMITS`, `Original` uses larger `ORIGINAL_DETAIL_LIMITS`, and `Low` is explicitly rejected as unsupported.

If image processing succeeds, the original `image_url` string is replaced with a resized/re-encoded data URL returned by `load_data_url_for_prompt`. If processing fails, the code logs a warning and replaces the image item with a text placeholder explaining the failure category. The placeholder mapping is intentionally user-readable and specific: unsupported low detail gets a dedicated message, `ImageTooLarge` gets a size-limit message, and all other processing failures collapse to a generic omission notice. The traversal deliberately ignores all other `ResponseItem` variants, so reasoning items, tool calls, compaction markers, and non-image content pass through unchanged.

#### Function details

##### `ImagePreparationError::placeholder`  (lines 34–42)

```
fn placeholder(&self) -> &'static str
```

**Purpose**: Maps an internal image-preparation error to the user-visible placeholder text that should replace the failed image.

**Data flow**: Matches `self` and returns `UNSUPPORTED_LOW_DETAIL_PLACEHOLDER` for `UnsupportedLowDetail`, `IMAGE_TOO_LARGE_PLACEHOLDER` for `Processing(ImageTooLarge { .. })`, or the generic `IMAGE_PROCESSING_ERROR_PLACEHOLDER` for all other processing errors.

**Call relations**: Used by both message and tool-output preparation paths when image processing fails.


##### `prepare_response_items`  (lines 45–70)

```
fn prepare_response_items(items: &mut [ResponseItem])
```

**Purpose**: Traverses a mutable slice of `ResponseItem`s and preprocesses any embedded message or tool-output images in place.

**Data flow**: Iterates over `items`. For `ResponseItem::Message` it delegates to `prepare_message_content`; for `FunctionCallOutput` and `CustomToolCallOutput` it obtains mutable content items and delegates to `prepare_tool_output_content`; all other response-item variants are ignored. It returns nothing and mutates the supplied items in place.

**Call relations**: Called by history/rollout preparation code before items are stored or reconstructed. It delegates image-specific work to the two content-level helpers.

*Call graph*: calls 2 internal fn (prepare_message_content, prepare_tool_output_content); called by 2 (apply_rollout_reconstruction, prepare_conversation_items_for_history).


##### `prepare_message_content`  (lines 72–84)

```
fn prepare_message_content(items: &mut [ContentItem])
```

**Purpose**: Processes inline images inside message content, resizing supported data URLs and replacing failures with text placeholders.

**Data flow**: Iterates over mutable `ContentItem`s. For each `ContentItem::InputImage { image_url, detail }`, it checks `is_data_url(image_url)` and then calls `prepare_image(image_url, *detail)`. On error it logs a warning and replaces the item with `ContentItem::InputText { text: error.placeholder().to_string() }`. Non-image items and non-data URLs are left unchanged.

**Call relations**: Called by `prepare_response_items` for message bodies.

*Call graph*: calls 2 internal fn (is_data_url, prepare_image); called by 1 (prepare_response_items); 1 external calls (warn!).


##### `prepare_tool_output_content`  (lines 86–98)

```
fn prepare_tool_output_content(items: &mut [FunctionCallOutputContentItem])
```

**Purpose**: Processes inline images inside function/custom tool output content, mirroring the message-content behavior.

**Data flow**: Iterates over mutable `FunctionCallOutputContentItem`s. For each `InputImage`, it checks `is_data_url`, calls `prepare_image`, and on failure logs a warning and replaces the item with `FunctionCallOutputContentItem::InputText { text: error.placeholder().to_string() }`. Other items are unchanged.

**Call relations**: Called by `prepare_response_items` for tool-output payloads.

*Call graph*: calls 2 internal fn (is_data_url, prepare_image); called by 1 (prepare_response_items); 1 external calls (warn!).


##### `is_data_url`  (lines 100–104)

```
fn is_data_url(image_url: &str) -> bool
```

**Purpose**: Performs a case-insensitive prefix check for `data:` URLs.

**Data flow**: Reads `image_url`, slices the first `"data:".len()` bytes when present, compares them case-insensitively to `data:`, and returns a boolean.

**Call relations**: Used by both content-preparation helpers to avoid touching non-inline image URLs.

*Call graph*: called by 2 (prepare_message_content, prepare_tool_output_content).


##### `prepare_image`  (lines 106–118)

```
fn prepare_image(
    image_url: &mut String,
    detail: Option<ImageDetail>,
) -> Result<(), ImagePreparationError>
```

**Purpose**: Loads, validates, resizes, and rewrites a data-URL image according to the requested detail level.

**Data flow**: Takes a mutable `image_url` string and optional `ImageDetail`. It selects `HIGH_DETAIL_LIMITS` for `None`, `Auto`, or `High`; `ORIGINAL_DETAIL_LIMITS` for `Original`; and returns `Err(UnsupportedLowDetail)` for `Low`. It then calls `load_data_url_for_prompt(image_url, PromptImageMode::ResizeWithLimits(limits))`, replaces `*image_url` with the processed image’s `into_data_url()` result, and returns `Ok(())` or a wrapped `ImagePreparationError`.

**Call relations**: Called by both message and tool-output image preparation paths as the core image-processing step.

*Call graph*: called by 2 (prepare_message_content, prepare_tool_output_content); 2 external calls (load_data_url_for_prompt, ResizeWithLimits).


### Async control primitives
These files provide small reusable primitives for cancellation, readiness signaling, and pause-aware timeout budgeting.

### `async-utils/src/lib.rs`

`util` · `cross-cutting`

This file defines one focused utility: `OrCancelExt`, implemented for any `Future + Send` whose output is also `Send`. The extension method `or_cancel` wraps an existing future in a `tokio::select!` that concurrently waits for either the future to complete or a `CancellationToken` to fire. If cancellation wins, the wrapper returns `Err(CancelErr::Cancelled)`; otherwise it returns `Ok(output)`.

The design is intentionally minimal. `CancelErr` has a single variant, so callers can distinguish cooperative cancellation from ordinary task success without introducing a broader error taxonomy. Because the trait is blanket-implemented for all matching futures, call sites can write `some_future.or_cancel(&token).await` without additional adapters or boxing.

The tests cover the three timing cases that matter for correctness: immediate success when the wrapped future resolves first, cancellation after a short delay while the future is still pending, and cancellation that has already happened before polling begins. Together they document that the wrapper is edge-trigger agnostic: it behaves the same whether the token is cancelled before or during execution.

#### Function details

##### `F::or_cancel`  (lines 25–30)

```
async fn or_cancel(self, token: &CancellationToken) -> Result<Self::Output, CancelErr>
```

**Purpose**: Wraps an arbitrary future so it resolves either with the future’s output or with `CancelErr::Cancelled` if the provided token is cancelled first. It is the blanket implementation behind the `OrCancelExt` trait.

**Data flow**: Consumes `self` as the future to run and borrows a `CancellationToken`. Inside `tokio::select!`, it awaits either `token.cancelled()` or the future itself; it transforms the winner into `Err(CancelErr::Cancelled)` or `Ok(output)` and returns that `Result`.

**Call relations**: This is the sole behavior provided by the file’s extension trait. The tests invoke it under different timing conditions to validate both branches of the `select!`.

*Call graph*: 1 external calls (select!).


##### `tests::returns_ok_when_future_completes_first`  (lines 42–49)

```
async fn returns_ok_when_future_completes_first()
```

**Purpose**: Checks that `or_cancel` preserves the wrapped future’s value when no cancellation occurs first. It demonstrates the happy-path contract.

**Data flow**: Creates a fresh `CancellationToken`, wraps an immediately-ready async block returning `42`, awaits `.or_cancel(&token)`, and asserts the result is `Ok(42)`.

**Call relations**: This test exercises the completion branch of `F::or_cancel` where the wrapped future wins the race.

*Call graph*: 2 external calls (new, assert_eq!).


##### `tests::returns_err_when_token_cancelled_first`  (lines 52–70)

```
async fn returns_err_when_token_cancelled_first()
```

**Purpose**: Checks that `or_cancel` returns `Cancelled` when the token fires before the wrapped future completes. It models in-flight cancellation from another task.

**Data flow**: Creates a token and clone, spawns a task that sleeps briefly then calls `cancel()`, wraps a slower async block that sleeps longer and returns `7`, awaits `.or_cancel(&token)`, waits for the canceller task, and asserts the result is `Err(CancelErr::Cancelled)`.

**Call relations**: This test exercises the cancellation branch of `F::or_cancel` under concurrent timing.

*Call graph*: 5 external calls (new, from_millis, assert_eq!, spawn, sleep).


##### `tests::returns_err_when_token_already_cancelled`  (lines 73–85)

```
async fn returns_err_when_token_already_cancelled()
```

**Purpose**: Checks that `or_cancel` immediately reports cancellation when the token has already been cancelled before polling starts. This covers the pre-cancelled edge case.

**Data flow**: Creates a token, cancels it synchronously, wraps a delayed async block returning `5`, awaits `.or_cancel(&token)`, and asserts the result is `Err(CancelErr::Cancelled)`.

**Call relations**: This test confirms `F::or_cancel` does not require cancellation to happen after polling begins.

*Call graph*: 4 external calls (new, from_millis, assert_eq!, sleep).


### `utils/readiness/src/lib.rs`

`domain_logic` · `cross-cutting synchronization during async startup and readiness gating`

This file implements a small concurrency primitive around `ReadinessFlag`, plus the `Readiness` trait that abstracts its behavior. The state is split between an `AtomicBool` `ready` for cheap lock-free reads, an `AtomicI32` `next_id` for token generation, a Tokio `Mutex<HashSet<Token>>` tracking active subscriptions, and a `watch::Sender<bool>` used to wake async waiters when readiness flips to true. Readiness is one-way: once `ready` becomes true it is never reset.

The design has an unusual but intentional shortcut in `is_ready`: if the flag is not yet ready and the token set can be `try_lock`ed and is empty, the method marks the flag ready immediately and broadcasts to waiters. That means a flag with no subscribers becomes ready on first observation. `subscribe` prevents races by rechecking `ready` while holding the token lock, then loops until it generates a nonzero, unique `Token`, handling `i32` wrap-around and collisions. `mark_ready` validates that the token is nonzero and currently present, removes it, stores `ready = true`, clears all remaining tokens, and sends a best-effort watch notification. `with_tokens` wraps lock acquisition in a 1-second timeout and converts lock contention into a domain-specific `ReadinessError::TokenLockFailed`. The tests cover the one-shot semantics, invalid tokens, waiter wakeup, zero-token avoidance, duplicate-token avoidance, and lock-timeout behavior.

#### Function details

##### `ReadinessFlag::new`  (lines 60–68)

```
fn new() -> Self
```

**Purpose**: Constructs a fresh readiness flag in the not-ready state with no subscribers. It also initializes the watch channel used to notify waiters.

**Data flow**: It creates a `watch::channel(false)`, stores `ready = false`, `next_id = 1`, an empty `HashSet<Token>` inside a Tokio `Mutex`, and the sender half of the watch channel in the returned `ReadinessFlag`.

**Call relations**: This is the primary constructor used throughout the tests and by production callers creating a new readiness gate. `Default::default` delegates directly to it.

*Call graph*: called by 9 (is_ready_without_subscribers_marks_flag_ready, mark_ready_rejects_unknown_token, mark_ready_twice_uses_single_token, subscribe_after_ready_returns_none, subscribe_and_mark_ready_roundtrip, subscribe_avoids_duplicate_tokens, subscribe_returns_error_when_lock_is_held, subscribe_skips_zero_token, wait_ready_unblocks_after_mark_ready); 5 external calls (new, new, new, new, channel).


##### `ReadinessFlag::with_tokens`  (lines 70–78)

```
async fn with_tokens(
        &self,
        f: impl FnOnce(&mut HashSet<Token>) -> R,
    ) -> Result<R, errors::ReadinessError>
```

**Purpose**: Runs a closure while holding the token set lock, but fails if the lock cannot be acquired within the configured timeout. It centralizes lock acquisition and timeout-to-error conversion.

**Data flow**: It takes a closure `f`, awaits `time::timeout(LOCK_TIMEOUT, self.tokens.lock())`, maps timeout into `ReadinessError::TokenLockFailed`, then passes the mutable `HashSet<Token>` guard into `f` and returns the closure result wrapped in `Ok`.

**Call relations**: Both `subscribe` and `mark_ready` use this helper so they share the same lock timeout behavior and error mapping.

*Call graph*: called by 2 (mark_ready, subscribe); 1 external calls (timeout).


##### `ReadinessFlag::load_ready`  (lines 80–82)

```
fn load_ready(&self) -> bool
```

**Purpose**: Reads the atomic ready bit with acquire ordering. It is the common fast-path accessor for readiness checks.

**Data flow**: It reads `self.ready` using `Ordering::Acquire` and returns the resulting `bool` without mutating any state.

**Call relations**: This helper is used by `fmt`, `is_ready`, `subscribe`, and `mark_ready` to avoid duplicating the atomic load details.

*Call graph*: called by 4 (fmt, is_ready, mark_ready, subscribe); 1 external calls (load).


##### `ReadinessFlag::default`  (lines 86–88)

```
fn default() -> Self
```

**Purpose**: Provides the `Default` implementation by constructing a new unreadied flag. It is purely a convenience wrapper.

**Data flow**: It takes no inputs and returns `Self::new()`.

**Call relations**: This is invoked when callers use `ReadinessFlag::default()` or derive/default-based initialization paths.

*Call graph*: 1 external calls (new).


##### `ReadinessFlag::fmt`  (lines 92–96)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Formats the flag for debugging by exposing only whether it is currently ready. It intentionally does not print token internals.

**Data flow**: It reads the current ready state via `load_ready`, builds a `DebugStruct("ReadinessFlag")`, adds the `ready` field, and writes the formatted representation into the provided formatter.

**Call relations**: This is the `fmt::Debug` implementation for the type and is used implicitly by debug formatting in logs, assertions, or diagnostics.

*Call graph*: calls 1 internal fn (load_ready); 1 external calls (debug_struct).


##### `ReadinessFlag::is_ready`  (lines 100–117)

```
fn is_ready(&self) -> bool
```

**Purpose**: Returns whether the flag is ready, and opportunistically transitions it to ready if there are no active subscribers. This makes readiness self-satisfying when nobody has subscribed for authorization.

**Data flow**: It first checks `load_ready`; if already true, it returns true immediately. Otherwise it attempts `self.tokens.try_lock()`, and if that succeeds and the token set is empty, it atomically swaps `ready` to true with `Ordering::AcqRel`, drops the lock, sends `true` on the watch channel if this call performed the transition, and returns true. If the lock is unavailable or tokens are present, it falls back to a final `load_ready()` result.

**Call relations**: This method is part of the `Readiness` trait implementation and is called directly by consumers as well as by `wait_ready` for its fast path before subscribing to watch notifications.

*Call graph*: calls 1 internal fn (load_ready); called by 1 (wait_ready); 2 external calls (swap, send).


##### `ReadinessFlag::subscribe`  (lines 119–143)

```
async fn subscribe(&self) -> Result<Token, errors::ReadinessError>
```

**Purpose**: Registers a new authorized subscriber and returns a unique nonzero token, unless the flag is already ready. It closes the race between readiness checks and token insertion by rechecking under lock.

**Data flow**: It first reads `load_ready` and returns `FlagAlreadyReady` if true. Otherwise it calls `with_tokens` with a closure that rechecks `load_ready`, then loops generating `Token(self.next_id.fetch_add(1, Ordering::Relaxed))` until it finds a token whose inner `i32` is nonzero and not already present in the `HashSet`; that token is inserted and returned as `Some(token)`. After awaiting the lock helper, it converts `None` into `FlagAlreadyReady` and otherwise returns the token.

**Call relations**: This is one of the main public async operations on the flag. It relies on `with_tokens` for bounded lock acquisition and is paired with `mark_ready`, which later consumes the returned token.

*Call graph*: calls 2 internal fn (load_ready, with_tokens).


##### `ReadinessFlag::mark_ready`  (lines 145–169)

```
async fn mark_ready(&self, token: Token) -> Result<bool, errors::ReadinessError>
```

**Purpose**: Attempts to transition the flag to ready using a previously issued token. It succeeds only once and only for a currently active token.

**Data flow**: It first checks `load_ready` and returns `Ok(false)` if already ready. It also rejects `Token(0)` immediately with `Ok(false)`. Otherwise it calls `with_tokens` with a closure that removes the token from the set; if removal fails it returns false, and if it succeeds it stores `true` into `self.ready` with `Ordering::Release`, clears the remaining token set, and returns true. After the lock is released, a successful transition triggers a best-effort `self.tx.send(true)`, and the method returns `Ok(true)`; invalid or reused tokens yield `Ok(false)`.

**Call relations**: This is the state-transition counterpart to `subscribe`. It uses `with_tokens` to serialize token validation and mutation, and its watch send is what wakes tasks blocked in `wait_ready`.

*Call graph*: calls 2 internal fn (load_ready, with_tokens); 1 external calls (send).


##### `ReadinessFlag::wait_ready`  (lines 171–186)

```
async fn wait_ready(&self)
```

**Purpose**: Asynchronously waits until the flag becomes ready. It uses both a synchronous fast path and a watch-channel slow path.

**Data flow**: It first calls `is_ready`; if that returns true, it exits immediately. Otherwise it creates a watch receiver with `self.tx.subscribe()`, checks `*rx.borrow()` for a preexisting true value, and if still false loops on `rx.changed().await`, breaking once `*rx.borrow()` becomes true or the sender side closes.

**Call relations**: This method is used by tasks that need to block until readiness. It depends on `is_ready` for the immediate path and on the watch notifications emitted by `is_ready` and `mark_ready` when they perform the transition.

*Call graph*: calls 1 internal fn (is_ready); 1 external calls (subscribe).


##### `tests::subscribe_and_mark_ready_roundtrip`  (lines 213–220)

```
async fn subscribe_and_mark_ready_roundtrip() -> Result<(), ReadinessError>
```

**Purpose**: Checks the normal lifecycle of subscribing, marking ready with the returned token, and observing the ready state. It verifies the happy path end to end.

**Data flow**: The test creates a new `ReadinessFlag`, awaits `subscribe` to obtain a token, awaits `mark_ready(token)` and asserts it returned true, then asserts `is_ready()` is true and returns `Ok(())`.

**Call relations**: This test exercises the intended interaction between `new`, `subscribe`, `mark_ready`, and `is_ready`.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert!).


##### `tests::subscribe_after_ready_returns_none`  (lines 223–230)

```
async fn subscribe_after_ready_returns_none() -> Result<(), ReadinessError>
```

**Purpose**: Verifies that once readiness has been established, further subscriptions are rejected. It confirms the one-way nature of the flag.

**Data flow**: It creates a flag, subscribes once, marks ready with that token, then awaits a second `subscribe` and asserts that it returns an error.

**Call relations**: This test covers the post-transition branch in `subscribe` after `mark_ready` has already flipped the atomic ready bit.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert!).


##### `tests::mark_ready_rejects_unknown_token`  (lines 233–239)

```
async fn mark_ready_rejects_unknown_token() -> Result<(), ReadinessError>
```

**Purpose**: Ensures that an arbitrary token not present in the subscription set cannot authorize readiness. It also demonstrates the special `is_ready` behavior when there are no subscribers.

**Data flow**: It creates a flag, calls `mark_ready(Token(42))` and asserts the result is false, asserts `load_ready()` is still false, then calls `is_ready()` and asserts that it returns true.

**Call relations**: This test exercises the invalid-token path in `mark_ready` and then the empty-subscriber auto-ready path in `is_ready`.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert!).


##### `tests::wait_ready_unblocks_after_mark_ready`  (lines 242–256)

```
async fn wait_ready_unblocks_after_mark_ready() -> Result<(), ReadinessError>
```

**Purpose**: Checks that a task waiting on readiness is released after a valid token marks the flag ready. It validates the watch-channel notification path.

**Data flow**: It wraps a new `ReadinessFlag` in `Arc`, subscribes to get a token, spawns a Tokio task that awaits `wait_ready`, then marks ready with the token and awaits the spawned task, asserting it did not panic.

**Call relations**: This test ties together `subscribe`, `wait_ready`, `mark_ready`, and the internal watch sender/receiver behavior.

*Call graph*: calls 1 internal fn (new); 4 external calls (clone, new, assert!, spawn).


##### `tests::mark_ready_twice_uses_single_token`  (lines 259–266)

```
async fn mark_ready_twice_uses_single_token() -> Result<(), ReadinessError>
```

**Purpose**: Verifies that a token is single-use and cannot mark readiness twice. The second call should be a no-op failure.

**Data flow**: It creates a flag, subscribes for one token, asserts the first `mark_ready(token)` returns true, and asserts the second `mark_ready(token)` returns false.

**Call relations**: This test covers the token-removal logic inside `mark_ready`, specifically the branch where the token is no longer present.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert!).


##### `tests::is_ready_without_subscribers_marks_flag_ready`  (lines 269–279)

```
async fn is_ready_without_subscribers_marks_flag_ready() -> Result<(), ReadinessError>
```

**Purpose**: Confirms that calling `is_ready` on a flag with no subscribers permanently flips it to ready. It also verifies that later subscriptions are rejected.

**Data flow**: It creates a flag, asserts `is_ready()` twice, then awaits `subscribe()` and asserts it returns `ReadinessError::FlagAlreadyReady`.

**Call relations**: This test directly targets the special-case control flow in `is_ready` that auto-readies an unsubscribed flag.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert!, assert_matches!).


##### `tests::subscribe_returns_error_when_lock_is_held`  (lines 282–313)

```
async fn subscribe_returns_error_when_lock_is_held()
```

**Purpose**: Ensures that subscription fails with `TokenLockFailed` if the token mutex remains locked longer than the timeout. It validates the timeout wrapper around lock acquisition.

**Data flow**: It creates an `Arc<ReadinessFlag>`, starts a separate thread that acquires `flag.tokens.blocking_lock()` and holds it until signaled, waits until that lock is known to be held, then awaits `flag.subscribe()` and asserts the returned error matches `TokenLockFailed`. Finally it releases the lock-holding thread and joins it.

**Call relations**: This test specifically exercises `with_tokens` through `subscribe`, forcing the timeout branch rather than the normal lock-acquisition path.

*Call graph*: calls 1 internal fn (new); 5 external calls (clone, new, assert_matches!, channel, spawn).


##### `tests::subscribe_skips_zero_token`  (lines 316–324)

```
async fn subscribe_skips_zero_token() -> Result<(), ReadinessError>
```

**Purpose**: Verifies that token generation never returns `Token(0)`, even if the atomic counter is manually set to zero. This protects the reserved invalid token value.

**Data flow**: It creates a flag, stores `0` into `next_id`, awaits `subscribe()` to get a token, asserts that token is not `Token(0)`, then marks ready with it and asserts success.

**Call relations**: This test targets the token-generation loop inside `subscribe`, specifically the branch that skips zero.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert!, assert_ne!).


##### `tests::subscribe_avoids_duplicate_tokens`  (lines 327–335)

```
async fn subscribe_avoids_duplicate_tokens() -> Result<(), ReadinessError>
```

**Purpose**: Checks that token generation avoids collisions if `next_id` is rewound to an already-issued value. It confirms uniqueness is enforced by the token set, not just the counter.

**Data flow**: It creates a flag, subscribes once to get `token`, stores `token.0` back into `next_id`, subscribes again, and asserts the second token differs from the first.

**Call relations**: This test exercises the collision-retry loop in `subscribe` where `tokens.insert(token)` can fail and generation must continue.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_ne!).


### `shell-escalation/src/unix/stopwatch.rs`

`domain_logic` · `cross-cutting`

This file defines `Stopwatch`, a clonable async timing primitive backed by shared state in `Arc<Mutex<StopwatchState>>` plus a `Notify` for waking the timeout task when pause/resume state changes. The state tracks cumulative `elapsed` time, an optional `running_since` instant when the clock is currently active, and a reference count of `active_pauses` so overlapping pauses do not resume the clock prematurely.

`Stopwatch::new` starts the clock immediately with a finite `limit`; `Stopwatch::unlimited` uses the same running state but stores `None` for the limit. `cancellation_token` creates a fresh `CancellationToken` and, when a limit exists, spawns a background task that repeatedly computes effective elapsed time as stored elapsed plus the current running segment. If the limit has been reached, it cancels the token. If the stopwatch is paused, the task waits on `notify`; if running, it sleeps only for the remaining duration but also listens for `notify` so a pause/resume recalculates the deadline.

`pause_for` wraps an arbitrary future, incrementing the pause count before awaiting it and decrementing afterward. The internal `pause` and `resume` methods update elapsed time and `running_since` only on transitions between zero and nonzero pause counts, preserving the invariant that nested pauses are reference-counted. Tests cover normal timeout firing, pause suppression, overlapping pauses, and the unlimited mode that never cancels.

#### Function details

##### `Stopwatch::new`  (lines 25–35)

```
fn new(limit: Duration) -> Self
```

**Purpose**: Constructs a stopwatch with a finite timeout budget and starts it immediately. The initial state has zero elapsed time, a live `running_since` timestamp, and no active pauses.

**Data flow**: It takes a `Duration` limit, allocates shared `StopwatchState` inside `Arc<Mutex<_>>`, creates a `Notify`, stores `Some(limit)`, and returns the assembled `Stopwatch`.

**Call relations**: Callers use this when they need cancellation after a bounded amount of active time; tests and escalation flows create it before obtaining a cancellation token.

*Call graph*: called by 8 (try_run_zsh_fork, denied_reads_keep_granular_sandbox_rejection_for_escalation, denied_reads_keep_prefix_rule_allow_inside_sandbox, execve_permission_request_hook_short_circuits_prompt, preapproved_additional_permissions_escalate_intercepted_exec, cancellation_receiver_fires_after_limit, overlapping_pauses_only_resume_once, pause_prevents_timeout_until_resumed); 4 external calls (new, now, new, new).


##### `Stopwatch::unlimited`  (lines 37–47)

```
fn unlimited() -> Self
```

**Purpose**: Constructs a stopwatch that tracks pause/resume state but never triggers cancellation. It shares the same internal state shape as the finite version, with `limit` set to `None`.

**Data flow**: It initializes `elapsed` to zero, `running_since` to `Some(Instant::now())`, `active_pauses` to zero, wraps the state and notifier in `Arc`, stores `limit: None`, and returns the `Stopwatch`.

**Call relations**: This variant is used where the pauseable timing API is needed but no deadline should ever fire; the cancellation-token path short-circuits for it.

*Call graph*: called by 2 (prepare_unified_exec_zsh_fork, unlimited_stopwatch_never_cancels); 4 external calls (new, now, new, new).


##### `Stopwatch::cancellation_token`  (lines 49–91)

```
fn cancellation_token(&self) -> CancellationToken
```

**Purpose**: Creates a token that will be cancelled once the stopwatch’s active running time reaches its configured limit. It spawns the monitoring task that reacts to both elapsed time and pause/resume transitions.

**Data flow**: It creates a new `CancellationToken`. If `self.limit` is `None`, it returns that token immediately and spawns nothing. Otherwise it clones the token, shared mutex, and notifier into a background task. That task repeatedly locks state, computes effective elapsed time from stored `elapsed` plus any current running segment, breaks if the limit is reached, waits on `notify` while paused, or sleeps for the remaining duration while also selecting on `notify` to recompute after state changes. When the loop exits, it calls `cancel()` on the cloned token. The original token is returned to the caller.

**Call relations**: Consumers call this after constructing a stopwatch to obtain a cancellation signal. Its internal task depends on `pause`/`resume` notifying waiters whenever the running state changes.

*Call graph*: 6 external calls (clone, new, pin!, select!, spawn, sleep).


##### `Stopwatch::pause_for`  (lines 97–105)

```
async fn pause_for(&self, fut: F) -> T
```

**Purpose**: Runs an arbitrary future while excluding its pending time from the stopwatch budget. It provides the ergonomic public API for temporary pauses.

**Data flow**: It takes `&self` and a future `F`, awaits `self.pause()`, awaits the supplied future to completion, then awaits `self.resume()` and returns the future’s output `T` unchanged.

**Call relations**: Higher-level code wraps operations such as prompts with this method so timeout accounting stops while waiting. Internally it is just structured sequencing around `pause` and `resume`.

*Call graph*: calls 2 internal fn (pause, resume); called by 1 (prompt).


##### `Stopwatch::pause`  (lines 107–116)

```
async fn pause(&self)
```

**Purpose**: Marks one active pause on the stopwatch and, on the first pause transition, freezes the running clock into accumulated elapsed time. Nested pauses only increment the reference count.

**Data flow**: It locks the shared `StopwatchState`, increments `active_pauses`, and if this was the first active pause and `running_since` was `Some`, it takes that instant, adds its elapsed duration into `elapsed`, clears `running_since`, and notifies waiters via `Notify`.

**Call relations**: This private helper is called by `pause_for`. Its notifications wake the cancellation task so it stops sleeping against an outdated deadline when the stopwatch becomes paused.

*Call graph*: called by 1 (pause_for).


##### `Stopwatch::resume`  (lines 118–128)

```
async fn resume(&self)
```

**Purpose**: Lifts one active pause and, when the last pause is removed, restarts the running clock from the current instant. Extra resumes when not paused are ignored.

**Data flow**: It locks the shared state, returns immediately if `active_pauses` is already zero, otherwise decrements the count. If the count reaches zero and `running_since` is `None`, it sets `running_since = Some(Instant::now())` and notifies waiters.

**Call relations**: This private helper is paired with `pause` inside `pause_for`. Its notifications wake the cancellation task so it can begin sleeping for the newly resumed remaining duration.

*Call graph*: called by 1 (pause_for); 1 external calls (now).


##### `tests::cancellation_receiver_fires_after_limit`  (lines 140–146)

```
async fn cancellation_receiver_fires_after_limit()
```

**Purpose**: Checks that a finite stopwatch cancels only after at least the configured duration has elapsed. It validates the basic timeout path without pauses.

**Data flow**: The test creates a 50 ms stopwatch, obtains its cancellation token, records a start instant, awaits `token.cancelled()`, and asserts that the measured elapsed time is at least 50 ms.

**Call relations**: It exercises `Stopwatch::new` and `Stopwatch::cancellation_token` together in the simplest running-only scenario.

*Call graph*: calls 1 internal fn (new); 3 external calls (from_millis, now, assert!).


##### `tests::pause_prevents_timeout_until_resumed`  (lines 149–173)

```
async fn pause_prevents_timeout_until_resumed()
```

**Purpose**: Verifies that pausing the stopwatch suppresses cancellation while the wrapped future is pending and that cancellation resumes afterward. It covers the pause/resume wakeup path.

**Data flow**: The test creates a 50 ms stopwatch and token, spawns a task that clones the stopwatch and calls `pause_for` around a 100 ms sleep, then asserts via `timeout(30 ms, token.cancelled())` that cancellation has not fired during the pause. After the pause task completes, it awaits `token.cancelled()` successfully.

**Call relations**: It drives `pause_for`, which in turn uses `pause` and `resume`, and confirms that the cancellation task reacts correctly to notifier-driven state changes.

*Call graph*: calls 1 internal fn (new); 4 external calls (from_millis, assert!, spawn, sleep).


##### `tests::overlapping_pauses_only_resume_once`  (lines 176–224)

```
async fn overlapping_pauses_only_resume_once()
```

**Purpose**: Ensures overlapping pauses are reference-counted so the stopwatch remains paused until all pause scopes finish. It validates the `active_pauses` invariant.

**Data flow**: The test creates a finite stopwatch and token, spawns one long `pause_for` sleep and one shorter overlapping `pause_for` sleep, asserts cancellation does not fire while both are active, awaits the shorter pause and asserts cancellation still does not fire, then awaits the longer pause and finally awaits token cancellation.

**Call relations**: It specifically exercises the transition logic in `pause` and `resume`, proving that only the final resume restarts the clock.

*Call graph*: calls 1 internal fn (new); 4 external calls (from_millis, assert!, spawn, sleep).


##### `tests::unlimited_stopwatch_never_cancels`  (lines 227–236)

```
async fn unlimited_stopwatch_never_cancels()
```

**Purpose**: Confirms that the unlimited stopwatch variant never triggers cancellation. It checks the early-return branch in `cancellation_token`.

**Data flow**: The test creates `Stopwatch::unlimited()`, obtains a token, and asserts that `timeout(30 ms, token.cancelled())` expires instead of completing.

**Call relations**: It validates that `Stopwatch::cancellation_token` does not spawn a cancelling task when `limit` is `None`.

*Call graph*: calls 1 internal fn (unlimited); 1 external calls (assert!).


### Sleep inhibition backends
These files expose the cross-platform sleep-inhibition API and its platform-specific or no-op implementations.

### `utils/sleep-inhibitor/src/lib.rs`

`orchestration` · `turn lifecycle; active whenever the application starts or stops a turn`

This file is the façade for the sleep-prevention utility crate. Conditional compilation selects one backend module per target OS—`linux_inhibitor`, `macos`, `windows_inhibitor`, or a dummy no-op implementation—and aliases it as `imp`, so the public `SleepInhibitor` type can expose one uniform interface regardless of platform. The struct stores three pieces of state: the caller-configured `enabled` flag, the latest requested `turn_running` boolean, and the backend-specific `platform` inhibitor instance.

The key behavior lives in `set_turn_running`. It always records the caller’s requested turn state first, even when inhibition is disabled. If `enabled` is false, it proactively calls `release` and returns, ensuring any previously held OS assertion/process/request is dropped. If enabled, it acquires inhibition when `turn_running` becomes true and releases it when false. The wrapper itself does not implement idempotence; instead it delegates repeated acquire/release calls to the backend, whose implementations are expected to tolerate redundant transitions safely.

The tests focus on API-level guarantees rather than backend internals: toggling should not panic, disabled mode should still remember the requested turn state, repeated `true` updates should be harmless, and multiple on/off transitions should remain stable. This makes the file the stable contract boundary between application logic and platform-specific power-management code.

#### Function details

##### `SleepInhibitor::new`  (lines 37–43)

```
fn new(enabled: bool) -> Self
```

**Purpose**: Constructs the public inhibitor wrapper with a caller-supplied enable flag and a fresh platform backend. It starts in a non-running state regardless of platform.

**Data flow**: Consumes `enabled: bool` from the caller, initializes `turn_running` to `false`, creates `platform` via the selected backend's `new`, and returns a fully initialized `SleepInhibitor` value without side effects beyond backend construction.

**Call relations**: This is the entry into the crate’s API and is used directly by tests and application code before any turn-state updates. Its only delegation is backend initialization so later `set_turn_running` calls have a concrete OS-specific implementation to talk to.

*Call graph*: calls 1 internal fn (new).


##### `SleepInhibitor::set_turn_running`  (lines 46–58)

```
fn set_turn_running(&mut self, turn_running: bool)
```

**Purpose**: Updates the remembered turn state and synchronizes OS sleep inhibition with that state. Disabled mode always forces release, while enabled mode maps `true` to acquire and `false` to release.

**Data flow**: Takes `&mut self` and `turn_running: bool`, writes the new value into `self.turn_running`, reads `self.enabled`, and then either calls `release` immediately when disabled or branches to `acquire`/`release` based on the requested state. It returns `()` and mutates backend state indirectly through those helper calls.

**Call relations**: This is the main control point invoked by higher-level turn orchestration. It delegates the actual OS interaction to `SleepInhibitor::acquire` and `SleepInhibitor::release`, which in turn forward to the platform backend.

*Call graph*: calls 2 internal fn (acquire, release).


##### `SleepInhibitor::acquire`  (lines 60–62)

```
fn acquire(&mut self)
```

**Purpose**: Forwards an acquire request to the selected platform implementation. It exists as a small wrapper around the backend field.

**Data flow**: Reads and mutably borrows `self.platform`, invokes its `acquire` method, and returns `()`. No wrapper-level fields are changed here.

**Call relations**: It is only reached from `SleepInhibitor::set_turn_running` when inhibition is enabled and the requested turn state is active. Delegation is intentionally thin so platform-specific idempotence and error handling stay in backend modules.

*Call graph*: calls 1 internal fn (acquire); called by 1 (set_turn_running).


##### `SleepInhibitor::release`  (lines 64–66)

```
fn release(&mut self)
```

**Purpose**: Forwards a release request to the selected platform implementation. It drops any active inhibition held by the backend.

**Data flow**: Reads and mutably borrows `self.platform`, invokes its `release` method, and returns `()`. Wrapper state is unchanged except for whatever `set_turn_running` already recorded.

**Call relations**: It is called from `SleepInhibitor::set_turn_running` both when a turn ends and when inhibition is globally disabled. Like `acquire`, it delegates all concrete cleanup behavior to the backend.

*Call graph*: calls 1 internal fn (release); called by 1 (set_turn_running).


##### `SleepInhibitor::is_turn_running`  (lines 69–71)

```
fn is_turn_running(&self) -> bool
```

**Purpose**: Reports the last turn-running value requested by the caller. It does not inspect backend state or infer whether inhibition actually succeeded.

**Data flow**: Reads `self.turn_running` and returns that boolean unchanged. It performs no mutation and no backend calls.

**Call relations**: This accessor is used by tests and can be used by callers that need to confirm the wrapper’s remembered state after `set_turn_running` calls.


##### `tests::sleep_inhibitor_toggles_without_panicking`  (lines 79–85)

```
fn sleep_inhibitor_toggles_without_panicking()
```

**Purpose**: Verifies that an enabled inhibitor can be turned on and off without panicking and that the wrapper remembers the requested state transitions.

**Data flow**: Creates a `SleepInhibitor` with `enabled = true`, sends `true` then `false` through `set_turn_running`, and asserts on `is_turn_running` after each transition. It writes only local test variables.

**Call relations**: This test exercises the normal public API path from construction through both branches of `set_turn_running`.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert!).


##### `tests::sleep_inhibitor_disabled_does_not_panic`  (lines 88–94)

```
fn sleep_inhibitor_disabled_does_not_panic()
```

**Purpose**: Checks that disabled mode still accepts turn-state updates without panicking and still records the requested state for inspection.

**Data flow**: Constructs a disabled `SleepInhibitor`, calls `set_turn_running(true)` and `set_turn_running(false)`, and asserts that `is_turn_running` mirrors those requests even though backend inhibition should be suppressed.

**Call relations**: This test specifically covers the early-return disabled branch inside `set_turn_running`.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert!).


##### `tests::sleep_inhibitor_multiple_true_calls_are_idempotent`  (lines 97–103)

```
fn sleep_inhibitor_multiple_true_calls_are_idempotent()
```

**Purpose**: Confirms that repeated requests to keep the turn running do not crash or destabilize the wrapper/backend combination.

**Data flow**: Builds an enabled inhibitor, calls `set_turn_running(true)` three times, then `set_turn_running(false)`, and relies on absence of panic as the success condition.

**Call relations**: This test stresses repeated traversal of the acquire path, validating the expectation that backend implementations tolerate redundant acquire requests.

*Call graph*: calls 1 internal fn (new).


##### `tests::sleep_inhibitor_can_toggle_multiple_times`  (lines 106–112)

```
fn sleep_inhibitor_can_toggle_multiple_times()
```

**Purpose**: Checks that the inhibitor can cycle through multiple acquire/release transitions in sequence without failure.

**Data flow**: Creates an enabled inhibitor and alternates `set_turn_running(true)` and `set_turn_running(false)` twice. It returns no value and asserts success by completing without panic.

**Call relations**: This test covers repeated use of the public state-transition API across multiple turn boundaries.

*Call graph*: calls 1 internal fn (new).


### `utils/sleep-inhibitor/src/dummy.rs`

`util` · `cross-cutting; active whenever sleep inhibition is toggled on unsupported builds`

This file defines a minimal placeholder `SleepInhibitor` type with `Debug` and `Default` derives and three trivial methods. `new` returns an empty `SleepInhibitor` value, while `acquire` and `release` are both intentional no-ops. There is no internal state, no reference counting, and no interaction with the operating system.

The value of this file is architectural rather than algorithmic: it lets higher-level code compile against a uniform sleep-inhibition interface regardless of target platform or feature set. Callers can freely construct the type and toggle prevention on and off without needing conditional logic around unsupported environments. Because both transition methods are empty, repeated calls are naturally idempotent and cannot fail or panic. The tests that reference this implementation are therefore checking API stability and harmlessness rather than actual power-management behavior.

#### Function details

##### `SleepInhibitor::new`  (lines 5–7)

```
fn new() -> Self
```

**Purpose**: Constructs the dummy inhibitor value. It exists to match the constructor shape of real platform-specific implementations.

**Data flow**: It takes no arguments and returns `Self`, which is the zero-sized `SleepInhibitor` struct. No state is read or written.

**Call relations**: This constructor is used by higher-level sleep-inhibitor setup code and by tests that verify toggling behavior does not panic.

*Call graph*: called by 7 (new, set_prevent_idle_sleep, new, sleep_inhibitor_can_toggle_multiple_times, sleep_inhibitor_disabled_does_not_panic, sleep_inhibitor_multiple_true_calls_are_idempotent, sleep_inhibitor_toggles_without_panicking).


##### `SleepInhibitor::acquire`  (lines 9–9)

```
fn acquire(&mut self)
```

**Purpose**: Pretends to acquire a sleep inhibition lock but intentionally does nothing. It is a compatibility stub.

**Data flow**: It takes `&mut self`, performs no reads or writes, and returns unit.

**Call relations**: This method is invoked by the higher-level `acquire` path so callers can use the same API regardless of whether a real inhibitor exists.

*Call graph*: called by 1 (acquire).


##### `SleepInhibitor::release`  (lines 11–11)

```
fn release(&mut self)
```

**Purpose**: Pretends to release a sleep inhibition lock but intentionally does nothing. It complements the no-op `acquire` method.

**Data flow**: It takes `&mut self`, performs no reads or writes, and returns unit.

**Call relations**: This method is invoked by the higher-level `release` path and supports repeated toggling without side effects.

*Call graph*: called by 1 (release).


### `utils/sleep-inhibitor/src/iokit_bindings.rs`

`generated` · `cross-cutting`

This file is a bindgen-generated Rust declaration layer over a tiny subset of Apple’s IOKit power-management API. It does not implement any logic itself; instead, it defines the exact C-compatible types, constants, and extern function signatures that higher-level Rust code can call through `unsafe` FFI. The file introduces an opaque `__CFString` marker struct and the pointer alias `CFStringRef`, preserving CoreFoundation’s reference semantics without exposing internals. It also maps kernel and IOKit return types through `kern_return_t` and `IOReturn`, and defines the assertion identifier and level types used by the power-management API. Two assertion-level constants are exposed: `kIOPMAssertionLevelOff` and `kIOPMAssertionLevelOn`, with the latter using the platform’s expected `255` value rather than a boolean. The exported functions are `IOPMAssertionCreateWithName`, which creates a named assertion of a given type and writes back an `IOPMAssertionID`, and `IOPMAssertionRelease`, which tears down a previously created assertion. `kIOReturnSuccess` is provided so callers can compare native return codes directly. Because this file is generated, its main design constraint is ABI fidelity: `#[repr(C)]`, raw pointers, and exact integer widths matter more than ergonomics.


### `utils/sleep-inhibitor/src/linux_inhibitor.rs`

`io_transport` · `during active turns on Linux and during cleanup/drop`

This file contains the Linux backend behind the public sleep-inhibitor API. `LinuxSleepInhibitor` stores an `InhibitState` enum, an optional `preferred_backend` remembered from the last successful launch, and a `missing_backend_logged` flag used to suppress repeated warning spam when no helper binary is available. The active state carries both the chosen `LinuxBackend` and the spawned `Child` process that keeps the machine awake by running a very long `sleep` command under an inhibitor wrapper.

`acquire` first checks whether an existing child is still alive with `try_wait`. If it is, the call is a no-op; if it exited or cannot be queried, the code logs a warning and attempts recovery. It then resets state to inactive, computes backend trial order based on `preferred_backend`, and tries each backend via `spawn_backend`. After spawning, it probes the child immediately: a still-running child becomes the new active state and preferred backend; an immediately exited child or status-probe failure triggers warnings and cleanup. Startup failures due to missing executables are intentionally quiet after the first global “no backend available” warning.

`release` uses `mem::take` to atomically remove the current state, then kills and waits on the child if one exists, treating `InvalidInput` errors as benign evidence that the child already exited. `spawn_backend` also installs a Linux parent-death signal with `prctl(PR_SET_PDEATHSIG, SIGTERM)` in `pre_exec`, plus a `getppid` check to close the fork/exec race, so helper processes do not outlive the original parent unexpectedly.

#### Function details

##### `LinuxSleepInhibitor::new`  (lines 39–41)

```
fn new() -> Self
```

**Purpose**: Creates a Linux inhibitor with no active child process, no preferred backend, and no prior missing-backend warning state.

**Data flow**: Takes no arguments, delegates to `Default`, and returns a `LinuxSleepInhibitor` whose `state` is `Inactive`, `preferred_backend` is `None`, and `missing_backend_logged` is `false`.

**Call relations**: This constructor is called by the cross-platform wrapper during initialization so later acquire/release requests have Linux-specific state to mutate.

*Call graph*: 1 external calls (default).


##### `LinuxSleepInhibitor::acquire`  (lines 43–143)

```
fn acquire(&mut self)
```

**Purpose**: Ensures a live Linux inhibition helper process is running, restarting or falling back between backends when necessary. It also suppresses repeated warning noise once backend absence has already been reported.

**Data flow**: Mutably reads and updates `self.state`, `self.preferred_backend`, and `self.missing_backend_logged`. It first probes any active `Child` with `try_wait`; if still alive it returns immediately. Otherwise it resets state to `Inactive`, computes an ordered backend list, calls `spawn_backend` for each candidate, probes each spawned child with `try_wait`, stores a successful `(backend, child)` pair back into `self.state`, updates `preferred_backend`, and clears `missing_backend_logged`. On failures it emits warnings, may kill/wait failed children, and if no backend works it sets `missing_backend_logged = true` after a final warning.

**Call relations**: This method is invoked by the public wrapper when a turn starts. It delegates process creation to `spawn_backend` and uses `child_exited` to classify kill/wait errors that should be ignored during recovery and cleanup.

*Call graph*: calls 2 internal fn (child_exited, spawn_backend); 1 external calls (warn!).


##### `LinuxSleepInhibitor::release`  (lines 145–161)

```
fn release(&mut self)
```

**Purpose**: Stops and reaps any active inhibition helper process, leaving the backend inactive. It is safe to call when no child is running.

**Data flow**: Uses `std::mem::take(&mut self.state)` to replace current state with `Inactive`, then matches the old state. For `Active`, it attempts `child.kill()` and `child.wait()`, logging only when errors are not classified by `child_exited` as an already-exited child. It returns `()` and leaves `self.state` inactive.

**Call relations**: This is called explicitly by the public wrapper when a turn ends or inhibition is disabled, and implicitly from `LinuxSleepInhibitor::drop` to guarantee child cleanup on object destruction.

*Call graph*: calls 1 internal fn (child_exited); called by 1 (drop); 2 external calls (take, warn!).


##### `LinuxSleepInhibitor::drop`  (lines 165–167)

```
fn drop(&mut self)
```

**Purpose**: Provides RAII cleanup so any active helper process is terminated when the backend object is dropped.

**Data flow**: Receives `&mut self`, calls `self.release()`, and returns `()`. All state mutation happens inside `release`.

**Call relations**: This destructor is the final cleanup path if callers forget to release explicitly; it funnels all shutdown logic through `LinuxSleepInhibitor::release`.

*Call graph*: calls 1 internal fn (release).


##### `spawn_backend`  (lines 170–226)

```
fn spawn_backend(backend: LinuxBackend) -> Result<Child, std::io::Error>
```

**Purpose**: Builds and spawns the concrete Linux helper command for a chosen backend, with stdio detached and parent-death signaling configured before exec.

**Data flow**: Takes a `LinuxBackend`, captures the current PID via `libc::getpid`, constructs a `Command` for either `systemd-inhibit --what=idle --mode=block --who codex --why ... -- sleep 2147483647` or `gnome-session-inhibit --inhibit idle --reason ... sleep 2147483647`, redirects stdin/stdout/stderr to `Stdio::null()`, registers a `pre_exec` closure that sets `PR_SET_PDEATHSIG` and self-terminates if the parent changed, then calls `spawn()` and returns `Result<Child, std::io::Error>`.

**Call relations**: It is only called from `LinuxSleepInhibitor::acquire` while trying candidate backends. Its job is isolated process setup so `acquire` can focus on supervision and fallback policy.

*Call graph*: called by 1 (acquire); 3 external calls (null, new, getpid).


##### `child_exited`  (lines 228–230)

```
fn child_exited(error: &std::io::Error) -> bool
```

**Purpose**: Classifies a specific `std::io::Error` kind as meaning the child has already exited. This avoids noisy warnings for benign kill/wait races.

**Data flow**: Reads a borrowed `std::io::Error`, checks whether `error.kind()` is `InvalidInput`, and returns a boolean.

**Call relations**: Both `LinuxSleepInhibitor::acquire` and `LinuxSleepInhibitor::release` use it when cleanup operations fail, to distinguish expected already-dead-child cases from real errors worth logging.

*Call graph*: called by 2 (acquire, release); 1 external calls (matches!).


##### `tests::sleep_seconds_is_i32_max`  (lines 237–239)

```
fn sleep_seconds_is_i32_max()
```

**Purpose**: Guards the long-running blocker duration constant against accidental drift from `i32::MAX` seconds.

**Data flow**: Reads `BLOCKER_SLEEP_SECONDS`, formats `i32::MAX` as a string, and asserts equality.

**Call relations**: This test validates the invariant relied on by `spawn_backend` when constructing the helper `sleep` command.

*Call graph*: 1 external calls (assert_eq!).


### `utils/sleep-inhibitor/src/macos.rs`

`io_transport` · `during active turns on macOS and when assertions are dropped`

This file is the macOS backend for the sleep-inhibitor crate. It embeds generated IOKit bindings in a private `iokit` module and defines local aliases for `IOPMAssertionID`, `IOPMAssertionLevel`, and `IOReturn` to make the FFI calls easier to read. The backend `SleepInhibitor` is intentionally minimal: it stores `assertion: Option<MacSleepAssertion>`, where presence means an active system sleep-prevention assertion is currently held.

`acquire` is idempotent at the backend level. If an assertion already exists, it returns immediately. Otherwise it calls `MacSleepAssertion::create` with the fixed reason string `Codex is running an active turn`. On success it stores the assertion; on failure it logs the raw IOKit error code with `tracing::warn` and leaves the backend inactive. `release` simply sets the option to `None`, relying on Rust drop semantics to release the underlying assertion.

`MacSleepAssertion::create` constructs two `CFString` values: one for the assertion type string `PreventUserIdleSystemSleep` and one for the human-readable reason. Because `core-foundation` and bindgen expose distinct opaque `__CFString` types, the code explicitly casts the concrete type refs to the bindgen `CFStringRef` aliases before calling `IOPMAssertionCreateWithName`. The returned assertion ID is wrapped only when the result equals `kIOReturnSuccess`; otherwise the raw error code is propagated. `Drop` for `MacSleepAssertion` calls `IOPMAssertionRelease` exactly once and warns if release fails.

#### Function details

##### `SleepInhibitor::new`  (lines 34–36)

```
fn new() -> Self
```

**Purpose**: Constructs an empty macOS backend with no active IOKit assertion.

**Data flow**: Takes no arguments, delegates to `Default`, and returns a `SleepInhibitor` whose `assertion` field is `None`.

**Call relations**: This constructor is called by the cross-platform wrapper during initialization before any acquire/release activity.

*Call graph*: 1 external calls (default).


##### `SleepInhibitor::acquire`  (lines 38–54)

```
fn acquire(&mut self)
```

**Purpose**: Creates and stores a macOS power assertion if one is not already active. Repeated acquire calls are harmless because an existing assertion short-circuits the method.

**Data flow**: Mutably reads `self.assertion`; if it is `Some`, returns immediately. Otherwise it calls `MacSleepAssertion::create(ASSERTION_REASON)`, stores the resulting assertion into `self.assertion` on success, or logs the returned `IOReturn` code on failure. It returns `()`.

**Call relations**: This method is invoked by the public wrapper when a turn starts on macOS. It delegates all FFI-heavy work to `MacSleepAssertion::create`.

*Call graph*: calls 1 internal fn (create); 1 external calls (warn!).


##### `SleepInhibitor::release`  (lines 56–58)

```
fn release(&mut self)
```

**Purpose**: Drops any active macOS assertion by clearing the stored option.

**Data flow**: Mutably sets `self.assertion = None` and returns `()`. If an assertion was present, its `Drop` implementation performs the actual IOKit release call.

**Call relations**: This is called by the public wrapper when a turn ends or inhibition is disabled, and it relies on `MacSleepAssertion::drop` for final cleanup.


##### `MacSleepAssertion::create`  (lines 67–90)

```
fn create(name: &str) -> Result<Self, IOReturn>
```

**Purpose**: Allocates a native IOKit assertion that prevents user-idle system sleep and wraps the returned assertion ID in a Rust owner type.

**Data flow**: Accepts `name: &str`, creates `CFString` values for the assertion type and assertion name, casts them to the bindgen `CFStringRef` type, initializes a mutable `id` out-parameter, and calls `IOPMAssertionCreateWithName`. If the result equals `kIOReturnSuccess`, it returns `Ok(MacSleepAssertion { id })`; otherwise it returns `Err(result)` with the raw `IOReturn` code.

**Call relations**: It is called only from `SleepInhibitor::acquire`, isolating the unsafe FFI boundary and Core Foundation conversion details from the higher-level backend logic.

*Call graph*: called by 1 (acquire); 2 external calls (new, IOPMAssertionCreateWithName).


##### `MacSleepAssertion::drop`  (lines 94–106)

```
fn drop(&mut self)
```

**Purpose**: Releases the owned IOKit assertion when the Rust wrapper goes out of scope. It logs but otherwise ignores release failures.

**Data flow**: Reads `self.id`, calls `IOPMAssertionRelease(self.id)` in an unsafe block, compares the result against `kIOReturnSuccess`, and emits a warning containing the returned error code if release failed.

**Call relations**: This destructor runs when `SleepInhibitor::release` clears the option or when the backend itself is dropped, providing the actual native cleanup path.

*Call graph*: 2 external calls (IOPMAssertionRelease, warn!).


### `utils/sleep-inhibitor/src/windows_inhibitor.rs`

`io_transport` · `during active turns on Windows and during request-handle cleanup`

This file provides the Windows backend for the sleep-inhibitor crate. `WindowsSleepInhibitor` stores `request: Option<PowerRequest>`, where `PowerRequest` owns both the raw Windows handle and the `POWER_REQUEST_TYPE` that was set on it. The backend mirrors the macOS design: presence of the option means inhibition is active, and dropping the owned request performs cleanup.

`acquire` is idempotent. If `request` is already `Some`, it returns immediately. Otherwise it calls `PowerRequest::new_system_required` with the fixed reason string and stores the resulting owner on success. Failures are converted into human-readable strings and logged with `tracing::warn`, leaving the backend inactive.

`PowerRequest::new_system_required` prepares a UTF-16, NUL-terminated reason string using `OsStrExt::encode_wide` and `once(0)`, then embeds its mutable pointer in a `REASON_CONTEXT` configured as `POWER_REQUEST_CONTEXT_SIMPLE_STRING`. It calls `PowerCreateRequest`, rejects null or `INVALID_HANDLE_VALUE`, and then calls `PowerSetRequest` with `PowerRequestSystemRequired`, matching the macOS behavior of preventing idle system sleep without forcing the display to remain on. If `PowerSetRequest` fails, it closes the handle before returning an error string.

Cleanup is centralized in `Drop` for `PowerRequest`: it first calls `PowerClearRequest` for the stored request type, then `CloseHandle` on the owned handle, logging OS errors from either step. `WindowsSleepInhibitor::release` simply sets the option to `None`, triggering that destructor.

#### Function details

##### `WindowsSleepInhibitor::new`  (lines 27–29)

```
fn new() -> Self
```

**Purpose**: Constructs an empty Windows backend with no active power request handle.

**Data flow**: Takes no arguments, delegates to `Default`, and returns a `WindowsSleepInhibitor` whose `request` field is `None`.

**Call relations**: This constructor is called by the cross-platform wrapper before any turn-state transitions occur.

*Call graph*: 1 external calls (default).


##### `WindowsSleepInhibitor::acquire`  (lines 31–47)

```
fn acquire(&mut self)
```

**Purpose**: Creates and stores a Windows system-required power request if one is not already active. Repeated acquire calls are intentionally no-ops once a request exists.

**Data flow**: Mutably reads `self.request`; if already `Some`, returns immediately. Otherwise it calls `PowerRequest::new_system_required(ASSERTION_REASON)`, stores the resulting `PowerRequest` into `self.request` on success, or logs the returned error string on failure.

**Call relations**: This method is invoked by the public wrapper when a turn starts on Windows. It delegates all Win32 API interaction and handle setup to `PowerRequest::new_system_required`.

*Call graph*: calls 1 internal fn (new_system_required); 1 external calls (warn!).


##### `WindowsSleepInhibitor::release`  (lines 49–51)

```
fn release(&mut self)
```

**Purpose**: Drops any active Windows power request by clearing the stored owner.

**Data flow**: Mutably sets `self.request = None` and returns `()`. If a request was present, its `Drop` implementation clears the request and closes the handle.

**Call relations**: This is called by the public wrapper when a turn ends or inhibition is disabled, and it relies on `PowerRequest::drop` for actual Win32 cleanup.


##### `PowerRequest::new_system_required`  (lines 61–95)

```
fn new_system_required(reason: &str) -> Result<Self, String>
```

**Purpose**: Allocates a Win32 power request handle and marks it as `PowerRequestSystemRequired`, returning a Rust owner on success or a formatted error string on failure.

**Data flow**: Accepts `reason: &str`, converts it to a mutable UTF-16 buffer terminated with `0`, builds a `REASON_CONTEXT` pointing at that buffer, calls `PowerCreateRequest`, validates the returned handle against null and `INVALID_HANDLE_VALUE`, then calls `PowerSetRequest(handle, PowerRequestSystemRequired)`. On `PowerSetRequest` failure it fetches `last_os_error`, closes the handle, and returns `Err(String)`; on success it returns `Ok(PowerRequest { handle, request_type })`.

**Call relations**: It is called only from `WindowsSleepInhibitor::acquire`, encapsulating all unsafe Win32 setup and error formatting away from the higher-level backend state machine.

*Call graph*: called by 1 (acquire); 7 external calls (new, last_os_error, format!, once, CloseHandle, PowerCreateRequest, PowerSetRequest).


##### `PowerRequest::drop`  (lines 99–118)

```
fn drop(&mut self)
```

**Purpose**: Clears the active Windows power request and closes its handle when the owner is dropped. It logs failures from either cleanup step but does not retry.

**Data flow**: Reads `self.handle` and `self.request_type`, calls `PowerClearRequest`, logs `last_os_error` if that returns `0`, then calls `CloseHandle` and logs `last_os_error` if that also returns `0`.

**Call relations**: This destructor is triggered when `WindowsSleepInhibitor::release` clears the option or when the backend itself is dropped, providing the actual resource-release path.

*Call graph*: 4 external calls (last_os_error, warn!, CloseHandle, PowerClearRequest).


### Runtime and UI support helpers
These files supply compact support utilities for runtime value conversion, replay filtering, frame-rate limiting, and lightweight caching.

### `code-mode/src/runtime/value.rs`

`util` · `cross-cutting during callback argument/result conversion`

This file centralizes the runtime’s coercion rules so callback code stays small and consistent. `serialize_output_text` defines how arbitrary JS values become output strings: primitives are converted with `to_rust_string_lossy`, while objects are first passed through `JSON.stringify` inside a `TryCatch`, falling back to string coercion if stringify returns `None` without throwing. `v8_value_to_json` and `json_to_v8` implement the bidirectional bridge between V8 values and `serde_json::Value`, using JSON stringify/parse as the interchange format.

The most nuanced logic is image handling. `normalize_output_image` accepts either a raw string URL, an object with `image_url` and optional `detail`, or a raw MCP image block. It rejects empty URLs and any `http://` or `https://` remote URL, forcing callers to provide base64 data URIs. It also normalizes detail strings to the `ImageDetail` enum, defaulting to `DEFAULT_IMAGE_DETAIL` when absent. Parsing is split between `parse_non_mcp_output_image`, `parse_mcp_output_image`, and `parse_image_detail_value`. The MCP path accepts `type: "image"`, `data`, optional `mimeType`/`mime_type`, and optional `_meta["codex/imageDetail"]`, synthesizing a `data:<mime>;base64,<data>` URI when the payload is not already a data URI.

`value_to_error_text` prefers an object’s `stack` property when present, which preserves JS stack traces in runtime errors. `throw_type_error` is a small helper that throws a plain string exception into V8.

#### Function details

##### `serialize_output_text`  (lines 11–37)

```
fn serialize_output_text(
    scope: &mut v8::PinScope<'_, '_>,
    value: v8::Local<'_, v8::Value>,
) -> Result<String, String>
```

**Purpose**: Converts a V8 value into the text form used by `text()` and `notify()`, preferring JSON serialization for objects.

**Data flow**: Checks whether the value is `undefined`, `null`, boolean, number, bigint, or string; those are converted directly with `to_rust_string_lossy(scope)`. For other values it enters a `TryCatch`, attempts `v8::json::stringify`, returns the resulting string when available, returns a converted exception string if stringify threw, and otherwise falls back to `to_rust_string_lossy` on the original value.

**Call relations**: Called by `callbacks::text_callback` and `callbacks::notify_callback` so both helpers share identical coercion and error behavior.

*Call graph*: called by 2 (notify_callback, text_callback); 9 external calls (is_big_int, is_boolean, is_null, is_number, is_string, is_undefined, to_rust_string_lossy, pin!, stringify).


##### `normalize_output_image`  (lines 39–96)

```
fn normalize_output_image(
    scope: &mut v8::PinScope<'_, '_>,
    value: v8::Local<'_, v8::Value>,
    detail_override: Option<String>,
) -> Result<FunctionCallOutputContentItem, ()>
```

**Purpose**: Validates and normalizes supported image helper inputs into a `FunctionCallOutputContentItem::InputImage`, throwing a JS type error on invalid input.

**Data flow**: Accepts a V8 value plus an optional detail override. Inside an inner `Result` closure, it interprets a string as `image_url`, an object as either a non-MCP image object via `parse_non_mcp_output_image` or a raw MCP image block via `parse_mcp_output_image`, and rejects all other shapes. It rejects empty URLs and remote `http/https` URLs, applies `detail_override.or(detail)`, normalizes accepted detail strings (`auto`, `low`, `high`, `original`) into `ImageDetail`, defaults missing detail to `DEFAULT_IMAGE_DETAIL`, and constructs `FunctionCallOutputContentItem::InputImage { image_url, detail }`. On any validation error it calls `throw_type_error(scope, &error_text)` and returns `Err(())`; otherwise returns the content item.

**Call relations**: Called by `callbacks::image_callback` and `callbacks::generated_image_callback`. It delegates shape-specific parsing to `parse_non_mcp_output_image` and `parse_mcp_output_image`, and centralizes all image validation rules.

*Call graph*: calls 1 internal fn (throw_type_error); called by 2 (generated_image_callback, image_callback).


##### `parse_non_mcp_output_image`  (lines 98–117)

```
fn parse_non_mcp_output_image(
    scope: &mut v8::PinScope<'_, '_>,
    object: v8::Local<'_, v8::Object>,
) -> Result<Option<(String, Option<String>)>, String>
```

**Purpose**: Parses the object form `{ image_url, detail? }` accepted by the image helpers.

**Data flow**: Allocates the `image_url` key, reads it from the object, and returns `Ok(None)` when the property is absent or `undefined`, signaling that the caller should try MCP parsing instead. If present, requires it to be a string. Then allocates the `detail` key, reads it, parses it with `parse_image_detail_value`, and returns `Ok(Some((image_url_string, detail_option)))`.

**Call relations**: Called by `normalize_output_image` before attempting MCP parsing. Returning `None` is the mechanism that distinguishes “not this object shape” from “this shape is invalid.”

*Call graph*: calls 1 internal fn (parse_image_detail_value); 2 external calls (get, new).


##### `parse_mcp_output_image`  (lines 119–164)

```
fn parse_mcp_output_image(
    scope: &mut v8::PinScope<'_, '_>,
    value: v8::Local<'_, v8::Value>,
) -> Result<(String, Option<String>), String>
```

**Purpose**: Parses a raw MCP image content block from a V8 object converted through JSON and extracts an image URL plus optional detail metadata.

**Data flow**: Converts the V8 value to `Option<JsonValue>` with `v8_value_to_json`; `None` or any non-object becomes an image-helper error. Requires `type` to be the string `"image"`, requires non-empty `data`, and then either uses `data` directly when it already starts with `data:` or constructs `data:<mime>;base64,<data>` using `mimeType`, `mime_type`, or a default `application/octet-stream`. It also reads `_meta["codex/imageDetail"]`, keeping it only when it is one of `auto`, `low`, `high`, or `original`. Returns `(image_url, detail_option)`.

**Call relations**: Called by `normalize_output_image` when the object did not match the simpler `{ image_url, detail? }` shape. It relies on `v8_value_to_json` to inspect arbitrary JS objects as JSON.

*Call graph*: calls 1 internal fn (v8_value_to_json); 1 external calls (format!).


##### `parse_image_detail_value`  (lines 166–176)

```
fn parse_image_detail_value(
    scope: &mut v8::PinScope<'s, '_>,
    value: Option<v8::Local<'s, v8::Value>>,
) -> Result<Option<String>, String>
```

**Purpose**: Interprets an optional V8 property value as an optional image-detail string.

**Data flow**: Given `Option<v8::Local<v8::Value>>`, returns `Ok(Some(string))` for string values, `Ok(None)` for `null`, `undefined`, or missing values, and `Err("image detail must be a string when provided")` for any other present type.

**Call relations**: Used only by `parse_non_mcp_output_image` to keep detail-property validation separate from object-shape detection.

*Call graph*: called by 1 (parse_non_mcp_output_image).


##### `v8_value_to_json`  (lines 178–196)

```
fn v8_value_to_json(
    scope: &mut v8::PinScope<'_, '_>,
    value: v8::Local<'_, v8::Value>,
) -> Result<Option<JsonValue>, String>
```

**Purpose**: Serializes a V8 value into `serde_json::Value` using JSON stringify semantics, distinguishing unsupported values from thrown exceptions.

**Data flow**: Runs `v8::json::stringify` inside a `TryCatch`. If stringify returns `Some(stringified)`, parses the resulting string with `serde_json::from_str` and returns `Ok(Some(JsonValue))` or a parse error string. If stringify returns `None` and V8 caught an exception, converts that exception with `value_to_error_text` and returns `Err(String)`. If stringify returns `None` without an exception, returns `Ok(None)` to indicate an unsupported/non-serializable value.

**Call relations**: Called by `callbacks::tool_callback`, `callbacks::store_callback`, and `parse_mcp_output_image`. It is the runtime’s standard path for turning JS values into JSON payloads.

*Call graph*: called by 3 (store_callback, tool_callback, parse_mcp_output_image); 3 external calls (from_str, pin!, stringify).


##### `json_to_v8`  (lines 198–205)

```
fn json_to_v8(
    scope: &mut v8::PinScope<'s, '_>,
    value: &JsonValue,
) -> Option<v8::Local<'s, v8::Value>>
```

**Purpose**: Converts a `serde_json::Value` back into a V8 value by serializing it to JSON text and parsing that text in V8.

**Data flow**: Serializes the input JSON value with `serde_json::to_string`, allocates the resulting text as a V8 string, and passes it to `v8::json::parse`, returning `Some(v8::Value)` on success or `None` if any step fails.

**Call relations**: Called by `callbacks::load_callback` and `module_loader::resolve_tool_response`. It is the inverse of `v8_value_to_json` for values that must re-enter JS.

*Call graph*: called by 2 (load_callback, resolve_tool_response); 3 external calls (to_string, new, parse).


##### `value_to_error_text`  (lines 207–220)

```
fn value_to_error_text(
    scope: &mut v8::PinScope<'_, '_>,
    value: v8::Local<'_, v8::Value>,
) -> String
```

**Purpose**: Extracts a human-readable error string from a V8 exception value, preferring stack traces when available.

**Data flow**: Checks whether the value is an object and can be cast to `v8::Object`; if so, allocates the `stack` key, reads the property, and when it is a string returns that stack text. Otherwise falls back to `value.to_rust_string_lossy(scope)`.

**Call relations**: Used by `module_loader::evaluate_main_module`, `module_loader::completion_state`, `module_loader::resolve_tool_response`, `timers::invoke_timeout_callback`, and `serialize_output_text`/`v8_value_to_json` error paths to preserve richer JS diagnostics.

*Call graph*: called by 2 (completion_state, evaluate_main_module); 4 external calls (is_object, to_rust_string_lossy, try_from, new).


##### `throw_type_error`  (lines 222–226)

```
fn throw_type_error(scope: &mut v8::PinScope<'_, '_>, message: &str)
```

**Purpose**: Throws a plain string exception into the current V8 scope with the provided message.

**Data flow**: Attempts to allocate `message` as a V8 string and, if successful, passes it to `scope.throw_exception`.

**Call relations**: Called throughout callback and value-conversion code whenever invalid JS arguments or conversion failures should surface synchronously to the executing script.

*Call graph*: called by 10 (clear_timeout_callback, generated_image_callback, image_callback, load_callback, notify_callback, set_timeout_callback, store_callback, text_callback, tool_callback, normalize_output_image); 2 external calls (throw_exception, new).


### `tui/src/app/replay_filter.rs`

`util` · `thread snapshot replay filtering during thread/agent switches`

This module provides two narrow predicates used when replaying buffered thread events after switching threads. `snapshot_has_pending_interactive_request` scans a `ThreadEventSnapshot` and returns true if any buffered event is a `ThreadBufferedEvent::Request` whose `ServerRequest` variant is one of the interactive prompt types: command execution approval, file change approval, MCP server elicitation, permissions approval, or tool request user input. This gives replay logic a quick way to know whether the snapshot still contains unresolved interactive UI that may need special treatment.

`event_is_notice` classifies a single buffered event as a notice when it is a `ThreadBufferedEvent::Notification` carrying one of the warning-like server notifications: `Warning`, `GuardianWarning`, or `ConfigWarning`. The function intentionally excludes ordinary informational notifications and all requests. Both helpers are pure pattern matches with no side effects, making them safe to use repeatedly during replay filtering and ordering decisions. Their value is not complexity but centralization: the exact set of interactive request variants and notice notification variants lives in one place instead of being duplicated in replay code.

#### Function details

##### `snapshot_has_pending_interactive_request`  (lines 9–22)

```
fn snapshot_has_pending_interactive_request(snapshot: &ThreadEventSnapshot) -> bool
```

**Purpose**: Checks whether a buffered thread snapshot contains any interactive request events that represent pending prompts. It is a coarse snapshot-level signal used during replay decisions.

**Data flow**: Reads a borrowed `ThreadEventSnapshot`, iterates over `snapshot.events`, pattern-matches each `ThreadBufferedEvent`, and returns `true` as soon as it finds a request whose `ServerRequest` variant is one of the five interactive prompt types; otherwise it returns `false`. It mutates nothing.

**Call relations**: Called by higher-level `replay_thread_snapshot` logic to decide whether the snapshot includes unresolved interactive UI. It does all of its work locally via pattern matching.

*Call graph*: called by 1 (replay_thread_snapshot).


##### `event_is_notice`  (lines 24–33)

```
fn event_is_notice(event: &ThreadBufferedEvent) -> bool
```

**Purpose**: Determines whether a buffered event is a warning-style notice notification. It distinguishes notice events from ordinary notifications and requests.

**Data flow**: Accepts a borrowed `ThreadBufferedEvent`, pattern-matches for `ThreadBufferedEvent::Notification` containing `ServerNotification::Warning`, `GuardianWarning`, or `ConfigWarning`, and returns a boolean. It has no side effects.

**Call relations**: Used by `replay_thread_snapshot` when classifying or ordering replayed events. It centralizes the exact set of notification variants treated as notices.

*Call graph*: called by 1 (replay_thread_snapshot); 1 external calls (matches!).


### `tui/src/tui/frame_rate_limiter.rs`

`util` · `cross-cutting`

This file contains a deliberately minimal rate-limiting primitive for frame scheduling. The constant `MIN_FRAME_INTERVAL` is set to 8,333,334 nanoseconds, approximately 120 frames per second. `FrameRateLimiter` itself stores a single field, `last_emitted_at: Option<Instant>`, representing the most recent draw notification that was actually sent.

The main behavior is in `clamp_deadline`: if no frame has been emitted yet, the requested deadline is returned unchanged. Otherwise, the function computes the earliest legal next emission time as `last_emitted_at + MIN_FRAME_INTERVAL`, using `checked_add` and falling back to `last_emitted_at` on overflow. It then returns the later of the caller’s requested deadline and that minimum allowed instant. This means immediate redraw requests can be pushed forward just enough to respect the FPS cap, while genuinely later requests are not delayed further. `mark_emitted` updates the remembered timestamp after a draw notification is sent.

The tests capture the intended contract: a fresh limiter does not clamp, and once a frame has been emitted, requests that arrive too soon are shifted forward to exactly one minimum interval after the last emission.

#### Function details

##### `FrameRateLimiter::clamp_deadline`  (lines 23–31)

```
fn clamp_deadline(&self, requested: Instant) -> Instant
```

**Purpose**: Returns the requested draw deadline, shifted forward if necessary to enforce the minimum interval between emitted frames.

**Data flow**: Reads `self.last_emitted_at`; if absent, returns `requested` unchanged. If present, computes `min_allowed = last_emitted_at + MIN_FRAME_INTERVAL` with overflow protection, then returns `requested.max(min_allowed)`.

**Call relations**: Called by the frame scheduler whenever a new draw request arrives so scheduling can coalesce requests without exceeding the configured frame rate.

*Call graph*: 1 external calls (max).


##### `FrameRateLimiter::mark_emitted`  (lines 34–36)

```
fn mark_emitted(&mut self, emitted_at: Instant)
```

**Purpose**: Records the instant at which a draw notification was actually emitted.

**Data flow**: Stores `Some(emitted_at)` into `self.last_emitted_at` and returns `()`. No other state is tracked.

**Call relations**: Called by the frame scheduler after it sends a draw signal, so future requests can be clamped relative to that emission.


##### `tests::default_does_not_clamp`  (lines 45–49)

```
fn default_does_not_clamp()
```

**Purpose**: Tests that a newly created limiter leaves the first requested deadline unchanged.

**Data flow**: Captures `Instant::now()`, constructs a default limiter, calls `clamp_deadline(t0)`, and asserts the result equals `t0`.

**Call relations**: Documents the no-history behavior of `clamp_deadline`.

*Call graph*: 3 external calls (now, assert_eq!, default).


##### `tests::clamps_to_min_interval_since_last_emit`  (lines 52–61)

```
fn clamps_to_min_interval_since_last_emit()
```

**Purpose**: Tests that requests arriving too soon after an emitted frame are clamped to exactly one minimum interval later.

**Data flow**: Creates a default limiter, verifies no clamp at `t0`, marks emission at `t0`, constructs `too_soon = t0 + 1ms`, and asserts `clamp_deadline(too_soon)` equals `t0 + MIN_FRAME_INTERVAL`.

**Call relations**: Validates the limiter behavior relied on by the frame scheduler.

*Call graph*: 4 external calls (from_millis, now, assert_eq!, default).


### `utils/cache/src/lib.rs`

`util` · `cross-cutting caching`

This file wraps `lru::LruCache` inside a `tokio::sync::Mutex` to provide a simple blocking cache API that is safe to call from synchronous code executing within Tokio. The central type, `BlockingLruCache<K, V>`, exposes common cache operations—lookup, insert, remove, clear, mutable access, and lazy insertion—while hiding the async mutex behind `lock_if_runtime`. That helper first checks `tokio::runtime::Handle::try_current()`; if no runtime is active, it returns `None`, causing most methods to behave as disabled no-ops. For example, `get` returns `None`, `insert` and `remove` do nothing, `clear` is ignored, and `get_or_insert_with` computes a fresh value without storing it. `with_mut` is slightly different: without a runtime it creates an unbounded temporary `LruCache` and runs the callback against that scratch cache, so callers still get a result but no persistent state is retained. When a runtime is present, locking uses `tokio::task::block_in_place(|| m.blocking_lock())` to avoid blocking the async scheduler incorrectly. The file also provides `try_with_capacity`, which returns `None` for zero capacity by using `NonZeroUsize`, and `sha1_digest`, which hashes arbitrary bytes into a fixed `[u8; 20]` array. Tests cover normal storage/eviction behavior under Tokio and the intentionally disabled semantics outside a runtime.

#### Function details

##### `BlockingLruCache::new`  (lines 23–27)

```
fn new(capacity: NonZeroUsize) -> Self
```

**Purpose**: Constructs a cache with a fixed non-zero capacity. It initializes both the underlying `LruCache` and the Tokio mutex wrapper.

**Data flow**: Takes `capacity: NonZeroUsize`, creates `LruCache::new(capacity)`, wraps it in `tokio::sync::Mutex`, and returns `BlockingLruCache { inner }`. No external state is touched.

**Call relations**: Tests call this directly, and production code can use it when capacity is already validated. It is also the constructor targeted by `try_with_capacity` through `Option::map(Self::new)`.

*Call graph*: called by 3 (disabled_without_runtime, evicts_least_recently_used, stores_and_retrieves_values); 2 external calls (new, new).


##### `BlockingLruCache::get_or_insert_with`  (lines 30–44)

```
fn get_or_insert_with(&self, key: K, value: impl FnOnce() -> V) -> V
```

**Purpose**: Returns a cloned cached value for a key if present, otherwise computes, stores, and returns a new value. Outside a Tokio runtime it computes the value but skips caching.

**Data flow**: Consumes `&self`, an owned `key: K`, and a closure `value: impl FnOnce() -> V`. It calls `lock_if_runtime(&self.inner)`; with a guard, it checks `guard.get(&key)`, clones and returns the hit, or computes `v = value()`, inserts `guard.put(key, v.clone())`, and returns `v`. Without a runtime, it simply evaluates and returns `value()` with no state change.

**Call relations**: Callers use this for synchronous memoization in runtime-aware code. Its only internal dependency is `lock_if_runtime`, which determines whether the cache is active.

*Call graph*: calls 1 internal fn (lock_if_runtime).


##### `BlockingLruCache::get_or_try_insert_with`  (lines 47–64)

```
fn get_or_try_insert_with(
        &self,
        key: K,
        value: impl FnOnce() -> Result<V, E>,
    ) -> Result<V, E>
```

**Purpose**: Like `get_or_insert_with`, but the value-producing closure may fail. It caches only successful results and propagates errors unchanged.

**Data flow**: Takes `&self`, `key: K`, and a closure returning `Result<V, E>`. If `lock_if_runtime` yields a guard and the key is present, it returns `Ok(cloned_value)`; otherwise it evaluates `value()?`, inserts a clone on success, and returns `Ok(v)`. Without a runtime it just returns `value()` directly, so no cache state is written.

**Call relations**: This method is used when cache population can fail and callers need the original error type preserved. It follows the same runtime-gated pattern as `get_or_insert_with` and delegates only to `lock_if_runtime`.

*Call graph*: calls 1 internal fn (lock_if_runtime).


##### `BlockingLruCache::try_with_capacity`  (lines 68–70)

```
fn try_with_capacity(capacity: usize) -> Option<Self>
```

**Purpose**: Builds a cache only when the requested capacity is non-zero. It provides a convenient `Option`-returning constructor for configurable capacities.

**Data flow**: Reads `capacity: usize`, converts it with `NonZeroUsize::new(capacity)`, and maps the resulting `Option<NonZeroUsize>` through `Self::new`. It returns `Some(cache)` for positive capacities or `None` for zero.

**Call relations**: Callers use this when zero should mean 'disable caching' without needing a separate branch. It delegates construction to `BlockingLruCache::new`.

*Call graph*: 1 external calls (new).


##### `BlockingLruCache::get`  (lines 73–81)

```
fn get(&self, key: &Q) -> Option<V>
```

**Purpose**: Looks up a key and returns a cloned cached value if present. Outside a Tokio runtime it always behaves as a cache miss.

**Data flow**: Takes `&self` and a borrowed key `&Q`, obtains a mutable guard via `lock_if_runtime(&self.inner)?`, then calls `guard.get(key).cloned()`. It returns `Option<V>` and mutates LRU recency state when the underlying cache is active.

**Call relations**: Tests and production callers use this for direct cache reads. It depends on `lock_if_runtime` to decide whether the cache is operational.

*Call graph*: calls 1 internal fn (lock_if_runtime).


##### `BlockingLruCache::insert`  (lines 84–87)

```
fn insert(&self, key: K, value: V) -> Option<V>
```

**Purpose**: Inserts or updates a cache entry and returns any previous value. Outside a Tokio runtime it performs no insertion and returns `None`.

**Data flow**: Consumes `&self`, `key: K`, and `value: V`, obtains a guard with `lock_if_runtime(&self.inner)?`, and calls `guard.put(key, value)`. It returns the evicted/replaced value if one existed, or `None` if disabled or absent.

**Call relations**: Callers use this for explicit cache population. It delegates all runtime gating and locking to `lock_if_runtime`.

*Call graph*: calls 1 internal fn (lock_if_runtime).


##### `BlockingLruCache::remove`  (lines 90–97)

```
fn remove(&self, key: &Q) -> Option<V>
```

**Purpose**: Deletes a cache entry by key and returns the removed value if present. Outside a Tokio runtime it is a no-op returning `None`.

**Data flow**: Takes `&self` and a borrowed key `&Q`, obtains a guard via `lock_if_runtime(&self.inner)?`, and calls `guard.pop(key)`. It returns `Option<V>`.

**Call relations**: This method is used when callers need explicit invalidation. It follows the same runtime-gated pattern as the other mutating operations.

*Call graph*: calls 1 internal fn (lock_if_runtime).


##### `BlockingLruCache::clear`  (lines 100–104)

```
fn clear(&self)
```

**Purpose**: Removes all entries from the cache when the cache is active. Outside a Tokio runtime it silently does nothing.

**Data flow**: Reads `&self`, calls `lock_if_runtime(&self.inner)`, and if a guard is available invokes `guard.clear()`. It returns no value.

**Call relations**: Callers use this for bulk invalidation. It delegates runtime detection and locking to `lock_if_runtime`.

*Call graph*: calls 1 internal fn (lock_if_runtime).


##### `BlockingLruCache::with_mut`  (lines 107–114)

```
fn with_mut(&self, callback: impl FnOnce(&mut LruCache<K, V>) -> R) -> R
```

**Purpose**: Runs an arbitrary callback with mutable access to an `LruCache`, using the real cache when active or a temporary scratch cache otherwise. This gives callers escape-hatch access without exposing the mutex directly.

**Data flow**: Takes `&self` and `callback: impl FnOnce(&mut LruCache<K, V>) -> R`. If `lock_if_runtime` succeeds, it passes `&mut guard` to the callback and returns the callback's result. Otherwise it creates `LruCache::unbounded()`, passes that temporary cache to the callback, and returns the callback result without persisting any changes.

**Call relations**: This method is for advanced callers needing operations not covered by the wrapper API. It depends on `lock_if_runtime` and intentionally diverges from other methods by providing ephemeral mutable state when disabled.

*Call graph*: calls 1 internal fn (lock_if_runtime); 1 external calls (unbounded).


##### `BlockingLruCache::blocking_lock`  (lines 117–119)

```
fn blocking_lock(&self) -> Option<MutexGuard<'_, LruCache<K, V>>>
```

**Purpose**: Exposes the underlying mutex guard directly when a Tokio runtime is available. It allows callers to perform multiple cache operations under one lock.

**Data flow**: Reads `&self`, calls `lock_if_runtime(&self.inner)`, and returns `Option<MutexGuard<'_, LruCache<K, V>>>`. No additional transformation occurs.

**Call relations**: Advanced callers use this when they need direct access to the underlying `LruCache`. It is a thin wrapper over `lock_if_runtime`.

*Call graph*: calls 1 internal fn (lock_if_runtime).


##### `lock_if_runtime`  (lines 122–128)

```
fn lock_if_runtime(m: &Mutex<LruCache<K, V>>) -> Option<MutexGuard<'_, LruCache<K, V>>>
```

**Purpose**: Obtains a blocking mutex guard only when code is running inside a Tokio runtime. It is the central policy point that disables the cache outside Tokio.

**Data flow**: Reads `m: &Mutex<LruCache<K, V>>`, calls `tokio::runtime::Handle::try_current().ok()?` to detect runtime presence, then enters `tokio::task::block_in_place(|| m.blocking_lock())` and wraps the resulting guard in `Some`. If no runtime is active, it returns `None` immediately.

**Call relations**: All cache operations route through this helper to decide whether they should touch shared cache state. It is the mechanism behind the file's documented 'no-ops outside a Tokio runtime' behavior.

*Call graph*: called by 8 (blocking_lock, clear, get, get_or_insert_with, get_or_try_insert_with, insert, remove, with_mut); 2 external calls (try_current, block_in_place).


##### `sha1_digest`  (lines 135–142)

```
fn sha1_digest(bytes: &[u8]) -> [u8; 20]
```

**Purpose**: Computes the SHA-1 digest of a byte slice and returns it as a fixed-size array. It is intended for stable content-based cache keys.

**Data flow**: Creates a `Sha1` hasher, feeds it `bytes`, finalizes to the digest output, copies the 20-byte result into a `[u8; 20]` array, and returns that array. It does not read or write any shared state.

**Call relations**: This standalone helper is independent of the cache type and can be used wherever callers need a compact deterministic digest for cache indexing.

*Call graph*: 1 external calls (new).


##### `tests::stores_and_retrieves_values`  (lines 150–156)

```
async fn stores_and_retrieves_values()
```

**Purpose**: Verifies that the cache stores an inserted value and returns it on lookup when running under Tokio. It covers the basic active-cache behavior.

**Data flow**: Creates a cache of capacity 2, asserts an initial miss for `"first"`, inserts `("first", 1)`, then asserts a subsequent hit returns `Some(1)`. It mutates only the cache instance created in the test.

**Call relations**: This Tokio test is run by the harness and exercises `new`, `get`, and `insert` in the normal runtime-enabled mode.

*Call graph*: calls 1 internal fn (new); 3 external calls (new, assert!, assert_eq!).


##### `tests::evicts_least_recently_used`  (lines 159–170)

```
async fn evicts_least_recently_used()
```

**Purpose**: Checks that the underlying LRU policy evicts the least recently used entry after capacity is exceeded. It also confirms that a read updates recency.

**Data flow**: Creates a capacity-2 cache, inserts `a` and `b`, reads `a` to make it most recently used, inserts `c`, then asserts `b` was evicted while `a` and `c` remain. It mutates only the test-local cache.

**Call relations**: The test harness invokes this Tokio test to validate that the wrapper preserves `lru::LruCache` eviction semantics.

*Call graph*: calls 1 internal fn (new); 3 external calls (new, assert!, assert_eq!).


##### `tests::disabled_without_runtime`  (lines 173–192)

```
fn disabled_without_runtime()
```

**Purpose**: Verifies the documented disabled behavior when cache methods are called outside a Tokio runtime. It checks that operations either no-op or use ephemeral scratch state.

**Data flow**: Creates a cache in a plain synchronous test, attempts insert/get/remove/clear operations and asserts they have no persistent effect, calls `get_or_insert_with` and confirms the computed value is returned but not stored, uses `with_mut` to mutate a temporary cache and confirms the mutation is not retained, and asserts `blocking_lock()` returns `None`. It mutates only temporary local state.

**Call relations**: This non-Tokio test is run by the harness and specifically exercises the `None` branch of `lock_if_runtime` across the public API.

*Call graph*: calls 1 internal fn (new); 3 external calls (new, assert!, assert_eq!).


### Sandbox summaries and V8 probe
These files package human-readable sandbox/config summaries and a small proof-of-concept crate for validating V8 linkage and behavior.

### `utils/sandbox-summary/src/lib.rs`

`orchestration` · `config display / diagnostics`

This crate root exposes two internal modules, `config_summary` and `sandbox_summary`, and re-exports three public functions from them: `create_config_summary_entries`, `summarize_permission_profile`, and `summarize_sandbox_policy`. The naming indicates a separation between turning raw configuration into structured summary entries and producing higher-level textual or semantic summaries of sandbox-related policies.

The file itself contains no logic, but its API curation is meaningful. By presenting these functions from the crate root, it gives downstream code a focused interface for generating user-facing explanations of sandbox settings without coupling callers to the internal module layout. This is especially useful for CLI, UI, or diagnostics code that needs to explain effective sandbox behavior and permission profiles in a consistent way. The crate appears intentionally narrow in scope: it is not enforcing policy or loading configuration, only summarizing already-defined sandbox and permission state for display or reporting purposes.


### `utils/sandbox-summary/src/config_summary.rs`

`domain_logic` · `config presentation and status/report generation`

This file contains a single formatter-style helper that extracts a concise set of configuration facts from `codex_core::config::Config`. `create_config_summary_entries` always emits entries for the working directory (`config.cwd.display()`), selected model string, provider ID, approval policy, and sandbox policy. The sandbox value is not taken directly from config fields; instead it computes the legacy sandbox policy relative to the current working directory via `config.permissions.legacy_sandbox_policy(config.cwd.as_path())` and then renders that policy through `summarize_sandbox_policy` from the sibling module.

There is one conditional branch based on the model provider wire protocol. When `config.model_provider.wire_api == WireApi::Responses`, the function appends two more entries: `reasoning effort`, derived from `config.model_reasoning_effort` or the string `none`, and `reasoning summaries`, derived from `config.model_reasoning_summary` or `none`. For non-Responses providers those fields are omitted entirely. The return value is a `Vec<(&'static str, String)>`, preserving a stable label order suitable for UI rendering or diagnostics rather than a map keyed by field name.

#### Function details

##### `create_config_summary_entries`  (lines 7–44)

```
fn create_config_summary_entries(config: &Config, model: &str) -> Vec<(&'static str, String)>
```

**Purpose**: Collects selected configuration values into ordered `(label, value)` pairs for display. It includes extra reasoning-related fields only for providers using the Responses wire API.

**Data flow**: It takes a borrowed `Config` and a model name `&str`, initializes a vector with stringified values for `cwd`, `model`, `model_provider_id`, approval policy, and a summarized sandbox policy derived from `config.permissions.legacy_sandbox_policy(config.cwd.as_path())`. If `config.model_provider.wire_api` equals `WireApi::Responses`, it computes optional reasoning effort and reasoning summary strings, substituting `"none"` when absent, pushes those entries, and returns the completed vector.

**Call relations**: This file is a leaf formatter helper: callers provide the already-loaded `Config`, and the function delegates only the sandbox rendering detail to `summarize_sandbox_policy`.

*Call graph*: 1 external calls (vec!).


### `utils/sandbox-summary/src/sandbox_summary.rs`

`domain_logic` · `config presentation and permission reporting`

This file contains the stringification logic for sandbox-related configuration. `summarize_sandbox_policy` pattern-matches on `SandboxPolicy` and emits stable labels such as `danger-full-access`, `read-only`, `external-sandbox`, and `workspace-write`. For policies with network access enabled, it appends the suffix ` (network access enabled)`. The `WorkspaceWrite` branch also builds a bracketed writable-root list beginning with `workdir`, conditionally adding `/tmp` and `$TMPDIR` depending on the exclusion flags, then appending any explicit `writable_roots` converted with `to_string_lossy()`.

`summarize_permission_profile` starts from a higher-level `PermissionProfile` plus runtime `cwd` and `workspace_roots`. It tries to convert the profile into a legacy sandbox policy relative to `cwd`. If that succeeds and yields `WorkspaceWrite`, it intentionally ignores internal writable roots embedded in the profile and instead reconstructs the writable-root list from the runtime `workspace_roots`, filtering out the current working directory because `workdir` is already represented explicitly. For other successful conversions it delegates to `summarize_sandbox_policy`. If conversion fails, it falls back to `custom permissions` with an optional network-enabled suffix based on `permission_profile.network_sandbox_policy()`. The tests verify wording for external sandbox and read-only modes, network suffix behavior, workspace-write formatting, and the hiding of internal writable roots in favor of runtime workspace roots.

#### Function details

##### `summarize_sandbox_policy`  (lines 6–52)

```
fn summarize_sandbox_policy(sandbox_policy: &SandboxPolicy) -> String
```

**Purpose**: Formats a concrete `SandboxPolicy` into a concise descriptive string. It encodes both the sandbox mode and any writable-root or network-access details.

**Data flow**: It takes a borrowed `SandboxPolicy` and matches on its variant. For `DangerFullAccess` it returns a fixed string. For `ReadOnly` and `ExternalSandbox` it starts with a base label and conditionally appends ` (network access enabled)` depending on the variant's network field representation. For `WorkspaceWrite` it builds a mutable summary string, constructs a `Vec<String>` of writable entries beginning with `workdir` and optionally `/tmp` and `$TMPDIR`, extends that list with stringified `writable_roots`, appends the joined list in brackets, optionally appends the network suffix, and returns the final string.

**Call relations**: This is the base formatter used directly by tests and indirectly by `summarize_permission_profile` and `create_config_summary_entries` in the sibling module.

*Call graph*: called by 5 (summarize_permission_profile, summarizes_external_sandbox_with_enabled_network, summarizes_external_sandbox_without_network_access_suffix, summarizes_read_only_with_enabled_network, workspace_write_summary_still_includes_network_access); 3 external calls (new, format!, matches!).


##### `summarize_permission_profile`  (lines 54–96)

```
fn summarize_permission_profile(
    permission_profile: &PermissionProfile,
    cwd: &AbsolutePathBuf,
    workspace_roots: &[AbsolutePathBuf],
) -> String
```

**Purpose**: Formats a higher-level `PermissionProfile` into a sandbox summary, using runtime workspace roots when available. It provides a fallback description for profiles that cannot be converted to a legacy sandbox policy.

**Data flow**: It takes a `PermissionProfile`, current directory `cwd`, and a slice of runtime `workspace_roots`. It calls `permission_profile.to_legacy_sandbox_policy(cwd.as_path())`. If that returns `WorkspaceWrite`, it builds a `workspace-write` summary using `workdir`, optional `/tmp` and `$TMPDIR`, and the provided `workspace_roots` excluding `cwd`; if network access is enabled it appends the standard suffix. If conversion succeeds with any other policy, it delegates to `summarize_sandbox_policy`. If conversion fails, it inspects `permission_profile.network_sandbox_policy().is_enabled()` and returns either `custom permissions` or `custom permissions (network access enabled)`.

**Call relations**: This function is the higher-level entrypoint when the caller has a permission profile rather than a concrete sandbox policy. It delegates to `summarize_sandbox_policy` for non-workspace-write legacy policies and is covered by the runtime-workspace-roots test.

*Call graph*: calls 4 internal fn (network_sandbox_policy, to_legacy_sandbox_policy, as_path, summarize_sandbox_policy); called by 1 (permission_profile_summary_uses_runtime_workspace_roots_and_hides_internal_writes); 3 external calls (format!, iter, vec!).


##### `tests::summarizes_external_sandbox_without_network_access_suffix`  (lines 106–111)

```
fn summarizes_external_sandbox_without_network_access_suffix()
```

**Purpose**: Checks that an external sandbox with restricted network access does not receive the enabled-network suffix. It verifies the exact wording for that branch.

**Data flow**: The test constructs `SandboxPolicy::ExternalSandbox { network_access: NetworkAccess::Restricted }`, passes it to `summarize_sandbox_policy`, and asserts the result equals `external-sandbox`.

**Call relations**: This test directly exercises the `ExternalSandbox` branch of `summarize_sandbox_policy` where network access is not enabled.

*Call graph*: calls 1 internal fn (summarize_sandbox_policy); 1 external calls (assert_eq!).


##### `tests::summarizes_external_sandbox_with_enabled_network`  (lines 114–119)

```
fn summarizes_external_sandbox_with_enabled_network()
```

**Purpose**: Checks that an external sandbox with enabled network access includes the expected suffix. It validates the `matches!(..., NetworkAccess::Enabled)` condition.

**Data flow**: It constructs `SandboxPolicy::ExternalSandbox { network_access: NetworkAccess::Enabled }`, summarizes it, and asserts the string equals `external-sandbox (network access enabled)`.

**Call relations**: This test covers the enabled-network branch of `summarize_sandbox_policy` for external sandboxes.

*Call graph*: calls 1 internal fn (summarize_sandbox_policy); 1 external calls (assert_eq!).


##### `tests::summarizes_read_only_with_enabled_network`  (lines 122–127)

```
fn summarizes_read_only_with_enabled_network()
```

**Purpose**: Verifies the read-only summary wording when network access is enabled. It ensures the boolean network flag is reflected in the output.

**Data flow**: It constructs `SandboxPolicy::ReadOnly { network_access: true }`, calls `summarize_sandbox_policy`, and asserts the returned string is `read-only (network access enabled)`.

**Call relations**: This test targets the `ReadOnly` branch of `summarize_sandbox_policy`.

*Call graph*: calls 1 internal fn (summarize_sandbox_policy); 1 external calls (assert_eq!).


##### `tests::workspace_write_summary_still_includes_network_access`  (lines 130–146)

```
fn workspace_write_summary_still_includes_network_access()
```

**Purpose**: Checks that workspace-write summaries include both writable roots and the network-enabled suffix. It also verifies platform-aware path formatting in the expected string.

**Data flow**: The test chooses a platform-specific root path, converts it to `AbsolutePathBuf`, constructs a `SandboxPolicy::WorkspaceWrite` with that root and both temp exclusions enabled, summarizes it, and asserts the result matches `workspace-write [workdir, <root>] (network access enabled)`.

**Call relations**: This test exercises the `WorkspaceWrite` branch of `summarize_sandbox_policy`, especially the writable-root list assembly and network suffix.

*Call graph*: calls 2 internal fn (try_from, summarize_sandbox_policy); 3 external calls (assert_eq!, cfg!, vec!).


##### `tests::permission_profile_summary_uses_runtime_workspace_roots_and_hides_internal_writes`  (lines 149–181)

```
fn permission_profile_summary_uses_runtime_workspace_roots_and_hides_internal_writes()
```

**Purpose**: Verifies that permission-profile summaries for workspace-write use runtime workspace roots rather than internal writable roots embedded in the profile. It ensures hidden internal paths do not leak into the displayed summary.

**Data flow**: It builds platform-specific `cwd`, `extra_root`, and `hidden_root` absolute paths, creates a `PermissionProfile::workspace_write_with` containing `hidden_root`, then calls `summarize_permission_profile(&profile, &cwd, &[cwd.clone(), extra_root.clone()])`. Finally it asserts the summary includes `workdir`, `/tmp`, `$TMPDIR`, and `extra_root`, but not `cwd` or `hidden_root`.

**Call relations**: This test specifically targets the special `WorkspaceWrite` handling inside `summarize_permission_profile`, where runtime roots replace internal profile roots.

*Call graph*: calls 3 internal fn (workspace_write_with, try_from, summarize_permission_profile); 3 external calls (assert_eq!, cfg!, from_ref).


### `v8-poc/src/lib.rs`

`domain_logic` · `library query calls and test-time engine initialization/execution`

This library is intentionally minimal: the production surface is three query functions that report the crate’s Bazel label, the linked V8 version string, and whether the linked V8 build has the in-process sandbox enabled. The sandbox probe is notable because it bypasses the safe `rusty_v8` API and binds directly to the exported `v8__V8__IsSandboxEnabled` symbol, relying on a symbol that `rusty_v8` exposes for its own verification tests.

Most of the file is test coverage that proves the crate is correctly linked and that a real V8 runtime can be initialized and used. Test initialization is guarded by a `std::sync::Once`, so platform and engine initialization happen only once across the whole test process. The expression evaluator creates a fresh `v8::Isolate`, enters a scope and context, compiles a UTF-8 source string into a script, runs it, and converts the result back to a Rust `String`. Additional tests validate CRDTP support by converting JSON protocol input to CBOR and inspecting a `v8::crdtp::Dispatchable`. The tests therefore exercise both JavaScript execution and protocol-message parsing, not just static metadata.

#### Function details

##### `bazel_target`  (lines 5–7)

```
fn bazel_target() -> &'static str
```

**Purpose**: Returns the fixed Bazel label string identifying this crate target.

**Data flow**: Takes no input and reads no mutable state. It returns the hard-coded `&'static str` value `//codex-rs/v8-poc:v8-poc`.

**Call relations**: Used directly by the test that verifies the crate exposes the expected Bazel target string; otherwise it is a standalone metadata accessor.


##### `embedded_v8_version`  (lines 11–13)

```
fn embedded_v8_version() -> &'static str
```

**Purpose**: Asks the linked V8 library for its version string and exposes it as a static string slice.

**Data flow**: Takes no arguments, calls into `v8::V8::get_version()`, and returns the resulting `&'static str` without further transformation.

**Call relations**: Exercised by the version test to confirm the embedded V8 is present and reports a non-empty version; it delegates entirely to the external V8 API.

*Call graph*: 1 external calls (get_version).


##### `linked_v8_has_sandbox`  (lines 17–24)

```
fn linked_v8_has_sandbox() -> bool
```

**Purpose**: Checks whether the linked V8 binary was compiled with sandbox support enabled.

**Data flow**: Takes no input, declares an unsafe extern symbol `v8__V8__IsSandboxEnabled`, invokes it, and returns the resulting `bool`.

**Call relations**: Validated by the sandbox-feature test, which compares the runtime-linked capability against the crate’s compile-time `sandbox` feature expectation.


##### `tests::initialize_v8`  (lines 33–40)

```
fn initialize_v8()
```

**Purpose**: Performs one-time global V8 platform and engine initialization for the test suite.

**Data flow**: Takes no arguments. It uses a static `Once` to ensure the closure runs only once, creating the default V8 platform, sharing it with `initialize_platform`, and then calling `v8::V8::initialize()`.

**Call relations**: Called by `tests::evaluate_expression` before any isolate is created, so repeated expression-evaluation tests reuse the same global initialization path safely.

*Call graph*: 1 external calls (new).


##### `tests::evaluate_expression`  (lines 42–55)

```
fn evaluate_expression(expression: &str) -> String
```

**Purpose**: Compiles and executes a JavaScript expression in a fresh V8 isolate and returns the result as a Rust string.

**Data flow**: Accepts an expression `&str`, first ensures global V8 initialization, then creates a new isolate, enters a scope, creates a context and context scope, allocates a V8 string from the source text, compiles it into a script, runs it, and converts the resulting V8 value to a lossy Rust `String`. It panics with explicit messages if UTF-8 conversion, compilation, or execution fails.

**Call relations**: Used by the arithmetic and string-concatenation tests as the common execution helper; it delegates all runtime work to V8 constructors, scope setup, compilation, and execution APIs.

*Call graph*: 8 external calls (default, initialize_v8, new, new, new, compile, new, scope!).


##### `tests::exposes_expected_bazel_target`  (lines 58–60)

```
fn exposes_expected_bazel_target()
```

**Purpose**: Asserts that the crate reports the exact Bazel label expected by the build.

**Data flow**: Calls `bazel_target()` and compares the returned string to the literal expected label using `assert_eq!`.

**Call relations**: This is a direct leaf test for the metadata accessor and does not delegate beyond the assertion macro.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::exposes_embedded_v8_version`  (lines 63–65)

```
fn exposes_embedded_v8_version()
```

**Purpose**: Checks that the linked V8 library returns some version text rather than an empty string.

**Data flow**: Calls `embedded_v8_version()` and asserts the returned string is not empty.

**Call relations**: Serves as a smoke test for successful V8 linkage and the external version query.

*Call graph*: 1 external calls (assert!).


##### `tests::sandbox_feature_matches_linked_v8`  (lines 68–70)

```
fn sandbox_feature_matches_linked_v8()
```

**Purpose**: Verifies that the crate’s compile-time sandbox feature flag matches the actual linked V8 sandbox capability.

**Data flow**: Calls `linked_v8_has_sandbox()` and compares its boolean result to `cfg!(feature = "sandbox")`.

**Call relations**: Bridges build configuration and runtime linkage, ensuring the direct FFI sandbox probe agrees with Cargo feature selection.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::evaluates_integer_addition`  (lines 73–75)

```
fn evaluates_integer_addition()
```

**Purpose**: Confirms that the V8 execution helper can evaluate a simple numeric expression.

**Data flow**: Passes the source string `"1 + 2"` into `evaluate_expression` and asserts the returned string is `"3"`.

**Call relations**: Uses the shared expression-evaluation helper to validate basic script compilation and execution.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::evaluates_string_concatenation`  (lines 78–80)

```
fn evaluates_string_concatenation()
```

**Purpose**: Confirms that the V8 execution helper can evaluate a simple string expression.

**Data flow**: Passes the source string `"'hello ' + 'world'"` into `evaluate_expression` and asserts the returned string is `"hello world"`.

**Call relations**: Exercises the same helper path as the arithmetic test, but with string semantics.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::parses_crdtp_dispatchable_messages`  (lines 83–91)

```
fn parses_crdtp_dispatchable_messages()
```

**Purpose**: Verifies that V8’s CRDTP utilities can convert JSON protocol input to CBOR and expose dispatch metadata.

**Data flow**: Builds a JSON byte string for a DevTools-style request, converts it to CBOR with `v8::crdtp::json_to_cbor`, constructs a `v8::crdtp::Dispatchable` over the CBOR bytes, and asserts that parsing succeeded and that the call id and method bytes match the input.

**Call relations**: Independent of the isolate-based execution tests; it validates the linked CRDTP support path by delegating to V8’s protocol conversion and dispatchable-message parser.

*Call graph*: 4 external calls (assert!, assert_eq!, new, json_to_cbor).
