# Utility crate tests for path/URI and output truncation helpers  `stage-23.6.6`

This stage is the project’s safety net for two small but important shared tools. It is not part of startup or shutdown. Instead, it is behind-the-scenes support: tests that make sure other parts of the system can trust these utility libraries.

One part checks output truncation, which means cutting text down to fit a size limit. The tests in truncate_tests.rs make sure shortening works the same way whether the limit is based on bytes or tokens, and whether the output is plain text or a structured list of content items. This prevents broken snippets and inconsistent limits.

The other two files focus on paths and URIs. A URI is a standard text form for identifying a location, like a file or web address. tests.rs checks PathUri, the core type that stores file-like locations in a platform-safe way. It verifies normalization, conversion to native Windows or POSIX path forms, encoding fallbacks, serialization, and clear error handling. api_path_string_tests.rs then tests the API-facing wrapper that turns those locations into the text form users and external callers see, including tricky cases like Windows drives, network shares, and unusual fallback URIs.

## Files in this stage

### Output truncation tests
These tests verify how shared truncation helpers enforce byte and token limits for plain text and structured output items.

### `utils/output-truncation/src/truncate_tests.rs`

`test` · `test run`

This test file documents the exact user-visible strings produced by the output-truncation helpers. The early tests focus on `formatted_truncate_text`, asserting both pass-through behavior under budget and the precise warning header plus middle-truncation marker when over budget. They also verify that the reported original line count reflects the untruncated input and that UTF-8 content is truncated safely without splitting code points. The larger structured-output tests cover both truncation strategies from the library: `truncate_function_output_items_with_policy` spends budget across multiple `InputText` items, preserves `InputImage` and `EncryptedContent` items untouched, truncates the first over-budget text item into a snippet, and appends an omission summary for later text items; `formatted_truncate_text_content_items_with_policy` instead merges all text items into one newline-separated block, emits a single warning-bearing `InputText`, and appends non-text items afterward. Several tests target subtle edge cases, such as empty leading text segments affecting merged line counts, token-budget truncation across multiple text items, and preservation of encrypted opaque payloads. The final test covers the signed byte-to-token conversion helper’s clamping behavior for negative and zero inputs. Together these tests serve as executable documentation for exact formatting, ordering, and omission semantics.

#### Function details

##### `truncate_bytes_less_than_placeholder_returns_placeholder`  (lines 13–20)

```
fn truncate_bytes_less_than_placeholder_returns_placeholder()
```

**Purpose**: Verifies byte-budget truncation when the budget is smaller than the visible placeholder still returns the expected warning-prefixed placeholder form.

**Data flow**: It defines a short string, calls `formatted_truncate_text` with `TruncationPolicy::Bytes(1)`, and asserts exact equality with the expected warning header and `…13 chars truncated…t` body.

**Call relations**: This test exercises the extreme low-byte-budget path of `formatted_truncate_text` and the underlying byte-based middle truncation.

*Call graph*: 1 external calls (assert_eq!).


##### `truncate_tokens_less_than_placeholder_returns_placeholder`  (lines 23–30)

```
fn truncate_tokens_less_than_placeholder_returns_placeholder()
```

**Purpose**: Verifies token-budget truncation under an extremely small token budget still produces the expected placeholder-style output.

**Data flow**: It passes `"example output"` to `formatted_truncate_text` with `TruncationPolicy::Tokens(1)` and asserts the exact warning-prefixed result string.

**Call relations**: This test covers the token-budget branch of `truncate_text` as surfaced through `formatted_truncate_text`.

*Call graph*: 1 external calls (assert_eq!).


##### `truncate_tokens_under_limit_returns_original`  (lines 33–40)

```
fn truncate_tokens_under_limit_returns_original()
```

**Purpose**: Checks that token-budget formatting is a no-op when the content is comfortably under budget.

**Data flow**: It calls `formatted_truncate_text` on a short string with `TruncationPolicy::Tokens(10)` and asserts the returned string is exactly the original content.

**Call relations**: This test covers the early-return path in `formatted_truncate_text` where no warning header is added.

*Call graph*: 1 external calls (assert_eq!).


##### `truncate_bytes_under_limit_returns_original`  (lines 43–50)

```
fn truncate_bytes_under_limit_returns_original()
```

**Purpose**: Checks that byte-budget formatting is a no-op when the content length is within the allowed byte budget.

**Data flow**: It calls `formatted_truncate_text` with `TruncationPolicy::Bytes(20)` on a shorter string and asserts exact equality with the original content.

**Call relations**: This test covers the byte-budget early-return branch in `formatted_truncate_text`.

*Call graph*: 1 external calls (assert_eq!).


##### `truncate_tokens_over_limit_returns_truncated`  (lines 53–60)

```
fn truncate_tokens_over_limit_returns_truncated()
```

**Purpose**: Verifies the exact warning and truncation marker produced for an over-budget token-limited string.

**Data flow**: It formats a longer sentence with `TruncationPolicy::Tokens(5)` and asserts the exact expected warning header and token-truncated body.

**Call relations**: This test documents the visible output of token-based truncation through the formatted wrapper.

*Call graph*: 1 external calls (assert_eq!).


##### `truncate_bytes_over_limit_returns_truncated`  (lines 63–70)

```
fn truncate_bytes_over_limit_returns_truncated()
```

**Purpose**: Verifies the exact warning and truncation marker produced for an over-budget byte-limited string.

**Data flow**: It formats a longer sentence with `TruncationPolicy::Bytes(30)` and asserts the exact expected warning header and byte-truncated body.

**Call relations**: This test documents the visible output of byte-based truncation through the formatted wrapper.

*Call graph*: 1 external calls (assert_eq!).


##### `truncate_bytes_reports_original_line_count_when_truncated`  (lines 73–81)

```
fn truncate_bytes_reports_original_line_count_when_truncated()
```

**Purpose**: Checks that formatted byte truncation reports the original number of lines, not the line count of the truncated snippet.

**Data flow**: It passes a two-line string to `formatted_truncate_text` with a small byte budget and asserts the warning header contains `Total output lines: 2` along with the expected truncated body.

**Call relations**: This test targets the line-count bookkeeping in `formatted_truncate_text`.

*Call graph*: 1 external calls (assert_eq!).


##### `truncate_tokens_reports_original_line_count_when_truncated`  (lines 84–92)

```
fn truncate_tokens_reports_original_line_count_when_truncated()
```

**Purpose**: Checks that formatted token truncation also reports the original line count correctly.

**Data flow**: It passes a two-line string to `formatted_truncate_text` with `TruncationPolicy::Tokens(10)` and asserts the exact warning-prefixed output string.

**Call relations**: This test complements the byte-based line-count test for the token-budget branch.

*Call graph*: 1 external calls (assert_eq!).


##### `truncate_middle_bytes_handles_utf8_content`  (lines 95–99)

```
fn truncate_middle_bytes_handles_utf8_content()
```

**Purpose**: Ensures byte-budget truncation respects UTF-8 boundaries and produces a valid string when multibyte characters are present.

**Data flow**: It defines a string containing emoji and ASCII text, calls `truncate_text` with `TruncationPolicy::Bytes(20)`, and asserts the exact truncated output string.

**Call relations**: This test directly exercises `truncate_text`’s byte branch and indirectly the UTF-8-safe behavior of `truncate_middle_chars`.

*Call graph*: 3 external calls (assert_eq!, truncate_text, Bytes).


##### `truncates_across_multiple_under_limit_texts_and_reports_omitted`  (lines 102–164)

```
fn truncates_across_multiple_under_limit_texts_and_reports_omitted()
```

**Purpose**: Verifies incremental token-budget truncation across multiple text items, preservation of images, and omission-summary generation for later text items.

**Data flow**: It builds several `InputText` items plus an `InputImage`, computes a token budget equal to three chunks, runs `truncate_function_output_items_with_policy`, and then inspects the output vector: first two text items unchanged, image preserved, fourth item truncated with a marker, and final summary mentioning two omitted text items.

**Call relations**: This test exercises the main loop in `truncate_function_output_items_with_policy`, especially budget depletion, partial truncation of one item, and omission counting for subsequent text items.

*Call graph*: 7 external calls (assert!, assert_eq!, approx_token_count, truncate_function_output_items_with_policy, panic!, Tokens, vec!).


##### `formatted_truncate_text_content_items_with_policy_returns_original_under_limit`  (lines 167–185)

```
fn formatted_truncate_text_content_items_with_policy_returns_original_under_limit()
```

**Purpose**: Checks that merged-text content-item formatting returns the original item list unchanged when the combined text fits the budget.

**Data flow**: It constructs three `InputText` items, including an empty string, calls `formatted_truncate_text_content_items_with_policy` with a generous byte budget, and asserts the output equals the original items and the optional original token count is `None`.

**Call relations**: This test covers the under-budget early return in the merged-text content-item helper.

*Call graph*: 4 external calls (assert_eq!, formatted_truncate_text_content_items_with_policy, Bytes, vec!).


##### `formatted_truncate_text_content_items_with_policy_preserves_empty_leading_text_behavior`  (lines 188–208)

```
fn formatted_truncate_text_content_items_with_policy_preserves_empty_leading_text_behavior()
```

**Purpose**: Verifies how an empty leading text item affects merged-text truncation and line counting when the combined content is over budget.

**Data flow**: It builds two text items, the first empty and the second `"abc"`, calls `formatted_truncate_text_content_items_with_policy` with zero byte budget, and asserts the output is a single warning-bearing `InputText` with the expected line count and truncation marker, plus `Some(1)` original token count.

**Call relations**: This test targets a subtle edge case in the helper’s newline-joining behavior for multiple text segments.

*Call graph*: 4 external calls (assert_eq!, formatted_truncate_text_content_items_with_policy, Bytes, vec!).


##### `formatted_truncate_text_content_items_with_policy_merges_text_and_appends_images`  (lines 211–252)

```
fn formatted_truncate_text_content_items_with_policy_merges_text_and_appends_images()
```

**Purpose**: Checks that merged-text truncation collapses all text items into one warning-bearing text item while preserving images afterward.

**Data flow**: It constructs interleaved text and image items, calls `formatted_truncate_text_content_items_with_policy` with a small byte budget, and asserts the output contains one merged/truncated `InputText` followed by the two original `InputImage` items, with `Some(4)` original token count.

**Call relations**: This test exercises the helper’s text extraction, newline joining, truncation, and non-text reattachment behavior.

*Call graph*: 4 external calls (assert_eq!, formatted_truncate_text_content_items_with_policy, Bytes, vec!).


##### `formatted_truncate_text_content_items_with_policy_preserves_encrypted_content`  (lines 255–280)

```
fn formatted_truncate_text_content_items_with_policy_preserves_encrypted_content()
```

**Purpose**: Verifies that merged-text truncation leaves encrypted content items untouched while replacing text with a single warning-bearing item.

**Data flow**: It builds one `InputText` and one `EncryptedContent`, truncates with a tiny byte budget, and asserts the output contains the expected warning-bearing text item followed by the unchanged encrypted item, plus the original token count.

**Call relations**: This test covers the branch in `formatted_truncate_text_content_items_with_policy` that preserves encrypted opaque payloads alongside truncated text.

*Call graph*: 4 external calls (assert_eq!, formatted_truncate_text_content_items_with_policy, Bytes, vec!).


##### `truncate_function_output_items_with_policy_preserves_encrypted_content`  (lines 283–306)

```
fn truncate_function_output_items_with_policy_preserves_encrypted_content()
```

**Purpose**: Verifies that per-item truncation preserves encrypted content items while truncating only text items.

**Data flow**: It builds one text item and one encrypted item, runs `truncate_function_output_items_with_policy` with a small byte budget, and asserts the output contains a truncated text snippet followed by the unchanged encrypted item.

**Call relations**: This test targets the non-text preservation branch in the iterative item-preserving truncation function.

*Call graph*: 4 external calls (assert_eq!, truncate_function_output_items_with_policy, Bytes, vec!).


##### `formatted_truncate_text_content_items_with_policy_merges_all_text_for_token_budget`  (lines 309–329)

```
fn formatted_truncate_text_content_items_with_policy_merges_all_text_for_token_budget()
```

**Purpose**: Checks that token-budget merged-text truncation treats multiple text items as one combined text block.

**Data flow**: It creates two text items, truncates them with `TruncationPolicy::Tokens(2)`, and asserts the output is a single warning-bearing `InputText` with the expected merged token-truncated body and `Some(5)` original token count.

**Call relations**: This test specifically documents token-budget behavior in `formatted_truncate_text_content_items_with_policy`, distinct from byte-budget merging.

*Call graph*: 4 external calls (assert_eq!, formatted_truncate_text_content_items_with_policy, Tokens, vec!).


##### `byte_count_conversion_clamps_non_positive_values`  (lines 332–336)

```
fn byte_count_conversion_clamps_non_positive_values()
```

**Purpose**: Tests the signed byte-to-token conversion helper’s clamping for negative and zero inputs and a normal positive conversion.

**Data flow**: It calls `approx_tokens_from_byte_count_i64` with `-1`, `0`, and `5`, and asserts the results are `0`, `0`, and `2` respectively.

**Call relations**: This test covers the guard and conversion behavior of the small numeric adapter function.

*Call graph*: 1 external calls (assert_eq!).


### Path URI semantics tests
This sequence documents the core `PathUri` behavior first and then the higher-level API-facing `LegacyAppPathString` wrapper built on top of it.

### `utils/path-uri/src/tests.rs`

`test` · `test execution`

This file tests `PathUri` directly, independent of the API-path-string layer. The suite covers both ordinary hierarchical `file:` URIs and the special opaque fallback namespace used when native absolute paths cannot be represented as standard file URLs. Many tests are cross-platform, while Unix- and Windows-specific cases validate behavior that depends on native path encodings or host conversion rules.

The tests establish several key invariants. Canonicalization collapses spelling aliases like uppercase `FILE:` and `file://localhost/...` into one form. `PathUri::from_abs_path` and `to_abs_path` round-trip ordinary absolute paths and also round-trip fallback URIs for POSIX null-byte paths, Windows namespace prefixes, and non-Unicode Windows paths. Validation rejects unsupported schemes, queries, fragments, encoded null bytes, malformed fallback payloads, and relative native paths during both direct construction and serde deserialization. Lexical helpers are pinned down separately: `basename` decodes URI segments, `parent` follows URI hierarchy while preserving authority, and `join` normalizes relative segments without letting `..` escape the root or turning encoded filename characters into URI metadata. Several tests also verify the convention inference heuristic, especially the intentional choice to treat drive-shaped `/C:/...` URIs as Windows. Together these tests define the crate's intended behavior more concretely than the API docs alone.

#### Function details

##### `file_uri_round_trips_an_absolute_path`  (lines 13–32)

```
fn file_uri_round_trips_an_absolute_path()
```

**Purpose**: Checks the ordinary happy path from an absolute native path to `PathUri` and back. It also verifies the serialized URI spelling contains the expected `file:` prefix and percent-encoded space.

**Data flow**: Builds a path under the current directory, converts it with `PathUri::from_abs_path`, reads `to_string()` for textual assertions, reparses that string with `PathUri::parse`, and converts the URI back with `to_abs_path()`, comparing both results to the originals.

**Call relations**: Run by the test harness as the baseline round-trip test for ordinary absolute paths, exercising both conversion directions and canonical string formatting.

*Call graph*: calls 2 internal fn (current_dir, from_abs_path); 2 external calls (assert!, assert_eq!).


##### `non_native_uri_io_conversion_is_invalid_input`  (lines 35–52)

```
fn non_native_uri_io_conversion_is_invalid_input()
```

**Purpose**: Verifies that a syntactically valid foreign-platform `file:` URI cannot be converted into a native path on the current host. The exact sample URI differs by platform to ensure it is non-native.

**Data flow**: Parses a UNC URI on Unix or a POSIX-root URI on Windows, calls `to_abs_path()` expecting an error, then compares the resulting `io::ErrorKind` and message against `InvalidInput` and the formatted invalid-path text.

**Call relations**: Invoked by the test harness to pin down host-dependent failure behavior of `to_abs_path` for foreign URIs.

*Call graph*: calls 1 internal fn (parse); 1 external calls (assert_eq!).


##### `file_uri_parses_a_windows_path_on_any_host`  (lines 55–65)

```
fn file_uri_parses_a_windows_path_on_any_host()
```

**Purpose**: Ensures a Windows drive-style `file:` URI parses successfully regardless of the host OS. It confirms that lexical inspection remains URI-based rather than host-based.

**Data flow**: Parses `file:///C:/Users/Alice%20Smith/src/main.rs`, then reads `encoded_path()`, `basename()`, and `to_string()` and compares each with the expected canonical values.

**Call relations**: Called by the test harness as a cross-platform parsing test for foreign Windows URI syntax.

*Call graph*: calls 1 internal fn (parse); 1 external calls (assert_eq!).


##### `infers_path_conventions_from_uri_shape`  (lines 68–91)

```
fn infers_path_conventions_from_uri_shape()
```

**Purpose**: Tests `PathUri::infer_path_convention` across ordinary POSIX URIs, Windows drive URIs, UNC authorities, and opaque fallback URIs. It also covers an invalid fallback payload that should infer no convention.

**Data flow**: Loops over URI strings and expected `Option<PathConvention>`, parses each URI, calls `infer_path_convention()`, and compares the result.

**Call relations**: Run by the test harness to validate the convention heuristic independently of native-path conversion.

*Call graph*: calls 1 internal fn (parse); 1 external calls (assert_eq!).


##### `drive_shaped_posix_uri_is_intentionally_inferred_as_windows`  (lines 94–101)

```
fn drive_shaped_posix_uri_is_intentionally_inferred_as_windows()
```

**Purpose**: Documents the deliberate heuristic that `/C:/...` is treated as Windows even though it is also legal POSIX path text. This test protects that design choice from accidental regression.

**Data flow**: Parses `file:///C:/actually/a/posix/path`, calls `infer_path_convention()`, and asserts it returns `Some(PathConvention::Windows)`.

**Call relations**: A focused companion to the broader convention-inference test, emphasizing the crate's preference for recognizing foreign Windows paths.

*Call graph*: calls 1 internal fn (parse); 1 external calls (assert_eq!).


##### `file_uri_falls_back_for_windows_prefixes_without_a_uri_representation`  (lines 105–128)

```
fn file_uri_falls_back_for_windows_prefixes_without_a_uri_representation()
```

**Purpose**: On Windows, verifies that namespace-prefixed paths such as `\\.\COM1` and `\\?\Volume{...}` are encoded into opaque fallback URIs and can be decoded back losslessly. These paths cannot be represented as ordinary file URLs.

**Data flow**: For each native path string, validates it as `AbsolutePathBuf`, converts it with `PathUri::from_abs_path`, compares `to_string()` with the expected fallback URI, reparses that URI with `PathUri::parse`, converts it back with `to_abs_path()`, and compares with the original path.

**Call relations**: Windows-only test run by the harness to exercise the fallback branch of `from_abs_path` and the guarded decode path in `to_abs_path`.

*Call graph*: calls 2 internal fn (from_absolute_path_checked, from_abs_path); 1 external calls (assert_eq!).


##### `file_uri_fallback_round_trips_non_unicode_windows_paths`  (lines 132–148)

```
fn file_uri_fallback_round_trips_non_unicode_windows_paths()
```

**Purpose**: On Windows, confirms that fallback URIs preserve absolute paths containing non-Unicode UTF-16 data. It specifically uses an unpaired surrogate to force the fallback representation.

**Data flow**: Builds a UTF-16 vector from `C:\bad\` plus `0xd800`, converts it into `PathBuf` via `OsString::from_wide`, validates it as `AbsolutePathBuf`, creates a fallback URI with `from_abs_path`, reparses the URI string, checks the URI starts with `BAD_PATH_URI_PREFIX`, and converts the reparsed URI back with `to_abs_path()` for equality with the original path.

**Call relations**: Windows-only test invoked by the harness to validate fallback handling for non-Unicode native paths, complementing the namespace-prefix fallback test.

*Call graph*: calls 3 internal fn (from_absolute_path_checked, from_abs_path, parse); 4 external calls (from_wide, from, assert!, assert_eq!).


##### `file_uri_falls_back_for_posix_paths_with_null_bytes`  (lines 152–174)

```
fn file_uri_falls_back_for_posix_paths_with_null_bytes()
```

**Purpose**: On Unix, verifies that absolute paths containing null bytes are encoded into the reserved fallback namespace, serialize as strings, deserialize back, and decode to the original path. This covers a native path shape ordinary file URLs cannot safely represent.

**Data flow**: Constructs a `PathBuf` from raw bytes `/tmp/null-\0-\xff-byte`, validates it as `AbsolutePathBuf`, converts it with `from_abs_path`, compares the URI against a parsed expected fallback URI, serializes it with serde, deserializes it back into `PathUri`, checks the exact JSON string, and converts the reparsed URI back with `to_abs_path()`.

**Call relations**: Unix-only test run by the harness to exercise fallback generation, serde round-trip, and guarded fallback decoding for raw-byte POSIX paths.

*Call graph*: calls 2 internal fn (from_absolute_path_checked, from_abs_path); 5 external calls (from, assert_eq!, from_str, to_string, from_vec).


##### `ordinary_bad_path_uri_is_not_decoded_as_a_fallback`  (lines 178–188)

```
fn ordinary_bad_path_uri_is_not_decoded_as_a_fallback()
```

**Purpose**: Ensures that a normal path whose text happens to resemble the base64 payload of a fallback URI is treated literally, not as an opaque fallback. This protects the reserved namespace from overmatching.

**Data flow**: Builds an absolute POSIX path `/bad/path/L3RtcC9udWxsLQAt_y1ieXRl`, converts it with `from_abs_path`, checks the resulting URI string is the ordinary `file:///bad/path/...` form, and converts it back with `to_abs_path()` to confirm literal interpretation.

**Call relations**: Unix-only test invoked by the harness to distinguish ordinary hierarchical paths from the reserved `%00/bad/path/` fallback namespace.

*Call graph*: calls 2 internal fn (from_absolute_path_checked, from_abs_path); 1 external calls (assert_eq!).


##### `malformed_bad_path_uris_are_rejected`  (lines 191–208)

```
fn malformed_bad_path_uris_are_rejected()
```

**Purpose**: Checks that malformed lookalikes of the fallback namespace are rejected during parsing rather than silently treated as valid paths. It covers empty payloads, invalid base64, padded base64, non-canonical encodings, extra segments, and wrong prefixes.

**Data flow**: Iterates over malformed URI strings, calls `PathUri::parse` on each, and compares the result with `Err(PathUriParseError::InvalidFileUriPath { path: uri.to_string() })`.

**Call relations**: Run by the test harness to validate the strict canonicality checks implemented by `decode_bad_path_uri` and `validate_file_url`.

*Call graph*: 1 external calls (assert_eq!).


##### `structurally_valid_bad_path_uri_with_invalid_native_payload_fails_conversion`  (lines 211–221)

```
fn structurally_valid_bad_path_uri_with_invalid_native_payload_fails_conversion()
```

**Purpose**: Shows that a canonical fallback URI can parse successfully yet still fail native conversion if its payload does not decode to a valid absolute path. This separates URI-shape validity from native-path validity.

**Data flow**: Parses `file:///%00/bad/path/YQ`, calls `to_abs_path()` expecting failure, and asserts the resulting `io::ErrorKind` is `InvalidInput`.

**Call relations**: Invoked by the test harness to exercise the revalidation logic inside `to_abs_path` for fallback payloads.

*Call graph*: calls 1 internal fn (parse); 1 external calls (assert_eq!).


##### `bad_path_uris_are_opaque_to_lexical_operations`  (lines 224–237)

```
fn bad_path_uris_are_opaque_to_lexical_operations()
```

**Purpose**: Verifies that fallback URIs do not participate in lexical path operations except for the degenerate empty join. They are intended only for native round-trip conversion.

**Data flow**: Parses a fallback URI, then checks `basename()` and `parent()` both return `None`, `join("")` returns the original URI, and `join("child")` returns `InvalidFileUriPath` containing the URI string.

**Call relations**: Run by the test harness to pin down the special opaque behavior of fallback URIs in lexical APIs.

*Call graph*: calls 1 internal fn (parse); 1 external calls (assert_eq!).


##### `file_uri_parses_a_posix_path_on_any_host`  (lines 240–247)

```
fn file_uri_parses_a_posix_path_on_any_host()
```

**Purpose**: Ensures a standard POSIX `file:` URI parses and exposes expected lexical information on every host. This mirrors the Windows-path parsing test for the POSIX case.

**Data flow**: Parses `file:///home/alice/src/main.rs`, then reads and compares `encoded_path()`, `basename()`, and `to_string()`.

**Call relations**: Called by the test harness as a cross-platform parsing sanity check for ordinary POSIX URIs.

*Call graph*: calls 1 internal fn (parse); 1 external calls (assert_eq!).


##### `file_uri_preserves_paths_that_resemble_windows_paths`  (lines 250–257)

```
fn file_uri_preserves_paths_that_resemble_windows_paths()
```

**Purpose**: Checks that URI path text like `/C:/Project` and `/C:` is preserved literally in the encoded path and survives reparse. This avoids rewriting such spellings during canonicalization.

**Data flow**: For each input URI, parses it, reparses `uri.to_string()`, and compares `encoded_path()` and the reparsed `PathUri` with expected values.

**Call relations**: Run by the test harness to document that canonicalization preserves these path spellings even though convention inference may later classify them as Windows.

*Call graph*: calls 1 internal fn (parse); 1 external calls (assert_eq!).


##### `file_uri_accepts_non_utf8_posix_paths`  (lines 261–275)

```
fn file_uri_accepts_non_utf8_posix_paths()
```

**Purpose**: On Unix, verifies that non-UTF-8 absolute POSIX paths can still round-trip through `PathUri`. This covers the ordinary percent-encoded path case distinct from null-byte fallback encoding.

**Data flow**: Constructs a raw-byte path `/tmp/non-utf8-\xff`, validates it as `AbsolutePathBuf`, converts it with `from_abs_path`, converts back with `to_abs_path()`, reparses `uri.to_string()` with `PathUri::parse`, and compares both results with the original values.

**Call relations**: Unix-only test run by the harness to validate lossless handling of non-UTF-8 bytes that remain representable in ordinary file URIs.

*Call graph*: calls 2 internal fn (from_absolute_path_checked, from_abs_path); 3 external calls (from, assert_eq!, from_vec).


##### `file_uri_round_trips_literal_percent_characters`  (lines 278–284)

```
fn file_uri_round_trips_literal_percent_characters()
```

**Purpose**: Ensures `%25` remains a literal percent character in filename text rather than being normalized away. It checks both canonical URI spelling and lexical basename extraction.

**Data flow**: Parses `file:///tmp/100%25/file`, then compares `to_string()`, `encoded_path()`, and `basename()` with expected values.

**Call relations**: Invoked by the test harness as one of several tests guarding encoded filename characters from being mistaken for URI syntax.

*Call graph*: calls 1 internal fn (parse); 1 external calls (assert_eq!).


##### `file_uri_round_trips_windows_unc_paths`  (lines 288–295)

```
fn file_uri_round_trips_windows_unc_paths()
```

**Purpose**: On Windows, verifies that absolute UNC paths convert to `PathUri` and back correctly. It also checks that the encoded path excludes the authority portion.

**Data flow**: Validates `\\server\share\src\main.rs` as `AbsolutePathBuf`, converts it with `from_abs_path`, compares `encoded_path()` with `/share/src/main.rs`, and converts back with `to_abs_path()` for equality with the original path.

**Call relations**: Windows-only test run by the harness to cover ordinary UNC conversion rather than fallback encoding.

*Call graph*: calls 2 internal fn (from_absolute_path_checked, from_abs_path); 1 external calls (assert_eq!).


##### `file_uri_retains_unc_authority`  (lines 298–303)

```
fn file_uri_retains_unc_authority()
```

**Purpose**: Checks that parsing a UNC-style `file://server/...` URI preserves the authority in canonical string form. This distinguishes UNC hosts from local paths.

**Data flow**: Parses `file://server/share/src/main.rs`, then compares `encoded_path()` and `to_string()` with expected values.

**Call relations**: Called by the test harness to validate authority preservation for UNC URIs.

*Call graph*: calls 1 internal fn (parse); 1 external calls (assert_eq!).


##### `file_uri_spelling_aliases_have_one_canonical_form`  (lines 306–316)

```
fn file_uri_spelling_aliases_have_one_canonical_form()
```

**Purpose**: Verifies that multiple equivalent local URI spellings normalize to the same canonical `PathUri` string. It covers uppercase scheme, single-slash form, and localhost authority aliases.

**Data flow**: Loops over alias strings, parses each with `PathUri::parse`, and compares `to_string()` with `file:///workspace/src`.

**Call relations**: Run by the test harness to document canonicalization behavior implemented by URL parsing plus `without_localhost_authority`.

*Call graph*: calls 1 internal fn (parse); 1 external calls (assert_eq!).


##### `unsupported_schemes_are_rejected_at_construction`  (lines 319–339)

```
fn unsupported_schemes_are_rejected_at_construction()
```

**Purpose**: Ensures `PathUri::parse` rejects non-`file` schemes and reports the offending scheme name. This keeps the type narrowly scoped to filesystem URIs.

**Data flow**: Iterates over URI strings and expected scheme names, calls `PathUri::parse`, expects an error, and asserts it matches `PathUriParseError::UnsupportedScheme(expected_scheme)`.

**Call relations**: Invoked by the test harness to validate the scheme gate in `TryFrom<Url>`.

*Call graph*: calls 1 internal fn (parse); 1 external calls (assert!).


##### `path_uri_serializes_as_a_string`  (lines 342–352)

```
fn path_uri_serializes_as_a_string()
```

**Purpose**: Pins down serde output and input for `PathUri` as a plain JSON string containing the canonical URI. It verifies exact wire representation.

**Data flow**: Parses a `PathUri` from string syntax, serializes it with `serde_json::to_string`, deserializes it back with `serde_json::from_str`, and compares both the JSON text and the resulting value.

**Call relations**: Run by the test harness as the focused serde round-trip test for canonical URI strings.

*Call graph*: 3 external calls (assert_eq!, from_str, to_string).


##### `path_uri_deserializes_legacy_absolute_paths`  (lines 355–363)

```
fn path_uri_deserializes_legacy_absolute_paths()
```

**Purpose**: Checks backward-compatible serde input from an absolute native path string rather than a `file:` URI. Deserialization should convert that path into the corresponding `PathUri`.

**Data flow**: Builds an absolute path under the current directory, serializes the path itself to JSON, deserializes that JSON into `PathUri`, and compares the result with `PathUri::from_abs_path(&path)`.

**Call relations**: Invoked by the test harness to exercise the legacy-native-path branch of `PathUri::deserialize`.

*Call graph*: calls 1 internal fn (current_dir); 3 external calls (assert_eq!, from_str, to_string).


##### `path_uri_rejects_relative_native_paths`  (lines 366–370)

```
fn path_uri_rejects_relative_native_paths()
```

**Purpose**: Verifies that `PathUri::from_path` rejects relative filesystem paths. This enforces the crate invariant that `PathUri` always represents an absolute location.

**Data flow**: Calls `PathUri::from_path("src/lib.rs")`, expects an error, and checks that the `io::ErrorKind` is `InvalidInput`.

**Call relations**: Run by the test harness to validate the absolute-path check in `from_path`.

*Call graph*: calls 1 internal fn (from_path); 1 external calls (assert_eq!).


##### `path_uri_rejects_legacy_relative_paths_with_absolute_path_guard`  (lines 373–380)

```
fn path_uri_rejects_legacy_relative_paths_with_absolute_path_guard()
```

**Purpose**: Ensures serde deserialization of a relative native path string fails even when an absolute-path guard is installed. The test checks that the error message mentions non-absolute input.

**Data flow**: Captures the current directory, installs `AbsolutePathBufGuard` rooted there, attempts to deserialize `"src/lib.rs"` into `PathUri`, expects failure, and asserts the error string contains `path is not absolute`.

**Call relations**: Invoked by the test harness to verify that deserialization does not silently reinterpret relative legacy paths against ambient process state.

*Call graph*: calls 2 internal fn (current_dir, new); 1 external calls (assert!).


##### `unsupported_scheme_is_rejected_during_deserialization`  (lines 383–392)

```
fn unsupported_scheme_is_rejected_during_deserialization()
```

**Purpose**: Checks that serde deserialization surfaces unsupported URI schemes as errors rather than treating them as native paths. This complements the direct-construction scheme test.

**Data flow**: Attempts to deserialize `"artifact://store/object-1"` into `PathUri`, expects an error, and asserts the error text contains the unsupported-scheme message.

**Call relations**: Run by the test harness to validate the URI-first branch of `PathUri::deserialize`.

*Call graph*: 1 external calls (assert!).


##### `known_path_uris_reject_queries_and_fragments`  (lines 395–406)

```
fn known_path_uris_reject_queries_and_fragments()
```

**Purpose**: Verifies that `file:` URIs containing query strings or fragments are rejected. These components are intentionally unsupported metadata for this type.

**Data flow**: Parses one URI with `?version=1` and one with `#L1`, expects errors from both, and asserts they match `QueryNotAllowed` and `FragmentNotAllowed` respectively.

**Call relations**: Invoked by the test harness to exercise `validate_common_known_uri` through `PathUri::parse`.

*Call graph*: calls 1 internal fn (parse); 1 external calls (assert!).


##### `path_uris_reject_encoded_null_bytes`  (lines 409–411)

```
fn path_uris_reject_encoded_null_bytes()
```

**Purpose**: Checks that ordinary `file:` URIs containing `%00` in the path are rejected. Only the reserved fallback namespace may contain an encoded null.

**Data flow**: Calls `PathUri::parse("file:///tmp/%00")` and asserts the result is an error.

**Call relations**: Run by the test harness to validate the null-byte restriction enforced by `validate_file_url`.

*Call graph*: 1 external calls (assert!).


##### `encoded_filename_characters_round_trip_without_becoming_uri_metadata`  (lines 414–421)

```
fn encoded_filename_characters_round_trip_without_becoming_uri_metadata()
```

**Purpose**: Ensures encoded `?`, `#`, and `%` remain filename text rather than being interpreted as URI query, fragment, or escape syntax after parsing. It also checks decoded basename output.

**Data flow**: Parses `file:///tmp/a%3Fb%23c%25d`, then compares `to_string()`, `encoded_path()`, and `basename()` with expected values.

**Call relations**: Called by the test harness as part of the lexical-character preservation suite.

*Call graph*: calls 1 internal fn (parse); 1 external calls (assert_eq!).


##### `double_encoded_separator_remains_filename_text`  (lines 424–431)

```
fn double_encoded_separator_remains_filename_text()
```

**Purpose**: Verifies that `%252F` survives as filename text `%2F` rather than becoming a path separator. This protects encoded separator bytes from accidental structural interpretation.

**Data flow**: Parses `file:///tmp/a%252Fb`, then compares `to_string()`, `encoded_path()`, and `basename()` with expected values.

**Call relations**: Run by the test harness to pin down separator handling in canonical URI parsing and lexical basename decoding.

*Call graph*: calls 1 internal fn (parse); 1 external calls (assert_eq!).


##### `basename_uses_decoded_uri_segments`  (lines 434–449)

```
fn basename_uses_decoded_uri_segments()
```

**Purpose**: Checks `basename()` across roots, ordinary paths, encoded spaces, drive roots, and UNC shares. It confirms the method returns decoded segment text rather than raw percent-encoded spelling when UTF-8 decoding succeeds.

**Data flow**: Loops over URI strings and expected optional basenames, parses each URI, calls `basename()`, maps expected `&str` to `String`, and compares the results.

**Call relations**: Invoked by the test harness to validate lexical segment extraction independently of native-path conversion.

*Call graph*: calls 1 internal fn (parse); 1 external calls (assert_eq!).


##### `parent_uses_uri_hierarchy_and_preserves_authority`  (lines 452–472)

```
fn parent_uses_uri_hierarchy_and_preserves_authority()
```

**Purpose**: Tests `parent()` on local paths, roots, drive roots, and UNC paths. It verifies that hierarchy is computed lexically and that authorities are preserved where applicable.

**Data flow**: For each input URI and optional expected parent URI string, parses the input, parses the expected parent when present, calls `parent()`, and compares the result.

**Call relations**: Run by the test harness to exercise the URL-segment mutation logic inside `parent`.

*Call graph*: calls 1 internal fn (parse); 1 external calls (assert_eq!).


##### `join_normalizes_relative_uri_segments`  (lines 475–500)

```
fn join_normalizes_relative_uri_segments()
```

**Purpose**: Checks that `join()` handles `..`, root clamping, Windows-drive and UNC bases, encoded filename characters, and empty relative paths correctly. It defines the lexical normalization semantics of URI joining.

**Data flow**: For each `(base, relative, expected)` triple, parses the base and expected URIs, calls `base.join(relative)`, and compares the result with `Ok(expected)`.

**Call relations**: Invoked by the test harness to validate the main success path of `join`, including its normalization rules.

*Call graph*: calls 1 internal fn (parse); 1 external calls (assert_eq!).


##### `join_rejects_absolute_and_null_paths`  (lines 503–516)

```
fn join_rejects_absolute_and_null_paths()
```

**Purpose**: Verifies the two explicit rejection cases in `join`: absolute relative-path arguments and embedded null characters. These are invalid regardless of the base URI.

**Data flow**: Parses `file:///workspace` as the base, calls `join("/src")` and asserts it matches `JoinPathMustBeRelative("/src")`, then calls `join("src\0file")` and compares with `InvalidFileUriPath { path: "src\0file".to_string() }`.

**Call relations**: Run by the test harness as the negative-path companion to `join_normalizes_relative_uri_segments`.

*Call graph*: calls 1 internal fn (parse); 2 external calls (assert!, assert_eq!).


##### `to_url_returns_the_validated_url`  (lines 519–526)

```
fn to_url_returns_the_validated_url()
```

**Purpose**: Checks that `to_url()` exposes the canonical validated `Url`, including localhost normalization. It confirms callers receive the post-validation URL rather than the original input spelling.

**Data flow**: Parses `file://localhost/workspace/a%20file.rs`, calls `to_url()`, parses the expected canonical `Url` with `Url::parse`, and compares the two.

**Call relations**: Invoked by the test harness to validate the simple accessor after canonicalization has already occurred in `PathUri::parse`.

*Call graph*: calls 1 internal fn (parse); 1 external calls (assert_eq!).


### `utils/path-uri/src/api_path_string_tests.rs`

`test` · `test execution`

This test file is a specification suite for converting between canonical `file:` URIs (`PathUri`) and legacy API path strings (`LegacyAppPathString`). Its core fixture is the large `RENDER_CASES` table, built from `RenderCase` values whose `expected` field distinguishes exact round trips, lossy render-only conversions, and expected failures. The cases cover ordinary POSIX paths, Windows drive-letter paths, UNC authorities, URI aliases such as `FILE:` and `file://localhost`, percent-encoded characters, non-UTF-8 payloads, encoded separators, and the special `%00/bad/path/<base64>` opaque fallback namespace.

The main test iterates over every shared case, parses the URI, computes the expected `LegacyAppPathString` or `LegacyAppPathStringError`, and compares it with `LegacyAppPathString::from_path_uri`. For successful renders it also checks `infer_absolute_path_convention`, and for exact round-trip cases it deserializes the rendered string from JSON, converts it back with `to_path_uri`, and confirms equality with the original URI. Additional tests pin down behavior for relative and otherwise non-absolute API strings: they serialize unchanged but cannot become `PathUri`s. Host-specific tests verify conversion from `AbsolutePathBuf`, including Windows-only lossy rendering of non-Unicode native paths. Overall, this file documents that API path strings preserve foreign absolute syntax textually, infer conventions heuristically, and reject conversions only when absolute/native invariants are violated.

#### Function details

##### `RenderCase::round_trips`  (lines 14–24)

```
fn round_trips(
        uri: &'static str,
        convention: PathConvention,
        rendered: &'static str,
    ) -> Self
```

**Purpose**: Constructs a `RenderCase` whose URI should render to a native path string and parse back to the same `PathUri`. It packages the expected rendered text as `RenderExpectation::RoundTrip`.

**Data flow**: Takes a static URI string, a `PathConvention`, and the expected rendered native-path text. It builds and returns a `RenderCase` with those fields plus a `RoundTrip` expectation; it does not read or mutate external state.

**Call relations**: Used while defining the `RENDER_CASES` constant to mark cases that must succeed in both directions, which the main shared-case test later subjects to render, convention inference, JSON deserialize, and URI reparse checks.

*Call graph*: 1 external calls (RoundTrip).


##### `RenderCase::rejects`  (lines 26–32)

```
fn rejects(uri: &'static str, convention: PathConvention, error: ExpectedError) -> Self
```

**Purpose**: Constructs a `RenderCase` for a URI/convention pair that should fail rendering into `LegacyAppPathString`. It records which error category is expected.

**Data flow**: Accepts a static URI string, a `PathConvention`, and an `ExpectedError`. It returns a `RenderCase` whose `expected` field is `RenderExpectation::Error(error)`.

**Call relations**: Used in `RENDER_CASES` for incompatible convention and opaque-fallback rejection scenarios; the shared-case test maps these markers into concrete `LegacyAppPathStringError` values before comparing against `from_path_uri`.

*Call graph*: 1 external calls (Error).


##### `RenderCase::renders_lossily`  (lines 34–44)

```
fn renders_lossily(
        uri: &'static str,
        convention: PathConvention,
        rendered: &'static str,
    ) -> Self
```

**Purpose**: Constructs a `RenderCase` for URIs that can be rendered to API path text but cannot be parsed back losslessly. This captures cases where URI byte boundaries or encoded separators collapse during rendering.

**Data flow**: Takes a static URI string, a `PathConvention`, and the expected rendered text, then returns a `RenderCase` with `RenderExpectation::RenderOnly(rendered)`.

**Call relations**: Used in `RENDER_CASES` for lossy conversions such as non-UTF-8 bytes becoming replacement characters or `%2F` becoming a path separator; the shared-case test validates rendering and convention inference but intentionally skips URI round-trip assertions for these entries.

*Call graph*: 1 external calls (RenderOnly).


##### `renders_native_paths_from_shared_cases`  (lines 300–346)

```
fn renders_native_paths_from_shared_cases()
```

**Purpose**: Runs the table-driven compatibility suite for `LegacyAppPathString` rendering and parsing across all predefined URI/convention combinations. It is the central behavioral test for the API path string layer.

**Data flow**: Iterates over `RENDER_CASES`, parses each `case.uri` into a `PathUri`, translates the case expectation into either `Ok(LegacyAppPathString(...))` or a concrete `LegacyAppPathStringError`, and compares that with `LegacyAppPathString::from_path_uri(&path, case.convention)`. For successful renders it reads `infer_absolute_path_convention()` from the produced string and checks it matches the requested convention. For `RoundTrip` cases it deserializes the rendered text from JSON into `LegacyAppPathString`, converts it back with `to_path_uri(case.convention)`, and asserts equality with the original `PathUri` and with a second render pass.

**Call relations**: Invoked by the test harness. It drives `PathUri::parse` first, then exercises `LegacyAppPathString::from_path_uri`; only when the case is marked `RoundTrip` does it continue into JSON deserialization and `to_path_uri`, making this test the bridge between the shared fixture table and both conversion directions.

*Call graph*: calls 2 internal fn (parse, from_path_uri); 2 external calls (assert_eq!, json!).


##### `relative_api_path_serializes_and_deserializes_unchanged`  (lines 349–359)

```
fn relative_api_path_serializes_and_deserializes_unchanged()
```

**Purpose**: Verifies that relative API path strings are accepted as plain text values by serde and emitted unchanged. This preserves backward-compatible transport behavior even though such paths are not valid absolute native paths.

**Data flow**: For each raw relative string (`.`, `subdir`, `subdir/file.rs`), it deserializes JSON into `LegacyAppPathString`, then serializes the value back to JSON and compares with the original string literal.

**Call relations**: Called directly by the test harness. Unlike the shared-case test, it never attempts URI conversion; it isolates serde behavior for relative strings.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `relative_api_path_is_invalid_when_converted_to_a_path_uri`  (lines 362–375)

```
fn relative_api_path_is_invalid_when_converted_to_a_path_uri()
```

**Purpose**: Confirms that a relative `LegacyAppPathString` cannot be promoted into a `PathUri`. It also checks that convention inference returns `None` for such text.

**Data flow**: Deserializes the JSON string `subdir` into `LegacyAppPathString`, reads `infer_absolute_path_convention()` and expects `None`, then calls `to_path_uri(PathConvention::Posix)` and expects `LegacyAppPathStringError::InvalidNativePath` containing the original text and convention.

**Call relations**: Invoked by the test harness to pin down the boundary between permissive string deserialization and strict absolute-path conversion.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `other_non_absolute_api_paths_cannot_be_converted_to_path_uris`  (lines 378–395)

```
fn other_non_absolute_api_paths_cannot_be_converted_to_path_uris()
```

**Purpose**: Checks additional Windows-shaped but non-absolute API strings that should deserialize without validation yet fail URI conversion. It covers rooted-relative and drive-relative Windows syntax.

**Data flow**: Loops over `workspace\file.rs` and `C:file.rs` with `PathConvention::Windows`, deserializes each into `LegacyAppPathString`, verifies `infer_absolute_path_convention()` is `None`, then calls `to_path_uri(convention)` and expects `InvalidNativePath` with the original text.

**Call relations**: Run by the test harness as a companion to the relative-path test, extending invalid conversion coverage to Windows-specific non-absolute spellings.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `infers_absolute_path_conventions_from_api_text`  (lines 398–424)

```
fn infers_absolute_path_conventions_from_api_text()
```

**Purpose**: Validates the heuristic that recognizes whether raw API path text looks like an absolute Windows path, absolute POSIX path, or neither. It covers drive letters, UNC, device prefixes, POSIX roots, and ambiguous/non-absolute forms.

**Data flow**: For each `(raw_path, expected)` pair, it deserializes the string into `LegacyAppPathString`, calls `infer_absolute_path_convention()`, and compares the result with the expected `Option<PathConvention>`.

**Call relations**: Executed by the test harness to verify convention inference independently of URI parsing/rendering, using only API text deserialization.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `foreign_absolute_syntax_deserializes_without_host_interpretation`  (lines 427–438)

```
fn foreign_absolute_syntax_deserializes_without_host_interpretation()
```

**Purpose**: Ensures that absolute path syntax from another platform is preserved literally when deserialized as API text. The test guards against host-dependent reinterpretation during input parsing.

**Data flow**: Deserializes a Windows absolute path and a POSIX absolute path from JSON strings, then checks `as_str()` returns the exact original text and `infer_absolute_path_convention()` identifies the corresponding convention.

**Call relations**: Called by the test harness to confirm that `LegacyAppPathString` is a textual wrapper first, not a host-native path parser.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `renders_an_absolute_path_using_the_host_convention`  (lines 441–453)

```
fn renders_an_absolute_path_using_the_host_convention()
```

**Purpose**: Checks conversion from a host-native `AbsolutePathBuf` into `LegacyAppPathString`. The expected rendered text is selected with `#[cfg(unix)]` or `#[cfg(windows)]` so the assertion matches the current platform.

**Data flow**: Builds a platform-specific absolute path string, validates it with `AbsolutePathBuf::from_absolute_path_checked`, converts it via `LegacyAppPathString::from(path)`, and compares the result with a wrapper around the original native string.

**Call relations**: Invoked by the test harness to cover the `From<AbsolutePathBuf>` path into API text, separate from URI-based rendering.

*Call graph*: calls 1 internal fn (from_absolute_path_checked); 1 external calls (assert_eq!).


##### `renders_native_non_unicode_windows_fallback_lossily`  (lines 457–486)

```
fn renders_native_non_unicode_windows_fallback_lossily()
```

**Purpose**: On Windows, verifies that non-Unicode native paths render with replacement characters in API text and that the corresponding fallback `PathUri` can be rendered only under the Windows convention. It also confirms POSIX rendering rejects that fallback URI.

**Data flow**: Constructs a `PathBuf` from a UTF-16 sequence containing an unpaired surrogate, validates it as `AbsolutePathBuf`, converts it with `LegacyAppPathString::from_abs_path` and expects a string ending in `�`, then creates a `PathUri` with `PathUri::from_abs_path`. It renders that URI with `LegacyAppPathString::from_path_uri` under both `PathConvention::Windows` and `PathConvention::Posix`, expecting success for Windows and `OpaqueFallback` for POSIX.

**Call relations**: Windows-only test run by the harness. It ties together native-path conversion, fallback URI generation, and convention-sensitive rendering for malformed Unicode paths.

*Call graph*: calls 2 internal fn (from_absolute_path_checked, from_abs_path); 3 external calls (assert_eq!, from_wide, from).


##### `serializes_and_deserializes_as_a_string`  (lines 489–501)

```
fn serializes_and_deserializes_as_a_string()
```

**Purpose**: Pins down serde representation for `LegacyAppPathString` as a bare JSON string. It uses a rendered POSIX path as the sample value.

**Data flow**: Parses a `PathUri`, renders it to `LegacyAppPathString` with `from_path_uri`, serializes that value to JSON text, checks the exact JSON string, then deserializes it back and compares with the original rendered value.

**Call relations**: Invoked by the test harness as a focused serde round-trip check after obtaining a valid API path string from URI rendering.

*Call graph*: calls 2 internal fn (parse, from_path_uri); 2 external calls (assert_eq!, to_string).
