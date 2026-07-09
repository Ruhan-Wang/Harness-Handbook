# Streaming, line framing, and hidden-markup parsers  `stage-22.2.2`

This stage provides the incremental parsing layer that sits between raw streamed model output and higher-level rendering or feature logic. It is cross-cutting infrastructure used during the main streaming path: it turns arbitrary byte or text chunks into stable text fragments, framed records, and extracted metadata without requiring the full response up front.

At its core, stream_text.rs defines the shared parser contract and output shape for parsers that emit visible text while collecting side-channel payloads, and lib.rs exposes those building blocks as the crate’s public API. utf8_stream.rs adapts any text parser to raw byte streams, preserving correctness when UTF-8 characters are split across chunk boundaries. line_buffer.rs performs newline framing for partial byte records.

On top of those primitives, inline_hidden_tag.rs extracts inline hidden markup while suppressing it from rendered text, and tagged_line_parser.rs recognizes whole-line opening and closing markers for block-style tagged sections even when lines arrive incrementally. table_detect.rs supplies consistent markdown table and code-fence detection rules to streaming consumers. mention_codec.rs translates visible mentions to and from structured link form, and citations.rs specializes the hidden-tag machinery to recover structured memory citation and thread ID data.

## Files in this stage

### Parser foundations
These files define the shared parser contract and crate-level exports that the streaming parser utilities build on.

### `utils/stream-parser/src/stream_text.rs`

`data_model` · `cross-cutting`

This file is the minimal abstraction layer for streamed text parsing. Its central data type, `StreamTextChunk<T>`, packages two parallel outputs from one parser step: `visible_text`, which is safe to surface to users immediately, and `extracted`, a `Vec<T>` of structured payloads pulled out of the stream while parsing. The struct derives `Debug`, `Clone`, `PartialEq`, and `Eq`, making it easy to compare parser outputs in tests and compose them across parser stages.

The `Default` implementation intentionally produces an empty chunk with an empty `String` and empty `Vec`, which downstream code uses as the neutral element when a parser step yields nothing yet—especially important for buffering parsers that must wait for more input before deciding what to emit. The `is_empty` helper codifies that notion of “no output” by requiring both channels to be empty.

The `StreamTextParser` trait defines the incremental parser lifecycle: `push_str` accepts one incoming text fragment and returns the chunk produced from just that push, while `finish` flushes any buffered parser state at end-of-stream or end-of-item. The trait leaves extraction semantics to implementations via the associated type `Extracted`, allowing the same interface to support citation extraction, tag parsing, or other hidden markup removal without coupling this file to any specific domain.

#### Function details

##### `StreamTextChunk::default`  (lines 11–16)

```
fn default() -> Self
```

**Purpose**: Constructs an empty parser result with no visible text and no extracted payloads. It serves as the neutral starting value and the standard “nothing emitted yet” result for buffering parsers.

**Data flow**: It takes no arguments and reads no external state. It creates a fresh `StreamTextChunk<T>` whose `visible_text` is `String::new()` and whose `extracted` is `Vec::new()`, then returns that value without side effects.

**Call relations**: This is used by higher-level parser code whenever a push or flush produces no output yet, such as UTF-8 buffering and chunk aggregation paths. Callers rely on it to represent deferred emission without inventing special sentinel values.

*Call graph*: called by 9 (collect_chunks, finish, push_str, collect_chunks, map_segments, collect_chunks, finish, push_bytes, collect_bytes); 2 external calls (new, new).


##### `StreamTextChunk::is_empty`  (lines 21–23)

```
fn is_empty(&self) -> bool
```

**Purpose**: Checks whether a parser result produced absolutely nothing on either output channel. It is the canonical emptiness test for incremental parser steps.

**Data flow**: It reads `self.visible_text` and `self.extracted`, evaluates whether both are empty, and returns a `bool`. It does not mutate the chunk or any external state.

**Call relations**: This helper is typically used by tests and parser consumers to distinguish a real emission from a buffering-only step. It does not delegate further and acts as a leaf predicate over `StreamTextChunk` state.


### `utils/stream-parser/src/lib.rs`

`orchestration` · `startup`

This crate root is a pure module-and-export file: it declares the internal parser modules that implement incremental text parsing behaviors, then selectively re-exports their public types and helpers as the crate’s stable interface. The module list shows the crate is organized around several specialized streaming parsers: assistant text parsing, citation extraction and stripping, inline hidden tag parsing, proposed-plan block parsing, generic stream text chunking, tagged-line parsing support, and UTF-8 boundary-safe byte stream decoding. The `pub use` section is the important contract here. Consumers of the crate do not need to know the internal module layout; they import `AssistantTextStreamParser`, `CitationStreamParser`, `InlineHiddenTagParser`, `ProposedPlanParser`, `StreamTextParser`, or `Utf8StreamParser` directly from the crate root, along with associated chunk/segment types and utility functions such as `strip_citations`, `extract_proposed_plan_text`, and `strip_proposed_plan_blocks`. Notably, `tagged_line_parser` is declared but not re-exported, implying it is an internal implementation detail used by other modules rather than part of the external API. This file therefore centralizes visibility decisions and keeps downstream code insulated from refactors inside the crate.


### Streaming input adapters
These utilities adapt raw streamed input into parseable units by handling UTF-8 chunk boundaries and incremental line framing.

### `utils/stream-parser/src/utf8_stream.rs`

`io_transport` · `request handling`

This file adapts text-oriented incremental parsers to byte-oriented upstream sources. `Utf8StreamParserError` distinguishes two failure modes: a definitively invalid UTF-8 sequence with `valid_up_to` and `error_len`, and an incomplete code point still buffered at EOF. Its `Display` implementation formats these cases into precise diagnostics.

`Utf8StreamParser<P>` stores the wrapped parser in `inner` and a `pending_utf8: Vec<u8>` buffer for undecoded bytes. `push_bytes` appends the incoming chunk to `pending_utf8` and then attempts `std::str::from_utf8` over the whole buffer. If decoding succeeds, the full decoded text is forwarded to `inner.push_str`, and the byte buffer is cleared. If decoding fails with a concrete `error_len`, the method rolls back the entire just-pushed chunk by truncating `pending_utf8` back to its old length and returns `InvalidUtf8`; this rollback is deliberate so the inner parser never sees a valid prefix from a chunk that ultimately failed. If decoding fails only because the buffer ends mid-code-point, the method emits any valid prefix before the incomplete suffix: when `valid_up_to == 0` it returns an empty `StreamTextChunk`, otherwise it decodes the valid prefix, forwards it, and drains those bytes from `pending_utf8`.

`finish` first validates that any remaining buffered bytes are either valid UTF-8 or reports `InvalidUtf8` / `IncompleteUtf8AtEof`. If buffered bytes decode cleanly, it pushes them into the inner parser before calling `inner.finish`, then concatenates the two `StreamTextChunk`s by appending visible text and extracted payloads. `into_inner` returns the wrapped parser only when no undecoded invalid/incomplete bytes remain, while `into_inner_lossy` skips validation and drops any buffered partial code point. The tests focus on split multibyte characters, rollback after invalid chunks, EOF behavior, and the difference between strict and lossy extraction of the inner parser.

#### Function details

##### `Utf8StreamParserError::fmt`  (lines 22–35)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Formats UTF-8 streaming errors into human-readable messages that include byte offsets and error lengths where applicable. It gives callers precise diagnostics for malformed byte streams.

**Data flow**: It reads the enum variant and its fields from `self`, writes the corresponding message into the provided formatter `f`, and returns the resulting `fmt::Result`.

**Call relations**: This implementation is used implicitly whenever the error is displayed or propagated through standard error-reporting paths. It is a leaf formatter and does not affect parser state.

*Call graph*: 1 external calls (write!).


##### `Utf8StreamParser::new`  (lines 54–59)

```
fn new(inner: P) -> Self
```

**Purpose**: Constructs a byte-oriented wrapper around an existing text parser. The wrapper starts with no buffered undecoded bytes.

**Data flow**: It takes an `inner` parser of type `P`, stores it, initializes `pending_utf8` to an empty `Vec<u8>`, and returns the new `Utf8StreamParser<P>`.

**Call relations**: Tests and production setup call this before any byte chunks are processed. It prepares the state later consumed by `Utf8StreamParser::push_bytes`, `Utf8StreamParser::finish`, and the `into_inner` methods.

*Call graph*: called by 6 (utf8_stream_parser_errors_on_incomplete_code_point_at_eof, utf8_stream_parser_handles_split_code_points_across_chunks, utf8_stream_parser_into_inner_errors_when_partial_code_point_is_buffered, utf8_stream_parser_into_inner_lossy_drops_buffered_partial_code_point, utf8_stream_parser_rolls_back_entire_chunk_when_invalid_byte_follows_valid_prefix, utf8_stream_parser_rolls_back_on_invalid_utf8_chunk); 1 external calls (new).


##### `Utf8StreamParser::push_bytes`  (lines 66–109)

```
fn push_bytes(
        &mut self,
        chunk: &[u8],
    ) -> Result<StreamTextChunk<P::Extracted>, Utf8StreamParserError>
```

**Purpose**: Accepts one raw byte chunk, decodes as much UTF-8 as is safely available, and forwards decoded text to the wrapped `StreamTextParser`. It preserves parser consistency by rolling back the entire chunk on definite UTF-8 errors.

**Data flow**: It takes `&[u8]`, records the old buffered length, appends the bytes to `self.pending_utf8`, and attempts `from_utf8` on the whole buffer. On full success it sends the decoded `&str` to `self.inner.push_str`, clears `pending_utf8`, and returns that `StreamTextChunk`. On invalid UTF-8 with `error_len`, it truncates `pending_utf8` back to `old_len` and returns `Utf8StreamParserError::InvalidUtf8`. On incomplete trailing UTF-8, it either returns `StreamTextChunk::default()` if no complete code point exists yet, or decodes the valid prefix, forwards it to `inner.push_str`, drains those bytes from `pending_utf8`, and returns the resulting chunk.

**Call relations**: This is the main byte-ingest entry and is used by higher-level collection code such as the test helper `tests::collect_bytes`. It delegates decoded text handling to the wrapped parser’s `push_str`, while owning all UTF-8 boundary detection and rollback behavior itself.

*Call graph*: calls 1 internal fn (default); called by 1 (collect_bytes); 2 external calls (push_str, from_utf8).


##### `Utf8StreamParser::finish`  (lines 111–149)

```
fn finish(&mut self) -> Result<StreamTextChunk<P::Extracted>, Utf8StreamParserError>
```

**Purpose**: Flushes any remaining buffered UTF-8 bytes and then flushes the wrapped text parser. It enforces that EOF cannot silently discard an incomplete code point.

**Data flow**: It reads `self.pending_utf8`; if non-empty, it validates the bytes with `from_utf8`, returning `InvalidUtf8` or `IncompleteUtf8AtEof` on failure. If buffered bytes are valid, it either starts from `StreamTextChunk::default()` when none remain or forwards the decoded text to `self.inner.push_str` and clears the buffer. It then calls `self.inner.finish()`, appends the tail chunk’s `visible_text` and `extracted` into the first chunk, and returns the combined result.

**Call relations**: This is called at end-of-stream by consumers such as `tests::collect_bytes`. It bridges the byte-level buffering layer with the wrapped parser’s own flush semantics, ensuring both pending UTF-8 and parser-internal state are emitted in order.

*Call graph*: calls 1 internal fn (default); called by 1 (collect_bytes); 3 external calls (finish, push_str, from_utf8).


##### `Utf8StreamParser::into_inner`  (lines 154–170)

```
fn into_inner(self) -> Result<P, Utf8StreamParserError>
```

**Purpose**: Returns the wrapped parser only if the wrapper is not holding undecoded invalid or incomplete UTF-8 bytes. It is the strict extraction path for callers that want ownership back without losing buffered state silently.

**Data flow**: It consumes `self`, checks whether `pending_utf8` is empty, and if so returns `Ok(self.inner)`. Otherwise it validates the buffered bytes with `from_utf8`; valid buffered bytes still permit returning `inner`, while invalid bytes produce `InvalidUtf8` and incomplete trailing bytes produce `IncompleteUtf8AtEof`.

**Call relations**: This method is used when callers want to unwrap the adapter safely after streaming. Unlike `finish`, it does not flush buffered valid text into the inner parser; unlike `into_inner_lossy`, it refuses to ignore malformed or partial buffered bytes.

*Call graph*: 1 external calls (from_utf8).


##### `Utf8StreamParser::into_inner_lossy`  (lines 175–177)

```
fn into_inner_lossy(self) -> P
```

**Purpose**: Returns the wrapped parser without validating or flushing any buffered undecoded bytes. It is an explicit escape hatch for callers willing to drop partial UTF-8 state.

**Data flow**: It consumes `self` and returns `self.inner`, ignoring `pending_utf8` entirely and performing no decoding, validation, or mutation beyond ownership transfer.

**Call relations**: This is the permissive counterpart to `Utf8StreamParser::into_inner`. Tests use it to confirm that buffered partial code points can be discarded intentionally when strict correctness is not required.


##### `tests::collect_bytes`  (lines 190–204)

```
fn collect_bytes(
        parser: &mut Utf8StreamParser<CitationStreamParser>,
        chunks: &[&[u8]],
    ) -> Result<StreamTextChunk<String>, Utf8StreamParserError>
```

**Purpose**: Aggregates the outputs of multiple `push_bytes` calls plus a final `finish` into one combined `StreamTextChunk`. It is a convenience helper for end-to-end UTF-8 streaming tests.

**Data flow**: It takes a mutable `Utf8StreamParser<CitationStreamParser>` and a slice of byte-slice chunks, starts from `StreamTextChunk::default()`, loops over chunks calling `parser.push_bytes(chunk)?`, concatenates each returned chunk’s `visible_text` and `extracted` into the accumulator, then does the same with `parser.finish()?` and returns the accumulated result.

**Call relations**: This helper is invoked by the split-code-point test to exercise the normal streaming lifecycle. It delegates all actual decoding and parsing to `Utf8StreamParser::push_bytes` and `Utf8StreamParser::finish`.

*Call graph*: calls 3 internal fn (default, finish, push_bytes).


##### `tests::utf8_stream_parser_handles_split_code_points_across_chunks`  (lines 207–222)

```
fn utf8_stream_parser_handles_split_code_points_across_chunks()
```

**Purpose**: Verifies that multibyte UTF-8 characters split across chunk boundaries are buffered and reconstructed correctly before reaching the inner parser. It also checks that extracted citation content survives this byte-level adaptation.

**Data flow**: The test defines three byte chunks containing split `é` and `中` sequences around citation tags, constructs a `Utf8StreamParser` around `CitationStreamParser`, runs `tests::collect_bytes`, and asserts that the final visible text is `"AéZ"` and the extracted payload list contains `"中"`.

**Call relations**: It drives the happy-path integration of `Utf8StreamParser::new`, `tests::collect_bytes`, `Utf8StreamParser::push_bytes`, and `Utf8StreamParser::finish`.

*Call graph*: calls 2 internal fn (new, new); 3 external calls (assert_eq!, panic!, collect_bytes).


##### `tests::utf8_stream_parser_rolls_back_on_invalid_utf8_chunk`  (lines 225–258)

```
fn utf8_stream_parser_rolls_back_on_invalid_utf8_chunk()
```

**Purpose**: Checks that when a continuation byte is invalid, the wrapper rejects the chunk and restores the previous buffered state so a later valid continuation can still succeed. This confirms the chunk-level rollback guarantee.

**Data flow**: The test pushes a leading byte `0xC3` and asserts the returned chunk is empty, then pushes invalid `0x28` and asserts it gets `InvalidUtf8 { valid_up_to: 0, error_len: 1 }`. It then pushes a valid continuation plus `x`, finishes the parser, and asserts the recovered visible output is `"éx"` with no extracted payloads and an empty tail.

**Call relations**: It exercises `Utf8StreamParser::push_bytes` on both incomplete and invalid paths, then confirms recovery through another `push_bytes` and `finish` call after rollback.

*Call graph*: calls 2 internal fn (new, new); 3 external calls (assert!, assert_eq!, panic!).


##### `tests::utf8_stream_parser_rolls_back_entire_chunk_when_invalid_byte_follows_valid_prefix`  (lines 261–283)

```
fn utf8_stream_parser_rolls_back_entire_chunk_when_invalid_byte_follows_valid_prefix()
```

**Purpose**: Verifies that a chunk containing a valid UTF-8 prefix followed by an invalid byte is rejected as a whole, rather than partially forwarded to the inner parser. This protects downstream parsers from seeing text from a failed chunk.

**Data flow**: The test pushes `b"ok\xFF"`, expects `InvalidUtf8 { valid_up_to: 2, error_len: 1 }`, then pushes `b"!"` and asserts the next visible output is only `"!"`, proving the earlier `"ok"` prefix was not emitted.

**Call relations**: It specifically targets the rollback branch in `Utf8StreamParser::push_bytes` where `from_utf8` reports a concrete invalid sequence after some valid bytes.

*Call graph*: calls 2 internal fn (new, new); 3 external calls (assert!, assert_eq!, panic!).


##### `tests::utf8_stream_parser_errors_on_incomplete_code_point_at_eof`  (lines 286–300)

```
fn utf8_stream_parser_errors_on_incomplete_code_point_at_eof()
```

**Purpose**: Confirms that EOF with a buffered partial UTF-8 sequence is treated as an error rather than silently dropped or emitted. This enforces strict end-of-stream correctness.

**Data flow**: The test pushes two bytes of a three-byte sequence, asserts the immediate output is empty, then calls `finish` and checks that it returns `Utf8StreamParserError::IncompleteUtf8AtEof`.

**Call relations**: It exercises the incomplete-buffer validation path in `Utf8StreamParser::finish` after a prior `Utf8StreamParser::push_bytes` buffered an unfinished code point.

*Call graph*: calls 2 internal fn (new, new); 3 external calls (assert!, assert_eq!, panic!).


##### `tests::utf8_stream_parser_into_inner_errors_when_partial_code_point_is_buffered`  (lines 303–317)

```
fn utf8_stream_parser_into_inner_errors_when_partial_code_point_is_buffered()
```

**Purpose**: Checks that strict unwrapping of the inner parser fails when the wrapper still holds an incomplete UTF-8 sequence. It distinguishes `into_inner` from the lossy variant.

**Data flow**: The test pushes a single leading byte, asserts the returned chunk is empty, then calls `into_inner` and asserts it returns `Utf8StreamParserError::IncompleteUtf8AtEof`.

**Call relations**: It directly exercises the validation logic in `Utf8StreamParser::into_inner` after state was established by `Utf8StreamParser::push_bytes`.

*Call graph*: calls 2 internal fn (new, new); 3 external calls (assert!, assert_eq!, panic!).


##### `tests::utf8_stream_parser_into_inner_lossy_drops_buffered_partial_code_point`  (lines 320–332)

```
fn utf8_stream_parser_into_inner_lossy_drops_buffered_partial_code_point()
```

**Purpose**: Verifies that lossy unwrapping discards buffered partial UTF-8 bytes and returns the inner parser without error. It documents the intentional trade-off of the lossy API.

**Data flow**: The test pushes a single leading byte, asserts the output is empty, calls `into_inner_lossy` to recover the wrapped parser, then calls `inner.finish()` and asserts that the tail chunk is empty.

**Call relations**: It contrasts with the strict `into_inner` test by exercising `Utf8StreamParser::into_inner_lossy` after the same buffered-partial setup from `Utf8StreamParser::push_bytes`.

*Call graph*: calls 2 internal fn (new, new); 2 external calls (assert!, panic!).


### `ollama/src/line_buffer.rs`

`util` · `cross-cutting stream parsing`

This file contains the internal `LineBuffer` type used when parsing Ollama's NDJSON pull stream and other line-oriented process output. The buffer stores accumulated bytes in a `bytes::BytesMut` and tracks `scanned_len`, the prefix length already searched and confirmed to contain no `\n`. That extra cursor is the key design choice: when more bytes arrive after a partial line, `take_line` searches only the newly appended suffix instead of rescanning the entire buffer each time.

`extend_from_slice` simply appends incoming bytes to the existing `BytesMut`. `take_line` then uses `memchr` over `self.bytes[self.scanned_len..]` to find the next newline efficiently. If no newline exists, it updates `scanned_len` to the current buffer length and returns `None`, preserving all bytes for future appends. If a newline is found, it computes the absolute index, splits the buffer through that newline with `split_to`, resets `scanned_len` to zero because the remaining tail has not been searched yet, and returns the extracted line including the trailing newline. The type is crate-private and derives `Default`; in tests it also derives `Debug`, `PartialEq`, and `Eq` so internal state can be asserted directly.

#### Function details

##### `LineBuffer::extend_from_slice`  (lines 13–15)

```
fn extend_from_slice(&mut self, bytes: &[u8])
```

**Purpose**: Appends newly received bytes onto the end of the buffered stream data. It does not alter the scan cursor because previously scanned bytes remain valid.

**Data flow**: Takes `&mut self` and `bytes: &[u8]`, extends `self.bytes` with the provided slice, and returns `()`. The only state mutation is growth of the internal `BytesMut`.

**Call relations**: It is called by stream-ingestion code such as `push_process_output` and `push_stderr` before line extraction is attempted. It deliberately does not perform parsing itself so callers can append many chunks and then repeatedly call `take_line`.

*Call graph*: called by 2 (push_process_output, push_stderr); 1 external calls (extend_from_slice).


##### `LineBuffer::take_line`  (lines 17–27)

```
fn take_line(&mut self) -> Option<BytesMut>
```

**Purpose**: Extracts the next complete newline-terminated line from the buffer if one is available. It preserves partial trailing data for future appends and avoids rescanning old bytes.

**Data flow**: Reads `self.scanned_len` and searches `self.bytes[self.scanned_len..]` with `memchr(b'\n', ...)`. If no newline is found, it sets `self.scanned_len = self.bytes.len()` and returns `None`. If a newline is found, it computes the absolute index, removes and returns the prefix up to and including that newline via `self.bytes.split_to(newline_index + 1)`, resets `self.scanned_len` to `0`, and leaves any remaining bytes in the buffer.

**Call relations**: It is used by consumers such as `push_stderr` and `take_stdout_message` after bytes have been appended. Those callers rely on its invariant that returned lines include the newline and that incomplete tails remain buffered.

*Call graph*: called by 2 (push_stderr, take_stdout_message); 3 external calls (len, split_to, memchr).


### Generic markup parsers
These reusable parsers incrementally recognize hidden inline tags and line-delimited tagged blocks from streamed text.

### `utils/stream-parser/src/inline_hidden_tag.rs`

`domain_logic` · `cross-cutting streaming text parsing primitive used during chunk ingestion and EOF flush`

This file implements a generic, stateful parser for inline tags whose delimiters are matched literally rather than by a full grammar. `InlineTagSpec<T>` defines each supported tag type with a typed `tag` marker plus static `open` and `close` delimiters. `ExtractedInlineTag<T>` is the output record containing the tag identity and captured body. Internally, the parser tracks `specs`, a `pending` string buffer holding undecided input, and an optional `active` tag with its close delimiter and accumulated content.

`new` validates that at least one tag spec exists and that no opener or closer is empty. Parsing happens in `push_str`, which appends the incoming chunk to `pending` and then loops until no more progress can be made. If a tag is active, it searches `pending` for the active close delimiter. On success it finalizes the extracted tag, drains the consumed bytes, and continues. If no close delimiter is found, it computes the longest suffix of `pending` that could be the prefix of the close delimiter, appends the safe prefix into the active tag’s content, drains it, and waits for more input.

If no tag is active, the parser searches for the earliest opener across all specs using `find_next_open`, breaking ties by preferring the longer opener at the same offset and then lower spec index. Text before the opener is emitted as visible output, the opener is drained, and a new `ActiveTag` begins. If no opener is found, `max_open_prefix_suffix_len` preserves any trailing bytes that might be the start of an opener while `drain_visible_to_suffix_match` emits the rest as visible text. `finish` auto-closes an active tag by emitting its buffered content as extracted data, or flushes remaining pending text as visible output when no tag is active. `longest_suffix_prefix_len` is the UTF-8-safe helper that makes chunk-boundary matching work even with non-ASCII delimiters.

#### Function details

##### `InlineHiddenTagParser::new`  (lines 50–70)

```
fn new(specs: Vec<InlineTagSpec<T>>) -> Self
```

**Purpose**: Constructs a generic hidden-tag parser and validates that its tag specifications are usable.

**Data flow**: Consumes `specs: Vec<InlineTagSpec<T>>`, asserts that the vector is non-empty and that every `open` and `close` delimiter is non-empty, initializes `pending` to an empty `String` and `active` to `None`, and returns the parser.

**Call relations**: This constructor is called by specialized wrappers such as `CitationStreamParser::new` and directly by tests that exercise generic behavior.

*Call graph*: called by 6 (new, generic_inline_parser_prefers_longest_opener_at_same_offset, generic_inline_parser_rejects_empty_close_delimiter, generic_inline_parser_rejects_empty_open_delimiter, generic_inline_parser_supports_multiple_tag_types, generic_inline_parser_supports_non_ascii_tag_delimiters); 2 external calls (new, assert!).


##### `InlineHiddenTagParser::find_next_open`  (lines 72–88)

```
fn find_next_open(&self) -> Option<(usize, usize)>
```

**Purpose**: Finds the next opener occurrence in the pending buffer, choosing the earliest match and preferring longer openers when multiple specs match at the same position.

**Data flow**: Reads `self.specs` and `self.pending`, searches each spec’s `open` delimiter with `find`, collects `(position, open_len, spec_index)` candidates, selects the minimum by position then descending opener length then ascending spec index, and returns `Option<(open_position, spec_index)>`.

**Call relations**: It is used only inside `InlineHiddenTagParser::push_str` when no tag is currently active and the parser needs to decide whether to start extracting a hidden tag.

*Call graph*: called by 1 (push_str).


##### `InlineHiddenTagParser::max_open_prefix_suffix_len`  (lines 90–96)

```
fn max_open_prefix_suffix_len(&self) -> usize
```

**Purpose**: Computes how many trailing bytes of the pending buffer must be retained because they could be the prefix of some opener delimiter.

**Data flow**: Reads `self.specs` and `self.pending`, calls `longest_suffix_prefix_len(&self.pending, spec.open)` for each spec, takes the maximum match length, and returns that length or `0` if none match.

**Call relations**: This helper is called from `InlineHiddenTagParser::push_str` when no opener is currently found, so the parser can emit only the definitely visible prefix and keep a possible partial opener buffered.

*Call graph*: called by 1 (push_str).


##### `InlineHiddenTagParser::push_visible_prefix`  (lines 98–102)

```
fn push_visible_prefix(out: &mut StreamTextChunk<ExtractedInlineTag<T>>, pending: &str)
```

**Purpose**: Appends a non-empty visible text slice into the output chunk.

**Data flow**: Takes a mutable `StreamTextChunk<ExtractedInlineTag<T>>` and a `pending: &str` slice, checks whether the slice is non-empty, and if so pushes it onto `out.visible_text`.

**Call relations**: This small helper is used by parsing routines to centralize the “append only if non-empty” behavior when emitting visible text.


##### `InlineHiddenTagParser::drain_visible_to_suffix_match`  (lines 104–115)

```
fn drain_visible_to_suffix_match(
        &mut self,
        out: &mut StreamTextChunk<ExtractedInlineTag<T>>,
        keep_suffix_len: usize,
    )
```

**Purpose**: Moves the definitely visible prefix of `pending` into output while preserving a trailing suffix that might complete an opener in a later chunk.

**Data flow**: Takes mutable `self`, mutable output chunk, and `keep_suffix_len: usize`; computes how many bytes can be emitted as `take = pending.len() - keep_suffix_len` with saturation, emits `self.pending[..take]` via `push_visible_prefix` if `take > 0`, then drains those bytes from `self.pending`.

**Call relations**: This helper is called from `InlineHiddenTagParser::push_str` in the no-active-tag, no-opener-found path.

*Call graph*: called by 1 (push_str); 1 external calls (push_visible_prefix).


##### `InlineHiddenTagParser::push_str`  (lines 124–174)

```
fn push_str(&mut self, chunk: &str) -> StreamTextChunk<Self::Extracted>
```

**Purpose**: Consumes one input chunk and incrementally emits visible text plus any fully parsed hidden-tag contents, buffering ambiguous suffixes across chunk boundaries.

**Data flow**: Appends `chunk` to `self.pending`, initializes an empty `StreamTextChunk`, and loops. If `self.active` exists, it searches `pending` for the active close delimiter; on success it takes the active tag, appends preceding bytes to its content, pushes an `ExtractedInlineTag` into output, drains through the close delimiter, and continues. If no close is found, it computes a suffix/prefix overlap with `longest_suffix_prefix_len`, appends the safe prefix into the active content, drains it, and breaks. If no tag is active, it calls `find_next_open`; on success it emits visible text before the opener, drains the opener, creates a new `ActiveTag`, and continues. If no opener is found, it computes `keep` with `max_open_prefix_suffix_len`, calls `drain_visible_to_suffix_match`, and breaks. It returns the accumulated output chunk.

**Call relations**: This is the core streaming algorithm used by specialized wrappers such as `CitationStreamParser::push_str`. It delegates to `find_next_open`, `max_open_prefix_suffix_len`, `drain_visible_to_suffix_match`, `push_visible_prefix`, and `longest_suffix_prefix_len` to keep the main loop readable.

*Call graph*: calls 5 internal fn (drain_visible_to_suffix_match, find_next_open, max_open_prefix_suffix_len, longest_suffix_prefix_len, default); called by 1 (push_str); 2 external calls (push_visible_prefix, new).


##### `InlineHiddenTagParser::finish`  (lines 176–197)

```
fn finish(&mut self) -> StreamTextChunk<Self::Extracted>
```

**Purpose**: Flushes the parser at EOF, auto-closing any active tag or emitting any remaining pending text as visible output.

**Data flow**: Creates an empty output chunk. If `self.active.take()` yields an active tag, it appends any remaining `self.pending` into that tag’s content, clears `pending`, pushes one `ExtractedInlineTag` into output, and returns immediately. Otherwise, if `pending` is non-empty, it appends it to `out.visible_text`, clears `pending`, and returns the output.

**Call relations**: This method is the end-of-stream counterpart to `push_str`, used by specialized wrappers’ `finish` implementations and by tests.

*Call graph*: calls 1 internal fn (default); called by 1 (finish).


##### `longest_suffix_prefix_len`  (lines 200–208)

```
fn longest_suffix_prefix_len(s: &str, needle: &str) -> usize
```

**Purpose**: Finds the longest suffix of one string that is also a prefix of another, respecting UTF-8 character boundaries in the prefix string.

**Data flow**: Accepts `s: &str` and `needle: &str`, computes the maximum candidate length as the smaller of `s.len()` and `needle.len() - 1`, iterates candidate lengths from largest to smallest, checks `needle.is_char_boundary(k)` and `s.ends_with(&needle[..k])`, and returns the first matching `k` or `0` if none match.

**Call relations**: This helper underpins chunk-boundary buffering in `InlineHiddenTagParser::push_str` and `max_open_prefix_suffix_len`, especially for non-ASCII delimiters.

*Call graph*: called by 1 (push_str).


##### `tests::collect_chunks`  (lines 224–238)

```
fn collect_chunks(parser: &mut P, chunks: &[&str]) -> StreamTextChunk<P::Extracted>
```

**Purpose**: Combines chunk-by-chunk parser output and final flush output into one aggregate result for test assertions.

**Data flow**: Takes a mutable generic parser and chunk slice, initializes a default `StreamTextChunk`, repeatedly appends each `push_str` result’s visible text and extracted items, then appends the `finish` result and returns the aggregate.

**Call relations**: This helper is shared by the generic parser tests to validate whole-stream behavior while still exercising incremental parsing.

*Call graph*: calls 1 internal fn (default); 2 external calls (finish, push_str).


##### `tests::generic_inline_parser_supports_multiple_tag_types`  (lines 241–263)

```
fn generic_inline_parser_supports_multiple_tag_types()
```

**Purpose**: Verifies that one parser instance can recognize multiple configured tag types and preserve their identities in extracted output.

**Data flow**: Constructs an `InlineHiddenTagParser` with `<a>` and `<b>` specs, feeds a mixed-tag input through `collect_chunks`, and asserts on visible text, extraction count, tag identities, and extracted contents.

**Call relations**: This test exercises the multi-spec path through `find_next_open` and the typed extraction behavior.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, collect_chunks, vec!).


##### `tests::generic_inline_parser_supports_non_ascii_tag_delimiters`  (lines 266–279)

```
fn generic_inline_parser_supports_non_ascii_tag_delimiters()
```

**Purpose**: Checks that delimiter matching works correctly for non-ASCII tag strings split across chunk boundaries.

**Data flow**: Builds a parser with `<é>` / `</é>` delimiters, feeds chunked input containing those delimiters and non-ASCII content through `collect_chunks`, and asserts on visible text and extracted content.

**Call relations**: This test specifically validates the UTF-8-safe overlap logic implemented by `longest_suffix_prefix_len`.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, collect_chunks, vec!).


##### `tests::generic_inline_parser_prefers_longest_opener_at_same_offset`  (lines 282–302)

```
fn generic_inline_parser_prefers_longest_opener_at_same_offset()
```

**Purpose**: Documents and verifies the tie-breaking rule that longer openers win when multiple tag specs match at the same byte position.

**Data flow**: Creates a parser with `<a>` and `<ab>` specs, parses input containing `<ab>`, and asserts that the extracted tag is the `Tag::B` variant with content `y` and that visible text excludes the whole `<ab>...</ab>` block.

**Call relations**: This test targets the ordering logic inside `find_next_open`.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, collect_chunks, vec!).


##### `tests::generic_inline_parser_rejects_empty_open_delimiter`  (lines 306–312)

```
fn generic_inline_parser_rejects_empty_open_delimiter()
```

**Purpose**: Ensures parser construction panics when a tag spec has an empty opener, preventing ambiguous or degenerate parsing behavior.

**Data flow**: Attempts to construct an `InlineHiddenTagParser` with `open: ""` and relies on the `#[should_panic]` expectation rather than returning a value.

**Call relations**: This test covers one of the constructor invariants enforced by `InlineHiddenTagParser::new`.

*Call graph*: calls 1 internal fn (new); 1 external calls (vec!).


##### `tests::generic_inline_parser_rejects_empty_close_delimiter`  (lines 316–322)

```
fn generic_inline_parser_rejects_empty_close_delimiter()
```

**Purpose**: Ensures parser construction panics when a tag spec has an empty closer, preventing malformed extraction rules.

**Data flow**: Attempts to construct an `InlineHiddenTagParser` with `close: ""` and expects a panic.

**Call relations**: This test covers the other delimiter invariant enforced by `InlineHiddenTagParser::new`.

*Call graph*: calls 1 internal fn (new); 1 external calls (vec!).


### `utils/stream-parser/src/tagged_line_parser.rs`

`domain_logic` · `request handling`

This file provides the core mechanics for recognizing line-based tag blocks in a stream without prematurely emitting text that might still turn out to be a tag delimiter. `TagSpec<T>` defines each supported tag pair as static `open` and `close` strings plus an associated tag value. Parsing output is expressed as `TaggedLineSegment<T>`, which distinguishes ordinary text (`Normal`) from tag lifecycle events (`TagStart`, `TagDelta`, `TagEnd`).

`TaggedLineParser<T>` maintains four pieces of state: the configured tag specs, the currently active tag if inside a block, a `detect_tag` flag controlling whether the parser is still evaluating the current line as a possible standalone tag line, and `line_buffer`, which accumulates the undecided line prefix. The main `parse` loop processes input character by character. While `detect_tag` is true, characters are buffered into `line_buffer`; the parser keeps waiting if the trimmed line is empty or still a prefix of any configured open/close delimiter. As soon as the buffered content can no longer become a tag line, it flips into plain-text mode and emits the buffered text. Newlines trigger `finish_line`, which decides whether the completed line is an opening tag, closing tag, or ordinary text.

`finish` handles end-of-stream by resolving any unterminated buffered line using the same matching rules and forcibly emitting a `TagEnd` if a tag remained active. Segment emission is normalized through `push_segment`, which drops empty text fragments and coalesces adjacent `Normal` or same-tag `TagDelta` segments. A subtle invariant is that tag delimiters only match after trimming leading and trailing whitespace from the line, but any extra non-whitespace text on the line disqualifies it and causes the whole line to be emitted as normal content.

#### Function details

##### `TaggedLineParser::new`  (lines 37–44)

```
fn new(specs: Vec<TagSpec<T>>) -> Self
```

**Purpose**: Builds a fresh line parser with a specific set of tag delimiter specifications. The parser starts outside any tag block and in tag-detection mode at the beginning of a line.

**Data flow**: It takes a `Vec<TagSpec<T>>` and stores it in `specs`, initializes `active_tag` to `None`, `detect_tag` to `true`, and `line_buffer` to an empty `String`, then returns the parser instance.

**Call relations**: Construction happens in higher-level parser setup and in tests that exercise line parsing behavior. It does not perform parsing itself; it prepares the state consumed later by `TaggedLineParser::parse` and `TaggedLineParser::finish`.

*Call graph*: called by 2 (new, parser); 1 external calls (new).


##### `TaggedLineParser::parse`  (lines 46–82)

```
fn parse(&mut self, delta: &str) -> Vec<TaggedLineSegment<T>>
```

**Purpose**: Consumes one streamed text fragment and emits a sequence of normal-text and tag-related segments based on the parser’s current line and tag state. It incrementally buffers ambiguous line prefixes until they can be classified.

**Data flow**: It reads and mutates `self.detect_tag`, `self.line_buffer`, and `self.active_tag` while iterating over `delta.chars()`. Characters are either appended to `line_buffer` during tag detection or accumulated in a temporary `run` string for plain text; completed lines are resolved via `finish_line`, and text fragments are emitted via `push_text`. It returns a `Vec<TaggedLineSegment<T>>` containing the segments produced from this input chunk.

**Call relations**: This is the main streaming entry used by outer parsers’ `push_str` implementations. During parsing it delegates line-final decisions to `TaggedLineParser::finish_line`, asks `TaggedLineParser::is_tag_prefix` whether a buffered slug could still become a delimiter, and routes actual text emission through `TaggedLineParser::push_text` so segment coalescing stays centralized.

*Call graph*: calls 3 internal fn (finish_line, is_tag_prefix, push_text); called by 1 (push_str); 3 external calls (new, new, take).


##### `TaggedLineParser::finish`  (lines 84–110)

```
fn finish(&mut self) -> Vec<TaggedLineSegment<T>>
```

**Purpose**: Flushes any buffered partial line and closes any still-open tag block at end-of-stream. It ensures the parser leaves no undecided line content or active tag state behind.

**Data flow**: It reads `self.line_buffer`, `self.active_tag`, and the configured specs. If buffered line content exists, it trims it for delimiter matching via `match_open` and `match_close`; on a match it emits `TagStart` or `TagEnd`, otherwise it emits the buffered text through `push_text`. If a tag remains active afterward, it emits a final `TagEnd`, resets `detect_tag` to `true`, clears `active_tag` via `take`, and returns the accumulated segment vector.

**Call relations**: This is called by outer parser `finish` paths when no more input will arrive. It mirrors the line-resolution logic used by `TaggedLineParser::finish_line`, but also performs the final cleanup step of auto-closing an active tag block so downstream consumers receive a balanced segment stream.

*Call graph*: calls 4 internal fn (match_close, match_open, push_text, push_segment); called by 1 (finish); 4 external calls (new, take, TagEnd, TagStart).


##### `TaggedLineParser::finish_line`  (lines 112–137)

```
fn finish_line(&mut self, segments: &mut Vec<TaggedLineSegment<T>>)
```

**Purpose**: Classifies one completed buffered line as an opening tag line, a closing tag line, or ordinary text. It is the newline-triggered decision point for line-based tag recognition.

**Data flow**: It takes mutable access to the parser and a mutable output segment vector. It drains `self.line_buffer`, trims the line for matching, checks `match_open` when no tag is active and `match_close` when the matching tag is active, updates `self.active_tag` and `self.detect_tag` accordingly, and otherwise forwards the original line text to `push_text`.

**Call relations**: This helper is invoked from `TaggedLineParser::parse` whenever a newline completes the current line under tag-detection mode. It delegates actual segment insertion to `push_segment` directly for tag boundary events and to `TaggedLineParser::push_text` for non-delimiter lines.

*Call graph*: calls 4 internal fn (match_close, match_open, push_text, push_segment); called by 1 (parse); 3 external calls (take, TagEnd, TagStart).


##### `TaggedLineParser::push_text`  (lines 139–145)

```
fn push_text(&self, text: String, segments: &mut Vec<TaggedLineSegment<T>>)
```

**Purpose**: Emits a text fragment in the correct segment form depending on whether the parser is currently inside a tag block. It abstracts the choice between visible normal text and tag-body delta text.

**Data flow**: It takes an owned `String` plus the mutable segment list, reads `self.active_tag`, wraps the text as either `TaggedLineSegment::Normal` or `TaggedLineSegment::TagDelta(tag, text)`, and passes that segment to `push_segment` for empty-fragment suppression and coalescing.

**Call relations**: This is the common text-emission path used by `TaggedLineParser::parse`, `TaggedLineParser::finish_line`, and `TaggedLineParser::finish`. By funneling all text through `push_segment`, it keeps adjacent text merging behavior consistent across streaming and flush paths.

*Call graph*: calls 1 internal fn (push_segment); called by 3 (finish, finish_line, parse); 2 external calls (Normal, TagDelta).


##### `TaggedLineParser::is_tag_prefix`  (lines 147–152)

```
fn is_tag_prefix(&self, slug: &str) -> bool
```

**Purpose**: Determines whether the current trimmed line prefix could still become any configured opening or closing delimiter. It lets the parser delay emission while a tag line is still plausible.

**Data flow**: It takes a candidate `slug`, trims trailing whitespace, scans `self.specs`, and returns `true` if any `spec.open` or `spec.close` starts with that slug; otherwise it returns `false`.

**Call relations**: This predicate is consulted only from `TaggedLineParser::parse` while the parser is buffering a possible tag line. A false result is the signal that the buffered content can no longer be a standalone delimiter and should be emitted as ordinary text.

*Call graph*: called by 1 (parse).


##### `TaggedLineParser::match_open`  (lines 154–159)

```
fn match_open(&self, slug: &str) -> Option<T>
```

**Purpose**: Looks up whether a fully formed trimmed line exactly matches any configured opening delimiter. It converts delimiter text into the parser’s tag identifier type.

**Data flow**: It takes a `slug`, iterates over `self.specs`, finds the first spec whose `open` equals the slug, and returns `Some(spec.tag)` or `None` if no opening delimiter matches.

**Call relations**: This exact-match helper is used by both `TaggedLineParser::finish_line` and `TaggedLineParser::finish` when deciding whether buffered line content should start a tag block. It isolates delimiter lookup from the surrounding state checks on `active_tag`.

*Call graph*: called by 2 (finish, finish_line).


##### `TaggedLineParser::match_close`  (lines 161–166)

```
fn match_close(&self, slug: &str) -> Option<T>
```

**Purpose**: Looks up whether a fully formed trimmed line exactly matches any configured closing delimiter. It maps closing delimiter text back to the associated tag identifier.

**Data flow**: It takes a `slug`, scans `self.specs` for a spec whose `close` equals the slug, and returns the corresponding `tag` in `Some(...)` or `None` if unmatched.

**Call relations**: This is paired with `TaggedLineParser::match_open` and is called from `TaggedLineParser::finish_line` and `TaggedLineParser::finish`. The surrounding control flow only treats a close match as valid when it matches the currently active tag.

*Call graph*: called by 2 (finish, finish_line).


##### `push_segment`  (lines 169–199)

```
fn push_segment(segments: &mut Vec<TaggedLineSegment<T>>, segment: TaggedLineSegment<T>)
```

**Purpose**: Appends a parsed segment to the output vector while normalizing away empty text fragments and merging adjacent compatible text segments. It keeps the emitted segment stream compact and stable.

**Data flow**: It takes a mutable `Vec<TaggedLineSegment<T>>` and one segment. For `Normal` and `TagDelta`, it drops empty strings, merges into the last segment when the variant matches and, for `TagDelta`, the tag value is equal; otherwise it pushes a new segment. `TagStart` and `TagEnd` are always appended as standalone events.

**Call relations**: All segment-producing paths funnel through this helper either directly or via `TaggedLineParser::push_text`. That makes it the single place enforcing the invariant that adjacent text chunks are coalesced instead of emitted as many tiny fragments.

*Call graph*: called by 3 (finish, finish_line, push_text); 4 external calls (Normal, TagDelta, TagEnd, TagStart).


##### `tests::parser`  (lines 213–219)

```
fn parser() -> TaggedLineParser<Tag>
```

**Purpose**: Creates a test parser configured with a single `<tag>` / `</tag>` block specification. It centralizes fixture setup for the tagged-line parser tests.

**Data flow**: It constructs a `Vec<TagSpec<Tag>>` with one `TagSpec` whose `tag` is `Tag::Block`, passes it to `TaggedLineParser::new`, and returns the resulting parser.

**Call relations**: This helper is called by the test cases so they all exercise the same parser configuration. It delegates all real initialization to `TaggedLineParser::new`.

*Call graph*: calls 1 internal fn (new); 1 external calls (vec!).


##### `tests::buffers_prefix_until_tag_is_decided`  (lines 222–236)

```
fn buffers_prefix_until_tag_is_decided()
```

**Purpose**: Verifies that an incomplete delimiter prefix is buffered across chunks until the parser can conclusively recognize it as a tag line. It checks the intended incremental behavior for split tag markers.

**Data flow**: The test creates a parser, feeds `"<t"` and then `"ag>\nline\n</tag>\n"`, extends one segment vector with the outputs from both parses plus `finish`, and compares the final segment list against the expected `TagStart`, `TagDelta`, and `TagEnd` sequence.

**Call relations**: It drives the public parsing lifecycle through the test fixture from `tests::parser`, exercising `TaggedLineParser::parse` and `TaggedLineParser::finish` together under a chunk-boundary condition.

*Call graph*: 2 external calls (assert_eq!, parser).


##### `tests::rejects_tag_lines_with_extra_text`  (lines 239–248)

```
fn rejects_tag_lines_with_extra_text()
```

**Purpose**: Checks that a would-be tag delimiter line is rejected when additional text appears on the same line. This confirms the parser’s strict “tag must appear alone on a line” rule.

**Data flow**: The test feeds `"<tag> extra\n"` into a fresh parser, appends the `finish` output, and asserts that the result is a single `TaggedLineSegment::Normal` containing the original line verbatim.

**Call relations**: It uses the shared `tests::parser` fixture and validates the negative path in `TaggedLineParser::finish_line` / `TaggedLineParser::finish`, where exact trimmed delimiter matching fails and the buffered line is emitted as ordinary text.

*Call graph*: 2 external calls (assert_eq!, parser).


### Markdown structure helpers
These helpers detect markdown-specific structures and encode or decode mention markup used by higher-level text processing.

### `tui/src/table_detect.rs`

`domain_logic` · `stream parsing and markdown analysis`

This module contains two tightly related pieces of parsing logic over raw markdown source. The first is single-line pipe-table structure detection: `parse_table_segments` trims a line, strips optional outer pipes, splits on unescaped `|`, trims each segment, and rejects plain text without actual separators unless outer pipes were present. `is_table_header_line` then accepts any parsed segment list containing at least one non-empty cell, while `is_table_delimiter_line` requires every segment to match markdown alignment syntax such as `---`, `:---`, `---:`, or `:---:` with at least three dashes. These functions are intentionally structural rather than rendering-aware; escaped pipes remain in segment text because callers only need to know whether a line can participate in a table.

The second piece is incremental fenced-code tracking via `FenceTracker`. It stores optional open-fence state as `(marker_char, marker_len, FenceKind)` and updates that state one raw line at a time. `advance` ignores lines indented more than three spaces, strips blockquote prefixes before scanning, recognizes backtick and tilde fences of length three or more, and only closes a fence when marker character and minimum length match and no trailing content follows the closing marker. Fence info strings `md` and `markdown` are classified as `FenceKind::Markdown`; all others become `Other`. Callers query `kind()` before advancing each line so they know whether current pipe characters should count as markdown table syntax. Extensive tests cover escaped pipes, delimiter validity, fence matching, indentation, blockquotes, and close-marker edge cases.

#### Function details

##### `parse_table_segments`  (lines 38–54)

```
fn parse_table_segments(line: &str) -> Option<Vec<&str>>
```

**Purpose**: Parses one candidate markdown line into trimmed pipe-separated segments suitable for table-structure checks. It rejects empty lines and plain text without any real separator marker.

**Data flow**: It takes `line: &str`, trims it, returns `None` if empty, records whether the trimmed line starts or ends with `|`, strips one leading and one trailing outer pipe if present, splits the remaining content with `split_unescaped_pipe`, rejects the result when there were no outer pipes and only one segment, trims each segment, and returns `Some(Vec<&str>)` when at least one segment remains.

**Call relations**: Header, delimiter, and holdback candidate detection all depend on this parser. It delegates only the low-level separator scan to `split_unescaped_pipe`, keeping policy decisions about outer pipes and emptiness here.

*Call graph*: calls 1 internal fn (split_unescaped_pipe); called by 3 (table_candidate_text, is_table_delimiter_line, is_table_header_line).


##### `split_unescaped_pipe`  (lines 61–80)

```
fn split_unescaped_pipe(content: &str) -> Vec<&str>
```

**Purpose**: Splits a string on `|` characters that are not escaped by a preceding backslash. It preserves escaped pipes inside the returned segment slices.

**Data flow**: It takes `content: &str`, scans its bytes left to right, skips over escaped characters after `\`, pushes slices between unescaped `|` positions into a preallocated `Vec<&str>`, appends the trailing slice after the loop, and returns the vector of borrowed segments.

**Call relations**: Only `parse_table_segments` calls this helper. It exists as the structural hot-path primitive for table parsing.

*Call graph*: called by 1 (parse_table_segments); 1 external calls (with_capacity).


##### `is_table_header_line`  (lines 88–90)

```
fn is_table_header_line(line: &str) -> bool
```

**Purpose**: Determines whether a line has table-header shape: pipe-separated segments with at least one non-empty cell. It does not validate any following delimiter row.

**Data flow**: It takes `line: &str`, runs `parse_table_segments(line)`, and returns `true` only when parsing succeeds and at least one segment is not empty.

**Call relations**: Whole-buffer table holdback tests use this directly, and incremental holdback logic reaches the same predicate through shared helpers. It is the positive structural check for a potential header row.

*Call graph*: calls 1 internal fn (parse_table_segments); called by 1 (table_holdback_state).


##### `is_table_delimiter_segment`  (lines 95–103)

```
fn is_table_delimiter_segment(segment: &str) -> bool
```

**Purpose**: Checks whether one segment matches markdown table alignment syntax. Valid forms are dash runs of length at least three with optional leading and/or trailing colons.

**Data flow**: It trims the input segment, rejects empties, strips at most one leading colon and one trailing colon, then returns whether the remaining text has length at least three and consists entirely of `-` characters.

**Call relations**: This is the per-cell predicate used by `is_table_delimiter_line`. It is intentionally private because callers care about whole-line delimiter validity.


##### `is_table_delimiter_line`  (lines 108–111)

```
fn is_table_delimiter_line(line: &str) -> bool
```

**Purpose**: Determines whether every parsed segment in a line is a valid markdown table delimiter segment. It is the structural confirmation step paired with a preceding header line.

**Data flow**: It takes `line: &str`, parses segments with `parse_table_segments`, and returns `true` only when parsing succeeds and every segment satisfies `is_table_delimiter_segment`.

**Call relations**: Whole-buffer holdback scanning uses this to confirm a table after a header. It complements `is_table_header_line` as the second half of the two-line table confirmation rule.

*Call graph*: calls 1 internal fn (parse_table_segments); called by 1 (table_holdback_state).


##### `FenceTracker::new`  (lines 149–151)

```
fn new() -> Self
```

**Purpose**: Constructs a fence tracker in the outside-of-fence state. No open fence marker or kind is remembered initially.

**Data flow**: It returns `FenceTracker { state: None }` with no side effects.

**Call relations**: Streaming scanners, test helpers, and fence tests create trackers through this constructor before feeding lines incrementally.

*Call graph*: called by 12 (new, parse_lines_with_fence_state, fence_tracker_blockquote_prefix_stripped, fence_tracker_close_with_trailing_content_does_not_close, fence_tracker_indented_4_spaces_ignored, fence_tracker_markdown_case_insensitive, fence_tracker_markdown_fence, fence_tracker_mismatched_char_does_not_close, fence_tracker_nested_shorter_marker_does_not_close, fence_tracker_opens_and_closes_backtick_fence (+2 more)).


##### `FenceTracker::advance`  (lines 157–188)

```
fn advance(&mut self, raw_line: &str)
```

**Purpose**: Consumes one raw source line and updates fenced-code-block state according to markdown fence rules. It handles indentation limits, blockquote prefixes, opening fences, and matching close fences.

**Data flow**: It takes `&mut self` and `raw_line: &str`, counts leading spaces and returns early if there are more than three, slices off those spaces, strips blockquote prefixes with `strip_blockquote_prefix`, parses a potential fence marker with `parse_fence_marker`, and then either closes the current fence when marker character/length match and trailing content is empty, or opens a new fence with kind `Markdown` or `Other` based on `is_markdown_fence_info`. If no valid fence marker is present, state is unchanged.

**Call relations**: Incremental table holdback scanning calls this after classifying each line so the next line sees the updated fence context. It is the canonical fence-state machine shared across markdown-related code.

*Call graph*: calls 3 internal fn (is_markdown_fence_info, parse_fence_marker, strip_blockquote_prefix); called by 1 (push_line).


##### `FenceTracker::kind`  (lines 192–194)

```
fn kind(&self) -> FenceKind
```

**Purpose**: Returns the current fence context that applies before the next line mutates tracker state. Outside of any fence, it reports `FenceKind::Outside`.

**Data flow**: It reads `self.state` and returns the stored `FenceKind` or `FenceKind::Outside` when no fence is open.

**Call relations**: Callers query this before processing a line structurally, especially the table holdback scanner and test helpers. It exposes fence context without exposing marker internals.

*Call graph*: called by 1 (push_line).


##### `parse_fence_marker`  (lines 203–213)

```
fn parse_fence_marker(line: &str) -> Option<(char, usize)>
```

**Purpose**: Recognizes the opening run of a backtick or tilde fence and returns its marker character and run length. Runs shorter than three are rejected.

**Data flow**: It inspects the first byte of `line`, returns `None` unless it is `` ` `` or `~`, counts the contiguous run length of that byte, rejects lengths under three, and otherwise returns `Some((marker_char, len))`.

**Call relations**: Only `FenceTracker::advance` calls this helper. It isolates the syntax for identifying candidate fence lines.

*Call graph*: called by 1 (advance).


##### `is_markdown_fence_info`  (lines 219–225)

```
fn is_markdown_fence_info(trimmed_line: &str, marker_len: usize) -> bool
```

**Purpose**: Determines whether the info string following a fence marker denotes markdown content. It recognizes `md` and `markdown` case-insensitively.

**Data flow**: It slices `trimmed_line` after `marker_len`, takes the first whitespace-delimited token, and returns whether that token equals `md` or `markdown` ignoring ASCII case.

**Call relations**: Fence opening logic uses this to classify new fences as `FenceKind::Markdown` versus `FenceKind::Other`.

*Call graph*: called by 1 (advance).


##### `strip_blockquote_prefix`  (lines 232–240)

```
fn strip_blockquote_prefix(line: &str) -> &str
```

**Purpose**: Removes all leading markdown blockquote markers from a line, including optional spaces after each `>`. This lets downstream parsers treat quoted tables and fences as their underlying content.

**Data flow**: It trims leading whitespace, repeatedly strips a leading `>` and one optional following space, trims leading whitespace again, and returns the remaining subslice once no more blockquote marker is present.

**Call relations**: Both fence tracking and table candidate detection rely on this helper so quoted markdown is interpreted structurally rather than rejected.

*Call graph*: called by 2 (table_candidate_text, advance).


##### `tests::parse_table_segments_basic`  (lines 247–252)

```
fn parse_table_segments_basic()
```

**Purpose**: Checks that a standard fully-piped table row is split into trimmed cell segments. It validates the normal parsing path.

**Data flow**: The test calls `parse_table_segments("| A | B | C |")` and asserts that the result is `Some(vec!["A", "B", "C"])`.

**Call relations**: This test anchors the expected baseline behavior of `parse_table_segments`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::parse_table_segments_no_outer_pipes`  (lines 255–257)

```
fn parse_table_segments_no_outer_pipes()
```

**Purpose**: Verifies that rows without leading or trailing outer pipes still parse when they contain internal separators. This matches common markdown table syntax.

**Data flow**: It calls `parse_table_segments("A | B | C")` and asserts the expected three trimmed segments.

**Call relations**: This test covers the branch where internal separators alone are sufficient to treat a line as table-like.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::parse_table_segments_no_leading_pipe`  (lines 260–265)

```
fn parse_table_segments_no_leading_pipe()
```

**Purpose**: Verifies parsing when only a trailing outer pipe is present. It ensures asymmetric outer-pipe forms are accepted.

**Data flow**: It calls `parse_table_segments("A | B | C |")` and asserts the expected segments.

**Call relations**: This test protects permissive handling of markdown rows missing a leading outer pipe.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::parse_table_segments_no_trailing_pipe`  (lines 268–273)

```
fn parse_table_segments_no_trailing_pipe()
```

**Purpose**: Verifies parsing when only a leading outer pipe is present. It ensures the parser accepts the opposite asymmetric form as well.

**Data flow**: It calls `parse_table_segments("| A | B | C")` and asserts the expected segments.

**Call relations**: This complements the no-leading-pipe test for outer-pipe normalization.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::parse_table_segments_single_segment_is_allowed`  (lines 276–278)

```
fn parse_table_segments_single_segment_is_allowed()
```

**Purpose**: Checks that a single segment enclosed by outer pipes is still considered a valid parsed result. The parser is structural and does not require multiple columns.

**Data flow**: It calls `parse_table_segments("| only |")` and asserts `Some(vec!["only"])`.

**Call relations**: This test documents that outer pipes alone are enough to make a line table-like even with one segment.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::parse_table_segments_without_pipe_returns_none`  (lines 281–283)

```
fn parse_table_segments_without_pipe_returns_none()
```

**Purpose**: Ensures plain text without any pipe separators is not misclassified as a table row. It protects against false positives.

**Data flow**: It calls `parse_table_segments("just text")` and asserts `None`.

**Call relations**: This test covers the rejection path for non-table text.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::parse_table_segments_empty_returns_none`  (lines 286–289)

```
fn parse_table_segments_empty_returns_none()
```

**Purpose**: Ensures empty and whitespace-only lines are rejected by the parser. Blank lines cannot participate in table structure.

**Data flow**: It calls `parse_table_segments("")` and `parse_table_segments("   ")`, asserting `None` for both.

**Call relations**: This test protects the parser's early-empty-line guard.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::parse_table_segments_escaped_pipe`  (lines 292–298)

```
fn parse_table_segments_escaped_pipe()
```

**Purpose**: Verifies that escaped pipes remain inside a segment instead of splitting columns. This preserves structural correctness for cell text containing literal `|`.

**Data flow**: It calls `parse_table_segments(r"| A \| B | C |")` and asserts two segments, with the escaped pipe retained in the first segment text.

**Call relations**: This test specifically validates `split_unescaped_pipe` behavior through the public parser.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::is_table_delimiter_segment_valid`  (lines 301–307)

```
fn is_table_delimiter_segment_valid()
```

**Purpose**: Checks representative valid delimiter-segment forms, including alignment colons and long dash runs. It pins the accepted syntax.

**Data flow**: It calls `is_table_delimiter_segment` on several valid strings and asserts each returns true.

**Call relations**: This test covers the positive cases for the private delimiter-segment predicate.

*Call graph*: 1 external calls (assert!).


##### `tests::is_table_delimiter_segment_invalid`  (lines 310–315)

```
fn is_table_delimiter_segment_invalid()
```

**Purpose**: Checks representative invalid delimiter-segment forms such as empty strings, too-short dash runs, and non-dash text. It guards against over-acceptance.

**Data flow**: It calls `is_table_delimiter_segment` on invalid inputs and asserts each returns false.

**Call relations**: This complements the valid-segment test for delimiter syntax boundaries.

*Call graph*: 1 external calls (assert!).


##### `tests::is_table_delimiter_line_valid`  (lines 318–322)

```
fn is_table_delimiter_line_valid()
```

**Purpose**: Verifies that full delimiter rows with multiple valid segments are accepted. It covers both outer-piped and minimally-piped forms.

**Data flow**: It calls `is_table_delimiter_line` on several valid delimiter rows and asserts true.

**Call relations**: This test exercises whole-line delimiter validation built on parsed segments.

*Call graph*: 1 external calls (assert!).


##### `tests::is_table_delimiter_line_invalid`  (lines 325–328)

```
fn is_table_delimiter_line_invalid()
```

**Purpose**: Ensures non-delimiter rows are rejected by whole-line delimiter detection. It protects against confusing headers or short dashes with delimiter syntax.

**Data flow**: It calls `is_table_delimiter_line` on invalid rows and asserts false.

**Call relations**: This test covers the negative path for delimiter-line recognition.

*Call graph*: 1 external calls (assert!).


##### `tests::is_table_header_line_valid`  (lines 331–334)

```
fn is_table_header_line_valid()
```

**Purpose**: Verifies that typical header rows with at least one non-empty cell are accepted. It covers both outer-piped and plain internal-separator forms.

**Data flow**: It calls `is_table_header_line` on valid examples and asserts true.

**Call relations**: This test anchors the positive semantics of header detection.

*Call graph*: 1 external calls (assert!).


##### `tests::is_table_header_line_all_empty_segments`  (lines 337–339)

```
fn is_table_header_line_all_empty_segments()
```

**Purpose**: Ensures a row of only empty cells is not treated as a valid header. At least one visible cell is required.

**Data flow**: It calls `is_table_header_line("| | |")` and asserts false.

**Call relations**: This test protects the non-empty-cell requirement in header detection.

*Call graph*: 1 external calls (assert!).


##### `tests::fence_tracker_outside_by_default`  (lines 346–349)

```
fn fence_tracker_outside_by_default()
```

**Purpose**: Checks that a new fence tracker starts outside any fence. It validates the initial state contract.

**Data flow**: It constructs `FenceTracker::new()` and asserts `kind()` equals `FenceKind::Outside`.

**Call relations**: This is the baseline test for tracker initialization.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `tests::fence_tracker_opens_and_closes_backtick_fence`  (lines 352–362)

```
fn fence_tracker_opens_and_closes_backtick_fence()
```

**Purpose**: Verifies opening, staying inside, and closing a backtick fence with non-markdown info. It confirms ordinary fence lifecycle behavior.

**Data flow**: It advances a tracker through ` ```rust `, a content line, and ` ``` `, asserting `Other`, `Other`, then `Outside`.

**Call relations**: This test exercises the standard backtick-fence path in `advance`.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `tests::fence_tracker_opens_and_closes_tilde_fence`  (lines 365–371)

```
fn fence_tracker_opens_and_closes_tilde_fence()
```

**Purpose**: Verifies the same lifecycle for tilde fences. It ensures both supported marker characters behave consistently.

**Data flow**: It advances through `~~~python` and `~~~`, asserting `Other` then `Outside`.

**Call relations**: This complements the backtick-fence test.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `tests::fence_tracker_markdown_fence`  (lines 374–382)

```
fn fence_tracker_markdown_fence()
```

**Purpose**: Checks that markdown fences are classified distinctly from other fences and remain active across interior table-like lines. This matters because markdown fences are still eligible for table scanning.

**Data flow**: It advances through ` ```md `, a table-looking line, and ` ``` `, asserting `Markdown`, `Markdown`, then `Outside`.

**Call relations**: This test validates the `is_markdown_fence_info` branch used during fence opening.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `tests::fence_tracker_markdown_case_insensitive`  (lines 385–391)

```
fn fence_tracker_markdown_case_insensitive()
```

**Purpose**: Ensures markdown fence info matching is case-insensitive. It protects compatibility with varied fence info capitalization.

**Data flow**: It advances through ` ```Markdown ` and ` ``` `, asserting `Markdown` then `Outside`.

**Call relations**: This test specifically covers case-insensitive info-string handling.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `tests::fence_tracker_nested_shorter_marker_does_not_close`  (lines 394–404)

```
fn fence_tracker_nested_shorter_marker_does_not_close()
```

**Purpose**: Verifies that a shorter marker inside an open longer fence does not close it, while a matching-length marker does. This preserves markdown fence matching rules.

**Data flow**: It opens with four backticks, advances a three-backtick line and asserts the fence remains `Other`, then advances a four-backtick line and asserts `Outside`.

**Call relations**: This test covers the minimum-close-length rule in `advance`.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `tests::fence_tracker_mismatched_char_does_not_close`  (lines 407–416)

```
fn fence_tracker_mismatched_char_does_not_close()
```

**Purpose**: Ensures a tilde marker cannot close a backtick fence and vice versa. Fence marker character must match exactly.

**Data flow**: It opens a backtick fence, advances a tilde fence marker and asserts still `Other`, then advances a matching backtick close and asserts `Outside`.

**Call relations**: This test covers the marker-character matching rule in close detection.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `tests::fence_tracker_indented_4_spaces_ignored`  (lines 419–423)

```
fn fence_tracker_indented_4_spaces_ignored()
```

**Purpose**: Checks that lines indented more than three spaces are ignored for fence parsing. Such lines are treated as indented code, not fences.

**Data flow**: It advances a tracker with `    ```sh` and asserts the tracker remains `Outside`.

**Call relations**: This test protects the leading-space guard in `advance`.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `tests::fence_tracker_blockquote_prefix_stripped`  (lines 426–432)

```
fn fence_tracker_blockquote_prefix_stripped()
```

**Purpose**: Verifies that blockquote prefixes are removed before fence parsing so quoted fences still affect context. This aligns fence handling with quoted markdown semantics.

**Data flow**: It advances through `> ```sh` and `> `````, asserting `Other` then `Outside`.

**Call relations**: This test validates the use of `strip_blockquote_prefix` inside `advance`.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `tests::fence_tracker_close_with_trailing_content_does_not_close`  (lines 435–444)

```
fn fence_tracker_close_with_trailing_content_does_not_close()
```

**Purpose**: Ensures a would-be closing marker with trailing content does not terminate the fence. Only clean closing lines count.

**Data flow**: It opens a fence, advances ` ``` extra ` and asserts still `Other`, then advances ` ``` ` and asserts `Outside`.

**Call relations**: This test covers the trailing-content rejection branch in close detection.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `tests::parse_fence_marker_backtick`  (lines 451–454)

```
fn parse_fence_marker_backtick()
```

**Purpose**: Checks that backtick fence markers are parsed with the correct run length. It validates the marker parser directly.

**Data flow**: It calls `parse_fence_marker` on backtick examples and asserts the expected `(char, len)` tuples.

**Call relations**: This test isolates `parse_fence_marker` from tracker state.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::parse_fence_marker_tilde`  (lines 457–459)

```
fn parse_fence_marker_tilde()
```

**Purpose**: Checks that tilde fence markers are parsed correctly. It covers the alternate marker character.

**Data flow**: It calls `parse_fence_marker("~~~python")` and asserts `Some(('~', 3))`.

**Call relations**: This complements the backtick marker test.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::parse_fence_marker_too_short`  (lines 462–465)

```
fn parse_fence_marker_too_short()
```

**Purpose**: Ensures runs shorter than three are not treated as fences. This protects the minimum-length rule.

**Data flow**: It calls `parse_fence_marker` on two-character backtick and tilde runs and asserts `None`.

**Call relations**: This test covers the parser's short-run rejection path.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::parse_fence_marker_not_fence`  (lines 468–471)

```
fn parse_fence_marker_not_fence()
```

**Purpose**: Ensures ordinary text and empty input are not misclassified as fence markers. It protects the parser's initial-byte checks.

**Data flow**: It calls `parse_fence_marker` on `hello` and `""`, asserting `None`.

**Call relations**: This test covers non-fence inputs for the marker parser.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::is_markdown_fence_info_basic`  (lines 474–480)

```
fn is_markdown_fence_info_basic()
```

**Purpose**: Verifies markdown info-string recognition for `md` and `markdown`, including uppercase, and rejection of unrelated or absent info strings. It pins the fence-kind classification rule.

**Data flow**: It calls `is_markdown_fence_info` on several fence lines and asserts the expected booleans.

**Call relations**: This test isolates the info-string classifier used by `advance`.

*Call graph*: 1 external calls (assert!).


##### `tests::strip_blockquote_prefix_basic`  (lines 483–487)

```
fn strip_blockquote_prefix_basic()
```

**Purpose**: Checks that one or more leading blockquote markers are removed and non-quoted text is left unchanged. It validates the quote-stripping helper directly.

**Data flow**: It calls `strip_blockquote_prefix` on quoted and unquoted examples and asserts the resulting slices.

**Call relations**: This test supports both fence and table parsing behavior by pinning the shared normalization helper.

*Call graph*: 1 external calls (assert_eq!).


### `tui/src/mention_codec.rs`

`domain_logic` · `history serialization and deserialization`

This file defines the round-trip format for mentions stored in TUI history. `LinkedMention` carries the visible sigil, mention text, and canonical target path; `DecodedHistoryText` returns reconstructed plain text alongside the extracted bindings. Encoding walks the original UTF-8 text byte-by-byte, looking only at `$` and `@` sigils that appear at valid plaintext boundaries and are followed by mention-name characters (`[A-Za-z0-9_-]`). It groups supplied bindings by `(sigil, mention)` into `VecDeque`s so repeated mentions are linked in encounter order rather than reusing the same path. Boundary helpers deliberately reject embedded substrings such as email addresses or package scopes while still allowing punctuation-delimited mentions and path-like suffixes after the linked token.

Decoding performs the inverse scan over markdown text, recognizing only links of the form `[$name](path)` or `[@name](path)` with optional whitespace before `(`. It filters out false positives such as common environment variables (`$PATH`, `$HOME`, etc.) and only accepts paths that look like tool/plugin references (`app://`, `mcp://`, `plugin://`, `skill://`, or a filesystem `SKILL.md`). A compatibility branch maps `[@plugin](plugin://...)` back to `$plugin` when `at_mentions_enabled` is off, preserving older history semantics. The tests focus on ordering, punctuation boundaries, Unicode whitespace, legacy fallback, and avoiding accidental matches inside larger tokens.

#### Function details

##### `encode_history_mentions`  (lines 21–89)

```
fn encode_history_mentions(text: &str, mentions: &[LinkedMention]) -> String
```

**Purpose**: Scans plain history text for visible mention tokens and replaces matched occurrences with markdown links using the supplied `LinkedMention` bindings. It only links supported sigils and consumes duplicate bindings in order so repeated names can map to different paths.

**Data flow**: Inputs are the source `text` and a slice of `LinkedMention` records. It first filters mentions to `$` and `@`, buckets them in a `HashMap<(char, &str), VecDeque<&str>>`, then walks the text by byte index, validating mention starts with `starts_plaintext_mention`, mention bodies with `is_mention_name_char`, and mention ends with `ends_plaintext_mention`. When a queued binding exists for the exact `(sigil, name)`, it emits `[sigilname](path)` into the output string and pops that path from the queue; otherwise it copies the original character unchanged. It returns the rewritten string and does not mutate external state.

**Call relations**: This is the main encoder exercised by the mention codec tests. During scanning it delegates boundary and token-shape decisions to `starts_plaintext_mention`, `is_mention_name_char`, and `ends_plaintext_mention` so the core loop can decide whether to link or preserve raw text.

*Call graph*: calls 3 internal fn (ends_plaintext_mention, is_mention_name_char, starts_plaintext_mention); called by 9 (encode_history_mentions_does_not_let_at_token_steal_later_tool_binding, encode_history_mentions_links_at_mentions_after_unicode_whitespace, encode_history_mentions_links_both_sigils_for_same_name, encode_history_mentions_links_bound_mentions_in_order, encode_history_mentions_links_dollar_mentions_after_punctuation, encode_history_mentions_links_parenthesized_at_mentions, encode_history_mentions_links_sentence_ending_at_mentions, encode_history_mentions_preserves_at_sigils, encode_history_mentions_skips_embedded_at_substrings); 4 external calls (new, with_capacity, matches!, is_empty).


##### `decode_history_mentions_with_at_mentions`  (lines 91–127)

```
fn decode_history_mentions_with_at_mentions(
    text: &str,
    at_mentions_enabled: bool,
) -> DecodedHistoryText
```

**Purpose**: Parses stored history text containing linked mentions and reconstructs the visible text plus a list of extracted `LinkedMention` bindings. It optionally preserves `@` mentions instead of collapsing them into legacy `$` mentions.

**Data flow**: Inputs are markdown-ish `text` and the `at_mentions_enabled` feature flag. It iterates through the byte slice, and whenever it sees `[`, it asks `parse_history_linked_mention` whether a valid linked mention starts there. On success it appends the visible `sigil + name` token to the output text, pushes a `LinkedMention { sigil, mention, path }` into a vector, and jumps to the parsed end index; otherwise it copies the next UTF-8 character verbatim. It returns a `DecodedHistoryText` containing the reconstructed plain text and collected mentions.

**Call relations**: This is the public decoder used by callers that load history text and by the tests covering legacy and `@`-mention behavior. It relies on `parse_history_linked_mention` to enforce all syntax, path, and compatibility rules.

*Call graph*: calls 1 internal fn (parse_history_linked_mention); called by 6 (new_with_at_mentions, decode_history_mentions_restores_at_sigil_for_tool_paths, decode_history_mentions_restores_plugin_links_with_at_sigil, decode_history_mentions_restores_visible_tokens, decode_history_mentions_without_at_mentions_ignores_at_non_plugin_paths, decode_history_mentions_without_at_mentions_uses_legacy_plugin_fallback); 2 external calls (with_capacity, new).


##### `parse_history_linked_mention`  (lines 129–162)

```
fn parse_history_linked_mention(
    text: &'a str,
    text_bytes: &[u8],
    start: usize,
    at_mentions_enabled: bool,
) -> Option<(char, &'a str, &'a str, usize)>
```

**Purpose**: Recognizes one linked mention at a given `[` position and decides which visible sigil should be restored. It applies compatibility rules so only tool-like links survive decoding and legacy plugin links can downgrade from `@` to `$`.

**Data flow**: Inputs are the full `text`, its byte slice, the candidate `start` index, and `at_mentions_enabled`. It first tries `parse_linked_tool_mention` for `$`, then for `@`, and filters successful parses through `is_common_env_var` and `is_tool_path`. If `at_mentions_enabled` is false, an `@` mention is only accepted when its path starts with `plugin://`, and the returned sigil is rewritten to `$`. It returns `Some((sigil, name, path, end_index))` or `None`.

**Call relations**: This function is called only from `decode_history_mentions_with_at_mentions` when the outer scan encounters `[`. It delegates raw bracket-and-parenthesis parsing to `parse_linked_tool_mention`, then adds the semantic acceptance rules that determine whether the decoder should consume the link.

*Call graph*: calls 3 internal fn (is_common_env_var, is_tool_path, parse_linked_tool_mention); called by 1 (decode_history_mentions_with_at_mentions).


##### `parse_linked_tool_mention`  (lines 164–219)

```
fn parse_linked_tool_mention(
    text: &'a str,
    text_bytes: &[u8],
    start: usize,
    sigil: char,
) -> Option<(&'a str, &'a str, usize)>
```

**Purpose**: Parses the concrete markdown fragment `[$name](path)` or `[@name](path)` starting at a `[` byte. It validates sigil placement, mention-name characters, closing delimiters, and a non-empty trimmed path.

**Data flow**: Inputs are the original `text`, its bytes, the `start` index, and the expected `sigil`. It checks for `[` followed immediately by that sigil, consumes a mention name using `is_mention_name_char`, requires a closing `]`, skips ASCII whitespace before `(`, then scans until `)` and trims the enclosed path. It returns borrowed slices for `name` and `path` plus the index after the closing `)`; otherwise it returns `None` without side effects.

**Call relations**: This is the low-level parser used by `parse_history_linked_mention` for both `$` and `@` candidates. It intentionally does syntax extraction only, leaving environment-variable and tool-path filtering to its caller.

*Call graph*: calls 1 internal fn (is_mention_name_char); called by 1 (parse_history_linked_mention).


##### `is_mention_name_char`  (lines 221–223)

```
fn is_mention_name_char(byte: u8) -> bool
```

**Purpose**: Defines the byte-level character class allowed inside mention names. The accepted set is ASCII letters, digits, underscore, and hyphen.

**Data flow**: It takes one `u8` and returns a boolean based on a `matches!` range check. It reads no external state and writes nothing.

**Call relations**: This helper is used by both `encode_history_mentions` and `parse_linked_tool_mention` so encoding and decoding agree on the exact mention token grammar.

*Call graph*: called by 2 (encode_history_mentions, parse_linked_tool_mention); 1 external calls (matches!).


##### `starts_plaintext_mention`  (lines 225–233)

```
fn starts_plaintext_mention(text: &str, index: usize) -> bool
```

**Purpose**: Determines whether a sigil at a byte index begins a standalone plaintext mention rather than appearing inside another token. It treats start-of-string, whitespace, and non-name punctuation as valid left boundaries.

**Data flow**: Inputs are the full `text` and the candidate byte `index`. It inspects the previous Unicode scalar, if any, and returns true when there is no previous character or when that character is whitespace or fails `is_mention_name_char_char`. It returns a boolean and has no side effects.

**Call relations**: This helper is consulted by `encode_history_mentions` for `@` mentions and for non-tool plaintext-boundary checks, preventing accidental linking inside emails or package-like strings.

*Call graph*: called by 1 (encode_history_mentions).


##### `ends_plaintext_mention`  (lines 235–248)

```
fn ends_plaintext_mention(text_bytes: &[u8], index: usize) -> bool
```

**Purpose**: Determines whether the byte after a parsed mention name is a valid right boundary for plaintext linking. It allows sentence punctuation and path-like continuations to remain outside the linked token.

**Data flow**: It takes the text byte slice and the index immediately after the mention name. It returns true at end-of-input, on whitespace, on a period followed by whitespace or non-name punctuation, or on other non-name delimiters while explicitly rejecting continuation characters such as `.`, `/`, `\`, alphanumerics, `_`, and `-`. It produces only a boolean.

**Call relations**: This function is called from `encode_history_mentions` after a candidate name has been scanned. Its boundary rules are what make cases like `$figma/docs` encode as a linked `$figma` followed by `/docs` instead of rejecting the mention entirely.

*Call graph*: called by 1 (encode_history_mentions).


##### `is_mention_name_char_char`  (lines 250–252)

```
fn is_mention_name_char_char(ch: char) -> bool
```

**Purpose**: Provides the character-level version of the mention-name predicate for boundary checks on preceding Unicode characters.

**Data flow**: It accepts a `char` and returns true for ASCII alphanumerics, underscore, or hyphen. It has no side effects.

**Call relations**: This helper is used internally by `starts_plaintext_mention` to decide whether the character before a sigil makes the sigil embedded in a larger token.

*Call graph*: 1 external calls (matches!).


##### `is_common_env_var`  (lines 254–270)

```
fn is_common_env_var(name: &str) -> bool
```

**Purpose**: Filters out uppercase names that are likely shell environment variables rather than intended tool mentions. This avoids decoding links like `$PATH` as structured mentions.

**Data flow**: It takes a mention `name`, uppercases it with `to_ascii_uppercase`, and compares it against a fixed allowlist of common environment variable names such as `PATH`, `HOME`, `USER`, and `XDG_CONFIG_HOME`. It returns a boolean and does not mutate state.

**Call relations**: This semantic filter is applied by `parse_history_linked_mention` after syntax parsing succeeds, so only plausible tool/plugin mentions are restored into structured history metadata.

*Call graph*: called by 1 (parse_history_linked_mention); 1 external calls (matches!).


##### `is_tool_path`  (lines 272–281)

```
fn is_tool_path(path: &str) -> bool
```

**Purpose**: Recognizes canonical mention target paths that should round-trip as tool mentions. It accepts known URI schemes and filesystem paths ending in `SKILL.md`.

**Data flow**: It takes a `&str` path and returns true if it starts with `app://`, `mcp://`, `plugin://`, or `skill://`, or if the last path segment after `/` or `\` equals `SKILL.md` case-insensitively. It reads no external state.

**Call relations**: This helper is used by `parse_history_linked_mention` to reject arbitrary markdown links and keep decoding limited to tool/plugin references that the TUI intentionally stores.

*Call graph*: called by 1 (parse_history_linked_mention).


##### `tests::decode_history_mentions_restores_visible_tokens`  (lines 289–315)

```
fn decode_history_mentions_restores_visible_tokens()
```

**Purpose**: Verifies that decoding converts linked `$` mentions back into visible plaintext tokens and preserves their paths in encounter order.

**Data flow**: The test feeds a string containing three linked mentions into `decode_history_mentions_with_at_mentions(true)`, then compares the returned `DecodedHistoryText.text` and `mentions` vector against explicit expected values.

**Call relations**: It exercises the normal decode path through `decode_history_mentions_with_at_mentions`, including parsing multiple links and preserving duplicate names with different paths.

*Call graph*: calls 1 internal fn (decode_history_mentions_with_at_mentions); 1 external calls (assert_eq!).


##### `tests::decode_history_mentions_restores_plugin_links_with_at_sigil`  (lines 318–339)

```
fn decode_history_mentions_restores_plugin_links_with_at_sigil()
```

**Purpose**: Checks that when `@` mentions are enabled, plugin links written with `@` decode back to visible `@name` tokens rather than legacy `$name` tokens.

**Data flow**: The test passes mixed `[@sample](plugin://...)` and `[$figma](app://...)` text into the decoder with `at_mentions_enabled = true` and asserts both the visible text and structured mentions.

**Call relations**: It validates the `@` branch inside `parse_history_linked_mention` as reached from `decode_history_mentions_with_at_mentions`.

*Call graph*: calls 1 internal fn (decode_history_mentions_with_at_mentions); 1 external calls (assert_eq!).


##### `tests::decode_history_mentions_without_at_mentions_uses_legacy_plugin_fallback`  (lines 342–363)

```
fn decode_history_mentions_without_at_mentions_uses_legacy_plugin_fallback()
```

**Purpose**: Confirms that disabled `@` mentions trigger the compatibility fallback that rewrites plugin `@` links to visible `$` mentions.

**Data flow**: The test decodes text containing an `@sample` plugin link and a `$figma` app link with `at_mentions_enabled = false`, then asserts that both visible tokens and stored sigils are `$`.

**Call relations**: It specifically covers the legacy fallback branch in `parse_history_linked_mention` invoked by the main decoder.

*Call graph*: calls 1 internal fn (decode_history_mentions_with_at_mentions); 1 external calls (assert_eq!).


##### `tests::decode_history_mentions_without_at_mentions_ignores_at_non_plugin_paths`  (lines 366–374)

```
fn decode_history_mentions_without_at_mentions_ignores_at_non_plugin_paths()
```

**Purpose**: Ensures that when `@` mentions are disabled, non-plugin `@` links are left untouched instead of being misinterpreted as legacy tool mentions.

**Data flow**: The test decodes `[@figma](app://figma-1)` with `at_mentions_enabled = false` and asserts that the original markdown text remains unchanged and no mentions are extracted.

**Call relations**: It verifies the negative path in `parse_history_linked_mention` where the fallback only accepts `plugin://` targets.

*Call graph*: calls 1 internal fn (decode_history_mentions_with_at_mentions); 1 external calls (assert_eq!).


##### `tests::decode_history_mentions_restores_at_sigil_for_tool_paths`  (lines 377–392)

```
fn decode_history_mentions_restores_at_sigil_for_tool_paths()
```

**Purpose**: Checks that enabled `@` mentions preserve the `@` sigil even for non-plugin tool paths such as `app://`.

**Data flow**: The test decodes a single `[@figma](app://figma-1)` link with `at_mentions_enabled = true` and asserts the visible text and `LinkedMention` contents.

**Call relations**: It covers the accepted `@`-tool-path branch in `parse_history_linked_mention` through the public decoder.

*Call graph*: calls 1 internal fn (decode_history_mentions_with_at_mentions); 1 external calls (assert_eq!).


##### `tests::encode_history_mentions_links_bound_mentions_in_order`  (lines 395–421)

```
fn encode_history_mentions_links_bound_mentions_in_order()
```

**Purpose**: Verifies that repeated visible mentions consume queued bindings in order and leave unmatched later tokens untouched.

**Data flow**: The test calls `encode_history_mentions` with text containing `$figma`, `$sample`, another `$figma`, and `$other`, plus three bindings. It asserts that the first two `$figma` occurrences use different paths in sequence and `$other` remains plain text.

**Call relations**: It exercises the encoder's `HashMap` plus `VecDeque` binding strategy and the main scanning loop.

*Call graph*: calls 1 internal fn (encode_history_mentions); 1 external calls (assert_eq!).


##### `tests::encode_history_mentions_links_dollar_mentions_after_punctuation`  (lines 424–434)

```
fn encode_history_mentions_links_dollar_mentions_after_punctuation()
```

**Purpose**: Checks that punctuation before a `$` mention still counts as a valid left boundary for linking.

**Data flow**: The test encodes `($figma)` with one `$figma` binding and asserts that only the mention token becomes a markdown link inside the parentheses.

**Call relations**: It validates the left-boundary logic in `starts_plaintext_mention` as used by `encode_history_mentions`.

*Call graph*: calls 1 internal fn (encode_history_mentions); 1 external calls (assert_eq!).


##### `tests::encode_history_mentions_links_dollar_mentions_with_path_like_suffixes`  (lines 437–456)

```
fn encode_history_mentions_links_dollar_mentions_with_path_like_suffixes()
```

**Purpose**: Ensures the encoder links the mention token itself while preserving following path-like or suffix characters outside the link.

**Data flow**: The test reuses one `LinkedMention` and calls `encode_history_mentions` on `$figma/docs`, `$figma.suffix`, and `$figma\docs`, asserting the exact split between linked token and trailing text.

**Call relations**: It covers the right-boundary behavior implemented by `ends_plaintext_mention` inside the encoder.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::encode_history_mentions_preserves_at_sigils`  (lines 459–480)

```
fn encode_history_mentions_preserves_at_sigils()
```

**Purpose**: Checks that `@` bindings encode as `[@name](path)` rather than being normalized to `$`.

**Data flow**: The test passes text with two `@` mentions and one unrelated `$other`, along with two `@` bindings, then asserts the exact encoded output.

**Call relations**: It exercises the encoder's per-sigil binding map and confirms that `@` and `$` are treated as distinct tokens.

*Call graph*: calls 1 internal fn (encode_history_mentions); 1 external calls (assert_eq!).


##### `tests::encode_history_mentions_links_both_sigils_for_same_name`  (lines 483–504)

```
fn encode_history_mentions_links_both_sigils_for_same_name()
```

**Purpose**: Verifies that the same mention name can be linked separately for `@` and `$` without collisions.

**Data flow**: The test encodes `@figma then $figma` with one `@figma` binding and one `$figma` binding and asserts that each occurrence receives the correct path.

**Call relations**: It validates the encoder's `(sigil, name)` map key, ensuring one sigil cannot consume the other's queued binding.

*Call graph*: calls 1 internal fn (encode_history_mentions); 1 external calls (assert_eq!).


##### `tests::encode_history_mentions_does_not_let_at_token_steal_later_tool_binding`  (lines 507–518)

```
fn encode_history_mentions_does_not_let_at_token_steal_later_tool_binding()
```

**Purpose**: Ensures an earlier `@name` occurrence does not consume a later `$name` binding when only the `$` binding exists.

**Data flow**: The test encodes `@figma then $figma` with only a `$figma` binding and asserts that the `@figma` stays plain while the later `$figma` is linked.

**Call relations**: It covers the same sigil-sensitive queueing behavior as the previous test, but from the negative case.

*Call graph*: calls 1 internal fn (encode_history_mentions); 1 external calls (assert_eq!).


##### `tests::encode_history_mentions_links_at_mentions_after_unicode_whitespace`  (lines 521–533)

```
fn encode_history_mentions_links_at_mentions_after_unicode_whitespace()
```

**Purpose**: Checks that non-ASCII whitespace still counts as a valid left boundary for plaintext `@` mentions.

**Data flow**: The test encodes a string containing a full-width space before `@sample` and asserts that the mention is linked correctly.

**Call relations**: It specifically exercises the Unicode-character path in `starts_plaintext_mention` used by the encoder.

*Call graph*: calls 1 internal fn (encode_history_mentions); 1 external calls (assert_eq!).


##### `tests::encode_history_mentions_links_sentence_ending_at_mentions`  (lines 536–547)

```
fn encode_history_mentions_links_sentence_ending_at_mentions()
```

**Purpose**: Verifies that a sentence-ending period after an `@` mention does not prevent linking.

**Data flow**: The test encodes `Please ask @figma.` with one `@figma` binding and asserts that the period remains outside the generated link.

**Call relations**: It covers the period-handling branch in `ends_plaintext_mention` through `encode_history_mentions`.

*Call graph*: calls 1 internal fn (encode_history_mentions); 1 external calls (assert_eq!).


##### `tests::encode_history_mentions_links_parenthesized_at_mentions`  (lines 550–561)

```
fn encode_history_mentions_links_parenthesized_at_mentions()
```

**Purpose**: Checks that parenthesized `@` mentions are recognized and linked correctly.

**Data flow**: The test encodes `Please ask (@figma)` with one binding and asserts the exact markdown output with parentheses preserved around the link.

**Call relations**: It exercises the encoder's boundary logic for punctuation-delimited mentions.

*Call graph*: calls 1 internal fn (encode_history_mentions); 1 external calls (assert_eq!).


##### `tests::encode_history_mentions_skips_embedded_at_substrings`  (lines 564–578)

```
fn encode_history_mentions_skips_embedded_at_substrings()
```

**Purpose**: Ensures the encoder does not treat embedded `@sample` substrings inside emails or package paths as standalone mentions.

**Data flow**: The test encodes `foo@sample.com npx @sample/pkg then @sample` with one `@sample` binding and asserts that only the final standalone token is linked.

**Call relations**: It validates the combined left- and right-boundary checks used by `encode_history_mentions` to avoid false positives.

*Call graph*: calls 1 internal fn (encode_history_mentions); 1 external calls (assert_eq!).


### Citation extraction
This specialized parser turns hidden citation markup into structured memory citation data for downstream use.

### `memories/read/src/citations.rs`

`domain_logic` · `memory citation parsing during read-path processing`

This module turns citation strings emitted elsewhere in the system into `codex_protocol::memory_citation::MemoryCitation` values. The main parser accepts multiple citation blobs, scans each one for two independent sections, and merges the results: `<citation_entries>...</citation_entries>` contributes structured file/line annotations, while `<rollout_ids>` or legacy `<thread_ids>` contributes rollout/thread identifiers. Entry parsing is line-oriented and strict about shape: each non-empty line must look like `path:start-end|note=[text]`, with the note enclosed in a trailing bracket pair and both line numbers parseable as integers.

`parse_memory_citation` accumulates entries in encounter order and rollout IDs in first-seen order while deduplicating them with a `HashSet`. If no entries and no IDs are found across all input strings, it returns `None`; otherwise it returns a `MemoryCitation` containing whatever was successfully extracted. `thread_ids_from_memory_citation` then filters the stored rollout ID strings through `ThreadId::try_from`, silently dropping malformed IDs rather than failing the whole citation. The helper functions are intentionally small: `extract_block` performs delimiter-based substring extraction using `split_once`, and `extract_ids_block` prefers `<rollout_ids>` but falls back to `<thread_ids>`. The overall design is tolerant of partial or mixed-quality input: malformed entry lines and invalid IDs are ignored, but valid data from the same citation blob is preserved.

#### Function details

##### `parse_memory_citation`  (lines 6–43)

```
fn parse_memory_citation(citations: Vec<String>) -> Option<MemoryCitation>
```

**Purpose**: Parses one or more citation markup strings into a single `MemoryCitation`, collecting both file-line entries and rollout/thread IDs. It merges data across all provided strings and deduplicates IDs while preserving first-seen order.

**Data flow**: Consumes `citations: Vec<String>`, initializes empty `entries`, `rollout_ids`, and `seen_rollout_ids`, iterates over each citation string, extracts a `<citation_entries>` block if present and extends `entries` with successfully parsed lines from `parse_memory_citation_entry`, extracts an IDs block via `extract_ids_block`, trims and filters non-empty ID lines, inserts unseen IDs into the set and vector, then returns `None` if both collections are empty or `Some(MemoryCitation { entries, rollout_ids })` otherwise.

**Call relations**: This parser is called by higher-level read-path code that strips assistant markup and records memory-citation usage. Within the module it delegates block extraction to `extract_block`/`extract_ids_block` and per-line entry parsing to `parse_memory_citation_entry`.

*Call graph*: calls 2 internal fn (extract_block, extract_ids_block); called by 2 (record_stage1_output_usage_and_detect_memory_citation, strip_hidden_assistant_markup_and_parse_memory_citation); 2 external calls (new, new).


##### `thread_ids_from_memory_citation`  (lines 45–51)

```
fn thread_ids_from_memory_citation(memory_citation: &MemoryCitation) -> Vec<ThreadId>
```

**Purpose**: Converts the string rollout IDs stored in a `MemoryCitation` into typed `ThreadId` values where possible. Invalid IDs are ignored rather than causing an error.

**Data flow**: Reads `memory_citation.rollout_ids`, iterates over the strings, attempts `ThreadId::try_from(id.as_str())` for each, keeps only successful conversions, and returns the resulting `Vec<ThreadId>`.

**Call relations**: This helper is used by telemetry/usage code that needs typed thread identifiers after citation parsing. It depends on `parse_memory_citation` having already collected rollout IDs as strings.

*Call graph*: called by 1 (record_stage1_output_usage_for_memory_citation).


##### `parse_memory_citation_entry`  (lines 53–70)

```
fn parse_memory_citation_entry(line: &str) -> Option<MemoryCitationEntry>
```

**Purpose**: Parses a single citation-entry line into a `MemoryCitationEntry`. It expects a path, line range, and note in a compact delimiter-based format.

**Data flow**: Takes `line: &str`, trims it, returns `None` for empty input, splits from the right on `|note=[` to separate location from note, strips the closing `]`, splits the location from the right on `:` to isolate the path, splits the line range on `-`, parses `line_start` and `line_end` as integers, and returns `Some(MemoryCitationEntry { path, line_start, line_end, note })` if every step succeeds.

**Call relations**: This is an internal helper used only by `parse_memory_citation` while processing `<citation_entries>` blocks. Its failure mode is intentionally soft so malformed lines are skipped without aborting the whole citation.


##### `extract_block`  (lines 72–76)

```
fn extract_block(text: &'a str, open: &str, close: &str) -> Option<&'a str>
```

**Purpose**: Extracts the substring between a given opening and closing marker. It is a generic delimiter helper used for citation markup sections.

**Data flow**: Accepts `text`, `open`, and `close`; uses `split_once(open)` to discard any prefix before the opening marker, then `split_once(close)` on the remainder to isolate the body, and returns `Some(body)` or `None` if either delimiter is missing.

**Call relations**: This helper is called directly by `parse_memory_citation` for `<citation_entries>` and indirectly through `extract_ids_block` for rollout/thread ID sections. It provides the module’s only markup extraction primitive.

*Call graph*: called by 2 (extract_ids_block, parse_memory_citation).


##### `extract_ids_block`  (lines 78–81)

```
fn extract_ids_block(text: &str) -> Option<&str>
```

**Purpose**: Finds the rollout/thread ID section in a citation string, supporting both current and legacy tag names. It abstracts the compatibility fallback away from the main parser.

**Data flow**: Receives `text: &str`, first tries `extract_block(text, "<rollout_ids>", "</rollout_ids>")`, and if that returns `None`, tries `extract_block(text, "<thread_ids>", "</thread_ids>")`; it returns whichever body is found first.

**Call relations**: Used only by `parse_memory_citation` when collecting rollout IDs. It delegates actual substring extraction to `extract_block` and encodes the backward-compatibility policy for legacy markup.

*Call graph*: calls 1 internal fn (extract_block); called by 1 (parse_memory_citation).
