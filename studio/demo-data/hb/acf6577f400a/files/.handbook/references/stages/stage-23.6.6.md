# Utility crate tests for path/URI and output truncation helpers  `stage-23.6.6`

This stage is a behind-the-scenes safety check for shared utility code. It is not part of startup, the main work loop, or shutdown. Instead, it makes sure small helper libraries behave correctly before other parts of the system rely on them.

The output truncation tests check the helper that shortens large results. This is like trimming a long receipt while keeping the important warning labels intact. The tests cover plain long text, mixed text and images, encrypted content, line limits, token estimates, and odd edge cases, so shortened output stays predictable and safe.

The PathUri tests protect the type that represents local file paths as file:// addresses. They verify converting, saving, loading, joining, and parsing paths on Unix, Windows, and unusual inputs.

The API path string tests check compatibility with an older path format. They make sure file URIs can move to and from that format, including spaces, percent-escaped characters, network shares, and invalid text. Together, these tests keep path handling and output trimming reliable across the whole project.

## Files in this stage

### Output truncation tests
These tests verify how shared truncation helpers enforce byte and token limits for plain text and structured output items.

### `utils/output-truncation/src/truncate_tests.rs`

`test` · `test run`

This is a test file for the output-truncation code. That code is responsible for shortening tool or function output before it is shown or sent onward, so that very large output does not overwhelm the system. Think of it like trimming a long receipt: it keeps the beginning and end, adds a clear note about what was removed, and preserves important non-text attachments when needed.

The tests cover two kinds of limits: byte limits, which are based on stored text size, and token limits, which are rough chunks of text used by language models. They check that short output is left alone, long output is shortened in the middle, and the warning message reports the original token count and number of lines. They also make sure truncation does not split multi-byte characters, such as emoji, in a broken way.

The later tests focus on structured output made of separate content items. Some items are plain text, some are images, and some are encrypted opaque data. The tests confirm that text can be merged and truncated as one budget, while images and encrypted content are preserved rather than accidentally discarded or modified. Without these tests, a small change in truncation behavior could silently hide useful output, corrupt Unicode text, or drop important non-text content.

#### Function details

##### `truncate_bytes_less_than_placeholder_returns_placeholder`  (lines 13–20)

```
fn truncate_bytes_less_than_placeholder_returns_placeholder()
```

**Purpose**: This test checks what happens when the byte limit is so tiny that even the usual kept text barely fits. It makes sure the user still gets a clear truncation warning and a placeholder showing that most of the content was removed.

**Data flow**: It starts with the text "example output" and asks the formatter to keep only one byte. The truncation code produces a warning plus a very small visible slice of the original text. The test compares that result with the exact expected message.

**Call relations**: During a Rust test run, the test harness calls this function. The function relies on the truncation formatter through the expression being checked, then uses the assertion macro to confirm the output matches the expected text exactly.

*Call graph*: 1 external calls (assert_eq!).


##### `truncate_tokens_less_than_placeholder_returns_placeholder`  (lines 23–30)

```
fn truncate_tokens_less_than_placeholder_returns_placeholder()
```

**Purpose**: This test checks the same tiny-limit situation as the byte test, but using a token limit. A token is a rough unit of text used for language-model budgeting, and the test confirms the warning still makes sense when the budget is smaller than the normal placeholder.

**Data flow**: It gives the formatter "example output" with a one-token limit. The formatter returns a warning that includes the original token count and a shortened middle marker. The test compares the full returned string to the expected result.

**Call relations**: The Rust test runner invokes this function. The test exercises the formatted truncation path and finishes by using the assertion macro to catch any change in the exact user-facing wording.

*Call graph*: 1 external calls (assert_eq!).


##### `truncate_tokens_under_limit_returns_original`  (lines 33–40)

```
fn truncate_tokens_under_limit_returns_original()
```

**Purpose**: This test proves that text is not changed when it already fits within the token budget. That matters because truncation should only intervene when it is necessary.

**Data flow**: It passes "example output" with a token limit large enough to contain it. The formatter should return the original string unchanged. The test checks that the before and after text are identical.

**Call relations**: The test harness calls this function as part of the suite. It exercises the formatted truncation function in the no-op case and uses the assertion macro to verify that no warning or marker was added.

*Call graph*: 1 external calls (assert_eq!).


##### `truncate_bytes_under_limit_returns_original`  (lines 43–50)

```
fn truncate_bytes_under_limit_returns_original()
```

**Purpose**: This test confirms that byte-based truncation leaves short text untouched. It protects against accidentally adding warnings or changing content when the output is already small enough.

**Data flow**: It starts with "example output" and gives the formatter a byte limit larger than the text. The formatter returns the same text. The test compares the returned value with the original content.

**Call relations**: The Rust test runner calls this function. It checks the byte-limit no-op path and relies on the assertion macro to report a failure if the formatter changes the text.

*Call graph*: 1 external calls (assert_eq!).


##### `truncate_tokens_over_limit_returns_truncated`  (lines 53–60)

```
fn truncate_tokens_over_limit_returns_truncated()
```

**Purpose**: This test checks that long text is shortened when it exceeds a token limit. It also verifies that the warning tells the reader how much was removed.

**Data flow**: It supplies a sentence that is longer than the five-token budget. The formatter keeps the beginning and end, inserts a marker saying how many tokens were removed, and adds a warning header. The test compares the whole formatted result with the expected string.

**Call relations**: The test harness runs this function. It exercises the token-based truncation path and uses the assertion macro to make sure both the visible snippet and warning text stay stable.

*Call graph*: 1 external calls (assert_eq!).


##### `truncate_bytes_over_limit_returns_truncated`  (lines 63–70)

```
fn truncate_bytes_over_limit_returns_truncated()
```

**Purpose**: This test checks that long text is shortened when it exceeds a byte limit. It makes sure byte-based truncation reports removed characters in the user-facing marker.

**Data flow**: It sends a long sentence through the formatter with a thirty-byte limit. The formatter keeps readable text from both ends, places a middle marker with the removed character count, and adds a warning. The test checks that exact output.

**Call relations**: The Rust test runner calls this function during the test suite. The function focuses on the byte-based truncation branch and uses the assertion macro to detect any change in behavior or wording.

*Call graph*: 1 external calls (assert_eq!).


##### `truncate_bytes_reports_original_line_count_when_truncated`  (lines 73–81)

```
fn truncate_bytes_reports_original_line_count_when_truncated()
```

**Purpose**: This test makes sure a truncated multi-line output still reports how many lines the original output had. That helps a user understand the size of what was cut away.

**Data flow**: It creates text with two lines and applies a byte limit that forces truncation. The formatter returns a warning that includes the original token count, the original line count, and the shortened text. The test verifies that the line count is reported as two.

**Call relations**: The test harness invokes this function. It exercises formatted byte truncation for multi-line content and uses the assertion macro to confirm the exact warning and snippet.

*Call graph*: 1 external calls (assert_eq!).


##### `truncate_tokens_reports_original_line_count_when_truncated`  (lines 84–92)

```
fn truncate_tokens_reports_original_line_count_when_truncated()
```

**Purpose**: This test confirms that token-based truncation also reports the original number of lines. The reader should not lose that context just because the text was shortened.

**Data flow**: It starts with two-line content and applies a ten-token limit. The formatter shortens the text and adds a warning showing the original token count and total line count. The test checks the exact resulting message.

**Call relations**: The Rust test runner calls this test. It covers the multi-line token-limit path and uses the assertion macro to make sure the line-count reporting stays correct.

*Call graph*: 1 external calls (assert_eq!).


##### `truncate_middle_bytes_handles_utf8_content`  (lines 95–99)

```
fn truncate_middle_bytes_handles_utf8_content()
```

**Purpose**: This test checks that byte-based truncation handles Unicode text, such as emoji, without corrupting it. This matters because some characters take more than one byte, and cutting in the wrong place can produce invalid text.

**Data flow**: It passes a string containing many emoji plus a second line into the lower-level truncation function with a twenty-byte limit. The function returns a shortened string that keeps whole emoji and normal text, with a marker in the middle. The test compares that output with the expected safe result.

**Call relations**: The test harness runs this function. Unlike the formatted warning tests, it calls the lower-level text truncation function directly with a byte policy, then uses the assertion macro to verify Unicode-safe behavior.

*Call graph*: 3 external calls (assert_eq!, truncate_text, Bytes).


##### `truncates_across_multiple_under_limit_texts_and_reports_omitted`  (lines 102–164)

```
fn truncates_across_multiple_under_limit_texts_and_reports_omitted()
```

**Purpose**: This test checks truncation across a list of structured output items, not just one plain string. It makes sure several text pieces share one overall token budget, images are preserved, and omitted text items are summarized.

**Data flow**: It builds repeated text chunks, measures their approximate token cost, and creates a mixed list containing text items and an image item. It then applies a token limit that allows some early text through, forces a later text item to be shortened, and causes later text items to be omitted. The test checks that the first texts and image remain, the shortened text contains a truncation marker, and the final summary mentions the omitted text items.

**Call relations**: The Rust test runner invokes this function. The test calls the token-count helper to size the budget, then calls the function-output item truncator. It uses assertions to verify the shape of the returned list and panics if an item appears in an unexpected form.

*Call graph*: 7 external calls (assert!, assert_eq!, approx_token_count, truncate_function_output_items_with_policy, panic!, Tokens, vec!).


##### `formatted_truncate_text_content_items_with_policy_returns_original_under_limit`  (lines 167–185)

```
fn formatted_truncate_text_content_items_with_policy_returns_original_under_limit()
```

**Purpose**: This test proves that structured text items are returned unchanged when they fit within the byte budget. It also checks that no original token count is reported when no truncation happened.

**Data flow**: It creates three text items, including an empty one, and applies a byte limit large enough for all of them. The formatting function returns the same list and no token-count metadata. The test compares both outputs with the expected unchanged values.

**Call relations**: The test harness calls this function. It exercises the structured-content formatting function in the under-limit case and uses assertion checks to confirm both the content and the optional metadata.

*Call graph*: 4 external calls (assert_eq!, formatted_truncate_text_content_items_with_policy, Bytes, vec!).


##### `formatted_truncate_text_content_items_with_policy_preserves_empty_leading_text_behavior`  (lines 188–208)

```
fn formatted_truncate_text_content_items_with_policy_preserves_empty_leading_text_behavior()
```

**Purpose**: This test checks an edge case where the first text item is empty and the byte budget is zero. It makes sure the real text that follows is still counted and represented in the truncation warning.

**Data flow**: It creates a list with an empty text item followed by "abc" and applies a zero-byte limit. The formatter merges the text for truncation, produces a warning-only text item with a marker showing three characters were removed, and reports the original token count. The test verifies both the returned item list and the token-count metadata.

**Call relations**: The Rust test runner invokes this function. It calls the structured formatted truncation function with a byte policy and uses assertions to protect this subtle empty-leading-text behavior.

*Call graph*: 4 external calls (assert_eq!, formatted_truncate_text_content_items_with_policy, Bytes, vec!).


##### `formatted_truncate_text_content_items_with_policy_merges_text_and_appends_images`  (lines 211–252)

```
fn formatted_truncate_text_content_items_with_policy_merges_text_and_appends_images()
```

**Purpose**: This test checks that text items are combined for truncation while image items are kept afterward. It protects the rule that images should not consume the text budget or disappear when nearby text is shortened.

**Data flow**: It builds a mixed list of text, image, text, text, and image. The formatter combines the text into one truncation candidate, shortens it to the byte budget, creates one warning text item, and then appends the original image items. The test verifies the final list and the reported original token count.

**Call relations**: The test harness calls this function. It exercises the structured formatted truncation function on mixed media content and uses assertions to check that text is merged while images survive unchanged.

*Call graph*: 4 external calls (assert_eq!, formatted_truncate_text_content_items_with_policy, Bytes, vec!).


##### `formatted_truncate_text_content_items_with_policy_preserves_encrypted_content`  (lines 255–280)

```
fn formatted_truncate_text_content_items_with_policy_preserves_encrypted_content()
```

**Purpose**: This test makes sure encrypted content is preserved when nearby text is formatted and truncated. Encrypted content is opaque data, meaning the truncation code should not try to read or alter it.

**Data flow**: It creates one text item and one encrypted-content item, then applies a small byte limit. The formatter truncates the text into a warning item and leaves the encrypted item exactly as it was. The test checks the final list and confirms that the original token count is reported.

**Call relations**: The Rust test runner invokes this function. It calls the structured formatted truncation path and uses assertions to verify that only plain text is modified while encrypted content passes through untouched.

*Call graph*: 4 external calls (assert_eq!, formatted_truncate_text_content_items_with_policy, Bytes, vec!).


##### `truncate_function_output_items_with_policy_preserves_encrypted_content`  (lines 283–306)

```
fn truncate_function_output_items_with_policy_preserves_encrypted_content()
```

**Purpose**: This test checks the non-formatted structured truncation path for encrypted content. It ensures plain text may be shortened, but encrypted opaque data remains unchanged.

**Data flow**: It creates a text item and an encrypted-content item, then applies a small byte limit through the function-output truncator. The text item is shortened with a middle marker, while the encrypted item is copied as-is. The test compares the returned list with the expected result.

**Call relations**: The test harness calls this function. It exercises the lower-level function-output item truncator rather than the warning-formatting wrapper, then uses the assertion macro to confirm encrypted content is preserved.

*Call graph*: 4 external calls (assert_eq!, truncate_function_output_items_with_policy, Bytes, vec!).


##### `formatted_truncate_text_content_items_with_policy_merges_all_text_for_token_budget`  (lines 309–329)

```
fn formatted_truncate_text_content_items_with_policy_merges_all_text_for_token_budget()
```

**Purpose**: This test confirms that multiple text items are treated as one combined text budget when truncating by tokens. That prevents each small piece from incorrectly escaping the overall limit.

**Data flow**: It creates two separate text items and applies a two-token limit. The formatter combines their text, sees that the combined token count is too high, and returns one warning text item with a token-truncation marker. The test checks the output item and the original token count.

**Call relations**: The Rust test runner invokes this function. It calls the structured formatted truncation function with a token policy and uses assertions to verify that the token budget applies to all text together.

*Call graph*: 4 external calls (assert_eq!, formatted_truncate_text_content_items_with_policy, Tokens, vec!).


##### `byte_count_conversion_clamps_non_positive_values`  (lines 332–336)

```
fn byte_count_conversion_clamps_non_positive_values()
```

**Purpose**: This test checks the helper that estimates tokens from a byte count. It makes sure negative and zero byte counts become zero tokens instead of producing a misleading or invalid estimate.

**Data flow**: It calls the byte-to-token estimate helper with -1, 0, and 5 bytes. The expected results are 0, 0, and 2 tokens. The test compares each returned estimate with the expected value.

**Call relations**: The test harness calls this function. It focuses on a small conversion helper used by truncation budgeting and uses assertion checks to guard its edge-case behavior.

*Call graph*: 1 external calls (assert_eq!).


### Path URI semantics tests
This sequence documents the core `PathUri` behavior first and then the higher-level API-facing `LegacyAppPathString` wrapper built on top of it.

### `utils/path-uri/src/tests.rs`

`test` · `test run`

PathUri sits at a tricky border: operating systems store paths in different formats, while tools often need a portable URI string such as file:///workspace/src/lib.rs. This test file makes sure that border does not leak surprises. It checks ordinary absolute paths, Windows drive paths, Unix paths, network share paths, and paths with spaces or percent signs. It also checks what happens when a native path cannot be written as a normal URI, such as a Unix path containing a null byte or a Windows path with special namespace prefixes. In those cases the library uses a special opaque fallback form, like putting an odd-shaped item into a sealed box instead of forcing it into the wrong drawer. The tests also confirm that unsafe or ambiguous input is rejected: relative paths, unsupported URI schemes, query strings, fragments, encoded null bytes, malformed fallback data, and absolute paths passed to join. Finally, it verifies user-facing path operations such as basename, parent, join, JSON serialization, and conversion back to a validated URL. Without these tests, small path-handling mistakes could break cross-platform workspaces, corrupt non-text paths, or silently treat a file name as URI metadata.

#### Function details

##### `file_uri_round_trips_an_absolute_path`  (lines 13–32)

```
fn file_uri_round_trips_an_absolute_path()
```

**Purpose**: Checks the basic promise of PathUri: an absolute native path can become a file URI and then return to the same path. It also verifies that spaces are encoded in the URI string.

**Data flow**: It starts with the current working directory and adds a path containing a space. That absolute path is converted into a PathUri, turned into text, parsed back, and converted back into a native path. The expected result is that the URI text looks like a file URI and the final path is exactly the original path.

**Call relations**: The Rust test runner calls this as a basic end-to-end test. It exercises the main conversion entry point, from_abs_path, then checks that parsing and native-path conversion agree with that original conversion.

*Call graph*: calls 2 internal fn (current_dir, from_abs_path); 2 external calls (assert!, assert_eq!).


##### `non_native_uri_io_conversion_is_invalid_input`  (lines 35–52)

```
fn non_native_uri_io_conversion_is_invalid_input()
```

**Purpose**: Verifies that a URI shaped for another operating system is accepted as a URI but rejected when asked to become a native path. This prevents the library from pretending it can safely use a path format the current host does not understand.

**Data flow**: It builds a file URI that is valid in general but not native to the current platform. It asks PathUri to convert it into an absolute local path. The expected output is an input error whose message names the current operating system.

**Call relations**: The test runner calls this to cover the boundary between portable URI parsing and host-specific path use. It relies on parse to accept the URI first, then checks that to_abs_path refuses the non-native conversion.

*Call graph*: calls 1 internal fn (parse); 1 external calls (assert_eq!).


##### `file_uri_parses_a_windows_path_on_any_host`  (lines 55–65)

```
fn file_uri_parses_a_windows_path_on_any_host()
```

**Purpose**: Confirms that a Windows-style file URI can be parsed even on non-Windows machines. This matters when one system needs to inspect or display paths that came from another system.

**Data flow**: It gives PathUri a file URI with a Windows drive letter and an encoded space. The parsed object keeps the encoded path, reports the decoded file name, and prints back to the same canonical URI string.

**Call relations**: The test runner uses this to prove that parse is not limited to the host operating system. It then checks read-only URI operations such as encoded_path, basename, and string rendering.

*Call graph*: calls 1 internal fn (parse); 1 external calls (assert_eq!).


##### `infers_path_conventions_from_uri_shape`  (lines 68–91)

```
fn infers_path_conventions_from_uri_shape()
```

**Purpose**: Checks that PathUri can guess whether a file URI looks like a Unix-style path or a Windows-style path. This guess helps callers display or reason about foreign paths without carrying extra metadata.

**Data flow**: It feeds several URI shapes into the parser, including root paths, drive letters, network shares, and fallback encoded paths. For each one, it asks for the inferred path convention and compares it with the expected Unix, Windows, or unknown answer.

**Call relations**: The test runner calls this as a broad table-driven check. It depends on parse to build valid PathUri values and then focuses on infer_path_convention, which is used after parsing to interpret the path shape.

*Call graph*: calls 1 internal fn (parse); 1 external calls (assert_eq!).


##### `drive_shaped_posix_uri_is_intentionally_inferred_as_windows`  (lines 94–101)

```
fn drive_shaped_posix_uri_is_intentionally_inferred_as_windows()
```

**Purpose**: Documents an intentional choice: a URI like file:///C:/... is treated as Windows-shaped even though it could technically be a Unix path. This favors the common case of receiving a Windows path from another machine.

**Data flow**: It parses a URI whose path begins with a drive-letter pattern. It then asks PathUri to infer the path convention. The expected result is Windows.

**Call relations**: The test runner calls this to lock in a design decision for infer_path_convention. It sits next to the broader inference test and explains why this ambiguous shape is not treated as Unix.

*Call graph*: calls 1 internal fn (parse); 1 external calls (assert_eq!).


##### `file_uri_falls_back_for_windows_prefixes_without_a_uri_representation`  (lines 105–128)

```
fn file_uri_falls_back_for_windows_prefixes_without_a_uri_representation()
```

**Purpose**: On Windows, checks that special namespace paths that cannot be written as normal file URIs still round-trip safely. The library uses a special fallback URI form instead of losing information.

**Data flow**: It starts with Windows-only native paths such as device or volume namespace paths. Each path is validated as absolute, converted to PathUri, compared with the expected fallback URI text, parsed again, and converted back to the original native path.

**Call relations**: The Windows test runner calls this only on Windows. It exercises from_absolute_path_checked before from_abs_path, then confirms that parse and to_abs_path understand the fallback form.

*Call graph*: calls 2 internal fn (from_absolute_path_checked, from_abs_path); 1 external calls (assert_eq!).


##### `file_uri_fallback_round_trips_non_unicode_windows_paths`  (lines 132–148)

```
fn file_uri_fallback_round_trips_non_unicode_windows_paths()
```

**Purpose**: On Windows, verifies that paths containing invalid Unicode still survive conversion through PathUri. This protects real filesystem paths that cannot be represented as ordinary text.

**Data flow**: It builds a Windows path from raw UTF-16 data containing an invalid surrogate value. That path is checked as absolute, converted to a URI, parsed again, and decoded back into a native path. The expected result is the same original path and a fallback URI prefix.

**Call relations**: The Windows test runner calls this to cover non-text path data. It feeds raw operating-system string data through from_abs_path and parse to make sure the opaque fallback path is used correctly.

*Call graph*: calls 3 internal fn (from_absolute_path_checked, from_abs_path, parse); 4 external calls (from_wide, from, assert!, assert_eq!).


##### `file_uri_falls_back_for_posix_paths_with_null_bytes`  (lines 152–174)

```
fn file_uri_falls_back_for_posix_paths_with_null_bytes()
```

**Purpose**: On Unix, checks that a path containing bytes that cannot be put directly in a normal file URI uses the special fallback form and still round-trips. This is important for preserving exact path bytes.

**Data flow**: It builds a Unix path from raw bytes, including a null byte and a non-UTF-8 byte. The path becomes a PathUri, is compared with the expected fallback URI, serialized to JSON, deserialized, and converted back to the original path.

**Call relations**: The Unix test runner calls this only on Unix. It connects native byte-path construction, from_abs_path, PathUri parsing, JSON serialization, and to_abs_path into one round-trip check.

*Call graph*: calls 2 internal fn (from_absolute_path_checked, from_abs_path); 5 external calls (from, assert_eq!, from_str, to_string, from_vec).


##### `ordinary_bad_path_uri_is_not_decoded_as_a_fallback`  (lines 178–188)

```
fn ordinary_bad_path_uri_is_not_decoded_as_a_fallback()
```

**Purpose**: Makes sure that only the exact special fallback prefix is treated as fallback data. A normal path that merely resembles part of that fallback spelling must remain an ordinary file path.

**Data flow**: It creates an absolute Unix path under /bad/path with text that looks like encoded fallback data. After conversion to PathUri, the URI remains a normal file URI, and converting it back returns the literal same path.

**Call relations**: The Unix test runner calls this to guard against over-eager fallback decoding. It complements the fallback tests by proving that from_abs_path and to_abs_path do not reinterpret ordinary paths accidentally.

*Call graph*: calls 2 internal fn (from_absolute_path_checked, from_abs_path); 1 external calls (assert_eq!).


##### `malformed_bad_path_uris_are_rejected`  (lines 191–208)

```
fn malformed_bad_path_uris_are_rejected()
```

**Purpose**: Checks that malformed fallback URIs are refused during parsing. This prevents ambiguous or corrupt opaque path data from entering the system.

**Data flow**: It tries several bad fallback-looking URI strings, including missing payloads, invalid base64 text, padded forms, extra path segments, and wrong prefixes. Each one is expected to produce an InvalidFileUriPath parse error.

**Call relations**: The test runner calls this to exercise PathUri parsing’s validation rules for the fallback format. It stands between raw URI input and later conversion functions by ensuring only canonical fallback strings are accepted.

*Call graph*: 1 external calls (assert_eq!).


##### `structurally_valid_bad_path_uri_with_invalid_native_payload_fails_conversion`  (lines 211–221)

```
fn structurally_valid_bad_path_uri_with_invalid_native_payload_fails_conversion()
```

**Purpose**: Shows that a fallback URI can be syntactically valid but still fail when its decoded data is not a valid absolute native path. Parsing and native conversion are deliberately separate checks.

**Data flow**: It parses a canonical-looking fallback URI whose payload decodes to unsuitable path data. Parsing succeeds, but converting to an absolute native path returns an invalid input error.

**Call relations**: The test runner calls this after malformed fallback tests to cover the next layer of validation. parse accepts the URI shape, while to_abs_path rejects the decoded native path.

*Call graph*: calls 1 internal fn (parse); 1 external calls (assert_eq!).


##### `bad_path_uris_are_opaque_to_lexical_operations`  (lines 224–237)

```
fn bad_path_uris_are_opaque_to_lexical_operations()
```

**Purpose**: Confirms that fallback URIs are treated like sealed data, not like normal slash-separated paths. Operations such as basename, parent, and joining children should not inspect or reshape their encoded payload.

**Data flow**: It parses a valid fallback URI and asks for its basename, parent, and joins. Empty join returns the same URI, while joining a real child fails because changing the fallback payload as if it were a normal path would be unsafe.

**Call relations**: The test runner calls this to protect lexical path operations from corrupting fallback URIs. It uses parse first, then checks basename, parent, and join behavior on the opaque value.

*Call graph*: calls 1 internal fn (parse); 1 external calls (assert_eq!).


##### `file_uri_parses_a_posix_path_on_any_host`  (lines 240–247)

```
fn file_uri_parses_a_posix_path_on_any_host()
```

**Purpose**: Confirms that a Unix-style file URI can be parsed on any operating system. This keeps PathUri useful for inspecting paths from remote or different-platform environments.

**Data flow**: It parses a Unix file URI, then checks that the encoded path is preserved, the basename is decoded to main.rs, and the URI prints back in canonical form.

**Call relations**: The test runner calls this as the Unix counterpart to the Windows path parsing test. It depends on parse and then verifies simple read-only PathUri accessors.

*Call graph*: calls 1 internal fn (parse); 1 external calls (assert_eq!).


##### `file_uri_preserves_paths_that_resemble_windows_paths`  (lines 250–257)

```
fn file_uri_preserves_paths_that_resemble_windows_paths()
```

**Purpose**: Checks that URI text shaped like a Windows drive path is preserved exactly in the URI path. This prevents normalization from accidentally rewriting or discarding ambiguous path text.

**Data flow**: It parses URIs such as file:///C:/Project and file:///C:, reads their encoded paths, serializes them back to strings, and parses those strings again. The URI remains equal to the original parsed value.

**Call relations**: The test runner calls this to complement path-convention inference. Even if a path shape may be inferred as Windows, parse and to_string must still preserve the URI spelling.

*Call graph*: calls 1 internal fn (parse); 1 external calls (assert_eq!).


##### `file_uri_accepts_non_utf8_posix_paths`  (lines 261–275)

```
fn file_uri_accepts_non_utf8_posix_paths()
```

**Purpose**: On Unix, verifies that a native path containing non-UTF-8 bytes can become a PathUri and return unchanged. Unix file names are bytes, not always valid text, so this protects real-world paths.

**Data flow**: It builds a Unix path from raw bytes with a non-UTF-8 byte, validates it as absolute, converts it to PathUri, converts it back to a native path, and reparses the URI string. Both round-trips preserve the same path and URI.

**Call relations**: The Unix test runner calls this to cover byte-level Unix path handling. It sends raw OS string data through from_abs_path, to_abs_path, and parse.

*Call graph*: calls 2 internal fn (from_absolute_path_checked, from_abs_path); 3 external calls (from, assert_eq!, from_vec).


##### `file_uri_round_trips_literal_percent_characters`  (lines 278–284)

```
fn file_uri_round_trips_literal_percent_characters()
```

**Purpose**: Checks that a literal percent character in a file name stays correctly encoded as %25 in the URI. This prevents percent signs from being mistaken for new escape sequences.

**Data flow**: It parses a URI containing 100%25, then checks the printed URI, encoded path, and decoded basename. The result keeps the encoded percent in URI text while presenting the file name normally.

**Call relations**: The test runner calls this to exercise percent-encoding behavior. It relies on parse and then checks that string rendering and basename decoding agree.

*Call graph*: calls 1 internal fn (parse); 1 external calls (assert_eq!).


##### `file_uri_round_trips_windows_unc_paths`  (lines 288–295)

```
fn file_uri_round_trips_windows_unc_paths()
```

**Purpose**: On Windows, verifies conversion of UNC network paths such as \\server\share\... into file URIs and back. UNC paths identify files on network shares, so their server/share parts must be preserved.

**Data flow**: It starts with an absolute Windows UNC path, converts it to a PathUri, checks the URI path portion, and converts it back to the same native UNC path.

**Call relations**: The Windows test runner calls this to exercise from_abs_path and to_abs_path for network shares. It is related to the authority-retention test, which checks the URI form directly.

*Call graph*: calls 2 internal fn (from_absolute_path_checked, from_abs_path); 1 external calls (assert_eq!).


##### `file_uri_retains_unc_authority`  (lines 298–303)

```
fn file_uri_retains_unc_authority()
```

**Purpose**: Checks that a file URI with a network server name keeps that server name when parsed and printed. In URI terms, the server name is the authority, meaning the host-like part after file://.

**Data flow**: It parses file://server/share/src/main.rs, reads the encoded path, and turns the PathUri back into text. The server authority and path are both preserved.

**Call relations**: The test runner calls this for URI-level UNC behavior, independent of whether the current host can convert it to a native path. It uses parse and string rendering rather than native path conversion.

*Call graph*: calls 1 internal fn (parse); 1 external calls (assert_eq!).


##### `file_uri_spelling_aliases_have_one_canonical_form`  (lines 306–316)

```
fn file_uri_spelling_aliases_have_one_canonical_form()
```

**Purpose**: Verifies that common equivalent spellings of local file URIs all normalize to one standard form. This avoids treating FILE:///x, file:/x, and file://localhost/x as different paths.

**Data flow**: It parses several alias spellings for the same local path. Each parsed URI is converted back to text, and the expected output is always file:///workspace/src.

**Call relations**: The test runner calls this to check canonicalization inside parse. It ensures later comparisons can rely on PathUri’s normalized string form.

*Call graph*: calls 1 internal fn (parse); 1 external calls (assert_eq!).


##### `unsupported_schemes_are_rejected_at_construction`  (lines 319–339)

```
fn unsupported_schemes_are_rejected_at_construction()
```

**Purpose**: Confirms that PathUri only accepts supported path URI schemes, currently file:// for this test set. Remote, artifact, web, and editor-specific schemes are rejected instead of being treated like local files.

**Data flow**: It tries to parse URIs with schemes such as http, ssh, artifact, and untitled. Each parse is expected to fail with an UnsupportedScheme error containing the rejected scheme name.

**Call relations**: The test runner calls this to protect the construction boundary. It exercises parse as the gatekeeper before any PathUri value can be created from outside text.

*Call graph*: calls 1 internal fn (parse); 1 external calls (assert!).


##### `path_uri_serializes_as_a_string`  (lines 342–352)

```
fn path_uri_serializes_as_a_string()
```

**Purpose**: Checks that PathUri is written to JSON as a simple URI string and can be read back. This keeps saved data and API payloads easy to understand and stable.

**Data flow**: It parses a file URI into a PathUri, serializes it with JSON, then deserializes it back. The JSON is expected to be a quoted URI string, and the final PathUri equals the original.

**Call relations**: The test runner calls this to verify serde support, where serde is Rust’s common serialization framework. It uses normal string parsing first, then hands the value through JSON conversion.

*Call graph*: 3 external calls (assert_eq!, from_str, to_string).


##### `path_uri_deserializes_legacy_absolute_paths`  (lines 355–363)

```
fn path_uri_deserializes_legacy_absolute_paths()
```

**Purpose**: Checks backward compatibility with older JSON data that stored native absolute paths instead of file URIs. Existing saved state can still be read and converted into PathUri.

**Data flow**: It creates an absolute path under the current directory and serializes that path as JSON. Then it deserializes the JSON as PathUri. The expected result is the same URI that from_abs_path would create from the absolute path.

**Call relations**: The test runner calls this to cover migration behavior during deserialization. It compares serde’s legacy path input handling with the normal from_abs_path conversion.

*Call graph*: calls 1 internal fn (current_dir); 3 external calls (assert_eq!, from_str, to_string).


##### `path_uri_rejects_relative_native_paths`  (lines 366–370)

```
fn path_uri_rejects_relative_native_paths()
```

**Purpose**: Verifies that PathUri cannot be created directly from a relative native path. Requiring absolute paths avoids confusion about which directory the path depends on.

**Data flow**: It passes src/lib.rs to from_path. The expected output is an invalid input error rather than a PathUri.

**Call relations**: The test runner calls this to check the direct native-path constructor. It protects callers before parsing or serialization are involved.

*Call graph*: calls 1 internal fn (from_path); 1 external calls (assert_eq!).


##### `path_uri_rejects_legacy_relative_paths_with_absolute_path_guard`  (lines 373–380)

```
fn path_uri_rejects_legacy_relative_paths_with_absolute_path_guard()
```

**Purpose**: Checks that legacy JSON path input must still be absolute, even when an absolute-path guard is active. This prevents old-style relative path strings from slipping into PathUri during deserialization.

**Data flow**: It records the current directory as the guarded base, then tries to deserialize the JSON string "src/lib.rs" as a PathUri. Deserialization fails, and the error message mentions that the path is not absolute.

**Call relations**: The test runner calls this to cover the legacy deserialization path with AbsolutePathBufGuard in place. It ensures the guard does not make a relative path acceptable for PathUri.

*Call graph*: calls 2 internal fn (current_dir, new); 1 external calls (assert!).


##### `unsupported_scheme_is_rejected_during_deserialization`  (lines 383–392)

```
fn unsupported_scheme_is_rejected_during_deserialization()
```

**Purpose**: Verifies that JSON deserialization applies the same scheme rules as direct parsing. A saved or received JSON string with an unsupported scheme must not create a PathUri.

**Data flow**: It tries to deserialize a JSON string containing artifact://store/object-1 as PathUri. The expected result is an error message saying the artifact scheme is unsupported.

**Call relations**: The test runner calls this as the serialization-side counterpart to unsupported_schemes_are_rejected_at_construction. It checks that serde input still goes through PathUri validation.

*Call graph*: 1 external calls (assert!).


##### `known_path_uris_reject_queries_and_fragments`  (lines 395–406)

```
fn known_path_uris_reject_queries_and_fragments()
```

**Purpose**: Checks that file URIs with query strings or fragments are rejected. In a path URI, ?version=1 or #L1 would be metadata, not part of the filesystem path, so allowing it would be ambiguous.

**Data flow**: It tries to parse one URI with a query and one with a fragment. Each parse fails with the specific error for that kind of forbidden metadata.

**Call relations**: The test runner calls this to validate parse rules for known path schemes. It keeps path identity separate from URI decorations such as queries and fragments.

*Call graph*: calls 1 internal fn (parse); 1 external calls (assert!).


##### `path_uris_reject_encoded_null_bytes`  (lines 409–411)

```
fn path_uris_reject_encoded_null_bytes()
```

**Purpose**: Confirms that a normal file URI cannot contain an encoded null byte. Null bytes are dangerous path contents for many native APIs, so they must not enter through ordinary URI decoding.

**Data flow**: It tries to parse file:///tmp/%00. The expected result is any parse error rather than a valid PathUri.

**Call relations**: The test runner calls this to cover a security and correctness edge case in parse. The special fallback tests cover opaque null-byte preservation separately; this test ensures normal URI paths reject it.

*Call graph*: 1 external calls (assert!).


##### `encoded_filename_characters_round_trip_without_becoming_uri_metadata`  (lines 414–421)

```
fn encoded_filename_characters_round_trip_without_becoming_uri_metadata()
```

**Purpose**: Checks that encoded question marks, hash signs, and percent signs inside a file name stay part of the file name. They must not turn into URI query, fragment, or escape syntax.

**Data flow**: It parses a URI whose final path segment contains %3F, %23, and %25. The URI string and encoded path remain encoded, while basename returns the decoded file name a?b#c%d.

**Call relations**: The test runner calls this after query and fragment rejection to show the safe way to include those characters: encode them as path text. It exercises parse and basename decoding.

*Call graph*: calls 1 internal fn (parse); 1 external calls (assert_eq!).


##### `double_encoded_separator_remains_filename_text`  (lines 424–431)

```
fn double_encoded_separator_remains_filename_text()
```

**Purpose**: Verifies that a slash encoded twice stays as text in a file name, not as a path separator. This prevents decoding too many times and accidentally changing the directory structure.

**Data flow**: It parses file:///tmp/a%252Fb. The encoded path and printed URI keep %252F, while basename decodes only one layer to a%2Fb.

**Call relations**: The test runner calls this to guard percent-decoding behavior. It checks that parse and basename do not over-decode URI segments.

*Call graph*: calls 1 internal fn (parse); 1 external calls (assert_eq!).


##### `basename_uses_decoded_uri_segments`  (lines 434–449)

```
fn basename_uses_decoded_uri_segments()
```

**Purpose**: Checks how PathUri reports the last path segment, known as the basename. It should decode normal URI escapes and return no name for a bare root.

**Data flow**: It parses several URI shapes: root, normal files, names with spaces, Windows drive roots, and network shares. For each one, basename returns the expected decoded final segment or None.

**Call relations**: The test runner calls this as the focused test for basename. It uses parse to create each URI, then verifies the user-facing filename result.

*Call graph*: calls 1 internal fn (parse); 1 external calls (assert_eq!).


##### `parent_uses_uri_hierarchy_and_preserves_authority`  (lines 452–472)

```
fn parent_uses_uri_hierarchy_and_preserves_authority()
```

**Purpose**: Checks that PathUri can find a URI’s parent directory using URI path hierarchy. It also makes sure network authorities such as file://server are kept when moving upward.

**Data flow**: It parses several file URIs and asks for each parent. The expected result is another parsed PathUri for the parent, or None when already at the root.

**Call relations**: The test runner calls this as the focused test for parent. It uses parse both for the input and for the expected parent values so comparisons stay in PathUri terms.

*Call graph*: calls 1 internal fn (parse); 1 external calls (assert_eq!).


##### `join_normalizes_relative_uri_segments`  (lines 475–500)

```
fn join_normalizes_relative_uri_segments()
```

**Purpose**: Checks that joining a relative path onto a base URI works like normal directory navigation. It also verifies that special filename characters are encoded when joined.

**Data flow**: It parses base URIs, joins relative strings such as ../tests/test.rs or a?b#c%d, and compares the result to an expected PathUri. Dot-dot segments are normalized without escaping above the URI root, and filename metadata characters become encoded path text.

**Call relations**: The test runner calls this as the main positive test for join. It combines parse for the base and expected values with join as the operation under test.

*Call graph*: calls 1 internal fn (parse); 1 external calls (assert_eq!).


##### `join_rejects_absolute_and_null_paths`  (lines 503–516)

```
fn join_rejects_absolute_and_null_paths()
```

**Purpose**: Verifies that join only accepts safe relative path text. Absolute paths and strings containing null bytes are rejected instead of being merged into a base URI.

**Data flow**: It parses a base URI, then tries to join /src and a string containing a null byte. The absolute input produces a JoinPathMustBeRelative error, and the null-containing input produces an invalid file URI path error.

**Call relations**: The test runner calls this as the negative counterpart to join_normalizes_relative_uri_segments. It checks that join validates its input before producing a new PathUri.

*Call graph*: calls 1 internal fn (parse); 2 external calls (assert!, assert_eq!).


##### `to_url_returns_the_validated_url`  (lines 519–526)

```
fn to_url_returns_the_validated_url()
```

**Purpose**: Checks that PathUri can expose its underlying validated URL form. This is useful when other code needs a standard URL object after PathUri has already enforced path-specific rules.

**Data flow**: It parses a file URI using localhost and an encoded space. Then it asks for the URL object and compares it with the canonical file URL without localhost.

**Call relations**: The test runner calls this to verify the handoff from PathUri to the general Url type. It first relies on parse for validation and normalization, then checks to_url returns that normalized URL.

*Call graph*: calls 1 internal fn (parse); 1 external calls (assert_eq!).


### `utils/path-uri/src/api_path_string_tests.rs`

`test` · `test`

This is a test file for the path conversion layer. The project has a newer file URI form, like `file:///workspace/src/lib.rs`, but some APIs still use plain path strings, like `/workspace/src/lib.rs` or `C:\workspace\src\lib.rs`. These tests make sure those two worlds agree where they can, and fail clearly where they cannot.

The file starts by defining small test-case helpers. Each case says: here is a URI, here is the path style we want to render it as, and here is what should happen. Some cases should round-trip, meaning URI → plain path → URI gives the same value back. Some cases only render in a lossy way, meaning information is lost, like a bad byte being shown as the replacement character `�`. Some cases should be rejected because the URI shape does not match the requested path convention.

The large shared case table is the heart of the file. It covers POSIX paths, Windows drive paths, Windows network-share paths, encoded characters, opaque fallback paths, and invalid combinations. The rest of the tests check surrounding behavior: relative paths can be stored as API strings but cannot become file URIs, the code can guess whether a string looks like Windows or POSIX, and JSON serialization treats these API paths as plain strings. Without these tests, small changes could silently break cross-platform path handling.

#### Function details

##### `RenderCase::round_trips`  (lines 14–24)

```
fn round_trips(
        uri: &'static str,
        convention: PathConvention,
        rendered: &'static str,
    ) -> Self
```

**Purpose**: Builds a test case where a URI is expected to render into a native-looking path string and then convert back to the same URI. It is a compact way to write many successful conversion examples.

**Data flow**: It takes a URI text, a path convention, and the expected rendered path text. It wraps the expected text in a round-trip expectation and returns a complete `RenderCase` containing all three pieces.

**Call relations**: The shared test table uses this helper for cases that should survive both directions of conversion. Later, `renders_native_paths_from_shared_cases` reads these cases and checks both rendering and parsing back.

*Call graph*: 1 external calls (RoundTrip).


##### `RenderCase::rejects`  (lines 26–32)

```
fn rejects(uri: &'static str, convention: PathConvention, error: ExpectedError) -> Self
```

**Purpose**: Builds a test case where conversion is expected to fail. This is used when a URI cannot honestly be shown as the requested kind of path, or when an opaque fallback is invalid.

**Data flow**: It takes a URI text, a path convention, and the kind of expected error. It stores those values in a `RenderCase` whose expectation says an error should occur.

**Call relations**: The shared test table uses this helper for deliberately incompatible or invalid examples. `renders_native_paths_from_shared_cases` later turns the stored error kind into the exact error value the conversion code should return.

*Call graph*: 1 external calls (Error).


##### `RenderCase::renders_lossily`  (lines 34–44)

```
fn renders_lossily(
        uri: &'static str,
        convention: PathConvention,
        rendered: &'static str,
    ) -> Self
```

**Purpose**: Builds a test case where a URI can be displayed as a path string, but the displayed text cannot faithfully recreate the original URI. This is important for cases like invalid UTF-8 bytes or escaped path separators.

**Data flow**: It takes a URI text, a path convention, and the expected displayed path text. It returns a `RenderCase` marked as render-only, meaning the test should check the display result but not demand a perfect parse back.

**Call relations**: The shared test table uses this helper for conversions that are acceptable for display but not safe for round-tripping. `renders_native_paths_from_shared_cases` treats these differently from full round-trip cases.

*Call graph*: 1 external calls (RenderOnly).


##### `renders_native_paths_from_shared_cases`  (lines 300–346)

```
fn renders_native_paths_from_shared_cases()
```

**Purpose**: Runs the main set of URI-to-path conversion tests. It checks successful rendering, expected failures, convention inference, and full round-tripping where the case says that should be possible.

**Data flow**: For each shared case, it parses the URI into a `PathUri`, builds the expected result, and asks `LegacyAppPathString::from_path_uri` to render it using the requested convention. If rendering succeeds, it checks that the rendered string looks like the same convention. For round-trip cases, it also deserializes the plain path from JSON, converts it back to a URI, and confirms the original URI is recovered.

**Call relations**: This is the main consumer of the `RenderCase` table and its helper constructors. It drives the real conversion functions, compares their output with the expected answer, and uses JSON conversion to mimic how API path strings appear at the system boundary.

*Call graph*: calls 2 internal fn (parse, from_path_uri); 2 external calls (assert_eq!, json!).


##### `relative_api_path_serializes_and_deserializes_unchanged`  (lines 349–359)

```
fn relative_api_path_serializes_and_deserializes_unchanged()
```

**Purpose**: Checks that relative API path strings, such as `subdir/file.rs`, can still pass through JSON unchanged. They are allowed as plain API text even though they are not absolute file locations.

**Data flow**: It starts with several raw relative path strings. Each string is deserialized into a `LegacyAppPathString`, then serialized back to JSON, and the result is compared with the original text.

**Call relations**: This test focuses on JSON behavior rather than URI conversion. It complements the later tests that show these same kinds of relative strings are not valid inputs when building a `PathUri`.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `relative_api_path_is_invalid_when_converted_to_a_path_uri`  (lines 362–375)

```
fn relative_api_path_is_invalid_when_converted_to_a_path_uri()
```

**Purpose**: Proves that a relative API path string is not enough to create a file URI. A file URI needs an absolute path, meaning a complete location from the filesystem root or drive root.

**Data flow**: It deserializes the raw string `subdir` into a `LegacyAppPathString`. It confirms no absolute path convention can be inferred, then tries to convert it as a POSIX path and expects an invalid-native-path error.

**Call relations**: This test follows up on the serialization test: relative strings may be stored and transmitted, but conversion to `PathUri` rejects them when an absolute filesystem location is required.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `other_non_absolute_api_paths_cannot_be_converted_to_path_uris`  (lines 378–395)

```
fn other_non_absolute_api_paths_cannot_be_converted_to_path_uris()
```

**Purpose**: Checks Windows-looking strings that are still not absolute paths. Examples include a path with backslashes but no drive root, and `C:file.rs`, which is drive-relative rather than fully absolute.

**Data flow**: For each raw path and convention, it deserializes the string into `LegacyAppPathString`. It verifies the string does not reveal an absolute convention, then tries converting it to a URI and expects an invalid-native-path error.

**Call relations**: This test broadens the relative-path rule to Windows-style edge cases. It helps ensure the conversion code does not mistake familiar-looking syntax for a complete absolute path.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `infers_absolute_path_conventions_from_api_text`  (lines 398–424)

```
fn infers_absolute_path_conventions_from_api_text()
```

**Purpose**: Checks the code’s ability to guess whether an API path string is an absolute Windows path, an absolute POSIX path, or neither. This guess is useful before choosing how to parse or display a path.

**Data flow**: It deserializes each sample string into `LegacyAppPathString`, calls the convention-inference method, and compares the result with the expected answer. Inputs include Windows drive paths, Windows network paths, POSIX root paths, and non-absolute strings.

**Call relations**: This test exercises the convention-detection part of `LegacyAppPathString`. The main rendering tests also rely on convention inference after successful rendering, but this test isolates that behavior with many direct examples.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `foreign_absolute_syntax_deserializes_without_host_interpretation`  (lines 427–438)

```
fn foreign_absolute_syntax_deserializes_without_host_interpretation()
```

**Purpose**: Checks that deserializing an API path string does not reinterpret it based on the computer running the test. A Windows-looking path should remain Windows-looking even on POSIX, and a POSIX-looking path should remain POSIX-looking even on Windows.

**Data flow**: It deserializes each raw absolute path string, then checks that the stored text is exactly the same and that the inferred convention matches the syntax of the string.

**Call relations**: This test protects API behavior from host operating system assumptions. It confirms that `LegacyAppPathString` treats incoming text as data from the API, not as a local filesystem path to be normalized immediately.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `renders_an_absolute_path_using_the_host_convention`  (lines 441–453)

```
fn renders_an_absolute_path_using_the_host_convention()
```

**Purpose**: Checks conversion from the project’s checked absolute path type into a legacy API path string using the current machine’s native path style. On Unix-like systems it expects a slash-rooted path; on Windows it expects a drive-rooted path.

**Data flow**: It chooses a known absolute native path for the current platform, wraps it in `AbsolutePathBuf` after checking that it is absolute, then converts it into `LegacyAppPathString`. The output should be the same path text.

**Call relations**: This test covers the path from a real host-native absolute path into the API string type. It uses the absolute-path checker first, then verifies the `LegacyAppPathString` conversion result.

*Call graph*: calls 1 internal fn (from_absolute_path_checked); 1 external calls (assert_eq!).


##### `renders_native_non_unicode_windows_fallback_lossily`  (lines 457–486)

```
fn renders_native_non_unicode_windows_fallback_lossily()
```

**Purpose**: On Windows only, checks what happens when a native path contains text that is not valid Unicode. The code should still produce a readable API path string, replacing the bad character with `�`, and should reject that fallback when asked to render it as POSIX.

**Data flow**: It builds a Windows path from raw UTF-16 units, including an invalid surrogate value. That path is checked as absolute, converted to a legacy string, and converted to a `PathUri`. Rendering the URI as Windows should produce the same lossy text, while rendering it as POSIX should return an opaque-fallback error.

**Call relations**: This is a platform-specific edge-case test for Windows native paths. It connects native Windows path construction, absolute-path validation, URI conversion, and legacy string rendering to make sure non-Unicode paths fail safely and predictably across conventions.

*Call graph*: calls 2 internal fn (from_absolute_path_checked, from_abs_path); 3 external calls (assert_eq!, from_wide, from).


##### `serializes_and_deserializes_as_a_string`  (lines 489–501)

```
fn serializes_and_deserializes_as_a_string()
```

**Purpose**: Checks that a rendered legacy API path appears in JSON as a simple string, not as a structured object. This matters because external API clients expect ordinary path text.

**Data flow**: It parses a file URI, renders it as a POSIX legacy path string, serializes that value to JSON, and checks the JSON text. It then deserializes the JSON string back and verifies it matches the original rendered value.

**Call relations**: This test ties URI rendering to the API serialization boundary. It shows that once a `LegacyAppPathString` has been created, JSON input and output preserve it as plain text.

*Call graph*: calls 2 internal fn (parse, from_path_uri); 2 external calls (assert_eq!, to_string).
