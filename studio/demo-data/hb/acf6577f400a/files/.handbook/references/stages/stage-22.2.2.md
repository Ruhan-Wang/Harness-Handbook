# Streaming, line framing, and hidden-markup parsers  `stage-22.2.2`

This stage is shared behind-the-scenes support for reading text that arrives in pieces, such as live assistant output or process logs. Its job is to turn messy chunks into clean, useful events without losing hidden information. The stream-parser front door gathers these helpers for the rest of the project. Its common result model separates visible text from hidden parts, like citations or metadata, so the app can show only what users should see while still keeping machine-readable details. The UTF-8 stream reader safely joins raw bytes into text even when one character is split across chunks. The line buffer does a similar job for process output, waiting until a full newline-ended line is ready. Other parsers remove inline hidden tags, detect tagged blocks that start and end on their own lines, and extract structured memory citations. The table detector recognizes Markdown tables and code fences so display and cleanup code agree. The mention codec turns user-friendly tool mentions into stored links and back again. Together, these pieces act like filters on a conveyor belt for streamed text.

## Files in this stage

### Parser foundations
These files define the shared parser contract and crate-level exports that the streaming parser utilities build on.

### `utils/stream-parser/src/stream_text.rs`

`data_model` · `cross-cutting`

Streaming text often arrives in small pieces, not as one complete message. That creates a practical problem: some parts may be normal text that can be shown right away, while other parts may be special hidden markers that should be extracted instead of displayed. This file gives the rest of the stream parser code a shared language for that job.

The main data type, `StreamTextChunk<T>`, is the parser's answer after it receives one piece of input. It contains `visible_text`, which is ordinary text ready to render, and `extracted`, a list of hidden payloads found in that input. The `T` means the extracted payload can be any type chosen by a specific parser, much like a labeled box whose contents depend on what kind of parser is using it.

The file also defines the `StreamTextParser` trait. A trait is a promise that different parser types can follow the same basic interface. Any parser using this trait must accept new text with `push_str` and must provide a final cleanup step with `finish`, which releases anything it had to keep buffered while waiting for more input. Without this file, different parsers would likely return results in incompatible ways, making streamed parsing harder to combine and reuse.

#### Function details

##### `StreamTextChunk::default`  (lines 11–16)

```
fn default() -> Self
```

**Purpose**: Creates an empty parser result: no visible text and no extracted payloads. This is useful when a parser receives input but cannot safely emit anything yet, or when a final flush has nothing left to return.

**Data flow**: It takes no outside input except the payload type chosen by the caller. It creates a fresh empty string for `visible_text` and a fresh empty list for `extracted`, then returns a `StreamTextChunk` containing both.

**Call relations**: Other parser helpers call this when they need a clean, empty result to start from or return. It is used during chunk collection, byte pushing, text pushing, finishing, and segment mapping, so it acts like the standard empty basket that many parser flows can hand back when there is nothing to show or extract.

*Call graph*: called by 9 (collect_chunks, finish, push_str, collect_chunks, map_segments, collect_chunks, finish, push_bytes, collect_bytes); 2 external calls (new, new).


##### `StreamTextChunk::is_empty`  (lines 21–23)

```
fn is_empty(&self) -> bool
```

**Purpose**: Checks whether this parser result contains nothing at all. It answers the simple question: did this chunk produce any visible text or any extracted payloads?

**Data flow**: It reads the chunk's `visible_text` and `extracted` list. If the text is empty and the extracted list is also empty, it returns `true`; otherwise it returns `false`. It does not change the chunk.

**Call relations**: This is a convenience check for code that receives parser output and wants to skip no-op results. It sits at the edge of the result object itself, so callers do not need to repeat the two separate emptiness checks every time.


### `utils/stream-parser/src/lib.rs`

`util` · `cross-cutting`

This file does not contain parsing logic itself. Instead, it acts like the index desk at a library: it tells Rust which internal parser modules belong to this crate, and it re-exports the important pieces so other code can import them easily.

The crate is about reading text that arrives in pieces rather than all at once. That matters for systems that display or process assistant output while it is still being generated. Different modules focus on different patterns inside that stream: normal assistant text, citation markers, hidden inline tags, proposed-plan blocks, tagged lines, and valid UTF-8 text. UTF-8 is the common text encoding used by Rust strings; a stream parser for it is important because a character can be split across two incoming chunks.

By re-exporting names such as `AssistantTextStreamParser`, `CitationStreamParser`, `InlineHiddenTagParser`, `ProposedPlanParser`, `StreamTextParser`, and `Utf8StreamParser`, this file keeps callers from needing to know the crate's internal file layout. Without this file, users would have to import from each private module directly, or the crate would not expose these tools at all.


### Streaming input adapters
These utilities adapt raw streamed input into parseable units by handling UTF-8 chunk boundaries and incremental line framing.

### `utils/stream-parser/src/utf8_stream.rs`

`domain_logic` · `stream parsing`

Streams often arrive in small byte chunks, not neat pieces of text. UTF-8, the common way to store text as bytes, can use more than one byte for a single character. That means a character like “é” may arrive as half in one chunk and half in the next. This file wraps an existing StreamTextParser, which expects valid text, and adds a small waiting room for unfinished UTF-8 bytes.

The main type, Utf8StreamParser, receives byte chunks. It adds each chunk to its pending byte buffer, then tries to read the buffer as UTF-8 text. If everything is valid, it passes the text to the wrapped parser and clears the buffer. If the bytes end in the middle of a character, it passes along only the complete text before that point and keeps the unfinished bytes for later. If the bytes are truly invalid, it rolls back the newly added chunk so the inner parser never sees a half-bad result.

The error type explains the two failure cases: invalid UTF-8, or the stream ending while a character is still incomplete. The tests show the important promises: split characters work, invalid chunks do not poison later parsing, and callers can choose either strict or lossy cleanup.

#### Function details

##### `Utf8StreamParserError::fmt`  (lines 22–35)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Turns a UTF-8 stream error into a clear human-readable message. This is what someone sees when the error is printed or included in a log.

**Data flow**: It receives one error value and a formatter to write into. It checks which kind of error happened, writes a sentence with the useful details, and returns whether formatting succeeded.

**Call relations**: This is used through Rust’s standard Display formatting path. When other code prints a Utf8StreamParserError, this function supplies the message and uses the external write! formatting tool to place text into the output.

*Call graph*: 1 external calls (write!).


##### `Utf8StreamParser::new`  (lines 54–59)

```
fn new(inner: P) -> Self
```

**Purpose**: Creates a byte-aware wrapper around an existing text parser. Use it when incoming data is bytes but the parser underneath expects valid text.

**Data flow**: It takes an inner parser as input. It stores that parser and starts with an empty buffer for pending UTF-8 bytes, then returns the ready-to-use wrapper.

**Call relations**: The tests call this at the start of each scenario to build a parser around CitationStreamParser. After creation, the wrapper can receive byte chunks through push_bytes, be completed through finish, or be unwrapped later.

*Call graph*: called by 6 (utf8_stream_parser_errors_on_incomplete_code_point_at_eof, utf8_stream_parser_handles_split_code_points_across_chunks, utf8_stream_parser_into_inner_errors_when_partial_code_point_is_buffered, utf8_stream_parser_into_inner_lossy_drops_buffered_partial_code_point, utf8_stream_parser_rolls_back_entire_chunk_when_invalid_byte_follows_valid_prefix, utf8_stream_parser_rolls_back_on_invalid_utf8_chunk); 1 external calls (new).


##### `Utf8StreamParser::push_bytes`  (lines 66–109)

```
fn push_bytes(
        &mut self,
        chunk: &[u8],
    ) -> Result<StreamTextChunk<P::Extracted>, Utf8StreamParserError>
```

**Purpose**: Feeds one chunk of raw bytes into the wrapped text parser while protecting it from broken UTF-8. It is the main streaming entry point for normal input.

**Data flow**: It receives a byte slice and appends it to any bytes already waiting from a previous chunk. If the combined bytes form valid UTF-8, it converts them to text, sends that text into the inner parser, clears the buffer, and returns the parser’s visible text and extracted items. If the bytes end with an unfinished character, it sends only the complete prefix and keeps the unfinished bytes. If the new chunk makes the data invalid, it removes that whole chunk from the pending buffer and returns an error.

**Call relations**: In the test helper collect_bytes, this is called repeatedly for each incoming chunk. When complete text is available, it hands that text to the wrapped parser’s push_str method; when no complete character is ready yet, it returns an empty default chunk.

*Call graph*: calls 1 internal fn (default); called by 1 (collect_bytes); 2 external calls (push_str, from_utf8).


##### `Utf8StreamParser::finish`  (lines 111–149)

```
fn finish(&mut self) -> Result<StreamTextChunk<P::Extracted>, Utf8StreamParserError>
```

**Purpose**: Ends the byte stream and flushes any remaining complete text into the inner parser. It also detects the important error case where the stream ends halfway through a UTF-8 character.

**Data flow**: It first looks at the pending byte buffer. If those bytes are invalid, it returns an error; if they are an incomplete final character, it returns the incomplete-at-end error. If complete text remains, it sends it to the inner parser and clears the buffer. Then it asks the inner parser to finish, combines that final output with any output just produced, and returns the combined result.

**Call relations**: collect_bytes calls this after all byte chunks have been pushed. It is the bridge between byte-level cleanup and the inner parser’s own finish step, making sure both layers get a chance to produce final visible text and extracted values.

*Call graph*: calls 1 internal fn (default); called by 1 (collect_bytes); 3 external calls (finish, push_str, from_utf8).


##### `Utf8StreamParser::into_inner`  (lines 154–170)

```
fn into_inner(self) -> Result<P, Utf8StreamParserError>
```

**Purpose**: Returns the wrapped parser only if it is safe to do so without leaving behind a broken UTF-8 character. This is the strict way to unwrap the parser.

**Data flow**: It consumes the Utf8StreamParser. If there are no pending bytes, it returns the inner parser. If pending bytes exist, it checks whether they are valid UTF-8; invalid bytes produce an invalid UTF-8 error, and an unfinished final character produces an incomplete-at-end error. If the bytes are valid, it returns the inner parser without flushing those bytes.

**Call relations**: This is a public escape hatch for callers that want the original parser back. The related test checks that it refuses to unwrap when a partial character is still buffered, while finish is the safer choice when the caller wants pending text flushed first.

*Call graph*: 1 external calls (from_utf8).


##### `Utf8StreamParser::into_inner_lossy`  (lines 175–177)

```
fn into_inner_lossy(self) -> P
```

**Purpose**: Returns the wrapped parser without checking or flushing leftover bytes. This is useful only when the caller is willing to drop any unfinished UTF-8 character.

**Data flow**: It consumes the wrapper and simply returns the inner parser. Any bytes waiting in the UTF-8 buffer are discarded as part of dropping the wrapper.

**Call relations**: This is the intentionally permissive counterpart to into_inner. The test for it shows the expected tradeoff: a buffered partial character disappears, and the inner parser can still be finished afterward.


##### `tests::collect_bytes`  (lines 190–204)

```
fn collect_bytes(
        parser: &mut Utf8StreamParser<CitationStreamParser>,
        chunks: &[&[u8]],
    ) -> Result<StreamTextChunk<String>, Utf8StreamParserError>
```

**Purpose**: Provides a small test helper that feeds several byte chunks into a Utf8StreamParser and gathers all output into one result. It keeps the tests focused on behavior instead of repeated plumbing.

**Data flow**: It receives a mutable parser and a list of byte chunks. For each chunk, it calls push_bytes and appends the returned visible text and extracted values to one running result. After all chunks, it calls finish and appends that final output too, then returns the combined result or the first error encountered.

**Call relations**: The split-character test calls this helper to exercise the normal full-stream path. Inside, it uses push_bytes for each chunk and finish at the end, so it tests the wrapper the same way a real streaming caller would use it.

*Call graph*: calls 3 internal fn (default, finish, push_bytes).


##### `tests::utf8_stream_parser_handles_split_code_points_across_chunks`  (lines 207–222)

```
fn utf8_stream_parser_handles_split_code_points_across_chunks()
```

**Purpose**: Checks that characters whose UTF-8 bytes are split across chunk boundaries still come out correctly. It also verifies that the wrapped citation parser can extract text while the wrapper is doing byte decoding.

**Data flow**: It builds three byte chunks containing visible text, a citation tag, and multi-byte characters split between chunks. It creates a Utf8StreamParser around a CitationStreamParser, feeds all chunks through collect_bytes, and checks that the visible output is “AéZ” while the extracted citation is “中”.

**Call relations**: This test starts by calling the constructors for the wrapper and inner parser. It then hands the real work to collect_bytes, which in turn drives push_bytes and finish, and finally uses assertions to confirm the combined behavior.

*Call graph*: calls 2 internal fn (new, new); 3 external calls (assert_eq!, panic!, collect_bytes).


##### `tests::utf8_stream_parser_rolls_back_on_invalid_utf8_chunk`  (lines 225–258)

```
fn utf8_stream_parser_rolls_back_on_invalid_utf8_chunk()
```

**Purpose**: Checks that a bad continuation byte does not permanently damage the parser’s buffered state. This matters because callers may want to recover after receiving one bad chunk.

**Data flow**: It first sends the leading byte of “é”, which should be buffered because it is incomplete. Then it sends an invalid byte and expects an invalid UTF-8 error. After that, it sends the correct continuation byte plus “x” and verifies that the parser still produces “éx” with no extracted items.

**Call relations**: The test creates a fresh wrapper and inner citation parser, then uses assertions and expected panics to prove the rollback promise. It focuses on the error path inside push_bytes: the new bad chunk is rejected, but the older pending byte remains usable.

*Call graph*: calls 2 internal fn (new, new); 3 external calls (assert!, assert_eq!, panic!).


##### `tests::utf8_stream_parser_rolls_back_entire_chunk_when_invalid_byte_follows_valid_prefix`  (lines 261–283)

```
fn utf8_stream_parser_rolls_back_entire_chunk_when_invalid_byte_follows_valid_prefix()
```

**Purpose**: Checks that if one chunk contains some valid text followed by an invalid byte, none of that chunk is passed to the inner parser. This prevents the inner parser from seeing a partial result from a chunk that the caller may choose to retry or discard.

**Data flow**: It sends the bytes for “ok” followed by an invalid byte and expects an invalid UTF-8 error that points after the valid prefix. Then it sends “!” and verifies that only “!” appears as output, showing that “ok” was not secretly accepted before the error.

**Call relations**: The test builds a fresh parser with the usual constructors and then exercises the rollback rule. It confirms, through assertions, that push_bytes treats an invalid chunk as all-or-nothing.

*Call graph*: calls 2 internal fn (new, new); 3 external calls (assert!, assert_eq!, panic!).


##### `tests::utf8_stream_parser_errors_on_incomplete_code_point_at_eof`  (lines 286–300)

```
fn utf8_stream_parser_errors_on_incomplete_code_point_at_eof()
```

**Purpose**: Checks that ending the stream in the middle of a UTF-8 character is reported as an error. This protects callers from silently losing or corrupting the final character.

**Data flow**: It sends two bytes that begin but do not complete a multi-byte character. The push call should return no output because the parser is waiting for the rest. Then finish is called, and the test expects an IncompleteUtf8AtEof error.

**Call relations**: This test creates a parser and drives the end-of-stream path. It shows the division of responsibility: push_bytes may wait for more data, but finish must decide that no more data is coming and report the unfinished character.

*Call graph*: calls 2 internal fn (new, new); 3 external calls (assert!, assert_eq!, panic!).


##### `tests::utf8_stream_parser_into_inner_errors_when_partial_code_point_is_buffered`  (lines 303–317)

```
fn utf8_stream_parser_into_inner_errors_when_partial_code_point_is_buffered()
```

**Purpose**: Checks that the strict unwrapping method refuses to return the inner parser while an unfinished UTF-8 character is still buffered. This prevents accidental silent data loss.

**Data flow**: It sends one leading byte of a multi-byte character, which leaves the wrapper with pending data and no output. Then it calls into_inner and expects an IncompleteUtf8AtEof error instead of receiving the inner parser.

**Call relations**: The test sets up the parser with the normal constructors and then targets into_inner specifically. It confirms that callers who want safety should not be allowed to bypass an unfinished byte sequence.

*Call graph*: calls 2 internal fn (new, new); 3 external calls (assert!, assert_eq!, panic!).


##### `tests::utf8_stream_parser_into_inner_lossy_drops_buffered_partial_code_point`  (lines 320–332)

```
fn utf8_stream_parser_into_inner_lossy_drops_buffered_partial_code_point()
```

**Purpose**: Checks the deliberately lossy unwrapping method. It proves that callers can choose to discard an unfinished UTF-8 character if that is acceptable for their situation.

**Data flow**: It sends one leading byte of a multi-byte character, producing no output and leaving that byte buffered. Then it calls into_inner_lossy to get the wrapped parser back, finishes the inner parser, and checks that no text appears from the discarded byte.

**Call relations**: This test contrasts with the strict into_inner test. It uses the same setup but follows the lossy path, showing that into_inner_lossy skips validation and hands back the inner parser directly.

*Call graph*: calls 2 internal fn (new, new); 2 external calls (assert!, panic!).


### `ollama/src/line_buffer.rs`

`util` · `request handling`

Programs often receive text output in uneven pieces. For example, a child process might write “hello\n”, but the reader might receive “he” first and “llo\n” later. This file provides `LineBuffer`, a simple holding area for those pieces. New bytes are appended as they arrive. When the rest of the system asks for a line, the buffer looks for a newline byte, which marks the end of a line. If it finds one, it cuts that complete line out of the front of the buffer and gives it back. If it does not find one, it keeps all the bytes for later.

A small but important detail is `scanned_len`. This remembers how much of the buffer has already been checked and found not to contain a newline. That way, each call does not repeatedly search the same old bytes. Think of it like placing a bookmark after the part of a page you already inspected. When more bytes arrive, the next search starts from the bookmark rather than from the beginning.

Without this file, code that reads standard output or standard error from a process would need to repeatedly solve the same awkward problem: turning unpredictable byte chunks into clean, complete lines without losing partial data.

#### Function details

##### `LineBuffer::extend_from_slice`  (lines 13–15)

```
fn extend_from_slice(&mut self, bytes: &[u8])
```

**Purpose**: Adds newly received bytes to the end of the buffer. This is used when output arrives from a process but may not yet form a complete line.

**Data flow**: It takes a slice of bytes as input. Those bytes are copied onto the end of the buffer’s existing bytes. It does not return a value; after it runs, the buffer simply contains more data waiting to be read as lines.

**Call relations**: When process output arrives, `push_process_output` and `push_stderr` call this function to store the new bytes. Later, code can call `LineBuffer::take_line` to see whether the accumulated bytes now include a complete line.

*Call graph*: called by 2 (push_process_output, push_stderr); 1 external calls (extend_from_slice).


##### `LineBuffer::take_line`  (lines 17–27)

```
fn take_line(&mut self) -> Option<BytesMut>
```

**Purpose**: Tries to remove and return the next complete line from the buffer. A complete line means bytes up to and including a newline character.

**Data flow**: It looks through the buffered bytes, starting after the part it has already checked before. If it finds no newline, it records that the current buffer has been scanned and returns nothing. If it finds a newline, it splits the complete line off the front of the buffer, resets the scan marker, and returns that line.

**Call relations**: `push_stderr` and `take_stdout_message` call this when they need to turn buffered process output into line-sized pieces. Inside, it uses a fast newline search and then splits the buffer so the returned line is removed while any later bytes stay behind for future calls.

*Call graph*: called by 2 (push_stderr, take_stdout_message); 3 external calls (len, split_to, memchr).


### Generic markup parsers
These reusable parsers incrementally recognize hidden inline tags and line-delimited tagged blocks from streamed text.

### `utils/stream-parser/src/inline_hidden_tag.rs`

`domain_logic` · `cross-cutting; active whenever streamed text chunks are parsed`

This parser solves a common streaming problem: the text arrives in pieces, but tags may be split across those pieces. For example, one chunk might end with "<oa" and the next might start with "i-mem-citation>". A simple search on each chunk would miss that. This file keeps a small buffer of unfinished text so it can recognize tag openings and closings even when they cross chunk boundaries.

The main type, InlineHiddenTagParser, is configured with one or more literal tag descriptions: an opening marker, a closing marker, and a label saying what kind of tag it is. As text is pushed in, the parser separates it into two streams. Normal text goes into visible_text. Text found between a configured opening and closing marker is removed from the visible output and returned as extracted data.

The parser is deliberately simple: matching is literal, and tags are not nested. Think of it like a highlighter with scissors: when it sees a configured opening marker, it starts cutting that section out until it sees the matching closing marker. If the input ends while a tag is still open, it treats the remaining buffered text as the hidden content and returns it anyway. The tests at the bottom check multiple tag kinds, non-English characters, tie-breaking between similar openers, and invalid empty delimiters.

#### Function details

##### `InlineHiddenTagParser::new`  (lines 50–70)

```
fn new(specs: Vec<InlineTagSpec<T>>) -> Self
```

**Purpose**: Creates a new inline tag parser from a list of tag rules. It refuses to start with no rules, or with empty opening or closing markers, because those would make matching meaningless or unsafe.

**Data flow**: It receives a list of tag specifications, checks that the list is not empty, then checks that every opening and closing marker has real text. If all checks pass, it returns a parser with those rules saved, an empty pending-text buffer, and no currently open tag.

**Call relations**: This is the setup step used by production code and by the tests before any text can be parsed. After construction, callers feed text into InlineHiddenTagParser::push_str and eventually call InlineHiddenTagParser::finish.

*Call graph*: called by 6 (new, generic_inline_parser_prefers_longest_opener_at_same_offset, generic_inline_parser_rejects_empty_close_delimiter, generic_inline_parser_rejects_empty_open_delimiter, generic_inline_parser_supports_multiple_tag_types, generic_inline_parser_supports_non_ascii_tag_delimiters); 2 external calls (new, assert!).


##### `InlineHiddenTagParser::find_next_open`  (lines 72–88)

```
fn find_next_open(&self) -> Option<(usize, usize)>
```

**Purpose**: Finds the next configured opening tag marker inside the parser's pending text. If more than one marker starts at the same place, it chooses the longest one so a more specific tag wins over a shorter prefix.

**Data flow**: It reads the parser's saved tag rules and the current pending text. It searches for each opening marker, compares their positions, and returns the earliest match along with which rule matched. If nothing is found, it returns no match.

**Call relations**: InlineHiddenTagParser::push_str calls this when the parser is not already inside a hidden tag. Its answer decides whether the parser should pass more text through visibly or switch into hidden-content collection.

*Call graph*: called by 1 (push_str).


##### `InlineHiddenTagParser::max_open_prefix_suffix_len`  (lines 90–96)

```
fn max_open_prefix_suffix_len(&self) -> usize
```

**Purpose**: Figures out how much text should be kept at the end of the pending buffer because it might be the beginning of an opening tag split across chunks.

**Data flow**: It compares the end of the pending text with the start of every configured opening marker. It returns the longest overlap length, or zero if the pending text cannot be the start of any opener.

**Call relations**: InlineHiddenTagParser::push_str uses this when no full opening tag has been found yet. This lets the parser safely output text that definitely cannot become a tag, while holding back only the possible partial marker.

*Call graph*: called by 1 (push_str).


##### `InlineHiddenTagParser::push_visible_prefix`  (lines 98–102)

```
fn push_visible_prefix(out: &mut StreamTextChunk<ExtractedInlineTag<T>>, pending: &str)
```

**Purpose**: Adds a piece of confirmed normal text to the visible output. It skips empty strings so it does not do unnecessary work.

**Data flow**: It receives an output chunk and a piece of pending text. If that text is not empty, it appends it to the chunk's visible_text field; it does not extract anything.

**Call relations**: This is a small helper used while parsing, especially when text before an opening tag can be safely shown. InlineHiddenTagParser::drain_visible_to_suffix_match also uses the same behavior when draining confirmed visible text.


##### `InlineHiddenTagParser::drain_visible_to_suffix_match`  (lines 104–115)

```
fn drain_visible_to_suffix_match(
        &mut self,
        out: &mut StreamTextChunk<ExtractedInlineTag<T>>,
        keep_suffix_len: usize,
    )
```

**Purpose**: Moves safe visible text out of the parser's pending buffer while keeping a possible partial opening tag at the end. This is what prevents the parser from accidentally showing half of a tag marker too early.

**Data flow**: It receives an output chunk and the number of ending characters to keep. It calculates everything before that kept suffix, appends that part to visible_text, and removes it from the pending buffer. The possible partial marker remains buffered for the next input chunk.

**Call relations**: InlineHiddenTagParser::push_str calls this when no complete opening tag is currently visible. It relies on InlineHiddenTagParser::push_visible_prefix to add confirmed normal text to the output.

*Call graph*: called by 1 (push_str); 1 external calls (push_visible_prefix).


##### `InlineHiddenTagParser::push_str`  (lines 124–174)

```
fn push_str(&mut self, chunk: &str) -> StreamTextChunk<Self::Extracted>
```

**Purpose**: Consumes one new piece of streamed text and returns whatever visible text or hidden tag content can be confidently produced now. This is the parser's main workhorse.

**Data flow**: It appends the new chunk to the pending buffer. If a hidden tag is already open, it searches for that tag's closing marker; found content is extracted, while unfinished content stays buffered only as much as needed to catch a split closing marker. If no tag is open, it searches for the next opening marker; text before it becomes visible, then the parser starts collecting hidden content. If no complete opening marker is present, it outputs only the text that cannot possibly be part of a split marker. The result is a StreamTextChunk containing visible text and any extracted tags produced by this push.

**Call relations**: Callers repeatedly use this as text arrives. Inside, it asks InlineHiddenTagParser::find_next_open where hidden text begins, uses InlineHiddenTagParser::max_open_prefix_suffix_len and longest_suffix_prefix_len to protect split markers across chunk boundaries, and uses InlineHiddenTagParser::drain_visible_to_suffix_match or InlineHiddenTagParser::push_visible_prefix to move safe visible text into the returned chunk.

*Call graph*: calls 5 internal fn (drain_visible_to_suffix_match, find_next_open, max_open_prefix_suffix_len, longest_suffix_prefix_len, default); called by 1 (push_str); 2 external calls (push_visible_prefix, new).


##### `InlineHiddenTagParser::finish`  (lines 176–197)

```
fn finish(&mut self) -> StreamTextChunk<Self::Extracted>
```

**Purpose**: Ends the stream and flushes anything still held inside the parser. This is needed because the last chunk may leave behind visible text or an unclosed hidden tag.

**Data flow**: It creates an empty output chunk. If a tag is currently open, it treats all remaining pending text as that tag's content, clears the buffer, and returns it as extracted data. If no tag is open, it moves any remaining pending text into visible_text and clears the buffer.

**Call relations**: Callers should use this after the final push_str call. The test helper tests::collect_chunks does this to make sure results include the final buffered text.

*Call graph*: calls 1 internal fn (default); called by 1 (finish).


##### `longest_suffix_prefix_len`  (lines 200–208)

```
fn longest_suffix_prefix_len(s: &str, needle: &str) -> usize
```

**Purpose**: Finds how much of the end of one string matches the beginning of another string. The parser uses this to recognize possible tag markers that are split between chunks.

**Data flow**: It receives a current string and a target marker. It checks the longest possible overlap first, while respecting character boundaries so multi-byte characters are not cut in the middle. It returns the overlap length, or zero if there is no overlap.

**Call relations**: InlineHiddenTagParser::push_str calls this while waiting for a closing marker, and InlineHiddenTagParser::max_open_prefix_suffix_len uses the same idea for opening markers. It is the small matching tool that makes streaming-safe parsing possible.

*Call graph*: called by 1 (push_str).


##### `tests::collect_chunks`  (lines 224–238)

```
fn collect_chunks(parser: &mut P, chunks: &[&str]) -> StreamTextChunk<P::Extracted>
```

**Purpose**: Runs a parser across several input chunks and combines all of its outputs into one result. It lets tests describe streaming input naturally without repeating boilerplate.

**Data flow**: It receives a mutable parser and a list of text chunks. For each chunk, it calls push_str, appends returned visible text to a combined result, and gathers extracted tags. At the end it calls finish and adds that final output too.

**Call relations**: The test cases call this after constructing an InlineHiddenTagParser. It exercises the same push-then-finish flow that real streaming code would use.

*Call graph*: calls 1 internal fn (default); 2 external calls (finish, push_str).


##### `tests::generic_inline_parser_supports_multiple_tag_types`  (lines 241–263)

```
fn generic_inline_parser_supports_multiple_tag_types()
```

**Purpose**: Checks that one parser can recognize more than one kind of hidden inline tag. It verifies both the visible text and the extracted tag labels and contents.

**Data flow**: It builds a parser with two tag rules, feeds it a string containing both tag types, and collects the output. The expected result is visible text with both hidden sections removed and two extracted records, one for each tag.

**Call relations**: This test calls InlineHiddenTagParser::new to set up the parser and tests::collect_chunks to run the streaming flow. It confirms the main parser behavior for multiple configured tags.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, collect_chunks, vec!).


##### `tests::generic_inline_parser_supports_non_ascii_tag_delimiters`  (lines 266–279)

```
fn generic_inline_parser_supports_non_ascii_tag_delimiters()
```

**Purpose**: Checks that the parser works with non-ASCII characters in tag markers and content. This matters because some characters take more than one byte internally, and careless slicing could break them.

**Data flow**: It creates a parser whose opening and closing markers contain "é", then feeds the input in chunks that split the marker. The expected output keeps only the surrounding visible letters and extracts the Chinese character inside the tag.

**Call relations**: This test uses InlineHiddenTagParser::new and tests::collect_chunks. It specifically protects the behavior supported by longest_suffix_prefix_len, which respects character boundaries.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, collect_chunks, vec!).


##### `tests::generic_inline_parser_prefers_longest_opener_at_same_offset`  (lines 282–302)

```
fn generic_inline_parser_prefers_longest_opener_at_same_offset()
```

**Purpose**: Checks the tie-breaking rule when two opening markers could start at the same position. The longer opener should win, so a specific marker is not mistaken for a shorter one.

**Data flow**: It builds a parser with "<a>" and "<ab>" as possible openers, then feeds text containing "<ab>". The expected result is that the parser extracts the content as the tag tied to the longer "<ab>" rule.

**Call relations**: This test calls InlineHiddenTagParser::new and tests::collect_chunks. It confirms the selection behavior implemented by InlineHiddenTagParser::find_next_open.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, collect_chunks, vec!).


##### `tests::generic_inline_parser_rejects_empty_open_delimiter`  (lines 306–312)

```
fn generic_inline_parser_rejects_empty_open_delimiter()
```

**Purpose**: Checks that the parser refuses a tag rule with an empty opening marker. An empty opener would match everywhere and make parsing impossible to reason about.

**Data flow**: It tries to create a parser with an empty open string and a normal close string. The expected outcome is a panic, meaning construction fails immediately instead of allowing a broken parser.

**Call relations**: This test directly exercises the validation inside InlineHiddenTagParser::new. It does not proceed to parsing because the invalid configuration should be rejected at startup.

*Call graph*: calls 1 internal fn (new); 1 external calls (vec!).


##### `tests::generic_inline_parser_rejects_empty_close_delimiter`  (lines 316–322)

```
fn generic_inline_parser_rejects_empty_close_delimiter()
```

**Purpose**: Checks that the parser refuses a tag rule with an empty closing marker. Without a real closer, the parser could not know where hidden content ends.

**Data flow**: It tries to create a parser with a normal open string and an empty close string. The expected outcome is a panic during construction.

**Call relations**: This test directly exercises the validation inside InlineHiddenTagParser::new. Like the empty-opener test, it confirms bad tag rules are caught before any streamed text is processed.

*Call graph*: calls 1 internal fn (new); 1 external calls (vec!).


### `utils/stream-parser/src/tagged_line_parser.rs`

`domain_logic` · `stream parsing during incremental text handling`

Streaming text often arrives in chunks that do not line up with lines or tags. For example, one chunk might contain “<t” and the next might contain “ag>\n”. This file solves that by keeping a small amount of memory between calls, like holding a bookmark while reading a page a few words at a time.

The main type, TaggedLineParser, is given a list of tag rules: an opening marker, a closing marker, and the tag value those markers represent. As text arrives, parse reads it character by character. At the start of each line it pauses before deciding whether the line is normal text or a tag line. It only accepts a tag if the trimmed line exactly matches a known open or close marker. If the line has extra text, it is treated as normal text.

When inside a tag block, ordinary text becomes TagDelta, meaning “content belonging to this tag.” Outside a tag block, it becomes Normal. TagStart and TagEnd mark the boundaries. finish is used when the stream ends, so any half-buffered line is resolved and any still-open tag is closed. push_segment keeps the output tidy by joining neighboring pieces of the same kind.

#### Function details

##### `TaggedLineParser::new`  (lines 37–44)

```
fn new(specs: Vec<TagSpec<T>>) -> Self
```

**Purpose**: Creates a fresh parser with the tag rules it should recognize. A caller uses this before feeding streamed text into the parser.

**Data flow**: It receives a list of tag specifications, each saying what opening text and closing text count as a tag. It stores that list, starts with no active tag, prepares to look for tags at the start of a line, and creates an empty line buffer. The result is a ready-to-use TaggedLineParser.

**Call relations**: This is the setup step before parsing begins. The test helper tests::parser calls it to build a parser for test cases, and normal callers do the same before calling TaggedLineParser::parse.

*Call graph*: called by 2 (new, parser); 1 external calls (new).


##### `TaggedLineParser::parse`  (lines 46–82)

```
fn parse(&mut self, delta: &str) -> Vec<TaggedLineSegment<T>>
```

**Purpose**: Consumes the next piece of streamed text and turns any completed decisions into output segments. It is designed for partial input, so it can wait when a possible tag has not fully arrived yet.

**Data flow**: It receives a text chunk. It reads characters one by one, buffering the start of a line while that line might still become a tag. If the buffered text stops matching any possible tag prefix, it releases it as normal text or tag content. When it reaches a newline, it asks finish_line to decide whether the whole line was a tag. It returns the segments that can be safely emitted from this chunk.

**Call relations**: This is the main workhorse used while text is arriving. It calls is_tag_prefix to decide whether to keep waiting, finish_line when a full line is available, and push_text when text should be emitted as either normal text or text inside the active tag.

*Call graph*: calls 3 internal fn (finish_line, is_tag_prefix, push_text); called by 1 (push_str); 3 external calls (new, new, take).


##### `TaggedLineParser::finish`  (lines 84–110)

```
fn finish(&mut self) -> Vec<TaggedLineSegment<T>>
```

**Purpose**: Ends the parsing session cleanly. It resolves any leftover buffered line and closes any tag block that was still open.

**Data flow**: It reads the parser’s saved line buffer and current active tag. If the buffered line exactly matches an opening tag, it emits a TagStart; if it exactly matches the matching closing tag, it emits a TagEnd; otherwise it emits the buffered text. Then, if a tag is still active, it emits a final TagEnd and clears the active tag. It returns the final segments and resets tag detection for future use.

**Call relations**: Callers use this after the last parse call, when no more text is coming. It uses match_open and match_close to classify the final line, push_text for ordinary leftover text, and push_segment to add boundary events cleanly.

*Call graph*: calls 4 internal fn (match_close, match_open, push_text, push_segment); called by 1 (finish); 4 external calls (new, take, TagEnd, TagStart).


##### `TaggedLineParser::finish_line`  (lines 112–137)

```
fn finish_line(&mut self, segments: &mut Vec<TaggedLineSegment<T>>)
```

**Purpose**: Decides what a completed line means. A line can be an opening tag, a closing tag, or plain text.

**Data flow**: It takes the saved line buffer, removes the trailing newline only for checking, and trims surrounding spaces for tag matching. If the line exactly matches an opening tag and no tag is already active, it emits TagStart and marks that tag active. If it matches the closing tag for the active block, it emits TagEnd and clears the active tag. Otherwise it sends the whole original line onward as text.

**Call relations**: TaggedLineParser::parse calls this whenever it reaches a newline while watching for possible tags. It relies on match_open and match_close for the exact tag checks, and uses push_text or push_segment to produce the right output.

*Call graph*: calls 4 internal fn (match_close, match_open, push_text, push_segment); called by 1 (parse); 3 external calls (take, TagEnd, TagStart).


##### `TaggedLineParser::push_text`  (lines 139–145)

```
fn push_text(&self, text: String, segments: &mut Vec<TaggedLineSegment<T>>)
```

**Purpose**: Adds a piece of ordinary text to the output in the correct category. The same characters mean different things depending on whether the parser is currently inside a tag block.

**Data flow**: It receives a text string and the growing output list. If there is an active tag, it wraps the text as TagDelta for that tag. If there is no active tag, it wraps the text as Normal. It then passes that segment to push_segment, which may append it or merge it with the previous segment.

**Call relations**: parse, finish_line, and finish all call this when they have text that is not itself a tag marker. It delegates the final insertion to push_segment so output stays compact.

*Call graph*: calls 1 internal fn (push_segment); called by 3 (finish, finish_line, parse); 2 external calls (Normal, TagDelta).


##### `TaggedLineParser::is_tag_prefix`  (lines 147–152)

```
fn is_tag_prefix(&self, slug: &str) -> bool
```

**Purpose**: Checks whether the current buffered line could still become a known tag. This is what lets the parser wait for more characters instead of wrongly emitting a partial tag as text.

**Data flow**: It receives the current possible tag text, trims trailing whitespace, and compares it against every known opening and closing marker. If any marker starts with that text, it returns true. Otherwise it returns false, meaning the line cannot be a tag anymore.

**Call relations**: TaggedLineParser::parse calls this while reading a line. If it returns true, parse keeps buffering; if it returns false, parse stops waiting and emits the buffered characters as text.

*Call graph*: called by 1 (parse).


##### `TaggedLineParser::match_open`  (lines 154–159)

```
fn match_open(&self, slug: &str) -> Option<T>
```

**Purpose**: Finds whether a completed line is exactly one of the configured opening tags. It returns the tag identity when there is a match.

**Data flow**: It receives a trimmed line. It compares that line with each configured opening marker. If one is equal, it returns the tag value from that rule; if none match, it returns nothing.

**Call relations**: finish_line uses this for complete lines during normal parsing, and finish uses it for a final buffered line at end of input. Its result tells those functions whether to emit TagStart.

*Call graph*: called by 2 (finish, finish_line).


##### `TaggedLineParser::match_close`  (lines 161–166)

```
fn match_close(&self, slug: &str) -> Option<T>
```

**Purpose**: Finds whether a completed line is exactly one of the configured closing tags. It returns the tag identity when there is a match.

**Data flow**: It receives a trimmed line. It compares that line with each configured closing marker. If one is equal, it returns the tag value from that rule; if none match, it returns nothing.

**Call relations**: finish_line uses this for complete lines during normal parsing, and finish uses it for a final buffered line at end of input. Its result tells those functions whether to emit TagEnd, but only when it matches the currently active tag.

*Call graph*: called by 2 (finish, finish_line).


##### `push_segment`  (lines 169–199)

```
fn push_segment(segments: &mut Vec<TaggedLineSegment<T>>, segment: TaggedLineSegment<T>)
```

**Purpose**: Adds one parsed segment to the output while avoiding unnecessary clutter. It drops empty text pieces and joins neighboring text pieces of the same kind.

**Data flow**: It receives the output list and one segment. Empty Normal or TagDelta text is ignored. A Normal segment is joined onto the previous Normal segment when possible. A TagDelta segment is joined onto the previous TagDelta only if both belong to the same tag. TagStart and TagEnd are always appended as separate boundary markers.

**Call relations**: push_text uses this for normal text and tag content, while finish_line and finish use it for tag start and end events. It is the final cleanup step before segments leave the parser.

*Call graph*: called by 3 (finish, finish_line, push_text); 4 external calls (Normal, TagDelta, TagEnd, TagStart).


##### `tests::parser`  (lines 213–219)

```
fn parser() -> TaggedLineParser<Tag>
```

**Purpose**: Builds a small parser used by the tests. It recognizes one block tag with “<tag>” as the opener and “</tag>” as the closer.

**Data flow**: It creates a tag specification for the test-only Tag::Block value and passes it to TaggedLineParser::new. The result is a parser ready for test input.

**Call relations**: The test cases call this helper so they all use the same setup. It keeps the tests focused on parser behavior rather than repeated construction code.

*Call graph*: calls 1 internal fn (new); 1 external calls (vec!).


##### `tests::buffers_prefix_until_tag_is_decided`  (lines 222–236)

```
fn buffers_prefix_until_tag_is_decided()
```

**Purpose**: Checks that the parser waits when a tag arrives split across chunks. This protects the streaming behavior that makes the parser useful.

**Data flow**: It creates a parser, feeds it “<t” first, then feeds the rest of the opening tag, a content line, and the closing tag. After finish, it compares the output with the expected TagStart, TagDelta, and TagEnd sequence.

**Call relations**: This test exercises TaggedLineParser::parse across multiple calls and then TaggedLineParser::finish at the end. It confirms that partial tag prefixes are buffered instead of being emitted too early as normal text.

*Call graph*: 2 external calls (assert_eq!, parser).


##### `tests::rejects_tag_lines_with_extra_text`  (lines 239–248)

```
fn rejects_tag_lines_with_extra_text()
```

**Purpose**: Checks that a tag marker only counts when it appears alone on the line. This prevents text like “<tag> extra” from accidentally starting a block.

**Data flow**: It creates a parser, feeds a line containing an opening tag plus extra words, then finishes the stream. It expects one Normal segment containing the whole line.

**Call relations**: This test drives TaggedLineParser::parse and TaggedLineParser::finish through the case where a tag-like line fails exact matching. It confirms the rule enforced by finish_line and the final-line logic in finish.

*Call graph*: 2 external calls (assert_eq!, parser).


### Markdown structure helpers
These helpers detect markdown-specific structures and encode or decode mention markup used by higher-level text processing.

### `tui/src/table_detect.rs`

`domain_logic` · `cross-cutting during Markdown parsing and streaming line scanning`

Markdown tables are easy for people to read but tricky for a program to spot while text is still arriving line by line. A normal sentence may contain a pipe character, and code examples may contain many pipes that should not become tables. This file solves that problem by providing small, shared checks for table-shaped lines and a tracker for fenced code blocks, which are blocks started by three or more backticks or tildes.

The table part works one line at a time. It trims the line, splits it on pipe characters that are real separators, and ignores escaped pipes such as `\|` because those are meant as text. It can then answer two important questions: does this look like a table header, and does this look like the required delimiter row made of dashes and optional colons?

The fence part works like a bookmark that remembers whether the current stream is outside code, inside Markdown code, or inside some other language’s code. That matters because tables inside Markdown fences may still be meaningful, while pipes inside Rust or shell code are just code. It also understands blockquotes, so lines like `> | A | B |` can still be treated as table candidates.

#### Function details

##### `parse_table_segments`  (lines 38–54)

```
fn parse_table_segments(line: &str) -> Option<Vec<&str>>
```

**Purpose**: Splits one possible Markdown table line into its cell-like pieces. It is used when callers need to know whether a line has table structure, not when they need to render the table for display.

**Data flow**: It receives one raw line of text. It trims outer whitespace, removes a leading or trailing pipe if present, asks `split_unescaped_pipe` to cut only at real separator pipes, trims each resulting piece, and returns the pieces; if the line is empty or has no usable table separator, it returns nothing.

**Call relations**: Higher-level table checks call this first because both headers and delimiter rows depend on the same idea of what counts as a pipe-separated line. The streaming table scanner and table candidate text logic rely on its answer before deciding whether consecutive lines form a real table.

*Call graph*: calls 1 internal fn (split_unescaped_pipe); called by 3 (table_candidate_text, is_table_delimiter_line, is_table_header_line).


##### `split_unescaped_pipe`  (lines 61–80)

```
fn split_unescaped_pipe(content: &str) -> Vec<&str>
```

**Purpose**: Cuts a line into pieces at pipe characters that are not escaped. This prevents text like `A \| B` from being mistaken for two table cells.

**Data flow**: It receives the already-trimmed table content without outer pipes. It walks through the bytes, skips over a character after a backslash, records each unescaped pipe as a split point, and returns borrowed slices of the original text.

**Call relations**: It is the low-level helper used by `parse_table_segments`. Callers do not use it directly for table decisions; they get the safer, trimmed result from `parse_table_segments` instead.

*Call graph*: called by 1 (parse_table_segments); 1 external calls (with_capacity).


##### `is_table_header_line`  (lines 88–90)

```
fn is_table_header_line(line: &str) -> bool
```

**Purpose**: Checks whether a line can serve as the header row of a Markdown pipe table. A header must have pipe-separated pieces and at least one non-empty cell.

**Data flow**: It receives a line, passes it to `parse_table_segments`, then looks for any segment that is not empty. It returns true if such a segment exists and false otherwise.

**Call relations**: The table holdback scanner calls this while reading source lines. It uses the result as the first half of the table pattern, waiting to see whether the next line is a delimiter row.

*Call graph*: calls 1 internal fn (parse_table_segments); called by 1 (table_holdback_state).


##### `is_table_delimiter_segment`  (lines 95–103)

```
fn is_table_delimiter_segment(segment: &str) -> bool
```

**Purpose**: Checks one cell of a Markdown table delimiter row, such as `---`, `:---`, `---:`, or `:---:`. These dash-and-colon markers tell Markdown where the table header ends and how columns align.

**Data flow**: It receives one segment, trims it, removes one optional colon from the start and one optional colon from the end, then checks that at least three dashes remain and that every remaining character is a dash. It returns true only for valid delimiter markers.

**Call relations**: It is the small rule used when validating a whole delimiter line. The delimiter-line check applies this same rule to every segment so a row is accepted only if all columns look like Markdown alignment markers.


##### `is_table_delimiter_line`  (lines 108–111)

```
fn is_table_delimiter_line(line: &str) -> bool
```

**Purpose**: Checks whether a whole line is a valid Markdown table delimiter row. This is the row of dashes that must immediately follow a table header.

**Data flow**: It receives a line, splits it with `parse_table_segments`, and then verifies that every segment matches the delimiter-segment rule. It returns true only when the entire row is made of valid delimiter markers.

**Call relations**: The table holdback scanner calls this after a possible header line. Together with `is_table_header_line`, it lets the scanner confirm that two neighboring lines really start a table.

*Call graph*: calls 1 internal fn (parse_table_segments); called by 1 (table_holdback_state).


##### `FenceTracker::new`  (lines 149–151)

```
fn new() -> Self
```

**Purpose**: Creates a fresh fenced-code-block tracker. At creation time it assumes the reader is outside any fenced code block.

**Data flow**: It takes no input. It returns a `FenceTracker` with no remembered open fence.

**Call relations**: Streaming and Markdown parsing code create one tracker before walking through lines. Tests also create fresh trackers so each fence scenario starts from a clean state.

*Call graph*: called by 12 (new, parse_lines_with_fence_state, fence_tracker_blockquote_prefix_stripped, fence_tracker_close_with_trailing_content_does_not_close, fence_tracker_indented_4_spaces_ignored, fence_tracker_markdown_case_insensitive, fence_tracker_markdown_fence, fence_tracker_mismatched_char_does_not_close, fence_tracker_nested_shorter_marker_does_not_close, fence_tracker_opens_and_closes_backtick_fence (+2 more)).


##### `FenceTracker::advance`  (lines 157–188)

```
fn advance(&mut self, raw_line: &str)
```

**Purpose**: Feeds one raw source line into the fence tracker so it can notice when a fenced code block opens or closes. This is how the scanner avoids treating pipes inside ordinary code blocks as Markdown tables.

**Data flow**: It receives a raw line, ignores it if it is indented more than three spaces, strips blockquote markers, and checks for a backtick or tilde fence marker. If no fence is open, a marker opens one and records whether it is Markdown or another language; if a fence is already open, a matching marker of sufficient length with no trailing text closes it. It updates the tracker’s stored state and returns nothing.

**Call relations**: The streaming line flow calls this as lines are pushed through. Inside, it relies on `strip_blockquote_prefix`, `parse_fence_marker`, and `is_markdown_fence_info` to make the same fence decision every time.

*Call graph*: calls 3 internal fn (is_markdown_fence_info, parse_fence_marker, strip_blockquote_prefix); called by 1 (push_line).


##### `FenceTracker::kind`  (lines 192–194)

```
fn kind(&self) -> FenceKind
```

**Purpose**: Reports the current fence context: outside code, inside Markdown code, or inside other code. Callers use this to decide whether pipe characters on nearby lines should count as table syntax.

**Data flow**: It reads the tracker’s stored state. If there is no open fence, it returns `Outside`; otherwise it returns the stored fence kind.

**Call relations**: The streaming line flow calls this around line processing after the tracker has been advanced. Its answer guides whether table detection should run or be skipped for code content.

*Call graph*: called by 1 (push_line).


##### `parse_fence_marker`  (lines 203–213)

```
fn parse_fence_marker(line: &str) -> Option<(char, usize)>
```

**Purpose**: Recognizes the opening marker part of a fenced code block: at least three backticks or at least three tildes. It does not decide the language; it only identifies the marker character and length.

**Data flow**: It receives text that has already had leading indentation and blockquote markers removed. It checks the first byte, counts how many matching marker characters appear at the start, and returns the marker character plus its run length; if the line is not a valid marker, it returns nothing.

**Call relations**: `FenceTracker::advance` calls this for each candidate line. The tracker then uses the marker information to open a new fence or test whether the current fence should close.

*Call graph*: called by 1 (advance).


##### `is_markdown_fence_info`  (lines 219–225)

```
fn is_markdown_fence_info(trimmed_line: &str, marker_len: usize) -> bool
```

**Purpose**: Decides whether the language label after a fence marker means the fenced content is Markdown. It accepts `md` and `markdown`, ignoring letter case.

**Data flow**: It receives the trimmed fence line and the length of the marker at the start. It reads the first word after the marker and compares it with Markdown labels, returning true for Markdown and false otherwise.

**Call relations**: `FenceTracker::advance` calls this only when it has found a new opening fence. The result becomes the stored `FenceKind`, which later tells table detection whether pipes inside the fence may still matter.

*Call graph*: called by 1 (advance).


##### `strip_blockquote_prefix`  (lines 232–240)

```
fn strip_blockquote_prefix(line: &str) -> &str
```

**Purpose**: Removes leading Markdown blockquote markers, the `>` characters used for quoted text. This lets table and fence detection work inside blockquotes as well as in normal text.

**Data flow**: It receives a line, trims leading spaces, repeatedly removes a leading `>` plus an optional following space, and returns the remaining text slice. The original text is not copied.

**Call relations**: Fence tracking calls this before looking for code fences, and table candidate detection calls it before looking for table syntax. It gives both callers a clean view of the line’s real Markdown content.

*Call graph*: called by 2 (table_candidate_text, advance).


##### `tests::parse_table_segments_basic`  (lines 247–252)

```
fn parse_table_segments_basic()
```

**Purpose**: Verifies that a normal pipe table row with leading and trailing pipes is split into clean cell names.

**Data flow**: It supplies `| A | B | C |` to `parse_table_segments` and checks that the result is three trimmed segments. Nothing outside the test is changed.

**Call relations**: The Rust test runner calls this during automated tests. It protects the basic behavior that higher-level header and delimiter checks depend on.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::parse_table_segments_no_outer_pipes`  (lines 255–257)

```
fn parse_table_segments_no_outer_pipes()
```

**Purpose**: Checks that table-like rows can be recognized even without a pipe at either edge.

**Data flow**: It sends `A | B | C` into the parser and expects three cells back. The test passes only if inner pipes are enough to form segments.

**Call relations**: The test runner executes this to keep the parser compatible with Markdown table styles that omit outer border pipes.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::parse_table_segments_no_leading_pipe`  (lines 260–265)

```
fn parse_table_segments_no_leading_pipe()
```

**Purpose**: Confirms that a row with a trailing pipe but no leading pipe is still accepted as table-shaped.

**Data flow**: It passes `A | B | C |` to `parse_table_segments` and checks for the three expected trimmed segments.

**Call relations**: This test supports the shared parsing rule used by both streaming detection and Markdown cleanup.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::parse_table_segments_no_trailing_pipe`  (lines 268–273)

```
fn parse_table_segments_no_trailing_pipe()
```

**Purpose**: Confirms that a row with a leading pipe but no trailing pipe is still accepted as table-shaped.

**Data flow**: It gives `| A | B | C` to `parse_table_segments` and expects the same three cell values. It only observes the parser result.

**Call relations**: The test runner uses this to guard a common Markdown table variation.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::parse_table_segments_single_segment_is_allowed`  (lines 276–278)

```
fn parse_table_segments_single_segment_is_allowed()
```

**Purpose**: Checks that a line enclosed in outer pipes can produce a single table segment. This matters because the presence of outer pipes is still structural information.

**Data flow**: It passes `| only |` to `parse_table_segments` and expects one segment, `only`.

**Call relations**: This test documents an intentional parser choice so future changes do not reject single-column table rows.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::parse_table_segments_without_pipe_returns_none`  (lines 281–283)

```
fn parse_table_segments_without_pipe_returns_none()
```

**Purpose**: Verifies that ordinary text with no pipe separator is not treated as a table line.

**Data flow**: It sends `just text` to `parse_table_segments` and expects no result.

**Call relations**: The test runner uses this to protect against false table detection in normal prose.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::parse_table_segments_empty_returns_none`  (lines 286–289)

```
fn parse_table_segments_empty_returns_none()
```

**Purpose**: Verifies that empty or whitespace-only lines are not considered table rows.

**Data flow**: It passes an empty string and a spaces-only string to `parse_table_segments` and expects no result from both.

**Call relations**: This keeps blank lines from confusing the streaming table scanner.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::parse_table_segments_escaped_pipe`  (lines 292–298)

```
fn parse_table_segments_escaped_pipe()
```

**Purpose**: Checks that an escaped pipe stays inside a cell instead of becoming a column break.

**Data flow**: It passes a row containing `\|` and expects that text to remain in the first segment, with only the unescaped pipe splitting the row.

**Call relations**: The test runner uses this to protect the distinction between literal pipe text and table separators.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::is_table_delimiter_segment_valid`  (lines 301–307)

```
fn is_table_delimiter_segment_valid()
```

**Purpose**: Verifies the accepted forms of one Markdown delimiter cell, including optional alignment colons.

**Data flow**: It checks several dash-and-colon strings and expects each one to be accepted as valid.

**Call relations**: This test protects the small rule that whole delimiter-line detection depends on.

*Call graph*: 1 external calls (assert!).


##### `tests::is_table_delimiter_segment_invalid`  (lines 310–315)

```
fn is_table_delimiter_segment_invalid()
```

**Purpose**: Verifies that empty text, too few dashes, and non-dash text are rejected as delimiter cells.

**Data flow**: It checks invalid strings and expects each one to fail the delimiter-segment test.

**Call relations**: The test runner uses this to prevent loose delimiter matching that could turn ordinary text into tables.

*Call graph*: 1 external calls (assert!).


##### `tests::is_table_delimiter_line_valid`  (lines 318–322)

```
fn is_table_delimiter_line_valid()
```

**Purpose**: Checks that complete delimiter rows are accepted in several common Markdown styles.

**Data flow**: It gives valid delimiter lines to `is_table_delimiter_line` and expects true each time.

**Call relations**: This test supports the scanner’s ability to confirm a table when a header is followed by a valid dash row.

*Call graph*: 1 external calls (assert!).


##### `tests::is_table_delimiter_line_invalid`  (lines 325–328)

```
fn is_table_delimiter_line_invalid()
```

**Purpose**: Checks that non-delimiter rows and rows with too few dashes are rejected.

**Data flow**: It passes invalid lines to `is_table_delimiter_line` and expects false.

**Call relations**: The test runner uses this to guard against false positives in table detection.

*Call graph*: 1 external calls (assert!).


##### `tests::is_table_header_line_valid`  (lines 331–334)

```
fn is_table_header_line_valid()
```

**Purpose**: Verifies that common table header rows are recognized with or without outer pipes.

**Data flow**: It passes header-like lines to `is_table_header_line` and expects true.

**Call relations**: This test protects the first step in the two-line table recognition process.

*Call graph*: 1 external calls (assert!).


##### `tests::is_table_header_line_all_empty_segments`  (lines 337–339)

```
fn is_table_header_line_all_empty_segments()
```

**Purpose**: Checks that a row of empty cells is not accepted as a table header.

**Data flow**: It passes `| | |` to `is_table_header_line` and expects false because no cell contains real content.

**Call relations**: This prevents empty-looking separator lines from being treated as meaningful table headers.

*Call graph*: 1 external calls (assert!).


##### `tests::fence_tracker_outside_by_default`  (lines 346–349)

```
fn fence_tracker_outside_by_default()
```

**Purpose**: Confirms that a new fence tracker starts outside any fenced code block.

**Data flow**: It creates a tracker with `FenceTracker::new` and checks that `kind` reports `Outside`.

**Call relations**: The test runner calls this to protect the initial state used before line scanning begins.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `tests::fence_tracker_opens_and_closes_backtick_fence`  (lines 352–362)

```
fn fence_tracker_opens_and_closes_backtick_fence()
```

**Purpose**: Verifies that backtick fences open, remain active across content lines, and close with a matching marker.

**Data flow**: It advances a tracker through an opening Rust fence, a code line, and a closing fence, checking the reported kind after each step.

**Call relations**: This test exercises the main state transitions used when streaming source text contains non-Markdown code.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `tests::fence_tracker_opens_and_closes_tilde_fence`  (lines 365–371)

```
fn fence_tracker_opens_and_closes_tilde_fence()
```

**Purpose**: Verifies that tilde fences work the same way as backtick fences.

**Data flow**: It advances through `~~~python` and then `~~~`, expecting the tracker to enter `Other` and then return to `Outside`.

**Call relations**: The test runner uses this to keep support for both Markdown fence marker styles.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `tests::fence_tracker_markdown_fence`  (lines 374–382)

```
fn fence_tracker_markdown_fence()
```

**Purpose**: Checks that a fence labeled `md` is treated as Markdown content, not ordinary code.

**Data flow**: It opens an `md` fence, advances through a table-like line, and then closes the fence, checking that the kind is `Markdown` until closure.

**Call relations**: This protects the behavior that lets table detection still consider pipes inside Markdown fences.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `tests::fence_tracker_markdown_case_insensitive`  (lines 385–391)

```
fn fence_tracker_markdown_case_insensitive()
```

**Purpose**: Verifies that Markdown fence labels are recognized regardless of letter case.

**Data flow**: It opens a fence labeled `Markdown`, checks for `Markdown` kind, then closes it and checks for `Outside`.

**Call relations**: The test runner uses this to make fence detection forgiving in the same way users usually expect Markdown labels to be.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `tests::fence_tracker_nested_shorter_marker_does_not_close`  (lines 394–404)

```
fn fence_tracker_nested_shorter_marker_does_not_close()
```

**Purpose**: Checks that a fence opened with a longer marker is not closed by a shorter marker inside it.

**Data flow**: It opens with four backticks, advances over three backticks, and confirms the fence remains open until four backticks appear.

**Call relations**: This test protects correct Markdown fence matching, which depends on closing markers being at least as long as the opener.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `tests::fence_tracker_mismatched_char_does_not_close`  (lines 407–416)

```
fn fence_tracker_mismatched_char_does_not_close()
```

**Purpose**: Verifies that a tilde marker cannot close a backtick fence.

**Data flow**: It opens a backtick fence, advances over a tilde marker, confirms the fence remains open, then closes with backticks.

**Call relations**: The test runner uses this to guard the rule that opening and closing fence characters must match.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `tests::fence_tracker_indented_4_spaces_ignored`  (lines 419–423)

```
fn fence_tracker_indented_4_spaces_ignored()
```

**Purpose**: Checks that a fence-like line indented by four spaces is ignored as a fence marker.

**Data flow**: It advances a fresh tracker with an indented backtick line and expects the tracker to remain `Outside`.

**Call relations**: This protects the Markdown rule that four-space indentation means an indented code block, not a fenced code block opener.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `tests::fence_tracker_blockquote_prefix_stripped`  (lines 426–432)

```
fn fence_tracker_blockquote_prefix_stripped()
```

**Purpose**: Verifies that fences inside blockquotes are still recognized.

**Data flow**: It advances through quoted opening and closing fence lines, checking that the tracker enters `Other` and then returns to `Outside`.

**Call relations**: This test confirms that `FenceTracker::advance` uses blockquote stripping before fence detection.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `tests::fence_tracker_close_with_trailing_content_does_not_close`  (lines 435–444)

```
fn fence_tracker_close_with_trailing_content_does_not_close()
```

**Purpose**: Checks that a closing fence marker with extra text after it does not close the current fence.

**Data flow**: It opens a fence, advances over a marker followed by extra text and expects the fence to stay open, then advances over a clean marker and expects closure.

**Call relations**: The test runner uses this to protect the closing rule used by the streaming scanner.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `tests::parse_fence_marker_backtick`  (lines 451–454)

```
fn parse_fence_marker_backtick()
```

**Purpose**: Verifies that backtick fence markers of three or more characters are recognized and counted.

**Data flow**: It passes backtick marker lines to `parse_fence_marker` and checks that the returned marker character and length are correct.

**Call relations**: This test protects the helper that `FenceTracker::advance` relies on before opening or closing fences.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::parse_fence_marker_tilde`  (lines 457–459)

```
fn parse_fence_marker_tilde()
```

**Purpose**: Verifies that tilde fence markers are recognized.

**Data flow**: It passes a tilde fence line and expects `parse_fence_marker` to return the tilde character and marker length.

**Call relations**: The test runner uses this to keep tilde fence support aligned with backtick support.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::parse_fence_marker_too_short`  (lines 462–465)

```
fn parse_fence_marker_too_short()
```

**Purpose**: Checks that one- or two-character marker runs are not accepted as fences.

**Data flow**: It passes two-backtick and two-tilde strings and expects no marker result.

**Call relations**: This protects the Markdown requirement that fenced code blocks start with at least three marker characters.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::parse_fence_marker_not_fence`  (lines 468–471)

```
fn parse_fence_marker_not_fence()
```

**Purpose**: Checks that ordinary text and empty text are not mistaken for fence markers.

**Data flow**: It passes `hello` and an empty string to `parse_fence_marker` and expects no result.

**Call relations**: The test runner uses this to prevent false fence transitions during line scanning.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::is_markdown_fence_info_basic`  (lines 474–480)

```
fn is_markdown_fence_info_basic()
```

**Purpose**: Verifies which fence language labels count as Markdown.

**Data flow**: It checks `md`, `markdown`, and uppercase `MD` as accepted labels, and checks Rust or no label as rejected.

**Call relations**: This test protects the helper that decides whether a newly opened fence should be classified as `Markdown` or `Other`.

*Call graph*: 1 external calls (assert!).


##### `tests::strip_blockquote_prefix_basic`  (lines 483–487)

```
fn strip_blockquote_prefix_basic()
```

**Purpose**: Verifies that leading blockquote markers are removed, including nested quote markers.

**Data flow**: It passes quoted and unquoted lines to `strip_blockquote_prefix` and checks the remaining text.

**Call relations**: The test runner uses this to protect the shared cleanup step used before both table and fence detection.

*Call graph*: 1 external calls (assert_eq!).


### `tui/src/mention_codec.rs`

`domain_logic` · `history save/load`

The TUI needs to remember more than the words a user typed. If a user mentions a tool by writing `$figma` or a plugin by writing `@sample`, the history must keep the real target path too, such as `app://figma-1` or `plugin://sample@test`. This file is the translator between those two forms. Think of it like saving a contact in your phone: you see “Mom”, but the phone stores the actual number as well.

When saving history, `encode_history_mentions` scans the visible text and replaces known mentions with Markdown-style links like `[$figma](app://figma-1)`. It is careful not to turn random text into a mention. For example, it avoids embedded `@` text inside an email address or package name, and it keeps repeated mentions matched to their saved paths in order.

When loading history, `decode_history_mentions_with_at_mentions` does the reverse. It finds those stored links, restores the visible `$name` or `@name` text, and returns a list of `LinkedMention` records containing the hidden paths. The code also protects common shell variables like `$PATH` from being mistaken for tool mentions, and it supports older history where plugin mentions used `$` instead of `@`.

#### Function details

##### `encode_history_mentions`  (lines 21–89)

```
fn encode_history_mentions(text: &str, mentions: &[LinkedMention]) -> String
```

**Purpose**: This turns visible mentions in user text into saved links that include the real destination path. It is used before storing history so later sessions can recover exactly which tool or plugin was meant.

**Data flow**: It receives plain text plus a list of known linked mentions. It groups those mentions by their visible token, scans the text from left to right, and when it finds a matching `$name` or `@name` in a safe place, it replaces it with a link like `[$name](path)`. It returns the encoded string and does not change the input list.

**Call relations**: In the bigger flow, this is the save-side translator. The tests call it with many edge cases, and inside it asks small boundary-checking helpers such as `starts_plaintext_mention`, `ends_plaintext_mention`, and `is_mention_name_char` to decide whether text really is a mention before writing a link.

*Call graph*: calls 3 internal fn (ends_plaintext_mention, is_mention_name_char, starts_plaintext_mention); called by 9 (encode_history_mentions_does_not_let_at_token_steal_later_tool_binding, encode_history_mentions_links_at_mentions_after_unicode_whitespace, encode_history_mentions_links_both_sigils_for_same_name, encode_history_mentions_links_bound_mentions_in_order, encode_history_mentions_links_dollar_mentions_after_punctuation, encode_history_mentions_links_parenthesized_at_mentions, encode_history_mentions_links_sentence_ending_at_mentions, encode_history_mentions_preserves_at_sigils, encode_history_mentions_skips_embedded_at_substrings); 4 external calls (new, with_capacity, matches!, is_empty).


##### `decode_history_mentions_with_at_mentions`  (lines 91–127)

```
fn decode_history_mentions_with_at_mentions(
    text: &str,
    at_mentions_enabled: bool,
) -> DecodedHistoryText
```

**Purpose**: This reads stored history text and restores the simple mention text users expect to see. At the same time, it rebuilds the list of hidden mention targets.

**Data flow**: It receives encoded history text and a flag saying whether `@` mentions are enabled. It scans for link-shaped text, asks `parse_history_linked_mention` whether each link is a real supported mention, writes the visible token back into the output text, and collects each mention's sigil, name, and path. It returns a `DecodedHistoryText` containing both the visible text and the recovered mention list.

**Call relations**: This is the load-side translator. It is called by `new_with_at_mentions` when history is being reconstructed, and the tests call it to prove both modern `@` behavior and older fallback behavior work.

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

**Purpose**: This decides whether a link found in history is one of this app's saved mentions. It also decides which visible sigil, `$` or `@`, should be restored.

**Data flow**: It receives the full text, its bytes, the starting position of a possible link, and the `@`-mentions setting. It tries to parse `$` and sometimes `@` linked mentions, rejects common environment variable names, checks that the path points to a known tool/plugin style location, and returns the restored sigil, name, path, and ending position when the link is valid.

**Call relations**: It sits between the broad decoder and the low-level link parser. `decode_history_mentions_with_at_mentions` asks it about each possible link, and it hands detailed parsing to `parse_linked_tool_mention` while using `is_common_env_var` and `is_tool_path` as safety filters.

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

**Purpose**: This parses the exact stored shape of one mention link, such as `[$figma](app://figma-1)`. It only checks the syntax and extracts the name and path.

**Data flow**: It receives the text, its byte view, a starting index, and the expected sigil. It verifies the text starts with `[`, then the sigil, then a valid name, then `]`, optional spaces, and a parenthesized path. If all parts are present and the path is not empty, it returns the name, path, and where the link ends.

**Call relations**: This is the careful reader used by `parse_history_linked_mention`. It does not decide whether a path is meaningful; it only extracts the pieces so the caller can apply higher-level rules.

*Call graph*: calls 1 internal fn (is_mention_name_char); called by 1 (parse_history_linked_mention).


##### `is_mention_name_char`  (lines 221–223)

```
fn is_mention_name_char(byte: u8) -> bool
```

**Purpose**: This answers whether one byte can be part of a mention name. Mention names here are limited to letters, numbers, underscores, and hyphens.

**Data flow**: It receives a single byte and checks it against the allowed ASCII characters. It returns `true` if the byte can be part of a mention name, otherwise `false`.

**Call relations**: Both the encoder and the low-level parser use this while walking through text. It is the shared rule that keeps mention-name recognition consistent in saved and loaded history.

*Call graph*: called by 2 (encode_history_mentions, parse_linked_tool_mention); 1 external calls (matches!).


##### `starts_plaintext_mention`  (lines 225–233)

```
fn starts_plaintext_mention(text: &str, index: usize) -> bool
```

**Purpose**: This checks whether an `@` mention starts in a reasonable place in normal text. It prevents the encoder from treating the middle of an email address or another word as a mention.

**Data flow**: It receives the full text and the index of a possible mention sigil. If the sigil is at the start of the text, it accepts it. Otherwise it looks at the previous character and returns `true` only when that previous character is whitespace or not a mention-name character.

**Call relations**: The encoder calls this before linking `@` mentions. It is part of the guardrail system that keeps ordinary text such as `foo@sample.com` from being rewritten.

*Call graph*: called by 1 (encode_history_mentions).


##### `ends_plaintext_mention`  (lines 235–248)

```
fn ends_plaintext_mention(text_bytes: &[u8], index: usize) -> bool
```

**Purpose**: This checks where a plain text mention is allowed to end. It lets mentions end before punctuation or whitespace while still allowing useful suffixes like paths to remain outside the link.

**Data flow**: It receives the byte slice of the text and the index just after a detected mention name. It looks at the next byte, if any, and decides whether that byte is a safe boundary. It returns `true` when the mention can stop there.

**Call relations**: The encoder uses this when deciding whether an `@` token should become a stored link. Together with `starts_plaintext_mention`, it keeps link creation precise rather than grabbing too much or too little text.

*Call graph*: called by 1 (encode_history_mentions).


##### `is_mention_name_char_char`  (lines 250–252)

```
fn is_mention_name_char_char(ch: char) -> bool
```

**Purpose**: This is the character-based version of the mention-name check. It is useful when the code is looking at Rust characters instead of raw bytes.

**Data flow**: It receives one character, checks whether it is an ASCII letter, digit, underscore, or hyphen, and returns a yes/no answer.

**Call relations**: It supports the plain-text boundary logic around mentions. It mirrors `is_mention_name_char`, but works at the character level so non-ASCII whitespace can still be handled safely.

*Call graph*: 1 external calls (matches!).


##### `is_common_env_var`  (lines 254–270)

```
fn is_common_env_var(name: &str) -> bool
```

**Purpose**: This prevents common shell variables like `$PATH` and `$HOME` from being mistaken for tool mentions. That matters because users may type normal command-line text into the TUI.

**Data flow**: It receives a name, converts it to uppercase, compares it with a fixed set of common environment variable names, and returns `true` if it matches one of them.

**Call relations**: `parse_history_linked_mention` uses this as a safety check while decoding stored links. If a link name looks like a common environment variable, the decoder refuses to treat it as a tool mention.

*Call graph*: called by 1 (parse_history_linked_mention); 1 external calls (matches!).


##### `is_tool_path`  (lines 272–281)

```
fn is_tool_path(path: &str) -> bool
```

**Purpose**: This decides whether a stored path looks like a real tool, plugin, app, MCP server, or skill target. It keeps the decoder from accepting arbitrary Markdown links as mentions.

**Data flow**: It receives a path string and checks for known prefixes such as `app://`, `mcp://`, `plugin://`, and `skill://`. It also accepts paths whose final file name is `SKILL.md`. It returns `true` only for those recognized forms.

**Call relations**: `parse_history_linked_mention` calls this after a link has been syntactically parsed. This helper supplies the final “is this one of ours?” decision for modern tool-style paths.

*Call graph*: called by 1 (parse_history_linked_mention).


##### `tests::decode_history_mentions_restores_visible_tokens`  (lines 289–315)

```
fn decode_history_mentions_restores_visible_tokens()
```

**Purpose**: This test proves that stored `$` mention links are turned back into visible `$name` text and linked mention records. It covers app, plugin, and skill-file paths.

**Data flow**: It feeds encoded history containing three linked mentions into the decoder. It then checks that the visible output text is simple and that the recovered mention list preserves each sigil, name, and path.

**Call relations**: During the test run, this calls `decode_history_mentions_with_at_mentions`. It confirms the main load-side path works for the common historical `$` form.

*Call graph*: calls 1 internal fn (decode_history_mentions_with_at_mentions); 1 external calls (assert_eq!).


##### `tests::decode_history_mentions_restores_plugin_links_with_at_sigil`  (lines 318–339)

```
fn decode_history_mentions_restores_plugin_links_with_at_sigil()
```

**Purpose**: This test checks that modern `@` plugin mentions are restored as `@name` when `@` mentions are enabled. It also confirms `$` tool mentions still work beside them.

**Data flow**: It sends encoded text with both an `@sample` plugin link and a `$figma` app link into the decoder. It expects the visible text and recovered mention list to keep the correct separate sigils.

**Call relations**: This test calls `decode_history_mentions_with_at_mentions` with the feature enabled. It protects the newer `@` mention behavior from accidentally being collapsed back into `$`.

*Call graph*: calls 1 internal fn (decode_history_mentions_with_at_mentions); 1 external calls (assert_eq!).


##### `tests::decode_history_mentions_without_at_mentions_uses_legacy_plugin_fallback`  (lines 342–363)

```
fn decode_history_mentions_without_at_mentions_uses_legacy_plugin_fallback()
```

**Purpose**: This test verifies compatibility when `@` mentions are not enabled. In that mode, plugin links written with `@` are restored as older `$` mentions.

**Data flow**: It gives the decoder encoded text containing an `@` plugin link and a `$` app link while the setting is off. It expects both visible mentions and both recovered records to use `$`.

**Call relations**: This calls `decode_history_mentions_with_at_mentions` in legacy mode. It ensures old UI behavior still understands plugin links stored with the newer shape.

*Call graph*: calls 1 internal fn (decode_history_mentions_with_at_mentions); 1 external calls (assert_eq!).


##### `tests::decode_history_mentions_without_at_mentions_ignores_at_non_plugin_paths`  (lines 366–374)

```
fn decode_history_mentions_without_at_mentions_ignores_at_non_plugin_paths()
```

**Purpose**: This test makes sure legacy mode does not accept every `@` link as a mention. Only plugin paths get the special fallback.

**Data flow**: It passes an encoded `@figma` link whose path is an app path, with `@` mentions disabled. It expects the text to remain unchanged and the recovered mention list to be empty.

**Call relations**: This test calls `decode_history_mentions_with_at_mentions` to check the decoder's rejection path. It guards against accidentally turning unsupported `@` links into `$` mentions.

*Call graph*: calls 1 internal fn (decode_history_mentions_with_at_mentions); 1 external calls (assert_eq!).


##### `tests::decode_history_mentions_restores_at_sigil_for_tool_paths`  (lines 377–392)

```
fn decode_history_mentions_restores_at_sigil_for_tool_paths()
```

**Purpose**: This test confirms that, when `@` mentions are enabled, an `@` mention can point to a normal tool path and still be restored as `@`. It protects the unified mention behavior.

**Data flow**: It gives the decoder a stored `[@figma](app://figma-1)` link with `@` support enabled. It expects visible text `@figma` and a matching linked mention record.

**Call relations**: This calls `decode_history_mentions_with_at_mentions`. It checks the path where `parse_history_linked_mention` accepts `@` for recognized tool paths.

*Call graph*: calls 1 internal fn (decode_history_mentions_with_at_mentions); 1 external calls (assert_eq!).


##### `tests::encode_history_mentions_links_bound_mentions_in_order`  (lines 395–421)

```
fn encode_history_mentions_links_bound_mentions_in_order()
```

**Purpose**: This test proves repeated visible mentions are linked to their saved paths in the same order they appear. That matters when the same name can refer to more than one target.

**Data flow**: It supplies text containing `$figma`, `$sample`, `$figma`, and an unmatched `$other`, plus three linked mention records. It expects the first three matching mentions to become links and `$other` to stay plain.

**Call relations**: This test calls `encode_history_mentions`. It verifies the encoder's queue-like matching behavior for repeated mention names.

*Call graph*: calls 1 internal fn (encode_history_mentions); 1 external calls (assert_eq!).


##### `tests::encode_history_mentions_links_dollar_mentions_after_punctuation`  (lines 424–434)

```
fn encode_history_mentions_links_dollar_mentions_after_punctuation()
```

**Purpose**: This test checks that a `$` mention can be linked even when it appears after punctuation, such as inside parentheses. Users often write mentions this way in normal sentences.

**Data flow**: It gives the encoder the text `($figma)` and a matching linked mention. It expects only `$figma` to become a saved link, leaving the parentheses around it.

**Call relations**: This test calls `encode_history_mentions`. It protects the encoder's ability to find mentions that are not separated only by spaces.

*Call graph*: calls 1 internal fn (encode_history_mentions); 1 external calls (assert_eq!).


##### `tests::encode_history_mentions_links_dollar_mentions_with_path_like_suffixes`  (lines 437–456)

```
fn encode_history_mentions_links_dollar_mentions_with_path_like_suffixes()
```

**Purpose**: This test checks that `$` mentions can be linked while suffixes like `/docs`, `.suffix`, or `\docs` remain visible after the link. This lets users refer to something inside or beside a mentioned tool target.

**Data flow**: It builds one `$figma` linked mention and checks several strings where extra path-like text follows the mention. The expected result is a link around `$figma` only, with the suffix left outside.

**Call relations**: During the test run, it exercises the encoder behavior for mention endings. It protects the boundary rules used by `encode_history_mentions` from swallowing path-like suffixes.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::encode_history_mentions_preserves_at_sigils`  (lines 459–480)

```
fn encode_history_mentions_preserves_at_sigils()
```

**Purpose**: This test confirms that `@` mentions stay `@` when they are encoded. It matters because `$` and `@` can mean different kinds of mentions to the user.

**Data flow**: It gives the encoder text containing two `@` mentions and one unrelated `$other`. It expects the two known `@` mentions to become `[@name](path)` links and the unrelated token to remain plain.

**Call relations**: This test calls `encode_history_mentions`. It guards against accidentally converting modern `@` mentions into older `$`-style links.

*Call graph*: calls 1 internal fn (encode_history_mentions); 1 external calls (assert_eq!).


##### `tests::encode_history_mentions_links_both_sigils_for_same_name`  (lines 483–504)

```
fn encode_history_mentions_links_both_sigils_for_same_name()
```

**Purpose**: This test proves `$figma` and `@figma` are treated as different visible tokens even though the name is the same. That prevents one mention type from stealing the other's path.

**Data flow**: It supplies text with `@figma` followed by `$figma`, plus one linked mention for each sigil. It expects each token to be linked to its own path.

**Call relations**: This test calls `encode_history_mentions`. It checks that the encoder groups mention records by both sigil and name, not by name alone.

*Call graph*: calls 1 internal fn (encode_history_mentions); 1 external calls (assert_eq!).


##### `tests::encode_history_mentions_does_not_let_at_token_steal_later_tool_binding`  (lines 507–518)

```
fn encode_history_mentions_does_not_let_at_token_steal_later_tool_binding()
```

**Purpose**: This test ensures an unmatched `@figma` does not consume a later `$figma` binding. Without this, the wrong visible token could get linked and the intended one would be left plain.

**Data flow**: It gives the encoder text containing `@figma` then `$figma`, but provides only a `$figma` linked mention. It expects `@figma` to stay plain and `$figma` to become the link.

**Call relations**: This test calls `encode_history_mentions`. It protects the encoder's sigil-aware matching rule.

*Call graph*: calls 1 internal fn (encode_history_mentions); 1 external calls (assert_eq!).


##### `tests::encode_history_mentions_links_at_mentions_after_unicode_whitespace`  (lines 521–533)

```
fn encode_history_mentions_links_at_mentions_after_unicode_whitespace()
```

**Purpose**: This test checks that `@` mentions still work after non-English or non-ASCII whitespace, such as a full-width space. That helps the TUI behave correctly for international text.

**Data flow**: It gives the encoder text where `@sample` follows a full-width space and supplies a matching plugin mention. It expects the mention to be linked while the surrounding text stays unchanged.

**Call relations**: This test calls `encode_history_mentions`. It specifically exercises the start-boundary logic used by `starts_plaintext_mention`.

*Call graph*: calls 1 internal fn (encode_history_mentions); 1 external calls (assert_eq!).


##### `tests::encode_history_mentions_links_sentence_ending_at_mentions`  (lines 536–547)

```
fn encode_history_mentions_links_sentence_ending_at_mentions()
```

**Purpose**: This test confirms an `@` mention at the end of a sentence can be linked without absorbing the final period. It keeps normal punctuation readable.

**Data flow**: It passes text ending with `@figma.` and a matching linked mention. It expects the link around `@figma` and the period after the link.

**Call relations**: This test calls `encode_history_mentions`. It checks the mention-ending logic supplied by `ends_plaintext_mention`.

*Call graph*: calls 1 internal fn (encode_history_mentions); 1 external calls (assert_eq!).


##### `tests::encode_history_mentions_links_parenthesized_at_mentions`  (lines 550–561)

```
fn encode_history_mentions_links_parenthesized_at_mentions()
```

**Purpose**: This test checks that `@` mentions inside parentheses are recognized. Parentheses should be treated as surrounding punctuation, not as part of the mention.

**Data flow**: It passes text containing `(@figma)` and a matching plugin mention. It expects only `@figma` to become a link, with both parentheses preserved.

**Call relations**: This test calls `encode_history_mentions`. It protects the start and end boundary checks for punctuation-wrapped `@` mentions.

*Call graph*: calls 1 internal fn (encode_history_mentions); 1 external calls (assert_eq!).


##### `tests::encode_history_mentions_skips_embedded_at_substrings`  (lines 564–578)

```
fn encode_history_mentions_skips_embedded_at_substrings()
```

**Purpose**: This test makes sure the encoder does not link `@sample` when it appears inside an email-like string or package path. It should only link the standalone mention.

**Data flow**: It gives the encoder text containing `foo@sample.com`, `@sample/pkg`, and finally a standalone `@sample`, with one matching linked mention. It expects only the standalone final mention to become a link.

**Call relations**: This test calls `encode_history_mentions`. It guards the plain-text boundary rules that prevent accidental links in ordinary technical text.

*Call graph*: calls 1 internal fn (encode_history_mentions); 1 external calls (assert_eq!).


### Citation extraction
This specialized parser turns hidden citation markup into structured memory citation data for downstream use.

### `memories/read/src/citations.rs`

`domain_logic` · `memory citation parsing during response/request handling`

When the system reads back memories, some responses may include citation markup: small tagged blocks that say where a memory came from and which prior threads or rollouts are connected to it. This file is the parser for that markup. Without it, those citations would remain as raw strings, so later code could not reliably show sources, count usage, or connect a memory back to earlier conversations.

The main parser, parse_memory_citation, looks through a list of citation strings. For each string, it searches for a <citation_entries> block. Lines inside that block are expected to look like a file path and line range, followed by a note. Each valid line becomes a MemoryCitationEntry. The parser also searches for rollout IDs, accepting both the newer <rollout_ids> tag and the older <thread_ids> tag. It removes duplicate IDs while keeping their first-seen order, like a guest list that does not let the same name sign in twice.

If nothing useful is found, the parser returns None instead of an empty citation. That tells callers there was no real citation data. A separate helper, thread_ids_from_memory_citation, tries to turn stored rollout ID strings into ThreadId values, quietly skipping any strings that are not valid IDs.

#### Function details

##### `parse_memory_citation`  (lines 6–43)

```
fn parse_memory_citation(citations: Vec<String>) -> Option<MemoryCitation>
```

**Purpose**: This is the main entry point for turning raw citation markup into a MemoryCitation object. It extracts source entries and rollout/thread IDs, removes duplicate IDs, and returns nothing if the input contains no usable citation data.

**Data flow**: It receives a list of citation strings. For each string, it reads any <citation_entries> block and turns valid lines into structured citation entries, then reads any rollout or thread ID block and keeps each ID only once. It returns Some(MemoryCitation) containing the collected entries and IDs, or None if both collections are empty.

**Call relations**: This function is called when stage-one output usage is recorded and when hidden assistant markup is stripped while parsing memory citations. Inside that flow, it asks extract_block to find citation-entry text and extract_ids_block to find ID text, then packages the parsed results for the callers that need memory-source information.

*Call graph*: calls 2 internal fn (extract_block, extract_ids_block); called by 2 (record_stage1_output_usage_and_detect_memory_citation, strip_hidden_assistant_markup_and_parse_memory_citation); 2 external calls (new, new).


##### `thread_ids_from_memory_citation`  (lines 45–51)

```
fn thread_ids_from_memory_citation(memory_citation: &MemoryCitation) -> Vec<ThreadId>
```

**Purpose**: This function turns the citation’s stored rollout ID strings into ThreadId values, which are the system’s typed representation of conversation or thread identifiers. It is useful when later code needs real thread IDs rather than plain text.

**Data flow**: It receives a MemoryCitation and reads its rollout_ids list. It tries to convert each string into a ThreadId and drops any string that does not pass that conversion. It returns a list of valid ThreadId values and does not change the original citation.

**Call relations**: This is called when recording output usage for a memory citation. At that point, the citation has already been parsed, and this helper provides the caller with only the IDs that are safe to use as ThreadId values.

*Call graph*: called by 1 (record_stage1_output_usage_for_memory_citation).


##### `parse_memory_citation_entry`  (lines 53–70)

```
fn parse_memory_citation_entry(line: &str) -> Option<MemoryCitationEntry>
```

**Purpose**: This helper parses one line from a citation-entry block into a MemoryCitationEntry. It expects the line to name a path, a line range, and a note explaining the citation.

**Data flow**: It receives one text line. It trims blank space, rejects empty or malformed lines, splits out the note, then splits the location into a path and start/end line numbers. If every part is present and the line numbers can be parsed, it returns a MemoryCitationEntry; otherwise it returns None.

**Call relations**: It works as the line-by-line parser used by the main citation parser. parse_memory_citation feeds it each line from a citation-entry block so that only well-formed citation lines become structured entries.


##### `extract_block`  (lines 72–76)

```
fn extract_block(text: &'a str, open: &str, close: &str) -> Option<&'a str>
```

**Purpose**: This small helper pulls out the text between an opening tag and a closing tag. It is a reusable way to say, “give me the contents inside this marked section.”

**Data flow**: It receives a larger text string plus the exact opening and closing marker strings to look for. It finds the first opening marker, then the first closing marker after it, and returns the text between them. If either marker is missing, it returns None.

**Call relations**: parse_memory_citation uses it directly to read citation-entry blocks. extract_ids_block also uses it to look for ID blocks, so this helper is the shared low-level tool for reading the tagged citation format.

*Call graph*: called by 2 (extract_ids_block, parse_memory_citation).


##### `extract_ids_block`  (lines 78–81)

```
fn extract_ids_block(text: &str) -> Option<&str>
```

**Purpose**: This helper finds the block of rollout or thread IDs inside a citation string. It supports both the current <rollout_ids> tag and the older <thread_ids> tag.

**Data flow**: It receives a citation text string. It first tries to extract text between <rollout_ids> and </rollout_ids>; if that is not present, it tries <thread_ids> and </thread_ids>. It returns the matching block text, or None if neither form exists.

**Call relations**: parse_memory_citation calls this when it is collecting IDs from each citation string. This helper delegates the actual tag search to extract_block, which keeps the tag-reading logic in one place.

*Call graph*: calls 1 internal fn (extract_block); called by 1 (parse_memory_citation).
