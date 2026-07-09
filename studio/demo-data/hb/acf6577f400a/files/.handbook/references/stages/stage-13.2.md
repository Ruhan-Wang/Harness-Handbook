# Streaming reduction and UI projection  `stage-13.2`

This stage is the live “make it readable” part of the main work loop. As the assistant, tools, and server send small events, it turns them into clean text, stable transcript entries, and status messages the user can understand. The stream parsers strip hidden citation, plan, and Git-action markers from assistant text while saving their structured meaning. Markdown streaming and table holdback delay unsafe fragments, especially half-built tables, until they can be rendered without flicker or bad wrapping. Markdown, syntax highlighting, diff rendering, and table conversion then turn text, code, and file changes into styled terminal lines.

The streaming controller, chunking, and commit-tick code decide when queued text becomes permanent history and when it stays as a live tail. History-cell and exec-cell files define the many transcript “cards”: user and assistant messages, plans, approvals, searches, tool calls, notices, patches, hooks, commands, and MCP activity. Chat-widget files keep the active turn, command lifecycle, hooks, user drafts, status line, token usage, and live assistant output in sync. Resize and consolidation code rebuild final transcript state safely, while API and watcher helpers translate rate limits, process output, and other low-level events into user-facing updates.

## Files in this stage

### Streaming parse and markdown pipeline
These files define how incremental assistant output is parsed, buffered, rendered as markdown, and safely held back until stable enough to expose.

### `utils/stream-parser/src/citation.rs`

`util` · `cross-cutting text parsing, during streaming output or whole-string cleanup`

Some text produced by the system can contain hidden citation markers like `<oai-mem-citation>source A</oai-mem-citation>`. Those markers should not be shown to the user, but the text inside them still matters because it records where something came from. This file is the small adapter that turns those hidden tagged sections into a clean pair: visible text for display, and a list of extracted citation strings.

The main type, `CitationStreamParser`, wraps a more general `InlineHiddenTagParser`. That inner parser knows how to recognize hidden inline tags even when the opening or closing tag is split across chunks. This wrapper configures it for exactly one tag shape: the citation tag. When new text is pushed in, normal text passes through as `visible_text`, while citation bodies are collected as extracted strings. The tag text itself is removed.

A useful detail is that matching is literal and non-nested. In everyday terms, it looks for the exact open sign and then the next exact close sign; it does not understand citations inside citations. If the input ends while a citation is still open, the parser treats the end of the file as the closing point and returns whatever citation body it has collected. The helper `strip_citations` offers the same behavior for callers that already have the complete text in one string.

#### Function details

##### `CitationStreamParser::new`  (lines 28–36)

```
fn new() -> Self
```

**Purpose**: Creates a fresh citation parser that knows the exact opening and closing citation tags. Use this when starting to read a new piece of text or a new stream of text.

**Data flow**: It takes no caller-provided data. It builds one tag rule using `<oai-mem-citation>` as the start marker and `</oai-mem-citation>` as the end marker, gives that rule to the general hidden-tag parser, and returns a ready-to-use `CitationStreamParser` with empty internal state.

**Call relations**: This is the setup step for the parser. `strip_citations` calls it when cleaning a complete string, and the tests call it to check streaming behavior, unfinished tags, and partial tag prefixes. Internally it hands the tag rule to `InlineHiddenTagParser::new`, which does the lower-level scanning work.

*Call graph*: calls 1 internal fn (new); called by 11 (strip_citations, citation_parser_auto_closes_unterminated_tag_on_finish, citation_parser_buffers_partial_open_tag_prefix, citation_parser_preserves_partial_open_tag_at_eof_if_not_a_full_tag, citation_parser_streams_across_chunk_boundaries, utf8_stream_parser_errors_on_incomplete_code_point_at_eof, utf8_stream_parser_handles_split_code_points_across_chunks, utf8_stream_parser_into_inner_errors_when_partial_code_point_is_buffered, utf8_stream_parser_into_inner_lossy_drops_buffered_partial_code_point, utf8_stream_parser_rolls_back_entire_chunk_when_invalid_byte_follows_valid_prefix (+1 more)); 1 external calls (vec!).


##### `CitationStreamParser::default`  (lines 40–42)

```
fn default() -> Self
```

**Purpose**: Provides the standard default way to make a citation parser. It exists so code that expects a `Default` value can create this parser without spelling out `new`.

**Data flow**: It receives no input, calls the parser constructor, and returns the same kind of empty, ready-to-use citation parser that `CitationStreamParser::new` returns.

**Call relations**: This is a convenience doorway into `CitationStreamParser::new`. The test helper uses default construction for generic parser setup, and any outside code using Rust's `Default` pattern can do the same.

*Call graph*: 1 external calls (new).


##### `CitationStreamParser::push_str`  (lines 48–54)

```
fn push_str(&mut self, chunk: &str) -> StreamTextChunk<Self::Extracted>
```

**Purpose**: Feeds one new piece of text into the citation parser. It returns the visible text that is safe to show now, plus any complete citation bodies found in that piece and any buffered earlier pieces.

**Data flow**: It receives a text chunk and the parser's current saved state. It passes the chunk to the inner hidden-tag parser, then converts the inner extracted tag records into plain strings by keeping only each tag's content. It returns a `StreamTextChunk` containing visible text and extracted citation strings, while the parser keeps any unfinished tag fragments for later chunks.

**Call relations**: This is the main streaming entry point. Callers repeatedly use it as text arrives. It delegates the hard part, such as recognizing tags split across chunk boundaries, to the inner parser, then reshapes the result into the citation-specific output type.

*Call graph*: calls 1 internal fn (push_str); called by 1 (push_str).


##### `CitationStreamParser::finish`  (lines 56–62)

```
fn finish(&mut self) -> StreamTextChunk<Self::Extracted>
```

**Purpose**: Tells the parser that no more text is coming. It flushes any saved text and, if a citation was opened but never closed, returns that unfinished citation body as an extracted citation.

**Data flow**: It reads the parser's internal buffered state and asks the inner parser to finish. It then keeps the visible leftover text and turns any extracted tag records into plain citation strings. The result is a final `StreamTextChunk`; after this, the stream is considered complete.

**Call relations**: This is called after the last `push_str`. `strip_citations` uses it after feeding the whole input, and the test helper uses it after all test chunks. It relies on the inner parser's finishing behavior, including auto-closing an unterminated citation at end of input.

*Call graph*: calls 1 internal fn (finish); called by 1 (finish).


##### `strip_citations`  (lines 69–76)

```
fn strip_citations(text: &str) -> (String, Vec<String>)
```

**Purpose**: Removes citation tags from a complete string in one call and returns both the cleaned text and the collected citations. It is the simple non-streaming helper for callers that already have all the text.

**Data flow**: It takes one full text string. It creates a `CitationStreamParser`, pushes the whole string into it, then calls `finish` to flush anything left. It joins the visible text from both steps, combines the extracted citations, and returns them as `(visible_text, citations)`.

**Call relations**: This function packages the streaming parser into an easier one-shot API. Tests use it to check multiple citations, unfinished citations at the end of the string, and the important rule that nested citation tags are not specially supported.

*Call graph*: calls 1 internal fn (new); called by 3 (citation_parser_does_not_support_nested_tags, strip_citations_auto_closes_unterminated_citation_at_eof, strip_citations_collects_all_citations).


##### `tests::collect_chunks`  (lines 86–100)

```
fn collect_chunks(parser: &mut P, chunks: &[&str]) -> StreamTextChunk<P::Extracted>
```

**Purpose**: Helps tests feed a parser several chunks and collect all visible text and extracted items into one result. It makes streaming tests easier to read.

**Data flow**: It receives a mutable parser and a list of text chunks. For each chunk it calls `push_str`, appends the returned visible text, and adds the returned extracted items. At the end it calls `finish` and appends that final output too, then returns the combined `StreamTextChunk`.

**Call relations**: The streaming-focused tests call this helper so they can describe input as several pieces and then assert on one combined result. It uses the general `StreamTextParser` trait, so it is not tied only to citation parsing.

*Call graph*: calls 1 internal fn (default); 2 external calls (finish, push_str).


##### `tests::citation_parser_streams_across_chunk_boundaries`  (lines 103–116)

```
fn citation_parser_streams_across_chunk_boundaries()
```

**Purpose**: Checks that citation tags are still recognized when the tag text is split across incoming chunks. This protects the main streaming use case.

**Data flow**: It creates a new parser and feeds three chunks where both the opening and closing citation tags are divided across chunk boundaries. It expects the visible output to contain only `Hello  world` and the extracted citations to contain `source A`.

**Call relations**: This test uses `CitationStreamParser::new` and the shared `tests::collect_chunks` helper. It proves that the parser and its inner hidden-tag scanner work like a reader holding a bookmark between pages, remembering partial tag text until the next chunk arrives.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert_eq!, collect_chunks).


##### `tests::citation_parser_buffers_partial_open_tag_prefix`  (lines 119–132)

```
fn citation_parser_buffers_partial_open_tag_prefix()
```

**Purpose**: Checks that a possible opening tag prefix is held back until the parser can tell whether it is really a citation tag. This prevents half a tag from leaking into visible text too early.

**Data flow**: It creates a parser and first pushes `abc <oai-mem-`, which might be the start of a citation tag. The parser returns only `abc ` as visible text and no citation. Then it pushes the rest of the tag, citation body, close tag, and trailing `z`; the parser returns `z` as visible text and `x` as the extracted citation, and finishing returns nothing extra.

**Call relations**: This test calls the parser directly rather than using the helper, because it needs to inspect the result after the first chunk. It checks the buffering behavior supplied through `CitationStreamParser::push_str` and completed by `finish`.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert!, assert_eq!).


##### `tests::citation_parser_auto_closes_unterminated_tag_on_finish`  (lines 135–141)

```
fn citation_parser_auto_closes_unterminated_tag_on_finish()
```

**Purpose**: Checks that an open citation is still returned when the input ends without a closing citation tag. This confirms the parser does not silently lose citation information at end of stream.

**Data flow**: It feeds text containing `x` followed by an opening citation tag and the body `source`, but no closing tag. After finishing, the combined visible text is `x` and the extracted citation list contains `source`.

**Call relations**: This test uses `CitationStreamParser::new` and `tests::collect_chunks`. It focuses on the behavior of `CitationStreamParser::finish`, which asks the inner parser to close out any still-open hidden tag.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert_eq!, collect_chunks).


##### `tests::citation_parser_preserves_partial_open_tag_at_eof_if_not_a_full_tag`  (lines 144–150)

```
fn citation_parser_preserves_partial_open_tag_at_eof_if_not_a_full_tag()
```

**Purpose**: Checks that a mere prefix of a citation tag is not treated as a real hidden citation when the input ends. This keeps ordinary text from disappearing just because it looks like the start of a tag.

**Data flow**: It feeds `hello <oai-mem-`, which is only part of the citation opening marker. When the stream finishes, the parser returns that whole text as visible output and extracts no citations.

**Call relations**: This test uses `CitationStreamParser::new` and `tests::collect_chunks`. It complements the unfinished-citation test by showing that auto-closing only happens after a full opening tag has actually been seen.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert_eq!, collect_chunks).


##### `tests::strip_citations_collects_all_citations`  (lines 153–160)

```
fn strip_citations_collects_all_citations()
```

**Purpose**: Checks that the one-shot helper removes more than one citation tag and returns all citation bodies in order. This protects the simple API used for complete strings.

**Data flow**: It passes a complete string with visible letters around two citation tags. `strip_citations` returns `abc` as the visible text and the two citation bodies, `one` and `two`, as a list.

**Call relations**: This test calls `strip_citations`, which in turn creates and uses `CitationStreamParser`. It confirms that the wrapper around the streaming parser preserves all extracted citations rather than only the first one.

*Call graph*: calls 1 internal fn (strip_citations); 1 external calls (assert_eq!).


##### `tests::strip_citations_auto_closes_unterminated_citation_at_eof`  (lines 163–168)

```
fn strip_citations_auto_closes_unterminated_citation_at_eof()
```

**Purpose**: Checks that the one-shot helper has the same end-of-input behavior as the streaming parser for an unfinished citation. This keeps the two APIs consistent.

**Data flow**: It passes `x<oai-mem-citation>y` to `strip_citations`. The function returns `x` as visible text and `y` as the extracted citation, even though no closing citation tag appears.

**Call relations**: This test calls `strip_citations`, which relies on `CitationStreamParser::finish` after pushing the input. It verifies that the helper inherits the parser's auto-close rule.

*Call graph*: calls 1 internal fn (strip_citations); 1 external calls (assert_eq!).


##### `tests::citation_parser_does_not_support_nested_tags`  (lines 171–178)

```
fn citation_parser_does_not_support_nested_tags()
```

**Purpose**: Documents and checks the rule that citation tags are not nested. The parser stops at the first closing tag it sees, even if another opening tag appeared inside the citation body.

**Data flow**: It passes text with a citation opening tag inside another citation. The parser treats the inner opening tag as ordinary citation-body text, extracts `x<oai-mem-citation>y`, and leaves the later outer closing tag visible as plain text, producing `az</oai-mem-citation>b`.

**Call relations**: This test calls `strip_citations` to exercise the public one-shot API. It captures an important limitation of the underlying literal scanner so future changes do not accidentally change how nested-looking input is interpreted.

*Call graph*: calls 1 internal fn (strip_citations); 1 external calls (assert_eq!).


### `utils/stream-parser/src/proposed_plan.rs`

`domain_logic` · `request handling / streaming text parsing`

Some assistant responses may contain a plan wrapped in `<proposed_plan>` and `</proposed_plan>` tags. This file is the small adapter that knows what those tags mean. Its job is like a mail sorter: ordinary text goes into the visible-text pile, while plan text goes into a separate extracted pile with markers for where the plan starts, changes, and ends.

The parser is built on top of a more general `TaggedLineParser`, which can find tagged blocks in text that arrives piece by piece. That matters because streamed text may split a tag across chunks, such as receiving `<prop` first and `osed_plan>` later. `ProposedPlanParser` configures that general parser with just one tag pair: `<proposed_plan>` and `</proposed_plan>`.

As text is pushed in, the underlying parser returns generic tagged segments. `map_segments` translates those into the more specific `ProposedPlanSegment` values used by callers. Normal text is also copied into `visible_text`; plan text is not, so it can be hidden from the main display.

The file also includes two convenience helpers: one removes plan blocks from a complete string, and one extracts the most recent plan text. The tests show important edge cases, including tags split across streamed chunks, ordinary lines that only look similar to tags, and unfinished plan blocks that are closed when parsing finishes.

#### Function details

##### `ProposedPlanParser::new`  (lines 34–42)

```
fn new() -> Self
```

**Purpose**: Creates a parser that specifically looks for `<proposed_plan>` blocks. Use this when starting to process a fresh assistant message or text stream.

**Data flow**: It takes no outside input. It builds a `TaggedLineParser` configured with one rule: the opening plan tag, the closing plan tag, and the internal label meaning “this is a proposed plan.” It returns a ready-to-use `ProposedPlanParser` with empty parsing state.

**Call relations**: This is the starting point for the rest of the file. The stripping and extraction helpers call it before parsing full text, and the tests call it before feeding sample chunks. It hands the tag setup to `TaggedLineParser::new`, which does the lower-level work of recognizing tagged blocks.

*Call graph*: calls 1 internal fn (new); called by 5 (extract_proposed_plan_text, strip_proposed_plan_blocks, closes_unterminated_plan_block_on_finish, preserves_non_tag_lines, streams_proposed_plan_segments_and_visible_text); 1 external calls (vec!).


##### `ProposedPlanParser::default`  (lines 46–48)

```
fn default() -> Self
```

**Purpose**: Provides the standard default way to create a `ProposedPlanParser`. This lets other Rust code use default construction without needing to remember the exact setup.

**Data flow**: It receives no data. It simply delegates to `ProposedPlanParser::new`, so the result is the same freshly configured parser.

**Call relations**: This is a convenience wrapper around `ProposedPlanParser::new`. Any caller that asks for the default parser gets the same tag-aware parser used everywhere else in this file.

*Call graph*: 1 external calls (new).


##### `ProposedPlanParser::push_str`  (lines 54–56)

```
fn push_str(&mut self, chunk: &str) -> StreamTextChunk<Self::Extracted>
```

**Purpose**: Feeds one new piece of streamed text into the parser. It returns what can be shown immediately and what plan-related pieces were found.

**Data flow**: It receives a text chunk and reads the parser’s current internal state, which may include a partly seen tag from earlier chunks. It asks the underlying tagged-line parser to parse the new text, then converts the generic tag results into `ProposedPlanSegment` values. It returns a `StreamTextChunk` containing visible normal text and extracted plan events.

**Call relations**: This is the main streaming entry point through the `StreamTextParser` trait. Higher-level parsing code calls it whenever more text arrives. It relies on the lower-level `parse` method to find tag boundaries, then hands those raw segments to `map_segments` so callers see proposed-plan-specific results.

*Call graph*: calls 2 internal fn (map_segments, parse); called by 1 (parse_visible_text).


##### `ProposedPlanParser::finish`  (lines 58–60)

```
fn finish(&mut self) -> StreamTextChunk<Self::Extracted>
```

**Purpose**: Ends parsing and flushes any leftover text or unfinished plan block. Call this when no more stream chunks are coming.

**Data flow**: It takes no new text, but reads the parser’s saved state. It asks the underlying parser to finish, which may produce final normal text or close an open plan block. It maps those final generic segments into proposed-plan segments and returns them in a `StreamTextChunk`.

**Call relations**: This completes the same flow started by `push_str`. Trait users call it at the end of a stream, and it passes final raw parser output through `map_segments` so the last pieces have the same shape as earlier streamed pieces.

*Call graph*: calls 2 internal fn (map_segments, finish); called by 1 (finish).


##### `map_segments`  (lines 63–84)

```
fn map_segments(segments: Vec<TaggedLineSegment<PlanTag>>) -> StreamTextChunk<ProposedPlanSegment>
```

**Purpose**: Converts generic tagged parser output into the specific language of proposed-plan parsing. It also decides which text remains visible to the user.

**Data flow**: It receives a list of generic `TaggedLineSegment` values. For each one, it turns normal text into `ProposedPlanSegment::Normal`, tag openings into `ProposedPlanStart`, plan body text into `ProposedPlanDelta`, and tag endings into `ProposedPlanEnd`. Normal text is appended to `visible_text`; every mapped segment is appended to `extracted`. It returns the completed `StreamTextChunk`.

**Call relations**: `push_str` and `finish` both call this after the lower-level tagged parser has done its work. It is the bridge between the generic tag-finding machinery and the public proposed-plan API.

*Call graph*: calls 1 internal fn (default); called by 2 (finish, push_str); 2 external calls (Normal, ProposedPlanDelta).


##### `strip_proposed_plan_blocks`  (lines 86–91)

```
fn strip_proposed_plan_blocks(text: &str) -> String
```

**Purpose**: Removes proposed-plan blocks from a complete string and returns only the text that should be visible. This is useful when the caller does not need streaming events, just cleaned text.

**Data flow**: It receives a whole text string. It creates a new parser, pushes the whole string through it, then finishes the parser to collect any final visible text. It returns the combined visible text, with plan blocks left out.

**Call relations**: This helper uses `ProposedPlanParser::new` and the parser’s streaming methods internally, but hides that process from callers. It is a simpler one-shot path for code that only wants to display or store text without proposed-plan content.

*Call graph*: calls 1 internal fn (new).


##### `extract_proposed_plan_text`  (lines 93–115)

```
fn extract_proposed_plan_text(text: &str) -> Option<String>
```

**Purpose**: Pulls the text inside a proposed-plan block from a complete string. It returns `None` if no plan block was found.

**Data flow**: It receives a whole text string. It creates a parser, parses the string, finishes parsing, and walks through all extracted segments in order. When it sees a plan start, it records that a plan exists and clears the collected text. When it sees plan text deltas, it appends them. At the end, it returns the collected plan text if any plan block was seen.

**Call relations**: This is the one-shot extraction companion to `strip_proposed_plan_blocks`. It uses `ProposedPlanParser::new` and the same stream parsing path, then interprets the resulting `ProposedPlanSegment` events to produce a plain `Option<String>` for callers.

*Call graph*: calls 1 internal fn (new); 1 external calls (new).


##### `tests::collect_chunks`  (lines 127–141)

```
fn collect_chunks(parser: &mut P, chunks: &[&str]) -> StreamTextChunk<P::Extracted>
```

**Purpose**: Test helper that feeds several text chunks into a stream parser and gathers all results into one combined output. It keeps the tests focused on expected behavior instead of repeated setup code.

**Data flow**: It receives a mutable parser and a list of string chunks. For each chunk, it calls `push_str`, appends the visible text, and extends the extracted segment list. After all chunks are sent, it calls `finish` and appends the final output. It returns one combined `StreamTextChunk`.

**Call relations**: The streaming tests call this helper to mimic real streamed input. It drives the parser the same way production code would: several `push_str` calls followed by one `finish`.

*Call graph*: calls 1 internal fn (default); 2 external calls (finish, push_str).


##### `tests::streams_proposed_plan_segments_and_visible_text`  (lines 144–166)

```
fn streams_proposed_plan_segments_and_visible_text()
```

**Purpose**: Checks that the parser correctly handles a proposed-plan tag split across multiple streamed chunks. It verifies both the hidden plan extraction and the visible text shown outside the plan.

**Data flow**: It creates a new parser and sends three chunks, including a split opening tag. It then compares the combined visible text and extracted segment list against the expected result: intro and outro remain visible, while the plan appears as start, delta, and end events.

**Call relations**: This test calls `ProposedPlanParser::new` and `tests::collect_chunks`. It proves that the main streaming path can survive chunk boundaries in awkward places, which is essential for real streamed assistant output.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert_eq!, collect_chunks).


##### `tests::preserves_non_tag_lines`  (lines 169–180)

```
fn preserves_non_tag_lines()
```

**Purpose**: Checks that text which merely resembles a proposed-plan tag is not treated as a real tag unless it matches the expected tag line format.

**Data flow**: It creates a parser and feeds a line containing spaces and extra text around `<proposed_plan>`. The parser output is compared with the original line as normal visible text and a single normal extracted segment.

**Call relations**: This test uses `ProposedPlanParser::new` and `tests::collect_chunks` to guard against over-eager parsing. It makes sure ordinary user-visible text is not accidentally removed just because it contains tag-like characters.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert_eq!, collect_chunks).


##### `tests::closes_unterminated_plan_block_on_finish`  (lines 183–196)

```
fn closes_unterminated_plan_block_on_finish()
```

**Purpose**: Checks what happens when a plan block starts but the closing tag never arrives. The expected behavior is that finishing the stream still produces a clean plan end event.

**Data flow**: It creates a parser, feeds an opening tag and plan text, then relies on `finish` through the helper. The visible text should be empty, and the extracted output should contain a plan start, the plan text, and a generated plan end.

**Call relations**: This test drives the normal streaming lifecycle through `tests::collect_chunks`. It confirms the contract of `ProposedPlanParser::finish`: callers do not have to handle dangling plan blocks themselves.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert_eq!, collect_chunks).


##### `tests::strips_proposed_plan_blocks_from_text`  (lines 199–202)

```
fn strips_proposed_plan_blocks_from_text()
```

**Purpose**: Checks the one-shot helper that removes plan blocks from ordinary text. It verifies that only the before-and-after text remains.

**Data flow**: It builds a sample string with text before a plan block, plan content, and text after it. It calls `strip_proposed_plan_blocks` and compares the returned string with the expected visible text.

**Call relations**: This test exercises the convenience helper rather than the parser directly. It shows that `strip_proposed_plan_blocks` correctly uses the parser pipeline internally.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::extracts_proposed_plan_text`  (lines 205–211)

```
fn extracts_proposed_plan_text()
```

**Purpose**: Checks the one-shot helper that returns the text inside a proposed-plan block. It verifies that the helper ignores surrounding normal text.

**Data flow**: It builds a sample string containing one plan block. It calls `extract_proposed_plan_text` and compares the result with `Some` containing only the plan body.

**Call relations**: This test exercises the extraction helper from the outside, as a caller would use it. It confirms that the parser events are interpreted correctly into a simple optional string.

*Call graph*: 1 external calls (assert_eq!).


### `utils/stream-parser/src/assistant_text.rs`

`domain_logic` · `request handling / streaming response parsing`

Assistant replies can arrive a little at a time, like words being typed over a slow connection. Some of that text is meant for the user to see, but some is special markup: citation tags such as `<oai-mem-citation>...</oai-mem-citation>`, and, when enabled, proposed-plan blocks such as `<proposed_plan>...</proposed_plan>`. This file is the adapter that cleans up that stream.

The main parser, `AssistantTextStreamParser`, works in stages. First it sends each incoming piece of text through a citation parser. That removes citation tags from the visible text and returns the citation contents separately. Then, if “plan mode” is turned on, it sends the remaining visible text through a proposed-plan parser. That strips proposed-plan markup and emits plan events, such as “plan started,” “plan text changed,” or “plan ended.”

This matters because stream chunks do not necessarily line up with tags. One chunk might contain `<proposed` and the next might contain `_plan>`. The parser remembers unfinished markup between calls, the way a bookmark keeps your place in a sentence. Without this file, users could see raw internal tags, citations could be lost, and proposed plans could be displayed or tracked incorrectly.

#### Function details

##### `AssistantTextChunk::is_empty`  (lines 15–17)

```
fn is_empty(&self) -> bool
```

**Purpose**: Checks whether a parsed chunk contains nothing useful: no text for the user, no citations, and no plan updates. This is helpful at the end of a stream, where finishing the parser may or may not produce one last piece of output.

**Data flow**: It reads the chunk’s three fields: `visible_text`, `citations`, and `plan_segments`. If all three are empty, it returns `true`; otherwise it returns `false`. It does not change the chunk.

**Call relations**: This is a simple question asked of an `AssistantTextChunk` after parsing. In this file, the plan-mode test uses it to confirm that calling `finish` after all text has already been parsed produces no extra output.


##### `AssistantTextStreamParser::new`  (lines 31–36)

```
fn new(plan_mode: bool) -> Self
```

**Purpose**: Creates a fresh assistant-text parser and chooses whether proposed-plan parsing should be active. Use it when starting to read a new streamed assistant message.

**Data flow**: It takes one input, `plan_mode`, which says whether `<proposed_plan>` markup should be treated specially. It starts from the parser’s default empty state, stores that mode flag, and returns a ready-to-use `AssistantTextStreamParser` with fresh citation and plan parsers inside.

**Call relations**: The tests call this first to set up a parser before feeding it streamed text. Internally it relies on the default constructor for the rest of the fields, so the citation parser and plan parser both start with no remembered partial tag.

*Call graph*: called by 2 (parses_citations_across_seed_and_delta_boundaries, parses_plan_segments_after_citation_stripping); 1 external calls (default).


##### `AssistantTextStreamParser::push_str`  (lines 38–43)

```
fn push_str(&mut self, chunk: &str) -> AssistantTextChunk
```

**Purpose**: Feeds one new piece of streamed assistant text into the parser and returns whatever can be safely emitted now. This is the main method used while a response is still arriving.

**Data flow**: It receives a text chunk. First, it passes that chunk to the citation parser, which removes citation tags from the text and collects completed citation payloads. Then it sends the cleaned visible text to `parse_visible_text`, which may also remove proposed-plan markup if plan mode is on. The returned `AssistantTextChunk` contains visible user-facing text, any citations completed by this input, and any plan segments completed by this input.

**Call relations**: This method is the streaming front door. It hands raw incoming text to the citation parser first, then calls `AssistantTextStreamParser::parse_visible_text` so plan parsing sees text after citations have already been stripped out.

*Call graph*: calls 2 internal fn (parse_visible_text, push_str).


##### `AssistantTextStreamParser::finish`  (lines 45–57)

```
fn finish(&mut self) -> AssistantTextChunk
```

**Purpose**: Tells the parser that no more text is coming and asks it to flush any leftover partial markup. This prevents unfinished buffered text from being silently dropped at the end of a stream.

**Data flow**: It first finishes the citation parser, receiving any final visible text and completed citations. It then sends that remaining visible text through `parse_visible_text`. If plan mode is active, it also finishes the plan parser and appends any final visible text or plan segments it produces. The result is one final `AssistantTextChunk` containing all remaining output.

**Call relations**: This is called after the last streamed chunk. It coordinates the citation parser’s `finish`, its own `parse_visible_text`, and, in plan mode, the proposed-plan parser’s `finish`, so each layer gets a chance to release text it was holding while waiting for a closing tag.

*Call graph*: calls 3 internal fn (parse_visible_text, finish, finish).


##### `AssistantTextStreamParser::parse_visible_text`  (lines 59–72)

```
fn parse_visible_text(&mut self, visible_text: String) -> AssistantTextChunk
```

**Purpose**: Processes text after citations have already been removed. If proposed-plan parsing is off, it simply returns the text as visible output; if it is on, it separates normal visible text from proposed-plan segments.

**Data flow**: It receives a string that is already free of citation markup. When `plan_mode` is false, it places that string directly into an `AssistantTextChunk`. When `plan_mode` is true, it passes the string to the proposed-plan parser, then returns a chunk containing the parser’s visible text and extracted plan segments.

**Call relations**: `push_str` and `finish` both call this as the second parsing stage. It delegates to the proposed-plan parser only when plan mode is enabled; otherwise it avoids that extra interpretation and treats all citation-cleaned text as ordinary visible text.

*Call graph*: calls 1 internal fn (push_str); called by 2 (finish, push_str); 1 external calls (default).


##### `tests::parses_citations_across_seed_and_delta_boundaries`  (lines 82–95)

```
fn parses_citations_across_seed_and_delta_boundaries()
```

**Purpose**: Checks that citation parsing still works when a citation tag is split across multiple streamed chunks. This protects against a common streaming problem where meaningful markup does not arrive all at once.

**Data flow**: The test creates a parser with plan mode turned off, feeds it text where the citation starts in one chunk and ends in the next, then finishes the stream. It expects the user-visible output to be `hello ` followed later by ` world`, while the citation payload `doc1` is returned separately and not shown in the visible text.

**Call relations**: The test begins by calling `AssistantTextStreamParser::new` to create the parser. It then uses assertions to verify the parser’s public streaming behavior: partial citation text is remembered until the closing citation tag arrives, and `finish` adds nothing once all content has already been emitted.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `tests::parses_plan_segments_after_citation_stripping`  (lines 98–129)

```
fn parses_plan_segments_after_citation_stripping()
```

**Purpose**: Checks that proposed-plan parsing happens after citation removal, and that both features still work when tags are split across chunks. This makes sure plan text does not accidentally include citation markup.

**Data flow**: The test creates a parser with plan mode turned on, feeds it an intro, a split `<proposed_plan>` opening tag, a plan line containing a citation, a closing plan tag, and an outro. It expects normal text to remain visible, the citation `doc` to be extracted separately, and the plan parser to emit start, delta, end, and normal-text segments in the right order.

**Call relations**: The test calls `AssistantTextStreamParser::new` to start in plan mode, then uses equality and truth assertions to check the combined parser behavior. It exercises the intended pipeline: citation markup is removed first, then proposed-plan markup is interpreted from the cleaned text.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert!, assert_eq!).


### `tui/src/streaming/table_holdback.rs`

`domain_logic` · `streaming output handling`

When an agent streams Markdown into the terminal, the UI wants to move finished text into scrollback as soon as possible. Tables are tricky: a Markdown table can look different after more rows arrive, because wider cells can change the layout of earlier rows. This file acts like a cautious lookout at the end of the stream. It watches the raw source text and says, “from this point onward, keep the rendered output mutable for now.”

The main type, TableHoldbackScanner, is built for append-only streaming. New source chunks are fed to it in order. It remembers only a small amount: the current byte position, whether it is inside a fenced code block, the previous line, and whether it has seen a possible or confirmed table. A fenced code block is a Markdown region marked by backticks or tildes; the scanner ignores tables inside non-Markdown code fences so code examples are not mistaken for real tables.

The scanner first notices a possible table header, such as a line with pipe-separated cells. If the next committed line is a table delimiter, such as dashes between pipes, it confirms the table and reports that the mutable tail should start at the header. It also understands blockquoted tables after removing quote markers. It does not fully render or validate tables; it only finds enough structure to avoid committing unstable table output too early.

#### Function details

##### `TableHoldbackScanner::new`  (lines 60–68)

```
fn new() -> Self
```

**Purpose**: Creates a fresh table holdback scanner with no remembered source and no table detected yet. This is used when a stream starts, or when tests need a clean scanner.

**Data flow**: It takes no input. It builds a scanner whose source position starts at zero, whose fenced-code tracker is fresh, and whose previous-line, pending-header, and confirmed-table memory are empty. The result is a ready-to-use scanner waiting for source chunks.

**Call relations**: This is the starting point for the incremental scanner. The scanner’s reset path also returns to this same clean state, and tests create scanners this way when checking how table detection behaves across chunks.

*Call graph*: calls 1 internal fn (new); called by 3 (new, incremental_holdback_detects_header_delimiter_across_chunk_boundary, incremental_holdback_matches_stateless_scan_per_chunk).


##### `TableHoldbackScanner::reset`  (lines 70–72)

```
fn reset(&mut self)
```

**Purpose**: Clears the scanner so it behaves like a brand-new one. Someone would use this when the current stream or accumulated source has been discarded and old table clues must not affect the next run.

**Data flow**: It takes the existing scanner as input by mutable reference. It replaces all remembered offsets, fence state, previous line state, and table state with the values from a new scanner. Afterward, the same scanner object is reused but contains no old history.

**Call relations**: This is a simple cleanup path. When called, it delegates the actual fresh-state construction to TableHoldbackScanner::new so reset and initial creation stay consistent.

*Call graph*: called by 1 (reset); 1 external calls (new).


##### `TableHoldbackScanner::state`  (lines 81–89)

```
fn state(&self) -> TableHoldbackState
```

**Purpose**: Reports the scanner’s current decision: no table, a possible header waiting for the next line, or a confirmed table whose start must stay mutable. The UI uses this answer to decide how much rendered output can safely move into stable scrollback.

**Data flow**: It reads the scanner’s stored table markers. If a confirmed table start exists, it returns that as the strongest answer. If not, but a pending header exists, it returns the header position. If neither exists, it returns that there is no table holdback needed.

**Call relations**: This is the scanner’s public status check. Code that budgets the active mutable tail asks for this state, while push_source_chunk updates the stored facts that state later reports.

*Call graph*: called by 1 (active_tail_budget_lines).


##### `TableHoldbackScanner::push_source_chunk`  (lines 98–116)

```
fn push_source_chunk(&mut self, source_chunk: &str)
```

**Purpose**: Feeds newly committed source text into the scanner. It is used as streaming output arrives, but only for source that is complete enough to inspect, usually whole lines rather than half-written table rows.

**Data flow**: It receives a text chunk. If the chunk is empty, nothing changes. Otherwise it splits the chunk into newline-ending pieces, sends each piece to push_line, counts how many lines it scanned, and writes a trace log with the byte count, line count, current state, and elapsed time. The scanner’s remembered position and table decision may change.

**Call relations**: This is the normal entry point for incremental scanning during streaming. The streaming collector calls it when pushing new deltas and when finalizing remaining text. It hands the detailed per-line work to TableHoldbackScanner::push_line.

*Call graph*: calls 1 internal fn (push_line); called by 2 (finalize_remaining, push_delta); 2 external calls (now, trace!).


##### `TableHoldbackScanner::push_line`  (lines 119–159)

```
fn push_line(&mut self, source_line: &str)
```

**Purpose**: Examines one committed source line and updates the scanner’s table detection memory. This is where a possible header becomes either a confirmed table or gets cleared when the next meaningful line does not match.

**Data flow**: It receives one source line, notes the line’s starting byte offset, and checks the current fenced-code context before advancing it. If the line is not in a non-Markdown code fence, it strips blockquote markers and checks whether the text looks like a table header or delimiter. If the previous line was a header and this line is a delimiter, it records a confirmed table starting at the previous line. If there is not yet a confirmed table, it records or clears a pending header based on the current non-blank line. Finally it saves this line as the previous line, advances the fence tracker, and moves the source offset forward by the line’s byte length.

**Call relations**: This is called only by TableHoldbackScanner::push_source_chunk as each line arrives. It relies on table_candidate_text to filter table-shaped lines and on the fence tracker to avoid false positives inside code blocks.

*Call graph*: calls 3 internal fn (table_candidate_text, advance, kind); called by 1 (push_source_chunk).


##### `table_candidate_text`  (lines 167–170)

```
fn table_candidate_text(line: &str) -> Option<&str>
```

**Purpose**: Prepares a line for table detection and rejects lines that do not have a pipe-table shape. It lets quoted tables count as real tables by ignoring Markdown blockquote markers before checking the table structure.

**Data flow**: It receives one line of source text. It removes any leading blockquote prefix, trims surrounding whitespace, and asks the table parser whether pipe-separated table segments are present. If they are, it returns the cleaned text; otherwise it returns no value.

**Call relations**: Both the streaming scanner and the test-only full-source scanner use this helper before asking whether a line is a table header or delimiter. It keeps the quote-stripping and basic table-shape check in one place.

*Call graph*: calls 2 internal fn (parse_table_segments, strip_blockquote_prefix); called by 2 (push_line, table_holdback_state).


##### `parse_lines_with_fence_state`  (lines 182–201)

```
fn parse_lines_with_fence_state(source: &str) -> Vec<ParsedLine<'_>>
```

**Purpose**: In tests, breaks a source string into lines and labels each line with whether it was inside a fenced code block at that point. This helps the stateless test scanner compare its result with the incremental scanner.

**Data flow**: It receives a full source string. Starting at byte offset zero, it walks line by line, records the raw line text, the current fence context, and the line’s starting offset, then advances the fence tracker for the next line. It returns a list of these annotated lines.

**Call relations**: This function exists only for test builds. table_holdback_state calls it to get a complete, line-by-line view of source before looking for table header and delimiter pairs.

*Call graph*: calls 1 internal fn (new); called by 1 (table_holdback_state); 1 external calls (new).


##### `table_holdback_state`  (lines 206–242)

```
fn table_holdback_state(source: &str) -> TableHoldbackState
```

**Purpose**: In tests, scans a whole source string at once and returns the same kind of holdback decision as the incremental scanner. It provides a simpler reference version that tests can compare against chunk-by-chunk streaming behavior.

**Data flow**: It receives full source text. It first parses lines with their fenced-code context. Then it looks at each neighboring pair of lines outside non-Markdown code fences; if one is a table header and the next is a delimiter, it returns a confirmed table starting at the header’s offset. If no confirmed table is found, it checks the last non-blank line and returns a pending header if that line looks like a table header. Otherwise it returns no holdback.

**Call relations**: This function is test-only support code. It uses parse_lines_with_fence_state and table_candidate_text to mirror the production scanner’s rules, then calls the header and delimiter checks to produce an expected state for tests.

*Call graph*: calls 4 internal fn (parse_lines_with_fence_state, table_candidate_text, is_table_delimiter_line, is_table_header_line).


### `tui/src/markdown_render/table_key_value.rs`

`domain_logic` · `markdown rendering`

Markdown tables are easy to scan when each column has enough room. In a terminal, that often stops being true: long words get chopped across lines, paragraph-like cells become tall thin strips, and the grid becomes more work to read than the content itself. This file decides when that has happened, then renders each row as a list of fields instead of as a table grid.

The idea is similar to turning a spreadsheet row into a form: instead of squeezing values into columns, it prints the column name as a label and the cell content as the value. If there is enough screen width, labels and values are aligned on the same line. If space is tight, the label is printed above the value, with the value indented underneath.

The file also preserves terminal hyperlinks while wrapping and indenting text. That matters because links are tracked by column positions; when a value is shifted to the right, the link ranges must shift too. Without this, clickable links could point to the wrong text.

The main flow is: first detect whether the table grid has become unreadable, then render records row by row, wrap each cell to the available width, add labels and spacing, and insert separator lines between original table rows.

#### Function details

##### `should_render_records`  (lines 31–71)

```
fn should_render_records(
    rows: &[Vec<TableCell>],
    column_widths: &[usize],
    metrics: &[TableColumnMetrics],
) -> bool
```

**Purpose**: Decides whether a table should stop being shown as a grid and instead be shown as vertical records. It looks for signs that the grid layout has become unreadable, such as long tokens that do not fit or multiple wide-content cells being squeezed into tall wrapped blocks.

**Data flow**: It receives the table rows, the chosen width for each column, and measurements describing what kind of content each column has. It checks each row for cells that are likely to fragment badly or for non-compact cells that are starved for space. It returns true when enough rows are affected to justify switching to the vertical key/value layout; otherwise it returns false.

**Call relations**: The broader table renderer calls this before choosing how to draw a markdown table. If this function says the grid is no longer useful, the renderer can call render_records to draw the table in the more readable record style.

*Call graph*: called by 1 (render_table_lines).


##### `expansive_cells_are_starved`  (lines 73–96)

```
fn expansive_cells_are_starved(
    row: &[TableCell],
    column_widths: &[usize],
    metrics: &[TableColumnMetrics],
) -> bool
```

**Purpose**: Checks whether a row has paragraph-like or otherwise roomy content that is being forced into columns too narrow to read comfortably. This catches cases where the problem is not one long word, but too much wrapping across several cells.

**Data flow**: It receives one row, the column widths, and the column metrics. It ignores compact columns, wraps each larger-content cell to its assigned width, and counts how many lines the cell would become. It returns true if several expansive cells become cramped, or if a narrative cell becomes especially narrow and tall.

**Call relations**: should_render_records uses this as one of its warning signs. It helps the decision step notice when the normal grid would produce tall, awkward strips of text rather than readable table cells.

*Call graph*: 1 external calls (iter).


##### `render_records`  (lines 98–149)

```
fn render_records(
    headers: &[TableCell],
    rows: &[Vec<TableCell>],
    metrics: &[TableColumnMetrics],
    available_width: Option<usize>,
    label_style: Style,
    separator_style: Style,
)
```

**Purpose**: Renders the whole table as vertical records instead of as a grid. Each original row becomes a block of labeled fields, with a separator line between row blocks.

**Data flow**: It receives the headers, rows, column metrics, optional available terminal width, and styles for labels and separators. It calculates how wide labels are and decides whether labels and values can fit side by side. It then renders every header/value pair in either aligned or stacked form, adds separator lines between records, and returns the finished list of terminal lines with hyperlink information preserved.

**Call relations**: The main table renderer calls this after deciding that record layout is better than grid layout. Inside, it delegates each field to render_aligned_field or render_stacked_field, and uses widest_line_width when it must create a separator without a known terminal width.

*Call graph*: calls 3 internal fn (render_aligned_field, render_stacked_field, new); called by 1 (render_table_lines); 5 external calls (from, styled, new, iter, iter).


##### `render_aligned_field`  (lines 151–178)

```
fn render_aligned_field(
    out: &mut Vec<HyperlinkLine>,
    header: &TableCell,
    value: &TableCell,
    label_width: usize,
    available_width: Option<usize>,
    label_style: Style,
)
```

**Purpose**: Draws one field with the label on the left and the value starting in a consistent column. This is the easier-to-scan layout used when there is enough horizontal room.

**Data flow**: It receives the output list, a header cell, a value cell, the shared label width, optional available width, and the label style. It computes where the value should begin, wraps the value to the remaining width, adds the styled label only on the first wrapped line, indents later wrapped lines to line up with the value, and appends the resulting lines to the output.

**Call relations**: render_records calls this for each header/value pair when the terminal is wide enough for aligned fields. It relies on wrap_cell to split the value into readable lines, then hands each prefixed line to push_prefixed_value_line so hyperlink positions stay correct after indentation.

*Call graph*: calls 3 internal fn (plain_text, push_prefixed_value_line, wrap_cell); called by 1 (render_records); 3 external calls (raw, styled, new).


##### `render_stacked_field`  (lines 180–212)

```
fn render_stacked_field(
    out: &mut Vec<HyperlinkLine>,
    header: &TableCell,
    value: &TableCell,
    available_width: Option<usize>,
    label_style: Style,
)
```

**Purpose**: Draws one field with the label above the value. This is used when the terminal is too narrow to fit labels and values side by side without making the value unreadable.

**Data flow**: It receives the output list, a header cell, a value cell, optional available width, and the label style. It wraps the label to the available label width and writes it with a small leading space. Then it wraps the value to the remaining width and writes it underneath with a slightly larger indent. The finished lines are appended to the output.

**Call relations**: render_records calls this when aligned fields would not leave enough room for values. It uses the general word-wrapping helper for labels, wrap_cell for values, and push_prefixed_value_line to attach indentation while preserving hyperlink positions.

*Call graph*: calls 7 internal fn (plain_text, push_prefixed_value_line, wrap_cell, push_owned_lines, new, new, word_wrap_line); called by 1 (render_records); 4 external calls (from, styled, new, vec!).


##### `push_prefixed_value_line`  (lines 214–232)

```
fn push_prefixed_value_line(
    out: &mut Vec<HyperlinkLine>,
    mut prefix: Vec<Span<'static>>,
    mut value_line: HyperlinkLine,
)
```

**Purpose**: Adds indentation or label text in front of a value line while keeping any terminal hyperlinks attached to the right characters. This is important because adding spaces before linked text changes its column positions.

**Data flow**: It receives the output list, a prefix made of text spans, and a value line that may contain hyperlinks. It measures the display width of the prefix, joins the prefix and value spans into one line, shifts every hyperlink range to the right by that prefix width, and pushes the corrected line into the output.

**Call relations**: Both render_aligned_field and render_stacked_field call this whenever they add a wrapped value line. It is the small but important bridge between visual formatting and accurate clickable link metadata.

*Call graph*: calls 1 internal fn (new); called by 2 (render_aligned_field, render_stacked_field); 1 external calls (from).


##### `wrap_cell`  (lines 234–255)

```
fn wrap_cell(cell: &TableCell, width: usize) -> Vec<HyperlinkLine>
```

**Purpose**: Wraps the visual contents of a table cell to a target width while preserving hyperlink information. It turns one possibly long cell into one or more terminal lines that fit the chosen width.

**Data flow**: It receives a table cell and a width. For each source line in the cell, it word-wraps the visible text, converts the wrapped lines into owned terminal lines, and remaps hyperlinks from the original line onto the new wrapped pieces. It returns the wrapped lines, or a blank line if the cell has no visible content.

**Call relations**: The record renderer uses this before drawing values in both aligned and stacked layouts. expansive_cells_are_starved also uses it as a measuring tool to estimate how tall a cell would become at a given column width.

*Call graph*: calls 4 internal fn (new, remap_wrapped_line, new, word_wrap_line); called by 2 (render_aligned_field, render_stacked_field); 3 external calls (default, new, vec!).


##### `cell_width`  (lines 257–269)

```
fn cell_width(cell: &TableCell) -> usize
```

**Purpose**: Finds the widest visible line inside a table cell. This is used when there is no fixed terminal width and the renderer needs a natural width for wrapping or spacing.

**Data flow**: It receives a table cell, measures the display width of every span in every line, and takes the largest total line width. It returns that maximum width, or zero for an empty cell.

**Call relations**: render_aligned_field and render_stacked_field use this when no available terminal width was supplied. It gives those functions a sensible fallback width based on the cell’s actual content.


##### `widest_line_width`  (lines 271–283)

```
fn widest_line_width(lines: &[HyperlinkLine]) -> usize
```

**Purpose**: Finds the widest rendered output line so separator lines can match the content width when no terminal width is known.

**Data flow**: It receives already-rendered lines, measures the visible width of each line by adding up its spans, and returns the largest width found. If there are no lines, it returns zero.

**Call relations**: render_records uses this when inserting separator lines between record blocks and no explicit available width was provided. It lets the separator grow to the width of the content already produced.

*Call graph*: 1 external calls (iter).


### `tui/src/render/highlight.rs`

`domain_logic` · `startup, theme changes, and rendering code/diff text`

This file is the syntax highlighting engine for the terminal interface. When the app shows a Markdown code block, a shell command, or parts of a diff, this code decides which words should be colored and which colors to use. Without it, code would still display, but it would be plain text and harder to scan.

It uses syntect, a library that understands many programming languages, together with two_face, which ships a large bundle of language rules and color themes. Think of the language rules as a set of dictionaries for recognizing code, and the theme as the paint palette. The file keeps these expensive resources in process-wide singletons so they are built once and reused.

At startup, the app can record a user’s preferred theme and the home folder where custom theme files live. Later, users can preview or switch themes while the app is running. The file supports built-in themes and custom `.tmTheme` files.

The actual highlighting path is careful: it refuses very large inputs, because coloring huge files can waste CPU and memory. If anything is unknown or too large, callers get plain unstyled text instead. It also adapts some color formats so terminal palette themes behave like real terminal colors, not forced RGB colors.

#### Function details

##### `syntax_set`  (lines 59–61)

```
fn syntax_set() -> &'static SyntaxSet
```

**Purpose**: Returns the shared database of language grammars used to recognize code. It builds that database only once because it is large and reused everywhere highlighting happens.

**Data flow**: It takes no input. The first time it is called, it loads the bundled two_face syntax set; later calls reuse the same stored value. It returns a reference to that shared syntax database.

**Call relations**: Language lookup and the core highlighter call this when they need grammar information. It is the common source of truth for both finding a language and parsing each highlighted line.

*Call graph*: called by 2 (find_syntax, highlight_to_line_spans_with_theme).


##### `set_theme_override`  (lines 81–101)

```
fn set_theme_override(
    name: Option<String>,
    codex_home: Option<PathBuf>,
) -> Option<String>
```

**Purpose**: Records the user’s configured syntax theme and custom-theme folder after configuration is finalized. It also updates the active theme immediately if the theme system has already started.

**Data flow**: It receives an optional theme name and optional Codex home path. It validates the name, stores the settings in write-once global slots, may resolve and apply the theme, and returns an optional warning message for the user.

**Call relations**: The app startup flow calls this from run_ratatui_app. It delegates checking to validate_theme_name, theme resolution to resolve_theme_with_override, and live application to set_syntax_theme.

*Call graph*: calls 3 internal fn (resolve_theme_with_override, set_syntax_theme, validate_theme_name); called by 1 (run_ratatui_app); 1 external calls (debug!).


##### `validate_theme_name`  (lines 105–133)

```
fn validate_theme_name(name: Option<&str>, codex_home: Option<&Path>) -> Option<String>
```

**Purpose**: Checks whether a requested theme name is usable. It gives a clear warning when a user typed an unknown built-in theme or pointed to a missing or broken custom theme file.

**Data flow**: It receives an optional theme name and optional home folder. If there is no name or the name matches a bundled theme, it returns no warning; otherwise it looks for and tries to parse a matching `.tmTheme` file, returning a warning string if that fails.

**Call relations**: set_theme_override calls this before saving the configuration. Tests call it directly to make sure users get useful messages for missing or invalid custom themes.

*Call graph*: calls 3 internal fn (custom_theme_path, load_custom_theme, parse_theme_name); called by 3 (set_theme_override, validate_theme_name_warns_for_missing_custom, validate_theme_name_warns_when_custom_file_is_invalid); 1 external calls (format!).


##### `parse_theme_name`  (lines 136–172)

```
fn parse_theme_name(name: &str) -> Option<EmbeddedThemeName>
```

**Purpose**: Translates the public kebab-case theme name, such as `catppuccin-mocha`, into the internal two_face theme identifier. This lets config files use readable names.

**Data flow**: It receives a string. If the string is one of the known bundled theme names, it returns the matching internal enum value; otherwise it returns nothing.

**Call relations**: Theme validation, theme resolution, and configured-theme reporting all use this as the first step before trying custom theme files.

*Call graph*: called by 4 (configured_theme_name, resolve_theme_by_name, resolve_theme_with_override, validate_theme_name).


##### `custom_theme_path`  (lines 175–177)

```
fn custom_theme_path(name: &str, codex_home: &Path) -> PathBuf
```

**Purpose**: Builds the expected file path for a custom theme. It standardizes the rule that custom themes live under `themes` inside the Codex home folder.

**Data flow**: It receives a theme name and a home directory path. It returns a path like `{home}/themes/{name}.tmTheme`.

**Call relations**: Custom-theme loading and validation both call this so they look in the same place and format user-facing warnings consistently.

*Call graph*: called by 2 (load_custom_theme, validate_theme_name); 2 external calls (join, format!).


##### `load_custom_theme`  (lines 180–182)

```
fn load_custom_theme(name: &str, codex_home: &Path) -> Option<Theme>
```

**Purpose**: Attempts to read and parse a user-provided `.tmTheme` file. This is what lets users bring their own syntax color themes.

**Data flow**: It receives a theme name and home directory. It builds the expected path, asks syntect to load the theme file, and returns the parsed theme if successful or nothing if the file is missing or invalid.

**Call relations**: Theme validation, theme resolution, and configured-theme lookup use this after bundled theme lookup fails. A test also calls it directly with a temporary theme file.

*Call graph*: calls 1 internal fn (custom_theme_path); called by 5 (configured_theme_name, resolve_theme_by_name, resolve_theme_with_override, load_custom_theme_from_tmtheme_file, validate_theme_name); 1 external calls (get_theme).


##### `adaptive_default_theme_selection`  (lines 184–191)

```
fn adaptive_default_theme_selection() -> (EmbeddedThemeName, &'static str)
```

**Purpose**: Chooses a default theme that fits the terminal background. Light terminals get a light theme; other terminals get a dark theme.

**Data flow**: It reads the terminal’s default background color if known. It checks whether that color is light and returns both the internal theme identifier and the public theme name for the selected default.

**Call relations**: The helper functions for default embedded theme and default theme name both call this so the visual default and the displayed name stay in sync.

*Call graph*: calls 2 internal fn (is_light, default_bg); called by 2 (adaptive_default_embedded_theme_name, adaptive_default_theme_name).


##### `adaptive_default_embedded_theme_name`  (lines 193–195)

```
fn adaptive_default_embedded_theme_name() -> EmbeddedThemeName
```

**Purpose**: Returns the internal identifier for the automatically chosen default theme. It is used when the program needs the actual theme object.

**Data flow**: It takes no input. It calls the adaptive default selector and returns only the internal theme value.

**Call relations**: Theme resolution calls this when there is no valid user override and it needs to load the fallback bundled theme.

*Call graph*: calls 1 internal fn (adaptive_default_theme_selection); called by 1 (resolve_theme_with_override).


##### `adaptive_default_theme_name`  (lines 199–201)

```
fn adaptive_default_theme_name() -> &'static str
```

**Purpose**: Returns the readable name of the automatically chosen default theme. This is useful for display and selection state.

**Data flow**: It takes no input. It calls the adaptive default selector and returns only the kebab-case name string.

**Call relations**: Theme-picker setup and configured-theme reporting use this when no valid configured theme is available.

*Call graph*: calls 1 internal fn (adaptive_default_theme_selection); called by 2 (restore_runtime_theme_from_config, configured_theme_name).


##### `resolve_theme_with_override`  (lines 205–224)

```
fn resolve_theme_with_override(name: Option<&str>, codex_home: Option<&Path>) -> Theme
```

**Purpose**: Builds the active theme from a user override if possible, otherwise from the adaptive default. It is the main decision point for theme selection.

**Data flow**: It receives an optional theme name and optional custom-theme home. It first tries bundled themes, then custom files, and finally falls back to the adaptive default theme. It returns a concrete theme object.

**Call relations**: Startup default construction and set_theme_override call this. It uses parse_theme_name, load_custom_theme, and adaptive_default_embedded_theme_name to work through the choices.

*Call graph*: calls 3 internal fn (adaptive_default_embedded_theme_name, load_custom_theme, parse_theme_name); called by 2 (build_default_theme, set_theme_override); 2 external calls (debug!, extra).


##### `build_default_theme`  (lines 228–234)

```
fn build_default_theme() -> Theme
```

**Purpose**: Creates the theme used when the theme lock is first initialized. It respects the saved startup override if one was recorded.

**Data flow**: It reads the stored theme override and stored Codex home path from global slots. It passes those values to resolve_theme_with_override and returns the resulting theme.

**Call relations**: theme_lock calls this lazily when the active theme has not yet been created.

*Call graph*: calls 1 internal fn (resolve_theme_with_override).


##### `theme_lock`  (lines 236–238)

```
fn theme_lock() -> &'static RwLock<Theme>
```

**Purpose**: Returns the shared lock around the active syntax theme. The lock lets the app read the current theme while still allowing safe runtime theme swaps.

**Data flow**: It takes no input. On first use it creates a read-write lock containing build_default_theme; later it returns the same lock.

**Call relations**: Theme readers, theme writers, and highlighters all pass through this helper so they coordinate through the same active theme.

*Call graph*: called by 3 (current_syntax_theme, highlight_to_line_spans, set_syntax_theme).


##### `set_syntax_theme`  (lines 241–247)

```
fn set_syntax_theme(theme: Theme)
```

**Purpose**: Replaces the active syntax theme while the app is running. This supports live preview and theme changes without restarting.

**Data flow**: It receives a theme object. It takes the write side of the theme lock, recovering even if another thread previously panicked while holding it, and stores the new theme.

**Call relations**: Theme preview, restore-from-config flow, and set_theme_override call this when they need the visible highlighting colors to change immediately.

*Call graph*: calls 1 internal fn (theme_lock); called by 3 (restore_runtime_theme_from_config, handle_event, set_theme_override).


##### `current_syntax_theme`  (lines 250–255)

```
fn current_syntax_theme() -> Theme
```

**Purpose**: Returns a copy of the active syntax theme. Callers use this when they need to inspect or save the current theme without changing it.

**Data flow**: It takes no input. It reads the theme lock, clones the theme, and returns that clone; if the lock is poisoned, it still recovers the contained theme.

**Call relations**: Diff-color extraction, foreground-style lookup, and theme-picker setup call this to work from the current live theme.

*Call graph*: calls 1 internal fn (theme_lock); called by 3 (diff_scope_background_rgbs, foreground_style_for_scopes, build_theme_picker_params).


##### `diff_scope_background_rgbs`  (lines 278–281)

```
fn diff_scope_background_rgbs() -> DiffScopeBackgroundRgbs
```

**Purpose**: Finds insert and delete background colors from the current syntax theme for diff rendering. This lets diffs match the selected theme when the theme provides those colors.

**Data flow**: It reads the current theme, asks the pure helper to inspect it, and returns optional raw RGB colors for inserted and deleted text.

**Call relations**: The diff rendering setup calls this through resolve_diff_backgrounds. It hands the actual extraction work to diff_scope_background_rgbs_for_theme.

*Call graph*: calls 2 internal fn (current_syntax_theme, diff_scope_background_rgbs_for_theme); called by 1 (resolve_diff_backgrounds).


##### `diff_scope_background_rgbs_for_theme`  (lines 285–292)

```
fn diff_scope_background_rgbs_for_theme(theme: &Theme) -> DiffScopeBackgroundRgbs
```

**Purpose**: Extracts diff background colors from a specific theme. It prefers modern TextMate scope names and falls back to older diff scope names.

**Data flow**: It receives a theme. It creates a syntect highlighter, asks for backgrounds for inserted and deleted scopes, and returns a small struct holding the optional RGB values.

**Call relations**: The live-theme wrapper calls this in production, while tests call it with hand-built or loaded themes to verify the extraction rules.

*Call graph*: calls 1 internal fn (scope_background_rgb); called by 5 (diff_scope_background_rgbs, bundled_theme_can_provide_diff_scope_backgrounds, custom_tmtheme_diff_scope_backgrounds_are_resolved, diff_scope_backgrounds_prefer_markup_scope_then_diff_fallback, diff_scope_backgrounds_return_none_when_no_background_scope_matches); 1 external calls (new).


##### `scope_background_rgb`  (lines 295–299)

```
fn scope_background_rgb(highlighter: &Highlighter<'_>, scope_name: &str) -> Option<(u8, u8, u8)>
```

**Purpose**: Looks up the background color for one TextMate scope name. A scope is a label like `markup.inserted` that themes can attach colors to.

**Data flow**: It receives a highlighter and a scope name string. It parses the scope, asks the theme what background that scope would use, and returns the color as red, green, and blue bytes if present.

**Call relations**: diff_scope_background_rgbs_for_theme calls this repeatedly while searching for inserted and deleted diff colors.

*Call graph*: called by 1 (diff_scope_background_rgbs_for_theme); 2 external calls (style_mod_for_stack, new).


##### `foreground_style_for_scopes`  (lines 303–306)

```
fn foreground_style_for_scopes(scope_names: &[&str]) -> Option<Style>
```

**Purpose**: Finds the first foreground text style supplied by the active theme for a list of scope names. Other UI pieces use this to borrow theme colors for labels and tables.

**Data flow**: It receives a list of scope-name strings. It copies the current theme, searches the scopes in order, and returns a ratatui Style if a foreground color is found.

**Call relations**: UI styling code such as label_style, numeric_style, theme_activity_style, and render_table_lines call this to make non-code interface elements match the syntax theme.

*Call graph*: calls 2 internal fn (current_syntax_theme, foreground_style_for_scopes_with_theme); called by 4 (label_style, numeric_style, theme_activity_style, render_table_lines).


##### `foreground_style_for_scopes_with_theme`  (lines 308–315)

```
fn foreground_style_for_scopes_with_theme(theme: &Theme, scope_names: &[&str]) -> Option<Style>
```

**Purpose**: Searches a given theme for a foreground color on one of several scopes. It is the testable core behind foreground_style_for_scopes.

**Data flow**: It receives a theme and ordered scope names. It checks each scope, converts the first found syntect color into a terminal color, and returns a Style with that foreground.

**Call relations**: The live wrapper calls this with the current theme. Tests call it with small artificial themes to confirm first-match behavior.

*Call graph*: called by 3 (foreground_style_for_scopes, foreground_style_for_scopes_reads_matching_theme_scope, foreground_style_for_scopes_uses_first_scope_with_foreground); 1 external calls (new).


##### `configured_theme_name`  (lines 322–335)

```
fn configured_theme_name() -> String
```

**Purpose**: Reports the theme name that should count as configured: a valid user choice if available, otherwise the adaptive default. It ignores temporary live-preview swaps.

**Data flow**: It reads the stored override and Codex home. If the override is a bundled theme or valid custom theme, it returns that name; otherwise it returns the adaptive default name.

**Call relations**: The theme picker calls this to decide which item should appear selected. Tests use it indirectly to ensure unavailable settings fall back cleanly.

*Call graph*: calls 3 internal fn (adaptive_default_theme_name, load_custom_theme, parse_theme_name); called by 2 (build_theme_picker_params, unavailable_configured_theme_falls_back_to_configured_or_default_selection).


##### `resolve_theme_by_name`  (lines 339–352)

```
fn resolve_theme_by_name(name: &str, codex_home: Option<&Path>) -> Option<Theme>
```

**Purpose**: Turns a theme name into a concrete theme object for previews and restores. It returns nothing when neither a bundled nor custom theme exists.

**Data flow**: It receives a name and optional custom-theme home. It tries the bundled theme table first, then tries a custom `.tmTheme` file, and returns the loaded theme if either works.

**Call relations**: Theme-picker events and restore-from-config use this to apply selected names. Tests also use it to fetch built-in and custom themes for color checks.

*Call graph*: calls 2 internal fn (load_custom_theme, parse_theme_name); called by 6 (restore_runtime_theme_from_config, handle_event, ansi_family_themes_use_terminal_palette_colors_not_rgb, bundled_theme_can_provide_diff_scope_backgrounds, custom_tmtheme_diff_scope_backgrounds_are_resolved, unique_foreground_colors_for_theme); 1 external calls (extra).


##### `list_available_themes`  (lines 366–402)

```
fn list_available_themes(codex_home: Option<&Path>) -> Vec<ThemeEntry>
```

**Purpose**: Builds the list of themes the picker can show. It combines bundled themes with valid custom `.tmTheme` files found on disk.

**Data flow**: It receives an optional home directory. It starts with all built-in names, scans `{home}/themes` for parseable `.tmTheme` files, skips invalid files and duplicate names, sorts the result, and returns entries marked as built-in or custom.

**Call relations**: Theme-picker setup calls this to populate choices. Tests call it to check that invalid files are hidden and ordering is stable.

*Call graph*: called by 3 (list_available_themes_excludes_invalid_custom_files, list_available_themes_returns_stable_sorted_order, build_theme_picker_params); 2 external calls (get_theme, read_dir).


##### `ansi_palette_color`  (lines 452–465)

```
fn ansi_palette_color(index: u8) -> RtColor
```

**Purpose**: Converts a terminal palette index into ratatui’s color type. Low indexes become named terminal colors so terminals can apply their usual behavior.

**Data flow**: It receives a number from 0 to 255. Values 0 through 7 become named colors like red or blue, while larger values become indexed terminal colors.

**Call relations**: convert_syntect_color calls this when syntect marks a color as an ANSI palette color instead of a true RGB color.

*Call graph*: called by 1 (convert_syntect_color); 1 external calls (Indexed).


##### `convert_syntect_color`  (lines 481–492)

```
fn convert_syntect_color(color: SyntectColor) -> Option<RtColor>
```

**Purpose**: Converts syntect’s color format into ratatui’s terminal color format. It understands a special alpha-byte convention used by ANSI-style themes.

**Data flow**: It receives a syntect color with red, green, blue, and alpha bytes. Some alpha values mean “use palette index” or “use terminal default”; otherwise it returns an RGB terminal color.

**Call relations**: convert_style uses this while translating each highlighted text span from syntect style data into terminal style data.

*Call graph*: calls 1 internal fn (ansi_palette_color); called by 1 (convert_style); 1 external calls (Rgb).


##### `convert_style`  (lines 498–517)

```
fn convert_style(syn_style: SyntectStyle) -> Style
```

**Purpose**: Turns a syntect style into a ratatui style that the terminal UI can render. It keeps foreground color and bold text, but intentionally avoids backgrounds, italics, and underlines.

**Data flow**: It receives a syntect style. It converts the foreground color, adds bold when requested, skips distracting or poorly supported attributes, and returns a ratatui Style.

**Call relations**: The core highlighter calls this for every colored piece of code. Multiple tests call it directly to lock down color and text-decoration behavior.

*Call graph*: calls 1 internal fn (convert_syntect_color); called by 7 (highlight_to_line_spans_with_theme, convert_style_suppresses_underline, style_conversion_correctness, style_conversion_unexpected_alpha_falls_back_to_rgb, style_conversion_uses_ansi_named_color_when_alpha_is_zero_low_index, style_conversion_uses_indexed_color_when_alpha_is_zero_high_index, style_conversion_uses_terminal_default_when_alpha_is_one); 1 external calls (default).


##### `find_syntax`  (lines 525–561)

```
fn find_syntax(lang: &str) -> Option<&'static SyntaxReference>
```

**Purpose**: Finds the language grammar for a language name or file extension. It also patches common aliases that the bundled grammar set does not recognize directly.

**Data flow**: It receives a language string such as `rust`, `rs`, or `python3`. It normalizes a few aliases, tries token lookup, exact name lookup, case-insensitive name lookup, and extension lookup, then returns the matching grammar if found.

**Call relations**: highlight_to_line_spans_with_theme calls this before trying to highlight code. If it returns nothing, callers fall back to plain text.

*Call graph*: calls 1 internal fn (syntax_set); called by 1 (highlight_to_line_spans_with_theme).


##### `exceeds_highlight_limits`  (lines 577–579)

```
fn exceeds_highlight_limits(total_bytes: usize, total_lines: usize) -> bool
```

**Purpose**: Checks whether a body of text is too large to highlight safely. This protects the UI from slow or memory-heavy highlighting work.

**Data flow**: It receives total byte count and line count. It compares them to fixed limits and returns true when either limit is exceeded.

**Call relations**: Diff rendering calls this before doing repeated per-line highlighting, so it can skip syntax highlighting for oversized changes.

*Call graph*: called by 1 (render_change).


##### `highlight_to_line_spans_with_theme`  (lines 588–629)

```
fn highlight_to_line_spans_with_theme(
    code: &str,
    lang: &str,
    theme: &Theme,
) -> Option<Vec<Vec<Span<'static>>>>
```

**Purpose**: This is the core highlighter. It parses code for a specific language and theme and returns styled spans grouped by source line.

**Data flow**: It receives source code, a language name, and a theme. It rejects empty or oversized input, finds a grammar, highlights each line, strips line-ending characters, converts styles, and returns per-line spans; failure returns nothing.

**Call relations**: The global-theme wrapper calls this in production. Tests and color-palette checks also call it directly with specific themes.

*Call graph*: calls 3 internal fn (convert_style, find_syntax, syntax_set); called by 3 (highlight_to_line_spans, ansi_family_themes_use_terminal_palette_colors_not_rgb, unique_foreground_colors_for_theme); 6 external calls (new, from, raw, styled, new, new).


##### `highlight_to_line_spans`  (lines 634–640)

```
fn highlight_to_line_spans(code: &str, lang: &str) -> Option<Vec<Vec<Span<'static>>>>
```

**Purpose**: Highlights code using the currently active global theme. It is the normal internal path used by public rendering helpers.

**Data flow**: It receives code and a language name. It reads the active theme lock, passes the code and theme to highlight_to_line_spans_with_theme, and returns the optional styled spans.

**Call relations**: highlight_code_to_lines and highlight_code_to_styled_spans call this before deciding whether to render styled text or fall back.

*Call graph*: calls 2 internal fn (highlight_to_line_spans_with_theme, theme_lock); called by 2 (highlight_code_to_lines, highlight_code_to_styled_spans).


##### `highlight_code_to_lines`  (lines 652–666)

```
fn highlight_code_to_lines(code: &str, lang: &str) -> Vec<Line<'static>>
```

**Purpose**: Returns terminal-renderable lines for code, styled when possible and plain when not. Callers can safely render its output without doing their own fallback logic.

**Data flow**: It receives code and a language name. If highlighting succeeds, it turns each group of styled spans into a Line; otherwise it splits the original text into plain Lines, preserving empty input as one empty line.

**Call relations**: Markdown code blocks, bash highlighting, and many tests use this as the friendly public API for code-to-terminal-lines conversion.

*Call graph*: calls 1 internal fn (highlight_to_line_spans); called by 9 (end_codeblock, highlight_bash_to_lines, fallback_trailing_newline_no_phantom_line, highlight_crlf_strips_carriage_return, highlight_empty_string, highlight_markdown_preserves_content, highlight_multiline_python, highlight_rust_has_keyword_style, highlight_unknown_lang_falls_back); 2 external calls (from, new).


##### `highlight_bash_to_lines`  (lines 669–671)

```
fn highlight_bash_to_lines(script: &str) -> Vec<Line<'static>>
```

**Purpose**: Convenience wrapper for highlighting shell scripts as Bash. It keeps older call sites simple and compatible.

**Data flow**: It receives a script string. It passes that script to highlight_code_to_lines with the language fixed to `bash` and returns the resulting Lines.

**Call relations**: Command display and transcript rendering call this when showing shell commands. It delegates all real work to highlight_code_to_lines.

*Call graph*: calls 1 internal fn (highlight_code_to_lines); called by 4 (build_header, command_display_lines, transcript_lines, highlight_bash_preserves_content).


##### `highlight_code_to_styled_spans`  (lines 682–687)

```
fn highlight_code_to_styled_spans(
    code: &str,
    lang: &str,
) -> Option<Vec<Vec<Span<'static>>>>
```

**Purpose**: Returns styled spans for code so another renderer, especially the diff renderer, can combine syntax colors with its own layout. It signals failure with None.

**Data flow**: It receives code and a language name. It tries the active-theme highlighting path and returns per-line styled spans, or None for unknown languages and oversized input.

**Call relations**: Diff preview and snapshot tests call this when they need raw spans rather than complete terminal Lines.

*Call graph*: calls 1 internal fn (highlight_to_line_spans); called by 8 (ui_snapshot_syntax_highlighted_insert_wraps, ui_snapshot_syntax_highlighted_insert_wraps_text, update_diff_preserves_multiline_highlight_state_within_hunk, highlight_code_to_styled_spans_returns_some_for_known, highlight_large_input_falls_back, highlight_many_lines_falls_back, highlight_many_lines_no_trailing_newline_falls_back, render_preview).


##### `tests::write_minimal_tmtheme`  (lines 701–717)

```
fn write_minimal_tmtheme(path: &Path)
```

**Purpose**: Creates a tiny valid custom theme file for tests. It avoids needing real user theme files in the repository.

**Data flow**: It receives a path. It writes a minimal XML `.tmTheme` document to that path and panics if writing fails.

**Call relations**: Custom-theme loading and listing tests call this while building temporary theme directories.

*Call graph*: 1 external calls (write).


##### `tests::write_tmtheme_with_diff_backgrounds`  (lines 719–754)

```
fn write_tmtheme_with_diff_backgrounds(
        path: &Path,
        inserted_scope: &str,
        inserted_background: &str,
        deleted_scope: &str,
        deleted_background: &str,
    )
```

**Purpose**: Creates a test theme file with specific diff insert and delete background colors. This lets tests check custom diff-color extraction.

**Data flow**: It receives a path, two scope names, and two color strings. It formats those values into a `.tmTheme` XML file and writes it to disk.

**Call relations**: The custom diff-background test calls this before resolving the custom theme by name.

*Call graph*: 2 external calls (format!, write).


##### `tests::reconstructed`  (lines 757–768)

```
fn reconstructed(lines: &[Line<'static>]) -> String
```

**Purpose**: Rebuilds plain text from rendered Lines so tests can confirm highlighting did not change the content. Coloring should decorate text, not rewrite it.

**Data flow**: It receives a slice of Lines. It concatenates each line’s span text and joins lines with newline characters, returning the reconstructed string.

**Call relations**: Several highlighting tests use this to compare rendered output back to the original source text.

*Call graph*: 1 external calls (iter).


##### `tests::unique_foreground_colors_for_theme`  (lines 770–787)

```
fn unique_foreground_colors_for_theme(theme_name: &str) -> Vec<String>
```

**Purpose**: Collects the distinct foreground colors produced by one built-in theme on a Rust snippet. It supports tests that verify ANSI-family themes use terminal palette colors.

**Data flow**: It receives a theme name. It resolves that theme, highlights a small Rust program with it, extracts foreground colors from spans, sorts and deduplicates them, and returns debug strings.

**Call relations**: The ANSI palette snapshot test calls this for each ANSI-family theme.

*Call graph*: calls 2 internal fn (highlight_to_line_spans_with_theme, resolve_theme_by_name).


##### `tests::theme_item`  (lines 789–797)

```
fn theme_item(scope: &str, background: Option<(u8, u8, u8)>) -> ThemeItem
```

**Purpose**: Builds a synthetic theme rule with an optional background color for tests. It is a small factory for theme-scope fixtures.

**Data flow**: It receives a scope name and optional RGB background. It parses the scope and returns a ThemeItem whose style contains that background if provided.

**Call relations**: Diff-background tests use this to assemble small in-memory themes without loading files.

*Call graph*: 2 external calls (from_str, default).


##### `tests::theme_item_with_foreground`  (lines 799–812)

```
fn theme_item_with_foreground(scope: &str, foreground: (u8, u8, u8)) -> ThemeItem
```

**Purpose**: Builds a synthetic theme rule with a foreground color for tests. It makes foreground-style lookup tests easy to read.

**Data flow**: It receives a scope name and RGB foreground. It parses the scope and returns a ThemeItem whose style sets that foreground.

**Call relations**: Foreground-style tests use this when creating in-memory themes.

*Call graph*: 2 external calls (from_str, default).


##### `tests::assert_rgb`  (lines 814–819)

```
fn assert_rgb(color: Option<RtColor>, expected: (u8, u8, u8))
```

**Purpose**: Checks that an optional ratatui color is the expected RGB value. It gives tests a compact way to validate converted colors.

**Data flow**: It receives an optional color and expected RGB tuple. It panics if the color is missing or not RGB, otherwise compares the channel values.

**Call relations**: Foreground-style tests call this after asking the theme lookup helper for a Style.

*Call graph*: 2 external calls (assert_eq!, panic!).


##### `tests::highlight_rust_has_keyword_style`  (lines 822–835)

```
fn highlight_rust_has_keyword_style()
```

**Purpose**: Verifies that Rust highlighting both preserves the source text and applies a non-default style to the `fn` keyword.

**Data flow**: It highlights a small Rust snippet, reconstructs the text, finds the span containing `fn`, and asserts that span has color or bold styling.

**Call relations**: This test exercises the public highlight_code_to_lines path and indirectly covers language lookup, theme use, and style conversion.

*Call graph*: calls 1 internal fn (highlight_code_to_lines); 2 external calls (assert!, assert_eq!).


##### `tests::highlight_unknown_lang_falls_back`  (lines 838–852)

```
fn highlight_unknown_lang_falls_back()
```

**Purpose**: Confirms that unknown languages render as plain text instead of failing. This is important because users may type arbitrary code fence labels.

**Data flow**: It highlights text with a fake language name, reconstructs the output, and checks that every span has the default style.

**Call relations**: This test drives highlight_code_to_lines through the fallback branch caused by find_syntax returning no grammar.

*Call graph*: calls 1 internal fn (highlight_code_to_lines); 1 external calls (assert_eq!).


##### `tests::fallback_trailing_newline_no_phantom_line`  (lines 855–867)

```
fn fallback_trailing_newline_no_phantom_line()
```

**Purpose**: Ensures the plain-text fallback does not create an extra empty line just because the input ends with a newline.

**Data flow**: It sends text ending in `\n` through an unknown language fallback and asserts that only the real content line is returned.

**Call relations**: This guards the fallback behavior inside highlight_code_to_lines, especially for Markdown code blocks.

*Call graph*: calls 1 internal fn (highlight_code_to_lines); 1 external calls (assert_eq!).


##### `tests::highlight_empty_string`  (lines 870–874)

```
fn highlight_empty_string()
```

**Purpose**: Checks that empty code still produces one empty renderable line. This prevents callers from having to special-case empty blocks.

**Data flow**: It highlights an empty string as Rust and asserts the output has one line whose reconstructed content is empty.

**Call relations**: This test covers the empty-input fallback in highlight_code_to_lines.

*Call graph*: calls 1 internal fn (highlight_code_to_lines); 1 external calls (assert_eq!).


##### `tests::highlight_bash_preserves_content`  (lines 877–881)

```
fn highlight_bash_preserves_content()
```

**Purpose**: Verifies that Bash command highlighting keeps the command text exactly the same.

**Data flow**: It passes a shell command through highlight_bash_to_lines, reconstructs the result, and compares it to the original script.

**Call relations**: This checks the bash wrapper while also exercising the general code highlighting path.

*Call graph*: calls 1 internal fn (highlight_bash_to_lines); 1 external calls (assert_eq!).


##### `tests::highlight_crlf_strips_carriage_return`  (lines 884–898)

```
fn highlight_crlf_strips_carriage_return()
```

**Purpose**: Ensures Windows-style line endings do not leave stray carriage-return characters in rendered spans.

**Data flow**: It highlights Rust code containing `\r\n` line endings and asserts no output span contains `\r`.

**Call relations**: This test targets the line-ending cleanup inside highlight_to_line_spans_with_theme through the public line API.

*Call graph*: calls 1 internal fn (highlight_code_to_lines); 1 external calls (assert!).


##### `tests::style_conversion_correctness`  (lines 902–926)

```
fn style_conversion_correctness()
```

**Purpose**: Checks the main rules for converting syntect styles into terminal styles. It confirms foreground and bold survive while background and italic do not.

**Data flow**: It builds a syntect style with RGB foreground, background, bold, and italic. It converts it and asserts the expected ratatui style fields.

**Call relations**: This directly tests convert_style, which the highlighter uses for every styled span.

*Call graph*: calls 1 internal fn (convert_style); 2 external calls (assert!, assert_eq!).


##### `tests::convert_style_suppresses_underline`  (lines 929–955)

```
fn convert_style_suppresses_underline()
```

**Purpose**: Confirms underlines from themes are deliberately ignored. Some themes underline common code names, which looks noisy in terminals.

**Data flow**: It builds a syntect style that requests underline, converts it, and asserts the terminal style does not include underline.

**Call relations**: This protects a specific design choice in convert_style.

*Call graph*: calls 1 internal fn (convert_style); 1 external calls (assert!).


##### `tests::style_conversion_uses_ansi_named_color_when_alpha_is_zero_low_index`  (lines 958–976)

```
fn style_conversion_uses_ansi_named_color_when_alpha_is_zero_low_index()
```

**Purpose**: Checks that an ANSI-theme color with a low palette index becomes a named terminal color. This preserves terminal-native color behavior.

**Data flow**: It creates a syntect foreground whose alpha byte marks it as an ANSI index and whose red byte is the index for green, then asserts conversion returns Green.

**Call relations**: This tests convert_style and the special color decoding behind convert_syntect_color.

*Call graph*: calls 1 internal fn (convert_style); 2 external calls (empty, assert_eq!).


##### `tests::style_conversion_uses_indexed_color_when_alpha_is_zero_high_index`  (lines 979–997)

```
fn style_conversion_uses_indexed_color_when_alpha_is_zero_high_index()
```

**Purpose**: Checks that higher ANSI palette indexes become indexed terminal colors. This supports 256-color themes.

**Data flow**: It builds a style with the ANSI-index marker and a high palette number, converts it, and asserts the result is an indexed color.

**Call relations**: This protects the high-index branch used by convert_syntect_color through convert_style.

*Call graph*: calls 1 internal fn (convert_style); 2 external calls (empty, assert!).


##### `tests::style_conversion_uses_terminal_default_when_alpha_is_one`  (lines 1000–1018)

```
fn style_conversion_uses_terminal_default_when_alpha_is_one()
```

**Purpose**: Confirms the special marker for “use the terminal default color” results in no explicit foreground. That lets the terminal decide the color.

**Data flow**: It creates a style with alpha set to the terminal-default marker, converts it, and checks the foreground is absent.

**Call relations**: This directly verifies convert_syntect_color behavior as surfaced through convert_style.

*Call graph*: calls 1 internal fn (convert_style); 2 external calls (empty, assert_eq!).


##### `tests::style_conversion_unexpected_alpha_falls_back_to_rgb`  (lines 1021–1039)

```
fn style_conversion_unexpected_alpha_falls_back_to_rgb()
```

**Purpose**: Checks that unusual alpha values are treated as ordinary RGB colors. This keeps non-ANSI themes working even if they contain semi-transparent-looking values.

**Data flow**: It builds a style with an unexpected alpha byte and RGB channels, converts it, and asserts the RGB channels are preserved.

**Call relations**: This guards the compatibility branch in convert_syntect_color through convert_style.

*Call graph*: calls 1 internal fn (convert_style); 2 external calls (empty, assert!).


##### `tests::ansi_palette_color_maps_ansi_white_to_gray`  (lines 1042–1044)

```
fn ansi_palette_color_maps_ansi_white_to_gray()
```

**Purpose**: Verifies the terminal color index for ANSI white maps to ratatui’s Gray variant. This matches ratatui’s naming for the standard palette.

**Data flow**: It calls ansi_palette_color with index 7 and compares the result to Gray.

**Call relations**: This directly tests one important case in the palette mapping used by convert_syntect_color.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::ansi_family_themes_use_terminal_palette_colors_not_rgb`  (lines 1047–1074)

```
fn ansi_family_themes_use_terminal_palette_colors_not_rgb()
```

**Purpose**: Ensures ANSI-family built-in themes produce terminal palette colors rather than forced RGB colors. This lets those themes respect the user’s terminal palette.

**Data flow**: For each ANSI-family theme, it resolves the theme, highlights Rust code, scans span foregrounds, rejects RGB colors, and confirms at least one explicit non-default color appears.

**Call relations**: This test exercises resolve_theme_by_name and highlight_to_line_spans_with_theme together.

*Call graph*: calls 2 internal fn (highlight_to_line_spans_with_theme, resolve_theme_by_name); 2 external calls (assert!, panic!).


##### `tests::ansi_family_foreground_palette_snapshot`  (lines 1077–1087)

```
fn ansi_family_foreground_palette_snapshot()
```

**Purpose**: Records the set of foreground colors produced by ANSI-family themes. The snapshot helps catch accidental changes in palette behavior.

**Data flow**: It collects unique foreground color strings for each ANSI-family theme, builds a readable text report, and compares it to an approved snapshot.

**Call relations**: It relies on tests::unique_foreground_colors_for_theme, which in turn uses theme resolution and core highlighting.

*Call graph*: 4 external calls (new, assert_snapshot!, format!, unique_foreground_colors_for_theme).


##### `tests::highlight_multiline_python`  (lines 1090–1095)

```
fn highlight_multiline_python()
```

**Purpose**: Verifies that multiline Python highlighting preserves text and line count.

**Data flow**: It highlights a three-line Python snippet, reconstructs the text, and asserts both content and number of lines match expectations.

**Call relations**: This covers the public highlight_code_to_lines path for a common non-Rust language.

*Call graph*: calls 1 internal fn (highlight_code_to_lines); 1 external calls (assert_eq!).


##### `tests::highlight_code_to_styled_spans_returns_none_for_unknown`  (lines 1098–1100)

```
fn highlight_code_to_styled_spans_returns_none_for_unknown()
```

**Purpose**: Checks that the span-oriented API clearly signals an unknown language with None.

**Data flow**: It asks for styled spans using a fake language name and asserts the result is absent.

**Call relations**: This guards the fallback signal used by diff rendering through highlight_code_to_styled_spans.

*Call graph*: 1 external calls (assert!).


##### `tests::highlight_code_to_styled_spans_returns_some_for_known`  (lines 1103–1108)

```
fn highlight_code_to_styled_spans_returns_some_for_known()
```

**Purpose**: Checks that the span-oriented API returns styled data for a known language.

**Data flow**: It highlights a small Rust snippet, asserts the result exists, and checks it contains at least one line of spans.

**Call relations**: This tests highlight_code_to_styled_spans on the success path used by diff previews.

*Call graph*: calls 1 internal fn (highlight_code_to_styled_spans); 1 external calls (assert!).


##### `tests::highlight_markdown_preserves_content`  (lines 1111–1119)

```
fn highlight_markdown_preserves_content()
```

**Purpose**: Ensures Markdown syntax highlighting does not alter nested fence-like content. This matters for displaying Markdown code blocks accurately.

**Data flow**: It highlights a Markdown snippet containing backticks and shell text, reconstructs the output, and compares it exactly to the input.

**Call relations**: This uses highlight_code_to_lines and tests::reconstructed to protect content preservation.

*Call graph*: calls 1 internal fn (highlight_code_to_lines); 2 external calls (assert_eq!, reconstructed).


##### `tests::highlight_large_input_falls_back`  (lines 1122–1128)

```
fn highlight_large_input_falls_back()
```

**Purpose**: Confirms code larger than the byte limit is not highlighted. This prevents expensive work on huge inputs.

**Data flow**: It creates a string just over the maximum byte limit, asks for styled spans, and asserts the result is None.

**Call relations**: This targets the guardrail inside highlight_to_line_spans_with_theme through highlight_code_to_styled_spans.

*Call graph*: calls 1 internal fn (highlight_code_to_styled_spans); 1 external calls (assert!).


##### `tests::highlight_many_lines_falls_back`  (lines 1131–1136)

```
fn highlight_many_lines_falls_back()
```

**Purpose**: Confirms input with too many lines is not highlighted. This protects the UI from slow parsing of very long snippets.

**Data flow**: It creates more than the allowed number of lines, requests styled spans, and asserts highlighting is skipped.

**Call relations**: This checks the line-count guardrail in the highlighting path used by diff rendering.

*Call graph*: calls 1 internal fn (highlight_code_to_styled_spans); 1 external calls (assert!).


##### `tests::highlight_many_lines_no_trailing_newline_falls_back`  (lines 1139–1151)

```
fn highlight_many_lines_no_trailing_newline_falls_back()
```

**Purpose**: Ensures the line limit counts actual lines, not just newline characters. A final line without a newline must still count.

**Data flow**: It builds text with one too many lines but no trailing newline, verifies the line count, and asserts highlighting returns None.

**Call relations**: This protects the precise line-count logic inside highlight_to_line_spans_with_theme.

*Call graph*: calls 1 internal fn (highlight_code_to_styled_spans); 2 external calls (assert!, assert_eq!).


##### `tests::find_syntax_resolves_languages_and_aliases`  (lines 1154–1217)

```
fn find_syntax_resolves_languages_and_aliases()
```

**Purpose**: Verifies the syntax lookup can recognize many common languages, file extensions, and patched aliases.

**Data flow**: It loops through language names, extensions, and aliases, checking that each can be resolved to a syntax grammar.

**Call relations**: This directly protects find_syntax, the gatekeeper for whether highlighting can happen.

*Call graph*: 1 external calls (assert!).


##### `tests::diff_scope_backgrounds_prefer_markup_scope_then_diff_fallback`  (lines 1220–1237)

```
fn diff_scope_backgrounds_prefer_markup_scope_then_diff_fallback()
```

**Purpose**: Checks that diff background extraction prefers `markup.*` scopes and falls back to `diff.*` scopes when needed.

**Data flow**: It creates an in-memory theme with an inserted markup background and a deleted diff background, extracts colors, and compares them to expected RGB values.

**Call relations**: This tests diff_scope_background_rgbs_for_theme with artificial theme rules.

*Call graph*: calls 1 internal fn (diff_scope_background_rgbs_for_theme); 4 external calls (default, default, assert_eq!, vec!).


##### `tests::diff_scope_backgrounds_return_none_when_no_background_scope_matches`  (lines 1240–1254)

```
fn diff_scope_backgrounds_return_none_when_no_background_scope_matches()
```

**Purpose**: Confirms diff color extraction returns no colors when the theme has no relevant insert/delete backgrounds.

**Data flow**: It creates a theme with an unrelated background scope, extracts diff backgrounds, and asserts both inserted and deleted values are absent.

**Call relations**: This guards the fallback behavior of diff_scope_background_rgbs_for_theme.

*Call graph*: calls 1 internal fn (diff_scope_background_rgbs_for_theme); 4 external calls (default, default, assert_eq!, vec!).


##### `tests::foreground_style_for_scopes_reads_matching_theme_scope`  (lines 1257–1268)

```
fn foreground_style_for_scopes_reads_matching_theme_scope()
```

**Purpose**: Verifies foreground-style lookup can read a color from a matching scope.

**Data flow**: It creates a theme with a `keyword` foreground, asks for the `keyword` style, and asserts the RGB color matches.

**Call relations**: This directly tests foreground_style_for_scopes_with_theme with a simple in-memory theme.

*Call graph*: calls 1 internal fn (foreground_style_for_scopes_with_theme); 4 external calls (default, default, assert_rgb, vec!).


##### `tests::foreground_style_for_scopes_uses_first_scope_with_foreground`  (lines 1271–1282)

```
fn foreground_style_for_scopes_uses_first_scope_with_foreground()
```

**Purpose**: Checks that foreground-style lookup searches scopes in order and returns the first one that has a foreground.

**Data flow**: It creates a theme with only a `string` foreground, asks for `keyword` then `string`, and asserts the returned style uses the string color.

**Call relations**: This protects the ordered search behavior in foreground_style_for_scopes_with_theme.

*Call graph*: calls 1 internal fn (foreground_style_for_scopes_with_theme); 4 external calls (default, default, assert_rgb, vec!).


##### `tests::bundled_theme_can_provide_diff_scope_backgrounds`  (lines 1285–1293)

```
fn bundled_theme_can_provide_diff_scope_backgrounds()
```

**Purpose**: Ensures at least one bundled theme exposes diff insert and delete background colors. This confirms the extraction path works on real bundled data.

**Data flow**: It resolves the built-in GitHub theme, extracts diff backgrounds from it, and asserts both inserted and deleted colors exist.

**Call relations**: This combines resolve_theme_by_name with diff_scope_background_rgbs_for_theme.

*Call graph*: calls 2 internal fn (diff_scope_background_rgbs_for_theme, resolve_theme_by_name); 1 external calls (assert!).


##### `tests::custom_tmtheme_diff_scope_backgrounds_are_resolved`  (lines 1296–1318)

```
fn custom_tmtheme_diff_scope_backgrounds_are_resolved()
```

**Purpose**: Verifies custom `.tmTheme` files can provide diff background colors. This supports themed diff rendering for user-installed themes.

**Data flow**: It creates a temporary themes folder, writes a custom theme with diff colors, resolves it by name, extracts backgrounds, and compares RGB values.

**Call relations**: This uses the custom theme writer, resolve_theme_by_name, and diff_scope_background_rgbs_for_theme together.

*Call graph*: calls 2 internal fn (diff_scope_background_rgbs_for_theme, resolve_theme_by_name); 4 external calls (assert_eq!, create_dir, tempdir, write_tmtheme_with_diff_backgrounds).


##### `tests::parse_theme_name_covers_all_variants`  (lines 1321–1378)

```
fn parse_theme_name_covers_all_variants()
```

**Purpose**: Checks that every expected public built-in theme name maps to the correct internal theme identifier.

**Data flow**: It iterates through known name-to-identifier pairs and asserts parse_theme_name returns the expected value for each.

**Call relations**: This directly protects the built-in mapping used by validation and theme resolution.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::parse_theme_name_returns_none_for_unknown`  (lines 1381–1384)

```
fn parse_theme_name_returns_none_for_unknown()
```

**Purpose**: Checks that unknown or empty theme names are not mistaken for bundled themes.

**Data flow**: It calls parse_theme_name with invalid strings and asserts the result is None.

**Call relations**: This guards the failure branch that lets custom-theme lookup or fallback logic run.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::load_custom_theme_from_tmtheme_file`  (lines 1387–1394)

```
fn load_custom_theme_from_tmtheme_file()
```

**Purpose**: Verifies a valid custom theme file can be loaded from the expected folder.

**Data flow**: It creates a temporary home, writes a minimal `.tmTheme` under `themes`, calls load_custom_theme, and asserts a theme is returned.

**Call relations**: This directly tests the custom-theme loading path used by validation and theme resolution.

*Call graph*: calls 1 internal fn (load_custom_theme); 4 external calls (assert!, create_dir, tempdir, write_minimal_tmtheme).


##### `tests::load_custom_theme_returns_none_for_missing`  (lines 1397–1400)

```
fn load_custom_theme_returns_none_for_missing()
```

**Purpose**: Checks that missing custom theme files simply return None rather than crashing.

**Data flow**: It creates an empty temporary directory, asks for a nonexistent theme, and asserts no theme is returned.

**Call relations**: This protects the missing-file behavior of load_custom_theme.

*Call graph*: 2 external calls (assert!, tempdir).


##### `tests::validate_theme_name_none_for_bundled`  (lines 1403–1407)

```
fn validate_theme_name_none_for_bundled()
```

**Purpose**: Ensures bundled theme names never produce configuration warnings.

**Data flow**: It validates known bundled theme names with and without a real home directory and asserts no warning is returned.

**Call relations**: This tests validate_theme_name on the built-in success path.

*Call graph*: 1 external calls (assert!).


##### `tests::validate_theme_name_none_when_no_override`  (lines 1410–1412)

```
fn validate_theme_name_none_when_no_override()
```

**Purpose**: Ensures no warning appears when the user did not configure a theme override.

**Data flow**: It calls validate_theme_name with no name and asserts the result is None.

**Call relations**: This protects the normal default-theme startup path.

*Call graph*: 1 external calls (assert!).


##### `tests::validate_theme_name_warns_for_missing_custom`  (lines 1415–1424)

```
fn validate_theme_name_warns_for_missing_custom()
```

**Purpose**: Checks that a missing custom theme produces a helpful warning mentioning the requested name.

**Data flow**: It validates a custom-looking name in an empty temporary home, unwraps the warning, and checks the message includes the theme name.

**Call relations**: This directly exercises validate_theme_name’s missing-custom-file branch.

*Call graph*: calls 1 internal fn (validate_theme_name); 2 external calls (assert!, tempdir).


##### `tests::validate_theme_name_none_when_custom_file_is_valid`  (lines 1427–1436)

```
fn validate_theme_name_none_when_custom_file_is_valid()
```

**Purpose**: Verifies valid custom theme files do not create startup warnings.

**Data flow**: It writes a minimal valid `.tmTheme` into a temporary themes folder, validates that theme name, and asserts no warning is returned.

**Call relations**: This covers validate_theme_name’s custom-theme success path.

*Call graph*: 4 external calls (assert!, create_dir, tempdir, write_minimal_tmtheme).


##### `tests::validate_theme_name_warns_when_custom_file_is_invalid`  (lines 1439–1455)

```
fn validate_theme_name_warns_when_custom_file_is_invalid()
```

**Purpose**: Checks that a present but unparsable custom theme file produces an actionable warning.

**Data flow**: It writes invalid text to a `.tmTheme` file, validates that name, and asserts the warning says the file could not be loaded.

**Call relations**: This tests the invalid-custom-file branch in validate_theme_name.

*Call graph*: calls 1 internal fn (validate_theme_name); 4 external calls (assert!, create_dir, write, tempdir).


##### `tests::list_available_themes_excludes_invalid_custom_files`  (lines 1458–1479)

```
fn list_available_themes_excludes_invalid_custom_files()
```

**Purpose**: Ensures the theme picker does not list broken custom theme files. Users should only see themes that can actually load.

**Data flow**: It creates one valid and one invalid custom theme file, lists available themes, and asserts only the valid custom theme appears.

**Call relations**: This directly tests list_available_themes with temporary filesystem data.

*Call graph*: calls 1 internal fn (list_available_themes); 5 external calls (assert!, create_dir, write, tempdir, write_minimal_tmtheme).


##### `tests::list_available_themes_returns_stable_sorted_order`  (lines 1482–1503)

```
fn list_available_themes_returns_stable_sorted_order()
```

**Purpose**: Checks that theme listing order is stable and case-insensitive. Stable ordering keeps the picker predictable across platforms.

**Data flow**: It creates several custom themes with mixed names, lists all themes, independently sorts the observed entries the same way, and compares both lists.

**Call relations**: This protects the sorting behavior in list_available_themes.

*Call graph*: calls 1 internal fn (list_available_themes); 4 external calls (assert_eq!, create_dir, tempdir, write_minimal_tmtheme).


##### `tests::parse_theme_name_is_exhaustive`  (lines 1506–1566)

```
fn parse_theme_name_is_exhaustive()
```

**Purpose**: Ensures the local theme-name mapping stays in sync with the themes bundled by two_face. If the dependency adds themes, this test forces an update.

**Data flow**: It asks two_face for all embedded theme variants, checks the expected count, maps all local kebab-case names, and asserts every embedded variant is covered.

**Call relations**: This is a safety net for parse_theme_name and the built-in theme list.

*Call graph*: 3 external calls (theme_names, assert!, assert_eq!).


### `tui/src/markdown_render.rs`

`domain_logic` · `transcript rendering`

The TUI receives assistant messages and other transcript content as Markdown, but the terminal cannot show Markdown directly. This file acts like a typesetter: it reads Markdown events from `pulldown-cmark` (a Markdown parser), builds `ratatui` text lines, applies styles such as bold or code color, and wraps text to the visible terminal width when that width is known. It also keeps terminal hyperlinks attached to the right visible text, even after wrapping. Tables get special care. The renderer first collects the table into rows and cells, then decides whether it can draw a normal aligned table. If the terminal is too narrow, it switches to a key/value layout so the information stays readable instead of becoming a crushed grid. It also detects a parser quirk where following prose can accidentally be swallowed as a table row and moves that prose back out. Local file links are intentionally displayed differently from web links. Instead of showing the Markdown label, the renderer shows the real file path target, possibly shortened relative to the session working directory. Without this file, transcript Markdown would appear raw, wrapped poorly, lose links, or show unreadable tables.

#### Function details

##### `MarkdownStyles::default`  (lines 105–122)

```
fn default() -> Self
```

**Purpose**: Creates the standard visual styles used for rendered Markdown, such as bold headings, cyan code, underlined links, and green blockquotes.

**Data flow**: It takes no input, builds a `MarkdownStyles` value from default `ratatui` styles plus colors and text effects, and returns that style set.

**Call relations**: A new `Writer` calls this during setup so every later Markdown event can ask for the right style when drawing text.

*Call graph*: called by 1 (new); 1 external calls (new).


##### `IndentContext::new`  (lines 133–139)

```
fn new(prefix: Vec<Span<'static>>, marker: Option<Vec<Span<'static>>>, is_list: bool) -> Self
```

**Purpose**: Builds one indentation rule for nested structures like lists, blockquotes, and code blocks.

**Data flow**: It receives prefix spans, an optional list marker, and a flag saying whether this context is a list, then stores them together for later line prefixing.

**Call relations**: List items, blockquotes, and code blocks call this when they begin so later output lines know what leading text, such as `> ` or `- `, should be added.

*Call graph*: called by 3 (start_blockquote, start_codeblock, start_item).


##### `TableCell::ensure_line`  (lines 155–159)

```
fn ensure_line(&mut self)
```

**Purpose**: Makes sure a table cell has at least one line ready before content is appended.

**Data flow**: It reads the cell's current line list; if it is empty, it adds a blank `HyperlinkLine`. It returns nothing but changes the cell.

**Call relations**: Cell-writing helpers call this before adding styled spans or annotated hyperlink content, so table cell content always has a place to go.

*Call graph*: calls 1 internal fn (new); called by 2 (push_annotated, push_span); 1 external calls (default).


##### `TableCell::push_span`  (lines 162–167)

```
fn push_span(&mut self, span: Span<'static>)
```

**Purpose**: Adds one styled piece of visible text to the current line of a table cell.

**Data flow**: It receives a span, creates the first line if needed, and appends the span to the cell's last line.

**Call relations**: Markdown text, inline code, and tests use this simple path when no hyperlink remapping is needed.

*Call graph*: calls 1 internal fn (ensure_line).


##### `TableCell::push_annotated`  (lines 169–180)

```
fn push_annotated(&mut self, mut appended: HyperlinkLine)
```

**Purpose**: Adds a line fragment that may contain terminal hyperlinks into a table cell while keeping link positions correct.

**Data flow**: It receives a `HyperlinkLine`, measures the existing cell line width, appends the new spans, shifts every incoming hyperlink range by that width, and stores them in the cell.

**Call relations**: The table text renderer uses this when text in a table cell contains web URLs or explicit Markdown links.

*Call graph*: calls 1 internal fn (ensure_line).


##### `TableCell::hard_break`  (lines 183–185)

```
fn hard_break(&mut self)
```

**Purpose**: Starts a new logical line inside a table cell, matching a Markdown hard break or multi-line HTML/text content.

**Data flow**: It appends a blank `HyperlinkLine` to the cell. Later content will be written on that new line.

**Call relations**: Markdown break handling and table-cell HTML/text helpers call this so multi-line table cells keep their intended breaks.

*Call graph*: calls 1 internal fn (new); 1 external calls (default).


##### `TableCell::plain_text`  (lines 187–199)

```
fn plain_text(&self) -> String
```

**Purpose**: Creates an unstyled text-only version of a table cell for measuring and classification.

**Data flow**: It walks all lines and spans in the cell, joins line breaks as spaces, and returns one plain string.

**Call relations**: Table layout code uses this text when deciding column widths, identifying long-token columns, and detecting spillover rows.

*Call graph*: called by 2 (render_aligned_field, render_stacked_field); 2 external calls (new, write!).


##### `TableState::new`  (lines 226–236)

```
fn new(alignments: Vec<Alignment>) -> Self
```

**Purpose**: Starts an empty table accumulator when the Markdown parser enters a table.

**Data flow**: It receives the table's column alignments and returns a state object with no header, no rows, and no active cell yet.

**Call relations**: The writer creates this at table start; later table-head, row, and cell events fill it until table end renders it.

*Call graph*: called by 1 (start_table); 1 external calls (new).


##### `render_markdown_text`  (lines 287–289)

```
fn render_markdown_text(input: &str) -> Text<'static>
```

**Purpose**: Renders Markdown into terminal text when no specific terminal width is available.

**Data flow**: It receives a Markdown string, passes it to the width-aware renderer with no width, and returns `ratatui` `Text`.

**Call relations**: Tests and callers that do not know the viewport use this convenience function; it delegates all real work to the width-aware path.

*Call graph*: calls 1 internal fn (render_markdown_text_with_width); called by 72 (vt100_deep_nested_mixed_list_third_level_marker_is_colored, crlf_code_block_no_extra_blank_lines, fenced_code_info_string_with_metadata_highlights, blockquote_heading_inherits_heading_style, blockquote_in_ordered_list_on_next_line, blockquote_in_unordered_list_on_next_line, blockquote_inside_nested_list, blockquote_list_then_nested_blockquote, blockquote_multiple_with_break, blockquote_nested_two_levels (+15 more)).


##### `render_markdown_text_with_width`  (lines 298–301)

```
fn render_markdown_text_with_width(input: &str, width: Option<usize>) -> Text<'static>
```

**Purpose**: Renders Markdown while respecting a known terminal width, using the process's current directory for local file-link display.

**Data flow**: It receives Markdown and an optional width, reads the current working directory if available, then returns styled `Text` from the fuller renderer.

**Call relations**: This is the common public-width entry used by tests and rendering helpers; it passes control to the version that accepts an explicit working directory.

*Call graph*: calls 1 internal fn (render_markdown_text_with_width_and_cwd); called by 20 (render_markdown_text, does_not_split_long_url_like_token_without_scheme, does_not_wrap_code_blocks, wraps_blockquotes, wraps_blockquotes_inside_lists, wraps_list_items_containing_blockquotes, wraps_list_items_preserving_indent, wraps_nested_lists, wraps_ordered_lists, wraps_plain_text_when_width_provided (+10 more)); 1 external calls (current_dir).


##### `render_markdown_text_with_width_and_cwd`  (lines 308–316)

```
fn render_markdown_text_with_width_and_cwd(
    input: &str,
    width: Option<usize>,
    cwd: Option<&Path>,
) -> Text<'static>
```

**Purpose**: Renders Markdown to visible terminal text using both a width and a chosen working directory.

**Data flow**: It receives Markdown, optional width, and optional cwd, renders hyperlink-aware lines, removes or exposes visible lines as needed, and wraps them into `Text`.

**Call relations**: Higher-level transcript rendering calls this when it knows the session directory, so local file links are displayed consistently.

*Call graph*: calls 2 internal fn (render_markdown_lines_with_width_and_cwd, visible_lines); called by 8 (append_markdown, append_markdown_agent, render_markdown_text_with_width, consecutive_unordered_list_local_file_links_do_not_detach_paths, render_markdown_text_for_cwd, table_wraps_file_paths_before_collapsing_narrative_columns_snapshot, unordered_list_local_file_link_soft_break_before_colon_stays_inline, unordered_list_local_file_link_stays_inline_with_following_text); 1 external calls (from).


##### `render_markdown_lines_with_width_and_cwd`  (lines 318–330)

```
fn render_markdown_lines_with_width_and_cwd(
    input: &str,
    width: Option<usize>,
    cwd: Option<&Path>,
) -> Vec<HyperlinkLine>
```

**Purpose**: Renders Markdown into hyperlink-aware lines before they are converted to plain visible `ratatui` text.

**Data flow**: It enables Markdown options for tables and strikethrough, creates the parser, feeds events into a `Writer`, runs it, and returns the writer's finished lines.

**Call relations**: This is the main bridge from parsed Markdown events into the `Writer`; callers that need hyperlink metadata use it directly.

*Call graph*: calls 2 internal fn (new, new); called by 10 (render_markdown_agent_with_links_and_cwd, render_markdown_text_with_width_and_cwd, annotates_explicit_web_link_label_and_visible_destination, does_not_annotate_code_or_non_web_markdown_links, key_value_table_keeps_web_annotations, pipe_table_fallback_keeps_web_annotations, wrapped_table_url_fragments_keep_complete_web_destination, bare_url_with_tilde_keeps_complete_hyperlink, merged_text_events_preserve_entity_decoding, table_url_with_tilde_keeps_complete_hyperlink); 2 external calls (empty, new_ext).


##### `should_render_link_destination`  (lines 343–345)

```
fn should_render_link_destination(dest_url: &str) -> bool
```

**Purpose**: Decides whether a link should show its destination text after the label.

**Data flow**: It receives a destination string and returns false for local path-like links, true for normal non-local links.

**Call relations**: When a link starts, `Writer::push_link` uses this to choose between web-link display rules and local-file display rules.

*Call graph*: calls 1 internal fn (is_local_path_like_link); called by 1 (push_link).


##### `Writer::new`  (lines 404–433)

```
fn new(input: &'a str, iter: I, wrap_width: Option<usize>, cwd: Option<&Path>) -> Self
```

**Purpose**: Creates the stateful Markdown event writer that will build terminal lines.

**Data flow**: It receives the original Markdown, an event iterator, optional wrap width, and optional cwd, then initializes style stacks, indentation stacks, table state, link state, and output buffers.

**Call relations**: The line-rendering entry function constructs one writer and then calls `Writer::run` to consume the Markdown events.

*Call graph*: calls 1 internal fn (default); called by 1 (render_markdown_lines_with_width_and_cwd); 3 external calls (new, default, new).


##### `Writer::run`  (lines 435–440)

```
fn run(&mut self)
```

**Purpose**: Consumes every Markdown event and finishes any partially built line.

**Data flow**: It repeatedly pulls events from the parser iterator, sends each to `handle_event`, then flushes the last current line into output.

**Call relations**: This is the writer's main loop, called once after construction by the Markdown-line rendering function.

*Call graph*: calls 2 internal fn (flush_current_line, handle_event); 1 external calls (next).


##### `Writer::handle_event`  (lines 442–464)

```
fn handle_event(&mut self, event: Event<'a>, range: Range<usize>)
```

**Purpose**: Dispatches one parsed Markdown event to the specific logic for that event type.

**Data flow**: It receives an event and source range, resolves any pending local-link soft-break behavior, then calls the matching start, end, text, code, break, rule, or HTML handler.

**Call relations**: The run loop calls this for every parser event; it is the switchboard that routes Markdown structure to the writer's specialized methods.

*Call graph*: calls 11 internal fn (code, end_tag, flush_current_line, hard_break, html, prepare_for_event, push_blank_line, push_line, soft_break, start_tag (+1 more)); called by 1 (run); 1 external calls (from).


##### `Writer::prepare_for_event`  (lines 466–481)

```
fn prepare_for_event(&mut self, event: &Event<'a>)
```

**Purpose**: Deals with a delayed soft break after a local file link before the next event is processed.

**Data flow**: It checks whether a soft break was held back. If the next text starts with a colon, it keeps the content inline; otherwise it inserts a blank line.

**Call relations**: Called at the start of event handling so local file-link list items do not split awkwardly before descriptions like `: changed file`.

*Call graph*: calls 1 internal fn (push_line); called by 1 (handle_event); 2 external calls (default, matches!).


##### `Writer::start_tag`  (lines 483–514)

```
fn start_tag(&mut self, tag: Tag<'a>, range: Range<usize>)
```

**Purpose**: Handles the beginning of a Markdown structure such as a paragraph, heading, list item, link, code block, or table.

**Data flow**: It receives a start tag and its source range, then updates writer state or starts collecting content for the corresponding structure.

**Call relations**: The event dispatcher calls this for `Event::Start`; it hands work to structure-specific methods like `start_table` or `start_heading`.

*Call graph*: calls 12 internal fn (push_inline_style, push_link, start_blockquote, start_codeblock, start_heading, start_item, start_list, start_paragraph, start_table, start_table_cell (+2 more)); called by 1 (handle_event); 1 external calls (from).


##### `Writer::end_tag`  (lines 516–545)

```
fn end_tag(&mut self, tag: TagEnd)
```

**Purpose**: Handles the end of a Markdown structure and closes any state opened by `start_tag`.

**Data flow**: It receives an end tag, flushes or updates the relevant state, pops styles or indentation, and may render accumulated structures such as tables or code blocks.

**Call relations**: The event dispatcher calls this for `Event::End`; it pairs with `start_tag` to keep nesting and output boundaries correct.

*Call graph*: calls 12 internal fn (end_blockquote, end_codeblock, end_heading, end_list, end_paragraph, end_table, end_table_cell, end_table_head, end_table_row, flush_current_line (+2 more)); called by 1 (handle_event).


##### `Writer::start_paragraph`  (lines 547–557)

```
fn start_paragraph(&mut self)
```

**Purpose**: Begins a normal paragraph outside tables.

**Data flow**: It checks whether rendering is currently inside a table cell. If not, it inserts needed spacing, starts a new line, and marks paragraph mode active.

**Call relations**: Called when a paragraph tag starts; it prepares the current output line before text events arrive.

*Call graph*: calls 3 internal fn (in_table_cell, push_blank_line, push_line); called by 1 (start_tag); 1 external calls (default).


##### `Writer::end_paragraph`  (lines 559–566)

```
fn end_paragraph(&mut self)
```

**Purpose**: Marks the end of a paragraph so following block content gets separated correctly.

**Data flow**: It ignores table cells, otherwise records that a newline is needed and clears paragraph/list-marker state.

**Call relations**: Called from end-tag handling after paragraph content has been written.

*Call graph*: calls 1 internal fn (in_table_cell); called by 1 (end_tag).


##### `Writer::start_heading`  (lines 568–588)

```
fn start_heading(&mut self, level: HeadingLevel)
```

**Purpose**: Begins a Markdown heading with visible `#` marker text and heading style.

**Data flow**: It receives the heading level, chooses the matching style, starts a line containing the right number of `#` characters, and pushes that style for heading text.

**Call relations**: Start-tag handling calls this for headings; later text events use the pushed style until `end_heading` pops it.

*Call graph*: calls 3 internal fn (in_table_cell, push_inline_style, push_line); called by 1 (start_tag); 4 external calls (default, from, format!, vec!).


##### `Writer::end_heading`  (lines 590–596)

```
fn end_heading(&mut self)
```

**Purpose**: Closes heading mode after the heading text has been written.

**Data flow**: It ignores table cells, otherwise marks that a new line is needed and removes the heading style from the inline style stack.

**Call relations**: End-tag handling calls this to balance `start_heading`.

*Call graph*: calls 2 internal fn (in_table_cell, pop_inline_style); called by 1 (end_tag).


##### `Writer::start_blockquote`  (lines 598–611)

```
fn start_blockquote(&mut self)
```

**Purpose**: Starts a blockquote by adding a `> ` prefix context.

**Data flow**: It inserts spacing if needed, then pushes an indentation context whose prefix is `> `.

**Call relations**: Called from start-tag handling; later line creation reads the indentation stack so quoted lines receive the prefix and quote style.

*Call graph*: calls 3 internal fn (new, in_table_cell, push_blank_line); called by 1 (start_tag); 1 external calls (vec!).


##### `Writer::end_blockquote`  (lines 613–619)

```
fn end_blockquote(&mut self)
```

**Purpose**: Ends the current blockquote.

**Data flow**: It ignores table cells, otherwise removes the blockquote indentation context and marks that a newline is needed.

**Call relations**: End-tag handling calls this to balance `start_blockquote`.

*Call graph*: calls 1 internal fn (in_table_cell); called by 1 (end_tag).


##### `Writer::text`  (lines 621–673)

```
fn text(&mut self, text: CowStr<'a>)
```

**Purpose**: Writes normal Markdown text to the current output location.

**Data flow**: It receives parsed text, skips it if it is the label of a local file link, sends it to a table cell if inside one, buffers it for syntax-highlighted code blocks when needed, or writes styled/wrapped text lines otherwise.

**Call relations**: The event dispatcher calls this for text events; it feeds either table-cell helpers or regular line helpers depending on current state.

*Call graph*: calls 5 internal fn (in_table_cell, push_line, push_text_spans, push_text_to_table_cell, suppressing_local_link_label); called by 1 (handle_event); 2 external calls (lines, default).


##### `Writer::code`  (lines 675–691)

```
fn code(&mut self, code: CowStr<'a>)
```

**Purpose**: Writes inline code text with the code style.

**Data flow**: It receives code content, suppresses local-link labels if needed, then either appends a styled span to the current table cell or to the current normal line.

**Call relations**: The event dispatcher calls this for inline code events; it uses the same table-vs-normal split as plain text.

*Call graph*: calls 5 internal fn (in_table_cell, push_line, push_span, push_span_to_table_cell, suppressing_local_link_label); called by 1 (handle_event); 3 external calls (into_string, default, from).


##### `Writer::html`  (lines 693–724)

```
fn html(&mut self, html: CowStr<'a>, inline: bool)
```

**Purpose**: Writes Markdown HTML content as visible text rather than interpreting it as real terminal markup.

**Data flow**: It receives HTML text and a flag saying whether it is inline. It writes each line with the current style, adding hard breaks for block HTML when appropriate.

**Call relations**: The event dispatcher calls this for HTML events; table-cell HTML is routed through table-cell helpers so it remains inside the table.

*Call graph*: calls 6 internal fn (in_table_cell, push_line, push_span, push_span_to_table_cell, push_table_cell_hard_break, suppressing_local_link_label); called by 1 (handle_event); 3 external calls (lines, default, styled).


##### `Writer::hard_break`  (lines 726–736)

```
fn hard_break(&mut self)
```

**Purpose**: Implements a Markdown hard line break.

**Data flow**: It skips suppressed local-link labels, then either starts a new line inside the active table cell or starts a new output line.

**Call relations**: The event dispatcher calls this for hard-break events.

*Call graph*: calls 4 internal fn (in_table_cell, push_line, push_table_cell_hard_break, suppressing_local_link_label); called by 1 (handle_event); 1 external calls (default).


##### `Writer::soft_break`  (lines 738–754)

```
fn soft_break(&mut self)
```

**Purpose**: Implements a Markdown soft line break with special handling after local file links.

**Data flow**: It writes a space inside table cells, delays the break if it follows a local file-link target, or otherwise starts a new output line.

**Call relations**: The event dispatcher calls this for soft-break events; `prepare_for_event` later decides whether a delayed local-link break should become a real line break.

*Call graph*: calls 4 internal fn (in_table_cell, push_line, push_span_to_table_cell, suppressing_local_link_label); called by 1 (handle_event); 2 external calls (default, styled).


##### `Writer::start_list`  (lines 756–762)

```
fn start_list(&mut self, index: Option<u64>)
```

**Purpose**: Starts an ordered or unordered list and records its numbering state.

**Data flow**: It receives an optional starting number, adds spacing if this is a top-level list after previous content, and pushes list counters and blank-line tracking state.

**Call relations**: Called when a list tag starts; list item rendering later reads and updates this state.

*Call graph*: calls 1 internal fn (push_line); called by 1 (start_tag); 1 external calls (default).


##### `Writer::end_list`  (lines 764–768)

```
fn end_list(&mut self)
```

**Purpose**: Ends the current list.

**Data flow**: It removes the current list counter and blank-line flag, then marks that later block content should begin on a new line.

**Call relations**: End-tag handling calls this when the Markdown list closes.

*Call graph*: called by 1 (end_tag).


##### `Writer::start_item`  (lines 770–818)

```
fn start_item(&mut self)
```

**Purpose**: Starts one list item and prepares its bullet or number marker.

**Data flow**: It handles any blank line needed between multi-line items, flushes current output, records where the item begins, computes the visible marker and indentation, and pushes an indentation context.

**Call relations**: Called from start-tag handling for list items; when the item ends, end-tag handling pops the context and may request blank spacing before the next item.

*Call graph*: calls 3 internal fn (new, flush_current_line, push_blank_line); called by 1 (start_tag); 2 external calls (new, vec!).


##### `Writer::start_codeblock`  (lines 820–845)

```
fn start_codeblock(&mut self, lang: Option<String>, indent: Option<Span<'static>>)
```

**Purpose**: Starts a fenced or indented code block and prepares either syntax highlighting or plain code output.

**Data flow**: It receives an optional language and optional indent span, flushes prior content, adds spacing, extracts a clean language token, clears the code buffer, and pushes code indentation.

**Call relations**: Start-tag handling calls this for code blocks; text events may be buffered until `end_codeblock` performs highlighting.

*Call graph*: calls 3 internal fn (new, flush_current_line, push_blank_line); called by 1 (start_tag); 1 external calls (vec!).


##### `Writer::end_codeblock`  (lines 847–865)

```
fn end_codeblock(&mut self)
```

**Purpose**: Finishes a code block and emits buffered highlighted code if a language was known.

**Data flow**: It takes the buffered code, asks the highlighter for styled lines, writes those spans, then clears code-block state and removes the code indentation context.

**Call relations**: End-tag handling calls this when the parser leaves a code block.

*Call graph*: calls 3 internal fn (push_line, push_span, highlight_code_to_lines); called by 1 (end_tag); 2 external calls (default, take).


##### `Writer::start_table`  (lines 867–874)

```
fn start_table(&mut self, alignments: Vec<Alignment>)
```

**Purpose**: Begins collecting a Markdown table instead of immediately writing lines.

**Data flow**: It flushes current output, inserts spacing if needed, and creates a `TableState` with the table alignments.

**Call relations**: Start-tag handling calls this for table tags; later table row and cell events fill the state until `end_table` renders it.

*Call graph*: calls 3 internal fn (new, flush_current_line, push_blank_line); called by 1 (start_tag).


##### `Writer::end_table`  (lines 876–902)

```
fn end_table(&mut self)
```

**Purpose**: Turns the collected table state into output lines.

**Data flow**: It takes the active `TableState`, asks `render_table_lines` to lay it out, then pushes prewrapped table lines and any extracted spillover prose into the transcript.

**Call relations**: End-tag handling calls this for table close; it is where accumulated table events become visible terminal output.

*Call graph*: calls 4 internal fn (flush_current_line, push_hyperlink_line, push_prewrapped_line, render_table_lines); called by 1 (end_tag).


##### `Writer::start_table_head`  (lines 904–909)

```
fn start_table_head(&mut self)
```

**Purpose**: Marks that following table row events belong to the table header.

**Data flow**: It sets the table state to header mode and starts an empty current row.

**Call relations**: Called by start-tag handling inside a table before header cell events arrive.

*Call graph*: called by 1 (start_tag); 1 external calls (new).


##### `Writer::end_table_head`  (lines 911–925)

```
fn end_table_head(&mut self)
```

**Purpose**: Stores the completed header row in the table state.

**Data flow**: It flushes any open current cell into the current row, moves the row into the header field, and leaves header mode.

**Call relations**: Called by end-tag handling after the header section of a table.

*Call graph*: called by 1 (end_tag).


##### `Writer::start_table_row`  (lines 927–933)

```
fn start_table_row(&mut self, source_range: Range<usize>)
```

**Purpose**: Starts collecting one table row and notes whether the source text used boundary pipes.

**Data flow**: It receives the source range, checks the original Markdown for leading or trailing pipe characters, and creates an empty current row in the table state.

**Call relations**: Start-tag handling calls this for every table row; the pipe-syntax flag later helps detect parser spillover rows.

*Call graph*: calls 1 internal fn (has_table_row_boundary_pipe); called by 1 (start_tag); 1 external calls (new).


##### `Writer::has_table_row_boundary_pipe`  (lines 935–941)

```
fn has_table_row_boundary_pipe(&self, source_range: Range<usize>) -> bool
```

**Purpose**: Checks whether a parsed table row looked like an explicit pipe table row in the source Markdown.

**Data flow**: It receives a source range, slices the original input, trims it, and returns whether it starts or ends with `|`.

**Call relations**: Used only when starting a table row, and its result is stored for later spillover detection.

*Call graph*: called by 1 (start_table_row).


##### `Writer::end_table_row`  (lines 943–968)

```
fn end_table_row(&mut self)
```

**Purpose**: Stores the completed table row as either the header or a body row.

**Data flow**: It flushes any current cell into the current row, then moves that row into the header or body list, carrying the pipe-syntax flag for body rows.

**Call relations**: End-tag handling calls this at row close; `render_table_lines` later consumes the stored rows.

*Call graph*: called by 1 (end_tag).


##### `Writer::start_table_cell`  (lines 970–974)

```
fn start_table_cell(&mut self)
```

**Purpose**: Starts collecting styled content for one table cell.

**Data flow**: It creates an empty `TableCell` in the active table state.

**Call relations**: Start-tag handling calls this before text, code, link, or HTML events that belong inside the cell.

*Call graph*: called by 1 (start_tag); 1 external calls (default).


##### `Writer::end_table_cell`  (lines 976–987)

```
fn end_table_cell(&mut self)
```

**Purpose**: Finishes the current table cell and appends it to the current row.

**Data flow**: It takes the active cell, creates a row if needed, and pushes the cell into that row.

**Call relations**: End-tag handling calls this after all events for a table cell have arrived.

*Call graph*: called by 1 (end_tag).


##### `Writer::in_table_cell`  (lines 989–994)

```
fn in_table_cell(&self) -> bool
```

**Purpose**: Answers whether the writer is currently collecting content inside a table cell.

**Data flow**: It checks whether table state exists and has an active current cell, then returns a boolean.

**Call relations**: Many event handlers call this to decide whether to write to normal transcript lines or to the table accumulator.

*Call graph*: called by 12 (code, end_blockquote, end_heading, end_paragraph, hard_break, html, pop_link, soft_break, start_blockquote, start_heading (+2 more)).


##### `Writer::push_span_to_table_cell`  (lines 996–1002)

```
fn push_span_to_table_cell(&mut self, span: Span<'static>)
```

**Purpose**: Adds a styled span directly to the active table cell.

**Data flow**: It receives a span, finds the active cell if one exists, and appends the span there.

**Call relations**: Inline code, HTML, link closing, and soft-break handling use this while inside table cells.

*Call graph*: called by 4 (code, html, pop_link, soft_break).


##### `Writer::push_table_cell_hard_break`  (lines 1004–1010)

```
fn push_table_cell_hard_break(&mut self)
```

**Purpose**: Adds a hard line break inside the active table cell.

**Data flow**: It finds the active cell and asks it to start a new internal line.

**Call relations**: Hard-break, HTML, and multi-line text handling call this when cell content must split across lines.

*Call graph*: called by 3 (hard_break, html, push_text_to_table_cell).


##### `Writer::push_text_to_table_cell`  (lines 1012–1020)

```
fn push_text_to_table_cell(&mut self, text: &str)
```

**Purpose**: Writes plain text into the current table cell while preserving source line breaks.

**Data flow**: It receives text, gets the current inline style, splits text into lines, inserts table-cell hard breaks between them, and sends each line to the annotated table-cell writer.

**Call relations**: The main text handler calls this whenever text arrives while a table cell is active.

*Call graph*: calls 2 internal fn (push_table_cell_hard_break, push_text_spans_to_table_cell); called by 1 (text).


##### `Writer::push_text_spans_to_table_cell`  (lines 1022–1042)

```
fn push_text_spans_to_table_cell(&mut self, text: &str, style: Style)
```

**Purpose**: Writes one line of text into a table cell, adding hyperlink annotations when appropriate.

**Data flow**: It receives text and style, turns it into a span, attaches an explicit web-link destination or detects bare web URLs unless links/code should suppress that, then appends the annotated content to the current cell.

**Call relations**: Used by table-cell text writing so links inside tables keep working after table wrapping.

*Call graph*: calls 2 internal fn (new, annotate_web_urls_in_line); called by 1 (push_text_to_table_cell); 4 external calls (default, from, styled, take).


##### `Writer::render_table_lines`  (lines 1055–1177)

```
fn render_table_lines(&self, mut table_state: TableState) -> RenderedTableLines
```

**Purpose**: Converts a completed table into readable terminal lines.

**Data flow**: It receives a `TableState`, separates accidental spillover prose, normalizes row widths, measures columns, computes available width, chooses aligned-table, key/value, or raw-pipe fallback layout, and returns table lines plus spillover lines.

**Call relations**: `end_table` calls this once the parser closes a table; it coordinates table measurement, rendering, and fallback helpers.

*Call graph*: calls 9 internal fn (available_record_width, available_table_width, compute_column_widths, render_table_pipe_fallback, render_table_row, render_records, should_render_records, foreground_style_for_scopes, table_separator_style); called by 1 (end_table); 7 external calls (collect_table_column_metrics, is_spillover_row, normalize_row, render_table_separator, default, new, with_capacity).


##### `Writer::normalize_row`  (lines 1179–1182)

```
fn normalize_row(row: &mut Vec<TableCell>, column_count: usize)
```

**Purpose**: Forces a table row to have exactly the expected number of cells.

**Data flow**: It receives a mutable row and column count, truncates extra cells, and adds empty cells if the row is short.

**Call relations**: Table rendering calls this before measuring so every row can be indexed safely by column.

*Call graph*: 1 external calls (default).


##### `Writer::available_table_width`  (lines 1185–1194)

```
fn available_table_width(&self, column_count: usize) -> Option<usize>
```

**Purpose**: Calculates how much horizontal space is available for table cell contents.

**Data flow**: It starts from the wrap width, subtracts current indentation, column gaps, and cell padding, and returns the remaining width if a wrap width exists.

**Call relations**: `render_table_lines` uses this budget when deciding whether an aligned table can fit.

*Call graph*: called by 1 (render_table_lines).


##### `Writer::available_record_width`  (lines 1197–1203)

```
fn available_record_width(&self) -> Option<usize>
```

**Purpose**: Calculates the width available for key/value table fallback records.

**Data flow**: It starts from the wrap width, subtracts only the current line prefix, and returns the remaining content width.

**Call relations**: `render_table_lines` passes this to the key/value renderer when a normal grid would be unreadable.

*Call graph*: called by 1 (render_table_lines).


##### `Writer::compute_column_widths`  (lines 1212–1276)

```
fn compute_column_widths(
        &self,
        header: &[TableCell],
        rows: &[Vec<TableCell>],
        alignments: &[Alignment],
        available_width: Option<usize>,
    ) -> Option<Vec<us
```

**Purpose**: Chooses table column widths that fit the terminal while trying to keep content readable.

**Data flow**: It receives header cells, body rows, alignments, and an optional width budget. It starts with natural widths, computes preferred floors, shrinks columns by priority, and returns widths or `None` if even minimum columns cannot fit.

**Call relations**: `render_table_lines` calls this before choosing between aligned rendering and fallback layouts.

*Call graph*: called by 1 (render_table_lines); 3 external calls (len, collect_table_column_metrics, next_column_to_shrink).


##### `Writer::collect_table_column_metrics`  (lines 1278–1343)

```
fn collect_table_column_metrics(
        header: &[TableCell],
        rows: &[Vec<TableCell>],
        column_count: usize,
    ) -> Vec<TableColumnMetrics>
```

**Purpose**: Measures each table column and classifies it as prose, token-heavy, or compact.

**Data flow**: It reads header and body cells, measures widest content and longest tokens, counts words, and returns per-column metrics used by width allocation.

**Call relations**: Both table rendering and column-width computation use these metrics to decide which columns should shrink first.

*Call graph*: 3 external calls (cell_display_width, longest_token_width, with_capacity).


##### `Writer::preferred_column_floor`  (lines 1351–1359)

```
fn preferred_column_floor(metrics: &TableColumnMetrics, min_column_width: usize) -> usize
```

**Purpose**: Chooses a soft minimum width for one table column before aggressive shrinking starts.

**Data flow**: It receives column metrics and a hard minimum, then returns a width based on column kind and token sizes, clamped to the column's actual maximum.

**Call relations**: `compute_column_widths` uses this floor so compact values and readable prose are not crushed too early.


##### `Writer::next_column_to_shrink`  (lines 1366–1383)

```
fn next_column_to_shrink(
        widths: &[usize],
        floors: &[usize],
        metrics: &[TableColumnMetrics],
    ) -> Option<usize>
```

**Purpose**: Selects which table column should lose one character of width next.

**Data flow**: It receives current widths, floors, and metrics, filters to columns above their floor, and returns the best candidate based on shrink priority and slack.

**Call relations**: `compute_column_widths` repeatedly calls this until the table fits or no more useful shrinking is possible.


##### `Writer::column_shrink_priority`  (lines 1385–1391)

```
fn column_shrink_priority(kind: TableColumnKind) -> usize
```

**Purpose**: Ranks table column kinds for width reduction.

**Data flow**: It receives a column kind and returns a numeric priority: token-heavy columns shrink first, narrative next, compact last.

**Call relations**: Column-width helpers use this ranking to protect short status-like values and readable prose from being squeezed too soon.


##### `Writer::render_table_separator`  (lines 1393–1406)

```
fn render_table_separator(
        column_widths: &[usize],
        separator_char: char,
        style: Style,
    ) -> HyperlinkLine
```

**Purpose**: Builds a styled horizontal separator line for a rendered table.

**Data flow**: It receives column widths, a separator character, and a style, creates repeated segments with padding and gaps, and returns a hyperlink-free line.

**Call relations**: `render_table_lines` uses this between the header and body rows, and between body rows.

*Call graph*: calls 1 internal fn (new); 2 external calls (from, styled).


##### `Writer::render_table_row`  (lines 1408–1493)

```
fn render_table_row(
        &self,
        row: &[TableCell],
        column_widths: &[usize],
        alignments: &[Alignment],
        row_style: Style,
    ) -> Vec<HyperlinkLine>
```

**Purpose**: Renders one table row into one or more prewrapped terminal lines.

**Data flow**: It wraps each cell to its column width, calculates row height, applies alignment and padding, shifts hyperlink ranges into their final columns, and returns the visible row lines.

**Call relations**: `render_table_lines` calls this for the header and each body row when aligned table rendering is chosen.

*Call graph*: calls 1 internal fn (new); called by 1 (render_table_lines); 7 external calls (default, from, line_display_width, raw, new, with_capacity, iter).


##### `Writer::render_table_pipe_fallback`  (lines 1500–1513)

```
fn render_table_pipe_fallback(
        &self,
        header: &[TableCell],
        rows: &[Vec<TableCell>],
        alignments: &[Alignment],
    ) -> Vec<HyperlinkLine>
```

**Purpose**: Renders a table as raw Markdown-style pipe lines when no aligned layout fits and there are no body records to transpose.

**Data flow**: It receives header, rows, and alignments, converts them into `| A | B |` lines plus a delimiter line, and returns those lines for normal wrapping.

**Call relations**: `render_table_lines` uses this mainly for header-only tables where key/value records would not make sense.

*Call graph*: calls 1 internal fn (new); called by 1 (render_table_lines); 4 external calls (from, alignments_to_pipe_delimiter, row_to_pipe_line, new).


##### `Writer::row_to_pipe_line`  (lines 1515–1562)

```
fn row_to_pipe_line(row: &[TableCell]) -> HyperlinkLine
```

**Purpose**: Converts one row of table cells into a pipe-delimited line while preserving hyperlinks.

**Data flow**: It walks each cell's visible text, escapes literal pipe characters as `\|`, tracks hyperlink destinations by display column, and writes spans into a new line.

**Call relations**: The pipe fallback renderer calls this for the header and body rows.

*Call graph*: calls 1 internal fn (new); 3 external calls (default, new, width).


##### `Writer::alignments_to_pipe_delimiter`  (lines 1564–1578)

```
fn alignments_to_pipe_delimiter(alignments: &[Alignment]) -> String
```

**Purpose**: Creates the Markdown delimiter row that represents table column alignment.

**Data flow**: It receives alignment values and returns a string such as `|:---|---:|`.

**Call relations**: The pipe fallback renderer uses this as the second row after the header.

*Call graph*: 1 external calls (new).


##### `Writer::wrap_cell`  (lines 1586–1607)

```
fn wrap_cell(&self, cell: &TableCell, width: usize) -> Vec<HyperlinkLine>
```

**Purpose**: Wraps one table cell to a column width without losing styles or hyperlinks.

**Data flow**: It receives a cell and width, wraps each internal cell line, converts wrapped lines to static terminal lines, remaps hyperlink ranges, and returns at least one line.

**Call relations**: `render_table_row` calls this for every cell before assembling padded table rows.

*Call graph*: calls 4 internal fn (new, remap_wrapped_line, new, word_wrap_line); 3 external calls (default, new, vec!).


##### `Writer::is_spillover_row`  (lines 1620–1652)

```
fn is_spillover_row(row: &TableBodyRow, next_row: Option<&TableBodyRow>) -> bool
```

**Purpose**: Detects rows that are probably accidental table rows created by the Markdown parser's loose table parsing.

**Data flow**: It receives a body row and optional next row, checks whether only the first cell has content and whether it looks like prose or HTML spillover, and returns a boolean.

**Call relations**: `render_table_lines` uses this before layout so trailing paragraphs or HTML are shown after the table instead of inside it.

*Call graph*: 3 external calls (first_non_empty_only_text, looks_like_html_content, looks_like_html_label_line).


##### `Writer::first_non_empty_only_text`  (lines 1654–1663)

```
fn first_non_empty_only_text(row: &[TableCell]) -> Option<String>
```

**Purpose**: Finds text for rows where only the first table cell has content.

**Data flow**: It reads a row's cells, returns the first cell's plain text only if it is non-empty and every other cell is empty.

**Call relations**: Spillover detection calls this to decide whether a sparse row should be examined as possible escaped prose.

*Call graph*: 1 external calls (first).


##### `Writer::looks_like_html_content`  (lines 1665–1686)

```
fn looks_like_html_content(text: &str) -> bool
```

**Purpose**: Checks whether text appears to contain an HTML tag.

**Data flow**: It scans bytes for a `<`, optional `/` or `!`, an alphabetic tag name, and a later `>`, returning true if that pattern appears.

**Call relations**: Spillover detection uses this to move HTML-like parser artifacts out of tables.


##### `Writer::looks_like_html_label_line`  (lines 1688–1697)

```
fn looks_like_html_label_line(text: &str) -> bool
```

**Purpose**: Checks whether a line looks like a label introducing HTML content.

**Data flow**: It trims the text, requires a trailing colon, then looks for the word `html` before that colon.

**Call relations**: Spillover detection uses this for trailing lines such as `HTML block:`.


##### `Writer::spans_display_width`  (lines 1703–1705)

```
fn spans_display_width(spans: &[Span<'_>]) -> usize
```

**Purpose**: Measures the visible terminal width of a list of spans.

**Data flow**: It receives spans, sums the Unicode display width of each span's content, and returns the total.

**Call relations**: Line, table, and prefix width calculations use this helper whenever visual column counts matter.

*Call graph*: 1 external calls (iter).


##### `Writer::line_display_width`  (lines 1708–1710)

```
fn line_display_width(line: &Line<'_>) -> usize
```

**Purpose**: Measures the visible width of one terminal line.

**Data flow**: It receives a line, forwards its spans to `spans_display_width`, and returns the result.

**Call relations**: Table row rendering uses this when padding and aligning cell lines.

*Call graph*: 1 external calls (spans_display_width).


##### `Writer::cell_display_width`  (lines 1713–1719)

```
fn cell_display_width(cell: &TableCell) -> usize
```

**Purpose**: Measures the widest visible line inside a table cell.

**Data flow**: It reads all lines in a cell, measures each line, and returns the maximum width or zero for an empty cell.

**Call relations**: Column metric collection uses this to find each column's natural width.


##### `Writer::longest_token_width`  (lines 1722–1724)

```
fn longest_token_width(text: &str) -> usize
```

**Purpose**: Finds the display width of the longest whitespace-separated token in text.

**Data flow**: It splits text by whitespace, measures each token, and returns the maximum width or zero.

**Call relations**: Column metric collection uses this to identify columns dominated by long paths, URLs, or hashes.


##### `Writer::push_inline_style`  (lines 1726–1730)

```
fn push_inline_style(&mut self, style: Style)
```

**Purpose**: Adds a new inline style while preserving any style already active.

**Data flow**: It receives a style, merges it with the current top style, and pushes the merged style onto the stack.

**Call relations**: Heading and emphasis/strong/strikethrough start handling call this so nested styles combine correctly.

*Call graph*: called by 2 (start_heading, start_tag).


##### `Writer::pop_inline_style`  (lines 1732–1734)

```
fn pop_inline_style(&mut self)
```

**Purpose**: Removes the most recently pushed inline style.

**Data flow**: It pops the style stack and returns nothing.

**Call relations**: Heading and emphasis/strong/strikethrough end handling call this to restore the previous text style.

*Call graph*: called by 2 (end_heading, end_tag).


##### `Writer::push_link`  (lines 1736–1747)

```
fn push_link(&mut self, dest_url: String)
```

**Purpose**: Starts tracking a Markdown link and decides how it should be displayed.

**Data flow**: It receives the destination string, decides whether to show the destination, prepares special local-file display text if needed, and stores a `LinkState`.

**Call relations**: Start-tag handling calls this for links; later text may be suppressed for local links, and `pop_link` finishes the visible output.

*Call graph*: calls 3 internal fn (is_local_path_like_link, render_local_link_target, should_render_link_destination); called by 1 (start_tag).


##### `Writer::pop_link`  (lines 1749–1799)

```
fn pop_link(&mut self)
```

**Purpose**: Finishes rendering a Markdown link.

**Data flow**: It takes the active link state. For web links it appends a styled destination suffix and hyperlink annotation; for local file links it writes the normalized target path instead of the label.

**Call relations**: End-tag handling calls this at link close; it writes either to the current table cell or the normal line depending on context.

*Call graph*: calls 7 internal fn (in_table_cell, push_annotated, push_line, push_span, push_span_to_table_cell, new, web_destination); called by 1 (end_tag); 2 external calls (default, styled).


##### `Writer::suppressing_local_link_label`  (lines 1801–1806)

```
fn suppressing_local_link_label(&self) -> bool
```

**Purpose**: Tells whether current link label text should be hidden because a local file target will be shown instead.

**Data flow**: It checks the active link state for prepared local-target display text and returns true if present.

**Call relations**: Text, code, HTML, and break handlers call this so arbitrary Markdown labels do not appear for local file links.

*Call graph*: called by 5 (code, hard_break, html, soft_break, text).


##### `Writer::flush_current_line`  (lines 1808–1841)

```
fn flush_current_line(&mut self)
```

**Purpose**: Moves the current in-progress line into final output, wrapping it if needed.

**Data flow**: It takes the current line, applies indentation, wraps non-code lines to the configured width, remaps hyperlinks after wrapping or prefixing, pushes completed lines, and clears current-line state.

**Call relations**: Many operations call this before starting a new block or preformatted line, and `run` calls it at the end.

*Call graph*: calls 4 internal fn (push_output_line, remap_wrapped_line, new, adaptive_wrap_line); called by 10 (end_table, end_tag, handle_event, push_blank_line, push_line, push_prewrapped_line, run, start_codeblock, start_item, start_table); 1 external calls (from_iter).


##### `Writer::is_blockquote_active`  (lines 1850–1854)

```
fn is_blockquote_active(&self) -> bool
```

**Purpose**: Checks whether any active indentation context represents a blockquote.

**Data flow**: It scans the indentation stack for a prefix containing `>` and returns a boolean.

**Call relations**: Line-pushing methods call this to apply blockquote styling to normal and prewrapped lines.

*Call graph*: called by 2 (push_line, push_prewrapped_line).


##### `Writer::push_prewrapped_line`  (lines 1856–1873)

```
fn push_prewrapped_line(&mut self, mut line: HyperlinkLine, pending_marker_line: bool)
```

**Purpose**: Adds a line that has already been laid out and must not be word-wrapped again.

**Data flow**: It flushes current content, applies blockquote style if active, prepends the right prefix or list marker, shifts hyperlinks, and pushes the final line.

**Call relations**: `end_table` uses this for aligned or key/value table output because wrapping those lines again would break the layout.

*Call graph*: calls 5 internal fn (flush_current_line, is_blockquote_active, prefix_spans, push_output_line, style); called by 1 (end_table); 1 external calls (from).


##### `Writer::push_line`  (lines 1875–1893)

```
fn push_line(&mut self, line: Line<'static>)
```

**Purpose**: Starts a new current line with the correct indentation and style context.

**Data flow**: It flushes any existing line, calculates initial and subsequent prefixes, records current style and code-block status, and stores the new line as in-progress.

**Call relations**: Most text-producing handlers call this whenever they need a fresh line.

*Call graph*: calls 4 internal fn (flush_current_line, is_blockquote_active, prefix_spans, new); called by 16 (code, end_codeblock, handle_event, hard_break, html, pop_link, prepare_for_event, push_annotated, push_blank_line, push_hyperlink_line (+6 more)).


##### `Writer::push_hyperlink_line`  (lines 1895–1901)

```
fn push_hyperlink_line(&mut self, line: HyperlinkLine)
```

**Purpose**: Starts a new current line from an already hyperlink-aware line.

**Data flow**: It separates the line's spans and hyperlinks, pushes the spans as a line, then restores the hyperlink metadata onto the current line.

**Call relations**: `end_table` uses this for fallback and spillover lines that should still go through normal flushing.

*Call graph*: calls 1 internal fn (push_line); called by 1 (end_table).


##### `Writer::push_span`  (lines 1903–1909)

```
fn push_span(&mut self, span: Span<'static>)
```

**Purpose**: Appends one styled span to the current line, creating a line if necessary.

**Data flow**: It receives a span and either pushes it onto the current line or starts a new line containing that span.

**Call relations**: Inline code, HTML, link finishing, and highlighted code output call this for simple span insertion.

*Call graph*: calls 1 internal fn (push_line); called by 4 (code, end_codeblock, html, pop_link); 2 external calls (from, vec!).


##### `Writer::push_annotated`  (lines 1911–1924)

```
fn push_annotated(&mut self, mut appended: HyperlinkLine)
```

**Purpose**: Appends hyperlink-aware content to the current line while preserving link columns.

**Data flow**: It receives a `HyperlinkLine`, creates a current line if needed, appends its spans, shifts hyperlink ranges by the existing line width, and stores those links.

**Call relations**: Plain text URL annotation and web-link destination rendering use this to keep terminal hyperlinks accurate.

*Call graph*: calls 1 internal fn (push_line); called by 2 (pop_link, push_text_spans); 1 external calls (default).


##### `Writer::push_text_spans`  (lines 1926–1942)

```
fn push_text_spans(&mut self, text: &str, style: Style)
```

**Purpose**: Writes styled text to normal output and attaches web-link annotations when appropriate.

**Data flow**: It receives text and style, creates a span, either uses the active explicit web-link destination, suppresses auto-linking inside links/code, or detects bare web URLs, then appends the annotated content.

**Call relations**: The main text handler calls this for non-table text.

*Call graph*: calls 3 internal fn (push_annotated, new, annotate_web_urls_in_line); called by 1 (text); 3 external calls (default, from, styled).


##### `Writer::push_blank_line`  (lines 1944–1952)

```
fn push_blank_line(&mut self)
```

**Purpose**: Adds a blank line while respecting list indentation rules.

**Data flow**: It flushes current content, then either pushes a truly empty output line for list-only contexts or creates and flushes a prefixed blank line for other contexts.

**Call relations**: Block starts and horizontal rules call this when visual separation is needed.

*Call graph*: calls 4 internal fn (flush_current_line, push_line, push_output_line, new); called by 6 (handle_event, start_blockquote, start_codeblock, start_item, start_paragraph, start_table); 1 external calls (default).


##### `Writer::push_output_line`  (lines 1954–1956)

```
fn push_output_line(&mut self, line: HyperlinkLine)
```

**Purpose**: Appends one completed hyperlink-aware line to the writer's final output.

**Data flow**: It receives a finished line and pushes it into the output vector.

**Call relations**: Only lower-level flushing and prewrapped-line helpers call this, making it the final sink for rendered lines.

*Call graph*: called by 3 (flush_current_line, push_blank_line, push_prewrapped_line).


##### `Writer::prefix_spans`  (lines 1958–1989)

```
fn prefix_spans(&self, pending_marker_line: bool) -> Vec<Span<'static>>
```

**Purpose**: Builds the visible indentation and list marker prefix for the next line.

**Data flow**: It receives whether a list marker is pending, walks the indentation stack, chooses marker or continuation prefixes, and returns spans to place before the line content.

**Call relations**: Line pushing and prewrapped table output call this so nested lists and blockquotes line up correctly.

*Call graph*: called by 2 (push_line, push_prewrapped_line); 1 external calls (new).


##### `is_local_path_like_link`  (lines 1992–2004)

```
fn is_local_path_like_link(dest_url: &str) -> bool
```

**Purpose**: Identifies link destinations that look like local filesystem paths rather than ordinary web links.

**Data flow**: It receives a destination string and checks for forms such as `file://`, absolute Unix paths, `~/`, relative paths, UNC paths, and Windows drive paths.

**Call relations**: Link setup and link-destination policy use this to choose local-file rendering behavior.

*Call graph*: called by 2 (push_link, should_render_link_destination); 1 external calls (matches!).


##### `render_local_link_target`  (lines 2010–2017)

```
fn render_local_link_target(dest_url: &str, cwd: Option<&Path>) -> Option<String>
```

**Purpose**: Turns a local link destination into the exact path text shown in the transcript.

**Data flow**: It parses the destination into path and optional location suffix, displays the path relative to cwd when appropriate, appends the suffix, and returns the final string.

**Call relations**: `Writer::push_link` calls this when a link looks local so `pop_link` can render the real target instead of the Markdown label.

*Call graph*: calls 2 internal fn (display_local_link_path, parse_local_link_target); called by 1 (push_link).


##### `parse_local_link_target`  (lines 2027–2058)

```
fn parse_local_link_target(dest_url: &str) -> Option<(String, Option<String>)>
```

**Purpose**: Splits a local-link destination into normalized path text and an optional line/column suffix.

**Data flow**: It accepts file URLs and plain path-like strings, decodes URL escapes, recognizes `#L...` and trailing `:line[:col]` suffixes, expands home-relative paths, and returns the parsed pieces.

**Call relations**: Local-link rendering calls this before deciding how much of the path to display.

*Call graph*: calls 4 internal fn (expand_local_link_path, extract_colon_location_suffix, file_url_to_local_path_text, normalize_hash_location_suffix_fragment); called by 1 (render_local_link_target); 3 external calls (parse, Borrowed, decode).


##### `normalize_hash_location_suffix_fragment`  (lines 2064–2069)

```
fn normalize_hash_location_suffix_fragment(fragment: &str) -> Option<String>
```

**Purpose**: Normalizes a URL hash fragment that refers to source-code line or column locations.

**Data flow**: It receives a fragment such as `L12C3`, checks it against the location pattern, adds `#`, normalizes it, and returns it only if it is a recognized location.

**Call relations**: Local-link parsing uses this for `file://...#L10` and similar path fragments.

*Call graph*: called by 1 (parse_local_link_target).


##### `extract_colon_location_suffix`  (lines 2075–2080)

```
fn extract_colon_location_suffix(path_text: &str) -> Option<String>
```

**Purpose**: Extracts a trailing source-location suffix like `:12` or `:12:3` from a path string.

**Data flow**: It matches only a suffix at the end of the string and returns that suffix without disturbing other colons such as Windows drive letters.

**Call relations**: Local-link parsing uses this when no hash-style location was found.

*Call graph*: called by 1 (parse_local_link_target).


##### `expand_local_link_path`  (lines 2086–2096)

```
fn expand_local_link_path(path_text: &str) -> String
```

**Purpose**: Expands home-relative local paths and normalizes path separators for display.

**Data flow**: It receives path text, expands `~/` using the user's home directory when available, converts separators to the display form, and returns the normalized path.

**Call relations**: Local-link parsing calls this for plain path-like link destinations.

*Call graph*: calls 1 internal fn (normalize_local_link_path_text); called by 1 (parse_local_link_target); 1 external calls (home_dir).


##### `file_url_to_local_path_text`  (lines 2103–2124)

```
fn file_url_to_local_path_text(url: &Url) -> Option<String>
```

**Purpose**: Converts a `file://` URL into display-ready local path text.

**Data flow**: It receives a parsed URL, first tries the URL library's file-path conversion, then falls back to reconstructing UNC or Windows-like paths, and normalizes separators.

**Call relations**: Local-link parsing calls this for file URL destinations.

*Call graph*: calls 1 internal fn (normalize_local_link_path_text); called by 1 (parse_local_link_target); 5 external calls (host_str, path, to_file_path, format!, matches!).


##### `normalize_local_link_path_text`  (lines 2132–2140)

```
fn normalize_local_link_path_text(path_text: &str) -> String
```

**Purpose**: Makes local path text stable for display across platforms.

**Data flow**: It receives path text, converts backslashes to forward slashes, and rewrites Windows UNC-style prefixes into `//server/share` form.

**Call relations**: Home expansion, file URL conversion, and display shortening all use this before comparing or showing paths.

*Call graph*: called by 3 (display_local_link_path, expand_local_link_path, file_url_to_local_path_text); 1 external calls (format!).


##### `is_absolute_local_link_path`  (lines 2142–2149)

```
fn is_absolute_local_link_path(path_text: &str) -> bool
```

**Purpose**: Checks whether normalized local path text is absolute.

**Data flow**: It receives path text and returns true for Unix absolute paths, UNC paths, and Windows drive-rooted paths.

**Call relations**: Display path selection uses this to decide whether cwd-relative shortening is possible.

*Call graph*: called by 1 (display_local_link_path); 1 external calls (matches!).


##### `trim_trailing_local_path_separator`  (lines 2155–2163)

```
fn trim_trailing_local_path_separator(path_text: &str) -> &str
```

**Purpose**: Removes trailing `/` characters from local paths without damaging root paths.

**Data flow**: It receives path text, preserves roots like `/`, `//`, and `C:/`, and otherwise trims trailing slashes.

**Call relations**: Prefix stripping uses this so `/work/project/` and `/work/project` compare the same.

*Call graph*: called by 1 (strip_local_path_prefix); 1 external calls (matches!).


##### `strip_local_path_prefix`  (lines 2170–2186)

```
fn strip_local_path_prefix(path_text: &'a str, cwd_text: &str) -> Option<&'a str>
```

**Purpose**: Returns a path relative to the cwd when the path is strictly underneath that cwd.

**Data flow**: It receives normalized path text and cwd text, trims trailing separators, refuses to strip if they are equal, handles root cwd specially, and returns the remainder if it is a child path.

**Call relations**: Display path selection calls this to shorten absolute local links in the current session directory.

*Call graph*: calls 1 internal fn (trim_trailing_local_path_separator); called by 1 (display_local_link_path).


##### `display_local_link_path`  (lines 2193–2209)

```
fn display_local_link_path(path_text: &str, cwd: Option<&Path>) -> String
```

**Purpose**: Chooses the visible path text for a local link.

**Data flow**: It normalizes the path, leaves relative paths unchanged, tries to shorten absolute paths under the provided cwd, and otherwise keeps the absolute path.

**Call relations**: Local-link target rendering calls this after parsing the path and before appending any line/column suffix.

*Call graph*: calls 3 internal fn (is_absolute_local_link_path, normalize_local_link_path_text, strip_local_path_prefix); called by 1 (render_local_link_target).


##### `tests::lines_to_strings`  (lines 2222–2232)

```
fn lines_to_strings(text: &Text<'_>) -> Vec<String>
```

**Purpose**: Converts rendered `Text` into plain strings so tests can compare visible output easily.

**Data flow**: It receives rendered text, joins each line's spans into one string, and returns a vector of line strings.

**Call relations**: Many wrapping tests call this after rendering Markdown.


##### `tests::wraps_plain_text_when_width_provided`  (lines 2235–2247)

```
fn wraps_plain_text_when_width_provided()
```

**Purpose**: Checks that ordinary prose wraps at the requested width.

**Data flow**: It renders a sentence with a small width, converts output to strings, and asserts the expected wrapped lines.

**Call relations**: The test harness runs this; it exercises the public width-aware renderer.

*Call graph*: calls 1 internal fn (render_markdown_text_with_width); 2 external calls (assert_eq!, lines_to_strings).


##### `tests::wraps_list_items_preserving_indent`  (lines 2250–2258)

```
fn wraps_list_items_preserving_indent()
```

**Purpose**: Checks that a wrapped bullet list item keeps its continuation indentation.

**Data flow**: It renders one long list item, converts lines to strings, and compares them with the expected bullet and continuation lines.

**Call relations**: This test exercises list prefix calculation and wrapping together.

*Call graph*: calls 1 internal fn (render_markdown_text_with_width); 2 external calls (assert_eq!, lines_to_strings).


##### `tests::wraps_nested_lists`  (lines 2261–2277)

```
fn wraps_nested_lists()
```

**Purpose**: Checks wrapping for nested unordered lists.

**Data flow**: It renders nested list Markdown at a narrow width and asserts that both outer and inner continuation lines are indented correctly.

**Call relations**: This test covers the interaction between list nesting, markers, and line wrapping.

*Call graph*: calls 1 internal fn (render_markdown_text_with_width); 2 external calls (assert_eq!, lines_to_strings).


##### `tests::wraps_ordered_lists`  (lines 2280–2293)

```
fn wraps_ordered_lists()
```

**Purpose**: Checks that ordered list numbers and continuation indentation survive wrapping.

**Data flow**: It renders a long numbered item, extracts strings, and asserts the expected lines.

**Call relations**: This test exercises ordered-list marker creation and prefix handling.

*Call graph*: calls 1 internal fn (render_markdown_text_with_width); 2 external calls (assert_eq!, lines_to_strings).


##### `tests::wraps_blockquotes`  (lines 2296–2308)

```
fn wraps_blockquotes()
```

**Purpose**: Checks that blockquote text wraps with `> ` on each line.

**Data flow**: It renders a long quoted line with a narrow width and compares the visible output.

**Call relations**: This test covers blockquote prefixing and wrapping.

*Call graph*: calls 1 internal fn (render_markdown_text_with_width); 2 external calls (assert_eq!, lines_to_strings).


##### `tests::wraps_blockquotes_inside_lists`  (lines 2311–2323)

```
fn wraps_blockquotes_inside_lists()
```

**Purpose**: Checks that blockquotes nested inside list items keep both list and quote indentation.

**Data flow**: It renders a list item followed by an indented blockquote and asserts the expected wrapped strings.

**Call relations**: This test exercises combined list and blockquote indentation contexts.

*Call graph*: calls 1 internal fn (render_markdown_text_with_width); 2 external calls (assert_eq!, lines_to_strings).


##### `tests::wraps_list_items_containing_blockquotes`  (lines 2326–2338)

```
fn wraps_list_items_containing_blockquotes()
```

**Purpose**: Checks ordered-list items that contain a blockquote.

**Data flow**: It renders an ordered list item with quoted text, converts to strings, and asserts the wrapped output.

**Call relations**: This test covers ordered-list prefixes together with nested blockquote prefixes.

*Call graph*: calls 1 internal fn (render_markdown_text_with_width); 2 external calls (assert_eq!, lines_to_strings).


##### `tests::does_not_wrap_code_blocks`  (lines 2341–2349)

```
fn does_not_wrap_code_blocks()
```

**Purpose**: Checks that code block lines are not wrapped even when a narrow width is given.

**Data flow**: It renders a fenced code block with a long line and asserts that the line remains intact.

**Call relations**: This test protects copy/paste-friendly code-block behavior in `flush_current_line`.

*Call graph*: calls 1 internal fn (render_markdown_text_with_width); 2 external calls (assert_eq!, lines_to_strings).


##### `tests::does_not_split_long_url_like_token_without_scheme`  (lines 2352–2363)

```
fn does_not_split_long_url_like_token_without_scheme()
```

**Purpose**: Checks that a long URL-like token without a scheme is not broken apart during wrapping.

**Data flow**: It renders one long path-like token, extracts lines, and asserts that the full token appears on a single line.

**Call relations**: This test exercises adaptive wrapping behavior used by normal text output.

*Call graph*: calls 1 internal fn (render_markdown_text_with_width); 2 external calls (assert_eq!, lines_to_strings).


##### `tests::fenced_code_info_string_with_metadata_highlights`  (lines 2366–2383)

```
fn fenced_code_info_string_with_metadata_highlights()
```

**Purpose**: Checks that fenced code blocks still get syntax highlighting when the info string includes extra metadata.

**Data flow**: It renders Rust code blocks with different info-string formats and asserts that some spans have RGB highlight colors.

**Call relations**: This test exercises language-token extraction in `start_codeblock` and highlighting in `end_codeblock`.

*Call graph*: calls 1 internal fn (render_markdown_text); 2 external calls (assert!, format!).


##### `tests::crlf_code_block_no_extra_blank_lines`  (lines 2386–2398)

```
fn crlf_code_block_no_extra_blank_lines()
```

**Purpose**: Checks that CRLF-formatted code blocks do not gain extra blank lines.

**Data flow**: It renders a Rust code block with Windows-style line endings, converts lines to strings, and asserts exactly the original code lines.

**Call relations**: This test protects the code-buffer concatenation path in `text` and `end_codeblock`.

*Call graph*: calls 1 internal fn (render_markdown_text); 2 external calls (assert_eq!, lines_to_strings).


##### `tests::wrap_cell_preserves_hard_break_lines`  (lines 2401–2424)

```
fn wrap_cell_preserves_hard_break_lines()
```

**Purpose**: Checks that table-cell hard breaks remain separate lines after wrapping.

**Data flow**: It builds a table cell with two internal lines, wraps it, converts the wrapped result to strings, and asserts both lines remain.

**Call relations**: This test directly exercises `Writer::wrap_cell`.

*Call graph*: 4 external calls (new, assert_eq!, empty, default).


##### `tests::make_cell`  (lines 2432–2436)

```
fn make_cell(text: &str) -> TableCell
```

**Purpose**: Builds a plain one-line table cell for table unit tests.

**Data flow**: It receives text, creates an empty `TableCell`, pushes a raw span, and returns the cell.

**Call relations**: Column-metric and spillover tests use this helper to create table inputs.

*Call graph*: 2 external calls (raw, default).


##### `tests::make_body_row`  (lines 2438–2443)

```
fn make_body_row(cells: Vec<TableCell>, has_table_pipe_syntax: bool) -> TableBodyRow
```

**Purpose**: Builds a table body row for tests, including whether it used pipe syntax.

**Data flow**: It receives cells and a pipe-syntax flag, packages them into a `TableBodyRow`, and returns it.

**Call relations**: Spillover tests use this helper to create realistic row metadata.


##### `tests::column_classification_narrative_by_word_count`  (lines 2448–2459)

```
fn column_classification_narrative_by_word_count()
```

**Purpose**: Checks that prose-heavy table columns are classified as narrative.

**Data flow**: It creates short ID cells and verbose description cells, collects metrics, and asserts the expected column kinds.

**Call relations**: This test directly exercises table column metric collection.

*Call graph*: 3 external calls (collect_table_column_metrics, assert_eq!, vec!).


##### `tests::column_classification_token_heavy_by_url_like_tokens`  (lines 2462–2470)

```
fn column_classification_token_heavy_by_url_like_tokens()
```

**Purpose**: Checks that columns full of long URL-like tokens are classified as token-heavy.

**Data flow**: It builds a one-column table of long URLs, collects metrics, and asserts the token-heavy kind.

**Call relations**: This test protects the width-allocation priority for URL/path columns.

*Call graph*: 3 external calls (collect_table_column_metrics, assert_eq!, vec!).


##### `tests::column_classification_token_heavy_for_local_path_lists`  (lines 2473–2485)

```
fn column_classification_token_heavy_for_local_path_lists()
```

**Purpose**: Checks that columns containing long local file paths are treated as token-heavy.

**Data flow**: It builds cells containing multiple long file paths, collects metrics, and asserts the token-heavy classification.

**Call relations**: This test protects table layout behavior for file-list output.

*Call graph*: 3 external calls (collect_table_column_metrics, assert_eq!, vec!).


##### `tests::column_classification_compact_all_short`  (lines 2488–2498)

```
fn column_classification_compact_all_short()
```

**Purpose**: Checks that short status/count columns are classified as compact.

**Data flow**: It builds a table with short values, collects metrics, and asserts both columns are compact.

**Call relations**: This test protects the rule that compact columns should resist shrinking.

*Call graph*: 3 external calls (collect_table_column_metrics, assert_eq!, vec!).


##### `tests::preferred_floor_narrative_retains_readable_width`  (lines 2501–2517)

```
fn preferred_floor_narrative_retains_readable_width()
```

**Purpose**: Checks the preferred minimum width for narrative columns.

**Data flow**: It creates sample narrative metrics and asserts the floor is readable but never larger than the column's maximum width.

**Call relations**: This test directly exercises `preferred_column_floor` for prose columns.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::preferred_floor_token_heavy_retains_readable_width`  (lines 2520–2528)

```
fn preferred_floor_token_heavy_retains_readable_width()
```

**Purpose**: Checks the preferred minimum width for token-heavy columns.

**Data flow**: It creates token-heavy metrics and asserts the floor keeps a modest readable width.

**Call relations**: This test covers one branch of table width allocation policy.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::preferred_floor_compact_uses_body_token`  (lines 2531–2551)

```
fn preferred_floor_compact_uses_body_token()
```

**Purpose**: Checks that compact column floors are based on header and body token widths with a cap.

**Data flow**: It creates compact metrics with different token sizes and asserts the computed floors.

**Call relations**: This test protects compact-column width behavior.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::next_column_to_shrink_prefers_token_heavy_then_narrative`  (lines 2554–2587)

```
fn next_column_to_shrink_prefers_token_heavy_then_narrative()
```

**Purpose**: Checks the shrink priority used when a table is too wide.

**Data flow**: It creates three columns with different kinds, asks which should shrink, changes available slack, and asserts token-heavy shrinks before narrative and compact.

**Call relations**: This test directly exercises `next_column_to_shrink`.

*Call graph*: 2 external calls (next_column_to_shrink, assert_eq!).


##### `tests::spillover_detects_single_cell_row`  (lines 2592–2598)

```
fn spillover_detects_single_cell_row()
```

**Purpose**: Checks that a single-cell row without pipe syntax is treated as spillover prose.

**Data flow**: It builds such a row and asserts `is_spillover_row` returns true.

**Call relations**: This test protects the table parser-artifact cleanup heuristic.

*Call graph*: 3 external calls (assert!, make_body_row, vec!).


##### `tests::spillover_keeps_single_cell_row_with_table_pipe_syntax`  (lines 2601–2607)

```
fn spillover_keeps_single_cell_row_with_table_pipe_syntax()
```

**Purpose**: Checks that an explicit single-cell pipe row is kept as table data.

**Data flow**: It builds a single-cell row marked as pipe syntax and asserts it is not spillover.

**Call relations**: This test keeps the spillover heuristic from removing real sparse tables.

*Call graph*: 3 external calls (assert!, make_body_row, vec!).


##### `tests::spillover_detects_html_content`  (lines 2610–2621)

```
fn spillover_detects_html_content()
```

**Purpose**: Checks that sparse rows containing HTML-like text are treated as spillover.

**Data flow**: It builds a multi-cell row where only the first cell has HTML-like content and asserts spillover detection.

**Call relations**: This test covers HTML parser-artifact detection.

*Call graph*: 3 external calls (assert!, make_body_row, vec!).


##### `tests::spillover_detects_label_followed_by_html`  (lines 2624–2635)

```
fn spillover_detects_label_followed_by_html()
```

**Purpose**: Checks that an `HTML block:` label followed by HTML content is treated as spillover.

**Data flow**: It builds a label row and a following HTML row, then asserts the label row is spillover.

**Call relations**: This test covers the multi-row spillover heuristic.

*Call graph*: 3 external calls (assert!, make_body_row, vec!).


##### `tests::spillover_detects_trailing_html_label`  (lines 2638–2645)

```
fn spillover_detects_trailing_html_label()
```

**Purpose**: Checks that a trailing HTML-intro label is treated as spillover even without a following row.

**Data flow**: It builds a sparse `HTML block:` row with no next row and asserts spillover detection.

**Call relations**: This test protects the trailing-label branch of `is_spillover_row`.

*Call graph*: 3 external calls (assert!, make_body_row, vec!).


##### `tests::spillover_keeps_normal_multi_cell_row`  (lines 2648–2655)

```
fn spillover_keeps_normal_multi_cell_row()
```

**Purpose**: Checks that normal rows with multiple non-empty cells remain table rows.

**Data flow**: It builds a row with three non-empty cells and asserts it is not spillover.

**Call relations**: This test prevents over-aggressive spillover extraction.

*Call graph*: 3 external calls (assert!, make_body_row, vec!).


##### `tests::spillover_keeps_label_when_next_is_not_html`  (lines 2658–2669)

```
fn spillover_keeps_label_when_next_is_not_html()
```

**Purpose**: Checks that a sparse label row is kept when the following row is ordinary table data.

**Data flow**: It builds a `Status:` row followed by an `ok` row and asserts the first is not spillover.

**Call relations**: This test guards a subtle spillover false-positive case.

*Call graph*: 3 external calls (assert!, make_body_row, vec!).


##### `tests::annotates_explicit_web_link_label_and_visible_destination`  (lines 2672–2689)

```
fn annotates_explicit_web_link_label_and_visible_destination()
```

**Purpose**: Checks that explicit web links produce terminal hyperlink annotations for both the label and shown destination.

**Data flow**: It renders a Markdown link, collects all hyperlink annotations, and asserts their count and destination.

**Call relations**: This test exercises link handling through the hyperlink-aware line renderer.

*Call graph*: calls 1 internal fn (render_markdown_lines_with_width_and_cwd); 2 external calls (assert!, assert_eq!).


##### `tests::wrapped_table_url_fragments_keep_complete_web_destination`  (lines 2692–2714)

```
fn wrapped_table_url_fragments_keep_complete_web_destination()
```

**Purpose**: Checks that URLs wrapped across table lines keep the full hyperlink destination on every fragment.

**Data flow**: It renders a narrow table containing a long URL, selects linked output lines, and asserts every hyperlink still points to the full URL.

**Call relations**: This test covers table cell wrapping and hyperlink range remapping.

*Call graph*: calls 1 internal fn (render_markdown_lines_with_width_and_cwd); 2 external calls (assert!, format!).


##### `tests::key_value_table_keeps_web_annotations`  (lines 2717–2734)

```
fn key_value_table_keeps_web_annotations()
```

**Purpose**: Checks that table key/value fallback preserves web hyperlink annotations.

**Data flow**: It renders an intentionally narrow table that falls back to records, collects destinations, and asserts they all match the original URL.

**Call relations**: This test exercises the table fallback path used when aligned columns cannot fit.

*Call graph*: calls 1 internal fn (render_markdown_lines_with_width_and_cwd); 2 external calls (assert!, format!).


##### `tests::does_not_annotate_code_or_non_web_markdown_links`  (lines 2737–2746)

```
fn does_not_annotate_code_or_non_web_markdown_links()
```

**Purpose**: Checks that URLs inside code or non-web links are not auto-annotated as web hyperlinks.

**Data flow**: It renders inline code, block code, mail links, and table content, then asserts no hyperlink annotations are present.

**Call relations**: This test protects the conditions in normal and table text writing that suppress auto-linking.

*Call graph*: calls 1 internal fn (render_markdown_lines_with_width_and_cwd); 1 external calls (assert!).


##### `tests::pipe_table_fallback_keeps_web_annotations`  (lines 2749–2770)

```
fn pipe_table_fallback_keeps_web_annotations()
```

**Purpose**: Checks that raw pipe-table fallback preserves valid web annotations and does not annotate code URLs.

**Data flow**: It renders a table too narrow for aligned layout, gathers hyperlink destinations, and asserts expected web destinations are present while code-label URLs are absent.

**Call relations**: This test exercises `render_table_pipe_fallback` and `row_to_pipe_line`.

*Call graph*: calls 1 internal fn (render_markdown_lines_with_width_and_cwd); 2 external calls (assert!, format!).


### `tui/src/markdown.rs`

`domain_logic` · `message rendering`

The terminal UI needs to show messages, plans, history, and agent replies in a readable way. Those messages often arrive as Markdown, which is plain text with lightweight formatting rules for things like lists, code blocks, links, and tables. This file is the front door for converting that Markdown into ratatui lines, where ratatui is the library used to paint text in the terminal.

There are two main paths. Normal Markdown goes through append_markdown, which sends the text to the shared Markdown renderer and appends the finished lines to an output list. Agent Markdown goes through a stricter preparation step first. Agents often wrap tables inside ```md or ```markdown fences, as if the table were code. If left alone, the Markdown parser would show the pipes and dashes literally instead of drawing a table. unwrap_markdown_fences looks for only those Markdown fences that actually contain a table, removes the fence markers, and leaves the table text behind so the renderer can recognize it.

The unwrapping is deliberately cautious. It leaves non-Markdown fences, non-table Markdown fences, badly indented fences, and unfinished fences alone. Think of it like opening a package only when the label says “Markdown” and the contents really look like a table; otherwise it keeps the package sealed.

#### Function details

##### `append_markdown`  (lines 34–46)

```
fn append_markdown(
    markdown_source: &str,
    width: Option<usize>,
    cwd: Option<&Path>,
    lines: &mut Vec<Line<'static>>,
)
```

**Purpose**: This is the general Markdown rendering entry point. Code that already has ordinary Markdown uses it to turn that text into terminal-ready lines, optionally using a display width and a working directory for path formatting.

**Data flow**: It receives Markdown text, an optional width, an optional current working directory, and a mutable list of output lines. It asks the shared Markdown renderer to produce styled lines, then copies those owned rendered lines into the caller’s output list. The caller’s list is longer afterward; the function itself returns no separate value.

**Call relations**: This function sits between higher-level UI flows and the shared renderer. It is called by tests and by rendering paths such as completed streaming output and full-message rendering, then hands the heavy parsing work to render_markdown_text_with_width_and_cwd and the final line insertion to push_owned_lines.

*Call graph*: calls 2 internal fn (render_markdown_text_with_width_and_cwd, push_owned_lines); called by 13 (append_markdown_keeps_ordered_list_line_unsplit_in_context, append_markdown_matches_tui_markdown_for_ordered_item, append_markdown_preserves_full_text_line, citations_render_as_plain_text, indented_code_blocks_preserve_leading_whitespace, commit_complete_lines, finalize_and_drain, assert_streamed_equals_full, heading_not_inlined_when_split_across_chunks, loose_list_with_split_dashes_matches_full_render (+3 more)).


##### `append_markdown_agent`  (lines 55–67)

```
fn append_markdown_agent(
    markdown_source: &str,
    width: Option<usize>,
    lines: &mut Vec<Line<'static>>,
)
```

**Purpose**: This test-only helper renders agent messages while applying the special table-fence cleanup first. It exists so tests can check that agent replies display Markdown tables as tables instead of as code.

**Data flow**: It receives raw agent Markdown, an optional width, and a mutable output list. It first normalizes the text with unwrap_markdown_fences, then renders the normalized Markdown, then appends the resulting styled lines to the output list. The visible result is added to the supplied list.

**Call relations**: This function is called by many tests that exercise agent rendering. Its work is a small pipeline: unwrap likely table fences, render the Markdown, and push the rendered lines into the terminal line buffer.

*Call graph*: calls 3 internal fn (unwrap_markdown_fences, render_markdown_text_with_width_and_cwd, push_owned_lines); called by 20 (append_markdown_agent_keeps_markdown_fence_when_content_is_not_table, append_markdown_agent_keeps_non_markdown_fences_as_code, append_markdown_agent_unwraps_markdown_fences_for_no_outer_table_rendering, append_markdown_agent_unwraps_markdown_fences_for_single_column_table, append_markdown_agent_unwraps_markdown_fences_for_table_rendering, append_markdown_agent_unwraps_markdown_fences_for_two_column_no_outer_table, collector_source_chunks_round_trip_into_agent_fence_unwrapping, controller_handles_table_immediately_after_heading, controller_holds_blockquoted_table_tail_until_stable, controller_keeps_markdown_fenced_no_outer_tables_mutable_until_finalize (+10 more)).


##### `render_markdown_agent_with_links_and_cwd`  (lines 69–76)

```
fn render_markdown_agent_with_links_and_cwd(
    markdown_source: &str,
    width: Option<usize>,
    cwd: Option<&Path>,
) -> Vec<HyperlinkLine>
```

**Purpose**: This renders an agent message into lines that can include terminal hyperlinks. It also applies the same Markdown-table fence cleanup used for agent output.

**Data flow**: It receives raw agent Markdown, an optional width, and an optional working directory. It removes qualifying Markdown table fences, sends the cleaned text to the link-aware Markdown renderer, and returns a new vector of HyperlinkLine values ready for display.

**Call relations**: This function is used by display and streaming code that needs hyperlink-capable output. It prepares agent text with unwrap_markdown_fences, then delegates the actual rendering to render_markdown_lines_with_width_and_cwd.

*Call graph*: calls 2 internal fn (unwrap_markdown_fences, render_markdown_lines_with_width_and_cwd); called by 4 (display_hyperlink_lines, display_hyperlink_lines, render_source, stable_prefix_len_for_source_start).


##### `unwrap_markdown_fences`  (lines 89–295)

```
fn unwrap_markdown_fences(markdown_source: &'a str) -> Cow<'a, str>
```

**Purpose**: This removes ```md or ```markdown fence markers only when the fenced content appears to contain a Markdown table. It protects normal code blocks while making agent-wrapped tables render properly.

**Data flow**: It receives a Markdown string. If there are no fence markers, it returns a borrowed reference to the original text without copying. Otherwise it scans line by line, tracks whether it is inside a fence, buffers possible Markdown-fence content by source ranges, checks for a table header followed by a delimiter row, and builds either the original text or a version with selected fence lines removed. It returns either the original borrowed text or a newly owned cleaned string.

**Call relations**: This is the cleanup step used before agent rendering. append_markdown_agent and render_markdown_agent_with_links_and_cwd call it before passing text to the Markdown renderer, and several tests call it directly to verify edge cases such as blockquotes, unfinished fences, and non-table content.

*Call graph*: called by 6 (append_markdown_agent, render_markdown_agent_with_links_and_cwd, append_markdown_agent_keeps_markdown_fence_with_blank_line_between_header_and_delimiter, append_markdown_agent_keeps_non_blockquoted_markdown_fence_with_blockquote_table_example, append_markdown_agent_unwraps_blockquoted_markdown_fence_table, unwrap_markdown_fences_repro_keeps_fence_without_header_delimiter_pair); 7 external calls (MarkdownCandidate, Passthrough, new, Borrowed, Owned, with_capacity, new).


##### `tests::lines_to_strings`  (lines 303–313)

```
fn lines_to_strings(lines: &[Line<'static>]) -> Vec<String>
```

**Purpose**: This helper turns rendered ratatui lines back into plain strings for easier test comparisons. It hides styling details so tests can focus on what text would be visible.

**Data flow**: It receives a slice of rendered Line values. For each line, it joins the text content of all spans into one string, then returns a vector of those strings.

**Call relations**: Most tests use this after calling append_markdown or append_markdown_agent. It converts styled output into simple text before assertions check the result.

*Call graph*: 1 external calls (iter).


##### `tests::citations_render_as_plain_text`  (lines 316–328)

```
fn citations_render_as_plain_text()
```

**Purpose**: This test checks that citation-like text with unusual brackets and symbols is preserved as normal visible text. It guards against the Markdown renderer accidentally interpreting or dropping citation markers.

**Data flow**: It builds a short source string containing two citation-looking references, renders it with append_markdown, converts the output lines to plain strings, and compares them with the expected original text.

**Call relations**: The test calls append_markdown to exercise the normal rendering path, then uses lines_to_strings to make the result easy to compare.

*Call graph*: calls 1 internal fn (append_markdown); 3 external calls (new, assert_eq!, lines_to_strings).


##### `tests::indented_code_blocks_preserve_leading_whitespace`  (lines 331–338)

```
fn indented_code_blocks_preserve_leading_whitespace()
```

**Purpose**: This test verifies that indented code blocks keep their leading spaces. That matters because code indentation is part of what the user needs to see.

**Data flow**: It sends Markdown containing an indented code line through append_markdown. It converts the rendered lines to strings and checks that the code line still starts with four spaces and that surrounding blank lines remain.

**Call relations**: The test exercises append_markdown and uses lines_to_strings for comparison. It protects the normal Markdown rendering path from stripping meaningful whitespace.

*Call graph*: calls 1 internal fn (append_markdown); 3 external calls (new, assert_eq!, lines_to_strings).


##### `tests::append_markdown_preserves_full_text_line`  (lines 341–360)

```
fn append_markdown_preserves_full_text_line()
```

**Purpose**: This test checks that a long plain-text sentence stays as one rendered line when no width wrapping is requested. It prevents accidental splitting or loss of text in simple messages.

**Data flow**: It renders one plain text line with append_markdown, checks that only one output line was produced, joins all spans in that line, and compares the visible text with the expected sentence.

**Call relations**: The test calls append_markdown directly and inspects the returned line list. It focuses on the simplest rendering case: plain text in, plain text out.

*Call graph*: calls 1 internal fn (append_markdown); 2 external calls (new, assert_eq!).


##### `tests::append_markdown_matches_tui_markdown_for_ordered_item`  (lines 363–373)

```
fn append_markdown_matches_tui_markdown_for_ordered_item()
```

**Purpose**: This test verifies that a single ordered-list item displays as one readable line. It protects list formatting in the terminal UI.

**Data flow**: It renders the Markdown text '1. Tight item', converts the rendered line to a string, and checks that the output is exactly the same visible list item.

**Call relations**: The test calls append_markdown and lines_to_strings. It confirms the normal renderer keeps the number marker and item text together.

*Call graph*: calls 1 internal fn (append_markdown); 3 external calls (new, assert_eq!, lines_to_strings).


##### `tests::append_markdown_keeps_ordered_list_line_unsplit_in_context`  (lines 376–395)

```
fn append_markdown_keeps_ordered_list_line_unsplit_in_context()
```

**Purpose**: This test checks that an ordered-list item remains one line even when it appears after other text. It guards against a bug where the number marker could be separated from the list item text.

**Data flow**: It renders a short paragraph followed by an ordered list item. It converts all rendered lines to strings, checks that '1. Tight item' appears, and checks that the output does not contain a marker-only line followed by the item text.

**Call relations**: The test uses append_markdown for the rendering path and lines_to_strings for inspection. It verifies list behavior in a more realistic surrounding context.

*Call graph*: calls 1 internal fn (append_markdown); 3 external calls (new, assert!, lines_to_strings).


##### `tests::append_markdown_agent_unwraps_markdown_fences_for_table_rendering`  (lines 398–405)

```
fn append_markdown_agent_unwraps_markdown_fences_for_table_rendering()
```

**Purpose**: This test proves that a table inside a ```markdown fence is unwrapped and rendered as a real table. It checks the main reason the agent-specific cleanup exists.

**Data flow**: It sends a fenced Markdown table through append_markdown_agent, converts the output to strings, and checks for table-drawing characters and table cell text rather than raw pipe syntax.

**Call relations**: The test calls append_markdown_agent, which calls unwrap_markdown_fences before rendering. It confirms the cleanup and renderer cooperate to produce native table output.

*Call graph*: calls 1 internal fn (append_markdown_agent); 3 external calls (new, assert!, lines_to_strings).


##### `tests::append_markdown_agent_unwraps_markdown_fences_for_no_outer_table_rendering`  (lines 408–424)

```
fn append_markdown_agent_unwraps_markdown_fences_for_no_outer_table_rendering()
```

**Purpose**: This test checks that table text without leading and trailing outer pipe characters is still recognized inside a Markdown fence. It protects a common compact table style.

**Data flow**: It renders a ```md fenced table with three columns and no outer pipes. It then checks that the output contains table-drawing characters and formatted cell text, and that the raw header line is not shown as plain code.

**Call relations**: The test runs through append_markdown_agent and then inspects the rendered strings. It verifies that the fence unwrapping supports more than one table spelling style.

*Call graph*: calls 1 internal fn (append_markdown_agent); 3 external calls (new, assert!, lines_to_strings).


##### `tests::append_markdown_agent_unwraps_markdown_fences_for_two_column_no_outer_table`  (lines 427–435)

```
fn append_markdown_agent_unwraps_markdown_fences_for_two_column_no_outer_table()
```

**Purpose**: This test checks the same no-outer-pipe table style for a smaller two-column table. It makes sure the table detection is not tied only to wider examples.

**Data flow**: It sends a two-column fenced Markdown table through append_markdown_agent, converts output lines to strings, and checks for table formatting and row content while ensuring the raw header is not left visible.

**Call relations**: The test exercises append_markdown_agent and its call to unwrap_markdown_fences. It adds coverage for a simpler table shape.

*Call graph*: calls 1 internal fn (append_markdown_agent); 3 external calls (new, assert!, lines_to_strings).


##### `tests::append_markdown_agent_unwraps_markdown_fences_for_single_column_table`  (lines 438–445)

```
fn append_markdown_agent_unwraps_markdown_fences_for_single_column_table()
```

**Purpose**: This test verifies that even a one-column Markdown table inside a Markdown fence can be unwrapped. It prevents table detection from assuming every table has multiple columns.

**Data flow**: It renders a fenced one-column table through append_markdown_agent, converts the output to strings, and checks that table formatting appears while the raw pipe header does not.

**Call relations**: The test uses the agent rendering path to confirm that unwrap_markdown_fences recognizes single-column tables before the Markdown renderer draws them.

*Call graph*: calls 1 internal fn (append_markdown_agent); 3 external calls (new, assert!, lines_to_strings).


##### `tests::append_markdown_agent_keeps_non_markdown_fences_as_code`  (lines 448–461)

```
fn append_markdown_agent_keeps_non_markdown_fences_as_code()
```

**Purpose**: This test makes sure non-Markdown code fences, such as ```rust, are not unwrapped even if their contents look like a table. That prevents real code examples from being misread as Markdown tables.

**Data flow**: It renders a Rust-fenced block containing table-like lines through append_markdown_agent. It converts the result to plain strings and checks that the three raw code lines are preserved.

**Call relations**: The test calls append_markdown_agent, which calls unwrap_markdown_fences. It verifies that the cleanup step only targets Markdown-labeled fences, not arbitrary code blocks.

*Call graph*: calls 1 internal fn (append_markdown_agent); 3 external calls (new, assert_eq!, lines_to_strings).


##### `tests::append_markdown_agent_unwraps_blockquoted_markdown_fence_table`  (lines 464–471)

```
fn append_markdown_agent_unwraps_blockquoted_markdown_fence_table()
```

**Purpose**: This test checks that a Markdown table inside a blockquoted Markdown fence can still be unwrapped. A blockquote is Markdown text that starts with '>' to show quoted material.

**Data flow**: It passes a blockquoted fenced table directly to unwrap_markdown_fences and checks that the returned text no longer contains fence markers.

**Call relations**: Unlike many tests, this one calls unwrap_markdown_fences directly. It focuses on the cleanup logic’s ability to understand fences inside quoted text.

*Call graph*: calls 1 internal fn (unwrap_markdown_fences); 1 external calls (assert!).


##### `tests::append_markdown_agent_keeps_non_blockquoted_markdown_fence_with_blockquote_table_example`  (lines 474–478)

```
fn append_markdown_agent_keeps_non_blockquoted_markdown_fence_with_blockquote_table_example()
```

**Purpose**: This test verifies a conservative edge case: a normal Markdown fence containing a blockquoted table example should stay fenced. It prevents the cleanup from changing examples that are meant to be shown as code.

**Data flow**: It passes a non-blockquoted ```markdown fence whose content lines are blockquoted table text into unwrap_markdown_fences. It checks that the returned text is exactly the original source.

**Call relations**: The test calls unwrap_markdown_fences directly. It confirms that the function distinguishes a blockquoted fence from a plain fence containing blockquoted-looking content.

*Call graph*: calls 1 internal fn (unwrap_markdown_fences); 1 external calls (assert_eq!).


##### `tests::append_markdown_agent_keeps_markdown_fence_when_content_is_not_table`  (lines 481–487)

```
fn append_markdown_agent_keeps_markdown_fence_when_content_is_not_table()
```

**Purpose**: This test checks that a Markdown fence without a table remains a code block. It protects intentional examples like fenced '**bold**' from being rendered as real bold text.

**Data flow**: It renders a ```markdown block containing bold Markdown syntax through append_markdown_agent. After converting output to strings, it expects to see the literal text '**bold**'.

**Call relations**: The test goes through append_markdown_agent and therefore through unwrap_markdown_fences. It proves that Markdown-labeled fences are only removed when their contents look like a table.

*Call graph*: calls 1 internal fn (append_markdown_agent); 3 external calls (new, assert_eq!, lines_to_strings).


##### `tests::unwrap_markdown_fences_repro_keeps_fence_without_header_delimiter_pair`  (lines 490–494)

```
fn unwrap_markdown_fences_repro_keeps_fence_without_header_delimiter_pair()
```

**Purpose**: This regression test checks that table-like lines are not enough to trigger unwrapping unless there is a proper header line immediately followed by a delimiter line. It avoids false positives.

**Data flow**: It passes a Markdown fence with a header-looking row, a non-delimiter line, and then a delimiter-looking row into unwrap_markdown_fences. It checks that the output exactly matches the input.

**Call relations**: The test calls unwrap_markdown_fences directly. It locks in the rule that table detection requires the right neighboring line pattern.

*Call graph*: calls 1 internal fn (unwrap_markdown_fences); 1 external calls (assert_eq!).


##### `tests::append_markdown_agent_keeps_markdown_fence_with_blank_line_between_header_and_delimiter`  (lines 497–501)

```
fn append_markdown_agent_keeps_markdown_fence_with_blank_line_between_header_and_delimiter()
```

**Purpose**: This test verifies that a blank line between a table header and delimiter prevents unwrapping. It keeps the table detector strict and predictable.

**Data flow**: It passes a fenced Markdown block with a blank line between the header row and delimiter row into unwrap_markdown_fences. It expects the function to return the original text unchanged.

**Call relations**: The test calls unwrap_markdown_fences directly. It protects the conservative behavior that only clear, valid table patterns are unwrapped.

*Call graph*: calls 1 internal fn (unwrap_markdown_fences); 1 external calls (assert_eq!).


### `tui/src/markdown_stream.rs`

`domain_logic` · `streaming response rendering`

Markdown can be tricky while it is still arriving. A line that currently looks like plain text might become a heading, a table row, a list item, or part of a code block once the rest of the line appears. This file solves that by acting like a small waiting room for incoming text. The main type, `MarkdownStreamCollector`, stores raw markdown chunks in a string buffer and remembers how much of that buffer has already been released. During normal use it does not parse or draw markdown itself. It simply says, “everything up to the last newline is complete enough to process.” The stream controller can then re-render from stable source text without guessing about unfinished lines. When the stream ends, the collector flushes the remaining text, adding a newline if needed so markdown block parsing works cleanly. In tests, the same collector also has helpers that render completed lines, so the project can check that streamed rendering matches full rendering. The many tests protect against subtle display bugs: duplicated list items, headings getting glued to paragraphs, blockquotes losing color when wrapped, tables being delayed incorrectly, and Unicode text being cut at unsafe points.

#### Function details

##### `MarkdownStreamCollector::new`  (lines 46–59)

```
fn new(width: Option<usize>, cwd: &Path) -> Self
```

**Purpose**: Creates a fresh collector for one stream of markdown text. It starts with an empty buffer and no committed text, and in tests it also remembers the current directory so local file links render consistently.

**Data flow**: It receives an optional display width and a current directory path. It stores the width, creates an empty text buffer, sets the committed position to zero, and in test builds copies the directory path. The result is a ready-to-use `MarkdownStreamCollector`.

**Call relations**: Test helpers and many tests call this at the start of a simulated stream. In production-style flow, this is the first step before chunks are fed in with `push_delta` and later released with commit or finalize methods.

*Call graph*: called by 9 (simulate_stream_markdown_for_tests, collector_source_chunks_round_trip_into_agent_fence_unwrapping, finalize_commits_partial_line, heading_not_inlined_when_split_across_chunks, heading_starts_on_new_line_when_following_paragraph, no_commit_until_newline, pipe_text_without_table_prefix_is_not_delayed, table_header_commits_without_holdback, new); 2 external calls (to_path_buf, new).


##### `MarkdownStreamCollector::set_width`  (lines 62–64)

```
fn set_width(&mut self, width: Option<usize>)
```

**Purpose**: Changes the width used by the test-only rendering helpers. This lets tests simulate a terminal width change without rebuilding the collector.

**Data flow**: It receives a new optional width and replaces the collector’s stored width with it. Nothing is returned, and the buffered markdown text is not changed.

**Call relations**: This method is part of the collector’s support API. The provided call graph does not show a caller here, but it is meant to affect later test rendering done by `commit_complete_lines` or `finalize_and_drain`.


##### `MarkdownStreamCollector::clear`  (lines 67–74)

```
fn clear(&mut self)
```

**Purpose**: Resets the collector so it can be reused for another stream. It removes all buffered text and forgets what had been committed.

**Data flow**: It takes the collector’s current buffer and bookkeeping state, empties the buffer, resets the committed byte count to zero, and in tests resets the committed rendered line count too. It returns nothing.

**Call relations**: `finalize_and_drain_source` and `finalize_and_drain` call this after they flush the final content. It is the cleanup step that prevents old streamed text from leaking into the next stream.

*Call graph*: called by 3 (finalize_and_drain, finalize_and_drain_source, clear).


##### `MarkdownStreamCollector::push_delta`  (lines 77–80)

```
fn push_delta(&mut self, delta: &str)
```

**Purpose**: Adds one newly arrived piece of markdown text to the collector. A “delta” here means a small chunk of streamed output.

**Data flow**: It receives a text slice, writes a trace log for debugging, and appends the text to the end of the internal buffer. It returns nothing; the collector now contains more source text.

**Call relations**: Stream simulations and real stream controllers call this whenever new text arrives. After a pushed delta contains a newline, callers usually ask `commit_complete_source` or, in tests, `commit_complete_lines` for the newly completed part.

*Call graph*: 1 external calls (trace!).


##### `MarkdownStreamCollector::commit_complete_source`  (lines 87–96)

```
fn commit_complete_source(&mut self) -> Option<String>
```

**Purpose**: Returns only the new raw markdown text that is safely complete, ending at the most recent newline. If no new complete line exists, it returns nothing.

**Data flow**: It looks inside the buffer for the last newline. If there is no newline, or if all text up to that newline was already committed earlier, it returns `None`. Otherwise it copies the newly completed slice, advances the committed byte position, and returns that slice as a string.

**Call relations**: This is the production-facing commit point used by stream controllers and exercised by `collector_source_chunks_round_trip_into_agent_fence_unwrapping`. It deliberately hands off raw source rather than rendered lines, so later rendering can be done with the full accumulated markdown context.


##### `MarkdownStreamCollector::finalize_and_drain_source`  (lines 104–116)

```
fn finalize_and_drain_source(&mut self) -> String
```

**Purpose**: Flushes the last uncommitted raw markdown when a stream ends. This covers the common case where the final line does not end with a newline.

**Data flow**: It compares the committed byte position with the buffer length. If nothing remains, it clears the collector and returns an empty string. If text remains, it copies that tail, adds a newline when missing, clears the collector, and returns the final source chunk.

**Call relations**: Callers use this after the stream is truly complete, or when intentionally consolidating interrupted output. It calls `clear` as its cleanup step, so it should not be used while more chunks from the same stream are expected.

*Call graph*: calls 1 internal fn (clear); 1 external calls (new).


##### `MarkdownStreamCollector::commit_complete_lines`  (lines 126–155)

```
fn commit_complete_lines(&mut self) -> Vec<Line<'static>>
```

**Purpose**: In test builds, renders the completed part of the buffered markdown and returns only the newly completed display lines. This helps tests check streaming behavior without involving the full stream controller.

**Data flow**: It finds the latest newline and renders the buffer up to that point with `append_markdown`. It trims a final spaces-only blank line from the count, compares the rendered line count with what was already returned, and returns only the new lines. It also updates both the committed source position and committed line count.

**Call relations**: The stream simulation helper and many tests call this after chunks that contain newlines. It hands raw completed source to the markdown renderer, then filters the rendered result down to just the new portion being tested.

*Call graph*: calls 2 internal fn (append_markdown, is_blank_line_spaces_only); 2 external calls (as_path, new).


##### `MarkdownStreamCollector::finalize_and_drain`  (lines 161–191)

```
fn finalize_and_drain(&mut self) -> Vec<Line<'static>>
```

**Purpose**: In test builds, renders and returns any display lines that remain when a simulated stream finishes. It makes sure even an unfinished last line is shown at the end.

**Data flow**: It copies the full buffer, adds a temporary newline if needed, logs debug information, renders the source with `append_markdown`, and returns only rendered lines that were not already committed. Then it clears the collector.

**Call relations**: `simulate_stream_markdown_for_tests` calls this when a test asks to finalize the stream. Like `finalize_and_drain_source`, it is an end-of-stream operation and uses `clear` to reset state afterward.

*Call graph*: calls 2 internal fn (append_markdown, clear); 4 external calls (as_path, new, debug!, trace!).


##### `test_cwd`  (lines 195–199)

```
fn test_cwd() -> PathBuf
```

**Purpose**: Provides a stable current directory for tests. This avoids tying expected output to a particular operating system root path.

**Data flow**: It reads the system temporary directory path and returns it as a `PathBuf`, which is an owned path value. It does not change global state.

**Call relations**: `simulate_stream_markdown_for_tests` uses this when creating a collector, and many tests use it through that helper or directly. It supports predictable rendering of local file links in test-only markdown rendering.

*Call graph*: called by 1 (simulate_stream_markdown_for_tests); 1 external calls (temp_dir).


##### `simulate_stream_markdown_for_tests`  (lines 202–218)

```
fn simulate_stream_markdown_for_tests(
    deltas: &[&str],
    finalize: bool,
) -> Vec<Line<'static>>
```

**Purpose**: Runs a small fake markdown stream for tests. It feeds chunks into a collector the same way real streamed output would arrive, then gathers the rendered lines.

**Data flow**: It receives a list of text chunks and a flag saying whether to finalize. It creates a collector, pushes each chunk, commits rendered lines whenever a chunk contains a newline, optionally drains the final remainder, and returns all collected rendered lines.

**Call relations**: Many tests use this as their main harness. It calls `MarkdownStreamCollector::new`, `push_delta`, `commit_complete_lines`, and sometimes `finalize_and_drain`, so individual tests can focus on expected output rather than repeating stream setup.

*Call graph*: calls 2 internal fn (new, test_cwd); called by 6 (assert_streamed_equals_full, empty_fenced_block_is_dropped_and_separator_preserved_before_heading, loose_list_with_split_dashes_matches_full_render, loose_vs_tight_list_items_streaming_matches_full, paragraph_then_empty_fence_then_heading_keeps_heading_on_new_line, utf8_boundary_safety_and_wide_chars); 1 external calls (new).


##### `tests::no_commit_until_newline`  (lines 226–234)

```
async fn no_commit_until_newline()
```

**Purpose**: Checks the collector’s central rule: do not release streamed markdown until a newline arrives. This prevents half-finished lines from being rendered too early.

**Data flow**: It creates a collector, pushes text without a newline, and confirms no lines are emitted. Then it pushes the newline that completes the line and confirms exactly one line is emitted.

**Call relations**: This test directly exercises `MarkdownStreamCollector::new`, `push_delta`, and `commit_complete_lines`. It verifies the behavior that stream controllers rely on before they re-render completed markdown.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert!, assert_eq!, test_cwd).


##### `tests::finalize_commits_partial_line`  (lines 237–242)

```
async fn finalize_commits_partial_line()
```

**Purpose**: Checks that the final unfinished line is not lost when a stream ends. A response may end without a trailing newline, and users still need to see that text.

**Data flow**: It creates a collector, pushes a line without a newline, finalizes the collector, and asserts that one rendered line comes out. The collector is drained as part of finalization.

**Call relations**: This test focuses on `finalize_and_drain`. It complements the newline rule by proving that the rule is relaxed only at the true end of the stream.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert_eq!, test_cwd).


##### `tests::e2e_stream_blockquote_simple_is_green`  (lines 245–255)

```
async fn e2e_stream_blockquote_simple_is_green()
```

**Purpose**: Checks that a simple streamed blockquote is rendered with the expected green style. A blockquote is markdown text that starts with `>`.

**Data flow**: It simulates a stream containing one blockquote line, collects the rendered output, and inspects the line’s foreground color. The expected result is one green line.

**Call relations**: This test uses `simulate_stream_markdown_for_tests`, which exercises the collector and markdown renderer together. It protects the connection between streaming boundaries and blockquote styling.

*Call graph*: 2 external calls (assert_eq!, simulate_stream_markdown_for_tests).


##### `tests::e2e_stream_blockquote_nested_is_green`  (lines 258–281)

```
async fn e2e_stream_blockquote_nested_is_green()
```

**Purpose**: Checks that nested blockquotes keep the same green styling when streamed. Nested blockquotes use repeated `>` markers.

**Data flow**: It simulates two blockquote lines, filters away blank quote-only lines that may appear around paragraphs, and confirms both meaningful lines are green. The output is used only for assertions.

**Call relations**: This test relies on `simulate_stream_markdown_for_tests` to drive the collector. It makes sure streaming does not break styling for multiple quote levels.

*Call graph*: 2 external calls (assert_eq!, simulate_stream_markdown_for_tests).


##### `tests::e2e_stream_blockquote_with_list_items_is_green`  (lines 284–292)

```
async fn e2e_stream_blockquote_with_list_items_is_green()
```

**Purpose**: Checks that list items inside a blockquote are still styled as blockquotes. This matters because nested markdown features can easily lose the parent style.

**Data flow**: It simulates two quoted bullet-list lines, receives rendered lines, and asserts that each line’s foreground color is green.

**Call relations**: The test goes through the stream simulation helper, so it tests the collector and renderer together. It catches regressions where list rendering might override quote coloring.

*Call graph*: 2 external calls (assert_eq!, simulate_stream_markdown_for_tests).


##### `tests::e2e_stream_nested_mixed_lists_ordered_marker_is_light_blue`  (lines 295–323)

```
async fn e2e_stream_nested_mixed_lists_ordered_marker_is_light_blue()
```

**Purpose**: Checks styling for a deeply nested ordered-list marker in streamed markdown. An ordered-list marker is text like `1.` at the start of a numbered item.

**Data flow**: It streams a mixed numbered and bullet list, searches the rendered lines for the third-level ordered item, and checks that at least one span on that line is light blue. A span is a styled piece of a terminal line.

**Call relations**: This test uses the stream simulation helper and then inspects the rendered result. It protects the visual styling rules for nested list markers during incremental rendering.

*Call graph*: 2 external calls (assert!, simulate_stream_markdown_for_tests).


##### `tests::e2e_stream_blockquote_wrap_preserves_green_style`  (lines 326–360)

```
async fn e2e_stream_blockquote_wrap_preserves_green_style()
```

**Purpose**: Checks that a long blockquote keeps its green style after word wrapping. Word wrapping means splitting a long visual line across terminal-width lines.

**Data flow**: It simulates a long quoted line, wraps the rendered output to a narrow width, removes blank lines, and confirms every wrapped piece begins with green styling.

**Call relations**: The test starts with `simulate_stream_markdown_for_tests` and then hands the output to `word_wrap_lines`. It verifies that styling survives both streaming and later terminal wrapping.

*Call graph*: calls 2 internal fn (new, word_wrap_lines); 3 external calls (assert!, assert_eq!, simulate_stream_markdown_for_tests).


##### `tests::heading_starts_on_new_line_when_following_paragraph`  (lines 363–415)

```
async fn heading_starts_on_new_line_when_following_paragraph()
```

**Purpose**: Checks that a heading streamed after a paragraph starts on its own line. Without this, the display could wrongly glue a heading to the previous paragraph.

**Data flow**: It pushes a paragraph line and commits it, then pushes a heading line and commits again. It converts rendered lines to plain text and verifies the first commit contains the paragraph, while the second contains a blank separator and the heading.

**Call relations**: This test uses the collector directly instead of the simulation helper, so it can inspect each commit separately. It guards the incremental behavior around paragraph-to-heading transitions.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert_eq!, test_cwd).


##### `tests::heading_not_inlined_when_split_across_chunks`  (lines 418–489)

```
async fn heading_not_inlined_when_split_across_chunks()
```

**Purpose**: Checks a harder heading case where the newline and heading text arrive in separate chunks. The heading should still not be merged into the previous sentence.

**Data flow**: It pushes a paragraph without a newline and confirms nothing commits. Then it pushes a newline plus the start of a heading, commits only the completed paragraph, pushes the final heading newline, and confirms the heading appears separately. It also renders a simple full markdown line as a sanity check.

**Call relations**: This test directly drives `MarkdownStreamCollector` and also calls `append_markdown` for comparison. It proves the collector’s newline boundary rule works even when markdown syntax is split across chunks.

*Call graph*: calls 2 internal fn (append_markdown, new); 4 external calls (new, assert!, assert_eq!, test_cwd).


##### `tests::lines_to_plain_strings`  (lines 491–502)

```
fn lines_to_plain_strings(lines: &[ratatui::text::Line<'_>]) -> Vec<String>
```

**Purpose**: Turns styled terminal lines into plain strings for easier test comparisons. It ignores colors and other style information.

**Data flow**: It receives rendered `Line` values, walks through each line’s spans, joins their text content, and returns a vector of plain strings.

**Call relations**: Many tests call this after using the collector or markdown renderer. It is a small test utility that lets assertions compare readable text instead of full styled structures.

*Call graph*: 1 external calls (iter).


##### `tests::table_header_commits_without_holdback`  (lines 505–529)

```
async fn table_header_commits_without_holdback()
```

**Purpose**: Checks that table-like markdown lines continue to commit as newlines arrive. The collector itself should not delay table rows using special table rules.

**Data flow**: It pushes a table header, delimiter, body row, and blank line in sequence. After each important push, it commits rendered lines and confirms output continues to appear.

**Call relations**: This test calls the collector directly and uses `lines_to_plain_strings` for assertions. It confirms that table-specific waiting behavior, if any, belongs outside this collector.

*Call graph*: calls 1 internal fn (new); 4 external calls (assert!, assert_eq!, test_cwd, lines_to_plain_strings).


##### `tests::pipe_text_without_table_prefix_is_not_delayed`  (lines 532–538)

```
async fn pipe_text_without_table_prefix_is_not_delayed()
```

**Purpose**: Checks that ordinary text containing pipe characters is not mistaken for a table and delayed. A pipe is the `|` character often used in markdown tables.

**Data flow**: It pushes one completed text line containing pipes, commits it, converts the output to plain text, and asserts the line appears immediately.

**Call relations**: This test uses the collector directly and relies on `lines_to_plain_strings` to compare output. It reinforces that the collector commits by newline, not by guessing markdown table structure.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, test_cwd, lines_to_plain_strings).


##### `tests::lists_and_fences_commit_without_duplication`  (lines 541–547)

```
async fn lists_and_fences_commit_without_duplication()
```

**Purpose**: Checks that streamed lists and fenced code blocks do not duplicate lines compared with rendering the full markdown at once. A fenced code block is text surrounded by lines like triple backticks.

**Data flow**: It passes list chunks and code-fence chunks to `assert_streamed_equals_full`. That helper compares streamed rendering with full rendering.

**Call relations**: This test delegates the detailed work to `tests::assert_streamed_equals_full`. It captures two common markdown structures where incremental rendering can easily repeat content.

*Call graph*: 1 external calls (assert_streamed_equals_full).


##### `tests::utf8_boundary_safety_and_wide_chars`  (lines 550–582)

```
async fn utf8_boundary_safety_and_wide_chars()
```

**Purpose**: Checks that streamed Unicode text is not cut, duplicated, or corrupted. This includes emoji, East Asian characters, control characters, and combining marks.

**Data flow**: It defines a full Unicode input and a list of chunks that split that input in realistic places. It renders the chunks through the streaming helper, renders the full input directly with `append_markdown`, converts both to plain strings, and asserts they match.

**Call relations**: This test connects `simulate_stream_markdown_for_tests`, `append_markdown`, and `lines_to_plain_strings`. It protects against byte-position bookkeeping bugs in the collector.

*Call graph*: calls 2 internal fn (append_markdown, simulate_stream_markdown_for_tests); 5 external calls (new, assert_eq!, test_cwd, lines_to_plain_strings, vec!).


##### `tests::e2e_stream_deep_nested_third_level_marker_is_light_blue`  (lines 585–631)

```
async fn e2e_stream_deep_nested_third_level_marker_is_light_blue()
```

**Purpose**: Checks exactly how a third-level ordered-list marker is styled in streamed output. It also confirms the following item text keeps the default color.

**Data flow**: It streams a deep mixed list, finds the line containing the third-level ordered item, checks that the first span is light blue, and then checks that the first real content span after the marker has no special foreground color.

**Call relations**: This test uses `simulate_stream_markdown_for_tests` and `lines_to_plain_strings` for diagnostics. It is a more precise version of the nested-list styling test.

*Call graph*: 4 external calls (assert!, assert_eq!, simulate_stream_markdown_for_tests, lines_to_plain_strings).


##### `tests::empty_fenced_block_is_dropped_and_separator_preserved_before_heading`  (lines 634–649)

```
async fn empty_fenced_block_is_dropped_and_separator_preserved_before_heading()
```

**Purpose**: Checks that an empty fenced code block does not render visible fence markers, while a following heading still appears properly. Empty code fences should not clutter the terminal display.

**Data flow**: It streams an empty fenced block followed by a heading, finalizes, converts output to plain text, and asserts that no line contains fence markers while the heading is present.

**Call relations**: This test uses `simulate_stream_markdown_for_tests` and `lines_to_plain_strings`. It protects the interaction between stream boundaries, empty code blocks, and heading placement.

*Call graph*: calls 1 internal fn (simulate_stream_markdown_for_tests); 3 external calls (assert!, lines_to_plain_strings, vec!).


##### `tests::paragraph_then_empty_fence_then_heading_keeps_heading_on_new_line`  (lines 652–668)

```
async fn paragraph_then_empty_fence_then_heading_keeps_heading_on_new_line()
```

**Purpose**: Checks that an empty fenced code block between a paragraph and a heading does not cause the heading to merge with the paragraph.

**Data flow**: It streams a paragraph, an empty fence, and a heading. It converts rendered output to plain text, finds the paragraph and heading positions, and asserts the heading comes later.

**Call relations**: This test uses the stream simulation helper for the full incremental path. It focuses on layout order rather than exact styling.

*Call graph*: calls 1 internal fn (simulate_stream_markdown_for_tests); 4 external calls (assert!, panic!, lines_to_plain_strings, vec!).


##### `tests::loose_list_with_split_dashes_matches_full_render`  (lines 671–694)

```
async fn loose_list_with_split_dashes_matches_full_render()
```

**Purpose**: Checks a previously problematic case where a loose list and a split dash could produce mismatched streamed output. A loose list has blank lines between parts of list items.

**Data flow**: It streams two chunks, including one ending in a lone dash, and collects the streamed plain strings. It also joins the chunks into one full markdown string, renders that directly, and asserts both results match.

**Call relations**: This test uses `simulate_stream_markdown_for_tests`, `append_markdown`, and `lines_to_plain_strings`. It protects against dangling list-marker artifacts during finalization.

*Call graph*: calls 2 internal fn (append_markdown, simulate_stream_markdown_for_tests); 5 external calls (new, assert_eq!, test_cwd, lines_to_plain_strings, vec!).


##### `tests::loose_vs_tight_list_items_streaming_matches_full`  (lines 697–801)

```
async fn loose_vs_tight_list_items_streaming_matches_full()
```

**Purpose**: Checks a realistic streamed section mixing tight and loose numbered lists. Tight lists have no blank paragraphs inside items; loose lists do.

**Data flow**: It feeds many small chunks into the stream simulator, converts the result to plain strings, also performs a full render for diagnostics, and asserts the streamed strings match an exact expected list of lines.

**Call relations**: This test is driven by `simulate_stream_markdown_for_tests` and uses direct markdown rendering as backup context. It guards against subtle list numbering, indentation, and paragraph-spacing regressions.

*Call graph*: calls 2 internal fn (append_markdown, simulate_stream_markdown_for_tests); 5 external calls (new, assert_eq!, test_cwd, lines_to_plain_strings, vec!).


##### `tests::assert_streamed_equals_full`  (lines 804–818)

```
async fn assert_streamed_equals_full(deltas: &[&str])
```

**Purpose**: Provides a shared test check: streamed rendering must match rendering the complete markdown all at once. This is the main comparison helper for fuzz-derived tests.

**Data flow**: It receives chunks, renders them through `simulate_stream_markdown_for_tests`, joins them into one full string, renders that full string with `append_markdown`, converts both outputs to plain strings, and asserts equality.

**Call relations**: Several tests call this helper instead of repeating the comparison logic. It ties the collector’s incremental behavior back to the expected full-render behavior.

*Call graph*: calls 2 internal fn (append_markdown, simulate_stream_markdown_for_tests); 4 external calls (new, assert_eq!, test_cwd, lines_to_plain_strings).


##### `tests::fuzz_class_bullet_duplication_variant_1`  (lines 821–827)

```
async fn fuzz_class_bullet_duplication_variant_1()
```

**Purpose**: Checks one fuzz-found bullet-list case that previously risked duplicated output. Fuzzing means testing with many generated or unusual inputs to find edge cases.

**Data flow**: It sends a small set of split bullet-list chunks to `assert_streamed_equals_full`. The assertion passes only if streamed and full rendering produce the same plain lines.

**Call relations**: This test delegates to `tests::assert_streamed_equals_full`. It preserves a specific regression case so future changes do not reintroduce the bug.

*Call graph*: 1 external calls (assert_streamed_equals_full).


##### `tests::fuzz_class_bullet_duplication_variant_2`  (lines 830–836)

```
async fn fuzz_class_bullet_duplication_variant_2()
```

**Purpose**: Checks a second fuzz-found bullet-list duplication case. It covers a different split point inside list text.

**Data flow**: It passes the chunk sequence to `assert_streamed_equals_full`, which compares streamed rendering against full rendering. The test itself returns no data beyond pass or fail.

**Call relations**: Like the first fuzz variant, this is a compact regression test built on the shared comparison helper.

*Call graph*: 1 external calls (assert_streamed_equals_full).


##### `tests::streaming_html_block_then_text_matches_full`  (lines 839–846)

```
async fn streaming_html_block_then_text_matches_full()
```

**Purpose**: Checks that an HTML block followed by normal text streams the same way it renders as a complete document. Markdown often allows raw HTML blocks, which can affect surrounding parsing.

**Data flow**: It sends chunks containing a label, an inline HTML block line, and following text to `assert_streamed_equals_full`. The helper compares streamed and full plain-text output.

**Call relations**: This test delegates to the shared streamed-versus-full helper. It makes sure newline-based committing does not mis-handle markdown’s HTML block rules.

*Call graph*: 1 external calls (assert_streamed_equals_full).


##### `tests::table_like_lines_inside_fenced_code_are_not_held`  (lines 849–851)

```
async fn table_like_lines_inside_fenced_code_are_not_held()
```

**Purpose**: Checks that table-looking text inside a code block is treated as code, not as a real markdown table waiting for more rows. This matters for snippets that contain pipe characters.

**Data flow**: It streams an opening code fence, a pipe-separated line, and a closing fence through `assert_streamed_equals_full`. The streamed result must match full rendering.

**Call relations**: This test uses the shared comparison helper. It protects the boundary between code-fence parsing and table-like text.

*Call graph*: 1 external calls (assert_streamed_equals_full).


##### `tests::collector_source_chunks_round_trip_into_agent_fence_unwrapping`  (lines 854–888)

```
async fn collector_source_chunks_round_trip_into_agent_fence_unwrapping()
```

**Purpose**: Checks the production-style raw source path used with agent markdown rendering. It verifies that chunks emitted by the collector can later be rendered with agent-specific markdown fence unwrapping.

**Data flow**: It streams a markdown-fenced table through `MarkdownStreamCollector`, collecting raw source chunks with `commit_complete_source` and `finalize_and_drain_source`. It then renders the combined source with `append_markdown_agent`, converts output to plain strings, and asserts that a table separator appears while the raw table header does not.

**Call relations**: This test directly exercises the raw-source commit API rather than the test-only line API. It shows how stream controllers can collect safe source chunks first, then hand the accumulated markdown to the agent renderer for final display behavior.

*Call graph*: calls 2 internal fn (append_markdown_agent, new); 5 external calls (new, new, assert!, test_cwd, lines_to_plain_strings).


### `tui/src/streaming/mod.rs`

`domain_logic` · `active during live TUI transcript streaming`

When an answer is streaming into the terminal, it does not always arrive as neat, complete lines. This file provides the small storage area that sits between “raw markdown is still arriving” and “finished lines are ready to show.” The main type, `StreamState`, owns a markdown collector, which gathers and renders incoming markdown, plus a queue of completed `HyperlinkLine` values, which are terminal-ready lines that may include clickable links.

The important rule is simple: lines leave in the same order they arrived. Think of it like a checkout line at a shop. New finished lines join the back of the queue, and the display code takes lines from the front. Each queued line also records the time it entered the queue, so later policy code can ask, “How long has the oldest line been waiting?” without inspecting the text itself.

The file also exposes nearby streaming submodules for chunk sizing, commit timing, controller behavior, and table holdback. Those pieces decide when and how much to draw. `StreamState` is the shared storage they depend on. Without it, streamed output could appear out of order, drain too aggressively, or lose track of whether there is anything waiting to be committed to the transcript.

#### Function details

##### `StreamState::new`  (lines 41–47)

```
fn new(width: Option<usize>, cwd: &Path) -> Self
```

**Purpose**: Creates a fresh streaming state for one active stream. It prepares the markdown collector with the terminal width and current working directory, so local file links can be rendered correctly.

**Data flow**: It receives an optional display width and a filesystem path for the current directory. It builds a new markdown collector from those values, starts with an empty line queue, marks that no streamed text has arrived yet, and returns the ready-to-use `StreamState`.

**Call relations**: This is the starting point for code that needs a streaming buffer. Higher-level setup code calls it when creating stream-related state, and the test in this file also uses it to create a small queue for checking drain behavior.

*Call graph*: calls 1 internal fn (new); called by 2 (new, drain_n_clamps_to_available_lines); 1 external calls (new).


##### `StreamState::clear`  (lines 49–53)

```
fn clear(&mut self)
```

**Purpose**: Resets the whole streaming state so it can be reused for the next stream. This clears both the partially collected markdown and any finished lines still waiting in the queue.

**Data flow**: It takes an existing mutable `StreamState`. It tells the markdown collector to forget its current content, empties the queued display lines, resets the “seen any delta yet” flag, and returns nothing.

**Call relations**: It is used by reset logic when a stream lifecycle ends or restarts. Rather than creating separate cleanup steps in multiple places, callers can ask this method to put the stream state back into its initial empty condition.

*Call graph*: calls 1 internal fn (clear); called by 1 (reset); 1 external calls (clear).


##### `StreamState::step`  (lines 55–61)

```
fn step(&mut self) -> Vec<HyperlinkLine>
```

**Purpose**: Takes one finished line from the front of the queue for display. It is the smallest possible drain operation: reveal at most one queued line.

**Data flow**: It reads the front of the queued-lines list. If a line is waiting, it removes that one item and returns it inside a vector; if the queue is empty, it returns an empty vector. The queue is changed only by removing that first item.

**Call relations**: The streaming tick logic calls this when it wants to advance the transcript one line at a time. This method does not decide when a tick should happen; it simply performs the safe, ordered removal requested by that outer controller.

*Call graph*: called by 1 (tick); 1 external calls (pop_front).


##### `StreamState::drain_n`  (lines 66–72)

```
fn drain_n(&mut self, max_lines: usize) -> Vec<HyperlinkLine>
```

**Purpose**: Takes several finished lines from the front of the queue, up to a requested maximum. This lets the UI catch up faster when many lines are waiting.

**Data flow**: It receives a maximum number of lines to remove. It compares that number with the actual queue length, drains only the available amount, converts the stored queue entries back into plain `HyperlinkLine` values, and returns them in their original order.

**Call relations**: Batch ticking code calls this when policy has decided that more than one line should be committed at once. The method protects callers from asking for too much by automatically clamping the request to the number of queued lines.

*Call graph*: called by 1 (tick_batch); 2 external calls (drain, len).


##### `StreamState::clear_queue`  (lines 74–76)

```
fn clear_queue(&mut self)
```

**Purpose**: Empties only the committed-line queue while leaving the markdown collector and stream lifecycle flags alone. This is useful when the already-rendered queue must be rebuilt without pretending the whole stream restarted.

**Data flow**: It receives mutable access to the state, removes every queued line, and returns nothing. The collector and `has_seen_delta` flag stay as they were.

**Call relations**: Rendering code calls this while rebuilding or synchronizing stable output, and when display settings such as render mode or width change. Those callers can discard stale queued lines and then refill the queue from a freshly rendered view.

*Call graph*: called by 4 (rebuild_stable_queue_from_render, set_render_mode, set_width, sync_stable_queue); 1 external calls (clear).


##### `StreamState::is_idle`  (lines 78–80)

```
fn is_idle(&self) -> bool
```

**Purpose**: Answers whether there are no finished lines waiting to be committed to the transcript. Callers use it to know whether the streaming queue has work left.

**Data flow**: It reads the queued-lines list and checks whether it is empty. It returns `true` if nothing is waiting and `false` otherwise, without changing the state.

**Call relations**: Outer idle-checking code calls this as part of deciding whether the stream still needs display work. It acts as a simple status light for the queue.

*Call graph*: called by 1 (is_idle); 1 external calls (is_empty).


##### `StreamState::queued_len`  (lines 82–84)

```
fn queued_len(&self) -> usize
```

**Purpose**: Reports how many finished lines are currently waiting in the queue. This helps other code make pacing decisions, such as whether to drain slowly or catch up.

**Data flow**: It reads the queue length and returns that number. It does not remove or add any lines.

**Call relations**: Queue-inspection and rendering-adjustment code calls this when it needs to understand current backlog pressure. For example, width or render-mode changes can use this count while rebuilding or synchronizing queued output.

*Call graph*: called by 4 (queued_lines, set_render_mode, set_width, sync_stable_queue); 1 external calls (len).


##### `StreamState::oldest_queued_age`  (lines 86–90)

```
fn oldest_queued_age(&self, now: Instant) -> Option<Duration>
```

**Purpose**: Reports how long the oldest queued line has been waiting. This gives timing policy code a way to avoid leaving old output stuck in the queue.

**Data flow**: It receives the current time from the caller. It looks at the front queue entry, compares that entry’s stored enqueue time with the provided time, and returns the elapsed duration. If the queue is empty, it returns no value.

**Call relations**: Higher-level age-checking code calls this when deciding whether queued text should be committed soon. This method supplies the timing fact; policy code elsewhere decides what to do with it.

*Call graph*: called by 1 (oldest_queued_age); 1 external calls (front).


##### `StreamState::enqueue`  (lines 92–99)

```
fn enqueue(&mut self, lines: Vec<HyperlinkLine>)
```

**Purpose**: Adds newly completed display lines to the back of the queue. All lines added together receive the same timestamp, showing when that batch became ready.

**Data flow**: It receives a vector of `HyperlinkLine` values. It records the current time once, wraps each line with that timestamp, appends the wrapped entries to the queue, and returns nothing.

**Call relations**: Render rebuilding and queue synchronization code call this after they have produced committed lines. This method is the single place where those lines enter the FIFO queue, preserving arrival order for later drains.

*Call graph*: called by 2 (rebuild_stable_queue_from_render, sync_stable_queue); 2 external calls (now, extend).


##### `tests::test_cwd`  (lines 109–113)

```
fn test_cwd() -> PathBuf
```

**Purpose**: Provides a stable current-directory path for tests. The tests only need an absolute-looking directory value, not a project-specific folder.

**Data flow**: It reads the operating system’s temporary directory path and returns it as a `PathBuf`. It does not touch the streaming state.

**Call relations**: The queue-draining test calls this while constructing a `StreamState`. Using the temporary directory keeps the test from depending on Unix or Windows root-path details.

*Call graph*: 1 external calls (temp_dir).


##### `tests::drain_n_clamps_to_available_lines`  (lines 116–123)

```
fn drain_n_clamps_to_available_lines()
```

**Purpose**: Checks that asking to drain more lines than exist does not fail or invent extra output. It proves that `drain_n` safely returns only the queued lines that are actually available.

**Data flow**: It creates a new stream state, enqueues one line containing the text “one,” then asks to drain up to eight lines. The result should contain exactly that one line, and the queue should be empty afterward.

**Call relations**: This test exercises `StreamState::new`, `StreamState::enqueue`, `StreamState::drain_n`, and `StreamState::is_idle` together. It protects the batch-drain behavior used by tick-batch code from accidentally over-reading the queue.

*Call graph*: calls 1 internal fn (new); 4 external calls (assert!, assert_eq!, test_cwd, vec!).


### `tui/src/streaming/controller.rs`

`domain_logic` · `request handling during live streaming, resize, animation ticks, and stream finalization`

When an agent is answering, text arrives in small pieces. This file decides which rendered lines are safe to commit to the chat history and which lines must stay editable on screen. The main idea is a two-region stream: a stable region, which is queued and animated into scrollback, and a tail region, which is shown as live content because it may still change. This matters most for markdown tables. A new table row can change column widths and therefore redraw earlier table rows, so the controller holds the table from its header onward until the stream is finished. Without that, users could see table lines jump, duplicate, or become inconsistent with the final transcript.

StreamCore contains the shared machinery: collect incoming text, commit only complete newline-ended source chunks, re-render markdown at the current terminal width, decide the stable/tail split, and rebuild queues after width or render-mode changes. StreamController wraps that for ordinary agent messages and adds the agent-message cell styling. PlanStreamController wraps it for proposed plans, adding the plan title, padding, indentation, and background style. The tests cover resize safety, table holdback, markdown fences, live-tail behavior, and matching streamed output to final full markdown rendering.

#### Function details

##### `StreamCore::new`  (lines 107–120)

```
fn new(width: Option<usize>, cwd: &Path, render_mode: HistoryRenderMode) -> Self
```

**Purpose**: Creates the shared streaming engine for one answer or plan. It records the current render width, working directory, render mode, and empty buffers for incoming text and rendered lines.

**Data flow**: It receives an optional width, a current-directory path, and a render mode. It builds a fresh StreamState, empty source string, empty rendered-line list, counters set to zero, and a new table holdback scanner. The result is a ready-to-use StreamCore.

**Call relations**: The two public controllers call this when they are created, so both agent-message streams and plan streams start with the same bookkeeping rules.

*Call graph*: calls 2 internal fn (new, new); called by 2 (new, new); 3 external calls (to_path_buf, with_capacity, with_capacity).


##### `StreamCore::push_delta`  (lines 129–145)

```
fn push_delta(&mut self, delta: &str) -> bool
```

**Purpose**: Accepts the next piece of streamed text and decides whether any newly complete lines can be queued for display. It deliberately waits for newlines before committing source, so unfinished rows or paragraphs do not flash incorrectly.

**Data flow**: A text delta goes in. The collector stores it, and if the delta completes one or more newline-ended chunks, those chunks are appended to raw_source, scanned for table structure, re-rendered, and compared with the current stable boundary. It returns true when new stable lines were added to the animation queue.

**Call relations**: StreamController::push and PlanStreamController::push hand incoming stream text here. This function then calls the render refresh and stable-queue sync paths that drive later commit ticks.

*Call graph*: calls 3 internal fn (recompute_streaming_render, sync_stable_queue, push_source_chunk); called by 2 (push, push).


##### `StreamCore::finalize_remaining`  (lines 154–166)

```
fn finalize_remaining(&mut self) -> Vec<HyperlinkLine>
```

**Purpose**: Finishes a stream and returns every rendered line that has not already been emitted. It produces the final canonical rendering instead of trying to stitch together old queued lines and live tail lines.

**Data flow**: It drains any leftover uncommitted source from the collector, appends and scans it, renders the full raw source, then slices off the lines already emitted. The output is a list of remaining hyperlink-aware terminal lines.

**Call relations**: Both controllers call this during finalize. The remaining lines are then wrapped into the appropriate history cell by each controller’s emit method.

*Call graph*: calls 2 internal fn (render_source, push_source_chunk); called by 2 (finalize, finalize); 1 external calls (new).


##### `StreamCore::tick`  (lines 169–173)

```
fn tick(&mut self) -> Vec<HyperlinkLine>
```

**Purpose**: Advances the commit animation by one step. In practice, it releases the next queued stable line or small step of lines into scrollback.

**Data flow**: It reads the queue inside StreamState, removes one animation step, increases the emitted-line counter by the number of lines released, and returns those released lines.

**Call relations**: The controller tick methods call this when the UI animation loop wants to move stable content from the queue into history.

*Call graph*: calls 1 internal fn (step); called by 2 (on_commit_tick, on_commit_tick).


##### `StreamCore::tick_batch`  (lines 176–186)

```
fn tick_batch(&mut self, max_lines: usize) -> Vec<HyperlinkLine>
```

**Purpose**: Releases up to a requested number of queued stable lines at once. This is useful when the UI wants to drain faster than one animation step.

**Data flow**: It receives a maximum line count. If that count is zero, nothing changes. Otherwise it drains up to that many lines, updates the emitted count, and returns the drained lines.

**Call relations**: Both controller batch tick methods call this, then wrap any returned lines into display cells.

*Call graph*: calls 1 internal fn (drain_n); called by 2 (on_commit_tick_batch, on_commit_tick_batch); 1 external calls (new).


##### `StreamCore::is_idle`  (lines 192–194)

```
fn is_idle(&self) -> bool
```

**Purpose**: Reports whether the stable-line animation queue is empty. Callers use this to know whether there is more committed content waiting to be displayed.

**Data flow**: It reads StreamState’s queue status and returns a boolean. It does not change the stream.

**Call relations**: Controller tick methods call this after draining lines, so the outer streaming code can decide whether to keep ticking.

*Call graph*: calls 1 internal fn (is_idle); called by 4 (on_commit_tick, on_commit_tick_batch, on_commit_tick, on_commit_tick_batch).


##### `StreamCore::queued_lines`  (lines 197–199)

```
fn queued_lines(&self) -> usize
```

**Purpose**: Returns how many stable lines are waiting in the animation queue. This is a simple visibility check for scheduling and tests.

**Data flow**: It reads the queue length from StreamState and returns that number. Nothing is modified.

**Call relations**: The public controllers expose this through their own queued_lines methods.

*Call graph*: calls 1 internal fn (queued_len); called by 2 (queued_lines, queued_lines).


##### `StreamCore::oldest_queued_age`  (lines 202–204)

```
fn oldest_queued_age(&self, now: Instant) -> Option<Duration>
```

**Purpose**: Tells how long the oldest queued stable line has been waiting. This can help the UI decide whether output is lagging.

**Data flow**: It receives the current time, asks StreamState about the oldest queued item, and returns an optional duration. If the queue is empty, there is no age.

**Call relations**: Both controller types expose this to higher-level streaming code.

*Call graph*: calls 1 internal fn (oldest_queued_age); called by 2 (oldest_queued_age, oldest_queued_age).


##### `StreamCore::current_tail_lines`  (lines 214–217)

```
fn current_tail_lines(&self) -> Vec<HyperlinkLine>
```

**Purpose**: Returns the mutable live tail: rendered lines that are not yet safe to commit. This prevents queued-but-not-yet-emitted lines from appearing twice.

**Data flow**: It reads rendered_lines and starts at enqueued_stable_len, not emitted_stable_len. It copies and returns everything from that boundary to the end.

**Call relations**: Both controllers use this to show the active-cell tail while stable lines continue draining into scrollback.

*Call graph*: called by 2 (current_tail_lines, current_tail_lines).


##### `StreamCore::has_tail`  (lines 220–222)

```
fn has_tail(&self) -> bool
```

**Purpose**: Reports whether there is currently any mutable live tail. A live tail means part of the rendered output is still being held back from the stable queue.

**Data flow**: It compares the stable enqueue boundary with the total rendered-line count and returns true if rendered content remains beyond that boundary.

**Call relations**: Controllers expose this as has_live_tail, and width/render-mode changes use it to preserve tail content correctly.

*Call graph*: called by 4 (has_live_tail, has_live_tail, set_render_mode, set_width).


##### `StreamCore::set_width`  (lines 233–265)

```
fn set_width(&mut self, width: Option<usize>)
```

**Purpose**: Updates the markdown render width after a terminal resize and rebuilds pending stable output for the new layout. This avoids replaying old lines or losing pending ones when wrapping changes.

**Data flow**: It receives a new optional width. If the width changed, it updates collector/render width, re-renders source, adjusts emitted counts to fit the new line count, clears stale queued lines, and rebuilds the queue when needed. It changes internal render and queue state but returns nothing.

**Call relations**: Both controllers call this from their set_width methods when the terminal changes size. It uses the same stable-boundary logic as normal streaming.

*Call graph*: calls 5 internal fn (clear_queue, queued_len, has_tail, rebuild_stable_queue_from_render, recompute_streaming_render); called by 2 (set_width, set_width).


##### `StreamCore::reset`  (lines 268–276)

```
fn reset(&mut self)
```

**Purpose**: Clears all state for the finished stream. This prevents text from one answer or plan leaking into the next one.

**Data flow**: It clears StreamState, raw source, rendered lines, counters, cache, and the table scanner. Afterward the core is empty but still reusable.

**Call relations**: Both finalize methods call this after they have taken the final source and output lines.

*Call graph*: calls 2 internal fn (clear, reset); called by 2 (finalize, finalize).


##### `StreamCore::render_source`  (lines 278–287)

```
fn render_source(&self, source: &str) -> Vec<HyperlinkLine>
```

**Purpose**: Turns markdown source into terminal lines, either richly formatted or raw. It is the single place where the stream chooses how source text becomes visible output.

**Data flow**: It receives source text. In rich mode it renders markdown with links and current-directory-aware file display; in raw mode it turns source lines into plain hyperlink-line wrappers. It returns rendered HyperlinkLine values.

**Call relations**: Final rendering and every streaming re-render go through this helper.

*Call graph*: calls 3 internal fn (raw_lines_from_source, render_markdown_agent_with_links_and_cwd, plain_hyperlink_lines); called by 2 (finalize_remaining, recompute_streaming_render); 1 external calls (as_path).


##### `StreamCore::recompute_streaming_render`  (lines 289–291)

```
fn recompute_streaming_render(&mut self)
```

**Purpose**: Refreshes the full rendered snapshot from the accumulated raw source. It keeps the visual model in sync after new complete source arrives or display settings change.

**Data flow**: It reads raw_source and current render settings, renders the source, and replaces rendered_lines with the new snapshot.

**Call relations**: push_delta, set_width, and set_render_mode call this before recalculating what can be stable.

*Call graph*: calls 1 internal fn (render_source); called by 3 (push_delta, set_render_mode, set_width).


##### `StreamCore::set_render_mode`  (lines 293–319)

```
fn set_render_mode(&mut self, render_mode: HistoryRenderMode)
```

**Purpose**: Switches between rich markdown rendering and raw text rendering while a stream may be active. It rebuilds pending output so the queue matches the new display style.

**Data flow**: It receives a render mode. If different, it records queue/tail state, changes mode, re-renders source, adjusts emitted counts, clears stale queue entries, and rebuilds stable lines when needed.

**Call relations**: Both controllers expose this for app-level display-mode changes. It follows almost the same repair path as set_width.

*Call graph*: calls 5 internal fn (clear_queue, queued_len, has_tail, rebuild_stable_queue_from_render, recompute_streaming_render); called by 2 (set_render_mode, set_render_mode).


##### `StreamCore::compute_target_stable_len`  (lines 322–328)

```
fn compute_target_stable_len(&mut self) -> usize
```

**Purpose**: Calculates how many rendered lines are safe to move into the stable region. It is the main boundary decision between scrollback and live tail.

**Data flow**: It asks how many lines must be held as tail, subtracts that from the rendered-line count, and never lets the stable target move before already emitted lines. It returns the target stable length.

**Call relations**: Queue syncing and queue rebuilding both call this before deciding which lines to enqueue.

*Call graph*: calls 1 internal fn (active_tail_budget_lines); called by 2 (rebuild_stable_queue_from_render, sync_stable_queue).


##### `StreamCore::sync_stable_queue`  (lines 332–356)

```
fn sync_stable_queue(&mut self) -> bool
```

**Purpose**: Moves newly safe rendered lines into the animation queue. It also repairs the queue if a structural markdown change moves the safe boundary backward.

**Data flow**: It computes the target stable length, compares it with the current enqueued length, clears and rebuilds if needed, or appends only the newly stable slice. It returns true if the queue ended up with new work.

**Call relations**: push_delta calls this after re-rendering committed source, so incoming stream text can become animated scrollback.

*Call graph*: calls 4 internal fn (clear_queue, enqueue, queued_len, compute_target_stable_len); called by 1 (push_delta).


##### `StreamCore::rebuild_stable_queue_from_render`  (lines 363–371)

```
fn rebuild_stable_queue_from_render(&mut self)
```

**Purpose**: Recreates the stable queue from the current rendered snapshot. This is used when old queued lines can no longer be trusted, such as after resize or render-mode change.

**Data flow**: It computes the target stable boundary, clears the queue, enqueues the slice between already emitted lines and the target, and updates enqueued_stable_len.

**Call relations**: set_width and set_render_mode call this after they re-render the stream.

*Call graph*: calls 3 internal fn (clear_queue, enqueue, compute_target_stable_len); called by 2 (set_render_mode, set_width).


##### `StreamCore::active_tail_budget_lines`  (lines 381–401)

```
fn active_tail_budget_lines(&mut self) -> usize
```

**Purpose**: Decides how many rendered lines must stay mutable because of table holdback. In raw mode it disables this behavior because raw text does not reflow markdown tables.

**Data flow**: It reads the table scanner state. If a table is confirmed or a possible header is pending, it converts the source offset of that table/header into a rendered-line tail size; otherwise it returns zero.

**Call relations**: compute_target_stable_len calls this whenever the stable boundary is recalculated.

*Call graph*: calls 2 internal fn (tail_budget_from_source_start, state); called by 1 (compute_target_stable_len); 2 external calls (now, trace!).


##### `StreamCore::tail_budget_from_source_start`  (lines 408–415)

```
fn tail_budget_from_source_start(&mut self, source_start: usize) -> usize
```

**Purpose**: Converts a table start position in raw source bytes into a count of rendered lines to hold back. This bridges source-text coordinates and terminal-line coordinates.

**Data flow**: It receives a source byte offset. If the table starts at the beginning, all rendered lines are tail; otherwise it renders or retrieves the prefix length before that offset and subtracts it from the full rendered length.

**Call relations**: active_tail_budget_lines calls this after the table scanner identifies where the mutable table region begins.

*Call graph*: calls 1 internal fn (stable_prefix_len_for_source_start); called by 1 (active_tail_budget_lines).


##### `StreamCore::stable_prefix_len_for_source_start`  (lines 422–456)

```
fn stable_prefix_len_for_source_start(&mut self, source_start: usize) -> usize
```

**Purpose**: Finds how many rendered lines exist before a table starts. It caches the answer because table streams can ask the same question repeatedly.

**Data flow**: It receives a source byte offset, checks whether a cached answer matches that offset and width, and otherwise renders only the source prefix to count its lines. It stores and returns the count.

**Call relations**: tail_budget_from_source_start uses this to compute how much of the current render can remain stable before a table.

*Call graph*: calls 1 internal fn (render_markdown_agent_with_links_and_cwd); called by 1 (tail_budget_from_source_start); 3 external calls (now, as_path, trace!).


##### `StreamController::new`  (lines 473–478)

```
fn new(width: Option<usize>, cwd: &Path, render_mode: HistoryRenderMode) -> Self
```

**Purpose**: Creates a controller for streaming a normal agent message. It adds agent-message behavior on top of the shared StreamCore.

**Data flow**: It receives width, current directory, and render mode, builds a StreamCore, and starts with no header emitted. It returns a StreamController.

**Call relations**: Higher-level answer streaming code creates this when an agent response starts.

*Call graph*: calls 1 internal fn (new); called by 4 (handle_streaming_delta, flush_answer_stream_keeps_default_reflow_for_plain_text_tail, flush_answer_stream_requests_scrollback_reflow_for_live_table_tail, stream_controller).


##### `StreamController::push`  (lines 480–482)

```
fn push(&mut self, delta: &str) -> bool
```

**Purpose**: Adds a new text delta to an agent-message stream. It returns whether new stable lines became available.

**Data flow**: It passes the delta into StreamCore::push_delta and returns that result unchanged.

**Call relations**: This is the agent-message wrapper around the shared push path.

*Call graph*: calls 1 internal fn (push_delta).


##### `StreamController::finalize`  (lines 486–498)

```
fn finalize(&mut self) -> (Option<Box<dyn HistoryCell>>, Option<String>)
```

**Purpose**: Finishes an agent-message stream and returns both the final display cell and the raw markdown source. The source is used later to consolidate the transcript.

**Data flow**: It asks the core for remaining rendered lines. If there is no source, it resets and returns nothing; otherwise it takes the raw source, emits the remaining lines as an agent cell, resets the core, and returns the cell plus source.

**Call relations**: Called when an agent answer ends. It hands final lines to emit and then clears state for the next stream.

*Call graph*: calls 3 internal fn (emit, finalize_remaining, reset); 1 external calls (take).


##### `StreamController::on_commit_tick`  (lines 500–503)

```
fn on_commit_tick(&mut self) -> (Option<Box<dyn HistoryCell>>, bool)
```

**Purpose**: Releases the next queued stable part of an agent message. It also reports whether the stable queue is now idle.

**Data flow**: It ticks the core, wraps any returned lines into an agent message cell, checks idle status, and returns both values.

**Call relations**: The stream-draining code calls this during animation ticks.

*Call graph*: calls 3 internal fn (emit, is_idle, tick); called by 1 (drain_stream_controller).


##### `StreamController::on_commit_tick_batch`  (lines 505–511)

```
fn on_commit_tick_batch(
        &mut self,
        max_lines: usize,
    ) -> (Option<Box<dyn HistoryCell>>, bool)
```

**Purpose**: Releases several queued stable agent-message lines at once. This is the faster-drain version of on_commit_tick.

**Data flow**: It receives a maximum line count, asks the core to drain up to that many lines, emits them as an agent cell if present, and returns the cell plus idle status.

**Call relations**: The stream-draining code calls this when batching is allowed.

*Call graph*: calls 3 internal fn (emit, is_idle, tick_batch); called by 1 (drain_stream_controller).


##### `StreamController::queued_lines`  (lines 517–519)

```
fn queued_lines(&self) -> usize
```

**Purpose**: Reports how many agent-message lines are queued for stable commit.

**Data flow**: It reads the count through StreamCore and returns it.

**Call relations**: Higher-level scheduling and tests use this to inspect backlog.

*Call graph*: calls 1 internal fn (queued_lines).


##### `StreamController::oldest_queued_age`  (lines 521–523)

```
fn oldest_queued_age(&self, now: Instant) -> Option<Duration>
```

**Purpose**: Reports how long the oldest queued agent-message line has been waiting.

**Data flow**: It receives the current time, forwards it to StreamCore, and returns the optional duration.

**Call relations**: This lets outer code detect or react to slow-draining output.

*Call graph*: calls 1 internal fn (oldest_queued_age).


##### `StreamController::current_tail_lines`  (lines 526–528)

```
fn current_tail_lines(&self) -> Vec<HyperlinkLine>
```

**Purpose**: Returns the current live tail for a normal agent message.

**Data flow**: It asks StreamCore for rendered lines beyond the stable enqueue boundary and returns them.

**Call relations**: The UI uses this when drawing the active streaming cell.

*Call graph*: calls 1 internal fn (current_tail_lines).


##### `StreamController::tail_starts_stream`  (lines 531–533)

```
fn tail_starts_stream(&self) -> bool
```

**Purpose**: Tells whether the live tail begins at the very start of the agent message. This helps decide whether the message header should appear with the tail.

**Data flow**: It checks whether no header has been emitted and no stable lines have been enqueued. It returns a boolean.

**Call relations**: Display code can use this when presenting a tail before any committed cell exists.


##### `StreamController::has_live_tail`  (lines 536–538)

```
fn has_live_tail(&self) -> bool
```

**Purpose**: Reports whether an agent message currently has mutable tail content.

**Data flow**: It delegates to StreamCore::has_tail and returns the result.

**Call relations**: Outer streaming logic uses this to know whether active-cell content must still be drawn or reflowed.

*Call graph*: calls 1 internal fn (has_tail).


##### `StreamController::clear_queue`  (lines 540–543)

```
fn clear_queue(&mut self)
```

**Purpose**: Drops pending stable agent-message lines from the animation queue and aligns the enqueue boundary with already emitted content.

**Data flow**: It clears StreamState’s queue and sets enqueued_stable_len to emitted_stable_len. Existing raw source and rendered tail remain.

**Call relations**: Higher-level code can call this when it intentionally abandons queued animation work.


##### `StreamController::set_width`  (lines 545–547)

```
fn set_width(&mut self, width: Option<usize>)
```

**Purpose**: Updates the render width for an active agent-message stream.

**Data flow**: It receives a new width and forwards it to StreamCore::set_width, which re-renders and repairs the queue.

**Call relations**: Called by UI resize handling for ordinary answer streams.

*Call graph*: calls 1 internal fn (set_width).


##### `StreamController::set_render_mode`  (lines 549–551)

```
fn set_render_mode(&mut self, render_mode: HistoryRenderMode)
```

**Purpose**: Changes how an active agent-message stream is rendered, such as rich markdown versus raw text.

**Data flow**: It receives the new mode and forwards it to StreamCore::set_render_mode.

**Call relations**: Called when app display settings change while an answer is streaming.

*Call graph*: calls 1 internal fn (set_render_mode).


##### `StreamController::emit`  (lines 553–564)

```
fn emit(&mut self, lines: Vec<HyperlinkLine>) -> Option<Box<dyn HistoryCell>>
```

**Purpose**: Wraps rendered agent-message lines into a history cell, adding the message header only once.

**Data flow**: It receives hyperlink-aware lines. If empty, it returns nothing; otherwise it creates an AgentMessageCell and flips header_emitted so later chunks are continuations.

**Call relations**: Finalize and both commit-tick methods call this after the core provides lines to display.

*Call graph*: calls 1 internal fn (new_hyperlink_lines); called by 3 (finalize, on_commit_tick, on_commit_tick_batch); 1 external calls (new).


##### `PlanStreamController::new`  (lines 586–592)

```
fn new(width: Option<usize>, cwd: &Path, render_mode: HistoryRenderMode) -> Self
```

**Purpose**: Creates a controller for streaming a proposed plan block. It uses the shared streaming core but tracks plan-specific header and padding state.

**Data flow**: It receives width, current directory, and render mode, builds a StreamCore, and initializes header and padding flags to false. It returns a PlanStreamController.

**Call relations**: Plan delta handling creates this when a proposed plan begins streaming.

*Call graph*: calls 1 internal fn (new); called by 5 (on_plan_delta, completed_token_activity_refresh_retries_after_plan_item_completion, completed_plan_table_tail_skips_provisional_history_insert, finalized_plan_stream_preserves_semantic_url_fragments, plan_stream_controller).


##### `PlanStreamController::push`  (lines 594–596)

```
fn push(&mut self, delta: &str) -> bool
```

**Purpose**: Adds a new text delta to a proposed-plan stream. It returns whether new stable plan lines were queued.

**Data flow**: It forwards the delta to StreamCore::push_delta and returns the boolean result.

**Call relations**: This is the plan-stream wrapper around the shared push logic.

*Call graph*: calls 1 internal fn (push_delta).


##### `PlanStreamController::finalize`  (lines 600–612)

```
fn finalize(&mut self) -> (Option<Box<dyn HistoryCell>>, Option<String>)
```

**Purpose**: Finishes a proposed-plan stream and returns the final styled cell plus raw markdown source. It includes bottom padding in the final plan block.

**Data flow**: It asks the core for remaining lines, exits with nothing if there is no source, otherwise takes the raw source, emits remaining lines with bottom padding, resets the core, and returns the cell plus source.

**Call relations**: Called when plan streaming ends, before transcript consolidation.

*Call graph*: calls 3 internal fn (emit, finalize_remaining, reset); 1 external calls (take).


##### `PlanStreamController::on_commit_tick`  (lines 614–620)

```
fn on_commit_tick(&mut self) -> (Option<Box<dyn HistoryCell>>, bool)
```

**Purpose**: Releases the next queued stable part of a proposed plan. It keeps final-only padding out of intermediate chunks.

**Data flow**: It ticks the core, emits returned lines as a plan cell without bottom padding, checks whether the core is idle, and returns both values.

**Call relations**: Plan stream draining calls this during animation ticks.

*Call graph*: calls 3 internal fn (emit, is_idle, tick); called by 1 (drain_plan_stream_controller).


##### `PlanStreamController::on_commit_tick_batch`  (lines 622–631)

```
fn on_commit_tick_batch(
        &mut self,
        max_lines: usize,
    ) -> (Option<Box<dyn HistoryCell>>, bool)
```

**Purpose**: Releases several queued stable proposed-plan lines at once. It is the batched version of the plan commit tick.

**Data flow**: It receives a maximum line count, drains up to that many lines from the core, emits them without bottom padding, and returns the optional cell plus idle status.

**Call relations**: Plan stream draining calls this when it wants to catch up more quickly.

*Call graph*: calls 3 internal fn (emit, is_idle, tick_batch); called by 1 (drain_plan_stream_controller).


##### `PlanStreamController::queued_lines`  (lines 634–636)

```
fn queued_lines(&self) -> usize
```

**Purpose**: Reports how many proposed-plan lines are waiting to be committed.

**Data flow**: It asks StreamCore for its queue length and returns that number.

**Call relations**: Used by higher-level plan streaming code and tests to inspect pending output.

*Call graph*: calls 1 internal fn (queued_lines).


##### `PlanStreamController::has_live_tail`  (lines 639–641)

```
fn has_live_tail(&self) -> bool
```

**Purpose**: Reports whether the proposed plan has mutable live-tail content.

**Data flow**: It delegates to StreamCore::has_tail and returns the result.

**Call relations**: The UI uses this to know whether to draw provisional plan content.

*Call graph*: calls 1 internal fn (has_tail).


##### `PlanStreamController::current_tail_lines`  (lines 644–646)

```
fn current_tail_lines(&self) -> Vec<HyperlinkLine>
```

**Purpose**: Returns the raw rendered live-tail lines for a proposed plan, before plan-specific decoration.

**Data flow**: It asks StreamCore for the tail slice beyond the stable boundary and returns it.

**Call relations**: current_tail_display_lines builds on this to produce styled plan-tail display lines.

*Call graph*: calls 1 internal fn (current_tail_lines); called by 1 (current_tail_display_lines).


##### `PlanStreamController::tail_starts_stream`  (lines 649–651)

```
fn tail_starts_stream(&self) -> bool
```

**Purpose**: Tells whether the proposed plan’s live tail begins before any plan header has been emitted.

**Data flow**: It checks the header flag and the core’s stable enqueue boundary. It returns true only when the stream is still at its first visible content.

**Call relations**: Display code can use this to decide whether the live plan tail should include the plan header.


##### `PlanStreamController::current_tail_display_lines`  (lines 653–659)

```
fn current_tail_display_lines(&self) -> Vec<HyperlinkLine>
```

**Purpose**: Returns the current proposed-plan live tail with plan styling applied. This is what the active plan tail should look like on screen.

**Data flow**: It gets raw tail lines. If there are none, it returns an empty list; otherwise it runs them through render_display_lines without final bottom padding.

**Call relations**: It connects the shared core tail with the plan-specific formatting helper.

*Call graph*: calls 2 internal fn (current_tail_lines, render_display_lines); 1 external calls (new).


##### `PlanStreamController::oldest_queued_age`  (lines 661–663)

```
fn oldest_queued_age(&self, now: Instant) -> Option<Duration>
```

**Purpose**: Reports how long the oldest queued proposed-plan line has been waiting.

**Data flow**: It forwards the current time to StreamCore and returns the optional age.

**Call relations**: Outer plan streaming code can use this for pacing or catch-up decisions.

*Call graph*: calls 1 internal fn (oldest_queued_age).


##### `PlanStreamController::clear_queue`  (lines 665–668)

```
fn clear_queue(&mut self)
```

**Purpose**: Clears pending stable plan lines and resets the stable boundary to already emitted content.

**Data flow**: It clears the core queue and sets enqueued_stable_len equal to emitted_stable_len. It leaves source and current render data intact.

**Call relations**: Higher-level code can call this when it wants to discard queued plan animation work.


##### `PlanStreamController::set_width`  (lines 670–672)

```
fn set_width(&mut self, width: Option<usize>)
```

**Purpose**: Updates the render width for an active proposed-plan stream.

**Data flow**: It receives the new width and delegates to StreamCore::set_width, which re-renders and rebuilds pending output.

**Call relations**: Called during terminal resize handling for plan streams.

*Call graph*: calls 1 internal fn (set_width).


##### `PlanStreamController::set_render_mode`  (lines 674–676)

```
fn set_render_mode(&mut self, render_mode: HistoryRenderMode)
```

**Purpose**: Changes the render mode for an active proposed-plan stream.

**Data flow**: It receives the new mode and delegates to StreamCore::set_render_mode.

**Call relations**: Called when display mode changes while plan content is streaming.

*Call graph*: calls 1 internal fn (set_render_mode).


##### `PlanStreamController::emit`  (lines 678–696)

```
fn emit(
        &mut self,
        lines: Vec<HyperlinkLine>,
        include_bottom_padding: bool,
    ) -> Option<Box<dyn HistoryCell>>
```

**Purpose**: Wraps proposed-plan lines into a styled plan history cell. It controls whether the chunk is the first plan block or a continuation.

**Data flow**: It receives lines and a bottom-padding flag. If there is no content and no padding needed, it returns nothing; otherwise it formats display lines, marks header and top padding as emitted, and returns a proposed-plan stream cell.

**Call relations**: Plan finalize and plan commit ticks call this after the core produces lines.

*Call graph*: calls 1 internal fn (render_display_lines); called by 3 (finalize, on_commit_tick, on_commit_tick_batch); 2 external calls (new, new_proposed_plan_stream).


##### `PlanStreamController::render_display_lines`  (lines 698–727)

```
fn render_display_lines(
        &self,
        lines: Vec<HyperlinkLine>,
        include_bottom_padding: bool,
    ) -> Vec<HyperlinkLine>
```

**Purpose**: Applies the proposed-plan visual shape: title, spacing, indentation, and background style. It turns plain rendered markdown lines into plan-block display lines.

**Data flow**: It receives plan content lines and a bottom-padding flag. It may add the “Proposed Plan” header, top padding, bottom padding, prefixes each plan line with spaces, applies the plan style, and returns the decorated lines.

**Call relations**: Plan emit uses this for committed cells, and current_tail_display_lines uses it for live tails.

*Call graph*: calls 3 internal fn (proposed_plan_style, new, prefix_hyperlink_lines); called by 2 (current_tail_display_lines, emit); 3 external calls (from, with_capacity, vec!).


##### `tests::test_cwd`  (lines 737–741)

```
fn test_cwd() -> PathBuf
```

**Purpose**: Provides a stable current-directory path for tests without depending on a particular operating-system root.

**Data flow**: It reads the system temporary directory and returns it as a PathBuf.

**Call relations**: The test controller factory helpers call this when constructing stream controllers.

*Call graph*: 1 external calls (temp_dir).


##### `tests::stream_controller`  (lines 743–745)

```
fn stream_controller(width: Option<usize>) -> StreamController
```

**Purpose**: Creates a rich-rendering agent StreamController for tests.

**Data flow**: It receives an optional width, gets the test current directory, and returns a StreamController in rich render mode.

**Call relations**: Most agent-stream tests use this helper to avoid repeated setup.

*Call graph*: calls 1 internal fn (new); 1 external calls (test_cwd).


##### `tests::plan_stream_controller`  (lines 747–749)

```
fn plan_stream_controller(width: Option<usize>) -> PlanStreamController
```

**Purpose**: Creates a rich-rendering PlanStreamController for tests.

**Data flow**: It receives an optional width, gets the test current directory, and returns a plan controller in rich render mode.

**Call relations**: Plan-stream tests use this helper for consistent setup.

*Call graph*: calls 1 internal fn (new); 1 external calls (test_cwd).


##### `tests::lines_to_plain_strings`  (lines 751–762)

```
fn lines_to_plain_strings(lines: &[ratatui::text::Line<'_>]) -> Vec<String>
```

**Purpose**: Converts styled terminal lines into plain strings for easy assertions.

**Data flow**: It receives ratatui Line values, joins the text content of their spans, and returns one plain string per line.

**Call relations**: Many tests use this to compare visible output without caring about style objects.

*Call graph*: 1 external calls (iter).


##### `tests::hyperlink_lines_to_plain_strings`  (lines 764–766)

```
fn hyperlink_lines_to_plain_strings(lines: &[HyperlinkLine]) -> Vec<String>
```

**Purpose**: Converts hyperlink-aware lines into plain strings for assertions.

**Data flow**: It receives HyperlinkLine values, extracts their visible terminal lines, and passes them through lines_to_plain_strings.

**Call relations**: Tail-related tests use this when checking live hyperlink-line output.

*Call graph*: calls 1 internal fn (visible_lines); 2 external calls (lines_to_plain_strings, to_vec).


##### `tests::collect_streamed_lines`  (lines 768–787)

```
fn collect_streamed_lines(deltas: &[&str], width: Option<usize>) -> Vec<String>
```

**Purpose**: Runs a full agent-message streaming scenario and collects the final plain transcript lines.

**Data flow**: It receives deltas and a width, pushes each delta through a StreamController, drains commit ticks after each push, finalizes, strips the agent bullet prefix, and returns plain strings.

**Call relations**: Many table and markdown tests use this helper to compare streamed output with full rendering.

*Call graph*: 3 external calls (new, lines_to_plain_strings, stream_controller).


##### `tests::collect_plan_streamed_lines`  (lines 789–805)

```
fn collect_plan_streamed_lines(deltas: &[&str], width: Option<usize>) -> Vec<String>
```

**Purpose**: Runs a full proposed-plan streaming scenario and collects plain transcript lines.

**Data flow**: It receives deltas and a width, pushes them through a PlanStreamController, drains ticks, finalizes, and returns plain strings.

**Call relations**: Plan-specific tests use this to compare streamed and baseline plan output.

*Call graph*: 3 external calls (new, lines_to_plain_strings, plan_stream_controller).


##### `tests::controller_set_width_rebuilds_queued_lines`  (lines 808–827)

```
fn controller_set_width_rebuilds_queued_lines()
```

**Purpose**: Checks that resizing rebuilds queued agent lines using the new width.

**Data flow**: It streams a long line at a wide width, resizes narrower, drains the queue, and asserts that the rendered output now wraps across multiple lines.

**Call relations**: This protects StreamCore::set_width and queue rebuilding behavior.

*Call graph*: 4 external calls (assert!, assert_eq!, lines_to_plain_strings, stream_controller).


##### `tests::controller_set_width_no_duplicate_after_emit`  (lines 830–846)

```
fn controller_set_width_no_duplicate_after_emit()
```

**Purpose**: Ensures already emitted content is not re-queued after a resize.

**Data flow**: It streams and fully emits a line, resizes, then checks that the queue remains empty.

**Call relations**: This guards the resize path that skips replay when there is no pending queue or live tail.

*Call graph*: 3 external calls (assert!, assert_eq!, stream_controller).


##### `tests::controller_tick_batch_zero_is_noop`  (lines 849–862)

```
fn controller_tick_batch_zero_is_noop()
```

**Purpose**: Verifies that asking to drain zero lines changes nothing.

**Data flow**: It queues one line, calls the batch tick with max_lines zero, and asserts no cell is emitted, the stream is not idle, and the queue length stays one.

**Call relations**: This protects StreamCore::tick_batch’s zero-count early return.

*Call graph*: 3 external calls (assert!, assert_eq!, stream_controller).


##### `tests::controller_has_live_tail_reflects_tail_presence`  (lines 865–875)

```
fn controller_has_live_tail_reflects_tail_presence()
```

**Purpose**: Checks that the agent controller reports live-tail presence based on the stable boundary.

**Data flow**: It manually inserts a rendered tail line, toggles the enqueue boundary, and asserts has_live_tail changes accordingly.

**Call relations**: This directly exercises StreamController::has_live_tail through StreamCore::has_tail.

*Call graph*: 3 external calls (assert!, stream_controller, vec!).


##### `tests::plan_controller_has_live_tail_reflects_tail_presence`  (lines 878–888)

```
fn plan_controller_has_live_tail_reflects_tail_presence()
```

**Purpose**: Checks that the plan controller reports live-tail presence correctly.

**Data flow**: It manually inserts a rendered line and moves the enqueue boundary before and after it, asserting the live-tail flag follows.

**Call relations**: This mirrors the agent live-tail test for PlanStreamController.

*Call graph*: 3 external calls (assert!, plan_stream_controller, vec!).


##### `tests::controller_live_tail_keeps_uncommitted_table_cell_newline_gated`  (lines 891–902)

```
fn controller_live_tail_keeps_uncommitted_table_cell_newline_gated()
```

**Purpose**: Ensures an unfinished table row does not appear in the live tail before its newline arrives.

**Data flow**: It streams a table header, delimiter, and a partial row without newline, then checks the visible tail does not contain the partial text.

**Call relations**: This protects push_delta’s complete-line commit rule for table safety.

*Call graph*: 3 external calls (assert!, hyperlink_lines_to_plain_strings, stream_controller).


##### `tests::controller_live_tail_requires_table_holdback_state`  (lines 905–914)

```
fn controller_live_tail_requires_table_holdback_state()
```

**Purpose**: Ensures ordinary partial text is not shown as a live tail unless holdback rules require it.

**Data flow**: It streams plain text without a newline and asserts current tail lines are empty and no live tail exists.

**Call relations**: This guards against showing uncommitted non-table fragments.

*Call graph*: 2 external calls (assert!, stream_controller).


##### `tests::controller_live_tail_rerenders_table_tail_after_resize`  (lines 917–942)

```
fn controller_live_tail_rerenders_table_tail_after_resize()
```

**Purpose**: Checks that a live table tail is re-rendered each time the width changes.

**Data flow**: It streams a table, resizes to several widths, compares the current tail with a fresh markdown render at each width, and expects equality.

**Call relations**: This tests the interaction of table holdback, current_tail_lines, and set_width.

*Call graph*: calls 1 internal fn (append_markdown_agent); 5 external calls (new, assert_eq!, hyperlink_lines_to_plain_strings, lines_to_plain_strings, stream_controller).


##### `tests::controller_set_width_partial_drain_no_lost_lines`  (lines 945–968)

```
fn controller_set_width_partial_drain_no_lost_lines()
```

**Purpose**: Ensures resizing after only part of the queue has drained does not lose later lines.

**Data flow**: It streams two lines, emits one tick, resizes, finalizes, and checks that the second line is still present.

**Call relations**: This protects the resize repair logic for partially drained queues.

*Call graph*: 2 external calls (assert!, stream_controller).


##### `tests::controller_set_width_partial_drain_keeps_pending_queue`  (lines 971–1003)

```
fn controller_set_width_partial_drain_keeps_pending_queue()
```

**Purpose**: Checks that pending queued lines remain available after a resize during partial drain.

**Data flow**: It streams wrapped content, emits one tick, resizes, confirms the queue still has work, drains it, and verifies the later line appears.

**Call relations**: This exercises set_width followed by normal commit ticks.

*Call graph*: 4 external calls (new, assert!, lines_to_plain_strings, stream_controller).


##### `tests::controller_set_width_preserves_in_flight_tail`  (lines 1006–1019)

```
fn controller_set_width_preserves_in_flight_tail()
```

**Purpose**: Ensures a partial agent-message tail survives a resize before finalization.

**Data flow**: It streams text without a newline, resizes, finalizes, and checks the final cell contains that text.

**Call relations**: This protects resize handling when the collector has in-flight source.

*Call graph*: 3 external calls (assert_eq!, lines_to_plain_strings, stream_controller).


##### `tests::controller_set_width_preserves_table_tail_when_queue_is_empty`  (lines 1022–1050)

```
fn controller_set_width_preserves_table_tail_when_queue_is_empty()
```

**Purpose**: Checks that a held table header remains as live tail across resize even when no stable queue exists.

**Data flow**: It emits an intro line, starts a table header, resizes, and verifies the table header still appears in the tail.

**Call relations**: This protects set_width’s special handling for live tails without pending queue lines.

*Call graph*: 4 external calls (assert!, assert_eq!, hyperlink_lines_to_plain_strings, stream_controller).


##### `tests::plan_controller_set_width_preserves_in_flight_tail`  (lines 1053–1072)

```
fn plan_controller_set_width_preserves_in_flight_tail()
```

**Purpose**: Ensures a partial proposed-plan tail survives resize and finalization.

**Data flow**: It streams an unfinished plan item, resizes, finalizes, and checks the item is present in the output.

**Call relations**: This mirrors the agent in-flight-tail resize test for plan streams.

*Call graph*: 3 external calls (assert!, lines_to_plain_strings, plan_stream_controller).


##### `tests::plan_controller_holds_table_header_as_live_tail`  (lines 1075–1086)

```
fn plan_controller_holds_table_header_as_live_tail()
```

**Purpose**: Verifies that proposed plans use table holdback too.

**Data flow**: It streams and drains intro text, then streams a table header and asserts it is held as live tail rather than queued.

**Call relations**: This confirms PlanStreamController shares StreamCore’s table holdback behavior.

*Call graph*: 2 external calls (assert!, plan_stream_controller).


##### `tests::controller_loose_vs_tight_with_commit_ticks_matches_full`  (lines 1089–1205)

```
fn controller_loose_vs_tight_with_commit_ticks_matches_full()
```

**Purpose**: Checks that streamed list rendering matches a full markdown render for tricky loose and tight list spacing.

**Data flow**: It pushes many small deltas, drains ticks throughout, finalizes, and compares the collected output with a full render and an explicit expected list.

**Call relations**: This protects incremental rendering from drifting away from final markdown semantics.

*Call graph*: calls 1 internal fn (append_markdown_agent); 5 external calls (new, assert_eq!, lines_to_plain_strings, stream_controller, vec!).


##### `tests::controller_streamed_table_matches_full_render_widths`  (lines 1208–1224)

```
fn controller_streamed_table_matches_full_render_widths()
```

**Purpose**: Ensures a simple streamed markdown table matches full rendering at a fixed width.

**Data flow**: It streams table deltas, collects output, renders the full source separately, and compares the plain lines.

**Call relations**: This verifies table holdback produces the same result as non-streamed rendering.

*Call graph*: calls 1 internal fn (append_markdown_agent); 5 external calls (new, assert_eq!, collect_streamed_lines, lines_to_plain_strings, vec!).


##### `tests::controller_holds_blockquoted_table_tail_until_stable`  (lines 1227–1243)

```
fn controller_holds_blockquoted_table_tail_until_stable()
```

**Purpose**: Checks that tables inside blockquotes are held and rendered correctly.

**Data flow**: It streams a blockquoted table, collects output, renders the full source, and compares them.

**Call relations**: This covers table scanner behavior with blockquote prefixes.

*Call graph*: calls 1 internal fn (append_markdown_agent); 5 external calls (new, assert_eq!, collect_streamed_lines, lines_to_plain_strings, vec!).


##### `tests::controller_keeps_pre_table_lines_queued_when_table_is_confirmed`  (lines 1246–1271)

```
fn controller_keeps_pre_table_lines_queued_when_table_is_confirmed()
```

**Purpose**: Ensures text before a table can still commit even after the following table is held back.

**Data flow**: It queues an intro line, then streams a table header and delimiter, checks the intro remains queued, drains it, and verifies only pre-table content was committed.

**Call relations**: This protects the invariant that holdback starts at the table, not before it.

*Call graph*: 3 external calls (assert!, assert_eq!, stream_controller).


##### `tests::controller_set_width_during_confirmed_table_stream_matches_finalize_render`  (lines 1274–1307)

```
fn controller_set_width_during_confirmed_table_stream_matches_finalize_render()
```

**Purpose**: Checks that resizing during a confirmed live table still leads to the correct final render.

**Data flow**: It streams a table, confirms no stable lines are queued, resizes, finalizes, and compares output against a full render at the new width.

**Call relations**: This exercises set_width with a fully mutable table tail.

*Call graph*: calls 1 internal fn (append_markdown_agent); 4 external calls (new, assert_eq!, lines_to_plain_strings, stream_controller).


##### `tests::controller_does_not_hold_back_pipe_prose_without_table_delimiter`  (lines 1310–1323)

```
fn controller_does_not_hold_back_pipe_prose_without_table_delimiter()
```

**Purpose**: Ensures prose containing pipe characters is not mistaken for a table forever.

**Data flow**: It streams a pipe-containing prose line, drains it, streams another line, and asserts the later line can commit.

**Call relations**: This protects the table scanner from over-holding non-table text.

*Call graph*: 2 external calls (assert!, stream_controller).


##### `tests::controller_does_not_stall_repeated_pipe_prose_paragraphs`  (lines 1326–1345)

```
fn controller_does_not_stall_repeated_pipe_prose_paragraphs()
```

**Purpose**: Checks repeated pipe-like prose paragraphs do not stall streaming.

**Data flow**: It streams two pipe-containing paragraphs separated by blank lines and verifies the first paragraph appears before finalization.

**Call relations**: This guards against false table detection causing permanent tail holdback.

*Call graph*: 2 external calls (assert!, stream_controller).


##### `tests::controller_handles_table_immediately_after_heading`  (lines 1348–1366)

```
fn controller_handles_table_immediately_after_heading()
```

**Purpose**: Ensures a table that follows a heading directly streams to the same output as full rendering.

**Data flow**: It streams a heading and table, collects output, renders the full source, and compares lines.

**Call relations**: This covers a common markdown structure near a table boundary.

*Call graph*: calls 1 internal fn (append_markdown_agent); 5 external calls (new, assert_eq!, collect_streamed_lines, lines_to_plain_strings, vec!).


##### `tests::controller_renders_separators_for_multi_table_response_shape`  (lines 1369–1388)

```
fn controller_renders_separators_for_multi_table_response_shape()
```

**Purpose**: Checks that streamed output for several table shapes includes rendered table separators.

**Data flow**: It streams a large source split by lines and asserts the collected output contains table separator characters.

**Call relations**: This verifies that tables are being rendered as tables, not left as raw pipe text.

*Call graph*: 2 external calls (assert!, collect_streamed_lines).


##### `tests::controller_renders_separators_for_no_outer_pipes_table_shape`  (lines 1391–1418)

```
fn controller_renders_separators_for_no_outer_pipes_table_shape()
```

**Purpose**: Ensures tables without leading and trailing outer pipes render correctly while streaming.

**Data flow**: It streams mixed content with no-outer-pipe tables, compares with full rendering, and asserts raw headers are not left behind while separators appear.

**Call relations**: This protects table detection and rendering for a less obvious markdown table form.

*Call graph*: calls 1 internal fn (append_markdown_agent); 5 external calls (new, assert!, assert_eq!, collect_streamed_lines, lines_to_plain_strings).


##### `tests::controller_stabilizes_first_no_outer_pipes_table_in_response`  (lines 1421–1449)

```
fn controller_stabilizes_first_no_outer_pipes_table_in_response()
```

**Purpose**: Checks that a no-outer-pipes table at the start of a response is correctly stabilized.

**Data flow**: It streams such a table, compares collected output with full rendering, and verifies separator output replaces the raw header.

**Call relations**: This covers table holdback when there is little or no preceding prose.

*Call graph*: calls 1 internal fn (append_markdown_agent); 6 external calls (new, assert!, assert_eq!, collect_streamed_lines, lines_to_plain_strings, vec!).


##### `tests::controller_stabilizes_two_column_no_outer_table_in_response`  (lines 1452–1476)

```
fn controller_stabilizes_two_column_no_outer_table_in_response()
```

**Purpose**: Verifies two-column no-outer-pipe tables are detected and rendered correctly.

**Data flow**: It streams a compact two-column table, compares with full rendering, and asserts the raw header is not present.

**Call relations**: This guards a minimal table shape that could be confused with prose.

*Call graph*: calls 1 internal fn (append_markdown_agent); 6 external calls (new, assert!, assert_eq!, collect_streamed_lines, lines_to_plain_strings, vec!).


##### `tests::controller_converts_no_outer_table_between_preboxed_sections`  (lines 1479–1504)

```
fn controller_converts_no_outer_table_between_preboxed_sections()
```

**Purpose**: Checks that a no-outer-pipe table between preformatted box-like sections is still converted.

**Data flow**: It streams a source with box-drawing text, a no-outer table, and more box text, then asserts the raw table header is gone and converted table text appears.

**Call relations**: This protects table detection in visually complex surrounding content.

*Call graph*: 2 external calls (assert!, collect_streamed_lines).


##### `tests::controller_keeps_markdown_fenced_tables_mutable_until_finalize`  (lines 1507–1531)

```
fn controller_keeps_markdown_fenced_tables_mutable_until_finalize()
```

**Purpose**: Ensures tables inside markdown-language code fences are treated as markdown tables for final output.

**Data flow**: It streams a fenced md table, compares streamed and full rendering, and asserts table separators appear while raw pipe headers do not.

**Call relations**: This exercises holdback scanner fence handling for markdown fences.

*Call graph*: calls 1 internal fn (append_markdown_agent); 6 external calls (new, assert!, assert_eq!, collect_streamed_lines, lines_to_plain_strings, vec!).


##### `tests::controller_keeps_markdown_fenced_no_outer_tables_mutable_until_finalize`  (lines 1534–1562)

```
fn controller_keeps_markdown_fenced_no_outer_tables_mutable_until_finalize()
```

**Purpose**: Checks no-outer-pipe tables inside markdown fences are held and rendered as tables.

**Data flow**: It streams a fenced md no-outer table, compares with full rendering, and checks for separators instead of raw headers.

**Call relations**: This extends markdown-fence coverage to no-outer table syntax.

*Call graph*: calls 1 internal fn (append_markdown_agent); 6 external calls (new, assert!, assert_eq!, collect_streamed_lines, lines_to_plain_strings, vec!).


##### `tests::controller_live_view_matches_render_during_interleaved_table_streaming`  (lines 1565–1608)

```
fn controller_live_view_matches_render_during_interleaved_table_streaming()
```

**Purpose**: Verifies that the combination of emitted scrollback and current live tail always matches a fresh render of the committed source.

**Data flow**: It streams prose and multiple tables line by line, drains commits after each line, combines emitted lines with visible tail lines, and compares that live view to a full render after every delta.

**Call relations**: This is a broad integration test for stable/tail partitioning during interleaved content.

*Call graph*: calls 2 internal fn (append_markdown_agent, visible_lines); 4 external calls (new, assert_eq!, lines_to_plain_strings, stream_controller).


##### `tests::finalized_stream_table_preserves_semantic_url_fragments`  (lines 1611–1632)

```
fn finalized_stream_table_preserves_semantic_url_fragments()
```

**Purpose**: Ensures long table URLs keep their hyperlink destination even when visually wrapped.

**Data flow**: It streams and finalizes a table with a long URL at narrow width, inspects displayed hyperlink fragments, and asserts every fragment points to the original full URL.

**Call relations**: This protects hyperlink preservation through table rendering and final emission.

*Call graph*: 3 external calls (assert!, format!, stream_controller).


##### `tests::controller_keeps_non_markdown_fenced_tables_as_code`  (lines 1635–1661)

```
fn controller_keeps_non_markdown_fenced_tables_as_code()
```

**Purpose**: Ensures table-like text inside non-markdown code fences stays raw code, not a rendered table.

**Data flow**: It streams a shell-fenced pipe table, compares with full rendering, and asserts raw pipe text remains while table separators do not appear.

**Call relations**: This protects the scanner rule that skips non-markdown fences.

*Call graph*: calls 1 internal fn (append_markdown_agent); 6 external calls (new, assert!, assert_eq!, collect_streamed_lines, lines_to_plain_strings, vec!).


##### `tests::plan_controller_streamed_table_matches_final_render`  (lines 1664–1689)

```
fn plan_controller_streamed_table_matches_final_render()
```

**Purpose**: Checks that a streamed proposed-plan table matches a baseline plan render.

**Data flow**: It streams plan table deltas, collects output, compares with collecting the same source as one chunk, and verifies table separators appear.

**Call relations**: This confirms plan streams share the same table correctness as agent streams.

*Call graph*: 4 external calls (assert!, assert_eq!, collect_plan_streamed_lines, vec!).


##### `tests::finalized_plan_stream_preserves_semantic_url_fragments`  (lines 1692–1717)

```
fn finalized_plan_stream_preserves_semantic_url_fragments()
```

**Purpose**: Ensures long URLs in finalized plan tables keep their full hyperlink destination across wrapped fragments.

**Data flow**: It streams a narrow plan table with a long URL, finalizes, inspects hyperlink lines, and asserts all hyperlink fragments preserve the original destination.

**Call relations**: This mirrors the agent hyperlink preservation test for proposed plans.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert!, format!, test_cwd).


##### `tests::plan_controller_streamed_markdown_fenced_table_matches_final_render`  (lines 1720–1747)

```
fn plan_controller_streamed_markdown_fenced_table_matches_final_render()
```

**Purpose**: Checks that markdown-fenced tables in proposed plans stream to the same result as baseline rendering.

**Data flow**: It streams a plan containing a fenced md table, compares with one-shot plan collection, and checks separators appear instead of raw headers.

**Call relations**: This covers plan-stream table holdback inside markdown fences.

*Call graph*: 4 external calls (assert!, assert_eq!, collect_plan_streamed_lines, vec!).


##### `tests::table_holdback_state_detects_header_plus_delimiter`  (lines 1750–1756)

```
fn table_holdback_state_detects_header_plus_delimiter()
```

**Purpose**: Verifies the table holdback scanner recognizes a normal table header followed by a delimiter row.

**Data flow**: It passes a simple pipe table source to the scanner helper and asserts the state is Confirmed.

**Call relations**: This tests the lower-level table detection used by StreamCore.

*Call graph*: 1 external calls (assert!).


##### `tests::table_holdback_state_detects_single_column_header_plus_delimiter`  (lines 1759–1765)

```
fn table_holdback_state_detects_single_column_header_plus_delimiter()
```

**Purpose**: Verifies the scanner accepts a single-column markdown table.

**Data flow**: It passes a one-column header and delimiter to the scanner helper and expects a Confirmed state.

**Call relations**: This protects a small but valid table form.

*Call graph*: 1 external calls (assert!).


##### `tests::table_holdback_state_ignores_table_like_lines_inside_unclosed_long_fence`  (lines 1768–1774)

```
fn table_holdback_state_ignores_table_like_lines_inside_unclosed_long_fence()
```

**Purpose**: Ensures table-looking text inside an open non-markdown fence does not trigger holdback.

**Data flow**: It passes source with nested fence-like text and pipe rows to the scanner helper and expects no table state.

**Call relations**: This guards fence-context handling in table detection.

*Call graph*: 1 external calls (assert!).


##### `tests::table_holdback_state_treats_indented_fence_text_as_plain_content`  (lines 1777–1786)

```
fn table_holdback_state_treats_indented_fence_text_as_plain_content()
```

**Purpose**: Checks that indented fence-looking text is not treated as opening a code fence for scanner purposes.

**Data flow**: It passes an indented fence-like line followed by table rows and expects table confirmation.

**Call relations**: This protects table detection when fence markers are just plain indented content.

*Call graph*: 1 external calls (assert!).


##### `tests::table_holdback_state_ignores_table_like_lines_inside_blockquoted_other_fence`  (lines 1789–1795)

```
fn table_holdback_state_ignores_table_like_lines_inside_blockquoted_other_fence()
```

**Purpose**: Ensures table-looking rows inside a blockquoted non-markdown fence are ignored.

**Data flow**: It passes a blockquoted shell fence containing pipe rows and expects no table holdback state.

**Call relations**: This covers the combination of blockquotes and non-markdown fences in scanner logic.

*Call graph*: 1 external calls (assert!).


##### `tests::incremental_holdback_matches_stateless_scan_per_chunk`  (lines 1798–1821)

```
fn incremental_holdback_matches_stateless_scan_per_chunk()
```

**Purpose**: Checks that the incremental table scanner gives the same answer as rescanning all source after each chunk.

**Data flow**: It feeds chunks one by one into TableHoldbackScanner, keeps a growing source string, and compares incremental state with a stateless scan after every chunk.

**Call relations**: This protects the append-only scanner used by StreamCore::push_delta.

*Call graph*: calls 1 internal fn (new); 2 external calls (new, assert_eq!).


##### `tests::incremental_holdback_detects_header_delimiter_across_chunk_boundary`  (lines 1824–1836)

```
fn incremental_holdback_detects_header_delimiter_across_chunk_boundary()
```

**Purpose**: Verifies the incremental scanner can detect a table whose header and delimiter arrive in separate chunks.

**Data flow**: It pushes the header chunk and expects PendingHeader, then pushes the delimiter chunk and expects Confirmed.

**Call relations**: This tests the exact streaming situation table holdback is built for.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `tests::controller_set_width_after_first_line_emit_does_not_requeue_first_line`  (lines 1839–1866)

```
fn controller_set_width_after_first_line_emit_does_not_requeue_first_line()
```

**Purpose**: Ensures resizing after the first emitted line does not replay that first line.

**Data flow**: It streams two lines, emits one tick, resizes narrower, finalizes, and checks the remaining output excludes the first token but includes the second line.

**Call relations**: This protects emitted_stable_len handling during resize.

*Call graph*: 2 external calls (assert!, stream_controller).


##### `tests::controller_set_width_partial_wrapped_emit_preserves_remaining_content`  (lines 1869–1895)

```
fn controller_set_width_partial_wrapped_emit_preserves_remaining_content()
```

**Purpose**: Checks that resizing after emitting only part of a wrapped line preserves later content.

**Data flow**: It streams a long wrapped line and a tail line, emits one tick, resizes wider, finalizes, and asserts the tail line remains.

**Call relations**: This guards against losing un-emitted content when wrapping changes dramatically.

*Call graph*: 2 external calls (assert!, stream_controller).


##### `tests::controller_set_width_partial_wrapped_emit_keeps_wrapped_remainder`  (lines 1898–1921)

```
fn controller_set_width_partial_wrapped_emit_keeps_wrapped_remainder()
```

**Purpose**: Ensures the un-emitted remainder of a partially emitted wrapped line is not lost after resize.

**Data flow**: It streams a long line at a narrow width, emits one wrapped segment, resizes wide, finalizes, and checks that later words from the original line still appear.

**Call relations**: This protects the resize logic for partially emitted source lines.

*Call graph*: 2 external calls (assert!, stream_controller).


### `tui/src/streaming/chunking.rs`

`domain_logic` · `main loop, during streaming display commit ticks`

Streaming output can arrive in bursts. If the terminal UI prints every queued line immediately, the display may feel jumpy. If it always prints only one line at a time, it can fall far behind. This file solves that pacing problem with a small two-gear policy, like a bicycle shifting between an easy cruising gear and a faster catch-up gear.

The policy looks only at two facts about the waiting queue: how many lines are queued, and how old the oldest queued line is. In normal Smooth mode, it tells the caller to drain one line on each display tick. If the queue gets deep enough, or the oldest line has waited too long, it enters CatchUp mode and tells the caller to drain the whole current backlog.

It also avoids rapidly switching back and forth near the thresholds. That protection is called hysteresis, meaning it requires the pressure to stay low for a short time before leaving CatchUp, and it briefly blocks re-entering CatchUp after an exit unless the backlog is severe. Without this file, streamed text would either lag badly during bursts or appear in uneven, hard-to-read jumps.

#### Function details

##### `AdaptiveChunkingPolicy::mode`  (lines 165–167)

```
fn mode(&self) -> ChunkingMode
```

**Purpose**: Returns the policy's current gear: Smooth or CatchUp. Callers use this when they need to know the latest pacing state without making a new decision.

**Data flow**: It reads the stored mode inside the policy and returns that value unchanged. It does not inspect the queue and does not change any state.

**Call relations**: The larger streaming flow calls this from resolve_chunking_plan when it needs to report or reuse the current chunking state. It is a read-only window into the policy after previous decisions have shaped that state.

*Call graph*: called by 1 (resolve_chunking_plan).


##### `AdaptiveChunkingPolicy::reset`  (lines 170–174)

```
fn reset(&mut self)
```

**Purpose**: Puts the policy back into its starting state. This is useful when a stream is restarted or the caller wants to forget any previous catch-up history.

**Data flow**: It takes the existing policy state, sets the mode to Smooth, clears the timer that tracks low pressure, and clears the record of the last catch-up exit. Nothing is returned; the policy itself is changed.

**Call relations**: This is a cleanup or fresh-start helper. Unlike decide, it does not look at the queue; it simply prepares the policy so the next decision begins from the baseline smooth behavior.


##### `AdaptiveChunkingPolicy::decide`  (lines 180–210)

```
fn decide(&mut self, snapshot: QueueSnapshot, now: Instant) -> ChunkingDecision
```

**Purpose**: Makes the main pacing decision for one display tick. It decides whether to stay smooth, switch into catch-up, leave catch-up, and how many queued lines should be drained now.

**Data flow**: It receives a QueueSnapshot, which says how many lines are waiting and how old the oldest one is, plus the current time. If the queue is empty, it returns to Smooth. Otherwise it may enter or exit CatchUp based on the thresholds and timers, then returns a ChunkingDecision containing the final mode, whether CatchUp was just entered, and a drain plan: one line in Smooth or the current backlog in CatchUp.

**Call relations**: resolve_chunking_plan calls this as the central policy step during streaming output. Inside, it delegates the gear-shift details to maybe_enter_catch_up or maybe_exit_catch_up, records empty-queue exits through note_catch_up_exit, and creates Batch plans when CatchUp should drain multiple lines.

*Call graph*: calls 3 internal fn (maybe_enter_catch_up, maybe_exit_catch_up, note_catch_up_exit); called by 1 (resolve_chunking_plan); 1 external calls (Batch).


##### `AdaptiveChunkingPolicy::maybe_enter_catch_up`  (lines 216–227)

```
fn maybe_enter_catch_up(&mut self, snapshot: QueueSnapshot, now: Instant) -> bool
```

**Purpose**: Checks whether Smooth mode should shift into CatchUp mode. It returns true only on the exact tick where that shift happens, so callers can notice the transition once.

**Data flow**: It receives the current queue snapshot and time. First it asks whether the normal entry thresholds are crossed. Then it checks whether a recent exit still blocks re-entry, unless the backlog is severe. If entry is allowed, it changes the stored mode to CatchUp, clears old exit timing state, and returns true; otherwise it leaves the policy unchanged and returns false.

**Call relations**: decide calls this only while the policy is currently Smooth. This helper uses should_enter_catch_up for the ordinary pressure test, reentry_hold_active for the cooldown check, and is_severe_backlog to let truly large or old queues bypass that cooldown.

*Call graph*: calls 3 internal fn (reentry_hold_active, is_severe_backlog, should_enter_catch_up); called by 1 (decide).


##### `AdaptiveChunkingPolicy::maybe_exit_catch_up`  (lines 233–250)

```
fn maybe_exit_catch_up(&mut self, snapshot: QueueSnapshot, now: Instant)
```

**Purpose**: Checks whether CatchUp mode should shift back to Smooth mode. It requires the queue to stay calm for a short hold period, rather than exiting the moment pressure dips.

**Data flow**: It receives the queue snapshot and current time. If the queue is not low enough, it clears the low-pressure timer. If the queue is low enough for the first time, it starts the timer. If it has stayed low long enough, it changes the mode to Smooth, clears the timer, and records when CatchUp ended.

**Call relations**: decide calls this only while the policy is in CatchUp. It uses should_exit_catch_up to decide whether pressure is low enough, and it compares times with saturating_duration_since so timing stays safe even if time values are unusual.

*Call graph*: calls 1 internal fn (should_exit_catch_up); called by 1 (decide); 1 external calls (saturating_duration_since).


##### `AdaptiveChunkingPolicy::note_catch_up_exit`  (lines 252–256)

```
fn note_catch_up_exit(&mut self, now: Instant)
```

**Purpose**: Records that CatchUp mode ended at a particular time, but only if the policy was actually in CatchUp. This supports the short cooldown that prevents immediate re-entry.

**Data flow**: It receives the current time. If the stored mode is CatchUp, it saves that time as the last catch-up exit; otherwise it does nothing. It returns nothing.

**Call relations**: decide calls this when the queue is empty, because an empty queue forces the policy back to Smooth. The recorded exit time is later read by reentry_hold_active when maybe_enter_catch_up considers a new CatchUp entry.

*Call graph*: called by 1 (decide).


##### `AdaptiveChunkingPolicy::reentry_hold_active`  (lines 258–261)

```
fn reentry_hold_active(&self, now: Instant) -> bool
```

**Purpose**: Answers whether the policy is still inside the cooldown period after leaving CatchUp. This helps avoid quick back-and-forth switching.

**Data flow**: It reads the stored last exit time, if there is one, and compares it with the current time. It returns true if the exit was recent enough to still be inside the re-entry hold window; otherwise it returns false.

**Call relations**: maybe_enter_catch_up calls this before switching back into CatchUp. If it says the hold is active, entry is blocked unless is_severe_backlog says the queue is too urgent to wait.

*Call graph*: called by 1 (maybe_enter_catch_up).


##### `should_enter_catch_up`  (lines 267–272)

```
fn should_enter_catch_up(snapshot: QueueSnapshot) -> bool
```

**Purpose**: Checks the basic pressure rule for entering CatchUp. Either enough queued lines or an old enough waiting line is enough to trigger it.

**Data flow**: It receives a QueueSnapshot. It compares queued_lines with the entry depth threshold and oldest_age with the entry age threshold, if an age is present. It returns true if either signal shows too much backlog.

**Call relations**: maybe_enter_catch_up calls this as its first gate. This function does only the simple threshold test; the caller adds cooldown and severe-backlog rules around it.

*Call graph*: called by 1 (maybe_enter_catch_up).


##### `should_exit_catch_up`  (lines 278–283)

```
fn should_exit_catch_up(snapshot: QueueSnapshot) -> bool
```

**Purpose**: Checks whether the queue is calm enough to begin or continue leaving CatchUp mode. Both the queue size and oldest-line age must be low.

**Data flow**: It receives a QueueSnapshot. It compares queued_lines with the exit depth threshold and oldest_age with the exit age threshold. It returns true only when both signals are below their limits.

**Call relations**: maybe_exit_catch_up calls this while in CatchUp. A true result does not immediately exit by itself; it lets the caller start or continue the required low-pressure hold time.

*Call graph*: called by 1 (maybe_exit_catch_up).


##### `is_severe_backlog`  (lines 289–294)

```
fn is_severe_backlog(snapshot: QueueSnapshot) -> bool
```

**Purpose**: Detects when the backlog is urgent enough to ignore the normal cooldown after leaving CatchUp. This prevents very large or very old queues from growing worse while waiting.

**Data flow**: It receives a QueueSnapshot and checks for either a very high queued line count or a very old oldest line. It returns true if either severe limit is reached.

**Call relations**: maybe_enter_catch_up calls this when the re-entry hold is active. If the backlog is severe, the policy is allowed to enter CatchUp anyway.

*Call graph*: called by 1 (maybe_enter_catch_up).


##### `tests::snapshot`  (lines 301–306)

```
fn snapshot(queued_lines: usize, oldest_age_ms: u64) -> QueueSnapshot
```

**Purpose**: Builds a small QueueSnapshot for tests. It keeps the test cases easy to read by letting them specify queued lines and age in milliseconds.

**Data flow**: It receives a line count and an age in milliseconds. It converts the age into a Duration and returns a QueueSnapshot with that count and age filled in.

**Call relations**: The test functions call this helper whenever they need a non-empty queue snapshot. It hides the Duration construction so each test can focus on the policy behavior being checked.

*Call graph*: 1 external calls (from_millis).


##### `tests::smooth_mode_is_default`  (lines 309–317)

```
fn smooth_mode_is_default()
```

**Purpose**: Verifies that a new policy starts in Smooth mode and drains one line at a time under light pressure.

**Data flow**: It creates a default policy, creates a low-pressure snapshot, asks the policy to decide, and checks that the result is Smooth, did not enter CatchUp, and uses a Single drain plan.

**Call relations**: This test exercises the public decide path with the normal starting state. It uses tests::snapshot to build the input and assert_eq! checks to confirm the baseline behavior.

*Call graph*: 4 external calls (now, assert_eq!, default, snapshot).


##### `tests::enters_catch_up_on_depth_threshold`  (lines 320–328)

```
fn enters_catch_up_on_depth_threshold()
```

**Purpose**: Verifies that a queue with enough waiting lines enters CatchUp even when the oldest line is still young.

**Data flow**: It creates a default policy and a snapshot with the entry-level line count. After calling decide, it checks that the mode is CatchUp, the transition flag is true, and the drain plan batches all queued lines.

**Call relations**: This test drives decide into maybe_enter_catch_up through the depth threshold path. It proves should_enter_catch_up can trigger from queue size alone.

*Call graph*: 4 external calls (now, assert_eq!, default, snapshot).


##### `tests::enters_catch_up_on_age_threshold`  (lines 331–339)

```
fn enters_catch_up_on_age_threshold()
```

**Purpose**: Verifies that an old waiting line can trigger CatchUp even when the queue is not very deep.

**Data flow**: It creates a default policy and a snapshot with only a few lines but with the oldest line at the entry age threshold. It calls decide and checks for CatchUp, a true transition flag, and a batch drain of the queued lines.

**Call relations**: This test reaches the same entry flow as the depth test, but through the age condition. It confirms should_enter_catch_up treats age pressure as sufficient on its own.

*Call graph*: 4 external calls (now, assert_eq!, default, snapshot).


##### `tests::severe_backlog_uses_faster_paced_batches`  (lines 342–353)

```
fn severe_backlog_uses_faster_paced_batches()
```

**Purpose**: Verifies that a very large backlog in CatchUp mode drains as a large batch. It checks that the policy tries to converge quickly when many lines are waiting.

**Data flow**: It first moves the policy into CatchUp with a moderate backlog. Then it gives the policy a severe line count and checks that it remains in CatchUp and returns a Batch plan for all 64 queued lines.

**Call relations**: This test uses decide twice: once to enter CatchUp and again to confirm the CatchUp drain plan follows the current queue size. It supports the intended behavior that CatchUp drains the visible backlog, not a fixed small number.

*Call graph*: 5 external calls (from_millis, now, assert_eq!, default, snapshot).


##### `tests::catch_up_batch_drains_current_backlog`  (lines 356–362)

```
fn catch_up_batch_drains_current_backlog()
```

**Purpose**: Verifies that CatchUp mode plans to drain the full current backlog, even when it is very large.

**Data flow**: It creates a snapshot with hundreds of queued lines and an old oldest line, calls decide, and checks that the result is CatchUp with a Batch plan matching the full queued count.

**Call relations**: This test exercises decide entering CatchUp and creating a Batch plan. It protects the important promise that CatchUp is meant to close display lag as quickly as possible.

*Call graph*: 4 external calls (now, assert_eq!, default, snapshot).


##### `tests::exits_catch_up_after_hysteresis_hold`  (lines 365–384)

```
fn exits_catch_up_after_hysteresis_hold()
```

**Purpose**: Verifies that CatchUp does not exit immediately when pressure drops, but does exit after the low-pressure condition lasts long enough.

**Data flow**: It first enters CatchUp. Then it calls decide with a low-pressure snapshot before the hold time has passed and confirms the policy stays in CatchUp. Finally it calls decide after enough time and confirms the policy returns to Smooth with a Single drain plan.

**Call relations**: This test drives decide through maybe_exit_catch_up. It proves the hysteresis hold works: should_exit_catch_up starts the exit process, but time must pass before the mode changes.

*Call graph*: 5 external calls (from_millis, now, assert_eq!, default, snapshot).


##### `tests::drops_back_to_smooth_when_idle`  (lines 387–402)

```
fn drops_back_to_smooth_when_idle()
```

**Purpose**: Verifies that an empty queue immediately returns the policy to Smooth mode. If there is nothing to drain, the UI should go back to its baseline pacing.

**Data flow**: It first enters CatchUp, then calls decide with zero queued lines and no oldest age. It checks that the returned decision is Smooth and uses a Single drain plan.

**Call relations**: This test covers the special empty-queue branch in decide. That branch calls note_catch_up_exit, resets the mode to Smooth, and clears the low-pressure timer without waiting for the normal exit hold.

*Call graph*: 5 external calls (from_millis, now, assert_eq!, default, snapshot).


##### `tests::holds_reentry_after_catch_up_exit`  (lines 405–434)

```
fn holds_reentry_after_catch_up_exit()
```

**Purpose**: Verifies that after leaving CatchUp, the policy briefly refuses to re-enter CatchUp for ordinary backlog. This prevents annoying rapid gear-flapping.

**Data flow**: It enters CatchUp, drains to an empty queue so the policy returns to Smooth, then presents another threshold-level backlog during the cooldown and checks that it stays Smooth. After the cooldown has passed, the same kind of backlog is allowed to re-enter CatchUp.

**Call relations**: This test follows decide through note_catch_up_exit and later through maybe_enter_catch_up. It specifically proves reentry_hold_active blocks ordinary re-entry until the hold window expires.

*Call graph*: 5 external calls (from_millis, now, assert_eq!, default, snapshot).


##### `tests::severe_backlog_can_reenter_during_hold`  (lines 437–456)

```
fn severe_backlog_can_reenter_during_hold()
```

**Purpose**: Verifies that the cooldown after leaving CatchUp can be bypassed when the backlog is severe. This keeps the UI from falling far behind during a sudden large burst.

**Data flow**: It enters CatchUp, exits by giving an empty queue, then presents a severe backlog while the re-entry hold is still active. It checks that the policy enters CatchUp and batches all severe queued lines.

**Call relations**: This test drives maybe_enter_catch_up through both reentry_hold_active and is_severe_backlog. It confirms that the cooldown protects against chatter but does not block urgent catch-up work.

*Call graph*: 5 external calls (from_millis, now, assert_eq!, default, snapshot).


### `tui/src/streaming/commit_tick.rs`

`orchestration` · `main loop streaming tick`

Streaming output can arrive faster than the interface should display it. If every incoming line were shown immediately, the UI could feel jumpy or overloaded; if lines were drained too slowly, the display could fall behind. This file is the middleman that solves that pacing problem.

On each commit tick, `run_commit_tick` looks at the current stream controllers. A controller is the object that owns queued stream lines and knows how to turn them into `HistoryCell` values, which are displayable pieces of conversation history. The file first builds a simple pressure report: how many lines are waiting, and how old the oldest waiting line is. It gives that report to the adaptive chunking policy, which chooses whether to drain just one line or a larger batch. “Adaptive” here means it changes behavior based on backlog, like a cashier opening a faster lane when the queue gets long.

After the policy decides, this file applies the same drain plan to both possible stream sources: the main stream and the plan stream. It returns the cells that were produced, plus simple status flags saying whether any controller existed and whether all controllers are now idle. Importantly, this file does not schedule ticks, insert cells into history, or animate the UI. It only decides and drains.

#### Function details

##### `CommitTickOutput::default`  (lines 53–59)

```
fn default() -> Self
```

**Purpose**: Creates an empty result for a commit tick that did not drain anything. This is useful when the tick is skipped on purpose, such as when catch-up-only draining is requested but the system is not currently catching up.

**Data flow**: It receives no outside data. It creates a `CommitTickOutput` with no cells, marks that no controller was used, and treats the state as idle because there is nothing known to wait on.

**Call relations**: When `run_commit_tick` suppresses a tick, it returns this empty output. `apply_commit_tick_plan` also starts with this empty shape, then fills it in as each available controller is drained.

*Call graph*: called by 2 (apply_commit_tick_plan, run_commit_tick); 1 external calls (new).


##### `run_commit_tick`  (lines 69–91)

```
fn run_commit_tick(
    policy: &mut AdaptiveChunkingPolicy,
    stream_controller: Option<&mut StreamController>,
    plan_stream_controller: Option<&mut PlanStreamController>,
    scope: CommitTickS
```

**Purpose**: Runs the full commit-tick sequence for the current stream controllers. It checks queue pressure, asks the pacing policy how much to drain, optionally skips draining based on the requested scope, and returns whatever display cells were produced.

**Data flow**: It receives the adaptive chunking policy, optional main and plan stream controllers, the tick scope, and the current time. It reads queue depth and age from the controllers, updates or queries the policy to get a drain plan, and then drains the controllers if allowed. The result is a `CommitTickOutput` containing produced history cells and idle-status information.

**Call relations**: This is the top-level function in the file. It calls `stream_queue_snapshot` to summarize the queues, `resolve_chunking_plan` to ask the policy what to do, and `apply_commit_tick_plan` to carry out the chosen drain. If the caller requested `CatchUpOnly` and the policy is not in catch-up mode, it returns `CommitTickOutput::default` instead of draining.

*Call graph*: calls 4 internal fn (default, apply_commit_tick_plan, resolve_chunking_plan, stream_queue_snapshot).


##### `stream_queue_snapshot`  (lines 97–118)

```
fn stream_queue_snapshot(
    stream_controller: Option<&StreamController>,
    plan_stream_controller: Option<&PlanStreamController>,
    now: Instant,
) -> QueueSnapshot
```

**Purpose**: Builds the small queue-pressure report that the chunking policy needs. It combines both stream controllers into one view: total waiting lines and the age of the oldest waiting line.

**Data flow**: It receives optional references to the main stream controller and the plan stream controller, plus the current time. For each controller that exists, it reads how many lines are queued and how long the oldest queued line has been waiting. It returns a `QueueSnapshot` with the combined line count and the greatest waiting age found.

**Call relations**: `run_commit_tick` calls this before asking the policy for a decision. Inside, it uses `max_duration` so that if both controllers have waiting lines, the policy sees the oldest delay across both queues.

*Call graph*: calls 1 internal fn (max_duration); called by 1 (run_commit_tick).


##### `resolve_chunking_plan`  (lines 124–142)

```
fn resolve_chunking_plan(
    policy: &mut AdaptiveChunkingPolicy,
    snapshot: QueueSnapshot,
    now: Instant,
) -> ChunkingDecision
```

**Purpose**: Asks the adaptive chunking policy what mode and drain plan to use for this tick. It also records a trace log when the policy changes mode, which helps developers understand why stream pacing changed.

**Data flow**: It receives the mutable policy, the queue snapshot, and the current time. It reads the policy’s previous mode, asks the policy to decide based on the snapshot, and compares old versus new mode. It returns the resulting `ChunkingDecision`, which includes the chosen drain plan.

**Call relations**: `run_commit_tick` calls this after building the queue snapshot. This function hands the snapshot to the policy’s `decide` method and uses tracing when the mode changes, keeping that observability in one consistent place.

*Call graph*: calls 2 internal fn (decide, mode); called by 1 (run_commit_tick); 1 external calls (trace!).


##### `apply_commit_tick_plan`  (lines 148–173)

```
fn apply_commit_tick_plan(
    drain_plan: DrainPlan,
    stream_controller: Option<&mut StreamController>,
    plan_stream_controller: Option<&mut PlanStreamController>,
) -> CommitTickOutput
```

**Purpose**: Carries out the chosen drain plan on every stream controller that is present. It gathers any history cells produced and reports whether the controllers are idle afterward.

**Data flow**: It receives a `DrainPlan` and optional mutable references to the main and plan stream controllers. It starts with an empty `CommitTickOutput`, marks that controllers exist when it sees them, drains each one according to the plan, adds any produced cell to the output list, and updates the all-idle flag. It returns the completed output.

**Call relations**: `run_commit_tick` calls this after the policy has chosen a drain plan. This function delegates the actual controller-specific work to `drain_stream_controller` and `drain_plan_stream_controller`, then combines their results into one tick output.

*Call graph*: calls 3 internal fn (default, drain_plan_stream_controller, drain_stream_controller); called by 1 (run_commit_tick).


##### `drain_stream_controller`  (lines 180–188)

```
fn drain_stream_controller(
    controller: &mut StreamController,
    drain_plan: DrainPlan,
) -> (Option<Box<dyn HistoryCell>>, bool)
```

**Purpose**: Applies one drain step to the main stream controller. It translates the general drain plan into the controller method that either drains one line or a batch of lines.

**Data flow**: It receives the main stream controller and the selected `DrainPlan`. If the plan says `Single`, it asks the controller to commit one queued item. If the plan says `Batch`, it asks the controller to commit up to the given number of lines. It returns an optional produced history cell and a flag saying whether the controller is idle afterward.

**Call relations**: `apply_commit_tick_plan` calls this when the main stream controller exists. The function hands off to the controller’s own `on_commit_tick` or `on_commit_tick_batch` methods because the controller knows how to turn queued stream data into a history cell.

*Call graph*: calls 2 internal fn (on_commit_tick, on_commit_tick_batch); called by 1 (apply_commit_tick_plan).


##### `drain_plan_stream_controller`  (lines 194–202)

```
fn drain_plan_stream_controller(
    controller: &mut PlanStreamController,
    drain_plan: DrainPlan,
) -> (Option<Box<dyn HistoryCell>>, bool)
```

**Purpose**: Applies one drain step to the plan stream controller. It mirrors the main stream draining path so plan output follows the same pacing rules.

**Data flow**: It receives the plan stream controller and the selected `DrainPlan`. For a single-line plan, it commits one queued item; for a batch plan, it commits up to the requested number of lines. It returns an optional produced history cell and whether the controller is idle afterward.

**Call relations**: `apply_commit_tick_plan` calls this when the plan stream controller exists. Like `drain_stream_controller`, it passes the final work to the controller’s single-item or batch commit method so both stream types obey the same chunking decision.

*Call graph*: calls 2 internal fn (on_commit_tick, on_commit_tick_batch); called by 1 (apply_commit_tick_plan).


##### `max_duration`  (lines 207–214)

```
fn max_duration(lhs: Option<Duration>, rhs: Option<Duration>) -> Option<Duration>
```

**Purpose**: Chooses the longer of two optional time spans. It is used to find the oldest waiting queued line when one or both controllers may have no queued age to report.

**Data flow**: It receives two values that may or may not contain a duration. If both contain durations, it returns the larger one. If only one side has a duration, it returns that one. If neither side has a duration, it returns nothing.

**Call relations**: `stream_queue_snapshot` calls this while combining queue information from the two controllers. This helper keeps the snapshot logic simple and ensures the chunking policy sees the worst waiting time currently known.

*Call graph*: called by 1 (stream_queue_snapshot).


### Transcript cell foundations
These files provide the core transcript cell abstraction and the concrete history-cell renderers that streaming and event projection emit.

### `tui/src/history_cell/mod.rs`

`domain_logic` · `main loop rendering and transcript display`

The Codex terminal UI shows a conversation as a stack of “history cells.” A cell might be a user message, an assistant message, a command result, a plan update, a permission prompt, or another event. This file is the shared contract that lets all of those different things fit into one scrolling conversation view.

The central piece is the `HistoryCell` trait. A trait is like a promise: any cell type that implements it must know how to turn itself into lines of text for the screen and into plain text for raw scrollback or transcript views. The file also provides default behavior for common needs, such as measuring how many terminal rows a cell will take after wrapping long lines, or converting styled text into plain text.

It also supports terminal hyperlinks. Some displayed lines can carry hidden link information, so the UI can mark clickable regions while still showing normal text. For transcript mode, it lets cells provide a separate representation when the full conversation transcript should differ from the compact chat view.

Finally, it implements rendering for `Box<dyn HistoryCell>`, meaning “any history cell stored behind a common wrapper.” This lets the UI draw mixed cell types through one path. Without this file, the chat view would not have a reliable common language for sizing, drawing, copying, and transcript rendering its many different cell kinds.

#### Function details

##### `raw_lines_from_source`  (lines 150–164)

```
fn raw_lines_from_source(source: &str) -> Vec<Line<'static>>
```

**Purpose**: Turns one source text block into separate plain terminal lines. It is useful when code or command output must be shown exactly as line-by-line text, without keeping an extra blank line just because the source ended with a newline.

**Data flow**: It receives a single string. If the string is empty, it returns no lines. Otherwise it splits the text at newline characters, removes the final empty piece when the original text ended with a newline, and returns a list of owned display lines.

**Call relations**: When source text is being rendered, `render_source` calls this helper to convert that source into the line format used by the rest of the history-cell display system.

*Call graph*: called by 1 (render_source); 1 external calls (new).


##### `plain_lines`  (lines 166–178)

```
fn plain_lines(lines: impl IntoIterator<Item = Line<'static>>) -> Vec<Line<'static>>
```

**Purpose**: Removes styling from a set of terminal lines and keeps only the visible text. This is used for copy-friendly or raw views where colors, emphasis, and other decoration should not matter.

**Data flow**: It receives any collection of styled lines. For each line, it joins the text content from all its spans into one plain string, then returns a new list of simple lines with no styling attached.

**Call relations**: Several `raw_lines` implementations in the history-cell submodules call this when their normal rich display already has the right words but needs to be flattened into plain text.

*Call graph*: called by 4 (raw_lines, raw_lines, raw_lines, raw_lines); 1 external calls (into_iter).


##### `HistoryCell::display_hyperlink_lines`  (lines 197–199)

```
fn display_hyperlink_lines(&self, width: u16) -> Vec<HyperlinkLine>
```

**Purpose**: Provides the default way for a history cell to expose clickable-link metadata for its rich display. If a cell does not have special link behavior, this wraps its normal display lines as plain hyperlink-aware lines.

**Data flow**: It asks the cell for its display lines at the given terminal width. It then converts those lines into hyperlink-line records with no special hidden link metadata beyond the visible text, and returns them.

**Call relations**: The mode-selection helpers call this when rich display output is needed. Cells with real terminal hyperlinks can override it, while ordinary cells can rely on this default.

*Call graph*: calls 1 internal fn (plain_hyperlink_lines); called by 2 (display_hyperlink_lines_for_mode, display_lines_for_mode).


##### `HistoryCell::display_lines_for_mode`  (lines 201–206)

```
fn display_lines_for_mode(&self, width: u16, mode: HistoryRenderMode) -> Vec<Line<'static>>
```

**Purpose**: Chooses which visible lines to show depending on whether the UI wants rich display or raw text. This keeps the rest of the UI from needing to know the details of each mode.

**Data flow**: It receives a terminal width and a render mode. In rich mode, it gets hyperlink-aware display lines and extracts the visible text. In raw mode, it asks the cell for its raw lines. It returns the chosen list of visible lines.

**Call relations**: Height measurement calls this before counting how many wrapped rows a cell will occupy. It also relies on `display_hyperlink_lines` and `visible_lines` to turn rich hyperlink output into ordinary visible lines.

*Call graph*: calls 2 internal fn (display_hyperlink_lines, visible_lines); called by 1 (desired_height_for_mode).


##### `HistoryCell::display_hyperlink_lines_for_mode`  (lines 208–217)

```
fn display_hyperlink_lines_for_mode(
        &self,
        width: u16,
        mode: HistoryRenderMode,
    ) -> Vec<HyperlinkLine>
```

**Purpose**: Chooses hyperlink-aware output for either rich or raw display mode. It gives callers one place to ask for lines plus any terminal link information.

**Data flow**: It receives a terminal width and a render mode. In rich mode, it returns the cell’s hyperlink-aware display lines. In raw mode, it takes the raw text lines and wraps them as plain hyperlink-line records. The result can be used for drawing or insertion into history while preserving the right mode.

**Call relations**: `display_lines_for_history_insert` calls this when it needs the correct representation of a cell for the history view. The function delegates to `display_hyperlink_lines` for rich mode and to `plain_hyperlink_lines` for raw mode.

*Call graph*: calls 2 internal fn (display_hyperlink_lines, plain_hyperlink_lines); called by 1 (display_lines_for_history_insert).


##### `HistoryCell::desired_height`  (lines 226–228)

```
fn desired_height(&self, width: u16) -> u16
```

**Purpose**: Reports how many terminal rows the cell wants in the normal rich chat view. This helps the scrollable conversation layout reserve enough space for wrapped text.

**Data flow**: It receives a terminal width. It asks the more general height function to measure the cell in rich mode, then returns that row count.

**Call relations**: Rendering and layout code call this through the `HistoryCell` interface or through boxed cells. It is a convenience wrapper around `desired_height_for_mode`.

*Call graph*: calls 1 internal fn (desired_height_for_mode); called by 3 (desired_height, desired_height, desired_height).


##### `HistoryCell::desired_height_for_mode`  (lines 230–236)

```
fn desired_height_for_mode(&self, width: u16, mode: HistoryRenderMode) -> u16
```

**Purpose**: Measures how tall a cell will be after the terminal wraps long lines. This matters because one logical line can take several screen rows, especially with long URLs or unbroken text.

**Data flow**: It receives a terminal width and a render mode. It first gets the lines for that mode, builds a paragraph from them, asks the terminal UI library to count wrapped rows, and converts that count into the small integer type used for terminal dimensions. If conversion fails, it returns zero.

**Call relations**: `desired_height` calls this for rich mode. Internally it depends on `display_lines_for_mode` so the measurement matches whichever view mode is being used.

*Call graph*: calls 1 internal fn (display_lines_for_mode); called by 1 (desired_height); 2 external calls (new, from).


##### `HistoryCell::transcript_lines`  (lines 243–245)

```
fn transcript_lines(&self, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Provides the lines used in the transcript overlay, which is the larger conversation view opened separately from the main chat. By default, the transcript uses the same text as the main display.

**Data flow**: It receives a terminal width and asks the cell for its normal display lines at that width. It returns those lines unchanged unless a specific cell type overrides the method.

**Call relations**: `transcript_hyperlink_lines` uses this default transcript text, and transcript rendering can call it directly. Some specialized cells override it when the transcript should show fuller or differently formatted information.

*Call graph*: called by 2 (transcript_hyperlink_lines, render_transcript).


##### `HistoryCell::transcript_hyperlink_lines`  (lines 252–254)

```
fn transcript_hyperlink_lines(&self, width: u16) -> Vec<HyperlinkLine>
```

**Purpose**: Provides transcript lines in a form that can also carry terminal hyperlink information. The default keeps transcript output plain, which is safe for cells whose transcript differs from their rich display.

**Data flow**: It receives a terminal width, gets the cell’s transcript lines, wraps those plain lines into hyperlink-line records, and returns them.

**Call relations**: `desired_transcript_height` calls this before measuring transcript height. Cells whose transcript view should keep rich links can override this method.

*Call graph*: calls 2 internal fn (transcript_lines, plain_hyperlink_lines); called by 1 (desired_transcript_height).


##### `HistoryCell::desired_transcript_height`  (lines 261–279)

```
fn desired_transcript_height(&self, width: u16) -> u16
```

**Purpose**: Measures how many terminal rows this cell needs inside the transcript overlay. It uses the same wrapping-aware measurement as the main view, with a small correction for a known whitespace-only line issue.

**Data flow**: It receives a terminal width. It gets hyperlink-aware transcript lines, extracts the visible lines, and checks for the special case of exactly one line made only of whitespace; that case returns height one. Otherwise it builds a paragraph, counts wrapped rows, converts the count to a terminal height value, and returns it.

**Call relations**: Transcript layout code uses this to size cells in the overlay. It depends on `transcript_hyperlink_lines` and `visible_lines` so the measurement matches what the transcript will actually show.

*Call graph*: calls 2 internal fn (transcript_hyperlink_lines, visible_lines); 2 external calls (new, from).


##### `HistoryCell::is_stream_continuation`  (lines 281–283)

```
fn is_stream_continuation(&self) -> bool
```

**Purpose**: Tells the UI whether this cell continues a streaming message rather than starting a fully separate entry. The default answer is no.

**Data flow**: It takes no extra input and returns `false`. Specific cell types can override it when they represent a continuation of live streamed output.

**Call relations**: `display_lines_for_history_insert` checks this when deciding how to insert or combine cells in the history display.

*Call graph*: called by 1 (display_lines_for_history_insert).


##### `HistoryCell::transcript_animation_tick`  (lines 295–297)

```
fn transcript_animation_tick(&self) -> Option<u64>
```

**Purpose**: Lets a cell signal that its transcript rendering changes over time, such as a spinner or other live animation. The default says there is no time-based change.

**Data flow**: It takes no extra input and returns `None`, meaning the transcript text can be cached safely. Animated in-flight cells can override it to return a changing number so cached transcript output gets refreshed.

**Call relations**: This supports the transcript overlay’s live-tail cache. When a cell does not override it, the overlay treats that cell’s transcript output as stable.


##### `Box::render`  (lines 301–318)

```
fn render(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Draws any boxed history cell into a rectangular area of the terminal. It also keeps clickable hyperlink regions aligned with the text that was drawn.

**Data flow**: It receives a screen rectangle and a mutable terminal buffer. It asks the cell for hyperlink-aware display lines at the rectangle width, extracts visible lines, builds a wrapping paragraph, and scrolls to the bottom if the content is taller than the available area. It clears the area first, draws the paragraph, and then marks hyperlink regions in the buffer.

**Call relations**: This is the common render path used once a history cell has been stored as `Box<dyn HistoryCell>`. It calls `mark_buffer_hyperlinks` after drawing so terminal links match the visible rows, and it uses `visible_lines` to separate what the user sees from the hidden link metadata.

*Call graph*: calls 2 internal fn (mark_buffer_hyperlinks, visible_lines); 4 external calls (new, from, try_from, from).


##### `Box::desired_height`  (lines 319–321)

```
fn desired_height(&self, width: u16) -> u16
```

**Purpose**: Allows a boxed history cell to report its wanted height through the generic rendering interface. This lets layout code treat all boxed cells the same way.

**Data flow**: It receives a terminal width. It forwards that width to the underlying `HistoryCell` height calculation and returns the result.

**Call relations**: The broader UI rendering system calls this through the `Renderable` interface. It simply bridges from boxed renderable objects back to the `HistoryCell::desired_height` behavior.

*Call graph*: calls 1 internal fn (desired_height).


##### `HistoryCell::as_any`  (lines 325–327)

```
fn as_any(&self) -> &dyn Any
```

**Purpose**: Exposes a history cell as a generic runtime value so code can check its concrete type when necessary. This is an escape hatch for cases where the shared trait is not enough.

**Data flow**: It receives an immutable reference to the cell and returns that same object through Rust’s `Any` type, which supports safe type checking and downcasting.

**Call relations**: Code that holds only a `dyn HistoryCell` can use this when it needs to ask, “is this actually a specific cell type?” without changing the main trait methods.


##### `HistoryCell::as_any_mut`  (lines 329–331)

```
fn as_any_mut(&mut self) -> &mut dyn Any
```

**Purpose**: Exposes a mutable history cell as a generic runtime value so code can check and modify its concrete type when necessary. This supports rare cases where an in-flight cell must be updated in place.

**Data flow**: It receives a mutable reference to the cell and returns that same object through Rust’s mutable `Any` interface. The caller can then safely downcast it to a specific cell type and change it if the type matches.

**Call relations**: This is used as a controlled escape hatch around the common `HistoryCell` interface, especially for active cells that may mutate while streaming.


### `tui/src/history_cell/messages.rs`

`domain_logic` · `conversation rendering and streaming updates`

The terminal chat history is made of small display units called history cells. This file provides the cells for the most important conversation content: what the user typed, what the assistant replied, short reasoning summaries, and the still-changing tail of a streaming assistant response.

Its main job is to make the same message useful in several places. On screen, text needs wrapping, indentation, color, bullets, and sometimes clickable file links. In transcripts or raw views, the same content should appear without decorative prefixes or terminal styling. Without this file, the app would either lose the original message text or display old conversation turns badly after a terminal resize.

A useful analogy is a print shop. The source message is the manuscript. These cells decide how to lay it out on the page: where to wrap lines, where to add a bullet, which parts get highlighted, and when to keep images or links visible. Assistant markdown is especially careful: finalized assistant messages keep the original markdown source so tables and links can be re-rendered correctly whenever the terminal width changes. Streaming messages are different: their unfinished tail is already laid out by the stream controller, so this file avoids rewrapping it and accidentally breaking table borders.

#### Function details

##### `build_user_message_lines_with_elements`  (lines 18–78)

```
fn build_user_message_lines_with_elements(
    message: &str,
    elements: &[TextElement],
    style: Style,
    element_style: Style,
) -> Vec<Line<'static>>
```

**Purpose**: Builds styled terminal lines for a user message when some parts of the text need special highlighting. It keeps explicit newlines and skips bad text ranges instead of crashing the history view.

**Data flow**: It receives the full message text, a list of marked text pieces, and two styles. It sorts the marked pieces by where they appear, walks through the message line by line, emits normal spans for ordinary text and highlighted spans for marked text, and returns terminal lines ready for wrapping.

**Call relations**: UserHistoryCell::display_lines calls this when a user message has text elements that need different styling. The result is then passed into the wrapping step so highlighted text and normal text stay in the right order on screen.

*Call graph*: called by 1 (display_lines); 6 external calls (from, from, styled, new, sort_by_key, to_vec).


##### `remote_image_display_line`  (lines 80–82)

```
fn remote_image_display_line(style: Style, index: usize) -> Line<'static>
```

**Purpose**: Creates the display line used to represent a remote image attachment in the user’s message. Instead of showing the image URL, it shows a short numbered image label.

**Data flow**: It receives a style and an image number. It turns that number into the standard image label text, applies the given style, and returns one terminal line.

**Call relations**: UserHistoryCell::display_lines uses this helper while building the list of remote image attachments shown above the user’s message text.

*Call graph*: 1 external calls (from).


##### `trim_trailing_blank_lines`  (lines 84–92)

```
fn trim_trailing_blank_lines(mut lines: Vec<Line<'static>>) -> Vec<Line<'static>>
```

**Purpose**: Removes empty-looking lines from the end of a list of terminal lines. This prevents extra blank space from appearing after messages that end with newlines.

**Data flow**: It receives already-built lines. It repeatedly checks the final line, and if all its text is blank after trimming whitespace, removes it. It returns the shortened list.

**Call relations**: UserHistoryCell::display_lines uses this after wrapping user message text, so the visible history does not grow extra empty rows at the bottom.

*Call graph*: called by 1 (display_lines).


##### `UserHistoryCell::display_lines`  (lines 95–177)

```
fn display_lines(&self, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Turns a stored user message into the styled, wrapped lines shown in the terminal history. It also shows remote image attachments and adds the user-message prefix.

**Data flow**: It receives the available terminal width and reads the cell’s message text, highlighted text elements, and remote image URLs. It calculates a safe wrap width, formats image labels if present, formats the message with or without highlighted spans, wraps everything, adds indentation and the prompt marker, and returns the final visible lines.

**Call relations**: The history renderer calls this when it needs to draw a user message. Inside, it may call build_user_message_lines_with_elements for highlighted text and trim_trailing_blank_lines to avoid trailing empty rows before handing the finished lines back to the UI.

*Call graph*: calls 3 internal fn (build_user_message_lines_with_elements, trim_trailing_blank_lines, new); 4 external calls (from, new, from, vec!).


##### `UserHistoryCell::raw_lines`  (lines 179–193)

```
fn raw_lines(&self) -> Vec<Line<'static>>
```

**Purpose**: Returns the user message as plain lines, without terminal decorations. This is useful for transcript-like views or operations that need the original readable content.

**Data flow**: It reads the stored message, trims only trailing line breaks, and turns it into plain lines. If remote images were attached, it adds a blank separator and then numbered image labels. The result is plain terminal lines with no chat prefix.

**Call relations**: The broader history system can call this when it needs the user content without the on-screen formatting added by display_lines.

*Call graph*: 1 external calls (from).


##### `ReasoningSummaryCell::new`  (lines 208–215)

```
fn new(header: String, content: String, cwd: &Path, transcript_only: bool) -> Self
```

**Purpose**: Creates a history cell for a reasoning summary. It also saves the working directory that was active at the time, so file links inside the summary keep the same meaning later.

**Data flow**: It receives a header, summary content, a current directory path, and a flag saying whether the summary should appear only in transcripts. It copies the path into the cell and returns the new ReasoningSummaryCell.

**Call relations**: new_reasoning_summary_block uses this when converting a finished reasoning buffer into a history cell. Tests and transcript-building code also construct these cells directly to check rendering behavior.

*Call graph*: called by 5 (new_reasoning_summary_block, reasoning_summary_height_matches_wrapped_rendering_for_url_like_content, source_backed_cells_render_raw_source_without_prefix_or_style, wrapped_and_prefixed_cells_handle_tiny_widths, thread_to_transcript_cells); 1 external calls (to_path_buf).


##### `ReasoningSummaryCell::lines`  (lines 217–244)

```
fn lines(&self, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Formats the reasoning summary for display or transcript output. It renders markdown, dims and italicizes it, then wraps it with a bullet-style indent.

**Data flow**: It receives the available width and reads the summary content plus saved working directory. It renders markdown with local file links resolved against that directory, applies a subdued style to every span, wraps the lines with a bullet on the first line and spaces after that, and returns the formatted lines.

**Call relations**: ReasoningSummaryCell::display_lines and ReasoningSummaryCell::transcript_lines both use this shared formatter, so screen output and transcript output are consistent when the summary is meant to be shown.

*Call graph*: calls 2 internal fn (usable_content_width_u16, new); called by 2 (display_lines, transcript_lines); 3 external calls (as_path, default, new).


##### `ReasoningSummaryCell::display_lines`  (lines 248–254)

```
fn display_lines(&self, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Returns the reasoning summary lines for the visible terminal history, unless this cell is marked transcript-only. Transcript-only summaries stay hidden from the normal chat view.

**Data flow**: It checks the transcript_only flag. If true, it returns no lines; otherwise it asks ReasoningSummaryCell::lines to format the content for the current width and returns those lines.

**Call relations**: The history renderer calls this for visible output. It delegates actual formatting to ReasoningSummaryCell::lines so the display path does not duplicate markdown and wrapping logic.

*Call graph*: calls 1 internal fn (lines); 1 external calls (new).


##### `ReasoningSummaryCell::transcript_lines`  (lines 256–258)

```
fn transcript_lines(&self, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Returns formatted reasoning summary lines for transcript output. Unlike display_lines, it includes transcript-only summaries.

**Data flow**: It receives the width, passes it to ReasoningSummaryCell::lines, and returns the wrapped, styled summary lines.

**Call relations**: Transcript rendering calls this when it wants the reasoning summary text even if the normal screen view hid it. It shares formatting with display_lines through ReasoningSummaryCell::lines.

*Call graph*: calls 1 internal fn (lines).


##### `ReasoningSummaryCell::raw_lines`  (lines 260–266)

```
fn raw_lines(&self) -> Vec<Line<'static>>
```

**Purpose**: Returns the reasoning summary as plain source lines when it should be visible outside transcripts. If the cell is transcript-only, it returns nothing here.

**Data flow**: It checks the transcript_only flag. If the summary is normal, it trims the content and splits it into raw lines; if it is transcript-only, it returns an empty list.

**Call relations**: The history system can call this when it needs undecorated reasoning text. The transcript-only check keeps hidden reasoning summaries from leaking through this raw display path.

*Call graph*: 1 external calls (new).


##### `AgentMessageCell::new`  (lines 277–282)

```
fn new(lines: Vec<Line<'static>>, is_first_line: bool) -> Self
```

**Purpose**: Creates an assistant message cell from ordinary terminal lines, mainly for tests. It converts those plain lines into the hyperlink-aware line format used by the normal rendering path.

**Data flow**: It receives terminal lines and a flag saying whether this is the first line of an assistant response. It wraps the lines in the internal hyperlink-line structure and returns an AgentMessageCell.

**Call relations**: Several tests use this constructor to build assistant message cells without needing real hyperlinks. Runtime code normally uses AgentMessageCell::new_hyperlink_lines instead.

*Call graph*: called by 4 (consolidation_walker_replaces_agent_message_cells, empty_agent_message_cell_transcript, streamed_agent_list_paragraph_preserves_item_indent_when_wrapped, wrapped_and_prefixed_cells_handle_tiny_widths).


##### `AgentMessageCell::new_hyperlink_lines`  (lines 284–289)

```
fn new_hyperlink_lines(lines: Vec<HyperlinkLine>, is_first_line: bool) -> Self
```

**Purpose**: Creates an assistant message cell from lines that may already contain terminal hyperlinks. This is the normal constructor for assistant output emitted by the streaming/rendering pipeline.

**Data flow**: It receives hyperlink-capable lines and a flag saying whether this cell starts the assistant message. It stores both pieces of information and returns the cell.

**Call relations**: The emit flow calls this when assistant output is ready to enter history. Later, display methods use the saved first-line flag to decide whether to show the assistant bullet or continuation indentation.

*Call graph*: called by 1 (emit).


##### `AgentMessageCell::display_lines`  (lines 293–295)

```
fn display_lines(&self, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Returns the visible terminal lines for an assistant message cell. It hides hyperlink metadata and keeps only the text and styling needed for drawing.

**Data flow**: It receives the terminal width, asks AgentMessageCell::display_hyperlink_lines to wrap and prefix the message, then converts those hyperlink-aware lines into ordinary visible lines.

**Call relations**: The history renderer calls this when it only needs drawable lines. It relies on display_hyperlink_lines for the real layout work.

*Call graph*: calls 1 internal fn (display_hyperlink_lines).


##### `AgentMessageCell::display_hyperlink_lines`  (lines 297–317)

```
fn display_hyperlink_lines(&self, width: u16) -> Vec<HyperlinkLine>
```

**Purpose**: Wraps assistant message lines for the current terminal width while preserving clickable link information. It also adds the assistant bullet or continuation indentation.

**Data flow**: It reads each stored hyperlink line and its position in the cell. For the first line of a fresh assistant message, it uses a bullet indent; otherwise it uses continuation spacing. It also carries over leading whitespace after wraps, then returns the wrapped hyperlink-aware lines.

**Call relations**: AgentMessageCell::display_lines and AgentMessageCell::transcript_hyperlink_lines both call this. It hands each line to the terminal hyperlink wrapping helper so links survive wrapping.

*Call graph*: calls 3 internal fn (leading_whitespace_prefix, adaptive_wrap_hyperlink_lines, new); called by 2 (display_lines, transcript_hyperlink_lines); 3 external calls (from, new, from_ref).


##### `AgentMessageCell::transcript_hyperlink_lines`  (lines 319–321)

```
fn transcript_hyperlink_lines(&self, width: u16) -> Vec<HyperlinkLine>
```

**Purpose**: Returns assistant message lines for transcript output while preserving hyperlink information. It uses the same wrapping as the visible display.

**Data flow**: It receives the width, calls AgentMessageCell::display_hyperlink_lines, and returns those hyperlink-aware wrapped lines.

**Call relations**: Transcript rendering calls this when it needs assistant output with links intact. It shares the display path so transcript and screen layout match.

*Call graph*: calls 1 internal fn (display_hyperlink_lines).


##### `AgentMessageCell::raw_lines`  (lines 323–325)

```
fn raw_lines(&self) -> Vec<Line<'static>>
```

**Purpose**: Returns the assistant message as plain visible lines, without hyperlink metadata. This is the raw text form of this already-rendered assistant cell.

**Data flow**: It clones the stored hyperlink lines, strips them down to visible lines, then converts those into plain lines and returns them.

**Call relations**: The history system can call this when it needs assistant text without bullets, wrapping metadata, or clickable-link tracking.


##### `AgentMessageCell::is_stream_continuation`  (lines 327–329)

```
fn is_stream_continuation(&self) -> bool
```

**Purpose**: Tells whether this assistant cell is a continuation of an earlier streaming message rather than the first visible part. This helps the UI choose the right indentation.

**Data flow**: It reads the is_first_line flag. If this cell is not the first line, it returns true; otherwise it returns false.

**Call relations**: The broader history and streaming code can use this to understand how a sequence of assistant cells fits together visually.


##### `AgentMarkdownCell::new`  (lines 355–360)

```
fn new(markdown_source: String, cwd: &Path) -> Self
```

**Purpose**: Creates a finalized assistant message cell backed by the original markdown source. Keeping the source lets the message be re-rendered correctly after terminal resizes.

**Data flow**: It receives raw markdown text and the working directory active when the message was produced. It stores the markdown and copies the directory path into the cell, then returns the new AgentMarkdownCell.

**Call relations**: After streaming finishes, handle_consolidate_agent_message replaces multiple temporary assistant cells with this source-backed cell. Tests also construct it to check that resizing and markdown rendering behave correctly.

*Call graph*: called by 10 (handle_consolidate_agent_message, agent_markdown_cell_does_not_split_words_after_inline_markdown, agent_markdown_cell_narrow_width_shows_prefix_only, agent_markdown_cell_renders_source_at_different_widths, agent_markdown_cell_survives_insert_history_rewrap, consolidation_walker_replaces_agent_message_cells, source_backed_cells_render_raw_source_without_prefix_or_style, wrapped_and_prefixed_cells_handle_tiny_widths, transcript_overlay_live_tail_preserves_semantic_web_links, thread_to_transcript_cells); 1 external calls (to_path_buf).


##### `AgentMarkdownCell::display_lines`  (lines 364–366)

```
fn display_lines(&self, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Returns the visible terminal lines for a finalized markdown assistant message. It converts hyperlink-aware rendering into ordinary drawable lines.

**Data flow**: It receives the terminal width, calls AgentMarkdownCell::display_hyperlink_lines to re-render the markdown for that width, removes hyperlink metadata from the result, and returns visible lines.

**Call relations**: The history renderer calls this when drawing finalized assistant messages. The heavy work is delegated to display_hyperlink_lines.

*Call graph*: calls 1 internal fn (display_hyperlink_lines).


##### `AgentMarkdownCell::display_hyperlink_lines`  (lines 368–387)

```
fn display_hyperlink_lines(&self, width: u16) -> Vec<HyperlinkLine>
```

**Purpose**: Re-renders a finalized assistant markdown message for the current terminal width, including local file links. This is what lets old assistant replies adapt cleanly when the terminal is resized.

**Data flow**: It receives the width and calculates how much space remains after the assistant prefix. If there is usable space, it renders the stored markdown source with links resolved against the saved working directory, prefixes the result with a bullet and indentation, and returns hyperlink-aware lines. If the width is too tiny, it returns a minimal prefixed blank line instead of failing.

**Call relations**: AgentMarkdownCell::display_lines and AgentMarkdownCell::transcript_hyperlink_lines call this. It hands markdown rendering to the markdown module and then applies history-style prefixes.

*Call graph*: calls 2 internal fn (render_markdown_agent_with_links_and_cwd, usable_content_width_u16); called by 2 (display_lines, transcript_hyperlink_lines); 2 external calls (as_path, vec!).


##### `AgentMarkdownCell::transcript_hyperlink_lines`  (lines 389–391)

```
fn transcript_hyperlink_lines(&self, width: u16) -> Vec<HyperlinkLine>
```

**Purpose**: Returns finalized assistant markdown for transcript output while keeping hyperlink information. It uses the same rendering path as the visible display.

**Data flow**: It receives the width, calls AgentMarkdownCell::display_hyperlink_lines, and returns the re-rendered hyperlink-aware lines.

**Call relations**: Transcript rendering calls this for finalized assistant replies. Sharing the display path keeps transcript and screen formatting consistent.

*Call graph*: calls 1 internal fn (display_hyperlink_lines).


##### `AgentMarkdownCell::raw_lines`  (lines 393–395)

```
fn raw_lines(&self) -> Vec<Line<'static>>
```

**Purpose**: Returns the original assistant markdown as plain source lines. This avoids confusing already-rendered terminal wrapping with the true message content.

**Data flow**: It reads the stored markdown source, splits it into raw lines, and returns those lines without display prefixes or styling.

**Call relations**: The history system uses this when it needs the assistant’s source text rather than the current terminal layout.


##### `StreamingAgentTailCell::new`  (lines 410–415)

```
fn new(lines: Vec<HyperlinkLine>, is_first_line: bool) -> Self
```

**Purpose**: Creates the temporary cell used for the still-changing tail of a streaming assistant response. This tail may include unfinished structures like markdown tables.

**Data flow**: It receives already-rendered hyperlink lines and a flag saying whether this tail starts the assistant message. It stores them and returns a StreamingAgentTailCell.

**Call relations**: sync_active_stream_tail calls this while assistant output is arriving. The cell is replaced on later stream updates and removed when the response is finalized.

*Call graph*: called by 2 (sync_active_stream_tail, streaming_agent_tail_blank_line_uses_one_viewport_row).


##### `StreamingAgentTailCell::display_lines`  (lines 419–421)

```
fn display_lines(&self, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Returns visible terminal lines for the live streaming assistant tail. It strips hyperlink metadata after the tail has been prefixed.

**Data flow**: It receives a width value, passes it to StreamingAgentTailCell::display_hyperlink_lines, converts the hyperlink-aware lines into ordinary visible lines, and returns them.

**Call relations**: The live display path calls this for the active streaming cell. StreamingAgentTailCell::raw_lines also uses it with a very large width to get a plain version.

*Call graph*: calls 1 internal fn (display_hyperlink_lines); called by 1 (raw_lines).


##### `StreamingAgentTailCell::display_hyperlink_lines`  (lines 423–447)

```
fn display_hyperlink_lines(&self, _width: u16) -> Vec<HyperlinkLine>
```

**Purpose**: Formats the live streaming tail without rewrapping it. This avoids breaking in-progress tables or other markdown shapes that the stream controller has already laid out.

**Data flow**: It ignores the width, clones the stored rendered lines, adds either a bullet or continuation prefix, and then cleans up lines that contain only whitespace so they occupy one simple blank row with no stale hyperlinks.

**Call relations**: StreamingAgentTailCell::display_lines and StreamingAgentTailCell::transcript_hyperlink_lines call this. Unlike finalized markdown cells, it deliberately does not call a wrapping renderer because the stream tail is temporary and already width-specific.

*Call graph*: called by 2 (display_lines, transcript_hyperlink_lines); 1 external calls (default).


##### `StreamingAgentTailCell::transcript_hyperlink_lines`  (lines 449–451)

```
fn transcript_hyperlink_lines(&self, width: u16) -> Vec<HyperlinkLine>
```

**Purpose**: Returns the live streaming tail in hyperlink-aware form for transcript-like consumers. It uses the same no-rewrap formatting as the visible display.

**Data flow**: It receives a width, passes it to StreamingAgentTailCell::display_hyperlink_lines, and returns the prefixed hyperlink-aware tail lines.

**Call relations**: Transcript or history code can call this while a response is still streaming. It shares display_hyperlink_lines so the live tail looks the same everywhere.

*Call graph*: calls 1 internal fn (display_hyperlink_lines).


##### `StreamingAgentTailCell::raw_lines`  (lines 453–455)

```
fn raw_lines(&self) -> Vec<Line<'static>>
```

**Purpose**: Returns a plain-line version of the current streaming tail. It is mainly a simple fallback view of content that is normally shown live.

**Data flow**: It calls StreamingAgentTailCell::display_lines with the widest possible width, then converts those visible lines into plain lines and returns them.

**Call relations**: The history system can call this when it needs raw text for the active streaming cell. It depends on display_lines, which in turn uses the no-rewrap streaming-tail formatter.

*Call graph*: calls 1 internal fn (display_lines).


##### `StreamingAgentTailCell::is_stream_continuation`  (lines 457–459)

```
fn is_stream_continuation(&self) -> bool
```

**Purpose**: Tells whether the live streaming tail continues an assistant message that already began earlier. This controls whether the UI shows a bullet or just continuation spacing.

**Data flow**: It reads the is_first_line flag. If the tail is not the first line, it returns true; otherwise it returns false.

**Call relations**: The streaming/history code can use this to keep indentation consistent across chunks of one assistant response.


##### `new_user_prompt`  (lines 461–473)

```
fn new_user_prompt(
    message: String,
    text_elements: Vec<TextElement>,
    local_image_paths: Vec<PathBuf>,
    remote_image_urls: Vec<String>,
) -> UserHistoryCell
```

**Purpose**: Creates a user-message history cell from the text and any attached images. It is the simple construction point for adding a user prompt to history.

**Data flow**: It receives the message text, highlighted text elements, local image paths, and remote image URLs. It stores them directly in a UserHistoryCell and returns it.

**Call relations**: Code that records a user turn calls this before the history renderer later asks the resulting cell for display or raw lines.


##### `new_reasoning_summary_block`  (lines 478–510)

```
fn new_reasoning_summary_block(
    full_reasoning_buffer: String,
    cwd: &Path,
) -> Box<dyn HistoryCell>
```

**Purpose**: Creates the history cell used after a reasoning block finishes. It tries to split a bold header from the rest of the reasoning summary and decides whether the result should be visible or transcript-only.

**Data flow**: It receives the full reasoning text and current working directory. It trims the text, looks for a bold markdown header marked with double asterisks, and if there is content after that header, creates a visible ReasoningSummaryCell with separate header and summary text. If no real summary follows, it creates a transcript-only ReasoningSummaryCell containing the whole buffer.

**Call relations**: The reasoning flow calls this at the end of a reasoning block. It delegates cell creation to ReasoningSummaryCell::new and preserves the current directory so file links in old reasoning text still resolve as they did when written.

*Call graph*: calls 1 internal fn (new); 2 external calls (new, to_path_buf).


### `tui/src/history_cell/plans.rs`

`domain_logic` · `conversation rendering and live streaming`

This file is part of the terminal user interface, where each message in the conversation history is represented as a “history cell.” Here, the cells are all about plans: a plan the assistant proposes, a plan that is still arriving live, and an update to an existing plan. Without this file, plan messages would either not appear in the history or would lose important formatting such as headings, indentation, checkboxes, wrapping, and clickable links.

There are two kinds of proposed-plan cells. `ProposedPlanCell` keeps the original markdown text and the working folder it came from, so it can re-render itself later if the terminal width changes. That matters because text wrapping and local file links depend on the current width and folder. `ProposedPlanStreamCell` and `StreamingPlanTailCell` are more temporary: they store lines that have already been rendered while text is still streaming in. They are like a live preview, not the permanent source copy.

`PlanUpdateCell` renders an updated plan as a friendly checklist. Completed items get a checked mark and dim crossed-out styling, the current item is highlighted, and pending items are muted. Optional explanatory text is shown above the steps. The file also provides small constructor functions that package incoming plan data into the right cell type.

#### Function details

##### `StreamingPlanTailCell::new`  (lines 17–22)

```
fn new(lines: Vec<HyperlinkLine>, is_stream_continuation: bool) -> Self
```

**Purpose**: Creates a temporary cell for the changing tail end of a proposed plan while it is still streaming. This lets the interface show the latest partial plan without treating it as finalized history.

**Data flow**: It receives already prepared display lines and a true-or-false flag saying whether this tail continues a previous stream. It stores both values in a new `StreamingPlanTailCell`. The result is a cell that can be shown immediately in the terminal.

**Call relations**: The active stream controller calls this through `sync_active_stream_tail` when it needs to refresh the live plan preview. Later, the cell’s display methods are used by the history rendering system to show those prepared lines.

*Call graph*: called by 1 (sync_active_stream_tail).


##### `StreamingPlanTailCell::display_lines`  (lines 26–28)

```
fn display_lines(&self, _width: u16) -> Vec<Line<'static>>
```

**Purpose**: Returns the visible terminal lines for the live streaming plan tail. It is used when the interface needs ordinary display text rather than link-aware line objects.

**Data flow**: It ignores the width because the lines were already formatted before the cell was created. It clones the stored hyperlink-capable lines, strips them down to visible terminal lines, and returns those lines without changing the cell.

**Call relations**: The general history display code calls this when drawing the active stream tail. It relies on the controller having already prepared the lines with the correct look.


##### `StreamingPlanTailCell::display_hyperlink_lines`  (lines 30–32)

```
fn display_hyperlink_lines(&self, _width: u16) -> Vec<HyperlinkLine>
```

**Purpose**: Returns the stored live-stream lines with their hyperlink information preserved. This is useful when the terminal can display or export clickable links.

**Data flow**: It receives a width value but does not use it, because the content is already rendered. It clones the stored `HyperlinkLine` values and returns them exactly as the cell has them.

**Call relations**: The transcript method calls this when it needs the same link-aware lines for saved or copied output. Display code may also use it directly when links should be preserved.

*Call graph*: called by 1 (transcript_hyperlink_lines).


##### `StreamingPlanTailCell::transcript_hyperlink_lines`  (lines 34–36)

```
fn transcript_hyperlink_lines(&self, width: u16) -> Vec<HyperlinkLine>
```

**Purpose**: Provides the transcript version of the streaming tail while keeping hyperlinks intact. For this temporary cell, the transcript view is the same as the display view.

**Data flow**: It receives the requested width, passes that width to `display_hyperlink_lines`, and returns whatever that method returns. Nothing is changed inside the cell.

**Call relations**: When transcript output asks this cell for link-aware lines, this method simply delegates to `display_hyperlink_lines` so there is only one source of truth for the rendered content.

*Call graph*: calls 1 internal fn (display_hyperlink_lines).


##### `StreamingPlanTailCell::raw_lines`  (lines 38–40)

```
fn raw_lines(&self) -> Vec<Line<'static>>
```

**Purpose**: Returns a plain-text version of the streaming tail. This is useful for contexts that should not include terminal styling or hyperlink metadata.

**Data flow**: It clones the stored hyperlink lines, converts them into visible lines, then converts those into plain lines. The output is a simple text-like version of the same preview content.

**Call relations**: The history system can call this when it needs unstyled text, such as for logs, copying, or fallback displays. It does not call other cell methods; it directly converts the stored lines.


##### `StreamingPlanTailCell::is_stream_continuation`  (lines 42–44)

```
fn is_stream_continuation(&self) -> bool
```

**Purpose**: Reports whether this streaming tail continues a previous streamed chunk. The renderer can use this to avoid treating every chunk like a brand-new message.

**Data flow**: It reads the stored boolean flag and returns it. No formatting is done and no state changes.

**Call relations**: The broader history rendering flow can ask this when deciding how to visually join or separate streamed plan fragments.


##### `new_plan_update`  (lines 47–50)

```
fn new_plan_update(update: UpdatePlanArgs) -> PlanUpdateCell
```

**Purpose**: Builds a `PlanUpdateCell` from incoming plan-update data. It is the simple entry point for turning an update message into something the history UI can render.

**Data flow**: It receives an `UpdatePlanArgs` value containing an optional explanation and a list of plan steps. It unpacks those fields and stores them in a new `PlanUpdateCell`, which is returned to the caller.

**Call relations**: Code that receives or prepares plan updates calls this before adding the update to the history. The returned cell later uses `PlanUpdateCell::display_lines` or `PlanUpdateCell::raw_lines` depending on whether styled or plain output is needed.


##### `new_proposed_plan`  (lines 57–62)

```
fn new_proposed_plan(plan_markdown: String, cwd: &Path) -> ProposedPlanCell
```

**Purpose**: Creates a finalized proposed-plan cell from raw markdown text. This is the durable version used after streaming is complete, because it can re-render the plan later at a different terminal width.

**Data flow**: It receives the plan as markdown text and the current working folder path. It stores the markdown and copies the folder path into the cell. The returned `ProposedPlanCell` can later render links and wrapping using that saved context.

**Call relations**: Callers use this when a proposed plan is complete and should become real history. It calls the path-copying helper `to_path_buf` so the cell owns its folder path instead of borrowing it.

*Call graph*: 1 external calls (to_path_buf).


##### `new_proposed_plan_stream`  (lines 68–76)

```
fn new_proposed_plan_stream(
    lines: Vec<impl Into<HyperlinkLine>>,
    is_stream_continuation: bool,
) -> ProposedPlanStreamCell
```

**Purpose**: Creates a temporary proposed-plan cell from lines that have already been rendered during live streaming. This lets the interface show partial plan content immediately.

**Data flow**: It receives a list of line-like values and a flag saying whether the stream continues earlier content. It converts each line into a `HyperlinkLine`, stores the list and flag, and returns a `ProposedPlanStreamCell`.

**Call relations**: Streaming code uses this while a plan is still arriving. Once the plan is complete, the stream cell is expected to be replaced by `ProposedPlanCell`, which keeps the original markdown for future reflow.


##### `ProposedPlanCell::display_lines`  (lines 101–103)

```
fn display_lines(&self, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Returns the finalized proposed plan as ordinary visible terminal lines. It is used when the terminal renderer does not need to keep hyperlink metadata separate.

**Data flow**: It receives the current terminal width, asks `display_hyperlink_lines` to render the plan with links and formatting, then converts those link-aware lines into normal visible lines. The cell itself is not changed.

**Call relations**: The history display system calls this when drawing a finalized proposed plan. It delegates the real rendering work to `display_hyperlink_lines` so display and transcript output stay consistent.

*Call graph*: calls 1 internal fn (display_hyperlink_lines).


##### `ProposedPlanCell::display_hyperlink_lines`  (lines 105–127)

```
fn display_hyperlink_lines(&self, width: u16) -> Vec<HyperlinkLine>
```

**Purpose**: Renders a finalized proposed plan into styled, link-aware terminal lines. This is the main rendering routine for completed proposed plans.

**Data flow**: It receives the current terminal width, starts with a “Proposed Plan” heading, calculates a safe wrap width, and renders the stored markdown using the saved working folder so local links can be displayed correctly. If the markdown produces no body, it inserts a dim “(empty)” placeholder. It then indents and styles the body before returning the full list of lines.

**Call relations**: `ProposedPlanCell::display_lines` and `ProposedPlanCell::transcript_hyperlink_lines` both call this so the same rendering is used on screen and in transcripts. It hands the markdown work to `render_markdown_agent_with_links_and_cwd`, which understands markdown and file links.

*Call graph*: calls 2 internal fn (render_markdown_agent_with_links_and_cwd, new); called by 2 (display_lines, transcript_hyperlink_lines); 3 external calls (from, as_path, vec!).


##### `ProposedPlanCell::transcript_hyperlink_lines`  (lines 129–131)

```
fn transcript_hyperlink_lines(&self, width: u16) -> Vec<HyperlinkLine>
```

**Purpose**: Returns the finalized proposed plan for transcript output while preserving hyperlinks. For this cell, transcript rendering matches normal link-aware display rendering.

**Data flow**: It receives a width, passes that width to `display_hyperlink_lines`, and returns the rendered lines. It does not alter the stored markdown or folder path.

**Call relations**: Transcript generation calls this when it wants a saved or copied version of the plan with links intact. It reuses `display_hyperlink_lines` rather than duplicating the markdown rendering rules.

*Call graph*: calls 1 internal fn (display_hyperlink_lines).


##### `ProposedPlanCell::raw_lines`  (lines 133–135)

```
fn raw_lines(&self) -> Vec<Line<'static>>
```

**Purpose**: Returns a plain version of the finalized proposed plan based on the original markdown. This is useful when formatting and terminal styling should be removed.

**Data flow**: It reads the stored markdown and converts the source text into plain raw lines. The result reflects the underlying plan content rather than the styled terminal layout.

**Call relations**: The history system can call this for plain-text export, logging, or copying. Unlike the display methods, it does not re-render markdown for terminal presentation.


##### `ProposedPlanStreamCell::display_lines`  (lines 139–141)

```
fn display_lines(&self, _width: u16) -> Vec<Line<'static>>
```

**Purpose**: Returns ordinary visible lines for a proposed plan that is still streaming. The content is already formatted, so this method only converts it for display.

**Data flow**: It ignores the width, clones the stored hyperlink-capable lines, converts them into visible terminal lines, and returns them. The stream cell remains unchanged.

**Call relations**: The renderer calls this for temporary stream fragments. It depends on upstream streaming code to have already prepared the lines at the right width.


##### `ProposedPlanStreamCell::display_hyperlink_lines`  (lines 143–145)

```
fn display_hyperlink_lines(&self, _width: u16) -> Vec<HyperlinkLine>
```

**Purpose**: Returns the already rendered streaming plan lines with hyperlink information preserved. This is the link-aware display path for temporary proposed-plan fragments.

**Data flow**: It receives but ignores the width because the lines cannot be reflowed from source markdown. It clones and returns the stored `HyperlinkLine` list.

**Call relations**: `ProposedPlanStreamCell::transcript_hyperlink_lines` calls this to reuse the same stored stream content. The cell is meant to be temporary until replaced by a source-backed `ProposedPlanCell`.

*Call graph*: called by 1 (transcript_hyperlink_lines).


##### `ProposedPlanStreamCell::transcript_hyperlink_lines`  (lines 147–149)

```
fn transcript_hyperlink_lines(&self, width: u16) -> Vec<HyperlinkLine>
```

**Purpose**: Provides transcript lines for a streaming proposed-plan fragment, preserving any links already present. Since this is temporary rendered content, transcript output is the same as display output.

**Data flow**: It takes a width, passes it to `display_hyperlink_lines`, and returns the cloned stored lines. No source markdown is available or re-rendered.

**Call relations**: Transcript-related code calls this if a stream fragment is still present. It delegates to `display_hyperlink_lines`; finalized history should normally use `ProposedPlanCell` instead.

*Call graph*: calls 1 internal fn (display_hyperlink_lines).


##### `ProposedPlanStreamCell::raw_lines`  (lines 151–153)

```
fn raw_lines(&self) -> Vec<Line<'static>>
```

**Purpose**: Returns a plain-text version of the temporary streaming plan fragment. This removes styling and hyperlink metadata from the already rendered lines.

**Data flow**: It clones the stored hyperlink lines, converts them to visible lines, then converts those to plain lines. The output is an unstyled snapshot of the stream fragment.

**Call relations**: Plain-text consumers of history can call this while stream cells still exist. Because the stream cell does not store markdown source, this method works from the rendered lines it has.


##### `ProposedPlanStreamCell::is_stream_continuation`  (lines 155–157)

```
fn is_stream_continuation(&self) -> bool
```

**Purpose**: Reports whether this proposed-plan stream cell is a continuation of earlier streamed content. This helps the UI keep streamed chunks visually connected.

**Data flow**: It reads the stored continuation flag and returns it as-is. It does not inspect or change the lines.

**Call relations**: The history renderer can ask this when deciding whether a streamed cell should look like a continuation instead of a separate new block.


##### `PlanUpdateCell::display_lines`  (lines 167–217)

```
fn display_lines(&self, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Renders a plan update as a styled checklist for the terminal. It makes the update easy to scan by showing a heading, optional note, and steps with status-specific symbols and styling.

**Data flow**: It receives the terminal width, uses that to wrap long text, and starts with an “Updated Plan” heading. If there is a non-empty explanation, it renders it as dim italic text. If there are no steps, it shows “(no steps provided)”; otherwise it renders each step with a checked or empty box and styling based on whether the step is completed, in progress, or pending. It indents the whole body and returns the finished terminal lines.

**Call relations**: The history display system calls this when it needs to draw a plan update. Inside the method, small local rendering helpers prepare notes and steps, and shared wrapping/prefix helpers keep the output aligned with the rest of the terminal UI.

*Call graph*: 2 external calls (from, vec!).


##### `PlanUpdateCell::raw_lines`  (lines 219–237)

```
fn raw_lines(&self) -> Vec<Line<'static>>
```

**Purpose**: Produces a plain-text version of a plan update. This keeps the important information while removing terminal styling such as bold, dim text, and checkbox colors.

**Data flow**: It starts with the text “Updated Plan.” If a trimmed explanation exists, it converts that explanation into raw lines and appends them. If the plan has no steps, it adds “(no steps provided)”; otherwise it adds one line per step in the form of its status plus the step text. The returned lines are simple and unstyled.

**Call relations**: Plain-text export, copying, or logging can call this instead of the styled display method. It uses basic string formatting for each step rather than the visual checklist symbols used on screen.

*Call graph*: 3 external calls (from, format!, vec!).


### `tui/src/history_cell/approvals.rs`

`domain_logic` · `request handling`

Codex sometimes needs permission before doing something risky, such as running a command, changing policy, applying a patch, or using the network. This file is the part of the terminal interface that records what happened in that approval flow. Without it, the user could still approve or deny actions, but the transcript would not clearly show what was approved, denied, canceled, or timed out.

The file works like a label maker for approval events. It receives the subject of the request, such as a command or a network target, plus the final decision. It then chooses a symbol, color, and sentence. A green checkmark means something was allowed or saved. A red cross means something was denied, canceled, or timed out. Command text is shortened before display so a long shell command does not take over the screen.

The main function, `new_approval_decision_cell`, covers the many possible outcomes: one-time approval, approval for the whole session, saved policy changes, denial, timeout, or abort. Smaller helper functions create similar transcript lines for guardian review of patch and action requests. A guardian here is an automatic reviewer, not the human user. The file also has a simple status-line builder for showing review progress in cyan while a decision is still pending.

#### Function details

##### `truncate_exec_snippet`  (lines 5–12)

```
fn truncate_exec_snippet(full_cmd: &str) -> String
```

**Purpose**: Makes a command safe and tidy for display in the transcript. It keeps only the first line, adds an ellipsis if there was more, and shortens the result so long commands do not crowd the terminal.

**Data flow**: It takes the full command as one string. If the command contains a newline, it keeps the first line and marks that more text existed; then it limits the visible text length. It returns the shortened display string and does not change anything else.

**Call relations**: This is the final cleanup step used by `exec_snippet`. Whenever a command needs to appear in an approval message, `exec_snippet` first prepares the command text and then asks this function to make it compact.

*Call graph*: called by 1 (exec_snippet); 1 external calls (format!).


##### `exec_snippet`  (lines 14–17)

```
fn exec_snippet(command: &[String]) -> String
```

**Purpose**: Turns a command stored as separate pieces into a short, readable command preview for the terminal. It also removes common wrapper noise so the user sees the meaningful command rather than shell bookkeeping.

**Data flow**: It receives a list of command arguments. It converts that list into a display string with shell wrapping stripped away, then sends that string to `truncate_exec_snippet`. It returns the cleaned and shortened command preview.

**Call relations**: This helper feeds command previews into approval messages. `new_approval_decision_cell` uses it when it must always show a snippet, and `non_empty_exec_snippet` uses it when an empty preview should be treated as no preview at all.

*Call graph*: calls 1 internal fn (truncate_exec_snippet); called by 2 (new_approval_decision_cell, non_empty_exec_snippet).


##### `non_empty_exec_snippet`  (lines 19–22)

```
fn non_empty_exec_snippet(command: &[String]) -> Option<String>
```

**Purpose**: Builds a command preview only when there is something meaningful to show. This lets the transcript fall back to generic text like “this request” when the command preview would be blank.

**Data flow**: It receives the command argument list and passes it to `exec_snippet`. If the resulting string is not empty, it returns that string wrapped as an optional value; if it is empty, it returns no value.

**Call relations**: This function is used inside `new_approval_decision_cell` whenever the wording depends on whether a useful command snippet exists. It keeps the main message-building code from repeating the empty-check logic.

*Call graph*: calls 1 internal fn (exec_snippet); called by 1 (new_approval_decision_cell).


##### `new_approval_decision_cell`  (lines 45–264)

```
fn new_approval_decision_cell(
    subject: ApprovalDecisionSubject,
    decision: ReviewDecision,
    actor: ApprovalDecisionActor,
) -> Box<dyn HistoryCell>
```

**Purpose**: Creates the transcript cell for a finished approval decision. It explains, in one short line, who made the decision, what was being requested, and whether it was approved, denied, canceled, saved as policy, or timed out.

**Data flow**: It receives the request subject, the decision result, and the actor who made the decision. It chooses the right sentence parts, shortens command text when needed, colors important words, and picks either a green checkmark or red cross. It returns a boxed history cell ready for the terminal transcript.

**Call relations**: This is the central builder in the file. Higher-level approval flow code calls it when a command or network request has reached a final decision. While building the line, it calls `non_empty_exec_snippet` or `exec_snippet` to create readable command previews and uses `ApprovalDecisionActor::subject` to phrase the actor as “You” or “Auto-reviewer.”

*Call graph*: calls 3 internal fn (exec_snippet, non_empty_exec_snippet, new); 4 external calls (new, from, from, vec!).


##### `ApprovalDecisionActor::subject`  (lines 273–278)

```
fn subject(self) -> &'static str
```

**Purpose**: Provides the human-readable label for whoever made an approval decision. It makes messages say either “You” for the user or “Auto-reviewer” for the guardian.

**Data flow**: It receives an approval actor value. It matches that value to a fixed text label and returns the label as a string slice. It does not allocate new text or change state.

**Call relations**: Message builders call this when they need to start a sentence with the decision maker. `new_approval_decision_cell` uses it throughout so the same wording is used consistently.


##### `new_guardian_denied_patch_request`  (lines 281–301)

```
fn new_guardian_denied_patch_request(files: Vec<String>) -> Box<dyn HistoryCell>
```

**Purpose**: Creates a transcript message saying the automatic reviewer denied a patch request. It tells the user whether the patch touched one named file or multiple files.

**Data flow**: It receives a list of file names touched by the patch. If there is one file, it includes that file name; otherwise it includes the number of files. It returns a red-cross history cell describing the denial.

**Call relations**: This function is used when a guardian review blocks a proposed patch. It does not call the general approval-decision builder because patch requests have their own wording based on the affected files.

*Call graph*: calls 1 internal fn (new); 4 external calls (new, from, from, vec!).


##### `new_guardian_denied_action_request`  (lines 303–311)

```
fn new_guardian_denied_action_request(summary: String) -> Box<dyn HistoryCell>
```

**Purpose**: Creates a transcript message saying the automatic reviewer denied a named action. It is used for action requests that can be summarized in a short phrase.

**Data flow**: It receives a plain summary of the requested action. It builds a red-cross line saying the request was denied for that summary, with the summary visually dimmed. It returns the finished history cell.

**Call relations**: Higher-level guardian review code can call this when the denied item is not specifically a patch or command approval cell. It packages the denial into the same transcript style used elsewhere.

*Call graph*: calls 1 internal fn (new); 3 external calls (new, from, vec!).


##### `new_guardian_approved_action_request`  (lines 313–321)

```
fn new_guardian_approved_action_request(summary: String) -> Box<dyn HistoryCell>
```

**Purpose**: Creates a transcript message saying the automatic reviewer approved a named action. It gives the user a compact record of what was allowed.

**Data flow**: It receives a short action summary. It builds a green-check line saying the request was approved for that summary, with the summary visually dimmed. It returns the finished history cell.

**Call relations**: This is the approval counterpart to `new_guardian_denied_action_request`. Guardian review code calls it when an action is allowed and the terminal transcript needs a clear success entry.

*Call graph*: calls 1 internal fn (new); 3 external calls (new, from, vec!).


##### `new_guardian_timed_out_patch_request`  (lines 323–343)

```
fn new_guardian_timed_out_patch_request(files: Vec<String>) -> Box<dyn HistoryCell>
```

**Purpose**: Creates a transcript message saying review timed out before Codex could apply a patch. It explains the patch size in user-friendly terms: one named file or a count of files.

**Data flow**: It receives the list of files that the patch would have touched. It builds a red-cross line saying the review timed out before the patch could be applied, including either the file name or file count. It returns the completed history cell.

**Call relations**: This is used when the automatic review process does not answer in time for a patch request. It mirrors `new_guardian_denied_patch_request`, but the reason is timeout rather than denial.

*Call graph*: calls 1 internal fn (new); 4 external calls (new, from, from, vec!).


##### `new_guardian_timed_out_action_request`  (lines 345–353)

```
fn new_guardian_timed_out_action_request(summary: String) -> Box<dyn HistoryCell>
```

**Purpose**: Creates a transcript message saying review timed out before a named action could happen. It helps the user distinguish a timeout from an explicit denial.

**Data flow**: It receives a short summary of the action. It builds a red-cross line saying review timed out before that summary, with the summary dimmed. It returns the finished history cell.

**Call relations**: Guardian review code calls this when an action request expires without a decision. It provides the non-patch version of the timeout message built by `new_guardian_timed_out_patch_request`.

*Call graph*: calls 1 internal fn (new); 3 external calls (new, from, vec!).


##### `new_review_status_line`  (lines 356–360)

```
fn new_review_status_line(message: String) -> PlainHistoryCell
```

**Purpose**: Creates a simple cyan status line for an approval or review that is still in progress. It is used to show the current state before a final approve, deny, or timeout message is known.

**Data flow**: It receives a status message string. It colors that message cyan and stores it as the only line in a plain history cell. It returns that cell directly.

**Call relations**: This function is separate from the final decision builders because it is for live status, not completed outcomes. The review flow can call it while waiting, then later add one of the final decision cells from this file.

*Call graph*: 1 external calls (vec!).


### `tui/src/history_cell/exec.rs`

`domain_logic` · `history rendering and background-terminal status display`

A terminal app needs to remember what happened, not just what is happening now. This file provides two kinds of history cells for background terminals. One cell records a single interaction: either the user waited for a background terminal, or sent text to it. The other cell shows a compact “/ps”-style summary of background terminals that are currently running.

The code’s main job is presentation. It takes stored facts, such as a command name, standard input text, and recent output chunks, and turns them into styled lines for the terminal. “Styled” means things like bold, dim, italic, cyan, or magenta text. It also wraps long text to fit the available terminal width, much like a newspaper column wraps sentences so they do not run off the page.

There are two important views of the same information. `display_lines` produces the pretty version for the live terminal screen. `raw_lines` produces a plain-text version, useful when copying, exporting, or testing. The process summary is careful not to flood the screen: it shows at most 16 background terminals, shortens long commands, includes a few recent output snippets, and adds a note if more terminals are running.

#### Function details

##### `UnifiedExecInteractionCell::new`  (lines 12–17)

```
fn new(command_display: Option<String>, stdin: String) -> Self
```

**Purpose**: Creates a history cell for one background-terminal interaction. It stores the optional command label and the text that was sent to the terminal, if any.

**Data flow**: It receives an optional command display string and a standard-input string. It puts those two pieces of information into a new `UnifiedExecInteractionCell`. The result is a small record that can later be rendered for the user.

**Call relations**: The public helper `new_unified_exec_interaction` calls this when other code wants to add an interaction entry. Tests also call it directly to check details such as wrapping and height behavior.

*Call graph*: called by 3 (new_unified_exec_interaction, unified_exec_interaction_cell_does_not_split_url_like_stdin_token, unified_exec_interaction_cell_height_matches_wrapped_rendering).


##### `UnifiedExecInteractionCell::display_lines`  (lines 21–63)

```
fn display_lines(&self, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Builds the styled, on-screen version of a background-terminal interaction. It shows either that the app waited for the terminal, or that the user sent input to it.

**Data flow**: It receives the terminal width. If the width is zero, it returns no lines. Otherwise it builds a header, adds the command name when available, wraps that header to fit, and, if input text exists, wraps each input line underneath with an indented arrow. The output is a list of terminal UI lines ready to draw.

**Call relations**: This is the display side of the `HistoryCell` behavior for interaction entries. When the history view needs to paint this cell, this function turns the stored command and input text into visible lines. It uses standard constructors and vector-building helpers while relying on wrapping helpers from the surrounding module.

*Call graph*: calls 1 internal fn (new); 3 external calls (from, new, vec!).


##### `UnifiedExecInteractionCell::raw_lines`  (lines 65–95)

```
fn raw_lines(&self) -> Vec<Line<'static>>
```

**Purpose**: Builds a plain-text version of the same interaction, without terminal styling. This is useful for logs, copying, or any place where colored and bold text would be inappropriate.

**Data flow**: It reads the stored command display and input text. If there was no input, it returns one line saying the app waited, optionally naming the command. If there was input, it returns a heading line and then appends the raw input lines. The result is a list of unstyled text lines.

**Call relations**: This is the plain-output partner to `display_lines` for the `HistoryCell` implementation. Code that asks a history cell for raw text gets this simpler representation instead of the wrapped, styled terminal view.

*Call graph*: 3 external calls (from, new, format!).


##### `new_unified_exec_interaction`  (lines 98–103)

```
fn new_unified_exec_interaction(
    command_display: Option<String>,
    stdin: String,
) -> UnifiedExecInteractionCell
```

**Purpose**: Provides a small, convenient constructor for background-terminal interaction history entries. Other parts of the program can call this without directly naming the struct constructor.

**Data flow**: It receives the optional command label and the input text. It passes both values straight into `UnifiedExecInteractionCell::new`. The returned value is ready to be placed into the history list.

**Call relations**: This helper sits at the boundary between the rest of the TUI code and this file’s interaction-cell type. Its only handoff is to `UnifiedExecInteractionCell::new`, which does the actual object creation.

*Call graph*: calls 1 internal fn (new).


##### `UnifiedExecProcessesCell::new`  (lines 111–113)

```
fn new(processes: Vec<UnifiedExecProcessDetails>) -> Self
```

**Purpose**: Creates the summary cell that knows about currently running background terminals. It stores the list of process details that will later be shown to the user.

**Data flow**: It receives a list of `UnifiedExecProcessDetails`, each containing a command label and recent output snippets. It stores that list inside a `UnifiedExecProcessesCell`. The result is a renderable summary object.

**Call relations**: This constructor is used by `new_unified_exec_processes_output` when building the full `/ps` history output. It prepares the summary part of that combined history entry.

*Call graph*: called by 1 (new_unified_exec_processes_output).


##### `UnifiedExecProcessesCell::display_lines`  (lines 123–225)

```
fn display_lines(&self, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Builds the styled screen output for the background-terminal process summary. It shows a heading, then a compact list of running terminals and their recent output.

**Data flow**: It receives the terminal width and reads the stored process list. With no width, it returns no lines. With no processes, it returns a friendly “none running” message. Otherwise it shows up to 16 processes, shortens long commands and chunks to fit the width, adds an ellipsis-like suffix when text was cut, and reports how many extra processes were not shown. The output is a list of styled terminal lines.

**Call relations**: This is the main renderer for the process-summary cell. `raw_lines` calls it with a very large width to get a complete plain version, and `desired_height` calls it to find out how many screen rows the summary will occupy.

*Call graph*: called by 2 (desired_height, raw_lines); 5 external calls (from, width, new, format!, vec!).


##### `UnifiedExecProcessesCell::raw_lines`  (lines 227–229)

```
fn raw_lines(&self) -> Vec<Line<'static>>
```

**Purpose**: Produces a plain-text version of the running-process summary. It reuses the normal display layout, then strips styling away.

**Data flow**: It asks `display_lines` to render the summary using the largest practical width, so text is not unnecessarily narrowed. It then converts those styled lines into plain lines. The result is unstyled text suitable for copying, exporting, or comparison in tests.

**Call relations**: This function depends directly on `UnifiedExecProcessesCell::display_lines` instead of rebuilding the summary itself. That keeps the plain and styled versions consistent.

*Call graph*: calls 1 internal fn (display_lines).


##### `UnifiedExecProcessesCell::desired_height`  (lines 231–233)

```
fn desired_height(&self, width: u16) -> u16
```

**Purpose**: Tells the UI how many terminal rows the process summary wants to use at a given width. This helps layout code reserve the right amount of space.

**Data flow**: It receives a width, renders the process summary for that width through `display_lines`, counts the resulting lines, and returns that count as a height. It does not change the stored process data.

**Call relations**: This function is another small wrapper around `UnifiedExecProcessesCell::display_lines`. Instead of using the rendered lines for display, it uses them as a measurement tool for layout.

*Call graph*: calls 1 internal fn (display_lines).


##### `new_unified_exec_processes_output`  (lines 236–242)

```
fn new_unified_exec_processes_output(
    processes: Vec<UnifiedExecProcessDetails>,
) -> CompositeHistoryCell
```

**Purpose**: Builds the full history entry for the `/ps` background-terminal summary command. It combines the visible command `/ps` with the rendered process summary that follows it.

**Data flow**: It receives a list of process details. It creates a simple command cell showing `/ps`, creates a `UnifiedExecProcessesCell` from the process list, and then packages both cells into one composite history cell. The result can be inserted into the history as a single combined entry.

**Call relations**: This is the main outward-facing builder for the process-summary output. It calls the plain command-cell constructor, `UnifiedExecProcessesCell::new`, and the composite-cell constructor so the history view sees one entry made from two coordinated parts.

*Call graph*: calls 3 internal fn (new, new, new); 1 external calls (vec!).


### `tui/src/history_cell/mcp.rs`

`domain_logic` · `main loop and transcript rendering`

When Codex uses an MCP tool, the user needs to see what is happening: which server and tool were called, whether the call is still running, whether it succeeded, and what it returned. This file is the display layer for that story in the terminal transcript. It creates history cells, which are small renderable blocks in the chat history.

The main cell, `McpToolCallCell`, starts as an in-progress “Calling server.tool(args)” entry. While it is running, it can show an animated activity marker. When the tool finishes, the same cell records the duration and result, changes the marker to success or failure, and prints a short, wrapped version of the output. It understands MCP content blocks such as text, images, audio, embedded resources, and links. Images are mostly summarized as “image content,” but if a completed result contains a decodable image, this file can also create a small extra history cell saying an image output exists.

The file also builds the `/mcp` inventory display: a readable list of configured or server-reported MCP servers, their authentication state, tools, resources, and templates. Finally, it defines a temporary loading cell used while that inventory is being fetched. Without this file, MCP activity would still happen, but users would lose the clear transcript view that explains what tools ran and what came back.

#### Function details

##### `CompletedMcpToolCallWithImageOutput::display_lines`  (lines 10–12)

```
fn display_lines(&self, _width: u16) -> Vec<Line<'static>>
```

**Purpose**: Shows a simple visible message when an MCP tool returned an image. The actual image is kept in memory, but the transcript displays a short text label instead of trying to draw the image inline.

**Data flow**: It receives a terminal width, which it does not need for this fixed message. It returns one styled terminal line that says the tool result was image output, without changing the stored image.

**Call relations**: This cell is created after a tool call finishes if image decoding succeeds. The transcript renderer calls this method when it needs the normal on-screen version of that extra image-output entry.

*Call graph*: 1 external calls (vec!).


##### `CompletedMcpToolCallWithImageOutput::raw_lines`  (lines 14–16)

```
fn raw_lines(&self) -> Vec<Line<'static>>
```

**Purpose**: Provides the plain-text version of the image-output notice. This is useful for transcript text where terminal styling and wrapping are not needed.

**Data flow**: It reads no outside information and returns one raw line saying `tool result (image output)`. It does not change the cell.

**Call relations**: After `try_new_completed_mcp_tool_call_with_image_output` creates this image-output cell, transcript code can ask for raw lines through the shared history-cell interface.

*Call graph*: 1 external calls (vec!).


##### `mcp_auth_status_label`  (lines 18–25)

```
fn mcp_auth_status_label(status: McpAuthStatus) -> &'static str
```

**Purpose**: Turns an internal MCP authentication state into a human-readable label. It keeps the `/mcp` inventory display from showing raw enum-like values to the user.

**Data flow**: It receives one authentication status, such as unsupported, not logged in, bearer token, or OAuth. It returns the matching short label string.

**Call relations**: The inventory-rendering functions use this helper when listing each MCP server, so the auth section reads like normal text.


##### `McpToolCallCell::new`  (lines 44–57)

```
fn new(
        call_id: String,
        invocation: McpInvocation,
        animations_enabled: bool,
    ) -> Self
```

**Purpose**: Creates a new history cell for an MCP tool call that has just started. It records what is being called and starts the clock used for progress animation and elapsed time.

**Data flow**: It takes a call ID, the server/tool/arguments being invoked, and whether animations are allowed. It stores those values, records the current time, and leaves duration and result empty because the call has not finished yet.

**Call relations**: `new_active_mcp_tool_call` calls this constructor when the UI needs to add an active MCP tool-call entry to the transcript.

*Call graph*: called by 1 (new_active_mcp_tool_call); 1 external calls (now).


##### `McpToolCallCell::call_id`  (lines 59–61)

```
fn call_id(&self) -> &str
```

**Purpose**: Returns the unique ID for this MCP tool call. Other parts of the UI can use it to match a later completion or failure event to the correct visible history cell.

**Data flow**: It reads the stored call ID string and returns it as a borrowed value. Nothing is copied unnecessarily and the cell is not changed.

**Call relations**: This is a lookup helper for code that tracks active tool calls. It lets surrounding code identify which `McpToolCallCell` should be updated.


##### `McpToolCallCell::complete`  (lines 63–73)

```
fn complete(
        &mut self,
        duration: Duration,
        result: Result<codex_protocol::mcp::CallToolResult, String>,
    ) -> Option<Box<dyn HistoryCell>>
```

**Purpose**: Marks an MCP tool call as finished and stores its result. If the result contains a usable image, it also prepares a separate image-output history cell.

**Data flow**: It receives the call duration and either a successful MCP result or an error message. It checks the result for a decodable image, saves the duration and result into the cell, and returns an optional extra history cell for the first valid image found.

**Call relations**: When the MCP call completes, surrounding UI code updates the active `McpToolCallCell` through this method. Internally it hands the result to `try_new_completed_mcp_tool_call_with_image_output` to decide whether an image notice should be added.

*Call graph*: calls 1 internal fn (try_new_completed_mcp_tool_call_with_image_output).


##### `McpToolCallCell::success`  (lines 75–81)

```
fn success(&self) -> Option<bool>
```

**Purpose**: Answers the simple question: is this tool call successful, failed, or still unknown? This drives the visual state of the transcript entry.

**Data flow**: It reads the stored result. If there is no result yet, it returns no answer; if the call errored or the MCP result says it is an error, it returns false; otherwise it returns true.

**Call relations**: `display_lines` uses this to choose a green success marker, red failure marker, or in-progress activity marker. `raw_lines` uses it to decide whether to say `Calling` or `Called`.

*Call graph*: called by 2 (display_lines, raw_lines).


##### `McpToolCallCell::mark_failed`  (lines 83–87)

```
fn mark_failed(&mut self)
```

**Purpose**: Forces an in-progress MCP tool call into a failed state, usually because it was interrupted. This prevents the UI from leaving a call looking like it is still running forever.

**Data flow**: It measures how much time has passed since the call started, stores that as the duration, and stores an `interrupted` error result. The cell then renders as failed.

**Call relations**: Surrounding code can call this when a running tool call is cancelled or otherwise cannot complete normally. Afterward, the usual rendering methods show it like any other failed call.

*Call graph*: 1 external calls (elapsed).


##### `McpToolCallCell::render_content_block`  (lines 89–116)

```
fn render_content_block(block: &serde_json::Value, width: usize) -> String
```

**Purpose**: Turns one MCP result content block into a short string suitable for the terminal. It makes mixed tool output readable without exposing raw JSON unless the block cannot be understood.

**Data flow**: It receives a JSON value and a target width. It tries to parse the JSON as an MCP content block; text is formatted and truncated, images and audio become short placeholders, resources and links become readable references, and unparseable content falls back to a truncated JSON string.

**Call relations**: `display_lines` and `raw_lines` call this for each content block in a completed tool result. It is the small translator between MCP’s structured output and the human-facing transcript.

*Call graph*: 3 external calls (clone, to_string, format!).


##### `McpToolCallCell::display_lines`  (lines 120–213)

```
fn display_lines(&self, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Builds the styled, width-aware terminal view of an MCP tool-call entry. It shows the call header, progress or success/failure marker, and any returned output in a compact readable form.

**Data flow**: It reads the call’s invocation, start time, animation setting, and optional result. It chooses a marker, formats `server.tool(arguments)`, wraps long text to fit the terminal width, renders result blocks or errors, and returns a list of styled terminal lines.

**Call relations**: The transcript renderer calls this whenever it needs to draw the MCP call on screen. It relies on `success` to choose the state, `format_mcp_invocation` to make the call name readable, and `render_content_block` to summarize returned content.

*Call graph*: calls 4 internal fn (success, format_mcp_invocation, from_animations_enabled, new); 6 external calls (from, render_content_block, new, format!, clone, vec!).


##### `McpToolCallCell::raw_lines`  (lines 215–239)

```
fn raw_lines(&self) -> Vec<Line<'static>>
```

**Purpose**: Builds the plain-text transcript version of an MCP tool-call entry. This strips away terminal-specific layout choices while keeping the important content.

**Data flow**: It reads the invocation and optional result. It returns lines beginning with `Calling` or `Called`, then appends rendered result text or an error line if the call has finished.

**Call relations**: Code that needs a non-styled transcript calls this through the history-cell interface. It uses `success` for the header wording and `render_content_block` to turn structured MCP output into text.

*Call graph*: calls 1 internal fn (success); 4 external calls (from, render_content_block, format!, vec!).


##### `McpToolCallCell::transcript_animation_tick`  (lines 241–246)

```
fn transcript_animation_tick(&self) -> Option<u64>
```

**Purpose**: Tells the UI when an in-progress MCP call should animate. The returned number changes over time, giving the renderer a simple clock for spinner-like updates.

**Data flow**: It checks whether animations are enabled and whether the tool call is still unfinished. If so, it converts elapsed time into a tick number that advances every 50 milliseconds; otherwise it returns nothing.

**Call relations**: The transcript animation system asks active cells for ticks. Once `complete` or `mark_failed` stores a result, this method stops producing ticks.

*Call graph*: 1 external calls (elapsed).


##### `new_active_mcp_tool_call`  (lines 249–255)

```
fn new_active_mcp_tool_call(
    call_id: String,
    invocation: McpInvocation,
    animations_enabled: bool,
) -> McpToolCallCell
```

**Purpose**: Convenience function for creating a new active MCP tool-call cell. It gives callers a simple, named entry point instead of reaching directly into the struct constructor.

**Data flow**: It takes the call ID, invocation details, and animation preference, then passes them into `McpToolCallCell::new`. It returns the newly initialized cell.

**Call relations**: UI code uses this when adding a just-started MCP call to the active transcript area. It delegates the actual setup to `McpToolCallCell::new`.

*Call graph*: calls 1 internal fn (new).


##### `try_new_completed_mcp_tool_call_with_image_output`  (lines 268–279)

```
fn try_new_completed_mcp_tool_call_with_image_output(
    result: &Result<codex_protocol::mcp::CallToolResult, String>,
) -> Option<CompletedMcpToolCallWithImageOutput>
```

**Purpose**: Checks a completed MCP tool result for image output and creates an extra history cell if it finds one. It intentionally returns only the first valid image, keeping the transcript lightweight.

**Data flow**: It receives either a successful tool result or an error. If the result is successful, it scans the content blocks, asks `decode_mcp_image` to decode each possible image, and returns a new image-output cell for the first image that works; otherwise it returns nothing.

**Call relations**: `McpToolCallCell::complete` calls this right before saving the result. This is how image-producing tools get a separate visible affordance in the transcript.

*Call graph*: called by 1 (complete).


##### `decode_mcp_image`  (lines 285–317)

```
fn decode_mcp_image(block: &serde_json::Value) -> Option<DynamicImage>
```

**Purpose**: Attempts to turn one MCP image content block into an in-memory image. It is careful to return nothing for non-images or invalid image data rather than crashing the UI.

**Data flow**: It receives a JSON content block, parses it as MCP content, confirms it is an image, extracts base64 image data, decodes the bytes, guesses the image format, and asks the image library to decode it. On success it returns the image; on any failure it logs the problem and returns nothing.

**Call relations**: `try_new_completed_mcp_tool_call_with_image_output` uses this while scanning completed tool output. It is the safety gate between untrusted tool-provided image data and the UI’s image-output cell.

*Call graph*: calls 1 internal fn (new); 2 external calls (new, clone).


##### `empty_mcp_output`  (lines 319–339)

```
fn empty_mcp_output() -> PlainHistoryCell
```

**Purpose**: Creates the `/mcp` display shown when no MCP servers are configured. It gives the user a friendly explanation and points them to documentation.

**Data flow**: It builds a fixed set of styled terminal lines: the `/mcp` heading, `MCP Tools`, a note that no servers are configured, and a hyperlink to the MCP docs. It returns those lines inside a plain history cell.

**Call relations**: Command-handling code can use this when the user asks for MCP inventory but there is nothing configured to show.

*Call graph*: calls 1 internal fn (new); 1 external calls (vec!).


##### `new_mcp_tools_output`  (lines 343–513)

```
fn new_mcp_tools_output(
    config: &Config,
    tools: HashMap<String, codex_protocol::mcp::Tool>,
    resources: HashMap<String, Vec<Resource>>,
    resource_templates: HashMap<String, Vec<Resource
```

**Purpose**: Builds a detailed `/mcp` inventory display from local configuration and locally known tools. In this source it is compiled only for tests, where it helps verify the expected layout.

**Data flow**: It receives config, known tools, resources, resource templates, and authentication statuses. It sorts servers and tool names, writes each server’s enabled or disabled state, transport details, auth label, tools, resources, and templates into styled lines, then returns a plain history cell.

**Call relations**: This mirrors the user-facing MCP inventory layout used elsewhere, but with data from in-process config and maps. It calls `mcp_auth_status_label` so authentication states appear as readable text.

*Call graph*: 4 external calls (from, new, format!, vec!).


##### `new_mcp_tools_output_from_statuses`  (lines 524–616)

```
fn new_mcp_tools_output_from_statuses(
    statuses: &[McpServerStatus],
    detail: McpServerStatusDetail,
) -> PlainHistoryCell
```

**Purpose**: Builds the `/mcp` inventory display from server-reported MCP status records. This is the main path when the app server owns the current remote MCP state.

**Data flow**: It receives a list of server statuses and a detail level. It sorts servers by name, notes if no tools exist, then writes each server’s auth status and tool names; when full detail is requested, it also writes resources and resource templates. It returns all of this as a plain history cell.

**Call relations**: When an MCP inventory request returns status data, UI code uses this function to turn that response into transcript lines. It uses `mcp_auth_status_label` after converting the app-server authentication status into the local display form.

*Call graph*: 6 external calls (from, iter, sort_by, format!, matches!, vec!).


##### `McpInventoryLoadingCell::new`  (lines 631–636)

```
fn new(animations_enabled: bool) -> Self
```

**Purpose**: Creates a temporary history cell that says the MCP inventory is loading. It records the start time so the loading marker can animate if animations are enabled.

**Data flow**: It receives the animation preference, records the current time, stores both values, and returns the new loading cell.

**Call relations**: `new_mcp_inventory_loading` calls this constructor when the UI starts fetching MCP inventory.

*Call graph*: called by 1 (new_mcp_inventory_loading); 1 external calls (now).


##### `McpInventoryLoadingCell::display_lines`  (lines 640–655)

```
fn display_lines(&self, _width: u16) -> Vec<Line<'static>>
```

**Purpose**: Builds the styled on-screen line for the temporary MCP inventory loading state. It lets the user know the `/mcp` request is in progress.

**Data flow**: It reads the start time and animation setting. It chooses either an animated activity indicator or a static bullet, combines it with `Loading MCP inventory…`, and returns one styled terminal line.

**Call relations**: The transcript renderer calls this while the inventory request is still in flight. Once the request finishes, surrounding UI code removes this loading cell and replaces it with the real inventory output.

*Call graph*: 1 external calls (vec!).


##### `McpInventoryLoadingCell::raw_lines`  (lines 657–659)

```
fn raw_lines(&self) -> Vec<Line<'static>>
```

**Purpose**: Provides the plain-text version of the MCP inventory loading message. This keeps non-styled transcript output understandable.

**Data flow**: It returns one raw line, `Loading MCP inventory...`, and does not read or change any other state.

**Call relations**: Code that exports or inspects raw history can call this through the history-cell interface while the loading cell is active.

*Call graph*: 1 external calls (vec!).


##### `McpInventoryLoadingCell::transcript_animation_tick`  (lines 661–666)

```
fn transcript_animation_tick(&self) -> Option<u64>
```

**Purpose**: Supplies animation timing for the MCP inventory loading cell. It lets the UI refresh the loading marker at a steady pace.

**Data flow**: It checks whether animations are enabled. If they are, it converts elapsed time since creation into a tick number that advances every 50 milliseconds; if not, it returns nothing.

**Call relations**: The transcript animation loop calls this while the loading cell is active. It works the same way as the tool-call animation tick, but for inventory loading.

*Call graph*: 1 external calls (elapsed).


##### `new_mcp_inventory_loading`  (lines 670–672)

```
fn new_mcp_inventory_loading(animations_enabled: bool) -> McpInventoryLoadingCell
```

**Purpose**: Convenience function for making an MCP inventory loading cell. It gives callers a clear name for the loading-state object they want.

**Data flow**: It receives whether animations should be enabled and passes that value to `McpInventoryLoadingCell::new`. It returns the initialized loading cell.

**Call relations**: UI code calls this when starting an MCP inventory fetch. The actual field setup happens in `McpInventoryLoadingCell::new`.

*Call graph*: calls 1 internal fn (new).


##### `format_mcp_invocation`  (lines 673–692)

```
fn format_mcp_invocation(invocation: McpInvocation) -> Line<'a>
```

**Purpose**: Formats an MCP tool invocation as `server.tool(arguments)` for display. It keeps tool-call headers consistent across the transcript.

**Data flow**: It receives the server name, tool name, and optional JSON arguments. It converts the arguments to compact JSON text when present, styles the server and tool names, dims the arguments, and returns one terminal line.

**Call relations**: `McpToolCallCell::display_lines` calls this when building the visible tool-call header. It is the shared formatter for the human-readable call name.

*Call graph*: called by 1 (display_lines); 1 external calls (vec!).


### `tui/src/history_cell/notices.rs`

`domain_logic` · `main loop`

The terminal interface keeps a history of what happened in the session, not only chat messages but also system notices. This file supplies several small “history cell” types for those notices. A history cell is one item in the scrollback, like a card in a timeline.

The file’s job is to make important messages easy to notice without making the rest of the interface responsible for formatting details. For example, an available update is shown with a sparkle icon, the current and latest versions, an update command if one is known, and links to release notes. A cybersecurity policy notice explains that a request was flagged and points the user to the Trusted Access for Cyber program. A deprecation notice warns that something is old or being removed, with optional extra detail.

Each notice usually has two forms. The display form is styled for the live terminal: colors, bold text, wrapping to the current screen width, and sometimes borders. The raw form is simpler plain text for logs, transcripts, or places where styling is not useful. Some notices also pass their display lines through URL annotation so web links can be recognized as hyperlinks by supporting terminals.

Without this file, these important status and warning messages would either be missing or scattered across the interface code, making them harder to keep consistent and readable.

#### Function details

##### `UpdateAvailableHistoryCell::new`  (lines 14–19)

```
fn new(latest_version: String, update_action: Option<UpdateAction>) -> Self
```

**Purpose**: Creates a new update notice with the latest available version and, if known, the command the user can run to update. This is used when the app has already detected that a newer Codex CLI version exists.

**Data flow**: It receives a version string and an optional update action. It stores both inside an UpdateAvailableHistoryCell. The result is a ready-to-render history item that can later produce styled or plain text lines.

**Call relations**: The main run flow and snapshot tests call this when they need an update notice. After creation, the terminal history system can ask the cell for display lines, raw lines, or hyperlink-aware lines.

*Call graph*: called by 3 (run, standalone_unix_update_available_history_cell_snapshot, standalone_windows_update_available_history_cell_snapshot).


##### `UpdateAvailableHistoryCell::display_lines`  (lines 23–57)

```
fn display_lines(&self, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Builds the colorful terminal version of the update notice. It tells the user that an update is available, shows the version change, gives update instructions, and includes the release notes link.

**Data flow**: It reads the stored latest version and optional update action, then chooses either a specific update command or a general installation link. It formats those pieces into styled text, wraps them to fit the available width, adds a border, and returns the finished terminal lines.

**Call relations**: This is used by UpdateAvailableHistoryCell::display_hyperlink_lines when the UI wants the visible update notice. It also relies on shared wrapping and border helpers so the notice fits neatly in the terminal.

*Call graph*: calls 1 internal fn (new); called by 1 (display_hyperlink_lines); 3 external calls (line!, text!, from).


##### `UpdateAvailableHistoryCell::raw_lines`  (lines 59–73)

```
fn raw_lines(&self) -> Vec<Line<'static>>
```

**Purpose**: Produces a plain-text version of the update notice without colors, borders, or terminal styling. This is useful for transcripts, logs, or any output where decoration would get in the way.

**Data flow**: It reads the latest version and optional update action. It turns them into ordinary text lines, including either the update command or a general install link, then returns those lines as the raw notice content.

**Call relations**: The history system can call this when it needs simple text instead of the live terminal display. It does not call the styled display path, so raw output stays clean and predictable.

*Call graph*: 2 external calls (format!, vec!).


##### `UpdateAvailableHistoryCell::display_hyperlink_lines`  (lines 75–77)

```
fn display_hyperlink_lines(&self, width: u16) -> Vec<HyperlinkLine>
```

**Purpose**: Produces the visible update notice with web URLs marked so terminals that support hyperlinks can recognize them. This makes the GitHub links more useful in capable terminal apps.

**Data flow**: It takes the available width, asks UpdateAvailableHistoryCell::display_lines to build the styled lines, then passes those lines through URL annotation. The result is a set of hyperlink-aware display lines.

**Call relations**: This sits between the normal display builder and hyperlink-aware consumers. UpdateAvailableHistoryCell::transcript_hyperlink_lines also reuses it, so display and transcript hyperlink treatment stay the same.

*Call graph*: calls 2 internal fn (display_lines, annotate_web_urls); called by 1 (transcript_hyperlink_lines).


##### `UpdateAvailableHistoryCell::transcript_hyperlink_lines`  (lines 79–81)

```
fn transcript_hyperlink_lines(&self, width: u16) -> Vec<HyperlinkLine>
```

**Purpose**: Returns hyperlink-aware lines for transcript output of the update notice. It keeps transcript link behavior aligned with the live display behavior.

**Data flow**: It receives the width and forwards it to UpdateAvailableHistoryCell::display_hyperlink_lines. Whatever hyperlink-marked lines come back are returned unchanged.

**Call relations**: This is a thin reuse point. Rather than rebuilding transcript-specific link logic, it delegates to the display hyperlink path.

*Call graph*: calls 1 internal fn (display_hyperlink_lines).


##### `new_warning_event`  (lines 84–86)

```
fn new_warning_event(message: String) -> PrefixedWrappedHistoryCell
```

**Purpose**: Creates a yellow warning message for the history, prefixed with a warning symbol. It is used for general cautionary messages that should stand out but are not necessarily fatal errors.

**Data flow**: It receives a message string, colors the message and warning prefix yellow, and builds a wrapped history cell with an aligned continuation indent. The result is a ready-to-display warning item.

**Call relations**: Callers use this helper when they want a standard warning style without knowing the formatting details. It hands the work to PrefixedWrappedHistoryCell::new, which is the shared cell type for wrapped prefixed messages.

*Call graph*: calls 1 internal fn (new).


##### `new_cyber_policy_error_event`  (lines 93–95)

```
fn new_cyber_policy_error_event() -> CyberPolicyNoticeCell
```

**Purpose**: Creates the special history item shown when a chat is flagged for possible cybersecurity risk. It gives the rest of the app a simple way to add this policy notice to the history.

**Data flow**: It takes no input. It returns a CyberPolicyNoticeCell, which later knows how to render the full explanatory notice and link.

**Call relations**: Callers use this as a factory instead of constructing the cell directly. Once returned, the history system asks CyberPolicyNoticeCell for display, raw, or hyperlink-aware lines.


##### `CyberPolicyNoticeCell::display_lines`  (lines 98–129)

```
fn display_lines(&self, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Builds the styled terminal version of the cybersecurity policy notice. It explains that the chat was flagged, suggests rephrasing if the flag seems wrong, and points to the Trusted Access for Cyber program.

**Data flow**: It receives the terminal width, creates a bold heading, wraps the explanatory sentence to fit the screen, and adds the program URL as a styled link-looking line. It returns the complete set of terminal display lines.

**Call relations**: CyberPolicyNoticeCell::display_hyperlink_lines calls this first, then adds hyperlink metadata to any web URLs. It also uses shared wrapping helpers so the message remains readable on narrow screens.

*Call graph*: calls 1 internal fn (new); called by 1 (display_hyperlink_lines); 3 external calls (from, new, vec!).


##### `CyberPolicyNoticeCell::raw_lines`  (lines 131–139)

```
fn raw_lines(&self) -> Vec<Line<'static>>
```

**Purpose**: Produces the plain-text version of the cybersecurity policy notice. This keeps transcripts or logs understandable even without terminal colors and styling.

**Data flow**: It uses the fixed policy heading, explanatory text, and Trusted Access for Cyber URL. It returns them as ordinary lines with no visual decoration.

**Call relations**: The history system can use this when it needs unstyled text. It is separate from the display path so raw output does not include icons, colors, or indentation meant only for the terminal.

*Call graph*: 1 external calls (vec!).


##### `CyberPolicyNoticeCell::display_hyperlink_lines`  (lines 141–143)

```
fn display_hyperlink_lines(&self, width: u16) -> Vec<HyperlinkLine>
```

**Purpose**: Builds the visible cybersecurity notice and marks its web URL as a hyperlink where supported. This helps users open the Trusted Access for Cyber page from compatible terminals.

**Data flow**: It receives the display width, gets styled lines from CyberPolicyNoticeCell::display_lines, then runs those lines through URL annotation. It returns hyperlink-aware lines.

**Call relations**: CyberPolicyNoticeCell::transcript_hyperlink_lines delegates to this function as well, so both display and transcript hyperlink output use the same URL detection path.

*Call graph*: calls 2 internal fn (display_lines, annotate_web_urls); called by 1 (transcript_hyperlink_lines).


##### `CyberPolicyNoticeCell::transcript_hyperlink_lines`  (lines 145–147)

```
fn transcript_hyperlink_lines(&self, width: u16) -> Vec<HyperlinkLine>
```

**Purpose**: Returns hyperlink-aware transcript lines for the cybersecurity policy notice. It avoids having separate transcript-specific formatting for links.

**Data flow**: It receives the width and passes it directly to CyberPolicyNoticeCell::display_hyperlink_lines. The annotated lines that come back are returned as the transcript hyperlink form.

**Call relations**: This is a small forwarding function. It keeps transcript hyperlink behavior tied to the same logic used for the live terminal notice.

*Call graph*: calls 1 internal fn (display_hyperlink_lines).


##### `new_deprecation_notice`  (lines 156–161)

```
fn new_deprecation_notice(
    summary: String,
    details: Option<String>,
) -> DeprecationNoticeCell
```

**Purpose**: Creates a deprecation notice, which warns the user that something is outdated, discouraged, or planned for removal. It can include a short summary and optional extra details.

**Data flow**: It receives a summary string and optional detail string. It stores them in a DeprecationNoticeCell and returns that cell for later rendering.

**Call relations**: Callers use this helper when they need to place a deprecation warning into the history. The returned cell then supplies styled display lines or raw text lines when the history renderer asks for them.


##### `DeprecationNoticeCell::display_lines`  (lines 164–177)

```
fn display_lines(&self, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Builds the styled terminal version of a deprecation notice. The summary is shown as a red warning, and any extra detail is shown more quietly underneath.

**Data flow**: It reads the stored summary and optional details, creates a red warning line, then wraps the details to fit within the available terminal width if details exist. It returns the finished display lines.

**Call relations**: The history renderer calls this when it needs to show the deprecation notice on screen. It uses the shared wrapping helper so long detail text does not spill awkwardly across the terminal.

*Call graph*: calls 1 internal fn (new); 3 external calls (from, new, vec!).


##### `DeprecationNoticeCell::raw_lines`  (lines 179–185)

```
fn raw_lines(&self) -> Vec<Line<'static>>
```

**Purpose**: Produces a plain-text version of a deprecation notice. It keeps the warning readable in transcripts or logs without terminal colors.

**Data flow**: It starts with the summary as the first line. If details are present, it turns the detail text into raw lines and appends them. The result is a simple list of text lines.

**Call relations**: The history system can call this for unstyled output. It complements DeprecationNoticeCell::display_lines by providing the same information in a simpler form.

*Call graph*: 1 external calls (vec!).


##### `new_info_event`  (lines 187–195)

```
fn new_info_event(message: String, hint: Option<String>) -> PlainHistoryCell
```

**Purpose**: Creates a small informational history message, shown with a muted bullet and an optional hint. This is for lightweight status notes that should be visible but not alarming.

**Data flow**: It receives a main message and an optional hint. It builds one terminal line containing a dim bullet, the message, and, if present, the hint in a quieter color. It returns a PlainHistoryCell containing that line.

**Call relations**: Callers use this helper to add standard informational messages without repeating the styling rules. The returned PlainHistoryCell can be displayed by the normal history rendering path.

*Call graph*: 1 external calls (vec!).


##### `new_error_event`  (lines 197–203)

```
fn new_error_event(message: String) -> PlainHistoryCell
```

**Purpose**: Creates a red error history message. It is used when something went wrong and the user should notice it immediately.

**Data flow**: It receives an error message string, prefixes it with a square marker, colors the whole line red, and places it into a PlainHistoryCell. The result is a simple one-line error item for the history.

**Call relations**: Callers use this helper whenever they need a consistently styled error in the terminal history. The normal PlainHistoryCell rendering then takes care of showing it.

*Call graph*: 1 external calls (vec!).


### `tui/src/history_cell/patches.rs`

`domain_logic` · `conversation rendering`

In the terminal UI, the history needs to show more than chat text. It also needs to show practical events: a proposed code patch, a failed patch application, an image being viewed, or an image being generated. This file is the small presentation layer for those events.

The main type, `PatchHistoryCell`, stores a map of changed files and the current working directory. When the UI asks it what to show, it turns those changes into a compact file-level diff summary, such as added, modified, or deleted files. It can produce a version fitted to the current screen width, and a plain raw version for logs or copying.

The other helper functions create simple `PlainHistoryCell` entries. A patch failure becomes a bold failure message plus trimmed command error output. Viewing an image becomes a two-line entry showing the path relative to the working directory when possible. Image generation becomes a success or failure entry, optionally showing the revised prompt and where the image was saved.

The file matters because without it, these non-chat events would either be invisible or shown as raw machine data. It acts like a receipt printer for tool actions: short, readable, and formatted for a human scanning the session history.

#### Function details

##### `PatchHistoryCell::display_lines`  (lines 12–14)

```
fn display_lines(&self, width: u16) -> Vec<Line<'static>>
```

**Purpose**: This produces the screen-ready lines for a patch summary. The UI uses it when it needs to draw the patch history entry at the current terminal width.

**Data flow**: It receives a display width. It reads the stored file changes and current working directory, then asks the diff-summary formatter to make lines that fit that width. The result is a list of styled terminal lines ready to render.

**Call relations**: When the history UI treats this object as a `HistoryCell`, it calls this method to get the visible version. This method hands the actual formatting work to `create_diff_summary`, because that helper knows how to turn changed files into a concise diff summary.


##### `PatchHistoryCell::raw_lines`  (lines 16–22)

```
fn raw_lines(&self) -> Vec<Line<'static>>
```

**Purpose**: This produces a plain-text version of the patch summary. It is useful when the same history entry needs to be copied, logged, or shown without terminal-specific styling.

**Data flow**: It reads the stored file changes and working directory. It first creates a diff summary using a fixed raw-output width, then strips or normalizes it into plain lines. The output is a list of lines that carry the same information without relying on the live terminal size.

**Call relations**: The history system calls this through the `HistoryCell` interface when it needs the raw form instead of the screen form. It relies on `create_diff_summary` for the content and `plain_lines` to turn that content into a simpler representation.


##### `new_patch_event`  (lines 27–35)

```
fn new_patch_event(
    changes: HashMap<PathBuf, FileChange>,
    cwd: &Path,
) -> PatchHistoryCell
```

**Purpose**: This builds a new history cell for a proposed patch. It packages the changed files and the current folder so the patch can later be displayed in a human-friendly way.

**Data flow**: It receives a map of file paths to their change information, plus the current working directory. It copies the working directory path into owned storage with `to_path_buf` and stores both pieces in a `PatchHistoryCell`. The result is a history cell ready to be rendered later.

**Call relations**: Other parts of the UI call this when a patch event needs to be added to the conversation history. The returned `PatchHistoryCell` later feeds `display_lines` or `raw_lines` when the history is actually shown or exported.

*Call graph*: 1 external calls (to_path_buf).


##### `new_patch_apply_failure`  (lines 37–61)

```
fn new_patch_apply_failure(stderr: String) -> PlainHistoryCell
```

**Purpose**: This creates a readable history entry for a failed patch application. It shows a clear failure heading and, when available, includes the error output that explains what went wrong.

**Data flow**: It receives the patch command’s standard error text as a string. It starts with a bold magenta failure line. If the error text is not empty, it wraps that text as command output with an exit code of 1, asks `output_lines` to format only the error portion within the line limit, and appends those lines. The result is a `PlainHistoryCell` containing the failure message and relevant error details.

**Call relations**: This is used when applying a patch does not succeed and the UI needs to record that outcome in the history. It builds the visible entry itself, while handing detailed command-output formatting to `output_lines` so error text is displayed consistently with other tool output.

*Call graph*: 3 external calls (from, new, new).


##### `new_view_image_tool_call`  (lines 63–72)

```
fn new_view_image_tool_call(path: AbsolutePathBuf, cwd: &Path) -> PlainHistoryCell
```

**Purpose**: This creates a short history entry saying that an image was viewed. It shows the image path in a way that is friendly to someone working in the current folder.

**Data flow**: It receives an absolute image path and the current working directory. It converts the path to a display form, usually relative to the working directory when that makes sense, then creates two styled lines: a “Viewed Image” heading and an indented path. The result is a `PlainHistoryCell` ready for the history list.

**Call relations**: Other code calls this after an image-viewing tool action should be recorded. It uses the path display helper to avoid showing unnecessarily long file paths, then returns a plain history cell that the UI can render directly.

*Call graph*: calls 1 internal fn (as_path); 1 external calls (vec!).


##### `new_image_generation_call`  (lines 74–95)

```
fn new_image_generation_call(
    call_id: String,
    status: &str,
    revised_prompt: Option<String>,
    saved_path: Option<AbsolutePathBuf>,
) -> PlainHistoryCell
```

**Purpose**: This creates a history entry for an image generation attempt. It shows whether generation succeeded or failed, what prompt or identifier describes it, and optionally where the generated image was saved.

**Data flow**: It receives a call ID, a status string, an optional revised prompt, and an optional saved file path. It uses the revised prompt if present, otherwise it falls back to the call ID. If the status is `failed`, it creates a failure heading; otherwise it creates a generated-image heading. If a saved path exists, it tries to turn that file path into a file URL, falling back to a normal path string if that conversion fails. The output is a `PlainHistoryCell` with the heading, detail line, and optional saved-location line.

**Call relations**: This is called when an image generation tool result needs to appear in the conversation history. It does the small decision-making needed for success versus failure display, and it uses `Url::from_file_path` so saved images can be shown as clickable or recognizable file links when the terminal supports that style.

*Call graph*: 2 external calls (from_file_path, vec!).


### `tui/src/history_cell/request_user_input.rs`

`domain_logic` · `history rendering`

When the program asks the user for extra input, that exchange later needs to appear in the terminal history. This file is responsible for making that transcript understandable. Without it, the history could lose important context: which questions were asked, whether the user answered them, and whether the exchange was interrupted.

The main type, `RequestUserInputResultCell`, stores the original questions, the answers keyed by question id, and a flag saying whether the exchange was interrupted. It implements the history-cell rendering interface in two forms. One form, `display_lines`, creates styled terminal lines with bullets, dim text, cyan answers, wrapping, and a clear answered count. This is the version meant for the on-screen text user interface. The other form, `raw_lines`, creates simpler plain text lines, useful when styling is not wanted, such as copying or exporting text.

The file is careful about privacy. If a question is marked secret, the real answer is never shown; it is replaced with bullets or asterisks, like a password field. It also understands that an answer can contain selected options plus a special freeform note stored as `user_note: ...`. A small helper separates those pieces so the transcript can label them clearly.

#### Function details

##### `RequestUserInputResultCell::display_lines`  (lines 14–109)

```
fn display_lines(&self, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Builds the styled, on-screen version of the completed question-and-answer transcript. It counts answered questions, marks interrupted exchanges, wraps long text to the terminal width, and hides secret answers.

**Data flow**: It starts with the cell’s stored questions, answer map, interruption flag, and the available terminal width. It counts how many questions have non-empty answers, creates a header, then walks through each question. For every question it adds wrapped question text, adds an unanswered marker when needed, shows secret answers as masked dots, and otherwise separates option answers from a freeform note before displaying them. It returns a list of styled terminal lines ready to be drawn.

**Call relations**: The terminal history system calls this when it needs the rich visual version of the cell. During that work it hands long pieces of text to `wrap_with_prefix` so they fit neatly in the terminal, and hands each non-secret answer to `split_request_user_input_answer` so options and notes can be shown with the right labels.

*Call graph*: calls 2 internal fn (split_request_user_input_answer, wrap_with_prefix); 3 external calls (default, format!, vec!).


##### `RequestUserInputResultCell::raw_lines`  (lines 111–151)

```
fn raw_lines(&self) -> Vec<Line<'static>>
```

**Purpose**: Builds a plain-text version of the same transcript, without terminal colors or wrapping. This is useful when the history needs to be represented simply rather than drawn with styling.

**Data flow**: It reads the stored questions, answers, and interruption flag. It writes a plain summary line with the answered count, adds an interrupted marker if needed, then adds each question and either its answer, a masked secret answer, a separated note, or an unanswered marker. It returns plain line objects containing that text.

**Call relations**: The history system calls this when it needs an unstyled representation of the cell. Like the display renderer, it uses `split_request_user_input_answer` for non-secret answers so encoded notes do not get mixed up with selected answer options.

*Call graph*: calls 1 internal fn (split_request_user_input_answer); 3 external calls (from, format!, vec!).


##### `wrap_with_prefix`  (lines 155–170)

```
fn wrap_with_prefix(
    text: &str,
    width: usize,
    initial_prefix: Span<'static>,
    subsequent_prefix: Span<'static>,
    style: Style,
) -> Vec<Line<'static>>
```

**Purpose**: Wraps one piece of text so it fits within a given width, while adding one prefix to the first line and another prefix to later lines. This keeps long questions and answers readable, like indenting wrapped lines in a document.

**Data flow**: It receives the text to show, the maximum width, the prefix for the first line, the prefix for continuation lines, and the style to apply to the content. It turns the text into a styled line, asks the wrapping helper to split it into terminal-width lines with the requested indentation, then copies those wrapped lines into an owned result. It returns the finished list of lines.

**Call relations**: `RequestUserInputResultCell::display_lines` calls this whenever question text, answer text, notes, or interruption summaries may be too long for the terminal. This helper keeps the visual renderer focused on what to display, while the helper takes care of how to wrap and indent it.

*Call graph*: calls 1 internal fn (new); called by 1 (display_lines); 3 external calls (from, new, vec!).


##### `split_request_user_input_answer`  (lines 174–187)

```
fn split_request_user_input_answer(
    answer: &ToolRequestUserInputAnswer,
) -> (Vec<String>, Option<String>)
```

**Purpose**: Separates normal answer entries from an optional freeform note. The note is stored inside the answer list using the special text prefix `user_note: `, so this function turns that encoding into clearer pieces.

**Data flow**: It receives one stored answer object and reads each string inside its answer list. Entries starting with `user_note: ` become the optional note text, with that marker removed. All other entries are copied into the list of selected or typed answer options. It returns both pieces: the option list and the optional note.

**Call relations**: Both `RequestUserInputResultCell::display_lines` and `RequestUserInputResultCell::raw_lines` call this before showing non-secret answers. It gives those renderers clean data so they can label selected options as answers and the extra freeform text as a note.

*Call graph*: called by 2 (display_lines, raw_lines); 1 external calls (new).


### `tui/src/history_cell/search.rs`

`domain_logic` · `request handling`

When the app uses web search, the terminal user interface needs to show that work clearly in the conversation history. This file is the small display unit for that job. It keeps the search’s identity, the visible query or action, whether the search is still running, and whether animated progress indicators are allowed.

The main type is WebSearchCell. Think of it like a label on a package moving through a delivery system: while the search is in progress, the label says “Searching the web” and may show a moving activity marker; once finished, it changes to “Searched the web.” The file also decides what extra detail to show. For a normal search, it prefers the explicit query. If that is missing, it falls back to the first query in a list. For opening a page, it shows the URL. For finding text in a page, it combines the search pattern and URL when both are available.

There are two render paths. display_lines creates styled, wrapped terminal lines for the live interface, including bullets, bold text, and indentation. raw_lines creates plain text lines, useful when styling is not wanted. Small constructor functions create either an active cell or an already-completed cell so the rest of the app does not have to know the setup details.

#### Function details

##### `web_search_header`  (lines 5–11)

```
fn web_search_header(completed: bool) -> &'static str
```

**Purpose**: Chooses the short heading shown for a web-search history entry. It says whether the search is still happening or has already finished.

**Data flow**: It receives a true-or-false completed flag. If the flag says the work is done, it returns “Searched the web”; otherwise it returns “Searching the web.” It does not change anything else.

**Call relations**: When WebSearchCell::display_lines or WebSearchCell::raw_lines is building the visible text, they call this helper first to get the correct heading for the cell’s current state.

*Call graph*: called by 2 (display_lines, raw_lines).


##### `web_search_action_detail`  (lines 13–38)

```
fn web_search_action_detail(action: &WebSearchAction) -> String
```

**Purpose**: Turns a specific web-search action into the detail text shown after the heading. This is the part that might show a query, a URL, or a phrase being searched within a page.

**Data flow**: It receives a WebSearchAction. For a search action, it uses the main query if present and non-empty; otherwise it looks at the query list and may show the first query with “...” if there are more. For opening a page, it returns the URL if known. For finding text in a page, it combines the pattern and URL when possible. If there is nothing useful to show, it returns an empty string.

**Call relations**: This helper is used through web_search_detail when a history cell needs readable detail text. It does the action-specific wording so the display code can stay focused on layout.

*Call graph*: 2 external calls (new, format!).


##### `web_search_detail`  (lines 40–47)

```
fn web_search_detail(action: Option<&WebSearchAction>, query: &str) -> String
```

**Purpose**: Chooses the best detail text for a web-search cell. It prefers the richer action detail, but falls back to the plain query when the action has no useful text.

**Data flow**: It receives an optional action and a query string. If there is an action, it asks web_search_action_detail to describe it. If that result is empty, or if no action was supplied, it uses the query string instead. It returns the final detail text to show.

**Call relations**: WebSearchCell::display_lines and WebSearchCell::raw_lines both call this before building their output. This keeps styled output and plain output consistent.

*Call graph*: called by 2 (display_lines, raw_lines).


##### `WebSearchCell::new`  (lines 60–74)

```
fn new(
        call_id: String,
        query: String,
        action: Option<WebSearchAction>,
        animations_enabled: bool,
    ) -> Self
```

**Purpose**: Creates a new web-search history cell in its initial, not-yet-completed state. It records the moment it was created so an active search can show a time-based activity indicator.

**Data flow**: It receives a call id, query text, optional action detail, and a setting for whether animations are enabled. It stores those values, records the current time, marks the cell as incomplete, and returns the new WebSearchCell.

**Call relations**: The two public helper constructors, new_active_web_search_call and new_web_search_call, use this as the shared setup step. One leaves the cell active, while the other immediately marks it complete.

*Call graph*: called by 2 (new_active_web_search_call, new_web_search_call); 1 external calls (now).


##### `WebSearchCell::call_id`  (lines 76–78)

```
fn call_id(&self) -> &str
```

**Purpose**: Returns the identifier for the web-search call represented by this cell. Other code can use this to match later updates or completion events to the right history entry.

**Data flow**: It reads the stored call_id string from the cell and returns it as borrowed text. Nothing is copied unnecessarily and the cell is not changed.

**Call relations**: This method is available to the surrounding history system when it needs to find or compare a particular web-search entry. It does not call into other helpers because it is only exposing stored identity data.


##### `WebSearchCell::update`  (lines 80–83)

```
fn update(&mut self, action: WebSearchAction, query: String)
```

**Purpose**: Refreshes an existing web-search cell with newer information about what the search is doing. This lets the visible history entry become more accurate as details arrive.

**Data flow**: It receives a new WebSearchAction and query string. It replaces the cell’s old action with the new action and replaces the old query with the new query. It does not return a value; the cell itself is changed.

**Call relations**: This is meant to be called by the code that receives progress updates for a web-search call. After it changes the stored data, later calls to display_lines or raw_lines will show the updated detail.


##### `WebSearchCell::complete`  (lines 85–87)

```
fn complete(&mut self)
```

**Purpose**: Marks the web-search cell as finished. After this, the wording changes from “Searching” to “Searched,” and the active progress marker is no longer needed.

**Data flow**: It takes the existing cell and sets its completed flag to true. It returns nothing; the change is stored inside the cell.

**Call relations**: new_web_search_call uses this when creating a cell that is already finished. Other completion-handling code can also call it so future rendering uses the completed wording and styling.


##### `WebSearchCell::display_lines`  (lines 91–111)

```
fn display_lines(&self, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Builds the styled terminal version of the web-search history cell. This is what the user sees in the live terminal interface.

**Data flow**: It reads the cell’s completed state, start time, animation setting, action, and query. It chooses either a dim bullet or an activity indicator, builds a bold heading plus optional detail text, wraps the result to the requested width, and returns terminal Line values ready to draw.

**Call relations**: The history display system calls this when it needs to paint the cell on screen. Inside, it asks web_search_header for the right heading, web_search_detail for the readable detail, and the shared wrapping cell helper to add the bullet prefix and indentation.

*Call graph*: calls 4 internal fn (new, web_search_detail, web_search_header, from_animations_enabled); 2 external calls (from, vec!).


##### `WebSearchCell::raw_lines`  (lines 113–122)

```
fn raw_lines(&self) -> Vec<Line<'static>>
```

**Purpose**: Builds a plain-text version of the web-search history cell. This is useful anywhere styling, wrapping, or animation is not wanted.

**Data flow**: It reads the same core state as display_lines: whether the search is complete, plus the action and query. It creates one simple text line, either just the heading or the heading plus detail, and returns it in a list.

**Call relations**: The history system calls this when it needs unstyled text. It shares the wording helpers web_search_header and web_search_detail with display_lines, so the plain and styled versions say the same thing.

*Call graph*: calls 2 internal fn (web_search_detail, web_search_header); 1 external calls (vec!).


##### `new_active_web_search_call`  (lines 125–131)

```
fn new_active_web_search_call(
    call_id: String,
    query: String,
    animations_enabled: bool,
) -> WebSearchCell
```

**Purpose**: Creates a WebSearchCell for a search that has started but has not finished yet. It is a convenience function for the common “show this as in progress” case.

**Data flow**: It receives the call id, initial query, and animation setting. It passes those into WebSearchCell::new with no action detail yet, and returns the active cell that comes back.

**Call relations**: Code that starts tracking a new live web-search call uses this instead of constructing WebSearchCell directly. It delegates the actual setup to WebSearchCell::new.

*Call graph*: calls 1 internal fn (new).


##### `new_web_search_call`  (lines 133–146)

```
fn new_web_search_call(
    call_id: String,
    query: String,
    action: WebSearchAction,
) -> WebSearchCell
```

**Purpose**: Creates a WebSearchCell for a web-search action that is already complete. This is useful when adding a finished search result to history in one step.

**Data flow**: It receives the call id, query, and final action. It creates a cell with animations disabled, stores the action, immediately marks the cell complete, and returns it.

**Call relations**: This factory function uses WebSearchCell::new for the basic cell setup and then calls the cell’s completion behavior. The rest of the app can call this when it does not need an active progress state.

*Call graph*: calls 1 internal fn (new).


### `tui/src/history_cell/hook_cell.rs`

`domain_logic` · `main loop / terminal redraws while hooks start, run, finish, and are written to history`

Hooks are small pieces of automation that run around events such as tool use or session start. If every hook always left a visible line, the terminal history would become noisy. This file solves that by treating each hook run like a small display state machine: first hidden, then visible if it lasts long enough, then either briefly lingering or becoming a permanent history entry.

A new hook starts in a hidden “pending reveal” state. If it finishes quickly and successfully with no output, it disappears completely. If it keeps running past a short delay, the user sees a running line with an activity indicator. If that visible hook then succeeds quietly, it stays briefly so the row does not blink away immediately. If a hook fails, is blocked or stopped, or produces output such as warnings or context, it becomes part of the lasting transcript.

The file also formats hook output. It chooses labels, bullets, prefixes like “warning:” or “error:”, indentation for multi-line output, and whether to animate the running text. Adjacent running hooks with the same kind and message can be combined into one line, like “Running 3 PostToolUse hooks”, so the screen stays readable.

#### Function details

##### `HookCell::new_active`  (lines 119–126)

```
fn new_active(run: HookRunSummary, animations_enabled: bool) -> Self
```

**Purpose**: Creates a new history cell for a hook that has just started. The hook is not necessarily shown immediately; it begins in the file’s quiet waiting period.

**Data flow**: It receives a hook summary and the current animation setting. It creates an empty cell, records the started hook through `start_run`, and returns the cell ready to be tracked by the UI.

**Call relations**: The public wrapper `new_active_hook_cell` uses this when live hook events arrive. Several tests also call it directly to check pending, visible, and animation behavior.

*Call graph*: called by 5 (new_active_hook_cell, pending_hook_does_not_animate_transcript, visible_hook_animates_transcript_when_animations_enabled, visible_hook_does_not_animate_transcript_when_animations_disabled, visible_hook_without_animations_omits_spinner); 1 external calls (new).


##### `HookCell::new_completed`  (lines 129–136)

```
fn new_completed(run: HookRunSummary, animations_enabled: bool) -> Self
```

**Purpose**: Creates a history cell from a hook that is already finished, such as when rebuilding history from saved transcript data.

**Data flow**: It receives the final hook summary and animation setting. It creates an empty cell, adds the completed run if it is worth showing, and returns the resulting cell.

**Call relations**: The public wrapper `new_completed_hook_cell` calls this for completed hook summaries. The test helper `completed_hook_cell` also uses it to build sample completed cells.

*Call graph*: called by 2 (new_completed_hook_cell, completed_hook_cell); 1 external calls (new).


##### `HookCell::is_empty`  (lines 138–140)

```
fn is_empty(&self) -> bool
```

**Purpose**: Reports whether this cell currently contains no hook runs at all.

**Data flow**: It reads the cell’s internal run list and returns true if that list is empty, otherwise false.

**Call relations**: `should_flush` uses this as one half of deciding whether a finished cell should be moved out of the active area.

*Call graph*: called by 1 (should_flush).


##### `HookCell::is_active`  (lines 143–145)

```
fn is_active(&self) -> bool
```

**Purpose**: Reports whether any hook in the cell can still change because it is running, waiting to be revealed, or lingering before removal.

**Data flow**: It looks at every stored run and asks each run state whether it is still active. It returns true as soon as at least one run can still change.

**Call relations**: `should_flush` calls this before deciding that a hook cell is fully settled.

*Call graph*: called by 1 (should_flush).


##### `HookCell::should_flush`  (lines 148–150)

```
fn should_flush(&self) -> bool
```

**Purpose**: Decides whether this cell is finished enough to leave the active hook slot and become normal history.

**Data flow**: It checks that the cell is not active anymore and is not empty. If both are true, it returns true.

**Call relations**: It combines `is_active` and `is_empty` so the surrounding UI can know when active hook bookkeeping is done.

*Call graph*: calls 2 internal fn (is_active, is_empty).


##### `HookCell::should_render`  (lines 153–155)

```
fn should_render(&self) -> bool
```

**Purpose**: Reports whether this hook cell currently has anything visible to draw.

**Data flow**: It checks each run state and returns true if at least one state should produce display lines.

**Call relations**: This lets callers avoid giving screen space to hooks that are still hidden or have disappeared quietly.


##### `HookCell::take_completed_persistent_runs`  (lines 161–176)

```
fn take_completed_persistent_runs(&mut self) -> Option<Self>
```

**Purpose**: Separates finished hook runs that should stay in history from temporary runs that should vanish.

**Data flow**: It drains the cell’s run list. Completed runs with output or notable status are moved into a new cell; quiet successes and temporary states remain behind or disappear. It returns the new persistent cell only if there is something to keep.

**Call relations**: This is used when the active hook area is being cleaned up. It preserves failures, blocked/stopped hooks, and hooks with output while letting quiet successes fade away.

*Call graph*: 1 external calls (new).


##### `HookCell::has_visible_running_run`  (lines 179–181)

```
fn has_visible_running_run(&self) -> bool
```

**Purpose**: Reports whether the active hook cell currently takes up visible space as a running hook row.

**Data flow**: It scans the runs and returns true if any run is in a visible running-like state.

**Call relations**: Callers can use this to decide whether the viewport needs to reserve room for active hook status text.


##### `HookCell::advance_time`  (lines 184–192)

```
fn advance_time(&mut self, now: Instant) -> bool
```

**Purpose**: Moves hook display timers forward and says whether the screen should be redrawn.

**Data flow**: It receives the current time. Pending hooks whose reveal time has arrived become visible, and quiet lingering hooks whose removal time has passed are removed. It returns true if any state changed or any run was removed.

**Call relations**: The UI timer loop uses this kind of method to turn hidden hooks into visible rows and later remove quiet successes without needing a new hook event.


##### `HookCell::start_run`  (lines 198–212)

```
fn start_run(&mut self, run: HookRunSummary)
```

**Purpose**: Records that a hook has started, or refreshes an existing started hook with the same id.

**Data flow**: It receives a hook summary and reads the current clock time. If a run with the same id already exists, it updates its metadata and resets its hidden reveal timer. Otherwise it appends a new pending run.

**Call relations**: `HookCell::new_active` calls this for the first run in a live cell. Later begin events can call it again, and matching by id keeps start and finish messages paired.

*Call graph*: calls 1 internal fn (pending); 1 external calls (now).


##### `HookCell::complete_run`  (lines 218–243)

```
fn complete_run(&mut self, run: HookRunSummary) -> bool
```

**Purpose**: Marks a known running hook as finished and applies the quiet-success rules.

**Data flow**: It receives a final hook summary. If no matching id exists, it returns false. If the hook completed successfully with no output, it either removes it immediately or changes it into a short linger. Otherwise it updates the run into a completed state with status and entries, then returns true.

**Call relations**: This is the live completion path. It uses `hook_run_is_quiet_success` to avoid noisy transcript entries and `HookRunState::completed` for runs that should remain visible.

*Call graph*: calls 2 internal fn (completed, hook_run_is_quiet_success); 1 external calls (now).


##### `HookCell::add_completed_run`  (lines 248–266)

```
fn add_completed_run(&mut self, run: HookRunSummary)
```

**Purpose**: Adds a hook that is already finished, but only if it deserves to be visible in history.

**Data flow**: It receives a final hook summary. Quiet successful hooks with no entries are ignored. Other completed hooks are appended as completed run cells with their id, event, message, status, and output entries.

**Call relations**: `HookCell::new_completed` uses this when restoring or replaying history where there was no live active cell.

*Call graph*: calls 2 internal fn (completed, hook_run_is_quiet_success).


##### `HookCell::next_timer_deadline`  (lines 268–273)

```
fn next_timer_deadline(&self) -> Option<Instant>
```

**Purpose**: Finds the next time when this cell needs a timer-based update.

**Data flow**: It asks each run state for its next deadline, ignores runs with no timer, and returns the earliest deadline if one exists.

**Call relations**: The surrounding UI can use this to schedule the next redraw for reveal or linger expiration.


##### `HookCell::expire_quiet_runs_now_for_test`  (lines 276–280)

```
fn expire_quiet_runs_now_for_test(&mut self)
```

**Purpose**: Test-only helper that makes quiet lingering hooks expire immediately.

**Data flow**: It walks through all runs and changes any quiet-linger removal deadline to the current time.

**Call relations**: Tests use this to avoid waiting in real time when checking disappearance behavior.


##### `HookCell::reveal_running_runs_now_for_test`  (lines 283–288)

```
fn reveal_running_runs_now_for_test(&mut self)
```

**Purpose**: Test-only helper that makes pending running hooks eligible to appear immediately.

**Data flow**: It reads the current time and sets each pending run’s reveal deadline to that time.

**Call relations**: Tests call this before advancing time so they can check visible running output deterministically.

*Call graph*: 1 external calls (now).


##### `HookCell::reveal_running_runs_after_delayed_redraw_for_test`  (lines 291–296)

```
fn reveal_running_runs_after_delayed_redraw_for_test(&mut self)
```

**Purpose**: Test-only helper that simulates a hook whose reveal deadline passed well before the redraw happened.

**Data flow**: It reads the current time and moves pending reveal deadlines into the past by more than the quiet visible duration.

**Call relations**: Tests use this to exercise timing edge cases without sleeping.

*Call graph*: 1 external calls (now).


##### `HookCell::display_lines`  (lines 301–340)

```
fn display_lines(&self, _width: u16) -> Vec<Line<'static>>
```

**Purpose**: Builds the terminal lines that should be shown for this hook cell.

**Data flow**: It reads all runs, skips hidden ones, groups adjacent visible running hooks with the same label and message, and emits completed runs with their output. It returns a list of styled terminal lines.

**Call relations**: `transcript_lines`, `raw_lines`, and `render` all rely on this as the single source of visible hook text. It calls grouping and formatting helpers to keep the output compact and readable.

*Call graph*: calls 4 internal fn (new, earliest_instant, push_hook_line_separator, push_running_hook_group); called by 3 (raw_lines, render, transcript_lines); 1 external calls (new).


##### `HookCell::transcript_lines`  (lines 343–345)

```
fn transcript_lines(&self, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Returns the same lines for transcript display that the viewport uses.

**Data flow**: It receives a width and forwards it to `display_lines`, returning the resulting styled lines unchanged.

**Call relations**: This keeps the saved or overlay transcript consistent with the live terminal view.

*Call graph*: calls 1 internal fn (display_lines).


##### `HookCell::raw_lines`  (lines 347–349)

```
fn raw_lines(&self) -> Vec<Line<'static>>
```

**Purpose**: Returns plain text versions of the hook display lines, without styling.

**Data flow**: It builds display lines at a very large width and passes them through `plain_lines` to strip styling.

**Call relations**: This is useful for plain transcript text, tests, or places where colors and animation spans are not wanted.

*Call graph*: calls 1 internal fn (display_lines); 1 external calls (plain_lines).


##### `HookCell::transcript_animation_tick`  (lines 352–363)

```
fn transcript_animation_tick(&self) -> Option<u64>
```

**Purpose**: Provides a simple changing number while visible hook animation is active, so transcript overlays can refresh at a reasonable pace.

**Data flow**: If animations are disabled or no running hook is visible, it returns nothing. Otherwise it finds a visible running hook’s start time, converts elapsed time into 600-millisecond buckets, and returns that bucket number.

**Call relations**: This lets transcript rendering know when animated hook text may need repainting without tracking every animation frame.


##### `HookCell::render`  (lines 367–371)

```
fn render(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Draws this hook cell into a terminal screen area.

**Data flow**: It receives a rectangular area and a terminal buffer. It builds display lines for that width, wraps them in a paragraph widget, and renders the paragraph into the buffer.

**Call relations**: This is the `Renderable` implementation used by the terminal UI when the hook cell is actually painted.

*Call graph*: calls 1 internal fn (display_lines); 2 external calls (new, from).


##### `HookCell::desired_height`  (lines 373–375)

```
fn desired_height(&self, width: u16) -> u16
```

**Purpose**: Reports how many terminal rows this hook cell wants at a given width.

**Data flow**: It receives a width and delegates to the general `HistoryCell` height calculation.

**Call relations**: The layout system uses this through the `Renderable` interface to reserve enough vertical space.

*Call graph*: calls 1 internal fn (desired_height).


##### `HookRunCell::expire_quiet_linger_now_for_test`  (lines 380–387)

```
fn expire_quiet_linger_now_for_test(&mut self)
```

**Purpose**: Test-only helper that forces one run’s quiet-linger state to be ready for removal.

**Data flow**: If the run is in quiet linger, it replaces its removal deadline with the current time. Other states are left unchanged.

**Call relations**: `HookCell::expire_quiet_runs_now_for_test` calls this for each run during tests.

*Call graph*: 1 external calls (now).


##### `HookRunCell::reveal_running_now_for_test`  (lines 390–397)

```
fn reveal_running_now_for_test(&mut self, now: Instant)
```

**Purpose**: Test-only helper that makes one pending run ready to reveal.

**Data flow**: It receives a time. If the run is pending reveal, it sets its reveal deadline to that time.

**Call relations**: `HookCell::reveal_running_runs_now_for_test` calls this on each run before tests advance the cell clock.


##### `HookRunCell::reveal_running_after_delayed_redraw_for_test`  (lines 400–410)

```
fn reveal_running_after_delayed_redraw_for_test(&mut self, now: Instant)
```

**Purpose**: Test-only helper that makes one pending run look as if its reveal deadline passed some time ago.

**Data flow**: It receives a time, subtracts the quiet visible duration plus a little extra when possible, and stores that older time as the reveal deadline.

**Call relations**: `HookCell::reveal_running_runs_after_delayed_redraw_for_test` calls this to set up delayed-redraw timing cases.

*Call graph*: 2 external calls (from_millis, checked_sub).


##### `HookRunCell::running_group_key`  (lines 413–420)

```
fn running_group_key(&self) -> Option<RunningHookGroupKey>
```

**Purpose**: Returns the information needed to combine this run with neighboring visible running hooks.

**Data flow**: If the run is visibly running or lingering as running, it returns its hook event name and status message. Otherwise it returns nothing.

**Call relations**: `HookCell::display_lines` uses this to decide whether adjacent running hooks can share one status line.

*Call graph*: calls 1 internal fn (is_running_visible).


##### `HookRunCell::push_display_lines`  (lines 423–465)

```
fn push_display_lines(&self, lines: &mut Vec<Line<'static>>, animations_enabled: bool)
```

**Purpose**: Adds the display lines for one hook run when it is not being merged into a running group.

**Data flow**: It receives a line list and the animation setting. For running states it adds a running header. For completed states it adds a status line plus formatted output entries. Pending hidden runs add nothing.

**Call relations**: `HookCell::display_lines` calls this for completed runs and other ungrouped cases. It uses helpers for labels, bullets, output prefixes, and running headers.

*Call graph*: calls 4 internal fn (hook_completed_bullet, hook_event_label, hook_output_prefix, push_running_hook_header); 2 external calls (format!, vec!).


##### `HookRunState::pending`  (lines 470–475)

```
fn pending(start_time: Instant) -> Self
```

**Purpose**: Creates the initial hidden state for a newly started hook.

**Data flow**: It receives the start time and stores both that time and a reveal deadline shortly afterward.

**Call relations**: `HookCell::start_run` uses this whenever a hook begin event is recorded or refreshed.

*Call graph*: called by 1 (start_run).


##### `HookRunState::completed`  (lines 478–480)

```
fn completed(status: HookRunStatus, entries: Vec<HookOutputEntry>) -> Self
```

**Purpose**: Creates the final stored state for a hook whose result should be shown.

**Data flow**: It receives the final status and output entries, then stores them in a completed state.

**Call relations**: `HookCell::complete_run` and `HookCell::add_completed_run` use this for hooks that are not invisible quiet successes.

*Call graph*: called by 2 (add_completed_run, complete_run).


##### `HookRunState::is_active`  (lines 483–490)

```
fn is_active(&self) -> bool
```

**Purpose**: Says whether this state can still change over time or through a completion event.

**Data flow**: It returns true for pending, visible running, and quiet-linger states, and false for completed states.

**Call relations**: `HookCell::is_active` uses this across all runs to tell whether the cell is still live.


##### `HookRunState::should_render`  (lines 493–500)

```
fn should_render(&self) -> bool
```

**Purpose**: Says whether this state should currently draw at least one line.

**Data flow**: It returns true for visible running, quiet linger, and completed states. It returns false while the hook is still in the hidden pending period.

**Call relations**: `HookCell::should_render` and `HookCell::display_lines` use this to keep very fast hooks invisible.


##### `HookRunState::has_persistent_output`  (lines 503–512)

```
fn has_persistent_output(&self) -> bool
```

**Purpose**: Says whether a completed hook should survive as lasting history.

**Data flow**: For completed runs, it returns true if the status is not a normal completion or if there are output entries. For active states it returns false.

**Call relations**: `HookCell::take_completed_persistent_runs` uses this to split permanent history from temporary active-cell state.


##### `HookRunState::start_time`  (lines 517–524)

```
fn start_time(&self) -> Option<Instant>
```

**Purpose**: Returns the original start time for states that still behave like running work.

**Data flow**: It returns the stored start time for pending, visible running, and quiet-linger states. It returns nothing for completed runs.

**Call relations**: `HookCell::display_lines` and animation logic use this so grouped spinners and shimmer timing stay stable.


##### `HookRunState::is_running_visible`  (lines 527–532)

```
fn is_running_visible(&self) -> bool
```

**Purpose**: Says whether this state should be treated as a visible in-progress row.

**Data flow**: It returns true for visible running and quiet linger, and false for pending or completed states.

**Call relations**: `HookRunCell::running_group_key`, `HookCell::has_visible_running_run`, and animation tick logic use this to identify active visible hook rows.

*Call graph*: called by 1 (running_group_key); 1 external calls (matches!).


##### `HookRunState::reveal_if_due`  (lines 538–554)

```
fn reveal_if_due(&mut self, now: Instant) -> bool
```

**Purpose**: Turns a hidden pending hook into a visible running hook once its reveal time arrives.

**Data flow**: It receives the current time. If the state is pending and the deadline has passed, it changes the state to visible running and records when it became visible. It returns whether a change happened.

**Call relations**: `HookCell::advance_time` calls this during timer updates and uses the result to decide whether a redraw is needed.


##### `HookRunState::next_timer_deadline`  (lines 557–567)

```
fn next_timer_deadline(&self) -> Option<Instant>
```

**Purpose**: Returns the next timer moment owned by this run state.

**Data flow**: It returns the reveal deadline for pending hooks, the removal deadline for quiet-linger hooks, and nothing for visible running or completed hooks.

**Call relations**: `HookCell::next_timer_deadline` gathers these deadlines across runs to schedule the next UI update.


##### `HookRunState::quiet_linger_expired`  (lines 570–579)

```
fn quiet_linger_expired(&self, now: Instant) -> bool
```

**Purpose**: Checks whether a quiet successful hook has lingered long enough to be removed.

**Data flow**: It receives the current time and compares it with the removal deadline for quiet-linger states. Other states always return false.

**Call relations**: `HookCell::advance_time` uses this to remove quiet successes after their brief readable pause.


##### `HookRunState::complete_quiet_success`  (lines 585–604)

```
fn complete_quiet_success(&mut self, now: Instant) -> bool
```

**Purpose**: Handles a successful no-output hook that has already become visible.

**Data flow**: It receives the current time. If the state is visible running and has not yet been visible for the minimum time, it changes to quiet linger and returns true. If it was never visible or has already been visible long enough, it returns false so the caller can remove it.

**Call relations**: `HookCell::complete_run` uses this when `hook_run_is_quiet_success` says the finished hook should not become permanent history.


##### `RunningHookGroup::new`  (lines 608–614)

```
fn new(key: RunningHookGroupKey, start_time: Option<Instant>) -> Self
```

**Purpose**: Starts a temporary group for adjacent running hooks that can share one display row.

**Data flow**: It receives the group key and optional start time, stores them, and begins the count at one.

**Call relations**: `HookCell::display_lines` creates these groups while walking through visible runs.

*Call graph*: called by 1 (display_lines).


##### `push_running_hook_group`  (lines 618–637)

```
fn push_running_hook_group(
    lines: &mut Vec<Line<'static>>,
    group: &RunningHookGroup,
    animations_enabled: bool,
)
```

**Purpose**: Adds one display line for a group of one or more similar running hooks.

**Data flow**: It receives the output line list, a running-hook group, and the animation setting. It inserts a separator if needed, builds text such as “Running PostToolUse hook” or “Running 3 PostToolUse hooks”, and passes it to the shared header formatter.

**Call relations**: `HookCell::display_lines` calls this whenever it finishes collecting a group of adjacent running hooks.

*Call graph*: calls 3 internal fn (hook_event_label, push_hook_line_separator, push_running_hook_header); called by 1 (display_lines); 1 external calls (format!).


##### `push_running_hook_header`  (lines 640–666)

```
fn push_running_hook_header(
    lines: &mut Vec<Line<'static>>,
    hook_text: &str,
    start_time: Option<Instant>,
    status_message: Option<&str>,
    animations_enabled: bool,
)
```

**Purpose**: Formats the shared header used for visible running hook rows.

**Data flow**: It receives a line list, header text, optional start time, optional status message, and animation setting. It may add an activity indicator, shimmer styling, bold static text when animations are off, and a dimmed status message, then appends the line.

**Call relations**: Both grouped running hooks and single running hooks call this so their headers look consistent.

*Call graph*: calls 3 internal fn (from_animations_enabled, activity_indicator, shimmer_text); called by 2 (push_display_lines, push_running_hook_group); 2 external calls (default, new).


##### `push_hook_line_separator`  (lines 669–673)

```
fn push_hook_line_separator(lines: &mut Vec<Line<'static>>)
```

**Purpose**: Adds a blank line between hook blocks without adding an unwanted blank line at the very top.

**Data flow**: It checks whether the line list already has content. If it does, it appends one empty line; if not, it does nothing.

**Call relations**: `HookCell::display_lines` and `push_running_hook_group` use this to keep separate hook blocks readable.

*Call graph*: called by 2 (display_lines, push_running_hook_group).


##### `earliest_instant`  (lines 676–683)

```
fn earliest_instant(left: Option<Instant>, right: Option<Instant>) -> Option<Instant>
```

**Purpose**: Chooses the earlier of two optional times while preserving a known time if only one exists.

**Data flow**: It receives two optional instants. If both exist, it returns the earlier one; if only one exists, it returns that one; if neither exists, it returns nothing.

**Call relations**: `HookCell::display_lines` uses this when merging running hooks so the grouped animation keeps the oldest hook’s timing.

*Call graph*: called by 1 (display_lines).


##### `new_active_hook_cell`  (lines 685–687)

```
fn new_active_hook_cell(run: HookRunSummary, animations_enabled: bool) -> HookCell
```

**Purpose**: Public helper for creating a hook history cell from a newly started hook.

**Data flow**: It receives a hook summary and animation setting, forwards both to `HookCell::new_active`, and returns the new cell.

**Call relations**: This is the small outside-facing constructor used by code that should not need to know the internal `HookCell` setup steps.

*Call graph*: calls 1 internal fn (new_active).


##### `new_completed_hook_cell`  (lines 689–691)

```
fn new_completed_hook_cell(run: HookRunSummary, animations_enabled: bool) -> HookCell
```

**Purpose**: Public helper for creating a hook history cell from an already completed hook.

**Data flow**: It receives a final hook summary and animation setting, forwards both to `HookCell::new_completed`, and returns the cell.

**Call relations**: This gives restoration or transcript code a simple entry point for completed hook display.

*Call graph*: calls 1 internal fn (new_completed).


##### `hook_run_is_quiet_success`  (lines 694–696)

```
fn hook_run_is_quiet_success(run: &HookRunSummary) -> bool
```

**Purpose**: Decides whether a completed hook should be invisible because it succeeded and said nothing.

**Data flow**: It reads the hook summary’s status and output entries. It returns true only when the status is completed and the entries list is empty.

**Call relations**: `HookCell::complete_run` and `HookCell::add_completed_run` call this before deciding whether to remove, linger, or persist a hook.

*Call graph*: called by 2 (add_completed_run, complete_run).


##### `hook_completed_bullet`  (lines 698–713)

```
fn hook_completed_bullet(status: HookRunStatus, entries: &[HookOutputEntry]) -> Span<'static>
```

**Purpose**: Chooses the styled bullet shown beside a completed hook.

**Data flow**: It receives the hook status and output entries. Normal successful hooks get a green bold bullet unless they contain warnings, warning successes get a default bold bullet, and blocked, failed, or stopped hooks get a red bold bullet.

**Call relations**: `HookRunCell::push_display_lines` uses this when drawing completed hook headers. A test checks the warning-specific behavior.

*Call graph*: called by 2 (push_display_lines, completed_hook_with_warning_uses_default_bold_bullet); 1 external calls (iter).


##### `hook_output_prefix`  (lines 715–723)

```
fn hook_output_prefix(kind: HookOutputEntryKind) -> &'static str
```

**Purpose**: Returns the human-readable prefix for a hook output entry kind.

**Data flow**: It receives an output kind such as warning, error, feedback, context, or stop, and returns text like “warning: ” or “hook context: ”.

**Call relations**: `HookRunCell::push_display_lines` uses this when rendering each completed hook output entry.

*Call graph*: called by 1 (push_display_lines).


##### `hook_event_label`  (lines 725–738)

```
fn hook_event_label(event_name: HookEventName) -> &'static str
```

**Purpose**: Turns a hook event enum value into the label shown to users.

**Data flow**: It receives a hook event name and returns a fixed label such as `PreToolUse`, `SessionStart`, or `Stop`.

**Call relations**: Running and completed hook renderers call this so all hook rows use consistent event names.

*Call graph*: called by 2 (push_display_lines, push_running_hook_group).


##### `tests::completed_hook_with_warning_uses_default_bold_bullet`  (lines 749–760)

```
fn completed_hook_with_warning_uses_default_bold_bullet()
```

**Purpose**: Checks that a completed hook with a warning does not get the green success bullet.

**Data flow**: It builds a warning output entry, asks `hook_completed_bullet` for the bullet, and asserts that the bullet text is present, bold, and has no green foreground color.

**Call relations**: This test protects the visual distinction between clean success and success-with-warning.

*Call graph*: calls 1 internal fn (hook_completed_bullet); 3 external calls (assert!, assert_eq!, vec!).


##### `tests::completed_hook_multiline_context_preserves_display_and_raw_lines`  (lines 763–783)

```
fn completed_hook_multiline_context_preserves_display_and_raw_lines()
```

**Purpose**: Checks that multi-line hook context output is formatted consistently in styled and plain text forms.

**Data flow**: It builds a completed SessionStart hook with multi-line context text, renders display and raw lines, and compares both with the expected strings.

**Call relations**: This test exercises the completed-hook rendering path through the `completed_hook_cell` helper.

*Call graph*: 3 external calls (assert_eq!, completed_hook_cell, vec!).


##### `tests::completed_hook_multiline_warning_prefixes_first_line_only`  (lines 786–804)

```
fn completed_hook_multiline_warning_prefixes_first_line_only()
```

**Purpose**: Checks that a multi-line warning prefixes only the first line with “warning:” and indents later lines.

**Data flow**: It builds a completed hook with warning text containing a newline, renders display lines, and compares them with the expected output.

**Call relations**: This test protects the output formatting done by `HookRunCell::push_display_lines`.

*Call graph*: 3 external calls (assert_eq!, completed_hook_cell, vec!).


##### `tests::pending_hook_does_not_animate_transcript`  (lines 807–812)

```
fn pending_hook_does_not_animate_transcript()
```

**Purpose**: Checks that a hidden pending hook does not request transcript animation updates.

**Data flow**: It creates a new active hook with animations enabled and asserts that `transcript_animation_tick` returns nothing.

**Call relations**: This test calls `HookCell::new_active` and confirms that pending hooks stay invisible and non-animating.

*Call graph*: calls 1 internal fn (new_active); 2 external calls (assert_eq!, hook_run_summary).


##### `tests::visible_hook_animates_transcript_when_animations_enabled`  (lines 815–822)

```
fn visible_hook_animates_transcript_when_animations_enabled()
```

**Purpose**: Checks that a revealed running hook requests transcript animation ticks when animations are enabled.

**Data flow**: It creates an active hook, forces it to reveal, advances time, and asserts that the first animation tick is present.

**Call relations**: This test covers the path from pending reveal to visible running animation.

*Call graph*: calls 1 internal fn (new_active); 3 external calls (now, assert_eq!, hook_run_summary).


##### `tests::visible_hook_does_not_animate_transcript_when_animations_disabled`  (lines 825–834)

```
fn visible_hook_does_not_animate_transcript_when_animations_disabled()
```

**Purpose**: Checks that visible hooks do not animate transcript overlays when animations are turned off.

**Data flow**: It creates an active hook with animations disabled, reveals it, advances time, and asserts that no animation tick is returned.

**Call relations**: This test ensures the global animation setting is respected by hook transcript rendering.

*Call graph*: calls 1 internal fn (new_active); 3 external calls (now, assert_eq!, hook_run_summary).


##### `tests::visible_hook_without_animations_omits_spinner`  (lines 837–855)

```
fn visible_hook_without_animations_omits_spinner()
```

**Purpose**: Checks that a visible running hook does not show a spinner when animations are disabled.

**Data flow**: It creates and reveals an active hook with animations disabled, renders its display lines, extracts plain text, and compares the result with the expected non-spinner text.

**Call relations**: This test protects the reduced-motion/static rendering path in `push_running_hook_header`.

*Call graph*: calls 1 internal fn (new_active); 3 external calls (now, assert_eq!, hook_run_summary).


##### `tests::completed_hook_cell`  (lines 857–870)

```
fn completed_hook_cell(
        event_name: HookEventName,
        status: HookRunStatus,
        entries: Vec<HookOutputEntry>,
    ) -> HookCell
```

**Purpose**: Test helper that builds a completed hook cell with chosen event, status, and output entries.

**Data flow**: It starts from a standard hook summary, overwrites fields to mark it completed, inserts the supplied entries, and returns a completed hook cell with animations disabled.

**Call relations**: Multiple completed-hook formatting tests use this helper to avoid repeating setup code.

*Call graph*: calls 1 internal fn (new_completed); 1 external calls (hook_run_summary).


##### `tests::line_texts`  (lines 872–874)

```
fn line_texts(lines: &[Line<'_>]) -> Vec<String>
```

**Purpose**: Test helper that converts many styled terminal lines into plain strings.

**Data flow**: It receives a slice of styled lines, maps each one through `line_text`, and returns the collected strings.

**Call relations**: Formatting tests use this to compare rendered output with simple expected string lists.

*Call graph*: 1 external calls (iter).


##### `tests::line_text`  (lines 876–881)

```
fn line_text(line: &Line<'_>) -> String
```

**Purpose**: Test helper that converts one styled terminal line into plain text.

**Data flow**: It receives a styled line, concatenates the text content from all its spans, and returns the resulting string.

**Call relations**: `tests::line_texts` and one rendering test use this to ignore colors and styles while checking text.


##### `tests::hook_run_summary`  (lines 883–900)

```
fn hook_run_summary(id: &str) -> HookRunSummary
```

**Purpose**: Test helper that creates a standard running hook summary.

**Data flow**: It receives an id string and returns a hook summary filled with typical test values, including a PostToolUse event and a status message.

**Call relations**: Active-hook tests and the completed-hook helper use this as their starting sample hook.

*Call graph*: 2 external calls (new, test_path_buf).


### Chat widget streaming and turn state
These files turn low-level stream and tool events into live chat-widget state, transcript updates, command and hook lifecycle changes, and finalized turn behavior.

### `tui/src/chatwidget/exec_state.rs`

`domain_logic` · `command execution tracking in the chat UI`

When the chat UI starts or watches a command, it needs to remember a few practical facts: what command is running, how it should be shown to the user, where it came from, and whether it is part of the newer “unified exec” flow. This file is that small bookkeeping drawer.

It defines simple records for a running command and for a short summary of a unified execution process. It also defines two pieces of waiting state. `UnifiedExecWaitState` remembers the display text for a command so the UI can notice when the same wait message would be shown twice. `UnifiedExecWaitStreak` tracks a run of terminal activity for one process and fills in the command display later if it was not known at first.

The helper functions answer common questions. One checks whether a command came from the unified execution system. Another checks whether parsed command actions are all recognized tool calls rather than unknown shell text. The last helper takes a raw command string and protocol-level command actions, then returns both the split command words and the core parsed-command form. In everyday terms, this file is like the label maker and clipboard for command execution in the chat panel: it keeps names straight and prevents repeated or incomplete status text.

#### Function details

##### `UnifiedExecWaitState::new`  (lines 26–28)

```
fn new(command_display: String) -> Self
```

**Purpose**: Creates a small wait-state object that remembers the text used to display a command. The chat widget uses this when a command has just started so it can compare later messages against the original display text.

**Data flow**: It receives a command display string → stores that string inside a new `UnifiedExecWaitState` → returns the new state object. It does not change anything outside itself.

**Call relations**: When command execution starts, `handle_command_execution_started_now` calls this to create the remembered display state. Later code can use that stored text to decide whether another wait message is repeating the same command.

*Call graph*: called by 1 (handle_command_execution_started_now).


##### `UnifiedExecWaitState::is_duplicate`  (lines 30–32)

```
fn is_duplicate(&self, command_display: &str) -> bool
```

**Purpose**: Checks whether a proposed command display is the same as the one already being waited on. This helps avoid showing the user duplicate command-wait information.

**Data flow**: It reads the command display saved inside the wait state and receives another display string → compares the two strings exactly → returns `true` if they match and `false` if they do not.

**Call relations**: This is used as the comparison step after a `UnifiedExecWaitState` has been created. It does not hand work off to other project code; it simply answers the duplicate-or-not question for the chat widget’s execution flow.


##### `UnifiedExecWaitStreak::new`  (lines 42–47)

```
fn new(process_id: String, command_display: Option<String>) -> Self
```

**Purpose**: Creates a record for a stretch of unified terminal activity tied to one process. It keeps the process identifier and, if available, a non-empty command display string.

**Data flow**: It receives a process ID and an optional command display → keeps the process ID as-is → keeps the display only if it exists and is not an empty string → returns the new streak record.

**Call relations**: `on_terminal_interaction` calls this when terminal activity begins or is noticed for a process. The returned streak can then be updated if the command display was not known yet.

*Call graph*: called by 1 (on_terminal_interaction).


##### `UnifiedExecWaitStreak::update_command_display`  (lines 49–54)

```
fn update_command_display(&mut self, command_display: Option<String>)
```

**Purpose**: Fills in the command display for a wait streak, but only if it does not already have one. This protects the first useful display text from being overwritten later.

**Data flow**: It receives an optional command display → first checks whether the streak already has display text → if it does, nothing changes → if it does not, it stores the new display only when it is present and not empty. It returns no value; the streak itself may be changed.

**Call relations**: This belongs to the follow-up part of terminal tracking. After a streak has been created, later activity may provide the missing command text, and this method adds it without disturbing an existing value.


##### `is_unified_exec_source`  (lines 57–62)

```
fn is_unified_exec_source(source: ExecCommandSource) -> bool
```

**Purpose**: Answers whether a command execution source belongs to the unified execution flow. This lets the chat UI treat unified startup and unified interaction commands differently from other command sources.

**Data flow**: It receives a command source value → checks whether it is either `UnifiedExecStartup` or `UnifiedExecInteraction` → returns `true` for those two cases and `false` for all others.

**Call relations**: Other execution-tracking code can call this as a gate before applying unified-exec behavior. Internally it only performs a direct pattern check and does not call into other project logic.

*Call graph*: 1 external calls (matches!).


##### `is_standard_tool_call`  (lines 64–69)

```
fn is_standard_tool_call(parsed_cmd: &[ParsedCommand]) -> bool
```

**Purpose**: Checks whether a parsed command looks like a normal recognized tool call. It rejects empty command lists and rejects any parsed item marked as unknown.

**Data flow**: It receives a list of parsed command pieces → first makes sure the list is not empty → then looks through every parsed item → returns `true` only when every item is recognized, otherwise returns `false`.

**Call relations**: This helper is used wherever the chat widget needs to distinguish clear, structured tool calls from unrecognized command text. It relies only on basic list checks and iteration.

*Call graph*: 2 external calls (is_empty, iter).


##### `command_execution_command_and_parsed`  (lines 71–83)

```
fn command_execution_command_and_parsed(
    command: &str,
    command_actions: &[codex_app_server_protocol::CommandAction],
) -> (Vec<String>, Vec<ParsedCommand>)
```

**Purpose**: Converts command execution data into two useful forms at once: a split command word list and a list of core parsed command actions. This gives the UI both the human command string broken into parts and the structured meaning of the command actions.

**Data flow**: It receives a raw command string and a list of protocol command actions → splits the command string into command words using `split_command_string` → converts each protocol action into the core parsed-command type → returns both results as a pair.

**Call relations**: This is the bridge between incoming command execution information and the chat widget’s internal command records. It hands the raw command text to `split_command_string` and converts each command action before returning the combined data to its caller.

*Call graph*: calls 1 internal fn (split_command_string); 1 external calls (iter).


### `tui/src/chatwidget/status_state.rs`

`domain_logic` · `main loop / UI status updates`

The chat widget needs to tell the user what is happening: working, thinking, waiting, retrying, or waiting for an approval review. This file is the small state box that remembers those messages between UI updates. Without it, the interface could lose track of the current footer text, show stale retry messages, or fail to combine multiple pending approval requests into a readable summary.

The main status shown to the user is stored as a `StatusIndicatorState`: a header like “Working”, optional detail text, and a limit for how many detail lines to display. A separate compact enum, `TerminalTitleStatusKind`, keeps the terminal title simple by reducing many possible UI states into a few short labels.

The most specific logic is for guardian review status. A “guardian review” is an approval request that is still waiting. `PendingGuardianReviewStatus` keeps a list of pending review entries, each with an id and a detail line. If one review is pending, the UI shows its detail directly. If several are pending, it shows a short bulleted list and says how many more exist if the list is long. This is like a receptionist grouping several waiting visitors into one neat lobby note.

`StatusState` ties these pieces together. It stores the current visible status, pending guardian reviews, terminal-title state, and a one-time saved status header used when retry-related UI needs to restore what was shown before.

#### Function details

##### `StatusIndicatorState::working`  (lines 13–19)

```
fn working() -> Self
```

**Purpose**: Creates the standard starting status for the chat widget: a simple “Working” message with no extra detail. This gives the UI a safe default before anything more specific happens.

**Data flow**: No outside information is needed. The function builds a new status object with the header set to “Working”, no detail text, and the usual maximum number of detail lines. The result is returned to the caller.

**Call relations**: Other parts of the chat widget can ask for this default status when they need a clean starting point. `StatusState::default` uses it when creating the overall status state.

*Call graph*: called by 1 (default); 1 external calls (from).


##### `StatusIndicatorState::is_guardian_review`  (lines 21–23)

```
fn is_guardian_review(&self) -> bool
```

**Purpose**: Checks whether the current status message is one of the approval-review messages. This lets callers tell whether the visible status belongs to the guardian review flow.

**Data flow**: It reads the status header text from the current object. If the header is exactly “Reviewing approval request” or starts with “Reviewing ”, it returns true; otherwise it returns false. Nothing is changed.

**Call relations**: This is a small helper used when other UI code needs to recognize that the current footer is review-related rather than an ordinary working or thinking message.


##### `PendingGuardianReviewStatus::start_or_update`  (lines 51–58)

```
fn start_or_update(&mut self, id: String, detail: String)
```

**Purpose**: Records that an approval review is pending, or updates the text for one that is already known. This keeps the pending-review list accurate when reviews start or their descriptions change.

**Data flow**: It receives a review id and a detail string. It looks for an existing entry with the same id. If it finds one, it replaces that entry’s detail text; if not, it adds a new entry to the list. It does not return a value, but it changes the stored review list.

**Call relations**: This function is used when the chat widget learns that a guardian approval request has begun or changed. Later, `PendingGuardianReviewStatus::status_indicator_state` can turn the updated list into the status text shown to the user.


##### `PendingGuardianReviewStatus::finish`  (lines 60–64)

```
fn finish(&mut self, id: &str) -> bool
```

**Purpose**: Marks one pending approval review as finished by removing it from the list. It also tells the caller whether anything was actually removed.

**Data flow**: It receives the id of a review. It compares the list size before and after removing entries with that id. It returns true if the list got shorter, and false if no matching review was found. The stored list may be changed.

**Call relations**: This fits the end of the guardian review flow. After a review completes, callers use this to remove it, then can ask whether any reviews remain or rebuild the visible status from the remaining entries.


##### `PendingGuardianReviewStatus::is_empty`  (lines 66–68)

```
fn is_empty(&self) -> bool
```

**Purpose**: Reports whether there are no pending approval reviews left. This is a quick way for the UI to know if the special review status should disappear.

**Data flow**: It reads the internal list of pending review entries. If the list has no entries, it returns true; otherwise it returns false. It does not change anything.

**Call relations**: Callers can use this after starting or finishing reviews to decide whether the guardian-review footer should still be shown or whether the normal status should be restored.


##### `PendingGuardianReviewStatus::status_indicator_state`  (lines 74–104)

```
fn status_indicator_state(&self) -> Option<StatusIndicatorState>
```

**Purpose**: Turns the current set of pending approval reviews into a user-facing status message. It creates either a single-review message or a compact summary of several reviews.

**Data flow**: It reads all stored pending review entries. With one entry, it uses that entry’s detail directly and shows the header “Reviewing approval request”. With several entries, it builds a bulleted list of up to three details, adds a “+N more” line if needed, and uses a plural header such as “Reviewing 2 approval requests”. With no entries, it returns no status. The stored list is not changed.

**Call relations**: After reviews are added with `start_or_update` or removed with `finish`, callers use this function to compute the footer snapshot that should be displayed while approval requests are still waiting. It uses formatting to build readable text for the UI.

*Call graph*: 2 external calls (from, format!).


##### `StatusState::default`  (lines 117–125)

```
fn default() -> Self
```

**Purpose**: Creates the initial full status state for a chat widget. This gives every status-related field a sensible starting value.

**Data flow**: No input is needed. It creates a current status using `StatusIndicatorState::working`, creates an empty guardian-review tracker, sets the terminal title kind to “Working”, clears any retry header, and says there is no pending status restore. It returns the completed state object.

**Call relations**: This is used when a chat widget is first created, including by setup code such as `new_with_op_target`. The retry-related test also uses it to start from a clean state.

*Call graph*: calls 1 internal fn (working); called by 2 (new_with_op_target, retry_status_header_is_taken_once); 1 external calls (default).


##### `StatusState::set_status`  (lines 129–131)

```
fn set_status(&mut self, status: StatusIndicatorState)
```

**Purpose**: Replaces the currently stored visible status with a new one. Callers use this when the UI should show a different status message.

**Data flow**: It receives a complete `StatusIndicatorState`. It assigns that object to `current_status`, replacing whatever was there before. It returns nothing.

**Call relations**: This is a simple update point for the wider chat widget. Other code decides what status should be shown, then hands that status to this function so the shared state matches the UI.


##### `StatusState::take_retry_status_header`  (lines 133–135)

```
fn take_retry_status_header(&mut self) -> Option<String>
```

**Purpose**: Retrieves and clears the saved retry status header. This makes the saved header a one-time value, so it cannot be restored twice by accident.

**Data flow**: It reads the optional saved retry header. If one exists, it removes it from the state and returns it. If none exists, it returns nothing. After this call, the stored retry header is empty.

**Call relations**: The retry restore flow calls this through `restore_retry_status_header_if_present` when it wants to put back the status header that was visible before retry UI took over.

*Call graph*: called by 1 (restore_retry_status_header_if_present).


##### `StatusState::remember_retry_status_header`  (lines 137–141)

```
fn remember_retry_status_header(&mut self)
```

**Purpose**: Saves the current status header so retry-related UI can restore it later. It only saves the first header, avoiding accidental overwrites during repeated retry updates.

**Data flow**: It checks whether a retry header is already saved. If not, it copies the current status header into `retry_status_header`. If one is already present, it leaves it unchanged. It returns nothing.

**Call relations**: This is used at the start of a retry-related status change. Later, `take_retry_status_header` can hand the saved header back and clear it.


##### `tests::guardian_status_aggregates_parallel_reviews`  (lines 151–164)

```
fn guardian_status_aggregates_parallel_reviews()
```

**Purpose**: Verifies that multiple pending guardian reviews are combined into one clear status message. This protects the UI behavior that summarizes parallel approval requests.

**Data flow**: The test starts with an empty pending-review state, adds two review entries, then asks for the derived status indicator. It compares the result with the expected plural header, two bullet lines, and a four-line display limit. The test passes only if the produced status matches exactly.

**Call relations**: This test exercises `PendingGuardianReviewStatus::start_or_update` and `PendingGuardianReviewStatus::status_indicator_state` together. It confirms that the list-building logic produces the footer text the chat widget relies on.

*Call graph*: 2 external calls (assert_eq!, default).


##### `tests::retry_status_header_is_taken_once`  (lines 167–178)

```
fn retry_status_header_is_taken_once()
```

**Purpose**: Verifies that a saved retry status header can be read back only once. This prevents old retry state from being reused after it has already been restored.

**Data flow**: The test creates a default status state, changes the current header to “Thinking”, saves it with `remember_retry_status_header`, then calls `take_retry_status_header` twice. The first call must return “Thinking”; the second must return nothing.

**Call relations**: This test checks the small retry-header lifecycle inside `StatusState`. It uses `StatusState::default`, then confirms that remembering and taking the retry header work together as intended.

*Call graph*: calls 1 internal fn (default); 1 external calls (assert_eq!).


### `tui/src/chatwidget/transcript.rs`

`domain_logic` · `chat turn handling and transcript updates`

This file is the chat widget’s notebook for transcript state. A chat transcript is not just a list of messages: while a response is streaming, the widget needs to know which cell is active, whether cached screen overlays are still valid, what the latest copyable assistant answer is, and what should happen if the visible conversation is rolled back.

The main type, `TranscriptState`, stores that bookkeeping. It tracks the active history cell, which is the transcript item currently being updated. It also keeps a revision number, like a ticket number, so cached display data can be rejected when the active cell changes.

A key job here is copy history. The widget stores recent completed assistant responses as raw Markdown, tied to how many user turns were visible when that response finished. This matters because the chat can roll back to an earlier point. If that happens, this file trims away copyable responses that belong to now-hidden future turns. If rollback removes everything the user wanted to copy, it records that too.

The file also resets flags at the start of a turn: whether this turn produced a copyable answer, did tool work, streamed a plan item, or updated plan progress. In everyday terms, it clears the desk before the next exchange so the UI does not accidentally reuse stale signs from the previous one.

#### Function details

##### `TranscriptState::new`  (lines 50–55)

```
fn new(active_cell: Option<Box<dyn HistoryCell>>) -> Self
```

**Purpose**: Creates a fresh transcript state, optionally starting with an active transcript cell already in place. This is used when the chat widget is being built and needs its transcript bookkeeping initialized.

**Data flow**: It receives an optional boxed `HistoryCell`, meaning an optional current transcript item. It fills that into a new `TranscriptState` and uses the default values for all other counters, flags, buffers, and history lists. The result is a ready-to-use state object.

**Call relations**: This is called by `new_with_op_target` during chat widget setup. It relies on the standard default setup for the many fields that should start empty or false, while preserving the active cell passed in by the caller.

*Call graph*: called by 1 (new_with_op_target); 1 external calls (default).


##### `TranscriptState::bump_active_cell_revision`  (lines 57–61)

```
fn bump_active_cell_revision(&mut self)
```

**Purpose**: Marks that the active transcript cell has changed in a way that can make cached display data outdated. It gives the active cell a new revision number, like stamping a newer version on a document.

**Data flow**: It reads the current `active_cell_revision`, adds one to it, and writes the result back. If the number is already at the largest possible `u64` value, it wraps back to zero instead of crashing or overflowing.

**Call relations**: This is called by the higher-level `bump_active_cell_revision` flow when the chat widget needs to invalidate transcript overlay caching. Nothing else is handed off; the changed revision number is the signal used later by display code.

*Call graph*: called by 1 (bump_active_cell_revision).


##### `TranscriptState::record_agent_markdown`  (lines 63–81)

```
fn record_agent_markdown(&mut self, markdown: String)
```

**Purpose**: Stores a completed assistant response as copyable Markdown. It keeps the latest answer easy to copy and also keeps a limited history of recent answers matched to visible user turns.

**Data flow**: It receives the assistant response text as a `String`. If the newest saved entry belongs to the current visible user-turn count, it replaces that entry; otherwise it adds a new entry. If the saved list grows past `MAX_AGENT_COPY_HISTORY`, it removes the oldest one. It then updates `last_agent_markdown`, clears the rollback-eviction warning, and notes that this turn produced a copy source.

**Call relations**: This is called by the higher-level `record_agent_markdown` path when an assistant response has finished and should be available for copying. It updates the state that later copy commands and rollback logic depend on.

*Call graph*: called by 1 (record_agent_markdown).


##### `TranscriptState::record_visible_user_turn`  (lines 83–85)

```
fn record_visible_user_turn(&mut self)
```

**Purpose**: Counts that one more user turn is now visible in the transcript. This count is used as an anchor for matching assistant responses to the conversation position where they were produced.

**Data flow**: It reads `visible_user_turn_count`, safely adds one, and writes the new count back. The safe add means it will not wrap around if the counter ever reached its maximum value.

**Call relations**: This is called by `record_visible_user_turn_for_copy` when a user message becomes part of the visible transcript. Later, `record_agent_markdown` uses this count to label the assistant response that follows.

*Call graph*: called by 1 (record_visible_user_turn_for_copy).


##### `TranscriptState::reset_copy_history`  (lines 87–93)

```
fn reset_copy_history(&mut self)
```

**Purpose**: Clears all stored copyable assistant responses and resets the user-turn copy counter. This is useful when the transcript context has changed so much that old copy history should no longer be trusted.

**Data flow**: It starts with whatever copy history and latest Markdown are currently stored. It removes the latest agent Markdown, empties the saved response list, sets the visible user-turn count back to zero, and clears the flags that say rollback evicted history or that this turn produced a copy source. The transcript state remains, but its copy-history memory is blank.

**Call relations**: No direct caller is listed in the provided graph, but this method is part of the transcript state API for any higher-level chat logic that needs to discard copy history after a reset or major transcript change.


##### `TranscriptState::truncate_copy_history_to_user_turn_count`  (lines 95–107)

```
fn truncate_copy_history_to_user_turn_count(&mut self, user_turn_count: usize)
```

**Purpose**: Cuts the copy history back to match a rolled-back transcript. If the visible chat is moved back to an earlier user turn, assistant responses from later turns must no longer be offered for copying.

**Data flow**: It receives the user-turn count that should remain visible. It updates `visible_user_turn_count` to that number, checks whether any copy history existed, and keeps only saved assistant responses whose recorded turn count is not beyond the new visible point. It then sets `last_agent_markdown` to the newest remaining response, or to nothing if none remain. If there used to be copy history but rollback removed it all, it records that eviction happened. It also clears the per-turn copy-source flag.

**Call relations**: No direct caller is listed in the provided graph, but this is the method higher-level rollback logic would use after removing later transcript entries. It prepares the state so future copy actions reflect only what the user can still see.


##### `TranscriptState::reset_turn_flags`  (lines 109–117)

```
fn reset_turn_flags(&mut self)
```

**Purpose**: Clears the temporary flags and buffers that belong only to the current chat turn. This prevents the next turn from inheriting stale information, such as an old plan update or a previous tool-use marker.

**Data flow**: It starts with the current per-turn markers, such as whether a copy source was seen, whether plan updates appeared, whether work activity happened, and any partially streamed plan text. It sets those booleans back to false, clears the latest proposed plan Markdown, empties the plan streaming buffer, and marks that no plan item is active. Longer-lived transcript data, such as copy history, is left alone.

**Call relations**: No direct caller is listed in the provided graph, but this method is intended for the chat-turn boundary. Higher-level orchestration can call it before or after a turn so the next exchange starts with clean per-turn state.


##### `tests::active_cell_revision_wraps`  (lines 127–136)

```
fn active_cell_revision_wraps()
```

**Purpose**: Checks that the active-cell revision counter safely wraps from the largest possible number back to zero. This confirms the cache-invalidation counter will not break at the numeric limit.

**Data flow**: The test creates a `TranscriptState` whose `active_cell_revision` is set to `u64::MAX`. It calls `bump_active_cell_revision`, then verifies that the revision became zero. The output is a passing or failing test result.

**Call relations**: This test exercises `TranscriptState::bump_active_cell_revision` directly. It uses an equality assertion to confirm the intended wraparound behavior.

*Call graph*: 2 external calls (assert_eq!, default).


##### `tests::copy_history_tracks_latest_visible_turn`  (lines 139–150)

```
fn copy_history_tracks_latest_visible_turn()
```

**Purpose**: Checks that copy history follows the visible transcript when the chat is rolled back. It proves that after returning to an earlier user turn, the latest copyable assistant response is also restored to the matching earlier answer.

**Data flow**: The test starts with an empty transcript state. It records a first visible user turn and assistant answer, then a second visible user turn and assistant answer. It truncates the copy history back to one user turn. It then verifies that the latest agent Markdown is `first` and that rollback did not mark the history as fully evicted.

**Call relations**: This test exercises `record_visible_user_turn`, `record_agent_markdown`, and `truncate_copy_history_to_user_turn_count` together. It shows how those methods cooperate during normal conversation and rollback.

*Call graph*: 3 external calls (assert!, assert_eq!, default).


### `tui/src/chatwidget/user_messages.rs`

`domain_logic` · `message composition, queue draining, restore, and chat history rendering`

A user message in this app is more than plain text. It can include local images, remote image URLs, pasted blocks, mentions, and marked text ranges that point to special UI elements. This file is the place where all of that is kept together so the chat widget can edit, queue, merge, restore, and display user input without losing meaning.

The main model is `UserMessage`, which stores the text plus attachments and text markers. `QueuedUserMessage` wraps a message that has been submitted but not yet fully processed. `ThreadComposerState` stores what is currently sitting in the input box. The file also tracks “pending steers,” which are user instructions waiting for the app-server to confirm them, and gives them small compare keys so duplicate pending rows can be suppressed.

A lot of the work here is about keeping placeholders honest. For example, if two queued drafts both contain `[Image #1]`, merging them would be confusing unless the second one is renamed to `[Image #2]`. The helper functions rebuild text and shift byte ranges so labels and clickable regions still point at the right content. Think of it like renumbering footnotes after combining two documents.

Finally, this file prepares messages for history display. It strips hidden prompt context when needed, keeps only visible text markers, and gathers image paths and URLs into a `UserMessageDisplay` that the chat UI can render.

#### Function details

##### `QueuedUserMessage::new`  (lines 67–73)

```
fn new(user_message: UserMessage, action: QueuedInputAction) -> Self
```

**Purpose**: Creates a queued user message from a real `UserMessage` and the action that should be taken with it. This is used when input has left the composer but still needs to be processed later.

**Data flow**: It receives a user message and a queued input action. It wraps them together and starts with an empty list of pending pasted blocks. The result is a `QueuedUserMessage` ready to sit in a queue.

**Call relations**: Other code uses this as the standard constructor for queued input. The `QueuedUserMessage::from` conversion also calls it when a plain user message should become a normal queued message.

*Call graph*: 1 external calls (new).


##### `QueuedUserMessage::into_user_message`  (lines 75–77)

```
fn into_user_message(self) -> UserMessage
```

**Purpose**: Unwraps a queued message and returns only the underlying user message. This is useful when the queue-specific details are no longer needed.

**Data flow**: It takes ownership of a `QueuedUserMessage`. It discards the queue action and pending paste list, then returns the stored `UserMessage`.

**Call relations**: This is a simple exit point from the queued-message wrapper. Code that has finished treating something as queued can use it to hand the plain message onward.


##### `QueuedUserMessage::from`  (lines 81–83)

```
fn from(user_message: UserMessage) -> Self
```

**Purpose**: Converts a plain `UserMessage` into a queued message using the default plain action. This saves callers from spelling out the common case.

**Data flow**: It receives a `UserMessage`, chooses `QueuedInputAction::Plain`, and passes both to `QueuedUserMessage::new`. The output is a queued version of the same message.

**Call relations**: This conversion is used when code such as `pop_next_queued_user_message` or `submit_user_message_with_history_and_shell_escape_policy` needs to put ordinary user input into the queue without special behavior.

*Call graph*: called by 2 (pop_next_queued_user_message, submit_user_message_with_history_and_shell_escape_policy); 1 external calls (new).


##### `QueuedUserMessage::deref`  (lines 89–91)

```
fn deref(&self) -> &Self::Target
```

**Purpose**: Lets a queued message be read like the `UserMessage` inside it. This is a convenience so code can inspect the message without manually reaching into the wrapper.

**Data flow**: It receives a reference to a `QueuedUserMessage` and returns a reference to its inner `UserMessage`. Nothing is copied or changed.

**Call relations**: This supports ergonomic access throughout the chat widget. When queue code only needs to read the message contents, it can treat the wrapper almost like the message itself.


##### `ThreadComposerState::has_content`  (lines 111–118)

```
fn has_content(&self) -> bool
```

**Purpose**: Checks whether the composer currently contains anything worth preserving. It counts not just typed text, but also images, marked text elements, mentions, and pending pasted content.

**Data flow**: It reads all fields of the composer state. If every field is empty, it returns `false`; if any kind of content is present, it returns `true`.

**Call relations**: This is used by higher-level chat-widget flows when deciding whether there is draft input to restore, merge, submit, or clear.


##### `UserMessage::from`  (lines 152–161)

```
fn from(text: &str) -> Self
```

**Purpose**: Builds a simple user message from plain text. It is the quick path for tests and callers that do not need images, mentions, or special text ranges.

**Data flow**: It receives either owned text or a string slice, puts that text into a new `UserMessage`, and fills every attachment and metadata list with empty lists. The result is a clean text-only message.

**Call relations**: Many chat-widget tests and reset or restore flows use this conversion when they only care about typed words. It appears in scenarios such as restoring inline questions, clearing queues, previewing queued categories, editing queued messages, and restoring interrupted prompts.

*Call graph*: called by 22 (side_restore_user_message_puts_inline_question_back_in_composer, clear_resets_all_input_queues, preview_keeps_queue_categories_separate, alt_up_edits_most_recent_queued_message, interrupt_prepends_queued_messages_before_existing_composer_text, interrupt_restores_queued_messages_into_composer, output_free_interrupted_turn_requests_prompt_restore, patch_activity_prevents_cancelled_turn_prompt_restore, thinking_status_keeps_cancelled_turn_prompt_restore_eligible, unbound_queued_message_edit_does_not_fall_back_to_alt_up (+12 more)); 1 external calls (new).


##### `create_initial_user_message`  (lines 171–196)

```
fn create_initial_user_message(
    text: Option<String>,
    local_image_paths: Vec<PathBuf>,
    text_elements: Vec<TextElement>,
) -> Option<UserMessage>
```

**Purpose**: Creates the first user message from startup or initial input, if there is actually something to send. It can combine optional text with local image paths.

**Data flow**: It receives optional text, a list of local image file paths, and text elements. If both the text and image list are empty, it returns `None`. Otherwise, it labels each local image with a placeholder like an image tag, builds a `UserMessage`, and returns it.

**Call relations**: This is an early construction helper. It turns raw initial inputs into the same structured message shape used everywhere else in the chat widget.

*Call graph*: 1 external calls (new).


##### `append_text_with_rebased_elements`  (lines 198–211)

```
fn append_text_with_rebased_elements(
    target_text: &mut String,
    target_text_elements: &mut Vec<TextElement>,
    text: &str,
    text_elements: impl IntoIterator<Item = TextElement>,
)
```

**Purpose**: Appends one piece of text to another while keeping its marked text ranges correct. This matters because marked ranges are measured by byte positions, and those positions change when text is added after existing text.

**Data flow**: It receives a target string, the target's text elements, new text, and the new text's elements. It remembers the current target length, appends the new text, shifts every incoming element by that length, and adds those shifted elements to the target list.

**Call relations**: This is the shared helper used when messages are merged and when display text is built from app-server input items. It keeps text and its annotations aligned after concatenation.

*Call graph*: called by 2 (user_message_display_from_inputs, merge_remapped_user_messages); 1 external calls (into_iter).


##### `app_server_text_elements`  (lines 213–215)

```
fn app_server_text_elements(elements: &[TextElement]) -> Vec<AppServerTextElement>
```

**Purpose**: Converts the TUI's text element format into the app-server protocol's text element format. This is needed when structured text information crosses from the terminal UI to the app-server layer.

**Data flow**: It receives a slice of local `TextElement` values. It clones each one, converts it into the app-server type, and returns the converted list.

**Call relations**: This is a boundary helper between the chat widget's internal model and the app-server protocol. It does not change meaning; it only changes the package the data travels in.

*Call graph*: 1 external calls (iter).


##### `build_placeholder_mapping`  (lines 217–233)

```
fn build_placeholder_mapping(
    local_images: Vec<LocalImageAttachment>,
    next_label: &mut usize,
) -> (HashMap<String, String>, Vec<LocalImageAttachment>)
```

**Purpose**: Renumbers local image placeholders and records how old labels map to new labels. This prevents combined messages from having duplicate labels like two different images both called `[Image #1]`.

**Data flow**: It receives local image attachments and a mutable next-label counter. For each image, it creates a fresh placeholder, records old placeholder to new placeholder in a map, moves the image path under the new placeholder, and advances the counter. It returns the mapping and the relabeled image list.

**Call relations**: This is called while remapping a message and its history record. Its mapping is then handed to the text-rebuilding helper so the visible text matches the relabeled attachments.

*Call graph*: calls 1 internal fn (local_image_label_text); called by 1 (remap_placeholders_for_message_and_history_record); 2 external calls (new, new).


##### `remap_placeholders_in_text`  (lines 235–280)

```
fn remap_placeholders_in_text(
    text: String,
    text_elements: Vec<TextElement>,
    mapping: &HashMap<String, String>,
) -> (String, Vec<TextElement>)
```

**Purpose**: Rewrites placeholder text and updates the matching text-element ranges. It is used when placeholders have been renamed and the visible message text must be kept in sync.

**Data flow**: It receives text, text elements, and a map from old placeholder names to new ones. If there is no mapping, it returns the inputs unchanged. Otherwise, it walks the marked elements in order, rebuilds the text piece by piece, replaces any mapped placeholder, updates each element's stored placeholder and byte range, and returns the rebuilt text and elements.

**Call relations**: This is the main text-repair tool used by paste-placeholder collision handling and by image-placeholder remapping. It is the function that makes renaming safe rather than just changing attachment metadata.

*Call graph*: called by 2 (remap_colliding_paste_placeholders, remap_placeholders_for_message_and_history_record); 2 external calls (new, new).


##### `remap_colliding_paste_placeholders`  (lines 282–308)

```
fn remap_colliding_paste_placeholders(
    mut message: UserMessage,
    mut pending_pastes: Vec<(String, String)>,
    used: &mut HashSet<String>,
) -> (UserMessage, Vec<(String, String)>)
```

**Purpose**: Renames pasted-content placeholders that would collide with placeholders already used elsewhere. This keeps multiple pasted blocks distinguishable in restored or merged input.

**Data flow**: It receives a user message, its pending pasted blocks, and a set of placeholder names already in use. For each paste placeholder, it either marks it as used or creates a unique replacement with a numbered suffix. It then rewrites the message text and text elements to use the new names, and returns the updated message and paste list.

**Call relations**: This is called during restore queue draining, where pending messages are being put back together. It hands the actual text rewriting to `remap_placeholders_in_text` after it has decided which names must change.

*Call graph*: calls 1 internal fn (remap_placeholders_in_text); called by 1 (drain_pending_messages_for_restore); 2 external calls (new, format!).


##### `remap_placeholders_for_message_and_history_record`  (lines 315–351)

```
fn remap_placeholders_for_message_and_history_record(
    message: UserMessage,
    history_record: UserMessageHistoryRecord,
    next_label: &mut usize,
) -> (UserMessage, UserMessageHistoryRecord)
```

**Purpose**: Renumbers a message's local image placeholders and applies the same change to its history display override. This keeps the restored draft and the transcript row saying the same thing.

**Data flow**: It receives a `UserMessage`, a history record, and the next image label counter. It relabels the message's local images, rewrites the message text and elements with the new labels, and, if the history record has its own non-empty display text, rewrites that too. It returns the updated message and updated history record.

**Call relations**: This function sits between placeholder mapping and whole-message merging. It calls `build_placeholder_mapping` to decide label changes and `remap_placeholders_in_text` to apply them. The test-only helper `remap_placeholders_for_message` uses it for message-only checks.

*Call graph*: calls 2 internal fn (build_placeholder_mapping, remap_placeholders_in_text); called by 1 (remap_placeholders_for_message); 1 external calls (Override).


##### `remap_placeholders_for_message`  (lines 354–364)

```
fn remap_placeholders_for_message(
    message: UserMessage,
    next_label: &mut usize,
) -> UserMessage
```

**Purpose**: Provides a test-only way to renumber image placeholders for a single message. It exists so tests can verify the remapping behavior without needing a history record.

**Data flow**: It receives a message and the next image label counter. It calls the full message-and-history remapper with a normal history setting, then returns only the remapped message.

**Call relations**: This is compiled only for tests. It is a thin wrapper around `remap_placeholders_for_message_and_history_record`.

*Call graph*: calls 1 internal fn (remap_placeholders_for_message_and_history_record).


##### `remap_user_messages_with_history_records`  (lines 366–384)

```
fn remap_user_messages_with_history_records(
    messages: Vec<(UserMessage, UserMessageHistoryRecord)>,
) -> Vec<(UserMessage, UserMessageHistoryRecord)>
```

**Purpose**: Renumbers image placeholders across a list of messages before they are merged. This avoids label collisions when several drafts are combined into one.

**Data flow**: It receives pairs of messages and their history records. It first counts all remote images so local image numbering can start after them, then walks the messages in order, remapping each one with a shared next-label counter. It returns the remapped pairs.

**Call relations**: Both `merge_user_messages` and `merge_user_messages_with_history_record` use this as their preparation step. It makes sure merging starts from clean, non-conflicting labels.

*Call graph*: called by 2 (merge_user_messages, merge_user_messages_with_history_record).


##### `merge_user_messages`  (lines 386–394)

```
fn merge_user_messages(messages: Vec<UserMessage>) -> UserMessage
```

**Purpose**: Combines several user messages into one message. It is useful when queued drafts or interrupted input need to become a single prompt.

**Data flow**: It receives a list of `UserMessage` values. It attaches a normal history marker to each one, remaps placeholders to avoid collisions, then merges the remapped messages into one. The output is a single `UserMessage` with combined text, images, remote URLs, mentions, and text elements.

**Call relations**: This is the simpler merge path for callers that do not need special history override behavior. It delegates remapping to `remap_user_messages_with_history_records` and final concatenation to `merge_remapped_user_messages`.

*Call graph*: calls 2 internal fn (merge_remapped_user_messages, remap_user_messages_with_history_records).


##### `merge_remapped_user_messages`  (lines 396–428)

```
fn merge_remapped_user_messages(messages: impl IntoIterator<Item = UserMessage>) -> UserMessage
```

**Purpose**: Joins already-renumbered messages into one combined message. It assumes placeholder conflicts have already been fixed.

**Data flow**: It starts with an empty combined message. For each input message, it adds a newline before every message after the first, appends the text while shifting text-element ranges, and extends the image, remote URL, and mention lists. It returns the fully combined message.

**Call relations**: This is called by both merge functions after their preparation work is done. It relies on `append_text_with_rebased_elements` so annotations still point to the right spans in the longer text.

*Call graph*: calls 1 internal fn (append_text_with_rebased_elements); called by 2 (merge_user_messages, merge_user_messages_with_history_record); 3 external calls (into_iter, new, new).


##### `user_message_for_restore`  (lines 430–444)

```
fn user_message_for_restore(
    message: UserMessage,
    history_record: &UserMessageHistoryRecord,
) -> UserMessage
```

**Purpose**: Chooses the text that should be put back into the composer when restoring a message. A history override can replace the stored message text if it has non-empty text.

**Data flow**: It receives a message and its history record. If the record contains a non-empty override, it returns a copy of the message with the override text and text elements. Otherwise, it returns the original message unchanged.

**Call relations**: This is used by `user_message_display_for_history` before building a display row. It keeps restore and display behavior consistent with any history-specific text.

*Call graph*: called by 1 (user_message_display_for_history).


##### `user_message_preview_text`  (lines 446–458)

```
fn user_message_preview_text(
    message: &UserMessage,
    history_record: Option<&UserMessageHistoryRecord>,
) -> String
```

**Purpose**: Returns the short text preview that should be shown for a user message. It respects a non-empty history override when one is present.

**Data flow**: It receives a message and an optional history record. If the record has a non-empty override, it returns that override text. Otherwise, it returns the message's own text.

**Call relations**: This is a lightweight read-only helper for preview surfaces. Unlike full display building, it only answers the question, “What text should the user see as the preview?”


##### `user_message_display_for_history`  (lines 460–475)

```
fn user_message_display_for_history(
    message: UserMessage,
    history_record: &UserMessageHistoryRecord,
) -> UserMessageDisplay
```

**Purpose**: Builds the display-ready form of a user message for the chat history. It applies any restore override and turns image attachments into paths and URLs the UI can render.

**Data flow**: It receives a full `UserMessage` and its history record. It first chooses the restored version of the message, then passes the text, text elements, local image paths, and remote image URLs into the chat widget display builder. The result is a `UserMessageDisplay`.

**Call relations**: This is called when a committed user message is being shown in history. It uses `user_message_for_restore` for override behavior and then hands off to `ChatWidget::user_message_display_from_parts` to do the final display projection.

*Call graph*: calls 1 internal fn (user_message_for_restore); called by 1 (on_committed_user_message); 1 external calls (user_message_display_from_parts).


##### `merge_user_messages_with_history_record`  (lines 477–524)

```
fn merge_user_messages_with_history_record(
    messages: Vec<(UserMessage, UserMessageHistoryRecord)>,
) -> (UserMessage, UserMessageHistoryRecord)
```

**Purpose**: Combines several messages and also creates the correct combined history record. This is needed when some messages have special history text that differs from the raw message sent to the agent.

**Data flow**: It receives message-and-history pairs. It first remaps placeholders across all of them. If every history record simply uses the message text, it keeps that simple history marker. Otherwise, it builds a combined override text by appending each visible history segment, shifting text-element ranges as it goes, and skipping empty override-only segments when appropriate. It returns the merged message and the merged history record.

**Call relations**: This is the full-featured merge path. It shares remapping with `merge_user_messages`, shares final message joining with `merge_remapped_user_messages`, and adds the extra work of preserving history overrides.

*Call graph*: calls 2 internal fn (merge_remapped_user_messages, remap_user_messages_with_history_records); 3 external calls (new, new, Override).


##### `ChatWidget::user_message_display_from_parts`  (lines 541–575)

```
fn user_message_display_from_parts(
        message: String,
        text_elements: Vec<TextElement>,
        local_images: Vec<PathBuf>,
        remote_image_urls: Vec<String>,
    ) -> UserMessageDi
```

**Purpose**: Creates the final display model for a user message from separate text, text elements, local image paths, and remote image URLs. It also hides any prompt-context prefix that should not be shown in the chat row.

**Data flow**: It receives raw message text plus its annotations and images. It extracts the visible prompt request and its offset within the original text. Then it keeps only text elements that fall inside the visible request and shifts their byte ranges so they line up with the shortened displayed text. It returns a `UserMessageDisplay` containing the visible message and image lists.

**Call relations**: This is the common final step for history display and input-item display. `user_message_display_for_history` and `ChatWidget::user_message_display_from_inputs` both hand their prepared pieces here so all chat surfaces strip prompt context the same way.

*Call graph*: 1 external calls (extract_prompt_request_with_offset).


##### `ChatWidget::pending_steer_compare_key_from_items`  (lines 581–599)

```
fn pending_steer_compare_key_from_items(
        items: &[UserInput],
    ) -> PendingSteerCompareKey
```

**Purpose**: Builds a small comparison key for a pending user instruction without doing full request serialization. The key is used to match a pending row with the committed message that later arrives from the app-server.

**Data flow**: It receives app-server user input items. It concatenates text items into one message string, counts image and local-image items, and ignores skill and mention items for this comparison. It returns a `PendingSteerCompareKey` containing the flattened message and total image count.

**Call relations**: This supports pending-steer duplicate suppression. Instead of asking the expensive full sending path for a comparison value, the chat widget can quickly compute the same practical identity from the input items.

*Call graph*: 1 external calls (new).


##### `ChatWidget::user_message_display_from_inputs`  (lines 601–640)

```
fn user_message_display_from_inputs(items: &[UserInput]) -> UserMessageDisplay
```

**Purpose**: Builds a display-ready user message directly from app-server `UserInput` items. This is used when the message arrives as protocol pieces rather than as the TUI's `UserMessage` model.

**Data flow**: It receives a list of user input items. It concatenates text items while converting and rebasing their text elements, collects remote image URLs, collects local image paths, and ignores skill and mention items for display text. It then passes the assembled parts to `user_message_display_from_parts` and returns the resulting `UserMessageDisplay`.

**Call relations**: This is the protocol-input display path. It uses `append_text_with_rebased_elements` while building one text string, then hands off to `ChatWidget::user_message_display_from_parts` so prompt-context stripping and element filtering match the rest of the UI.

*Call graph*: calls 1 internal fn (append_text_with_rebased_elements); 3 external calls (user_message_display_from_parts, new, new).


### `tui/src/chatwidget/command_lifecycle.rs`

`orchestration` · `during command execution and terminal interaction updates`

When the assistant runs commands, the terminal user interface needs to answer simple questions: What command started? Is it still running? Where should its output appear? Did it finish? This file is the command “lifecycle” part of `ChatWidget`, meaning it follows a command from birth to output to completion.

It separates normal command display from “unified exec” behavior. Unified exec is a shared execution mode where background terminal work can be shown in one status surface instead of scattering many small rows through the chat transcript. The file remembers which unified exec processes are active, keeps a short command name for each, and updates the footer in the bottom pane so the user sees what is still running.

For transcript rendering, it groups related command calls into an active `ExecCell`, which is the visible block that represents one or more command runs. Output chunks are appended to that block as they arrive. When a command ends, the code carefully decides whether to complete the current block, create a standalone history entry, or start a new block. This matters because command events can arrive out of the neat order a human expects. Without these checks, unrelated commands could be merged together, hidden, or marked finished incorrectly.

#### Function details

##### `ChatWidget::flush_unified_exec_wait_streak`  (lines 9–18)

```
fn flush_unified_exec_wait_streak(&mut self)
```

**Purpose**: This finishes a pending “waiting for background terminal” streak and turns it into a transcript entry. It is used when the UI has been showing a compact waiting status and now needs to record that wait in chat history.

**Data flow**: It reads the saved `unified_exec_wait_streak`, if one exists. If there is no saved wait, nothing changes. If there is one, it removes that saved state, marks that the transcript needs a separator before the final message, creates a history cell for the wait, sends that cell to be inserted into history, and restores the normal reasoning/status header.

**Call relations**: This is called when terminal activity changes or finishes. `on_terminal_interaction` uses it before showing real input after a waiting period or before switching to a different wait, and `on_command_execution_completed` uses it when the process being waited on ends.

*Call graph*: called by 2 (on_command_execution_completed, on_terminal_interaction); 4 external calls (new, new, InsertHistoryCell, new_unified_exec_interaction).


##### `ChatWidget::on_command_execution_started`  (lines 20–52)

```
fn on_command_execution_started(&mut self, item: ThreadItem)
```

**Purpose**: This is the first stop for a command-start event. It decides whether the event should be shown immediately, deferred, or only reflected in the unified execution status area.

**Data flow**: It receives a `ThreadItem` and first checks that it is actually a command execution item. It extracts the command details, clears any pending assistant answer stream with a separator, updates unified exec tracking when needed, and then either stops early for status-only cases or passes the event onward for normal rendering.

**Call relations**: This is called when the backend reports that a command has started. For unified exec startup commands it hands process tracking to `track_unified_exec_process_begin`; for commands that should appear in the transcript, it sends the event through the widget’s defer-or-handle path, which eventually reaches `handle_command_execution_started_now`.

*Call graph*: calls 1 internal fn (track_unified_exec_process_begin); 1 external calls (clone).


##### `ChatWidget::on_exec_command_output_delta`  (lines 54–73)

```
fn on_exec_command_output_delta(&mut self, call_id: &str, delta: &str)
```

**Purpose**: This receives a small new piece of command output and adds it to the visible command block if that block is currently on screen. It also remembers recent output for unified exec status tracking.

**Data flow**: It takes a command call id and a text delta. First it records the bytes with `track_unified_exec_output_chunk`. If no task is currently running, or if the active transcript cell is not an execution cell, it stops. Otherwise it appends the new text to the matching command inside the active cell, bumps the cell version, and asks the UI to redraw if anything changed.

**Call relations**: This function sits in the live-output path. It calls `track_unified_exec_output_chunk` so the unified exec process summary stays fresh, then updates the active `ExecCell` that was created by `handle_command_execution_started_now` and will later be finalized by `handle_command_execution_completed_now`.

*Call graph*: calls 1 internal fn (track_unified_exec_output_chunk).


##### `ChatWidget::on_terminal_interaction`  (lines 75–132)

```
fn on_terminal_interaction(&mut self, process_id: String, stdin: String)
```

**Purpose**: This records or displays interaction with a background terminal process. It treats empty input as “we are waiting for background output” and non-empty input as an actual terminal interaction to put in history.

**Data flow**: It receives a process id and stdin text. It looks up the matching unified exec command display name, if known. If stdin is empty, it updates the bottom pane to show a waiting status, stores or updates the current wait streak, and requests a redraw. If stdin has text, it flushes a matching wait streak if needed and adds a unified exec interaction cell to history.

**Call relations**: This function is used when terminal activity is reported separately from normal command start/end events. It calls `flush_unified_exec_wait_streak` when a previous compact wait must become a history entry, and it creates unified interaction cells for the transcript when there is actual input to show.

*Call graph*: calls 2 internal fn (flush_unified_exec_wait_streak, new); 1 external calls (new_unified_exec_interaction).


##### `ChatWidget::on_command_execution_completed`  (lines 134–163)

```
fn on_command_execution_completed(&mut self, item: ThreadItem)
```

**Purpose**: This is the first stop for a command-completed event. It cleans up unified exec state and then routes the completion to the rendering logic when appropriate.

**Data flow**: It receives a `ThreadItem` and verifies that it describes a command execution. For unified exec commands, it flushes any waiting streak tied to the process, removes the process from the active unified exec list, and may stop early if the UI is no longer showing a running task. Otherwise it clones the event and sends it through the same defer-or-handle path used by start events.

**Call relations**: This is called when the backend says a command is done. It uses `flush_unified_exec_wait_streak` and `track_unified_exec_process_end` for unified exec cleanup, then hands the event toward `handle_command_execution_completed_now` so the transcript cell can be finished safely.

*Call graph*: calls 2 internal fn (flush_unified_exec_wait_streak, track_unified_exec_process_end); 1 external calls (clone).


##### `ChatWidget::track_unified_exec_process_begin`  (lines 165–191)

```
fn track_unified_exec_process_begin(
        &mut self,
        call_id: &str,
        process_id: Option<&str>,
        command: &str,
    )
```

**Purpose**: This remembers that a unified exec process has started, along with a clean display version of its command. The bottom pane can then show the user which background process is active.

**Data flow**: It receives a call id, an optional process id, and the raw command text. It chooses a stable key, splits and cleans the command for display, then either updates an existing process summary or adds a new one. Finally it refreshes the unified exec footer.

**Call relations**: `on_command_execution_started` calls this for unified exec startup commands. After updating the internal process list, it calls `sync_unified_exec_footer` so the bottom pane reflects the new or changed process immediately.

*Call graph*: calls 1 internal fn (sync_unified_exec_footer); called by 1 (on_command_execution_started); 1 external calls (new).


##### `ChatWidget::track_unified_exec_process_end`  (lines 193–205)

```
fn track_unified_exec_process_end(
        &mut self,
        call_id: &str,
        process_id: Option<&str>,
    )
```

**Purpose**: This removes a unified exec process from the list of active background processes. It keeps the footer from showing commands that are no longer running.

**Data flow**: It receives a call id and optional process id, chooses the same key used when the process began, and removes any matching process summary. If the list actually changed, it refreshes the bottom pane footer.

**Call relations**: `on_command_execution_completed` calls this when a unified exec command finishes. It calls `sync_unified_exec_footer` only when something was removed, avoiding unnecessary UI updates.

*Call graph*: calls 1 internal fn (sync_unified_exec_footer); called by 1 (on_command_execution_completed).


##### `ChatWidget::sync_unified_exec_footer`  (lines 207–214)

```
fn sync_unified_exec_footer(&mut self)
```

**Purpose**: This copies the current list of active unified exec command names into the bottom pane. It is the small bridge between stored process summaries and what the user sees in the footer.

**Data flow**: It reads `unified_exec_processes`, extracts each process’s display command, collects those names into a list, and gives that list to the bottom pane. It does not create or remove processes itself.

**Call relations**: This is called after unified exec process tracking changes. `track_unified_exec_process_begin` uses it after adding or updating a process, and `track_unified_exec_process_end` uses it after removing one.

*Call graph*: called by 2 (track_unified_exec_process_begin, track_unified_exec_process_end).


##### `ChatWidget::track_unified_exec_output_chunk`  (lines 217–240)

```
fn track_unified_exec_output_chunk(&mut self, call_id: &str, chunk: &[u8])
```

**Purpose**: This keeps a tiny rolling memory of recent output lines for a unified exec process. That gives the UI a short, fresh hint of what a background command has been printing without storing everything here.

**Data flow**: It receives a command call id and raw output bytes. It finds the matching unified exec process, converts the bytes into readable text as safely as possible, trims and stores non-empty lines, and then keeps only the last three lines. If no matching process exists, it does nothing.

**Call relations**: `on_exec_command_output_delta` calls this for every output delta before updating the visible execution cell. It supports the unified exec status/footer side of the display, while the caller handles the transcript side.

*Call graph*: called by 1 (on_exec_command_output_delta); 1 external calls (from_utf8_lossy).


##### `ChatWidget::handle_command_execution_started_now`  (lines 242–313)

```
fn handle_command_execution_started_now(&mut self, item: ThreadItem)
```

**Purpose**: This immediately creates or updates the visible transcript block for a command that has started. It is the main start-rendering routine after any deferral rules have been resolved.

**Data flow**: It receives a command execution item, records that visible work is happening, parses and annotates the command, makes sure the status indicator is visible, and saves the command in `running_commands` so completion can match it later. It suppresses duplicate unified wait rows when needed. Otherwise it either adds the new call to the current active execution cell or creates a new active execution cell, then asks the UI to redraw.

**Call relations**: `on_command_execution_started` routes eligible start events here through the widget’s defer-or-handle mechanism. The command state saved here is later removed and used by `handle_command_execution_completed_now` so the finish event can use the same command text, source, and parsed meaning that were shown at the start.

*Call graph*: calls 1 internal fn (new); 2 external calls (new, matches!).


##### `ChatWidget::handle_command_execution_completed_now`  (lines 323–458)

```
fn handle_command_execution_completed_now(&mut self, item: ThreadItem)
```

**Purpose**: This finalizes a command in the transcript when it finishes. It is careful not to accidentally attach a completion event to the wrong active command block.

**Data flow**: It receives a command completion item, extracts the command, output, exit code, and duration, and looks up any matching running command state saved at start time. If the call was previously suppressed as a duplicate wait, it stops. Otherwise it builds the final output record and decides where the finished command belongs: inside the active execution cell, as a standalone history entry while another command group stays active, or as a new cell. It updates history or the active cell, marks that work happened, and may send queued shell input if this was a user shell command.

**Call relations**: `on_command_execution_completed` routes completion events here after unified exec cleanup and any deferral. It completes cells that were created or extended by `handle_command_execution_started_now`, but it can also create an orphan history entry when events arrive for a command that is not part of the current active execution group.

*Call graph*: 6 external calls (new, from_millis, new, InsertHistoryCell, debug_assert!, matches!).


### `tui/src/chatwidget/hook_lifecycle.rs`

`domain_logic` · `request handling and redraw timing`

This file is about the life cycle of hook output inside `ChatWidget`, the terminal chat interface. A hook is a separate action reported by the app, such as a background check or helper command. While it is running, the user needs to see live status. Once it finishes, the output should stop being a temporary status line and become part of the chat history if it is worth keeping.

The file treats the live hook display like a sticky note on the screen. While work is still happening, the sticky note can change. When the work is done, the note is either thrown away if empty, or pasted into the transcript as a history cell.

The main state is `active_hook_cell`, which holds the currently visible hook information. When a hook starts, the widget records activity, clears out any completed hook output that should already be in history, and either adds the new run to the existing hook cell or creates a new one. When a hook completes, the code marks the matching run as done, collects completed output, inserts persistent output into history, and removes or flushes the active cell when it has nothing live left to show.

The file also schedules small timer updates. These timers let running hook cells animate or reveal time-based changes without waiting for another user action.

#### Function details

##### `ChatWidget::clear_active_hook_cell`  (lines 10–15)

```
fn clear_active_hook_cell(&mut self)
```

**Purpose**: Clears the temporary hook display without saving it into the chat history. This is useful when the live status should simply disappear rather than become a permanent transcript entry.

**Data flow**: It looks at `active_hook_cell`, the current live hook display. If one exists, it removes it, marks the visible cell area as changed, and asks for any pending usage output to be inserted later. Nothing is returned; the widget's internal display state is changed.

**Call relations**: This is a cleanup helper for the chat widget's hook state. Unlike the completion paths in this file, it does not hand a cell to history insertion; it only drops the live cell and updates the surrounding UI bookkeeping.


##### `ChatWidget::on_hook_started`  (lines 17–35)

```
fn on_hook_started(&mut self, run: codex_app_server_protocol::HookRunSummary)
```

**Purpose**: Updates the chat screen when the app reports that a hook run has started. It makes sure the user sees the new running hook in the live area of the chat.

**Data flow**: It receives a `HookRunSummary`, which is a compact report describing the hook run. Before showing it, it records that visible activity happened, finishes any answer text that was streaming, and moves any already completed hook output into history. Then it either adds the new run to the existing active hook cell or creates a fresh active hook cell, marks that live cell as changed, and requests a redraw.

**Call relations**: When a hook-start event reaches the widget, this function prepares the display for a new live run. It first calls `ChatWidget::flush_completed_hook_output` so old completed hook output does not stay mixed with the new live status. If there is no live hook cell yet, it asks `history_cell::new_active_hook_cell` to build one for the incoming run.

*Call graph*: calls 1 internal fn (flush_completed_hook_output); 1 external calls (new_active_hook_cell).


##### `ChatWidget::on_hook_completed`  (lines 37–67)

```
fn on_hook_completed(
        &mut self,
        completed: codex_app_server_protocol::HookRunSummary,
    )
```

**Purpose**: Updates the chat screen when the app reports that a hook run has finished. It turns live hook status into completed output, then decides whether that output should be inserted into the permanent transcript or the live area should remain visible.

**Data flow**: It receives a completed `HookRunSummary`. If an active hook cell already contains that run, it marks that run as complete. If not, it adds the completed run to the current cell, or creates a completed hook cell if there is no active cell. It then flushes completed persistent output into history, checks whether the remaining live cell is idle or ready to be moved into history, and requests a redraw.

**Call relations**: This is the completion counterpart to `ChatWidget::on_hook_started`. It calls `ChatWidget::flush_completed_hook_output` to move finished persistent runs into the transcript, and then calls `ChatWidget::finish_active_hook_cell_if_idle` to remove or archive the active cell if nothing still needs to be shown live. If a completed report arrives without an active cell, it uses `history_cell::new_completed_hook_cell` to create a suitable cell.

*Call graph*: calls 2 internal fn (finish_active_hook_cell_if_idle, flush_completed_hook_output); 1 external calls (new_completed_hook_cell).


##### `ChatWidget::flush_completed_hook_output`  (lines 69–89)

```
fn flush_completed_hook_output(&mut self)
```

**Purpose**: Moves completed hook output out of the temporary live hook cell and into the permanent chat history. This prevents finished hook details from lingering forever in the live status area.

**Data flow**: It asks the active hook cell for any completed runs that should be kept permanently. If there are none, it does nothing. If completed output exists, it removes it from the active cell, clears the active cell if it became empty, marks the live area as changed, tells the transcript that the next final message needs a separator, sends an `InsertHistoryCell` event containing the completed cell, and asks for pending usage output insertion.

**Call relations**: Both `ChatWidget::on_hook_started` and `ChatWidget::on_hook_completed` call this function. On start, it clears away previously completed hook output before a new live run appears. On completion, it archives the just-finished output. It hands the finished cell to the wider app by sending an `AppEvent::InsertHistoryCell` event.

*Call graph*: called by 2 (on_hook_completed, on_hook_started); 2 external calls (new, InsertHistoryCell).


##### `ChatWidget::finish_active_hook_cell_if_idle`  (lines 91–110)

```
fn finish_active_hook_cell_if_idle(&mut self)
```

**Purpose**: Checks whether the live hook cell is done showing anything useful, and either removes it or moves it into history. This keeps the chat screen from showing stale hook status.

**Data flow**: It first looks for an active hook cell. If there is none, it returns. If the cell is empty, it removes it, marks the live area as changed, and asks for pending usage output insertion. If the cell says it should be flushed, it takes the whole cell, marks the live area as changed, flags that the transcript needs a separator, sends an `InsertHistoryCell` event, and asks for pending usage output insertion.

**Call relations**: `ChatWidget::on_hook_completed` calls this after processing completed hook output, because a finished hook may leave nothing live to display. `ChatWidget::update_due_hook_visibility` also calls it after time-based visibility changes, because a cell may become ready to disappear or be archived after a timer update.

*Call graph*: called by 2 (on_hook_completed, update_due_hook_visibility); 2 external calls (new, InsertHistoryCell).


##### `ChatWidget::update_due_hook_visibility`  (lines 112–121)

```
fn update_due_hook_visibility(&mut self)
```

**Purpose**: Advances any time-based display changes for the active hook cell. This is what lets hook status change over time, such as animations or delayed visibility updates.

**Data flow**: It checks whether an active hook cell exists. If so, it reads the current time, asks the cell to advance to that time, and marks the live cell as changed if the cell's visible state changed. After that, it checks whether the cell has become idle and should be removed or saved into history.

**Call relations**: This function is used when a scheduled hook timer comes due. It calls the system clock through `Instant::now`, lets the hook cell update itself, and then calls `ChatWidget::finish_active_hook_cell_if_idle` to clean up if that time update made the live cell no longer necessary.

*Call graph*: calls 1 internal fn (finish_active_hook_cell_if_idle); 1 external calls (now).


##### `ChatWidget::schedule_hook_timer_if_needed`  (lines 123–143)

```
fn schedule_hook_timer_if_needed(&self)
```

**Purpose**: Schedules future redraws for hook cells that still need time-based updates. Without this, running hook animations or delayed hook visibility changes could freeze until some unrelated event caused a redraw.

**Data flow**: It reads the widget configuration and the active hook cell. If animations are enabled and a running hook is visibly active, it asks for another frame in about 50 milliseconds. It also asks the hook cell whether it has a specific next deadline, calculates how long from now that deadline is, and schedules a frame for that delay. It returns nothing; it only schedules future work through the frame requester.

**Call relations**: This function supports `ChatWidget::update_due_hook_visibility`: it arranges for the future frame that will later give the widget a chance to update hook visibility. It uses `Duration::from_millis` for the short animation tick and `Instant::now` to turn an absolute deadline into a delay.

*Call graph*: 2 external calls (from_millis, now).


### `tui/src/chatwidget/turn_runtime.rs`

`orchestration` · `active during each agent turn, from turn start through completion or error cleanup`

A “turn” is one round where the user asks something and the agent works on it. This file is the ChatWidget’s turn control desk. When a turn starts, it clears old temporary state, shows the working indicator, resets metrics, and prepares the transcript for new output. While the turn runs, it can collect runtime metrics, such as WebSocket timing, and add readable summaries to the chat history. When the turn completes, it finalizes any live streamed answer or plan, adds separators and usage details if useful, updates notifications, and decides whether to send the next queued user message.

The file also covers unhappy paths. If the server is overloaded, the user hits a rate limit, a policy blocks the request, or a general error happens, it stops the turn safely and writes an appropriate warning or error into the history. This matters because the terminal UI has many moving parts: live spinners, streamed text, plan previews, queued inputs, status headers, pet notifications, and bottom-pane hints. Without this file, a failed or completed turn could leave the app looking like it is still running, lose the final answer, or prompt the user at the wrong time.

A useful analogy is a stage manager: it cues the lights when the agent begins, records what happened during the scene, clears the props when the scene ends, and tells the next actor when to enter.

#### Function details

##### `ChatWidget::update_task_running_state`  (lines 13–19)

```
fn update_task_running_state(&mut self)
```

**Purpose**: This refreshes the bottom-pane indicator that tells the user whether something is currently running. It treats the indicator as true if either an agent turn is active or MCP startup is still in progress; MCP is an external tool/server startup process used by the app.

**Data flow**: It reads the current agent-turn lifecycle and MCP startup status. It combines those into one yes-or-no running value, writes that to the bottom pane, then refreshes nearby UI surfaces such as plan-mode nudges and status text.

**Call relations**: This is called whenever the turn state changes: when a task starts, when it completes, and when cleanup finalizes a stopped turn. Those callers do the detailed state changes first, then call this so the visible UI matches the new reality.

*Call graph*: called by 3 (finalize_turn, on_task_complete, on_task_started).


##### `ChatWidget::collect_runtime_metrics_delta`  (lines 21–25)

```
fn collect_runtime_metrics_delta(&mut self)
```

**Purpose**: This asks the session telemetry system whether any new runtime measurements are available and, if so, applies them to the current turn. Telemetry here means small measurements about how the agent run performed.

**Data flow**: It reads a possible metrics summary from session telemetry. If there is a new summary, it passes that summary into the metric-application step; if there is none, it leaves the widget unchanged.

**Call relations**: It is used by `ChatWidget::refresh_runtime_metrics` for a simple refresh, and by `ChatWidget::on_task_complete` before the final turn summary is written. It hands actual merging work to `ChatWidget::apply_runtime_metrics_delta`.

*Call graph*: calls 1 internal fn (apply_runtime_metrics_delta); called by 2 (on_task_complete, refresh_runtime_metrics).


##### `ChatWidget::apply_runtime_metrics_delta`  (lines 27–33)

```
fn apply_runtime_metrics_delta(&mut self, delta: RuntimeMetricsSummary)
```

**Purpose**: This folds a new batch of runtime measurements into the accumulated metrics for the current turn. It also decides whether WebSocket timing should be shown in the chat history; a WebSocket is a long-lived network connection used for back-and-forth messages.

**Data flow**: It receives a runtime metrics summary. It checks whether that summary contains timing information worth logging, merges the summary into the turn’s stored metrics, and, when timing exists, asks another function to add a readable timing line to history.

**Call relations**: It is called by `ChatWidget::collect_runtime_metrics_delta`, which gathers the new metrics. When timing details should be visible, it delegates the history-writing part to `ChatWidget::log_websocket_timing_totals`.

*Call graph*: calls 1 internal fn (log_websocket_timing_totals); called by 1 (collect_runtime_metrics_delta).


##### `ChatWidget::log_websocket_timing_totals`  (lines 35–41)

```
fn log_websocket_timing_totals(&mut self, delta: RuntimeMetricsSummary)
```

**Purpose**: This writes a short human-readable WebSocket timing summary into the chat history. It is meant to make network timing visible without exposing raw measurement data.

**Data flow**: It receives a metrics summary, extracts the Responses API timing portion, and asks a helper to turn that into a label. If a label exists, it appends a dim, bullet-style line to the transcript history; if not, it writes nothing.

**Call relations**: It is called only from `ChatWidget::apply_runtime_metrics_delta`, after that function has detected timing metrics. It relies on external formatting helpers to produce the label and the styled history line.

*Call graph*: calls 1 internal fn (responses_api_summary); called by 1 (apply_runtime_metrics_delta); 2 external calls (runtime_metrics_label, vec!).


##### `ChatWidget::refresh_runtime_metrics`  (lines 43–45)

```
fn refresh_runtime_metrics(&mut self)
```

**Purpose**: This is a small refresh hook for runtime measurements. It exists so other code can ask the widget to pull in any latest performance data without knowing the details.

**Data flow**: It takes no outside data directly. It simply calls the collector, which may read new telemetry and merge it into the current turn’s stored metrics.

**Call relations**: It is a thin wrapper around `ChatWidget::collect_runtime_metrics_delta`. Any caller that wants a metrics refresh can use this function instead of calling the collector directly.

*Call graph*: calls 1 internal fn (collect_runtime_metrics_delta).


##### `ChatWidget::on_task_started`  (lines 49–79)

```
fn on_task_started(&mut self)
```

**Purpose**: This prepares the whole chat UI for a new agent turn. It clears stale state from the previous turn, starts timers and lifecycle flags, shows interrupt controls, and marks the interface as working.

**Data flow**: Before this runs, the widget may contain old stream buffers, status hints, metrics, quit shortcuts, and transcript flags. It resets those turn-specific pieces, starts the turn lifecycle with the current time, sets the status to “Working” when appropriate, clears reasoning buffers, updates the running indicator, sends a running pet notification, and requests a redraw.

**Call relations**: This is the turn-start entry point inside the widget. After changing internal state, it calls `ChatWidget::update_task_running_state` so the bottom pane reflects that work is underway. It also uses standard helpers for the current time and default metric values.

*Call graph*: calls 1 internal fn (update_task_running_state); 3 external calls (now, from, default).


##### `ChatWidget::on_task_complete`  (lines 81–208)

```
fn on_task_complete(
        &mut self,
        last_agent_message: Option<String>,
        duration_ms: Option<i64>,
        from_replay: bool,
    )
```

**Purpose**: This finishes a successful agent turn and turns all live output into stable history. It also decides whether to notify the user, prompt for plan implementation, or immediately start the next queued input.

**Data flow**: It receives the final agent message if one was supplied, an optional duration, and a flag saying whether this completion came from replay rather than a live run. It sanitizes the final message, records it only if no better copy source was already captured, finalizes answer and plan streams, gathers final metrics, writes separators and summaries when needed, clears running state, updates notifications and previews, and may send the next queued message. Its output is changed widget state, updated chat history, possible app events, possible notifications, and a redraw request.

**Call relations**: This is one of the main turn-ending paths. It calls `ChatWidget::collect_runtime_metrics_delta` before writing the final separator, `ChatWidget::update_task_running_state` after stopping the lifecycle, checks `ChatWidget::has_queued_follow_up_messages`, and may call `ChatWidget::maybe_prompt_plan_implementation`. It also emits a plan-consolidation app event when a streamed plan needs to be consolidated.

*Call graph*: calls 6 internal fn (agent_turn_preview, collect_runtime_metrics_delta, has_queued_follow_up_messages, maybe_prompt_plan_implementation, update_task_running_state, new); 2 external calls (ConsolidateProposedPlan, default).


##### `ChatWidget::maybe_prompt_plan_implementation`  (lines 210–235)

```
fn maybe_prompt_plan_implementation(&mut self)
```

**Purpose**: This decides whether to ask the user if they want to implement a plan the agent just produced. It prevents the prompt from appearing when it would be confusing, such as during another popup, outside plan mode, or when a follow-up message is already queued.

**Data flow**: It reads collaboration-mode settings, queued input state, the current mode, whether a plan appeared this turn, popup/modal state, and rate-limit prompt state. If every condition says it is safe and useful, it opens the plan implementation prompt; otherwise it returns without changing the UI.

**Call relations**: It is called from `ChatWidget::on_task_complete`, after a turn ends and before the next queued input may begin. It calls `ChatWidget::has_queued_follow_up_messages` as one guard and `ChatWidget::open_plan_implementation_prompt` when the prompt should actually be shown.

*Call graph*: calls 2 internal fn (has_queued_follow_up_messages, open_plan_implementation_prompt); called by 1 (on_task_complete); 1 external calls (matches!).


##### `ChatWidget::open_plan_implementation_prompt`  (lines 237–250)

```
fn open_plan_implementation_prompt(&mut self)
```

**Purpose**: This displays the prompt that lets the user choose how to proceed with implementing a proposed plan. It includes useful context, such as the latest plan text and how much conversation context has already been used.

**Data flow**: It calculates the default collaboration-mode choice, asks for a context-usage label, and builds selection-view parameters using the latest proposed plan. It then tells the bottom pane to show the selection view and sends a notification that the plan-mode prompt appeared.

**Call relations**: It is called by `ChatWidget::maybe_prompt_plan_implementation` after all safety checks pass. It uses `ChatWidget::plan_implementation_context_usage_label` for the context label and external helpers to build the mode mask and selection-view settings.

*Call graph*: calls 3 internal fn (selection_view_params, plan_implementation_context_usage_label, default_mode_mask); called by 1 (maybe_prompt_plan_implementation).


##### `ChatWidget::plan_implementation_context_usage_label`  (lines 259–279)

```
fn plan_implementation_context_usage_label(&self) -> Option<String>
```

**Purpose**: This creates a short label such as “35% used” for the plan implementation prompt. The label helps the user understand whether clearing prior conversation context might be worthwhile before implementing a plan.

**Data flow**: It reads token information, where tokens are chunks of text used to measure model context size. If the remaining-context percentage is known, it converts that into used percentage and returns it when greater than zero. If percentage is unknown but used-token count is known and positive, it returns a compact token count. If there is no meaningful evidence of context use, it returns nothing.

**Call relations**: It is called by `ChatWidget::open_plan_implementation_prompt` while building the prompt. Its result becomes optional footer text in that prompt.

*Call graph*: called by 1 (open_plan_implementation_prompt); 1 external calls (format!).


##### `ChatWidget::has_queued_follow_up_messages`  (lines 281–283)

```
fn has_queued_follow_up_messages(&self) -> bool
```

**Purpose**: This answers whether there are user messages waiting to be sent after the current turn. It hides the details of the input queue behind a simple yes-or-no question.

**Data flow**: It reads the widget’s input queue and returns whether that queue contains follow-up messages. It does not change any state.

**Call relations**: It is used by `ChatWidget::on_task_complete` to decide whether the agent is truly waiting for the user, and by `ChatWidget::maybe_prompt_plan_implementation` to avoid showing a prompt when another user message is already lined up.

*Call graph*: called by 2 (maybe_prompt_plan_implementation, on_task_complete).


##### `ChatWidget::handle_app_server_steer_rejected_error`  (lines 285–293)

```
fn handle_app_server_steer_rejected_error(
        &mut self,
        codex_error_info: &AppServerCodexErrorInfo,
    ) -> bool
```

**Purpose**: This handles a specific server response saying that a mid-turn steering message was rejected because the active turn cannot be steered. A steering message is an extra instruction sent while the agent is already working.

**Data flow**: It receives structured server error information. If the error is the specific “active turn not steerable” kind, it tries to enqueue the rejected steer for later and returns whether that succeeded. For other errors, it returns false and leaves broader error handling to someone else.

**Call relations**: Although no direct caller is shown in the provided call facts, this is the specialized helper used by the non-retry error flow. It lets that broader flow treat a rejected steer as recoverable when the message can be queued instead of shown as a normal failure.

*Call graph*: 1 external calls (matches!).


##### `ChatWidget::finalize_turn`  (lines 299–326)

```
fn finalize_turn(&mut self)
```

**Purpose**: This force-cleans a turn that is ending because of cancellation or error. It makes sure no live spinner, temporary stream tail, or running command state is left behind.

**Data flow**: It starts with a widget that may still have live streamed output, active command cells, hook rows, running flags, and buffers. It drops preview-only stream tails, marks any active cell as failed, clears transient rows and queues, finishes the turn lifecycle, updates the running indicator, resets stream controllers and chunking, refreshes status information, and checks for pending rate-limit prompts.

**Call relations**: This is the shared cleanup step for error paths. `ChatWidget::on_server_overloaded_error`, `ChatWidget::on_error`, and `ChatWidget::on_cyber_policy_error` call it before adding their specific warning or error messages. It calls `ChatWidget::update_task_running_state` so the UI stops showing the agent as running unless MCP startup is still active.

*Call graph*: calls 1 internal fn (update_task_running_state); called by 3 (on_cyber_policy_error, on_error, on_server_overloaded_error).


##### `ChatWidget::on_server_overloaded_error`  (lines 328–341)

```
fn on_server_overloaded_error(&mut self, message: String)
```

**Purpose**: This responds when the server says it is too busy to handle the request. It stops the current turn, shows a warning rather than a generic crash-style error, and then tries to continue with queued input if possible.

**Data flow**: It receives a server message. It clears pending steering behavior, finalizes the turn, substitutes a default high-load message if the server message is empty, adds a warning event to history, requests a redraw, and tries to send the next queued input.

**Call relations**: It is called by `ChatWidget::handle_non_retry_error` when that function recognizes a server-overloaded rate-limit kind. It uses `ChatWidget::finalize_turn` for cleanup and an external history helper to create the warning event.

*Call graph*: calls 1 internal fn (finalize_turn); called by 1 (handle_non_retry_error); 1 external calls (new_warning_event).


##### `ChatWidget::on_error`  (lines 343–356)

```
fn on_error(&mut self, message: String)
```

**Purpose**: This is the general error-ending path for a turn. It stops streaming, cleans up the turn, records the error for the user, and marks the ambient pet notification as failed.

**Data flow**: It receives an error message. It clears steering-after-interrupt state, flushes any streamed answer with a separator, finalizes the turn, adds an error event to history, updates the pet notification to failed, asks for a redraw, and then tries to send the next queued input.

**Call relations**: It is called directly by `ChatWidget::handle_non_retry_error` for ordinary non-retryable errors and by `ChatWidget::on_rate_limit_error` for several rate-limit cases. It relies on `ChatWidget::finalize_turn` for the common cleanup work.

*Call graph*: calls 1 internal fn (finalize_turn); called by 2 (handle_non_retry_error, on_rate_limit_error); 1 external calls (new_error_event).


##### `ChatWidget::on_cyber_policy_error`  (lines 358–366)

```
fn on_cyber_policy_error(&mut self)
```

**Purpose**: This handles a policy-blocked request for the cyber-related safety flow. It stops the turn and adds a special policy error message to the chat history.

**Data flow**: It clears steering-after-interrupt state, finalizes the turn, appends a cyber policy error event, requests a redraw, and then tries to send any queued next input.

**Call relations**: It is called by `ChatWidget::handle_non_retry_error` when the structured server error matches the cyber policy case. It shares the same cleanup path as other failures through `ChatWidget::finalize_turn`.

*Call graph*: calls 1 internal fn (finalize_turn); called by 1 (handle_non_retry_error); 1 external calls (new_cyber_policy_error_event).


##### `ChatWidget::on_rate_limit_error`  (lines 368–411)

```
fn on_rate_limit_error(&mut self, error_kind: RateLimitErrorKind, message: String)
```

**Purpose**: This turns different kinds of rate-limit or credit-limit failures into the most helpful user-facing response. A rate limit means the service is refusing more work for now or until account limits change.

**Data flow**: It receives a rate-limit kind and message. It adjusts the stored limit-reached type when a usage-limit error should be shown instead of a credit-depleted error, then chooses what to do: show a tailored owner message, show the server message, or open a nudge asking a workspace owner to add credits or raise usage limits. Most branches finish by calling the general error path.

**Call relations**: It is called by `ChatWidget::handle_non_retry_error` when the structured error is a usage-limit or generic rate-limit case. It delegates ordinary display and cleanup to `ChatWidget::on_error`, and adds workspace-owner nudges for member-specific limit cases.

*Call graph*: calls 1 internal fn (on_error); called by 1 (handle_non_retry_error); 1 external calls (matches!).


##### `ChatWidget::handle_non_retry_error`  (lines 413–440)

```
fn handle_non_retry_error(
        &mut self,
        message: String,
        codex_error_info: Option<AppServerCodexErrorInfo>,
    )
```

**Purpose**: This is the dispatcher for errors that should not simply be retried. It looks at structured server details, when available, and routes the error to the most specific handler.

**Data flow**: It receives a plain error message and optional structured server error information. It first checks whether a rejected steer can be queued instead of shown as a failure. If not, it checks for cyber policy errors, server overload, usage limits, or generic rate limits. If none of those match, it treats the message as a normal error.

**Call relations**: This function sits above the specific error handlers. It calls `ChatWidget::on_cyber_policy_error`, `ChatWidget::on_server_overloaded_error`, `ChatWidget::on_rate_limit_error`, or `ChatWidget::on_error` depending on what the server reported.

*Call graph*: calls 4 internal fn (on_cyber_policy_error, on_error, on_rate_limit_error, on_server_overloaded_error).


##### `ChatWidget::on_warning`  (lines 442–449)

```
fn on_warning(&mut self, message: impl Into<String>)
```

**Purpose**: This adds a warning message to the chat history, but only if the warning display policy says it should be shown. That avoids repeating the same warning too often.

**Data flow**: It accepts any value that can become a string, converts it into a message, and asks the warning display state whether this message should appear. If yes, it appends a warning event to history and requests a redraw; if no, it does nothing.

**Call relations**: It is called by `ChatWidget::on_app_server_model_verification` when server verification data implies the user should be warned. It uses an external helper to create the warning history event.

*Call graph*: called by 1 (on_app_server_model_verification); 2 external calls (into, new_warning_event).


##### `ChatWidget::on_app_server_model_verification`  (lines 451–458)

```
fn on_app_server_model_verification(
        &mut self,
        verifications: &[AppServerModelVerification],
    )
```

**Purpose**: This reacts to model-verification information sent by the app server. In particular, it warns the user when trusted access for cyber-related behavior is involved.

**Data flow**: It receives a list of verification markers from the server. If the list contains the trusted-access-for-cyber marker, it sends a predefined warning through the normal warning path; otherwise it changes nothing.

**Call relations**: This function calls `ChatWidget::on_warning` so warning filtering and history display stay centralized. It uses the list membership check to decide whether that warning is needed.

*Call graph*: calls 1 internal fn (on_warning); 1 external calls (contains).


##### `ChatWidget::on_plan_update`  (lines 460–474)

```
fn on_plan_update(&mut self, update: UpdatePlanArgs)
```

**Purpose**: This records a plan update from the agent and updates progress information shown elsewhere in the UI. A plan is a list of steps the agent intends to follow.

**Data flow**: It receives the updated plan. It marks that a plan update happened this turn, counts total steps and completed steps, stores progress when the plan is non-empty, refreshes status surfaces, and appends a plan-update history cell.

**Call relations**: This is the plan-update event path for the widget. It uses an external history helper to turn the update into a visible history item, and its stored progress later helps status surfaces describe the turn.

*Call graph*: 1 external calls (new_plan_update).


##### `ChatWidget::interrupted_turn_message`  (lines 476–482)

```
fn interrupted_turn_message(&self, reason: TurnAbortReason) -> String
```

**Purpose**: This chooses the user-facing message shown when a turn is interrupted. It gives a special message when the turn stopped because a goal budget was reached, and a general message for other interruptions.

**Data flow**: It receives the reason the turn was aborted. If the reason is budget-limited, it returns a short budget message. Otherwise, it returns a longer message telling the user the conversation was interrupted and suggesting feedback if something went wrong.

**Call relations**: No direct caller is shown in the provided call facts, but this function is the central wording helper for interrupted turns. Keeping the wording here makes interruption messages consistent wherever that reason is displayed.


### `tui/src/chatwidget/streaming.rs`

`domain_logic` · `main loop / streaming response handling`

When an assistant writes an answer, the text often arrives in small pieces. This file is the part of `ChatWidget` that turns those pieces into something readable in the terminal. It starts a stream controller when the first text arrives, feeds new text into it, and uses commit ticks to move completed lines into the chat history at a smooth pace. The unfinished end of the stream is shown as a temporary “tail” cell, like the last line of a typewriter still being typed.

The file also does the same kind of work for proposed plans, which are shown only in plan mode. When a stream finishes, it turns the many temporary streaming cells into a stable markdown history entry so the text can be reflowed correctly if the terminal is resized.

Reasoning text is treated differently. It is not streamed into visible history as normal answer text. Instead, this file looks for a bold heading inside the reasoning text and uses that as the status header, such as a “thinking” label. At the end, it can add a reasoning summary block to the transcript.

One important detail is ordering. Some events, such as command output interrupts, must not appear in the middle of a streamed write. This file can defer those events until the stream is safely finished, preventing confusing transcript order.

#### Function details

##### `ChatWidget::restore_reasoning_status_header`  (lines 9–17)

```
fn restore_reasoning_status_header(&mut self)
```

**Purpose**: Restores the status text after reasoning has already produced a useful heading. If no reasoning heading is available but work is still running, it falls back to a plain “Working” status.

**Data flow**: It reads the current reasoning text buffer and the task-running state. If it finds the first bold phrase in the reasoning text, it changes the terminal title/status kind to “thinking” and shows that phrase as the header. Otherwise, if a task is still running, it shows “Working”.

**Call relations**: This is called from outside this file when the widget needs to rebuild or restore its visible status. It does not hand off to other streaming helpers; it directly updates the status state.

*Call graph*: 1 external calls (from).


##### `ChatWidget::flush_answer_stream_with_separator`  (lines 19–59)

```
fn flush_answer_stream_with_separator(&mut self)
```

**Purpose**: Finishes any active assistant answer stream and converts temporary streamed output into stable history content. This is what prevents partial streaming cells from lingering after the final answer is done.

**Data flow**: It takes the current answer stream controller, clears the temporary stream tail, finalizes the controller into a finished cell and source text, and either adds the finished cell to history or defers it for scrollback reflow. If source text exists, it parses the assistant markdown and sends an event asking the app to consolidate the stream into one stable history entry. It also resets chunking, may stop the commit animation, and asks for usage output insertion after shutdown.

**Call relations**: It is called by `ChatWidget::finalize_completed_assistant_message` when an assistant message is complete. Inside, it uses `ChatWidget::clear_active_stream_tail` to remove the temporary tail and `ChatWidget::stream_controllers_idle` to decide whether the commit animation can stop.

*Call graph*: calls 2 internal fn (clear_active_stream_tail, stream_controllers_idle); called by 1 (finalize_completed_assistant_message).


##### `ChatWidget::stream_controllers_idle`  (lines 61–71)

```
fn stream_controllers_idle(&self) -> bool
```

**Purpose**: Checks whether both answer streaming and plan streaming have no queued lines waiting to be committed. It is a small gate used before restoring status UI or stopping animation.

**Data flow**: It reads the answer stream controller and the plan stream controller, if they exist. For each one, it checks whether the queued line count is zero. It returns true only when both are absent or empty.

**Call relations**: It is used by `ChatWidget::flush_answer_stream_with_separator` to decide whether streaming has fully settled, and by `ChatWidget::maybe_restore_status_indicator_after_stream_idle` to avoid restoring the status row too early.

*Call graph*: called by 2 (flush_answer_stream_with_separator, maybe_restore_status_indicator_after_stream_idle).


##### `ChatWidget::maybe_restore_status_indicator_after_stream_idle`  (lines 79–95)

```
fn maybe_restore_status_indicator_after_stream_idle(&mut self)
```

**Purpose**: Brings back the status indicator after commentary or plan streaming ends, but only when doing so will not flicker over active streamed output.

**Data flow**: It reads a pending-restore flag, whether a task is still running, and whether stream queues are idle. If any condition is not right, it does nothing. If all are right, it ensures the status indicator exists, restores the saved status header and details, and clears the pending flag.

**Call relations**: It is called after assistant message completion, plan completion, and commit ticks. It relies on `ChatWidget::stream_controllers_idle` so the status row returns only after queued streaming lines have drained.

*Call graph*: calls 1 internal fn (stream_controllers_idle); called by 3 (on_agent_message_item_completed, on_plan_item_completed, run_commit_tick_with_scope).


##### `ChatWidget::finalize_completed_assistant_message`  (lines 97–109)

```
fn finalize_completed_assistant_message(&mut self, message: Option<&str>)
```

**Purpose**: Completes an assistant message once the final message event arrives. It makes sure the visible text has been streamed or inserted, then shuts down the stream cleanly.

**Data flow**: It receives an optional final message string. If there was no active stream and the message is non-empty, it feeds that message through the normal streaming-delta path so it appears in history. Then it flushes the answer stream, handles stream-finished cleanup, and requests a redraw.

**Call relations**: It is called by `ChatWidget::on_agent_message_item_completed`. It may call `ChatWidget::handle_streaming_delta` for non-streamed final payloads, then always calls `ChatWidget::flush_answer_stream_with_separator` and `ChatWidget::handle_stream_finished`.

*Call graph*: calls 3 internal fn (flush_answer_stream_with_separator, handle_stream_finished, handle_streaming_delta); called by 1 (on_agent_message_item_completed).


##### `ChatWidget::on_agent_message_delta`  (lines 111–113)

```
fn on_agent_message_delta(&mut self, delta: String)
```

**Purpose**: Receives one new piece of assistant answer text and sends it into the streaming machinery.

**Data flow**: It takes a text delta from the assistant and passes it unchanged to `ChatWidget::handle_streaming_delta`. The result is that the new text becomes part of the live stream and the UI is asked to redraw.

**Call relations**: This is the simple event-facing entry point for answer deltas. It delegates the actual setup, queuing, animation, tail update, and redraw work to `ChatWidget::handle_streaming_delta`.

*Call graph*: calls 1 internal fn (handle_streaming_delta).


##### `ChatWidget::on_plan_delta`  (lines 115–145)

```
fn on_plan_delta(&mut self, delta: String)
```

**Purpose**: Receives a new piece of proposed-plan text and streams it into the transcript, but only while the chat is in plan mode.

**Data flow**: It checks the current mode. If plan mode is active, it records visible activity for non-empty text, appends the delta to the plan buffer, creates a plan stream controller if needed, pushes the delta into that controller, starts commit animation when new lines are ready, updates the stream tail, and requests a redraw.

**Call relations**: This function is the plan-side counterpart to answer streaming. It creates a `PlanStreamController` when the first plan delta arrives, may call `ChatWidget::run_catch_up_commit_tick` to reduce backlog, and then calls `ChatWidget::sync_active_stream_tail` so the unfinished plan tail is visible.

*Call graph*: calls 3 internal fn (run_catch_up_commit_tick, sync_active_stream_tail, new).


##### `ChatWidget::on_plan_item_completed`  (lines 147–198)

```
fn on_plan_item_completed(&mut self, text: String)
```

**Purpose**: Finishes a proposed plan after all plan text has arrived. It records the final plan, cleans up any plan stream, and schedules consolidation when needed.

**Data flow**: It receives final plan text and compares it with the text accumulated from streaming. It chooses the non-empty final text when available, records it as agent markdown and as the latest proposed plan, finalizes any plan stream controller, clears plan-stream state, and adds either a finalized streamed cell, a normal proposed-plan history cell, or a consolidation event. If streaming happened, it marks the status indicator for later restoration and may request usage insertion.

**Call relations**: It is called when a plan item completion event arrives. It uses `ChatWidget::clear_active_stream_tail` to remove temporary plan tail UI and `ChatWidget::maybe_restore_status_indicator_after_stream_idle` to bring back status only when streaming queues are quiet. It also hands plan text to the history-cell builder or to a consolidation event.

*Call graph*: calls 2 internal fn (clear_active_stream_tail, maybe_restore_status_indicator_after_stream_idle); 2 external calls (ConsolidateProposedPlan, new_proposed_plan).


##### `ChatWidget::on_agent_reasoning_delta`  (lines 200–220)

```
fn on_agent_reasoning_delta(&mut self, delta: String)
```

**Purpose**: Updates the status line from incoming reasoning text instead of showing that text as normal chat output. This lets the UI show what kind of thinking is happening without filling the visible answer with internal reasoning deltas.

**Data flow**: It appends the incoming reasoning text to the current reasoning buffer. If an execution-wait status is active, it leaves that status alone and only redraws. Otherwise, it looks for the first bold heading in the reasoning buffer and uses that as the thinking status header. It then requests a redraw.

**Call relations**: This is an event handler for reasoning deltas. Unlike answer and plan deltas, it does not call stream controllers; it updates the status area directly because reasoning has different display rules.


##### `ChatWidget::on_agent_reasoning_final`  (lines 222–235)

```
fn on_agent_reasoning_final(&mut self)
```

**Purpose**: Closes the current reasoning block and stores it as transcript-only history when there is reasoning content to keep.

**Data flow**: It appends the current reasoning buffer into the full reasoning buffer. If that combined text is not empty, it creates a reasoning summary history cell and adds it to history. Then it clears both reasoning buffers and requests a redraw.

**Call relations**: This is called when a reasoning section ends. It uses the external reasoning-summary cell builder, then returns control to the normal widget flow with clean buffers.

*Call graph*: 1 external calls (new_reasoning_summary_block).


##### `ChatWidget::on_reasoning_section_break`  (lines 237–242)

```
fn on_reasoning_section_break(&mut self)
```

**Purpose**: Separates one reasoning section from the next while preserving the full reasoning transcript. It resets the short buffer used for finding the current status heading.

**Data flow**: It moves the current reasoning buffer into the full reasoning buffer, adds a blank-line break, and clears the current buffer. Nothing is returned, but later reasoning deltas start fresh for header extraction.

**Call relations**: This is used between reasoning sections. It prepares the buffers so `ChatWidget::on_agent_reasoning_delta` can find a new heading while `ChatWidget::on_agent_reasoning_final` can still save the whole combined reasoning text.


##### `ChatWidget::on_stream_error`  (lines 244–254)

```
fn on_stream_error(&mut self, message: String, additional_details: Option<String>)
```

**Purpose**: Shows an error or retry-related message in the status area when streaming fails. It makes the problem visible without pretending the stream is still healthy.

**Data flow**: It receives a main message and optional details. It remembers the retry status header, ensures the status indicator exists, marks the terminal title/status kind as thinking, and sets the visible status text with details capitalized appropriately.

**Call relations**: This is an error event handler. It does not use the stream controllers; it updates the bottom/status pane directly so the user sees the failure state immediately.


##### `ChatWidget::on_agent_message_item_completed`  (lines 261–302)

```
fn on_agent_message_item_completed(
        &mut self,
        item: AgentMessageItem,
        from_replay: bool,
    )
```

**Purpose**: Processes a completed assistant message item, including final answers and commentary. It finalizes visible text, records final markdown when appropriate, and may update the thread’s git branch after branch-creation output.

**Data flow**: It joins the message item’s text parts into one string, parses it as assistant markdown, and finalizes the visible markdown through `ChatWidget::finalize_completed_assistant_message`. If the item is a final answer or has no phase, it records the markdown as agent output. If this is not replayed history and the parsed text indicates a created branch, it starts an asynchronous task to read the current branch and sends a sync event. Finally, it sets whether the status indicator should be restored and tries to restore it if streams are idle.

**Call relations**: This is the main completion handler for assistant message items. It hands text cleanup to `ChatWidget::finalize_completed_assistant_message`, may spawn background branch lookup through `current_branch_name`, and finishes by calling `ChatWidget::maybe_restore_status_indicator_after_stream_idle`.

*Call graph*: calls 3 internal fn (current_branch_name, finalize_completed_assistant_message, maybe_restore_status_indicator_after_stream_idle); 4 external calls (from, new, matches!, spawn).


##### `ChatWidget::on_commit_tick`  (lines 306–308)

```
fn on_commit_tick(&mut self)
```

**Purpose**: Responds to a periodic animation tick for streaming output. It exists as the public tick hook and forwards the real work to the regular commit-tick runner.

**Data flow**: It receives no outside data beyond the widget state. It calls `ChatWidget::run_commit_tick`, which may move queued stream lines into history and update the tail.

**Call relations**: This is called by the app’s timer or event loop when a stream commit tick occurs. It delegates directly to `ChatWidget::run_commit_tick`.

*Call graph*: calls 1 internal fn (run_commit_tick).


##### `ChatWidget::run_commit_tick`  (lines 311–313)

```
fn run_commit_tick(&mut self)
```

**Purpose**: Runs a normal streaming commit tick. In plain terms, it advances the visible stream by moving ready lines from the queue into the chat history.

**Data flow**: It uses the current widget state and asks `ChatWidget::run_commit_tick_with_scope` to commit in any allowed mode. The outcome is applied by that shared helper.

**Call relations**: It is called by `ChatWidget::on_commit_tick`. It does not duplicate commit logic; it selects the broad “any mode” scope and passes control to `ChatWidget::run_commit_tick_with_scope`.

*Call graph*: calls 1 internal fn (run_commit_tick_with_scope); called by 1 (on_commit_tick).


##### `ChatWidget::run_catch_up_commit_tick`  (lines 316–318)

```
fn run_catch_up_commit_tick(&mut self)
```

**Purpose**: Runs an extra commit tick only when the stream is behind and catch-up behavior is active. This helps reduce lag when many lines arrive quickly.

**Data flow**: It reads no new inputs except widget state. It calls `ChatWidget::run_commit_tick_with_scope` with a catch-up-only scope, so the helper commits larger batches only when that mode is currently appropriate.

**Call relations**: It is called after answer deltas and plan deltas are pushed into their controllers. It gives `ChatWidget::handle_streaming_delta` and `ChatWidget::on_plan_delta` a way to drain backlog without disrupting smooth one-line pacing.

*Call graph*: calls 1 internal fn (run_commit_tick_with_scope); called by 2 (handle_streaming_delta, on_plan_delta).


##### `ChatWidget::run_commit_tick_with_scope`  (lines 326–349)

```
fn run_commit_tick_with_scope(&mut self, scope: CommitTickScope)
```

**Purpose**: Applies one streaming commit step for answer and plan streams. This is the central place where queued stream lines become permanent history cells.

**Data flow**: It captures the current time, passes adaptive chunking state plus the answer and plan stream controllers into the commit-tick engine, then receives committed cells and idle-state information back. For each committed cell, it hides the status indicator and adds the cell to history. It updates the active tail, may restore the status indicator when all streams are idle, may stop commit animation, and refreshes runtime metrics while an agent turn is running.

**Call relations**: It is the shared worker behind `ChatWidget::run_commit_tick` and `ChatWidget::run_catch_up_commit_tick`. After the commit engine returns, it calls `ChatWidget::sync_active_stream_tail` and may call `ChatWidget::maybe_restore_status_indicator_after_stream_idle`.

*Call graph*: calls 2 internal fn (maybe_restore_status_indicator_after_stream_idle, sync_active_stream_tail); called by 2 (run_catch_up_commit_tick, run_commit_tick); 1 external calls (now).


##### `ChatWidget::flush_interrupt_queue`  (lines 351–355)

```
fn flush_interrupt_queue(&mut self)
```

**Purpose**: Runs any delayed interrupt events after streaming has reached a safe stopping point. This keeps transcript events in the order the user expects.

**Data flow**: It temporarily takes the interrupt manager out of the widget, asks it to flush all queued interrupts using the widget as context, and then puts the manager back. The queued interruptions are consumed and their effects are applied to the widget.

**Call relations**: It is called by `ChatWidget::handle_stream_finished`. The temporary take avoids borrowing the same widget state in two conflicting ways while the interrupt manager applies queued work.

*Call graph*: called by 1 (handle_stream_finished); 1 external calls (take).


##### `ChatWidget::defer_or_handle`  (lines 358–371)

```
fn defer_or_handle(
        &mut self,
        push: impl FnOnce(&mut InterruptManager),
        handle: impl FnOnce(&mut Self),
    )
```

**Purpose**: Either queues an interrupt-like action for later or runs it immediately, depending on whether streaming is active. This prevents events from being reordered around an active stream write.

**Data flow**: It receives two small pieces of behavior: one that can push work into the interrupt queue, and one that can handle the work now. If an answer stream is active or interrupts are already queued, it pushes the new work into the queue. Otherwise, it runs the handler immediately on the widget.

**Call relations**: This helper is used by code outside this file when events may arrive during streaming. It is designed so that once deferral starts, later events keep being queued until `ChatWidget::flush_interrupt_queue` drains them in first-in, first-out order.


##### `ChatWidget::handle_stream_finished`  (lines 373–380)

```
fn handle_stream_finished(&mut self)
```

**Purpose**: Performs cleanup after a non-execution stream finishes. It hides a pending completion status if needed and releases any interrupts that were waiting for the stream to end.

**Data flow**: It checks whether task completion was pending. If so, it hides the status indicator and clears that pending flag. Then it flushes the interrupt queue, applying delayed events now that streamed content has been inserted.

**Call relations**: It is called by `ChatWidget::finalize_completed_assistant_message` after answer-stream flushing. It calls `ChatWidget::flush_interrupt_queue` so deferred transcript events can finally run.

*Call graph*: calls 1 internal fn (flush_interrupt_queue); called by 1 (finalize_completed_assistant_message).


##### `ChatWidget::handle_streaming_delta`  (lines 383–416)

```
fn handle_streaming_delta(&mut self, delta: String)
```

**Purpose**: Adds one piece of assistant answer text to the live answer stream. It starts the stream when necessary, queues the text, advances commit animation when possible, and refreshes the temporary tail.

**Data flow**: It receives a text delta. For non-empty text, it records visible activity. If no answer stream exists yet, it flushes active execution cells, optionally inserts a final-message separator from prior work, and creates a new `StreamController` sized for the current terminal width. It pushes the delta into the controller, starts commit animation if a commit is ready, may run a catch-up tick, synchronizes the active stream tail, and requests a redraw.

**Call relations**: It is called by `ChatWidget::on_agent_message_delta` for normal streaming and by `ChatWidget::finalize_completed_assistant_message` when a final message arrived without earlier deltas. It calls `ChatWidget::run_catch_up_commit_tick` and `ChatWidget::sync_active_stream_tail` after feeding the controller.

*Call graph*: calls 4 internal fn (run_catch_up_commit_tick, sync_active_stream_tail, new, new); called by 2 (finalize_completed_assistant_message, on_agent_message_delta).


##### `ChatWidget::active_cell_is_stream_tail`  (lines 418–423)

```
fn active_cell_is_stream_tail(&self) -> bool
```

**Purpose**: Checks whether the transcript’s current active cell is one of the temporary stream-tail cells. This helps the widget avoid deleting or replacing unrelated active content by mistake.

**Data flow**: It reads the transcript’s active cell, if one exists, and tests whether it is a streaming assistant tail or a streaming plan tail. It returns true for those temporary tail cells and false otherwise.

**Call relations**: It is used by `ChatWidget::clear_active_stream_tail` before clearing the active cell, and by `ChatWidget::has_active_stream_tail` to report whether a live stream tail is actually present.

*Call graph*: called by 2 (clear_active_stream_tail, has_active_stream_tail).


##### `ChatWidget::has_active_stream_tail`  (lines 425–428)

```
fn has_active_stream_tail(&self) -> bool
```

**Purpose**: Reports whether a stream controller exists and the active transcript cell is its temporary tail. This is a quick “is there live unfinished stream UI?” check.

**Data flow**: It checks whether either answer or plan streaming is active, then calls `ChatWidget::active_cell_is_stream_tail`. It returns true only when both the controller side and the visible active-cell side agree that a stream tail is present.

**Call relations**: It builds on `ChatWidget::active_cell_is_stream_tail`. Other widget code can call it when deciding whether the current active cell belongs to streaming.

*Call graph*: calls 1 internal fn (active_cell_is_stream_tail).


##### `ChatWidget::sync_active_stream_tail`  (lines 430–465)

```
fn sync_active_stream_tail(&mut self)
```

**Purpose**: Keeps the visible temporary tail cell matched to the current answer or plan stream. This is what makes the newest unfinished lines appear at the bottom while older lines are committed into history.

**Data flow**: It first checks the answer stream controller. If it has tail lines, it hides the status indicator, replaces the active cell with a streaming assistant tail, and bumps the active-cell revision so the UI knows it changed. If no answer stream is active, it does the same for a plan stream using plan display lines. If neither stream has tail lines, it clears the stream tail.

**Call relations**: It is called after answer deltas, plan deltas, and commit ticks. It may call `ChatWidget::clear_active_stream_tail` when there is no tail to show, otherwise it creates the appropriate streaming-tail history cell.

*Call graph*: calls 3 internal fn (clear_active_stream_tail, new, new); called by 3 (handle_streaming_delta, on_plan_delta, run_commit_tick_with_scope); 1 external calls (new).


##### `ChatWidget::clear_active_stream_tail`  (lines 467–472)

```
fn clear_active_stream_tail(&mut self)
```

**Purpose**: Removes the temporary stream-tail cell if the active cell is actually a stream tail. It leaves other active transcript content alone.

**Data flow**: It checks the current active cell with `ChatWidget::active_cell_is_stream_tail`. If the active cell is a streaming tail, it sets the active cell to none and bumps the active-cell revision. If not, it does nothing.

**Call relations**: It is called when answer streams are flushed, plan streams are finalized, and stream-tail synchronization finds no tail lines. It depends on `ChatWidget::active_cell_is_stream_tail` to avoid clearing the wrong kind of active cell.

*Call graph*: calls 1 internal fn (active_cell_is_stream_tail); called by 3 (flush_answer_stream_with_separator, on_plan_item_completed, sync_active_stream_tail).


### `tui/src/app/agent_message_consolidation.rs`

`domain_logic` · `when a streaming agent response finishes`

While the agent is typing, the terminal UI shows the reply in moving pieces so it can update smoothly. Those pieces are useful during streaming, but they are not the best long-term record of the answer. Once the answer is finished, the app needs one canonical copy of the raw markdown text. This is like replacing a stack of sticky notes with a single clean document.

This file performs that cleanup. It looks at the end of the transcript and finds the final run of temporary agent message cells. If there is a delayed temporary cell that had to be kept around for event ordering, it first inserts that cell into the transcript and any open transcript overlay. Then it replaces the whole temporary run with one `AgentMarkdownCell`, which stores the original markdown source and the working directory it should be interpreted from.

If the transcript overlay is open, the same replacement is made there too, and the UI asks for another frame to be drawn. After that, the file decides how to finish any pending scrollback reflow. A reflow means recalculating how text wraps and scrolls, usually after the terminal size changes. If there were no temporary cells to replace, it still makes sure any stream reflow is completed if needed.

#### Function details

##### `App::handle_consolidate_agent_message`  (lines 24–74)

```
fn handle_consolidate_agent_message(
        &mut self,
        tui: &mut tui::Tui,
        source: String,
        cwd: PathBuf,
        scrollback_reflow: ConsolidationScrollbackReflow,
        defe
```

**Purpose**: This function finalizes a streamed agent reply in the transcript. It replaces the temporary cells used during live typing with one permanent markdown-backed cell, so future redraws and resizes use the original answer text.

**Data flow**: It receives the finished markdown text, the current working directory, a note about whether scrollback reflow must be completed, and possibly one delayed temporary history cell. If that delayed cell exists, it is first added to the transcript and to the transcript overlay if one is open. The function then looks backward through the transcript for the trailing group of temporary agent message cells. If it finds any, it creates a new permanent `AgentMarkdownCell` from the source text and working directory, replaces the temporary group with it, updates the overlay in the same way, asks the UI to draw another frame, and finishes the related reflow work. If it finds no cells to replace, it only checks whether stream reflow still needs to be finished. It returns success or an error from the reflow steps.

**Call relations**: This is the main entry point in this file’s flow. The app calls it when an agent message has finished streaming and needs to become part of the stable transcript. Inside, it creates the permanent markdown cell, requests a new UI frame through the TUI frame requester when the visible overlay changes, and then hands off to `App::finish_agent_message_consolidation` to complete the scrollback reflow decision.

*Call graph*: calls 2 internal fn (finish_agent_message_consolidation, new); 4 external calls (new, frame_requester, once, debug!).


##### `App::finish_agent_message_consolidation`  (lines 76–91)

```
fn finish_agent_message_consolidation(
        &mut self,
        tui: &mut tui::Tui,
        scrollback_reflow: ConsolidationScrollbackReflow,
    ) -> Result<()>
```

**Purpose**: This helper finishes the resize and scrollback cleanup after a streamed message has been consolidated. It chooses the correct final reflow path based on whether reflow is optional or required.

**Data flow**: It receives the TUI object and a small instruction value describing the needed reflow behavior. If the instruction says to finish only when a resize reflow had already run, it calls the app’s conditional stream reflow finisher. If the instruction says reflow is required, it calls the stricter finisher. It does not create a visible result itself; it updates the app/UI state through those reflow operations and returns success or any error they produce.

**Call relations**: `App::handle_consolidate_agent_message` calls this after it has replaced temporary transcript cells with the permanent markdown cell. This keeps the higher-level consolidation function focused on transcript replacement, while this helper decides which reflow completion path is needed for the UI to settle correctly.

*Call graph*: called by 1 (handle_consolidate_agent_message).


### `tui/src/transcript_reflow.rs`

`domain_logic` · `terminal resize, drawing, and stream finalization`

A terminal is not like a web page where the app owns every visible element forever. Once Codex prints wrapped text into the terminal, the terminal keeps those rows in its own scrollback. If the user resizes the terminal, old wrapped lines may no longer match the new width. This file is the small state machine that remembers when that scrollback needs to be repaired from Codex’s own saved transcript cells.

It solves two timing problems. First, resize events often arrive in a burst while someone drags the terminal edge. Rebuilding the whole transcript for every tiny intermediate width would be wasteful and could still leave the wrong final shape. So this file uses a short debounce, meaning it waits for resizing to quiet down before asking for a rebuild.

Second, Codex may be streaming output while the resize happens. Some streamed rows are temporary until they are folded into the permanent transcript. If a resize repair runs too early, the app must remember to repair once more after streaming finishes, using the final source-backed transcript. This is like waiting until wet ink dries before making the clean photocopy.

The main type, TranscriptReflowState, records observed widths, widths already repaired, pending deadlines, and stream-related flags. Other code, especially the resize reflow path, reads this state and performs the actual clearing and reprinting.

#### Function details

##### `TranscriptReflowState::clear`  (lines 42–44)

```
fn clear(&mut self)
```

**Purpose**: Resets the reflow tracker back to a blank starting point. This is used when the transcript data it would have repaired has been discarded, so old resize reminders would no longer make sense.

**Data flow**: It takes the current state, ignores all remembered widths, deadlines, and stream flags, and replaces everything with the default empty state. Afterward there is no pending repair and no remembered resize history.

**Call relations**: When higher-level app code throws away or replaces transcript state, it can call this so future draws do not try to rebuild old scrollback. Internally it relies on the type’s default empty value.

*Call graph*: 1 external calls (default).


##### `TranscriptReflowState::note_width`  (lines 51–60)

```
fn note_width(&mut self, width: u16) -> TranscriptWidthChange
```

**Purpose**: Records the terminal width seen during a draw and reports whether this is the first width or a real change. The first width is treated as a baseline, not as a resize needing repair.

**Data flow**: It receives a width number, stores it as the latest observed width, and compares it with the previous one. If there was no previous width, it also records that width as already reflowed. It returns a small result saying whether the width was newly initialized and whether it changed.

**Call relations**: The drawing code uses this when it learns the current terminal width. The returned TranscriptWidthChange tells the caller whether it should consider scheduling resize work or simply treat this as first setup.


##### `TranscriptReflowState::reflow_needed_for_width`  (lines 68–70)

```
fn reflow_needed_for_width(&self, width: u16) -> bool
```

**Purpose**: Answers whether scrollback still needs to be rebuilt for a given width. It avoids requesting duplicate work if that width has already been rebuilt or is already scheduled.

**Data flow**: It receives a width, compares it with the last width that actually completed a rebuild, and also checks any pending target width. It returns true only when the requested width is neither already repaired nor already waiting to be repaired.

**Call relations**: Resize-aware drawing code asks this before scheduling a new repair. This keeps repeated draw cycles from piling up the same rebuild request.


##### `TranscriptReflowState::schedule_debounced`  (lines 78–85)

```
fn schedule_debounced(&mut self, target_width: Option<u16>) -> bool
```

**Purpose**: Schedules a resize repair after a short quiet period. This prevents the app from rebuilding scrollback over and over while the user is still dragging the terminal size.

**Data flow**: It optionally receives a target width. If a width is supplied, it remembers that as the pending repair width. It then sets a deadline to the current time plus the debounce delay and returns false, meaning the repair should not run immediately.

**Call relations**: Resize handling code calls this when a rebuild is needed but should wait for resize events to settle. It uses the current clock time to push the deadline forward each time another resize arrives.

*Call graph*: 1 external calls (now).


##### `TranscriptReflowState::schedule_immediate`  (lines 91–94)

```
fn schedule_immediate(&mut self)
```

**Purpose**: Schedules a repair for the next available draw without waiting for the debounce delay. This is used when waiting would leave visibly wrong wrapped stream output in the transcript.

**Data flow**: It clears any specific pending width target and sets the pending deadline to the current time. After that, a due-check will consider the repair ready right away.

**Call relations**: Stream finalization code can call this after temporary streamed rows become permanent transcript history. It prepares the resize reflow path to run promptly on the next draw opportunity.

*Call graph*: 1 external calls (now).


##### `TranscriptReflowState::set_due_for_test`  (lines 97–99)

```
fn set_due_for_test(&mut self)
```

**Purpose**: For tests only, makes a pending repair look overdue. This lets tests check rescheduling behavior without waiting in real time.

**Data flow**: It sets the pending deadline to just before the current time. Afterward, code that checks whether the repair is due will see it as ready.

**Call relations**: Only the test module uses this helper. It uses the clock and a tiny duration to create a controlled expired deadline.

*Call graph*: 2 external calls (from_millis, now).


##### `TranscriptReflowState::pending_is_due`  (lines 101–103)

```
fn pending_is_due(&self, now: Instant) -> bool
```

**Purpose**: Checks whether the scheduled repair deadline has arrived. Callers use this to decide if it is time to perform the actual transcript rebuild.

**Data flow**: It receives a current time value, compares it with the stored pending deadline if one exists, and returns true when the current time is at or past that deadline. If no repair is pending, it returns false.

**Call relations**: The draw or resize reflow loop can call this before doing expensive scrollback repair. It does not perform the repair itself; it only answers whether the timer has matured.


##### `TranscriptReflowState::pending_until`  (lines 105–107)

```
fn pending_until(&self) -> Option<Instant>
```

**Purpose**: Returns the exact time when the pending repair is due. This is useful for scheduling wakeups or for tests that need to inspect the debounce deadline.

**Data flow**: It reads the stored pending deadline and returns it as an optional value. If no repair is waiting, it returns no time.

**Call relations**: Tests use this to confirm that repeated debounced scheduling moves the deadline later. Runtime code can also use it to know when to wake up for the next repair.


##### `TranscriptReflowState::has_pending_reflow`  (lines 109–111)

```
fn has_pending_reflow(&self) -> bool
```

**Purpose**: Reports whether any transcript repair is currently waiting. It is a simple yes-or-no check for pending resize work.

**Data flow**: It looks at whether a pending deadline exists. It returns true if there is one and false if the state is idle.

**Call relations**: Other parts of the app can use this before deciding whether there is reflow work to consider during drawing or scheduling.


##### `TranscriptReflowState::clear_pending_reflow`  (lines 113–116)

```
fn clear_pending_reflow(&mut self)
```

**Purpose**: Cancels the currently scheduled repair without forgetting the broader resize history. This is used after pending work is no longer needed or has been dealt with.

**Data flow**: It removes the pending deadline and any pending target width. The remembered observed width, last repaired width, and stream flags remain unchanged.

**Call relations**: The resize reflow code can call this after consuming or canceling a scheduled repair. Clearing the pending target also allows the same width to be scheduled again later if it still needs repair.


##### `TranscriptReflowState::mark_reflowed_width`  (lines 123–125)

```
fn mark_reflowed_width(&mut self, width: u16) -> bool
```

**Purpose**: Records the terminal width at which scrollback was actually rebuilt. This is important because the last width seen by the app may not be the same as the width that was already repaired.

**Data flow**: It receives a width, stores it as the last completed reflow width, and returns whether that value changed from before. The observed-width record is left alone.

**Call relations**: After app::resize_reflow or similar rebuilding code finishes reprinting transcript history, it calls this to update the source of truth for completed repairs.


##### `TranscriptReflowState::mark_ran_during_stream`  (lines 132–134)

```
fn mark_ran_during_stream(&mut self)
```

**Purpose**: Remembers that a repair ran while streamed output was still temporary. This tells the app that one more clean repair may be needed after streaming is finalized.

**Data flow**: It sets the ran-during-stream flag to true. Nothing is returned, but later stream-finish checks will see that a final repair is required.

**Call relations**: The resize repair path uses this when it rebuilds while streaming is still active. Stream finalization later reads this flag through take_stream_finish_reflow_needed.


##### `TranscriptReflowState::mark_resize_requested_during_stream`  (lines 142–144)

```
fn mark_resize_requested_during_stream(&mut self)
```

**Purpose**: Remembers that a resize repair was requested while streaming or pre-final transcript cells existed. This covers the case where the debounce timer did not fire before the stream ended.

**Data flow**: It sets the resize-requested-during-stream flag to true. Later, when the stream is finalized, that flag can trigger one source-backed repair.

**Call relations**: Resize scheduling code calls this during streaming. The stream completion path later drains the flag so the final transcript can be rebuilt once from permanent cells.


##### `TranscriptReflowState::take_stream_finish_reflow_needed`  (lines 151–156)

```
fn take_stream_finish_reflow_needed(&mut self) -> bool
```

**Purpose**: Checks whether stream completion requires one final transcript repair, then clears that request. It is a draining read: asking the question also consumes the stored need.

**Data flow**: It combines the two stream-related flags into one yes-or-no answer. Then it resets both flags to false and returns whether either had been set.

**Call relations**: Stream finalization code calls this after temporary stream output has become source-backed transcript history. If it returns true, the caller should schedule or run the final repair.


##### `TranscriptReflowState::clear_stream_flags`  (lines 162–165)

```
fn clear_stream_flags(&mut self)
```

**Purpose**: Clears only the stream-related repair reminders. This is useful after the required final stream repair has completed, while keeping width history intact.

**Data flow**: It sets both stream flags to false. Pending deadlines and remembered widths are not changed.

**Call relations**: After a post-stream repair succeeds, higher-level code can call this to mark that stream cleanup is done without making the next draw look like first-time initialization.


##### `tests::schedule_debounced_postpones_existing_reflow`  (lines 182–195)

```
fn schedule_debounced_postpones_existing_reflow()
```

**Purpose**: Checks that scheduling another debounced repair moves the deadline later. This proves that resize dragging keeps extending the quiet period instead of using an old deadline.

**Data flow**: The test starts with a fresh state, schedules a debounced repair, records its deadline, waits briefly, then schedules again. It expects the second deadline to be later than the first.

**Call relations**: This test exercises TranscriptReflowState::schedule_debounced and TranscriptReflowState::pending_until. It supports the larger resize flow by verifying that repeated resize events postpone rebuilding.

*Call graph*: 4 external calls (from_millis, assert!, sleep, default).


##### `tests::schedule_debounced_postpones_due_existing_reflow`  (lines 198–208)

```
fn schedule_debounced_postpones_due_existing_reflow()
```

**Purpose**: Checks that even an already-due repair can be rescheduled into a fresh debounce window. This matters when another resize arrives just as an old repair was about to run.

**Data flow**: The test creates a fresh state, forces its pending deadline to be in the past, records the current time, then schedules a debounced repair. It expects the new deadline to be in the future.

**Call relations**: This test uses the test-only due helper and schedule_debounced. It confirms the state machine favors the newest resize burst rather than immediately acting on stale timing.

*Call graph*: 3 external calls (now, assert!, default).


##### `tests::first_observed_width_marks_reflow_baseline`  (lines 211–220)

```
fn first_observed_width_marks_reflow_baseline()
```

**Purpose**: Checks that the first terminal width is treated as the initial baseline, not as a resize. This prevents unnecessary scrollback repair on the first draw.

**Data flow**: The test creates a fresh state and notes width 80. It expects the result to say initialized, the observed width to be 80, the reflow baseline to be 80, and no repair to be needed for 80.

**Call relations**: This test focuses on note_width and reflow_needed_for_width. It protects startup drawing behavior from doing redundant resize work.

*Call graph*: 3 external calls (assert!, assert_eq!, default).


##### `tests::mark_reflowed_width_records_actual_rebuild_width`  (lines 223–231)

```
fn mark_reflowed_width_records_actual_rebuild_width()
```

**Purpose**: Checks that the state records the width that was actually rebuilt, separately from the width that was merely observed. This distinction avoids confusing a seen size with a repaired size.

**Data flow**: The test notes an observed width of 80, then marks width 100 as reflowed. It expects the observed width to stay 80 while the completed reflow width becomes 100.

**Call relations**: This test exercises note_width and mark_reflowed_width. It supports the logic used when terminal resize reports and actual rebuild timing do not line up perfectly.

*Call graph*: 3 external calls (assert!, assert_eq!, default).


##### `tests::reflow_needed_compares_against_actual_rebuild_width`  (lines 234–241)

```
fn reflow_needed_compares_against_actual_rebuild_width()
```

**Purpose**: Checks that repair need is based on the width that was actually rebuilt, not just the latest width observed. This catches cases where the terminal settles on a size after an earlier repair.

**Data flow**: The test records width 80, marks width 90 as rebuilt, then observes width 100. It expects a repair to be needed for 100 because scrollback has not actually been rebuilt at that width.

**Call relations**: This test combines note_width, mark_reflowed_width, and reflow_needed_for_width. It guards the main invariant that completed repair width is tracked separately.

*Call graph*: 2 external calls (assert!, default).


##### `tests::pending_reflow_target_prevents_repeated_reschedule`  (lines 244–252)

```
fn pending_reflow_target_prevents_repeated_reschedule()
```

**Purpose**: Checks that once a repair for a width is already pending, the state does not keep saying the same width needs another schedule. This prevents duplicate scheduling loops.

**Data flow**: The test starts at width 80, confirms width 100 needs repair, then schedules a debounced repair targeting 100. After that, it expects width 100 to no longer be reported as needing a new repair request.

**Call relations**: This test exercises reflow_needed_for_width and schedule_debounced. It verifies that the pending target width acts like a reservation for upcoming work.

*Call graph*: 2 external calls (assert!, default).


##### `tests::clear_pending_reflow_allows_same_width_to_be_rescheduled`  (lines 255–263)

```
fn clear_pending_reflow_allows_same_width_to_be_rescheduled()
```

**Purpose**: Checks that canceling a pending repair removes its target, so the same width can be requested again. This matters if pending work is cleared before it actually runs.

**Data flow**: The test starts at width 80, schedules a pending repair for width 100, then clears pending reflow. It expects width 100 to again be considered in need of repair.

**Call relations**: This test focuses on schedule_debounced, clear_pending_reflow, and reflow_needed_for_width. It confirms canceling pending work does not accidentally mark the repair as complete.

*Call graph*: 2 external calls (assert!, default).


##### `tests::mark_reflowed_width_reports_unchanged_width`  (lines 266–272)

```
fn mark_reflowed_width_reports_unchanged_width()
```

**Purpose**: Checks that marking the same reflow width twice reports no change the second time. This lets callers know whether the completed repair width actually moved.

**Data flow**: The test marks width 100 as reflowed and expects a change. It marks width 100 again and expects no change, while the stored width remains 100.

**Call relations**: This test exercises mark_reflowed_width directly. It verifies the function’s return value is meaningful, not just that it stores a width.

*Call graph*: 3 external calls (assert!, assert_eq!, default).


##### `tests::take_stream_finish_reflow_needed_drains_resize_request`  (lines 275–281)

```
fn take_stream_finish_reflow_needed_drains_resize_request()
```

**Purpose**: Checks that a resize request made during streaming triggers exactly one stream-finish repair. After it is read once, the request should be gone.

**Data flow**: The test marks that a resize was requested during streaming, then calls the draining check twice. It expects true the first time and false the second time.

**Call relations**: This test covers mark_resize_requested_during_stream and take_stream_finish_reflow_needed. It protects the stream finalization flow from both missing a needed repair and repeating it forever.

*Call graph*: 2 external calls (assert!, default).


##### `tests::take_stream_finish_reflow_needed_drains_ran_during_stream`  (lines 284–290)

```
fn take_stream_finish_reflow_needed_drains_ran_during_stream()
```

**Purpose**: Checks that a repair that actually ran during streaming also triggers exactly one final repair after streaming finishes. This ensures temporary streamed rows do not remain as the final wrapped transcript.

**Data flow**: The test marks that a reflow ran during streaming, then calls the draining check twice. It expects true once, then false after the flag has been cleared.

**Call relations**: This test covers mark_ran_during_stream and take_stream_finish_reflow_needed. It verifies the cleanup path for mid-stream rebuilds.

*Call graph*: 2 external calls (assert!, default).


##### `tests::clear_resets_stream_reflow_flags`  (lines 293–301)

```
fn clear_resets_stream_reflow_flags()
```

**Purpose**: Checks that a full state reset also clears the stream-related repair reminders. This prevents stale stream flags from causing repairs after the transcript has been discarded.

**Data flow**: The test sets both stream flags, calls clear, then asks whether stream finish needs a repair. It expects false because the reset should remove those old reminders.

**Call relations**: This test exercises mark_ran_during_stream, mark_resize_requested_during_stream, clear, and take_stream_finish_reflow_needed. It confirms that full reset is stronger than only clearing pending resize timing.

*Call graph*: 2 external calls (assert!, default).


### `tui/src/app/resize_reflow.rs`

`orchestration` · `draw/pre-render, terminal resize, history replay, stream finalization`

A terminal chat view is tricky because text is wrapped to the current terminal width. If the user makes the window wider or narrower, old lines in terminal scrollback do not magically re-wrap. This file solves that by treating the app’s stored transcript cells as the source of truth, clearing the Codex-owned terminal history, and replaying the transcript at the new width.

Think of it like reprinting a book after changing the page size. The app does not copy the old pages, because their line breaks are wrong. It goes back to the original text and lays it out again.

The file also protects performance. If there is a row limit, it renders only the tail end of the transcript that the terminal would keep, instead of formatting a huge old conversation. Startup replay and thread-switch replay use the same rule so they do not insert more rows than resize replay would later preserve.

Streaming output needs special care. While an assistant response is still streaming, the app may show temporary stream cells. Later those are replaced by finalized transcript cells. If a resize happens during that window, this file marks that fact and forces one more rebuild after finalization, so scrollback does not keep the temporary wrapping.

#### Function details

##### `trailing_run_start`  (lines 47–66)

```
fn trailing_run_start(transcript_cells: &[Arc<dyn HistoryCell>]) -> usize
```

**Purpose**: Finds where the final group of transcript cells of a certain type begins, including its first non-continuation cell. This matters for streamed messages, where one visible message may be split into a starting cell plus continuation cells.

**Data flow**: It receives the transcript cell list and a cell type to look for. It walks backward from the end while the cells are continuation cells of that type, then includes the matching first cell if it exists. It returns the index where that final run starts, or the end index if there is no such run.

**Call relations**: The stream-time resize check uses this helper to notice a trailing unfinished agent message or proposed plan. That lets the resize system treat the transcript as still stream-sensitive even after the live stream controller has stopped but before final consolidation has happened.


##### `App::reset_history_emission_state`  (lines 69–72)

```
fn reset_history_emission_state(&mut self)
```

**Purpose**: Resets the app’s memory of whether it has already written history lines, and drops any delayed history lines. This is used before a fresh rebuild so old spacing and queued output do not leak into the new transcript.

**Data flow**: It takes the current app state, sets the history-emitted flag back to false, and empties the deferred line queue. It returns nothing, but it changes the app’s bookkeeping.

**Call relations**: Rebuild paths call this when there is no transcript to replay, when rollback removes all cells, or when a pending resize is abandoned because there is no terminal-owned history to repair.

*Call graph*: called by 3 (maybe_clear_resize_reflow_without_terminal, rebuild_transcript_after_backtrack, reflow_transcript_now).


##### `App::display_lines_for_history_insert`  (lines 74–89)

```
fn display_lines_for_history_insert(
        &mut self,
        cell: &dyn HistoryCell,
        width: u16,
    ) -> Vec<HyperlinkLine>
```

**Purpose**: Turns one stored history cell into display-ready terminal lines, adding a blank separator before a new top-level history item when needed. It is the shared formatting step for normal history insertion and buffered startup replay.

**Data flow**: It receives a history cell and a target width. It asks the cell to render itself for the current history display mode, checks whether the cell is a stream continuation, and may insert a blank line before it. It returns the lines that should be written or buffered.

**Call relations**: Both immediate insertion and initial replay buffering call this first. It hands back already wrapped hyperlink-aware lines, which the caller either writes to the terminal or stores until later.

*Call graph*: calls 3 internal fn (display_hyperlink_lines_for_mode, is_stream_continuation, new); called by 2 (insert_history_cell_lines, insert_history_cell_lines_with_initial_replay_buffer); 1 external calls (from).


##### `App::insert_history_cell_lines`  (lines 91–109)

```
fn insert_history_cell_lines(
        &mut self,
        tui: &mut tui::Tui,
        cell: &dyn HistoryCell,
        width: u16,
    )
```

**Purpose**: Writes one finalized history cell into terminal scrollback, unless an overlay is currently taking over the screen. If an overlay is active, it saves the lines for later instead of mixing them into the wrong surface.

**Data flow**: It receives the terminal object, a history cell, and the width to wrap to. It formats the cell into display lines. Empty output is ignored; otherwise the lines are either appended to the deferred queue or inserted into terminal history with the current wrapping policy.

**Call relations**: This is the normal path for adding history as the conversation proceeds. It relies on the local display formatter and then hands the result to the terminal insertion API.

*Call graph*: calls 2 internal fn (display_lines_for_history_insert, history_line_wrap_policy); 1 external calls (insert_history_hyperlink_lines_with_wrap_policy).


##### `App::begin_initial_history_replay_buffer`  (lines 117–121)

```
fn begin_initial_history_replay_buffer(&mut self)
```

**Purpose**: Starts a temporary buffer for rows replayed when resuming an existing session. The goal is to apply the same row cap at startup that resize rebuilds use later.

**Data flow**: It checks whether an overlay is active. If not, it creates an empty initial history replay buffer in the app state. Nothing is written to the terminal yet.

**Call relations**: Startup replay begins by calling this before many old history cells are inserted. Later, the matching finish function flushes the retained rows into terminal scrollback.

*Call graph*: 1 external calls (default).


##### `App::begin_thread_switch_history_replay_buffer`  (lines 128–135)

```
fn begin_thread_switch_history_replay_buffer(&mut self)
```

**Purpose**: Starts a special replay buffer for switching conversation threads when a resize row cap exists. Instead of rendering every old cell one by one, it lets the app render only the retained tail after the transcript source is rebuilt.

**Data flow**: It checks whether row-capped resize reflow is enabled and no overlay is active. If so, it creates a replay buffer marked to render from the transcript tail later. It returns nothing but changes app state.

**Call relations**: Thread-switch replay uses this setup before rebuilding transcript cells from source. The finish step then calls the same tail renderer used for resize reflow.

*Call graph*: calls 1 internal fn (resize_reflow_max_rows); 1 external calls (new).


##### `App::finish_initial_history_replay_buffer`  (lines 142–166)

```
fn finish_initial_history_replay_buffer(&mut self, tui: &mut tui::Tui)
```

**Purpose**: Flushes the temporary startup or thread-switch replay buffer into terminal scrollback. If the buffer was set to render from the transcript tail, it performs that rendering now.

**Data flow**: It takes the replay buffer out of the app state. If retained lines are already stored, it writes them to the terminal. If the buffer instead requested tail rendering, it renders the transcript at the terminal’s current width and writes those lines. If there is no buffer, it does nothing.

**Call relations**: This closes the buffering period started by the initial replay or thread-switch setup functions. It hands final rows to the terminal insertion API using the app’s current history wrapping policy.

*Call graph*: calls 2 internal fn (history_line_wrap_policy, render_transcript_lines_for_reflow); 1 external calls (insert_history_hyperlink_lines_with_wrap_policy).


##### `App::insert_history_cell_lines_with_initial_replay_buffer`  (lines 168–201)

```
fn insert_history_cell_lines_with_initial_replay_buffer(
        &mut self,
        tui: &mut tui::Tui,
        cell: &dyn HistoryCell,
        width: u16,
    )
```

**Purpose**: Adds a history cell during startup replay, respecting any replay buffer and row cap. It prevents large resumed sessions from writing more scrollback rows than the app is willing to rebuild later.

**Data flow**: It receives the terminal, a cell, and a width. If tail rendering is planned, it skips per-cell rendering. Otherwise it formats the cell. If a replay buffer and row cap exist, it keeps only the newest rows in that buffer; without a cap, it either defers lines for an overlay or writes them immediately.

**Call relations**: This is the replay-aware version of normal history insertion. It uses the same formatter as regular insertion, may call the buffer-trimming helper, and writes through the same terminal insertion path when buffering is not needed.

*Call graph*: calls 3 internal fn (display_lines_for_history_insert, history_line_wrap_policy, resize_reflow_max_rows); 2 external calls (buffer_initial_history_replay_display_lines, insert_history_hyperlink_lines_with_wrap_policy).


##### `App::history_line_wrap_policy`  (lines 203–209)

```
fn history_line_wrap_policy(&self) -> HistoryLineWrapPolicy
```

**Purpose**: Chooses how inserted history lines should be wrapped by the terminal layer. Raw output mode uses the terminal’s own wrapping; normal chat mode uses pre-wrapped lines prepared by the app.

**Data flow**: It reads whether the chat widget is in raw output mode. From that single setting it returns either the terminal wrapping policy or the pre-wrap policy.

**Call relations**: Every path that writes rebuilt or replayed history asks this function for the wrapping rule. That keeps normal insertions, resize rebuilds, rollback rebuilds, and replay flushing consistent.

*Call graph*: called by 5 (finish_initial_history_replay_buffer, insert_history_cell_lines, insert_history_cell_lines_with_initial_replay_buffer, rebuild_transcript_after_backtrack, reflow_transcript_now).


##### `App::buffer_initial_history_replay_display_lines`  (lines 216–225)

```
fn buffer_initial_history_replay_display_lines(
        buffer: &mut InitialHistoryReplayBuffer,
        display: Vec<HyperlinkLine>,
        max_rows: usize,
    )
```

**Purpose**: Keeps only the newest display rows in the initial replay buffer. This mirrors terminal scrollback behavior, where old rows fall off the top when a row limit is reached.

**Data flow**: It receives the replay buffer, a batch of display lines, and the maximum row count. It appends the new lines, then removes lines from the front until the buffer is within the limit. It changes the buffer and returns nothing.

**Call relations**: The replay-aware insertion path calls this when startup replay is being capped. It trims display rows, not source transcript cells, so other features still have the full conversation history.


##### `App::schedule_resize_reflow`  (lines 227–229)

```
fn schedule_resize_reflow(&mut self, target_width: Option<u16>) -> bool
```

**Purpose**: Asks the transcript reflow tracker to schedule a resize rebuild, usually after a short quiet period. This avoids rebuilding repeatedly while the user is still dragging the terminal size.

**Data flow**: It receives an optional target width and passes it to the reflow scheduler stored in the app. It returns whether a new frame should be scheduled immediately.

**Call relations**: The draw-size change handler calls this after deciding that the transcript needs rebuilding. The scheduler’s answer controls whether the frame requester wakes up now or after the debounce delay.

*Call graph*: called by 1 (handle_draw_size_change).


##### `App::resize_reflow_max_rows`  (lines 231–233)

```
fn resize_reflow_max_rows(&self) -> Option<usize>
```

**Purpose**: Reads the configured limit for how many terminal rows resize reflow should retain. If no limit is configured, resize replay may render the whole transcript.

**Data flow**: It reads the terminal resize reflow setting from the app config and passes it to the resize-cap helper. It returns either a maximum row count or no limit.

**Call relations**: Replay buffering and transcript rendering call this so startup, thread switching, and resize rebuilds all follow the same row-retention rule.

*Call graph*: calls 1 internal fn (resize_reflow_max_rows); called by 3 (begin_thread_switch_history_replay_buffer, insert_history_cell_lines_with_initial_replay_buffer, render_transcript_lines_for_reflow).


##### `App::clear_terminal_for_resize_replay`  (lines 235–247)

```
fn clear_terminal_for_resize_replay(&mut self, tui: &mut tui::Tui) -> Result<()>
```

**Purpose**: Clears the terminal area before replaying rebuilt transcript lines. This removes old scrollback that was wrapped for the wrong size or no longer exists in the source transcript.

**Data flow**: It receives the terminal wrapper. If the alternate screen is active, it clears the visible screen; otherwise it clears scrollback plus the visible screen using terminal escape behavior. It also moves the viewport area back to the top if needed. It returns success or an error from the terminal operations.

**Call relations**: Resize reflow and rollback rebuild both call this before inserting freshly rendered transcript rows. It is the cleanup step between old terminal output and the new source-backed replay.

*Call graph*: called by 2 (rebuild_transcript_after_backtrack, reflow_transcript_now); 1 external calls (is_alt_screen_active).


##### `App::maybe_finish_stream_reflow`  (lines 256–264)

```
fn maybe_finish_stream_reflow(&mut self, tui: &mut tui::Tui) -> Result<()>
```

**Purpose**: After streamed assistant output has been finalized, this checks whether a resize happened during streaming and repairs the terminal if needed. Without this, scrollback could keep lines from temporary stream cells instead of finalized transcript cells.

**Data flow**: It asks the reflow tracker whether stream-finish repair is needed. If yes, it schedules an immediate reflow and runs it. If not, but a pending reflow is already due, it requests a frame. It returns success or any error from the reflow run.

**Call relations**: Stream consolidation calls this after temporary stream cells have been replaced or confirmed. It may hand off to immediate scheduling and then to the normal resize reflow runner.

*Call graph*: calls 2 internal fn (maybe_run_resize_reflow, schedule_immediate_resize_reflow); 2 external calls (now, frame_requester).


##### `App::schedule_immediate_resize_reflow`  (lines 266–269)

```
fn schedule_immediate_resize_reflow(&mut self, tui: &mut tui::Tui)
```

**Purpose**: Forces resize reflow to happen on the next frame instead of waiting for the normal debounce delay. This is used when correctness depends on repairing scrollback right away.

**Data flow**: It marks the transcript reflow tracker as immediate and asks the terminal frame requester to schedule a frame. It returns nothing but changes scheduling state.

**Call relations**: Stream-finalization paths call this before running or requesting resize reflow. It is the fast lane into the same rebuild machinery used for ordinary resizes.

*Call graph*: called by 2 (finish_required_stream_reflow, maybe_finish_stream_reflow); 1 external calls (frame_requester).


##### `App::finish_required_stream_reflow`  (lines 276–283)

```
fn finish_required_stream_reflow(&mut self, tui: &mut tui::Tui) -> Result<()>
```

**Purpose**: Runs a required post-stream rebuild, especially for finalized proposed plans. It makes sure completed streamed content is replayed from its final source-backed cell form.

**Data flow**: It schedules immediate reflow, tries to run it, and then clears stream flags if no reflow remains pending. It returns success or an error from the rebuild work.

**Call relations**: This is a stricter stream-finish path than the optional checker. It calls the immediate scheduler and the normal reflow runner, then cleans up stream bookkeeping once the repair is complete.

*Call graph*: calls 2 internal fn (maybe_run_resize_reflow, schedule_immediate_resize_reflow).


##### `App::handle_draw_size_change`  (lines 291–320)

```
fn handle_draw_size_change(
        &mut self,
        size: ratatui::layout::Size,
        last_known_screen_size: ratatui::layout::Size,
        frame_requester: &tui::FrameRequester,
    ) -> bool
```

**Purpose**: Notices terminal width or height changes during drawing and decides whether transcript scrollback needs to be rebuilt. It also updates resize-aware UI state such as the chat widget and status line.

**Data flow**: It receives the current terminal size, the previously known size, and a frame requester. It records the new width, checks whether width or height changes require a rebuild, marks stream-time resize state when appropriate, schedules reflow, refreshes status information, and may clear a useless pending reflow. It returns whether the transcript should be rebuilt.

**Call relations**: The pre-render draw hook calls this before painting. When it decides work is needed, it uses the resize scheduler and frame requester so the actual rebuild can run at the right time.

*Call graph*: calls 5 internal fn (maybe_clear_resize_reflow_without_terminal, schedule_resize_reflow, should_mark_reflow_as_stream_time, schedule_frame, schedule_frame_in); called by 1 (handle_draw_pre_render).


##### `App::maybe_clear_resize_reflow_without_terminal`  (lines 322–333)

```
fn maybe_clear_resize_reflow_without_terminal(&mut self)
```

**Purpose**: Cancels a pending resize rebuild when there is no overlay and no transcript content left to replay. This prevents an empty app state from keeping stale resize work around forever.

**Data flow**: It checks whether a reflow deadline exists, whether that deadline has arrived, whether an overlay is active, and whether transcript cells exist. If the deadline has passed and there is nothing to rebuild, it clears the pending reflow and resets history emission state.

**Call relations**: The size-change handler calls this after scheduling decisions. It is a cleanup guard for cases where there is no terminal-backed transcript to repair.

*Call graph*: calls 1 internal fn (reset_history_emission_state); called by 1 (handle_draw_size_change); 1 external calls (now).


##### `App::handle_draw_pre_render`  (lines 335–350)

```
fn handle_draw_pre_render(&mut self, tui: &mut tui::Tui) -> Result<()>
```

**Purpose**: Runs resize-related checks just before a draw is rendered. It samples the terminal size, drops stale queued history lines if a rebuild is needed, and then tries to run any due reflow.

**Data flow**: It asks the terminal for its current size and compares it with the last known size through the size-change handler. If rebuild work is needed, it clears pending history insertions that may have been wrapped for the old size. Then it calls the reflow runner. It returns success or an error from terminal or reflow operations.

**Call relations**: This is the main draw-time entry into this file’s logic. It connects terminal size sampling to scheduling, stale-line cleanup, and the actual reflow execution.

*Call graph*: calls 2 internal fn (handle_draw_size_change, maybe_run_resize_reflow); 2 external calls (clear_pending_history_lines, frame_requester).


##### `App::maybe_run_resize_reflow`  (lines 358–396)

```
fn maybe_run_resize_reflow(&mut self, tui: &mut tui::Tui) -> Result<()>
```

**Purpose**: Runs a pending resize rebuild once its debounce deadline has arrived. It waits while the user is still resizing and avoids rebuilding while an overlay owns the screen.

**Data flow**: It checks for a pending reflow deadline. If it is too early, it schedules another frame for the deadline. If an overlay is active, it waits. Otherwise it clears the pending marker, notes whether the rebuild is happening during streaming, rebuilds the transcript now, records the width that was reflowed, possibly marks stream-time work, and schedules one follow-up frame. It returns success or any rebuild error.

**Call relations**: The draw pre-render hook and stream-finish paths call this. It hands the real terminal rewrite to `reflow_transcript_now` and uses the frame requester to avoid getting stuck between resize events.

*Call graph*: calls 2 internal fn (reflow_transcript_now, should_mark_reflow_as_stream_time); called by 3 (finish_required_stream_reflow, handle_draw_pre_render, maybe_finish_stream_reflow); 2 external calls (now, frame_requester).


##### `App::reflow_transcript_now`  (lines 398–424)

```
fn reflow_transcript_now(&mut self, tui: &mut tui::Tui) -> Result<u16>
```

**Purpose**: Immediately rebuilds terminal scrollback from stored transcript cells at the current terminal width. This is the core resize repair operation.

**Data flow**: It reads the terminal width, asks the chat widget what history wrap width to use, and checks whether there are transcript cells. If there are none, it clears queued history and resets emission state. If cells exist, it renders them for the new width, clears stale queued lines, clears the terminal scrollback or screen, drops deferred history lines, and inserts the rebuilt lines. It returns the terminal width it used.

**Call relations**: The reflow runner calls this when a pending resize rebuild is due. It relies on the render function for source-backed lines and on the terminal-clear helper before replaying them.

*Call graph*: calls 4 internal fn (clear_terminal_for_resize_replay, history_line_wrap_policy, render_transcript_lines_for_reflow, reset_history_emission_state); called by 1 (maybe_run_resize_reflow); 2 external calls (clear_pending_history_lines, insert_history_hyperlink_lines_with_wrap_policy).


##### `App::rebuild_transcript_after_backtrack`  (lines 431–453)

```
fn rebuild_transcript_after_backtrack(&mut self, tui: &mut tui::Tui) -> Result<()>
```

**Purpose**: Rebuilds terminal scrollback after a rollback or backtrack removes transcript cells. Unlike resize reflow, it clears the terminal even if no transcript cells remain, so canceled prompts do not stay visible.

**Data flow**: It reads the terminal width and computes the wrap width. If no transcript cells remain, it resets emission state and uses an empty line list; otherwise it renders the current transcript. Then it clears queued history, clears the terminal, drops deferred lines, and writes the rebuilt rows if any exist. It returns success or a terminal error.

**Call relations**: Backtrack or rollback code uses this to make the terminal match the edited source transcript. It shares the same rendering, clearing, and insertion helpers as resize reflow, but is stricter about clearing empty history.

*Call graph*: calls 4 internal fn (clear_terminal_for_resize_replay, history_line_wrap_policy, render_transcript_lines_for_reflow, reset_history_emission_state); 3 external calls (new, clear_pending_history_lines, insert_history_hyperlink_lines_with_wrap_policy).


##### `App::render_transcript_lines_for_reflow`  (lines 462–523)

```
fn render_transcript_lines_for_reflow(&mut self, width: u16) -> ReflowRenderResult
```

**Purpose**: Turns stored transcript cells into the exact terminal rows needed for a resize rebuild. It can render only the newest rows when a row cap is configured, while preserving correct separators around stream continuations.

**Data flow**: It receives a wrap width. It reads the row cap, walks backward through transcript cells, renders cells into hyperlink-aware lines, and stops early once enough rows have been collected. If the retained tail starts in the middle of a stream continuation group, it extends backward to include the first cell in that group. Then it adds blank separators between top-level history items, trims the final rows to the cap, updates the app’s emission flag, and returns the rendered lines.

**Call relations**: Resize reflow, rollback rebuild, and buffered replay flushing call this whenever they need source-backed terminal rows. It is the layout engine that makes terminal scrollback match the stored transcript at a specific width.

*Call graph*: calls 2 internal fn (resize_reflow_max_rows, new); called by 3 (finish_initial_history_replay_buffer, rebuild_transcript_after_backtrack, reflow_transcript_now); 3 external calls (from, new, new).


##### `App::should_mark_reflow_as_stream_time`  (lines 530–537)

```
fn should_mark_reflow_as_stream_time(&self) -> bool
```

**Purpose**: Decides whether the current transcript state should be treated as stream-sensitive. This covers both actively streaming output and the short gap where temporary stream cells are still waiting to be consolidated.

**Data flow**: It reads the chat widget’s active agent-stream and plan-stream flags. It also checks the tail of the transcript for unfinished agent message cells or proposed plan stream cells. It returns true if any of those signs are present.

**Call relations**: The size-change handler calls this before scheduling resize work, and the reflow runner calls it before recording that a rebuild happened during streaming. Those marks later cause stream finalization to run a corrective source-backed rebuild.

*Call graph*: called by 2 (handle_draw_size_change, maybe_run_resize_reflow).


### Execution and auxiliary transcript rendering
These files cover execution-cell models and rendering plus adjacent rich renderers used for diffs, directives, overlays, and compact status/footer surfaces.

### `tui/src/exec_cell/mod.rs`

`orchestration` · `cross-cutting`

An “exec cell” is likely one block in the terminal interface that shows a command being run and the output it produced. This file does not contain the logic itself. Instead, it connects two nearby parts: `model`, which defines the data shapes such as an execution cell and command output, and `render`, which turns that data into visible terminal lines.

Think of it like a reception desk for this folder. Other code does not need to know which internal file contains `ExecCell`, `CommandOutput`, or the output rendering helpers. It can import them from this module instead. That keeps the rest of the project cleaner and makes it easier to reorganize the internals later without changing every caller.

It also exposes `ExecCall` only during tests. That means test code can inspect or build lower-level execution-call data, while normal production code is kept to the smaller public surface. This is a common way to keep internal details private unless tests need them.

Without this file, other parts of the terminal UI would have to reach directly into `model` and `render`, making the code more tightly coupled and harder to maintain.


### `tui/src/exec_cell/model.rs`

`data_model` · `main loop / transcript updates`

When the app runs commands, the terminal-style interface needs a reliable way to show them in the conversation history. This file is that record book. An ExecCall is one command run: what was asked, where it came from, whether it has output yet, when it started, and how long it took. An ExecCell is the transcript item that contains one or more of those calls.

The important idea is grouping. Some commands are exploratory, such as reading files, listing files, or searching. If several of those happen close together, the interface can show them as one combined “exploring” cell instead of cluttering the transcript with many tiny entries. But user shell commands are not grouped this way, because they are direct user actions and should stay distinct.

The file also protects routing by command ID. Each command has a call_id, like a claim ticket. When output or a finish event arrives, it must match the right ticket. If no matching call is found, the function reports that instead of pretending everything is fine. Without this, unrelated command output could be folded into the wrong transcript entry, making the history misleading.

#### Function details

##### `ExecCell::new`  (lines 42–47)

```
fn new(call: ExecCall, animations_enabled: bool) -> Self
```

**Purpose**: Creates a new transcript cell from one command run. This is used when the interface first needs a place to show a command and its future output.

**Data flow**: It receives one ExecCall and a yes-or-no setting for animations. It wraps that call in a one-item list and stores the animation setting. The result is a new ExecCell ready to be displayed and updated.

**Call relations**: This is the starting point for command cells. The active-command creation path and many display tests build cells through it, so later updates such as completion, output appending, and rendering all have a stable container to work with.

*Call graph*: called by 17 (new_active_exec_command, active_command_without_animations_is_stable, command_display_does_not_split_long_url_token, desired_transcript_height_accounts_for_wrapped_url_like_rows, exploring_display_does_not_split_long_url_like_search_query, output_display_does_not_split_long_url_like_token_without_scheme, user_shell_output_is_limited_by_screen_lines, coalesced_reads_dedupe_names, coalesces_reads_across_multiple_calls, coalesces_sequential_reads_within_one_call (+7 more)); 1 external calls (vec!).


##### `ExecCell::with_added_call`  (lines 49–75)

```
fn with_added_call(
        &self,
        call_id: String,
        command: Vec<String>,
        parsed: Vec<ParsedCommand>,
        source: ExecCommandSource,
        interaction_input: Option<Strin
```

**Purpose**: Tries to add another command to an existing cell, but only when both the existing cell and the new command are part of the same kind of exploratory work. This keeps related reads, listings, and searches together without accidentally grouping unrelated commands.

**Data flow**: It receives the new command’s ID, command text, parsed meaning, source, and optional interaction text. It builds a fresh ExecCall with the current time as its start time and no output yet. If the current cell is already an exploring cell and the new call is also exploratory, it returns a new ExecCell containing the old calls plus the new one; otherwise it returns nothing.

**Call relations**: This function asks is_exploring_cell about the existing cell and is_exploring_call about the new command. It is the gatekeeper that decides whether a new command joins an existing grouped transcript entry or must be shown separately.

*Call graph*: calls 1 internal fn (is_exploring_cell); 3 external calls (now, is_exploring_call, vec!).


##### `ExecCell::complete_call`  (lines 82–95)

```
fn complete_call(
        &mut self,
        call_id: &str,
        output: CommandOutput,
        duration: Duration,
    ) -> bool
```

**Purpose**: Marks one command inside the cell as finished. It is careful to report whether the command ID was actually found, because a missing ID means the finish event belongs somewhere else.

**Data flow**: It receives a call ID, the final command output, and the elapsed duration. It searches from the newest call backward for a matching ID. If it finds one, it stores the output, stores the duration, clears the live start time, and returns true. If it finds none, it changes nothing and returns false.

**Call relations**: This is used when an execution-end event arrives. Its true-or-false result helps the chat widget avoid attaching an orphan finish event to the wrong active exploring cell.


##### `ExecCell::should_flush`  (lines 97–99)

```
fn should_flush(&self) -> bool
```

**Purpose**: Decides whether this cell is ready to be moved out of the active area and into stable transcript history. Non-exploring cells can be flushed once every command inside them has finished.

**Data flow**: It reads the cell’s calls and checks two things: the cell must not be an exploring group, and every call must already have output. It returns true only when both are true.

**Call relations**: It calls is_exploring_cell to keep grouped exploring entries from being flushed by the same rule as ordinary command cells. This helps the transcript keep active grouped exploration visible while it may still grow.

*Call graph*: calls 1 internal fn (is_exploring_cell).


##### `ExecCell::mark_failed`  (lines 101–117)

```
fn mark_failed(&mut self)
```

**Purpose**: Turns any still-running calls in the cell into failed calls. This is useful when something interrupts execution and the interface still needs a finished-looking record instead of a spinner forever.

**Data flow**: It walks through every call. For each call without output, it calculates how long it had been running if a start time exists, clears the start time, stores that duration, and inserts an empty failed CommandOutput with exit code 1. Finished calls are left alone.

**Call relations**: This function is a cleanup path for active cells. Instead of handing work to another helper, it directly fills in failure output so later display code can treat the call as completed.

*Call graph*: 1 external calls (new).


##### `ExecCell::is_exploring_cell`  (lines 119–121)

```
fn is_exploring_cell(&self) -> bool
```

**Purpose**: Checks whether every command in the cell is an exploratory read, list, or search command. This tells the interface whether the cell is allowed to behave like a grouped exploration entry.

**Data flow**: It looks at each ExecCall in the cell and applies the exploring-command test to it. If all calls pass, it returns true; if any call does not, it returns false.

**Call relations**: This is used by should_flush and with_added_call. In both places it acts like a label check: before special grouped behavior is allowed, the cell must prove it is made only of exploratory commands.

*Call graph*: called by 2 (should_flush, with_added_call).


##### `ExecCell::is_active`  (lines 123–125)

```
fn is_active(&self) -> bool
```

**Purpose**: Reports whether any command in the cell is still unfinished. The interface can use this to decide whether the cell should still look live.

**Data flow**: It scans the calls for one whose output is still missing. If it finds one, it returns true. If every call has output, it returns false.

**Call relations**: No specific caller is shown in the provided graph, but this is the natural status check used by transcript and rendering code when deciding whether a cell represents ongoing work.


##### `ExecCell::active_start_time`  (lines 127–132)

```
fn active_start_time(&self) -> Option<Instant>
```

**Purpose**: Finds when the first still-running command in the cell began. This supports live elapsed-time displays, such as showing how long a command has been running.

**Data flow**: It searches for the first call without output. If that call has a recorded start time, it returns it. If there is no active call or no start time, it returns nothing.

**Call relations**: No specific caller is shown in the provided graph, but it fits with live display behavior: once a cell is known to be active, this gives the time needed to calculate a running duration.


##### `ExecCell::animations_enabled`  (lines 134–136)

```
fn animations_enabled(&self) -> bool
```

**Purpose**: Returns whether this cell should use animations while it is displayed. This lets tests or settings turn animated behavior on or off without changing the command data.

**Data flow**: It reads the stored animation flag from the cell and returns it unchanged. It does not modify the cell.

**Call relations**: No specific caller is shown in the provided graph, but rendering code can ask this before showing spinners or other moving visual elements.


##### `ExecCell::iter_calls`  (lines 138–140)

```
fn iter_calls(&self) -> impl Iterator<Item = &ExecCall>
```

**Purpose**: Provides read-only access to the command calls inside the cell. This lets other code inspect or render the calls without taking ownership of them.

**Data flow**: It reads the cell’s internal list of calls and returns an iterator, which is a way to visit each call one at a time. Nothing is changed.

**Call relations**: No specific caller is shown in the provided graph, but this is the safe doorway for display or summary code that needs to look through all calls in a cell.


##### `ExecCell::append_output`  (lines 142–152)

```
fn append_output(&mut self, call_id: &str, chunk: &str) -> bool
```

**Purpose**: Adds a new piece of live command output to the matching call. This is used while a command is still producing text before the final result arrives.

**Data flow**: It receives a call ID and an output chunk. Empty chunks are ignored and return false. For non-empty chunks, it searches from the newest call backward for the matching ID. If found, it creates a default output record if needed, appends the chunk to the aggregated output text, and returns true. If no call matches, it returns false.

**Call relations**: This is the progress-update companion to complete_call. Output chunks can arrive before the command is finished, and this function makes sure they are attached only to the call with the matching ID.


##### `ExecCell::is_exploring_call`  (lines 154–165)

```
fn is_exploring_call(call: &ExecCall) -> bool
```

**Purpose**: Decides whether one command counts as exploratory work that may be grouped with similar commands. In this file, exploratory means a non-user-shell command that parsed into read, list-files, or search operations.

**Data flow**: It reads the call’s source and parsed command list. It returns false for direct user shell commands, false for commands with no parsed meaning, and true only when every parsed command is a read, file listing, or search.

**Call relations**: with_added_call uses this to judge a new call, and is_exploring_cell uses it across the whole cell. Together, those checks prevent unrelated or user-entered shell commands from being hidden inside an exploration group.

*Call graph*: 1 external calls (matches!).


##### `ExecCall::is_user_shell_command`  (lines 169–171)

```
fn is_user_shell_command(&self) -> bool
```

**Purpose**: Checks whether this command came directly from the user’s shell input. This is useful because direct user commands are treated differently from automated exploration commands.

**Data flow**: It reads the call’s source field and returns true if the source is UserShell. Otherwise it returns false. It does not change the call.

**Call relations**: No specific caller is shown in the provided graph, but this helper gives display or decision-making code a plain way to ask, “Was this the user’s own shell command?”

*Call graph*: 1 external calls (matches!).


##### `ExecCall::is_unified_exec_interaction`  (lines 173–175)

```
fn is_unified_exec_interaction(&self) -> bool
```

**Purpose**: Checks whether this command came from a unified execution interaction source. This lets other code recognize that special kind of command origin without repeating the source comparison.

**Data flow**: It reads the call’s source field and returns true if the source is UnifiedExecInteraction. Otherwise it returns false. The call is not changed.

**Call relations**: No specific caller is shown in the provided graph, but this helper is meant for places that need to adjust display or behavior based on this particular command source.

*Call graph*: 1 external calls (matches!).


### `tui/src/exec_cell/render.rs`

`domain_logic` · `main loop rendering`

When the app runs a shell command, the raw facts are not enough for a human: there is a command, maybe parsed actions, maybe output, maybe an exit code, and maybe a long stream of text. This file is the display layer that turns those facts into clear lines for the terminal interface. It is like a careful editor: it adds bullets, labels such as “Running” or “Ran”, colors success and failure, wraps long text to fit the terminal width, and trims huge output so one command cannot flood the screen.

The file supports two main views. The normal history view shows a compact summary, with only a short output preview and a hint that the full transcript is available. The transcript view shows the command and its formatted output more fully, including duration and success or failure. There is also a special “Exploring” view that groups file reads, searches, and directory listings into friendlier summaries.

A major detail is safe truncation. Output is shortened by visible screen rows, not just by newline count, because one very long URL can wrap into many rows. The file also avoids splitting URL-like tokens where possible, making copied or read commands easier to understand.

#### Function details

##### `new_active_exec_command`  (lines 44–65)

```
fn new_active_exec_command(
    call_id: String,
    command: Vec<String>,
    parsed: Vec<ParsedCommand>,
    source: ExecCommandSource,
    interaction_input: Option<String>,
    animations_enabled:
```

**Purpose**: Creates a new execution cell for a command that has just started. This gives the rest of the UI a ready-made object it can render as “currently running.”

**Data flow**: It receives the command ID, command words, parsed command summary, source of the command, optional interaction input, and whether animations are enabled. It records the current time as the start time, leaves output and duration empty, wraps everything in an ExecCall, and returns a new ExecCell.

**Call relations**: This is used when a command first enters the history before any output exists. It hands the freshly built call to ExecCell::new, and later the rendering methods in this file turn that cell into visible lines.

*Call graph*: calls 1 internal fn (new); 1 external calls (now).


##### `format_unified_exec_interaction`  (lines 67–80)

```
fn format_unified_exec_interaction(command: &[String], input: Option<&str>) -> String
```

**Purpose**: Builds a short human sentence for an interactive command event, such as waiting for a process or sending input to it. This makes interaction logs read like plain English instead of raw shell data.

**Data flow**: It receives the command and optional input text. It extracts the bash script when possible, otherwise joins the command words, then either says the app waited for the command or says it interacted with the command and sent a shortened input preview.

**Call relations**: ExecCell::command_display_lines calls this when a command is marked as a unified execution interaction. It relies on summarize_interaction_input to keep any sent input short and safe to display.

*Call graph*: calls 2 internal fn (extract_bash_command, summarize_interaction_input); called by 1 (command_display_lines); 1 external calls (format!).


##### `summarize_interaction_input`  (lines 82–95)

```
fn summarize_interaction_input(input: &str) -> String
```

**Purpose**: Makes interactive input safe and short enough to show inline. It prevents multiline or very long input from making the history view noisy.

**Data flow**: It receives raw input text, replaces real newlines with the visible text “\n”, escapes backticks, and cuts the result to a fixed preview length with an ellipsis if needed. It returns the cleaned preview string.

**Call relations**: format_unified_exec_interaction calls this only when there is non-empty interaction input. The result becomes part of the one-line interaction summary shown by ExecCell::command_display_lines.

*Call graph*: called by 1 (format_unified_exec_interaction); 1 external calls (new).


##### `output_lines`  (lines 103–184)

```
fn output_lines(
    output: Option<&CommandOutput>,
    params: OutputLinesParams,
) -> OutputLines
```

**Purpose**: Turns command output into dimmed terminal lines for a compact preview. It also shortens very long output by keeping the beginning and end and inserting an omitted-lines message in the middle.

**Data flow**: It receives optional command output plus display options such as line limit, whether to show only errors, and whether to add gutter prefixes. If there is no relevant output, it returns no lines. Otherwise it parses each output line, preserves ANSI color escape styling, dims it, adds prefixes if requested, inserts a transcript hint when lines are skipped, and returns both the visible lines and the count omitted.

**Call relations**: ExecCell::command_display_lines uses this before wrapping and trimming output for the main history view. Several tests call it directly to protect the ellipsis and transcript-hint behavior.

*Call graph*: called by 3 (command_display_lines, output_lines_ellipsis_includes_transcript_hint, user_shell_output_is_limited_by_screen_lines); 3 external calls (new, ansi_escape_line, output_ellipsis_line).


##### `activity_marker`  (lines 186–193)

```
fn activity_marker(start_time: Option<Instant>, animations_enabled: bool) -> Span<'static>
```

**Purpose**: Chooses the small marker shown next to an active command. It can animate when motion is allowed, or fall back to a steady bullet when animations are disabled.

**Data flow**: It receives the command start time and an animation setting. It converts that setting into a motion mode, asks the shared activity indicator for a marker, and returns either that marker or a dim bullet as a fallback.

**Call relations**: ExecCell::command_display_lines calls this for running commands. The same visual idea is also used in the exploring display path to show active exploration.

*Call graph*: calls 2 internal fn (from_animations_enabled, activity_indicator); called by 1 (command_display_lines).


##### `ExecCell::display_lines`  (lines 196–202)

```
fn display_lines(&self, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Chooses which on-screen summary to draw for an execution cell. It is the main entry point used by the history UI when it needs visible lines.

**Data flow**: It receives the available terminal width through the method argument and reads whether the cell represents exploration. It then returns either exploration-style lines or normal command-style lines.

**Call relations**: The HistoryCell trait calls this as the standard display method. It delegates the real formatting work to ExecCell::exploring_display_lines or ExecCell::command_display_lines.

*Call graph*: calls 2 internal fn (command_display_lines, exploring_display_lines).


##### `ExecCell::transcript_lines`  (lines 204–246)

```
fn transcript_lines(&self, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Builds the fuller transcript version of command execution. This view favors completeness over compactness, showing commands, output, duration, and success or failure.

**Data flow**: It reads each stored command call, cleans the shell command for display, applies bash highlighting, wraps it to the requested width, then appends formatted output when appropriate. If the command has finished, it adds a green success mark or red failure mark with the duration.

**Call relations**: ExecCell::raw_lines calls this before stripping styling. It is the fuller counterpart to ExecCell::display_lines, and the compact output previews point users toward this transcript with a keyboard shortcut hint.

*Call graph*: calls 6 internal fn (strip_bash_lc_and_escape, highlight_bash_to_lines, push_owned_lines, new, adaptive_wrap_line, adaptive_wrap_lines); called by 1 (raw_lines); 3 external calls (from, format!, vec!).


##### `ExecCell::raw_lines`  (lines 248–250)

```
fn raw_lines(&self) -> Vec<Line<'static>>
```

**Purpose**: Produces a plain-text version of the transcript. This is useful when styling should be removed, such as for copying or non-rich display.

**Data flow**: It asks ExecCell::transcript_lines for the widest practical transcript, then passes those styled lines through plain_lines to remove terminal styling. It returns the plain lines.

**Call relations**: This is part of the HistoryCell implementation. It reuses the transcript-building path rather than creating a separate raw rendering system.

*Call graph*: calls 2 internal fn (transcript_lines, plain_lines).


##### `ExecCell::output_ellipsis_text`  (lines 254–256)

```
fn output_ellipsis_text(omitted: usize) -> String
```

**Purpose**: Creates the standard message used when output has been shortened. The message includes how many lines are hidden and reminds the user how to open the transcript.

**Data flow**: It receives a count of omitted lines and formats it into text like “... +N lines (ctrl + t to view transcript)”. It returns that string.

**Call relations**: The output ellipsis helpers use this to keep all shortened-output messages consistent. It is also referenced by tests that verify the visible wording.

*Call graph*: 1 external calls (format!).


##### `ExecCell::output_ellipsis_line`  (lines 258–260)

```
fn output_ellipsis_line(omitted: usize) -> Line<'static>
```

**Purpose**: Wraps the standard omitted-output message into a styled terminal line. It is used when the output preview is cut down.

**Data flow**: It receives the omitted line count, builds the shared ellipsis text, dims it, and returns it as a Line value for the terminal UI.

**Call relations**: output_lines calls this when it removes the middle of a long output preview. Other ellipsis helpers provide prefixed variants for aligned output blocks.

*Call graph*: 2 external calls (from, vec!).


##### `ExecCell::exploring_display_lines`  (lines 262–363)

```
fn exploring_display_lines(&self, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Builds the compact display for a group of exploration actions, such as reading files, listing folders, or searching. It turns low-level parsed commands into a short activity summary.

**Data flow**: It reads the cell’s calls, groups consecutive read-only calls together, labels actions as “Read”, “List”, “Search”, or “Run”, wraps each summary to the terminal width, and adds indentation so the actions sit under an “Exploring” or “Explored” heading.

**Call relations**: ExecCell::display_lines calls this when the cell is an exploration cell. It uses wrapping and prefix helpers so the result visually matches the rest of the history.

*Call graph*: calls 4 internal fn (prefix_lines, push_owned_lines, new, adaptive_wrap_line); called by 1 (display_lines); 3 external calls (from, new, vec!).


##### `ExecCell::command_display_lines`  (lines 365–508)

```
fn command_display_lines(&self, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Builds the normal compact history display for a single command. It shows the command status, command text, and a bounded preview of its output.

**Data flow**: It reads the single execution call in the cell, chooses a colored or animated bullet based on success, failure, or running state, formats and highlights the command, wraps long command text, then adds output if available. Output is first converted to styled lines, then wrapped, prefixed, and trimmed so it fits within the allowed number of visible rows.

**Call relations**: ExecCell::display_lines calls this for ordinary command cells. It brings together many helpers in this file: activity_marker for running state, format_unified_exec_interaction for interaction summaries, output_lines for raw output previews, and truncation helpers to keep the UI compact.

*Call graph*: calls 9 internal fn (activity_marker, format_unified_exec_interaction, output_lines, strip_bash_lc_and_escape, highlight_bash_to_lines, prefix_lines, push_owned_lines, new, adaptive_wrap_line); called by 1 (display_lines); 7 external calls (from, limit_lines_from_start, truncate_lines_middle, from, new, panic!, vec!).


##### `ExecCell::limit_lines_from_start`  (lines 510–521)

```
fn limit_lines_from_start(lines: &[Line<'static>], keep: usize) -> Vec<Line<'static>>
```

**Purpose**: Keeps only the first few lines of a list and adds a simple ellipsis if more were present. It is used for command text continuation, not command output.

**Data flow**: It receives a list of styled lines and a maximum number to keep. If the list already fits, it returns a copy. If not, it returns the first kept lines plus a final “... +N lines” message.

**Call relations**: ExecCell::command_display_lines uses this to prevent long command displays from taking over the screen. Unlike output truncation, its ellipsis does not include the transcript shortcut hint, which tests verify.

*Call graph*: 4 external calls (len, to_vec, ellipsis_line, vec!).


##### `ExecCell::truncate_lines_middle`  (lines 539–630)

```
fn truncate_lines_middle(
        lines: &[Line<'static>],
        max_rows: usize,
        width: u16,
        omitted_hint: Option<usize>,
        ellipsis_prefix: Option<Line<'static>>,
    ) -> Ve
```

**Purpose**: Shortens a list of lines to fit a row budget while preserving both the beginning and the end. This is important for command output, where the first and last lines are often the most useful.

**Data flow**: It receives styled lines, a maximum number of visible rows, terminal width, an optional previously omitted count, and an optional prefix. It estimates how many screen rows each line will occupy after wrapping, reserves space for an ellipsis line, keeps as many rows as possible from the top and bottom, and returns the shortened list with an omitted-lines message in the middle.

**Call relations**: ExecCell::command_display_lines uses this after output has already been wrapped and prefixed. Its helper calls make sure the ellipsis itself fits the same width and aligns with the output gutter.

*Call graph*: 8 external calls (iter, len, to_vec, output_ellipsis_line_with_prefix, output_ellipsis_row_count, new, from, vec!).


##### `ExecCell::ellipsis_line`  (lines 632–634)

```
fn ellipsis_line(omitted: usize) -> Line<'static>
```

**Purpose**: Creates a simple omitted-lines message without the transcript shortcut. This is used for trimming command text, not output.

**Data flow**: It receives the number of hidden lines, formats that into a dim styled line, and returns it.

**Call relations**: ExecCell::limit_lines_from_start calls this when a command’s continuation lines exceed the allowed count. Tests confirm that this command ellipsis stays simpler than the output ellipsis.

*Call graph*: 2 external calls (from, vec!).


##### `ExecCell::output_ellipsis_row_count`  (lines 636–647)

```
fn output_ellipsis_row_count(
        omitted: usize,
        width: u16,
        prefix: Option<&Line<'static>>,
    ) -> usize
```

**Purpose**: Calculates how many visible terminal rows the output ellipsis line will take. This helps the truncation logic keep within the screen-space budget.

**Data flow**: It receives an omitted count, terminal width, and optional prefix. It builds the same ellipsis line that would be displayed, asks the terminal paragraph wrapper how many rows it needs, and returns at least one row.

**Call relations**: ExecCell::truncate_lines_middle calls this before choosing how many output rows to keep. This prevents the hint line itself from causing the output block to exceed its limit.

*Call graph*: 3 external calls (new, from, vec!).


##### `ExecCell::output_ellipsis_line_with_prefix`  (lines 651–658)

```
fn output_ellipsis_line_with_prefix(
        omitted: usize,
        prefix: Option<&Line<'static>>,
    ) -> Line<'static>
```

**Purpose**: Builds an omitted-output line that can line up with the output gutter. This keeps the truncation message visually inside the output block.

**Data flow**: It receives an omitted count and an optional prefix line. It starts with that prefix if present, appends the standard dim ellipsis text, and returns the combined line.

**Call relations**: ExecCell::truncate_lines_middle uses this for the actual middle ellipsis, and ExecCell::output_ellipsis_row_count uses it to measure how much space that same line will take.

*Call graph*: 1 external calls (output_ellipsis_text).


##### `PrefixedBlock::new`  (lines 668–673)

```
fn new(initial_prefix: &'static str, subsequent_prefix: &'static str) -> Self
```

**Purpose**: Defines the prefixes used for a block of wrapped text. A prefix is the small gutter text, such as a branch mark or vertical guide, placed before displayed lines.

**Data flow**: It receives an initial prefix and a subsequent-line prefix. It stores both in a PrefixedBlock value and returns it.

**Call relations**: The static execution display layout uses this to describe command continuation and output blocks. Later rendering code reads these prefixes when wrapping and aligning text.


##### `PrefixedBlock::wrap_width`  (lines 675–679)

```
fn wrap_width(self, total_width: u16) -> usize
```

**Purpose**: Finds how much horizontal space remains for content after a block’s prefix is added. This prevents wrapped text from overflowing the terminal width.

**Data flow**: It receives the total terminal width, measures the wider of the two prefixes, subtracts that from the total, and returns at least one column of usable content width.

**Call relations**: ExecCell::command_display_lines uses this through the display layout before wrapping command continuations and output blocks. The calculation keeps prefixes and content aligned.

*Call graph*: 2 external calls (width, from).


##### `ExecDisplayLayout::new`  (lines 691–703)

```
fn new(
        command_continuation: PrefixedBlock,
        command_continuation_max_lines: usize,
        output_block: PrefixedBlock,
        output_max_lines: usize,
    ) -> Self
```

**Purpose**: Collects the spacing rules for execution-cell display into one layout value. This makes the command and output limits easy to define together.

**Data flow**: It receives the command continuation block, its maximum line count, the output block, and its maximum line count. It stores those settings in an ExecDisplayLayout and returns it.

**Call relations**: The file’s constant EXEC_DISPLAY_LAYOUT is built with this function. ExecCell::command_display_lines then uses that layout every time it renders a command cell.


##### `tests::render_line_text`  (lines 719–724)

```
fn render_line_text(line: &Line<'static>) -> String
```

**Purpose**: Converts a styled terminal line into plain text for test comparisons. It lets tests check what a user would read without caring about colors or styles.

**Data flow**: It receives a Line made of styled spans, joins the text content of those spans, and returns one plain string.

**Call relations**: The tests in this file call this helper whenever they need stable string assertions. It keeps each test focused on rendering behavior rather than style internals.


##### `tests::user_shell_output_is_limited_by_screen_lines`  (lines 727–829)

```
fn user_shell_output_is_limited_by_screen_lines()
```

**Purpose**: Checks that very long user-shell output is limited by visible screen rows, not just by newline count. This protects the UI from being flooded by a few enormous wrapped lines.

**Data flow**: The test builds output containing very long URL-like lines, measures how large it would be without trimming, renders it through an ExecCell, and then checks that the output rows stay within the user-shell limit. It also checks that an ellipsis and transcript shortcut are shown.

**Call relations**: This test exercises output_lines, wrapping helpers, prefixing, and ExecCell::command_display_lines together. It guards the row-aware truncation path used in normal command rendering.

*Call graph*: calls 6 internal fn (new, output_lines, prefix_lines, push_owned_lines, new, adaptive_wrap_line); 8 external calls (new, from, new, from, new, assert!, format!, vec!).


##### `tests::truncate_lines_middle_keeps_omitted_count_in_line_units`  (lines 832–858)

```
fn truncate_lines_middle_keeps_omitted_count_in_line_units()
```

**Purpose**: Verifies that omitted counts are reported as logical lines, not wrapped screen rows. This keeps the user-facing count stable across different terminal widths.

**Data flow**: The test builds a small list with a long wrapping line and an existing omitted hint, truncates it, turns the result into text, and checks that the final ellipsis reports the expected hidden-line count.

**Call relations**: It directly tests ExecCell::truncate_lines_middle. This protects the counting behavior that ExecCell::command_display_lines relies on for output previews.

*Call graph*: 4 external calls (from, assert!, truncate_lines_middle, vec!).


##### `tests::output_lines_ellipsis_includes_transcript_hint`  (lines 861–888)

```
fn output_lines_ellipsis_includes_transcript_hint()
```

**Purpose**: Confirms that shortened output previews tell the user how to see the full transcript. This matters because hidden output should not feel lost.

**Data flow**: The test creates seven lines of output, asks output_lines to keep only two from each side, then checks that the rendered ellipsis includes the transcript shortcut text.

**Call relations**: It calls output_lines directly. The behavior it verifies is visible later when ExecCell::command_display_lines includes shortened command output.

*Call graph*: calls 1 internal fn (output_lines); 2 external calls (new, assert!).


##### `tests::command_truncation_ellipsis_does_not_include_transcript_hint`  (lines 891–910)

```
fn command_truncation_ellipsis_does_not_include_transcript_hint()
```

**Purpose**: Checks that command-text truncation uses a simpler ellipsis than output truncation. The transcript shortcut is only meant for hidden command output.

**Data flow**: The test passes three command lines into ExecCell::limit_lines_from_start with a keep count of two, converts the result to text, and compares it to the expected two lines plus a simple omitted-lines message.

**Call relations**: It directly protects ExecCell::limit_lines_from_start and ExecCell::ellipsis_line. This keeps command display shortening distinct from output preview shortening.

*Call graph*: 3 external calls (from, assert_eq!, limit_lines_from_start).


##### `tests::truncate_lines_middle_does_not_truncate_blank_prefixed_output_lines`  (lines 913–924)

```
fn truncate_lines_middle_does_not_truncate_blank_prefixed_output_lines()
```

**Purpose**: Ensures blank-looking prefixed output lines are still counted correctly. This prevents harmless whitespace lines from being removed when they actually fit.

**Data flow**: The test builds an output block with a start line, many blank prefixed lines, and an end line. It truncates with enough row budget and checks that the returned lines are unchanged.

**Call relations**: It directly tests ExecCell::truncate_lines_middle. This guards a subtle case in the row-counting logic used by command output rendering.

*Call graph*: 5 external calls (from, assert_eq!, repeat_n, truncate_lines_middle, vec!).


##### `tests::command_display_does_not_split_long_url_token`  (lines 927–958)

```
fn command_display_does_not_split_long_url_token()
```

**Purpose**: Checks that a long URL inside a displayed command is not broken across multiple rendered lines. This keeps URLs readable and copyable.

**Data flow**: The test creates a user shell command containing a long URL, renders the command display at a narrow width, and checks that the full URL appears together in one rendered line.

**Call relations**: It exercises ExecCell::command_display_lines through a realistic cell. The test protects the no-hyphenation wrapping choice used for command text.

*Call graph*: calls 1 internal fn (new); 3 external calls (new, assert_eq!, vec!).


##### `tests::active_command_without_animations_is_stable`  (lines 961–987)

```
fn active_command_without_animations_is_stable()
```

**Purpose**: Verifies that a running command renders consistently when animations are disabled. This avoids flickering or changing text in reduced-motion mode.

**Data flow**: The test creates an active command with a start time but animations turned off, renders it twice, and checks that both renderings are identical and show a plain running marker.

**Call relations**: It exercises ExecCell::command_display_lines and the activity_marker path. This protects the reduced-motion behavior used during normal rendering.

*Call graph*: calls 1 internal fn (new); 4 external calls (now, new, assert_eq!, vec!).


##### `tests::exploring_display_does_not_split_long_url_like_search_query`  (lines 990–1027)

```
fn exploring_display_does_not_split_long_url_like_search_query()
```

**Purpose**: Checks that exploration summaries do not split a long URL-like search query. This keeps search targets readable in the exploration view.

**Data flow**: The test creates an exploration-style search command with a long query, renders the display at a narrow width, and verifies that the full query appears together in one rendered line.

**Call relations**: It reaches ExecCell::exploring_display_lines through ExecCell::display_lines. This protects the same careful wrapping behavior for exploration summaries that command displays use.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert_eq!, vec!).


##### `tests::output_display_does_not_split_long_url_like_token_without_scheme`  (lines 1030–1065)

```
fn output_display_does_not_split_long_url_like_token_without_scheme()
```

**Purpose**: Checks that long URL-like output without an “http” scheme is not split apart. This matters for paths, artifact IDs, and API routes that users may need to read or copy.

**Data flow**: The test creates command output containing one very long URL-like token, renders the command display at a narrow width, and checks that the token remains whole in one rendered line.

**Call relations**: It exercises ExecCell::command_display_lines, including output_lines and output wrapping. The test protects output rendering for long unbroken tokens.

*Call graph*: calls 1 internal fn (new); 4 external calls (new, new, assert_eq!, vec!).


##### `tests::desired_transcript_height_accounts_for_wrapped_url_like_rows`  (lines 1068–1094)

```
fn desired_transcript_height_accounts_for_wrapped_url_like_rows()
```

**Purpose**: Verifies that transcript height calculations count wrapped rows, not only logical lines. This helps the transcript view reserve enough vertical space for long wrapped content.

**Data flow**: The test creates output containing a very long URL, asks for transcript lines at a narrow width, then compares the raw logical line count with the desired transcript height. It expects the desired height to be larger because wrapping creates extra rows.

**Call relations**: It uses ExecCell transcript rendering and the cell’s transcript height calculation. This protects the connection between transcript_lines and layout sizing elsewhere in the UI.

*Call graph*: calls 1 internal fn (new); 3 external calls (new, assert!, vec!).


### `tui/src/diff_render.rs`

`domain_logic` · `rendering`

This file is the terminal UI's diff painter. A diff is like a marked-up page showing what text was added, removed, or left nearby for context. Without this file, the app could know that files changed, but it would not have a clear, compact, color-coded way to show those changes to a person.

The file starts by choosing a visual style that fits the user's terminal. It checks whether the terminal background is light or dark, how many colors the terminal can show, and whether the current syntax theme has special colors for inserted or deleted text. On limited terminals it avoids strong background colors, because those can become ugly or unreadable.

It then builds a per-file summary: file path, rename target if any, number of added and removed lines, and the actual diff block. Added files are shown as all green insert lines, deleted files as red delete lines, and updated files are parsed into hunks, which are small separated sections of a larger patch. Long lines are hard-wrapped so they fit the available width, while preserving color spans across the break. For code files, it can syntax-highlight content by extension, and for update hunks it highlights a whole hunk at once so multi-line strings and comments keep the right color.

#### Function details

##### `RichDiffColorLevel::from_diff_color_level`  (lines 160–166)

```
fn from_diff_color_level(level: DiffColorLevel) -> Option<Self>
```

**Purpose**: Converts the renderer's general color capability into the smaller set that can safely use tinted backgrounds. It returns no value for ANSI-16 terminals because those terminals do not have enough gentle colors for readable diff backgrounds.

**Data flow**: It receives a color level → checks whether it is truecolor, 256-color, or ANSI-16 → returns the matching rich level for truecolor or 256-color, or nothing for ANSI-16.

**Call relations**: Background-picking helpers call this before choosing tinted colors. That lets later styling code skip impossible ANSI-16 background cases instead of repeatedly checking them.

*Call graph*: called by 3 (fallback_diff_backgrounds, resolve_diff_backgrounds_for, style_gutter_for).


##### `resolve_diff_backgrounds`  (lines 199–204)

```
fn resolve_diff_backgrounds(
    theme: DiffTheme,
    color_level: DiffColorLevel,
) -> ResolvedDiffBackgrounds
```

**Purpose**: Chooses the actual add and delete background colors for normal rendering. It combines the terminal's theme choice with any diff-specific colors supplied by the active syntax theme.

**Data flow**: It receives the light/dark theme and color depth → reads syntax-theme diff background settings → asks the pure resolver to combine those with fallback colors → returns resolved add/delete background colors.

**Call relations**: The current render style context calls this once per render pass. It hands off to the testable resolver after fetching live theme scope colors.

*Call graph*: calls 2 internal fn (resolve_diff_backgrounds_for, diff_scope_background_rgbs); called by 1 (current_diff_render_style_context).


##### `current_diff_render_style_context`  (lines 215–224)

```
fn current_diff_render_style_context() -> DiffRenderStyleContext
```

**Purpose**: Takes a snapshot of all style decisions needed to render diff lines consistently. Callers use it so every line in one render pass uses the same theme and color rules.

**Data flow**: It reads the terminal background, terminal color support, and syntax-theme diff backgrounds → bundles those decisions into a DiffRenderStyleContext → returns that context for line rendering.

**Call relations**: The main diff renderer calls this at the start of rendering a change. Preview code and tests also use it before asking lower-level line renderers to draw sample diff lines.

*Call graph*: calls 3 internal fn (diff_color_level, diff_theme, resolve_diff_backgrounds); called by 6 (render_change, fallback_wrapping_uses_display_width_for_tabs_and_wide_chars, ui_snapshot_syntax_highlighted_insert_wraps, ui_snapshot_syntax_highlighted_insert_wraps_text, ui_snapshot_wrap_behavior_insert, render_preview).


##### `resolve_diff_backgrounds_for`  (lines 232–249)

```
fn resolve_diff_backgrounds_for(
    theme: DiffTheme,
    color_level: DiffColorLevel,
    scope_backgrounds: DiffScopeBackgroundRgbs,
) -> ResolvedDiffBackgrounds
```

**Purpose**: Purely decides add and delete background colors from explicit inputs. It exists so the color policy can be tested without reading the real terminal or user theme.

**Data flow**: It starts with fallback colors → checks whether the terminal color level supports rich backgrounds → replaces fallback add/delete colors with syntax-theme scope colors when present → returns the final background pair.

**Call relations**: Production code reaches it through resolve_diff_backgrounds. Tests call it directly to prove theme overrides, ANSI-256 conversion, and ANSI-16 behavior.

*Call graph*: calls 3 internal fn (from_diff_color_level, color_from_rgb_for_level, fallback_diff_backgrounds); called by 5 (resolve_diff_backgrounds, ansi16_disables_line_and_gutter_backgrounds, theme_scope_backgrounds_override_truecolor_fallback_when_available, theme_scope_backgrounds_quantize_to_ansi256, ui_snapshot_theme_scope_background_resolution).


##### `fallback_diff_backgrounds`  (lines 253–264)

```
fn fallback_diff_backgrounds(
    theme: DiffTheme,
    color_level: DiffColorLevel,
) -> ResolvedDiffBackgrounds
```

**Purpose**: Provides built-in add and delete background colors when the syntax theme does not define its own diff colors. It deliberately returns no backgrounds for ANSI-16 terminals.

**Data flow**: It receives a light/dark theme and color level → checks whether rich backgrounds are allowed → returns green/red tinted backgrounds or an empty pair.

**Call relations**: The background resolver uses this as its baseline. Style tests also call it to verify the default palette.

*Call graph*: calls 3 internal fn (from_diff_color_level, add_line_bg, del_line_bg); called by 6 (resolve_diff_backgrounds_for, ansi16_add_style_uses_foreground_only, ansi16_del_style_uses_foreground_only, ansi16_sign_styles_use_foreground_only, light_theme_wrapped_lines_keep_number_gutter_contrast, ui_snapshot_ansi16_insert_delete_no_background); 1 external calls (default).


##### `color_from_rgb_for_level`  (lines 268–273)

```
fn color_from_rgb_for_level(rgb: (u8, u8, u8), color_level: RichDiffColorLevel) -> Color
```

**Purpose**: Turns an RGB color into the terminal color format appropriate for the current rich color mode. Truecolor keeps the exact color, while 256-color mode picks an approximation.

**Data flow**: It receives an RGB triple and a rich color level → either wraps the RGB directly or quantizes it to an ANSI-256 palette entry → returns a ratatui Color.

**Call relations**: The background resolver uses this when a syntax theme supplies custom inserted or deleted background colors.

*Call graph*: calls 2 internal fn (quantize_rgb_to_ansi256, rgb_color); called by 1 (resolve_diff_backgrounds_for).


##### `quantize_rgb_to_ansi256`  (lines 281–294)

```
fn quantize_rgb_to_ansi256(target: (u8, u8, u8)) -> Color
```

**Purpose**: Finds the closest safe ANSI-256 palette color for a requested RGB value. This keeps theme colors recognizable on terminals that cannot show full truecolor.

**Data flow**: It receives a target RGB color → compares it with known xterm palette colors using perceptual distance → returns the nearest indexed terminal color, or a safe fallback.

**Call relations**: Only color_from_rgb_for_level calls this, when custom theme colors must be adapted to 256-color terminals.

*Call graph*: calls 1 internal fn (indexed_color); called by 1 (color_from_rgb_for_level).


##### `DiffSummary::new`  (lines 302–304)

```
fn new(changes: HashMap<PathBuf, FileChange>, cwd: AbsolutePathBuf) -> Self
```

**Purpose**: Creates a DiffSummary value from a map of file changes and the current working directory. This packages the information needed to render a multi-file diff summary.

**Data flow**: It receives file changes and a current directory → stores both inside a DiffSummary → returns the new summary object.

**Call relations**: Other parts of the UI can build this summary and then convert it into a renderable block using the Box conversion in this file.


##### `FileChange::render`  (lines 308–312)

```
fn render(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Draws one file change into a terminal buffer. It converts the change into styled text lines, then lets ratatui render those lines in the given area.

**Data flow**: It receives a file change, screen rectangle, and output buffer → creates diff lines sized to the rectangle width → writes them into the buffer as a paragraph.

**Call relations**: Ratatui calls this through the Renderable trait. It delegates the real diff-line construction to render_change.

*Call graph*: calls 1 internal fn (render_change); 2 external calls (new, vec!).


##### `FileChange::desired_height`  (lines 314–318)

```
fn desired_height(&self, width: u16) -> u16
```

**Purpose**: Calculates how many terminal rows one rendered file change will need at a given width. This lets layout code reserve enough vertical space before drawing.

**Data flow**: It receives a width → renders the change into temporary lines using that width → returns the number of produced lines.

**Call relations**: Layout code calls this through the Renderable trait. It uses the same render_change path as actual drawing so measurement matches output.

*Call graph*: calls 1 internal fn (render_change); 1 external calls (vec!).


##### `Box::from`  (lines 322–343)

```
fn from(val: DiffSummary) -> Self
```

**Purpose**: Turns a DiffSummary into a renderable column of file headers and indented diff blocks. This is the bridge from stored change data to something the TUI can place on screen.

**Data flow**: It receives a DiffSummary → sorts and summarizes its rows → creates path headers, count summaries, blank separators, and inset file-change renderables → returns one boxed renderable column.

**Call relations**: This conversion is used when the UI wants to display a DiffSummary as a generic Renderable. It relies on collect_rows, display_path_for, and line-count rendering helpers.

*Call graph*: calls 6 internal fn (collect_rows, display_path_for, render_line_count_summary, tlbr, with, new); 3 external calls (new, from, vec!).


##### `create_diff_summary`  (lines 346–353)

```
fn create_diff_summary(
    changes: &HashMap<PathBuf, FileChange>,
    cwd: &Path,
    wrap_cols: usize,
) -> Vec<RtLine<'static>>
```

**Purpose**: Builds a plain list of styled terminal lines for a set of file changes. This is useful when callers want the rendered text directly instead of a boxed renderable widget.

**Data flow**: It receives file changes, current directory, and wrapping width → collects sorted row summaries → renders the whole block → returns styled ratatui lines.

**Call relations**: Many tests and snapshot helpers call this as the main public rendering path. It is a thin wrapper around collect_rows and render_changes_block.

*Call graph*: calls 2 internal fn (collect_rows, render_changes_block); called by 12 (add_diff_uses_path_extension_for_highlighting, delete_diff_uses_path_extension_for_highlighting, diff_summary_for_tests, large_update_diff_skips_highlighting, rename_diff_uses_destination_extension_for_highlighting, snapshot_diff_gallery, ui_snapshot_apply_update_block_line_numbers_three_digits_text, ui_snapshot_apply_update_block_relativizes_path, ui_snapshot_apply_update_block_wraps_long_lines, ui_snapshot_apply_update_block_wraps_long_lines_text (+2 more)).


##### `collect_rows`  (lines 366–391)

```
fn collect_rows(changes: &HashMap<PathBuf, FileChange>) -> Vec<Row>
```

**Purpose**: Turns raw file changes into sorted per-file presentation rows. Each row includes the path, rename target, added count, removed count, and cloned change data.

**Data flow**: It receives a map of paths to changes → counts lines for added/deleted files or parses update diffs for counts → records rename targets → sorts rows by path → returns the row list.

**Call relations**: Both summary rendering paths call this before building UI lines. It calls calculate_add_remove_from_diff for update patches.

*Call graph*: calls 1 internal fn (calculate_add_remove_from_diff); called by 2 (from, create_diff_summary); 1 external calls (new).


##### `render_line_count_summary`  (lines 393–401)

```
fn render_line_count_summary(added: usize, removed: usize) -> Vec<RtSpan<'static>>
```

**Purpose**: Creates the small '(+N -M)' summary shown next to file names. Added counts are green and removed counts are red.

**Data flow**: It receives added and removed line counts → formats them into styled spans → returns the span list for insertion into a header line.

**Call relations**: File summary headers use this in both the boxed renderable path and the direct line-list path.

*Call graph*: called by 2 (from, render_changes_block); 2 external calls (new, format!).


##### `render_changes_block`  (lines 403–465)

```
fn render_changes_block(rows: Vec<Row>, wrap_cols: usize, cwd: &Path) -> Vec<RtLine<'static>>
```

**Purpose**: Assembles the full multi-file diff summary as styled terminal lines. It creates the overall header, optional per-file headers, and indented diff content.

**Data flow**: It receives sorted rows, wrap width, and current directory → computes total counts → formats paths and rename arrows → detects file language by extension → renders each file change and prefixes indentation → returns all output lines.

**Call relations**: create_diff_summary calls this after row collection. It calls render_change for the actual per-line diff content and prefix_lines to indent that content under headers.

*Call graph*: calls 4 internal fn (detect_lang_for_path, render_change, render_line_count_summary, prefix_lines); called by 1 (create_diff_summary); 4 external calls (from, new, format!, vec!).


##### `detect_lang_for_path`  (lines 470–473)

```
fn detect_lang_for_path(path: &Path) -> Option<String>
```

**Purpose**: Guesses the code language from a file path extension. The result is passed to syntax highlighting, which later decides whether that extension is known.

**Data flow**: It receives a path → extracts its extension as text if one exists → returns that extension string or nothing.

**Call relations**: render_changes_block calls this before rendering a file. For renames, it is given the destination path so highlighting matches the new file type.

*Call graph*: called by 1 (render_changes_block); 1 external calls (extension).


##### `render_change`  (lines 475–737)

```
fn render_change(
    change: &FileChange,
    out: &mut Vec<RtLine<'static>>,
    width: usize,
    lang: Option<&str>,
)
```

**Purpose**: Converts one file change into styled diff lines. It is the main worker that handles added files, deleted files, and update patches differently.

**Data flow**: It receives a FileChange, output line vector, width, and optional language → snapshots style settings → optionally syntax-highlights content → formats each diff line with line numbers, signs, wrapping, and hunk separators → appends lines to the output vector.

**Call relations**: FileChange rendering, height measurement, and summary rendering all call this. It delegates individual line layout to push_wrapped_diff_line_inner_with_theme_and_color_level.

*Call graph*: calls 5 internal fn (current_diff_render_style_context, line_number_width, push_wrapped_diff_line_inner_with_theme_and_color_level, style_gutter_for, exceeds_highlight_limits); called by 3 (desired_height, render, render_changes_block); 5 external calls (from, styled, from_str, format!, vec!).


##### `display_path_for`  (lines 742–763)

```
fn display_path_for(path: &Path, cwd: &Path) -> String
```

**Purpose**: Formats a path so it is pleasant and stable for display. It prefers relative paths from the current directory or repository, and falls back to home-relative paths when helpful.

**Data flow**: It receives a path and current directory → if already relative, returns it unchanged → otherwise tries to strip the current directory, compare repository roots, or shorten through the home directory → returns a display string.

**Call relations**: Headers call this before showing file names. Tests check that absolute paths inside the working directory become readable relative paths.

*Call graph*: calls 1 internal fn (relativize_to_home); called by 2 (from, display_path_prefers_cwd_without_git_repo); 5 external calls (display, is_relative, strip_prefix, get_git_repo_root, diff_paths).


##### `calculate_add_remove_from_diff`  (lines 765–780)

```
fn calculate_add_remove_from_diff(diff: &str) -> (usize, usize)
```

**Purpose**: Counts inserted and deleted lines in a unified diff string. If the diff cannot be parsed, it safely reports zero counts.

**Data flow**: It receives diff text → parses it as a patch → walks every hunk line → increments added or removed counters for insert/delete lines → returns the two counts.

**Call relations**: collect_rows calls this for updated files so summary headers can show accurate '+N -M' counts.

*Call graph*: called by 1 (collect_rows); 1 external calls (from_str).


##### `push_wrapped_diff_line_with_style_context`  (lines 788–807)

```
fn push_wrapped_diff_line_with_style_context(
    line_number: usize,
    kind: DiffLineType,
    text: &str,
    width: usize,
    line_number_width: usize,
    style_context: DiffRenderStyleContext,
```

**Purpose**: Renders one plain-text diff line using a precomputed style context. It is a convenient entry point when there is no syntax highlighting to apply.

**Data flow**: It receives line number, line kind, text, width, number-column width, and style context → passes those along with no syntax spans → returns one or more wrapped styled lines.

**Call relations**: Preview code and wrapping tests use this. It delegates all layout and styling work to the inner line renderer.

*Call graph*: calls 1 internal fn (push_wrapped_diff_line_inner_with_theme_and_color_level); called by 3 (fallback_wrapping_uses_display_width_for_tabs_and_wide_chars, ui_snapshot_wrap_behavior_insert, render_preview).


##### `push_wrapped_diff_line_with_syntax_and_style_context`  (lines 816–836)

```
fn push_wrapped_diff_line_with_syntax_and_style_context(
    line_number: usize,
    kind: DiffLineType,
    text: &str,
    width: usize,
    line_number_width: usize,
    syntax_spans: &[RtSpan<'sta
```

**Purpose**: Renders one syntax-highlighted diff line using a precomputed style context. It preserves syntax colors while still showing diff signs and delete dimming.

**Data flow**: It receives line number, diff kind, raw text, width, line-number width, syntax spans, and style context → combines syntax spans with diff styling → returns wrapped styled terminal lines.

**Call relations**: Preview code and syntax-wrapping tests use this. It forwards to the same inner renderer as plain-text lines, but supplies syntax spans.

*Call graph*: calls 1 internal fn (push_wrapped_diff_line_inner_with_theme_and_color_level); called by 3 (ui_snapshot_syntax_highlighted_insert_wraps, ui_snapshot_syntax_highlighted_insert_wraps_text, render_preview).


##### `push_wrapped_diff_line_inner_with_theme_and_color_level`  (lines 839–939)

```
fn push_wrapped_diff_line_inner_with_theme_and_color_level(
    line_number: usize,
    kind: DiffLineType,
    text: &str,
    width: usize,
    line_number_width: usize,
    syntax_spans: Option<&[R
```

**Purpose**: Builds the final visible rows for a single diff line. It adds the line-number gutter, plus/minus sign, content styles, full-line background, and continuation indentation after wrapping.

**Data flow**: It receives line identity, text, width, optional syntax spans, theme, color level, and resolved backgrounds → chooses styles for gutter, sign, and content → wraps content to available columns → returns one or more ratatui lines.

**Call relations**: All higher-level diff rendering eventually reaches this function. It calls the style helpers and wrap_styled_spans to produce the exact terminal-ready rows.

*Call graph*: calls 8 internal fn (style_add, style_context, style_del, style_gutter_for, style_line_bg_for, style_sign_add, style_sign_del, wrap_styled_spans); called by 5 (push_wrapped_diff_line_with_style_context, push_wrapped_diff_line_with_syntax_and_style_context, render_change, light_theme_wrapped_lines_keep_number_gutter_contrast, ui_snapshot_ansi16_insert_delete_no_background); 5 external calls (from, styled, new, format!, vec!).


##### `wrap_styled_spans`  (lines 952–1021)

```
fn wrap_styled_spans(spans: &[RtSpan<'static>], max_cols: usize) -> Vec<Vec<RtSpan<'static>>>
```

**Purpose**: Splits styled text into chunks that fit within a column width without losing colors. It understands Unicode display width, including tabs and wide characters.

**Data flow**: It receives styled spans and a maximum column count → walks through characters, carrying each span's style → starts a new output chunk when the next character would overflow → returns one span list per wrapped line.

**Call relations**: The inner diff-line renderer calls this for both syntax-highlighted and plain text. Several tests call it directly to verify wrapping edge cases.

*Call graph*: called by 7 (push_wrapped_diff_line_inner_with_theme_and_color_level, wrap_styled_spans_flushes_at_span_boundary, wrap_styled_spans_preserves_styles, wrap_styled_spans_single_line, wrap_styled_spans_splits_long_content, wrap_styled_spans_tabs_have_visible_width, wrap_styled_spans_wraps_before_first_overflowing_char); 3 external calls (styled, new, take).


##### `line_number_width`  (lines 1023–1029)

```
fn line_number_width(max_line_number: usize) -> usize
```

**Purpose**: Calculates how wide the line-number gutter needs to be. This keeps signs and content aligned even when line numbers grow from one digit to many.

**Data flow**: It receives the largest line number → returns its digit count, or 1 for zero → callers use that width to right-align all line numbers.

**Call relations**: render_change uses this before rendering each file or patch. Tests and preview code use it when calling single-line render helpers.

*Call graph*: called by 8 (render_change, fallback_wrapping_uses_display_width_for_tabs_and_wide_chars, light_theme_wrapped_lines_keep_number_gutter_contrast, ui_snapshot_ansi16_insert_delete_no_background, ui_snapshot_syntax_highlighted_insert_wraps, ui_snapshot_syntax_highlighted_insert_wraps_text, ui_snapshot_wrap_behavior_insert, render_preview).


##### `diff_theme_for_bg`  (lines 1032–1039)

```
fn diff_theme_for_bg(bg: Option<(u8, u8, u8)>) -> DiffTheme
```

**Purpose**: Chooses a light or dark diff theme from an explicit background color sample. Unknown backgrounds default to dark because that is the safer assumption for many terminals.

**Data flow**: It receives an optional RGB background → checks whether the color is light → returns Light for light samples and Dark otherwise.

**Call relations**: diff_theme calls this after reading the terminal background. Keeping the decision separate makes it easy to test.

*Call graph*: calls 1 internal fn (is_light); called by 1 (diff_theme).


##### `diff_theme`  (lines 1042–1044)

```
fn diff_theme() -> DiffTheme
```

**Purpose**: Reads the terminal background and chooses the diff palette family. This decides whether add/delete tints should be dark-muted or light-pastel.

**Data flow**: It reads the default terminal background color → passes it to diff_theme_for_bg → returns the chosen diff theme.

**Call relations**: current_diff_render_style_context calls this once per render pass before lines are styled.

*Call graph*: calls 2 internal fn (diff_theme_for_bg, default_bg); called by 1 (current_diff_render_style_context).


##### `diff_color_level`  (lines 1054–1061)

```
fn diff_color_level() -> DiffColorLevel
```

**Purpose**: Determines how many colors the diff renderer should use in the current terminal session. It also applies special Windows Terminal rules so capable terminals are not underused.

**Data flow**: It reads stdout color support, terminal identity, WT_SESSION, and FORCE_COLOR → passes those signals to the pure policy function → returns the renderer's color level.

**Call relations**: current_diff_render_style_context calls this during style setup. The policy itself lives in diff_color_level_for_terminal for testability.

*Call graph*: calls 3 internal fn (diff_color_level_for_terminal, has_force_color_override, stdout_color_level); called by 1 (current_diff_render_style_context); 2 external calls (terminal_info, var_os).


##### `has_force_color_override`  (lines 1064–1066)

```
fn has_force_color_override() -> bool
```

**Purpose**: Checks whether the user explicitly set FORCE_COLOR. That variable is treated as user intent and can stop automatic color promotion.

**Data flow**: It reads the process environment → returns true if FORCE_COLOR exists, otherwise false.

**Call relations**: diff_color_level calls this before asking the color policy function to choose a final level.

*Call graph*: called by 1 (diff_color_level); 1 external calls (var_os).


##### `diff_color_level_for_terminal`  (lines 1090–1116)

```
fn diff_color_level_for_terminal(
    stdout_level: StdoutColorLevel,
    terminal_name: TerminalName,
    has_wt_session: bool,
    has_force_color_override: bool,
) -> DiffColorLevel
```

**Purpose**: Maps raw terminal color information into the diff renderer's color level. It contains the policy for promoting Windows Terminal to truecolor when appropriate.

**Data flow**: It receives reported color support, terminal name, whether WT_SESSION is set, and whether FORCE_COLOR is set → applies promotion and conservative fallback rules → returns TrueColor, Ansi256, or Ansi16.

**Call relations**: diff_color_level calls this with live environment data. Tests call it through focused cases to verify the policy table.

*Call graph*: called by 1 (diff_color_level).


##### `style_line_bg_for`  (lines 1141–1151)

```
fn style_line_bg_for(kind: DiffLineType, diff_backgrounds: ResolvedDiffBackgrounds) -> Style
```

**Purpose**: Chooses the full-width background style for an inserted, deleted, or context line. Context lines intentionally keep the terminal's normal background.

**Data flow**: It receives a diff line kind and resolved backgrounds → selects add background, delete background, or no background → returns a ratatui Style.

**Call relations**: The inner line renderer applies this to each output row so the tint stretches across the full terminal line.

*Call graph*: called by 1 (push_wrapped_diff_line_inner_with_theme_and_color_level); 1 external calls (default).


##### `style_context`  (lines 1153–1155)

```
fn style_context() -> Style
```

**Purpose**: Returns the default style for unchanged context text. It means 'do not add special coloring here.'

**Data flow**: It takes no project data → creates a default Style → returns it.

**Call relations**: The inner line renderer uses this for context signs and content.

*Call graph*: called by 1 (push_wrapped_diff_line_inner_with_theme_and_color_level); 1 external calls (default).


##### `add_line_bg`  (lines 1157–1164)

```
fn add_line_bg(theme: DiffTheme, color_level: RichDiffColorLevel) -> Color
```

**Purpose**: Returns the built-in background color for inserted lines. It chooses different colors for dark versus light terminals and for truecolor versus 256-color output.

**Data flow**: It receives a theme and rich color level → selects the matching green-tinted palette entry → returns it as a terminal color.

**Call relations**: fallback_diff_backgrounds calls this when rich backgrounds are available and no syntax theme override has replaced the add color.

*Call graph*: calls 2 internal fn (indexed_color, rgb_color); called by 1 (fallback_diff_backgrounds).


##### `del_line_bg`  (lines 1166–1173)

```
fn del_line_bg(theme: DiffTheme, color_level: RichDiffColorLevel) -> Color
```

**Purpose**: Returns the built-in background color for deleted lines. It mirrors add_line_bg but uses red-tinted palette entries.

**Data flow**: It receives a theme and rich color level → selects the matching red-tinted palette entry → returns it as a terminal color.

**Call relations**: fallback_diff_backgrounds calls this when rich backgrounds are available and no syntax theme override has replaced the delete color.

*Call graph*: calls 2 internal fn (indexed_color, rgb_color); called by 1 (fallback_diff_backgrounds).


##### `light_gutter_fg`  (lines 1175–1181)

```
fn light_gutter_fg(color_level: DiffColorLevel) -> Color
```

**Purpose**: Chooses the line-number text color used on light terminal themes. This keeps numbers readable against pastel gutter backgrounds.

**Data flow**: It receives the renderer color level → returns an RGB, indexed, or black foreground color depending on available color depth.

**Call relations**: style_gutter_for calls this whenever it builds a light-theme gutter style.

*Call graph*: calls 2 internal fn (indexed_color, rgb_color); called by 1 (style_gutter_for).


##### `light_add_num_bg`  (lines 1183–1188)

```
fn light_add_num_bg(color_level: RichDiffColorLevel) -> Color
```

**Purpose**: Chooses the stronger green gutter background for inserted lines on light themes. The gutter is darker than the line tint so the line number remains visible.

**Data flow**: It receives a rich color level → returns either a truecolor green or an ANSI-256 green background.

**Call relations**: style_gutter_for calls this for inserted lines when the terminal supports rich backgrounds.

*Call graph*: calls 2 internal fn (indexed_color, rgb_color); called by 1 (style_gutter_for).


##### `light_del_num_bg`  (lines 1190–1195)

```
fn light_del_num_bg(color_level: RichDiffColorLevel) -> Color
```

**Purpose**: Chooses the stronger red gutter background for deleted lines on light themes. It improves line-number contrast beside the pale delete background.

**Data flow**: It receives a rich color level → returns either a truecolor red or an ANSI-256 red background.

**Call relations**: style_gutter_for calls this for deleted lines when the terminal supports rich backgrounds.

*Call graph*: calls 2 internal fn (indexed_color, rgb_color); called by 1 (style_gutter_for).


##### `style_gutter_for`  (lines 1200–1220)

```
fn style_gutter_for(kind: DiffLineType, theme: DiffTheme, color_level: DiffColorLevel) -> Style
```

**Purpose**: Builds the style for the line-number gutter. On light themes it uses readable foregrounds and sometimes tinted backgrounds; on dark themes it simply dims the gutter.

**Data flow**: It receives line kind, theme, and color level → checks whether rich backgrounds are possible → chooses light-theme gutter colors or dim styling → returns a Style.

**Call relations**: render_change uses it for hunk separator gutters, and the inner line renderer uses it for every rendered diff line.

*Call graph*: calls 5 internal fn (from_diff_color_level, light_add_num_bg, light_del_num_bg, light_gutter_fg, style_gutter_dim); called by 2 (push_wrapped_diff_line_inner_with_theme_and_color_level, render_change); 1 external calls (default).


##### `style_sign_add`  (lines 1225–1234)

```
fn style_sign_add(
    theme: DiffTheme,
    color_level: DiffColorLevel,
    diff_backgrounds: ResolvedDiffBackgrounds,
) -> Style
```

**Purpose**: Chooses the style for the '+' sign on inserted lines. On dark themes it matches inserted content; on light themes it stays a simple green foreground.

**Data flow**: It receives theme, color level, and resolved backgrounds → either returns plain green sign styling or delegates to style_add → returns the sign Style.

**Call relations**: The inner line renderer calls this when building inserted rows. Tests verify the ANSI-16 path stays foreground-only.

*Call graph*: calls 1 internal fn (style_add); called by 2 (push_wrapped_diff_line_inner_with_theme_and_color_level, ansi16_sign_styles_use_foreground_only); 1 external calls (default).


##### `style_sign_del`  (lines 1237–1246)

```
fn style_sign_del(
    theme: DiffTheme,
    color_level: DiffColorLevel,
    diff_backgrounds: ResolvedDiffBackgrounds,
) -> Style
```

**Purpose**: Chooses the style for the '-' sign on deleted lines. It mirrors style_sign_add with red delete styling.

**Data flow**: It receives theme, color level, and resolved backgrounds → either returns plain red sign styling or delegates to style_del → returns the sign Style.

**Call relations**: The inner line renderer calls this when building deleted rows. Tests verify the ANSI-16 path stays foreground-only.

*Call graph*: calls 1 internal fn (style_del); called by 2 (push_wrapped_diff_line_inner_with_theme_and_color_level, ansi16_sign_styles_use_foreground_only); 1 external calls (default).


##### `style_add`  (lines 1259–1277)

```
fn style_add(
    theme: DiffTheme,
    color_level: DiffColorLevel,
    diff_backgrounds: ResolvedDiffBackgrounds,
) -> Style
```

**Purpose**: Builds the content style for plain inserted text. It uses green foregrounds and/or resolved backgrounds depending on terminal theme and color depth.

**Data flow**: It receives theme, color level, and resolved backgrounds → avoids backgrounds for ANSI-16 → otherwise applies background and sometimes green foreground → returns a Style.

**Call relations**: The inner line renderer uses this for non-syntax inserted content, and style_sign_add reuses it for dark-theme plus signs.

*Call graph*: called by 3 (push_wrapped_diff_line_inner_with_theme_and_color_level, style_sign_add, ansi16_add_style_uses_foreground_only); 1 external calls (default).


##### `style_del`  (lines 1283–1301)

```
fn style_del(
    theme: DiffTheme,
    color_level: DiffColorLevel,
    diff_backgrounds: ResolvedDiffBackgrounds,
) -> Style
```

**Purpose**: Builds the content style for plain deleted text. It mirrors style_add with red delete coloring and delete backgrounds.

**Data flow**: It receives theme, color level, and resolved backgrounds → avoids backgrounds for ANSI-16 → otherwise applies background and sometimes red foreground → returns a Style.

**Call relations**: The inner line renderer uses this for non-syntax deleted content, and style_sign_del reuses it for dark-theme minus signs.

*Call graph*: called by 3 (push_wrapped_diff_line_inner_with_theme_and_color_level, style_sign_del, ansi16_del_style_uses_foreground_only); 1 external calls (default).


##### `style_gutter_dim`  (lines 1303–1305)

```
fn style_gutter_dim() -> Style
```

**Purpose**: Creates the dimmed style used for gutters in dark-theme or context cases. It makes line numbers less visually loud than code content.

**Data flow**: It creates a default style → adds the DIM modifier → returns that style.

**Call relations**: style_gutter_for calls this for its simple dim-gutter fallback.

*Call graph*: called by 1 (style_gutter_for); 1 external calls (default).


##### `tests::ansi16_add_style_uses_foreground_only`  (lines 1321–1329)

```
fn ansi16_add_style_uses_foreground_only()
```

**Purpose**: Verifies that inserted text in ANSI-16 mode uses only a green foreground and no background. This protects readability on low-color terminals.

**Data flow**: It builds an ANSI-16 add style → checks foreground and background fields → the test passes only if no background is present.

**Call relations**: This test exercises fallback_diff_backgrounds and style_add directly.

*Call graph*: calls 2 internal fn (fallback_diff_backgrounds, style_add); 1 external calls (assert_eq!).


##### `tests::ansi16_del_style_uses_foreground_only`  (lines 1332–1340)

```
fn ansi16_del_style_uses_foreground_only()
```

**Purpose**: Verifies that deleted text in ANSI-16 mode uses only a red foreground. It prevents saturated low-color backgrounds from returning accidentally.

**Data flow**: It builds an ANSI-16 delete style → checks that foreground is red and background is empty → reports failure if not.

**Call relations**: This test directly covers fallback_diff_backgrounds and style_del.

*Call graph*: calls 2 internal fn (fallback_diff_backgrounds, style_del); 1 external calls (assert_eq!).


##### `tests::ansi16_sign_styles_use_foreground_only`  (lines 1343–1359)

```
fn ansi16_sign_styles_use_foreground_only()
```

**Purpose**: Checks that plus and minus signs also avoid backgrounds in ANSI-16 mode. The signs should stay readable but not overpower the diff.

**Data flow**: It creates add and delete sign styles for ANSI-16 → inspects their foreground and background values → expects green/red foregrounds and no backgrounds.

**Call relations**: This test calls style_sign_add and style_sign_del with fallback ANSI-16 backgrounds.

*Call graph*: calls 3 internal fn (fallback_diff_backgrounds, style_sign_add, style_sign_del); 1 external calls (assert_eq!).


##### `tests::diff_summary_for_tests`  (lines 1360–1362)

```
fn diff_summary_for_tests(changes: &HashMap<PathBuf, FileChange>) -> Vec<RtLine<'static>>
```

**Purpose**: Small test helper that renders changes from the filesystem root with a fixed width. It avoids repeating setup in many snapshot tests.

**Data flow**: It receives a change map → calls create_diff_summary with cwd '/' and width 80 → returns rendered lines.

**Call relations**: Several snapshot tests call this helper before rendering lines into a fake terminal.

*Call graph*: calls 1 internal fn (create_diff_summary); 1 external calls (from).


##### `tests::snapshot_lines`  (lines 1364–1374)

```
fn snapshot_lines(name: &str, lines: Vec<RtLine<'static>>, width: u16, height: u16)
```

**Purpose**: Renders styled lines into a fake terminal and compares the result with an insta snapshot. This catches visual layout regressions.

**Data flow**: It receives a snapshot name, lines, width, and height → draws them into a test backend → records or compares the terminal snapshot.

**Call relations**: Most UI snapshot tests call this after building diff lines.

*Call graph*: 3 external calls (new, assert_snapshot!, new).


##### `tests::display_width`  (lines 1376–1380)

```
fn display_width(text: &str) -> usize
```

**Purpose**: Computes the terminal display width of plain text for tests. It treats tabs as four columns and accounts for wide Unicode characters.

**Data flow**: It receives text → sums each character's display width with tab handling → returns the total column count.

**Call relations**: line_display_width uses this to check whether wrapped rendered lines exceed their intended width.


##### `tests::line_display_width`  (lines 1382–1387)

```
fn line_display_width(line: &RtLine<'static>) -> usize
```

**Purpose**: Computes the visible width of a rendered ratatui line in tests. This helps prove wrapping works with styled spans.

**Data flow**: It receives a rendered line → measures each span's content with display_width → returns the combined width.

**Call relations**: Wrapping tests use this after calling the public line-render helper.


##### `tests::snapshot_lines_text`  (lines 1389–1404)

```
fn snapshot_lines_text(name: &str, lines: &[RtLine<'static>])
```

**Purpose**: Turns styled lines into plain text and snapshots the text layout. This makes indentation and wrapping easier to inspect than full terminal style snapshots.

**Data flow**: It receives lines → concatenates span contents per row, trims trailing spaces, joins rows with newlines → compares the plain text snapshot.

**Call relations**: Text-focused wrapping and line-number tests call this instead of snapshot_lines.

*Call graph*: 2 external calls (iter, assert_snapshot!).


##### `tests::diff_gallery_changes`  (lines 1406–1460)

```
fn diff_gallery_changes() -> HashMap<PathBuf, FileChange>
```

**Purpose**: Builds a representative set of file changes for visual snapshot tests. It includes updates, renames, additions, deletions, tabs, emoji, and wide characters.

**Data flow**: It creates original and modified strings → builds patches for some files → inserts multiple FileChange values into a map → returns the map.

**Call relations**: snapshot_diff_gallery calls this to feed broad diff examples into create_diff_summary.

*Call graph*: 3 external calls (new, from, create_patch).


##### `tests::snapshot_diff_gallery`  (lines 1462–1469)

```
fn snapshot_diff_gallery(name: &str, width: u16, height: u16)
```

**Purpose**: Renders the gallery diff set at a chosen terminal size and snapshots it. This checks the overall look of mixed diff content.

**Data flow**: It receives a snapshot name and terminal dimensions → builds gallery changes → renders a summary at that width → snapshots the fake terminal output.

**Call relations**: The three gallery-size tests call this with different widths and heights.

*Call graph*: calls 1 internal fn (create_diff_summary); 4 external calls (from, diff_gallery_changes, snapshot_lines, from).


##### `tests::display_path_prefers_cwd_without_git_repo`  (lines 1472–1489)

```
fn display_path_prefers_cwd_without_git_repo()
```

**Purpose**: Checks that paths inside the current working directory display relatively even when no Git repository is involved. This avoids noisy absolute paths.

**Data flow**: It builds a fake cwd and file path → calls display_path_for → expects the path relative to cwd.

**Call relations**: This directly protects display_path_for's first important absolute-path shortening rule.

*Call graph*: calls 1 internal fn (display_path_for); 3 external calls (from, assert_eq!, cfg!).


##### `tests::ui_snapshot_wrap_behavior_insert`  (lines 1492–1513)

```
fn ui_snapshot_wrap_behavior_insert()
```

**Purpose**: Snapshots how a long inserted line wraps. It ensures continuation rows align under the gutter instead of repeating the plus sign.

**Data flow**: It renders one long inserted line with current style context → sends the produced rows to snapshot_lines → compares the layout.

**Call relations**: This tests the public plain-text line render helper and the lower-level wrapping behavior behind it.

*Call graph*: calls 3 internal fn (current_diff_render_style_context, line_number_width, push_wrapped_diff_line_with_style_context); 1 external calls (snapshot_lines).


##### `tests::ui_snapshot_apply_update_block`  (lines 1516–1538)

```
fn ui_snapshot_apply_update_block()
```

**Purpose**: Snapshots a simple one-file update diff. It verifies the normal edited-file layout.

**Data flow**: It creates a small patch → renders it through the summary helper → snapshots the fake terminal output.

**Call relations**: This covers create_diff_summary through diff_summary_for_tests and the update branch of render_change.

*Call graph*: 5 external calls (new, from, create_patch, diff_summary_for_tests, snapshot_lines).


##### `tests::ui_snapshot_apply_update_with_rename_block`  (lines 1541–1563)

```
fn ui_snapshot_apply_update_with_rename_block()
```

**Purpose**: Snapshots an update diff that also represents a rename. It checks that the old and new names appear correctly.

**Data flow**: It creates a patch with a move target → renders the summary → snapshots the output.

**Call relations**: This exercises row move_path handling in collect_rows and render_changes_block.

*Call graph*: 5 external calls (new, from, create_patch, diff_summary_for_tests, snapshot_lines).


##### `tests::ui_snapshot_apply_multiple_files_block`  (lines 1566–1596)

```
fn ui_snapshot_apply_multiple_files_block()
```

**Purpose**: Snapshots a summary containing more than one file. It checks the combined header and per-file sections.

**Data flow**: It creates one update and one added file → renders the summary → snapshots the resulting terminal block.

**Call relations**: This exercises collect_rows sorting, multi-file header logic, and per-file rendering together.

*Call graph*: 5 external calls (new, from, create_patch, diff_summary_for_tests, snapshot_lines).


##### `tests::ui_snapshot_apply_add_block`  (lines 1599–1616)

```
fn ui_snapshot_apply_add_block()
```

**Purpose**: Snapshots the rendering of a newly added file. It verifies added-file headers and insert-line formatting.

**Data flow**: It creates one added file change → renders it through the test helper → snapshots the output.

**Call relations**: This covers the Add branch in render_change through the summary renderer.

*Call graph*: 4 external calls (new, from, diff_summary_for_tests, snapshot_lines).


##### `tests::ui_snapshot_apply_delete_block`  (lines 1619–1635)

```
fn ui_snapshot_apply_delete_block()
```

**Purpose**: Snapshots the rendering of a deleted file. It verifies delete-line formatting and removed-line counts.

**Data flow**: It creates one deleted file change → renders it through the test helper → snapshots the output.

**Call relations**: This covers the Delete branch in render_change through the summary renderer.

*Call graph*: 4 external calls (new, from, diff_summary_for_tests, snapshot_lines).


##### `tests::ui_snapshot_apply_update_block_wraps_long_lines`  (lines 1638–1662)

```
fn ui_snapshot_apply_update_block_wraps_long_lines()
```

**Purpose**: Checks that long changed lines inside update diffs wrap at the requested summary width. It guards against clipping or relying only on paragraph auto-wrap.

**Data flow**: It creates a patch with a very long modified line → renders with a narrow wrap width → snapshots the output in a wider fake terminal.

**Call relations**: This exercises render_change and the inner wrapping renderer through create_diff_summary.

*Call graph*: calls 1 internal fn (create_diff_summary); 4 external calls (new, from, create_patch, snapshot_lines).


##### `tests::ui_snapshot_apply_update_block_wraps_long_lines_text`  (lines 1665–1683)

```
fn ui_snapshot_apply_update_block_wraps_long_lines_text()
```

**Purpose**: Snapshots the plain-text layout of wrapped update lines. It focuses on sign placement and continuation indentation.

**Data flow**: It builds a patch with inserted and context lines that wrap → renders at a narrow width → snapshots only the textual layout.

**Call relations**: This uses create_diff_summary and snapshot_lines_text to check wrapping without style noise.

*Call graph*: calls 1 internal fn (create_diff_summary); 4 external calls (new, from, create_patch, snapshot_lines_text).


##### `tests::ui_snapshot_apply_update_block_line_numbers_three_digits_text`  (lines 1686–1710)

```
fn ui_snapshot_apply_update_block_line_numbers_three_digits_text()
```

**Purpose**: Checks alignment when line numbers reach three digits. It prevents gutters from shifting as numbers grow wider.

**Data flow**: It creates a 110-line file with one change near line 100 → renders a summary → snapshots the plain text.

**Call relations**: This indirectly tests line_number_width through the update rendering path.

*Call graph*: calls 1 internal fn (create_diff_summary); 4 external calls (new, from, create_patch, snapshot_lines_text).


##### `tests::ui_snapshot_apply_update_block_relativizes_path`  (lines 1713–1739)

```
fn ui_snapshot_apply_update_block_relativizes_path()
```

**Purpose**: Checks that absolute old and new paths are displayed relative to the current directory in an update with rename. This keeps headers readable.

**Data flow**: It builds absolute paths under the current directory → renders a rename diff → snapshots the resulting header and diff.

**Call relations**: This covers display_path_for as used by create_diff_summary.

*Call graph*: calls 1 internal fn (create_diff_summary); 4 external calls (new, create_patch, current_dir, snapshot_lines).


##### `tests::ui_snapshot_syntax_highlighted_insert_wraps`  (lines 1742–1773)

```
fn ui_snapshot_syntax_highlighted_insert_wraps()
```

**Purpose**: Verifies that a long syntax-highlighted inserted line wraps into multiple rows. It protects highlighting and wrapping from fighting each other.

**Data flow**: It highlights a long Rust line → renders it as an inserted diff line → asserts multiple rows exist → snapshots the styled output.

**Call relations**: This directly calls the syntax-aware line render helper with a current style context.

*Call graph*: calls 4 internal fn (current_diff_render_style_context, line_number_width, push_wrapped_diff_line_with_syntax_and_style_context, highlight_code_to_styled_spans); 2 external calls (assert!, snapshot_lines).


##### `tests::ui_snapshot_syntax_highlighted_insert_wraps_text`  (lines 1776–1794)

```
fn ui_snapshot_syntax_highlighted_insert_wraps_text()
```

**Purpose**: Snapshots the plain-text layout of a wrapped syntax-highlighted insert line. It checks the wrapping shape without depending on colors.

**Data flow**: It highlights a long Rust line → renders it through the syntax-aware helper → snapshots concatenated text rows.

**Call relations**: This complements the styled syntax wrapping snapshot.

*Call graph*: calls 4 internal fn (current_diff_render_style_context, line_number_width, push_wrapped_diff_line_with_syntax_and_style_context, highlight_code_to_styled_spans); 1 external calls (snapshot_lines_text).


##### `tests::ui_snapshot_diff_gallery_80x24`  (lines 1797–1799)

```
fn ui_snapshot_diff_gallery_80x24()
```

**Purpose**: Runs the mixed diff gallery at an 80-column terminal size. It catches regressions in the common narrow layout.

**Data flow**: It passes fixed dimensions to the gallery snapshot helper → the helper renders and snapshots the result.

**Call relations**: This is one of several size-specific callers of snapshot_diff_gallery.

*Call graph*: 1 external calls (snapshot_diff_gallery).


##### `tests::ui_snapshot_diff_gallery_94x35`  (lines 1802–1804)

```
fn ui_snapshot_diff_gallery_94x35()
```

**Purpose**: Runs the mixed diff gallery at a medium terminal size. It checks layout behavior with more horizontal room.

**Data flow**: It passes fixed dimensions to the gallery snapshot helper → the helper renders and snapshots the result.

**Call relations**: This reuses snapshot_diff_gallery with a different terminal width and height.

*Call graph*: 1 external calls (snapshot_diff_gallery).


##### `tests::ui_snapshot_diff_gallery_120x40`  (lines 1807–1813)

```
fn ui_snapshot_diff_gallery_120x40()
```

**Purpose**: Runs the mixed diff gallery at a wide terminal size. It verifies that wider layouts still look correct.

**Data flow**: It passes fixed dimensions to the gallery snapshot helper → the helper renders and snapshots the result.

**Call relations**: This is the wide-screen companion to the other gallery snapshot tests.

*Call graph*: 1 external calls (snapshot_diff_gallery).


##### `tests::ui_snapshot_ansi16_insert_delete_no_background`  (lines 1816–1846)

```
fn ui_snapshot_ansi16_insert_delete_no_background()
```

**Purpose**: Snapshots insert and delete lines rendered in ANSI-16 mode. It proves low-color output uses foreground colors only.

**Data flow**: It renders one insert and one delete line with explicit ANSI-16 style settings → snapshots the fake terminal output.

**Call relations**: This calls the inner renderer directly so the test controls theme and color level exactly.

*Call graph*: calls 3 internal fn (fallback_diff_backgrounds, line_number_width, push_wrapped_diff_line_inner_with_theme_and_color_level); 1 external calls (snapshot_lines).


##### `tests::truecolor_dark_theme_uses_configured_backgrounds`  (lines 1849–1880)

```
fn truecolor_dark_theme_uses_configured_backgrounds()
```

**Purpose**: Checks the configured truecolor dark-theme backgrounds and gutter style. It protects the built-in dark palette.

**Data flow**: It asks style helpers for dark truecolor add/delete styles and gutters → compares them with expected colors and dim gutter styling.

**Call relations**: This validates the constants used by fallback dark truecolor rendering.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::ansi256_dark_theme_uses_distinct_add_and_delete_backgrounds`  (lines 1883–1909)

```
fn ansi256_dark_theme_uses_distinct_add_and_delete_backgrounds()
```

**Purpose**: Checks that ANSI-256 dark-theme insert and delete backgrounds remain different. This prevents green and red diff lines from collapsing into the same color.

**Data flow**: It builds add and delete line background styles → compares them with expected palette indices → asserts they are not equal.

**Call relations**: This protects the 256-color fallback palette.

*Call graph*: 2 external calls (assert_eq!, assert_ne!).


##### `tests::theme_scope_backgrounds_override_truecolor_fallback_when_available`  (lines 1912–1929)

```
fn theme_scope_backgrounds_override_truecolor_fallback_when_available()
```

**Purpose**: Verifies that syntax-theme diff background colors override built-in truecolor fallbacks. This lets user themes control diff tints.

**Data flow**: It supplies explicit inserted and deleted RGB scope backgrounds → resolves backgrounds → checks rendered line styles use those exact colors.

**Call relations**: This directly tests resolve_diff_backgrounds_for.

*Call graph*: calls 1 internal fn (resolve_diff_backgrounds_for); 1 external calls (assert_eq!).


##### `tests::theme_scope_backgrounds_quantize_to_ansi256`  (lines 1932–1949)

```
fn theme_scope_backgrounds_quantize_to_ansi256()
```

**Purpose**: Verifies that theme RGB backgrounds are converted to ANSI-256 colors when needed. It also checks missing theme values still use fallbacks.

**Data flow**: It supplies an inserted RGB background and no deleted background → resolves in ANSI-256 mode → checks inserted quantization and deleted fallback.

**Call relations**: This covers resolve_diff_backgrounds_for and its color conversion path.

*Call graph*: calls 1 internal fn (resolve_diff_backgrounds_for); 1 external calls (assert_eq!).


##### `tests::ui_snapshot_theme_scope_background_resolution`  (lines 1952–1967)

```
fn ui_snapshot_theme_scope_background_resolution()
```

**Purpose**: Snapshots a simple theme-background resolution result. It gives a stable record of which backgrounds are chosen.

**Data flow**: It resolves custom inserted and fallback deleted backgrounds → formats the resulting style backgrounds → snapshots the text.

**Call relations**: This is a focused snapshot around resolve_diff_backgrounds_for.

*Call graph*: calls 1 internal fn (resolve_diff_backgrounds_for); 2 external calls (assert_snapshot!, format!).


##### `tests::ansi16_disables_line_and_gutter_backgrounds`  (lines 1970–2017)

```
fn ansi16_disables_line_and_gutter_backgrounds()
```

**Purpose**: Ensures ANSI-16 mode never uses line or gutter backgrounds, even if a theme provides RGB diff colors. This keeps low-color output legible.

**Data flow**: It checks fallback and theme-provided ANSI-16 styles → expects default line backgrounds and simple light gutter foregrounds.

**Call relations**: This protects the ANSI-16 branches in background resolution and gutter styling.

*Call graph*: calls 1 internal fn (resolve_diff_backgrounds_for); 1 external calls (assert_eq!).


##### `tests::light_truecolor_theme_uses_readable_gutter_and_line_backgrounds`  (lines 2020–2055)

```
fn light_truecolor_theme_uses_readable_gutter_and_line_backgrounds()
```

**Purpose**: Checks the light-theme truecolor palette, including stronger gutter backgrounds. It protects readability on light terminals.

**Data flow**: It asks for light truecolor line and gutter styles → compares them with expected RGB values.

**Call relations**: This validates the light-theme constants and style_gutter_for behavior.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::light_theme_wrapped_lines_keep_number_gutter_contrast`  (lines 2058–2089)

```
fn light_theme_wrapped_lines_keep_number_gutter_contrast()
```

**Purpose**: Verifies that wrapped continuation lines keep the same readable gutter style on light themes. Line numbers should not lose contrast after wrapping.

**Data flow**: It forces a narrow-width inserted line to wrap → inspects gutter spans and line backgrounds on multiple rows → expects consistent light-theme styles.

**Call relations**: This directly exercises the inner renderer with explicit light truecolor settings.

*Call graph*: calls 3 internal fn (fallback_diff_backgrounds, line_number_width, push_wrapped_diff_line_inner_with_theme_and_color_level); 2 external calls (assert!, assert_eq!).


##### `tests::windows_terminal_promotes_ansi16_to_truecolor_for_diffs`  (lines 2092–2102)

```
fn windows_terminal_promotes_ansi16_to_truecolor_for_diffs()
```

**Purpose**: Checks that identified Windows Terminal sessions reporting ANSI-16 are promoted to truecolor. This compensates for underreported terminal capability.

**Data flow**: It passes ANSI-16 and WindowsTerminal inputs to the policy function → expects TrueColor.

**Call relations**: This directly tests diff_color_level_for_terminal.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::wt_session_promotes_ansi16_to_truecolor_for_diffs`  (lines 2105–2115)

```
fn wt_session_promotes_ansi16_to_truecolor_for_diffs()
```

**Purpose**: Checks that the WT_SESSION environment signal can promote ANSI-16 output to truecolor. This catches Windows Terminal even when the parsed terminal name is unknown.

**Data flow**: It passes ANSI-16 with WT_SESSION present → expects TrueColor.

**Call relations**: This is another focused policy test for diff_color_level_for_terminal.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::non_windows_terminal_keeps_ansi16_diff_palette`  (lines 2118–2128)

```
fn non_windows_terminal_keeps_ansi16_diff_palette()
```

**Purpose**: Checks that non-Windows terminals reporting ANSI-16 stay in ANSI-16 mode. The renderer should not assume more color support than exists.

**Data flow**: It passes ANSI-16 and a non-Windows terminal name → expects Ansi16.

**Call relations**: This protects the conservative branch of diff_color_level_for_terminal.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::wt_session_promotes_unknown_color_level_to_truecolor`  (lines 2131–2141)

```
fn wt_session_promotes_unknown_color_level_to_truecolor()
```

**Purpose**: Checks that WT_SESSION can promote even an unknown reported color level to truecolor. This favors rich output in Windows Terminal unless overridden.

**Data flow**: It passes Unknown color support with WT_SESSION present → expects TrueColor.

**Call relations**: This verifies the early WT_SESSION promotion rule.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::non_wt_windows_terminal_keeps_unknown_color_level_conservative`  (lines 2144–2154)

```
fn non_wt_windows_terminal_keeps_unknown_color_level_conservative()
```

**Purpose**: Checks that a WindowsTerminal name alone does not promote an unknown color level. Unknown support remains conservative without WT_SESSION.

**Data flow**: It passes Unknown support, WindowsTerminal name, and no WT_SESSION → expects Ansi16.

**Call relations**: This protects a careful distinction inside diff_color_level_for_terminal.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::explicit_force_override_keeps_ansi16_on_windows_terminal`  (lines 2157–2167)

```
fn explicit_force_override_keeps_ansi16_on_windows_terminal()
```

**Purpose**: Checks that FORCE_COLOR prevents automatic truecolor promotion for ANSI-16 Windows Terminal cases. Explicit user intent wins.

**Data flow**: It passes ANSI-16 WindowsTerminal inputs with force override set → expects Ansi16.

**Call relations**: This tests the override branch in diff_color_level_for_terminal.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::explicit_force_override_keeps_ansi256_on_windows_terminal`  (lines 2170–2180)

```
fn explicit_force_override_keeps_ansi256_on_windows_terminal()
```

**Purpose**: Checks that FORCE_COLOR also prevents WT_SESSION from promoting ANSI-256 to truecolor. The reported level should be preserved.

**Data flow**: It passes ANSI-256 with WT_SESSION and force override → expects Ansi256.

**Call relations**: This completes coverage of the force-override color policy.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::add_diff_uses_path_extension_for_highlighting`  (lines 2183–2202)

```
fn add_diff_uses_path_extension_for_highlighting()
```

**Purpose**: Verifies that added files use their file extension for syntax highlighting. A Rust added file should contain RGB syntax-colored spans.

**Data flow**: It creates an added .rs file → renders the summary → scans spans for RGB foreground colors → expects at least one.

**Call relations**: This exercises detect_lang_for_path and render_change's Add highlighting path.

*Call graph*: calls 1 internal fn (create_diff_summary); 3 external calls (new, from, assert!).


##### `tests::cpp_module_extensions_use_cpp_highlighting`  (lines 2205–2236)

```
fn cpp_module_extensions_use_cpp_highlighting()
```

**Purpose**: Checks that several C++ module file extensions receive syntax highlighting. This protects extension normalization downstream of this file's detection.

**Data flow**: It loops over C++ module extensions → renders an added file for each → collects highlighted RGB token text → snapshots the results.

**Call relations**: This uses create_diff_summary-like rendering behavior through the add-file path and validates highlighting integration.

*Call graph*: 1 external calls (assert_debug_snapshot!).


##### `tests::unknown_extension_falls_back_without_syntax_highlighting`  (lines 2239–2254)

```
fn unknown_extension_falls_back_without_syntax_highlighting()
```

**Purpose**: Verifies that unknown file extensions render without syntax highlighting instead of failing. Plain diff colors should still appear.

**Data flow**: It creates an added file with an unknown extension → renders the summary → checks no span has an RGB syntax foreground.

**Call relations**: This covers the graceful fallback when detect_lang_for_path returns an extension that the highlighter cannot resolve.

*Call graph*: calls 1 internal fn (create_diff_summary); 3 external calls (new, from, assert!).


##### `tests::delete_diff_uses_path_extension_for_highlighting`  (lines 2257–2276)

```
fn delete_diff_uses_path_extension_for_highlighting()
```

**Purpose**: Verifies that deleted files also use their extension for syntax highlighting. A Python deletion should show syntax-colored spans.

**Data flow**: It creates a deleted .py file → renders the summary → scans for RGB syntax foreground colors → expects at least one.

**Call relations**: This exercises render_change's Delete highlighting path.

*Call graph*: calls 1 internal fn (create_diff_summary); 3 external calls (new, from, assert!).


##### `tests::detect_lang_for_common_paths`  (lines 2279–2288)

```
fn detect_lang_for_common_paths()
```

**Purpose**: Checks the simple extension detector on common and extensionless paths. It confirms that files without extensions are not assigned a language here.

**Data flow**: It passes paths with and without extensions → checks which return a value → expects extensions for standard files and none for extensionless names.

**Call relations**: This directly tests detect_lang_for_path.

*Call graph*: 1 external calls (assert!).


##### `tests::wrap_styled_spans_single_line`  (lines 2291–2296)

```
fn wrap_styled_spans_single_line()
```

**Purpose**: Checks that short styled text that fits the width stays in one chunk. This is the simplest wrapping case.

**Data flow**: It passes one short span and a wide limit → calls wrap_styled_spans → expects one output line.

**Call relations**: This directly tests the span-wrapping helper.

*Call graph*: calls 1 internal fn (wrap_styled_spans); 2 external calls (assert_eq!, vec!).


##### `tests::wrap_styled_spans_splits_long_content`  (lines 2299–2309)

```
fn wrap_styled_spans_splits_long_content()
```

**Purpose**: Checks that long content is split into multiple wrapped chunks. It prevents over-wide output.

**Data flow**: It passes a 100-character span with a 40-column limit → calls wrap_styled_spans → expects at least three chunks.

**Call relations**: This directly tests wrap_styled_spans on plain long text.

*Call graph*: calls 1 internal fn (wrap_styled_spans); 2 external calls (assert!, vec!).


##### `tests::wrap_styled_spans_flushes_at_span_boundary`  (lines 2312–2334)

```
fn wrap_styled_spans_flushes_at_span_boundary()
```

**Purpose**: Checks a boundary case where one styled span exactly fills a line and another span follows. The next span must start on a new line.

**Data flow**: It creates two styled spans with a width of four columns → wraps them → expects two lines and no over-wide first line.

**Call relations**: This protects wrap_styled_spans from a subtle exact-fit bug.

*Call graph*: calls 1 internal fn (wrap_styled_spans); 4 external calls (default, assert!, assert_eq!, vec!).


##### `tests::wrap_styled_spans_preserves_styles`  (lines 2337–2348)

```
fn wrap_styled_spans_preserves_styles()
```

**Purpose**: Verifies that wrapping does not lose span styles. Color and modifiers should survive across line breaks.

**Data flow**: It wraps a long green span → inspects every output span → expects the same green style everywhere.

**Call relations**: This directly protects the style-preservation promise of wrap_styled_spans.

*Call graph*: calls 1 internal fn (wrap_styled_spans); 3 external calls (default, assert_eq!, vec!).


##### `tests::wrap_styled_spans_tabs_have_visible_width`  (lines 2351–2361)

```
fn wrap_styled_spans_tabs_have_visible_width()
```

**Purpose**: Checks that tabs count as visible columns during wrapping. Treating tabs as zero width would let lines overflow.

**Data flow**: It wraps text containing a tab and five letters with an eight-column limit → expects wrapping to occur.

**Call relations**: This directly tests wrap_styled_spans tab handling.

*Call graph*: calls 1 internal fn (wrap_styled_spans); 2 external calls (assert!, vec!).


##### `tests::wrap_styled_spans_wraps_before_first_overflowing_char`  (lines 2364–2390)

```
fn wrap_styled_spans_wraps_before_first_overflowing_char()
```

**Purpose**: Checks that wrapping happens before the character that would overflow, including tabs and wide characters. This keeps every output line within the limit.

**Data flow**: It wraps text containing letters, a tab, and a wide character → compares produced line text and verifies each line width.

**Call relations**: This directly covers a tricky branch in wrap_styled_spans.

*Call graph*: calls 1 internal fn (wrap_styled_spans); 3 external calls (assert!, assert_eq!, vec!).


##### `tests::fallback_wrapping_uses_display_width_for_tabs_and_wide_chars`  (lines 2393–2411)

```
fn fallback_wrapping_uses_display_width_for_tabs_and_wide_chars()
```

**Purpose**: Verifies that the public plain-text diff-line renderer respects display width for tabs and wide Unicode characters. It checks the full line-rendering path, not just the helper.

**Data flow**: It renders an inserted line containing a tab, CJK character, and emoji at a narrow width → asserts wrapping occurred and no rendered row exceeds the width.

**Call relations**: This uses current_diff_render_style_context, line_number_width, and push_wrapped_diff_line_with_style_context.

*Call graph*: calls 3 internal fn (current_diff_render_style_context, line_number_width, push_wrapped_diff_line_with_style_context); 1 external calls (assert!).


##### `tests::large_update_diff_skips_highlighting`  (lines 2414–2465)

```
fn large_update_diff_skips_highlighting()
```

**Purpose**: Checks that very large update diffs skip syntax highlighting. This prevents rendering from becoming painfully slow on huge patches.

**Data flow**: It builds a patch over 10,000 lines → renders the summary → asserts output exists and no RGB syntax-highlighted spans appear.

**Call relations**: This covers render_change's large-diff guard through create_diff_summary.

*Call graph*: calls 1 internal fn (create_diff_summary); 5 external calls (new, from, assert!, create_patch, panic!).


##### `tests::rename_diff_uses_destination_extension_for_highlighting`  (lines 2468–2495)

```
fn rename_diff_uses_destination_extension_for_highlighting()
```

**Purpose**: Verifies that renamed files use the destination extension for syntax highlighting. A rename into .rs should highlight as Rust even if the old extension was unknown.

**Data flow**: It creates a patch from an unknown old extension to a .rs move path → renders the summary → expects RGB syntax-highlighted spans.

**Call relations**: This protects render_changes_block's choice of move_path for language detection.

*Call graph*: calls 1 internal fn (create_diff_summary); 4 external calls (new, from, assert!, create_patch).


##### `tests::update_diff_preserves_multiline_highlight_state_within_hunk`  (lines 2498–2533)

```
fn update_diff_preserves_multiline_highlight_state_within_hunk()
```

**Purpose**: Checks that update hunks are highlighted as a block, preserving syntax state across lines. This matters for things like multi-line strings.

**Data flow**: It creates a Rust patch with a multi-line string → computes the expected highlighter style for the second string line → renders the diff → compares the actual span style for that text.

**Call relations**: This verifies render_change's hunk-level highlighting strategy using create_diff_summary and the highlighter.

*Call graph*: calls 2 internal fn (create_diff_summary, highlight_code_to_styled_spans); 4 external calls (new, from, assert_eq!, create_patch).


### `tui/src/git_action_directives.rs`

`domain_logic` · `assistant message parsing before transcript display and Git action presentation`

Assistant messages can contain more than plain text. They may include small directive tags such as Git actions, which should not be shown directly to the user, or code-comment tags, which need to be displayed in a friendlier form. This file is the translator for those tags.

The main flow is like sorting mail. `parse_assistant_markdown` reads the assistant markdown line by line. For each line, it first checks whether the whole line is a code-comment directive. If so, it rewrites it into a readable bullet such as a title, file location, and comment body. If not, it looks for hidden Git directives inside the line. It removes those hidden tags from the visible text and records them as `GitActionDirective` values, such as stage, commit, create branch, push, or create pull request.

The file is careful about malformed input. If a directive is incomplete, it is not turned into an action. Git directives are still hidden from the visible text once recognized as directive-shaped text, which prevents broken tags from creating odd blank rows. Duplicate Git actions are also ignored, so the same instruction is not repeated. At the end, trailing empty lines are trimmed so the displayed assistant text looks clean.

#### Function details

##### `GitActionDirective::created_branch_cwd`  (lines 32–37)

```
fn created_branch_cwd(&self) -> Option<&str>
```

**Purpose**: This small helper answers one question: if this Git directive creates a branch, what working folder is it for? For all other Git actions, it returns nothing.

**Data flow**: It receives one Git action value. If that value is `CreateBranch`, it reads its `cwd` field and returns it as text borrowed from the action. If the action is stage, commit, push, or create pull request, it returns no value.

**Call relations**: This is used by `ParsedAssistantMarkdown::last_created_branch_cwd` when scanning parsed actions to find the most recent branch-creation instruction.


##### `ParsedAssistantMarkdown::last_created_branch_cwd`  (lines 47–52)

```
fn last_created_branch_cwd(&self) -> Option<&str>
```

**Purpose**: This finds the working folder for the last branch that the assistant asked to create. It is useful when later UI behavior needs to know which repository folder was most recently involved in branch creation.

**Data flow**: It reads the parsed list of Git actions from the markdown result. It walks backward through that list, asks each action whether it is a branch-creation action, and returns the first matching folder it finds. If no branch was created, it returns nothing.

**Call relations**: It relies on `GitActionDirective::created_branch_cwd` for the per-action check. The test `tests::last_created_branch_cwd_uses_the_last_matching_directive` verifies that it chooses the last matching directive, not the first.


##### `parse_assistant_markdown`  (lines 55–85)

```
fn parse_assistant_markdown(markdown: &str, cwd: &Path) -> ParsedAssistantMarkdown
```

**Purpose**: This is the main parser for assistant markdown. It produces clean markdown for display and a separate list of Git actions hidden inside the assistant message.

**Data flow**: It takes the raw markdown text and the current working folder path. It reads each line, rewrites valid code-comment directive lines into visible markdown, strips Git directive tags from normal lines, records valid Git actions, removes duplicates, trims trailing blank display lines, and returns a `ParsedAssistantMarkdown` containing the visible text plus the action list.

**Call relations**: This is the entry point other code uses, including `thread_to_transcript_cells` when turning a conversation thread into screen content. Internally it calls `rewrite_code_comment_line` first for whole-line code comments, then `strip_line_directives` for inline Git directives. The test functions call it directly to check the expected parsing behavior.

*Call graph*: calls 2 internal fn (rewrite_code_comment_line, strip_line_directives); called by 6 (hides_malformed_directives_without_materializing_rows, last_created_branch_cwd_uses_the_last_matching_directive, preserves_non_directive_and_malformed_code_comment_text, renders_code_comment_directives_as_markdown, strips_and_parses_git_action_directives, thread_to_transcript_cells); 2 external calls (new, new).


##### `rewrite_code_comment_line`  (lines 87–132)

```
fn rewrite_code_comment_line(line: &str, cwd: &Path) -> Option<String>
```

**Purpose**: This converts a special code-comment directive line into a normal markdown bullet that a person can read. It turns machine-style fields like title, body, file, and line range into a compact review comment.

**Data flow**: It receives one line of text plus the current working folder. It checks whether the line starts with one to three colons followed by `code-comment{...}`. If the required fields are present and non-empty, it parses the attributes, calculates the line range, optionally adds a priority prefix, shortens the file path relative to the working folder when possible, and returns a formatted markdown bullet. If the line is not a valid code-comment directive, it returns nothing.

**Call relations**: It is called by `parse_assistant_markdown` before Git directive stripping, because code-comment bodies may contain text that looks like Git directives but should remain part of the comment. It uses `parse_code_comment_attributes` to read fields, `directive_integer` to read numeric fields, and `title_has_priority` to avoid adding a duplicate priority label.

*Call graph*: calls 3 internal fn (directive_integer, parse_code_comment_attributes, title_has_priority); called by 1 (parse_assistant_markdown); 2 external calls (new, format!).


##### `strip_line_directives`  (lines 134–160)

```
fn strip_line_directives(line: &str) -> (String, Vec<GitActionDirective>)
```

**Purpose**: This removes hidden Git directive tags from one line of markdown and collects the real Git actions they describe. The user sees the cleaned line, while the app keeps the actions separately.

**Data flow**: It takes one line of text. It searches for `::git-` directive patterns, copies ordinary text into a visible output string, parses each complete directive body into an action when possible, and skips the directive text itself. It returns the cleaned visible line together with any actions found.

**Call relations**: It is called by `parse_assistant_markdown` for lines that were not rewritten as code comments. For each directive-shaped item, it calls `parse_git_action` to turn the directive name and attributes into a structured `GitActionDirective`.

*Call graph*: calls 1 internal fn (parse_git_action); called by 1 (parse_assistant_markdown); 2 external calls (new, new).


##### `directive_integer`  (lines 162–169)

```
fn directive_integer(attributes: &HashMap<String, String>, name: &str) -> Option<i64>
```

**Purpose**: This reads an integer attribute from a parsed attribute map. It is flexible enough to accept values like `P2` as well as `2`, which matters for priority fields.

**Data flow**: It receives a map of attribute names to text values and the name to look up. It finds that value, trims spaces, removes a leading `P` or `p` if present, and tries to parse the rest as a number. It returns the number if parsing works, otherwise nothing.

**Call relations**: It is used by `rewrite_code_comment_line` to interpret line numbers and priority values in code-comment directives.

*Call graph*: called by 1 (rewrite_code_comment_line).


##### `title_has_priority`  (lines 171–178)

```
fn title_has_priority(title: &str) -> bool
```

**Purpose**: This checks whether a comment title already starts with a priority label such as `[P1]`. It prevents the display text from getting a duplicate priority prefix.

**Data flow**: It takes a title string, ignores leading spaces, and inspects the first few bytes. If the title begins with `[P`, then a digit, then `]`, it returns true. Otherwise it returns false.

**Call relations**: It is called by `rewrite_code_comment_line` when deciding whether to add a priority prefix from the directive attributes.

*Call graph*: called by 1 (rewrite_code_comment_line); 1 external calls (matches!).


##### `parse_code_comment_attributes`  (lines 180–200)

```
fn parse_code_comment_attributes(input: &str) -> Option<HashMap<String, String>>
```

**Purpose**: This reads the attributes inside a code-comment directive. It supports quoted values with escaped quote characters, which allows comment bodies to contain richer text.

**Data flow**: It receives the raw text between the braces of a code-comment directive. It repeatedly reads `name=value` pairs, accepting either quoted values or unquoted values, and stores them in a map. If the syntax is incomplete or a name is empty, it returns nothing. Otherwise it returns the completed attribute map.

**Call relations**: It is called by `rewrite_code_comment_line` before that function can build the visible markdown comment. When a value starts with a quote, it hands the detailed quoted-string reading to `parse_quoted_value`.

*Call graph*: calls 1 internal fn (parse_quoted_value); called by 1 (rewrite_code_comment_line); 1 external calls (new).


##### `parse_git_action`  (lines 202–224)

```
fn parse_git_action(name: &str, attributes: &str) -> Option<GitActionDirective>
```

**Purpose**: This turns one hidden Git directive into a typed action the rest of the app can understand. It recognizes stage, commit, create branch, push, and create pull request directives.

**Data flow**: It receives a directive name and its raw attribute text. It parses the attributes, requires a working folder value, and then matches the directive name to the correct Git action shape. Some actions also require a branch name; create-pull-request may include a URL and a draft flag. If anything required is missing or the directive name is unknown, it returns nothing.

**Call relations**: It is called by `strip_line_directives` for each Git-looking directive found in a line. It depends on `parse_attributes` to read the simple attribute syntax used by Git directives.

*Call graph*: calls 1 internal fn (parse_attributes); called by 1 (strip_line_directives).


##### `parse_attributes`  (lines 226–247)

```
fn parse_attributes(input: &str) -> Option<std::collections::HashMap<String, String>>
```

**Purpose**: This reads simple `key=value` attributes used by Git directives. It is the basic text-to-map parser for those hidden action tags.

**Data flow**: It takes the raw text inside a Git directive’s braces. It scans one attribute at a time, reads the key before `=`, then reads either a quoted value or an unquoted value up to the next space. It returns a map of keys to values, or nothing if the syntax is invalid.

**Call relations**: It is called only by `parse_git_action`, which then interprets the resulting map as Git action fields like `cwd`, `branch`, `url`, and `isDraft`.

*Call graph*: called by 1 (parse_git_action); 1 external calls (new).


##### `parse_quoted_value`  (lines 249–267)

```
fn parse_quoted_value(input: &str) -> Option<(String, &str)>
```

**Purpose**: This reads a quoted string value for code-comment attributes, including escaped quote marks. It lets comment text contain `"` without ending the value too early.

**Data flow**: It receives the text after an opening quote. It walks character by character, building the value until it reaches an unescaped closing quote. If it sees `\"`, it adds a literal quote to the value. It returns the parsed value and the remaining text after the closing quote; if no closing quote appears, it returns nothing.

**Call relations**: It is called by `parse_code_comment_attributes` whenever a code-comment attribute value starts with a quote.

*Call graph*: called by 1 (parse_code_comment_attributes); 1 external calls (new).


##### `tests::strips_and_parses_git_action_directives`  (lines 275–297)

```
fn strips_and_parses_git_action_directives()
```

**Purpose**: This test checks that Git directives are removed from visible markdown and turned into structured actions. It also confirms duplicate-looking but different folder values are preserved as distinct actions.

**Data flow**: It feeds markdown containing normal text and several Git directives into `parse_assistant_markdown`. It then compares the visible markdown with the expected cleaned text and compares the parsed actions with the expected stage and push actions.

**Call relations**: This test exercises the main parser path through `parse_assistant_markdown`, including its use of `strip_line_directives` and `parse_git_action`.

*Call graph*: calls 1 internal fn (parse_assistant_markdown); 2 external calls (new, assert_eq!).


##### `tests::hides_malformed_directives_without_materializing_rows`  (lines 300–305)

```
fn hides_malformed_directives_without_materializing_rows()
```

**Purpose**: This test checks the behavior for an incomplete Git directive. The important point is that broken action tags should not become visible clutter or fake actions.

**Data flow**: It passes markdown containing a malformed push directive into `parse_assistant_markdown`. The result should show only the ordinary text and contain no parsed Git actions.

**Call relations**: This test calls `parse_assistant_markdown` to confirm that the line-cleaning and action-parsing behavior stays safe when a directive is missing required information.

*Call graph*: calls 1 internal fn (parse_assistant_markdown); 3 external calls (new, assert!, assert_eq!).


##### `tests::renders_code_comment_directives_as_markdown`  (lines 308–321)

```
fn renders_code_comment_directives_as_markdown()
```

**Purpose**: This test verifies that code-comment directives are converted into readable markdown rather than being shown as raw directive text. It also checks that Git-looking text inside a comment body is not accidentally treated as a Git action.

**Data flow**: It builds markdown containing two code-comment directives and sends it to `parse_assistant_markdown`. It snapshots the visible markdown output and checks that no Git actions were produced.

**Call relations**: This test mainly exercises `parse_assistant_markdown` through `rewrite_code_comment_line`, including quoted attribute parsing, priority formatting, file path shortening, and line-range cleanup.

*Call graph*: calls 1 internal fn (parse_assistant_markdown); 4 external calls (new, assert!, concat!, assert_snapshot!).


##### `tests::preserves_non_directive_and_malformed_code_comment_text`  (lines 324–329)

```
fn preserves_non_directive_and_malformed_code_comment_text()
```

**Purpose**: This test makes sure ordinary mentions of code-comment syntax, or malformed code-comment directives, are left alone. That prevents the parser from rewriting text it does not fully understand.

**Data flow**: It passes markdown with an inline code-comment-like phrase and an incomplete code-comment directive into `parse_assistant_markdown`. The output visible markdown is expected to be exactly the same as the input.

**Call relations**: This test checks the cautious side of `rewrite_code_comment_line` as used by `parse_assistant_markdown`: only valid whole-line code-comment directives are rewritten.

*Call graph*: calls 1 internal fn (parse_assistant_markdown); 2 external calls (new, assert_eq!).


##### `tests::last_created_branch_cwd_uses_the_last_matching_directive`  (lines 332–339)

```
fn last_created_branch_cwd_uses_the_last_matching_directive()
```

**Purpose**: This test confirms that when several branch-creation directives exist, the helper returns the most recent one. That matters when later behavior should follow the latest assistant instruction.

**Data flow**: It parses markdown containing two create-branch directives with a push directive between them. It then asks the parsed result for the last created branch folder and expects the folder from the second create-branch directive.

**Call relations**: This test calls `parse_assistant_markdown` and then exercises `ParsedAssistantMarkdown::last_created_branch_cwd`, which in turn uses `GitActionDirective::created_branch_cwd`.

*Call graph*: calls 1 internal fn (parse_assistant_markdown); 2 external calls (new, assert_eq!).


### `tui/src/bottom_pane/mentions_v2/render.rs`

`domain_logic` · `request handling`

This file is responsible for the visual side of the mentions picker: the small popup that appears when a user is searching for something to mention, such as a file, directory, plugin, skill, or tool. Without it, the search system might still find results, but the user would not get a readable list to choose from.

The code uses Ratatui, a terminal UI library, to write styled text into a screen buffer. Think of the buffer like a sheet of graph paper for the terminal: each function decides what text and styling should go into which cells.

The top-level function splits the popup into two parts: a result list and, when there is room, a one-line footer with hints. The list renderer decides which results are visible based on scrolling and the current selection, so the highlighted item stays in view. Each row is then built from smaller pieces: a primary label, optional secondary information such as a path or description, padding, and a short tag showing the kind of mention.

A few helper functions make file paths easier to read. For filesystem results, the file name is treated as the main text, while the folder path is shown as secondary, dimmer text. Matching characters can be bolded, and long rows are shortened with an ellipsis so they do not spill past the popup edge.

#### Function details

##### `render_popup`  (lines 23–68)

```
fn render_popup(
    area: Rect,
    buf: &mut Buffer,
    rows: &[SearchResult],
    state: &ScrollState,
    empty_message: &str,
    search_mode: SearchMode,
)
```

**Purpose**: Draws the whole mention-search popup. It lays out the results area and, if there is enough height, reserves a bottom line for user hints.

**Data flow**: It receives a screen rectangle, a writable terminal buffer, search result rows, scroll and selection state, an empty-results message, and the current search mode. It splits the rectangle into a list area and optional footer area, indents the list slightly, draws the rows, and then draws the footer hint when space allows. It does not return a value; its output is the changed buffer.

**Call relations**: This is the entry point for this file’s drawing work. It is called by render_ref when the mentions UI needs to be painted, then it hands the result list to render_rows and the footer line to render_footer. It also uses tlbr to describe the small inset that keeps the list text away from the popup edge.

*Call graph*: calls 3 internal fn (render_footer, render_rows, tlbr); called by 1 (render_ref).


##### `render_rows`  (lines 70–126)

```
fn render_rows(
    area: Rect,
    buf: &mut Buffer,
    rows: &[SearchResult],
    state: &ScrollState,
    empty_message: &str,
)
```

**Purpose**: Draws the visible result rows inside the popup list area. It also handles the empty state, showing a simple italic message when there are no results.

**Data flow**: It receives the list rectangle, terminal buffer, rows, scroll state, and empty message. If there is no vertical space, it stops. If there are no rows, it writes the empty message. Otherwise, it calculates how many rows fit, adjusts the starting row so the selected result is visible, computes a shared width for the main label column, builds each visible line, and writes each line into the buffer.

**Call relations**: render_popup calls this after deciding where the list should go. For every visible search result, render_rows calls build_line to turn that result into styled text that can be rendered on one terminal row.

*Call graph*: calls 1 internal fn (build_line); called by 1 (render_popup); 4 external calls (from, is_empty, iter, len).


##### `build_line`  (lines 128–161)

```
fn build_line(
    row: &SearchResult,
    selected: bool,
    width: usize,
    primary_column_width: usize,
) -> Line<'static>
```

**Purpose**: Creates one styled display line for a single search result. It combines the result text, spacing, and the type tag at the far right.

**Data flow**: It receives one search result, whether it is selected, the available row width, and the width of the primary text column. It chooses bold styling for selected rows, builds the main content, shortens it with an ellipsis if needed, pads the remaining space, appends the mention-type tag, and returns a Ratatui Line ready to draw.

**Call relations**: render_rows calls this for each visible result. build_line relies on content_line for the main human-readable text and on truncate_line_with_ellipsis_if_overflow to keep the row within the popup width.

*Call graph*: calls 2 internal fn (content_line, truncate_line_with_ellipsis_if_overflow); called by 1 (render_rows); 3 external calls (from, default, new).


##### `content_line`  (lines 163–180)

```
fn content_line(
    row: &SearchResult,
    base_style: Style,
    dim_style: Style,
    primary_column_width: usize,
) -> Line<'static>
```

**Purpose**: Builds the main text portion of a result row, before the type tag is added. It aligns the primary text and optional secondary text so rows are easier to scan.

**Data flow**: It receives a search result, normal styling, dim styling, and the target width for the primary column. It creates spans for the primary label, checks whether there is secondary information, inserts enough spaces to align the secondary column, appends the secondary spans, and returns a single styled line.

**Call relations**: build_line calls this when assembling a full row. content_line delegates the first column to primary_spans, asks secondary_line whether extra information should be shown, and uses primary_text_width to calculate column padding.

*Call graph*: calls 3 internal fn (primary_spans, primary_text_width, secondary_line); called by 1 (build_line); 2 external calls (from, new).


##### `primary_spans`  (lines 182–213)

```
fn primary_spans(row: &SearchResult, base_style: Style) -> Vec<Span<'static>>
```

**Purpose**: Creates the styled primary label for a search result. For files, this usually means showing just the file name; for other result types, it styles the display name according to what kind of item it is.

**Data flow**: It receives a search result and a base style. It first checks whether the row has a file name that should be separated from its path. If so, it returns that file name, colored cyan for file mentions. Otherwise, it styles the display name based on mention type, and if match positions are available, it bolds the matching characters. The result is a list of styled text spans.

**Call relations**: content_line calls this to build the row’s first and most important visual piece. It uses file_name to decide whether filesystem-style display rules apply.

*Call graph*: calls 1 internal fn (file_name); called by 1 (content_line); 5 external calls (dim, fg, magenta, with_capacity, vec!).


##### `secondary_line`  (lines 215–237)

```
fn secondary_line(
    row: &SearchResult,
    base_style: Style,
    dim_style: Style,
) -> Option<Line<'static>>
```

**Purpose**: Creates optional supporting text for a result row, such as a folder path or description. This gives users extra context without making it the main thing they read.

**Data flow**: It receives a search result plus normal and dim styles. If the row represents a filesystem item with a separable file name, it builds path spans and may append the description. If it is not a filesystem-style row, it returns the description alone when one exists and is not empty. If there is no useful secondary text, it returns nothing.

**Call relations**: content_line calls this after building the primary label. secondary_line uses file_name to decide which layout path to take, and path_spans to create the dimmed folder-path portion for file-like results.

*Call graph*: calls 2 internal fn (file_name, path_spans); called by 1 (content_line); 1 external calls (from).


##### `path_spans`  (lines 239–271)

```
fn path_spans(row: &SearchResult, base_style: Style) -> Vec<Span<'static>>
```

**Purpose**: Builds the styled folder-path part of a filesystem result. It keeps the path visually quieter than the file name while still showing where the file lives.

**Data flow**: It receives a search result and base style. It finds where the file name begins inside the display name, then creates dimmed spans for the path before that point. If the file is in the current folder, it shows "./". If match positions are known, matching path characters are bolded. The output is a list of styled spans.

**Call relations**: secondary_line calls this when a row has a separate file name and path. path_spans relies on file_name_start to know which part of the display name is the path.

*Call graph*: calls 1 internal fn (file_name_start); called by 1 (secondary_line); 2 external calls (dim, with_capacity).


##### `primary_text_width`  (lines 273–277)

```
fn primary_text_width(row: &SearchResult) -> usize
```

**Purpose**: Measures how wide the main label of a row is in characters. This is used to line up secondary text across multiple rows.

**Data flow**: It receives a search result. If the row has a separate file name, it counts the characters in that file name; otherwise, it counts the characters in the full display name. It returns that character count as a width.

**Call relations**: render_rows uses this across visible rows to find the widest primary label, and content_line uses it for the current row to calculate padding. It calls file_name so filesystem rows are measured by their visible main label rather than their full path.

*Call graph*: calls 1 internal fn (file_name); called by 1 (content_line).


##### `file_name`  (lines 279–295)

```
fn file_name(row: &SearchResult) -> Option<&str>
```

**Purpose**: Extracts the file name portion from a display name when the row is a filesystem mention. This lets the UI show the file name as the main label and the folder path as supporting text.

**Data flow**: It receives a search result and asks file_name_start where the file name begins. If there is no file-name split for this kind of row, it returns nothing. If the name starts at the beginning, it returns the whole display name. Otherwise, it converts the character position into a byte position safely and returns the substring from there to the end.

**Call relations**: primary_spans, primary_text_width, and secondary_line call this whenever they need to know whether a result should be treated like a file path. It depends on file_name_start for the actual decision about where the split belongs.

*Call graph*: calls 1 internal fn (file_name_start); called by 3 (primary_spans, primary_text_width, secondary_line).


##### `file_name_start`  (lines 297–306)

```
fn file_name_start(row: &SearchResult) -> usize
```

**Purpose**: Finds the character position where the file name begins inside a displayed path. It also marks non-filesystem-style rows as having no usable file-name split.

**Data flow**: It receives a search result. If the row is a file selection and its mention type is filesystem-related, it searches for the last forward slash or backslash and returns the character count just after it; if there is no slash, it returns zero. For other file or tool selections that should not be split this way, it returns a special no-split value.

**Call relations**: file_name and path_spans call this as the shared rule for separating path from file name. This keeps the row-building functions consistent about which results get file-path formatting.

*Call graph*: called by 2 (file_name, path_spans).


### `tui/src/bottom_pane/request_user_input/layout.rs`

`domain_logic` · `rendering`

This file is the layout brain for the request-user-input overlay. In a terminal app, the screen can be tall, short, wide, or narrow, and the overlay still has to stay readable. This code turns one available rectangle of screen space into smaller rectangles: one for progress, one for the question, one for selectable options, and one for notes. Think of it like packing items into a small suitcase: the most important things go in first, and less important spacing or extra room gets reduced when space is tight.

The main decision is whether the question has options. If there are options, the layout protects at least a little room for them, may shorten the wrapped question text, and decides whether notes are visible. If notes are hidden, it tries to leave room for progress and footer hints by shrinking the options list before giving up those extras. If notes are visible, it gives space to the footer, a small separator, and then the notes area.

If there are no options, the question comes first. When space is too small, the question is truncated to fit and everything else disappears. With enough space, notes, footer lines, and the progress line are added in that order. The final step converts these calculated heights into actual terminal rectangles, stacked from top to bottom.

#### Function details

##### `RequestUserInputOverlay::layout_sections`  (lines 19–60)

```
fn layout_sections(&self, area: Rect) -> LayoutSections
```

**Purpose**: This is the main entry point for laying out the overlay. Given the available screen area, it decides which layout path to use, then returns all the screen sections needed for drawing.

**Data flow**: It starts with one terminal rectangle and reads the overlay state, such as whether options exist, whether notes should be shown, how tall the footer wants to be, and how the question wraps at the current width. It chooses the options or no-options layout calculation, then turns the resulting heights into concrete rectangles. The output is a LayoutSections value containing the progress, question, options, and notes areas, plus the wrapped question lines and footer height.

**Call relations**: This function sits above the rest of the file. It calls RequestUserInputOverlay::layout_with_options when choices are present, RequestUserInputOverlay::layout_without_options when they are not, and then RequestUserInputOverlay::build_layout_areas to convert the plan into drawable screen regions.

*Call graph*: calls 3 internal fn (build_layout_areas, layout_with_options, layout_without_options).


##### `RequestUserInputOverlay::layout_with_options`  (lines 63–95)

```
fn layout_with_options(
        &self,
        args: OptionsLayoutArgs,
        question_lines: &mut Vec<String>,
    ) -> LayoutPlan
```

**Purpose**: This prepares the layout when the user has a list of choices to pick from. Its main job is to make sure the options list gets at least some space, even if that means shortening the displayed question.

**Data flow**: It receives the available height and width, the current question height, preferred notes and footer sizes, and whether notes should be visible. It checks how much room can be used for the question while still leaving at least one row for options. If the question is too tall, it truncates the stored question lines. It then passes the adjusted numbers, along with preferred and full option-list heights, into the normal options layout calculation and returns that plan.

**Call relations**: RequestUserInputOverlay::layout_sections calls this whenever options exist. This function does the first round of protection for the options area, then hands the detailed space-sharing work to RequestUserInputOverlay::layout_with_options_normal.

*Call graph*: calls 1 internal fn (layout_with_options_normal); called by 1 (layout_sections).


##### `RequestUserInputOverlay::layout_with_options_normal`  (lines 99–196)

```
fn layout_with_options_normal(
        &self,
        args: OptionsNormalArgs,
        options: OptionsHeights,
    ) -> LayoutPlan
```

**Purpose**: This does the detailed space budgeting for a question that has selectable options. It decides how much height goes to options, progress, footer hints, spacing, and notes.

**Data flow**: It receives the available height, adjusted question height, notes preference, footer preference, whether notes are visible, and the preferred and full heights for the options list. It first gives options a reasonable height within the remaining space. Then it tries to reserve room for a progress line, footer text, and useful blank spacer rows. If notes are hidden, it may shrink options to protect the progress and footer, then gives any leftover room back to the options list up to its full height. If notes are visible, it gives space to the footer, a spacer, and the notes area, with any leftover height added to notes. The result is a LayoutPlan containing only heights, not final screen coordinates.

**Call relations**: This function is called by RequestUserInputOverlay::layout_with_options after the question has been trimmed if needed. It is the final decision-maker for the options case and returns a plan that later gets converted into rectangles by RequestUserInputOverlay::build_layout_areas through the top-level layout flow.

*Call graph*: called by 1 (layout_with_options).


##### `RequestUserInputOverlay::layout_without_options`  (lines 203–222)

```
fn layout_without_options(
        &self,
        available_height: u16,
        question_height: u16,
        notes_pref_height: u16,
        footer_pref: u16,
        question_lines: &mut Vec<String
```

**Purpose**: This chooses the layout strategy when the overlay is only asking a question and does not show choices. It separates the emergency small-screen case from the normal roomy case.

**Data flow**: It receives the available height, question height, preferred notes height, footer height, and the mutable list of wrapped question lines. It checks whether the question alone is taller than the available space. If so, it uses the tight layout path, which cuts the question down. Otherwise, it uses the normal path, which can include notes, footer, and progress. It returns a LayoutPlan describing the chosen heights.

**Call relations**: RequestUserInputOverlay::layout_sections calls this when there are no selectable options. This function then dispatches to RequestUserInputOverlay::layout_without_options_tight or RequestUserInputOverlay::layout_without_options_normal depending on whether the screen is too short.

*Call graph*: calls 2 internal fn (layout_without_options_normal, layout_without_options_tight); called by 1 (layout_sections).


##### `RequestUserInputOverlay::layout_without_options_tight`  (lines 225–244)

```
fn layout_without_options_tight(
        &self,
        available_height: u16,
        question_height: u16,
        question_lines: &mut Vec<String>,
    ) -> LayoutPlan
```

**Purpose**: This is the fallback for very little vertical space when there are no options. It keeps only as much of the question as can fit and removes the other overlay parts.

**Data flow**: It receives the available height, the original question height, and the wrapped question lines. It limits the question height to the available height and truncates the question lines to match. It returns a plan where the question uses the available space and progress, options, notes, spacers, and footer all get zero height.

**Call relations**: RequestUserInputOverlay::layout_without_options calls this when the question alone is too tall for the available area. It does not call further helpers; it creates the compact plan directly so the top-level layout can still build valid rectangles.

*Call graph*: called by 1 (layout_without_options).


##### `RequestUserInputOverlay::layout_without_options_normal`  (lines 247–279)

```
fn layout_without_options_normal(
        &self,
        available_height: u16,
        question_height: u16,
        notes_pref_height: u16,
        footer_pref: u16,
    ) -> LayoutPlan
```

**Purpose**: This lays out a no-options question when there is enough room to show more than just the question. It adds notes, footer text, and progress in a clear priority order.

**Data flow**: It receives the available height, question height, preferred notes height, and preferred footer height. It reserves the question first, then gives remaining rows to notes, then footer lines, then a one-line progress area if there is still space. Any leftover space after that is added back to the notes area. It returns a LayoutPlan with the final heights.

**Call relations**: RequestUserInputOverlay::layout_without_options calls this when the full question fits. The plan it returns goes back through RequestUserInputOverlay::layout_sections, which then asks RequestUserInputOverlay::build_layout_areas to turn the heights into real drawing areas.

*Call graph*: called by 1 (layout_without_options).


##### `RequestUserInputOverlay::build_layout_areas`  (lines 282–326)

```
fn build_layout_areas(
        &self,
        area: Rect,
        heights: LayoutPlan,
    ) -> (
        Rect, // progress_area
        Rect, // question_area
        Rect, // options_area
        Re
```

**Purpose**: This converts the height plan into actual terminal rectangles that the renderer can draw into. It stacks the regions from top to bottom inside the available area.

**Data flow**: It receives the original screen rectangle and a LayoutPlan containing heights for progress, question, spacers, options, and notes. Starting at the top y-coordinate, it creates a progress rectangle, moves the cursor down, creates the question rectangle, skips any spacer, creates the options rectangle, skips another spacer, and finally creates the notes rectangle. It returns those four rectangles; footer lines are not returned as a rectangle here.

**Call relations**: RequestUserInputOverlay::layout_sections calls this after one of the layout calculators has produced a plan. It is the bridge between abstract budgeting, such as 'the question gets 3 rows,' and concrete drawing positions, such as 'draw the question starting at this row.'

*Call graph*: called by 1 (layout_sections).


### `tui/src/bottom_pane/unified_exec_footer.rs`

`domain_logic` · `main loop / UI rendering`

This file is a small user-interface piece for the bottom pane of the terminal app. Its job is to tell the user, in one compact line, that one or more background terminal processes are still running and how to inspect or stop them. Without it, different parts of the interface might invent slightly different wording, pluralization, or truncation rules, which would make the UI feel inconsistent.

The main type, `UnifiedExecFooter`, stores a list of process names. It does not show the names directly; it only uses the list to know whether anything is running and how many sessions there are. From that, it creates a message like “1 background terminal running” or “123 background terminals running,” followed by hints for `/ps` and `/stop`.

When the message is drawn as a footer, the file adds a little indentation, dims the text visually, and cuts it to fit the available width. That cutting is important in a terminal interface because long text cannot spill outside its allotted rectangle. Think of it like writing a note on a sticky label: if the label is too narrow, the note must be shortened cleanly rather than wrapping messily.

The file also includes tests that check the footer’s height and saved visual snapshots for one and many running sessions.

#### Function details

##### `UnifiedExecFooter::new`  (lines 22–26)

```
fn new() -> Self
```

**Purpose**: Creates an empty footer with no background processes recorded. This is used when the bottom pane first needs a footer object but there may not be anything to show yet.

**Data flow**: It takes no project data as input. It creates a fresh empty list of process names and returns a `UnifiedExecFooter` that will render nothing until processes are added.

**Call relations**: This is the starting point for the footer’s life. The app’s construction path calls it when building the UI state, and the tests call it to make a clean footer before checking height and rendering behavior.

*Call graph*: called by 4 (new, desired_height_empty, render_many_sessions, render_more_sessions); 1 external calls (new).


##### `UnifiedExecFooter::set_processes`  (lines 28–34)

```
fn set_processes(&mut self, processes: Vec<String>) -> bool
```

**Purpose**: Replaces the stored list of background processes and reports whether anything actually changed. This lets the rest of the UI avoid unnecessary redraw work when the process list is the same as before.

**Data flow**: It receives a new list of process names. It compares that list with the footer’s current list; if they match, it leaves the footer unchanged and returns `false`. If they differ, it stores the new list and returns `true`.

**Call relations**: This is called when the wider bottom-pane state is updated through `set_unified_exec_processes`. That caller feeds in the latest known background sessions, and this function tells it whether the footer’s visible state may need to be refreshed.

*Call graph*: called by 1 (set_unified_exec_processes).


##### `UnifiedExecFooter::is_empty`  (lines 36–38)

```
fn is_empty(&self) -> bool
```

**Purpose**: Answers whether there are no background processes to report. Callers use this to decide whether the footer should take up screen space at all.

**Data flow**: It reads the stored process list and checks whether the list has zero entries. It returns `true` for no processes and `false` when at least one background process is known.

**Call relations**: The bottom pane asks this through `as_renderable_with_composer_right_reserve` while deciding what parts of the interface should be rendered. If the footer is empty, the UI can skip reserving room for it.

*Call graph*: called by 1 (as_renderable_with_composer_right_reserve).


##### `UnifiedExecFooter::summary_text`  (lines 45–55)

```
fn summary_text(&self) -> Option<String>
```

**Purpose**: Builds the reusable message that tells the user how many background terminals are running and which commands can inspect or stop them. It deliberately leaves out layout details, such as indentation, so different UI locations can frame it in their own way.

**Data flow**: It reads the stored process list. If the list is empty, it returns `None`, meaning there is no message to show. If the list has entries, it counts them, chooses the singular or plural wording, and returns the finished summary string.

**Call relations**: This is the shared wording source. `render_lines` uses it when drawing the dedicated footer row, and `sync_status_inline_message` uses the same text when the message is folded into the status row instead.

*Call graph*: called by 2 (sync_status_inline_message, render_lines); 1 external calls (format!).


##### `UnifiedExecFooter::render_lines`  (lines 57–67)

```
fn render_lines(&self, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Turns the summary message into terminal-renderable text lines that fit within a given width. It is the bridge between the plain message and the actual on-screen footer.

**Data flow**: It receives the available width. If the width is too small or there is no summary message, it returns an empty list. Otherwise it adds leading spaces, trims the text to the allowed display width using `take_prefix_by_width`, dims the visual style, and returns a one-line list ready for rendering.

**Call relations**: Both rendering and height calculation rely on this function, so the footer measures itself and draws itself from the same source. It calls `summary_text` for the message and hands the finished line list back to `render` or `desired_height`.

*Call graph*: calls 2 internal fn (summary_text, take_prefix_by_width); called by 2 (desired_height, render); 3 external calls (new, format!, vec!).


##### `UnifiedExecFooter::render`  (lines 71–77)

```
fn render(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Draws the footer into the terminal screen area assigned to it. This is the method the UI rendering system uses when it is time to paint the component.

**Data flow**: It receives a rectangular screen area and a mutable terminal buffer, which is the in-memory canvas for the next frame. If the area is empty, it does nothing. Otherwise it asks `render_lines` for the text that fits the area width, wraps those lines in a paragraph widget, and writes them into the buffer.

**Call relations**: This is part of the `Renderable` interface, so the wider UI can treat this footer like other drawable pieces. When called during a render pass, it delegates the wording and trimming work to `render_lines` before handing the result to the terminal UI library’s paragraph renderer.

*Call graph*: calls 1 internal fn (render_lines); 2 external calls (new, is_empty).


##### `UnifiedExecFooter::desired_height`  (lines 79–81)

```
fn desired_height(&self, width: u16) -> u16
```

**Purpose**: Reports how many terminal rows the footer wants for a given width. This helps the layout code decide whether to reserve a row for the footer.

**Data flow**: It receives the available width, asks `render_lines` what would be shown at that width, counts the resulting lines, and returns that count as a row height.

**Call relations**: The layout system calls this through the `Renderable` interface before drawing. Because it uses `render_lines`, its answer stays in sync with what `render` will actually paint.

*Call graph*: calls 1 internal fn (render_lines).


##### `tests::desired_height_empty`  (lines 91–94)

```
fn desired_height_empty()
```

**Purpose**: Checks that a newly created footer with no processes asks for zero rows. This protects the UI from wasting screen space on an empty message.

**Data flow**: It creates a fresh footer, asks for its desired height at a normal width, and compares the answer with zero. The test passes only if the empty footer stays invisible in layout terms.

**Call relations**: This test covers the empty-state path that starts with `UnifiedExecFooter::new`. It supports callers that rely on `desired_height` to decide whether the footer should appear.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `tests::render_more_sessions`  (lines 97–105)

```
fn render_more_sessions()
```

**Purpose**: Checks the rendered appearance for a footer with one running background session. The saved snapshot makes sure the visible text and styling do not change by accident.

**Data flow**: It creates a footer, gives it one process, creates a buffer sized from the footer’s requested height, renders into that buffer, and compares the debug view of the buffer with a stored snapshot.

**Call relations**: This test exercises the normal visible-footer path. It begins with `UnifiedExecFooter::new`, uses a terminal buffer as the drawing target, and verifies the final rendered output with a snapshot assertion.

*Call graph*: calls 1 internal fn (new); 4 external calls (empty, new, assert_snapshot!, vec!).


##### `tests::render_many_sessions`  (lines 108–116)

```
fn render_many_sessions()
```

**Purpose**: Checks the rendered appearance when many background sessions are running. This protects the plural wording and count display for large numbers.

**Data flow**: It creates a footer, fills it with many generated process names, creates an appropriately sized buffer, renders the footer, and compares the buffer output with a stored snapshot.

**Call relations**: This test follows the same rendering route as the one-session test, but with a large process count. It helps ensure `summary_text`, `render_lines`, and the final render still produce a compact, stable message.

*Call graph*: calls 1 internal fn (new); 3 external calls (empty, new, assert_snapshot!).


### `tui/src/status_indicator_widget.rs`

`domain_logic` · `main loop while an agent task is running`

When the agent is busy, the user needs quick reassurance: something is happening, how long it has been running, and how to stop it. This file builds that single status area. Think of it like the “loading…” strip at the bottom of an app, but with a timer and a clear escape hatch.

The main type, `StatusIndicatorWidget`, stores the text to show, optional detail lines, an optional inline message, the interrupt key binding, and timer state. It can pause and resume its timer so the displayed elapsed time reflects only active work. When rendered, it builds one main line: an activity indicator if motion is enabled, the header text such as “Working”, the elapsed time, and optionally “esc to interrupt”. If there is extra space below, it also wraps the detail text onto a few indented lines.

The file is careful about small terminal widths. Long header lines are shortened with an ellipsis, and long details are wrapped and capped at a maximum number of lines. If details still overflow, the last visible line gets an ellipsis. It also supports reduced motion by hiding animation pieces when animations are disabled. The included tests check formatting, truncation, wrapping, remapped interrupt keys, and timer pause/resume behavior.

#### Function details

##### `fmt_elapsed_compact`  (lines 65–78)

```
fn fmt_elapsed_compact(elapsed_secs: u64) -> String
```

**Purpose**: Turns a number of elapsed seconds into a short, human-readable time label for the status row. It keeps short times compact, but expands to minutes and hours when needed.

**Data flow**: It receives a count of seconds. It chooses seconds-only, minutes-plus-seconds, or hours-plus-minutes-plus-seconds formatting. It returns text such as `59s`, `1m 00s`, or `2h 03m 09s`.

**Call relations**: The render path calls this just before drawing the status line, so the user sees elapsed time in a stable, readable format instead of a raw number.

*Call graph*: called by 1 (render); 1 external calls (format!).


##### `StatusIndicatorWidget::new`  (lines 81–101)

```
fn new(
        app_event_tx: AppEventSender,
        frame_requester: FrameRequester,
        animations_enabled: bool,
    ) -> Self
```

**Purpose**: Creates a fresh status indicator with sensible defaults: header text `Working`, an escape-key interrupt hint, no details, and a running timer. This is what other parts of the TUI use when a task starts or when tests need a widget to inspect.

**Data flow**: It receives an app event sender, a frame requester, and a flag saying whether animations are enabled. It stores those, sets default display text and interrupt behavior, records the current time as the timer start, and returns the ready-to-render widget.

**Call relations**: Higher-level task code calls this when it needs a status indicator, and the tests call it to build controlled examples. It relies on the key-hint helper to make the default Escape binding and on the clock to start timing immediately.

*Call graph*: calls 1 internal fn (plain); called by 10 (ensure_status_indicator, set_task_running, details_args_can_disable_capitalization_and_limit_lines, details_overflow_adds_ellipsis, renders_remapped_interrupt_hint, renders_truncated, renders_with_working_header, renders_without_spinner_when_animations_disabled, renders_wrapped_details_panama_two_lines, timer_pauses_when_requested); 2 external calls (now, from).


##### `StatusIndicatorWidget::interrupt`  (lines 103–106)

```
fn interrupt(&self)
```

**Purpose**: Asks the application to interrupt the current work and restore the prompt if nothing new has appeared. This is the action behind the visible interrupt hint.

**Data flow**: It reads the widget’s stored application event sender. It sends an interrupt request through that sender and does not return any separate value.

**Call relations**: This method is the bridge from the status row’s user-facing “interrupt” affordance to the rest of the app. When something decides the interrupt action should fire, this hands the request to the app event system.

*Call graph*: calls 1 internal fn (interrupt_and_restore_prompt_if_no_output).


##### `StatusIndicatorWidget::update_header`  (lines 109–111)

```
fn update_header(&mut self, header: String)
```

**Purpose**: Changes the main status label shown at the start of the row. Callers use it to replace generic text like `Working` with a more specific short phrase.

**Data flow**: It receives a new string. It stores that string as the widget’s header, so later renders use the new label.

**Call relations**: Task-state code can call this whenever the visible high-level activity changes. The render method later reads the stored header and draws it, with shimmer animation if motion is enabled.


##### `StatusIndicatorWidget::update_details`  (lines 114–130)

```
fn update_details(
        &mut self,
        details: Option<String>,
        capitalization: StatusDetailsCapitalization,
        max_lines: usize,
    )
```

**Purpose**: Sets the optional longer detail text that appears below the main status line. It also decides whether to capitalize the first letter and how many wrapped lines may be shown.

**Data flow**: It receives optional detail text, a capitalization choice, and a maximum line count. Empty detail text is discarded; non-empty text is trimmed at the start, optionally capitalized, and stored. The maximum line count is stored too, with a minimum of one.

**Call relations**: Callers use this when they have helpful context, such as what background command is running. Later, `wrapped_details_lines` turns the stored text into terminal-width lines, and `render` draws those lines if space is available.


##### `StatusIndicatorWidget::update_inline_message`  (lines 137–141)

```
fn update_inline_message(&mut self, message: Option<String>)
```

**Purpose**: Sets a short optional message shown on the same line after the elapsed time and interrupt hint. This is for brief context that should stay compact.

**Data flow**: It receives optional message text. It trims surrounding whitespace, drops the message if it becomes empty, and stores the cleaned text for future renders.

**Call relations**: Callers can add small status context without taking extra vertical space. The render method appends this message after the core timer and interrupt text, so the most important controls stay in a predictable position.


##### `StatusIndicatorWidget::header`  (lines 144–146)

```
fn header(&self) -> &str
```

**Purpose**: Returns the current header text for tests. It is only compiled in test builds.

**Data flow**: It reads the widget’s stored header string and returns it as borrowed text without changing anything.

**Call relations**: Tests use this as a small inspection window into the widget’s state after updates. Normal application code does not use it.


##### `StatusIndicatorWidget::details`  (lines 149–151)

```
fn details(&self) -> Option<&str>
```

**Purpose**: Returns the current detail text for tests, if any. It is only compiled in test builds.

**Data flow**: It reads the optional stored details and returns either borrowed detail text or no value. It does not modify the widget.

**Call relations**: Tests call this to confirm that detail text was trimmed, preserved, capitalized, or removed as expected. Rendering code reads the same stored data through `wrapped_details_lines` instead.


##### `StatusIndicatorWidget::set_interrupt_hint_visible`  (lines 153–155)

```
fn set_interrupt_hint_visible(&mut self, visible: bool)
```

**Purpose**: Shows or hides the interrupt instruction in the status line. This is useful when interrupting should not be advertised for a particular state.

**Data flow**: It receives a boolean value. It stores that value, and future renders either include the key hint or show only elapsed time.

**Call relations**: Callers adjust this before rendering based on whether interruption is appropriate. The render method checks the stored flag when building the main status line.


##### `StatusIndicatorWidget::set_interrupt_binding`  (lines 157–159)

```
fn set_interrupt_binding(&mut self, binding: Option<KeyBinding>)
```

**Purpose**: Changes which key is displayed as the interrupt shortcut, or removes the binding entirely. This lets the status row match user-configured or context-specific controls.

**Data flow**: It receives an optional key binding. It stores that binding, and future renders use it when the interrupt hint is visible.

**Call relations**: Configuration or input-mapping code can call this before the widget is drawn. The render method later turns the stored binding into visible key-hint text.


##### `StatusIndicatorWidget::pause_timer`  (lines 161–163)

```
fn pause_timer(&mut self)
```

**Purpose**: Pauses the elapsed-time counter using the current clock time. This keeps inactive waiting periods from being counted as active running time.

**Data flow**: It reads the current time and passes it to `pause_timer_at`. The widget’s timer state may change from running to paused.

**Call relations**: Application code calls this simple version during real runtime. It delegates to `pause_timer_at`, which contains the actual calculation and is easier to test with a fixed time.

*Call graph*: calls 1 internal fn (pause_timer_at); 1 external calls (now).


##### `StatusIndicatorWidget::resume_timer`  (lines 165–167)

```
fn resume_timer(&mut self)
```

**Purpose**: Resumes the elapsed-time counter using the current clock time. It restarts active timing after a pause.

**Data flow**: It reads the current time and passes it to `resume_timer_at`. The widget may switch from paused to running and request a redraw.

**Call relations**: Application code calls this during normal operation. The timestamp-specific `resume_timer_at` does the real state update, while this method supplies the real current time.

*Call graph*: calls 1 internal fn (resume_timer_at); 1 external calls (now).


##### `StatusIndicatorWidget::pause_timer_at`  (lines 169–175)

```
fn pause_timer_at(&mut self, now: Instant)
```

**Purpose**: Pauses the timer at a supplied moment. Supplying the time directly makes timer behavior predictable in tests.

**Data flow**: It receives a timestamp. If the timer is already paused, it does nothing. Otherwise, it adds the time since the last resume to the accumulated running time and marks the timer paused.

**Call relations**: `pause_timer` calls this with the current time, and tests call it indirectly to verify exact timing. It uses safe duration calculation so unusual clock ordering does not create negative time.

*Call graph*: called by 1 (pause_timer); 1 external calls (saturating_duration_since).


##### `StatusIndicatorWidget::resume_timer_at`  (lines 177–184)

```
fn resume_timer_at(&mut self, now: Instant)
```

**Purpose**: Restarts the timer at a supplied moment after it has been paused. It also asks the UI to redraw so the status row starts updating again.

**Data flow**: It receives a timestamp. If the timer is not paused, it does nothing. If it is paused, it records the new resume time, marks the timer running, and schedules a frame.

**Call relations**: `resume_timer` calls this with the current time. It hands off to the frame requester because a resumed animated or timed widget needs another screen update.

*Call graph*: calls 1 internal fn (schedule_frame); called by 1 (resume_timer).


##### `StatusIndicatorWidget::elapsed_duration_at`  (lines 186–192)

```
fn elapsed_duration_at(&self, now: Instant) -> Duration
```

**Purpose**: Calculates the total active running time at a chosen moment. It respects pauses, so paused time is not counted.

**Data flow**: It receives a timestamp. It starts with the already accumulated running time, then adds time since the last resume only if the timer is currently running. It returns a duration.

**Call relations**: Both `render` and `elapsed_seconds_at` call this. It is the central timing calculation used for display and for public elapsed-second queries.

*Call graph*: called by 2 (elapsed_seconds_at, render); 1 external calls (saturating_duration_since).


##### `StatusIndicatorWidget::elapsed_seconds_at`  (lines 194–196)

```
fn elapsed_seconds_at(&self, now: Instant) -> u64
```

**Purpose**: Returns the active elapsed time as whole seconds at a chosen moment. This is a simpler form of the duration calculation.

**Data flow**: It receives a timestamp, asks `elapsed_duration_at` for the full duration, converts that duration to seconds, and returns the number.

**Call relations**: `elapsed_seconds` calls this with the real current time, and tests use the same timing path to check pause and resume behavior.

*Call graph*: calls 1 internal fn (elapsed_duration_at); called by 1 (elapsed_seconds).


##### `StatusIndicatorWidget::elapsed_seconds`  (lines 198–200)

```
fn elapsed_seconds(&self) -> u64
```

**Purpose**: Returns the active elapsed time as whole seconds using the current clock. This gives other code a quick way to ask how long the task has been running.

**Data flow**: It reads the current time, passes it to `elapsed_seconds_at`, and returns the resulting second count.

**Call relations**: This is the public convenience method for elapsed time. It depends on the timestamp-based helper so runtime code and testable timing logic stay consistent.

*Call graph*: calls 1 internal fn (elapsed_seconds_at); 1 external calls (now).


##### `StatusIndicatorWidget::wrapped_details_lines`  (lines 203–232)

```
fn wrapped_details_lines(&self, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Turns the stored detail text into terminal-ready lines that fit the available width. It adds an indented tree-like prefix and trims extra lines with an ellipsis.

**Data flow**: It receives the available width. If there are no details or no width, it returns an empty list. Otherwise, it wraps the text with an initial `└`-style prefix, uses matching indentation for later lines, limits the number of lines, and marks overflow with `…` on the final visible line.

**Call relations**: `desired_height` uses this to know how tall the widget wants to be, and `render` uses it to draw the detail lines. It relies on the shared word-wrapping helper so long text fits narrow terminals cleanly.

*Call graph*: calls 2 internal fn (new, word_wrap_lines); called by 2 (desired_height, render); 6 external calls (from, from, width, new, format!, from).


##### `StatusIndicatorWidget::desired_height`  (lines 236–238)

```
fn desired_height(&self, width: u16) -> u16
```

**Purpose**: Reports how many terminal rows the widget would like for a given width. It always needs one row for the main status line, plus any wrapped detail rows.

**Data flow**: It receives a width. It asks `wrapped_details_lines` how many detail rows would be produced, adds one for the header row, and returns that height as a terminal row count.

**Call relations**: The surrounding layout system calls this before drawing so it can reserve enough vertical space. It shares wrapping logic with `render`, which helps measurement match what will actually be drawn.

*Call graph*: calls 1 internal fn (wrapped_details_lines); 1 external calls (try_from).


##### `StatusIndicatorWidget::render`  (lines 240–299)

```
fn render(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Draws the status indicator into the terminal buffer. This is where the timer, spinner, header, interrupt hint, inline message, truncation, and detail lines become visible text.

**Data flow**: It receives a rectangular screen area and a mutable terminal buffer. If the area is empty, it stops. Otherwise, it may schedule another animation frame, calculates elapsed time, builds styled text spans, truncates the main line to fit the width, adds wrapped details if height allows, and writes everything into the buffer.

**Call relations**: The TUI rendering system calls this whenever the screen is drawn. It pulls together helpers for elapsed-time formatting, motion mode, activity indicators, shimmer text, line truncation, and detail wrapping, then hands the final text to Ratatui’s paragraph renderer.

*Call graph*: calls 8 internal fn (truncate_line_with_ellipsis_if_overflow, from_animations_enabled, activity_indicator, shimmer_text, elapsed_duration_at, wrapped_details_lines, fmt_elapsed_compact, schedule_frame_in); 11 external calls (from_millis, now, from, new, is_empty, from, new, with_capacity, format!, from (+1 more)).


##### `tests::fmt_elapsed_compact_formats_seconds_minutes_hours`  (lines 316–327)

```
fn fmt_elapsed_compact_formats_seconds_minutes_hours()
```

**Purpose**: Checks that elapsed seconds are displayed correctly across seconds, minutes, and hours. This protects the small but visible timer format from accidental changes.

**Data flow**: It feeds fixed second counts into `fmt_elapsed_compact`. It compares each returned string with the expected label.

**Call relations**: This test directly exercises the formatter used by `render`, so failures would point to the user-visible elapsed-time text.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::renders_with_working_header`  (lines 330–345)

```
fn renders_with_working_header()
```

**Purpose**: Verifies the default widget rendering with the normal `Working` header. It uses a fake terminal so the output can be snapshot-tested.

**Data flow**: It creates a test app-event channel, builds a widget, draws it into an 80-column by 2-row test terminal, and compares the resulting buffer to a stored snapshot.

**Call relations**: This test follows the same render path as real UI drawing, starting from `StatusIndicatorWidget::new` and ending in `render`.

*Call graph*: calls 3 internal fn (new, new, test_dummy); 3 external calls (new, assert_snapshot!, new).


##### `tests::renders_truncated`  (lines 348–363)

```
fn renders_truncated()
```

**Purpose**: Checks that the main status line is shortened safely when the terminal is narrow. This prevents long status text from overflowing the UI area.

**Data flow**: It creates a default widget, draws it into a 20-column test terminal, and compares the output with a snapshot that includes truncation behavior.

**Call relations**: This test exercises `render` under tight width constraints, including the truncation helper used for the first line.

*Call graph*: calls 3 internal fn (new, new, test_dummy); 3 external calls (new, assert_snapshot!, new).


##### `tests::renders_wrapped_details_panama_two_lines`  (lines 366–392)

```
fn renders_wrapped_details_panama_two_lines()
```

**Purpose**: Checks that detail text wraps onto two lines in a predictable way. It also verifies rendering without the interrupt hint in a fixed-size terminal.

**Data flow**: It creates a widget with animations off, sets detail text, hides the interrupt hint, freezes the timer, draws into a narrow test terminal, and snapshot-compares the result.

**Call relations**: This test drives `update_details`, `set_interrupt_hint_visible`, `wrapped_details_lines`, and `render` together to confirm the detail area behaves as intended.

*Call graph*: calls 3 internal fn (new, new, test_dummy); 3 external calls (new, assert_snapshot!, new).


##### `tests::renders_without_spinner_when_animations_disabled`  (lines 395–416)

```
fn renders_without_spinner_when_animations_disabled()
```

**Purpose**: Confirms that disabling animations removes the spinner but keeps the useful status text. This matters for reduced-motion settings and stable displays.

**Data flow**: It creates a widget with animations disabled, freezes elapsed time at zero, draws one terminal row, reads the rendered text, and checks that it starts with `Working (0s • esc to interrupt)`.

**Call relations**: This test exercises the reduced-motion branch in `render`, where the activity indicator is omitted but the timer and interrupt hint remain.

*Call graph*: calls 3 internal fn (new, new, test_dummy); 3 external calls (new, assert!, new).


##### `tests::renders_remapped_interrupt_hint`  (lines 419–436)

```
fn renders_remapped_interrupt_hint()
```

**Purpose**: Checks that the interrupt key shown in the UI can be changed. This protects support for remapped controls.

**Data flow**: It creates a widget, changes the interrupt binding to F12, freezes the timer, draws into a test terminal, and compares the buffer with a snapshot.

**Call relations**: This test uses `set_interrupt_binding` before calling `render`, confirming that the stored key binding is what users see.

*Call graph*: calls 4 internal fn (new, plain, new, test_dummy); 4 external calls (F, new, assert_snapshot!, new).


##### `tests::timer_pauses_when_requested`  (lines 439–461)

```
fn timer_pauses_when_requested()
```

**Purpose**: Verifies that the timer stops increasing while paused and starts increasing again after resume. This protects the meaning of the elapsed time shown to users.

**Data flow**: It creates a widget, sets a fixed baseline time, checks elapsed seconds after five seconds, pauses at that moment, confirms later time does not increase while paused, resumes, and confirms only resumed time is added.

**Call relations**: This test exercises the timer calculation path behind `pause_timer_at`, `resume_timer_at`, and `elapsed_seconds_at`, which is also used by rendering.

*Call graph*: calls 3 internal fn (new, new, test_dummy); 3 external calls (from_secs, now, assert_eq!).


##### `tests::details_overflow_adds_ellipsis`  (lines 464–485)

```
fn details_overflow_adds_ellipsis()
```

**Purpose**: Checks that overly long detail text is capped and marked with an ellipsis. This tells users there is more text without letting the status area grow too tall.

**Data flow**: It creates a widget, sets long detail text, asks for wrapped details at a very small width, and verifies the number of lines and the ellipsis on the final visible line.

**Call relations**: This test focuses on `wrapped_details_lines`, the helper used by both layout measurement and rendering.

*Call graph*: calls 3 internal fn (new, new, test_dummy); 2 external calls (assert!, assert_eq!).


##### `tests::details_args_can_disable_capitalization_and_limit_lines`  (lines 488–516)

```
fn details_args_can_disable_capitalization_and_limit_lines()
```

**Purpose**: Checks that callers can preserve detail text exactly and limit details to one line. This is important for command-like text where capitalization should not be changed.

**Data flow**: It creates a widget, stores a command-style detail string with capitalization preservation and a one-line limit, confirms the stored text is unchanged, then checks that wrapping produces one ellipsized line.

**Call relations**: This test combines `update_details`, the test-only `details` accessor, and `wrapped_details_lines` to verify both stored state and rendered-line preparation.

*Call graph*: calls 3 internal fn (new, new, test_dummy); 2 external calls (assert!, assert_eq!).


### `tui/src/status/card.rs`

`domain_logic` · `when /status is created, rendered, refreshed, or written to transcript`

When a user runs `/status`, they need a quick answer to questions like: which model am I using, what folder can Codex touch, am I logged in, how many tokens have I used, and are there rate limits? This file is the “status report printer” for that screen. It gathers raw information from the app configuration and current session, simplifies it into human-friendly labels, and renders it as terminal lines with alignment, wrapping, borders, and optional hyperlinks.

The central piece is `StatusHistoryCell`, a history item that knows how to draw itself. Its constructor prepares the facts: model name and details, current directory, permission summary, account display, token usage, context-window usage, session IDs, and rate-limit state. Later, `display_lines` lays those facts out in a neat card. It also adapts to narrow terminals by wrapping or shortening text so the card stays usable.

Rate limits can arrive or refresh after the card is created, so the file uses shared locked state (`Arc<RwLock<...>>`, meaning shared data protected by a read/write lock) and returns a `StatusHistoryHandle`. That handle lets other code update the card’s rate-limit data safely. The file also sanitizes provider URLs before showing them, so secrets such as usernames, passwords, query strings, and fragments are not displayed.

#### Function details

##### `StatusHistoryHandle::finish_rate_limit_refresh`  (lines 85–102)

```
fn finish_rate_limit_refresh(
        &self,
        rate_limits: &[RateLimitSnapshotDisplay],
        now: DateTime<Local>,
    )
```

**Purpose**: Updates an already-created status card after fresh rate-limit information arrives. This lets the UI first show that limits are being refreshed, then replace that placeholder with real data.

**Data flow**: It receives a list of rate-limit snapshots and the current time. It turns one snapshot into normal rate-limit display data, or several snapshots into a combined display. Then it writes that result into the shared rate-limit state and marks the refresh as finished.

**Call relations**: This is used after the status card has been created through the handle returned with it. It relies on the same rate-limit composing helpers used during card creation, so refreshed data is formatted the same way as initial data.

*Call graph*: calls 2 internal fn (compose_rate_limit_data, compose_rate_limit_data_many); 2 external calls (first, len).


##### `new_status_output`  (lines 126–158)

```
fn new_status_output(
    config: &Config,
    account_display: Option<&StatusAccountDisplay>,
    token_info: Option<&TokenUsageInfo>,
    total_usage: &TokenUsage,
    session_id: &Option<ThreadId>,
```

**Purpose**: Creates a test-only status output for the common case of zero or one rate-limit snapshot. It is a convenience wrapper so tests do not have to build the full rate-limit list themselves.

**Data flow**: It takes configuration, account details, token counts, session information, model information, and an optional single rate-limit snapshot. It converts that optional snapshot into a slice-like list and passes everything on. The result is a composite history cell ready to render in tests.

**Call relations**: This function is only compiled for tests. It calls `new_status_output_with_rate_limits`, which handles the more general case.

*Call graph*: calls 1 internal fn (new_status_output_with_rate_limits).


##### `new_status_output_with_rate_limits`  (lines 162–198)

```
fn new_status_output_with_rate_limits(
    config: &Config,
    account_display: Option<&StatusAccountDisplay>,
    token_info: Option<&TokenUsageInfo>,
    total_usage: &TokenUsage,
    session_id: &
```

**Purpose**: Creates a test-only status output when tests need to provide multiple rate-limit snapshots. It hides the handle and returns only the rendered history cell.

**Data flow**: It receives all status ingredients plus a list of rate-limit snapshots and a flag saying whether a refresh is in progress. It supplies test defaults for runtime provider URL, remote connection, and agent summary, then asks the full builder to create the card. It returns just the composite card.

**Call relations**: It is called by `new_status_output` in simpler tests. It delegates the real work to `new_status_output_with_rate_limits_handle`.

*Call graph*: calls 1 internal fn (new_status_output_with_rate_limits_handle); called by 1 (new_status_output).


##### `new_status_output_with_rate_limits_handle`  (lines 201–245)

```
fn new_status_output_with_rate_limits_handle(
    config: &Config,
    runtime_model_provider_base_url: Option<&str>,
    remote_connection: Option<&RemoteConnectionStatus>,
    account_display: Optio
```

**Purpose**: Builds the full `/status` history entry and also returns a handle that can update its rate-limit section later. The visible history entry includes both the `/status` command line and the status card below it.

**Data flow**: It receives the app state and display inputs. It creates a small plain history cell containing the literal `/status` command, builds a `StatusHistoryCell` from the supplied data, and combines both into one composite history cell. It also returns the card’s update handle.

**Call relations**: Test helpers call this through wrappers, and production code can use it when it needs both the card and the refresh handle. It calls `StatusHistoryCell::new` to prepare the actual card contents.

*Call graph*: calls 3 internal fn (new, new, new); called by 1 (new_status_output_with_rate_limits); 1 external calls (vec!).


##### `StatusHistoryCell::new`  (lines 249–374)

```
fn new(
        config: &Config,
        runtime_model_provider_base_url: Option<&str>,
        remote_connection: Option<&RemoteConnectionStatus>,
        account_display: Option<&StatusAccountDispla
```

**Purpose**: Collects all raw status facts and turns them into the stored data needed to draw the status card. It is where configuration details become readable labels.

**Data flow**: It reads the configuration, account display, token information, total usage, session IDs, rate limits, model name, collaboration mode, remote/provider information, and agent summary. It summarizes permissions, formats model details, decides whether to show a ChatGPT usage link, converts token usage into totals and context-window data, and creates shared state for rate limits and agent text. It outputs a `StatusHistoryCell` plus a `StatusHistoryHandle` that points at the same rate-limit state.

**Call relations**: This is called by `new_status_output_with_rate_limits_handle` when a status card is being created. It uses helper functions in this file for permission labels and provider formatting, and it uses rate-limit helpers from the status rate-limit module.

*Call graph*: calls 12 internal fn (from, blended_total, non_cached_input, format_model_provider, status_approval_label, status_permission_summary, status_permissions_label, workspace_root_suffix, compose_account_display, compose_model_display (+2 more)); called by 1 (new_status_output_with_rate_limits_handle); 7 external calls (new, new, effective_workspace_roots, default, first, len, vec!).


##### `StatusHistoryCell::token_usage_spans`  (lines 376–392)

```
fn token_usage_spans(&self) -> Vec<Span<'static>>
```

**Purpose**: Formats total, input, and output token usage as styled pieces of terminal text. Tokens are chunks of text processed by the model, so this gives users a compact usage summary.

**Data flow**: It reads the card’s stored total, input, and output token counts. It formats each count compactly, then arranges them into spans such as total followed by dimmed input-plus-output details. It returns those spans for rendering.

**Call relations**: `display_lines` calls this when it is ready to add the token usage row. It hands back styled text fragments that the field formatter can place next to the `Token usage` label.

*Call graph*: calls 1 internal fn (format_tokens_compact); called by 1 (display_lines); 1 external calls (vec!).


##### `StatusHistoryCell::context_window_spans`  (lines 394–408)

```
fn context_window_spans(&self) -> Option<Vec<Span<'static>>>
```

**Purpose**: Formats how much of the model’s current context window remains. The context window is the amount of conversation text the model can keep in view at once.

**Data flow**: It checks whether context-window data exists. If not, it returns nothing. If it does, it reads the percent remaining, used tokens, and total window size, formats the numbers compactly, and returns styled spans such as `72% left (35k used / 128k)`.

**Call relations**: `display_lines` calls this after token usage. If it returns spans, the status card gets a `Context window` row.

*Call graph*: calls 1 internal fn (format_tokens_compact); called by 1 (display_lines); 1 external calls (vec!).


##### `StatusHistoryCell::rate_limit_lines`  (lines 410–459)

```
fn rate_limit_lines(
        &self,
        state: &StatusRateLimitState,
        available_inner_width: usize,
        formatter: &FieldFormatter,
    ) -> Vec<Line<'static>>
```

**Purpose**: Chooses what the rate-limit section of the status card should say. It covers available limits, stale limits, unavailable limits, and data that has not arrived yet.

**Data flow**: It receives the current shared rate-limit state, the available terminal width, and a field formatter. It looks at the state: real rows are passed to the row formatter, stale rows also get a warning, unavailable data gets a polite unavailable message, and missing data gets a waiting or not-yet-available message. It returns ready-to-render lines.

**Call relations**: `display_lines` calls this near the end of building the card. For detailed rows it delegates to `rate_limit_row_lines` so each limit can be wrapped and formatted consistently.

*Call graph*: calls 2 internal fn (rate_limit_row_lines, line); called by 1 (display_lines); 1 external calls (vec!).


##### `StatusHistoryCell::rate_limit_row_lines`  (lines 461–549)

```
fn rate_limit_row_lines(
        &self,
        rows: &[StatusRateLimitRow],
        available_inner_width: usize,
        formatter: &FieldFormatter,
    ) -> Vec<Line<'static>>
```

**Purpose**: Turns individual rate-limit rows into terminal lines. It keeps the most useful information visible even on narrow terminals.

**Data flow**: It receives prepared rate-limit rows, the available width, and a field formatter. For percentage-window limits, it computes the remaining percentage, builds a progress bar and summary, adds reset time when present, and wraps long reset or detail text instead of cutting it mid-word. For plain text limits, it formats the label and value directly. It returns the resulting lines.

**Call relations**: `rate_limit_lines` calls this whenever rate-limit rows are available or stale. It uses formatting helpers from the rate-limit and status formatting modules to make its output match the rest of the card.

*Call graph*: calls 4 internal fn (full_spans, value_width, line_display_width, format_status_limit_summary); called by 1 (rate_limit_lines); 8 external calls (from, from, with_capacity, format!, new, wrap, len, vec!).


##### `StatusHistoryCell::collect_rate_limit_labels`  (lines 551–576)

```
fn collect_rate_limit_labels(
        &self,
        state: &StatusRateLimitState,
        seen: &mut BTreeSet<String>,
        labels: &mut Vec<String>,
    )
```

**Purpose**: Adds the labels needed by the rate-limit section to the card’s label list before rendering. This matters because the card aligns values by first knowing all labels it may display.

**Data flow**: It reads the current rate-limit state and receives a set of labels already seen plus a label list being built. Depending on the rate-limit state, it adds row labels, `Limits`, or `Warning` while avoiding duplicates. It changes the label list and seen set in place.

**Call relations**: `display_lines` calls this while preparing the formatter. The collected labels help `FieldFormatter` line up every row in the status card.

*Call graph*: calls 1 internal fn (push_label); called by 1 (display_lines).


##### `status_permission_summary`  (lines 579–601)

```
fn status_permission_summary(
    permission_profile: &PermissionProfile,
    cwd: &AbsolutePathBuf,
    workspace_roots: &[AbsolutePathBuf],
) -> String
```

**Purpose**: Turns a detailed permission profile into a shorter permission phrase suitable for the status card. It keeps important distinctions, especially whether network access is enabled.

**Data flow**: It receives the active permission profile, current working directory, and workspace roots. It asks a shared summarizer for the detailed permission summary, then simplifies common phrases like read-only and workspace-write into shorter labels. It returns the simplified string.

**Call relations**: `StatusHistoryCell::new` calls this while preparing the `Permissions` row. Its result is later fed into `status_permissions_label` for the final user-facing label.

*Call graph*: called by 1 (new); 1 external calls (summarize_permission_profile).


##### `workspace_root_suffix`  (lines 603–617)

```
fn workspace_root_suffix(
    workspace_roots: &[AbsolutePathBuf],
    cwd: &AbsolutePathBuf,
) -> Option<String>
```

**Purpose**: Builds a small suffix that lists extra workspace roots beyond the current directory. This helps explain when Codex can work in more than one folder.

**Data flow**: It receives all workspace roots and the current directory. It filters out the current directory, converts any remaining roots to text, and joins them inside square brackets. It returns no suffix if there are no extra roots.

**Call relations**: `StatusHistoryCell::new` calls this before building the permission label. The suffix is later added to workspace-related permission text when relevant.

*Call graph*: called by 1 (new); 2 external calls (format!, iter).


##### `status_permissions_label`  (lines 619–684)

```
fn status_permissions_label(
    active_permission_profile: Option<&ActivePermissionProfile>,
    permission_profile: &PermissionProfile,
    approval_policy: AskForApproval,
    sandbox: &str,
    ap
```

**Purpose**: Creates the final human-readable permissions label shown on the status card. It combines the sandbox level, approval behavior, active profile name, and workspace-root details.

**Data flow**: It receives the active permission profile, concrete permission profile, approval policy, simplified sandbox text, approval label, and optional workspace suffix. It checks for built-in profiles like read-only, workspace, and full access, then formats special cases clearly. If nothing matches a built-in case, it returns a custom/profile label with the sandbox and approval details included.

**Call relations**: `StatusHistoryCell::new` calls this after calculating the sandbox and approval pieces. It may call `decorate_workspace_sandbox_label` to attach extra workspace roots to workspace-style sandbox labels.

*Call graph*: calls 1 internal fn (decorate_workspace_sandbox_label); called by 1 (new); 1 external calls (format!).


##### `decorate_workspace_sandbox_label`  (lines 686–691)

```
fn decorate_workspace_sandbox_label(sandbox: &str, workspace_root_suffix: Option<&str>) -> String
```

**Purpose**: Adds the extra workspace-root suffix to sandbox labels that describe workspace access. It avoids adding that suffix to unrelated permission labels.

**Data flow**: It receives a sandbox label and an optional suffix. If the suffix exists and the sandbox label starts with `workspace`, it appends the suffix. Otherwise it returns the original sandbox label as owned text.

**Call relations**: `status_permissions_label` calls this for custom or profile-based permission displays, where the sandbox wording needs a small final cleanup.

*Call graph*: called by 1 (status_permissions_label); 1 external calls (format!).


##### `status_approval_label`  (lines 693–706)

```
fn status_approval_label(
    approval_policy: AskForApproval,
    approvals_reviewer: ApprovalsReviewer,
    approval: &str,
) -> String
```

**Purpose**: Turns approval settings into wording that makes sense to the user. In particular, it distinguishes between asking the user and automatic review when approvals happen on request.

**Data flow**: It receives the approval policy, who reviews approvals, and the raw approval text. If approvals are on request, it returns either `Approve for me` or `Ask for approval`. For other policies, it returns the original approval text.

**Call relations**: `StatusHistoryCell::new` calls this before composing the final permissions label. Its output becomes the approval part inside the `Permissions` row.

*Call graph*: called by 1 (new).


##### `StatusHistoryCell::display_lines`  (lines 709–874)

```
fn display_lines(&self, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Draws the complete status card as terminal lines. This is the main rendering function for what the user sees after running `/status`.

**Data flow**: It receives the terminal width. It reads the card’s stored facts, plus the shared rate-limit and agent-summary state, then decides which rows should appear. It builds aligned labels, optional usage and remote notes, model and account rows, session rows, token and context rows, and rate-limit rows. It wraps or truncates text to fit the width, then surrounds the result with a border and returns the finished lines.

**Call relations**: The history system calls this through the `HistoryCell` behavior when the card needs to be shown. `raw_lines` and `display_hyperlink_lines` also call it as their starting point, then transform the result for plain text or hyperlink-aware output.

*Call graph*: calls 10 internal fn (collect_rate_limit_labels, context_window_spans, rate_limit_lines, token_usage_spans, from_labels, push_label, format_directory_display, new, adaptive_wrap_lines, word_wrap_lines); called by 2 (display_hyperlink_lines, raw_lines); 8 external calls (from, from, new, new, with_border_with_inner_width, matches!, from, vec!).


##### `StatusHistoryCell::raw_lines`  (lines 876–878)

```
fn raw_lines(&self) -> Vec<Line<'static>>
```

**Purpose**: Produces a plain-text-like version of the status card. This is useful when styled terminal output needs to be flattened.

**Data flow**: It asks `display_lines` to render the card at the maximum width, then passes those lines through a helper that strips or normalizes them into plain lines. It returns the plain line list.

**Call relations**: This is part of the `HistoryCell` interface. It builds directly on `display_lines` so the raw output stays consistent with the visual card.

*Call graph*: calls 2 internal fn (plain_lines, display_lines).


##### `StatusHistoryCell::display_hyperlink_lines`  (lines 880–903)

```
fn display_hyperlink_lines(
        &self,
        width: u16,
    ) -> Vec<crate::terminal_hyperlinks::HyperlinkLine>
```

**Purpose**: Produces the status card with terminal hyperlink metadata added for the ChatGPT usage URL. This lets terminals that support links make the URL clickable.

**Data flow**: It renders normal display lines, converts them into hyperlink-capable lines, then scans each visible line for the ChatGPT usage URL. When it finds the URL, it records the exact terminal columns that should link to that destination. It returns the hyperlink-aware lines.

**Call relations**: This is called when the UI wants display output that can include clickable terminal links. `transcript_hyperlink_lines` reuses it so transcript output gets the same link behavior.

*Call graph*: calls 2 internal fn (display_lines, plain_hyperlink_lines); called by 1 (transcript_hyperlink_lines).


##### `StatusHistoryCell::transcript_hyperlink_lines`  (lines 905–910)

```
fn transcript_hyperlink_lines(
        &self,
        width: u16,
    ) -> Vec<crate::terminal_hyperlinks::HyperlinkLine>
```

**Purpose**: Returns hyperlink-aware lines for transcript output. It keeps transcript rendering consistent with normal display rendering.

**Data flow**: It receives a width and simply asks `display_hyperlink_lines` to produce the lines. The same rendered content and hyperlink ranges come out.

**Call relations**: This is part of the history-cell output path for transcripts. It delegates entirely to `display_hyperlink_lines` rather than maintaining a separate transcript-specific renderer.

*Call graph*: calls 1 internal fn (display_hyperlink_lines).


##### `format_model_provider`  (lines 913–931)

```
fn format_model_provider(config: &Config, runtime_base_url: Option<&str>) -> Option<String>
```

**Purpose**: Formats the model provider row, while hiding it for the default OpenAI provider case where showing it would add little value. It also includes a safe base URL when a custom runtime URL is being used.

**Data flow**: It reads the configured provider name and ID, plus an optional runtime base URL. It chooses a display name, sanitizes the base URL if present, and suppresses output for the default OpenAI setup. Otherwise it returns either the provider name alone or the provider name plus sanitized URL.

**Call relations**: `StatusHistoryCell::new` calls this while preparing card fields. It calls `sanitize_base_url` so unsafe or noisy URL parts are removed before display.

*Call graph*: called by 1 (new); 1 external calls (format!).


##### `sanitize_base_url`  (lines 933–947)

```
fn sanitize_base_url(raw: &str) -> Option<String>
```

**Purpose**: Cleans a provider base URL before it is shown to the user. This prevents accidental display of credentials or unnecessary URL parts.

**Data flow**: It receives raw URL text. It trims whitespace, rejects empty or invalid URLs, removes username, password, query string, and fragment, trims a trailing slash, and returns the cleaned URL if anything remains.

**Call relations**: `format_model_provider` calls this when a runtime base URL is available. Its output is only for display, not for making network requests.

*Call graph*: 1 external calls (parse).


### `tui/src/token_usage.rs`

`data_model` · `cross-cutting; used when token counts are received and displayed in the TUI`

Language models work with “tokens,” which are small chunks of text. The terminal UI needs to show people how many tokens were used, how many came from cache, how many were produced as output, and how much room may remain in the model’s context window — the maximum amount of text the model can keep in mind at once.

This file is the shared shape for that information. The main type, `TokenUsage`, stores raw counts such as input tokens, cached input tokens, output tokens, reasoning output tokens, and total tokens. Its helper methods clean those numbers up before display. For example, negative cached-token values are treated as zero, and “non-cached input” is calculated by subtracting cached input from total input without letting the result go below zero.

It also defines how token usage is printed as a human-readable line, using thousands separators so large numbers are easier to scan. A second type, `TokenUsageInfo`, groups together the accumulated session total, the latest request’s token usage, and the model’s optional context window size.

One important detail is the baseline of 12,000 tokens. When estimating remaining context window space, the code treats that baseline as already reserved and only reports remaining percentage above it. This avoids giving a misleading sense of available room when the window is small.

#### Function details

##### `TokenUsage::is_zero`  (lines 21–23)

```
fn is_zero(&self) -> bool
```

**Purpose**: Checks whether this token usage record represents no usage at all. It is useful when the UI wants to avoid showing an empty or meaningless usage line.

**Data flow**: It reads the `total_tokens` number from the `TokenUsage` value. If that number is exactly zero, it returns `true`; otherwise it returns `false`. It does not change the token usage record.

**Call relations**: This is a simple check available to other parts of the TUI when deciding whether a token usage value is worth showing. It does not call any helper functions and stands on its own.


##### `TokenUsage::cached_input`  (lines 25–27)

```
fn cached_input(&self) -> i64
```

**Purpose**: Returns the number of input tokens that were served from cache, while protecting the rest of the code from negative values. Cached input means text the system could reuse instead of fully processing again.

**Data flow**: It reads `cached_input_tokens`. If that value is positive, it returns it unchanged; if it is negative, it returns zero. The original stored value is not modified.

**Call relations**: This is the basic cleanup step for cached-token counting. `TokenUsage::non_cached_input` calls it so that subtracting cached tokens from input tokens is based on a safe, non-negative cached amount.

*Call graph*: called by 1 (non_cached_input).


##### `TokenUsage::non_cached_input`  (lines 29–31)

```
fn non_cached_input(&self) -> i64
```

**Purpose**: Calculates how many input tokens were not cached and therefore count as fresh input work. This helps the UI distinguish reused text from newly processed text.

**Data flow**: It reads `input_tokens`, asks `TokenUsage::cached_input` for a safe cached-token count, subtracts cached from total input, and returns the result. If the subtraction would go below zero, it returns zero instead.

**Call relations**: This builds on `TokenUsage::cached_input` and is itself used by `TokenUsage::blended_total`. In the display flow, it provides the input number that users see as the main input cost, separate from the cached amount.

*Call graph*: calls 1 internal fn (cached_input); called by 1 (blended_total).


##### `TokenUsage::blended_total`  (lines 33–35)

```
fn blended_total(&self) -> i64
```

**Purpose**: Calculates the total shown to the user as fresh input plus output. It intentionally leaves cached input out of this total so the visible number better reflects the work that was not reused.

**Data flow**: It asks `TokenUsage::non_cached_input` for the fresh input count, reads `output_tokens`, treats negative output as zero, adds the two numbers, and returns a non-negative total.

**Call relations**: This function depends on `TokenUsage::non_cached_input` for the cleaned input side of the calculation. The display formatter uses this blended idea of total when presenting token usage in a compact human-readable line.

*Call graph*: calls 1 internal fn (non_cached_input).


##### `TokenUsage::tokens_in_context_window`  (lines 39–41)

```
fn tokens_in_context_window(&self) -> i64
```

**Purpose**: Returns the raw total token count used for context-window calculations. For the latest usage record, this means the current active context size; for accumulated usage, it means the full session total.

**Data flow**: It reads `total_tokens` and returns that exact value. It does not adjust, clamp, or reformat it, and it does not change anything.

**Call relations**: This gives `TokenUsage::percent_of_context_window_remaining` the raw count it needs before estimating remaining context space. Keeping this as a separate method makes the meaning of `total_tokens` explicit.

*Call graph*: called by 1 (percent_of_context_window_remaining).


##### `TokenUsage::percent_of_context_window_remaining`  (lines 43–53)

```
fn percent_of_context_window_remaining(&self, context_window: i64) -> i64
```

**Purpose**: Estimates what percentage of the model’s usable context window remains. This helps the TUI warn or inform users when a conversation is getting close to the model’s memory limit.

**Data flow**: It receives a `context_window` size. If that size is not larger than the 12,000-token baseline, it returns zero. Otherwise it subtracts the baseline from the window, reads the current token count through `TokenUsage::tokens_in_context_window`, subtracts the baseline from used tokens, computes the remaining percentage, clamps it between 0 and 100, rounds it, and returns it as a whole number.

**Call relations**: This function calls `TokenUsage::tokens_in_context_window` to get the usage number it compares against the model’s capacity. It is meant for the UI path that wants to show remaining context space rather than raw token counts.

*Call graph*: calls 1 internal fn (tokens_in_context_window).


##### `TokenUsage::fmt`  (lines 64–88)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Defines how a `TokenUsage` value appears when converted to text for display. It produces a concise line like a receipt: total, input, optional cached input, output, and optional reasoning output.

**Data flow**: It reads the token usage fields, uses the helper calculations for blended total, non-cached input, and cached input, formats large numbers with separators, and writes the final sentence into the formatter provided by Rust’s display system. It adds the cached and reasoning details only when those numbers are positive.

**Call relations**: This is called automatically whenever code formats `TokenUsage` with normal display formatting. It hands the final text to Rust’s `write!` mechanism so the TUI or logs can show token usage in a readable form.

*Call graph*: 1 external calls (write!).


### `tui/src/chatwidget/tokens/chart.rs`

`domain_logic` · `request handling for the /usage display`

When a user asks for `/usage`, the app receives account token totals and daily history from the server. This file is the display workshop for that data. It does not fetch anything itself. Instead, it takes an already-loaded response and turns it into `ratatui` text lines, which are styled pieces of terminal UI text.

The chart is built around a fixed 52-week window, like a calendar heat map. First it writes a title and summary numbers such as lifetime tokens, peak day, streak, and longest task. It packs those fields onto one or more lines depending on how wide the terminal is, so narrow windows still look reasonable.

If daily history is missing, it says so. Otherwise it normalizes the server’s dated buckets into one value per calendar cell, starting on the oldest Sunday and ending at the current week. Bad dates, future dates, and dates outside the window are ignored. Duplicate days are added together, and negative token counts are treated as zero.

Then it draws one of three views. Daily mode shows intensity per day. Weekly mode turns each week into a vertical bar. Cumulative mode shows a running total over time. A small palette module supplies the characters and colors, while this file decides what each cell means.

#### Function details

##### `TokenActivityView::parse`  (lines 45–52)

```
fn parse(value: &str) -> Option<Self>
```

**Purpose**: This reads the optional word after `/usage` and turns it into one of the supported chart views. It lets `/usage`, `/usage daily`, `/usage weekly`, and `/usage cumulative` choose different displays, while rejecting unknown words.

**Data flow**: It receives a text value from the command. It trims spaces, lowercases it, compares it with accepted names, and returns the matching view. If the text is not recognized, it returns nothing so the command layer can report the unsupported argument.

**Call relations**: The slash-command dispatcher calls this when preparing a `/usage` command with arguments. By returning either a clear view choice or no match, it decides whether the rest of the usage display can proceed.

*Call graph*: called by 1 (dispatch_prepared_command_with_args).


##### `TokenActivityView::label`  (lines 54–60)

```
fn label(self) -> &'static str
```

**Purpose**: This gives a human-readable name for a chart view, such as `Daily` or `Weekly`. It is a small convenience for places that need to show the selected mode as text.

**Data flow**: It receives one `TokenActivityView` value and matches it to a fixed string. It does not read or change anything else.

**Call relations**: No caller is shown in the supplied call graph, but it belongs with the view enum as the plain-text label for each possible display mode.


##### `loaded_lines`  (lines 63–86)

```
fn loaded_lines(
    view: TokenActivityView,
    response: &GetAccountTokenUsageResponse,
    today: NaiveDate,
    width: u16,
) -> Vec<Line<'static>>
```

**Purpose**: This is the main formatter for a loaded token-usage response. It builds all terminal lines for the card: title, summary numbers, spacing, and the activity chart or an unavailable-history message.

**Data flow**: It receives the selected view, the server response, today's date, and the available width. It starts with a title, adds packed summary lines, checks whether daily history exists, and either adds a warning line or asks the chart builder to create the calendar/bar display. It returns a list of styled terminal lines.

**Call relations**: The parent token UI calls this through `display_lines` after usage data has been loaded. Inside, it delegates width calculation to `graph_width`, summary formatting to `summary_lines`, and chart drawing to `chart_lines`.

*Call graph*: calls 3 internal fn (chart_lines, graph_width, summary_lines); called by 1 (display_lines); 2 external calls (default, vec!).


##### `chart_lines`  (lines 88–138)

```
fn chart_lines(
    view: TokenActivityView,
    buckets: &[codex_app_server_protocol::AccountTokenUsageDailyBucket],
    today: NaiveDate,
    width: u16,
) -> Vec<Line<'static>>
```

**Purpose**: This draws the main activity area below the summary. Depending on the selected view, it creates a daily heat map, weekly bars, or cumulative bars for the last 12 months.

**Data flow**: It receives raw daily buckets, today's date, the chosen view, and terminal width. It converts buckets into fixed daily values, decides how many week columns fit, computes display intensity levels, adds month labels, builds seven rows of chart cells, and finishes with a legend or caption plus a view footer. It returns terminal lines ready to display.

**Call relations**: `loaded_lines` calls this only when daily history exists. It relies on helpers such as `daily_values`, `shown_columns`, `levels_for_view`, `month_labels`, `weekday_label`, `legend_line`, `bar_caption`, and `view_footer` to turn data into a readable chart.

*Call graph*: calls 9 internal fn (bar_caption, cell_date, daily_values, legend_line, levels_for_view, month_labels, current, shown_columns, view_footer); called by 1 (loaded_lines); 4 external calls (default, styled, new, vec!).


##### `shown_columns`  (lines 140–146)

```
fn shown_columns(width: u16) -> usize
```

**Purpose**: This calculates how many week columns can fit in the available terminal width. It prevents the chart from overflowing a narrow screen.

**Data flow**: It receives a width in terminal cells. It subtracts space reserved for the left labels, accounts for the spacing between columns, caps the answer at 52 weeks, and returns the number of columns that can be shown.

**Call relations**: `chart_lines` uses this to decide whether it can draw the graph at all and how much history to show. `graph_width` uses the same calculation so the summary can align with the chart width.

*Call graph*: called by 2 (chart_lines, graph_width); 1 external calls (from).


##### `graph_width`  (lines 148–153)

```
fn graph_width(width: u16) -> u16
```

**Purpose**: This converts the terminal width into the actual width occupied by the chart area. The summary uses this so its headline fields line up with the graph below.

**Data flow**: It receives the raw width. In a special unlimited-width mode, it returns that width unchanged. Otherwise it asks `shown_columns` how many weeks fit and computes the resulting chart width.

**Call relations**: `loaded_lines` calls this before building summary lines. It shares the same width logic as `chart_lines`, which helps the top summary and the lower chart feel like one card.

*Call graph*: calls 1 internal fn (shown_columns); called by 1 (loaded_lines).


##### `summary_lines`  (lines 155–173)

```
fn summary_lines(response: &GetAccountTokenUsageResponse, width: u16) -> Vec<Line<'static>>
```

**Purpose**: This creates the headline usage numbers above the chart. It shows compact fields for lifetime tokens, peak daily tokens, streak, and longest task duration.

**Data flow**: It reads the summary part of the server response. It formats each value, groups fields so they fit the available width, turns each group into styled spans, indents them, and returns the resulting lines.

**Call relations**: `loaded_lines` calls this near the start of rendering. It depends on `format_optional_tokens`, `format_streak`, `format_optional_duration`, `pack_fields`, `summary_line`, and `align_summary_line` so each field is both readable and width-aware.

*Call graph*: calls 4 internal fn (format_optional_duration, format_optional_tokens, format_streak, pack_fields); called by 1 (loaded_lines).


##### `pack_fields`  (lines 177–198)

```
fn pack_fields(fields: &[(&str, String)], width: u16) -> Vec<Vec<usize>>
```

**Purpose**: This decides which summary fields can share a line. It keeps the fields in order and greedily fills each line until adding another field would make it too wide.

**Data flow**: It receives summary field labels and already-formatted values plus a width limit. It tries candidate groups, measures their rendered line width, starts a new group when needed, and returns groups of field indexes. In unlimited-width mode, it puts all fields on one line.

**Call relations**: `summary_lines` uses this before actually producing the visible lines. It calls `summary_line` while testing candidate widths, like measuring packages before putting them on a shelf.

*Call graph*: calls 1 internal fn (summary_line); called by 1 (summary_lines); 4 external calls (new, take, from, vec!).


##### `summary_line`  (lines 200–211)

```
fn summary_line(fields: &[(&str, String)], indexes: &[usize]) -> Line<'static>
```

**Purpose**: This turns one group of summary fields into a styled terminal line. Labels are dim/comment-colored, while numbers are highlighted.

**Data flow**: It receives all possible fields and a list of indexes to include. For each selected field, it adds a separator if needed, then adds a styled label and styled value. It returns one `Line` made of those spans.

**Call relations**: `pack_fields` uses it to measure possible groupings, and `summary_lines` uses it when building the final visible summary. It calls `label_style` and `numeric_style` to keep summary styling consistent.

*Call graph*: calls 2 internal fn (label_style, numeric_style); called by 1 (pack_fields); 3 external calls (styled, new, format!).


##### `align_summary_line`  (lines 213–219)

```
fn align_summary_line(mut line: Line<'static>, width: u16) -> Line<'static>
```

**Purpose**: This adds the small left indent used by summary lines. It keeps the summary visually aligned with the chart card.

**Data flow**: It receives a terminal line and the width mode. In unlimited-width mode, it leaves the line unchanged. Otherwise it inserts one leading space and returns the adjusted line.

**Call relations**: `summary_lines` applies this after building each summary line. It is a final polish step before the summary is returned to `loaded_lines`.


##### `format_optional_tokens`  (lines 221–225)

```
fn format_optional_tokens(value: Option<i64>) -> String
```

**Purpose**: This formats an optional token count for display. If the server did not provide the value, it shows a dash instead of a misleading number.

**Data flow**: It receives either a token count or no value. With a count, it uses the app’s compact token formatter; without one, it returns `-`.

**Call relations**: `summary_lines` uses this for lifetime and peak token fields. It keeps missing data visibly different from zero.

*Call graph*: called by 1 (summary_lines).


##### `format_streak`  (lines 229–237)

```
fn format_streak(current: Option<i64>, longest: Option<i64>) -> String
```

**Purpose**: This combines current and longest usage streaks into one short display field. It avoids repeating the longest streak when it is the same as the current streak.

**Data flow**: It receives optional current and longest streak day counts. It formats cases such as `54d`, `12d (best 54d)`, `- (best 54d)`, or `-` depending on what data exists.

**Call relations**: `summary_lines` calls this while preparing the streak field. It hides the branching details so the summary builder can treat the result as plain text.

*Call graph*: called by 1 (summary_lines); 1 external calls (format!).


##### `format_optional_duration`  (lines 239–254)

```
fn format_optional_duration(value: Option<i64>) -> String
```

**Purpose**: This formats the longest task duration in a short human-readable way. It turns seconds into seconds, minutes, hours, or hours plus minutes.

**Data flow**: It receives either a duration in seconds or no value. Missing data becomes `-`; negative durations are clamped to zero; then the value is converted into strings like `45s`, `12m`, `3h`, or `3h 15m`.

**Call relations**: `summary_lines` uses this for the `Longest task` field. It keeps raw seconds from leaking into the user interface.

*Call graph*: called by 1 (summary_lines).


##### `numeric_style`  (lines 256–259)

```
fn numeric_style() -> Style
```

**Purpose**: This chooses the visual style for numbers in the usage card. It tries to follow the app’s syntax/theme colors and falls back to green if the theme has no matching rule.

**Data flow**: It asks the highlighting system for a style matching numeric scopes. If that lookup succeeds, it returns the theme style; otherwise it returns a default green style.

**Call relations**: `summary_line` uses this for summary values, and `view_footer` uses it to emphasize the active chart view. It centralizes number styling so the card looks consistent.

*Call graph*: calls 1 internal fn (foreground_style_for_scopes); called by 2 (summary_line, view_footer).


##### `label_style`  (lines 261–263)

```
fn label_style() -> Style
```

**Purpose**: This chooses the visual style for quiet labels and helper text. It tries the app’s comment color and falls back to dim text.

**Data flow**: It asks the highlighting system for the comment style. If found, it returns that; if not, it returns a dim default style.

**Call relations**: Many display helpers use this, including `summary_line`, `weekday_label`, `legend_line`, `bar_caption`, and `view_footer`. It gives the less-important text a consistent subdued look.

*Call graph*: calls 1 internal fn (foreground_style_for_scopes); called by 5 (bar_caption, legend_line, summary_line, view_footer, weekday_label).


##### `weekday_label`  (lines 265–291)

```
fn weekday_label(view: TokenActivityView, row: usize) -> Span<'static>
```

**Purpose**: This creates the left-side label for each chart row. In daily mode it shows weekdays; in bar modes it acts like a simple vertical scale.

**Data flow**: It receives the active view and a row number from 0 to 6. For daily mode, it returns labels such as `Su`, `Mo`, and so on. For weekly and cumulative bar views, it returns `max` at the top, `0` at the bottom, and blanks between.

**Call relations**: `chart_lines` calls this while drawing each of the seven chart rows. It uses `label_style` so these gutter labels stay visually secondary.

*Call graph*: calls 1 internal fn (label_style); 1 external calls (styled).


##### `legend_line`  (lines 293–306)

```
fn legend_line(palette: &TokenActivityPalette) -> Line<'static>
```

**Purpose**: This builds the `Less ... More` legend for the daily heat map. It explains how the colored daily cells should be read.

**Data flow**: It receives the current palette. It creates a line starting with `Less`, adds one sample glyph for each activity level from 0 to 4, and ends with `More`.

**Call relations**: `chart_lines` uses this only for the daily view. It asks the palette for each glyph and color, so the legend matches the actual chart cells.

*Call graph*: calls 3 internal fn (label_style, for_level, glyph); called by 1 (chart_lines); 2 external calls (styled, vec!).


##### `bar_caption`  (lines 310–328)

```
fn bar_caption(view: TokenActivityView, values: &[i64]) -> Line<'static>
```

**Purpose**: This writes the explanatory caption for weekly and cumulative bar charts. The daily legend would be misleading there, so this states what each bar means and what the top value is.

**Data flow**: It receives the active view and daily values. It totals values by week, then either finds the tallest weekly total or sums all weeks for the cumulative top. If there is no activity, it returns a no-activity message; otherwise it returns a caption with the peak number highlighted.

**Call relations**: `chart_lines` calls this after drawing weekly or cumulative bars. It uses `weekly_totals`, `label_style`, and compact token formatting to make the scale understandable.

*Call graph*: calls 2 internal fn (label_style, weekly_totals); called by 1 (chart_lines); 2 external calls (styled, vec!).


##### `view_footer`  (lines 332–351)

```
fn view_footer(active: TokenActivityView) -> Line<'static>
```

**Purpose**: This adds a small footer showing the available `/usage` views: daily, weekly, and cumulative. It highlights the currently active one so users can discover the other modes.

**Data flow**: It receives the active view. It builds a line with all three view names separated by dots, styling the active name in bold numeric style and the inactive names as subdued labels.

**Call relations**: `chart_lines` appends this after the legend or caption. It uses `numeric_style` and `label_style` to make the current mode stand out without being loud.

*Call graph*: calls 2 internal fn (label_style, numeric_style); called by 1 (chart_lines); 2 external calls (styled, vec!).


##### `month_labels`  (lines 353–377)

```
fn month_labels(today: NaiveDate, first_column: usize, shown_columns: usize) -> Line<'static>
```

**Purpose**: This creates the month names above the chart columns. It places labels only where they fit, so the top row stays tidy even in narrow terminals.

**Data flow**: It receives today's date, the first visible week column, and the number of visible columns. It computes the chart start date, checks week starts near the beginning of each month, writes short month names into a character row, skips overlaps, and returns a styled line.

**Call relations**: `chart_lines` calls this before drawing the seven day rows. It uses `chart_start` so month labels line up with the same calendar window used by the data cells.

*Call graph*: calls 1 internal fn (chart_start); called by 1 (chart_lines); 2 external calls (days, vec!).


##### `daily_values`  (lines 384–408)

```
fn daily_values(
    buckets: &[codex_app_server_protocol::AccountTokenUsageDailyBucket],
    today: NaiveDate,
) -> Vec<i64>
```

**Purpose**: This normalizes the server’s daily usage buckets into exactly one value for every day in the 52-week chart window. It is the cleanup step that makes later drawing simple.

**Data flow**: It receives dated usage buckets and today's date. It computes the chart window, parses each bucket date, ignores invalid dates, future dates, and dates outside the window, adds duplicate dates together, clamps negative token values to zero, and returns a vector of daily totals ordered from oldest chart cell to newest.

**Call relations**: `chart_lines` calls this before any chart levels are calculated. It uses `chart_start` so the data, month labels, and cell dates all share the same calendar anchor.

*Call graph*: calls 1 internal fn (chart_start); called by 1 (chart_lines); 3 external calls (new, days, parse_from_str).


##### `levels_for_view`  (lines 410–425)

```
fn levels_for_view(values: &[i64], view: TokenActivityView) -> Vec<usize>
```

**Purpose**: This converts raw daily values into simple display levels. Those levels tell the chart whether to draw an empty cell, a light cell, a dark cell, or part of a bar.

**Data flow**: It receives the daily values and the selected view. Daily mode grades each day against the busiest day. Weekly mode totals days into weeks and makes bars. Cumulative mode totals weeks into a running sum and then makes bars. It returns one level per chart cell.

**Call relations**: `chart_lines` calls this after `daily_values`. It delegates the actual daily grading to `graded_levels`, weekly grouping to `weekly_totals`, and bar construction to `bar_levels`.

*Call graph*: calls 3 internal fn (bar_levels, graded_levels, weekly_totals); called by 1 (chart_lines).


##### `graded_levels`  (lines 427–439)

```
fn graded_levels(values: &[i64]) -> Vec<usize>
```

**Purpose**: This assigns daily heat-map intensity levels from 0 to 4. It makes busy days appear stronger while keeping quiet or empty days lighter.

**Data flow**: It receives daily token values. It finds the maximum value, then compares every day with that maximum: zero stays level 0, and nonzero days are split into four increasing levels. It returns the level list.

**Call relations**: `levels_for_view` uses this for the daily chart view. Its output is later turned into palette glyphs and colors by `chart_lines`.

*Call graph*: called by 1 (levels_for_view).


##### `weekly_totals`  (lines 441–446)

```
fn weekly_totals(values: &[i64]) -> Vec<i64>
```

**Purpose**: This adds seven daily values into one total per week. It turns the day-by-day calendar data into week-sized chunks.

**Data flow**: It receives a list of daily values. It processes the list in groups of seven and returns the sum of each group.

**Call relations**: `levels_for_view` uses this for weekly and cumulative calculations, and `bar_caption` uses it to explain the bar chart scale.

*Call graph*: called by 2 (bar_caption, levels_for_view).


##### `bar_levels`  (lines 448–461)

```
fn bar_levels(totals: &[i64]) -> Vec<usize>
```

**Purpose**: This turns weekly or cumulative totals into seven-cell-tall bars. It is what makes a larger total fill more rows from the bottom upward.

**Data flow**: It receives one total per column. It finds the maximum total, converts each total into a bar height from 0 to 7, and returns seven levels per column: filled cells at level 4 near the bottom and empty cells at level 0 above them.

**Call relations**: `levels_for_view` calls this for weekly and cumulative views. `chart_lines` later reads these levels row by row to draw the bar shapes.

*Call graph*: called by 1 (levels_for_view).


##### `chart_start`  (lines 463–466)

```
fn chart_start(today: NaiveDate) -> NaiveDate
```

**Purpose**: This finds the first day shown in the 52-week chart window. The chart always starts on a Sunday so weeks line up cleanly.

**Data flow**: It receives today's date. It moves back to the Sunday of the current week, then moves back 51 more weeks, and returns that start date.

**Call relations**: `daily_values`, `month_labels`, and `cell_date` all use this. It is the shared calendar anchor that keeps data cells, labels, and future-date checks aligned.

*Call graph*: called by 3 (cell_date, daily_values, month_labels); 4 external calls (days, weeks, weekday, from).


##### `cell_date`  (lines 468–470)

```
fn cell_date(today: NaiveDate, index: usize) -> Option<NaiveDate>
```

**Purpose**: This converts a chart cell index into its real calendar date. It is mainly used to avoid drawing future daily cells.

**Data flow**: It receives today's date and a zero-based cell index. It recomputes the chart start date, adds the index as a number of days, and returns the resulting date if the date arithmetic succeeds.

**Call relations**: `chart_lines` calls this while drawing daily mode cells. If a cell would represent a date after today, `chart_lines` leaves it blank instead of showing fake activity.

*Call graph*: calls 1 internal fn (chart_start); called by 1 (chart_lines); 1 external calls (days).


### External event adapters and backend feeds
These files adapt backend process, rate-limit, exec, and pull-stream events into the data that the TUI later projects into transcript and status UI.

### `codex-api/src/rate_limits.rs`

`io_transport` · `response handling`

Codex talks to a server that may say, “you have used 80% of this limit” or “your credits are empty.” That information arrives in raw forms: HTTP headers, which are small name/value labels on a response, or JSON messages over a websocket, which is a long-lived connection for live updates. This file is the translator between those raw messages and a clean RateLimitSnapshot used elsewhere in the app.

It supports the older default Codex limit headers, plus newer named “limit families” such as separate limits for different models or features. It normalizes names so small spelling differences, like dashes versus underscores, do not confuse the client. It also ignores empty or meaningless window data, such as a zero-used window with no reset time.

The file includes small parsing helpers for strings, numbers, and booleans, because headers are always text at first. Like a mailroom sorting envelopes, it checks each label, extracts the useful parts, and builds a tidy snapshot. If this file were wrong or missing, Codex could fail to warn users about limits, show stale usage, or miss credit information sent by the service.

#### Function details

##### `RateLimitError::fmt`  (lines 17–19)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: This defines how a RateLimitError is shown as text. It lets the error be printed or included in messages using its stored human-readable message.

**Data flow**: It receives a RateLimitError and a text formatter. It writes the error's message into that formatter, and the caller receives the normal formatting result.

**Call relations**: When Rust needs to display this error, it calls this method. The method delegates the actual text writing to the standard write operation.

*Call graph*: 1 external calls (write!).


##### `parse_default_rate_limit`  (lines 23–25)

```
fn parse_default_rate_limit(headers: &HeaderMap) -> Option<RateLimitSnapshot>
```

**Purpose**: This reads the standard, legacy Codex rate-limit headers. Use it when the caller only wants the default Codex limit rather than every named limit family.

**Data flow**: It receives an HTTP header map. It asks parse_rate_limit_for_limit to parse the default limit, then returns either a RateLimitSnapshot or nothing if parsing cannot produce one.

**Call relations**: parse_all_rate_limits calls this first so the default Codex snapshot is always considered before looking for other named limits. It is a small convenience wrapper around parse_rate_limit_for_limit.

*Call graph*: calls 1 internal fn (parse_rate_limit_for_limit); called by 1 (parse_all_rate_limits).


##### `parse_all_rate_limits`  (lines 28–51)

```
fn parse_all_rate_limits(headers: &HeaderMap) -> Vec<RateLimitSnapshot>
```

**Purpose**: This finds every rate-limit family present in a response and returns one snapshot per limit. It is used when the client wants the full picture, not just the default Codex limit.

**Data flow**: It receives all response headers. It first adds the default Codex snapshot, then scans header names for other limit IDs, parses each one, keeps only those with real data, and returns the list of snapshots.

**Call relations**: During response streaming, spawn_response_stream calls this to turn server headers into updates. Internally it uses parse_default_rate_limit for the main limit, header_name_to_limit_id to discover extra limits, and parse_rate_limit_for_limit to read each discovered family.

*Call graph*: calls 2 internal fn (header_name_to_limit_id, parse_default_rate_limit); called by 3 (parse_all_rate_limits_includes_default_codex_snapshot, parse_all_rate_limits_reads_all_limit_families, spawn_response_stream); 3 external calls (new, keys, new).


##### `parse_rate_limit_for_limit`  (lines 57–100)

```
fn parse_rate_limit_for_limit(
    headers: &HeaderMap,
    limit_id: Option<&str>,
) -> Option<RateLimitSnapshot>
```

**Purpose**: This parses the headers for one specific rate-limit family. It knows the naming pattern for primary and secondary windows, credit information, and an optional display name for the limit.

**Data flow**: It receives headers and an optional limit ID. It cleans the ID, builds the expected header names, reads primary and secondary usage windows, reads credits, reads a friendly limit name if present, and returns a RateLimitSnapshot.

**Call relations**: parse_default_rate_limit uses it for the built-in Codex limit, and parse_all_rate_limits uses it for each discovered named limit. It hands detailed field parsing to parse_rate_limit_window, parse_credits_snapshot, parse_header_str, and normalize_limit_id.

*Call graph*: calls 4 internal fn (normalize_limit_id, parse_credits_snapshot, parse_header_str, parse_rate_limit_window); called by 4 (parse_default_rate_limit, parse_rate_limit_for_limit_defaults_to_codex_headers, parse_rate_limit_for_limit_prefers_limit_name_header, parse_rate_limit_for_limit_reads_secondary_headers); 1 external calls (format!).


##### `parse_rate_limit_event`  (lines 133–165)

```
fn parse_rate_limit_event(payload: &str) -> Option<RateLimitSnapshot>
```

**Purpose**: This parses a live websocket JSON event about Codex rate limits. It lets the client update rate-limit state even when the information arrives as a streaming event instead of HTTP headers.

**Data flow**: It receives a JSON text payload. It tries to decode it, checks that the event type is codex.rate_limits, converts any primary and secondary windows, converts credit data, chooses a limit ID, and returns a RateLimitSnapshot. If the JSON is invalid or is the wrong event type, it returns nothing.

**Call relations**: run_websocket_response_stream calls this when websocket messages arrive. The function uses serde_json parsing for the raw JSON and map_event_window to convert each window into the shared snapshot shape.

*Call graph*: calls 1 internal fn (map_event_window); called by 1 (run_websocket_response_stream); 1 external calls (from_str).


##### `map_event_window`  (lines 167–174)

```
fn map_event_window(window: Option<&RateLimitEventWindow>) -> Option<RateLimitWindow>
```

**Purpose**: This converts one rate-limit window from the websocket event format into the common RateLimitWindow format. It keeps the rest of the code from needing to know the event-specific field names.

**Data flow**: It receives an optional event window. If there is no window, it returns nothing; otherwise it copies the used percentage, window length, and reset time into a RateLimitWindow.

**Call relations**: parse_rate_limit_event calls this for the primary and secondary windows while building a full RateLimitSnapshot from a websocket message.

*Call graph*: called by 1 (parse_rate_limit_event).


##### `parse_promo_message`  (lines 177–182)

```
fn parse_promo_message(headers: &HeaderMap) -> Option<String>
```

**Purpose**: This reads an optional promotional or explanatory message from a response header. It only returns a message if the header exists and is not blank.

**Data flow**: It receives headers, reads x-codex-promo-message as text, trims surrounding whitespace, rejects an empty result, and returns the cleaned string.

**Call relations**: This uses parse_header_str to safely read the raw header text. It is available to response-handling code that wants to show or store server-supplied messaging alongside rate-limit information.

*Call graph*: calls 1 internal fn (parse_header_str).


##### `parse_rate_limit_reached_type`  (lines 184–189)

```
fn parse_rate_limit_reached_type(headers: &HeaderMap) -> Option<RateLimitReachedType>
```

**Purpose**: This reads which kind of rate limit was reached from a response header. The result helps the client distinguish different limit-hit situations instead of treating them all the same.

**Data flow**: It receives headers, reads x-codex-rate-limit-reached-type, trims it, tries to parse it into a RateLimitReachedType value, and returns nothing if the header is absent or unrecognized.

**Call relations**: It relies on parse_header_str for safe header reading, then hands the cleaned text to the RateLimitReachedType parser. It supports callers that need more detail after the server says a limit has been reached.

*Call graph*: calls 1 internal fn (parse_header_str).


##### `parse_rate_limit_window`  (lines 191–213)

```
fn parse_rate_limit_window(
    headers: &HeaderMap,
    used_percent_header: &str,
    window_minutes_header: &str,
    resets_at_header: &str,
) -> Option<RateLimitWindow>
```

**Purpose**: This reads one usage window, such as a primary or secondary limit window, from three related headers. A window tells how much has been used, how long the window is, and when it resets.

**Data flow**: It receives headers plus the three header names to look up. It reads the used percentage first, then optionally reads the window length and reset time, and returns a RateLimitWindow only when the values contain meaningful data.

**Call relations**: parse_rate_limit_for_limit calls this twice: once for the primary window and once for the secondary window. It uses parse_header_f64 for the percentage; the companion integer parsing helpers provide the minute and reset fields.

*Call graph*: calls 1 internal fn (parse_header_f64); called by 1 (parse_rate_limit_for_limit).


##### `parse_credits_snapshot`  (lines 215–227)

```
fn parse_credits_snapshot(headers: &HeaderMap) -> Option<CreditsSnapshot>
```

**Purpose**: This reads credit status from headers. It tells the rest of the app whether credits exist, whether they are unlimited, and what balance text the server provided.

**Data flow**: It receives headers. It requires valid boolean values for has_credits and unlimited, optionally reads a non-empty balance string, and returns a CreditsSnapshot when the required pieces are present.

**Call relations**: parse_rate_limit_for_limit calls this while building each snapshot. It depends on parse_header_bool for the required true/false fields and parse_header_str for the optional balance.

*Call graph*: calls 2 internal fn (parse_header_bool, parse_header_str); called by 1 (parse_rate_limit_for_limit).


##### `parse_header_f64`  (lines 229–234)

```
fn parse_header_f64(headers: &HeaderMap, name: &str) -> Option<f64>
```

**Purpose**: This reads a header as a decimal number. It is used for percentages, where values like 12.5 are valid.

**Data flow**: It receives headers and a header name. It reads the raw text, tries to convert it to a finite floating-point number, and returns the number only if conversion succeeds and the result is not infinity or not-a-number.

**Call relations**: parse_rate_limit_window calls this to read the used-percent header before it can build a usage window. It gets the raw text through parse_header_str.

*Call graph*: calls 1 internal fn (parse_header_str); called by 1 (parse_rate_limit_window).


##### `parse_header_i64`  (lines 236–238)

```
fn parse_header_i64(headers: &HeaderMap, name: &str) -> Option<i64>
```

**Purpose**: This reads a header as a whole number. It is used for values such as minutes or timestamp-like reset times.

**Data flow**: It receives headers and a header name. It reads the raw text, tries to convert it to a 64-bit integer, and returns either that number or nothing if the header is missing or invalid.

**Call relations**: It is part of the shared header-parsing toolbox used by rate-limit window parsing. It relies on parse_header_str so invalid header text is filtered out before number conversion.

*Call graph*: calls 1 internal fn (parse_header_str).


##### `parse_header_bool`  (lines 240–249)

```
fn parse_header_bool(headers: &HeaderMap, name: &str) -> Option<bool>
```

**Purpose**: This reads a header as a true-or-false value. It accepts both words like true and false and numeric forms like 1 and 0.

**Data flow**: It receives headers and a header name. It reads the raw text, compares it against accepted true and false spellings, and returns a boolean or nothing if the value is not recognized.

**Call relations**: parse_credits_snapshot calls this for the required credit flags. It uses parse_header_str to get the raw header text safely.

*Call graph*: calls 1 internal fn (parse_header_str); called by 1 (parse_credits_snapshot).


##### `parse_header_str`  (lines 251–253)

```
fn parse_header_str(headers: &'a HeaderMap, name: &str) -> Option<&'a str>
```

**Purpose**: This safely reads a header value as normal text. HTTP header values are bytes internally, so this function rejects values that are not valid text.

**Data flow**: It receives headers and a header name. It looks up the value, tries to view it as a string, and returns the string slice or nothing if the header is missing or not valid text.

**Call relations**: Most parsing helpers use this as their first step, including credit parsing, number parsing, boolean parsing, promo-message parsing, direct limit-name parsing, and rate-limit-reached-type parsing.

*Call graph*: called by 7 (parse_credits_snapshot, parse_header_bool, parse_header_f64, parse_header_i64, parse_promo_message, parse_rate_limit_for_limit, parse_rate_limit_reached_type); 1 external calls (get).


##### `has_rate_limit_data`  (lines 255–257)

```
fn has_rate_limit_data(snapshot: &RateLimitSnapshot) -> bool
```

**Purpose**: This checks whether a snapshot contains any useful rate-limit information. It prevents empty discovered limit families from being reported as real updates.

**Data flow**: It receives a RateLimitSnapshot. It checks whether primary window, secondary window, or credit information is present, and returns true if at least one exists.

**Call relations**: parse_all_rate_limits uses this after parsing non-default limit families, so only snapshots with actual data are added to the returned list.


##### `header_name_to_limit_id`  (lines 259–264)

```
fn header_name_to_limit_id(header_name: &str) -> Option<String>
```

**Purpose**: This extracts a limit ID from a header name that follows the rate-limit naming pattern. For example, it can turn a header name for a specific primary-used-percent value into the corresponding limit family name.

**Data flow**: It receives a lowercased header name. It checks that the name starts with x- and ends with -primary-used-percent, removes those wrapper parts, normalizes the remaining limit name, and returns it if the pattern matched.

**Call relations**: parse_all_rate_limits calls this while scanning all header names to discover non-default limit families. It uses normalize_limit_id so discovered IDs match the format used in snapshots.

*Call graph*: calls 1 internal fn (normalize_limit_id); called by 1 (parse_all_rate_limits).


##### `normalize_limit_id`  (lines 266–268)

```
fn normalize_limit_id(name: impl Into<String>) -> String
```

**Purpose**: This puts a limit ID into one consistent form. It trims spaces, lowercases letters, and changes dashes into underscores.

**Data flow**: It receives any value that can become a string. It converts it, cleans the spelling and separators, and returns the normalized string.

**Call relations**: parse_rate_limit_for_limit uses this for the snapshot ID, and header_name_to_limit_id uses it for IDs found in header names. This keeps callers from seeing separate names for what is really the same limit.

*Call graph*: called by 2 (header_name_to_limit_id, parse_rate_limit_for_limit); 1 external calls (into).


##### `tests::parse_rate_limit_for_limit_defaults_to_codex_headers`  (lines 277–299)

```
fn parse_rate_limit_for_limit_defaults_to_codex_headers()
```

**Purpose**: This test proves that parsing with no explicit limit ID reads the default Codex headers. It protects the older header format from accidental breakage.

**Data flow**: It builds a small header map with primary usage, window length, and reset time. It parses those headers and checks that the snapshot is for codex and contains the expected primary window values.

**Call relations**: The test calls parse_rate_limit_for_limit directly, imitating what parse_default_rate_limit would do in normal code. Its assertions document the expected default behavior.

*Call graph*: calls 1 internal fn (parse_rate_limit_for_limit); 3 external calls (new, from_static, assert_eq!).


##### `tests::parse_rate_limit_for_limit_reads_secondary_headers`  (lines 302–326)

```
fn parse_rate_limit_for_limit_reads_secondary_headers()
```

**Purpose**: This test proves that a named limit family can be read from its own header prefix. It confirms that an underscore-style input ID maps to dash-style HTTP header names and back to the normalized snapshot ID.

**Data flow**: It creates headers for a codex_secondary limit family, parses that named limit, and checks that the primary window values are read while no secondary window is invented.

**Call relations**: The test calls parse_rate_limit_for_limit with a specific limit ID. It exercises the same path parse_all_rate_limits uses after discovering an extra limit family.

*Call graph*: calls 1 internal fn (parse_rate_limit_for_limit); 3 external calls (new, from_static, assert_eq!).


##### `tests::parse_rate_limit_for_limit_prefers_limit_name_header`  (lines 329–344)

```
fn parse_rate_limit_for_limit_prefers_limit_name_header()
```

**Purpose**: This test checks that a friendly limit name from the server is preserved. That matters when the internal limit ID is not the best thing to show to a person.

**Data flow**: It creates headers with usage data and an x-...-limit-name value. After parsing, it checks that the snapshot keeps the normalized ID and includes the friendly limit name.

**Call relations**: The test calls parse_rate_limit_for_limit and focuses on the branch that reads the optional limit-name header through parse_header_str.

*Call graph*: calls 1 internal fn (parse_rate_limit_for_limit); 3 external calls (new, from_static, assert_eq!).


##### `tests::parse_all_rate_limits_reads_all_limit_families`  (lines 347–364)

```
fn parse_all_rate_limits_reads_all_limit_families()
```

**Purpose**: This test proves that scanning all headers returns both the default Codex limit and an additional named limit. It protects the multi-limit discovery behavior.

**Data flow**: It builds headers for the default family and one extra family. It calls parse_all_rate_limits and checks that two snapshots come back in the expected order with the expected IDs.

**Call relations**: The test exercises parse_all_rate_limits as response streaming would use it. Through that one call, it also covers discovery with header_name_to_limit_id and per-limit parsing with parse_rate_limit_for_limit.

*Call graph*: calls 1 internal fn (parse_all_rate_limits); 3 external calls (new, from_static, assert_eq!).


##### `tests::parse_all_rate_limits_includes_default_codex_snapshot`  (lines 367–377)

```
fn parse_all_rate_limits_includes_default_codex_snapshot()
```

**Purpose**: This test confirms that the default Codex snapshot is returned even when no rate-limit headers are present. That gives callers a stable baseline result.

**Data flow**: It starts with an empty header map, calls parse_all_rate_limits, and checks that the result contains one empty codex snapshot with no windows or credits.

**Call relations**: The test calls parse_all_rate_limits, which in turn calls parse_default_rate_limit. It documents the special rule that the default snapshot is always included.

*Call graph*: calls 1 internal fn (parse_all_rate_limits); 2 external calls (new, assert_eq!).


### `core/src/unified_exec/async_watcher.rs`

`orchestration` · `request handling, while a unified exec command is running`

When the system starts a command, the command may keep printing text while it runs and may also end at any time. This file is the bridge between that live process and the rest of the app’s event system. Without it, users would not see output as it arrives, and the system might not send a reliable final result for the command.

It starts two background tasks. One task reads bytes coming from the process, adds them to a shared transcript, and sends small output-delta events. It is careful to split output only at valid UTF-8 text boundaries when possible, so it does not accidentally cut a character in half. It also caps each event size, which protects downstream consumers from huge messages.

The second task waits for the process to exit. It then waits briefly for any last output to be drained, like waiting a moment after a printer stops so the final page can come out. After that it builds either a success or failure event, including the saved transcript, exit code, duration, command, working directory, and process id.

The shared transcript is protected by a mutex, which is a lock that prevents two async tasks from editing or reading it at the same time.

#### Function details

##### `start_streaming_output`  (lines 40–102)

```
fn start_streaming_output(
    process: &UnifiedExecProcess,
    context: &UnifiedExecContext,
    transcript: Arc<Mutex<HeadTailBuffer>>,
)
```

**Purpose**: Starts a background task that continuously reads output from a running process. It sends live output events and records the same output in the shared transcript.

**Data flow**: It receives a process, the current execution context, and a shared transcript buffer. It gets an output receiver, an exit signal, and a notification used to say “output is fully drained.” As byte chunks arrive, it passes them to `process_chunk`; when the process exits, it waits a short grace period for trailing output, then notifies the rest of the system that output reading is complete.

**Call relations**: This is called by `exec_command` after a command has started. It uses the process helpers to subscribe to output and cancellation, then runs independently in a spawned async task. For each chunk, it hands the real work to `process_chunk`, and at the end it signals the exit watcher through the process’s output-drained notification.

*Call graph*: calls 3 internal fn (cancellation_token, output_drained_notify, output_receiver); called by 1 (exec_command); 4 external calls (clone, new, select!, spawn).


##### `spawn_exit_watcher`  (lines 107–157)

```
fn spawn_exit_watcher(
    process: Arc<UnifiedExecProcess>,
    session_ref: Arc<Session>,
    turn_ref: Arc<TurnContext>,
    call_id: String,
    command: Vec<String>,
    cwd: AbsolutePathBuf,
```

**Purpose**: Starts a background task that waits for the command to finish and then emits the final command result event. It makes sure final output has been collected before reporting the end.

**Data flow**: It receives the process, session and turn information, command details, process id, transcript, and start time. It waits for the process cancellation or exit signal, then waits for the streaming task to say output is drained. It calculates how long the command ran, checks whether the process recorded a failure message, and emits either a successful end event or a failed end event.

**Call relations**: This is called by `store_process` when the running process is registered. It waits alongside the streaming task started elsewhere. Once both the process and its output stream are done, it calls `emit_exec_end_for_unified_exec` for normal exits or `emit_failed_exec_end_for_unified_exec` for process-level failures.

*Call graph*: calls 2 internal fn (emit_exec_end_for_unified_exec, emit_failed_exec_end_for_unified_exec); called by 1 (store_process); 3 external calls (now, new, spawn).


##### `process_chunk`  (lines 159–189)

```
async fn process_chunk(
    pending: &mut Vec<u8>,
    transcript: &Arc<Mutex<HeadTailBuffer>>,
    call_id: &str,
    session_ref: &Arc<Session>,
    turn_ref: &Arc<TurnContext>,
    emitted_deltas:
```

**Purpose**: Takes one new batch of process output bytes, saves it to the transcript, and sends it as a live output event when allowed. It also keeps partial text bytes until they can be safely emitted.

**Data flow**: It receives a mutable pending-byte buffer, the shared transcript, call and session context, a counter of already emitted deltas, and a new output chunk. It appends the chunk to pending bytes, repeatedly extracts valid UTF-8-sized prefixes, writes each prefix into the transcript, and sends an `ExecCommandOutputDelta` event until the per-command delta limit is reached. It updates the pending buffer and the emitted-delta count.

**Call relations**: This function is used by the background task created in `start_streaming_output`. It relies on `split_valid_utf8_prefix` to decide what part of the byte buffer can be sent safely. It then sends the delta through the session event system so the caller can see live command output.

*Call graph*: calls 1 internal fn (split_valid_utf8_prefix); 1 external calls (ExecCommandOutputDelta).


##### `emit_exec_end_for_unified_exec`  (lines 195–237)

```
async fn emit_exec_end_for_unified_exec(
    session_ref: Arc<Session>,
    turn_ref: Arc<TurnContext>,
    call_id: String,
    command: Vec<String>,
    cwd: AbsolutePathBuf,
    process_id: Option<
```

**Purpose**: Builds and sends the final success event for a unified exec command. It packages the command’s output, exit code, duration, and identifying details into the standard tool-event format.

**Data flow**: It receives session and turn references, the call id, command, working directory, optional process id, transcript, fallback output, exit code, and duration. It chooses the final aggregated output from the transcript if present, otherwise from the fallback string. It then creates an `ExecToolCallOutput` marked as successful and sends it through a unified exec `ToolEmitter`.

**Call relations**: This is called by `spawn_exit_watcher` after a normal process exit, and also by `exec_command` in paths that need to emit a final result directly. It calls `resolve_aggregated_output` to get the final text, then hands the completed success event to the tool event emitter.

*Call graph*: calls 4 internal fn (unified_exec, new, resolve_aggregated_output, new); called by 2 (spawn_exit_watcher, exec_command); 1 external calls (new).


##### `emit_failed_exec_end_for_unified_exec`  (lines 240–288)

```
async fn emit_failed_exec_end_for_unified_exec(
    session_ref: Arc<Session>,
    turn_ref: Arc<TurnContext>,
    call_id: String,
    command: Vec<String>,
    cwd: AbsolutePathBuf,
    process_id:
```

**Purpose**: Builds and sends the final failure event for a unified exec command. It includes both any output collected before failure and the failure message itself.

**Data flow**: It receives session and turn references, command identity details, transcript, fallback output, failure message, and duration. It chooses stdout from the fallback text or the transcript, then creates aggregated output by combining stdout and the error message when both exist. It builds an `ExecToolCallOutput` with exit code -1 and emits it as a failure event.

**Call relations**: This is called by `spawn_exit_watcher` when the stored process reports a failure message, and by `emit_failed_initial_exec_end_if_unstored` for early failures before a process is fully stored. It may call `resolve_aggregated_output`, then sends the failure through the same unified exec event-emitter path used for successful endings.

*Call graph*: calls 4 internal fn (unified_exec, new, resolve_aggregated_output, new); called by 2 (spawn_exit_watcher, emit_failed_initial_exec_end_if_unstored); 3 external calls (Output, Failure, format!).


##### `split_valid_utf8_prefix`  (lines 290–292)

```
fn split_valid_utf8_prefix(buffer: &mut Vec<u8>) -> Option<Vec<u8>>
```

**Purpose**: Chooses the next safe piece of buffered output to emit using the file’s standard maximum event size. It is a small wrapper around the more configurable splitting helper.

**Data flow**: It receives a mutable byte buffer. It passes that buffer and the configured maximum chunk size to `split_valid_utf8_prefix_with_max`. The returned value is either a byte vector removed from the front of the buffer or `None` if there is nothing to emit.

**Call relations**: This is called by `process_chunk` whenever new output bytes arrive. It delegates the detailed text-boundary work to `split_valid_utf8_prefix_with_max`, keeping the main output-processing function simple.

*Call graph*: calls 1 internal fn (split_valid_utf8_prefix_with_max); called by 1 (process_chunk).


##### `split_valid_utf8_prefix_with_max`  (lines 294–318)

```
fn split_valid_utf8_prefix_with_max(buffer: &mut Vec<u8>, max_bytes: usize) -> Option<Vec<u8>>
```

**Purpose**: Cuts off the next output piece without making an event too large and, when possible, without splitting a UTF-8 character. UTF-8 is the common text encoding where some characters use more than one byte.

**Data flow**: It receives a mutable byte buffer and a maximum number of bytes. If the buffer is empty, it returns `None`. Otherwise it searches backward from the allowed size until the front slice is valid UTF-8, removes that slice, and returns it. If no valid prefix is found quickly, it removes and returns one byte anyway so the stream never gets stuck.

**Call relations**: This is used by `split_valid_utf8_prefix`, which supplies the normal maximum chunk size. Its result controls what `process_chunk` records and emits as the next live output delta.

*Call graph*: called by 1 (split_valid_utf8_prefix); 1 external calls (from_utf8).


##### `resolve_aggregated_output`  (lines 320–330)

```
async fn resolve_aggregated_output(
    transcript: &Arc<Mutex<HeadTailBuffer>>,
    fallback: String,
) -> String
```

**Purpose**: Decides what text should be used as the command’s final combined output. It prefers the saved transcript, but falls back to a supplied string if the transcript is empty.

**Data flow**: It receives the shared transcript and a fallback string. It locks the transcript, checks whether any bytes were retained, and if none were retained it returns the fallback. Otherwise it converts the transcript bytes into text, replacing invalid byte sequences safely, and returns that text.

**Call relations**: This is called when building final success and failure events in `emit_exec_end_for_unified_exec` and `emit_failed_exec_end_for_unified_exec`. It gives those emitters one final output string to place into the event sent to the rest of the system.

*Call graph*: called by 2 (emit_exec_end_for_unified_exec, emit_failed_exec_end_for_unified_exec); 1 external calls (from_utf8_lossy).


### `exec/src/event_processor_with_human_output.rs`

`io_transport` · `startup, request handling, shutdown`

This file is the “announcer” for an exec session. The Codex server sends structured notifications such as “a command started,” “a patch finished,” “the model replied,” or “the turn is done.” Those messages are useful to software, but not pleasant for a person to read directly. EventProcessorWithHumanOutput translates them into clear text on the terminal, with colors and emphasis when ANSI styling is allowed.

It keeps a small amount of memory about the session. For example, it remembers the latest final assistant message, whether that message was already shown, whether it should be saved to a “last message” file, and the latest token count. This matters because the final answer may need to be printed differently depending on the situation. In an interactive terminal, it avoids showing the same answer twice. In a scripted or piped run, it prints the final answer to standard output so another program can capture it.

The file also prints a startup summary: working directory, model, provider, approval mode, sandbox permissions, and session id. During the run it renders commands, MCP tool calls, web searches, patch applications, plans, warnings, errors, and turn completion. Think of it like a live sports commentator: the server is the game, and this file narrates what is happening in a form people can follow.

#### Function details

##### `EventProcessorWithHumanOutput::create_with_ansi`  (lines 42–65)

```
fn create_with_ansi(
        with_ansi: bool,
        config: &Config,
        last_message_path: Option<PathBuf>,
    ) -> Self
```

**Purpose**: Creates a human-output event processor and decides whether its text styles should be real terminal colors or plain text. Someone uses this when starting an exec session so later events can be printed consistently.

**Data flow**: It receives a yes-or-no choice for ANSI styling, the current configuration, and an optional path where the last message should be saved. It builds style settings, copies display-related options from the configuration, starts with no final message or token usage recorded, and returns a ready-to-use EventProcessorWithHumanOutput.

**Call relations**: The exec session setup calls this before the event stream begins. After that, the returned processor is used to print the startup summary, react to server notifications, and produce final output.

*Call graph*: called by 1 (run_exec_session); 1 external calls (new).


##### `EventProcessorWithHumanOutput::render_item_started`  (lines 67–96)

```
fn render_item_started(&self, item: &ThreadItem)
```

**Purpose**: Prints a short human-readable line when a unit of work begins, such as running a shell command, calling a tool, searching the web, or applying a patch. This gives the user immediate feedback that something has started.

**Data flow**: It receives one thread item describing the work that just began. It looks at the item type, extracts the useful details such as command text, working directory, tool name, or search query, and writes a styled line to standard error. It does not return a value or change stored state.

**Call relations**: When a server notification says an item started, process_server_notification calls this helper. This keeps the large notification dispatcher from having to contain all of the formatting details for started items.

*Call graph*: called by 1 (process_server_notification); 1 external calls (eprintln!).


##### `EventProcessorWithHumanOutput::render_item_completed`  (lines 98–208)

```
fn render_item_completed(&mut self, item: ThreadItem)
```

**Purpose**: Prints the result of a completed item, such as the assistant’s message, command output, patch status, tool error, or reasoning summary. It also records the assistant’s final-looking message so shutdown can save or print it correctly.

**Data flow**: It receives a completed thread item. Depending on the item type, it chooses suitable text and colors, may call reasoning_text to decide which reasoning text to show, prints the result to standard error, and may update the stored final message and whether it was already rendered.

**Call relations**: process_server_notification calls this when the server reports an item completion. It is the main formatter for completed work and feeds later shutdown behavior by remembering assistant messages.

*Call graph*: calls 1 internal fn (reasoning_text); called by 1 (process_server_notification); 1 external calls (eprintln!).


##### `EventProcessorWithHumanOutput::print_config_summary`  (lines 212–225)

```
fn print_config_summary(
        &mut self,
        config: &Config,
        prompt: &str,
        session_configured_event: &SessionConfiguredEvent,
    )
```

**Purpose**: Prints the opening banner and session settings before the user’s prompt is shown. This helps the person confirm which model, workspace, permission mode, and sandbox rules are being used.

**Data flow**: It receives the configuration, the user prompt, and the session details reported by the server. It gets the package version, asks config_summary_entries for display rows, prints them, and then prints the user prompt under a user label.

**Call relations**: This is part of the EventProcessor interface and is used near session startup. It delegates the choice of which configuration fields to show to config_summary_entries, then focuses on presentation.

*Call graph*: calls 1 internal fn (config_summary_entries); 2 external calls (env!, eprintln!).


##### `EventProcessorWithHumanOutput::process_server_notification`  (lines 227–367)

```
fn process_server_notification(&mut self, notification: ServerNotification) -> CodexStatus
```

**Purpose**: Receives each server notification and decides what the user should see and whether the exec session should keep running or start shutting down. This is the central switchboard for live terminal output.

**Data flow**: It receives one structured notification from the server. It matches the notification kind, prints warnings, errors, hooks, plans, diffs, item starts and completions, model reroutes, or token updates as needed. For turn completion it records or clears the final message and returns a status telling the caller either to continue or begin shutdown.

**Call relations**: The event loop calls this for incoming server notifications. It hands item formatting to render_item_started and render_item_completed, warning formatting to process_warning, and final-answer extraction to final_message_from_turn_items.

*Call graph*: calls 4 internal fn (process_warning, render_item_completed, render_item_started, final_message_from_turn_items); 1 external calls (eprintln!).


##### `EventProcessorWithHumanOutput::process_warning`  (lines 369–375)

```
fn process_warning(&mut self, message: String) -> CodexStatus
```

**Purpose**: Prints a warning message in the standard warning style and tells the session to continue. It is a small shared path for ordinary warning notifications.

**Data flow**: It receives warning text, writes it to standard error with a highlighted warning label, and returns a status meaning the session is still running. It does not change the saved final message or token data.

**Call relations**: process_server_notification calls this when it receives a general warning notification. More specialized warnings, such as configuration warnings, are printed directly by the dispatcher because they include extra fields.

*Call graph*: called by 1 (process_server_notification); 1 external calls (eprintln!).


##### `EventProcessorWithHumanOutput::print_final_output`  (lines 377–417)

```
fn print_final_output(&mut self)
```

**Purpose**: Performs the last bits of human output when the session is ending. It may save the last assistant message, print token usage, and decide whether the final answer belongs on standard output or standard error.

**Data flow**: It reads the stored final message, the chosen last-message file path, the latest token usage, whether the final message was already shown, and whether standard output and standard error are terminals. It may write the final message to a file through handle_last_message, print token usage, print the final answer to standard output for scripts, or print it to the terminal if it has not appeared yet.

**Call relations**: This is called during shutdown after notifications have been processed. It relies on earlier state set by process_server_notification and render_item_completed, and uses should_print_final_message_to_stdout and should_print_final_message_to_tty to avoid duplicate or misplaced final answers.

*Call graph*: calls 3 internal fn (handle_last_message, should_print_final_message_to_stdout, should_print_final_message_to_tty); 4 external calls (eprintln!, println!, stderr, stdout).


##### `config_summary_entries`  (lines 420–467)

```
fn config_summary_entries(
    config: &Config,
    session_configured_event: &SessionConfiguredEvent,
) -> Vec<(&'static str, String)>
```

**Purpose**: Builds the list of configuration facts shown at the top of an exec session. It gathers the settings most useful for understanding how Codex is about to run.

**Data flow**: It receives the local configuration and the server’s session-configured event. It reads the working directory, selected model, provider, approval policy, sandbox permission profile, optional reasoning settings, and session id, then returns them as label-and-value rows for printing.

**Call relations**: print_config_summary calls this before printing the startup banner. This helper keeps the selection of summary fields separate from the terminal formatting.

*Call graph*: called by 1 (print_config_summary); 1 external calls (vec!).


##### `reasoning_text`  (lines 469–484)

```
fn reasoning_text(
    summary: &[String],
    content: &[String],
    show_raw_agent_reasoning: bool,
) -> Option<String>
```

**Purpose**: Chooses which agent reasoning text, if any, should be shown to the user. It respects the setting that controls whether to show raw reasoning content or only summaries.

**Data flow**: It receives a list of summary strings, a list of raw content strings, and a yes-or-no flag for raw reasoning. If raw reasoning is requested and available, it joins the raw content; otherwise it joins the summaries. If there is nothing to show, it returns no text.

**Call relations**: render_item_completed calls this when a reasoning item finishes. The returned text is then printed dimly if reasoning display is enabled and the text is not blank.

*Call graph*: called by 1 (render_item_completed).


##### `final_message_from_turn_items`  (lines 486–500)

```
fn final_message_from_turn_items(items: &[ThreadItem]) -> Option<String>
```

**Purpose**: Finds the best final text to treat as the answer for a completed turn. It prefers the latest assistant message, but can fall back to the latest plan text if no assistant message is present.

**Data flow**: It receives the full list of thread items from a turn. It scans backward from the end, first looking for an agent message and returning its text. If none is found, it scans backward again for a plan item and returns that text; if neither exists, it returns nothing.

**Call relations**: process_server_notification uses this when a turn completes. Its result updates the stored final message so shutdown can save or print the right text.

*Call graph*: called by 1 (process_server_notification); 1 external calls (iter).


##### `blended_total`  (lines 502–506)

```
fn blended_total(usage: &ThreadTokenUsage) -> i64
```

**Purpose**: Calculates the token count displayed to the user at the end of a run. It counts non-cached input tokens plus output tokens, so reused cached input is not included in the visible total.

**Data flow**: It receives token usage totals. It separates cached input from total input, clamps negative values to zero for safety, adds non-cached input to output tokens, and returns the final non-negative count.

**Call relations**: This supports the final token summary printed during shutdown. It turns the detailed token accounting structure into one simple number a human can read.


##### `should_print_final_message_to_stdout`  (lines 508–514)

```
fn should_print_final_message_to_stdout(
    final_message: Option<&str>,
    stdout_is_terminal: bool,
    stderr_is_terminal: bool,
) -> bool
```

**Purpose**: Decides whether the final assistant message should be printed to standard output. This is important for script use, where another program may be waiting to capture just the final answer.

**Data flow**: It receives the optional final message and two facts: whether standard output is a terminal and whether standard error is a terminal. It returns true only when there is a final message and the process is not in the fully interactive case where both streams are terminals.

**Call relations**: print_final_output calls this during shutdown. If it says yes, the final message is printed with println so it goes to standard output rather than the usual progress stream.

*Call graph*: called by 1 (print_final_output).


##### `should_print_final_message_to_tty`  (lines 516–523)

```
fn should_print_final_message_to_tty(
    final_message: Option<&str>,
    final_message_rendered: bool,
    stdout_is_terminal: bool,
    stderr_is_terminal: bool,
) -> bool
```

**Purpose**: Decides whether the final assistant message still needs to be printed to the interactive terminal. It prevents the same answer from appearing twice.

**Data flow**: It receives the optional final message, whether that message has already been rendered, and whether standard output and standard error are terminals. It returns true only when there is a message, it has not already been shown, and both streams are interactive terminals.

**Call relations**: print_final_output calls this after checking the standard-output case. If it says yes, the file prints the final message to standard error with the usual Codex label and styling.

*Call graph*: called by 1 (print_final_output).


### `ollama/src/parser.rs`

`domain_logic` · `pull stream processing`

When Ollama pulls a model, it receives progress updates as JSON objects. JSON is flexible, but that also means the rest of the code would have to keep checking strings and optional fields by hand. This file is the small translator that turns those raw messages into a tidy list of events.

The main function looks for a `status` field first. If it finds one, it creates a status event. A special status value, `success`, also creates a separate success event, so later code does not have to remember that the word “success” means the pull is finished.

Then it looks for progress information: a chunk `digest` plus optional `total` and `completed` byte counts. If either progress number is present, it creates a progress event. The digest is used when present, or an empty string when missing.

The tests in this file act like simple examples. They feed in small JSON objects and check that the parser produces exactly the expected events. Without this file, the pull system would have raw JSON leaking through it, making progress reporting and completion detection more fragile.

#### Function details

##### `pull_events_from_value`  (lines 6–29)

```
fn pull_events_from_value(value: &JsonValue) -> Vec<PullEvent>
```

**Purpose**: This function turns one JSON pull-update object into zero, one, or several `PullEvent` values. It is used so the rest of the pull code can react to clear events instead of digging through JSON fields itself.

**Data flow**: It receives a JSON value. It reads `status`, `digest`, `total`, and `completed` if they exist and have the expected type. From that, it builds a list: status text becomes a status event, the exact status `success` also becomes a success event, and progress numbers become a chunk-progress event. It returns the completed list and does not change the input JSON.

**Call relations**: The test functions call this directly with sample JSON messages to prove the translation rules. Inside the function, it uses JSON field lookup helpers to read the incoming object and constructs `PullEvent` variants for the higher-level pull flow to consume.

*Call graph*: called by 2 (test_pull_events_decoder_progress, test_pull_events_decoder_status_and_success); 3 external calls (get, new, Status).


##### `tests::test_pull_events_decoder_status_and_success`  (lines 38–48)

```
fn test_pull_events_decoder_status_and_success()
```

**Purpose**: This test checks that status messages are decoded correctly. It also verifies the special rule that a `success` status produces both a normal status event and a separate success event.

**Data flow**: It creates one JSON object with `status: "verifying"` and sends it into `pull_events_from_value`, expecting one status event. Then it creates another JSON object with `status: "success"`, sends that in, and checks that two events come back: a status event followed by a success event.

**Call relations**: This test is called by Rust's test runner, not by application code. It exercises `pull_events_from_value` as a user of the parser would, and uses assertion helpers to confirm that the returned events match the intended behavior.

*Call graph*: calls 1 internal fn (pull_events_from_value); 3 external calls (assert_eq!, assert_matches!, json!).


##### `tests::test_pull_events_decoder_progress`  (lines 51–74)

```
fn test_pull_events_decoder_progress()
```

**Purpose**: This test checks that download progress fields are turned into chunk-progress events. It covers both cases where only the total size is known and where only the completed amount is known.

**Data flow**: It builds a JSON object with a digest and `total`, passes it to `pull_events_from_value`, and checks that the returned progress event keeps the digest and total while leaving completed empty. Then it repeats the process with a digest and `completed`, checking the opposite shape.

**Call relations**: Like the other test, this is run by Rust's test runner. It calls `pull_events_from_value` with controlled examples so changes to the parser will quickly reveal if progress reporting has been broken.

*Call graph*: calls 1 internal fn (pull_events_from_value); 3 external calls (assert_eq!, assert_matches!, json!).
