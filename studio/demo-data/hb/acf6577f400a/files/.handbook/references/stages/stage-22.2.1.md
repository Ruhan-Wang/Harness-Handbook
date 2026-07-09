# Generic string, formatting, truncation, and templating utilities  `stage-22.2.1`

This stage is shared behind-the-scenes support for making text safe, short, and easy to read across the project. It is like a set of measuring cups and labels used by many kitchens, not the main cooking itself.

The string utilities clean and convert text safely. They can produce ASCII-only JSON for places that may reject Unicode, shorten long strings without breaking emoji or non-English characters, and prepare safe metric tags or terminal-friendly code links. Number and elapsed-time formatters turn raw values into labels people can scan, like “12,000”, “12K”, or “1m 15s”. CLI helpers display environment variable names without leaking their values, and build copy-safe “resume” commands for old threads.

Several tools keep text from overwhelming the system. Output truncation preserves useful beginning and ending context, while response-history trimming keeps conversations within a reusable size budget. The strict template helper fills placeholders such as “{{ name }}” and catches missing or mistaken fields. Web search formatting and TUI text helpers turn actions, paths, JSON, and long tool output into compact readable labels for narrow displays.

## Files in this stage

### Core string utilities
These files define the shared string helper surface, including ASCII-safe JSON emission and UTF-8-safe truncation primitives that other callers can build on.

### `utils/string/src/json.rs`

`util` · `cross-cutting`

Normal JSON can contain characters from many languages, such as Japanese text, Turkish letters, or emoji. That is usually fine, but some transport channels are safest when every byte is plain ASCII, the small character set used by older English-only systems. This file solves that problem by serializing JSON normally while changing any non-ASCII character inside strings into JSON escape sequences like `\u6771`.

The key idea is like writing an international address on a form that only accepts basic letters: the meaning is preserved, but the writing is converted into an allowed form. The JSON is still valid JSON, and when another program reads it back, it gets the original Unicode text again.

The file defines a custom JSON formatter, `AsciiJsonFormatter`, for `serde_json`, the Rust JSON library. `serde_json` already knows how to serialize structs, maps, numbers, booleans, and so on. This formatter only steps in when a piece of a string is being written. It copies ordinary ASCII text as-is, and replaces each non-ASCII character with one or two `\uXXXX` escape codes, as JSON expects.

The public function `to_ascii_json_string` is the simple entry point: give it any serializable value, and it returns a JSON string that is guaranteed to be ASCII if serialization succeeds. The included test proves both sides: the output contains only escaped ASCII text, and parsing it back produces the original data.

#### Function details

##### `AsciiJsonFormatter::write_string_fragment`  (lines 13–39)

```
fn write_string_fragment(&mut self, writer: &mut W, fragment: &str) -> io::Result<()>
```

**Purpose**: This function writes part of a JSON string while making sure any non-ASCII character is escaped. It lets the normal JSON serializer keep control of the overall JSON format, while this function only changes unsafe string characters into safe `\uXXXX` text.

**Data flow**: It receives a writable output destination and a fragment of string text. It scans the fragment character by character, writes unchanged ASCII stretches directly, and turns each non-ASCII character into UTF-16 code units written as JSON Unicode escapes. The output destination gains only ASCII bytes for this fragment, and the function reports success or any write error.

**Call relations**: This function is called by `serde_json` through the custom formatter whenever string content is being emitted. It relies on ordinary writing operations to copy safe bytes and to write escape sequences, then hands control back to the serializer so the rest of the JSON can continue normally.

*Call graph*: 2 external calls (write_all, write!).


##### `to_ascii_json_string`  (lines 46–55)

```
fn to_ascii_json_string(value: &T) -> serde_json::Result<String>
```

**Purpose**: This is the public helper callers use when they need JSON text that is valid JSON and ASCII-only. A caller gives it any value that can be serialized, and it returns a JSON string with non-ASCII string content escaped.

**Data flow**: It starts with the input value and an empty byte buffer. It creates a JSON serializer using `AsciiJsonFormatter`, asks the value to serialize itself into that serializer, then converts the collected bytes into a Rust `String`. On success, the result is JSON text; if serialization or byte-to-string conversion fails, it returns a JSON error.

**Call relations**: Higher-level code calls this when it needs ASCII-safe JSON. In this file, the test calls it with a payload containing Japanese text, a Turkish character, and an emoji. Internally it hands the actual JSON writing to `serde_json`, with `AsciiJsonFormatter` providing the special string escaping behavior.

*Call graph*: called by 1 (to_ascii_json_string_escapes_non_ascii_strings); 4 external calls (from_utf8, serialize, new, with_formatter).


##### `tests::to_ascii_json_string_escapes_non_ascii_strings`  (lines 70–121)

```
fn to_ascii_json_string_escapes_non_ascii_strings()
```

**Purpose**: This test checks that `to_ascii_json_string` really escapes non-ASCII characters without changing the meaning of the JSON. It guards against regressions where Unicode text might accidentally be emitted directly or escaped incorrectly.

**Data flow**: It builds a small custom serializable payload containing a map key with Japanese characters, a label with a Turkish dotless letter, and an emoji. It serializes that payload using `to_ascii_json_string`, checks that the exact output uses JSON Unicode escapes and contains only ASCII, then parses the output back into JSON and compares it with the expected original value.

**Call relations**: The test is the direct caller of `to_ascii_json_string` in this file. After receiving the serialized text, it uses assertions and JSON parsing to verify both the byte-level requirement, meaning ASCII-only output, and the data-level requirement, meaning the JSON still represents the same value.

*Call graph*: calls 1 internal fn (to_ascii_json_string); 4 external calls (assert!, assert_eq!, json!, from_str).


### `utils/string/src/truncate.rs`

`util` · `cross-cutting text/output preparation`

This file solves a common display problem: sometimes the program has a long piece of text, such as command output or a log, but only has room to show part of it. Instead of simply chopping off the end, it keeps a slice from the start and a slice from the end, then places a clear message in the middle saying how much was removed. This is like folding a long receipt so you can still read the header and the final total.

The code has two public ways to truncate. One works with a byte limit and reports removed characters. The other works with an approximate token budget, where a token is a rough chunk of text used by language models; this file estimates one token as about four bytes. The estimate is intentionally simple and fast, not exact.

The main internal routine checks for easy cases first: empty text, zero budget, or text that already fits. If truncation is needed, it splits the available space between the left and right sides, finds safe cut points at real character boundaries, counts what was removed, builds the marker text, and joins everything together. The most important safety detail is that it walks through characters rather than slicing blindly by byte position, because Rust strings are UTF-8 and some characters use more than one byte.

#### Function details

##### `truncate_middle_chars`  (lines 7–9)

```
fn truncate_middle_chars(s: &str, max_bytes: usize) -> String
```

**Purpose**: Shortens a string to a maximum byte budget while preserving the start and end. The marker in the middle says how many characters were removed.

**Data flow**: It receives the original text and a maximum number of bytes. It passes those to the shared truncation routine with character-count reporting turned on, and returns the resulting string.

**Call relations**: This is the simple public entry point for character-based truncation. It delegates all real work to truncate_with_byte_estimate, which performs the safe splitting and marker creation.

*Call graph*: calls 1 internal fn (truncate_with_byte_estimate).


##### `truncate_middle_with_token_budget`  (lines 15–36)

```
fn truncate_middle_with_token_budget(s: &str, max_tokens: usize) -> (String, Option<u64>)
```

**Purpose**: Shortens text to fit an approximate token budget, while still keeping both the beginning and the end. It also tells the caller the estimated original token count when truncation actually happened.

**Data flow**: It receives text and a maximum number of approximate tokens. Empty text becomes an empty string with no truncation note. If the text already fits the estimated byte budget, it is returned unchanged. Otherwise, the token budget is converted into an approximate byte budget, the text is truncated, and the original token count is estimated and returned if the text changed.

**Call relations**: This is the public entry point for callers that think in tokens rather than bytes, such as code preparing text for a language-model prompt. It uses approx_bytes_for_tokens to turn the budget into bytes, truncate_with_byte_estimate to do the actual trimming, and approx_token_count to report the original size.

*Call graph*: calls 3 internal fn (approx_bytes_for_tokens, approx_token_count, truncate_with_byte_estimate); 2 external calls (new, try_from).


##### `truncate_with_byte_estimate`  (lines 38–69)

```
fn truncate_with_byte_estimate(s: &str, max_bytes: usize, use_tokens: bool) -> String
```

**Purpose**: This is the central worker that decides whether a string needs shortening and, if so, builds the final shortened version. It can label the removed middle either as characters or as approximate tokens.

**Data flow**: It receives text, a maximum byte budget, and a choice of whether the marker should talk about tokens or characters. It returns early for empty text, zero budget, or text that already fits. When truncation is needed, it splits the byte budget between the front and back, extracts safe prefix and suffix slices, calculates the removed amount, creates the marker, and returns prefix plus marker plus suffix.

**Call relations**: Both public truncation functions call this routine so they share the same behavior. It coordinates the helper functions: split_budget divides the space, split_string finds safe slices, removed_units chooses the right count, format_truncation_marker writes the middle message, and assemble_truncated_output joins the final text.

*Call graph*: calls 5 internal fn (assemble_truncated_output, format_truncation_marker, removed_units, split_budget, split_string); called by 2 (truncate_middle_chars, truncate_middle_with_token_budget); 1 external calls (new).


##### `approx_token_count`  (lines 71–74)

```
fn approx_token_count(text: &str) -> usize
```

**Purpose**: Estimates how many tokens a piece of text contains using the file’s simple rule of about four bytes per token. This is useful when the program needs a quick size estimate rather than an exact tokenizer.

**Data flow**: It receives text, reads its byte length, rounds that length up to the nearest four-byte group, and returns the resulting token estimate.

**Call relations**: truncate_middle_with_token_budget calls this after truncation so it can tell the caller roughly how large the original text was. It does not call other project code; it is a small calculation helper.

*Call graph*: called by 1 (truncate_middle_with_token_budget).


##### `approx_bytes_for_tokens`  (lines 76–78)

```
fn approx_bytes_for_tokens(tokens: usize) -> usize
```

**Purpose**: Converts an approximate token limit into an approximate byte limit. It uses the same four-bytes-per-token rule as the rest of this file.

**Data flow**: It receives a token count, multiplies it by the approximate bytes per token, and returns the byte budget. The multiplication is saturating, meaning it avoids overflowing if the number is extremely large.

**Call relations**: truncate_middle_with_token_budget uses this before truncating, because the underlying truncation routine works with byte budgets. This function is the bridge from token-based thinking to byte-based slicing.

*Call graph*: called by 1 (truncate_middle_with_token_budget).


##### `approx_tokens_from_byte_count`  (lines 80–84)

```
fn approx_tokens_from_byte_count(bytes: usize) -> u64
```

**Purpose**: Estimates how many tokens a number of bytes represents. It rounds upward so that any leftover bytes still count as another token-sized chunk.

**Data flow**: It receives a byte count, converts it to a 64-bit number, divides by the four-byte token estimate with rounding up, and returns the approximate token count.

**Call relations**: removed_units calls this when the truncation marker needs to report removed tokens instead of removed characters. It keeps token-count math in one place.

*Call graph*: called by 1 (removed_units).


##### `split_string`  (lines 86–124)

```
fn split_string(s: &str, beginning_bytes: usize, end_bytes: usize) -> (usize, &str, &str)
```

**Purpose**: Finds the safe beginning and ending pieces to keep from a string. Its main job is to avoid cutting in the middle of a UTF-8 character.

**Data flow**: It receives the original text, a byte budget for the beginning, and a byte budget for the end. It walks character by character, chooses the last safe prefix boundary within the beginning budget, chooses the first safe suffix boundary near the end, counts the characters skipped in the middle, and returns the removed character count plus the two string slices to keep.

**Call relations**: truncate_with_byte_estimate calls this once it knows how much room to give the prefix and suffix. The slices it returns are later combined with the marker by assemble_truncated_output.

*Call graph*: called by 1 (truncate_with_byte_estimate).


##### `split_budget`  (lines 126–129)

```
fn split_budget(budget: usize) -> (usize, usize)
```

**Purpose**: Divides the available byte budget between the beginning and the end of the string. It gives about half to each side, with any odd extra byte going to the end.

**Data flow**: It receives one total budget number. It calculates the left half and returns that plus the remaining amount for the right side.

**Call relations**: truncate_with_byte_estimate calls this before asking split_string for the actual prefix and suffix. It keeps the policy of “show both ends” simple and consistent.

*Call graph*: called by 1 (truncate_with_byte_estimate).


##### `format_truncation_marker`  (lines 131–137)

```
fn format_truncation_marker(use_tokens: bool, removed_count: u64) -> String
```

**Purpose**: Creates the visible message that sits between the kept beginning and ending text. The message says either how many tokens or how many characters were removed.

**Data flow**: It receives a flag saying whether to talk about tokens and a count of removed units. It formats a string such as “... tokens truncated ...” or “... chars truncated ...” using an ellipsis character.

**Call relations**: truncate_with_byte_estimate calls this after it has calculated what was removed. The returned marker is then inserted between the prefix and suffix.

*Call graph*: called by 1 (truncate_with_byte_estimate); 1 external calls (format!).


##### `removed_units`  (lines 139–145)

```
fn removed_units(use_tokens: bool, removed_bytes: usize, removed_chars: usize) -> u64
```

**Purpose**: Chooses the number that should appear in the truncation marker. It reports either approximate tokens removed or characters removed, depending on how the caller wants to describe the truncation.

**Data flow**: It receives a choice between token mode and character mode, plus the removed byte count and removed character count. In token mode it converts bytes to approximate tokens; in character mode it converts the character count into the marker’s numeric type. The result is a 64-bit count suitable for display.

**Call relations**: truncate_with_byte_estimate calls this just before creating the marker. When token reporting is needed, it hands the byte count to approx_tokens_from_byte_count; otherwise it uses the character count gathered by split_string.

*Call graph*: calls 1 internal fn (approx_tokens_from_byte_count); called by 1 (truncate_with_byte_estimate); 1 external calls (try_from).


##### `assemble_truncated_output`  (lines 147–153)

```
fn assemble_truncated_output(prefix: &str, suffix: &str, marker: &str) -> String
```

**Purpose**: Builds the final shortened string from the kept beginning, the marker, and the kept ending. It is the last step of the truncation process.

**Data flow**: It receives three string pieces: prefix, suffix, and marker. It creates a new string with enough space for them, appends the prefix, then the marker, then the suffix, and returns the combined result.

**Call relations**: truncate_with_byte_estimate calls this after all decisions have been made. It does not decide what to keep or what to report; it simply puts the prepared pieces together.

*Call graph*: called by 1 (truncate_with_byte_estimate); 1 external calls (with_capacity).


### `utils/string/src/lib.rs`

`util` · `cross-cutting`

This file gathers string utilities that are useful across the project. Some of the tools are defined here, and others are re-exported from nearby modules so callers can import them from one simple place. In everyday terms, it is like a shared drawer of text-safe scissors, labels, and format converters.

The file solves several practical problems. Rust strings are stored as bytes, but human characters can take more than one byte. `take_bytes_at_char_boundary` makes sure text is shortened only between complete characters, so the result is still valid text. `sanitize_metric_tag_value` turns arbitrary user or system text into a safe metric tag value, replacing characters that monitoring systems may reject and falling back to `unspecified` when nothing meaningful remains. `find_uuids` scans text for UUIDs, which are standard unique ID strings. `normalize_markdown_hash_location_suffix` converts Markdown-style source links like `#L74C3-L76C9` into the more familiar terminal format `:74:3-76:9`.

The tests at the bottom act as examples and safeguards. They check that UUID searching, tag cleanup, and location conversion behave correctly, including edge cases such as non-ASCII characters and invalid tag values.

#### Function details

##### `take_bytes_at_char_boundary`  (lines 13–26)

```
fn take_bytes_at_char_boundary(s: &str, maxb: usize) -> &str
```

**Purpose**: Returns the beginning of a string without going over a requested byte limit, while making sure it never cuts through the middle of a character. This matters for non-English text and emoji, where one visible character can use several bytes.

**Data flow**: It receives a string slice and a maximum byte count. If the whole string already fits, it returns it unchanged. Otherwise it walks character by character, remembers the last byte position that ended cleanly after a full character, and returns the prefix up to that safe point.

**Call relations**: This is a standalone utility for any code that needs a byte-sized preview or prefix of text. It does not call other project functions; callers use it when they need shortening that keeps the string valid.


##### `sanitize_metric_tag_value`  (lines 30–51)

```
fn sanitize_metric_tag_value(value: &str) -> String
```

**Purpose**: Turns any text into a safe metric tag value. Metric tags are labels sent to monitoring systems, and those systems often reject spaces, punctuation, or empty-looking values.

**Data flow**: It receives a text value. It replaces every character that is not an ASCII letter, digit, dot, underscore, hyphen, or slash with an underscore. Then it removes underscores from the beginning and end, checks whether anything useful is left, returns `unspecified` if not, and otherwise limits the result to 256 characters.

**Call relations**: This function stands on its own as a cleanup step before sending labels to metrics or monitoring code. The tests call it with awkward values to show that it replaces bad characters and avoids producing empty or meaningless tags.


##### `find_uuids`  (lines 55–65)

```
fn find_uuids(s: &str) -> Vec<String>
```

**Purpose**: Finds UUIDs inside a larger piece of text. A UUID is a common 36-character unique identifier, written as groups of hexadecimal characters separated by hyphens.

**Data flow**: It receives a string to scan. The first time it runs, it builds and stores a regular expression, which is a search pattern for UUID-shaped text. It then searches the input, copies every matching UUID into a new list, and returns that list of strings.

**Call relations**: This function uses the external regular-expression constructor `new` to create its UUID search pattern once and reuse it later. The tests call it to confirm it finds multiple UUIDs, skips invalid lookalikes, and works correctly when non-ASCII characters appear nearby.

*Call graph*: 1 external calls (new).


##### `normalize_markdown_hash_location_suffix`  (lines 69–92)

```
fn normalize_markdown_hash_location_suffix(suffix: &str) -> Option<String>
```

**Purpose**: Converts a Markdown-style code location suffix into a format that is easier to use in terminals and editor-like output. For example, it can turn `#L74C3-L76C9` into `:74:3-76:9`.

**Data flow**: It receives a suffix string. It first requires the string to start with `#`; if not, it gives back `None`, meaning it could not convert it. It then separates a start point and optional end point, asks `parse_markdown_hash_location_point` to read each point, and builds a new string using colons for line and column numbers. If any required piece cannot be parsed in the expected shape, it returns `None`; otherwise it returns the normalized suffix.

**Call relations**: This function is the public converter for source-location suffixes. It relies on `parse_markdown_hash_location_point` for the smaller job of reading one `L...C...` point, and uses the standard string-building conversion `from` while assembling the result. The location-format tests call it for both a single point and a range.

*Call graph*: calls 1 internal fn (parse_markdown_hash_location_point); 1 external calls (from).


##### `parse_markdown_hash_location_point`  (lines 94–100)

```
fn parse_markdown_hash_location_point(point: &str) -> Option<(&str, Option<&str>)>
```

**Purpose**: Reads one Markdown-style location point such as `L74` or `L74C3`. It extracts the line number and, when present, the column number.

**Data flow**: It receives one point string. It requires the string to begin with `L`; if that marker is missing, it returns `None`. After the `L`, it looks for `C`: if found, the text before `C` becomes the line and the text after it becomes the column; if not found, the whole remainder becomes the line with no column.

**Call relations**: This is a small helper used by `normalize_markdown_hash_location_suffix`. The larger converter calls it once for the start point and, for ranges, once more for the end point, so the parsing rules stay in one place.

*Call graph*: called by 1 (normalize_markdown_hash_location_suffix).


##### `tests::find_uuids_finds_multiple`  (lines 111–121)

```
fn find_uuids_finds_multiple()
```

**Purpose**: Checks that UUID searching can find more than one valid UUID in the same input string.

**Data flow**: It creates a sample string containing two UUIDs mixed with other text. It calls `find_uuids` and compares the returned list with the two expected UUID strings.

**Call relations**: This test supports `find_uuids` by showing the normal success path. It uses the external `assert_eq!` test macro to fail loudly if the returned list is not exactly right.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::find_uuids_ignores_invalid`  (lines 124–127)

```
fn find_uuids_ignores_invalid()
```

**Purpose**: Checks that UUID searching does not accept text that only partly looks like a UUID.

**Data flow**: It creates an invalid UUID-like string, passes it to `find_uuids`, and expects an empty list back.

**Call relations**: This test guards against false positives in `find_uuids`. It uses `assert_eq!` to compare the actual result with an empty vector.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::find_uuids_handles_non_ascii_without_overlap`  (lines 130–136)

```
fn find_uuids_handles_non_ascii_without_overlap()
```

**Purpose**: Checks that UUID searching still works correctly when non-ASCII text, such as an emoji, appears near the UUID.

**Data flow**: It builds an input string containing an emoji followed by a UUID plus extra trailing characters. It calls `find_uuids` and expects only the valid UUID-length part to be returned.

**Call relations**: This test protects `find_uuids` around Unicode text and nearby extra characters. It uses `assert_eq!` to verify the search result exactly.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::sanitize_metric_tag_value_trims_and_fills_unspecified`  (lines 139–142)

```
fn sanitize_metric_tag_value_trims_and_fills_unspecified()
```

**Purpose**: Checks that a metric tag value made only of non-meaningful allowed punctuation does not survive as an empty or useless label.

**Data flow**: It passes `///` into `sanitize_metric_tag_value`. After trimming and validation, the expected output is `unspecified`.

**Call relations**: This test documents an important fallback behavior of `sanitize_metric_tag_value`. It uses `assert_eq!` to make sure the fallback word is returned.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::sanitize_metric_tag_value_replaces_invalid_chars`  (lines 145–148)

```
fn sanitize_metric_tag_value_replaces_invalid_chars()
```

**Purpose**: Checks that invalid characters in a metric tag value are replaced with underscores and then cleaned up at the edges.

**Data flow**: It passes `bad value!` into `sanitize_metric_tag_value`. The space and exclamation mark are replaced with underscores, the trailing underscore is trimmed away, and the expected result is `bad_value`.

**Call relations**: This test demonstrates the common cleanup path for `sanitize_metric_tag_value`. It uses `assert_eq!` to compare the cleaned value with the expected safe tag.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::normalize_markdown_hash_location_suffix_converts_single_location`  (lines 151–156)

```
fn normalize_markdown_hash_location_suffix_converts_single_location()
```

**Purpose**: Checks that a single Markdown-style line and column marker is converted into terminal-style notation.

**Data flow**: It passes `#L74C3` into `normalize_markdown_hash_location_suffix` and expects `Some(":74:3")` back.

**Call relations**: This test covers the single-location path through `normalize_markdown_hash_location_suffix`, which in turn uses `parse_markdown_hash_location_point`. It uses `assert_eq!` to verify the exact converted string.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::normalize_markdown_hash_location_suffix_converts_ranges`  (lines 159–164)

```
fn normalize_markdown_hash_location_suffix_converts_ranges()
```

**Purpose**: Checks that a Markdown-style range with start and end positions is converted correctly.

**Data flow**: It passes `#L74C3-L76C9` into `normalize_markdown_hash_location_suffix` and expects `Some(":74:3-76:9")` back.

**Call relations**: This test covers the range path through `normalize_markdown_hash_location_suffix`, where the helper parser is used for both endpoints. It uses `assert_eq!` to confirm the final range format.

*Call graph*: 1 external calls (assert_eq!).


### Formatting and presentation helpers
These utilities format values and user-facing text into concise, readable display strings across durations, numbers, environment settings, resume hints, and web-search action details.

### `protocol/src/num_format.rs`

`util` · `cross-cutting`

This file is about making numbers easier for people to read. A raw number like 123456789 is precise, but it is hard to scan quickly. This code can display it as "123,456,789" with the right separator for the user's region, or as "123M" when a compact summary is better.

The file first builds a decimal formatter, which is an object from the ICU library that knows how to write numbers for a particular language and region. For example, some locales use commas between thousands, while others use spaces or periods. The code tries to detect the computer's current locale. If that fails, it uses "en-US" as a safe default. The chosen formatter is stored once in a `OnceLock`, which is like putting a shared tool on a workbench: it is created the first time someone needs it, then reused after that.

There are two public helpers. `format_with_separators` keeps the full number but adds grouping separators. `format_si_suffix` shortens non-negative counts to about three significant figures using base-10 suffixes: K for thousands, M for millions, and G for billions. Very large values above 1000G stay in G rather than introducing a larger unit. The test checks the boundary cases where rounding changes one suffix into the next.

#### Function details

##### `make_local_formatter`  (lines 8–11)

```
fn make_local_formatter() -> Option<DecimalFormatter>
```

**Purpose**: This function tries to create a number formatter that matches the user's current system locale. Someone uses it when they want numbers to look natural for the person running the program.

**Data flow**: It starts with no input. It asks the operating system for the current locale, tries to parse that locale into ICU's locale format, and then asks ICU to build a decimal formatter with default options. If any step fails, it returns nothing; if all steps work, it returns a ready-to-use formatter.

**Call relations**: This is part of the setup path for the shared formatter. `formatter` calls it when the program first needs number formatting, and if it cannot produce a local formatter, `formatter` falls back to the built-in US English formatter.

*Call graph*: 3 external calls (try_new, default, get_locale).


##### `make_en_us_formatter`  (lines 13–18)

```
fn make_en_us_formatter() -> DecimalFormatter
```

**Purpose**: This function creates a guaranteed fallback number formatter for US English. It is used when the program cannot detect or use the user's own locale.

**Data flow**: It starts with the fixed locale text `en-US`, parses it, and builds an ICU decimal formatter with default options. Because `en-US` is expected to always be valid, failures are treated as impossible programmer or library errors and cause the program to stop rather than silently continue.

**Call relations**: The shared `formatter` uses this when local formatter creation fails. The test `tests::kmg` also calls it directly so the expected outputs are stable, because US English formatting always uses commas and periods in the tested way.

*Call graph*: called by 1 (kmg); 2 external calls (try_new, default).


##### `formatter`  (lines 20–23)

```
fn formatter() -> &'static DecimalFormatter
```

**Purpose**: This function provides one shared decimal formatter for the rest of the file. It avoids rebuilding the formatter every time a number is printed.

**Data flow**: It receives no input. The first time it is called, it creates a formatter by trying the user's locale and then falling back to US English. It stores that formatter in a `OnceLock`, a one-time storage cell, and returns a shared reference to it. Later calls simply return the same stored formatter.

**Call relations**: `format_with_separators` and `format_si_suffix` call this whenever they need locale-aware number formatting. It is the small central doorway between the public formatting helpers and the formatter-building functions.

*Call graph*: called by 2 (format_si_suffix, format_with_separators); 1 external calls (new).


##### `format_with_separators`  (lines 27–29)

```
fn format_with_separators(n: i64) -> String
```

**Purpose**: This public function writes a whole number with locale-aware digit grouping, such as turning `12345` into `12,345` in US English. It is useful wherever the program wants an exact number that is easier to read.

**Data flow**: It takes an `i64`, which is a signed 64-bit whole number. It gets the shared formatter, converts the number into ICU's decimal input type, formats it, and returns the result as a `String`. It does not change any outside data except possibly causing the shared formatter to be created on first use.

**Call relations**: Other parts of the project, such as `format_credit_amount`, call this when they need readable full-size numbers. Internally it relies on `formatter` for the locale-specific rules.

*Call graph*: calls 1 internal fn (formatter); called by 1 (format_credit_amount); 1 external calls (from).


##### `format_with_separators_with_formatter`  (lines 31–33)

```
fn format_with_separators_with_formatter(n: i64, formatter: &DecimalFormatter) -> String
```

**Purpose**: This helper formats a whole number with separators using a formatter supplied by the caller. It exists so code that already has a specific formatter, especially internal code or tests, can avoid using the global shared one.

**Data flow**: It takes a number and a reference to a decimal formatter. It converts the number into ICU's decimal representation, asks the supplied formatter to turn it into text, and returns that text as a `String`.

**Call relations**: This is used inside `format_si_suffix_with_formatter` for the special case of extremely large values above 1000G. There, the code still wants grouped digits, but it must use the same formatter that the suffix-formatting path is already using.

*Call graph*: 2 external calls (from, format).


##### `format_si_suffix_with_formatter`  (lines 35–67)

```
fn format_si_suffix_with_formatter(n: i64, formatter: &DecimalFormatter) -> String
```

**Purpose**: This helper shortens a non-negative count into a compact form with K, M, or G while using a caller-provided formatter for the number part. It is the main logic behind compact token-count display.

**Data flow**: It takes a signed whole number and a formatter. Negative inputs are first clamped up to zero, so they display as `0` rather than a negative compact count. Numbers below 1000 are formatted normally. Larger numbers are divided by 1,000, 1,000,000, or 1,000,000,000, rounded to roughly three significant figures, formatted with the supplied formatter, and then given the matching suffix. If the number is above 1000G, it stays in G and the whole-G value is formatted with separators.

**Call relations**: `format_si_suffix` calls this with the shared formatter for normal public use. The test calls it through a small local closure with an explicit US English formatter so the rounding and suffix rules can be checked without depending on the machine's locale.

*Call graph*: called by 1 (format_si_suffix); 3 external calls (from, format, format!).


##### `format_si_suffix`  (lines 75–77)

```
fn format_si_suffix(n: i64) -> String
```

**Purpose**: This public function formats token counts or similar large counts into a short readable form, such as `1.20K` or `123M`. It is meant for places where a compact summary matters more than showing every digit.

**Data flow**: It takes an `i64` count. It gets the shared locale-aware formatter, passes both the count and formatter to `format_si_suffix_with_formatter`, and returns the resulting string. On first use, it may also trigger creation of the shared formatter.

**Call relations**: This is the public wrapper around the suffix-formatting logic. It keeps callers simple: they do not need to know about ICU formatters, locale detection, or the rounding rules.

*Call graph*: calls 2 internal fn (format_si_suffix_with_formatter, formatter).


##### `tests::kmg`  (lines 84–102)

```
fn kmg()
```

**Purpose**: This test checks that compact K, M, and G formatting works at important boundary values. It protects against accidental changes to rounding, suffix choice, and formatting above 1000G.

**Data flow**: It creates a US English formatter, wraps `format_si_suffix_with_formatter` in a small helper closure, and feeds it many representative numbers. For each input, it compares the output string against the expected text. The test produces no returned value; it passes if every comparison matches and fails otherwise.

**Call relations**: The test calls `make_en_us_formatter` directly so its expectations are not affected by the developer's computer locale. It exercises `format_si_suffix_with_formatter`, which is the core logic used by the public `format_si_suffix` function.

*Call graph*: calls 1 internal fn (make_en_us_formatter); 1 external calls (assert_eq!).


### `utils/elapsed/src/lib.rs`

`util` · `cross-cutting`

Computers often measure time in raw units that are precise but awkward for people to read. This file solves that small but common problem: it takes a `Duration` (Rust's standard type for a length of time) and formats it in a compact way for logs, status messages, or user-facing output. The rule is simple. Very short times stay in milliseconds, because "250ms" is clearer than "0.25s". Times under a minute are shown as seconds with two decimal places, such as "1.50s". Times of a minute or more are shown as minutes plus two-digit seconds, such as "3m 05s". The public doorway is `format_duration`, which accepts the standard `Duration` type. It converts that duration into a millisecond count, then passes the number to a private helper, `format_elapsed_millis`, where the actual formatting choices are made. The tests act like examples and guardrails. They check the important boundaries: zero, less than one second, seconds below a minute, exactly one minute, and one hour. One subtle behavior is that 59.999 seconds is formatted as "60.00s" because the seconds display rounds to two decimal places, even though the rule choice is still based on the original millisecond count.

#### Function details

##### `format_duration`  (lines 9–12)

```
fn format_duration(duration: Duration) -> String
```

**Purpose**: This is the public function other code uses when it wants to show an elapsed time in a friendly compact form. It accepts Rust's standard `Duration` value, so callers do not need to think about raw milliseconds themselves.

**Data flow**: A `Duration` goes in. The function reads its total length in milliseconds, turns that into a whole-number millisecond value, and passes it to the formatter helper. A finished string such as "250ms", "1.50s", or "1m 15s" comes out.

**Call relations**: This function is the safe front door for the file. Code outside the file calls it with a normal Rust duration; it then hands the simplified millisecond count to `format_elapsed_millis`, which makes the display decision.

*Call graph*: calls 1 internal fn (format_elapsed_millis); 1 external calls (as_millis).


##### `format_elapsed_millis`  (lines 14–24)

```
fn format_elapsed_millis(millis: i64) -> String
```

**Purpose**: This private helper contains the formatting rules. It decides whether a time should be shown as milliseconds, seconds, or minutes plus seconds.

**Data flow**: A whole-number millisecond count goes in. If it is below 1000, the function writes it as milliseconds. If it is below 60000, it converts the number to seconds and keeps two decimal places. Otherwise, it splits the value into minutes and remaining seconds. The result is a formatted text string.

**Call relations**: This helper is called by `format_duration` after the public function has converted a `Duration` into milliseconds. It does not call back into project code; it only uses Rust's formatting machinery to build the final text.

*Call graph*: called by 1 (format_duration); 1 external calls (format!).


##### `tests::test_format_duration_subsecond`  (lines 31–39)

```
fn test_format_duration_subsecond()
```

**Purpose**: This test checks that times shorter than one second are displayed as plain milliseconds. It also confirms that a zero-length duration is handled cleanly.

**Data flow**: The test creates durations of 250 milliseconds and 0 milliseconds. It sends each one through `format_duration` and compares the returned text with the expected strings "250ms" and "0ms". If either string is different, the test fails.

**Call relations**: This test exercises the public `format_duration` function from the outside, like normal project code would. It protects the first formatting branch, where short durations should not be converted into seconds.

*Call graph*: 2 external calls (from_millis, assert_eq!).


##### `tests::test_format_duration_seconds`  (lines 42–51)

```
fn test_format_duration_seconds()
```

**Purpose**: This test checks the middle range: durations from one second up to just under one minute. It makes sure they are shown as seconds with exactly two decimal places.

**Data flow**: The test creates durations of 1500 milliseconds and 59999 milliseconds. It passes them to `format_duration` and checks that the output is "1.50s" and "60.00s". The second case confirms the rounding behavior near one minute.

**Call relations**: This test calls the same public function that real callers use. It guards the seconds-formatting path inside `format_elapsed_millis`, reached through `format_duration`.

*Call graph*: 2 external calls (from_millis, assert_eq!).


##### `tests::test_format_duration_minutes`  (lines 54–64)

```
fn test_format_duration_minutes()
```

**Purpose**: This test checks that durations of one minute or longer are displayed as minutes plus two-digit seconds. It covers ordinary, exact-boundary, and longer examples.

**Data flow**: The test builds durations for 75 seconds, exactly 60 seconds, and 3601 seconds. Each duration goes through `format_duration`, and the returned strings are compared with "1m 15s", "1m 00s", and "60m 01s". The test changes nothing outside itself; it only verifies results.

**Call relations**: This test reaches the minutes-formatting branch through the public `format_duration` function. It helps ensure that the helper keeps seconds padded with a leading zero when needed.

*Call graph*: 2 external calls (from_millis, assert_eq!).


##### `tests::test_format_duration_one_hour_has_space`  (lines 67–70)

```
fn test_format_duration_one_hour_has_space()
```

**Purpose**: This test confirms the exact formatting of a one-hour duration. In particular, it checks that the output includes a space between the minutes part and the seconds part.

**Data flow**: The test creates a duration of 3600000 milliseconds, sends it to `format_duration`, and expects the string "60m 00s". If the spacing or number format changes, the comparison fails.

**Call relations**: This test is another outside-style check of `format_duration`. It focuses on a presentation detail in the minutes-and-seconds output so that future edits do not accidentally change the visible format.

*Call graph*: 2 external calls (from_millis, assert_eq!).


### `utils/cli/src/format_env_display.rs`

`util` · `cross-cutting CLI display`

Command-line tools often need to show a summary of the environment they will pass to another command. The problem is that environment values can contain secrets, such as tokens, passwords, or private paths. This file solves that by printing the variable names but replacing every value with stars. Think of it like a receipt that lists the items bought but blacks out the credit card number.

The main helper, `format_env_display`, accepts two sources of environment information. One is a map of explicit key-value pairs, where both the variable name and value are already known. The other is a list of variable names that should be forwarded from the current environment. In both cases, the displayed value is always `*****`.

For stable output, the explicit map entries are sorted by variable name before being printed. That matters because maps do not naturally keep a predictable order, and unpredictable output makes logs and tests harder to read. Variables from the list keep the order they were given. If there is nothing to show, the function returns `-`, a compact way to say “no environment variables.”

The rest of the file is a small test suite that checks the empty case, sorting, list formatting, and combining both input sources.

#### Function details

##### `format_env_display`  (lines 3–24)

```
fn format_env_display(
    env: Option<&HashMap<String, String>>,
    env_vars: &[S],
) -> String
```

**Purpose**: Builds a safe display string for environment variables. It keeps the variable names visible but hides every value, so logs or command previews do not leak secrets.

**Data flow**: It receives an optional map of environment variable names to values, plus a list of variable names. If a map is present, it reads its entries, sorts them by name, and turns each one into `NAME=*****`. It then adds the listed variable names in their given order, also as `NAME=*****`. If nothing was added, it returns `-`; otherwise it returns all parts joined with commas.

**Call relations**: This is the file’s useful helper. The test functions call it with different inputs to prove its behavior. Inside, it relies on standard collection operations such as creating a list of parts, checking whether inputs are empty, and iterating through values.

*Call graph*: 3 external calls (is_empty, iter, new).


##### `tests::returns_dash_when_empty`  (lines 31–37)

```
fn returns_dash_when_empty()
```

**Purpose**: Checks that the display uses `-` when there are no environment variables to show. This protects the simple “nothing configured” case from becoming an empty or confusing string.

**Data flow**: It starts with an empty variable list and then tries two inputs: no map at all, and an empty map. In both cases it sends those inputs to `format_env_display` and expects the result to be `-`.

**Call relations**: The Rust test runner calls this test during the test suite. The test exercises `format_env_display` and uses standard assertion support to compare the actual text with the expected text.

*Call graph*: 2 external calls (new, assert_eq!).


##### `tests::formats_sorted_env_pairs`  (lines 40–49)

```
fn formats_sorted_env_pairs()
```

**Purpose**: Checks that explicit environment pairs are shown in a predictable sorted order. This matters because ordinary maps can store entries in an order that is not useful for stable output.

**Data flow**: It creates a map with two variables inserted in reverse alphabetical order. It passes that map to `format_env_display` with no extra variable list. The expected output is `A=*****, B=*****`, proving that the helper sorted by variable name and hid both values.

**Call relations**: The Rust test runner calls this test. The test builds sample input, asks `format_env_display` to format it, and uses an assertion to confirm that the sorting and masking behavior are correct.

*Call graph*: 2 external calls (new, assert_eq!).


##### `tests::formats_env_vars_with_dollar_prefix`  (lines 52–59)

```
fn formats_env_vars_with_dollar_prefix()
```

**Purpose**: Checks that a plain list of environment variable names is formatted safely. Even when only names are supplied, the display still uses masked placeholder values.

**Data flow**: It creates a list containing `TOKEN` and `PATH`. It passes that list to `format_env_display` without an explicit map. The result should be `TOKEN=*****, PATH=*****`, keeping the input order and showing no real values.

**Call relations**: The Rust test runner calls this test. The test uses a small vector of names, calls `format_env_display`, and compares the returned string with the expected display text.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `tests::combines_env_pairs_and_vars`  (lines 62–71)

```
fn combines_env_pairs_and_vars()
```

**Purpose**: Checks that the helper can combine explicit environment values and forwarded variable names in one display string. This covers the realistic case where both kinds of environment input are used together.

**Data flow**: It creates a map containing `HOME` and a separate list containing `TOKEN`. It passes both to `format_env_display`. The expected output is `HOME=*****, TOKEN=*****`, showing the map entry first and the listed variable after it, with both values hidden.

**Call relations**: The Rust test runner calls this test as part of the suite. The test supplies both input paths to `format_env_display` and uses an assertion to make sure the combined output is correct.

*Call graph*: 3 external calls (new, assert_eq!, vec!).


### `utils/cli/src/resume_command.rs`

`util` · `request handling / user-facing CLI message formatting`

When Codex wants to point a user back to an earlier conversation, it needs to show a clear instruction such as `codex resume my-thread`. This file keeps that wording in one shared place so different parts of the command-line tool do not invent slightly different, possibly unsafe versions.

The main job is choosing the best “resume target.” If a non-empty thread name is available, it uses that because it is friendlier for humans. If not, it falls back to the thread ID, which is a unique identifier. If neither exists, it returns nothing because there is no honest command to show.

It also protects against shell confusion. A shell is the program that reads typed commands. Some names need special treatment: names with spaces must be quoted, and names starting with `-` could be mistaken for command options. The file uses shell-style quoting and adds `--` before dash-starting targets, which means “stop reading options; what follows is a value.”

There is a second helper for hints. If both a name and ID exist, it tells the user to run `codex resume` and pick the named item, showing the ID for clarity. If only an ID is useful, it gives the direct command.

#### Function details

##### `resume_command`  (lines 6–20)

```
fn resume_command(thread_name: Option<&str>, thread_id: Option<ThreadId>) -> Option<String>
```

**Purpose**: Builds a copyable `codex resume ...` command from a thread name or thread ID. It prefers a readable name when one is available, but falls back to the ID so the command can still target the right thread.

**Data flow**: It receives an optional thread name and an optional thread ID. It ignores an empty name, chooses the name if possible, otherwise turns the ID into text, then shell-quotes the chosen target so spaces or quotes are safe. If the target begins with `-`, it inserts `--` so the target is not mistaken for an option. It returns the finished command text, or `None` if there is no target at all.

**Call relations**: This is the core formatter for this file. `resume_hint` calls it when it needs a direct resume command, and the tests call it in several situations to confirm that names, IDs, missing targets, and tricky shell characters all produce the expected output.

*Call graph*: called by 5 (resume_hint, formats_thread_id_when_name_is_missing, prefers_name_over_id, quotes_thread_names_when_needed, returns_none_without_a_resume_target).


##### `resume_hint`  (lines 22–30)

```
fn resume_hint(thread_name: Option<&str>, thread_id: Option<ThreadId>) -> Option<String>
```

**Purpose**: Builds a short instruction for resuming a thread when Codex wants to show a helpful hint rather than always giving a direct command. It requires a thread ID so the hint can identify the exact thread.

**Data flow**: It receives an optional thread name and optional thread ID. If there is no ID, it returns `None`. If there is a non-empty name, it creates text telling the user to run `codex resume` and then select that named thread, with the ID shown in parentheses. If there is no usable name, it asks `resume_command` to build a direct command using the ID.

**Call relations**: This function sits one level above `resume_command`: it decides whether the friendlier picker-style hint is appropriate, and delegates to `resume_command` for the direct-command case. The hint-related tests call it to check the named-thread wording, the ID-only fallback, and the rule that an ID is required.

*Call graph*: calls 1 internal fn (resume_command); called by 3 (resume_hint_names_picker_item_with_id, resume_hint_requires_thread_id, resume_hint_uses_direct_id_command_without_name); 1 external calls (format!).


##### `tests::prefers_name_over_id`  (lines 38–42)

```
fn prefers_name_over_id()
```

**Purpose**: Checks that `resume_command` uses the thread name when both a name and an ID are available. This protects the user-friendly behavior where names win over less readable IDs.

**Data flow**: The test creates a sample thread ID, passes both that ID and the name `my-thread` into `resume_command`, and compares the result with the expected command. The output should be `codex resume my-thread`, showing that the ID was not used.

**Call relations**: This test directly exercises `resume_command` in the case where both possible targets exist. It supports the larger formatting flow by locking in the priority rule used before any hint or command is shown to a user.

*Call graph*: calls 2 internal fn (from_string, resume_command); 1 external calls (assert_eq!).


##### `tests::formats_thread_id_when_name_is_missing`  (lines 45–52)

```
fn formats_thread_id_when_name_is_missing()
```

**Purpose**: Checks that `resume_command` still produces a useful command when there is no thread name. This matters because an ID may be the only reliable way to find a saved thread.

**Data flow**: The test creates a sample thread ID, calls `resume_command` with no name and that ID, then compares the result with a command containing the ID text. The before state is “only an ID is known”; the after state is a complete `codex resume <id>` command.

**Call relations**: This test calls `resume_command` directly to verify its fallback path. That same fallback is also used indirectly by `resume_hint` when it cannot name a picker item.

*Call graph*: calls 2 internal fn (from_string, resume_command); 1 external calls (assert_eq!).


##### `tests::returns_none_without_a_resume_target`  (lines 55–58)

```
fn returns_none_without_a_resume_target()
```

**Purpose**: Checks that `resume_command` does not invent a command when it has neither a thread name nor a thread ID. This prevents Codex from showing misleading instructions.

**Data flow**: The test passes no name and no ID into `resume_command`. It expects `None`, meaning there is no command text to display.

**Call relations**: This test covers the “nothing to work with” edge case for `resume_command`. It helps ensure callers can safely treat `None` as “do not show a resume command.”

*Call graph*: calls 1 internal fn (resume_command); 1 external calls (assert_eq!).


##### `tests::quotes_thread_names_when_needed`  (lines 61–73)

```
fn quotes_thread_names_when_needed()
```

**Purpose**: Checks that `resume_command` formats awkward thread names safely for a shell. It covers names that look like options, contain spaces, or contain quote characters.

**Data flow**: The test calls `resume_command` several times with special thread names. Each input name is turned into a command string, and the test compares that string with the expected safe shell form, including `--` for a dash-starting name and quotes where needed.

**Call relations**: This test directly protects the shell-safety behavior inside `resume_command`. Without it, a future change could accidentally produce commands that the user’s shell reads differently from what Codex intended.

*Call graph*: calls 1 internal fn (resume_command); 1 external calls (assert_eq!).


##### `tests::resume_hint_names_picker_item_with_id`  (lines 76–86)

```
fn resume_hint_names_picker_item_with_id()
```

**Purpose**: Checks that `resume_hint` uses the friendlier picker-style wording when both a thread name and ID are present. The hint tells the user what to select and still includes the exact ID for confidence.

**Data flow**: The test creates a sample thread ID, passes it with the name `my-thread` into `resume_hint`, and compares the result with the expected sentence. The output is not a direct `codex resume my-thread` command; it is an instruction to run `codex resume` and select the named item.

**Call relations**: This test calls `resume_hint` for the named-thread path. It confirms the higher-level hint behavior that sits above the direct command formatter.

*Call graph*: calls 2 internal fn (from_string, resume_hint); 1 external calls (assert_eq!).


##### `tests::resume_hint_uses_direct_id_command_without_name`  (lines 89–96)

```
fn resume_hint_uses_direct_id_command_without_name()
```

**Purpose**: Checks that `resume_hint` falls back to a direct ID-based command when there is no thread name. This keeps the hint useful even when no friendly label is available.

**Data flow**: The test creates a sample thread ID and calls `resume_hint` without a name. `resume_hint` then relies on the command-building path, and the test expects the final text to be `codex resume <id>`.

**Call relations**: This test exercises the connection between `resume_hint` and `resume_command`. It proves that the hint helper delegates to the direct command formatter when it cannot produce a picker-style named hint.

*Call graph*: calls 2 internal fn (from_string, resume_hint); 1 external calls (assert_eq!).


##### `tests::resume_hint_requires_thread_id`  (lines 99–102)

```
fn resume_hint_requires_thread_id()
```

**Purpose**: Checks that `resume_hint` refuses to produce a hint without a thread ID. This avoids showing a hint that names something but cannot identify the exact saved thread.

**Data flow**: The test passes a thread name but no ID into `resume_hint`. The expected result is `None`, so no hint text is produced.

**Call relations**: This test covers the guard at the start of `resume_hint`. It complements the other hint tests by showing that the helper needs an ID before it will take either the named-picker path or the direct-command path.

*Call graph*: calls 1 internal fn (resume_hint); 1 external calls (assert_eq!).


### `core/src/web_search.rs`

`domain_logic` · `request handling`

This file solves a small but important presentation problem: web search actions are stored as structured data, but people need to see them as simple text. Without this conversion, logs or user-facing status messages might show empty, confusing, or overly technical details.

The main idea is to pick the best available description for each kind of web action. For a search, the code prefers a single query if one exists. If there are several queries instead, it shows the first one and adds an ellipsis when there is more than one, like writing “cats ...” to hint that more searches are included. For opening a page, it shows the URL. For finding text within a page, it combines the search pattern and the page URL when both are present, or falls back to whichever one exists.

The file is careful about missing information. Many fields are optional, so it returns an empty string when there is truly nothing useful to show. The public helper `web_search_detail` adds one more fallback: if the action itself cannot provide a detail, it uses the original query text instead. In everyday terms, this file is like the caption writer for web search activity.

#### Function details

##### `search_action_detail`  (lines 3–16)

```
fn search_action_detail(query: &Option<String>, queries: &Option<Vec<String>>) -> String
```

**Purpose**: This helper chooses the best short label for a search request. It prefers a single non-empty query, but can also summarize a list of queries when the action contains more than one.

**Data flow**: It receives an optional single query and an optional list of queries. First it checks whether the single query exists and is not empty; if so, that becomes the result. Otherwise it looks at the query list, takes the first item if there is one, and adds “ ...” when the list has more than one non-empty item. It returns the chosen text as a new string and does not change the inputs.

**Call relations**: This is the search-specific piece used by `web_search_action_detail`. When the larger formatter sees a `Search` action, it hands the query fields to this helper so the search case stays separate from page-opening and find-in-page formatting.

*Call graph*: called by 1 (web_search_action_detail).


##### `web_search_action_detail`  (lines 18–30)

```
fn web_search_action_detail(action: &WebSearchAction) -> String
```

**Purpose**: This function turns one structured `WebSearchAction` into the short text a person should see for it. It covers searching, opening a page, finding text in a page, and unknown or unsupported action types.

**Data flow**: It receives a web search action. It looks at which kind of action it is: for a search, it asks `search_action_detail` to summarize the query; for an open-page action, it returns the URL or an empty string; for find-in-page, it combines the pattern and URL when available; for an unknown action, it returns an empty string. The output is always a plain string suitable for display.

**Call relations**: This is called by `parse_turn_item`, which likely needs readable text while turning lower-level conversation or event data into something the rest of the system can use. Inside, it delegates the search-query case to `search_action_detail` and builds combined text for find-in-page actions when needed.

*Call graph*: calls 1 internal fn (search_action_detail); called by 1 (parse_turn_item); 2 external calls (new, format!).


##### `web_search_detail`  (lines 32–39)

```
fn web_search_detail(action: Option<&WebSearchAction>, query: &str) -> String
```

**Purpose**: This function gives callers a reliable display string for a web search step, even when the structured action is missing or has no useful detail. It falls back to the raw query text so the user still sees something meaningful.

**Data flow**: It receives an optional web search action and a plain query string. If an action is present, it converts that action into display text; if that text is empty, or if there is no action, it uses the provided query string instead. It returns the final text and does not modify anything.

**Call relations**: No specific caller is shown in the provided call facts, but this acts as a convenience wrapper around the action-detail formatting path. It is useful at the point where code wants one final label and does not want to repeat the fallback rule itself.


### Text shaping and truncation workflows
These files apply reusable formatting and budget-enforcement logic to larger text payloads, from TUI-oriented shaping to output and response-history trimming.

### `tui/src/text_formatting.rs`

`util` · `cross-cutting during terminal rendering and tests`

A terminal screen is a cramped space, and text is not as simple as “one character equals one cell.” Emojis, accented letters, wide characters, JSON blobs, and long paths can all display badly if they are cut or wrapped carelessly. This file is the TUI’s text-polishing toolbox.

It provides helpers for common display tasks: capitalizing the first letter, shortening long text safely, making JSON compact but still wrappable, shortening paths while preserving useful beginning and ending folders, and joining words in readable English. The most important idea is that the code tries to preserve meaning while respecting space. For example, a path is shortened like a map route: keep the starting point and destination, replace the middle with an ellipsis when needed.

The file also pays attention to Unicode. It truncates by graphemes, meaning user-visible characters, rather than raw bytes. That avoids cutting an emoji or accented character in half. For terminal width, it uses display-width calculations so wide characters are counted more realistically.

The tests at the bottom lock down edge cases: tiny limits, emojis, combining accents, JSON formats, Windows-style paths, and natural-language joins. Without these helpers, the interface would show messy wrapping, broken characters, overly tall JSON, or unhelpfully chopped paths.

#### Function details

##### `capitalize_first`  (lines 5–15)

```
fn capitalize_first(input: &str) -> String
```

**Purpose**: Turns the first character of a piece of text into uppercase while leaving the rest untouched. This is useful for small display labels that should start like a sentence or title.

**Data flow**: It receives a string. It looks at the first character; if there is one, it uppercases that character and appends the remaining original text after it. If the input is empty, it returns an empty string.

**Call relations**: This is a standalone formatting helper. Other display code can call it when it needs a friendlier label, and it only relies on ordinary string construction.

*Call graph*: 1 external calls (new).


##### `format_and_truncate_tool_result`  (lines 19–34)

```
fn format_and_truncate_tool_result(
    text: &str,
    max_lines: usize,
    line_width: usize,
) -> String
```

**Purpose**: Prepares a tool result for display inside a limited terminal area. If the result is JSON, it first makes it compact and easier to wrap, then shortens it to fit the available space.

**Data flow**: It receives raw text plus a maximum number of lines and a line width. It estimates how many visible character groups can fit, tries to reformat the text as compact JSON, and then sends either the formatted JSON or the original text through safe truncation. It returns the display-ready string.

**Call relations**: When the TUI needs to show tool output, this function acts as the coordinator. It asks format_json_compact to improve JSON and then hands the final text to truncate_text so the result does not overflow the display area.

*Call graph*: calls 2 internal fn (format_json_compact, truncate_text).


##### `format_json_compact`  (lines 44–88)

```
fn format_json_compact(text: &str) -> Option<String>
```

**Purpose**: Turns valid JSON into a single-line format that is still readable and can wrap at spaces in the terminal. It returns nothing if the text is not valid JSON.

**Data flow**: It receives text and tries to parse it as JSON. If parsing works, it creates pretty JSON, then removes line breaks and extra indentation while carefully preserving spaces and escape characters inside quoted strings. It returns the compact JSON string wrapped in Some; invalid JSON becomes None.

**Call relations**: This function is used by display code that shows tool approval values and by format_and_truncate_tool_result before truncation. Its tests call it with objects, arrays, primitives, whitespace-heavy JSON, compact JSON, and invalid JSON to make sure it behaves predictably.

*Call graph*: called by 10 (format_tool_approval_display_param_value, format_and_truncate_tool_result, test_format_json_compact_already_compact, test_format_json_compact_array, test_format_json_compact_empty_array, test_format_json_compact_empty_object, test_format_json_compact_invalid_json, test_format_json_compact_nested_object, test_format_json_compact_simple_object, test_format_json_compact_with_whitespace); 3 external calls (new, matches!, to_string_pretty).


##### `truncate_text`  (lines 91–115)

```
fn truncate_text(text: &str, max_graphemes: usize) -> String
```

**Purpose**: Shortens text to a maximum number of graphemes, which are user-visible character groups. This avoids cutting through characters like emojis or letters made from multiple Unicode pieces.

**Data flow**: It receives text and a grapheme limit. If the text fits, it returns the original text. If it is too long and the limit is at least three, it keeps enough text to add three dots within the limit. For very small limits, it simply returns the first visible character groups without dots.

**Call relations**: Many parts of the TUI rely on this as the safe text cutter, including summaries, prompts, row building, status spans, and tool display formatting. The tests exercise normal strings, empty input, tiny limits, emojis, combining marks, exact limits, and very long strings.

*Call graph*: called by 25 (activity_summary, bounded_summary, format_tool_approval_display_param_value, build_rows, error_summary_spans, prompt_line, status_summary_spans, dense_column_text, push_footer_part, render_comfortable_session_lines (+15 more)); 1 external calls (format!).


##### `center_truncate_path`  (lines 120–328)

```
fn center_truncate_path(path: &str, max_width: usize) -> String
```

**Purpose**: Shortens a file path to fit a given terminal width while keeping useful context from both the start and the end. It uses a single ellipsis in the middle when possible, and can shorten an individual long folder or file name if needed.

**Data flow**: It receives a path-like string and a maximum display width. If the path already fits, it returns it unchanged. Otherwise it splits the path into segments, tries combinations of leading and trailing segments, inserts an ellipsis for skipped middle parts, and measures the display width. If a segment is still too long, it front-truncates that segment with an ellipsis. It returns the best fitting path it can produce.

**Call relations**: Directory display code calls this when showing paths in the TUI. The function uses Unicode display-width checks so terminal cells, not just byte counts, guide the shortening. Tests cover paths that fit, long Unix-like paths, Windows-style paths, and a path with one very long segment.

*Call graph*: called by 6 (format_directory_inner, format_directory_display, test_center_truncate_doesnt_truncate_short_path, test_center_truncate_handles_long_segment, test_center_truncate_truncates_long_path, test_center_truncate_truncates_long_windows_path); 4 external calls (new, width, new, min).


##### `proper_join`  (lines 336–355)

```
fn proper_join(items: &[T]) -> String
```

**Purpose**: Joins a list of words or phrases using ordinary English punctuation. It makes lists read naturally in messages, such as “apple, banana and cherry.”

**Data flow**: It receives a slice of string-like items. For no items it returns an empty string, for one item it returns that item, for two it inserts “and,” and for three or more it adds commas between earlier items plus “and” before the last. It returns the completed sentence fragment.

**Call relations**: This is a standalone helper for human-readable messages. Its test checks empty, one-item, two-item, and longer lists.

*Call graph*: 4 external calls (new, iter, len, format!).


##### `tests::test_truncate_text`  (lines 363–367)

```
fn test_truncate_text()
```

**Purpose**: Checks that ordinary text is shortened with dots when the limit is smaller than the text. It protects the basic truncation behavior users see in the interface.

**Data flow**: It starts with “Hello, world!” and asks truncate_text for eight graphemes. It expects the result to be “Hello...”, proving the dots are included within the limit.

**Call relations**: The test runner calls this during the test suite. It directly exercises truncate_text and compares the result with an assertion.

*Call graph*: calls 1 internal fn (truncate_text); 1 external calls (assert_eq!).


##### `tests::test_truncate_empty_string`  (lines 370–374)

```
fn test_truncate_empty_string()
```

**Purpose**: Checks that truncating an empty string stays empty. This prevents special-case display bugs when there is no text to show.

**Data flow**: It sends an empty string and a limit of five into truncate_text. It expects an empty string back.

**Call relations**: The test runner calls this as part of validation. It uses truncate_text and verifies the result with an equality assertion.

*Call graph*: calls 1 internal fn (truncate_text); 1 external calls (assert_eq!).


##### `tests::test_truncate_max_graphemes_zero`  (lines 377–381)

```
fn test_truncate_max_graphemes_zero()
```

**Purpose**: Checks behavior when the allowed size is zero. This matters because some terminal areas can effectively have no room.

**Data flow**: It sends “Hello” with a zero-grapheme limit into truncate_text. It expects the returned string to be empty.

**Call relations**: The test runner invokes this edge-case test. It calls truncate_text and confirms the exact output.

*Call graph*: calls 1 internal fn (truncate_text); 1 external calls (assert_eq!).


##### `tests::test_truncate_max_graphemes_one`  (lines 384–388)

```
fn test_truncate_max_graphemes_one()
```

**Purpose**: Checks behavior when only one visible character group is allowed. It ensures tiny spaces do not receive an ellipsis that would exceed the limit.

**Data flow**: It sends “Hello” with a limit of one into truncate_text. It expects only “H” back.

**Call relations**: This is run by the test framework. It focuses on truncate_text’s small-limit branch and verifies it with an assertion.

*Call graph*: calls 1 internal fn (truncate_text); 1 external calls (assert_eq!).


##### `tests::test_truncate_max_graphemes_two`  (lines 391–395)

```
fn test_truncate_max_graphemes_two()
```

**Purpose**: Checks behavior when two visible character groups are allowed. It confirms that the function returns raw leading text instead of dots for very small limits.

**Data flow**: It sends “Hello” with a limit of two into truncate_text. It expects “He”.

**Call relations**: The test runner calls this. It exercises truncate_text and checks the output exactly.

*Call graph*: calls 1 internal fn (truncate_text); 1 external calls (assert_eq!).


##### `tests::test_truncate_max_graphemes_three_boundary`  (lines 398–402)

```
fn test_truncate_max_graphemes_three_boundary()
```

**Purpose**: Checks the boundary where the function starts using three dots. It makes sure a three-character limit becomes exactly an ellipsis-style marker.

**Data flow**: It sends “Hello” with a limit of three into truncate_text. It expects “...”.

**Call relations**: This test is called by the test runner. It validates the transition point in truncate_text’s truncation rules.

*Call graph*: calls 1 internal fn (truncate_text); 1 external calls (assert_eq!).


##### `tests::test_truncate_text_shorter_than_limit`  (lines 405–409)

```
fn test_truncate_text_shorter_than_limit()
```

**Purpose**: Checks that short text is not changed when there is plenty of space. This protects against unnecessary shortening.

**Data flow**: It sends “Hi” with a limit of ten into truncate_text. It expects “Hi” back unchanged.

**Call relations**: The test runner executes this case. It confirms truncate_text leaves fitting text alone.

*Call graph*: calls 1 internal fn (truncate_text); 1 external calls (assert_eq!).


##### `tests::test_truncate_text_exact_length`  (lines 412–416)

```
fn test_truncate_text_exact_length()
```

**Purpose**: Checks that text exactly at the limit is not shortened. This avoids losing information when the text already fits.

**Data flow**: It sends “Hello” with a limit of five into truncate_text. It expects “Hello” back unchanged.

**Call relations**: This test is run by the test framework. It verifies truncate_text’s exact-fit behavior.

*Call graph*: calls 1 internal fn (truncate_text); 1 external calls (assert_eq!).


##### `tests::test_truncate_emoji`  (lines 419–426)

```
fn test_truncate_emoji()
```

**Purpose**: Checks that emojis are counted as whole visible characters rather than raw bytes. This prevents broken emoji display after truncation.

**Data flow**: It sends a sequence of emojis into truncate_text with limits of three and four. It expects either just dots or one emoji followed by dots, showing that no emoji is split apart.

**Call relations**: The test runner calls this Unicode-focused test. It uses truncate_text and equality assertions to guard emoji-safe behavior.

*Call graph*: calls 1 internal fn (truncate_text); 1 external calls (assert_eq!).


##### `tests::test_truncate_unicode_combining_characters`  (lines 429–433)

```
fn test_truncate_unicode_combining_characters()
```

**Purpose**: Checks that letters with combining marks are treated as complete visible characters. This protects accented text from being cut in the middle.

**Data flow**: It sends text made from base letters plus combining marks into truncate_text with a limit of two graphemes. It expects the full two visible characters back.

**Call relations**: This test is run with the rest of the suite. It directly validates truncate_text’s grapheme-based cutting.

*Call graph*: calls 1 internal fn (truncate_text); 1 external calls (assert_eq!).


##### `tests::test_truncate_very_long_text`  (lines 436–441)

```
fn test_truncate_very_long_text()
```

**Purpose**: Checks that very long text is shortened correctly and stays within the requested length. This protects the terminal from oversized strings.

**Data flow**: It creates one thousand “a” characters, truncates them to ten graphemes, and expects seven “a” characters followed by three dots. It also checks the resulting byte length for this plain ASCII case.

**Call relations**: The test runner invokes this stress-style case. It calls truncate_text and confirms both the visible result and its length.

*Call graph*: calls 1 internal fn (truncate_text); 1 external calls (assert_eq!).


##### `tests::test_format_json_compact_simple_object`  (lines 444–448)

```
fn test_format_json_compact_simple_object()
```

**Purpose**: Checks that a simple JSON object becomes compact but readable. It verifies spaces are added after separators in the expected way.

**Data flow**: It sends a small object with extra spaces into format_json_compact. It unwraps the successful result and expects a single-line object with consistent spacing.

**Call relations**: The test framework calls this. It exercises format_json_compact’s normal object path and compares the output.

*Call graph*: calls 1 internal fn (format_json_compact); 1 external calls (assert_eq!).


##### `tests::test_format_json_compact_nested_object`  (lines 451–458)

```
fn test_format_json_compact_nested_object()
```

**Purpose**: Checks that nested JSON objects are compacted without losing their structure. This matters because tool output often contains nested data.

**Data flow**: It sends JSON with objects inside objects into format_json_compact. It expects one compact line that still keeps braces, keys, and values in the right places.

**Call relations**: The test runner invokes this. It calls format_json_compact and uses an assertion to guard nested formatting.

*Call graph*: calls 1 internal fn (format_json_compact); 1 external calls (assert_eq!).


##### `tests::test_center_truncate_doesnt_truncate_short_path`  (lines 461–467)

```
fn test_center_truncate_doesnt_truncate_short_path()
```

**Purpose**: Checks that a path which already fits is returned unchanged. This prevents needless ellipses in readable paths.

**Data flow**: It builds a platform-appropriate path and passes it to center_truncate_path with a generous width. It expects the same path back.

**Call relations**: The test runner calls this case. It uses path formatting, center_truncate_path, and an equality assertion.

*Call graph*: calls 1 internal fn (center_truncate_path); 2 external calls (assert_eq!, format!).


##### `tests::test_center_truncate_truncates_long_path`  (lines 470–479)

```
fn test_center_truncate_truncates_long_path()
```

**Purpose**: Checks that a long path is shortened by keeping useful beginning and ending segments. It verifies the middle is replaced by an ellipsis.

**Data flow**: It builds a long path, gives center_truncate_path a narrower width, and expects a result that keeps the early folders and the final folders with an ellipsis between them.

**Call relations**: The test framework runs this to validate the main path-shortening behavior. It calls center_truncate_path and checks the exact formatted result.

*Call graph*: calls 1 internal fn (center_truncate_path); 2 external calls (assert_eq!, format!).


##### `tests::test_center_truncate_truncates_long_windows_path`  (lines 482–492)

```
fn test_center_truncate_truncates_long_windows_path()
```

**Purpose**: Checks that Windows-style paths also shorten in a useful way. This matters because the project may run on different operating systems.

**Data flow**: It builds a long path beginning with a drive-like segment, passes it to center_truncate_path, and expects the start plus the final path parts to remain visible.

**Call relations**: The test runner invokes this platform-conscious case. It uses format-style path construction, calls center_truncate_path, and verifies the output.

*Call graph*: calls 1 internal fn (center_truncate_path); 2 external calls (assert_eq!, format!).


##### `tests::test_center_truncate_handles_long_segment`  (lines 495–501)

```
fn test_center_truncate_handles_long_segment()
```

**Purpose**: Checks that a single very long path segment can be shortened from the front. This keeps the ending of a filename or folder name visible when that is the most useful part.

**Data flow**: It builds a short path with one extremely long segment, asks center_truncate_path to fit it into a small width, and expects the segment to start with an ellipsis followed by its ending.

**Call relations**: This test is run by the test framework. It directly exercises center_truncate_path’s per-segment fallback behavior.

*Call graph*: calls 1 internal fn (center_truncate_path); 2 external calls (assert_eq!, format!).


##### `tests::test_format_json_compact_array`  (lines 504–508)

```
fn test_format_json_compact_array()
```

**Purpose**: Checks that JSON arrays are compacted cleanly. It verifies mixed array contents such as numbers, objects, and strings stay readable.

**Data flow**: It sends an array with extra spaces into format_json_compact. It expects a single-line array with spaces after commas where helpful.

**Call relations**: The test runner calls this. It validates format_json_compact for array-shaped JSON.

*Call graph*: calls 1 internal fn (format_json_compact); 1 external calls (assert_eq!).


##### `tests::test_format_json_compact_already_compact`  (lines 511–515)

```
fn test_format_json_compact_already_compact()
```

**Purpose**: Checks that already compact JSON is normalized into the project’s preferred readable spacing. It prevents cramped JSON from being shown without wrap-friendly spaces.

**Data flow**: It sends a compact object into format_json_compact. It expects the same structure but with a space after the colon.

**Call relations**: The test runner invokes this. It calls format_json_compact and compares the normalized output.

*Call graph*: calls 1 internal fn (format_json_compact); 1 external calls (assert_eq!).


##### `tests::test_format_json_compact_with_whitespace`  (lines 518–533)

```
fn test_format_json_compact_with_whitespace()
```

**Purpose**: Checks that heavily indented, multi-line JSON becomes a compact single line. This protects terminal space when tool output is pretty-printed.

**Data flow**: It sends a multi-line object containing an array into format_json_compact. It expects one line with the same data and readable separator spacing.

**Call relations**: The test framework calls this. It confirms format_json_compact removes outside-string whitespace while preserving JSON meaning.

*Call graph*: calls 1 internal fn (format_json_compact); 1 external calls (assert_eq!).


##### `tests::test_format_json_compact_invalid_json`  (lines 536–540)

```
fn test_format_json_compact_invalid_json()
```

**Purpose**: Checks that invalid JSON is rejected instead of being reformatted incorrectly. This lets callers safely fall back to displaying the original text.

**Data flow**: It sends malformed JSON into format_json_compact. It expects no formatted string to be returned.

**Call relations**: The test runner executes this negative case. It calls format_json_compact and asserts that the result is None.

*Call graph*: calls 1 internal fn (format_json_compact); 1 external calls (assert!).


##### `tests::test_format_json_compact_empty_object`  (lines 543–547)

```
fn test_format_json_compact_empty_object()
```

**Purpose**: Checks that an empty JSON object stays as a simple empty object. It guards a small but common edge case.

**Data flow**: It sends “{}” into format_json_compact. It expects “{}” back.

**Call relations**: The test framework runs this. It calls format_json_compact and verifies the exact result.

*Call graph*: calls 1 internal fn (format_json_compact); 1 external calls (assert_eq!).


##### `tests::test_format_json_compact_empty_array`  (lines 550–554)

```
fn test_format_json_compact_empty_array()
```

**Purpose**: Checks that an empty JSON array stays as a simple empty array. It prevents unnecessary spacing or changes.

**Data flow**: It sends “[]” into format_json_compact. It expects “[]” back.

**Call relations**: The test runner calls this. It validates format_json_compact on another empty JSON shape.

*Call graph*: calls 1 internal fn (format_json_compact); 1 external calls (assert_eq!).


##### `tests::test_format_json_compact_primitive_values`  (lines 557–563)

```
fn test_format_json_compact_primitive_values()
```

**Purpose**: Checks that JSON values that are not objects or arrays, such as numbers, booleans, null, and strings, are accepted and preserved. This matters because valid JSON can be a single primitive value.

**Data flow**: It feeds primitive JSON values through the compact formatter and compares each returned value with the expected plain form. The values should not gain object-style spacing or extra structure.

**Call relations**: The test runner invokes this set of assertions. It protects format_json_compact’s behavior for primitive JSON values.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::test_proper_join`  (lines 566–579)

```
fn test_proper_join()
```

**Purpose**: Checks that lists of different lengths are joined in readable English. It makes sure user-facing messages do not contain awkward punctuation.

**Data flow**: It creates empty and non-empty example lists and passes them through proper_join. It expects the correct empty string, single item, two-item “and” form, and comma-separated longer forms.

**Call relations**: The test runner calls this. It validates the standalone proper_join helper using equality assertions.

*Call graph*: 2 external calls (assert_eq!, vec!).


### `utils/output-truncation/src/lib.rs`

`util` · `cross-cutting during tool output preparation`

Large command results can overwhelm a conversation, exceed model limits, or make logs hard to read. This file is the project’s shared toolkit for trimming that output safely and consistently. Think of it like a careful editor: if the text already fits, it leaves it alone; if it is too long, it cuts from the middle so the reader can still see how the output starts and ends.

The main idea is a `TruncationPolicy`, which says whether the limit is measured in bytes, meaning raw text size, or in tokens, meaning an approximate model-sized word-piece count. Simple text can be shortened directly with `truncate_text`, or shortened with a warning header using `formatted_truncate_text`. That header tells the reader that content was removed and gives the original estimated token count and line count.

The file also works with structured tool output items. Some items are text, while others are images or encrypted content. The truncation helpers avoid damaging images and encrypted data. One helper combines all text into a single readable block before truncating it and then appends the non-text items unchanged. Another helper walks item by item, spending a shared budget on text while always keeping images and encrypted content. This matters because output sent to a model must be small enough to fit, but should still be honest about what was omitted.

#### Function details

##### `formatted_truncate_text`  (lines 12–23)

```
fn formatted_truncate_text(content: &str, policy: TruncationPolicy) -> String
```

**Purpose**: Shortens a plain text string only if it is larger than the allowed size, and adds a clear warning when shortening happens. Someone would use this when showing command output to a user or model and they need the reader to know that the text is incomplete.

**Data flow**: It receives the original text and a truncation policy. First it checks the policy’s byte budget; if the text already fits, it returns the text unchanged. If the text is too large, it estimates the original token count, counts the original lines, asks `truncate_text` to make a shorter version, and returns a new string with a warning header followed by the shortened content.

**Call relations**: This is a friendly wrapper around `truncate_text`. It calls the lower-level truncation function only after deciding the output is too large, and it adds human-readable context using the token estimate and line count before handing the shortened text back to its caller.

*Call graph*: calls 2 internal fn (byte_budget, truncate_text); 2 external calls (approx_token_count, format!).


##### `truncate_text`  (lines 25–30)

```
fn truncate_text(content: &str, policy: TruncationPolicy) -> String
```

**Purpose**: Cuts a text string down according to the chosen limit, without adding any warning text. It is the core text-shortening helper used when callers want just the shortened content.

**Data flow**: It receives text and a policy. If the policy is byte-based, it uses a character-aware middle-truncation helper so the output fits roughly within that byte size. If the policy is token-based, it uses a token-budget helper that estimates how much text can fit. It returns the shortened string.

**Call relations**: This function sits underneath the higher-level helpers. `formatted_truncate_text` calls it when it needs a shortened body for a warning-wrapped message, and `truncate_function_output_items_with_policy` calls it when one text item is too large for the remaining shared budget.

*Call graph*: called by 2 (formatted_truncate_text, truncate_function_output_items_with_policy); 2 external calls (truncate_middle_chars, truncate_middle_with_token_budget).


##### `formatted_truncate_text_content_items_with_policy`  (lines 32–81)

```
fn formatted_truncate_text_content_items_with_policy(
    items: &[FunctionCallOutputContentItem],
    policy: TruncationPolicy,
) -> (Vec<FunctionCallOutputContentItem>, Option<usize>)
```

**Purpose**: Shortens structured function-call output by combining all text pieces into one readable block, while keeping images and encrypted content intact. It also reports the original token count when truncation was needed.

**Data flow**: It receives a list of output content items and a policy. It gathers only the text items, leaving image and encrypted items aside. If there is no text, or the combined text fits the byte budget, it returns a copy of the original items and no token count. If the combined text is too large, it estimates its token count, creates one warning-wrapped shortened text item, then appends copies of the original non-text items. The result is the new item list plus the original token count.

**Call relations**: This helper is used when the caller wants one formatted, easy-to-read truncated text block rather than many separately shortened text fragments. Internally it relies on the same counting and formatting approach as `formatted_truncate_text`, and it preserves non-text content so later parts of the system still receive images or encrypted payloads.

*Call graph*: calls 1 internal fn (byte_budget); 5 external calls (new, iter, to_vec, approx_token_count, vec!).


##### `truncate_function_output_items_with_policy`  (lines 83–145)

```
fn truncate_function_output_items_with_policy(
    items: &[FunctionCallOutputContentItem],
    policy: TruncationPolicy,
) -> Vec<FunctionCallOutputContentItem>
```

**Purpose**: Applies one shared size budget across a list of function output items. It spends that budget only on text, keeps images and encrypted content, and adds a short note if some text items had to be skipped.

**Data flow**: It receives content items and a policy. It starts with a remaining budget, measured either in bytes or estimated tokens. For each text item, it checks whether the full text fits; if so, it copies it and subtracts its cost. If it does not fit, it truncates that one text item to whatever budget remains, then stops allowing more text. Image and encrypted items are copied through unchanged. If later text items are omitted, it appends a final text note such as an omitted-item count.

**Call relations**: This is the item-by-item truncation path. It calls `truncate_text` when a single text item needs to be squeezed into the last bit of available space, and it uses token or byte counting to decide how much of the budget remains as it walks through the output.

*Call graph*: calls 3 internal fn (byte_budget, token_budget, truncate_text); 6 external calls (with_capacity, len, approx_token_count, format!, Bytes, Tokens).


##### `approx_tokens_from_byte_count_i64`  (lines 147–154)

```
fn approx_tokens_from_byte_count_i64(bytes: i64) -> i64
```

**Purpose**: Converts a byte count into an approximate token count using signed 64-bit integers, which are common in APIs and configuration values. It protects callers from negative values and number sizes that are too large to convert safely.

**Data flow**: It receives a byte count as an `i64`. If the value is zero or negative, it returns zero. Otherwise it converts the number to an unsigned size, clamps impossible conversions to the largest available value, calls the shared byte-to-token estimate helper, and converts the result back to `i64`, again using a safe maximum if needed.

**Call relations**: This is a small compatibility helper around the exported `approx_tokens_from_byte_count` utility. It does not drive truncation itself, but it gives other code a safe way to ask, in token terms, what a byte-sized limit roughly means.

*Call graph*: 3 external calls (approx_tokens_from_byte_count, try_from, try_from).


### `tools/src/response_history.rs`

`util` · `cross-cutting`

Long conversations can grow too large to send back into a model or store comfortably. This file provides two small cleanup tools for a list of response items, where each item is a message or another piece of model conversation data. The first tool keeps the tail of the conversation starting from the earliest of the last chosen number of user messages. It also cuts away anything after the latest user message, so later assistant text is not carried forward as if it were part of the prompt. The second tool limits assistant output text across the whole list. A token is a rough chunk of text used for model size limits, so this function treats the budget like a spending limit: each assistant output spends some of the remaining allowance, and once the allowance is gone, later assistant text is removed. If one assistant message is too long, it is shortened rather than thrown away entirely. Non-assistant messages and non-text content are left alone. The tests at the bottom build simple fake messages and prove the two main behaviors: keeping the right conversation tail, and sharing one text budget across multiple assistant messages.

#### Function details

##### `retain_tail_from_last_n_user_messages`  (lines 9–34)

```
fn retain_tail_from_last_n_user_messages(
    items: &mut Vec<ResponseItem>,
    user_message_count: usize,
)
```

**Purpose**: Keeps only the recent part of a response history, measured by user messages. This is useful when the system wants enough recent context to understand the current conversation, but not the entire older history.

**Data flow**: It receives a mutable list of response items and a number of user messages to keep. If the number is zero, or if there are no user messages at all, it empties the list. Otherwise, it first removes anything after the latest user message, then finds the earliest user message among the last requested user messages, and removes everything before that point. The same list is changed in place; it does not return a new list.

**Call relations**: In this file it is exercised by tests::retains_tail_through_latest_user_message, which builds a sample conversation with old and recent turns and checks that only the intended recent tail remains. In normal use, this helper would be called before reusing or sending conversation history, so older context does not keep growing forever.

*Call graph*: called by 1 (retains_tail_through_latest_user_message).


##### `truncate_assistant_output_text_to_token_budget`  (lines 37–71)

```
fn truncate_assistant_output_text_to_token_budget(
    items: &mut Vec<ResponseItem>,
    max_tokens: usize,
)
```

**Purpose**: Shortens assistant output text so all assistant text together fits within one maximum token budget. This helps keep stored or reused model output from becoming too large.

**Data flow**: It receives a mutable list of response items and a maximum token count. It walks through the items in order, ignores anything that is not an assistant message, and looks only at assistant output text. Each kept text item uses part of the remaining budget. If a text item is larger than what is left, the function replaces it with a shortened version. Once the budget is used up, later assistant output text items are removed, and assistant messages with no content left are removed too. The list is modified in place.

**Call relations**: In this file it is checked by tests::truncates_assistant_output_text_across_items, which creates assistant text before and after a small budget and verifies that the first text is shortened and later over-budget assistant text disappears. The helper relies on the truncation utilities approx_token_count and truncate_text to estimate size and perform the actual shortening.

*Call graph*: called by 1 (truncates_assistant_output_text_across_items).


##### `tests::message`  (lines 84–100)

```
fn message(role: &str, text: &str) -> ResponseItem
```

**Purpose**: Builds a simple test message with the requested role and text. It lets the tests describe conversations clearly without repeating the full response item structure each time.

**Data flow**: It takes a role such as "user" or "assistant" and a text string. It creates a ResponseItem::Message with that role. Assistant messages receive output text, while all other roles receive input text. It returns the constructed message for use in test vectors.

**Call relations**: The two test functions call this helper whenever they need sample conversation items. It hides the setup details so the tests can focus on the behavior being checked.

*Call graph*: 1 external calls (vec!).


##### `tests::retains_tail_through_latest_user_message`  (lines 103–124)

```
fn retains_tail_through_latest_user_message()
```

**Purpose**: Tests that recent-history trimming keeps the correct slice of a conversation. It proves that old messages are removed, the requested number of recent user turns is respected, and assistant content after the latest user message is not kept.

**Data flow**: It starts with a sample list containing system, user, and assistant messages, including an assistant message after the current user message. It calls retain_tail_from_last_n_user_messages with a request to keep two user messages. It then compares the changed list with the expected shorter list.

**Call relations**: This test calls tests::message to build the sample data, then calls retain_tail_from_last_n_user_messages to perform the real work. Finally, it uses an assertion to confirm the helper changed the list exactly as intended.

*Call graph*: calls 1 internal fn (retain_tail_from_last_n_user_messages); 2 external calls (assert_eq!, vec!).


##### `tests::truncates_assistant_output_text_across_items`  (lines 127–149)

```
fn truncates_assistant_output_text_across_items()
```

**Purpose**: Tests that assistant output text shares one total token budget across multiple messages. It checks that overlong text is shortened and later assistant text is removed once the budget has been spent.

**Data flow**: It creates a long assistant message, another assistant message that should fall after the budget, and user messages around them. It calls truncate_assistant_output_text_to_token_budget with a very small budget. It then compares the result with a list where the first assistant text is shortened using the same truncation rule, the later assistant message is gone, and user messages remain.

**Call relations**: This test uses tests::message to create the conversation, then calls truncate_assistant_output_text_to_token_budget to apply the budget. It also calls truncate_text directly to build the expected shortened text, making sure the test expects the same truncation style as the production helper.

*Call graph*: calls 1 internal fn (truncate_assistant_output_text_to_token_budget); 2 external calls (assert_eq!, vec!).


### Strict text templating
This file provides the stage's standalone templating engine for parsing and rendering placeholder-based text with explicit error handling.

### `utils/template/src/lib.rs`

`util` · `cross-cutting text and prompt rendering`

This file is a lightweight template engine, meant for prompts and other text assets where the project wants predictable replacement and clear errors. Think of it like a mail-merge tool: a template is a letter with blanks, and rendering fills each blank with a value.

The syntax is deliberately tiny. A placeholder is written as `{{ name }}`. If the text needs to contain the characters `{{` or `}}` literally, it uses `{{{{` or `}}}}`. The parser reads the source text from left to right and breaks it into two kinds of pieces: literal text and placeholders. It also records the set of placeholder names, sorted and without duplicates.

The strictness is important. Rendering fails if a needed value is missing, if the caller supplies an unused value, or if the same value name is supplied twice. This prevents quiet mistakes, such as a misspelled variable silently leaving a prompt wrong. Parsing also rejects empty placeholders, nested placeholders, stray closing braces, and unfinished placeholders.

The public `Template` type is for parsing once and rendering many times. The public `render` function is a convenience for one-off use: parse a template, render it, and return one combined error type if anything goes wrong.

#### Function details

##### `TemplateParseError::fmt`  (lines 22–43)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Turns a template parsing problem into a clear human-readable message. This is what users or logs see when the template text itself is malformed.

**Data flow**: It receives a specific parse error, such as an empty placeholder or an unmatched closing delimiter, plus a formatter to write into. It writes a sentence that includes the byte position where the problem was found. Nothing else is changed.

**Call relations**: Rust’s error-display machinery calls this when a `TemplateParseError` needs to be printed. It uses formatting output to describe the exact parse problem in plain text.

*Call graph*: 1 external calls (write!).


##### `TemplateRenderError::fmt`  (lines 56–68)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Turns a rendering problem into a clear human-readable message. This explains mistakes in the values supplied for a valid template.

**Data flow**: It receives a render error, such as a duplicate, extra, or missing value, and writes a message into the formatter. The output names the value that caused the problem.

**Call relations**: Rust’s error-display machinery calls this when a `TemplateRenderError` is shown to a caller or written to logs. It relies on formatting output to produce the message.

*Call graph*: 1 external calls (write!).


##### `TemplateError::fmt`  (lines 80–85)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Prints the combined template error type by delegating to the more specific error inside it. This keeps parse and render errors wrapped together without losing their helpful wording.

**Data flow**: It receives either a parse error wrapper or a render error wrapper. It forwards the formatter to the contained error, so the final text is the same message the specific error would have produced.

**Call relations**: This is used when the convenience `render` function returns `TemplateError` and someone prints it. It hands the display work to `TemplateParseError::fmt` or `TemplateRenderError::fmt` depending on what went wrong.


##### `TemplateError::source`  (lines 89–94)

```
fn source(&self) -> Option<&(dyn Error + 'static)>
```

**Purpose**: Exposes the underlying cause of a combined template error. This lets error-reporting tools show the original parse or render error beneath the wrapper.

**Data flow**: It receives a `TemplateError`. If the wrapper contains a parse error, it returns that parse error as the source; if it contains a render error, it returns that render error instead.

**Call relations**: Rust’s standard error system calls this when building an error chain. It connects the public combined error back to the specific inner error.


##### `TemplateError::from`  (lines 104–106)

```
fn from(value: TemplateRenderError) -> Self
```

**Purpose**: Converts specific parse or render errors into the combined `TemplateError` type. This makes it easier for callers to return one error type from operations that can fail in either phase.

**Data flow**: It receives either a parsing error or a rendering error. It wraps that value as `TemplateError::Parse` or `TemplateError::Render` and returns the wrapper.

**Call relations**: The convenience `render` path uses this style of conversion after parsing or rendering fails. It creates the combined error variants that `TemplateError::fmt` and `TemplateError::source` later inspect.

*Call graph*: 2 external calls (Parse, Render).


##### `Template::parse`  (lines 122–168)

```
fn parse(source: &str) -> Result<Self, TemplateParseError>
```

**Purpose**: Reads raw template text and turns it into a reusable `Template`. It also checks that the placeholder syntax is valid before anyone tries to render it.

**Data flow**: It takes a source string and scans through it from left to right. Literal text is saved as literal segments, placeholders are parsed and saved by name, and escaped delimiters become ordinary text. If the syntax is invalid, it returns a parse error; otherwise it returns a `Template` containing its ordered placeholder set and segment list.

**Call relations**: This is the main entry into the reusable template flow. It calls `push_literal` to store ordinary text cleanly and `parse_placeholder` when it sees `{{`. It is used by the one-shot `render` function, by embedded-template parsing code elsewhere, and by tests that check both valid and invalid templates.

*Call graph*: calls 2 internal fn (parse_placeholder, push_literal); called by 13 (parse_embedded_template, parse_embedded_template, parse_embedded_template, render, parse_errors_when_closing_delimiter_is_unmatched, parse_errors_when_placeholder_is_empty, parse_errors_when_placeholder_is_nested, parse_errors_when_placeholder_is_unterminated, parsed_templates_can_be_reused, placeholders_are_sorted_and_unique (+3 more)); 3 external calls (new, new, Placeholder).


##### `Template::placeholders`  (lines 170–172)

```
fn placeholders(&self) -> impl ExactSizeIterator<Item = &str>
```

**Purpose**: Returns the names of all placeholders used by a parsed template. The names are unique and sorted, which makes them easy to inspect or compare.

**Data flow**: It reads the template’s stored placeholder set. It turns the stored strings into borrowed string slices and returns an iterator over them without changing the template.

**Call relations**: Callers use this after `Template::parse` when they need to know what values a template expects. The test for sorted and unique placeholders checks this behavior directly.

*Call graph*: 1 external calls (iter).


##### `Template::render`  (lines 174–209)

```
fn render(&self, variables: I) -> Result<String, TemplateRenderError>
```

**Purpose**: Fills a parsed template with actual values. It is strict: every placeholder must have exactly one value, and no unused values are allowed.

**Data flow**: It receives a collection of name-value pairs. First it builds a map and rejects duplicate names. Then it checks for missing template placeholders and extra supplied names. Finally it walks the stored template segments, copying literal text and replacing placeholders with their values, and returns the finished string.

**Call relations**: This is called after a template has already been parsed. Higher-level prompt code such as `render_memory_extensions_block` and `render_review_prompt` call it when they need to produce final text. It calls `build_variable_map` before assembling the output.

*Call graph*: calls 1 internal fn (build_variable_map); called by 2 (render_memory_extensions_block, render_review_prompt); 5 external calls (contains, contains_key, get, keys, new).


##### `render`  (lines 212–221)

```
fn render(template: &str, variables: I) -> Result<String, TemplateError>
```

**Purpose**: Provides a simple one-call way to render a template string. It is useful when the caller does not need to keep a parsed template for reuse.

**Data flow**: It takes raw template text and a set of variables. It parses the text into a `Template`, then renders that template with the variables. A parse failure or render failure comes back as one combined `TemplateError` type.

**Call relations**: This function sits on top of `Template::parse` and the parsed template’s render operation. The tests use it to confirm ordinary replacement, escaped delimiters, multiline templates, and error wrapping.

*Call graph*: calls 1 internal fn (parse); called by 5 (render_function_wraps_parse_errors, render_function_wraps_render_errors, render_replaces_placeholders_with_and_without_whitespace, render_supports_literal_delimiter_escapes, render_supports_multiline_templates_and_adjacent_placeholders).


##### `push_literal`  (lines 223–233)

```
fn push_literal(segments: &mut Vec<Segment>, literal: &str)
```

**Purpose**: Adds ordinary text to the template’s internal segment list. It avoids creating empty pieces and joins neighboring literal pieces together.

**Data flow**: It receives the current segment list and a slice of literal text. If the text is empty, it does nothing. If the last segment is already literal text, it appends to that segment; otherwise it creates a new literal segment.

**Call relations**: `Template::parse` calls this whenever it has found ordinary text or an escaped delimiter. It keeps the parsed template tidy so rendering can later walk fewer, cleaner pieces.

*Call graph*: called by 1 (parse); 1 external calls (Literal).


##### `parse_placeholder`  (lines 235–259)

```
fn parse_placeholder(source: &str, start: usize) -> Result<(String, usize), TemplateParseError>
```

**Purpose**: Parses one placeholder that starts with `{{`. It extracts the placeholder name and finds where parsing should continue afterward.

**Data flow**: It receives the full template source and the byte position where a placeholder begins. It scans until it finds the matching `}}`, trims whitespace around the name, and returns the name plus the next cursor position. If it finds a nested `{{`, an empty name, or no closing `}}`, it returns the appropriate parse error.

**Call relations**: `Template::parse` calls this only after it has recognized the start of a placeholder. The result becomes a placeholder segment and is also recorded in the template’s placeholder set.

*Call graph*: called by 1 (parse).


##### `build_variable_map`  (lines 261–280)

```
fn build_variable_map(
    variables: I,
) -> Result<BTreeMap<String, String>, TemplateRenderError>
```

**Purpose**: Turns supplied render values into a lookup table keyed by name. It also catches duplicate value names before rendering starts.

**Data flow**: It receives any iterable collection of name-value pairs. It copies each name and value into a sorted map. If inserting a name would replace an existing one, it returns a duplicate-value error; otherwise it returns the completed map.

**Call relations**: `Template::render` calls this as its first step. The map it returns is then used to check for missing or extra values and to look up replacements while building the final string.

*Call graph*: called by 1 (render); 1 external calls (new).


##### `tests::render_replaces_placeholders_with_and_without_whitespace`  (lines 292–303)

```
fn render_replaces_placeholders_with_and_without_whitespace()
```

**Purpose**: Checks that placeholders are replaced correctly whether or not there is whitespace inside the braces. It also verifies that repeated placeholders reuse the same supplied value.

**Data flow**: It gives the one-shot `render` function a greeting template and values for `name` and `place`. It expects the returned string to contain the substituted values in every matching location.

**Call relations**: The test runner calls this during the test suite. It exercises the public `render` helper and compares the result with the expected text.

*Call graph*: calls 1 internal fn (render); 1 external calls (assert_eq!).


##### `tests::parsed_templates_can_be_reused`  (lines 306–317)

```
fn parsed_templates_can_be_reused()
```

**Purpose**: Checks that a parsed `Template` can be rendered more than once with different values. This matters for callers that want to parse once and avoid repeating that work.

**Data flow**: It parses a greeting template once. Then it renders that same parsed template with two different sets of values and checks that each output matches the corresponding values.

**Call relations**: The test runner calls this as part of the suite. It uses `Template::parse` first, then the template’s render method, showing the reusable-template path.

*Call graph*: calls 1 internal fn (parse); 1 external calls (assert_eq!).


##### `tests::placeholders_are_sorted_and_unique`  (lines 320–324)

```
fn placeholders_are_sorted_and_unique()
```

**Purpose**: Checks that a template reports each placeholder name once and in sorted order. This makes placeholder inspection predictable.

**Data flow**: It parses a template containing `b`, `a`, and `b` again. It collects the placeholder iterator into a list and compares it to `a`, then `b`.

**Call relations**: The test runner calls this test. It goes through `Template::parse` and then uses `Template::placeholders` to verify the stored placeholder set behavior.

*Call graph*: calls 1 internal fn (parse); 1 external calls (assert_eq!).


##### `tests::render_supports_multiline_templates_and_adjacent_placeholders`  (lines 327–335)

```
fn render_supports_multiline_templates_and_adjacent_placeholders()
```

**Purpose**: Checks that rendering works across line breaks and when two placeholders are directly next to each other. This protects common prompt-formatting cases.

**Data flow**: It passes a two-line template with adjacent placeholders to `render`, along with three values. It expects a string where the first two values touch each other and the line break is preserved.

**Call relations**: The test runner calls this test. It exercises the public `render` helper and confirms that parsing and rendering do not depend on spaces or single-line input.

*Call graph*: calls 1 internal fn (render); 1 external calls (assert_eq!).


##### `tests::render_supports_literal_delimiter_escapes`  (lines 338–349)

```
fn render_supports_literal_delimiter_escapes()
```

**Purpose**: Checks that users can include literal `{{` and `}}` text in a template. Without this, delimiter characters could only mean placeholders.

**Data flow**: It sends a template containing `{{{{` and `}}}}` escapes plus a real placeholder to `render`. It expects the escapes to become literal braces and the placeholder to be replaced.

**Call relations**: The test runner calls this test. It verifies the escape-handling path in `Template::parse` through the public `render` function.

*Call graph*: calls 1 internal fn (render); 1 external calls (assert_eq!).


##### `tests::parse_errors_when_placeholder_is_empty`  (lines 352–356)

```
fn parse_errors_when_placeholder_is_empty()
```

**Purpose**: Checks that an empty placeholder is rejected. This prevents templates from containing blanks that cannot be matched to a meaningful value name.

**Data flow**: It tries to parse text containing `{{   }}`. It expects parsing to fail with an `EmptyPlaceholder` error at the correct starting position.

**Call relations**: The test runner calls this test. It directly exercises `Template::parse`, which calls `parse_placeholder` to detect the empty name.

*Call graph*: calls 1 internal fn (parse); 1 external calls (assert_eq!).


##### `tests::parse_errors_when_placeholder_is_unterminated`  (lines 359–366)

```
fn parse_errors_when_placeholder_is_unterminated()
```

**Purpose**: Checks that a placeholder without a closing `}}` is rejected. This catches accidental unfinished template syntax.

**Data flow**: It tries to parse text where `{{ name` never closes. It expects an `UnterminatedPlaceholder` error at the placeholder’s start.

**Call relations**: The test runner calls this test. It verifies the error path from `Template::parse` through `parse_placeholder`.

*Call graph*: calls 1 internal fn (parse); 1 external calls (assert_eq!).


##### `tests::parse_errors_when_placeholder_is_nested`  (lines 369–373)

```
fn parse_errors_when_placeholder_is_nested()
```

**Purpose**: Checks that placeholders cannot contain another `{{` inside them. This keeps the template language simple and avoids ambiguous parsing.

**Data flow**: It parses text with `{{ outer {{ inner }} }}`. It expects a `NestedPlaceholder` error pointing to the outer placeholder start.

**Call relations**: The test runner calls this test. It confirms that `parse_placeholder`, reached from `Template::parse`, rejects nested opening delimiters.

*Call graph*: calls 1 internal fn (parse); 1 external calls (assert_eq!).


##### `tests::parse_errors_when_closing_delimiter_is_unmatched`  (lines 376–383)

```
fn parse_errors_when_closing_delimiter_is_unmatched()
```

**Purpose**: Checks that a stray closing `}}` is rejected. This helps catch typos where a template has closing braces without an opening placeholder.

**Data flow**: It tries to parse text containing `}}` outside any placeholder. It expects an `UnmatchedClosingDelimiter` error at that position.

**Call relations**: The test runner calls this test. It exercises the direct unmatched-closing check inside `Template::parse`.

*Call graph*: calls 1 internal fn (parse); 1 external calls (assert_eq!).


##### `tests::render_errors_when_placeholder_is_missing`  (lines 386–395)

```
fn render_errors_when_placeholder_is_missing()
```

**Purpose**: Checks that rendering fails when a template needs a value that was not supplied. This prevents incomplete output from being produced silently.

**Data flow**: It parses a template needing `name`, then renders it with no values. It expects a `MissingValue` error naming `name`.

**Call relations**: The test runner calls this test. It uses `Template::parse` and then the template’s render method to verify strict missing-value checking.

*Call graph*: calls 1 internal fn (parse); 1 external calls (assert_eq!).


##### `tests::render_errors_when_extra_value_is_provided`  (lines 398–407)

```
fn render_errors_when_extra_value_is_provided()
```

**Purpose**: Checks that rendering fails when the caller supplies a value the template does not use. This catches misspelled or stale variable names.

**Data flow**: It parses a template needing only `name`, then renders with both `name` and `unused`. It expects an `ExtraValue` error for `unused`.

**Call relations**: The test runner calls this test. It exercises the extra-value validation inside the parsed template’s render method.

*Call graph*: calls 1 internal fn (parse); 1 external calls (assert_eq!).


##### `tests::render_errors_when_duplicate_value_is_provided`  (lines 410–419)

```
fn render_errors_when_duplicate_value_is_provided()
```

**Purpose**: Checks that rendering fails when the same variable name is supplied twice. This avoids unclear situations where one value might silently override another.

**Data flow**: It parses a template needing `name`, then renders with two different entries both named `name`. It expects a `DuplicateValue` error.

**Call relations**: The test runner calls this test. It verifies the duplicate detection performed by `build_variable_map`, reached through the template’s render method.

*Call graph*: calls 1 internal fn (parse); 1 external calls (assert_eq!).


##### `tests::render_function_wraps_parse_errors`  (lines 422–429)

```
fn render_function_wraps_parse_errors()
```

**Purpose**: Checks that the one-shot `render` helper wraps parsing failures in `TemplateError::Parse`. This gives callers one error type without hiding what went wrong.

**Data flow**: It calls `render` with a malformed template containing an unmatched closing delimiter. It expects the returned error to be the combined parse-error wrapper with the original parse details inside.

**Call relations**: The test runner calls this test. It exercises the public `render` helper and confirms its parse-error conversion behavior.

*Call graph*: calls 1 internal fn (render); 1 external calls (assert_eq!).


##### `tests::render_function_wraps_render_errors`  (lines 432–441)

```
fn render_function_wraps_render_errors()
```

**Purpose**: Checks that the one-shot `render` helper wraps rendering failures in `TemplateError::Render`. This confirms render-time problems are reported through the combined error type.

**Data flow**: It calls `render` with a valid template needing `name` but supplies only `extra`. It expects a combined render-error wrapper containing a missing-value error for `name`.

**Call relations**: The test runner calls this test. It exercises the public `render` helper and confirms its render-error conversion behavior.

*Call graph*: calls 1 internal fn (render); 1 external calls (assert_eq!).
