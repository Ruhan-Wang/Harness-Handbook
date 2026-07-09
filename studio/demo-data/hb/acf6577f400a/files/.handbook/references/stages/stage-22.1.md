# Path, filesystem, environment, and sandbox support utilities  `stage-22.1`

This stage is shared behind-the-scenes support. It gives the rest of the system safe ways to talk about files, folders, programs, terminals, and sandboxes without each feature reinventing the rules. The path helpers form the base layer: PathUri, ApiPathString, AbsolutePathBuf, app-server paths, path-utils, WSL path conversion, memory path helpers, and timestamp helpers all clean, compare, display, and translate paths across Unix, Windows, WSL, remotes, and saved data. Filesystem pieces build on that: regular_file protects reads from special files, file-watcher reports disk changes, file-system defines common read/write/list operations, and symlink helpers hide platform differences. Build and execution helpers find binaries under Cargo or Bazel, resolve program names on Windows, and shape the environment variables passed to child commands. Terminal support detects the host terminal, chooses usable colors, and copies text safely through SSH, tmux, WSL, or local clipboards. Sandbox utilities prepare restricted runs on Linux, macOS, and Windows by finding sandbox tools, reporting denied permissions, normalizing paths, setting up safe working folders, environment variables, SSH dependencies, mutexes, and Windows-specific system details.

## Files in this stage

### Path identity and conversion
These files define the core path abstractions and conversion layers used to represent absolute paths, canonical file URIs, and API-facing path strings across platforms.

### `utils/path-uri/src/api_path_string.rs`

`io_transport` · `API serialization and path conversion`

This file sits at a boundary between two worlds. Older app-server APIs still send paths as plain JSON strings, such as `/home/me/file.txt` or `C:\Users\me\file.txt`. Newer internal code wants to use `PathUri`, which represents paths as file URIs in a more consistent way. `LegacyAppPathString` is the bridge between them.

The key idea is that path text only makes sense if you know its spelling rules. POSIX systems, such as Linux and macOS, use `/` roots. Windows uses drive roots like `C:\` and network paths like `\\server\share`. The `PathConvention` enum names which rulebook to use. This matters because the same characters can mean different things on different systems.

The wrapper allows raw strings to be accepted from JSON without validation, because legacy clients may send many forms. But internal code cannot freely create one from any `String`; it must usually come from an absolute path or a `PathUri`. That design keeps the messy compatibility layer close to the API edge.

When converting to `PathUri`, the file checks that the string is an absolute path for the chosen convention. When converting back, it refuses shapes that would lose meaning, such as rendering a Windows network URI as a POSIX path. For unusual or non-standard paths, it uses an “opaque fallback,” meaning it stores the original bytes so the path can still be preserved even if it cannot be cleanly understood.

#### Function details

##### `LegacyAppPathString::from_abs_path`  (lines 37–39)

```
fn from_abs_path(path: &AbsolutePathBuf) -> Self
```

**Purpose**: Creates a legacy API path string from an absolute path on the current machine. It is used when internal code already has a trusted absolute path and needs to send it through the older string-based API.

**Data flow**: It receives an `AbsolutePathBuf`, reads its text form, and turns it into UTF-8 text. If the original path contains bytes that are not valid UTF-8, they are replaced in a lossy but displayable way, then stored inside `LegacyAppPathString`.

**Call relations**: This is the straightforward path out to the legacy API. The `From<AbsolutePathBuf>` conversion delegates to it, and higher-level permission and app-server code uses it when it needs legacy path strings for already-known filesystem roots.

*Call graph*: calls 1 internal fn (to_string_lossy); called by 4 (from, additional_file_system_permissions_populates_entries_for_legacy_roots, app_server_exec_approval_request_preserves_permissions_context, app_server_request_permissions_preserves_file_system_permissions).


##### `LegacyAppPathString::from_path_uri`  (lines 48–60)

```
fn from_path_uri(
        path: &PathUri,
        convention: PathConvention,
    ) -> Result<Self, LegacyAppPathStringError>
```

**Purpose**: Renders a `PathUri` as an old-style native path string using an explicitly chosen path convention. It prevents accidental conversion between incompatible path worlds, such as treating a POSIX path as a Windows drive path.

**Data flow**: It receives a `PathUri` and a `PathConvention`. If the URI carries opaque fallback bytes, it tries to recover those bytes as native path text. Otherwise, it sends the URI to either the POSIX renderer or the Windows renderer. The result is a `LegacyAppPathString`, or an error explaining why the URI cannot be safely written in that convention.

**Call relations**: Callers use this when they must answer an API or test with legacy path text. It is the public gatekeeper that chooses between `render_opaque_fallback`, `render_posix_path`, and `render_windows_path`.

*Call graph*: calls 4 internal fn (opaque_fallback_bytes, render_opaque_fallback, render_posix_path, render_windows_path); called by 3 (remote_cwd, renders_native_paths_from_shared_cases, serializes_and_deserializes_as_a_string).


##### `LegacyAppPathString::to_path_uri`  (lines 64–76)

```
fn to_path_uri(
        &self,
        convention: PathConvention,
    ) -> Result<PathUri, LegacyAppPathStringError>
```

**Purpose**: Parses the stored legacy string as an absolute path and converts it into the project’s canonical `PathUri` form. It is used when old API input needs to enter newer internal code.

**Data flow**: It reads the inner string and the requested path convention. For POSIX it tries POSIX parsing; for Windows it tries Windows parsing. If parsing succeeds, the output is a `PathUri`; if the string is not an absolute path under that convention, the output is an error.

**Call relations**: This is the main inbound conversion point from legacy JSON path text. It relies on `parse_posix_path` or `parse_windows_path` to interpret the spelling rules.

*Call graph*: calls 2 internal fn (parse_posix_path, parse_windows_path).


##### `LegacyAppPathString::infer_absolute_path_convention`  (lines 83–97)

```
fn infer_absolute_path_convention(&self) -> Option<PathConvention>
```

**Purpose**: Guesses whether the stored string looks like an absolute POSIX path or an absolute Windows path. It only returns an answer when the spelling is clear enough.

**Data flow**: It inspects the start of the string. A drive-root form like `C:\` or a backslash-based network form is treated as Windows. A leading `/` is treated as POSIX. Relative or unclear strings produce `None`.

**Call relations**: This function helps callers decide which convention to use before doing a stricter conversion. It does not create a URI itself; it only gives a best-effort classification.

*Call graph*: 1 external calls (matches!).


##### `LegacyAppPathString::as_str`  (lines 99–101)

```
fn as_str(&self) -> &str
```

**Purpose**: Returns the stored path text as a borrowed string. It is useful when code only needs to read or display the legacy value without taking ownership of it.

**Data flow**: It receives a `LegacyAppPathString` by reference and returns a reference to the same inner text. Nothing is changed or copied.

**Call relations**: This is a small access point for code that needs the raw API spelling after the wrapper has preserved it.


##### `LegacyAppPathString::into_string`  (lines 103–105)

```
fn into_string(self) -> String
```

**Purpose**: Consumes the wrapper and gives back the stored plain string. It is useful when the caller wants to move the text onward and no longer needs the safer wrapper.

**Data flow**: It receives the `LegacyAppPathString` by value, removes the inner `String`, and returns that `String`. The original wrapper is used up.

**Call relations**: This is the exit hatch for code that must hand the raw legacy path text to another string-based layer.


##### `LegacyAppPathString::from`  (lines 109–111)

```
fn from(path: AbsolutePathBuf) -> Self
```

**Purpose**: Allows an absolute path buffer to be converted into a legacy API path string using Rust’s standard `From` conversion pattern. It makes the common conversion concise while still going through the intended path-rendering logic.

**Data flow**: It receives an `AbsolutePathBuf`, borrows it, and passes it to `from_abs_path`. The returned value is a `LegacyAppPathString` containing displayable path text.

**Call relations**: This is a convenience wrapper around `LegacyAppPathString::from_abs_path`, so callers using generic conversion APIs still follow the same safe path.

*Call graph*: 1 external calls (from_abs_path).


##### `parse_posix_path`  (lines 114–122)

```
fn parse_posix_path(path: &str) -> Option<PathUri>
```

**Purpose**: Interprets a string as an absolute POSIX path and turns it into a `PathUri`. POSIX paths are the slash-rooted paths used on Linux and macOS.

**Data flow**: It receives plain path text. If the text does not start with `/`, parsing fails. If it contains a null character, it stores the original bytes as an opaque fallback. Otherwise, it splits the path into slash-separated pieces and builds a file URI from those pieces.

**Call relations**: This is called by `LegacyAppPathString::to_path_uri` when the caller selected the POSIX convention. It hands normal paths to `path_uri_from_segments` and unusual null-containing paths to the opaque fallback mechanism.

*Call graph*: calls 2 internal fn (from_opaque_path_bytes, path_uri_from_segments); called by 1 (to_path_uri); 1 external calls (format!).


##### `parse_windows_path`  (lines 124–160)

```
fn parse_windows_path(path: &str) -> Option<PathUri>
```

**Purpose**: Interprets a string as an absolute Windows path and turns it into a `PathUri`. It understands drive paths, network share paths, and special Windows namespace paths.

**Data flow**: It receives path text and checks its shape. Special namespace paths or paths with null characters become opaque fallback URIs. Drive-root paths like `C:\x` become file URIs with `C:` as the first segment. Network paths like `\\server\share\x` become file URIs with a host and share. Relative or incomplete paths fail.

**Call relations**: This is called by `LegacyAppPathString::to_path_uri` for Windows parsing. It uses `path_uri_from_segments` for cleanly representable paths and `windows_opaque_path_uri` when the exact Windows spelling must be preserved.

*Call graph*: calls 2 internal fn (path_uri_from_segments, windows_opaque_path_uri); called by 1 (to_path_uri); 2 external calls (matches!, once).


##### `path_uri_from_segments`  (lines 162–178)

```
fn path_uri_from_segments(
    host: Option<&str>,
    segments: impl Iterator<Item = &'a str>,
) -> Option<PathUri>
```

**Purpose**: Builds a `PathUri` from already-separated path pieces, optionally including a network host. It is the shared helper for normal POSIX and Windows paths.

**Data flow**: It starts with an empty `file:///` URL, optionally sets the host, clears the URL path, then pushes each path segment into the URL so it can be encoded correctly. Finally, it tries to convert that URL into a `PathUri`.

**Call relations**: Both POSIX and Windows parsers use this after they have broken native path text into meaningful pieces. It centralizes the URL-building step so each parser does not have to repeat it.

*Call graph*: calls 1 internal fn (try_from); called by 2 (parse_posix_path, parse_windows_path); 1 external calls (parse).


##### `windows_opaque_path_uri`  (lines 180–186)

```
fn windows_opaque_path_uri(path: &str) -> PathUri
```

**Purpose**: Stores a Windows path as opaque bytes inside a `PathUri` when it cannot or should not be represented as a normal file URI. This preserves the original Windows-specific form.

**Data flow**: It receives Windows path text, encodes it as UTF-16 little-endian bytes, which is the common Windows wide-character representation, and creates a `PathUri` from those raw bytes.

**Call relations**: The Windows parser uses this for namespace paths and other unusual cases. Later, rendering code can try to recover those bytes through `render_opaque_fallback`.

*Call graph*: calls 1 internal fn (from_opaque_path_bytes); called by 1 (parse_windows_path).


##### `is_windows_separator_char`  (lines 188–190)

```
fn is_windows_separator_char(character: char) -> bool
```

**Purpose**: Checks whether a character is a Windows path separator. Windows commonly accepts both backslash and forward slash as separators.

**Data flow**: It receives one character and returns `true` if it is `\` or `/`; otherwise it returns `false`.

**Call relations**: Windows parsing uses this when splitting a path string into components, so both separator styles are treated consistently.

*Call graph*: 1 external calls (matches!).


##### `is_windows_separator_byte`  (lines 192–194)

```
fn is_windows_separator_byte(character: u8) -> bool
```

**Purpose**: Checks whether a byte is a Windows path separator. This is the byte-level version of the separator test.

**Data flow**: It receives one byte and returns `true` for the byte values of `\` or `/`; otherwise it returns `false`.

**Call relations**: The convention inference and Windows parser use this when they only need to inspect the start of a string cheaply as bytes.

*Call graph*: 1 external calls (matches!).


##### `render_opaque_fallback`  (lines 196–211)

```
fn render_opaque_fallback(
    path: &PathUri,
    path_bytes: &[u8],
    convention: PathConvention,
) -> Result<String, LegacyAppPathStringError>
```

**Purpose**: Tries to turn opaque fallback bytes from a `PathUri` back into native path text. It exists so unusual paths can still round-trip through the legacy API when possible.

**Data flow**: It receives the original `PathUri`, its stored fallback bytes, and the target convention. For POSIX, the bytes must start with `/` and are decoded as UTF-8 lossily. For Windows, the bytes are passed to the Windows fallback renderer. If the bytes do not match the requested convention, it returns an error.

**Call relations**: `LegacyAppPathString::from_path_uri` calls this before normal rendering whenever a URI contains opaque bytes. It delegates Windows recovery to `render_windows_opaque_fallback`.

*Call graph*: calls 1 internal fn (render_windows_opaque_fallback); called by 1 (from_path_uri); 1 external calls (from_utf8_lossy).


##### `render_windows_opaque_fallback`  (lines 213–238)

```
fn render_windows_opaque_fallback(path_bytes: &[u8]) -> Option<String>
```

**Purpose**: Attempts to recover Windows path text from opaque bytes. It only accepts bytes that look like an absolute Windows path after decoding.

**Data flow**: It receives raw bytes and first checks that they can be split into 16-bit Windows characters. It then decodes them and checks for either a drive root like `C:\` or a double-separator root like `\\server`. If the shape is absolute, it returns text; otherwise it returns nothing.

**Call relations**: `render_opaque_fallback` uses this when the caller requested Windows path syntax. It is the counterpart to `windows_opaque_path_uri`, which created the bytes earlier.

*Call graph*: called by 1 (render_opaque_fallback); 1 external calls (matches!).


##### `is_windows_separator`  (lines 240–242)

```
fn is_windows_separator(character: u16) -> bool
```

**Purpose**: Checks whether a UTF-16 Windows character value is a path separator. It is used while examining decoded Windows opaque fallback data.

**Data flow**: It receives one 16-bit character value and returns whether it equals the UTF-16 value for `\` or `/`.

**Call relations**: The Windows opaque fallback renderer uses this to recognize drive roots and network-style roots without first converting every character into a Rust `char`.

*Call graph*: 1 external calls (from).


##### `LegacyAppPathString::fmt`  (lines 245–247)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Defines how a legacy path string is printed for display. It prints just the stored path text, not extra wrapper information.

**Data flow**: It receives the wrapper and a formatter, writes the inner string into that formatter, and returns the formatting result.

**Call relations**: This supports normal string formatting, logging, and error messages wherever `LegacyAppPathString` is displayed.

*Call graph*: 1 external calls (write_str).


##### `LegacyAppPathString::serialize`  (lines 251–256)

```
fn serialize(&self, serializer: S) -> Result<S::Ok, S::Error>
```

**Purpose**: Serializes the legacy path wrapper as a plain JSON string. This keeps the API shape compatible with clients that expect a string, not an object.

**Data flow**: It receives the wrapper and a serializer, then gives the inner string to that serializer. The output is whatever serialized string form the caller’s format uses, typically JSON text.

**Call relations**: API response code and tests rely on this so `LegacyAppPathString` remains transparent over the wire.

*Call graph*: 1 external calls (serialize_str).


##### `LegacyAppPathString::schema_name`  (lines 260–262)

```
fn schema_name() -> String
```

**Purpose**: Gives the JSON schema system a stable name for this path-string type. A JSON schema describes the shape of data that APIs send and receive.

**Data flow**: It takes no path input and returns the fixed schema name `LegacyAppPathString`.

**Call relations**: Schema generation code calls this when documenting or exporting the API type.


##### `LegacyAppPathString::json_schema`  (lines 264–266)

```
fn json_schema(generator: &mut schemars::r#gen::SchemaGenerator) -> schemars::schema::Schema
```

**Purpose**: Tells the JSON schema system that this wrapper should be described like a normal string. This matches how it is serialized over the API.

**Data flow**: It receives a schema generator and asks the existing string schema logic to produce the schema. The result is a schema that says the API value is string-shaped.

**Call relations**: This works together with `serialize` and the transparent wrapper design so generated API docs match the actual wire format.

*Call graph*: 1 external calls (json_schema).


##### `render_posix_path`  (lines 269–285)

```
fn render_posix_path(path: &PathUri) -> Result<String, LegacyAppPathStringError>
```

**Purpose**: Renders a `PathUri` as a POSIX absolute path string. It rejects URIs that need information POSIX path text cannot carry, such as a network host.

**Data flow**: It receives a `PathUri`, turns it into a URL, and checks that there is no host. It then walks through the URI path segments, decodes each segment once, joins them with `/`, and returns the resulting path string. If a host is present, it returns an incompatible-convention error.

**Call relations**: `LegacyAppPathString::from_path_uri` calls this when the requested convention is POSIX. It uses `path_segments` to read the URI pieces and `decode_native_segment` to turn URI escaping back into native text.

*Call graph*: calls 4 internal fn (to_url, decode_native_segment, incompatible_convention, path_segments); called by 1 (from_path_uri); 1 external calls (new).


##### `render_windows_path`  (lines 287–334)

```
fn render_windows_path(path: &PathUri) -> Result<String, LegacyAppPathStringError>
```

**Purpose**: Renders a `PathUri` as an absolute Windows path string. It supports both drive-root paths and UNC network paths, while rejecting POSIX-shaped URIs that cannot be valid Windows absolute paths.

**Data flow**: It receives a `PathUri`, turns it into a URL, and reads the path segments. If the URL has a host, it renders a network path like `\\server\share`. Without a host, it requires the first segment to be a drive name like `C:`. It decodes each remaining segment and joins them with backslashes, adding a trailing backslash for a bare drive root.

**Call relations**: `LegacyAppPathString::from_path_uri` calls this when Windows syntax is requested. It depends on `path_segments`, `decode_native_segment`, and `incompatible_convention` to keep rendering strict and meaningful.

*Call graph*: calls 4 internal fn (to_url, decode_native_segment, incompatible_convention, path_segments); called by 1 (from_path_uri); 1 external calls (new).


##### `path_segments`  (lines 336–339)

```
fn path_segments(url: &url::Url) -> std::str::Split<'_, char>
```

**Purpose**: Returns the slash-separated path pieces from a file URL. It is a small helper that hides the URL library detail from the renderers.

**Data flow**: It receives a URL and returns an iterator over its path segments. The code assumes these validated file URLs always have segments.

**Call relations**: Both POSIX and Windows renderers call this before decoding and joining URI path pieces into native path text.

*Call graph*: called by 2 (render_posix_path, render_windows_path); 1 external calls (path_segments).


##### `decode_native_segment`  (lines 341–346)

```
fn decode_native_segment(segment: &str) -> String
```

**Purpose**: Decodes one URI path segment into native path text. It decodes percent-escapes once, so encoded text is not accidentally decoded too far.

**Data flow**: It receives one URI segment such as `a%20dir`, decodes percent-encoded bytes into raw bytes, then turns those bytes into UTF-8 text, replacing invalid UTF-8 if needed. The result is a displayable string segment.

**Call relations**: The POSIX and Windows renderers call this for each path segment before joining segments with the convention’s separator.

*Call graph*: called by 2 (render_posix_path, render_windows_path); 2 external calls (from_utf8_lossy, decode_binary).


##### `incompatible_convention`  (lines 348–353)

```
fn incompatible_convention(path: &PathUri, convention: PathConvention) -> LegacyAppPathStringError
```

**Purpose**: Creates a clear error for cases where a `PathUri` cannot be rendered using the requested path convention. It keeps error construction consistent.

**Data flow**: It receives the `PathUri` and the requested convention, converts the URI to text for the error message, and returns an `IncompatibleConvention` error value.

**Call relations**: The POSIX and Windows renderers call this whenever rendering would lose information or produce an invalid native path.

*Call graph*: called by 2 (render_posix_path, render_windows_path); 1 external calls (to_string).


##### `PathConvention::native`  (lines 392–394)

```
fn native() -> Self
```

**Purpose**: Returns the path convention used by the operating system running this process. On Windows it returns Windows; on Unix-like systems it returns POSIX.

**Data flow**: It takes no input and returns the compile-time native convention for the current build target.

**Call relations**: Callers use this when they want the local machine’s normal path spelling instead of choosing POSIX or Windows manually.

*Call graph*: called by 2 (try_from, path_convention).


##### `PathConvention::fmt`  (lines 398–403)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Defines how a path convention is printed in human-readable messages. It prints `POSIX` or `Windows`.

**Data flow**: It receives a `PathConvention` and a formatter, writes the matching display name, and returns the formatting result.

**Call relations**: Error messages use this so failures can clearly say which path syntax was expected.

*Call graph*: 1 external calls (write_str).


### `utils/path-uri/src/lib.rs`

`domain_logic` · `cross-cutting`

A file path is not as universal as it looks. `/tmp/a.txt`, `C:\src\a.txt`, and `file://server/share/a.txt` mean different things depending on the operating system. This file solves that by wrapping file locations in a typed `PathUri`: a URL-like form that is checked when it is created and cannot be changed afterward.

The file accepts only `file:` URIs. It rejects extra URL parts that do not make sense for files, such as usernames, passwords, ports, query strings, and fragments. It also blocks paths containing decoded null bytes, because those are unsafe for native path APIs.

It can convert an absolute native path into a `file:` URI, and later try to convert it back. If a path cannot be represented as a normal URI, it is stored in a special fallback URI containing base64-encoded original bytes. That is like putting a fragile object in a labeled sealed envelope: most path operations cannot inspect it, but the original value can still be recovered on the right host.

The type also provides simple path-like operations such as finding a basename, finding a parent, joining a relative path, and guessing whether the URI looks like a Unix-style or Windows-style path.

#### Function details

##### `PathUri::parse`  (lines 62–64)

```
fn parse(uri: &str) -> Result<Self, PathUriParseError>
```

**Purpose**: Parses text into a checked `PathUri`. Use it when a string is expected to be a real `file:` URI and should be rejected if it is not safe or not supported.

**Data flow**: It receives a string, asks the URL parser to understand it, then passes the parsed URL through `PathUri` validation. It returns a `PathUri` on success, or a clear parse error on failure.

**Call relations**: This is the front door for URI text. Higher-level code that receives current working directories, remote paths, helper protocol data, or test fixtures calls it before trusting the value as a path URI.

*Call graph*: called by 30 (remote_cwd, helper_protocol_uses_path_uris, non_native_cwd, non_native_uri, start_process_rejects_non_native_cwd_before_launch, non_native_cwd, non_native_uri, renders_native_paths_from_shared_cases, serializes_and_deserializes_as_a_string, bad_path_uris_are_opaque_to_lexical_operations (+15 more)); 1 external calls (parse).


##### `PathUri::from_abs_path`  (lines 76–98)

```
fn from_abs_path(path: &AbsolutePathBuf) -> Self
```

**Purpose**: Turns an already-checked absolute native path into a `file:` URI. It is used when the project has a real filesystem path and needs the portable `PathUri` form.

**Data flow**: It receives an absolute path object, first tries the standard URL conversion, and validates the result. If that normal conversion cannot safely represent the path, it encodes the original platform bytes into a special fallback URI. The output is always a `PathUri`.

**Call relations**: File operations such as reading, writing, copying, creating directories, and applying edits use this when they need to report or store paths as URIs. When the normal URL route fails, it hands the raw bytes to the opaque fallback builder.

*Call graph*: calls 1 internal fn (as_path); called by 100 (copy, create_directory, get_metadata, read_directory, read_file, remove, write_file, apply_hunks_to_files, derive_new_contents_from_chunks, ensure_not_directory (+15 more)); 3 external calls (from_opaque_path_bytes, try_from, from_file_path).


##### `PathUri::from_opaque_path_bytes`  (lines 100–106)

```
fn from_opaque_path_bytes(path_bytes: &[u8]) -> Self
```

**Purpose**: Builds the special fallback URI used for paths that cannot be written as an ordinary `file:` URL. This preserves the original path bytes instead of losing or guessing information.

**Data flow**: It receives raw path bytes, base64-encodes them using a URL-safe spelling, attaches them to the reserved bad-path prefix, and parses that string back into a `PathUri`. The result is an opaque URI that can later be decoded.

**Call relations**: This supports the absolute-path conversion fallback. Tests also exercise it directly for unusual Unix and Windows path cases, making sure the sealed-envelope behavior works.

*Call graph*: called by 2 (parse_posix_path, windows_opaque_path_uri); 3 external calls (parse, format!, unreachable!).


##### `PathUri::from_path`  (lines 113–117)

```
fn from_path(path: impl AsRef<Path>) -> io::Result<Self>
```

**Purpose**: Converts a native path into a `PathUri`, but only if the native path is absolute. It gives callers an I/O-style error when they accidentally pass a relative path.

**Data flow**: It receives anything path-like, checks that it is absolute, converts that into the project’s absolute-path wrapper, and then delegates to `from_abs_path`. It returns either a `PathUri` or an invalid-input error.

**Call relations**: This is the convenient entry point used by many callers that start with ordinary paths, such as filesystem helpers, thread setup, patch workflows, and tests. It hands valid absolute paths onward to the stricter absolute-path converter.

*Call graph*: calls 1 internal fn (from_absolute_path_checked); called by 89 (create_dir_all, read_file_text, write_file, fresh_thread_composes_global_before_project_and_reports_sources, multi_environment_thread_loads_every_project_and_keeps_creation_snapshot, apply_patch_turn_diff_tracks_local_and_remote_environment_paths, apply_patch_approvals_are_remembered_per_environment, apply_patch_freeform_routes_to_selected_remote_environment, apply_patch_intercepted_exec_command_routes_to_selected_remote_environment, exec_command_routes_to_selected_remote_environment (+15 more)); 1 external calls (from_abs_path).


##### `PathUri::encoded_path`  (lines 123–125)

```
fn encoded_path(&self) -> &str
```

**Purpose**: Returns the URI path text exactly as encoded inside the URL, without the `file:` scheme or host part. This is useful when code needs the path spelling rather than a native filesystem path.

**Data flow**: It reads the stored URL and returns its path portion as text. It does not decode percent escapes and does not change the `PathUri`.

**Call relations**: The parent calculation uses this to quickly recognize the URI root, where there is no parent to return.

*Call graph*: called by 1 (parent).


##### `PathUri::opaque_fallback_bytes`  (lines 127–129)

```
fn opaque_fallback_bytes(&self) -> Option<Vec<u8>>
```

**Purpose**: Checks whether this URI is one of the special fallback URIs, and if so returns the original stored bytes. It hides the details of the fallback format from the rest of the type.

**Data flow**: It reads the stored URL, tries to decode it as the reserved bad-path form, and returns either the recovered bytes or nothing. The `PathUri` itself is unchanged.

**Call relations**: Path convention inference and legacy path rendering use this when they need to inspect a URI that may not be a normal readable `file:` path.

*Call graph*: calls 1 internal fn (decode_bad_path_uri); called by 2 (infer_path_convention, from_path_uri).


##### `PathUri::infer_path_convention`  (lines 147–165)

```
fn infer_path_convention(&self) -> Option<PathConvention>
```

**Purpose**: Guesses whether the URI represents a Unix-style path or a Windows-style path. This helps code choose the right display or API format when the URI may have come from another environment.

**Data flow**: It first checks for fallback bytes and inspects their raw shape. Otherwise it looks for a URI host, which suggests a Windows network path, or a first segment like `C:`, which suggests a Windows drive. It returns a path convention when it can make a useful guess.

**Call relations**: Callers use this after they already have a `PathUri` and need to decide how to present or convert it. It relies on the fallback-byte helper and the opaque-byte convention detector for hard-to-represent paths.

*Call graph*: calls 2 internal fn (opaque_fallback_bytes, infer_opaque_path_convention).


##### `PathUri::basename`  (lines 172–181)

```
fn basename(&self) -> Option<String>
```

**Purpose**: Returns the final path segment, like a filename, from a normal path URI. It returns nothing for the root or for opaque fallback URIs that cannot be safely inspected segment by segment.

**Data flow**: It first rejects fallback URIs. Then it scans the URL path segments from the end, skips empty segments, decodes the chosen segment when possible, and returns it as a string.

**Call relations**: This is a lexical path helper: it works on URI text rather than asking the current operating system to interpret the path. It uses the fallback detector so it does not pretend to understand sealed fallback paths.

*Call graph*: calls 1 internal fn (decode_bad_path_uri).


##### `PathUri::parent`  (lines 185–199)

```
fn parent(&self) -> Option<Self>
```

**Purpose**: Returns the URI for the containing directory. It is used when code needs to move one level up in URI path terms without depending on the local operating system’s path rules.

**Data flow**: It rejects the root path and opaque fallback URIs. For normal URIs, it clones the stored URL, removes the trailing empty segment if present, removes one real segment, and returns the resulting `PathUri`.

**Call relations**: This builds on `encoded_path` for the root check and on the fallback detector for safety. It stays within URL path-segment logic instead of converting to a native path.

*Call graph*: calls 2 internal fn (encoded_path, decode_bad_path_uri); 1 external calls (unreachable!).


##### `PathUri::join`  (lines 209–246)

```
fn join(&self, path: &str) -> Result<Self, PathUriParseError>
```

**Purpose**: Adds a relative URI path onto this `PathUri`. It is meant for safe path composition where `.` and `..` behave like familiar directory navigation but cannot escape above the URI root.

**Data flow**: It receives relative text, rejects absolute paths and null characters, returns the original URI for an empty join, and rejects non-empty joins on opaque fallback URIs. For normal URIs, it walks each slash-separated component, skips empty and `.` parts, pops for `..`, pushes ordinary names, then revalidates the URL as a `PathUri`.

**Call relations**: Callers use this when they have a base URI and need a child path. It hands the final URL back through the same validation path used for parsed URLs, so joining cannot create an invalid `PathUri`.

*Call graph*: calls 1 internal fn (decode_bad_path_uri); 3 external calls (try_from, unreachable!, JoinPathMustBeRelative).


##### `PathUri::to_abs_path`  (lines 258–309)

```
fn to_abs_path(&self) -> io::Result<AbsolutePathBuf>
```

**Purpose**: Converts the `PathUri` back into an absolute native path for the current machine. It should only be used when the URI is known to refer to this host’s filesystem.

**Data flow**: It first checks for the special fallback form and, if present, decodes the original Unix bytes or Windows UTF-16 bytes depending on the current platform. It verifies that the decoded path is absolute and that converting it back would produce the same URI. For normal URIs, it asks the URL library for a native file path and then checks that it is absolute. The result is an absolute path or an invalid-input error.

**Call relations**: Filesystem-facing code such as canonicalization, file reads, metadata lookup, and sandbox setup calls this just before touching the local filesystem. It uses the same fallback decoder and absolute-path checker to avoid unsafe or host-incompatible conversions.

*Call graph*: calls 2 internal fn (from_absolute_path_checked, decode_bad_path_uri); called by 22 (canonicalize, read_file, get_metadata, read_file, get_metadata, read_file, native_sandbox_cwd, canonicalize, copy, create_directory (+12 more)); 4 external calls (from_abs_path, new, from_vec, from).


##### `PathUri::to_url`  (lines 312–314)

```
fn to_url(&self) -> Url
```

**Purpose**: Returns the underlying canonical URL as a clone. This is useful when another library or renderer needs a `Url` value rather than the project’s wrapper type.

**Data flow**: It reads the stored URL, clones it, and returns the clone. The original `PathUri` remains unchanged.

**Call relations**: Path rendering code uses this when producing POSIX-style or Windows-style output from a URI while still keeping `PathUri` immutable.

*Call graph*: called by 2 (render_posix_path, render_windows_path).


##### `PathUri::try_from`  (lines 335–337)

```
fn try_from(uri: String) -> Result<Self, Self::Error>
```

**Purpose**: Turns a parsed URL into a `PathUri` if it is a valid file URI. It is the central validation gate for URLs that are already parsed.

**Data flow**: It receives a URL, checks that its scheme is exactly `file`, validates the parts that are allowed for file URIs, removes a redundant `localhost` host if present, and returns the wrapped URL. If any rule fails, it returns a specific error.

**Call relations**: Parsing, string conversion, deserialization, joining, and helper code route URLs through this gate. It delegates detailed file-URI checks to `validate_file_url` and normalizes the local host alias with `without_localhost_authority`.

*Call graph*: calls 2 internal fn (validate_file_url, without_localhost_authority); called by 1 (path_uri_from_segments); 3 external calls (parse, scheme, UnsupportedScheme).


##### `PathUri::deserialize`  (lines 341–370)

```
fn deserialize(deserializer: D) -> Result<Self, D::Error>
```

**Purpose**: Reads a `PathUri` from serialized data, usually JSON. For backward compatibility, it also accepts an absolute native path string where older data may have stored one.

**Data flow**: It receives a serialized string, first tries to parse it as a URL and validate it as a `PathUri`. If that fails only because the string is not a URL or looks like an unsupported scheme, it tries to treat the string as an absolute native path and converts it with `from_abs_path`. It returns a `PathUri` or a deserialization error.

**Call relations**: Serde, the Rust serialization framework, calls this automatically when loading data containing `PathUri`. It hands real URLs to `try_from` and legacy absolute paths to the native-path conversion path.

*Call graph*: calls 1 internal fn (from_absolute_path_checked); 6 external calls (from_abs_path, try_from, deserialize, parse, custom, InvalidUri).


##### `PathUri::from_str`  (lines 376–378)

```
fn from_str(uri: &str) -> Result<Self, Self::Err>
```

**Purpose**: Allows `PathUri` to be created with Rust’s standard string-parsing pattern. It is a thin wrapper around the normal parser.

**Data flow**: It receives string text and passes it to `PathUri::parse`. The output is the same success value or parse error that `parse` would produce.

**Call relations**: Any code using the standard `FromStr` interface, such as `"file:///tmp/a".parse()`, reaches the same validation behavior as direct parsing.

*Call graph*: 1 external calls (parse).


##### `PathUri::fmt`  (lines 382–384)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Defines how a `PathUri` is printed as text. It shows the canonical URI string stored inside the wrapper.

**Data flow**: It receives a formatter, writes the inner URL’s display form into it, and returns the formatting result. It does not change the URI.

**Call relations**: Rust’s display machinery calls this whenever a `PathUri` is formatted with `{}` or converted to a user-facing string through display formatting.


##### `PathUri::serialize`  (lines 388–393)

```
fn serialize(&self, serializer: S) -> Result<S::Ok, S::Error>
```

**Purpose**: Writes a `PathUri` into serialized data as a plain string. This keeps JSON and API representations simple.

**Data flow**: It receives a serializer, reads the inner URL’s string form, and asks the serializer to emit that string. The output is the serializer’s success value or error.

**Call relations**: Serde calls this automatically when saving structures that contain `PathUri`. Deserialization later reads the same string form back through the validation path.

*Call graph*: 1 external calls (serialize_str).


##### `PathUri::schema_name`  (lines 397–399)

```
fn schema_name() -> String
```

**Purpose**: Names this type as `PathUri` in generated JSON schemas. A JSON schema is a machine-readable description of what serialized data should look like.

**Data flow**: It takes no input from a value and returns the fixed schema name string `PathUri`.

**Call relations**: Schema generation tools call this when documenting or validating API shapes that include `PathUri`.


##### `PathUri::json_schema`  (lines 401–403)

```
fn json_schema(generator: &mut schemars::r#gen::SchemaGenerator) -> schemars::schema::Schema
```

**Purpose**: Describes `PathUri` values in JSON schemas as strings. This matches the way the type is serialized.

**Data flow**: It receives a schema generator and asks the normal string type to produce the schema. The result is a schema saying that serialized `PathUri` data is string-shaped.

**Call relations**: Schema generation calls this alongside the schema name. It deliberately reuses the string schema because consumers see a URI string, not the internal Rust wrapper.

*Call graph*: 1 external calls (json_schema).


##### `without_localhost_authority`  (lines 407–414)

```
fn without_localhost_authority(mut url: Url) -> Url
```

**Purpose**: Removes `localhost` from a file URI’s host field because `file://localhost/path` and `file:///path` mean the same local file location. It keeps non-local hosts, such as Windows network shares.

**Data flow**: It receives a URL, checks whether its host is exactly `localhost`, and if so clears the host field. It returns the possibly-normalized URL.

**Call relations**: The URL-to-`PathUri` validation path calls this after proving the URL is a valid file URI. That keeps stored URIs canonical while preserving real remote or UNC authorities.

*Call graph*: called by 1 (try_from); 3 external calls (host_str, set_host, unreachable!).


##### `decode_uri_path`  (lines 421–425)

```
fn decode_uri_path(path: &str) -> String
```

**Purpose**: Turns percent-encoded URI path text into readable text when the decoded bytes are valid UTF-8. If decoding would produce invalid text, it leaves the encoded spelling intact.

**Data flow**: It receives one URI path segment or path string, tries percent-decoding it, and returns either the decoded text or the original encoded text. Nothing else is changed.

**Call relations**: This supports human-friendly lexical inspection, especially for final path names. It avoids losing information when a `file:` URI contains encoded bytes that are not valid text.

*Call graph*: 1 external calls (decode).


##### `decode_bad_path_uri`  (lines 428–439)

```
fn decode_bad_path_uri(url: &Url) -> Option<Vec<u8>>
```

**Purpose**: Recognizes and decodes the reserved fallback URI format used for paths that could not be represented normally. It prevents ordinary paths from being mistaken for fallback paths by checking the exact prefix and canonical base64 spelling.

**Data flow**: It receives a URL, checks for the reserved bad-path prefix, rejects empty or slash-containing payloads, decodes the base64 bytes, and confirms that re-encoding gives the same text. It returns the original path bytes or nothing.

**Call relations**: Many safety checks call this before inspecting or converting a URI. Basename, parent, join, native conversion, path convention guessing, and validation all use it to treat fallback URIs differently from normal file paths.

*Call graph*: called by 6 (basename, join, opaque_fallback_bytes, parent, to_abs_path, validate_file_url); 1 external calls (as_str).


##### `is_windows_drive_uri_segment`  (lines 441–443)

```
fn is_windows_drive_uri_segment(segment: &str) -> bool
```

**Purpose**: Checks whether a URI path segment looks like a Windows drive marker such as `C:`. This helps identify Windows paths even when the current machine is not Windows.

**Data flow**: It receives one path segment as text, checks whether it is exactly an ASCII letter followed by a colon, and returns true or false.

**Call relations**: Path convention inference uses this test while scanning URI path segments. It is one small rule in deciding whether a URI should be treated as Windows-style.

*Call graph*: 1 external calls (matches!).


##### `infer_opaque_path_convention`  (lines 445–462)

```
fn infer_opaque_path_convention(path_bytes: &[u8]) -> Option<PathConvention>
```

**Purpose**: Guesses whether raw fallback path bytes look like an absolute Unix path or an absolute Windows path. This is needed because fallback URIs hide the path from normal URL segment inspection.

**Data flow**: It receives raw bytes. If they start with `/`, it reports POSIX. Otherwise it checks whether the bytes can be read as pairs of Windows UTF-16 little-endian values and looks for a drive prefix like `C:` or a network prefix like `\\`. It returns Windows, POSIX, or nothing if the bytes are unclear.

**Call relations**: The public path convention inference method calls this after extracting bytes from an opaque fallback URI. It lets even hard-to-represent paths carry enough clues for display and routing decisions.

*Call graph*: called by 1 (infer_path_convention); 2 external calls (from, try_from).


##### `validate_common_known_uri`  (lines 465–479)

```
fn validate_common_known_uri(url: &Url) -> Result<(), PathUriParseError>
```

**Purpose**: Rejects URL parts that this project does not allow in path URIs. For files, usernames, passwords, ports, query strings, and fragments have no safe defined meaning here.

**Data flow**: It receives a URL and checks each disallowed field. If all are absent, it returns success; otherwise it returns the matching validation error.

**Call relations**: File-URL validation calls this first, before checking file-specific path rules. It provides the shared “no extra URL metadata” policy.

*Call graph*: called by 1 (validate_file_url); 5 external calls (fragment, password, port, query, username).


##### `validate_file_url`  (lines 482–494)

```
fn validate_file_url(url: &Url) -> Result<(), PathUriParseError>
```

**Purpose**: Applies all validation rules for a `file:` URL before it can become a `PathUri`. It blocks unsafe path bytes while allowing the project’s own special fallback form.

**Data flow**: It receives a URL, runs the common metadata checks, then percent-decodes the path bytes to see whether they contain a null byte. A null byte is rejected unless the URL is recognized as the reserved fallback format. It returns success or a specific parse error.

**Call relations**: The central URL-to-`PathUri` conversion calls this for every parsed URL. It uses the fallback decoder so legitimate sealed fallback URIs are allowed while ordinary unsafe file URIs are not.

*Call graph*: calls 2 internal fn (decode_bad_path_uri, validate_common_known_uri); called by 1 (try_from); 3 external calls (path, to_string, decode_binary).


### `utils/absolute-path/src/lib.rs`

`util` · `cross-cutting`

Many parts of the project need to talk about files and folders. A plain path string can be vague: `logs/output.txt` depends on “where you are standing,” while `/tmp/logs/output.txt` does not. This file gives the project a wrapper around normal paths that promises: once you have an `AbsolutePathBuf`, it is absolute and normalized, even if the file does not actually exist.

The main job is turning messy user input into dependable paths. It expands `~` to the user’s home directory, resolves relative paths against a known base folder, removes simple `.` and `..` path pieces, and smooths over special Windows path prefixes. This is like turning “the blue house two blocks from here” into a full street address before handing it to someone else.

The file also supports configuration loading. When paths are read from JSON or TOML-like data, relative paths need a base directory. `AbsolutePathBufGuard` temporarily stores that base path for the current thread while deserialization happens. Without this guard, relative paths in config would be ambiguous and are rejected.

Finally, it includes careful canonicalization helpers. Canonicalization means asking the operating system for the “real” path, resolving links. These helpers avoid unexpectedly replacing a user’s logical symlink path with its hidden target when that would be confusing.

#### Function details

##### `AbsolutePathBuf::maybe_expand_home_directory`  (lines 27–43)

```
fn maybe_expand_home_directory(path: &Path) -> PathBuf
```

**Purpose**: Turns paths that start with `~` into paths under the current user’s home directory. This lets people write familiar paths like `~/code` in configuration.

**Data flow**: It receives a path. If the path can be read as text, starts with `~`, and the system can find a home directory, it replaces `~` with that home directory and keeps the rest of the path. Otherwise, it returns the original path as a new path buffer.

**Call relations**: This is an early cleanup step used by the path constructors. `resolve_path_against_base`, `from_absolute_path`, and `from_absolute_path_checked` call it before they normalize and absolutize the path.

*Call graph*: 4 external calls (to_path_buf, to_str, cfg!, home_dir).


##### `AbsolutePathBuf::resolve_path_against_base`  (lines 45–56)

```
fn resolve_path_against_base(
        path: P,
        base_path: B,
    ) -> Self
```

**Purpose**: Builds an `AbsolutePathBuf` from either an absolute path or a relative path plus a base folder. Use it when a path from config or user input should be understood relative to a known directory.

**Data flow**: It takes an input path and a base path. It expands `~`, normalizes platform-specific spelling, normalizes the base path, and then combines them so relative input becomes absolute while already absolute input stays absolute. It returns a new `AbsolutePathBuf`.

**Call relations**: This is one of the main entry points for creating safe paths. Config writing, file patching, cache setup, and many path-resolution flows call it when they need a relative path anchored to a known place.

*Call graph*: calls 2 internal fn (absolutize_from, normalize_path_for_platform); called by 53 (config_batch_write_applies_multiple_edits, config_value_write_replaces_value, apply_hunks_to_files, resolve_path, create_test_cache, new, create_test_cache, home_relative_path_fields_are_allowed_and_resolved, relative_absolute_path_fields_resolve_against_base_dir, load_config_layers_state (+15 more)); 3 external calls (as_ref, as_ref, maybe_expand_home_directory).


##### `AbsolutePathBuf::from_absolute_path`  (lines 58–62)

```
fn from_absolute_path(path: P) -> std::io::Result<Self>
```

**Purpose**: Creates an `AbsolutePathBuf` from a path that is expected to become absolute after normal path cleanup. It accepts existing absolute paths and also relies on the lower-level absolutizing logic for final normalization.

**Data flow**: It takes a path, expands `~`, normalizes platform-specific spelling, and asks the internal absolutizing code to produce a cleaned absolute path. It returns either the safe wrapper or an input/output error.

**Call relations**: Many runtime pieces call this when they already have paths that should be absolute, such as socket paths, startup lock paths, permission scopes, and test paths.

*Call graph*: calls 2 internal fn (absolutize, normalize_path_for_platform); called by 271 (remote_unix_socket_typed_request_roundtrip_works, app_server_control_socket_path, app_server_startup_lock_path, absolute_path, test_socket_path, test_startup_lock_path, request_permissions_response_accepts_explicit_child_grant_for_requested_cwd_scope, request_permissions_response_ignores_broader_cwd_grant_for_requested_child_path, request_permissions_response_rejects_child_grant_outside_requested_cwd_scope, apply_edits (+15 more)); 2 external calls (as_ref, maybe_expand_home_directory).


##### `AbsolutePathBuf::from_absolute_path_checked`  (lines 64–78)

```
fn from_absolute_path_checked(path: P) -> std::io::Result<Self>
```

**Purpose**: Creates an `AbsolutePathBuf` only if the supplied path is already absolute after home-directory and platform cleanup. It is useful when accepting a relative path would be a bug.

**Data flow**: It takes a path, expands `~`, normalizes platform-specific spelling, and checks whether the result is absolute. If not, it returns an invalid-input error. If yes, it normalizes the path and returns `AbsolutePathBuf`.

**Call relations**: Loaders, plugin setup, and tests call this when they need to enforce a strict “must already be absolute” rule instead of silently resolving against the current directory.

*Call graph*: calls 2 internal fn (absolutize_from, normalize_path_for_platform); called by 36 (model_provider_auth_from_proto, loader_translates_sources_to_config_layers, host_and_executor_sources_parse_the_same_manifest, selected_plugin_root, malformed_preferred_manifest_does_not_fall_through_to_alternate, plugin_root_resolution_uses_supplied_executor_file_system, try_new, load_default_with_cli_overrides_for_codex_home, with_models_provider_home_and_state_for_tests, malformed_declared_config_is_an_error (+15 more)); 5 external calls (as_ref, new, maybe_expand_home_directory, new, format!).


##### `AbsolutePathBuf::current_dir`  (lines 80–82)

```
fn current_dir() -> std::io::Result<Self>
```

**Purpose**: Returns the process’s current working directory as an `AbsolutePathBuf`. This gives callers a safe, normalized version of “where the program is running right now.”

**Data flow**: It asks the operating system for the current directory, then passes that path through `from_absolute_path`. The result is either a safe absolute path or an error from the operating system/path cleanup.

**Call relations**: Startup and command-running code call this when they need a dependable current directory before building more paths or launching work.

*Call graph*: called by 67 (cancellation_expiration_keeps_process_alive_until_terminated, timeout_or_cancellation_reports_cancellation_without_timeout_exit_code, windows_sandbox_exec_request, run_main, arg0_dispatch, workspace_dir, build_inner, default_thread_environment_selections_empty_when_default_disabled, default_thread_environment_selections_use_manager_default_id, latest_environment_update_wins_while_previous_resolution_is_pending (+15 more)); 2 external calls (from_absolute_path, current_dir).


##### `AbsolutePathBuf::relative_to_current_dir`  (lines 86–91)

```
fn relative_to_current_dir(path: P) -> std::io::Result<Self>
```

**Purpose**: Turns a path into an absolute path by resolving relative input against the process’s current working directory. This is useful for command-line or server inputs that are naturally typed relative to where the program was started.

**Data flow**: It receives a path, asks the operating system for the current directory, then calls `resolve_path_against_base` with that directory. It returns a new `AbsolutePathBuf` or an error if the current directory cannot be read.

**Call relations**: URL parsing, current-working-directory configuration, thread summaries, and socket path parsing use this when relative user input should mean “relative to this running process.”

*Call graph*: called by 21 (from_listen_url, resolve_cwd_config, normalize_thread_list_cwd_filters, thread_from_stored_thread, normalize_thread_list_cwd_filter_resolves_relative_paths_against_server_cwd, summary_to_thread, parse_allow_unix_socket_path, parse_socket_path, collect_explicit_skill_mentions, build_inner (+11 more)); 2 external calls (resolve_path_against_base, current_dir).


##### `AbsolutePathBuf::join`  (lines 93–95)

```
fn join(&self, path: P) -> Self
```

**Purpose**: Combines this absolute path with another path and returns a new absolute path. If the added path is relative, it is placed under this path; if it is absolute, it wins.

**Data flow**: It takes `self` as the base and another path as the child/input. It calls `resolve_path_against_base`, which expands and normalizes the child path against `self`. The output is a fresh `AbsolutePathBuf`.

**Call relations**: Code that builds paths under the project home, plugin roots, hooks, manifests, and other known folders calls this instead of manually stitching strings together.

*Call graph*: called by 39 (from_core_with_cwd, new, load_from_codex_home, project_ignored_config_keys_warning, default_skill_roots, load_plugin_hooks, write_hook_file, write_manifest, resolve_plugin_root, update_personal_marketplace (+15 more)); 1 external calls (resolve_path_against_base).


##### `AbsolutePathBuf::canonicalize`  (lines 97–99)

```
fn canonicalize(&self) -> std::io::Result<Self>
```

**Purpose**: Asks the operating system for the canonical, real filesystem path for this path. This requires the path to exist.

**Data flow**: It reads the wrapped path and calls canonicalization through `dunce`, a helper crate that avoids awkward Windows path spellings. It returns a new `AbsolutePathBuf` on success or an error if the path cannot be canonicalized.

**Call relations**: Higher-level helpers such as “canonicalize if exists” call this when they need the filesystem’s confirmed version of a path.

*Call graph*: called by 1 (canonicalize_if_exists); 1 external calls (canonicalize).


##### `AbsolutePathBuf::parent`  (lines 101–109)

```
fn parent(&self) -> Option<Self>
```

**Purpose**: Returns the parent folder of this absolute path, if there is one. It preserves the guarantee that the result is also absolute.

**Data flow**: It reads the wrapped path’s parent. If a parent exists, it copies that parent into a new `AbsolutePathBuf`; if not, it returns nothing.

**Call relations**: File-saving, git-root discovery, skill metadata loading, and similar code use this when walking upward from a known file or directory.

*Call graph*: called by 12 (new_add_for_test, write_file_with_missing_parent_retry, save, find_git_checkout_root, load_requirements_toml, default_skill_name, load_skill_metadata, read_resolved_agent_role_file, write_shell_snapshot, default_output_csv_path (+2 more)).


##### `AbsolutePathBuf::ancestors`  (lines 111–119)

```
fn ancestors(&self) -> impl Iterator<Item = Self> + '_
```

**Purpose**: Iterates from this path upward through each parent directory to the filesystem root. Every item yielded is still an `AbsolutePathBuf`.

**Data flow**: It reads the wrapped path’s ancestor iterator and wraps each ancestor path in `AbsolutePathBuf`. The output is a sequence of safe absolute paths.

**Call relations**: Project-root discovery, config-layer loading, git lookup, and plugin namespace detection use this when they need to search parent directories one by one.

*Call graph*: called by 6 (find_project_root, load_project_layers, dirs_between_project_root_and_cwd, find_project_root, find_ancestor_git_entry_with_fs, plugin_namespace_for_skill_path).


##### `AbsolutePathBuf::as_path`  (lines 121–123)

```
fn as_path(&self) -> &Path
```

**Purpose**: Borrows the inner standard path without taking ownership. This lets other code pass the safe path into APIs that expect a normal `Path`.

**Data flow**: It receives `self` by reference and returns a borrowed reference to the internal path. Nothing is copied or changed.

**Call relations**: Network socket setup, file edits, command execution, startup locks, and many other callers use this at the boundary where ordinary filesystem APIs need a standard path reference.

*Call graph*: called by 58 (connect_unix_socket_endpoint, drop, acquire_app_server_startup_lock, start_control_socket_acceptor, create_empty_user_layer, derive_new_contents_from_chunks, run_command_under_windows_session, wait_for_foreground_remote_control_ready, cloud_config_layers_from_fragments_impl, validate_fragment_strictly (+15 more)).


##### `AbsolutePathBuf::into_path_buf`  (lines 125–127)

```
fn into_path_buf(self) -> PathBuf
```

**Purpose**: Consumes the wrapper and returns the ordinary owned path inside it. Use this when the caller no longer needs the safety wrapper.

**Data flow**: It takes ownership of the `AbsolutePathBuf`, unwraps its inner `PathBuf`, and returns that `PathBuf`. The original wrapper is gone afterward.

**Call relations**: The conversion from `AbsolutePathBuf` into `PathBuf` delegates to this so there is one clear way to unwrap the stored path.

*Call graph*: called by 1 (from).


##### `AbsolutePathBuf::to_path_buf`  (lines 129–131)

```
fn to_path_buf(&self) -> PathBuf
```

**Purpose**: Copies the inner path into a normal owned `PathBuf`. This is useful when other code needs its own editable copy.

**Data flow**: It borrows `self`, clones the internal path buffer, and returns the clone. The original `AbsolutePathBuf` is unchanged.

**Call relations**: Plugin source resolution, home-directory setup, marketplace tests, and other code call this when they need to store or transform a standard path value.

*Call graph*: called by 18 (new_add_for_test, invalid_marketplace_layout_error, normalize_git_plugin_source_url, normalize_relative_git_plugin_source_url, normalize_remote_plugin_subdir, resolve_local_plugin_source_path, personal_marketplace_relative_plugin_path, codex_home, rebuild_preserving_session_layers, to_mcp_config_with_plugin_registrations (+8 more)).


##### `AbsolutePathBuf::to_string_lossy`  (lines 133–135)

```
fn to_string_lossy(&self) -> std::borrow::Cow<'_, str>
```

**Purpose**: Turns the path into readable text, replacing any invalid text bytes with safe placeholder characters. This is mainly for display, prompts, logs, or command construction.

**Data flow**: It borrows the inner path and asks the standard library for a lossy string view. The output is a borrowed-or-owned string-like value, depending on whether conversion was clean.

**Call relations**: Prompt building, command display, policy messages, and metadata naming use this when a path must be shown as text.

*Call graph*: called by 9 (from, normalized_path, prompt, commands_for_intercepted_exec_policy, join_program_and_argv, seatbelt_protected_metadata_name_regex, prepare_escalated_exec, prepare_escalated_exec, from_abs_path).


##### `AbsolutePathBuf::display`  (lines 137–139)

```
fn display(&self) -> Display<'_>
```

**Purpose**: Returns a display helper for printing the path in user-facing messages. It avoids forcing an immediate string allocation.

**Data flow**: It borrows the inner path and returns the standard display wrapper. The path is not changed.

**Call relations**: Home setup, snapshot validation, shell snapshot writing, and hook-source messages use this when formatting paths for people.

*Call graph*: called by 5 (codex_home, validate_snapshot, write_shell_snapshot, hook_handler_source, unmanaged_hook_handler_source).


##### `normalize_path_for_platform`  (lines 142–151)

```
fn normalize_path_for_platform(path: &Path) -> Cow<'_, Path>
```

**Purpose**: Cleans up platform-specific path spelling before deeper path processing. Its main special case is removing supported Windows device prefixes that would otherwise leak into normal paths.

**Data flow**: It receives a path. On Windows, if the path can be read as text and matches a supported device-style prefix, it returns an owned normalized path. Otherwise, it returns a borrowed view of the original path.

**Call relations**: All main constructors call this after home expansion. It hands Windows-specific work to `normalize_windows_device_path`.

*Call graph*: calls 1 internal fn (normalize_windows_device_path); called by 3 (from_absolute_path, from_absolute_path_checked, resolve_path_against_base); 5 external calls (Borrowed, Owned, to_str, from, cfg!).


##### `normalize_windows_device_path`  (lines 153–171)

```
fn normalize_windows_device_path(path: &str) -> Option<String>
```

**Purpose**: Recognizes certain Windows “device” or “verbatim” path forms and rewrites them into ordinary Windows path spelling. This prevents paths like `\\?\C:\...` from spreading through the rest of the program.

**Data flow**: It receives a path string. If it starts with a supported UNC or drive-letter device prefix, it strips or rewrites that prefix and returns the normalized string. If the form is unsupported, it returns nothing.

**Call relations**: Only `normalize_path_for_platform` calls this, keeping Windows path quirks isolated in one helper.

*Call graph*: calls 1 internal fn (is_windows_drive_absolute_path); called by 1 (normalize_path_for_platform); 1 external calls (format!).


##### `is_windows_drive_absolute_path`  (lines 173–179)

```
fn is_windows_drive_absolute_path(path: &str) -> bool
```

**Purpose**: Checks whether a string looks like an absolute Windows drive path such as `C:\folder` or `D:/folder`. It is a small safety check before stripping device prefixes.

**Data flow**: It reads the string as bytes and verifies three things: a letter, a colon, and then a slash or backslash. It returns true or false.

**Call relations**: `normalize_windows_device_path` uses this so it only accepts device-prefixed drive paths that are truly absolute.

*Call graph*: called by 1 (normalize_windows_device_path); 1 external calls (matches!).


##### `canonicalize_preserving_symlinks`  (lines 189–197)

```
fn canonicalize_preserving_symlinks(path: &Path) -> std::io::Result<PathBuf>
```

**Purpose**: Produces a cleaned absolute path while avoiding unwanted replacement of nested symbolic-link paths with their real targets. A symbolic link is a filesystem shortcut that points somewhere else.

**Data flow**: It first makes a logical absolute path. It then checks whether any nested ancestor is a symbolic link. If operating-system canonicalization succeeds but would rewrite such a logical path, it returns the logical path instead; if canonicalization fails, it still returns the logical absolute path.

**Call relations**: Tests call this directly to verify symlink behavior and Windows prefix behavior. It uses `from_absolute_path` for logical cleanup and `should_preserve_logical_path` to decide whether to keep the user-visible route.

*Call graph*: calls 2 internal fn (from_absolute_path, should_preserve_logical_path); called by 3 (canonicalize_preserving_symlinks_avoids_verbatim_prefixes, canonicalize_preserving_symlinks_keeps_logical_missing_child_under_symlink, canonicalize_preserving_symlinks_keeps_logical_symlink_path); 1 external calls (canonicalize).


##### `canonicalize_existing_preserving_symlinks`  (lines 204–212)

```
fn canonicalize_existing_preserving_symlinks(path: &Path) -> std::io::Result<PathBuf>
```

**Purpose**: Canonicalizes a path that must exist, while still preserving logical nested symlink paths when canonicalization would rewrite them. It is stricter than `canonicalize_preserving_symlinks` because missing paths are errors.

**Data flow**: It builds the logical absolute path, asks the operating system to canonicalize the original path, and then compares the result. If nested symlink preservation applies and the canonical path differs, it returns the logical path; otherwise it returns the canonical path. Canonicalization errors are passed back.

**Call relations**: Tests call this to confirm missing paths fail and symlink paths stay logical. It shares the same preservation decision helper as `canonicalize_preserving_symlinks`.

*Call graph*: calls 2 internal fn (from_absolute_path, should_preserve_logical_path); called by 2 (canonicalize_existing_preserving_symlinks_errors_for_missing_path, canonicalize_existing_preserving_symlinks_keeps_logical_symlink_path); 1 external calls (canonicalize).


##### `should_preserve_logical_path`  (lines 214–221)

```
fn should_preserve_logical_path(logical: &Path) -> bool
```

**Purpose**: Decides whether a logical path should be kept instead of replaced by a canonical target because it passes through a nested symbolic link.

**Data flow**: It walks through the path and its ancestors. For each existing ancestor, it checks filesystem metadata to see whether that ancestor is a symbolic link and is not just a top-level alias. It returns true if such a nested link is found.

**Call relations**: Both symlink-preserving canonicalization functions call this before deciding whether to return the logical path or the filesystem’s canonical answer.

*Call graph*: called by 2 (canonicalize_existing_preserving_symlinks, canonicalize_preserving_symlinks); 1 external calls (ancestors).


##### `AbsolutePathBuf::as_ref`  (lines 224–226)

```
fn as_ref(&self) -> &Path
```

**Purpose**: Allows `AbsolutePathBuf` to be used wherever Rust code expects something that can be viewed as a standard `Path`. This is a convenience bridge to common path APIs.

**Data flow**: It borrows the wrapper and returns a borrowed reference to the inner path. No allocation or mutation happens.

**Call relations**: This trait implementation supports generic code that accepts `AsRef<Path>`, including path constructors and many filesystem helpers elsewhere.


##### `AbsolutePathBuf::deref`  (lines 232–234)

```
fn deref(&self) -> &Self::Target
```

**Purpose**: Lets an `AbsolutePathBuf` behave like a normal `Path` for read-only path operations. This makes the wrapper easier to use without constantly unwrapping it.

**Data flow**: It borrows the wrapper and returns a borrowed reference to the inner `Path`. The stored path remains unchanged.

**Call relations**: Rust’s automatic dereferencing can use this whenever code calls `Path` methods directly on an `AbsolutePathBuf`.


##### `PathBuf::from`  (lines 238–240)

```
fn from(path: AbsolutePathBuf) -> Self
```

**Purpose**: Converts an `AbsolutePathBuf` into a normal `PathBuf`. This is useful at boundaries that cannot keep the stronger wrapper type.

**Data flow**: It takes ownership of the safe wrapper, calls `into_path_buf`, and returns the inner ordinary path buffer.

**Call relations**: This conversion relies on `AbsolutePathBuf::into_path_buf`, keeping the unwrap behavior consistent.

*Call graph*: calls 1 internal fn (into_path_buf).


##### `test_support::test_path_buf`  (lines 252–265)

```
fn test_path_buf(unix_path: &str) -> PathBuf
```

**Purpose**: Creates platform-correct absolute test paths from Unix-style strings. This lets tests write simple paths like `/tmp/example` and still work on Windows.

**Data flow**: It receives a Unix-style path string. On Windows, it turns it into a `C:\...` path by splitting on `/`; on other systems, it uses the string as-is. It returns a standard `PathBuf`.

**Call relations**: Unit tests use this helper when they need expected absolute paths that compare correctly across operating systems.

*Call graph*: 2 external calls (from, cfg!).


##### `test_support::Path::abs`  (lines 275–278)

```
fn abs(&self) -> AbsolutePathBuf
```

**Purpose**: Test-only shortcut that converts an already absolute `Path` into an `AbsolutePathBuf`. It keeps tests readable while still enforcing the absolute-path rule.

**Data flow**: It borrows a `Path`, calls `from_absolute_path_checked`, and expects success. If the test supplied a relative path, the test fails immediately.

**Call relations**: This trait method is used from test code through the `PathExt` extension trait. It depends on the strict checked constructor.

*Call graph*: calls 1 internal fn (from_absolute_path_checked).


##### `test_support::PathBuf::abs`  (lines 288–290)

```
fn abs(&self) -> AbsolutePathBuf
```

**Purpose**: Test-only shortcut that converts an already absolute `PathBuf` into an `AbsolutePathBuf`. It mirrors the path-reference helper for owned path buffers.

**Data flow**: It borrows the `PathBuf` as a `Path` and calls the test `abs` helper for paths. The output is an `AbsolutePathBuf` or a test failure if the input is not absolute.

**Call relations**: This extension method builds on `test_support::Path::abs` so tests can use the same simple `.abs()` style for both borrowed and owned paths.


##### `AbsolutePathBuf::try_from`  (lines 321–323)

```
fn try_from(value: String) -> Result<Self, Self::Error>
```

**Purpose**: Provides fallible conversion into `AbsolutePathBuf` from supported path-like inputs. “Fallible” means the conversion can return an error instead of panicking.

**Data flow**: It receives a path-like value, passes it to `from_absolute_path`, and returns either the safe absolute wrapper or an input/output error.

**Call relations**: Serialization tests, plugin interfaces, argument parsing, and many other call sites use these conversions when they want standard Rust `try_from` behavior for path input.

*Call graph*: called by 245 (marketplace_remove_response_serializes_nullable_installed_root, marketplace_upgrade_response_serializes_camel_case_fields, plugin_install_params_serialization_omits_force_remote_sync, plugin_interface_serializes_local_paths_and_remote_urls_separately, plugin_read_params_serialization_uses_install_source_fields, plugin_share_params_and_response_serialization_use_camel_case_fields, plugin_source_serializes_local_git_and_remote_variants, absolute_path_arg, read, read_includes_origins_and_layers (+15 more)); 1 external calls (from_absolute_path).


##### `AbsolutePathBufGuard::new`  (lines 337–342)

```
fn new(base_path: &Path) -> Self
```

**Purpose**: Temporarily sets the base directory used when deserializing relative `AbsolutePathBuf` values. It is like placing a bookmark that says, “interpret relative paths from here.”

**Data flow**: It receives a base path and stores a copy in thread-local storage, meaning storage visible only to the current thread. It returns a guard object whose lifetime controls how long that base remains set.

**Call relations**: Configuration validation and loading code creates this guard before deserializing path-containing settings. `AbsolutePathBuf::deserialize` reads the base path that this function stores.

*Call graph*: called by 23 (validate_fragment_strictly, deserialize_filesystem_deny_read_glob_requirements, first_layer_config_error_for_entries, validate_config_toml_strictly, validate_managed_config_toml_strictly_if_requested, project_trust_context, resolve_relative_paths_in_config_toml, validate_cli_overrides_strictly, validate_config_toml_strictly, load_skill_metadata (+13 more)).


##### `AbsolutePathBufGuard::drop`  (lines 346–350)

```
fn drop(&mut self)
```

**Purpose**: Clears the temporary deserialization base path when the guard goes out of scope. This prevents one config load’s base directory from accidentally affecting another.

**Data flow**: It runs automatically when the guard is destroyed. It sets the thread-local base path back to `None` and returns nothing.

**Call relations**: Rust calls this as part of cleanup. It pairs with `AbsolutePathBufGuard::new` to make the base-path setting temporary and scoped.


##### `AbsolutePathBuf::deserialize`  (lines 354–368)

```
fn deserialize(deserializer: D) -> Result<Self, D::Error>
```

**Purpose**: Reads an `AbsolutePathBuf` from serialized data such as JSON, while resolving relative paths only when a base path has been set. This keeps configuration paths clear and safe.

**Data flow**: It first deserializes the input as a normal `PathBuf`. If a guard-provided base path exists, it resolves the path against that base. If no base exists but the path is already absolute, it accepts it. If no base exists and the path is relative, it returns a deserialization error.

**Call relations**: Config and tests trigger this through Serde, the Rust serialization framework. It depends on `AbsolutePathBufGuard::new` having been used when relative paths are allowed.

*Call graph*: called by 2 (deserialize_absolute_path, default_provider_auth_cwd); 1 external calls (deserialize).


##### `tests::create_with_absolute_path_ignores_base_path`  (lines 382–390)

```
fn create_with_absolute_path_ignores_base_path()
```

**Purpose**: Checks that an already absolute path is not wrongly placed under the supplied base path.

**Data flow**: The test creates two temporary directories, resolves an absolute file path against an unrelated base, and compares the result with the original absolute path.

**Call relations**: The test runner calls this. It exercises `AbsolutePathBuf::resolve_path_against_base` for the absolute-input case.

*Call graph*: calls 1 internal fn (resolve_path_against_base); 2 external calls (assert_eq!, tempdir).


##### `tests::from_absolute_path_does_not_read_current_dir_when_path_is_absolute`  (lines 394–403)

```
fn from_absolute_path_does_not_read_current_dir_when_path_is_absolute()
```

**Purpose**: Verifies that absolute-path construction does not depend on the current working directory when the input is already absolute.

**Data flow**: The test launches the current test binary as a child process with an environment flag. It expects that child test to succeed.

**Call relations**: This test coordinates with `tests::from_absolute_path_with_removed_current_dir_child`, which performs the risky current-directory removal in a separate process.

*Call graph*: 3 external calls (assert!, new, current_exe).


##### `tests::from_absolute_path_with_removed_current_dir_child`  (lines 408–430)

```
fn from_absolute_path_with_removed_current_dir_child()
```

**Purpose**: Child-process test proving that `from_absolute_path` still works even when the process’s current directory has been deleted.

**Data flow**: When the special environment flag is present, it enters a temporary directory, deletes that directory, confirms the current directory can no longer be read, then constructs an absolute path and checks the normalized result.

**Call relations**: It is launched by `tests::from_absolute_path_does_not_read_current_dir_when_path_is_absolute`. It directly exercises `AbsolutePathBuf::from_absolute_path` under an unusual filesystem condition.

*Call graph*: calls 1 internal fn (from_absolute_path); 7 external calls (assert_eq!, current_dir, set_current_dir, var_os, remove_dir, tempdir, test_path_buf).


##### `tests::from_absolute_path_checked_rejects_relative_path`  (lines 433–438)

```
fn from_absolute_path_checked_rejects_relative_path()
```

**Purpose**: Confirms that the strict constructor rejects relative paths.

**Data flow**: The test passes `relative/path` to `from_absolute_path_checked`, expects an error, and checks that the error kind is invalid input.

**Call relations**: The test runner calls this to protect the contract of `AbsolutePathBuf::from_absolute_path_checked`.

*Call graph*: calls 1 internal fn (from_absolute_path_checked); 1 external calls (assert_eq!).


##### `tests::normalize_windows_device_path_strips_supported_verbatim_prefixes`  (lines 441–462)

```
fn normalize_windows_device_path_strips_supported_verbatim_prefixes()
```

**Purpose**: Checks that supported Windows device-style prefixes are normalized and unsupported ones are left alone.

**Data flow**: The test feeds several Windows path strings into `normalize_windows_device_path` and compares each result with the expected normalized string or `None`.

**Call relations**: This directly tests the helper used by `normalize_path_for_platform`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::from_absolute_path_strips_windows_verbatim_prefix`  (lines 466–475)

```
fn from_absolute_path_strips_windows_verbatim_prefix()
```

**Purpose**: On Windows, verifies that constructing a checked absolute path removes a supported verbatim prefix.

**Data flow**: The test passes a `\\?\D:\...` style path to `from_absolute_path_checked` and checks that the stored path uses normal drive-letter spelling.

**Call relations**: The Windows test runner calls this. It exercises the constructor path through `normalize_path_for_platform` and `normalize_windows_device_path`.

*Call graph*: calls 1 internal fn (from_absolute_path_checked); 1 external calls (assert_eq!).


##### `tests::relative_path_is_resolved_against_base_path`  (lines 478–483)

```
fn relative_path_is_resolved_against_base_path()
```

**Purpose**: Confirms that a simple relative path is placed under the provided base directory.

**Data flow**: The test creates a temporary base directory, resolves `file.txt` against it, and checks that the result equals `base/file.txt`.

**Call relations**: The test runner calls this to verify the common relative-path behavior of `resolve_path_against_base`.

*Call graph*: calls 1 internal fn (resolve_path_against_base); 2 external calls (assert_eq!, tempdir).


##### `tests::relative_path_dots_are_normalized_against_base_path`  (lines 486–492)

```
fn relative_path_dots_are_normalized_against_base_path()
```

**Purpose**: Confirms that `.` and `..` pieces are cleaned up while resolving a relative path.

**Data flow**: The test resolves `./nested/../file.txt` against a temporary base directory and expects the final path to be `base/file.txt`.

**Call relations**: This protects the normalization behavior inside `resolve_path_against_base`.

*Call graph*: calls 1 internal fn (resolve_path_against_base); 2 external calls (assert_eq!, tempdir).


##### `tests::canonicalize_returns_absolute_path_buf`  (lines 495–512)

```
fn canonicalize_returns_absolute_path_buf()
```

**Purpose**: Checks that `AbsolutePathBuf::canonicalize` returns the operating system’s real path for an existing file.

**Data flow**: The test creates directories and a file, builds a path containing `..` and `.`, canonicalizes it, and compares it with independently canonicalized expected path.

**Call relations**: The test runner calls this to verify the wrapper’s `canonicalize` method.

*Call graph*: calls 1 internal fn (from_absolute_path); 4 external calls (assert_eq!, create_dir, write, tempdir).


##### `tests::canonicalize_returns_error_for_missing_path`  (lines 515–521)

```
fn canonicalize_returns_error_for_missing_path()
```

**Purpose**: Checks that `AbsolutePathBuf::canonicalize` reports an error when the target path does not exist.

**Data flow**: The test creates a temporary directory, builds an absolute path to a missing file, calls `canonicalize`, and asserts that it fails.

**Call relations**: This protects the distinction between normal path cleanup and filesystem canonicalization, which requires existing files.

*Call graph*: calls 1 internal fn (from_absolute_path); 2 external calls (assert!, tempdir).


##### `tests::ancestors_returns_absolute_path_bufs`  (lines 524–542)

```
fn ancestors_returns_absolute_path_bufs()
```

**Purpose**: Verifies that walking ancestors of an absolute path returns the expected sequence of absolute paths.

**Data flow**: The test creates an absolute test path, collects its ancestors into ordinary path buffers, and compares them with the expected path, parent, grandparent, and root.

**Call relations**: The test runner calls this to verify `AbsolutePathBuf::ancestors`.

*Call graph*: calls 1 internal fn (from_absolute_path_checked); 3 external calls (assert_eq!, test_path_buf, vec!).


##### `tests::relative_to_current_dir_resolves_relative_path`  (lines 545–553)

```
fn relative_to_current_dir_resolves_relative_path() -> std::io::Result<()>
```

**Purpose**: Checks that `relative_to_current_dir` resolves a relative input using the process current directory.

**Data flow**: The test reads the current directory, resolves `file.txt`, and confirms the result equals `current_dir/file.txt`.

**Call relations**: This directly tests `AbsolutePathBuf::relative_to_current_dir`.

*Call graph*: calls 1 internal fn (relative_to_current_dir); 2 external calls (assert_eq!, current_dir).


##### `tests::guard_used_in_deserialization`  (lines 556–569)

```
fn guard_used_in_deserialization()
```

**Purpose**: Verifies that deserialization uses the guard’s base path for relative paths.

**Data flow**: The test creates a temporary base directory, creates an `AbsolutePathBufGuard`, deserializes a relative JSON string, and checks that the result is under the base directory.

**Call relations**: This tests the cooperation between `AbsolutePathBufGuard::new` and `AbsolutePathBuf::deserialize`.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, format!, tempdir).


##### `tests::home_directory_root_is_expanded_in_deserialization`  (lines 572–582)

```
fn home_directory_root_is_expanded_in_deserialization()
```

**Purpose**: Checks that deserializing `~` produces the current user’s home directory.

**Data flow**: If a home directory is available, the test deserializes the JSON string `~` while a base guard is active and compares the result with the home directory.

**Call relations**: This exercises home-directory expansion through the deserialization path.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, home_dir, tempdir).


##### `tests::home_directory_subpath_is_expanded_in_deserialization`  (lines 585–595)

```
fn home_directory_subpath_is_expanded_in_deserialization()
```

**Purpose**: Checks that deserializing a path like `~/code` expands it under the user’s home directory.

**Data flow**: If a home directory is available, the test deserializes `~/code` with a guard active and compares the result with `home/code`.

**Call relations**: This protects `maybe_expand_home_directory` behavior when used by deserialization.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, home_dir, tempdir).


##### `tests::home_directory_double_slash_is_expanded_in_deserialization`  (lines 598–608)

```
fn home_directory_double_slash_is_expanded_in_deserialization()
```

**Purpose**: Checks that extra slashes after `~` do not produce a strange path.

**Data flow**: If a home directory is available, the test deserializes `~//code` and checks that the result is still `home/code`.

**Call relations**: This tests a forgiving edge case in home-directory expansion.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, home_dir, tempdir).


##### `tests::canonicalize_preserving_symlinks_keeps_logical_symlink_path`  (lines 612–623)

```
fn canonicalize_preserving_symlinks_keeps_logical_symlink_path()
```

**Purpose**: On Unix, verifies that symlink-preserving canonicalization keeps the visible symlink path instead of replacing it with the target path.

**Data flow**: The test creates a real directory and a symbolic link to it, canonicalizes the link with the preserving helper, and checks that the result is the link path.

**Call relations**: This directly exercises `canonicalize_preserving_symlinks` and its symlink-preservation decision.

*Call graph*: calls 1 internal fn (canonicalize_preserving_symlinks); 4 external calls (assert_eq!, create_dir_all, symlink, tempdir).


##### `tests::canonicalize_preserving_symlinks_keeps_logical_missing_child_under_symlink`  (lines 627–639)

```
fn canonicalize_preserving_symlinks_keeps_logical_missing_child_under_symlink()
```

**Purpose**: On Unix, verifies that a missing child path under a symlink still keeps the logical symlink route.

**Data flow**: The test creates a real directory and symlink, appends a missing filename under the symlink, calls the preserving canonicalizer, and expects the same logical missing path back.

**Call relations**: This checks the tolerant behavior of `canonicalize_preserving_symlinks` when full filesystem canonicalization cannot succeed.

*Call graph*: calls 1 internal fn (canonicalize_preserving_symlinks); 4 external calls (assert_eq!, create_dir_all, symlink, tempdir).


##### `tests::canonicalize_existing_preserving_symlinks_errors_for_missing_path`  (lines 642–650)

```
fn canonicalize_existing_preserving_symlinks_errors_for_missing_path()
```

**Purpose**: Confirms that the stricter symlink-preserving canonicalizer fails when the path does not exist.

**Data flow**: The test creates a path to a missing entry, calls `canonicalize_existing_preserving_symlinks`, expects an error, and checks that it is a not-found error.

**Call relations**: This protects the difference between the tolerant and strict canonicalization helpers.

*Call graph*: calls 1 internal fn (canonicalize_existing_preserving_symlinks); 2 external calls (assert_eq!, tempdir).


##### `tests::canonicalize_existing_preserving_symlinks_keeps_logical_symlink_path`  (lines 654–665)

```
fn canonicalize_existing_preserving_symlinks_keeps_logical_symlink_path()
```

**Purpose**: On Unix, verifies that the strict existing-path canonicalizer still preserves a logical symlink path.

**Data flow**: The test creates a real directory and symlink, calls `canonicalize_existing_preserving_symlinks` on the symlink, and checks that the returned path is the symlink path.

**Call relations**: This directly tests the strict helper’s use of `should_preserve_logical_path`.

*Call graph*: calls 1 internal fn (canonicalize_existing_preserving_symlinks); 4 external calls (assert_eq!, create_dir_all, symlink, tempdir).


##### `tests::home_directory_backslash_subpath_is_expanded_in_deserialization`  (lines 669–681)

```
fn home_directory_backslash_subpath_is_expanded_in_deserialization()
```

**Purpose**: On Windows, checks that `~\code` expands to the user’s home directory plus `code`.

**Data flow**: If a home directory is available, the test serializes a Windows-style home-relative string, deserializes it while a guard is active, and compares the result with `home/code`.

**Call relations**: This protects the Windows-specific branch in home-directory expansion.

*Call graph*: calls 1 internal fn (new); 4 external calls (assert_eq!, home_dir, to_string, tempdir).


##### `tests::canonicalize_preserving_symlinks_avoids_verbatim_prefixes`  (lines 685–699)

```
fn canonicalize_preserving_symlinks_avoids_verbatim_prefixes()
```

**Purpose**: On Windows, checks that symlink-preserving canonicalization does not introduce unwanted `\\?\` verbatim prefixes.

**Data flow**: The test canonicalizes a temporary directory, compares it with `dunce` canonicalization, and asserts that the text form does not start with the verbatim prefix.

**Call relations**: This verifies that `canonicalize_preserving_symlinks` remains compatible with the project’s preferred Windows path spelling.

*Call graph*: calls 1 internal fn (canonicalize_preserving_symlinks); 3 external calls (assert!, assert_eq!, tempdir).


### `utils/absolute-path/src/absolutize.rs`

`util` · `cross-cutting path construction and normalization`

This file solves a common path problem: users and code can provide paths in many forms, such as `./file`, `../other`, `/already/full`, or Windows-specific forms like `D:folder`. The project needs one dependable form before it can safely keep, join, or compare paths. Think of it like rewriting driving directions into a single street address: “go one block back, then into this folder” becomes the actual destination.

The main public helpers here are kept inside the crate. `absolutize` uses the computer’s current working directory when the input path is relative. Looking up that current directory can fail, so this function returns an error-aware result. `absolutize_from` does the same job using a base path that is already supplied, so it does not need to ask the operating system anything and can be infallible.

The work happens in two steps. First, `path_with_base` combines the input path with the base path when needed. On Unix-like systems this is simple. On Windows it has to respect drive letters and root-relative paths, which have special meanings. Second, `normalize_path` walks through the path pieces and removes `.` pieces while applying `..` by stepping back one folder. The tests document the expected behavior for Unix and Windows edge cases.

#### Function details

##### `absolutize`  (lines 14–20)

```
fn absolutize(path: &Path) -> std::io::Result<PathBuf>
```

**Purpose**: Turns a path into a clean absolute path using the program’s current working directory when the path is relative. Someone uses this when they have only a path and want the system to decide what it means from “where the program is running now.”

**Data flow**: It receives a path. If the path is already absolute, it sends it straight to the path cleaner and returns the cleaned version. If the path is relative, it first asks the operating system for the current working directory, combines the two through `absolutize_from`, and returns either the finished path or an error if the current directory could not be found.

**Call relations**: This is called by `from_absolute_path` when a higher-level absolute-path type needs to be built from ordinary input. It delegates the actual cleaning to `normalize_path`, and for relative paths it hands the job to `absolutize_from` after getting the current directory.

*Call graph*: calls 2 internal fn (absolutize_from, normalize_path); called by 1 (from_absolute_path); 2 external calls (is_absolute, current_dir).


##### `absolutize_from`  (lines 22–24)

```
fn absolutize_from(path: &Path, base_path: &Path) -> PathBuf
```

**Purpose**: Turns a path into a clean absolute path using a base path supplied by the caller. This is useful when the caller already knows the starting folder and wants path resolution to be predictable and not depend on the process’s current directory.

**Data flow**: It receives an input path and a base path. It first combines them with `path_with_base`, using the base only when the input needs it, then passes the combined path to `normalize_path`. It returns the resulting cleaned `PathBuf` directly.

**Call relations**: This is the central helper for callers that already have a base path, such as `from_absolute_path_checked` and `resolve_path_against_base`. `absolutize` also calls it after fetching the current working directory, so both entry routes share the same combining and cleanup behavior.

*Call graph*: calls 2 internal fn (normalize_path, path_with_base); called by 3 (from_absolute_path_checked, resolve_path_against_base, absolutize).


##### `normalize_path`  (lines 26–45)

```
fn normalize_path(path: &Path) -> PathBuf
```

**Purpose**: Cleans a path by removing current-folder markers and applying parent-folder markers. It does not check whether files or folders exist; it only simplifies the written path.

**Data flow**: It receives a path and reads it piece by piece. Plain folder names, drive prefixes, and root markers are copied into a new path. `.` pieces are ignored, and `..` pieces remove the previous piece from the new path when possible. If everything disappears, it returns `.` to represent the current folder.

**Call relations**: Both `absolutize` and `absolutize_from` call this after deciding what full path text should be cleaned. It is the final polishing step before a normalized path is returned to higher-level path-building code.

*Call graph*: called by 2 (absolutize, absolutize_from); 3 external calls (components, from, new).


##### `path_with_base`  (lines 57–84)

```
fn path_with_base(path: &Path, base_path: &Path) -> PathBuf
```

**Purpose**: Combines an input path with a base path only when that is needed. Its job is especially important on Windows, where paths can have drive letters, roots, or both, and those forms do not all mean the same thing.

**Data flow**: It receives an input path and a base path. On non-Windows systems, it returns the input unchanged if it is already absolute, otherwise it joins it onto the base. On Windows, it also considers root-only paths and drive-relative paths, preserving the right drive or root meaning while borrowing the needed parts from the base. It returns the combined path before cleanup.

**Call relations**: `absolutize_from` calls this first, before normalization. This function does not finish the job by itself; it prepares the path shape, then `absolutize_from` passes the result to `normalize_path` so dots and parent-folder steps are resolved.

*Call graph*: called by 1 (absolutize_from); 9 external calls (components, has_root, is_absolute, join, push, to_path_buf, new, matches!, from).


##### `tests::absolute_path_without_dots_is_unchanged`  (lines 93–98)

```
fn absolute_path_without_dots_is_unchanged()
```

**Purpose**: Checks that a Unix absolute path with no `.` or `..` pieces stays the same. This protects the simple case from being accidentally changed.

**Data flow**: The test gives `absolutize_from` an already absolute path and an unrelated base path. It expects the output to match the original absolute path exactly.

**Call relations**: This test exercises the normal `absolutize_from` path and verifies the result with `assert_eq!`. It is only compiled on Unix systems.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::absolute_path_dots_are_removed`  (lines 102–107)

```
fn absolute_path_dots_are_removed()
```

**Purpose**: Checks that a Unix absolute path containing `.` and `..` is simplified correctly. It proves that cleanup happens even when no base path is needed.

**Data flow**: The test passes an absolute path containing a current-folder marker and a parent-folder marker. The expected result removes the current-folder marker and backs up over the previous folder before continuing.

**Call relations**: This test calls `absolutize_from`, which uses `path_with_base` and `normalize_path`, then compares the final path with `assert_eq!`. It is Unix-only.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::relative_path_without_dot_uses_base`  (lines 111–116)

```
fn relative_path_without_dot_uses_base()
```

**Purpose**: Checks that a plain Unix relative path is placed under the supplied base folder. This confirms that relative paths are not treated as complete paths by mistake.

**Data flow**: The test provides `path/to/123/456` and the base `/base`. It expects the result `/base/path/to/123/456`.

**Call relations**: This test exercises the base-joining behavior inside `absolutize_from` and confirms the output with `assert_eq!`. It is only built for Unix.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::relative_path_with_current_dir_uses_base`  (lines 120–125)

```
fn relative_path_with_current_dir_uses_base()
```

**Purpose**: Checks that a Unix relative path starting with `./` still uses the supplied base folder. The leading `./` means “from here,” so it should disappear after normalization.

**Data flow**: The test provides `./path/to/123/456` and the base `/base`. The path is joined to the base, then the `.` piece is removed, producing `/base/path/to/123/456`.

**Call relations**: This test confirms that `absolutize_from` combines first and normalizes second. It uses `assert_eq!` to lock in that behavior on Unix.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::relative_path_with_parent_dir_uses_base_parent`  (lines 129–134)

```
fn relative_path_with_parent_dir_uses_base_parent()
```

**Purpose**: Checks that a Unix relative path beginning with `..` moves up from the supplied base folder. This makes sure parent-folder navigation is applied after the path is joined to the base.

**Data flow**: The test starts with base `/base/cwd` and relative path `../path/to/123/456`. Joining gives a path that includes `cwd/..`, and normalization removes that pair, leaving `/base/path/to/123/456`.

**Call relations**: This test covers the interaction between `path_with_base` and `normalize_path` through `absolutize_from`. It verifies the result with `assert_eq!` and is Unix-only.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::parent_dir_above_root_stays_at_root`  (lines 138–143)

```
fn parent_dir_above_root_stays_at_root()
```

**Purpose**: Checks that going above the Unix root folder does not create an invalid path. Extra `..` pieces at the top effectively leave the path at root.

**Data flow**: The test uses base `/` and a relative path that starts by going up twice. Normalization cannot go above `/`, so the remaining folder pieces produce `/path/to/123/456`.

**Call relations**: This test protects an edge case in `normalize_path` as reached through `absolutize_from`. It compares the expected and actual paths with `assert_eq!` on Unix.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::empty_path_uses_base`  (lines 147–152)

```
fn empty_path_uses_base()
```

**Purpose**: Checks that an empty Unix path means “the base folder itself.” This avoids turning an empty input into something surprising.

**Data flow**: The test gives an empty path and the base `/base/cwd`. Combining and normalizing leave the base path unchanged, so that is the expected output.

**Call relations**: This test calls `absolutize_from` and verifies the base-preserving behavior with `assert_eq!`. It is compiled only on Unix.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::windows_root_relative_path_uses_base_prefix`  (lines 156–161)

```
fn windows_root_relative_path_uses_base_prefix()
```

**Purpose**: Checks a Windows path that starts at the root of the current drive, such as `\path\to\file`. It should keep the drive from the base path while replacing the folder part.

**Data flow**: The test uses input `\path\to\file` and base `C:\base\cwd`. The result should be `C:\path\to\file`, meaning the input is rooted on drive `C:` rather than treated as a completely separate drive.

**Call relations**: This test targets the Windows-specific version of `path_with_base` through `absolutize_from`. It uses `assert_eq!` and is compiled only on Windows.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::windows_drive_relative_path_uses_path_prefix_and_base_tail`  (lines 165–170)

```
fn windows_drive_relative_path_uses_path_prefix_and_base_tail()
```

**Purpose**: Checks a Windows drive-relative path like `D:path\to\file`. This form names a drive but is still relative, so the code must combine the drive from the input with the folder tail from the base.

**Data flow**: The test provides `D:path\to\file` with base `C:\base\cwd`. The expected result is `D:\base\cwd\path\to\file`, showing that the drive changes to `D:` while the base folder structure is still used.

**Call relations**: This test covers the most Windows-specific branch of `path_with_base` as used by `absolutize_from`. It confirms the final normalized path with `assert_eq!` and only runs on Windows.

*Call graph*: 1 external calls (assert_eq!).


### `app-server-client/src/path.rs`

`util` · `cross-cutting`

This file solves a subtle but important problem: the client may need to talk about files on an app server that uses different path rules from the client’s own operating system. For example, a client on Linux might receive a Windows path like `C:\Users\me\file.txt`. If the code used the local machine’s normal path tools, it could split or join that path incorrectly.

`AppServerPath` is a simple wrapper around a string. The wrapper is useful because it marks the string as “a path understood by the app server.” The file then provides a few safe, predictable operations on that path: create one from server-provided text, accept only absolute paths when needed, read it back as plain text, split it into parts, join another segment onto it, and print it.

The main bit of intelligence is recognizing Windows absolute paths. The helper checks for drive-letter paths like `C:\...` or `C:/...`, and network paths that begin with `\\` or `//`. Once the file knows whether a path is Windows-like, it chooses the right separators. Think of it like using the road signs from the city where the road actually exists, rather than the city where you are reading the map.

#### Function details

##### `AppServerPath::from_app_server`  (lines 9–11)

```
fn from_app_server(path: impl Into<String>) -> Self
```

**Purpose**: Creates an `AppServerPath` from path text that is already trusted as coming from, or being meant for, the app server. It does not validate the path; it simply labels the string with the app-server path type.

**Data flow**: It takes any value that can be turned into a string, converts it into a string, and stores that string inside a new `AppServerPath`. The output is the wrapped path value, with no other changes.

**Call relations**: Other code uses this when it already has a server-side path, such as when finding the Codex home path or in a test that checks long objective text being materialized before paste. This function is the simple doorway for turning plain path text into the project’s app-server path type.

*Call graph*: called by 2 (codex_home, set_thread_goal_draft_materializes_long_objective_and_confirms_before_paste); 1 external calls (into).


##### `AppServerPath::from_absolute_str`  (lines 13–15)

```
fn from_absolute_str(raw: &str) -> Option<Self>
```

**Purpose**: Creates an `AppServerPath` only if the given text looks like an absolute path. An absolute path is one that starts from a root location, such as `/home/me` on Unix or `C:\Users\me` on Windows.

**Data flow**: It receives raw text, checks whether it starts with `/` or matches the file’s Windows absolute-path rules, and then either wraps it in `AppServerPath` or returns nothing. The result is `Some(path)` for accepted absolute paths and `None` for relative paths.

**Call relations**: Code that builds an objective file path calls this when it needs to reject ambiguous relative paths. It relies on `is_windows_absolute_path` so that Windows paths are accepted even if the client is not running on Windows.

*Call graph*: calls 1 internal fn (is_windows_absolute_path); called by 1 (objective_file_path).


##### `AppServerPath::as_str`  (lines 17–19)

```
fn as_str(&self) -> &str
```

**Purpose**: Returns the stored path as plain text. This is useful when another part of the program needs to send, compare, or display the exact path string.

**Data flow**: It reads the string inside the `AppServerPath` and returns a borrowed view of it. It does not copy or change the path.

**Call relations**: The filesystem request code calls this when it needs the path text to include in a request. This keeps the path wrapped for most of the program, while still allowing transport code to access the raw string when needed.

*Call graph*: called by 1 (request_fs_path).


##### `AppServerPath::components`  (lines 21–31)

```
fn components(&self) -> Vec<&str>
```

**Purpose**: Splits the app-server path into its meaningful pieces, ignoring empty pieces caused by leading or repeated separators. For example, it can break a path into folder and file names.

**Data flow**: It looks at the stored path, decides whether it should treat both `/` and `\` as separators for Windows-style paths or only `/` for other paths, splits the text, removes empty parts, and returns the remaining pieces as a list of string slices.

**Call relations**: This function calls `is_windows_absolute_path` before splitting so it can use the separator rules of the app server path itself. It is part of the path utility layer that lets higher-level code inspect paths without guessing which operating system style they use.

*Call graph*: calls 1 internal fn (is_windows_absolute_path).


##### `AppServerPath::join`  (lines 33–41)

```
fn join(&self, segment: impl AsRef<str>) -> Self
```

**Purpose**: Adds one new path segment to the end of an existing app-server path, using the right separator for that path style. It avoids accidentally mixing Unix and Windows separators.

**Data flow**: It takes the current path and a segment to append. It first decides whether the current path is Windows-style, trims any trailing separators from the current path, chooses `\` for Windows-style paths or `/` otherwise, and builds a new combined `AppServerPath`.

**Call relations**: This function also depends on `is_windows_absolute_path` to choose the separator. Higher-level code can use it to extend server-side paths without needing to know whether the app server path is Unix-like or Windows-like.

*Call graph*: calls 1 internal fn (is_windows_absolute_path); 1 external calls (format!).


##### `AppServerPath::fmt`  (lines 45–47)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Defines how an `AppServerPath` is shown when formatted or printed. It prints the underlying path text exactly as stored.

**Data flow**: It receives a formatter from Rust’s display system, sends the inner string into that formatter, and returns whether formatting succeeded. It does not change the path.

**Call relations**: This is used automatically when code formats an `AppServerPath` for logs, messages, or user-visible text. It hands off to the inner string’s normal formatting behavior so the wrapper remains transparent when printed.


##### `is_windows_absolute_path`  (lines 50–58)

```
fn is_windows_absolute_path(path: &str) -> bool
```

**Purpose**: Recognizes whether a path string looks like an absolute Windows path. It covers drive-letter paths such as `C:\folder` and network paths that start with `\\` or `//`.

**Data flow**: It reads the path as bytes, checks for a letter followed by `:` and then `/` or `\`, and also checks for network-style prefixes. It returns `true` when the string matches one of those Windows absolute forms, and `false` otherwise.

**Call relations**: This helper is called by absolute-path validation, path splitting, and path joining. It is the shared rulebook that lets the rest of the file treat Windows paths correctly even when the client itself may be running on a different operating system.

*Call graph*: called by 3 (components, from_absolute_str, join); 1 external calls (matches!).


### Filesystem path operations
These helpers build on the core path types to normalize, inspect, and safely operate on filesystem paths in local application code.

### `utils/path-utils/src/lib.rs`

`util` · `cross-cutting`

File paths can be surprisingly tricky. The same real file may be written with different spelling, different letter case, or through a symbolic link, which is a filesystem shortcut. This file gives the rest of the project one place to answer questions like “Are these two paths really the same?” and “Where should I write so I do not corrupt a symlink target?”

The first group of helpers normalizes paths before comparing them. Normalizing means turning a path into a cleaner, more standard form. On WSL, the Windows Subsystem for Linux, Windows drives are usually mounted under paths like `/mnt/c/...`, and those paths are case-insensitive. So this file lowercases those paths before comparison, because `/mnt/c/Users` and `/mnt/c/users` may point to the same place.

Another helper simplifies native Windows working-directory paths, removing odd-looking path forms that Windows accepts but humans and tools may compare poorly.

The symlink helper follows a chain of symlinks until it reaches the real target, while watching for loops. If something looks unsafe or unreadable, it falls back to writing to the original path instead of guessing.

Finally, `write_atomically` writes content through a temporary file and then moves it into place. Like writing a note on scratch paper before replacing the old note, this avoids leaving a broken file if the write is interrupted.

#### Function details

##### `normalize_for_path_comparison`  (lines 13–16)

```
fn normalize_for_path_comparison(path: impl AsRef<Path>) -> std::io::Result<PathBuf>
```

**Purpose**: This function turns a path into a standard form that is safer to compare with another path. It resolves the path through the operating system, then applies Codex’s WSL-specific cleanup.

**Data flow**: It receives any path-like value. It asks the filesystem for the path’s canonical form, meaning the system’s resolved version of the path, then passes that result through WSL normalization. It returns the cleaned-up path, or an error if the filesystem cannot canonicalize it.

**Call relations**: This is the main cleanup step used by `paths_match_after_normalization`. It delegates the WSL-specific part to `normalize_for_wsl`, so callers do not need to know whether the program is running inside WSL.

*Call graph*: calls 1 internal fn (normalize_for_wsl); called by 1 (paths_match_after_normalization); 1 external calls (as_ref).


##### `paths_match_after_normalization`  (lines 21–29)

```
fn paths_match_after_normalization(left: impl AsRef<Path>, right: impl AsRef<Path>) -> bool
```

**Purpose**: This function answers the practical question, “Do these two paths point to the same place after Codex’s normal cleanup rules?” It is useful when direct string comparison would be too brittle.

**Data flow**: It receives two paths. It tries to normalize both with `normalize_for_path_comparison`; if both succeed, it compares the normalized results. If either path cannot be normalized, it falls back to comparing the original paths exactly as given.

**Call relations**: This is the public comparison helper built on top of `normalize_for_path_comparison`. It is designed for callers that want a yes-or-no answer without having to deal with filesystem errors unless comparison truly cannot be improved.

*Call graph*: calls 1 internal fn (normalize_for_path_comparison); 1 external calls (as_ref).


##### `normalize_for_native_workdir`  (lines 31–33)

```
fn normalize_for_native_workdir(path: impl AsRef<Path>) -> PathBuf
```

**Purpose**: This function prepares a working-directory path for the current operating system. On Windows, it simplifies the path into a more normal-looking form; on other systems, it leaves it alone.

**Data flow**: It receives a path-like value and turns it into a `PathBuf`, which is Rust’s owned path type. It checks at compile time whether this build targets Windows, then passes the path and that yes-or-no flag to `normalize_for_native_workdir_with_flag`. It returns the possibly simplified path.

**Call relations**: This is the convenient public wrapper. The real decision is made by `normalize_for_native_workdir_with_flag`, which is split out so the behavior can be tested with an explicit Windows/non-Windows flag.

*Call graph*: calls 1 internal fn (normalize_for_native_workdir_with_flag); 2 external calls (as_ref, cfg!).


##### `resolve_symlink_write_paths`  (lines 46–119)

```
fn resolve_symlink_write_paths(path: &Path) -> io::Result<SymlinkWritePaths>
```

**Purpose**: This function follows symbolic links to find the real place a path points to, while still choosing a safe path to write to. It protects the program from symlink loops and from making unsafe guesses when the filesystem cannot be inspected.

**Data flow**: It starts with an input path and tries to treat it as an absolute path. It then repeatedly checks whether the current path is a symlink. If it is, it reads the symlink target, resolves relative targets against the symlink’s parent folder, and continues. It records every path it has seen so it can detect a loop. The result contains a `read_path`, which is the resolved target when known, and a `write_path`, which is the path that should be written. If resolution fails or loops, `read_path` is `None` and `write_path` falls back to the original root path.

**Call relations**: This function stands on its own as the safety gate for symlink-aware file access. It uses absolute-path helpers to avoid ambiguous path handling, filesystem metadata calls to inspect each step, and link-reading calls to follow each symlink target.

*Call graph*: calls 2 internal fn (from_absolute_path, resolve_path_against_base); 4 external calls (new, into_path_buf, read_link, symlink_metadata).


##### `write_atomically`  (lines 121–133)

```
fn write_atomically(write_path: &Path, contents: &str) -> io::Result<()>
```

**Purpose**: This function writes text to a file in a safer way than directly overwriting it. It helps prevent half-written files if the process crashes or is interrupted during the write.

**Data flow**: It receives a destination path and the text to write. It finds the destination’s parent directory, creates that directory if needed, creates a temporary file in the same directory, writes the text into the temporary file, and then persists that temporary file at the final path. It returns success or an input/output error.

**Call relations**: This is the file’s durable-write helper. Callers use it when they want the final file to appear all at once instead of being gradually overwritten in place.

*Call graph*: 4 external calls (new_in, parent, create_dir_all, write).


##### `normalize_for_wsl`  (lines 135–137)

```
fn normalize_for_wsl(path: PathBuf) -> PathBuf
```

**Purpose**: This function applies WSL-specific path cleanup when the program is running inside WSL. WSL is the Windows Subsystem for Linux, where Linux tools can access Windows drives through paths like `/mnt/c/...`.

**Data flow**: It receives a path. It asks `env::is_wsl` whether the program is running under WSL, then passes the path and that answer to `normalize_for_wsl_with_flag`. It returns either the original path or a lowercased version when WSL rules require it.

**Call relations**: This is called by `normalize_for_path_comparison` after the path has already been canonicalized. It separates environment detection from the actual normalization rule.

*Call graph*: calls 2 internal fn (is_wsl, normalize_for_wsl_with_flag); called by 1 (normalize_for_path_comparison).


##### `normalize_for_native_workdir_with_flag`  (lines 139–145)

```
fn normalize_for_native_workdir_with_flag(path: PathBuf, is_windows: bool) -> PathBuf
```

**Purpose**: This function performs the actual native working-directory cleanup using an explicit “is Windows” flag. It exists so the Windows-specific behavior can be controlled directly, especially in tests.

**Data flow**: It receives a path and a boolean flag saying whether to treat the environment as Windows. If the flag is true, it uses `dunce::simplified` to turn the path into a simpler Windows-friendly form. If the flag is false, it returns the path unchanged.

**Call relations**: This is called by `normalize_for_native_workdir`, which supplies the real compile-time Windows flag. It keeps the platform-specific rule small and easy to reason about.

*Call graph*: called by 1 (normalize_for_native_workdir); 1 external calls (simplified).


##### `normalize_for_wsl_with_flag`  (lines 147–157)

```
fn normalize_for_wsl_with_flag(path: PathBuf, is_wsl: bool) -> PathBuf
```

**Purpose**: This function decides whether a path should be lowercased under WSL. It only changes paths that are on WSL’s Windows-drive mounts, because those are the paths where letter case should not matter.

**Data flow**: It receives a path and a boolean saying whether WSL behavior should apply. If WSL behavior is off, it returns the path unchanged. If WSL behavior is on, it checks whether the path looks like a case-insensitive WSL Windows-drive path. If so, it lowercases the path’s ASCII bytes; otherwise it leaves it alone.

**Call relations**: This function is called by `normalize_for_wsl`. It uses `is_wsl_case_insensitive_path` to recognize paths that need special treatment and `lower_ascii_path` to perform the actual lowercasing.

*Call graph*: calls 2 internal fn (is_wsl_case_insensitive_path, lower_ascii_path); called by 1 (normalize_for_wsl).


##### `is_wsl_case_insensitive_path`  (lines 159–186)

```
fn is_wsl_case_insensitive_path(path: &Path) -> bool
```

**Purpose**: This function recognizes WSL paths that point into mounted Windows drives, such as `/mnt/c/...`. Those paths are treated as case-insensitive, so they may need lowercasing before comparison.

**Data flow**: It receives a path and, on Linux builds, breaks it into path components. It checks for the shape `/mnt/<drive-letter>/...`, allowing `mnt` to be written in different ASCII letter cases. It returns true only when that shape is found. On non-Linux builds, it always returns false.

**Call relations**: This function is used by `normalize_for_wsl_with_flag` as the decision point before lowercasing. On Linux it relies on `ascii_eq_ignore_case` to compare the `mnt` folder name without caring about letter case.

*Call graph*: calls 1 internal fn (ascii_eq_ignore_case); called by 1 (normalize_for_wsl_with_flag); 1 external calls (components).


##### `ascii_eq_ignore_case`  (lines 189–195)

```
fn ascii_eq_ignore_case(left: &[u8], right: &[u8]) -> bool
```

**Purpose**: This small helper compares two byte strings as ASCII text while ignoring letter case. It is used for simple filesystem path checks where only basic English letters matter.

**Data flow**: It receives two byte slices. It first checks that they have the same length, then compares each pair of bytes after lowercasing the left byte as ASCII. It returns true if every byte pair matches under that rule.

**Call relations**: This helper is called by `is_wsl_case_insensitive_path` when checking whether a path component spells `mnt`. It is only compiled on Linux, where the WSL path-shape check is meaningful.

*Call graph*: called by 1 (is_wsl_case_insensitive_path).


##### `lower_ascii_path`  (lines 213–215)

```
fn lower_ascii_path(path: PathBuf) -> PathBuf
```

**Purpose**: This function lowercases the ASCII bytes of a path. It is used to make WSL Windows-drive paths compare consistently even when users or tools spell folder names with different letter case.

**Data flow**: It receives a path. On Linux, it reads the path as raw bytes, lowercases each byte using ASCII rules, builds a new operating-system string from those bytes, and returns it as a new path. On non-Linux builds, it returns the path unchanged.

**Call relations**: This function is called by `normalize_for_wsl_with_flag` after that function has confirmed the path is a WSL case-insensitive Windows-drive path. It performs the final transformation in the WSL normalization chain.

*Call graph*: called by 1 (normalize_for_wsl_with_flag); 4 external calls (from_vec, as_os_str, from, with_capacity).


### `utils/path-utils/src/env.rs`

`util` · `cross-cutting`

This file provides a small environment check used by path-related code. Windows Subsystem for Linux, often called WSL, lets Linux programs run on Windows. That is useful, but it creates a mixed world: Linux-style paths may need to work with Windows files, and some path decisions depend on knowing that the program is in WSL rather than a regular Linux machine.

The file exposes one function, `is_wsl`, which returns a simple yes-or-no answer. On Linux, it first looks for the `WSL_DISTRO_NAME` environment variable. An environment variable is a small named setting given to a running process by the operating system or shell. If that variable exists, the function treats the process as running under WSL. If not, it reads `/proc/version`, a Linux system file that describes the running kernel, and checks whether it mentions Microsoft. Older or differently configured WSL environments can be detected this way.

On non-Linux systems, the function always returns false, because WSL is specifically a Linux environment running on Windows. Without this shared helper, different crates could each guess differently, leading to inconsistent path handling.

#### Function details

##### `is_wsl`  (lines 4–19)

```
fn is_wsl() -> bool
```

**Purpose**: Checks whether the current process is running inside Windows Subsystem for Linux. Code that adjusts paths for WSL uses this to decide whether special conversion rules are needed.

**Data flow**: It takes no direct input. On Linux, it reads the process environment to look for `WSL_DISTRO_NAME`; if that is present, it returns `true`. If not, it reads the system file `/proc/version`, looks for the word `microsoft` in its contents, and returns `true` if found. If the file cannot be read, or if the code is running on a non-Linux operating system, it returns `false`.

**Call relations**: When path-normalizing code needs to know whether WSL-specific behavior applies, `normalize_for_wsl` calls this function first. `is_wsl` then asks the operating system for clues using environment lookup and a system-file read, and hands back a plain true-or-false answer so the caller can choose the right path behavior.

*Call graph*: called by 1 (normalize_for_wsl); 2 external calls (var_os, read_to_string).


### `core/src/utils/path_utils.rs`

`util` · `cross-cutting`

This file is intentionally tiny. Its job is not to define new behavior, but to re-export everything from `codex_utils_path`, which is a separate package of path utilities. A path utility is code that helps work with file and folder names safely and consistently.

The reason this matters is convenience and stability. Other code in `core` can import path helpers through `core::utils::path_utils` instead of needing to know exactly where those helpers are implemented. That is a bit like a building directory: people go to the same directory entry even if the office behind it moves later.

Without this file, callers would have to import `codex_utils_path` directly, which spreads knowledge of that lower-level dependency throughout the codebase. By keeping this small re-export layer, the project can keep its internal import paths tidy and preserve a clear place for path-related helpers under `core/src/utils`.


### `ext/memories/src/local/path.rs`

`util` · `request handling`

This file is a toolbox for working with files and folders on disk. The memories backend stores or reads information locally, so it needs careful rules for paths: folders should be listed in a stable order, hidden files should be easy to skip, symbolic links should be rejected, and displayed paths should be readable without exposing unnecessary full system paths.

The most safety-focused helper is the symlink check. A symbolic link is a file-system shortcut that points somewhere else. If accepted blindly, it could let a request escape the intended storage area, like a side door out of a locked room. This file helps prevent that by turning symlinks into a clear backend error.

The directory-reading helper uses asynchronous disk access, meaning it can wait for the operating system without blocking the whole program. If the directory does not exist, it treats that as an empty folder rather than a failure, which makes listing and searching more forgiving.

The hidden-file helpers look for names starting with a dot, such as `.git` or `.env`. The display helper converts a full path into a relative, slash-separated path, so callers can show compact names like `notes/today.md` instead of a machine-specific absolute path.

#### Function details

##### `read_sorted_dir_paths`  (lines 7–21)

```
async fn read_sorted_dir_paths(
    dir_path: &Path,
) -> Result<Vec<PathBuf>, MemoriesBackendError>
```

**Purpose**: Reads the contents of a directory and returns the entry paths in sorted order. It is useful when listing or searching because stable ordering makes results predictable instead of depending on the file system’s natural order.

**Data flow**: It receives a directory path. It asks the operating system, through Tokio’s asynchronous file API, for the directory entries. If the folder is missing, it returns an empty list. Otherwise it collects each entry path, sorts the list, and returns it; if another disk error happens, it turns that error into the backend’s own error type.

**Call relations**: The listing and search code call this when they need to walk through a folder. This helper does the low-level directory reading and gives those higher-level flows a clean, sorted list they can filter or inspect further.

*Call graph*: called by 2 (list, search_entries); 2 external calls (new, read_dir).


##### `reject_symlink`  (lines 23–34)

```
fn reject_symlink(
    path: &str,
    metadata: &std::fs::Metadata,
) -> Result<(), MemoriesBackendError>
```

**Purpose**: Checks whether a path points to a symbolic link and rejects it if so. This protects the local backend from accidentally following shortcuts to places outside the intended storage area.

**Data flow**: It receives the original path text and already-read file metadata. It looks at the metadata’s file type. If the file is a symlink, it creates an “invalid path” backend error explaining that symlinks are not allowed; otherwise it returns success and changes nothing.

**Call relations**: Path resolving, directory creation checks, listing, reading, and searching all call this before trusting a file-system target. It acts like a shared safety gate that those operations pass through before continuing.

*Call graph*: calls 1 internal fn (invalid_path); called by 5 (resolve_scoped_path, ensure_directory, list, read, search); 1 external calls (file_type).


##### `is_hidden_component`  (lines 36–41)

```
fn is_hidden_component(component: Component<'_>) -> bool
```

**Purpose**: Checks whether one part of a path is hidden by Unix-style naming rules. In plain terms, it answers: “Does this single folder or file name start with a dot?”

**Data flow**: It receives one path component, such as a folder name or file name. If that component is a normal name and its text begins with `.`, it returns true; otherwise it returns false. It does not read the disk or change anything.

**Call relations**: In the provided call graph, no other function is shown calling this helper directly. It is a standalone path-checking utility that can be used when code needs to examine a path piece by piece rather than only checking the final file name.

*Call graph*: 1 external calls (matches!).


##### `is_hidden_path`  (lines 43–46)

```
fn is_hidden_path(path: &Path) -> bool
```

**Purpose**: Checks whether the final name in a path is hidden. This is used to skip entries like `.DS_Store` or `.private` during listing and searching.

**Data flow**: It receives a full path. It extracts only the last file or folder name, converts it to text in a forgiving way, and checks whether it starts with a dot. It returns true for hidden names and false otherwise.

**Call relations**: The listing flow and the recursive search helper call this when deciding which directory entries should be visible. It gives those flows a simple yes-or-no answer before they decide whether to include or ignore a path.

*Call graph*: called by 2 (list, search_entries); 1 external calls (file_name).


##### `display_relative_path`  (lines 48–56)

```
fn display_relative_path(root: &Path, path: &Path) -> String
```

**Purpose**: Turns a full path into a clean path relative to a chosen root. This makes paths suitable for display or API results, avoiding noisy absolute machine paths.

**Data flow**: It receives a root path and another path. It tries to remove the root prefix from the path; if that is not possible, it keeps the original path. Then it converts each remaining path part to text, drops empty parts, joins the pieces with `/`, and returns the resulting string.

**Call relations**: Path resolving, listing, search result building, and search call this when they need a readable path to show or return. It sits at the boundary between internal file-system paths and user-facing path strings.

*Call graph*: called by 4 (resolve_scoped_path, list, build_search_match, search); 1 external calls (strip_prefix).


### `memories/read/src/lib.rs`

`util` · `cross-cutting read access`

Codex has a “memories” area: a folder where saved information can be read back and inserted into later work. This file belongs to the read side of that system. It does not write or update memories; it only helps other code find and use existing memory data.

The file makes three submodules available. The `citations` module is public, so other parts of the project can parse or work with references to memories. The `usage` module is also public, so callers can use read-path behavior around memory use. The `metrics` module is private, which means it supports this crate internally, likely for classifying or recording read access without becoming part of the public interface.

The one function here, `memory_root`, answers a simple but important question: “Given the Codex home directory, where is the memories directory?” It appends `memories` to the provided home path. This keeps the folder location consistent everywhere. Without this small helper, different parts of the program might build the path by hand and accidentally disagree, like people filing documents in slightly different drawers.

#### Function details

##### `memory_root`  (lines 13–15)

```
fn memory_root(codex_home: &AbsolutePathBuf) -> AbsolutePathBuf
```

**Purpose**: Returns the standard path to the memories folder inside a Codex home directory. Other code uses it so everyone looks for memories in the same place.

**Data flow**: It takes an absolute Codex home path as input. It adds the folder name `memories` to that path using the path-joining operation. It returns the resulting absolute path, leaving the input path unchanged.

**Call relations**: When read-side memory code needs to locate the memory folder, this helper provides the shared answer. Internally it hands the actual path construction to `join`, which safely appends the `memories` folder name to the Codex home path.

*Call graph*: calls 1 internal fn (join).


### `git-utils/src/platform.rs`

`util` · `cross-cutting filesystem work`

A symbolic link is a small filesystem pointer, like a shortcut, that makes one path point to another file or directory. Creating one is not quite the same on every operating system. Unix-like systems use one general symlink call. Windows has separate calls for links to files and links to directories, so the code must first figure out what kind of thing the original path is.

This file is the project’s adapter for that difference. On Unix, `create_symlink` simply creates a link from the requested destination to the requested target. The `source` path is not needed there, because Unix does not require the caller to say whether the target is a file or a directory.

On Windows, the function looks at the `source` path’s filesystem metadata, which is information such as “is this a directory link?” It then chooses the correct Windows function: one for directory links, one for file links. If metadata lookup or symlink creation fails, the error is returned as the project’s `GitToolingError`.

Without this file, code that needs to recreate or copy Git-related symlinks would either fail on one platform or be cluttered with platform-specific branches everywhere.

#### Function details

##### `create_symlink`  (lines 18–34)

```
fn create_symlink(
    source: &Path,
    link_target: &Path,
    destination: &Path,
) -> Result<(), GitToolingError>
```

**Purpose**: Creates a symbolic link in a way that works correctly on the current operating system. Callers use it when they want `destination` to become a link pointing at `link_target`, without having to care whether the program is running on Unix or Windows.

**Data flow**: The function receives three paths: `source`, which is used on Windows to learn what kind of link is being copied or recreated; `link_target`, which is the path the new link should point to; and `destination`, where the new link should be placed. On Unix it directly asks the operating system to create the link. On Windows it first reads metadata from `source`, then creates either a directory symlink or a file symlink as appropriate. It returns success with no value, or returns a `GitToolingError` if reading metadata or creating the link fails.

**Call relations**: Other Git utility code calls this helper whenever it needs to make a symlink. Inside the Windows version, it calls the filesystem metadata lookup (`symlink_metadata`) so it can choose the right Windows symlink operation before handing the request to the operating system.

*Call graph*: 1 external calls (symlink_metadata).


### `state/src/paths.rs`

`util` · `cross-cutting`

This file solves a common bookkeeping problem: the system sometimes needs to know whether a file on disk is fresh, stale, or changed since the last time it was seen. To do that safely in an asynchronous program, it asks the operating system for the file's metadata without blocking the rest of the program. Metadata is basic information about a file, such as its size, permissions, and last modified time.

The helper in this file takes a file path, looks up the file's metadata, extracts the last modified time, and converts that time into UTC. UTC is a standard world time, which avoids confusion from local time zones or daylight saving changes.

If anything goes wrong, such as the file not existing or the operating system not providing a modified time, the function returns nothing instead of crashing. In Rust terms, it returns `None`, meaning “there is no usable timestamp.” This makes it a quiet, safe helper: callers can ask for the timestamp and then decide what to do if it is unavailable.

#### Function details

##### `file_modified_time_utc`  (lines 5–9)

```
async fn file_modified_time_utc(path: &Path) -> Option<DateTime<Utc>>
```

**Purpose**: This function looks up the last modified time of a file and returns it as a UTC timestamp. It is useful when the rest of the system needs a reliable way to compare file ages or detect changes.

**Data flow**: It receives a file path. It asks the operating system for that file's metadata, then reads the modified-time field from that metadata. If both steps work, it converts the time into UTC and returns it. If the file cannot be inspected or the modified time cannot be read, it returns no value.

**Call relations**: When another part of the system needs to know when a file was last changed, it calls this helper with the file's path. The helper delegates the disk lookup to Tokio's asynchronous `metadata` call, which lets other tasks keep running while the filesystem is being checked, then hands the caller either a UTC timestamp or `None` if the timestamp could not be found.

*Call graph*: 1 external calls (metadata).


### `exec-server/src/regular_file.rs`

`io_transport` · `request handling`

This file is a small safety gate around file opening. In many operating systems, a “path” can point to more than a regular file: it might be a directory, a pipe, a device, or another special object. Those special objects can behave in surprising ways, such as blocking forever or exposing system resources. This code makes sure the exec server only accepts plain files from disk.

The main function, `open`, builds file-opening options for read-only access, applies operating-system-specific safety settings, and then opens the path using Tokio, an asynchronous runtime that lets the server wait on file operations without blocking other work. After opening, it checks two things: whether the opened object is a disk file on platforms where that distinction matters, and whether its metadata says it is a normal file rather than a directory or something else. If either check fails, it returns a clear “invalid input” error.

The platform-specific helpers are like different safety instructions for different kinds of doors. On Unix, the file is opened with a non-blocking flag. On Windows, it sets a security quality-of-service flag and also asks Windows whether the handle belongs to a real disk file. On other platforms, no extra setup is needed.

#### Function details

##### `open`  (lines 4–17)

```
async fn open(path: &Path) -> io::Result<tokio::fs::File>
```

**Purpose**: Opens a path for reading only after setting safe platform-specific options and confirming the result is a regular file. Code uses this when it needs a file handle but must reject directories, pipes, devices, and other special path targets.

**Data flow**: It receives a filesystem path. It creates read-only open options, lets `configure_open` adjust those options for the current operating system, and asynchronously opens the path. Then it checks the opened file with `is_disk_file` and asks the file metadata whether it is a normal file. If the checks pass, it returns the open file; if not, it returns an error explaining that the path is not a file.

**Call relations**: `open_file_for_read` calls this when the server needs to read a file safely. During that flow, `open` delegates operating-system setup to `configure_open`, then delegates the disk-file check to `is_disk_file` before handing the verified file back to its caller.

*Call graph*: calls 2 internal fn (configure_open, is_disk_file); called by 1 (open_file_for_read); 3 external calls (new, format!, new).


##### `configure_open`  (lines 32–32)

```
fn configure_open(_options: &mut tokio::fs::OpenOptions)
```

**Purpose**: Adds operating-system-specific safety settings to the file-opening options before the file is opened. This keeps the rest of the code from needing to know the small but important differences between Unix, Windows, and other platforms.

**Data flow**: It receives a mutable set of file-opening options. On Unix, it adds a non-blocking flag. On Windows, it adds a security quality-of-service flag. On unsupported or simpler platforms, it leaves the options unchanged. It does not return a separate value; the options are changed in place.

**Call relations**: `open` calls this before opening the path. After `configure_open` has adjusted the options, `open` uses those options to perform the actual file open.

*Call graph*: called by 1 (open); 2 external calls (custom_flags, security_qos_flags).


##### `is_disk_file`  (lines 46–48)

```
fn is_disk_file(_file: &tokio::fs::File) -> bool
```

**Purpose**: Checks whether an opened file is backed by a real disk file, where the operating system provides that distinction. This is especially important on Windows, where some handles can look file-like but actually refer to other kinds of system objects.

**Data flow**: It receives an already opened Tokio file. On Windows, it looks at the raw operating-system handle and asks Windows what type of file object it is, returning true only for disk files. On non-Windows systems, it returns true because the later metadata check is used to confirm the object is a regular file.

**Call relations**: `open` calls this immediately after opening the path. Its answer is combined with the metadata check; only if both checks are acceptable does `open` return the file to `open_file_for_read`.

*Call graph*: called by 1 (open); 1 external calls (as_raw_handle).


### `file-watcher/src/lib.rs`

`io_transport` · `cross-cutting`

This file is like a shared building alarm system for files. Many parts of the program may care about different files or folders, but the operating system watcher is expensive and reports low-level events in awkward forms. This code keeps one central watcher, records who is interested in which paths, and sends each subscriber only the changes that match its own request.

Subscribers register paths through a `FileWatcherSubscriber`. Each registration returns a guard called `WatchRegistration`; when the guard is dropped, the watch is automatically removed. This “clean up when the ticket is thrown away” pattern prevents forgotten subscriptions from leaking.

The file also deals with practical filesystem problems. If a requested path does not exist yet, it watches the nearest existing parent folder instead, then moves the real watch closer as directories or files appear. It also canonicalizes paths, meaning it accounts for operating systems that report a path under its resolved real location rather than the spelling the caller used.

Events are collected into sets so duplicates disappear and paths are delivered in sorted order. Optional wrappers can throttle events, spacing them out, or debounce them, grouping a burst of rapid changes into one batch.

#### Function details

##### `Receiver::recv`  (lines 116–132)

```
async fn recv(&mut self) -> Option<FileWatcherEvent>
```

**Purpose**: Waits for the next batch of changed paths for one subscriber. If the subscriber has been removed and no more senders exist, it returns `None` so callers can stop waiting.

**Data flow**: It reads the receiver’s shared set of pending changed paths. If the set has paths, it takes them out, turns them into a `FileWatcherEvent`, and returns it. If there are no paths but senders are still alive, it waits to be notified; if no senders remain, it reports shutdown with `None`.

**Call relations**: This is the main doorway through which higher-level code receives watcher events. Raw watcher notifications are first routed into a subscriber’s queue by `WatchSender::add_changed_paths`; then many consumers, such as event loops and status listeners, call this method to wait for the next usable batch.

*Call graph*: called by 26 (next_event, recv_broadcast_message, next_event, read_response, read_thread_started_notification, recv_status_changed_notification, next_runtime_command, next_event, forward_ops, next_event (+15 more)); 1 external calls (take).


##### `WatchSender::add_changed_paths`  (lines 136–147)

```
async fn add_changed_paths(&self, paths: &[PathBuf])
```

**Purpose**: Adds newly changed paths to a subscriber’s pending event set and wakes the subscriber if there is something new to read.

**Data flow**: It receives a slice of changed paths. Empty input is ignored. Otherwise it locks the shared set, inserts the paths, removes duplicates naturally because the set stores each path once, and notifies one waiting receiver only if the set grew.

**Call relations**: After `FileWatcher::notify_subscribers` decides which subscriber should hear about which paths, it calls this sender method. The matching subscriber later receives those paths through `Receiver::recv`.

*Call graph*: 2 external calls (is_empty, iter).


##### `WatchSender::clone`  (lines 151–156)

```
fn clone(&self) -> Self
```

**Purpose**: Creates another sender handle for the same subscriber queue while keeping an accurate count of live senders.

**Data flow**: It increases the shared sender counter and returns a new `WatchSender` pointing at the same inner queue. No paths are changed.

**Call relations**: This is used when the watcher needs to keep a sender while handing a copy to asynchronous notification code. The counter it updates is later used by `Receiver::recv` and `WatchSender::drop` to know when the channel is truly closed.

*Call graph*: 1 external calls (clone).


##### `WatchSender::drop`  (lines 160–164)

```
fn drop(&mut self)
```

**Purpose**: Marks one sender handle as gone and wakes waiting receivers when the last sender disappears.

**Data flow**: When a sender is destroyed, it decreases the shared sender count. If that count reaches zero, it notifies all waiters so `Receiver::recv` can stop waiting and return `None`.

**Call relations**: This supports clean shutdown of subscriber event streams. When a subscriber is removed or the watcher is torn down, dropped senders cause receivers blocked in `Receiver::recv` to wake up.


##### `watch_channel`  (lines 167–179)

```
fn watch_channel() -> (WatchSender, Receiver)
```

**Purpose**: Builds the private event channel used by one subscriber: a sender for the watcher side and a receiver for the subscriber side.

**Data flow**: It creates shared inner state containing an empty sorted path set, a wake-up notifier, and a sender count starting at one. It returns a `WatchSender` and a `Receiver` that both point to that same state.

**Call relations**: `FileWatcher::add_subscriber` calls this whenever a new subscriber is created. Later, watcher code writes into the sender and subscriber code reads from the receiver.

*Call graph*: called by 1 (add_subscriber); 6 external calls (clone, new, new, new, new, new).


##### `PathWatchCounts::increment`  (lines 188–194)

```
fn increment(&mut self, recursive: bool, amount: usize)
```

**Purpose**: Raises the number of active watches for a path, separated by recursive and non-recursive mode.

**Data flow**: It receives whether the watch is recursive and how many references to add. It increases the matching counter and returns nothing.

**Call relations**: Registration code calls this when a subscriber starts watching a path, and `FileWatcher::apply_actual_watch_move` calls it when a watch moves from a parent path to a more exact path.


##### `PathWatchCounts::decrement`  (lines 196–202)

```
fn decrement(&mut self, recursive: bool, amount: usize)
```

**Purpose**: Lowers the number of active watches for a path without letting the count go below zero.

**Data flow**: It receives whether the watch is recursive and how many references to remove. It subtracts from the matching counter using safe subtraction, then returns nothing.

**Call relations**: Unregistration, subscriber removal, and watch-moving code use this to keep the central reference counts honest. Those counts decide whether the operating-system watcher should still watch a path.


##### `PathWatchCounts::effective_mode`  (lines 204–212)

```
fn effective_mode(self) -> Option<RecursiveMode>
```

**Purpose**: Decides what kind of operating-system watch is needed for a path based on current subscriber demand.

**Data flow**: It reads the recursive and non-recursive counts. If any recursive watch exists, it returns recursive mode; otherwise if any non-recursive watch exists, it returns non-recursive mode; if neither exists, it returns no mode.

**Call relations**: Registration and cleanup code compare the old and new result of this method. If the result changes, they call reconfiguration code so the real filesystem watcher matches current needs.


##### `PathWatchCounts::is_empty`  (lines 214–216)

```
fn is_empty(self) -> bool
```

**Purpose**: Checks whether no subscriber is currently using a watched path.

**Data flow**: It reads both counters and returns true only when both are zero.

**Call relations**: Unregistration, subscriber removal, and watch-moving code use this as the signal to remove a path from the shared reference-count table.


##### `ThrottledWatchReceiver::new`  (lines 233–239)

```
fn new(rx: Receiver, interval: Duration) -> Self
```

**Purpose**: Wraps a normal watcher receiver so events are not emitted more often than a chosen interval.

**Data flow**: It receives an existing `Receiver` and a time interval. It stores both and starts with no scheduled delay.

**Call relations**: Higher-level watcher users and tests create this wrapper when they want to avoid reacting too often to frequent filesystem changes. It later delegates the actual waiting to `Receiver::recv`.

*Call graph*: called by 10 (spawn_event_loop, ancestor_events_notify_child_watches, matching_subscribers_are_notified, missing_directory_watch_moves_to_created_directory_for_child_events, missing_file_watch_reports_requested_path_when_parent_changes, missing_file_watch_reports_requested_path_when_parent_delete_event_arrives, non_recursive_watch_ignores_grandchildren, spawn_event_loop_filters_non_mutating_events, throttled_receiver_coalesces_within_interval, throttled_receiver_flushes_pending_on_shutdown).


##### `ThrottledWatchReceiver::recv`  (lines 243–253)

```
async fn recv(&mut self) -> Option<FileWatcherEvent>
```

**Purpose**: Receives the next event batch, but waits first if the previous batch was emitted too recently.

**Data flow**: It checks the next allowed time. If needed, it sleeps until then, then asks the inner receiver for an event. If an event arrives, it sets the next allowed time to now plus the configured interval and returns the event.

**Call relations**: This sits between callers and `Receiver::recv`. It does not change which paths are reported; it only controls timing so downstream work is not triggered too rapidly.

*Call graph*: calls 1 internal fn (recv); 2 external calls (now, sleep_until).


##### `DebouncedWatchReceiver::new`  (lines 266–272)

```
fn new(rx: Receiver, interval: Duration) -> Self
```

**Purpose**: Wraps a normal watcher receiver so rapid events can be grouped into one combined batch.

**Data flow**: It receives an existing `Receiver` and a debounce interval. It stores them with an initially empty set of accumulated changed paths.

**Call relations**: Higher-level watch setup and tests create this wrapper when they want a burst of file changes to be treated as one event, like waiting a moment after the first doorbell ring before answering.

*Call graph*: called by 3 (watch, debounced_receiver_coalesces_each_event_batch, debounced_receiver_flushes_pending_on_shutdown); 1 external calls (new).


##### `DebouncedWatchReceiver::recv`  (lines 275–296)

```
async fn recv(&mut self) -> Option<FileWatcherEvent>
```

**Purpose**: Collects all events that arrive during a short window after the first event, then returns them as one deduplicated batch.

**Data flow**: It waits until at least one event arrives from the inner receiver. It then starts a deadline and keeps adding paths from any further events until the deadline passes or the stream closes. Finally it returns all accumulated paths in sorted order and clears its internal set.

**Call relations**: This calls `Receiver::recv` repeatedly and presents a quieter event stream to callers. It is useful when saving a file creates several low-level filesystem events that should trigger only one higher-level reaction.

*Call graph*: calls 1 internal fn (recv); 5 external calls (extend, is_empty, now, take, select!).


##### `FileWatcherSubscriber::register_paths`  (lines 308–331)

```
fn register_paths(&self, watched_paths: Vec<WatchPath>) -> WatchRegistration
```

**Purpose**: Registers one subscriber’s interest in a list of files or folders and returns a guard that will unregister them automatically.

**Data flow**: It receives requested watch paths, removes exact duplicates, converts each request into the actual path the operating system can watch, then asks the shared `FileWatcher` to register them for this subscriber. It returns a `WatchRegistration` containing enough information to undo the registration later.

**Call relations**: Higher-level code calls this when it begins caring about runtime roots, thread config files, or other watched paths. It hands the real bookkeeping to `FileWatcher::register_paths` and relies on `WatchRegistration::drop` for cleanup.

*Call graph*: calls 1 internal fn (dedupe_watched_paths); called by 3 (register_runtime_extra_roots, register_thread_config, register_path); 1 external calls (downgrade).


##### `FileWatcherSubscriber::register_path`  (lines 334–336)

```
fn register_path(&self, path: PathBuf, recursive: bool) -> WatchRegistration
```

**Purpose**: Test-only convenience helper for registering one path instead of a whole list.

**Data flow**: It receives a path and a recursive flag, wraps them into a single-item list, and calls `FileWatcherSubscriber::register_paths`. It returns the same registration guard.

**Call relations**: Tests use this to keep setup short. It exercises the same registration path as production code.

*Call graph*: calls 1 internal fn (register_paths); 1 external calls (vec!).


##### `FileWatcherSubscriber::drop`  (lines 340–342)

```
fn drop(&mut self)
```

**Purpose**: Removes the whole subscriber when its handle is destroyed.

**Data flow**: When the subscriber handle is dropped, it tells the shared `FileWatcher` to remove this subscriber id and all associated watches.

**Call relations**: This is the broad cleanup path. Individual registrations are cleaned by `WatchRegistration::drop`, but if the subscriber itself goes away, `FileWatcher::remove_subscriber` cleans everything still attached to it.


##### `WatchRegistration::default`  (lines 353–359)

```
fn default() -> Self
```

**Purpose**: Creates an empty registration guard that does not watch anything.

**Data flow**: It builds a guard with no watcher reference, subscriber id zero, and an empty path list. Dropping it has no effect.

**Call relations**: Callers use this as a harmless placeholder before a real registration exists or after clearing one. Because it contains no live watcher reference, its drop behavior is safe and silent.

*Call graph*: called by 3 (new, register_thread_config, clear_listener); 2 external calls (new, new).


##### `WatchRegistration::drop`  (lines 363–367)

```
fn drop(&mut self)
```

**Purpose**: Automatically unregisters the paths represented by this guard when the guard is destroyed.

**Data flow**: It tries to upgrade its weak reference back to the shared `FileWatcher`. If the watcher still exists, it asks it to unregister this subscriber’s saved watch keys; if the watcher is already gone, it does nothing.

**Call relations**: This is the fine-grained cleanup path for `FileWatcherSubscriber::register_paths`. It means callers do not need to remember a separate unregister call; lifetime controls the subscription.

*Call graph*: 1 external calls (upgrade).


##### `FileWatcher::new`  (lines 379–396)

```
fn new() -> notify::Result<Self>
```

**Purpose**: Creates a live filesystem watcher backed by the `notify` library and starts the background loop that receives raw operating-system events.

**Data flow**: It creates an internal channel for raw watcher results, constructs the recommended platform watcher, initializes shared watch state, and spawns the event loop. On success it returns a ready `FileWatcher`; on setup failure it returns the watcher library’s error.

**Call relations**: Production setup calls this when real disk changes should be observed. It immediately connects the low-level callback from `notify` to this file’s subscriber routing logic through `FileWatcher::spawn_event_loop`.

*Call graph*: called by 5 (new, new, dropping_live_watcher_releases_inner_watcher, recursive_registration_downgrades_to_non_recursive_after_drop, unregister_holds_state_lock_until_unwatch_finishes); 7 external calls (new, new, new, new, default, unbounded_channel, recommended_watcher).


##### `FileWatcher::noop`  (lines 400–405)

```
fn noop() -> Self
```

**Purpose**: Creates an inert watcher that has subscriber bookkeeping but no live operating-system watcher.

**Data flow**: It initializes the same shared state as a real watcher but leaves the internal OS watcher absent. It returns a `FileWatcher` that can still receive synthetic test notifications.

**Call relations**: Tests and some manager setup paths use this when they need the subscription machinery without touching the real filesystem watcher. Notification routing can still be exercised through test helpers.

*Call graph*: called by 16 (new, manager_with_noop_watcher, new, ancestor_events_notify_child_watches, deeply_missing_path_registers_nearest_existing_directory_ancestor, matching_subscribers_are_notified, missing_directory_watch_moves_to_created_directory_for_child_events, missing_file_watch_reports_requested_path_when_parent_changes, missing_file_watch_reports_requested_path_when_parent_delete_event_arrives, missing_path_registers_nearest_existing_parent (+6 more)); 3 external calls (new, new, default).


##### `FileWatcher::add_subscriber`  (lines 409–430)

```
fn add_subscriber(self: &Arc<Self>) -> (FileWatcherSubscriber, Receiver)
```

**Purpose**: Adds a new logical consumer of file changes and gives it both a subscriber handle and its own receiver.

**Data flow**: It creates a fresh sender-receiver pair, locks the shared state, assigns the next subscriber id, stores the subscriber’s sender and empty watch list, and returns the subscriber handle plus receiver.

**Call relations**: Higher-level code calls this before registering paths. The returned `FileWatcherSubscriber` is used to register interests, while the returned `Receiver` is used to read matching events.

*Call graph*: calls 1 internal fn (watch_channel); 1 external calls (new).


##### `FileWatcher::register_paths`  (lines 432–476)

```
fn register_paths(
        &self,
        subscriber_id: SubscriberId,
        watched_paths: &[SubscriberWatchRegistration],
    )
```

**Purpose**: Adds already-prepared watch registrations into the central state and updates the real operating-system watcher if needed.

**Data flow**: It receives a subscriber id and registration records. For each one, it adds or increments that subscriber’s watch state, increases the shared reference count for the actual watched path, compares the old and new effective watch mode, and reconfigures the OS watcher when the needed mode changes.

**Call relations**: `FileWatcherSubscriber::register_paths` calls this after normalizing requests. This method is where per-subscriber interest becomes shared filesystem watching, and it calls `FileWatcher::reconfigure_watch` when the backend must be changed.

*Call graph*: calls 1 internal fn (reconfigure_watch).


##### `FileWatcher::unregister_paths`  (lines 478–516)

```
fn unregister_paths(&self, subscriber_id: SubscriberId, watched_paths: &[SubscriberWatchKey])
```

**Purpose**: Removes specific registered paths for one subscriber and updates the real watcher if those paths are no longer needed.

**Data flow**: It receives a subscriber id and watch keys to remove. It lowers each subscriber watch count, deletes entries that reach zero, lowers shared path reference counts, removes empty count records, and reconfigures the OS watcher when the effective mode changes.

**Call relations**: `WatchRegistration::drop` calls this when a registration guard goes away. It is the mirror image of `FileWatcher::register_paths`.

*Call graph*: calls 1 internal fn (reconfigure_watch).


##### `FileWatcher::remove_subscriber`  (lines 518–554)

```
fn remove_subscriber(&self, subscriber_id: SubscriberId)
```

**Purpose**: Removes an entire subscriber and all path watches still owned by it.

**Data flow**: It removes the subscriber record from shared state. For every watch that subscriber had, it subtracts that watch’s count from the shared path counts, deletes empty count records, and reconfigures the OS watcher if necessary.

**Call relations**: `FileWatcherSubscriber::drop` calls this when a subscriber handle is destroyed. It prevents abandoned subscribers from keeping filesystem watches alive.

*Call graph*: calls 1 internal fn (reconfigure_watch).


##### `FileWatcher::reconfigure_watch`  (lines 556–563)

```
fn reconfigure_watch(
        &'a self,
        path: &Path,
        next_mode: Option<RecursiveMode>,
        inner_guard: &mut Option<std::sync::MutexGuard<'a, FileWatcherInner>>,
    )
```

**Purpose**: Small wrapper that asks the lower-level reconfiguration helper to update one watched path.

**Data flow**: It receives a path, the next desired watch mode, and an optional locked inner watcher guard. It forwards the current watcher’s inner state to `FileWatcher::reconfigure_watch_inner`.

**Call relations**: Registration, unregistration, and subscriber removal call this whenever reference counts show that the backend watch should change. The wrapper keeps those callers from dealing directly with optional live watcher internals.

*Call graph*: called by 3 (register_paths, remove_subscriber, unregister_paths); 1 external calls (reconfigure_watch_inner).


##### `FileWatcher::reconfigure_watch_inner`  (lines 565–608)

```
fn reconfigure_watch_inner(
        inner: Option<&'a Arc<Mutex<FileWatcherInner>>>,
        path: &Path,
        next_mode: Option<RecursiveMode>,
        inner_guard: &mut Option<std::sync::MutexGua
```

**Purpose**: Actually changes the operating-system watcher so one path is watched recursively, watched non-recursively, or not watched at all.

**Data flow**: It receives optional live watcher state, a path, the desired next mode, and a reusable lock guard. If there is no live watcher, it exits. Otherwise it compares the existing mode with the desired one, unwatches old mode if needed, skips missing paths, and asks the backend watcher to watch the path in the new mode.

**Call relations**: This is the direct bridge to the `notify` backend. `FileWatcher::reconfigure_watch` and `FileWatcher::apply_actual_watch_move` call it after reference-count decisions have already been made.

*Call graph*: 3 external calls (exists, to_path_buf, warn!).


##### `FileWatcher::apply_actual_watch_move`  (lines 610–641)

```
fn apply_actual_watch_move(
        path_ref_counts: &mut HashMap<PathBuf, PathWatchCounts>,
        old_actual: WatchPath,
        new_actual: WatchPath,
        count: usize,
        inner: Option<&
```

**Purpose**: Moves shared watch counts and backend watches when a missing-path fallback can be replaced by a closer actual watch path.

**Data flow**: It receives the old actual watch path, the new actual watch path, and the number of references to move. If the paths differ, it subtracts the count from the old path, adds it to the new path, and reconfigures the backend wherever the effective watch mode changes.

**Call relations**: `FileWatcher::notify_subscribers` gathers these moves while processing events, because newly created directories or files may allow a more precise watch. This helper applies those moves after subscriber matching has been calculated.

*Call graph*: 1 external calls (reconfigure_watch_inner).


##### `FileWatcher::spawn_event_loop`  (lines 645–672)

```
fn spawn_event_loop(&self, mut raw_rx: mpsc::UnboundedReceiver<notify::Result<Event>>)
```

**Purpose**: Starts the asynchronous background task that turns raw filesystem watcher callbacks into subscriber notifications.

**Data flow**: It receives the raw event channel from the `notify` callback. If a Tokio runtime is available, it spawns a task that reads events, ignores errors and non-mutating or empty events as appropriate, and passes useful event paths to `FileWatcher::notify_subscribers`. If no runtime is available, it logs a warning.

**Call relations**: `FileWatcher::new` uses this during live watcher creation, and tests can call it through `FileWatcher::spawn_event_loop_for_test`. It is the bridge from callback-style OS events into async subscriber delivery.

*Call graph*: calls 1 internal fn (is_mutating_event); called by 1 (spawn_event_loop_for_test); 5 external calls (clone, try_current, notify_subscribers, recv, warn!).


##### `FileWatcher::notify_subscribers`  (lines 674–733)

```
async fn notify_subscribers(
        state: &RwLock<WatchState>,
        inner: Option<&Arc<Mutex<FileWatcherInner>>>,
        event_paths: &[PathBuf],
    )
```

**Purpose**: Finds which subscribers should be told about a set of changed filesystem paths and sends each one the paths in its own requested spelling.

**Data flow**: It receives shared watch state, optional live watcher internals, and raw event paths. It locks the state, checks every subscriber watch against every event path, collects subscriber-visible changed paths, records any needed actual-watch moves, applies those moves, then sends the collected paths to each subscriber’s sender.

**Call relations**: The background event loop calls this for real filesystem events, and test helpers call it for synthetic events. It relies on `changed_path_for_event` for matching and `actual_watch_path` plus `apply_actual_watch_move` to keep fallback watches accurate over time.

*Call graph*: calls 2 internal fn (actual_watch_path, changed_path_for_event); 2 external calls (apply_actual_watch_move, new).


##### `FileWatcher::send_paths_for_test`  (lines 736–738)

```
async fn send_paths_for_test(&self, paths: Vec<PathBuf>)
```

**Purpose**: Test-only helper that injects synthetic changed paths directly into the subscriber notification logic.

**Data flow**: It receives a list of paths and passes them to `FileWatcher::notify_subscribers` using this watcher’s state and inner watcher option. It returns when notification routing is complete.

**Call relations**: Tests use this instead of relying on real operating-system filesystem events. It exercises the same matching and delivery logic used by the live event loop.

*Call graph*: 1 external calls (notify_subscribers).


##### `FileWatcher::spawn_event_loop_for_test`  (lines 741–746)

```
fn spawn_event_loop_for_test(
        &self,
        raw_rx: mpsc::UnboundedReceiver<notify::Result<Event>>,
    )
```

**Purpose**: Test-only helper that starts the normal event loop with a test-provided raw event channel.

**Data flow**: It receives a raw event receiver and forwards it to `FileWatcher::spawn_event_loop`. It does not change the behavior of the loop.

**Call relations**: Tests use this to feed controlled `notify` events into the same path that production uses, including filtering and warning behavior.

*Call graph*: calls 1 internal fn (spawn_event_loop).


##### `FileWatcher::watch_counts_for_test`  (lines 749–758)

```
fn watch_counts_for_test(&self, path: &Path) -> Option<(usize, usize)>
```

**Purpose**: Test-only helper that reports the current non-recursive and recursive reference counts for one path.

**Data flow**: It locks the shared state for reading, looks up the path in the reference-count table, and returns the two counts if the path is present.

**Call relations**: Tests use this to confirm that registering, unregistering, dropping subscribers, and moving fallback watches update shared counts correctly.


##### `is_mutating_event`  (lines 761–766)

```
fn is_mutating_event(event: &Event) -> bool
```

**Purpose**: Checks whether a raw watcher event represents a change that should matter to subscribers.

**Data flow**: It reads the event kind and returns true for create, modify, or remove events. Other event kinds return false.

**Call relations**: `FileWatcher::spawn_event_loop` calls this before routing an event. This keeps subscribers from being woken for low-level events that do not represent content or path changes they care about.

*Call graph*: called by 1 (spawn_event_loop); 1 external calls (matches!).


##### `dedupe_watched_paths`  (lines 768–777)

```
fn dedupe_watched_paths(mut watched_paths: Vec<WatchPath>) -> Vec<WatchPath>
```

**Purpose**: Removes exact duplicate watch requests before registration.

**Data flow**: It receives a list of `WatchPath` values, sorts them by path and recursive flag, removes adjacent duplicates, and returns the cleaned list.

**Call relations**: `FileWatcherSubscriber::register_paths` calls this first so repeated identical requests in one registration do not inflate watch counts or create unnecessary work.

*Call graph*: called by 1 (register_paths).


##### `actual_watch_path`  (lines 785–823)

```
fn actual_watch_path(requested: &WatchPath) -> (WatchPath, WatchPath, bool)
```

**Purpose**: Decides what path should actually be given to the operating-system watcher for a requested watch path, especially when the requested path does not exist yet.

**Data flow**: It receives a requested path and recursive flag. If the path exists, it uses that path as the actual watch and also records its canonical form for matching. If it does not exist, it searches upward for the nearest existing directory, watches that directory non-recursively, and builds a matched path in the canonical namespace. It returns the actual watch, the matched watch, and whether fallback watching was needed.

**Call relations**: `FileWatcherSubscriber::register_paths` uses this at registration time, and `FileWatcher::notify_subscribers` uses it again after events because newly created path components may let the watcher move closer to the original request.

*Call graph*: called by 1 (notify_subscribers); 1 external calls (clone).


##### `changed_path_for_event`  (lines 830–852)

```
fn changed_path_for_event(
    subscriber_watch: &SubscriberWatchKey,
    subscriber_watch_state: &mut SubscriberWatchState,
    event_path: &Path,
) -> Option<PathBuf>
```

**Purpose**: Turns one raw event path into the path that a particular subscriber should see, if the event matches that subscriber’s watch.

**Data flow**: It receives the subscriber’s requested and canonical watch identity, mutable state for that watch, and a raw event path. It first tries matching in the canonical path namespace, then, when useful, tries the originally requested namespace. It returns a subscriber-visible changed path or `None`.

**Call relations**: `FileWatcher::notify_subscribers` calls this while comparing every raw event path to every subscriber watch. It delegates the detailed matching rules to `changed_path_for_matched_path`.

*Call graph*: calls 1 internal fn (changed_path_for_matched_path); called by 1 (notify_subscribers).


##### `changed_path_for_matched_path`  (lines 856–895)

```
fn changed_path_for_matched_path(
    subscriber_watch: &SubscriberWatchKey,
    subscriber_watch_state: &mut SubscriberWatchState,
    matched: &WatchPath,
    event_path: &Path,
) -> Option<PathBuf>
```

**Purpose**: Applies the detailed path matching rules for one namespace and maps a matching event back into the subscriber’s requested path spelling.

**Data flow**: It receives the subscriber watch identity, mutable existence/fallback state, a matched watch path, and a raw event path. It checks exact matches, ancestor events, recursive child events, and non-recursive direct-child events. It updates whether the watched target last existed and returns the correct requested-path version of the change when the event should be reported.

**Call relations**: `changed_path_for_event` calls this once or twice depending on whether canonical and requested path spellings differ. This is the core rulebook that decides whether a subscriber hears about a raw filesystem event.

*Call graph*: called by 1 (changed_path_for_event); 4 external calls (parent, starts_with, strip_prefix, to_path_buf).


### `file-system/src/lib.rs`

`io_transport` · `cross-cutting`

This file is the common contract for filesystem access. Instead of every part of the program directly touching the computer’s disk, they talk through the `ExecutorFileSystem` trait. A trait is like a promise: any real filesystem implementation must provide these operations, such as reading a file, creating a directory, or getting file metadata. That matters because the same higher-level code can work with local files, remote files, or sandboxed files without knowing the difference.

The file also describes the safety wrapper around file access. `FileSystemSandboxContext` carries permission rules, the current working directory when needed, and Windows-specific sandbox settings. This is what lets the system decide, “Should this operation run inside a restricted area?” rather than accidentally giving broad disk access.

There are a few small data shapes for common file tasks: options for creating directories, removing files, and copying files; metadata about a file; and entries returned when listing a directory. `FileSystemReadStream` wraps a stream of byte chunks, so large files can be read piece by piece instead of all at once. Think of it like sipping through a straw rather than lifting the whole bucket.

#### Function details

##### `FileSystemSandboxContext::from_legacy_sandbox_policy`  (lines 73–92)

```
fn from_legacy_sandbox_policy(
        sandbox_policy: SandboxPolicy,
        cwd: PathUri,
    ) -> io::Result<Self>
```

**Purpose**: Builds a modern sandbox context from an older sandbox policy format. This lets older configuration still be understood by the newer permission system.

**Data flow**: It receives an old-style sandbox policy and a current working directory URI. It turns the URI into a native absolute path, projects the old policy into filesystem and network permission rules, combines those rules into a permission profile, and returns a new sandbox context that still remembers the original URI form of the working directory. If the URI cannot be converted into a native path, it returns an input/output error.

**Call relations**: This is the bridge used when older sandbox settings arrive at the filesystem boundary. It hands off to the legacy-policy conversion helpers, then finishes by using `FileSystemSandboxContext::from_permission_profile_with_cwd` so the rest of the code receives the same kind of sandbox context as newer callers.

*Call graph*: calls 4 internal fn (from_legacy_sandbox_policy, from_legacy_sandbox_policy_for_cwd, from, to_abs_path); 2 external calls (from_runtime_permissions_with_enforcement, from_permission_profile_with_cwd).


##### `FileSystemSandboxContext::from_permission_profile`  (lines 94–96)

```
fn from_permission_profile(permissions: PermissionProfile<AbsolutePathBuf>) -> Self
```

**Purpose**: Creates a sandbox context from an already-built permission profile when no current working directory needs to be attached. It is the simple constructor for permission rules that stand on their own.

**Data flow**: It takes a permission profile using native absolute paths. It passes that profile onward with no current working directory, and the result is a `FileSystemSandboxContext` with default Windows sandbox settings and legacy Landlock disabled.

**Call relations**: This is used by code and tests that already know the exact filesystem permissions they want, such as read-only or workspace-write sandbox setups. It delegates the actual field-filling to `FileSystemSandboxContext::from_permissions_and_cwd`.

*Call graph*: called by 7 (read_only_sandbox, workspace_write_sandbox, test_environment_rejects_sandboxed_filesystem_without_runtime_paths, sandbox_cwd_rejects_cwd_dependent_profile_without_context_cwd, sandboxed_file_system_rejects_non_native_uri_as_invalid_input, read_only_sandbox, sandbox_context); 1 external calls (from_permissions_and_cwd).


##### `FileSystemSandboxContext::from_permission_profile_with_cwd`  (lines 98–103)

```
fn from_permission_profile_with_cwd(
        permissions: PermissionProfile<AbsolutePathBuf>,
        cwd: PathUri,
    ) -> Self
```

**Purpose**: Creates a sandbox context from a permission profile and a current working directory. This is needed when some permission rules depend on where the process is currently working.

**Data flow**: It receives native-path permissions and a working-directory URI. It wraps the directory in `Some`, passes both pieces into the shared constructor, and returns a context that carries both the rules and the directory hint.

**Call relations**: This is used when callers need the sandbox context to include a working directory, including remote filesystem protocol paths and tests that check whether the directory is preserved or dropped. It relies on `FileSystemSandboxContext::from_permissions_and_cwd` to build the final value.

*Call graph*: called by 5 (sandbox_context_with_cwd, filesystem_protocol_accepts_legacy_absolute_paths_and_serializes_path_uris, remote_sandbox_context_drops_unused_cwd, remote_sandbox_context_preserves_required_cwd, remote_file_system_sends_path_and_sandbox_cwd_uris_without_native_conversion); 1 external calls (from_permissions_and_cwd).


##### `FileSystemSandboxContext::from_permissions_and_cwd`  (lines 105–116)

```
fn from_permissions_and_cwd(
        permissions: PermissionProfile<AbsolutePathBuf>,
        cwd: Option<PathUri>,
    ) -> Self
```

**Purpose**: Centralizes the actual construction of a `FileSystemSandboxContext`. The public constructors use it so default settings are applied consistently.

**Data flow**: It receives a permission profile based on native absolute paths and either a working directory URI or no working directory. It converts the permissions into the URI-based form stored by the context, fills in default sandbox settings, and returns the completed context.

**Call relations**: This is the shared helper behind both permission-profile constructors. It keeps the construction rules in one place so callers do not each have to remember the same default values.

*Call graph*: 1 external calls (into).


##### `FileSystemSandboxContext::should_run_in_sandbox`  (lines 118–128)

```
fn should_run_in_sandbox(&self) -> bool
```

**Purpose**: Decides whether this context requires a restricted filesystem sandbox. It protects against accidentally using an unrestricted filesystem when the permission profile cannot safely be interpreted locally.

**Data flow**: It reads the stored permission profile and tries to convert it into native absolute-path permissions for the current host. If that conversion fails, it chooses the safer answer and says to use a sandbox. If conversion works, it checks whether the filesystem policy is restricted and does not already allow full-disk write access, then returns that yes-or-no decision.

**Call relations**: Filesystem selection code can call this before choosing between sandboxed and unsandboxed execution. It depends on the permission profile’s conversion and policy inspection methods to turn stored rules into a practical safety decision.

*Call graph*: 3 external calls (try_from, matches!, clone).


##### `FileSystemSandboxContext::has_cwd_dependent_permissions`  (lines 130–149)

```
fn has_cwd_dependent_permissions(&self) -> bool
```

**Purpose**: Checks whether the permission rules need a current working directory to make sense. This matters because relative patterns and project-root shortcuts cannot be interpreted correctly without knowing “where we are.”

**Data flow**: It looks inside the permission profile. For restricted managed filesystem permissions, it scans each entry: relative glob patterns and project-root special paths count as depending on the working directory, while absolute paths and other special paths do not. Unrestricted, disabled, and external permission profiles return false.

**Call relations**: This is used by sandbox code that needs to know whether a current working directory is required. `FileSystemSandboxContext::drop_cwd_if_unused` calls it before deciding whether it is safe to remove the stored directory.

*Call graph*: called by 2 (sandbox_cwd, drop_cwd_if_unused).


##### `FileSystemSandboxContext::drop_cwd_if_unused`  (lines 151–156)

```
fn drop_cwd_if_unused(mut self) -> Self
```

**Purpose**: Removes the stored current working directory when the permission rules do not need it. This avoids carrying extra path information, especially across remote boundaries, unless it is actually required.

**Data flow**: It takes ownership of a sandbox context. It asks `has_cwd_dependent_permissions` whether the permissions rely on the current working directory. If not, it sets `cwd` to `None`; otherwise it keeps it. It returns the updated context.

**Call relations**: This is a cleanup step for sandbox contexts after they are built. It depends on `FileSystemSandboxContext::has_cwd_dependent_permissions` to avoid dropping information that relative or project-root permissions still need.

*Call graph*: calls 1 internal fn (has_cwd_dependent_permissions).


##### `FileSystemReadStream::new`  (lines 172–176)

```
fn new(stream: impl Stream<Item = FileSystemResult<Bytes>> + Send + 'static) -> Self
```

**Purpose**: Wraps any compatible byte stream so it can be used as a `FileSystemReadStream`. This gives the rest of the code one standard stream type for reading files in chunks.

**Data flow**: It receives a stream whose items are either byte chunks or filesystem errors. It pins and boxes that stream, meaning it stores it behind a stable heap pointer so asynchronous code can safely poll it later. It returns a `FileSystemReadStream` containing that wrapped stream.

**Call relations**: Filesystem implementations call this when they open or create a streamed file read. After that, consumers interact with the wrapper rather than the original stream type.

*Call graph*: called by 2 (read_file_stream, open); 1 external calls (pin).


##### `FileSystemReadStream::poll_next`  (lines 182–184)

```
fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>>
```

**Purpose**: Provides the next chunk of a streamed file read. This is the method that lets `FileSystemReadStream` behave like a standard asynchronous stream.

**Data flow**: It receives a pinned mutable reference to the stream wrapper and an asynchronous task context. It forwards the polling request to the inner stream. The result is either the next byte chunk, an error, a signal that no chunk is ready yet, or a signal that the stream is finished.

**Call relations**: This is called by the asynchronous stream machinery whenever some consumer awaits the next file chunk. It does not interpret the file data itself; it simply passes the request through to the wrapped stream.

*Call graph*: 1 external calls (as_mut).


##### `ExecutorFileSystem::read_file_text`  (lines 211–220)

```
fn read_file_text(
        &'a self,
        path: &'a PathUri,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, String>
```

**Purpose**: Reads a file and turns its bytes into text. It is a convenience method for callers that want a UTF-8 string instead of raw bytes.

**Data flow**: It receives a path and an optional sandbox context. It calls `read_file` on the filesystem implementation to get the full file as bytes, then tries to decode those bytes as UTF-8 text. If reading fails, the read error is returned; if the bytes are not valid UTF-8, it returns an invalid-data error; otherwise it returns the decoded string.

**Call relations**: Higher-level code uses this when working with text files, such as configuration files or patch-related content. It is built on top of the required `ExecutorFileSystem::read_file` operation, so each concrete filesystem only has to provide byte reading and gets text reading for free.

*Call graph*: called by 18 (apply_hunks_to_files, derive_new_contents_from_chunks, verify_apply_patch_args, read_optional_file_text_for_delta, remove_failure_was_side_effect_free, read_config_from_path, load_config_toml_for_required_layer, load_project_layers, load_requirements_toml, merge_root_checkout_project_hooks (+8 more)); 2 external calls (pin, from_utf8).


### Executable and resource resolution
This group covers utilities that locate runnable programs and build/test resources across Unix, Windows, Cargo, Bazel, and WSL environments.

### `cli/src/wsl_paths.rs`

`util` · `cross-cutting`

Windows and Linux write file paths differently. That matters in WSL, where a Linux program may be given a Windows-looking path. Without this file, the CLI could try to open `C:\...` as if it were a normal Linux path, and fail because Linux expects Windows drives to appear under places like `/mnt/c`.

The file provides one small conversion rule: if a path starts with a Windows drive letter, a colon, and then a slash or backslash, it is treated as a Windows absolute path. The drive letter is lowercased, backslashes are changed to forward slashes, and the path is placed under `/mnt/<drive>`. For example, `D:/Work/codex.tgz` becomes `/mnt/d/Work/codex.tgz`.

It also exposes a higher-level helper, `normalize_for_wsl`, which first asks whether the program is currently running under WSL. If not, it leaves the path alone. If it is under WSL, it converts only Windows-style paths and leaves already-normal Unix paths unchanged. This is like a border crossing checkpoint: only paths that need a passport change get rewritten; everyone else passes through untouched.

#### Function details

##### `win_path_to_wsl`  (lines 8–23)

```
fn win_path_to_wsl(path: &str) -> Option<String>
```

**Purpose**: This function converts a Windows absolute drive path into the matching WSL mount path. It is useful when a Linux process inside WSL needs to access a file that was described using Windows path syntax.

**Data flow**: It receives a path as plain text. It checks whether the text looks like a Windows drive path, meaning a letter, then `:`, then `/` or `\`. If the shape does not match, it returns nothing. If it matches, it lowercases the drive letter, changes any backslashes in the rest of the path to forward slashes, and returns a new `/mnt/<drive>/...` path.

**Call relations**: This is the focused conversion tool used by `normalize_for_wsl`. It does not decide whether the program is actually running in WSL; it only answers the narrower question, “If this is a Windows path, what would its WSL version be?”

*Call graph*: called by 1 (normalize_for_wsl); 1 external calls (format!).


##### `normalize_for_wsl`  (lines 27–36)

```
fn normalize_for_wsl(path: P) -> String
```

**Purpose**: This function prepares a path for use in WSL without changing paths unnecessarily. Code can call it before using a path, and it will only rewrite Windows-style paths when the process is actually running under WSL.

**Data flow**: It receives a path-like value, turns it into text, and checks whether the current process is running under WSL. If not, it returns the original text. If it is running under WSL, it asks `win_path_to_wsl` to convert the path. When conversion succeeds, it returns the WSL path; otherwise it returns the original text unchanged.

**Call relations**: `run_update_action` calls this when it needs paths to work correctly during an update flow. `normalize_for_wsl` acts as the safe wrapper around `win_path_to_wsl`: it first checks the environment with `is_wsl`, then delegates the actual path rewriting only when that makes sense.

*Call graph*: calls 1 internal fn (win_path_to_wsl); called by 1 (run_update_action); 2 external calls (as_ref, is_wsl).


##### `tests::win_to_wsl_basic`  (lines 43–53)

```
fn win_to_wsl_basic()
```

**Purpose**: This test checks the basic Windows-to-WSL path conversion rules. It protects against mistakes such as mishandling backslashes, forward slashes, drive letters, or normal Unix paths.

**Data flow**: It feeds example paths into `win_path_to_wsl`. For Windows-style inputs, it expects specific `/mnt/<drive>/...` outputs. For a Unix-style input such as `/home/user/codex`, it expects no conversion result.

**Call relations**: This test directly exercises `win_path_to_wsl`, the low-level conversion function. It confirms the behavior that `normalize_for_wsl` relies on later.

*Call graph*: 2 external calls (assert!, assert_eq!).


##### `tests::normalize_is_noop_on_unix_paths`  (lines 56–58)

```
fn normalize_is_noop_on_unix_paths()
```

**Purpose**: This test confirms that a normal Unix path is not rewritten by the WSL normalizer. That matters because paths that are already valid for Linux should not be changed.

**Data flow**: It passes `/home/u/x` into `normalize_for_wsl` and checks that the returned text is exactly the same path. Nothing outside the test is changed.

**Call relations**: This test covers the safe-pass-through behavior of `normalize_for_wsl`. It helps ensure the helper does not over-correct paths that are already in the right form.

*Call graph*: 1 external calls (assert_eq!).


### `linux-sandbox/src/bazel_bwrap.rs`

`util` · `startup/tool discovery`

The Linux sandbox needs an external program called `bwrap` (Bubblewrap), which creates isolated filesystem and process environments. Most of the time the project can find that program in the usual ways, but Bazel tests and debug runs are different: files may live in Bazel's special “runfiles” area instead of ordinary paths. A runfiles area is like a packed lunch Bazel prepares for a test: it contains the files the test is allowed to see, but their real locations can vary.

This file is a small helper for that special case. It only has real behavior in debug builds. It first checks whether the program appears to be running under Bazel and whether Bazel runfiles information is available. If not, it returns no candidate path. If Bazel provided `CARGO_BIN_EXE_bwrap`, it uses that as the possible location of `bwrap`. If the path is already absolute, it can be used directly. If it is a logical runfiles path, the file tries to turn it into a real filesystem path by looking under known runfiles directories or, as a fallback, by reading Bazel's runfiles manifest file.

Without this helper, debug and test runs under Bazel could fail to find `bwrap` even though Bazel had built and supplied it.

#### Function details

##### `candidate`  (lines 24–26)

```
fn candidate() -> Option<PathBuf>
```

**Purpose**: This function offers a possible filesystem path to the `bwrap` executable when running in a Bazel debug or test environment. In non-debug builds, it always returns nothing, so this Bazel-specific lookup cannot affect normal release behavior.

**Data flow**: It reads environment information supplied by Bazel, especially `CARGO_BIN_EXE_bwrap`, plus signs that runfiles are available. If the environment does not look like a Bazel runfiles setup, it returns no path. If Bazel gave an absolute path, it returns that path. If Bazel gave a logical runfiles path, it asks `resolve_runfile` to translate that into a real path and returns the result if one is found.

**Call relations**: This is the entry point for the file's lookup behavior. `legacy_candidates_for_exe` calls it when building a list of possible places to find an executable. `candidate` first uses `runfiles_env_present` as a quick check that Bazel's file-location clues exist, then hands relative runfiles paths to `resolve_runfile` for the more detailed search.

*Call graph*: calls 2 internal fn (resolve_runfile, runfiles_env_present); called by 1 (legacy_candidates_for_exe); 3 external calls (from, option_env!, var_os).


##### `runfiles_env_present`  (lines 29–33)

```
fn runfiles_env_present() -> bool
```

**Purpose**: This function answers a simple yes-or-no question: did Bazel provide any of the usual environment variables that describe where runfiles can be found?

**Data flow**: It checks three environment variables: `RUNFILES_DIR`, `TEST_SRCDIR`, and `RUNFILES_MANIFEST_FILE`. If at least one is present, it returns true. If none are present, it returns false. It does not change anything outside itself.

**Call relations**: It is called by `candidate` before doing any deeper lookup. This keeps the code from treating ordinary non-Bazel runs as Bazel runs and avoids unnecessary file searching when there is no runfiles information to use.

*Call graph*: called by 1 (candidate); 1 external calls (var_os).


##### `resolve_runfile`  (lines 36–68)

```
fn resolve_runfile(logical_path: &str) -> Option<PathBuf>
```

**Purpose**: This function converts a Bazel logical runfiles path into an actual path on disk. It is needed because Bazel may describe a file by its workspace-style name, while the operating system needs a real filesystem location.

**Data flow**: It receives a logical path as text. It builds one or two possible logical names: the original path, and, if Bazel supplied a workspace name, the workspace-prefixed version. It then looks for those names under runfiles root directories from the environment. If that fails, it opens Bazel's runfiles manifest file, reads it line by line, and looks for a matching entry. When it finds a match, it returns the real path. If no match can be found or the needed environment data is missing, it returns nothing.

**Call relations**: It is called by `candidate` only when Bazel's `bwrap` path is not already absolute. It performs the detailed search work and hands the resolved path back to `candidate`, which can then pass that candidate location along to the broader executable-discovery flow.

*Call graph*: called by 1 (candidate); 7 external calls (open, from, format!, var, var_os, new, vec!).


### `utils/cargo-bin/src/lib.rs`

`util` · `test setup and test helper lookup`

Tests often need to run another program that was just built, or read a sample file from the repository. That sounds simple, but Cargo and Bazel point to those things differently. Cargo usually gives direct filesystem paths. Bazel often gives “runfiles” paths, which are logical names that must be translated into real paths at runtime. This file is the adapter between those worlds.

The main helper, `cargo_bin`, looks for the environment variables Cargo and Bazel set for a built binary. If it finds one, it turns the value into a real, existing path. Under Bazel it uses the runfiles library, which is like asking a map where a packaged test file or binary actually lives on disk. Under Cargo it expects an ordinary absolute path. If no environment variable works, it falls back to `assert_cmd`, a testing helper crate that can locate Cargo-built binaries.

The file also provides helpers for finding resource files and the repository root. The exported `find_resource!` macro chooses at runtime whether to resolve a Bazel runfile or join a path under Cargo’s package directory. Errors are made explicit, so a failing test says what path or environment variable was missing instead of failing mysteriously.

#### Function details

##### `cargo_bin`  (lines 39–69)

```
fn cargo_bin(name: &str) -> Result<PathBuf, CargoBinError>
```

**Purpose**: Finds the real filesystem path to a binary built for the current test run. Test code uses this when it wants to launch another executable without caring whether Cargo or Bazel built it.

**Data flow**: It takes a binary name. First it builds the possible environment variable names for that binary, then checks whether any of those variables are set. If one is set, it asks `resolve_bin_from_env` to turn that value into a real path. If none are set, it asks `assert_cmd` as a fallback. It returns an absolute path if the binary exists, or a clear `CargoBinError` if it cannot find one.

**Call relations**: This is the public entry point for binary lookup. It calls `cargo_bin_env_keys` to know which environment variables to try, and hands any found value to `resolve_bin_from_env`. If that route fails because no variable exists, it delegates to the external `assert_cmd::Command::cargo_bin` helper.

*Call graph*: calls 2 internal fn (cargo_bin_env_keys, resolve_bin_from_env); 5 external calls (from, cargo_bin, format!, current_dir, var_os).


##### `cargo_bin_env_keys`  (lines 71–82)

```
fn cargo_bin_env_keys(name: &str) -> Vec<String>
```

**Purpose**: Builds the list of environment variable names that might point to a test binary. It matters because Cargo changes dashes in binary names to underscores when it creates these variables.

**Data flow**: It takes a binary name such as `my-tool`. It always creates `CARGO_BIN_EXE_my-tool`, then also creates `CARGO_BIN_EXE_my_tool` if replacing dashes with underscores changes the name. It returns the list of possible keys for callers to check.

**Call relations**: This is a small helper used by `cargo_bin` before it reads the environment. It gives `cargo_bin` the possible places where Cargo or Bazel may have stored the binary path.

*Call graph*: called by 1 (cargo_bin); 2 external calls (with_capacity, format!).


##### `runfiles_available`  (lines 84–86)

```
fn runfiles_available() -> bool
```

**Purpose**: Checks whether the program is running in Bazel’s runfiles mode. In plain terms, it asks, “Do we need to translate Bazel’s logical file names into real paths?”

**Data flow**: It reads the `RUNFILES_MANIFEST_ONLY` environment variable. If that variable is present, it returns `true`; otherwise it returns `false`. It does not change anything.

**Call relations**: Both `resolve_bin_from_env` and `repo_root` call this before deciding which path-finding strategy to use. It is the switch that separates the Bazel path flow from the Cargo path flow.

*Call graph*: called by 2 (repo_root, resolve_bin_from_env); 1 external calls (var_os).


##### `resolve_bin_from_env`  (lines 88–112)

```
fn resolve_bin_from_env(key: &str, value: OsString) -> Result<PathBuf, CargoBinError>
```

**Purpose**: Turns an environment variable value for a binary into a real path that exists. It supports both Bazel-style runfile paths and Cargo-style absolute paths.

**Data flow**: It receives the environment variable name and its raw value. If Bazel runfiles are available, it creates a runfiles lookup object and translates the raw path through Bazel’s runfiles map, then makes it absolute if needed and checks that it exists. If runfiles are not available, it accepts the raw value only if it is already an absolute existing path. It returns the resolved path or an error naming the failed key and path.

**Call relations**: `cargo_bin` calls this after finding a `CARGO_BIN_EXE_*` environment variable. This function then calls `runfiles_available` to choose the Bazel or Cargo behavior, and uses the external runfiles lookup when Bazel is active.

*Call graph*: calls 1 internal fn (runfiles_available); called by 1 (cargo_bin); 4 external calls (from, create, rlocation!, current_dir).


##### `resolve_bazel_runfile`  (lines 140–166)

```
fn resolve_bazel_runfile(
    bazel_package: Option<&str>,
    resource: &Path,
) -> std::io::Result<PathBuf>
```

**Purpose**: Finds a test resource file when the test is running under Bazel. It converts a repository-relative resource path into the real path Bazel made available for the test.

**Data flow**: It receives the Bazel package name captured at compile time and the resource path requested by the test. It builds a runfile path under `_main/<package>/<resource>`, cleans up simple `.` and `..` path parts, then asks Bazel’s runfiles lookup for the actual file location. If the file exists, it returns that path; otherwise it returns an `io::Error` explaining what was missing.

**Call relations**: The `find_resource!` macro uses this when `runfiles_available` says the test is running under Bazel. Inside, this function calls `normalize_runfile_path` before asking the external runfiles library to resolve the path.

*Call graph*: calls 1 internal fn (normalize_runfile_path); 5 external calls (from, new, format!, create, rlocation!).


##### `resolve_cargo_runfile`  (lines 168–171)

```
fn resolve_cargo_runfile(resource: &Path) -> std::io::Result<PathBuf>
```

**Purpose**: Finds a test resource file when the test is running under Cargo. It treats the resource as living underneath the crate’s manifest directory.

**Data flow**: It receives a resource path. It reads Cargo’s compile-time `CARGO_MANIFEST_DIR` value, joins the resource path onto that directory, and returns the combined path. It does not check whether the file exists.

**Call relations**: `repo_root` uses this to find `repo_root.marker` in Cargo runs. The `find_resource!` macro follows the same Cargo idea directly when runfiles are not available.

*Call graph*: called by 1 (repo_root); 2 external calls (env!, from).


##### `repo_root`  (lines 173–207)

```
fn repo_root() -> io::Result<PathBuf>
```

**Purpose**: Finds the root directory of the repository during tests. It does this by locating a marker file and walking upward a fixed number of parent directories.

**Data flow**: It first checks whether Bazel runfiles are available. Under Bazel, it reads a compile-time marker path, resolves it through the runfiles system, and errors if the marker cannot be found. Under Cargo, it uses `resolve_cargo_runfile` to locate `repo_root.marker`. After finding the marker file, it moves up four directory levels and returns that directory as the repository root.

**Call relations**: Callers use this when they need a stable path to the repository root. This function calls `runfiles_available` to choose between Bazel and Cargo behavior, and calls `resolve_cargo_runfile` for the Cargo path. In the Bazel path, it relies on the external runfiles library.

*Call graph*: calls 2 internal fn (resolve_cargo_runfile, runfiles_available); 4 external calls (new, option_env!, create, rlocation!).


##### `normalize_runfile_path`  (lines 209–231)

```
fn normalize_runfile_path(path: &Path) -> PathBuf
```

**Purpose**: Cleans up a runfile path by removing harmless current-directory parts and resolving simple parent-directory parts. This makes Bazel resource paths more predictable before lookup.

**Data flow**: It receives a path and walks through its pieces one by one. It drops `.` pieces, cancels a normal previous piece when it sees `..`, and keeps other pieces as they are. It then rebuilds and returns a cleaned `PathBuf`.

**Call relations**: `resolve_bazel_runfile` calls this before asking Bazel’s runfiles lookup to resolve a resource. It is an internal cleanup step that keeps the path handed to Bazel tidy and consistent.

*Call graph*: called by 1 (resolve_bazel_runfile); 4 external calls (components, new, new, matches!).


### `rmcp-client/src/program_resolver.rs`

`util` · `server launch`

When this project starts an MCP server, it may be given a simple command name such as `npx`, `pnpm`, or another script on the system path. Unix-like systems usually know how to run these scripts directly, because the operating system reads the script’s first line, called a shebang, to find the right interpreter. Windows is different: it often needs the full executable name, including extensions like `.cmd` or `.bat`, before `Command::new()` can run it.

This file hides that difference behind one function, `resolve`. On Unix, it leaves the program name alone because the operating system can already find and run it. On Windows, it searches the configured `PATH` and uses Windows extension rules to find the actual executable file. If the search fails, it returns the original program name so the later process launch can report the normal error.

The tests build a tiny fake executable in a temporary folder, place that folder on `PATH`, and check the expected platform behavior. In everyday terms, this file is like a translator at the door: on Unix it lets the command through unchanged, while on Windows it adds the missing street address so the system can actually find the command.

#### Function details

##### `resolve`  (lines 41–61)

```
fn resolve(
    program: OsString,
    env: &HashMap<OsString, OsString>,
    cwd: &Path,
) -> std::io::Result<OsString>
```

**Purpose**: This function turns a requested program name into something the operating system can run. On Unix it returns the name unchanged; on Windows it tries to find the full executable path, including script extensions such as `.cmd`.

**Data flow**: It receives a program name, an environment map containing values like `PATH`, and a current working directory. On Windows it reads `PATH` from that environment and asks the `which` library to search for the real executable from that starting point; on Unix it does not need the extra search. It returns an `OsString` containing either the resolved executable path or, if resolution fails on Windows, the original program name.

**Call relations**: The real server startup flow calls this from `launch_server` before creating the child process. The test `test_resolved_program_executes_successfully` also calls it to prove that the resolved command can actually be run. Inside the Windows version, it hands the search work to `which_in` and writes debug messages about whether the lookup succeeded.

*Call graph*: called by 2 (test_resolved_program_executes_successfully, launch_server); 3 external calls (new, debug!, which_in).


##### `tests::test_unix_executes_script_without_extension`  (lines 76–102)

```
async fn test_unix_executes_script_without_extension() -> Result<()>
```

**Purpose**: This Unix-only test proves that a script placed on `PATH` can be run by name without adding a file extension. It protects the assumption that Unix does not need the Windows-style resolution step.

**Data flow**: It builds a temporary test environment with a small executable script and a modified `PATH`. Then it tries to run the script by its plain name using that environment. The expected result is a successful process start; if the operating system briefly reports the file as busy, the test waits a moment and retries.

**Call relations**: This test uses `tests::TestExecutableEnv::new` to create the fake command and then calls the system process launcher directly. It does not call `resolve`, because it is checking the baseline Unix behavior that `resolve` relies on.

*Call graph*: 5 external calls (assert!, new, new, from_millis, sleep).


##### `tests::test_windows_fails_without_extension`  (lines 107–118)

```
async fn test_windows_fails_without_extension() -> Result<()>
```

**Purpose**: This Windows-only test shows the problem this file is meant to solve: a script command without its `.cmd` extension does not run directly on Windows. It documents the platform difference in executable lookup.

**Data flow**: It creates a temporary Windows-style test command, sets up an environment where the command is on `PATH`, and then tries to run the command by its base name only. The expected result is an error from the process launcher.

**Call relations**: This test uses `tests::TestExecutableEnv::new` to prepare the fake command. It intentionally bypasses `resolve` so it can demonstrate what fails before this file’s Windows-specific resolution is applied.

*Call graph*: 3 external calls (assert!, new, new).


##### `tests::test_windows_succeeds_with_extension`  (lines 123–136)

```
async fn test_windows_succeeds_with_extension() -> Result<()>
```

**Purpose**: This Windows-only test confirms that the same script does run when the `.cmd` extension is included. It verifies the behavior that Windows program resolution must reproduce automatically.

**Data flow**: It creates the temporary test command, appends `.cmd` to the command name, and runs that explicit file name with the test environment. The expected result is a successful process start.

**Call relations**: Like the previous Windows test, it uses `tests::TestExecutableEnv::new` for setup and then invokes the process launcher directly. Together with `test_windows_fails_without_extension`, it explains why `resolve` needs to find the extension on Windows.

*Call graph*: 4 external calls (assert!, new, format!, new).


##### `tests::test_resolved_program_executes_successfully`  (lines 140–157)

```
async fn test_resolved_program_executes_successfully() -> Result<()>
```

**Purpose**: This test checks the main promise of the file: after using `resolve`, the command should run successfully on every supported platform. It is the end-to-end safety check for the resolver.

**Data flow**: It creates a temporary executable command and turns the command name into an `OsString`. It passes that name, the prepared environment, and the current directory into `resolve`. It then uses the returned value as the program to launch and expects the launch to succeed.

**Call relations**: This is the test that directly exercises `resolve`. It first calls `tests::TestExecutableEnv::new` for setup, then passes the resolved result into the process launcher, mirroring how `launch_server` uses the resolver in normal operation.

*Call graph*: calls 1 internal fn (resolve); 5 external calls (from, assert!, new, new, current_dir).


##### `tests::TestExecutableEnv::new`  (lines 170–190)

```
fn new() -> Result<Self>
```

**Purpose**: This helper builds a controlled temporary environment for the tests. It creates a fake executable and prepares environment variables so the test command can be found through `PATH`.

**Data flow**: It creates a temporary directory, writes the test executable into it, and builds an extra environment map with that directory at the front of `PATH`. On Windows it also makes sure `PATHEXT`, the variable that lists executable extensions, includes `.CMD`. It then calls `create_env_for_mcp_server` and returns a `TestExecutableEnv` that keeps the temporary directory alive and stores the program name and environment.

**Call relations**: All the tests call this before trying to launch the fake command. It hands off file creation to `tests::TestExecutableEnv::create_executable`, path construction to `tests::TestExecutableEnv::build_path_env_var`, and, on Windows, extension setup to `tests::TestExecutableEnv::ensure_cmd_extension`.

*Call graph*: calls 1 internal fn (create_env_for_mcp_server); 6 external calls (new, from, build_path_env_var, create_executable, ensure_cmd_extension, new).


##### `tests::TestExecutableEnv::create_executable`  (lines 193–208)

```
fn create_executable(dir: &Path) -> Result<()>
```

**Purpose**: This helper writes the small fake program used by the tests. It creates the right kind of script for the current operating system.

**Data flow**: It receives the temporary directory path. On Windows it writes a `.cmd` file that exits successfully. On Unix it writes a shell script with a shebang and then marks it as executable. It returns success once the test program exists in the temporary directory.

**Call relations**: It is called by `tests::TestExecutableEnv::new` during test setup. On Unix, it calls `tests::TestExecutableEnv::set_executable` so the script can actually be run by the operating system.

*Call graph*: 4 external calls (join, set_executable, format!, write).


##### `tests::TestExecutableEnv::set_executable`  (lines 211–217)

```
fn set_executable(path: &Path) -> Result<()>
```

**Purpose**: This Unix-only helper gives the test script permission to run. Without this permission change, the file might exist but the operating system would refuse to execute it.

**Data flow**: It receives the path to the newly written script. It reads the file’s current permissions, changes them to include execute permission for typical users, and writes the permissions back to the file.

**Call relations**: It is called only by `tests::TestExecutableEnv::create_executable` on Unix. It supports the Unix tests by making the fake script behave like a real command-line program.

*Call graph*: 2 external calls (metadata, set_permissions).


##### `tests::TestExecutableEnv::build_path_env_var`  (lines 220–228)

```
fn build_path_env_var(dir: &Path) -> OsString
```

**Purpose**: This helper builds a `PATH` value that makes the temporary test command easy to find. It places the temporary directory before the existing system path.

**Data flow**: It receives the temporary directory path and starts a new `PATH` string with that directory. If the machine already has a `PATH`, it appends the correct separator for the platform, `:` on Unix or `;` on Windows, followed by the existing value. It returns the combined path as an operating-system string.

**Call relations**: It is called by `tests::TestExecutableEnv::new` while building the test environment. The resulting value is passed into `create_env_for_mcp_server`, which produces the environment later used by the test process launches and by `resolve`.

*Call graph*: 4 external calls (from, as_os_str, cfg!, var_os).


##### `tests::TestExecutableEnv::ensure_cmd_extension`  (lines 232–245)

```
fn ensure_cmd_extension() -> OsString
```

**Purpose**: This Windows-only helper makes sure the Windows executable-extension list includes `.CMD`. That lets lookup tools discover `.cmd` scripts when the user typed only the base command name.

**Data flow**: It reads the current `PATHEXT` environment variable, which tells Windows which file extensions count as executable. If `.CMD` is already present, it returns the existing value. If not, it creates a new value with `.CMD;` added at the front.

**Call relations**: It is called by `tests::TestExecutableEnv::new` when preparing Windows test environments. Its output helps `resolve` and the Windows lookup rules find the temporary `.cmd` test program.

*Call graph*: 2 external calls (from, var_os).


### Environment and terminal shaping
These files detect runtime terminal context and construct adjusted process environments or UI behavior based on that context.

### `core/src/exec_env.rs`

`util` · `command execution setup`

When Codex starts a shell command, it must decide which environment variables the new process should receive. Environment variables are small name-value settings, such as PATH or HOME, that programs inherit from their parent process. Passing all of them through can leak secrets or create surprising behavior; passing too few can break normal shell tools. This file is the core-side doorway for that decision.

The real filtering rules live in codex_protocol::shell_environment. This file adapts those shared helpers for the core crate. It accepts a ShellEnvironmentPolicy, which describes what to include, exclude, or override, and optionally a ThreadId, which identifies the Codex conversation or task. If a thread id is present, it is converted to text and injected as CODEX_THREAD_ID, even when the policy is otherwise very restrictive.

A useful analogy is packing a travel bag for a subprocess: the policy is the packing list, the current machine environment is the closet, and this file produces the exact bag the command is allowed to take. The result is a plain map of strings that can be passed to a child process after first clearing the default inherited environment. The test-only helpers let tests build the same kind of environment map from controlled input variables instead of the real machine environment.

#### Function details

##### `create_env`  (lines 20–26)

```
fn create_env(
    policy: &ShellEnvironmentPolicy,
    thread_id: Option<ThreadId>,
) -> HashMap<String, String>
```

**Purpose**: Builds the environment-variable map that should be given to a real command Codex is about to run. It applies the chosen shell environment policy and adds the Codex thread id when one is available.

**Data flow**: It receives a ShellEnvironmentPolicy and an optional ThreadId. The thread id, if present, is turned into a string, then both the policy and that optional string are passed to the shared shell_environment::create_env helper. The output is a HashMap of environment variable names to values, ready to give to a spawned process.

**Call relations**: This is the public helper other command-running paths call before launching shell work, including sandboxed commands, user shell commands, session setup, and conversion into execution parameters. It delegates the detailed filtering work to the shared protocol-layer create_env function, so the core code uses the same environment rules as the rest of the system.

*Call graph*: calls 1 internal fn (create_env); called by 7 (run_command_under_sandbox, execute_user_shell_command, to_exec_params, shell_command_handler_to_exec_params_uses_session_shell_and_turn_context, open_session_with_sandbox, create_env_from_core_vars, create_env_from_core_vars).


##### `create_env_from_vars`  (lines 29–39)

```
fn create_env_from_vars(
    vars: I,
    policy: &ShellEnvironmentPolicy,
    thread_id: Option<ThreadId>,
) -> HashMap<String, String>
```

**Purpose**: Provides a Windows-only test helper for building an environment map from a supplied list of variables instead of the real process environment. This lets tests check the policy behavior with predictable input.

**Data flow**: It receives an iterable collection of variable name-value pairs, a ShellEnvironmentPolicy, and an optional ThreadId. It converts the thread id to text if needed, then passes the supplied variables, policy, and optional thread id string to the shared shell_environment::create_env_from_vars helper. It returns the resulting filtered environment map.

**Call relations**: This function exists only during tests on Windows. Test code calls it when it needs to exercise the same environment-building path while controlling exactly which variables are present, and it hands the real work off to the shared create_env_from_vars implementation.

*Call graph*: calls 1 internal fn (create_env_from_vars).


##### `populate_env`  (lines 42–52)

```
fn populate_env(
    vars: I,
    policy: &ShellEnvironmentPolicy,
    thread_id: Option<ThreadId>,
) -> HashMap<String, String>
```

**Purpose**: Provides a test-only helper for applying an environment policy to a supplied set of variables. It is used to verify how policy rules transform known input into the final environment map.

**Data flow**: It receives test-provided environment variables, a ShellEnvironmentPolicy, and an optional ThreadId. The optional thread id is converted to a string, then the inputs are passed to shell_environment::populate_env. The returned value is the environment map after the policy has been applied and the thread id has been added when appropriate.

**Call relations**: This helper is compiled only for tests. The test module uses it to check the lower-level population behavior without depending on the live operating-system environment, while the actual transformation is still performed by the shared populate_env helper.

*Call graph*: calls 1 internal fn (populate_env).


### `terminal-detection/src/lib.rs`

`domain_logic` · `first terminal metadata request, then cached for cross-cutting use`

Terminal programs expose clues through environment variables, such as `TERM_PROGRAM`, `TERM`, `WEZTERM_VERSION`, or `WT_SESSION`. This file gathers those clues and turns them into a small, structured answer: the terminal name, optional version, fallback terminal capability string, and whether a terminal multiplexer is in use. A terminal multiplexer is a program like tmux or Zellij that sits between the app and the real terminal, like a switchboard between callers.

The main flow starts with `terminal_info()`, which detects the terminal once and caches the answer so later calls are cheap and consistent. Detection prefers explicit names first, because they are usually more reliable, then checks known terminal-specific variables, and finally falls back to `TERM`, a broad capability label used by many command-line programs.

There is special care for tmux. If `TERM_PROGRAM` says `tmux`, the code tries to ask tmux what the underlying client terminal really is, so the app can report “Ghostty” or “WezTerm” instead of only “tmux”. Zellij is detected too, including a best-effort version lookup.

Before terminal information is used in a User-Agent header, it is cleaned so unsafe characters are replaced. Without this file, telemetry would be less useful and terminal-specific choices could be wrong or impossible.

#### Function details

##### `TerminalInfo::new`  (lines 91–105)

```
fn new(
        name: TerminalName,
        term_program: Option<String>,
        version: Option<String>,
        term: Option<String>,
        multiplexer: Option<Multiplexer>,
    ) -> Self
```

**Purpose**: Builds a complete `TerminalInfo` value from already-decided pieces. It is the shared constructor used by the more specific helper constructors.

**Data flow**: It receives a terminal category, optional program name, optional version, optional `TERM` value, and optional multiplexer information. It places those values directly into a new `TerminalInfo` object and returns it.

**Call relations**: The other `TerminalInfo` constructors use this as the common final step after they have decided which fields apply. It does not perform detection itself; it only packages the result.


##### `TerminalInfo::from_term_program`  (lines 108–121)

```
fn from_term_program(
        name: TerminalName,
        term_program: String,
        version: Option<String>,
        multiplexer: Option<Multiplexer>,
    ) -> Self
```

**Purpose**: Creates terminal information when `TERM_PROGRAM` is the main clue. This is used when the environment clearly names the terminal program.

**Data flow**: It receives the detected terminal category, the raw `TERM_PROGRAM` text, an optional version, and optional multiplexer details. It stores the program and version, leaves the `TERM` capability field empty, and returns a `TerminalInfo`.

**Call relations**: `detect_terminal_info_from_env` calls this after reading `TERM_PROGRAM` and mapping it to a known terminal name when possible. It hands the final object back to the detection flow.

*Call graph*: called by 1 (detect_terminal_info_from_env); 1 external calls (new).


##### `TerminalInfo::from_term_program_and_term`  (lines 124–132)

```
fn from_term_program_and_term(
        name: TerminalName,
        term_program: String,
        version: Option<String>,
        term: Option<String>,
        multiplexer: Option<Multiplexer>,
    )
```

**Purpose**: Creates terminal information when both a program name and a `TERM` capability string are known. This is mainly useful inside tmux, where tmux can reveal both the client terminal type and the client `TERM` name.

**Data flow**: It receives a terminal category, program name, optional version, optional `TERM` value, and optional multiplexer details. It stores all of those in a new `TerminalInfo` and returns it.

**Call relations**: `terminal_from_tmux_client_info` calls this after splitting tmux’s client terminal description into a program name and version. It lets the tmux-specific path preserve more detail than a normal `TERM_PROGRAM` lookup.

*Call graph*: called by 1 (terminal_from_tmux_client_info); 1 external calls (new).


##### `TerminalInfo::from_name`  (lines 135–147)

```
fn from_name(
        name: TerminalName,
        version: Option<String>,
        multiplexer: Option<Multiplexer>,
    ) -> Self
```

**Purpose**: Creates terminal information when the code knows the terminal category but does not have a `TERM_PROGRAM` string. This is used for clues like `WEZTERM_VERSION`, `KITTY_WINDOW_ID`, or `WT_SESSION`.

**Data flow**: It receives a terminal category, optional version, and optional multiplexer details. It returns a `TerminalInfo` with no program string and no `TERM` fallback value.

**Call relations**: `detect_terminal_info_from_env` calls this for terminal-specific environment variables that identify a terminal without providing a standard `TERM_PROGRAM` value.

*Call graph*: called by 1 (detect_terminal_info_from_env); 1 external calls (new).


##### `TerminalInfo::from_term`  (lines 150–163)

```
fn from_term(term: String, multiplexer: Option<Multiplexer>) -> Self
```

**Purpose**: Creates terminal information from the `TERM` capability string, the broad fallback clue used by terminal programs. It recognizes a few special `TERM` values but otherwise marks the terminal name as unknown.

**Data flow**: It receives a `TERM` string and optional multiplexer details. If the value is `dumb`, `wezterm`, or `wezterm-mux`, it chooses a matching category; otherwise it uses `Unknown`. It returns a `TerminalInfo` that keeps the original `TERM` value.

**Call relations**: `detect_terminal_info_from_env` calls this near the end of detection when stronger clues are missing. `terminal_from_tmux_client_info` also uses it when tmux provides only a client `TERM` name.

*Call graph*: called by 1 (detect_terminal_info_from_env); 1 external calls (new).


##### `TerminalInfo::unknown`  (lines 166–174)

```
fn unknown(multiplexer: Option<Multiplexer>) -> Self
```

**Purpose**: Creates terminal information for the case where no usable terminal clue was found. It still preserves multiplexer information if tmux or Zellij was detected.

**Data flow**: It receives optional multiplexer details. It returns a `TerminalInfo` with terminal name `Unknown` and no program, version, or `TERM` value.

**Call relations**: `detect_terminal_info_from_env` calls this as the final fallback after every known environment check fails.

*Call graph*: called by 1 (detect_terminal_info_from_env); 1 external calls (new).


##### `TerminalInfo::user_agent_token`  (lines 177–209)

```
fn user_agent_token(&self) -> String
```

**Purpose**: Turns structured terminal information into a short text token safe for a User-Agent header. A User-Agent header is metadata sent with requests or telemetry to describe the client program and environment.

**Data flow**: It reads the `TerminalInfo` fields. It prefers `TERM_PROGRAM` plus version, then a non-empty `TERM` value, then a built-in display name for the detected terminal category. It then sanitizes the text so invalid header characters become underscores and returns the cleaned string.

**Call relations**: `user_agent` reaches this through `terminal_info()`. This function relies on `format_terminal_version` to add versions consistently and `sanitize_header_value` to make the final token safe.

*Call graph*: calls 2 internal fn (format_terminal_version, sanitize_header_value); 1 external calls (format!).


##### `TerminalInfo::is_zellij`  (lines 212–214)

```
fn is_zellij(&self) -> bool
```

**Purpose**: Answers whether the detected environment is running inside Zellij. Callers can use this to choose behavior that should only happen in that multiplexer.

**Data flow**: It reads the `multiplexer` field from `TerminalInfo`. It returns `true` if that field contains Zellij information and `false` otherwise.

**Call relations**: This is a small convenience method for code outside this file. It depends on the detection work already captured in a `TerminalInfo` value.

*Call graph*: 1 external calls (matches!).


##### `Environment::has`  (lines 227–229)

```
fn has(&self, name: &str) -> bool
```

**Purpose**: Checks whether an environment variable exists. It is part of the injectable environment interface, which makes detection testable without changing the real process environment.

**Data flow**: It receives an environment variable name. It asks `var` for the value and returns `true` if any value is present, even an empty one.

**Call relations**: `detect_terminal_info_from_env` uses this style of check for variables where mere presence is meaningful. Implementations only need to provide `var`; this default method builds on it.


##### `Environment::var_non_empty`  (lines 232–234)

```
fn var_non_empty(&self, name: &str) -> Option<String>
```

**Purpose**: Reads an environment variable only if it contains non-whitespace text. This avoids treating blank values as real terminal clues.

**Data flow**: It receives an environment variable name. It reads the value through `var`, discards it if it is empty or only spaces, and returns the remaining string if valid.

**Call relations**: `Environment::has_non_empty` and `Environment::zellij_version` build on this method. The detection functions use the same idea when they need meaningful values rather than just present variables.

*Call graph*: called by 2 (has_non_empty, zellij_version).


##### `Environment::has_non_empty`  (lines 237–239)

```
fn has_non_empty(&self, name: &str) -> bool
```

**Purpose**: Checks whether an environment variable exists and has useful text in it. This is stricter than simply checking that the variable exists.

**Data flow**: It receives an environment variable name. It calls `var_non_empty` and returns `true` only when that produces a string.

**Call relations**: `detect_multiplexer` uses this to recognize tmux and Zellij markers without being fooled by blank variables.

*Call graph*: calls 1 internal fn (var_non_empty).


##### `Environment::zellij_version`  (lines 245–247)

```
fn zellij_version(&self) -> Option<String>
```

**Purpose**: Provides a default way to read the Zellij version from the environment. Zellij is a terminal multiplexer, so this helps record which version is active.

**Data flow**: It reads `ZELLIJ_VERSION` through `var_non_empty`. It returns the version string if present and non-blank, otherwise `None`.

**Call relations**: `detect_multiplexer` asks the environment for this when it has found Zellij. `ProcessEnvironment` overrides it with an extra command-line fallback.

*Call graph*: calls 1 internal fn (var_non_empty).


##### `ProcessEnvironment::var`  (lines 254–263)

```
fn var(&self, name: &str) -> Option<String>
```

**Purpose**: Reads an environment variable from the actual running process. This is the real-world implementation of the testable `Environment` interface.

**Data flow**: It receives a variable name and asks the operating system for its value. If the variable is missing, it returns nothing. If the value is not valid UTF-8 text, it logs a warning and returns nothing.

**Call relations**: Detection uses this through the `Environment` trait when running normally. The warning path protects the rest of the detection code from invalid text.

*Call graph*: 2 external calls (var, warn!).


##### `ProcessEnvironment::tmux_client_info`  (lines 265–267)

```
fn tmux_client_info(&self) -> TmuxClientInfo
```

**Purpose**: Gets tmux client details for the real process environment. This is how the detector can look through tmux and identify the underlying terminal.

**Data flow**: It takes no extra input beyond the current process context. It calls the helper that runs tmux queries and returns a `TmuxClientInfo` containing optional client terminal type and name.

**Call relations**: `detect_terminal_info_from_env` calls this through the `Environment` trait only when tmux is detected and `TERM_PROGRAM` says tmux.

*Call graph*: calls 1 internal fn (tmux_client_info).


##### `ProcessEnvironment::zellij_version`  (lines 269–272)

```
fn zellij_version(&self) -> Option<String>
```

**Purpose**: Gets the Zellij version for the real process, using both environment data and a command fallback. This improves version detection when `ZELLIJ_VERSION` is not set.

**Data flow**: It first tries the non-empty `ZELLIJ_VERSION` environment variable. If that is missing, it runs the Zellij version command and returns the parsed version if available.

**Call relations**: `detect_multiplexer` calls this through the `Environment` trait after detecting Zellij. It hands back optional version text for the `Multiplexer::Zellij` record.


##### `user_agent`  (lines 276–278)

```
fn user_agent() -> String
```

**Purpose**: Returns the terminal identifier as a cleaned User-Agent token. This is the simple public function for code that only needs a string for telemetry or headers.

**Data flow**: It asks for the cached structured terminal information through `terminal_info()`. It then converts that information into a sanitized token and returns the string.

**Call relations**: Callers outside this file use this instead of dealing with all detection details. It sits on top of `terminal_info` and `TerminalInfo::user_agent_token`.

*Call graph*: calls 1 internal fn (terminal_info).


##### `terminal_info`  (lines 281–285)

```
fn terminal_info() -> TerminalInfo
```

**Purpose**: Returns structured terminal metadata for the current process. It detects the terminal once, then reuses the same result for later calls.

**Data flow**: On the first call, it runs detection against `ProcessEnvironment` and stores the result in a `OnceLock`, which is a one-time cache. On every call, it returns a clone of the stored `TerminalInfo`.

**Call relations**: `user_agent` calls this when it needs a string token. Other code can call it directly when it needs the full terminal name, version, `TERM`, or multiplexer details.

*Call graph*: called by 1 (user_agent).


##### `detect_terminal_info_from_env`  (lines 301–388)

```
fn detect_terminal_info_from_env(env: &dyn Environment) -> TerminalInfo
```

**Purpose**: Performs the main terminal detection decision tree. It turns environment clues into one best `TerminalInfo` answer.

**Data flow**: It receives an `Environment`, first detects whether tmux or Zellij is active, then checks terminal clues in priority order. It uses `TERM_PROGRAM` first, has a special tmux path to identify the underlying client terminal, checks known terminal-specific variables next, falls back to `TERM`, and finally returns `Unknown` if nothing works.

**Call relations**: `terminal_info` indirectly uses this with `ProcessEnvironment`. It calls helper constructors such as `from_term_program`, `from_name`, `from_term`, and `unknown`, plus helper detectors such as `detect_multiplexer`, `is_tmux_term_program`, `terminal_from_tmux_client_info`, and `terminal_name_from_term_program`.

*Call graph*: calls 8 internal fn (from_name, from_term, from_term_program, unknown, detect_multiplexer, is_tmux_term_program, terminal_from_tmux_client_info, terminal_name_from_term_program); 5 external calls (has, tmux_client_info, var, var_non_empty, matches!).


##### `detect_multiplexer`  (lines 390–407)

```
fn detect_multiplexer(env: &dyn Environment) -> Option<Multiplexer>
```

**Purpose**: Detects whether the app is running inside tmux or Zellij. A multiplexer can hide the real terminal, so this must be known early.

**Data flow**: It reads tmux marker variables first, then Zellij marker variables. If tmux is present, it returns tmux metadata with an optional version. If Zellij is present, it returns Zellij metadata with an optional version. If neither is present, it returns nothing.

**Call relations**: `detect_terminal_info_from_env` calls this before choosing the terminal name. It calls `tmux_version_from_env` for tmux and asks the environment for `zellij_version` for Zellij.

*Call graph*: calls 1 internal fn (tmux_version_from_env); called by 1 (detect_terminal_info_from_env); 2 external calls (has_non_empty, zellij_version).


##### `is_tmux_term_program`  (lines 409–411)

```
fn is_tmux_term_program(value: &str) -> bool
```

**Purpose**: Checks whether a `TERM_PROGRAM` value means tmux. It uses a case-insensitive comparison so different capitalization still works.

**Data flow**: It receives a string and compares it with `tmux` without caring about letter case. It returns `true` for tmux and `false` for anything else.

**Call relations**: `detect_terminal_info_from_env` uses this to decide whether to ask tmux for client terminal details. `tmux_version_from_env` uses it to confirm that `TERM_PROGRAM_VERSION` belongs to tmux.

*Call graph*: called by 2 (detect_terminal_info_from_env, tmux_version_from_env).


##### `terminal_from_tmux_client_info`  (lines 413–435)

```
fn terminal_from_tmux_client_info(
    client_info: TmuxClientInfo,
    multiplexer: Option<Multiplexer>,
) -> Option<TerminalInfo>
```

**Purpose**: Builds terminal information from details reported by tmux about its client terminal. This helps report the real terminal behind tmux instead of reporting only tmux.

**Data flow**: It receives tmux client data and multiplexer metadata. It removes blank values, then prefers the client terminal type. If that exists, it splits it into program and version, maps the program to a known terminal category if possible, and returns a `TerminalInfo` that also keeps the client `TERM` name. If only the client `TERM` name exists, it builds from that. If neither exists, it returns nothing.

**Call relations**: `detect_terminal_info_from_env` calls this only in the tmux-specific path. It uses `split_term_program_and_version`, `terminal_name_from_term_program`, and `TerminalInfo::from_term_program_and_term` to create the richer result.

*Call graph*: calls 3 internal fn (from_term_program_and_term, split_term_program_and_version, terminal_name_from_term_program); called by 1 (detect_terminal_info_from_env).


##### `tmux_version_from_env`  (lines 437–444)

```
fn tmux_version_from_env(env: &dyn Environment) -> Option<String>
```

**Purpose**: Extracts the tmux version from environment variables when the environment clearly says `TERM_PROGRAM=tmux`. This avoids misusing a version value that might belong to another terminal.

**Data flow**: It reads `TERM_PROGRAM`; if that is missing or not tmux, it returns nothing. If it is tmux, it reads non-empty `TERM_PROGRAM_VERSION` and returns that as the tmux version if present.

**Call relations**: `detect_multiplexer` calls this after seeing tmux marker variables. It uses `is_tmux_term_program` as a guard before trusting `TERM_PROGRAM_VERSION`.

*Call graph*: calls 1 internal fn (is_tmux_term_program); called by 1 (detect_multiplexer); 2 external calls (var, var_non_empty).


##### `split_term_program_and_version`  (lines 446–451)

```
fn split_term_program_and_version(value: &str) -> (String, Option<String>)
```

**Purpose**: Splits a tmux client terminal type string into a program name and optional version. For example, a value like `ghostty 1.2.3` becomes program `ghostty` and version `1.2.3`.

**Data flow**: It receives one string and separates it on whitespace. The first word becomes the program name, the second word becomes the optional version, and any later words are ignored.

**Call relations**: `terminal_from_tmux_client_info` calls this when tmux provides a client terminal type. The split result is then mapped to a terminal category and stored in `TerminalInfo`.

*Call graph*: called by 1 (terminal_from_tmux_client_info).


##### `tmux_client_info`  (lines 453–458)

```
fn tmux_client_info() -> TmuxClientInfo
```

**Purpose**: Asks tmux for the current client terminal type and client `TERM` name. This gathers the clues needed to see through tmux to the underlying terminal.

**Data flow**: It runs two tmux display-message queries: one for `client_termtype` and one for `client_termname`. It returns a `TmuxClientInfo` containing whichever answers were available.

**Call relations**: `ProcessEnvironment::tmux_client_info` calls this for real process detection. It delegates each individual tmux query to `tmux_display_message`.

*Call graph*: calls 1 internal fn (tmux_display_message); called by 1 (tmux_client_info).


##### `tmux_display_message`  (lines 460–472)

```
fn tmux_display_message(format: &str) -> Option<String>
```

**Purpose**: Runs one `tmux display-message` query and returns its text result. It is a best-effort helper, so failures simply produce no value.

**Data flow**: It receives a tmux format string, starts the `tmux` command with `display-message -p`, and checks whether the command succeeded. It converts stdout from bytes to UTF-8 text, trims it, discards blank results, and returns the cleaned string if all steps work.

**Call relations**: `tmux_client_info` calls this twice to gather tmux client details. It uses `none_if_whitespace` to avoid treating empty command output as useful data.

*Call graph*: calls 1 internal fn (none_if_whitespace); called by 1 (tmux_client_info); 2 external calls (from_utf8, new).


##### `zellij_version_from_command`  (lines 474–487)

```
fn zellij_version_from_command() -> Option<String>
```

**Purpose**: Tries to get the Zellij version by running `zellij --version`. This is a fallback for when the environment variable is not available.

**Data flow**: It starts the `zellij --version` command, returns nothing if the command cannot run or fails, converts stdout to text, trims it, and parses the version. The parsed version is returned if available.

**Call relations**: `ProcessEnvironment::zellij_version` uses this after checking `ZELLIJ_VERSION`. It hands command output to `parse_zellij_version` so different output shapes can be handled.

*Call graph*: calls 1 internal fn (parse_zellij_version); 2 external calls (from_utf8, new).


##### `parse_zellij_version`  (lines 489–498)

```
fn parse_zellij_version(value: &str) -> Option<String>
```

**Purpose**: Extracts a useful version string from Zellij version command output. It supports the common form `zellij 0.x.y` but also keeps unexpected non-empty output instead of throwing it away.

**Data flow**: It receives command output text, discards it if blank, then splits it into words. If the first word is `zellij` and there is a second word, it returns the second word as the version. Otherwise it returns the whole non-empty string.

**Call relations**: `zellij_version_from_command` calls this after reading command output. It uses `none_if_whitespace` to reject blank output.

*Call graph*: calls 1 internal fn (none_if_whitespace); called by 1 (zellij_version_from_command).


##### `sanitize_header_value`  (lines 503–505)

```
fn sanitize_header_value(value: String) -> String
```

**Purpose**: Cleans a terminal token so it is safe to place in a User-Agent header. Unsafe characters are replaced rather than causing invalid header text.

**Data flow**: It receives a string and checks every character. Characters allowed by `is_valid_header_value_char` are kept; all others are replaced with underscores. The cleaned string is returned.

**Call relations**: `TerminalInfo::user_agent_token` calls this as the final step before returning a User-Agent token.

*Call graph*: called by 1 (user_agent_token).


##### `is_valid_header_value_char`  (lines 508–510)

```
fn is_valid_header_value_char(c: char) -> bool
```

**Purpose**: Defines which characters are allowed in this file’s User-Agent terminal token. The allowed set is intentionally simple: letters, numbers, dash, underscore, dot, and slash.

**Data flow**: It receives one character. It returns `true` if the character is ASCII alphanumeric or one of the allowed punctuation characters, otherwise `false`.

**Call relations**: `sanitize_header_value` uses this rule while cleaning a complete token. Keeping the rule separate makes the sanitizing behavior clear and easy to test.


##### `terminal_name_from_term_program`  (lines 512–536)

```
fn terminal_name_from_term_program(value: &str) -> Option<TerminalName>
```

**Purpose**: Maps a raw terminal program name to one of the known terminal categories. It accepts small spelling differences, such as spaces, dashes, underscores, dots, and capitalization.

**Data flow**: It receives a program name string, trims it, removes separators, lowercases it, and compares the normalized result with known terminal names. It returns the matching `TerminalName` if recognized, otherwise nothing.

**Call relations**: `detect_terminal_info_from_env` uses this for ordinary `TERM_PROGRAM` values. `terminal_from_tmux_client_info` uses it for program names reported by tmux.

*Call graph*: called by 2 (detect_terminal_info_from_env, terminal_from_tmux_client_info).


##### `format_terminal_version`  (lines 538–543)

```
fn format_terminal_version(name: &str, version: &Option<String>) -> String
```

**Purpose**: Formats a terminal name with an optional version in the standard `name/version` shape. If there is no useful version, it returns just the name.

**Data flow**: It receives a display name and an optional version string. If the version exists and is not empty, it joins them with a slash; otherwise it returns the display name alone.

**Call relations**: `TerminalInfo::user_agent_token` calls this for terminal categories that do not already have a raw `TERM_PROGRAM` or `TERM` string to use.

*Call graph*: called by 1 (user_agent_token); 1 external calls (format!).


##### `none_if_whitespace`  (lines 545–547)

```
fn none_if_whitespace(value: String) -> Option<String>
```

**Purpose**: Turns blank or all-whitespace strings into `None`. This keeps empty clues from being mistaken for real terminal information.

**Data flow**: It receives a string. If trimming the string leaves no characters, it returns nothing; otherwise it returns the original string unchanged.

**Call relations**: `tmux_display_message` uses this for command output, and `parse_zellij_version` uses it for version output. Environment helper methods use the same idea through their own calls to this function.

*Call graph*: called by 2 (parse_zellij_version, tmux_display_message).


### `tui/src/clipboard_copy.rs`

`io_transport` · `active when the user invokes copy, such as `/copy` or `Ctrl+O``

Copying text sounds simple, but terminal apps run in many awkward places. If the app is on a remote SSH machine, the “system clipboard” may belong to the remote server, not the laptop in front of the user. If it is inside tmux, clipboard data may need to pass through tmux first. On Linux, some clipboards only keep the copied text while the program that wrote it is still alive. This file chooses the right path for those cases.

The main public action is `copy_to_clipboard`. It first reads the environment to see whether the session is SSH, WSL, or tmux. Over SSH it avoids the native clipboard and uses terminal-based copying instead, preferring tmux when available and otherwise using OSC 52, a terminal escape sequence that asks the terminal emulator to copy text. Locally it tries `arboard`, a native clipboard library, first. If that fails on WSL, it tries Windows PowerShell’s `Set-Clipboard`. If that also fails, it falls back to terminal copying.

A small but important detail is `ClipboardLease`. On Linux, copied text may disappear if the clipboard owner is dropped too soon, so this lease keeps the clipboard connection alive for the life of the TUI. The file also includes tests that check the fallback order and error messages without touching the real clipboard.

#### Function details

##### `copy_to_clipboard`  (lines 40–53)

```
fn copy_to_clipboard(text: &str) -> Result<Option<ClipboardLease>, String>
```

**Purpose**: Copies the given text using the best available clipboard route for the current environment. This is the normal entry point used by the TUI when the user asks to copy something.

**Data flow**: It receives text → checks environment variables to learn whether the app is in SSH, WSL, or tmux → passes the text, environment facts, and real clipboard backends into the core copy function → returns success with an optional `ClipboardLease`, or a user-facing error string.

**Call relations**: This function is the real-world wrapper around `copy_to_clipboard_with`. It gathers facts using `is_ssh_session`, `is_wsl_session`, and `is_tmux_session`, then hands off to the core logic with the actual tmux, OSC 52, native clipboard, and WSL clipboard functions.

*Call graph*: calls 4 internal fn (copy_to_clipboard_with, is_ssh_session, is_tmux_session, is_wsl_session).


##### `ClipboardLease::native_linux`  (lines 70–74)

```
fn native_linux(clipboard: arboard::Clipboard) -> Self
```

**Purpose**: Wraps a Linux native clipboard connection so it stays alive after text is copied. This matters because some Linux clipboard systems ask the original writer process to keep serving the copied text.

**Data flow**: It receives an `arboard::Clipboard` object → stores it inside a `ClipboardLease` → returns that lease so the caller can keep it for as long as the TUI is running.

**Call relations**: The Linux version of `arboard_copy` calls this after successfully writing text. The lease is then returned up the copy flow so the UI can keep the clipboard contents available.

*Call graph*: called by 1 (arboard_copy).


##### `ClipboardLease::test`  (lines 77–82)

```
fn test() -> Self
```

**Purpose**: Creates a harmless fake clipboard lease for unit tests. Tests use it when they need to simulate a successful native clipboard copy without opening a real clipboard.

**Data flow**: It takes no input → builds an empty or inert lease appropriate for the platform → returns it to test code.

**Call relations**: The test functions use this helper inside fake clipboard backends passed to `copy_to_clipboard_with`. It keeps the tests focused on decision-making rather than real operating-system clipboard behavior.


##### `copy_to_clipboard_with`  (lines 94–175)

```
fn copy_to_clipboard_with(
    text: &str,
    environment: CopyEnvironment,
    tmux_copy_fn: impl Fn(&str) -> Result<(), String>,
    osc52_copy_fn: impl Fn(&str) -> Result<(), String>,
    arboard_
```

**Purpose**: Contains the main decision tree for copying text. It chooses between SSH-safe terminal copying, native clipboard copying, WSL PowerShell, tmux, and OSC 52 fallback.

**Data flow**: It receives text, an environment summary, and four copy functions → tries them in the correct order for that environment → logs warnings when a preferred route fails → returns either an optional clipboard lease or a combined error message explaining what failed.

**Call relations**: The public `copy_to_clipboard` calls this with real backends, while many tests call it with fake backends. When terminal-based copying is needed, it delegates to `terminal_clipboard_copy_with` so tmux and OSC 52 fallback behavior stays in one place.

*Call graph*: calls 1 internal fn (terminal_clipboard_copy_with); called by 13 (copy_to_clipboard, local_non_wsl_falls_back_to_osc52_when_native_fails, local_reports_both_errors_when_native_and_osc52_fail, local_tmux_fallback_prefers_tmux_when_native_fails, local_uses_native_clipboard_first, local_wsl_falls_back_to_osc52_when_native_and_powershell_fail, local_wsl_native_failure_uses_powershell_and_skips_osc52_on_success, local_wsl_reports_native_powershell_and_osc52_errors_when_all_fail, ssh_inside_tmux_falls_back_to_osc52_when_tmux_copy_fails, ssh_inside_tmux_prefers_tmux_clipboard (+3 more)); 1 external calls (warn!).


##### `terminal_clipboard_copy_with`  (lines 178–197)

```
fn terminal_clipboard_copy_with(
    text: &str,
    tmux_session: bool,
    tmux_copy_fn: &impl Fn(&str) -> Result<(), String>,
    osc52_copy_fn: &impl Fn(&str) -> Result<(), String>,
) -> Result<()
```

**Purpose**: Copies text through the terminal instead of through the operating system clipboard. It prefers tmux when the app is inside tmux, and falls back to OSC 52 if tmux copy fails.

**Data flow**: It receives text, a flag saying whether tmux is active, and two copy functions → if tmux is active, tries tmux first → if tmux fails or is not active, tries OSC 52 → returns success or an error that preserves both failure reasons when needed.

**Call relations**: `copy_to_clipboard_with` calls this whenever terminal-mediated copy is the right path, especially over SSH or after native clipboard failures. It hands off the actual work to the provided tmux and OSC 52 functions.

*Call graph*: called by 1 (copy_to_clipboard_with); 1 external calls (warn!).


##### `is_ssh_session`  (lines 200–202)

```
fn is_ssh_session() -> bool
```

**Purpose**: Detects whether the app appears to be running inside an SSH login. This prevents copying to the remote machine’s clipboard when the user expects their local clipboard.

**Data flow**: It reads SSH-related environment variables → checks whether either is present → returns `true` for an SSH session or `false` otherwise.

**Call relations**: `copy_to_clipboard` calls this during setup for the copy decision. Its result strongly changes the path because SSH sessions skip native clipboard copying.

*Call graph*: called by 1 (copy_to_clipboard); 1 external calls (var_os).


##### `is_tmux_session`  (lines 205–207)

```
fn is_tmux_session() -> bool
```

**Purpose**: Detects whether the app appears to be running inside tmux, a terminal multiplexer that can sit between the app and the real terminal. This lets the copy code use tmux’s clipboard bridge when available.

**Data flow**: It reads tmux-related environment variables → checks whether either is present → returns `true` if tmux seems active.

**Call relations**: `copy_to_clipboard` calls this before entering the main copy decision. The result tells `copy_to_clipboard_with` and `terminal_clipboard_copy_with` whether to try tmux before OSC 52.

*Call graph*: called by 1 (copy_to_clipboard); 1 external calls (var_os).


##### `is_wsl_session`  (lines 215–217)

```
fn is_wsl_session() -> bool
```

**Purpose**: Detects whether the app is running in WSL, the Windows Subsystem for Linux. This matters because the useful clipboard is usually the Windows clipboard, not a Linux clipboard inside WSL.

**Data flow**: On Linux, it asks the paste-side WSL detector whether this looks like WSL; on other platforms it reports false → returns a simple yes/no value.

**Call relations**: `copy_to_clipboard` uses this fact when building the environment summary. If native clipboard copy fails and this is WSL, `copy_to_clipboard_with` tries the PowerShell clipboard fallback next.

*Call graph*: calls 1 internal fn (is_probably_wsl); called by 1 (copy_to_clipboard).


##### `arboard_copy`  (lines 258–260)

```
fn arboard_copy(_text: &str) -> Result<Option<ClipboardLease>, String>
```

**Purpose**: Copies text using the platform’s native clipboard through the `arboard` library. On Linux, it may also return a lease that keeps the clipboard contents alive.

**Data flow**: It receives text → creates a native clipboard connection, with stderr suppressed where needed so stray system messages do not corrupt the TUI → writes the text → returns either no lease, a Linux lease, or an error explaining why the native clipboard was unavailable.

**Call relations**: `copy_to_clipboard` passes this function into `copy_to_clipboard_with` as the first local copy attempt. On Linux it calls `ClipboardLease::native_linux` after a successful write.

*Call graph*: calls 2 internal fn (native_linux, new); 1 external calls (new).


##### `wsl_clipboard_copy`  (lines 309–311)

```
fn wsl_clipboard_copy(_text: &str) -> Result<(), String>
```

**Purpose**: Copies text from a Linux process running under WSL into the Windows clipboard. It does this by sending the text to PowerShell’s `Set-Clipboard` command.

**Data flow**: It receives text → starts `powershell.exe` with standard input open → writes the text into that input → waits for PowerShell to finish → returns success, or an error including process startup, write, wait, exit status, or stderr details.

**Call relations**: `copy_to_clipboard` passes this into the core copy logic. `copy_to_clipboard_with` only tries it after native clipboard copy fails in a WSL session, before falling back to terminal copying.

*Call graph*: 5 external calls (from_utf8_lossy, new, format!, null, piped).


##### `tmux_clipboard_copy`  (lines 318–361)

```
fn tmux_clipboard_copy(text: &str) -> Result<(), String>
```

**Purpose**: Copies text through tmux’s clipboard integration. This is useful when tmux is between the app and the user’s terminal clipboard.

**Data flow**: It receives text → first checks that tmux is configured to forward clipboard writes → starts `tmux load-buffer -w -` → writes the text to tmux’s input → waits for tmux to finish → returns success or a clear error.

**Call relations**: `copy_to_clipboard` passes this backend into `copy_to_clipboard_with`, and `terminal_clipboard_copy_with` uses it before OSC 52 when tmux is active. It calls `tmux_clipboard_copy_ready` before attempting the actual copy.

*Call graph*: calls 1 internal fn (tmux_clipboard_copy_ready); 5 external calls (from_utf8_lossy, new, format!, null, piped).


##### `tmux_clipboard_copy_ready`  (lines 364–379)

```
fn tmux_clipboard_copy_ready(
    set_clipboard_fn: impl FnOnce() -> Result<String, String>,
    tmux_info_fn: impl FnOnce() -> Result<String, String>,
) -> Result<(), String>
```

**Purpose**: Checks whether tmux is able and allowed to forward copied text to the outer terminal clipboard. It avoids claiming success when tmux is configured in a way that cannot actually copy out.

**Data flow**: It receives two small query functions → reads tmux’s `set-clipboard` setting → rejects the copy if forwarding is disabled → reads tmux capability information → rejects the copy if the required clipboard capability is missing → otherwise returns success.

**Call relations**: `tmux_clipboard_copy` calls this before writing text to tmux. Several tests call it directly with fake tmux outputs to verify accepted and rejected configurations.

*Call graph*: called by 4 (tmux_clipboard_copy_ready_accepts_forwarding_configuration, tmux_clipboard_copy_ready_rejects_disabled_forwarding, tmux_clipboard_copy_ready_rejects_missing_ms_capability, tmux_clipboard_copy).


##### `tmux_command_output`  (lines 381–398)

```
fn tmux_command_output(args: [&str; N]) -> Result<String, String>
```

**Purpose**: Runs a tmux command and returns its text output. It centralizes the common work of spawning tmux, reading stdout, and turning failures into readable messages.

**Data flow**: It receives an array of tmux command arguments → runs `tmux` with those arguments → if the command succeeds, converts stdout from UTF-8 bytes into a string → if it fails, returns stderr or the exit status as an error.

**Call relations**: `tmux_clipboard_copy` uses this indirectly through closures passed into `tmux_clipboard_copy_ready`. It is the small command-running helper behind the tmux readiness checks.

*Call graph*: 4 external calls (from_utf8, from_utf8_lossy, new, format!).


##### `SuppressStderr::drop`  (lines 437–444)

```
fn drop(&mut self)
```

**Purpose**: Restores stderr after it was temporarily redirected away from the terminal. This keeps the TUI display safe while still returning the process to normal afterward.

**Data flow**: When the guard is dropped → if a saved stderr file descriptor exists, it points stderr back to that saved descriptor → closes the saved descriptor → leaves stderr restored.

**Call relations**: The macOS `SuppressStderr::new` creates this guard, and `arboard_copy` holds it while initializing and using the native clipboard. Rust automatically calls `drop` when the guard goes out of scope.

*Call graph*: 2 external calls (close, dup2).


##### `SuppressStderr::new`  (lines 452–454)

```
fn new() -> Self
```

**Purpose**: Creates a guard that suppresses stderr while sensitive clipboard code runs. On macOS this prevents noisy system clipboard messages from being printed into the TUI screen.

**Data flow**: It starts with the current process stderr → on macOS, saves stderr, opens `/dev/null`, and redirects stderr there; on other platforms, it creates a no-op guard → returns the guard object.

**Call relations**: `arboard_copy` calls this before opening the native clipboard. On macOS, `SuppressStderr::drop` restores stderr when the guard is no longer needed.

*Call graph*: called by 1 (arboard_copy); 4 external calls (close, dup, dup2, open).


##### `osc52_copy`  (lines 458–476)

```
fn osc52_copy(text: &str) -> Result<(), String>
```

**Purpose**: Copies text by writing an OSC 52 terminal escape sequence. OSC 52 is a special message that many terminal emulators interpret as “put this text on the clipboard.”

**Data flow**: It receives text → builds an OSC 52 sequence, wrapping it for tmux if needed → on Unix, first tries to write directly to `/dev/tty` → if that fails, writes to stdout → returns success or a write/flush error.

**Call relations**: `copy_to_clipboard` passes this backend into the core copy flow. `terminal_clipboard_copy_with` uses it directly when not in tmux or as a fallback when tmux copy fails.

*Call graph*: calls 2 internal fn (osc52_sequence, write_osc52_to_writer); 4 external calls (var_os, new, stdout, debug!).


##### `write_osc52_to_writer`  (lines 478–485)

```
fn write_osc52_to_writer(mut writer: impl Write, sequence: &str) -> Result<(), String>
```

**Purpose**: Writes an already-built OSC 52 sequence to a destination and flushes it. It is separated out so the write behavior can be tested with an in-memory buffer.

**Data flow**: It receives a writable destination and a sequence string → writes all sequence bytes → flushes the destination so the terminal sees it immediately → returns success or an error from writing or flushing.

**Call relations**: `osc52_copy` calls this for `/dev/tty` or stdout. The test `tests::write_osc52_to_writer_emits_sequence_verbatim` calls it with a vector to confirm the exact bytes are written.

*Call graph*: called by 1 (osc52_copy); 2 external calls (flush, write_all).


##### `osc52_sequence`  (lines 487–501)

```
fn osc52_sequence(text: &str, tmux: bool) -> Result<String, String>
```

**Purpose**: Builds the actual OSC 52 escape sequence for a piece of text. It also refuses overly large payloads so the app does not overwhelm the terminal.

**Data flow**: It receives text and a flag saying whether tmux wrapping is needed → checks the raw byte size against the limit → base64-encodes the text → returns a normal OSC 52 sequence or a tmux-wrapped sequence.

**Call relations**: `osc52_copy` calls this before writing to the terminal. Tests call it directly to confirm encoding, size limits, and tmux wrapping.

*Call graph*: called by 2 (osc52_copy, osc52_encoding_roundtrips); 1 external calls (format!).


##### `tests::remote_environment`  (lines 515–521)

```
fn remote_environment() -> CopyEnvironment
```

**Purpose**: Builds a fake environment for tests where the app is running over SSH but not inside tmux. This lets tests check remote-copy behavior without changing real environment variables.

**Data flow**: It takes no input → creates a `CopyEnvironment` with SSH enabled, WSL enabled, and tmux disabled → returns that test environment.

**Call relations**: SSH-focused tests call this helper before calling `copy_to_clipboard_with` with fake copy backends.


##### `tests::remote_tmux_environment`  (lines 523–528)

```
fn remote_tmux_environment() -> CopyEnvironment
```

**Purpose**: Builds a fake test environment for an SSH session inside tmux. This checks the special case where terminal copying should try tmux first.

**Data flow**: It starts from the remote test environment → changes the tmux flag to true → returns the adjusted environment.

**Call relations**: Remote tmux tests use this helper before calling `copy_to_clipboard_with`, so they can verify tmux-first behavior and OSC 52 fallback.

*Call graph*: 1 external calls (remote_environment).


##### `tests::local_environment`  (lines 530–536)

```
fn local_environment() -> CopyEnvironment
```

**Purpose**: Builds a fake local environment for tests. This represents the common case where the app is not in SSH, WSL, or tmux.

**Data flow**: It takes no input → creates a `CopyEnvironment` with all three flags false → returns it.

**Call relations**: Local fallback tests use this helper when they want the core copy logic to try native clipboard first and then OSC 52 if native copy fails.


##### `tests::local_wsl_environment`  (lines 538–543)

```
fn local_wsl_environment() -> CopyEnvironment
```

**Purpose**: Builds a fake local WSL environment for tests. This lets tests confirm that PowerShell is tried after native clipboard failure.

**Data flow**: It starts from the local test environment → sets the WSL flag to true → returns the adjusted environment.

**Call relations**: WSL-specific tests call this helper before exercising `copy_to_clipboard_with` with fake native, PowerShell, and OSC 52 backends.

*Call graph*: 1 external calls (local_environment).


##### `tests::local_tmux_environment`  (lines 545–550)

```
fn local_tmux_environment() -> CopyEnvironment
```

**Purpose**: Builds a fake local tmux environment for tests. This checks what happens when local native copying fails while tmux is active.

**Data flow**: It starts from the local test environment → sets the tmux flag to true → returns the adjusted environment.

**Call relations**: The local tmux fallback test uses this helper before calling `copy_to_clipboard_with`.

*Call graph*: 1 external calls (local_environment).


##### `tests::osc52_encoding_roundtrips`  (lines 553–564)

```
fn osc52_encoding_roundtrips()
```

**Purpose**: Verifies that OSC 52 encoding preserves the original text. It protects against mistakes in base64 wrapping.

**Data flow**: It creates sample multi-line text → builds an OSC 52 sequence → extracts the encoded portion → decodes it → checks that the decoded bytes match the original text.

**Call relations**: The test runner calls this test. It directly exercises `osc52_sequence` rather than going through terminal output.

*Call graph*: calls 1 internal fn (osc52_sequence); 1 external calls (assert_eq!).


##### `tests::osc52_rejects_payload_larger_than_limit`  (lines 567–576)

```
fn osc52_rejects_payload_larger_than_limit()
```

**Purpose**: Checks that very large OSC 52 copies are rejected before encoding. This protects terminals from being flooded with huge escape sequences.

**Data flow**: It creates text one byte larger than the allowed limit → calls the OSC 52 sequence builder → expects the exact size-limit error.

**Call relations**: The test runner calls this test to enforce the payload guard used by `osc52_copy`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::osc52_wraps_tmux_passthrough`  (lines 579–584)

```
fn osc52_wraps_tmux_passthrough()
```

**Purpose**: Verifies that OSC 52 sequences are wrapped correctly when they must pass through tmux. Without the wrapper, tmux may swallow or alter the terminal escape sequence.

**Data flow**: It builds an OSC 52 sequence for `hello` with tmux mode enabled → compares the result with the expected tmux passthrough string.

**Call relations**: The test runner calls this test. It checks the tmux branch of `osc52_sequence`, which `osc52_copy` uses when tmux is present.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::write_osc52_to_writer_emits_sequence_verbatim`  (lines 587–592)

```
fn write_osc52_to_writer_emits_sequence_verbatim()
```

**Purpose**: Confirms that the OSC 52 writer does not change the escape sequence bytes. This is important because terminal escape sequences must be exact.

**Data flow**: It creates an in-memory byte vector → writes a known sequence into it using `write_osc52_to_writer` → checks that the stored bytes equal the original sequence.

**Call relations**: The test runner calls this test. It covers the helper used by `osc52_copy` for both `/dev/tty` and stdout writes.

*Call graph*: 2 external calls (new, assert_eq!).


##### `tests::ssh_uses_osc52_and_skips_native_on_success`  (lines 595–626)

```
fn ssh_uses_osc52_and_skips_native_on_success()
```

**Purpose**: Checks that an SSH session uses OSC 52 and does not touch native or WSL clipboards when OSC 52 succeeds. This prevents copying to the wrong machine.

**Data flow**: It creates fake backend functions that count calls → runs `copy_to_clipboard_with` in a remote environment → verifies OSC 52 was called once and native, WSL, and tmux were not used.

**Call relations**: The test runner calls this test. It exercises the SSH branch of `copy_to_clipboard_with` with controlled fake backends.

*Call graph*: calls 1 internal fn (copy_to_clipboard_with); 4 external calls (new, assert!, assert_eq!, remote_environment).


##### `tests::ssh_returns_osc52_error_and_skips_native`  (lines 629–663)

```
fn ssh_returns_osc52_error_and_skips_native()
```

**Purpose**: Checks the error path for an SSH session when OSC 52 fails. It also confirms native clipboard code is still skipped.

**Data flow**: It creates fake backends where OSC 52 returns an error → runs the core copy function in a remote environment → checks the returned error text and verifies only OSC 52 was called.

**Call relations**: The test runner calls this test. It verifies `copy_to_clipboard_with` reports SSH terminal-copy failure clearly.

*Call graph*: calls 1 internal fn (copy_to_clipboard_with); 4 external calls (new, assert_eq!, panic!, remote_environment).


##### `tests::ssh_inside_tmux_prefers_tmux_clipboard`  (lines 666–697)

```
fn ssh_inside_tmux_prefers_tmux_clipboard()
```

**Purpose**: Checks that SSH inside tmux uses tmux’s clipboard path before OSC 52. This matches the intended route when tmux can forward clipboard data.

**Data flow**: It sets up call counters and a remote-tmux environment → runs the core copy function → verifies tmux was called and OSC 52, native, and WSL were skipped.

**Call relations**: The test runner calls this test. It verifies the interaction between `copy_to_clipboard_with` and `terminal_clipboard_copy_with`.

*Call graph*: calls 1 internal fn (copy_to_clipboard_with); 4 external calls (new, assert!, assert_eq!, remote_tmux_environment).


##### `tests::ssh_inside_tmux_falls_back_to_osc52_when_tmux_copy_fails`  (lines 700–731)

```
fn ssh_inside_tmux_falls_back_to_osc52_when_tmux_copy_fails()
```

**Purpose**: Checks that OSC 52 is tried if tmux clipboard copy fails during an SSH tmux session. This gives the user a second chance to copy successfully.

**Data flow**: It uses a fake tmux backend that fails and a fake OSC 52 backend that succeeds → runs the core copy function → checks that both were called and the overall result is success.

**Call relations**: The test runner calls this test. It covers the fallback path inside `terminal_clipboard_copy_with`.

*Call graph*: calls 1 internal fn (copy_to_clipboard_with); 4 external calls (new, assert!, assert_eq!, remote_tmux_environment).


##### `tests::ssh_inside_tmux_reports_tmux_and_osc52_errors_when_both_fail`  (lines 734–751)

```
fn ssh_inside_tmux_reports_tmux_and_osc52_errors_when_both_fail()
```

**Purpose**: Checks that, when both tmux and OSC 52 fail over SSH, the user gets an error containing both causes. This makes troubleshooting easier.

**Data flow**: It runs the core copy function with fake tmux and OSC 52 backends that both fail → receives an error → compares it with the expected combined message.

**Call relations**: The test runner calls this test. It verifies error composition in `copy_to_clipboard_with` after `terminal_clipboard_copy_with` reports failure.

*Call graph*: calls 1 internal fn (copy_to_clipboard_with); 3 external calls (assert_eq!, panic!, remote_tmux_environment).


##### `tests::tmux_clipboard_copy_ready_accepts_forwarding_configuration`  (lines 754–761)

```
fn tmux_clipboard_copy_ready_accepts_forwarding_configuration()
```

**Purpose**: Checks that tmux readiness passes when forwarding is enabled and the needed clipboard capability is present.

**Data flow**: It passes fake tmux query functions returning a forwarding setting and valid capability information → calls `tmux_clipboard_copy_ready` → expects success.

**Call relations**: The test runner calls this test. It directly exercises the readiness check used before `tmux_clipboard_copy` writes text.

*Call graph*: calls 1 internal fn (tmux_clipboard_copy_ready); 1 external calls (assert_eq!).


##### `tests::tmux_clipboard_copy_ready_rejects_disabled_forwarding`  (lines 764–774)

```
fn tmux_clipboard_copy_ready_rejects_disabled_forwarding()
```

**Purpose**: Checks that tmux readiness fails when clipboard forwarding is disabled. In that case, writing to tmux would not reach the user’s clipboard.

**Data flow**: It passes a fake setting query that returns `off` → calls `tmux_clipboard_copy_ready` → expects the disabled-forwarding error and does not need the info query.

**Call relations**: The test runner calls this test. It protects the early rejection branch of the tmux readiness check.

*Call graph*: calls 1 internal fn (tmux_clipboard_copy_ready); 1 external calls (assert_eq!).


##### `tests::tmux_clipboard_copy_ready_rejects_missing_ms_capability`  (lines 777–787)

```
fn tmux_clipboard_copy_ready_rejects_missing_ms_capability()
```

**Purpose**: Checks that tmux readiness fails when the terminal clipboard capability is missing. The `Ms` capability is the tmux/terminal feature used for clipboard forwarding.

**Data flow**: It passes fake tmux outputs where forwarding is enabled but `Ms` is marked missing → calls `tmux_clipboard_copy_ready` → expects the missing-capability error.

**Call relations**: The test runner calls this test. It covers the second rejection branch used by `tmux_clipboard_copy`.

*Call graph*: calls 1 internal fn (tmux_clipboard_copy_ready); 1 external calls (assert_eq!).


##### `tests::local_uses_native_clipboard_first`  (lines 790–816)

```
fn local_uses_native_clipboard_first()
```

**Purpose**: Checks that local copying tries the native clipboard first, even in a WSL-like test environment. If native copy works, no fallback should run.

**Data flow**: It creates fake backends where native copy succeeds and returns a test lease → runs the core copy function → verifies the native backend was called and WSL/OSC 52 were skipped.

**Call relations**: The test runner calls this test. It confirms the preferred local path in `copy_to_clipboard_with`.

*Call graph*: calls 1 internal fn (copy_to_clipboard_with); 4 external calls (new, assert!, assert_eq!, local_wsl_environment).


##### `tests::local_non_wsl_falls_back_to_osc52_when_native_fails`  (lines 819–845)

```
fn local_non_wsl_falls_back_to_osc52_when_native_fails()
```

**Purpose**: Checks that a normal local session falls back to OSC 52 if native clipboard copy fails. This gives non-WSL users a terminal-based backup.

**Data flow**: It sets native copy to fail and OSC 52 to succeed → runs the core copy function in a local environment → verifies native and OSC 52 were called, while WSL was not.

**Call relations**: The test runner calls this test. It covers the non-WSL fallback branch of `copy_to_clipboard_with`.

*Call graph*: calls 1 internal fn (copy_to_clipboard_with); 4 external calls (new, assert!, assert_eq!, local_environment).


##### `tests::local_tmux_fallback_prefers_tmux_when_native_fails`  (lines 848–879)

```
fn local_tmux_fallback_prefers_tmux_when_native_fails()
```

**Purpose**: Checks that, in a local tmux session, terminal fallback tries tmux before OSC 52 after native clipboard failure.

**Data flow**: It creates a local-tmux environment with native copy failing and tmux copy succeeding → runs the core copy function → verifies tmux was used and OSC 52 was not.

**Call relations**: The test runner calls this test. It verifies that local fallback still respects the tmux-first rule through `terminal_clipboard_copy_with`.

*Call graph*: calls 1 internal fn (copy_to_clipboard_with); 4 external calls (new, assert!, assert_eq!, local_tmux_environment).


##### `tests::local_wsl_native_failure_uses_powershell_and_skips_osc52_on_success`  (lines 882–908)

```
fn local_wsl_native_failure_uses_powershell_and_skips_osc52_on_success()
```

**Purpose**: Checks that WSL uses PowerShell as the next fallback when native clipboard copy fails. If PowerShell succeeds, OSC 52 should not be needed.

**Data flow**: It uses a WSL environment with native failure and WSL PowerShell success → runs the core copy function → verifies native and WSL were called, while OSC 52 was skipped.

**Call relations**: The test runner calls this test. It protects the WSL-specific fallback order in `copy_to_clipboard_with`.

*Call graph*: calls 1 internal fn (copy_to_clipboard_with); 4 external calls (new, assert!, assert_eq!, local_wsl_environment).


##### `tests::local_wsl_falls_back_to_osc52_when_native_and_powershell_fail`  (lines 911–937)

```
fn local_wsl_falls_back_to_osc52_when_native_and_powershell_fail()
```

**Purpose**: Checks that WSL still has a final terminal-copy fallback if both native clipboard and PowerShell fail.

**Data flow**: It sets native and WSL fake backends to fail and OSC 52 to succeed → runs the core copy function → verifies all three were tried in order and the final result is success.

**Call relations**: The test runner calls this test. It covers the deepest successful fallback path in the WSL branch.

*Call graph*: calls 1 internal fn (copy_to_clipboard_with); 4 external calls (new, assert!, assert_eq!, local_wsl_environment).


##### `tests::local_reports_both_errors_when_native_and_osc52_fail`  (lines 940–972)

```
fn local_reports_both_errors_when_native_and_osc52_fail()
```

**Purpose**: Checks that a local non-WSL failure reports both the native clipboard error and the OSC 52 fallback error. This avoids hiding the original cause.

**Data flow**: It makes native and OSC 52 fake backends fail → runs the core copy function locally → receives an error → checks that the message includes both failures and that WSL was not called.

**Call relations**: The test runner calls this test. It verifies error reporting in the non-WSL local fallback path.

*Call graph*: calls 1 internal fn (copy_to_clipboard_with); 4 external calls (new, assert_eq!, panic!, local_environment).


##### `tests::local_wsl_reports_native_powershell_and_osc52_errors_when_all_fail`  (lines 975–1007)

```
fn local_wsl_reports_native_powershell_and_osc52_errors_when_all_fail()
```

**Purpose**: Checks that, in WSL, a total copy failure reports all three failed routes: native clipboard, PowerShell, and OSC 52. This gives the user the full picture.

**Data flow**: It makes native, WSL PowerShell, and OSC 52 fake backends all fail → runs the core copy function in a WSL environment → checks the combined error message and call counts.

**Call relations**: The test runner calls this test. It verifies the final error path in `copy_to_clipboard_with` for WSL sessions.

*Call graph*: calls 1 internal fn (copy_to_clipboard_with); 4 external calls (new, assert_eq!, panic!, local_wsl_environment).


### `tui/src/terminal_palette.rs`

`domain_logic` · `cross-cutting`

Terminals do not all understand color in the same way. Some can show exact red-green-blue colors, some can only show a fixed set of 256 colors, and some report only basic color support. This file acts like a translator between the UI's desired colors and the terminal's real abilities.

First, it asks what color level standard output supports. Then it applies a small correction for Windows Terminal, because some environments report weaker color support than they really have. If full color is available, the file returns the exact color. If only 256-color mode is available, it searches the stable part of the Xterm 256-color palette and picks the closest visible match using a perceptual distance calculation, which is meant to match what human eyes notice. If color support is too limited or unknown, it falls back to the terminal default instead of forcing a poor-looking color.

The file also caches the terminal's default foreground and background colors. That cache prevents repeated terminal queries, which can be slow or interfere with input. On Unix it can re-query those defaults after focus events; on Windows the refresh path is currently a no-op. Without this file, the UI would either use colors that look wrong in many terminals or repeatedly ask the terminal for information at awkward times.

#### Function details

##### `stdout_color_level`  (lines 14–21)

```
fn stdout_color_level() -> StdoutColorLevel
```

**Purpose**: Figures out how much color the current standard output stream says it supports. The result tells the rest of the UI whether it can use exact colors, 256-color approximations, basic colors, or should treat color support as unknown.

**Data flow**: It reads the cached color-support report for standard output. If that report says 16 million colors are supported, it returns TrueColor; if it says 256 colors are supported, it returns Ansi256; if it reports only basic color, it returns Ansi16; if there is no report, it returns Unknown.

**Call relations**: Other style-building code asks this when it needs to know the terminal's raw color capability. Inside this file, effective_stdout_color_level calls it before applying terminal-specific corrections.

*Call graph*: called by 4 (current, diff_color_level, table_separator_style, effective_stdout_color_level); 1 external calls (on_cached).


##### `rgb_color`  (lines 24–26)

```
fn rgb_color((r, g, b): (u8, u8, u8)) -> Color
```

**Purpose**: Wraps an exact red-green-blue color in the color type used by the terminal UI library. It is the direct path used when the terminal can display true color.

**Data flow**: It receives three byte-sized numbers for red, green, and blue. It turns those numbers into a UI Color value and returns it without changing them.

**Call relations**: Color-building code throughout the UI calls this when it already knows an exact color should be used. best_color_for_color_level also calls it when true-color output is available.

*Call graph*: called by 10 (truecolor_palette_blends_empty_cell_for_light_background, truecolor_palette_blends_theme_accent_against_dark_background, add_line_bg, color_from_rgb_for_level, del_line_bg, light_add_num_bg, light_del_num_bg, light_gutter_fg, table_separator_style_for, best_color_for_color_level); 1 external calls (Rgb).


##### `indexed_color`  (lines 29–31)

```
fn indexed_color(index: u8) -> Color
```

**Purpose**: Wraps a numbered terminal palette color in the color type used by the UI. This is useful for 256-color terminals, where colors are addressed by palette number instead of exact red-green-blue values.

**Data flow**: It receives a palette index from 0 to 255. It returns a UI Color value that tells the terminal to use that numbered palette entry.

**Call relations**: Diff and theme code call this when they already want a known indexed color. best_color_for_color_level uses it after choosing the closest Xterm palette entry.

*Call graph*: called by 6 (add_line_bg, del_line_bg, light_add_num_bg, light_del_num_bg, light_gutter_fg, quantize_rgb_to_ansi256); 1 external calls (Indexed).


##### `best_color`  (lines 34–36)

```
fn best_color(target: (u8, u8, u8)) -> Color
```

**Purpose**: Chooses the best displayable version of a desired color for the current terminal. Callers use it when they want a nice color but do not want to know the terminal details themselves.

**Data flow**: It receives a desired red-green-blue color. It asks for the effective color level of the current terminal, then passes both pieces of information to the shared color-picking function and returns the resulting UI Color.

**Call relations**: Higher-level style code calls this while building backgrounds, accents, separators, and message colors. It delegates the environment check to effective_stdout_color_level and the actual color choice to best_color_for_color_level.

*Call graph*: calls 2 internal fn (best_color_for_color_level, effective_stdout_color_level); called by 5 (dense_row_background_style, transcript_loading_overlay_style, accent_style_for, table_separator_style_for, user_message_bg).


##### `best_color_for_level`  (lines 39–41)

```
fn best_color_for_level(target: (u8, u8, u8), color_level: StdoutColorLevel) -> Color
```

**Purpose**: Chooses the best displayable version of a desired color when the caller already knows the terminal's color level. This is useful for code that is constructing a palette from known conditions rather than probing the live terminal.

**Data flow**: It receives a desired red-green-blue color and a color capability value. It forwards both to the shared color-picking function and returns the UI Color that should be used.

**Call relations**: Palette construction code calls this when it has already decided what color level to target. It avoids repeating the live terminal detection used by best_color.

*Call graph*: calls 1 internal fn (best_color_for_color_level); called by 1 (from_parts).


##### `effective_stdout_color_level`  (lines 43–50)

```
fn effective_stdout_color_level() -> StdoutColorLevel
```

**Purpose**: Gets the terminal's usable color level after applying environment-specific fixes. This matters because some terminals, especially Windows Terminal, may be capable of true color even when basic detection says otherwise.

**Data flow**: It reads the reported standard-output color level, the detected terminal name, and two environment variables: WT_SESSION and FORCE_COLOR. It combines those facts and returns the corrected color level.

**Call relations**: best_color calls this before choosing a color. It hands the raw facts to stdout_color_level_for_terminal, which contains the correction rules.

*Call graph*: calls 2 internal fn (stdout_color_level, stdout_color_level_for_terminal); called by 1 (best_color); 2 external calls (terminal_info, var_os).


##### `stdout_color_level_for_terminal`  (lines 52–70)

```
fn stdout_color_level_for_terminal(
    stdout_level: StdoutColorLevel,
    terminal_name: TerminalName,
    has_wt_session: bool,
    has_force_color_override: bool,
) -> StdoutColorLevel
```

**Purpose**: Applies special rules to the raw color-support result for known terminal cases. Its main job is to avoid needlessly downgrading Windows Terminal to basic colors.

**Data flow**: It receives the reported color level, the terminal name, and two yes/no flags saying whether WT_SESSION and FORCE_COLOR are present. If Windows Terminal is detected without a force-color override, it may return TrueColor; otherwise it returns the reported level.

**Call relations**: effective_stdout_color_level calls this after collecting environment information. The tests in this file exercise its Windows Terminal and FORCE_COLOR behavior.

*Call graph*: called by 1 (effective_stdout_color_level).


##### `best_color_for_color_level`  (lines 72–84)

```
fn best_color_for_color_level(target: (u8, u8, u8), color_level: StdoutColorLevel) -> Color
```

**Purpose**: Performs the actual decision about how to represent a desired color for a given color capability. It is the central color translation rule in this file.

**Data flow**: It receives a target red-green-blue color and a color level. For TrueColor it returns the exact RGB color. For Ansi256 it scans the stable Xterm palette, finds the closest color by human-perception distance, and returns that palette index. For Ansi16 or Unknown it returns the default reset color.

**Call relations**: Both public color-picking functions call this. It uses xterm_fixed_colors for the 256-color search and rgb_color or indexed_color to produce the final UI color.

*Call graph*: calls 2 internal fn (rgb_color, xterm_fixed_colors); called by 2 (best_color, best_color_for_level); 1 external calls (default).


##### `requery_default_colors`  (lines 86–88)

```
fn requery_default_colors()
```

**Purpose**: Asks the platform-specific code to refresh the cached default terminal foreground and background colors. This is useful when the terminal theme may have changed while the app is running.

**Data flow**: It takes no input. It forwards the request to the implementation module, which may update the stored default colors or do nothing depending on the platform.

**Call relations**: This is the public wrapper for the platform-specific requery function. Callers do not need to know whether they are running on Unix, Windows, or a platform where querying is unavailable.

*Call graph*: 1 external calls (requery_default_colors).


##### `default_colors`  (lines 96–98)

```
fn default_colors() -> Option<DefaultColors>
```

**Purpose**: Returns the terminal's default foreground and background colors if they are known. These defaults help the UI choose colors that fit the user's terminal theme.

**Data flow**: It takes no direct input. It asks the platform-specific implementation for the cached or newly queried default colors and returns either those colors or nothing.

**Call relations**: default_fg and default_bg call this to expose one color at a time. The actual cache and terminal query live in the imp module.

*Call graph*: called by 2 (default_bg, default_fg); 1 external calls (default_colors).


##### `default_fg`  (lines 100–102)

```
fn default_fg() -> Option<(u8, u8, u8)>
```

**Purpose**: Returns only the terminal's default foreground color, which is usually the normal text color. UI code can use it when it wants to match or contrast with ordinary terminal text.

**Data flow**: It asks default_colors for both default colors. If they are available, it extracts the foreground triple and returns it; otherwise it returns nothing.

**Call relations**: Theme and style code call this when deciding text and separator colors. It depends on default_colors so the cache is shared with background lookups.

*Call graph*: calls 1 internal fn (default_colors); called by 3 (current, shimmer_spans, table_separator_style).


##### `default_bg`  (lines 104–106)

```
fn default_bg() -> Option<(u8, u8, u8)>
```

**Purpose**: Returns only the terminal's default background color. This lets the UI adapt to light and dark terminal themes instead of assuming one.

**Data flow**: It asks default_colors for both default colors. If they are available, it extracts the background triple and returns it; otherwise it returns nothing.

**Call relations**: Many theme decisions call this, including adaptive theme choice and message styling. It shares the same underlying cache used by default_fg.

*Call graph*: calls 1 internal fn (default_colors); called by 15 (current, diff_theme, adaptive_default_theme_selection, conversation_assistant_style, conversation_user_style, dense_row_background_style, footer_hint_key_style, footer_hint_label_style, selected_session_style, transcript_loading_overlay_style (+5 more)).


##### `set_default_colors_from_startup_probe`  (lines 109–113)

```
fn set_default_colors_from_startup_probe(
    colors: Option<crate::terminal_probe::DefaultColors>,
)
```

**Purpose**: Stores default terminal colors that were discovered during startup. This avoids asking the terminal the same question again later.

**Data flow**: It receives optional startup-probed foreground and background colors. It passes them to the platform-specific cache, where they are converted into this file's DefaultColors type and marked as already attempted.

**Call relations**: Startup probing code can call this after it has already queried the terminal. Later calls to default_colors then reuse that result instead of probing again.

*Call graph*: 1 external calls (set_default_colors_from_startup_probe).


##### `imp::color_to_tuple`  (lines 209–214)

```
fn color_to_tuple(color: CrosstermColor) -> Option<(u8, u8, u8)>
```

**Purpose**: Converts a color returned by the terminal library into a simple red-green-blue tuple, but only when the color is actually an RGB color. It filters out other color forms that cannot be used as exact defaults.

**Data flow**: It receives a Crossterm color value. If that value contains red, green, and blue fields, it returns those three numbers; otherwise it returns nothing.

**Call relations**: The Unix refresh path uses this after asking Crossterm for foreground and background colors. It keeps the cache from storing non-RGB answers.


##### `imp::Cache::default`  (lines 229–234)

```
fn default() -> Self
```

**Purpose**: Creates an empty cache that has not tried to load a value yet. This lets the code distinguish between 'we have not asked' and 'we asked and there was no answer.'

**Data flow**: It takes no input. It returns a cache with attempted set to false and value set to none.

**Call relations**: default_colors_cache uses this when it first creates the shared cache. The rest of the implementation relies on the attempted flag to avoid repeated failed terminal queries.


##### `imp::Cache::get_or_init_with`  (lines 238–244)

```
fn get_or_init_with(&mut self, mut init: impl FnMut() -> Option<T>) -> Option<T>
```

**Purpose**: Returns the cached value, running a supplied lookup function only the first time. This prevents repeated terminal probing, especially after a failed attempt.

**Data flow**: It receives a mutable cache and a function that can try to produce a value. If no attempt has been made, it runs that function, stores the result, and marks the cache as attempted. It then returns the stored optional value.

**Call relations**: The platform-specific default_colors function uses this when callers ask for default colors. It is the small gatekeeper that turns an expensive or fragile terminal query into a one-time operation.


##### `imp::default_colors_cache`  (lines 247–250)

```
fn default_colors_cache() -> &'static Mutex<Cache<DefaultColors>>
```

**Purpose**: Provides the one shared cache used for terminal default colors. The cache is protected by a mutex, which is a lock that stops two tasks from changing the same data at the same time.

**Data flow**: It takes no input. On first use, it creates a locked cache; on later calls, it returns the same locked cache.

**Call relations**: The platform-specific default_colors, set_default_colors_from_startup_probe, and requery_default_colors functions all go through this shared cache so they agree on the current default-color state.

*Call graph*: 1 external calls (new).


##### `imp::query_default_colors`  (lines 272–280)

```
fn query_default_colors() -> Option<DefaultColors>
```

**Purpose**: Asks the terminal probe code for the terminal's default foreground and background colors. It treats errors and missing answers the same way: as no available default colors.

**Data flow**: It calls the startup-style terminal probe with a fixed timeout. If the probe succeeds and returns colors, it converts them into this file's DefaultColors type; otherwise it returns nothing.

**Call relations**: The cache calls this the first time default colors are requested and no startup result has already been stored. This keeps probing bounded so the UI does not hang waiting for a terminal response.

*Call graph*: calls 1 internal fn (default_colors).


##### `imp::default_colors`  (lines 287–289)

```
fn default_colors() -> Option<DefaultColors>
```

**Purpose**: Returns cached terminal default colors for the active platform implementation. If the cache has never been filled, it tries the default-color query once.

**Data flow**: It gets the shared cache, locks it, and asks the cache to initialize itself with query_default_colors if needed. It returns the stored colors or nothing if locking or querying fails.

**Call relations**: The public default_colors wrapper calls this. It is the bridge between outside style code and the platform-specific cache.

*Call graph*: 1 external calls (default_colors_cache).


##### `imp::set_default_colors_from_startup_probe`  (lines 292–295)

```
fn set_default_colors_from_startup_probe(
        _colors: Option<crate::terminal_probe::DefaultColors>,
    )
```

**Purpose**: Writes startup-probed default colors into the shared cache. This records that the default-color question has already been answered, even if the answer was unavailable.

**Data flow**: It receives optional colors from startup probing. If it can lock the cache, it stores converted foreground and background colors or stores none, then marks the cache as attempted.

**Call relations**: The public set_default_colors_from_startup_probe wrapper forwards startup results here. Later default_colors calls see this stored result and do not repeat the startup probe.

*Call graph*: 1 external calls (default_colors_cache).


##### `imp::requery_default_colors`  (lines 297–297)

```
fn requery_default_colors()
```

**Purpose**: Refreshes the cached default colors when the platform supports it. On Unix this asks Crossterm for the current foreground and background; on Windows this implementation is empty.

**Data flow**: It locks the shared cache. On Unix, if a previous query failed, it leaves the failure alone; otherwise it asks for the current foreground and background colors, converts RGB answers, stores both if present, and marks the cache as attempted. On Windows it makes no change.

**Call relations**: The public requery_default_colors function calls this. The Unix path is designed for later runtime events, using Crossterm so unrelated keyboard or terminal input is not accidentally consumed by the startup probe path.

*Call graph*: 3 external calls (query_background_color, query_foreground_color, default_colors_cache).


##### `xterm_fixed_colors`  (lines 301–303)

```
fn xterm_fixed_colors() -> impl Iterator<Item = (usize, (u8, u8, u8))>
```

**Purpose**: Returns the stable part of the Xterm 256-color palette. It skips the first 16 colors because terminals often let users theme those entries, so their actual appearance is not reliable.

**Data flow**: It reads the built-in XTERM_COLORS table, pairs each color with its palette index, skips indices 0 through 15, and returns an iterator over the remaining entries.

**Call relations**: best_color_for_color_level calls this when it needs to approximate an RGB color on a 256-color terminal. The skipped first colors avoid choosing palette entries whose real look may differ from the table.

*Call graph*: called by 1 (best_color_for_color_level).


##### `tests::best_color_uses_truecolor_without_quantization`  (lines 574–579)

```
fn best_color_uses_truecolor_without_quantization()
```

**Purpose**: Checks that true-color terminals receive the exact RGB color requested. This protects against accidentally reducing full-color output to a palette index.

**Data flow**: It passes a sample RGB color and the TrueColor level into the color picker. It compares the result with the direct RGB color wrapper.

**Call relations**: This test exercises best_color_for_color_level through the true-color branch and uses rgb_color as the expected result.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::best_color_resets_for_ansi16`  (lines 582–587)

```
fn best_color_resets_for_ansi16()
```

**Purpose**: Checks that basic 16-color support does not try to approximate arbitrary RGB colors. The expected behavior is to fall back to the terminal default color.

**Data flow**: It passes a sample RGB color and the Ansi16 level into the color picker. It verifies that the returned color is the reset/default color.

**Call relations**: This test protects the conservative fallback behavior in best_color_for_color_level.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::windows_terminal_wt_session_promotes_to_truecolor`  (lines 590–600)

```
fn windows_terminal_wt_session_promotes_to_truecolor()
```

**Purpose**: Checks that the presence of WT_SESSION can promote the effective color level to true color. This reflects Windows Terminal environments that may report too little color support.

**Data flow**: It gives the correction function a raw Ansi16 level, an unknown terminal name, WT_SESSION set to true, and no force-color override. It expects TrueColor back.

**Call relations**: This test directly exercises stdout_color_level_for_terminal, focusing on the WT_SESSION rule used by effective_stdout_color_level.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::windows_terminal_name_promotes_ansi16_to_truecolor`  (lines 603–613)

```
fn windows_terminal_name_promotes_ansi16_to_truecolor()
```

**Purpose**: Checks that a detected Windows Terminal name can promote a basic-color report to true color. This prevents the UI from looking unnecessarily dull in Windows Terminal.

**Data flow**: It gives the correction function a raw Ansi16 level, the WindowsTerminal name, no WT_SESSION flag, and no force-color override. It expects TrueColor back.

**Call relations**: This test directly protects the terminal-name rule inside stdout_color_level_for_terminal.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::force_color_keeps_reported_stdout_level`  (lines 616–626)

```
fn force_color_keeps_reported_stdout_level()
```

**Purpose**: Checks that FORCE_COLOR prevents the Windows Terminal promotion rules from changing the reported color level. This respects an explicit user or environment override.

**Data flow**: It gives the correction function a raw Ansi16 level, Windows Terminal indicators, and FORCE_COLOR set to true. It expects the original Ansi16 level to be returned.

**Call relations**: This test covers the override path in stdout_color_level_for_terminal, making sure effective_stdout_color_level will not second-guess FORCE_COLOR.

*Call graph*: 1 external calls (assert_eq!).


### Sandbox diagnostics and Windows support
These utilities provide sandbox-specific diagnostics and the Windows-focused helpers needed to prepare paths, environment, permissions, and sensitive dependencies for sandboxed execution.

### `cli/src/debug_sandbox/seatbelt.rs`

`io_transport` · `during sandboxed child process execution and teardown`

macOS has a sandbox system, sometimes called Seatbelt, that can block a program from reading files, opening network connections, or using other system features. When that happens, the system writes denial messages to the unified log. This file acts like a temporary notebook for those messages: it starts listening to the system log, tracks the process being debugged and its child processes, and later pulls out only the denial messages that belong to that process family.

The main type is `DenialLogger`. When it is created, it runs the `log stream` command with a filter that asks macOS for sandbox-related log entries in newline-delimited JSON form. A background task reads those log lines into memory while the sandboxed process runs. When the real child process starts, `on_child_spawn` records its process ID and starts a `PidTracker`, which follows that process and its descendants.

At the end, `finish` stops tracking process IDs, kills the log-streaming command, reads the captured log text, and scans each line. It parses the JSON, extracts the human-readable sandbox message, checks whether the denied process ID is one of the tracked IDs, and removes duplicates. The final result is a list of `SandboxDenial` values, each saying which process name was denied which capability. Without this file, a user might only see that something failed, not the specific sandbox rule that caused it.

#### Function details

##### `DenialLogger::new`  (lines 20–44)

```
fn new() -> Option<Self>
```

**Purpose**: Creates a new sandbox denial logger, if the macOS log stream can be started. It begins collecting sandbox log output in the background so later code can inspect what happened while a child process was running.

**Data flow**: It starts by asking `start_log_stream` to launch the system `log stream` command. If that works and the command has readable standard output, it takes that output, wraps it in a buffered reader, and spawns an asynchronous task that keeps reading lines into a byte buffer. It returns a `DenialLogger` containing the running log process, no process tracker yet, and the background reader task; if any required setup step fails, it returns nothing.

**Call relations**: This is the setup step for the whole file. It calls `start_log_stream` to open the pipe to macOS logs, then starts the background reader. Later, once the sandboxed child process exists, `DenialLogger::on_child_spawn` adds process tracking, and `DenialLogger::finish` uses the collected log bytes.

*Call graph*: calls 1 internal fn (start_log_stream); 3 external calls (new, new, spawn).


##### `DenialLogger::on_child_spawn`  (lines 46–50)

```
fn on_child_spawn(&mut self, child: &Child)
```

**Purpose**: Tells the logger which child process it should care about. This matters because the system log contains sandbox messages from the whole machine, so the logger needs a way to separate relevant messages from unrelated noise.

**Data flow**: It receives a spawned child process. It reads the child process ID, and if one is available, creates a `PidTracker` rooted at that ID. The logger is changed from merely collecting all sandbox logs to also knowing which process family should be considered relevant.

**Call relations**: This is called after the sandboxed child process has been started. It hands the root process ID to `PidTracker::new`, so that `DenialLogger::finish` can later ask the tracker for the full set of process IDs to match against the captured log lines.

*Call graph*: calls 1 internal fn (new); 1 external calls (id).


##### `DenialLogger::finish`  (lines 52–84)

```
async fn finish(mut self) -> Vec<SandboxDenial>
```

**Purpose**: Stops logging and returns the sandbox denials that belonged to the tracked child process and its descendants. It turns a raw stream of system log text into a clean, deduplicated list of denied capabilities.

**Data flow**: It first stops the process tracker, if one was created, and gets the set of process IDs that should count as relevant. If there are no tracked process IDs, it returns an empty list. Otherwise it kills and waits for the `log stream` command, collects the bytes read by the background task, converts them to text, and reads each log line. For each line, it parses the JSON, looks for the `eventMessage` field, uses `parse_message` to extract the process ID, process name, and denied capability, keeps only entries whose process ID is in the tracked set, removes repeated name-and-capability pairs, and returns the remaining denials.

**Call relations**: This is the teardown and reporting step. It depends on `DenialLogger::on_child_spawn` having set up a `PidTracker`; otherwise there is no reliable way to know which log messages belong to the child process. It calls `parse_message` for each candidate sandbox message to turn Apple’s log wording into structured data.

*Call graph*: calls 1 internal fn (parse_message); 6 external calls (kill, wait, default, new, from_utf8_lossy, new).


##### `start_log_stream`  (lines 87–100)

```
fn start_log_stream() -> Option<Child>
```

**Purpose**: Starts the macOS command that streams sandbox-related system log entries. It is the bridge between this Rust code and the operating system’s log service.

**Data flow**: It builds a `log stream` command with a predicate, meaning a filter expression, that selects likely sandbox-reporting messages. It asks for newline-delimited JSON output, closes standard input, pipes standard output so the Rust code can read it, hides standard error, and arranges for the process to be killed if dropped. It returns the running child process if spawning succeeds, or nothing if the command cannot be started.

**Call relations**: This helper is called by `DenialLogger::new` during setup. Its output becomes the source that the background reader task consumes, and later `DenialLogger::finish` stops the same process once enough logs have been collected.

*Call graph*: called by 1 (new); 3 external calls (null, piped, new).


##### `parse_message`  (lines 102–114)

```
fn parse_message(msg: &str) -> Option<(i32, String, String)>
```

**Purpose**: Extracts the useful parts from one human-readable macOS sandbox denial message. It turns text like `Sandbox: processname(1234) deny(1) capability-name ...` into a process ID, process name, and denied capability string.

**Data flow**: It receives a message string from the system log. It uses a compiled regular expression, cached for reuse, to check whether the string matches the expected sandbox denial format. If it matches, it pulls out the process name, converts the process ID text into a number, and returns those along with the capability text. If the message has an unexpected shape or the process ID cannot be read as a number, it returns nothing.

**Call relations**: This is called from `DenialLogger::finish` while scanning captured log lines. `finish` uses the parsed process ID to decide whether the denial belongs to the tracked child process family, and uses the parsed name and capability to build the final `SandboxDenial` report.

*Call graph*: called by 1 (finish); 1 external calls (new).


### `windows-sandbox-rs/src/bin/command_runner/win/cwd_junction.rs`

`io_transport` · `command setup`

On Windows, a directory junction is a special kind of folder link: it looks like a normal folder, but it actually points somewhere else. This file uses that feature to make a repeatable shortcut to the requested current working directory, under `USERPROFILE\.codex\.sandbox\cwd`.

The main reason this exists is to prepare a working directory path that the Windows sandbox command runner can use reliably. Instead of using the original path directly, it creates or reuses a junction whose name is based on a hash of that original path. That is like putting a labeled shortcut in a known drawer, where the label is a compact fingerprint of the real location.

The flow is careful. First it finds the user's profile folder and creates the sandbox junction folder if needed. Then it builds the junction path. If something already exists there and it is a Windows reparse point, meaning a link-like filesystem object, it reuses it. If a normal file or folder is in the way, it tries to remove it. Finally it calls `cmd /c mklink /J`, because `mklink` is built into the Windows command shell rather than being a separate program. It logs each important success or failure and returns `None` if it cannot safely create or reuse the junction.

#### Function details

##### `junction_name_for_path`  (lines 11–15)

```
fn junction_name_for_path(path: &Path) -> String
```

**Purpose**: This function turns a real folder path into a short, stable name for the junction. It uses a hash, which is a compact fingerprint, so long or awkward paths can become simple folder names.

**Data flow**: It receives a path. It converts the path to text, feeds that text into a hasher, and formats the resulting number as hexadecimal text. The output is a string that can be used as the junction folder name.

**Call relations**: When `create_cwd_junction` needs to decide where the shortcut folder should live, it calls this helper to derive the final folder name from the requested working directory.

*Call graph*: called by 1 (create_cwd_junction); 3 external calls (new, to_string_lossy, format!).


##### `junction_root_for_userprofile`  (lines 17–22)

```
fn junction_root_for_userprofile(userprofile: &str) -> PathBuf
```

**Purpose**: This function chooses the parent folder where all current-working-directory junctions are stored for one Windows user. It keeps these sandbox shortcuts grouped in a predictable place.

**Data flow**: It receives the user's profile directory as text. It appends `.codex`, then `.sandbox`, then `cwd`, producing a full path such as a sandbox-specific folder inside the user's home area. The output is that path.

**Call relations**: At the start of `create_cwd_junction`, this helper is called after reading the `USERPROFILE` environment variable, so the rest of the code knows where to create or find junctions.

*Call graph*: called by 1 (create_cwd_junction); 1 external calls (from).


##### `create_cwd_junction`  (lines 24–140)

```
fn create_cwd_junction(requested_cwd: &Path, log_dir: Option<&Path>) -> Option<PathBuf>
```

**Purpose**: This function creates, reuses, or rejects a Windows junction for the folder where a command should run. It is used when the command runner needs an effective current working directory path for sandboxed execution.

**Data flow**: It takes the requested working directory and an optional log directory. It reads `USERPROFILE`, builds the sandbox junction root, creates that root folder if missing, and then builds a junction path using a hash of the requested directory. If a valid junction already exists there, it returns that path. If something invalid is there, it tries to remove it. If no usable junction exists, it runs `cmd /c mklink /J` to create one pointing to the requested directory. On success it returns the junction path; on any failure it writes a log note and returns `None`.

**Call relations**: `effective_cwd` calls this when it needs a usable working directory for a command. Inside, this function relies on `junction_root_for_userprofile` to find the storage area, `junction_name_for_path` to name the specific junction, and `log_note` to leave a readable trail of what happened. It also hands off the actual junction creation to Windows through `cmd` and the built-in `mklink` command.

*Call graph*: calls 2 internal fn (junction_name_for_path, junction_root_for_userprofile); called by 1 (effective_cwd); 9 external calls (to_string_lossy, from_utf8_lossy, new, log_note, format!, var, create_dir_all, remove_dir, symlink_metadata).


### `windows-sandbox-rs/src/bin/setup_main/win/read_acl_mutex.rs`

`util` · `setup coordination`

This file is a small Windows-specific safety tool. A mutex is a lock: like a restroom key, whoever holds it gets exclusive access, and everyone else can see that the room is occupied. Here the lock has a fixed Windows name, `Local\CodexSandboxReadAcl`, so separate parts of the setup program can recognize the same lock even if they are not sharing normal Rust memory.

The file solves a coordination problem during sandbox setup. One setup path may need to perform read-ACL work, while another path may only want to know whether that work is already in progress. Without this named mutex, two setup flows could overlap and step on each other, which is especially risky when changing or inspecting Windows security settings.

There are two main actions. `read_acl_mutex_exists` checks whether the named lock already exists. It opens the mutex if it can, closes the handle immediately, and reports true. If Windows says the mutex was not found, it reports false. Other Windows errors become normal Rust errors.

`acquire_read_acl_mutex` tries to create and take ownership of the mutex. If it successfully creates a new one, it returns a guard object. That guard releases and closes the Windows handle automatically when it is dropped, so callers do not have to remember cleanup by hand. If the mutex already exists, it returns `None`, meaning “someone else already has or created this lock.”

#### Function details

##### `ReadAclMutexGuard::drop`  (lines 21–26)

```
fn drop(&mut self)
```

**Purpose**: This automatically gives back the Windows mutex and closes its operating-system handle when the guard object goes away. It is the cleanup safety net that prevents the lock from being held longer than intended.

**Data flow**: It starts with a `ReadAclMutexGuard` that contains a Windows handle to the named mutex. When Rust drops the guard, the function tells Windows to release the mutex, then closes the handle so the program no longer owns that system resource. It does not return a value; its effect is cleanup.

**Call relations**: This is triggered automatically after `acquire_read_acl_mutex` has returned a guard and the caller is finished with it. It hands cleanup to Windows through `ReleaseMutex` and `CloseHandle`, so callers such as the read-ACL setup path do not need to call those functions themselves.

*Call graph*: 2 external calls (CloseHandle, ReleaseMutex).


##### `read_acl_mutex_exists`  (lines 29–43)

```
fn read_acl_mutex_exists() -> Result<bool>
```

**Purpose**: This checks whether the shared read-ACL mutex already exists. It is used when setup wants to know if another setup flow has already created the coordination lock.

**Data flow**: It starts with the fixed mutex name, converts it into the wide-character string format that Windows APIs expect, and asks Windows to open that mutex. If Windows opens it, the function closes the temporary handle and returns `true`. If Windows says the mutex was not found, it returns `false`. If Windows reports any other failure, it turns that into an error message for the caller.

**Call relations**: The full setup flow calls this through `run_setup_full` when it needs to check whether the read-ACL coordination lock is present. Internally it talks directly to Windows with `OpenMutexW`, reads failure details with `GetLastError`, and closes any handle it successfully opens.

*Call graph*: called by 1 (run_setup_full); 6 external calls (new, anyhow!, to_wide, CloseHandle, GetLastError, OpenMutexW).


##### `acquire_read_acl_mutex`  (lines 45–61)

```
fn acquire_read_acl_mutex() -> Result<Option<ReadAclMutexGuard>>
```

**Purpose**: This tries to create and take the read-ACL mutex so the current setup path can be the only one doing that work. It returns a guard if this process got the lock, or `None` if the named mutex already existed.

**Data flow**: It begins with the fixed mutex name, converts it into Windows wide-character form, and asks Windows to create the mutex while immediately owning it. If creation fails outright, it returns an error. If Windows says the mutex already existed, it closes the handle it just received and returns `None`. If the mutex is new, it wraps the handle in `ReadAclMutexGuard` and returns it, so the lock will be released automatically later.

**Call relations**: The read-ACL-only setup path calls this through `run_read_acl_only` before doing the protected work. This function delegates the actual lock creation to Windows with `CreateMutexW`, checks the result with `GetLastError`, and relies on `ReadAclMutexGuard::drop` to release the lock when the caller is done.

*Call graph*: called by 1 (run_read_acl_only); 7 external calls (new, anyhow!, to_wide, null_mut, CloseHandle, GetLastError, CreateMutexW).


### `windows-sandbox-rs/src/env.rs`

`util` · `startup and process spawn preparation`

Environment variables are small named settings passed to a program when it starts. They can decide where commands are found, which pager opens text, whether tools try to use the internet, and more. This file is a toolkit for shaping those settings before the sandbox launches a child process.

The file solves several practical problems. Some Unix-style settings, such as `/dev/null`, do not work the same way on Windows, so they are translated to Windows’ `NUL` device. Some tools, especially Git, may try to open an interactive pager and wait for a keypress; this file nudges them toward non-interactive behavior. It also preserves `PATH` and `PATHEXT`, the Windows settings that control where commands are searched for and which file extensions count as runnable commands.

The most security-relevant part is the no-network setup. It sets common proxy and package-manager variables so tools are discouraged from reaching the internet. It also creates a small “denybin” directory containing fake `ssh` and `scp` commands that immediately fail, then puts that directory first in `PATH`. This is like placing a locked dummy phone at the front desk so anyone asking to make an outside call gets stopped before reaching the real phone. It is not a full firewall by itself, but it blocks many common network paths used by developer tools.

#### Function details

##### `normalize_null_device_env`  (lines 12–22)

```
fn normalize_null_device_env(env_map: &mut HashMap<String, String>)
```

**Purpose**: This function makes null-device settings portable for Windows. If an environment variable points at a Unix-style null sink, it changes it to Windows’ `NUL`, so programs do not fail because they were given the wrong operating-system name for “throw this output away.”

**Data flow**: It receives a mutable map of environment variable names to values. It scans every current value, trims extra spaces, compares it case-insensitively against known null-device spellings, and replaces matching values with `NUL`. The same map comes out changed in place; there is no separate return value.

**Call relations**: This is used while building launch environments in the normal spawn path, the elevated-permissions path, and the permission-profile sandbox capture path. It runs before the child program starts, so later launch code receives an environment that is already Windows-friendly.

*Call graph*: called by 3 (run_windows_sandbox_capture_for_permission_profile, prepare_elevated_spawn_context_for_permissions, prepare_spawn_context_common).


##### `ensure_non_interactive_pager`  (lines 24–32)

```
fn ensure_non_interactive_pager(env_map: &mut HashMap<String, String>)
```

**Purpose**: This function prevents command-line tools from getting stuck waiting in an interactive text viewer. It sets safe defaults for pager-related variables, especially for Git output.

**Data flow**: It receives the environment map and adds defaults only when the caller has not already chosen values. It sets `GIT_PAGER` and `PAGER` to `more.com`, and sets `LESS` to an empty value. Existing user-provided settings are left alone.

**Call relations**: This is called during the same environment preparation flows that create spawn contexts for sandboxed or elevated commands. Its job is to make the soon-to-start process less likely to pause unexpectedly for user input.

*Call graph*: called by 3 (run_windows_sandbox_capture_for_permission_profile, prepare_elevated_spawn_context_for_permissions, prepare_spawn_context_common).


##### `inherit_path_env`  (lines 35–46)

```
fn inherit_path_env(env_map: &mut HashMap<String, String>)
```

**Purpose**: This function keeps Windows command lookup working by copying `PATH` and `PATHEXT` from the parent process when the prepared environment does not already include them. Without these, child programs might not find basic tools or might not recognize `.exe`, `.bat`, or `.cmd` files as runnable.

**Data flow**: It takes the environment map being prepared. If `PATH` is missing, it reads `PATH` from the current process and inserts it. If `PATHEXT` is missing, it does the same for `PATHEXT`. If either variable is already present, it respects that existing value.

**Call relations**: The spawn-preparation code calls this before launching sandboxed, elevated, or permission-profile commands. It bridges the parent process environment into the child environment so later steps can still customize it without accidentally losing the basic Windows search behavior.

*Call graph*: called by 3 (run_windows_sandbox_capture_for_permission_profile, prepare_elevated_spawn_context_for_permissions, prepare_spawn_context_common); 1 external calls (var).


##### `prepend_path`  (lines 48–69)

```
fn prepend_path(env_map: &mut HashMap<String, String>, prefix: &str)
```

**Purpose**: This helper puts a chosen directory at the front of `PATH`, so commands in that directory are found before commands elsewhere. In this file, that is used to make blocker scripts take priority over real network tools such as SSH.

**Data flow**: It receives the environment map and a directory path as text. It reads the existing `PATH` from the map or, if missing, from the current process. If the requested directory is not already first, it builds a new `PATH` with that directory followed by the old entries and writes it back into the map.

**Call relations**: This is an internal helper used by `apply_no_network_to_env`. After the denybin directory has been created, `apply_no_network_to_env` asks this function to move that directory to the front of command search order.

*Call graph*: called by 1 (apply_no_network_to_env); 1 external calls (new).


##### `reorder_pathext_for_stubs`  (lines 71–103)

```
fn reorder_pathext_for_stubs(env_map: &mut HashMap<String, String>)
```

**Purpose**: This helper changes the Windows executable-extension order so `.bat` and `.cmd` files are considered before other runnable extensions. That matters because the network blockers created here are batch or command scripts.

**Data flow**: It reads `PATHEXT` from the environment map, or from the current process, or falls back to a standard default. It splits the extension list, moves `.BAT` and `.CMD` to the front while keeping the remaining extensions afterward, and writes the reordered list back into the map.

**Call relations**: This is called by `apply_no_network_to_env` after adding the denybin directory to `PATH`. Together, the front-of-`PATH` directory and the adjusted extension order make the fake blocker commands more likely to be chosen when a tool tries to run `ssh` or `scp`.

*Call graph*: called by 1 (apply_no_network_to_env); 1 external calls (new).


##### `ensure_denybin`  (lines 105–124)

```
fn ensure_denybin(tools: &[&str], denybin_dir: Option<&Path>) -> Result<PathBuf>
```

**Purpose**: This function creates a directory of tiny blocker commands that immediately fail. It is used to stop selected command-line tools, such as `ssh` and `scp`, from being used by child processes.

**Data flow**: It receives a list of tool names and, optionally, a directory to use. If no directory is given, it chooses `.sbx-denybin` inside the user’s home directory. It creates the directory if needed, then creates `.bat` and `.cmd` files for each requested tool when they do not already exist. Each file contains a short Windows script that exits with failure. It returns the directory path, or an error if the home directory or file operations fail.

**Call relations**: This is called by `apply_no_network_to_env` as the filesystem part of the no-network setup. Once it returns the denybin path, the caller can put that path first in `PATH` so the blocker commands are found before the real tools.

*Call graph*: called by 1 (apply_no_network_to_env); 4 external calls (create, home_dir, format!, create_dir_all).


##### `apply_no_network_to_env`  (lines 126–177)

```
fn apply_no_network_to_env(env_map: &mut HashMap<String, String>) -> Result<()>
```

**Purpose**: This function applies the file’s no-network environment profile. It sets common variables that tell tools to avoid the network and installs command stubs that make SSH-style access fail quickly.

**Data flow**: It receives the environment map that will be passed to a child process. It marks no-network mode as active, fills in proxy settings pointing to `127.0.0.1:9` when the caller has not already set proxies, and sets offline flags for tools such as pip, npm, Cargo, and Git. It creates blocker scripts for `ssh` and `scp`, removes old blockers for `curl` and `wget` if they are present, puts the blocker directory first in `PATH`, reorders `PATHEXT`, and returns success or an error if setup fails.

**Call relations**: This is called from the legacy spawn-context preparation path when that path needs network access disabled. It coordinates the lower-level helpers in this file: `ensure_denybin` creates the blocker directory, `prepend_path` makes it take priority, and `reorder_pathext_for_stubs` makes Windows prefer the blocker script extensions.

*Call graph*: calls 3 internal fn (ensure_denybin, prepend_path, reorder_pathext_for_stubs); called by 1 (prepare_legacy_spawn_context); 2 external calls (format!, remove_file).


### `windows-sandbox-rs/src/path_normalization.rs`

`util` · `cross-cutting`

The sandbox often needs to answer questions like “is this folder inside the allowed workspace?” or “does this path match a protected location?” Those checks are only reliable if two spellings of the same place are treated as the same path. On Windows, that is easy to get wrong: `C:\Users\Dev` and `c:/users/dev` may refer to the same folder but look different as text.

This file provides the small shared tool used to avoid that mistake. First, it tries to canonicalize a path, meaning it asks the operating system or path library for the path’s cleaned-up, real form. It uses `dunce`, a Rust library that produces friendlier Windows paths than the standard canonicalizer. If that cleanup fails, for example because the path does not exist yet, it keeps the original path instead of crashing.

Then it can turn the result into a “key”: a plain string with forward slashes and lowercase letters. That key is useful for comparisons, like giving every address in a city the same spelling before checking whether two addresses match. Without this file, sandbox permission checks could become inconsistent and either deny safe paths or, worse, miss paths that should be restricted.

#### Function details

##### `canonicalize_path`  (lines 4–6)

```
fn canonicalize_path(path: &Path) -> PathBuf
```

**Purpose**: This function tries to convert a path into its cleaned-up, real filesystem form. It is used when later code needs a more trustworthy version of a path before checking permissions or comparing locations.

**Data flow**: It receives a path. It asks `dunce::canonicalize` to resolve it into a normalized filesystem path. If that works, it returns the cleaned path; if it fails, it returns a copy of the original path so callers can continue without a crash.

**Call relations**: This is the basic path-cleaning step used by higher-level sandbox checks. Code that decides whether a workspace write root contains a path, how specific a write root is, whether read-deny rules apply, whether legacy session access rules match, or whether a command is running at the workspace root calls this before making those decisions. `canonical_path_key` also builds on it when it needs a comparison-friendly string.

*Call graph*: called by 6 (workspace_write_root_contains_path, workspace_write_root_specificity, plan_deny_read_acl_paths, canonical_path_key, apply_legacy_session_acl_rules, is_command_cwd_root); 1 external calls (canonicalize).


##### `canonical_path_key`  (lines 8–13)

```
fn canonical_path_key(path: &Path) -> String
```

**Purpose**: This function makes a path safe to compare as text. It turns different-looking spellings of the same path into the same lowercase, forward-slash string.

**Data flow**: It receives a path, sends it through `canonicalize_path`, converts the result into text, changes backslashes to forward slashes, and lowercases the text. The output is a normalized string key that can be stored, compared, or used to group matching paths.

**Call relations**: This is the comparison layer used by many permission and filtering decisions. Callers use it when auditing writable locations, choosing capability identifiers for workspaces and write roots, expanding or filtering user-profile roots, and checking exclusions. It depends on `canonicalize_path` first so the text key starts from the best available filesystem form.

*Call graph*: calls 1 internal fn (canonicalize_path); called by 9 (audit_everyone_writable, workspace_cap_sid_for_cwd, workspace_write_cap_sid_for_root, writable_root_cap_sid_for_path, expand_user_profile_root_for, filter_sensitive_write_roots, filter_user_profile_root, is_user_profile_root_exclusion, user_profile_child_name).


##### `tests::canonical_path_key_normalizes_case_and_separators`  (lines 22–30)

```
fn canonical_path_key_normalizes_case_and_separators()
```

**Purpose**: This test proves that `canonical_path_key` treats common Windows path spelling differences as equivalent. It protects the sandbox from regressions where slash style or letter case would accidentally change permission decisions.

**Data flow**: It creates two paths that should mean the same location: one with backslashes and uppercase drive letter, and one with forward slashes and lowercase text. It runs both through `canonical_path_key` and checks that the two results are equal.

**Call relations**: This test exercises the public comparison helper directly. It uses `Path::new` to build the sample paths and `assert_eq!` to confirm the normalized keys match, giving confidence to all the sandbox code that relies on these keys for path comparisons.

*Call graph*: 2 external calls (new, assert_eq!).


### `windows-sandbox-rs/src/sandbox_utils.rs`

`util` · `sandbox setup before command launch`

When this project runs a command inside a Windows sandbox, the command may run as a different user from the one who owns the project files. That creates two practical problems. First, the sandbox needs a Codex home directory to exist before tools can write settings or temporary files there. Second, Git may refuse to work in the checked-out repository, because modern Git protects users from repositories owned by someone else unless they are marked as safe.

This file solves those setup problems in one shared place, so the older sandbox path, the elevated sandbox path, and command-capture flows all behave the same way. It can create the Codex home directory if it is missing. It can also look upward from the command's working directory until it finds a Git repository root, then add temporary Git configuration entries into the environment map. Those entries tell Git, for this launched process only, that the repository is a safe directory.

An everyday analogy: before lending someone a locked workshop, this file makes sure their desk exists and gives their tools a note saying, “yes, this workshop is allowed.” The tests check both common Git layouts: a normal `.git` directory and a `.git` file used by Git worktrees.

#### Function details

##### `find_git_worktree_root_for_safe_directory`  (lines 13–25)

```
fn find_git_worktree_root_for_safe_directory(start: &Path) -> Option<std::path::PathBuf>
```

**Purpose**: Finds the top folder of the Git working tree that should be marked as safe for Git. It starts from a given folder and walks upward until it sees a `.git` entry.

**Data flow**: It receives a starting path. It first turns that path into a normalized real path, then checks that folder and each parent folder for a `.git` directory or file. If it finds one, it returns that folder; if it reaches the filesystem root or cannot normalize the path, it returns nothing.

**Call relations**: This is the private search helper used by `inject_git_safe_directory`. The larger setup code does not call it directly; it asks `inject_git_safe_directory` to update the environment, and this function quietly finds the right repository root for that update.

*Call graph*: called by 1 (inject_git_safe_directory); 1 external calls (canonicalize).


##### `ensure_codex_home_exists`  (lines 28–31)

```
fn ensure_codex_home_exists(p: &Path) -> Result<()>
```

**Purpose**: Makes sure the Codex home directory exists before sandboxed code tries to use it. This prevents later file operations from failing just because the directory was never created.

**Data flow**: It receives the path that should be used as the Codex home. It asks the operating system to create that directory and any missing parent directories. It returns success if the directory exists afterward, or an error if Windows could not create it.

**Call relations**: Several sandbox preparation paths call this before launching or checking a sandboxed command: capture flow, elevated spawn setup, common spawn setup, and legacy preflight. It is an early setup step that clears the way for later work.

*Call graph*: called by 4 (run_windows_sandbox_capture_for_permission_profile, prepare_elevated_spawn_context_for_permissions, prepare_spawn_context_common, run_windows_sandbox_legacy_preflight); 1 external calls (create_dir_all).


##### `inject_git_safe_directory`  (lines 36–51)

```
fn inject_git_safe_directory(env_map: &mut HashMap<String, String>, cwd: &Path)
```

**Purpose**: Adds temporary Git settings to a command's environment so Git will trust the current repository inside the sandbox. This matters because the sandbox user may not be the same Windows user who owns the repository files.

**Data flow**: It receives a mutable environment map and the command's current working directory. It looks for the surrounding Git worktree root. If it finds one, it reads the current `GIT_CONFIG_COUNT`, adds a new `safe.directory` key/value pair at the next numbered slot, and writes the updated count back into the map. If no Git repository is found, it leaves the environment unchanged.

**Call relations**: Sandbox setup code calls this while building the environment for a process that is about to run. It relies on `find_git_worktree_root_for_safe_directory` to locate the repository, then hands the result to Git through environment variables rather than editing any real Git config file. The tests also call it directly to prove the injected values are correct.

*Call graph*: calls 1 internal fn (find_git_worktree_root_for_safe_directory); called by 5 (run_windows_sandbox_capture_for_permission_profile, injects_safe_directory_for_git_directory, injects_worktree_root_for_gitfile, prepare_elevated_spawn_context_for_permissions, prepare_spawn_context_common); 1 external calls (format!).


##### `tests::safe_directory_value`  (lines 62–67)

```
fn safe_directory_value(path: &Path) -> String
```

**Purpose**: Builds the expected safe-directory string used in tests. It mirrors the same path normalization style that the real helper uses.

**Data flow**: It receives a path, converts it to a normalized real path, turns it into text, and adjusts Windows backslashes into the slash style expected by the test values. It returns that string.

**Call relations**: The test cases use this helper when building their expected environment maps. It keeps the tests focused on behavior instead of repeating path-normalization details in each test.

*Call graph*: 1 external calls (canonicalize).


##### `tests::injects_safe_directory_for_git_directory`  (lines 70–89)

```
fn injects_safe_directory_for_git_directory()
```

**Purpose**: Checks that a normal Git repository with a `.git` directory gets added as a safe directory. This proves the sandbox environment will be prepared correctly for the common repository layout.

**Data flow**: It creates a temporary fake repository, including a nested working directory and a `.git` directory at the repository root. It passes an empty environment map and the nested directory into `inject_git_safe_directory`. It then compares the changed map against the exact Git environment variables that should have been inserted.

**Call relations**: This test exercises `inject_git_safe_directory` through the normal `.git` directory case. It also uses `tests::safe_directory_value` to compute the expected repository path in the same normalized form as the production code.

*Call graph*: calls 1 internal fn (inject_git_safe_directory); 6 external calls (from, new, new, assert_eq!, create_dir_all, safe_directory_value).


##### `tests::injects_worktree_root_for_gitfile`  (lines 92–115)

```
fn injects_worktree_root_for_gitfile()
```

**Purpose**: Checks that a Git worktree layout, where `.git` is a file rather than a directory, is still recognized. This matters because Git worktrees are a valid way to have multiple working folders connected to one repository.

**Data flow**: It creates a temporary fake repository with a nested folder, then writes a `.git` file at the repository root. It calls `inject_git_safe_directory` with an empty environment map and the nested folder. It expects the map to contain one `safe.directory` entry pointing to the repository root.

**Call relations**: This test covers the less obvious Git worktree case for `inject_git_safe_directory`. Like the normal repository test, it uses `tests::safe_directory_value` to build the expected path and then verifies the full environment map.

*Call graph*: calls 1 internal fn (inject_git_safe_directory); 7 external calls (from, new, new, assert_eq!, create_dir_all, write, safe_directory_value).


### `windows-sandbox-rs/src/ssh_config_dependencies.rs`

`domain_logic` · `sandbox setup`

An SSH config file is rarely just one file. It can point to keys, certificates, sockets, known-hosts lists, and even other config files through Include lines. If a sandbox only copied the main .ssh/config file, SSH might fail later because one of those referenced files is missing. This file solves that problem by reading the user’s SSH config and building a list of file paths that matter.

The main path starts with the user profile folder, then looks at .ssh/config. From there it walks through the config like following a trail of notes. When it sees Include, it expands the include pattern, including wildcards, and recursively reads those files too. When it sees path-style SSH options such as IdentityFile or CertificateFile, it turns SSH’s home-folder shortcuts like ~, %d, and ${HOME} into real paths under the user profile.

It also tries to avoid getting trapped. It remembers config files it has already visited, and it stops after a fixed recursion depth so a broken or circular Include chain cannot loop forever. The small parser helpers exist because SSH config lines can contain comments, quotes, equals signs, and escaped spaces.

#### Function details

##### `ssh_config_dependency_paths`  (lines 15–27)

```
fn ssh_config_dependency_paths(user_profile: &Path) -> Vec<PathBuf>
```

**Purpose**: Starts the dependency search for one user profile. It returns the main SSH config file plus any extra files found by reading that config and its includes.

**Data flow**: It receives the user profile path, builds the expected .ssh folder and .ssh/config path, puts that main config path into a list, then asks visit_config to inspect it. The result is a vector of paths that should be treated as SSH dependencies.

**Call relations**: This is the public entry point inside the crate for this file’s work. filter_ssh_config_dependency_roots calls it when it needs to know which SSH paths should be included, and it immediately hands the detailed scanning work to visit_config.

*Call graph*: calls 1 internal fn (visit_config); called by 1 (filter_ssh_config_dependency_roots); 3 external calls (new, join, vec!).


##### `visit_config`  (lines 29–70)

```
fn visit_config(
    path: &Path,
    user_profile: &Path,
    ssh_dir: &Path,
    visited: &mut HashSet<PathBuf>,
    paths: &mut Vec<PathBuf>,
    depth: usize,
)
```

**Purpose**: Reads one SSH config file and adds any files it refers to into the dependency list. It also follows Include lines into other config files.

**Data flow**: It receives a config path, the user profile path, the .ssh folder path, a set of already-seen files, the growing output list, and the current recursion depth. It canonicalizes the path when possible, skips files already visited, reads the file text, parses each useful line, then adds included files and profile-relative path references to the output list. It changes the visited set and the paths list, but returns no separate value.

**Call relations**: ssh_config_dependency_paths calls this for the main .ssh/config file. When visit_config finds Include directives, it calls include_paths to expand them and then calls itself again for each included config file. When it finds SSH options that name files, it calls profile_path_arg to turn SSH-style path text into real filesystem paths.

*Call graph*: calls 2 internal fn (include_paths, profile_path_arg); called by 1 (ssh_config_dependency_paths); 2 external calls (canonicalize, read_to_string).


##### `include_paths`  (lines 72–81)

```
fn include_paths(arg: &str, user_profile: &Path, ssh_dir: &Path) -> Vec<PathBuf>
```

**Purpose**: Turns one SSH Include argument into the actual config files it names. This includes support for wildcard patterns such as conf.d/*.conf.

**Data flow**: It receives the raw Include argument plus the user profile and .ssh folder. First it converts SSH path shortcuts and relative paths into a usable pattern path. Then it normalizes slashes for glob matching, expands the wildcard pattern, drops failed matches, and returns the matching paths.

**Call relations**: visit_config calls this when it sees an Include line. include_paths uses profile_path_arg to interpret the Include argument before handing the resulting pattern to the glob library, which finds matching files on disk.

*Call graph*: calls 1 internal fn (profile_path_arg); called by 1 (visit_config); 2 external calls (new, glob).


##### `directive`  (lines 83–105)

```
fn directive(line: &str) -> Option<(String, Vec<String>)>
```

**Purpose**: Parses one SSH config line into a setting name and its arguments. It understands both forms SSH allows, such as IdentityFile ~/.ssh/id and IdentityFile=~/.ssh/id.

**Data flow**: It receives one line of text. It first asks words to split the line into meaningful pieces while respecting quotes, escapes, and comments. Then it separates the first piece into a key and values, handling equals signs either attached to the key or as part of the next word. It returns nothing for blank or comment-only lines, or returns the directive name with its argument list.

**Call relations**: This parser is used during config scanning so visit_config can decide whether a line is an Include, a file-path option, or something irrelevant. It relies on words for the lower-level job of splitting text safely.

*Call graph*: calls 1 internal fn (words); 1 external calls (new).


##### `words`  (lines 107–143)

```
fn words(line: &str) -> Vec<String>
```

**Purpose**: Splits a config line into words the way an SSH config reader needs, not just by simple spaces. It keeps quoted text together, ignores comments, and handles a few escaped characters.

**Data flow**: It receives a raw line of text and walks through it character by character. It tracks whether it is inside single or double quotes, stops at an unquoted # comment, treats unquoted whitespace as a separator, and preserves escaped quotes, backslashes, and spaces where appropriate. It returns a list of cleaned-up words.

**Call relations**: directive calls this before it tries to understand a line as an SSH setting. This keeps directive focused on the meaning of the line, while words handles the small but important text-splitting rules.

*Call graph*: called by 1 (directive); 4 external calls (new, new, matches!, take).


##### `profile_path_arg`  (lines 145–173)

```
fn profile_path_arg(
    arg: &str,
    user_profile: &Path,
    relative_base: Option<&Path>,
) -> Option<PathBuf>
```

**Purpose**: Converts an SSH config path argument into a real path when it can. It understands home-folder shortcuts and decides whether relative paths should be accepted.

**Data flow**: It receives a path-like argument, the user profile path, and optionally a base folder for relative paths. If the argument is none, it returns no path. If it is ~, %d, ${HOME}, or starts with one of those forms, it produces a path under the user profile. If it is already absolute, it returns that path. If it is relative, it only returns a path when a relative base was provided.

**Call relations**: visit_config calls this for SSH options that point to files, where only profile-style or absolute paths are useful. include_paths calls it with the .ssh folder as the relative base, because SSH Include paths may be relative to the SSH config directory.

*Call graph*: called by 2 (include_paths, visit_config); 3 external calls (join, to_path_buf, from).


##### `tests::collects_path_directive_profile_entries`  (lines 184–218)

```
fn collects_path_directive_profile_entries()
```

**Purpose**: Checks that the dependency finder recognizes the main SSH file-path directives and expands home-folder shortcuts correctly.

**Data flow**: It creates a temporary home folder, writes a sample .ssh/config containing several path-based SSH options, then runs ssh_config_dependency_paths. It compares the returned paths with the exact list expected, after normalizing slashes so the test works consistently across platforms.

**Call relations**: This test exercises the main public flow through ssh_config_dependency_paths, which then reaches visit_config and the path conversion helper. It proves that common directives such as IdentityFile, CertificateFile, and UserKnownHostsFile are not missed.

*Call graph*: 4 external calls (new, assert_eq!, create_dir_all, write).


##### `tests::recursively_collects_include_dependencies`  (lines 221–241)

```
fn recursively_collects_include_dependencies()
```

**Purpose**: Checks that Include lines are followed and that dependencies inside included files are collected too.

**Data flow**: It creates a temporary home folder with .ssh/config and an included config file under .ssh/conf.d. The main config includes the second file by wildcard, and the included file names a certificate. The test runs ssh_config_dependency_paths and expects the output to contain the main config, the included config, and the certificate path.

**Call relations**: This test drives ssh_config_dependency_paths into visit_config, include_paths, and recursive visit_config calls. It confirms that the file-following behavior works across more than one config file.

*Call graph*: 4 external calls (new, assert_eq!, create_dir_all, write).


##### `tests::slash_paths`  (lines 243–248)

```
fn slash_paths(paths: Vec<PathBuf>) -> Vec<PathBuf>
```

**Purpose**: Normalizes path separators in test results so expected paths can be compared reliably. This matters because Windows and Unix-like systems display path separators differently.

**Data flow**: It receives a list of paths, converts each path to text, replaces backslashes with forward slashes, turns the text back into a path, and returns the normalized list.

**Call relations**: The test functions use this helper before comparing results with assert_eq. It does not affect production code; it only keeps the tests from failing because of platform-specific path formatting.


### `windows-sandbox-rs/src/winutil.rs`

`util` · `cross-cutting`

Windows APIs often do not accept data in the same shape that normal Rust code uses. For example, many Windows calls want text as UTF-16 numbers ending with a zero, not as a Rust string. They also use SIDs, or security identifiers, which are compact binary labels for accounts and groups such as Everyone, SYSTEM, or Administrators. This file is the adapter between friendly Rust values and those Windows formats.

The file has three main jobs. First, it converts text into Windows wide strings with to_wide. Second, it builds command lines safely for CreateProcess-style Windows process launching. Windows does not receive an argument list directly in many APIs; it receives one long command-line string, so quote_windows_arg and argv_to_command_line preserve spaces, quotes, and backslashes correctly. Third, it works with Windows security data. It can resolve a user or group name into SID bytes, convert SID bytes back into readable text, and fast-path a few common built-in groups using known SID strings.

It also includes format_last_error, which asks Windows to turn an error number into a human-readable message. Without helpers like these, the rest of the project would repeat fragile low-level code and would be more likely to misquote commands, mis-handle account names, or show confusing error messages.

#### Function details

##### `to_wide`  (lines 19–23)

```
fn to_wide(s: S) -> Vec<u16>
```

**Purpose**: Converts ordinary Rust text into the UTF-16, zero-ended form expected by many Windows system calls. This is like writing a note in the alphabet Windows APIs require and adding a clear end marker.

**Data flow**: It takes any value that can be viewed as an operating-system string. It encodes that string as a list of 16-bit numbers, appends a final zero value to mark the end, and returns the list.

**Call relations**: Many Windows-facing parts of the project call this before passing names, paths, or security labels into Windows APIs. In this file, resolve_sid and sid_bytes_from_string use it before asking Windows to look up or parse a SID.

*Call graph*: called by 21 (add_allow_ace, add_deny_ace, allow_null_device, ensure_allow_mask_aces_with_inheritance_impl, fetch_dacl_handle, revoke_ace, spawn_conpty_process_as_user, prepare, create, spawn_runner_transport (+11 more)); 1 external calls (as_ref).


##### `quote_windows_arg`  (lines 29–65)

```
fn quote_windows_arg(arg: &str) -> String
```

**Purpose**: Quotes one Windows command-line argument so it will be read back as the same argument later. This matters because spaces, quotation marks, and backslashes can change where one argument ends and another begins.

**Data flow**: It receives one argument as text. If the argument is simple, it returns it unchanged. If it contains characters that require quoting, it wraps it in quotes and carefully escapes internal quotes and trailing backslashes so Windows command-line parsing preserves the original text.

**Call relations**: argv_to_command_line uses this for each argument when building a full command line. It mirrors the quoting behavior expected by Windows command-line parsing and Rust's Windows process launching behavior.

*Call graph*: 1 external calls (with_capacity).


##### `argv_to_command_line`  (lines 69–74)

```
fn argv_to_command_line(argv: &[String]) -> String
```

**Purpose**: Turns a list of program arguments into one Windows command-line string suitable for CreateProcess-style APIs. Windows often asks for one command string instead of a neat list of arguments.

**Data flow**: It takes a slice of argument strings. It quotes each argument independently with quote_windows_arg, then joins the quoted pieces with spaces. The result is one command-line string that should parse back into the intended arguments.

**Call relations**: create_process_as_user calls this when it needs to launch a process through a Windows API that expects a command-line string. This function hands off the delicate per-argument quoting to quote_windows_arg.

*Call graph*: called by 1 (create_process_as_user).


##### `format_last_error`  (lines 77–103)

```
fn format_last_error(err: i32) -> String
```

**Purpose**: Turns a Windows error code into a readable message. Instead of showing only a number, it asks Windows for the system's own explanation of that number.

**Data flow**: It takes an integer error code. It calls the Windows FormatMessageW API, receives a temporary Windows-allocated UTF-16 message buffer, converts that buffer into a Rust string, trims extra whitespace, frees the Windows buffer, and returns the message. If Windows cannot provide a message, it returns a simple fallback like "Win32 error 5".

**Call relations**: This is a utility for code that has already received a Windows error code and wants to report it clearly. It delegates the actual lookup to Windows and uses LocalFree to release the memory Windows allocated for the message.

*Call graph*: 7 external calls (from_utf16_lossy, format!, null, null_mut, from_raw_parts, LocalFree, FormatMessageW).


##### `string_from_sid_bytes`  (lines 105–124)

```
fn string_from_sid_bytes(sid: &[u8]) -> Result<String, String>
```

**Purpose**: Converts binary SID data into the familiar text form used in Windows documentation, such as S-1-5-18. A SID is a security identifier: Windows' internal label for a user, group, or special account.

**Data flow**: It receives raw SID bytes. It passes them to Windows, which allocates a UTF-16 string version of the SID. The function measures that zero-ended string, converts it to normal Rust text, frees the Windows-allocated string, and returns either the text or an error message.

**Call relations**: create_named_pipe calls this when it needs a readable version of SID bytes, likely for security setup or diagnostics. The function relies on the Windows ConvertSidToStringSidW API and cleans up with LocalFree afterward.

*Call graph*: called by 1 (create_named_pipe); 6 external calls (from_utf16_lossy, format!, null_mut, from_raw_parts, LocalFree, ConvertSidToStringSidW).


##### `resolve_sid`  (lines 132–168)

```
fn resolve_sid(name: &str) -> Result<Vec<u8>>
```

**Purpose**: Finds the binary SID for a Windows account or group name. This lets other code say "Everyone" or "Administrators" and then give Windows the binary identifier it actually needs for permissions.

**Data flow**: It receives a name. First it checks whether the name is one of a few built-in Windows groups or accounts and, if so, converts that known SID string into bytes. Otherwise it converts the name to a Windows wide string and calls LookupAccountNameW. If Windows says the temporary buffers are too small, it resizes them and tries again. On success it returns the exact SID bytes; on failure it returns an error.

**Call relations**: create_named_pipe calls this when building security rules for a named pipe. Inside this file, it uses well_known_sid_str for built-in shortcuts, sid_bytes_from_string to turn known SID text into bytes, and to_wide before calling the Windows account lookup API.

*Call graph*: calls 3 internal fn (sid_bytes_from_string, to_wide, well_known_sid_str); called by 1 (create_named_pipe); 7 external calls (new, new, anyhow!, null, vec!, GetLastError, LookupAccountNameW).


##### `well_known_sid_str`  (lines 170–179)

```
fn well_known_sid_str(name: &str) -> Option<&'static str>
```

**Purpose**: Recognizes a small set of common Windows account or group names and returns their official SID text. This avoids a system lookup for names that are universal on Windows.

**Data flow**: It receives a name string. If the name exactly matches Administrators, Users, Authenticated Users, Everyone, or SYSTEM, it returns the matching SID string. Otherwise it returns nothing.

**Call relations**: resolve_sid calls this first as a shortcut before doing the heavier Windows account lookup. It is the table of built-in identities that resolve_sid trusts.

*Call graph*: called by 1 (resolve_sid).


##### `sid_bytes_from_string`  (lines 181–206)

```
fn sid_bytes_from_string(sid_str: &str) -> Result<Vec<u8>>
```

**Purpose**: Converts a textual SID, such as S-1-1-0, into the binary SID format Windows permission APIs need. This is used for known identities whose SID text is already available.

**Data flow**: It takes a SID string, converts it to a Windows wide string, and asks Windows to parse it into a SID pointer. It then asks Windows how long the SID is, copies the SID into a Rust-owned byte vector, frees the Windows-allocated SID memory, and returns the byte vector. If parsing, length lookup, or copying fails, it returns an error.

**Call relations**: resolve_sid calls this after well_known_sid_str finds a built-in SID string. It relies on Windows APIs to parse and copy the SID, while to_wide prepares the input string for those APIs.

*Call graph*: calls 1 internal fn (to_wide); called by 1 (resolve_sid); 8 external calls (new, anyhow!, null_mut, vec!, LocalFree, ConvertStringSidToSidW, CopySid, GetLengthSid).


##### `tests::argv_to_command_line_quotes_each_argument_independently`  (lines 214–226)

```
fn argv_to_command_line_quotes_each_argument_independently()
```

**Purpose**: Checks that a complicated command argument containing spaces and embedded quotes is preserved as one argument. This protects against accidentally splitting a nested command into the wrong pieces.

**Data flow**: It builds a sample argument list for cmd.exe where the third argument is itself a quoted PowerShell command. It runs argv_to_command_line and compares the result with the exact command-line string expected by Windows quoting rules.

**Call relations**: This test exercises argv_to_command_line, which in turn depends on quote_windows_arg. It is run during testing, not during normal program execution.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `tests::argv_to_command_line_quotes_regular_program_args`  (lines 229–240)

```
fn argv_to_command_line_quotes_regular_program_args()
```

**Purpose**: Checks that a normal program argument containing quoted text is escaped correctly. This helps ensure a command like writing "hello world" stays one argument with quotes inside it.

**Data flow**: It creates a PowerShell-style argument list, including a command string with embedded quotes. It converts the list with argv_to_command_line and asserts that the produced command line matches the expected safely quoted form.

**Call relations**: This test also covers the path from argv_to_command_line into quote_windows_arg. It guards the process-launching helpers against regressions in Windows command-line quoting.

*Call graph*: 2 external calls (assert_eq!, vec!).
