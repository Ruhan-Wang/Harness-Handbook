# Generic string, formatting, truncation, and templating utilities  `stage-22.2.1`

This stage is shared behind-the-scenes support for turning raw values into clear, safe text. It is not the app’s main work loop by itself. Instead, many other parts call it when they need to show numbers, times, commands, search details, or shortened content to a person or another system.

Several files focus on formatting. Number and duration helpers turn values into readable forms like grouped digits, short “1.2k” styles, or compact elapsed times. CLI helpers build stable display strings for environment settings without leaking secrets, and generate consistent “resume” command hints. The web search formatter turns different kinds of search actions into one short description.

Another group focuses on shrinking text safely. Truncation utilities cut long strings in the middle without breaking UTF-8, the text encoding used for Unicode characters. There are byte-based and rough token-based budgets, plus extra helpers for truncating function output and response history.

The rest are text cleanup tools: strict templates with {{name}} placeholders, ASCII-only JSON output using \uXXXX escapes, TUI text shaping, and small string utilities like safe slicing and UUID extraction. Together, these parts make text output consistent, compact, and dependable.

## Files in this stage

### Core string utilities
These files define the shared string helper surface, including ASCII-safe JSON emission and UTF-8-safe truncation primitives that other callers can build on.

### `utils/string/src/json.rs`

`io_transport` · `serialization/output`

This file customizes `serde_json` string emission rather than reimplementing JSON serialization wholesale. The private `AsciiJsonFormatter` implements `serde_json::ser::Formatter`, overriding only `write_string_fragment`. That method scans each string fragment by `char_indices`, writes contiguous ASCII spans directly to the output writer, and rewrites every non-ASCII scalar value into one or two UTF-16 code units using `encode_utf16`, formatting each code unit as a lowercase `\uXXXX` escape. This means ordinary JSON escaping remains under `serde_json`’s control, while the formatter only adds ASCII enforcement for string contents.

The public `to_ascii_json_string` function serializes any `T: Serialize` into a `Vec<u8>` using `serde_json::Serializer::with_formatter` and the custom formatter, then converts the resulting bytes into a `String`. The final `String::from_utf8` should succeed because the formatter emits only ASCII and `serde_json` itself writes valid UTF-8, but the code still maps any unexpected UTF-8 conversion failure into a `serde_json::Error` with `io::ErrorKind::InvalidData`.

The included test demonstrates several important properties at once: object keys and values containing non-ASCII text are escaped, supplementary-plane characters like emoji become surrogate-pair escapes, the resulting string is entirely ASCII, and parsing the serialized output back with `serde_json::from_str` reconstructs the original JSON value exactly.

#### Function details

##### `AsciiJsonFormatter::write_string_fragment`  (lines 13–39)

```
fn write_string_fragment(&mut self, writer: &mut W, fragment: &str) -> io::Result<()>
```

**Purpose**: Writes one JSON string fragment to the serializer output while escaping every non-ASCII character as UTF-16 `\uXXXX` sequences. It preserves ASCII runs verbatim for efficiency.

**Data flow**: It takes a mutable writer and a `fragment: &str`, scans the fragment by character boundaries, writes any ASCII byte ranges directly with `write_all`, and for each non-ASCII `char` encodes it into one or two UTF-16 code units and writes each as `\u{code_unit:04x}`. It returns `io::Result<()>` and mutates only the provided writer.

**Call relations**: This method is invoked by `serde_json` during string serialization when `AsciiJsonFormatter` is installed. It deliberately leaves all non-string JSON formatting to the serializer and only customizes string-fragment emission.

*Call graph*: 2 external calls (write_all, write!).


##### `to_ascii_json_string`  (lines 46–55)

```
fn to_ascii_json_string(value: &T) -> serde_json::Result<String>
```

**Purpose**: Serializes any `serde::Serialize` value into a JSON string whose string contents are ASCII-safe via Unicode escapes. It is the public entry point for callers that need JSON over ASCII-only channels.

**Data flow**: It takes a serializable `value`, creates a `Vec<u8>` buffer and a `serde_json::Serializer` configured with `AsciiJsonFormatter`, calls `value.serialize(&mut serializer)?`, then converts the byte buffer into a `String` with `String::from_utf8`. On UTF-8 conversion failure it wraps the error as `serde_json::Error::io(...)`; otherwise it returns the serialized JSON string.

**Call relations**: This function is called by tests and by any higher-level code needing ASCII-safe JSON output. It delegates structural serialization to `serde_json` and character escaping policy to `AsciiJsonFormatter::write_string_fragment`.

*Call graph*: called by 1 (to_ascii_json_string_escapes_non_ascii_strings); 4 external calls (from_utf8, serialize, new, with_formatter).


##### `tests::to_ascii_json_string_escapes_non_ascii_strings`  (lines 70–121)

```
fn to_ascii_json_string_escapes_non_ascii_strings()
```

**Purpose**: Validates that ASCII-safe serialization escapes non-ASCII keys and values, preserves JSON semantics, and produces output that remains parseable. It covers BMP characters and surrogate-pair emoji escapes.

**Data flow**: The test defines custom `Serialize` implementations for nested payload structs containing non-ASCII path, label, and emoji strings, serializes them with `to_ascii_json_string`, asserts the exact escaped JSON string, checks `is_ascii()` and absence of raw non-ASCII substrings, parses the result back into `serde_json::Value`, and compares it to the expected JSON value.

**Call relations**: It exercises the full public API through `to_ascii_json_string`, indirectly driving `AsciiJsonFormatter::write_string_fragment` via `serde_json`’s serializer.

*Call graph*: calls 1 internal fn (to_ascii_json_string); 4 external calls (assert!, assert_eq!, json!, from_str).


### `utils/string/src/truncate.rs`

`util` · `cross-cutting`

This module provides the actual truncation logic re-exported by the string crate. The public entry points are `truncate_middle_chars`, which truncates to a byte budget while reporting removed character count in the marker, and `truncate_middle_with_token_budget`, which converts an approximate token budget into bytes and reports the original approximate token count when truncation occurs. Both route through the private `truncate_with_byte_estimate`.

The truncation algorithm preserves a prefix and suffix of the original string and inserts a marker like `…21 chars truncated…` or `…8 tokens truncated…` in the middle. It is careful about UTF-8 boundaries: `split_budget` divides the byte budget between left and right sides, and `split_string` walks `char_indices` to choose the largest prefix within the left budget and the earliest suffix starting within the right-side tail target, counting removed characters in between. If the budgets overlap, `split_string` clamps the suffix start so the output never duplicates overlapping bytes. Empty strings and zero budgets are handled explicitly, with zero budget producing only the truncation marker.

Approximate token accounting is intentionally simple and byte-based: `APPROX_BYTES_PER_TOKEN` is fixed at 4, `approx_token_count` rounds string length up to that granularity, `approx_bytes_for_tokens` multiplies tokens by 4 with saturation, and `approx_tokens_from_byte_count` performs the inverse rounded-up conversion. `removed_units` chooses whether the marker count is based on removed characters or approximate removed tokens, and `assemble_truncated_output` preallocates enough capacity for prefix, marker, and suffix before concatenating them.

#### Function details

##### `truncate_middle_chars`  (lines 7–9)

```
fn truncate_middle_chars(s: &str, max_bytes: usize) -> String
```

**Purpose**: Truncates a string to a byte budget by preserving the beginning and end and inserting a marker that reports removed character count. It is the simpler public truncation API.

**Data flow**: It takes `s: &str` and `max_bytes: usize`, passes them to `truncate_with_byte_estimate` with `use_tokens` set to `false`, and returns the resulting `String`.

**Call relations**: This is a thin wrapper over `truncate_with_byte_estimate`, used when callers want character-count wording in the truncation marker rather than token-based wording.

*Call graph*: calls 1 internal fn (truncate_with_byte_estimate).


##### `truncate_middle_with_token_budget`  (lines 15–36)

```
fn truncate_middle_with_token_budget(s: &str, max_tokens: usize) -> (String, Option<u64>)
```

**Purpose**: Truncates a string according to an approximate token budget and reports the original approximate token count when truncation actually happened. It is intended for LLM-style token budgeting without exact tokenization.

**Data flow**: It takes `s` and `max_tokens`. It returns `(String::new(), None)` for empty input, returns the original string and `None` when the string length already fits within `approx_bytes_for_tokens(max_tokens)`, otherwise truncates via `truncate_with_byte_estimate(..., use_tokens = true)`, computes `total_tokens` from `approx_token_count(s)` converted to `u64`, and returns either `(truncated, None)` if no change occurred or `(truncated, Some(total_tokens))` if truncation did occur.

**Call relations**: This public API orchestrates the token-budget path by delegating byte conversion to `approx_bytes_for_tokens`, truncation to `truncate_with_byte_estimate`, and token counting to `approx_token_count`.

*Call graph*: calls 3 internal fn (approx_bytes_for_tokens, approx_token_count, truncate_with_byte_estimate); 2 external calls (new, try_from).


##### `truncate_with_byte_estimate`  (lines 38–69)

```
fn truncate_with_byte_estimate(s: &str, max_bytes: usize, use_tokens: bool) -> String
```

**Purpose**: Performs the core middle-truncation algorithm for both byte-budget and token-budget modes. It computes preserved prefix/suffix slices, the truncation marker, and the final assembled output.

**Data flow**: It takes `s`, `max_bytes`, and `use_tokens`. It returns an empty `String` for empty input, returns only a formatted marker when `max_bytes == 0`, returns `s.to_string()` when the input already fits, otherwise computes total bytes/chars, splits the budget with `split_budget`, splits the string with `split_string`, computes removed units with `removed_units`, formats the marker with `format_truncation_marker`, assembles the final string with `assemble_truncated_output`, and returns it.

**Call relations**: This private function is the shared implementation behind `truncate_middle_chars` and `truncate_middle_with_token_budget`. It delegates all sub-decisions—budget splitting, UTF-8-safe slicing, removed-count calculation, marker formatting, and final concatenation—to dedicated helpers.

*Call graph*: calls 5 internal fn (assemble_truncated_output, format_truncation_marker, removed_units, split_budget, split_string); called by 2 (truncate_middle_chars, truncate_middle_with_token_budget); 1 external calls (new).


##### `approx_token_count`  (lines 71–74)

```
fn approx_token_count(text: &str) -> usize
```

**Purpose**: Estimates token count from byte length using a fixed 4-bytes-per-token heuristic. It rounds up so any nonzero remainder counts as another token.

**Data flow**: It takes `text: &str`, reads `text.len()`, applies saturating arithmetic to compute `(len + 3) / 4`, and returns the resulting `usize`.

**Call relations**: This helper is used by `truncate_middle_with_token_budget` to report the original approximate token count when truncation occurs.

*Call graph*: called by 1 (truncate_middle_with_token_budget).


##### `approx_bytes_for_tokens`  (lines 76–78)

```
fn approx_bytes_for_tokens(tokens: usize) -> usize
```

**Purpose**: Converts an approximate token budget into a byte budget using the same fixed 4-bytes-per-token heuristic. It saturates on overflow.

**Data flow**: It takes `tokens: usize`, multiplies by `APPROX_BYTES_PER_TOKEN` with `saturating_mul`, and returns the resulting byte budget.

**Call relations**: This helper is used by `truncate_middle_with_token_budget` both for the early-fit check and for the actual truncation budget.

*Call graph*: called by 1 (truncate_middle_with_token_budget).


##### `approx_tokens_from_byte_count`  (lines 80–84)

```
fn approx_tokens_from_byte_count(bytes: usize) -> u64
```

**Purpose**: Estimates how many tokens correspond to a byte count using the same rounded-up 4-byte heuristic. It is the inverse-style helper for removed-byte accounting.

**Data flow**: It takes `bytes: usize`, casts to `u64`, computes `(bytes + 3) / 4` with saturation, and returns the result as `u64`.

**Call relations**: This helper is called by `removed_units` when token-based truncation markers need to describe how many approximate tokens were removed.

*Call graph*: called by 1 (removed_units).


##### `split_string`  (lines 86–124)

```
fn split_string(s: &str, beginning_bytes: usize, end_bytes: usize) -> (usize, &str, &str)
```

**Purpose**: Splits a string into a preserved prefix and suffix under separate byte budgets while counting how many whole characters are removed between them. It respects UTF-8 boundaries and avoids overlapping output slices.

**Data flow**: It takes `s`, `beginning_bytes`, and `end_bytes`. For empty input it returns `(0, "", "")`; otherwise it computes the target tail start, walks `s.char_indices()`, extends `prefix_end` while characters fit in the prefix budget, marks `suffix_start` once indices reach the tail region, counts removed middle characters, clamps `suffix_start` to at least `prefix_end`, slices `before` and `after` from `s`, and returns `(removed_chars, before, after)`.

**Call relations**: This helper is called only by `truncate_with_byte_estimate`. It encapsulates the UTF-8-aware slicing logic that determines exactly what content survives on each side of the truncation marker.

*Call graph*: called by 1 (truncate_with_byte_estimate).


##### `split_budget`  (lines 126–129)

```
fn split_budget(budget: usize) -> (usize, usize)
```

**Purpose**: Divides a total byte budget between the left and right preserved portions of a truncated string. It gives the extra byte, when odd, to the right side.

**Data flow**: It takes `budget: usize`, computes `left = budget / 2`, and returns `(left, budget - left)`.

**Call relations**: This helper is used by `truncate_with_byte_estimate` before calling `split_string`, keeping budget partitioning separate from string slicing.

*Call graph*: called by 1 (truncate_with_byte_estimate).


##### `format_truncation_marker`  (lines 131–137)

```
fn format_truncation_marker(use_tokens: bool, removed_count: u64) -> String
```

**Purpose**: Builds the human-readable marker inserted between preserved prefix and suffix. The wording changes depending on whether truncation is measured in chars or approximate tokens.

**Data flow**: It takes `use_tokens` and `removed_count`, formats either `…{removed_count} tokens truncated…` or `…{removed_count} chars truncated…`, and returns the resulting `String`.

**Call relations**: This helper is called by `truncate_with_byte_estimate` after removed-unit calculation so marker wording stays centralized and consistent.

*Call graph*: called by 1 (truncate_with_byte_estimate); 1 external calls (format!).


##### `removed_units`  (lines 139–145)

```
fn removed_units(use_tokens: bool, removed_bytes: usize, removed_chars: usize) -> u64
```

**Purpose**: Chooses the numeric quantity reported in the truncation marker based on mode: removed characters for char mode or approximate removed tokens for token mode. It also handles integer conversion safely.

**Data flow**: It takes `use_tokens`, `removed_bytes`, and `removed_chars`. In token mode it returns `approx_tokens_from_byte_count(removed_bytes)`; otherwise it converts `removed_chars` to `u64`, falling back to `u64::MAX` on overflow.

**Call relations**: This helper is used by `truncate_with_byte_estimate` to decouple marker accounting from the slicing algorithm.

*Call graph*: calls 1 internal fn (approx_tokens_from_byte_count); called by 1 (truncate_with_byte_estimate); 1 external calls (try_from).


##### `assemble_truncated_output`  (lines 147–153)

```
fn assemble_truncated_output(prefix: &str, suffix: &str, marker: &str) -> String
```

**Purpose**: Concatenates the preserved prefix, truncation marker, and preserved suffix into the final output string. It preallocates capacity to avoid unnecessary reallocations.

**Data flow**: It takes `prefix`, `suffix`, and `marker`, allocates a `String` with capacity equal to the combined lengths plus one extra byte, pushes the three parts in order, and returns the assembled string.

**Call relations**: This is the final assembly step called by `truncate_with_byte_estimate` once all truncation decisions have been made.

*Call graph*: called by 1 (truncate_with_byte_estimate); 1 external calls (with_capacity).


### `utils/string/src/lib.rs`

`util` · `cross-cutting`

This module is the crate root for `utils/string`. It re-exports the JSON serializer helper and the truncation utilities from sibling modules, then defines a handful of independent string helpers used elsewhere in the system.

`take_bytes_at_char_boundary` is a low-level UTF-8-safe slicer: given a byte budget, it returns either the original `&str` or the longest prefix whose end lands on a character boundary. It walks `char_indices` and never returns an invalid UTF-8 slice. `sanitize_metric_tag_value` converts arbitrary text into a metrics-safe tag value by preserving only ASCII alphanumerics plus `.`, `_`, `-`, and `/`, replacing everything else with `_`, trimming leading/trailing underscores, and falling back to `"unspecified"` if the result is empty or contains no ASCII alphanumeric characters. It also caps the final string at 256 bytes by slicing the already-ASCII sanitized string.

`find_uuids` lazily initializes a compiled `regex_lite::Regex` in a `OnceLock` and returns every substring matching the canonical 8-4-4-4-12 hexadecimal UUID pattern. `normalize_markdown_hash_location_suffix` converts GitHub-style fragments like `#L74C3-L76C9` into terminal-friendly `:74:3-76:9` syntax. It strips the leading `#`, splits optional ranges on `-`, parses each point with the private `parse_markdown_hash_location_point`, and rebuilds the normalized suffix. Parsing is intentionally permissive about numeric validation: it only enforces the `L...` and optional `C...` shape, returning `None` when the fragment does not match that structure.

#### Function details

##### `take_bytes_at_char_boundary`  (lines 13–26)

```
fn take_bytes_at_char_boundary(s: &str, maxb: usize) -> &str
```

**Purpose**: Returns the longest prefix of a string that fits within a byte limit without cutting through a UTF-8 code point. It is a safe alternative to raw byte slicing.

**Data flow**: It takes `s: &str` and `maxb: usize`. If `s.len() <= maxb`, it returns `s` unchanged; otherwise it iterates `s.char_indices()`, tracks the last character end offset not exceeding `maxb`, and returns `&s[..last_ok]`.

**Call relations**: This is a standalone helper intended for callers that need byte-budgeted prefixes while preserving UTF-8 validity. It does not delegate to other local functions.


##### `sanitize_metric_tag_value`  (lines 30–51)

```
fn sanitize_metric_tag_value(value: &str) -> String
```

**Purpose**: Transforms arbitrary input into a metric tag value restricted to ASCII alphanumerics plus `.`, `_`, `-`, and `/`. It also normalizes degenerate results to `"unspecified"` and enforces a maximum length.

**Data flow**: It takes `value: &str`, maps each character to itself if allowed or to `'_'` otherwise, collects the result into `sanitized`, trims leading and trailing underscores into `trimmed`, and then returns either `"unspecified"`, `trimmed.to_string()`, or the first 256 bytes of `trimmed` as a new `String`.

**Call relations**: This helper is used wherever external strings must satisfy metric tag validation rules. Its logic is self-contained and relies on the invariant that the post-mapping string is ASCII, making the final byte truncation safe.


##### `find_uuids`  (lines 55–65)

```
fn find_uuids(s: &str) -> Vec<String>
```

**Purpose**: Finds all substrings in the input that match the canonical hexadecimal UUID textual form. It returns each match as an owned `String` in encounter order.

**Data flow**: It takes `s: &str`, initializes or reuses a static `OnceLock<regex_lite::Regex>` containing the UUID pattern, runs `find_iter(s)`, converts each match to `String`, collects them into a `Vec<String>`, and returns it.

**Call relations**: This is a reusable extraction helper for any code that needs to scan free-form text for UUIDs. It encapsulates regex compilation behind `OnceLock` so repeated calls reuse the same compiled pattern.

*Call graph*: 1 external calls (new).


##### `normalize_markdown_hash_location_suffix`  (lines 69–92)

```
fn normalize_markdown_hash_location_suffix(suffix: &str) -> Option<String>
```

**Purpose**: Converts markdown-style line or line-column fragments into a colon-based terminal location suffix. It supports both single points and ranges.

**Data flow**: It takes `suffix: &str`, strips a leading `#`, splits the remainder once on `-` into start and optional end fragments, parses each point with `parse_markdown_hash_location_point`, then builds and returns `Some(String)` in the form `:line[:column][-line[:column]]`; any parse failure returns `None`.

**Call relations**: This is the public normalization entry point and delegates point-shape parsing to `parse_markdown_hash_location_point`. Callers use it when translating markdown anchor syntax into terminal/editor-friendly location strings.

*Call graph*: calls 1 internal fn (parse_markdown_hash_location_point); 1 external calls (from).


##### `parse_markdown_hash_location_point`  (lines 94–100)

```
fn parse_markdown_hash_location_point(point: &str) -> Option<(&str, Option<&str>)>
```

**Purpose**: Parses one markdown location point of the form `Lline` or `LlineCcolumn`. It extracts the line and optional column substrings without validating that they are numeric.

**Data flow**: It takes `point: &str`, requires and strips a leading `'L'`, then splits once on `'C'`. It returns `Some((line, Some(column)))`, `Some((line, None))`, or `None` if the leading `L` is missing.

**Call relations**: This private helper is called only from `normalize_markdown_hash_location_suffix`. It isolates the fragment-shape parsing so the public function can focus on range handling and output formatting.

*Call graph*: called by 1 (normalize_markdown_hash_location_suffix).


##### `tests::find_uuids_finds_multiple`  (lines 111–121)

```
fn find_uuids_finds_multiple()
```

**Purpose**: Checks that UUID extraction returns multiple valid UUID substrings from one input string. It verifies ordering and exact match boundaries.

**Data flow**: The test defines an input containing two UUIDs embedded in surrounding text and asserts that `find_uuids(input)` returns a two-element vector with those exact UUID strings.

**Call relations**: It exercises the positive path of `find_uuids`, confirming the regex finds repeated matches in one scan.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::find_uuids_ignores_invalid`  (lines 124–127)

```
fn find_uuids_ignores_invalid()
```

**Purpose**: Verifies that malformed UUID-like text does not produce false-positive matches. It protects the regex against overmatching invalid shapes.

**Data flow**: The test passes a nonconforming UUID-like string to `find_uuids` and asserts that the returned vector is empty.

**Call relations**: It covers the negative path of `find_uuids`, complementing the multiple-match test.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::find_uuids_handles_non_ascii_without_overlap`  (lines 130–136)

```
fn find_uuids_handles_non_ascii_without_overlap()
```

**Purpose**: Checks that UUID matching works correctly in the presence of preceding non-ASCII characters and stops at the canonical UUID length. It guards against byte/character indexing issues and overlong matches.

**Data flow**: The test supplies a string beginning with an emoji followed by an overlong hexadecimal run and asserts that `find_uuids` returns only the first canonical-length UUID substring.

**Call relations**: It exercises `find_uuids` on mixed Unicode input, validating that regex matching remains correct without overlap into trailing hex characters.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::sanitize_metric_tag_value_trims_and_fills_unspecified`  (lines 139–142)

```
fn sanitize_metric_tag_value_trims_and_fills_unspecified()
```

**Purpose**: Verifies that a sanitized value containing no ASCII alphanumeric characters falls back to `"unspecified"`. It covers the degenerate-output branch.

**Data flow**: The test passes `"///"` to `sanitize_metric_tag_value` and asserts that the returned string is `"unspecified"`.

**Call relations**: It targets the post-trimming validation logic in `sanitize_metric_tag_value`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::sanitize_metric_tag_value_replaces_invalid_chars`  (lines 145–148)

```
fn sanitize_metric_tag_value_replaces_invalid_chars()
```

**Purpose**: Checks that invalid metric-tag characters are replaced with underscores and trimmed appropriately. It demonstrates the normal sanitization path.

**Data flow**: The test passes `"bad value!"` to `sanitize_metric_tag_value` and asserts that the result is `"bad_value"`.

**Call relations**: It exercises the character-mapping and trimming behavior of `sanitize_metric_tag_value`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::normalize_markdown_hash_location_suffix_converts_single_location`  (lines 151–156)

```
fn normalize_markdown_hash_location_suffix_converts_single_location()
```

**Purpose**: Verifies conversion of a single markdown line-column fragment into colon syntax. It covers the simplest successful normalization case.

**Data flow**: The test calls `normalize_markdown_hash_location_suffix("#L74C3")` and asserts that it returns `Some(":74:3".to_string())`.

**Call relations**: It exercises the single-point path through `normalize_markdown_hash_location_suffix` and `parse_markdown_hash_location_point`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::normalize_markdown_hash_location_suffix_converts_ranges`  (lines 159–164)

```
fn normalize_markdown_hash_location_suffix_converts_ranges()
```

**Purpose**: Verifies conversion of a markdown range fragment into colon-based range syntax. It confirms that both endpoints are parsed and formatted correctly.

**Data flow**: The test calls `normalize_markdown_hash_location_suffix("#L74C3-L76C9")` and asserts that it returns `Some(":74:3-76:9".to_string())`.

**Call relations**: It exercises the range-handling branch in `normalize_markdown_hash_location_suffix`, including two calls to `parse_markdown_hash_location_point`.

*Call graph*: 1 external calls (assert_eq!).


### Formatting and presentation helpers
These utilities format values and user-facing text into concise, readable display strings across durations, numbers, environment settings, resume hints, and web-search action details.

### `protocol/src/num_format.rs`

`util` · `cross-cutting formatting`

This utility module wraps ICU decimal formatting behind a small API tailored to Codex UI needs. `make_local_formatter` tries to discover the current system locale via `sys_locale::get_locale`, parse it into an ICU `Locale`, and build a `DecimalFormatter`; any failure returns `None`. `make_en_us_formatter` is the guaranteed fallback and intentionally panics only if the hard-coded `en-US` locale is somehow invalid. `formatter()` stores the chosen formatter in a `OnceLock`, so locale detection and formatter construction happen at most once per process.

Two public formatting styles are exposed. `format_with_separators` renders an `i64` with locale-aware grouping separators, such as commas in `en-US`. `format_si_suffix` renders counts with three significant figures and base-10 suffixes `K`, `M`, and `G`. The internal `format_si_suffix_with_formatter` clamps negative inputs to zero, uses a closure to scale and round values to 0, 1, or 2 fractional digits depending on magnitude, and chooses the first unit where the rounded value stays below 1000. Values above `1000G` are rendered as whole gigas with grouped separators. The test suite fixes the exact thresholds and rounding behavior around boundaries like `999_500 -> 1.00M` and `999_950_000 -> 1.00G`.

#### Function details

##### `make_local_formatter`  (lines 8–11)

```
fn make_local_formatter() -> Option<DecimalFormatter>
```

**Purpose**: Attempts to build an ICU decimal formatter for the current system locale. Any locale lookup, parse, or formatter-construction failure yields `None`.

**Data flow**: Calls `sys_locale::get_locale()`, parses the resulting locale string into `Locale`, then calls `DecimalFormatter::try_new` with default options. It returns `Some(DecimalFormatter)` on success or `None` if any step fails.

**Call relations**: Used only by `formatter()` during one-time formatter initialization. It is the preferred path before falling back to `en-US`.

*Call graph*: 3 external calls (try_new, default, get_locale).


##### `make_en_us_formatter`  (lines 13–18)

```
fn make_en_us_formatter() -> DecimalFormatter
```

**Purpose**: Builds a guaranteed fallback decimal formatter for the hard-coded `en-US` locale. It uses `expect` because failure would indicate a programming or ICU configuration error, not user input.

**Data flow**: Parses the string `"en-US"` into `Locale`, constructs a `DecimalFormatter` with default options, and returns it. It panics if either parse or formatter creation fails.

**Call relations**: Called by `formatter()` when local formatter creation fails, and directly by the test to ensure deterministic `en-US` output.

*Call graph*: called by 1 (kmg); 2 external calls (try_new, default).


##### `formatter`  (lines 20–23)

```
fn formatter() -> &'static DecimalFormatter
```

**Purpose**: Returns the process-wide cached decimal formatter, initializing it on first use. It prefers the system locale and falls back to `en-US`.

**Data flow**: Uses a static `OnceLock<DecimalFormatter>` and `get_or_init` to either return the existing formatter or initialize it with `make_local_formatter().unwrap_or_else(make_en_us_formatter)`. It returns a shared `'static` reference.

**Call relations**: Called by both public formatting functions. It centralizes lazy initialization and caching so formatting calls stay cheap after the first use.

*Call graph*: called by 2 (format_si_suffix, format_with_separators); 1 external calls (new).


##### `format_with_separators`  (lines 27–29)

```
fn format_with_separators(n: i64) -> String
```

**Purpose**: Formats an integer with locale-aware grouping separators. It is the simple public API for full numeric rendering without SI suffixes.

**Data flow**: Accepts `n: i64`, obtains the cached formatter via `formatter()`, converts `n` into `icu_decimal::input::Decimal`, formats it, converts the formatted value to `String`, and returns it.

**Call relations**: Used by higher-level UI formatting such as credit-amount display. It delegates all locale selection and caching to `formatter()`.

*Call graph*: calls 1 internal fn (formatter); called by 1 (format_credit_amount); 1 external calls (from).


##### `format_with_separators_with_formatter`  (lines 31–33)

```
fn format_with_separators_with_formatter(n: i64, formatter: &DecimalFormatter) -> String
```

**Purpose**: Formats an integer with a caller-supplied decimal formatter. This is the internal deterministic helper used by tests and by the large-number fallback in SI formatting.

**Data flow**: Accepts `n: i64` and `&DecimalFormatter`, converts `n` into `Decimal`, formats it, converts the result to `String`, and returns it. It mutates no state.

**Call relations**: Used by `format_si_suffix_with_formatter` for the `>1000G` fallback path. It avoids re-fetching the global formatter when one is already available.

*Call graph*: 2 external calls (from, format).


##### `format_si_suffix_with_formatter`  (lines 35–67)

```
fn format_si_suffix_with_formatter(n: i64, formatter: &DecimalFormatter) -> String
```

**Purpose**: Formats an integer using `K`, `M`, or `G` suffixes with roughly three significant figures, using a caller-supplied formatter for locale-aware decimal punctuation. It also clamps negative inputs to zero.

**Data flow**: Accepts `n: i64` and `&DecimalFormatter`, clamps `n` with `n.max(0)`, returns a plain formatted integer if `n < 1000`, otherwise defines a local `format_scaled` closure that scales, rounds, and formats with a chosen number of fractional digits. It iterates through `(1_000, "K")`, `(1_000_000, "M")`, and `(1_000_000_000, "G")`, selecting 2, 1, or 0 fractional digits based on rounded magnitude thresholds, and returns the suffixed string. If all units exceed 999 after rounding, it formats rounded whole gigas with separators and appends `G`.

**Call relations**: Called by the public `format_si_suffix` and by the test through a deterministic `en-US` formatter. It contains the module’s main rounding and threshold logic.

*Call graph*: called by 1 (format_si_suffix); 3 external calls (from, format, format!).


##### `format_si_suffix`  (lines 75–77)

```
fn format_si_suffix(n: i64) -> String
```

**Purpose**: Public API for compact SI-suffix formatting using the cached locale-aware formatter. It is intended for token counts and similar large counters.

**Data flow**: Accepts `n: i64`, obtains the cached formatter via `formatter()`, passes both to `format_si_suffix_with_formatter`, and returns the resulting `String`.

**Call relations**: Used by callers that want compact count formatting without managing formatter state. It delegates all real work to the formatter-specific helper.

*Call graph*: calls 2 internal fn (format_si_suffix_with_formatter, formatter).


##### `tests::kmg`  (lines 84–102)

```
fn kmg()
```

**Purpose**: Verifies the exact `K`/`M`/`G` formatting thresholds, rounding, and fallback behavior under a deterministic `en-US` locale. It documents the intended compact-number output contract.

**Data flow**: Builds an `en-US` formatter with `make_en_us_formatter`, defines a local closure that calls `format_si_suffix_with_formatter`, and asserts expected outputs for a range of values from `0` through `1_234_000_000_000`.

**Call relations**: Run by the test harness as the sole regression suite for this module’s SI-formatting behavior.

*Call graph*: calls 1 internal fn (make_en_us_formatter); 1 external calls (assert_eq!).


### `utils/elapsed/src/lib.rs`

`util` · `cross-cutting`

This utility crate exposes `format_duration` and keeps the actual formatting rules in a private helper, `format_elapsed_millis`. The public function converts a `Duration` to whole milliseconds using `as_millis()` and casts that value to `i64`, then delegates to the helper. The helper applies three display regimes: durations under one second are rendered as integer milliseconds like `250ms`; durations from one second up to but not including one minute are rendered as seconds with exactly two decimal places like `1.50s`; and durations of one minute or more are rendered as `Xm YYs`, where seconds are zero-padded to two digits.

One subtle consequence of the implementation is that values just below one minute can round up in the seconds format, so `59_999ms` becomes `60.00s` rather than switching to minute formatting. Once the input reaches `60_000ms`, the branch changes and the output becomes `1m 00s`. Hours are not given a separate unit; they continue accumulating into the minute count, so one hour prints as `60m 00s`.

The tests cover subsecond formatting, zero, second-range formatting and rounding, minute formatting, and the exact spacing/padding used at one hour.

#### Function details

##### `format_duration`  (lines 9–12)

```
fn format_duration(duration: Duration) -> String
```

**Purpose**: Public entry point that converts a `Duration` into the crate's compact elapsed-time string format. It normalizes the input to milliseconds and delegates the actual formatting rules to a private helper.

**Data flow**: It takes `duration: Duration`, reads `duration.as_millis()`, casts the result to `i64`, passes that millisecond count to `format_elapsed_millis`, and returns the resulting `String`. It does not mutate external state.

**Call relations**: This is the exported API used by all tests in the file. It exists mainly as a typed wrapper around `format_elapsed_millis` for callers that already have `Duration` values.

*Call graph*: calls 1 internal fn (format_elapsed_millis); 1 external calls (as_millis).


##### `format_elapsed_millis`  (lines 14–24)

```
fn format_elapsed_millis(millis: i64) -> String
```

**Purpose**: Implements the actual elapsed-time formatting policy based on a millisecond count. It chooses among millisecond, decimal-second, and minute/second output forms.

**Data flow**: It takes `millis: i64`. If `millis < 1000`, it returns `"{millis}ms"`; else if `millis < 60_000`, it divides by `1000.0` and formats with two decimal places as seconds; otherwise it computes `minutes = millis / 60_000` and `seconds = (millis % 60_000) / 1000`, then returns `"{minutes}m {seconds:02}s"`.

**Call relations**: This helper is called only by `format_duration`. Keeping it private isolates the formatting logic while allowing the public API to stay `Duration`-based.

*Call graph*: called by 1 (format_duration); 1 external calls (format!).


##### `tests::test_format_duration_subsecond`  (lines 31–39)

```
fn test_format_duration_subsecond()
```

**Purpose**: Verifies millisecond formatting for durations below one second, including the zero-duration edge case. It ensures no decimal seconds are used in this range.

**Data flow**: The test creates `Duration` values from 250 ms and 0 ms, passes each to `format_duration`, and asserts the returned strings are `"250ms"` and `"0ms"` respectively.

**Call relations**: It exercises the first branch of `format_elapsed_millis` through the public `format_duration` API.

*Call graph*: 2 external calls (from_millis, assert_eq!).


##### `tests::test_format_duration_seconds`  (lines 42–51)

```
fn test_format_duration_seconds()
```

**Purpose**: Checks formatting in the one-second to under-one-minute range, including rounding behavior near the upper boundary. This locks in the two-decimal seconds representation.

**Data flow**: The test constructs durations of 1,500 ms and 59,999 ms, calls `format_duration`, and asserts outputs `"1.50s"` and `"60.00s"`.

**Call relations**: It covers the middle branch of `format_elapsed_millis`, including the notable case where formatting rounds up to `60.00s` without switching branches.

*Call graph*: 2 external calls (from_millis, assert_eq!).


##### `tests::test_format_duration_minutes`  (lines 54–64)

```
fn test_format_duration_minutes()
```

**Purpose**: Verifies minute/second formatting for durations at or above one minute. It checks normal values, exact minute boundaries, and long durations that continue counting in minutes.

**Data flow**: The test creates durations of 75,000 ms, 60,000 ms, and 3,601,000 ms, passes them to `format_duration`, and asserts `"1m 15s"`, `"1m 00s"`, and `"60m 01s"`.

**Call relations**: It exercises the final branch of `format_elapsed_millis`, confirming zero-padded seconds and the absence of a separate hour unit.

*Call graph*: 2 external calls (from_millis, assert_eq!).


##### `tests::test_format_duration_one_hour_has_space`  (lines 67–70)

```
fn test_format_duration_one_hour_has_space()
```

**Purpose**: Checks the exact formatting of a one-hour duration, especially the presence of the space between minutes and seconds. This is a narrow regression-style assertion on output shape.

**Data flow**: The test creates a duration of 3,600,000 ms, calls `format_duration`, and asserts the string is `"60m 00s"`.

**Call relations**: It reinforces the minute-format branch and specifically guards the spacing/padding convention for large durations.

*Call graph*: 2 external calls (from_millis, assert_eq!).


### `utils/cli/src/format_env_display.rs`

`util` · `cross-cutting`

This file contains a single formatting helper plus unit tests that pin down its output shape. `format_env_display` accepts two sources of environment information: an optional `HashMap<String, String>` of explicit key/value pairs and a slice of variable names that should be referenced symbolically. The function never emits real values; every entry is rendered as `NAME=*****`. When a map is present, it first collects and sorts the entries by key so output is deterministic regardless of `HashMap` iteration order, then appends the redacted key/value renderings. It separately appends any names from `env_vars` in their original slice order, also redacted. The two sources are concatenated into a single comma-separated list.

A notable invariant is that empty inputs collapse to a single `-` sentinel rather than an empty string, which makes absence explicit in user-facing output. Another subtle design choice is that map entries and `env_vars` are not deduplicated against each other; if the same variable appears in both inputs, both redacted entries will be shown. The tests verify the empty case, sorted map formatting, plain variable-name formatting, and combined output ordering.

#### Function details

##### `format_env_display`  (lines 3–24)

```
fn format_env_display(
    env: Option<&HashMap<String, String>>,
    env_vars: &[S],
) -> String
```

**Purpose**: Builds a redacted display string for environment configuration from an optional map of concrete variables and a list of variable names. It guarantees deterministic ordering for map entries and returns `-` when there is nothing to show.

**Data flow**: It takes `env: Option<&HashMap<String, String>>` and `env_vars: &[S]` where `S: AsRef<str>`. It initializes an empty `Vec<String>`, optionally reads all map entries, sorts them by key, transforms each pair into `key=*****`, then appends `env_vars` rendered as `name=*****`. If the accumulated parts vector is empty it returns `"-"`; otherwise it joins the parts with `", "` and returns the resulting `String`.

**Call relations**: This is the file's primary exported helper and is exercised directly by all four tests. Its internal flow is self-contained: it performs collection, sorting, redaction, and final string assembly without delegating to other project-local functions.

*Call graph*: 3 external calls (is_empty, iter, new).


##### `tests::returns_dash_when_empty`  (lines 31–37)

```
fn returns_dash_when_empty()
```

**Purpose**: Verifies that the formatter emits the explicit `-` placeholder when both the map and variable-name list are empty. It covers both `None` and an empty `HashMap` as the map input.

**Data flow**: The test constructs an empty slice of `String` and an empty `HashMap<String, String>`, passes them into `format_env_display`, and compares the returned `String` against `"-"` in both cases. It does not mutate shared state.

**Call relations**: This test invokes the exported formatter in the no-data paths to confirm the fallback branch that returns the dash sentinel.

*Call graph*: 2 external calls (new, assert_eq!).


##### `tests::formats_sorted_env_pairs`  (lines 40–49)

```
fn formats_sorted_env_pairs()
```

**Purpose**: Checks that explicit environment pairs are rendered in key-sorted order rather than insertion order. This locks in deterministic output for user-visible displays.

**Data flow**: The test builds a `HashMap` with keys inserted as `B` then `A`, calls `format_env_display(Some(&env), &[] as &[String])`, and asserts that the returned string is `"A=*****, B=*****"`. The values `one` and `two` are intentionally ignored by the formatter.

**Call relations**: It exercises the branch where `env` is present and `env_vars` is empty, specifically validating the sort-before-format behavior.

*Call graph*: 2 external calls (new, assert_eq!).


##### `tests::formats_env_vars_with_dollar_prefix`  (lines 52–59)

```
fn formats_env_vars_with_dollar_prefix()
```

**Purpose**: Confirms that symbolic environment-variable names are rendered as redacted assignments in the order provided. Despite the test name, the output uses bare names rather than a `$` prefix.

**Data flow**: The test creates a `Vec<String>` containing `TOKEN` and `PATH`, calls `format_env_display(None, &vars)`, and asserts that the result is `"TOKEN=*****, PATH=*****"`. No map input is supplied.

**Call relations**: It covers the path where only `env_vars` contributes output, ensuring the helper formats names directly from the slice.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `tests::combines_env_pairs_and_vars`  (lines 62–71)

```
fn combines_env_pairs_and_vars()
```

**Purpose**: Verifies that explicit map entries and symbolic variable names are combined into one comma-separated display string. It also confirms the relative ordering: sorted map entries first, then listed variable names.

**Data flow**: The test constructs a one-entry `HashMap` with `HOME`, a one-element variable list containing `TOKEN`, calls `format_env_display(Some(&env), &vars)`, and asserts the combined string `"HOME=*****, TOKEN=*****"`.

**Call relations**: This test drives the mixed-input path, validating how the formatter concatenates the two independently generated groups.

*Call graph*: 3 external calls (new, assert_eq!, vec!).


### `utils/cli/src/resume_command.rs`

`util` · `request handling`

This file provides two small formatting helpers for resume-related UX. `resume_command` chooses a concrete resume target by preferring a non-empty thread name over a `ThreadId`; if neither exists, it returns `None`. Once a target is chosen, it shell-escapes it with `shlex_join` so names containing spaces or quotes become safe copy-pasteable commands. It also detects targets beginning with `-` and inserts `--` before the escaped argument so the target cannot be misparsed as another CLI flag.

`resume_hint` is slightly stricter: it requires a `ThreadId` up front and returns `None` if the ID is absent, even if a name exists. With both name and ID available, it emits a picker-oriented instruction of the form `codex resume, then select NAME (ID)`, reflecting flows where the user resumes into a selector UI. If only the ID is available, it falls back to `resume_command(None, Some(thread_id))` to produce a direct command.

The tests cover precedence rules, missing-target behavior, shell quoting for spaces and embedded quotes, the `--` safeguard for dash-prefixed names, and the distinction between direct commands and picker hints.

#### Function details

##### `resume_command`  (lines 6–20)

```
fn resume_command(thread_name: Option<&str>, thread_id: Option<ThreadId>) -> Option<String>
```

**Purpose**: Constructs a concrete `codex resume ...` shell command from either a thread name or a thread ID. It prefers a non-empty name, shell-quotes the chosen target, and inserts `--` when the target starts with a dash.

**Data flow**: It takes `thread_name: Option<&str>` and `thread_id: Option<ThreadId>`. It filters out empty names, converts a surviving name to `String`, otherwise converts the `ThreadId` to text, yielding an optional target. For a present target it computes `needs_double_dash` from `starts_with('-')`, escapes the single argument with `shlex_join(&[target])`, and returns either `Some("codex resume -- {escaped}")` or `Some("codex resume {escaped}")`; if no target exists it returns `None`.

**Call relations**: This helper is called directly by tests and by `resume_hint` when only an ID-based direct command should be shown. It is the lower-level formatter that encapsulates target selection and shell-safe command rendering.

*Call graph*: called by 5 (resume_hint, formats_thread_id_when_name_is_missing, prefers_name_over_id, quotes_thread_names_when_needed, returns_none_without_a_resume_target).


##### `resume_hint`  (lines 22–30)

```
fn resume_hint(thread_name: Option<&str>, thread_id: Option<ThreadId>) -> Option<String>
```

**Purpose**: Builds a higher-level resume hint string that either names the selectable thread alongside its ID or falls back to a direct resume command by ID. It refuses to produce any hint unless a thread ID is available.

**Data flow**: It accepts `thread_name: Option<&str>` and `thread_id: Option<ThreadId>`. Using `?`, it immediately returns `None` if `thread_id` is absent. It then filters out empty names; with a non-empty name it formats `"codex resume, then select {thread_name} ({thread_id})"`, otherwise it delegates to `resume_command(None, Some(thread_id))` and returns that result.

**Call relations**: This function sits above `resume_command`: callers use it when they want user guidance rather than always a direct command. In the no-name case it intentionally reuses `resume_command` so ID formatting and escaping stay consistent.

*Call graph*: calls 1 internal fn (resume_command); called by 3 (resume_hint_names_picker_item_with_id, resume_hint_requires_thread_id, resume_hint_uses_direct_id_command_without_name); 1 external calls (format!).


##### `tests::prefers_name_over_id`  (lines 38–42)

```
fn prefers_name_over_id()
```

**Purpose**: Checks that a non-empty thread name wins over a provided thread ID when building a resume command. This preserves friendlier commands when both identifiers are known.

**Data flow**: The test parses a fixed UUID string into `ThreadId`, calls `resume_command(Some("my-thread"), Some(thread_id))`, and asserts that the result is `Some("codex resume my-thread".to_string())`.

**Call relations**: It exercises the name-precedence branch of `resume_command`, confirming that the ID is ignored when a usable name exists.

*Call graph*: calls 2 internal fn (from_string, resume_command); 1 external calls (assert_eq!).


##### `tests::formats_thread_id_when_name_is_missing`  (lines 45–52)

```
fn formats_thread_id_when_name_is_missing()
```

**Purpose**: Verifies that the command formatter falls back to the thread ID when no thread name is supplied. This ensures resume remains possible without a human-readable name.

**Data flow**: The test constructs a `ThreadId` from a UUID string, calls `resume_command(None, Some(thread_id))`, and compares the returned `Option<String>` to the expected `codex resume <uuid>` string.

**Call relations**: It covers the fallback path in `resume_command` where the ID becomes the sole resume target.

*Call graph*: calls 2 internal fn (from_string, resume_command); 1 external calls (assert_eq!).


##### `tests::returns_none_without_a_resume_target`  (lines 55–58)

```
fn returns_none_without_a_resume_target()
```

**Purpose**: Confirms that no command string is produced when both the thread name and thread ID are absent. This prevents emitting malformed or misleading commands.

**Data flow**: The test calls `resume_command(None, None)` and asserts that the return value is `None`.

**Call relations**: It validates the early no-target outcome of `resume_command`.

*Call graph*: calls 1 internal fn (resume_command); 1 external calls (assert_eq!).


##### `tests::quotes_thread_names_when_needed`  (lines 61–73)

```
fn quotes_thread_names_when_needed()
```

**Purpose**: Checks the shell-safety rules for unusual thread names, including dash-prefixed names, names with spaces, and names containing quotes. It locks in the exact command strings users can copy and paste.

**Data flow**: The test calls `resume_command` three times with different `thread_name` values and no ID, then asserts the outputs: `codex resume -- -starts-with-dash`, `codex resume 'two words'`, and `codex resume "quote'case"` respectively.

**Call relations**: It exercises the escaping and `--` insertion logic inside `resume_command`, covering the branches that depend on target contents.

*Call graph*: calls 1 internal fn (resume_command); 1 external calls (assert_eq!).


##### `tests::resume_hint_names_picker_item_with_id`  (lines 76–86)

```
fn resume_hint_names_picker_item_with_id()
```

**Purpose**: Verifies that `resume_hint` emits picker-oriented guidance when both a thread name and ID are available. The hint includes both identifiers so the user can disambiguate selections.

**Data flow**: The test parses a UUID into `ThreadId`, calls `resume_hint(Some("my-thread"), Some(thread_id))`, and asserts that the returned string is `codex resume, then select my-thread (<uuid>)`.

**Call relations**: It covers the named-thread branch of `resume_hint`, where the function formats its own descriptive message instead of delegating.

*Call graph*: calls 2 internal fn (from_string, resume_hint); 1 external calls (assert_eq!).


##### `tests::resume_hint_uses_direct_id_command_without_name`  (lines 89–96)

```
fn resume_hint_uses_direct_id_command_without_name()
```

**Purpose**: Checks that `resume_hint` falls back to a direct ID-based command when no thread name is available. This keeps the hint actionable even without a display name.

**Data flow**: The test parses a UUID into `ThreadId`, calls `resume_hint(None, Some(thread_id))`, and asserts that the result matches the direct `codex resume <uuid>` command string.

**Call relations**: It drives the branch where `resume_hint` delegates to `resume_command` because there is no non-empty name to mention.

*Call graph*: calls 2 internal fn (from_string, resume_hint); 1 external calls (assert_eq!).


##### `tests::resume_hint_requires_thread_id`  (lines 99–102)

```
fn resume_hint_requires_thread_id()
```

**Purpose**: Confirms that `resume_hint` returns `None` if the thread ID is missing, even when a thread name is present. This enforces the function's requirement that hints be anchored to a concrete resumable thread.

**Data flow**: The test calls `resume_hint(Some("my-thread"), None)` and asserts that the result is `None`.

**Call relations**: It validates the early-return `?` behavior in `resume_hint` that rejects name-only inputs.

*Call graph*: calls 1 internal fn (resume_hint); 1 external calls (assert_eq!).


### `core/src/web_search.rs`

`util` · `request formatting / display rendering`

This file is a small formatting utility around `codex_protocol::models::WebSearchAction`. Its internal helper, `search_action_detail`, resolves the display text for search actions that may contain either `query: Option<String>` or `queries: Option<Vec<String>>`. The logic prefers a non-empty singular `query`; otherwise it looks at the first entry in `queries`, defaulting to the empty string if nothing is present. When multiple queries exist and the first query is non-empty, it appends `" ..."` to signal truncation rather than listing every query.

`web_search_action_detail` then pattern-matches the action enum and applies action-specific formatting. `Search` delegates to the helper above. `OpenPage` returns the URL or an empty string. `FindInPage` combines `pattern` and `url` into one of four concrete strings: `'<pattern>' in <url>`, `'<pattern>'`, `<url>`, or empty, depending on which optional fields are present. `Other` intentionally renders as empty. Finally, `web_search_detail` adds one more fallback layer for callers that already have a raw query string: it computes the action-derived detail when an action exists, but if that detail is empty it returns the provided `query` argument instead. This keeps downstream UI or logging code from showing blank detail text when the structured action lacks enough information.

#### Function details

##### `search_action_detail`  (lines 3–16)

```
fn search_action_detail(query: &Option<String>, queries: &Option<Vec<String>>) -> String
```

**Purpose**: Chooses the best display string for a search action from either a single query or a list of queries.

**Data flow**: Takes `&Option<String>` and `&Option<Vec<String>>`. It clones and returns the singular query if present and non-empty; otherwise it inspects the optional query list, clones the first element or defaults to `""`, and if there are multiple queries and the first is non-empty it returns `"<first> ..."`, else just the first string.

**Call relations**: This is a private helper used only by `web_search_action_detail` for the `WebSearchAction::Search` branch, keeping the query-selection rules in one place.

*Call graph*: called by 1 (web_search_action_detail).


##### `web_search_action_detail`  (lines 18–30)

```
fn web_search_action_detail(action: &WebSearchAction) -> String
```

**Purpose**: Formats a `WebSearchAction` into a concise detail string tailored to the specific action variant.

**Data flow**: Consumes `&WebSearchAction` and pattern-matches it. For `Search` it delegates to `search_action_detail`; for `OpenPage` it clones the optional URL or returns empty; for `FindInPage` it combines optional `pattern` and `url` into a formatted string according to which values are present; for `Other` it returns an empty `String`.

**Call relations**: It is called by `parse_turn_item`, which needs a readable summary of web-search-related actions. Internally it delegates only the search-query selection logic to `search_action_detail`.

*Call graph*: calls 1 internal fn (search_action_detail); called by 1 (parse_turn_item); 2 external calls (new, format!).


##### `web_search_detail`  (lines 32–39)

```
fn web_search_detail(action: Option<&WebSearchAction>, query: &str) -> String
```

**Purpose**: Returns the best available web-search detail, preferring structured action detail but falling back to a raw query string.

**Data flow**: Accepts `Option<&WebSearchAction>` and a fallback `&str` query. It maps the action through `web_search_action_detail`, defaults to `""` when no action exists, and returns either that detail if non-empty or `query.to_string()` otherwise.

**Call relations**: This is a public convenience wrapper for callers that may or may not have a structured action object. It sits above `web_search_action_detail` as the final fallback layer.


### Text shaping and truncation workflows
These files apply reusable formatting and budget-enforcement logic to larger text payloads, from TUI-oriented shaping to output and response-history trimming.

### `tui/src/text_formatting.rs`

`util` · `cross-cutting`

This file is a utility module for turning arbitrary text into forms that fit terminal rendering constraints. `capitalize_first` uppercases only the first Unicode scalar and leaves the remainder untouched. `format_and_truncate_tool_result` is tailored for tool output: it computes an approximate grapheme budget from `max_lines * line_width`, subtracting one grapheme per line as a fudge factor because terminal cell width and grapheme count do not perfectly align, then prefers compacted JSON if the input parses as JSON.

`format_json_compact` is the most specialized routine. It parses input into `serde_json::Value`, pretty-prints it, then walks the characters while tracking `in_string` and `escape_next` state. Outside strings it removes newlines and most indentation whitespace, but preserves a single space after `:` and `,` when the next token is not `}` or `]`. The result is a single-line JSON form that still contains whitespace Ratatui can wrap on.

`truncate_text` truncates by grapheme boundaries using `unicode_segmentation`, adding `...` only when at least three graphemes are available. `center_truncate_path` is width-aware rather than byte-aware: it splits on the platform path separator, preserves leading/trailing/root semantics, tries combinations of left and right segments with a Unicode ellipsis in the middle, and front-truncates individual segments when necessary using display-cell widths from `unicode_width`. `proper_join` formats human-readable lists without an Oxford comma. The test module exercises empty inputs, emoji and combining marks, invalid JSON, Windows-style paths, long segments, and preview-friendly wrapping behavior.

#### Function details

##### `capitalize_first`  (lines 5–15)

```
fn capitalize_first(input: &str) -> String
```

**Purpose**: Uppercases the first character of a string and leaves the remainder unchanged. Empty input returns an empty `String`.

**Data flow**: Reads `input: &str`, pulls the first `char` from `input.chars()`, converts that char with `to_uppercase().collect::<String>()`, appends the untouched remainder via `chars.as_str()`, and returns the new string; if there is no first char, it returns `String::new()`.

**Call relations**: This is a standalone helper with no internal callers listed here. It performs all logic locally and does not depend on other functions in the module.

*Call graph*: 1 external calls (new).


##### `format_and_truncate_tool_result`  (lines 19–34)

```
fn format_and_truncate_tool_result(
    text: &str,
    max_lines: usize,
    line_width: usize,
) -> String
```

**Purpose**: Prepares tool output for narrow terminal display by compacting JSON when possible and then truncating to an approximate grapheme budget derived from line count and width. It is tuned for Ratatui’s limited wrapping behavior.

**Data flow**: Takes raw `text`, `max_lines`, and `line_width`; computes `max_graphemes = (max_lines * line_width).saturating_sub(max_lines)`. It tries `format_json_compact(text)` first and passes either the compact JSON or the original text into `truncate_text`, returning the resulting `String`.

**Call relations**: Used where tool results must fit bounded UI regions. It orchestrates the two lower-level helpers in this file: JSON normalization first, grapheme-safe truncation second.

*Call graph*: calls 2 internal fn (format_json_compact, truncate_text).


##### `format_json_compact`  (lines 44–88)

```
fn format_json_compact(text: &str) -> Option<String>
```

**Purpose**: Converts valid JSON into a single-line representation that still contains strategic spaces after separators so Ratatui can wrap it cleanly. Invalid JSON yields `None` instead of altering the input.

**Data flow**: Parses `text` with `serde_json::from_str::<Value>`; on failure returns `None`. On success it pretty-prints the value, then scans the characters while maintaining `in_string` and `escape_next` flags, dropping newlines and indentation outside strings and inserting a single space after `:` or `,` when appropriate. It returns `Some(compacted_json)`.

**Call relations**: Called by tool-result formatting and other display helpers that want wrap-friendly JSON. Its behavior is validated by multiple unit tests covering objects, arrays, primitives, whitespace-heavy input, and invalid JSON.

*Call graph*: called by 10 (format_tool_approval_display_param_value, format_and_truncate_tool_result, test_format_json_compact_already_compact, test_format_json_compact_array, test_format_json_compact_empty_array, test_format_json_compact_empty_object, test_format_json_compact_invalid_json, test_format_json_compact_nested_object, test_format_json_compact_simple_object, test_format_json_compact_with_whitespace); 3 external calls (new, matches!, to_string_pretty).


##### `truncate_text`  (lines 91–115)

```
fn truncate_text(text: &str, max_graphemes: usize) -> String
```

**Purpose**: Truncates text by grapheme cluster count rather than bytes or scalar values, avoiding splits inside emoji or combining-character sequences. When space permits, it reserves three graphemes for an ASCII ellipsis `...`.

**Data flow**: Takes `text` and `max_graphemes`, iterates `text.grapheme_indices(true)` to detect whether the string exceeds the limit, and either returns the original text, a prefix plus `...`, or the first `max_graphemes` graphemes when the limit is below three. It returns a new `String` in all cases.

**Call relations**: This is a widely reused low-level formatter used by summaries, prompts, rows, and tool displays elsewhere in the TUI. `format_and_truncate_tool_result` composes it after optional JSON compaction, and the test suite here exercises many boundary conditions.

*Call graph*: called by 25 (activity_summary, bounded_summary, format_tool_approval_display_param_value, build_rows, error_summary_spans, prompt_line, status_summary_spans, dense_column_text, push_footer_part, render_comfortable_session_lines (+15 more)); 1 external calls (format!).


##### `center_truncate_path`  (lines 120–328)

```
fn center_truncate_path(path: &str, max_width: usize) -> String
```

**Purpose**: Shrinks a path-like string to a target display width while preserving as much leading and trailing path structure as possible. It prefers a middle ellipsis and only front-truncates individual segments when necessary.

**Data flow**: Consumes `path` and `max_width`, first short-circuiting for zero width or already-fitting paths. It splits the path on `MAIN_SEPARATOR`, tracks leading/trailing separators, generates candidate `(left_count, right_count)` segment combinations, assembles candidates with an inserted `…` when middle segments are omitted, measures display width with `UnicodeWidthStr`, and iteratively front-truncates selected segments using a helper closure based on `UnicodeWidthChar`. It returns the first fitting candidate or a final front-truncated whole-path fallback.

**Call relations**: Used by directory/path display formatting elsewhere in the TUI and covered by dedicated tests for Unix-like paths, Windows-like paths, and oversized single segments. It encapsulates all width-aware path truncation logic locally.

*Call graph*: called by 6 (format_directory_inner, format_directory_display, test_center_truncate_doesnt_truncate_short_path, test_center_truncate_handles_long_segment, test_center_truncate_truncates_long_path, test_center_truncate_truncates_long_windows_path); 4 external calls (new, width, new, min).


##### `proper_join`  (lines 336–355)

```
fn proper_join(items: &[T]) -> String
```

**Purpose**: Joins a slice of strings into simple English list text using `and` and comma separators. It intentionally omits the Oxford comma in lists of three or more items.

**Data flow**: Reads `items: &[T]` where `T: AsRef<str>`, branches on `items.len()`, and returns either an empty string, the sole item, a two-item `"a and b"` string, or a comma-separated prefix followed by ` and {last}`.

**Call relations**: This is a standalone presentation helper. It is validated by the local `test_proper_join` unit test.

*Call graph*: 4 external calls (new, iter, len, format!).


##### `tests::test_truncate_text`  (lines 363–367)

```
fn test_truncate_text()
```

**Purpose**: Verifies that truncation beyond the limit produces a shortened prefix plus ellipsis for ordinary ASCII text.

**Data flow**: Creates a sample string, calls `truncate_text` with a limit of 8 graphemes, and asserts that the returned string is `Hello...`.

**Call relations**: This test exercises the main truncation path where the input exceeds the limit and the limit is large enough to reserve three graphemes for `...`.

*Call graph*: calls 1 internal fn (truncate_text); 1 external calls (assert_eq!).


##### `tests::test_truncate_empty_string`  (lines 370–374)

```
fn test_truncate_empty_string()
```

**Purpose**: Checks that truncating an empty string returns an empty string rather than panicking or adding punctuation.

**Data flow**: Passes `""` into `truncate_text` with a positive limit and asserts the result is still empty.

**Call relations**: This test covers the empty-input edge case of `truncate_text`.

*Call graph*: calls 1 internal fn (truncate_text); 1 external calls (assert_eq!).


##### `tests::test_truncate_max_graphemes_zero`  (lines 377–381)

```
fn test_truncate_max_graphemes_zero()
```

**Purpose**: Confirms that a zero grapheme budget yields an empty result.

**Data flow**: Calls `truncate_text("Hello", 0)` and asserts the returned string is empty.

**Call relations**: This test covers the smallest possible truncation budget for `truncate_text`.

*Call graph*: calls 1 internal fn (truncate_text); 1 external calls (assert_eq!).


##### `tests::test_truncate_max_graphemes_one`  (lines 384–388)

```
fn test_truncate_max_graphemes_one()
```

**Purpose**: Confirms that a one-grapheme budget returns exactly the first grapheme with no ellipsis.

**Data flow**: Calls `truncate_text("Hello", 1)` and asserts the result is `H`.

**Call relations**: This test validates the branch where `max_graphemes < 3`, so no `...` is appended.

*Call graph*: calls 1 internal fn (truncate_text); 1 external calls (assert_eq!).


##### `tests::test_truncate_max_graphemes_two`  (lines 391–395)

```
fn test_truncate_max_graphemes_two()
```

**Purpose**: Confirms that a two-grapheme budget returns the first two graphemes with no ellipsis.

**Data flow**: Calls `truncate_text("Hello", 2)` and asserts the result is `He`.

**Call relations**: This test covers another `max_graphemes < 3` boundary for `truncate_text`.

*Call graph*: calls 1 internal fn (truncate_text); 1 external calls (assert_eq!).


##### `tests::test_truncate_max_graphemes_three_boundary`  (lines 398–402)

```
fn test_truncate_max_graphemes_three_boundary()
```

**Purpose**: Checks the exact boundary where the entire budget is consumed by the ellipsis marker.

**Data flow**: Calls `truncate_text("Hello", 3)` and asserts the result is `...`.

**Call relations**: This test validates the `max_graphemes >= 3` truncation branch at its smallest value.

*Call graph*: calls 1 internal fn (truncate_text); 1 external calls (assert_eq!).


##### `tests::test_truncate_text_shorter_than_limit`  (lines 405–409)

```
fn test_truncate_text_shorter_than_limit()
```

**Purpose**: Ensures text shorter than the grapheme limit is returned unchanged.

**Data flow**: Calls `truncate_text("Hi", 10)` and asserts the original string is preserved.

**Call relations**: This test covers the no-truncation path of `truncate_text`.

*Call graph*: calls 1 internal fn (truncate_text); 1 external calls (assert_eq!).


##### `tests::test_truncate_text_exact_length`  (lines 412–416)

```
fn test_truncate_text_exact_length()
```

**Purpose**: Ensures text exactly at the grapheme limit is not modified.

**Data flow**: Calls `truncate_text("Hello", 5)` and asserts the result remains `Hello`.

**Call relations**: This test covers the exact-fit path of `truncate_text`.

*Call graph*: calls 1 internal fn (truncate_text); 1 external calls (assert_eq!).


##### `tests::test_truncate_emoji`  (lines 419–426)

```
fn test_truncate_emoji()
```

**Purpose**: Verifies grapheme-aware truncation with emoji sequences, including the boundary where only ellipsis fits and where one emoji plus ellipsis fits.

**Data flow**: Calls `truncate_text` on an emoji string with limits 3 and 4, then asserts the outputs are `...` and `👋...` respectively.

**Call relations**: This test demonstrates why `truncate_text` uses grapheme clusters instead of bytes or chars.

*Call graph*: calls 1 internal fn (truncate_text); 1 external calls (assert_eq!).


##### `tests::test_truncate_unicode_combining_characters`  (lines 429–433)

```
fn test_truncate_unicode_combining_characters()
```

**Purpose**: Checks that combining-character sequences are not split incorrectly during truncation.

**Data flow**: Passes a string containing combining marks into `truncate_text` with a limit of 2 graphemes and asserts the full text is preserved.

**Call relations**: This test validates Unicode grapheme correctness in `truncate_text`.

*Call graph*: calls 1 internal fn (truncate_text); 1 external calls (assert_eq!).


##### `tests::test_truncate_very_long_text`  (lines 436–441)

```
fn test_truncate_very_long_text()
```

**Purpose**: Confirms truncation behavior on large inputs and verifies the final string length stays within the requested grapheme budget for simple ASCII.

**Data flow**: Builds a 1000-character `a` string, truncates it to 10 graphemes, and asserts both the textual result and resulting length.

**Call relations**: This test covers performance-adjacent long-input behavior and the expected `7 chars + 3 dots` output shape.

*Call graph*: calls 1 internal fn (truncate_text); 1 external calls (assert_eq!).


##### `tests::test_format_json_compact_simple_object`  (lines 444–448)

```
fn test_format_json_compact_simple_object()
```

**Purpose**: Verifies compact formatting of a simple JSON object with spaces after separators.

**Data flow**: Calls `format_json_compact` on a small object literal, unwraps the `Option`, and asserts the exact compact string.

**Call relations**: This test covers the basic successful parse-and-compact path of `format_json_compact`.

*Call graph*: calls 1 internal fn (format_json_compact); 1 external calls (assert_eq!).


##### `tests::test_format_json_compact_nested_object`  (lines 451–458)

```
fn test_format_json_compact_nested_object()
```

**Purpose**: Checks that nested objects are compacted into a single line while preserving readable separator spacing.

**Data flow**: Passes nested JSON into `format_json_compact`, unwraps the result, and compares it to the expected single-line nested form.

**Call relations**: This test validates recursive/nested structure handling in `format_json_compact`.

*Call graph*: calls 1 internal fn (format_json_compact); 1 external calls (assert_eq!).


##### `tests::test_center_truncate_doesnt_truncate_short_path`  (lines 461–467)

```
fn test_center_truncate_doesnt_truncate_short_path()
```

**Purpose**: Ensures a path already within the width budget is returned unchanged.

**Data flow**: Constructs a path using the platform separator, calls `center_truncate_path` with a wide limit, and asserts equality with the original path.

**Call relations**: This test covers the early-return no-truncation branch of `center_truncate_path`.

*Call graph*: calls 1 internal fn (center_truncate_path); 2 external calls (assert_eq!, format!).


##### `tests::test_center_truncate_truncates_long_path`  (lines 470–479)

```
fn test_center_truncate_truncates_long_path()
```

**Purpose**: Verifies that long multi-segment paths are center-truncated with a middle ellipsis while preserving both prefix and suffix segments.

**Data flow**: Builds a long path, calls `center_truncate_path` with a constrained width, and asserts the expected `prefix/…/suffix` form.

**Call relations**: This test exercises the candidate-combination logic in `center_truncate_path`.

*Call graph*: calls 1 internal fn (center_truncate_path); 2 external calls (assert_eq!, format!).


##### `tests::test_center_truncate_truncates_long_windows_path`  (lines 482–492)

```
fn test_center_truncate_truncates_long_windows_path()
```

**Purpose**: Checks center truncation on a Windows-style path shape, preserving drive/prefix and filename suffix.

**Data flow**: Constructs a long path with a drive-like prefix and many segments, truncates it, and asserts the expected ellipsis-preserving result.

**Call relations**: This test validates that `center_truncate_path` works across platform-style path structures.

*Call graph*: calls 1 internal fn (center_truncate_path); 2 external calls (assert_eq!, format!).


##### `tests::test_center_truncate_handles_long_segment`  (lines 495–501)

```
fn test_center_truncate_handles_long_segment()
```

**Purpose**: Verifies fallback front-truncation of an individual oversized segment when preserving whole segments cannot fit.

**Data flow**: Builds a path with one extremely long segment, calls `center_truncate_path`, and asserts the result contains a leading ellipsis inside that segment.

**Call relations**: This test covers the segment-level front-truncation branch of `center_truncate_path`.

*Call graph*: calls 1 internal fn (center_truncate_path); 2 external calls (assert_eq!, format!).


##### `tests::test_format_json_compact_array`  (lines 504–508)

```
fn test_format_json_compact_array()
```

**Purpose**: Verifies compact formatting of arrays containing primitives and nested objects.

**Data flow**: Calls `format_json_compact` on an array literal, unwraps the result, and asserts the exact compact output.

**Call relations**: This test extends `format_json_compact` coverage to array syntax.

*Call graph*: calls 1 internal fn (format_json_compact); 1 external calls (assert_eq!).


##### `tests::test_format_json_compact_already_compact`  (lines 511–515)

```
fn test_format_json_compact_already_compact()
```

**Purpose**: Ensures already-compact JSON is normalized only as needed, such as inserting a space after a colon.

**Data flow**: Passes compact JSON into `format_json_compact`, unwraps the result, and asserts the normalized compact form.

**Call relations**: This test checks idempotent-ish behavior of `format_json_compact` on already concise input.

*Call graph*: calls 1 internal fn (format_json_compact); 1 external calls (assert_eq!).


##### `tests::test_format_json_compact_with_whitespace`  (lines 518–533)

```
fn test_format_json_compact_with_whitespace()
```

**Purpose**: Checks that heavily indented multiline JSON is collapsed into a single wrap-friendly line.

**Data flow**: Supplies multiline JSON text to `format_json_compact`, unwraps the result, and asserts the expected compact string.

**Call relations**: This test validates whitespace stripping outside strings in `format_json_compact`.

*Call graph*: calls 1 internal fn (format_json_compact); 1 external calls (assert_eq!).


##### `tests::test_format_json_compact_invalid_json`  (lines 536–540)

```
fn test_format_json_compact_invalid_json()
```

**Purpose**: Ensures invalid JSON input is rejected rather than partially rewritten.

**Data flow**: Calls `format_json_compact` on malformed JSON and asserts the result is `None`.

**Call relations**: This test covers the parse-failure early return of `format_json_compact`.

*Call graph*: calls 1 internal fn (format_json_compact); 1 external calls (assert!).


##### `tests::test_format_json_compact_empty_object`  (lines 543–547)

```
fn test_format_json_compact_empty_object()
```

**Purpose**: Verifies that an empty object remains `{}` after compaction.

**Data flow**: Calls `format_json_compact("{}")`, unwraps the result, and asserts it equals `{}`.

**Call relations**: This test covers a minimal valid-object case for `format_json_compact`.

*Call graph*: calls 1 internal fn (format_json_compact); 1 external calls (assert_eq!).


##### `tests::test_format_json_compact_empty_array`  (lines 550–554)

```
fn test_format_json_compact_empty_array()
```

**Purpose**: Verifies that an empty array remains `[]` after compaction.

**Data flow**: Calls `format_json_compact("[]")`, unwraps the result, and asserts it equals `[]`.

**Call relations**: This test covers a minimal valid-array case for `format_json_compact`.

*Call graph*: calls 1 internal fn (format_json_compact); 1 external calls (assert_eq!).


##### `tests::test_format_json_compact_primitive_values`  (lines 557–563)

```
fn test_format_json_compact_primitive_values()
```

**Purpose**: Checks that primitive JSON values are accepted and returned in their expected textual form.

**Data flow**: Calls `format_json_compact` on numeric, boolean, null, and string literals and asserts each unwrapped result.

**Call relations**: This test broadens `format_json_compact` coverage beyond arrays and objects.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::test_proper_join`  (lines 566–579)

```
fn test_proper_join()
```

**Purpose**: Verifies English list joining across empty, singleton, pair, and longer lists.

**Data flow**: Constructs several input slices and vectors, calls `proper_join` on each, and asserts the exact returned strings.

**Call relations**: This test locks down the punctuation and conjunction rules implemented by `proper_join`.

*Call graph*: 2 external calls (assert_eq!, vec!).


### `utils/output-truncation/src/lib.rs`

`domain_logic` · `cross-cutting`

This file contains the production truncation logic used to shrink tool or exec output before it is surfaced elsewhere. The simplest path is `truncate_text`, which dispatches on `TruncationPolicy`: byte budgets use `truncate_middle_chars`, while token budgets use `truncate_middle_with_token_budget` and keep only the truncated string component. `formatted_truncate_text` wraps that raw truncation with a warning header that records the original approximate token count and original line count, but only when the content exceeds the policy’s byte budget; otherwise it returns the original string unchanged. For structured outputs, `formatted_truncate_text_content_items_with_policy` extracts only `InputText` segments, joins them with newline separators, and if truncation is needed replaces all text items with a single warning-prefixed `InputText` while appending any `InputImage` and `EncryptedContent` items unchanged. The sibling `truncate_function_output_items_with_policy` instead preserves item boundaries as much as possible: it walks items in order, spends a remaining byte/token budget only on text items, truncates the first over-budget text item into a snippet, omits later text items once the budget is exhausted, and appends a summary marker like `[omitted N text items ...]`. Non-text items never consume budget and are always preserved. Finally, `approx_tokens_from_byte_count_i64` is a small adapter that clamps non-positive inputs to zero and saturates conversions between signed and unsigned sizes.

#### Function details

##### `formatted_truncate_text`  (lines 12–23)

```
fn formatted_truncate_text(content: &str, policy: TruncationPolicy) -> String
```

**Purpose**: Returns either the original text or a warning-prefixed truncated version that includes original token and line counts.

**Data flow**: It takes a content string and `TruncationPolicy`. If `content.len()` is within `policy.byte_budget()`, it returns `content.to_string()`. Otherwise it computes `approx_token_count(content)`, counts lines with `content.lines().count()`, obtains the truncated body from `truncate_text`, and formats a warning header plus the truncated body into a new `String`.

**Call relations**: This helper is used directly by callers that want human-readable truncation context and is also reused by `formatted_truncate_text_content_items_with_policy` after text segments are merged.

*Call graph*: calls 2 internal fn (byte_budget, truncate_text); 2 external calls (approx_token_count, format!).


##### `truncate_text`  (lines 25–30)

```
fn truncate_text(content: &str, policy: TruncationPolicy) -> String
```

**Purpose**: Performs the core middle-truncation of a single text string according to either a byte or token budget.

**Data flow**: It takes a content string and `TruncationPolicy`. For `Bytes(bytes)` it calls `truncate_middle_chars(content, bytes)`; for `Tokens(tokens)` it calls `truncate_middle_with_token_budget(content, tokens)` and returns only the string portion of that result.

**Call relations**: This is the low-level truncation primitive used by both `formatted_truncate_text` and `truncate_function_output_items_with_policy`. It delegates the actual truncation algorithm to shared string utilities.

*Call graph*: called by 2 (formatted_truncate_text, truncate_function_output_items_with_policy); 2 external calls (truncate_middle_chars, truncate_middle_with_token_budget).


##### `formatted_truncate_text_content_items_with_policy`  (lines 32–81)

```
fn formatted_truncate_text_content_items_with_policy(
    items: &[FunctionCallOutputContentItem],
    policy: TruncationPolicy,
) -> (Vec<FunctionCallOutputContentItem>, Option<usize>)
```

**Purpose**: Merges all text content items, truncates them as one combined block if needed, and preserves non-text items after the merged text.

**Data flow**: It takes a slice of `FunctionCallOutputContentItem` and a policy. It collects `InputText` strings, ignoring `InputImage` and `EncryptedContent`. If there are no text segments, or if the newline-joined combined text fits within `policy.byte_budget()`, it returns `(items.to_vec(), None)`. Otherwise it computes the original token count, creates a new output vector whose first item is a single `InputText` containing `formatted_truncate_text(&combined, policy)`, then appends cloned image and encrypted items in original order. It returns that vector plus `Some(original_token_count)`.

**Call relations**: This function is for callers that prefer one consolidated warning-bearing text block rather than per-item truncation. It delegates the actual text shortening to `formatted_truncate_text` and preserves non-text payloads explicitly.

*Call graph*: calls 1 internal fn (byte_budget); 5 external calls (new, iter, to_vec, approx_token_count, vec!).


##### `truncate_function_output_items_with_policy`  (lines 83–145)

```
fn truncate_function_output_items_with_policy(
    items: &[FunctionCallOutputContentItem],
    policy: TruncationPolicy,
) -> Vec<FunctionCallOutputContentItem>
```

**Purpose**: Applies a byte or token budget incrementally across text items while preserving non-text items and reporting how many later text items were omitted.

**Data flow**: It takes a slice of content items and a policy, initializes an output vector and remaining budget from either `byte_budget()` or `token_budget()`, and iterates items in order. Text items consume budget based on byte length or `approx_token_count`; fully fitting text is cloned unchanged, the first over-budget text is truncated with `truncate_text` under the remaining budget, and once budget reaches zero later text items are omitted and counted. `InputImage` and `EncryptedContent` items are always cloned through unchanged. If any text items were omitted, it appends a final `InputText` summary marker.

**Call relations**: This function is the item-preserving alternative to `formatted_truncate_text_content_items_with_policy`. It relies on `truncate_text` for the partial-snippet case and on token-count helpers when operating under token budgets.

*Call graph*: calls 3 internal fn (byte_budget, token_budget, truncate_text); 6 external calls (with_capacity, len, approx_token_count, format!, Bytes, Tokens).


##### `approx_tokens_from_byte_count_i64`  (lines 147–154)

```
fn approx_tokens_from_byte_count_i64(bytes: i64) -> i64
```

**Purpose**: Converts a signed byte count into an approximate signed token count with clamping and saturation.

**Data flow**: It takes an `i64` byte count. Non-positive values return `0`. Positive values are converted to `usize` with saturation to `usize::MAX`, passed to `approx_tokens_from_byte_count`, then converted back to `i64` with saturation to `i64::MAX`.

**Call relations**: This is a small adapter for APIs that traffic in signed integers. It delegates the actual approximation to the re-exported string utility.

*Call graph*: 3 external calls (approx_tokens_from_byte_count, try_from, try_from).


### `tools/src/response_history.rs`

`util` · `cross-cutting history preparation`

This module operates directly on conversation history represented as `codex_protocol::models::ResponseItem`. `retain_tail_from_last_n_user_messages` is a structural slicer: if asked to retain zero user messages it clears the vector immediately; if there is no user message at all it also clears the vector. Otherwise it first truncates away everything after the latest user message, intentionally dropping any assistant output that followed that user turn, then walks backward through the remaining items to find the earliest user message among the last `user_message_count` user turns and drains everything before it. The result is a contiguous suffix beginning at a retained user message and ending exactly at the latest user message. `truncate_assistant_output_text_to_token_budget` is content-aware rather than turn-aware. It scans items in order, only touching `ResponseItem::Message` values whose `role` is `assistant`, and within those messages only `ContentItem::OutputText` entries. It spends a single shared `remaining_budget` across all assistant output text segments; once the budget is exhausted, later output-text segments are removed, and assistant messages emptied by that removal are dropped entirely. If a segment would exceed the remaining budget, it is truncated in place with `truncate_text(..., TruncationPolicy::Tokens(...))` and consumes the rest of the budget. The tests build minimal synthetic messages to demonstrate both the tail-retention boundary and cross-item truncation behavior.

#### Function details

##### `retain_tail_from_last_n_user_messages`  (lines 9–34)

```
fn retain_tail_from_last_n_user_messages(
    items: &mut Vec<ResponseItem>,
    user_message_count: usize,
)
```

**Purpose**: Shrinks a response-history vector so it contains only the contiguous span from the earliest of the last N user messages through the latest user message. It deliberately excludes any items after that latest user turn.

**Data flow**: Takes `&mut Vec<ResponseItem>` plus `user_message_count`. If the count is zero, it clears the vector and returns. Otherwise it searches backward for the last item where `ResponseItem::is_user_message` is true; if none exists, it clears the vector. With a latest user index found, it truncates the vector to `latest_user_idx + 1`, then scans backward over user messages, takes the last `user_message_count` of them, computes the earliest retained user index, and drains all earlier items. It mutates the input vector in place and returns `()`.

**Call relations**: Production code can call this as a preprocessing step before handing history to downstream consumers; in this file it is exercised by `tests::retains_tail_through_latest_user_message`. The function is self-contained and delegates only to standard iterator and vector operations.

*Call graph*: called by 1 (retains_tail_through_latest_user_message).


##### `truncate_assistant_output_text_to_token_budget`  (lines 37–71)

```
fn truncate_assistant_output_text_to_token_budget(
    items: &mut Vec<ResponseItem>,
    max_tokens: usize,
)
```

**Purpose**: Applies one shared token budget across all assistant output-text content in a history vector, truncating or removing assistant text once the budget is exhausted. Non-assistant items and non-output content are preserved unchanged.

**Data flow**: Accepts `&mut Vec<ResponseItem>` and `max_tokens`, initializes `remaining_budget`, and then retains/mutates items in place. For each `ResponseItem::Message`, it skips non-assistant roles; for assistant messages it retains/mutates each `ContentItem`, preserving non-`OutputText` entries, dropping `OutputText` entries when budget is zero, keeping whole text when `approx_token_count(text)` fits, or replacing `text` with `truncate_text(text, TruncationPolicy::Tokens(remaining_budget))` when only a prefix fits. After processing a message, it removes the whole message if its `content` becomes empty. It returns `()` after mutating the vector.

**Call relations**: This helper is validated by `tests::truncates_assistant_output_text_across_items`, which demonstrates budget sharing across multiple assistant messages. It delegates token estimation and truncation mechanics to `approx_token_count` and `truncate_text` from the output-truncation utility crate.

*Call graph*: called by 1 (truncates_assistant_output_text_across_items).


##### `tests::message`  (lines 84–100)

```
fn message(role: &str, text: &str) -> ResponseItem
```

**Purpose**: Constructs a minimal `ResponseItem::Message` fixture for tests, choosing input or output content shape based on the role. It keeps the tests concise while still producing realistic protocol values.

**Data flow**: Takes a `role` string and `text` string slice. Builds a `ResponseItem::Message` with `id`, `phase`, and `metadata` set to `None`; if the role is `assistant`, it wraps the text in `ContentItem::OutputText`, otherwise in `ContentItem::InputText`. Returns the assembled `ResponseItem`.

**Call relations**: This helper is called by both test functions in the nested `tests` module to build expected and actual histories. It does not participate in production call flow.

*Call graph*: 1 external calls (vec!).


##### `tests::retains_tail_through_latest_user_message`  (lines 103–124)

```
fn retains_tail_through_latest_user_message()
```

**Purpose**: Demonstrates that retaining the last two user messages keeps the contiguous span from the earlier retained user turn through the latest user turn and drops later assistant output. It serves as the executable specification for the tail-retention helper.

**Data flow**: Builds a mixed sequence of system, user, and assistant messages with `tests::message`, mutably passes it to `retain_tail_from_last_n_user_messages` with count `2`, and then asserts that the vector now contains only `previous user`, `previous assistant`, and `current user`.

**Call relations**: The test harness invokes this test, and it directly exercises `retain_tail_from_last_n_user_messages`. Its expected vector captures the function’s key boundary choice: stop at the latest user message rather than including following assistant items.

*Call graph*: calls 1 internal fn (retain_tail_from_last_n_user_messages); 2 external calls (assert_eq!, vec!).


##### `tests::truncates_assistant_output_text_across_items`  (lines 127–149)

```
fn truncates_assistant_output_text_across_items()
```

**Purpose**: Checks that assistant output truncation spends a shared budget across messages, truncates the first oversized assistant text, and removes later assistant output once no budget remains. It also confirms user messages survive untouched.

**Data flow**: Creates a long assistant string, builds a history containing user and assistant messages, calls `truncate_assistant_output_text_to_token_budget` with a budget of `2`, and asserts that the first assistant message now contains `truncate_text(..., Tokens(2))` while the second assistant message has been removed entirely.

**Call relations**: This test is run by the test harness and directly validates `truncate_assistant_output_text_to_token_budget`. It relies on the same `truncate_text` helper as production code to compute the expected truncated string.

*Call graph*: calls 1 internal fn (truncate_assistant_output_text_to_token_budget); 2 external calls (assert_eq!, vec!).


### Strict text templating
This file provides the stage's standalone templating engine for parsing and rendering placeholder-based text with explicit error handling.

### `utils/template/src/lib.rs`

`domain_logic` · `rendering`

This module provides a deliberately small templating system with strict validation. Parsing produces a `Template` containing two synchronized representations: `segments`, a `Vec<Segment>` of `Literal(String)` and `Placeholder(String)` pieces in source order, and `placeholders`, a `BTreeSet<String>` of unique placeholder names for validation and deterministic iteration. The parser supports `{{ name }}` interpolation plus `{{{{` and `}}}}` escapes for literal `{{` and `}}`.

`Template::parse` scans the source string by byte cursor. It flushes preceding literal text with `push_literal` whenever it encounters an escape or placeholder start. `{{{{` and `}}}}` become literal delimiter segments; `{{` triggers `parse_placeholder`, which trims surrounding whitespace inside the placeholder and rejects empty placeholders, nested `{{`, unmatched `}}`, and unterminated placeholders with byte-accurate error positions. A bare `}}` outside a placeholder is also rejected immediately.

Rendering is intentionally strict in both directions. `build_variable_map` first consumes the provided variables into a `BTreeMap<String, String>`, rejecting duplicate names. `Template::render` then checks that every placeholder has a value and that no extra variable names were supplied. Only after both validations pass does it iterate `segments`, copying literals directly and substituting placeholder values from the map. The free `render` function is a convenience wrapper that parses and renders in one call, wrapping parse and render failures into the umbrella `TemplateError`. The tests cover reuse of parsed templates, sorted unique placeholder enumeration, multiline and adjacent placeholders, delimiter escaping, and every parse/render error variant.

#### Function details

##### `TemplateParseError::fmt`  (lines 22–43)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Formats parse errors into precise human-readable messages that include the byte offset of the offending delimiter or placeholder. Each variant explains the exact structural problem in the template source.

**Data flow**: It reads the `TemplateParseError` variant and associated `start` field from `self`, writes the corresponding message into the formatter `f`, and returns `fmt::Result`.

**Call relations**: This formatter is used whenever parse errors are displayed directly or through `TemplateError`. It is purely diagnostic and does not participate in parsing logic.

*Call graph*: 1 external calls (write!).


##### `TemplateRenderError::fmt`  (lines 56–68)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Formats rendering errors for duplicate, extra, or missing variable values. The messages name the specific placeholder or variable involved.

**Data flow**: It reads the `TemplateRenderError` variant and its `name` field, writes the appropriate message into `f`, and returns `fmt::Result`.

**Call relations**: This is used when render-time validation fails, either directly or wrapped inside `TemplateError`.

*Call graph*: 1 external calls (write!).


##### `TemplateError::fmt`  (lines 80–85)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Delegates formatting of the umbrella template error to the underlying parse or render error. It preserves the more specific message text from the wrapped error.

**Data flow**: It matches on `self` and calls `fmt` on the contained `TemplateParseError` or `TemplateRenderError`, returning that `fmt::Result`.

**Call relations**: This sits above the specific error types and is used by the convenience `render` API, which can fail in either phase.


##### `TemplateError::source`  (lines 89–94)

```
fn source(&self) -> Option<&(dyn Error + 'static)>
```

**Purpose**: Exposes the wrapped parse or render error as the causal source for standard error chaining. It lets callers inspect the underlying failure category through the `Error` trait.

**Data flow**: It matches on `self` and returns `Some(err)` as `&(dyn Error + 'static)` for either wrapped variant.

**Call relations**: This supports generic error-reporting infrastructure when `TemplateError` is propagated from the top-level `render` helper.


##### `TemplateError::from`  (lines 104–106)

```
fn from(value: TemplateRenderError) -> Self
```

**Purpose**: Converts a specific parse or render error into the umbrella `TemplateError` enum. It is the glue that allows `?` and `map_err(Into::into)` to work across phases.

**Data flow**: It takes either a `TemplateParseError` or `TemplateRenderError` value and wraps it in `TemplateError::Parse` or `TemplateError::Render`, returning the new enum value.

**Call relations**: These conversions are used by the free `render` function and any other code that wants to collapse phase-specific errors into one return type.

*Call graph*: 2 external calls (Parse, Render).


##### `Template::parse`  (lines 122–168)

```
fn parse(source: &str) -> Result<Self, TemplateParseError>
```

**Purpose**: Parses template source into reusable literal and placeholder segments while collecting the unique placeholder names. It enforces the templating syntax strictly and reports byte-accurate parse errors.

**Data flow**: It takes `source: &str`, initializes empty `BTreeSet<String>` and `Vec<Segment>`, then scans with `cursor` and `literal_start`. On `{{{{` or `}}}}` it flushes preceding literal text via `push_literal`, inserts literal delimiter text, advances the cursor, and resets `literal_start`. On `{{` it flushes preceding literal text, parses the placeholder with `parse_placeholder`, inserts the placeholder name into the set, pushes `Segment::Placeholder`, and advances. On bare `}}` it returns `UnmatchedClosingDelimiter`. Otherwise it advances by one UTF-8 character. At the end it flushes the trailing literal and returns `Template { placeholders, segments }`.

**Call relations**: This is the main parse entry used by the free `render` helper, tests, and other code that wants reusable compiled templates. It delegates literal coalescing to `push_literal` and placeholder-body parsing/validation to `parse_placeholder`.

*Call graph*: calls 2 internal fn (parse_placeholder, push_literal); called by 13 (parse_embedded_template, parse_embedded_template, parse_embedded_template, render, parse_errors_when_closing_delimiter_is_unmatched, parse_errors_when_placeholder_is_empty, parse_errors_when_placeholder_is_nested, parse_errors_when_placeholder_is_unterminated, parsed_templates_can_be_reused, placeholders_are_sorted_and_unique (+3 more)); 3 external calls (new, new, Placeholder).


##### `Template::placeholders`  (lines 170–172)

```
fn placeholders(&self) -> impl ExactSizeIterator<Item = &str>
```

**Purpose**: Returns an iterator over the template’s unique placeholder names as `&str`. Because the names are stored in a `BTreeSet`, iteration order is sorted.

**Data flow**: It borrows `self.placeholders`, iterates over the set, maps each `String` to `&str` with `String::as_str`, and returns the resulting exact-size iterator.

**Call relations**: This accessor is used by callers and tests that need to inspect the template schema without rendering. It reads the parse result but does not mutate template state.

*Call graph*: 1 external calls (iter).


##### `Template::render`  (lines 174–209)

```
fn render(&self, variables: I) -> Result<String, TemplateRenderError>
```

**Purpose**: Renders a parsed template with a supplied variable set, rejecting duplicate inputs, missing placeholders, and unused extra variables before producing output. It is intentionally strict so template/data mismatches fail loudly.

**Data flow**: It takes an iterable of `(K, V)` pairs, converts it into a `BTreeMap<String, String>` via `build_variable_map`, checks every placeholder in `self.placeholders` exists in the map, checks every provided variable name is actually used by the template, then iterates `self.segments`. Literal segments are appended directly to a `String`; placeholder segments look up the corresponding value in the map and append it. It returns `Ok(rendered)` or a `TemplateRenderError`.

**Call relations**: This is the main rendering engine used by higher-level prompt/template code and by the free `render` wrapper. It delegates duplicate detection and string ownership normalization to `build_variable_map`, then performs its own strict missing/extra validation before substitution.

*Call graph*: calls 1 internal fn (build_variable_map); called by 2 (render_memory_extensions_block, render_review_prompt); 5 external calls (contains, contains_key, get, keys, new).


##### `render`  (lines 212–221)

```
fn render(template: &str, variables: I) -> Result<String, TemplateError>
```

**Purpose**: Convenience function that parses and renders a template in one call, returning a unified error type. It is suitable for one-off rendering when template reuse is unnecessary.

**Data flow**: It takes a template source string and variables iterable, calls `Template::parse(template)?`, then calls `.render(variables)` on the parsed template and maps any render error into `TemplateError` before returning the final `Result<String, TemplateError>`.

**Call relations**: This top-level helper orchestrates the full parse-then-render flow. It is used by tests and by callers that do not need to keep a parsed `Template` around.

*Call graph*: calls 1 internal fn (parse); called by 5 (render_function_wraps_parse_errors, render_function_wraps_render_errors, render_replaces_placeholders_with_and_without_whitespace, render_supports_literal_delimiter_escapes, render_supports_multiline_templates_and_adjacent_placeholders).


##### `push_literal`  (lines 223–233)

```
fn push_literal(segments: &mut Vec<Segment>, literal: &str)
```

**Purpose**: Appends literal text to the segment list while skipping empty literals and merging adjacent literal segments. It keeps the parsed representation compact.

**Data flow**: It takes a mutable `Vec<Segment>` and a `literal: &str`. If the literal is empty it returns immediately; otherwise it either appends to the last `Segment::Literal` in place or pushes a new `Segment::Literal(literal.to_string())`.

**Call relations**: This helper is called repeatedly from `Template::parse` whenever the scanner crosses into or out of placeholders or escaped delimiters. It centralizes literal coalescing so the parser does not emit fragmented adjacent literals.

*Call graph*: called by 1 (parse); 1 external calls (Literal).


##### `parse_placeholder`  (lines 235–259)

```
fn parse_placeholder(source: &str, start: usize) -> Result<(String, usize), TemplateParseError>
```

**Purpose**: Parses the contents of one `{{ ... }}` placeholder starting at a known opening delimiter. It trims surrounding whitespace and rejects empty, nested, or unterminated placeholders.

**Data flow**: It takes the full `source` and the byte index `start` of the opening `{{`, sets `placeholder_start` after the delimiter, then scans forward by UTF-8 characters. Encountering another `{{` before `}}` returns `NestedPlaceholder`; encountering `}}` trims the substring between delimiters and returns `EmptyPlaceholder` if blank or otherwise returns `(placeholder.to_string(), next_cursor)`; reaching the end without `}}` returns `UnterminatedPlaceholder`.

**Call relations**: This helper is called only from `Template::parse` when the scanner sees `{{`. It isolates placeholder-body validation and cursor advancement from the outer parse loop.

*Call graph*: called by 1 (parse).


##### `build_variable_map`  (lines 261–280)

```
fn build_variable_map(
    variables: I,
) -> Result<BTreeMap<String, String>, TemplateRenderError>
```

**Purpose**: Consumes the caller-provided variable pairs into an owned map while rejecting duplicate names. It normalizes all keys and values to owned `String`s for rendering.

**Data flow**: It takes an iterable of `(K, V)` where both sides implement `AsRef<str>`, creates a `BTreeMap<String, String>`, inserts each pair after converting both name and value to owned strings, and returns `DuplicateValue` if an insertion replaces an existing entry; otherwise it returns the completed map.

**Call relations**: This helper is called by `Template::render` before any placeholder validation or substitution. It separates duplicate detection and ownership conversion from the rest of the rendering logic.

*Call graph*: called by 1 (render); 1 external calls (new).


##### `tests::render_replaces_placeholders_with_and_without_whitespace`  (lines 292–303)

```
fn render_replaces_placeholders_with_and_without_whitespace()
```

**Purpose**: Verifies that placeholders render correctly whether or not whitespace appears inside the delimiters, and that repeated placeholders reuse the same value. It demonstrates the basic happy path of the one-shot API.

**Data flow**: The test calls the free `render` function with a template containing `{{ name }}` and `{{place}}`, unwraps the result, and asserts the final rendered string matches the expected interpolation.

**Call relations**: It exercises the full parse-and-render pipeline through the top-level `render` helper.

*Call graph*: calls 1 internal fn (render); 1 external calls (assert_eq!).


##### `tests::parsed_templates_can_be_reused`  (lines 306–317)

```
fn parsed_templates_can_be_reused()
```

**Purpose**: Checks that a parsed `Template` can be rendered multiple times with different variable sets. It validates the separation between parse-time structure and render-time data.

**Data flow**: The test parses `"{{greeting}}, {{ name }}!"` once, then calls `template.render(...)` twice with different values and asserts both rendered outputs.

**Call relations**: It exercises `Template::parse` followed by repeated `Template::render` calls on the same compiled template.

*Call graph*: calls 1 internal fn (parse); 1 external calls (assert_eq!).


##### `tests::placeholders_are_sorted_and_unique`  (lines 320–324)

```
fn placeholders_are_sorted_and_unique()
```

**Purpose**: Verifies that placeholder enumeration removes duplicates and yields names in sorted order. It documents the `BTreeSet`-backed behavior of `Template::placeholders`.

**Data flow**: The test parses a template containing placeholders `b`, `a`, and `b` again, collects `template.placeholders()` into a `Vec<_>`, and asserts it equals `["a", "b"]`.

**Call relations**: It exercises `Template::parse` and `Template::placeholders`, specifically the unique/sorted placeholder metadata path rather than rendering.

*Call graph*: calls 1 internal fn (parse); 1 external calls (assert_eq!).


##### `tests::render_supports_multiline_templates_and_adjacent_placeholders`  (lines 327–335)

```
fn render_supports_multiline_templates_and_adjacent_placeholders()
```

**Purpose**: Checks that rendering works across newlines and with placeholders placed directly adjacent to each other. It validates that no separator text is implicitly inserted.

**Data flow**: The test calls the free `render` helper on a two-line template containing `{{first}}{{second}}` adjacency and asserts the output is `"Line 1: AB\nLine 2: C"`.

**Call relations**: It exercises the normal parse/render flow with multiline literals and back-to-back placeholder segments.

*Call graph*: calls 1 internal fn (render); 1 external calls (assert_eq!).


##### `tests::render_supports_literal_delimiter_escapes`  (lines 338–349)

```
fn render_supports_literal_delimiter_escapes()
```

**Purpose**: Verifies that `{{{{` and `}}}}` are parsed as literal `{{` and `}}` rather than placeholder delimiters. It documents the escape syntax supported by the parser.

**Data flow**: The test renders a template containing escaped delimiters plus one real placeholder and asserts the output contains literal braces and the substituted value in the expected positions.

**Call relations**: It exercises the escape-handling branches in `Template::parse` through the top-level `render` helper.

*Call graph*: calls 1 internal fn (render); 1 external calls (assert_eq!).


##### `tests::parse_errors_when_placeholder_is_empty`  (lines 352–356)

```
fn parse_errors_when_placeholder_is_empty()
```

**Purpose**: Checks that a placeholder containing only whitespace is rejected as empty. It validates one parse error variant and its byte offset.

**Data flow**: The test calls `Template::parse("Hello, {{   }}.")`, unwraps the error, and asserts it equals `TemplateParseError::EmptyPlaceholder { start: 7 }`.

**Call relations**: It exercises the empty-placeholder branch in `parse_placeholder` via `Template::parse`.

*Call graph*: calls 1 internal fn (parse); 1 external calls (assert_eq!).


##### `tests::parse_errors_when_placeholder_is_unterminated`  (lines 359–366)

```
fn parse_errors_when_placeholder_is_unterminated()
```

**Purpose**: Checks that a placeholder missing its closing `}}` is rejected with the correct error and start offset. It validates EOF handling during placeholder parsing.

**Data flow**: The test parses `"Hello, {{ name."`, unwraps the error, and asserts it equals `TemplateParseError::UnterminatedPlaceholder { start: 7 }`.

**Call relations**: It exercises the unterminated-placeholder path in `parse_placeholder` through `Template::parse`.

*Call graph*: calls 1 internal fn (parse); 1 external calls (assert_eq!).


##### `tests::parse_errors_when_placeholder_is_nested`  (lines 369–373)

```
fn parse_errors_when_placeholder_is_nested()
```

**Purpose**: Checks that a placeholder body containing another `{{` is rejected as nested syntax. It enforces the engine’s intentionally simple non-nesting grammar.

**Data flow**: The test parses `"Hello, {{ outer {{ inner }} }}."`, unwraps the error, and asserts it equals `TemplateParseError::NestedPlaceholder { start: 7 }`.

**Call relations**: It exercises the nested-placeholder detection branch in `parse_placeholder`.

*Call graph*: calls 1 internal fn (parse); 1 external calls (assert_eq!).


##### `tests::parse_errors_when_closing_delimiter_is_unmatched`  (lines 376–383)

```
fn parse_errors_when_closing_delimiter_is_unmatched()
```

**Purpose**: Checks that a bare `}}` outside any placeholder is rejected immediately. It validates the parser’s unmatched-closing-delimiter error path.

**Data flow**: The test parses `"Hello, }} world."`, unwraps the error, and asserts it equals `TemplateParseError::UnmatchedClosingDelimiter { start: 7 }`.

**Call relations**: It exercises the explicit unmatched-`}}` branch in `Template::parse`.

*Call graph*: calls 1 internal fn (parse); 1 external calls (assert_eq!).


##### `tests::render_errors_when_placeholder_is_missing`  (lines 386–395)

```
fn render_errors_when_placeholder_is_missing()
```

**Purpose**: Verifies that rendering fails when a required placeholder has no supplied value. It documents strict missing-variable validation.

**Data flow**: The test parses `"Hello, {{ name }}."`, calls `template.render` with an empty vector, and asserts the result is `Err(TemplateRenderError::MissingValue { name: "name".to_string() })`.

**Call relations**: It exercises the missing-placeholder validation loop in `Template::render` after successful parsing.

*Call graph*: calls 1 internal fn (parse); 1 external calls (assert_eq!).


##### `tests::render_errors_when_extra_value_is_provided`  (lines 398–407)

```
fn render_errors_when_extra_value_is_provided()
```

**Purpose**: Verifies that rendering fails when the caller supplies a variable not used by the template. It documents strict rejection of extra inputs.

**Data flow**: The test parses `"Hello, {{ name }}."`, renders with `name` plus an unused `unused` variable, and asserts the result is `Err(TemplateRenderError::ExtraValue { name: "unused".to_string() })`.

**Call relations**: It exercises the extra-variable validation loop in `Template::render`.

*Call graph*: calls 1 internal fn (parse); 1 external calls (assert_eq!).


##### `tests::render_errors_when_duplicate_value_is_provided`  (lines 410–419)

```
fn render_errors_when_duplicate_value_is_provided()
```

**Purpose**: Checks that duplicate variable names in the input iterable are rejected before rendering begins. It validates duplicate detection in variable-map construction.

**Data flow**: The test parses `"Hello, {{ name }}."`, renders with two `name` entries, and asserts the result is `Err(TemplateRenderError::DuplicateValue { name: "name".to_string() })`.

**Call relations**: It exercises `build_variable_map` through `Template::render`, specifically the duplicate-insert error path.

*Call graph*: calls 1 internal fn (parse); 1 external calls (assert_eq!).


##### `tests::render_function_wraps_parse_errors`  (lines 422–429)

```
fn render_function_wraps_parse_errors()
```

**Purpose**: Verifies that the one-shot `render` helper wraps parse failures in `TemplateError::Parse`. It documents the error-shaping behavior of the convenience API.

**Data flow**: The test calls the free `render` function on an invalid template with otherwise irrelevant variables, unwraps the error, and asserts it equals `TemplateError::Parse(TemplateParseError::UnmatchedClosingDelimiter { start: 7 })`.

**Call relations**: It exercises the parse phase of the top-level `render` helper and the `From<TemplateParseError> for TemplateError` conversion.

*Call graph*: calls 1 internal fn (render); 1 external calls (assert_eq!).


##### `tests::render_function_wraps_render_errors`  (lines 432–441)

```
fn render_function_wraps_render_errors()
```

**Purpose**: Verifies that the one-shot `render` helper wraps render-time validation failures in `TemplateError::Render`. It documents the second half of the convenience API’s error contract.

**Data flow**: The test calls the free `render` function on a valid template with only an extra variable, unwraps the error, and asserts it equals `TemplateError::Render(TemplateRenderError::MissingValue { name: "name".to_string() })`.

**Call relations**: It exercises the successful parse plus failing render path through the top-level `render` helper and the `From<TemplateRenderError> for TemplateError` conversion.

*Call graph*: calls 1 internal fn (render); 1 external calls (assert_eq!).
