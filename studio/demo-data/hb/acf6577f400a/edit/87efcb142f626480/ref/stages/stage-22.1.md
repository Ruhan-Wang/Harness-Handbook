# Path, filesystem, environment, and sandbox support utilities  `stage-22.1`

This stage is shared behind-the-scenes support. It gives the rest of the system safe, consistent ways to talk about paths, files, environment variables, terminals, and sandboxes on different operating systems.

Several pieces make path handling dependable. `PathUri`, `LegacyAppPathString`, `AbsolutePathBuf`, and the low-level absolutize code turn messy path text into checked, normalized forms, while still preserving the original spelling when needed. The app-server path wrapper keeps “host machine” path rules separate from the local client’s rules. The general path utilities add comparison-friendly normalization, symlink handling, atomic file replacement, WSL detection, and small helpers used by memories code and core re-exports.

Other files deal with real filesystem access. The filesystem abstraction defines a common interface for local or remote files and carries sandbox permission data. The file watcher reports changes to many listeners. There are helpers for safe regular-file opening, file modification times, symlink creation, locating built binaries, and finding runnable programs.

The rest shapes the runtime environment. Core environment code builds cleaned child-process environments. Terminal detection, clipboard support, and terminal palette selection adapt behavior to SSH, tmux, WSL, and color capabilities. Linux, macOS, and Windows sandbox utilities handle platform-specific path rewriting, log collection, ACL locking, SSH config scanning, and other setup details.

## Files in this stage

### Path identity and conversion
These files define the core path abstractions and conversion layers used to represent absolute paths, canonical file URIs, and API-facing path strings across platforms.

### `utils/path-uri/src/api_path_string.rs`

`domain_logic` · `API boundary`

This file implements the compatibility layer between legacy stringly-typed API paths and the crate’s canonical `PathUri` representation. `LegacyAppPathString` is a transparent serialized wrapper around a private `String`; serde may deserialize any UTF-8 string, but internal code is steered toward construction from `AbsolutePathBuf` or `PathUri`. Conversion is convention-aware through `PathConvention::{Posix,Windows}`. Parsing from string to URI is split into `parse_posix_path` and `parse_windows_path`: POSIX requires a leading slash and falls back to opaque bytes when NUL is present; Windows recognizes drive-rooted paths, UNC paths, and namespace-prefixed paths, using opaque UTF-16LE fallback for namespace or NUL-containing inputs. Rendering from `PathUri` back to native text is similarly split: `render_posix_path` rejects URIs with authorities because POSIX cannot represent UNC hosts, while `render_windows_path` renders either UNC (`\\host\share\...`) or drive-rooted forms and rejects non-Windows-shaped URIs. Opaque fallback bytes are recoverable only when they encode an absolute path for the requested convention; otherwise `LegacyAppPathStringError::OpaqueFallback` is returned. Segment handling is careful: URI path segments are decoded exactly once with `urlencoding::decode_binary`, so `%20` becomes a space but `%252F` remains literal `%2F` rather than turning into a separator. The file also provides schema/serialization/display implementations, convention inference from absolute path spelling, and a platform-specific `PathConvention::native()` helper.

#### Function details

##### `LegacyAppPathString::from_abs_path`  (lines 37–39)

```
fn from_abs_path(path: &AbsolutePathBuf) -> Self
```

**Purpose**: Constructs a legacy API path string from an absolute host-native path buffer using lossy UTF-8 rendering.

**Data flow**: It takes an `&AbsolutePathBuf`, calls `to_string_lossy().into_owned()`, wraps the resulting `String` in `LegacyAppPathString`, and returns it.

**Call relations**: This is used by the `From<AbsolutePathBuf>` impl and by higher-level code that needs to expose native absolute paths at the API boundary without going through `PathUri` first.

*Call graph*: calls 1 internal fn (to_string_lossy); called by 4 (from, additional_file_system_permissions_populates_entries_for_legacy_roots, app_server_exec_approval_request_preserves_permissions_context, app_server_request_permissions_preserves_file_system_permissions).


##### `LegacyAppPathString::from_path_uri`  (lines 48–60)

```
fn from_path_uri(
        path: &PathUri,
        convention: PathConvention,
    ) -> Result<Self, LegacyAppPathStringError>
```

**Purpose**: Renders a canonical `PathUri` into a legacy native-path string under an explicitly chosen path convention.

**Data flow**: It takes a `&PathUri` and `PathConvention`. If the URI carries opaque fallback bytes, it delegates to `render_opaque_fallback` and wraps the resulting string. Otherwise it dispatches to `render_posix_path` or `render_windows_path` based on the convention and wraps the successful rendered string.

**Call relations**: This is the main outward conversion from canonical URI form to API string form. It delegates all convention-specific rendering and opaque-fallback recovery to dedicated helpers.

*Call graph*: calls 4 internal fn (opaque_fallback_bytes, render_opaque_fallback, render_posix_path, render_windows_path); called by 3 (remote_cwd, renders_native_paths_from_shared_cases, serializes_and_deserializes_as_a_string).


##### `LegacyAppPathString::to_path_uri`  (lines 64–76)

```
fn to_path_uri(
        &self,
        convention: PathConvention,
    ) -> Result<PathUri, LegacyAppPathStringError>
```

**Purpose**: Parses the stored API string as an absolute native path under a chosen convention and converts it into a canonical `PathUri`.

**Data flow**: It reads `self.0` and dispatches to `parse_posix_path` or `parse_windows_path` depending on the supplied `PathConvention`. If parsing returns `None`, it constructs `LegacyAppPathStringError::InvalidNativePath { path: self.0.clone(), convention }`; otherwise it returns the parsed `PathUri`.

**Call relations**: This is the inverse of `from_path_uri` for callers that need to canonicalize incoming API strings. It relies entirely on the convention-specific parsers for syntax recognition.

*Call graph*: calls 2 internal fn (parse_posix_path, parse_windows_path).


##### `LegacyAppPathString::infer_absolute_path_convention`  (lines 83–97)

```
fn infer_absolute_path_convention(&self) -> Option<PathConvention>
```

**Purpose**: Infers whether the stored string looks like an absolute POSIX path, an absolute Windows path, or neither.

**Data flow**: It inspects the underlying string bytes. A drive-root pattern like `C:\` or `C:/`, or a leading `\\`, yields `Some(PathConvention::Windows)`; a leading `/` yields `Some(PathConvention::Posix)`; anything else returns `None`.

**Call relations**: This helper is for callers that need a best-effort convention guess before parsing. It does not validate the full path, only its absolute-path spelling.

*Call graph*: 1 external calls (matches!).


##### `LegacyAppPathString::as_str`  (lines 99–101)

```
fn as_str(&self) -> &str
```

**Purpose**: Returns the wrapped path string by shared reference.

**Data flow**: It borrows `self.0` and returns `&str` without allocation or validation.

**Call relations**: This is a simple accessor for read-only consumers of the raw API string.


##### `LegacyAppPathString::into_string`  (lines 103–105)

```
fn into_string(self) -> String
```

**Purpose**: Consumes the wrapper and returns the owned inner path string.

**Data flow**: It takes ownership of `self` and returns `self.0` directly.

**Call relations**: This is the ownership-taking counterpart to `as_str`, used when callers need the raw `String`.


##### `LegacyAppPathString::from`  (lines 109–111)

```
fn from(path: AbsolutePathBuf) -> Self
```

**Purpose**: Implements `From<AbsolutePathBuf>` by delegating to `from_abs_path`.

**Data flow**: It takes ownership of an `AbsolutePathBuf`, borrows it for `from_abs_path`, and returns the resulting `LegacyAppPathString`.

**Call relations**: This trait impl provides ergonomic conversion from absolute paths into the API wrapper and centralizes behavior in `from_abs_path`.

*Call graph*: 1 external calls (from_abs_path).


##### `parse_posix_path`  (lines 114–122)

```
fn parse_posix_path(path: &str) -> Option<PathUri>
```

**Purpose**: Parses an absolute POSIX path string into a `PathUri`, preserving NUL-containing paths as opaque fallback bytes.

**Data flow**: It takes a `&str`, requires and strips a leading `/`, and returns `None` if absent. If the remaining path contains `\0`, it reconstructs the original slash-prefixed bytes and returns `PathUri::from_opaque_path_bytes(...)`. Otherwise it splits on `/` and passes the segments with no host to `path_uri_from_segments`.

**Call relations**: This parser is used by `LegacyAppPathString::to_path_uri` for `PathConvention::Posix`. It delegates normal URL-based URI construction to `path_uri_from_segments`.

*Call graph*: calls 2 internal fn (from_opaque_path_bytes, path_uri_from_segments); called by 1 (to_path_uri); 1 external calls (format!).


##### `parse_windows_path`  (lines 124–160)

```
fn parse_windows_path(path: &str) -> Option<PathUri>
```

**Purpose**: Parses absolute Windows path spellings—including drive-rooted, UNC, and opaque namespace forms—into a `PathUri`.

**Data flow**: It inspects the input bytes. Namespace-prefixed paths like `\\.\` or `\\?\`, or any path containing `\0`, are converted to opaque UTF-16LE bytes via `windows_opaque_path_uri`. Drive-rooted paths like `C:\...` become URI segments beginning with the drive prefix and remaining components split on either slash or backslash. UNC paths beginning with two separators extract host and share, then build a URI with that host and remaining segments; if URI construction fails, they fall back to an opaque Windows path URI. Non-matching inputs return `None`.

**Call relations**: This parser is used by `LegacyAppPathString::to_path_uri` for `PathConvention::Windows`. It delegates standard URI assembly to `path_uri_from_segments` and opaque preservation to `windows_opaque_path_uri`.

*Call graph*: calls 2 internal fn (path_uri_from_segments, windows_opaque_path_uri); called by 1 (to_path_uri); 2 external calls (matches!, once).


##### `path_uri_from_segments`  (lines 162–178)

```
fn path_uri_from_segments(
    host: Option<&str>,
    segments: impl Iterator<Item = &'a str>,
) -> Option<PathUri>
```

**Purpose**: Builds a canonical `PathUri` from an optional host and an iterator of already-separated path segments.

**Data flow**: It parses the base URL `file:///`, optionally sets the host, clears the default path segments, pushes each provided segment into the URL path, then attempts `PathUri::try_from(url)`. Any failure along the way yields `None`; success returns `Some(PathUri)`.

**Call relations**: Both POSIX and Windows parsers use this helper for non-opaque paths so URL assembly and validation are centralized.

*Call graph*: calls 1 internal fn (try_from); called by 2 (parse_posix_path, parse_windows_path); 1 external calls (parse).


##### `windows_opaque_path_uri`  (lines 180–186)

```
fn windows_opaque_path_uri(path: &str) -> PathUri
```

**Purpose**: Encodes a Windows path string as opaque fallback bytes in UTF-16LE and wraps it in a `PathUri`.

**Data flow**: It takes a `&str`, encodes it as UTF-16 code units, flattens each `u16` into little-endian bytes, collects them into a `Vec<u8>`, and returns `PathUri::from_opaque_path_bytes(&path_bytes)`.

**Call relations**: This helper is used by `parse_windows_path` for namespace-prefixed or NUL-containing paths that cannot be safely represented as structured file-URL segments.

*Call graph*: calls 1 internal fn (from_opaque_path_bytes); called by 1 (parse_windows_path).


##### `is_windows_separator_char`  (lines 188–190)

```
fn is_windows_separator_char(character: char) -> bool
```

**Purpose**: Recognizes either slash or backslash as a Windows path separator at the `char` level.

**Data flow**: It takes a `char` and returns `true` for `'\\'` or `'/'`, otherwise `false`.

**Call relations**: This helper is used when splitting Windows path strings into components in `parse_windows_path`.

*Call graph*: 1 external calls (matches!).


##### `is_windows_separator_byte`  (lines 192–194)

```
fn is_windows_separator_byte(character: u8) -> bool
```

**Purpose**: Recognizes either slash or backslash as a Windows path separator at the byte level.

**Data flow**: It takes a `u8` and returns `true` for `b'\\'` or `b'/'`, otherwise `false`.

**Call relations**: This helper supports byte-pattern matching in convention inference and Windows path parsing.

*Call graph*: 1 external calls (matches!).


##### `render_opaque_fallback`  (lines 196–211)

```
fn render_opaque_fallback(
    path: &PathUri,
    path_bytes: &[u8],
    convention: PathConvention,
) -> Result<String, LegacyAppPathStringError>
```

**Purpose**: Attempts to recover a native path string from opaque fallback bytes according to a requested convention.

**Data flow**: It takes the original `PathUri`, opaque byte slice, and `PathConvention`. For POSIX it succeeds only when the bytes start with `/`, decoding them lossily as UTF-8. For Windows it delegates to `render_windows_opaque_fallback`. If no valid rendering is possible, it returns `LegacyAppPathStringError::OpaqueFallback { path: path.to_string() }`.

**Call relations**: This helper is called by `LegacyAppPathString::from_path_uri` whenever the URI stores opaque fallback bytes instead of structured segments.

*Call graph*: calls 1 internal fn (render_windows_opaque_fallback); called by 1 (from_path_uri); 1 external calls (from_utf8_lossy).


##### `render_windows_opaque_fallback`  (lines 213–238)

```
fn render_windows_opaque_fallback(path_bytes: &[u8]) -> Option<String>
```

**Purpose**: Decodes opaque fallback bytes as a UTF-16LE Windows absolute path if they represent a rooted drive, UNC, or namespace path.

**Data flow**: It takes a byte slice, rejects odd lengths, decodes pairs into `u16` values, and checks whether the resulting wide string begins with a drive root like `C:\` or with two separators indicating UNC/namespace form. If so it returns `Some(String::from_utf16_lossy(&path_wide))`; otherwise it returns `None`.

**Call relations**: This helper is used only by `render_opaque_fallback` for Windows convention recovery.

*Call graph*: called by 1 (render_opaque_fallback); 1 external calls (matches!).


##### `is_windows_separator`  (lines 240–242)

```
fn is_windows_separator(character: u16) -> bool
```

**Purpose**: Recognizes slash or backslash as a Windows separator in UTF-16 code-unit form.

**Data flow**: It takes a `u16` and compares it to the UTF-16 values of `'\\'` and `'/'`, returning a boolean.

**Call relations**: This helper supports wide-character prefix checks in `render_windows_opaque_fallback`.

*Call graph*: 1 external calls (from).


##### `LegacyAppPathString::fmt`  (lines 245–247)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Formats the wrapper for display by writing the raw inner path string.

**Data flow**: It borrows `self.0` and writes it into the provided formatter with `write_str`, returning the formatter result.

**Call relations**: This `Display` impl lets the wrapper print exactly as its contained string without additional quoting or normalization.

*Call graph*: 1 external calls (write_str).


##### `LegacyAppPathString::serialize`  (lines 251–256)

```
fn serialize(&self, serializer: S) -> Result<S::Ok, S::Error>
```

**Purpose**: Serializes the wrapper as a plain JSON/string value containing the raw path text.

**Data flow**: It borrows `self.0` and passes it to `serializer.serialize_str`, returning the serializer’s result.

**Call relations**: This custom `Serialize` impl matches the type’s transparent API-boundary role and complements serde-derived deserialization.

*Call graph*: 1 external calls (serialize_str).


##### `LegacyAppPathString::schema_name`  (lines 260–262)

```
fn schema_name() -> String
```

**Purpose**: Provides the schema name used when generating JSON Schema for this wrapper type.

**Data flow**: It returns the fixed string `"LegacyAppPathString"` as an owned `String`.

**Call relations**: This is part of the `JsonSchema` implementation and is used by schema-generation tooling.


##### `LegacyAppPathString::json_schema`  (lines 264–266)

```
fn json_schema(generator: &mut schemars::r#gen::SchemaGenerator) -> schemars::schema::Schema
```

**Purpose**: Declares that the JSON schema for this wrapper is the same as a plain string schema.

**Data flow**: It takes a mutable schema generator reference and returns `String::json_schema(generator)`.

**Call relations**: This complements `schema_name` in the `JsonSchema` impl, ensuring API consumers see this type as a string in generated schemas.

*Call graph*: 1 external calls (json_schema).


##### `render_posix_path`  (lines 269–285)

```
fn render_posix_path(path: &PathUri) -> Result<String, LegacyAppPathStringError>
```

**Purpose**: Renders a structured `PathUri` as a POSIX absolute path string, rejecting URIs with authorities that would lose host information.

**Data flow**: It converts the `PathUri` to a URL, returns `IncompatibleConvention` if `url.host_str()` is present, then iterates URL path segments, prepending `/` and appending each segment after `decode_native_segment`. It returns the assembled path string.

**Call relations**: This renderer is selected by `LegacyAppPathString::from_path_uri` for `PathConvention::Posix` when no opaque fallback is present.

*Call graph*: calls 4 internal fn (to_url, decode_native_segment, incompatible_convention, path_segments); called by 1 (from_path_uri); 1 external calls (new).


##### `render_windows_path`  (lines 287–334)

```
fn render_windows_path(path: &PathUri) -> Result<String, LegacyAppPathStringError>
```

**Purpose**: Renders a structured `PathUri` as a Windows absolute path string in either UNC or drive-rooted form.

**Data flow**: It converts the `PathUri` to a URL and iterates path segments. If the URL has a host, it requires a non-empty first segment as the share name and builds `\\host\share...`; otherwise it requires the first segment to decode to a drive designator like `C:` and builds `C:\...`. Remaining segments are decoded individually and joined with backslashes. If the rendered result is only a drive like `C:`, it appends a trailing backslash to represent the drive root. Invalid shapes return `IncompatibleConvention`.

**Call relations**: This renderer is selected by `LegacyAppPathString::from_path_uri` for `PathConvention::Windows` when no opaque fallback is present.

*Call graph*: calls 4 internal fn (to_url, decode_native_segment, incompatible_convention, path_segments); called by 1 (from_path_uri); 1 external calls (new).


##### `path_segments`  (lines 336–339)

```
fn path_segments(url: &url::Url) -> std::str::Split<'_, char>
```

**Purpose**: Extracts path segments from a validated file URL, asserting that such URLs always have segment access.

**Data flow**: It takes a `&url::Url`, calls `url.path_segments()`, and unwraps it with an `unreachable!` fallback, returning the resulting `Split<'_, char>` iterator.

**Call relations**: Both renderers use this helper to avoid repeating the assumption that validated file URLs always expose path segments.

*Call graph*: called by 2 (render_posix_path, render_windows_path); 1 external calls (path_segments).


##### `decode_native_segment`  (lines 341–346)

```
fn decode_native_segment(segment: &str) -> String
```

**Purpose**: Decodes one URL path segment exactly once into lossy UTF-8 native text.

**Data flow**: It takes a percent-encoded segment string, decodes raw bytes with `urlencoding::decode_binary`, converts them with `String::from_utf8_lossy`, and returns the owned `String`.

**Call relations**: This helper is used by both POSIX and Windows renderers so segment decoding is consistent and does not accidentally decode separators twice.

*Call graph*: called by 2 (render_posix_path, render_windows_path); 2 external calls (from_utf8_lossy, decode_binary).


##### `incompatible_convention`  (lines 348–353)

```
fn incompatible_convention(path: &PathUri, convention: PathConvention) -> LegacyAppPathStringError
```

**Purpose**: Constructs a standardized `IncompatibleConvention` error for a `PathUri` that cannot be rendered under a requested path syntax.

**Data flow**: It takes a `&PathUri` and `PathConvention`, converts the URI to string form, and returns `LegacyAppPathStringError::IncompatibleConvention { path, convention }`.

**Call relations**: This helper is used by both renderers to centralize error construction for convention-mismatch cases.

*Call graph*: called by 2 (render_posix_path, render_windows_path); 1 external calls (to_string).


##### `PathConvention::native`  (lines 392–394)

```
fn native() -> Self
```

**Purpose**: Returns the path convention corresponding to the current build target’s operating-system family.

**Data flow**: On Windows builds it returns `PathConvention::Windows`; on Unix builds it returns `PathConvention::Posix`.

**Call relations**: This platform-specific associated function is used elsewhere in the crate when callers want the host-native convention without branching themselves.

*Call graph*: called by 2 (try_from, path_convention).


##### `PathConvention::fmt`  (lines 398–403)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Formats a path convention as a human-readable name for error messages and display.

**Data flow**: It matches `self` and writes either `"POSIX"` or `"Windows"` into the formatter.

**Call relations**: This `Display` impl is used implicitly in error messages such as `InvalidNativePath` and `IncompatibleConvention`.

*Call graph*: 1 external calls (write_str).


### `utils/path-uri/src/lib.rs`

`domain_logic` · `cross-cutting path parsing and conversion`

This file is the core implementation of the `path-uri` crate. Its main type, `PathUri(Url)`, stores a validated `url::Url` restricted to the `file` scheme and exposes cross-platform lexical operations that do not depend on the current host OS. Construction flows through `parse`, `TryFrom<Url>`, `from_path`, or `from_abs_path`. `TryFrom<Url>` enforces invariants: only `file:` is accepted; credentials, ports, queries, and fragments are rejected; encoded null bytes are forbidden unless the URI is in the reserved opaque fallback namespace; and `localhost` authority is canonicalized away.

The fallback namespace `file:///%00/bad/path/<base64>` is central: `from_abs_path` uses it when `Url::from_file_path` cannot represent an absolute native path, encoding raw Unix bytes or Windows UTF-16LE bytes. `to_abs_path` reverses that process only if the decoded payload forms an absolute path and re-encodes back to the same URI, preventing malformed payloads from being treated as valid paths. Lexical helpers `basename`, `parent`, and `join` operate on URI segments and intentionally treat fallback URIs as opaque. `infer_path_convention` classifies ordinary URIs as Windows when they have an authority or drive-shaped first segment, otherwise POSIX; fallback URIs are inferred from raw payload bytes. The file also provides serde, `Display`, `FromStr`, and JSON schema integration, with deserialization accepting either canonical `file:` strings or legacy absolute native paths.

#### Function details

##### `PathUri::parse`  (lines 62–64)

```
fn parse(uri: &str) -> Result<Self, PathUriParseError>
```

**Purpose**: Parses a string into a validated canonical `PathUri`. It is the main entry for `file:` URI text coming from callers and tests.

**Data flow**: Accepts `&str` URI text, feeds it to `Url::parse`, then passes the resulting `Url` through `TryFrom<Url>` validation and canonicalization. It returns either `Ok(PathUri)` or a `PathUriParseError` describing invalid syntax, unsupported scheme, or forbidden URI components.

**Call relations**: Widely invoked by tests and higher-level code whenever URI text is supplied directly. After raw URL parsing, it delegates all semantic checks to `TryFrom<Url>` so every construction path shares the same validation rules.

*Call graph*: called by 30 (remote_cwd, helper_protocol_uses_path_uris, non_native_cwd, non_native_uri, start_process_rejects_non_native_cwd_before_launch, non_native_cwd, non_native_uri, renders_native_paths_from_shared_cases, serializes_and_deserializes_as_a_string, bad_path_uris_are_opaque_to_lexical_operations (+15 more)); 1 external calls (parse).


##### `PathUri::from_abs_path`  (lines 76–98)

```
fn from_abs_path(path: &AbsolutePathBuf) -> Self
```

**Purpose**: Converts an absolute host-native path into a `PathUri`, using a normal `file:` URL when possible and an opaque fallback URI otherwise. This is the crate's lossless bridge from native filesystem paths into transport-safe URI form.

**Data flow**: Reads the provided `AbsolutePathBuf` as a `Path`, first attempting `Url::from_file_path` and then `Self::try_from(url)` to validate/canonicalize the result. If either step fails, it extracts raw path bytes from the native path (`OsStrExt::as_bytes` on Unix or UTF-16LE bytes from `encode_wide` on Windows) and passes them to `from_opaque_path_bytes`, returning the resulting fallback `PathUri`.

**Call relations**: Called by filesystem-facing code and by `from_path`, serde fallback paths, and tests. It prefers ordinary URLs but delegates to `from_opaque_path_bytes` specifically for paths that native URL conversion cannot represent.

*Call graph*: calls 1 internal fn (as_path); called by 100 (copy, create_directory, get_metadata, read_directory, read_file, remove, write_file, apply_hunks_to_files, derive_new_contents_from_chunks, ensure_not_directory (+15 more)); 3 external calls (from_opaque_path_bytes, try_from, from_file_path).


##### `PathUri::from_opaque_path_bytes`  (lines 100–106)

```
fn from_opaque_path_bytes(path_bytes: &[u8]) -> Self
```

**Purpose**: Builds a canonical fallback `PathUri` from raw native path bytes. It encapsulates the reserved `%00/bad/path/` namespace and URL-safe base64 encoding.

**Data flow**: Takes a byte slice, base64-encodes it with URL-safe no-padding rules, formats `file:///%00/bad/path/<encoded>`, parses that string with `Self::parse`, and returns the resulting `PathUri`. The `unreachable!` branch asserts that this generated spelling is always valid.

**Call relations**: Used internally by `from_abs_path` after ordinary URL conversion fails. Tests also rely on the exact fallback shape this helper produces when checking opaque-path round trips.

*Call graph*: called by 2 (parse_posix_path, windows_opaque_path_uri); 3 external calls (parse, format!, unreachable!).


##### `PathUri::from_path`  (lines 113–117)

```
fn from_path(path: impl AsRef<Path>) -> io::Result<Self>
```

**Purpose**: Converts an arbitrary path-like input into a `PathUri`, rejecting relative paths up front. It is the ergonomic API for callers that may not already hold an `AbsolutePathBuf`.

**Data flow**: Accepts any `AsRef<Path>`, validates absoluteness with `AbsolutePathBuf::from_absolute_path_checked`, maps that validation failure into `io::ErrorKind::InvalidInput`, and on success forwards to `from_abs_path`. It returns `io::Result<PathUri>`.

**Call relations**: Called by higher-level file operations that accept generic paths. It exists as a thin adapter around `AbsolutePathBuf` validation plus `from_abs_path` conversion.

*Call graph*: calls 1 internal fn (from_absolute_path_checked); called by 89 (create_dir_all, read_file_text, write_file, fresh_thread_composes_global_before_project_and_reports_sources, multi_environment_thread_loads_every_project_and_keeps_creation_snapshot, apply_patch_turn_diff_tracks_local_and_remote_environment_paths, apply_patch_approvals_are_remembered_per_environment, apply_patch_freeform_routes_to_selected_remote_environment, apply_patch_intercepted_exec_command_routes_to_selected_remote_environment, exec_command_routes_to_selected_remote_environment (+15 more)); 1 external calls (from_abs_path).


##### `PathUri::encoded_path`  (lines 123–125)

```
fn encoded_path(&self) -> &str
```

**Purpose**: Returns the URL path component exactly as stored, including percent escapes and excluding any authority. This is the low-level lexical view used by tests and internal helpers.

**Data flow**: Reads the inner `Url` and returns `self.0.path()` as `&str` without allocation or mutation.

**Call relations**: Used by `parent` and tests that need to inspect canonical URI spelling rather than decoded native text.

*Call graph*: called by 1 (parent).


##### `PathUri::opaque_fallback_bytes`  (lines 127–129)

```
fn opaque_fallback_bytes(&self) -> Option<Vec<u8>>
```

**Purpose**: Exposes the decoded payload bytes when the URI is in the reserved opaque fallback namespace. Ordinary file URIs return `None`.

**Data flow**: Reads the inner `Url`, passes it to `decode_bad_path_uri`, and returns the resulting `Option<Vec<u8>>`.

**Call relations**: Used by `infer_path_convention` and API-path rendering code to distinguish fallback URIs from ordinary hierarchical file URIs.

*Call graph*: calls 1 internal fn (decode_bad_path_uri); called by 2 (infer_path_convention, from_path_uri).


##### `PathUri::infer_path_convention`  (lines 147–165)

```
fn infer_path_convention(&self) -> Option<PathConvention>
```

**Purpose**: Heuristically classifies the URI as representing a POSIX path or a Windows path. It intentionally favors recognizing foreign Windows spellings such as `file:///C:/...`.

**Data flow**: First checks `opaque_fallback_bytes`; if present, it delegates to `infer_opaque_path_convention` on the raw payload. Otherwise it inspects the URL authority and path segments: any host implies Windows UNC, and a first non-empty segment matching `<letter>:` implies Windows drive syntax; all other ordinary file URIs are classified as POSIX. It returns `Option<PathConvention>`.

**Call relations**: Called by tests and by API-path conversion logic that needs a convention hint. It branches early on fallback URIs because their path text no longer carries reliable lexical structure.

*Call graph*: calls 2 internal fn (opaque_fallback_bytes, infer_opaque_path_convention).


##### `PathUri::basename`  (lines 172–181)

```
fn basename(&self) -> Option<String>
```

**Purpose**: Returns the final decoded path segment for ordinary hierarchical URIs. It suppresses lexical inspection for roots and opaque fallback URIs.

**Data flow**: Checks `decode_bad_path_uri(&self.0)` and returns `None` if the URI is a fallback. Otherwise it iterates `path_segments()`, finds the last non-empty segment, decodes it with `decode_uri_path`, and returns `Some(String)`; root URIs yield `None`.

**Call relations**: Used by tests and callers needing filename-like lexical inspection. It deliberately avoids interpreting fallback payloads because those URIs are meant only for native round-trip conversion.

*Call graph*: calls 1 internal fn (decode_bad_path_uri).


##### `PathUri::parent`  (lines 185–199)

```
fn parent(&self) -> Option<Self>
```

**Purpose**: Computes the lexical parent URI by removing the last path segment while preserving scheme and authority. It treats root and fallback URIs as having no parent.

**Data flow**: Returns `None` if `encoded_path()` is `/` or if `decode_bad_path_uri(&self.0)` identifies a fallback URI. Otherwise it clones the inner `Url`, obtains mutable path segments, removes a trailing empty segment if present and then pops one segment, and wraps the modified URL in `PathUri`.

**Call relations**: Called by tests and any code performing URI-hierarchy navigation. It relies on validated file URLs supporting hierarchical path mutation, hence the `unreachable!` assertion around `path_segments_mut`.

*Call graph*: calls 2 internal fn (encoded_path, decode_bad_path_uri); 1 external calls (unreachable!).


##### `PathUri::join`  (lines 209–246)

```
fn join(&self, path: &str) -> Result<Self, PathUriParseError>
```

**Purpose**: Lexically appends a relative URI path onto the current URI, normalizing `.` and `..` segments and percent-encoding filename characters through `Url` segment handling. It rejects absolute joins, embedded nulls, and non-empty joins onto opaque fallback URIs.

**Data flow**: Accepts a relative path string. If it starts with `/`, returns `JoinPathMustBeRelative`; if it contains `\0`, returns `InvalidFileUriPath`; if empty, returns `self.clone()`. For fallback URIs, any non-empty join returns `InvalidFileUriPath` using the URI string. Otherwise it clones the URL, mutates path segments by ignoring empty/`.` components, popping on `..`, and pushing all other components, then validates the result via `Self::try_from(url)`.

**Call relations**: Used by tests and lexical path-building code. It sits on top of URL segment mutation and reuses `TryFrom<Url>` at the end so joined results still satisfy all file-URI invariants.

*Call graph*: calls 1 internal fn (decode_bad_path_uri); 3 external calls (try_from, unreachable!, JoinPathMustBeRelative).


##### `PathUri::to_abs_path`  (lines 258–309)

```
fn to_abs_path(&self) -> io::Result<AbsolutePathBuf>
```

**Purpose**: Converts a `PathUri` back into an absolute path on the current host, including decoding opaque fallback URIs created from native paths. It rejects URIs that are not representable under the host's path rules.

**Data flow**: If `decode_bad_path_uri(&self.0)` returns bytes, it decodes them into a native `PathBuf` (`OsString::from_vec` on Unix or UTF-16LE `OsString::from_wide` on Windows when the byte length is even), validates absoluteness with `AbsolutePathBuf::from_absolute_path_checked`, and then re-encodes with `Self::from_abs_path` to ensure the URI matches exactly before returning the path. If any fallback step fails, it returns `io::ErrorKind::InvalidInput`. For ordinary URIs it calls `Url::to_file_path`, then validates the resulting path as absolute and maps failures to the same invalid-input error.

**Call relations**: Called by filesystem-facing code that needs a host-native path. It is the inverse of `from_abs_path`, with extra round-trip verification for fallback payloads to prevent malformed opaque URIs from decoding into unintended paths.

*Call graph*: calls 2 internal fn (from_absolute_path_checked, decode_bad_path_uri); called by 22 (canonicalize, read_file, get_metadata, read_file, get_metadata, read_file, native_sandbox_cwd, canonicalize, copy, create_directory (+12 more)); 4 external calls (from_abs_path, new, from_vec, from).


##### `PathUri::to_url`  (lines 312–314)

```
fn to_url(&self) -> Url
```

**Purpose**: Returns a clone of the validated canonical `Url` stored inside `PathUri`. This exposes the underlying URL object without allowing mutation of the original wrapper.

**Data flow**: Clones `self.0` and returns the new `Url` value.

**Call relations**: Used by rendering code and tests that need direct access to the canonical URL after validation and localhost normalization.

*Call graph*: called by 2 (render_posix_path, render_windows_path).


##### `PathUri::try_from`  (lines 335–337)

```
fn try_from(uri: String) -> Result<Self, Self::Error>
```

**Purpose**: Validates a parsed `Url` as a canonical `file:` URI and wraps it as `PathUri`. This is the semantic gatekeeper shared by all URI construction paths.

**Data flow**: Reads the URL scheme and returns `UnsupportedScheme` unless it equals `FILE_SCHEME`. It then calls `validate_file_url` to reject credentials, ports, query, fragment, and illegal null-containing paths, canonicalizes away `localhost` authority via `without_localhost_authority`, and returns `Ok(PathUri(url))`.

**Call relations**: Reached from `parse`, `from_abs_path`, and serde deserialization after raw URL parsing. It centralizes validation so all callers observe the same canonicalization and error behavior.

*Call graph*: calls 2 internal fn (validate_file_url, without_localhost_authority); called by 1 (path_uri_from_segments); 3 external calls (parse, scheme, UnsupportedScheme).


##### `PathUri::deserialize`  (lines 341–370)

```
fn deserialize(deserializer: D) -> Result<Self, D::Error>
```

**Purpose**: Implements serde deserialization for `PathUri`, accepting either canonical `file:` URI strings or legacy absolute native path strings. It rejects relative paths and unsupported URI schemes with informative errors.

**Data flow**: Deserializes the input as a `String`. It first tries `Url::parse(&value)`: if that succeeds, it attempts `Self::try_from(url)` and returns the URI on success; unsupported-scheme errors are remembered because Windows drive paths can be misparsed as URI schemes. If URL parsing reports `RelativeUrlWithoutBase`, it falls through to native-path handling; other URL parse errors become `InvalidUri`. Native-path handling validates the string with `AbsolutePathBuf::from_absolute_path_checked`; on success it returns `Self::from_abs_path(&path)`, and on failure it emits either the path error or the earlier unsupported-scheme message.

**Call relations**: Invoked automatically by serde. It first prefers real URI parsing, then conditionally delegates to absolute-path validation and `from_abs_path` for backward compatibility with older JSON fields.

*Call graph*: calls 1 internal fn (from_absolute_path_checked); 6 external calls (from_abs_path, try_from, deserialize, parse, custom, InvalidUri).


##### `PathUri::from_str`  (lines 376–378)

```
fn from_str(uri: &str) -> Result<Self, Self::Err>
```

**Purpose**: Provides `FromStr` support by forwarding directly to `parse`. This lets callers use standard string parsing APIs for `PathUri`.

**Data flow**: Accepts `&str`, calls `Self::parse(uri)`, and returns the same `Result<Self, PathUriParseError>`.

**Call relations**: Used by generic parsing contexts and tests; it is a thin convenience wrapper over `parse`.

*Call graph*: 1 external calls (parse).


##### `PathUri::fmt`  (lines 382–384)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Formats the `PathUri` as its canonical URI string. Display output is exactly the inner validated URL spelling.

**Data flow**: Delegates formatting to `self.0.fmt(f)` and returns the resulting `fmt::Result`.

**Call relations**: Used implicitly by `to_string()`, error messages, and tests that compare canonical URI text.


##### `PathUri::serialize`  (lines 388–393)

```
fn serialize(&self, serializer: S) -> Result<S::Ok, S::Error>
```

**Purpose**: Implements serde serialization as a JSON string containing the canonical URI. This keeps wire format stable and language-agnostic.

**Data flow**: Reads `self.0.as_str()` and passes it to `serializer.serialize_str`, returning the serializer's result.

**Call relations**: Invoked automatically during serde output; paired with `deserialize`, though deserialization is intentionally more permissive than serialization.

*Call graph*: 1 external calls (serialize_str).


##### `PathUri::schema_name`  (lines 397–399)

```
fn schema_name() -> String
```

**Purpose**: Supplies the schema type name used by `schemars`. It labels the serialized form as `PathUri`.

**Data flow**: Returns the owned string `"PathUri"` with no external reads or writes.

**Call relations**: Called by schema generation tooling alongside `json_schema`.


##### `PathUri::json_schema`  (lines 401–403)

```
fn json_schema(generator: &mut schemars::r#gen::SchemaGenerator) -> schemars::schema::Schema
```

**Purpose**: Declares that `PathUri` has the same JSON schema shape as a string. The semantic constraints live in runtime validation rather than schema structure.

**Data flow**: Ignores `PathUri` internals and delegates to `String::json_schema(generator)`, returning the resulting schema.

**Call relations**: Used by schema generation; complements `schema_name` by exposing the serialized representation rather than the Rust wrapper type.

*Call graph*: 1 external calls (json_schema).


##### `without_localhost_authority`  (lines 407–414)

```
fn without_localhost_authority(mut url: Url) -> Url
```

**Purpose**: Canonicalizes `file://localhost/...` to `file:///...` while preserving non-local authorities such as UNC hosts. This collapses equivalent local spellings into one representation.

**Data flow**: Takes ownership of a `Url`, checks `host_str()`, and if it equals `Some("localhost")` calls `set_host(None)` before returning the possibly modified URL.

**Call relations**: Called only from `TryFrom<Url>` after validation, so all successfully constructed `PathUri`s share the same localhost-free canonical form.

*Call graph*: called by 1 (try_from); 3 external calls (host_str, set_host, unreachable!).


##### `decode_uri_path`  (lines 421–425)

```
fn decode_uri_path(path: &str) -> String
```

**Purpose**: Decodes a URI path segment to UTF-8 text when possible, but preserves the original percent-encoded spelling if decoding would fail. This avoids losing visibility into non-UTF-8 segments during lexical inspection.

**Data flow**: Accepts a percent-encoded path string, runs `urlencoding::decode`, converts a successful `Cow<str>` into an owned `String`, and on decode failure returns `path.to_string()` unchanged.

**Call relations**: Used by `basename` so lexical segment inspection is human-readable for valid UTF-8 while still stable for invalid byte sequences.

*Call graph*: 1 external calls (decode).


##### `decode_bad_path_uri`  (lines 428–439)

```
fn decode_bad_path_uri(url: &Url) -> Option<Vec<u8>>
```

**Purpose**: Recognizes canonical opaque fallback URIs and extracts their original native path bytes. It rejects malformed or non-canonical lookalikes.

**Data flow**: Reads `url.as_str()`, strips the `BAD_PATH_URI_PREFIX`, rejects empty payloads or payloads containing `/`, base64-decodes the remainder with URL-safe no-padding rules, then re-encodes the bytes and returns them only if the spelling matches exactly. Otherwise it returns `None`.

**Call relations**: This helper underpins fallback handling throughout the file: `basename`, `parent`, `join`, `opaque_fallback_bytes`, `to_abs_path`, and `validate_file_url` all use it to distinguish real fallback URIs from ordinary paths that merely resemble them.

*Call graph*: called by 6 (basename, join, opaque_fallback_bytes, parent, to_abs_path, validate_file_url); 1 external calls (as_str).


##### `is_windows_drive_uri_segment`  (lines 441–443)

```
fn is_windows_drive_uri_segment(segment: &str) -> bool
```

**Purpose**: Checks whether a URI path segment has the exact `<ASCII letter>:` shape used for Windows drive roots. It is a narrow lexical predicate.

**Data flow**: Matches the segment's bytes against `[drive, b':']` and returns `true` only when `drive.is_ascii_alphabetic()`.

**Call relations**: Used by `infer_path_convention` when scanning the first non-empty URI segment of ordinary file URIs.

*Call graph*: 1 external calls (matches!).


##### `infer_opaque_path_convention`  (lines 445–462)

```
fn infer_opaque_path_convention(path_bytes: &[u8]) -> Option<PathConvention>
```

**Purpose**: Infers POSIX or Windows convention from raw fallback payload bytes. It recognizes absolute POSIX byte prefixes and absolute Windows UTF-16LE prefixes.

**Data flow**: If the byte slice starts with `/`, it returns `Some(Posix)`. Otherwise it requires an even byte length, decodes the first two UTF-16LE code units, and returns `Some(Windows)` when they indicate either a drive prefix like `C:` or a UNC prefix `\\`; all other payloads yield `None`.

**Call relations**: Called only from `infer_path_convention` for opaque fallback URIs, where ordinary URL authority/path heuristics no longer apply.

*Call graph*: called by 1 (infer_path_convention); 2 external calls (from, try_from).


##### `validate_common_known_uri`  (lines 465–479)

```
fn validate_common_known_uri(url: &Url) -> Result<(), PathUriParseError>
```

**Purpose**: Rejects URI metadata that is meaningless or unsupported for `file:` URIs in this crate. It enforces a narrow accepted subset before path-specific checks run.

**Data flow**: Reads `username`, `password`, `port`, `query`, and `fragment` from the `Url`. It returns the corresponding `PathUriParseError` when any are present, otherwise `Ok(())`.

**Call relations**: Used by `validate_file_url` as the first validation phase before checking path-byte restrictions.

*Call graph*: called by 1 (validate_file_url); 5 external calls (fragment, password, port, query, username).


##### `validate_file_url`  (lines 482–494)

```
fn validate_file_url(url: &Url) -> Result<(), PathUriParseError>
```

**Purpose**: Applies all semantic validation for candidate `file:` URLs, including rejection of encoded null bytes outside the reserved fallback namespace. This is the final gate before a `Url` becomes a `PathUri`.

**Data flow**: Calls `validate_common_known_uri(url)` first. It then percent-decodes the URL path bytes with `decode_binary(url.path().as_bytes())`; if the decoded bytes contain `0` and `decode_bad_path_uri(url)` does not recognize a canonical fallback URI, it returns `InvalidFileUriPath { path: url.to_string() }`. Otherwise it returns `Ok(())`.

**Call relations**: Called from `TryFrom<Url>` for every parsed or generated URL. It relies on `decode_bad_path_uri` so the reserved fallback namespace remains legal while ordinary `%00` path bytes are rejected.

*Call graph*: calls 2 internal fn (decode_bad_path_uri, validate_common_known_uri); called by 1 (try_from); 3 external calls (path, to_string, decode_binary).


### `utils/absolute-path/src/lib.rs`

`data_model` · `cross-cutting path construction and config deserialization`

This file is the main implementation of the absolute-path utility crate. Its core type, `AbsolutePathBuf(PathBuf)`, guarantees paths are absolute and lexically normalized, though not necessarily canonicalized or existing. Construction flows all pass through home-directory expansion (`~`, `~/...`, and on Windows `~\...`), Windows device-path normalization that strips supported verbatim prefixes like `\\?\D:\...` and `\\?\UNC\...`, and the lower-level `absolutize` helpers from the sibling module. The API offers explicit-base resolution, current-directory resolution, checked absolute-only construction, joining, parent/ancestor traversal, and conversions to `&Path`, `PathBuf`, lossy strings, and display wrappers. Two public canonicalization helpers preserve the logical path when full canonicalization would rewrite through a nested symlink; they intentionally still allow top-level aliases such as `/var -> /private/var` to canonicalize by only preserving paths whose symlinked ancestor is not near the root. Deserialization is special: a thread-local `ABSOLUTE_PATH_BASE` stores an optional base path set by `AbsolutePathBufGuard`, allowing relative paths in config files to be resolved consistently during single-threaded serde operations; without a guard, only already-absolute inputs are accepted. The file also includes test-only helpers for constructing platform-absolute paths from Unix-style literals and a broad test suite covering cwd independence, alias handling, symlink preservation, and deserialization behavior.

#### Function details

##### `AbsolutePathBuf::maybe_expand_home_directory`  (lines 27–43)

```
fn maybe_expand_home_directory(path: &Path) -> PathBuf
```

**Purpose**: Expands leading `~` syntax into the user's home directory when possible. It supports bare `~`, Unix-style `~/subpath`, and Windows-style `~\subpath` on Windows, while leaving all other paths unchanged.

**Data flow**: Reads `path: &Path`, converts it to UTF-8 with `to_str()`, reads the home directory via `dirs::home_dir()`, and checks string prefixes. If expansion applies, it returns a new `PathBuf` rooted at the home directory with trimmed separators removed from the remainder; otherwise it returns `path.to_path_buf()` unchanged.

**Call relations**: This private helper is called at the start of `resolve_path_against_base`, `from_absolute_path`, and `from_absolute_path_checked` so all constructors share the same `~` semantics before platform normalization and absolutization.

*Call graph*: 4 external calls (to_path_buf, to_str, cfg!, home_dir).


##### `AbsolutePathBuf::resolve_path_against_base`  (lines 45–56)

```
fn resolve_path_against_base(
        path: P,
        base_path: B,
    ) -> Self
```

**Purpose**: Constructs an `AbsolutePathBuf` by resolving an arbitrary path against an explicit base path. It is the infallible constructor used when the caller already knows the base directory.

**Data flow**: Accepts generic `path` and `base_path` arguments implementing `AsRef<Path>`, expands `~` in the input path, normalizes both path and base for platform quirks, then passes them to `absolutize::absolutize_from`. It wraps the resulting normalized absolute `PathBuf` in `AbsolutePathBuf` and returns it.

**Call relations**: Many higher-level callers use this as the standard relative-resolution primitive, including config loading and path joins. Internally it delegates to `maybe_expand_home_directory`, `normalize_path_for_platform`, and finally the lower-level absolutizer.

*Call graph*: calls 2 internal fn (absolutize_from, normalize_path_for_platform); called by 53 (config_batch_write_applies_multiple_edits, config_value_write_replaces_value, apply_hunks_to_files, resolve_path, create_test_cache, new, create_test_cache, home_relative_path_fields_are_allowed_and_resolved, relative_absolute_path_fields_resolve_against_base_dir, load_config_layers_state (+15 more)); 3 external calls (as_ref, as_ref, maybe_expand_home_directory).


##### `AbsolutePathBuf::from_absolute_path`  (lines 58–62)

```
fn from_absolute_path(path: P) -> std::io::Result<Self>
```

**Purpose**: Builds an `AbsolutePathBuf` from a path that may already be absolute or may need resolution against the current working directory. It is the general fallible constructor that tolerates relative input.

**Data flow**: Reads a generic path argument, expands `~`, normalizes platform-specific syntax, then calls `absolutize::absolutize`, which may read `std::env::current_dir()` if the path is relative. It returns `Ok(AbsolutePathBuf)` on success or propagates any I/O error from cwd lookup.

**Call relations**: This constructor is widely used by runtime code that accepts user-supplied paths. It delegates to the lower-level absolutizer and is itself reused by `current_dir`, `TryFrom` impls, and the canonicalization helpers.

*Call graph*: calls 2 internal fn (absolutize, normalize_path_for_platform); called by 271 (remote_unix_socket_typed_request_roundtrip_works, app_server_control_socket_path, app_server_startup_lock_path, absolute_path, test_socket_path, test_startup_lock_path, request_permissions_response_accepts_explicit_child_grant_for_requested_cwd_scope, request_permissions_response_ignores_broader_cwd_grant_for_requested_child_path, request_permissions_response_rejects_child_grant_outside_requested_cwd_scope, apply_edits (+15 more)); 2 external calls (as_ref, maybe_expand_home_directory).


##### `AbsolutePathBuf::from_absolute_path_checked`  (lines 64–78)

```
fn from_absolute_path_checked(path: P) -> std::io::Result<Self>
```

**Purpose**: Constructs an `AbsolutePathBuf` only if the supplied path is already absolute after home and platform normalization. It rejects relative input with `InvalidInput` instead of consulting the current directory.

**Data flow**: Takes a generic path, expands `~`, normalizes platform-specific syntax, checks `expanded.is_absolute()`, and on failure returns a new `std::io::Error` containing the original path's display string. On success it calls `absolutize::absolutize_from` with `/` as the base solely to normalize the already-absolute path, then wraps the result.

**Call relations**: Callers use this when relative paths would be a bug or a validation failure. It shares preprocessing with the other constructors but deliberately avoids `absolutize` so it never depends on process cwd.

*Call graph*: calls 2 internal fn (absolutize_from, normalize_path_for_platform); called by 36 (model_provider_auth_from_proto, loader_translates_sources_to_config_layers, host_and_executor_sources_parse_the_same_manifest, selected_plugin_root, malformed_preferred_manifest_does_not_fall_through_to_alternate, plugin_root_resolution_uses_supplied_executor_file_system, try_new, load_default_with_cli_overrides_for_codex_home, with_models_provider_home_and_state_for_tests, malformed_declared_config_is_an_error (+15 more)); 5 external calls (as_ref, new, maybe_expand_home_directory, new, format!).


##### `AbsolutePathBuf::current_dir`  (lines 80–82)

```
fn current_dir() -> std::io::Result<Self>
```

**Purpose**: Returns the process current working directory as an `AbsolutePathBuf`. It is a convenience wrapper that preserves the crate's normalization guarantees.

**Data flow**: Reads `std::env::current_dir()`, then passes that path into `from_absolute_path` and returns the resulting `AbsolutePathBuf` or any I/O error. No additional state is modified.

**Call relations**: Runtime setup code calls this when it needs a normalized absolute cwd. Internally it is just a thin wrapper over `from_absolute_path`.

*Call graph*: called by 67 (cancellation_expiration_keeps_process_alive_until_terminated, timeout_or_cancellation_reports_cancellation_without_timeout_exit_code, windows_sandbox_exec_request, run_main, arg0_dispatch, workspace_dir, build_inner, default_thread_environment_selections_empty_when_default_disabled, default_thread_environment_selections_use_manager_default_id, latest_environment_update_wins_while_previous_resolution_is_pending (+15 more)); 2 external calls (from_absolute_path, current_dir).


##### `AbsolutePathBuf::relative_to_current_dir`  (lines 86–91)

```
fn relative_to_current_dir(path: P) -> std::io::Result<Self>
```

**Purpose**: Resolves a path against the process current working directory and returns the normalized absolute result. It is the explicit relative-input counterpart to `current_dir`.

**Data flow**: Accepts a generic path, reads `std::env::current_dir()`, then passes both into `resolve_path_against_base`. It returns `Ok(AbsolutePathBuf)` or propagates cwd lookup errors.

**Call relations**: This is used by CLI and config parsing paths that interpret relative values against the server or process cwd. It delegates to `resolve_path_against_base` after obtaining the ambient base path.

*Call graph*: called by 21 (from_listen_url, resolve_cwd_config, normalize_thread_list_cwd_filters, thread_from_stored_thread, normalize_thread_list_cwd_filter_resolves_relative_paths_against_server_cwd, summary_to_thread, parse_allow_unix_socket_path, parse_socket_path, collect_explicit_skill_mentions, build_inner (+11 more)); 2 external calls (resolve_path_against_base, current_dir).


##### `AbsolutePathBuf::join`  (lines 93–95)

```
fn join(&self, path: P) -> Self
```

**Purpose**: Appends another path onto an existing absolute base while preserving normalization and home-expansion behavior. Unlike raw `PathBuf::join`, it returns another `AbsolutePathBuf` with the same invariant.

**Data flow**: Reads `&self` as the base and a generic `path` argument, then forwards both to `resolve_path_against_base`. It returns the newly constructed absolute wrapper.

**Call relations**: Callers use this as the ergonomic method for deriving child paths from an existing `AbsolutePathBuf`. It is a direct wrapper around the explicit-base constructor.

*Call graph*: called by 39 (from_core_with_cwd, new, load_from_codex_home, project_ignored_config_keys_warning, default_skill_roots, load_plugin_hooks, write_hook_file, write_manifest, resolve_plugin_root, update_personal_marketplace (+15 more)); 1 external calls (resolve_path_against_base).


##### `AbsolutePathBuf::canonicalize`  (lines 97–99)

```
fn canonicalize(&self) -> std::io::Result<Self>
```

**Purpose**: Canonicalizes the wrapped path through the filesystem and returns the canonical absolute result as another `AbsolutePathBuf`. Unlike lexical normalization, this resolves symlinks and requires the path to exist.

**Data flow**: Reads `self.0`, passes it to `dunce::canonicalize`, and maps the resulting `PathBuf` into `AbsolutePathBuf`. It returns any filesystem error unchanged.

**Call relations**: This method is called by code that wants strict canonical filesystem paths. It delegates entirely to `dunce::canonicalize` and does not use the symlink-preserving helpers in this file.

*Call graph*: called by 1 (canonicalize_if_exists); 1 external calls (canonicalize).


##### `AbsolutePathBuf::parent`  (lines 101–109)

```
fn parent(&self) -> Option<Self>
```

**Purpose**: Returns the parent directory of the absolute path, preserving the absolute-path invariant. It wraps the standard `Path::parent` result in `AbsolutePathBuf` when present.

**Data flow**: Reads `self.0.parent()`, and if a parent exists, debug-asserts that it is absolute before cloning it into a new `PathBuf` and wrapping it. It returns `Option<AbsolutePathBuf>` and writes no external state.

**Call relations**: Filesystem and config code call this when walking upward through directories. It does not delegate to other crate helpers beyond the underlying `Path` API.

*Call graph*: called by 12 (new_add_for_test, write_file_with_missing_parent_retry, save, find_git_checkout_root, load_requirements_toml, default_skill_name, load_skill_metadata, read_resolved_agent_role_file, write_shell_snapshot, default_output_csv_path (+2 more)).


##### `AbsolutePathBuf::ancestors`  (lines 111–119)

```
fn ancestors(&self) -> impl Iterator<Item = Self> + '_
```

**Purpose**: Produces an iterator of all ancestor paths, including the path itself, each wrapped as `AbsolutePathBuf`. It preserves the invariant across upward traversal.

**Data flow**: Reads `self.0.ancestors()`, maps each yielded `&Path` into a cloned `PathBuf`, debug-asserting each ancestor is absolute, and returns the iterator. No state is mutated.

**Call relations**: Project-root and plugin-resolution code use this to search upward through directory trees. It is also consumed internally by `should_preserve_logical_path` through the underlying `Path` API on plain paths.

*Call graph*: called by 6 (find_project_root, load_project_layers, dirs_between_project_root_and_cwd, find_project_root, find_ancestor_git_entry_with_fs, plugin_namespace_for_skill_path).


##### `AbsolutePathBuf::as_path`  (lines 121–123)

```
fn as_path(&self) -> &Path
```

**Purpose**: Exposes the wrapped path as `&Path` without copying. It is the primary borrowing accessor for interoperability with APIs expecting standard paths.

**Data flow**: Reads `self.0` and returns a shared `&Path` reference to it. It performs no transformation or mutation.

**Call relations**: Many external callers use this accessor before passing the path into filesystem, socket, or process APIs. It is a leaf accessor with no internal delegation.

*Call graph*: called by 58 (connect_unix_socket_endpoint, drop, acquire_app_server_startup_lock, start_control_socket_acceptor, create_empty_user_layer, derive_new_contents_from_chunks, run_command_under_windows_session, wait_for_foreground_remote_control_ready, cloud_config_layers_from_fragments_impl, validate_fragment_strictly (+15 more)).


##### `AbsolutePathBuf::into_path_buf`  (lines 125–127)

```
fn into_path_buf(self) -> PathBuf
```

**Purpose**: Consumes the wrapper and returns the owned inner `PathBuf`. It is the ownership-releasing conversion out of the type.

**Data flow**: Takes ownership of `self` and returns `self.0`. No additional work is performed.

**Call relations**: This is used by the `From<AbsolutePathBuf> for PathBuf` impl and by callers that need to move the underlying buffer out.

*Call graph*: called by 1 (from).


##### `AbsolutePathBuf::to_path_buf`  (lines 129–131)

```
fn to_path_buf(&self) -> PathBuf
```

**Purpose**: Clones the inner path into a standalone `PathBuf`. It provides an owned copy while keeping the original wrapper intact.

**Data flow**: Reads `self.0` and returns `self.0.clone()`. It does not mutate any state.

**Call relations**: Various callers use this when they need an owned standard path but want to retain the original `AbsolutePathBuf`.

*Call graph*: called by 18 (new_add_for_test, invalid_marketplace_layout_error, normalize_git_plugin_source_url, normalize_relative_git_plugin_source_url, normalize_remote_plugin_subdir, resolve_local_plugin_source_path, personal_marketplace_relative_plugin_path, codex_home, rebuild_preserving_session_layers, to_mcp_config_with_plugin_registrations (+8 more)).


##### `AbsolutePathBuf::to_string_lossy`  (lines 133–135)

```
fn to_string_lossy(&self) -> std::borrow::Cow<'_, str>
```

**Purpose**: Returns a lossy UTF-8 string view of the path for display or command construction. It mirrors `Path::to_string_lossy` on the wrapped path.

**Data flow**: Reads `self.0` and returns `Cow<'_, str>` from `self.0.to_string_lossy()`. No state changes occur.

**Call relations**: Formatting and shell-command code call this when they need a string representation that tolerates non-UTF-8 paths.

*Call graph*: called by 9 (from, normalized_path, prompt, commands_for_intercepted_exec_policy, join_program_and_argv, seatbelt_protected_metadata_name_regex, prepare_escalated_exec, prepare_escalated_exec, from_abs_path).


##### `AbsolutePathBuf::display`  (lines 137–139)

```
fn display(&self) -> Display<'_>
```

**Purpose**: Returns the standard `Display` adapter for the wrapped path. It supports deferred formatting without allocating a string.

**Data flow**: Reads `self.0` and returns `self.0.display()`. It has no side effects.

**Call relations**: Used by diagnostics and snapshot-writing code that wants standard path formatting semantics.

*Call graph*: called by 5 (codex_home, validate_snapshot, write_shell_snapshot, hook_handler_source, unmanaged_hook_handler_source).


##### `normalize_path_for_platform`  (lines 142–151)

```
fn normalize_path_for_platform(path: &Path) -> Cow<'_, Path>
```

**Purpose**: Normalizes platform-specific path syntax before absolutization, currently focused on stripping supported Windows device/verbatim prefixes. It avoids rewriting paths on non-Windows platforms.

**Data flow**: Reads `path: &Path`; on Windows it converts to `&str`, passes the string to `normalize_windows_device_path`, and if a normalized string is returned wraps it in `Cow::Owned(PathBuf)`. Otherwise, and on non-Windows, it returns `Cow::Borrowed(path)`.

**Call relations**: All main constructors call this after home expansion so they can accept Windows verbatim paths while still enforcing the crate's normalized-path invariant. It delegates to `normalize_windows_device_path` for the actual string rewrite logic.

*Call graph*: calls 1 internal fn (normalize_windows_device_path); called by 3 (from_absolute_path, from_absolute_path_checked, resolve_path_against_base); 5 external calls (Borrowed, Owned, to_str, from, cfg!).


##### `normalize_windows_device_path`  (lines 153–171)

```
fn normalize_windows_device_path(path: &str) -> Option<String>
```

**Purpose**: Strips supported Windows verbatim/device prefixes from path strings and converts UNC forms back to ordinary UNC syntax. It intentionally ignores unsupported device namespaces such as `GLOBALROOT`.

**Data flow**: Reads a `&str` path and checks prefixes in order: `\\?\UNC\`, `\\.\UNC\`, `\\?\`, and `\\.\`. UNC prefixes are rewritten with `format!("\\\\{unc}")`; drive-prefixed forms are only accepted if `is_windows_drive_absolute_path` returns true, in which case the stripped remainder is returned as `String`. If no supported pattern matches, it returns `None`.

**Call relations**: This helper is only called by `normalize_path_for_platform`. It encapsulates the string-level Windows-specific cleanup before paths are converted back into `PathBuf`s.

*Call graph*: calls 1 internal fn (is_windows_drive_absolute_path); called by 1 (normalize_path_for_platform); 1 external calls (format!).


##### `is_windows_drive_absolute_path`  (lines 173–179)

```
fn is_windows_drive_absolute_path(path: &str) -> bool
```

**Purpose**: Recognizes strings of the form `X:\...` or `X:/...` where `X` is an ASCII alphabetic drive letter. It is a narrow validator used when stripping Windows device prefixes.

**Data flow**: Reads the input string as bytes and checks length, alphabetic first byte, colon second byte, and slash-or-backslash third byte. It returns a boolean and writes no state.

**Call relations**: Only `normalize_windows_device_path` calls this to ensure it strips prefixes only from true drive-absolute paths, not arbitrary device names.

*Call graph*: called by 1 (normalize_windows_device_path); 1 external calls (matches!).


##### `canonicalize_preserving_symlinks`  (lines 189–197)

```
fn canonicalize_preserving_symlinks(path: &Path) -> std::io::Result<PathBuf>
```

**Purpose**: Canonicalizes a path when possible but preserves the logical absolute path if canonicalization would rewrite it through a nested symlink. It also falls back to the logical path when canonicalization fails.

**Data flow**: Reads `path: &Path`, first computes a logical normalized absolute path via `AbsolutePathBuf::from_absolute_path(path)?.into_path_buf()`, then computes `preserve_logical_path` with `should_preserve_logical_path(&logical)`. It attempts `dunce::canonicalize(path)` and returns the logical path if preservation is required and the canonical path differs, otherwise the canonical path; if canonicalization errors, it still returns the logical path.

**Call relations**: Tests in this file call it directly, and runtime code can use it when missing paths should not be fatal. It delegates to `from_absolute_path`, `should_preserve_logical_path`, and `dunce::canonicalize`.

*Call graph*: calls 2 internal fn (from_absolute_path, should_preserve_logical_path); called by 3 (canonicalize_preserving_symlinks_avoids_verbatim_prefixes, canonicalize_preserving_symlinks_keeps_logical_missing_child_under_symlink, canonicalize_preserving_symlinks_keeps_logical_symlink_path); 1 external calls (canonicalize).


##### `canonicalize_existing_preserving_symlinks`  (lines 204–212)

```
fn canonicalize_existing_preserving_symlinks(path: &Path) -> std::io::Result<PathBuf>
```

**Purpose**: Canonicalizes an existing path while preserving the logical path across nested symlink rewrites, but unlike the more permissive variant it propagates canonicalization failures. It is intended for callers that must reject nonexistent or invalid paths.

**Data flow**: Builds the logical normalized absolute path with `AbsolutePathBuf::from_absolute_path(path)?.into_path_buf()`, canonicalizes the filesystem path with `dunce::canonicalize(path)?`, then returns either the logical path or canonical path depending on `should_preserve_logical_path(&logical)` and equality. Errors from canonicalization are returned directly.

**Call relations**: This function is used where existence matters and tests cover both missing-path and symlink-preservation cases. It shares the same preservation predicate as `canonicalize_preserving_symlinks` but differs in error handling.

*Call graph*: calls 2 internal fn (from_absolute_path, should_preserve_logical_path); called by 2 (canonicalize_existing_preserving_symlinks_errors_for_missing_path, canonicalize_existing_preserving_symlinks_keeps_logical_symlink_path); 1 external calls (canonicalize).


##### `should_preserve_logical_path`  (lines 214–221)

```
fn should_preserve_logical_path(logical: &Path) -> bool
```

**Purpose**: Determines whether a logical path passes through a nested symlink whose rewrite should be hidden from callers. It intentionally excludes top-level aliases by requiring the symlink ancestor to have a grandparent.

**Data flow**: Iterates over `logical.ancestors()`, calls `std::fs::symlink_metadata` on each ancestor, and for successful metadata checks whether the file type is a symlink and whether `ancestor.parent().and_then(Path::parent).is_some()`. It returns true if any ancestor satisfies both conditions; metadata errors are treated as false for that ancestor.

**Call relations**: Both symlink-preserving canonicalization functions call this predicate before deciding whether to return the logical or canonical path. It does not mutate state and only inspects filesystem metadata.

*Call graph*: called by 2 (canonicalize_existing_preserving_symlinks, canonicalize_preserving_symlinks); 1 external calls (ancestors).


##### `AbsolutePathBuf::as_ref`  (lines 224–226)

```
fn as_ref(&self) -> &Path
```

**Purpose**: Implements `AsRef<Path>` for `AbsolutePathBuf` so it can be passed directly into generic path-taking APIs. It exposes the wrapped path by shared reference.

**Data flow**: Reads `self.0` and returns `&Path`. No allocation or mutation occurs.

**Call relations**: This trait method is used implicitly by generic callers throughout the codebase; it is a simple adapter with no internal delegation.


##### `AbsolutePathBuf::deref`  (lines 232–234)

```
fn deref(&self) -> &Self::Target
```

**Purpose**: Implements `Deref<Target = Path>` so `AbsolutePathBuf` can transparently use `Path` methods. It makes the wrapper ergonomic in path-heavy code.

**Data flow**: Reads `self.0` and returns `&Path` as the deref target. It performs no transformation.

**Call relations**: This trait implementation is invoked implicitly by Rust method resolution and indexing into path APIs; it is a leaf adapter.


##### `PathBuf::from`  (lines 238–240)

```
fn from(path: AbsolutePathBuf) -> Self
```

**Purpose**: Implements conversion from `AbsolutePathBuf` into a plain `PathBuf`. It consumes the wrapper and yields the owned inner buffer.

**Data flow**: Takes `path: AbsolutePathBuf`, calls `into_path_buf`, and returns the resulting `PathBuf`. No other state is touched.

**Call relations**: This conversion is used wherever callers need to leave the typed wrapper world. It delegates directly to `AbsolutePathBuf::into_path_buf`.

*Call graph*: calls 1 internal fn (into_path_buf).


##### `test_support::test_path_buf`  (lines 252–265)

```
fn test_path_buf(unix_path: &str) -> PathBuf
```

**Purpose**: Builds a platform-absolute `PathBuf` from a Unix-style absolute test literal. It lets tests write `/tmp/example` once and get `C:\tmp\example` on Windows.

**Data flow**: Reads `unix_path: &str`; on Windows it starts from `C:\`, trims leading slashes, splits on `/`, filters empty segments, and extends the path with those segments. On non-Windows it simply returns `PathBuf::from(unix_path)`.

**Call relations**: Tests in this crate call it to express expected paths portably. It is isolated under `test_support` so production code does not depend on test-only path conventions.

*Call graph*: 2 external calls (from, cfg!).


##### `test_support::Path::abs`  (lines 275–278)

```
fn abs(&self) -> AbsolutePathBuf
```

**Purpose**: Adds a test-only extension method to convert an already absolute `&Path` into `AbsolutePathBuf`. It panics in tests if the path is not absolute.

**Data flow**: Reads `&self` as a `Path`, calls `AbsolutePathBuf::from_absolute_path_checked(self)`, and unwraps with `expect("path should already be absolute")`. It returns the resulting `AbsolutePathBuf`.

**Call relations**: Test code uses this extension for concise fixture construction. It delegates to the checked constructor so tests still enforce the absolute-path invariant.

*Call graph*: calls 1 internal fn (from_absolute_path_checked).


##### `test_support::PathBuf::abs`  (lines 288–290)

```
fn abs(&self) -> AbsolutePathBuf
```

**Purpose**: Adds the same test-only absolute conversion for `PathBuf`. It forwards through the `Path` extension implementation.

**Data flow**: Reads `&self`, converts to `self.as_path()`, calls `.abs()` from the `PathExt` trait, and returns the resulting `AbsolutePathBuf`. No state is mutated.

**Call relations**: This helper is used in tests when the fixture is already a `PathBuf`. It delegates entirely to `test_support::Path::abs`.


##### `AbsolutePathBuf::try_from`  (lines 321–323)

```
fn try_from(value: String) -> Result<Self, Self::Error>
```

**Purpose**: Implements `TryFrom<&Path>` by constructing an `AbsolutePathBuf` from the referenced path. It gives generic conversion support with the crate's normalization semantics.

**Data flow**: Reads `value: &Path`, passes it to `Self::from_absolute_path`, and returns the resulting `Result<AbsolutePathBuf, std::io::Error>`. No extra state is involved.

**Call relations**: This trait conversion is used by serialization and argument-parsing code that wants standard `TryFrom` ergonomics. It delegates directly to the general constructor.

*Call graph*: called by 245 (marketplace_remove_response_serializes_nullable_installed_root, marketplace_upgrade_response_serializes_camel_case_fields, plugin_install_params_serialization_omits_force_remote_sync, plugin_interface_serializes_local_paths_and_remote_urls_separately, plugin_read_params_serialization_uses_install_source_fields, plugin_share_params_and_response_serialization_use_camel_case_fields, plugin_source_serializes_local_git_and_remote_variants, absolute_path_arg, read, read_includes_origins_and_layers (+15 more)); 1 external calls (from_absolute_path).


##### `AbsolutePathBufGuard::new`  (lines 337–342)

```
fn new(base_path: &Path) -> Self
```

**Purpose**: Sets the thread-local base path used when deserializing relative `AbsolutePathBuf` values. The returned guard represents the active scope for that base path.

**Data flow**: Reads `base_path: &Path`, enters the `ABSOLUTE_PATH_BASE` thread-local, and stores `Some(base_path.to_path_buf())` into the `RefCell`. It returns a zero-sized `AbsolutePathBufGuard` value.

**Call relations**: Config validation and deserialization entry points create this guard before invoking serde so relative paths can be resolved consistently. Cleanup is paired with the `Drop` implementation.

*Call graph*: called by 23 (validate_fragment_strictly, deserialize_filesystem_deny_read_glob_requirements, first_layer_config_error_for_entries, validate_config_toml_strictly, validate_managed_config_toml_strictly_if_requested, project_trust_context, resolve_relative_paths_in_config_toml, validate_cli_overrides_strictly, validate_config_toml_strictly, load_skill_metadata (+13 more)).


##### `AbsolutePathBufGuard::drop`  (lines 346–350)

```
fn drop(&mut self)
```


##### `AbsolutePathBuf::deserialize`  (lines 354–368)

```
fn deserialize(deserializer: D) -> Result<Self, D::Error>
```

**Purpose**: Deserializes an `AbsolutePathBuf` from a serialized path string, resolving relative paths against the thread-local base when present. Without a base, it only accepts already-absolute paths.

**Data flow**: Reads a serde `Deserializer`, first deserializes a `PathBuf`, then inspects `ABSOLUTE_PATH_BASE`. If a base exists it returns `Self::resolve_path_against_base(path, base)`; if no base exists but `path.is_absolute()` it calls `Self::from_absolute_path(path)` and maps any I/O error into a serde error; otherwise it returns a custom serde error stating that no base path was provided.

**Call relations**: Serde invokes this implementation whenever an `AbsolutePathBuf` field is deserialized. It relies on `AbsolutePathBufGuard::new` having established thread-local context for relative-path cases.

*Call graph*: called by 2 (deserialize_absolute_path, default_provider_auth_cwd); 1 external calls (deserialize).


##### `tests::create_with_absolute_path_ignores_base_path`  (lines 382–390)

```
fn create_with_absolute_path_ignores_base_path()
```

**Purpose**: Verifies that resolving an already absolute path against a base leaves the absolute path unchanged. It documents that the base is ignored in this case.

**Data flow**: Creates temporary base and absolute directories, appends `file.txt` to the absolute directory, calls `AbsolutePathBuf::resolve_path_against_base`, and asserts the resulting `as_path()` equals the original absolute path. It writes only temporary filesystem state.

**Call relations**: This unit test is run by the harness and exercises the absolute-input branch of `resolve_path_against_base`.

*Call graph*: calls 1 internal fn (resolve_path_against_base); 2 external calls (assert_eq!, tempdir).


##### `tests::from_absolute_path_does_not_read_current_dir_when_path_is_absolute`  (lines 394–403)

```
fn from_absolute_path_does_not_read_current_dir_when_path_is_absolute()
```

**Purpose**: Checks that `from_absolute_path` does not depend on `current_dir()` when given an absolute path. It does so indirectly by spawning an ignored child test that removes its cwd.

**Data flow**: Builds a `Command` for the current test binary, passes the ignored child test name and an environment flag, runs it, and asserts the child exits successfully. The child test performs the actual cwd-removal scenario.

**Call relations**: The test harness invokes this parent test, which orchestrates a subprocess because changing and deleting cwd would be unsafe to do inline with other tests.

*Call graph*: 3 external calls (assert!, new, current_exe).


##### `tests::from_absolute_path_with_removed_current_dir_child`  (lines 408–430)

```
fn from_absolute_path_with_removed_current_dir_child()
```

**Purpose**: Implements the subprocess scenario proving absolute-path construction works even when the process current directory has been removed. It is ignored by default and only runs when explicitly selected by the parent test.

**Data flow**: Checks for the gating environment variable and returns early if absent. Otherwise it records the original cwd, creates and enters a temp directory, removes that directory, confirms `current_dir()` now errors, calls `AbsolutePathBuf::from_absolute_path` on a fixed absolute test path containing `..`, restores the original cwd, and asserts the normalized result equals the expected path.

**Call relations**: This ignored test is launched by `tests::from_absolute_path_does_not_read_current_dir_when_path_is_absolute` in a subprocess. It specifically exercises the optimization in the lower-level absolutizer that skips cwd lookup for already-absolute inputs.

*Call graph*: calls 1 internal fn (from_absolute_path); 7 external calls (assert_eq!, current_dir, set_current_dir, var_os, remove_dir, tempdir, test_path_buf).


##### `tests::from_absolute_path_checked_rejects_relative_path`  (lines 433–438)

```
fn from_absolute_path_checked_rejects_relative_path()
```

**Purpose**: Confirms that the checked constructor rejects relative input with `InvalidInput`. It distinguishes the checked API from the more permissive constructor.

**Data flow**: Calls `AbsolutePathBuf::from_absolute_path_checked("relative/path")`, captures the error with `expect_err`, and asserts `err.kind()` is `std::io::ErrorKind::InvalidInput`. No external state is changed.

**Call relations**: This test is run by the harness and covers the explicit validation branch in `from_absolute_path_checked`.

*Call graph*: calls 1 internal fn (from_absolute_path_checked); 1 external calls (assert_eq!).


##### `tests::normalize_windows_device_path_strips_supported_verbatim_prefixes`  (lines 441–462)

```
fn normalize_windows_device_path_strips_supported_verbatim_prefixes()
```

**Purpose**: Validates the string-level Windows device-path normalization helper across supported and unsupported prefixes. It documents exactly which prefixes are rewritten and which are rejected.

**Data flow**: Calls `normalize_windows_device_path` with several hard-coded strings and asserts the returned `Option<String>` matches expected rewritten values or `None`. It performs no I/O.

**Call relations**: The test harness invokes this unit test to pin down the behavior of the private Windows normalization helper.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::from_absolute_path_strips_windows_verbatim_prefix`  (lines 466–475)

```
fn from_absolute_path_strips_windows_verbatim_prefix()
```

**Purpose**: On Windows, verifies that the checked constructor accepts a verbatim drive path and stores it without the verbatim prefix. It proves the platform normalization is applied before the absolute check.

**Data flow**: Calls `AbsolutePathBuf::from_absolute_path_checked` with a `\\?\D:\...` path and asserts the resulting `as_path()` equals the non-verbatim `D:\...` path. No external state is modified.

**Call relations**: This Windows-only test is run by the harness and exercises the interaction between `normalize_path_for_platform` and `from_absolute_path_checked`.

*Call graph*: calls 1 internal fn (from_absolute_path_checked); 1 external calls (assert_eq!).


##### `tests::relative_path_is_resolved_against_base_path`  (lines 478–483)

```
fn relative_path_is_resolved_against_base_path()
```

**Purpose**: Checks that a simple relative path is appended to the provided base directory. It covers the common explicit-base resolution case.

**Data flow**: Creates a temp base directory, calls `AbsolutePathBuf::resolve_path_against_base("file.txt", base_dir)`, and asserts the resulting path equals `base_dir.join("file.txt")`. It only uses temporary filesystem setup.

**Call relations**: This test is invoked by the harness and validates the straightforward relative-input branch of the explicit-base constructor.

*Call graph*: calls 1 internal fn (resolve_path_against_base); 2 external calls (assert_eq!, tempdir).


##### `tests::relative_path_dots_are_normalized_against_base_path`  (lines 486–492)

```
fn relative_path_dots_are_normalized_against_base_path()
```

**Purpose**: Verifies that dot segments in a relative path are normalized away after resolution against a base directory. It demonstrates lexical cleanup through the public API.

**Data flow**: Creates a temp base directory, resolves `./nested/../file.txt` against it, and asserts the result equals `base_dir.join("file.txt")`. No persistent state is changed.

**Call relations**: The test runner invokes this to cover normalization behavior exposed through `resolve_path_against_base`.

*Call graph*: calls 1 internal fn (resolve_path_against_base); 2 external calls (assert_eq!, tempdir).


##### `tests::canonicalize_returns_absolute_path_buf`  (lines 495–512)

```
fn canonicalize_returns_absolute_path_buf()
```

**Purpose**: Ensures the `canonicalize` method returns the same canonical filesystem path as `dunce::canonicalize` for an existing path. It also confirms the method preserves the wrapper type.

**Data flow**: Creates directories and a file under a temp dir, constructs an `AbsolutePathBuf` from a path containing `..` and `.`, calls `.canonicalize()`, and compares the resulting `as_path()` to `dunce::canonicalize` on the expected file path. It writes temporary filesystem entries as setup.

**Call relations**: This test is run by the harness and exercises the happy path of `AbsolutePathBuf::canonicalize` against real filesystem state.

*Call graph*: calls 1 internal fn (from_absolute_path); 4 external calls (assert_eq!, create_dir, write, tempdir).


##### `tests::canonicalize_returns_error_for_missing_path`  (lines 515–521)

```
fn canonicalize_returns_error_for_missing_path()
```

**Purpose**: Checks that `AbsolutePathBuf::canonicalize` propagates an error for a nonexistent path. It distinguishes strict canonicalization from lexical normalization.

**Data flow**: Creates a temp directory, constructs an `AbsolutePathBuf` for a missing child path, calls `.canonicalize()`, and asserts the result is an error. It does not inspect the exact error kind here.

**Call relations**: The test harness invokes this to cover the failure branch of the wrapper's canonicalization method.

*Call graph*: calls 1 internal fn (from_absolute_path); 2 external calls (assert!, tempdir).


##### `tests::ancestors_returns_absolute_path_bufs`  (lines 524–542)

```
fn ancestors_returns_absolute_path_bufs()
```

**Purpose**: Verifies that `ancestors()` yields the full chain of absolute paths in order from the path itself up to root. It confirms the iterator preserves the wrapper invariant.

**Data flow**: Constructs an `AbsolutePathBuf` from a fixed absolute test path, maps the `ancestors()` iterator into plain `PathBuf`s, collects them into a `Vec`, and compares against an expected vector of absolute paths. No external state is modified.

**Call relations**: This unit test is run by the harness and directly validates the iterator returned by `AbsolutePathBuf::ancestors`.

*Call graph*: calls 1 internal fn (from_absolute_path_checked); 3 external calls (assert_eq!, test_path_buf, vec!).


##### `tests::relative_to_current_dir_resolves_relative_path`  (lines 545–553)

```
fn relative_to_current_dir_resolves_relative_path() -> std::io::Result<()>
```

**Purpose**: Checks that `relative_to_current_dir` resolves a relative path against the process cwd. It validates the convenience constructor's use of ambient state.

**Data flow**: Reads `std::env::current_dir()`, calls `AbsolutePathBuf::relative_to_current_dir("file.txt")`, and asserts the resulting path equals `current_dir.join("file.txt")`. It returns `std::io::Result<()>` so cwd lookup failures propagate naturally.

**Call relations**: The test harness invokes this to cover the current-directory-based constructor.

*Call graph*: calls 1 internal fn (relative_to_current_dir); 2 external calls (assert_eq!, current_dir).


##### `tests::guard_used_in_deserialization`  (lines 556–569)

```
fn guard_used_in_deserialization()
```

**Purpose**: Verifies that `AbsolutePathBufGuard` supplies the base path used to resolve relative paths during serde deserialization. It proves the thread-local mechanism works end to end.

**Data flow**: Creates a temp base directory, enters a scope holding `AbsolutePathBufGuard::new(base_dir)`, deserializes a JSON string containing `subdir/file.txt` into `AbsolutePathBuf`, then asserts the resulting path equals `base_dir.join(relative_path)`. The guard's drop clears the thread-local afterward.

**Call relations**: This test is run by the harness and exercises the interaction between `AbsolutePathBufGuard::new`, the `Deserialize` impl, and the guard's `Drop` cleanup.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, format!, tempdir).


##### `tests::home_directory_root_is_expanded_in_deserialization`  (lines 572–582)

```
fn home_directory_root_is_expanded_in_deserialization()
```

**Purpose**: Checks that deserializing `"~"` expands to the user's home directory when a guard is active. It validates home expansion inside the deserialization path.

**Data flow**: Reads `home_dir()`, returning early if unavailable, creates a temp base directory, deserializes `"~"` inside a guard scope, and asserts the resulting path equals the home directory. It writes no persistent state.

**Call relations**: The test harness invokes this to cover the `maybe_expand_home_directory` branch reached through serde deserialization.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, home_dir, tempdir).


##### `tests::home_directory_subpath_is_expanded_in_deserialization`  (lines 585–595)

```
fn home_directory_subpath_is_expanded_in_deserialization()
```

**Purpose**: Verifies that `"~/code"` deserializes to a path under the user's home directory. It confirms subpath expansion, not just bare `~`.

**Data flow**: Obtains `home_dir()`, creates a temp base directory, deserializes `"~/code"` while a guard is active, and asserts the result equals `home.join("code")`. No external state is modified.

**Call relations**: This test is run by the harness and exercises the slash-subpath branch of home expansion during deserialization.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, home_dir, tempdir).


##### `tests::home_directory_double_slash_is_expanded_in_deserialization`  (lines 598–608)

```
fn home_directory_double_slash_is_expanded_in_deserialization()
```

**Purpose**: Checks that redundant slashes after `~` are trimmed during deserialization. It ensures `"~//code"` still resolves to `home/code`.

**Data flow**: Reads `home_dir()`, creates a temp base directory, deserializes `"~//code"` under a guard, and asserts the resulting path equals `home.join("code")`. It has no side effects beyond temporary setup.

**Call relations**: The test harness invokes this to pin down the `trim_start_matches('/')` behavior in home expansion.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, home_dir, tempdir).


##### `tests::canonicalize_preserving_symlinks_keeps_logical_symlink_path`  (lines 612–623)

```
fn canonicalize_preserving_symlinks_keeps_logical_symlink_path()
```

**Purpose**: On Unix, verifies that canonicalization preserving symlinks returns the logical symlink path itself rather than the real target path. It covers the simplest existing-symlink case.

**Data flow**: Creates a real directory and a symlink to it inside a temp dir, calls `canonicalize_preserving_symlinks(&link)`, and asserts the returned `PathBuf` equals `link`. It writes temporary filesystem entries as setup.

**Call relations**: This Unix-only test is run by the harness and exercises the preservation branch where canonicalization would otherwise rewrite through a nested symlink.

*Call graph*: calls 1 internal fn (canonicalize_preserving_symlinks); 4 external calls (assert_eq!, create_dir_all, symlink, tempdir).


##### `tests::canonicalize_preserving_symlinks_keeps_logical_missing_child_under_symlink`  (lines 627–639)

```
fn canonicalize_preserving_symlinks_keeps_logical_missing_child_under_symlink()
```

**Purpose**: Checks that the symlink-preserving canonicalizer returns the logical path even for a missing child beneath a symlinked directory. It validates the fallback-to-logical-path behavior on canonicalization failure.

**Data flow**: Creates a real directory and symlink, constructs a missing child path under the symlink, calls `canonicalize_preserving_symlinks(&missing)`, and asserts the result equals the logical missing path. Temporary filesystem state is created for setup.

**Call relations**: The test harness invokes this Unix-only case to cover the error-handling branch of `canonicalize_preserving_symlinks`.

*Call graph*: calls 1 internal fn (canonicalize_preserving_symlinks); 4 external calls (assert_eq!, create_dir_all, symlink, tempdir).


##### `tests::canonicalize_existing_preserving_symlinks_errors_for_missing_path`  (lines 642–650)

```
fn canonicalize_existing_preserving_symlinks_errors_for_missing_path()
```

**Purpose**: Verifies that the strict existing-path variant returns `NotFound` for a missing path instead of falling back to the logical path. It distinguishes the two public canonicalization helpers.

**Data flow**: Creates a temp directory, constructs a missing child path, calls `canonicalize_existing_preserving_symlinks(&missing)`, captures the error, and asserts its kind is `std::io::ErrorKind::NotFound`. No persistent state is changed.

**Call relations**: This test is run by the harness and covers the strict error-propagation behavior of `canonicalize_existing_preserving_symlinks`.

*Call graph*: calls 1 internal fn (canonicalize_existing_preserving_symlinks); 2 external calls (assert_eq!, tempdir).


##### `tests::canonicalize_existing_preserving_symlinks_keeps_logical_symlink_path`  (lines 654–665)

```
fn canonicalize_existing_preserving_symlinks_keeps_logical_symlink_path()
```

**Purpose**: On Unix, confirms that the strict existing-path canonicalizer still preserves the logical symlink path when the path exists. It covers the successful preservation branch of the stricter API.

**Data flow**: Creates a real directory and symlink in a temp dir, calls `canonicalize_existing_preserving_symlinks(&link)`, and asserts the returned path equals `link`. It writes temporary filesystem entries as setup.

**Call relations**: The test harness invokes this Unix-only test to validate that the strict variant differs from the permissive one only in error handling, not in symlink-preservation semantics.

*Call graph*: calls 1 internal fn (canonicalize_existing_preserving_symlinks); 4 external calls (assert_eq!, create_dir_all, symlink, tempdir).


##### `tests::home_directory_backslash_subpath_is_expanded_in_deserialization`  (lines 669–681)

```
fn home_directory_backslash_subpath_is_expanded_in_deserialization()
```

**Purpose**: On Windows, verifies that a backslash-separated `~\code` path expands under the home directory during deserialization. It covers the Windows-specific branch in home expansion.

**Data flow**: Obtains `home_dir()`, creates a temp base directory, serializes the raw string `~\code` as JSON, deserializes it into `AbsolutePathBuf` under a guard, and asserts the result equals `home.join("code")`. No persistent state is modified.

**Call relations**: This Windows-only test is run by the harness and exercises the `cfg!(windows)` backslash branch in `maybe_expand_home_directory` through serde.

*Call graph*: calls 1 internal fn (new); 4 external calls (assert_eq!, home_dir, to_string, tempdir).


##### `tests::canonicalize_preserving_symlinks_avoids_verbatim_prefixes`  (lines 685–699)

```
fn canonicalize_preserving_symlinks_avoids_verbatim_prefixes()
```

**Purpose**: On Windows, checks that symlink-preserving canonicalization returns a normal non-verbatim path string. It ensures the helper does not leak `\\?\` prefixes into callers.

**Data flow**: Creates a temp directory, calls `canonicalize_preserving_symlinks(temp_dir.path())`, compares the result to `dunce::canonicalize(temp_dir.path())`, and asserts the string form does not start with `\\?\`. It only uses temporary setup.

**Call relations**: This Windows-only test is invoked by the harness to validate the interaction between canonicalization and the crate's Windows path normalization policy.

*Call graph*: calls 1 internal fn (canonicalize_preserving_symlinks); 3 external calls (assert!, assert_eq!, tempdir).


### `utils/absolute-path/src/absolutize.rs`

`util` · `cross-cutting path normalization`

This file contains the core pure path-manipulation logic behind `AbsolutePathBuf`. The top-level `absolutize` function is the only fallible entry point: if the input path is already absolute it simply normalizes it, otherwise it fetches the process current directory and delegates to `absolutize_from`. `absolutize_from` is intentionally infallible because it receives an explicit base path and only performs lexical transformations. The heavy lifting happens in `normalize_path`, which iterates over `Path::components()` and drops `Component::CurDir`, pops one segment for each `Component::ParentDir`, and preserves prefixes, roots, and normal segments. This means parent traversal above root saturates at root because `PathBuf::pop()` on `/` stops there. If normalization removes everything, the function returns `PathBuf::from(".")` rather than an empty path. `path_with_base` is platform-specific: on non-Windows it is just `base_path.join(path)` unless the input is already absolute; on Windows it additionally distinguishes root-relative paths and drive-relative paths, preserving or synthesizing the correct drive prefix and combining the base path tail with the remaining components. The embedded tests document Unix and Windows edge cases such as empty paths, root-relative Windows paths, and drive-relative Windows paths.

#### Function details

##### `absolutize`  (lines 14–20)

```
fn absolutize(path: &Path) -> std::io::Result<PathBuf>
```

**Purpose**: Converts an arbitrary path into a normalized absolute `PathBuf`, using the process current working directory only when the input is relative. It is the fallible bridge between lexical normalization and ambient process state.

**Data flow**: Reads `path: &Path`; if `path.is_absolute()` it sends the path directly through `normalize_path` and returns `Ok(PathBuf)`. Otherwise it reads `std::env::current_dir()`, passes both path and cwd into `absolutize_from`, and returns the resulting absolute normalized buffer or propagates the current-dir I/O error.

**Call relations**: It is called by `from_absolute_path` in the higher-level wrapper when callers want absolute-or-relative input resolved against the current directory. Internally it delegates either straight to `normalize_path` for already-absolute inputs or to `absolutize_from` when a base directory must be supplied.

*Call graph*: calls 2 internal fn (absolutize_from, normalize_path); called by 1 (from_absolute_path); 2 external calls (is_absolute, current_dir).


##### `absolutize_from`  (lines 22–24)

```
fn absolutize_from(path: &Path, base_path: &Path) -> PathBuf
```

**Purpose**: Builds a normalized absolute path from an input path and an explicit base path without consulting the filesystem or process cwd. This is the infallible path-resolution primitive used throughout the crate.

**Data flow**: Takes `path: &Path` and `base_path: &Path`, combines them with `path_with_base`, then normalizes the combined path with `normalize_path`. It returns the resulting `PathBuf` directly.

**Call relations**: Higher-level constructors such as `from_absolute_path_checked`, `resolve_path_against_base`, and `absolutize` call this when they already know the base path to use. Its only delegation is to `path_with_base` for platform-aware joining and `normalize_path` for lexical cleanup.

*Call graph*: calls 2 internal fn (normalize_path, path_with_base); called by 3 (from_absolute_path_checked, resolve_path_against_base, absolutize).


##### `normalize_path`  (lines 26–45)

```
fn normalize_path(path: &Path) -> PathBuf
```

**Purpose**: Performs lexical normalization of a path by removing `.` segments and collapsing `..` segments through `PathBuf::pop()`. It preserves roots and prefixes and never touches the filesystem.

**Data flow**: Consumes `path.components()` one component at a time into a fresh `PathBuf`. `CurDir` is ignored, `ParentDir` pops the accumulated path, and `Prefix`, `RootDir`, and `Normal` components are pushed unchanged. If the resulting buffer is empty, it returns `PathBuf::from(".")`; otherwise it returns the accumulated normalized path.

**Call relations**: This helper is called by both `absolutize` and `absolutize_from` after any needed base-path combination. It is the final normalization stage regardless of whether the original path was absolute or relative.

*Call graph*: called by 2 (absolutize, absolutize_from); 3 external calls (components, from, new).


##### `path_with_base`  (lines 57–84)

```
fn path_with_base(path: &Path, base_path: &Path) -> PathBuf
```

**Purpose**: Combines an input path with a base path using platform-specific semantics, especially for Windows root-relative and drive-relative paths. It decides what should be joined before normalization occurs.

**Data flow**: On non-Windows, it returns `path.to_path_buf()` if already absolute, otherwise `base_path.join(path)`. On Windows, it first special-cases absolute or rooted paths, then inspects components to detect a drive prefix without a root, constructs a new `PathBuf` beginning with that prefix, optionally appends a separator for bare drive paths, and otherwise appends the base path tail plus remaining components while skipping the base prefix when appropriate.

**Call relations**: Only `absolutize_from` calls this helper. Its role is to encode the platform-specific pre-normalization join rules so the rest of the crate can rely on a single normalized output path.

*Call graph*: called by 1 (absolutize_from); 9 external calls (components, has_root, is_absolute, join, push, to_path_buf, new, matches!, from).


##### `tests::absolute_path_without_dots_is_unchanged`  (lines 93–98)

```
fn absolute_path_without_dots_is_unchanged()
```

**Purpose**: Asserts that an already absolute Unix path with no dot segments survives `absolutize_from` unchanged. It documents the no-op normalization case.

**Data flow**: Builds fixed `Path` inputs for an absolute path and an unused base path, calls `absolutize_from`, and compares the returned `PathBuf` to the expected absolute path. It writes no state.

**Call relations**: This unit test is run by the test harness and directly exercises `absolutize_from`'s simplest Unix path case.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::absolute_path_dots_are_removed`  (lines 102–107)

```
fn absolute_path_dots_are_removed()
```

**Purpose**: Checks that `.` and `..` segments are collapsed correctly for an absolute Unix path. It demonstrates lexical normalization independent of the base path.

**Data flow**: Supplies an absolute path containing `./` and `../` plus a base path, calls `absolutize_from`, and asserts the returned `PathBuf` equals the simplified absolute path. No external state is modified.

**Call relations**: Invoked by the test runner, this test documents `normalize_path` behavior as observed through `absolutize_from`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::relative_path_without_dot_uses_base`  (lines 111–116)

```
fn relative_path_without_dot_uses_base()
```

**Purpose**: Verifies that a plain relative Unix path is appended to the provided base path. It captures the standard relative-resolution behavior.

**Data flow**: Creates relative and base `Path` values, passes them to `absolutize_from`, and asserts the returned `PathBuf` is `base/path`. It only reads the function result.

**Call relations**: This test is called by the harness and covers the common relative-path branch through `path_with_base` and `normalize_path`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::relative_path_with_current_dir_uses_base`  (lines 120–125)

```
fn relative_path_with_current_dir_uses_base()
```

**Purpose**: Ensures a relative path beginning with `./` resolves against the base path with the current-directory marker removed. It proves `CurDir` components are discarded.

**Data flow**: Calls `absolutize_from` with `./path/to/123/456` and `/base`, then asserts the output is `/base/path/to/123/456`. It has no side effects.

**Call relations**: The test runner invokes it to validate the `Component::CurDir` branch inside normalization.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::relative_path_with_parent_dir_uses_base_parent`  (lines 129–134)

```
fn relative_path_with_parent_dir_uses_base_parent()
```

**Purpose**: Checks that a relative path beginning with `..` climbs one level above the base path before appending the remaining segments. It demonstrates parent traversal against an explicit base.

**Data flow**: Passes `../path/to/123/456` and `/base/cwd` into `absolutize_from`, then asserts the result is `/base/path/to/123/456`. It only consumes and compares the returned path.

**Call relations**: This unit test exercises the `ParentDir` normalization path after joining with the base.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::parent_dir_above_root_stays_at_root`  (lines 138–143)

```
fn parent_dir_above_root_stays_at_root()
```

**Purpose**: Verifies that repeated `..` components cannot escape above filesystem root on Unix. It documents the saturating behavior of repeated `pop()` calls at root.

**Data flow**: Calls `absolutize_from` with `../../path/to/123/456` relative to `/`, then asserts the result is `/path/to/123/456`. No state is written.

**Call relations**: The test harness runs this to pin down an edge case in `normalize_path` when parent traversal exceeds available ancestors.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::empty_path_uses_base`  (lines 147–152)

```
fn empty_path_uses_base()
```

**Purpose**: Confirms that an empty relative path resolves to the base path itself. It captures the behavior of joining and normalizing an empty input.

**Data flow**: Supplies `Path::new("")` and `/base/cwd` to `absolutize_from`, then asserts the returned `PathBuf` equals `/base/cwd`. It only reads the result.

**Call relations**: This test is invoked by the harness and documents how empty paths are treated by the join-plus-normalize pipeline.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::windows_root_relative_path_uses_base_prefix`  (lines 156–161)

```
fn windows_root_relative_path_uses_base_prefix()
```

**Purpose**: On Windows, verifies that a root-relative path like `\path\to\file` inherits the drive prefix from the base path. This distinguishes root-relative from fully absolute-with-prefix paths.

**Data flow**: Calls `absolutize_from` with a root-relative Windows path and base `C:\base\cwd`, then asserts the output is `C:\path\to\file`. It has no side effects.

**Call relations**: This Windows-only test is run by the harness to validate the Windows-specific `path_with_base` branch for `has_root()` paths.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::windows_drive_relative_path_uses_path_prefix_and_base_tail`  (lines 165–170)

```
fn windows_drive_relative_path_uses_path_prefix_and_base_tail()
```

**Purpose**: On Windows, checks that a drive-relative path like `D:path\to\file` keeps its own drive prefix while borrowing the base path tail. It documents the crate's explicit handling of prefixed-but-not-rooted paths.

**Data flow**: Passes `D:path\to\file` and base `C:\base\cwd` into `absolutize_from`, then asserts the result is `D:\base\cwd\path\to\file`. It only compares the returned path.

**Call relations**: The test runner invokes this Windows-only case to cover the most specialized branch in `path_with_base`.

*Call graph*: 1 external calls (assert_eq!).


### `app-server-client/src/path.rs`

`util` · `cross-cutting; used when callers need to manipulate app-server-host paths`

This file introduces `AppServerPath`, a thin newtype around `String` used when the client needs to reason about paths reported by the app-server host. The key design point is that these paths may follow either Unix or Windows absolute-path conventions regardless of the local process platform, so the helper methods avoid `std::path::Path` semantics and instead operate on strings with explicit platform detection.

`from_app_server` wraps any string-like value without validation, while `from_absolute_str` only accepts strings that look like absolute Unix paths (`/...`) or Windows absolute/UNC paths as recognized by `is_windows_absolute_path`. `components` splits the stored path into non-empty segments using `/` on Unix-like paths and both `/` and `\` on Windows-like paths. `join` appends a segment using the separator appropriate for the stored path style, trimming any trailing separators first so repeated joins do not accumulate duplicate delimiters. `as_str` exposes the raw stored string, and the `Display` impl delegates directly to the inner string.

The private `is_windows_absolute_path` helper recognizes drive-letter roots like `C:\` or `C:/` as well as UNC-style prefixes beginning with `\\` or `//`. The overall API is intentionally small and string-based so callers can safely manipulate remote host paths without accidentally normalizing them according to the local OS.

#### Function details

##### `AppServerPath::from_app_server`  (lines 9–11)

```
fn from_app_server(path: impl Into<String>) -> Self
```

**Purpose**: Wraps a path string originating from the app-server host without validating or transforming it.

**Data flow**: Consumes any `Into<String>` value, converts it into a `String`, stores it in `AppServerPath`, and returns the wrapper.

**Call relations**: Used when the path source is already trusted as app-server-native, such as reported Codex home paths.

*Call graph*: called by 2 (codex_home, set_thread_goal_draft_materializes_long_objective_and_confirms_before_paste); 1 external calls (into).


##### `AppServerPath::from_absolute_str`  (lines 13–15)

```
fn from_absolute_str(raw: &str) -> Option<Self>
```

**Purpose**: Parses a raw string into `AppServerPath` only if it appears to be an absolute Unix or Windows path.

**Data flow**: Reads a string slice, checks `raw.starts_with('/')` or `is_windows_absolute_path(raw)`, and returns `Some(AppServerPath(raw.to_string()))` on success or `None` otherwise.

**Call relations**: Used by callers that need to validate externally supplied path strings before treating them as host paths.

*Call graph*: calls 1 internal fn (is_windows_absolute_path); called by 1 (objective_file_path).


##### `AppServerPath::as_str`  (lines 17–19)

```
fn as_str(&self) -> &str
```

**Purpose**: Returns the raw stored path string.

**Data flow**: Reads `self` and returns `&self.0`.

**Call relations**: Used by code that needs the exact host path string for requests or display.

*Call graph*: called by 1 (request_fs_path).


##### `AppServerPath::components`  (lines 21–31)

```
fn components(&self) -> Vec<&str>
```

**Purpose**: Splits the stored host path into non-empty path components using separators appropriate to its detected path style.

**Data flow**: Reads `self.0`, chooses separator set based on `is_windows_absolute_path`, splits the string, filters out empty parts, collects them into `Vec<&str>`, and returns it.

**Call relations**: Used when callers need path-segment inspection without relying on local-platform path parsing.

*Call graph*: calls 1 internal fn (is_windows_absolute_path).


##### `AppServerPath::join`  (lines 33–41)

```
fn join(&self, segment: impl AsRef<str>) -> Self
```

**Purpose**: Appends one path segment using the separator style implied by the stored host path.

**Data flow**: Reads `self.0`, detects Windows-vs-Unix style with `is_windows_absolute_path`, trims trailing separators, formats the base plus one separator plus the provided segment, and returns a new `AppServerPath`.

**Call relations**: Used by callers constructing child paths relative to an app-server-host absolute path.

*Call graph*: calls 1 internal fn (is_windows_absolute_path); 1 external calls (format!).


##### `AppServerPath::fmt`  (lines 45–47)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Formats the wrapped host path for display.

**Data flow**: Reads `self.0` and delegates formatting to the inner string.

**Call relations**: Used implicitly by formatting macros and display-oriented code.


##### `is_windows_absolute_path`  (lines 50–58)

```
fn is_windows_absolute_path(path: &str) -> bool
```

**Purpose**: Recognizes Windows absolute and UNC path syntaxes in raw strings.

**Data flow**: Reads a string slice as bytes, checks for drive-letter-plus-colon-plus-slash/backslash prefixes or UNC prefixes beginning with `\\` or `//`, and returns a `bool`.

**Call relations**: Private helper used by `from_absolute_str`, `components`, and `join` to keep path-style detection consistent.

*Call graph*: called by 3 (components, from_absolute_str, join); 1 external calls (matches!).


### Filesystem path operations
These helpers build on the core path types to normalize, inspect, and safely operate on filesystem paths in local application code.

### `utils/path-utils/src/lib.rs`

`util` · `cross-cutting filesystem operations`

This file groups reusable path helpers used across Codex crates. The normalization functions split into two concerns. `normalize_for_path_comparison` canonicalizes a path through the filesystem and then applies WSL-specific normalization so `/mnt/<drive>` paths compare case-insensitively when running under WSL. `paths_match_after_normalization` uses that normalization opportunistically and falls back to raw path equality if either side cannot be canonicalized. Separately, `normalize_for_native_workdir` simplifies Windows verbatim paths via `dunce::simplified` so workdir paths are suitable for downstream native consumers.

The most involved logic is `resolve_symlink_write_paths`. Given a path, it follows symlink chains using `symlink_metadata` and `read_link`, resolves relative targets against the current symlink's parent, and tracks visited paths in a `HashSet` to detect cycles. On success it returns both a `read_path` pointing at the final non-symlink target and a `write_path` equal to that same resolved path. If metadata lookup, link resolution, or cycle detection fails, it deliberately degrades to `read_path: None` and `write_path: root`, preserving a safe original write location instead of guessing.

`write_atomically` handles durable replacement by creating parent directories, writing contents to a temporary file in the destination directory, and persisting it over the target path. The remaining private helpers implement WSL detection plumbing and ASCII-only lowercasing for `/mnt/<drive>` paths on Linux builds.

#### Function details

##### `normalize_for_path_comparison`  (lines 13–16)

```
fn normalize_for_path_comparison(path: impl AsRef<Path>) -> std::io::Result<PathBuf>
```

**Purpose**: Canonicalizes a path and then applies Codex's WSL-specific normalization rules so equivalent filesystem locations compare consistently. It is the strict normalization path used before equality checks.

**Data flow**: Accepts any `AsRef<Path>`, calls `canonicalize()` on the referenced path, then passes the resulting `PathBuf` into `normalize_for_wsl`. It returns the normalized `PathBuf` or propagates the underlying I/O error.

**Call relations**: Called by `paths_match_after_normalization` for both operands when normalization succeeds; it delegates WSL-specific adjustments to `normalize_for_wsl` after filesystem canonicalization.

*Call graph*: calls 1 internal fn (normalize_for_wsl); called by 1 (paths_match_after_normalization); 1 external calls (as_ref).


##### `paths_match_after_normalization`  (lines 21–29)

```
fn paths_match_after_normalization(left: impl AsRef<Path>, right: impl AsRef<Path>) -> bool
```

**Purpose**: Compares two paths using canonicalization and platform-specific normalization when possible, but degrades gracefully when normalization fails. This avoids turning missing-path comparisons into hard errors.

**Data flow**: Takes two path-like inputs, attempts `normalize_for_path_comparison` on both, and if both succeed compares the normalized `PathBuf`s. If either normalization fails, it falls back to direct equality of the original `Path` references and returns that boolean.

**Call relations**: This is the public comparison entrypoint; it orchestrates two normalization attempts and only uses raw equality as a fallback path.

*Call graph*: calls 1 internal fn (normalize_for_path_comparison); 1 external calls (as_ref).


##### `normalize_for_native_workdir`  (lines 31–33)

```
fn normalize_for_native_workdir(path: impl AsRef<Path>) -> PathBuf
```

**Purpose**: Normalizes a path for use as a native working directory, simplifying Windows-specific verbatim prefixes when running on Windows. On other platforms it leaves the path unchanged.

**Data flow**: Converts the input to a `PathBuf`, computes `cfg!(windows)`, and forwards both to `normalize_for_native_workdir_with_flag`, returning the resulting `PathBuf`.

**Call relations**: Public wrapper around `normalize_for_native_workdir_with_flag`; it supplies the compile-time platform flag so callers do not need to.

*Call graph*: calls 1 internal fn (normalize_for_native_workdir_with_flag); 2 external calls (as_ref, cfg!).


##### `resolve_symlink_write_paths`  (lines 46–119)

```
fn resolve_symlink_write_paths(path: &Path) -> io::Result<SymlinkWritePaths>
```

**Purpose**: Follows a symlink chain to find the final read target while preserving a safe write destination. It is designed for write workflows that want to respect symlink targets when possible but avoid unsafe guesses on errors or cycles.

**Data flow**: Starts from `path`, preferring an `AbsolutePathBuf` conversion when possible and otherwise using the original `PathBuf` as `root`. It loops on `current`: `symlink_metadata` returning `NotFound` yields `read_path: Some(current.clone())` and `write_path: current`; other metadata errors yield `read_path: None` and `write_path: root`. If metadata says the path is not a symlink, it returns that same success shape. For symlinks, it inserts `current` into a `HashSet` to detect cycles, reads the link target with `read_link`, resolves absolute targets directly or relative targets against `current.parent()` via `AbsolutePathBuf::resolve_path_against_base`, and updates `current` to the resolved path. Any failure in reading or resolving the link returns `read_path: None` with `write_path: root`.

**Call relations**: Called by higher-level write logic that needs both a readable resolved target and a conservative write location. Internally it coordinates metadata inspection, link reading, relative-target resolution, and cycle detection in one loop.

*Call graph*: calls 2 internal fn (from_absolute_path, resolve_path_against_base); 4 external calls (new, into_path_buf, read_link, symlink_metadata).


##### `write_atomically`  (lines 121–133)

```
fn write_atomically(write_path: &Path, contents: &str) -> io::Result<()>
```

**Purpose**: Writes text to a file by staging it in a temporary file in the destination directory and then persisting it over the target path. This minimizes partial-write exposure and ensures the parent directory exists.

**Data flow**: Accepts a destination `&Path` and `&str` contents. It reads `write_path.parent()` and returns `InvalidInput` if there is no parent, creates the parent directory tree with `create_dir_all`, creates a `NamedTempFile` in that directory, writes the contents to `tmp.path()`, persists the temp file to `write_path`, and returns `Ok(())` on success.

**Call relations**: Used by callers that need atomic-ish file replacement semantics. It delegates temporary-file creation to `tempfile` and filesystem writes to `std::fs`.

*Call graph*: 4 external calls (new_in, parent, create_dir_all, write).


##### `normalize_for_wsl`  (lines 135–137)

```
fn normalize_for_wsl(path: PathBuf) -> PathBuf
```

**Purpose**: Applies WSL-specific path normalization based on runtime environment detection. It is the bridge between generic path normalization and the `is_wsl` probe.

**Data flow**: Takes a `PathBuf`, calls `env::is_wsl()` to obtain a boolean, then forwards both to `normalize_for_wsl_with_flag`, returning the resulting `PathBuf`.

**Call relations**: Called by `normalize_for_path_comparison`; it exists mainly to separate runtime environment detection from the pure transformation logic in `normalize_for_wsl_with_flag`.

*Call graph*: calls 2 internal fn (is_wsl, normalize_for_wsl_with_flag); called by 1 (normalize_for_path_comparison).


##### `normalize_for_native_workdir_with_flag`  (lines 139–145)

```
fn normalize_for_native_workdir_with_flag(path: PathBuf, is_windows: bool) -> PathBuf
```

**Purpose**: Implements workdir normalization given an explicit `is_windows` flag. It strips Windows verbatim path prefixes only when requested.

**Data flow**: Accepts a `PathBuf` and a boolean. If `is_windows` is true, it passes the path to `dunce::simplified` and returns the simplified `PathBuf`; otherwise it returns the original path unchanged.

**Call relations**: Private helper used by `normalize_for_native_workdir` and directly by tests so platform-specific behavior can be exercised deterministically.

*Call graph*: called by 1 (normalize_for_native_workdir); 1 external calls (simplified).


##### `normalize_for_wsl_with_flag`  (lines 147–157)

```
fn normalize_for_wsl_with_flag(path: PathBuf, is_wsl: bool) -> PathBuf
```

**Purpose**: Implements the pure WSL normalization rule set given an explicit `is_wsl` flag. Only mounted Windows-drive paths are lowercased, and only when WSL mode is active.

**Data flow**: Accepts a `PathBuf` and a boolean. If `is_wsl` is false, it returns the path unchanged. If true, it calls `is_wsl_case_insensitive_path(&path)`; non-matching paths are returned unchanged, while matching `/mnt/<drive>/...` paths are transformed by `lower_ascii_path(path)`.

**Call relations**: Called by `normalize_for_wsl` and by tests. It delegates path-shape detection to `is_wsl_case_insensitive_path` and the actual bytewise lowercasing to `lower_ascii_path`.

*Call graph*: calls 2 internal fn (is_wsl_case_insensitive_path, lower_ascii_path); called by 1 (normalize_for_wsl).


##### `is_wsl_case_insensitive_path`  (lines 159–186)

```
fn is_wsl_case_insensitive_path(path: &Path) -> bool
```

**Purpose**: Recognizes Linux paths that refer to Windows-mounted drives under WSL and therefore should be treated case-insensitively. The accepted shape is `/mnt/<single-letter-drive>/...`.

**Data flow**: On Linux, it iterates `path.components()`, requiring a root directory, then a normal component equal to `mnt` under ASCII case-insensitive comparison, then a normal component whose bytes are exactly one ASCII alphabetic letter. It returns `true` only for that shape. On non-Linux builds it ignores the input and returns `false`.

**Call relations**: Used by `normalize_for_wsl_with_flag` to decide whether lowercasing should be applied. It relies on `ascii_eq_ignore_case` for matching the `mnt` component.

*Call graph*: calls 1 internal fn (ascii_eq_ignore_case); called by 1 (normalize_for_wsl_with_flag); 1 external calls (components).


##### `ascii_eq_ignore_case`  (lines 189–195)

```
fn ascii_eq_ignore_case(left: &[u8], right: &[u8]) -> bool
```

**Purpose**: Performs ASCII-only case-insensitive equality on two byte slices. It is a tiny helper used for path-component matching on Linux.

**Data flow**: Compares lengths first, then zips the slices and checks that each left byte lowercased with `to_ascii_lowercase()` equals the corresponding right byte. It returns a boolean and has no side effects.

**Call relations**: Called only by `is_wsl_case_insensitive_path` when matching the `mnt` component.

*Call graph*: called by 1 (is_wsl_case_insensitive_path).


##### `lower_ascii_path`  (lines 213–215)

```
fn lower_ascii_path(path: PathBuf) -> PathBuf
```

**Purpose**: Lowercases every byte of a path's OS-string representation using ASCII rules. On Linux this is used specifically for WSL-mounted Windows-drive paths.

**Data flow**: On Linux, it reads the raw bytes from `path.as_os_str().as_bytes()`, allocates a `Vec<u8>` with matching capacity, pushes each byte lowercased with `to_ascii_lowercase()`, converts the bytes back into an `OsString` with `from_vec`, and wraps that in a `PathBuf`. On non-Linux builds it simply returns the input path unchanged.

**Call relations**: Called by `normalize_for_wsl_with_flag` after `is_wsl_case_insensitive_path` has identified a path that should be normalized case-insensitively.

*Call graph*: called by 1 (normalize_for_wsl_with_flag); 4 external calls (from_vec, as_os_str, from, with_capacity).


### `utils/path-utils/src/env.rs`

`util` · `cross-cutting environment detection`

This file contains a single helper, `is_wsl`, whose job is to cheaply identify WSL so path comparison code can account for Windows-mounted drives being case-insensitive under `/mnt/<drive>`. The implementation is intentionally platform-gated. On Linux builds, it first checks the `WSL_DISTRO_NAME` environment variable, which is the fastest and most explicit signal that the process is running under WSL. If that variable is absent, it falls back to reading `/proc/version` and searching the lowercased contents for `microsoft`, which catches environments where the variable is unavailable but the kernel branding still reveals WSL.

On non-Linux targets the function always returns `false`, because WSL-specific path semantics are irrelevant there. Errors reading `/proc/version` are treated as a negative result rather than propagating, making the probe safe to call from normalization paths without introducing new failure modes. The design choice here is that WSL detection is best-effort and side-effect free: callers get a boolean hint, not a detailed diagnosis.

#### Function details

##### `is_wsl`  (lines 4–19)

```
fn is_wsl() -> bool
```

**Purpose**: Detects whether the current process appears to be running under Windows Subsystem for Linux. It uses environment inspection first and kernel-version text as a fallback.

**Data flow**: On Linux targets, it reads `std::env::var_os("WSL_DISTRO_NAME")`; if present, it returns `true`. Otherwise it reads `/proc/version` with `std::fs::read_to_string`, lowercases the contents, and returns whether they contain `microsoft`; read failures return `false`. On non-Linux targets it immediately returns `false`.

**Call relations**: Called by `normalize_for_wsl` in `path-utils` when deciding whether to apply WSL-specific lowercasing to mounted Windows-drive paths.

*Call graph*: called by 1 (normalize_for_wsl); 2 external calls (var_os, read_to_string).


### `core/src/utils/path_utils.rs`

`util` · `cross-cutting`

This file is a thin compatibility layer over `codex_utils_path`. It contains a single glob re-export, `pub use codex_utils_path::*;`, and therefore introduces no new behavior, state, or control flow. Its role is to make the external path utility crate appear as `core::utils::path_utils`, giving the core crate a stable internal import path and insulating callers from direct dependency details.

Because the re-export is a glob, every public item from `codex_utils_path` becomes available through this module. That is a deliberate design choice: `codex-core` treats the path helper crate as its path utility implementation rather than wrapping individual functions one by one. The tradeoff is broad exposure of the upstream API, but the benefit is zero maintenance overhead and no duplication. This file is active anywhere path normalization, joining, validation, or conversion helpers are needed, but only as an import surface; all actual logic lives in the re-exported crate.


### `ext/memories/src/local/path.rs`

`util` · `cross-cutting request handling`

This module contains the reusable path utilities that keep the local backend’s higher-level operations concise and consistent. `read_sorted_dir_paths` is the async directory enumeration primitive: it reads a directory with Tokio, treats a missing directory as an empty result rather than an error, collects each entry’s full path, sorts the paths lexicographically, and returns them. That deterministic ordering is important because both listing and recursive search rely on stable traversal order before later pagination or sorting.

`reject_symlink` centralizes the backend’s policy that memory paths must never traverse or target symlinks. Rather than exposing raw metadata checks everywhere, callers pass a display string and metadata; if the file type is a symlink, the helper returns `InvalidPath` with a fixed reason.

The hidden-path helpers implement the subsystem’s visibility rules. `is_hidden_component` checks a single path component for a leading dot and is used during scoped path resolution to make hidden paths appear absent. `is_hidden_path` checks the final filename of a concrete path and is used while enumerating directories. Finally, `display_relative_path` converts an absolute path under the backend root into a slash-joined relative string, stripping the root prefix when possible and dropping empty components. This keeps all externally returned paths normalized and root-relative.

#### Function details

##### `read_sorted_dir_paths`  (lines 7–21)

```
async fn read_sorted_dir_paths(
    dir_path: &Path,
) -> Result<Vec<PathBuf>, MemoriesBackendError>
```

**Purpose**: Reads all entries in a directory and returns their full paths in sorted order. It provides deterministic directory traversal for listing and search.

**Data flow**: Accepts `dir_path: &Path`, awaits `tokio::fs::read_dir(dir_path)`, returns `Ok(Vec::new())` if the directory is missing, otherwise iterates `next_entry()` collecting each `entry.path()` into a vector, sorts that vector in place, and returns it. Non-`NotFound` I/O errors are converted into `MemoriesBackendError`.

**Call relations**: Used by both `list` and recursive search traversal to enumerate child paths. It is a low-level helper and does not delegate to other project-local functions.

*Call graph*: called by 2 (list, search_entries); 2 external calls (new, read_dir).


##### `reject_symlink`  (lines 23–34)

```
fn reject_symlink(
    path: &str,
    metadata: &std::fs::Metadata,
) -> Result<(), MemoriesBackendError>
```

**Purpose**: Rejects filesystem objects that are symlinks according to metadata. It enforces the backend invariant that memory access never follows symlinked paths.

**Data flow**: Reads a display `path: &str` and `&std::fs::Metadata`; if `metadata.file_type().is_symlink()` is true, it returns `MemoriesBackendError::invalid_path(path, "must not be a symlink")`, otherwise `Ok(())`.

**Call relations**: Called from path resolution, directory creation, listing, reading, and searching whenever metadata has already been fetched. It provides the shared policy check those flows rely on before proceeding.

*Call graph*: calls 1 internal fn (invalid_path); called by 5 (resolve_scoped_path, ensure_directory, list, read, search); 1 external calls (file_type).


##### `is_hidden_component`  (lines 36–41)

```
fn is_hidden_component(component: Component<'_>) -> bool
```

**Purpose**: Determines whether a single path component is hidden by checking for a leading dot. It is used during path parsing before a full filesystem path is assembled.

**Data flow**: Accepts a `Component<'_>` and returns `true` only for `Component::Normal(name)` values whose lossy string form starts with `'.'`. It reads no external state.

**Call relations**: Used by `LocalMemoriesBackend::resolve_scoped_path` to reject hidden components early, causing hidden paths to be treated as not found.

*Call graph*: 1 external calls (matches!).


##### `is_hidden_path`  (lines 43–46)

```
fn is_hidden_path(path: &Path) -> bool
```

**Purpose**: Determines whether a concrete filesystem path’s final component is hidden. It is the enumeration-time counterpart to `is_hidden_component`.

**Data flow**: Reads `path.file_name()`, converts the name lossily if present, and returns whether it starts with `'.'`; if there is no filename, it returns `false` via `is_some_and`. No state is mutated.

**Call relations**: Called while iterating directory contents in `list` and `search_entries` so hidden files and directories are skipped from visible results and recursive traversal.

*Call graph*: called by 2 (list, search_entries); 1 external calls (file_name).


##### `display_relative_path`  (lines 48–56)

```
fn display_relative_path(root: &Path, path: &Path) -> String
```

**Purpose**: Formats a path for external responses as a slash-separated path relative to the backend root when possible. It hides absolute host filesystem details from callers.

**Data flow**: Accepts `root` and `path`, attempts `path.strip_prefix(root)`, falls back to the original path if stripping fails, iterates components, converts each to a lossy string, filters out empty components, joins them with `'/'`, and returns the resulting `String`.

**Call relations**: Used wherever the backend needs a stable user-facing path string: symlink error reporting during scoped resolution, list entries, search matches, and top-level search/list validation.

*Call graph*: called by 4 (resolve_scoped_path, list, build_search_match, search); 1 external calls (strip_prefix).


### `memories/read/src/lib.rs`

`orchestration` · `cross-cutting path derivation for memory read operations`

This crate root is intentionally small. Its module declarations expose `citations` and `usage` publicly while keeping `metrics` internal, matching the crate’s stated responsibility for memory injection support, citation parsing, and telemetry classification on the read path. The top-level documentation comment clarifies an important architectural boundary: this crate is read-only support code and deliberately does not depend on the memory write pipeline.

The only function, `memory_root`, computes the absolute path to the memories directory under a given Codex home directory by appending the literal `"memories"` segment to an `AbsolutePathBuf`. Centralizing this path derivation avoids scattering the directory name across callers and ensures all read-path code refers to the same root location. Because it returns another `AbsolutePathBuf`, callers keep the stronger path-type guarantee rather than dropping down to a plain relative or unchecked path representation.

#### Function details

##### `memory_root`  (lines 13–15)

```
fn memory_root(codex_home: &AbsolutePathBuf) -> AbsolutePathBuf
```

**Purpose**: Computes the absolute path of the memories directory beneath a Codex home directory. It is the crate’s canonical helper for locating read-path memory files.

**Data flow**: Takes `codex_home: &AbsolutePathBuf`, appends the literal path segment `"memories"` via `join`, and returns the resulting `AbsolutePathBuf`.

**Call relations**: This helper is used by callers elsewhere in the system whenever they need the standard memory root path. It does not perform I/O; it simply centralizes path construction.

*Call graph*: calls 1 internal fn (join).


### `git-utils/src/platform.rs`

`io_transport` · `filesystem operations when creating links`

This file is a tiny platform abstraction around symlink creation. Its single exported function, `create_symlink`, is compiled differently per target OS using `#[cfg]`. On Unix, the implementation ignores the original source path and directly creates a symlink from `destination` to `link_target` with `std::os::unix::fs::symlink`. On Windows, the implementation must choose between directory and file symlink APIs, so it first reads metadata from `source` using `std::fs::symlink_metadata`, inspects the file type with `FileTypeExt::is_symlink_dir`, and then calls either `symlink_dir` or `symlink_file` against `link_target` and `destination`.

The important design detail is that Windows decides the symlink kind from the existing `source`, not from `link_target`; callers therefore need `source` to accurately reflect whether the intended link points at a directory-like or file-like target. All OS errors are propagated through `?` and converted into `GitToolingError` via the crate’s error conversions. For any non-Unix, non-Windows target, the file emits a compile-time error rather than silently omitting support.

#### Function details

##### `create_symlink`  (lines 18–34)

```
fn create_symlink(
    source: &Path,
    link_target: &Path,
    destination: &Path,
) -> Result<(), GitToolingError>
```

**Purpose**: Creates a symlink at `destination` pointing to `link_target`, using the platform-appropriate syscall wrapper. On Windows it additionally determines whether to create a file or directory symlink by inspecting `source` metadata.

**Data flow**: Inputs are `source`, `link_target`, and `destination` paths. On Unix, it ignores `source` and directly invokes the Unix symlink API; on Windows, it reads filesystem metadata from `source`, branches on whether the file type is a symlinked directory, and then creates either a directory or file symlink from `link_target` to `destination`. It returns `Ok(())` on success or propagates filesystem errors as `GitToolingError`.

**Call relations**: This is the file’s sole abstraction point for symlink creation. Its internal flow is entirely platform-gated: the Windows variant delegates to metadata inspection before choosing the concrete symlink API, while the Unix variant delegates straight to the OS symlink call.

*Call graph*: 1 external calls (symlink_metadata).


### `state/src/paths.rs`

`util` · `cross-cutting`

This module contains a single utility function that bridges filesystem metadata and the runtime’s UTC timestamp conventions. Given a `&Path`, it asynchronously calls `tokio::fs::metadata` to fetch file metadata, then asks the metadata for its `modified()` system time. Both operations are fallible and intentionally collapsed into `Option` using `.ok()?`, so missing files, permission errors, unsupported platforms, or absent modification times all produce `None` rather than bubbling an error.

When a modification time is available, the function converts the returned system time into `chrono::DateTime<Utc>` using the standard `Into` conversion and returns it wrapped in `Some`. The design choice here is pragmatic: callers that use file mtimes for best-effort freshness checks or indexing can treat absence uniformly without needing to distinguish I/O failure modes. Because the function is async and Tokio-based, it fits naturally into the runtime’s broader asynchronous file-scanning and metadata ingestion flows.

#### Function details

##### `file_modified_time_utc`  (lines 5–9)

```
async fn file_modified_time_utc(path: &Path) -> Option<DateTime<Utc>>
```

**Purpose**: Fetches a file’s last modification time and returns it as a UTC chrono timestamp if available. It is a best-effort helper that suppresses filesystem errors by returning `None`.

**Data flow**: It takes a borrowed `Path`, awaits `tokio::fs::metadata(path)`, calls `.modified()` on the resulting metadata, converts the `SystemTime` into `DateTime<Utc>`, and returns `Some(updated_at)`. If metadata lookup or modification-time retrieval fails at any step, it short-circuits to `None`.

**Call relations**: Other runtime components call this when they need filesystem-derived update times during scanning or reconciliation, without wanting hard failures for missing or unreadable files.

*Call graph*: 1 external calls (metadata).


### `exec-server/src/regular_file.rs`

`io_transport` · `request handling`

This file is a small safety layer around `tokio::fs::OpenOptions` for read-only access. The exported `open` function constructs read-enabled open options, delegates platform tuning to `configure_open`, opens the path asynchronously, and then performs two post-open checks before returning the `tokio::fs::File`. First, it asks `is_disk_file` whether the underlying handle is a disk file; on Windows this uses `GetFileType` on the raw handle and rejects anything other than `FILE_TYPE_DISK`, while on non-Windows platforms the helper is a no-op that returns `true`. Second, it fetches metadata and requires `metadata().is_file()` so directories and other non-regular filesystem objects are rejected even if the open itself succeeded.

The design intentionally validates after opening rather than trusting the path string, which avoids races where the path target changes between inspection and open. Error reporting is concrete: invalid targets become `io::ErrorKind::InvalidInput` with the displayed path embedded in the message. Platform-specific open configuration is minimal but deliberate: Unix adds `O_NONBLOCK`, and Windows sets `SECURITY_IDENTIFICATION` QoS flags, matching the server’s need to safely interact with potentially unusual filesystem endpoints without accidentally treating them as regular readable files.

#### Function details

##### `open`  (lines 4–17)

```
async fn open(path: &Path) -> io::Result<tokio::fs::File>
```

**Purpose**: Opens a path for reading as a Tokio file and rejects it unless the opened handle represents a regular file. It is the file’s main entry point for safe read access.

**Data flow**: Takes `&Path`, creates `tokio::fs::OpenOptions`, enables read mode, and lets `configure_open` mutate the options with OS-specific flags. It asynchronously opens the path, reads handle/type state via `is_disk_file` and `metadata().is_file()`, and returns either the validated `tokio::fs::File` or an `io::Error` describing why the path is not an acceptable file.

**Call relations**: It is invoked by `open_file_for_read` when the server needs a readable local file. Inside its flow it first delegates option customization to `configure_open`, then uses `is_disk_file` as an additional platform check before deciding whether to return the file or synthesize an `InvalidInput` error.

*Call graph*: calls 2 internal fn (configure_open, is_disk_file); called by 1 (open_file_for_read); 3 external calls (new, format!, new).


##### `configure_open`  (lines 32–32)

```
fn configure_open(_options: &mut tokio::fs::OpenOptions)
```

**Purpose**: Applies platform-specific flags to the `OpenOptions` used by `open`. The exact behavior is selected at compile time by target OS.

**Data flow**: Receives a mutable `tokio::fs::OpenOptions` and mutates it in place. On Unix it adds `libc::O_NONBLOCK`; on Windows it sets `SECURITY_IDENTIFICATION` security QoS flags; on unsupported targets it leaves the options unchanged and returns no value.

**Call relations**: It is only called from `open` during option construction, before the actual filesystem open occurs. Its role is preparatory: it does not perform I/O itself, but influences how the subsequent `options.open(path)` behaves on each platform.

*Call graph*: called by 1 (open); 2 external calls (custom_flags, security_qos_flags).


##### `is_disk_file`  (lines 46–48)

```
fn is_disk_file(_file: &tokio::fs::File) -> bool
```

**Purpose**: Determines whether an already-opened Tokio file corresponds to a disk file handle. On Windows this filters out non-disk handle types that can still be wrapped as files.

**Data flow**: Takes `&tokio::fs::File`. On Windows it reads the raw OS handle with `AsRawHandle`, passes it to `GetFileType`, and returns `true` only for `FILE_TYPE_DISK`; on non-Windows builds it ignores the argument and returns `true` unconditionally.

**Call relations**: It is called by `open` immediately after the path is opened and before metadata validation. Its result participates in the final acceptance check that decides whether `open` returns the file or rejects the path as not being a regular file.

*Call graph*: called by 1 (open); 1 external calls (as_raw_handle).


### `file-watcher/src/lib.rs`

`domain_logic` · `startup for watcher creation, then request handling / background event loop during runtime`

This file defines the complete watch subsystem: subscriber-visible types (`FileWatcherEvent`, `WatchPath`, `FileWatcherSubscriber`, `WatchRegistration`, `Receiver`) and the internal state needed to multiplex one OS watcher across many logical consumers. `WatchState` tracks subscribers by numeric ID plus global reference counts per actual watched path; each subscriber stores immutable registration identity (`SubscriberWatchKey`) and mutable watch state (`SubscriberWatchState`) including the current actual OS watch path, duplicate-registration count, whether the requested path previously existed, and whether the registration began as a fallback from a missing path.

A key design choice is separating three path namespaces: `requested` (what the client asked for), `matched` (canonicalized path used to compare backend events), and `actual` (the existing path currently passed to the OS watcher). Missing targets are watched via the nearest existing ancestor directory non-recursively, then migrated closer as directories/files appear. Event routing first filters `notify::Event`s to mutating kinds only, then for each subscriber and each event path computes subscriber-visible changed paths, preserving delete/create semantics for fallback watches via `last_exists`. Delivery uses a custom async channel backed by `BTreeSet<PathBuf>` so duplicates are removed and paths are sorted. OS watch reconfiguration is reference-counted and mode-aware: multiple registrations can upgrade a path from non-recursive to recursive and downgrade it again when registrations disappear.

#### Function details

##### `Receiver::recv`  (lines 116–132)

```
async fn recv(&mut self) -> Option<FileWatcherEvent>
```

**Purpose**: Waits asynchronously for the next coalesced batch of changed paths for one subscriber. It returns `None` only when all senders for that subscriber have been dropped and no buffered paths remain.

**Data flow**: Reads `self.inner.changed_paths`, `self.inner.notify`, and `self.inner.sender_count`. It first snapshots a notification future, then locks the async `BTreeSet<PathBuf>`; if the set is non-empty it drains it into a `FileWatcherEvent { paths }`, preserving sorted/deduplicated order. If the set is empty and `sender_count` is zero, it returns `None`; otherwise it awaits the notification and loops.

**Call relations**: This is the consumer-facing receive primitive used by higher-level code and by the throttling/debouncing wrappers. Those wrappers repeatedly invoke it to obtain raw batches, while sender shutdown via `WatchSender::drop` is what eventually causes the terminal `None` path.

*Call graph*: called by 26 (next_event, recv_broadcast_message, next_event, read_response, read_thread_started_notification, recv_status_changed_notification, next_runtime_command, next_event, forward_ops, next_event (+15 more)); 1 external calls (take).


##### `WatchSender::add_changed_paths`  (lines 136–147)

```
async fn add_changed_paths(&self, paths: &[PathBuf])
```

**Purpose**: Adds one or more changed paths into the subscriber’s pending set and wakes the receiver only if the set actually grew. This avoids redundant wakeups when duplicate paths arrive.

**Data flow**: Takes a slice of `PathBuf`; if empty, returns immediately. Otherwise it locks `changed_paths`, records the previous set length, extends the `BTreeSet` with cloned paths, and if the new length differs from the old length it calls `notify_one` on the shared `Notify`.

**Call relations**: It is invoked after `FileWatcher::notify_subscribers` has computed per-subscriber path lists. It does not perform matching itself; its role is the final enqueue/coalescing step before `Receiver::recv` drains the batch.

*Call graph*: 2 external calls (is_empty, iter).


##### `WatchSender::clone`  (lines 151–156)

```
fn clone(&self) -> Self
```

**Purpose**: Creates another sender handle for the same receiver state while incrementing the sender reference count used for shutdown detection.

**Data flow**: Reads and updates `sender_count` with `fetch_add`, then clones the inner `Arc<ReceiverInner>` into a new `WatchSender`.

**Call relations**: Cloning happens when subscriber notifications are staged for async delivery, so the sender can outlive temporary borrow scopes. `Receiver::recv` relies on the count maintained here and in `WatchSender::drop` to know when no more events can arrive.

*Call graph*: 1 external calls (clone).


##### `WatchSender::drop`  (lines 160–164)

```
fn drop(&mut self)
```

**Purpose**: Decrements the sender reference count and wakes any waiting receivers when the last sender disappears. This is the shutdown signal for a subscriber channel.

**Data flow**: Atomically decrements `sender_count`; if the previous count was 1, it calls `notify_waiters` so blocked receivers can re-check state and return `None`.

**Call relations**: Runs automatically when subscriber state is removed or temporary sender clones are dropped. It complements `Receiver::recv`, which checks `sender_count` after observing an empty pending-path set.


##### `watch_channel`  (lines 167–179)

```
fn watch_channel() -> (WatchSender, Receiver)
```

**Purpose**: Constructs the internal sender/receiver pair used for one subscriber’s event stream.

**Data flow**: Allocates a `ReceiverInner` containing an empty async `BTreeSet`, a fresh `Notify`, and `sender_count = 1`, then returns a `WatchSender` and `Receiver` sharing that `Arc`.

**Call relations**: Used only when `FileWatcher::add_subscriber` creates a new logical consumer. The returned sender is stored in subscriber state; the receiver is handed to the caller.

*Call graph*: called by 1 (add_subscriber); 6 external calls (clone, new, new, new, new, new).


##### `PathWatchCounts::increment`  (lines 188–194)

```
fn increment(&mut self, recursive: bool, amount: usize)
```

**Purpose**: Adds registrations to either the recursive or non-recursive count for one actual watched path.

**Data flow**: Consumes `recursive: bool` and `amount: usize`; increments `self.recursive` or `self.non_recursive` accordingly.

**Call relations**: Called during registration and actual-watch migration to update global path reference counts before deciding whether the OS watcher mode must change.


##### `PathWatchCounts::decrement`  (lines 196–202)

```
fn decrement(&mut self, recursive: bool, amount: usize)
```

**Purpose**: Removes registrations from either the recursive or non-recursive count for one actual watched path, saturating at zero.

**Data flow**: Consumes `recursive: bool` and `amount: usize`; subtracts from the selected counter using `saturating_sub`.

**Call relations**: Used during unregister, subscriber removal, and actual-watch migration. Its saturating behavior prevents underflow if duplicate drops or mismatched counts occur.


##### `PathWatchCounts::effective_mode`  (lines 204–212)

```
fn effective_mode(self) -> Option<RecursiveMode>
```

**Purpose**: Computes the single `notify::RecursiveMode` that should be installed for a path given all current registrations.

**Data flow**: Reads the two counters and returns `Some(Recursive)` if any recursive registrations exist, else `Some(NonRecursive)` if only non-recursive registrations exist, else `None` if no registrations remain.

**Call relations**: Registration, unregistration, removal, and watch migration compare the previous and next effective modes to decide whether `reconfigure_watch` must touch the OS watcher.


##### `PathWatchCounts::is_empty`  (lines 214–216)

```
fn is_empty(self) -> bool
```

**Purpose**: Reports whether no registrations remain for a path.

**Data flow**: Returns `true` when both counters are zero.

**Call relations**: Used after decrements to decide whether to remove the path entirely from `WatchState.path_ref_counts`.


##### `ThrottledWatchReceiver::new`  (lines 233–239)

```
fn new(rx: Receiver, interval: Duration) -> Self
```

**Purpose**: Wraps a raw subscriber `Receiver` with a minimum emission interval. It preserves batches but enforces spacing between them.

**Data flow**: Stores the provided `Receiver`, `Duration`, and initializes `next_allowed` to `None`.

**Call relations**: Constructed by callers that want rate limiting on top of the raw watcher stream. Its `recv` method delegates to the underlying receiver.

*Call graph*: called by 10 (spawn_event_loop, ancestor_events_notify_child_watches, matching_subscribers_are_notified, missing_directory_watch_moves_to_created_directory_for_child_events, missing_file_watch_reports_requested_path_when_parent_changes, missing_file_watch_reports_requested_path_when_parent_delete_event_arrives, non_recursive_watch_ignores_grandchildren, spawn_event_loop_filters_non_mutating_events, throttled_receiver_coalesces_within_interval, throttled_receiver_flushes_pending_on_shutdown).


##### `ThrottledWatchReceiver::recv`  (lines 243–253)

```
async fn recv(&mut self) -> Option<FileWatcherEvent>
```

**Purpose**: Receives the next raw event batch, sleeping until the next allowed instant if the previous batch was emitted too recently.

**Data flow**: Reads `next_allowed`; if present, awaits `sleep_until`. Then awaits `self.rx.recv()`. When an event is returned, it sets `next_allowed` to `Instant::now() + interval`; if the underlying receiver is closed, it returns `None` unchanged.

**Call relations**: This is a thin policy layer over `Receiver::recv`. It is used by consumers that want at most one notification per interval rather than immediate delivery.

*Call graph*: calls 1 internal fn (recv); 2 external calls (now, sleep_until).


##### `DebouncedWatchReceiver::new`  (lines 266–272)

```
fn new(rx: Receiver, interval: Duration) -> Self
```

**Purpose**: Wraps a raw subscriber `Receiver` with a debounce window that merges all events arriving shortly after the first one.

**Data flow**: Stores the provided `Receiver`, debounce `Duration`, and an empty `BTreeSet<PathBuf>` accumulator.

**Call relations**: Constructed by callers that want burst coalescing beyond the raw channel’s set-based deduplication. Its `recv` method repeatedly pulls from the underlying receiver.

*Call graph*: called by 3 (watch, debounced_receiver_coalesces_each_event_batch, debounced_receiver_flushes_pending_on_shutdown); 1 external calls (new).


##### `DebouncedWatchReceiver::recv`  (lines 275–296)

```
async fn recv(&mut self) -> Option<FileWatcherEvent>
```

**Purpose**: Waits for the first event in a batch, then keeps collecting additional events until the fixed deadline expires or the underlying stream closes.

**Data flow**: If the accumulator is empty, it awaits `self.rx.recv()?` and extends the `BTreeSet` with the returned paths. It computes `deadline = now + interval`, then loops with `tokio::select!` between another `rx.recv()` and `sleep_until(deadline)`. Additional paths are merged into the set; on timeout or channel closure it drains the set into a sorted `FileWatcherEvent`.

**Call relations**: Acts as a higher-level consumer of `Receiver::recv`. Unlike throttling, it intentionally delays the first emission in order to absorb a burst into one batch.

*Call graph*: calls 1 internal fn (recv); 5 external calls (extend, is_empty, now, take, select!).


##### `FileWatcherSubscriber::register_paths`  (lines 308–331)

```
fn register_paths(&self, watched_paths: Vec<WatchPath>) -> WatchRegistration
```

**Purpose**: Registers one subscriber’s requested watch paths, normalizing duplicates and resolving each request into requested/matched/actual forms. It returns an RAII guard that will unregister the same logical registrations on drop.

**Data flow**: Takes `Vec<WatchPath>`, sorts/deduplicates it via `dedupe_watched_paths`, maps each request through `actual_watch_path` to build `SubscriberWatchRegistration` values, then calls `self.file_watcher.register_paths(self.id, &watched_paths)`. It returns `WatchRegistration` containing a weak pointer to the watcher, the subscriber ID, and the immutable `SubscriberWatchKey`s.

**Call relations**: Called by external code through the subscriber handle. It is the only public path-registration entrypoint and delegates all shared-state mutation to `FileWatcher::register_paths`.

*Call graph*: calls 1 internal fn (dedupe_watched_paths); called by 3 (register_runtime_extra_roots, register_thread_config, register_path); 1 external calls (downgrade).


##### `FileWatcherSubscriber::register_path`  (lines 334–336)

```
fn register_path(&self, path: PathBuf, recursive: bool) -> WatchRegistration
```

**Purpose**: Test-only convenience wrapper for registering a single path with a recursive flag.

**Data flow**: Builds a one-element `Vec<WatchPath>` from `path` and `recursive`, then forwards to `register_paths` and returns its `WatchRegistration`.

**Call relations**: Used only in tests to reduce boilerplate around single-path registrations.

*Call graph*: calls 1 internal fn (register_paths); 1 external calls (vec!).


##### `FileWatcherSubscriber::drop`  (lines 340–342)

```
fn drop(&mut self)
```

**Purpose**: Automatically removes the entire subscriber and all of its registrations when the subscriber handle is dropped.

**Data flow**: Calls `self.file_watcher.remove_subscriber(self.id)`; all associated sender state and path reference counts are cleaned up there.

**Call relations**: This is the subscriber-level RAII cleanup path, distinct from `WatchRegistration::drop`, which removes only a subset of registrations while keeping the subscriber alive.


##### `WatchRegistration::default`  (lines 353–359)

```
fn default() -> Self
```

**Purpose**: Creates an inert registration guard that unregisters nothing when dropped.

**Data flow**: Builds a `WatchRegistration` with an empty weak watcher reference, subscriber ID `0`, and an empty watched-path list.

**Call relations**: Used as a placeholder/default value by callers that need an optional registration slot.

*Call graph*: called by 3 (new, register_thread_config, clear_listener); 2 external calls (new, new).


##### `WatchRegistration::drop`  (lines 363–367)

```
fn drop(&mut self)
```

**Purpose**: Unregisters the paths represented by this guard if the owning `FileWatcher` still exists.

**Data flow**: Attempts to upgrade the stored weak pointer; if successful, calls `file_watcher.unregister_paths(self.subscriber_id, &self.watched_paths)`.

**Call relations**: This is the path-level RAII cleanup path created by `FileWatcherSubscriber::register_paths`. It allows registrations to be scoped independently of subscriber lifetime.

*Call graph*: 1 external calls (upgrade).


##### `FileWatcher::new`  (lines 379–396)

```
fn new() -> notify::Result<Self>
```

**Purpose**: Creates a live watcher backed by `notify::recommended_watcher`, bridges callback events into a Tokio channel, and starts the async event loop.

**Data flow**: Creates an unbounded Tokio MPSC channel, builds a `RecommendedWatcher` whose callback forwards `notify::Result<Event>` into that channel, initializes `FileWatcherInner { watcher, watched_paths }` and shared `WatchState`, then calls `spawn_event_loop(raw_rx)` before returning the `FileWatcher`.

**Call relations**: This is the main constructor for production use. The spawned loop later invokes `notify_subscribers` for mutating backend events.

*Call graph*: called by 5 (new, new, dropping_live_watcher_releases_inner_watcher, recursive_registration_downgrades_to_non_recursive_after_drop, unregister_holds_state_lock_until_unwatch_finishes); 7 external calls (new, new, new, new, default, unbounded_channel, recommended_watcher).


##### `FileWatcher::noop`  (lines 400–405)

```
fn noop() -> Self
```

**Purpose**: Creates an inert watcher with no underlying OS watcher, intended for tests or synthetic notifications.

**Data flow**: Returns `FileWatcher { inner: None, state: default WatchState }`.

**Call relations**: Used where callers want all registration/matching logic without touching the real filesystem backend. Functions that reconfigure watches become no-ops when `inner` is absent.

*Call graph*: called by 16 (new, manager_with_noop_watcher, new, ancestor_events_notify_child_watches, deeply_missing_path_registers_nearest_existing_directory_ancestor, matching_subscribers_are_notified, missing_directory_watch_moves_to_created_directory_for_child_events, missing_file_watch_reports_requested_path_when_parent_changes, missing_file_watch_reports_requested_path_when_parent_delete_event_arrives, missing_path_registers_nearest_existing_parent (+6 more)); 3 external calls (new, new, default).


##### `FileWatcher::add_subscriber`  (lines 409–430)

```
fn add_subscriber(self: &Arc<Self>) -> (FileWatcherSubscriber, Receiver)
```

**Purpose**: Allocates a new logical subscriber ID, installs subscriber state, and returns both the subscriber handle and its dedicated receiver.

**Data flow**: Creates a sender/receiver pair with `watch_channel`, locks `state` for writing, assigns `next_subscriber_id`, inserts `SubscriberState { watched_paths: HashMap::new(), tx }`, then returns `FileWatcherSubscriber { id, file_watcher }` plus the `Receiver`.

**Call relations**: This is the public entrypoint for consumers to join the watcher. The returned subscriber is later used to register paths; the receiver is consumed directly or wrapped in throttling/debouncing.

*Call graph*: calls 1 internal fn (watch_channel); 1 external calls (new).


##### `FileWatcher::register_paths`  (lines 432–476)

```
fn register_paths(
        &self,
        subscriber_id: SubscriberId,
        watched_paths: &[SubscriberWatchRegistration],
    )
```

**Purpose**: Merges one subscriber’s registrations into shared state, increments duplicate counts, updates global path reference counts, and reconfigures OS watches when effective modes change.

**Data flow**: Takes a subscriber ID and slice of `SubscriberWatchRegistration`. Under the write lock, it updates or inserts each `SubscriberWatchState`, preserving the existing `actual` path for duplicate registrations and initializing `last_exists` from the matched path’s current existence. For each resulting actual path it updates `path_ref_counts`, compares previous and next `effective_mode`, and calls `reconfigure_watch` when needed.

**Call relations**: Invoked only from `FileWatcherSubscriber::register_paths`. It is the central registration mutator and delegates backend changes to `reconfigure_watch`.

*Call graph*: calls 1 internal fn (reconfigure_watch).


##### `FileWatcher::unregister_paths`  (lines 478–516)

```
fn unregister_paths(&self, subscriber_id: SubscriberId, watched_paths: &[SubscriberWatchKey])
```

**Purpose**: Removes one subscriber’s registrations by key, decrements duplicate counts and global path reference counts, and downgrades or removes OS watches as needed.

**Data flow**: Under the write lock, it looks up each `SubscriberWatchKey`, decrements its per-subscriber `count`, removes the entry when the count reaches zero, then decrements the corresponding `PathWatchCounts` for the actual path. Empty path counts are removed from the map, and any effective-mode transition triggers `reconfigure_watch`.

**Call relations**: Called from `WatchRegistration::drop`. It performs partial cleanup for a still-live subscriber, unlike `remove_subscriber`, which tears down everything at once.

*Call graph*: calls 1 internal fn (reconfigure_watch).


##### `FileWatcher::remove_subscriber`  (lines 518–554)

```
fn remove_subscriber(&self, subscriber_id: SubscriberId)
```

**Purpose**: Deletes an entire subscriber and releases all watch references held by its registrations.

**Data flow**: Under the write lock, removes the `SubscriberState` from `state.subscribers`. It then iterates all remaining `SubscriberWatchState`s from that subscriber, decrements global path counts by each watch’s stored `count`, removes empty entries, and reconfigures backend watches when effective modes change.

**Call relations**: Triggered by `FileWatcherSubscriber::drop`. It is the final cleanup path for a subscriber and also causes the subscriber’s `WatchSender` to be dropped, eventually closing the receiver.

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

**Purpose**: Thin instance method that forwards watch reconfiguration to the shared helper using this watcher’s optional backend.

**Data flow**: Passes `self.inner.as_ref()`, the target path, desired `Option<RecursiveMode>`, and the reusable mutex-guard slot into `reconfigure_watch_inner`.

**Call relations**: Used by registration, unregistration, and subscriber removal whenever path reference counts imply a backend watch mode transition.

*Call graph*: called by 3 (register_paths, remove_subscriber, unregister_paths); 1 external calls (reconfigure_watch_inner).


##### `FileWatcher::reconfigure_watch_inner`  (lines 565–608)

```
fn reconfigure_watch_inner(
        inner: Option<&'a Arc<Mutex<FileWatcherInner>>>,
        path: &Path,
        next_mode: Option<RecursiveMode>,
        inner_guard: &mut Option<std::sync::MutexGua
```

**Purpose**: Synchronizes one actual path’s desired watch mode with the underlying `notify` watcher, reusing a single mutex guard across multiple updates and tolerating backend failures.

**Data flow**: If no backend exists, returns immediately. Otherwise it lazily acquires `FileWatcherInner`’s mutex into `inner_guard`, reads the currently installed mode from `watched_paths`, and if unchanged does nothing. If a watch exists, it attempts `unwatch(path)` and removes the map entry. If `next_mode` is `Some` and the path currently exists, it attempts `watch(path, next_mode)` and records the installed mode on success; failures are logged with `warn!`.

**Call relations**: This is the only function that touches the OS watcher directly. It is called indirectly from all state transitions that affect actual watch placement or recursion mode.

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

**Purpose**: Moves reference counts from one actual watched path to another when a fallback registration can now watch a closer existing path.

**Data flow**: Given `old_actual`, `new_actual`, and a registration `count`, it decrements the old path’s `PathWatchCounts`, possibly removing or reconfiguring that watch, then increments the new path’s counts and possibly configures that watch. If the paths are identical, it returns immediately.

**Call relations**: Called from `notify_subscribers` after event processing discovers that requested paths have appeared or moved the nearest existing ancestor. It keeps backend watch placement aligned with evolving filesystem reality.

*Call graph*: 1 external calls (reconfigure_watch_inner).


##### `FileWatcher::spawn_event_loop`  (lines 645–672)

```
fn spawn_event_loop(&self, mut raw_rx: mpsc::UnboundedReceiver<notify::Result<Event>>)
```

**Purpose**: Bridges callback-based `notify` events into the Tokio runtime and dispatches only mutating events with non-empty path lists to subscriber matching.

**Data flow**: Attempts `Handle::try_current()`. If successful, clones shared state and a weak backend pointer, then spawns an async loop reading `raw_rx.recv().await`. Successful events are filtered through `is_mutating_event` and `event.paths.is_empty()`, then passed to `notify_subscribers`; backend errors are logged, and channel closure ends the loop. If no runtime exists, it logs a warning and does nothing.

**Call relations**: Started by `FileWatcher::new` and test helper `spawn_event_loop_for_test`. It is the runtime driver that feeds backend events into the matching logic.

*Call graph*: calls 1 internal fn (is_mutating_event); called by 1 (spawn_event_loop_for_test); 5 external calls (clone, try_current, notify_subscribers, recv, warn!).


##### `FileWatcher::notify_subscribers`  (lines 674–733)

```
async fn notify_subscribers(
        state: &RwLock<WatchState>,
        inner: Option<&Arc<Mutex<FileWatcherInner>>>,
        event_paths: &[PathBuf],
    )
```

**Purpose**: Matches raw event paths against every subscriber watch, computes subscriber-visible changed paths, updates fallback watch placement, and asynchronously enqueues notifications.

**Data flow**: Takes shared `WatchState`, optional backend, and a slice of event paths. Under the write lock it iterates all subscribers and all their watches for each event path, calling `changed_path_for_event` to decide whether to emit a path and `actual_watch_path` to see whether the watch’s actual backend path should move. It accumulates `(old_actual, new_actual, count)` moves and `(WatchSender, Vec<PathBuf>)` notifications, applies all actual-watch moves via `apply_actual_watch_move`, then drops the lock and awaits `add_changed_paths` on each sender.

**Call relations**: Called by the live event loop and by test helpers. It is the core routing engine tying together path matching, fallback semantics, backend watch migration, and final delivery.

*Call graph*: calls 2 internal fn (actual_watch_path, changed_path_for_event); 2 external calls (apply_actual_watch_move, new).


##### `FileWatcher::send_paths_for_test`  (lines 736–738)

```
async fn send_paths_for_test(&self, paths: Vec<PathBuf>)
```

**Purpose**: Injects synthetic event paths directly into subscriber matching without using the OS watcher.

**Data flow**: Forwards the provided `Vec<PathBuf>` to `notify_subscribers(&self.state, self.inner.as_ref(), &paths).await`.

**Call relations**: Test-only helper for exercising matching and fallback logic in `noop` or live watchers.

*Call graph*: 1 external calls (notify_subscribers).


##### `FileWatcher::spawn_event_loop_for_test`  (lines 741–746)

```
fn spawn_event_loop_for_test(
        &self,
        raw_rx: mpsc::UnboundedReceiver<notify::Result<Event>>,
    )
```

**Purpose**: Exposes the normal event-loop startup for tests that want to feed a custom raw event channel.

**Data flow**: Simply forwards the provided receiver to `spawn_event_loop`.

**Call relations**: Used in tests to validate callback-to-Tokio bridging and event filtering behavior.

*Call graph*: calls 1 internal fn (spawn_event_loop).


##### `FileWatcher::watch_counts_for_test`  (lines 749–758)

```
fn watch_counts_for_test(&self, path: &Path) -> Option<(usize, usize)>
```

**Purpose**: Returns the current non-recursive and recursive reference counts for one actual watched path.

**Data flow**: Reads `state.path_ref_counts` under a read lock and maps the stored `PathWatchCounts` to `(non_recursive, recursive)`.

**Call relations**: Test-only inspection helper for verifying registration and migration bookkeeping.


##### `is_mutating_event`  (lines 761–766)

```
fn is_mutating_event(event: &Event) -> bool
```

**Purpose**: Filters `notify::Event`s down to create, modify, and remove operations.

**Data flow**: Matches `event.kind` against `EventKind::Create(_) | Modify(_) | Remove(_)` and returns a boolean.

**Call relations**: Used by the background event loop to ignore non-mutating backend notifications before any subscriber matching work is done.

*Call graph*: called by 1 (spawn_event_loop); 1 external calls (matches!).


##### `dedupe_watched_paths`  (lines 768–777)

```
fn dedupe_watched_paths(mut watched_paths: Vec<WatchPath>) -> Vec<WatchPath>
```

**Purpose**: Sorts and removes duplicate `WatchPath` registrations so repeated identical requests do not create redundant registration records.

**Data flow**: Sorts the vector by path string then `recursive` flag, calls `dedup`, and returns the normalized vector.

**Call relations**: Applied at subscriber registration time before resolving actual/matched paths.

*Call graph*: called by 1 (register_paths).


##### `actual_watch_path`  (lines 785–823)

```
fn actual_watch_path(requested: &WatchPath) -> (WatchPath, WatchPath, bool)
```

**Purpose**: Resolves a requested watch into the actual existing path to hand to the OS watcher, the canonicalized path namespace to match backend events against, and a flag indicating fallback-from-missing behavior.

**Data flow**: If `requested.path` exists, it canonicalizes that path for matching, returns the original request as `actual`, and `fallback = false`. Otherwise it walks parent directories upward until it finds an existing directory, returns that ancestor as a non-recursive `actual` watch, constructs a canonical matched path by joining the missing suffix onto the ancestor’s canonical path, and sets `fallback = true`. If no ancestor directory exists, it falls back to returning the request unchanged with `fallback = false`.

**Call relations**: Used during initial registration and again during event processing to detect when a fallback watch can move closer to the requested target.

*Call graph*: called by 1 (notify_subscribers); 1 external calls (clone).


##### `changed_path_for_event`  (lines 830–852)

```
fn changed_path_for_event(
    subscriber_watch: &SubscriberWatchKey,
    subscriber_watch_state: &mut SubscriberWatchState,
    event_path: &Path,
) -> Option<PathBuf>
```

**Purpose**: Converts one backend event path into the subscriber-visible changed path for a specific watch, trying canonical matching first and requested-path matching second.

**Data flow**: Calls `changed_path_for_matched_path` with `subscriber_watch.matched`; if that returns `Some`, it is returned immediately. If the matched and requested paths are identical, it returns `None`; otherwise it retries with `subscriber_watch.requested`.

**Call relations**: Called from `notify_subscribers` for every event path and watch pair. The two-pass strategy handles backends that canonicalize paths as well as synthetic tests or backends that preserve original spelling.

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

**Purpose**: Applies the detailed path-matching rules for one namespace, including exact matches, ancestor events for missing/fallback watches, recursive child matches, and mapping results back into the subscriber’s requested namespace.

**Data flow**: Reads `subscriber_watch.requested`, the chosen `matched` watch, mutable `subscriber_watch_state`, and `event_path`. Exact equality emits the requested path and refreshes `last_exists`. If `matched.path.starts_with(event_path)`, the event is on an ancestor of the watched path; fallback or moved-actual watches emit the requested path only when the target now exists or previously existed, preserving delete notifications via `last_exists`. If the event is below the watched path, it requires either recursive watching or a direct child for non-recursive mode, then strips the matched prefix and joins the suffix onto the requested path. Non-matches return `None`.

**Call relations**: This is the low-level matcher used exclusively by `changed_path_for_event`. Its state updates (`last_exists`) are essential for correct create/delete behavior when watching missing paths through ancestors.

*Call graph*: called by 1 (changed_path_for_event); 4 external calls (parent, starts_with, strip_prefix, to_path_buf).


### `file-system/src/lib.rs`

`data_model` · `cross-cutting filesystem abstraction and sandbox setup`

This file is primarily a shared contract layer. It defines small option/data structs for directory creation, removal, copying, metadata, and directory entries, then introduces `FileSystemSandboxContext`, the serializable description of filesystem permissions and related sandbox settings that can cross process or host boundaries. The context stores a `PermissionProfile<PathUri>`, optional `cwd`, Windows sandbox settings, and the `use_legacy_landlock` compatibility bit.

The key logic in this file is the conversion and inspection of sandbox context. `from_legacy_sandbox_policy` projects an older `SandboxPolicy` into the newer filesystem-specific permission model by first converting the URI cwd to a native absolute path, deriving a `FileSystemSandboxPolicy` for that cwd, combining it with sandbox enforcement and network policy into a `PermissionProfile<AbsolutePathBuf>`, and then converting that profile back into URI form with cwd retained. `from_permission_profile` and `from_permission_profile_with_cwd` are simpler constructors over the same internal helper.

Two predicates capture important semantics. `should_run_in_sandbox` attempts to convert the URI-based permission profile back into native absolute paths; if that fails, the context is assumed to belong to another host and must not select an unsandboxed filesystem, so it returns `true`. Otherwise it checks for a restricted filesystem policy without full-disk write access. `has_cwd_dependent_permissions` inspects managed restricted entries for relative glob patterns or `ProjectRoots` special paths, and `drop_cwd_if_unused` removes the cwd only when those dependencies are absent.

The rest of the file defines `FileSystemReadStream`, a boxed stream of `Bytes`, and the `ExecutorFileSystem` trait. Most methods are abstract async operations over `PathUri`; the only provided behavior is `read_file_text`, which reads bytes through `read_file` and converts them to UTF-8, returning `InvalidData` on decoding failure.

#### Function details

##### `FileSystemSandboxContext::from_legacy_sandbox_policy`  (lines 73–92)

```
fn from_legacy_sandbox_policy(
        sandbox_policy: SandboxPolicy,
        cwd: PathUri,
    ) -> io::Result<Self>
```

**Purpose**: Projects a legacy `SandboxPolicy` plus cwd into the newer serializable filesystem sandbox context.

**Data flow**: Takes a `SandboxPolicy` and `PathUri` cwd, converts the cwd to a native absolute path with `to_abs_path()`, derives a `FileSystemSandboxPolicy` for that cwd, computes sandbox enforcement and network policy from the legacy policy, builds a `PermissionProfile<AbsolutePathBuf>` from those pieces, then returns `Self::from_permission_profile_with_cwd(permissions, cwd)` inside `Ok(...)`.

**Call relations**: Used when older sandbox policy representations need to be translated at the receiving-host boundary into the newer filesystem abstraction.

*Call graph*: calls 4 internal fn (from_legacy_sandbox_policy, from_legacy_sandbox_policy_for_cwd, from, to_abs_path); 2 external calls (from_runtime_permissions_with_enforcement, from_permission_profile_with_cwd).


##### `FileSystemSandboxContext::from_permission_profile`  (lines 94–96)

```
fn from_permission_profile(permissions: PermissionProfile<AbsolutePathBuf>) -> Self
```

**Purpose**: Constructs a sandbox context from a permission profile when no cwd needs to be retained.

**Data flow**: Consumes `PermissionProfile<AbsolutePathBuf>` and delegates to `from_permissions_and_cwd(permissions, None)`.

**Call relations**: Used by callers that already have a resolved permission profile and do not need cwd-dependent path interpretation.

*Call graph*: called by 7 (read_only_sandbox, workspace_write_sandbox, test_environment_rejects_sandboxed_filesystem_without_runtime_paths, sandbox_cwd_rejects_cwd_dependent_profile_without_context_cwd, sandboxed_file_system_rejects_non_native_uri_as_invalid_input, read_only_sandbox, sandbox_context); 1 external calls (from_permissions_and_cwd).


##### `FileSystemSandboxContext::from_permission_profile_with_cwd`  (lines 98–103)

```
fn from_permission_profile_with_cwd(
        permissions: PermissionProfile<AbsolutePathBuf>,
        cwd: PathUri,
    ) -> Self
```

**Purpose**: Constructs a sandbox context from a permission profile while preserving an explicit cwd URI.

**Data flow**: Consumes `PermissionProfile<AbsolutePathBuf>` and a `PathUri`, wraps the cwd in `Some`, and delegates to `from_permissions_and_cwd`.

**Call relations**: Used when cwd-relative permission entries or remote serialization require the cwd to travel with the context.

*Call graph*: called by 5 (sandbox_context_with_cwd, filesystem_protocol_accepts_legacy_absolute_paths_and_serializes_path_uris, remote_sandbox_context_drops_unused_cwd, remote_sandbox_context_preserves_required_cwd, remote_file_system_sends_path_and_sandbox_cwd_uris_without_native_conversion); 1 external calls (from_permissions_and_cwd).


##### `FileSystemSandboxContext::from_permissions_and_cwd`  (lines 105–116)

```
fn from_permissions_and_cwd(
        permissions: PermissionProfile<AbsolutePathBuf>,
        cwd: Option<PathUri>,
    ) -> Self
```

**Purpose**: Internal constructor that converts native-path permissions into URI form and fills default sandbox flags.

**Data flow**: Consumes `PermissionProfile<AbsolutePathBuf>` and optional `PathUri`, converts the permission profile with `into()`, stores the cwd, and initializes `windows_sandbox_level` to `Disabled`, `windows_sandbox_private_desktop` to `false`, and `use_legacy_landlock` to `false`.

**Call relations**: Shared implementation behind the public permission-profile constructors and the legacy-policy projection path.

*Call graph*: 1 external calls (into).


##### `FileSystemSandboxContext::should_run_in_sandbox`  (lines 118–128)

```
fn should_run_in_sandbox(&self) -> bool
```

**Purpose**: Determines whether this context requires a sandboxed filesystem implementation.

**Data flow**: Clones `self.permissions` and attempts `PermissionProfile::<AbsolutePathBuf>::try_from(...)`. If conversion fails, it returns `true` to avoid selecting an unsandboxed filesystem for a foreign-host context. If conversion succeeds, it reads the derived filesystem sandbox policy and returns true only when the kind is `Restricted` and it does not grant full-disk write access.

**Call relations**: Used by filesystem-selection logic to choose between sandboxed and unsandboxed backends safely.

*Call graph*: 3 external calls (try_from, matches!, clone).


##### `FileSystemSandboxContext::has_cwd_dependent_permissions`  (lines 130–149)

```
fn has_cwd_dependent_permissions(&self) -> bool
```

**Purpose**: Checks whether any permission entries depend on interpreting paths relative to a cwd.

**Data flow**: Matches on `self.permissions`. For managed restricted filesystem permissions, it scans entries and returns true if any path is a non-absolute `GlobPattern` or a `Special::ProjectRoots` entry; absolute paths and other special paths return false. Managed unrestricted, disabled, and external profiles all return false.

**Call relations**: Used by `drop_cwd_if_unused` and by callers validating whether a cwd must be preserved with the sandbox context.

*Call graph*: called by 2 (sandbox_cwd, drop_cwd_if_unused).


##### `FileSystemSandboxContext::drop_cwd_if_unused`  (lines 151–156)

```
fn drop_cwd_if_unused(mut self) -> Self
```

**Purpose**: Removes the stored cwd when the permission profile does not actually depend on it.

**Data flow**: Consumes `self` mutably, calls `has_cwd_dependent_permissions()`, sets `self.cwd = None` if that returns false, and returns the possibly modified context.

**Call relations**: Used before serialization or transport to avoid carrying unnecessary cwd state.

*Call graph*: calls 1 internal fn (has_cwd_dependent_permissions).


##### `FileSystemReadStream::new`  (lines 172–176)

```
fn new(stream: impl Stream<Item = FileSystemResult<Bytes>> + Send + 'static) -> Self
```

**Purpose**: Wraps any compatible byte stream into the concrete `FileSystemReadStream` type.

**Data flow**: Takes an arbitrary `Stream<Item = FileSystemResult<Bytes>> + Send + 'static`, boxes and pins it, stores it in `inner`, and returns `FileSystemReadStream`.

**Call relations**: Used by concrete filesystem implementations to return a uniform stream type from `read_file_stream`.

*Call graph*: called by 2 (read_file_stream, open); 1 external calls (pin).


##### `FileSystemReadStream::poll_next`  (lines 182–184)

```
fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>>
```

**Purpose**: Delegates stream polling to the boxed inner stream.

**Data flow**: Mutably pins `self`, calls `self.inner.as_mut().poll_next(cx)`, and returns the resulting `Poll<Option<FileSystemResult<Bytes>>>`.

**Call relations**: Implements `Stream` for the wrapper so callers can consume filesystem read streams transparently.

*Call graph*: 1 external calls (as_mut).


##### `ExecutorFileSystem::read_file_text`  (lines 211–220)

```
fn read_file_text(
        &'a self,
        path: &'a PathUri,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, String>
```

**Purpose**: Provides a default async helper that reads a file’s bytes and decodes them as UTF-8 text.

**Data flow**: Returns a boxed async future that awaits `self.read_file(path, sandbox)`, then attempts `String::from_utf8(bytes)`. On success it yields the string; on decoding failure it maps the error into `io::ErrorKind::InvalidData`.

**Call relations**: This is the only trait method with built-in behavior; concrete filesystem implementations inherit it automatically once they implement `read_file`.

*Call graph*: called by 18 (apply_hunks_to_files, derive_new_contents_from_chunks, verify_apply_patch_args, read_optional_file_text_for_delta, remove_failure_was_side_effect_free, read_config_from_path, load_config_toml_for_required_layer, load_project_layers, load_requirements_toml, merge_root_checkout_project_hooks (+8 more)); 2 external calls (pin, from_utf8).


### Executable and resource resolution
This group covers utilities that locate runnable programs and build/test resources across Unix, Windows, Cargo, Bazel, and WSL environments.

### `cli/src/wsl_paths.rs`

`util` · `cross-cutting helper used during update command execution under WSL`

This file is a narrowly scoped utility used by the update flow on non-Windows platforms. Its core helper, `win_path_to_wsl`, performs a syntactic conversion from Windows absolute drive paths like `C:\foo\bar` or `D:/Work/file` into WSL mount paths like `/mnt/c/foo/bar`. The function is intentionally conservative: it requires at least three bytes, a drive-letter prefix, a colon, and either `\` or `/` as the separator after the colon. Inputs that do not match that shape return `None` rather than attempting any broader path translation. It also handles the drive-root case by returning `/mnt/<drive>` when the tail is empty.

`normalize_for_wsl` is the public convenience wrapper. It accepts any `AsRef<OsStr>`, converts it lossily to a `String`, and then checks `is_wsl()` from `codex_utils_path`. Outside WSL it returns the original string unchanged. Inside WSL it tries `win_path_to_wsl`; if conversion succeeds, it returns the mapped path, otherwise it leaves the original value untouched. This design means Unix paths and non-drive Windows-like strings pass through safely, while update commands launched from a WSL-hosted Codex process can still invoke Windows-originated installer paths correctly. The tests cover both basic drive-path conversion and the no-op behavior for ordinary Unix paths.

#### Function details

##### `win_path_to_wsl`  (lines 8–23)

```
fn win_path_to_wsl(path: &str) -> Option<String>
```

**Purpose**: Converts a Windows absolute drive path into the equivalent WSL `/mnt/<drive>/...` path when the input matches a drive-letter pattern.

**Data flow**: Consumes a `&str`, inspects its bytes for `<letter> : <slash-or-backslash>` at the start, lowercases the drive letter, replaces backslashes in the remainder with `/`, and returns either `/mnt/<drive>` for a bare drive root or `/mnt/<drive>/<tail>` for longer paths. Returns `None` when the input does not look like a Windows drive path.

**Call relations**: Used by `normalize_for_wsl` as the actual conversion routine.

*Call graph*: called by 1 (normalize_for_wsl); 1 external calls (format!).


##### `normalize_for_wsl`  (lines 27–36)

```
fn normalize_for_wsl(path: P) -> String
```

**Purpose**: Returns a WSL-normalized path string only when running under WSL and the input looks like a Windows drive path.

**Data flow**: Accepts any `AsRef<OsStr>`, converts it to a lossy `String`, checks `is_wsl()`, and if not under WSL returns the original string. Under WSL it calls `win_path_to_wsl`; on `Some(mapped)` it returns the mapped path, otherwise it returns the original string unchanged.

**Call relations**: Called by `run_update_action` in `main.rs` to normalize updater command paths and arguments before spawning them on non-Windows systems.

*Call graph*: calls 1 internal fn (win_path_to_wsl); called by 1 (run_update_action); 2 external calls (as_ref, is_wsl).


##### `tests::win_to_wsl_basic`  (lines 43–53)

```
fn win_to_wsl_basic()
```

**Purpose**: Verifies basic Windows-drive to WSL-path conversion and rejection of ordinary Unix paths.

**Data flow**: Calls `win_path_to_wsl` with backslash and slash Windows paths and asserts the expected `/mnt/...` outputs, then asserts a Unix path returns `None`.

**Call relations**: Direct unit test for `win_path_to_wsl`.

*Call graph*: 2 external calls (assert!, assert_eq!).


##### `tests::normalize_is_noop_on_unix_paths`  (lines 56–58)

```
fn normalize_is_noop_on_unix_paths()
```

**Purpose**: Verifies that Unix-style paths are returned unchanged by the normalization wrapper.

**Data flow**: Calls `normalize_for_wsl` with a Unix path and asserts the returned string is identical.

**Call relations**: Tests the pass-through behavior of `normalize_for_wsl`.

*Call graph*: 1 external calls (assert_eq!).


### `linux-sandbox/src/bazel_bwrap.rs`

`util` · `debug/test-time sandbox launcher discovery`

This file is a narrow development/test helper for locating `bwrap` when the Linux sandbox is running under Bazel. In debug builds, `candidate()` first checks that the code appears to be built in a Bazel package (`option_env!("BAZEL_PACKAGE")`) and that some runfiles environment is present. If either condition fails, it returns `None` immediately so normal bundled/legacy lookup continues. Otherwise it reads `CARGO_BIN_EXE_bwrap`, which Bazel/cargo test setups can populate with either an absolute path or a logical runfile path.

If the value is already absolute, it is returned directly. If not, `resolve_runfile` tries to map the logical path into a real filesystem path. It searches both `RUNFILES_DIR` and `TEST_SRCDIR`, trying the raw logical path and, when `TEST_WORKSPACE` is set, a workspace-prefixed variant. If directory-based runfiles lookup fails, it falls back to parsing `RUNFILES_MANIFEST_FILE`, scanning each `key value` line until it finds a matching logical path. In non-debug builds the public `candidate()` is compiled as a stub that always returns `None`, ensuring Bazel-specific test behavior does not affect release binaries.

#### Function details

##### `candidate`  (lines 24–26)

```
fn candidate() -> Option<PathBuf>
```

**Purpose**: Returns a Bazel-resolved `bwrap` path in debug builds, or `None` when Bazel/runfiles context is absent.

**Data flow**: Checks compile-time `BAZEL_PACKAGE` and runtime runfiles env presence → reads `CARGO_BIN_EXE_bwrap` from the environment → if absolute, returns it as `PathBuf`; otherwise converts to `&str` and delegates to `resolve_runfile` → returns `Option<PathBuf>`.

**Call relations**: Called by legacy bundled-bwrap candidate discovery so Bazel test binaries can be considered alongside adjacent resource paths.

*Call graph*: calls 2 internal fn (resolve_runfile, runfiles_env_present); called by 1 (legacy_candidates_for_exe); 3 external calls (from, option_env!, var_os).


##### `runfiles_env_present`  (lines 29–33)

```
fn runfiles_env_present() -> bool
```

**Purpose**: Detects whether any Bazel runfiles mechanism is available in the current environment.

**Data flow**: Reads `RUNFILES_DIR`, `TEST_SRCDIR`, and `RUNFILES_MANIFEST_FILE` from the environment → returns `true` if any are set, else `false`.

**Call relations**: Used as an early gate by `candidate` to avoid unnecessary Bazel-specific resolution work.

*Call graph*: called by 1 (candidate); 1 external calls (var_os).


##### `resolve_runfile`  (lines 36–68)

```
fn resolve_runfile(logical_path: &str) -> Option<PathBuf>
```

**Purpose**: Resolves a logical Bazel runfile path to a concrete filesystem path using runfiles directories or a manifest file.

**Data flow**: Takes a logical path string → builds a list containing the raw path and optionally `TEST_WORKSPACE/logical_path` → searches `RUNFILES_DIR` and `TEST_SRCDIR` roots for existing joined paths; if none exist, opens `RUNFILES_MANIFEST_FILE`, scans lines, splits each on the first space, and returns the mapped value for any matching logical key → returns `Option<PathBuf>`.

**Call relations**: Called only from `candidate` when `CARGO_BIN_EXE_bwrap` is not already absolute.

*Call graph*: called by 1 (candidate); 7 external calls (open, from, format!, var, var_os, new, vec!).


### `utils/cargo-bin/src/lib.rs`

`io_transport` · `test setup and resource lookup`

This file is environment-plumbing for tests and tooling that need to find binaries or packaged resources regardless of whether they are running under `cargo test` or `bazel test`. `cargo_bin` is the main entry point: it derives candidate `CARGO_BIN_EXE_*` environment variable names, checks them in order, and resolves each value either as a Bazel runfile path or as an absolute filesystem path. If no env var works, it falls back to `assert_cmd::Command::cargo_bin`, making relative fallback paths absolute via `current_dir()` and verifying existence before returning them. Errors are reported through a dedicated `CargoBinError` enum that distinguishes current-exe/current-dir failures, nonexistent resolved paths, and total lookup failure. `runfiles_available` keys off Bazel's `RUNFILES_MANIFEST_ONLY` environment variable, which this crate treats as the signal that runfiles resolution should be used. The exported `find_resource!` macro chooses between Bazel runfile lookup and Cargo-manifest-relative lookup at the call site, using compile-time environment variables like `BAZEL_PACKAGE` and `CARGO_MANIFEST_DIR`. `resolve_bazel_runfile` normalizes `.` and `..` segments before calling `rlocation!`, while `repo_root` finds a packaged `repo_root.marker` and walks four parent directories upward to reconstruct the repository root. The implementation is careful to validate existence after resolution and to produce explicit `NotFound` errors when compile-time Bazel metadata is missing.

#### Function details

##### `cargo_bin`  (lines 39–69)

```
fn cargo_bin(name: &str) -> Result<PathBuf, CargoBinError>
```

**Purpose**: Finds the absolute path to a named binary built for the current test run, supporting both Cargo and Bazel conventions. It tries environment variables first and falls back to `assert_cmd` discovery.

**Data flow**: Reads `name: &str`, derives candidate env var keys with `cargo_bin_env_keys`, then iterates through them calling `std::env::var_os`. For the first present value it delegates to `resolve_bin_from_env`. If none are set, it calls `assert_cmd::Command::cargo_bin(name)`, converts the program path into a `PathBuf`, makes it absolute with `current_dir()` if needed, checks `exists()`, and returns either `Ok(path)` or a `CargoBinError` describing the failure.

**Call relations**: Test code calls this as the main binary locator. It orchestrates the full lookup flow by delegating to `cargo_bin_env_keys` and `resolve_bin_from_env`, then using `assert_cmd` only as a fallback path.

*Call graph*: calls 2 internal fn (cargo_bin_env_keys, resolve_bin_from_env); 5 external calls (from, cargo_bin, format!, current_dir, var_os).


##### `cargo_bin_env_keys`  (lines 71–82)

```
fn cargo_bin_env_keys(name: &str) -> Vec<String>
```

**Purpose**: Builds the list of environment variable names Cargo or Bazel may use for a binary target. It accounts for Cargo's dash-to-underscore rewriting.

**Data flow**: Reads `name: &str`, allocates a `Vec<String>` with capacity 2, pushes `CARGO_BIN_EXE_{name}`, computes `underscore_name = name.replace('-', '_')`, and if that differs pushes `CARGO_BIN_EXE_{underscore_name}`. It returns the vector of candidate keys.

**Call relations**: Only `cargo_bin` calls this helper. Its role is to centralize the env-var naming policy before actual resolution is attempted.

*Call graph*: called by 1 (cargo_bin); 2 external calls (with_capacity, format!).


##### `runfiles_available`  (lines 84–86)

```
fn runfiles_available() -> bool
```

**Purpose**: Detects whether the current process should resolve paths through Bazel runfiles. It uses the presence of Bazel's manifest-only environment variable as the signal.

**Data flow**: Reads `std::env::var_os(RUNFILES_MANIFEST_ONLY_ENV)` and returns `true` if it is `Some`, otherwise `false`. It does not mutate state.

**Call relations**: Both `resolve_bin_from_env` and `repo_root` call this to choose between Bazel runfiles logic and direct filesystem/Cargo-relative logic.

*Call graph*: called by 2 (repo_root, resolve_bin_from_env); 1 external calls (var_os).


##### `resolve_bin_from_env`  (lines 88–112)

```
fn resolve_bin_from_env(key: &str, value: OsString) -> Result<PathBuf, CargoBinError>
```

**Purpose**: Resolves a binary path taken from a `CARGO_BIN_EXE_*` environment variable, interpreting it either as a Bazel rlocation path or as a direct absolute path. It validates that the resolved file actually exists.

**Data flow**: Takes `key: &str` and `value: OsString`, converts the raw value into `PathBuf`, then branches on `runfiles_available()`. In runfiles mode it creates `runfiles::Runfiles`, resolves the raw path with `rlocation!`, makes the result absolute with `current_dir()` if necessary, and returns it if `exists()`. Outside runfiles mode it accepts the raw path only if it is already absolute and exists. Otherwise it returns `CargoBinError::ResolvedPathDoesNotExist { key, path: raw }`.

**Call relations**: This helper is called by `cargo_bin` for env-var-based resolution. It encapsulates the environment-specific interpretation of env var values and delegates to `runfiles_available`, `Runfiles::create`, and `rlocation!` as needed.

*Call graph*: calls 1 internal fn (runfiles_available); called by 1 (cargo_bin); 4 external calls (from, create, rlocation!, current_dir).


##### `resolve_bazel_runfile`  (lines 140–166)

```
fn resolve_bazel_runfile(
    bazel_package: Option<&str>,
    resource: &Path,
) -> std::io::Result<PathBuf>
```

**Purpose**: Resolves a resource path inside Bazel runfiles using the compile-time Bazel package name. It normalizes the runfile path before lookup and errors clearly when metadata or files are missing.

**Data flow**: Reads `bazel_package: Option<&str>` and `resource: &Path`, creates a `Runfiles` handle, constructs `_main/<bazel_package>/<resource>` when the package is present or returns `NotFound` if absent, normalizes that path with `normalize_runfile_path`, then calls `rlocation!`. If the resolved path exists it returns it; otherwise it returns an `io::ErrorKind::NotFound` containing the normalized runfile path in the message.

**Call relations**: The exported `find_resource!` macro uses this function in Bazel mode. It delegates path cleanup to `normalize_runfile_path` and actual runfiles lookup to the `runfiles` crate.

*Call graph*: calls 1 internal fn (normalize_runfile_path); 5 external calls (from, new, format!, create, rlocation!).


##### `resolve_cargo_runfile`  (lines 168–171)

```
fn resolve_cargo_runfile(resource: &Path) -> std::io::Result<PathBuf>
```

**Purpose**: Resolves a resource path relative to the crate's manifest directory in Cargo builds. It is the non-Bazel counterpart to runfiles lookup.

**Data flow**: Reads `resource: &Path`, constructs a `PathBuf` from compile-time `env!("CARGO_MANIFEST_DIR")`, joins the resource onto it, and returns the resulting path in `Ok`. It performs no existence check.

**Call relations**: This helper is called by `repo_root` and conceptually mirrors the Cargo branch of the `find_resource!` macro.

*Call graph*: called by 1 (repo_root); 2 external calls (env!, from).


##### `repo_root`  (lines 173–207)

```
fn repo_root() -> io::Result<PathBuf>
```

**Purpose**: Finds the repository root by locating a packaged `repo_root.marker` file and walking up a fixed number of parent directories. It supports both Bazel runfiles and Cargo layouts.

**Data flow**: Checks `runfiles_available()`. In Bazel mode it creates `Runfiles`, reads compile-time `CODEX_REPO_ROOT_MARKER`, resolves it with `rlocation!`, and errors if any step fails. In Cargo mode it calls `resolve_cargo_runfile(Path::new("repo_root.marker"))`. Starting from the marker path, it repeatedly calls `.parent()` four times, converting each parent to `PathBuf`, and returns the final root or a `NotFound` error if the expected depth is missing.

**Call relations**: Callers use this when tests need a stable repository root independent of build system. It orchestrates environment detection, marker lookup, and parent traversal by delegating to `runfiles_available`, `resolve_cargo_runfile`, and runfiles APIs.

*Call graph*: calls 2 internal fn (resolve_cargo_runfile, runfiles_available); 4 external calls (new, option_env!, create, rlocation!).


##### `normalize_runfile_path`  (lines 209–231)

```
fn normalize_runfile_path(path: &Path) -> PathBuf
```

**Purpose**: Lexically normalizes a runfile path by removing `.` components and collapsing `..` only when it can cancel a normal segment. It preserves leading parent traversals and other non-normal components.

**Data flow**: Iterates over `path.components()` into a `Vec<Component>`. `CurDir` is skipped; `ParentDir` pops the last component only if that last component is `Normal(_)`, otherwise it is retained; all other components are pushed unchanged. It then folds the component list into a new `PathBuf` by pushing each component's `as_os_str()`.

**Call relations**: Only `resolve_bazel_runfile` calls this helper before invoking `rlocation!`. Its role is to sanitize resource paths without over-normalizing away meaningful leading `..` segments.

*Call graph*: called by 1 (resolve_bazel_runfile); 4 external calls (components, new, new, matches!).


### `rmcp-client/src/program_resolver.rs`

`util` · `process launch setup`

This module exists because `tokio::process::Command::new()` behaves differently across platforms when given a bare program name. On Unix, the kernel and shell conventions already support PATH lookup and shebang-based script execution, so the Unix implementation of `resolve` simply returns the original `OsString` unchanged. On Windows, script launch requires an explicit executable path including an extension such as `.cmd` or `.bat`; the Windows implementation therefore consults the provided environment's `PATH` using `which::which_in`, logs either the resolved path or the failure, and falls back to the original program name if lookup fails so the eventual process spawn can report the real OS error.

The tests build a temporary executable fixture through `TestExecutableEnv`. That fixture creates a temp directory, writes either a Unix shell script or a Windows `.cmd` file, prepends the directory to `PATH`, and on Windows ensures `.CMD` is present in `PATHEXT`. The tests then demonstrate the platform assumptions directly: Unix can execute the bare script name, Windows cannot execute the bare name without an extension, Windows can execute the explicit `.cmd` name, and `resolve` makes the bare program executable on all platforms. The Unix direct-execution test includes a small retry loop for transient `ExecutableFileBusy` (`ETXTBSY`) errors immediately after writing the script.

#### Function details

##### `resolve`  (lines 41–61)

```
fn resolve(
    program: OsString,
    env: &HashMap<OsString, OsString>,
    cwd: &Path,
) -> std::io::Result<OsString>
```

**Purpose**: Resolves a configured program name into the executable path that should be passed to `Command::new()`, with platform-specific behavior. On Unix it is a no-op; on Windows it performs PATH/PATHEXT lookup and logs the outcome.

**Data flow**: Takes `program: OsString`, an environment map, and a working directory → on Unix returns `Ok(program)` unchanged; on Windows reads `PATH` from `env`, calls `which::which_in(&program, search_path, cwd)`, logs success or failure, and returns either the resolved path as `OsString` or the original `program`.

**Call relations**: Used by `LocalStdioServerLauncher::launch_server` before spawning a local stdio MCP server, and directly by the cross-platform execution test.

*Call graph*: called by 2 (test_resolved_program_executes_successfully, launch_server); 3 external calls (new, debug!, which_in).


##### `tests::test_unix_executes_script_without_extension`  (lines 76–102)

```
async fn test_unix_executes_script_without_extension() -> Result<()>
```

**Purpose**: Demonstrates the Unix assumption behind `resolve`: a PATH-resolved script without an extension can be executed directly. It also tolerates transient ETXTBSY after creating the script.

**Data flow**: Creates `TestExecutableEnv`, repeatedly tries `Command::new(&env.program_name).envs(&env.mcp_env).output().await`, sleeping briefly and retrying up to two times if the error kind is `ExecutableFileBusy`, then asserts the final output is `Ok`.

**Call relations**: Unix-only test validating the platform behavior that allows the Unix `resolve` implementation to be a no-op.

*Call graph*: 5 external calls (assert!, new, new, from_millis, sleep).


##### `tests::test_windows_fails_without_extension`  (lines 107–118)

```
async fn test_windows_fails_without_extension() -> Result<()>
```

**Purpose**: Shows the Windows failure mode that motivates explicit resolution: a bare script name without `.cmd` or `.bat` does not execute directly.

**Data flow**: Creates `TestExecutableEnv`, runs `Command::new(&env.program_name)` with the prepared environment, awaits output, and asserts the result is an error.

**Call relations**: Windows-only test documenting the problem that the Windows `resolve` implementation fixes.

*Call graph*: 3 external calls (assert!, new, new).


##### `tests::test_windows_succeeds_with_extension`  (lines 123–136)

```
async fn test_windows_succeeds_with_extension() -> Result<()>
```

**Purpose**: Verifies that Windows can execute the same script once the `.cmd` extension is supplied explicitly. This confirms the fixture itself is valid.

**Data flow**: Creates `TestExecutableEnv`, formats `program_with_ext = format!("{}.cmd", env.program_name)`, runs it with the prepared environment, awaits output, and asserts success.

**Call relations**: Windows-only companion test to the previous failure case.

*Call graph*: 4 external calls (assert!, new, format!, new).


##### `tests::test_resolved_program_executes_successfully`  (lines 140–157)

```
async fn test_resolved_program_executes_successfully() -> Result<()>
```

**Purpose**: Checks the end-to-end contract of `resolve`: the returned program path should be executable on the current platform. This is the main behavioral test for the module.

**Data flow**: Creates `TestExecutableEnv`, converts the fixture program name to `OsString`, calls `resolve(program, &env.mcp_env, current_dir)`, then runs `Command::new(resolved)` with the fixture environment and asserts the output succeeds.

**Call relations**: Cross-platform test that directly exercises the public `resolve` function.

*Call graph*: calls 1 internal fn (resolve); 5 external calls (from, assert!, new, new, current_dir).


##### `tests::TestExecutableEnv::new`  (lines 170–190)

```
fn new() -> Result<Self>
```

**Purpose**: Builds the temporary executable test fixture and the environment needed to discover it through PATH. On Windows it also ensures `.CMD` is discoverable through `PATHEXT`.

**Data flow**: Creates a `TempDir`, calls `create_executable(dir_path)`, builds an `extra_env` map with `PATH` prepended via `build_path_env_var`, conditionally inserts `PATHEXT` via `ensure_cmd_extension`, passes that overlay to `create_env_for_mcp_server`, and returns `TestExecutableEnv` containing the temp dir, bare program name, and final environment map.

**Call relations**: Used by all tests in this module as the common fixture constructor.

*Call graph*: calls 1 internal fn (create_env_for_mcp_server); 6 external calls (new, from, build_path_env_var, create_executable, ensure_cmd_extension, new).


##### `tests::TestExecutableEnv::create_executable`  (lines 193–208)

```
fn create_executable(dir: &Path) -> Result<()>
```

**Purpose**: Writes the platform-specific test executable into the temporary directory. On Unix it also marks the script executable.

**Data flow**: Takes a directory path → on Windows writes `test_mcp_server.cmd` containing `@echo off\nexit 0`; on Unix writes `test_mcp_server` containing a shell script and then calls `set_executable` on it → returns `Result<()>`.

**Call relations**: Called only by `TestExecutableEnv::new` during fixture setup.

*Call graph*: 4 external calls (join, set_executable, format!, write).


##### `tests::TestExecutableEnv::set_executable`  (lines 211–217)

```
fn set_executable(path: &Path) -> Result<()>
```

**Purpose**: Applies executable permissions to the Unix test script. This makes the bare script runnable through PATH lookup.

**Data flow**: Reads file metadata and permissions, sets mode `0o755`, writes the updated permissions back, and returns `Result<()>`.

**Call relations**: Unix-only helper called by `create_executable`.

*Call graph*: 2 external calls (metadata, set_permissions).


##### `tests::TestExecutableEnv::build_path_env_var`  (lines 220–228)

```
fn build_path_env_var(dir: &Path) -> OsString
```

**Purpose**: Constructs a PATH value that prepends the temporary executable directory ahead of the existing PATH. This ensures the fixture program is found first.

**Data flow**: Starts with the directory as `OsString`, reads the current process `PATH` if present, appends the platform-specific separator (`;` on Windows, `:` otherwise), then appends the existing PATH → returns the combined `OsString`.

**Call relations**: Called by `TestExecutableEnv::new` when preparing the environment overlay.

*Call graph*: 4 external calls (from, as_os_str, cfg!, var_os).


##### `tests::TestExecutableEnv::ensure_cmd_extension`  (lines 232–245)

```
fn ensure_cmd_extension() -> OsString
```

**Purpose**: Ensures `.CMD` appears in `PATHEXT` for Windows tests so command discovery can find the generated `.cmd` script. It preserves the existing variable when already sufficient.

**Data flow**: Reads current `PATHEXT`, uppercases it for inspection, and if `.CMD` is absent prefixes `.CMD;` to the existing value; otherwise returns the original value.

**Call relations**: Windows-only helper used by `TestExecutableEnv::new`.

*Call graph*: 2 external calls (from, var_os).


### Environment and terminal shaping
These files detect runtime terminal context and construct adjusted process environments or UI behavior based on that context.

### `core/src/exec_env.rs`

`util` · `process spawn setup`

This file is a thin adapter around `codex_protocol::shell_environment`, keeping environment derivation logic in the protocol crate while presenting a simpler API to the core runtime. Its main exported item is `create_env`, which accepts a `ShellEnvironmentPolicy` plus an optional `ThreadId`, converts the thread id to a string, and forwards to the protocol implementation. The resulting `HashMap<String, String>` is intended to be used after `Command::env_clear()` so spawned commands receive only explicitly approved variables.

A notable invariant is that the thread identifier is passed separately from the inherited environment and is documented to be injected even when `include_only` filtering is active; this preserves Codex’s per-thread context in subprocesses. The file also re-exports `CODEX_THREAD_ID_ENV_VAR` so callers and tests can refer to the exact environment variable name without depending directly on the protocol module.

Two helper functions exist only for tests: one Windows-only helper that builds an environment from an explicit iterator of variables, and one cross-platform helper that populates from supplied variables. These let tests verify filtering, inheritance, overrides, and Windows-specific `PATHEXT` behavior deterministically without mutating the host process environment.

#### Function details

##### `create_env`  (lines 20–26)

```
fn create_env(
    policy: &ShellEnvironmentPolicy,
    thread_id: Option<ThreadId>,
) -> HashMap<String, String>
```

**Purpose**: Builds the environment map for a spawned command using the configured shell-environment policy and an optional Codex thread id. It is the production entry point used by command execution paths.

**Data flow**: Reads `policy` and `thread_id`; converts `Option<ThreadId>` into `Option<String>` via `to_string`, then passes `policy` and `thread_id.as_deref()` into the protocol-layer environment builder. Returns the resulting `HashMap<String, String>` without mutating local state.

**Call relations**: This wrapper is invoked from multiple execution-preparation paths when core needs a clean environment for subprocesses, including sandboxed command execution and shell-command parameter construction. It delegates all filtering, inheritance, and variable injection rules to `codex_protocol::shell_environment::create_env` so core and protocol stay consistent.

*Call graph*: calls 1 internal fn (create_env); called by 7 (run_command_under_sandbox, execute_user_shell_command, to_exec_params, shell_command_handler_to_exec_params_uses_session_shell_and_turn_context, open_session_with_sandbox, create_env_from_core_vars, create_env_from_core_vars).


##### `create_env_from_vars`  (lines 29–39)

```
fn create_env_from_vars(
    vars: I,
    policy: &ShellEnvironmentPolicy,
    thread_id: Option<ThreadId>,
) -> HashMap<String, String>
```

**Purpose**: Constructs an environment map from an explicit iterator of `(String, String)` pairs under a policy, for Windows-only tests. It lets tests bypass the real OS environment and exercise case-insensitive handling and default `PATHEXT` insertion.

**Data flow**: Consumes `vars`, reads `policy` and optional `thread_id`, stringifies the thread id if present, and forwards the iterator plus `policy` and `thread_id.as_deref()` to the protocol helper. Returns a new `HashMap<String, String>`.

**Call relations**: This function is only compiled for `#[cfg(all(test, target_os = "windows"))]` and is used by Windows-specific tests to validate behavior that depends on supplied variables rather than ambient process state. It delegates directly to `codex_protocol::shell_environment::create_env_from_vars`.

*Call graph*: calls 1 internal fn (create_env_from_vars).


##### `populate_env`  (lines 42–52)

```
fn populate_env(
    vars: I,
    policy: &ShellEnvironmentPolicy,
    thread_id: Option<ThreadId>,
) -> HashMap<String, String>
```

**Purpose**: Populates an environment map from a supplied variable iterator according to the shell-environment policy, for tests. It is the general deterministic test hook for inheritance, filtering, and explicit overrides.

**Data flow**: Consumes `vars`, reads `policy` and optional `thread_id`, converts the thread id to `Option<String>`, and forwards all inputs to `codex_protocol::shell_environment::populate_env`. Returns the populated `HashMap<String, String>`.

**Call relations**: This helper is compiled only in tests and underpins the unit tests in `exec_env_tests.rs`. It exists so tests can drive the same policy algorithm as production code while controlling the exact input variable set.

*Call graph*: calls 1 internal fn (populate_env).


### `terminal-detection/src/lib.rs`

`domain_logic` · `startup and cross-cutting telemetry/config decisions`

This library centers on `TerminalInfo`, a structured snapshot of terminal identity with five fields: a normalized `TerminalName`, optional raw `TERM_PROGRAM`, optional version, optional `TERM` capability string, and optional `Multiplexer` metadata for tmux or Zellij. Detection is cached process-wide in the `TERMINAL_INFO: OnceLock<TerminalInfo>`, so callers get a stable answer after the first probe. The main detection routine, `detect_terminal_info_from_env`, works against an injectable `Environment` trait so tests can supply fake variables while production uses `ProcessEnvironment` backed by `std::env` and best-effort subprocess probes.

The detection order is deliberate and affects outcomes: it first identifies a multiplexer, then prefers `TERM_PROGRAM`; if `TERM_PROGRAM=tmux` and tmux is actually active, it replaces tmux with underlying client terminal data from `tmux display-message`. Otherwise it checks terminal-specific variables in a fixed sequence (`WEZTERM_VERSION`, iTerm markers, Apple Terminal session ID, kitty, Alacritty, Konsole, GNOME Terminal, VTE, Windows Terminal), then falls back to `TERM`, and finally to `Unknown`. Empty or whitespace-only values are consistently discarded via `none_if_whitespace`. User-Agent formatting prefers raw `TERM_PROGRAM` plus version when present, otherwise `TERM`, otherwise a canonical token derived from `TerminalName`; the result is sanitized so only header-safe ASCII characters remain. Notably, tmux and Zellij version lookup is best-effort and failure never aborts detection.

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

**Purpose**: Builds a `TerminalInfo` from already-decided component fields without applying any detection logic. It is the common constructor used by all specialized factory helpers.

**Data flow**: Consumes a `TerminalName` plus optional `term_program`, `version`, `term`, and `multiplexer` values, packages them directly into a `TerminalInfo`, and returns that struct without mutating external state.

**Call relations**: This is the leaf constructor underneath the file’s higher-level `TerminalInfo` factory methods, which call it after choosing which fields should be populated for a particular detection path.


##### `TerminalInfo::from_term_program`  (lines 108–121)

```
fn from_term_program(
        name: TerminalName,
        term_program: String,
        version: Option<String>,
        multiplexer: Option<Multiplexer>,
    ) -> Self
```

**Purpose**: Creates terminal metadata for cases where detection came from `TERM_PROGRAM`, optionally preserving a version and multiplexer. It intentionally leaves the `term` capability field unset.

**Data flow**: Takes a normalized `TerminalName`, the raw `TERM_PROGRAM` string, optional version, and optional multiplexer; forwards those into `TerminalInfo::new` with `term` fixed to `None`; returns the resulting `TerminalInfo`.

**Call relations**: It is used by `detect_terminal_info_from_env` on the primary `TERM_PROGRAM` branch after terminal-name normalization, including the non-tmux path where explicit program identity should override later probes.

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

**Purpose**: Creates terminal metadata when both a program identifier and a `TERM` capability string should be preserved, primarily for tmux client-terminal attribution.

**Data flow**: Accepts a `TerminalName`, raw program string, optional version, optional `TERM`-style capability string, and optional multiplexer; passes all five through to `TerminalInfo::new`; returns the assembled struct.

**Call relations**: This is called by `terminal_from_tmux_client_info` when tmux exposes both `client_termtype` and `client_termname`, allowing the library to report the underlying terminal program while still retaining the client capability string.

*Call graph*: called by 1 (terminal_from_tmux_client_info); 1 external calls (new).


##### `TerminalInfo::from_name`  (lines 135–147)

```
fn from_name(
        name: TerminalName,
        version: Option<String>,
        multiplexer: Option<Multiplexer>,
    ) -> Self
```

**Purpose**: Creates terminal metadata from a known terminal category when no raw `TERM_PROGRAM` string should be recorded. It is used for terminal-specific environment markers such as `WEZTERM_VERSION` or `WT_SESSION`.

**Data flow**: Receives a `TerminalName`, optional version, and optional multiplexer; calls `TerminalInfo::new` with `term_program` and `term` both set to `None`; returns the resulting struct.

**Call relations**: It is the constructor used by `detect_terminal_info_from_env` for all non-`TERM_PROGRAM` positive detections based on dedicated environment variables.

*Call graph*: called by 1 (detect_terminal_info_from_env); 1 external calls (new).


##### `TerminalInfo::from_term`  (lines 150–163)

```
fn from_term(term: String, multiplexer: Option<Multiplexer>) -> Self
```

**Purpose**: Builds terminal metadata from a `TERM` capability string and derives only the small subset of names that can be recognized from that field alone. Everything else remains `Unknown` while preserving the raw `TERM` value.

**Data flow**: Consumes a `TERM` string and optional multiplexer, maps specific values like `dumb`, `wezterm`, and `wezterm-mux` to concrete `TerminalName` variants, then calls `TerminalInfo::new` with `term_program` and `version` unset and `term` populated.

**Call relations**: This is the fallback constructor used by `detect_terminal_info_from_env` and also by `terminal_from_tmux_client_info` when tmux only yields a client term name but no client term type.

*Call graph*: called by 1 (detect_terminal_info_from_env); 1 external calls (new).


##### `TerminalInfo::unknown`  (lines 166–174)

```
fn unknown(multiplexer: Option<Multiplexer>) -> Self
```

**Purpose**: Constructs a terminal metadata record for cases where no identifying signal was found. It preserves only multiplexer information if one was detected.

**Data flow**: Takes an optional `Multiplexer`, passes `TerminalName::Unknown` and all other optional fields as `None` into `TerminalInfo::new`, and returns the result.

**Call relations**: This is the terminal end of `detect_terminal_info_from_env` after all explicit probes and `TERM` fallback have failed.

*Call graph*: called by 1 (detect_terminal_info_from_env); 1 external calls (new).


##### `TerminalInfo::user_agent_token`  (lines 177–209)

```
fn user_agent_token(&self) -> String
```

**Purpose**: Formats a `TerminalInfo` into the exact token string used in User-Agent-style headers. It prefers explicit raw identifiers when available and falls back to canonical names otherwise.

**Data flow**: Reads `self.term_program`, `self.version`, `self.term`, and `self.name`; chooses one of three formatting branches: raw `TERM_PROGRAM[/version]`, raw `TERM`, or a canonical token derived from `TerminalName` with `format_terminal_version` for versioned names; then passes the chosen string through `sanitize_header_value` and returns the sanitized token.

**Call relations**: This method is reached through the public `user_agent` helper and is the final formatting step after `terminal_info` has already cached or detected the structured metadata.

*Call graph*: calls 2 internal fn (format_terminal_version, sanitize_header_value); 1 external calls (format!).


##### `TerminalInfo::is_zellij`  (lines 212–214)

```
fn is_zellij(&self) -> bool
```

**Purpose**: Reports whether the detected multiplexer is specifically Zellij. It is a convenience predicate over the `multiplexer` field.

**Data flow**: Reads `self.multiplexer`, pattern-matches it against `Some(Multiplexer::Zellij { .. })`, and returns a boolean without changing state.

**Call relations**: This is a leaf helper for callers that need a simple multiplexer check without inspecting the full enum.

*Call graph*: 1 external calls (matches!).


##### `Environment::has`  (lines 227–229)

```
fn has(&self, name: &str) -> bool
```

**Purpose**: Provides a default trait helper for checking whether an environment variable exists at all. It avoids repeating `var(...).is_some()` in detection code.

**Data flow**: Reads a variable name, calls `self.var(name)`, converts the optional string into a boolean, and returns that boolean.

**Call relations**: Detection logic uses this helper for probes where empty strings still count as presence, such as some terminal-specific marker variables.


##### `Environment::var_non_empty`  (lines 232–234)

```
fn var_non_empty(&self, name: &str) -> Option<String>
```

**Purpose**: Provides a default trait helper that treats empty or whitespace-only environment values as absent. This keeps detection from accepting blank versions or identifiers.

**Data flow**: Reads a variable name, fetches `self.var(name)`, then runs the result through `none_if_whitespace`; returns `Some(String)` only for nonblank values.

**Call relations**: It underpins `has_non_empty`, the default `zellij_version`, and many branches in terminal detection where blank values should not win precedence.

*Call graph*: called by 2 (has_non_empty, zellij_version).


##### `Environment::has_non_empty`  (lines 237–239)

```
fn has_non_empty(&self, name: &str) -> bool
```

**Purpose**: Checks whether an environment variable is both present and nonblank. It is the boolean form of `var_non_empty`.

**Data flow**: Reads a variable name, calls `self.var_non_empty(name)`, and returns whether the result is `Some`.

**Call relations**: This helper is used by multiplexer detection to avoid treating empty `TMUX`, `TMUX_PANE`, or Zellij markers as active sessions.

*Call graph*: calls 1 internal fn (var_non_empty).


##### `Environment::zellij_version`  (lines 245–247)

```
fn zellij_version(&self) -> Option<String>
```

**Purpose**: Supplies the default way to read a Zellij version directly from `ZELLIJ_VERSION`. Implementations can override it to add command-based fallback behavior.

**Data flow**: Reads no external state beyond the trait object; calls `self.var_non_empty("ZELLIJ_VERSION")` and returns that optional version string.

**Call relations**: The default implementation is used by fake environments unless overridden; `detect_multiplexer` relies on this abstraction rather than hard-coding where the version comes from.

*Call graph*: calls 1 internal fn (var_non_empty).


##### `ProcessEnvironment::var`  (lines 254–263)

```
fn var(&self, name: &str) -> Option<String>
```

**Purpose**: Reads a process environment variable from `std::env` and normalizes missing or invalid-Unicode values into `None`. Invalid UTF-8 is logged as a warning instead of surfacing an error.

**Data flow**: Takes a variable name, calls `std::env::var`, returns `Some(value)` on success, `None` for `NotPresent`, and on `NotUnicode` emits a `tracing::warn!` and returns `None`.

**Call relations**: This is the production implementation behind the `Environment` trait and is exercised indirectly by `terminal_info` through `detect_terminal_info_from_env(&ProcessEnvironment)`.

*Call graph*: 2 external calls (var, warn!).


##### `ProcessEnvironment::tmux_client_info`  (lines 265–267)

```
fn tmux_client_info(&self) -> TmuxClientInfo
```

**Purpose**: Provides production tmux client metadata by delegating to the subprocess-based helper. It satisfies the `Environment` abstraction for tmux-aware detection.

**Data flow**: Reads no arguments beyond `self`, calls the free `tmux_client_info()` helper, and returns its `TmuxClientInfo` result.

**Call relations**: It is invoked only when terminal detection needs tmux client details, specifically on the `TERM_PROGRAM=tmux` path with an active tmux multiplexer.

*Call graph*: calls 1 internal fn (tmux_client_info).


##### `ProcessEnvironment::zellij_version`  (lines 269–272)

```
fn zellij_version(&self) -> Option<String>
```

**Purpose**: Extends the default Zellij version lookup with a best-effort `zellij --version` fallback. This lets detection capture a version even when the environment variable is absent.

**Data flow**: First reads `ZELLIJ_VERSION` via `var_non_empty`; if absent, calls `zellij_version_from_command`; returns the first non-`None` version found.

**Call relations**: This override is consumed by `detect_multiplexer` in production so Zellij sessions can carry version metadata without requiring the variable to be exported.


##### `user_agent`  (lines 276–278)

```
fn user_agent() -> String
```

**Purpose**: Returns the current process terminal identity as a sanitized User-Agent token. It is the simplest public API in the file.

**Data flow**: Calls `terminal_info()` to obtain the cached or newly detected `TerminalInfo`, then calls `user_agent_token()` on that struct and returns the resulting string.

**Call relations**: This is a thin public wrapper over the cached detection path and formatting logic.

*Call graph*: calls 1 internal fn (terminal_info).


##### `terminal_info`  (lines 281–285)

```
fn terminal_info() -> TerminalInfo
```

**Purpose**: Returns structured terminal metadata for the current process, computing it only once. It is the public entry point for callers that need more than the flattened token string.

**Data flow**: Reads the global `TERMINAL_INFO` `OnceLock`; if uninitialized, runs `detect_terminal_info_from_env(&ProcessEnvironment)` and stores the result; clones and returns the cached `TerminalInfo`.

**Call relations**: This function is called by `user_agent` and is the top-level production entry into the file’s detection pipeline.

*Call graph*: called by 1 (user_agent).


##### `detect_terminal_info_from_env`  (lines 301–388)

```
fn detect_terminal_info_from_env(env: &dyn Environment) -> TerminalInfo
```

**Purpose**: Implements the full terminal detection algorithm against an abstract environment source. It combines multiplexer detection, explicit terminal identifiers, tmux client introspection, and `TERM` fallback into one ordered decision tree.

**Data flow**: Reads many environment variables through the `Environment` trait, first deriving `multiplexer` via `detect_multiplexer`. It then checks `TERM_PROGRAM`; if that value is tmux and tmux is active, it asks `terminal_from_tmux_client_info` to reinterpret the session as the underlying client terminal. Otherwise it normalizes `TERM_PROGRAM` with `terminal_name_from_term_program` and constructs a `TerminalInfo`. If no `TERM_PROGRAM` exists, it probes terminal-specific variables in fixed order, optionally reading versions, then falls back to nonblank `TERM` via `TerminalInfo::from_term`, and finally returns `TerminalInfo::unknown`.

**Call relations**: This is the core domain function called by `terminal_info` in production and directly by tests through fake environments. It delegates multiplexer classification, tmux-specific parsing, and terminal-name normalization to smaller helpers.

*Call graph*: calls 8 internal fn (from_name, from_term, from_term_program, unknown, detect_multiplexer, is_tmux_term_program, terminal_from_tmux_client_info, terminal_name_from_term_program); 5 external calls (has, tmux_client_info, var, var_non_empty, matches!).


##### `detect_multiplexer`  (lines 390–407)

```
fn detect_multiplexer(env: &dyn Environment) -> Option<Multiplexer>
```

**Purpose**: Detects whether the process is running inside tmux or Zellij and captures any available version metadata. It does not identify the underlying terminal emulator.

**Data flow**: Reads `TMUX`/`TMUX_PANE` with `has_non_empty` to detect tmux and, if present, fills `Multiplexer::Tmux { version }` using `tmux_version_from_env`. Otherwise it checks `ZELLIJ`, `ZELLIJ_SESSION_NAME`, and `ZELLIJ_VERSION`; if any are nonempty, it returns `Multiplexer::Zellij { version: env.zellij_version() }`; otherwise returns `None`.

**Call relations**: This helper runs at the start of `detect_terminal_info_from_env` so later terminal detection can preserve multiplexer context and decide whether tmux client introspection is applicable.

*Call graph*: calls 1 internal fn (tmux_version_from_env); called by 1 (detect_terminal_info_from_env); 2 external calls (has_non_empty, zellij_version).


##### `is_tmux_term_program`  (lines 409–411)

```
fn is_tmux_term_program(value: &str) -> bool
```

**Purpose**: Recognizes whether a `TERM_PROGRAM` value denotes tmux, ignoring ASCII case. It isolates that special-case comparison in one place.

**Data flow**: Consumes a string slice, compares it to `"tmux"` with `eq_ignore_ascii_case`, and returns a boolean.

**Call relations**: It is used both in `detect_terminal_info_from_env` to decide whether to consult tmux client info and in `tmux_version_from_env` to ensure `TERM_PROGRAM_VERSION` is only treated as a tmux version when appropriate.

*Call graph*: called by 2 (detect_terminal_info_from_env, tmux_version_from_env).


##### `terminal_from_tmux_client_info`  (lines 413–435)

```
fn terminal_from_tmux_client_info(
    client_info: TmuxClientInfo,
    multiplexer: Option<Multiplexer>,
) -> Option<TerminalInfo>
```

**Purpose**: Transforms tmux client metadata into a `TerminalInfo` that reflects the underlying terminal instead of tmux itself. It prefers `client_termtype` and falls back to `client_termname`.

**Data flow**: Takes a `TmuxClientInfo` and optional multiplexer, strips blank `termtype` and `termname` with `none_if_whitespace`, and if `termtype` exists splits it into program and optional version via `split_term_program_and_version`. It normalizes the program with `terminal_name_from_term_program` and returns `TerminalInfo::from_term_program_and_term` including the client `termname`. If no `termtype` exists but `termname` does, it returns `TerminalInfo::from_term`; otherwise returns `None`.

**Call relations**: This helper is called only from the tmux-specific branch of `detect_terminal_info_from_env`, where `TERM_PROGRAM=tmux` should be replaced by client-terminal attribution when possible.

*Call graph*: calls 3 internal fn (from_term_program_and_term, split_term_program_and_version, terminal_name_from_term_program); called by 1 (detect_terminal_info_from_env).


##### `tmux_version_from_env`  (lines 437–444)

```
fn tmux_version_from_env(env: &dyn Environment) -> Option<String>
```

**Purpose**: Extracts a tmux version from environment variables, but only when `TERM_PROGRAM` actually identifies tmux. This prevents unrelated `TERM_PROGRAM_VERSION` values from being misinterpreted.

**Data flow**: Reads `TERM_PROGRAM` via `env.var`; if absent or not recognized by `is_tmux_term_program`, returns `None`. Otherwise reads and returns nonblank `TERM_PROGRAM_VERSION` via `env.var_non_empty`.

**Call relations**: It is used by `detect_multiplexer` to populate `Multiplexer::Tmux { version }` when tmux markers are present.

*Call graph*: calls 1 internal fn (is_tmux_term_program); called by 1 (detect_multiplexer); 2 external calls (var, var_non_empty).


##### `split_term_program_and_version`  (lines 446–451)

```
fn split_term_program_and_version(value: &str) -> (String, Option<String>)
```

**Purpose**: Parses a tmux client term type string into a program token and an optional version token separated by whitespace. It intentionally ignores any tokens after the second.

**Data flow**: Consumes a string slice, splits it on whitespace, converts the first token into the returned program string, converts the second token into an optional version string, and returns the pair `(String, Option<String>)`.

**Call relations**: This parser is used by `terminal_from_tmux_client_info` for values like `ghostty 1.2.3` emitted by tmux.

*Call graph*: called by 1 (terminal_from_tmux_client_info).


##### `tmux_client_info`  (lines 453–458)

```
fn tmux_client_info() -> TmuxClientInfo
```

**Purpose**: Collects tmux client terminal metadata by querying tmux for both client term type and client term name. It packages the two optional strings into a `TmuxClientInfo` struct.

**Data flow**: Calls `tmux_display_message("#{client_termtype}")` and `tmux_display_message("#{client_termname}")`, stores the two optional results in a `TmuxClientInfo`, and returns it.

**Call relations**: This helper is the subprocess-backed implementation used by `ProcessEnvironment::tmux_client_info` when tmux-aware detection needs underlying client details.

*Call graph*: calls 1 internal fn (tmux_display_message); called by 1 (tmux_client_info).


##### `tmux_display_message`  (lines 460–472)

```
fn tmux_display_message(format: &str) -> Option<String>
```

**Purpose**: Runs `tmux display-message -p` for a single format string and returns the trimmed output if the command succeeds and yields valid UTF-8. Failures are treated as absence rather than errors.

**Data flow**: Builds a `std::process::Command` for `tmux`, executes it, returns `None` if spawning fails or exit status is unsuccessful, decodes `stdout` as UTF-8, trims it, filters blank output through `none_if_whitespace`, and returns the optional string.

**Call relations**: It is called twice by `tmux_client_info`, once for `#{client_termtype}` and once for `#{client_termname}`.

*Call graph*: calls 1 internal fn (none_if_whitespace); called by 1 (tmux_client_info); 2 external calls (from_utf8, new).


##### `zellij_version_from_command`  (lines 474–487)

```
fn zellij_version_from_command() -> Option<String>
```

**Purpose**: Best-effort fallback for discovering the Zellij version by invoking the binary directly. It is intentionally non-fatal so missing or broken installations do not interfere with terminal detection.

**Data flow**: Runs `zellij --version`, returns `None` if the command cannot be executed or exits unsuccessfully, decodes stdout as UTF-8, trims it, parses it with `parse_zellij_version`, and returns the parsed optional version string.

**Call relations**: This helper is used only by `ProcessEnvironment::zellij_version` after the environment-variable lookup fails.

*Call graph*: calls 1 internal fn (parse_zellij_version); 2 external calls (from_utf8, new).


##### `parse_zellij_version`  (lines 489–498)

```
fn parse_zellij_version(value: &str) -> Option<String>
```

**Purpose**: Normalizes `zellij --version` output into just the version string when possible. It also accepts already-bare version strings.

**Data flow**: Takes an output string, rejects blank input via `none_if_whitespace`, splits on whitespace, and if the first token is case-insensitive `zellij` and a second token exists returns that second token; otherwise returns the original nonblank string.

**Call relations**: It is the parsing step underneath `zellij_version_from_command` and is also directly exercised by tests.

*Call graph*: calls 1 internal fn (none_if_whitespace); called by 1 (zellij_version_from_command).


##### `sanitize_header_value`  (lines 503–505)

```
fn sanitize_header_value(value: String) -> String
```

**Purpose**: Rewrites a terminal token into a header-safe form by replacing disallowed characters with underscores. This prevents malformed User-Agent values.

**Data flow**: Consumes a `String`, scans each character with `is_valid_header_value_char`, replaces invalid characters with `_`, and returns the sanitized string.

**Call relations**: It is the final step in `TerminalInfo::user_agent_token` after the raw token string has been chosen.

*Call graph*: called by 1 (user_agent_token).


##### `is_valid_header_value_char`  (lines 508–510)

```
fn is_valid_header_value_char(c: char) -> bool
```

**Purpose**: Defines the exact character whitelist allowed in emitted terminal header tokens. The accepted set is ASCII alphanumeric plus `-`, `_`, `.`, and `/`.

**Data flow**: Consumes a `char`, checks it against the whitelist predicate, and returns a boolean.

**Call relations**: This predicate is used by `sanitize_header_value` during token rewriting.


##### `terminal_name_from_term_program`  (lines 512–536)

```
fn terminal_name_from_term_program(value: &str) -> Option<TerminalName>
```

**Purpose**: Maps raw `TERM_PROGRAM`-style strings into normalized `TerminalName` variants while tolerating punctuation and case differences. It recognizes aliases like `iTerm.app`, `WarpTerminal`, and `gnome-terminal`.

**Data flow**: Consumes a string slice, trims it, removes spaces, hyphens, underscores, and dots, lowercases the remaining characters, matches the normalized string against known terminal names, and returns `Some(TerminalName)` or `None`.

**Call relations**: This normalization helper is used by both `detect_terminal_info_from_env` and `terminal_from_tmux_client_info` whenever a raw program identifier needs to be categorized.

*Call graph*: called by 2 (detect_terminal_info_from_env, terminal_from_tmux_client_info).


##### `format_terminal_version`  (lines 538–543)

```
fn format_terminal_version(name: &str, version: &Option<String>) -> String
```

**Purpose**: Formats a canonical terminal name with an optional version suffix. Empty version strings are ignored.

**Data flow**: Reads a terminal display name and an `Option<String>` reference, returns `"name/version"` when the version is present and nonempty, otherwise returns `name` unchanged.

**Call relations**: It is used by `TerminalInfo::user_agent_token` for canonical-name branches such as Apple Terminal, WezTerm, Konsole, and VTE.

*Call graph*: called by 1 (user_agent_token); 1 external calls (format!).


##### `none_if_whitespace`  (lines 545–547)

```
fn none_if_whitespace(value: String) -> Option<String>
```

**Purpose**: Converts blank or whitespace-only strings into `None` while preserving nonblank strings exactly. It is the file’s standard blank-value filter.

**Data flow**: Consumes a `String`, trims it for emptiness testing, and returns `Some(value)` if any non-whitespace remains or `None` otherwise.

**Call relations**: This helper is reused across environment-variable filtering, tmux command output parsing, and Zellij version parsing to keep blank values from affecting detection.

*Call graph*: called by 2 (parse_zellij_version, tmux_display_message).


### `tui/src/clipboard_copy.rs`

`io_transport` · `user-triggered clipboard copy and related tests`

This module implements `/copy` and `Ctrl+O` clipboard behavior with a deliberately narrow scope: copying text and returning user-facing error strings. The top-level `copy_to_clipboard` detects three environment facts—SSH, WSL, and tmux—and passes them plus concrete backend functions into `copy_to_clipboard_with`, which contains the real policy. Over SSH it never attempts native clipboard access because that would target the remote machine; instead it uses `terminal_clipboard_copy_with`, preferring tmux clipboard integration and falling back to OSC 52. In local sessions it tries `arboard` first, then on WSL falls back to `powershell.exe` writing to the Windows clipboard, and finally falls back to terminal-mediated copy.

A key platform-specific state object is `ClipboardLease`: on Linux it stores the live `arboard::Clipboard` handle so X11/Wayland clipboard ownership survives after the copy call returns. Native clipboard writes use `SuppressStderr` to silence noisy macOS `NSPasteboard` stderr output and to keep Linux clipboard ownership alive. Terminal paths include tmux readiness checks (`set-clipboard` not off and `Ms` capability present), OSC 52 sequence generation with a hard raw-byte limit, and writing either to `/dev/tty` or stdout.

The large test module validates the routing matrix and error composition, using injected closures and `Cell` counters rather than touching real clipboards or terminals. That makes the backend-selection logic deterministic and well specified.

#### Function details

##### `copy_to_clipboard`  (lines 40–53)

```
fn copy_to_clipboard(text: &str) -> Result<Option<ClipboardLease>, String>
```

**Purpose**: Entry point for copying text from the TUI into the user's clipboard using the best backend for the current environment. It gathers runtime environment facts and delegates the actual routing logic to the injectable core helper.

**Data flow**: It takes `text: &str`, computes `ssh_session`, `wsl_session`, and `tmux_session` via `is_ssh_session`, `is_wsl_session`, and `is_tmux_session`, packages them into `CopyEnvironment`, and calls `copy_to_clipboard_with` with the concrete backend functions `tmux_clipboard_copy`, `osc52_copy`, `arboard_copy`, and `wsl_clipboard_copy`. It returns either `Ok(Some(ClipboardLease))`, `Ok(None)`, or a composed `Err(String)` from the delegated logic.

**Call relations**: This is the public module-level entry used by the TUI copy command and hotkey path. It exists mainly to bind real environment detection and backend implementations before handing control to `copy_to_clipboard_with`.

*Call graph*: calls 4 internal fn (copy_to_clipboard_with, is_ssh_session, is_tmux_session, is_wsl_session).


##### `ClipboardLease::native_linux`  (lines 70–74)

```
fn native_linux(clipboard: arboard::Clipboard) -> Self
```

**Purpose**: Constructs a Linux clipboard lease that retains ownership of an `arboard::Clipboard` handle. This preserves clipboard contents on platforms where the writing process must stay alive to serve paste requests.

**Data flow**: It consumes an `arboard::Clipboard` and stores it in `ClipboardLease { _clipboard: Some(clipboard) }`. The returned lease carries no behavior beyond keeping that handle alive.

**Call relations**: This constructor is used only by `arboard_copy` on Linux after a successful native clipboard write. The returned lease is then propagated back through the copy API so the caller can retain it for the TUI lifetime.

*Call graph*: called by 1 (arboard_copy).


##### `ClipboardLease::test`  (lines 77–82)

```
fn test() -> Self
```

**Purpose**: Creates a dummy clipboard lease for tests without requiring a real clipboard handle. It lets unit tests exercise success paths that return a lease.

**Data flow**: It returns a `ClipboardLease` whose Linux `_clipboard` field is `None`. No external state is touched.

**Call relations**: This helper is used only inside the test module when injected native-copy closures need to simulate a successful lease-returning backend.


##### `copy_to_clipboard_with`  (lines 94–175)

```
fn copy_to_clipboard_with(
    text: &str,
    environment: CopyEnvironment,
    tmux_copy_fn: impl Fn(&str) -> Result<(), String>,
    osc52_copy_fn: impl Fn(&str) -> Result<(), String>,
    arboard_
```

**Purpose**: Implements the full backend-selection policy for clipboard copy using injected functions, making the decision tree testable. It chooses different fallback chains for SSH, local non-WSL, and local WSL sessions and composes detailed error messages when multiple backends fail.

**Data flow**: Inputs are the text to copy, a `CopyEnvironment`, and four backend closures/functions for tmux, OSC 52, native `arboard`, and WSL PowerShell copy. If `environment.ssh_session` is true, it immediately calls `terminal_clipboard_copy_with` and maps success to `Ok(None)`; on failure it logs a warning and returns an SSH-specific error string mentioning either terminal clipboard or OSC 52 depending on tmux presence. Otherwise it tries `arboard_copy_fn(text)`: success returns its `Option<ClipboardLease>` directly; failure logs a warning and either (for WSL) tries `wsl_copy_fn(text)` before terminal fallback, or (for non-WSL) falls straight back to `terminal_clipboard_copy_with`. In each fallback branch it preserves the earlier error text and appends later failures into a semicolon-separated message.

**Call relations**: This is the core logic behind `copy_to_clipboard` and the main subject of the unit tests, which inject closures to force each branch. It delegates terminal-specific behavior to `terminal_clipboard_copy_with` and leaves concrete clipboard/terminal I/O to the injected backend functions.

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

**Purpose**: Performs terminal-mediated clipboard copy, preferring tmux's native clipboard forwarding when inside tmux and otherwise using OSC 52 directly. It also wraps tmux failure with an OSC 52 fallback error if both mechanisms fail.

**Data flow**: It receives `text`, a `tmux_session` flag, and references to tmux and OSC 52 copy functions. If `tmux_session` is true it calls `tmux_copy_fn(text)` and returns success immediately; on tmux failure it logs a warning and calls `osc52_copy_fn(text)`, converting a second failure into `tmux clipboard: ...; OSC 52 fallback: ...`. If not in tmux, it simply returns `osc52_copy_fn(text)`.

**Call relations**: This helper is called only from `copy_to_clipboard_with` whenever the policy chooses a terminal-mediated path. It isolates the tmux-vs-OSC52 sub-decision so the higher-level function can focus on SSH/native/WSL routing.

*Call graph*: called by 1 (copy_to_clipboard_with); 1 external calls (warn!).


##### `is_ssh_session`  (lines 200–202)

```
fn is_ssh_session() -> bool
```

**Purpose**: Detects whether the current process appears to be running under SSH. The copy policy uses this to avoid writing to a remote machine's native clipboard.

**Data flow**: It reads the `SSH_TTY` and `SSH_CONNECTION` environment variables with `std::env::var_os` and returns `true` if either is present.

**Call relations**: This detector is called by `copy_to_clipboard` during environment assembly. Its boolean directly controls whether the copy path skips native clipboard access entirely.

*Call graph*: called by 1 (copy_to_clipboard); 1 external calls (var_os).


##### `is_tmux_session`  (lines 205–207)

```
fn is_tmux_session() -> bool
```

**Purpose**: Detects whether the process is running inside tmux. This determines whether terminal-mediated copy should try tmux clipboard forwarding before OSC 52.

**Data flow**: It checks `TMUX` and `TMUX_PANE` via `std::env::var_os` and returns `true` if either variable exists.

**Call relations**: This is another environment probe used by `copy_to_clipboard`. The resulting flag is passed through `CopyEnvironment` into both the SSH path and local terminal fallback path.

*Call graph*: called by 1 (copy_to_clipboard); 1 external calls (var_os).


##### `is_wsl_session`  (lines 215–217)

```
fn is_wsl_session() -> bool
```

**Purpose**: Detects whether the process is running under WSL so the copy logic can try the Windows clipboard through PowerShell after native Linux clipboard failure. On non-Linux targets it is hardwired to false.

**Data flow**: On Linux it delegates to `crate::clipboard_paste::is_probably_wsl()` and returns that boolean; on other targets it returns `false` directly.

**Call relations**: This detector is called by `copy_to_clipboard` when constructing `CopyEnvironment`. Its result enables the extra WSL PowerShell fallback branch inside `copy_to_clipboard_with`.

*Call graph*: calls 1 internal fn (is_probably_wsl); called by 1 (copy_to_clipboard).


##### `arboard_copy`  (lines 258–260)

```
fn arboard_copy(_text: &str) -> Result<Option<ClipboardLease>, String>
```

**Purpose**: Writes text to the native clipboard using `arboard`, with platform-specific behavior for stderr suppression and Linux clipboard ownership. On Linux it returns a lease that must be retained to keep the clipboard contents alive.

**Data flow**: On Linux, it creates a `SuppressStderr` guard, constructs `arboard::Clipboard::new()`, calls `set_text(text)`, and wraps the live clipboard in `ClipboardLease::native_linux`, returning `Ok(Some(lease))`. Errors from clipboard creation or `set_text` are converted into descriptive `String`s. On other supported non-Android targets the same write occurs but returns `Ok(None)` because no lease is needed.

**Call relations**: This function is passed as the native backend into `copy_to_clipboard`. The core routing logic in `copy_to_clipboard_with` tries it first for local sessions and only falls back when it returns an error.

*Call graph*: calls 2 internal fn (native_linux, new); 1 external calls (new).


##### `wsl_clipboard_copy`  (lines 309–311)

```
fn wsl_clipboard_copy(_text: &str) -> Result<(), String>
```

**Purpose**: Copies text from a WSL process into the Windows clipboard by piping UTF-8 text into `powershell.exe` and invoking `Set-Clipboard`. It is the WSL-specific fallback when native Linux clipboard access fails.

**Data flow**: It spawns `powershell.exe` with piped stdin, null stdout, and piped stderr, using a command string that sets console input encoding to UTF-8, reads all stdin, and calls `Set-Clipboard -Value $text`. It writes `text.as_bytes()` into the child's stdin, closes stdin, waits for output, and returns `Ok(())` on success. Failures at spawn, stdin acquisition, write, wait, or non-zero exit are converted into descriptive `Err(String)` values, including trimmed stderr when available.

**Call relations**: This backend is injected into `copy_to_clipboard_with` by `copy_to_clipboard` and is only attempted in the local WSL branch after native `arboard` copy fails. If it also fails, the core logic falls through to terminal-mediated copy.

*Call graph*: 5 external calls (from_utf8_lossy, new, format!, null, piped).


##### `tmux_clipboard_copy`  (lines 318–361)

```
fn tmux_clipboard_copy(text: &str) -> Result<(), String>
```

**Purpose**: Copies text through tmux's native clipboard integration using `load-buffer -w -`, after first verifying that tmux is configured to forward clipboard writes outward. This avoids relying on OSC 52 passthrough when tmux can handle clipboard forwarding itself.

**Data flow**: It first calls `tmux_clipboard_copy_ready`, supplying closures that fetch `tmux show-options -gv set-clipboard` and `tmux info` via `tmux_command_output`. If readiness succeeds, it spawns `tmux load-buffer -w -` with piped stdin, writes the text bytes into stdin, closes stdin, waits for output, and returns `Ok(())` on success. Spawn, stdin, write, wait, and non-zero exit failures are converted into `String` errors, using stderr text when present.

**Call relations**: This function is the tmux backend passed into `copy_to_clipboard`. It is selected by `terminal_clipboard_copy_with` whenever the environment indicates a tmux session, and that helper falls back to OSC 52 if this function returns an error.

*Call graph*: calls 1 internal fn (tmux_clipboard_copy_ready); 5 external calls (from_utf8_lossy, new, format!, null, piped).


##### `tmux_clipboard_copy_ready`  (lines 364–379)

```
fn tmux_clipboard_copy_ready(
    set_clipboard_fn: impl FnOnce() -> Result<String, String>,
    tmux_info_fn: impl FnOnce() -> Result<String, String>,
) -> Result<(), String>
```

**Purpose**: Validates that tmux clipboard forwarding is actually usable before attempting a clipboard write. It rejects configurations where forwarding is disabled or the terminal capability needed for OSC 52 forwarding is missing.

**Data flow**: It calls `set_clipboard_fn()` to obtain the `set-clipboard` option and returns an error if the trimmed value is `off`. Otherwise it calls `tmux_info_fn()` and scans the output lines for `Ms: [missing]`; if found, it returns an error about missing `Ms` capability. If neither condition triggers, it returns `Ok(())`.

**Call relations**: This helper is used by `tmux_clipboard_copy` before spawning `tmux load-buffer`. It is also directly exercised by dedicated unit tests that inject canned tmux outputs for accepted and rejected configurations.

*Call graph*: called by 4 (tmux_clipboard_copy_ready_accepts_forwarding_configuration, tmux_clipboard_copy_ready_rejects_disabled_forwarding, tmux_clipboard_copy_ready_rejects_missing_ms_capability, tmux_clipboard_copy).


##### `tmux_command_output`  (lines 381–398)

```
fn tmux_command_output(args: [&str; N]) -> Result<String, String>
```

**Purpose**: Runs a tmux command and returns its stdout as UTF-8 text or a descriptive error string. It is a small process-spawning utility used by tmux readiness checks.

**Data flow**: It takes a fixed-size array of `&str` arguments, spawns `tmux` with those args, and captures output. On success it decodes `output.stdout` with `String::from_utf8`; on failure it returns either `tmux exited with status ...` or `tmux failed: <stderr>` using lossy stderr decoding.

**Call relations**: This helper is called indirectly by `tmux_clipboard_copy` through the closures passed into `tmux_clipboard_copy_ready`. It isolates the repetitive command execution and output decoding needed for tmux introspection.

*Call graph*: 4 external calls (from_utf8, from_utf8_lossy, new, format!).


##### `SuppressStderr::drop`  (lines 437–444)

```
fn drop(&mut self)
```

**Purpose**: Restores the original stderr file descriptor when the suppression guard goes out of scope on macOS. It completes the RAII pattern started by `SuppressStderr::new`.

**Data flow**: If `self.saved_fd` is `Some(saved)`, it calls `libc::dup2(saved, 2)` to restore stderr and then `libc::close(saved)` to release the saved descriptor. It returns no value.

**Call relations**: This destructor runs automatically after `arboard_copy` finishes with a `SuppressStderr` guard in scope. It ensures temporary stderr redirection does not leak beyond the clipboard operation.

*Call graph*: 2 external calls (close, dup2).


##### `SuppressStderr::new`  (lines 452–454)

```
fn new() -> Self
```

**Purpose**: Creates an RAII guard that redirects stderr to `/dev/null` on macOS so clipboard initialization noise does not corrupt the TUI display. On failure it degrades gracefully by returning a guard with no saved descriptor.

**Data flow**: It uses unsafe libc calls to duplicate fd 2, open `/dev/null` for writing, and `dup2` that fd onto stderr. If any step fails it closes any intermediate descriptors and returns `SuppressStderr { saved_fd: None }`; otherwise it closes the `/dev/null` fd and returns a guard storing the saved original stderr fd.

**Call relations**: This constructor is called by `arboard_copy` before invoking `arboard::Clipboard::new()`. Its paired cleanup occurs in `SuppressStderr::drop` when the guard leaves scope.

*Call graph*: called by 1 (arboard_copy); 4 external calls (close, dup, dup2, open).


##### `osc52_copy`  (lines 458–476)

```
fn osc52_copy(text: &str) -> Result<(), String>
```

**Purpose**: Copies text by emitting an OSC 52 escape sequence to the terminal, optionally wrapped for tmux passthrough. It prefers writing directly to `/dev/tty` on Unix and falls back to stdout if that fails.

**Data flow**: It builds the escape sequence by calling `osc52_sequence(text, std::env::var_os("TMUX").is_some())`. On Unix it tries to open `/dev/tty` for writing and pass that handle plus the sequence to `write_osc52_to_writer`; if opening or writing fails it logs a debug message and falls back to `write_osc52_to_writer(std::io::stdout().lock(), &sequence)`. The result is `Ok(())` on successful write/flush or an `Err(String)` from sequence generation or writer operations.

**Call relations**: This function is the terminal fallback backend used by `copy_to_clipboard` and `terminal_clipboard_copy_with`. It delegates sequence construction to `osc52_sequence` and the actual byte emission to `write_osc52_to_writer`.

*Call graph*: calls 2 internal fn (osc52_sequence, write_osc52_to_writer); 4 external calls (var_os, new, stdout, debug!).


##### `write_osc52_to_writer`  (lines 478–485)

```
fn write_osc52_to_writer(mut writer: impl Write, sequence: &str) -> Result<(), String>
```

**Purpose**: Writes a prebuilt OSC 52 sequence to an arbitrary `Write` target and flushes it. It isolates the low-level I/O so `osc52_copy` can try multiple destinations.

**Data flow**: It takes a mutable writer and `sequence: &str`, writes `sequence.as_bytes()` with `write_all`, then flushes the writer. Any I/O error is converted into `failed to write OSC 52: ...` or `failed to flush OSC 52: ...`.

**Call relations**: This helper is called by `osc52_copy` for both `/dev/tty` and stdout destinations, and it is directly tested by `write_osc52_to_writer_emits_sequence_verbatim`.

*Call graph*: called by 1 (osc52_copy); 2 external calls (flush, write_all).


##### `osc52_sequence`  (lines 487–501)

```
fn osc52_sequence(text: &str, tmux: bool) -> Result<String, String>
```

**Purpose**: Constructs the OSC 52 escape sequence for a text payload, with optional tmux passthrough wrapping and a hard size limit. It prevents oversized payloads from being base64-encoded and sent to the terminal.

**Data flow**: It measures `text.len()` as raw bytes and returns an error if that exceeds `OSC52_MAX_RAW_BYTES`. Otherwise it base64-encodes `text.as_bytes()` using `base64::engine::general_purpose::STANDARD.encode(...)` and formats either a plain `\x1b]52;c;...\x07` sequence or a tmux-wrapped `\x1bPtmux;...\x1b\\` sequence depending on the `tmux` flag.

**Call relations**: This helper is used by `osc52_copy` at runtime and by tests that verify encoding, size rejection, and tmux wrapping. It is pure string construction with no I/O.

*Call graph*: called by 2 (osc52_copy, osc52_encoding_roundtrips); 1 external calls (format!).


##### `tests::remote_environment`  (lines 515–521)

```
fn remote_environment() -> CopyEnvironment
```

**Purpose**: Builds a `CopyEnvironment` representing an SSH session outside tmux for unit tests. It standardizes the remote baseline used by several routing tests.

**Data flow**: It returns `CopyEnvironment { ssh_session: true, wsl_session: true, tmux_session: false }`. No external state is read.

**Call relations**: This helper is called by SSH-focused tests that want to verify remote behavior without repeating the environment literal.


##### `tests::remote_tmux_environment`  (lines 523–528)

```
fn remote_tmux_environment() -> CopyEnvironment
```

**Purpose**: Builds a `CopyEnvironment` representing an SSH session inside tmux for tests. It extends the remote baseline with `tmux_session: true`.

**Data flow**: It starts from `remote_environment()` and overrides `tmux_session` to `true`, returning the resulting `CopyEnvironment`.

**Call relations**: This helper is used by tests that verify tmux-preferred behavior and tmux-to-OSC52 fallback in remote sessions.

*Call graph*: 1 external calls (remote_environment).


##### `tests::local_environment`  (lines 530–536)

```
fn local_environment() -> CopyEnvironment
```

**Purpose**: Builds a `CopyEnvironment` representing a local non-WSL, non-tmux session for tests. It is the baseline local environment fixture.

**Data flow**: It returns `CopyEnvironment { ssh_session: false, wsl_session: false, tmux_session: false }`.

**Call relations**: This helper is used by tests covering native clipboard success and local terminal fallback without WSL-specific behavior.


##### `tests::local_wsl_environment`  (lines 538–543)

```
fn local_wsl_environment() -> CopyEnvironment
```

**Purpose**: Builds a `CopyEnvironment` representing a local WSL session for tests. It enables the PowerShell fallback branch while remaining non-SSH and non-tmux.

**Data flow**: It starts from `local_environment()` and overrides `wsl_session` to `true`, returning the resulting environment.

**Call relations**: This helper is used by tests that verify the native → WSL PowerShell → terminal fallback chain.

*Call graph*: 1 external calls (local_environment).


##### `tests::local_tmux_environment`  (lines 545–550)

```
fn local_tmux_environment() -> CopyEnvironment
```

**Purpose**: Builds a `CopyEnvironment` representing a local tmux session for tests. It enables tmux-preferred terminal fallback after native clipboard failure.

**Data flow**: It starts from `local_environment()` and overrides `tmux_session` to `true`.

**Call relations**: This helper is used by tests that verify local fallback prefers tmux clipboard forwarding over OSC 52.

*Call graph*: 1 external calls (local_environment).


##### `tests::osc52_encoding_roundtrips`  (lines 553–564)

```
fn osc52_encoding_roundtrips()
```

**Purpose**: Verifies that `osc52_sequence` base64-encodes text correctly by decoding the payload back to the original bytes. It checks the happy path for a multiline sample string.

**Data flow**: The test builds a sample text, calls `osc52_sequence(text, false)`, strips the OSC 52 prefix/suffix from the returned string, decodes the base64 payload, and asserts equality with `text.as_bytes()`.

**Call relations**: This test directly exercises `osc52_sequence`'s encoding behavior rather than the higher-level copy routing.

*Call graph*: calls 1 internal fn (osc52_sequence); 1 external calls (assert_eq!).


##### `tests::osc52_rejects_payload_larger_than_limit`  (lines 567–576)

```
fn osc52_rejects_payload_larger_than_limit()
```

**Purpose**: Checks that oversized text is rejected before OSC 52 encoding. It validates the module's explicit payload-size guard.

**Data flow**: It creates a string one byte larger than `OSC52_MAX_RAW_BYTES`, calls `osc52_sequence(&text, false)`, and asserts that the result is the expected `Err(...)` message.

**Call relations**: This test targets the size-check branch inside `osc52_sequence`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::osc52_wraps_tmux_passthrough`  (lines 579–584)

```
fn osc52_wraps_tmux_passthrough()
```

**Purpose**: Verifies that OSC 52 sequences are wrapped in tmux passthrough framing when the `tmux` flag is true. It checks the exact escape-string format.

**Data flow**: It calls `osc52_sequence("hello", true)` and asserts equality with the expected tmux-wrapped escape sequence string.

**Call relations**: This test covers the tmux-specific formatting branch of `osc52_sequence`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::write_osc52_to_writer_emits_sequence_verbatim`  (lines 587–592)

```
fn write_osc52_to_writer_emits_sequence_verbatim()
```

**Purpose**: Ensures the low-level writer helper outputs the provided OSC 52 sequence unchanged. It validates that no extra bytes or transformations are introduced.

**Data flow**: It creates a `Vec<u8>` buffer, calls `write_osc52_to_writer(&mut output, sequence)`, and asserts both success and byte-for-byte equality between the buffer and `sequence.as_bytes()`.

**Call relations**: This test isolates `write_osc52_to_writer` from terminal detection and sequence generation.

*Call graph*: 2 external calls (new, assert_eq!).


##### `tests::ssh_uses_osc52_and_skips_native_on_success`  (lines 595–626)

```
fn ssh_uses_osc52_and_skips_native_on_success()
```

**Purpose**: Confirms that in a remote non-tmux environment the copy logic uses OSC 52 directly and never touches native or WSL clipboard backends. It validates the SSH short-circuit behavior.

**Data flow**: The test injects closures that increment `Cell<u8>` counters for tmux, OSC 52, native, and WSL calls, runs `copy_to_clipboard_with("hello", remote_environment(), ...)`, and asserts `Ok(None)` plus the expected call counts: only OSC 52 invoked once.

**Call relations**: This test exercises the SSH branch of `copy_to_clipboard_with` and proves that native clipboard access is skipped entirely over SSH.

*Call graph*: calls 1 internal fn (copy_to_clipboard_with); 4 external calls (new, assert!, assert_eq!, remote_environment).


##### `tests::ssh_returns_osc52_error_and_skips_native`  (lines 629–663)

```
fn ssh_returns_osc52_error_and_skips_native()
```

**Purpose**: Checks that a remote non-tmux OSC 52 failure is surfaced with the SSH-specific error message and still does not attempt native or WSL backends. It validates both routing and error wording.

**Data flow**: It injects an OSC 52 closure that returns `Err("blocked")`, runs `copy_to_clipboard_with` in `remote_environment()`, extracts the error, and asserts the exact message and call counters.

**Call relations**: This test covers the SSH error path in `copy_to_clipboard_with` when terminal copy fails outside tmux.

*Call graph*: calls 1 internal fn (copy_to_clipboard_with); 4 external calls (new, assert_eq!, panic!, remote_environment).


##### `tests::ssh_inside_tmux_prefers_tmux_clipboard`  (lines 666–697)

```
fn ssh_inside_tmux_prefers_tmux_clipboard()
```

**Purpose**: Verifies that remote sessions inside tmux try tmux clipboard forwarding before OSC 52. It checks the preferred terminal backend ordering.

**Data flow**: Using counter closures, it runs `copy_to_clipboard_with` in `remote_tmux_environment()` with tmux success and asserts `Ok(None)` plus one tmux call and zero OSC/native/WSL calls.

**Call relations**: This test exercises the SSH path plus the tmux-preferred branch inside `terminal_clipboard_copy_with`.

*Call graph*: calls 1 internal fn (copy_to_clipboard_with); 4 external calls (new, assert!, assert_eq!, remote_tmux_environment).


##### `tests::ssh_inside_tmux_falls_back_to_osc52_when_tmux_copy_fails`  (lines 700–731)

```
fn ssh_inside_tmux_falls_back_to_osc52_when_tmux_copy_fails()
```

**Purpose**: Confirms that a tmux clipboard failure in a remote tmux session falls back to OSC 52. It validates the nested fallback inside terminal-mediated copy.

**Data flow**: It injects a failing tmux closure and successful OSC 52 closure, runs `copy_to_clipboard_with` in `remote_tmux_environment()`, and asserts success with one tmux call and one OSC 52 call.

**Call relations**: This test targets the tmux-failure branch of `terminal_clipboard_copy_with` as reached through the SSH path.

*Call graph*: calls 1 internal fn (copy_to_clipboard_with); 4 external calls (new, assert!, assert_eq!, remote_tmux_environment).


##### `tests::ssh_inside_tmux_reports_tmux_and_osc52_errors_when_both_fail`  (lines 734–751)

```
fn ssh_inside_tmux_reports_tmux_and_osc52_errors_when_both_fail()
```

**Purpose**: Checks that when both tmux clipboard forwarding and OSC 52 fail in a remote tmux session, the returned error preserves both causes. It validates composed error reporting.

**Data flow**: It runs `copy_to_clipboard_with` in `remote_tmux_environment()` with both terminal backends returning errors and asserts the exact combined error string.

**Call relations**: This test covers the deepest SSH terminal-fallback failure path, proving that `terminal_clipboard_copy_with` and `copy_to_clipboard_with` preserve both error layers.

*Call graph*: calls 1 internal fn (copy_to_clipboard_with); 3 external calls (assert_eq!, panic!, remote_tmux_environment).


##### `tests::tmux_clipboard_copy_ready_accepts_forwarding_configuration`  (lines 754–761)

```
fn tmux_clipboard_copy_ready_accepts_forwarding_configuration()
```

**Purpose**: Verifies that tmux readiness succeeds when clipboard forwarding is enabled and the `Ms` capability is present. It checks the positive validation case.

**Data flow**: It calls `tmux_clipboard_copy_ready` with closures returning `external\n` and a tmux info line containing an `Ms` capability string, then asserts `Ok(())`.

**Call relations**: This test directly exercises `tmux_clipboard_copy_ready` without spawning tmux.

*Call graph*: calls 1 internal fn (tmux_clipboard_copy_ready); 1 external calls (assert_eq!).


##### `tests::tmux_clipboard_copy_ready_rejects_disabled_forwarding`  (lines 764–774)

```
fn tmux_clipboard_copy_ready_rejects_disabled_forwarding()
```

**Purpose**: Ensures tmux readiness fails immediately when `set-clipboard` is `off`. It validates the first readiness guard.

**Data flow**: It calls `tmux_clipboard_copy_ready` with a closure returning `off\n` and a second closure that would panic if called, then asserts the expected disabled-forwarding error.

**Call relations**: This test proves `tmux_clipboard_copy_ready` short-circuits before querying tmux info when forwarding is disabled.

*Call graph*: calls 1 internal fn (tmux_clipboard_copy_ready); 1 external calls (assert_eq!).


##### `tests::tmux_clipboard_copy_ready_rejects_missing_ms_capability`  (lines 777–787)

```
fn tmux_clipboard_copy_ready_rejects_missing_ms_capability()
```

**Purpose**: Ensures tmux readiness rejects terminals lacking the `Ms` capability needed for clipboard forwarding. It validates the second readiness guard.

**Data flow**: It calls `tmux_clipboard_copy_ready` with `set-clipboard` enabled and tmux info containing `Ms: [missing]`, then asserts the expected error string.

**Call relations**: This test covers the capability-check branch of `tmux_clipboard_copy_ready`.

*Call graph*: calls 1 internal fn (tmux_clipboard_copy_ready); 1 external calls (assert_eq!).


##### `tests::local_uses_native_clipboard_first`  (lines 790–816)

```
fn local_uses_native_clipboard_first()
```

**Purpose**: Confirms that local sessions prefer the native clipboard backend even when WSL fallback is available. It validates the primary local success path.

**Data flow**: It injects a native backend that returns `Ok(Some(ClipboardLease::test()))`, runs `copy_to_clipboard_with` in `local_wsl_environment()`, and asserts success with only the native backend called.

**Call relations**: This test demonstrates that `copy_to_clipboard_with` does not unnecessarily invoke WSL or terminal fallbacks after native success.

*Call graph*: calls 1 internal fn (copy_to_clipboard_with); 4 external calls (new, assert!, assert_eq!, local_wsl_environment).


##### `tests::local_non_wsl_falls_back_to_osc52_when_native_fails`  (lines 819–845)

```
fn local_non_wsl_falls_back_to_osc52_when_native_fails()
```

**Purpose**: Checks that a local non-WSL native clipboard failure falls back directly to OSC 52. It validates the standard local fallback chain outside WSL.

**Data flow**: It injects a failing native backend and successful OSC 52 backend, runs `copy_to_clipboard_with` in `local_environment()`, and asserts `Ok(None)` with one native call and one OSC 52 call.

**Call relations**: This test covers the non-WSL local error branch in `copy_to_clipboard_with`.

*Call graph*: calls 1 internal fn (copy_to_clipboard_with); 4 external calls (new, assert!, assert_eq!, local_environment).


##### `tests::local_tmux_fallback_prefers_tmux_when_native_fails`  (lines 848–879)

```
fn local_tmux_fallback_prefers_tmux_when_native_fails()
```

**Purpose**: Verifies that local terminal fallback prefers tmux clipboard forwarding over OSC 52 when inside tmux. It checks the interaction between local native failure and tmux-aware terminal copy.

**Data flow**: It injects a failing native backend and successful tmux backend, runs `copy_to_clipboard_with` in `local_tmux_environment()`, and asserts success with one native call, one tmux call, and zero OSC 52 calls.

**Call relations**: This test reaches `terminal_clipboard_copy_with` through the local fallback path and confirms tmux preference there as well.

*Call graph*: calls 1 internal fn (copy_to_clipboard_with); 4 external calls (new, assert!, assert_eq!, local_tmux_environment).


##### `tests::local_wsl_native_failure_uses_powershell_and_skips_osc52_on_success`  (lines 882–908)

```
fn local_wsl_native_failure_uses_powershell_and_skips_osc52_on_success()
```

**Purpose**: Confirms that in local WSL sessions, native clipboard failure triggers the PowerShell fallback before any terminal-mediated copy. It validates the WSL-specific middle step.

**Data flow**: It injects a failing native backend, successful WSL backend, and successful OSC 52 backend, runs `copy_to_clipboard_with` in `local_wsl_environment()`, and asserts success with native and WSL called once each and OSC 52 never called.

**Call relations**: This test covers the WSL-specific branch in `copy_to_clipboard_with` where PowerShell succeeds and terminal fallback is skipped.

*Call graph*: calls 1 internal fn (copy_to_clipboard_with); 4 external calls (new, assert!, assert_eq!, local_wsl_environment).


##### `tests::local_wsl_falls_back_to_osc52_when_native_and_powershell_fail`  (lines 911–937)

```
fn local_wsl_falls_back_to_osc52_when_native_and_powershell_fail()
```

**Purpose**: Checks that local WSL sessions fall through to terminal-mediated copy when both native and PowerShell clipboard writes fail. It validates the full WSL fallback chain.

**Data flow**: It injects failing native and WSL backends plus successful OSC 52, runs `copy_to_clipboard_with` in `local_wsl_environment()`, and asserts success with all three backends called in order.

**Call relations**: This test exercises the deepest successful WSL fallback path in `copy_to_clipboard_with`.

*Call graph*: calls 1 internal fn (copy_to_clipboard_with); 4 external calls (new, assert!, assert_eq!, local_wsl_environment).


##### `tests::local_reports_both_errors_when_native_and_osc52_fail`  (lines 940–972)

```
fn local_reports_both_errors_when_native_and_osc52_fail()
```

**Purpose**: Ensures that local non-WSL failures preserve both the native clipboard error and the terminal fallback error. It validates composed error reporting outside WSL.

**Data flow**: It injects failing native and OSC 52 backends, runs `copy_to_clipboard_with` in `local_environment()`, extracts the error, and asserts the exact combined message.

**Call relations**: This test covers the non-WSL local all-fail branch of `copy_to_clipboard_with`.

*Call graph*: calls 1 internal fn (copy_to_clipboard_with); 4 external calls (new, assert_eq!, panic!, local_environment).


##### `tests::local_wsl_reports_native_powershell_and_osc52_errors_when_all_fail`  (lines 975–1007)

```
fn local_wsl_reports_native_powershell_and_osc52_errors_when_all_fail()
```

**Purpose**: Ensures that when every local WSL backend fails, the returned error includes native, PowerShell, and terminal causes in order. It validates the most detailed error composition path.

**Data flow**: It injects failing native, WSL, and OSC 52 backends, runs `copy_to_clipboard_with` in `local_wsl_environment()`, and asserts the exact three-part error string.

**Call relations**: This test covers the complete WSL failure path in `copy_to_clipboard_with`, proving that each fallback layer's error is retained.

*Call graph*: calls 1 internal fn (copy_to_clipboard_with); 4 external calls (new, assert_eq!, panic!, local_wsl_environment).


### `tui/src/terminal_palette.rs`

`config` · `startup palette detection and cross-cutting rendering`

This module is the TUI's palette and color-capability utility. At the top level it defines `StdoutColorLevel` with `TrueColor`, `Ansi256`, `Ansi16`, and `Unknown`, then derives the current stdout capability from `supports_color`. `best_color` and `best_color_for_level` convert a target RGB tuple into the closest `ratatui::style::Color` the terminal can actually display: truecolor terminals get exact `Color::Rgb`, ANSI-256 terminals are quantized against the fixed xterm palette entries 16..255 using perceptual distance, and ANSI-16 or unknown terminals fall back to `Color::Reset`/default so theme code can remain conservative.

The module also adjusts reported capability for known Windows-terminal cases. `effective_stdout_color_level` combines the raw stdout level, detected terminal name, and environment variables such as `WT_SESSION` and `FORCE_COLOR`; Windows Terminal is promoted to truecolor unless an explicit force-color override says to trust the reported lower level.

Default terminal colors are exposed as `default_colors`, `default_fg`, and `default_bg`, backed by platform-specific `imp` modules. On Unix and Windows, a small `Cache<T>` stores whether probing has been attempted and the optional `DefaultColors` result, so unsupported terminals do not get reprobed repeatedly. Startup code can seed the cache from an earlier bounded probe, and Unix can later requery through crossterm on focus events. The large `XTERM_COLORS` table is static data used only for ANSI-256 quantization; the first 16 entries are intentionally skipped because they vary with terminal theme.

#### Function details

##### `stdout_color_level`  (lines 14–21)

```
fn stdout_color_level() -> StdoutColorLevel
```

**Purpose**: Detects the terminal color capability reported for stdout and maps it into the module's `StdoutColorLevel` enum. It is the raw capability probe before terminal-specific adjustments.

**Data flow**: It queries `supports_color::on_cached(Stream::Stdout)` and returns `TrueColor` when `has_16m`, `Ansi256` when `has_256`, `Ansi16` for any other reported support, or `Unknown` when no information is available.

**Call relations**: Rendering code and `effective_stdout_color_level` call this as the baseline stdout capability source.

*Call graph*: called by 4 (current, diff_color_level, table_separator_style, effective_stdout_color_level); 1 external calls (on_cached).


##### `rgb_color`  (lines 24–26)

```
fn rgb_color((r, g, b): (u8, u8, u8)) -> Color
```

**Purpose**: Constructs a ratatui truecolor `Color::Rgb` from an RGB tuple. It is a small convenience wrapper used throughout palette-aware styling.

**Data flow**: It destructures `(r, g, b)` and returns `Color::Rgb(r, g, b)`.

**Call relations**: Truecolor styling and quantization helpers call this when exact RGB output is desired.

*Call graph*: called by 10 (truecolor_palette_blends_empty_cell_for_light_background, truecolor_palette_blends_theme_accent_against_dark_background, add_line_bg, color_from_rgb_for_level, del_line_bg, light_add_num_bg, light_del_num_bg, light_gutter_fg, table_separator_style_for, best_color_for_color_level); 1 external calls (Rgb).


##### `indexed_color`  (lines 29–31)

```
fn indexed_color(index: u8) -> Color
```

**Purpose**: Constructs a ratatui indexed color from an ANSI palette index. It is used when quantizing to ANSI-256.

**Data flow**: It takes `index: u8` and returns `Color::Indexed(index)`.

**Call relations**: ANSI-256 quantization and some theme code use this helper instead of constructing indexed colors inline.

*Call graph*: called by 6 (add_line_bg, del_line_bg, light_add_num_bg, light_del_num_bg, light_gutter_fg, quantize_rgb_to_ansi256); 1 external calls (Indexed).


##### `best_color`  (lines 34–36)

```
fn best_color(target: (u8, u8, u8)) -> Color
```

**Purpose**: Returns the closest displayable color to a target RGB tuple for the current terminal environment. It is the main palette-aware color selection entry point.

**Data flow**: It takes `target: (u8,u8,u8)`, computes `effective_stdout_color_level()`, passes both into `best_color_for_color_level`, and returns the resulting `Color`.

**Call relations**: Many style constructors call this when they want a target RGB but need terminal-aware fallback behavior.

*Call graph*: calls 2 internal fn (best_color_for_color_level, effective_stdout_color_level); called by 5 (dense_row_background_style, transcript_loading_overlay_style, accent_style_for, table_separator_style_for, user_message_bg).


##### `best_color_for_level`  (lines 39–41)

```
fn best_color_for_level(target: (u8, u8, u8), color_level: StdoutColorLevel) -> Color
```

**Purpose**: Returns the closest displayable color to a target RGB tuple for an explicitly supplied color level. It is useful when the caller already knows the capability context.

**Data flow**: It takes `target` and `color_level`, forwards them to `best_color_for_color_level`, and returns the resulting `Color`.

**Call relations**: Callers that compute colors for a known capability level use this instead of consulting global terminal state.

*Call graph*: calls 1 internal fn (best_color_for_color_level); called by 1 (from_parts).


##### `effective_stdout_color_level`  (lines 43–50)

```
fn effective_stdout_color_level() -> StdoutColorLevel
```

**Purpose**: Computes the stdout color level after applying terminal-specific heuristics and environment overrides. It smooths over known under-reporting cases, especially on Windows Terminal.

**Data flow**: It reads the raw `stdout_color_level()`, terminal name from `terminal_info().name`, and booleans for `WT_SESSION` and `FORCE_COLOR` environment variables, passes them to `stdout_color_level_for_terminal`, and returns the adjusted `StdoutColorLevel`.

**Call relations**: Only `best_color` calls this helper, keeping environment-sensitive capability adjustment centralized.

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

**Purpose**: Applies terminal-name and environment-specific promotion rules to a reported stdout color level. It currently upgrades certain Windows Terminal cases to truecolor unless explicitly overridden.

**Data flow**: Inputs are the reported `stdout_level`, `terminal_name`, and booleans for `has_wt_session` and `has_force_color_override`. It returns `TrueColor` immediately when `WT_SESSION` is present without `FORCE_COLOR`; otherwise it promotes `Ansi16` plus `TerminalName::WindowsTerminal` to `TrueColor` when not overridden, and returns the original level in all other cases.

**Call relations**: This helper is used only by `effective_stdout_color_level`, isolating platform heuristics from the rest of the module.

*Call graph*: called by 1 (effective_stdout_color_level).


##### `best_color_for_color_level`  (lines 72–84)

```
fn best_color_for_color_level(target: (u8, u8, u8), color_level: StdoutColorLevel) -> Color
```

**Purpose**: Implements the actual color selection policy for a target RGB tuple under a specific color capability. It chooses exact RGB, nearest ANSI-256 palette entry, or reset/default fallback.

**Data flow**: It matches on `color_level`: `TrueColor` returns `rgb_color(target)`; `Ansi256` iterates `xterm_fixed_colors()`, chooses the palette entry with minimum `perceptual_distance` to `target`, and returns `indexed_color(index)` or `Color::default()` if no entry exists; `Ansi16` and `Unknown` return `Color::default()`.

**Call relations**: Both `best_color` and `best_color_for_level` delegate here so all quantization logic lives in one place.

*Call graph*: calls 2 internal fn (rgb_color, xterm_fixed_colors); called by 2 (best_color, best_color_for_level); 1 external calls (default).


##### `requery_default_colors`  (lines 86–88)

```
fn requery_default_colors()
```

**Purpose**: Requests a refresh of cached terminal default colors through the platform-specific implementation. It is used when the terminal palette may have changed after startup.

**Data flow**: It calls `imp::requery_default_colors()` and returns `()`. Any cache mutation happens inside the platform module.

**Call relations**: Higher-level lifecycle code invokes this on events such as focus/resume when a palette refresh is desirable.

*Call graph*: 1 external calls (requery_default_colors).


##### `default_colors`  (lines 96–98)

```
fn default_colors() -> Option<DefaultColors>
```

**Purpose**: Returns the cached or lazily probed terminal default foreground/background colors as a pair. Missing support or probe failure yields `None`.

**Data flow**: It calls `imp::default_colors()` and returns `Option<DefaultColors>`.

**Call relations**: Foreground and background accessors delegate here so the cache/probe policy remains hidden behind one function.

*Call graph*: called by 2 (default_bg, default_fg); 1 external calls (default_colors).


##### `default_fg`  (lines 100–102)

```
fn default_fg() -> Option<(u8, u8, u8)>
```

**Purpose**: Returns just the terminal's default foreground RGB tuple when known. It is a convenience accessor over `default_colors`.

**Data flow**: It calls `default_colors()`, maps the result to `c.fg`, and returns `Option<(u8,u8,u8)>`.

**Call relations**: Style code uses this when blending against the terminal's foreground color.

*Call graph*: calls 1 internal fn (default_colors); called by 3 (current, shimmer_spans, table_separator_style).


##### `default_bg`  (lines 104–106)

```
fn default_bg() -> Option<(u8, u8, u8)>
```

**Purpose**: Returns just the terminal's default background RGB tuple when known. It is the most commonly used palette accessor for theme adaptation.

**Data flow**: It calls `default_colors()`, maps the result to `c.bg`, and returns `Option<(u8,u8,u8)>`.

**Call relations**: Many style and theme functions call this to adapt colors to light versus dark terminal backgrounds.

*Call graph*: calls 1 internal fn (default_colors); called by 15 (current, diff_theme, adaptive_default_theme_selection, conversation_assistant_style, conversation_user_style, dense_row_background_style, footer_hint_key_style, footer_hint_label_style, selected_session_style, transcript_loading_overlay_style (+5 more)).


##### `set_default_colors_from_startup_probe`  (lines 109–113)

```
fn set_default_colors_from_startup_probe(
    colors: Option<crate::terminal_probe::DefaultColors>,
)
```

**Purpose**: Seeds the default-color cache from an earlier startup probe result on supported platforms. This avoids repeating terminal queries after startup has already collected the information.

**Data flow**: It takes `Option<crate::terminal_probe::DefaultColors>` and forwards it to the platform-specific `imp::set_default_colors_from_startup_probe`, which converts and stores it in the cache.

**Call relations**: Startup orchestration calls this after bounded terminal probing so later palette lookups can use cached values immediately.

*Call graph*: 1 external calls (set_default_colors_from_startup_probe).


##### `imp::color_to_tuple`  (lines 209–214)

```
fn color_to_tuple(color: CrosstermColor) -> Option<(u8, u8, u8)>
```

**Purpose**: Converts a crossterm color value into an RGB tuple only when it is an explicit `Rgb` color. Non-RGB colors are ignored.

**Data flow**: It matches on `CrosstermColor`; `Rgb { r, g, b }` becomes `Some((r,g,b))`, all other variants return `None`.

**Call relations**: Unix requery logic uses this when translating crossterm foreground/background query results into cached default colors.


##### `imp::Cache::default`  (lines 229–234)

```
fn default() -> Self
```

**Purpose**: Creates an empty cache entry that has not yet attempted initialization and holds no value. It is the baseline state for default-color caching.

**Data flow**: It returns `Cache { attempted: false, value: None }`.

**Call relations**: The platform cache singleton initializes its `Mutex<Cache<DefaultColors>>` with this default state.


##### `imp::Cache::get_or_init_with`  (lines 238–244)

```
fn get_or_init_with(&mut self, mut init: impl FnMut() -> Option<T>) -> Option<T>
```

**Purpose**: Lazily initializes a cache value exactly once, remembering both successful and unsuccessful attempts. Failed probes are cached as attempted `None`.

**Data flow**: It takes `&mut self` and an initializer closure. If `attempted` is false, it stores `self.value = init()` and sets `attempted = true`; it then returns `self.value`.

**Call relations**: Platform `default_colors` accessors use this to ensure probing happens at most once unless explicitly refreshed.


##### `imp::default_colors_cache`  (lines 247–250)

```
fn default_colors_cache() -> &'static Mutex<Cache<DefaultColors>>
```

**Purpose**: Returns the process-wide mutex-protected cache storing probed default terminal colors. It lazily creates the singleton on first use.

**Data flow**: It accesses a `OnceLock<Mutex<Cache<DefaultColors>>>`, initializes it with `Mutex::new(Cache::default())` if needed, and returns a shared reference to the mutex.

**Call relations**: All platform cache operations go through this singleton accessor.

*Call graph*: 1 external calls (new).


##### `imp::query_default_colors`  (lines 272–280)

```
fn query_default_colors() -> Option<DefaultColors>
```

**Purpose**: Performs the bounded startup-path terminal probe for default colors and converts the result into the palette module's `DefaultColors` type. Probe errors and missing responses collapse to `None`.

**Data flow**: It calls `crate::terminal_probe::default_colors(DEFAULT_TIMEOUT)`, converts `Ok(Some(colors))` into `Some(DefaultColors { fg, bg })`, and returns `None` for errors or absent responses.

**Call relations**: Lazy cache initialization uses this as the one-shot probe function.

*Call graph*: calls 1 internal fn (default_colors).


##### `imp::default_colors`  (lines 287–289)

```
fn default_colors() -> Option<DefaultColors>
```

**Purpose**: Returns cached default colors on supported platforms, probing once on first access if necessary. Mutex poisoning or lock failure yields `None`.

**Data flow**: It obtains the cache mutex from `default_colors_cache()`, locks it, and calls `cache.get_or_init_with(query_default_colors)`, returning the resulting `Option<DefaultColors>`.

**Call relations**: The top-level `default_colors` wrapper delegates here to hide platform-specific caching details.

*Call graph*: 1 external calls (default_colors_cache).


##### `imp::set_default_colors_from_startup_probe`  (lines 292–295)

```
fn set_default_colors_from_startup_probe(
        _colors: Option<crate::terminal_probe::DefaultColors>,
    )
```

**Purpose**: Stores startup-probed default colors directly into the cache and marks probing as attempted. This bypasses lazy probing when startup already has the answer.

**Data flow**: It locks the cache mutex, maps the probe type into the local `DefaultColors` struct when present, assigns `cache.value`, sets `cache.attempted = true`, and returns `()`.

**Call relations**: The top-level startup-seeding function delegates here on Unix and Windows.

*Call graph*: 1 external calls (default_colors_cache).


##### `imp::requery_default_colors`  (lines 297–297)

```
fn requery_default_colors()
```

**Purpose**: Refreshes cached default colors on Unix through crossterm's foreground/background query APIs, unless the cache has already recorded a permanent unsupported result. It is the runtime refresh path after startup.

**Data flow**: It locks the cache, returns early if probing was attempted and failed with `None`, otherwise queries foreground and background colors via crossterm, converts RGB results with `color_to_tuple`, zips them into `DefaultColors` when both are present, stores the new value, and marks `attempted = true`.

**Call relations**: The top-level `requery_default_colors` wrapper delegates here on Unix; Windows and fallback builds provide no-op implementations.

*Call graph*: 3 external calls (query_background_color, query_foreground_color, default_colors_cache).


##### `xterm_fixed_colors`  (lines 301–303)

```
fn xterm_fixed_colors() -> impl Iterator<Item = (usize, (u8, u8, u8))>
```

**Purpose**: Returns an iterator over the stable portion of the xterm 256-color palette, skipping the first 16 theme-dependent entries. This is the candidate set for ANSI-256 quantization.

**Data flow**: It iterates `XTERM_COLORS.into_iter().enumerate().skip(16)` and returns that iterator.

**Call relations**: Only `best_color_for_color_level` uses this helper when searching for the nearest ANSI-256 color.

*Call graph*: called by 1 (best_color_for_color_level).


##### `tests::best_color_uses_truecolor_without_quantization`  (lines 574–579)

```
fn best_color_uses_truecolor_without_quantization()
```

**Purpose**: Verifies that truecolor mode returns the exact requested RGB value rather than quantizing it. It protects the truecolor branch of color selection.

**Data flow**: It calls `best_color_for_color_level((12,34,56), StdoutColorLevel::TrueColor)` and asserts equality with `rgb_color((12,34,56))`.

**Call relations**: This test isolates the exact-color branch of `best_color_for_color_level`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::best_color_resets_for_ansi16`  (lines 582–587)

```
fn best_color_resets_for_ansi16()
```

**Purpose**: Verifies that ANSI-16 mode falls back to reset/default rather than attempting unsupported quantization. It protects the conservative fallback policy.

**Data flow**: It calls `best_color_for_color_level((12,34,56), StdoutColorLevel::Ansi16)` and asserts equality with `Color::Reset`.

**Call relations**: This test covers the low-color fallback branch of color selection.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::windows_terminal_wt_session_promotes_to_truecolor`  (lines 590–600)

```
fn windows_terminal_wt_session_promotes_to_truecolor()
```

**Purpose**: Checks that the presence of `WT_SESSION` promotes the effective color level to truecolor even when the reported stdout level is only ANSI-16. It validates one Windows-specific heuristic.

**Data flow**: It calls `stdout_color_level_for_terminal` with `Ansi16`, unknown terminal name, `has_wt_session = true`, and no force-color override, then asserts `TrueColor`.

**Call relations**: This test targets the highest-priority promotion rule in terminal capability adjustment.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::windows_terminal_name_promotes_ansi16_to_truecolor`  (lines 603–613)

```
fn windows_terminal_name_promotes_ansi16_to_truecolor()
```

**Purpose**: Checks that a detected Windows Terminal name promotes ANSI-16 to truecolor when no force-color override is present. It validates the terminal-name heuristic.

**Data flow**: It calls `stdout_color_level_for_terminal` with `Ansi16`, `TerminalName::WindowsTerminal`, no `WT_SESSION`, and no override, then asserts `TrueColor`.

**Call relations**: This test covers the second promotion rule in capability adjustment.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::force_color_keeps_reported_stdout_level`  (lines 616–626)

```
fn force_color_keeps_reported_stdout_level()
```

**Purpose**: Verifies that `FORCE_COLOR` disables the Windows-specific truecolor promotions and preserves the reported stdout level. It protects explicit user override semantics.

**Data flow**: It calls `stdout_color_level_for_terminal` with `Ansi16`, Windows Terminal, `WT_SESSION = true`, and `has_force_color_override = true`, then asserts the result remains `Ansi16`.

**Call relations**: This test covers the override branch that suppresses heuristic promotion.

*Call graph*: 1 external calls (assert_eq!).


### Sandbox diagnostics and Windows support
These utilities provide sandbox-specific diagnostics and the Windows-focused helpers needed to prepare paths, environment, permissions, and sensitive dependencies for sandboxed execution.

### `cli/src/debug_sandbox/seatbelt.rs`

`util` · `during and immediately after macOS sandbox child execution`

This file provides the macOS denial-logging support used by the debug sandbox runner. `DenialLogger::new` starts a `log stream --style ndjson` subprocess with a predicate that captures sandbox-reporting events, takes its stdout, and spawns an async reader task that accumulates raw log bytes line by line. The logger initially has no PID tracker; `on_child_spawn` attaches one by creating a `PidTracker` rooted at the spawned child PID.

When `finish` is called, the logger first stops PID tracking and obtains the full set of descendant PIDs. If no PIDs were tracked, it returns an empty denial list immediately. Otherwise it kills and waits for the `log` subprocess, joins the reader task to obtain all captured bytes, decodes them lossily as UTF-8, and scans each line as JSON. For each line it looks up `eventMessage`, parses messages of the form `Sandbox: processname(1234) deny(...) capability...` with a lazily initialized regex in `parse_message`, and keeps only entries whose PID belongs to the tracked process tree. A `HashSet<(String, String)>` deduplicates repeated denials by process name and capability before producing `Vec<SandboxDenial>`. The design intentionally separates process-tree scoping from log parsing so unrelated system sandbox denials do not pollute the output.

#### Function details

##### `DenialLogger::new`  (lines 20–44)

```
fn new() -> Option<Self>
```

**Purpose**: Starts the macOS unified-log stream and an async reader task that buffers its stdout for later parsing. It returns `None` if the log subprocess or stdout pipe cannot be established.

**Data flow**: The method calls `start_log_stream()` to spawn `log stream`, takes the child's stdout pipe, and spawns a Tokio task that wraps it in `BufReader`, repeatedly calls `read_until(b'\n', &mut chunk)`, appends each chunk into a `Vec<u8>`, and returns the accumulated bytes when EOF or error occurs. It stores the `Child`, initializes `pid_tracker` to `None`, stores the reader `JoinHandle`, and returns `Some(DenialLogger)`.

**Call relations**: The debug sandbox runner creates this logger only when denial logging is requested on macOS. Later `run_command_under_sandbox` calls `on_child_spawn` and `finish` around the sandboxed child lifecycle.

*Call graph*: calls 1 internal fn (start_log_stream); 3 external calls (new, new, spawn).


##### `DenialLogger::on_child_spawn`  (lines 46–50)

```
fn on_child_spawn(&mut self, child: &Child)
```

**Purpose**: Begins PID-tree tracking for the sandboxed child process once its OS PID is known. This lets later log parsing filter denials to the relevant process family.

**Data flow**: The method reads `child.id()`, and if a PID is available converts it to `i32` and stores `Some(PidTracker::new(...))` in `self.pid_tracker`. If the child has no PID yet or tracker creation fails, the field remains `None`.

**Call relations**: `run_command_under_sandbox` calls this immediately after spawning the Seatbelt child when denial logging is enabled. It delegates descendant tracking to `PidTracker::new`.

*Call graph*: calls 1 internal fn (new); 1 external calls (id).


##### `DenialLogger::finish`  (lines 52–84)

```
async fn finish(mut self) -> Vec<SandboxDenial>
```

**Purpose**: Stops PID tracking and log capture, parses the buffered log stream, and returns unique sandbox denials attributable to the tracked process tree. It is the logger's shutdown and extraction step.

**Data flow**: The method consumes `self`, awaits `tracker.stop()` if a tracker exists or uses an empty default set otherwise, and returns an empty vector immediately if no PIDs were tracked. It then kills and waits for the `log_stream`, awaits the `log_reader` handle to obtain buffered bytes, decodes them with `String::from_utf8_lossy`, and iterates over each line. For each line it attempts `serde_json::from_str::<serde_json::Value>`, extracts `eventMessage`, parses it with `parse_message`, checks membership in the tracked PID set, and inserts `(name, capability)` into a deduplication `HashSet`; newly seen pairs are pushed as `SandboxDenial` values into the output vector.

**Call relations**: The debug sandbox runner calls this after the Seatbelt child exits. It depends on `PidTracker::stop` for process scoping and `parse_message` for extracting structured denial data from each log line.

*Call graph*: calls 1 internal fn (parse_message); 6 external calls (kill, wait, default, new, from_utf8_lossy, new).


##### `start_log_stream`  (lines 87–100)

```
fn start_log_stream() -> Option<Child>
```

**Purpose**: Launches the macOS `log stream` subprocess configured to emit sandbox-related events as newline-delimited JSON. It encapsulates the exact command-line predicate and stdio setup.

**Data flow**: The function builds a `tokio::process::Command` for `log`, passes `stream --style ndjson --predicate <PREDICATE>`, sets stdin and stderr to null, stdout to piped, enables `kill_on_drop`, and attempts to spawn the child. It returns `Some(Child)` on success or `None` if spawning fails.

**Call relations**: Only `DenialLogger::new` calls this helper. It isolates the external-process setup from the rest of the logger initialization.

*Call graph*: called by 1 (new); 3 external calls (null, piped, new).


##### `parse_message`  (lines 102–114)

```
fn parse_message(msg: &str) -> Option<(i32, String, String)>
```

**Purpose**: Extracts `(pid, process name, capability)` from a sandbox denial message string using a lazily compiled regex. It converts free-form log text into the structured fields used by `SandboxDenial`.

**Data flow**: The function takes a message string, initializes a `OnceLock<regex_lite::Regex>` on first use with a pattern matching `Sandbox: name(pid) deny(...) capability`, applies it to the input, extracts the captured name, PID string, and capability, parses the PID as `i32`, and returns `Some((pid, name.to_string(), capability.to_string()))` or `None` if matching/parsing fails.

**Call relations**: `DenialLogger::finish` calls this for each candidate `eventMessage` extracted from the JSON log stream. It is purely a parser and does not interact with process tracking or I/O directly.

*Call graph*: called by 1 (finish); 1 external calls (new).


### `windows-sandbox-rs/src/bin/command_runner/win/cwd_junction.rs`

`util` · `child-process setup when selecting effective CWD`

This helper module encapsulates the junction-based working-directory workaround used by the elevated command runner. It derives a deterministic junction name by hashing the requested CWD’s lossy string form with `DefaultHasher`, then places the junction under `%USERPROFILE%\.codex\.sandbox\cwd`. That keeps junction paths stable across runs for the same requested directory while avoiding direct reuse of arbitrary path text in the filesystem.

`create_cwd_junction` is defensive and log-heavy. It first requires `USERPROFILE`; if absent it returns `None`. It ensures the junction root exists, then checks whether the target junction path already exists. Existing reparse points are reused immediately, while unexpected regular files or directories are logged and removed before recreation. Junction creation itself shells out to `cmd /c mklink /J` rather than using a direct API, because `mklink` is a `cmd.exe` builtin. The implementation uses `raw_arg` specifically to avoid Windows quoting issues when paths contain spaces; it prequotes the link and target paths and relies on the fact that Windows paths cannot contain literal quotes. On failure it logs command status plus captured stdout/stderr and returns `None` rather than raising an error.

#### Function details

##### `junction_name_for_path`  (lines 11–15)

```
fn junction_name_for_path(path: &Path) -> String
```

**Purpose**: Computes a deterministic hexadecimal junction name from a requested path.

**Data flow**: Accepts a `&Path`, converts it to a lossy string, hashes that string with `DefaultHasher`, formats the resulting `u64` hash as lowercase hexadecimal, and returns the `String`.

**Call relations**: Used by `create_cwd_junction` to derive the leaf name for the per-path junction.

*Call graph*: called by 1 (create_cwd_junction); 3 external calls (new, to_string_lossy, format!).


##### `junction_root_for_userprofile`  (lines 17–22)

```
fn junction_root_for_userprofile(userprofile: &str) -> PathBuf
```

**Purpose**: Builds the fixed directory under a user profile where CWD junctions are stored.

**Data flow**: Accepts the `USERPROFILE` string, converts it to a `PathBuf`, appends `.codex`, `.sandbox`, and `cwd`, and returns the resulting path.

**Call relations**: Called by `create_cwd_junction` before ensuring the junction root exists.

*Call graph*: called by 1 (create_cwd_junction); 1 external calls (from).


##### `create_cwd_junction`  (lines 24–140)

```
fn create_cwd_junction(requested_cwd: &Path, log_dir: Option<&Path>) -> Option<PathBuf>
```

**Purpose**: Creates or reuses a junction pointing at the requested working directory and returns the junction path on success.

**Data flow**: Accepts the requested CWD and optional log directory. It reads `USERPROFILE`, computes the junction root and hashed junction path, creates the root directory, reuses an existing reparse point if present, otherwise removes an unexpected existing directory and constructs quoted link/target strings. It then runs `cmd` with raw arguments for `/c mklink /J`, logs success or detailed failure output, and returns `Some(junction_path)` only when the command succeeds and the junction path exists.

**Call relations**: Called by `effective_cwd` in the runner when the ACL-helper mutex indicates the junction-based CWD path should be used.

*Call graph*: calls 2 internal fn (junction_name_for_path, junction_root_for_userprofile); called by 1 (effective_cwd); 9 external calls (to_string_lossy, from_utf8_lossy, new, log_note, format!, var, create_dir_all, remove_dir, symlink_metadata).


### `windows-sandbox-rs/src/bin/setup_main/win/read_acl_mutex.rs`

`util` · `background ACL refresh coordination`

This small module wraps a local named mutex, `Local\CodexSandboxReadAcl`, so the setup helper can avoid spawning or running multiple concurrent read-ACL refresh passes. The `ReadAclMutexGuard` type owns the raw `HANDLE` and releases the mutex plus closes the handle in its `Drop` implementation, making the lock lifetime explicit and exception-safe from Rust’s perspective.

`read_acl_mutex_exists` is a non-owning probe: it attempts `OpenMutexW` with `MUTEX_ALL_ACCESS`, interprets `ERROR_FILE_NOT_FOUND` as absence, closes any successfully opened handle immediately, and treats other Win32 errors as failures. `acquire_read_acl_mutex` uses `CreateMutexW` with initial ownership set to true; if `GetLastError` reports `ERROR_ALREADY_EXISTS`, it closes the returned handle and reports `Ok(None)` so callers can skip duplicate work. Otherwise it returns `Some(ReadAclMutexGuard)` and the caller holds exclusive ownership until the guard drops. The design intentionally distinguishes “someone else is already running” from “the mutex API itself failed,” which lets setup continue conservatively in some paths while still surfacing real OS errors.

#### Function details

##### `ReadAclMutexGuard::drop`  (lines 21–26)

```
fn drop(&mut self)
```

**Purpose**: Releases the named mutex and closes its handle when the guard goes out of scope.

**Data flow**: It reads the stored raw `HANDLE`, calls `ReleaseMutex`, then `CloseHandle`, and produces no return value.

**Call relations**: This destructor runs automatically after `run_read_acl_only` finishes or unwinds, ensuring the serialized read-ACL slot is freed.

*Call graph*: 2 external calls (CloseHandle, ReleaseMutex).


##### `read_acl_mutex_exists`  (lines 29–43)

```
fn read_acl_mutex_exists() -> Result<bool>
```

**Purpose**: Checks whether the named read-ACL mutex currently exists.

**Data flow**: It converts the fixed mutex name to UTF-16, calls `OpenMutexW`, and returns `Ok(false)` if the mutex is missing, `Ok(true)` if it can open and then close the handle, or an error for other Win32 failures.

**Call relations**: This probe is used by `run_setup_full` before spawning a detached read-ACL helper so it can skip spawning when another helper is already active.

*Call graph*: called by 1 (run_setup_full); 6 external calls (new, anyhow!, to_wide, CloseHandle, GetLastError, OpenMutexW).


##### `acquire_read_acl_mutex`  (lines 45–61)

```
fn acquire_read_acl_mutex() -> Result<Option<ReadAclMutexGuard>>
```

**Purpose**: Attempts to create and immediately own the named read-ACL mutex, reporting contention without treating it as an error.

**Data flow**: It converts the mutex name to UTF-16, calls `CreateMutexW` with initial ownership, checks for a zero handle as a hard failure, inspects `GetLastError`, and returns `Ok(None)` if the mutex already existed after closing the handle; otherwise it returns `Ok(Some(ReadAclMutexGuard { handle }))`.

**Call relations**: This acquisition path is used by `run_read_acl_only` to ensure only one helper instance performs the read-grant pass at a time.

*Call graph*: called by 1 (run_read_acl_only); 7 external calls (new, anyhow!, to_wide, null_mut, CloseHandle, GetLastError, CreateMutexW).


### `windows-sandbox-rs/src/env.rs`

`util` · `spawn preparation`

This file operates entirely on `HashMap<String, String>` environment maps and a small amount of filesystem state. The simplest helpers normalize Unix-ish values into Windows-safe ones: `normalize_null_device_env` scans every key/value pair and rewrites `/dev/null` or escaped `\\dev\\null` to `NUL`; `ensure_non_interactive_pager` inserts `GIT_PAGER=more.com`, `PAGER=more.com`, and `LESS=` only when absent; and `inherit_path_env` copies `PATH` and `PATHEXT` from the parent process if the caller did not provide them.

The no-network path is more involved. `ensure_denybin` creates a denybin directory—defaulting to `~/.sbx-denybin`—and writes tiny `.bat` and `.cmd` stubs for selected tools that simply `exit /b 1`. `prepend_path` then places that directory at the front of `PATH`, but only if it is not already first, preserving the rest of the path string. `reorder_pathext_for_stubs` moves `.BAT` and `.CMD` to the front of `PATHEXT` so Windows command resolution prefers the deny stubs over real `.exe` binaries.

`apply_no_network_to_env` combines these pieces: it marks the environment with `SBX_NONET_ACTIVE=1`, injects loopback blackhole proxy settings (`127.0.0.1:9`) for HTTP/HTTPS/ALL/Git, disables package-manager network access (`PIP_NO_INDEX`, `NPM_CONFIG_OFFLINE`, `CARGO_NET_OFFLINE`), blocks Git SSH via `cmd /c exit 1`, ensures deny stubs for `ssh` and `scp`, explicitly removes any `curl`/`wget` stubs if present, then updates `PATH` and `PATHEXT` so the stubs win during command lookup.

#### Function details

##### `normalize_null_device_env`  (lines 12–22)

```
fn normalize_null_device_env(env_map: &mut HashMap<String, String>)
```

**Purpose**: Rewrites environment values that refer to the Unix null device into the Windows null device name. This prevents child processes from inheriting unusable `/dev/null`-style values on Windows.

**Data flow**: It takes a mutable environment map, clones the current key set to avoid mutating during iteration, then for each key clones the current value, trims and lowercases it, and compares against `/dev/null` and the escaped `\\dev\\null` form. Matching values are replaced in-place with `NUL`; the function returns no value.

**Call relations**: It is called during both elevated and legacy spawn-context preparation before process launch. It is an early normalization step so later setup and child execution see Windows-native device names.

*Call graph*: called by 3 (run_windows_sandbox_capture_for_permission_profile, prepare_elevated_spawn_context_for_permissions, prepare_spawn_context_common).


##### `ensure_non_interactive_pager`  (lines 24–32)

```
fn ensure_non_interactive_pager(env_map: &mut HashMap<String, String>)
```

**Purpose**: Installs pager-related defaults that avoid interactive terminal behavior inside sandboxed commands. The chosen defaults favor simple Windows paging behavior and disable `less` features.

**Data flow**: It mutates the provided environment map by inserting `GIT_PAGER=more.com`, `PAGER=more.com`, and `LESS=` only when those keys are absent. Existing caller-provided values are preserved, and the function returns nothing.

**Call relations**: It is invoked by elevated and legacy spawn preparation paths after basic environment normalization. Its role is to keep Git and other pager-using tools from hanging on interactive pager expectations in non-interactive sandbox sessions.

*Call graph*: called by 3 (run_windows_sandbox_capture_for_permission_profile, prepare_elevated_spawn_context_for_permissions, prepare_spawn_context_common).


##### `inherit_path_env`  (lines 35–46)

```
fn inherit_path_env(env_map: &mut HashMap<String, String>)
```

**Purpose**: Copies `PATH` and `PATHEXT` from the parent process into the child environment when the caller did not specify them. This preserves normal Windows executable lookup semantics for sandboxed commands.

**Data flow**: It reads the mutable environment map and checks for missing `PATH` and `PATHEXT` keys. For each missing key it queries `std::env::var` from the current process and, if successful, inserts the retrieved string into `env_map`; it returns no value.

**Call relations**: It is used by elevated and legacy spawn-context builders when they want stable command lookup without forcing callers to pass through the full parent environment. It does not call other local helpers and serves as a bridge from process-global environment state into the explicit child map.

*Call graph*: called by 3 (run_windows_sandbox_capture_for_permission_profile, prepare_elevated_spawn_context_for_permissions, prepare_spawn_context_common); 1 external calls (var).


##### `prepend_path`  (lines 48–69)

```
fn prepend_path(env_map: &mut HashMap<String, String>, prefix: &str)
```

**Purpose**: Places a directory at the front of `PATH` unless it is already the first entry. This is used to make deny stubs resolve before real tools.

**Data flow**: It takes a mutable environment map and a path prefix string. The function reads `PATH` from the map or falls back to the parent process environment, splits it on `;`, compares the first segment case-insensitively to `prefix`, and if different constructs a new semicolon-separated path with `prefix` prepended and writes it back to `env_map`.

**Call relations**: It is a private helper used only by `apply_no_network_to_env`. Its output is paired with `reorder_pathext_for_stubs` so both directory order and extension order favor the generated stub scripts.

*Call graph*: called by 1 (apply_no_network_to_env); 1 external calls (new).


##### `reorder_pathext_for_stubs`  (lines 71–103)

```
fn reorder_pathext_for_stubs(env_map: &mut HashMap<String, String>)
```

**Purpose**: Reorders `PATHEXT` so `.BAT` and `.CMD` are searched before executable extensions like `.EXE`. This ensures Windows command lookup prefers the denybin script stubs.

**Data flow**: It reads `PATHEXT` from the environment map or parent environment, defaulting to `.COM;.EXE;.BAT;.CMD` if absent. The function splits the extension list, preserves original casing, finds `.BAT` and `.CMD` case-insensitively, moves those entries to the front while keeping all other extensions in original order, then writes the recombined semicolon-separated string back into `env_map`.

**Call relations**: It is a private helper called only from `apply_no_network_to_env`. It complements `prepend_path`: even if the denybin directory is first, Windows still needs `.bat`/`.cmd` to outrank `.exe` for the stubs to intercept bare command names.

*Call graph*: called by 1 (apply_no_network_to_env); 1 external calls (new).


##### `ensure_denybin`  (lines 105–124)

```
fn ensure_denybin(tools: &[&str], denybin_dir: Option<&Path>) -> Result<PathBuf>
```

**Purpose**: Creates a directory of failing wrapper scripts for selected tool names and returns its path. The wrappers are simple `.bat` and `.cmd` files that immediately exit with status 1.

**Data flow**: It accepts a slice of tool names and an optional directory path. If no directory is provided, it resolves the user's home directory and uses `~/.sbx-denybin`; it creates the directory, then for each tool and each of the `.bat` and `.cmd` extensions creates the file if missing and writes `@echo off\r\nexit /b 1\r\n`. It returns the resulting base `PathBuf` or an error if home lookup, directory creation, file creation, or writing fails.

**Call relations**: It is a private helper used by `apply_no_network_to_env` to materialize command stubs for network-sensitive tools. The returned directory is then inserted into `PATH` so those stubs become active.

*Call graph*: called by 1 (apply_no_network_to_env); 4 external calls (create, home_dir, format!, create_dir_all).


##### `apply_no_network_to_env`  (lines 126–177)

```
fn apply_no_network_to_env(env_map: &mut HashMap<String, String>) -> Result<()>
```

**Purpose**: Transforms an environment map into an offline/no-network configuration by setting proxy blackholes, package-manager offline flags, Git restrictions, and command stubs for selected tools. It is the highest-level environment mutation in this file.

**Data flow**: It mutates the provided environment map by inserting `SBX_NONET_ACTIVE=1` and a series of default-only keys: `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`, `PIP_NO_INDEX`, `PIP_DISABLE_PIP_VERSION_CHECK`, `NPM_CONFIG_OFFLINE`, `CARGO_NET_OFFLINE`, `GIT_HTTP_PROXY`, `GIT_HTTPS_PROXY`, `GIT_SSH_COMMAND`, and `GIT_ALLOW_PROTOCOLS`. It then calls `ensure_denybin` for `ssh` and `scp`, removes any existing `curl` and `wget` stub files from that directory, prepends the denybin directory to `PATH`, reorders `PATHEXT`, and returns `Ok(())` or any filesystem/home-resolution error encountered.

**Call relations**: It is called by the legacy spawn-context preparation path when network access must be blocked. Internally it orchestrates `ensure_denybin`, `prepend_path`, and `reorder_pathext_for_stubs` to make the environment-level network restrictions effective during command resolution.

*Call graph*: calls 3 internal fn (ensure_denybin, prepend_path, reorder_pathext_for_stubs); called by 1 (prepare_legacy_spawn_context); 2 external calls (format!, remove_file).


### `windows-sandbox-rs/src/path_normalization.rs`

`util` · `cross-cutting path comparison and key generation`

This file is intentionally tiny but important for path identity decisions elsewhere in the sandbox system. `canonicalize_path` wraps `dunce::canonicalize`, which is friendlier for Windows path handling than the standard library in some cases, but it deliberately falls back to `path.to_path_buf()` if canonicalization fails. That fallback means callers can still derive stable-enough keys even for paths that do not exist yet or cannot be resolved at the moment.

`canonical_path_key` builds on that by converting the canonical-or-original path into a normalized string key. After obtaining the `PathBuf`, it renders it with `to_string_lossy()`, replaces backslashes with forward slashes, and lowercases the entire string with `to_ascii_lowercase()`. The result is suitable for case-insensitive comparisons, capability SID derivation, root filtering, and deduplication logic elsewhere in the crate.

The included test demonstrates the intended invariant: a Windows-style path like `C:\Users\Dev\Repo` and a slash-style path like `c:/users/dev/repo` should normalize to the same key. The design choice here is pragmatic rather than perfect fidelity—favoring robust comparison semantics over preserving original path spelling.

#### Function details

##### `canonicalize_path`  (lines 4–6)

```
fn canonicalize_path(path: &Path) -> PathBuf
```

**Purpose**: Attempts to canonicalize a path and falls back to the original path when canonicalization fails. This gives callers a best-effort normalized `PathBuf` without making path existence a hard requirement.

**Data flow**: It takes `&Path`, calls `dunce::canonicalize(path)`, and returns the canonicalized `PathBuf` on success. If canonicalization returns an error, it instead clones the input path with `to_path_buf()` and returns that.

**Call relations**: It is used by path-comparison and ACL-planning code that wants normalized paths but must tolerate unresolved or not-yet-created paths. `canonical_path_key` builds directly on it.

*Call graph*: called by 6 (workspace_write_root_contains_path, workspace_write_root_specificity, plan_deny_read_acl_paths, canonical_path_key, apply_legacy_session_acl_rules, is_command_cwd_root); 1 external calls (canonicalize).


##### `canonical_path_key`  (lines 8–13)

```
fn canonical_path_key(path: &Path) -> String
```

**Purpose**: Converts a path into a case-insensitive, slash-normalized string key suitable for comparisons and map/set membership. It is the string-level normalization primitive used across the crate.

**Data flow**: It takes `&Path`, obtains a `PathBuf` from `canonicalize_path`, converts it to a lossy string, replaces `\` with `/`, lowercases the result with `to_ascii_lowercase()`, and returns the normalized `String`.

**Call relations**: It is called by capability SID derivation, writable-root filtering, deny-read logic, and other path-identity code. Its job is to collapse superficial Windows path spelling differences into a stable comparison key.

*Call graph*: calls 1 internal fn (canonicalize_path); called by 9 (audit_everyone_writable, workspace_cap_sid_for_cwd, workspace_write_cap_sid_for_root, writable_root_cap_sid_for_path, expand_user_profile_root_for, filter_sensitive_write_roots, filter_user_profile_root, is_user_profile_root_exclusion, user_profile_child_name).


##### `tests::canonical_path_key_normalizes_case_and_separators`  (lines 22–30)

```
fn canonical_path_key_normalizes_case_and_separators()
```

**Purpose**: Verifies that path keys are insensitive to drive-letter case and slash direction. It documents the normalization contract expected by callers.

**Data flow**: The test constructs two semantically equivalent paths with different casing and separators, calls `canonical_path_key` on both, and asserts that the resulting strings are equal.

**Call relations**: It directly validates `canonical_path_key`. This protects the crate's path-comparison assumptions from regressions in normalization behavior.

*Call graph*: 2 external calls (new, assert_eq!).


### `windows-sandbox-rs/src/sandbox_utils.rs`

`util` · `spawn/setup preparation`

This file contains two operational helpers and a private repository-discovery routine. `ensure_codex_home_exists` is intentionally minimal: it just creates the requested directory tree so later setup and spawn code can assume `CODEX_HOME` exists. The more interesting logic is around Git's `safe.directory` enforcement. Because sandboxed commands may run as a different Windows user than the repo owner, Git would normally reject operations in that repository as unsafe.

`find_git_worktree_root_for_safe_directory` walks upward from a starting path after canonicalization, looking for any `.git` entry. It treats both a `.git` directory and a `.git` file as sufficient because it only checks existence; that means linked worktrees are supported automatically. The walk stops at the filesystem root.

`inject_git_safe_directory` uses that root, if found, to append one more synthetic Git config entry into the environment using Git's `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_N`, and `GIT_CONFIG_VALUE_N` convention. It preserves any existing count by parsing `GIT_CONFIG_COUNT`, inserts `safe.directory`, normalizes the path to forward slashes, increments the count, and writes the updated variables back into the caller's `HashMap`. The tests cover both ordinary repositories and worktree-style `.git` files.

#### Function details

##### `find_git_worktree_root_for_safe_directory`  (lines 13–25)

```
fn find_git_worktree_root_for_safe_directory(start: &Path) -> Option<std::path::PathBuf>
```

**Purpose**: Searches upward from a starting directory to find the repository root that should be added to Git's `safe.directory` list. It accepts either a `.git` directory or a `.git` file as the repository marker.

**Data flow**: Takes `start: &Path`, canonicalizes it with `dunce::canonicalize`, then loops: if `cur.join(".git").exists()` it returns `Some(cur)`, otherwise it moves to `cur.parent()`; if there is no parent or the parent equals the current path, it returns `None`.

**Call relations**: This private helper is only used by `inject_git_safe_directory`. It isolates repository-root discovery from the environment mutation logic.

*Call graph*: called by 1 (inject_git_safe_directory); 1 external calls (canonicalize).


##### `ensure_codex_home_exists`  (lines 28–31)

```
fn ensure_codex_home_exists(p: &Path) -> Result<()>
```

**Purpose**: Creates the Codex home directory tree if it does not already exist. It gives callers a simple success/failure boundary before they write sandbox state under that root.

**Data flow**: Takes `p: &Path`, calls `std::fs::create_dir_all(p)`, and returns `Ok(())` on success or propagates the filesystem error via `anyhow::Result`.

**Call relations**: Multiple setup and spawn preparation paths call this before creating `.sandbox` subdirectories or other state. It does not delegate to any project-local helper.

*Call graph*: called by 4 (run_windows_sandbox_capture_for_permission_profile, prepare_elevated_spawn_context_for_permissions, prepare_spawn_context_common, run_windows_sandbox_legacy_preflight); 1 external calls (create_dir_all).


##### `inject_git_safe_directory`  (lines 36–51)

```
fn inject_git_safe_directory(env_map: &mut HashMap<String, String>, cwd: &Path)
```

**Purpose**: Adds a `safe.directory` Git config entry to the environment when the current working directory is inside a repository. This lets the sandbox user run Git in a repo owned by the primary user.

**Data flow**: Takes `env_map: &mut HashMap<String, String>` and `cwd: &Path`. It calls `find_git_worktree_root_for_safe_directory(cwd)`; if a root is found, it reads and parses `GIT_CONFIG_COUNT` from `env_map` defaulting to `0`, converts the repo path to a slash-normalized string, inserts `GIT_CONFIG_KEY_{n}=safe.directory` and `GIT_CONFIG_VALUE_{n}=<repo-path>`, increments the count, and writes the new `GIT_CONFIG_COUNT` back into the map. If no repo root is found, it leaves the environment unchanged.

**Call relations**: This helper is invoked by both legacy and elevated spawn preparation flows, as well as direct capture paths, whenever Git compatibility should be preserved. It depends on the repository-root finder to decide whether any injection is needed.

*Call graph*: calls 1 internal fn (find_git_worktree_root_for_safe_directory); called by 5 (run_windows_sandbox_capture_for_permission_profile, injects_safe_directory_for_git_directory, injects_worktree_root_for_gitfile, prepare_elevated_spawn_context_for_permissions, prepare_spawn_context_common); 1 external calls (format!).


##### `tests::safe_directory_value`  (lines 62–67)

```
fn safe_directory_value(path: &Path) -> String
```

**Purpose**: Normalizes a path into the exact slash-separated canonical string expected in `GIT_CONFIG_VALUE_n` during tests. It keeps assertions concise and consistent.

**Data flow**: Takes `path: &Path`, canonicalizes it, converts it to a lossy string, replaces backslashes with forward slashes, and returns the resulting `String`.

**Call relations**: Both test cases use this helper to build expected environment maps after calling `inject_git_safe_directory`.

*Call graph*: 1 external calls (canonicalize).


##### `tests::injects_safe_directory_for_git_directory`  (lines 70–89)

```
fn injects_safe_directory_for_git_directory()
```

**Purpose**: Verifies that a normal repository with a `.git` directory causes `inject_git_safe_directory` to add one `safe.directory` entry. It checks the exact environment variables written.

**Data flow**: Creates a temporary repo with `.git` and a nested subdirectory, initializes an empty `HashMap`, calls `inject_git_safe_directory` with the nested path, builds the expected `GIT_CONFIG_*` map using `safe_directory_value`, and asserts equality.

**Call relations**: This test exercises the standard repository-root discovery path through `find_git_worktree_root_for_safe_directory` and the environment mutation in `inject_git_safe_directory`.

*Call graph*: calls 1 internal fn (inject_git_safe_directory); 6 external calls (from, new, new, assert_eq!, create_dir_all, safe_directory_value).


##### `tests::injects_worktree_root_for_gitfile`  (lines 92–115)

```
fn injects_worktree_root_for_gitfile()
```

**Purpose**: Verifies that a repository represented by a `.git` file, as used by Git worktrees, is also recognized for `safe.directory` injection. It ensures the helper does not require `.git` to be a directory.

**Data flow**: Creates a temporary repo and nested directory, writes a `.git` file containing a worktree-style `gitdir:` line, initializes an empty environment map, calls `inject_git_safe_directory`, builds the expected `GIT_CONFIG_*` map using `safe_directory_value`, and asserts equality.

**Call relations**: This test specifically validates the `.exists()`-based repository detection in `find_git_worktree_root_for_safe_directory` as used by `inject_git_safe_directory`.

*Call graph*: calls 1 internal fn (inject_git_safe_directory); 7 external calls (from, new, new, assert_eq!, create_dir_all, write, safe_directory_value).


### `windows-sandbox-rs/src/ssh_config_dependencies.rs`

`util` · `setup root filtering`

This file implements a small SSH-config parser tailored to dependency discovery rather than full semantic evaluation. `ssh_config_dependency_paths` starts from `USERPROFILE/.ssh/config`, seeds the output with that path, and recursively walks included configs through `visit_config`. Recursion is bounded to depth 32 and guarded by a `visited` set keyed by canonicalized path to avoid loops through repeated includes or symlinks.

`visit_config` reads a config file line by line, tokenizes each directive with `directive`, and handles two categories: `Include`, whose arguments are expanded through `include_paths`, and a fixed set of path-bearing directives such as `IdentityFile`, `CertificateFile`, `ControlPath`, and known-hosts paths. Path arguments are resolved by `profile_path_arg`, which understands `~`, `%d`, and `${HOME}` forms, absolute paths, and optionally relative paths against `.ssh` for include patterns.

The parser is intentionally permissive and lightweight. `directive` supports both `key value` and `key=value` forms, strips empty arguments, and relies on `words` for shell-like tokenization with quotes, comments, and limited backslash escaping. `include_paths` expands glob patterns and silently ignores invalid patterns or unreadable files. The resulting dependency list is later used by setup filtering code to block access to top-level profile roots that contain SSH config dependencies.

#### Function details

##### `ssh_config_dependency_paths`  (lines 15–27)

```
fn ssh_config_dependency_paths(user_profile: &Path) -> Vec<PathBuf>
```

**Purpose**: Collects SSH config dependency paths rooted at `USERPROFILE/.ssh/config`, including recursively included config files and path-bearing directive targets. It returns the raw dependency path list used by setup filtering.

**Data flow**: Takes `user_profile: &Path`, computes `ssh_dir = user_profile.join(".ssh")`, initializes `paths` with `ssh_dir.join("config")`, calls `visit_config` on that config path with a fresh `HashSet` and depth `0`, and returns the accumulated `Vec<PathBuf>`.

**Call relations**: Setup filtering calls this before deciding whether a root should be excluded as an SSH config dependency root. It delegates all parsing and recursion to `visit_config`.

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

**Purpose**: Recursively parses one SSH config file, collecting included config files and path-valued directive targets. It is the core traversal routine for dependency discovery.

**Data flow**: Takes the current config `path`, `user_profile`, `ssh_dir`, mutable `visited` set, mutable output `paths`, and recursion `depth`. It returns immediately at depth 32, canonicalizes the path for cycle detection, skips already-visited files, reads the file to string, iterates over parsed `(key, args)` pairs from `directive`, and for `include` directives expands each argument with `include_paths`, pushes each included path into `paths`, and recursively visits it; for directives listed in `SSH_PROFILE_PATH_DIRECTIVES`, it resolves each argument with `profile_path_arg(..., None)` and pushes any resulting path into `paths`.

**Call relations**: This function is only called by `ssh_config_dependency_paths`. It delegates tokenization to `directive`, include expansion to `include_paths`, and path resolution to `profile_path_arg`.

*Call graph*: calls 2 internal fn (include_paths, profile_path_arg); called by 1 (ssh_config_dependency_paths); 2 external calls (canonicalize, read_to_string).


##### `include_paths`  (lines 72–81)

```
fn include_paths(arg: &str, user_profile: &Path, ssh_dir: &Path) -> Vec<PathBuf>
```

**Purpose**: Expands an SSH `Include` argument into concrete file paths using profile-aware path resolution and glob expansion. It silently ignores invalid patterns.

**Data flow**: Takes an include `arg`, `user_profile`, and `ssh_dir`. It resolves the argument to a pattern path with `profile_path_arg(arg, user_profile, Some(ssh_dir))`; if resolution fails it returns an empty vector. Otherwise it converts the pattern path to a slash-normalized string, runs `glob::glob(&pattern)`, returns an empty vector on glob parse failure, and otherwise collects successful matches into `Vec<PathBuf>`.

**Call relations**: `visit_config` calls this for each `Include` argument before recursing into matched config files.

*Call graph*: calls 1 internal fn (profile_path_arg); called by 1 (visit_config); 2 external calls (new, glob).


##### `directive`  (lines 83–105)

```
fn directive(line: &str) -> Option<(String, Vec<String>)>
```

**Purpose**: Parses one SSH config line into a directive key and argument list, supporting both whitespace-separated and `key=value` forms. It also strips empty arguments after normalization.

**Data flow**: Takes `line: &str`, tokenizes it with `words`, returns `None` if there are no tokens, then either splits the first token on `=` when present and non-empty to form `(key, args)` or treats the first token as the key and the remaining tokens as arguments, stripping a leading `=` from the first argument when needed and removing empty arguments. It returns `Some((String, Vec<String>))`.

**Call relations**: `visit_config` calls this on each line before deciding whether the directive contributes dependency paths.

*Call graph*: calls 1 internal fn (words); 1 external calls (new).


##### `words`  (lines 107–143)

```
fn words(line: &str) -> Vec<String>
```

**Purpose**: Tokenizes an SSH config line into shell-like words with support for quotes, comments, and limited backslash escaping. It is a lightweight lexer for `directive`.

**Data flow**: Takes `line: &str`, scans characters with a peekable iterator, accumulates the current token in `word`, tracks an optional active quote character, stops at `#` when not inside quotes, handles quote open/close, preserves or consumes backslashes depending on the next character and quoting state, emits tokens on unquoted whitespace, and returns the collected `Vec<String>`.

**Call relations**: This helper is only used by `directive` to split raw config lines into tokens.

*Call graph*: called by 1 (directive); 4 external calls (new, new, matches!, take).


##### `profile_path_arg`  (lines 145–173)

```
fn profile_path_arg(
    arg: &str,
    user_profile: &Path,
    relative_base: Option<&Path>,
) -> Option<PathBuf>
```

**Purpose**: Resolves an SSH config path argument into a concrete path, understanding home-directory shorthands and optional relative bases. It is shared by include expansion and path-directive handling.

**Data flow**: Takes `arg`, `user_profile`, and optional `relative_base`. It returns `None` for `none`, returns the profile root for `~`, `%d`, or `${HOME}`, expands prefixed forms like `~/`, `%d/`, and `${HOME}/` by joining the remainder onto `user_profile`, otherwise converts `arg` to `PathBuf` and returns it directly if absolute or joins it to `relative_base` when relative and a base is provided.

**Call relations**: Both `visit_config` and `include_paths` call this to normalize SSH config path arguments before collecting or globbing them.

*Call graph*: called by 2 (include_paths, visit_config); 3 external calls (join, to_path_buf, from).


##### `tests::collects_path_directive_profile_entries`  (lines 184–218)

```
fn collects_path_directive_profile_entries()
```

**Purpose**: Verifies that path-bearing SSH directives are parsed and resolved correctly, including quoted paths and multiple home-directory syntaxes. It checks the direct dependency collection path.

**Data flow**: Creates a temporary `.ssh/config` containing several path directives, calls `ssh_config_dependency_paths(home)`, normalizes returned paths with `slash_paths`, and asserts the exact expected list of config and resolved dependency paths.

**Call relations**: This test exercises `ssh_config_dependency_paths`, `visit_config`, `directive`, `words`, and `profile_path_arg` together on a single config file.

*Call graph*: 4 external calls (new, assert_eq!, create_dir_all, write).


##### `tests::recursively_collects_include_dependencies`  (lines 221–241)

```
fn recursively_collects_include_dependencies()
```

**Purpose**: Verifies that `Include` directives are expanded recursively and that dependencies from included files are collected. It checks the recursive traversal path.

**Data flow**: Creates a temporary `.ssh/config` with an `Include conf.d/*.conf` directive and an included file containing a `CertificateFile` directive, calls `ssh_config_dependency_paths(home)`, normalizes paths with `slash_paths`, and asserts the expected config, included file, and resolved certificate path list.

**Call relations**: This test specifically validates the `include_paths` and recursive `visit_config` behavior.

*Call graph*: 4 external calls (new, assert_eq!, create_dir_all, write).


##### `tests::slash_paths`  (lines 243–248)

```
fn slash_paths(paths: Vec<PathBuf>) -> Vec<PathBuf>
```

**Purpose**: Normalizes path separators to forward slashes for stable test assertions across Windows path spellings. It is a test-only formatting helper.

**Data flow**: Takes `Vec<PathBuf>`, converts each path to a lossy string, replaces backslashes with `/`, wraps each back into `PathBuf`, collects the results, and returns them.

**Call relations**: Both SSH dependency tests use this helper to compare expected paths independent of native separator style.


### `windows-sandbox-rs/src/winutil.rs`

`util` · `cross-cutting`

This file collects low-level Windows helpers that other modules reuse when talking to Win32 APIs. `to_wide` is the basic string bridge, converting any `OsStr`-like input into a null-terminated UTF-16 buffer suitable for `windows-sys` calls. For process creation, `quote_windows_arg` implements the same quoting and backslash rules used by `CommandLineToArgvW` and the CRT, and `argv_to_command_line` applies that quoting independently to each argument before joining with spaces; the tests focus on preserving embedded quotes and spaces correctly.

The file also wraps common diagnostics and SID operations. `format_last_error` uses `FormatMessageW` with `FORMAT_MESSAGE_ALLOCATE_BUFFER` to turn a numeric Win32 error code into a trimmed human-readable message, freeing the allocated buffer with `LocalFree`. `string_from_sid_bytes` converts raw SID bytes into the canonical string form via `ConvertSidToStringSidW`. `resolve_sid` resolves either a small set of built-in account names through hard-coded SID strings or arbitrary account names through `LookupAccountNameW`, including the standard retry loop for `ERROR_INSUFFICIENT_BUFFER` that resizes both SID and domain buffers until the call succeeds. `sid_bytes_from_string` performs the inverse conversion from SID string to owned bytes using `ConvertStringSidToSidW`, `GetLengthSid`, and `CopySid`, again taking care to free the temporary system allocation.

#### Function details

##### `to_wide`  (lines 19–23)

```
fn to_wide(s: S) -> Vec<u16>
```

**Purpose**: Converts an OS string into a null-terminated UTF-16 vector for Win32 APIs. It is the standard string-preparation helper used throughout the Windows codebase.

**Data flow**: Accepts any `S: AsRef<OsStr>`, reads the underlying `OsStr`, encodes it with `encode_wide()`, collects into `Vec<u16>`, appends a trailing `0`, and returns the vector.

**Call relations**: This helper is widely reused by many Windows-facing modules, including WFP setup and ACL code. It performs no I/O itself; it prepares data for later FFI calls.

*Call graph*: called by 21 (add_allow_ace, add_deny_ace, allow_null_device, ensure_allow_mask_aces_with_inheritance_impl, fetch_dacl_handle, revoke_ace, spawn_conpty_process_as_user, prepare, create, spawn_runner_transport (+11 more)); 1 external calls (as_ref).


##### `quote_windows_arg`  (lines 29–65)

```
fn quote_windows_arg(arg: &str) -> String
```

**Purpose**: Quotes one command-line argument according to Windows `CommandLineToArgvW`/CRT parsing rules. It preserves spaces, quotes, and trailing backslashes exactly as a child process will interpret them.

**Data flow**: Takes `arg: &str`, first determines whether quoting is needed based on emptiness or presence of whitespace/newlines/quotes. If not needed, it returns `arg.to_string()`. Otherwise it builds a new string with surrounding quotes, tracks runs of backslashes, doubles them before embedded quotes, emits literal characters otherwise, doubles trailing backslashes before the closing quote, and returns the quoted string.

**Call relations**: Used by `argv_to_command_line` to serialize each argument independently. It is a pure transformation helper with no external side effects.

*Call graph*: 1 external calls (with_capacity).


##### `argv_to_command_line`  (lines 69–74)

```
fn argv_to_command_line(argv: &[String]) -> String
```

**Purpose**: Builds a single Windows command-line string from an argv vector using correct per-argument quoting. This is intended for CreateProcess-style APIs that take one command-line buffer.

**Data flow**: Accepts `argv: &[String]`, maps each element through `quote_windows_arg`, collects the quoted pieces, joins them with spaces, and returns the resulting `String`.

**Call relations**: Called by process-spawning code such as `create_process_as_user`. It delegates all escaping semantics to `quote_windows_arg`.

*Call graph*: called by 1 (create_process_as_user).


##### `format_last_error`  (lines 77–103)

```
fn format_last_error(err: i32) -> String
```

**Purpose**: Formats a Win32 error code into a readable system message string, falling back to a numeric description when formatting fails. It encapsulates the awkward `FormatMessageW` allocation contract.

**Data flow**: Takes `err: i32`, allocates a `*mut u16` output pointer, calls `FormatMessageW` with allocate-buffer/system/ignore-inserts flags, and if no message is produced returns `format!("Win32 error {err}")`. Otherwise it builds a UTF-16 slice from the returned pointer and length, converts it with `String::from_utf16_lossy`, trims whitespace, frees the buffer with `LocalFree`, and returns the trimmed message.

**Call relations**: This helper is available for diagnostics across the Windows code. It directly wraps Win32 APIs and memory management but is itself a pure formatter from the caller's perspective.

*Call graph*: 7 external calls (from_utf16_lossy, format!, null, null_mut, from_raw_parts, LocalFree, FormatMessageW).


##### `string_from_sid_bytes`  (lines 105–124)

```
fn string_from_sid_bytes(sid: &[u8]) -> Result<String, String>
```

**Purpose**: Converts raw SID bytes into the canonical SID string representation such as `S-1-5-...`. It is useful for logging or naming resources based on a SID.

**Data flow**: Accepts `sid: &[u8]`, passes its pointer to `ConvertSidToStringSidW`, and on failure returns a `String` error containing `last_os_error()`. On success it scans the returned UTF-16 buffer to find the terminating null, converts that slice to `String`, frees the allocated string with `LocalFree`, and returns `Ok(out)`.

**Call relations**: Called by `create_named_pipe` according to the graph. It complements `resolve_sid` and `sid_bytes_from_string` by providing the reverse textual conversion.

*Call graph*: called by 1 (create_named_pipe); 6 external calls (from_utf16_lossy, format!, null_mut, from_raw_parts, LocalFree, ConvertSidToStringSidW).


##### `resolve_sid`  (lines 132–168)

```
fn resolve_sid(name: &str) -> Result<Vec<u8>>
```

**Purpose**: Resolves an account or group name into owned SID bytes, with fast paths for several well-known built-in names. It hides both the built-in SID mapping and the variable-size `LookupAccountNameW` retry loop.

**Data flow**: Takes `name: &str`. It first queries `well_known_sid_str(name)`; if present, it returns `sid_bytes_from_string` of that SID string. Otherwise it converts the name to UTF-16, initializes a SID buffer and empty domain buffer, then repeatedly calls `LookupAccountNameW`. On success it truncates the SID buffer to the returned length and returns it. If the call fails with `ERROR_INSUFFICIENT_BUFFER`, it resizes both buffers to the lengths requested by the API and retries. Any other error becomes an `anyhow` failure mentioning the account name and raw error code.

**Call relations**: Used by `create_named_pipe` when it needs a SID for an account name. It delegates built-in-name handling to `well_known_sid_str` and SID-string parsing to `sid_bytes_from_string`.

*Call graph*: calls 3 internal fn (sid_bytes_from_string, to_wide, well_known_sid_str); called by 1 (create_named_pipe); 7 external calls (new, new, anyhow!, null, vec!, GetLastError, LookupAccountNameW).


##### `well_known_sid_str`  (lines 170–179)

```
fn well_known_sid_str(name: &str) -> Option<&'static str>
```

**Purpose**: Maps a small fixed set of common Windows principal names to their SID strings. This avoids account lookup for names whose SID is stable across systems.

**Data flow**: Accepts `name: &str` and returns `Option<&'static str>` by matching exact names like `Administrators`, `Users`, `Authenticated Users`, `Everyone`, and `SYSTEM` to the corresponding SID constants.

**Call relations**: Called only by `resolve_sid` as its first resolution step. It is a pure lookup table.

*Call graph*: called by 1 (resolve_sid).


##### `sid_bytes_from_string`  (lines 181–206)

```
fn sid_bytes_from_string(sid_str: &str) -> Result<Vec<u8>>
```

**Purpose**: Parses a SID string into an owned byte vector. It wraps the Win32 conversion API and copies the result out of the system-allocated SID buffer.

**Data flow**: Takes `sid_str: &str`, converts it to UTF-16 with `to_wide`, calls `ConvertStringSidToSidW` to obtain a temporary SID pointer, then calls `GetLengthSid` to determine its size. If length is zero it frees the temporary SID and returns an error. Otherwise it allocates `Vec<u8>` of that length, copies the SID bytes with `CopySid`, frees the temporary SID with `LocalFree`, and returns the copied bytes or an error if `CopySid` failed.

**Call relations**: Used by `resolve_sid` for well-known SID strings. It is the inverse of `string_from_sid_bytes` at the byte/string boundary.

*Call graph*: calls 1 internal fn (to_wide); called by 1 (resolve_sid); 8 external calls (new, anyhow!, null_mut, vec!, LocalFree, ConvertStringSidToSidW, CopySid, GetLengthSid).


##### `tests::argv_to_command_line_quotes_each_argument_independently`  (lines 214–226)

```
fn argv_to_command_line_quotes_each_argument_independently()
```

**Purpose**: Checks that a pre-quoted inner command passed as one argv element is itself quoted as a single argument rather than split. This guards against accidental flattening of nested command strings.

**Data flow**: Builds a sample argv vector containing `cmd.exe`, `/c`, and a PowerShell command string with embedded quotes, calls `argv_to_command_line`, and asserts the exact expected serialized command line.

**Call relations**: This test exercises the interaction between `argv_to_command_line` and `quote_windows_arg` for nested quoting scenarios.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `tests::argv_to_command_line_quotes_regular_program_args`  (lines 229–240)

```
fn argv_to_command_line_quotes_regular_program_args()
```

**Purpose**: Checks ordinary quoting of an argument containing spaces and embedded quotes. It verifies the helper matches expected Windows escaping behavior for common command invocations.

**Data flow**: Constructs a simple argv vector for `pwsh.exe -Command 'Write-Output "hello world"'`, calls `argv_to_command_line`, and asserts the exact expected output string.

**Call relations**: This test covers the standard path through `argv_to_command_line` and `quote_windows_arg`.

*Call graph*: 2 external calls (assert_eq!, vec!).
